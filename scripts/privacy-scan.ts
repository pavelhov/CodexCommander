import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Finding = {
  file: string;
  line: number;
  kind: string;
  value: string;
};

export const TEXT_FILE_RE = /\.(?:cjs|css|html|js|json|jsonc|md|mjs|plist|ps1|sh|swift|toml|ts|tsx|txt|yml|yaml)$/;
const EXCLUDED_PREFIXES = [
  "node_modules/",
  "tests/.tmp-",
];
const EXCLUDED_SUFFIXES = [
  "bun.lock",
  "package-lock.json",
];

function gitLsFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`git ls-files failed: ${stderr.trim() || result.exitCode}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split(/\r?\n/)
    .filter(Boolean);
}

function posixPath(file: string): string {
  return file.replaceAll("\\", "/");
}

function pathHasSegment(file: string, segment: string): boolean {
  return posixPath(file).split("/").includes(segment);
}

export function shouldScan(file: string): boolean {
  const normalized = posixPath(file);
  if (!TEXT_FILE_RE.test(normalized)) return false;
  if (pathHasSegment(normalized, "node_modules")) return false;
  if (EXCLUDED_PREFIXES.some(prefix => normalized.startsWith(prefix) || normalized.includes(`/${prefix}`))) {
    return false;
  }
  if (EXCLUDED_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return false;
  return true;
}

export function lineNumber(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function isAllowedEmail(file: string, email: string): boolean {
  if (file === "scripts/privacy-scan.ts" && email === "a@b.com") return true;
  const domain = email.split("@").at(1)?.toLowerCase() ?? "";
  if (domain === "example.test" || domain === "example.com" || domain === "test.com" || domain.endsWith(".test")) {
    return true;
  }
  // URL-userinfo fixtures (https://user:pw@host/...) read as "pw@host" — not emails.
  if (file.startsWith("tests/") && email === ["pw", "chatgpt.com"].join("@")) return true;
  return file.startsWith("tests/") && email === "a@b.com";
}

function isAllowedHomePath(file: string, username: string): boolean {
  const normalized = posixPath(file);
  if (
    (normalized.startsWith("tests/")
      || normalized.startsWith("app/")
      || normalized.includes("/tests/")
      || normalized.includes("/app/"))
    && (username === "example" || username === "test" || username === "x")
  ) {
    return true;
  }
  if (normalized.startsWith("docs/") && (username === "me" || username === "user")) return true;
  if (normalized.startsWith("docs-site/") && username === "example") return true;
  return false;
}

function isAllowedTokenLooking(file: string, token: string): boolean {
  if (posixPath(file).includes("/tests/") || posixPath(file).startsWith("tests/")) {
    // Test fixture sentinels: sk-rawsentinel..., sk-test-...
    return /^sk-(?:rawsentinel|test-)\d+[a-z]*$/.test(token);
  }
  return false;
}

function isAllowedBearerToken(file: string, token: string): boolean {
  const normalized = posixPath(file);
  if (!normalized.startsWith("tests/") && !normalized.includes("/tests/")) return false;
  return /^(?:access|stack|usage-debug)-token(?:-value)?-[A-Za-z0-9-]+$/.test(token);
}

function addFindingsForPattern(
  findings: Finding[],
  file: string,
  text: string,
  kind: string,
  pattern: RegExp,
  allow: (match: RegExpExecArray) => boolean,
): void {
  for (const match of text.matchAll(pattern)) {
    if (allow(match)) continue;
    findings.push({
      file,
      line: lineNumber(text, match.index ?? 0),
      kind,
      value: match[0],
    });
  }
}

export function scanFile(file: string, text: string = readFileSync(file, "utf-8")): Finding[] {
  const findings: Finding[] = [];
  addFindingsForPattern(
    findings,
    file,
    text,
    "home-path",
    /\/Users\/([A-Za-z0-9_-]+)\//g,
    match => isAllowedHomePath(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "email",
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    match =>
      isAllowedEmail(file, match[0]),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "bearer-token",
    /Bearer\s+([A-Za-z0-9._-]{24,})/g,
    match => isAllowedBearerToken(file, match[1] ?? ""),
  );
  addFindingsForPattern(
    findings,
    file,
    text,
    "token-looking",
    /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
    match => isAllowedTokenLooking(file, match[0]),
  );
  return findings;
}

export function redactSecret(value: string): string {
  return `[redacted ${value.length} chars]`;
}

export function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line} ${finding.kind}: ${redactSecret(finding.value)}`;
}

function walkTextFiles(root: string, files: string[] = []): string[] {
  if (!existsSync(root)) return files;
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkTextFiles(full, files);
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) files.push(full);
  }
  return files;
}

export function collectScanFiles(options: { scanRoot?: string; cwd?: string } = {}): string[] {
  if (options.scanRoot) {
    return walkTextFiles(options.scanRoot).filter(existsSync).filter(shouldScan);
  }
  const tracked = gitLsFiles().filter(existsSync).filter(shouldScan);
  const generatedGui = walkTextFiles(join(options.cwd ?? ".", "gui/dist")).filter(shouldScan);
  return [...new Set([...tracked, ...generatedGui])];
}

export function scanFiles(files: string[]): Finding[] {
  return files.flatMap(file => scanFile(file));
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const scanRootIndex = argv.indexOf("--scan-root");
  const scanRoot = scanRootIndex >= 0 ? argv[scanRootIndex + 1] : undefined;
  if (scanRootIndex >= 0 && !scanRoot) {
    console.error("privacy-scan: --scan-root requires a directory");
    return 2;
  }
  const findings = scanFiles(collectScanFiles({ scanRoot }));
  if (findings.length > 0) {
    console.error("Privacy scan failed:");
    for (const finding of findings) {
      console.error(formatFinding(finding));
    }
    return 1;
  }
  console.log("Privacy scan passed");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}

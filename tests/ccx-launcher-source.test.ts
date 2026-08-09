import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * bin/ccx.mjs is the Node bin launcher — it executes top-level logic on import, so it
 * cannot be imported by tests. Guard its Windows-critical invariants at the source level.
 */
const root = join(import.meta.dir, "..");
const source = readFileSync(join(root, "bin", "ccx.mjs"), "utf8");
const prepareSource = readFileSync(join(root, "scripts", "prepare-package.ts"), "utf8");
const runtimeSource = readFileSync(join(import.meta.dir, "..", "src", "lib", "bun-runtime.ts"), "utf8");
const validatorSource = readFileSync(
  join(import.meta.dir, "..", "src", "lib", "bun-binary-validator.mjs"),
  "utf8",
);

describe("ccx.mjs launcher (source invariants)", () => {
  test("the package exposes exactly the two canonical commands through one launcher", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin).toEqual({
      codexcommander: "./bin/ccx.mjs",
      ccx: "./bin/ccx.mjs",
    });
    expect(readdirSync(join(root, "bin")).filter(name => name.endsWith(".mjs")).sort())
      .toEqual(["ccx.mjs", "package-main.mjs"]);
    const aliasBlock = /const DIST_BIN_ALIASES = \[([\s\S]*?)\] as const;/.exec(prepareSource)?.[1] ?? "";
    expect([...aliasBlock.matchAll(/"([^"]+)"/g)].map(match => match[1]))
      .toEqual(["codexcommander", "ccx"]);
    expect(prepareSource).toContain('join(root, "bin", "ccx.mjs")');
  });

  test("the Bun child receives the runtime provenance the launcher actually selected (#848)", () => {
    // The launcher is a plain-Node bin script executing at import time, so this is
    // asserted at the source level: the marker must reach the spawn env, and it must
    // carry the source resolved alongside the chosen binary rather than a literal.
    expect(source).toContain('const BUN_RUNTIME_SOURCE_ENV = "CCX_BUN_RUNTIME_SOURCE";');
    expect(source).toContain("[BUN_RUNTIME_SOURCE_ENV]: bunRuntime.source,");

    // The stamp must sit inside the spawn's env object, not merely somewhere in the file.
    const spawnStart = source.indexOf("const child = spawn(bun, [cliPath");
    expect(spawnStart).toBeGreaterThanOrEqual(0);
    const spawnCall = source.slice(spawnStart, source.indexOf("});", spawnStart));
    expect(spawnCall).toContain("[BUN_RUNTIME_SOURCE_ENV]: bunRuntime.source");

    // Path and source come from one resolution, so the marker cannot describe another binary.
    expect(source).toContain("const bunRuntime = resolveBun();");
    expect(source).toContain("const bun = bunRuntime.path;");
    expect(source).toContain('return { path: bin, source: "bundled" };');

    // The launcher's literal name must match the TypeScript constant it mirrors.
    expect(runtimeSource).toContain('export const BUN_RUNTIME_SOURCE_ENV = "CCX_BUN_RUNTIME_SOURCE";');
    expect(runtimeSource).toContain('export const BUN_RUNTIME_PATH_ENV = "CCX_BUN_RUNTIME_PATH";');
  });

  test("has no package-manager self-update branch or updater subprocess", () => {
    expect(source).not.toContain("npmInvocation");
    expect(source).not.toContain("runNpmSelfUpdate");
    expect(source).not.toContain('process.argv[2] === "update"');
    expect(source).not.toContain("src/update/");
    expect(source).not.toContain("codex-history-backup-");
    // The one synchronous child is the bundled Bun package's local installer fallback.
    expect(source.match(/spawnSync\(process\.execPath/g)).toHaveLength(1);
    expect(source).not.toContain("shell: true");
    expect(source).not.toContain('"npm.cmd"');
  });

  // #701: the launcher is the only place that still knows whether an Anthropic credential
  // came from a real shell export or from a project dotenv, because Node does not
  // auto-load `.env` while the Bun child does. Losing this half silently returns the
  // proxy to billing a subscriber's API key from an ambient file, and the runtime half in
  // src/cli/claude.ts would keep passing its own unit tests while doing nothing.
  test("the Bun child receives proof-bound pre-Bun Anthropic provenance", () => {
    expect(source).toContain("const preBunAnthropicSlots = [\"ANTHROPIC_API_KEY\", \"ANTHROPIC_AUTH_TOKEN\", \"ANTHROPIC_BASE_URL\"]");
    expect(source).toContain("const launchProof = randomBytes(32).toString(\"base64url\")");
    expect(source).toContain('const NODE_LAUNCH_CONTEXT_ENV = "CCX_NODE_LAUNCH_CONTEXT";');
    expect(source).toContain('const NODE_LAUNCH_PROOF_PREFIX = "--ccx-internal-launch-proof=";');
    expect(source).toContain("[NODE_LAUNCH_CONTEXT_ENV]: launchContext");
    expect(source).toContain("`${NODE_LAUNCH_PROOF_PREFIX}${launchProof}`");
    // The snapshot must be computed from the launcher's OWN env, before Bun's dotenv load.
    expect(source).toContain("typeof process.env[name] === \"string\" && process.env[name] !== \"\"");
  });

  test("valid Bun overrides are selected before the bundled runtime", () => {
    expect(source).toContain('const BUN_OVERRIDE_ENV = "CCX_BUN_PATH";');
    expect(source).toContain("const overridePath = resolve(override);");
    expect(source).toContain('if (isRealBunBinary(overridePath)) return { path: overridePath, source: "override" };');

    const resolveStart = source.indexOf("function resolveBun() {");
    const overrideCheck = source.indexOf("process.env[BUN_OVERRIDE_ENV]?.trim()", resolveStart);
    const overrideResolve = source.indexOf("resolve(override)", overrideCheck);
    const bundledLookup = source.indexOf("bunDir = bunBinDir()", resolveStart);
    expect(resolveStart).toBeGreaterThanOrEqual(0);
    expect(overrideCheck).toBeGreaterThan(resolveStart);
    expect(overrideResolve).toBeGreaterThan(overrideCheck);
    expect(bundledLookup).toBeGreaterThan(overrideResolve);
  });

  test("invalid Bun overrides warn safely and fall back without throwing", () => {
    expect(source).toContain('import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";');
    expect(source).toContain("is missing, unreadable, or not a complete Bun binary; falling back to the bundled runtime.");
    expect(source).not.toContain('${override} is missing, unreadable');
  });

  test("shares the Node-safe Bun binary validator across both runtime paths", () => {
    expect(source).toContain('import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";');
    expect(runtimeSource).toContain('import { isRealBunBinary } from "./bun-binary-validator.mjs";');
    expect(runtimeSource).toContain("export { isRealBunBinary };");
    expect(validatorSource).toContain("export const REAL_BUN_MIN_BYTES = 1_000_000;");
    expect(validatorSource).toMatch(/export function isRealBunBinary\(path\) \{[\s\S]*?try \{[\s\S]*?statSync\(path\)[\s\S]*?catch \{[\s\S]*?return false;/);
  });
});

/**
 * GUI suite runner.
 *
 * Happy-dom tests mutate globalThis.document/window. Bun's default shared-global
 * run is fast locally and red on slower GHA: a late React 19 update after
 * afterEach then throws on `window.event` and poisons later files. `--parallel`
 * implies `--isolate` (fresh global per file) and is the default here, capped
 * like the proxy suite at min(4, CPU). Failed files retry once on a single
 * worker — never a full-suite rerun.
 *
 * Override with CCX_TEST_PARALLEL_WORKERS and CCX_TEST_RETRY.
 */
import { availableParallelism } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

const GUI_ROOT = join(import.meta.dir, "..");
const TEST_ROOT = "tests";

export function resolveWorkerCount(
  raw = process.env.CCX_TEST_PARALLEL_WORKERS,
  cpuCount = availableParallelism(),
): number {
  if (raw === undefined || raw.trim() === "") return Math.max(1, Math.min(4, cpuCount));
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `CCX_TEST_PARALLEL_WORKERS must be a positive integer, received ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

export function resolveRetryCount(raw = process.env.CCX_TEST_RETRY): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`CCX_TEST_RETRY must be a non-negative integer, received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** File paths from a Bun junit report that had failures or errors. */
export function failedFilesFromJunit(xml: string): string[] {
  const files = new Set<string>();
  for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const attrs = match[1] ?? "";
    const failures = Number(/\bfailures="(\d+)"/.exec(attrs)?.[1] ?? 0);
    const errors = Number(/\berrors="(\d+)"/.exec(attrs)?.[1] ?? 0);
    if (failures + errors === 0) continue;
    const file = /\bfile="([^"]+)"/.exec(attrs)?.[1];
    if (file) files.add(file);
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

/** Static guidance only: failed test paths are PR-controlled and must never become shell syntax. */
export function failedFilesSummary(files: readonly string[]): string {
  return `[gui:test] ${files.length} file(s) remain failed. Review the failed file list above.`;
}

function displayPath(file: string): string {
  const rel = relative(GUI_ROOT, file);
  return rel && !rel.startsWith("..") ? rel : file;
}

function resolveSuiteFile(file: string): string {
  return isAbsolute(file) ? file : join(GUI_ROOT, file);
}

function spawnTest(args: string[], junitPath?: string): Promise<number> {
  const env = { ...process.env, TZ: process.env.TZ || "UTC" };
  const command = [
    process.execPath,
    "test",
    ...args,
    ...(junitPath ? ["--reporter=junit", `--reporter-outfile=${junitPath}`] : []),
  ];
  const child = Bun.spawn(command, {
    cwd: GUI_ROOT,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited.then(code => code ?? 1);
}

async function runQueue(files: string[], workers: number, label: string): Promise<string[]> {
  const failed: string[] = [];
  let next = 0;
  const workerCount = Math.min(workers, Math.max(1, files.length));
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= files.length) return;
      const file = files[index]!;
      const code = await spawnTest(["--isolate", file]);
      const status = code === 0 ? "ok" : "FAIL";
      console.warn(`[gui:test] ${label} ${index + 1}/${files.length} ${status} ${displayPath(file)}`);
      if (code !== 0) failed.push(file);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return failed;
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const workers = resolveWorkerCount();
  const retryCount = resolveRetryCount();
  const scratch = mkdtempSync(join(tmpdir(), "ccx-gui-test-"));
  const junitPath = join(scratch, "junit.xml");

  try {
    const patterns = requested.length > 0 ? requested : [TEST_ROOT];
    console.warn(
      `[gui:test] ${patterns.join(" ")} across ${workers} worker(s) `
      + `(CCX_TEST_PARALLEL_WORKERS / CCX_TEST_RETRY to override)`,
    );
    const startedAt = Date.now();
    const code = await spawnTest([`--parallel=${workers}`, ...patterns], junitPath);

    let failures: string[] = [];
    if (code !== 0) {
      let xml = "";
      try {
        xml = readFileSync(junitPath, "utf8");
      } catch {
        console.error("[gui:test] suite failed and no junit report was written; not rerunning the whole suite.");
        process.exitCode = 1;
        return;
      }
      failures = failedFilesFromJunit(xml).map(resolveSuiteFile);
      if (failures.length === 0) {
        console.error("[gui:test] suite failed but junit listed no failed files; not rerunning the whole suite.");
        process.exitCode = 1;
        return;
      }
    }

    const recovered: string[] = [];
    if (failures.length > 0 && retryCount > 0) {
      console.warn(
        `[gui:test] ${failures.length} file(s) failed; retrying only those files (${retryCount} pass(es), 1 worker):`,
      );
      for (const file of failures) console.warn(`  ${displayPath(file)}`);
      const stillFailing = new Set(failures);
      for (let attempt = 1; attempt <= retryCount; attempt += 1) {
        const retryFailures = await runQueue([...stillFailing], 1, `retry ${attempt}/${retryCount}`);
        const failedThisPass = new Set(retryFailures);
        for (const file of stillFailing) {
          if (!failedThisPass.has(file)) recovered.push(file);
        }
        stillFailing.clear();
        for (const file of failedThisPass) stillFailing.add(file);
        if (stillFailing.size === 0) break;
      }
      failures = [...stillFailing];
    }

    const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
    if (recovered.length > 0) {
      console.warn(`[gui:test] recovered after retry (${recovered.length} file(s)):`);
      for (const file of recovered) console.warn(`  ${displayPath(file)}`);
    }
    if (failures.length > 0) {
      console.error(`[gui:test] ${failures.length} file(s) failed after ${minutes} min:`);
      for (const file of failures) console.error(`  ${displayPath(file)}`);
      console.error(failedFilesSummary(failures));
      process.exitCode = 1;
      return;
    }
    console.warn(`[gui:test] passed in ${minutes} min`);
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

if (import.meta.main) {
  await main();
}

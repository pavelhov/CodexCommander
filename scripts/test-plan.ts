import { readFileSync } from "node:fs";

/**
 * Cheap files share a process; server/subprocess files stay isolated.
 *
 * `bun test --isolate` is a fresh global object, not a fresh OS process. The
 * serial and parallel wrappers spawn one process per file because Bun 1.3.x on
 * macOS can leave the event loop spinning after a server-heavy file, stalling
 * whatever would run next in that process. That isolation is necessary — it is
 * also why 600 one-file processes thrash a laptop.
 *
 * Files that never bind a server, spawn `process.execPath`, or write the
 * process HOME sandbox do not hit that stall. Batching them with
 * `--no-isolate --max-concurrency=1` keeps HOME sandboxing (preload still
 * runs once per process) without paying a Bun boot per file. Isolate-needed
 * files still get their own process.
 */
export const DEFAULT_TEST_BATCH_SIZE = 8;

export type TestLane = "batch" | "isolate";

export interface ParallelTestPlan {
  isolate: string[];
  batches: string[][];
}

/**
 * Isolate anything that cannot safely share a process with the next file:
 * - server binds / nested Bun CLI spawns (macOS event-loop stall + load timeouts)
 * - writes to the process HOME sandbox (preload HOME is per-process, not per-file)
 */
const ISOLATE_SOURCE_RE =
  /\bstartServer\s*\(|\bBun\.serve\s*\(|\bprocess\.execPath\b|\bsaveConfig\s*\(|\binstallIsolatedCodexHome\s*\(|process\.env\.(CODEXCOMMANDER_HOME|CODEX_HOME)\s*=/;

export function classifyTestFile(filePath: string, source: string): TestLane {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.includes("/e2e-style/")) return "isolate";
  if (ISOLATE_SOURCE_RE.test(source)) return "isolate";
  return "batch";
}

export function resolveTestBatchSize(raw = process.env.CCX_TEST_BATCH_SIZE): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TEST_BATCH_SIZE;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`CCX_TEST_BATCH_SIZE must be a positive integer, received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function forceIsolateAllFiles(raw = process.env.CCX_TEST_FORCE_ISOLATE): boolean {
  return raw === "1";
}

export function planParallelTests(
  files: readonly string[],
  options: { batchSize?: number; forceIsolate?: boolean; readSource?: (file: string) => string } = {},
): ParallelTestPlan {
  const batchSize = options.batchSize ?? resolveTestBatchSize();
  const forceIsolate = options.forceIsolate ?? forceIsolateAllFiles();
  const readSource = options.readSource ?? ((file: string) => readFileSync(file, "utf8"));

  const isolate: string[] = [];
  const batchable: string[] = [];
  for (const file of files) {
    if (forceIsolate || classifyTestFile(file, readSource(file)) === "isolate") {
      isolate.push(file);
    } else {
      batchable.push(file);
    }
  }

  const batches: string[][] = [];
  for (let offset = 0; offset < batchable.length; offset += batchSize) {
    batches.push(batchable.slice(offset, offset + batchSize));
  }
  return { isolate, batches };
}

export function filesFromFailedPlanItems(
  failed: readonly { files: readonly string[] }[],
): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const item of failed) {
    for (const file of item.files) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

/**
 * Parallel full-suite runner.
 *
 * `scripts/test.ts` runs one fresh process per test file (shard size 1) because
 * Bun 1.3.x on macOS can leave the event loop spinning after a server-heavy file
 * completes, stalling the next file in the same process. That isolation is
 * preserved here: each file still gets its own `bun test --isolate` process,
 * but up to `CCX_TEST_PARALLEL_WORKERS` of them run at the same time.
 *
 * On a multi-core machine this turns the serial ~40-minute full suite into a
 * few minutes. Default worker count is min(4, CPU count); override with
 * `CCX_TEST_PARALLEL_WORKERS`. Optional positional args restrict the run to the
 * given test files (useful for smoke probes).
 *
 * The same exclusivity queue as the serial runner applies: this script waits
 * for any other `bun test --isolate` runner to finish before starting, so two
 * suites never fight over the CPU.
 */
import { availableParallelism } from "node:os";
import {
  createIsolatedTestEnvironment,
  findCompetingTestRunners,
  listRepositoryTestFiles,
  waitForExclusiveRun,
} from "./test";

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

function runIsolatedFile(file: string): Promise<number> {
  const isolated = createIsolatedTestEnvironment();
  const memoryArgs = process.env.CCX_TEST_SMOL === "1" ? ["--smol"] : [];
  return Bun.spawn(
    [process.execPath, "test", "--isolate", ...memoryArgs, file],
    {
      env: isolated.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  ).exited.then((code) => {
    isolated.cleanup();
    return code ?? 1;
  });
}

if (import.meta.main) {
  const requested = process.argv.slice(2);
  await waitForExclusiveRun(process.pid);

  const files = requested.length > 0 ? requested : listRepositoryTestFiles();
  if (files.length === 0) throw new Error("no test files found");
  const workers = Math.min(resolveWorkerCount(), files.length);

  console.warn(
    `[test:parallel] ${files.length} file(s) across ${workers} worker(s)`
    + (requested.length > 0 ? " (explicit file list)" : " (CCX_TEST_PARALLEL_WORKERS to override)"),
  );

  const startedAt = Date.now();
  let next = 0;
  let failed = 0;
  const failures: string[] = [];

  const workerLoop = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      const file = files[index]!;
      const code = await runIsolatedFile(file);
      if (code !== 0) {
        failed += 1;
        failures.push(file);
      }
      console.warn(`[test:parallel] ${index + 1}/${files.length} ${code === 0 ? "ok" : "FAIL"} ${file}`);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => workerLoop()));
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);

  if (failures.length > 0) {
    console.error(`[test:parallel] ${failures.length} file(s) failed after ${minutes} min:`);
    for (const file of failures) console.error(`  ${file}`);
    process.exit(1);
  }
  console.warn(`[test:parallel] all ${files.length} file(s) passed in ${minutes} min`);
}

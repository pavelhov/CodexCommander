/**
 * Parallel full-suite runner.
 *
 * Cheap unit files share a process (batched, `--no-isolate`, one test at a
 * time). Server/subprocess files still get a dedicated `bun test --isolate`
 * process — Bun 1.3.x on macOS can leave the event loop spinning after those,
 * which is why the serial runner uses shard size 1.
 *
 * Default worker count is min(4, CPU count); override with
 * `CCX_TEST_PARALLEL_WORKERS`. Batch size defaults to 8 (`CCX_TEST_BATCH_SIZE`).
 * `CCX_TEST_FORCE_ISOLATE=1` restores one process per file.
 *
 * Failed items are retried once, file-by-file, on a single worker. That is the
 * load-flake recovery path: do not rerun the entire suite. Optional positional
 * args restrict the run to the given test files (including retry-only reruns).
 *
 * The same exclusivity queue as the serial runner applies.
 */
import { availableParallelism } from "node:os";
import { relative } from "node:path";
import {
  createIsolatedTestEnvironment,
  listRepositoryTestFiles,
  waitForExclusiveRun,
} from "./test";
import {
  filesFromFailedPlanItems,
  planParallelTests,
  resolveTestBatchSize,
} from "./test-plan";

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

interface WorkItem {
  files: string[];
  isolate: boolean;
}

function displayPath(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") ? rel : file;
}

function displayItem(item: WorkItem): string {
  if (item.files.length === 1) return displayPath(item.files[0]!);
  return `${item.files.length} files (${displayPath(item.files[0]!)} …)`;
}

function runWorkItem(item: WorkItem): Promise<number> {
  const isolated = createIsolatedTestEnvironment();
  const memoryArgs = process.env.CCX_TEST_SMOL === "1" ? ["--smol"] : [];
  const isolateArgs = item.isolate
    ? ["--isolate"]
    : ["--no-isolate", "--max-concurrency=1"];
  return Bun.spawn(
    [process.execPath, "test", ...isolateArgs, ...memoryArgs, ...item.files],
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

async function runQueue(items: WorkItem[], workers: number, label: string): Promise<WorkItem[]> {
  const workerCount = Math.min(workers, Math.max(1, items.length));
  let next = 0;
  const failures: WorkItem[] = [];

  const workerLoop = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index]!;
      const code = await runWorkItem(item);
      if (code !== 0) failures.push(item);
      console.warn(
        `[test:parallel] ${label} ${index + 1}/${items.length} ${code === 0 ? "ok" : "FAIL"} ${displayItem(item)}`,
      );
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
  return failures;
}

if (import.meta.main) {
  const requested = process.argv.slice(2);
  await waitForExclusiveRun(process.pid);

  const files = requested.length > 0 ? requested : listRepositoryTestFiles();
  if (files.length === 0) throw new Error("no test files found");

  const plan = planParallelTests(files);
  const items: WorkItem[] = [
    ...plan.batches.map(batch => ({ files: batch, isolate: false })),
    ...plan.isolate.map(file => ({ files: [file], isolate: true })),
  ];
  const workers = Math.min(resolveWorkerCount(), items.length);
  const retryCount = resolveRetryCount();

  console.warn(
    `[test:parallel] ${files.length} file(s): ${plan.isolate.length} isolated, ${plan.batches.length} batch(es) `
    + `of up to ${resolveTestBatchSize()} across ${workers} worker(s)`
    + (requested.length > 0 ? " (explicit file list)" : " (CCX_TEST_PARALLEL_WORKERS / CCX_TEST_BATCH_SIZE to override)"),
  );

  const startedAt = Date.now();
  let failures = await runQueue(items, workers, "run");
  const recovered: string[] = [];

  if (failures.length > 0 && retryCount > 0) {
    const retryFiles = filesFromFailedPlanItems(failures);
    console.warn(
      `[test:parallel] ${retryFiles.length} file(s) failed; retrying only those files (${retryCount} pass(es), 1 worker):`,
    );
    for (const file of retryFiles) console.warn(`  ${displayPath(file)}`);

    const stillFailing = new Set(retryFiles);
    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
      const retryItems: WorkItem[] = [...stillFailing].map(file => ({ files: [file], isolate: true }));
      const retryFailures = await runQueue(retryItems, 1, `retry ${attempt}/${retryCount}`);
      const failedThisPass = new Set(filesFromFailedPlanItems(retryFailures));
      for (const file of stillFailing) {
        if (!failedThisPass.has(file)) recovered.push(file);
      }
      stillFailing.clear();
      for (const file of failedThisPass) stillFailing.add(file);
      if (stillFailing.size === 0) break;
    }
    failures = [...stillFailing].map(file => ({ files: [file], isolate: true }));
  }

  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);

  if (recovered.length > 0) {
    console.warn(`[test:parallel] recovered after retry (${recovered.length} file(s)):`);
    for (const file of recovered) console.warn(`  ${displayPath(file)}`);
  }

  if (failures.length > 0) {
    const failedFiles = filesFromFailedPlanItems(failures);
    console.error(`[test:parallel] ${failedFiles.length} file(s) failed after ${minutes} min:`);
    for (const file of failedFiles) console.error(`  ${displayPath(file)}`);
    console.error("[test:parallel] rerun only the failed files, not the entire suite:");
    console.error(`  bun run test:parallel ${failedFiles.map(displayPath).join(" ")}`);
    process.exit(1);
  }
  console.warn(`[test:parallel] all ${files.length} file(s) passed in ${minutes} min`);
}

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandLineLooksLikeBunTest,
  createIsolatedTestEnvironment,
  DEFAULT_TEST_SHARD_SIZE,
  findCompetingTestRunners,
  listRepositoryTestFiles,
  partitionBunTestCliArgs,
  partitionTestFiles,
  resolveTestShardSize,
  resolveTestStartShard,
} from "../scripts/test";
import {
  bunTestArgvForWorkItem,
  diagnosticIsolateRetryItems,
  resolveRetryCount,
  resolveWorkerCount,
  retryFailuresInSameMode,
  retryQueueForFailures,
  type WorkItem,
} from "../scripts/test-parallel";
import {
  classifyTestFile,
  DEFAULT_TEST_BATCH_SIZE,
  filesFromFailedPlanItems,
  planParallelTests,
  resolveTestBatchSize,
} from "../scripts/test-plan";

describe("test runner isolation", () => {
  test("redirects user homes to a disposable root", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "/test/bin", HOME: "/real/home" });
    try {
      expect(isolated.env).toMatchObject({
        PATH: "/test/bin",
        HOME: isolated.root,
        USERPROFILE: isolated.root,
        CODEXCOMMANDER_HOME: join(isolated.root, ".codexcommander"),
        CODEX_HOME: join(isolated.root, ".codex"),
      });
      expect(existsSync(isolated.env.CODEXCOMMANDER_HOME!)).toBe(true);
      expect(existsSync(isolated.env.CODEX_HOME!)).toBe(true);
    } finally {
      isolated.cleanup();
    }
    expect(existsSync(isolated.root)).toBe(false);
  });

  test("partitions full-suite files without dropping or duplicating paths", () => {
    expect(partitionTestFiles(["a", "b", "c", "d", "e"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
    expect(partitionTestFiles([], 2)).toEqual([]);
    expect(() => partitionTestFiles(["a"], 0)).toThrow("positive integer");
  });

  test("parallel runner defaults to a bounded worker count and validates overrides", () => {
    expect(resolveWorkerCount(undefined, 10)).toBe(4);
    expect(resolveWorkerCount(undefined, 2)).toBe(2);
    expect(resolveWorkerCount("8", 10)).toBe(8);
    expect(() => resolveWorkerCount("0", 10)).toThrow("positive integer");
    expect(() => resolveWorkerCount("1.5", 10)).toThrow("positive integer");
    expect(() => resolveWorkerCount("x", 10)).toThrow("positive integer");
  });

  test("retries failed files once by default and validates overrides", () => {
    expect(resolveRetryCount(undefined)).toBe(1);
    expect(resolveRetryCount("0")).toBe(0);
    expect(resolveRetryCount("2")).toBe(2);
    expect(() => resolveRetryCount("-1")).toThrow("non-negative integer");
    expect(() => resolveRetryCount("1.5")).toThrow("non-negative integer");
  });

  test("classifies server, spawn, and HOME-mutating files as isolate; cheap unit files as batch", () => {
    expect(classifyTestFile("tests/adapter-resolve.test.ts", "expect(resolveAdapter()).toBe(\"x\")")).toBe("batch");
    expect(classifyTestFile("tests/server-auth.test.ts", "const server = startServer(0);")).toBe("isolate");
    expect(classifyTestFile("tests/cli-help.test.ts", "spawnSync(process.execPath, [cliPath]);")).toBe("isolate");
    expect(classifyTestFile("tests/config.test.ts", "saveConfig(config);")).toBe("isolate");
    expect(classifyTestFile("tests/e2e-style/native.test.ts", "expect(true).toBe(true);")).toBe("isolate");
  });

  test("plans batches without dropping isolate files, and flattens failed batch items for retry", () => {
    const original = process.env.CCX_TEST_BATCH_SIZE;
    delete process.env.CCX_TEST_BATCH_SIZE;
    try {
      expect(DEFAULT_TEST_BATCH_SIZE).toBe(8);
      expect(resolveTestBatchSize()).toBe(8);
    } finally {
      if (original === undefined) delete process.env.CCX_TEST_BATCH_SIZE;
      else process.env.CCX_TEST_BATCH_SIZE = original;
    }

    const plan = planParallelTests(
      ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"],
      {
        batchSize: 2,
        readSource: (file) => file === "c.test.ts" ? "startServer(0)" : "expect(1).toBe(1)",
      },
    );
    expect(plan.isolate).toEqual(["c.test.ts"]);
    expect(plan.batches).toEqual([["a.test.ts", "b.test.ts"], ["d.test.ts", "e.test.ts"]]);
    expect(filesFromFailedPlanItems([{ files: ["a.test.ts", "b.test.ts"] }, { files: ["a.test.ts"] }]))
      .toEqual(["a.test.ts", "b.test.ts"]);
    expect(resolveTestBatchSize("12")).toBe(12);
    expect(() => resolveTestBatchSize("0")).toThrow("positive integer");
  });

  test("uses a bounded default shard size and validates overrides", () => {
    const originalShardSize = process.env.CCX_TEST_SHARD_SIZE;
    delete process.env.CCX_TEST_SHARD_SIZE;
    try {
      expect(DEFAULT_TEST_SHARD_SIZE).toBe(1);
      expect(resolveTestShardSize()).toBe(1);
    } finally {
      if (originalShardSize === undefined) delete process.env.CCX_TEST_SHARD_SIZE;
      else process.env.CCX_TEST_SHARD_SIZE = originalShardSize;
    }
    expect(resolveTestShardSize("17")).toBe(17);
    expect(() => resolveTestShardSize("0")).toThrow("positive integer");
    expect(() => resolveTestShardSize("many")).toThrow("positive integer");
  });

  test("uses an explicit bounded start shard for safe manual resume", () => {
    const originalStartShard = process.env.CCX_TEST_START_SHARD;
    delete process.env.CCX_TEST_START_SHARD;
    try {
      expect(resolveTestStartShard(12)).toBe(1);
    } finally {
      if (originalStartShard === undefined) delete process.env.CCX_TEST_START_SHARD;
      else process.env.CCX_TEST_START_SHARD = originalStartShard;
    }
    expect(resolveTestStartShard(12, "7")).toBe(7);
    expect(() => resolveTestStartShard(12, "0")).toThrow("integer from 1 to 12");
    expect(() => resolveTestStartShard(12, "13")).toThrow("integer from 1 to 12");
    expect(() => resolveTestStartShard(12, "later")).toThrow("integer from 1 to 12");
    expect(() => resolveTestStartShard(0, "1")).toThrow("positive integer");
  });

  test("retries forward caller flags including --timeout", () => {
    expect(partitionBunTestCliArgs(["--timeout", "1", "tests/foo.test.ts", "tests/bar.test.ts"])).toEqual({
      flags: ["--timeout", "1"],
      targets: ["tests/foo.test.ts", "tests/bar.test.ts"],
    });
    expect(partitionBunTestCliArgs(["--timeout=1", "--bail", "tests/foo.test.ts"])).toEqual({
      flags: ["--timeout=1", "--bail"],
      targets: ["tests/foo.test.ts"],
    });
    expect(partitionBunTestCliArgs(["--bail", "tests/foo.test.ts"])).toEqual({
      flags: ["--bail"],
      targets: ["tests/foo.test.ts"],
    });
    expect(bunTestArgvForWorkItem(
      { files: ["tests/foo.test.ts", "tests/bar.test.ts"], isolate: false },
      ["--timeout", "1"],
    )).toEqual([
      "test",
      "--no-isolate",
      "--max-concurrency=1",
      "--timeout",
      "1",
      "tests/foo.test.ts",
      "tests/bar.test.ts",
    ]);
    expect(bunTestArgvForWorkItem(
      { files: ["tests/foo.test.ts"], isolate: true },
      ["--timeout", "1"],
    )).toEqual(["test", "--isolate", "--timeout", "1", "tests/foo.test.ts"]);
  });

  test("a shared-process batch failure stays a failure if files only pass isolated", async () => {
    const batch: WorkItem = { files: ["a.test.ts", "b.test.ts"], isolate: false };
    expect(retryQueueForFailures([batch])).toEqual([
      { files: ["a.test.ts", "b.test.ts"], isolate: false },
    ]);

    const fakeRun = async (items: WorkItem[]) => items.filter(item => !item.isolate);
    const result = await retryFailuresInSameMode([batch], 1, fakeRun);
    expect(result.failures).toEqual([batch]);
    expect(result.recovered).toEqual([]);

    const diagnostics = diagnosticIsolateRetryItems(result.failures);
    expect(diagnostics).toEqual([
      { files: ["a.test.ts"], isolate: true },
      { files: ["b.test.ts"], isolate: true },
    ]);
    expect(await fakeRun(diagnostics)).toEqual([]);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  test("a shared-process batch can recover when the same batch passes on retry", async () => {
    const batch: WorkItem = { files: ["a.test.ts", "b.test.ts"], isolate: false };
    const result = await retryFailuresInSameMode([batch], 1, async () => []);
    expect(result.failures).toEqual([]);
    expect(result.recovered).toEqual(["a.test.ts", "b.test.ts"]);
  });

  test("overlap lock matches bun test including --no-isolate and not the wrapper scripts", () => {
    expect(commandLineLooksLikeBunTest("/home/x/.bun/bin/bun test --no-isolate --max-concurrency=1 a.test.ts")).toBe(true);
    expect(commandLineLooksLikeBunTest("/home/x/.bun/bin/bun test --isolate a.test.ts")).toBe(true);
    expect(commandLineLooksLikeBunTest("/home/x/.bun/bin/bun test --parallel=4 tests")).toBe(true);
    expect(commandLineLooksLikeBunTest("C:\\Users\\x\\.bun\\bin\\bun.exe test --no-isolate a.test.ts")).toBe(true);
    expect(commandLineLooksLikeBunTest("/home/x/.bun/bin/bun scripts/test-parallel.ts")).toBe(false);
    expect(commandLineLooksLikeBunTest("/home/x/.bun/bin/bun scripts/test.ts")).toBe(false);
    expect(commandLineLooksLikeBunTest("/home/x/.bun/bin/bun gui/scripts/test.ts")).toBe(false);
  });

  test("overlap lock fires for a live --no-isolate bun test process", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "ccx-overlap-"));
    const file = join(dir, "hold.test.ts");
    writeFileSync(file, `
      test("hold the process for the overlap lock probe", async () => {
        await Bun.sleep(30_000);
      });
    `);
    writeFileSync(join(dir, "bunfig.toml"), "[test]\n");
    const child = Bun.spawn(
      [process.execPath, "test", "--no-isolate", "--timeout", "30000", file],
      {
        cwd: dir,
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, CCX_TEST_NO_QUEUE: "1" },
      },
    );
    try {
      const started = Date.now();
      let seen = false;
      while (Date.now() - started < 8_000) {
        const competing = findCompetingTestRunners(process.pid);
        if (child.pid !== undefined && competing.includes(child.pid)) {
          seen = true;
          break;
        }
        await Bun.sleep(50);
      }
      expect(seen).toBe(true);
    } finally {
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discovers Bun test filename patterns in stable order", () => {
    const root = mkdtempSync(join(tmpdir(), "ccx-test-discovery-"));
    try {
      mkdirSync(join(root, "nested"));
      for (const path of [
        join(root, "zeta.test.ts"),
        join(root, "nested", "alpha.spec.tsx"),
        join(root, "nested", "beta_test.js"),
        join(root, "ignored.ts"),
      ]) writeFileSync(path, "", "utf8");

      expect(listRepositoryTestFiles(root)).toEqual([
        join(root, "nested", "alpha.spec.tsx"),
        join(root, "nested", "beta_test.js"),
        join(root, "zeta.test.ts"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

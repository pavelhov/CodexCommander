import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIsolatedTestEnvironment,
  DEFAULT_TEST_SHARD_SIZE,
  listRepositoryTestFiles,
  partitionTestFiles,
  resolveTestShardSize,
  resolveTestStartShard,
} from "../scripts/test";
import { resolveWorkerCount } from "../scripts/test-parallel";

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

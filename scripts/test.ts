import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Bun 1.3.x on macOS can leave its event loop spinning after a server-heavy test
// file completes, preventing the next file in the same process from starting.
// A fresh process per file keeps the full suite deterministic across file-order
// changes. CI and local runs can still opt into larger shards explicitly.
export const DEFAULT_TEST_SHARD_SIZE = 1;

const BUN_TEST_FILE_PATTERN = /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx)$/;

export interface IsolatedTestEnvironment {
  root: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

export function createIsolatedTestEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): IsolatedTestEnvironment {
  const root = mkdtempSync(join(tmpdir(), "codexcommander-test-"));
  const codexCommanderHome = join(root, ".codexcommander");
  const codexHome = join(root, ".codex");
  mkdirSync(codexCommanderHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  return {
    root,
    env: {
      ...baseEnv,
      // Captured BEFORE HOME is overwritten: once the child starts with a rewritten
      // HOME, `homedir()` returns the sandbox, so this hand-off is the only way the
      // real-home write guard can still know which path to protect.
      // (implementation contract)
      CCX_REAL_HOME: baseEnv.CCX_REAL_HOME ?? homedir(),
      HOME: root,
      USERPROFILE: root,
      CODEXCOMMANDER_HOME: codexCommanderHome,
      CODEX_HOME: codexHome,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Discover the same test-file shapes Bun searches for, in stable path order. */
export function listRepositoryTestFiles(testRoot = join(process.cwd(), "tests")): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && BUN_TEST_FILE_PATTERN.test(entry.name)) files.push(path);
    }
  };
  visit(testRoot);
  return files.sort((a, b) => a.localeCompare(b));
}

export function resolveTestShardSize(raw = process.env.CCX_TEST_SHARD_SIZE): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TEST_SHARD_SIZE;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`CCX_TEST_SHARD_SIZE must be a positive integer, received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function resolveTestStartShard(
  shardCount: number,
  raw = process.env.CCX_TEST_START_SHARD,
): number {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(`test shard count must be a positive integer, received ${shardCount}`);
  }
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > shardCount) {
    throw new Error(
      `CCX_TEST_START_SHARD must be an integer from 1 to ${shardCount}, received ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

export function partitionTestFiles(files: readonly string[], shardSize: number): string[][] {
  if (!Number.isSafeInteger(shardSize) || shardSize < 1) {
    throw new Error(`test shard size must be a positive integer, received ${shardSize}`);
  }
  const shards: string[][] = [];
  for (let offset = 0; offset < files.length; offset += shardSize) {
    shards.push(files.slice(offset, offset + shardSize));
  }
  return shards;
}

function runIsolatedTestProcess(testArgs: readonly string[]): number {
  const isolated = createIsolatedTestEnvironment();
  try {
    const memoryArgs = process.env.CCX_TEST_SMOL === "1" ? ["--smol"] : [];
    const child = Bun.spawnSync(
      [process.execPath, "test", "--isolate", ...memoryArgs, ...testArgs],
      {
        env: isolated.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    return child.exitCode ?? 1;
  } finally {
    isolated.cleanup();
  }
}

/**
 * Other `bun test` runners already on this machine.
 *
 * Two full suites sharing one CPU do not fail — they crawl. A run that normally
 * finishes in about 210s took 26 minutes against a runner an earlier session had
 * left behind, and neither process said anything, so the slowdown read as a hang
 * in this suite. Bun's own timeouts cannot see the contention, so name it here.
 *
 * `pgrep` is absent on Windows and may exit non-zero for "no matches"; both cases
 * mean "nothing to warn about" rather than an error worth failing a test run over.
 */
function findCompetingTestRunners(selfPid: number): number[] {
  try {
    const found = Bun.spawnSync(["pgrep", "-f", "bun.*test --isolate"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!found.success) return [];
    return new TextDecoder().decode(found.stdout)
      .split("\n")
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== selfPid);
  } catch {
    return [];
  }
}

/**
 * Wait until this machine has no other full-suite runner, then proceed.
 *
 * Warning about contention was not enough: the warning scrolls past, the run still
 * starts, and four concurrent suites drove load average to 10 and turned a ~210s
 * suite into a 13-minute one that read as a hang. Agents in parallel worktrees each
 * think they are the only runner, so the serialization has to live here rather than
 * in anyone's discipline.
 *
 * Queue rather than refuse: a failed `bun run test` invites `bun test` directly,
 * which bypasses this file entirely. Waiting is the behavior that survives being
 * worked around. `CCX_TEST_NO_QUEUE=1` opts out for anyone who really wants overlap.
 */
async function waitForExclusiveRun(selfPid: number): Promise<void> {
  if (process.env.CCX_TEST_NO_QUEUE === "1") return;
  const pollMs = 5_000;
  // Long enough for a full suite plus slack; past this, assume the holder is wedged
  // rather than working and let this run start anyway.
  const maxWaitMs = 45 * 60 * 1000;
  const startedAt = Date.now();
  let announced = false;
  for (;;) {
    const competing = findCompetingTestRunners(selfPid);
    if (competing.length === 0) {
      if (announced) {
        console.warn(`[test] the other runner(s) finished after ${Math.round((Date.now() - startedAt) / 1000)}s; starting.`);
      }
      return;
    }
    if (Date.now() - startedAt > maxWaitMs) {
      console.warn(
        `[test] still waiting on pid ${competing.join(", ")} after ${Math.round(maxWaitMs / 60000)} minutes. `
        + "Assuming they are stuck and starting anyway; expect a slow run.",
      );
      return;
    }
    if (!announced) {
      announced = true;
      console.warn(
        `[test] ${competing.length} other bun test runner(s) already running (pid ${competing.join(", ")}). `
        + "Waiting for them to finish so the suites do not fight over the CPU. "
        + "Set CCX_TEST_NO_QUEUE=1 to run concurrently anyway.",
      );
    }
    await Bun.sleep(pollMs);
  }
}

if (import.meta.main) {
  try {
    const requestedTests = process.argv.slice(2);
    await waitForExclusiveRun(process.pid);
    const startedAt = Date.now();
    let exitCode = 0;

    if (requestedTests.length > 0 || process.env.CCX_TEST_NO_SHARDS === "1") {
      exitCode = runIsolatedTestProcess(requestedTests.length > 0 ? requestedTests : ["./tests/"]);
    } else {
      const files = listRepositoryTestFiles();
      const shardSize = resolveTestShardSize();
      const shards = partitionTestFiles(files, shardSize);
      if (shards.length === 0) throw new Error("no test files found under ./tests");
      const startShard = resolveTestStartShard(shards.length);

      if (startShard > 1) {
        console.warn(
          `[test] resuming at shard ${startShard}/${shards.length}; this is a partial run. `
          + `Combine it only with a prior green 1-${startShard - 1} run from the same revision and worktree.`,
        );
      }

      for (let index = startShard - 1; index < shards.length; index += 1) {
        const shard = shards[index]!;
        console.warn(`[test] shard ${index + 1}/${shards.length} (${shard.length} files)`);
        exitCode = runIsolatedTestProcess(shard);
        if (exitCode !== 0) {
          console.error(`[test] shard ${index + 1}/${shards.length} failed; stopping.`);
          console.error(
            `[test] after fixing the failure, set CCX_TEST_START_SHARD to ${index + 1} `
            + `and CCX_TEST_SHARD_SIZE to ${shardSize}, then run bun run test.`,
          );
          break;
        }
      }
      if (exitCode === 0) {
        if (startShard === 1) console.warn(`[test] all ${shards.length} shards passed.`);
        else console.warn(`[test] resumed shards ${startShard}-${shards.length} passed (partial run).`);
      }
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (requestedTests.length === 0 && elapsedSeconds > 600) {
      console.warn(
        `[test] the suite took ${elapsedSeconds}s; it normally runs in about 210s on an idle machine. `
        + "Check for another test runner, a busy CPU, or a test that started polling something real.",
      );
    }
    process.exitCode = exitCode;
  } catch (error) {
    console.error(`[test] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * The production call edge, proven by contention rather than by a spy.
 *
 * `withCodexWriteLock` shipped with zero production callers, and every test it
 * had exercised it with a fabricated snapshot. The property that matters is not
 * "the lock function was invoked" — a pass-through mock satisfies that — but
 * that two real processes running the real injection cannot both write.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const CHILD = join(repoRoot, "tests", "helpers", "codex-inject-race-child.ts");
const LOCK_CHILD = join(repoRoot, "tests", "helpers", "codex-write-lock-child.ts");

let root = "";
let codexHome = "";
let codexCommanderHome = "";
const cleanup: string[] = [];

function seedNative(): void {
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
}

function runInject(port: number, lockTimeoutMs = 0): { success: boolean; status?: "skipped"; retryable: boolean; message: string } {
  const result = spawnSync(process.execPath, [CHILD], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEXCOMMANDER_HOME: codexCommanderHome,
      CCX_INJECT_RACE_PAYLOAD: JSON.stringify({ port, lockTimeoutMs }),
    },
  });
  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(line) as { success: boolean; status?: "skipped"; retryable: boolean; message: string };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccx-inject-race-"));
  cleanup.push(root);
  codexHome = join(root, ".codex");
  codexCommanderHome = join(root, ".codexcommander");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(codexCommanderHome, { recursive: true });
});

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("the lock is on the production path", () => {
  test("a persisted OFF observed under N skips the real injector without writing", () => {
    seedNative();
    const configPath = join(codexHome, "config.toml");
    const before = readFileSync(configPath, "utf8");
    writeFileSync(join(codexCommanderHome, "config.json"), JSON.stringify({
      port: 10100,
      multiAgentGuidanceEnabled: true,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
      clientIntegrations: { codex: false },
    }));

    const result = runInject(20200);

    expect(result).toMatchObject({ success: true, status: "skipped" });
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("a clean first apply coordinates and records a transition", () => {
    seedNative();
    const result = runInject(10100);
    expect(result.success).toBeTrue();

    // The row is the proof that the lock ran, not that the function was called.
    const state = spawnSync(process.execPath, ["--eval", `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: codexCommanderHome },
    });
    const row = JSON.parse((state.stdout ?? "{}").trim().split("\n").pop() ?? "{}") as {
      kind?: string;
      state?: { nativeGeneration?: number; currentTxId?: string | null };
    };
    expect(row.kind).toBe("ready");
    expect(row.state?.nativeGeneration).toBeGreaterThan(0);
    // Guessing null passes on a fresh machine and fails on a real one, so the
    // id being present is part of the claim.
    expect(typeof row.state?.currentTxId).toBe("string");
  });

  /**
   * The contention proof. A real second process holds N through the production
   * lock module while a real injection runs; the injection must report busy and
   * must not have written its candidate bytes.
   */
  test("a held lock makes real injection report busy and write nothing", () => {
    seedNative();
    // Establish the coordinator first: a clean home has no row, and the holder
    // needs one to contend over.
    expect(runInject(10100).success).toBeTrue();
    const afterFirst = readFileSync(join(codexHome, "config.toml"), "utf-8");

    const holdMarker = join(root, "held");
    const releaseMarker = join(root, "release");
    const holder = Bun.spawn([process.execPath, LOCK_CHILD], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEXCOMMANDER_HOME: codexCommanderHome,
        CCX_LOCK_CHILD_PAYLOAD: JSON.stringify({ timeoutMs: 5_000, holdMarker, releaseMarker }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const deadline = Date.now() + 10_000;
    while (!existsSync(holdMarker) && Date.now() < deadline) {
      spawnSync(process.execPath, ["--eval", "Bun.sleepSync(20)"], { encoding: "utf8" });
    }
    expect(existsSync(holdMarker)).toBeTrue();

    // PROCESS-UNIQUE bytes: a different port means different candidate bytes, so
    // the loser's work is identifiable rather than assumed.
    const contender = runInject(20200);

    writeFileSync(releaseMarker, "go");
    holder.exited.then(() => undefined);

    expect(contender.success).toBeFalse();
    expect(contender.retryable).toBeTrue();
    // Its bytes are absent: the file still names the first winner's port.
    const finalConfig = readFileSync(join(codexHome, "config.toml"), "utf-8");
    expect(finalConfig).not.toContain("20200");
    expect(finalConfig).toBe(afterFirst);
  }, 30_000);
});

describe("uncoordinated routed homes are not adopted", () => {
  test("routed residue without a current coordinator is refused without mutation", () => {
    const original = [
      'model_provider = "codexcommander"',
      'model = "gpt-5.5"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'name = "CodexCommander Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original);

    const result = runInject(10100);
    expect(result.success).toBeFalse();
    expect(result.message).toContain("routing residue exists without a current coordinator");
    expect(readFileSync(join(codexHome, "config.toml"), "utf-8")).toBe(original);
  });
});

describe("the native transition is published", () => {
  test("a completed apply records the current native generation", () => {
    seedNative();
    expect(runInject(10100).success).toBeTrue();

    const state = spawnSync(process.execPath, ["--eval", `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: codexCommanderHome },
    });
    const row = JSON.parse((state.stdout ?? "{}").trim().split("\n").pop() ?? "{}") as {
      kind?: string;
      state?: { nativeGeneration?: number; currentTxId?: string | null };
    };
    expect(row.kind).toBe("ready");
    expect(row.state?.nativeGeneration).toBe(1);
    expect(row.state?.currentTxId).toEqual(expect.any(String));
  });
});

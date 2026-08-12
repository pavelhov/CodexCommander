/** Dashboard restart delegates to the canonical detached tray helper. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "bun:test";
import { ManagementRequest as Request } from "./helpers/management-auth";
import { handleManagementAPI } from "../src/server/management-api";
import { setServerRef } from "../src/server/lifecycle";
import {
  acceptSerializedSystemRestart,
  setSystemRestartIoForTests,
  spawnDetachedTrayRestart,
  trayRestartHelperArgv,
} from "../src/server/management/system-restart";
import {
  BUN_RUNTIME_PATH_ENV,
  BUN_RUNTIME_SOURCES,
  BUN_RUNTIME_SOURCE_ENV,
} from "../src/lib/bun-runtime";
import type { CodexCommanderConfig } from "../src/types";

class FakeChild extends EventEmitter {
  pid = 222;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  unrefCount = 0;
  unref(): this { this.unrefCount += 1; return this; }
}

function config(): CodexCommanderConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        defaultModel: "gpt-test",
      },
    },
  };
}

function request(): Request {
  return new Request("http://127.0.0.1:10100/api/system/restart", { method: "POST" });
}

afterEach(() => {
  setSystemRestartIoForTests();
  setServerRef(undefined);
});

describe("detached restart helper", () => {
  test("uses fixed internal argv, retains packaged Bun hardening, and clears CCX_SERVICE", async () => {
    const child = new FakeChild();
    let executable: string | undefined;
    let argv: readonly string[] | undefined;
    let options: Record<string, unknown> | undefined;
    const spawned = spawnDetachedTrayRestart(() => {}, {
      entry: "/app/runtime/src/cli/index.ts",
      execArgv: ["--inspect", "--no-install", "--no-env-file", "--config=/dev/null", "-e"],
      env: { CCX_SERVICE: "1", CCX_TEST_SENTINEL: "kept" },
      spawnFn: ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
        executable = file;
        argv = args;
        options = opts;
        return child;
      }) as typeof import("node:child_process").spawn,
    });

    let settled = false;
    void spawned.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("spawn");
    await spawned;

    expect(executable).toBe(process.execPath);
    expect(argv).toEqual([
      "--no-install",
      "--no-env-file",
      "--config=/dev/null",
      "/app/runtime/src/cli/index.ts",
      "__tray-restart",
    ]);
    expect(options?.detached).toBe(true);
    expect(options?.stdio).toBe("ignore");
    expect((options?.env as NodeJS.ProcessEnv).CCX_SERVICE).toBeUndefined();
    expect((options?.env as NodeJS.ProcessEnv).CCX_TEST_SENTINEL).toBe("kept");
    expect(BUN_RUNTIME_SOURCES).toContain(
      (options?.env as NodeJS.ProcessEnv)[BUN_RUNTIME_SOURCE_ENV],
    );
    expect((options?.env as NodeJS.ProcessEnv)[BUN_RUNTIME_PATH_ENV]).toBe(process.execPath);
    expect(child.unrefCount).toBe(1);
  });

  test("a post-spawn child error is treated like early helper exit", async () => {
    const child = new FakeChild();
    let exited = 0;
    const spawned = spawnDetachedTrayRestart(() => { exited += 1; }, {
      entry: "/safe/index.ts",
      execArgv: [],
      spawnFn: (() => child) as typeof import("node:child_process").spawn,
    });
    child.emit("spawn");
    await spawned;
    child.emit("error", new Error("fixture post-spawn error"));
    expect(exited).toBe(1);
  });

  test("never forwards arbitrary runtime flags", () => {
    expect(trayRestartHelperArgv("/safe/index.ts", [
      "--inspect", "--preload=attacker.ts", "--no-install", "--no-install",
    ])).toEqual(["--no-install", "/safe/index.ts", "__tray-restart"]);
  });
});

describe("restart admission", () => {
  test("waits for spawn proof and latches duplicate requests", async () => {
    let proveSpawn!: () => void;
    let spawnCount = 0;
    const io = {
      getActiveTurnCount: () => 2,
      spawnHelper: async () => {
        spawnCount += 1;
        await new Promise<void>(resolve => { proveSpawn = resolve; });
      },
    };
    const firstPending = acceptSerializedSystemRestart(io);
    const secondPending = acceptSerializedSystemRestart(io);
    let firstSettled = false;
    void firstPending.then(() => { firstSettled = true; });
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(spawnCount).toBe(1);

    proveSpawn();
    expect(await firstPending).toEqual({
      kind: "accepted",
      activeTurnCount: 2,
      drainTimeoutMs: 0,
    });
    expect(await secondPending).toEqual({
      kind: "already-accepted",
      activeTurnCount: 2,
      drainTimeoutMs: 0,
    });
    expect((await acceptSerializedSystemRestart(io)).kind).toBe("already-accepted");
    expect(spawnCount).toBe(1);
  });

  test("spawn refusal leaves admission retryable", async () => {
    let spawnCount = 0;
    const io = {
      getActiveTurnCount: () => 1,
      spawnHelper: async () => {
        spawnCount += 1;
        if (spawnCount === 1) throw new Error("fixture refusal");
      },
    };

    expect((await acceptSerializedSystemRestart(io)).kind).toBe("refused");
    expect((await acceptSerializedSystemRestart(io)).kind).toBe("accepted");
    expect(spawnCount).toBe(2);
  });

  test("helper exit while the old parent remains re-arms a second restart", async () => {
    let onExit: (() => void) | undefined;
    let spawnCount = 0;
    const io = {
      getActiveTurnCount: () => 0,
      spawnHelper: async (exit: () => void) => {
        spawnCount += 1;
        onExit = exit;
      },
    };

    expect((await acceptSerializedSystemRestart(io)).kind).toBe("accepted");
    expect(spawnCount).toBe(1);
    onExit?.();
    expect((await acceptSerializedSystemRestart(io)).kind).toBe("accepted");
    expect(spawnCount).toBe(2);
  });
});

describe("POST /api/system/restart", () => {
  test("returns 202 after helper spawn without draining the listener or exiting the parent", async () => {
    let listenerStops = 0;
    setServerRef({
      port: 10100,
      stop() { listenerStops += 1; },
    } as unknown as ReturnType<typeof Bun.serve>);
    setSystemRestartIoForTests({
      getActiveTurnCount: () => 3,
      spawnHelper: async () => {},
    });

    const res = await handleManagementAPI(request(), new URL(request().url), config());
    expect(res?.status).toBe(202);
    expect(listenerStops).toBe(0);
    const body = await res!.json() as {
      success: boolean;
      activeTurnCount: number;
      drainTimeoutMs: number;
      alreadyDraining: boolean;
      message: string;
    };
    expect(body).toEqual({
      success: true,
      message: "Safe proxy restart accepted.",
      activeTurnCount: 3,
      drainTimeoutMs: 0,
      alreadyDraining: false,
    });
    // Reaching this assertion with the same PID is the behavioral proof that
    // the authenticated API handler did not call process.exit.
    expect(process.pid).toBeGreaterThan(0);
  });

  test("returns 409 on spawn refusal and accepts a later retry", async () => {
    let spawnCount = 0;
    setSystemRestartIoForTests({
      getActiveTurnCount: () => 1,
      spawnHelper: async () => {
        spawnCount += 1;
        if (spawnCount === 1) throw new Error("fixture refusal");
      },
    });

    const first = await handleManagementAPI(request(), new URL(request().url), config());
    expect(first?.status).toBe(409);
    expect((await first!.json() as { success: boolean }).success).toBe(false);
    const second = await handleManagementAPI(request(), new URL(request().url), config());
    expect(second?.status).toBe(202);
    expect(spawnCount).toBe(2);
  });

  test("returns an already-accepted 202 without spawning a duplicate helper", async () => {
    let spawnCount = 0;
    setSystemRestartIoForTests({
      spawnHelper: async () => { spawnCount += 1; },
    });

    expect((await handleManagementAPI(request(), new URL(request().url), config()))?.status).toBe(202);
    const duplicate = await handleManagementAPI(request(), new URL(request().url), config());
    expect(duplicate?.status).toBe(202);
    const body = await duplicate!.json() as { alreadyDraining: boolean; message: string };
    expect(body.alreadyDraining).toBe(true);
    expect(body.message).toBe("Restart already accepted.");
    expect(spawnCount).toBe(1);
  });
});

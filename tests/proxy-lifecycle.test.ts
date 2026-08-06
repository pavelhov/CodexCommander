import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  ensureProxyLifecycle,
  findLiveProxyForStart,
  macOSCompanionOpenArguments,
  spawnDetachedProxyStart,
  type EnsureProxyLifecycleIo,
} from "../src/cli/proxy-lifecycle";
import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCES, BUN_RUNTIME_SOURCE_ENV } from "../src/lib/bun-runtime";
import type { ServiceDiagnostic } from "../src/service";
import type { LivenessIo } from "../src/server/proxy-liveness";
import type { OcxConfig } from "../src/types";

function config(codexAutoStart = true): OcxConfig {
  return {
    port: 10100,
    codexAutoStart,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
    },
  } as OcxConfig;
}

function service(overrides: Partial<ServiceDiagnostic> = {}): ServiceDiagnostic {
  return {
    supported: true,
    installed: false,
    enabled: false,
    running: false,
    viable: false,
    startable: false,
    stale: false,
    conflict: false,
    backend: null,
    summary: "not installed",
    ...overrides,
  };
}

function baseIo(overrides: EnsureProxyLifecycleIo = {}): EnsureProxyLifecycleIo {
  return {
    loadConfig: () => config(),
    findLive: async () => null,
    reconcile: () => {},
    acquireEnsureLock: async () => ({ release: () => {} }),
    diagnoseService: () => service(),
    syncLive: async () => {},
    ensureCompanion: async () => false,
    ...overrides,
  };
}

describe("shared proxy lifecycle authority", () => {
  test("explicit start probes its requested fallback port without hiding local runtime records", async () => {
    const seen: Array<{ port?: number; hostname?: string } | null> = [];
    const findLive = async (io: LivenessIo = {}) => {
      seen.push(io.configFn?.() ?? null);
      return null;
    };

    await findLiveProxyForStart(undefined, config(), findLive);
    await findLiveProxyForStart(62991, { port: 10100, hostname: "127.0.0.1" }, findLive);

    expect(seen).toEqual([null, { port: 62991, hostname: "127.0.0.1" }]);
  });

  test("an already-live identity is reused without starting another process", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        acquireEnsureLock: async () => {
          calls.push("lock");
          return { release: () => { calls.push("release"); } };
        },
        spawnStart: async () => { calls.push("spawn"); },
        startService: () => { calls.push("service"); return true; },
        syncLive: async live => { calls.push(`sync:${live.port}`); },
        ensureCompanion: async () => { calls.push("companion"); return true; },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      state: "running",
      changed: false,
      pid: 42,
      port: 10123,
    });
    expect(calls).toEqual(["lock", "sync:10123", "release", "companion"]);
  });

  test("already-live ensure callers serialize managed-client sync", async () => {
    let held = false;
    const waiters: Array<() => void> = [];
    const acquireEnsureLock = async () => {
      if (held) await new Promise<void>(resolve => waiters.push(resolve));
      held = true;
      return {
        release: () => {
          held = false;
          waiters.shift()?.();
        },
      };
    };
    let activeSyncs = 0;
    let maxActiveSyncs = 0;
    const io = baseIo({
      findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
      acquireEnsureLock,
      syncLive: async () => {
        activeSyncs += 1;
        maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
        await Bun.sleep(5);
        activeSyncs -= 1;
      },
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => ensureProxyLifecycle({ io })));
    expect(results.every(result => result.ok && result.pid === 42)).toBe(true);
    expect(maxActiveSyncs).toBe(1);
  });

  test("the CLI autostart preference gates only honorAutoStart callers", async () => {
    const result = await ensureProxyLifecycle({
      honorAutoStart: true,
      io: baseIo({ loadConfig: () => config(false) }),
    });
    expect(result).toMatchObject({
      ok: true,
      state: "disabled",
      errorCode: "AUTOSTART_DISABLED",
    });
  });

  test("a viable installed service is started and direct spawn is not attempted", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      io: baseIo({
        diagnoseService: () => service({
          installed: true,
          startable: true,
          backend: "launchd",
          summary: "installed",
        }),
        startService: () => { calls.push("service"); return true; },
        spawnStart: async () => { calls.push("spawn"); },
        waitForProxy: async () => ({ pid: 77, port: 10100, source: "runtime" }),
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(calls).toEqual(["service"]);
  });

  test("a stale installed service blocks unmanaged fallback", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      io: baseIo({
        diagnoseService: () => service({
          installed: true,
          startable: false,
          stale: true,
          summary: "stale",
        }),
        spawnStart: async () => { calls.push("spawn"); },
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      state: "blocked",
      errorCode: "SERVICE_BLOCKED",
    });
    expect(calls).toEqual([]);
  });

  test("an unverifiable service state fails closed and releases startup authority", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      io: baseIo({
        acquireEnsureLock: async () => ({ release: () => { calls.push("release"); } }),
        diagnoseService: () => { throw new Error("permission denied"); },
        spawnStart: async () => { calls.push("spawn"); },
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      state: "blocked",
      errorCode: "SERVICE_BLOCKED",
    });
    expect(calls).toEqual(["release"]);
  });

  test("an installed service start refusal never falls back to an unmanaged child", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      io: baseIo({
        diagnoseService: () => service({
          installed: true,
          startable: true,
          backend: "launchd",
        }),
        startService: () => { throw new Error("launchctl denied start"); },
        spawnStart: async () => { calls.push("spawn"); },
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      state: "blocked",
      errorCode: "SERVICE_BLOCKED",
    });
    expect(calls).toEqual([]);
  });

  test("an unmanaged start publishes only after identity-checked health", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      io: baseIo({
        spawnStart: async port => { calls.push(`spawn:${port}`); },
        waitForProxy: async timeout => {
          calls.push(`wait:${timeout}`);
          return { pid: 88, port: 10100, source: "runtime" };
        },
        syncLive: async live => { calls.push(`sync:${live.pid}`); },
      }),
    });
    expect(result).toMatchObject({ ok: true, pid: 88, port: 10100, changed: true });
    expect(calls).toEqual(["spawn:10100", "wait:20000", "sync:88"]);
  });

  test("the shared detached launcher preserves caller env and stamps runtime provenance", async () => {
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    let unrefCalled = false;
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => { unrefCalled = true; };
    const spawnFn = ((_command: string, _args: readonly string[], options: SpawnOptions) => {
      spawnedEnv = options.env;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    }) as unknown as typeof nodeSpawn;

    await spawnDetachedProxyStart({
      port: 10124,
      entry: "/repo/src/cli/index.ts",
      env: { OCX_SERVICE: "1", OCX_TEST_SENTINEL: "kept" },
      spawnFn,
    });

    expect(spawnedEnv?.OCX_SERVICE).toBe("1");
    expect(spawnedEnv?.OCX_TEST_SENTINEL).toBe("kept");
    expect(spawnedEnv?.[BUN_RUNTIME_PATH_ENV]).toBe(process.execPath);
    expect(BUN_RUNTIME_SOURCES).toContain(spawnedEnv?.[BUN_RUNTIME_SOURCE_ENV]);
    expect(unrefCalled).toBe(true);
  });

  test("macOS companion launch targets only dist/macos or the fixed bundle id", () => {
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      appPath: "/repo/dist/macos/OpenCodex.app",
      exists: () => true,
    })).toEqual(["-g", "/repo/dist/macos/OpenCodex.app"]);
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      appPath: "/repo/dist/macos/OpenCodex.app",
      exists: () => false,
    })).toEqual(["-g", "-b", "com.opencodex.menubar"]);
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: { OCX_SERVICE: "1" },
      exists: () => true,
    })).toBeNull();
    expect(JSON.stringify(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      appPath: "/repo/dist/macos/OpenCodex.app",
      exists: () => true,
    }))).not.toContain("Application Support");
  });
});

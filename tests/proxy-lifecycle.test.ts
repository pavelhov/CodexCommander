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
import type { CodexCommanderConfig } from "../src/types";

function config(codexAutoStart = true): CodexCommanderConfig {
  return {
    port: 10100,
    codexAutoStart,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
    },
  } as CodexCommanderConfig;
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
    waitForReady: async () => "ready",
    syncLive: async () => ({
      status: "applied",
      ok: true,
      catalogQuality: "live",
      catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
    }),
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
        syncLive: async live => {
          calls.push(`sync:${live.port}`);
          return {
            status: "applied",
            ok: true,
            catalogQuality: "live",
            catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
          };
        },
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

  test("an already-live sync refusal is surfaced while the healthy proxy stays running", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        acquireEnsureLock: async () => ({ release: () => { calls.push("release"); } }),
        syncLive: async () => ({
          status: "refused",
          ok: false,
          message: "Catalog publication was refused safely.",
        }),
        ensureCompanion: async () => { calls.push("companion"); return true; },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      state: "running",
      changed: false,
      pid: 42,
      port: 10123,
      errorCode: "SYNC_FAILED",
      message: "Catalog publication was refused safely.",
    });
    expect(calls).toEqual(["release", "companion"]);
  });

  test("a failed current sync stays fatal", async () => {
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        syncLive: async () => ({
          status: "failed",
          ok: false,
          lifecycleErrorCode: "SYNC_FAILED",
          message: "The running CodexCommander proxy could not synchronize its catalog.",
        }),
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      state: "running",
      pid: 42,
      port: 10123,
      errorCode: "SYNC_FAILED",
    });
    expect(result.message).toContain("could not synchronize");
    expect(result.codexRestartRequired).toBeUndefined();
  });

  test("a successful sync without the current catalog-state payload fails closed", async () => {
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        syncLive: async () => ({
          status: "applied",
          ok: true,
          catalogQuality: "live",
        }),
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      state: "running",
      errorCode: "SYNC_FAILED",
    });
    expect(result.message).toContain("invalid catalog state");
  });

  test("integration OFF is a converged lifecycle state", async () => {
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        syncLive: async () => ({
          status: "skipped",
          skippedReason: "desired_disabled",
          ok: true,
          catalogQuality: "native-only",
          catalogState: { state: "stale", processes: [], catalogMtimeMs: null },
        }),
      }),
    });

    expect(result).toMatchObject({ ok: true, state: "running", pid: 42 });
  });

  test("an explicitly external-provider native-only result is converged", async () => {
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        syncLive: async () => ({
          status: "skipped",
          skippedReason: "external_provider",
          ok: true,
          catalogQuality: "native-only",
          message: "External Codex provider preserved.",
          catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
        }),
      }),
    });

    expect(result).toMatchObject({ ok: true, state: "running", pid: 42 });
  });

  test("an unclassified native-only result fails closed", async () => {
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        syncLive: async () => ({
          status: "applied",
          ok: true,
          catalogQuality: "native-only",
          message: "Catalog write completed without routed rows.",
          catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
        }),
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      state: "running",
      pid: 42,
      errorCode: "SYNC_FAILED",
    });
  });

  test("a stale Codex worker catalog is a nonfatal update-ready notice", async () => {
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        syncLive: async () => ({
          status: "applied",
          ok: true,
          catalogQuality: "retained",
          catalogWritten: true,
          catalogState: {
            state: "stale",
            catalogMtimeMs: 2_000,
            processes: [
              { pid: 81, startedAtMs: 1_000 },
              { pid: 82, startedAtMs: 3_000 },
            ],
          },
        }),
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      state: "running",
      pid: 42,
      errorCode: "CODEX_RESTART_REQUIRED",
      catalogUpdated: true,
      codexRestartRequired: true,
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
    expect(result.message).toContain("update ready");
  });

  test("a generic post-write hint cannot override an explicit fresh worker state", async () => {
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        syncLive: async () => ({
          status: "applied",
          ok: true,
          catalogQuality: "live",
          catalogWritten: true,
          staleAppServerHint: "restart if stale",
          catalogState: { state: "fresh", processes: [], catalogMtimeMs: null },
        }),
      }),
    });

    expect(result).toMatchObject({ ok: true, state: "running", pid: 42 });
    expect(result.errorCode).toBeUndefined();
    expect(result.codexRestartRequired).toBeUndefined();
  });

  test("a real sync failure remains fatal even when worker state is stale", async () => {
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        syncLive: async () => ({
          status: "applied",
          ok: false,
          catalogQuality: "retained",
          catalogWritten: true,
          catalogState: { state: "stale", processes: [], catalogMtimeMs: null },
          message: "Catalog config injection failed.",
        }),
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      state: "running",
      pid: 42,
      errorCode: "SYNC_FAILED",
      message: "Catalog config injection failed.",
    });
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
        return {
          status: "applied",
          ok: true,
          catalogQuality: "live",
          catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
        };
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
        waitForReady: async live => {
          calls.push(`ready:${live.pid}`);
          return "ready";
        },
        syncLive: async live => {
          calls.push(`sync:${live.pid}`);
          return {
            status: "applied",
            ok: true,
            catalogQuality: "live",
            catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
          };
        },
      }),
    });
    expect(result).toMatchObject({ ok: true, pid: 88, port: 10100, changed: true });
    expect(calls).toEqual(["spawn:10100", "wait:20000", "ready:88", "sync:88"]);
  });

  test("failed startup readiness retries catalog convergence and never tears down the live proxy", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      io: baseIo({
        spawnStart: async () => { calls.push("spawn"); },
        waitForProxy: async () => ({ pid: 88, port: 10100, source: "runtime" }),
        waitForReady: async () => { calls.push("ready:failed"); return "failed"; },
        syncLive: async () => {
          calls.push("sync:retry");
          return {
            status: "applied",
            ok: true,
            catalogQuality: "retained",
            catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
          };
        },
      }),
    });

    expect(result).toMatchObject({ ok: true, state: "running", changed: true, pid: 88 });
    expect(calls).toEqual(["spawn", "ready:failed", "sync:retry"]);
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
      env: { CCX_SERVICE: "1", CCX_TEST_SENTINEL: "kept" },
      spawnFn,
    });

    expect(spawnedEnv?.CCX_SERVICE).toBe("1");
    expect(spawnedEnv?.CCX_TEST_SENTINEL).toBe("kept");
    expect(spawnedEnv?.[BUN_RUNTIME_PATH_ENV]).toBe(process.execPath);
    expect(BUN_RUNTIME_SOURCES).toContain(spawnedEnv?.[BUN_RUNTIME_SOURCE_ENV]);
    expect(unrefCalled).toBe(true);
  });

  test("macOS companion launch targets the canonical app or fixed bundle id", () => {
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      appPath: "/repo/dist/macos/CodexCommander.app",
      exists: () => true,
    })).toEqual(["-g", "/repo/dist/macos/CodexCommander.app"]);
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      appPath: "/repo/dist/macos/CodexCommander.app",
      exists: () => false,
    })).toEqual(["-g", "-b", "com.codexcommander.menubar"]);
    // Default path prefers the rebranded CodexCommander.app when it exists.
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      exists: (p) => p.endsWith("/dist/macos/CodexCommander.app"),
    })).toEqual(["-g", expect.stringContaining("/dist/macos/CodexCommander.app")]);
    // No local build at all: open by the rebranded bundle id.
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      exists: () => false,
    })).toEqual(["-g", "-b", "com.codexcommander.menubar"]);
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: { CCX_SERVICE: "1" },
      exists: () => true,
    })).toBeNull();
    expect(JSON.stringify(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      appPath: "/repo/dist/macos/CodexCommander.app",
      exists: () => true,
    }))).not.toContain("Application Support");
  });
});

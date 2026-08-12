import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  ensureProxyLifecycle,
  findLiveProxyForStart,
  macOSCompanionOpenArguments,
  prepareExplicitProxyStart,
  restoreBackRoutingLifecycle,
  spawnDetachedProxyStart,
  stopProxyLifecycle,
  type EnsureProxyLifecycleIo,
} from "../src/cli/proxy-lifecycle";
import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCES, BUN_RUNTIME_SOURCE_ENV } from "../src/lib/bun-runtime";
import type { ServiceDiagnostic } from "../src/service";
import type { LivenessIo } from "../src/server/proxy-liveness";
import type { CodexCommanderConfig } from "../src/types";
import type { ProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
import { PROXY_DELEGATED_START_ENV } from "../src/server/proxy-lifecycle-protocol";

function authority(
  calls: string[] = [],
  overrides: Partial<ProxyLifecycleAuthority> = {},
): ProxyLifecycleAuthority {
  let startHeld = true;
  const value: ProxyLifecycleAuthority = {
    deadlineAt: Number.POSITIVE_INFINITY,
    ensure: { token: "ensure-token", release: () => value.releaseAll() },
    get start() {
      return startHeld ? { token: "start-token", release: () => value.releaseStart() } : undefined;
    },
    acquireStart: async () => {
      startHeld = true;
      return { token: "start-token", release: () => value.releaseStart() };
    },
    delegatedLease: () => startHeld
      ? { ensureToken: "ensure-token", startToken: "start-token" }
      : undefined,
    releaseStart: () => {
      if (!startHeld) return;
      startHeld = false;
      calls.push("release-S");
    },
    releaseAll: () => {
      value.releaseStart();
      calls.push("release-E");
    },
  };
  return Object.assign(value, overrides);
}

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
    registrationState: "absent",
    supervisorState: "inactive",
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
    journalPending: () => false,
    externalProvider: () => null,
    acquireAuthority: async () => authority(),
    diagnoseService: () => service(),
    waitForReady: async () => "ready",
    restoreNative: () => ({
      success: true,
      changed: true,
      desiredChanged: true,
      configChanged: false,
      message: "native",
    }),
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
  test("Stop cannot pass an in-flight explicit Start while E is held", async () => {
    const calls: string[] = [];
    let held = false;
    const waiters: Array<() => void> = [];
    let nextToken = 0;
    const acquireAuthority = async () => {
      while (held) await new Promise<void>(resolve => waiters.push(resolve));
      held = true;
      calls.push("acquire-E");
      nextToken += 1;
      return authority([], {
        releaseAll: () => {
          calls.push("release-S");
          calls.push("release-E");
          held = false;
          waiters.shift()?.();
        },
      });
    };
    let allowSync!: () => void;
    const syncBlocked = new Promise<void>(resolve => { allowSync = resolve; });
    let syncEntered!: () => void;
    const entered = new Promise<void>(resolve => { syncEntered = resolve; });

    const starting = ensureProxyLifecycle({
      action: "start",
      ensureCompanion: false,
      io: baseIo({
        acquireAuthority,
        findLive: async () => ({ pid: 41, port: 10100, source: "runtime" }),
        setEnabled: (_client, enabled) => {
          calls.push(`enabled:${enabled}`);
          return { ok: true, status: "committed", enabled };
        },
        syncLive: async () => {
          calls.push("sync-enter");
          syncEntered();
          await syncBlocked;
          calls.push("sync-exit");
          return {
            status: "applied",
            ok: true,
            catalogQuality: "live",
            catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
          };
        },
      }),
    });
    await entered;

    const stopping = stopProxyLifecycle({
      io: {
        acquireAuthority,
        diagnoseService: () => service(),
        stopService: () => false,
        restoreNative: () => {
          calls.push("enabled:false");
          return {
            success: true,
            changed: true,
            desiredChanged: true,
            configChanged: true,
            message: "native",
          };
        },
        stripGrok: () => ({ ok: true, changed: false, message: "native" }),
        readPid: () => null,
        readPidFileValue: () => null,
        readRuntimePort: () => null,
        findLive: async () => null,
        findSurvivor: async () => null,
      },
    });
    await Bun.sleep(10);
    expect(calls).not.toContain("enabled:false");

    allowSync();
    const [started, stopped] = await Promise.all([starting, stopping]);
    expect(started.ok).toBe(true);
    expect(stopped.ok).toBe(true);
    expect(calls.indexOf("sync-exit")).toBeLessThan(calls.indexOf("release-E"));
    expect(calls.indexOf("release-E")).toBeLessThan(calls.indexOf("enabled:false"));
  });

  test("a native escape refusal leaves service and proxy running", async () => {
    const calls: string[] = [];
    const result = await stopProxyLifecycle({
      io: {
        diagnoseService: () => {
          calls.push("diagnose");
          return service({ installed: true, running: true });
        },
        restoreNative: () => {
          calls.push("restore");
          return {
            success: false,
            changed: false,
            desiredChanged: false,
            configChanged: false,
            message: "refused",
          };
        },
        findLive: async () => {
          calls.push("find-live");
          return { pid: 42, port: 10100, source: "runtime" };
        },
        stopService: () => {
          calls.push("stop-service");
          return true;
        },
        stopProxy: async () => {
          calls.push("stop-proxy");
        },
      },
    });

    expect(result).toMatchObject({
      action: "stop",
      ok: false,
      state: "running",
      pid: 42,
      port: 10100,
      errorCode: "STOP_FAILED",
    });
    expect(calls).toEqual(["diagnose", "restore", "find-live"]);
  });

  test("a desired-state write refusal stops before restore or termination", async () => {
    const calls: string[] = [];
    const result = await stopProxyLifecycle({
      io: {
        diagnoseService: () => {
          calls.push("diagnose");
          return service({ installed: true, running: true });
        },
        restoreNative: () => {
          calls.push("disable");
          return {
            success: false,
            changed: false,
            desiredChanged: false,
            configChanged: false,
            message: "write refused",
          };
        },
        findLive: async () => {
          calls.push("find-live");
          return { pid: 42, port: 10100, source: "runtime" };
        },
        stopService: () => {
          calls.push("stop-service");
          return true;
        },
        stopProxy: async () => {
          calls.push("stop-proxy");
        },
      },
    });

    expect(result).toMatchObject({
      action: "stop",
      ok: false,
      state: "running",
      pid: 42,
      port: 10100,
      errorCode: "STOP_FAILED",
    });
    expect(calls).toEqual(["diagnose", "disable", "find-live"]);
  });

  test("automatic ensure while Codex is OFF does not prepare, enable, or reconcile", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      action: "ensure",
      io: baseIo({
        loadConfig: () => ({ ...config(), clientIntegrations: { codex: false } }),
        setEnabled: () => {
          calls.push("enable");
          return { ok: true, status: "committed", enabled: true };
        },
        reconcile: () => { calls.push("reconcile"); },
        journalPending: () => { calls.push("journal"); return true; },
        findLive: async () => {
          calls.push("find");
          return { pid: 42, port: 10100, source: "runtime" };
        },
        syncLive: async () => {
          calls.push("sync");
          return {
            status: "skipped",
            skippedReason: "desired_disabled",
            ok: true,
            catalogQuality: "native-only",
            catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
          };
        },
      }),
    });

    expect(result).toMatchObject({ ok: true, state: "running" });
    expect(calls).toEqual(["find", "sync"]);
  });

  test("explicit start strictly retires a pending journal before enabling", () => {
    const calls: string[] = [];
    let pending = true;
    const result = prepareExplicitProxyStart({
      externalProvider: () => null,
      journalPending: () => {
        calls.push("journal");
        return pending;
      },
      retireExplicitJournal: owner => {
        calls.push(`explicit:${owner.kind}`);
        return false;
      },
      reconcile: () => {
        calls.push("reconcile");
        pending = false;
        return true;
      },
      setEnabled: (_client, enabled) => {
        calls.push("enable");
        return { ok: true, status: "committed", enabled };
      },
    });

    expect(result).toMatchObject({ success: true, changed: true });
    expect(calls).toEqual(["journal", "explicit:dead", "reconcile", "journal", "enable"]);
  });

  test("repeated Route Back preserves an exact active live-owner journal", () => {
    const calls: string[] = [];
    const result = prepareExplicitProxyStart({
      externalProvider: () => null,
      journalPending: () => {
        calls.push("journal");
        return true;
      },
      protectedLiveOwnerPid: 42,
      desiredEnabled: () => {
        calls.push("desired");
        return true;
      },
      classifyActiveJournal: pid => {
        calls.push(`classify:${pid}`);
        return { kind: "active-managed-postimage" };
      },
      retireExplicitJournal: () => {
        calls.push("retire");
        return false;
      },
      reconcile: () => {
        calls.push("reconcile");
        return false;
      },
      setEnabled: (_client, enabled) => {
        calls.push(`enable:${enabled}`);
        return { ok: true, status: "unchanged", enabled };
      },
    });

    expect(result).toEqual({
      success: true,
      changed: false,
      message: "Codex is already routing through this live proxy.",
    });
    expect(calls).toEqual(["journal", "desired", "classify:42", "enable:true"]);
  });

  test("native OFF with a live-owner journal still uses exact retirement", () => {
    const calls: string[] = [];
    let pending = true;
    const result = prepareExplicitProxyStart({
      externalProvider: () => null,
      journalPending: () => {
        calls.push("journal");
        return pending;
      },
      protectedLiveOwnerPid: 42,
      desiredEnabled: () => {
        calls.push("desired");
        return false;
      },
      classifyActiveJournal: () => {
        calls.push("classify");
        return { kind: "active-managed-postimage" };
      },
      retireExplicitJournal: owner => {
        calls.push(`retire:${owner.kind}`);
        pending = false;
        return true;
      },
      setEnabled: (_client, enabled) => {
        calls.push(`enable:${enabled}`);
        return { ok: true, status: "committed", enabled };
      },
    });

    expect(result).toMatchObject({ success: true, changed: true });
    expect(calls).toEqual([
      "journal",
      "desired",
      "retire:protected-live",
      "journal",
      "enable:true",
    ]);
  });

  test("an unsafe live-owner journal refuses without enabling", () => {
    const calls: string[] = [];
    const result = prepareExplicitProxyStart({
      externalProvider: () => null,
      journalPending: () => true,
      protectedLiveOwnerPid: 42,
      desiredEnabled: () => true,
      classifyActiveJournal: () => ({
        kind: "not-active-managed-postimage",
        reason: "owner-mismatch",
      }),
      retireExplicitJournal: owner => {
        calls.push(`retire:${owner.kind}`);
        return false;
      },
      reconcile: () => {
        calls.push("reconcile");
        return false;
      },
      setEnabled: (_client, enabled) => {
        calls.push(`enable:${enabled}`);
        return { ok: true, status: "committed", enabled };
      },
    });

    expect(result).toMatchObject({
      success: false,
      changed: false,
      reason: "routing-recovery-unverified",
    });
    expect(calls).toEqual(["retire:protected-live", "retire:dead", "reconcile"]);
  });

  test("Restore Back exposes a typed recovery refusal to lifecycle clients", async () => {
    const result = await restoreBackRoutingLifecycle({
      acquireAuthority: async () => authority(),
      findLive: async () => ({ pid: 42, port: 10100, source: "runtime" }),
      journalPending: () => true,
      desiredEnabled: () => true,
      classifyActiveJournal: () => ({
        kind: "not-active-managed-postimage",
        reason: "owner-mismatch",
      }),
      retireExplicitJournal: () => false,
      reconcile: () => false,
      setEnabled: (_client, enabled) => ({ ok: true, status: "unchanged", enabled }),
    });

    expect(result).toMatchObject({
      ok: false,
      state: "running",
      errorCode: "ROUTING_RECOVERY_REQUIRED",
    });
  });

  test("explicit start retires an external-provider journal before enabling", () => {
    const calls: string[] = [];
    let pending = true;
    const result = prepareExplicitProxyStart({
      externalProvider: () => "custom",
      journalPending: () => {
        calls.push("journal");
        return pending;
      },
      reconcile: () => { calls.push("reconcile"); return true; },
      retireExplicitJournal: owner => {
        calls.push(`explicit:${owner.kind}`);
        return false;
      },
      retireExternalJournal: provider => {
        calls.push(`retire:${provider}`);
        pending = false;
        return true;
      },
      setEnabled: (_client, enabled) => {
        calls.push("enable");
        return { ok: true, status: "committed", enabled };
      },
    });

    expect(result).toMatchObject({ success: true, changed: true });
    expect(calls).toEqual(["journal", "explicit:dead", "retire:custom", "journal", "enable"]);
  });

  test("explicit start recovery refusal leaves the durable switch OFF", () => {
    const calls: string[] = [];
    const result = prepareExplicitProxyStart({
      externalProvider: () => null,
      journalPending: () => true,
      retireExplicitJournal: () => false,
      reconcile: () => { calls.push("reconcile"); return false; },
      setEnabled: (_client, enabled) => {
        calls.push(`enable:${enabled}`);
        return { ok: true, status: "committed", enabled };
      },
    });

    expect(result).toMatchObject({ success: false, changed: false });
    expect(calls).toEqual(["reconcile"]);
  });

  test("explicit start reports a durable ON change even when the proxy was already live", async () => {
    const result = await ensureProxyLifecycle({
      action: "start",
      io: baseIo({
        setEnabled: (_client, enabled) => ({ ok: true, status: "committed", enabled }),
        findLive: async () => ({ pid: 42, port: 10100, source: "runtime" }),
      }),
    });

    expect(result).toMatchObject({ ok: true, state: "running", changed: true });
  });

  test("explicit start passes only the protected runtime PID to journal retirement", async () => {
    const owners: unknown[] = [];
    let pending = true;
    const result = await ensureProxyLifecycle({
      action: "start",
      io: baseIo({
        journalPending: () => pending,
        retireExplicitJournal: owner => {
          owners.push(owner);
          pending = false;
          return true;
        },
        setEnabled: (_client, enabled) => ({ ok: true, status: "committed", enabled }),
        findLive: async () => ({ pid: 42, port: 10100, source: "runtime" }),
      }),
    });

    expect(result).toMatchObject({ ok: true, state: "running", pid: 42 });
    expect(owners).toEqual([{ kind: "protected-live", pid: 42 }]);
  });

  test("explicit start and Restore Back reject recordless listeners before routing mutation", async () => {
    const calls: string[] = [];
    const io = {
      findLive: async () => ({ pid: 41, port: 10100, source: "config" as const }),
      journalPending: () => { calls.push("journal"); return true; },
      setEnabled: () => {
        calls.push("enable");
        return { ok: true as const, status: "committed" as const, enabled: true };
      },
      syncModels: async () => {
        calls.push("sync");
        return { status: "applied" as const, ok: true };
      },
      acquireEnsureLock: async () => ({ release: () => {} }),
    };

    const started = await ensureProxyLifecycle({ action: "start", io: baseIo(io) });
    const restored = await restoreBackRoutingLifecycle(io);
    expect(started).toMatchObject({ ok: false, state: "blocked" });
    expect(restored).toMatchObject({ ok: false, state: "blocked" });
    expect(calls).toEqual([]);
  });

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
        acquireAuthority: async () => {
          calls.push("lock");
          return authority(calls);
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
    expect(calls).toEqual(["lock", "sync:10123", "release-S", "release-E", "companion"]);
  });

  test("an already-live sync refusal is surfaced while the healthy proxy stays running", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      io: baseIo({
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        acquireAuthority: async () => authority(calls),
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
    expect(calls).toEqual(["release-S", "release-E", "companion"]);
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

  test("a canonical OpenAI-only catalog reaches the stale-worker update path", async () => {
    const nativeConfig = {
      port: 10100,
      codexAutoStart: true,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
    } as CodexCommanderConfig;
    const result = await ensureProxyLifecycle({
      io: baseIo({
        loadConfig: () => nativeConfig,
        findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
        syncLive: async () => ({
          status: "applied",
          ok: true,
          catalogQuality: "native-only",
          catalogWritten: true,
          catalogState: {
            state: "stale",
            catalogMtimeMs: 2_000,
            processes: [{ pid: 81, startedAtMs: 1_000 }],
          },
        }),
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      state: "running",
      errorCode: "CODEX_RESTART_REQUIRED",
      codexRestartRequired: true,
      staleWorkerCount: 1,
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
    const acquireAuthority = async () => {
      if (held) await new Promise<void>(resolve => waiters.push(resolve));
      held = true;
      return authority([], {
        releaseAll: () => {
          held = false;
          waiters.shift()?.();
        },
      });
    };
    let activeSyncs = 0;
    let maxActiveSyncs = 0;
    const io = baseIo({
      findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
      acquireAuthority,
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
          registrationState: "present",
          supervisorState: "inactive",
          installed: true,
          startable: true,
          backend: "launchd",
          summary: "installed",
        }),
        armServiceStartDelegation: ensureToken => {
          calls.push(`arm:${ensureToken}`);
          return {
            token: "delegation",
            ensureToken,
            ownerPid: process.pid,
            expiresAt: Date.now() + 1_000,
          };
        },
        clearServiceStartDelegation: () => { calls.push("clear"); },
        startService: () => { calls.push("service"); return true; },
        spawnStart: async () => { calls.push("spawn"); },
        waitForProxy: async () => ({ pid: 77, port: 10100, source: "runtime" }),
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(calls).toEqual(["arm:ensure-token", "service", "clear"]);
  });

  test("a stale installed service blocks unmanaged fallback", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      io: baseIo({
        diagnoseService: () => service({
          registrationState: "present",
          supervisorState: "inactive",
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
        acquireAuthority: async () => authority(calls),
        diagnoseService: () => { throw new Error("permission denied"); },
        spawnStart: async () => { calls.push("spawn"); },
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      state: "blocked",
      errorCode: "SERVICE_BLOCKED",
    });
    expect(calls).toEqual(["release-S", "release-E"]);
  });

  test("an installed service start refusal never falls back to an unmanaged child", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      action: "start",
      io: baseIo({
        setEnabled: (_client, enabled) => {
          calls.push(`enabled:${enabled}`);
          return { ok: true, status: "committed", enabled };
        },
        diagnoseService: () => service({
          registrationState: "present",
          supervisorState: "inactive",
          installed: true,
          startable: true,
          backend: "launchd",
        }),
        armServiceStartDelegation: ensureToken => {
          calls.push(`arm:${ensureToken}`);
          return {
            token: "delegation",
            ensureToken,
            ownerPid: process.pid,
            expiresAt: Date.now() + 1_000,
          };
        },
        clearServiceStartDelegation: () => { calls.push("clear"); },
        startService: () => {
          calls.push("service-refused");
          throw new Error("launchctl denied start");
        },
        spawnStart: async () => { calls.push("spawn"); },
        restoreNative: () => {
          calls.push("restore-native");
          return {
            success: true,
            changed: true,
            desiredChanged: true,
            configChanged: false,
            message: "external provider preserved",
          };
        },
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      state: "blocked",
      errorCode: "SERVICE_BLOCKED",
    });
    expect(calls).toEqual([
      "enabled:true",
      "arm:ensure-token",
      "service-refused",
      "clear",
      "restore-native",
    ]);
    expect(result.message).toContain("Native Codex routing was restored");
  });

  test("explicit detached spawn refusal rolls routing back before lifecycle authority is released", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      action: "start",
      io: baseIo({
        acquireAuthority: async () => {
          calls.push("acquire-E");
          return authority(calls);
        },
        setEnabled: (_client, enabled) => {
          calls.push(`enabled:${enabled}`);
          return { ok: true, status: "committed", enabled };
        },
        spawnStart: async () => {
          calls.push("spawn-refused");
          throw new Error("spawn refused");
        },
        restoreNative: () => {
          calls.push("restore-native");
          return {
            success: true,
            changed: true,
            desiredChanged: true,
            configChanged: false,
            message: "external provider bytes preserved",
          };
        },
      }),
    });

    expect(result).toMatchObject({ ok: false, state: "failed", errorCode: "START_FAILED" });
    expect(result.message).toContain("Native Codex routing was restored");
    expect(calls).toEqual([
      "acquire-E", "enabled:true", "spawn-refused", "restore-native", "release-S", "release-E",
    ]);
  });

  test("explicit start health timeout restores prior native routing without touching external provider bytes", async () => {
    const calls: string[] = [];
    const result = await ensureProxyLifecycle({
      action: "start",
      waitTimeoutMs: 5,
      io: baseIo({
        acquireAuthority: async () => {
          calls.push("acquire-E");
          return authority(calls);
        },
        externalProvider: () => "custom-provider",
        setEnabled: (_client, enabled) => {
          calls.push(`enabled:${enabled}`);
          return { ok: true, status: "committed", enabled };
        },
        spawnStart: async () => { calls.push("spawn"); },
        waitForProxy: async timeout => {
          calls.push(`wait:${timeout}`);
          return null;
        },
        restoreNative: () => {
          calls.push("restore-native:config-unchanged");
          return {
            success: true,
            changed: true,
            desiredChanged: true,
            configChanged: false,
            message: "external provider preserved byte-for-byte",
          };
        },
      }),
    });

    expect(result).toMatchObject({ ok: false, state: "failed", errorCode: "START_FAILED" });
    expect(result.message).toContain("Native Codex routing was restored");
    expect(calls).toEqual([
      "acquire-E", "enabled:true", "spawn", "wait:5",
      "restore-native:config-unchanged", "release-S", "release-E",
    ]);
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
      env: { [PROXY_DELEGATED_START_ENV]: "1", CCX_TEST_SENTINEL: "kept" },
      spawnFn,
    });

    expect(spawnedEnv?.[PROXY_DELEGATED_START_ENV]).toBe("1");
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
    })).toEqual([
      "-g", "/repo/dist/macos/CodexCommander.app",
      "--args", "--ccx-passive-launch",
    ]);
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      appPath: "/repo/dist/macos/CodexCommander.app",
      exists: () => false,
    })).toEqual([
      "-g", "-b", "com.codexcommander.menubar",
      "--args", "--ccx-passive-launch",
    ]);
    // Default path prefers the rebranded CodexCommander.app when it exists.
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      exists: (p) => p.endsWith("/dist/macos/CodexCommander.app"),
    })).toEqual([
      "-g", expect.stringContaining("/dist/macos/CodexCommander.app"),
      "--args", "--ccx-passive-launch",
    ]);
    // No local build at all: open by the rebranded bundle id.
    expect(macOSCompanionOpenArguments({
      platform: "darwin",
      env: {},
      exists: () => false,
    })).toEqual([
      "-g", "-b", "com.codexcommander.menubar",
      "--args", "--ccx-passive-launch",
    ]);
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

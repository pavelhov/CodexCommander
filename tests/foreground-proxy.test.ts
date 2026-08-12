import { describe, expect, test } from "bun:test";

import type { CliCodexSyncResult } from "../src/cli/catalog-activation";
import {
  runForegroundProxyStart,
  runForegroundStartupInitialization,
  type ForegroundProxyStartIo,
} from "../src/cli/foreground-proxy";
import { createReadinessGate } from "../src/server/readiness";
import type { ProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
import {
  PROXY_DELEGATED_START_ENV,
  PROXY_ENSURE_LEASE_HEADER,
  PROXY_START_LEASE_HEADER,
} from "../src/server/proxy-lifecycle-protocol";
import type { LiveProxy } from "../src/server/proxy-liveness";
import type { CodexCommanderConfig } from "../src/types";

const config = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: {
    mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
  },
  shutdownTimeoutMs: 25,
} as CodexCommanderConfig;

function makeAuthority(events: string[]): ProxyLifecycleAuthority {
  const ensure = { token: "ensure", release: () => {} };
  const start = { token: "start", release: () => {} };
  let released = false;
  return {
    deadlineAt: 1_000,
    ensure,
    start,
    acquireStart: async () => start,
    delegatedLease: () => ({ ensureToken: "ensure", startToken: "start" }),
    releaseStart: () => {},
    releaseAll: () => {
      if (released) return;
      released = true;
      events.push("release-authority");
    },
  };
}

function successfulCatalogSync(): CliCodexSyncResult {
  return {
    status: "applied",
    ok: true,
    added: 0,
    catalogPath: null,
    catalogExists: false,
    catalogWritten: false,
    cacheSynced: false,
    catalogQuality: "live",
    rehydrated: 0,
    message: "synchronized",
    activation: { catalog: { status: "current" } },
  };
}

function baseStartIo(
  events: string[],
  overrides: ForegroundProxyStartIo = {},
): ForegroundProxyStartIo {
  const startServer = ((_port: number) => {
    events.push("bind");
    return {};
  }) as NonNullable<ForegroundProxyStartIo["startServer"]>;

  return {
    env: {},
    logger: {
      log: message => events.push(`log:${message}`),
      error: message => events.push(`error:${message}`),
    },
    loadServiceToken: () => null,
    acquireAuthority: async options => {
      events.push(`authority:${options?.includeStart === true}`);
      return makeAuthority(events);
    },
    loadConfig: () => config,
    readPid: () => null,
    removePid: () => events.push("remove-pid"),
    removeRuntimePort: () => events.push("remove-runtime"),
    writePid: () => events.push("write-pid"),
    writeRuntimePort: () => events.push("write-runtime"),
    findLive: async () => {
      events.push("probe");
      return null;
    },
    routing: {
      externalProvider: () => null,
      journalPending: () => {
        events.push("routing-read");
        return false;
      },
      setEnabled: (_client, enabled) => {
        events.push(`routing-write:${enabled}`);
        return { ok: true, status: "unchanged", enabled };
      },
    },
    externalProvider: () => null,
    choosePort: async () => {
      events.push("choose-port");
      return 19191;
    },
    startServer,
    scheduleCatalogPrewarm: () => events.push("prewarm"),
    installCrashGuards: () => events.push("crash-guards"),
    createAttestationSecret: () => "local-attestation-secret",
    startGuardian: () => ({ stop: () => events.push("stop-guardian") }),
    isRecyclingForExit: () => false,
    revertSystemEnv: () => events.push("revert-env"),
    restoreNative: () => ({
      success: true,
      changed: true,
      desiredChanged: true,
      configChanged: true,
      message: "native",
    }),
    serviceEnvironmentOwnedHere: () => false,
    stripGrok: () => ({ ok: true, changed: false, message: "native" }),
    drainAndShutdown: async () => events.push("drain"),
    initializeStartup: async () => events.push("initialize"),
    onSignal: () => {},
    onExit: () => {},
    ...overrides,
  };
}

describe("foreground proxy lifecycle", () => {
  test("acquires E then S authority before explicit routing mutation and bind", async () => {
    const events: string[] = [];

    const status = await runForegroundProxyStart([], {
      block: false,
      io: baseStartIo(events),
    });

    expect(status).toBe(0);
    const authorityAt = events.indexOf("authority:true");
    const probeAt = events.indexOf("probe");
    const mutationAt = events.indexOf("routing-write:true");
    const bindAt = events.indexOf("bind");
    expect(authorityAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeGreaterThan(authorityAt);
    expect(mutationAt).toBeGreaterThan(probeAt);
    expect(bindAt).toBeGreaterThan(mutationAt);
    expect(events.at(-1)).toBe("release-authority");
  });

  test("a pre-bind explicit Start failure rolls routing back to native before releasing E", async () => {
    const events: string[] = [];
    const io = baseStartIo(events, {
      choosePort: async () => {
        events.push("choose-port-failed");
        throw new Error("port selection failed");
      },
      restoreNative: () => {
        events.push("rollback-off-and-native");
        return {
          success: true,
          changed: true,
          desiredChanged: true,
          configChanged: true,
          message: "native",
        };
      },
    });

    await expect(runForegroundProxyStart([], { block: false, io })).rejects.toThrow(
      "port selection failed",
    );
    expect(events.indexOf("routing-write:true")).toBeLessThan(
      events.indexOf("choose-port-failed"),
    );
    expect(events.indexOf("rollback-off-and-native")).toBeLessThan(
      events.indexOf("release-authority"),
    );
    expect(events).not.toContain("bind");
  });

  test("fixed-port exhaustion uses the same native rollback path", async () => {
    const events: string[] = [];
    const busy = Object.assign(new Error("busy"), { code: "EADDRINUSE" });
    const io = baseStartIo(events, {
      startServer: (() => {
        events.push("bind-busy");
        throw busy;
      }) as NonNullable<ForegroundProxyStartIo["startServer"]>,
      waitForPortAvailable: async () => false,
      restoreNative: () => {
        events.push("rollback-off-and-native");
        return {
          success: true,
          changed: true,
          desiredChanged: true,
          configChanged: true,
          message: "native",
        };
      },
    });

    expect(await runForegroundProxyStart(["--port", "19191"], { block: false, io })).toBe(1);
    expect(events).toContain("rollback-off-and-native");
    expect(events.indexOf("rollback-off-and-native")).toBeLessThan(
      events.indexOf("release-authority"),
    );
  });

  test("post-bind failure restores native before drain and stays live if restore refuses", async () => {
    const events: string[] = [];
    const gate = createReadinessGate();
    const io = baseStartIo(events, {
      createReadinessGate: () => gate,
      writeRuntimePort: () => {
        events.push("publish-runtime-failed");
        throw new Error("runtime publication failed");
      },
      restoreNative: () => {
        events.push("restore-refused");
        return {
          success: false,
          changed: false,
          desiredChanged: false,
          configChanged: false,
          message: "ownership changed",
        };
      },
      drainAndShutdown: async () => events.push("unexpected-drain"),
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(0);
    expect(gate.getStatus()).toBe("failed");
    expect(events).toContain("restore-refused");
    expect(events).not.toContain("unexpected-drain");
    expect(events).not.toContain("remove-pid");
    expect(events).not.toContain("remove-runtime");
    expect(events.at(-1)).toBe("release-authority");
  });

  test("reuses a current-home live proxy by preparing and synchronizing without binding", async () => {
    const events: string[] = [];
    const live: LiveProxy = {
      pid: 4242,
      port: 10100,
      hostname: "127.0.0.1",
      source: "runtime",
    };
    const io = baseStartIo(events, {
      findLive: async () => {
        events.push("probe-current-home");
        return live;
      },
      syncCatalog: async (candidate, _deps, lease) => {
        events.push(`sync:${candidate?.pid}`);
        events.push(`lease:${lease?.ensureToken}:${lease?.startToken}`);
        return successfulCatalogSync();
      },
      catalogCanApply: () => true,
      choosePort: async () => {
        events.push("unexpected-port-choice");
        return 19191;
      },
      startServer: (() => {
        events.push("unexpected-bind");
        return {};
      }) as NonNullable<ForegroundProxyStartIo["startServer"]>,
    });

    const status = await runForegroundProxyStart([], { block: false, io });

    expect(status).toBe(0);
    expect(events.indexOf("routing-write:true")).toBeGreaterThan(
      events.indexOf("probe-current-home"),
    );
    expect(events.indexOf("sync:4242")).toBeGreaterThan(
      events.indexOf("routing-write:true"),
    );
    expect(events).toContain("lease:ensure:start");
    expect(events).not.toContain("unexpected-port-choice");
    expect(events).not.toContain("unexpected-bind");
    expect(events.at(-1)).toBe("release-authority");
  });

  test("refuses a recordless listener before routing mutation or bind", async () => {
    const events: string[] = [];
    const io = baseStartIo(events, {
      findLive: async () => {
        events.push("probe-recordless");
        return { pid: null, port: 10100, hostname: "127.0.0.1", source: "config" };
      },
    });

    const status = await runForegroundProxyStart([], { block: false, io });

    expect(status).toBe(1);
    expect(events).not.toContain("routing-read");
    expect(events).not.toContain("routing-write:true");
    expect(events).not.toContain("bind");
    expect(events.some(event => event.includes("recordless or different-home"))).toBe(true);
    expect(events.at(-1)).toBe("release-authority");
  });

  test("post-bind initialization failure stays live with failed readiness", async () => {
    const events: string[] = [];
    const gate = createReadinessGate();
    const io = baseStartIo(events, {
      createReadinessGate: () => gate,
      initializeStartup: async () => {
        events.push("initialize-after-routing");
        throw new Error("startup convergence failed");
      },
      drainAndShutdown: async () => events.push("unexpected-drain"),
      exit: code => events.push(`unexpected-exit:${code}`),
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(0);
    expect(gate.getStatus()).toBe("failed");
    expect(events).toContain("initialize-after-routing");
    expect(events).not.toContain("unexpected-drain");
    expect(events).not.toContain("remove-pid");
    expect(events).not.toContain("remove-runtime");
    expect(events.some(event => event.includes(
      "startup initialization failed: startup convergence failed",
    ))).toBe(true);
    expect(events.some(event => event.startsWith("unexpected-exit:"))).toBe(false);
    expect(events.at(-1)).toBe("release-authority");
  });

  test("refused native restore leaves the foreground endpoint and records available", async () => {
    const events: string[] = [];
    const signals = new Map<NodeJS.Signals, () => void>();
    const io = baseStartIo(events, {
      onSignal: (signal, listener) => signals.set(signal, listener),
      restoreNative: () => ({
        success: false,
        changed: false,
        desiredChanged: false,
        configChanged: false,
        message: "ownership proof changed",
      }),
      exit: code => {
        events.push(`exit:${code}`);
      },
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(0);
    signals.get("SIGTERM")?.();

    await Promise.resolve();
    await Promise.resolve();
    expect(events).not.toContain("drain");
    expect(events).not.toContain("revert-env");
    expect(events).not.toContain("remove-pid");
    expect(events).not.toContain("remove-runtime");
    expect(events.some(event => event.includes(
      "Native Codex restore failed during shutdown: ownership proof changed",
    ))).toBe(true);
    expect(events.some(event => event.startsWith("exit:"))).toBe(false);
  });

  test("a repeated signal cannot bypass a pending refused native restore", async () => {
    const events: string[] = [];
    const signals = new Map<NodeJS.Signals, () => void>();
    let signalHandlersReady!: () => void;
    const handlersReady = new Promise<void>(resolve => { signalHandlersReady = resolve; });
    let finishInitialization!: () => void;
    const initialization = new Promise<void>(resolve => { finishInitialization = resolve; });
    const io = baseStartIo(events, {
      onSignal: (signal, listener) => {
        signals.set(signal, listener);
        if (signal === "SIGHUP") signalHandlersReady();
      },
      initializeStartup: async () => initialization,
      restoreNative: () => ({
        success: false,
        changed: false,
        desiredChanged: false,
        configChanged: false,
        message: "native proof unavailable",
      }),
      exit: code => events.push(`exit:${code}`),
    });

    const start = runForegroundProxyStart([], { block: false, io });
    await handlersReady;
    signals.get("SIGTERM")?.();
    signals.get("SIGINT")?.();
    expect(events).not.toContain("drain");
    expect(events).not.toContain("remove-pid");
    expect(events).not.toContain("remove-runtime");
    expect(events.some(event => event.startsWith("exit:"))).toBe(false);

    finishInitialization();
    expect(await start).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).not.toContain("drain");
    expect(events).not.toContain("remove-pid");
    expect(events).not.toContain("remove-runtime");
    expect(events.some(event => event.startsWith("exit:"))).toBe(false);
  });

  test("signal shutdown persists desired OFF for an external provider before draining", async () => {
    const events: string[] = [];
    const signals = new Map<NodeJS.Signals, () => void>();
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    let acquisition = 0;
    const io = baseStartIo(events, {
      acquireAuthority: async options => {
        acquisition += 1;
        events.push(`authority:${acquisition}:${options?.includeStart === true}`);
        return makeAuthority(events);
      },
      externalProvider: () => "custom",
      onSignal: (signal, listener) => signals.set(signal, listener),
      restoreNative: () => {
        events.push("persist-desired-off-and-native");
        return {
          success: true,
          changed: true,
          desiredChanged: true,
          configChanged: true,
          message: "native",
        };
      },
      exit: code => {
        events.push(`exit:${code}`);
        resolveExit(code);
      },
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(0);
    signals.get("SIGINT")?.();

    expect(await exited).toBe(0);
    expect(events.indexOf("authority:2:true")).toBeLessThan(events.indexOf("drain"));
    expect(events.indexOf("persist-desired-off-and-native")).toBeLessThan(
      events.indexOf("drain"),
    );
    expect(events.indexOf("release-authority", events.indexOf("persist-desired-off-and-native")))
      .toBeGreaterThan(events.indexOf("persist-desired-off-and-native"));
  });

  test("a parent-delegated unsupervised child restores native routing on signal", async () => {
    const events: string[] = [];
    const signals = new Map<NodeJS.Signals, () => void>();
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const io = baseStartIo(events, {
      env: { [PROXY_DELEGATED_START_ENV]: "1" },
      acquireServiceStartLock: async () => ({
        token: "delegated-start",
        release: () => events.push("release-delegated-start"),
      }),
      acquireAuthority: async options => {
        events.push(`shutdown-authority:${options?.includeStart === true}`);
        return makeAuthority(events);
      },
      onSignal: (signal, listener) => signals.set(signal, listener),
      restoreNative: () => {
        events.push("persist-desired-off-and-native");
        return {
          success: true,
          changed: true,
          desiredChanged: true,
          configChanged: true,
          message: "native",
        };
      },
      exit: code => {
        events.push(`exit:${code}`);
        resolveExit(code);
      },
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(0);
    expect(events).not.toContain("routing-write:true");
    signals.get("SIGTERM")?.();
    expect(await exited).toBe(0);
    expect(events.indexOf("shutdown-authority:true")).toBeLessThan(
      events.indexOf("persist-desired-off-and-native"),
    );
    expect(events.indexOf("persist-desired-off-and-native")).toBeLessThan(
      events.indexOf("drain"),
    );
  });

  test("a proven parent-delegated service child preserves routing for manager respawn", async () => {
    const events: string[] = [];
    const signals = new Map<NodeJS.Signals, () => void>();
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const io = baseStartIo(events, {
      env: { CCX_SERVICE: "1" },
      acquireAuthority: async () => {
        events.push("unexpected-full-authority");
        throw new Error("must not acquire full authority");
      },
      acquireServiceStartLock: async () => ({
        token: "service-start",
        release: () => events.push("release-service-start"),
      }),
      consumeServiceStartDelegation: () => ({
        token: "delegation",
        ensureToken: "parent-ensure",
        ownerPid: 4242,
        expiresAt: Date.now() + 1_000,
      }),
      onSignal: (signal, listener) => signals.set(signal, listener),
      restoreNative: () => {
        events.push("unexpected-native-restore");
        return {
          success: true,
          changed: true,
          desiredChanged: true,
          configChanged: true,
          message: "native",
        };
      },
      exit: code => {
        events.push(`exit:${code}`);
        resolveExit(code);
      },
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(0);
    signals.get("SIGTERM")?.();
    expect(await exited).toBe(0);
    expect(events).not.toContain("unexpected-native-restore");
    expect(events).not.toContain("unexpected-full-authority");
    expect(events).toContain("drain");
  });

  test("an autonomous service supervisor acquires full E+S authority and may run startup sync", async () => {
    const events: string[] = [];
    const io = baseStartIo(events, {
      env: { CCX_SERVICE: "1" },
      acquireAuthority: async options => {
        events.push(`service-authority:${options?.includeStart}:${options?.waitTimeoutMs}`);
        return makeAuthority(events);
      },
      acquireServiceStartLock: async () => {
        events.push("probe-s");
        return { token: "start", release: () => events.push("release-probe-s") };
      },
      consumeServiceStartDelegation: () => null,
      initializationIo: {
        syncCodexOnStart: async () => {
          events.push("autonomous-codex-sync");
          return { ran: true, catalogWritten: false, cacheSynced: false };
        },
      },
      initializeStartup: async (_context, initializationIo) => {
        events.push("initialize-service");
        await initializationIo.syncCodexOnStart?.(19191, config);
      },
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(0);
    expect(events).toContain("service-authority:true:undefined");
    expect(events.indexOf("probe-s")).toBeLessThan(events.indexOf("release-probe-s"));
    expect(events.indexOf("release-probe-s")).toBeLessThan(
      events.indexOf("service-authority:true:undefined"),
    );
    expect(events).toContain("autonomous-codex-sync");
  });

  test("a parent-delegated service child takes S only and suppresses every routing writer", async () => {
    const events: string[] = [];
    let suppressedSync: (() => Promise<unknown>) | undefined;
    let suppressedEnv: (() => Promise<unknown>) | undefined;
    let suppressedDesktop: (() => Promise<unknown>) | undefined;
    let suppressedGrokPolicy: (() => boolean) | undefined;
    const gate = createReadinessGate();
    const io = baseStartIo(events, {
      env: { CCX_SERVICE: "1" },
      createReadinessGate: () => gate,
      acquireAuthority: async options => {
        events.push(`unexpected-full:${options?.includeStart}:${options?.waitTimeoutMs}`);
        throw new Error("must not acquire full authority");
      },
      acquireServiceStartLock: async () => {
        events.push("acquire-s-only");
        return { token: "service-start", release: () => events.push("release-s-only") };
      },
      consumeServiceStartDelegation: () => {
        events.push("consume-delegation");
        return {
          token: "delegation",
          ensureToken: "parent-ensure",
          ownerPid: 4242,
          expiresAt: Date.now() + 1_000,
        };
      },
      reconcile: () => events.push("unexpected-reconcile"),
      initializationIo: {
        injectSystemEnv: async () => {
          events.push("unexpected-env-write");
          return { injected: true };
        },
        syncCodexOnStart: async () => {
          events.push("unexpected-codex-sync");
          return { ran: true, catalogWritten: false, cacheSynced: false };
        },
        buildDesktopRegistry: async () => { events.push("unexpected-desktop-write"); },
        shouldSyncGrok: () => { events.push("unexpected-grok-policy"); return true; },
        syncGrok: async () => {
          events.push("unexpected-grok-write");
          return { ok: true, changed: true, message: "updated" };
        },
      },
      initializeStartup: async (_context, initializationIo) => {
        suppressedSync = initializationIo.syncCodexOnStart;
        suppressedEnv = initializationIo.injectSystemEnv;
        suppressedDesktop = initializationIo.buildDesktopRegistry;
        suppressedGrokPolicy = initializationIo.shouldSyncGrok;
        events.push("initialize-service");
      },
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(0);
    expect(events).not.toContain("unexpected-full:true:undefined");
    expect(events).toContain("acquire-s-only");
    expect(events).toContain("consume-delegation");
    expect(events).not.toContain("unexpected-reconcile");
    expect(events).not.toContain("unexpected-codex-sync");
    expect(suppressedSync).toBeDefined();
    expect(await suppressedSync!()).toEqual({
      ran: false,
      catalogWritten: false,
      cacheSynced: false,
    });
    expect(await suppressedEnv!()).toEqual({
      injected: false,
      reason: "parent-delegated service startup",
    });
    await suppressedDesktop!();
    expect(suppressedGrokPolicy!()).toBe(false);
    expect(events).not.toContain("unexpected-env-write");
    expect(events).not.toContain("unexpected-desktop-write");
    expect(events).not.toContain("unexpected-grok-policy");
    expect(events).not.toContain("unexpected-grok-write");
    expect(gate.getStatus()).toBe("ready");
  });

  test("an autonomous service child refuses when full E+S authority is contended", async () => {
    const events: string[] = [];
    const io = baseStartIo(events, {
      env: { CCX_SERVICE: "1" },
      acquireServiceStartLock: async () => ({
        token: "probe",
        release: () => events.push("release-probe-s"),
      }),
      consumeServiceStartDelegation: () => null,
      acquireAuthority: async options => {
        events.push(`full-authority:${options?.includeStart}`);
        throw new Error("lifecycle contention");
      },
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(1);
    expect(events).toContain("release-probe-s");
    expect(events).toContain("full-authority:true");
    expect(events).not.toContain("bind");
  });

  test("an unsafe delegation record fails closed without inferring parent delegation", async () => {
    const events: string[] = [];
    const io = baseStartIo(events, {
      env: { CCX_SERVICE: "1" },
      acquireServiceStartLock: async () => ({
        token: "probe",
        release: () => events.push("release-probe-s"),
      }),
      consumeServiceStartDelegation: () => { throw new Error("unsafe ensure record"); },
      acquireAuthority: async () => {
        events.push("unexpected-full-authority");
        return makeAuthority(events);
      },
    });

    expect(await runForegroundProxyStart([], { block: false, io })).toBe(1);
    expect(events).toContain("release-probe-s");
    expect(events).not.toContain("unexpected-full-authority");
    expect(events).not.toContain("bind");
  });

  test("a Start queued during signal shutdown cannot re-enable routing after OFF", async () => {
    const events: string[] = [];
    const firstSignals = new Map<NodeJS.Signals, () => void>();
    let releaseFirstInitialization!: () => void;
    const firstInitialization = new Promise<void>(resolve => { releaseFirstInitialization = resolve; });
    let signalHandlersReady!: () => void;
    const signalHandlers = new Promise<void>(resolve => { signalHandlersReady = resolve; });
    let authorityCalls = 0;
    let firstReleased = false;
    let releaseQueuedStart!: () => void;
    const queuedStart = new Promise<void>(resolve => { releaseQueuedStart = resolve; });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });

    const acquireAuthority: NonNullable<ForegroundProxyStartIo["acquireAuthority"]> = async options => {
      authorityCalls += 1;
      const call = authorityCalls;
      events.push(`authority:${call}:${options?.includeStart === true}`);
      if (call === 2) await queuedStart;
      const authority = makeAuthority(events);
      if (call === 1) {
        const release = authority.releaseAll;
        authority.releaseAll = () => {
          release();
          firstReleased = true;
          releaseQueuedStart();
        };
      }
      return authority;
    };
    const first = baseStartIo(events, {
      acquireAuthority,
      onSignal: (signal, listener) => {
        firstSignals.set(signal, listener);
        if (signal === "SIGHUP") signalHandlersReady();
      },
      initializeStartup: async () => firstInitialization,
      restoreNative: () => {
        events.push("routing-write:false");
        return {
          success: true,
          changed: true,
          desiredChanged: true,
          configChanged: true,
          message: "native",
        };
      },
      exit: code => {
        events.push(`exit:${code}`);
        resolveExit(code);
      },
    });
    const second = baseStartIo(events, {
      acquireAuthority,
      initializeStartup: async () => {},
    });

    const firstRun = runForegroundProxyStart([], { block: false, io: first });
    await signalHandlers;
    firstSignals.get("SIGTERM")?.();
    const secondRun = runForegroundProxyStart([], { block: false, io: second });
    releaseFirstInitialization();

    expect(await secondRun).toBe(0);
    expect(await firstRun).toBe(0);
    expect(await exited).toBe(0);
    expect(firstReleased).toBe(true);
    expect(events.indexOf("routing-write:false")).toBeLessThan(
      events.lastIndexOf("routing-write:true"),
    );
  });
});

describe("foreground startup integrations", () => {
  test("still synchronizes Grok when Desktop registry construction fails", async () => {
    const events: string[] = [];
    const gate = createReadinessGate();

    await runForegroundStartupInitialization({ port: 19191, config, readinessGate: gate }, {
      sleep: async () => { events.push("sleep"); },
      injectSystemEnv: async () => { events.push("inject-env"); },
      syncCodexOnStart: async () => {
        events.push("sync-codex");
        gate.markReady();
        return { ran: true, catalogWritten: false, cacheSynced: false };
      },
      buildDesktopRegistry: async () => {
        events.push("desktop-registry");
        throw new Error("registry unavailable");
      },
      shouldSyncGrok: () => {
        events.push("grok-policy");
        return true;
      },
      syncGrok: async () => {
        events.push("sync-grok");
        return { ok: true, changed: true, message: "updated" };
      },
      ensureCompanion: async () => {
        events.push("companion");
        return true;
      },
      logger: {
        log: message => events.push(`log:${message}`),
        error: message => events.push(`error:${message}`),
      },
    });

    expect(events.indexOf("desktop-registry")).toBeGreaterThan(
      events.indexOf("sync-codex"),
    );
    expect(events.indexOf("sync-grok")).toBeGreaterThan(
      events.indexOf("desktop-registry"),
    );
    expect(events).toContain("companion");
    expect(gate.getStatus()).toBe("ready");
  });
});

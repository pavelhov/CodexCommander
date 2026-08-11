import { describe, expect, test } from "bun:test";
import {
  applyCodexCatalog,
  applyCodexCatalogWorkers,
  runCodexCatalogApply,
  type ApplyCodexCatalogDeps,
  type ApplyCodexCatalogWorkersDeps,
  type CodexCatalogApplyCoreDeps,
} from "../src/codex/catalog-apply";
import type {
  CodexAppServerCatalogStatus,
  CodexAppServerProcess,
  RestartCodexAppServersResult,
} from "../src/codex/app-server-processes";
import { collectCodexAppServerCatalogState } from "../src/codex/app-server-processes";
import type { CodexSyncResult } from "../src/codex/sync";

const syncResult = (overrides: Partial<CodexSyncResult> = {}): CodexSyncResult => ({
  status: "applied",
  ok: true,
  added: 2,
  catalogPath: "/private/catalog-must-not-cross-helper.json",
  catalogExists: true,
  catalogWritten: true,
  cacheSynced: true,
  catalogQuality: "live",
  rehydrated: 0,
  message: "internal sync detail",
  ...overrides,
});

const noRestart = (): RestartCodexAppServersResult => ({
  requested: [],
  signaled: [],
  stopped: [],
  surviving: [],
  failed: [],
});

function makeDeps(options: {
  live?: boolean;
  captureDesiredSnapshot?: ApplyCodexCatalogDeps["captureDesiredSnapshot"];
  sync?: () => Promise<CodexSyncResult>;
  states: CodexAppServerCatalogStatus[];
  workers?: CodexAppServerProcess[];
  restart?: (workers: readonly CodexAppServerProcess[]) => RestartCodexAppServersResult;
  calls?: string[];
}): ApplyCodexCatalogDeps {
  let stateIndex = 0;
  const calls = options.calls ?? [];
  return {
    findLiveProxy: async () => options.live === false
      ? null
      : ({ pid: 900, port: 10100, source: "runtime" }),
    captureDesiredSnapshot: options.captureDesiredSnapshot ?? (() => ({
      config: {} as never,
      authority: {} as never,
      revision: "test-desired-revision",
    })),
    syncModelsToCodex: async () => (options.sync ? options.sync() : syncResult()),
    inspectArtifactProof: () => "current",
    getRoutingKind: () => "codexcommander-local",
    resetCatalogStateCache: () => { calls.push("reset"); },
    collectCatalogState: () => {
      calls.push("collect");
      const state = options.states[Math.min(stateIndex, options.states.length - 1)];
      stateIndex += 1;
      if (!state) throw new Error("missing test state");
      return state;
    },
    listCodexWorkers: () => {
      calls.push("list");
      return options.workers ?? [];
    },
    restartCodexWorkers: workers => {
      calls.push("restart");
      return options.restart?.(workers) ?? noRestart();
    },
  };
}

describe("fixed applyCodexCatalog lifecycle action", () => {
  test("refuses without mutation when the live proxy identity disappeared", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      live: false,
      calls,
      sync: async () => { throw new Error("sync must not run"); },
      states: [{ state: "not_running", catalogMtimeMs: null, processes: [] }],
    }));

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      state: "stopped",
      changed: false,
      errorCode: "SYNC_FAILED",
      catalogUpdated: false,
      codexRestartRequired: false,
      staleWorkerCount: 0,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
    });
  });

  test("restarts only workers proven stale and returns counts without process details", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      calls,
      states: [
        {
          state: "stale",
          catalogMtimeMs: 200,
          processes: [
            { pid: 10, startedAtMs: 100 },
            { pid: 20, startedAtMs: 300 },
          ],
        },
        {
          state: "fresh",
          catalogMtimeMs: 200,
          processes: [{ pid: 20, startedAtMs: 300 }],
        },
      ],
      workers: [
        { pid: 10, commandLine: "/Applications/Codex.app/codex app-server --secret-detail" },
        { pid: 20, commandLine: "/Applications/Codex.app/codex app-server --fresh" },
      ],
      restart: workers => {
        expect(workers).toEqual([{
          pid: 10,
          commandLine: "/Applications/Codex.app/codex app-server --secret-detail",
          startedAtMs: 100,
        }]);
        return { requested: [10], signaled: [10], stopped: [10], surviving: [], failed: [] };
      },
    }));

    expect(calls).toEqual(["reset", "collect", "list", "restart", "reset", "collect"]);
    expect(result).toMatchObject({
      ok: true,
      state: "running",
      catalogUpdated: true,
      codexRestartRequired: false,
      staleWorkerCount: 1,
      stoppedWorkerCount: 1,
      survivingWorkerCount: 0,
      pid: null,
      port: null,
    });
    const frame = JSON.stringify(result);
    expect(frame).not.toContain("/Applications");
    expect(frame).not.toContain("commandLine");
    expect(frame).not.toContain("catalog-must-not-cross-helper");
    expect(frame).not.toContain("stoppedPids");
    expect(frame).not.toContain("survivingPids");
  });

  test("unknown worker state fails closed without listing or signalling", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      calls,
      states: [{ state: "unknown", catalogMtimeMs: null, processes: [] }],
    }));

    expect(calls).toEqual(["reset", "collect"]);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "CODEX_RESTART_REQUIRED",
      codexRestartRequired: true,
      staleWorkerCount: 0,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
    });
  });

  test("a sync failure with no confirmed catalog/cache write never signals workers", async () => {
    const calls: string[] = [];
    const stale: CodexAppServerCatalogStatus = {
      state: "stale",
      catalogMtimeMs: 200,
      processes: [{ pid: 10, startedAtMs: 100 }],
    };
    const result = await applyCodexCatalog(makeDeps({
      calls,
      sync: async () => syncResult({
        status: "refused",
        ok: false,
        catalogWritten: false,
        cacheSynced: false,
      }),
      states: [stale],
      workers: [{ pid: 10, commandLine: "codex app-server" }],
      restart: () => { throw new Error("must not signal"); },
    }));

    expect(calls).toEqual(["reset", "collect"]);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SYNC_FAILED",
      catalogUpdated: false,
      codexRestartRequired: true,
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
  });

  test("an intentional integration skip is blocked by the canonical Apply policy", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      calls,
      sync: async () => syncResult({
        status: "skipped",
        skippedReason: "desired_disabled",
        ok: true,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "native-only",
      }),
      states: [{
        state: "stale",
        catalogMtimeMs: 200,
        processes: [{ pid: 10, startedAtMs: 100 }],
      }],
      workers: [{ pid: 10, commandLine: "codex app-server" }],
      restart: () => { throw new Error("must not signal"); },
    }));

    expect(calls).toEqual(["reset", "collect"]);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SYNC_FAILED",
      catalogUpdated: false,
      codexRestartRequired: false,
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
  });

  test("a sync failure never signals workers even when it reports a partial catalog write", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      calls,
      sync: async () => syncResult({ ok: false, catalogWritten: true, cacheSynced: false }),
      states: [{
        state: "stale",
        catalogMtimeMs: 200,
        processes: [{ pid: 10, startedAtMs: 100 }],
      }],
      workers: [{ pid: 10, commandLine: "codex app-server" }],
      restart: () => { throw new Error("must not signal"); },
    }));

    expect(calls).toEqual(["reset", "collect"]);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SYNC_FAILED",
      catalogUpdated: true,
      codexRestartRequired: true,
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
  });

  test("a degraded native-only sync with a warning never lists or signals workers", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      calls,
      sync: async () => syncResult({
        ok: true,
        catalogWritten: true,
        cacheSynced: true,
        catalogQuality: "native-only",
        warning: "provider discovery returned nothing",
      }),
      states: [{
        state: "stale",
        catalogMtimeMs: 200,
        processes: [{ pid: 10, startedAtMs: 100 }],
      }],
      workers: [{ pid: 10, commandLine: "codex app-server" }],
      restart: () => { throw new Error("must not signal"); },
    }));

    expect(calls).toEqual(["reset", "collect"]);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SYNC_FAILED",
      catalogUpdated: true,
      codexRestartRequired: true,
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
  });

  test("a healthy native-only sync restarts a proven-stale Codex worker", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      calls,
      sync: async () => syncResult({
        ok: true,
        catalogWritten: true,
        cacheSynced: true,
        catalogQuality: "native-only",
        warning: undefined,
      }),
      states: [
        {
          state: "stale",
          catalogMtimeMs: 200,
          processes: [{ pid: 10, startedAtMs: 100 }],
        },
        {
          state: "fresh",
          catalogMtimeMs: 200,
          processes: [{ pid: 20, startedAtMs: 300 }],
        },
      ],
      workers: [{ pid: 10, commandLine: "/Applications/Codex.app/codex app-server" }],
      restart: workers => {
        expect(workers.map(worker => worker.pid)).toEqual([10]);
        return { requested: [10], signaled: [10], stopped: [10], surviving: [], failed: [] };
      },
    }));

    expect(calls).toEqual(["reset", "collect", "list", "restart", "reset", "collect"]);
    expect(result).toMatchObject({
      ok: true,
      catalogUpdated: true,
      codexRestartRequired: false,
      staleWorkerCount: 1,
      stoppedWorkerCount: 1,
      survivingWorkerCount: 0,
    });
  });

  test("a native-only sync without an existing catalog never signals workers", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      calls,
      sync: async () => syncResult({
        ok: true,
        catalogExists: false,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "native-only",
        warning: undefined,
      }),
      states: [{
        state: "stale",
        catalogMtimeMs: 200,
        processes: [{ pid: 10, startedAtMs: 100 }],
      }],
      workers: [{ pid: 10, commandLine: "/Applications/Codex.app/codex app-server" }],
      restart: () => { throw new Error("must not signal"); },
    }));

    expect(calls).toEqual(["reset", "collect"]);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "SYNC_FAILED",
      catalogUpdated: false,
      codexRestartRequired: true,
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
  });

  test("a committed native-only semantic no-op can apply an existing catalog", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      calls,
      sync: async () => syncResult({
        ok: true,
        catalogExists: true,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "native-only",
        warning: undefined,
      }),
      states: [
        {
          state: "stale",
          catalogMtimeMs: 200,
          processes: [{ pid: 10, startedAtMs: 100 }],
        },
        { state: "not_running", catalogMtimeMs: null, processes: [] },
      ],
      workers: [{ pid: 10, commandLine: "codex app-server" }],
      restart: () => ({
        requested: [10],
        signaled: [10],
        stopped: [10],
        surviving: [],
        failed: [],
      }),
    }));

    expect(calls).toEqual(["reset", "collect", "list", "restart", "reset", "collect"]);
    expect(result).toMatchObject({
      ok: true,
      catalogUpdated: false,
      codexRestartRequired: false,
      staleWorkerCount: 1,
      stoppedWorkerCount: 1,
      survivingWorkerCount: 0,
    });
  });

  test("surviving stale workers keep the final restart-required state true", async () => {
    const stale: CodexAppServerCatalogStatus = {
      state: "stale",
      catalogMtimeMs: 200,
      processes: [{ pid: 10, startedAtMs: 100 }],
    };
    const result = await applyCodexCatalog(makeDeps({
      states: [stale, stale],
      workers: [{ pid: 10, commandLine: "codex app-server" }],
      restart: () => ({
        requested: [10],
        signaled: [],
        stopped: [],
        surviving: [10],
        failed: [{ pid: 10, error: "permission denied must not cross helper" }],
      }),
    }));

    expect(result).toMatchObject({
      ok: false,
      errorCode: "CODEX_RESTART_REQUIRED",
      codexRestartRequired: true,
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("permission denied");
  });

  test("fresh workers need no signal and leave restart-required false", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      calls,
      states: [{
        state: "fresh",
        catalogMtimeMs: 100,
        processes: [{ pid: 10, startedAtMs: 200 }],
      }],
      workers: [{ pid: 10, commandLine: "codex app-server" }],
    }));

    expect(calls).toEqual(["reset", "collect"]);
    expect(result).toMatchObject({
      ok: true,
      codexRestartRequired: false,
      staleWorkerCount: 0,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
    });
  });

  test("companion apply refuses to signal when desired generation changes during sync", async () => {
    const calls: string[] = [];
    let captures = 0;
    const result = await applyCodexCatalog(makeDeps({
      calls,
      captureDesiredSnapshot: () => ({
        config: {} as never,
        authority: {} as never,
        revision: ++captures === 1 ? "desired-A-generation-1" : "desired-B-generation-2",
      }),
      states: [{
        state: "stale",
        catalogMtimeMs: 200,
        processes: [{ pid: 10, startedAtMs: 100 }],
      }],
      workers: [{ pid: 10, commandLine: "codex app-server" }],
      restart: () => { throw new Error("must not signal superseded desired state"); },
    }));

    expect(captures).toBe(2);
    expect(calls).toEqual(["reset", "collect"]);
    expect(result).toMatchObject({
      ok: false,
      codexRestartRequired: true,
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
  });
});

describe("verified worker-only catalog activation", () => {
  function workerDeps(options: {
    states: CodexAppServerCatalogStatus[];
    workers?: CodexAppServerProcess[];
    restart?: ApplyCodexCatalogWorkersDeps["restartCodexWorkers"];
    calls?: string[];
  }): ApplyCodexCatalogWorkersDeps {
    let index = 0;
    const calls = options.calls ?? [];
    return {
      resetCatalogStateCache: () => { calls.push("reset"); },
      collectCatalogState: () => {
        calls.push("collect");
        return options.states[Math.min(index++, options.states.length - 1)]!;
      },
      listCodexWorkers: () => {
        calls.push("list");
        return options.workers ?? [];
      },
      restartCodexWorkers: (workers, io) => {
        calls.push("restart");
        return options.restart?.(workers, io) ?? noRestart();
      },
    };
  }

  test("unknown observation blocks before process listing or signaling", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalogWorkers(() => true, workerDeps({
      calls,
      states: [{ state: "unknown", catalogMtimeMs: null, processes: [] }],
    }));
    expect(result).toEqual({
      outcome: "blocked",
      staleWorkerCount: 0,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
    });
    expect(calls).toEqual(["reset", "collect"]);
  });

  test("a replacement starting after the fence in the same Darwin second is never signaled", async () => {
    const calls: string[] = [];
    const ambiguousReplacement = collectCodexAppServerCatalogState({
      platform: "darwin",
      listSnapshots: () => [{
        pid: 10,
        commandLine: "codex app-server",
        startedAtMs: 1_000,
      }],
      startTimePrecisionMs: 1_000,
      catalogMtimeMs: () => 1_500,
    });
    const result = await applyCodexCatalogWorkers(
      () => true,
      workerDeps({
        calls,
        states: [ambiguousReplacement],
        restart: () => { throw new Error("same-second replacement must never be signaled"); },
      }),
      ambiguousReplacement,
    );

    expect(result).toEqual({
      outcome: "blocked",
      staleWorkerCount: 0,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
    });
    expect(calls).toEqual([]);
  });

  test("a superseded desired revision is checked immediately before signaling", async () => {
    const calls: string[] = [];
    const stale: CodexAppServerCatalogStatus = {
      state: "stale",
      catalogMtimeMs: 200,
      processes: [{ pid: 10, startedAtMs: 100 }],
    };
    const result = await applyCodexCatalogWorkers(() => false, workerDeps({
      calls,
      states: [stale],
      workers: [{ pid: 10, commandLine: "codex app-server" }],
    }));
    expect(result).toEqual({
      outcome: "superseded",
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
    expect(calls).toEqual(["reset", "collect", "list"]);
  });

  test("signals only the birth-time-fenced stale target and verifies replacement state", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalogWorkers(() => true, workerDeps({
      calls,
      states: [
        {
          state: "stale",
          catalogMtimeMs: 200,
          processes: [{ pid: 10, startedAtMs: 100 }, { pid: 20, startedAtMs: 300 }],
        },
        {
          state: "fresh",
          catalogMtimeMs: 200,
          processes: [{ pid: 20, startedAtMs: 300 }],
        },
      ],
      workers: [
        { pid: 10, commandLine: "codex app-server" },
        { pid: 20, commandLine: "codex app-server" },
      ],
      restart: workers => {
        expect(workers).toEqual([{ pid: 10, commandLine: "codex app-server", startedAtMs: 100 }]);
        return { requested: [10], signaled: [10], stopped: [10], surviving: [], failed: [] };
      },
    }));
    expect(result).toEqual({
      outcome: "applied",
      staleWorkerCount: 1,
      stoppedWorkerCount: 1,
      survivingWorkerCount: 0,
    });
    expect(calls).toEqual(["reset", "collect", "list", "restart", "reset", "collect"]);
  });

  test("a revision change at the final signal fence is reported as superseded", async () => {
    const calls: string[] = [];
    let revisionChecks = 0;
    const stale: CodexAppServerCatalogStatus = {
      state: "stale",
      catalogMtimeMs: 200,
      processes: [{ pid: 10, startedAtMs: 100 }],
    };
    const result = await applyCodexCatalogWorkers(
      () => ++revisionChecks === 1,
      workerDeps({
        calls,
        states: [stale],
        workers: [{ pid: 10, commandLine: "codex app-server" }],
        restart: (_workers, io) => {
          expect(io.authorizeSignal?.()).toBe(false);
          return {
            requested: [10],
            signaled: [],
            stopped: [],
            surviving: [10],
            failed: [],
            authorizationRefused: true,
          };
        },
      }),
    );

    expect(result).toEqual({
      outcome: "superseded",
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
    expect(calls).toEqual(["reset", "collect", "list", "restart", "reset", "collect"]);
  });

  test("one signal followed by authorization refusal is partial, not superseded", async () => {
    const calls: string[] = [];
    let revisionChecks = 0;
    const result = await applyCodexCatalogWorkers(
      () => ++revisionChecks < 3,
      workerDeps({
        calls,
        states: [
          {
            state: "stale",
            catalogMtimeMs: 300,
            processes: [
              { pid: 10, startedAtMs: 100 },
              { pid: 20, startedAtMs: 200 },
            ],
          },
          {
            state: "stale",
            catalogMtimeMs: 300,
            processes: [{ pid: 20, startedAtMs: 200 }],
          },
        ],
        workers: [
          { pid: 10, commandLine: "codex app-server --worker one" },
          { pid: 20, commandLine: "codex app-server --worker two" },
        ],
        restart: (_workers, io) => {
          expect(io.authorizeSignal?.()).toBe(true);
          expect(io.authorizeSignal?.()).toBe(false);
          return {
            requested: [10, 20],
            signaled: [10],
            stopped: [10],
            surviving: [20],
            failed: [],
            authorizationRefused: true,
          };
        },
      }),
    );

    expect(result).toEqual({
      outcome: "partial",
      staleWorkerCount: 2,
      stoppedWorkerCount: 1,
      survivingWorkerCount: 1,
    });
    expect(calls).toEqual(["reset", "collect", "list", "restart", "reset", "collect"]);
  });
});

describe("shared catalog Apply orchestration", () => {
  const desired = {
    config: {} as never,
    authority: { generation: { value: 7 } } as never,
    revision: "desired-generation-7",
  };
  const stale: CodexAppServerCatalogStatus = {
    state: "stale",
    catalogMtimeMs: 200,
    processes: [{ pid: 10, startedAtMs: 100 }],
  };

  function coreDeps(
    overrides: Partial<CodexCatalogApplyCoreDeps> = {},
  ): CodexCatalogApplyCoreDeps {
    return {
      captureDesiredSnapshot: () => desired,
      syncCatalog: async () => syncResult(),
      inspectArtifactProof: () => "current",
      getRoutingKind: () => "codexcommander-local",
      resetWorkerObservation: () => {},
      collectWorkerState: () => stale,
      applyWorkers: async () => ({
        outcome: "applied",
        staleWorkerCount: 1,
        stoppedWorkerCount: 1,
        survivingWorkerCount: 0,
      }),
      ...overrides,
    };
  }

  for (const drift of ["native", "custom-remote"] as const) {
    test(`route drift to ${drift} between convergence and SIGTERM sends zero signals`, async () => {
      let routingReads = 0;
      let signals = 0;
      const result = await runCodexCatalogApply({}, coreDeps({
        getRoutingKind: () => ++routingReads < 3 ? "codexcommander-local" : drift,
        applyWorkers: async authorizeSignal => {
          if (authorizeSignal()) signals += 1;
          return {
            outcome: signals > 0 ? "applied" : "superseded",
            staleWorkerCount: 1,
            stoppedWorkerCount: signals,
            survivingWorkerCount: signals > 0 ? 0 : 1,
          };
        },
      }));

      expect(signals).toBe(0);
      expect(result).toMatchObject({
        outcome: "superseded",
        blockReason: "authorization-changed",
        staleWorkerCount: 1,
        stoppedWorkerCount: 0,
        survivingWorkerCount: 1,
      });
    });
  }

  test("warning-bearing convergence blocks before the worker operation", async () => {
    let applied = 0;
    const result = await runCodexCatalogApply({}, coreDeps({
      syncCatalog: async () => syncResult({ warning: "degraded provider discovery" }),
      applyWorkers: async () => {
        applied += 1;
        throw new Error("must not run");
      },
    }));

    expect(applied).toBe(0);
    expect(result).toMatchObject({
      outcome: "blocked",
      blockReason: "sync-warning",
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 1,
    });
  });

  test("records the boot fence after proof and before worker signaling", async () => {
    const calls: string[] = [];
    await runCodexCatalogApply({}, coreDeps({
      inspectArtifactProof: () => { calls.push("proof"); return "current"; },
      recordBootFenceApplied: () => { calls.push("fence"); },
      applyWorkers: async () => {
        calls.push("signal");
        return { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 };
      },
    }));
    expect(calls.indexOf("fence")).toBeGreaterThan(calls.indexOf("proof"));
    expect(calls.indexOf("fence")).toBeLessThan(calls.indexOf("signal"));
  });

  test("does not record the boot fence on blocked or early-superseded paths", async () => {
    for (const overrides of [
      { syncCatalog: async () => syncResult({ warning: "blocked" }) },
      { captureDesiredSnapshot: () => ({ ...desired, revision: "newer" }) },
      { inspectArtifactProof: () => "drifted" as const },
      { collectWorkerState: () => ({ state: "unknown", catalogMtimeMs: null, processes: [] }) as CodexAppServerCatalogStatus },
    ]) {
      let records = 0;
      await runCodexCatalogApply({ expectedDesiredRevision: desired.revision }, coreDeps({
        ...overrides,
        recordBootFenceApplied: () => { records += 1; },
      }));
      expect(records).toBe(0);
    }
  });

  test("no-worker, current, unknown, and partial outcomes are canonical", async () => {
    const cases = [
      {
        state: { state: "not_running", catalogMtimeMs: null, processes: [] } as CodexAppServerCatalogStatus,
        workerResult: undefined,
        outcome: "no_workers",
      },
      {
        state: { state: "fresh", catalogMtimeMs: 200, processes: [{ pid: 20, startedAtMs: 300 }] } as CodexAppServerCatalogStatus,
        workerResult: undefined,
        outcome: "already_current",
      },
      {
        state: { state: "unknown", catalogMtimeMs: null, processes: [] } as CodexAppServerCatalogStatus,
        workerResult: undefined,
        outcome: "blocked",
      },
      {
        state: stale,
        workerResult: {
          outcome: "partial" as const,
          staleWorkerCount: 1,
          stoppedWorkerCount: 0,
          survivingWorkerCount: 1,
        },
        outcome: "partial",
      },
    ];
    for (const item of cases) {
      let workerCalls = 0;
      const result = await runCodexCatalogApply({}, coreDeps({
        collectWorkerState: () => item.state,
        applyWorkers: async () => {
          workerCalls += 1;
          if (!item.workerResult) throw new Error("unexpected worker operation");
          return item.workerResult;
        },
      }));
      expect(result.outcome).toBe(item.outcome);
      expect(workerCalls).toBe(item.state.state === "stale" ? 1 : 0);
    }
  });
});

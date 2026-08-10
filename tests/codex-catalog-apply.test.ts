import { describe, expect, test } from "bun:test";
import {
  applyCodexCatalog,
  type ApplyCodexCatalogDeps,
} from "../src/codex/catalog-apply";
import type {
  CodexAppServerCatalogStatus,
  CodexAppServerProcess,
  RestartCodexAppServersResult,
} from "../src/codex/app-server-processes";
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
  stopped: [],
  surviving: [],
  failed: [],
});

function makeDeps(options: {
  live?: boolean;
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
    syncModelsToCodex: async () => (options.sync ? options.sync() : syncResult()),
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
        return { requested: [10], stopped: [10], surviving: [], failed: [] };
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

  test("an intentional integration skip never restarts workers and clears update readiness", async () => {
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
      ok: true,
      catalogUpdated: false,
      codexRestartRequired: false,
      staleWorkerCount: 1,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
    });
    expect(result.errorCode).toBeUndefined();
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
        return { requested: [10], stopped: [10], surviving: [], failed: [] };
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

  test("a native-only sync without a proven catalog write never signals workers", async () => {
    const calls: string[] = [];
    const result = await applyCodexCatalog(makeDeps({
      calls,
      sync: async () => syncResult({
        ok: true,
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
});

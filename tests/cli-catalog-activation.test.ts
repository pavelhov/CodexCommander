import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyCodexCatalogForCompanion,
  applySynchronizedCatalogWorkers,
  bindCacheArtifactForApply,
  bindCatalogArtifactsForApply,
  cacheApplyFenceArtifactStillMatches,
  catalogApplyFenceArtifactsStillMatch,
  catalogSyncCanApply,
  reportCatalogWorkerApply,
  syncCodexCatalogForCli,
  type CliCodexSyncResult,
} from "../src/cli/catalog-activation";
import { APPLY_CODEX_CATALOG_ACTION } from "../src/codex/catalog-apply";
import type { CodexSyncResult } from "../src/codex/sync";
import { RuntimeApiError } from "../src/cli/runtime-api";
import {
  PROXY_ENSURE_LEASE_HEADER,
  PROXY_START_LEASE_HEADER,
} from "../src/server/proxy-lifecycle-protocol";
import type { ProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";

function authority(events: string[]): ProxyLifecycleAuthority {
  const ensure = { token: "ensure-token", release: () => {} };
  const start = { token: "start-token", release: () => {} };
  return {
    deadlineAt: 1,
    ensure,
    start,
    acquireStart: async () => start,
    delegatedLease: () => ({ ensureToken: ensure.token, startToken: start.token }),
    releaseStart: () => {},
    releaseAll: () => events.push("release"),
  };
}

function syncResult(overrides: Partial<CodexSyncResult> = {}): CodexSyncResult {
  return {
    status: "applied",
    ok: true,
    added: 1,
    catalogPath: "/redacted/catalog.json",
    catalogExists: true,
    catalogWritten: true,
    cacheSynced: true,
    catalogQuality: "live",
    rehydrated: 0,
    message: "catalog synchronized",
    ...overrides,
  };
}

function liveSyncResult(overrides: Partial<CliCodexSyncResult> = {}): CliCodexSyncResult {
  return {
    ...syncResult(),
    activation: { catalog: { status: "current" } },
    ...overrides,
  };
}

describe("CLI catalog activation orchestration", () => {
  test("a live sync publishes through /api/sync and never falls back to a local writer", async () => {
    let localCalls = 0;
    const events: string[] = [];
    const requests: Array<{ path: string; baseUrl: string | undefined; headers: Headers }> = [];
    const result = await syncCodexCatalogForCli(
      { pid: 41, port: 14100, hostname: "0.0.0.0", source: "runtime" },
      {
        syncModelsToCodex: async () => {
          localCalls += 1;
          return syncResult();
        },
        acquireAuthority: async options => {
          events.push(`acquire:${options.includeStart}`);
          return authority(events);
        },
        runtimeRequest: async (path, init, deps) => {
          requests.push({ path, baseUrl: deps.baseUrl, headers: new Headers(init.headers) });
          return liveSyncResult({ catalogWritten: false, cacheSynced: false });
        },
      },
    );

    expect(localCalls).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/api/sync");
    expect(requests[0]?.baseUrl).toBe("http://127.0.0.1:14100");
    expect(requests[0]?.headers.get(PROXY_ENSURE_LEASE_HEADER)).toBe("ensure-token");
    expect(requests[0]?.headers.get(PROXY_START_LEASE_HEADER)).toBe("start-token");
    expect(events).toEqual(["acquire:true", "release"]);
    expect(result.catalogWritten).toBe(false);
  });

  test("an unreachable live proxy fails closed instead of starting a competing local sync", async () => {
    let localCalls = 0;
    await expect(syncCodexCatalogForCli(
      { pid: 41, port: 14100, source: "runtime" },
      {
        syncModelsToCodex: async () => {
          localCalls += 1;
          return syncResult();
        },
        runtimeRequest: async () => {
          throw new RuntimeApiError("unreachable", 503, null);
        },
        acquireAuthority: async () => authority([]),
      },
    )).rejects.toThrow("unreachable");
    expect(localCalls).toBe(0);
  });

  test("offline sync uses the canonical local sync facade", async () => {
    let localCalls = 0;
    const events: string[] = [];
    const result = await syncCodexCatalogForCli(null, {
      syncModelsToCodex: async () => {
        localCalls += 1;
        return syncResult();
      },
      runtimeRequest: async () => {
        throw new Error("unexpected runtime request");
      },
      acquireAuthority: async options => {
        events.push(`acquire:${options.includeStart}`);
        return authority(events);
      },
    });
    expect(localCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(events).toEqual(["acquire:true", "release"]);
  });

  test("a public config-port identity is never treated as a management target", async () => {
    let localCalls = 0;
    let runtimeCalls = 0;
    const result = await syncCodexCatalogForCli(
      { pid: 41, port: 10100, source: "config" },
      {
        syncModelsToCodex: async () => {
          localCalls += 1;
          return syncResult({ status: "skipped", skippedReason: "desired_disabled" });
        },
        runtimeRequest: async () => {
          runtimeCalls += 1;
          throw new Error("public identity must not receive a management request");
        },
        acquireAuthority: async () => authority([]),
      },
    );

    expect(localCalls).toBe(1);
    expect(runtimeCalls).toBe(0);
    expect(result).toMatchObject({ status: "skipped", skippedReason: "desired_disabled" });
  });

  test("the companion wires its convergence callback to a freshly verified live proxy", async () => {
    const live = { pid: 71, port: 17100, source: "runtime" as const };
    let synchronizedWith: typeof live | null = null;
    let findCalls = 0;
    const result = await applyCodexCatalogForCompanion({
      findLiveProxy: async () => {
        findCalls += 1;
        return live;
      },
      syncCatalog: async observed => {
        synchronizedWith = observed as typeof live;
        // This wiring seam does not exercise disk artifacts; a warning keeps
        // the production wrapper from arming its post-sync signal fence.
        return liveSyncResult({ warning: "test seam" });
      },
      applyCatalog: async deps => {
        await deps.syncModelsToCodex(live.port, {} as never, null);
        return {
          schemaVersion: 1,
          action: APPLY_CODEX_CATALOG_ACTION,
          ok: true,
          state: "running",
          changed: true,
          pid: null,
          port: null,
          message: "applied",
          catalogUpdated: true,
          codexRestartRequired: false,
          staleWorkerCount: 1,
          stoppedWorkerCount: 1,
          survivingWorkerCount: 0,
        };
      },
    });

    expect(findCalls).toBe(1);
    expect(synchronizedWith).toEqual(live);
    expect(result.ok).toBe(true);
  });

  test("the companion never falls back to helper-local convergence if the proxy disappears", async () => {
    const live = { pid: 71, port: 17100, source: "runtime" as const };
    let findCalls = 0;
    let syncCalls = 0;
    await expect(applyCodexCatalogForCompanion({
      findLiveProxy: async () => (++findCalls === 1 ? live : null),
      syncCatalog: async () => {
        syncCalls += 1;
        return syncResult();
      },
      applyCatalog: async deps => {
        expect(await deps.findLiveProxy()).toEqual(live);
        await deps.syncModelsToCodex(live.port, {} as never, null);
        throw new Error("unexpected local continuation");
      },
    })).rejects.toThrow("stopped before catalog synchronization");
    expect(findCalls).toBe(2);
    expect(syncCalls).toBe(0);
  });

  test("the companion folds post-sync artifact drift into its per-signal desired fence", async () => {
    const live = { pid: 71, port: 17100, source: "runtime" as const };
    let drifted = false;
    const desired = {
      config: {} as never,
      authority: {} as never,
      revision: "desired-revision",
    };
    await applyCodexCatalogForCompanion({
      findLiveProxy: async () => live,
      syncCatalog: async () => liveSyncResult(),
      captureDesiredSnapshot: () => desired,
      captureArtifacts: () => ({}) as never,
      artifactsStillMatch: () => !drifted,
      applyCatalog: async deps => {
        expect(deps.captureDesiredSnapshot().revision).toBe("desired-revision");
        await deps.syncModelsToCodex(live.port, {} as never, null);
        expect(deps.captureDesiredSnapshot().revision).toBe("desired-revision");
        expect(deps.inspectArtifactProof(deps.captureDesiredSnapshot())).toBe("current");
        drifted = true;
        expect(deps.captureDesiredSnapshot().revision).toBe("desired-revision");
        expect(deps.inspectArtifactProof(deps.captureDesiredSnapshot())).toBe("drifted");
        return {
          schemaVersion: 1,
          action: APPLY_CODEX_CATALOG_ACTION,
          ok: false,
          state: "running",
          changed: false,
          pid: null,
          port: null,
          message: "superseded",
          errorCode: "CODEX_RESTART_REQUIRED",
          catalogUpdated: false,
          codexRestartRequired: true,
          staleWorkerCount: 1,
          stoppedWorkerCount: 0,
          survivingWorkerCount: 1,
        };
      },
    });
  });

  test("live Apply requires a current or degraded receipt-backed activation", () => {
    expect(catalogSyncCanApply(liveSyncResult(), true)).toBe(true);
    expect(catalogSyncCanApply(liveSyncResult({
      activation: { catalog: { status: "degraded" } },
    }), true)).toBe(true);
    expect(catalogSyncCanApply(liveSyncResult({
      activation: { catalog: { status: "pending" } },
    }), true)).toBe(false);
    expect(catalogSyncCanApply(syncResult(), true)).toBe(false);
    expect(catalogSyncCanApply(syncResult(), false)).toBe(true);
    expect(catalogSyncCanApply(liveSyncResult({ warning: "degraded evidence" }), true)).toBe(false);
  });

  for (const drift of ["native", "custom-remote"] as const) {
    test(`the CLI signal fence blocks route drift to ${drift}`, async () => {
      const desired = {
        config: {} as never,
        authority: { generation: { value: 1 } } as never,
        revision: "cli-desired-generation-1",
      };
      let routingReads = 0;
      let signals = 0;
      const result = await applySynchronizedCatalogWorkers(
        { desired, artifacts: {} as never },
        syncResult(),
        {
          captureDesiredSnapshot: () => desired,
          artifactFenceStillMatches: () => true,
          getRoutingKind: () => ++routingReads < 3 ? "codexcommander-local" : drift,
          resetWorkerObservation: () => {},
          collectWorkerState: () => ({
            state: "stale",
            catalogMtimeMs: 200,
            processes: [{ pid: 10, startedAtMs: 100 }],
          }),
          applyWorkers: async authorizeSignal => {
            if (authorizeSignal()) signals += 1;
            return {
              outcome: signals > 0 ? "applied" : "superseded",
              staleWorkerCount: 1,
              stoppedWorkerCount: signals,
              survivingWorkerCount: signals > 0 ? 0 : 1,
            };
          },
        },
      );

      expect(signals).toBe(0);
      expect(result).toEqual({
        outcome: "superseded",
        staleWorkerCount: 1,
        stoppedWorkerCount: 0,
        survivingWorkerCount: 1,
      });
    });
  }

  test("the CLI adapter preserves canonical no-worker, current, unknown, and partial outcomes", async () => {
    const desired = {
      config: {} as never,
      authority: { generation: { value: 1 } } as never,
      revision: "cli-outcome-generation-1",
    };
    const cases = [
      {
        state: { state: "not_running" as const, catalogMtimeMs: null, processes: [] },
        expected: { outcome: "no_workers", staleWorkerCount: 0, stoppedWorkerCount: 0, survivingWorkerCount: 0 },
      },
      {
        state: { state: "fresh" as const, catalogMtimeMs: 200, processes: [{ pid: 20, startedAtMs: 300 }] },
        expected: { outcome: "already_current", staleWorkerCount: 0, stoppedWorkerCount: 0, survivingWorkerCount: 0 },
      },
      {
        state: { state: "unknown" as const, catalogMtimeMs: null, processes: [] },
        expected: { outcome: "blocked", staleWorkerCount: 0, stoppedWorkerCount: 0, survivingWorkerCount: 0 },
      },
      {
        state: { state: "stale" as const, catalogMtimeMs: 200, processes: [{ pid: 10, startedAtMs: 100 }] },
        expected: { outcome: "partial", staleWorkerCount: 1, stoppedWorkerCount: 0, survivingWorkerCount: 1 },
      },
    ];
    for (const item of cases) {
      const result = await applySynchronizedCatalogWorkers(
        { desired, artifacts: {} as never },
        syncResult(),
        {
          captureDesiredSnapshot: () => desired,
          artifactFenceStillMatches: () => true,
          getRoutingKind: () => "codexcommander-local",
          resetWorkerObservation: () => {},
          collectWorkerState: () => item.state,
          applyWorkers: async () => item.expected,
        },
      );
      expect(result).toEqual(item.expected);
    }
  });

  test("the post-sync fence accepts Codex-native cache churn but rejects catalog byte drift", () => {
    const previous = process.env.CODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ccx-cli-apply-fence-"));
    process.env.CODEX_HOME = home;
    try {
      writeFileSync(join(home, "codexcommander-catalog.json"), '{"models":[{"slug":"a"}]}\n');
      writeFileSync(join(home, "models_cache.json"), '{"models":[{"slug":"a"}]}\n');
      const fence = bindCatalogArtifactsForApply({
        config: {} as never,
        authority: {} as never,
        revision: "test-revision",
      });
      expect(fence).not.toBeNull();
      expect(catalogApplyFenceArtifactsStillMatch(fence!)).toBe(true);

      writeFileSync(join(home, "models_cache.json"), '{"models":[{"slug":"b"}]}\n');
      expect(catalogApplyFenceArtifactsStillMatch(fence!)).toBe(true);
      rmSync(join(home, "models_cache.json"));
      expect(catalogApplyFenceArtifactsStillMatch(fence!)).toBe(true);
      writeFileSync(join(home, "codexcommander-catalog.json"), '{"models":[{"slug":"b"}]}\n');
      expect(catalogApplyFenceArtifactsStillMatch(fence!)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the advanced sync-cache fence remains exact and cache-only", () => {
    const previous = process.env.CODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ccx-cli-cache-apply-fence-"));
    process.env.CODEX_HOME = home;
    try {
      writeFileSync(join(home, "models_cache.json"), '{"models":[{"slug":"a"}]}\n');
      const fence = bindCacheArtifactForApply({
        config: {} as never,
        authority: {} as never,
        revision: "cache-test-revision",
      });
      expect(fence).not.toBeNull();
      expect(cacheApplyFenceArtifactStillMatches(fence!)).toBe(true);

      writeFileSync(join(home, "models_cache.json"), '{"models":[{"slug":"b"}]}\n');
      expect(cacheApplyFenceArtifactStillMatches(fence!)).toBe(false);
      rmSync(join(home, "models_cache.json"));
      expect(cacheApplyFenceArtifactStillMatches(fence!)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("worker outcomes remain count-only and report incomplete Apply as failure", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const ok = reportCatalogWorkerApply({
      outcome: "partial",
      staleWorkerCount: 2,
      stoppedWorkerCount: 1,
      survivingWorkerCount: 1,
    }, {
      log: value => logs.push(String(value)),
      error: value => errors.push(String(value)),
    });
    expect(ok).toBe(false);
    expect(logs).toEqual([]);
    expect(errors).toEqual(["1 verified stale Codex worker(s) are still running after SIGTERM."]);
  });
});

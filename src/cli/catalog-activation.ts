import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import {
  applyCodexCatalog,
  applyCodexCatalogWorkers,
  codexCatalogSyncCanSignal,
  runCodexCatalogApply,
  type ApplyCodexCatalogLifecycleResult,
  type ApplyCodexCatalogWorkersResult,
} from "../codex/catalog-apply";
import {
  captureCodexCatalogDesiredSnapshot,
  collectCodexCatalogActivationWorkerState,
  resetCodexCatalogActivationWorkerStateCache,
  type CodexCatalogDesiredSnapshot,
} from "../codex/catalog-activation";
import {
  listCodexAppServerProcesses,
  resetCodexAppServerCatalogStateCache,
  restartCodexAppServers,
} from "../codex/app-server-processes";
import { activeCodexModelsCachePath, readCodexCatalogPath } from "../codex/catalog/parsing";
import { getCodexRoutingKind } from "../codex/inject";
import type { CodexRoutingKind } from "../codex/routing-document";
import { syncModelsToCodex, type CodexSyncResult } from "../codex/sync";
import {
  acquireProxyLifecycleAuthority,
  type ProxyLifecycleAuthority,
} from "../server/proxy-lifecycle-authority";
import {
  proxyLifecycleLockLeaseHeaders,
  type ProxyLifecycleLockLease,
} from "../server/proxy-lifecycle-protocol";
import { RuntimeApiError, runtimeRequest } from "./runtime-api";

interface CatalogActivationReceipt {
  catalog: { status: "current" | "pending" | "degraded" | "unknown" };
}

export type CliCodexSyncResult = CodexSyncResult & {
  activation?: CatalogActivationReceipt;
};

function isCodexSyncResult(value: unknown): value is CodexSyncResult {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<CodexSyncResult>;
  return (candidate.status === "applied" || candidate.status === "skipped" || candidate.status === "refused")
    && typeof candidate.ok === "boolean"
    && typeof candidate.catalogExists === "boolean"
    && typeof candidate.catalogWritten === "boolean"
    && typeof candidate.cacheSynced === "boolean"
    && typeof candidate.message === "string";
}

function hasCatalogActivationReceipt(value: unknown): value is CodexSyncResult & {
  activation: CatalogActivationReceipt;
} {
  if (!isCodexSyncResult(value)) return false;
  const activation = (value as { activation?: unknown }).activation;
  if (activation === null || typeof activation !== "object") return false;
  const catalog = (activation as { catalog?: unknown }).catalog;
  if (catalog === null || typeof catalog !== "object") return false;
  const status = (catalog as { status?: unknown }).status;
  return status === "current" || status === "pending" || status === "degraded" || status === "unknown";
}

export function liveCatalogActivationIsReady(result: CliCodexSyncResult): boolean {
  return result.activation?.catalog.status === "current"
    || result.activation?.catalog.status === "degraded";
}

export function catalogSyncCanApply(
  result: CliCodexSyncResult,
  requireLiveReceipt: boolean,
): boolean {
  return codexCatalogSyncCanSignal(result)
    && (!requireLiveReceipt || liveCatalogActivationIsReady(result));
}

interface CliCatalogSyncDeps {
  syncModelsToCodex: typeof syncModelsToCodex;
  runtimeRequest: typeof runtimeRequest;
  acquireAuthority?: (options: { includeStart: true }) => Promise<ProxyLifecycleAuthority>;
}

const defaultCliSyncDeps: CliCatalogSyncDeps = { syncModelsToCodex, runtimeRequest };

/** Serialize every CLI-local Codex mutation under the canonical E -> S hierarchy. */
export async function runLocalCliCodexSync<T>(
  sync: () => Promise<T>,
  acquireAuthority: (options: { includeStart: true }) => Promise<ProxyLifecycleAuthority>
    = acquireProxyLifecycleAuthority,
): Promise<T> {
  const authority = await acquireAuthority({ includeStart: true });
  try {
    return await sync();
  } finally {
    authority.releaseAll();
  }
}

/**
 * Keep catalog publication in the exact runtime-record proxy when one exists.
 * Its process-local convergence receipt then remains available to the dashboard;
 * public config-port discovery and offline CLI use converge the caller's own
 * files locally.
 */
export async function syncCodexCatalogForCli(
  live: LiveProxy | null,
  deps: CliCatalogSyncDeps = defaultCliSyncDeps,
  lifecycleLease?: ProxyLifecycleLockLease,
): Promise<CliCodexSyncResult> {
  if (!lifecycleLease) {
    const authority = await (deps.acquireAuthority ?? acquireProxyLifecycleAuthority)({
      includeStart: true,
    });
    try {
      const lease = authority.delegatedLease();
      if (!lease) throw new Error("CLI Codex sync lost lifecycle authority before mutation.");
      return await syncCodexCatalogForCli(live, deps, lease);
    } finally {
      authority.releaseAll();
    }
  }
  // Public /healthz identity at the configured port is not management
  // authority. It may be an unrelated CodexCommander instance using another
  // home (a common test/development collision), and it has no protected
  // runtime record from which this CLI can attest it. Only an exact
  // runtime-record PID may receive the authenticated POST; otherwise converge
  // the caller's own files locally without releasing a credential or body to
  // the listener. Cross-process catalog serialization still protects a legacy
  // same-home proxy whose runtime record was lost.
  if (!live || live.source !== "runtime" || live.pid === null) {
    return deps.syncModelsToCodex();
  }
  try {
    const headers = proxyLifecycleLockLeaseHeaders(lifecycleLease);
    const response = await deps.runtimeRequest<unknown>("/api/sync", {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(45_000),
    }, {
      baseUrl: `http://${probeHostname(live.hostname)}:${live.port}`,
    });
    if (!hasCatalogActivationReceipt(response)) {
      throw new RuntimeApiError("The running proxy returned an unverified Codex sync result.", 502, response);
    }
    return response;
  } catch (error) {
    // /api/sync preserves the structured sync body on refused/failed responses.
    // Keep the established CLI projection without falling back to a competing
    // local writer that would strand the server's process-local receipt.
    if (error instanceof RuntimeApiError && hasCatalogActivationReceipt(error.body)) return error.body;
    throw error;
  }
}

interface FileFingerprint {
  path: string;
  sha256: string;
}

interface CatalogArtifactSnapshot {
  catalog: FileFingerprint;
}

interface CacheArtifactSnapshot {
  cache: FileFingerprint;
}

export interface CatalogApplyFence {
  desired: CodexCatalogDesiredSnapshot;
  artifacts: CatalogArtifactSnapshot;
}

export interface CacheApplyFence {
  desired: CodexCatalogDesiredSnapshot;
  artifacts: CacheArtifactSnapshot;
}

function fingerprint(path: string): FileFingerprint {
  return {
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function captureCatalogArtifacts(): CatalogArtifactSnapshot {
  return {
    catalog: fingerprint(readCodexCatalogPath()),
  };
}

function captureCacheArtifact(): CacheArtifactSnapshot {
  return { cache: fingerprint(activeCodexModelsCachePath()) };
}

function sameFileFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.path === right.path && left.sha256 === right.sha256;
}

function catalogArtifactsStillMatch(expected: CatalogArtifactSnapshot): boolean {
  try {
    const current = captureCatalogArtifacts();
    return sameFileFingerprint(current.catalog, expected.catalog);
  } catch {
    return false;
  }
}

function cacheArtifactStillMatches(expected: CacheArtifactSnapshot): boolean {
  try {
    return sameFileFingerprint(captureCacheArtifact().cache, expected.cache);
  } catch {
    return false;
  }
}

export function catalogApplyFenceArtifactsStillMatch(expected: CatalogApplyFence): boolean {
  return catalogArtifactsStillMatch(expected.artifacts);
}

export function cacheApplyFenceArtifactStillMatches(expected: CacheApplyFence): boolean {
  return cacheArtifactStillMatches(expected.artifacts);
}

/** Bind the exact authoritative catalog bytes only after convergence succeeds. */
export function bindCatalogArtifactsForApply(
  desired: CodexCatalogDesiredSnapshot | null,
): CatalogApplyFence | null {
  if (!desired) return null;
  try {
    return { desired, artifacts: captureCatalogArtifacts() };
  } catch {
    return null;
  }
}

/** Bind the exact cache bytes for the explicit advanced `sync-cache` command. */
export function bindCacheArtifactForApply(
  desired: CodexCatalogDesiredSnapshot | null,
): CacheApplyFence | null {
  if (!desired) return null;
  try {
    return { desired, artifacts: captureCacheArtifact() };
  } catch {
    return null;
  }
}

interface CompanionCatalogApplyDeps {
  findLiveProxy: typeof findLiveProxy;
  syncCatalog: typeof syncCodexCatalogForCli;
  applyCatalog: typeof applyCodexCatalog;
  captureDesiredSnapshot?: typeof captureCodexCatalogDesiredSnapshot;
  captureArtifacts?: typeof captureCatalogArtifacts;
  artifactsStillMatch?: typeof catalogArtifactsStillMatch;
  getRoutingKind?: () => CodexRoutingKind;
}

const defaultCompanionDeps: CompanionCatalogApplyDeps = {
  findLiveProxy,
  syncCatalog: syncCodexCatalogForCli,
  applyCatalog: applyCodexCatalog,
};

/**
 * The fixed native bridge keeps convergence in the authenticated live proxy,
 * then delegates all exact-worker and revision-fence policy to catalog-apply.
 */
export async function applyCodexCatalogForCompanion(
  deps: CompanionCatalogApplyDeps = defaultCompanionDeps,
): Promise<ApplyCodexCatalogLifecycleResult> {
  const captureDesiredSnapshot = deps.captureDesiredSnapshot ?? captureCodexCatalogDesiredSnapshot;
  const captureArtifacts = deps.captureArtifacts ?? captureCatalogArtifacts;
  const artifactsStillMatch = deps.artifactsStillMatch ?? catalogArtifactsStillMatch;
  const routingKind = deps.getRoutingKind ?? getCodexRoutingKind;
  let artifactFence: CatalogArtifactSnapshot | null = null;
  const resetCatalogStateCache = () => {
    resetCodexAppServerCatalogStateCache();
    resetCodexCatalogActivationWorkerStateCache();
  };
  return deps.applyCatalog({
    findLiveProxy: deps.findLiveProxy,
    captureDesiredSnapshot,
    syncModelsToCodex: async () => {
      const live = await deps.findLiveProxy();
      if (!live) throw new Error("CodexCommander stopped before catalog synchronization.");
      const result = await deps.syncCatalog(live);
      if (catalogSyncCanApply(result, true)) {
        artifactFence = captureArtifacts();
      }
      return result;
    },
    inspectArtifactProof: () => artifactFence !== null && artifactsStillMatch(artifactFence)
      ? "current"
      : "drifted",
    getRoutingKind: routingKind,
    resetCatalogStateCache,
    collectCatalogState: collectCodexCatalogActivationWorkerState,
    listCodexWorkers: listCodexAppServerProcesses,
    restartCodexWorkers: restartCodexAppServers,
  });
}

export function captureCatalogRestartFence(
  restartRequested: boolean,
): CodexCatalogDesiredSnapshot | null {
  if (!restartRequested) return null;
  try {
    return captureCodexCatalogDesiredSnapshot();
  } catch {
    return null;
  }
}

function cacheRestartFenceStillMatches(expected: CacheApplyFence): boolean {
  try {
    return captureCodexCatalogDesiredSnapshot().revision === expected.desired.revision
      && getCodexRoutingKind() === "codexcommander-local"
      && cacheApplyFenceArtifactStillMatches(expected);
  } catch {
    return false;
  }
}

export function reportCatalogWorkerApply(
  result: ApplyCodexCatalogWorkersResult,
  output: Pick<Console, "log" | "error"> = console,
): boolean {
  switch (result.outcome) {
    case "applied":
      output.log(result.stoppedWorkerCount > 0
        ? `Stopped ${result.stoppedWorkerCount} verified stale Codex worker(s). A replacement will load the synchronized catalog.`
        : "The verified stale Codex workers exited before signaling completed. A replacement will load the synchronized catalog.");
      return true;
    case "already_current":
      output.log("Running Codex workers already match the synchronized catalog; no process was stopped.");
      return true;
    case "no_workers":
      output.log("No Codex background worker is running. The synchronized catalog will load when Codex starts one.");
      return true;
    case "superseded":
      output.error("The saved CodexCommander configuration changed during synchronization; no further Codex workers were stopped. Run the command again.");
      return false;
    case "partial":
      output.error(`${result.survivingWorkerCount} verified stale Codex worker(s) are still running after SIGTERM.`);
      return false;
    case "blocked":
      output.error("Codex worker identity or start time could not be verified; no process was stopped.");
      return false;
  }
}

export interface ApplySynchronizedCatalogWorkersDeps {
  captureDesiredSnapshot: typeof captureCodexCatalogDesiredSnapshot;
  artifactFenceStillMatches: (expected: CatalogApplyFence) => boolean;
  getRoutingKind: () => CodexRoutingKind;
  resetWorkerObservation: () => void;
  collectWorkerState: typeof collectCodexCatalogActivationWorkerState;
  applyWorkers: (
    authorizeSignal: () => boolean,
    observedBefore: ReturnType<typeof collectCodexCatalogActivationWorkerState>,
  ) => Promise<ApplyCodexCatalogWorkersResult>;
}

const defaultSynchronizedApplyDeps: ApplySynchronizedCatalogWorkersDeps = {
  captureDesiredSnapshot: captureCodexCatalogDesiredSnapshot,
  artifactFenceStillMatches: catalogApplyFenceArtifactsStillMatch,
  getRoutingKind: getCodexRoutingKind,
  resetWorkerObservation: () => {
    resetCodexAppServerCatalogStateCache();
    resetCodexCatalogActivationWorkerStateCache();
  },
  collectWorkerState: collectCodexCatalogActivationWorkerState,
  applyWorkers: (authorizeSignal, observedBefore) => applyCodexCatalogWorkers(
    authorizeSignal,
    undefined,
    observedBefore,
  ),
};

export async function applySynchronizedCatalogWorkers(
  expected: CatalogApplyFence | null,
  synchronized: CliCodexSyncResult,
  deps: ApplySynchronizedCatalogWorkersDeps = defaultSynchronizedApplyDeps,
): Promise<ApplyCodexCatalogWorkersResult | null> {
  if (!expected) return null;
  const result = await runCodexCatalogApply({
    expectedDesiredRevision: expected.desired.revision,
  }, {
    captureDesiredSnapshot: deps.captureDesiredSnapshot,
    // The CLI completed the canonical full sync immediately before binding
    // this exact catalog-byte fence; replay only its structured, warning-bearing receipt.
    syncCatalog: async () => synchronized,
    inspectArtifactProof: () => deps.artifactFenceStillMatches(expected)
      ? "current"
      : "drifted",
    getRoutingKind: deps.getRoutingKind,
    resetWorkerObservation: deps.resetWorkerObservation,
    collectWorkerState: deps.collectWorkerState,
    applyWorkers: deps.applyWorkers,
  });
  return {
    outcome: result.outcome,
    staleWorkerCount: result.staleWorkerCount,
    stoppedWorkerCount: result.stoppedWorkerCount,
    survivingWorkerCount: result.survivingWorkerCount,
  };
}

/** Apply the advanced sync-cache command against its own exact write fence. */
export async function applyInvalidatedCacheWorkers(
  expected: CacheApplyFence | null,
): Promise<ApplyCodexCatalogWorkersResult | null> {
  if (!expected) return null;
  const [processes, parsing, fs] = await Promise.all([
    import("../codex/app-server-processes"),
    import("../codex/catalog/parsing"),
    import("node:fs"),
  ]);
  const cachePath = parsing.activeCodexModelsCachePath();
  const cacheMtimeMs = () => {
    try {
      return fs.statSync(cachePath).mtimeMs;
    } catch {
      return null;
    }
  };
  return applyCodexCatalogWorkers(
    () => cacheRestartFenceStillMatches(expected),
    {
      resetCatalogStateCache: processes.resetCodexAppServerCatalogStateCache,
      collectCatalogState: () => processes.collectCodexAppServerCatalogState({ catalogMtimeMs: cacheMtimeMs }),
      listCodexWorkers: processes.listCodexAppServerProcesses,
      restartCodexWorkers: processes.restartCodexAppServers,
    },
  );
}

export async function warnAfterCatalogWrite(fence: "activation" | "cache"): Promise<void> {
  const processes = await import("../codex/app-server-processes");
  let status;
  if (fence === "activation") {
    const activation = await import("../codex/catalog-activation");
    processes.resetCodexAppServerCatalogStateCache();
    activation.resetCodexCatalogActivationWorkerStateCache();
    status = activation.collectCodexCatalogActivationWorkerState();
  } else {
    const [{ activeCodexModelsCachePath }, fs] = await Promise.all([
      import("../codex/catalog/parsing"),
      import("node:fs"),
    ]);
    const cachePath = activeCodexModelsCachePath();
    processes.resetCodexAppServerCatalogStateCache();
    status = processes.collectCodexAppServerCatalogState({
      catalogMtimeMs: () => {
        try {
          return fs.statSync(cachePath).mtimeMs;
        } catch {
          return null;
        }
      },
    });
  }
  if (status.state === "stale") {
    console.error(processes.formatStaleCodexAppServerWarning(status.processes));
  } else if (status.state === "unknown") {
    console.error("WARNING: Codex files changed, but running worker identity or start time could not be verified. Restart Codex manually if its model list stays stale.");
  }
}

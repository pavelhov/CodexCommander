import { findLiveProxy } from "../server/proxy-liveness";
import {
  collectCodexAppServerCatalogState,
  listCodexAppServerProcesses,
  resetCodexAppServerCatalogStateCache,
  restartCodexAppServers,
  verifiedCodexAppServerProcessesFromCatalogState,
  type CodexAppServerCatalogStatus,
  type RestartCodexAppServersResult,
} from "./app-server-processes";
import {
  captureCodexCatalogDesiredSnapshot,
  collectCodexCatalogActivationWorkerState,
  inspectCodexCatalogArtifactProof,
  resetCodexCatalogActivationWorkerStateCache,
  type CodexCatalogArtifactProof,
  type CodexCatalogDesiredSnapshot,
} from "./catalog-activation";
import { getCodexRoutingKind, type CodexRoutingKind } from "./inject";
import { syncModelsToCodex, type CodexSyncResult } from "./sync";

export const APPLY_CODEX_CATALOG_ACTION = "applyCodexCatalog" as const;

/** Fixed, count-only lifecycle frame consumed by the native companion. */
export interface ApplyCodexCatalogLifecycleResult {
  schemaVersion: 1;
  action: typeof APPLY_CODEX_CATALOG_ACTION;
  ok: boolean;
  state: "running" | "stopped" | "failed";
  changed: boolean;
  pid: null;
  port: null;
  message: string;
  errorCode?: "SYNC_FAILED" | "CODEX_RESTART_REQUIRED";
  catalogUpdated: boolean;
  codexRestartRequired: boolean;
  staleWorkerCount: number;
  stoppedWorkerCount: number;
  survivingWorkerCount: number;
}

export type ApplyCodexCatalogWorkersOutcome =
  | "applied"
  | "already_current"
  | "no_workers"
  | "partial"
  | "superseded"
  | "blocked";

export interface ApplyCodexCatalogWorkersResult {
  outcome: ApplyCodexCatalogWorkersOutcome;
  staleWorkerCount: number;
  stoppedWorkerCount: number;
  survivingWorkerCount: number;
}

export interface ApplyCodexCatalogWorkersDeps {
  resetCatalogStateCache: typeof resetCodexAppServerCatalogStateCache;
  collectCatalogState: typeof collectCodexAppServerCatalogState;
  listCodexWorkers: typeof listCodexAppServerProcesses;
  restartCodexWorkers: typeof restartCodexAppServers;
}

const defaultWorkerDeps: ApplyCodexCatalogWorkersDeps = {
  resetCatalogStateCache: resetCatalogActivationStateCaches,
  collectCatalogState: collectCodexCatalogActivationWorkerState,
  listCodexWorkers: listCodexAppServerProcesses,
  restartCodexWorkers: restartCodexAppServers,
};

function resetCatalogActivationStateCaches(): void {
  resetCodexAppServerCatalogStateCache();
  resetCodexCatalogActivationWorkerStateCache();
}

function unknownCatalogState(): CodexAppServerCatalogStatus {
  return { state: "unknown", processes: [], catalogMtimeMs: null };
}

function safeCatalogState(deps: Pick<ApplyCodexCatalogWorkersDeps,
  "resetCatalogStateCache" | "collectCatalogState">): CodexAppServerCatalogStatus {
  try {
    deps.resetCatalogStateCache();
    return deps.collectCatalogState();
  } catch {
    return unknownCatalogState();
  }
}

function staleProcessStarts(status: CodexAppServerCatalogStatus): Map<number, number> {
  const starts = new Map<number, number>();
  if (status.state !== "stale" || status.catalogMtimeMs === null) return starts;
  for (const process of status.processes) {
    if (
      Number.isSafeInteger(process.pid)
      && process.pid > 1
      && process.startedAtMs !== null
      && Number.isFinite(process.startedAtMs)
      && process.startedAtMs <= status.catalogMtimeMs
    ) {
      starts.set(process.pid, process.startedAtMs);
    }
  }
  return starts;
}

function uniqueCount(values: readonly number[]): number {
  return new Set(values).size;
}

/**
 * Exact-process interruption primitive. `authorizeSignal` is evaluated once
 * before entering the process helper and again by that helper immediately
 * before every eligible SIGTERM, after PID/argv/birth-time revalidation.
 */
export async function applyCodexCatalogWorkers(
  authorizeSignal: () => boolean,
  deps: ApplyCodexCatalogWorkersDeps = defaultWorkerDeps,
  observedBefore?: CodexAppServerCatalogStatus,
): Promise<ApplyCodexCatalogWorkersResult> {
  const before = observedBefore ?? safeCatalogState(deps);
  if (before.state === "unknown") {
    return { outcome: "blocked", staleWorkerCount: 0, stoppedWorkerCount: 0, survivingWorkerCount: 0 };
  }
  if (before.state === "not_running") {
    return { outcome: "no_workers", staleWorkerCount: 0, stoppedWorkerCount: 0, survivingWorkerCount: 0 };
  }
  if (before.state === "fresh") {
    return { outcome: "already_current", staleWorkerCount: 0, stoppedWorkerCount: 0, survivingWorkerCount: 0 };
  }

  const staleStarts = staleProcessStarts(before);
  const staleWorkerCount = staleStarts.size;
  let listed = verifiedCodexAppServerProcessesFromCatalogState(before);
  if (listed === null) {
    try {
      listed = deps.listCodexWorkers();
    } catch {
      return { outcome: "blocked", staleWorkerCount, stoppedWorkerCount: 0, survivingWorkerCount: staleWorkerCount };
    }
  }
  const targets = listed.flatMap(process => {
    const startedAtMs = staleStarts.get(process.pid);
    return startedAtMs === undefined ? [] : [{ ...process, startedAtMs }];
  });
  if (targets.length === 0) {
    const current = safeCatalogState(deps);
    const outcome = current.state === "not_running"
      ? "no_workers"
      : current.state === "fresh"
        ? "already_current"
        : "blocked";
    return {
      outcome,
      staleWorkerCount,
      stoppedWorkerCount: 0,
      survivingWorkerCount: outcome === "blocked" ? staleWorkerCount : 0,
    };
  }
  if (!authorizeSignal()) {
    return {
      outcome: "superseded",
      staleWorkerCount,
      stoppedWorkerCount: 0,
      survivingWorkerCount: staleWorkerCount,
    };
  }

  let restart: RestartCodexAppServersResult = {
    requested: [],
    signaled: [],
    stopped: [],
    surviving: [],
    failed: [],
  };
  try {
    restart = deps.restartCodexWorkers(targets, { authorizeSignal });
  } catch {
    // The final process observation is authoritative; platform detail is private.
  }
  const after = safeCatalogState(deps);
  const signaled = new Set(restart.signaled);
  const stoppedWorkerCount = new Set(
    restart.stopped.filter(pid => signaled.has(pid)),
  ).size;
  const survivingWorkerCount = after.state === "stale"
    ? staleProcessStarts(after).size
    : after.state === "unknown"
      ? Math.max(uniqueCount(restart.surviving), staleWorkerCount - stoppedWorkerCount)
      : 0;
  const supersededBeforeAnySignal = restart.authorizationRefused === true
    && restart.signaled.length === 0;
  return {
    outcome: supersededBeforeAnySignal
      ? "superseded"
      : restart.authorizationRefused === true || after.state === "stale" || after.state === "unknown"
        ? "partial"
        : "applied",
    staleWorkerCount,
    stoppedWorkerCount,
    survivingWorkerCount,
  };
}

export type CodexCatalogApplyBlockReason =
  | "desired-superseded"
  | "sync-failed"
  | "sync-warning"
  | "integration-disabled"
  | "external-routing"
  | "artifact-not-current"
  | "routing-not-owned"
  | "authorization-changed"
  | "worker-state-unknown"
  | "workers-survived";

export interface CodexCatalogApplyResult extends ApplyCodexCatalogWorkersResult {
  catalogUpdated: boolean;
  workerState: CodexAppServerCatalogStatus["state"];
  blockReason?: CodexCatalogApplyBlockReason;
}

/** The one warning/degraded policy used by HTTP, CLI, and companion Apply. */
export function codexCatalogSyncCanSignal(result: CodexSyncResult): boolean {
  return result.status === "applied"
    && result.ok === true
    && result.catalogExists === true
    && (result.warning === undefined || result.warning.length === 0);
}

function syncBlockReason(result: CodexSyncResult): CodexCatalogApplyBlockReason {
  if (result.status === "skipped" && result.skippedReason === "desired_disabled") {
    return "integration-disabled";
  }
  if (result.status === "skipped" && result.skippedReason === "external_provider") {
    return "external-routing";
  }
  if (result.warning !== undefined && result.warning.length > 0) return "sync-warning";
  return "sync-failed";
}

function countsFromObservation(status: CodexAppServerCatalogStatus): ApplyCodexCatalogWorkersResult {
  const staleWorkerCount = staleProcessStarts(status).size;
  return {
    outcome: "blocked",
    staleWorkerCount,
    stoppedWorkerCount: 0,
    survivingWorkerCount: staleWorkerCount,
  };
}

export interface CodexCatalogApplyCoreDeps {
  captureDesiredSnapshot: () => CodexCatalogDesiredSnapshot;
  syncCatalog: (desired: CodexCatalogDesiredSnapshot) => Promise<CodexSyncResult>;
  inspectArtifactProof: (desired: CodexCatalogDesiredSnapshot) => CodexCatalogArtifactProof;
  getRoutingKind: () => CodexRoutingKind;
  resetWorkerObservation: () => void;
  collectWorkerState: () => CodexAppServerCatalogStatus;
  applyWorkers: (
    authorizeSignal: () => boolean,
    observedBefore: CodexAppServerCatalogStatus,
  ) => Promise<ApplyCodexCatalogWorkersResult>;
}

export interface CodexCatalogApplyInput {
  /** Browser consent supplies this; CLI/companion bind it before convergence. */
  expectedDesiredRevision?: string;
}

function observeWorkers(deps: Pick<CodexCatalogApplyCoreDeps,
  "resetWorkerObservation" | "collectWorkerState">): CodexAppServerCatalogStatus {
  try {
    deps.resetWorkerObservation();
    return deps.collectWorkerState();
  } catch {
    return unknownCatalogState();
  }
}

function blockedResult(
  reason: CodexCatalogApplyBlockReason,
  catalogUpdated: boolean,
  workers: CodexAppServerCatalogStatus,
  outcome: "blocked" | "superseded" = "blocked",
): CodexCatalogApplyResult {
  return {
    ...countsFromObservation(workers),
    outcome,
    catalogUpdated,
    workerState: workers.state,
    blockReason: reason,
  };
}

/**
 * Canonical catalog Apply orchestration shared by every adapter.
 *
 * A successful sync may adopt native routing. External routing and OFF are
 * preserved/refused by sync and never open the signal path. Exact artifact
 * proof and CodexCommander-owned routing are required after convergence and
 * are revalidated with the generation-bearing desired snapshot before every
 * process signal.
 */
export async function runCodexCatalogApply(
  input: CodexCatalogApplyInput,
  deps: CodexCatalogApplyCoreDeps,
): Promise<CodexCatalogApplyResult> {
  let desired: CodexCatalogDesiredSnapshot;
  try {
    desired = deps.captureDesiredSnapshot();
  } catch {
    return blockedResult("sync-failed", false, observeWorkers(deps));
  }
  const expectedRevision = input.expectedDesiredRevision ?? desired.revision;
  if (desired.revision !== expectedRevision) {
    return blockedResult("desired-superseded", false, observeWorkers(deps), "superseded");
  }

  let syncResult: CodexSyncResult;
  try {
    syncResult = await deps.syncCatalog(desired);
  } catch {
    return blockedResult("sync-failed", false, observeWorkers(deps));
  }
  const catalogUpdated = syncResult.catalogWritten === true || syncResult.cacheSynced === true;

  let convergedDesired: CodexCatalogDesiredSnapshot;
  try {
    convergedDesired = deps.captureDesiredSnapshot();
  } catch {
    return blockedResult("desired-superseded", catalogUpdated, observeWorkers(deps), "superseded");
  }
  if (convergedDesired.revision !== expectedRevision) {
    return blockedResult("desired-superseded", catalogUpdated, observeWorkers(deps), "superseded");
  }
  if (!codexCatalogSyncCanSignal(syncResult)) {
    return blockedResult(syncBlockReason(syncResult), catalogUpdated, observeWorkers(deps));
  }

  let artifactProof: CodexCatalogArtifactProof;
  let routingKind: CodexRoutingKind;
  try {
    artifactProof = deps.inspectArtifactProof(convergedDesired);
    routingKind = deps.getRoutingKind();
  } catch {
    return blockedResult("artifact-not-current", catalogUpdated, observeWorkers(deps));
  }
  if (artifactProof !== "current") {
    return blockedResult("artifact-not-current", catalogUpdated, observeWorkers(deps));
  }
  if (routingKind !== "codexcommander-local") {
    return blockedResult("routing-not-owned", catalogUpdated, observeWorkers(deps));
  }

  const workersBefore = observeWorkers(deps);
  const authorizeSignal = (): boolean => {
    try {
      const current = deps.captureDesiredSnapshot();
      return current.revision === expectedRevision
        && deps.getRoutingKind() === "codexcommander-local"
        && deps.inspectArtifactProof(current) === "current";
    } catch {
      return false;
    }
  };
  if (!authorizeSignal()) {
    return blockedResult("authorization-changed", catalogUpdated, workersBefore, "superseded");
  }

  if (workersBefore.state === "unknown") {
    return blockedResult("worker-state-unknown", catalogUpdated, workersBefore);
  }
  if (workersBefore.state === "not_running") {
    return {
      outcome: "no_workers",
      staleWorkerCount: 0,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
      catalogUpdated,
      workerState: workersBefore.state,
    };
  }
  if (workersBefore.state === "fresh") {
    return {
      outcome: "already_current",
      staleWorkerCount: 0,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
      catalogUpdated,
      workerState: workersBefore.state,
    };
  }

  let result: ApplyCodexCatalogWorkersResult;
  try {
    result = await deps.applyWorkers(authorizeSignal, workersBefore);
  } catch {
    return blockedResult("worker-state-unknown", catalogUpdated, workersBefore);
  }
  return {
    ...result,
    catalogUpdated,
    workerState: workersBefore.state,
    ...(result.outcome === "superseded"
      ? { blockReason: "authorization-changed" as const }
      : result.outcome === "partial"
        ? { blockReason: "workers-survived" as const }
        : result.outcome === "blocked"
          ? { blockReason: "worker-state-unknown" as const }
          : {}),
  };
}

export interface ApplyCodexCatalogDeps extends ApplyCodexCatalogWorkersDeps {
  findLiveProxy: typeof findLiveProxy;
  captureDesiredSnapshot: typeof captureCodexCatalogDesiredSnapshot;
  syncModelsToCodex: typeof syncModelsToCodex;
  inspectArtifactProof: (desired: CodexCatalogDesiredSnapshot) => CodexCatalogArtifactProof;
  getRoutingKind: () => CodexRoutingKind;
}

const defaultDeps: ApplyCodexCatalogDeps = {
  findLiveProxy,
  captureDesiredSnapshot: captureCodexCatalogDesiredSnapshot,
  syncModelsToCodex,
  inspectArtifactProof: desired => inspectCodexCatalogArtifactProof(desired.config),
  getRoutingKind: getCodexRoutingKind,
  resetCatalogStateCache: resetCatalogActivationStateCaches,
  collectCatalogState: collectCodexCatalogActivationWorkerState,
  listCodexWorkers: listCodexAppServerProcesses,
  restartCodexWorkers: restartCodexAppServers,
};

function lifecycleMessage(result: CodexCatalogApplyResult): string {
  if (result.blockReason === "integration-disabled") {
    return "Agent catalog does not need to be applied.";
  }
  if (result.blockReason === "external-routing") {
    return "Codex uses external routing; no Codex process was stopped.";
  }
  if (result.blockReason === "sync-failed" || result.blockReason === "sync-warning"
    || result.blockReason === "artifact-not-current" || result.blockReason === "routing-not-owned") {
    return "Agent catalog update did not complete.";
  }
  if (result.outcome === "superseded") {
    return "Agent catalog Apply was superseded before a Codex process could be stopped.";
  }
  if (result.outcome === "blocked") {
    return "Agent catalog was synchronized, but Codex worker state could not be verified.";
  }
  if (result.outcome === "partial") {
    return "Agent catalog was updated, but some stale Codex workers are still running.";
  }
  if (result.outcome === "no_workers") {
    return "Agent catalog applied. Codex will load it when a new background worker starts.";
  }
  if (result.outcome === "already_current") return "Agent catalog is already current.";
  return "Agent catalog applied.";
}

/** Thin native-companion adapter; it never restarts the CodexCommander proxy. */
export async function applyCodexCatalog(
  deps: ApplyCodexCatalogDeps = defaultDeps,
): Promise<ApplyCodexCatalogLifecycleResult> {
  const live = await deps.findLiveProxy().catch(() => null);
  if (!live) {
    return {
      schemaVersion: 1,
      action: APPLY_CODEX_CATALOG_ACTION,
      ok: false,
      state: "stopped",
      changed: false,
      pid: null,
      port: null,
      message: "CodexCommander is not running; the agent catalog was not changed.",
      errorCode: "SYNC_FAILED",
      catalogUpdated: false,
      codexRestartRequired: false,
      staleWorkerCount: 0,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
    };
  }

  const result = await runCodexCatalogApply({}, {
    captureDesiredSnapshot: deps.captureDesiredSnapshot,
    syncCatalog: desired => deps.syncModelsToCodex(live.port, desired.config, null),
    inspectArtifactProof: deps.inspectArtifactProof,
    getRoutingKind: deps.getRoutingKind,
    resetWorkerObservation: deps.resetCatalogStateCache,
    collectWorkerState: deps.collectCatalogState,
    applyWorkers: (authorizeSignal, observedBefore) => applyCodexCatalogWorkers(authorizeSignal, {
      resetCatalogStateCache: deps.resetCatalogStateCache,
      collectCatalogState: deps.collectCatalogState,
      listCodexWorkers: deps.listCodexWorkers,
      restartCodexWorkers: deps.restartCodexWorkers,
    }, observedBefore),
  });
  const ok = result.outcome === "applied"
    || result.outcome === "already_current"
    || result.outcome === "no_workers";
  const syncFailure = result.blockReason === "sync-failed"
    || result.blockReason === "sync-warning"
    || result.blockReason === "artifact-not-current"
    || result.blockReason === "routing-not-owned"
    || result.blockReason === "integration-disabled"
    || result.blockReason === "external-routing";
  const intentionalPreservation = result.blockReason === "integration-disabled"
    || result.blockReason === "external-routing";
  const codexRestartRequired = !intentionalPreservation
    && (result.survivingWorkerCount > 0
      || result.workerState === "unknown"
      || result.outcome === "partial"
      || result.outcome === "superseded");
  return {
    schemaVersion: 1,
    action: APPLY_CODEX_CATALOG_ACTION,
    ok,
    state: "running",
    changed: result.catalogUpdated || result.stoppedWorkerCount > 0,
    pid: null,
    port: null,
    message: lifecycleMessage(result),
    ...(!ok
      ? { errorCode: syncFailure ? "SYNC_FAILED" as const : "CODEX_RESTART_REQUIRED" as const }
      : {}),
    catalogUpdated: result.catalogUpdated,
    codexRestartRequired,
    staleWorkerCount: result.staleWorkerCount,
    stoppedWorkerCount: result.stoppedWorkerCount,
    survivingWorkerCount: result.survivingWorkerCount,
  };
}

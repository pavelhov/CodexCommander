import { findLiveProxy } from "../server/proxy-liveness";
import {
  collectCodexAppServerCatalogState,
  listCodexAppServerProcesses,
  resetCodexAppServerCatalogStateCache,
  restartCodexAppServers,
  type CodexAppServerCatalogStatus,
  type CodexAppServerProcess,
  type RestartCodexAppServersResult,
} from "./app-server-processes";
import { syncModelsToCodex, type CodexSyncResult } from "./sync";

export const APPLY_CODEX_CATALOG_ACTION = "applyCodexCatalog" as const;

/**
 * Fixed, app-visible lifecycle frame for applying Codex's model catalog.
 *
 * The worker fields are counts deliberately. Process ids, command lines,
 * filesystem paths, and platform error strings stay inside this module and
 * never cross the menu-app helper boundary.
 */
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

export interface ApplyCodexCatalogDeps {
  findLiveProxy: typeof findLiveProxy;
  syncModelsToCodex: typeof syncModelsToCodex;
  resetCatalogStateCache: typeof resetCodexAppServerCatalogStateCache;
  collectCatalogState: typeof collectCodexAppServerCatalogState;
  listCodexWorkers: typeof listCodexAppServerProcesses;
  restartCodexWorkers: typeof restartCodexAppServers;
}

const defaultDeps: ApplyCodexCatalogDeps = {
  findLiveProxy,
  syncModelsToCodex,
  resetCatalogStateCache: resetCodexAppServerCatalogStateCache,
  collectCatalogState: collectCodexAppServerCatalogState,
  listCodexWorkers: listCodexAppServerProcesses,
  restartCodexWorkers: restartCodexAppServers,
};

const emptyRestartResult = (): RestartCodexAppServersResult => ({
  requested: [],
  stopped: [],
  surviving: [],
  failed: [],
});

function intentionalSyncSkip(result: CodexSyncResult): boolean {
  return result.status === "skipped"
    && result.ok
    && (result.skippedReason === "desired_disabled" || result.skippedReason === "external_provider");
}

function syncResultFailed(result: CodexSyncResult | undefined): boolean {
  if (!result) return true;
  if (intentionalSyncSkip(result)) return false;
  return !result.ok
    || result.status === "refused"
    || (result.warning !== undefined && result.warning.length > 0)
    || (result.catalogQuality === "native-only" && result.catalogWritten !== true);
}

function unknownCatalogState(): CodexAppServerCatalogStatus {
  return { state: "unknown", processes: [], catalogMtimeMs: null };
}

function collectAfterInvalidation(deps: ApplyCodexCatalogDeps): CodexAppServerCatalogStatus {
  try {
    deps.resetCatalogStateCache();
    return deps.collectCatalogState();
  } catch {
    return unknownCatalogState();
  }
}

function staleProcessStarts(
  status: CodexAppServerCatalogStatus,
): Map<number, number> {
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

function currentStaleTargets(
  status: CodexAppServerCatalogStatus,
  deps: ApplyCodexCatalogDeps,
): CodexAppServerProcess[] {
  const staleStarts = staleProcessStarts(status);
  if (staleStarts.size === 0) return [];
  let current: CodexAppServerProcess[];
  try {
    current = deps.listCodexWorkers();
  } catch {
    return [];
  }
  return current.flatMap(process => {
    const startedAtMs = staleStarts.get(process.pid);
    return startedAtMs === undefined ? [] : [{ ...process, startedAtMs }];
  });
}

function uniqueCount(values: readonly number[]): number {
  return new Set(values).size;
}

function fixedMessage(options: {
  syncFailed: boolean;
  syncSkipped: boolean;
  stateUnknown: boolean;
  restartIncomplete: boolean;
  staleDetected: boolean;
  catalogUpdated: boolean;
}): string {
  if (options.syncFailed) return "Agent catalog update did not complete.";
  if (options.syncSkipped) return "Agent catalog does not need to be applied.";
  if (options.stateUnknown) {
    return "Agent catalog was synchronized, but Codex worker state could not be verified.";
  }
  if (options.restartIncomplete) {
    return "Agent catalog was updated, but some stale Codex workers are still running.";
  }
  if (options.staleDetected) return "Agent catalog applied. Codex will reload it on the next task.";
  if (options.catalogUpdated) return "Agent catalog is current. No Codex worker restart was needed.";
  return "Agent catalog is already current.";
}

/**
 * Apply the on-disk Codex catalog, classify long-lived workers, and terminate
 * only workers proven stale. This is the implementation behind the fixed
 * macOS helper action; it never starts, stops, or restarts the CodexCommander proxy.
 */
export async function applyCodexCatalog(
  deps: ApplyCodexCatalogDeps = defaultDeps,
): Promise<ApplyCodexCatalogLifecycleResult> {
  const live = await deps.findLiveProxy().catch(() => null);
  // This fixed app action is offered only from a healthy CodexCommander state. If
  // that identity vanished before confirmation, refuse without touching the
  // catalog or any Codex process; the standalone CLI keeps its own offline
  // synchronization behavior.
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
  let syncResult: CodexSyncResult | undefined;
  try {
    syncResult = await deps.syncModelsToCodex(live.port, undefined, null);
  } catch {
    // Without a structured result there is no proof that a catalog/cache write
    // landed. Continue only to report readiness; the signal gate below remains
    // closed and no error detail crosses the helper boundary.
  }
  const catalogUpdated = syncResult?.catalogWritten === true || syncResult?.cacheSynced === true;
  const syncSkipped = syncResult !== undefined && intentionalSyncSkip(syncResult);
  const syncFailed = syncResultFailed(syncResult);

  const before = collectAfterInvalidation(deps);
  const initialStaleStarts = staleProcessStarts(before);
  const staleDetected = before.state === "stale";
  const staleWorkerCount = initialStaleStarts.size;
  let restart = emptyRestartResult();
  let after = before;

  // Unknown is a fail-closed state. No listing or signal path is reached.
  if (before.state === "stale" && !syncSkipped && !syncFailed) {
    const targets = currentStaleTargets(before, deps);
    try {
      restart = deps.restartCodexWorkers(targets);
    } catch {
      // Verification below decides whether any stale worker remains. Platform
      // error text is intentionally discarded at this boundary.
    }
    after = collectAfterInvalidation(deps);
  }

  const remainingStale = staleProcessStarts(after).size;
  const stoppedReported = uniqueCount(restart.stopped);
  const stoppedByFinalState = after.state === "unknown"
    ? 0
    : Math.max(0, staleWorkerCount - Math.min(staleWorkerCount, remainingStale));
  const stoppedWorkerCount = Math.min(
    staleWorkerCount,
    Math.max(stoppedReported, stoppedByFinalState),
  );
  const survivingWorkerCount = syncSkipped
    ? 0
    : after.state === "stale"
      ? remainingStale
      : after.state === "unknown"
        ? uniqueCount(restart.surviving)
        : 0;
  const stateUnknown = !syncSkipped && (before.state === "unknown" || after.state === "unknown");
  const restartIncomplete = !syncSkipped && staleDetected && after.state === "stale";
  // Unknown cannot prove the old roster is gone, so the app must continue to
  // present the update as incomplete instead of claiming success.
  const codexRestartRequired = !syncSkipped && (after.state === "stale" || after.state === "unknown");
  const ok = !syncFailed && !stateUnknown && !restartIncomplete;

  return {
    schemaVersion: 1,
    action: APPLY_CODEX_CATALOG_ACTION,
    ok,
    state: "running",
    changed: catalogUpdated || stoppedWorkerCount > 0,
    pid: null,
    port: null,
    message: fixedMessage({
      syncFailed,
      syncSkipped,
      stateUnknown,
      restartIncomplete,
      staleDetected,
      catalogUpdated,
    }),
    ...(syncFailed
      ? { errorCode: "SYNC_FAILED" as const }
      : stateUnknown || restartIncomplete
        ? { errorCode: "CODEX_RESTART_REQUIRED" as const }
        : {}),
    catalogUpdated,
    codexRestartRequired,
    staleWorkerCount,
    stoppedWorkerCount,
    survivingWorkerCount,
  };
}

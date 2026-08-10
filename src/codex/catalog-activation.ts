import { createHmac, randomBytes } from "node:crypto";
import { statSync } from "node:fs";

import { loadConfig } from "../config";
import type { CodexCommanderConfig } from "../types";
import {
  configuredSubagentModelMatchesEntry,
  effectiveSubagentRoster,
  readCatalog,
  readCodexCatalogPath,
  type EffectiveSubagentRoster,
  type SubagentRosterExclusion,
} from "./catalog";
import {
  collectCodexAppServerCatalogState,
  reclassifyCodexAppServerCatalogState,
  type CodexAppServerCatalogStatus,
} from "./app-server-processes";
import type { CatalogDisposition } from "./convergence-types";
import {
  codexCatalogConvergenceReceiptMatchesCurrent,
  readCodexCatalogConvergenceReceipt,
} from "./convergence";
import {
  captureCatalogConfigAuthority,
  CatalogAdmissionStaleConfigError,
  type CatalogConfigAuthoritySnapshot,
} from "./catalog-admission";
import {
  activeCodexConfigPath,
  getAgentsEnabled,
  getAgentsMaxDepth,
  getLogicalMaxThreads,
  getSubagentDeveloperInstructions,
  isMultiAgentV2Enabled,
} from "./features";
import { getCodexRoutingKind, type CodexRoutingKind } from "./inject";

export type CodexCatalogProtocol = "v1" | "default" | "v2";
export type CodexCatalogArtifactProof = "current" | "drifted" | "unproven" | "not-required";

export interface CodexCatalogRosterProjection {
  advertised: string[];
  excluded: SubagentRosterExclusion[];
}

export interface CodexCatalogActivationState {
  schemaVersion: 1;
  desired: {
    revision: string;
    chosen: string[];
    protocol: CodexCatalogProtocol;
  };
  catalog: {
    status: "current" | "pending" | "degraded" | "unknown";
    advertised: string[];
    excluded: SubagentRosterExclusion[];
    projections: {
      v1: CodexCatalogRosterProjection;
      v2: CodexCatalogRosterProjection;
    };
  };
  routing: {
    status: "current" | "not_injected" | "external" | "unknown" | "not_required";
    kind: CodexRoutingKind;
  };
  workers: {
    status: "current" | "reload_required" | "not_running" | "unknown";
    runningCount: number;
    staleCount: number;
    evidence: "process-start-vs-activation-fence" | "no-processes" | "unavailable";
  };
  apply: {
    required: boolean;
    allowed: boolean;
    reason:
      | "reload-required"
      | "routing-not-injected"
      | "external-routing"
      | "routing-unknown"
      | "integration-disabled"
      | "already-current"
      | "no-workers"
      | "worker-state-unknown"
      | "catalog-not-ready";
  };
}

function routingState(
  config: Pick<CodexCommanderConfig, "clientIntegrations">,
  kind: CodexRoutingKind,
): CodexCatalogActivationState["routing"] {
  if (config.clientIntegrations?.codex === false) return { status: "not_required", kind };
  if (kind === "codexcommander-local") return { status: "current", kind };
  if (kind === "native") return { status: "not_injected", kind };
  if (kind === "custom-local" || kind === "custom-remote") return { status: "external", kind };
  return { status: "unknown", kind };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

// Process-local key: revisions are equality fences, not durable identifiers.
// Keying them prevents the management response from becoming an offline oracle
// over provider credentials that legitimately influence the generated catalog.
const desiredRevisionKey = randomBytes(32);

/** Opaque optimistic-concurrency fence. Its input never crosses the API boundary. */
export function codexCatalogDesiredRevision(
  config: Readonly<CodexCommanderConfig>,
  authority?: CatalogConfigAuthoritySnapshot,
): string {
  let bootInputs: unknown = null;
  try {
    bootInputs = {
      multiAgentV2Enabled: isMultiAgentV2Enabled(),
      maxConcurrentThreadsPerSession: getLogicalMaxThreads(),
      agentsEnabled: getAgentsEnabled(),
      agentsMaxDepth: getAgentsMaxDepth(),
      subagentDeveloperInstructions: getSubagentDeveloperInstructions(),
    };
  } catch {
    // The persisted CodexCommander config still provides a stable fence when
    // native boot settings are temporarily unreadable.
  }
  const bytes = JSON.stringify(canonicalValue({
    config,
    bootInputs,
    configAuthority: authority
      ? {
          generation: authority.generation.value,
          semanticIdentity: authority.semanticIdentity,
          contentIdentity: authority.contentIdentity,
        }
      : null,
  }));
  return `v1:${createHmac("sha256", desiredRevisionKey).update(bytes).digest("hex")}`;
}

export interface CodexCatalogDesiredSnapshot {
  readonly config: CodexCommanderConfig;
  readonly authority: CatalogConfigAuthoritySnapshot;
  readonly revision: string;
}

/**
 * Read the desired config and bind it to its monotonic generation. A concurrent
 * Save between the file read and authority capture is retried, never paired
 * with the newer generation. The generation keeps A -> B -> A from passing an
 * Apply fence merely because the semantic bytes returned to A.
 */
export function captureCodexCatalogDesiredSnapshot(
  readConfig: () => CodexCommanderConfig = loadConfig,
): CodexCatalogDesiredSnapshot {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const config = readConfig();
    try {
      const authority = captureCatalogConfigAuthority(config);
      return {
        config,
        authority,
        revision: codexCatalogDesiredRevision(config, authority),
      };
    } catch (error) {
      if (error instanceof CatalogAdmissionStaleConfigError) continue;
      throw error;
    }
  }
  throw new CatalogAdmissionStaleConfigError();
}

function projection(roster: EffectiveSubagentRoster): CodexCatalogRosterProjection {
  return {
    advertised: roster.advertised.map(model => model.model),
    excluded: [...roster.excluded],
  };
}

function defaultProjection(
  chosen: readonly string[],
  v1: CodexCatalogRosterProjection,
  v2: CodexCatalogRosterProjection,
): CodexCatalogRosterProjection {
  const advertisedSet = new Set([...v1.advertised, ...v2.advertised]);
  const advertised = [...advertisedSet];
  const excluded = chosen.flatMap(configured => {
    if (advertisedSet.has(configured)) return [];
    const v2Reason = v2.excluded.find(item => item.configured === configured);
    const v1Reason = v1.excluded.find(item => item.configured === configured);
    return v2Reason ? [v2Reason] : v1Reason ? [v1Reason] : [];
  });
  return { advertised, excluded };
}

function catalogStatus(
  catalogReadable: boolean,
  active: CodexCatalogRosterProjection,
  orderMatches: boolean,
  disposition?: CatalogDisposition,
  artifactProof: CodexCatalogArtifactProof = "not-required",
): CodexCatalogActivationState["catalog"]["status"] {
  if (disposition?.status === "failed") return "pending";
  if (disposition?.status === "skipped") {
    if (disposition.reason !== "not-requested") {
      return disposition.reason === "catalog-unavailable" ? "unknown" : "pending";
    }
  }
  if (artifactProof === "unproven") return "unknown";
  if (artifactProof === "drifted") return "pending";
  if (!catalogReadable) return "unknown";
  if (active.excluded.some(item => item.reason === "missing_catalog_entry")) return "pending";
  if (!orderMatches) return "pending";
  // Provider/fallback degradation belongs to the mutation's catalogRefresh
  // receipt. It is not persisted, so folding it into activation would make a
  // mutation response say `degraded` while an immediate GET over identical
  // durable evidence says `current`. Deterministic, non-missing exclusions are
  // part of the current roster projection; missing rows remain pending above.
  return "current";
}

/** Process-local proof of the authoritative catalog; Codex owns its volatile cache. */
export function inspectCodexCatalogArtifactProof(
  config: Readonly<CodexCommanderConfig>,
): CodexCatalogArtifactProof {
  if (!readCodexCatalogConvergenceReceipt()) return "unproven";
  return codexCatalogConvergenceReceiptMatchesCurrent({
    config,
    catalogPath: readCodexCatalogPath(),
  }) ? "current" : "drifted";
}

function configuredOrderMatchesCatalog(
  chosen: readonly string[],
  active: CodexCatalogRosterProjection,
  entries: readonly Parameters<typeof configuredSubagentModelMatchesEntry>[1][],
): boolean {
  const excluded = new Set(active.excluded.map(item => item.configured));
  const expected = chosen.filter(configured => !excluded.has(configured));
  const actual: string[] = [];
  for (const slug of active.advertised) {
    const entry = entries.find(candidate => candidate.slug === slug);
    if (!entry) continue;
    const configured = chosen.find(candidate => configuredSubagentModelMatchesEntry(candidate, entry));
    if (configured !== undefined && !actual.includes(configured)) actual.push(configured);
  }
  return expected.length === actual.length
    && expected.every((configured, index) => configured === actual[index]);
}

function workerState(status: CodexAppServerCatalogStatus): CodexCatalogActivationState["workers"] {
  const staleCount = status.state === "stale" && status.catalogMtimeMs !== null
    ? status.processes.filter(process => process.startedAtMs !== null
      && process.startedAtMs <= status.catalogMtimeMs!).length
    : 0;
  if (status.state === "fresh") {
    return {
      status: "current",
      runningCount: status.processes.length,
      staleCount: 0,
      evidence: "process-start-vs-activation-fence",
    };
  }
  if (status.state === "stale") {
    return {
      status: "reload_required",
      runningCount: status.processes.length,
      staleCount,
      evidence: "process-start-vs-activation-fence",
    };
  }
  if (status.state === "not_running") {
    return { status: "not_running", runningCount: 0, staleCount: 0, evidence: "no-processes" };
  }
  return {
    status: "unknown",
    runningCount: status.processes.length,
    staleCount: 0,
    evidence: "unavailable",
  };
}

function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Catalog rows and native Codex boot settings share one explicit Apply boundary. */
function activationFenceObservation(): {
  identity: string;
  mtimeMs: number | null;
} {
  const catalogPath = readCodexCatalogPath();
  const configPath = activeCodexConfigPath();
  const mtimes = [fileMtimeMs(catalogPath), fileMtimeMs(configPath)]
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    identity: `${catalogPath}\0${configPath}`,
    mtimeMs: mtimes.length > 0 ? Math.max(...mtimes) : null,
  };
}

export function codexCatalogActivationFenceMtimeMs(): number | null {
  return activationFenceObservation().mtimeMs;
}

let activationWorkerStateCache: {
  atMs: number;
  fenceIdentity: string;
  fenceMtimeMs: number | null;
  status: CodexAppServerCatalogStatus;
} | null = null;
const ACTIVATION_WORKER_STATE_TTL_MS = 5_000;

export function collectCodexCatalogActivationWorkerState(): CodexAppServerCatalogStatus {
  const atMs = Date.now();
  const fence = activationFenceObservation();
  if (activationWorkerStateCache
    && activationWorkerStateCache.fenceIdentity === fence.identity
    && activationWorkerStateCache.fenceMtimeMs === fence.mtimeMs
    && atMs - activationWorkerStateCache.atMs < ACTIVATION_WORKER_STATE_TTL_MS) {
    return activationWorkerStateCache.status;
  }
  const status = collectCodexAppServerCatalogState({
    catalogMtimeMs: () => fence.mtimeMs,
  });
  activationWorkerStateCache = {
    atMs,
    fenceIdentity: fence.identity,
    fenceMtimeMs: fence.mtimeMs,
    status,
  };
  return status;
}

/** Invalidate the combined catalog/native-config process observation after a write or Apply. */
export function resetCodexCatalogActivationWorkerStateCache(): void {
  activationWorkerStateCache = null;
}

/** Preserve the legacy catalog-only status without paying for a second process scan. */
export function catalogOnlyWorkerStateFromActivation(
  observed: CodexAppServerCatalogStatus,
): CodexAppServerCatalogStatus {
  return reclassifyCodexAppServerCatalogState(
    observed,
    fileMtimeMs(readCodexCatalogPath()),
  );
}

export function inspectCodexCatalogActivation(
  config: Readonly<CodexCommanderConfig>,
  workers: CodexAppServerCatalogStatus,
  disposition?: CatalogDisposition,
  authority?: CatalogConfigAuthoritySnapshot,
  artifactProof: CodexCatalogArtifactProof = authority
    ? inspectCodexCatalogArtifactProof(config)
    : "not-required",
  routingKind: CodexRoutingKind = getCodexRoutingKind(),
): CodexCatalogActivationState {
  const chosen = [...(config.subagentModels ?? [])];
  const protocol = config.multiAgentMode === "v1" || config.multiAgentMode === "v2"
    ? config.multiAgentMode
    : "default";
  const catalog = readCatalog(readCodexCatalogPath());
  const entries = catalog?.models ?? [];
  const v1 = projection(effectiveSubagentRoster(chosen, "v1", entries));
  const v2 = projection(effectiveSubagentRoster(chosen, "v2", entries));
  const active = protocol === "v1" ? v1 : protocol === "v2" ? v2 : defaultProjection(chosen, v1, v2);
  const catalogState = catalogStatus(
    catalog !== null,
    active,
    configuredOrderMatchesCatalog(chosen, active, entries),
    disposition,
    artifactProof,
  );
  const routing = routingState(config, routingKind);
  const worker = workerState(workers);
  const catalogReady = catalogState === "current" || catalogState === "degraded";
  const routingCanApply = routing.status === "current" || routing.status === "not_injected";
  // Apply owns the repairing sync before it ever considers a worker signal.
  // A pending/unproven catalog is therefore itself an Apply reason, not a gate
  // that strands the only action able to establish the artifact receipt.
  const required = !catalogReady
    || routing.status === "not_injected"
    || worker.status === "reload_required";
  const allowed = required && routingCanApply && worker.status !== "unknown";
  const reason = routing.status === "not_required"
    ? "integration-disabled"
    : routing.status === "external"
      ? "external-routing"
      : routing.status === "unknown"
        ? "routing-unknown"
        : !catalogReady
    ? "catalog-not-ready"
    : worker.status === "unknown"
      ? "worker-state-unknown"
      : routing.status === "not_injected"
        ? "routing-not-injected"
      : worker.status === "not_running"
        ? "no-workers"
        : worker.status === "current"
          ? "already-current"
          : "reload-required";

  return {
    schemaVersion: 1,
    desired: {
      revision: codexCatalogDesiredRevision(config, authority),
      chosen,
      protocol,
    },
    catalog: {
      status: catalogState,
      advertised: active.advertised,
      excluded: active.excluded,
      projections: { v1, v2 },
    },
    routing,
    workers: worker,
    apply: { required, allowed, reason },
  };
}

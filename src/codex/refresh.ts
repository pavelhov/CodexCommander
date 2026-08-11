import { existsSync } from "node:fs";
import { readCodexCatalogPath } from "./catalog";
import { primeBundledCatalogForGatherIfNeeded } from "./catalog/bundled";
import type { ComboCatalogOmission } from "./catalog/aggregation";
import type { CatalogQuality } from "./catalog/sync";
import { withConfigMutationLockSync } from "../config";
import type { CodexCommanderConfig } from "../types";
import {
  captureCatalogAdmissionSnapshot,
  CatalogAdmissionStaleConfigError,
  type CatalogConfigAuthoritySnapshot,
} from "./catalog-admission";
import { convergeCodexCatalog } from "./convergence";
import type { CatalogDisposition, ConfigGeneration } from "./convergence-types";

export interface CodexCatalogRefreshResult {
  added: number;
  path: string;
  catalogExists: boolean;
  catalogWritten: boolean;
  cacheSynced: boolean;
  comboOmissions: ComboCatalogOmission[];
  /** Where the routed rows in the committed catalog came from (`live` | `retained` | `native-only`). */
  catalogQuality: CatalogQuality;
  /** Routed rows rehydrated from the retained last-known-good snapshot this refresh. */
  rehydrated: number;
  /** Desired OFF observed under K during the catalog commit; no cache write either. */
  skippedReason?: "desired_disabled";
  /** Internal convergence evidence used by sync response projection. */
  catalogDisposition?: CatalogDisposition;
  /** Generation admitted by the canonical gather and required by subsequent injection. */
  admittedGeneration?: ConfigGeneration;
  /** Exact admitted config authority required by subsequent native publication. */
  admittedConfigAuthority?: CatalogConfigAuthoritySnapshot;
  /** Exact stale reason retained internally; management receives only the sanitized disposition. */
  staleReason?: "generation" | "home-selection" | "source-observation" | "process-local" | "target-identity" | "candidate-consumed";
  /** Admission could not bind config+generation; native injection must not continue. */
  catalogAdmissionFailed?: boolean;
}

export interface RefreshDeps {
  captureCatalogAdmissionSnapshot: typeof captureCatalogAdmissionSnapshot;
  convergeCodexCatalog: typeof convergeCodexCatalog;
  prepareConfigGeneration: () => void;
  /** Production-only orchestration: resolve/probe before the observe-only gather. */
  primeCatalogSource?: () => void;
  existsSync: typeof existsSync;
}

const defaultDeps: RefreshDeps = {
  captureCatalogAdmissionSnapshot,
  convergeCodexCatalog,
  // Existing installations may predate the cooperating generation database.
  // Preparing generation zero is orchestration, not a catalog candidate write.
  prepareConfigGeneration: () => { withConfigMutationLockSync(() => undefined); },
  // The canonical gather is deliberately observe-only. Settle the runtime and
  // bundled memo here so a fresh home still has a native template to converge.
  primeCatalogSource: primeBundledCatalogForGatherIfNeeded,
  existsSync,
};

/**
 * Rebuild Codex's on-disk model catalog and force Codex's models cache stale
 * when a catalog file exists. The cache must keep Codex's fetched_at/client_version
 * wrapper shape; writing the raw catalog back here makes app-server/TUI refreshes
 * inconsistent with the CLI models-manager cache path.
 */
export async function refreshCodexModelCatalog(
  config: CodexCommanderConfig,
  deps: RefreshDeps = defaultDeps,
): Promise<CodexCatalogRefreshResult> {
  let snapshot: ReturnType<typeof captureCatalogAdmissionSnapshot>;
  try {
    deps.prepareConfigGeneration();
    if (deps.primeCatalogSource) {
      // Reject a stale caller before probing. Priming can add persisted
      // runtime evidence, so this preflight is deliberately discarded.
      deps.captureCatalogAdmissionSnapshot(config);
      deps.primeCatalogSource();
    }
    snapshot = deps.captureCatalogAdmissionSnapshot(config);
  } catch (error) {
    const path = readCodexCatalogPath();
    const stale = error instanceof CatalogAdmissionStaleConfigError;
    return {
      added: 0,
      path,
      catalogExists: deps.existsSync(path),
      catalogWritten: false,
      cacheSynced: false,
      comboOmissions: [],
      catalogQuality: "native-only",
      rehydrated: 0,
      catalogDisposition: stale
        ? { status: "skipped", reason: "stale", retryable: true }
        : { status: "skipped", reason: "busy", retryable: true },
      ...(stale ? { staleReason: "generation" as const } : {}),
      catalogAdmissionFailed: true,
    };
  }
  const converged = await deps.convergeCodexCatalog(snapshot, {
    action: "converge",
    scope: "catalog",
    reason: "api-sync",
    mode: "explicit",
    deadlineMs: 1_000,
  });
  const projected = converged.projection;
  return {
    added: projected.added,
    path: projected.path,
    catalogExists: deps.existsSync(projected.path),
    catalogWritten: projected.catalogWritten,
    cacheSynced: projected.cacheSynced,
    comboOmissions: [...projected.comboOmissions],
    catalogQuality: projected.catalogQuality,
    rehydrated: projected.rehydrated,
    catalogDisposition: converged.catalogRefresh,
    admittedGeneration: projected.admittedGeneration,
    admittedConfigAuthority: projected.admittedConfigAuthority,
    ...(projected.staleReason ? { staleReason: projected.staleReason } : {}),
  };
}

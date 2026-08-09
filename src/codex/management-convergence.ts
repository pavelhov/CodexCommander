import type { CodexCommanderConfig } from "../types";
import { captureCatalogAdmissionSnapshot } from "./catalog-admission";
import { convergeCodexCatalog } from "./convergence";
import type {
  CatalogDisposition,
  CatalogOnlyOutcome,
  CodexObservedState,
  ConvergeCodex,
  ProjectCatalogOnlyOutcomeInput,
} from "./convergence-types";

function notEvaluatedObserved(): CodexObservedState {
  return {
    aggregate: "not-evaluated",
    isApplied: null,
    desired: "unknown",
    converged: null,
    authority: { service: "unknown", externalProvider: null },
    surfaces: {
      config: "not-evaluated",
      profile: "not-evaluated",
      catalog: "not-evaluated",
      cache: "not-evaluated",
      journal: "not-evaluated",
      provenance: {
        state: "not-evaluated",
        nativeGeneration: null,
        currentTxId: null,
      },
    },
  };
}

function unexpectedCatalogFailure(commitBegan: boolean): CatalogDisposition {
  return {
    status: "failed",
    reason: "disk",
    phase: commitBegan ? "commit" : "gather",
    retryable: false,
    partialWrite: commitBegan,
  };
}

function admissionFailure(error: unknown): CatalogDisposition {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("config generation is busy") || message.includes("config generation is database")) {
    return { status: "skipped", reason: "busy", retryable: true };
  }
  return unexpectedCatalogFailure(false);
}

/** Project catalog work into the shared no-change/not-evaluated outcome shape. */
export function projectCatalogOnlyOutcome({
  changed,
  catalogRefresh,
}: ProjectCatalogOnlyOutcomeInput): CatalogOnlyOutcome {
  return {
    kind: "catalog-only",
    changed,
    observed: notEvaluatedObserved(),
    catalogRefresh,
  };
}

/**
 * Bind the management callback's exact config authority to a catalog-only
 * funnel. This module is intentionally not re-exported by a public Codex facade.
 */
export function createManagementConvergeCodex(
  config: Readonly<CodexCommanderConfig>,
): ConvergeCodex {
  const retainedConfig = config;
  return async request => {
    let commitBegan = false;
    try {
      if (request.scope !== "catalog" || request.action !== "converge") {
        return projectCatalogOnlyOutcome({
          changed: false,
          catalogRefresh: unexpectedCatalogFailure(false),
        });
      }
      const snapshot = captureCatalogAdmissionSnapshot(retainedConfig);
      const result = await convergeCodexCatalog(snapshot, request, {
        onCommitBegin: () => { commitBegan = true; },
      });
      return projectCatalogOnlyOutcome(result);
    } catch (error) {
      return projectCatalogOnlyOutcome({
        changed: false,
        catalogRefresh: commitBegan ? unexpectedCatalogFailure(true) : admissionFailure(error),
      });
    }
  };
}

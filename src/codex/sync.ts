import { currentExternalCodexModelProvider, injectCodexConfig } from "./inject";
import { printProjectCodexConfigWarnings, groupProjectCodexConfigWarningsByPath, type ProjectCodexConfigWarning } from "./project-config-warnings";
import { refreshCodexModelCatalog, type CodexCatalogRefreshResult } from "./refresh";
import { applyProxyEnv, loadConfig } from "../config";
import type { CodexCommanderConfig } from "../types";
import { collectOrcaCodexHomeDiagnostic } from "./home";
import { summarizeComboCatalogOmissions, type ComboCatalogOmission } from "./catalog/aggregation";
import { shouldSyncCodexOnStart } from "./desired-state";
import { admitCodexWrite, type CodexAdmission } from "./admission";
import { hasRoutedCapableProviders, type CatalogQuality } from "./catalog/sync";
import { readCodexTransitionState } from "./transition-state";
import { reconcileJournal } from "./journal";

export interface CodexSyncResult {
  /** `skipped` is policy truth, never evidence that Codex was written. */
  status: "applied" | "skipped" | "refused";
  ok: boolean;
  skippedReason?: "desired_disabled" | "external_provider";
  /** Present when unattended convergence refused another service's native home. */
  authority?: "service-home";
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  catalogWritten: boolean;
  cacheSynced: boolean;
  /**
   * Where the routed rows in the active Codex catalog came from: `live` (gathered
   * from providers), `retained` (rehydrated from the CodexCommander-owned last-known-good
   * snapshot), or `native-only` (no CodexCommander-routed rows). `native-only` while
   * routed providers are configured carries an actionable `warning`.
   */
  catalogQuality: CatalogQuality;
  /** Routed rows rehydrated from the retained last-known-good snapshot this sync. */
  rehydrated: number;
  message: string;
  warning?: string;
  comboOmissions?: ComboCatalogOmission[];
  nativeSubagentDefaultsWarning?: string;
  projectConfigWarnings?: ProjectCodexConfigWarning[];
  projectConfigGrouped?: { path: string; issues: string[]; bypass: string }[];
}

type CodexSyncAdmission = Extract<CodexAdmission, { kind: "refused" }> | { readonly kind: "admitted" };

interface CodexSyncDeps {
  refreshCodexModelCatalog: typeof refreshCodexModelCatalog;
  injectCodexConfig: typeof injectCodexConfig;
  /** The sync entry only needs this admission's service-home verdict. */
  admitCodexWrite?: () => CodexSyncAdmission;
  /**
   * Production prepares the current coordinator before catalog publication.
   * Optional so pure unit seams never resolve or create a real user-home DB.
   */
  prepareCodexTransitionState: typeof readCodexTransitionState;
  currentExternalCodexModelProvider?: typeof currentExternalCodexModelProvider;
  collectCodexHomeDiagnostic?: typeof collectOrcaCodexHomeDiagnostic;
  /**
   * Production recovery boundary. Optional so isolated sync tests with fully
   * synthetic files never inspect the host journal unless they opt in.
   */
  reconcileJournal?: typeof reconcileJournal;
}

const defaultDeps: CodexSyncDeps = {
  refreshCodexModelCatalog,
  injectCodexConfig,
  prepareCodexTransitionState: readCodexTransitionState,
  reconcileJournal,
};

function coordinatorPreparationFailure(
  result: Exclude<ReturnType<typeof readCodexTransitionState>, { kind: "ready" }>,
): string {
  if (result.kind === "state-ambiguous") {
    return `Codex sync refused before catalog publication: ${result.message}`;
  }
  const detail = result.reason === "busy"
    ? "the transition coordinator is busy; retry the sync"
    : result.reason === "unsafe-path"
      ? "the transition coordinator path is unsafe"
      : "the transition coordinator is unavailable";
  return `Codex sync refused before catalog publication because ${detail}.`;
}

function reportCodexHomeTarget(
  log: Pick<Console, "log" | "error"> | null,
  collectDiagnostic: typeof collectOrcaCodexHomeDiagnostic,
): void {
  if (!log) return;
  const target = collectDiagnostic();
  log.log(`   Target Codex home: ${target.effectiveCodexHome}`);
  if (target.warning) {
    log.error(`WARNING: ${target.warning}`);
    log.error(`Action: ${target.action}`);
  }
}

export async function syncModelsToCodex(
  port?: number,
  config: CodexCommanderConfig = loadConfig(),
  log: Pick<Console, "log" | "error"> | null = console,
  deps: CodexSyncDeps = defaultDeps,
): Promise<CodexSyncResult> {
  // `config` can be the server's startup object. The decision, however, is a
  // durable user switch and must be read again at this production boundary: a
  // PUT OFF while provider discovery is in flight cannot be allowed to commit
  // through an older captured object.
  if (!shouldSyncCodexOnStart(loadConfig())) {
    return {
      status: "skipped",
      skippedReason: "desired_disabled",
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "native-only",
      rehydrated: 0,
      message: "Codex integration is OFF; no Codex config, catalog, cache, or history was changed.",
    };
  }
  const p = port ?? config.port ?? 10100;
  const externalProvider = (deps.currentExternalCodexModelProvider ?? currentExternalCodexModelProvider)();
  if (externalProvider) {
    const result = await deps.injectCodexConfig(p, config, {
      expectedExternalProvider: externalProvider,
    });
    log?.log(result.message);
    reportCodexHomeTarget(log, deps.collectCodexHomeDiagnostic ?? collectOrcaCodexHomeDiagnostic);
    return {
      status: result.success ? "skipped" : "refused",
      ...(result.success ? { skippedReason: "external_provider" as const } : {}),
      ok: result.success,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "native-only",
      rehydrated: 0,
      message: result.message,
      ...(result.nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning: result.nativeSubagentDefaultsWarning } : {}),
    };
  }

  // One canonical full sync owns legacy recovery. Startup, authenticated
  // /api/sync, browser Apply, CLI, and the native companion therefore converge
  // through the same fail-closed journal fence instead of relying on a prior
  // app-launch side effect. A false result is neutral: coordinator preparation
  // below remains the authority for a live, replaced, or ambiguous journal.
  deps.reconcileJournal?.();

  // Catalog gathering precedes direct injection and can itself write the native
  // catalog/cache. It therefore needs the same unattended service-home veto as
  // the injector, before it gets a chance to create any artifact. An explicitly
  // external model_provider is handled above: that path preserves its owner and
  // never enters catalog publication, so a machine-global service-manager claim
  // must not turn the no-op into a false ownership refusal.
  const admission = (deps.admitCodexWrite ?? admitCodexWrite)();
  if (admission.kind === "refused" && admission.authority === "service-home") {
    return {
      status: "refused",
      authority: "service-home",
      ok: false,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "native-only",
      rehydrated: 0,
      message: admission.message,
    };
  }

  /*
   * A first sync must establish the current coordinator while native Codex
   * state is still clean. Catalog refresh can write routed rows, and creating
   * the coordinator afterwards would correctly look like an attempted adoption
   * of uncoordinated residue. Refuse before applyProxyEnv or any catalog/cache
   * write when the current coordinator cannot be initialized and validated.
   */
  const prepared = deps.prepareCodexTransitionState();
  if (prepared.kind !== "ready") {
    return {
      status: "refused",
      ok: false,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "native-only",
      rehydrated: 0,
      message: coordinatorPreparationFailure(prepared),
    };
  }

  applyProxyEnv(config); // `ccx ensure`/`ccx sync` fetch provider models outside the server process
  let added = 0;
  let catalogPath: string | null = null;
  let catalogPathForInjection: string | null | undefined;
  let catalogExists = false;
  let catalogWritten = false;
  let cacheSynced = false;
  let catalogQuality: CatalogQuality = "native-only";
  let rehydrated = 0;
  let warning: string | undefined;
  let comboOmissions: ComboCatalogOmission[] = [];
  let admittedGeneration: CodexCatalogRefreshResult["admittedGeneration"];
  let admittedConfigAuthority: CodexCatalogRefreshResult["admittedConfigAuthority"];
  let staleGeneration = false;
  let catalogAdmissionFailed = false;
  let catalogConvergenceNotCommitted = false;
  let catalogConvergenceChanged = false;

  try {
    const cat = await deps.refreshCodexModelCatalog(config);
    added = cat.added;
    catalogExists = cat.catalogExists;
    catalogWritten = cat.catalogWritten;
    cacheSynced = cat.cacheSynced;
    catalogQuality = cat.catalogQuality;
    rehydrated = cat.rehydrated;
    admittedGeneration = cat.admittedGeneration;
    admittedConfigAuthority = cat.admittedConfigAuthority;
    staleGeneration = cat.staleReason === "generation";
    catalogAdmissionFailed = cat.catalogAdmissionFailed === true;
    catalogConvergenceChanged = (cat.catalogDisposition?.status === "committed"
      && cat.catalogDisposition.changed)
      || cat.catalogWritten
      || cat.cacheSynced;
    catalogConvergenceNotCommitted = cat.catalogDisposition !== undefined
      && cat.catalogDisposition.status !== "committed"
      // A proven absence is the established native-catalog fallback: continue
      // config/profile reconciliation with catalogPath=null. Every retryable or
      // failed canonical disposition remains a hard publication boundary.
      && !(cat.catalogDisposition.status === "skipped"
        && cat.catalogDisposition.reason === "catalog-unavailable");
    catalogPathForInjection = cat.catalogExists ? cat.path : null;
    catalogPath = catalogPathForInjection;
    comboOmissions = cat.comboOmissions ?? [];
    if (cat.added > 0) {
      log?.log(`   + ${cat.added} models appended to Codex catalog (${cat.path})`);
    } else if (cat.rehydrated > 0) {
      log?.log(`   + ${cat.rehydrated} routed models restored from the retained snapshot (${cat.path})`);
    } else if (!cat.catalogExists) {
      warning = "catalog sync skipped: no Codex catalog source found; keeping Codex's native catalog.";
      log?.error(warning);
    }
    if (cat.catalogDisposition?.status === "skipped" && cat.catalogDisposition.reason !== "catalog-unavailable") {
      const detail = cat.catalogDisposition.reason === "busy"
        ? "catalog convergence is busy; retry"
        : cat.catalogDisposition.reason === "stale"
          ? "catalog inputs changed during discovery; retry"
          : "catalog convergence was refused";
      const message = `catalog sync skipped: ${detail}.`;
      warning = warning ? `${warning} ${message}` : message;
      log?.error(message);
    } else if (cat.catalogDisposition?.status === "failed") {
      const message = `catalog sync skipped: catalog convergence failed during ${cat.catalogDisposition.phase}.`;
      warning = warning ? `${warning} ${message}` : message;
      log?.error(message);
    }
    // A native-only commit while routed providers are configured is a degraded
    // state, not a success: the live gather returned nothing and there was no
    // retained snapshot to fall back on. Surface it so the readiness gate and
    // /api/sync consumers can act instead of reporting a false fully-ready sync.
    if (
      cat.catalogQuality === "native-only"
      && (cat.catalogDisposition?.status === "committed" ? cat.catalogExists : cat.catalogWritten)
      && cat.skippedReason !== "desired_disabled"
      && hasRoutedCapableProviders(config)
    ) {
      const nativeOnly =
        "catalog sync produced no routed models (Codex left native-only) while routed providers are configured; "
        + "provider discovery returned nothing. Retry with 'ccx sync' or check provider connectivity.";
      warning = warning ? `${warning} ${nativeOnly}` : nativeOnly;
      log?.error(nativeOnly);
    }
    if (comboOmissions.length > 0) {
      // Individual omission lines already went through console.warn during gather;
      // keep a single summary on the sync logger to avoid duplicate stderr noise.
      const summary = summarizeComboCatalogOmissions(comboOmissions);
      log?.error(summary);
      warning = warning ? `${warning} ${summary}` : summary;
    }
  } catch (e) {
    warning = `catalog sync skipped: ${e instanceof Error ? e.message : String(e)}`;
    log?.error(warning);
    // The historical injected refresh seam may deliberately throw and still
    // exercise native config/profile reconciliation. Production's canonical
    // funnel must never turn an unexpected catalog failure into an unadmitted
    // native publish.
    if (deps.refreshCodexModelCatalog === refreshCodexModelCatalog) {
      catalogAdmissionFailed = true;
    }
  }

  if (staleGeneration) {
    if (!shouldSyncCodexOnStart(loadConfig())) {
      return {
        status: "skipped",
        skippedReason: "desired_disabled",
        ok: true,
        added: 0,
        catalogPath: null,
        catalogExists: false,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "native-only",
        rehydrated: 0,
        message: "Codex integration is OFF; no Codex config, catalog, cache, or history was changed.",
      };
    }
    const message = "Codex configuration changed during catalog discovery; no stale catalog or Codex config was published. Retry the sync.";
    log?.error(message);
    return {
      status: "refused",
      ok: false,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "native-only",
      rehydrated: 0,
      message,
    };
  }
  if (catalogAdmissionFailed) {
    const message = "Codex catalog admission could not bind the current configuration; no Codex config was published. Retry the sync.";
    log?.error(message);
    return {
      status: "refused",
      ok: false,
      added,
      catalogPath,
      catalogExists,
      catalogWritten,
      cacheSynced,
      catalogQuality,
      rehydrated,
      message,
      ...(warning ? { warning } : {}),
      ...(comboOmissions.length > 0 ? { comboOmissions } : {}),
    };
  }
  if (catalogConvergenceNotCommitted) {
    if (!shouldSyncCodexOnStart(loadConfig())) {
      return {
        status: "skipped",
        skippedReason: "desired_disabled",
        ok: true,
        added: 0,
        catalogPath: null,
        catalogExists: false,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "native-only",
        rehydrated: 0,
        message: "Codex integration is OFF; no Codex config, catalog, cache, or history was changed.",
      };
    }
    const message = "Codex catalog convergence did not commit; no Codex config was published. Retry the sync.";
    log?.error(message);
    return {
      status: "refused",
      ok: false,
      added,
      catalogPath,
      catalogExists,
      catalogWritten,
      cacheSynced,
      catalogQuality,
      rehydrated,
      message,
      ...(warning ? { warning } : {}),
      ...(comboOmissions.length > 0 ? { comboOmissions } : {}),
    };
  }

  const result = await deps.injectCodexConfig(p, config, {
    catalogPath: catalogPathForInjection,
    ...(admittedConfigAuthority ? { expectedConfigAuthority: admittedConfigAuthority } : {}),
    ...(admittedGeneration ? { expectedConfigGeneration: admittedGeneration } : {}),
  });
  if (result.status === "skipped") {
    const message = catalogConvergenceChanged
      ? "Codex integration turned OFF after catalog convergence; catalog changes from this sync were published, but native Codex config was not written."
      : result.message;
    return {
      status: "skipped",
      // The apply direction's only under-lock policy skip is desired OFF.
      skippedReason: "desired_disabled",
      ok: true,
      added,
      catalogPath,
      catalogExists,
      catalogWritten,
      cacheSynced,
      catalogQuality,
      rehydrated,
      message,
      ...(warning ? { warning } : {}),
      ...(comboOmissions.length > 0 ? { comboOmissions } : {}),
    };
  }
  if (result.status === "stale") {
    return {
      status: "refused",
      ok: false,
      added,
      catalogPath,
      catalogExists,
      catalogWritten,
      cacheSynced,
      catalogQuality,
      rehydrated,
      message: result.message,
      ...(warning ? { warning } : {}),
      ...(comboOmissions.length > 0 ? { comboOmissions } : {}),
    };
  }
  log?.log(result.message);
  reportCodexHomeTarget(log, deps.collectCodexHomeDiagnostic ?? collectOrcaCodexHomeDiagnostic);
  const projectConfigWarnings = printProjectCodexConfigWarnings(log, { cwd: process.cwd() });
  return {
    status: "applied",
    ok: result.success,
    added,
    catalogPath,
    catalogExists,
    catalogWritten,
    cacheSynced,
    catalogQuality,
    rehydrated,
    message: result.message,
    ...(warning ? { warning } : {}),
    ...(comboOmissions.length > 0 ? { comboOmissions } : {}),
    ...(result.nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning: result.nativeSubagentDefaultsWarning } : {}),
    ...(projectConfigWarnings.length > 0 ? {
      projectConfigWarnings,
      projectConfigGrouped: groupProjectCodexConfigWarningsByPath(projectConfigWarnings),
    } : {}),
  };
}

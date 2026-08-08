import { currentExternalCodexModelProvider, injectCodexConfig } from "./inject";
import { printProjectCodexConfigWarnings, groupProjectCodexConfigWarningsByPath, type ProjectCodexConfigWarning } from "./project-config-warnings";
import { refreshCodexModelCatalog } from "./refresh";
import { applyProxyEnv, loadConfig } from "../config";
import type { OcxConfig } from "../types";
import { collectOrcaCodexHomeDiagnostic } from "./home";
import { summarizeComboCatalogOmissions, type ComboCatalogOmission } from "./catalog/aggregation";
import { shouldSyncCodexOnStart } from "./desired-state";
import { admitCodexWrite, type CodexAdmission } from "./admission";
import { hasRoutedCapableProviders, type CatalogQuality } from "./catalog/sync";

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
   * from providers), `retained` (rehydrated from the OpenCodex-owned last-known-good
   * snapshot), or `native-only` (no OpenCodex-routed rows). `native-only` while
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
  currentExternalCodexModelProvider?: typeof currentExternalCodexModelProvider;
  collectCodexHomeDiagnostic?: typeof collectOrcaCodexHomeDiagnostic;
}

const defaultDeps: CodexSyncDeps = {
  refreshCodexModelCatalog,
  injectCodexConfig,
};

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
  config: OcxConfig = loadConfig(),
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

  applyProxyEnv(config); // `ocx ensure`/`ocx sync` fetch provider models outside the server process
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

  try {
    const cat = await deps.refreshCodexModelCatalog(config);
    added = cat.added;
    catalogExists = cat.catalogExists;
    catalogWritten = cat.catalogWritten;
    cacheSynced = cat.cacheSynced;
    catalogQuality = cat.catalogQuality;
    rehydrated = cat.rehydrated;
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
    // A native-only commit while routed providers are configured is a degraded
    // state, not a success: the live gather returned nothing and there was no
    // retained snapshot to fall back on. Surface it so the readiness gate and
    // /api/sync consumers can act instead of reporting a false fully-ready sync.
    if (
      cat.catalogQuality === "native-only"
      && cat.catalogWritten
      && cat.skippedReason !== "desired_disabled"
      && hasRoutedCapableProviders(config)
    ) {
      const nativeOnly =
        "catalog sync produced no routed models (Codex left native-only) while routed providers are configured; "
        + "provider discovery returned nothing. Retry with 'ocx sync' or check provider connectivity.";
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
  }

  const result = await deps.injectCodexConfig(p, config, { catalogPath: catalogPathForInjection });
  if (result.status === "skipped") {
    return {
      status: "skipped",
      // The apply direction's only under-lock policy skip is desired OFF.
      skippedReason: "desired_disabled",
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "native-only",
      rehydrated: 0,
      message: result.message,
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

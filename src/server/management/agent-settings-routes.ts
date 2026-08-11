import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import {
  catalogOnlyWorkerStateFromActivation,
  captureCodexCatalogDesiredSnapshot,
  codexCatalogDesiredRevision,
  collectCodexCatalogActivationWorkerState,
  inspectCodexCatalogActivation,
  resetCodexCatalogActivationWorkerStateCache,
} from "../../codex/catalog-activation";
import type { CatalogConfigAuthoritySnapshot } from "../../codex/catalog-admission";
import { resetCodexAppServerCatalogStateCache } from "../../codex/app-server-processes";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  loadConfig,
  multiAgentGuidanceEnabled,
  mutatePersistedConfig,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfigPreservingClaudeCode,
  subagentDefaultSyncEffective,
} from "../../config";
import {
  clearLoginState,
  getLoginStatus,
  isPublicOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
  upsertOAuthProvider,
} from "../../oauth";
import { removeCredential } from "../../oauth/store";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { routedSlug } from "../../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { resolveCodexHomeDir } from "../../codex/home";
import { readUsageEntries } from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../../usage/summary";
import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { getDebugLogEntries } from "../../lib/debug-log-buffer";
import { getInjectionDebugLogEntries } from "../../lib/injection-debug-log";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../../lib/debug-settings";
import type { CodexCommanderClaudeCodeConfig, CodexCommanderConfig, CodexCommanderCustomModel, CodexCommanderProviderConfig } from "../../types";
import { drainAndShutdown } from "../lifecycle";
import { filterRequestLogs, getRequestLogEntries, type RequestLogEntry } from "../request-log";
import { estimateComboCost, estimateRequestCost, normalizeCostTokens, tokensPerSecond } from "../../usage/cost";
import type { PersistedUsageAttempt } from "../../usage/log";
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels, fetchGrokCandidateModels, buildClaudeDesktopState } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { projectCatalogActivationForPrincipal } from "./catalog-activation-routes";

const GROK_APPLY_JOIN_MS = 120_000;
export const GROK_APPLY_TERMINAL_MS = 10 * 60_000;
const grokApplyEncoder = new TextEncoder();
let grokApplyFlight: { startedAt: number; promise: Promise<unknown>; bytes: number } | null = null;
let grokApplyHighWaterBytes = 0;
let grokApplyTestHooks: { now?: () => number; run?: () => Promise<unknown> } | null = null;

class GrokApplyBusyError extends Error {}

/** Persisted model selectors are bare native ids or one-slash Codex-facing ids. */
function isCanonicalPersistedModelSelector(value: string): boolean {
  const slash = value.indexOf("/");
  return slash < 0 || (slash > 0 && slash === value.lastIndexOf("/") && slash < value.length - 1);
}

/**
 * Mirror a durable desired-state transition onto the long-lived server snapshot.
 *
 * `setIntegrationEnabled` writes DISK only. The server reuses one `config` object
 * for every request, so leaving it stale makes the native GET report the opposite
 * of what was just persisted, and makes any later whole-snapshot save (the Desktop
 * profile PUT does exactly that) write the stale value back over the transition.
 * ON is the ABSENCE of the key, matching `setIntegrationEnabled`'s on-disk shape.
 */
function mirrorDesiredEnabledOntoSnapshot(config: CodexCommanderConfig, client: "claude-desktop", enabled: boolean): void {
  const integrations = { ...(config.clientIntegrations ?? {}) };
  if (enabled) delete integrations[client];
  else integrations[client] = false;
  if (Object.keys(integrations).length === 0) delete config.clientIntegrations;
  else config.clientIntegrations = integrations;
}

/**
 * Persist ONLY `claudeCode.desktopProfile`, field-scoped, against the CURRENT
 * on-disk config.
 *
 * `saveConfigPreservingClaudeCode(ctx.config)` writes the whole long-lived server
 * snapshot. On the apply path that snapshot still carries the `clientIntegrations`
 * it was loaded with, so a save right after `setIntegrationEnabled("claude-desktop",
 * true)` carried the stale OFF back over the enable and made the route cancel its
 * own apply. Mutating one field under the config-mutation lock cannot regress an
 * unrelated key another writer just committed.
 */
function persistDesktopProfileField(
  config: CodexCommanderConfig,
  desktopProfile: NonNullable<CodexCommanderConfig["claudeCode"]>["desktopProfile"],
): { ok: true } | { ok: false; reason: "missing" | "invalid" | "conflict" } {
  const outcome = mutatePersistedConfig(persisted => {
    persisted.claudeCode = { ...(persisted.claudeCode ?? {}), desktopProfile };
    return { changed: true, value: true };
  });
  // Only mirror into memory once the durable write actually landed; an
  // `unavailable` outcome must not leave the snapshot claiming a saved profile.
  if (outcome.status === "unavailable") return { ok: false, reason: outcome.reason };
  config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile };
  return { ok: true };
}

export function grokApplyFlightSnapshot(): { currentBytes: number; highWaterBytes: number; active: number } {
  return {
    currentBytes: grokApplyFlight?.bytes ?? 0,
    highWaterBytes: grokApplyHighWaterBytes,
    active: grokApplyFlight ? 1 : 0,
  };
}

function runGrokApplyFlight(): Promise<unknown> {
  const at = grokApplyTestHooks?.now?.() ?? Date.now();
  const current = grokApplyFlight;
  if (current) {
    const age = at - current.startedAt;
    if (age < GROK_APPLY_JOIN_MS) return current.promise;
    if (age <= GROK_APPLY_TERMINAL_MS) return Promise.reject(new GrokApplyBusyError("grok_apply_busy"));
    // A permanently hung operation must not monopolize the singleton forever. Its
    // eventual finally is identity-checked, so it cannot clear a replacement flight.
    if (grokApplyFlight === current) grokApplyFlight = null;
  }

  const flight = { startedAt: at, promise: Promise.resolve() as Promise<unknown>, bytes: 0 };
  flight.promise = (grokApplyTestHooks?.run ?? (async () => {
    const [{ syncGrokConfig }, { readRuntimePort }] = await Promise.all([
      import("../../grok/sync"),
      import("../../config"),
    ]);
    const currentConfig = loadConfig();
    const runtime = readRuntimePort(process.pid);
    const port = runtime?.port ?? currentConfig.port;
    const hostname = runtime?.hostname ?? currentConfig.hostname;
    flight.bytes = grokApplyEncoder.encode(JSON.stringify(currentConfig)).byteLength
      + grokApplyEncoder.encode(hostname ?? "").byteLength;
    grokApplyHighWaterBytes = Math.max(grokApplyHighWaterBytes, flight.bytes);
    return syncGrokConfig(port, currentConfig, hostname !== undefined ? { hostname } : {});
  }))().finally(() => {
    if (grokApplyFlight === flight) grokApplyFlight = null;
  });
  grokApplyFlight = flight;
  return flight.promise;
}

export function runGrokApplyFlightForTests(): Promise<unknown> {
  return runGrokApplyFlight();
}

export function setGrokApplyFlightTestHooks(
  hooks: { now?: () => number; run?: () => Promise<unknown> } | null,
): void {
  grokApplyTestHooks = hooks;
  grokApplyFlight = null;
  grokApplyHighWaterBytes = 0;
}
import type { ManagementContext } from "./context";

export async function handleAgentSettingsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, convergeCodexCatalog, syncClaudeAgentDefsBestEffort } = ctx;

  function resetCatalogWorkerObservation(): void {
    (deps.resetCodexAppServerCatalogStateCache ?? resetCodexAppServerCatalogStateCache)();
    resetCodexCatalogActivationWorkerStateCache();
  }

  function collectCatalogWorkerObservation() {
    if (deps.collectCodexAppServerCatalogState) {
      const catalogState = deps.collectCodexAppServerCatalogState();
      return { catalogState, activationWorkers: catalogState };
    }
    const activationWorkers = collectCodexCatalogActivationWorkerState();
    return {
      catalogState: catalogOnlyWorkerStateFromActivation(activationWorkers),
      activationWorkers,
    };
  }

  function currentCatalogDesired(): {
    config: CodexCommanderConfig;
    revision: string;
    authority?: CatalogConfigAuthoritySnapshot;
  } {
    if (deps.captureCatalogDesiredSnapshotForActivation) {
      return deps.captureCatalogDesiredSnapshotForActivation();
    }
    if (deps.loadConfigForCatalogActivation) {
      const current = deps.loadConfigForCatalogActivation();
      return { config: current, revision: codexCatalogDesiredRevision(current) };
    }
    // Direct route tests intentionally supply an in-memory persistence seam.
    if (deps.saveConfigPreservingClaudeCode) {
      return { config, revision: codexCatalogDesiredRevision(config) };
    }
    // Direct management tests can inject a pure convergence factory around an
    // intentionally non-persisted config fixture. Production never supplies
    // this seam, so malformed/unreadable persisted state still fails closed.
    if (deps.createManagementConvergeCodex) {
      return { config, revision: codexCatalogDesiredRevision(config) };
    }
    // A malformed or unreadable persisted config is not permission to report
    // the server's older startup snapshot as current. Let the management error
    // boundary surface the read failure instead of manufacturing false catalog
    // or activation state.
    return captureCodexCatalogDesiredSnapshot();
  }

  /** Best-effort Desktop 3P config auto-reconcile when providers change. */
  async function autoApplyDesktopBestEffort(): Promise<void> {
    try {
      const { claudeDesktopIntegrationEnabled } = await import("../../codex/desired-state");
      const admitted = loadConfig();
      if (!claudeDesktopIntegrationEnabled(admitted)) return;
      if (admitted.claudeCode?.desktopAutoApply === false) return;
      if (!admitted.claudeCode?.desktopProfile) return;
      const { inspectDesktop3pConfigLibrary, writeDesktop3pConfig } = await import("../../claude/desktop-3p");
      const beforeKind = inspectDesktop3pConfigLibrary({
        appliedFingerprint: admitted.claudeCode.desktopProfile.appliedFingerprint ?? null,
      }).kind;
      if (["not_installed", "no_owned_state", "foreign", "unsafe", "broken"].includes(beforeKind)) return;
      const { filterCatalogVisibleModels, desktopVisibleNativeSlugs } = await import("../../codex/catalog");
      const allModels = await (deps.fetchAllModels ?? fetchAllModels)(admitted);
      const current = loadConfig();
      // This is the real guard: the catalog await admits a concurrent explicit OFF.
      if (!claudeDesktopIntegrationEnabled(current)) return;
      if (current.claudeCode?.desktopAutoApply === false || !current.claudeCode?.desktopProfile) return;
      const afterKind = inspectDesktop3pConfigLibrary({
        appliedFingerprint: current.claudeCode.desktopProfile.appliedFingerprint ?? null,
      }).kind;
      if (["not_installed", "no_owned_state", "foreign", "unsafe", "broken"].includes(afterKind)) return;
      const routed = filterCatalogVisibleModels(allModels, current).map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow }));
      const result = (deps.writeDesktop3pConfig ?? writeDesktop3pConfig)(
        current.port ?? 10100,
        [...desktopVisibleNativeSlugs(current)],
        routed,
        current.apiKeys?.[0]?.key,
        "static",
        current.claudeCode.desktopProfile,
      );
      if (result.written && result.fingerprint) {
        current.claudeCode = { ...current.claudeCode, desktopProfile: { ...current.claudeCode.desktopProfile, appliedFingerprint: result.fingerprint, appliedAt: new Date().toISOString() } };
        saveConfigPreservingClaudeCode(current);
      }
    } catch { /* best-effort */ }
  }

  // multi_agent_v2 surface toggle. GET reports the flag + the agents.max_threads
  // boot conflict; PUT flips it via the official `codex features` CLI and RESYNCS
  // the catalog so multi-agent surface metadata stays fresh. The catalog build
  // itself never writes config — this endpoint is the only server-side mutation
  // surface for the flag.
  if (url.pathname === "/api/v2" && req.method === "GET") {
    const {
      isMultiAgentV2Enabled, hasAgentsMaxThreads, getLogicalMaxThreads,
      getAgentsEnabled, getAgentsMaxDepth, getSubagentDeveloperInstructions,
    } = await import("../../codex/features");
    const enabled = isMultiAgentV2Enabled();
    const current = currentCatalogDesired().config;
    return jsonResponse({
      enabled,
      agentsMaxThreadsConflict: enabled && hasAgentsMaxThreads(),
      maxConcurrentThreadsPerSession: getLogicalMaxThreads(),
      multiAgentMode: current.multiAgentMode ?? "default",
      multiAgentV2MessageDelivery: current.multiAgentV2MessageDelivery ?? "encrypted",
      agentsEnabled: getAgentsEnabled(),
      agentsMaxDepth: getAgentsMaxDepth(),
      subagentDeveloperInstructions: getSubagentDeveloperInstructions(),
      // max_depth is V1-only upstream; this is the global-flag statement, derived
      // server-side so no client can present it as an effective V2 limit.
      agentsMaxDepthAppliesWhenV2Disabled: !enabled,
    });
  }
  if (url.pathname === "/api/v2" && req.method === "PUT") {
    let body: {
      enabled?: unknown;
      maxConcurrentThreadsPerSession?: unknown;
      multiAgentMode?: unknown;
      multiAgentV2MessageDelivery?: unknown;
      agentsEnabled?: unknown;
      agentsMaxDepth?: unknown;
      subagentDeveloperInstructions?: unknown;
    };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const wantsFlag = body.enabled !== undefined;
    const wantsThreads = body.maxConcurrentThreadsPerSession !== undefined;
    const wantsMode = body.multiAgentMode !== undefined;
    const wantsMessageDelivery = body.multiAgentV2MessageDelivery !== undefined;
    const wantsAgentsEnabled = body.agentsEnabled !== undefined;
    const wantsMaxDepth = body.agentsMaxDepth !== undefined;
    const wantsSubagentInstructions = body.subagentDeveloperInstructions !== undefined;
    if (!wantsFlag && !wantsThreads && !wantsMode && !wantsMessageDelivery && !wantsAgentsEnabled && !wantsMaxDepth && !wantsSubagentInstructions) {
      return jsonResponse({ error: "body must set enabled, multiAgentMode, multiAgentV2MessageDelivery, maxConcurrentThreadsPerSession, agentsEnabled, agentsMaxDepth, and/or subagentDeveloperInstructions" }, 400);
    }
    if (wantsFlag && typeof body.enabled !== "boolean") return jsonResponse({ error: "body.enabled must be a boolean" }, 400);
    if (wantsMode && body.multiAgentMode !== "v1" && body.multiAgentMode !== "default" && body.multiAgentMode !== "v2") {
      return jsonResponse({ error: "body.multiAgentMode must be 'v1', 'default', or 'v2'" }, 400);
    }
    if (wantsMessageDelivery
      && body.multiAgentV2MessageDelivery !== null
      && body.multiAgentV2MessageDelivery !== "encrypted"
      && body.multiAgentV2MessageDelivery !== "plaintext") {
      return jsonResponse({ error: "body.multiAgentV2MessageDelivery must be 'encrypted', 'plaintext', or null" }, 400);
    }
    // null clears the active thread-limit key (same unset contract as the other
    // nullable fields below); an integer keeps the existing set behavior.
    if (wantsThreads && body.maxConcurrentThreadsPerSession !== null
        && (typeof body.maxConcurrentThreadsPerSession !== "number" || !Number.isInteger(body.maxConcurrentThreadsPerSession) || body.maxConcurrentThreadsPerSession < 1)) {
      return jsonResponse({ error: "body.maxConcurrentThreadsPerSession must be an integer >= 1, or null to clear it" }, 400);
    }
    // Validate every new field BEFORE any write, so each 400 leaves config untouched.
    // null unsets the key; "" is a meaningful value for instructions and must not be
    // collapsed by a falsy check. The i32 preflight mirrors the upstream Option<i32>
    // contract — out-of-range would otherwise surface as a mid-sequence write failure.
    if (wantsAgentsEnabled && body.agentsEnabled !== null && typeof body.agentsEnabled !== "boolean") {
      return jsonResponse({ error: "body.agentsEnabled must be a boolean or null" }, 400);
    }
    if (wantsMaxDepth && body.agentsMaxDepth !== null
        && (typeof body.agentsMaxDepth !== "number" || !Number.isInteger(body.agentsMaxDepth)
            || body.agentsMaxDepth < -2_147_483_648 || body.agentsMaxDepth > 2_147_483_647)) {
      return jsonResponse({ error: "body.agentsMaxDepth must be an integer within signed i32 range, or null" }, 400);
    }
    if (wantsSubagentInstructions && body.subagentDeveloperInstructions !== null && typeof body.subagentDeveloperInstructions !== "string") {
      return jsonResponse({ error: "body.subagentDeveloperInstructions must be a string or null" }, 400);
    }
    const mode = wantsMode ? body.multiAgentMode as "v1" | "default" | "v2" : undefined;
    const modeFlag = mode === "v2" ? true : mode === "v1" ? false : undefined;
    if (wantsFlag && modeFlag !== undefined && body.enabled !== modeFlag) {
      return jsonResponse({ error: `body.enabled conflicts with multiAgentMode '${mode}'` }, 400);
    }
    const {
      isMultiAgentV2Enabled, hasAgentsMaxThreads, getLogicalMaxThreads, transitionMultiAgentV2,
      getAgentsEnabled, getAgentsMaxDepth, getSubagentDeveloperInstructions,
      setAgentsEnabled, setAgentsMaxDepth, setSubagentDeveloperInstructions,
    } = await import("../../codex/features");
    const warnings: string[] = [];
    const requestedFlag = wantsFlag ? body.enabled as boolean : modeFlag;
    if (requestedFlag !== undefined || wantsThreads) {
    const targetFlag = requestedFlag ?? isMultiAgentV2Enabled();
    let toggle = deps.toggleCodexMultiAgentV2;
    if (!toggle) {
      const { runCodexFeaturesCommand } = await import("../../cli/v2");
      toggle = (enabled: boolean) => runCodexFeaturesCommand(enabled ? "enable" : "disable");
      }
      const result = transitionMultiAgentV2(targetFlag, toggle, {
        ...(wantsThreads ? { threadLimit: body.maxConcurrentThreadsPerSession as number | null } : {}),
      });
      if (!result.ok) return jsonResponse({ error: `multi_agent_v2 transition failed: ${result.error}` }, 502);
      if (result.changed && result.threadLimit !== null) warnings.push(`Thread limit ${result.threadLimit} preserved for ${targetFlag ? "v2" : "v1"}.`);
    }
    if (wantsMode || wantsMessageDelivery) {
      const applyRequestedConfigFields = (current: CodexCommanderConfig): boolean => {
        let changed = false;
        if (wantsMode) {
          const next = mode === "default" ? undefined : mode;
          if (current.multiAgentMode !== next) changed = true;
          if (next === undefined) delete current.multiAgentMode;
          else current.multiAgentMode = next;
        }
        if (wantsMessageDelivery) {
          const next = body.multiAgentV2MessageDelivery === "plaintext" ? "plaintext" as const : undefined;
          if (current.multiAgentV2MessageDelivery !== next) changed = true;
          if (next === undefined) delete current.multiAgentV2MessageDelivery;
          else current.multiAgentV2MessageDelivery = next;
        }
        return changed;
      };
      if (deps.saveConfigPreservingClaudeCode) {
        applyRequestedConfigFields(config);
        deps.saveConfigPreservingClaudeCode(config);
      } else {
        const persisted = mutatePersistedConfig(current => ({
          changed: applyRequestedConfigFields(current),
          value: {
            multiAgentMode: current.multiAgentMode,
            multiAgentV2MessageDelivery: current.multiAgentV2MessageDelivery,
          },
        }));
        if (persisted.status === "unavailable") {
          const status = persisted.reason === "conflict" ? 503 : 409;
          const response = jsonResponse({ error: `multi-agent policy could not be saved (${persisted.reason})` }, status);
          if (status === 503) response.headers.set("Retry-After", "1");
          return response;
        }
        if (persisted.value.multiAgentMode === undefined) delete config.multiAgentMode;
        else config.multiAgentMode = persisted.value.multiAgentMode;
        if (persisted.value.multiAgentV2MessageDelivery === undefined) delete config.multiAgentV2MessageDelivery;
        else config.multiAgentV2MessageDelivery = persisted.value.multiAgentV2MessageDelivery;
      }
      if (wantsMode) {
        warnings.push(`Multi-agent mode set to '${mode}'. Apply the catalog to Codex, then start a new task.`);
      }
      if (wantsMessageDelivery) {
        warnings.push("V2 task-message delivery changes affect subsequent requests. Start a new task instead of switching an active conversation.");
      }
    }
    // New-key scalar writes: each writer is individually atomic, so apply them in
    // sequence after the transition. A failure here is a persistence failure (the
    // writers' ok:false result or a throw from the underlying atomic write helper),
    // reported as 502 naming the failed key plus the writes that already landed.
    // NOTE: do not name that helper literally here — tests/grok-writer-boundary.test.ts
    // asserts this route file contains no direct write primitive, and matches on the
    // symbol name even inside a comment.
    const scalarWrites: Array<{ field: string; run: () => { ok: true; changed: boolean } | { ok: false; error: string } }> = [];
    if (wantsAgentsEnabled) scalarWrites.push({ field: "agentsEnabled", run: () => setAgentsEnabled(body.agentsEnabled as boolean | null) });
    if (wantsMaxDepth) scalarWrites.push({ field: "agentsMaxDepth", run: () => setAgentsMaxDepth(body.agentsMaxDepth as number | null) });
    if (wantsSubagentInstructions) scalarWrites.push({ field: "subagentDeveloperInstructions", run: () => setSubagentDeveloperInstructions(body.subagentDeveloperInstructions as string | null) });
    const landed: string[] = [];
    for (const write of scalarWrites) {
      try {
        const result = write.run();
        if (!result.ok) {
          return jsonResponse({ error: `writing ${write.field} failed: ${result.error}${landed.length > 0 ? ` (already applied: ${landed.join(", ")})` : ""}` }, 502);
        }
        landed.push(write.field);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: `writing ${write.field} failed: ${message}${landed.length > 0 ? ` (already applied: ${landed.join(", ")})` : ""}` }, 502);
      }
    }
    // Derived from fresh post-write readers (readConfigText is uncached): upstream
    // lets an enabled multi_agent_v2 feature override [agents].enabled = false, so
    // warn rather than reject — silently accepting would imply multi-agent is off.
    if (getAgentsEnabled() === false && isMultiAgentV2Enabled()) {
      warnings.push("agents.enabled = false has no effect while features.multi_agent_v2 is enabled; upstream keeps V2 active.");
    }
    const catalogAffectingChange = wantsMode || requestedFlag !== undefined;
    const activationAffectingChange = catalogAffectingChange
      || wantsThreads
      || wantsAgentsEnabled
      || wantsMaxDepth
      || wantsSubagentInstructions;
    const desiredForCatalog = currentCatalogDesired();
    const catalogRefresh = catalogAffectingChange
      ? await convergeCodexCatalog(desiredForCatalog.config)
      : { status: "skipped" as const, reason: "not-requested" as const, retryable: false };
    if (requestedFlag !== undefined && !wantsMode) {
      warnings.push("The collaboration protocol changed. Apply the catalog to Codex, then start a new task.");
    }
    if (activationAffectingChange) resetCatalogWorkerObservation();
    const { activationWorkers } = collectCatalogWorkerObservation();
    const responseDesired = currentCatalogDesired();
    const activation = inspectCodexCatalogActivation(
      responseDesired.config,
      activationWorkers,
      catalogRefresh,
      responseDesired.authority,
      deps.catalogArtifactProofForActivation?.(),
      deps.codexRoutingKindForActivation?.(),
    );
    const enabled = isMultiAgentV2Enabled();
    return jsonResponse({
      ok: true,
      enabled,
      agentsMaxThreadsConflict: enabled && hasAgentsMaxThreads(),
      maxConcurrentThreadsPerSession: getLogicalMaxThreads(),
      multiAgentMode: responseDesired.config.multiAgentMode ?? "default",
      multiAgentV2MessageDelivery: responseDesired.config.multiAgentV2MessageDelivery ?? "encrypted",
      agentsEnabled: getAgentsEnabled(),
      agentsMaxDepth: getAgentsMaxDepth(),
      subagentDeveloperInstructions: getSubagentDeveloperInstructions(),
      agentsMaxDepthAppliesWhenV2Disabled: !enabled,
      warnings,
      catalogRefresh,
      activation: projectCatalogActivationForPrincipal(activation, ctx.principal),
    });
  }

  // default_mode_request_user_input feature toggle (Codex Auth page). GET reads the
  // flag from $CODEX_HOME/config.toml; PUT flips it via the official `codex features`
  // CLI so the TOML edit stays upstream-owned and format-preserving.
  if (url.pathname === "/api/codex-auth/features/default-mode-request-user-input" && req.method === "GET") {
    const { isDefaultModeRequestUserInputEnabled, DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE_KEY } = await import("../../codex/features");
    return jsonResponse({
      enabled: isDefaultModeRequestUserInputEnabled(),
      key: DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE_KEY,
    });
  }
  if (url.pathname === "/api/codex-auth/features/default-mode-request-user-input" && req.method === "PUT") {
    let parsedBody: unknown;
    try {
      parsedBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return jsonResponse({ error: "body must be a JSON object" }, 400);
    }
    const body = parsedBody as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return jsonResponse({ error: "body.enabled must be a boolean" }, 400);
    const { isDefaultModeRequestUserInputEnabled, DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE_KEY } = await import("../../codex/features");
    const before = isDefaultModeRequestUserInputEnabled();
    let toggle = deps.toggleDefaultModeRequestUserInput;
    if (!toggle) {
      const { runCodexFeaturesCommand } = await import("../../cli/v2");
      toggle = (enabled: boolean) => runCodexFeaturesCommand(enabled ? "enable" : "disable", DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE_KEY);
    }
    let toggleError: string | null = null;
    try {
      toggle(body.enabled);
    } catch (error) {
      const err = error as { stderr?: unknown; message?: string };
      const raw = err.stderr;
      const stderrText = typeof raw === "string"
        ? raw.trim()
        : raw instanceof Uint8Array ? new TextDecoder().decode(raw).trim() : "";
      toggleError = stderrText || (err.message ?? String(error));
    }
    const enabled = isDefaultModeRequestUserInputEnabled();
    if (toggleError !== null || enabled !== body.enabled) {
      const reason = toggleError
        ?? `postcondition failed - the installed Codex build may not know the ${DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE_KEY} flag yet`;
      return jsonResponse({ error: `default_mode_request_user_input toggle failed: ${reason}` }, 502);
    }
    const warnings: string[] = [];
    if (enabled !== before) {
      warnings.push("Applies to new sessions; restart the Codex app or wait out its picker cache to see the change.");
    }
    return jsonResponse({ ok: true, enabled, changed: enabled !== before, warnings });
  }

  // Subagent prompt injection model: single native or routed model whose info is
  // dynamically injected into the v1 proactive prompt, plus an optional reasoning
  // effort the prompt tells the agent to pass to spawn_agent. GET returns the current
  // picks + available models/efforts; PUT sets or clears them.
  if (url.pathname === "/api/injection-model" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const { CODEX_REASONING_LEVELS } = await import("../../reasoning-effort");
    const nativeModels = listCatalogNativeSlugs()
      .filter(slug => !disabled.has(slug))
      .map(slug => ({ provider: "openai", model: slug, namespaced: slug }));
    const routedModels = uniqueCatalogModelsForPublicList(models)
      .map(m => ({ provider: m.provider, model: m.id, namespaced: catalogModelSlug(m) }))
      .filter(m => !disabled.has(m.namespaced));
    return jsonResponse({
      multiAgentGuidanceEnabled: multiAgentGuidanceEnabled(config),
      syncCodexSubagentDefaults: subagentDefaultSyncEffective(config),
      model: config.injectionModel ?? null,
      effort: config.injectionEffort ?? null,
      prompt: config.injectionPrompt ?? null,
      efforts: CODEX_REASONING_LEVELS.map(l => l.effort),
      available: [...nativeModels, ...routedModels],
    });
  }
  if (url.pathname === "/api/injection-model" && req.method === "PUT") {
    let parsedBody: unknown;
    try { parsedBody = await readManagementJsonBody(req); } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return jsonResponse({ error: "body must be a JSON object" }, 400);
    }
    const body = parsedBody as {
      multiAgentGuidanceEnabled?: unknown;
      syncCodexSubagentDefaults?: unknown;
      model?: unknown;
      effort?: unknown;
      prompt?: unknown;
    };
    const { isCodexReasoningEffort } = await import("../../reasoning-effort");

    let nextEnabled = config.multiAgentGuidanceEnabled;
    // Start from the effective state reported by GET. A stale hand-edited
    // `true` without a model must not spring back on during a model-only PUT.
    let nextSyncCodexSubagentDefaults = subagentDefaultSyncEffective(config);
    let nextModel = config.injectionModel;
    let nextEffort = config.injectionEffort;
    let nextPrompt = config.injectionPrompt;
    const previousSyncCodexSubagentDefaults = subagentDefaultSyncEffective(config);

    if ("multiAgentGuidanceEnabled" in body) {
      if (typeof body.multiAgentGuidanceEnabled !== "boolean") {
        return jsonResponse({ error: "multiAgentGuidanceEnabled must be a boolean" }, 400);
      }
      nextEnabled = body.multiAgentGuidanceEnabled;
    }
    if ("syncCodexSubagentDefaults" in body) {
      if (typeof body.syncCodexSubagentDefaults !== "boolean") {
        return jsonResponse({ error: "syncCodexSubagentDefaults must be a boolean" }, 400);
      }
      nextSyncCodexSubagentDefaults = body.syncCodexSubagentDefaults;
    }
    if ("model" in body) {
      if (body.model === null || body.model === "") nextModel = undefined;
      else if (typeof body.model === "string" && body.model.trim().length > 0) {
        const selector = body.model.trim();
        if (!isCanonicalPersistedModelSelector(selector)) {
          return jsonResponse({ error: "model must be a canonical selector or null" }, 400);
        }
        nextModel = selector;
      } else return jsonResponse({ error: "model must be a nonblank string or null" }, 400);
    }
    if ("effort" in body) {
      if (body.effort === null || body.effort === "") nextEffort = undefined;
      else if (typeof body.effort === "string" && isCodexReasoningEffort(body.effort)) {
        nextEffort = body.effort;
      } else {
        return jsonResponse({ error: `unknown reasoning effort "${String(body.effort)}"` }, 400);
      }
    }
    if ("prompt" in body) {
      if (typeof body.prompt === "string" && body.prompt.trim().length > 0) nextPrompt = body.prompt;
      else if (body.prompt === null || body.prompt === "") nextPrompt = undefined;
      else return jsonResponse({ error: "prompt must be a string or null" }, 400);
    }
    // Clearing the model always clears model-dependent settings before sync/effort gates.
    if (!nextModel) {
      nextEffort = undefined;
      nextSyncCodexSubagentDefaults = false;
    }
    if (body.syncCodexSubagentDefaults === true && !nextModel?.trim()) {
      return jsonResponse({ error: "syncCodexSubagentDefaults requires an injection model" }, 400);
    }
    if (nextSyncCodexSubagentDefaults && nextEffort !== undefined && !isCodexReasoningEffort(nextEffort)) {
      return jsonResponse({ error: "syncCodexSubagentDefaults requires a supported Codex reasoning effort" }, 400);
    }

    config.multiAgentGuidanceEnabled = nextEnabled;
    if (nextSyncCodexSubagentDefaults) config.syncCodexSubagentDefaults = true;
    else delete config.syncCodexSubagentDefaults;
    if (nextModel) config.injectionModel = nextModel;
    else delete config.injectionModel;
    if (nextEffort) config.injectionEffort = nextEffort;
    else delete config.injectionEffort;
    if (nextPrompt) config.injectionPrompt = nextPrompt;
    else delete config.injectionPrompt;

    saveConfigPreservingClaudeCode(config);
    const nativeDefaultsAffectingChange = "syncCodexSubagentDefaults" in body
      || (("model" in body || "effort" in body)
        && (previousSyncCodexSubagentDefaults || nextSyncCodexSubagentDefaults));
    let nativeDefaultsRefresh;
    let activation;
    if (nativeDefaultsAffectingChange) {
      const desired = currentCatalogDesired();
      try {
        const reconcile = deps.reconcileManagementNativeSubagentDefaults
          ?? (await import("../../codex/management-native-defaults"))
            .reconcileManagementNativeSubagentDefaults;
        nativeDefaultsRefresh = await reconcile(desired.config, desired.authority);
      } catch (error) {
        nativeDefaultsRefresh = {
          status: "failed" as const,
          retryable: false,
          message: error instanceof Error ? error.message : "Native Codex defaults could not be reconciled.",
        };
      }
      if (nativeDefaultsRefresh.status === "reconciled") resetCatalogWorkerObservation();
      const { activationWorkers } = collectCatalogWorkerObservation();
      const responseDesired = currentCatalogDesired();
      activation = inspectCodexCatalogActivation(
        responseDesired.config,
        activationWorkers,
        { status: "skipped", reason: "not-requested", retryable: false },
        responseDesired.authority,
        deps.catalogArtifactProofForActivation?.(),
        deps.codexRoutingKindForActivation?.(),
      );
    }
    return jsonResponse({
      ok: true,
      multiAgentGuidanceEnabled: multiAgentGuidanceEnabled(config),
      syncCodexSubagentDefaults: subagentDefaultSyncEffective(config),
      model: config.injectionModel ?? null,
      effort: config.injectionEffort ?? null,
      prompt: config.injectionPrompt ?? null,
      ...(nativeDefaultsRefresh ? { nativeDefaultsRefresh } : {}),
      ...(activation
        ? { activation: projectCatalogActivationForPrincipal(activation, ctx.principal) }
        : {}),
    });
  }

  // Hard reasoning-effort caps (implementation contract): a global ceiling and a
  // sub-agent-only ceiling, enforced per-request in handleResponses (src/server/effort-policy.ts).
  // Key semantics per field: absent -> unchanged; null/"" -> clear; ladder value -> set; else 400.
  if (url.pathname === "/api/effort-caps" && req.method === "GET") {
    const { CODEX_REASONING_LEVELS } = await import("../../reasoning-effort");
    return jsonResponse({
      effortCap: config.effortCap ?? null,
      subagentEffortCap: config.subagentEffortCap ?? null,
      efforts: CODEX_REASONING_LEVELS.map(l => l.effort),
    });
  }
  if (url.pathname === "/api/effort-caps" && req.method === "PUT") {
    let body: { effortCap?: unknown; subagentEffortCap?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { isCodexReasoningEffort } = await import("../../reasoning-effort");
    for (const key of ["effortCap", "subagentEffortCap"] as const) {
      if (!(key in body)) continue;
      const value = body[key];
      if (value === null || value === "") { delete config[key]; continue; }
      if (typeof value !== "string" || !isCodexReasoningEffort(value)) {
        return jsonResponse({ error: `unknown reasoning effort "${String(value)}"` }, 400);
      }
      config[key] = value;
    }
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({ ok: true, effortCap: config.effortCap ?? null, subagentEffortCap: config.subagentEffortCap ?? null });
  }

  // Subagent model picker: persist up to five requested quick picks. Codex advertises the first
  // five picker-visible catalog rows, so the response reports the protocol-aware projection rather
  // than implying every saved choice necessarily entered that window. PUT reprioritizes the
  // injected catalog so eligible chosen rows lead.
  if (url.pathname === "/api/subagent-models" && req.method === "GET") {
    const rosterDesired = currentCatalogDesired();
    const rosterConfig = rosterDesired.config;
    const models = await fetchAllModels(rosterConfig);
    const disabled = new Set(rosterConfig.disabledModels ?? []);
    // Native gpt (passthrough) are also valid subagent picks — they're picker-visible models in the
    // catalog, just buried by priority. List them first so the user can feature them over routed.
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const visibleRouted = [...new Set(models
      .filter(m => !disabled.has(catalogModelSlug(m)))
      .map(catalogModelSlug))];
    const available = [
      ...listCatalogNativeSlugs().filter(ns => !disabled.has(ns)),
      ...visibleRouted,
    ];
    // #857: let CLI/GUI show when a running Codex app-server keeps an older
    // in-memory catalog than the one on disk.
    const { catalogState, activationWorkers } = collectCatalogWorkerObservation();
    const activation = inspectCodexCatalogActivation(
      rosterConfig,
      activationWorkers,
      undefined,
      rosterDesired.authority,
      deps.catalogArtifactProofForActivation?.(),
      deps.codexRoutingKindForActivation?.(),
    );
    const response = jsonResponse({
      chosen: rosterConfig.subagentModels ?? [],
      available,
      catalogState,
      advertised: activation.catalog.advertised,
      excluded: activation.catalog.excluded,
      activation: projectCatalogActivationForPrincipal(activation, ctx.principal),
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (url.pathname === "/api/subagent-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!Array.isArray(body.models)) return jsonResponse({ error: "models must be an array" }, 400);
    if (body.models.length > 5) return jsonResponse({ error: "models must contain at most five selectors" }, 400);
    const chosen = body.models;
    if (chosen.some(model => typeof model !== "string" || model.trim().length === 0 || !isCanonicalPersistedModelSelector(model.trim()))) {
      return jsonResponse({ error: "models must contain canonical selectors" }, 400);
    }
    const canonicalChosen = chosen.map(model => (model as string).trim());
    if (new Set(canonicalChosen).size !== canonicalChosen.length) {
      return jsonResponse({ error: "models must not contain duplicate selectors" }, 400);
    }
    if (deps.saveConfigPreservingClaudeCode) {
      config.subagentModels = canonicalChosen;
      deps.saveConfigPreservingClaudeCode(config);
    } else {
      const persisted = mutatePersistedConfig(current => {
        const previous = current.subagentModels ?? [];
        const changed = previous.length !== canonicalChosen.length
          || previous.some((model, index) => model !== canonicalChosen[index]);
        current.subagentModels = [...canonicalChosen];
        return { changed, value: [...canonicalChosen] };
      });
      if (persisted.status === "unavailable") {
        const status = persisted.reason === "conflict" ? 503 : 409;
        const response = jsonResponse({ error: `subagent roster could not be saved (${persisted.reason})` }, status);
        if (status === 503) response.headers.set("Retry-After", "1");
        return response;
      }
      config.subagentModels = [...persisted.value];
    }
    // The field-scoped mutation rebases onto the newest persisted config. Build
    // from that same authority, not the server's older whole-config snapshot.
    const catalogDesired = currentCatalogDesired();
    const catalogRefresh = await convergeCodexCatalog(catalogDesired.config);
    await syncClaudeAgentDefsBestEffort();
    await autoApplyDesktopBestEffort();
    resetCatalogWorkerObservation();
    const { catalogState, activationWorkers } = collectCatalogWorkerObservation();
    const responseDesired = currentCatalogDesired();
    const responseConfig = responseDesired.config;
    const currentChosen = [...(responseConfig.subagentModels ?? [])];
    const superseded = currentChosen.length !== canonicalChosen.length
      || currentChosen.some((model, index) => model !== canonicalChosen[index]);
    const activation = inspectCodexCatalogActivation(
      responseConfig,
      activationWorkers,
      catalogRefresh,
      responseDesired.authority,
      deps.catalogArtifactProofForActivation?.(),
      deps.codexRoutingKindForActivation?.(),
    );
    return jsonResponse({
      ok: true,
      saved: true,
      ...(superseded ? { superseded: true, requested: canonicalChosen } : {}),
      applied: currentChosen,
      catalogRefresh,
      catalogState,
      advertised: activation.catalog.advertised,
      excluded: activation.catalog.excluded,
      activation: projectCatalogActivationForPrincipal(activation, ctx.principal),
    });
  }

  // Priority-ordered subagent model fallback chain for quota-aware spawn routing.
  if (url.pathname === "/api/subagent-model-fallback" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const visibleRouted = [...new Set(models
      .filter(m => !disabled.has(catalogModelSlug(m)))
      .map(catalogModelSlug))];
    const available = [
      ...listCatalogNativeSlugs().filter(ns => !disabled.has(ns)),
      ...visibleRouted,
    ];
    return jsonResponse({
      models: config.subagentModelFallback ?? [],
      pollMs: config.subagentModelFallbackPollMs ?? 60_000,
      available,
    });
  }
  if (url.pathname === "/api/subagent-model-fallback" && req.method === "PUT") {
    let body: { models?: unknown; pollMs?: unknown };
    try {
      body = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    let nextModels = config.subagentModelFallback;
    let nextPollMs = config.subagentModelFallbackPollMs;
    if ("models" in body) {
      if (!Array.isArray(body.models)) return jsonResponse({ error: "models must be an array" }, 400);
      const models: string[] = [];
      for (let i = 0; i < body.models.length; i++) {
        const entry = body.models[i];
        if (typeof entry !== "string" || entry.trim().length === 0) {
          return jsonResponse({
            error: `models[${i}] must be a non-empty string`,
            index: i,
            value: entry,
          }, 400);
        }
        if (!isCanonicalPersistedModelSelector(entry.trim())) {
          return jsonResponse({ error: `models[${i}] must be a canonical selector`, index: i, value: entry }, 400);
        }
        models.push(entry.trim());
      }
      nextModels = models.length > 0 ? models : undefined;
    }
    if ("pollMs" in body) {
      const pollMs = body.pollMs;
      if (pollMs === null || pollMs === "") nextPollMs = undefined;
      else if (typeof pollMs === "number" && Number.isInteger(pollMs) && pollMs >= 5_000 && pollMs <= 600_000) {
        nextPollMs = pollMs;
      } else {
        return jsonResponse({ error: "pollMs must be an integer between 5000 and 600000" }, 400);
      }
    }
    if (nextModels !== undefined) config.subagentModelFallback = nextModels;
    else delete config.subagentModelFallback;
    if (nextPollMs !== undefined) config.subagentModelFallbackPollMs = nextPollMs;
    else delete config.subagentModelFallbackPollMs;
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({
      ok: true,
      models: config.subagentModelFallback ?? [],
      pollMs: config.subagentModelFallbackPollMs ?? 60_000,
    });
  }

  // Grok Build: view of the managed fence in ~/.grok/config.toml plus the candidate
  // catalog and the user's selection. The fence itself is still written ONLY by
  // injectGrokConfig — the write routes below carry no path/host/port/body input.
  if (url.pathname === "/api/grok" && req.method === "GET") {
    try {
      const { readGrokStatus } = await import("../../grok/status");
      // `candidates` is the full visible catalog the fence WOULD carry, so the page can
      // show a switch for a model the user has already excluded. Aliases come from
      // `status.models` — the writer's output — never computed client-side.
      return jsonResponse({
        ...readGrokStatus(),
        candidates: await fetchGrokCandidateModels(config),
        excluded: config.grokExcludedModels ?? [],
      });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  // Writes CONFIG only. ~/.grok/config.toml is still written exclusively by
  // injectGrokConfig, through the apply route below — this route cannot touch that file.
  if (url.pathname === "/api/grok/selection" && req.method === "PUT") {
    let body: { excluded?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const raw = body.excluded;
    if (!Array.isArray(raw) || raw.some(entry => typeof entry !== "string" || entry.length === 0)) {
      return jsonResponse({ error: "excluded must be an array of model ids" }, 400);
    }
    // Dedupe + sort so the stored list is stable, and cap it so a hostile client
    // cannot grow config.json without bound.
    const excluded = [...new Set(raw as string[])].sort();
    if (excluded.length > 2000) return jsonResponse({ error: "excluded list is too large" }, 400);
    if (excluded.length === 0) delete config.grokExcludedModels;
    else config.grokExcludedModels = excluded;
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({ ok: true, excluded });
  }

  // Re-runs the SAME sync the CLI runs. All guards (no-grok-home, non-loopback refusal,
  // orphaned marker, backup, alias reservation) live in injectGrokConfig and are not
  // duplicated here. Accepts no body: every input comes from persisted state.
  if (url.pathname === "/api/grok/apply" && req.method === "POST") {
    try {
      const result = await runGrokApplyFlight() as Awaited<ReturnType<typeof import("../../grok/sync")["syncGrokConfig"]>>;
      // A policy skip (non-loopback, no ~/.grok) is not a server error: report it as a
      // result the page can explain rather than a 500 the user cannot act on.
      return jsonResponse({
        ok: result.ok,
        changed: result.changed,
        message: result.message,
        ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
      }, result.ok ? 200 : 500);
    } catch (error) {
      if (error instanceof GrokApplyBusyError) return jsonResponse({ error: "grok_apply_busy" }, 409);
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  // Claude Desktop profile: routed/native model assignments for the Desktop 3P config.
  if (url.pathname === "/api/claude-desktop" && req.method === "GET") {
    try {
      const state = await buildClaudeDesktopState(config, undefined, deps.fetchAllModels);
      const runtimePort = Number(url.port) || config.port;
      return jsonResponse({ ...state, port: runtimePort });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
  if (url.pathname === "/api/claude-desktop" && req.method === "PUT") {
    let body: { profile?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    try {
      const { parseDesktopProfile, reconcileDesktopProfile } = await import("../../claude/desktop-profile");
      const parsed = parseDesktopProfile(body.profile);
      const current = await buildClaudeDesktopState(config, undefined, deps.fetchAllModels);
      for (const model of current.models.filter(item => !item.available)) {
        const before = current.profile.assignments[model.route];
        const after = parsed.assignments[model.route];
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          throw new Error(`현재 사용할 수 없는 모델은 옮길 수 없습니다: ${model.route}`);
        }
      }
      for (const family of ["opus", "fable", "sonnet", "haiku"] as const) {
        const nextDefault = parsed.defaults[family];
        const target = nextDefault ? current.models.find(model => model.route === nextDefault) : undefined;
        if (target && !target.available && current.profile.defaults[family] !== nextDefault) {
          throw new Error(`현재 사용할 수 없는 모델은 기본값으로 지정할 수 없습니다: ${nextDefault}`);
        }
      }
      const state = await buildClaudeDesktopState(config, parsed, deps.fetchAllModels);
      config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: reconcileDesktopProfile(state.profile, state.models) };
      saveConfigPreservingClaudeCode(config);
      const saved = await buildClaudeDesktopState(config, undefined, deps.fetchAllModels);
      const runtimePort = Number(url.port) || config.port;
      return jsonResponse({ ok: true, ...saved, port: runtimePort });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
  if (url.pathname === "/api/claude-desktop/apply" && req.method === "POST") {
    try {
      let parsed: unknown;
      try {
        parsed = await readManagementJsonBody(req);
      } catch (error) {
        rethrowManagementBodyTooLarge(error);
        return jsonResponse({ error: "invalid JSON body" }, 400);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return jsonResponse({ error: "body must be an object" }, 400);
      }
      const body = parsed as { mode?: unknown; profile?: unknown };
      const unknownField = Object.keys(body).find(field => field !== "mode" && field !== "profile");
      if (unknownField) return jsonResponse({ error: `unknown Claude Desktop apply field: ${unknownField}` }, 400);
      if (body.mode !== "static" && body.mode !== "hybrid" && body.mode !== "discovery") {
        return jsonResponse({ error: "mode must be static, hybrid, or discovery" }, 400);
      }
      const mode = body.mode;

      // #859: a delegated CLI apply carries the profile it just saved — the
      // daemon's own config can be older, and building state from it would
      // apply (and persist) the stale profile over the newer one.
      let profileOverride: Parameters<typeof buildClaudeDesktopState>[1];
      if (body.profile !== undefined) {
        const { parseDesktopProfile } = await import("../../claude/desktop-profile");
        try {
          profileOverride = parseDesktopProfile(body.profile);
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }

      const { setIntegrationEnabled, claudeDesktopIntegrationEnabled } = await import("../../codex/desired-state");
      const desired = setIntegrationEnabled("claude-desktop", true);
      if (!desired.ok) return jsonResponse({ error: desired.message }, desired.retryable ? 409 : 500);
      // Disk now says ON; the reused server snapshot must agree, or the native
      // GET reports OFF and a later whole-snapshot save undoes this transition.
      mirrorDesiredEnabledOntoSnapshot(config, "claude-desktop", true);
      const state = await buildClaudeDesktopState(config, profileOverride, deps.fetchAllModels);
      // `setIntegrationEnabled` above wrote desired ON to DISK; it does not touch
      // this long-lived server snapshot. Saving the snapshot wholesale would carry
      // its stale `clientIntegrations` back over that write and turn the enable
      // action into an immediate self-cancelling OFF — the guard below would then
      // refuse the apply it was asked to perform. Persist ONLY the profile field.
      const profileSaved = persistDesktopProfileField(config, state.profile);
      if (!profileSaved.ok) {
        return jsonResponse({
          error: `Claude Desktop profile could not be saved (${profileSaved.reason}); nothing was applied.`,
          saved: false,
          applied: false,
        }, profileSaved.reason === "conflict" ? 409 : 500);
      }
      const { writeDesktop3pConfig } = await import("../../claude/desktop-3p");
      const { desktopVisibleNativeSlugs } = await import("../../codex/catalog");
      const routed = state.models
        .filter(model => model.available && !model.route.startsWith("native/"))
        .map(model => {
          const slash = model.route.indexOf("/");
          return { provider: model.route.slice(0, slash), id: model.route.slice(slash + 1), contextWindow: model.contextWindow };
        });
      // State construction can await catalog work; never write from the stale
      // config captured before that await if another request turned Desktop off.
      const latest = loadConfig();
      if (!claudeDesktopIntegrationEnabled(latest)) {
        return jsonResponse({
          error: "Claude Desktop apply was cancelled because the desired state changed to off.",
          code: "claude_desktop_apply_skipped",
          reason: "desired_state_changed",
          desiredEnabled: false,
          saved: true,
          applied: false,
        }, 409);
      }
      const result = (deps.writeDesktop3pConfig ?? writeDesktop3pConfig)(
        Number(url.port) || latest.port,
        [...desktopVisibleNativeSlugs(latest)],
        routed,
        latest.apiKeys?.[0]?.key,
        mode,
        state.profile,
      );
      if (!result.written) return jsonResponse({ error: result.reason ?? "Claude Desktop apply failed", saved: true, path: result.path }, 500);
      // Persist applied fingerprint + timestamp so GUI can show saved-vs-applied state.
      if (result.fingerprint) {
        // The Desktop write already landed, so a failed bookkeeping save is not
        // an apply failure: report the miss instead of claiming a clean apply.
        const marked = persistDesktopProfileField(config, {
          ...state.profile,
          appliedFingerprint: result.fingerprint,
          appliedAt: new Date().toISOString(),
        });
        if (!marked.ok) {
          return jsonResponse({
            ok: true,
            applied: true,
            saved: false,
            path: result.path,
            fingerprint: result.fingerprint,
            warning: `Claude Desktop was applied, but the applied marker was not saved (${marked.reason}).`,
          });
        }
      }
      return jsonResponse({ ok: true, saved: true, applied: true, path: result.path, fingerprint: result.fingerprint });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  // Desktop applied-state + health status.
  if (url.pathname === "/api/claude-desktop/status" && req.method === "GET") {
    try {
      const { claudeDesktopIntegrationEnabled } = await import("../../codex/desired-state");
      const { inspectDesktop3pConfigLibrary } = await import("../../claude/desktop-3p");
      const persisted = loadConfig();
      const savedFingerprint = persisted.claudeCode?.desktopProfile?.appliedFingerprint ?? null;
      const observed = inspectDesktop3pConfigLibrary({ appliedFingerprint: savedFingerprint });
      const desiredEnabled = claudeDesktopIntegrationEnabled(persisted);
      const applied = observed.kind === "gateway_ours" || observed.kind === "gateway_drifted";
      const stale = observed.kind === "gateway_drifted";
      const { getDesktopHealth } = await import("../../claude/desktop-health");
      const health = getDesktopHealth();
      return jsonResponse({
        desiredEnabled,
        installed: observed.kind !== "not_installed",
        observedKind: observed.kind,
        applied,
        appliedAt: persisted.claudeCode?.desktopProfile?.appliedAt ?? null,
        savedFingerprint,
        onDiskFingerprint: observed.fingerprint ?? null,
        configPath: observed.selectedProfilePath,
        stale,
        // Tri-state by ID match, independent of profile health: null =
        // undeterminable (no/unreadable metadata or no appliedId); a readable
        // appliedId with no owned entry is a KNOWN false. Predates the inspector.
        activeProfile: observed.ownedProfileActive,
        drift: desiredEnabled ? !applied || stale : applied || observed.kind === "unsafe",
        driftReason: desiredEnabled ? (!applied ? "desired_on_not_current" : stale ? "profile_drift" : null) : (applied ? "desired_off_gateway_selected" : null),
        health,
      });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  // Claude Code inbound settings (GUI "Claude ON" toggle + Claude page).
  if (url.pathname === "/api/claude-code" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const { claudeCodeAlias, claudeCodeNativeAlias } = await import("../../claude/alias");
    const { buildClaudeContextWindows, effectiveModelEnv } = await import("../../claude/context-windows");
    const { visibleNativeSlugs } = await import("../../codex/catalog");
    const disabled = new Set(config.disabledModels ?? []);
    const isDisabled = (provider: string, id: string) => disabled.has(routedSlug(provider, id));
    const available = [
      ...listCatalogNativeSlugs().filter(ns => !disabled.has(ns)),
      ...models.filter(m => !isDisabled(m.provider, m.id)).map(catalogModelSlug),
    ];
    const aliases: { id: string; display_name: string }[] = [];
    for (const slug of listCatalogNativeSlugs()) {
      // Readable CLI-surface alias with hash fallback (implementation contract / audit 051 #2) —
      // the same shared helper the /v1/models ?ids=cli path uses.
      if (!disabled.has(slug)) aliases.push({ id: claudeCodeNativeAlias(slug), display_name: `${slug} (native)` });
    }
    for (const m of models) {
      if (isDisabled(m.provider, m.id)) continue;
      aliases.push({ id: claudeCodeAlias(m.provider, m.id), display_name: `${m.id} (${m.provider})` });
    }
    const contextWindows = buildClaudeContextWindows([...visibleNativeSlugs(config)], models);
    const webSearchOverride = config.claudeCode?.webSearchSidecar;
    const visionOverride = config.claudeCode?.visionSidecar;
    // Auto is a RESOLUTION, recomputed per request — never stored state. Detection is
    // daemon-side, so it cannot see a key exported only in the user's terminal; the
    // GUI labels the badge with detectionScope for exactly that reason.
    const { defaultAuthDetectDeps, detectClaudeAuth, ownAdmissionTokens } = await import("../../claude/auth-detect");
    const { authModeIntent, resolveClaudeAuthMode } = await import("../../claude/auth-mode");
    const authDetection = detectClaudeAuth(defaultAuthDetectDeps(process.env, ownAdmissionTokens(config)));
    const resolvedAuthMode = resolveClaudeAuthMode(config, authDetection);
    return jsonResponse({
      enabled: config.claudeCode?.enabled !== false,
      // Three-state intent (implementation contract): an absent key is AUTO, not
      // subscription. The old coercion made every save convert an untouched auto config
      // into a sticky manual subscription with no way back.
      authMode: authModeIntent(config),
      /** Does the CodexCommander dummy marker get injected — NOT a claim about native auth. */
      markerMode: resolvedAuthMode.markerMode,
      authModeOrigin: resolvedAuthMode.origin,
      ...(resolvedAuthMode.foundBy ? { authFoundBy: resolvedAuthMode.foundBy } : {}),
      authDetectionUnknown: authDetection.presence === "unknown",
      // Separate axis: with an admission key configured a token is injected regardless
      // of mode, so the GUI must never present subscription as "no token anywhere".
      admissionKeyActive: (config.apiKeys?.length ?? 0) > 0,
      detectionScope: "daemon",
      smallFastModel: config.claudeCode?.smallFastModel ?? "",
      modelMap: config.claudeCode?.modelMap ?? {},
      systemEnv: config.claudeCode?.systemEnv === true,
      autoConnectSupported: process.platform === "darwin",
      autoContext: config.claudeCode?.autoContext !== false,
      autoCompactWindow: config.claudeCode?.autoCompactWindow ?? null,
      blockedSkills: config.claudeCode?.blockedSkills ?? null,
      injectAgents: config.claudeCode?.injectAgents !== false,
      ...(webSearchOverride && Object.keys(webSearchOverride).length > 0
        ? { webSearchSidecar: { backend: webSearchOverride.backend, model: webSearchOverride.model } }
        : {}),
      ...(visionOverride && Object.keys(visionOverride).length > 0
        ? { visionSidecar: { backend: visionOverride.backend, model: visionOverride.model } }
        : {}),
      fastMode: config.fastMode,
      contextWindows,
      effectiveModelEnv: effectiveModelEnv(config.claudeCode, contextWindows),
      available,
      aliases,
      port: config.port,
    });
  }
  if (url.pathname === "/api/claude-code" && req.method === "PUT") {
    let parsedBody: unknown;
    try { parsedBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const isPlainObject = (value: unknown): value is Record<string, unknown> => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    };
    if (!isPlainObject(parsedBody)) return jsonResponse({ error: "body must be an object" }, 400);
    const body = parsedBody as { enabled?: unknown; authMode?: unknown; smallFastModel?: unknown; modelMap?: unknown; systemEnv?: unknown; fastMode?: unknown; autoContext?: unknown; autoCompactWindow?: unknown; blockedSkills?: unknown; injectAgents?: unknown; webSearchSidecar?: unknown; visionSidecar?: unknown };
    const allowedFields = new Set([
      "enabled", "authMode", "smallFastModel", "modelMap", "systemEnv", "fastMode",
      "autoContext", "autoCompactWindow", "blockedSkills", "injectAgents",
      "webSearchSidecar", "visionSidecar",
    ]);
    const unknownField = Object.keys(parsedBody).find(field => !allowedFields.has(field));
    if (unknownField) return jsonResponse({ error: `unknown Claude Code setting: ${unknownField}` }, 400);
    for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
      const section = body[field];
      if (section === undefined || section === null) continue;
      if (!isPlainObject(section)) return jsonResponse({ error: `${field} must be an object or null` }, 400);
      if (section.backend !== undefined && section.backend !== null
        && section.backend !== "openai" && section.backend !== "anthropic") {
        return jsonResponse({ error: `${field}.backend must be openai, anthropic, or null` }, 400);
      }
      if (section.model !== undefined && typeof section.model !== "string") {
        return jsonResponse({ error: `${field}.model must be a string` }, 400);
      }
    }
    const next = { ...(config.claudeCode ?? {}) };
    for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
      const section = body[field];
      if (section === undefined) continue;
      if (section === null || Object.keys(section as Record<string, unknown>).length === 0) {
        delete next[field];
        continue;
      }
      const requested = section as { backend?: "openai" | "anthropic" | null; model?: string };
      const override: NonNullable<CodexCommanderClaudeCodeConfig[typeof field]> = { ...next[field] };
      if (requested.backend === null) delete override.backend;
      else if (requested.backend !== undefined) override.backend = requested.backend;
      if (requested.model === "") delete override.model;
      else if (requested.model !== undefined) override.model = requested.model;
      if (Object.keys(override).length > 0) next[field] = override;
      else delete next[field];
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return jsonResponse({ error: "enabled must be a boolean" }, 400);
      next.enabled = body.enabled;
    }
    if (body.authMode !== undefined) {
      // Three-state intent: "proxy" and "subscription" are stored literally and stick
      // forever; "auto" DELETES the key so the mode is resolved from detected Claude
      // auth on every launch. The 260720 round-trip contract survives as a superset —
      // storing "subscription" literally is also backward-safe, since older readers
      // only ever recognised "proxy".
      if (body.authMode !== "proxy" && body.authMode !== "subscription" && body.authMode !== "auto") {
        return jsonResponse({ error: "authMode must be \"auto\", \"proxy\", or \"subscription\"" }, 400);
      }
      if (body.authMode === "auto") delete next.authMode;
      else next.authMode = body.authMode;
    }
    if (body.systemEnv !== undefined) {
      if (typeof body.systemEnv !== "boolean") return jsonResponse({ error: "systemEnv must be a boolean" }, 400);
      next.systemEnv = body.systemEnv;
    }
    if (body.autoContext !== undefined) {
      // Default-on boolean (implementation contract 020): true = drop the key, false = store.
      if (typeof body.autoContext !== "boolean") return jsonResponse({ error: "autoContext must be a boolean" }, 400);
      if (body.autoContext) delete next.autoContext;
      else next.autoContext = false;
    }
    if (body.injectAgents !== undefined) {
      // Default-on boolean (implementation contract 070): true = drop the key, false = store.
      if (typeof body.injectAgents !== "boolean") return jsonResponse({ error: "injectAgents must be a boolean" }, 400);
      if (body.injectAgents) delete next.injectAgents;
      else next.injectAgents = false;
    }
    if (body.autoCompactWindow !== undefined) {
      // null resets to the 350k default; otherwise the binary-accepted range
      // 100_000..1_000_000 (2.1.207 pSo/yDs — audit 021 #1).
      if (body.autoCompactWindow === null) {
        delete next.autoCompactWindow;
      } else if (typeof body.autoCompactWindow !== "number" || !Number.isInteger(body.autoCompactWindow) || body.autoCompactWindow < 100_000 || body.autoCompactWindow > 1_000_000) {
        return jsonResponse({ error: "autoCompactWindow must be an integer between 100000 and 1000000, or null" }, 400);
      } else {
        next.autoCompactWindow = body.autoCompactWindow;
      }
    }
    if (body.blockedSkills !== undefined) {
      // null resets to the default (["claude-api"]); an array (possibly empty = off)
      // must contain non-empty strings (implementation contract).
      if (body.blockedSkills === null) {
        delete next.blockedSkills;
      } else if (!Array.isArray(body.blockedSkills) || body.blockedSkills.some(s => typeof s !== "string" || s.trim() === "")) {
        return jsonResponse({ error: "blockedSkills must be an array of non-empty strings, or null" }, 400);
      } else {
        next.blockedSkills = (body.blockedSkills as string[]).map(s => s.trim());
      }
    }
    if (body.fastMode !== undefined) {
      if (body.fastMode !== true && body.fastMode !== false && body.fastMode !== null) {
        return jsonResponse({ error: "fastMode must be true, false, or null" }, 400);
      }
      config.fastMode = body.fastMode === null ? undefined : body.fastMode;
    }
    for (const field of ["smallFastModel"] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (typeof value !== "string") return jsonResponse({ error: `${field} must be a string` }, 400);
      if (value.trim() === "") delete next[field];
      else next[field] = value.trim();
    }
    if (body.modelMap !== undefined) {
      if (body.modelMap === null) {
        delete next.modelMap;
      } else {
        if (!isPlainObject(body.modelMap)) {
          return jsonResponse({ error: "modelMap must be an object of string->string, or null" }, 400);
        }
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.modelMap)) {
          if (typeof v !== "string" || k.trim() === "" || v.trim() === "") {
            return jsonResponse({ error: "modelMap entries must be non-empty strings" }, 400);
          }
          map[k.trim()] = v.trim();
        }
        if (Object.keys(map).length > 0) next.modelMap = map;
        else delete next.modelMap;
      }
    }
    config.claudeCode = next;
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
    save(config);
    const warnings: string[] = [];
    // authMode changes must reconcile the injected system env too: switching back to
    // Subscription has to remove the CodexCommander-owned dummy ANTHROPIC_AUTH_TOKEN
    // (audit R1 blocker #1/#2, implementation contract).
    if (body.systemEnv !== undefined || body.authMode !== undefined) {
      try {
        await applySystemEnvToggle(config, config.port);
      } catch (err) {
        warnings.push(`Failed to apply system environment setting: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Keep the file-backed live registry symmetric: OFF prunes immediately, while
    // ON and config changes restore definitions without requiring a restart.
    await syncClaudeAgentDefsBestEffort();
    return jsonResponse({ ok: true, enabled: next.enabled !== false, warnings });
  }
  return null;
}

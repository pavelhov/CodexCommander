import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../codex/catalog";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  multiAgentGuidanceEnabled,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfigPreservingClaudeCode,
} from "../config";
import {
  clearLoginState,
  getLoginStatus,
  isPublicOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
  upsertOAuthProvider,
} from "../oauth";
import { OAuthMutationBusyError, removeCredential } from "../oauth/store";
import { providerDestinationResolvedError } from "../lib/destination-policy";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../oauth/key-providers";
import { deriveProviderPresets } from "../providers/derive";
import { providerCodexAccountMode } from "../providers/registry";
import { routedSlug, slugEquals } from "../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { clearThreadAccountMap } from "../codex/routing";
import { primeCodexPoolQuotas } from "../codex/auth-api";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../providers/context-cap";
import { resolveCodexHomeDir } from "../codex/home";
import { readUsageEntries } from "../usage/log";
import { getUsageDebugLogEntries } from "../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../usage/summary";
import { stripCodexRuntimeProviderFields } from "../codex/auth-context";
import { getProviderRegistryEntry } from "../providers/registry";
import { getDebugLogEntries } from "../lib/debug-log-buffer";
import { getInjectionDebugLogEntries } from "../lib/injection-debug-log";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../lib/debug-settings";
import type { OcxClaudeCodeConfig, OcxClaudeDesktopProfile, OcxConfig, OcxCustomModel, OcxProviderConfig } from "../types";
import type { DesktopProfileModel } from "../claude/desktop-profile";
import { drainAndShutdown } from "./lifecycle";
import { filterRequestLogs, getRequestLogEntries, type RequestLogEntry } from "./request-log";
import { estimateComboCost, estimateRequestCost, normalizeCostTokens, tokensPerSecond } from "../usage/cost";
import type { PersistedUsageAttempt } from "../usage/log";
import { isAllowedManagementOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "./auth-cors";
import { applySystemEnvToggle } from "./system-env";

import type { ManagementApiDeps } from "./management/context";
import { handleConfigRoutes } from "./management/config-routes";
import { handleLogsUsageRoutes } from "./management/logs-usage-routes";
import { handleProviderRoutes } from "./management/provider-routes";
import { handleModelRoutes } from "./management/model-routes";
import { handleAgentSettingsRoutes } from "./management/agent-settings-routes";
import { handleOauthAccountRoutes } from "./management/oauth-account-routes";
import { handleComboRoutes } from "./management/combo-routes";
import { handleSystemRoutes } from "./management/system-routes";
import { handleActivityRoutes } from "./management/activity-routes";
import { handleSidebarRoutes } from "./management/sidebar-routes";
import { handleIntegrationRoutes } from "./management/integration-routes";
import type { ManagementContext } from "./management/context";
export type { ManagementApiDeps } from "./management/context";
import { fetchAllModels } from "./management/shared";
import { CatalogGatherBusyError } from "../codex/catalog/provider-fetch";
import { managementBodyTooLargeResponse } from "./management/body";

// installed npm version instead of a stale hardcode.
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

export async function handleManagementAPI(req: Request, url: URL, config: OcxConfig, deps: ManagementApiDeps = {}): Promise<Response | null> {
  if (!isAllowedManagementOrigin(req, config)) {
    return jsonResponse({ error: "cross-origin request blocked" }, 403, req, config);
  }
  // Management bodies are small JSON (provider names, key ids, settings). Reject oversized
  // payloads before any handler buffers them — the data plane has its own decompression cap.
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      return jsonResponse({ error: "request body too large" }, 413, req, config);
    }
  }
  async function refreshCodexCatalogBestEffort(): Promise<void> {
    if (deps.refreshCodexCatalog) await deps.refreshCodexCatalog();
    else {
      try {
        const { refreshCodexModelCatalog } = await import("../codex/refresh");
        await refreshCodexModelCatalog(config);
      } catch {
        /* catalog absent */
      }
    }
    try {
      const { reconcileOpencodeIntegrationIfEnabled } = await import("./management/integration-routes");
      await reconcileOpencodeIntegrationIfEnabled(config, Number(url.port) || config.port);
    } catch {
      // Optional client integration: catalog/config mutations must still succeed
      // when OpenCode is absent or its user-owned config needs attention.
    }
  }

  async function syncClaudeAgentDefsBestEffort(): Promise<void> {
    try {
      const { injectClaudeAgentDefs } = await import("../claude/agents-inject");
      if (config.claudeCode?.enabled === false || config.claudeCode?.injectAgents === false) {
        injectClaudeAgentDefs(config, {});
        return;
      }
      try {
        const [models, { buildClaudeContextWindows }, { visibleNativeSlugs }] = await Promise.all([
          fetchAllModels(config),
          import("../claude/context-windows"),
          import("../codex/catalog"),
        ]);
        injectClaudeAgentDefs(config, buildClaudeContextWindows([...visibleNativeSlugs(config)], models));
      } catch {
        // Keep routes available through a provider-discovery blip. A later
        // launch-time sync restores any context markers missing from this pass.
        injectClaudeAgentDefs(config, {});
      }
    } catch { /* best-effort */ }
  }
  const ctx: ManagementContext = { req, url, config, deps, refreshCodexCatalogBestEffort, syncClaudeAgentDefsBestEffort };
  let routed: Response | null;
  try {
    routed = (await handleConfigRoutes(ctx))
    ??     (await handleLogsUsageRoutes(ctx))
    ??     (await handleProviderRoutes(ctx))
    ??     (await handleIntegrationRoutes(ctx))
    ??     (await handleModelRoutes(ctx))
    ??     (await handleAgentSettingsRoutes(ctx))
    ??     (await handleOauthAccountRoutes(ctx))
    ??     (await handleComboRoutes(ctx))
    ??     (await handleActivityRoutes(ctx))
    ??     (await handleSystemRoutes(ctx))
      ?? (await handleSidebarRoutes(ctx));
  } catch (error) {
    const tooLarge = managementBodyTooLargeResponse(error, req, config);
    if (tooLarge) return tooLarge;
    if (error instanceof OAuthMutationBusyError) {
      return new Response(JSON.stringify({ error: { type: "server_error", code: "oauth_mutation_busy", message: error.message } }), {
        status: 503,
        headers: { "content-type": "application/json", "Retry-After": "1" },
      });
    }
    if (!(error instanceof CatalogGatherBusyError)) throw error;
    return new Response(JSON.stringify({ error: { type: "server_error", code: "catalog_busy", message: error.message } }), {
      status: 503,
      headers: { "content-type": "application/json", "Retry-After": "1" },
    });
  }
  if (routed) return routed;

  if (url.pathname === "/api/stop" && req.method === "POST") {
    const { prepareExplicitProxyShutdown } = await import("../cli/proxy-lifecycle");
    const prepared = prepareExplicitProxyShutdown();
    if (!prepared.accepted) {
      return jsonResponse(
        { success: false, message: prepared.message },
        prepared.status,
        req,
        config,
      );
    }
    setTimeout(async () => {
      await drainAndShutdown(undefined, config.shutdownTimeoutMs ?? 5000);
      process.exit(0);
    }, 200);
    return jsonResponse({ success: prepared.success, message: prepared.message });
  }

  if (url.pathname.startsWith("/api/codex-auth/")) {
    const { handleCodexAuthAPI } = await import("../codex/auth-api");
    const { ConfigMutationLockError } = await import("../config");
    const { CodexCredentialRefreshLockTimeoutError } = await import("../codex/account-store");
    try {
      return await handleCodexAuthAPI(req, url, config);
    } catch (error) {
      // Credential writers remap ConfigMutationLockError to CodexCredentialRefreshLockTimeoutError;
      // treat both as the same retryable busy response.
      if (error instanceof ConfigMutationLockError || error instanceof CodexCredentialRefreshLockTimeoutError) {
        return jsonResponse(
          { error: "Configuration is busy; retry shortly", code: "CONFIG_MUTATION_LOCK_UNAVAILABLE" },
          503,
          req,
          config,
        );
      }
      throw error;
    }
  }

  return null;
}


export { buildClaudeDesktopState, fetchAllModels } from "./management/shared";

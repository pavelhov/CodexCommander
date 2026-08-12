import { readFileSync } from "node:fs";
import type { CodexCommanderConfig } from "../types";
import { OAuthMutationBusyError } from "../oauth/store";
import { drainAndShutdown } from "./lifecycle";
import { isAllowedManagementOrigin, jsonResponse } from "./auth-cors";
import { validateProxyLifecycleLockLease } from "./proxy-start-lock";
import {
  acquireProxyLifecycleAuthority,
  type AcquireProxyLifecycleAuthorityOptions,
  type ProxyLifecycleAuthority,
} from "./proxy-lifecycle-authority";
import { readProxyLifecycleLockLeaseHeaders } from "./proxy-lifecycle-protocol";

import type { ManagementApiDeps } from "./management/context";
import { handleConfigRoutes } from "./management/config-routes";
import { handleLogsUsageRoutes } from "./management/logs-usage-routes";
import { handleRequestHistoryRoutes } from "./management/request-history-routes";
import { handleRoutingAnalyticsRoutes } from "./management/routing-analytics-routes";
import { handleRoutingProfileRoutes } from "./management/routing-profile-routes";
import { handleProviderRoutes } from "./management/provider-routes";
import { handleModelRoutes } from "./management/model-routes";
import { handleAgentSettingsRoutes } from "./management/agent-settings-routes";
import { handleOauthAccountRoutes } from "./management/oauth-account-routes";
import { handleComboRoutes } from "./management/combo-routes";
import { handleSystemRoutes } from "./management/system-routes";
import { handleActivityRoutes } from "./management/activity-routes";
import { handleCatalogActivationRoutes } from "./management/catalog-activation-routes";
import { handleIntegrationRoutes } from "./management/integration-routes";
import { handleOpencodeIntegrationRoutes } from "./management/opencode-integration-routes";
import { handleNativeIntegrationRoutes } from "./management/native-integration-routes";
import type { ManagementContext } from "./management/context";
import type { ManagementPrincipal } from "./management-auth";
export type { ManagementApiDeps } from "./management/context";
import { fetchAllModels } from "./management/shared";
import { CatalogGatherBusyError } from "../codex/catalog/provider-fetch";
import type { CatalogDisposition, ConvergeCodex } from "../codex/convergence-types";
import { managementBodyTooLargeResponse } from "./management/body";

// Read the package version instead of carrying a stale hardcode.
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

function stopLifecycleAuthorityOptions(): AcquireProxyLifecycleAuthorityOptions {
  return { includeStart: true, waitTimeoutMs: 8_000 };
}

function isCatalogDisposition(value: unknown): value is CatalogDisposition {
  if (!value || typeof value !== "object" || !("status" in value)) return false;
  const disposition = value as Record<string, unknown>;
  if (disposition.status === "committed") {
    return typeof disposition.changed === "boolean"
      && typeof disposition.degraded === "boolean"
      && Array.isArray(disposition.notices)
      && disposition.notices.every(notice => notice === "provider-auth" || notice === "provider-network" || notice === "fallback");
  }
  if (disposition.status === "skipped") {
    return ["not-requested", "catalog-unavailable", "busy", "stale", "refused"].includes(String(disposition.reason))
      && typeof disposition.retryable === "boolean";
  }
  if (disposition.status === "failed") {
    return ["provider-auth", "provider-network", "disk"].includes(String(disposition.reason))
      && (disposition.phase === "gather" || disposition.phase === "commit")
      && typeof disposition.retryable === "boolean"
      && typeof disposition.partialWrite === "boolean";
  }
  return false;
}

const managementConvergenceBindings = new WeakMap<object, Readonly<{
  factory: (config: Readonly<CodexCommanderConfig>) => ConvergeCodex;
  converge: ConvergeCodex;
}>>();

export async function handleManagementAPI(
  req: Request,
  url: URL,
  config: CodexCommanderConfig,
  deps: ManagementApiDeps = {},
  principal?: ManagementPrincipal,
): Promise<Response | null> {
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
  async function convergeCodexCatalog(
    configOverride: Readonly<CodexCommanderConfig> = config,
  ): Promise<CatalogDisposition> {
    let convergenceInvoked = false;
    let managementConvergeCodex: ConvergeCodex | undefined;
    try {
      if (!managementConvergeCodex) {
        const factory = deps.createManagementConvergeCodex
          ?? (await import("../codex/management-convergence")).createManagementConvergeCodex;
        if (typeof factory !== "function") throw new TypeError("Catalog convergence factory is unavailable.");
        let binding = managementConvergenceBindings.get(configOverride as object);
        if (!binding || binding.factory !== factory) {
          const created = factory(configOverride);
          if (typeof created !== "function") throw new TypeError("Catalog convergence factory returned no function.");
          binding = { factory, converge: created };
          managementConvergenceBindings.set(configOverride as object, binding);
        }
        managementConvergeCodex = binding.converge;
      }
      const { createCatalogConvergeRequest } = await import("../codex/catalog-admission");
      convergenceInvoked = true;
      const outcome = await managementConvergeCodex(createCatalogConvergeRequest({ deadlineMs: 1_000 }));
      if (!outcome || outcome.kind !== "catalog-only" || !isCatalogDisposition(outcome.catalogRefresh)) {
        throw new TypeError("Catalog convergence returned an invalid outcome.");
      }
      const disposition = outcome.catalogRefresh;
      try {
        const { reconcileOpencodeIntegrationIfEnabled } = await import("./management/opencode-integration-routes");
        await reconcileOpencodeIntegrationIfEnabled(configOverride, Number(url.port) || configOverride.port);
      } catch {
        // Optional client integration: catalog/config mutations remain successful when OpenCode
        // is absent or its user-owned config needs attention.
      }
      return disposition;
    } catch {
      return {
        status: "failed",
        reason: "disk",
        phase: convergenceInvoked ? "commit" : "gather",
        retryable: false,
        partialWrite: convergenceInvoked,
      };
    }
  }

  async function syncClaudeAgentDefsBestEffort(): Promise<void> {
    if (deps.syncClaudeAgentDefsBestEffort) {
      await deps.syncClaudeAgentDefsBestEffort();
      return;
    }
    try {
      const { injectClaudeAgentDefs } = await import("../claude/agents-inject");
      if (config.claudeCode?.enabled === false || config.claudeCode?.injectAgents === false) {
        injectClaudeAgentDefs(config, {});
        return;
      }
      try {
        const [models, { buildClaudeContextWindows }, { visibleNativeSlugs }] = await Promise.all([
          (deps.fetchAllModels ?? fetchAllModels)(config),
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
  const ctx: ManagementContext = { req, url, config, deps, principal, convergeCodexCatalog, syncClaudeAgentDefsBestEffort };
  let routed: Response | null;
  try {
    routed = (await handleConfigRoutes(ctx))
    ??     (await handleLogsUsageRoutes(ctx))
    ??     (await handleRequestHistoryRoutes(ctx))
    ??     (await handleRoutingAnalyticsRoutes(ctx))
    ??     (await handleRoutingProfileRoutes(ctx))
    ??     (await handleProviderRoutes(ctx))
    ??     (await handleIntegrationRoutes(ctx))
    ??     (await handleOpencodeIntegrationRoutes(ctx))
    ??     (await handleModelRoutes(ctx))
    ??     (await handleNativeIntegrationRoutes(ctx))
    ??     (await handleAgentSettingsRoutes(ctx))
    ??     (await handleCatalogActivationRoutes(ctx))
    ??     (await handleOauthAccountRoutes(ctx))
    ??     (await handleComboRoutes(ctx))
    ??     (await handleActivityRoutes(ctx))
    ??     (await handleSystemRoutes(ctx));
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
    const lifecycle = deps.proxyStopLifecycle ?? {};
    const delegatedLease = readProxyLifecycleLockLeaseHeaders(req.headers);
    let ownedAuthority: ProxyLifecycleAuthority | undefined;
    if (delegatedLease.kind !== "none") {
      const valid = delegatedLease.kind === "lease"
        && (lifecycle.validateLease ?? validateProxyLifecycleLockLease)(delegatedLease.lease);
      if (!valid) {
        return jsonResponse(
          { success: false, message: "Proxy stop lifecycle coordination was refused." },
          409,
          req,
          config,
        );
      }
    } else {
      try {
        ownedAuthority = await (lifecycle.acquireAuthority ?? acquireProxyLifecycleAuthority)(
          stopLifecycleAuthorityOptions(),
        );
      } catch {
        return jsonResponse(
          { success: false, message: "Proxy lifecycle is busy; use menu or CLI Stop and retry." },
          409,
          req,
          config,
        );
      }
    }
    let prepared: Awaited<ReturnType<NonNullable<typeof lifecycle.prepareShutdown>>>;
    try {
      const prepareShutdown = lifecycle.prepareShutdown
        ?? (await import("../cli/proxy-lifecycle")).prepareExplicitProxyShutdown;
      prepared = prepareShutdown({
        allowInstalledServiceStop: delegatedLease.kind === "lease",
        serviceAlreadyStopped: delegatedLease.kind === "lease",
      });
    } catch {
      ownedAuthority?.releaseAll();
      return jsonResponse(
        { success: false, message: "Proxy stop preparation failed; CodexCommander stayed running." },
        409,
        req,
        config,
      );
    }
    if (!prepared.accepted) {
      ownedAuthority?.releaseAll();
      return jsonResponse(
        { success: false, message: prepared.message },
        prepared.status,
        req,
        config,
      );
    }
    // The Stop transition is persisted by a fresh locked config mutation. Keep
    // this long-lived server instance aligned immediately so an already-admitted
    // whole-config writer cannot re-publish a stale Codex ON value before exit.
    config.clientIntegrations = { ...config.clientIntegrations, codex: false };
    try {
      (lifecycle.schedule ?? setTimeout)(async () => {
        try {
          await (lifecycle.drain ?? drainAndShutdown)(undefined, config.shutdownTimeoutMs ?? 5000);
        } finally {
          // Production process.exit never returns, so raw-owned E/S remain present
          // until dead-owner reclamation. A test exit seam may return; release only
          // after it has observed the still-held authority.
          try { (lifecycle.exit ?? process.exit)(0); } finally { ownedAuthority?.releaseAll(); }
        }
      }, 200);
    } catch {
      ownedAuthority?.releaseAll();
      return jsonResponse(
        { success: false, message: "Proxy stop scheduling failed; CodexCommander stayed running." },
        409,
        req,
        config,
      );
    }
    return jsonResponse({ success: prepared.success, message: prepared.message });
  }

  if (url.pathname.startsWith("/api/native-main-profiles")) {
    const { handleNativeProfileAPI } = await import("../codex/native-profile-api");
    return handleNativeProfileAPI(req, url, config, deps.nativeProfileApi);
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

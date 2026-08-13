import { codexAutoStartEnabled, saveConfigPreservingClaudeCode } from "../../config";

import { isStreamMode } from "../../lib/bun-stream-caps";
import { shadowSourceModels } from "../../lib/shadow-call";
import {
  configureAppOwnedMemoryBudget,
  enforceAppOwnedMemoryBudget,
  MAX_APP_OWNED_MEMORY_BUDGET_MB,
  MIN_APP_OWNED_MEMORY_BUDGET_MB,
  resolveAppOwnedMemoryBudgetBytes,
} from "../../lib/app-owned-memory";

import { jsonResponse, safeConfigDTO } from "../auth-cors";

import { getCachedStartupHealth, invalidateStartupHealthCache } from "../startup-health-cache";
import {
  decorateStartupHealth,
  parseCompanionStartupBody,
  recordCompanionLease,
} from "../companion-startup-state";
import { runWindowsTrayAction } from "../windows-tray-control";
import { runStartupInstallAction, type StartupInstallAction } from "../startup-action-control";
import { displayCodexRuntimePath, effortClampAppliesToRuntime, loadLastEffortClamp, resolveCodexRuntime } from "../../codex/runtime";
import { acquireProxyLifecycleAuthority, type ProxyLifecycleAuthority } from "../proxy-lifecycle-authority";
import { validateProxyLifecycleLockLease } from "../proxy-start-lock";
import { readProxyLifecycleLockLeaseHeaders } from "../proxy-lifecycle-protocol";

import { isPlainRecord } from "./shared";

import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";

export async function handleConfigRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps } = ctx;
  if (url.pathname === "/api/config" && req.method === "GET") {
    return jsonResponse(safeConfigDTO(config));
  }

  if (url.pathname === "/api/config" && req.method === "PUT") {
    return jsonResponse({ error: "Full config PUT is disabled. Use /api/providers POST for provider changes." }, 405);
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    let resolved: ReturnType<typeof resolveCodexRuntime>;
    try {
      // Full alternative discovery (memoized) so newerAvailable warnings work.
      resolved = (deps.resolveCodexRuntime ?? resolveCodexRuntime)();
    } catch {
      resolved = {
        runtime: { command: "codex", version: null, source: "fallback" },
        failures: [],
      };
    }
    const lastClamp = loadLastEffortClamp();
    const clampActive = effortClampAppliesToRuntime(lastClamp, resolved.runtime);
    const warningParts: string[] = [];
    if (resolved.replacedConfigured) {
      warningParts.push(
        `Preferred Codex runtime is unavailable; using ${displayCodexRuntimePath(resolved.runtime.command)} instead.`,
      );
    } else if (
      resolved.runtime.source === "fallback"
      && resolved.failures.length > 0
      && !resolved.runtime.version
    ) {
      warningParts.push("No validated Codex runtime found; falling back to `codex`.");
    }
    if (clampActive) {
      const clampVersion = lastClamp?.runtimeVersion ?? resolved.runtime.version ?? "an older binary";
      warningParts.push(
        `Some reasoning effort options were hidden because CodexCommander used Codex ${clampVersion}.${resolved.newerAvailable ? " A newer Codex installation is available." : ""}`,
      );
    } else if (resolved.newerAvailable) {
      warningParts.push(
        `CodexCommander is using an older Codex binary (${resolved.runtime.version ?? "unknown"}). A newer Codex installation is available.`,
      );
    }
    return jsonResponse({
      // The dashboard renders request-log timestamps. Without this it formats them in the
      // BROWSER's zone, so a KST proxy viewed from a UTC browser reports every request nine
      // hours off (#725). Carried on settings rather than /api/logs because that route's
      // array response has four consumers that would have to change with it.
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      codexAutoStart: codexAutoStartEnabled(config),
      port: config.port,
      hostname: config.hostname ?? "127.0.0.1",
      streamMode: config.streamMode ?? "auto",
      appOwnedMemoryBudgetMb: config.appOwnedMemoryBudgetMb ?? 256,
      startupHealth: decorateStartupHealth(await (deps.getCachedStartupHealth ?? getCachedStartupHealth)(config)),
      codexRuntime: {
        path: displayCodexRuntimePath(resolved.runtime.command),
        version: resolved.runtime.version,
        source: resolved.runtime.source,
        newerAvailable: resolved.newerAvailable
          ? {
            path: displayCodexRuntimePath(resolved.newerAvailable.command),
            version: resolved.newerAvailable.version,
          }
          : null,
        catalogClamp: {
          active: clampActive,
          removedEfforts: clampActive ? (lastClamp?.removedEfforts ?? []) : [],
          runtimeVersion: clampActive ? (lastClamp?.runtimeVersion ?? null) : null,
        },
        warning: warningParts.length > 0 ? warningParts.join(" ") : null,
      },
    });
  }

  if (url.pathname === "/api/startup-health" && req.method === "GET") {
    return jsonResponse(decorateStartupHealth(await getCachedStartupHealth(config)));
  }

  if (url.pathname === "/api/startup-health/companion" && req.method === "PUT") {
    // The native app reports launch-at-login state with the admin token. Anything
    // that is not the raw admin token — browser GUI sessions and direct-dispatch
    // requests without an explicit principal — fails closed with 403.
    if (ctx.principal !== "admin-token") {
      return jsonResponse({ error: "companion startup state requires the admin token" }, 403);
    }
    let raw: unknown;
    try {
      raw = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const parsed = parseCompanionStartupBody(raw);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
    recordCompanionLease(parsed.launchAtLogin);
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/startup-action" && req.method === "POST") {
    let body: { action?: unknown; repair?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!body || !["install-service", "install-shim"].includes(String(body.action))) {
      return jsonResponse({ error: "action must be install-service or install-shim" }, 400);
    }
    if (body.repair !== undefined && typeof body.repair !== "boolean") {
      return jsonResponse({ error: "repair must be a boolean when provided" }, 400);
    }
    try {
      const action = body.action as StartupInstallAction;
      const repair = body.repair === true;
      const result = await (deps.runStartupInstallAction ?? runStartupInstallAction)(action, { repair });
      invalidateStartupHealthCache();
      return jsonResponse({ ok: true, action, repair, message: result.message });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (url.pathname === "/api/windows-tray" && req.method === "GET") {
    if (process.platform !== "win32") return jsonResponse({ supported: false, installed: false, running: false, stale: false, summary: `unsupported on ${process.platform}` });
    try {
      return jsonResponse(await runWindowsTrayAction("status"));
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (url.pathname === "/api/windows-tray" && req.method === "POST") {
    let body: { action?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!body || !["install", "start", "stop", "uninstall"].includes(String(body.action))) {
      return jsonResponse({ error: "action must be install, start, stop, or uninstall" }, 400);
    }
    if (process.platform !== "win32") return jsonResponse({ error: "Windows tray is only supported on Windows" }, 400);
    try {
      const status = await runWindowsTrayAction(body.action as "install" | "start" | "stop" | "uninstall");
      return jsonResponse({ ok: true, status });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (url.pathname === "/api/settings" && req.method === "PUT") {
    // Each field is optional but at least one must be present; fields are
    // validated when present. streamMode-only PUTs must work: Windows/macOS
    // memory troubleshooting can use this persisted stream-shape escape hatch
    // (a Windows service does not inherit shell env). A stream-shape
    // change applies to NEW turns only — the config object is shared by
    // reference with the request handlers, no restart needed.
    let body: { codexAutoStart?: unknown; streamMode?: unknown; appOwnedMemoryBudgetMb?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.codexAutoStart === undefined && body.streamMode === undefined && body.appOwnedMemoryBudgetMb === undefined) {
      return jsonResponse({ error: "provide codexAutoStart, streamMode, or appOwnedMemoryBudgetMb" }, 400);
    }
    if (body.codexAutoStart !== undefined && typeof body.codexAutoStart !== "boolean") {
      return jsonResponse({ error: "codexAutoStart boolean is required" }, 400);
    }
    if (body.streamMode !== undefined && !isStreamMode(body.streamMode)) {
      return jsonResponse({ error: "streamMode must be auto, safe-tee, or eager-relay" }, 400);
    }
    if (body.appOwnedMemoryBudgetMb !== undefined && (
      typeof body.appOwnedMemoryBudgetMb !== "number"
      || !Number.isInteger(body.appOwnedMemoryBudgetMb)
      || body.appOwnedMemoryBudgetMb < MIN_APP_OWNED_MEMORY_BUDGET_MB
      || body.appOwnedMemoryBudgetMb > MAX_APP_OWNED_MEMORY_BUDGET_MB
    )) {
      return jsonResponse({ error: `appOwnedMemoryBudgetMb must be an integer from ${MIN_APP_OWNED_MEMORY_BUDGET_MB} to ${MAX_APP_OWNED_MEMORY_BUDGET_MB}` }, 400);
    }
    if (typeof body.codexAutoStart === "boolean") {
      config.codexAutoStart = body.codexAutoStart;
    }
    if (body.streamMode !== undefined) {
      if (body.streamMode === "auto") {
        delete config.streamMode;
      } else {
        config.streamMode = body.streamMode as "safe-tee" | "eager-relay";
      }
    }
    if (typeof body.appOwnedMemoryBudgetMb === "number") {
      config.appOwnedMemoryBudgetMb = body.appOwnedMemoryBudgetMb;
    }
    saveConfigPreservingClaudeCode(config);
    if (typeof body.appOwnedMemoryBudgetMb === "number") {
      configureAppOwnedMemoryBudget(resolveAppOwnedMemoryBudgetBytes(body.appOwnedMemoryBudgetMb));
      enforceAppOwnedMemoryBudget();
    }
    invalidateStartupHealthCache();
    return jsonResponse({
      ok: true,
      codexAutoStart: codexAutoStartEnabled(config),
      streamMode: config.streamMode ?? "auto",
      appOwnedMemoryBudgetMb: config.appOwnedMemoryBudgetMb ?? 256,
      startupHealth: decorateStartupHealth(await getCachedStartupHealth(config)),
    });
  }

  if (url.pathname === "/api/diagnostics/project-config" && req.method === "GET") {
    const { getCachedProjectConfigDiagnostics } = await import("../../codex/project-config-warnings");
    const { warnings, grouped } = getCachedProjectConfigDiagnostics();
    return jsonResponse({ warnings, grouped });
  }

  if (url.pathname === "/api/sync" && req.method === "POST") {
    const lifecycle = deps.proxyStopLifecycle ?? {};
    const delegatedLease = readProxyLifecycleLockLeaseHeaders(req.headers);
    let ownedAuthority: ProxyLifecycleAuthority | undefined;
    if (delegatedLease.kind !== "none") {
      const valid = delegatedLease.kind === "lease"
        && (lifecycle.validateLease ?? validateProxyLifecycleLockLease)(delegatedLease.lease);
      if (!valid) {
        return jsonResponse({
          status: "refused",
          ok: false,
          added: 0,
          catalogPath: null,
          catalogExists: false,
          catalogWritten: false,
          cacheSynced: false,
          catalogQuality: "native-only",
          rehydrated: 0,
          message: "Codex sync lifecycle coordination was refused.",
          error: "Codex sync lifecycle coordination was refused.",
        }, 409);
      }
    } else {
      try {
        ownedAuthority = await (lifecycle.acquireAuthority
          ?? acquireProxyLifecycleAuthority)({ includeStart: true });
      } catch {
        return jsonResponse({
          status: "refused",
          ok: false,
          added: 0,
          catalogPath: null,
          catalogExists: false,
          catalogWritten: false,
          cacheSynced: false,
          catalogQuality: "native-only",
          rehydrated: 0,
          message: "Proxy lifecycle is busy; no Codex catalog or routing changes were made.",
          error: "Proxy lifecycle is busy; no Codex catalog or routing changes were made.",
        }, 409);
      }
    }
    try {
      const { syncModelsToCodex } = await import("../../codex/sync");
      const {
        attachStaleAppServerHint,
        resetCodexAppServerCatalogStateCache,
      } = await import("../../codex/app-server-processes");
      const { readRuntimePort, loadConfig } = await import("../../config");
      // Never use the server-captured startup object for a durable integration
      // decision. A toggle may have persisted while this process was gathering.
      const runtime = (deps.readRuntimePort ?? readRuntimePort)(process.pid);
      const currentConfig = loadConfig();
      const result = await (deps.syncModelsToCodex ?? syncModelsToCodex)(runtime?.port, currentConfig, null);
      // A read taken before this sync can be memoized for five seconds. Drop it
      // before classifying the just-written catalog so launch-time catalog
      // readiness cannot be masked by a pre-write `fresh` snapshot.
      (deps.resetCodexAppServerCatalogStateCache ?? resetCodexAppServerCatalogStateCache)();
      const {
        catalogOnlyWorkerStateFromActivation,
        captureCodexCatalogDesiredSnapshot,
        collectCodexCatalogActivationWorkerState,
        inspectCodexCatalogArtifactProof,
        inspectCodexCatalogActivation,
        resetCodexCatalogActivationWorkerStateCache,
      } = await import("../../codex/catalog-activation");
      const { getCodexRoutingKind } = await import("../../codex/inject");
      resetCodexCatalogActivationWorkerStateCache();
      const activationWorkers = (deps.collectCodexAppServerCatalogState
        ?? collectCodexCatalogActivationWorkerState)();
      const catalogState = deps.collectCodexAppServerCatalogState
        ? activationWorkers
        : catalogOnlyWorkerStateFromActivation(activationWorkers);
      // Bind the response to the desired generation that exists after the sync.
      // This also requires the process-local convergence receipt to prove that a
      // complete catalog/cache publication committed, then verifies the exact
      // authoritative catalog instead of inferring readiness from roster slugs.
      // Codex owns models_cache.json and may legitimately refresh it immediately.
      const captureDesired = () => deps.captureCatalogDesiredSnapshotForActivation?.()
        ?? captureCodexCatalogDesiredSnapshot();
      const artifactProof = (desired: ReturnType<typeof captureDesired>) =>
        deps.catalogArtifactProofForActivation?.()
        ?? inspectCodexCatalogArtifactProof(desired.config);
      const routingKind = () => deps.codexRoutingKindForActivation?.()
        ?? getCodexRoutingKind();
      const activationDesired = captureDesired();
      const activationArtifactProof = artifactProof(activationDesired);
      const activationRoutingKind = routingKind();
      const activation = inspectCodexCatalogActivation(
        activationDesired.config,
        activationWorkers,
        undefined,
        activationDesired.authority,
        activationArtifactProof,
        activationRoutingKind,
      );

      // An authenticated manual full sync is the only failed-readiness recovery
      // boundary. Do not promote from the sync result alone: Save may race the
      // request, or routing/artifact state may drift after the writer returns.
      // Re-observe every relevant signal after building the response activation
      // and require the two post-sync observations to describe the same desired
      // generation and route. Applied integration additionally needs the exact
      // process-local publication receipt and authoritative catalog on both reads. Intentional OFF and
      // external-provider skips have no Commander-owned artifact by design, but
      // their skip reason must agree exactly with the stable routing state.
      let recoveryProven = false;
      if (result.ok === true && (result.warning === undefined || result.warning === "")) {
        try {
          const confirmedRoutingKind = routingKind();
          const confirmedArtifactProof = result.status === "applied"
            ? artifactProof(activationDesired)
            : activationArtifactProof;
          // Recapture desired state last. A Save that races either confirmation
          // read must change this revision and keep the recovery gate closed.
          const confirmedDesired = captureDesired();
          const desiredStable = confirmedDesired.revision === activationDesired.revision;
          const routingStable = confirmedRoutingKind === activationRoutingKind;
          const integrationDisabled = activationDesired.config.clientIntegrations?.codex === false
            && confirmedDesired.config.clientIntegrations?.codex === false;
          const disabledSkip = result.status === "skipped"
            && result.skippedReason === "desired_disabled"
            && integrationDisabled
            && activation.routing.status === "not_required"
            // `not_required` is derived from desired OFF and intentionally masks
            // the raw route in the public activation DTO. OFF is not actually
            // settled while a stale Commander-owned route remains injected, and
            // unreadable routing is never positive proof.
            && activationRoutingKind !== "codexcommander-local"
            && activationRoutingKind !== "unknown";
          const externalSkip = result.status === "skipped"
            && result.skippedReason === "external_provider"
            && !integrationDisabled
            && activation.routing.status === "external";
          const applied = result.status === "applied"
            && !integrationDisabled
            && activation.routing.status === "current"
            && activationArtifactProof === "current"
            && confirmedArtifactProof === "current";
          recoveryProven = desiredStable && routingStable && (disabledSkip || externalSkip || applied);
        } catch {
          // A torn/unreadable confirmation is not proof. Keep readiness failed;
          // the structured sync/activation response remains useful diagnostics.
        }
      }
      if (recoveryProven) deps.readinessGate?.recoverReady();
      const status = result.status === "refused" ? 409 : (result.status === "skipped" || result.ok ? 200 : 500);
      return jsonResponse({
        ...attachStaleAppServerHint(result),
        catalogState,
        activation,
        ...(result.ok ? {} : { error: result.message }),
      }, status);
    } finally {
      // releaseAll is the canonical S -> E order. A delegated caller retains
      // its own pair; this route neither releases nor re-acquires it.
      ownedAuthority?.releaseAll();
    }
  }

  if (url.pathname === "/api/sidecar-settings" && req.method === "GET") {
    const ws = config.webSearchSidecar ?? {};
    const vs = config.visionSidecar ?? {};
    return jsonResponse({
      webSearch: { model: ws.model ?? "gpt-5.6-luna", backend: ws.backend },
      vision: {
        model: vs.model ?? "gpt-5.6-luna",
        backend: vs.backend,
        maxDescriptionsPerTurn: vs.maxDescriptionsPerTurn,
      },
    });
  }

  if (url.pathname === "/api/sidecar-settings" && req.method === "PUT") {
    let raw: unknown;
    try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    // Strict shape (review F2): reject non-object bodies and non-object sections instead of throwing
    // on `null` or silently accepting arrays/strings as no-op updates.
    if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400);
    if (raw.webSearch !== undefined && !isPlainRecord(raw.webSearch)) return jsonResponse({ error: "webSearch must be an object" }, 400);
    if (raw.vision !== undefined && !isPlainRecord(raw.vision)) return jsonResponse({ error: "vision must be an object" }, 400);
    const body = raw as {
      webSearch?: { model?: unknown; backend?: unknown; reasoning?: unknown };
      vision?: { model?: unknown; backend?: unknown; maxDescriptionsPerTurn?: unknown };
    };
    if (body.webSearch && body.webSearch.backend !== undefined && body.webSearch.backend !== null
      && body.webSearch.backend !== "openai" && body.webSearch.backend !== "anthropic") {
      return jsonResponse({ error: "webSearch.backend must be openai, anthropic, or null" }, 400);
    }
    if (body.vision && body.vision.backend !== undefined
      && body.vision.backend !== null && body.vision.backend !== "openai" && body.vision.backend !== "anthropic") {
      return jsonResponse({ error: "vision.backend must be openai, anthropic, or null" }, 400);
    }
    if (body.vision && body.vision.maxDescriptionsPerTurn !== undefined
      && (typeof body.vision.maxDescriptionsPerTurn !== "number"
        || !Number.isInteger(body.vision.maxDescriptionsPerTurn)
        || body.vision.maxDescriptionsPerTurn <= 0)) {
      return jsonResponse({ error: "vision.maxDescriptionsPerTurn must be a positive integer" }, 400);
    }
    if (body.webSearch) {
      config.webSearchSidecar = { ...config.webSearchSidecar };
      if (typeof body.webSearch.model === "string") {
        if (body.webSearch.model === "") delete config.webSearchSidecar.model;
        else config.webSearchSidecar.model = body.webSearch.model;
      }
      if (body.webSearch.backend === null) delete config.webSearchSidecar.backend;
      else if (body.webSearch.backend === "openai" || body.webSearch.backend === "anthropic") {
        config.webSearchSidecar.backend = body.webSearch.backend;
      }
      if (typeof body.webSearch.reasoning === "string") config.webSearchSidecar.reasoning = body.webSearch.reasoning;
    }
    if (body.vision) {
      config.visionSidecar = { ...config.visionSidecar };
      if (typeof body.vision.model === "string") {
        if (body.vision.model === "") delete config.visionSidecar.model;
        else config.visionSidecar.model = body.vision.model;
      }
      if (body.vision.backend === null) delete config.visionSidecar.backend;
      else if (body.vision.backend === "openai" || body.vision.backend === "anthropic") {
        config.visionSidecar.backend = body.vision.backend;
      }
      if (typeof body.vision.maxDescriptionsPerTurn === "number") {
        config.visionSidecar.maxDescriptionsPerTurn = body.vision.maxDescriptionsPerTurn;
      }
    }
    saveConfigPreservingClaudeCode(config);
    const ws = config.webSearchSidecar ?? {};
    const vs = config.visionSidecar ?? {};
    return jsonResponse({
      ok: true,
      webSearch: { model: ws.model ?? "gpt-5.6-luna", backend: ws.backend },
      vision: {
        model: vs.model ?? "gpt-5.6-luna",
        backend: vs.backend,
        maxDescriptionsPerTurn: vs.maxDescriptionsPerTurn,
      },
    });
  }

  if (url.pathname === "/api/shadow-call-settings" && req.method === "GET") {
    const sci = config.shadowCallIntercept ?? {};
    return jsonResponse({
      enabled: sci.enabled === true,
      model: sci.model ?? "",
      sourceModels: shadowSourceModels(sci.sourceModels),
    });
  }

  if (url.pathname === "/api/shadow-call-settings" && req.method === "PUT") {
    let raw: unknown;
    try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400);
    const body = raw as { enabled?: unknown; model?: unknown };
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      return jsonResponse({ error: "model must be a string" }, 400);
    }
    config.shadowCallIntercept = { ...config.shadowCallIntercept };
    if (typeof body.enabled === "boolean") config.shadowCallIntercept.enabled = body.enabled;
    if (typeof body.model === "string") {
      if (body.model === "") delete config.shadowCallIntercept.model;
      else config.shadowCallIntercept.model = body.model;
    }
    saveConfigPreservingClaudeCode(config);
    const sci = config.shadowCallIntercept;
    return jsonResponse({
      ok: true,
      enabled: sci.enabled === true,
      model: sci.model ?? "",
      sourceModels: shadowSourceModels(sci.sourceModels),
    });
  }
  return null;
}

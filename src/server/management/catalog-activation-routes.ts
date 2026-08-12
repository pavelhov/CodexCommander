import {
  captureCodexCatalogDesiredSnapshot,
  codexCatalogDesiredRevision,
  collectCodexCatalogActivationWorkerState,
  inspectCodexCatalogArtifactProof,
  inspectCodexCatalogActivation,
  resetCodexCatalogActivationWorkerStateCache,
  type CodexCatalogActivationState,
} from "../../codex/catalog-activation";
import type { CatalogConfigAuthoritySnapshot } from "../../codex/catalog-admission";
import {
  resetCodexAppServerCatalogStateCache,
  type CodexAppServerCatalogStatus,
} from "../../codex/app-server-processes";
import type { CatalogDisposition } from "../../codex/convergence-types";
import type {
  CodexCatalogApplyBlockReason,
  CodexCatalogApplyResult,
} from "../../codex/catalog-apply";
import type { CodexCommanderConfig } from "../../types";
import { getCodexRoutingKind } from "../../codex/inject";
import { jsonResponse } from "../auth-cors";
import {
  acquireProxyLifecycleAuthority,
  type ProxyLifecycleAuthority,
} from "../proxy-lifecycle-authority";
import type { ManagementContext } from "./context";
import type { ManagementPrincipal } from "../management-auth";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { isPlainRecord } from "./shared";

let catalogApplyFlight: Promise<Response> | null = null;

/**
 * Process interruption is never advertised to an ordinary dashboard session or
 * a raw admin-token API client. Only a browser session created by the one-time
 * launcher handoff receives the actionable reason and permission.
 */
export function projectCatalogActivationForPrincipal(
  activation: CodexCatalogActivationState,
  principal?: ManagementPrincipal,
) {
  if (principal === "confirmed-gui-session") return activation;
  return {
    ...activation,
    apply: {
      ...activation.apply,
      allowed: false,
      reason: "confirmed-launch-required" as const,
    },
  };
}

function unknownWorkerStatus(): CodexAppServerCatalogStatus {
  return { state: "unknown", processes: [], catalogMtimeMs: null };
}

function collectWorkers(ctx: ManagementContext): CodexAppServerCatalogStatus {
  try {
    return (ctx.deps.collectCodexAppServerCatalogState
      ?? collectCodexCatalogActivationWorkerState)();
  } catch {
    return unknownWorkerStatus();
  }
}

interface DesiredObservation {
  config: CodexCommanderConfig;
  revision: string;
  authority?: CatalogConfigAuthoritySnapshot;
}

function currentDesired(ctx: ManagementContext): DesiredObservation {
  if (ctx.deps.captureCatalogDesiredSnapshotForActivation) {
    return ctx.deps.captureCatalogDesiredSnapshotForActivation();
  }
  if (ctx.deps.loadConfigForCatalogActivation) {
    const config = ctx.deps.loadConfigForCatalogActivation();
    return { config, revision: codexCatalogDesiredRevision(config) };
  }
  return captureCodexCatalogDesiredSnapshot();
}

function collectActivation(
  ctx: ManagementContext,
  desired: DesiredObservation = currentDesired(ctx),
  disposition?: CatalogDisposition,
  workers: CodexAppServerCatalogStatus = collectWorkers(ctx),
): CodexCatalogActivationState {
  const activation = inspectCodexCatalogActivation(
    desired.config,
    workers,
    disposition,
    desired.authority,
    ctx.deps.catalogArtifactProofForActivation?.(),
    ctx.deps.codexRoutingKindForActivation?.(),
  );
  // Test seams intentionally do not touch the persisted coordinator. Keep one
  // authoritative revision even if their config reader is stateful.
  activation.desired.revision = desired.revision;
  return activation;
}

function resetActivationObservation(ctx: ManagementContext): void {
  (ctx.deps.resetCodexAppServerCatalogStateCache
    ?? resetCodexAppServerCatalogStateCache)();
  resetCodexCatalogActivationWorkerStateCache();
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function lifecycleBusyResponse(ctx: ManagementContext): Response {
  const response = jsonResponse({
    error: "Proxy lifecycle is busy; no Codex catalog or routing changes were made.",
    retryable: true,
  }, 409, ctx.req, ctx.config);
  response.headers.set("Retry-After", "1");
  return noStore(response);
}

function applyMessage(outcome: string, stopped: number, surviving: number): string {
  if (outcome === "applied") {
    if (stopped === 0) {
      return "The stale Codex workers are no longer running. The saved roster will load with the current worker state.";
    }
    return stopped === 1
      ? "The stale Codex background worker was stopped. The saved roster will load in its replacement."
      : `${stopped} stale Codex background workers were stopped. The saved roster will load in their replacements.`;
  }
  if (outcome === "already_current") return "Codex is already using the saved roster.";
  if (outcome === "no_workers") return "No Codex background worker is running. The saved roster will load when Codex starts.";
  if (outcome === "partial") {
    return `${surviving} stale Codex background worker${surviving === 1 ? " is" : "s are"} still running.`;
  }
  if (outcome === "superseded") return "The saved configuration changed before Apply could run. Refresh and try again.";
  return "Codex worker identity could not be verified. No process was stopped.";
}

function blockedMessage(reason: CodexCatalogApplyBlockReason | undefined): string {
  if (reason === "integration-disabled") {
    return "Codex integration is disabled, so Apply did not change Codex routing or stop a process.";
  }
  if (reason === "external-routing") {
    return "Codex is using an external model provider, so CodexCommander preserved that routing and stopped no process.";
  }
  if (reason === "desired-superseded" || reason === "authorization-changed") {
    return applyMessage("superseded", 0, 0);
  }
  if (reason === "artifact-not-current") {
    return "The exact synchronized catalog could not be proven, so no Codex process was stopped.";
  }
  if (reason === "routing-not-owned") {
    return "CodexCommander does not own the active Codex routing, so no Codex process was stopped.";
  }
  if (reason === "sync-warning") {
    return "Catalog synchronization reported degraded evidence, so no Codex process was stopped.";
  }
  if (reason === "worker-state-unknown") {
    return applyMessage("blocked", 0, 0);
  }
  return "Codex routing and catalog synchronization failed, so no Codex process was stopped.";
}

async function runApply(
  ctx: ManagementContext,
  expectedRevision: string,
): Promise<Response> {
  const { readRuntimePort } = await import("../../config");
  const {
    applyCodexCatalogWorkers,
    runCodexCatalogApply,
  } = await import("../../codex/catalog-apply");
  const runtime = (ctx.deps.readRuntimePort ?? readRuntimePort)(process.pid);
  const result: CodexCatalogApplyResult = await runCodexCatalogApply({
    expectedDesiredRevision: expectedRevision,
  }, {
    // Production always returns an authority-bearing snapshot. The legacy
    // config-only seam exists only for direct route fixtures.
    captureDesiredSnapshot: () => currentDesired(ctx) as ReturnType<typeof captureCodexCatalogDesiredSnapshot>,
    syncCatalog: async desired => {
      const { syncModelsToCodex } = await import("../../codex/sync");
      return (ctx.deps.syncModelsToCodex ?? syncModelsToCodex)(runtime?.port, desired.config, null);
    },
    inspectArtifactProof: desired => ctx.deps.catalogArtifactProofForActivation?.()
      ?? inspectCodexCatalogArtifactProof(desired.config),
    getRoutingKind: () => ctx.deps.codexRoutingKindForActivation?.() ?? getCodexRoutingKind(),
    resetWorkerObservation: () => resetActivationObservation(ctx),
    collectWorkerState: () => collectWorkers(ctx),
    applyWorkers: (authorizeSignal, observedBefore) => (
      ctx.deps.applyCodexCatalogWorkers ?? applyCodexCatalogWorkers
    )(authorizeSignal, undefined, observedBefore),
  });
  const activation = collectActivation(ctx, currentDesired(ctx));
  const outcome = result.outcome;
  const ok = outcome === "applied" || outcome === "already_current" || outcome === "no_workers";
  const status = outcome === "superseded" || outcome === "blocked" ? 409 : 200;
  const message = (outcome === "partial" || outcome === "applied"
    || outcome === "already_current" || outcome === "no_workers")
    ? applyMessage(outcome, result.stoppedWorkerCount, result.survivingWorkerCount)
    : result.blockReason
    ? blockedMessage(result.blockReason)
    : applyMessage(outcome, result.stoppedWorkerCount, result.survivingWorkerCount);
  return noStore(jsonResponse({
    ok,
    outcome,
    activation,
    staleWorkerCount: result.staleWorkerCount,
    stoppedWorkerCount: result.stoppedWorkerCount,
    survivingWorkerCount: result.survivingWorkerCount,
    message,
  }, status, ctx.req, ctx.config));
}

export async function handleCatalogActivationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname === "/api/codex-catalog/status" && req.method === "GET") {
    return noStore(jsonResponse({
      activation: projectCatalogActivationForPrincipal(collectActivation(ctx), ctx.principal),
    }, 200, req, config));
  }
  if (url.pathname !== "/api/codex-catalog/apply" || req.method !== "POST") return null;

  // Keep this interruption action on the dashboard's origin/CSRF-protected path,
  // which blocks remote drive-by requests. This is not an OS privilege boundary:
  // a same-user local process can already signal another same-user process.
  if (ctx.principal !== "confirmed-gui-session") {
    return jsonResponse({
      error: "Apply to Codex requires a confirmed dashboard launch from `ccx gui` or the CodexCommander menu bar app.",
    }, 403, req, config);
  }
  let raw: unknown;
  try {
    raw = await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
  }
  if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400, req, config);
  const keys = Object.keys(raw);
  if (keys.some(key => key !== "expectedDesiredRevision" && key !== "confirmInterrupt")) {
    return jsonResponse({ error: "body contains unsupported fields" }, 400, req, config);
  }
  if (typeof raw.expectedDesiredRevision !== "string" || raw.expectedDesiredRevision.length < 4 || raw.expectedDesiredRevision.length > 128) {
    return jsonResponse({ error: "expectedDesiredRevision must be an opaque revision string" }, 400, req, config);
  }
  if (raw.confirmInterrupt !== true) {
    return jsonResponse({ error: "confirmInterrupt must be true" }, 400, req, config);
  }
  const expectedDesiredRevision = raw.expectedDesiredRevision;
  if (catalogApplyFlight) {
    const response = jsonResponse({ error: "catalog apply is already in progress" }, 503, req, config);
    response.headers.set("Retry-After", "1");
    return response;
  }
  const flight = (async (): Promise<Response> => {
    let authority: ProxyLifecycleAuthority;
    try {
      authority = await (ctx.deps.proxyStopLifecycle?.acquireAuthority
        ?? acquireProxyLifecycleAuthority)({ includeStart: true });
    } catch {
      return lifecycleBusyResponse(ctx);
    }
    try {
      // Apply performs its sync locally. Keeping it inside this authority avoids
      // a nested /api/sync acquisition while serializing desired-state reads,
      // routing/catalog publication, activation proof, and worker interruption
      // against Stop and every other E/S lifecycle transition.
      return await runApply(ctx, expectedDesiredRevision);
    } finally {
      try { authority.releaseAll(); } catch { /* best-effort release at response boundary */ }
    }
  })().finally(() => {
    if (catalogApplyFlight === flight) catalogApplyFlight = null;
  });
  catalogApplyFlight = flight;
  return flight;
}

export function resetCatalogApplyFlightForTests(): void {
  catalogApplyFlight = null;
}

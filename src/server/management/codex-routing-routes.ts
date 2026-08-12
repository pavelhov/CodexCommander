import { getCodexRoutingKind } from "../../codex/inject";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

/**
 * Cheap, uncached observation of the active Codex routing document.
 *
 * Startup health intentionally includes slower service and shim diagnostics and is
 * cached. Route-switch confirmation needs a different boundary: read the routing
 * document that Codex will consume, return no config contents, and never cache it.
 */
export function handleCodexRoutingRoutes(ctx: ManagementContext): Response | null {
  if (ctx.url.pathname !== "/api/codex-routing" || ctx.req.method !== "GET") {
    return null;
  }

  const routingKind = (ctx.deps.getCodexRoutingKind ?? getCodexRoutingKind)();
  const response = jsonResponse({
    schemaVersion: 1,
    routingKind,
    routingInjected: routingKind === "codexcommander-local",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

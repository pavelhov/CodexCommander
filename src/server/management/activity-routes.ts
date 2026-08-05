/** Privacy-safe active agent turns for the native macOS companion. */
import { jsonResponse } from "../auth-cors";
import { getAgentActivitySnapshot } from "../lifecycle";
import type { ManagementContext } from "./context";

export async function handleActivityRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname !== "/api/agent-activity" || req.method !== "GET") return null;
  const response = jsonResponse(getAgentActivitySnapshot(), 200, req, config);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

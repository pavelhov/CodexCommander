import { createHash, randomUUID } from "node:crypto";
import { resolveCodexTaskIdentity } from "../codex/task-identity";
import type { CodexCommanderProviderConfig } from "../types";
import { providerMatchesRegistryTransport } from "./registry";

const SESSION_HEADER = "x-opencode-session";
const USER_AGENT_HEADER = "user-agent";

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === name);
}

function validSession(value: string | null): string | undefined {
  return value && value.length <= 512 && !/[\x00-\x20\x7f,]/.test(value) ? value : undefined;
}

/** Give OpenCode Go a stable, opaque lane for each Codex conversation. */
export function resolveOpenCodeGoTransport(
  providerName: string,
  provider: CodexCommanderProviderConfig,
  headers: Headers,
  clientMetadata?: unknown,
): CodexCommanderProviderConfig {
  // The router may already have pinned this model to Go's Anthropic or Responses
  // wire. Verify the canonical key destination against the registry's base adapter,
  // while accepting only Go's three documented wire adapters.
  if (providerName !== "opencode-go"
    || !["openai-chat", "anthropic", "openai-responses"].includes(provider.adapter)
    || !providerMatchesRegistryTransport(providerName, { ...provider, adapter: "openai-chat" })) return provider;
  const hasSession = hasHeader(provider.headers, SESSION_HEADER);
  const hasUserAgent = hasHeader(provider.headers, USER_AGENT_HEADER);
  if (hasSession && hasUserAgent) return provider;

  const outboundHeaders = { ...provider.headers };
  if (!hasSession) {
    const lane = resolveCodexTaskIdentity(headers, clientMetadata).taskId
      ?? validSession(headers.get(SESSION_HEADER))
      ?? randomUUID();
    const session = createHash("sha256")
      .update("codexcommander/opencode-go/session/v1\0")
      .update(lane)
      .digest("hex")
      .slice(0, 32);
    outboundHeaders[SESSION_HEADER] = `ccx_${session}`;
  }
  if (!hasUserAgent) outboundHeaders["User-Agent"] = "CodexCommander";
  return {
    ...provider,
    headers: outboundHeaders,
  };
}

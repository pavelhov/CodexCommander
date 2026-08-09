import type { CodexCommanderProviderConfig } from "../types";
import {
  GITHUB_COPILOT_DEFAULT_API_BASE,
  GITHUB_COPILOT_EDITOR_HEADERS,
  validateCopilotApiBaseUrl,
} from "../oauth/github-copilot";

export type CodexCommanderProviderTransport = CodexCommanderProviderConfig & {
  fetch?: typeof globalThis.fetch;
};

function hasHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === target);
}

function withoutUserOverridden(
  defaults: Readonly<Record<string, string>>,
  userHeaders: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(defaults).filter(([name]) => !hasHeaderCaseInsensitive(userHeaders, name)),
  );
}

/**
 * Copilot chat requires editor fingerprint headers. Defaults are honest CodexCommander values
 * with Copilot-Integration-Id set to the vscode-chat integration id the public client uses.
 * User-configured headers always win.
 */
export function resolveGithubCopilotTransport(
  provider: CodexCommanderProviderTransport,
  apiBaseUrl?: string,
): CodexCommanderProviderTransport {
  const stableDefaults = withoutUserOverridden(GITHUB_COPILOT_EDITOR_HEADERS, provider.headers);
  const headers = {
    ...stableDefaults,
    ...(provider.headers ?? {}),
  };
  // Fail closed: the OAuth bearer only ever goes to an allowlisted *.githubcopilot.com
  // host. A legacy/crafted credential without endpoints.api, or a user-edited baseUrl,
  // must not redirect the token — fall back to the canonical default instead.
  const baseUrl = provider.authMode === "oauth"
    ? validateCopilotApiBaseUrl(apiBaseUrl)
      ?? validateCopilotApiBaseUrl(provider.baseUrl)
      ?? GITHUB_COPILOT_DEFAULT_API_BASE
    : apiBaseUrl?.trim() || provider.baseUrl || GITHUB_COPILOT_DEFAULT_API_BASE;
  return {
    ...provider,
    baseUrl,
    headers,
  };
}

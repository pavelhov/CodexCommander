import type { CodexCommanderProviderConfig } from "../types";

export const OPENAI_CODEX_PROVIDER_ID = "openai";
export const OPENAI_API_PROVIDER_ID = "openai-apikey";

export const CODEX_FORWARD_BASE_URL = "https://chatgpt.com/backend-api/codex";

function normalizedBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

export function isCanonicalOpenAiForwardProvider(provider: CodexCommanderProviderConfig): boolean {
  return provider.adapter === "openai-responses"
    && provider.authMode === "forward"
    && normalizedBaseUrl(provider.baseUrl) === CODEX_FORWARD_BASE_URL;
}

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/**
 * Whether this provider can serve `POST /responses/compact`. The canonical ChatGPT
 * backend can, and so can the official OpenAI API — but an arbitrary gateway that
 * merely speaks the Responses wire cannot, and calling it there fails compaction
 * with an unhelpful error instead of falling back to a routed summary (#422).
 */
export function supportsNativeResponsesCompactEndpoint(
  providerName: string,
  provider: CodexCommanderProviderConfig,
): boolean {
  if (isCanonicalOpenAiForwardProvider(provider)) return true;
  return providerName === OPENAI_API_PROVIDER_ID
    && provider.adapter === "openai-responses"
    && normalizedBaseUrl(provider.baseUrl) === OPENAI_API_BASE_URL;
}

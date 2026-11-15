import type { AdapterEvent, CodexCommanderProviderConfig } from "../types";
import { isCanonicalAnthropicEndpoint } from "../lib/anthropic-endpoint";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { validateClientRetryAfterHeader } from "../lib/retry-after";

/** Only a fresh summarization request to the native Anthropic endpoint owns this policy. */
export function usesCompactionQuotaRecovery(provider: CodexCommanderProviderConfig, freshCompaction: boolean): boolean {
  return freshCompaction && provider.adapter === "anthropic" && isCanonicalAnthropicEndpoint(provider.baseUrl);
}

export function isExplicitQuotaError(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = value as { type?: unknown; code?: unknown };
  return error.type === "insufficient_quota" || error.code === "insufficient_quota";
}

/** Request-local quota-window evidence. Retry-After, cooldowns and cached usage are not proof. */
export function hasRejectedAnthropicQuotaWindow(headers: Headers, now = Date.now()): boolean {
  const overall = headers.get("anthropic-ratelimit-unified-status");
  if (overall && overall !== "rejected") return false;
  const overage = headers.get("anthropic-ratelimit-unified-overage-status");
  if (overage && overage !== "rejected") return false;
  const futureReset = (reset: string | null): boolean => {
    if (!reset || !/^\d+(?:\.\d+)?$/.test(reset)) return false;
    const resetAt = Number(reset) * 1000;
    return Number.isFinite(resetAt) && resetAt > now;
  };
  const claim = headers.get("anthropic-ratelimit-unified-representative-claim");
  if (overall === "rejected" && (claim === "five_hour" || claim === "seven_day")
    && futureReset(headers.get("anthropic-ratelimit-unified-reset"))) return true;
  return ["5h", "7d"].some(window => {
    if (headers.get(`anthropic-ratelimit-unified-${window}-status`) !== "rejected") return false;
    return futureReset(headers.get(`anthropic-ratelimit-unified-${window}-reset`));
  });
}

/** A bounded, read-only inspection; the original error body remains owned by its normal consumer. */
export async function isCompactionQuotaHttpFailure(response: Response, enabled: boolean, signal?: AbortSignal): Promise<boolean> {
  if (!enabled || response.status !== 429) return false;
  if (hasRejectedAnthropicQuotaWindow(response.headers)) return true;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    if (!body.displaySafe || body.truncated) return false;
    const json = JSON.parse(body.text) as { error?: unknown };
    return isExplicitQuotaError(json?.error);
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

export function compactionQuotaErrorResponse(message: string, retryAfter?: string | null): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  const validatedRetryAfter = validateClientRetryAfterHeader(retryAfter, Date.now());
  if (validatedRetryAfter !== undefined) headers.set("Retry-After", validatedRetryAfter);
  // Both installed Codex compaction paths recognize this standard terminal quota code.
  // Do not impersonate an OpenAI subscription or synthesize plan/reset metadata.
  return new Response(JSON.stringify({ error: { message, type: "insufficient_quota", code: "insufficient_quota" } }), { status: 429, headers });
}

export async function* recoverCompactionQuotaEvents(events: AsyncIterable<AdapterEvent> | Iterable<AdapterEvent>, headers: Headers, enabled: boolean): AsyncGenerator<AdapterEvent> {
  for await (const event of events) {
    if (enabled && event.type === "error" && (event.providerErrorType === "insufficient_quota"
      || ((event.status === 429 || event.providerErrorType === "rate_limit_error") && hasRejectedAnthropicQuotaWindow(headers)))) {
      // Preserve the source event identity and its retained translator-budget lease.
      event.status = 429;
      event.errorType = "insufficient_quota";
      event.code = "insufficient_quota";
      event.retryable = false;
      yield event;
    } else yield event;
  }
}

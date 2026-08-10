/**
 * Shadow-call intercept source models.
 *
 * Current Codex uses `gpt-5.6-luna` for helper calls. Every surface that names
 * the intercepted model (management API, GUI badges/tooltips, CLI) reads it
 * from here instead of hard-coding a slug that goes stale on the next client bump.
 */
export const DEFAULT_SHADOW_SOURCE_MODELS = ["gpt-5.6-luna"] as const;

/** Normalize a persisted `sourceModels` override; falls back to the defaults. */
export function shadowSourceModels(configured?: unknown): string[] {
  const configuredStrings = Array.isArray(configured)
    ? configured
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map(v => v.trim())
    : [];
  return configuredStrings.length > 0 ? configuredStrings : [...DEFAULT_SHADOW_SOURCE_MODELS];
}

/**
 * True when `modelId` is one of Codex's helper/shadow source models.
 * Routed ids (`provider/model`) are hard-excluded: a shadow call is always a
 * bare native slug, and an explicit routed selection must never be hijacked.
 */
export function isShadowSourceModel(modelId: string, configured?: unknown): boolean {
  if (modelId.includes("/")) return false;
  return shadowSourceModels(configured).some(prefix => modelId.startsWith(prefix));
}

/**
 * Decide whether a matching source model should use the opt-in intercept.
 *
 * Current Codex identifies maintenance requests in x-codex-turn-metadata.
 * Missing, malformed, or unknown metadata fails closed and is never intercepted.
 */
export function shouldInterceptShadowCall(
  modelId: string,
  configured: unknown,
  headers: Headers,
): boolean {
  if (!isShadowSourceModel(modelId, configured)) return false;
  const rawMetadata = headers.get("x-codex-turn-metadata");
  if (rawMetadata === null) return false;

  try {
    const parsed = JSON.parse(rawMetadata) as { request_kind?: unknown };
    return parsed.request_kind === "memory"
      || parsed.request_kind === "compaction"
      || parsed.request_kind === "prewarm";
  } catch {
    return false;
  }
}

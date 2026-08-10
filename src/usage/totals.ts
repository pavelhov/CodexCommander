import type { CodexCommanderUsage } from "../types";

/**
 * Canonical display total (implementation contract): `inputTokens` is already INCLUSIVE of cache
 * read/write, so the total is simply input+output. Cache detail is never re-added.
 */
export function usageDisplayTotalTokens(usage: CodexCommanderUsage | undefined, storedTotal?: number): number | undefined {
  if (!usage) return storedTotal;
  return usage.inputTokens + usage.outputTokens;
}

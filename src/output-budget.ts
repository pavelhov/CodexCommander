import type { CodexCommanderConfig, CodexCommanderParsedRequest, CodexCommanderProviderConfig } from "./types";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED, pinnedWireAdapter } from "./types";
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive } from "./generated/jawcode-model-metadata";
import { getProviderRegistryEntry, providerMatchesRegistryMetadataDestination } from "./providers/registry";
import { isCanonicalAnthropicEndpoint } from "./lib/anthropic-endpoint";
import { modelRecordValue } from "./reasoning-effort";

export type OutputTokenPolicy = "request" | "model-max";

/** Existing installations receive the same output policy as new configurations. */
export function effectiveOutputTokenPolicy(config: Pick<CodexCommanderConfig, "outputTokenPolicy">): OutputTokenPolicy {
  return config.outputTokenPolicy ?? "model-max";
}

/** Resolve capacity only for the destination whose model metadata we know. */
export function knownModelOutputTokenLimit(provider: CodexCommanderProviderConfig, modelId: string): number | undefined {
  const registryId = provider._registryId
    ?? (provider.adapter === "anthropic" && isCanonicalAnthropicEndpoint(provider.baseUrl) ? "anthropic" : undefined);
  if (!registryId) return undefined;
  const entry = getProviderRegistryEntry(registryId);
  if (!entry) return undefined;
  // Mixed-wire gateways choose their model-specific adapter after routing. Their
  // destination's capacity metadata remains valid across those reviewed wire choices.
  const declared = entry.modelWireDefaults?.[modelId.trim().toLowerCase()];
  const registryWire = typeof declared === "string" ? declared : declared?.wire;
  const configuredWire = provider.modelAdapters?.[modelId];
  const knownWire = provider.adapter === entry.adapter
    || pinnedWireAdapter(registryId, modelId) === provider.adapter
    || (MODEL_ADAPTER_OVERRIDE_ALLOWED.has(provider.adapter)
      && (registryWire === provider.adapter || configuredWire === provider.adapter));
  if (!knownWire || !providerMatchesRegistryMetadataDestination(registryId, { ...provider, adapter: entry.adapter })) return undefined;
  const bundle = entry.jawcodeBundle ?? (entry.id === "openai-apikey" ? "openai" : entry.id);
  const id = bundle === "anthropic"
    ? modelId.replace(/^anthropic\//, "")
      .replace(/\.(\d+)/g, "-$1")
      .replace(/\[1m\]$/, "")
      .replace(/-\d{8}$/, "")
    : modelId;
  const override = modelRecordValue(entry.modelOutputTokenLimits, id);
  const metadata = entry.metadataModelIdNormalize === "case-insensitive"
    ? getJawcodeModelMetadataCaseInsensitive(bundle, id)
    : getJawcodeModelMetadata(bundle, id);
  if (override === undefined && metadata?.contextWindow !== undefined
    && metadata.contextWindow > 0 && metadata.maxTokens !== undefined
    && metadata.maxTokens > metadata.contextWindow) return undefined;
  const limit = override ?? metadata?.maxTokens;
  // The OpenRouter bundle uses 8888 for undisclosed output limits.
  if (bundle === "openrouter" && limit === 8888) return undefined;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

export function resolveOutputTokenBudget(
  provider: CodexCommanderProviderConfig,
  parsed: CodexCommanderParsedRequest,
  fallback?: number,
): number | undefined {
  const explicit = parsed.options.maxOutputTokens;
  if (parsed._compactionRequest === true) return explicit ?? fallback;
  const known = knownModelOutputTokenLimit(provider, parsed.modelId);
  if (provider._outputTokenPolicy === "model-max" && known !== undefined) return known;
  return explicit
    ?? modelRecordValue(provider.modelMaxOutputTokens, parsed.modelId)
    ?? provider.defaultMaxOutputTokens
    ?? known
    ?? fallback;
}

/** Native Messages passthrough invokes this only after its canonical endpoint gate. */
export function resolveNativeAnthropicOutputTokens(
  policy: OutputTokenPolicy | undefined,
  modelId: string,
  explicit: number | undefined,
  compaction: boolean,
): number | undefined {
  if (policy !== "model-max" || compaction) return explicit;
  return knownModelOutputTokenLimit({ adapter: "anthropic", baseUrl: "https://api.anthropic.com" }, modelId) ?? explicit;
}

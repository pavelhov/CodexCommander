/**
 * Candidate capability evidence for policy routing (RI-05).
 *
 * Evidence comes from canonical local sources only - provider config maps,
 * explicit custom-model metadata, the provider registry, and native-model
 * metadata helpers. No live network fetch or generated-catalog inference
 * happens at routing time.
 *
 * "Unknown is not zero": any dimension without canonical evidence stays
 * `undefined` (unknown) and the profile's `unknownEvidence` policy decides
 * how that affects eligibility.
 */

import type { CodexCommanderConfig } from "../types";
import { modelInList } from "../types";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { PROVIDER_REGISTRY, providerMatchesRegistryTransport } from "../providers/registry";
import { modelRecordValue, sanitizeCodexReasoningEfforts } from "../reasoning-effort";
import { applyProviderContextCap, providerContextCap } from "../providers/context-cap";
import {
  nativeInputModalities,
  nativeOpenAiContextWindow,
  nativeReasoningEfforts,
} from "../codex/catalog/metadata";
import type { RouteCapabilityEvidence } from "./trace";

/**
 * Classify a hostname for locality evidence. `URL.hostname` keeps IPv6
 * literals bracketed (`[::1]`), so strip the brackets before matching.
 * Anything not positively local or private stays unknown: "unknown is not
 * zero", so an unrecognized host must never assert `remoteAllowed`.
 */
function classifyHostname(hostname: string): "local" | "private" | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") return "local";
  if (host === "::1" || /^127\./.test(host)) return "local";
  if (/^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host)
    || /^fe80:/.test(host)
    || /^::ffff:(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) {
    return "private";
  }
  return null;
}

/**
 * Adapters whose upstream protocol supports function/tool calling. Mirrors
 * the adapter ids the resolver accepts; `kiro` and `mimo-free` send/delegate
 * tool calls.
 */
const TOOL_CAPABLE_ADAPTERS = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic",
  "cursor",
  "google",
  "azure-openai",
  "kiro",
  "mimo-free",
  "command-code",
]);

function localRemoteEvidence(baseUrl: string | undefined): Pick<RouteCapabilityEvidence, "localOnly" | "remoteAllowed"> {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return {};
  try {
    const hostname = new URL(baseUrl).hostname;
    if (!hostname) return {};
    const kind = classifyHostname(hostname);
    if (kind === null) return {};
    // Both booleans are emitted once classified: definitive negative evidence,
    // so a local host cannot satisfy `require.remoteAllowed` (or vice versa)
    // under `unknownEvidence.capability: "allow"`/`"penalize"`.
    return kind === "local" || kind === "private"
      ? { localOnly: true, remoteAllowed: false }
      : { remoteAllowed: true, localOnly: false };
  } catch {
    return {};
  }
}

/**
 * Assemble canonical capability evidence for one `provider/model` candidate.
 * Sources (in priority order): provider config maps, explicit custom-model
 * metadata, provider registry hints, native-model metadata.
 */
export function candidateCapabilityEvidence(
  config: CodexCommanderConfig,
  providerName: string,
  modelId: string,
): RouteCapabilityEvidence {
  const provider = config.providers[providerName];
  const registryEntry = provider && providerMatchesRegistryTransport(providerName, provider)
    ? PROVIDER_REGISTRY.find(entry => entry.id === providerName)
    : undefined;
  const customModel = config.customModels?.find(model =>
    model.provider === providerName && model.modelId === modelId);
  const isNative = providerName === "openai" && !modelId.includes("/");

  const providerModelContext = modelRecordValue(provider?.modelContextWindows, modelId);
  const registryModelContext = modelRecordValue(registryEntry?.modelContextWindows, modelId);
  const uncappedContextWindow = customModel?.contextWindow
    ?? (providerName === "openai-apikey"
      && providerModelContext !== undefined
      && registryModelContext !== undefined
        ? Math.min(providerModelContext, registryModelContext)
        : providerModelContext ?? registryModelContext)
    ?? provider?.contextWindow
    ?? registryEntry?.contextWindow
    ?? (isNative ? nativeOpenAiContextWindow(modelId) : undefined);
  const contextWindow = customModel?.contextWindow !== undefined
    ? uncappedContextWindow
    : applyProviderContextCap(uncappedContextWindow, providerContextCap(config, providerName));

  const modalities = customModel?.inputModalities
    ?? modelRecordValue(provider?.modelInputModalities, modelId)
    ?? modelRecordValue(registryEntry?.modelInputModalities, modelId)
    ?? (isNative ? nativeInputModalities(modelId) : undefined);
  const image = Array.isArray(modalities)
    ? modalities.includes("image")
    : undefined;

  // Adapter protocol support is positive tool evidence even when the provider
  // does not opt into parallel calls. `parallelToolCalls` remains an explicit
  // positive override; neither source infers a negative capability.
  const tools = isNative
    || (provider !== undefined && TOOL_CAPABLE_ADAPTERS.has(provider.adapter))
    || provider?.parallelToolCalls === true
    || undefined;

  const reasoningDisabled = modelInList(provider?.noReasoningModels, modelId)
    || modelInList(registryEntry?.noReasoningModels, modelId);
  const configuredReasoning = reasoningDisabled
    ? []
    : modelRecordValue(provider?.modelReasoningEfforts, modelId)
      ?? modelRecordValue(registryEntry?.modelReasoningEfforts, modelId)
      ?? provider?.reasoningEfforts
      ?? registryEntry?.reasoningEfforts;
  const reasoningEfforts = configuredReasoning === undefined
    ? (isNative ? nativeReasoningEfforts(modelId) : undefined)
    : sanitizeCodexReasoningEfforts(configuredReasoning) ?? [];

  const tierSupport = provider?.supportsServiceTier
    ?? registryEntry?.supportsServiceTier;
  const serviceTier = tierSupport === true
    ? "supported"
    : tierSupport === false ? "unsupported" : "unknown";

  const localRemote = localRemoteEvidence(provider?.baseUrl);
  // Only emit a definitive encryptedCodexTasks value when the provider is
  // present. An absent/unconfigured provider must stay unknown so
  // require.encryptedCodexTasks does not fail closed on missing config.
  const encryptedCodexTasks = provider === undefined
    ? undefined
    : isCanonicalOpenAiForwardProvider(provider);

  return {
    ...(typeof contextWindow === "number" ? { contextWindow } : {}),
    ...(typeof image === "boolean" ? { image } : {}),
    ...(typeof tools === "boolean" ? { tools } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(serviceTier !== "unknown" ? { serviceTier } : {}),
    ...localRemote,
    ...(typeof encryptedCodexTasks === "boolean" ? { encryptedCodexTasks } : {}),
  };
}

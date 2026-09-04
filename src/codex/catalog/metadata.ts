import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { atomicWriteFile, expandUserPath, getConfigDir, websocketsEnabled } from "../../config";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, readRootTomlString, resolveCodexConfigPath } from "../paths";
import { clearModelCache, DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, isModelsFetchCoolingDown, markModelsFetchFailure, setCached } from "../model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "../../oauth";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../../types";
import { modelInList } from "../../types";
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive, listJawcodeModelMetadata, resolveJawcodeProvider } from "../../generated/jawcode-model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import { getProviderRegistryEntry } from "../../providers/registry";
import { applyProviderContextCap, providerContextCap } from "../../providers/context-cap";
import { routedSlug, slugEquals, slugsEquivalent } from "../../providers/slug-codec";
import { CODEX_GPT5_IDENTITY_LINE } from "../../adapters/identity";
import { filterCursorConfiguredModelsByLiveDiscovery } from "../../adapters/cursor/discovery";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import { isCanonicalOpenAiForwardProvider, OPENAI_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import {
  COMBO_NAMESPACE,
  comboModelId,
  getCombo,
  isNativeAliasCombo,
  listComboIds,
  targetKey,
} from "../../combos/types";
import type { NormalizedComboConfig } from "../../combos/types";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { redactSecretString } from "../../lib/redact";
import upstreamModelsSnapshot from "../data/upstream-models.json";


import type { RawEntry } from "./parsing";
import { bundledCatalogCacheState, loadBundledCodexCatalog, readCurrentCatalogOrCache, unique, type BundledCatalogDeps } from "./bundled";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
import { LEGACY_NATIVE_OPENAI_MODELS } from "./native-models";
export { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
export {
  LEGACY_NATIVE_OPENAI_MODELS,
  LEGACY_NATIVE_OPENAI_MODELS as NATIVE_OPENAI_MODELS,
  LEGACY_SUPPORTED_NATIVE_OPENAI_SLUGS,
  LEGACY_SUPPORTED_NATIVE_OPENAI_SLUGS as SUPPORTED_NATIVE_OPENAI_SLUGS,
} from "./native-models";

export type NativeCatalogMode = "bundled-all" | "bundled-listed";

export const DEFAULT_NATIVE_CATALOG_MODE: NativeCatalogMode = "bundled-all";

export interface NativeCatalogSelectionOptions extends BundledCatalogDeps {
  nativeCatalogMode?: NativeCatalogMode;
}

function resolveNativeCatalogMode(mode?: NativeCatalogMode): NativeCatalogMode {
  return mode === "bundled-listed" ? "bundled-listed" : DEFAULT_NATIVE_CATALOG_MODE;
}

export function isBareBundledNativeCatalogEntry(entry: RawEntry): boolean {
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  return slug.length > 0
    && !slug.includes("/")
    && !isNativeAliasCatalogEntry(entry)
    && entry.owned_by !== COMBO_NAMESPACE;
}

function matchesNativeCatalogVisibility(
  entry: RawEntry,
  mode: NativeCatalogMode,
): boolean {
  if (mode === "bundled-all") return true;
  return entry.visibility === "list";
}

export function bundledNativeCatalogEntries(
  deps: BundledCatalogDeps = {},
  mode: NativeCatalogMode = DEFAULT_NATIVE_CATALOG_MODE,
): RawEntry[] {
  const catalog = loadBundledCodexCatalog(deps);
  const resolvedMode = resolveNativeCatalogMode(mode);
  return (catalog?.models ?? []).filter(entry =>
    isBareBundledNativeCatalogEntry(entry)
    && matchesNativeCatalogVisibility(entry, resolvedMode),
  );
}

export function bundledNativeCatalogSlugs(
  deps: BundledCatalogDeps = {},
  mode: NativeCatalogMode = DEFAULT_NATIVE_CATALOG_MODE,
): string[] {
  return unique(bundledNativeCatalogEntries(deps, mode).flatMap(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    return slug.length > 0 ? [slug] : [];
  }));
}

function onDiskBareNativeRecoverySlugs(deps: BundledCatalogDeps = {}): string[] {
  const cat = readCurrentCatalogOrCache(deps);
  return unique((cat?.models ?? []).flatMap(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    return isBareBundledNativeCatalogEntry(entry) && /^(?:gpt|codex)-/.test(slug) ? [slug] : [];
  }));
}

type SupportedNativeSlugMemo = {
  key: string;
  slugs: string[];
  slugSet: Set<string>;
};

let supportedNativeSlugMemo: SupportedNativeSlugMemo | null = null;

function hasInjectedNativeCatalogDeps(options: NativeCatalogSelectionOptions): boolean {
  return Boolean(
    options.commandCandidates
      || options.execFileSync
      || options.configDir
      || options.env
      || options.platform
      || options.existsSync
      || options.readFileSync
      || options.now
      || options.discoverAlternatives,
  );
}

function supportedNativeSlugMemoKey(mode: NativeCatalogMode): string {
  return `${mode}\0${bundledCatalogCacheState().epoch}`;
}

function computeSupportedNativeOpenAiSlugs(
  options: NativeCatalogSelectionOptions = {},
): string[] {
  const mode = resolveNativeCatalogMode(options.nativeCatalogMode);
  const bundled = bundledNativeCatalogSlugs(options, mode);
  if (bundled.length > 0) {
    return unique([...bundled, ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS, ...onDiskBareNativeRecoverySlugs(options)]);
  }
  const recovered = onDiskBareNativeRecoverySlugs(options);
  if (recovered.length > 0) {
    return unique([...recovered, ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS]);
  }
  return [...LEGACY_NATIVE_OPENAI_MODELS];
}

export function supportedNativeOpenAiSlugs(
  options: NativeCatalogSelectionOptions = {},
): string[] {
  if (hasInjectedNativeCatalogDeps(options)) {
    return computeSupportedNativeOpenAiSlugs(options);
  }
  const mode = resolveNativeCatalogMode(options.nativeCatalogMode);
  const key = supportedNativeSlugMemoKey(mode);
  if (supportedNativeSlugMemo?.key === key) {
    return supportedNativeSlugMemo.slugs;
  }
  const slugs = computeSupportedNativeOpenAiSlugs(options);
  supportedNativeSlugMemo = { key, slugs, slugSet: new Set(slugs) };
  return slugs;
}

export function supportedNativeOpenAiSlugSet(
  options: NativeCatalogSelectionOptions = {},
): Set<string> {
  if (hasInjectedNativeCatalogDeps(options)) {
    return new Set(computeSupportedNativeOpenAiSlugs(options));
  }
  const mode = resolveNativeCatalogMode(options.nativeCatalogMode);
  const key = supportedNativeSlugMemoKey(mode);
  if (supportedNativeSlugMemo?.key === key) {
    return supportedNativeSlugMemo.slugSet;
  }
  const slugs = supportedNativeOpenAiSlugs(options);
  return supportedNativeSlugMemo?.slugSet ?? new Set(slugs);
}

export function isSupportedNativeOpenAiSlug(
  slug: string,
  options: NativeCatalogSelectionOptions = {},
): boolean {
  return supportedNativeOpenAiSlugSet(options).has(slug);
}

export const DOCUMENTED_NATIVE_OPENAI_ADDITIONS = [
  "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

export function configuredNativeAliasSlugs(
  config: Pick<CodexCommanderConfig, "combos" | "nativeCatalogMode">,
  deps: BundledCatalogDeps = {},
): Set<string> {
  const aliases = new Set<string>();
  const supported = supportedNativeOpenAiSlugSet({ ...deps, nativeCatalogMode: config.nativeCatalogMode });
  for (const raw of Object.values(config.combos ?? {})) {
    if (!isNativeAliasCombo(raw)) continue;
    const alias = raw.alias!.trim();
    if (supported.has(alias)) aliases.add(alias);
  }
  return aliases;
}

/**
 * Bare native rows that must be absent, rather than merely hidden, while Desktop native-alias
 * compatibility is active. Codex Desktop's remote allowlist can ignore `visibility: "hide"`;
 * omitting disabled native rows is therefore part of the explicit native-alias opt-in.
 */
export function desktopAllowlistSuppressedNativeSlugs(
  config: Pick<CodexCommanderConfig, "combos" | "disabledModels" | "nativeCatalogMode">,
  deps: BundledCatalogDeps = {},
): Set<string> {
  const suppressed = configuredNativeAliasSlugs(config, deps);
  if (suppressed.size === 0) return suppressed;
  const disabled = disabledNativeSlugs(config);
  for (const slug of supportedNativeOpenAiSlugs({ ...deps, nativeCatalogMode: config.nativeCatalogMode })) {
    if (disabled.has(slug)) suppressed.add(slug);
  }
  return suppressed;
}

export function isNativeAliasCatalogEntry(entry: RawEntry): boolean {
  return entry.codexcommander_catalog_kind === CODEX_NATIVE_ALIAS_CATALOG_KIND;
}

export function isUnsupportedOpenAiNativeSlug(
  slug: string,
  options: NativeCatalogSelectionOptions = {},
): boolean {
  if (slug.includes("/")) return false;
  if (isSupportedNativeOpenAiSlug(slug, options)) return false;
  return /^(?:gpt|codex)-/.test(slug);
}

/** Test-only: clear the supported-native slug memo (sync.ts calls this via resetCatalogRuntimeStateForTests). */
export function resetSupportedNativeSlugMemoForTests(): void {
  supportedNativeSlugMemo = null;
}

export const NATIVE_GPT56_CONTEXT_WINDOW = 372_000;

export const NATIVE_OPENAI_CONTEXT_OVERRIDES: Record<string, { contextWindow?: number; maxContextWindow?: number }> = {
  "gpt-5.5": { contextWindow: 272_000, maxContextWindow: 272_000 },
  "gpt-5.4": { contextWindow: 1_000_000, maxContextWindow: 1_000_000 },
  "gpt-5.3-codex-spark": { contextWindow: 100_000, maxContextWindow: 100_000 },
  "gpt-5.6-sol": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_CONTEXT_WINDOW },
  "gpt-5.6-terra": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_CONTEXT_WINDOW },
  "gpt-5.6-luna": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_CONTEXT_WINDOW },
};

/**
 * Pinned capability metadata is safe to use as a fallback for every supported native model.
 * Keep it separate from UPSTREAM_NATIVE_ENTRIES: that narrower map also authorizes replacing
 * persisted native rows during sync, which is currently intentional only for the GPT-5.6 family.
 */
const PINNED_NATIVE_CAPABILITY_ENTRIES: Map<string, RawEntry> = new Map(
  ((upstreamModelsSnapshot as unknown as { models?: RawEntry[] }).models ?? [])
    .filter(m => typeof m.slug === "string"
      && /^(?:gpt|codex)-/.test(m.slug as string))
    .map(m => [m.slug as string, m]),
);

export function nativeOpenAiContextWindow(slug: string): number | undefined {
  return NATIVE_OPENAI_CONTEXT_OVERRIDES[slug]?.contextWindow
    ?? (typeof PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.context_window === "number"
      ? PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)!.context_window as number
      : undefined);
}

export function nativeInputModalities(slug: string): string[] {
  const upstream = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug);
  if (Array.isArray(upstream?.input_modalities) && upstream!.input_modalities!.length > 0) {
    return [...upstream!.input_modalities as string[]];
  }
  // gpt-5.3-codex-spark is not in the upstream snapshot; all supported natives are
  // text+image capable, so default to the family baseline rather than text-only.
  return ["text", "image"];
}

export function nativeReasoningEfforts(slug: string): string[] {
  const upstream = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug);
  const levels = Array.isArray(upstream?.supported_reasoning_levels)
    ? upstream!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length > 0) {
    // Preserve the exact pinned per-model ladder. In particular, GPT-5.6 Sol and Terra
    // include ultra while Luna intentionally ends at max.
    return levels.flatMap(l => typeof l.effort === "string" ? [l.effort] : []);
  }
  // gpt-5.3-codex-spark is not in upstream snapshot — use the standard old-ladder default.
  return ["low", "medium", "high", "xhigh"];
}

/** Upstream-pinned default for a native slug, when present and non-empty. */
export function nativeDefaultReasoningEffort(slug: string): string | undefined {
  const level = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.default_reasoning_level;
  return typeof level === "string" && level.length > 0 ? level : undefined;
}

/** Upstream-pinned multi-agent surface for a supported native slug, when present. */
export function nativeMultiAgentVersion(slug: string): string | undefined {
  const version = PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.multi_agent_version;
  return typeof version === "string" && version.length > 0 ? version : undefined;
}

export function nativeParallelToolCalls(slug: string): boolean {
  return PINNED_NATIVE_CAPABILITY_ENTRIES.get(slug)?.supports_parallel_tool_calls === true
    || false;
}

export function hasComboTargets(config: { combos?: Record<string, { targets?: unknown[] }> }): boolean {
  const combos = config.combos;
  if (!combos) return false;
  return Object.values(combos).some(c => Array.isArray(c?.targets) && c!.targets!.length > 0);
}

export function disabledNativeSlugs(config: Pick<CodexCommanderConfig, "disabledModels">): Set<string> {
  return new Set((config.disabledModels ?? []).filter(id => !id.includes("/")));
}

export function visibleNativeSlugs(
  config: Pick<CodexCommanderConfig, "disabledModels" | "combos" | "nativeCatalogMode">,
  deps: BundledCatalogDeps = {},
): string[] {
  const disabled = disabledNativeSlugs(config);
  const shadowed = configuredNativeAliasSlugs(config, deps);
  return nativeOpenAiSlugs(deps, config.nativeCatalogMode).filter(slug => !disabled.has(slug) && !shadowed.has(slug));
}

/** Whether an enabled canonical OpenAI provider can serve exact account-qualified routes. */
export function shouldIncludeAccountBoundNativeOpenAi(
  config: Pick<CodexCommanderConfig, "providers">,
): boolean {
  const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!provider || provider.disabled === true) return false;
  // Registry routing defaults an omitted authMode on the built-in OpenAI row to forward.
  const canonical = provider.authMode === undefined
    ? { ...provider, authMode: "forward" as const }
    : provider;
  return isCanonicalOpenAiForwardProvider(canonical);
}

/** Whether native ChatGPT/Codex rows belong in this provider configuration. */
export function shouldIncludeNativeOpenAi(config: Pick<CodexCommanderConfig, "providers">): boolean {
  const hasEnabledProvider = Object.values(config.providers)
    .some(provider => provider.disabled !== true);
  // Preserve the existing no-enabled-provider catalog bootstrap, but do not use that bootstrap
  // exception for account-qualified rows: exact-account routing requires a live OpenAI provider.
  return !hasEnabledProvider || shouldIncludeAccountBoundNativeOpenAi(config);
}

/** Native slugs exposed to Claude Desktop show/export/apply (opt-out via claudeCode.desktopNativeModels). */
export function desktopVisibleNativeSlugs(
  config: Pick<CodexCommanderConfig, "claudeCode" | "disabledModels" | "combos" | "nativeCatalogMode">,
  deps: BundledCatalogDeps = {},
): string[] {
  if (config.claudeCode?.desktopNativeModels === false) return [];
  return visibleNativeSlugs(config, deps);
}

export function nativeModelRows(
  config: Pick<CodexCommanderConfig, "disabledModels" | "combos" | "nativeCatalogMode">,
  deps: BundledCatalogDeps = {},
): Array<{ slug: string; disabled: boolean; contextWindow?: number }> {
  const disabled = disabledNativeSlugs(config);
  const shadowed = configuredNativeAliasSlugs(config, deps);
  return supportedNativeOpenAiSlugs({ ...deps, nativeCatalogMode: config.nativeCatalogMode })
    .filter(slug => !shadowed.has(slug))
    .map(slug => {
    const contextWindow = nativeOpenAiContextWindow(slug);
    return { slug, disabled: disabled.has(slug), ...(contextWindow !== undefined ? { contextWindow } : {}) };
  });
}

export function applyNativeVisibility(
  entries: RawEntry[],
  disabledModels: ReadonlySet<string>,
  hideBareNative = false,
  options: NativeCatalogSelectionOptions = {},
  supportedNativeSlugs?: ReadonlySet<string>,
): RawEntry[] {
  const supported = supportedNativeSlugs ?? supportedNativeOpenAiSlugSet(options);
  for (const entry of entries) {
    if (isNativeAliasCatalogEntry(entry)) continue;
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const accountBoundSlug = trustedAccountBoundNativeCatalogSlug(entry);
    const nativeSlug = accountBoundSlug ?? slug;
    if (!nativeSlug
      || (!accountBoundSlug && slug.includes("/"))
      || !supported.has(nativeSlug)) continue;
    const disabled = disabledModels.has(nativeSlug)
      || (accountBoundSlug !== undefined && disabledModels.has(slug));
    entry.visibility = disabled || (!accountBoundSlug && hideBareNative)
      ? "hide"
      : "list";
  }
  return entries;
}

export const UPSTREAM_NATIVE_ENTRIES: Map<string, RawEntry> = new Map(
  ((upstreamModelsSnapshot as unknown as { models?: RawEntry[] }).models ?? [])
    .filter(m => typeof m.slug === "string"
      && /^(?:gpt|codex)-/.test(m.slug as string)
      && (m.slug as string).startsWith("gpt-5.6-"))
    .map(m => [m.slug as string, m]),
);

export function upstreamNativeEntry(slug: string): RawEntry | null {
  const entry = UPSTREAM_NATIVE_ENTRIES.get(slug);
  if (!entry) return null;
  const clone = JSON.parse(JSON.stringify(entry)) as RawEntry;
  delete clone.minimal_client_version;
  return clone;
}

export function shouldUpgradeToUpstreamEntry(entry: RawEntry): boolean {
  return typeof entry.slug === "string"
    && UPSTREAM_NATIVE_ENTRIES.has(entry.slug)
    && entry.display_name === entry.slug;
}

export function nativeOpenAiSlugs(
  deps: BundledCatalogDeps = {},
  mode?: NativeCatalogMode,
): string[] {
  return supportedNativeOpenAiSlugs({ ...deps, nativeCatalogMode: mode });
}

export function listCatalogNativeSlugs(
  deps: BundledCatalogDeps = {},
  mode?: NativeCatalogMode,
): string[] {
  const resolvedMode = resolveNativeCatalogMode(mode);
  const bundled = bundledNativeCatalogSlugs(deps, resolvedMode);
  const recovered = onDiskBareNativeRecoverySlugs(deps);
  const models = readCurrentCatalogOrCache(deps)?.models ?? [];
  const accountBound = models.flatMap(entry => {
    const slug = trustedAccountBoundNativeCatalogSlug(entry);
    return slug !== undefined && isSupportedNativeOpenAiSlug(slug, { ...deps, nativeCatalogMode: resolvedMode })
      ? [slug]
      : [];
  });
  // Deliberately ignore `visibility`: it is a rendered projection of disabledModels and account
  // selectors, so treating it as fresh availability would shrink the supported set between syncs.
  // visibleNativeSlugs applies the current disabledModels source of truth for public consumers.
  // Ensure documented additions (e.g. gpt-5.3-codex-spark) appear even when the bundled catalog
  // predates the slug — mirrors nativeOpenAiSlugs() which already merges them for /v1/models.
  return unique([...bundled, ...recovered, ...accountBound, ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS]);
}

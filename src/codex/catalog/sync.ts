import { existsSync, readFileSync } from "node:fs";
import { loadConfig, readConfigDiagnostics } from "../../config";
import { shouldSyncCodexOnStart } from "../desired-state";
import { getCodexHome } from "../paths";
import { clearModelCache } from "../model-cache";
import type { CodexCommanderConfig } from "../../types";
import { modelInList } from "../../types";
import { CODEX_REASONING_LEVELS } from "../../reasoning-effort";
import { routedSlug } from "../../providers/slug-codec";
import { identifyRoutedModel } from "../../adapters/identity";
import {
  COMBO_NAMESPACE,
  comboModelId,
  getCombo,
} from "../../combos";


import { activeCodexModelsCachePath, applyJawcodeCatalogMetadata, applyMultiAgentMode, applyNativeOpenAiContextOverride, catalogModelSlug, ensureStrictCatalogFields, isRoutedModelCompatibilityExcluded, normalizeRoutedCatalogEntry, normalizeServiceTiers, readCatalog, readCatalogBackup, readCodexCatalogPath } from "./parsing";
import type { CatalogModel, MultiAgentMode, RawCatalog, RawEntry } from "./parsing";
import { applyNativeVisibility, CODEX_NATIVE_ALIAS_CATALOG_KIND, isNativeAliasCatalogEntry, isUnsupportedOpenAiNativeSlug, NATIVE_OPENAI_MODELS, shouldUpgradeToUpstreamEntry, SUPPORTED_NATIVE_OPENAI_SLUGS, upstreamNativeEntry } from "./metadata";
import {
  resetBundledCatalogCacheForTests,
} from "./bundled";
import { isMultiAgentV2Enabled } from "../features";
import { applyCatalogModelMetadata, applyReasoningLevels, catalogEntryEfforts, ensureGpt56ReasoningLevels, ensureUltraReasoningLevel, isGpt56NativeSlug } from "./effort";
import { clearGatherRoutedModelsInflight, lastDropWarnSignature } from "./provider-fetch";
import { accountSelectorShadowCollisionWarnings, clearLastComboCatalogOmissions, comboCatalogWarningSignatures, comboMasqueradeCollisionWarnings, openAiApiCollisionWarnings, resolveSlugAliasCollisions, slugAliasCollisionWarnings, warnAccountSelectorShadowedProviderOnce, warnComboMasqueradeCollisionOnce } from "./aggregation";
import {
  withCatalogWriteSerialization,
  type CatalogWritePermit,
} from "../catalog-write-serialization";
import {
  replaceActiveCodexCatalog,
  replaceCodexModelsCache,
} from "../internal/catalog-writer";
import { accountBoundNativeDisplayName, CODEX_ACCOUNT_BOUND_CATALOG_KIND, trustedAccountBoundNativeCatalogSlug } from "./account-models";

export const MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5;

/**
 * Where the routed rows in the committed Codex catalog came from.
 *
 * - `live`: routed rows were gathered live from providers this sync.
 * - `retained`: the live gather yielded nothing and the on-disk catalog had no
 *   routed rows, so rows were rehydrated from the CodexCommander-owned last-known-good
 *   snapshot for providers still configured.
 * - `native-only`: the committed catalog has no CodexCommander-routed rows (nothing to
 *   restore); with routed providers configured this is a degraded state and must
 *   surface an actionable warning rather than a false fully-ready success.
 */
export type CatalogQuality = "live" | "retained" | "native-only";

export type SpawnAgentSurface = "v1" | "v2";

export type SubagentRosterExclusionReason =
  | "missing_catalog_entry"
  | "picker_hidden"
  | "surface_incompatible"
  | "outside_display_limit";

/**
 * Whether a catalog entry may be offered as a V2 subagent model.
 *
 * Upstream (codex-rs 92938d880) requires `multi_agent_version === "v2"` exactly,
 * because upstream assumes a single backend serves every model. codexcommander routes
 * many providers, so that equality would reject the cross-provider spawns this
 * proxy exists to enable.
 *
 * Any model codexcommander actually routes is eligible. An entry pinned to a DIFFERENT
 * multi-agent backend (`v1`) stays excluded, because that pin is a real capability
 * statement rather than an absence of information. An unpinned entry (null or
 * absent) is a routed or unpinned-native model and is allowed. The three-way
 * distinction is the substance; do not flatten it into a truthiness check.
 */
export function isEligibleV2SubagentEntry(entry: RawEntry): boolean {
  const pinned = entry.multi_agent_version;
  return pinned === "v2" || pinned === null || pinned === undefined;
}

export interface EffectiveSubagentModel {
  model: string;
  efforts: string[];
}

export interface SubagentRosterExclusion {
  configured: string;
  reason: SubagentRosterExclusionReason;
  catalogModel?: string;
}

export interface EffectiveSubagentRoster {
  candidates: EffectiveSubagentModel[];
  advertised: EffectiveSubagentModel[];
  excluded: SubagentRosterExclusion[];
}

export function configuredCatalogEntry(entries: readonly RawEntry[], configured: string): RawEntry | undefined {
  return entries.find(entry => entry.slug === configured);
}

export function configuredSubagentModelMatchesEntry(configured: string, entry: RawEntry): boolean {
  if (typeof entry.slug !== "string") return false;
  if (configured === entry.slug) return true;
  const nativeSlug = trustedAccountBoundNativeCatalogSlug(entry);
  return !configured.includes("/")
    && nativeSlug !== undefined
    && SUPPORTED_NATIVE_OPENAI_SLUGS.has(nativeSlug)
    && configured === nativeSlug;
}

export function effectiveSubagentRoster(
  configuredModels: readonly string[],
  surface: SpawnAgentSurface,
  catalogEntries?: readonly RawEntry[],
): EffectiveSubagentRoster {
  const configured = configuredModels
    .filter(model => model.trim().length > 0)
    .filter((model, index, all) =>
      !all.slice(0, index).some(previous => previous === model)
    );
  const entries = catalogEntries ?? readCatalog(readCodexCatalogPath())?.models ?? [];
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => typeof entry.slug === "string")
    .filter(({ entry }) => entry.visibility === "list")
    .filter(({ entry }) => surface !== "v2" || isEligibleV2SubagentEntry(entry))
    .sort((left, right) => {
      const leftPriority = typeof left.entry.priority === "number" && Number.isFinite(left.entry.priority)
        ? left.entry.priority : Number.MAX_SAFE_INTEGER;
      const rightPriority = typeof right.entry.priority === "number" && Number.isFinite(right.entry.priority)
        ? right.entry.priority : Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority || left.index - right.index;
    })
    .slice(0, MAX_SPAWN_AGENT_MODEL_OVERRIDES);
  const orderedEntries = new Set(ordered.map(({ entry }) => entry));

  const candidates = ordered.map(({ entry }) => ({
    model: entry.slug as string,
    efforts: catalogEntryEfforts(entry),
  }));
  const advertised = ordered
    .filter(({ entry }) => configured.some(model => configuredSubagentModelMatchesEntry(model, entry)))
    .map(({ entry }) => ({
      model: entry.slug as string,
      efforts: catalogEntryEfforts(entry),
    }));
  const excluded = configured.flatMap((model): SubagentRosterExclusion[] => {
    const matchingEntries = entries.filter(entry => configuredSubagentModelMatchesEntry(model, entry));
    if (matchingEntries.some(entry => orderedEntries.has(entry))) return [];
    if (matchingEntries.length === 0) return [{ configured: model, reason: "missing_catalog_entry" }];
    const visibleCompatible = matchingEntries.find(entry =>
      entry.visibility === "list"
      && (surface !== "v2" || isEligibleV2SubagentEntry(entry))
    );
    if (visibleCompatible) {
      return [{
        configured: model,
        catalogModel: visibleCompatible.slug as string,
        reason: "outside_display_limit",
      }];
    }
    const visible = matchingEntries.find(entry => entry.visibility === "list");
    if (visible) {
      return [{
        configured: model,
        catalogModel: visible.slug as string,
        reason: "surface_incompatible",
      }];
    }
    const hidden = configuredCatalogEntry(entries, model) ?? matchingEntries[0]!;
    return [{ configured: model, catalogModel: hidden.slug as string, reason: "picker_hidden" }];
  });
  return { candidates, advertised, excluded };
}

export function finishUpstreamNativeEntry(clone: RawEntry, priority: number): RawEntry {
  if (priority !== 9) clone.priority = priority;
  applyNativeOpenAiContextOverride(clone);
  // GPT-5.6 natives keep their exact upstream ladders (e.g. luna has max but no ultra).
  // Older natives (gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex-spark) get mock max + ultra
  // (wire-clamped to xhigh). Ultra is always advertised regardless of v2 toggle.
  if (!isGpt56NativeSlug(String(clone.slug ?? ""))) ensureUltraReasoningLevel(clone);
  return ensureStrictCatalogFields(normalizeServiceTiers(clone));
}

/**
 * The ONE native-priority policy shared by buildCatalogEntries (fresh/convergence
 * builds) and mergeCatalogEntriesForSync (on-disk merge):
 *
 * 1. A featured exact rank always wins (featured = the configured subagent roster).
 * 2. When a nonempty featured roster exists, an unfeatured native sorts STRICTLY
 *    BELOW the featured block — Codex's models-manager sorts by priority ASC and
 *    advertises only the first 5 as spawn_agent suggestions, so a genuine upstream priority
 *    (gpt-5.6-terra=2, gpt-5.6-luna=3) would otherwise displace configured routed
 *    models from that five-slot window.
 * 3. With no featured roster, the genuine upstream/baseline priority is preserved
 *    untouched.
 */
export function nativeCatalogEntryPriority(
  slug: string,
  rank: ReadonlyMap<string, number>,
  featuredCount: number,
  baselinePriority: number,
): number {
  const featuredRank = rank.get(slug);
  if (featuredRank !== undefined) return featuredRank;
  if (featuredCount > 0) {
    return Math.max(typeof baselinePriority === "number" ? baselinePriority : 9, featuredCount + 100);
  }
  return baselinePriority;
}

export function isExactComboCatalogModel(
  model: CatalogModel | undefined,
  exactComboSlugs: ReadonlySet<string>,
): boolean {
  return model !== undefined && exactComboSlugs.has(catalogModelSlug(model));
}

/**
 * Friendly Codex-picker label for a routed `provider/model` slug. Command Code's two config
 * ids differ by a single dash (`command-code` vs `commandcode`), so relabel them to the
 * lowercase-dash style the opencode presets use: `commandcode-auth/x` and `commandcode-api/x`.
 * The model-id portion also carries a redundant `<vendor>-` prefix (`deepseek-deepseek-v4-flash`)
 * that is dropped for display. All other providers keep the raw slug exactly as before.
 */
function routedDisplayName(slug: string): string {
  const slash = slug.indexOf("/");
  if (slash <= 0) return slug;
  const provider = slug.slice(0, slash);
  let model = slug.slice(slash + 1);
  if (provider === "command-code" || provider === "commandcode") {
    const m = model.match(/^([a-z0-9]+)-([a-z0-9]+(?:-[a-z0-9]+)+)$/i);
    if (m && model.startsWith(`${m[1]}-${m[1]}-`)) model = model.slice(m[1]!.length + 1);
    return `${provider === "command-code" ? "commandcode-auth" : "commandcode-api"}/${model}`;
  }
  return slug;
}

export function deriveEntry(
  template: RawEntry | null,
  slug: string,
  desc: string,
  priority: number,
  model?: CatalogModel,
  exactComboSlugs: ReadonlySet<string> = new Set(),
): RawEntry {
  const preserveExact = isExactComboCatalogModel(model, exactComboSlugs);
  const isRouted = model !== undefined;
  if (!isRouted && !slug.includes("/")) {
    // Supported native slug covered by the upstream snapshot: use the REAL entry (exact
    // reasoning ladder — e.g. luna has no ultra — default effort, identity, model_messages)
    // instead of cloning an older template.
    const upstream = upstreamNativeEntry(slug);
    if (upstream) return finishUpstreamNativeEntry(upstream, priority);
  }
  if (template) {
    const e = JSON.parse(JSON.stringify(template)) as RawEntry;
    e.slug = slug;
    e.display_name = routedDisplayName(slug);
    e.description = desc;
    e.priority = priority;
    e.visibility = "list";
    if ("upgrade" in e) e.upgrade = null;
    delete e.availability_nux; // don't replay another model's "now available" NUX
    // Routed (namespaced) models inherit the gpt template — correct its OpenAI/GPT identity
    // and advertise the reasoning ladder Codex accepts.
    if (isRouted) {
      // A routed model is NOT the native template: never inherit its context
      // window when /models omits context metadata (#992). Known metadata
      // restores exact values below; otherwise the strict-fields fallback
      // supplies the conservative 128k triple.
      delete e.context_window;
      delete e.max_context_window;
      delete e.auto_compact_token_limit;
      // Native id for identity text + metadata lookups — the slug may be an encoded
      // alias (`provider/vendor-model`); the model object carries the native id.
      const modelName = model?.id ?? slug.slice(slug.indexOf("/") + 1);
      if (typeof e.base_instructions === "string") {
        // Proxy-neutral: keep the GPT-5/OpenAI disclaimer but never advertise the codexcommander proxy
        // (leaking that into base_instructions is a non-first-party signature → ToS risk).
        e.base_instructions = identifyRoutedModel(e.base_instructions, modelName);
      }
      applyReasoningLevels(e, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExact);
      normalizeRoutedCatalogEntry(e, model?.parallelToolCalls === true);
      if (model) applyJawcodeCatalogMetadata(e, model.provider, model.id, model.contextCap);
      applyCatalogModelMetadata(e, model);
    } else {
      applyNativeOpenAiContextOverride(e);
      if (isGpt56NativeSlug(slug)) ensureGpt56ReasoningLevels(e);
      else ensureUltraReasoningLevel(e);
     // Non-5.6 natives (5.5, 5.4, 5.4-mini, spark) do not support responses-lite;
     // the template may carry the flag from a 5.6 entry — strip it so codex-rs does
     // not inject reasoning.context: "all_turns" for models that reject it.
     if (!isGpt56NativeSlug(slug)) {
        // Spark NEEDS use_responses_lite: true — it controls the tool delivery format
        // (AdditionalTools in input vs top-level tools). The reasoning params that
        // use_responses_lite triggers (context: "all_turns", summary) are stripped
        // separately in the passthrough adapter (stripUnsupportedReasoningParams).
        if (!slug.includes("codex-spark")) delete e.use_responses_lite;
        delete e.supports_websockets;
      }
    }
    return ensureStrictCatalogFields(normalizeServiceTiers(e), {
      preserveExactInputModalities: preserveExact,
      isRouted,
    });
  }
  // Fallback when no template is available (best-effort; strict parser may need more).
  const entry: RawEntry = {
    slug, display_name: routedDisplayName(slug), description: desc,
    shell_type: "shell_command", visibility: "list", supported_in_api: true,
    priority, base_instructions: "You are a helpful coding assistant.",
    ...(isRouted ? { web_search_tool_type: "text_and_image", supports_search_tool: true } : {}),
  };
  if (isRouted) {
    applyReasoningLevels(entry, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExact);
  }
  else {
    applyReasoningLevels(entry, isGpt56NativeSlug(slug) ? undefined : ["low", "medium", "high", "xhigh"]);
    if (isGpt56NativeSlug(slug)) ensureGpt56ReasoningLevels(entry);
  }
  if (model && isRouted) applyJawcodeCatalogMetadata(entry, model.provider, model.id, model.contextCap);
  applyCatalogModelMetadata(entry, model);
  if (!isRouted) applyNativeOpenAiContextOverride(entry);
  return ensureStrictCatalogFields(normalizeServiceTiers(entry), {
    preserveExactInputModalities: preserveExact,
    isRouted,
  });
}

export function buildCatalogEntries(
  template: RawEntry | null,
  gptSlugs: string[],
  goModels: CatalogModel[],
  featured?: string[],
  wsEnabled = false,
  multiAgentMode: MultiAgentMode = "default",
  exactComboSlugs: ReadonlySet<string> = new Set(),
  accountSelectors: readonly string[] = [],
  suppressedBareNativeSlugs: ReadonlySet<string> = new Set(),
  disabledNativeAccountSlugs: ReadonlySet<string> = new Set(),
): RawEntry[] {
  // Codex's models-manager sorts by `priority` ASC and advertises the first 5 picker-visible
  // models as spawn_agent suggestions (sort_by_key(priority) + MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT=5). Catalog
  // ARRAY order is discarded — so "featuring" a model = giving it the LOWEST priority (0..N-1) so
  // it sorts to the front. This works for native gpt slugs AND routed slugs alike.
  const rank = new Map((featured ?? []).map((slug, i) => [slug, i] as const));
  const priorityStride = Math.max(accountSelectors.length, 1);
  const out: RawEntry[] = [];
  const nativeEntries: RawEntry[] = [];
  const collisionSkipped = resolveSlugAliasCollisions(goModels);
  const emittedNativeAliases = new Set<CatalogModel>();
  const emittedNativeAliasSlugs = new Set<string>();
  const nativeAliasesBySlug = new Map<string, CatalogModel>();
  for (const model of goModels) {
    if (model.provider !== COMBO_NAMESPACE
      || model.nativeAlias !== true
      || typeof model.alias !== "string"
      || model.alias.includes("/")) continue;
    if (nativeAliasesBySlug.has(model.alias)) {
      collisionSkipped.add(model);
      if (!slugAliasCollisionWarnings.has(model.alias)) {
        slugAliasCollisionWarnings.add(model.alias);
        console.warn(
          `[codexcommander] native combo alias collision on "${model.alias}": keeping the first configured combo and omitting later duplicates from the catalog.`,
        );
      }
      continue;
    }
    nativeAliasesBySlug.set(model.alias, model);
  }
  const comboPublicSlugs = new Set(goModels
    .filter(model => model.provider === COMBO_NAMESPACE)
    .map(catalogModelSlug));
  for (const slug of gptSlugs) {
    const native = deriveEntry(template, slug, "OpenAI native model (Codex OAuth passthrough).", 9);
    // deriveEntry keeps the genuine upstream snapshot priority for snapshot-backed
    // natives (terra=2, luna=3); route it through the shared native policy so an
    // unfeatured native can never outrank the featured block (spawn_agent top-5).
    native.priority = nativeCatalogEntryPriority(
      slug,
      rank,
      featured?.length ?? 0,
      typeof native.priority === "number" ? native.priority : 9,
    );
    nativeEntries.push(native);
    const nativeAlias = nativeAliasesBySlug.get(slug);
    if (!nativeAlias || collisionSkipped.has(nativeAlias)) {
      if (!suppressedBareNativeSlugs.has(slug)) out.push(native);
      continue;
    }
    const routed = deriveEntry(
      template,
      slug,
      `Routed via CodexCommander → ${nativeAlias.provider} (${nativeAlias.owned_by ?? nativeAlias.provider}).`,
      5,
      nativeAlias,
      exactComboSlugs,
    );
    routed.codexcommander_catalog_kind = CODEX_NATIVE_ALIAS_CATALOG_KIND;
    const rankHit = rank.get(slug);
    if (rankHit !== undefined) routed.priority = rankHit * priorityStride;
    else if (accountSelectors.length > 0) {
      routed.priority = 1_000 + (typeof routed.priority === "number" ? routed.priority : 5);
    }
    out.push(routed);
    emittedNativeAliases.add(nativeAlias);
    emittedNativeAliasSlugs.add(slug);
  }
  for (const [selectorIndex, selector] of accountSelectors.entries()) {
    for (const [nativeIndex, native] of nativeEntries.entries()) {
      const nativeSlug = String(native.slug);
      if (disabledNativeAccountSlugs.has(nativeSlug)) continue;
      const e = JSON.parse(JSON.stringify(native)) as RawEntry;
      const catalogSlug = `${selector}/${nativeSlug}`;
      e.slug = catalogSlug;
      e.display_name = accountBoundNativeDisplayName(selector, native);
      // Codex ignores this CodexCommander extension; preserve the native comp_hash unchanged.
      e.codexcommander_catalog_kind = CODEX_ACCOUNT_BOUND_CATALOG_KIND;
      const exactRank = rank.get(catalogSlug);
      // A featured bare id belongs to the compatibility combo once shadowed; do not
      // feature the account-qualified native clone unless it was selected exactly.
      const inheritedRank = emittedNativeAliasSlugs.has(nativeSlug)
        || suppressedBareNativeSlugs.has(nativeSlug)
        ? undefined
        : rank.get(nativeSlug);
      const featuredRank = exactRank ?? inheritedRank;
      e.priority = featuredRank !== undefined
        ? featuredRank * priorityStride + selectorIndex
        : ((featured?.length ?? 0) + nativeIndex) * accountSelectors.length + selectorIndex;
      e.visibility = "list";
      out.push(e);
    }
  }
  for (const m of goModels) {
    if (collisionSkipped.has(m) || emittedNativeAliases.has(m)) continue;
    const slug = catalogModelSlug(m);
    if (m.provider !== COMBO_NAMESPACE && comboPublicSlugs.has(slug)) {
      warnComboMasqueradeCollisionOnce(slug);
      continue;
    }
    // Provider rows use the one-slash slug codec; combo aliases intentionally override that
    // public slug and may be bare.
    const e = deriveEntry(
      template,
      slug,
      `Routed via CodexCommander → ${m.provider} (${m.owned_by ?? m.provider}).`,
      5,
      m,
      exactComboSlugs,
    );
    if (m.provider === COMBO_NAMESPACE && m.nativeAlias === true && !slug.includes("/")) {
      e.codexcommander_catalog_kind = CODEX_NATIVE_ALIAS_CATALOG_KIND;
    }
    // Featured picks are canonical Codex-facing selectors.
    const rankHit = rank.get(slug);
    if (rankHit !== undefined) e.priority = rankHit * priorityStride;
    else if (accountSelectors.length > 0) {
      // Keep the generated account rows together in Codex's priority-sorted flat picker.
      e.priority = 1_000 + (typeof e.priority === "number" ? e.priority : 5);
    }
    out.push(e);
  }
  // Central capability override (phase 120.4): the advertised flag must match the implemented WS
  // endpoint. Overrides both the routed strip (normalizeRoutedCatalogEntry) and any native template
  // leak (deriveEntry clones the template as-is for native slugs).
  for (const entry of out) {
    if (wsEnabled) entry.supports_websockets = true;
    else {
      delete entry.supports_websockets;
      // Snapshot-backed native entries carry prefer_websockets: never advertise a preference
      // for an endpoint ccx has disabled.
      delete entry.prefer_websockets;
    }
  }
  return applyMultiAgentMode(out, multiAgentMode, isMultiAgentV2Enabled());
}

export function resetCatalogRuntimeStateForTests(): void {
  resetBundledCatalogCacheForTests();
  lastDropWarnSignature.clear();
  openAiApiCollisionWarnings.clear();
  comboCatalogWarningSignatures.clear();
  slugAliasCollisionWarnings.clear();
  comboMasqueradeCollisionWarnings.clear();
  accountSelectorShadowCollisionWarnings.clear();
  clearLastComboCatalogOmissions();
  clearModelCache();
  clearGatherRoutedModelsInflight();
}

export function orderForSubagents(goModels: CatalogModel[], featured?: string[]): CatalogModel[] {
  if (!featured || featured.length === 0) return goModels;
  const rank = new Map(featured.map((id, i) => [id, i]));
  // Featured picks are canonical Codex-facing selectors.
  const rankOf = (m: CatalogModel) =>
    (m.alias ? rank.get(m.alias) : undefined)
      ?? rank.get(routedSlug(m.provider, m.id))
      ?? Number.MAX_SAFE_INTEGER;
  return [...goModels].sort((a, b) => {
    return rankOf(a) - rankOf(b);
  });
}

/**
 * True when an existing catalog row was authored by CodexCommander routing (#855).
 * Every generated routed row carries the stable description prefix
 * `Routed via CodexCommander → `; foreign rows from Cursor or user tooling do
 * not. `owned_by` cannot serve as the signal (upstream
 * ownership), and `comp_hash` defaults to "codexcommander" for every normalized
 * row.
 */
export function isCodexCommanderAuthoredRoutedEntry(entry: RawEntry): boolean {
  if (isNativeAliasCatalogEntry(entry)) return true;
  const desc = typeof entry.description === "string" ? entry.description : "";
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  return slug.includes("/")
    && desc.startsWith("Routed via CodexCommander → ");
}

function recoverableNativeSlug(entry: RawEntry): string | null {
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  return SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)
    && !isNativeAliasCatalogEntry(entry)
    && entry.owned_by !== COMBO_NAMESPACE
    ? slug
    : null;
}

/** Append missing supported native rows from trusted catalog sources only. */
export function mergeCatalogModelsWithNativeRecovery(
  primaryCatalogModels: readonly RawEntry[],
  nativeRecoverySources: readonly (readonly RawEntry[])[],
): RawEntry[] {
  const merged = [...primaryCatalogModels];
  const recoveredNativeSlugs = new Set(primaryCatalogModels.flatMap(entry => {
    const slug = recoverableNativeSlug(entry);
    return slug === null ? [] : [slug];
  }));
  for (const source of nativeRecoverySources) {
    for (const entry of source) {
      const slug = recoverableNativeSlug(entry);
      if (slug === null || recoveredNativeSlugs.has(slug)) continue;
      merged.push(structuredClone(entry) as RawEntry);
      recoveredNativeSlugs.add(slug);
    }
  }
  return merged;
}

/**
 * Whether the config has at least one enabled provider that can contribute
 * routed catalog rows. Forward passthrough providers (the canonical OpenAI
 * Codex-OAuth backend) never produce routed rows, and a static provider with an
 * empty `models` list intentionally publishes zero rows — a native-only catalog
 * is legitimate for both, so neither may trigger the native-only warning.
 */
export function hasRoutedCapableProviders(config: Pick<CodexCommanderConfig, "providers">): boolean {
  for (const [, provider] of Object.entries(config.providers ?? {})) {
    if (provider.disabled === true) continue;
    if (provider.authMode === "forward") continue;
    if (provider.liveModels === false && (provider.models ?? []).length === 0) continue;
    return true;
  }
  return false;
}

/**
 * Whether a retained snapshot row may be rehydrated into the active catalog:
 * it must be CodexCommander-authored, its provider (or combo) must still be
 * configured and enabled, and it must survive the same model-level
 * disabled/selected filters the live gather path applies.
 */
function retainedRowStillConfigured(
  entry: RawEntry,
  config: Readonly<CodexCommanderConfig>,
  gatheredProviderNames: ReadonlySet<string>,
): boolean {
  if (!isCodexCommanderAuthoredRoutedEntry(entry)) return false;
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  if (isNativeAliasCatalogEntry(entry)) {
    const combo = Object.entries(config.combos ?? {}).find(([, raw]) => (
      raw.nativeAlias === true && raw.alias?.trim() === slug
    ));
    return combo !== undefined
      && !(config.disabledModels ?? []).includes(comboModelId(combo[0]))
      && combo[1].targets.some(target => (
        gatheredProviderNames.has(target.provider)
        && config.providers[target.provider]?.disabled !== true
      ));
  }
  const slash = slug.indexOf("/");
  if (slash <= 0) return false;
  const provider = slug.slice(0, slash);
  const model = slug.slice(slash + 1);
  if ((config.disabledModels ?? []).includes(slug)) return false;
  if (provider === COMBO_NAMESPACE) return getCombo(config, model) !== undefined;
  if (!gatheredProviderNames.has(provider)) return false;
  const providerConfig = config.providers?.[provider];
  if (!providerConfig || providerConfig.disabled === true || providerConfig.authMode === "forward") return false;
  if (providerConfig.liveModels === false && (providerConfig.models ?? []).length === 0) return false;
  const selected = providerConfig.selectedModels;
  if (Array.isArray(selected) && selected.length > 0 && !modelInList(selected, model)) return false;
  return true;
}

/**
 * Rehydrate provider-level gaps from an already-observed last-known-good snapshot.
 * The caller owns the snapshot read/evidence; this helper is deliberately pure so
 * management convergence and the legacy sync path apply the same retention policy.
 */
export function mergeLiveRoutedEntriesWithRetained(
  liveRoutedEntries: readonly RawEntry[],
  retainedCatalog: RawCatalog | null,
  config: Readonly<CodexCommanderConfig>,
  gatheredProviderNames: ReadonlySet<string>,
  onDiskHasRoutedEntries: boolean,
): { entries: RawEntry[]; retainedRows: RawEntry[] } {
  const retainedRows: RawEntry[] = [];
  if (liveRoutedEntries.length > 0 || !onDiskHasRoutedEntries) {
    const liveEntryKeys = new Set(liveRoutedEntries.flatMap(entry => {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      if (isNativeAliasCatalogEntry(entry) && slug) return [`native-alias:${slug}`];
      const slash = slug.indexOf("/");
      return slash > 0 ? [`provider:${slug.slice(0, slash)}`] : [];
    }));
    for (const entry of retainedCatalog?.models ?? []) {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const slash = slug.indexOf("/");
      const entryKey = isNativeAliasCatalogEntry(entry) && slug
        ? `native-alias:${slug}`
        : slash > 0 ? `provider:${slug.slice(0, slash)}` : "";
      if (
        entryKey
        && !liveEntryKeys.has(entryKey)
        && retainedRowStillConfigured(entry, config, gatheredProviderNames)
      ) {
        retainedRows.push(entry);
      }
    }
  }
  return {
    entries: liveRoutedEntries.length > 0
      ? [...liveRoutedEntries, ...retainedRows]
      : retainedRows,
    retainedRows,
  };
}

export function mergeCatalogEntriesForSync(
  catalogModels: RawEntry[],
  routedEntries: RawEntry[],
  baseline: Map<string, number>,
  featured: string[],
  wsEnabled: boolean,
  _goIds: Set<string> = new Set(),
  template: RawEntry | null = null,
  disabledModels: ReadonlySet<string> = new Set(),
  gatheredProviderNames: Set<string> = new Set(routedEntries.flatMap(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const slash = slug.indexOf("/");
    return slash > 0 ? [slug.slice(0, slash)] : [];
  })),
  multiAgentMode: MultiAgentMode = "default",
  exactComboSlugs: ReadonlySet<string> = new Set(),
  hasPhysicalComboProvider = false,
  includeNativeOpenAi = true,
  accountBoundEntries: readonly RawEntry[] = [],
  availableNativeSlugs: readonly string[] = NATIVE_OPENAI_MODELS,
  suppressedBareNativeSlugs: ReadonlySet<string> = new Set(
    routedEntries.flatMap(entry => (
      isNativeAliasCatalogEntry(entry) && typeof entry.slug === "string" ? [entry.slug] : []
    )),
  ),
): RawEntry[] {
  const rank = new Map(featured.map((slug, i) => [slug, i] as const));
  const freshBareComboAliases = new Set(routedEntries.flatMap(entry => (
    isNativeAliasCatalogEntry(entry) && typeof entry.slug === "string" ? [entry.slug] : []
  )));
  const nativeSourceEntries = includeNativeOpenAi
    ? catalogModels
    .filter(m => typeof m.slug === "string"
      && !(m.slug as string).includes("/")
      && m.owned_by !== COMBO_NAMESPACE
      && !isUnsupportedOpenAiNativeSlug(m.slug as string))
    .map(m => {
      const slug = m.slug as string;
      const baselinePriority = baseline.get(slug) ?? (m.priority as number);
      const priority = nativeCatalogEntryPriority(slug, rank, featured.length, baselinePriority);
      // Fallback-quality entries (ccx synthesis / codex-rs model_info fallback: display_name
      // stamped with the bare slug) are upgraded to the pinned upstream snapshot entry so a
      // previously synthesized ladder (e.g. luna advertising ultra) self-heals on sync. A
      // genuine catalog entry (real display name) is preserved untouched.
      if (shouldUpgradeToUpstreamEntry(m)) {
        const upstream = upstreamNativeEntry(slug)!;
        const upgradePriority = nativeCatalogEntryPriority(
          slug,
          rank,
          featured.length,
          typeof upstream.priority === "number" ? upstream.priority : priority,
        );
        const finished = finishUpstreamNativeEntry(upstream, 9);
        finished.priority = upgradePriority;
        return finished;
      }
      const preserved = normalizeServiceTiers({ ...m, priority });
      // Older natives kept from disk still need the mock top tiers (max + ultra always
      // for subagent max spawns; wire-clamped to the model's real top rung).
      if (!isGpt56NativeSlug(slug)) ensureUltraReasoningLevel(preserved);
      return preserved;
    })
    : [];
  const native = nativeSourceEntries.filter(entry =>
    typeof entry.slug !== "string"
      || (!freshBareComboAliases.has(entry.slug) && !suppressedBareNativeSlugs.has(entry.slug))
  );

  // Backfill any native OpenAI slug that the on-disk catalog is missing (e.g. gpt-5.5), so a
  // routed provider exposing the same id can never delete the native OpenAI/Codex base row.
  // Skip when no enabled canonical openai provider exists (#636) — bare gpt-* would 404.
  const nativeSlugs = new Set(native.flatMap(m => typeof m.slug === "string" ? [m.slug] : []));
  if (includeNativeOpenAi) {
  for (const slug of availableNativeSlugs) {
    if (nativeSlugs.has(slug) || freshBareComboAliases.has(slug) || suppressedBareNativeSlugs.has(slug)) continue;
    nativeSlugs.add(slug);
    const priority = nativeCatalogEntryPriority(slug, rank, featured.length, 9);
    native.push(deriveEntry(template ? JSON.parse(JSON.stringify(template)) : null, slug, "OpenAI native model (Codex OAuth passthrough).", priority));
  }
  }

  const nativeSourceBySlug = new Map([...nativeSourceEntries, ...native].flatMap(entry =>
    typeof entry.slug === "string" ? [[entry.slug, entry] as const] : []
  ));
  const alignedAccountBoundEntries = accountBoundEntries.map(entry => {
    const nativeSlug = trustedAccountBoundNativeCatalogSlug(entry);
    const source = nativeSlug === undefined ? undefined : nativeSourceBySlug.get(nativeSlug);
    if (!source) return entry;
    const aligned = JSON.parse(JSON.stringify(source)) as RawEntry;
    aligned.slug = entry.slug;
    aligned.display_name = entry.display_name;
    aligned.priority = entry.priority;
    aligned.visibility = "list";
    aligned.codexcommander_catalog_kind = CODEX_ACCOUNT_BOUND_CATALOG_KIND;
    return aligned;
  });

  const freshSlugs = new Set(
    routedEntries.flatMap(entry => typeof entry.slug === "string" ? [entry.slug] : []),
  );
  let finalRoutedEntries = routedEntries;
  const existingRoutedEntries = catalogModels.filter(m =>
    typeof m.slug === "string"
    && (m.slug.includes("/") || isNativeAliasCatalogEntry(m))
    && trustedAccountBoundNativeCatalogSlug(m) === undefined
  );
  const preservingExistingRouted = routedEntries.length === 0
    && existingRoutedEntries.length > 0;
  if (preservingExistingRouted) {
    // #855: transient-fetch protection keeps existing rows, but rows CodexCommander
    // itself authored for a provider that is no longer configured are ghosts,
    // not protected foreign entries.
    finalRoutedEntries = existingRoutedEntries.filter(m => {
      if (isNativeAliasCatalogEntry(m)) {
        return typeof m.slug === "string" && exactComboSlugs.has(m.slug);
      }
      const provider = (m.slug as string).slice(0, (m.slug as string).indexOf("/"));
      return !(isCodexCommanderAuthoredRoutedEntry(m) && !gatheredProviderNames.has(provider));
    });
  } else {
    const preservedForeignRouted = catalogModels.filter(m => {
      if (typeof m.slug !== "string") return false;
      if (isNativeAliasCatalogEntry(m)) return exactComboSlugs.has(m.slug) && !freshSlugs.has(m.slug);
      if (!m.slug.includes("/")) return false;
      if (trustedAccountBoundNativeCatalogSlug(m) !== undefined) return false;
      const provider = m.slug.slice(0, m.slug.indexOf("/"));
      if (gatheredProviderNames.has(provider) || freshSlugs.has(m.slug)) return false;
      // #855: an CodexCommander-authored row whose provider was deleted is a ghost;
      // only genuinely foreign rows (Cursor, user tooling) are preserved.
      return !isCodexCommanderAuthoredRoutedEntry(m);
    });
    finalRoutedEntries = [...routedEntries, ...preservedForeignRouted];
  }
  if (!hasPhysicalComboProvider) {
    finalRoutedEntries = finalRoutedEntries.filter(entry => {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const comboOwned = slug.startsWith(`${COMBO_NAMESPACE}/`) || entry.owned_by === COMBO_NAMESPACE;
      const retainedNativeAlias = isNativeAliasCatalogEntry(entry) && exactComboSlugs.has(slug);
      return !comboOwned || freshSlugs.has(slug) || retainedNativeAlias;
    });
  }
  finalRoutedEntries = finalRoutedEntries.filter(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const retainedNativeAlias = isNativeAliasCatalogEntry(entry) && exactComboSlugs.has(slug);
    return retainedNativeAlias
      || !exactComboSlugs.has(slug)
      || (Array.isArray(entry.input_modalities) && entry.input_modalities.length > 0);
  });
  // Reapply final catalog policy to rows preserved from disk. Those rows bypass
  // gatherRoutedModels, so filtering only the freshly gathered list can resurrect an excluded id.
  finalRoutedEntries = finalRoutedEntries.filter(entry =>
    typeof entry.slug !== "string" || !isRoutedModelCompatibilityExcluded(entry.slug)
  );
  const accountBoundSlugs = new Set(alignedAccountBoundEntries.flatMap(entry =>
    typeof entry.slug === "string" ? [entry.slug] : []
  ));
  finalRoutedEntries = finalRoutedEntries.filter(entry => {
    if (typeof entry.slug !== "string" || !accountBoundSlugs.has(entry.slug)) return true;
    if (freshSlugs.has(entry.slug)) warnAccountSelectorShadowedProviderOnce(entry.slug);
    return false;
  });
  if (preservingExistingRouted) {
    console.warn(`[codexcommander] catalog sync: routed model fetch returned empty; preserving ${finalRoutedEntries.length} existing routed entr${finalRoutedEntries.length === 1 ? "y" : "ies"} on disk.`);
  }

  const managedEntries = [...finalRoutedEntries, ...alignedAccountBoundEntries];
  const mergedEntries = [...native, ...managedEntries].map(m => {
    const normalized = normalizeServiceTiers(m);
    if (!isNativeAliasCatalogEntry(normalized)) applyNativeOpenAiContextOverride(normalized);
    const exactCombo = typeof m.slug === "string" && exactComboSlugs.has(m.slug);
    const e = ensureStrictCatalogFields(normalized, {
      preserveExactInputModalities: exactCombo,
      isRouted: finalRoutedEntries.includes(m),
    });
    // Mock-max universality (260709): preserved routed entries from disk may predate
    // the max rung — ensure it here so subagent max spawns validate on every
    // reasoning-capable entry. max only: 5.6 exact ladders (luna: no ultra) stay intact.
    if (!exactCombo) {
      const levels = Array.isArray(e.supported_reasoning_levels)
        ? e.supported_reasoning_levels as Array<{ effort?: string }>
        : [];
      if (levels.length > 0 && !levels.some(level => level.effort === "max")) {
        levels.push(CODEX_REASONING_LEVELS.find(level => level.effort === "max")
          ?? { effort: "max", description: "Maximum reasoning depth for the hardest problems" });
        e.supported_reasoning_levels = levels;
      }
    }
    if (wsEnabled) e.supports_websockets = true;
    else {
      delete e.supports_websockets;
      // Match buildCatalogEntries: never advertise a websocket preference while WS is off.
      delete e.prefer_websockets;
    }
    return e;
  });
  // Native enable/disable runs as the LAST pass so the upstream-upgrade branch above can never
  // clobber a hide flag back to list. Bare ids disable every account clone; qualified ids disable
  // only their generated account row.
  return applyMultiAgentMode(
    applyNativeVisibility(mergedEntries, disabledModels, alignedAccountBoundEntries.length > 0),
    multiAgentMode,
    isMultiAgentV2Enabled(),
  );
}

function visibleAccountReplacementNatives(
  models: readonly RawEntry[],
  disabledModels: ReadonlySet<string> | null,
): Map<string, boolean> {
  const replacements = new Map<string, boolean>();
  for (const entry of models) {
    const nativeSlug = trustedAccountBoundNativeCatalogSlug(entry);
    if (nativeSlug === undefined || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(nativeSlug)) continue;
    const exactSlug = typeof entry.slug === "string" ? entry.slug : "";
    const visible = entry.visibility === "list"
      || (disabledModels !== null
        && (disabledModels.has(nativeSlug) || disabledModels.has(exactSlug)));
    replacements.set(nativeSlug, (replacements.get(nativeSlug) ?? true) && visible);
  }
  return replacements;
}

function restoreAccountHiddenBareNatives(
  entries: readonly RawEntry[],
  replacementVisibility: ReadonlyMap<string, boolean>,
  disabledModels: ReadonlySet<string> | null,
): RawEntry[] {
  return entries.map(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (
      entry.visibility !== "hide"
      || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)
      || replacementVisibility.get(slug) !== true
      || disabledModels === null
      || disabledModels.has(slug)
    ) {
      return entry;
    }
    return { ...entry, visibility: "list" };
  });
}

function currentDisabledModelsForRestore(): Set<string> | null {
  try {
    const diagnostics = readConfigDiagnostics();
    if (diagnostics.source === "fallback" || diagnostics.error !== null) return null;
    return new Set(diagnostics.config.disabledModels ?? []);
  } catch {
    // An unreadable config cannot safely authorize a visibility change during restore.
    return null;
  }
}

export function restoreCodexCatalogWithPermit(
  permit: CatalogWritePermit,
  owningCodexHome: string,
): { removed: number; kept: number; path: string } {
  const catalogPath = readCodexCatalogPath();
  const catalog = readCatalog(catalogPath);
  if (!catalog || !Array.isArray(catalog.models)) return { removed: 0, kept: 0, path: catalogPath };
  const disabledModels = currentDisabledModelsForRestore();
  const replacementVisibility = visibleAccountReplacementNatives(catalog.models, disabledModels);
  const backup = readCatalogBackup(catalogPath);
  if (backup && Array.isArray(backup.models)) {
    const removed = (catalog.models ?? []).filter(m => typeof m.slug === "string"
      && (m.slug.includes("/") || isNativeAliasCatalogEntry(m))).length;
    const backupSlugs = new Set(backup.models.flatMap(m => typeof m.slug === "string" ? [m.slug] : []));
    const userNativeAdditions = restoreAccountHiddenBareNatives(
      (catalog.models ?? []).filter(m =>
        typeof m.slug === "string"
        && !m.slug.includes("/")
        && !isNativeAliasCatalogEntry(m)
        && !backupSlugs.has(m.slug)
      ),
      replacementVisibility,
      disabledModels,
    );
    const restored = {
      ...backup,
      models: [...backup.models, ...userNativeAdditions],
    };
    replaceActiveCodexCatalog(permit, owningCodexHome, {
      path: catalogPath,
      content: `${JSON.stringify(restored, null, 2)}\n`,
    });
    return { removed, kept: restored.models.length, path: catalogPath };
  }
  const before = catalog.models.length;
  const native = restoreAccountHiddenBareNatives(
    catalog.models.filter(m => !(typeof m.slug === "string"
      && (m.slug.includes("/") || isNativeAliasCatalogEntry(m)))),
    replacementVisibility,
    disabledModels,
  );
  const removed = before - native.length;
  if (removed > 0) {
    catalog.models = native;
    replaceActiveCodexCatalog(permit, owningCodexHome, {
      path: catalogPath,
      content: `${JSON.stringify(catalog, null, 2)}\n`,
    });
  }
  return { removed, kept: native.length, path: catalogPath };
}

export function restoreCodexCatalog(): { removed: number; kept: number; path: string } {
  const owningCodexHome = getCodexHome();
  const outcome = withCatalogWriteSerialization(
    owningCodexHome,
    permit => restoreCodexCatalogWithPermit(permit, owningCodexHome),
  );
  return outcome.kind === "completed"
    ? outcome.value
    : { removed: 0, kept: 0, path: readCodexCatalogPath() };
}

/** Force Codex's models_cache stale from the on-disk catalog. Returns whether a cache write occurred. */
export function invalidateCodexModelsCacheWithPermit(
  permit: CatalogWritePermit,
  owningCodexHome: string,
): boolean {
  try {
    // This advanced cache-only operation is intentionally separate from
    // canonical convergence. Re-read durable intent while holding its permit so
    // an explicit `sync-cache` cannot publish routed bytes after integration OFF.
    if (!shouldSyncCodexOnStart(loadConfig())) return false;
    const catalogPath = readCodexCatalogPath();
    if (!existsSync(catalogPath)) return false;
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const models = catalog.models ?? catalog;
    const wrapper = {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models,
    };
    replaceCodexModelsCache(permit, owningCodexHome, {
      path: activeCodexModelsCachePath(),
      content: `${JSON.stringify(wrapper, null, 2)}\n`,
    });
    return true;
  } catch {
    return false;
  }
}

export function invalidateCodexModelsCache(): boolean {
  const owningCodexHome = getCodexHome();
  const outcome = withCatalogWriteSerialization(
    owningCodexHome,
    permit => invalidateCodexModelsCacheWithPermit(permit, owningCodexHome),
  );
  return outcome.kind === "completed" && outcome.value;
}

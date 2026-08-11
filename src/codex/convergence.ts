import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ConfigMutationLockError,
  getConfigDir,
  validateConfigCandidate,
  websocketsEnabled,
  withExpectedConfigGenerationSync,
} from "../config";
import { COMBO_NAMESPACE } from "../combos";
import { getAuthStorePath } from "../oauth/store";
import type { CodexCommanderConfig } from "../types";
import {
  captureCatalogAdmissionSnapshot,
  captureCatalogConfigAuthority,
  CatalogAdmissionStaleConfigError,
  type CatalogConfigAuthoritySnapshot,
} from "./catalog-admission";
import {
  type CatalogSourceForGather,
  bundledCatalogCacheState,
  resolveCatalogSourceForGather,
} from "./catalog/bundled";
import {
  acceptCatalogGatherSourcePath,
  captureAndSealCatalogHomeSelection,
  captureCatalogGatherTargetIdentity,
  createCatalogGatherEvidenceSession,
  readCatalogGatherSource,
  sealCatalogGatherEvidenceSession,
  type CatalogFilesystemEvidenceSession,
} from "./catalog/filesystem-evidence";
import {
  CatalogGatherBusyError,
  createCatalogGatherAuthorityIdentity,
  filterCatalogVisibleModels,
  gatherRoutedModelsForCatalogGather,
  type CatalogGatherProviderAuthOutcome,
} from "./catalog/provider-fetch";
import {
  catalogBackupPathFor,
  catalogHasRoutedEntries,
  findNativeTemplate,
  parseCatalogJson,
  retainedRoutedCatalogPath,
  writeRetainedRoutedCatalogAtPath,
  type RawCatalog,
  type RawEntry,
} from "./catalog/parsing";
import {
  buildCatalogEntries,
  isCodexCommanderAuthoredRoutedEntry,
  mergeCatalogEntriesForSync,
  mergeCatalogModelsWithNativeRecovery,
  mergeLiveRoutedEntriesWithRetained,
  orderForSubagents,
  type CatalogQuality,
} from "./catalog/sync";
import { exactComboCatalogSlugs } from "./catalog/aggregation";
import type { ComboCatalogOmission } from "./catalog/aggregation";
import {
  catalogSupportedReasoningEfforts,
  clampCatalogModelsToSupportedEfforts,
} from "./catalog/effort";
import {
  desktopAllowlistSuppressedNativeSlugs,
  disabledNativeSlugs,
  isNativeAliasCatalogEntry,
  NATIVE_OPENAI_MODELS,
  shouldIncludeAccountBoundNativeOpenAi,
  shouldIncludeNativeOpenAi,
} from "./catalog/metadata";
import { trustedAccountBoundNativeCatalogSlug, visibleCodexAccountSelectors } from "./catalog/account-models";
import { codexRuntimeStatePath, peekCodexRuntimeProcessCache } from "./runtime";
import { isMultiAgentV2Enabled } from "./features";
import {
  codexCatalogWritePolicy,
  nonDisruptiveCodexManagementWritePolicy,
} from "./management-write-policy";
import { withCatalogWriteSerialization } from "./catalog-write-serialization";
import {
  publishHashedCodexCatalogBackup,
  replaceActiveCodexCatalog,
  replaceCodexModelsCache,
  type PreparedCatalogFileWrite,
} from "./internal/catalog-writer";
import type {
  CatalogAdmissionSnapshot,
  CatalogDisposition,
  CatalogGatherAuthorityIdentity,
  CatalogNotice,
  CatalogProviderDiscoveryPolicySnapshot,
  CatalogProcessLocalEvidence,
  CatalogSourceEvidence,
  CatalogSourceRole,
  ConvergeRequest,
} from "./convergence-types";

export interface CatalogWriteReceipt {
  readonly keyedBackup: "written" | "preserved" | "not-requested";
  readonly catalog: "written" | "not-written";
  readonly cache: "written" | "not-written";
}

export type CodexCatalogCommitResult =
  | { readonly kind: "committed"; readonly changed: boolean; readonly writes: CatalogWriteReceipt }
  | { readonly kind: "stale"; readonly reason: "generation" | "home-selection" | "source-observation" | "process-local" | "target-identity" | "candidate-consumed" }
  | { readonly kind: "refused"; readonly reason: "source-unreadable" | "source-ambiguous" | "target-unsafe" }
  | { readonly kind: "failed"; readonly surface: "disk"; readonly writes: CatalogWriteReceipt };

declare const catalogCandidateBrand: unique symbol;
export interface CodexCatalogCandidate { readonly [catalogCandidateBrand]: true }

export type CodexCatalogGatherResult =
  | { readonly kind: "candidate"; readonly candidate: CodexCatalogCandidate }
  | {
      readonly kind: "disposition";
      readonly disposition: CatalogDisposition;
      readonly staleReason?: Extract<CodexCatalogCommitResult, { kind: "stale" }>["reason"];
    };

/** Internal projection used to preserve the established sync response without a second pipeline. */
export interface CodexCatalogConvergenceProjection {
  readonly admittedGeneration: CatalogAdmissionSnapshot["generation"];
  readonly admittedConfigAuthority: CatalogConfigAuthoritySnapshot;
  readonly path: string;
  readonly added: number;
  readonly catalogWritten: boolean;
  readonly cacheSynced: boolean;
  readonly comboOmissions: readonly ComboCatalogOmission[];
  readonly catalogQuality: CatalogQuality;
  readonly rehydrated: number;
  readonly staleReason?: Extract<CodexCatalogCommitResult, { kind: "stale" }>["reason"];
}

export interface CodexCatalogConvergenceResult {
  readonly changed: boolean;
  readonly catalogRefresh: CatalogDisposition;
  readonly projection: CodexCatalogConvergenceProjection;
}

/**
 * Process-local proof that one admitted catalog input produced both active
 * artifacts. The generation is diagnostic only: artifact-current comparison
 * deliberately uses `catalogInputIdentity`, which excludes session-only config.
 *
 * `models_cache.json` is included as commit provenance, but it is not a durable
 * activation fence: a running Codex worker legitimately rewrites or removes
 * that cache. Steady-state activation therefore revalidates the authoritative
 * catalog target and identity only.
 */
export interface CodexCatalogConvergenceReceipt {
  readonly admittedGeneration: CatalogAdmissionSnapshot["generation"];
  readonly catalogInputIdentity: string;
  readonly targets: Readonly<{ catalogPath: string; cachePath: string }>;
  readonly semanticIdentities: Readonly<{ catalog: string; cache: string }>;
}

export interface CodexCatalogConvergenceReceiptMatchInput {
  readonly config: Readonly<CodexCommanderConfig>;
  readonly catalogPath: string;
}

type CommitAttempt = CodexCatalogCommitResult | { readonly kind: "busy" };

interface CandidateState {
  consumed: boolean;
  readonly requiresManagedRouting: boolean;
  readonly sequence: number;
  readonly config: Readonly<CodexCommanderConfig>;
  readonly generation: CatalogAdmissionSnapshot["generation"];
  readonly configSemanticIdentity: string;
  readonly configContentIdentity: string;
  readonly catalogInputIdentity: string;
  readonly authority: CatalogGatherAuthorityIdentity;
  readonly sourceEvidence: CatalogSourceEvidence;
  readonly processLocal: CatalogProcessLocalEvidence;
  readonly home: string;
  readonly targets: CatalogAdmissionSnapshot["targets"];
  readonly catalog: PreparedCatalogFileWrite;
  readonly cache: PreparedCatalogFileWrite;
  readonly keyedBackup?: PreparedCatalogFileWrite;
  readonly retained?: Readonly<{ path: string; models: RawEntry[] }>;
  readonly catalogChanged: boolean;
  readonly cacheChanged: boolean;
  readonly retainedChanged: boolean;
  readonly changed: boolean;
  readonly notices: readonly CatalogNotice[];
  readonly added: number;
  readonly comboOmissions: readonly ComboCatalogOmission[];
  readonly catalogQuality: CatalogQuality;
  readonly rehydrated: number;
}

const candidateStates = new WeakMap<object, CandidateState>();
const CATALOG_INPUT_IDENTITY_KEY = randomBytes(32);
let nextCandidateSequence = 0;
let convergenceReceipt: Readonly<{
  sequence: number;
  value: CodexCatalogConvergenceReceipt;
}> | null = null;
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetPath(identity: string): string {
  const parsed = JSON.parse(identity) as { path?: unknown };
  if (typeof parsed.path !== "string") throw new TypeError("Catalog target identity has no path.");
  return parsed.path;
}

function catalogFrom(bytes: Uint8Array | null): RawCatalog | null {
  return bytes === null ? null : parseCatalogJson(Buffer.from(bytes).toString("utf8"));
}

function catalogBytes(catalog: RawCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeJsonValue(child)]));
  }
  return value;
}

function catalogInputIdentity(config: Readonly<CodexCommanderConfig>): string {
  const normalized = validateConfigCandidate(config);
  const value = normalized.ok ? normalized.config : config;
  // Audited against gatherRoutedModelsForCatalogGather + prepareCatalog. Keep
  // operational/session settings out: artifact-current must not drift for log,
  // timeout, sidecar, cleanup, or message-delivery changes that cannot alter
  // either prepared JSON document.
  const catalogInput = {
    providers: value.providers,
    combos: value.combos ?? {},
    disabledModels: [...(value.disabledModels ?? [])].sort(),
    customModels: value.customModels ?? [],
    providerContextCaps: value.providerContextCaps ?? {},
    subagentModels: value.subagentModels ?? [],
    multiAgentMode: value.multiAgentMode ?? "default",
    // In default mode the native Codex feature flag decides the advertised
    // multi_agent_version. Forced v1/v2 modes intentionally ignore it.
    nativeMultiAgentV2Enabled: value.multiAgentMode === "v1" || value.multiAgentMode === "v2"
      ? null
      : isMultiAgentV2Enabled(),
    websockets: websocketsEnabled(value),
    codexAccounts: (value.codexAccounts ?? [])
      .map(account => ({ id: account.id, isMain: account.isMain === true }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    codexAccountNamespaces: value.codexAccountNamespaces ?? {},
  };
  return createHmac("sha256", CATALOG_INPUT_IDENTITY_KEY)
    .update(JSON.stringify(normalizeJsonValue(catalogInput)))
    .digest("hex");
}

function semanticJsonIdentity(bytes: string | Uint8Array): string | null {
  try {
    const parsed = JSON.parse(typeof bytes === "string"
      ? bytes
      : Buffer.from(bytes).toString("utf8")) as unknown;
    return createHash("sha256")
      .update(JSON.stringify(normalizeJsonValue(parsed)))
      .digest("hex");
  } catch {
    return null;
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  return process.platform === "win32"
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

/** Last fully committed catalog+cache proof in this process, if any. */
export function readCodexCatalogConvergenceReceipt(): CodexCatalogConvergenceReceipt | null {
  return convergenceReceipt?.value ?? null;
}

/**
 * Require the current audited catalog input and exact authoritative catalog
 * target/identity to match the last fully committed catalog+cache convergence.
 * Codex owns `models_cache.json` after publication and may churn it at any time.
 */
export function codexCatalogConvergenceReceiptMatchesCurrent(
  input: CodexCatalogConvergenceReceiptMatchInput,
): boolean {
  const receipt = convergenceReceipt?.value;
  if (!receipt || receipt.catalogInputIdentity !== catalogInputIdentity(input.config)) return false;
  if (!sameResolvedPath(receipt.targets.catalogPath, input.catalogPath)) return false;
  try {
    return semanticJsonIdentity(readFileSync(input.catalogPath)) === receipt.semanticIdentities.catalog;
  } catch {
    return false;
  }
}

/** Test/process lifecycle seam; startup convergence repopulates the receipt. */
export function resetCodexCatalogConvergenceReceiptForTests(): void {
  convergenceReceipt = null;
}

function publishConvergenceReceipt(state: CandidateState): void {
  const catalog = semanticJsonIdentity(state.catalog.content);
  const cache = semanticJsonIdentity(state.cache.content);
  if (catalog === null || cache === null) return;
  const value: CodexCatalogConvergenceReceipt = Object.freeze({
    admittedGeneration: Object.freeze({ ...state.generation }),
    catalogInputIdentity: state.catalogInputIdentity,
    targets: Object.freeze({ catalogPath: state.catalog.path, cachePath: state.cache.path }),
    semanticIdentities: Object.freeze({ catalog, cache }),
  });
  convergenceReceipt = Object.freeze({ sequence: state.sequence, value });
}

function invalidateConvergenceReceipt(state: CandidateState): void {
  // A late failure from an older overlapping attempt must not erase a newer
  // successful proof. The newest unsuccessful attempt is conservative: it
  // leaves no process-local claim until convergence succeeds again.
  if (convergenceReceipt && convergenceReceipt.sequence > state.sequence) return;
  convergenceReceipt = null;
}

/** JSON object key order and whitespace are not catalog behavior. Array order remains significant. */
function sameJsonDocument(bytes: Uint8Array | null, prepared: unknown): boolean {
  if (bytes === null) return false;
  try {
    const current = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    return JSON.stringify(normalizeJsonValue(current)) === JSON.stringify(normalizeJsonValue(prepared));
  } catch {
    return false;
  }
}

interface ReadonlyRawCatalogLike {
  readonly models?: readonly Readonly<Record<string, unknown>>[];
}

function hasRoutedEntries(catalog: ReadonlyRawCatalogLike): boolean {
  return (catalog.models ?? []).some(entry => typeof entry.slug === "string"
    && (entry.slug.includes("/") || isNativeAliasCatalogEntry(entry as RawEntry)));
}

function processEvidence(source: CatalogSourceForGather): CatalogProcessLocalEvidence {
  return Object.freeze({
    runtime: Object.freeze({ ...source.processLocal.runtime }),
    bundledCatalog: Object.freeze({ ...source.processLocal.bundledCatalog }),
  });
}

function bindGatherPaths(
  session: CatalogFilesystemEvidenceSession,
  snapshot: CatalogAdmissionSnapshot,
): Readonly<{ catalog: string; cache: string; keyedBackup: string; retained: string }> {
  const catalog = targetPath(snapshot.targets.catalog);
  const cache = targetPath(snapshot.targets.cache);
  const keyedBackup = targetPath(snapshot.targets.catalogBackups[0]!);
  const retained = retainedRoutedCatalogPath();
  const configPath = snapshot.sourceEvidence.required["catalog-target-selection"].logicalPath;

  acceptCatalogGatherSourcePath(session, "catalog-target-selection", configPath);
  readCatalogGatherSource(session, "catalog-target-selection");
  acceptCatalogGatherSourcePath(session, "active-catalog-merge", catalog);
  acceptCatalogGatherSourcePath(session, "hashed-backup-fallback", keyedBackup);
  acceptCatalogGatherSourcePath(session, "models-cache-fallback", cache);
  acceptCatalogGatherSourcePath(session, "retained-routed-fallback", retained);
  acceptCatalogGatherSourcePath(session, "runtime-selection", codexRuntimeStatePath(getConfigDir()));
  acceptCatalogGatherSourcePath(session, "provider-auth-selection", getAuthStorePath());
  acceptCatalogGatherSourcePath(session, "native-catalog-selection", catalog);
  return { catalog, cache, keyedBackup, retained };
}

function prepareCatalog(
  config: Readonly<CodexCommanderConfig>,
  source: Extract<CatalogSourceForGather, { kind: "available" }>,
  active: RawCatalog | null,
  routedModels: Awaited<ReturnType<typeof gatherRoutedModelsForCatalogGather>>,
  retainedCatalog: RawCatalog | null,
  nativeRecoverySources: readonly (readonly RawEntry[])[] = [],
): {
  catalog: RawCatalog;
  retainedRows: RawEntry[];
  retainedSnapshot: RawEntry[] | null;
  added: number;
  catalogQuality: CatalogQuality;
  rehydrated: number;
} {
  const catalog = JSON.parse(JSON.stringify(source.catalog)) as RawCatalog;
  const template = findNativeTemplate(catalog);
  const enabled = filterCatalogVisibleModels(routedModels, config);
  const featured = config.subagentModels ?? [];
  const ordered = orderForSubagents(enabled, featured);
  const multiAgentMode = config.multiAgentMode === "v1" || config.multiAgentMode === "v2"
    ? config.multiAgentMode : "default";
  const exactComboSlugs = exactComboCatalogSlugs(config);
  const suppressedBareNativeSlugs = desktopAllowlistSuppressedNativeSlugs(config);
  const hasPhysicalComboProvider = Object.hasOwn(config.providers, COMBO_NAMESPACE);
  const enabledProviders = Object.entries(config.providers).filter(([, provider]) => provider.disabled !== true);
  const includeNativeOpenAi = shouldIncludeNativeOpenAi(config);
  const includeAccountBoundNativeOpenAi = shouldIncludeAccountBoundNativeOpenAi(config);
  const accountSelectors = includeAccountBoundNativeOpenAi
    ? visibleCodexAccountSelectors(config)
    : [];
  const disabledNative = disabledNativeSlugs(config);
  const catalogModels = mergeCatalogModelsWithNativeRecovery(
    active?.models ?? catalog.models ?? [],
    [catalog.models ?? [], ...nativeRecoverySources],
  );
  const routedEntries = buildCatalogEntries(
    template ? JSON.parse(JSON.stringify(template)) : null,
    [], ordered, featured, websocketsEnabled(config), multiAgentMode, exactComboSlugs,
    accountSelectors, suppressedBareNativeSlugs, new Set(),
  );
  const accountBoundEntries = accountSelectors.length === 0
    ? []
    : buildCatalogEntries(
      template ? JSON.parse(JSON.stringify(template)) : null,
      NATIVE_OPENAI_MODELS,
      [],
      featured,
      websocketsEnabled(config),
      multiAgentMode,
      exactComboSlugs,
      accountSelectors,
      suppressedBareNativeSlugs,
      new Set([...disabledNative].filter(slug => suppressedBareNativeSlugs.has(slug))),
    ).filter(entry => trustedAccountBoundNativeCatalogSlug(entry) !== undefined);
  const baseline = new Map<string, number>((catalog.models ?? []).flatMap(entry => (
    typeof entry.slug === "string" && typeof entry.priority === "number"
      ? [[entry.slug, entry.priority] as const]
      : []
  )));
  const gatheredProviderNames = new Set(enabledProviders.map(([name]) => name));
  const goIds = new Set(enabled.map(model => model.id));
  const retainedMerge = mergeLiveRoutedEntriesWithRetained(
    routedEntries,
    retainedCatalog,
    config,
    gatheredProviderNames,
    catalogHasRoutedEntries({ models: catalogModels }),
  );
  catalog.models = mergeCatalogEntriesForSync(
    catalogModels,
    retainedMerge.entries,
    baseline,
    featured,
    websocketsEnabled(config),
    goIds,
    template,
    new Set(config.disabledModels ?? []),
    gatheredProviderNames,
    multiAgentMode,
    exactComboSlugs,
    hasPhysicalComboProvider,
    includeNativeOpenAi,
    accountBoundEntries,
    NATIVE_OPENAI_MODELS,
    suppressedBareNativeSlugs,
  );
  clampCatalogModelsToSupportedEfforts(
    catalog.models,
    catalogSupportedReasoningEfforts(source.catalog),
  );
  const ccxAuthoredRouted = catalog.models.filter(isCodexCommanderAuthoredRoutedEntry);
  const retainedSlugs = new Set(retainedMerge.retainedRows.flatMap(entry => (
    typeof entry.slug === "string" ? [entry.slug] : []
  )));
  const rehydrated = ccxAuthoredRouted.filter(entry => (
    typeof entry.slug === "string" && retainedSlugs.has(entry.slug)
  )).length;
  const catalogQuality: CatalogQuality = retainedMerge.retainedRows.length > 0
    ? "retained"
    : routedEntries.length > 0
      ? "live"
      : ccxAuthoredRouted.length > 0
        ? "retained"
        : "native-only";
  return {
    catalog,
    retainedRows: retainedMerge.retainedRows,
    // Match the established recovery contract: only a successful live gather
    // advances the LKG, and partial live discovery carries forward retained peers.
    retainedSnapshot: routedEntries.length > 0 ? ccxAuthoredRouted : null,
    added: routedEntries.length + accountBoundEntries.length,
    catalogQuality,
    rehydrated,
  };
}

export async function gatherCodexCatalogCandidate(
  snapshot: CatalogAdmissionSnapshot,
  policy: Readonly<{ requiresManagedRouting?: boolean }> = {},
): Promise<CodexCatalogGatherResult> {
  let providerGatherStarted = false;
  try {
    const session = createCatalogGatherEvidenceSession();
    const home = captureAndSealCatalogHomeSelection(session);
    if (!same(home, snapshot.sourceEvidence.homeSelection)) {
      return {
        kind: "disposition",
        disposition: { status: "skipped", reason: "stale", retryable: true },
        staleReason: "home-selection",
      };
    }
    const paths = bindGatherPaths(session, snapshot);
    const source = resolveCatalogSourceForGather(session);
    if (source.kind === "catalog-unavailable") {
      return { kind: "disposition", disposition: { status: "skipped", reason: "catalog-unavailable", retryable: false } };
    }

    const activeBytes = readCatalogGatherSource(session, "active-catalog-merge");
    const cacheBytes = readCatalogGatherSource(session, "models-cache-fallback");
    const keyedBackupBytes = readCatalogGatherSource(session, "hashed-backup-fallback");
    const retainedBytes = readCatalogGatherSource(session, "retained-routed-fallback");
    if (Object.keys(snapshot.config.combos ?? {}).length > 0) {
      readCatalogGatherSource(session, "native-catalog-selection");
    }
    const authOutcomes: CatalogGatherProviderAuthOutcome[] = [];
    const discoveryPolicies: CatalogProviderDiscoveryPolicySnapshot[] = [];
    const comboOmissions: ComboCatalogOmission[] = [];
    providerGatherStarted = true;
    const routedModels = await gatherRoutedModelsForCatalogGather(snapshot.config, session, {
      providerAuthOutcomes: authOutcomes,
      discoveryPolicySnapshots: discoveryPolicies,
      comboOmissions,
    });
    const processLocal = processEvidence(source);
    const sourceEvidence = sealCatalogGatherEvidenceSession(session);
    if (!same(sourceEvidence.required, snapshot.sourceEvidence.required)) {
      return {
        kind: "disposition",
        disposition: { status: "skipped", reason: "stale", retryable: true },
        staleReason: "source-observation",
      };
    }

    let current: CatalogAdmissionSnapshot;
    try {
      current = captureCatalogAdmissionSnapshot(snapshot.config);
    } catch (error) {
      if (error instanceof CatalogAdmissionStaleConfigError) {
        return {
          kind: "disposition",
          disposition: { status: "skipped", reason: "stale", retryable: true },
          staleReason: "generation",
        };
      }
      const message = error instanceof Error ? error.message : "";
      if (error instanceof ConfigMutationLockError
        || message.includes("config generation is busy")
        || message.includes("config generation is database")) {
        return {
          kind: "disposition",
          disposition: { status: "skipped", reason: "busy", retryable: true },
        };
      }
      throw error;
    }
    if (!same(current.configIdentity, snapshot.configIdentity)) {
      return {
        kind: "disposition",
        disposition: { status: "skipped", reason: "stale", retryable: true },
        staleReason: current.generation.value !== snapshot.generation.value
          ? "generation"
          : "source-observation",
      };
    }
    if (!same(current.targets, snapshot.targets)
      || !same(current.sourceEvidence.homeSelection, snapshot.sourceEvidence.homeSelection)
      || !same(current.sourceEvidence.required, snapshot.sourceEvidence.required)) {
      return {
        kind: "disposition",
        disposition: { status: "skipped", reason: "stale", retryable: true },
        staleReason: "target-identity",
      };
    }

    const active = catalogFrom(activeBytes);
    const prepared = prepareCatalog(snapshot.config, source, active, routedModels, catalogFrom(retainedBytes), [
      catalogFrom(keyedBackupBytes)?.models ?? [],
      catalogFrom(cacheBytes)?.models ?? [],
    ]);
    const preparedCatalog = prepared.catalog;
    const preparedCatalogBytes = catalogBytes(preparedCatalog);
    const preparedCache = {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models: preparedCatalog.models ?? [],
    };
    const preparedCacheBytes = `${JSON.stringify(preparedCache, null, 2)}\n`;
    const pristineBytes = active && !catalogHasRoutedEntries(active)
      ? Buffer.from(activeBytes!).toString("utf8")
      : !hasRoutedEntries(source.catalog) ? `${JSON.stringify(source.catalog, null, 2)}\n` : null;
    const notices = new Set<CatalogNotice>();
    if (source.source !== "bundled-catalog-template") notices.add("fallback");
    if (authOutcomes.some(outcome => outcome.state !== "available")) notices.add("provider-auth");
    if (prepared.retainedRows.length > 0) notices.add("provider-network");
    const candidate = {} as CodexCatalogCandidate;
    const catalogChanged = !sameJsonDocument(activeBytes, preparedCatalog);
    const cacheChanged = !sameJsonDocument(cacheBytes, preparedCache);
    const retainedPrepared = prepared.retainedSnapshot === null
      ? null
      : { models: prepared.retainedSnapshot };
    const retainedChanged = retainedPrepared !== null
      && !sameJsonDocument(retainedBytes, retainedPrepared);
    candidateStates.set(candidate, {
      consumed: false,
      requiresManagedRouting: policy.requiresManagedRouting === true,
      sequence: ++nextCandidateSequence,
      config: snapshot.config,
      generation: snapshot.generation,
      configSemanticIdentity: snapshot.configIdentity.snapshotIdentity,
      configContentIdentity: snapshot.configIdentity.contentIdentity,
      catalogInputIdentity: catalogInputIdentity(snapshot.config),
      authority: createCatalogGatherAuthorityIdentity(
        snapshot,
        sourceEvidence,
        processLocal,
        discoveryPolicies,
      ),
      sourceEvidence,
      processLocal,
      home: home.canonicalCodexHome,
      targets: snapshot.targets,
      catalog: { path: paths.catalog, content: preparedCatalogBytes },
      cache: { path: paths.cache, content: preparedCacheBytes },
      ...(pristineBytes ? { keyedBackup: { path: paths.keyedBackup, content: pristineBytes } } : {}),
      ...(prepared.retainedSnapshot === null
        ? {}
        : { retained: { path: paths.retained, models: prepared.retainedSnapshot } }),
      catalogChanged,
      cacheChanged,
      retainedChanged,
      changed: catalogChanged || cacheChanged || retainedChanged,
      notices: Object.freeze([...notices]),
      added: prepared.added,
      comboOmissions: Object.freeze([...comboOmissions]),
      catalogQuality: prepared.catalogQuality,
      rehydrated: prepared.rehydrated,
    });
    return { kind: "candidate", candidate };
  } catch (error) {
    if (error instanceof CatalogGatherBusyError) {
      return { kind: "disposition", disposition: { status: "skipped", reason: "busy", retryable: true } };
    }
    if (!providerGatherStarted) {
      return { kind: "disposition", disposition: { status: "skipped", reason: "refused", retryable: false } };
    }
    return {
      kind: "disposition",
      disposition: { status: "failed", reason: "provider-network", phase: "gather", retryable: true, partialWrite: false },
    };
  }
}

function revalidateCandidate(state: CandidateState): CodexCatalogCommitResult | null {
  if (state.requiresManagedRouting
    && !nonDisruptiveCodexManagementWritePolicy(state.config).allowed) {
    return { kind: "refused", reason: "source-ambiguous" };
  }
  try {
    const authority = captureCatalogConfigAuthority(state.config);
    if (authority.generation.value !== state.generation.value
      || authority.semanticIdentity !== state.configSemanticIdentity
      || authority.contentIdentity !== state.configContentIdentity) {
      return { kind: "stale", reason: "generation" };
    }
  } catch (error) {
    if (error instanceof CatalogAdmissionStaleConfigError) {
      return { kind: "stale", reason: "generation" };
    }
    return { kind: "refused", reason: "source-unreadable" };
  }

  let session: CatalogFilesystemEvidenceSession;
  let validatingTargets = false;
  try {
    session = createCatalogGatherEvidenceSession();
    const home = captureAndSealCatalogHomeSelection(session);
    if (!same(home, state.sourceEvidence.homeSelection)) return { kind: "stale", reason: "home-selection" };
    validatingTargets = true;
    const currentTargets = {
      catalog: captureCatalogGatherTargetIdentity(session, state.catalog.path),
      cache: captureCatalogGatherTargetIdentity(session, state.cache.path),
      catalogBackups: state.targets.catalogBackups.map(identity => (
        captureCatalogGatherTargetIdentity(session, targetPath(identity))
      )),
    };
    if (!same(currentTargets, state.targets)) return { kind: "stale", reason: "target-identity" };
    validatingTargets = false;
    for (const observation of [state.sourceEvidence.required["catalog-target-selection"]]) {
      acceptCatalogGatherSourcePath(session, observation.role, observation.logicalPath);
      readCatalogGatherSource(session, observation.role);
    }
    for (const [role, observations] of Object.entries(state.sourceEvidence.conditional)) {
      for (const observation of observations) {
        acceptCatalogGatherSourcePath(session, role as CatalogSourceRole, observation.logicalPath);
        readCatalogGatherSource(session, role as CatalogSourceRole);
      }
    }
    if (!same(sealCatalogGatherEvidenceSession(session), state.sourceEvidence)) {
      return { kind: "stale", reason: "source-observation" };
    }
  } catch {
    return { kind: "refused", reason: validatingTargets ? "target-unsafe" : "source-unreadable" };
  }

  if (state.processLocal.runtime.state === "used") {
    const current = peekCodexRuntimeProcessCache();
    if (current.kind !== "available" || current.epoch !== state.processLocal.runtime.epoch
      || current.valueIdentity !== state.processLocal.runtime.valueIdentity) {
      return { kind: "stale", reason: "process-local" };
    }
  }
  if (state.processLocal.bundledCatalog.state === "used") {
    const current = bundledCatalogCacheState();
    if (current.epoch !== state.processLocal.bundledCatalog.epoch
      || current.valueIdentity !== state.processLocal.bundledCatalog.valueIdentity) {
      return { kind: "stale", reason: "process-local" };
    }
  }
  return null;
}

function fixedCommit(state: CandidateState, permit: Parameters<typeof replaceActiveCodexCatalog>[0]): CodexCatalogCommitResult {
  let writes: CatalogWriteReceipt = {
    keyedBackup: "not-requested",
    catalog: "not-written",
    cache: "not-written",
  };
  try {
    if (state.keyedBackup) {
      writes = { ...writes, keyedBackup: publishHashedCodexCatalogBackup(permit, state.home, state.keyedBackup) };
    }
    if (state.catalogChanged) {
      replaceActiveCodexCatalog(permit, state.home, state.catalog);
      writes = { ...writes, catalog: "written" };
    }
    if (state.cacheChanged) {
      replaceCodexModelsCache(permit, state.home, state.cache);
      writes = { ...writes, cache: "written" };
    }
    if (state.retained && state.retainedChanged) {
      writeRetainedRoutedCatalogAtPath(state.retained.path, state.retained.models);
    }
    return { kind: "committed", changed: state.changed, writes };
  } catch {
    return { kind: "failed", surface: "disk", writes };
  }
}

export async function commitCodexCatalogCandidate(
  candidate: CodexCatalogCandidate,
  deadlineMs: number,
): Promise<CommitAttempt> {
  const state = candidateStates.get(candidate as object);
  if (!state) return { kind: "refused", reason: "source-ambiguous" };
  if (state.consumed) return { kind: "stale", reason: "candidate-consumed" };
  const deadline = Date.now() + Math.max(0, deadlineMs);
  while (true) {
    const acquired = withCatalogWriteSerialization(state.home, permit => {
      state.consumed = true;
      const guarded = withExpectedConfigGenerationSync(state.generation, () => {
        const invalid = revalidateCandidate(state);
        const result = invalid ?? fixedCommit(state, permit);
        if (result.kind === "committed") publishConvergenceReceipt(state);
        else invalidateConvergenceReceipt(state);
        return result;
      });
      if (guarded.kind === "conflict") {
        invalidateConvergenceReceipt(state);
        return { kind: "stale", reason: "generation" } as const;
      }
      if (guarded.kind === "unavailable") {
        invalidateConvergenceReceipt(state);
        return { kind: "busy" } as const;
      }
      return guarded.value;
    });
    if (acquired.kind === "completed") return acquired.value;
    if (acquired.reason !== "busy" || Date.now() >= deadline) return { kind: "busy" };
    await Bun.sleep(Math.min(10, Math.max(1, deadline - Date.now())));
  }
}

function projectCommit(result: CommitAttempt, notices: readonly CatalogNotice[]): CatalogDisposition {
  if (result.kind === "busy") return { status: "skipped", reason: "busy", retryable: true };
  if (result.kind === "committed") {
    return { status: "committed", changed: result.changed, degraded: notices.length > 0, notices };
  }
  if (result.kind === "stale") return { status: "skipped", reason: "stale", retryable: true };
  if (result.kind === "refused") return { status: "skipped", reason: "refused", retryable: false };
  const partialWrite = result.writes.keyedBackup === "written"
    || result.writes.catalog === "written"
    || result.writes.cache === "written";
  return { status: "failed", reason: "disk", phase: "commit", retryable: false, partialWrite };
}

export async function convergeCodexCatalog(
  snapshot: CatalogAdmissionSnapshot,
  request: ConvergeRequest,
  lifecycle: Readonly<{ onCommitBegin?: () => void }> = {},
): Promise<CodexCatalogConvergenceResult> {
  const emptyProjection = (): CodexCatalogConvergenceProjection => ({
    admittedGeneration: snapshot.generation,
    admittedConfigAuthority: {
      generation: snapshot.generation,
      semanticIdentity: snapshot.configIdentity.snapshotIdentity,
      contentIdentity: snapshot.configIdentity.contentIdentity,
    },
    path: targetPath(snapshot.targets.catalog),
    added: 0,
    catalogWritten: false,
    cacheSynced: false,
    comboOmissions: [],
    catalogQuality: "native-only",
    rehydrated: 0,
  });
  if (request.scope !== "catalog" || request.action !== "converge") {
    return {
      changed: false,
      catalogRefresh: { status: "failed", reason: "disk", phase: "gather", retryable: false, partialWrite: false },
      projection: emptyProjection(),
    };
  }
  const policy = codexCatalogWritePolicy(snapshot.config, request);
  if (!policy.allowed) {
    return {
      changed: false,
      catalogRefresh: { status: "skipped", reason: "refused", retryable: false },
      projection: emptyProjection(),
    };
  }
  const gathered = await gatherCodexCatalogCandidate(snapshot, {
    requiresManagedRouting: policy.requiresManagedRouting,
  });
  if (gathered.kind === "disposition") {
    return {
      changed: false,
      catalogRefresh: gathered.disposition,
      projection: {
        ...emptyProjection(),
        ...(gathered.staleReason ? { staleReason: gathered.staleReason } : {}),
      },
    };
  }
  const state = candidateStates.get(gathered.candidate as object)!;
  lifecycle.onCommitBegin?.();
  const committed = await commitCodexCatalogCandidate(gathered.candidate, request.deadlineMs);
  const catalogWritten = (committed.kind === "committed" || committed.kind === "failed")
    && committed.writes.catalog === "written";
  const cacheSynced = (committed.kind === "committed" || committed.kind === "failed")
    && committed.writes.cache === "written";
  const committedStateApplies = committed.kind === "committed"
    || (committed.kind === "failed" && (catalogWritten || !state.catalogChanged));
  return {
    changed: committed.kind === "committed" ? committed.changed : false,
    catalogRefresh: projectCommit(committed, state.notices),
    projection: {
      admittedGeneration: state.generation,
      admittedConfigAuthority: {
        generation: state.generation,
        semanticIdentity: state.configSemanticIdentity,
        contentIdentity: state.configContentIdentity,
      },
      path: state.catalog.path,
      // `added` and `rehydrated` describe rows this attempt actually published,
      // not rows merely rediscovered during a semantic no-op.
      added: catalogWritten ? state.added : 0,
      catalogWritten,
      cacheSynced,
      comboOmissions: state.comboOmissions,
      catalogQuality: committedStateApplies ? state.catalogQuality : "native-only",
      rehydrated: catalogWritten ? state.rehydrated : 0,
      ...(committed.kind === "stale" ? { staleReason: committed.reason } : {}),
    },
  };
}

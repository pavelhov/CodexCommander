import { join } from "node:path";

import { getConfigDir, websocketsEnabled, withExpectedConfigGenerationSync } from "../config";
import { COMBO_NAMESPACE } from "../combos";
import { getAuthStorePath } from "../oauth/store";
import type { CodexCommanderConfig } from "../types";
import { captureCatalogAdmissionSnapshot } from "./catalog-admission";
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
  type RawCatalog,
  type RawEntry,
} from "./catalog/parsing";
import {
  buildCatalogEntries,
  mergeCatalogEntriesForSync,
  mergeCatalogModelsWithNativeRecovery,
  mergeLiveRoutedEntriesWithRetained,
  orderForSubagents,
} from "./catalog/sync";
import { exactComboCatalogSlugs } from "./catalog/aggregation";
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
  | { readonly kind: "disposition"; readonly disposition: CatalogDisposition };

type CommitAttempt = CodexCatalogCommitResult | { readonly kind: "busy" };

interface CandidateState {
  consumed: boolean;
  readonly generation: CatalogAdmissionSnapshot["generation"];
  readonly authority: CatalogGatherAuthorityIdentity;
  readonly sourceEvidence: CatalogSourceEvidence;
  readonly processLocal: CatalogProcessLocalEvidence;
  readonly home: string;
  readonly targets: CatalogAdmissionSnapshot["targets"];
  readonly catalog: PreparedCatalogFileWrite;
  readonly cache: PreparedCatalogFileWrite;
  readonly keyedBackup?: PreparedCatalogFileWrite;
  readonly changed: boolean;
  readonly notices: readonly CatalogNotice[];
}

const candidateStates = new WeakMap<object, CandidateState>();
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
): { catalog: RawCatalog; retainedRows: RawEntry[] } {
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
  return { catalog, retainedRows: retainedMerge.retainedRows };
}

export async function gatherCodexCatalogCandidate(
  snapshot: CatalogAdmissionSnapshot,
): Promise<CodexCatalogGatherResult> {
  let providerGatherStarted = false;
  try {
    const session = createCatalogGatherEvidenceSession();
    const home = captureAndSealCatalogHomeSelection(session);
    if (!same(home, snapshot.sourceEvidence.homeSelection)) {
      return { kind: "disposition", disposition: { status: "skipped", reason: "stale", retryable: true } };
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
    providerGatherStarted = true;
    const routedModels = await gatherRoutedModelsForCatalogGather(snapshot.config, session, {
      providerAuthOutcomes: authOutcomes,
      discoveryPolicySnapshots: discoveryPolicies,
    });
    const processLocal = processEvidence(source);
    const sourceEvidence = sealCatalogGatherEvidenceSession(session);
    if (!same(sourceEvidence.required, snapshot.sourceEvidence.required)) {
      return { kind: "disposition", disposition: { status: "skipped", reason: "stale", retryable: true } };
    }

    const current = captureCatalogAdmissionSnapshot(snapshot.config);
    if (!same(current.configIdentity, snapshot.configIdentity)
      || !same(current.targets, snapshot.targets)
      || !same(current.sourceEvidence.homeSelection, snapshot.sourceEvidence.homeSelection)
      || !same(current.sourceEvidence.required, snapshot.sourceEvidence.required)) {
      return { kind: "disposition", disposition: { status: "skipped", reason: "stale", retryable: true } };
    }

    const active = catalogFrom(activeBytes);
    const prepared = prepareCatalog(snapshot.config, source, active, routedModels, catalogFrom(retainedBytes), [
      catalogFrom(keyedBackupBytes)?.models ?? [],
      catalogFrom(cacheBytes)?.models ?? [],
    ]);
    const preparedCatalog = prepared.catalog;
    const preparedCatalogBytes = catalogBytes(preparedCatalog);
    const preparedCacheBytes = `${JSON.stringify({
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models: preparedCatalog.models ?? [],
    }, null, 2)}\n`;
    const pristineBytes = active && !catalogHasRoutedEntries(active)
      ? Buffer.from(activeBytes!).toString("utf8")
      : !hasRoutedEntries(source.catalog) ? `${JSON.stringify(source.catalog, null, 2)}\n` : null;
    const notices = new Set<CatalogNotice>();
    if (source.source !== "bundled-catalog-template") notices.add("fallback");
    if (authOutcomes.some(outcome => outcome.state !== "available")) notices.add("provider-auth");
    if (prepared.retainedRows.length > 0) notices.add("provider-network");
    const candidate = {} as CodexCatalogCandidate;
    candidateStates.set(candidate, {
      consumed: false,
      generation: snapshot.generation,
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
      changed: Buffer.from(activeBytes ?? []).toString("utf8") !== preparedCatalogBytes
        || Buffer.from(cacheBytes ?? []).toString("utf8") !== preparedCacheBytes,
      notices: Object.freeze([...notices]),
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
    replaceActiveCodexCatalog(permit, state.home, state.catalog);
    writes = { ...writes, catalog: "written" };
    replaceCodexModelsCache(permit, state.home, state.cache);
    writes = { ...writes, cache: "written" };
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
        return invalid ?? fixedCommit(state, permit);
      });
      if (guarded.kind === "conflict") return { kind: "stale", reason: "generation" } as const;
      if (guarded.kind === "unavailable") return { kind: "busy" } as const;
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
    || result.writes.catalog === "written";
  return { status: "failed", reason: "disk", phase: "commit", retryable: false, partialWrite };
}

export async function convergeCodexCatalog(
  snapshot: CatalogAdmissionSnapshot,
  request: ConvergeRequest,
  lifecycle: Readonly<{ onCommitBegin?: () => void }> = {},
): Promise<Readonly<{ changed: boolean; catalogRefresh: CatalogDisposition }>> {
  if (request.scope !== "catalog" || request.action !== "converge") {
    return {
      changed: false,
      catalogRefresh: { status: "failed", reason: "disk", phase: "gather", retryable: false, partialWrite: false },
    };
  }
  const gathered = await gatherCodexCatalogCandidate(snapshot);
  if (gathered.kind === "disposition") return { changed: false, catalogRefresh: gathered.disposition };
  const state = candidateStates.get(gathered.candidate as object)!;
  lifecycle.onCommitBegin?.();
  const committed = await commitCodexCatalogCandidate(gathered.candidate, request.deadlineMs);
  return {
    changed: committed.kind === "committed" ? committed.changed : false,
    catalogRefresh: projectCommit(committed, state.notices),
  };
}

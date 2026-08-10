/**
 * Shared types for the Codex safe-interruption write substrate.
 *
 * This module is the SINGLE owner of every surface WP9-WP13 share. Two prior
 * attempts failed audit because four phase documents each invented their share
 * of the record schema, the /api/sync contract, and the convergence entry
 * point; the contract is centralized here so a consumer can only import.
 *
 * TYPES ONLY. WP8b deliberately rewires nothing: WP9 supplies the first
 * `ConvergeCodex` implementation. Every phase must typecheck and preserve
 * behavior at its own commit, which a runtime placeholder here would break.
 */
import type { CodexCommanderConfig } from "../types";
import type { ProviderModelDiscoveryFilter } from "../providers/registry";

/**
 * The non-CAS JSON record for the Codex integration.
 *
 * ONE owner. WP12 writes provenance here through `updateIntegrationRecord` —
 * never its own read/merge/write. Cross-process transition state is deliberately
 * absent; it belongs to the CODEX_HOME-keyed SQLite row below.
 *
 * Provenance is required in the current schema. Every persisted level is
 * exact-key validated; unknown fields are not current product state.
 */
export interface CodexIntegrationRecord {
  version: 1;
  provenance: CodexProvenanceLedger;
}

/**
 * Every mutable Codex artifact for which the provenance ledger can authorize a
 * restore. Embedded config fragments share the `config` entry because they are
 * committed and restored as one file.
 */
export type CodexArtifactId =
  | { readonly kind: "config" }
  | { readonly kind: "generated-profile" }
  | { readonly kind: "active-catalog"; readonly canonicalPath: string }
  | { readonly kind: "catalog-backup"; readonly form: "hashed";
      readonly canonicalPath: string }
  | { readonly kind: "models-cache" }
  | { readonly kind: "injection-journal" };

export interface CodexProvenanceEntry {
  artifact: CodexArtifactId;
  baseline:
    | { kind: "absent" }
    | { kind: "present"; sha256: string; bytesBase64: string };
  /** Hash of what WE wrote. null when the write did not complete. */
  postImage: string | null;
  txId: string;
  at: string;
}

export interface CodexProvenanceLedger {
  entries: readonly CodexProvenanceEntry[];
}

export type CodexArtifactObservation =
  | "applied"
  | "absent"
  | "missing"
  | "residue"
  | "drifted"
  | "unreadable"
  | "invalid"
  | "not-evaluated"
  | "unknown";

/**
 * Read-only proof of what Codex has now, not what persisted intent requests.
 * `isApplied` is true only for aggregate `applied`; a partial surface can never
 * be flattened into true. OFF is operationally converged only at `absent`.
 */
export interface CodexObservedState {
  aggregate: "applied" | "absent" | "partial" | "external" | "blocked" | "not-evaluated";
  /** null only for a catalog-scoped request that deliberately did not observe. */
  isApplied: boolean | null;
  desired: "on" | "off" | "unknown";
  /** null only when aggregate is `not-evaluated`. */
  converged: boolean | null;
  authority: {
    service: "owned" | "foreign" | "unknown";
    externalProvider: string | null;
  };
  surfaces: {
    config: CodexArtifactObservation;
    profile: CodexArtifactObservation;
    catalog: CodexArtifactObservation;
    cache: CodexArtifactObservation;
    journal: "absent" | "pending" | "live" | "invalid" | "unknown" | "not-evaluated";
    provenance: {
      state: "verified" | "missing" | "conflict" | "unreadable" | "unknown" | "not-evaluated";
      nativeGeneration: number | null;
      currentTxId: string | null;
    };
  };
}

export type CatalogNotice = "provider-auth" | "provider-network" | "fallback";

/** Sanitized catalog fact safe to append to management mutation responses. */
export type CatalogDisposition =
  | { status: "committed"; changed: boolean; degraded: boolean;
      notices: readonly CatalogNotice[] }
  | { status: "skipped";
      reason: "not-requested" | "catalog-unavailable" | "busy" | "stale" | "refused";
      retryable: boolean }
  | { status: "failed"; reason: "provider-auth" | "provider-network" | "disk";
      phase: "gather" | "commit"; retryable: boolean; partialWrite: boolean };

/**
 * The ONLY way Codex-owned bytes are written. Startup, ensure, /api/sync, the
 * CLI verbs and all 16 management mutation callbacks funnel here.
 *
 * The funnel is the point: admission, generation checks and the lock live in one
 * place, so a new caller cannot forget them. Round 1's 16 callers each held
 * their own path to a commit.
 */
export type ConvergeCodex = (
  request: ConvergeRequest,
) => Promise<ConvergeOutcome>;

export interface ConvergeRequest {
  /**
   * The caller says WHEN, never WHICH WAY.
   *
   * Round 2 N1: an `apply | remove` request let `/api/sync` skip while desired
   * state was OFF instead of removing residue, which violates C11 and
   * contradicts the rule that callers cannot supply desired state. The
   * direction is derived from admitted persisted intent, full stop.
   *
   * `observe` writes nothing and is the status read.
   */
  action: "converge" | "observe";
  /**
   * WP9 management mutations use `catalog`; explicit/lifecycle convergence uses
   * `full`. Scope limits work, but still never lets the caller choose direction.
   */
  scope: "catalog" | "full";
  /** Why, for the record and for log attribution. */
  reason: "startup" | "ensure" | "api-sync" | "cli" | "management-mutation";
  /** Automatic callers fail fast and defer; explicit ones may wait. See §5. */
  mode: "automatic" | "explicit";
  deadlineMs: number;
}

/** Caller-controlled input for the fixed management catalog request shape. */
export interface CatalogConvergeRequestInput {
  deadlineMs: number;
}

export type ConvergeOutcome =
  | { kind: "catalog-only"; changed: boolean;
      observed: CodexObservedState; catalogRefresh: CatalogDisposition }
  | { kind: "converged"; direction: "applied" | "removed"; changed: boolean;
      observed: CodexObservedState; nativeGeneration: number;
      currentTxId: string;
      catalogRefresh: CatalogDisposition }
  | { kind: "skipped"; reason: "already-converged";
      observed: CodexObservedState; catalogRefresh: CatalogDisposition }
  | { kind: "refused"; authority: "service-home" | "external-provider" | "journal" | "provenance";
      message: string; observed: CodexObservedState }
  | { kind: "busy"; surface: "lock" | "config"; retryAfterMs: number }
  | { kind: "deferred"; direction: "applied" | "removed"; changed: boolean;
      unresolved: readonly UnresolvedSurface[];
      nativeGeneration: number; currentTxId: string;
      observed: CodexObservedState; catalogRefresh: CatalogDisposition }
  | { kind: "failed"; surface: string; message: string };

export type CatalogOnlyOutcome = Extract<ConvergeOutcome, { kind: "catalog-only" }>;

export interface ProjectCatalogOnlyOutcomeInput {
  changed: boolean;
  catalogRefresh: CatalogDisposition;
}

/**
 * Note what is NOT here: `desired-off`. Desired OFF is not a skip — it is a
 * `converged` with `direction: "removed"`. That is round 2 N1: the old shape let
 * a sync while OFF return "skipped" and leave routed residue on disk.
 */
export type UnresolvedSurface =
  | "config"
  | "native"
  | "catalog"
  | "cache"
  | "journal"
  | "provenance";

/** Bumped by every cooperating CONFIG write. Owned by src/config.ts. */
export interface ConfigGeneration { readonly value: number; }

/** Bumped by every cooperating NATIVE commit. Owned by transition-state.ts. */
export interface NativeGeneration { readonly value: number; }

export type ConfigGenerationRead =
  | { kind: "ready"; generation: ConfigGeneration }
  | { kind: "unavailable"; reason: "busy" | "database" };

export type ConfigGenerationBump =
  | { kind: "updated"; generation: ConfigGeneration }
  | { kind: "conflict"; current: ConfigGeneration }
  | { kind: "unavailable"; reason: "busy" | "database" };

export type ExpectedConfigGenerationSyncResult<T> =
  | { kind: "matched"; generation: ConfigGeneration; value: T }
  | { kind: "conflict"; current: ConfigGeneration }
  | { kind: "unavailable"; reason: "busy" | "database" };

export type ReadConfigGeneration = () => ConfigGenerationRead;
export type BumpConfigGeneration = (expected: ConfigGeneration) => ConfigGenerationBump;
export type WithExpectedConfigGenerationSync = <T>(
  expected: ConfigGeneration,
  commit: () => T,
) => ExpectedConfigGenerationSyncResult<T>;

export interface CommitExpectation {
  /** Read at admission. */
  readonly nativeBefore: number;
  /** What OUR commit will produce. Always nativeBefore + 1. */
  readonly nativeAfter: number;
  /** Identifies the commit that performed the bump. */
  readonly txId: string;
}

/** The authoritative native-write pair stored under canonical CODEX_HOME. */
export interface CodexTransitionVersion {
  readonly nativeGeneration: number;
  readonly currentTxId: string | null;
}

export interface CodexTransitionState extends CodexTransitionVersion {
}

export type TransitionStateRead =
  | { kind: "ready"; state: CodexTransitionState }
  | { kind: "state-ambiguous"; message: string }
  | { kind: "unavailable"; reason: "busy" | "unsafe-path" | "database" };

export type TransitionStateUpdate =
  | { kind: "updated"; state: CodexTransitionState }
  | { kind: "conflict"; current: CodexTransitionState }
  | { kind: "unavailable"; reason: "busy" | "unsafe-path" | "database" };

export interface BeginCodexTransitionNext {
  readonly txId: string;
}

export type BeginCodexTransition = (
  expected: CodexTransitionVersion,
  next: BeginCodexTransitionNext,
) => TransitionStateUpdate;

export type ReadCodexTransitionState = () => TransitionStateRead;

/**
 * A coordinator transaction never exposes its SQLite connection. The runtime
 * owner adds a private brand so only its one-shot factory can create one.
 */
export interface CodexCoordinatorTransaction {
  readonly beginTransition: BeginCodexTransition;
}

export interface CodexCoordinatorTransactionController {
  readonly capability: CodexCoordinatorTransaction;
  expectation(): CommitExpectation;
  /**
   * The pair the row holds right now, read on the ALREADY-OPEN transaction.
   *
   * A holder needs `currentTxId` to build the conditional update, and
   * `CommitExpectation` carries only the generation pair plus the new txId.
   * Opening a second connection to read it would contend with this
   * transaction's own `BEGIN IMMEDIATE`.
   */
  version(): CodexTransitionVersion;
  assertPublished(expectation: CommitExpectation): void;
  assertStablePath(): void;
  commit(): void;
  rollback(): void;
  close(): void;
}

/** Why a filesystem observation influenced catalog preparation. Closed by contract. */
export type CatalogRequiredSourceRole = "catalog-target-selection";

export type CatalogConditionalSourceRole =
  | "bundled-catalog-template"
  | "active-catalog-merge"
  | "hashed-backup-fallback"
  | "models-cache-fallback"
  | "retained-routed-fallback"
  | "native-catalog-selection"
  | "runtime-selection"
  | "provider-auth-selection";

export type CatalogSourceRole =
  | CatalogRequiredSourceRole
  | CatalogConditionalSourceRole;

/** Portable normalized identity: POSIX dev/inode or Windows volume/file id. */
export interface CatalogFilesystemIdentity {
  readonly volume: string;
  readonly fileId: string;
}

export interface CatalogParentIdentity extends CatalogFilesystemIdentity {
  readonly canonicalPath: string;
}

/** Required evidence for the selector that chose every CODEX_HOME-derived path. */
export interface CatalogHomeSelectionObservation {
  readonly selector: Readonly<{
    readonly kind: "environment" | "default";
    /** Exact pre-canonicalization selector string used by the production resolver. */
    readonly raw: string;
  }>;
  readonly canonicalCodexHome: string;
  readonly rootIdentity: CatalogFilesystemIdentity;
}

export type CatalogProcessLocalObservation =
  | { readonly state: "unused" }
  | { readonly state: "used"; readonly epoch: number; readonly valueIdentity: string };

/** Candidate-bound evidence for mutable process-local authority, never file evidence. */
export interface CatalogProcessLocalEvidence {
  readonly runtime: CatalogProcessLocalObservation;
  readonly bundledCatalog: CatalogProcessLocalObservation;
}

export type CatalogDiscoveryPolicyField<T> =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "present"; value: T }>;

export interface CatalogTrustedOpenAiApiPolicySnapshot {
  readonly state: "unused" | "transport-mismatch" | "registry-models-absent" | "captured";
  readonly models?: readonly string[];
  readonly modelContextWindows?: Readonly<Record<string, number>>;
  readonly modelMaxInputTokens?: Readonly<Record<string, number>>;
  readonly modelInputModalities?: Readonly<Record<string, readonly string[]>>;
  readonly modelReasoningEfforts?: Readonly<Record<string, readonly string[]>>;
}

/** Detached effective policy consumed by one enabled provider inside a gather flight. */
export interface CatalogProviderDiscoveryPolicySnapshot {
  readonly provider: string;
  readonly registryTransportMatch: boolean;
  readonly location: Readonly<{
    readonly spec: "absent" | "present";
    readonly url: CatalogDiscoveryPolicyField<string | undefined>;
    readonly path: CatalogDiscoveryPolicyField<string | undefined>;
    readonly query: CatalogDiscoveryPolicyField<Readonly<Record<string, string>> | undefined>;
  }>;
  readonly finalMethod: "GET";
  readonly finalUrl: string;
  readonly filter: CatalogDiscoveryPolicyField<ProviderModelDiscoveryFilter | undefined>;
  readonly maxResponseBytes: number;
  readonly maxModels: number;
  readonly trustedOpenAiApi: CatalogTrustedOpenAiApiPolicySnapshot;
}

/** Non-secret-bearing identity of every authority input admitted to one gather flight. */
export interface CatalogGatherAuthorityIdentity {
  readonly version: 1;
  /** Process-local keyed HMAC over every component below; never a raw content hash. */
  readonly authorityId: string;
  readonly admittedConfig: Readonly<{
    /** Opaque WeakMap identity of the exact resident Readonly<CodexCommanderConfig> reference. */
    readonly referenceIdentity: string;
    readonly generation: ConfigGeneration;
    /** Keyed HMAC of the exact canonical config snapshot, including secret-bearing fields. */
    readonly snapshotIdentity: string;
    /** Process-keyed identity of the exact persisted config bytes bound to admission. */
    readonly contentIdentity: string;
  }>;
  readonly authSnapshotIdentity: string;
  readonly discoveryPolicyIdentity: string;
  readonly nativeCatalogSourceIdentity: string;
  readonly sourceEvidenceIdentity: string;
  readonly processLocalEvidenceIdentity: string;
}

/** Exact gather-time evidence for one consulted filesystem source. */
export type CatalogSourceObservation<R extends CatalogSourceRole = CatalogSourceRole> =
  | {
      readonly state: "present";
      readonly role: R;
      readonly logicalPath: string;
      readonly canonicalPath: string;
      readonly parentIdentity: CatalogParentIdentity;
      readonly fileIdentity: CatalogFilesystemIdentity;
      /** Digest of the exact buffer returned to gather. */
      readonly sha256: string;
    }
  | {
      readonly state: "absent";
      readonly role: R;
      readonly logicalPath: string;
      readonly canonicalPath: string;
      readonly parentIdentity: CatalogParentIdentity;
      readonly fileIdentity: null;
    };

export type CatalogRequiredSourceObservations = Readonly<{
  [R in CatalogRequiredSourceRole]: CatalogSourceObservation<R>;
}>;

export type CatalogConditionalSourceObservations = Readonly<{
  [R in CatalogConditionalSourceRole]: readonly CatalogSourceObservation<R>[];
}>;

export interface CatalogSourceEvidence {
  /** Required before any CODEX_HOME-derived target or source path is accepted. */
  readonly homeSelection: CatalogHomeSelectionObservation;
  readonly required: CatalogRequiredSourceObservations;
  /** Every role is a required key; an empty list means the role was not consulted. */
  readonly conditional: CatalogConditionalSourceObservations;
}

/** The shared WP8b/WP9 snapshot; it authorizes catalog work only. */
export interface CatalogAdmissionSnapshot {
  config: Readonly<CodexCommanderConfig>;
  generation: ConfigGeneration;
  /** Exact retained-reference/generation/snapshot identity used by gather authority. */
  readonly configIdentity: CatalogGatherAuthorityIdentity["admittedConfig"];
  targets: Readonly<{
    catalog: string;
    cache: string;
    catalogBackups: readonly string[];
  }>;
  /** Candidate-bound present/absent evidence, produced by the sole read owner. */
  sourceEvidence: CatalogSourceEvidence;
}

export interface AdmissionSnapshot {
  config: Readonly<CodexCommanderConfig>;
  configDigest: string;
  intent: "on" | "off";
  /**
   * `present:false` means the coordinator database did not exist when this was
   * captured. It is not a baseline: it authorizes a write only when the read
   * taken inside the config transaction returns exactly 0.
   */
  generation: Readonly<{ present: boolean; value: number }>;
  ownership: "owned" | "foreign" | "unknown";
  externalProvider: string | null;
  canonicalTargets: Readonly<{
    codexHome: string;
    codexCommanderHome: string;
    config: string;
    profile: string;
    catalog: string;
    cache: string;
    journal: string;
    integrationRecord: string;
    catalogBackups: readonly string[];
  }>;
  journalIdentity: string;
  provenanceIdentity: string;
  /** Digest of every authority field above. */
  authoritySnapshotId: string;
}

/**
 * Effective-user identity for the lock namespace.
 *
 * NOT a home path. Bun 1.3.14 returns an environment-controlled home from both
 * os.homedir() AND os.userInfo().homedir, so any home-derived namespace can be
 * split by a service and a CLI that see different HOME values — which defeats
 * exclusion entirely, silently.
 */
export type UserIdentity =
  | { platform: "posix"; uid: number }
  | { platform: "win32"; sid: string };

/**
 * Resolve the effective account from operating-system identity APIs only.
 * Failure is a typed namespace refusal; username/home/environment fallback is
 * forbidden because it can split one account across two lock databases.
 */
export type ResolveEffectiveUserIdentity = () => UserIdentity;

/**
 * Return the FINAL SQLite coordinator database path for this exact canonical
 * CODEX_HOME. Consumers append no uid/SID, version, directory or filename.
 */
export type ResolveCodexCoordinatorDatabasePath = (
  identity: UserIdentity,
  canonicalCodexHome: string,
) => string;

/**
 * Return K's FINAL database path; this is never the native coordinator path.
 *
 * Catalog serialization is a separate ownership surface from N. `K -> C` is a
 * legal order and `N -> K` nests, so one shared database would self-contend.
 * Consumers append no uid/SID, version, directory or filename.
 */
export type ResolveCodexCatalogSerializationDatabasePath = (
  identity: UserIdentity,
  canonicalCodexHome: string,
) => string;

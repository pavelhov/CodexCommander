import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { getConfigDir } from "../config";
import {
  assertStableLockFile,
  openStableLockFile,
  type StableLockFile,
} from "../codex/native-main-lock-file";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import type { MediaSafeFailureCode } from "./media-errors";
import type { MediaCredentialBinding } from "./types";

export const MEDIA_JOURNAL_SCHEMA_VERSION = 2;
export const MEDIA_JOURNAL_FILENAME = "media-journal.sqlite";
const MEDIA_STATE_DIRECTORY = "media";
const RECOVERY_OWNER_SUFFIX = ".recovery-owner.sqlite";
const MAX_ROWS = 1_024;
/** Durable terminal-id visibility lease; terminal transitions already persist updated_at atomically. */
export const VIDEO_JOB_RECOVERY_RETENTION_MS = 24 * 60 * 60_000;
const claimedJournalPaths = new Set<string>();

export interface MediaJournalOwnerLease {
  readonly journalPath: string;
  assertOwned(): void;
  close(): void;
}

export type VideoJobState =
  | "queued"
  | "submitting"
  | "accepted"
  | "polling"
  | "needs_auth"
  | "downloading"
  | "download_failed"
  | "outcome_unknown"
  | "completed"
  | "artifact_pruned"
  | "failed"
  | "expired"
  | "cancelled"
  | "acknowledged";

export type SafeMediaFailure =
  | MediaSafeFailureCode
  | "download_rejected"
  | "job_failed"
  | "job_expired";

export interface VideoJobRecord {
  readonly id: string;
  readonly revision: number;
  readonly state: VideoJobState;
  readonly binding: MediaCredentialBinding;
  readonly deadlineAt: number;
  readonly requestId?: string;
  readonly artifactId?: string;
  readonly artifactExpiresAt?: number;
  readonly safeError?: SafeMediaFailure;
  readonly probeOperationId?: string;
  readonly confirmationRevision?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PublicVideoJob {
  readonly id: string;
  readonly revision: number;
  readonly state: VideoJobState;
  readonly deadlineAt: number;
  readonly artifactId?: string;
  readonly safeError?: SafeMediaFailure;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type VideoJobReservation =
  | { kind: "created"; job: VideoJobRecord }
  | { kind: "busy"; reservationId: string };

export type VideoJobUpdate =
  | { kind: "updated"; job: VideoJobRecord }
  | { kind: "conflict"; current: VideoJobRecord | null };

export type ArtifactPinReleaseResult = "released" | "protected" | "conflict" | "not_owned";
export type ArtifactPinPreflightResult = "releasable" | "protected" | "conflict" | "not_owned";
export type ArtifactPinFinalizeResult = "finalized" | "protected" | "conflict" | "not_owned";

export interface TransitionVideoJobInput {
  id: string;
  expectedRevision: number;
  from: readonly VideoJobState[];
  to: VideoJobState;
  safeError?: SafeMediaFailure | null;
  artifactId?: string | null;
}

export interface VideoJobStoreOptions {
  /** Fixed test/deployment seam. Production callers should omit it. */
  path?: string;
  now?: () => number;
}

export type CapabilityProbeStepKind = "image" | "video";
export type CapabilityProbeStepState =
  | "pending"
  | "submitting"
  | "accepted"
  | "completed"
  | "failed"
  | "outcome_unknown"
  | "acknowledged";
export type CapabilityProbeDispatchCertainty =
  | "not_dispatched"
  | "dispatch_started"
  | "accepted"
  | "definite_rejection"
  | "outcome_unknown"
  | "completed";

export interface CapabilityProbeStepRecord {
  readonly kind: CapabilityProbeStepKind;
  readonly revision: number;
  readonly state: CapabilityProbeStepState;
  readonly dispatchCertainty: CapabilityProbeDispatchCertainty;
  readonly safeError?: SafeMediaFailure;
  readonly artifactId?: string;
  readonly artifactExpiresAt?: number;
  readonly videoJobId?: string;
  readonly confirmationRevision?: number;
  readonly verifiedAt?: number;
  readonly inspectedAt?: number;
  readonly updatedAt: number;
}

export interface CapabilityProbeRecord {
  readonly id: string;
  readonly revision: number;
  /** Private stable binding digest. Never put this record directly into CLI/management output. */
  readonly bindingDigest: string;
  readonly imageModel: string;
  readonly videoModel: string;
  readonly contractRevision: string;
  readonly probeVersion: number;
  readonly confirmationRevision?: number;
  readonly confirmationExpiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly steps: Readonly<Record<CapabilityProbeStepKind, CapabilityProbeStepRecord>>;
}

export interface PublicCapabilityProbe {
  readonly id: string;
  readonly revision: number;
  readonly imageModel: string;
  readonly videoModel: string;
  readonly contractRevision: string;
  readonly probeVersion: number;
  readonly confirmationRevision?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly steps: Readonly<Record<CapabilityProbeStepKind, CapabilityProbeStepRecord>>;
}

export type CapabilityProbeUpdate =
  | { kind: "updated"; probe: CapabilityProbeRecord }
  | { kind: "conflict"; current: CapabilityProbeRecord | null };

export interface CapabilityArtifactDeletion {
  readonly operationId: string;
  readonly step: CapabilityProbeStepKind;
  readonly stepRevision: number;
  readonly artifactId: string;
}

interface VideoJobRow {
  id: unknown;
  revision: unknown;
  state: unknown;
  auth_source: unknown;
  provider_kind: unknown;
  slot_ref: unknown;
  binding_digest: unknown;
  deadline_at: unknown;
  request_id: unknown;
  artifact_id: unknown;
  safe_error: unknown;
  probe_operation_id: unknown;
  confirmation_revision: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface CapabilityProbeRow {
  id: unknown;
  key_digest: unknown;
  revision: unknown;
  binding_digest: unknown;
  image_model: unknown;
  video_model: unknown;
  contract_revision: unknown;
  probe_version: unknown;
  confirmation_revision: unknown;
  confirmation_expires_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface CapabilityProbeStepRow {
  operation_id: unknown;
  step_kind: unknown;
  revision: unknown;
  state: unknown;
  dispatch_certainty: unknown;
  safe_error: unknown;
  artifact_id: unknown;
  artifact_expires_at: unknown;
  video_job_id: unknown;
  confirmation_revision: unknown;
  verified_at: unknown;
  inspected_at: unknown;
  updated_at: unknown;
}

export const VIDEO_ADMISSION_HOLDING_STATES: readonly VideoJobState[] = [
  "queued",
  "submitting",
  "accepted",
  "polling",
  "needs_auth",
  "downloading",
  "download_failed",
  "outcome_unknown",
];

const ALL_STATES: readonly VideoJobState[] = [
  ...VIDEO_ADMISSION_HOLDING_STATES,
  "completed",
  "artifact_pruned",
  "failed",
  "expired",
  "cancelled",
  "acknowledged",
];

const EVICTABLE_TERMINAL_STATES: readonly VideoJobState[] = [
  "completed",
  "artifact_pruned",
  "failed",
  "expired",
  "cancelled",
  "acknowledged",
];

const PROBE_OBLIGATION_STATES: readonly CapabilityProbeStepState[] = [
  "submitting",
  "accepted",
  "outcome_unknown",
];

const LEGAL_TRANSITIONS: Readonly<Record<VideoJobState, readonly VideoJobState[]>> = {
  queued: ["submitting", "cancelled"],
  submitting: ["accepted", "needs_auth", "outcome_unknown", "failed", "cancelled"],
  accepted: ["polling", "needs_auth", "downloading", "failed", "expired", "cancelled"],
  polling: ["accepted", "needs_auth", "downloading", "download_failed", "failed", "expired", "cancelled"],
  needs_auth: ["polling", "accepted", "expired", "cancelled"],
  downloading: ["completed", "download_failed", "expired", "cancelled"],
  download_failed: ["accepted", "polling", "downloading", "expired", "cancelled"],
  outcome_unknown: ["acknowledged"],
  completed: ["artifact_pruned"],
  artifact_pruned: [],
  failed: [],
  expired: [],
  cancelled: [],
  acknowledged: [],
};

const SAFE_FAILURES: readonly SafeMediaFailure[] = [
  "needs_auth",
  "entitlement_denied",
  "rate_limited",
  "policy_rejected",
  "ambiguous_submission",
  "upstream_failed",
  "cancelled",
  "timeout",
  "download_rejected",
  "job_failed",
  "job_expired",
];

const PROBE_STEP_STATES: readonly CapabilityProbeStepState[] = [
  "pending", "submitting", "accepted", "completed", "failed", "outcome_unknown", "acknowledged",
];
const PROBE_DISPATCH_CERTAINTIES: readonly CapabilityProbeDispatchCertainty[] = [
  "not_dispatched", "dispatch_started", "accepted", "definite_rejection", "outcome_unknown", "completed",
];

const CREATE_VIDEO_JOBS = `
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    state TEXT NOT NULL CHECK(state IN (${ALL_STATES.map(state => `'${state}'`).join(",")})),
    auth_source TEXT NOT NULL CHECK(auth_source IN ('subscription_oauth','api_key')),
    provider_kind TEXT NOT NULL CHECK(provider_kind IN ('canonical','legacy_alias')),
    slot_ref TEXT NOT NULL CHECK(length(slot_ref) BETWEEN 1 AND 256),
    binding_digest TEXT NOT NULL CHECK(length(binding_digest) BETWEEN 1 AND 128),
    deadline_at INTEGER NOT NULL CHECK(deadline_at > 0),
    request_id TEXT CHECK(request_id IS NULL OR length(request_id) BETWEEN 1 AND 512),
    artifact_id TEXT CHECK(artifact_id IS NULL OR length(artifact_id) BETWEEN 1 AND 256),
    safe_error TEXT CHECK(safe_error IS NULL OR safe_error IN (${SAFE_FAILURES.map(value => `'${value}'`).join(",")})),
    probe_operation_id TEXT CHECK(probe_operation_id IS NULL OR length(probe_operation_id) BETWEEN 1 AND 64),
    confirmation_revision INTEGER CHECK(confirmation_revision IS NULL OR confirmation_revision > 0),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0)
  ) STRICT`;

const CREATE_ACTIVE_BINDING_INDEX = `
  CREATE UNIQUE INDEX video_jobs_one_active_binding
  ON video_jobs(binding_digest)
  WHERE state IN (${VIDEO_ADMISSION_HOLDING_STATES.map(state => `'${state}'`).join(",")})`;

const CREATE_CAPABILITY_PROBES = `
  CREATE TABLE capability_probes (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
    key_digest TEXT NOT NULL UNIQUE CHECK(length(key_digest) BETWEEN 1 AND 128),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    binding_digest TEXT NOT NULL CHECK(length(binding_digest) BETWEEN 1 AND 128),
    image_model TEXT NOT NULL CHECK(length(image_model) BETWEEN 1 AND 128),
    video_model TEXT NOT NULL CHECK(length(video_model) BETWEEN 1 AND 128),
    contract_revision TEXT NOT NULL CHECK(length(contract_revision) BETWEEN 1 AND 128),
    probe_version INTEGER NOT NULL CHECK(probe_version > 0),
    confirmation_revision INTEGER CHECK(confirmation_revision IS NULL OR confirmation_revision > 0),
    confirmation_expires_at INTEGER CHECK(confirmation_expires_at IS NULL OR confirmation_expires_at > 0),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0)
  ) STRICT`;

const CREATE_CAPABILITY_PROBE_STEPS = `
  CREATE TABLE capability_probe_steps (
    operation_id TEXT NOT NULL REFERENCES capability_probes(id) ON DELETE RESTRICT,
    step_kind TEXT NOT NULL CHECK(step_kind IN ('image','video')),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    state TEXT NOT NULL CHECK(state IN (${PROBE_STEP_STATES.map(value => `'${value}'`).join(",")})),
    dispatch_certainty TEXT NOT NULL CHECK(dispatch_certainty IN (${PROBE_DISPATCH_CERTAINTIES.map(value => `'${value}'`).join(",")})),
    safe_error TEXT CHECK(safe_error IS NULL OR safe_error IN (${SAFE_FAILURES.map(value => `'${value}'`).join(",")})),
    artifact_id TEXT CHECK(artifact_id IS NULL OR length(artifact_id) BETWEEN 1 AND 256),
    artifact_expires_at INTEGER CHECK(artifact_expires_at IS NULL OR artifact_expires_at > 0),
    video_job_id TEXT CHECK(video_job_id IS NULL OR length(video_job_id) BETWEEN 1 AND 64),
    confirmation_revision INTEGER CHECK(confirmation_revision IS NULL OR confirmation_revision > 0),
    verified_at INTEGER CHECK(verified_at IS NULL OR verified_at > 0),
    inspected_at INTEGER CHECK(inspected_at IS NULL OR inspected_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0),
    PRIMARY KEY(operation_id, step_kind)
  ) STRICT`;

function journalError(message: string): Error {
  const error = new Error(message);
  error.name = "MediaJournalError";
  return error;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database (?:is|table is) locked/i.test(message);
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && value.trim() === value
    && !/[\x00-\x1f\x7f]/.test(value);
}

function validInteger(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function validState(value: unknown): value is VideoJobState {
  return typeof value === "string" && (ALL_STATES as readonly string[]).includes(value);
}

function validSafeFailure(value: unknown): value is SafeMediaFailure {
  return typeof value === "string" && (SAFE_FAILURES as readonly string[]).includes(value);
}

function assertPrivateDirectory(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.nlink < 1) {
    throw journalError("The private media journal directory is unsafe.");
  }
  if (process.platform === "win32") {
    if (!hardenSecretDir(path, { required: true, timeoutMemoKey: `${path}::media` }).ok) {
      throw journalError("The private media journal directory could not be secured.");
    }
    return;
  }
  const uid = process.getuid?.();
  if (uid === undefined || stats.uid !== uid) throw journalError("The private media journal directory has unsafe ownership.");
  if (existed && (stats.mode & 0o777) !== 0o700) {
    throw journalError("The private media journal directory has unsafe permissions.");
  }
  chmodSync(path, 0o700);
  const hardened = lstatSync(path);
  if ((hardened.mode & 0o777) !== 0o700) throw journalError("The private media journal directory has unsafe permissions.");
}

function assertPrivateFile(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw journalError("The private media journal file is unsafe.");
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || stats.uid !== uid || (stats.mode & 0o777) !== 0o600) {
      throw journalError("The private media journal file has unsafe ownership or permissions.");
    }
  }
}

function hardenJournalFile(path: string): void {
  if (process.platform === "win32") {
    if (!hardenSecretPath(path, { required: true, timeoutMemoKey: `${path}::media` }).ok) {
      throw journalError("The private media journal file could not be secured.");
    }
  } else {
    chmodSync(path, 0o600);
  }
  assertPrivateFile(lstatSync(path));
}

function assertExistingJournalSidecars(path: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    if (!existsSync(sidecar)) continue;
    const stats = lstatSync(sidecar);
    assertPrivateFile(stats);
    if (realpathSync.native(sidecar) !== sidecar) {
      throw journalError("The private media journal sidecar is unsafe.");
    }
  }
}

function databaseSchemaIsEmpty(database: Database): boolean {
  return database.query<Record<string, unknown>, []>("SELECT 1 FROM sqlite_schema LIMIT 1").get() === null;
}

function initializeSchema(database: Database): void {
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
  if (version === 0) {
    if (!databaseSchemaIsEmpty(database)) throw journalError("The media journal schema is unsupported.");
    database.exec(CREATE_VIDEO_JOBS);
    database.exec(CREATE_ACTIVE_BINDING_INDEX);
    database.exec(CREATE_CAPABILITY_PROBES);
    database.exec(CREATE_CAPABILITY_PROBE_STEPS);
    database.exec(`PRAGMA user_version = ${MEDIA_JOURNAL_SCHEMA_VERSION}`);
  } else if (version !== MEDIA_JOURNAL_SCHEMA_VERSION) {
    throw journalError("The media journal schema version is unsupported.");
  }
  const required = new Set([
    "id", "revision", "state", "auth_source", "provider_kind", "slot_ref", "binding_digest",
    "deadline_at", "request_id", "artifact_id", "safe_error", "probe_operation_id",
    "confirmation_revision", "created_at", "updated_at",
  ]);
  const columns = database.query<{ name: string }, []>("PRAGMA table_info(video_jobs)").all();
  if (columns.length !== required.size || columns.some(column => !required.delete(column.name)) || required.size !== 0) {
    throw journalError("The media journal schema is malformed.");
  }
  const probeColumns = new Set([
    "id", "key_digest", "revision", "binding_digest", "image_model", "video_model",
    "contract_revision", "probe_version", "confirmation_revision", "confirmation_expires_at",
    "created_at", "updated_at",
  ]);
  const observedProbeColumns = database.query<{ name: string }, []>("PRAGMA table_info(capability_probes)").all();
  if (
    observedProbeColumns.length !== probeColumns.size
    || observedProbeColumns.some(column => !probeColumns.delete(column.name))
    || probeColumns.size !== 0
  ) throw journalError("The media journal probe schema is malformed.");
  const stepColumns = new Set([
    "operation_id", "step_kind", "revision", "state", "dispatch_certainty", "safe_error",
    "artifact_id", "artifact_expires_at", "video_job_id", "confirmation_revision", "verified_at", "inspected_at", "updated_at",
  ]);
  const observedStepColumns = database.query<{ name: string }, []>("PRAGMA table_info(capability_probe_steps)").all();
  if (
    observedStepColumns.length !== stepColumns.size
    || observedStepColumns.some(column => !stepColumns.delete(column.name))
    || stepColumns.size !== 0
  ) throw journalError("The media journal probe-step schema is malformed.");
}

function rowToJob(row: VideoJobRow | null): VideoJobRecord | null {
  if (!row) return null;
  if (
    !validText(row.id, 64)
    || !validInteger(row.revision)
    || !validState(row.state)
    || (row.auth_source !== "subscription_oauth" && row.auth_source !== "api_key")
    || (row.provider_kind !== "canonical" && row.provider_kind !== "legacy_alias")
    || !validText(row.slot_ref, 256)
    || !validText(row.binding_digest, 128)
    || !validInteger(row.deadline_at, 1)
    || (row.request_id !== null && !validText(row.request_id, 512))
    || (row.artifact_id !== null && !validText(row.artifact_id, 256))
    || (row.safe_error !== null && !validSafeFailure(row.safe_error))
    || (row.probe_operation_id !== null && !validText(row.probe_operation_id, 64))
    || (row.confirmation_revision !== null && !validInteger(row.confirmation_revision, 1))
    || !validInteger(row.created_at, 1)
    || !validInteger(row.updated_at, 1)
  ) throw journalError("The media journal contains a malformed job.");
  return {
    id: row.id,
    revision: row.revision,
    state: row.state,
    binding: {
      authSource: row.auth_source,
      providerKind: row.provider_kind,
      slotRef: row.slot_ref,
      identityDigest: row.binding_digest,
    },
    deadlineAt: row.deadline_at,
    ...(row.request_id !== null ? { requestId: row.request_id } : {}),
    ...(row.artifact_id !== null ? { artifactId: row.artifact_id } : {}),
    ...(row.safe_error !== null ? { safeError: row.safe_error } : {}),
    ...(row.probe_operation_id !== null ? { probeOperationId: row.probe_operation_id } : {}),
    ...(row.confirmation_revision !== null ? { confirmationRevision: row.confirmation_revision } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicJob(job: VideoJobRecord): PublicVideoJob {
  return {
    id: job.id,
    revision: job.revision,
    state: job.state,
    deadlineAt: job.deadlineAt,
    ...(job.artifactId && job.state !== "artifact_pruned" && job.state !== "expired"
      ? { artifactId: job.artifactId }
      : {}),
    ...(job.safeError ? { safeError: job.safeError } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function validProbeStepState(value: unknown): value is CapabilityProbeStepState {
  return typeof value === "string" && (PROBE_STEP_STATES as readonly string[]).includes(value);
}

function validProbeDispatch(value: unknown): value is CapabilityProbeDispatchCertainty {
  return typeof value === "string" && (PROBE_DISPATCH_CERTAINTIES as readonly string[]).includes(value);
}

function rowToProbeStep(row: CapabilityProbeStepRow | null): CapabilityProbeStepRecord | null {
  if (!row) return null;
  if (
    (row.step_kind !== "image" && row.step_kind !== "video")
    || !validInteger(row.revision)
    || !validProbeStepState(row.state)
    || !validProbeDispatch(row.dispatch_certainty)
    || (row.safe_error !== null && !validSafeFailure(row.safe_error))
    || (row.artifact_id !== null && (!validText(row.artifact_id, 256) || !safeArtifactId(row.artifact_id)))
    || (row.artifact_expires_at !== null && !validInteger(row.artifact_expires_at, 1))
    || (row.video_job_id !== null && !validText(row.video_job_id, 64))
    || (row.confirmation_revision !== null && !validInteger(row.confirmation_revision, 1))
    || (row.verified_at !== null && !validInteger(row.verified_at, 1))
    || (row.inspected_at !== null && !validInteger(row.inspected_at, 1))
    || !validInteger(row.updated_at, 1)
  ) throw journalError("The media journal contains a malformed probe step.");
  return {
    kind: row.step_kind,
    revision: row.revision,
    state: row.state,
    dispatchCertainty: row.dispatch_certainty,
    ...(row.safe_error !== null ? { safeError: row.safe_error } : {}),
    ...(row.artifact_id !== null ? { artifactId: row.artifact_id } : {}),
    ...(row.artifact_expires_at !== null ? { artifactExpiresAt: row.artifact_expires_at } : {}),
    ...(row.video_job_id !== null ? { videoJobId: row.video_job_id } : {}),
    ...(row.confirmation_revision !== null ? { confirmationRevision: row.confirmation_revision } : {}),
    ...(row.verified_at !== null ? { verifiedAt: row.verified_at } : {}),
    ...(row.inspected_at !== null ? { inspectedAt: row.inspected_at } : {}),
    updatedAt: row.updated_at,
  };
}

function publicProbe(probe: CapabilityProbeRecord): PublicCapabilityProbe {
  return {
    id: probe.id,
    revision: probe.revision,
    imageModel: probe.imageModel,
    videoModel: probe.videoModel,
    contractRevision: probe.contractRevision,
    probeVersion: probe.probeVersion,
    ...(probe.confirmationRevision !== undefined ? { confirmationRevision: probe.confirmationRevision } : {}),
    createdAt: probe.createdAt,
    updatedAt: probe.updatedAt,
    steps: probe.steps,
  };
}

function safeArtifactId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value) && !value.includes("..");
}

function safeRequestId(value: string): boolean {
  return validText(value, 512);
}

export function defaultMediaJournalPath(): string {
  return join(getConfigDir(), MEDIA_STATE_DIRECTORY, MEDIA_JOURNAL_FILENAME);
}

function canonicalMediaJournalPath(selected: string): string {
  const resolvedPath = resolve(selected);
  if (!isAbsolute(resolvedPath)) throw journalError("The media journal path must be absolute.");
  const requestedDirectory = dirname(resolvedPath);
  assertNotRealHomeUnderTest(requestedDirectory);
  assertPrivateDirectory(requestedDirectory);
  return join(realpathSync.native(requestedDirectory), basename(resolvedPath));
}

/**
 * Acquire the same process-lifetime lease used by the runtime before inspecting
 * or moving journal bytes. The SQLite transaction is OS-backed and survives no
 * process crash; the stable descriptor prevents lock-path replacement while it
 * is held.
 */
export function acquireMediaJournalOwnerLease(selected = defaultMediaJournalPath()): MediaJournalOwnerLease {
  const journalPath = canonicalMediaJournalPath(selected);
  const ownerPath = `${journalPath}${RECOVERY_OWNER_SUFFIX}`;
  if (claimedJournalPaths.has(journalPath)) throw journalError("The media journal is busy.");
  claimedJournalPaths.add(journalPath);
  let ownerFile: StableLockFile | undefined;
  let ownerDatabase: Database | undefined;
  let closed = false;
  try {
    const ownerExisted = existsSync(ownerPath);
    if (ownerExisted) assertPrivateFile(lstatSync(ownerPath));
    assertExistingJournalSidecars(ownerPath);
    ownerFile = openStableLockFile(ownerPath);
    if (!ownerExisted || process.platform === "win32") hardenJournalFile(ownerPath);
    assertStableLockFile(ownerPath, ownerFile);
    ownerDatabase = new Database(ownerPath, { create: true, strict: true });
    ownerDatabase.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = NORMAL; PRAGMA journal_mode = DELETE");
    ownerDatabase.exec("BEGIN EXCLUSIVE");
    ownerDatabase.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_schema LIMIT 1").get();
    assertStableLockFile(ownerPath, ownerFile);
    const database = ownerDatabase;
    const file = ownerFile;
    return {
      journalPath,
      assertOwned() {
        if (closed) throw journalError("The media journal owner lease is closed.");
        assertStableLockFile(ownerPath, file);
      },
      close() {
        if (closed) return;
        closed = true;
        try { database.exec("ROLLBACK"); } catch { /* close still releases */ }
        try { database.close(); } finally {
          try { file.close(); } finally { claimedJournalPaths.delete(journalPath); }
        }
      },
    };
  } catch (error) {
    try { ownerDatabase?.exec("ROLLBACK"); } catch { /* close below */ }
    try { ownerDatabase?.close(); } catch { /* mapped below */ }
    try { ownerFile?.close(); } catch { /* mapped below */ }
    claimedJournalPaths.delete(journalPath);
    if (error instanceof Error && error.name === "MediaJournalError") throw error;
    throw journalError(isBusy(error) ? "The media journal is busy." : "The media journal is unavailable.");
  }
}

export class VideoJobStore {
  readonly #database: Database;
  readonly #file: StableLockFile;
  readonly #ownerLease: MediaJournalOwnerLease;
  readonly #path: string;
  readonly #identity: string;
  readonly #now: () => number;
  #closed = false;

  constructor(options: VideoJobStoreOptions = {}) {
    const selected = options.path ?? defaultMediaJournalPath();
    this.#path = canonicalMediaJournalPath(selected);
    const directory = dirname(this.#path);
    const ownerPath = `${this.#path}${RECOVERY_OWNER_SUFFIX}`;
    const productionPath = options.path === undefined;
    if (productionPath) {
      const root = getConfigDir();
      recordOwnedConfigPath(root, directory);
      for (const suffix of ["", "-journal", "-wal", "-shm"]) recordOwnedConfigPath(root, `${this.#path}${suffix}`);
      for (const suffix of ["", "-journal", "-wal", "-shm"]) recordOwnedConfigPath(root, `${ownerPath}${suffix}`);
    }

    let file: StableLockFile | undefined;
    let database: Database | undefined;
    let ownerLease: MediaJournalOwnerLease | undefined;
    try {
      ownerLease = acquireMediaJournalOwnerLease(this.#path);

      const existed = existsSync(this.#path);
      if (existed) assertPrivateFile(lstatSync(this.#path));
      assertExistingJournalSidecars(this.#path);
      file = openStableLockFile(this.#path);
      if (!existed || process.platform === "win32") hardenJournalFile(this.#path);
      assertStableLockFile(this.#path, file);
      const fileStats = lstatSync(this.#path);
      assertPrivateFile(fileStats);
      this.#identity = `${fileStats.dev}:${fileStats.ino}`;
      database = new Database(this.#path, { create: true, strict: true });
      database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = NORMAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
      const mode = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get()?.journal_mode;
      const lockingMode = database.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get()?.locking_mode;
      const synchronous = database.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous;
      if (mode?.toLowerCase() !== "delete" || lockingMode?.toLowerCase() !== "normal" || synchronous !== 2) {
        throw journalError("The media journal durability mode is unavailable.");
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        initializeSchema(database);
        const count = database.query<{ count: number }, []>("SELECT count(*) AS count FROM video_jobs").get()?.count;
        const probeCount = database.query<{ count: number }, []>("SELECT count(*) AS count FROM capability_probes").get()?.count;
        if (!validInteger(count) || count > MAX_ROWS || !validInteger(probeCount) || probeCount > MAX_ROWS) {
          throw journalError("The media journal row limit was exceeded.");
        }
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* close below */ }
        throw error;
      }
      this.#database = database;
      this.#file = file;
      this.#ownerLease = ownerLease;
      this.#now = options.now ?? Date.now;
    } catch (error) {
      try { database?.close(); } catch { /* mapped below */ }
      try { file?.close(); } catch { /* mapped below */ }
      try { ownerLease?.close(); } catch { /* mapped below */ }
      if (error instanceof Error && error.name === "MediaJournalError") throw error;
      throw journalError(isBusy(error) ? "The media journal is busy." : "The media journal is unavailable.");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw journalError("The media journal is closed.");
    assertStableLockFile(this.#path, this.#file);
    this.#ownerLease.assertOwned();
    const stats = lstatSync(this.#path);
    assertPrivateFile(stats);
    if (`${stats.dev}:${stats.ino}` !== this.#identity || realpathSync.native(this.#path) !== this.#path) {
      throw journalError("The media journal identity changed.");
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#assertOpen();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* close still releases */ }
      throw error;
    }
  }

  #get(id: string): VideoJobRecord | null {
    if (!validText(id, 64)) return null;
    return rowToJob(this.#database.query<VideoJobRow, [string]>("SELECT * FROM video_jobs WHERE id = ?").get(id));
  }

  #getProbe(id: string): CapabilityProbeRecord | null {
    if (!validText(id, 64)) return null;
    const row = this.#database.query<CapabilityProbeRow, [string]>(
      "SELECT * FROM capability_probes WHERE id = ?",
    ).get(id);
    if (!row) return null;
    if (
      !validText(row.id, 64)
      || !validText(row.key_digest, 128)
      || !validInteger(row.revision)
      || !validText(row.binding_digest, 128)
      || !validText(row.image_model, 128)
      || !validText(row.video_model, 128)
      || !validText(row.contract_revision, 128)
      || !validInteger(row.probe_version, 1)
      || (row.confirmation_revision !== null && !validInteger(row.confirmation_revision, 1))
      || (row.confirmation_expires_at !== null && !validInteger(row.confirmation_expires_at, 1))
      || !validInteger(row.created_at, 1)
      || !validInteger(row.updated_at, 1)
    ) throw journalError("The media journal contains a malformed capability probe.");
    const stepRows = this.#database.query<CapabilityProbeStepRow, [string]>(
      "SELECT * FROM capability_probe_steps WHERE operation_id = ? ORDER BY step_kind ASC",
    ).all(id);
    if (stepRows.length !== 2) throw journalError("The media capability probe has incomplete steps.");
    const image = rowToProbeStep(stepRows.find(step => step.step_kind === "image") ?? null);
    const video = rowToProbeStep(stepRows.find(step => step.step_kind === "video") ?? null);
    if (!image || !video) throw journalError("The media capability probe has malformed steps.");
    return {
      id: row.id,
      revision: row.revision,
      bindingDigest: row.binding_digest,
      imageModel: row.image_model,
      videoModel: row.video_model,
      contractRevision: row.contract_revision,
      probeVersion: row.probe_version,
      ...(row.confirmation_revision !== null ? { confirmationRevision: row.confirmation_revision } : {}),
      ...(row.confirmation_expires_at !== null ? { confirmationExpiresAt: row.confirmation_expires_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      steps: { image, video },
    };
  }

  #compactVideoJobsForAdmission(rowCount: number): void {
    const rowsNeeded = rowCount - MAX_ROWS + 1;
    if (rowsNeeded <= 0) return;
    const now = this.#now();
    if (!validInteger(now, 1)) throw journalError("The media journal retention time is invalid.");
    const recoveryRetentionCutoff = now - VIDEO_JOB_RECOVERY_RETENTION_MS;
    const evicted = this.#database.query(`
      DELETE FROM video_jobs
       WHERE id IN (
         SELECT job.id
           FROM video_jobs AS job
          WHERE job.state IN (${EVICTABLE_TERMINAL_STATES.map(state => `'${state}'`).join(",")})
            AND job.artifact_id IS NULL
            AND (job.state = 'acknowledged' OR job.updated_at <= ?)
            AND NOT EXISTS (
              SELECT 1
                FROM capability_probe_steps AS step
               WHERE (
                 step.video_job_id = job.id
                 OR (
                   job.probe_operation_id IS NOT NULL
                   AND step.operation_id = job.probe_operation_id
                   AND step.step_kind = 'video'
                 )
               )
                 AND (
                   step.state IN (${PROBE_OBLIGATION_STATES.map(state => `'${state}'`).join(",")})
                   OR step.artifact_id IS NOT NULL
                 )
            )
          ORDER BY job.created_at ASC, job.id ASC
          LIMIT ?
       )
    `).run(recoveryRetentionCutoff, rowsNeeded);
    if (evicted.changes !== rowsNeeded) {
      throw journalError("The media journal row limit was exceeded.");
    }
  }

  getVideoJob(id: string): VideoJobRecord | null {
    this.#assertOpen();
    return this.#get(id);
  }

  publicVideoJob(id: string): PublicVideoJob | null {
    const job = this.getVideoJob(id);
    return job ? publicJob(job) : null;
  }

  listVideoJobs(): VideoJobRecord[] {
    this.#assertOpen();
    const rows = this.#database.query<VideoJobRow, []>(
      `SELECT * FROM video_jobs ORDER BY created_at ASC, id ASC LIMIT ${MAX_ROWS + 1}`,
    ).all();
    if (rows.length > MAX_ROWS) throw journalError("The media journal row limit was exceeded.");
    return rows.map(row => rowToJob(row) as VideoJobRecord);
  }

  listPublicVideoJobs(): PublicVideoJob[] {
    return this.listVideoJobs().map(publicJob);
  }

  reserveVideoJob(input: {
    binding: MediaCredentialBinding;
    deadlineAt: number;
    probeOperationId?: string;
    confirmationRevision?: number;
  }): VideoJobReservation {
    if (
      !validText(input.binding.slotRef, 256)
      || !validText(input.binding.identityDigest, 128)
      || !validInteger(input.deadlineAt, 1)
      || input.deadlineAt <= this.#now()
      || (input.probeOperationId !== undefined && !validText(input.probeOperationId, 64))
      || (input.confirmationRevision !== undefined && !validInteger(input.confirmationRevision, 1))
    ) throw journalError("The media job reservation is invalid.");
    return this.#transaction(() => {
      const existing = rowToJob(this.#database.query<VideoJobRow, [string]>(
        `SELECT * FROM video_jobs WHERE binding_digest = ? AND state IN (${VIDEO_ADMISSION_HOLDING_STATES.map(state => `'${state}'`).join(",")}) LIMIT 1`,
      ).get(input.binding.identityDigest));
      if (existing) return { kind: "busy", reservationId: existing.id };
      const activeProbe = this.#database.query<{ id: string }, [string, string]>(`
        SELECT p.id AS id
          FROM capability_probes p
          JOIN capability_probe_steps s ON s.operation_id = p.id
         WHERE p.binding_digest = ?
           AND p.id != ?
           AND s.state IN ('submitting','outcome_unknown')
         LIMIT 1
      `).get(input.binding.identityDigest, input.probeOperationId ?? "-");
      if (activeProbe) return { kind: "busy", reservationId: activeProbe.id };
      const count = this.#database.query<{ count: number }, []>("SELECT count(*) AS count FROM video_jobs").get()?.count;
      if (!validInteger(count)) throw journalError("The media journal row limit was exceeded.");
      this.#compactVideoJobsForAdmission(count);
      const id = crypto.randomUUID();
      const now = this.#now();
      this.#database.query(`
        INSERT INTO video_jobs (
          id, revision, state, auth_source, provider_kind, slot_ref, binding_digest,
          deadline_at, request_id, artifact_id, safe_error, probe_operation_id,
          confirmation_revision, created_at, updated_at
        ) VALUES (?,0,'queued',?,?,?,?,?,NULL,NULL,NULL,?,?,?,?)
      `).run(
        id,
        input.binding.authSource,
        input.binding.providerKind,
        input.binding.slotRef,
        input.binding.identityDigest,
        input.deadlineAt,
        input.probeOperationId ?? null,
        input.confirmationRevision ?? null,
        now,
        now,
      );
      const job = this.#get(id);
      if (!job) throw journalError("The media job reservation was not durable.");
      return { kind: "created", job };
    });
  }

  transitionVideoJob(input: TransitionVideoJobInput): VideoJobUpdate {
    if (
      !validText(input.id, 64)
      || !validInteger(input.expectedRevision)
      || input.from.length === 0
      || input.from.some(state => !validState(state) || !LEGAL_TRANSITIONS[state].includes(input.to))
      || (input.safeError !== undefined && input.safeError !== null && !validSafeFailure(input.safeError))
      || (input.artifactId !== undefined && input.artifactId !== null && !safeArtifactId(input.artifactId))
    ) throw journalError("The media job transition is invalid.");
    return this.#transaction(() => {
      const now = this.#now();
      const result = this.#database.query(`
        UPDATE video_jobs
           SET state = ?, revision = revision + 1, updated_at = ?,
               safe_error = CASE WHEN ? = 1 THEN ? ELSE safe_error END,
               artifact_id = CASE WHEN ? = 1 THEN ? ELSE artifact_id END
         WHERE id = ? AND revision = ? AND state IN (${input.from.map(() => "?").join(",")})
      `).run(
        input.to,
        now,
        input.safeError !== undefined ? 1 : 0,
        input.safeError ?? null,
        input.artifactId !== undefined ? 1 : 0,
        input.artifactId ?? null,
        input.id,
        input.expectedRevision,
        ...input.from,
      );
      const current = this.#get(input.id);
      return result.changes === 1 && current
        ? { kind: "updated", job: current }
        : { kind: "conflict", current };
    });
  }

  /** CAS-reserve the exact final video artifact id before publication begins. */
  reserveVideoArtifact(id: string, expectedRevision: number, artifactId: string): VideoJobUpdate {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:mp4|webm)$/i.test(artifactId)) {
      throw journalError("The video artifact reservation is invalid.");
    }
    return this.transitionVideoJob({
      id,
      expectedRevision,
      from: ["polling"],
      to: "downloading",
      artifactId,
      safeError: null,
    });
  }

  /** Complete only when the durable downloading row still names these exact bytes. */
  completeVideoArtifact(id: string, expectedRevision: number, artifactId: string): VideoJobUpdate {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:mp4|webm)$/i.test(artifactId)) {
      throw journalError("The completed video artifact is invalid.");
    }
    return this.#transaction(() => {
      const result = this.#database.query(`
        UPDATE video_jobs
           SET state = 'completed', revision = revision + 1, updated_at = ?, safe_error = NULL
         WHERE id = ? AND revision = ? AND state = 'downloading' AND artifact_id = ?
      `).run(this.#now(), id, expectedRevision, artifactId);
      const current = this.#get(id);
      return result.changes === 1 && current
        ? { kind: "updated", job: current }
        : { kind: "conflict", current };
    });
  }

  /** CAS-prepare deletion while retaining the private id until directory fsync succeeds. */
  markVideoArtifactPruned(id: string, expectedRevision: number, artifactId: string): VideoJobUpdate {
    if (!validText(id, 64) || !validInteger(expectedRevision) || !safeArtifactId(artifactId)) {
      throw journalError("The pruned video artifact transition is invalid.");
    }
    return this.#transaction(() => {
      const result = this.#database.query(`
        UPDATE video_jobs
           SET state = 'artifact_pruned', revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND state = 'completed' AND artifact_id = ?
      `).run(this.#now(), id, expectedRevision, artifactId);
      const current = this.#get(id);
      return result.changes === 1 && current
        ? { kind: "updated", job: current }
        : { kind: "conflict", current };
    });
  }

  /** Atomically release every ordinary completed-job pin authorizing one deletion. */
  canReleaseArtifactForPrune(artifactId: string): ArtifactPinPreflightResult {
    if (!safeArtifactId(artifactId)) throw journalError("The pruned artifact id is invalid.");
    this.#assertOpen();
    const probePin = this.#database.query<{ found: number }, [string]>(
      "SELECT 1 AS found FROM capability_probe_steps WHERE artifact_id = ? LIMIT 1",
    ).get(artifactId);
    if (probePin) return "protected";
    const jobs = this.#database.query<{ id: string; state: VideoJobState }, [string]>(`
      SELECT id, state FROM video_jobs WHERE artifact_id = ?
      ORDER BY id LIMIT ${MAX_ROWS + 1}
    `).all(artifactId);
    if (jobs.length > MAX_ROWS) throw journalError("The media retention set is too large.");
    if (jobs.length === 0) return "not_owned";
    if (jobs.some(job => job.state !== "completed" && job.state !== "artifact_pruned")) return "protected";
    this.#assertOpen();
    return "releasable";
  }

  /** Atomically prepare every completed-job pin while retaining its exact artifact id. */
  releaseArtifactForPrune(artifactId: string): ArtifactPinReleaseResult {
    if (!safeArtifactId(artifactId)) throw journalError("The pruned artifact id is invalid.");
    return this.#transaction(() => {
      const probePin = this.#database.query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM capability_probe_steps WHERE artifact_id = ? LIMIT 1",
      ).get(artifactId);
      if (probePin) return "protected";
      const jobs = this.#database.query<{ id: string; revision: number; state: VideoJobState }, [string]>(`
        SELECT id, revision, state FROM video_jobs WHERE artifact_id = ?
        ORDER BY id LIMIT ${MAX_ROWS + 1}
      `).all(artifactId);
      if (jobs.length > MAX_ROWS) throw journalError("The media retention set is too large.");
      if (jobs.length === 0) return "not_owned";
      if (jobs.some(job => job.state !== "completed" && job.state !== "artifact_pruned")) return "protected";
      const changed = this.#database.query(`
        UPDATE video_jobs
           SET state = 'artifact_pruned', revision = revision + 1, updated_at = ?
         WHERE artifact_id = ? AND state = 'completed'
      `).run(this.#now(), artifactId);
      return changed.changes === jobs.filter(job => job.state === "completed").length ? "released" : "conflict";
    });
  }

  pendingArtifactDeletionIds(): ReadonlySet<string> {
    return new Set(this.listVideoJobs()
      .filter(job => (job.state === "artifact_pruned" || job.state === "expired") && job.artifactId)
      .map(job => job.artifactId!));
  }

  /** Clear prune/expiry-prepared private ids only after the artifact directory is durably synced. */
  finalizeArtifactPrune(artifactId: string): ArtifactPinFinalizeResult {
    if (!safeArtifactId(artifactId)) throw journalError("The finalized artifact id is invalid.");
    return this.#transaction(() => {
      const rows = this.#database.query<{ id: string; state: VideoJobState }, [string]>(`
        SELECT id, state FROM video_jobs WHERE artifact_id = ?
        ORDER BY id LIMIT ${MAX_ROWS + 1}
      `).all(artifactId);
      if (rows.length > MAX_ROWS) throw journalError("The media retention set is too large.");
      if (rows.length === 0) return "not_owned";
      if (rows.some(row => row.state !== "artifact_pruned" && row.state !== "expired")) return "protected";
      const changed = this.#database.query(`
        UPDATE video_jobs
           SET artifact_id = NULL, revision = revision + 1, updated_at = ?
         WHERE artifact_id = ? AND state IN ('artifact_pruned','expired')
      `).run(this.#now(), artifactId);
      return changed.changes === rows.length ? "finalized" : "conflict";
    });
  }

  fenceVideoSubmission(id: string, expectedRevision: number): VideoJobUpdate {
    return this.transitionVideoJob({ id, expectedRevision, from: ["queued"], to: "submitting" });
  }

  commitVideoAccepted(id: string, expectedRevision: number, requestId: string): VideoJobUpdate {
    if (!safeRequestId(requestId)) throw journalError("The accepted media request identifier is invalid.");
    return this.#transaction(() => {
      const result = this.#database.query(`
        UPDATE video_jobs
           SET state = 'accepted', request_id = ?, revision = revision + 1, updated_at = ?, safe_error = NULL
         WHERE id = ? AND revision = ? AND state = 'submitting' AND request_id IS NULL
      `).run(requestId, this.#now(), id, expectedRevision);
      const current = this.#get(id);
      return result.changes === 1 && current
        ? { kind: "updated", job: current }
        : { kind: "conflict", current };
    });
  }

  acknowledgeVideoOutcomeUnknown(id: string, expectedRevision: number): VideoJobUpdate {
    return this.transitionVideoJob({
      id,
      expectedRevision,
      from: ["outcome_unknown"],
      to: "acknowledged",
      safeError: "ambiguous_submission",
    });
  }

  recoverStartup(): { cancelledBeforeDispatch: string[]; outcomeUnknown: string[]; pollable: string[] } {
    return this.#transaction(() => {
      const now = this.#now();
      const queued = this.#database.query<{ id: string }, []>(
        `SELECT id FROM video_jobs WHERE state = 'queued' ORDER BY created_at ASC LIMIT ${MAX_ROWS + 1}`,
      ).all();
      const submitting = this.#database.query<{ id: string }, []>(
        `SELECT id FROM video_jobs WHERE state = 'submitting' ORDER BY created_at ASC LIMIT ${MAX_ROWS + 1}`,
      ).all();
      if (queued.length > MAX_ROWS || submitting.length > MAX_ROWS) {
        throw journalError("The media recovery set is too large.");
      }
      // No dispatch can occur before the submitting fence. Releasing these rows is safe,
      // but startup still never initiates replacement work without a new confirmation.
      this.#database.query(`
        UPDATE video_jobs
           SET state = 'cancelled', safe_error = 'cancelled', revision = revision + 1, updated_at = ?
         WHERE state = 'queued'
      `).run(now);
      // A restart never extends the original absolute deadline. Expire every
      // poll/download-safe state before selecting background recovery work.
      this.#database.query(`
        UPDATE video_jobs
           SET state = 'expired', safe_error = 'timeout', revision = revision + 1, updated_at = ?
         WHERE deadline_at <= ?
           AND state IN ('accepted','polling','needs_auth','downloading','download_failed')
           AND NOT (state IN ('downloading','download_failed') AND artifact_id IS NOT NULL)
      `).run(now, now);
      this.#database.query(`
        UPDATE video_jobs
           SET state = 'outcome_unknown', safe_error = 'ambiguous_submission', revision = revision + 1, updated_at = ?
         WHERE state = 'submitting'
      `).run(now);
      this.#database.query(`
        UPDATE capability_probe_steps
           SET state = 'accepted', dispatch_certainty = 'accepted',
               video_job_id = (
                 SELECT v.id FROM video_jobs v
                  WHERE v.probe_operation_id = capability_probe_steps.operation_id
                    AND v.request_id IS NOT NULL
                    AND v.state IN ('accepted','polling','needs_auth','downloading','download_failed')
                  ORDER BY v.created_at DESC LIMIT 1
               ),
               revision = revision + 1, updated_at = ?
         WHERE step_kind = 'video' AND state = 'submitting'
           AND EXISTS (
             SELECT 1 FROM video_jobs v
              WHERE v.probe_operation_id = capability_probe_steps.operation_id
                AND v.request_id IS NOT NULL
                AND v.state IN ('accepted','polling','needs_auth','downloading','download_failed')
           )
      `).run(now);
      this.#database.query(`
        UPDATE capability_probe_steps
           SET state = 'outcome_unknown', dispatch_certainty = 'outcome_unknown',
               safe_error = 'ambiguous_submission', revision = revision + 1, updated_at = ?
         WHERE state = 'submitting'
      `).run(now);
      this.#database.query(`
        UPDATE capability_probes
           SET revision = revision + 1, updated_at = ?
         WHERE id IN (
           SELECT operation_id FROM capability_probe_steps
            WHERE state IN ('accepted','outcome_unknown') AND updated_at = ?
         )
      `).run(now, now);
      // GET/download work is recoverable; normalize in-flight ownership states to a safe GET restart.
      this.#database.query(`
        UPDATE video_jobs
           SET state = CASE WHEN state = 'downloading' THEN 'download_failed' ELSE 'accepted' END,
               safe_error = CASE WHEN state = 'downloading' THEN 'download_rejected' ELSE safe_error END,
               revision = revision + 1, updated_at = ?
         WHERE state IN ('polling','downloading')
      `).run(now);
      const pollable = this.#database.query<{ id: string }, []>(`
        SELECT id FROM video_jobs
         WHERE state IN ('accepted','needs_auth','download_failed')
         ORDER BY created_at ASC LIMIT ${MAX_ROWS + 1}
      `).all();
      if (pollable.length > MAX_ROWS) throw journalError("The media recovery set is too large.");
      return {
        cancelledBeforeDispatch: queued.map(row => row.id),
        outcomeUnknown: submitting.map(row => row.id),
        pollable: pollable.map(row => row.id),
      };
    });
  }

  protectedArtifactIds(): ReadonlySet<string> {
    const ids = this.listVideoJobs()
      .filter(job => job.artifactId && (job.state === "completed" || VIDEO_ADMISSION_HOLDING_STATES.includes(job.state)))
      .map(job => job.artifactId!);
    const probeRows = this.#database.query<{ artifact_id: unknown }, []>(`
      SELECT DISTINCT artifact_id FROM capability_probe_steps
       WHERE artifact_id IS NOT NULL LIMIT ${MAX_ROWS + 1}
    `).all();
    if (probeRows.length > MAX_ROWS) throw journalError("The media retention set is too large.");
    for (const row of probeRows) {
      const id = row.artifact_id;
      if (typeof id !== "string" || !safeArtifactId(id)) throw journalError("The media journal contains an invalid artifact id.");
      ids.push(id);
    }
    return new Set(ids);
  }

  /** Exact durable reservations whose local hard-link publication may be completed after a crash. */
  recoverablePublicationArtifactIds(): ReadonlySet<string> {
    return new Set(this.listVideoJobs()
      .filter(job => job.artifactId && (job.state === "downloading" || job.state === "download_failed"))
      .map(job => job.artifactId!));
  }

  getCapabilityProbe(id: string): CapabilityProbeRecord | null {
    this.#assertOpen();
    return this.#getProbe(id);
  }

  publicCapabilityProbe(id: string): PublicCapabilityProbe | null {
    const probe = this.getCapabilityProbe(id);
    return probe ? publicProbe(probe) : null;
  }

  getOrCreateCapabilityProbe(input: {
    keyDigest: string;
    bindingDigest: string;
    imageModel: string;
    videoModel: string;
    contractRevision: string;
    probeVersion: number;
  }): { kind: "created" | "existing"; probe: CapabilityProbeRecord } {
    if (
      !validText(input.keyDigest, 128)
      || !validText(input.bindingDigest, 128)
      || !validText(input.imageModel, 128)
      || !validText(input.videoModel, 128)
      || !validText(input.contractRevision, 128)
      || !validInteger(input.probeVersion, 1)
    ) throw journalError("The capability probe key is invalid.");
    return this.#transaction(() => {
      const existingRow = this.#database.query<{ id: string }, [string]>(
        "SELECT id FROM capability_probes WHERE key_digest = ?",
      ).get(input.keyDigest);
      if (existingRow) {
        const existing = this.#getProbe(existingRow.id);
        if (!existing) throw journalError("The capability probe is unavailable.");
        return { kind: "existing", probe: existing };
      }
      const count = this.#database.query<{ count: number }, []>("SELECT count(*) AS count FROM capability_probes").get()?.count ?? MAX_ROWS;
      if (count >= MAX_ROWS) throw journalError("The media journal row limit was exceeded.");
      const id = crypto.randomUUID();
      const now = this.#now();
      this.#database.query(`
        INSERT INTO capability_probes (
          id, key_digest, revision, binding_digest, image_model, video_model,
          contract_revision, probe_version, confirmation_revision, confirmation_expires_at,
          created_at, updated_at
        ) VALUES (?,?,0,?,?,?,?,?,NULL,NULL,?,?)
      `).run(
        id,
        input.keyDigest,
        input.bindingDigest,
        input.imageModel,
        input.videoModel,
        input.contractRevision,
        input.probeVersion,
        now,
        now,
      );
      for (const step of ["image", "video"] as const) {
        this.#database.query(`
          INSERT INTO capability_probe_steps (
            operation_id, step_kind, revision, state, dispatch_certainty, safe_error,
            artifact_id, artifact_expires_at, video_job_id, confirmation_revision, verified_at, inspected_at, updated_at
          ) VALUES (?,?,0,'pending','not_dispatched',NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)
        `).run(id, step, now);
      }
      const probe = this.#getProbe(id);
      if (!probe) throw journalError("The capability probe was not durable.");
      return { kind: "created", probe };
    });
  }

  authorizeCapabilityProbe(input: {
    id: string;
    expectedRevision: number;
    confirmationRevision: number;
    expiresAt: number;
  }): CapabilityProbeUpdate {
    if (
      !validText(input.id, 64)
      || !validInteger(input.expectedRevision)
      || !validInteger(input.confirmationRevision, 1)
      || !validInteger(input.expiresAt, 1)
      || input.expiresAt <= this.#now()
    ) throw journalError("The capability probe confirmation is invalid.");
    return this.#transaction(() => {
      const result = this.#database.query(`
        UPDATE capability_probes
           SET confirmation_revision = ?, confirmation_expires_at = ?,
               revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?
           AND (confirmation_revision IS NULL OR confirmation_revision < ?)
      `).run(
        input.confirmationRevision,
        input.expiresAt,
        this.#now(),
        input.id,
        input.expectedRevision,
        input.confirmationRevision,
      );
      const current = this.#getProbe(input.id);
      return result.changes === 1 && current
        ? { kind: "updated", probe: current }
        : { kind: "conflict", current };
    });
  }

  beginCapabilityProbeStep(input: {
    id: string;
    step: CapabilityProbeStepKind;
    expectedRevision: number;
    confirmationRevision: number;
  }): CapabilityProbeUpdate {
    return this.#transaction(() => {
      const current = this.#getProbe(input.id);
      if (
        !current
        || current.revision !== input.expectedRevision
        || current.confirmationRevision !== input.confirmationRevision
        || !current.confirmationExpiresAt
        || current.confirmationExpiresAt <= this.#now()
      ) return { kind: "conflict", current };
      const step = current.steps[input.step];
      const image = current.steps.image;
      if (
        !["pending", "failed", "acknowledged"].includes(step.state)
        || (step.confirmationRevision !== undefined && step.confirmationRevision >= input.confirmationRevision)
        || (input.step === "video" && !(
          (image.state === "completed" && image.dispatchCertainty === "completed")
          || (image.state === "failed" && image.dispatchCertainty === "definite_rejection")
        ))
      ) return { kind: "conflict", current };
      const now = this.#now();
      const changed = this.#database.query(`
        UPDATE capability_probe_steps
           SET state = 'submitting', dispatch_certainty = 'dispatch_started', safe_error = NULL,
               artifact_id = NULL, artifact_expires_at = NULL, video_job_id = NULL, confirmation_revision = ?,
               verified_at = NULL, inspected_at = NULL, revision = revision + 1, updated_at = ?
         WHERE operation_id = ? AND step_kind = ? AND revision = ?
      `).run(input.confirmationRevision, now, input.id, input.step, step.revision);
      if (changed.changes !== 1) return { kind: "conflict", current: this.#getProbe(input.id) };
      this.#database.query(`
        UPDATE capability_probes SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?
      `).run(now, input.id, input.expectedRevision);
      const updated = this.#getProbe(input.id);
      return updated ? { kind: "updated", probe: updated } : { kind: "conflict", current: null };
    });
  }

  settleCapabilityProbeStep(input: {
    id: string;
    step: CapabilityProbeStepKind;
    expectedStepRevision: number;
    state: Exclude<CapabilityProbeStepState, "pending" | "submitting" | "acknowledged">;
    dispatchCertainty: Exclude<CapabilityProbeDispatchCertainty, "not_dispatched" | "dispatch_started">;
    safeError?: SafeMediaFailure | null;
    artifactId?: string | null;
    artifactExpiresAt?: number | null;
    videoJobId?: string | null;
    verifiedAt?: number | null;
  }): CapabilityProbeUpdate {
    if (
      (input.artifactId !== undefined && input.artifactId !== null && !safeArtifactId(input.artifactId))
      || (input.artifactExpiresAt !== undefined && input.artifactExpiresAt !== null && !validInteger(input.artifactExpiresAt, 1))
      || (input.artifactId !== undefined && input.artifactId !== null
        && (input.verifiedAt === undefined || input.verifiedAt === null
          || input.artifactExpiresAt === undefined || input.artifactExpiresAt === null
          || input.artifactExpiresAt <= input.verifiedAt))
      || (input.videoJobId !== undefined && input.videoJobId !== null && !validText(input.videoJobId, 64))
      || (input.safeError !== undefined && input.safeError !== null && !validSafeFailure(input.safeError))
      || (input.verifiedAt !== undefined && input.verifiedAt !== null && !validInteger(input.verifiedAt, 1))
    ) throw journalError("The capability probe result is invalid.");
    return this.#transaction(() => {
      const now = this.#now();
      const result = this.#database.query(`
        UPDATE capability_probe_steps
           SET state = ?, dispatch_certainty = ?, safe_error = ?, artifact_id = ?, artifact_expires_at = ?,
               video_job_id = ?, verified_at = ?, revision = revision + 1, updated_at = ?
         WHERE operation_id = ? AND step_kind = ? AND revision = ? AND state IN ('submitting','accepted')
      `).run(
        input.state,
        input.dispatchCertainty,
        input.safeError ?? null,
        input.artifactId ?? null,
        input.artifactExpiresAt ?? null,
        input.videoJobId ?? null,
        input.verifiedAt ?? null,
        now,
        input.id,
        input.step,
        input.expectedStepRevision,
      );
      if (result.changes === 1) {
        this.#database.query("UPDATE capability_probes SET revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(now, input.id);
      }
      const current = this.#getProbe(input.id);
      return result.changes === 1 && current
        ? { kind: "updated", probe: current }
        : { kind: "conflict", current };
    });
  }

  acknowledgeCapabilityProbeStep(input: {
    id: string;
    step: CapabilityProbeStepKind;
    expectedRevision: number;
  }): CapabilityProbeUpdate {
    return this.#transaction(() => {
      const current = this.#getProbe(input.id);
      if (!current || current.revision !== input.expectedRevision) return { kind: "conflict", current };
      const step = current.steps[input.step];
      if (step.state !== "outcome_unknown") return { kind: "conflict", current };
      const now = this.#now();
      if (input.step === "video") {
        const confirmationRevision = step.confirmationRevision;
        if (confirmationRevision === undefined) return { kind: "conflict", current };
        const matches = this.#database.query<VideoJobRow, [string, number]>(`
          SELECT * FROM video_jobs
           WHERE probe_operation_id = ?
             AND confirmation_revision = ?
             AND state = 'outcome_unknown'
           ORDER BY created_at ASC, id ASC
           LIMIT 2
        `).all(input.id, confirmationRevision).map(row => rowToJob(row) as VideoJobRecord);
        if (matches.length !== 1) return { kind: "conflict", current };
        const job = matches[0]!;
        if (step.videoJobId !== undefined && step.videoJobId !== job.id) {
          return { kind: "conflict", current };
        }
        const jobChanged = this.#database.query(`
          UPDATE video_jobs SET state = 'acknowledged', revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND state = 'outcome_unknown'
             AND probe_operation_id = ? AND confirmation_revision = ?
        `).run(now, job.id, job.revision, input.id, confirmationRevision);
        if (jobChanged.changes !== 1) {
          throw journalError("The capability probe video acknowledgement changed concurrently.");
        }
      }
      const stepChanged = this.#database.query(`
        UPDATE capability_probe_steps
           SET state = 'acknowledged', revision = revision + 1, updated_at = ?
         WHERE operation_id = ? AND step_kind = ? AND revision = ? AND state = 'outcome_unknown'
      `).run(now, input.id, input.step, step.revision);
      if (stepChanged.changes !== 1) {
        throw journalError("The capability probe step acknowledgement changed concurrently.");
      }
      const probeChanged = this.#database.query(`
        UPDATE capability_probes SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?
      `).run(now, input.id, input.expectedRevision);
      if (probeChanged.changes !== 1) {
        throw journalError("The capability probe acknowledgement changed concurrently.");
      }
      const updated = this.#getProbe(input.id);
      if (!updated) throw journalError("The acknowledged capability probe is unavailable.");
      return { kind: "updated", probe: updated };
    });
  }

  recordCapabilityProbeInspection(input: {
    id: string;
    step: CapabilityProbeStepKind;
    expectedRevision: number;
  }): { kind: "updated"; probe: CapabilityProbeRecord; deletion: CapabilityArtifactDeletion } | { kind: "conflict"; current: CapabilityProbeRecord | null } {
    return this.#transaction(() => {
      const current = this.#getProbe(input.id);
      if (!current || current.revision !== input.expectedRevision) return { kind: "conflict", current };
      const step = current.steps[input.step];
      if (step.state !== "completed" || !step.artifactId) return { kind: "conflict", current };
      const now = this.#now();
      const stepChanged = this.#database.query(`
        UPDATE capability_probe_steps
           SET inspected_at = ?, revision = revision + 1, updated_at = ?
         WHERE operation_id = ? AND step_kind = ? AND revision = ? AND state = 'completed'
      `).run(now, now, input.id, input.step, step.revision);
      if (stepChanged.changes !== 1) throw journalError("The media inspection record changed concurrently.");
      const probeChanged = this.#database.query(`
        UPDATE capability_probes SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?
      `).run(now, input.id, input.expectedRevision);
      if (probeChanged.changes !== 1) throw journalError("The media inspection operation changed concurrently.");
      const updated = this.#getProbe(input.id);
      return updated
        ? {
            kind: "updated",
            probe: updated,
            deletion: {
              operationId: input.id,
              step: input.step,
              stepRevision: updated.steps[input.step].revision,
              artifactId: step.artifactId,
            },
          }
        : { kind: "conflict", current: null };
    });
  }

  /** List durable inspection/expiry deletion work without clearing its artifact id. */
  listPendingCapabilityArtifactDeletions(now = this.#now()): CapabilityArtifactDeletion[] {
    if (!validInteger(now, 1)) throw journalError("The capability artifact retention time is invalid.");
    this.#assertOpen();
    const rows = this.#database.query<{
        operation_id: string;
        step_kind: CapabilityProbeStepKind;
        revision: number;
        artifact_id: string;
      }, [number]>(`
        SELECT operation_id, step_kind, revision, artifact_id
          FROM capability_probe_steps
         WHERE artifact_id IS NOT NULL
           AND (inspected_at IS NOT NULL OR (artifact_expires_at IS NOT NULL AND artifact_expires_at <= ?))
         ORDER BY operation_id, step_kind
         LIMIT ${MAX_ROWS + 1}
      `).all(now);
    if (rows.length > MAX_ROWS) throw journalError("The media retention set is too large.");
    return rows.map(row => {
      if (!safeArtifactId(row.artifact_id)) throw journalError("The media journal contains an invalid artifact id.");
      return {
        operationId: row.operation_id,
        step: row.step_kind,
        stepRevision: row.revision,
        artifactId: row.artifact_id,
      };
    });
  }

  /** Clear durable delete work and tombstone its linked video job only after exact deletion. */
  completeCapabilityArtifactDeletion(input: CapabilityArtifactDeletion): CapabilityProbeUpdate {
    if (
      !validText(input.operationId, 64)
      || (input.step !== "image" && input.step !== "video")
      || !validInteger(input.stepRevision)
      || !safeArtifactId(input.artifactId)
    ) {
      throw journalError("The capability artifact deletion is invalid.");
    }
    return this.#transaction(() => {
      const current = this.#getProbe(input.operationId);
      if (!current) return { kind: "conflict", current: null };
      const step = current.steps[input.step];
      const deletionDue = step.inspectedAt !== undefined
        || (step.artifactExpiresAt !== undefined && step.artifactExpiresAt <= this.#now());
      if (step.revision !== input.stepRevision || step.artifactId !== input.artifactId || !deletionDue) {
        return { kind: "conflict", current };
      }
      const now = this.#now();
      if (step.videoJobId) {
        const job = this.#get(step.videoJobId);
        if (!job) return { kind: "conflict", current };
        if (job.state === "completed" && job.artifactId === input.artifactId) {
          const changed = this.#database.query(`
            UPDATE video_jobs
               SET state = 'artifact_pruned', artifact_id = NULL, revision = revision + 1, updated_at = ?
             WHERE id = ? AND revision = ? AND state = 'completed' AND artifact_id = ?
          `).run(now, job.id, job.revision, input.artifactId);
          if (changed.changes !== 1) return { kind: "conflict", current };
        } else if (job.state === "artifact_pruned" && job.artifactId === input.artifactId) {
          const finalized = this.#database.query(`
            UPDATE video_jobs
               SET artifact_id = NULL, revision = revision + 1, updated_at = ?
             WHERE id = ? AND revision = ? AND state = 'artifact_pruned' AND artifact_id = ?
          `).run(now, job.id, job.revision, input.artifactId);
          if (finalized.changes !== 1) return { kind: "conflict", current };
        } else if (job.state !== "artifact_pruned" || job.artifactId !== undefined) {
          return { kind: "conflict", current };
        }
      }
      const changed = this.#database.query(`
        UPDATE capability_probe_steps
           SET artifact_id = NULL, artifact_expires_at = NULL, revision = revision + 1, updated_at = ?
         WHERE operation_id = ? AND step_kind = ? AND revision = ? AND artifact_id = ?
      `).run(now, input.operationId, input.step, input.stepRevision, input.artifactId);
      if (changed.changes !== 1) throw journalError("The media deletion record changed concurrently.");
      const probeChanged = this.#database.query(`
        UPDATE capability_probes SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?
      `).run(now, input.operationId, current.revision);
      if (probeChanged.changes !== 1) throw journalError("The media deletion operation changed concurrently.");
      const updated = this.#getProbe(input.operationId);
      return updated ? { kind: "updated", probe: updated } : { kind: "conflict", current: null };
    });
  }

  findVideoJobForProbe(operationId: string): VideoJobRecord | null {
    this.#assertOpen();
    const row = this.#database.query<VideoJobRow, [string]>(
      "SELECT * FROM video_jobs WHERE probe_operation_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(operationId);
    return rowToJob(row);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#database.close(); } finally {
      try { this.#file.close(); } finally {
        this.#ownerLease.close();
      }
    }
  }
}

export function openVideoJobStore(options: VideoJobStoreOptions = {}): VideoJobStore {
  return new VideoJobStore(options);
}

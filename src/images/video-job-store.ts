import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual, type Hmac } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
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
import {
  assertCapabilityProbeSchema,
  CAPABILITY_PROBE_OBLIGATION_STATES,
  CapabilityProbePersistence,
  createCapabilityProbeSchema,
  type CapabilityArtifactDeletion,
  type CapabilityProbeDispatchCertainty,
  type CapabilityProbeRecord,
  type CapabilityProbeStepKind,
  type CapabilityProbeStepState,
  type CapabilityProbeUpdate,
  type PublicCapabilityProbe,
} from "./capability-probe-store";
import type { SafeMediaFailure } from "./media-safe-failure";
import {
  acquireMediaRecoveryCoordinatorForJournal,
  MEDIA_RECOVERY_FENCE_VERSION,
  mediaRecoveryCoordinatorPathForJournal,
  readDurableMediaRecoveryFenceForJournal,
  type MediaRecoveryCoordinatorLease,
} from "./media-recovery-fence";
import type { MediaCredentialBinding } from "./types";
import {
  deriveVideoOperationKey,
  deriveVideoRequestBodyDigest,
  isValidVideoClientRequestId,
  type VideoOperationAdmissionScope,
  type VideoOperationIdentity,
} from "./video-operation-key";
import {
  equalVideoOperationReplayFingerprint,
  reconcileVideoOperationReplaySecret,
  retainVideoOperationReplaySecret,
  videoOperationReplaySecretPathForJournal,
  type VideoReplaySecretLease,
} from "./video-operation-secret";

export type {
  CapabilityArtifactDeletion,
  CapabilityProbeDispatchCertainty,
  CapabilityProbeRecord,
  CapabilityProbeStepKind,
  CapabilityProbeStepRecord,
  CapabilityProbeStepState,
  CapabilityProbeUpdate,
  PublicCapabilityProbe,
} from "./capability-probe-store";
export type { SafeMediaFailure } from "./media-safe-failure";

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

export interface VideoJobRecord {
  readonly id: string;
  readonly revision: number;
  readonly state: VideoJobState;
  readonly binding: MediaCredentialBinding;
  readonly deadlineAt: number;
  /** Private digest of a client-supplied retry identity. Never expose publicly. */
  readonly operationKey?: string;
  /** Private digest of non-prompt request semantics used to reject identity reuse. */
  readonly requestSemanticsDigest?: string;
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
  | { kind: "replay"; job: VideoJobRecord }
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
  /**
   * Fixed test/deployment seam. Production callers should omit it. A custom
   * journal remains subject to the process-global default recovery fence.
   */
  path?: string;
  now?: () => number;
  /** Test-only interleaving seam immediately before the locked fence preflight. */
  recoveryFencePreflightSeam?: () => void;
  /** Test-only crash seam inside the replay-authority creation transaction. */
  replayAuthorityCrashSeam?: () => void;
  /** Test-only fault seam for required parent-directory synchronization. */
  replayAuthorityFsyncDirectory?: (directory: string) => void;
}

interface VideoJobRow {
  id: unknown;
  revision: unknown;
  state: unknown;
  auth_source: unknown;
  provider_kind: unknown;
  slot_ref: unknown;
  binding_digest: unknown;
  binding_witness: unknown;
  deadline_at: unknown;
  operation_key: unknown;
  request_semantics_digest: unknown;
  request_id: unknown;
  artifact_id: unknown;
  safe_error: unknown;
  probe_operation_id: unknown;
  confirmation_revision: unknown;
  created_at: unknown;
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

const REQUEST_ID_REQUIRED_STATES: readonly VideoJobState[] = [
  "accepted", "polling", "needs_auth", "downloading", "download_failed", "completed", "artifact_pruned", "expired",
];
const REQUEST_ID_FORBIDDEN_STATES: readonly VideoJobState[] = [
  "queued", "submitting", "outcome_unknown", "acknowledged",
];
const REQUEST_ID_OPTIONAL_STATES: readonly VideoJobState[] = ["failed", "cancelled"];
const ARTIFACT_REQUIRED_STATES: readonly VideoJobState[] = ["downloading", "completed"];
const ARTIFACT_OPTIONAL_STATES: readonly VideoJobState[] = ["download_failed", "artifact_pruned", "expired", "cancelled"];
const ARTIFACT_FORBIDDEN_STATES: readonly VideoJobState[] = [
  "queued", "submitting", "accepted", "polling", "needs_auth", "outcome_unknown", "failed", "acknowledged",
];
const NULL_SAFE_ERROR_STATES: readonly VideoJobState[] = [
  "queued", "submitting", "downloading", "completed", "artifact_pruned",
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
    binding_witness BLOB NOT NULL CHECK(typeof(binding_witness) = 'blob' AND length(binding_witness) = 32),
    deadline_at INTEGER NOT NULL CHECK(deadline_at > 0),
    operation_key TEXT CHECK(operation_key IS NULL OR length(operation_key) BETWEEN 1 AND 128),
    request_semantics_digest TEXT CHECK(request_semantics_digest IS NULL OR length(request_semantics_digest) BETWEEN 1 AND 128),
    request_id TEXT CHECK(request_id IS NULL OR length(request_id) BETWEEN 1 AND 512),
    artifact_id TEXT CHECK(artifact_id IS NULL OR length(artifact_id) BETWEEN 1 AND 256),
    safe_error TEXT CHECK(safe_error IS NULL OR safe_error IN (${SAFE_FAILURES.map(value => `'${value}'`).join(",")})),
    probe_operation_id TEXT CHECK(probe_operation_id IS NULL OR length(probe_operation_id) BETWEEN 1 AND 64),
    confirmation_revision INTEGER CHECK(confirmation_revision IS NULL OR confirmation_revision > 0),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0),
    CHECK(deadline_at > created_at),
    CHECK((operation_key IS NULL) = (request_semantics_digest IS NULL)),
    CHECK((probe_operation_id IS NULL) = (confirmation_revision IS NULL))
  ) STRICT`;

const CREATE_ACTIVE_BINDING_INDEX = `
  CREATE UNIQUE INDEX video_jobs_one_active_binding
  ON video_jobs(binding_digest)
  WHERE state IN (${VIDEO_ADMISSION_HOLDING_STATES.map(state => `'${state}'`).join(",")})`;

const CREATE_VIDEO_REPLAY_AUTHORITY_WITNESS = `
  CREATE TABLE IF NOT EXISTS video_replay_authority_witness (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
    secret_fingerprint BLOB NOT NULL CHECK(typeof(secret_fingerprint) = 'blob' AND length(secret_fingerprint) = 32)
  ) STRICT`;

const CREATE_VIDEO_JOB_SET_WITNESS = `
  CREATE TABLE video_job_set_witness (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
    row_count INTEGER NOT NULL CHECK(row_count >= 0),
    set_fingerprint BLOB NOT NULL CHECK(typeof(set_fingerprint) = 'blob' AND length(set_fingerprint) = 32)
  ) STRICT`;

function journalError(message: string): Error {
  const error = new Error(message);
  error.name = "MediaJournalError";
  return error;
}

function assertMediaRecoveryFenceAllowsOpen(journalPath: string): void {
  try {
    const recoveryFence = readDurableMediaRecoveryFenceForJournal(journalPath);
    if (recoveryFence && (
      recoveryFence.version !== MEDIA_RECOVERY_FENCE_VERSION
      || !recoveryFence.acknowledged
    )) {
      throw journalError("The media journal is blocked by pending recovery acknowledgement.");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "MediaJournalError") throw error;
    throw journalError("The media recovery fence is unavailable.");
  }
}

function closeMediaRecoveryCoordinators(
  coordinators: readonly MediaRecoveryCoordinatorLease[],
): void {
  let failed = false;
  let firstError: unknown;
  for (let index = coordinators.length - 1; index >= 0; index -= 1) {
    try {
      coordinators[index]!.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  if (failed) throw firstError;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message)
    || message === "media recovery acknowledgement is busy";
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

const VIDEO_JOB_INTEGRITY_WITNESS_DOMAIN = "codexcommander/video-job-integrity/v1";
const VIDEO_JOB_SET_WITNESS_DOMAIN = "codexcommander/video-job-set-integrity/v1";

function updateWitnessString(hmac: Hmac, value: string): void {
  hmac.update("S");
  hmac.update(String(Buffer.byteLength(value)));
  hmac.update(":");
  hmac.update(value);
}

function updateWitnessInteger(hmac: Hmac, value: number): void {
  hmac.update("I");
  hmac.update(String(value));
  hmac.update(";");
}

function updateWitnessOptionalString(hmac: Hmac, value: string | undefined): void {
  if (value === undefined) hmac.update("N");
  else updateWitnessString(hmac, value);
}

function updateWitnessOptionalInteger(hmac: Hmac, value: number | undefined): void {
  if (value === undefined) hmac.update("N");
  else updateWitnessInteger(hmac, value);
}

function deriveVideoJobIntegrityWitness(secret: Uint8Array, job: VideoJobRecord): Uint8Array {
  const hmac = createHmac("sha256", secret);
  hmac.update(VIDEO_JOB_INTEGRITY_WITNESS_DOMAIN);
  hmac.update("\0");
  updateWitnessString(hmac, job.id);
  updateWitnessInteger(hmac, job.revision);
  updateWitnessString(hmac, job.state);
  updateWitnessString(hmac, job.binding.authSource);
  updateWitnessString(hmac, job.binding.providerKind);
  updateWitnessString(hmac, job.binding.slotRef);
  updateWitnessString(hmac, job.binding.identityDigest);
  updateWitnessInteger(hmac, job.deadlineAt);
  updateWitnessOptionalString(hmac, job.operationKey);
  updateWitnessOptionalString(hmac, job.requestSemanticsDigest);
  updateWitnessOptionalString(hmac, job.requestId);
  updateWitnessOptionalString(hmac, job.artifactId);
  updateWitnessOptionalString(hmac, job.safeError);
  updateWitnessOptionalString(hmac, job.probeOperationId);
  updateWitnessOptionalInteger(hmac, job.confirmationRevision);
  updateWitnessInteger(hmac, job.createdAt);
  updateWitnessInteger(hmac, job.updatedAt);
  return new Uint8Array(hmac.digest());
}

function equalBindingWitness(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function verifiedVideoJobSetState(
  database: Database,
  secret: Uint8Array,
): { rowCount: number; fingerprint: Uint8Array } {
  const rows = database.query<VideoJobRow, []>(`
    SELECT * FROM video_jobs ORDER BY id ASC LIMIT ${MAX_ROWS + 1}
  `).all();
  if (rows.length > MAX_ROWS) throw journalError("The media journal row limit was exceeded.");
  const hmac = createHmac("sha256", secret);
  hmac.update(VIDEO_JOB_SET_WITNESS_DOMAIN);
  hmac.update("\0");
  updateWitnessInteger(hmac, rows.length);
  for (const row of rows) {
    const job = rowToJob(row);
    if (!job || !(row.binding_witness instanceof Uint8Array)) {
      throw journalError("The media journal contains a malformed job.");
    }
    const expectedRowWitness = deriveVideoJobIntegrityWitness(secret, job);
    if (!equalBindingWitness(row.binding_witness, expectedRowWitness)) {
      throw journalError("The media journal contains a malformed integrity witness.");
    }
    updateWitnessString(hmac, job.id);
    hmac.update("B32:");
    hmac.update(row.binding_witness);
  }
  return { rowCount: rows.length, fingerprint: new Uint8Array(hmac.digest()) };
}

function readVideoJobSetWitness(database: Database): { rowCount: number; fingerprint: Uint8Array } {
  const rows = database.query<{ singleton: unknown; row_count: unknown; set_fingerprint: unknown }, []>(
    "SELECT singleton, row_count, set_fingerprint FROM video_job_set_witness LIMIT 2",
  ).all();
  const row = rows[0];
  if (
    rows.length !== 1
    || row?.singleton !== 1
    || !validInteger(row.row_count)
    || !(row.set_fingerprint instanceof Uint8Array)
    || row.set_fingerprint.byteLength !== 32
  ) throw journalError("The media job-set witness is malformed.");
  return { rowCount: row.row_count, fingerprint: new Uint8Array(row.set_fingerprint) };
}

function assertVideoJobSetWitness(database: Database, secret: Uint8Array): void {
  const expected = verifiedVideoJobSetState(database, secret);
  const observed = readVideoJobSetWitness(database);
  if (
    observed.rowCount !== expected.rowCount
    || !equalBindingWitness(observed.fingerprint, expected.fingerprint)
  ) throw journalError("The media job-set witness does not match retained jobs.");
}

function sealVideoJobSetWitness(database: Database, secret: Uint8Array): void {
  const expected = verifiedVideoJobSetState(database, secret);
  const updated = database.query(`
    UPDATE video_job_set_witness SET row_count = ?, set_fingerprint = ? WHERE singleton = 1
  `).run(expected.rowCount, expected.fingerprint);
  if (updated.changes !== 1) throw journalError("The media job-set witness could not be sealed.");
}

function validVideoJobStateFields(
  state: VideoJobState,
  revision: number,
  requestId: string | null,
  artifactId: string | null,
  safeError: SafeMediaFailure | null,
): boolean {
  const revisionValid = state === "queued"
    ? revision === 0
    : state === "submitting"
      ? revision === 1
      : state === "cancelled"
        ? revision >= 1
        : revision >= 2;
  const requestValid = REQUEST_ID_REQUIRED_STATES.includes(state)
    ? requestId !== null
    : REQUEST_ID_FORBIDDEN_STATES.includes(state)
      ? requestId === null
      : REQUEST_ID_OPTIONAL_STATES.includes(state);
  const artifactValid = ARTIFACT_REQUIRED_STATES.includes(state)
    ? artifactId !== null
    : ARTIFACT_FORBIDDEN_STATES.includes(state)
      ? artifactId === null
      : ARTIFACT_OPTIONAL_STATES.includes(state);
  let safeErrorValid: boolean;
  if (NULL_SAFE_ERROR_STATES.includes(state)) safeErrorValid = safeError === null;
  else if (state === "needs_auth") safeErrorValid = safeError === "needs_auth";
  else if (state === "outcome_unknown" || state === "acknowledged") safeErrorValid = safeError === "ambiguous_submission";
  else if (state === "download_failed") safeErrorValid = safeError === "download_rejected" || safeError === "cancelled";
  else if (state === "expired") safeErrorValid = safeError === "timeout" || safeError === "job_expired";
  else if (state === "failed") {
    safeErrorValid = safeError === "needs_auth"
      || safeError === "entitlement_denied"
      || safeError === "rate_limited"
      || safeError === "policy_rejected"
      || safeError === "upstream_failed"
      || safeError === "timeout"
      || safeError === "job_failed";
  }
  else if (state === "accepted") safeErrorValid = safeError === null || safeError === "upstream_failed" || safeError === "cancelled";
  else if (state === "polling") {
    safeErrorValid = safeError === null
      || safeError === "upstream_failed"
      || safeError === "cancelled"
      || safeError === "needs_auth"
      || safeError === "download_rejected";
  } else safeErrorValid = state === "cancelled" && (safeError === null || safeError === "cancelled");
  return revisionValid && requestValid && artifactValid && safeErrorValid;
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

function normalizedSchemaSql(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function assertCanonicalVideoJobSchema(database: Database): void {
  const table = database.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'video_jobs'",
  ).get();
  if (!table?.sql || normalizedSchemaSql(table.sql) !== normalizedSchemaSql(CREATE_VIDEO_JOBS)) {
    throw journalError("The media journal schema is malformed.");
  }
  const explicitIndexes = database.query<{ name: string; sql: string | null }, []>(`
    SELECT name, sql FROM sqlite_schema
     WHERE type = 'index' AND tbl_name = 'video_jobs' AND sql IS NOT NULL
     ORDER BY name
  `).all();
  if (
    explicitIndexes.length !== 1
    || explicitIndexes[0]?.name !== "video_jobs_one_active_binding"
    || !explicitIndexes[0].sql
    || normalizedSchemaSql(explicitIndexes[0].sql) !== normalizedSchemaSql(CREATE_ACTIVE_BINDING_INDEX)
  ) throw journalError("The media journal binding index is malformed.");
}

function exactColumnSet(columns: readonly { name: string }[], expected: ReadonlySet<string>): boolean {
  const remaining = new Set(expected);
  return columns.length === remaining.size
    && columns.every(column => remaining.delete(column.name))
    && remaining.size === 0;
}

function rebuildEmptyLegacyVideoJobTable(database: Database): void {
  const count = database.query<{ count: number }, []>("SELECT count(*) AS count FROM video_jobs").get()?.count;
  if (count !== 0) throw journalError("The media journal schema is malformed.");
  database.exec("DROP INDEX IF EXISTS video_jobs_one_active_binding");
  database.exec("DROP TABLE video_jobs");
  database.exec(CREATE_VIDEO_JOBS);
  database.exec(CREATE_ACTIVE_BINDING_INDEX);
}

function initializeVideoReplayAuthority(
  database: Database,
  journalPath: string,
  options: VideoJobStoreOptions,
): { secret: Uint8Array; witnessChanged: boolean } {
  database.exec(CREATE_VIDEO_REPLAY_AUTHORITY_WITNESS);
  const schema = database.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'video_replay_authority_witness'",
  ).get();
  const columns = database.query<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }, []>("PRAGMA table_info(video_replay_authority_witness)").all();
  if (!schema?.sql || !/\)\s*STRICT\s*$/i.test(schema.sql)
    || columns.length !== 2
    || columns[0]?.name !== "singleton"
    || columns[0]?.type.toUpperCase() !== "INTEGER"
    || columns[0]?.notnull !== 1
    || columns[0]?.pk !== 1
    || columns[1]?.name !== "secret_fingerprint"
    || columns[1]?.type.toUpperCase() !== "BLOB"
    || columns[1]?.notnull !== 1
    || columns[1]?.pk !== 0) {
    throw journalError("The media replay authority schema is malformed.");
  }

  const rows = database.query<{ singleton: unknown; secret_fingerprint: unknown }, []>(
    "SELECT singleton, secret_fingerprint FROM video_replay_authority_witness LIMIT 2",
  ).all();
  const row = rows[0];
  if (rows.length > 1
    || (row !== undefined && (
      row.singleton !== 1
      || !(row.secret_fingerprint instanceof Uint8Array)
      || row.secret_fingerprint.byteLength !== 32
    ))) {
    throw journalError("The media replay authority witness is malformed.");
  }
  // The same private authority authenticates both retry metadata and immutable
  // binding witnesses. Losing it while any retained row remains must never mint
  // a replacement authority that would make a corrupted binding look valid.
  const hasSetWitnessTable = database.query<{ present: number }, []>(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'video_job_set_witness'",
  ).get() !== null;
  const retainedSetCount = hasSetWitnessTable
    ? database.query<{ row_count: unknown }, []>(
      "SELECT row_count FROM video_job_set_witness WHERE singleton = 1",
    ).get()?.row_count
    : undefined;
  const hasRetryRecords = database.query<{ present: number }, []>(
    "SELECT 1 AS present FROM video_jobs LIMIT 1",
  ).get() !== null || (validInteger(retainedSetCount) && retainedSetCount > 0);
  const reconciled = reconcileVideoOperationReplaySecret({
    journalPath,
    ...(row?.secret_fingerprint instanceof Uint8Array
      ? { witnessFingerprint: new Uint8Array(row.secret_fingerprint) }
      : {}),
    hasRetryRecords,
    ...(options.replayAuthorityFsyncDirectory
      ? { fsyncDirectory: options.replayAuthorityFsyncDirectory }
      : {}),
  });
  if (reconciled.witnessChanged) {
    // The file and (on POSIX) parent directory are already synchronized. A crash
    // here leaves a valid unwitnessed file that the next startup can safely adopt.
    options.replayAuthorityCrashSeam?.();
    database.query(`
      INSERT INTO video_replay_authority_witness(singleton, secret_fingerprint)
      VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET secret_fingerprint = excluded.secret_fingerprint
    `).run(reconciled.fingerprint);
  }
  const witnessed = database.query<{ singleton: unknown; secret_fingerprint: unknown }, []>(
    "SELECT singleton, secret_fingerprint FROM video_replay_authority_witness LIMIT 2",
  ).all();
  const finalWitness = witnessed[0];
  if (witnessed.length !== 1
    || finalWitness?.singleton !== 1
    || !(finalWitness.secret_fingerprint instanceof Uint8Array)
    || !equalVideoOperationReplayFingerprint(finalWitness.secret_fingerprint, reconciled.fingerprint)) {
    throw journalError("The media replay authority witness was not durable.");
  }
  return { secret: reconciled.secret, witnessChanged: reconciled.witnessChanged };
}

function initializeVideoJobSetWitness(
  database: Database,
  replaySecret: Uint8Array,
  allowCreate: boolean,
  allowEmptyReset: boolean,
): void {
  let schema = database.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'video_job_set_witness'",
  ).get();
  if (!schema) {
    if (!allowCreate) throw journalError("The media job-set witness schema is missing.");
    database.exec(CREATE_VIDEO_JOB_SET_WITNESS);
    schema = database.query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'video_job_set_witness'",
    ).get();
  }
  const columns = database.query<{ name: string; type: string; notnull: number; pk: number }, []>(
    "PRAGMA table_info(video_job_set_witness)",
  ).all();
  if (
    !schema?.sql
    || normalizedSchemaSql(schema.sql) !== normalizedSchemaSql(CREATE_VIDEO_JOB_SET_WITNESS)
    || columns.length !== 3
    || columns[0]?.name !== "singleton" || columns[0].type.toUpperCase() !== "INTEGER"
    || columns[0].notnull !== 1 || columns[0].pk !== 1
    || columns[1]?.name !== "row_count" || columns[1].type.toUpperCase() !== "INTEGER"
    || columns[1].notnull !== 1 || columns[1].pk !== 0
    || columns[2]?.name !== "set_fingerprint" || columns[2].type.toUpperCase() !== "BLOB"
    || columns[2].notnull !== 1 || columns[2].pk !== 0
  ) throw journalError("The media job-set witness schema is malformed.");
  const expected = verifiedVideoJobSetState(database, replaySecret);
  const witnessRows = database.query<{ present: number }, []>(
    "SELECT 1 AS present FROM video_job_set_witness LIMIT 2",
  ).all();
  if (witnessRows.length === 0) {
    if (!allowCreate) throw journalError("The media job-set witness is missing.");
    database.query(`
      INSERT INTO video_job_set_witness(singleton, row_count, set_fingerprint) VALUES (1, ?, ?)
    `).run(expected.rowCount, expected.fingerprint);
    return;
  }
  try {
    assertVideoJobSetWitness(database, replaySecret);
  } catch (error) {
    if (!allowEmptyReset || expected.rowCount !== 0) throw error;
    database.query(`
      UPDATE video_job_set_witness SET row_count = 0, set_fingerprint = ? WHERE singleton = 1
    `).run(expected.fingerprint);
  }
}

function initializeSchema(
  database: Database,
  journalPath: string,
  options: VideoJobStoreOptions,
): Uint8Array {
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
  const freshDatabase = version === 0;
  if (version === 0) {
    if (!databaseSchemaIsEmpty(database)) throw journalError("The media journal schema is unsupported.");
    database.exec(CREATE_VIDEO_JOBS);
    database.exec(CREATE_ACTIVE_BINDING_INDEX);
    createCapabilityProbeSchema(database, SAFE_FAILURES);
    database.exec(`PRAGMA user_version = ${MEDIA_JOURNAL_SCHEMA_VERSION}`);
  } else if (version !== MEDIA_JOURNAL_SCHEMA_VERSION) {
    throw journalError("The media journal schema version is unsupported.");
  }
  const legacyRequired = new Set([
    "id", "revision", "state", "auth_source", "provider_kind", "slot_ref", "binding_digest",
    "deadline_at", "request_id", "artifact_id", "safe_error", "probe_operation_id",
    "confirmation_revision", "created_at", "updated_at",
  ]);
  const preWitnessRequired = new Set([
    "id", "revision", "state", "auth_source", "provider_kind", "slot_ref", "binding_digest",
    "deadline_at", "operation_key", "request_semantics_digest", "request_id", "artifact_id", "safe_error", "probe_operation_id",
    "confirmation_revision", "created_at", "updated_at",
  ]);
  const canonicalRequired = new Set([
    "id", "revision", "state", "auth_source", "provider_kind", "slot_ref", "binding_digest", "binding_witness",
    "deadline_at", "operation_key", "request_semantics_digest", "request_id", "artifact_id", "safe_error", "probe_operation_id",
    "confirmation_revision", "created_at", "updated_at",
  ]);
  let columns = database.query<{ name: string }, []>("PRAGMA table_info(video_jobs)").all();
  if (!exactColumnSet(columns, canonicalRequired)) {
    if (exactColumnSet(columns, legacyRequired) || exactColumnSet(columns, preWitnessRequired)) {
      // A binding witness cannot be safely invented for retained work. Only an
      // empty legacy table can be replaced with the canonical integrity schema.
      rebuildEmptyLegacyVideoJobTable(database);
      columns = database.query<{ name: string }, []>("PRAGMA table_info(video_jobs)").all();
    } else {
      throw journalError("The media journal schema is malformed.");
    }
  }
  if (!exactColumnSet(columns, canonicalRequired)) throw journalError("The media journal schema is malformed.");
  assertCanonicalVideoJobSchema(database);
  const malformedRetryPair = database.query<{ present: number }, []>(`
    SELECT 1 AS present FROM video_jobs
     WHERE (operation_key IS NULL) != (request_semantics_digest IS NULL)
     LIMIT 1
  `).get();
  if (malformedRetryPair) throw journalError("The media journal contains malformed retry identity state.");
  const retainedJobs = database.query<VideoJobRow, []>(`
    SELECT * FROM video_jobs
     ORDER BY created_at ASC, id ASC
     LIMIT ${MAX_ROWS + 1}
  `).all();
  if (retainedJobs.length > MAX_ROWS) throw journalError("The media journal row limit was exceeded.");
  for (const row of retainedJobs) rowToJob(row);
  assertCapabilityProbeSchema(database, journalError);
  const replayAuthority = initializeVideoReplayAuthority(database, journalPath, options);
  const replaySecret = replayAuthority.secret;
  for (const row of retainedJobs) {
    const job = rowToJob(row);
    if (!job) throw journalError("The media journal contains a malformed job.");
    const expected = deriveVideoJobIntegrityWitness(replaySecret, job);
    if (!equalBindingWitness(row.binding_witness as Uint8Array, expected)) {
      throw journalError("The media journal contains a malformed binding witness.");
    }
  }
  initializeVideoJobSetWitness(
    database,
    replaySecret,
    freshDatabase,
    replayAuthority.witnessChanged && retainedJobs.length === 0,
  );
  return replaySecret;
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
    || !(row.binding_witness instanceof Uint8Array)
    || row.binding_witness.byteLength !== 32
    || !validInteger(row.deadline_at, 1)
    || (row.operation_key !== null && !validText(row.operation_key, 128))
    || (row.request_semantics_digest !== null && !validText(row.request_semantics_digest, 128))
    || ((row.operation_key === null) !== (row.request_semantics_digest === null))
    || (row.request_id !== null && !validText(row.request_id, 512))
    || (row.artifact_id !== null && (!validText(row.artifact_id, 256) || !safeArtifactId(row.artifact_id)))
    || (row.safe_error !== null && !validSafeFailure(row.safe_error))
    || (row.probe_operation_id !== null && !validText(row.probe_operation_id, 64))
    || (row.confirmation_revision !== null && !validInteger(row.confirmation_revision, 1))
    || !validInteger(row.created_at, 1)
    || !validInteger(row.updated_at, 1)
  ) throw journalError("The media journal contains a malformed job.");
  if (
    row.deadline_at <= row.created_at
    || row.updated_at < row.created_at
    || ((row.probe_operation_id === null) !== (row.confirmation_revision === null))
    || (row.auth_source === "subscription_oauth" && row.provider_kind !== "canonical")
    || !validVideoJobStateFields(row.state, row.revision, row.request_id, row.artifact_id, row.safe_error)
  ) throw journalError("The media journal contains malformed job state.");
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
    ...(row.operation_key !== null ? { operationKey: row.operation_key } : {}),
    ...(row.request_semantics_digest !== null ? { requestSemanticsDigest: row.request_semantics_digest } : {}),
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

function safeArtifactId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value) && !value.includes("..");
}

function safeRequestId(value: string): boolean {
  return validText(value, 512);
}

export function defaultMediaJournalPath(): string {
  return join(getConfigDir(), MEDIA_STATE_DIRECTORY, MEDIA_JOURNAL_FILENAME);
}

export function mediaJournalRecoveryOwnerPathForJournal(journalPath: string): string {
  return `${journalPath}${RECOVERY_OWNER_SUFFIX}`;
}

function canonicalMediaJournalPath(selected: string): string {
  const resolvedPath = resolve(selected);
  if (!isAbsolute(resolvedPath)) throw journalError("The media journal path must be absolute.");
  const requestedDirectory = dirname(resolvedPath);
  assertNotRealHomeUnderTest(requestedDirectory);
  assertPrivateDirectory(requestedDirectory);
  return join(realpathSync.native(requestedDirectory), basename(resolvedPath));
}

function openExistingStableOwnerFile(path: string): StableLockFile {
  let fd: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDWR | noFollow);
    const stats = fstatSync(fd);
    assertPrivateFile(stats);
    let closed = false;
    const retainedFd = fd;
    fd = undefined;
    const file: StableLockFile = {
      fd: retainedFd,
      dev: stats.dev,
      ino: stats.ino,
      close() {
        if (closed) return;
        closed = true;
        closeSync(retainedFd);
      },
    };
    assertStableLockFile(path, file);
    return file;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* mapped by the caller */ }
    }
    throw error;
  }
}

/**
 * Acquire the same process-lifetime lease used by the runtime before inspecting
 * or moving journal bytes. The SQLite transaction is OS-backed and survives no
 * process crash; the stable descriptor prevents lock-path replacement while it
 * is held.
 */
export function acquireMediaJournalOwnerLease(
  selected = defaultMediaJournalPath(),
  options: { requireExisting?: boolean } = {},
): MediaJournalOwnerLease {
  const journalPath = canonicalMediaJournalPath(selected);
  const ownerPath = mediaJournalRecoveryOwnerPathForJournal(journalPath);
  if (claimedJournalPaths.has(journalPath)) throw journalError("The media journal is busy.");
  claimedJournalPaths.add(journalPath);
  let ownerFile: StableLockFile | undefined;
  let ownerDatabase: Database | undefined;
  let closed = false;
  try {
    const ownerExisted = existsSync(ownerPath);
    if (options.requireExisting && !ownerExisted) throw journalError("The media journal is busy.");
    if (ownerExisted) assertPrivateFile(lstatSync(ownerPath));
    assertExistingJournalSidecars(ownerPath);
    ownerFile = options.requireExisting
      ? openExistingStableOwnerFile(ownerPath)
      : openStableLockFile(ownerPath);
    if (!ownerExisted || process.platform === "win32") hardenJournalFile(ownerPath);
    assertStableLockFile(ownerPath, ownerFile);
    ownerDatabase = new Database(ownerPath, { create: options.requireExisting !== true, strict: true });
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
  readonly #capabilityProbes: CapabilityProbePersistence;
  readonly #file: StableLockFile;
  readonly #ownerLease: MediaJournalOwnerLease;
  readonly #recoveryCoordinators: readonly MediaRecoveryCoordinatorLease[];
  readonly #path: string;
  readonly #identity: string;
  readonly #now: () => number;
  readonly #replaySecret: Uint8Array;
  readonly #replaySecretLease: VideoReplaySecretLease;
  #closed = false;

  constructor(options: VideoJobStoreOptions = {}) {
    const selected = options.path ?? defaultMediaJournalPath();
    this.#path = canonicalMediaJournalPath(selected);
    const defaultPath = options.path === undefined
      ? this.#path
      : canonicalMediaJournalPath(defaultMediaJournalPath());
    const recoveryJournalPaths = mediaRecoveryCoordinatorPathForJournal(defaultPath)
      === mediaRecoveryCoordinatorPathForJournal(this.#path)
      ? [defaultPath]
      : [defaultPath, this.#path];
    const directory = dirname(this.#path);
    const ownerPath = mediaJournalRecoveryOwnerPathForJournal(this.#path);
    const replaySecretPath = videoOperationReplaySecretPathForJournal(this.#path);
    const productionPath = options.path === undefined;
    let recoveryCoordinators: MediaRecoveryCoordinatorLease[] = [];
    let file: StableLockFile | undefined;
    let database: Database | undefined;
    let ownerLease: MediaJournalOwnerLease | undefined;
    let replaySecret: Uint8Array | undefined;
    let replaySecretLease: VideoReplaySecretLease | undefined;
    try {
      options.recoveryFencePreflightSeam?.();
      // Recovery is process-global even when a fixed custom journal path is
      // used. Hold the default-domain coordinator for this store's complete
      // lifetime, then the custom domain (when distinct), so quarantine cannot
      // establish a fence between an admission check and paid work.
      for (const journalPath of recoveryJournalPaths) {
        const coordinator = acquireMediaRecoveryCoordinatorForJournal(journalPath);
        recoveryCoordinators.push(coordinator);
        coordinator.assertOwned();
        assertMediaRecoveryFenceAllowsOpen(journalPath);
      }
      for (const coordinator of recoveryCoordinators) coordinator.assertOwned();
      for (const journalPath of recoveryJournalPaths) assertMediaRecoveryFenceAllowsOpen(journalPath);
      const existedBeforeOpen = existsSync(this.#path);
      const companionExistedBeforeOpen = existsSync(replaySecretPath) || existsSync(ownerPath);
      // A surviving replay authority or owner file proves that a missing journal
      // is partial state loss, not a fresh installation. Recreating it could erase
      // the only tombstone preventing a duplicate paid submission.
      if (!existedBeforeOpen && companionExistedBeforeOpen) {
        throw journalError("The media journal is missing while replay authority state remains.");
      }
      if (productionPath) {
        const root = getConfigDir();
        const recoveryCoordinatorPath = mediaRecoveryCoordinatorPathForJournal(this.#path);
        recordOwnedConfigPath(root, directory);
        for (const suffix of ["", "-journal", "-wal", "-shm"]) recordOwnedConfigPath(root, `${this.#path}${suffix}`);
        for (const suffix of ["", "-journal", "-wal", "-shm"]) recordOwnedConfigPath(root, `${ownerPath}${suffix}`);
        for (const suffix of ["", "-journal", "-wal", "-shm"]) recordOwnedConfigPath(root, `${recoveryCoordinatorPath}${suffix}`);
        recordOwnedConfigPath(root, replaySecretPath);
      }
      ownerLease = acquireMediaJournalOwnerLease(this.#path);
      for (const coordinator of recoveryCoordinators) coordinator.assertOwned();
      for (const journalPath of recoveryJournalPaths) assertMediaRecoveryFenceAllowsOpen(journalPath);

      const existed = existsSync(this.#path);
      if (!existed && (existedBeforeOpen || companionExistedBeforeOpen || existsSync(replaySecretPath))) {
        throw journalError("The media journal is missing while replay authority state remains.");
      }
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
        replaySecret = initializeSchema(database, this.#path, options);
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
      replaySecretLease = retainVideoOperationReplaySecret(this.#path, replaySecret);
      this.#database = database;
      this.#file = file;
      this.#ownerLease = ownerLease;
      this.#recoveryCoordinators = recoveryCoordinators;
      recoveryCoordinators = [];
      this.#now = options.now ?? Date.now;
      this.#replaySecret = replaySecret;
      this.#replaySecretLease = replaySecretLease;
      this.#capabilityProbes = new CapabilityProbePersistence({
        database,
        now: this.#now,
        maxRows: MAX_ROWS,
        safeFailures: SAFE_FAILURES,
        error: journalError,
        assertOpen: () => this.#assertOpen(),
        transaction: operation => this.#transaction(operation),
        decodeVideoJobRow: row => this.#verifiedVideoJobRow(row as unknown as VideoJobRow),
        sealVideoJob: id => this.#sealVideoJob(id),
      });
    } catch (error) {
      try { replaySecretLease?.close(); } catch { /* mapped below */ }
      try { database?.close(); } catch { /* mapped below */ }
      try { file?.close(); } catch { /* mapped below */ }
      try { ownerLease?.close(); } catch { /* mapped below */ }
      try { closeMediaRecoveryCoordinators(recoveryCoordinators); } catch { /* mapped below */ }
      if (error instanceof Error && error.name === "MediaJournalError") throw error;
      throw journalError(isBusy(error) ? "The media journal is busy." : "The media journal is unavailable.");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw journalError("The media journal is closed.");
    for (const coordinator of this.#recoveryCoordinators) coordinator.assertOwned();
    this.#replaySecretLease.assertAvailable();
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
      assertVideoJobSetWitness(this.#database, this.#replaySecret);
      const value = operation();
      sealVideoJobSetWitness(this.#database, this.#replaySecret);
      this.#assertOpen();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* close still releases */ }
      throw error;
    }
  }

  deriveVideoOperationIdentity(
    clientRequestId: string | null | undefined,
    admission: VideoOperationAdmissionScope,
    body: unknown,
  ): VideoOperationIdentity | undefined {
    if (!isValidVideoClientRequestId(clientRequestId)) return undefined;
    this.#assertOpen();
    const context = { digestSecret: this.#replaySecret, admission };
    const operationKey = deriveVideoOperationKey(clientRequestId, context);
    if (!operationKey) return undefined;
    return {
      operationKey,
      requestSemanticsDigest: deriveVideoRequestBodyDigest(body, context),
    };
  }

  #verifiedVideoJobRow(row: VideoJobRow | null): VideoJobRecord | null {
    const job = rowToJob(row);
    if (!job || !row) return job;
    const expected = deriveVideoJobIntegrityWitness(this.#replaySecret, job);
    if (!equalBindingWitness(row.binding_witness as Uint8Array, expected)) {
      throw journalError("The media journal contains a malformed integrity witness.");
    }
    return job;
  }

  #get(id: string): VideoJobRecord | null {
    if (!validText(id, 64)) return null;
    return this.#verifiedVideoJobRow(
      this.#database.query<VideoJobRow, [string]>("SELECT * FROM video_jobs WHERE id = ?").get(id),
    );
  }

  /** Seal one already-mutated row inside the caller's transaction before it can commit. */
  #sealVideoJob(id: string): VideoJobRecord | null {
    if (!validText(id, 64)) return null;
    const row = this.#database.query<VideoJobRow, [string]>("SELECT * FROM video_jobs WHERE id = ?").get(id);
    const job = rowToJob(row);
    if (!job) return null;
    const witness = deriveVideoJobIntegrityWitness(this.#replaySecret, job);
    const sealed = this.#database.query(`
      UPDATE video_jobs SET binding_witness = ? WHERE id = ? AND revision = ?
    `).run(witness, id, job.revision);
    if (sealed.changes !== 1) throw journalError("The media job integrity witness changed concurrently.");
    return job;
  }

  #verifyAllVideoJobs(): void {
    const rows = this.#database.query<VideoJobRow, []>(
      `SELECT * FROM video_jobs ORDER BY created_at ASC, id ASC LIMIT ${MAX_ROWS + 1}`,
    ).all();
    if (rows.length > MAX_ROWS) throw journalError("The media journal row limit was exceeded.");
    for (const row of rows) this.#verifiedVideoJobRow(row);
  }

  #sealAllVideoJobs(): void {
    const rows = this.#database.query<{ id: string }, []>(
      `SELECT id FROM video_jobs ORDER BY created_at ASC, id ASC LIMIT ${MAX_ROWS + 1}`,
    ).all();
    if (rows.length > MAX_ROWS) throw journalError("The media journal row limit was exceeded.");
    for (const row of rows) {
      if (!this.#sealVideoJob(row.id)) throw journalError("The media job integrity witness is unavailable.");
    }
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
            AND ((job.state = 'acknowledged' AND job.operation_key IS NULL) OR job.updated_at <= ?)
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
                   step.state IN (${CAPABILITY_PROBE_OBLIGATION_STATES.map(state => `'${state}'`).join(",")})
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
    return rows.map(row => this.#verifiedVideoJobRow(row) as VideoJobRecord);
  }

  listPublicVideoJobs(): PublicVideoJob[] {
    return this.listVideoJobs().map(publicJob);
  }

  reserveVideoJob(input: {
    binding: MediaCredentialBinding;
    deadlineAt: number;
    operationKey?: string;
    requestSemanticsDigest?: string;
    probeOperationId?: string;
    confirmationRevision?: number;
  }): VideoJobReservation {
    const now = this.#now();
    if (
      !validText(input.binding.slotRef, 256)
      || !validText(input.binding.identityDigest, 128)
      || (input.binding.authSource === "subscription_oauth" && input.binding.providerKind !== "canonical")
      || !validInteger(now, 1)
      || !validInteger(input.deadlineAt, 1)
      || input.deadlineAt <= now
      || (input.operationKey !== undefined && !validText(input.operationKey, 128))
      || (input.requestSemanticsDigest !== undefined && !validText(input.requestSemanticsDigest, 128))
      || ((input.operationKey === undefined) !== (input.requestSemanticsDigest === undefined))
      || (input.probeOperationId !== undefined && !validText(input.probeOperationId, 64))
      || (input.confirmationRevision !== undefined && !validInteger(input.confirmationRevision, 1))
      || ((input.probeOperationId === undefined) !== (input.confirmationRevision === undefined))
    ) throw journalError("The media job reservation is invalid.");
    return this.#transaction(() => {
      this.#verifyAllVideoJobs();
      if (input.operationKey) {
        const replayCutoff = now - VIDEO_JOB_RECOVERY_RETENTION_MS;
        const operationMatches = this.#database.query<VideoJobRow, [string, number]>(`
          SELECT * FROM video_jobs
           WHERE operation_key = ?
             AND (state IN (${VIDEO_ADMISSION_HOLDING_STATES.map(state => `'${state}'`).join(",")}) OR updated_at > ?)
           ORDER BY created_at DESC, id DESC
           LIMIT 2
        `).all(input.operationKey, replayCutoff).map(row => this.#verifiedVideoJobRow(row) as VideoJobRecord);
        if (operationMatches.length > 1) return { kind: "busy", reservationId: operationMatches[0]!.id };
        const existingOperation = operationMatches[0];
        if (existingOperation) {
          if (
            existingOperation.binding.identityDigest !== input.binding.identityDigest
            || existingOperation.binding.authSource !== input.binding.authSource
            || existingOperation.binding.providerKind !== input.binding.providerKind
            || existingOperation.binding.slotRef !== input.binding.slotRef
            || existingOperation.requestSemanticsDigest !== input.requestSemanticsDigest
          ) return { kind: "busy", reservationId: existingOperation.id };
          return { kind: "replay", job: existingOperation };
        }
      }
      const existing = this.#verifiedVideoJobRow(this.#database.query<VideoJobRow, [string]>(
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
      const queuedJob: VideoJobRecord = {
        id,
        revision: 0,
        state: "queued",
        binding: input.binding,
        deadlineAt: input.deadlineAt,
        ...(input.operationKey ? { operationKey: input.operationKey } : {}),
        ...(input.requestSemanticsDigest ? { requestSemanticsDigest: input.requestSemanticsDigest } : {}),
        ...(input.probeOperationId ? { probeOperationId: input.probeOperationId } : {}),
        ...(input.confirmationRevision !== undefined ? { confirmationRevision: input.confirmationRevision } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const bindingWitness = deriveVideoJobIntegrityWitness(this.#replaySecret, queuedJob);
      this.#database.query(`
        INSERT INTO video_jobs (
          id, revision, state, auth_source, provider_kind, slot_ref, binding_digest, binding_witness,
          deadline_at, operation_key, request_semantics_digest, request_id, artifact_id, safe_error, probe_operation_id,
          confirmation_revision, created_at, updated_at
        ) VALUES (?,0,'queued',?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?)
      `).run(
        id,
        input.binding.authSource,
        input.binding.providerKind,
        input.binding.slotRef,
        input.binding.identityDigest,
        bindingWitness,
        input.deadlineAt,
        input.operationKey ?? null,
        input.requestSemanticsDigest ?? null,
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
      this.#get(input.id);
      const now = this.#now();
      const result = this.#database.query(`
        UPDATE video_jobs
           SET state = ?, revision = revision + 1, updated_at = MAX(updated_at, ?),
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
      if (result.changes === 1) {
        const current = this.#sealVideoJob(input.id);
        if (!current) throw journalError("The updated media job could not be sealed.");
        return { kind: "updated", job: current };
      }
      return { kind: "conflict", current: this.#get(input.id) };
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
      this.#get(id);
      const result = this.#database.query(`
        UPDATE video_jobs
           SET state = 'completed', revision = revision + 1, updated_at = MAX(updated_at, ?), safe_error = NULL
         WHERE id = ? AND revision = ? AND state = 'downloading' AND artifact_id = ?
      `).run(this.#now(), id, expectedRevision, artifactId);
      if (result.changes === 1) {
        const current = this.#sealVideoJob(id);
        if (!current) throw journalError("The completed media job could not be sealed.");
        return { kind: "updated", job: current };
      }
      return { kind: "conflict", current: this.#get(id) };
    });
  }

  /** CAS-prepare deletion while retaining the private id until directory fsync succeeds. */
  markVideoArtifactPruned(id: string, expectedRevision: number, artifactId: string): VideoJobUpdate {
    if (!validText(id, 64) || !validInteger(expectedRevision) || !safeArtifactId(artifactId)) {
      throw journalError("The pruned video artifact transition is invalid.");
    }
    return this.#transaction(() => {
      this.#get(id);
      const result = this.#database.query(`
        UPDATE video_jobs
           SET state = 'artifact_pruned', revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE id = ? AND revision = ? AND state = 'completed' AND artifact_id = ?
      `).run(this.#now(), id, expectedRevision, artifactId);
      if (result.changes === 1) {
        const current = this.#sealVideoJob(id);
        if (!current) throw journalError("The pruned media job could not be sealed.");
        return { kind: "updated", job: current };
      }
      return { kind: "conflict", current: this.#get(id) };
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
    for (const job of jobs) this.#get(job.id);
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
      for (const job of jobs) this.#get(job.id);
      if (jobs.some(job => job.state !== "completed" && job.state !== "artifact_pruned")) return "protected";
      const changed = this.#database.query(`
        UPDATE video_jobs
           SET state = 'artifact_pruned', revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE artifact_id = ? AND state = 'completed'
      `).run(this.#now(), artifactId);
      const completed = jobs.filter(job => job.state === "completed");
      if (changed.changes !== completed.length) return "conflict";
      for (const job of completed) {
        if (!this.#sealVideoJob(job.id)) throw journalError("The released media job could not be sealed.");
      }
      return "released";
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
      for (const row of rows) this.#get(row.id);
      if (rows.some(row => row.state !== "artifact_pruned" && row.state !== "expired")) return "protected";
      const changed = this.#database.query(`
        UPDATE video_jobs
           SET artifact_id = NULL, revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE artifact_id = ? AND state IN ('artifact_pruned','expired')
      `).run(this.#now(), artifactId);
      if (changed.changes !== rows.length) return "conflict";
      for (const row of rows) {
        if (!this.#sealVideoJob(row.id)) throw journalError("The finalized media job could not be sealed.");
      }
      return "finalized";
    });
  }

  fenceVideoSubmission(id: string, expectedRevision: number): VideoJobUpdate {
    return this.transitionVideoJob({ id, expectedRevision, from: ["queued"], to: "submitting" });
  }

  /**
   * Terminalize a definite authentication failure that occurred before provider dispatch.
   * No paid request can exist without dispatch, so the retry identity must be released
   * atomically with the binding admission hold instead of becoming a replayable tombstone.
   */
  failVideoSubmissionNeedsAuth(id: string, expectedRevision: number): VideoJobUpdate {
    if (!validText(id, 64) || !validInteger(expectedRevision)) {
      throw journalError("The pre-dispatch media failure is invalid.");
    }
    return this.#transaction(() => {
      this.#get(id);
      const result = this.#database.query(`
        UPDATE video_jobs
           SET state = 'failed', safe_error = 'needs_auth',
               operation_key = NULL, request_semantics_digest = NULL,
               revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE id = ? AND revision = ? AND state = 'submitting' AND request_id IS NULL
      `).run(this.#now(), id, expectedRevision);
      if (result.changes === 1) {
        const current = this.#sealVideoJob(id);
        if (!current) throw journalError("The pre-dispatch media failure could not be sealed.");
        return { kind: "updated", job: current };
      }
      return { kind: "conflict", current: this.#get(id) };
    });
  }

  commitVideoAccepted(id: string, expectedRevision: number, requestId: string): VideoJobUpdate {
    if (!safeRequestId(requestId)) throw journalError("The accepted media request identifier is invalid.");
    return this.#transaction(() => {
      this.#get(id);
      const result = this.#database.query(`
        UPDATE video_jobs
           SET state = 'accepted', request_id = ?, revision = revision + 1, updated_at = MAX(updated_at, ?), safe_error = NULL
         WHERE id = ? AND revision = ? AND state = 'submitting' AND request_id IS NULL
      `).run(requestId, this.#now(), id, expectedRevision);
      if (result.changes === 1) {
        const current = this.#sealVideoJob(id);
        if (!current) throw journalError("The accepted media job could not be sealed.");
        return { kind: "updated", job: current };
      }
      return { kind: "conflict", current: this.#get(id) };
    });
  }

  acknowledgeVideoOutcomeUnknown(id: string, expectedRevision: number): VideoJobUpdate {
    const current = this.getVideoJob(id);
    // Probe-owned uncertainty must use the aggregate acknowledgement path,
    // which advances the job and probe step in one journal transaction.
    if (current?.probeOperationId) return { kind: "conflict", current };
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
      this.#verifyAllVideoJobs();
      const wallNow = this.#now();
      if (!validInteger(wallNow, 1)) throw journalError("The media recovery clock is invalid.");
      const timestampFloor = this.#database.query<{ timestamp_floor: number | null }, []>(`
        SELECT max(value) AS timestamp_floor
          FROM (
            SELECT created_at AS value FROM video_jobs
            UNION ALL SELECT updated_at FROM video_jobs
            UNION ALL SELECT created_at FROM capability_probes
            UNION ALL SELECT updated_at FROM capability_probes
            UNION ALL SELECT updated_at FROM capability_probe_steps
          )
      `).get()?.timestamp_floor;
      if (timestampFloor !== null && timestampFloor !== undefined && !validInteger(timestampFloor, 1)) {
        throw journalError("The media recovery timestamp floor is invalid.");
      }
      // Wall clocks may move backward across restart. Mutation timestamps must
      // never regress durable rows, while deadline expiry still uses wall time.
      const now = Math.max(wallNow, timestampFloor ?? 0);
      const queued = this.#database.query<{ id: string }, []>(
        `SELECT id FROM video_jobs WHERE state = 'queued' ORDER BY created_at ASC LIMIT ${MAX_ROWS + 1}`,
      ).all();
      const submitting = this.#database.query<{ id: string }, []>(
        `SELECT id FROM video_jobs WHERE state = 'submitting' ORDER BY created_at ASC LIMIT ${MAX_ROWS + 1}`,
      ).all();
      if (queued.length > MAX_ROWS || submitting.length > MAX_ROWS) {
        throw journalError("The media recovery set is too large.");
      }
      // Beginning the probe step precedes durable video reservation. If the
      // exact confirmation has no job row, no submission could have reached
      // the provider, so recovery must release it as a definite non-dispatch
      // instead of creating an outcome_unknown obligation with nothing to
      // acknowledge.
      this.#database.query(`
        UPDATE capability_probes
           SET revision = revision + 1, updated_at = ?
         WHERE EXISTS (
           SELECT 1 FROM capability_probe_steps s
            WHERE s.operation_id = capability_probes.id
              AND s.step_kind = 'video' AND s.state IN ('submitting','outcome_unknown')
              AND NOT EXISTS (
                SELECT 1 FROM video_jobs v
                 WHERE v.probe_operation_id = s.operation_id
                   AND v.confirmation_revision = s.confirmation_revision
              )
         )
      `).run(now);
      this.#database.query(`
        UPDATE capability_probe_steps
           SET state = 'failed', dispatch_certainty = 'definite_rejection',
               safe_error = 'cancelled', video_job_id = NULL,
               revision = revision + 1, updated_at = ?
         WHERE step_kind = 'video' AND state IN ('submitting','outcome_unknown')
           AND NOT EXISTS (
             SELECT 1 FROM video_jobs v
              WHERE v.probe_operation_id = capability_probe_steps.operation_id
                AND v.confirmation_revision = capability_probe_steps.confirmation_revision
           )
      `).run(now);
      // A queued probe job is durable proof that the probe began local
      // admission, but the absence of the submission fence proves that no
      // provider dispatch could have started. Settle the exact confirmation as
      // a definite rejection before cancelling the job so the probe does not
      // become an unacknowledgeable outcome_unknown hold below.
      this.#database.query(`
        UPDATE capability_probes
           SET revision = revision + 1, updated_at = ?
         WHERE EXISTS (
           SELECT 1
             FROM capability_probe_steps s
             JOIN video_jobs v
               ON v.probe_operation_id = s.operation_id
              AND v.confirmation_revision = s.confirmation_revision
            WHERE s.operation_id = capability_probes.id
              AND s.step_kind = 'video' AND s.state IN ('submitting','outcome_unknown')
              AND v.state = 'queued'
         )
      `).run(now);
      this.#database.query(`
        UPDATE capability_probe_steps
           SET state = 'failed', dispatch_certainty = 'definite_rejection',
               safe_error = 'cancelled',
               video_job_id = (
                 SELECT v.id FROM video_jobs v
                  WHERE v.probe_operation_id = capability_probe_steps.operation_id
                    AND v.confirmation_revision = capability_probe_steps.confirmation_revision
                    AND v.state = 'queued'
                  ORDER BY v.created_at ASC, v.id ASC LIMIT 1
               ),
               revision = revision + 1, updated_at = ?
         WHERE step_kind = 'video' AND state IN ('submitting','outcome_unknown')
           AND EXISTS (
             SELECT 1 FROM video_jobs v
              WHERE v.probe_operation_id = capability_probe_steps.operation_id
                AND v.confirmation_revision = capability_probe_steps.confirmation_revision
                AND v.state = 'queued'
           )
      `).run(now);
      // No dispatch can occur before the submitting fence. Releasing these rows is safe,
      // but startup still never initiates replacement work without a new confirmation.
      this.#database.query(`
        UPDATE video_jobs
           SET state = 'cancelled', safe_error = 'cancelled',
               operation_key = NULL, request_semantics_digest = NULL,
               revision = revision + 1, updated_at = ?
         WHERE state = 'queued'
      `).run(now);
      // A definite terminal job can be committed just before the probe owner
      // mirrors that result. Preserve the exact local outcome on restart rather
      // than turning the aggregate into an uncertainty that cannot be
      // acknowledged against a non-unknown job.
      this.#database.query(`
        UPDATE capability_probes
           SET revision = revision + 1, updated_at = ?
         WHERE EXISTS (
           SELECT 1
             FROM capability_probe_steps s
             JOIN video_jobs v
               ON v.probe_operation_id = s.operation_id
              AND v.confirmation_revision = s.confirmation_revision
            WHERE s.operation_id = capability_probes.id
              AND s.step_kind = 'video' AND s.state IN ('submitting','outcome_unknown')
              AND v.state IN ('failed','cancelled','expired')
         )
      `).run(now);
      this.#database.query(`
        UPDATE capability_probe_steps
           SET state = 'failed', dispatch_certainty = 'definite_rejection',
               safe_error = (
                 SELECT CASE
                          WHEN v.safe_error IS NOT NULL THEN v.safe_error
                          WHEN v.state = 'cancelled' THEN 'cancelled'
                          ELSE 'upstream_failed'
                        END
                   FROM video_jobs v
                  WHERE v.probe_operation_id = capability_probe_steps.operation_id
                    AND v.confirmation_revision = capability_probe_steps.confirmation_revision
                    AND v.state IN ('failed','cancelled','expired')
                  ORDER BY v.created_at DESC, v.id DESC LIMIT 1
               ),
               video_job_id = (
                 SELECT v.id FROM video_jobs v
                  WHERE v.probe_operation_id = capability_probe_steps.operation_id
                    AND v.confirmation_revision = capability_probe_steps.confirmation_revision
                    AND v.state IN ('failed','cancelled','expired')
                  ORDER BY v.created_at DESC, v.id DESC LIMIT 1
               ),
               revision = revision + 1, updated_at = ?
         WHERE step_kind = 'video' AND state IN ('submitting','outcome_unknown')
           AND EXISTS (
             SELECT 1 FROM video_jobs v
              WHERE v.probe_operation_id = capability_probe_steps.operation_id
                AND v.confirmation_revision = capability_probe_steps.confirmation_revision
                AND v.state IN ('failed','cancelled','expired')
           )
      `).run(now);
      // A durable provider request id proves acceptance even when the probe
      // aggregate crashed before recording its video-job link. Reconcile that
      // linkage before deadline expiry changes the job's recoverable state.
      this.#database.query(`
        UPDATE capability_probe_steps
           SET state = 'accepted', dispatch_certainty = 'accepted', safe_error = NULL,
               video_job_id = (
                 SELECT v.id FROM video_jobs v
                  WHERE v.probe_operation_id = capability_probe_steps.operation_id
                    AND v.confirmation_revision = capability_probe_steps.confirmation_revision
                    AND v.request_id IS NOT NULL
                    AND v.state IN ('accepted','polling','needs_auth','downloading','download_failed','completed','artifact_pruned')
                  ORDER BY v.created_at DESC LIMIT 1
               ),
               revision = revision + 1, updated_at = ?
         WHERE step_kind = 'video' AND state IN ('submitting','outcome_unknown')
           AND EXISTS (
             SELECT 1 FROM video_jobs v
              WHERE v.probe_operation_id = capability_probe_steps.operation_id
                AND v.confirmation_revision = capability_probe_steps.confirmation_revision
                AND v.request_id IS NOT NULL
                AND v.state IN ('accepted','polling','needs_auth','downloading','download_failed','completed','artifact_pruned')
           )
      `).run(now);
      // A restart never extends the original absolute deadline. Expire every
      // poll/download-safe state before selecting background recovery work.
      this.#database.query(`
        UPDATE video_jobs
           SET state = 'expired', safe_error = 'timeout', revision = revision + 1, updated_at = ?
         WHERE deadline_at <= ?
           AND state IN ('accepted','polling','needs_auth','downloading','download_failed')
           AND NOT (state IN ('downloading','download_failed') AND artifact_id IS NOT NULL)
      `).run(now, wallNow);
      this.#database.query(`
        UPDATE video_jobs
           SET state = 'outcome_unknown', safe_error = 'ambiguous_submission', revision = revision + 1, updated_at = ?
         WHERE state = 'submitting'
      `).run(now);
      this.#database.query(`
        UPDATE capability_probe_steps
           SET state = 'outcome_unknown', dispatch_certainty = 'outcome_unknown',
               safe_error = 'ambiguous_submission', revision = revision + 1, updated_at = ?
         WHERE state = 'submitting'
           AND (
             step_kind = 'image'
             OR (
               step_kind = 'video'
               AND EXISTS (
                 SELECT 1 FROM video_jobs v
                  WHERE v.probe_operation_id = capability_probe_steps.operation_id
                    AND v.confirmation_revision = capability_probe_steps.confirmation_revision
                    AND v.state = 'outcome_unknown'
               )
             )
           )
      `).run(now);
      // Older runtimes allowed the generic job action to acknowledge a
      // probe-owned uncertainty without advancing its aggregate step. Repair
      // that exact split before enforcing the acknowledgement invariant below.
      this.#database.query(`
        UPDATE capability_probes
           SET revision = revision + 1, updated_at = ?
         WHERE EXISTS (
           SELECT 1
             FROM capability_probe_steps s
             JOIN video_jobs v
               ON v.probe_operation_id = s.operation_id
              AND v.confirmation_revision = s.confirmation_revision
            WHERE s.operation_id = capability_probes.id
              AND s.step_kind = 'video' AND s.state IN ('submitting','outcome_unknown')
              AND v.state = 'acknowledged'
         )
      `).run(now);
      this.#database.query(`
        UPDATE capability_probe_steps
           SET state = 'acknowledged', dispatch_certainty = 'outcome_unknown',
               safe_error = 'ambiguous_submission',
               video_job_id = (
                 SELECT v.id FROM video_jobs v
                  WHERE v.probe_operation_id = capability_probe_steps.operation_id
                    AND v.confirmation_revision = capability_probe_steps.confirmation_revision
                    AND v.state = 'acknowledged'
                  ORDER BY v.created_at DESC, v.id DESC LIMIT 1
               ),
               revision = revision + 1, updated_at = ?
         WHERE step_kind = 'video' AND state IN ('submitting','outcome_unknown')
           AND EXISTS (
             SELECT 1 FROM video_jobs v
              WHERE v.probe_operation_id = capability_probe_steps.operation_id
                AND v.confirmation_revision = capability_probe_steps.confirmation_revision
                AND v.state = 'acknowledged'
           )
      `).run(now);
      const unreconciledVideoSteps = this.#database.query<{ count: number }, []>(`
        SELECT count(*) AS count
          FROM capability_probe_steps s
         WHERE s.step_kind = 'video'
           AND (
             s.state = 'submitting'
             OR (
               s.state = 'outcome_unknown'
               AND NOT EXISTS (
                 SELECT 1 FROM video_jobs v
                  WHERE v.probe_operation_id = s.operation_id
                    AND v.confirmation_revision = s.confirmation_revision
                    AND v.state = 'outcome_unknown'
               )
             )
           )
      `).get()?.count;
      if (!validInteger(unreconciledVideoSteps) || unreconciledVideoSteps !== 0) {
        throw journalError("The media probe recovery state is inconsistent.");
      }
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
      this.#sealAllVideoJobs();
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
    ids.push(...this.#capabilityProbes.protectedArtifactIds());
    return new Set(ids);
  }

  /** Exact durable reservations whose local hard-link publication may be completed after a crash. */
  recoverablePublicationArtifactIds(): ReadonlySet<string> {
    return new Set(this.listVideoJobs()
      .filter(job => job.artifactId && (job.state === "downloading" || job.state === "download_failed"))
      .map(job => job.artifactId!));
  }

  /** Exact timed-out reservations whose validated two-name publication must be deleted, not adopted. */
  expiredLinkedPublicationArtifactIds(): ReadonlySet<string> {
    return new Set(this.listVideoJobs()
      .filter(job => (
        job.state === "expired"
        && job.safeError === "timeout"
        && job.artifactId
        && /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:mp4|webm)$/i.test(job.artifactId)
      ))
      .map(job => job.artifactId!));
  }

  getCapabilityProbe(id: string): CapabilityProbeRecord | null {
    return this.#capabilityProbes.get(id);
  }

  publicCapabilityProbe(id: string): PublicCapabilityProbe | null {
    return this.#capabilityProbes.public(id);
  }

  getOrCreateCapabilityProbe(input: {
    keyDigest: string;
    bindingDigest: string;
    imageModel: string;
    videoModel: string;
    contractRevision: string;
    probeVersion: number;
  }): { kind: "created" | "existing"; probe: CapabilityProbeRecord } {
    return this.#capabilityProbes.getOrCreate(input);
  }

  authorizeCapabilityProbe(input: {
    id: string;
    expectedRevision: number;
    confirmationRevision: number;
    expiresAt: number;
  }): CapabilityProbeUpdate {
    return this.#capabilityProbes.authorize(input);
  }

  beginCapabilityProbeStep(input: {
    id: string;
    step: CapabilityProbeStepKind;
    expectedRevision: number;
    confirmationRevision: number;
  }): CapabilityProbeUpdate {
    return this.#capabilityProbes.beginStep(input);
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
    return this.#capabilityProbes.settleStep(input);
  }

  acknowledgeCapabilityProbeStep(input: {
    id: string;
    step: CapabilityProbeStepKind;
    expectedRevision: number;
  }): CapabilityProbeUpdate {
    return this.#capabilityProbes.acknowledgeStep(input);
  }

  recordCapabilityProbeInspection(input: {
    id: string;
    step: CapabilityProbeStepKind;
    expectedRevision: number;
  }): { kind: "updated"; probe: CapabilityProbeRecord; deletion: CapabilityArtifactDeletion }
    | { kind: "conflict"; current: CapabilityProbeRecord | null } {
    return this.#capabilityProbes.recordInspection(input);
  }

  listPendingCapabilityArtifactDeletions(now = this.#now()): CapabilityArtifactDeletion[] {
    return this.#capabilityProbes.listPendingArtifactDeletions(now);
  }

  completeCapabilityArtifactDeletion(input: CapabilityArtifactDeletion): CapabilityProbeUpdate {
    return this.#capabilityProbes.completeArtifactDeletion(input);
  }
  findVideoJobForProbe(operationId: string, confirmationRevision?: number): VideoJobRecord | null {
    this.#assertOpen();
    if (confirmationRevision !== undefined && !validInteger(confirmationRevision, 1)) return null;
    const row = confirmationRevision === undefined
      ? this.#database.query<VideoJobRow, [string]>(
        "SELECT * FROM video_jobs WHERE probe_operation_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(operationId)
      : this.#database.query<VideoJobRow, [string, number]>(`
        SELECT * FROM video_jobs
         WHERE probe_operation_id = ? AND confirmation_revision = ?
         ORDER BY created_at DESC LIMIT 1
      `).get(operationId, confirmationRevision);
    return this.#verifiedVideoJobRow(row);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#database.close(); } finally {
      try { this.#file.close(); } finally {
        try { this.#replaySecretLease.close(); } finally {
          try { this.#ownerLease.close(); } finally {
            closeMediaRecoveryCoordinators(this.#recoveryCoordinators);
          }
        }
      }
    }
  }
}

export function openVideoJobStore(options: VideoJobStoreOptions = {}): VideoJobStore {
  return new VideoJobStore(options);
}

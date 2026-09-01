import { Database } from "bun:sqlite";

import type { SafeMediaFailure } from "./media-safe-failure";

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

interface LinkedVideoJobRecord {
  readonly id: string;
  readonly revision: number;
  readonly state: string;
  readonly artifactId?: string;
}

export const CAPABILITY_PROBE_OBLIGATION_STATES: readonly CapabilityProbeStepState[] = [
  "submitting",
  "accepted",
  "outcome_unknown",
];

const PROBE_STEP_STATES: readonly CapabilityProbeStepState[] = [
  "pending", "submitting", "accepted", "completed", "failed", "outcome_unknown", "acknowledged",
];
const PROBE_DISPATCH_CERTAINTIES: readonly CapabilityProbeDispatchCertainty[] = [
  "not_dispatched", "dispatch_started", "accepted", "definite_rejection", "outcome_unknown", "completed",
];

export function createCapabilityProbeSchema(database: Database, safeFailures: readonly string[]): void {
  database.exec(`
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
    ) STRICT`);
  database.exec(`
    CREATE TABLE capability_probe_steps (
      operation_id TEXT NOT NULL REFERENCES capability_probes(id) ON DELETE RESTRICT,
      step_kind TEXT NOT NULL CHECK(step_kind IN ('image','video')),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      state TEXT NOT NULL CHECK(state IN (${PROBE_STEP_STATES.map(value => `'${value}'`).join(",")})),
      dispatch_certainty TEXT NOT NULL CHECK(dispatch_certainty IN (${PROBE_DISPATCH_CERTAINTIES.map(value => `'${value}'`).join(",")})),
      safe_error TEXT CHECK(safe_error IS NULL OR safe_error IN (${safeFailures.map(value => `'${value}'`).join(",")})),
      artifact_id TEXT CHECK(artifact_id IS NULL OR length(artifact_id) BETWEEN 1 AND 256),
      artifact_expires_at INTEGER CHECK(artifact_expires_at IS NULL OR artifact_expires_at > 0),
      video_job_id TEXT CHECK(video_job_id IS NULL OR length(video_job_id) BETWEEN 1 AND 64),
      confirmation_revision INTEGER CHECK(confirmation_revision IS NULL OR confirmation_revision > 0),
      verified_at INTEGER CHECK(verified_at IS NULL OR verified_at > 0),
      inspected_at INTEGER CHECK(inspected_at IS NULL OR inspected_at > 0),
      updated_at INTEGER NOT NULL CHECK(updated_at > 0),
      PRIMARY KEY(operation_id, step_kind)
    ) STRICT`);
}

export function assertCapabilityProbeSchema(database: Database, error: (message: string) => Error): void {
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
  ) throw error("The media journal probe schema is malformed.");
  const stepColumns = new Set([
    "operation_id", "step_kind", "revision", "state", "dispatch_certainty", "safe_error",
    "artifact_id", "artifact_expires_at", "video_job_id", "confirmation_revision", "verified_at", "inspected_at", "updated_at",
  ]);
  const observedStepColumns = database.query<{ name: string }, []>("PRAGMA table_info(capability_probe_steps)").all();
  if (
    observedStepColumns.length !== stepColumns.size
    || observedStepColumns.some(column => !stepColumns.delete(column.name))
    || stepColumns.size !== 0
  ) throw error("The media journal probe-step schema is malformed.");
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

function safeArtifactId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value) && !value.includes("..");
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

interface CapabilityProbePersistenceOwner {
  database: Database;
  now: () => number;
  maxRows: number;
  safeFailures: readonly SafeMediaFailure[];
  error: (message: string) => Error;
  assertOpen: () => void;
  transaction<T>(operation: () => T): T;
  /** Canonical full-row decoder owned by VideoJobStore; malformed rows throw. */
  decodeVideoJobRow: (row: Record<string, unknown> | null) => LinkedVideoJobRecord | null;
  /** Recompute the private full-row witness after a video mutation in this transaction. */
  sealVideoJob: (id: string) => LinkedVideoJobRecord | null;
}

/** Capability aggregate persistence; all mutations run through the journal owner's transaction. */
export class CapabilityProbePersistence {
  readonly #owner: CapabilityProbePersistenceOwner;

  constructor(owner: CapabilityProbePersistenceOwner) {
    this.#owner = owner;
  }

  #validSafeFailure(value: unknown): value is SafeMediaFailure {
    return typeof value === "string" && (this.#owner.safeFailures as readonly string[]).includes(value);
  }

  #step(row: CapabilityProbeStepRow | null): CapabilityProbeStepRecord | null {
    if (!row) return null;
    if (
      (row.step_kind !== "image" && row.step_kind !== "video")
      || !validInteger(row.revision)
      || typeof row.state !== "string" || !(PROBE_STEP_STATES as readonly string[]).includes(row.state)
      || typeof row.dispatch_certainty !== "string" || !(PROBE_DISPATCH_CERTAINTIES as readonly string[]).includes(row.dispatch_certainty)
      || (row.safe_error !== null && !this.#validSafeFailure(row.safe_error))
      || (row.artifact_id !== null && (!validText(row.artifact_id, 256) || !safeArtifactId(row.artifact_id)))
      || (row.artifact_expires_at !== null && !validInteger(row.artifact_expires_at, 1))
      || (row.video_job_id !== null && !validText(row.video_job_id, 64))
      || (row.confirmation_revision !== null && !validInteger(row.confirmation_revision, 1))
      || (row.verified_at !== null && !validInteger(row.verified_at, 1))
      || (row.inspected_at !== null && !validInteger(row.inspected_at, 1))
      || !validInteger(row.updated_at, 1)
    ) throw this.#owner.error("The media journal contains a malformed probe step.");
    return {
      kind: row.step_kind,
      revision: row.revision,
      state: row.state as CapabilityProbeStepState,
      dispatchCertainty: row.dispatch_certainty as CapabilityProbeDispatchCertainty,
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

  #get(id: string): CapabilityProbeRecord | null {
    if (!validText(id, 64)) return null;
    const row = this.#owner.database.query<CapabilityProbeRow, [string]>(
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
    ) throw this.#owner.error("The media journal contains a malformed capability probe.");
    const stepRows = this.#owner.database.query<CapabilityProbeStepRow, [string]>(
      "SELECT * FROM capability_probe_steps WHERE operation_id = ? ORDER BY step_kind ASC",
    ).all(id);
    if (stepRows.length !== 2) throw this.#owner.error("The media capability probe has incomplete steps.");
    const image = this.#step(stepRows.find(step => step.step_kind === "image") ?? null);
    const video = this.#step(stepRows.find(step => step.step_kind === "video") ?? null);
    if (!image || !video) throw this.#owner.error("The media capability probe has malformed steps.");
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

  get(id: string): CapabilityProbeRecord | null {
    this.#owner.assertOpen();
    return this.#get(id);
  }

  public(id: string): PublicCapabilityProbe | null {
    const probe = this.get(id);
    return probe ? publicProbe(probe) : null;
  }

  getOrCreate(input: {
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
    ) throw this.#owner.error("The capability probe key is invalid.");
    return this.#owner.transaction(() => {
      const existingRow = this.#owner.database.query<{ id: string }, [string]>(
        "SELECT id FROM capability_probes WHERE key_digest = ?",
      ).get(input.keyDigest);
      if (existingRow) {
        const existing = this.#get(existingRow.id);
        if (!existing) throw this.#owner.error("The capability probe is unavailable.");
        return { kind: "existing", probe: existing };
      }
      const count = this.#owner.database.query<{ count: number }, []>("SELECT count(*) AS count FROM capability_probes").get()?.count ?? this.#owner.maxRows;
      if (count >= this.#owner.maxRows) throw this.#owner.error("The media journal row limit was exceeded.");
      const id = crypto.randomUUID();
      const now = this.#owner.now();
      this.#owner.database.query(`
        INSERT INTO capability_probes (
          id, key_digest, revision, binding_digest, image_model, video_model,
          contract_revision, probe_version, confirmation_revision, confirmation_expires_at,
          created_at, updated_at
        ) VALUES (?,?,0,?,?,?,?,?,NULL,NULL,?,?)
      `).run(id, input.keyDigest, input.bindingDigest, input.imageModel, input.videoModel, input.contractRevision, input.probeVersion, now, now);
      for (const step of ["image", "video"] as const) {
        this.#owner.database.query(`
          INSERT INTO capability_probe_steps (
            operation_id, step_kind, revision, state, dispatch_certainty, safe_error,
            artifact_id, artifact_expires_at, video_job_id, confirmation_revision, verified_at, inspected_at, updated_at
          ) VALUES (?,?,0,'pending','not_dispatched',NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)
        `).run(id, step, now);
      }
      const probe = this.#get(id);
      if (!probe) throw this.#owner.error("The capability probe was not durable.");
      return { kind: "created", probe };
    });
  }

  authorize(input: { id: string; expectedRevision: number; confirmationRevision: number; expiresAt: number }): CapabilityProbeUpdate {
    if (
      !validText(input.id, 64)
      || !validInteger(input.expectedRevision)
      || !validInteger(input.confirmationRevision, 1)
      || !validInteger(input.expiresAt, 1)
      || input.expiresAt <= this.#owner.now()
    ) throw this.#owner.error("The capability probe confirmation is invalid.");
    return this.#owner.transaction(() => {
      const result = this.#owner.database.query(`
        UPDATE capability_probes
           SET confirmation_revision = ?, confirmation_expires_at = ?, revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE id = ? AND revision = ? AND (confirmation_revision IS NULL OR confirmation_revision < ?)
      `).run(input.confirmationRevision, input.expiresAt, this.#owner.now(), input.id, input.expectedRevision, input.confirmationRevision);
      const current = this.#get(input.id);
      return result.changes === 1 && current ? { kind: "updated", probe: current } : { kind: "conflict", current };
    });
  }

  beginStep(input: { id: string; step: CapabilityProbeStepKind; expectedRevision: number; confirmationRevision: number }): CapabilityProbeUpdate {
    return this.#owner.transaction(() => {
      const current = this.#get(input.id);
      if (
        !current || current.revision !== input.expectedRevision
        || current.confirmationRevision !== input.confirmationRevision
        || !current.confirmationExpiresAt || current.confirmationExpiresAt <= this.#owner.now()
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
      const now = this.#owner.now();
      const changed = this.#owner.database.query(`
        UPDATE capability_probe_steps
           SET state = 'submitting', dispatch_certainty = 'dispatch_started', safe_error = NULL,
               artifact_id = NULL, artifact_expires_at = NULL, video_job_id = NULL, confirmation_revision = ?,
               verified_at = NULL, inspected_at = NULL, revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE operation_id = ? AND step_kind = ? AND revision = ?
      `).run(input.confirmationRevision, now, input.id, input.step, step.revision);
      if (changed.changes !== 1) return { kind: "conflict", current: this.#get(input.id) };
      this.#owner.database.query("UPDATE capability_probes SET revision = revision + 1, updated_at = MAX(updated_at, ?) WHERE id = ? AND revision = ?")
        .run(now, input.id, input.expectedRevision);
      const updated = this.#get(input.id);
      return updated ? { kind: "updated", probe: updated } : { kind: "conflict", current: null };
    });
  }

  settleStep(input: {
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
      || (input.artifactId !== undefined && input.artifactId !== null && (
        input.verifiedAt === undefined || input.verifiedAt === null
        || input.artifactExpiresAt === undefined || input.artifactExpiresAt === null
        || input.artifactExpiresAt <= input.verifiedAt
      ))
      || (input.videoJobId !== undefined && input.videoJobId !== null && !validText(input.videoJobId, 64))
      || (input.safeError !== undefined && input.safeError !== null && !this.#validSafeFailure(input.safeError))
      || (input.verifiedAt !== undefined && input.verifiedAt !== null && !validInteger(input.verifiedAt, 1))
    ) throw this.#owner.error("The capability probe result is invalid.");
    return this.#owner.transaction(() => {
      const now = this.#owner.now();
      const result = this.#owner.database.query(`
        UPDATE capability_probe_steps
           SET state = ?, dispatch_certainty = ?, safe_error = ?, artifact_id = ?, artifact_expires_at = ?,
               video_job_id = ?, verified_at = ?, revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE operation_id = ? AND step_kind = ? AND revision = ? AND state IN ('submitting','accepted')
      `).run(input.state, input.dispatchCertainty, input.safeError ?? null, input.artifactId ?? null,
        input.artifactExpiresAt ?? null, input.videoJobId ?? null, input.verifiedAt ?? null, now,
        input.id, input.step, input.expectedStepRevision);
      if (result.changes === 1) {
        this.#owner.database.query("UPDATE capability_probes SET revision = revision + 1, updated_at = MAX(updated_at, ?) WHERE id = ?").run(now, input.id);
      }
      const current = this.#get(input.id);
      return result.changes === 1 && current ? { kind: "updated", probe: current } : { kind: "conflict", current };
    });
  }

  acknowledgeStep(input: { id: string; step: CapabilityProbeStepKind; expectedRevision: number }): CapabilityProbeUpdate {
    return this.#owner.transaction(() => {
      const current = this.#get(input.id);
      if (!current || current.revision !== input.expectedRevision) return { kind: "conflict", current };
      const step = current.steps[input.step];
      if (step.state !== "outcome_unknown") return { kind: "conflict", current };
      const now = this.#owner.now();
      if (input.step === "video") {
        const confirmationRevision = step.confirmationRevision;
        if (confirmationRevision === undefined) return { kind: "conflict", current };
        const matches = this.#owner.database.query<Record<string, unknown>, [string, number]>(`
          SELECT * FROM video_jobs
           WHERE probe_operation_id = ? AND confirmation_revision = ? AND state = 'outcome_unknown'
           ORDER BY created_at ASC, id ASC LIMIT 2
        `).all(input.id, confirmationRevision);
        if (matches.length !== 1) return { kind: "conflict", current };
        const job = this.#owner.decodeVideoJobRow(matches[0]!);
        if (!job || job.state !== "outcome_unknown") throw this.#owner.error("The media journal contains a malformed job.");
        if (step.videoJobId !== undefined && step.videoJobId !== job.id) return { kind: "conflict", current };
        const changed = this.#owner.database.query(`
          UPDATE video_jobs SET state = 'acknowledged', revision = revision + 1, updated_at = MAX(updated_at, ?)
           WHERE id = ? AND revision = ? AND state = 'outcome_unknown'
             AND probe_operation_id = ? AND confirmation_revision = ?
        `).run(now, job.id, job.revision, input.id, confirmationRevision);
        if (changed.changes !== 1) throw this.#owner.error("The capability probe video acknowledgement changed concurrently.");
        if (!this.#owner.sealVideoJob(job.id)) {
          throw this.#owner.error("The capability probe video acknowledgement could not be sealed.");
        }
      }
      const stepChanged = this.#owner.database.query(`
        UPDATE capability_probe_steps SET state = 'acknowledged', revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE operation_id = ? AND step_kind = ? AND revision = ? AND state = 'outcome_unknown'
      `).run(now, input.id, input.step, step.revision);
      if (stepChanged.changes !== 1) throw this.#owner.error("The capability probe step acknowledgement changed concurrently.");
      const probeChanged = this.#owner.database.query(`
        UPDATE capability_probes SET revision = revision + 1, updated_at = MAX(updated_at, ?) WHERE id = ? AND revision = ?
      `).run(now, input.id, input.expectedRevision);
      if (probeChanged.changes !== 1) throw this.#owner.error("The capability probe acknowledgement changed concurrently.");
      const updated = this.#get(input.id);
      if (!updated) throw this.#owner.error("The acknowledged capability probe is unavailable.");
      return { kind: "updated", probe: updated };
    });
  }

  recordInspection(input: { id: string; step: CapabilityProbeStepKind; expectedRevision: number }):
    { kind: "updated"; probe: CapabilityProbeRecord; deletion: CapabilityArtifactDeletion }
    | { kind: "conflict"; current: CapabilityProbeRecord | null } {
    return this.#owner.transaction(() => {
      const current = this.#get(input.id);
      if (!current || current.revision !== input.expectedRevision) return { kind: "conflict", current };
      const step = current.steps[input.step];
      if (step.state !== "completed" || !step.artifactId) return { kind: "conflict", current };
      const now = this.#owner.now();
      const stepChanged = this.#owner.database.query(`
        UPDATE capability_probe_steps SET inspected_at = ?, revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE operation_id = ? AND step_kind = ? AND revision = ? AND state = 'completed'
      `).run(now, now, input.id, input.step, step.revision);
      if (stepChanged.changes !== 1) throw this.#owner.error("The media inspection record changed concurrently.");
      const probeChanged = this.#owner.database.query(`
        UPDATE capability_probes SET revision = revision + 1, updated_at = MAX(updated_at, ?) WHERE id = ? AND revision = ?
      `).run(now, input.id, input.expectedRevision);
      if (probeChanged.changes !== 1) throw this.#owner.error("The media inspection operation changed concurrently.");
      const updated = this.#get(input.id);
      return updated ? {
        kind: "updated", probe: updated,
        deletion: { operationId: input.id, step: input.step, stepRevision: updated.steps[input.step].revision, artifactId: step.artifactId },
      } : { kind: "conflict", current: null };
    });
  }

  listPendingArtifactDeletions(now = this.#owner.now()): CapabilityArtifactDeletion[] {
    if (!validInteger(now, 1)) throw this.#owner.error("The capability artifact retention time is invalid.");
    this.#owner.assertOpen();
    const rows = this.#owner.database.query<{
      operation_id: string; step_kind: CapabilityProbeStepKind; revision: number; artifact_id: string;
    }, [number]>(`
      SELECT operation_id, step_kind, revision, artifact_id FROM capability_probe_steps
       WHERE artifact_id IS NOT NULL
         AND (inspected_at IS NOT NULL OR (artifact_expires_at IS NOT NULL AND artifact_expires_at <= ?))
       ORDER BY operation_id, step_kind LIMIT ${this.#owner.maxRows + 1}
    `).all(now);
    if (rows.length > this.#owner.maxRows) throw this.#owner.error("The media retention set is too large.");
    return rows.map(row => {
      if (!safeArtifactId(row.artifact_id)) throw this.#owner.error("The media journal contains an invalid artifact id.");
      return { operationId: row.operation_id, step: row.step_kind, stepRevision: row.revision, artifactId: row.artifact_id };
    });
  }

  completeArtifactDeletion(input: CapabilityArtifactDeletion): CapabilityProbeUpdate {
    if (!validText(input.operationId, 64) || !["image", "video"].includes(input.step)
      || !validInteger(input.stepRevision) || !safeArtifactId(input.artifactId)) {
      throw this.#owner.error("The capability artifact deletion is invalid.");
    }
    return this.#owner.transaction(() => {
      const current = this.#get(input.operationId);
      if (!current) return { kind: "conflict", current: null };
      const step = current.steps[input.step];
      const deletionDue = step.inspectedAt !== undefined
        || (step.artifactExpiresAt !== undefined && step.artifactExpiresAt <= this.#owner.now());
      if (step.revision !== input.stepRevision || step.artifactId !== input.artifactId || !deletionDue) {
        return { kind: "conflict", current };
      }
      const now = this.#owner.now();
      if (step.videoJobId) {
        const row = this.#owner.database.query<Record<string, unknown>, [string]>(
          "SELECT * FROM video_jobs WHERE id = ?",
        ).get(step.videoJobId);
        const job = this.#owner.decodeVideoJobRow(row);
        if (!job) return { kind: "conflict", current };
        if (job.state === "completed" && job.artifactId === input.artifactId) {
          const changed = this.#owner.database.query(`
            UPDATE video_jobs SET state = 'artifact_pruned', artifact_id = NULL, revision = revision + 1, updated_at = MAX(updated_at, ?)
             WHERE id = ? AND revision = ? AND state = 'completed' AND artifact_id = ?
          `).run(now, job.id, job.revision, input.artifactId);
          if (changed.changes !== 1) return { kind: "conflict", current };
          if (!this.#owner.sealVideoJob(job.id)) return { kind: "conflict", current };
        } else if (job.state === "artifact_pruned" && job.artifactId === input.artifactId) {
          const finalized = this.#owner.database.query(`
            UPDATE video_jobs SET artifact_id = NULL, revision = revision + 1, updated_at = MAX(updated_at, ?)
             WHERE id = ? AND revision = ? AND state = 'artifact_pruned' AND artifact_id = ?
          `).run(now, job.id, job.revision, input.artifactId);
          if (finalized.changes !== 1) return { kind: "conflict", current };
          if (!this.#owner.sealVideoJob(job.id)) return { kind: "conflict", current };
        } else if (job.state !== "artifact_pruned" || job.artifactId !== undefined) {
          return { kind: "conflict", current };
        }
      }
      const changed = this.#owner.database.query(`
        UPDATE capability_probe_steps SET artifact_id = NULL, artifact_expires_at = NULL, revision = revision + 1, updated_at = MAX(updated_at, ?)
         WHERE operation_id = ? AND step_kind = ? AND revision = ? AND artifact_id = ?
      `).run(now, input.operationId, input.step, input.stepRevision, input.artifactId);
      if (changed.changes !== 1) throw this.#owner.error("The media deletion record changed concurrently.");
      const probeChanged = this.#owner.database.query(`
        UPDATE capability_probes SET revision = revision + 1, updated_at = MAX(updated_at, ?) WHERE id = ? AND revision = ?
      `).run(now, input.operationId, current.revision);
      if (probeChanged.changes !== 1) throw this.#owner.error("The media deletion operation changed concurrently.");
      const updated = this.#get(input.operationId);
      return updated ? { kind: "updated", probe: updated } : { kind: "conflict", current: null };
    });
  }

  protectedArtifactIds(): string[] {
    this.#owner.assertOpen();
    const rows = this.#owner.database.query<{ artifact_id: unknown }, []>(`
      SELECT DISTINCT artifact_id FROM capability_probe_steps
       WHERE artifact_id IS NOT NULL LIMIT ${this.#owner.maxRows + 1}
    `).all();
    if (rows.length > this.#owner.maxRows) throw this.#owner.error("The media retention set is too large.");
    return rows.map(row => {
      if (typeof row.artifact_id !== "string" || !safeArtifactId(row.artifact_id)) {
        throw this.#owner.error("The media journal contains an invalid artifact id.");
      }
      return row.artifact_id;
    });
  }
}

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac, type Hmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import {
  openVideoJobStore,
  type VideoJobRecord,
  VIDEO_JOB_RECOVERY_RETENTION_MS,
} from "../../src/images/video-job-store";
import { videoOperationReplaySecretPathForJournal } from "../../src/images/video-operation-secret";
import type { MediaCredentialBinding } from "../../src/images/types";

const MAX_VIDEO_JOB_ROWS = 1_024;
const COMPACTION_NOW = VIDEO_JOB_RECOVERY_RETENTION_MS + 10_000;
const COMPACTION_DEADLINE = COMPACTION_NOW + 60_000;
const roots: string[] = [];
const binding: MediaCredentialBinding = {
  authSource: "subscription_oauth",
  providerKind: "canonical",
  slotRef: "media-slot:test-opaque",
  identityDigest: `sha256:${"a".repeat(64)}`,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ccx-media-store-"));
  roots.push(root);
  return { root, path: join(root, "private", "media-journal.sqlite") };
}

interface SeedVideoJob {
  state?: "queued" | "download_failed" | "outcome_unknown" | "completed" | "artifact_pruned" | "failed" | "expired" | "cancelled" | "acknowledged";
  artifactId?: string;
  probeOperationId?: string;
  operationKey?: string;
  requestSemanticsDigest?: string;
  updatedAt?: number;
}

function updateBindingWitnessString(hmac: Hmac, value: string): void {
  hmac.update("S");
  hmac.update(String(Buffer.byteLength(value)));
  hmac.update(":");
  hmac.update(value);
}

function updateBindingWitnessInteger(hmac: Hmac, value: number): void {
  hmac.update("I");
  hmac.update(String(value));
  hmac.update(";");
}

function updateBindingWitnessOptionalString(hmac: Hmac, value: string | undefined): void {
  if (value === undefined) hmac.update("N");
  else updateBindingWitnessString(hmac, value);
}

function updateBindingWitnessOptionalInteger(hmac: Hmac, value: number | undefined): void {
  if (value === undefined) hmac.update("N");
  else updateBindingWitnessInteger(hmac, value);
}

function bindingWitness(secret: Uint8Array, job: VideoJobRecord): Uint8Array {
  const hmac = createHmac("sha256", secret);
  hmac.update("codexcommander/video-job-integrity/v1");
  hmac.update("\0");
  updateBindingWitnessString(hmac, job.id);
  updateBindingWitnessInteger(hmac, job.revision);
  updateBindingWitnessString(hmac, job.state);
  updateBindingWitnessString(hmac, job.binding.authSource);
  updateBindingWitnessString(hmac, job.binding.providerKind);
  updateBindingWitnessString(hmac, job.binding.slotRef);
  updateBindingWitnessString(hmac, job.binding.identityDigest);
  updateBindingWitnessInteger(hmac, job.deadlineAt);
  updateBindingWitnessOptionalString(hmac, job.operationKey);
  updateBindingWitnessOptionalString(hmac, job.requestSemanticsDigest);
  updateBindingWitnessOptionalString(hmac, job.requestId);
  updateBindingWitnessOptionalString(hmac, job.artifactId);
  updateBindingWitnessOptionalString(hmac, job.safeError);
  updateBindingWitnessOptionalString(hmac, job.probeOperationId);
  updateBindingWitnessOptionalInteger(hmac, job.confirmationRevision);
  updateBindingWitnessInteger(hmac, job.createdAt);
  updateBindingWitnessInteger(hmac, job.updatedAt);
  return new Uint8Array(hmac.digest());
}

function jobSetWitness(
  secret: Uint8Array,
  rows: readonly { id: string; witness: Uint8Array }[],
): Uint8Array {
  const hmac = createHmac("sha256", secret);
  hmac.update("codexcommander/video-job-set-integrity/v1");
  hmac.update("\0");
  updateBindingWitnessInteger(hmac, rows.length);
  for (const row of [...rows].sort((left, right) => left.id.localeCompare(right.id))) {
    updateBindingWitnessString(hmac, row.id);
    hmac.update("B32:");
    hmac.update(row.witness);
  }
  return new Uint8Array(hmac.digest());
}

function seedFullVideoJobJournal(path: string, overrides: ReadonlyMap<number, SeedVideoJob> = new Map()): void {
  const secret = new Uint8Array(readFileSync(videoOperationReplaySecretPathForJournal(path)));
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  try {
    const setRows: Array<{ id: string; witness: Uint8Array }> = [];
    const insert = db.query(`
      INSERT INTO video_jobs (
        id, revision, state, auth_source, provider_kind, slot_ref, binding_digest, binding_witness,
        deadline_at, operation_key, request_semantics_digest, request_id, artifact_id, safe_error, probe_operation_id,
        confirmation_revision, created_at, updated_at
      ) VALUES (?,?,?,'subscription_oauth','canonical',?,?,?,100000,?,?,?,?,?,?,?,?,?)
    `);
    for (let index = 0; index < MAX_VIDEO_JOB_ROWS; index += 1) {
      const override = overrides.get(index);
      const state = override?.state ?? "cancelled";
      const revision = state === "queued" ? 0 : state === "cancelled" ? 1 : 2;
      const timestamp = index + 1;
      const id = `job-${String(index).padStart(4, "0")}`;
      const jobBinding: MediaCredentialBinding = {
        authSource: "subscription_oauth",
        providerKind: "canonical",
        slotRef: `media-slot:seed-${index}`,
        identityDigest: `sha256:${index.toString(16).padStart(64, "0")}`,
      };
      const requestId = ["download_failed", "completed", "artifact_pruned", "expired"].includes(state)
        ? `seed-request-${index}`
        : null;
      const safeError = state === "download_failed"
        ? "download_rejected"
        : state === "outcome_unknown" || state === "acknowledged"
          ? "ambiguous_submission"
          : state === "failed"
            ? "upstream_failed"
            : state === "expired"
              ? "timeout"
              : null;
      const updatedAt = override?.updatedAt ?? timestamp;
      const seededJob: VideoJobRecord = {
        id,
        revision,
        state,
        binding: jobBinding,
        deadlineAt: 100_000,
        ...(override?.operationKey ? { operationKey: override.operationKey } : {}),
        ...(override?.requestSemanticsDigest ? { requestSemanticsDigest: override.requestSemanticsDigest } : {}),
        ...(requestId ? { requestId } : {}),
        ...(override?.artifactId ? { artifactId: override.artifactId } : {}),
        ...(safeError ? { safeError } : {}),
        ...(override?.probeOperationId ? { probeOperationId: override.probeOperationId, confirmationRevision: 1 } : {}),
        createdAt: timestamp,
        updatedAt,
      };
      const witness = bindingWitness(secret, seededJob);
      insert.run(
        id,
        revision,
        state,
        jobBinding.slotRef,
        jobBinding.identityDigest,
        witness,
        override?.operationKey ?? null,
        override?.requestSemanticsDigest ?? null,
        requestId,
        override?.artifactId ?? null,
        safeError,
        override?.probeOperationId ?? null,
        override?.probeOperationId ? 1 : null,
        timestamp,
        updatedAt,
      );
      setRows.push({ id, witness });
    }
    db.query(`
      UPDATE video_job_set_witness SET row_count = ?, set_fingerprint = ? WHERE singleton = 1
    `).run(setRows.length, jobSetWitness(secret, setRows));
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* close below */ }
    throw error;
  } finally {
    db.close();
  }
}

function seedAcceptedProbeObligation(path: string, operationId: string, videoJobId: string | null): void {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  try {
    db.query(`
      INSERT INTO capability_probes (
        id, key_digest, revision, binding_digest, image_model, video_model,
        contract_revision, probe_version, confirmation_revision, confirmation_expires_at,
        created_at, updated_at
      ) VALUES (?, ?, 0, ?, 'grok-imagine-image', 'grok-imagine-video', 'test-contract', 1, NULL, NULL, 1, 1)
    `).run(operationId, `key-${operationId}`, `binding-${operationId}`);
    db.query(`
      INSERT INTO capability_probe_steps (
        operation_id, step_kind, revision, state, dispatch_certainty, safe_error,
        artifact_id, artifact_expires_at, video_job_id, confirmation_revision,
        verified_at, inspected_at, updated_at
      ) VALUES (?, 'image', 0, 'failed', 'definite_rejection', 'upstream_failed', NULL, NULL, NULL, NULL, NULL, NULL, 1)
    `).run(operationId);
    db.query(`
      INSERT INTO capability_probe_steps (
        operation_id, step_kind, revision, state, dispatch_certainty, safe_error,
        artifact_id, artifact_expires_at, video_job_id, confirmation_revision,
        verified_at, inspected_at, updated_at
      ) VALUES (?, 'video', 0, 'accepted', 'accepted', NULL, NULL, NULL, ?, NULL, NULL, NULL, 1)
    `).run(operationId, videoJobId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* close below */ }
    throw error;
  } finally {
    db.close();
  }
}

function alternateBinding(seed: string): MediaCredentialBinding {
  return {
    ...binding,
    slotRef: `media-slot:test-${seed}`,
    identityDigest: `sha256:${seed.repeat(64)}`,
  };
}

function beginCapabilityVideoSubmission(store: ReturnType<typeof openVideoJobStore>, confirmationRevision = 1) {
  const prepared = store.getOrCreateCapabilityProbe({
    keyDigest: `probe-key-${confirmationRevision}`,
    bindingDigest: binding.identityDigest,
    imageModel: "grok-imagine-image",
    videoModel: "grok-imagine-video",
    contractRevision: "test-contract",
    probeVersion: 1,
  }).probe;
  const authorized = store.authorizeCapabilityProbe({
    id: prepared.id,
    expectedRevision: prepared.revision,
    confirmationRevision,
    expiresAt: 61_000,
  });
  if (authorized.kind !== "updated") throw new Error("expected probe authorization");
  const begunImage = store.beginCapabilityProbeStep({
    id: prepared.id,
    step: "image",
    expectedRevision: authorized.probe.revision,
    confirmationRevision,
  });
  if (begunImage.kind !== "updated") throw new Error("expected image submission");
  const settledImage = store.settleCapabilityProbeStep({
    id: prepared.id,
    step: "image",
    expectedStepRevision: begunImage.probe.steps.image.revision,
    state: "failed",
    dispatchCertainty: "definite_rejection",
    safeError: "upstream_failed",
  });
  if (settledImage.kind !== "updated") throw new Error("expected image settlement");
  const begunVideo = store.beginCapabilityProbeStep({
    id: prepared.id,
    step: "video",
    expectedRevision: settledImage.probe.revision,
    confirmationRevision,
  });
  if (begunVideo.kind !== "updated") throw new Error("expected video submission");
  return begunVideo.probe;
}

function createOutcomeUnknownVideoJob(
  store: ReturnType<typeof openVideoJobStore>,
  jobBinding: MediaCredentialBinding,
  probeOperationId: string,
  confirmationRevision: number,
) {
  const reserved = store.reserveVideoJob({
    binding: jobBinding,
    deadlineAt: 61_000,
    probeOperationId,
    confirmationRevision,
  });
  if (reserved.kind !== "created") throw new Error("expected video reservation");
  const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
  if (fenced.kind !== "updated") throw new Error("expected video submission fence");
  const unknown = store.transitionVideoJob({
    id: fenced.job.id,
    expectedRevision: fenced.job.revision,
    from: ["submitting"],
    to: "outcome_unknown",
    safeError: "ambiguous_submission",
  });
  if (unknown.kind !== "updated") throw new Error("expected unknown video outcome");
  return unknown.job;
}

describe("video job journal", () => {
  test("is owner-only, versioned, synchronous FULL, prompt-free, and revision-CAS guarded", async () => {
    const f = await fixture();
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const reserved = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
    expect(reserved.kind).toBe("created");
    if (reserved.kind !== "created") throw new Error("expected reservation");
    expect(reserved.job.state).toBe("queued");

    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    expect(fenced.kind).toBe("updated");
    if (fenced.kind !== "updated") throw new Error("expected fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "upstream-private-id");
    expect(accepted.kind).toBe("updated");
    if (accepted.kind !== "updated") throw new Error("expected accepted commit");
    expect(accepted.job.state).toBe("accepted");

    const stale = store.transitionVideoJob({
      id: accepted.job.id,
      expectedRevision: fenced.job.revision,
      from: ["accepted"],
      to: "polling",
    });
    expect(stale.kind).toBe("conflict");
    expect(store.publicVideoJob(accepted.job.id)).not.toHaveProperty("requestId");
    expect(store.publicVideoJob(accepted.job.id)).not.toHaveProperty("binding");
    store.close();

    if (process.platform !== "win32") {
      expect((await stat(f.path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(f.root, "private"))).mode & 0o777).toBe(0o700);
    }
    const db = new Database(f.path, { readonly: true });
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(2);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(video_jobs)").all().map(row => row.name);
    expect(columns).not.toContain("prompt");
    expect(columns).not.toContain("url");
    expect(columns).not.toContain("provider_body");
    db.close();
  });

  test("fails a v1 journal closed instead of mutating its state constraint in place", async () => {
    const f = await fixture();
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    store.close();
    const db = new Database(f.path);
    db.exec("PRAGMA user_version = 1");
    db.close();
    expect(() => openVideoJobStore({ path: f.path, now: () => 2_000 }))
      .toThrow("schema version is unsupported");
  });

  test("rebuilds an empty exact legacy v2 video table into the canonical integrity schema", async () => {
    const f = await fixture();
    const initialized = openVideoJobStore({ path: f.path, now: () => 1_000 });
    initialized.close();
    const legacy = new Database(f.path);
    // Rebuild the empty table in the exact pre-operation-key v2 shape. Retained
    // legacy rows cannot safely acquire a retrospective private binding witness.
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE video_jobs;
      CREATE TABLE video_jobs (
        id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        state TEXT NOT NULL,
        auth_source TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        slot_ref TEXT NOT NULL CHECK(length(slot_ref) BETWEEN 1 AND 256),
        binding_digest TEXT NOT NULL CHECK(length(binding_digest) BETWEEN 1 AND 128),
        deadline_at INTEGER NOT NULL CHECK(deadline_at > 0),
        request_id TEXT,
        artifact_id TEXT,
        safe_error TEXT,
        probe_operation_id TEXT,
        confirmation_revision INTEGER,
        created_at INTEGER NOT NULL CHECK(created_at > 0),
        updated_at INTEGER NOT NULL CHECK(updated_at > 0)
      ) STRICT;
      CREATE UNIQUE INDEX video_jobs_one_active_binding
        ON video_jobs(binding_digest)
       WHERE state IN ('queued','submitting','accepted','polling','needs_auth','downloading','download_failed','outcome_unknown');
    `);
    expect(legacy.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    legacy.close();

    const migrated = openVideoJobStore({ path: f.path, now: () => 2_000 });
    expect(migrated.reserveVideoJob({
      binding,
      deadlineAt: 62_000,
      operationKey: `sha256:${"5".repeat(64)}`,
      requestSemanticsDigest: `sha256:${"6".repeat(64)}`,
    }).kind).toBe("created");
    migrated.close();
    const proof = new Database(f.path, { readonly: true });
    expect(proof.query<{ name: string }, []>("PRAGMA table_info(video_jobs)").all().map(row => row.name))
      .toEqual(expect.arrayContaining(["operation_key", "request_semantics_digest"]));
    proof.close();
  });

  test("rejects a drifted active-binding index before recovery or admission", async () => {
    const f = await fixture();
    const initialized = openVideoJobStore({ path: f.path, now: () => 1_000 });
    initialized.close();
    const altered = new Database(f.path);
    altered.exec(`
      DROP INDEX video_jobs_one_active_binding;
      CREATE UNIQUE INDEX video_jobs_one_active_binding
        ON video_jobs(binding_digest)
       WHERE state = 'queued';
    `);
    altered.close();

    expect(() => openVideoJobStore({ path: f.path, now: () => 2_000 }))
      .toThrow("binding index is malformed");
  });

  test("startup converts a leftover submitting fence to outcome_unknown and holds admission until CAS acknowledgement", async () => {
    const f = await fixture();
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const reserved = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
    if (reserved.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");
    store.close();

    store = openVideoJobStore({ path: f.path, now: () => 2_000 });
    const recovered = store.recoverStartup();
    expect(recovered.outcomeUnknown).toEqual([reserved.job.id]);
    const unknown = store.getVideoJob(reserved.job.id);
    expect(unknown?.state).toBe("outcome_unknown");
    const blocked = store.reserveVideoJob({ binding, deadlineAt: 62_000 });
    expect(blocked.kind).toBe("busy");

    const stale = store.acknowledgeVideoOutcomeUnknown(reserved.job.id, fenced.job.revision);
    expect(stale.kind).toBe("conflict");
    const acknowledged = store.acknowledgeVideoOutcomeUnknown(reserved.job.id, unknown!.revision);
    expect(acknowledged.kind).toBe("updated");
    const next = store.reserveVideoJob({ binding, deadlineAt: 62_000 });
    expect(next.kind).toBe("created");
    store.close();
  });

  test("startup recovery never regresses durable timestamps when the wall clock moves backward", async () => {
    const f = await fixture();
    let store = openVideoJobStore({ path: f.path, now: () => 10_000 });
    const reserved = store.reserveVideoJob({ binding, deadlineAt: 70_000 });
    if (reserved.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected submission fence");
    store.close();

    store = openVideoJobStore({ path: f.path, now: () => 5_000 });
    expect(store.recoverStartup().outcomeUnknown).toEqual([reserved.job.id]);
    expect(store.getVideoJob(reserved.job.id)).toMatchObject({
      state: "outcome_unknown",
      createdAt: 10_000,
      updatedAt: 10_000,
    });
    store.close();
  });

  test("ordinary video mutations retain each row's durable timestamp across wall-clock rollback", async () => {
    const f = await fixture();
    let now = 10_000;
    const store = openVideoJobStore({ path: f.path, now: () => now });
    const reserved = store.reserveVideoJob({ binding, deadlineAt: 100_000 });
    if (reserved.kind !== "created") throw new Error("expected reservation");

    now = 20_000;
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected submission fence");
    expect(fenced.job.updatedAt).toBe(20_000);

    now = 15_000;
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "rollback-clock-request");
    if (accepted.kind !== "updated") throw new Error("expected accepted job");
    expect(accepted.job.updatedAt).toBe(20_000);

    now = 12_000;
    const polling = store.transitionVideoJob({
      id: accepted.job.id,
      expectedRevision: accepted.job.revision,
      from: ["accepted"],
      to: "polling",
    });
    expect(polling.kind).toBe("updated");
    expect(polling.kind === "updated" ? polling.job.updatedAt : undefined).toBe(20_000);
    store.close();
  });

  test("replays active and recently completed matching operations without a new reservation", async () => {
    const f = await fixture();
    let now = 1_000;
    const store = openVideoJobStore({ path: f.path, now: () => now });
    const operationKey = `sha256:${"d".repeat(64)}`;
    const requestSemanticsDigest = `sha256:${"e".repeat(64)}`;
    const first = store.reserveVideoJob({ binding, deadlineAt: 61_000, operationKey, requestSemanticsDigest });
    if (first.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(first.job.id, first.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");
    expect(store.reserveVideoJob({ binding, deadlineAt: 61_000, operationKey, requestSemanticsDigest }))
      .toEqual({ kind: "replay", job: fenced.job });

    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "accepted-id");
    if (accepted.kind !== "updated") throw new Error("expected accepted");
    const polling = store.transitionVideoJob({ id: accepted.job.id, expectedRevision: accepted.job.revision, from: ["accepted"], to: "polling" });
    if (polling.kind !== "updated") throw new Error("expected polling");
    const downloading = store.reserveVideoArtifact(polling.job.id, polling.job.revision, "vid-replay.mp4");
    if (downloading.kind !== "updated") throw new Error("expected downloading");
    const completed = store.completeVideoArtifact(downloading.job.id, downloading.job.revision, "vid-replay.mp4");
    if (completed.kind !== "updated") throw new Error("expected completion");
    now += 1;
    expect(store.reserveVideoJob({ binding, deadlineAt: 61_000, operationKey, requestSemanticsDigest }))
      .toEqual({ kind: "replay", job: completed.job });
    expect(store.listVideoJobs()).toHaveLength(1);
    store.close();
  });

  test("atomically releases retry identity after definite pre-dispatch authentication failure", async () => {
    const f = await fixture();
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const operationKey = `sha256:${"7".repeat(64)}`;
    const requestSemanticsDigest = `sha256:${"8".repeat(64)}`;
    const first = store.reserveVideoJob({ binding, deadlineAt: 61_000, operationKey, requestSemanticsDigest });
    if (first.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(first.job.id, first.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");

    const released = store.failVideoSubmissionNeedsAuth(fenced.job.id, fenced.job.revision);
    if (released.kind !== "updated") throw new Error("expected released failure");
    expect(released.job).toMatchObject({ state: "failed", safeError: "needs_auth" });
    expect(released.job).not.toHaveProperty("operationKey");
    expect(released.job).not.toHaveProperty("requestSemanticsDigest");
    expect(released.job).not.toHaveProperty("requestId");

    const retried = store.reserveVideoJob({ binding, deadlineAt: 61_000, operationKey, requestSemanticsDigest });
    expect(retried.kind).toBe("created");
    expect(retried.kind === "created" ? retried.job.id : undefined).not.toBe(first.job.id);
    store.close();
  });

  test("refuses operation-key binding and semantic collisions without dispatch admission", async () => {
    const f = await fixture();
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const operationKey = `sha256:${"f".repeat(64)}`;
    const requestSemanticsDigest = `sha256:${"1".repeat(64)}`;
    const first = store.reserveVideoJob({ binding, deadlineAt: 61_000, operationKey, requestSemanticsDigest });
    if (first.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(first.job.id, first.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");

    expect(store.reserveVideoJob({
      binding: alternateBinding("b"), deadlineAt: 61_000, operationKey, requestSemanticsDigest,
    })).toEqual({ kind: "busy", reservationId: first.job.id });
    expect(store.reserveVideoJob({
      binding, deadlineAt: 61_000, operationKey, requestSemanticsDigest: `sha256:${"2".repeat(64)}`,
    })).toEqual({ kind: "busy", reservationId: first.job.id });
    expect(store.listVideoJobs()).toHaveLength(1);
    store.close();
  });

  test("preserves legacy no-identity admission without inventing body-based deduplication", async () => {
    const f = await fixture();
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const first = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
    if (first.kind !== "created") throw new Error("expected reservation");
    const cancelled = store.transitionVideoJob({
      id: first.job.id, expectedRevision: first.job.revision, from: ["queued"], to: "cancelled",
    });
    expect(cancelled.kind).toBe("updated");
    const second = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
    expect(second.kind).toBe("created");
    expect(store.listVideoJobs()).toHaveLength(2);
    store.close();
  });

  test("restart operation-only probe acknowledgement atomically releases its matching video job", async () => {
    const f = await fixture();
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const probe = beginCapabilityVideoSubmission(store);
    const reserved = store.reserveVideoJob({
      binding,
      deadlineAt: 61_000,
      probeOperationId: probe.id,
      confirmationRevision: 1,
    });
    if (reserved.kind !== "created") throw new Error("expected video reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected video submission fence");
    store.close();

    store = openVideoJobStore({ path: f.path, now: () => 2_000 });
    expect(store.recoverStartup()).toMatchObject({ outcomeUnknown: [reserved.job.id] });
    const recoveredProbe = store.getCapabilityProbe(probe.id);
    expect(recoveredProbe?.steps.video).toMatchObject({
      state: "outcome_unknown",
      confirmationRevision: 1,
    });
    expect(recoveredProbe?.steps.video).not.toHaveProperty("videoJobId");
    expect(store.getVideoJob(reserved.job.id)).toMatchObject({
      state: "outcome_unknown",
      probeOperationId: probe.id,
      confirmationRevision: 1,
    });
    expect(store.reserveVideoJob({ binding, deadlineAt: 62_000 })).toEqual({
      kind: "busy",
      reservationId: reserved.job.id,
    });

    const acknowledged = store.acknowledgeCapabilityProbeStep({
      id: probe.id,
      step: "video",
      expectedRevision: recoveredProbe!.revision,
    });
    expect(acknowledged.kind).toBe("updated");
    if (acknowledged.kind !== "updated") throw new Error("expected probe acknowledgement");
    expect(acknowledged.probe.steps.video.state).toBe("acknowledged");
    expect(store.getVideoJob(reserved.job.id)?.state).toBe("acknowledged");
    expect(store.reserveVideoJob({ binding, deadlineAt: 62_000 }).kind).toBe("created");
    store.close();
  });

  test("probe acknowledgement decodes the full linked video row before either aggregate mutates", async () => {
    const f = await fixture();
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const probe = beginCapabilityVideoSubmission(store);
    const job = createOutcomeUnknownVideoJob(store, binding, probe.id, 1);
    const settled = store.settleCapabilityProbeStep({
      id: probe.id,
      step: "video",
      expectedStepRevision: probe.steps.video.revision,
      state: "outcome_unknown",
      dispatchCertainty: "outcome_unknown",
      safeError: "ambiguous_submission",
      videoJobId: job.id,
    });
    if (settled.kind !== "updated") throw new Error("expected unknown probe outcome");
    const corrupt = new Database(f.path);
    corrupt.exec("PRAGMA ignore_check_constraints = ON");
    corrupt.query(`
      UPDATE video_jobs SET slot_ref = '' WHERE id = ?
    `).run(job.id);
    corrupt.close();

    expect(() => store.acknowledgeCapabilityProbeStep({
      id: probe.id,
      step: "video",
      expectedRevision: settled.probe.revision,
    })).toThrow("media journal contains a malformed job");
    expect(store.getCapabilityProbe(probe.id)?.steps.video.state).toBe("outcome_unknown");
    store.close();

    const verified = new Database(f.path, { readonly: true });
    expect(verified.query<{ state: string }, [string]>("SELECT state FROM video_jobs WHERE id = ?").get(job.id)?.state)
      .toBe("outcome_unknown");
    expect(verified.query<{ state: string }, [string, string]>(
      "SELECT state FROM capability_probe_steps WHERE operation_id = ? AND step_kind = ?",
    ).get(probe.id, "video")?.state).toBe("outcome_unknown");
    verified.close();
  });

  test("probe artifact deletion decodes the full linked video row before either aggregate mutates", async () => {
    const f = await fixture();
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const probe = beginCapabilityVideoSubmission(store);
    const reserved = store.reserveVideoJob({
      binding,
      deadlineAt: 61_000,
      probeOperationId: probe.id,
      confirmationRevision: 1,
    });
    if (reserved.kind !== "created") throw new Error("expected video reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected submission fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "private-deletion-request");
    if (accepted.kind !== "updated") throw new Error("expected accepted job");
    const polling = store.transitionVideoJob({
      id: accepted.job.id,
      expectedRevision: accepted.job.revision,
      from: ["accepted"],
      to: "polling",
    });
    if (polling.kind !== "updated") throw new Error("expected polling job");
    const downloading = store.reserveVideoArtifact(polling.job.id, polling.job.revision, "vid-malformed-linked.mp4");
    if (downloading.kind !== "updated") throw new Error("expected downloading job");
    const completed = store.completeVideoArtifact(
      downloading.job.id,
      downloading.job.revision,
      "vid-malformed-linked.mp4",
    );
    if (completed.kind !== "updated") throw new Error("expected completed job");
    const settled = store.settleCapabilityProbeStep({
      id: probe.id,
      step: "video",
      expectedStepRevision: probe.steps.video.revision,
      state: "completed",
      dispatchCertainty: "completed",
      artifactId: "vid-malformed-linked.mp4",
      artifactExpiresAt: 20_000,
      videoJobId: completed.job.id,
      verifiedAt: 10_000,
    });
    if (settled.kind !== "updated") throw new Error("expected completed probe outcome");
    const inspected = store.recordCapabilityProbeInspection({
      id: probe.id,
      step: "video",
      expectedRevision: settled.probe.revision,
    });
    if (inspected.kind !== "updated") throw new Error("expected inspection record");
    const corrupt = new Database(f.path);
    corrupt.exec("PRAGMA ignore_check_constraints = ON");
    corrupt.query(`
      UPDATE video_jobs SET slot_ref = '' WHERE id = ?
    `).run(completed.job.id);
    corrupt.close();

    expect(() => store.completeCapabilityArtifactDeletion(inspected.deletion))
      .toThrow("media journal contains a malformed job");
    expect(store.getCapabilityProbe(probe.id)?.steps.video.artifactId).toBe("vid-malformed-linked.mp4");
    store.close();

    const verified = new Database(f.path, { readonly: true });
    expect(verified.query<{ state: string; artifact_id: string | null }, [string]>(
      "SELECT state, artifact_id FROM video_jobs WHERE id = ?",
    ).get(completed.job.id)).toEqual({ state: "completed", artifact_id: "vid-malformed-linked.mp4" });
    expect(verified.query<{ artifact_id: string | null }, [string, string]>(
      "SELECT artifact_id FROM capability_probe_steps WHERE operation_id = ? AND step_kind = ?",
    ).get(probe.id, "video")?.artifact_id).toBe("vid-malformed-linked.mp4");
    verified.close();
  });

  test.each([
    ["operation", "different-operation", 1],
    ["confirmation", null, 2],
  ] as const)("rejects a direct video-job id with a mismatched %s", async (_kind, operationOverride, jobConfirmation) => {
    const f = await fixture();
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const probe = beginCapabilityVideoSubmission(store);
    const job = createOutcomeUnknownVideoJob(
      store,
      alternateBinding("b"),
      operationOverride ?? probe.id,
      jobConfirmation,
    );
    const settled = store.settleCapabilityProbeStep({
      id: probe.id,
      step: "video",
      expectedStepRevision: probe.steps.video.revision,
      state: "outcome_unknown",
      dispatchCertainty: "outcome_unknown",
      safeError: "ambiguous_submission",
      videoJobId: job.id,
    });
    if (settled.kind !== "updated") throw new Error("expected unknown probe outcome");

    const acknowledged = store.acknowledgeCapabilityProbeStep({
      id: probe.id,
      step: "video",
      expectedRevision: settled.probe.revision,
    });
    expect(acknowledged.kind).toBe("conflict");
    expect(store.getCapabilityProbe(probe.id)?.steps.video.state).toBe("outcome_unknown");
    expect(store.getVideoJob(job.id)?.state).toBe("outcome_unknown");
    store.close();
  });

  test("rejects an ambiguous operation-only probe acknowledgement without partial updates", async () => {
    const f = await fixture();
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const probe = beginCapabilityVideoSubmission(store);
    const first = createOutcomeUnknownVideoJob(store, alternateBinding("b"), probe.id, 1);
    const second = createOutcomeUnknownVideoJob(store, alternateBinding("c"), probe.id, 1);
    const settled = store.settleCapabilityProbeStep({
      id: probe.id,
      step: "video",
      expectedStepRevision: probe.steps.video.revision,
      state: "outcome_unknown",
      dispatchCertainty: "outcome_unknown",
      safeError: "ambiguous_submission",
    });
    if (settled.kind !== "updated") throw new Error("expected unknown probe outcome");
    expect(settled.probe.steps.video).not.toHaveProperty("videoJobId");

    const acknowledged = store.acknowledgeCapabilityProbeStep({
      id: probe.id,
      step: "video",
      expectedRevision: settled.probe.revision,
    });
    expect(acknowledged.kind).toBe("conflict");
    expect(store.getCapabilityProbe(probe.id)?.steps.video.state).toBe("outcome_unknown");
    expect(store.getVideoJob(first.id)?.state).toBe("outcome_unknown");
    expect(store.getVideoJob(second.id)?.state).toBe("outcome_unknown");
    store.close();
  });

  test("rejects a concurrent recovery owner and admits the same path after close", async () => {
    const f = await fixture();
    const first = openVideoJobStore({ path: f.path, now: () => 1_000 });
    expect(() => openVideoJobStore({ path: f.path, now: () => 1_000 })).toThrow("media journal is busy");
    first.close();
    const successor = openVideoJobStore({ path: f.path, now: () => 2_000 });
    successor.close();
  });

  test("rejects an overlapping recovery owner in another process", async () => {
    const f = await fixture();
    const first = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../../src/images/video-job-store.ts")).href;
    const script = `
      import { openVideoJobStore } from ${JSON.stringify(moduleUrl)};
      try {
        const store = openVideoJobStore({ path: ${JSON.stringify(f.path)} });
        store.close();
        process.stdout.write("opened");
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : String(error));
      }
    `;
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const output = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    expect(output).toContain("media journal is busy");
    first.close();
  });

  test("recovers capacity by evicting the oldest obligation-free terminal job", async () => {
    const f = await fixture();
    const initialized = openVideoJobStore({ path: f.path, now: () => 2_000 });
    initialized.close();
    seedFullVideoJobJournal(f.path);

    const store = openVideoJobStore({ path: f.path, now: () => COMPACTION_NOW });
    const reserved = store.reserveVideoJob({ binding, deadlineAt: COMPACTION_DEADLINE });
    expect(reserved.kind).toBe("created");
    expect(store.listVideoJobs()).toHaveLength(MAX_VIDEO_JOB_ROWS);
    expect(store.getVideoJob("job-0000")).toBeNull();
    expect(store.getVideoJob("job-0001")?.state).toBe("cancelled");
    store.close();
  });

  test("capacity eviction retains active, unknown-outcome, artifact, and operation-only probe obligations", async () => {
    const f = await fixture();
    const initialized = openVideoJobStore({ path: f.path, now: () => 2_000 });
    initialized.close();
    const probeOperationId = "probe-obligation";
    seedFullVideoJobJournal(f.path, new Map([
      [0, { state: "queued" }],
      [1, { state: "download_failed" }],
      [2, { state: "outcome_unknown" }],
      [3, { state: "completed", artifactId: "live-video.mp4" }],
      [4, { state: "artifact_pruned", artifactId: "pending-delete.mp4" }],
      [5, { state: "failed", probeOperationId }],
    ]));
    seedAcceptedProbeObligation(f.path, probeOperationId, null);

    const proof = new Database(f.path, { readonly: true });
    expect(proof.query<{ video_job_id: string | null }, []>(`
      SELECT video_job_id FROM capability_probe_steps
       WHERE operation_id = 'probe-obligation' AND step_kind = 'video'
    `).get()?.video_job_id).toBeNull();
    proof.close();

    const store = openVideoJobStore({ path: f.path, now: () => COMPACTION_NOW });
    expect(store.reserveVideoJob({ binding, deadlineAt: COMPACTION_DEADLINE }).kind).toBe("created");
    for (let index = 0; index <= 5; index += 1) {
      expect(store.getVideoJob(`job-${String(index).padStart(4, "0")}`)).not.toBeNull();
    }
    expect(store.getVideoJob("job-0006")).toBeNull();
    store.close();
  });

  test("retains a freshly disclosed failed id until the bounded recovery obligation expires", async () => {
    const f = await fixture();
    let now = COMPACTION_NOW;
    const initialized = openVideoJobStore({ path: f.path, now: () => now });
    initialized.close();
    seedFullVideoJobJournal(f.path, new Map(
      Array.from({ length: MAX_VIDEO_JOB_ROWS }, (_, index) => [
        index,
        index === 0
          ? { state: "failed" as const, updatedAt: now }
          : index === 1
            ? { state: "cancelled" as const }
            : { state: "completed" as const, artifactId: `recovery-pin-${index}.mp4` },
      ]),
    ));

    const store = openVideoJobStore({ path: f.path, now: () => now });
    const first = store.reserveVideoJob({ binding, deadlineAt: now + 60_000 });
    expect(first.kind).toBe("created");
    if (first.kind !== "created") throw new Error("expected first admission");
    expect(store.getVideoJob("job-0000")).toMatchObject({ state: "failed", updatedAt: now });
    expect(store.getVideoJob("job-0001")).toBeNull();

    const released = store.transitionVideoJob({
      id: first.job.id,
      expectedRevision: first.job.revision,
      from: ["queued"],
      to: "cancelled",
      safeError: "cancelled",
    });
    expect(released.kind).toBe("updated");
    now += VIDEO_JOB_RECOVERY_RETENTION_MS - 1;
    expect(() => store.reserveVideoJob({ binding, deadlineAt: now + 60_000 }))
      .toThrow("row limit was exceeded");
    expect(store.getVideoJob("job-0000")).not.toBeNull();

    now += 1;
    expect(store.reserveVideoJob({ binding, deadlineAt: now + 60_000 }).kind).toBe("created");
    expect(store.getVideoJob("job-0000")).toBeNull();
    store.close();
  });

  test("rejects admission when every terminal row has a fresh recovery obligation", async () => {
    const f = await fixture();
    const initialized = openVideoJobStore({ path: f.path, now: () => COMPACTION_NOW });
    initialized.close();
    seedFullVideoJobJournal(f.path, new Map(
      Array.from({ length: MAX_VIDEO_JOB_ROWS }, (_, index) => [
        index,
        { state: "failed" as const, updatedAt: COMPACTION_NOW },
      ]),
    ));

    const store = openVideoJobStore({ path: f.path, now: () => COMPACTION_NOW });
    expect(() => store.reserveVideoJob({ binding, deadlineAt: COMPACTION_DEADLINE }))
      .toThrow("row limit was exceeded");
    expect(store.listVideoJobs()).toHaveLength(MAX_VIDEO_JOB_ROWS);
    expect(store.getVideoJob("job-0000")?.state).toBe("failed");
    expect(store.getVideoJob("job-1023")?.state).toBe("failed");
    store.close();
  });

  test("makes a freshly acknowledged outcome-unknown row immediately eligible for deterministic eviction", async () => {
    const f = await fixture();
    const initialized = openVideoJobStore({ path: f.path, now: () => COMPACTION_NOW });
    initialized.close();
    seedFullVideoJobJournal(f.path, new Map(
      Array.from({ length: MAX_VIDEO_JOB_ROWS }, (_, index) => [
        index,
        index === 0
          ? { state: "outcome_unknown" as const, updatedAt: COMPACTION_NOW }
          : { state: "failed" as const, updatedAt: COMPACTION_NOW },
      ]),
    ));

    const store = openVideoJobStore({ path: f.path, now: () => COMPACTION_NOW });
    const acknowledged = store.acknowledgeVideoOutcomeUnknown("job-0000", 2);
    expect(acknowledged.kind).toBe("updated");
    if (acknowledged.kind !== "updated") throw new Error("expected acknowledgement");
    expect(acknowledged.job.state).toBe("acknowledged");
    expect(store.reserveVideoJob({ binding, deadlineAt: COMPACTION_DEADLINE }).kind).toBe("created");
    expect(store.getVideoJob("job-0000")).toBeNull();
    expect(store.getVideoJob("job-0001")?.state).toBe("failed");
    store.close();
  });

  test("retains retry-key tombstones for the replay window and evicts them after expiry", async () => {
    const f = await fixture();
    let now = COMPACTION_NOW;
    const initialized = openVideoJobStore({ path: f.path, now: () => now });
    initialized.close();
    seedFullVideoJobJournal(f.path, new Map([
      [0, {
        state: "acknowledged",
        operationKey: `sha256:${"3".repeat(64)}`,
        requestSemanticsDigest: `sha256:${"4".repeat(64)}`,
        updatedAt: now,
      }],
    ]));

    const store = openVideoJobStore({ path: f.path, now: () => now });
    expect(store.reserveVideoJob({ binding, deadlineAt: COMPACTION_DEADLINE }).kind).toBe("created");
    expect(store.getVideoJob("job-0000")?.state).toBe("acknowledged");
    expect(store.getVideoJob("job-0001")).toBeNull();

    now += VIDEO_JOB_RECOVERY_RETENTION_MS + 1;
    expect(store.reserveVideoJob({
      binding: alternateBinding("b"), deadlineAt: now + 60_000,
    }).kind).toBe("created");
    expect(store.getVideoJob("job-0000")).toBeNull();
    store.close();
  });

  test("capacity rejection preserves a journal containing only protected terminal artifacts", async () => {
    const f = await fixture();
    const initialized = openVideoJobStore({ path: f.path, now: () => 2_000 });
    initialized.close();
    seedFullVideoJobJournal(f.path, new Map(
      Array.from({ length: MAX_VIDEO_JOB_ROWS }, (_, index) => [
        index,
        { state: "completed" as const, artifactId: `live-${index}.mp4` },
      ]),
    ));

    const store = openVideoJobStore({ path: f.path, now: () => 2_000 });
    expect(() => store.reserveVideoJob({ binding, deadlineAt: 100_000 }))
      .toThrow("row limit was exceeded");
    expect(store.listVideoJobs()).toHaveLength(MAX_VIDEO_JOB_ROWS);
    expect(store.getVideoJob("job-0000")?.artifactId).toBe("live-0.mp4");
    expect(store.getVideoJob("job-1023")?.artifactId).toBe("live-1023.mp4");
    store.close();
  });

  test("keeps an expired artifact private and durably pending until deletion is finalized", async () => {
    const f = await fixture();
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const reserved = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
    if (reserved.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "accepted-id");
    if (accepted.kind !== "updated") throw new Error("expected accepted");
    const polling = store.transitionVideoJob({
      id: accepted.job.id,
      expectedRevision: accepted.job.revision,
      from: ["accepted"],
      to: "polling",
    });
    if (polling.kind !== "updated") throw new Error("expected polling");
    const downloading = store.reserveVideoArtifact(
      polling.job.id,
      polling.job.revision,
      "vid-expired-private.mp4",
    );
    if (downloading.kind !== "updated") throw new Error("expected artifact reservation");
    expect(store.finalizeArtifactPrune("vid-expired-private.mp4")).toBe("protected");

    const expired = store.transitionVideoJob({
      id: downloading.job.id,
      expectedRevision: downloading.job.revision,
      from: ["downloading"],
      to: "expired",
      safeError: "timeout",
    });
    if (expired.kind !== "updated") throw new Error("expected expiry preparation");
    expect(expired.job).toMatchObject({ state: "expired", artifactId: "vid-expired-private.mp4" });
    expect(store.publicVideoJob(expired.job.id)).not.toHaveProperty("artifactId");
    expect(store.pendingArtifactDeletionIds()).toEqual(new Set(["vid-expired-private.mp4"]));
    store.close();

    store = openVideoJobStore({ path: f.path, now: () => 2_000 });
    expect(store.getVideoJob(expired.job.id)).toMatchObject({
      state: "expired",
      artifactId: "vid-expired-private.mp4",
    });
    expect(store.publicVideoJob(expired.job.id)).not.toHaveProperty("artifactId");
    expect(store.pendingArtifactDeletionIds()).toEqual(new Set(["vid-expired-private.mp4"]));
    expect(store.finalizeArtifactPrune("vid-expired-private.mp4")).toBe("finalized");
    expect(store.getVideoJob(expired.job.id)).toMatchObject({ state: "expired" });
    expect(store.getVideoJob(expired.job.id)).not.toHaveProperty("artifactId");
    expect(store.pendingArtifactDeletionIds()).toEqual(new Set());
    expect(store.finalizeArtifactPrune("vid-expired-private.mp4")).toBe("not_owned");
    store.close();
  });

  test.each(["accepted", "needs_auth", "download_failed"] as const)(
    "startup expires overdue %s work under its original absolute deadline",
    async state => {
      const f = await fixture();
      let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
      const reservation = store.reserveVideoJob({ binding, deadlineAt: 2_000 });
      if (reservation.kind !== "created") throw new Error("expected reservation");
      const fenced = store.fenceVideoSubmission(reservation.job.id, reservation.job.revision);
      if (fenced.kind !== "updated") throw new Error("expected fence");
      const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "accepted-id");
      if (accepted.kind !== "updated") throw new Error("expected accepted");
      let current = accepted.job;
      if (state !== "accepted") {
        const polling = store.transitionVideoJob({ id: current.id, expectedRevision: current.revision, from: ["accepted"], to: "polling" });
        if (polling.kind !== "updated") throw new Error("expected polling");
        current = polling.job;
        if (state !== "downloading") {
          const target = store.transitionVideoJob({
            id: current.id,
            expectedRevision: current.revision,
            from: ["polling"],
            to: state,
            safeError: state === "needs_auth" ? "needs_auth" : "download_rejected",
          });
          if (target.kind !== "updated") throw new Error("expected target state");
          current = target.job;
        } else {
          const downloading = store.reserveVideoArtifact(current.id, current.revision, "vid-overdue.mp4");
          if (downloading.kind !== "updated") throw new Error("expected downloading");
          current = downloading.job;
        }
      }
      store.close();

      store = openVideoJobStore({ path: f.path, now: () => 2_001 });
      const recovered = store.recoverStartup();
      expect(recovered.pollable).toEqual([]);
      expect(store.getVideoJob(reservation.job.id)).toMatchObject({ state: "expired", deadlineAt: 2_000, safeError: "timeout" });
      expect(store.reserveVideoJob({ binding, deadlineAt: 5_000 }).kind).toBe("created");
      store.close();
    },
  );

  test("startup preserves an overdue downloading artifact reservation for publication recovery", async () => {
    const f = await fixture();
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const reservation = store.reserveVideoJob({ binding, deadlineAt: 2_000 });
    if (reservation.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reservation.job.id, reservation.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "accepted-id");
    if (accepted.kind !== "updated") throw new Error("expected accepted");
    const polling = store.transitionVideoJob({
      id: accepted.job.id, expectedRevision: accepted.job.revision, from: ["accepted"], to: "polling",
    });
    if (polling.kind !== "updated") throw new Error("expected polling");
    const downloading = store.reserveVideoArtifact(polling.job.id, polling.job.revision, "vid-overdue.mp4");
    if (downloading.kind !== "updated") throw new Error("expected downloading");
    store.close();

    store = openVideoJobStore({ path: f.path, now: () => 2_001 });
    expect(store.recoverStartup().pollable).toEqual([reservation.job.id]);
    expect(store.getVideoJob(reservation.job.id)).toMatchObject({
      state: "download_failed",
      artifactId: "vid-overdue.mp4",
      safeError: "download_rejected",
      deadlineAt: 2_000,
    });
    expect(store.reserveVideoJob({ binding, deadlineAt: 5_000 })).toEqual({
      kind: "busy",
      reservationId: reservation.job.id,
    });
    store.close();
  });

  test.each(["queued", "submitting", "accepted", "polling", "needs_auth", "downloading", "download_failed", "outcome_unknown"] as const)(
    "holds one binding admission throughout %s",
    async targetState => {
      const f = await fixture();
      const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
      const reservation = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
      if (reservation.kind !== "created") throw new Error("expected reservation");
      let current = reservation.job;
      if (targetState !== "queued") {
        const fenced = store.fenceVideoSubmission(current.id, current.revision);
        if (fenced.kind !== "updated") throw new Error("expected fence");
        current = fenced.job;
      }
      if (!["queued", "submitting", "outcome_unknown"].includes(targetState)) {
        const accepted = store.commitVideoAccepted(current.id, current.revision, "accepted-id");
        if (accepted.kind !== "updated") throw new Error("expected accepted");
        current = accepted.job;
      }
      if (["polling", "needs_auth", "downloading", "download_failed"].includes(targetState)) {
        const polling = store.transitionVideoJob({ id: current.id, expectedRevision: current.revision, from: ["accepted"], to: "polling" });
        if (polling.kind !== "updated") throw new Error("expected polling");
        current = polling.job;
      }
      if (targetState === "needs_auth" || targetState === "downloading" || targetState === "download_failed") {
        const target = targetState === "downloading"
          ? store.reserveVideoArtifact(current.id, current.revision, "vid-binding-hold.mp4")
          : store.transitionVideoJob({
              id: current.id,
              expectedRevision: current.revision,
              from: ["polling"],
              to: targetState,
              ...(targetState === "needs_auth" ? { safeError: "needs_auth" as const } : {}),
              ...(targetState === "download_failed" ? { safeError: "download_rejected" as const } : {}),
            });
        if (target.kind !== "updated") throw new Error("expected target");
        current = target.job;
      } else if (targetState === "outcome_unknown") {
        const unknown = store.transitionVideoJob({
          id: current.id,
          expectedRevision: current.revision,
          from: ["submitting"],
          to: "outcome_unknown",
          safeError: "ambiguous_submission",
        });
        if (unknown.kind !== "updated") throw new Error("expected unknown");
        current = unknown.job;
      }
      expect(current.state).toBe(targetState);
      expect(store.reserveVideoJob({ binding, deadlineAt: 61_000 })).toEqual({
        kind: "busy",
        reservationId: current.id,
      });

      const released = targetState === "outcome_unknown"
        ? store.acknowledgeVideoOutcomeUnknown(current.id, current.revision)
        : targetState === "downloading"
          ? store.completeVideoArtifact(current.id, current.revision, "vid-binding-hold.mp4")
          : store.transitionVideoJob({
              id: current.id,
              expectedRevision: current.revision,
              from: [targetState],
              to: targetState === "queued" || targetState === "accepted" || targetState === "polling" || targetState === "needs_auth"
                ? "cancelled"
                : targetState === "submitting" ? "failed" : "expired",
              safeError: targetState === "submitting"
                ? "upstream_failed"
                : targetState === "download_failed"
                  ? "timeout"
                  : "cancelled",
            });
      expect(released.kind).toBe("updated");
      expect(store.reserveVideoJob({ binding, deadlineAt: 61_000 }).kind).toBe("created");
      store.close();
    },
  );
});

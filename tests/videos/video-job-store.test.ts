import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import {
  openVideoJobStore,
  VIDEO_JOB_RECOVERY_RETENTION_MS,
} from "../../src/images/video-job-store";
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
  updatedAt?: number;
}

function seedFullVideoJobJournal(path: string, overrides: ReadonlyMap<number, SeedVideoJob> = new Map()): void {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  try {
    const insert = db.query(`
      INSERT INTO video_jobs (
        id, revision, state, auth_source, provider_kind, slot_ref, binding_digest,
        deadline_at, request_id, artifact_id, safe_error, probe_operation_id,
        confirmation_revision, created_at, updated_at
      ) VALUES (?,0,?,'subscription_oauth','canonical',?,?,100000,NULL,?,NULL,?,NULL,?,?)
    `);
    for (let index = 0; index < MAX_VIDEO_JOB_ROWS; index += 1) {
      const override = overrides.get(index);
      const timestamp = index + 1;
      insert.run(
        `job-${String(index).padStart(4, "0")}`,
        override?.state ?? "cancelled",
        `media-slot:seed-${index}`,
        `sha256:${index.toString(16).padStart(64, "0")}`,
        override?.artifactId ?? null,
        override?.probeOperationId ?? null,
        timestamp,
        override?.updatedAt ?? timestamp,
      );
    }
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
    const acknowledged = store.acknowledgeVideoOutcomeUnknown("job-0000", 0);
    expect(acknowledged.kind).toBe("updated");
    if (acknowledged.kind !== "updated") throw new Error("expected acknowledgement");
    expect(acknowledged.job.state).toBe("acknowledged");
    expect(store.reserveVideoJob({ binding, deadlineAt: COMPACTION_DEADLINE }).kind).toBe("created");
    expect(store.getVideoJob("job-0000")).toBeNull();
    expect(store.getVideoJob("job-0001")?.state).toBe("failed");
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

  test.each(["accepted", "needs_auth", "downloading", "download_failed"] as const)(
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
          const downloading = store.transitionVideoJob({ id: current.id, expectedRevision: current.revision, from: ["polling"], to: "downloading" });
          if (downloading.kind !== "updated") throw new Error("expected downloading");
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
        const target = store.transitionVideoJob({
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
        : store.transitionVideoJob({
            id: current.id,
            expectedRevision: current.revision,
            from: [targetState],
            to: targetState === "downloading" ? "completed"
              : targetState === "queued" || targetState === "accepted" || targetState === "polling" || targetState === "needs_auth"
                ? "cancelled"
                : targetState === "submitting" ? "failed" : "expired",
            ...(targetState === "downloading" ? { artifactId: "vid-complete.mp4" } : {}),
          });
      expect(released.kind).toBe("updated");
      expect(store.reserveVideoJob({ binding, deadlineAt: 61_000 }).kind).toBe("created");
      store.close();
    },
  );
});

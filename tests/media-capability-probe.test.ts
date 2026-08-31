import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CapabilityProbeService,
  IMAGE_PROBE_MODEL,
  PROBE_ARTIFACT_RETENTION_MS,
  VIDEO_PROBE_MODEL,
  type CapabilityProbeGate,
  type CapabilityProbeStatus,
} from "../src/images/capability-probe";
import { MediaRuntime } from "../src/images/media-runtime";
import { mediaError } from "../src/images/media-errors";
import { getArtifactsDir, pruneArtifacts, type VideoArtifactDownloadOptions } from "../src/images/artifacts";
import { registerArtifactPinAuthority, unlinkMediaArtifactDurably } from "../src/images/artifact-retention";
import { openVideoJobStore } from "../src/images/video-job-store";
import type { MediaCredentialBinding } from "../src/images/types";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { resetLifecycleDrainStateForTests } from "../src/server/lifecycle";
import type { CodexCommanderConfig } from "../src/types";

const roots: string[] = [];
const binding: MediaCredentialBinding = {
  authSource: "subscription_oauth",
  providerKind: "canonical",
  slotRef: "media-slot:opaque-private-value",
  identityDigest: `sha256:${"c".repeat(64)}`,
};
const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ccx-capability-probe-"));
  roots.push(root);
  const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => 10_000 });
  return { root, store };
}

function gate(status: CapabilityProbeStatus, confirmationRevision: number): CapabilityProbeGate {
  return {
    caller: "interactive_cli",
    operationId: status.id,
    expectedRevision: status.revision,
    confirmationRevision,
    expiresAt: 20_000,
    runtimeAttested: true,
    humanConfirmed: true,
    targetedTestsPassed: true,
    privacyScanPassed: true,
    securityReviewApproved: true,
    apiKeyFallbackDisabled: true,
    billingAttribution: "unknown",
    ambiguousSubmissionRiskAccepted: true,
    nonReleaseEvidenceAccepted: true,
  };
}

async function waitForProbeVideo(
  probe: CapabilityProbeService,
  expected: CapabilityProbeStatus["steps"]["video"]["state"],
): Promise<CapabilityProbeStatus> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = probe.prepare(binding);
    if (current.steps.video.state === expected) return current;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`probe video did not reach ${expected}`);
}

describe("durable media capability probe", () => {
  test("missing or stale gate evidence performs zero paid POSTs", async () => {
    const f = await fixture();
    const image = mock(async () => ({ images: [{ url: "https://signed.invalid/private" }] }));
    const submit = mock(async () => ({ requestId: "private-id" }));
    const runtime = new MediaRuntime(f.store, { submitVideoJob: submit, now: () => 10_000 });
    const probe = new CapabilityProbeService(f.store, runtime, {
      now: () => 10_000,
      callImage: image,
      materializeImage: async () => "image.png",
    });
    const status = probe.prepare(binding);
    await expect(probe.run(binding)).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(probe.run(binding, { ...gate(status, 1), runtimeAttested: false })).rejects.toMatchObject({
      code: "runtime_attestation_required",
    });
    await expect(probe.run(binding, { ...gate(status, 1), humanConfirmed: false })).rejects.toMatchObject({
      code: "interactive_human_required",
    });
    await expect(probe.run(binding, {
      ...gate(status, 1),
      caller: "agent" as CapabilityProbeGate["caller"],
    })).rejects.toMatchObject({ code: "interactive_human_required" });
    await expect(probe.run(binding, { ...gate(status, 1), expectedRevision: status.revision + 1 })).rejects.toMatchObject({
      code: "stale_confirmation",
    });
    expect(image).toHaveBeenCalledTimes(0);
    expect(submit).toHaveBeenCalledTimes(0);
    expect(() => probe.prepare({ ...binding, authSource: "api_key" })).toThrow();
    f.store.close();
  });

  test("ambiguous image dispatch stops video and stays blocked until human acknowledgement", async () => {
    const f = await fixture();
    let imageAttempts = 0;
    const image = mock(async () => {
      imageAttempts += 1;
      if (imageAttempts === 1) throw new Error("simulated connection loss");
      return { images: [{ b64_json: "opaque-result" }] };
    });
    const submit = mock(async () => ({ requestId: "private-id" }));
    const runtime = new MediaRuntime(f.store, {
      now: () => 10_000,
      submitVideoJob: submit,
      pollVideoJob: async () => ({ status: "processing" }),
    });
    const probe = new CapabilityProbeService(f.store, runtime, {
      now: () => 10_000,
      callImage: image,
      materializeImage: async () => join(f.root, "img-probe.png"),
    });
    let status = await probe.run(binding, gate(probe.prepare(binding), 1));
    expect(status.steps.image.state).toBe("outcome_unknown");
    expect(status.steps.image.dispatchCertainty).toBe("outcome_unknown");
    expect(status.steps.video.state).toBe("pending");
    expect(submit).toHaveBeenCalledTimes(0);

    status = await probe.run(binding, gate(status, 2));
    expect(image).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(0);
    status = probe.acknowledge({
      caller: "interactive_cli",
      operationId: status.id,
      step: "image",
      expectedRevision: status.revision,
      runtimeAttested: true,
      humanConfirmed: true,
    });
    status = await probe.run(binding, gate(status, 3));
    expect(image).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
    f.store.close();
  });

  test("one confirmation runs fixed image and one-second 1080p video through the shared runtime", async () => {
    const f = await fixture();
    const image = mock(async () => ({ images: [{ b64_json: "opaque-result" }] }));
    const submit = mock(async () => ({ requestId: "private-id" }));
    const poll = mock(async () => ({ status: "done" as const, videoUrl: "https://signed.invalid/video" }));
    const runtime = new MediaRuntime(f.store, {
      submitVideoJob: submit,
      pollVideoJob: poll,
      downloadVideo: async () => join(f.root, "vid-probe.mp4"),
      now: () => 10_000,
    });
    const probe = new CapabilityProbeService(f.store, runtime, {
      now: () => 10_000,
      callImage: image,
      materializeImage: async () => join(f.root, "img-probe.png"),
    });
    const prepared = probe.prepare(binding);
    const result = await probe.run(binding, gate(prepared, 1));

    expect(result.steps.image.state).toBe("completed");
    expect(result.steps.video.state).toBe("completed");
    expect(result.billingAttribution).toBe("unknown");
    expect(result.releaseStatus).toBe("feasibility_only");
    expect(image).toHaveBeenCalledTimes(1);
    expect(image.mock.calls[0]?.[0]).toMatchObject({ model: IMAGE_PROBE_MODEL });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      model: VIDEO_PROBE_MODEL,
      duration: 1,
      resolution: "1080p",
    });
    expect(poll).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(binding.slotRef);
    expect(serialized).not.toContain(binding.identityDigest);
    expect(serialized).not.toContain("private-id");
    expect(serialized).not.toContain("signed.invalid");
    expect(serialized).not.toContain(f.root);
    f.store.close();
  });

  test("probe durably adopts its completed video before older pins can force retention", async () => {
    const f = await fixture();
    const previousHome = process.env.CODEXCOMMANDER_HOME;
    process.env.CODEXCOMMANDER_HOME = f.root;
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const oldPinnedId = "vid-older-probe-pin.mp4";
    await writeFile(join(artifacts, oldPinnedId), MP4, { mode: 0o600 });
    await utimes(join(artifacts, oldPinnedId), 1, 1);
    const unregister = registerArtifactPinAuthority({
      protectedArtifactIds: () => new Set([oldPinnedId]),
    });
    const runtime = new MediaRuntime(f.store, {
      now: () => 10_000,
      artifactsKeepCount: 1,
      submitVideoJob: async () => ({ requestId: "private-probe-retention" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/video" }),
      downloadVideo: async (_url, _signal, options?: VideoArtifactDownloadOptions) => {
        const id = "vid-new-probe.mp4";
        await options?.onReserveArtifact?.(id);
        const path = join(artifacts, id);
        await writeFile(path, MP4, { mode: 0o600 });
        await utimes(path, 2, 2);
        return path;
      },
    });
    const probe = new CapabilityProbeService(f.store, runtime, {
      now: () => 10_000,
      callImage: async () => ({ images: [{ b64_json: "opaque-result" }] }),
      materializeImage: async () => join(f.root, "img-probe.png"),
    });
    try {
      const result = await probe.run(binding, gate(probe.prepare(binding), 1));

      expect(result.steps.video).toMatchObject({ state: "completed", artifactId: "vid-new-probe.mp4" });
      expect(f.store.findVideoJobForProbe(result.id)).toMatchObject({
        state: "completed",
        artifactId: "vid-new-probe.mp4",
      });
      expect(await access(join(artifacts, "vid-new-probe.mp4")).then(() => true, () => false)).toBe(true);
      expect(await access(join(artifacts, oldPinnedId)).then(() => true, () => false)).toBe(true);
    } finally {
      unregister();
      await runtime.shutdown();
      if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previousHome;
    }
  });

  test("partial success is preserved and a fresh confirmation retries only the safely failed step", async () => {
    const f = await fixture();
    const image = mock(async () => ({ images: [{ b64_json: "opaque-result" }] }));
    let attempts = 0;
    const submit = mock(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw mediaError({
          code: "entitlement_denied",
          phase: "submit",
          certainty: "definite",
          status: 403,
          reason: "http_status",
        });
      }
      return { requestId: "private-id" };
    });
    const runtime = new MediaRuntime(f.store, {
      submitVideoJob: submit,
      pollVideoJob: async () => ({ status: "processing" }),
      now: () => 10_000,
    });
    const probe = new CapabilityProbeService(f.store, runtime, {
      now: () => 10_000,
      callImage: image,
      materializeImage: async () => join(f.root, "img-probe.png"),
    });
    let status = await probe.run(binding, gate(probe.prepare(binding), 1));
    expect(status.steps.image.state).toBe("completed");
    expect(status.steps.video.state).toBe("failed");
    expect(status.steps.video.safeError).toBe("entitlement_denied");

    status = await probe.run(binding, gate(status, 2));
    expect(image).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(status.steps.image.state).toBe("completed");
    expect(status.steps.video.state).toBe("accepted");
    f.store.close();
  });

  test("concurrent invocations share one durable operation and one dispatch per step", async () => {
    const f = await fixture();
    let releaseImage!: () => void;
    const imageFence = new Promise<void>(resolve => { releaseImage = resolve; });
    const image = mock(async () => {
      await imageFence;
      return { images: [{ b64_json: "opaque-result" }] };
    });
    const submit = mock(async () => ({ requestId: "private-id" }));
    const runtime = new MediaRuntime(f.store, {
      submitVideoJob: submit,
      pollVideoJob: async () => ({ status: "processing" }),
      now: () => 10_000,
    });
    const probe = new CapabilityProbeService(f.store, runtime, {
      now: () => 10_000,
      callImage: image,
      materializeImage: async () => join(f.root, "img-probe.png"),
    });
    const prepared = probe.prepare(binding);
    const first = probe.run(binding, gate(prepared, 1));
    await Promise.resolve();
    const second = probe.run(binding, gate(prepared, 1));
    releaseImage();
    const results = await Promise.allSettled([first, second]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(image).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(probe.prepare(binding).id).toBe(prepared.id);
    f.store.close();
  });

  test("a fresh concurrent confirmation cannot start video while image submission is unresolved", async () => {
    const f = await fixture();
    let imageStarted!: () => void;
    let releaseImage!: () => void;
    const started = new Promise<void>(resolve => { imageStarted = resolve; });
    const imageFence = new Promise<void>(resolve => { releaseImage = resolve; });
    const image = mock(async () => {
      imageStarted();
      await imageFence;
      return { images: [{ b64_json: "opaque-result" }] };
    });
    const submit = mock(async () => ({ requestId: "private-id" }));
    const runtime = new MediaRuntime(f.store, {
      submitVideoJob: submit,
      pollVideoJob: async () => ({ status: "processing" }),
      now: () => 10_000,
    });
    const probe = new CapabilityProbeService(f.store, runtime, {
      now: () => 10_000,
      callImage: image,
      materializeImage: async () => join(f.root, "img-probe.png"),
    });

    const first = probe.run(binding, gate(probe.prepare(binding), 1));
    await started;
    const whileImageSubmitting = probe.prepare(binding);
    expect(whileImageSubmitting.steps.image.state).toBe("submitting");
    const second = await probe.run(binding, gate(whileImageSubmitting, 2));
    expect(second.steps.image.state).toBe("submitting");
    expect(second.steps.video.state).toBe("pending");
    expect(submit).toHaveBeenCalledTimes(0);

    releaseImage();
    await first;
    expect(image).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(0);
    f.store.close();
  });

  test("the journal transaction refuses video before a non-ambiguous image settlement", async () => {
    const f = await fixture();
    const runtime = new MediaRuntime(f.store, { now: () => 10_000 });
    const probe = new CapabilityProbeService(f.store, runtime, { now: () => 10_000 });
    const prepared = probe.prepare(binding);
    const authorizedImage = f.store.authorizeCapabilityProbe({
      id: prepared.id,
      expectedRevision: prepared.revision,
      confirmationRevision: 1,
      expiresAt: 20_000,
    });
    expect(authorizedImage.kind).toBe("updated");
    if (authorizedImage.kind !== "updated") throw new Error("expected image authorization");
    const imageSubmitting = f.store.beginCapabilityProbeStep({
      id: prepared.id,
      step: "image",
      expectedRevision: authorizedImage.probe.revision,
      confirmationRevision: 1,
    });
    expect(imageSubmitting.kind).toBe("updated");
    if (imageSubmitting.kind !== "updated") throw new Error("expected image submission");
    const authorizedVideo = f.store.authorizeCapabilityProbe({
      id: prepared.id,
      expectedRevision: imageSubmitting.probe.revision,
      confirmationRevision: 2,
      expiresAt: 20_000,
    });
    expect(authorizedVideo.kind).toBe("updated");
    if (authorizedVideo.kind !== "updated") throw new Error("expected video authorization");

    expect(f.store.beginCapabilityProbeStep({
      id: prepared.id,
      step: "video",
      expectedRevision: authorizedVideo.probe.revision,
      confirmationRevision: 2,
    }).kind).toBe("conflict");
    expect(f.store.publicCapabilityProbe(prepared.id)?.steps.video.state).toBe("pending");
    f.store.close();
  });

  test("accepted processing video is driven and reconciled in the background", async () => {
    const f = await fixture();
    const submit = mock(async () => ({ requestId: "private-id" }));
    let polls = 0;
    const runtime = new MediaRuntime(f.store, {
      submitVideoJob: submit,
      pollVideoJob: async () => ++polls === 1
        ? { status: "processing" }
        : { status: "done", videoUrl: "https://signed.invalid/video" },
      downloadVideo: async () => join(f.root, "vid-background.mp4"),
      sleep: async () => {},
      pollIntervalMs: 1,
      now: () => 10_000,
    });
    const probe = new CapabilityProbeService(f.store, runtime, {
      now: () => 10_000,
      callImage: async () => ({ images: [{ b64_json: "opaque-result" }] }),
      materializeImage: async () => join(f.root, "img-probe.png"),
    });

    const submitted = await probe.run(binding, gate(probe.prepare(binding), 1));
    expect(["accepted", "completed"]).toContain(submitted.steps.video.state);
    const completed = await waitForProbeVideo(probe, "completed");
    expect(completed.steps.video.artifactId).toBe("vid-background.mp4");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(polls).toBe(2);
    await runtime.shutdown();
  });

  test("inspection finalizes the video tombstone after deletion and the 24h ceiling releases remaining probe media", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccx-capability-retention-"));
    roots.push(root);
    let now = 10_000;
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => now });
    const removeArtifact = mock(async () => true);
    const runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob: async () => ({ requestId: "private-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/video" }),
      downloadVideo: async () => join(root, "vid-retained.mp4"),
    });
    const probe = new CapabilityProbeService(store, runtime, {
      now: () => now,
      callImage: async () => ({ images: [{ b64_json: "opaque-result" }] }),
      materializeImage: async () => join(root, "img-retained.png"),
      removeArtifact,
    });
    let status = await probe.run(binding, gate(probe.prepare(binding), 1));
    expect(status.steps.image.artifactExpiresAt).toBe(10_000 + PROBE_ARTIFACT_RETENTION_MS);
    expect(status.steps.video.artifactExpiresAt).toBe(10_000 + PROBE_ARTIFACT_RETENTION_MS);

    status = await probe.recordInspection({
      operationId: status.id,
      step: "video",
      expectedRevision: status.revision,
      caller: "interactive_cli",
      runtimeAttested: true,
      humanConfirmed: true,
    });
    expect(removeArtifact).toHaveBeenCalledWith("vid-retained.mp4");
    expect(status.steps.video.artifactId).toBeUndefined();
    expect(store.findVideoJobForProbe(status.id)?.state).toBe("artifact_pruned");
    expect(store.findVideoJobForProbe(status.id)?.artifactId).toBeUndefined();
    now = 10_000 + PROBE_ARTIFACT_RETENTION_MS - 1;
    expect(await probe.sweepExpiredArtifacts()).toBe(0);
    now += 1;
    expect(await probe.sweepExpiredArtifacts()).toBe(1);
    expect(removeArtifact).toHaveBeenCalledWith("img-retained.png");
    expect(probe.prepare(binding).steps.image.artifactId).toBeUndefined();
    expect(store.findVideoJobForProbe(status.id)?.artifactId).toBeUndefined();
    store.close();
    const reopened = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => now + 1 });
    expect(reopened.findVideoJobForProbe(status.id)?.state).toBe("artifact_pruned");
    expect(reopened.findVideoJobForProbe(status.id)?.artifactId).toBeUndefined();
    reopened.close();
  });

  test("failed inspection and expiry deletes retain durable work across restart until eventual removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccx-capability-delete-retry-"));
    roots.push(root);
    const path = join(root, "private", "journal.sqlite");
    let now = 10_000;
    let store = openVideoJobStore({ path, now: () => now });
    let runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob: async () => ({ requestId: "private-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/video" }),
      downloadVideo: async () => join(root, "vid-delete-retry.mp4"),
    });
    const failedRemove = mock(async () => false);
    let probe = new CapabilityProbeService(store, runtime, {
      now: () => now,
      callImage: async () => ({ images: [{ b64_json: "opaque-result" }] }),
      materializeImage: async () => join(root, "img-delete-retry.png"),
      removeArtifact: failedRemove,
      // Models unlink success followed by artifact-directory fsync failure: the
      // name is absent, but `false` must preserve durable delete work.
      artifactExists: () => false,
    });
    let status = await probe.run(binding, gate(probe.prepare(binding), 1));
    status = await probe.recordInspection({
      operationId: status.id,
      step: "video",
      expectedRevision: status.revision,
      caller: "interactive_cli",
      runtimeAttested: true,
      humanConfirmed: true,
    });
    expect(status.steps.video).toMatchObject({
      artifactId: "vid-delete-retry.mp4",
      inspectedAt: now,
    });
    expect(store.findVideoJobForProbe(status.id)).toMatchObject({
      state: "completed",
      artifactId: "vid-delete-retry.mp4",
    });
    expect(store.protectedArtifactIds().has("vid-delete-retry.mp4")).toBe(true);

    now += PROBE_ARTIFACT_RETENTION_MS;
    expect(await probe.sweepExpiredArtifacts()).toBe(0);
    expect(probe.prepare(binding).steps.image.artifactId).toBe("img-delete-retry.png");
    expect(probe.prepare(binding).steps.video.artifactId).toBe("vid-delete-retry.mp4");
    await runtime.shutdown();

    store = openVideoJobStore({ path, now: () => now + 1 });
    runtime = new MediaRuntime(store, { now: () => now + 1 });
    const recoveredRemove = mock(async () => true);
    probe = new CapabilityProbeService(store, runtime, {
      now: () => now + 1,
      removeArtifact: recoveredRemove,
      artifactExists: () => true,
    });
    await probe.recoverOnStartup();
    const recovered = probe.prepare(binding);
    expect(recovered.steps.image.artifactId).toBeUndefined();
    expect(recovered.steps.video.artifactId).toBeUndefined();
    const recoveredJob = store.findVideoJobForProbe(status.id);
    expect(recoveredJob?.state).toBe("artifact_pruned");
    expect(recoveredJob?.artifactId).toBeUndefined();
    expect(recoveredRemove).toHaveBeenCalledWith("img-delete-retry.png");
    expect(recoveredRemove).toHaveBeenCalledWith("vid-delete-retry.mp4");
    await runtime.shutdown();
  });

  test("default removal unlinks pending probe artifacts through the registered runtime authority before CAS finalize", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccx-capability-real-delete-"));
    roots.push(root);
    const previousHome = process.env.CODEXCOMMANDER_HOME;
    process.env.CODEXCOMMANDER_HOME = root;
    let now = 10_000;
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => now });
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const imagePath = join(artifacts, "img-real-delete.png");
    const videoPath = join(artifacts, "vid-real-delete.mp4");
    const runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob: async () => ({ requestId: "private-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/video" }),
      downloadVideo: async () => {
        await writeFile(videoPath, MP4, { mode: 0o600 });
        return videoPath;
      },
    });
    const unregister = registerArtifactPinAuthority({
      protectedArtifactIds: () => runtime.protectedArtifactIds(),
      canReleaseArtifactForPrune: artifactId => runtime.canReleaseArtifactForPrune(artifactId),
      releaseArtifactForPrune: artifactId => runtime.releaseArtifactForPrune(artifactId),
      pendingArtifactDeletionIds: () => runtime.pendingArtifactDeletionIds(),
      finalizeArtifactPrune: artifactId => runtime.finalizeArtifactPrune(artifactId),
    });
    const probe = new CapabilityProbeService(store, runtime, {
      now: () => now,
      callImage: async () => ({ images: [{ b64_json: "opaque-result" }] }),
      materializeImage: async () => {
        await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { mode: 0o600 });
        return imagePath;
      },
    });
    try {
      let status = await probe.run(binding, gate(probe.prepare(binding), 1));
      // Cross the runtime's completion handoff timer; the durable probe record is now the sole
      // owner, matching a real later human inspection.
      await Bun.sleep(1);
      status = await probe.recordInspection({
        operationId: status.id,
        step: "video",
        expectedRevision: status.revision,
        caller: "interactive_cli",
        runtimeAttested: true,
        humanConfirmed: true,
      });
      expect(await access(videoPath).then(() => true, () => false)).toBe(false);
      expect(status.steps.video.artifactId).toBeUndefined();
      expect(store.findVideoJobForProbe(status.id)?.state).toBe("artifact_pruned");

      now += PROBE_ARTIFACT_RETENTION_MS;
      const pressurePath = join(artifacts, "zzz-retention-pressure.png");
      await writeFile(pressurePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { mode: 0o600 });
      pruneArtifacts(1);
      expect(await access(imagePath).then(() => true, () => false)).toBe(true);
      expect(probe.prepare(binding).steps.image.artifactId).toBe("img-real-delete.png");
      expect(await probe.sweepExpiredArtifacts()).toBe(1);
      expect(await access(imagePath).then(() => true, () => false)).toBe(false);
      expect(probe.prepare(binding).steps.image.artifactId).toBeUndefined();
    } finally {
      unregister();
      await runtime.shutdown();
      if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previousHome;
    }
  });

  test("directory-sync failure keeps absent probe bytes pending until ENOENT is durably confirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccx-capability-sync-retry-"));
    roots.push(root);
    const previousHome = process.env.CODEXCOMMANDER_HOME;
    process.env.CODEXCOMMANDER_HOME = root;
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => 10_000 });
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const videoPath = join(artifacts, "vid-probe-sync-retry.mp4");
    let directorySyncSucceeds = false;
    const runtime = new MediaRuntime(store, {
      now: () => 10_000,
      submitVideoJob: async () => ({ requestId: "private-sync-retry" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/video" }),
      downloadVideo: async () => {
        await writeFile(videoPath, MP4, { mode: 0o600 });
        return videoPath;
      },
    });
    const probe = new CapabilityProbeService(store, runtime, {
      now: () => 10_000,
      callImage: async () => ({ images: [{ b64_json: "opaque-result" }] }),
      materializeImage: async () => join(root, "img-sync-retry.png"),
      removeArtifact: async artifactId => unlinkMediaArtifactDurably(artifacts, artifactId, {
        syncDirectory: () => directorySyncSucceeds,
      }),
    });
    try {
      let status = await probe.run(binding, gate(probe.prepare(binding), 1));
      await Bun.sleep(1);
      status = await probe.recordInspection({
        operationId: status.id,
        step: "video",
        expectedRevision: status.revision,
        caller: "interactive_cli",
        runtimeAttested: true,
        humanConfirmed: true,
      });

      expect(await access(videoPath).then(() => true, () => false)).toBe(false);
      expect(status.steps.video.artifactId).toBe("vid-probe-sync-retry.mp4");
      expect(store.findVideoJobForProbe(status.id)).toMatchObject({
        state: "completed",
        artifactId: "vid-probe-sync-retry.mp4",
      });

      directorySyncSucceeds = true;
      expect(await probe.sweepExpiredArtifacts()).toBe(1);
      expect(probe.prepare(binding).steps.video.artifactId).toBeUndefined();
      expect(store.findVideoJobForProbe(status.id)?.state).toBe("artifact_pruned");
      expect(store.findVideoJobForProbe(status.id)?.artifactId).toBeUndefined();
    } finally {
      await runtime.shutdown();
      if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previousHome;
    }
  });

  test("periodic sweep expires artifacts without restart and shutdown cancels future passes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccx-capability-periodic-"));
    roots.push(root);
    let now = 10_000;
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => now });
    const runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob: async () => ({ requestId: "private-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/video" }),
      downloadVideo: async () => join(root, "vid-periodic.mp4"),
    });
    const removeArtifact = mock(async () => true);
    const probe = new CapabilityProbeService(store, runtime, {
      now: () => now,
      callImage: async () => ({ images: [{ b64_json: "opaque-result" }] }),
      materializeImage: async () => join(root, "img-periodic.png"),
      removeArtifact,
      artifactExists: () => true,
      sweepIntervalMs: 5,
    });
    const initial = await probe.run(binding, gate(probe.prepare(binding), 1));
    expect(initial.steps.image.artifactId).toBe("img-periodic.png");
    probe.startBackgroundRecovery();
    now += PROBE_ARTIFACT_RETENTION_MS;
    for (let attempt = 0; attempt < 100 && probe.prepare(binding).steps.image.artifactId; attempt++) {
      await Bun.sleep(2);
    }
    expect(removeArtifact.mock.calls.length).toBeGreaterThan(0);
    expect(probe.prepare(binding).steps.image.artifactId).toBeUndefined();
    expect(probe.prepare(binding).steps.video.artifactId).toBeUndefined();
    const callsAtShutdown = removeArtifact.mock.calls.length;
    probe.shutdown();
    await Bun.sleep(20);
    expect(removeArtifact).toHaveBeenCalledTimes(callsAtShutdown);
    await runtime.shutdown();
  });

  test("accepted video restart recovery keeps one POST and reconciles processing to done", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccx-capability-recovery-"));
    roots.push(root);
    const path = join(root, "private", "journal.sqlite");
    const submit = mock(async () => ({ requestId: "private-id" }));
    let polls = 0;
    const poll = mock(async () => ++polls === 1
      ? { status: "processing" as const }
      : { status: "done" as const, videoUrl: "https://signed.invalid/video" });
    let store = openVideoJobStore({ path, now: () => 10_000 });
    let runtime = new MediaRuntime(store, {
      now: () => 10_000,
      submitVideoJob: submit,
    });
    let probe = new CapabilityProbeService(store, runtime, {
      now: () => 10_000,
      removeArtifact: async () => true,
    });
    const prepared = probe.prepare(binding);
    const authorized = store.authorizeCapabilityProbe({
      id: prepared.id,
      expectedRevision: prepared.revision,
      confirmationRevision: 1,
      expiresAt: 20_000,
    });
    if (authorized.kind !== "updated") throw new Error("expected probe authorization");
    const begunImage = store.beginCapabilityProbeStep({
      id: prepared.id,
      step: "image",
      expectedRevision: authorized.probe.revision,
      confirmationRevision: 1,
    });
    if (begunImage.kind !== "updated") throw new Error("expected image submission");
    const settledImage = store.settleCapabilityProbeStep({
      id: prepared.id,
      step: "image",
      expectedStepRevision: begunImage.probe.steps.image.revision,
      state: "completed",
      dispatchCertainty: "completed",
      artifactId: "img-probe.png",
      artifactExpiresAt: 86_410_000,
      verifiedAt: 10_000,
    });
    if (settledImage.kind !== "updated") throw new Error("expected image settlement");
    const begunVideo = store.beginCapabilityProbeStep({
      id: prepared.id,
      step: "video",
      expectedRevision: settledImage.probe.revision,
      confirmationRevision: 1,
    });
    if (begunVideo.kind !== "updated") throw new Error("expected video submission");
    const submitted = await runtime.submitVideo({
      binding,
      deadlineAt: 610_000,
      request: {
        prompt: "fixed test prompt",
        model: VIDEO_PROBE_MODEL,
        duration: 1,
        resolution: "1080p",
        aspectRatio: "16:9",
      },
      probeOperationId: prepared.id,
      confirmationRevision: 1,
    });
    if (submitted.kind !== "accepted") throw new Error("expected accepted video");
    const acceptedVideo = store.settleCapabilityProbeStep({
      id: prepared.id,
      step: "video",
      expectedStepRevision: begunVideo.probe.steps.video.revision,
      state: "accepted",
      dispatchCertainty: "accepted",
      videoJobId: submitted.job.id,
    });
    if (acceptedVideo.kind !== "updated") throw new Error("expected accepted probe video");
    const interrupted = probe.prepare(binding);
    expect(interrupted.steps.video.state).toBe("accepted");
    expect(interrupted.steps.video.dispatchCertainty).toBe("accepted");
    store.close();

    store = openVideoJobStore({ path, now: () => 20_000 });
    runtime = new MediaRuntime(store, {
      now: () => 20_000,
      submitVideoJob: submit,
      pollVideoJob: poll,
      downloadVideo: async () => join(root, "vid-recovered.mp4"),
      sleep: async () => {},
      pollIntervalMs: 1,
    });
    probe = new CapabilityProbeService(store, runtime, {
      now: () => 20_000,
      removeArtifact: async () => true,
    });
    probe.startBackgroundRecovery();
    const recovered = await waitForProbeVideo(probe, "completed");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(recovered.steps.video.state).toBe("completed");
    expect(JSON.stringify(recovered)).not.toContain("private-id");
    expect(JSON.stringify(recovered)).not.toContain("signed.invalid");
    expect(JSON.stringify(recovered)).not.toContain(root);
    store.close();
  });

  test("real server startup delegates recovery and reconciliation to the probe owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccx-capability-server-startup-"));
    roots.push(root);
    const previousCommanderHome = process.env.CODEXCOMMANDER_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEXCOMMANDER_HOME = root;
    process.env.CODEX_HOME = join(root, "codex");
    await mkdir(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
    saveConfig({
      port: 0,
      multiAgentGuidanceEnabled: true,
      clientIntegrations: { codex: false },
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "fixture-key",
          allowPrivateNetwork: true,
          liveModels: false,
          models: ["fixture-model"],
        },
      },
      images: { bridgeEnabled: false, videoBridgeEnabled: true, authSource: "subscription_oauth" },
    } as CodexCommanderConfig);
    const startRecovery = spyOn(CapabilityProbeService.prototype, "startBackgroundRecovery");
    const shutdownProbe = spyOn(CapabilityProbeService.prototype, "shutdown");
    const server = startServer(0);
    try {
      await Promise.resolve();
      expect(startRecovery).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop(true);
      expect(shutdownProbe).toHaveBeenCalledTimes(1);
      startRecovery.mockRestore();
      shutdownProbe.mockRestore();
      resetLifecycleDrainStateForTests();
      if (previousCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previousCommanderHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});

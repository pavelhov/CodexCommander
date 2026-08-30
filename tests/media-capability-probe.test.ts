import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
import { openVideoJobStore } from "../src/images/video-job-store";
import type { MediaCredentialBinding } from "../src/images/types";

const roots: string[] = [];
const binding: MediaCredentialBinding = {
  authSource: "subscription_oauth",
  providerKind: "canonical",
  slotRef: "media-slot:opaque-private-value",
  identityDigest: `sha256:${"c".repeat(64)}`,
};

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

  test("inspection tombstones video before deletion and the 24h ceiling releases remaining probe media", async () => {
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

  test("accepted video recovery uses GET/download only and reconciles durable probe evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccx-capability-recovery-"));
    roots.push(root);
    const path = join(root, "private", "journal.sqlite");
    const submit = mock(async () => ({ requestId: "private-id" }));
    const poll = mock(async () => ({ status: "done" as const, videoUrl: "https://signed.invalid/video" }));
    let store = openVideoJobStore({ path, now: () => 10_000 });
    let runtime = new MediaRuntime(store, {
      now: () => 10_000,
      submitVideoJob: submit,
      crashSeam(seam) {
        if (seam === "after_accepted_commit") throw new Error("simulated process loss");
      },
    });
    let probe = new CapabilityProbeService(store, runtime, {
      now: () => 10_000,
      callImage: async () => ({ images: [{ b64_json: "opaque-result" }] }),
      materializeImage: async () => join(root, "img-probe.png"),
      removeArtifact: async () => true,
    });
    const interrupted = await probe.run(binding, gate(probe.prepare(binding), 1));
    expect(interrupted.steps.video.state).toBe("accepted");
    expect(interrupted.steps.video.dispatchCertainty).toBe("accepted");
    store.close();

    store = openVideoJobStore({ path, now: () => 20_000 });
    runtime = new MediaRuntime(store, {
      now: () => 20_000,
      submitVideoJob: submit,
      pollVideoJob: poll,
      downloadVideo: async () => join(root, "vid-recovered.mp4"),
    });
    probe = new CapabilityProbeService(store, runtime, {
      now: () => 20_000,
      removeArtifact: async () => true,
    });
    const recovered = await probe.recoverOnStartup();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.steps.video.state).toBe("completed");
    expect(JSON.stringify(recovered)).not.toContain("private-id");
    expect(JSON.stringify(recovered)).not.toContain("signed.invalid");
    expect(JSON.stringify(recovered)).not.toContain(root);
    store.close();
  });
});

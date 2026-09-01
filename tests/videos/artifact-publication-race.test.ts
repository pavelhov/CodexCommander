import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  downloadVideoToArtifact,
  getArtifactsDir,
  type VideoArtifactDownloadOptions,
} from "../../src/images/artifacts";
import { pruneMediaArtifacts, registerArtifactPinAuthority } from "../../src/images/artifact-retention";
import { MediaRuntime } from "../../src/images/media-runtime";
import { beginImageArtifactMaterialization } from "../../src/images/fulfill";
import { openVideoJobStore } from "../../src/images/video-job-store";
import type { MediaCredentialBinding } from "../../src/images/types";

const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const roots: string[] = [];
const originalCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
const binding: MediaCredentialBinding = {
  authSource: "api_key",
  providerKind: "canonical",
  slotRef: "media-slot:publication-race",
  identityDigest: `sha256:${"d".repeat(64)}`,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
  if (originalCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = originalCodexCommanderHome;
});

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  process.env.CODEXCOMMANDER_HOME = root;
  return root;
}

async function waitForState(runtime: MediaRuntime, id: string, states: string[]): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = runtime.getPublicVideoJob(id)?.state;
    if (state && states.includes(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("video job did not reach the expected state");
}

describe("artifact reservation and publication races", () => {
  test("reserves the final opaque id before publication and pruning preserves that pin", async () => {
    const root = await fixture("ccx-artifact-reserve-");
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await chmod(artifacts, 0o700);
    await writeFile(join(artifacts, "img-old.png"), Buffer.from("old"), { mode: 0o600 });
    const protectedIds = new Set<string>();
    let reserved = "";

    const published = await downloadVideoToArtifact(
      `data:video/mp4;base64,${MP4.toString("base64")}`,
      undefined,
      undefined,
      {
        onReserveArtifact: artifactId => {
          reserved = artifactId;
          protectedIds.add(artifactId);
          const during = pruneMediaArtifacts({ dir: artifacts, maxFiles: 1, protectedArtifactIds: protectedIds });
          expect(during.prunedArtifactIds).toEqual([]);
        },
      },
    );

    expect(basename(published)).toBe(reserved);
    expect(Buffer.from(await readFile(published))).toEqual(MP4);
    const after = pruneMediaArtifacts({ dir: artifacts, maxFiles: 1, protectedArtifactIds: protectedIds });
    expect(after.prunedArtifactIds).toContain("img-old.png");
    expect(after.prunedArtifactIds).not.toContain(reserved);
    expect(root).toBeTruthy();
  });

  test("runtime CAS stores the reserved id in downloading and completes only that durable id", async () => {
    const root = await fixture("ccx-artifact-runtime-");
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => 1_000 });
    let reservedState: unknown;
    const runtime = new MediaRuntime(store, {
      now: () => 1_000,
      submitVideoJob: async () => ({ requestId: "private-request-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
      downloadVideo: async (_url, _signal, options?: VideoArtifactDownloadOptions) => {
        const id = "vid-reserved.mp4";
        await options?.onReserveArtifact?.(id);
        reservedState = store.listVideoJobs()[0];
        const dir = getArtifactsDir();
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, id);
        await writeFile(path, MP4, { mode: 0o600 });
        return path;
      },
      sleep: async () => {},
    });
    const submitted = await runtime.submitVideo({
      binding,
      deadlineAt: 61_000,
      request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
    });
    if (submitted.kind !== "accepted") throw new Error("expected accepted job");
    runtime.startVideoJob(submitted.job.id);
    expect(await waitForState(runtime, submitted.job.id, ["completed"])).toBe("completed");
    expect(reservedState).toMatchObject({ state: "downloading", artifactId: "vid-reserved.mp4" });
    expect(store.getVideoJob(submitted.job.id)).toMatchObject({ state: "completed", artifactId: "vid-reserved.mp4" });
    await runtime.shutdown();
  });

  test("video-only runtime prunes durably at startup and after later completion", async () => {
    const root = await fixture("ccx-video-only-retention-");
    const journal = join(root, "private", "journal.sqlite");
    const artifacts = getArtifactsDir();
    let now = 1_000;
    let submissions = 0;
    let publications = 0;
    const submitVideoJob = async () => ({ requestId: `private-request-${++submissions}` });
    const pollVideoJob = async () => ({
      status: "done" as const,
      videoUrl: "https://signed.invalid/result",
    });
    const downloadVideo = async (_url: string, _signal?: AbortSignal, options?: VideoArtifactDownloadOptions) => {
      const artifactId = `vid-video-only-${++publications}.mp4`;
      await options?.onReserveArtifact?.(artifactId);
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      const path = join(artifacts, artifactId);
      await writeFile(path, MP4, { mode: 0o600 });
      await utimes(path, publications, publications);
      return path;
    };
    const createVideo = async (runtime: MediaRuntime): Promise<string> => {
      const submitted = await runtime.submitVideo({
        binding,
        deadlineAt: now + 60_000,
        request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
      });
      if (submitted.kind !== "accepted") throw new Error("expected accepted job");
      const completed = await runtime.driveVideoJob(submitted.job.id);
      expect(completed?.state).toBe("completed");
      now += 1_000;
      return submitted.job.id;
    };
    const exists = async (path: string): Promise<boolean> => {
      try { await access(path); return true; } catch { return false; }
    };

    let store = openVideoJobStore({ path: journal, now: () => now });
    let runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob,
      pollVideoJob,
      downloadVideo,
      artifactsKeepCount: 0,
    });
    const initialJobIds: string[] = [];
    for (let index = 0; index < 3; index += 1) initialJobIds.push(await createVideo(runtime));
    expect(await exists(join(artifacts, "vid-video-only-1.mp4"))).toBe(true);
    await runtime.shutdown();

    store = openVideoJobStore({ path: journal, now: () => now });
    runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob,
      pollVideoJob,
      downloadVideo,
      artifactsKeepCount: 2,
    });
    runtime.prepareStartup();
    runtime.startBackgroundRecovery();
    await runtime.runArtifactRetention();

    expect(store.getVideoJob(initialJobIds[0]!)?.state).toBe("artifact_pruned");
    expect(store.getVideoJob(initialJobIds[1]!)?.state).toBe("completed");
    expect(await exists(join(artifacts, "vid-video-only-1.mp4"))).toBe(false);
    expect(await exists(join(artifacts, "vid-video-only-2.mp4"))).toBe(true);

    const fourthJobId = await createVideo(runtime);
    expect(store.getVideoJob(initialJobIds[1]!)?.state).toBe("artifact_pruned");
    expect(store.getVideoJob(fourthJobId)?.state).toBe("completed");
    expect(await exists(join(artifacts, "vid-video-only-2.mp4"))).toBe(false);
    expect(await exists(join(artifacts, "vid-video-only-4.mp4"))).toBe(true);
    await runtime.shutdown();

    const reopened = openVideoJobStore({ path: journal, now: () => now });
    expect(reopened.getVideoJob(initialJobIds[0]!)?.state).toBe("artifact_pruned");
    expect(reopened.getVideoJob(initialJobIds[1]!)?.state).toBe("artifact_pruned");
    expect(reopened.getVideoJob(fourthJobId)?.state).toBe("completed");
    reopened.close();
  });

  test("completion-time retention preserves the just-paid ordinary video under older pin pressure", async () => {
    const root = await fixture("ccx-video-delivery-pin-");
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const oldPinnedId = "vid-older-pinned.mp4";
    await writeFile(join(artifacts, oldPinnedId), MP4, { mode: 0o600 });
    await utimes(join(artifacts, oldPinnedId), 1, 1);
    const unregister = registerArtifactPinAuthority({
      protectedArtifactIds: () => new Set([oldPinnedId]),
    });
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => 10_000 });
    const runtime = new MediaRuntime(store, {
      now: () => 10_000,
      artifactsKeepCount: 1,
      submitVideoJob: async () => ({ requestId: "private-request-delivery" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
      downloadVideo: async (_url, _signal, options?: VideoArtifactDownloadOptions) => {
        const id = "vid-just-completed.mp4";
        await options?.onReserveArtifact?.(id);
        const path = join(artifacts, id);
        await writeFile(path, MP4, { mode: 0o600 });
        await utimes(path, 2, 2);
        return path;
      },
    });
    try {
      const submitted = await runtime.submitVideo({
        binding,
        deadlineAt: 70_000,
        request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
      });
      if (submitted.kind !== "accepted") throw new Error("expected accepted job");
      const completed = await runtime.driveVideoJob(submitted.job.id);

      expect(completed).toMatchObject({ state: "completed", artifactId: "vid-just-completed.mp4" });
      expect(await access(join(artifacts, "vid-just-completed.mp4")).then(() => true, () => false)).toBe(true);
      expect(await access(join(artifacts, oldPinnedId)).then(() => true, () => false)).toBe(true);
    } finally {
      unregister();
      await runtime.shutdown();
    }
  });

  test("completed replay acquires its delivery lease before the submit promise resolves", async () => {
    const root = await fixture("ccx-video-replay-lease-");
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const artifactId = "vid-replay-lease.mp4";
    const newerId = "img-newer-than-replay.png";
    await writeFile(join(artifacts, artifactId), MP4, { mode: 0o600 });
    await writeFile(join(artifacts, newerId), Buffer.from("newer"), { mode: 0o600 });
    await utimes(join(artifacts, artifactId), 1, 1);
    await utimes(join(artifacts, newerId), 2, 2);
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => 10_000 });
    const operationKey = `hmac-sha256:${"8".repeat(64)}`;
    const requestSemanticsDigest = `hmac-sha256:${"9".repeat(64)}`;
    const reserved = store.reserveVideoJob({
      binding,
      deadlineAt: 70_000,
      operationKey,
      requestSemanticsDigest,
    });
    if (reserved.kind !== "created") throw new Error("expected replay fixture reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected replay fixture fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "private-replay-id");
    if (accepted.kind !== "updated") throw new Error("expected replay fixture acceptance");
    const polling = store.transitionVideoJob({
      id: accepted.job.id,
      expectedRevision: accepted.job.revision,
      from: ["accepted"],
      to: "polling",
    });
    if (polling.kind !== "updated") throw new Error("expected replay fixture polling");
    const downloading = store.reserveVideoArtifact(polling.job.id, polling.job.revision, artifactId);
    if (downloading.kind !== "updated") throw new Error("expected replay fixture artifact reservation");
    const completed = store.completeVideoArtifact(downloading.job.id, downloading.job.revision, artifactId);
    if (completed.kind !== "updated") throw new Error("expected replay fixture completion");
    const runtime = new MediaRuntime(store, { now: () => 10_000, artifactsKeepCount: 1 });

    const retention = runtime.runArtifactRetention();
    const replay = await runtime.submitVideo({
      binding,
      deadlineAt: 70_000,
      operationKey,
      requestSemanticsDigest,
      request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
    });
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") throw new Error("expected completed replay");
    expect(typeof replay.releaseArtifactDeliveryLease).toBe("function");
    await retention;
    expect(store.getVideoJob(completed.job.id)?.state).toBe("completed");
    expect(await access(join(artifacts, artifactId)).then(() => true, () => false)).toBe(true);
    replay.releaseArtifactDeliveryLease?.();
    await runtime.shutdown();
  });

  test("concurrent different-binding completions cannot prune each other before delivery", async () => {
    const root = await fixture("ccx-video-concurrent-delivery-");
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    let downloads = 0;
    let releaseDownloads!: () => void;
    const bothDownloading = new Promise<void>(resolve => { releaseDownloads = resolve; });
    const runtimeStore = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => 20_000 });
    const runtime = new MediaRuntime(runtimeStore, {
      now: () => 20_000,
      artifactsKeepCount: 1,
      submitVideoJob: async (_request, selectedBinding) => ({
        requestId: selectedBinding.identityDigest.endsWith("a") ? "request-a" : "request-b",
      }),
      pollVideoJob: async requestId => ({
        status: "done",
        videoUrl: `https://signed.invalid/${requestId}`,
      }),
      downloadVideo: async (url, _signal, options?: VideoArtifactDownloadOptions) => {
        const id = url.endsWith("request-a") ? "vid-a.mp4" : "vid-b.mp4";
        await options?.onReserveArtifact?.(id);
        const path = join(artifacts, id);
        await writeFile(path, MP4, { mode: 0o600 });
        downloads += 1;
        if (downloads === 2) releaseDownloads();
        await bothDownloading;
        return path;
      },
    });
    const bindingA: MediaCredentialBinding = {
      ...binding,
      slotRef: "media-slot:concurrent-a",
      identityDigest: `sha256:${"1".repeat(63)}a`,
    };
    const bindingB: MediaCredentialBinding = {
      ...binding,
      slotRef: "media-slot:concurrent-b",
      identityDigest: `sha256:${"2".repeat(63)}b`,
    };
    try {
      const [submittedA, submittedB] = await Promise.all([
        runtime.submitVideo({
          binding: bindingA,
          deadlineAt: 80_000,
          request: { prompt: "ephemeral a", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
        }),
        runtime.submitVideo({
          binding: bindingB,
          deadlineAt: 80_000,
          request: { prompt: "ephemeral b", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
        }),
      ]);
      if (submittedA.kind !== "accepted" || submittedB.kind !== "accepted") throw new Error("expected two accepted jobs");
      const [completedA, completedB] = await Promise.all([
        runtime.driveVideoJob(submittedA.job.id),
        runtime.driveVideoJob(submittedB.job.id),
      ]);

      expect(completedA).toMatchObject({ state: "completed", artifactId: "vid-a.mp4" });
      expect(completedB).toMatchObject({ state: "completed", artifactId: "vid-b.mp4" });
      expect(runtimeStore.getVideoJob(submittedA.job.id)?.state).toBe("completed");
      expect(runtimeStore.getVideoJob(submittedB.job.id)?.state).toBe("completed");
      expect(await access(join(artifacts, "vid-a.mp4")).then(() => true, () => false)).toBe(true);
      expect(await access(join(artifacts, "vid-b.mp4")).then(() => true, () => false)).toBe(true);

      // Ephemeral delivery pins are not durable leaks: a later independent pass
      // can enforce the configured cap after both callers received completion.
      await new Promise(resolve => setTimeout(resolve, 5));
      await runtime.runArtifactRetention();
      const terminalStates = [
        runtimeStore.getVideoJob(submittedA.job.id)?.state,
        runtimeStore.getVideoJob(submittedB.job.id)?.state,
      ];
      expect(terminalStates.filter(state => state === "completed")).toHaveLength(1);
      expect(terminalStates.filter(state => state === "artifact_pruned")).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  test("a crash after durable publication recovers the same reserved id without another publication", async () => {
    const root = await fixture("ccx-artifact-crash-");
    const journal = join(root, "private", "journal.sqlite");
    let publications = 0;
    let store = openVideoJobStore({ path: journal, now: () => 1_000 });
    let runtime = new MediaRuntime(store, {
      now: () => 1_000,
      submitVideoJob: async () => ({ requestId: "private-request-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
      downloadVideo: async (_url, _signal, options?: VideoArtifactDownloadOptions) => {
        const id = options?.reservedArtifactId ?? "vid-crash-safe.mp4";
        await options?.onReserveArtifact?.(id);
        const dir = getArtifactsDir();
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, id);
        await writeFile(path, MP4, { mode: 0o600 });
        publications += 1;
        return path;
      },
      crashSeam(seam) {
        if (seam === "after_artifact_published") throw new Error("simulated process loss");
      },
    });
    const submitted = await runtime.submitVideo({
      binding,
      deadlineAt: 61_000,
      request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
    });
    if (submitted.kind !== "accepted") throw new Error("expected accepted job");
    runtime.startVideoJob(submitted.job.id);
    expect(await waitForState(runtime, submitted.job.id, ["downloading"])).toBe("downloading");
    for (let attempt = 0; attempt < 100 && publications === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(publications).toBe(1);
    const reserved = store.getVideoJob(submitted.job.id)?.artifactId;
    expect(reserved).toBe("vid-crash-safe.mp4");
    store.close();

    let recoveryPolls = 0;
    let recoveryDownloads = 0;
    store = openVideoJobStore({ path: journal, now: () => 70_000 });
    runtime = new MediaRuntime(store, {
      now: () => 70_000,
      submitVideoJob: async () => { throw new Error("must not resubmit"); },
      pollVideoJob: async () => {
        recoveryPolls += 1;
        throw new Error("must adopt local bytes before provider polling");
      },
      downloadVideo: async () => {
        recoveryDownloads += 1;
        throw new Error("must adopt local bytes before signed URL download");
      },
      sleep: async () => {},
    });
    runtime.prepareStartup();
    runtime.startBackgroundRecovery();
    expect(await waitForState(runtime, submitted.job.id, ["completed"])).toBe("completed");
    expect(publications).toBe(1);
    expect(recoveryPolls).toBe(0);
    expect(recoveryDownloads).toBe(0);
    expect(store.getVideoJob(submitted.job.id)).toMatchObject({ state: "completed", artifactId: reserved });
    await runtime.shutdown();
  });

  test("an invalid reserved local artifact expires after its deadline without provider replay", async () => {
    const root = await fixture("ccx-artifact-invalid-local-");
    const artifactId = "vid-invalid-local.mp4";
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await writeFile(join(artifacts, artifactId), Buffer.from("not-a-video"), { mode: 0o600 });

    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => 1_000 });
    const reservation = store.reserveVideoJob({ binding, deadlineAt: 1_500 });
    if (reservation.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reservation.job.id, reservation.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "private-request-id");
    if (accepted.kind !== "updated") throw new Error("expected acceptance");
    const polling = store.transitionVideoJob({
      id: accepted.job.id,
      expectedRevision: accepted.job.revision,
      from: ["accepted"],
      to: "polling",
    });
    if (polling.kind !== "updated") throw new Error("expected polling");
    const downloading = store.reserveVideoArtifact(polling.job.id, polling.job.revision, artifactId);
    if (downloading.kind !== "updated") throw new Error("expected artifact reservation");
    const failed = store.transitionVideoJob({
      id: downloading.job.id,
      expectedRevision: downloading.job.revision,
      from: ["downloading"],
      to: "download_failed",
      safeError: "download_rejected",
    });
    if (failed.kind !== "updated") throw new Error("expected download failure");

    let polls = 0;
    let downloads = 0;
    const runtime = new MediaRuntime(store, {
      now: () => 2_000,
      pollVideoJob: async () => {
        polls += 1;
        throw new Error("invalid local recovery must not poll after deadline");
      },
      downloadVideo: async () => {
        downloads += 1;
        throw new Error("invalid local recovery must not download after deadline");
      },
    });
    const result = await runtime.driveVideoJob(failed.job.id);
    expect(result).toMatchObject({ state: "expired", safeError: "timeout" });
    expect(polls).toBe(0);
    expect(downloads).toBe(0);
    await runtime.shutdown();
  });

  test("a retry deterministically adopts a final hard link left by a publication crash", async () => {
    await fixture("ccx-artifact-link-crash-");
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await chmod(artifacts, 0o700);
    const artifactId = "vid-link-crash.mp4";
    const temp = join(artifacts, ".ccx-video-link-crash.tmp");
    const final = join(artifacts, artifactId);
    await writeFile(temp, MP4, { mode: 0o600 });
    await link(temp, final);
    expect((await lstat(final)).nlink).toBe(2);

    const recovered = await downloadVideoToArtifact(
      `data:video/mp4;base64,${MP4.toString("base64")}`,
      undefined,
      undefined,
      { reservedArtifactId: artifactId },
    );

    expect(recovered).toBe(final);
    expect((await lstat(final)).nlink).toBe(1);
    expect(Buffer.from(await readFile(final))).toEqual(MP4);
    await expect(lstat(temp)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cap-zero startup repairs a durable active reservation before local adoption", async () => {
    const root = await fixture("ccx-artifact-active-link-");
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await chmod(artifacts, 0o700);
    const artifactId = "vid-active-link.mp4";
    const temp = join(artifacts, ".ccx-video-active-link.tmp");
    const final = join(artifacts, artifactId);
    await writeFile(temp, MP4, { mode: 0o600 });
    await link(temp, final);

    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => 1_000 });
    const reservation = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
    if (reservation.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reservation.job.id, reservation.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "private-active-request");
    if (accepted.kind !== "updated") throw new Error("expected acceptance");
    const polling = store.transitionVideoJob({
      id: accepted.job.id,
      expectedRevision: accepted.job.revision,
      from: ["accepted"],
      to: "polling",
    });
    if (polling.kind !== "updated") throw new Error("expected polling");
    const downloading = store.reserveVideoArtifact(polling.job.id, polling.job.revision, artifactId);
    if (downloading.kind !== "updated") throw new Error("expected artifact reservation");

    let polls = 0;
    let downloads = 0;
    const runtime = new MediaRuntime(store, {
      now: () => 2_000,
      artifactsKeepCount: 0,
      pollVideoJob: async () => {
        polls += 1;
        throw new Error("local adoption must precede provider polling");
      },
      downloadVideo: async () => {
        downloads += 1;
        throw new Error("local adoption must precede provider download");
      },
    });

    expect(runtime.prepareStartup().pollable).toEqual([downloading.job.id]);
    await runtime.runArtifactRetention();

    await expect(lstat(temp)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(final)).nlink).toBe(1);
    runtime.startBackgroundRecovery();
    expect(await waitForState(runtime, downloading.job.id, ["completed"])).toBe("completed");
    expect(store.getVideoJob(downloading.job.id)).toMatchObject({ state: "completed", artifactId });
    expect(polls).toBe(0);
    expect(downloads).toBe(0);
    await runtime.shutdown();
  });

  test("ordinary retention prepares deletion before bytes and finalizes only afterward", async () => {
    const root = await fixture("ccx-artifact-pruned-");
    const artifactId = "vid-retention.mp4";
    const artifacts = getArtifactsDir();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await writeFile(join(artifacts, artifactId), MP4, { mode: 0o600 });
    await writeFile(join(artifacts, "img-new.png"), Buffer.from("new"), { mode: 0o600 });
    await utimes(join(artifacts, artifactId), 1, 1);
    await utimes(join(artifacts, "img-new.png"), 2, 2);

    const journal = join(root, "private", "journal.sqlite");
    const store = openVideoJobStore({ path: journal, now: () => 1_000 });
    const reservation = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
    if (reservation.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reservation.job.id, reservation.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "private-request-id");
    if (accepted.kind !== "updated") throw new Error("expected acceptance");
    const polling = store.transitionVideoJob({ id: accepted.job.id, expectedRevision: accepted.job.revision, from: ["accepted"], to: "polling" });
    if (polling.kind !== "updated") throw new Error("expected polling");
    const downloading = store.reserveVideoArtifact(polling.job.id, polling.job.revision, artifactId);
    if (downloading.kind !== "updated") throw new Error("expected artifact reservation");
    const completed = store.completeVideoArtifact(downloading.job.id, downloading.job.revision, artifactId);
    if (completed.kind !== "updated") throw new Error("expected completion");

    expect(store.markVideoArtifactPruned(completed.job.id, completed.job.revision - 1, artifactId).kind).toBe("conflict");
    const runtime = new MediaRuntime(store, { now: () => 1_000 });
    // Mirror the two production authorities: server/index registers a forwarding
    // wrapper while runtime-owned retention also passes the runtime explicitly.
    const unregister = registerArtifactPinAuthority({
      protectedArtifactIds: () => runtime.protectedArtifactIds(),
      recoverablePublicationArtifactIds: () => runtime.recoverablePublicationArtifactIds(),
      canReleaseArtifactForPrune: id => runtime.canReleaseArtifactForPrune(id),
      releaseArtifactForPrune: id => runtime.releaseArtifactForPrune(id),
      pendingArtifactDeletionIds: () => runtime.pendingArtifactDeletionIds(),
      finalizeArtifactPrune: id => runtime.finalizeArtifactPrune(id),
    });
    try {
      // Register the runtime owner first so the historical one-phase loop would
      // tombstone it before discovering the later directory-wide image guard.
      const finishMaterialization = beginImageArtifactMaterialization();
      try {
        expect(pruneMediaArtifacts({ dir: artifacts, maxFiles: 1, pinAuthorities: [runtime] }).prunedArtifactIds).toEqual([]);
        expect(store.getVideoJob(completed.job.id)?.state).toBe("completed");
        expect(await access(join(artifacts, artifactId)).then(() => true, () => false)).toBe(true);
      } finally {
        finishMaterialization();
      }

      expect(pruneMediaArtifacts({ dir: artifacts, maxFiles: 1, pinAuthorities: [runtime] }).prunedArtifactIds).toEqual([artifactId]);
    } finally {
      unregister();
    }
    expect(store.getVideoJob(completed.job.id)?.state).toBe("artifact_pruned");
    expect(store.getVideoJob(completed.job.id)?.artifactId).toBeUndefined();
    await runtime.shutdown();

    const reopened = openVideoJobStore({ path: journal, now: () => 2_000 });
    expect(reopened.getVideoJob(completed.job.id)?.state).toBe("artifact_pruned");
    expect(reopened.getVideoJob(completed.job.id)?.artifactId).toBeUndefined();
    reopened.close();
  });

  test.each(["unlink", "sync", "finalize"] as const)(
    "ordinary %s failure stays pending across restart without pruning a newer video",
    async fault => {
      const root = await fixture(`ccx-artifact-${fault}-failure-`);
      const artifacts = getArtifactsDir();
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      const oldId = `vid-old-${fault}.mp4`;
      const newId = `vid-new-${fault}.mp4`;
      await writeFile(join(artifacts, oldId), MP4, { mode: 0o600 });
      await writeFile(join(artifacts, newId), MP4, { mode: 0o600 });
      await utimes(join(artifacts, oldId), 1, 1);
      await utimes(join(artifacts, newId), 2, 2);
      const journal = join(root, "private", "journal.sqlite");
      let store = openVideoJobStore({ path: journal, now: () => 5_000 });
      const complete = (artifactId: string, requestId: string) => {
        const reservation = store.reserveVideoJob({ binding, deadlineAt: 65_000 });
        if (reservation.kind !== "created") throw new Error("expected reservation");
        const fenced = store.fenceVideoSubmission(reservation.job.id, reservation.job.revision);
        if (fenced.kind !== "updated") throw new Error("expected fence");
        const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, requestId);
        if (accepted.kind !== "updated") throw new Error("expected acceptance");
        const polling = store.transitionVideoJob({
          id: accepted.job.id,
          expectedRevision: accepted.job.revision,
          from: ["accepted"],
          to: "polling",
        });
        if (polling.kind !== "updated") throw new Error("expected polling");
        const downloading = store.reserveVideoArtifact(polling.job.id, polling.job.revision, artifactId);
        if (downloading.kind !== "updated") throw new Error("expected artifact reservation");
        const completed = store.completeVideoArtifact(downloading.job.id, downloading.job.revision, artifactId);
        if (completed.kind !== "updated") throw new Error("expected completion");
        return completed.job;
      };
      const oldJob = complete(oldId, `private-old-${fault}`);
      const newJob = complete(newId, `private-new-${fault}`);
      const authority = {
        protectedArtifactIds: () => store.protectedArtifactIds(),
        canReleaseArtifactForPrune: (id: string) => store.canReleaseArtifactForPrune(id),
        releaseArtifactForPrune: (id: string) => store.releaseArtifactForPrune(id),
        pendingArtifactDeletionIds: () => store.pendingArtifactDeletionIds(),
        finalizeArtifactPrune: (id: string) => fault === "finalize" ? "conflict" as const : store.finalizeArtifactPrune(id),
      };
      const first = pruneMediaArtifacts({
        dir: artifacts,
        maxFiles: 1,
        pinAuthorities: [authority],
        ...(fault === "unlink"
          ? { io: { unlinkFile: () => { throw new Error("injected unlink failure"); } } }
          : fault === "sync"
            ? { io: { syncDirectory: () => false } }
            : {}),
      });

      expect(first.prunedArtifactIds).toEqual([]);
      expect(store.getVideoJob(oldJob.id)).toMatchObject({ state: "artifact_pruned", artifactId: oldId });
      expect(store.publicVideoJob(oldJob.id)).not.toHaveProperty("artifactId");
      expect(store.getVideoJob(newJob.id)).toMatchObject({ state: "completed", artifactId: newId });
      expect(await access(join(artifacts, newId)).then(() => true, () => false)).toBe(true);
      expect(store.pendingArtifactDeletionIds()).toEqual(new Set([oldId]));
      if (fault === "unlink") {
        expect(await access(join(artifacts, oldId)).then(() => true, () => false)).toBe(true);
      } else {
        expect(await access(join(artifacts, oldId)).then(() => true, () => false)).toBe(false);
      }
      store.close();

      store = openVideoJobStore({ path: journal, now: () => 6_000 });
      const recoveredRuntime = new MediaRuntime(store, {
        now: () => 6_000,
        // Zero disables count pruning but must never disable durable pending-delete recovery.
        artifactsKeepCount: 0,
      });
      await recoveredRuntime.runArtifactRetention();
      expect(store.getVideoJob(oldJob.id)).toMatchObject({ state: "artifact_pruned" });
      expect(store.getVideoJob(oldJob.id)?.artifactId).toBeUndefined();
      expect(store.getVideoJob(newJob.id)).toMatchObject({ state: "completed", artifactId: newId });
      expect(await access(join(artifacts, newId)).then(() => true, () => false)).toBe(true);
      await recoveredRuntime.shutdown();
    },
  );
});

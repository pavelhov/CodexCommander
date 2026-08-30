import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  downloadVideoToArtifact,
  getArtifactsDir,
  type VideoArtifactDownloadOptions,
} from "../../src/images/artifacts";
import { pruneMediaArtifacts, registerArtifactPinAuthority } from "../../src/images/artifact-retention";
import { MediaRuntime } from "../../src/images/media-runtime";
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

    store = openVideoJobStore({ path: journal, now: () => 2_000 });
    runtime = new MediaRuntime(store, {
      now: () => 2_000,
      submitVideoJob: async () => { throw new Error("must not resubmit"); },
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result-2" }),
      downloadVideo: async (_url, _signal, options?: VideoArtifactDownloadOptions) => {
        expect(options?.reservedArtifactId).toBe(reserved);
        await options?.onReserveArtifact?.(reserved!);
        return join(getArtifactsDir(), reserved!);
      },
      sleep: async () => {},
    });
    runtime.prepareStartup();
    runtime.startBackgroundRecovery();
    expect(await waitForState(runtime, submitted.job.id, ["completed"])).toBe("completed");
    expect(publications).toBe(1);
    expect(store.getVideoJob(submitted.job.id)).toMatchObject({ state: "completed", artifactId: reserved });
    await runtime.shutdown();
  });

  test("ordinary retention CAS-tombstones a completed job before deleting its bytes", async () => {
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
    const unregister = registerArtifactPinAuthority({
      protectedArtifactIds: () => store.protectedArtifactIds(),
      releaseArtifactForPrune: id => store.releaseArtifactForPrune(id),
    });
    try {
      expect(pruneMediaArtifacts({ dir: artifacts, maxFiles: 1 }).prunedArtifactIds).toEqual([artifactId]);
    } finally {
      unregister();
    }
    expect(store.getVideoJob(completed.job.id)?.state).toBe("artifact_pruned");
    expect(store.getVideoJob(completed.job.id)?.artifactId).toBeUndefined();
    store.close();

    const reopened = openVideoJobStore({ path: journal, now: () => 2_000 });
    expect(reopened.getVideoJob(completed.job.id)?.state).toBe("artifact_pruned");
    expect(reopened.getVideoJob(completed.job.id)?.artifactId).toBeUndefined();
    reopened.close();
  });
});

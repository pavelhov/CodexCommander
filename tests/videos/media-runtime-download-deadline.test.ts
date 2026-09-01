import { afterEach, describe, expect, test } from "bun:test";
import { access, link, lstat, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getArtifactsDir,
} from "../../src/images/artifacts";
import type { ArtifactRetentionIo } from "../../src/images/artifact-retention";
import { mediaError, MediaTransportError } from "../../src/images/media-errors";
import {
  MediaRuntime,
  mediaRecoveryJobId,
  type RuntimeVideoArtifactDownloadOptions,
} from "../../src/images/media-runtime";
import type { MediaCredentialBinding } from "../../src/images/types";
import { openVideoJobStore } from "../../src/images/video-job-store";

const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const roots: string[] = [];
const originalCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
const binding: MediaCredentialBinding = {
  authSource: "api_key",
  providerKind: "canonical",
  slotRef: "media-slot:download-deadline",
  identityDigest: `sha256:${"7".repeat(64)}`,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
  if (originalCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = originalCodexCommanderHome;
});

async function fixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  process.env.CODEXCOMMANDER_HOME = root;
  return root;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise rejection");
}

async function submitAccepted(runtime: MediaRuntime, deadlineAt: number): Promise<string> {
  const submitted = await runtime.submitVideo({
    binding,
    deadlineAt,
    request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
  });
  if (submitted.kind !== "accepted") throw new Error("expected accepted job");
  return submitted.job.id;
}

describe("durable video download deadline", () => {
  test("durably cleans a reserved artifact when the download rejects after its deadline", async () => {
    const root = await fixture("ccx-video-download-expired-rejection-");
    const journalPath = join(root, "private", "journal.sqlite");
    const artifacts = getArtifactsDir();
    const artifactId = "vid-expired-rejection.mp4";
    const finalPath = join(artifacts, artifactId);
    let now = 1_000;
    const deadlineAt = 2_000;
    const store = openVideoJobStore({ path: journalPath, now: () => now });
    const runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob: async () => ({ requestId: "private-request-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
      downloadVideo: async (_url, _signal, options?: RuntimeVideoArtifactDownloadOptions) => {
        await options?.onReserveArtifact?.(artifactId);
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        await writeFile(finalPath, MP4, { mode: 0o600 });
        now = deadlineAt;
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });

    try {
      const id = await submitAccepted(runtime, deadlineAt);
      const result = await runtime.driveVideoJob(id);

      expect(result).toMatchObject({ state: "expired", safeError: "timeout" });
      expect(result).not.toHaveProperty("artifactId");
      await runtime.shutdown();
      expect(await exists(finalPath)).toBe(false);

      const reopened = openVideoJobStore({ path: journalPath, now: () => now });
      expect(reopened.getVideoJob(id)).toMatchObject({ state: "expired", safeError: "timeout" });
      expect(reopened.getVideoJob(id)?.artifactId).toBeUndefined();
      reopened.close();
    } finally {
      await runtime.shutdown();
    }
  });

  test("cleans an artifact that finishes publishing after the absolute deadline", async () => {
    const root = await fixture("ccx-video-download-post-expiry-");
    const artifacts = getArtifactsDir();
    const artifactId = "vid-post-download-expiry.mp4";
    const finalPath = join(artifacts, artifactId);
    let now = 10_000;
    const deadlineAt = 11_000;
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite"), now: () => now });
    const runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob: async () => ({ requestId: "private-request-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
      downloadVideo: async (_url, _signal, options?: RuntimeVideoArtifactDownloadOptions) => {
        await options?.onReserveArtifact?.(artifactId);
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        await writeFile(finalPath, MP4, { mode: 0o600 });
        now = deadlineAt;
        return finalPath;
      },
    });

    try {
      const id = await submitAccepted(runtime, deadlineAt);
      const result = await runtime.driveVideoJob(id);

      expect(result).toMatchObject({ state: "expired", safeError: "timeout" });
      expect(result).not.toHaveProperty("artifactId");
      expect(await exists(finalPath)).toBe(false);
      expect(store.getVideoJob(id)?.artifactId).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  test.each(["unlink", "fsync"] as const)(
    "retains a private deletion obligation after %s failure and retries it after reopen",
    async failure => {
      const root = await fixture(`ccx-video-download-${failure}-retry-`);
      const journalPath = join(root, "private", "journal.sqlite");
      const artifacts = getArtifactsDir();
      const artifactId = `vid-${failure}-retry.mp4`;
      const finalPath = join(artifacts, artifactId);
      let now = 20_000;
      const deadlineAt = 21_000;
      const io: ArtifactRetentionIo = failure === "unlink"
        ? { unlinkFile: () => { throw new Error("injected unlink failure"); } }
        : { syncDirectory: () => false };
      const store = openVideoJobStore({ path: journalPath, now: () => now });
      const runtime = new MediaRuntime(store, {
        now: () => now,
        artifactRetentionIo: io,
        submitVideoJob: async () => ({ requestId: "private-request-id" }),
        pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
        downloadVideo: async (_url, _signal, options?: RuntimeVideoArtifactDownloadOptions) => {
          await options?.onReserveArtifact?.(artifactId);
          await mkdir(artifacts, { recursive: true, mode: 0o700 });
          await writeFile(finalPath, MP4, { mode: 0o600 });
          now = deadlineAt;
          return finalPath;
        },
      });

      const id = await submitAccepted(runtime, deadlineAt);
      const result = await runtime.driveVideoJob(id);
      expect(result).toMatchObject({ state: "expired", safeError: "timeout" });
      expect(result).not.toHaveProperty("artifactId");
      expect(store.publicVideoJob(id)).not.toHaveProperty("artifactId");
      expect(store.getVideoJob(id)?.artifactId).toBe(artifactId);
      expect(await exists(finalPath)).toBe(failure === "unlink");
      await runtime.shutdown();

      now += 1;
      const reopenedStore = openVideoJobStore({ path: journalPath, now: () => now });
      const reopenedRuntime = new MediaRuntime(reopenedStore, { now: () => now });
      try {
        await reopenedRuntime.recoverOnStartup();
        expect(await exists(finalPath)).toBe(false);
        expect(reopenedStore.getVideoJob(id)).toMatchObject({ state: "expired", safeError: "timeout" });
        expect(reopenedStore.getVideoJob(id)?.artifactId).toBeUndefined();
      } finally {
        await reopenedRuntime.shutdown();
      }
    },
  );

  test("recreates a missing private artifact directory before finalizing an absent expired artifact", async () => {
    const root = await fixture("ccx-video-download-missing-dir-retry-");
    const journalPath = join(root, "private", "journal.sqlite");
    const artifacts = getArtifactsDir();
    const artifactId = "vid-missing-dir-retry.mp4";
    const finalPath = join(artifacts, artifactId);
    let now = 25_000;
    const deadlineAt = 26_000;
    const store = openVideoJobStore({ path: journalPath, now: () => now });
    const runtime = new MediaRuntime(store, {
      now: () => now,
      artifactRetentionIo: { syncDirectory: () => false },
      submitVideoJob: async () => ({ requestId: "private-request-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
      downloadVideo: async (_url, _signal, options?: RuntimeVideoArtifactDownloadOptions) => {
        await options?.onReserveArtifact?.(artifactId);
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        await writeFile(finalPath, MP4, { mode: 0o600 });
        now = deadlineAt;
        return finalPath;
      },
    });

    const id = await submitAccepted(runtime, deadlineAt);
    expect(await runtime.driveVideoJob(id)).toMatchObject({ state: "expired", safeError: "timeout" });
    expect(store.getVideoJob(id)?.artifactId).toBe(artifactId);
    await runtime.shutdown();
    await rm(artifacts, { recursive: true, force: true });

    now += 1;
    const reopenedStore = openVideoJobStore({ path: journalPath, now: () => now });
    const reopenedRuntime = new MediaRuntime(reopenedStore, { now: () => now });
    try {
      await reopenedRuntime.recoverOnStartup();
      const stats = await lstat(artifacts);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o700);
        expect(stats.uid).toBe(process.getuid?.());
      }
      expect(reopenedStore.getVideoJob(id)).toMatchObject({ state: "expired", safeError: "timeout" });
      expect(reopenedStore.getVideoJob(id)?.artifactId).toBeUndefined();
    } finally {
      await reopenedRuntime.shutdown();
    }
  });

  test("restart removes both names from an expired reserved publication-link crash before finalizing", async () => {
    const root = await fixture("ccx-video-expired-linked-restart-");
    const journalPath = join(root, "private", "journal.sqlite");
    const artifacts = getArtifactsDir();
    const artifactId = "vid-expired-linked-restart.mp4";
    const tempPath = join(artifacts, ".ccx-video-expired-linked-restart.tmp");
    const finalPath = join(artifacts, artifactId);
    let now = 1_000;
    let store = openVideoJobStore({ path: journalPath, now: () => now });
    const reserved = store.reserveVideoJob({ binding, deadlineAt: 2_000 });
    if (reserved.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "private-linked-crash-request");
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
    now = 2_000;
    const expired = store.transitionVideoJob({
      id: downloading.job.id,
      expectedRevision: downloading.job.revision,
      from: ["downloading"],
      to: "expired",
      safeError: "timeout",
    });
    if (expired.kind !== "updated") throw new Error("expected expiry");
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await writeFile(tempPath, MP4, { mode: 0o600 });
    await link(tempPath, finalPath);
    expect((await lstat(tempPath)).nlink).toBe(2);
    store.close(); // simulated process loss after link(temp, final), before either unlink

    now = 3_000;
    store = openVideoJobStore({ path: journalPath, now: () => now });
    const runtime = new MediaRuntime(store, { now: () => now, artifactsKeepCount: 0 });
    try {
      await runtime.recoverOnStartup();
      expect(await exists(tempPath)).toBe(false);
      expect(await exists(finalPath)).toBe(false);
      expect(store.getVideoJob(expired.job.id)).toMatchObject({ state: "expired", safeError: "timeout" });
      expect(store.getVideoJob(expired.job.id)).not.toHaveProperty("artifactId");
    } finally {
      await runtime.shutdown();
    }
  });

  test("startup removes only a bounded batch of old private unlinked video temps", async () => {
    const root = await fixture("ccx-video-stale-temp-restart-");
    const journalPath = join(root, "private", "journal.sqlite");
    const artifacts = getArtifactsDir();
    const initialized = openVideoJobStore({ path: journalPath });
    initialized.close();
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const staleTime = new Date(Date.now() - (25 * 60 * 60_000));
    for (let index = 0; index < 34; index += 1) {
      const path = join(artifacts, `.ccx-video-stale-${String(index).padStart(2, "0")}.tmp`);
      await writeFile(path, Buffer.from(`partial-${index}`), { mode: 0o600 });
      await utimes(path, staleTime, staleTime);
    }
    const freshPath = join(artifacts, ".ccx-video-fresh.tmp");
    await writeFile(freshPath, Buffer.from("active-looking"), { mode: 0o600 });

    const store = openVideoJobStore({ path: journalPath });
    const runtime = new MediaRuntime(store, { artifactsKeepCount: 0 });
    try {
      await runtime.recoverOnStartup();
      const remaining = await readdir(artifacts);
      expect(remaining.filter(name => /^\.ccx-video-stale-\d{2}\.tmp$/.test(name))).toHaveLength(2);
      expect(remaining).toContain(".ccx-video-fresh.tmp");
    } finally {
      await runtime.shutdown();
    }
  });

  test("pins an in-flight late publication and shutdown awaits its durable cleanup", async () => {
    const root = await fixture("ccx-video-download-shutdown-cleanup-");
    const journalPath = join(root, "private", "journal.sqlite");
    const artifacts = getArtifactsDir();
    const artifactId = "vid-shutdown-late-publication.mp4";
    const finalPath = join(artifacts, artifactId);
    const downloadStarted = deferred();
    const releaseLatePublication = deferred();
    const driveAbort = new AbortController();
    let now = 30_000;
    const deadlineAt = 31_000;
    const store = openVideoJobStore({ path: journalPath, now: () => now });
    const runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob: async () => ({ requestId: "private-request-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
      downloadVideo: async (_url, signal, options?: RuntimeVideoArtifactDownloadOptions) => {
        await options?.onReserveArtifact?.(artifactId);
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        downloadStarted.resolve();
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await releaseLatePublication.promise;
        await writeFile(finalPath, MP4, { mode: 0o600 });
        return finalPath;
      },
    });

    let shutdown: Promise<void> | undefined;
    try {
      const id = await submitAccepted(runtime, deadlineAt);
      const drive = runtime.driveVideoJob(id, driveAbort.signal);
      await downloadStarted.promise;
      now = deadlineAt;
      driveAbort.abort(new Error("deterministic deadline trigger"));
      expect(await drive).toMatchObject({ state: "expired", safeError: "timeout" });

      // An unrelated retention pass must not confirm the currently absent name
      // while the producer can still publish it.
      await runtime.runArtifactRetention();
      expect(store.getVideoJob(id)?.artifactId).toBe(artifactId);

      let shutdownSettled = false;
      shutdown = runtime.shutdown().then(() => { shutdownSettled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);

      releaseLatePublication.resolve();
      await shutdown;
      expect(await exists(finalPath)).toBe(false);

      const reopened = openVideoJobStore({ path: journalPath });
      expect(reopened.getVideoJob(id)).toMatchObject({ state: "expired", safeError: "timeout" });
      expect(reopened.getVideoJob(id)?.artifactId).toBeUndefined();
      reopened.close();
    } finally {
      releaseLatePublication.resolve();
      await shutdown;
      await runtime.shutdown();
    }
  });

  test("shutdown also awaits and removes a late unreserved compatibility publication", async () => {
    const root = await fixture("ccx-video-download-unreserved-shutdown-");
    const journalPath = join(root, "private", "journal.sqlite");
    const artifacts = getArtifactsDir();
    const artifactId = "vid-unreserved-late-publication.mp4";
    const finalPath = join(artifacts, artifactId);
    const downloadStarted = deferred();
    const releaseLatePublication = deferred();
    const driveAbort = new AbortController();
    let now = 40_000;
    const deadlineAt = 41_000;
    const store = openVideoJobStore({ path: journalPath, now: () => now });
    const runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob: async () => ({ requestId: "private-request-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
      downloadVideo: async (_url, signal) => {
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        downloadStarted.resolve();
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await releaseLatePublication.promise;
        await writeFile(finalPath, MP4, { mode: 0o600 });
        return finalPath;
      },
    });

    let shutdown: Promise<void> | undefined;
    try {
      const id = await submitAccepted(runtime, deadlineAt);
      const drive = runtime.driveVideoJob(id, driveAbort.signal);
      await downloadStarted.promise;
      now = deadlineAt;
      driveAbort.abort(new Error("deterministic deadline trigger"));
      expect(await drive).toMatchObject({ state: "expired", safeError: "timeout" });
      expect(store.getVideoJob(id)?.artifactId).toBeUndefined();

      let shutdownSettled = false;
      shutdown = runtime.shutdown().then(() => { shutdownSettled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);

      releaseLatePublication.resolve();
      await shutdown;
      expect(await exists(finalPath)).toBe(false);
    } finally {
      releaseLatePublication.resolve();
      await shutdown;
      await runtime.shutdown();
    }
  });

  test("shutdown before deadline drains publication and restart expires it instead of adopting", async () => {
    const root = await fixture("ccx-video-download-shutdown-restart-");
    const journalPath = join(root, "private", "journal.sqlite");
    const artifacts = getArtifactsDir();
    const artifactId = "vid-shutdown-restart.mp4";
    const finalPath = join(artifacts, artifactId);
    const downloadStarted = deferred();
    const downloadAborted = deferred();
    const releaseLatePublication = deferred();
    let now = 50_000;
    const deadlineAt = 51_000;
    const store = openVideoJobStore({ path: journalPath, now: () => now });
    const runtime = new MediaRuntime(store, {
      now: () => now,
      submitVideoJob: async () => ({ requestId: "private-request-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
      downloadVideo: async (_url, signal, options?: RuntimeVideoArtifactDownloadOptions) => {
        await options?.onReserveArtifact?.(artifactId);
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        downloadStarted.resolve();
        await new Promise<void>(resolve => {
          const finish = () => {
            downloadAborted.resolve();
            resolve();
          };
          if (signal?.aborted) finish();
          else signal?.addEventListener("abort", finish, { once: true });
        });
        await releaseLatePublication.promise;
        await writeFile(finalPath, MP4, { mode: 0o600 });
        return finalPath;
      },
    });

    let shutdown: Promise<void> | undefined;
    try {
      const id = await submitAccepted(runtime, deadlineAt);
      runtime.startVideoJob(id);
      await downloadStarted.promise;
      let shutdownSettled = false;
      shutdown = runtime.shutdown().then(() => { shutdownSettled = true; });
      await downloadAborted.promise;
      for (let attempt = 0; attempt < 20 && store.getVideoJob(id)?.state !== "download_failed"; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(store.getVideoJob(id)).toMatchObject({
        state: "download_failed",
        safeError: "cancelled",
        artifactId,
      });
      expect(shutdownSettled).toBe(false);

      releaseLatePublication.resolve();
      await shutdown;
      expect(await exists(finalPath)).toBe(true);

      now = deadlineAt + 1;
      let polls = 0;
      let downloads = 0;
      const reopenedStore = openVideoJobStore({ path: journalPath, now: () => now });
      const reopenedRuntime = new MediaRuntime(reopenedStore, {
        now: () => now,
        pollVideoJob: async () => {
          polls += 1;
          throw new Error("shutdown-expired reservation must not poll");
        },
        downloadVideo: async () => {
          downloads += 1;
          throw new Error("shutdown-expired reservation must not download");
        },
      });
      try {
        const recovered = await reopenedRuntime.recoverOnStartup();
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).toMatchObject({ state: "expired", safeError: "timeout" });
        expect(polls).toBe(0);
        expect(downloads).toBe(0);
        expect(await exists(finalPath)).toBe(false);
        expect(reopenedStore.getVideoJob(id)?.artifactId).toBeUndefined();
      } finally {
        await reopenedRuntime.shutdown();
      }
    } finally {
      releaseLatePublication.resolve();
      await shutdown;
      await runtime.shutdown();
    }
  });

  test("completes a download before the deadline and preserves its artifact", async () => {
    const root = await fixture("ccx-video-download-success-");
    const artifacts = getArtifactsDir();
    const artifactId = "vid-before-deadline.mp4";
    const deadlineAt = Date.now() + 2_000;
    let observedDeadlineAt: number | undefined;
    let observedSignal: AbortSignal | undefined;
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite") });
    const runtime = new MediaRuntime(store, {
      submitVideoJob: async () => ({ requestId: "private-request-id" }),
      pollVideoJob: async () => ({ status: "done", videoUrl: "https://signed.invalid/result" }),
      downloadVideo: async (_url, signal, options?: RuntimeVideoArtifactDownloadOptions) => {
        observedSignal = signal;
        observedDeadlineAt = options?.deadlineAt;
        await options?.onReserveArtifact?.(artifactId);
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        const path = join(artifacts, artifactId);
        await writeFile(path, MP4, { mode: 0o600 });
        return path;
      },
    });

    try {
      const id = await submitAccepted(runtime, deadlineAt);
      const result = await runtime.driveVideoJob(id);

      expect(observedDeadlineAt).toBe(deadlineAt);
      expect(observedSignal?.aborted).toBe(false);
      expect(result).toMatchObject({ state: "completed", artifactId });
      expect(await exists(join(artifacts, artifactId))).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe("private media recovery job id", () => {
  test.each(["extensible", "frozen"] as const)(
    "keeps the recovery id non-enumerable and non-serialized for an %s transport error",
    async kind => {
      const root = await fixture(`ccx-media-recovery-id-${kind}-`);
      const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite") });
      const original = mediaError({
        code: "ambiguous_submission",
        phase: "submit",
        certainty: "ambiguous",
        reason: "incomplete_response",
      });
      if (kind === "frozen") Object.freeze(original);
      const runtime = new MediaRuntime(store, {
        submitVideoJob: async () => { throw original; },
      });

      try {
        let caught: unknown;
        try {
          await runtime.submitVideo({
            binding,
            deadlineAt: Date.now() + 1_000,
            request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
          });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(MediaTransportError);
        if (kind === "extensible") expect(caught).toBe(original);
        else expect(caught).not.toBe(original);
        expect((caught as MediaTransportError).toJSON()).toEqual(original.toJSON());
        const recoveryId = mediaRecoveryJobId(caught);
        expect(recoveryId).toBe(store.listVideoJobs()[0]?.id);
        expect(Object.keys(caught as object)).not.toContain("mediaRecoveryJobId");
        expect(JSON.stringify(caught)).not.toContain(recoveryId!);
        const recoveryDescriptor = Object.getOwnPropertySymbols(caught as object)
          .map(symbol => Object.getOwnPropertyDescriptor(caught as object, symbol))
          .find(descriptor => descriptor?.value === recoveryId);
        expect(recoveryDescriptor?.enumerable).toBe(false);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  test("tags the original late rejection after shutdown already persisted outcome_unknown", async () => {
    const root = await fixture("ccx-media-recovery-late-rejection-");
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite") });
    const submitStarted = deferred();
    const releaseSubmit = deferred();
    const original = new Error("fixed late submission rejection");
    const runtime = new MediaRuntime(store, {
      submitVideoJob: async () => {
        submitStarted.resolve();
        await releaseSubmit.promise;
        throw original;
      },
    });

    try {
      const submission = runtime.submitVideo({
        binding,
        deadlineAt: Date.now() + 1_000,
        request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
      });
      await submitStarted.promise;
      runtime.beginShutdown();
      releaseSubmit.resolve();
      const caught = await captureRejection(submission);
      const job = store.listVideoJobs()[0]!;
      expect(caught).toBe(original);
      expect(mediaRecoveryJobId(caught)).toBe(job.id);
      expect(job).toMatchObject({ state: "outcome_unknown", safeError: "ambiguous_submission" });
    } finally {
      releaseSubmit.resolve();
      await runtime.shutdown();
    }
  });

  test("returns a tagged safe ambiguity when shutdown wins before a successful POST resolves", async () => {
    const root = await fixture("ccx-media-recovery-late-success-");
    const store = openVideoJobStore({ path: join(root, "private", "journal.sqlite") });
    const submitStarted = deferred();
    const releaseSubmit = deferred();
    const runtime = new MediaRuntime(store, {
      submitVideoJob: async () => {
        submitStarted.resolve();
        await releaseSubmit.promise;
        return { requestId: "private-late-request-id" };
      },
    });

    try {
      const submission = runtime.submitVideo({
        binding,
        deadlineAt: Date.now() + 1_000,
        request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
      });
      await submitStarted.promise;
      runtime.beginShutdown();
      releaseSubmit.resolve();
      const caught = await captureRejection(submission);
      const job = store.listVideoJobs()[0]!;
      expect(caught).toMatchObject({
        name: "MediaTransportError",
        code: "ambiguous_submission",
        phase: "submit",
        certainty: "ambiguous",
      });
      expect(mediaRecoveryJobId(caught)).toBe(job.id);
      expect(JSON.stringify(caught)).not.toContain(job.id);
      expect(job).toMatchObject({ state: "outcome_unknown", safeError: "ambiguous_submission" });
    } finally {
      releaseSubmit.resolve();
      await runtime.shutdown();
    }
  });

  test("tags a post-dispatch acceptance CAS conflict and restart never resubmits", async () => {
    const root = await fixture("ccx-media-recovery-accept-conflict-");
    const journalPath = join(root, "private", "journal.sqlite");
    let submitCalls = 0;
    const store = openVideoJobStore({ path: journalPath });
    const commitAccepted = store.commitVideoAccepted.bind(store);
    store.commitVideoAccepted = (id, expectedRevision, requestId) => {
      const current = store.getVideoJob(id);
      if (!current) throw new Error("expected durable submitting job");
      const changed = store.transitionVideoJob({
        id,
        expectedRevision: current.revision,
        from: ["submitting"],
        to: "outcome_unknown",
        safeError: "ambiguous_submission",
      });
      if (changed.kind !== "updated") throw new Error("expected injected outcome_unknown transition");
      return commitAccepted(id, expectedRevision, requestId);
    };
    const runtime = new MediaRuntime(store, {
      submitVideoJob: async () => {
        submitCalls += 1;
        return { requestId: "private-conflicted-request-id" };
      },
    });

    const caught = await captureRejection(runtime.submitVideo({
      binding,
      deadlineAt: Date.now() + 1_000,
      request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
    }));
    const job = store.listVideoJobs()[0]!;
    expect(caught).toMatchObject({ code: "ambiguous_submission", certainty: "ambiguous" });
    expect(mediaRecoveryJobId(caught)).toBe(job.id);
    expect(job).toMatchObject({ state: "outcome_unknown", safeError: "ambiguous_submission" });
    expect(submitCalls).toBe(1);
    await runtime.shutdown();

    const reopenedStore = openVideoJobStore({ path: journalPath });
    const reopenedRuntime = new MediaRuntime(reopenedStore, {
      submitVideoJob: async () => {
        submitCalls += 1;
        throw new Error("must not resubmit outcome_unknown work");
      },
    });
    try {
      await reopenedRuntime.recoverOnStartup();
      expect(submitCalls).toBe(1);
      expect(reopenedStore.getVideoJob(job.id)?.state).toBe("outcome_unknown");
    } finally {
      await reopenedRuntime.shutdown();
    }
  });

  test("tags a thrown acceptance commit and restart recovers without resubmission even if fallback fencing fails", async () => {
    for (const fallback of ["transitions", "throws"] as const) {
      const root = await fixture(`ccx-media-recovery-commit-throws-${fallback}-`);
      const journalPath = join(root, "private", "journal.sqlite");
      let submitCalls = 0;
      const store = openVideoJobStore({ path: journalPath });
      const original = new Error(`fixed ${fallback} acceptance commit failure`);
      store.commitVideoAccepted = () => {
        if (fallback === "throws") {
          store.transitionVideoJob = () => { throw new Error("injected fallback transition failure"); };
        }
        throw original;
      };
      const runtime = new MediaRuntime(store, {
        submitVideoJob: async () => {
          submitCalls += 1;
          return { requestId: "private-commit-throws-request-id" };
        },
      });

      const caught = await captureRejection(runtime.submitVideo({
        binding,
        deadlineAt: Date.now() + 1_000,
        request: { prompt: "ephemeral", model: "grok-imagine-video-1.5", duration: 1, resolution: "1080p" },
      }));
      const job = store.listVideoJobs()[0]!;
      expect(caught).toBe(original);
      expect(mediaRecoveryJobId(caught)).toBe(job.id);
      expect(JSON.stringify(caught)).not.toContain(job.id);
      expect(job.state).toBe(fallback === "transitions" ? "outcome_unknown" : "submitting");
      expect(submitCalls).toBe(1);
      await runtime.shutdown();

      const reopenedStore = openVideoJobStore({ path: journalPath });
      const reopenedRuntime = new MediaRuntime(reopenedStore, {
        submitVideoJob: async () => {
          submitCalls += 1;
          throw new Error("must not resubmit commit-uncertain work");
        },
      });
      try {
        await reopenedRuntime.recoverOnStartup();
        expect(submitCalls).toBe(1);
        expect(reopenedStore.getVideoJob(job.id)).toMatchObject({
          state: "outcome_unknown",
          safeError: "ambiguous_submission",
        });
      } finally {
        await reopenedRuntime.shutdown();
      }
    }
  });
});

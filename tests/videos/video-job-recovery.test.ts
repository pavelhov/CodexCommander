import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mediaError } from "../../src/images/media-errors";
import { MediaRuntime, RecoveryBlockedMediaRuntime } from "../../src/images/media-runtime";
import { openVideoJobStore } from "../../src/images/video-job-store";
import type { MediaCredentialBinding } from "../../src/images/types";
import type { ServerMediaRuntime, SubmitRuntimeVideoInput } from "../../src/images/media-runtime";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { drainAndShutdown, resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import type { CodexCommanderConfig } from "../../src/types";

const roots: string[] = [];
const binding: MediaCredentialBinding = {
  authSource: "subscription_oauth",
  providerKind: "canonical",
  slotRef: "media-slot:recovery-account",
  identityDigest: `sha256:${"c".repeat(64)}`,
};
const request = {
  prompt: "ephemeral prompt",
  model: "grok-imagine-video-1.5",
  duration: 6,
  resolution: "720p",
  aspectRatio: "16:9",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(prefix = "ccx-video-recovery-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return { root, path: join(root, "private", "media-journal.sqlite") };
}

async function settleBackground(runtime: MediaRuntime, id: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const job = runtime.getPublicVideoJob(id);
    if (!job || ["completed", "failed", "expired", "cancelled", "acknowledged", "outcome_unknown"].includes(job.state)) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("background video did not settle");
}

describe("durable video recovery", () => {
  test("idle shutdown releases the journal owner before returning its resolved flight", async () => {
    const f = await fixture("ccx-video-idle-shutdown-");
    const runtime = new MediaRuntime(
      openVideoJobStore({ path: f.path, now: () => 1_000 }),
      { now: () => 1_000 },
    );

    const shutdown = runtime.shutdown();
    const reopened = openVideoJobStore({ path: f.path, now: () => 1_001 });
    reopened.close();
    await shutdown;
  });

  test("repeated restart preserves one POST and the original absolute deadline", async () => {
    const f = await fixture();
    const submit = mock(async () => ({ requestId: "accepted-private-id" }));
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    let runtime = new MediaRuntime(store, { now: () => 1_000, submitVideoJob: submit });
    const submitted = await runtime.submitVideo({ binding, deadlineAt: 61_000, request });
    if (submitted.kind !== "accepted") throw new Error("expected accepted job");
    const id = submitted.job.id;
    store.close(); // simulated process loss after accepted commit

    let polls = 0;
    store = openVideoJobStore({ path: f.path, now: () => 2_000 });
    runtime = new MediaRuntime(store, {
      now: () => 2_000,
      submitVideoJob: submit,
      pollVideoJob: async (_requestId, observedBinding) => {
        expect(observedBinding).toEqual(binding);
        return ++polls === 1
          ? { status: "processing" }
          : { status: "done", videoUrl: "https://signed.invalid/result" };
      },
      downloadVideo: async () => join(f.root, "artifacts", "vid-recovered.mp4"),
      sleep: async () => {},
      pollIntervalMs: 1,
    });
    runtime.prepareStartup();
    runtime.startBackgroundRecovery();
    await settleBackground(runtime, id);
    expect(runtime.getPublicVideoJob(id)).toMatchObject({ state: "completed", deadlineAt: 61_000 });
    expect(submit).toHaveBeenCalledTimes(1);
    await runtime.shutdown();

    store = openVideoJobStore({ path: f.path, now: () => 3_000 });
    runtime = new MediaRuntime(store, { now: () => 3_000, submitVideoJob: submit });
    expect(runtime.prepareStartup().pollable).toEqual([]);
    expect(runtime.getPublicVideoJob(id)).toMatchObject({ state: "completed", deadlineAt: 61_000 });
    expect(submit).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });

  test("a completed-turn retry replays the durable result without a second paid POST", async () => {
    const f = await fixture("ccx-video-operation-replay-");
    const submit = mock(async () => ({ requestId: "accepted-private-id" }));
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const runtime = new MediaRuntime(store, { now: () => 1_000, submitVideoJob: submit });
    const operationKey = `sha256:${"8".repeat(64)}`;
    const first = await runtime.submitVideo({ binding, deadlineAt: 61_000, request, operationKey });
    if (first.kind !== "accepted") throw new Error("expected accepted job");

    const accepted = store.getVideoJob(first.job.id);
    if (!accepted) throw new Error("expected durable accepted job");
    const polling = store.transitionVideoJob({
      id: accepted.id, expectedRevision: accepted.revision, from: ["accepted"], to: "polling",
    });
    if (polling.kind !== "updated") throw new Error("expected polling");
    const downloading = store.reserveVideoArtifact(polling.job.id, polling.job.revision, "vid-idempotent.mp4");
    if (downloading.kind !== "updated") throw new Error("expected downloading");
    const completed = store.completeVideoArtifact(downloading.job.id, downloading.job.revision, "vid-idempotent.mp4");
    if (completed.kind !== "updated") throw new Error("expected completion");

    const retry = await runtime.submitVideo({ binding, deadlineAt: 61_000, request, operationKey });
    expect(retry.kind).toBe("replay");
    if (retry.kind !== "replay") throw new Error("expected completed replay");
    expect(retry.job).toEqual(store.publicVideoJob(first.job.id)!);
    expect(retry.job.state).toBe("completed");
    expect(typeof retry.releaseArtifactDeliveryLease).toBe("function");
    retry.releaseArtifactDeliveryLease?.();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.listVideoJobs()).toHaveLength(1);
    await runtime.shutdown();
  });

  test("definite pre-dispatch auth failure releases exact retry admission across restart", async () => {
    const f = await fixture("ccx-video-predispatch-auth-retry-");
    const operationKey = `sha256:${"9".repeat(64)}`;
    let credentialReady = false;
    let paidPosts = 0;
    const submit = mock(async () => {
      if (!credentialReady) {
        throw mediaError({
          code: "needs_auth",
          phase: "pre_dispatch",
          certainty: "definite",
          reason: "credential_unavailable",
        });
      }
      paidPosts += 1;
      return { requestId: "accepted-after-auth" };
    });

    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    let runtime = new MediaRuntime(store, { now: () => 1_000, submitVideoJob: submit });
    await expect(runtime.submitVideo({ binding, deadlineAt: 61_000, request, operationKey }))
      .rejects.toMatchObject({
        code: "needs_auth",
        phase: "pre_dispatch",
        certainty: "definite",
      });
    expect(paidPosts).toBe(0);
    const released = store.listVideoJobs();
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ state: "failed", safeError: "needs_auth" });
    expect(released[0]).not.toHaveProperty("requestId");
    expect(released[0]).not.toHaveProperty("operationKey");
    expect(released[0]).not.toHaveProperty("requestSemanticsDigest");
    const failedId = released[0]!.id;
    await runtime.shutdown();

    credentialReady = true;
    store = openVideoJobStore({ path: f.path, now: () => 2_000 });
    runtime = new MediaRuntime(store, { now: () => 2_000, submitVideoJob: submit });
    const retried = await runtime.submitVideo({ binding, deadlineAt: 62_000, request, operationKey });
    if (retried.kind !== "accepted") throw new Error("expected retry admission after auth recovery");
    expect(retried.job.id).not.toBe(failedId);
    expect(paidPosts).toBe(1);

    const replay = await runtime.submitVideo({ binding, deadlineAt: 62_000, request, operationKey });
    expect(replay).toEqual({ kind: "replay", job: retried.job });
    expect(paidPosts).toBe(1);
    expect(submit).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });

  test("safe GET failures, missing auth, pending, and done retry without resubmission", async () => {
    const f = await fixture();
    const submit = mock(async () => ({ requestId: "accepted-id" }));
    const outcomes: Array<"pending" | "429" | "network" | "auth" | "done"> = [
      "pending", "429", "network", "auth", "done",
    ];
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const runtime = new MediaRuntime(store, {
      now: () => 1_000,
      submitVideoJob: submit,
      pollVideoJob: async () => {
        const outcome = outcomes.shift();
        if (outcome === "pending") return { status: "processing" };
        if (outcome === "429") throw mediaError({
          code: "poll_retryable", phase: "poll", certainty: "definite", retryable: true, status: 429,
        });
        if (outcome === "network") throw mediaError({
          code: "poll_retryable", phase: "poll", certainty: "definite", retryable: true, reason: "network",
        });
        if (outcome === "auth") throw mediaError({
          code: "needs_auth", phase: "pre_dispatch", certainty: "definite", reason: "credential_unavailable",
        });
        return { status: "done", videoUrl: "https://signed.invalid/result" };
      },
      downloadVideo: async () => join(f.root, "artifacts", "vid-retried.mp4"),
      sleep: async () => {},
      pollIntervalMs: 1,
    });
    const submitted = await runtime.submitVideo({ binding, deadlineAt: 61_000, request });
    if (submitted.kind !== "accepted") throw new Error("expected accepted job");
    runtime.startVideoJob(submitted.job.id);
    await settleBackground(runtime, submitted.job.id);
    expect(runtime.getPublicVideoJob(submitted.job.id)?.state).toBe("completed");
    expect(outcomes).toEqual([]);
    expect(submit).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });

  test("honors a bounded safe GET retry hint within the original deadline", async () => {
    const f = await fixture();
    const sleeps: number[] = [];
    let polls = 0;
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const runtime = new MediaRuntime(store, {
      now: () => 1_000,
      submitVideoJob: async () => ({ requestId: "accepted-id" }),
      pollVideoJob: async () => {
        polls += 1;
        if (polls === 1) throw mediaError({
          code: "poll_retryable",
          phase: "poll",
          certainty: "definite",
          retryable: true,
          status: 429,
          retryAfterMs: 20_000,
        });
        return { status: "done", videoUrl: "https://signed.invalid/result" };
      },
      downloadVideo: async () => join(f.root, "artifacts", "vid-retry-hint.mp4"),
      sleep: async ms => { sleeps.push(ms); },
      pollIntervalMs: 1,
    });
    const submitted = await runtime.submitVideo({ binding, deadlineAt: 11_000, request });
    if (submitted.kind !== "accepted") throw new Error("expected accepted job");
    runtime.startVideoJob(submitted.job.id);
    await settleBackground(runtime, submitted.job.id);
    expect(sleeps[0]).toBe(10_000);
    expect(runtime.getPublicVideoJob(submitted.job.id)?.deadlineAt).toBe(11_000);
    await runtime.shutdown();
  });

  test("cancel before reservation performs no paid call", async () => {
    const f = await fixture();
    const submit = mock(async () => ({ requestId: "unexpected" }));
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const runtime = new MediaRuntime(store, { now: () => 1_000, submitVideoJob: submit });
    const turn = new AbortController();
    turn.abort(new Error("cancelled before submit"));
    await expect(runtime.submitVideo({ binding, deadlineAt: 61_000, request, signal: turn.signal }))
      .rejects.toMatchObject({ code: "cancelled", phase: "pre_dispatch" });
    expect(store.listVideoJobs()).toEqual([]);
    expect(submit).toHaveBeenCalledTimes(0);
    await runtime.shutdown();
  });

  test("disconnect after acceptance detaches only the waiter while background work completes", async () => {
    const f = await fixture();
    let finishPoll!: () => void;
    const pollGate = new Promise<void>(resolve => { finishPoll = resolve; });
    const store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const runtime = new MediaRuntime(store, {
      now: () => 1_000,
      submitVideoJob: async () => ({ requestId: "accepted-id" }),
      pollVideoJob: async () => { await pollGate; return { status: "done", videoUrl: "https://signed.invalid/result" }; },
      downloadVideo: async () => join(f.root, "artifacts", "vid-detached.mp4"),
      sleep: async () => {},
    });
    const turn = new AbortController();
    const submitted = await runtime.submitVideo({ binding, deadlineAt: 61_000, request, signal: turn.signal });
    if (submitted.kind !== "accepted") throw new Error("expected accepted job");
    runtime.startVideoJob(submitted.job.id);
    const firstUpdate = await runtime.waitForVideoUpdate(submitted.job.id, submitted.job.revision, { signal: turn.signal });
    expect(firstUpdate.kind).toBe("updated");
    const revision = firstUpdate.kind === "updated" ? firstUpdate.job.revision : submitted.job.revision;
    const waiting = runtime.waitForVideoUpdate(submitted.job.id, revision, { signal: turn.signal });
    turn.abort(new Error("client disconnected"));
    expect(await waiting).toMatchObject({ kind: "detached" });
    finishPoll();
    await settleBackground(runtime, submitted.job.id);
    expect(runtime.getPublicVideoJob(submitted.job.id)?.state).toBe("completed");
    await runtime.shutdown();
  });

  test("shutdown marks an in-flight POST outcome unknown before abort and never replays it", async () => {
    const f = await fixture();
    let dispatched!: () => void;
    const dispatchObserved = new Promise<void>(resolve => { dispatched = resolve; });
    const submit = mock((_request, _binding, signal?: AbortSignal) => new Promise<{ requestId: string }>((_resolve, reject) => {
      dispatched();
      signal?.addEventListener("abort", () => reject(mediaError({
        code: "ambiguous_submission", phase: "submit", certainty: "ambiguous", reason: "cancelled",
      })), { once: true });
    }));
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const runtime = new MediaRuntime(store, { now: () => 1_000, submitVideoJob: submit });
    const submission = runtime.submitVideo({ binding, deadlineAt: 61_000, request });
    await dispatchObserved;
    runtime.beginShutdown();
    await expect(submission).rejects.toMatchObject({ code: "ambiguous_submission" });
    await runtime.shutdown();

    store = openVideoJobStore({ path: f.path, now: () => 2_000 });
    const recovered = new MediaRuntime(store, { now: () => 2_000, submitVideoJob: submit });
    expect(recovered.prepareStartup().pollable).toEqual([]);
    expect(store.listVideoJobs()[0]).toMatchObject({ state: "outcome_unknown", safeError: "ambiguous_submission" });
    expect(submit).toHaveBeenCalledTimes(1);
    await recovered.shutdown();
  });

  test("shutdown aborts accepted polling without marking the recoverable job failed", async () => {
    const f = await fixture();
    let polling!: () => void;
    const pollStarted = new Promise<void>(resolve => { polling = resolve; });
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const runtime = new MediaRuntime(store, {
      now: () => 1_000,
      submitVideoJob: async () => ({ requestId: "accepted-id" }),
      pollVideoJob: (_requestId, _binding, signal) => new Promise((_resolve, reject) => {
        polling();
        signal?.addEventListener("abort", () => reject(mediaError({
          code: "cancelled",
          phase: "poll",
          certainty: "definite",
          reason: "cancelled",
        })), { once: true });
      }),
    });
    const submitted = await runtime.submitVideo({ binding, deadlineAt: 61_000, request });
    if (submitted.kind !== "accepted") throw new Error("expected accepted job");
    runtime.startVideoJob(submitted.job.id);
    await pollStarted;
    runtime.beginShutdown();
    await runtime.shutdown();

    store = openVideoJobStore({ path: f.path, now: () => 2_000 });
    expect(store.getVideoJob(submitted.job.id)).toMatchObject({ state: "accepted", safeError: "cancelled" });
    expect(store.recoverStartup().pollable).toEqual([submitted.job.id]);
    store.close();
  });
});

describe("journal recovery blocking", () => {
  test("valid-looking fenced binding substitution blocks restart before replacement paid admission", async () => {
    const f = await fixture("ccx-video-malformed-fence-");
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const reserved = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
    if (reserved.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected submission fence");
    store.close();

    const corrupt = new Database(f.path);
    const substitutedDigest = `sha256:${"d".repeat(64)}`;
    corrupt.query("UPDATE video_jobs SET binding_digest = ? WHERE id = ?").run(substitutedDigest, fenced.job.id);
    corrupt.close();

    const paidSubmit = mock(async () => ({ requestId: "must-not-dispatch" }));
    let recovered: ServerMediaRuntime;
    try {
      store = openVideoJobStore({ path: f.path, now: () => 2_000 });
      recovered = new MediaRuntime(store, { now: () => 2_000, submitVideoJob: paidSubmit });
    } catch {
      recovered = new RecoveryBlockedMediaRuntime();
    }
    await expect(recovered.submitVideo({ binding, deadlineAt: 62_000, request }))
      .rejects.toMatchObject({
        name: "MediaRecoveryBlockedError",
        message: "video recovery is unavailable (recovery_blocked)",
      });
    expect(paidSubmit).toHaveBeenCalledTimes(0);
    await recovered.shutdown();

    const proof = new Database(f.path, { readonly: true });
    expect(proof.query<{ state: string; binding_digest: string }, [string]>(
      "SELECT state, binding_digest FROM video_jobs WHERE id = ?",
    ).get(fenced.job.id)).toEqual({ state: "submitting", binding_digest: substitutedDigest });
    proof.close();
  });

  test("coordinated accepted-row rewind blocks restart before recovery or paid admission", async () => {
    const f = await fixture("ccx-video-invalid-state-fields-");
    let store = openVideoJobStore({ path: f.path, now: () => 1_000 });
    const operationKey = `sha256:${"4".repeat(64)}`;
    const requestSemanticsDigest = `sha256:${"5".repeat(64)}`;
    const reserved = store.reserveVideoJob({
      binding,
      deadlineAt: 61_000,
      operationKey,
      requestSemanticsDigest,
    });
    if (reserved.kind !== "created") throw new Error("expected reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected submission fence");
    const accepted = store.commitVideoAccepted(fenced.job.id, fenced.job.revision, "accepted-before-corruption");
    if (accepted.kind !== "updated") throw new Error("expected accepted job");
    store.close();

    const corrupt = new Database(f.path);
    corrupt.query(`
      UPDATE video_jobs
         SET state = 'queued', revision = 0, request_id = NULL, safe_error = NULL,
             operation_key = NULL, request_semantics_digest = NULL, updated_at = created_at
       WHERE id = ?
    `).run(accepted.job.id);
    corrupt.close();

    const paidSubmit = mock(async () => ({ requestId: "must-not-dispatch" }));
    let recovered: ServerMediaRuntime;
    try {
      store = openVideoJobStore({ path: f.path, now: () => 2_000 });
      recovered = new MediaRuntime(store, { now: () => 2_000, submitVideoJob: paidSubmit });
      recovered.prepareStartup();
    } catch {
      recovered = new RecoveryBlockedMediaRuntime();
    }
    await expect(recovered.submitVideo({ binding, deadlineAt: 62_000, request }))
      .rejects.toMatchObject({ name: "MediaRecoveryBlockedError" });
    expect(paidSubmit).toHaveBeenCalledTimes(0);
    await recovered.shutdown();

    const proof = new Database(f.path, { readonly: true });
    expect(proof.query<{
      state: string; revision: number; request_id: string | null; operation_key: string | null;
    }, [string]>(
      "SELECT state, revision, request_id, operation_key FROM video_jobs WHERE id = ?",
    ).get(accepted.job.id)).toEqual({ state: "queued", revision: 0, request_id: null, operation_key: null });
    proof.close();
  });

  test("future and corrupt journals fail closed without exposing variable diagnostics", async () => {
    for (const kind of ["future", "corrupt"] as const) {
      const f = await fixture(`ccx-video-${kind}-`);
      await mkdir(join(f.root, "private"), { recursive: true, mode: 0o700 });
      if (kind === "future") {
        const db = new Database(f.path, { create: true });
        db.exec("PRAGMA user_version = 999");
        db.close();
        if (process.platform !== "win32") await chmod(f.path, 0o600);
      } else {
        await writeFile(f.path, new Uint8Array([0, 1, 2, 3]), { mode: 0o600 });
      }
      expect(() => openVideoJobStore({ path: f.path })).toThrow();
      const blocked = new RecoveryBlockedMediaRuntime();
      await expect(blocked.submitVideo({ binding, deadlineAt: Date.now() + 10_000, request }))
        .rejects.toMatchObject({ name: "MediaRecoveryBlockedError", message: "video recovery is unavailable (recovery_blocked)" });
    }
  });

  test("a symlink journal is rejected", async () => {
    if (process.platform === "win32") return;
    const f = await fixture("ccx-video-symlink-");
    await mkdir(join(f.root, "private"), { recursive: true, mode: 0o700 });
    const target = join(f.root, "target.sqlite");
    await writeFile(target, "not a journal", { mode: 0o600 });
    await symlink(target, f.path);
    expect(() => openVideoJobStore({ path: f.path })).toThrow("journal file is unsafe");
  });

  test("a group-readable journal is rejected instead of silently repaired", async () => {
    if (process.platform === "win32") return;
    const f = await fixture("ccx-video-permissions-");
    const store = openVideoJobStore({ path: f.path });
    store.close();
    await chmod(f.path, 0o640);
    expect(() => openVideoJobStore({ path: f.path })).toThrow("unsafe ownership or permissions");
  });
});

describe("server-owned video lifecycle", () => {
  function fakeRuntime(events: string[]): ServerMediaRuntime {
    return {
      prepareStartup() {
        events.push("prepare");
        return { cancelledBeforeDispatch: [], outcomeUnknown: [], pollable: [] };
      },
      startBackgroundRecovery() { events.push("start"); },
      beginShutdown() { events.push("begin-shutdown"); },
      async shutdown() { events.push("shutdown"); },
      async submitVideo(_input: SubmitRuntimeVideoInput) { throw new Error("unused"); },
      startVideoJob() {},
      getPublicVideoJob() { return null; },
      async waitForVideoUpdate() { return { kind: "missing" }; },
    };
  }

  async function withServer(
    run: (server: ReturnType<typeof startServer>, events: string[]) => Promise<void>,
  ): Promise<void> {
    const f = await fixture("ccx-video-server-");
    const previousCommanderHome = process.env.CODEXCOMMANDER_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEXCOMMANDER_HOME = f.root;
    process.env.CODEX_HOME = join(f.root, "codex");
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
    } as CodexCommanderConfig);
    const events: string[] = [];
    const server = startServer(0, { mediaRuntime: fakeRuntime(events) });
    try {
      await Promise.resolve();
      await run(server, events);
    } finally {
      try { await server.stop(true); } catch { /* already stopped */ }
      resetLifecycleDrainStateForTests();
      if (previousCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previousCommanderHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  }

  test("direct server.stop fences and closes the runtime exactly once", async () => {
    await withServer(async (server, events) => {
      await server.stop(true);
      expect(events[0]).toBe("prepare");
      expect(events).toContain("start");
      expect(events.filter(event => event === "begin-shutdown")).toHaveLength(1);
      expect(events.filter(event => event === "shutdown")).toHaveLength(1);
    });
  });

  test("normal drain fences the runtime before listener stop and single-flights cleanup", async () => {
    await withServer(async (server, events) => {
      await drainAndShutdown(server, 0);
      const begin = events.indexOf("begin-shutdown");
      const shutdown = events.indexOf("shutdown");
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(shutdown).toBeGreaterThan(begin);
      expect(events.filter(event => event === "shutdown")).toHaveLength(1);
    });
  });
});

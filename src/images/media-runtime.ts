import { basename } from "node:path";
import { existsSync } from "node:fs";

import {
  adoptReservedVideoArtifact,
  DEFAULT_ARTIFACT_KEEP_COUNT,
  downloadVideoToArtifact,
  getArtifactsDir,
  type VideoArtifactDownloadOptions,
} from "./artifacts";
import { pruneMediaArtifacts } from "./artifact-retention";
import {
  isMediaTransportError,
  mediaError,
  safeMediaFailure,
  type MediaTransportError,
} from "./media-errors";
import type { MediaCredentialBinding } from "./types";
import {
  pollVideoJob as pollXaiVideoJob,
  submitVideoJob as submitXaiVideoJob,
  type XaiVideoPollResult,
  type XaiVideoSubmitRequest,
  type XaiVideoSubmitResult,
} from "./xai-video-client";
import {
  VIDEO_ADMISSION_HOLDING_STATES,
  type ArtifactPinReleaseResult,
  type ArtifactPinPreflightResult,
  type ArtifactPinFinalizeResult,
  type PublicVideoJob,
  type VideoJobRecord,
  type VideoJobStore,
  type VideoJobUpdate,
} from "./video-job-store";

export type MediaRuntimeCrashSeam =
  | "before_fence"
  | "after_fence"
  | "after_request_id"
  | "after_accepted_commit"
  | "after_artifact_reserved"
  | "after_artifact_published";

export interface MediaRuntimeDeps {
  now?: () => number;
  submitVideoJob?: (
    request: XaiVideoSubmitRequest,
    binding: MediaCredentialBinding,
    signal?: AbortSignal,
    options?: { deadlineAt?: number; timeoutMs?: number },
  ) => Promise<XaiVideoSubmitResult>;
  pollVideoJob?: (
    requestId: string,
    binding: MediaCredentialBinding,
    signal?: AbortSignal,
    options?: { deadlineAt?: number; timeoutMs?: number },
  ) => Promise<XaiVideoPollResult>;
  downloadVideo?: (
    url: string,
    signal?: AbortSignal,
    options?: VideoArtifactDownloadOptions,
  ) => Promise<string>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  /** Shared image/video artifact cap. Defaults to the canonical retention limit. */
  artifactsKeepCount?: number;
  /** Test-only hard-crash seam. A thrown error deliberately leaves the last durable state untouched. */
  crashSeam?: (seam: MediaRuntimeCrashSeam, job: PublicVideoJob) => void;
}

export interface SubmitRuntimeVideoInput {
  binding: MediaCredentialBinding;
  deadlineAt: number;
  request: XaiVideoSubmitRequest;
  /** Used only to reject cancellation before reservation/fencing. Live disconnect never owns the job. */
  signal?: AbortSignal;
  probeOperationId?: string;
  confirmationRevision?: number;
}

export type SubmitRuntimeVideoResult =
  | { kind: "accepted"; job: PublicVideoJob }
  | { kind: "busy"; reservationId: string; job?: PublicVideoJob };

export type WaitForVideoUpdateResult =
  | { kind: "updated"; job: PublicVideoJob }
  | { kind: "timeout"; job: PublicVideoJob | null }
  | { kind: "detached"; job: PublicVideoJob | null }
  | { kind: "missing" };

export interface ModelVideoRuntime {
  submitVideo(input: SubmitRuntimeVideoInput): Promise<SubmitRuntimeVideoResult>;
  startVideoJob(id: string): void;
  getPublicVideoJob(id: string): PublicVideoJob | null;
  waitForVideoUpdate(
    id: string,
    afterRevision: number,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<WaitForVideoUpdateResult>;
  /** Hold the runtime's own completed-job pin until one consumer finishes replay/delivery. */
  acquireArtifactDeliveryLease?(artifactId: string): () => void;
}

export interface ServerMediaRuntime extends ModelVideoRuntime {
  prepareStartup(): { cancelledBeforeDispatch: string[]; outcomeUnknown: string[]; pollable: string[] };
  startBackgroundRecovery(): void;
  beginShutdown(): void;
  shutdown(): Promise<void>;
  /** Optional durable artifact pins consumed by the shared retention coordinator. */
  protectedArtifactIds?(): ReadonlySet<string>;
  /** Exact durable video reservations eligible for publication crash recovery. */
  recoverablePublicationArtifactIds?(): ReadonlySet<string>;
  /** Non-mutating retention release preflight. */
  canReleaseArtifactForPrune?(artifactId: string): ArtifactPinPreflightResult;
  releaseArtifactForPrune?(artifactId: string): ArtifactPinReleaseResult;
  pendingArtifactDeletionIds?(): ReadonlySet<string>;
  finalizeArtifactPrune?(artifactId: string): ArtifactPinFinalizeResult;
  /** Serialized runtime-owned retention pass, safe before global pin registration. */
  runArtifactRetention?(): Promise<void>;
}

function requireUpdated(update: VideoJobUpdate): VideoJobRecord {
  if (update.kind !== "updated") {
    const error = new Error("The durable media job changed concurrently.");
    error.name = "MediaRuntimeConflict";
    throw error;
  }
  return update.job;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    function finish(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stoppingError(): MediaTransportError {
  return mediaError({ code: "cancelled", phase: "pre_dispatch", certainty: "definite", reason: "cancelled" });
}

function terminal(state: PublicVideoJob["state"]): boolean {
  return !VIDEO_ADMISSION_HOLDING_STATES.includes(state);
}

type UpdateWaiter = (result: WaitForVideoUpdateResult) => void;

/**
 * Sole owner of billable video submission fences and restart recovery.
 * Prompts and signed result URLs remain request-local and never enter the store.
 */
export class MediaRuntime implements ServerMediaRuntime {
  readonly #store: VideoJobStore;
  readonly #now: () => number;
  readonly #submit: NonNullable<MediaRuntimeDeps["submitVideoJob"]>;
  readonly #poll: NonNullable<MediaRuntimeDeps["pollVideoJob"]>;
  readonly #download: NonNullable<MediaRuntimeDeps["downloadVideo"]>;
  readonly #sleep: NonNullable<MediaRuntimeDeps["sleep"]>;
  readonly #pollIntervalMs: number;
  readonly #artifactsKeepCount: number;
  readonly #crashSeam?: MediaRuntimeDeps["crashSeam"];
  readonly #submissionControllers = new Map<string, AbortController>();
  readonly #submissionFlights = new Map<string, Promise<unknown>>();
  readonly #runnerControllers = new Map<string, AbortController>();
  readonly #runnerFlights = new Map<string, Promise<void>>();
  readonly #retryDelays = new Map<string, number>();
  readonly #waiters = new Map<string, Set<UpdateWaiter>>();
  readonly #pendingDeliveryArtifactIds = new Set<string>();
  readonly #artifactDeliveryLeaseCounts = new Map<string, number>();
  #prepared: ReturnType<VideoJobStore["recoverStartup"]> | undefined;
  #accepting = true;
  #closed = false;
  #shutdownFlight: Promise<void> | undefined;
  #retentionTail: Promise<void> | undefined;

  constructor(store: VideoJobStore, deps: MediaRuntimeDeps = {}) {
    this.#store = store;
    this.#now = deps.now ?? Date.now;
    this.#submit = deps.submitVideoJob ?? submitXaiVideoJob;
    this.#poll = deps.pollVideoJob ?? pollXaiVideoJob;
    this.#download = deps.downloadVideo
      ?? (async (url, signal, options) => downloadVideoToArtifact(url, undefined, signal, options));
    this.#sleep = deps.sleep ?? sleepWithAbort;
    this.#pollIntervalMs = typeof deps.pollIntervalMs === "number" && Number.isFinite(deps.pollIntervalMs)
      ? Math.max(1, Math.floor(deps.pollIntervalMs))
      : 5_000;
    this.#artifactsKeepCount = typeof deps.artifactsKeepCount === "number"
      && Number.isSafeInteger(deps.artifactsKeepCount)
      ? deps.artifactsKeepCount
      : DEFAULT_ARTIFACT_KEEP_COUNT;
    this.#crashSeam = deps.crashSeam;
  }

  #public(record: VideoJobRecord): PublicVideoJob {
    const projected = this.#store.publicVideoJob(record.id);
    if (!projected) throw new Error("The durable media job is unavailable.");
    return projected;
  }

  #notify(id: string): void {
    const listeners = this.#waiters.get(id);
    if (!listeners?.size) return;
    this.#waiters.delete(id);
    const job = this.getPublicVideoJob(id);
    const result: WaitForVideoUpdateResult = job ? { kind: "updated", job } : { kind: "missing" };
    for (const resolve of listeners) resolve(result);
  }

  #transition(input: Parameters<VideoJobStore["transitionVideoJob"]>[0]): VideoJobRecord {
    const job = requireUpdated(this.#store.transitionVideoJob(input));
    this.#notify(job.id);
    return job;
  }

  async submitVideo(input: SubmitRuntimeVideoInput): Promise<SubmitRuntimeVideoResult> {
    if (!this.#accepting || this.#closed) throw stoppingError();
    if (input.signal?.aborted) throw stoppingError();

    const reservation = this.#store.reserveVideoJob({
      binding: input.binding,
      deadlineAt: input.deadlineAt,
      ...(input.probeOperationId ? { probeOperationId: input.probeOperationId } : {}),
      ...(input.confirmationRevision !== undefined ? { confirmationRevision: input.confirmationRevision } : {}),
    });
    if (reservation.kind === "busy") {
      const job = this.#store.publicVideoJob(reservation.reservationId);
      return {
        kind: "busy",
        reservationId: reservation.reservationId,
        ...(job ? { job } : {}),
      };
    }

    this.#crashSeam?.("before_fence", this.#public(reservation.job));
    let job = requireUpdated(this.#store.fenceVideoSubmission(reservation.job.id, reservation.job.revision));
    this.#notify(job.id);
    this.#crashSeam?.("after_fence", this.#public(job));

    // The live turn is detached after the fence. Only runtime shutdown owns this controller.
    const controller = new AbortController();
    this.#submissionControllers.set(job.id, controller);
    const submitFlight = this.#submit(input.request, input.binding, controller.signal, { deadlineAt: input.deadlineAt });
    this.#submissionFlights.set(job.id, submitFlight);
    let submitted: XaiVideoSubmitResult;
    try {
      submitted = await submitFlight;
    } catch (error) {
      const current = this.#store.getVideoJob(job.id);
      if (!current || current.state !== "submitting") throw error;
      job = current;
      if (!isMediaTransportError(error) || error.certainty === "ambiguous") {
        this.#transition({
          id: job.id,
          expectedRevision: job.revision,
          from: ["submitting"],
          to: "outcome_unknown",
          safeError: "ambiguous_submission",
        });
        throw error;
      }
      if (error.code === "needs_auth" && error.phase === "pre_dispatch") {
        this.#transition({
          id: job.id,
          expectedRevision: job.revision,
          from: ["submitting"],
          to: "needs_auth",
          safeError: "needs_auth",
        });
        throw error;
      }
      this.#transition({
        id: job.id,
        expectedRevision: job.revision,
        from: ["submitting"],
        to: error.code === "cancelled" ? "cancelled" : "failed",
        safeError: safeMediaFailure(error),
      });
      throw error;
    } finally {
      this.#submissionControllers.delete(job.id);
      this.#submissionFlights.delete(job.id);
    }

    this.#crashSeam?.("after_request_id", this.#public(job));
    const current = this.#store.getVideoJob(job.id);
    if (!current || current.state !== "submitting") throw stoppingError();
    job = requireUpdated(this.#store.commitVideoAccepted(current.id, current.revision, submitted.requestId));
    this.#notify(job.id);
    const projected = this.#public(job);
    this.#crashSeam?.("after_accepted_commit", projected);
    return { kind: "accepted", job: projected };
  }

  async driveVideoJob(id: string, signal?: AbortSignal): Promise<PublicVideoJob | null> {
    this.#retryDelays.delete(id);
    let job = this.#store.getVideoJob(id);
    if (!job) return null;
    if (job.state === "outcome_unknown" || job.state === "queued" || job.state === "submitting") {
      return this.#store.publicVideoJob(id);
    }
    if (terminal(job.state)) return this.#store.publicVideoJob(id);
    if (job.artifactId && (job.state === "downloading" || job.state === "download_failed")) {
      try {
        const adopted = await adoptReservedVideoArtifact(job.artifactId);
        if (adopted) {
          if (job.state === "download_failed") {
            job = this.#transition({
              id: job.id,
              expectedRevision: job.revision,
              from: ["download_failed"],
              to: "downloading",
              artifactId: job.artifactId,
              safeError: null,
            });
          }
          return this.#finishCompletedVideo(job);
        }
      } catch {
        if (job.state === "downloading") {
          job = this.#transition({
            id: job.id,
            expectedRevision: job.revision,
            from: ["downloading"],
            to: "download_failed",
            safeError: "download_rejected",
          });
        }
        if (this.#now() >= job.deadlineAt) {
          job = this.#transition({
            id: job.id,
            expectedRevision: job.revision,
            from: ["download_failed"],
            to: "expired",
            safeError: "timeout",
          });
        }
        return this.#public(job);
      }
    }
    if (this.#now() >= job.deadlineAt) {
      job = this.#transition({
        id: job.id,
        expectedRevision: job.revision,
        from: [job.state],
        to: "expired",
        safeError: "timeout",
      });
      return this.#public(job);
    }
    const requestId = job.requestId;
    if (!requestId) return this.#store.publicVideoJob(id);

    if (job.state !== "polling") {
      job = this.#transition({ id: job.id, expectedRevision: job.revision, from: [job.state], to: "polling" });
    }

    let result: XaiVideoPollResult;
    try {
      result = await this.#poll(requestId, job.binding, signal, { deadlineAt: job.deadlineAt });
    } catch (error) {
      if (isMediaTransportError(error)) {
        if (error.code === "needs_auth") {
          job = this.#transition({
            id: job.id,
            expectedRevision: job.revision,
            from: ["polling"],
            to: "needs_auth",
            safeError: "needs_auth",
          });
        } else if (error.retryable || error.code === "cancelled") {
          if (error.retryable && error.retryAfterMs !== undefined) {
            this.#retryDelays.set(id, error.retryAfterMs);
          }
          job = this.#transition({
            id: job.id,
            expectedRevision: job.revision,
            from: ["polling"],
            to: "accepted",
            safeError: error.code === "cancelled" ? "cancelled" : "upstream_failed",
          });
        } else {
          job = this.#transition({
            id: job.id,
            expectedRevision: job.revision,
            from: ["polling"],
            to: "failed",
            safeError: safeMediaFailure(error),
          });
        }
        return this.#public(job);
      }
      job = this.#transition({
        id: job.id,
        expectedRevision: job.revision,
        from: ["polling"],
        to: "accepted",
        safeError: "upstream_failed",
      });
      return this.#public(job);
    }

    if (result.status === "processing") {
      job = this.#transition({
        id: job.id,
        expectedRevision: job.revision,
        from: ["polling"],
        to: "accepted",
        safeError: null,
      });
      return this.#public(job);
    }
    if (result.status === "failed" || result.status === "expired") {
      job = this.#transition({
        id: job.id,
        expectedRevision: job.revision,
        from: ["polling"],
        to: result.status === "expired" ? "expired" : "failed",
        safeError: result.status === "expired" ? "job_expired" : "job_failed",
      });
      return this.#public(job);
    }
    if (!result.videoUrl) {
      job = this.#transition({
        id: job.id,
        expectedRevision: job.revision,
        from: ["polling"],
        to: "download_failed",
        safeError: "download_rejected",
      });
      return this.#public(job);
    }

    // The signed URL remains on this stack only. The artifact downloader sniffs
    // the format, then CAS-reserves its exact final id before it creates or
    // publishes any final-name bytes.
    let hardCrash = false;
    let path: string;
    try {
      path = await this.#download(result.videoUrl, signal, {
        ...(job.artifactId ? { reservedArtifactId: job.artifactId } : {}),
        onReserveArtifact: artifactId => {
          const reservingJob = job;
          if (!reservingJob) throw new Error("The durable media job is unavailable.");
          job = requireUpdated(this.#store.reserveVideoArtifact(reservingJob.id, reservingJob.revision, artifactId));
          this.#notify(job.id);
          try {
            this.#crashSeam?.("after_artifact_reserved", this.#public(job));
          } catch (error) {
            hardCrash = true;
            throw error;
          }
        },
      });
      // Backward-compatible injected test seam: production's sole downloader
      // always invokes onReserveArtifact before publication.
      if (job.state === "polling") {
        job = requireUpdated(this.#store.reserveVideoArtifact(job.id, job.revision, basename(path)));
        this.#notify(job.id);
      }
      if (!job.artifactId || basename(path) !== job.artifactId) {
        throw new Error("published video did not match its durable artifact reservation");
      }
    } catch (error) {
      if (hardCrash) throw error;
      job = this.#transition({
        id: job.id,
        expectedRevision: job.revision,
        from: ["polling", "downloading"],
        to: "download_failed",
        safeError: "download_rejected",
      });
      return this.#public(job);
    }
    this.#crashSeam?.("after_artifact_published", this.#public(job));
    return this.#finishCompletedVideo(job);
  }

  async #finishCompletedVideo(job: VideoJobRecord): Promise<PublicVideoJob | null> {
    job = requireUpdated(this.#store.completeVideoArtifact(job.id, job.revision, job.artifactId!));
    const completedArtifactId = job.artifactId!;
    this.#pendingDeliveryArtifactIds.add(completedArtifactId);
    this.#notify(job.id);
    try {
      // Every concurrently completed result remains pinned across every queued
      // completion-time pass. This permits a temporary cap overflow until each
      // caller has received its result or the probe continuation has durably
      // adopted it; otherwise A's pass could tombstone B before B's pass starts.
      await this.runArtifactRetention();
      return this.#store.publicVideoJob(job.id);
    } finally {
      // A timer crosses the promise-delivery boundary: synchronous/microtask
      // continuations (including probe settlement and other queued retention
      // passes) observe the pin, while a future independent pass may prune it.
      const timer = setTimeout(() => {
        if (!this.#artifactDeliveryLeaseCounts.has(completedArtifactId)) {
          this.#pendingDeliveryArtifactIds.delete(completedArtifactId);
        }
      }, 0);
      timer.unref?.();
    }
  }

  acquireArtifactDeliveryLease(artifactId: string): () => void {
    const ownsCompletedArtifact = this.#store.listVideoJobs()
      .some(job => job.state === "completed" && job.artifactId === artifactId);
    if (!ownsCompletedArtifact) return () => {};
    this.#artifactDeliveryLeaseCounts.set(
      artifactId,
      (this.#artifactDeliveryLeaseCounts.get(artifactId) ?? 0) + 1,
    );
    this.#pendingDeliveryArtifactIds.add(artifactId);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = (this.#artifactDeliveryLeaseCounts.get(artifactId) ?? 1) - 1;
      if (remaining > 0) {
        this.#artifactDeliveryLeaseCounts.set(artifactId, remaining);
        return;
      }
      this.#artifactDeliveryLeaseCounts.delete(artifactId);
      this.#pendingDeliveryArtifactIds.delete(artifactId);
    };
  }

  protectedArtifactIds(): ReadonlySet<string> {
    return new Set([
      ...this.#store.protectedArtifactIds(),
      ...this.#pendingDeliveryArtifactIds,
    ]);
  }

  recoverablePublicationArtifactIds(): ReadonlySet<string> {
    return this.#store.recoverablePublicationArtifactIds();
  }

  canReleaseArtifactForPrune(artifactId: string): ArtifactPinPreflightResult {
    if (this.#pendingDeliveryArtifactIds.has(artifactId)) return "protected";
    return this.#store.canReleaseArtifactForPrune(artifactId);
  }

  releaseArtifactForPrune(artifactId: string): ArtifactPinReleaseResult {
    if (this.#pendingDeliveryArtifactIds.has(artifactId)) return "protected";
    return this.#store.releaseArtifactForPrune(artifactId);
  }

  pendingArtifactDeletionIds(): ReadonlySet<string> {
    return this.#store.pendingArtifactDeletionIds();
  }

  finalizeArtifactPrune(artifactId: string): ArtifactPinFinalizeResult {
    return this.#store.finalizeArtifactPrune(artifactId);
  }

  /**
   * One serialized image/video retention owner for this durable runtime. Passing
   * the runtime explicitly makes startup safe even before server-global pin registration.
   */
  runArtifactRetention(): Promise<void> {
    const previous = this.#retentionTail ?? Promise.resolve();
    const run = previous.then(() => {
      if (this.#closed) return;
      const dir = getArtifactsDir();
      if (!existsSync(dir)) return;
      pruneMediaArtifacts({
        dir,
        maxFiles: this.#artifactsKeepCount,
        protectedArtifactIds: new Set(this.#pendingDeliveryArtifactIds),
        pinAuthorities: [this],
      });
    });
    const settled = run.catch(() => { /* a later pass can retry */ });
    this.#retentionTail = settled;
    void settled.then(() => {
      if (this.#retentionTail === settled) this.#retentionTail = undefined;
    });
    return settled;
  }

  prepareStartup(): ReturnType<VideoJobStore["recoverStartup"]> {
    if (this.#prepared) return this.#prepared;
    if (this.#closed) throw new Error("The media runtime is closed.");
    this.#prepared = this.#store.recoverStartup();
    for (const id of [
      ...this.#prepared.cancelledBeforeDispatch,
      ...this.#prepared.outcomeUnknown,
      ...this.#prepared.pollable,
    ]) this.#notify(id);
    return this.#prepared;
  }

  startBackgroundRecovery(): void {
    const recovered = this.prepareStartup();
    void this.runArtifactRetention().finally(() => {
      for (const id of recovered.pollable) this.startVideoJob(id);
    });
  }

  startVideoJob(id: string): void {
    if (!this.#accepting || this.#closed || this.#runnerFlights.has(id)) return;
    const initial = this.#store.publicVideoJob(id);
    if (!initial || terminal(initial.state) || initial.state === "outcome_unknown" || initial.state === "submitting" || initial.state === "queued") return;
    const controller = new AbortController();
    this.#runnerControllers.set(id, controller);
    const flight = this.#runVideoJob(id, controller.signal)
      .catch(() => { /* durable state is authoritative; recovery resumes on restart */ })
      .finally(() => {
        this.#runnerControllers.delete(id);
        this.#runnerFlights.delete(id);
      });
    this.#runnerFlights.set(id, flight);
  }

  async #runVideoJob(id: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted || this.#closed) return;
      const result = await this.driveVideoJob(id, signal);
      if (!result || terminal(result.state) || result.state === "outcome_unknown") return;
      const remaining = result.deadlineAt - this.#now();
      if (remaining <= 0) continue;
      const retryDelay = this.#retryDelays.get(id) ?? this.#pollIntervalMs;
      this.#retryDelays.delete(id);
      try {
        await this.#sleep(Math.min(retryDelay, remaining), signal);
      } catch {
        return;
      }
    }
  }

  /** Compatibility one-pass recovery used by the capability probe and focused crash tests. */
  async recoverOnStartup(signal?: AbortSignal): Promise<PublicVideoJob[]> {
    const recovered = this.prepareStartup();
    await this.runArtifactRetention();
    const results: PublicVideoJob[] = [];
    for (const id of recovered.pollable) {
      if (signal?.aborted) break;
      const result = await this.driveVideoJob(id, signal);
      if (result) results.push(result);
    }
    return results;
  }

  getPublicVideoJob(id: string): PublicVideoJob | null {
    if (this.#closed) return null;
    return this.#store.publicVideoJob(id);
  }

  waitForVideoUpdate(
    id: string,
    afterRevision: number,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<WaitForVideoUpdateResult> {
    if (this.#closed || !this.#accepting) {
      return Promise.resolve({ kind: "detached", job: this.getPublicVideoJob(id) });
    }
    const current = this.#store.publicVideoJob(id);
    if (!current) return Promise.resolve({ kind: "missing" });
    if (current.revision > afterRevision || terminal(current.state)) {
      return Promise.resolve({ kind: "updated", job: current });
    }
    if (options.signal?.aborted) return Promise.resolve({ kind: "detached", job: current });

    return new Promise(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const listeners = this.#waiters.get(id) ?? new Set<UpdateWaiter>();
      this.#waiters.set(id, listeners);
      const finish = (result: WaitForVideoUpdateResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        listeners.delete(finish);
        if (listeners.size === 0 && this.#waiters.get(id) === listeners) this.#waiters.delete(id);
        resolve(result);
      };
      const onAbort = () => finish({ kind: "detached", job: this.getPublicVideoJob(id) });
      listeners.add(finish);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = options.timeoutMs ?? 2_000;
      timer = setTimeout(() => finish({ kind: "timeout", job: this.getPublicVideoJob(id) }), Math.max(0, timeoutMs));
    });
  }

  acknowledgeOutcomeUnknown(id: string, expectedRevision: number): PublicVideoJob | null {
    const result = this.#store.acknowledgeVideoOutcomeUnknown(id, expectedRevision);
    if (result.kind !== "updated") return null;
    this.#notify(id);
    return this.#public(result.job);
  }

  beginShutdown(): void {
    if (!this.#accepting) return;
    this.#accepting = false;

    // Persist uncertainty before aborting a possibly dispatched POST. This also
    // releases every live waiter while retaining binding admission.
    for (const [id, controller] of this.#submissionControllers) {
      const current = this.#store.getVideoJob(id);
      if (current?.state === "submitting") {
        const changed = this.#store.transitionVideoJob({
          id,
          expectedRevision: current.revision,
          from: ["submitting"],
          to: "outcome_unknown",
          safeError: "ambiguous_submission",
        });
        if (changed.kind === "updated") this.#notify(id);
      }
      controller.abort(new Error("media runtime shutdown"));
    }
    for (const controller of this.#runnerControllers.values()) {
      controller.abort(new Error("media runtime shutdown"));
    }
    for (const [id, listeners] of this.#waiters) {
      const job = this.#store.publicVideoJob(id);
      for (const resolve of listeners) resolve({ kind: "detached", job });
    }
    this.#waiters.clear();
  }

  shutdown(): Promise<void> {
    if (this.#shutdownFlight) return this.#shutdownFlight;
    this.beginShutdown();
    const flights = [
      ...this.#submissionFlights.values(),
      ...this.#runnerFlights.values(),
      ...(this.#retentionTail ? [this.#retentionTail] : []),
    ];
    if (flights.length === 0) {
      if (!this.#closed) {
        this.#closed = true;
        this.#store.close();
      }
      this.#shutdownFlight = Promise.resolve();
      return this.#shutdownFlight;
    }
    this.#shutdownFlight = (async () => {
      await Promise.allSettled(flights);
      if (this.#closed) return;
      this.#closed = true;
      this.#store.close();
    })();
    return this.#shutdownFlight;
  }
}

/** Fixed redacted fail-closed runtime used when startup journal validation fails. */
export class RecoveryBlockedMediaRuntime implements ServerMediaRuntime {
  submitVideo(): Promise<SubmitRuntimeVideoResult> {
    const error = new Error("video recovery is unavailable (recovery_blocked)");
    error.name = "MediaRecoveryBlockedError";
    return Promise.reject(error);
  }
  startVideoJob(): void {}
  getPublicVideoJob(): PublicVideoJob | null { return null; }
  waitForVideoUpdate(): Promise<WaitForVideoUpdateResult> { return Promise.resolve({ kind: "missing" }); }
  prepareStartup() { return { cancelledBeforeDispatch: [], outcomeUnknown: [], pollable: [] }; }
  startBackgroundRecovery(): void {}
  beginShutdown(): void {}
  shutdown(): Promise<void> { return Promise.resolve(); }
  protectedArtifactIds(): ReadonlySet<string> {
    throw new Error("video artifact pins are unavailable while recovery is blocked");
  }
  recoverablePublicationArtifactIds(): ReadonlySet<string> {
    throw new Error("video artifact reservations are unavailable while recovery is blocked");
  }
  canReleaseArtifactForPrune(): ArtifactPinPreflightResult { return "protected"; }
  releaseArtifactForPrune(): ArtifactPinReleaseResult { return "protected"; }
  pendingArtifactDeletionIds(): ReadonlySet<string> {
    throw new Error("video artifact deletions are unavailable while recovery is blocked");
  }
  finalizeArtifactPrune(): ArtifactPinFinalizeResult { return "protected"; }
}

let defaultModelVideoRuntime: ModelVideoRuntime | null = null;

export function setDefaultModelVideoRuntime(runtime: ModelVideoRuntime | null): void {
  defaultModelVideoRuntime = runtime;
}

export function getDefaultModelVideoRuntime(): ModelVideoRuntime | null {
  return defaultModelVideoRuntime;
}

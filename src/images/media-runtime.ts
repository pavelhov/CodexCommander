import { basename } from "node:path";

import {
  adoptReservedVideoArtifact,
  downloadVideoToArtifact,
  type VideoArtifactDownloadOptions,
} from "./artifacts";
import {
  type ArtifactRetentionIo,
} from "./artifact-retention";
import { clearableDeadline } from "../lib/abort";
import {
  isMediaTransportError,
  mediaError,
  safeMediaFailure,
  type MediaTransportError,
} from "./media-errors";
import type { MediaCredentialBinding } from "./types";
import {
  deriveVideoRequestSemanticsDigest,
  type VideoOperationAdmissionScope,
  type VideoOperationIdentity,
} from "./video-operation-key";
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
import { VideoArtifactRetentionCoordinator } from "./video-artifact-retention-coordinator";

export type MediaRuntimeCrashSeam =
  | "before_fence"
  | "after_fence"
  | "after_request_id"
  | "after_accepted_commit"
  | "after_artifact_reserved"
  | "after_artifact_published";

export interface RuntimeVideoArtifactDownloadOptions extends VideoArtifactDownloadOptions {
  /** Persisted absolute job deadline. The runtime also enforces it through the download signal. */
  deadlineAt: number;
}

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
    options?: RuntimeVideoArtifactDownloadOptions,
  ) => Promise<string>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  /** Shared image/video artifact cap. Defaults to the canonical retention limit. */
  artifactsKeepCount?: number;
  /** Test-only durable artifact deletion fault seam. */
  artifactRetentionIo?: ArtifactRetentionIo;
  /** Test-only hard-crash seam. A thrown error deliberately leaves the last durable state untouched. */
  crashSeam?: (seam: MediaRuntimeCrashSeam, job: PublicVideoJob) => void;
}

export interface SubmitRuntimeVideoInput {
  binding: MediaCredentialBinding;
  deadlineAt: number;
  request: XaiVideoSubmitRequest;
  /** Private digest derived from a validated client retry identity. */
  operationKey?: string;
  /** Private keyed digest of the complete admitted request body. */
  requestSemanticsDigest?: string;
  /** Used only to reject cancellation before reservation/fencing. Live disconnect never owns the job. */
  signal?: AbortSignal;
  probeOperationId?: string;
  confirmationRevision?: number;
}

export type SubmitRuntimeVideoResult =
  | { kind: "accepted"; job: PublicVideoJob }
  | { kind: "replay"; job: PublicVideoJob; releaseArtifactDeliveryLease?: () => void }
  | { kind: "busy"; reservationId: string; job?: PublicVideoJob };

export type WaitForVideoUpdateResult =
  | { kind: "updated"; job: PublicVideoJob }
  | { kind: "timeout"; job: PublicVideoJob | null }
  | { kind: "detached"; job: PublicVideoJob | null }
  | { kind: "missing" };

export interface ModelVideoRuntime {
  /** Derive retry metadata without exposing the journal-owned HMAC authority. */
  deriveVideoOperationIdentity?(
    clientRequestId: string | null | undefined,
    admission: VideoOperationAdmissionScope,
    body: unknown,
  ): VideoOperationIdentity | undefined;
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

const MEDIA_RECOVERY_JOB_ID = Symbol("ccx.mediaRecoveryJobId");

function validRecoveryJobId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^[A-Za-z0-9._-]+$/.test(value);
}

/** Read one private durable recovery handle without exposing it through serialization. */
export function mediaRecoveryJobId(error: unknown): string | undefined {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return undefined;
  try {
    const value = (error as { [MEDIA_RECOVERY_JOB_ID]?: unknown })[MEDIA_RECOVERY_JOB_ID];
    return validRecoveryJobId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeRecoveryWrapper(error: unknown): MediaTransportError {
  if (isMediaTransportError(error)) {
    return mediaError({
      code: error.code,
      phase: error.phase,
      certainty: error.certainty,
      retryable: error.retryable,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    });
  }
  return mediaError({
    code: "ambiguous_submission",
    phase: "submit",
    certainty: "ambiguous",
    reason: "incomplete_response",
  });
}

function withMediaRecoveryJobId(error: unknown, jobId: string): unknown {
  const attach = (target: object): boolean => {
    try {
      Object.defineProperty(target, MEDIA_RECOVERY_JOB_ID, {
        value: jobId,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      return true;
    } catch {
      return false;
    }
  };
  if (((typeof error === "object" && error !== null) || typeof error === "function") && attach(error)) {
    return error;
  }
  const wrapper = safeRecoveryWrapper(error);
  attach(wrapper);
  return wrapper;
}

function submissionOutcomeUnknownError(jobId: string, original?: unknown): unknown {
  return withMediaRecoveryJobId(
    original ?? mediaError({
      code: "ambiguous_submission",
      phase: "submit",
      certainty: "ambiguous",
      reason: "incomplete_response",
    }),
    jobId,
  );
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

function rejectWhenAborted(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
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
  readonly #retention: VideoArtifactRetentionCoordinator;
  readonly #crashSeam?: MediaRuntimeDeps["crashSeam"];
  readonly #submissionControllers = new Map<string, AbortController>();
  readonly #submissionFlights = new Map<string, Promise<unknown>>();
  readonly #runnerControllers = new Map<string, AbortController>();
  readonly #runnerFlights = new Map<string, Promise<void>>();
  readonly #retryDelays = new Map<string, number>();
  readonly #waiters = new Map<string, Set<UpdateWaiter>>();
  #prepared: ReturnType<VideoJobStore["recoverStartup"]> | undefined;
  #accepting = true;
  #closed = false;
  #shutdownFlight: Promise<void> | undefined;

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
    this.#retention = new VideoArtifactRetentionCoordinator({
      store,
      ...(deps.artifactsKeepCount !== undefined ? { artifactsKeepCount: deps.artifactsKeepCount } : {}),
      ...(deps.artifactRetentionIo ? { artifactRetentionIo: deps.artifactRetentionIo } : {}),
    });
    this.#crashSeam = deps.crashSeam;
  }

  deriveVideoOperationIdentity(
    clientRequestId: string | null | undefined,
    admission: VideoOperationAdmissionScope,
    body: unknown,
  ): VideoOperationIdentity | undefined {
    return this.#store.deriveVideoOperationIdentity(clientRequestId, admission, body);
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

  #bestEffortFenceSubmissionOutcomeUnknown(id: string): void {
    try {
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
      } else if (current?.state === "outcome_unknown") {
        this.#notify(id);
      }
    } catch {
      // Startup recovery still converts a surviving submitting fence. The
      // caller receives the known local id even when journal I/O is unavailable.
    }
  }

  async submitVideo(input: SubmitRuntimeVideoInput): Promise<SubmitRuntimeVideoResult> {
    if (!this.#accepting || this.#closed) throw stoppingError();
    if (input.signal?.aborted) throw stoppingError();

    const reservation = this.#store.reserveVideoJob({
      binding: input.binding,
      deadlineAt: input.deadlineAt,
      ...(input.operationKey ? {
        operationKey: input.operationKey,
        requestSemanticsDigest: input.requestSemanticsDigest
          ?? deriveVideoRequestSemanticsDigest(input.request),
      } : {}),
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
    if (reservation.kind === "replay") {
      const job = this.#public(reservation.job);
      const releaseArtifactDeliveryLease = job.state === "completed" && job.artifactId
        ? this.#retention.acquireArtifactDeliveryLease(job.artifactId)
        : undefined;
      return {
        kind: "replay",
        job,
        ...(releaseArtifactDeliveryLease ? { releaseArtifactDeliveryLease } : {}),
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
      if (!current) throw error;
      if (current.state === "outcome_unknown") {
        throw submissionOutcomeUnknownError(current.id, error);
      }
      if (current.state !== "submitting") throw error;
      job = current;
      if (!isMediaTransportError(error) || error.certainty === "ambiguous") {
        const outcomeUnknown = this.#transition({
          id: job.id,
          expectedRevision: job.revision,
          from: ["submitting"],
          to: "outcome_unknown",
          safeError: "ambiguous_submission",
        });
        throw submissionOutcomeUnknownError(outcomeUnknown.id, error);
      }
      if (error.code === "needs_auth" && error.phase === "pre_dispatch") {
        job = requireUpdated(this.#store.failVideoSubmissionNeedsAuth(job.id, job.revision));
        this.#notify(job.id);
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
    if (!current) throw stoppingError();
    if (current.state === "outcome_unknown") throw submissionOutcomeUnknownError(current.id);
    if (current.state !== "submitting") throw stoppingError();
    let accepted: VideoJobUpdate;
    try {
      accepted = this.#store.commitVideoAccepted(current.id, current.revision, submitted.requestId);
    } catch (error) {
      this.#bestEffortFenceSubmissionOutcomeUnknown(current.id);
      throw submissionOutcomeUnknownError(current.id, error);
    }
    if (accepted.kind !== "updated") {
      this.#bestEffortFenceSubmissionOutcomeUnknown(current.id);
      throw submissionOutcomeUnknownError(current.id);
    }
    job = accepted.job;
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
    if (
      job.artifactId
      && job.state === "download_failed"
      && job.safeError === "cancelled"
      && this.#now() >= job.deadlineAt
    ) {
      return this.#expireVideoJob(job, ["download_failed"]);
    }
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
          return this.#expireVideoJob(job, ["download_failed"]);
        }
        return this.#public(job);
      }
    }
    if (this.#now() >= job.deadlineAt) {
      return this.#expireVideoJob(job, [job.state]);
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

    if (this.#now() >= job.deadlineAt) {
      return this.#expireVideoJob(job, ["polling"]);
    }

    // The signed URL remains on this stack only. The artifact downloader sniffs
    // the format, then CAS-reserves its exact final id before it creates or
    // publishes any final-name bytes.
    let hardCrash = false;
    let path: string;
    let downloadFlight: Promise<string> | undefined;
    const deadline = clearableDeadline(Math.max(1, Math.ceil(job.deadlineAt - this.#now())), signal);
    const downloadSignal = deadline.signal;
    const deadlineAbort = rejectWhenAborted(deadline.signal);
    try {
      downloadFlight = this.#download(result.videoUrl, downloadSignal, {
        deadlineAt: job.deadlineAt,
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
      path = await Promise.race([downloadFlight, deadlineAbort.promise]);
      // Backward-compatible injected test seam: production's sole downloader
      // always invokes onReserveArtifact before publication.
      if (job.state === "polling") {
        job = requireUpdated(this.#store.reserveVideoArtifact(job.id, job.revision, basename(path)));
        this.#notify(job.id);
      }
      if (!job.artifactId || basename(path) !== job.artifactId) {
        throw new Error("published video did not match its durable artifact reservation");
      }
      if (deadline.didExpire() || this.#now() >= job.deadlineAt) {
        return this.#expireVideoJob(job, ["downloading"]);
      }
    } catch (error) {
      if (hardCrash) throw error;
      if (deadline.didExpire() || this.#now() >= job.deadlineAt) {
        return this.#expireVideoJob(job, ["polling", "downloading"], downloadFlight);
      }
      if (signal?.aborted) {
        return this.#interruptVideoDownload(job, ["polling", "downloading"], downloadFlight);
      }
      job = this.#transition({
        id: job.id,
        expectedRevision: job.revision,
        from: ["polling", "downloading"],
        to: "download_failed",
        safeError: "download_rejected",
      });
      return this.#public(job);
    } finally {
      deadlineAbort.cleanup();
      deadline.clear();
    }
    this.#crashSeam?.("after_artifact_published", this.#public(job));
    return this.#finishCompletedVideo(job);
  }

  #interruptVideoDownload(
    job: VideoJobRecord,
    from: readonly VideoJobRecord["state"][],
    lateDownload?: Promise<string>,
  ): PublicVideoJob {
    const artifactId = job.artifactId;
    job = this.#transition({
      id: job.id,
      expectedRevision: job.revision,
      from,
      to: "download_failed",
      safeError: "cancelled",
    });
    if (lateDownload) {
      if (artifactId) this.#retention.trackReservedLatePublication(lateDownload);
      else this.#retention.trackUnreservedLatePublication(lateDownload);
    }
    return this.#public(job);
  }

  async #expireVideoJob(
    job: VideoJobRecord,
    from: readonly VideoJobRecord["state"][],
    lateDownload?: Promise<string>,
  ): Promise<PublicVideoJob> {
    const artifactId = job.artifactId;
    job = this.#transition({
      id: job.id,
      expectedRevision: job.revision,
      from,
      to: "expired",
      safeError: "timeout",
    });

    if (lateDownload) {
      // The absent final name is not evidence of cleanup while this producer can
      // still publish it. The coordinator keeps the live pin until settlement,
      // then runs the durable pending-deletion/finalization pass.
      this.#retention.trackLatePublication(artifactId, lateDownload);
      return this.#public(job);
    }

    if (!artifactId) return this.#public(job);
    await this.runArtifactRetention();
    return this.#public(job);
  }

  async #finishCompletedVideo(job: VideoJobRecord): Promise<PublicVideoJob | null> {
    job = requireUpdated(this.#store.completeVideoArtifact(job.id, job.revision, job.artifactId!));
    const completedArtifactId = job.artifactId!;
    this.#retention.markDeliveryPending(completedArtifactId);
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
      this.#retention.releaseDeliveryPendingAfterTurn(completedArtifactId);
    }
  }

  acquireArtifactDeliveryLease(artifactId: string): () => void {
    return this.#retention.acquireArtifactDeliveryLease(artifactId);
  }

  protectedArtifactIds(): ReadonlySet<string> {
    return this.#retention.protectedArtifactIds();
  }

  recoverablePublicationArtifactIds(): ReadonlySet<string> {
    return this.#retention.recoverablePublicationArtifactIds();
  }

  canReleaseArtifactForPrune(artifactId: string): ArtifactPinPreflightResult {
    return this.#retention.canReleaseArtifactForPrune(artifactId);
  }

  releaseArtifactForPrune(artifactId: string): ArtifactPinReleaseResult {
    return this.#retention.releaseArtifactForPrune(artifactId);
  }

  pendingArtifactDeletionIds(): ReadonlySet<string> {
    return this.#retention.pendingArtifactDeletionIds();
  }

  finalizeArtifactPrune(artifactId: string): ArtifactPinFinalizeResult {
    return this.#retention.finalizeArtifactPrune(artifactId);
  }

  /**
   * One serialized image/video retention owner for this durable runtime. Passing
   * the runtime explicitly makes startup safe even before server-global pin registration.
   */
  runArtifactRetention(): Promise<void> {
    return this.#retention.run();
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
    this.#shutdownFlight = (async () => {
      // A runner aborted by beginShutdown may create a late-publication cleanup
      // continuation before it settles. Re-snapshot until every runtime-owned
      // flight, including work spawned by another flight, is drained.
      for (;;) {
        const flights = [
          ...this.#submissionFlights.values(),
          ...this.#runnerFlights.values(),
          ...this.#retention.pendingFlights(),
        ];
        if (flights.length === 0) break;
        await Promise.allSettled(flights);
      }
      if (this.#closed) return;
      this.#retention.close();
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

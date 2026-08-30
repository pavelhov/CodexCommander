import { basename } from "node:path";

import { downloadVideoToArtifact } from "./artifacts";
import { isMediaTransportError, type MediaTransportError } from "./media-errors";
import type { MediaCredentialBinding } from "./types";
import {
  pollVideoJob as pollXaiVideoJob,
  submitVideoJob as submitXaiVideoJob,
  type XaiVideoPollResult,
  type XaiVideoSubmitRequest,
  type XaiVideoSubmitResult,
} from "./xai-video-client";
import {
  type PublicVideoJob,
  type SafeMediaFailure,
  type VideoJobRecord,
  type VideoJobStore,
  type VideoJobUpdate,
} from "./video-job-store";

export type MediaRuntimeCrashSeam = "before_fence" | "after_fence" | "after_request_id" | "after_accepted_commit";

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
  downloadVideo?: (url: string, signal?: AbortSignal) => Promise<string>;
  /** Test-only hard-crash seam. A thrown error deliberately leaves the last durable state untouched. */
  crashSeam?: (seam: MediaRuntimeCrashSeam, job: PublicVideoJob) => void;
}

export interface SubmitRuntimeVideoInput {
  binding: MediaCredentialBinding;
  deadlineAt: number;
  request: XaiVideoSubmitRequest;
  signal?: AbortSignal;
  probeOperationId?: string;
  confirmationRevision?: number;
}

export type SubmitRuntimeVideoResult =
  | { kind: "accepted"; job: PublicVideoJob }
  | { kind: "busy"; reservationId: string; job?: PublicVideoJob };

function requireUpdated(update: VideoJobUpdate): VideoJobRecord {
  if (update.kind !== "updated") {
    const error = new Error("The durable media job changed concurrently.");
    error.name = "MediaRuntimeConflict";
    throw error;
  }
  return update.job;
}

function safeFailure(error: MediaTransportError): SafeMediaFailure {
  switch (error.code) {
    case "needs_auth": return "needs_auth";
    case "entitlement_denied": return "entitlement_denied";
    case "rate_limited": return "rate_limited";
    case "policy_rejected": return "policy_rejected";
    case "ambiguous_submission": return "ambiguous_submission";
    case "cancelled": return "cancelled";
    case "timeout": return "timeout";
    default: return "upstream_failed";
  }
}

function publicFromRecord(store: VideoJobStore, record: VideoJobRecord): PublicVideoJob {
  const projected = store.publicVideoJob(record.id);
  if (!projected) throw new Error("The durable media job is unavailable.");
  return projected;
}

/**
 * Sole owner of billable video submission fences and restart recovery.
 * Prompts and signed result URLs remain request-local and never enter the store.
 */
export class MediaRuntime {
  readonly #store: VideoJobStore;
  readonly #now: () => number;
  readonly #submit: NonNullable<MediaRuntimeDeps["submitVideoJob"]>;
  readonly #poll: NonNullable<MediaRuntimeDeps["pollVideoJob"]>;
  readonly #download: NonNullable<MediaRuntimeDeps["downloadVideo"]>;
  readonly #crashSeam?: MediaRuntimeDeps["crashSeam"];

  constructor(store: VideoJobStore, deps: MediaRuntimeDeps = {}) {
    this.#store = store;
    this.#now = deps.now ?? Date.now;
    this.#submit = deps.submitVideoJob ?? submitXaiVideoJob;
    this.#poll = deps.pollVideoJob ?? pollXaiVideoJob;
    this.#download = deps.downloadVideo ?? (async (url, signal) => downloadVideoToArtifact(url, undefined, signal));
    this.#crashSeam = deps.crashSeam;
  }

  async submitVideo(input: SubmitRuntimeVideoInput): Promise<SubmitRuntimeVideoResult> {
    const reservation = this.#store.reserveVideoJob({
      binding: input.binding,
      deadlineAt: input.deadlineAt,
      ...(input.probeOperationId ? { probeOperationId: input.probeOperationId } : {}),
      ...(input.confirmationRevision !== undefined ? { confirmationRevision: input.confirmationRevision } : {}),
    });
    if (reservation.kind === "busy") {
      return {
        kind: "busy",
        reservationId: reservation.reservationId,
        ...(this.#store.publicVideoJob(reservation.reservationId)
          ? { job: this.#store.publicVideoJob(reservation.reservationId)! }
          : {}),
      };
    }

    this.#crashSeam?.("before_fence", publicFromRecord(this.#store, reservation.job));
    let job = requireUpdated(this.#store.fenceVideoSubmission(reservation.job.id, reservation.job.revision));
    this.#crashSeam?.("after_fence", publicFromRecord(this.#store, job));

    let submitted: XaiVideoSubmitResult;
    try {
      submitted = await this.#submit(input.request, input.binding, input.signal, {
        deadlineAt: input.deadlineAt,
      });
    } catch (error) {
      // Once the durable fence exists, an unknown exception is conservative: remote work may exist.
      if (!isMediaTransportError(error) || error.certainty === "ambiguous") {
        const unknown = this.#store.transitionVideoJob({
          id: job.id,
          expectedRevision: job.revision,
          from: ["submitting"],
          to: "outcome_unknown",
          safeError: "ambiguous_submission",
        });
        requireUpdated(unknown);
        throw error;
      }
      if (error.code === "needs_auth" && error.phase === "pre_dispatch") {
        requireUpdated(this.#store.transitionVideoJob({
          id: job.id,
          expectedRevision: job.revision,
          from: ["submitting"],
          to: "needs_auth",
          safeError: "needs_auth",
        }));
        throw error;
      }
      requireUpdated(this.#store.transitionVideoJob({
        id: job.id,
        expectedRevision: job.revision,
        from: ["submitting"],
        to: error.code === "cancelled" ? "cancelled" : "failed",
        safeError: safeFailure(error),
      }));
      throw error;
    }

    this.#crashSeam?.("after_request_id", publicFromRecord(this.#store, job));
    job = requireUpdated(this.#store.commitVideoAccepted(job.id, job.revision, submitted.requestId));
    const projected = publicFromRecord(this.#store, job);
    this.#crashSeam?.("after_accepted_commit", projected);
    return { kind: "accepted", job: projected };
  }

  async driveVideoJob(id: string, signal?: AbortSignal): Promise<PublicVideoJob | null> {
    let job = this.#store.getVideoJob(id);
    if (!job) return null;
    if (job.state === "outcome_unknown" || job.state === "queued" || job.state === "submitting") {
      return this.#store.publicVideoJob(id);
    }
    if (["completed", "failed", "expired", "cancelled", "acknowledged"].includes(job.state)) {
      return this.#store.publicVideoJob(id);
    }
    if (this.#now() >= job.deadlineAt) {
      job = requireUpdated(this.#store.transitionVideoJob({
        id: job.id,
        expectedRevision: job.revision,
        from: [job.state],
        to: "expired",
        safeError: "timeout",
      }));
      return publicFromRecord(this.#store, job);
    }
    const requestId = job.requestId;
    if (!requestId) {
      // Only a crash-lost POST can lack an id after the fence. Do not invent or resubmit one.
      if (job.state === "needs_auth") return this.#store.publicVideoJob(id);
      return this.#store.publicVideoJob(id);
    }

    if (job.state !== "polling") {
      job = requireUpdated(this.#store.transitionVideoJob({
        id: job.id,
        expectedRevision: job.revision,
        from: [job.state],
        to: "polling",
      }));
    }

    let result: XaiVideoPollResult;
    try {
      result = await this.#poll(requestId, job.binding, signal, { deadlineAt: job.deadlineAt });
    } catch (error) {
      if (isMediaTransportError(error)) {
        if (error.code === "needs_auth") {
          job = requireUpdated(this.#store.transitionVideoJob({
            id: job.id,
            expectedRevision: job.revision,
            from: ["polling"],
            to: "needs_auth",
            safeError: "needs_auth",
          }));
        } else if (error.retryable || error.code === "cancelled") {
          job = requireUpdated(this.#store.transitionVideoJob({
            id: job.id,
            expectedRevision: job.revision,
            from: ["polling"],
            to: "accepted",
            safeError: error.code === "cancelled" ? "cancelled" : "upstream_failed",
          }));
        } else {
          job = requireUpdated(this.#store.transitionVideoJob({
            id: job.id,
            expectedRevision: job.revision,
            from: ["polling"],
            to: "failed",
            safeError: safeFailure(error),
          }));
        }
        return publicFromRecord(this.#store, job);
      }
      job = requireUpdated(this.#store.transitionVideoJob({
        id: job.id,
        expectedRevision: job.revision,
        from: ["polling"],
        to: "accepted",
        safeError: "upstream_failed",
      }));
      return publicFromRecord(this.#store, job);
    }

    if (result.status === "processing") {
      job = requireUpdated(this.#store.transitionVideoJob({
        id: job.id,
        expectedRevision: job.revision,
        from: ["polling"],
        to: "accepted",
        safeError: null,
      }));
      return publicFromRecord(this.#store, job);
    }
    if (result.status === "failed" || result.status === "expired") {
      job = requireUpdated(this.#store.transitionVideoJob({
        id: job.id,
        expectedRevision: job.revision,
        from: ["polling"],
        to: result.status === "expired" ? "expired" : "failed",
        safeError: result.status === "expired" ? "job_expired" : "job_failed",
      }));
      return publicFromRecord(this.#store, job);
    }
    if (!result.videoUrl) {
      job = requireUpdated(this.#store.transitionVideoJob({
        id: job.id,
        expectedRevision: job.revision,
        from: ["polling"],
        to: "download_failed",
        safeError: "download_rejected",
      }));
      return publicFromRecord(this.#store, job);
    }

    // The signed URL remains on this stack only; the durable transition stores no URL.
    job = requireUpdated(this.#store.transitionVideoJob({
      id: job.id,
      expectedRevision: job.revision,
      from: ["polling"],
      to: "downloading",
      safeError: null,
    }));
    try {
      const path = await this.#download(result.videoUrl, signal);
      const artifactId = basename(path);
      job = requireUpdated(this.#store.transitionVideoJob({
        id: job.id,
        expectedRevision: job.revision,
        from: ["downloading"],
        to: "completed",
        artifactId,
        safeError: null,
      }));
    } catch {
      job = requireUpdated(this.#store.transitionVideoJob({
        id: job.id,
        expectedRevision: job.revision,
        from: ["downloading"],
        to: "download_failed",
        safeError: "download_rejected",
      }));
    }
    return publicFromRecord(this.#store, job);
  }

  async recoverOnStartup(signal?: AbortSignal): Promise<PublicVideoJob[]> {
    const recovered = this.#store.recoverStartup();
    const results: PublicVideoJob[] = [];
    // Deliberately no call to #submit: startup recovery owns only safe GET/download work.
    for (const id of recovered.pollable) {
      if (signal?.aborted) break;
      const result = await this.driveVideoJob(id, signal);
      if (result) results.push(result);
    }
    return results;
  }

  acknowledgeOutcomeUnknown(id: string, expectedRevision: number): PublicVideoJob | null {
    const result = this.#store.acknowledgeVideoOutcomeUnknown(id, expectedRevision);
    return result.kind === "updated" ? publicFromRecord(this.#store, result.job) : null;
  }
}

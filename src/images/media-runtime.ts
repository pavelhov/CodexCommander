import { basename } from "node:path";

import { downloadVideoToArtifact } from "./artifacts";
import { isMediaTransportError, mediaError, type MediaTransportError } from "./media-errors";
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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
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
}

export interface ServerMediaRuntime extends ModelVideoRuntime {
  prepareStartup(): { cancelledBeforeDispatch: string[]; outcomeUnknown: string[]; pollable: string[] };
  startBackgroundRecovery(): void;
  beginShutdown(): void;
  shutdown(): Promise<void>;
}

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
    this.#download = deps.downloadVideo ?? (async (url, signal) => downloadVideoToArtifact(url, undefined, signal));
    this.#sleep = deps.sleep ?? sleepWithAbort;
    this.#pollIntervalMs = typeof deps.pollIntervalMs === "number" && Number.isFinite(deps.pollIntervalMs)
      ? Math.max(1, Math.floor(deps.pollIntervalMs))
      : 5_000;
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
        safeError: safeFailure(error),
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
            safeError: safeFailure(error),
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

    // The signed URL remains on this stack only; the durable transition stores no URL.
    job = this.#transition({
      id: job.id,
      expectedRevision: job.revision,
      from: ["polling"],
      to: "downloading",
      safeError: null,
    });
    try {
      const path = await this.#download(result.videoUrl, signal);
      job = this.#transition({
        id: job.id,
        expectedRevision: job.revision,
        from: ["downloading"],
        to: "completed",
        artifactId: basename(path),
        safeError: null,
      });
    } catch {
      job = this.#transition({
        id: job.id,
        expectedRevision: job.revision,
        from: ["downloading"],
        to: "download_failed",
        safeError: "download_rejected",
      });
    }
    return this.#public(job);
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
    for (const id of recovered.pollable) this.startVideoJob(id);
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
    const flights = [...this.#submissionFlights.values(), ...this.#runnerFlights.values()];
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
}

let defaultModelVideoRuntime: ModelVideoRuntime | null = null;

export function setDefaultModelVideoRuntime(runtime: ModelVideoRuntime | null): void {
  defaultModelVideoRuntime = runtime;
}

export function getDefaultModelVideoRuntime(): ModelVideoRuntime | null {
  return defaultModelVideoRuntime;
}

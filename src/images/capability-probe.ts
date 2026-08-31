import { createHash } from "node:crypto";
import { basename, join } from "node:path";

import {
  downloadImageToArtifact,
  materializeInlineImage,
  removePendingCapabilityArtifactById,
} from "./artifacts";
import { callXaiImages, type XaiImageRequest, type XaiImageResult } from "./xai-client";
import { isMediaTransportError, safeMediaFailure } from "./media-errors";
import { MediaRuntime } from "./media-runtime";
import type { MediaCredentialBinding } from "./types";
import {
  type CapabilityProbeStepKind,
  type CapabilityArtifactDeletion,
  type CapabilityProbeStepRecord,
  type PublicCapabilityProbe,
  type PublicVideoJob,
  type VideoJobStore,
} from "./video-job-store";

export const IMAGE_PROBE_MODEL = "grok-imagine-image-2.0";
export const VIDEO_PROBE_MODEL = "grok-imagine-video-1.5";
export const MEDIA_CONTRACT_REVISION = "xai-imagine-rest-v1";
export const MEDIA_PROBE_VERSION = 1;
export const PROBE_ARTIFACT_RETENTION_MS = 24 * 60 * 60_000;
const PROBE_CONFIRMATION_MAX_LIFETIME_MS = 15 * 60_000;
const PROBE_JOB_LIFETIME_MS = 10 * 60_000;
const PROBE_ARTIFACT_SWEEP_INTERVAL_MS = 60_000;
const PROBE_KEY_DOMAIN = "ccx-media-capability-probe-v1";
// Fixed, code-owned test content. It is never persisted, logged, or accepted from a caller.
const FIXED_IMAGE_PROMPT = "A plain red circle centered on a white background.";
const FIXED_VIDEO_PROMPT = "A plain red circle remains centered on a white background.";

export type CapabilityProbeGateErrorCode =
  | "confirmation_required"
  | "runtime_attestation_required"
  | "interactive_human_required"
  | "preflight_evidence_required"
  | "source_mismatch"
  | "stale_confirmation"
  | "confirmation_expired";

export class CapabilityProbeGateError extends Error {
  constructor(readonly code: CapabilityProbeGateErrorCode) {
    super("The media capability probe is not authorized.");
    this.name = "CapabilityProbeGateError";
  }
}

export interface CapabilityProbeGate {
  caller: "interactive_cli" | "confirmed_gui";
  operationId: string;
  expectedRevision: number;
  confirmationRevision: number;
  expiresAt: number;
  runtimeAttested: boolean;
  humanConfirmed: boolean;
  targetedTestsPassed: boolean;
  privacyScanPassed: boolean;
  securityReviewApproved: boolean;
  apiKeyFallbackDisabled: boolean;
  billingAttribution: "unknown";
  ambiguousSubmissionRiskAccepted: boolean;
  nonReleaseEvidenceAccepted: boolean;
}

export interface CapabilityProbeAcknowledgement {
  caller: "interactive_cli" | "confirmed_gui";
  operationId: string;
  step: CapabilityProbeStepKind;
  expectedRevision: number;
  runtimeAttested: true;
  humanConfirmed: true;
}

export interface CapabilityProbeStatus {
  readonly id: string;
  readonly revision: number;
  readonly source: "subscription_oauth";
  readonly imageModel: string;
  readonly videoModel: string;
  readonly videoDurationSeconds: 1;
  readonly videoResolution: "1080p";
  readonly apiKeyFallbackDisabled: true;
  readonly billingAttribution: "unknown";
  readonly releaseStatus: "feasibility_only";
  readonly contractRevision: string;
  readonly probeVersion: number;
  readonly confirmationRevision?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly steps: Readonly<Record<CapabilityProbeStepKind, CapabilityProbeStepRecord>>;
}

export interface CapabilityProbeDeps {
  now?: () => number;
  callImage?: (
    request: XaiImageRequest,
    binding: MediaCredentialBinding,
    signal?: AbortSignal,
  ) => Promise<XaiImageResult>;
  /** Converts one returned image to the private artifact store. Signed URLs remain memory-only. */
  materializeImage?: (result: XaiImageResult["images"][number], signal?: AbortSignal) => Promise<string>;
  /** Test/store seam; production deletes through the opaque-id artifact helper. */
  removeArtifact?: (artifactId: string) => Promise<boolean>;
  /** Exact-entry existence seam used to distinguish an already-absent artifact from unlink failure. */
  artifactExists?: (artifactId: string) => boolean;
  /** Fixed test seam for the long-lived expiry sweep cadence. */
  sweepIntervalMs?: number;
}

function probeKey(bindingDigest: string): string {
  return `sha256:${createHash("sha256")
    .update(PROBE_KEY_DOMAIN)
    .update("\0")
    .update(bindingDigest)
    .update("\0")
    .update(IMAGE_PROBE_MODEL)
    .update("\0")
    .update(VIDEO_PROBE_MODEL)
    .update("\0")
    .update(MEDIA_CONTRACT_REVISION)
    .update("\0")
    .update(String(MEDIA_PROBE_VERSION))
    .digest("hex")}`;
}

function status(probe: PublicCapabilityProbe): CapabilityProbeStatus {
  return {
    id: probe.id,
    revision: probe.revision,
    source: "subscription_oauth",
    imageModel: probe.imageModel,
    videoModel: probe.videoModel,
    videoDurationSeconds: 1,
    videoResolution: "1080p",
    apiKeyFallbackDisabled: true,
    billingAttribution: "unknown",
    releaseStatus: "feasibility_only",
    contractRevision: probe.contractRevision,
    probeVersion: probe.probeVersion,
    ...(probe.confirmationRevision !== undefined ? { confirmationRevision: probe.confirmationRevision } : {}),
    createdAt: probe.createdAt,
    updatedAt: probe.updatedAt,
    steps: probe.steps,
  };
}

async function defaultMaterializeImage(
  result: XaiImageResult["images"][number],
  signal?: AbortSignal,
): Promise<string> {
  if (result.b64_json) return materializeInlineImage(result.b64_json);
  if (result.url) return downloadImageToArtifact(result.url, undefined, signal);
  throw new Error("The capability image result is unavailable.");
}

function gateError(code: CapabilityProbeGateErrorCode): never {
  throw new CapabilityProbeGateError(code);
}

function imageStepSettledNonAmbiguous(step: CapabilityProbeStepRecord): boolean {
  return (step.state === "completed" && step.dispatchCertainty === "completed")
    || (step.state === "failed" && step.dispatchCertainty === "definite_rejection");
}

/** Durable, single-flight feasibility operation. It is not a billing or release-verification claim. */
export class CapabilityProbeService {
  readonly #store: VideoJobStore;
  readonly #runtime: MediaRuntime;
  readonly #now: () => number;
  readonly #callImage: NonNullable<CapabilityProbeDeps["callImage"]>;
  readonly #materializeImage: NonNullable<CapabilityProbeDeps["materializeImage"]>;
  readonly #removeArtifact: NonNullable<CapabilityProbeDeps["removeArtifact"]>;
  readonly #sweepIntervalMs: number;
  readonly #reconciliationFlights = new Map<string, Promise<void>>();
  #sweepTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(store: VideoJobStore, runtime: MediaRuntime, deps: CapabilityProbeDeps = {}) {
    this.#store = store;
    this.#runtime = runtime;
    this.#now = deps.now ?? Date.now;
    this.#callImage = deps.callImage ?? callXaiImages;
    this.#materializeImage = deps.materializeImage ?? defaultMaterializeImage;
    this.#removeArtifact = deps.removeArtifact ?? removePendingCapabilityArtifactById;
    this.#sweepIntervalMs = deps.sweepIntervalMs ?? PROBE_ARTIFACT_SWEEP_INTERVAL_MS;
  }

  prepare(binding: MediaCredentialBinding): CapabilityProbeStatus {
    if (binding.authSource !== "subscription_oauth" || binding.providerKind !== "canonical") {
      gateError("source_mismatch");
    }
    const operation = this.#store.getOrCreateCapabilityProbe({
      keyDigest: probeKey(binding.identityDigest),
      bindingDigest: binding.identityDigest,
      imageModel: IMAGE_PROBE_MODEL,
      videoModel: VIDEO_PROBE_MODEL,
      contractRevision: MEDIA_CONTRACT_REVISION,
      probeVersion: MEDIA_PROBE_VERSION,
    });
    return status(this.#store.publicCapabilityProbe(operation.probe.id)!);
  }

  #validateGate(binding: MediaCredentialBinding, current: CapabilityProbeStatus, gate?: CapabilityProbeGate): CapabilityProbeGate {
    if (!gate) gateError("confirmation_required");
    if (binding.authSource !== "subscription_oauth" || !gate.apiKeyFallbackDisabled) gateError("source_mismatch");
    if (!gate.runtimeAttested) gateError("runtime_attestation_required");
    if ((gate.caller !== "interactive_cli" && gate.caller !== "confirmed_gui") || !gate.humanConfirmed) gateError("interactive_human_required");
    if (
      !gate.targetedTestsPassed
      || !gate.privacyScanPassed
      || !gate.securityReviewApproved
      || gate.billingAttribution !== "unknown"
      || !gate.ambiguousSubmissionRiskAccepted
      || !gate.nonReleaseEvidenceAccepted
    ) gateError("preflight_evidence_required");
    if (
      gate.operationId !== current.id
      || gate.expectedRevision !== current.revision
      || !Number.isSafeInteger(gate.confirmationRevision)
      || gate.confirmationRevision <= (current.confirmationRevision ?? 0)
    ) gateError("stale_confirmation");
    const now = this.#now();
    if (
      !Number.isSafeInteger(gate.expiresAt)
      || gate.expiresAt <= now
      || gate.expiresAt > now + PROBE_CONFIRMATION_MAX_LIFETIME_MS
    ) gateError("confirmation_expired");
    return gate;
  }

  async run(
    binding: MediaCredentialBinding,
    gate?: CapabilityProbeGate,
    signal?: AbortSignal,
  ): Promise<CapabilityProbeStatus> {
    let current = this.prepare(binding);
    const confirmed = this.#validateGate(binding, current, gate);
    const authorized = this.#store.authorizeCapabilityProbe({
      id: current.id,
      expectedRevision: current.revision,
      confirmationRevision: confirmed.confirmationRevision,
      expiresAt: confirmed.expiresAt,
    });
    if (authorized.kind !== "updated") gateError("stale_confirmation");
    current = status(this.#store.publicCapabilityProbe(current.id)!);
    current = await this.#runImage(binding, current, confirmed.confirmationRevision, signal);
    current = await this.#runVideo(binding, current, confirmed.confirmationRevision, signal);
    return current;
  }

  async #runImage(
    binding: MediaCredentialBinding,
    current: CapabilityProbeStatus,
    confirmationRevision: number,
    signal?: AbortSignal,
  ): Promise<CapabilityProbeStatus> {
    if (!["pending", "failed", "acknowledged"].includes(current.steps.image.state)) return current;
    const begun = this.#store.beginCapabilityProbeStep({
      id: current.id,
      step: "image",
      expectedRevision: current.revision,
      confirmationRevision,
    });
    if (begun.kind !== "updated") return status(this.#store.publicCapabilityProbe(current.id)!);
    const step = begun.probe.steps.image;
    try {
      const result = await this.#callImage({
        prompt: FIXED_IMAGE_PROMPT,
        model: IMAGE_PROBE_MODEL,
        n: 1,
        size: "1024x1024",
        quality: "standard",
      }, binding, signal);
      const first = result.images[0];
      if (!first) throw new Error("missing image result");
      const path = await this.#materializeImage(first, signal);
      const verifiedAt = this.#now();
      this.#store.settleCapabilityProbeStep({
        id: current.id,
        step: "image",
        expectedStepRevision: step.revision,
        state: "completed",
        dispatchCertainty: "completed",
        artifactId: basename(path),
        verifiedAt,
        artifactExpiresAt: verifiedAt + PROBE_ARTIFACT_RETENTION_MS,
      });
    } catch (error) {
      const ambiguous = !isMediaTransportError(error) || error.certainty === "ambiguous";
      this.#store.settleCapabilityProbeStep({
        id: current.id,
        step: "image",
        expectedStepRevision: step.revision,
        state: ambiguous ? "outcome_unknown" : "failed",
        dispatchCertainty: ambiguous ? "outcome_unknown" : "definite_rejection",
        safeError: ambiguous ? "ambiguous_submission" : safeMediaFailure(error),
      });
    }
    return status(this.#store.publicCapabilityProbe(current.id)!);
  }

  async #runVideo(
    binding: MediaCredentialBinding,
    current: CapabilityProbeStatus,
    confirmationRevision: number,
    signal?: AbortSignal,
  ): Promise<CapabilityProbeStatus> {
    // The durable image step must be fully settled before another paid POST can
    // begin. The store repeats this predicate in the begin-step transaction so
    // a concurrent fresh confirmation cannot race this snapshot.
    if (!imageStepSettledNonAmbiguous(current.steps.image)) return current;
    if (!["pending", "failed", "acknowledged"].includes(current.steps.video.state)) return current;
    const begun = this.#store.beginCapabilityProbeStep({
      id: current.id,
      step: "video",
      expectedRevision: current.revision,
      confirmationRevision,
    });
    if (begun.kind !== "updated") return status(this.#store.publicCapabilityProbe(current.id)!);
    const step = begun.probe.steps.video;
    try {
      const submitted = await this.#runtime.submitVideo({
        binding,
        deadlineAt: this.#now() + PROBE_JOB_LIFETIME_MS,
        request: {
          prompt: FIXED_VIDEO_PROMPT,
          model: VIDEO_PROBE_MODEL,
          duration: 1,
          resolution: "1080p",
          aspectRatio: "16:9",
        },
        signal,
        probeOperationId: current.id,
        confirmationRevision,
      });
      if (submitted.kind === "busy" || !submitted.job) {
        this.#store.settleCapabilityProbeStep({
          id: current.id,
          step: "video",
          expectedStepRevision: step.revision,
          state: "failed",
          dispatchCertainty: "definite_rejection",
          safeError: "upstream_failed",
        });
        return status(this.#store.publicCapabilityProbe(current.id)!);
      }
      let settled = this.#store.settleCapabilityProbeStep({
        id: current.id,
        step: "video",
        expectedStepRevision: step.revision,
        state: "accepted",
        dispatchCertainty: "accepted",
        videoJobId: submitted.job.id,
      });
      if (settled.kind !== "updated") return status(this.#store.publicCapabilityProbe(current.id)!);
      const driven = await this.#runtime.driveVideoJob(submitted.job.id, signal);
      const probeStep = settled.probe.steps.video;
      if (!driven) return status(this.#store.publicCapabilityProbe(current.id)!);
      if (driven.state === "completed") {
        const verifiedAt = this.#now();
        settled = this.#store.settleCapabilityProbeStep({
          id: current.id,
          step: "video",
          expectedStepRevision: probeStep.revision,
          state: "completed",
          dispatchCertainty: "completed",
          artifactId: driven.artifactId,
          videoJobId: driven.id,
          verifiedAt,
          artifactExpiresAt: verifiedAt + PROBE_ARTIFACT_RETENTION_MS,
        });
      } else if (["failed", "expired", "cancelled"].includes(driven.state)) {
        settled = this.#store.settleCapabilityProbeStep({
          id: current.id,
          step: "video",
          expectedStepRevision: probeStep.revision,
          state: "failed",
          dispatchCertainty: "definite_rejection",
          safeError: driven.safeError ?? "upstream_failed",
          videoJobId: driven.id,
        });
      } else {
        this.#startAcceptedVideoDriver(driven.id);
      }
      void settled;
    } catch (error) {
      const job = this.#store.findVideoJobForProbe(current.id);
      if (job?.requestId && ["accepted", "polling", "needs_auth", "downloading", "download_failed", "completed"].includes(job.state)) {
        const verifiedAt = this.#now();
        this.#store.settleCapabilityProbeStep({
          id: current.id,
          step: "video",
          expectedStepRevision: step.revision,
          state: job.state === "completed" ? "completed" : "accepted",
          dispatchCertainty: job.state === "completed" ? "completed" : "accepted",
          videoJobId: job.id,
          ...(job.state === "completed" && job.artifactId
            ? {
                artifactId: job.artifactId,
                verifiedAt,
                artifactExpiresAt: verifiedAt + PROBE_ARTIFACT_RETENTION_MS,
              }
            : {}),
        });
        if (job.state !== "completed") this.#startAcceptedVideoDriver(job.id);
        return status(this.#store.publicCapabilityProbe(current.id)!);
      }
      const ambiguous = job?.state === "outcome_unknown" || !isMediaTransportError(error) || error.certainty === "ambiguous";
      this.#store.settleCapabilityProbeStep({
        id: current.id,
        step: "video",
        expectedStepRevision: step.revision,
        state: ambiguous ? "outcome_unknown" : "failed",
        dispatchCertainty: ambiguous ? "outcome_unknown" : "definite_rejection",
        safeError: ambiguous ? "ambiguous_submission" : safeMediaFailure(error),
        ...(job ? { videoJobId: job.id } : {}),
      });
    }
    return status(this.#store.publicCapabilityProbe(current.id)!);
  }

  #settleAcceptedProbeVideo(job: PublicVideoJob): boolean {
    const storedJob = this.#store.getVideoJob(job.id);
    if (!storedJob?.probeOperationId) return true;
    const probe = this.#store.getCapabilityProbe(storedJob.probeOperationId);
    if (
      !probe
      || probe.steps.video.state !== "accepted"
      || probe.steps.video.videoJobId !== job.id
    ) return true;
    if (job.state === "completed" && job.artifactId) {
      const verifiedAt = this.#now();
      this.#store.settleCapabilityProbeStep({
        id: probe.id,
        step: "video",
        expectedStepRevision: probe.steps.video.revision,
        state: "completed",
        dispatchCertainty: "completed",
        artifactId: job.artifactId,
        artifactExpiresAt: verifiedAt + PROBE_ARTIFACT_RETENTION_MS,
        videoJobId: job.id,
        verifiedAt,
      });
      return true;
    }
    if (["failed", "expired", "cancelled"].includes(job.state)) {
      this.#store.settleCapabilityProbeStep({
        id: probe.id,
        step: "video",
        expectedStepRevision: probe.steps.video.revision,
        state: "failed",
        dispatchCertainty: "definite_rejection",
        safeError: job.safeError ?? "upstream_failed",
        videoJobId: job.id,
      });
      return true;
    }
    if (job.state === "artifact_pruned") {
      this.#store.settleCapabilityProbeStep({
        id: probe.id,
        step: "video",
        expectedStepRevision: probe.steps.video.revision,
        state: "failed",
        dispatchCertainty: "definite_rejection",
        safeError: "download_rejected",
        videoJobId: job.id,
      });
      return true;
    }
    return job.state === "outcome_unknown" || job.state === "acknowledged";
  }

  async #watchAcceptedProbeVideo(id: string): Promise<void> {
    let job = this.#runtime.getPublicVideoJob(id);
    while (job) {
      if (this.#settleAcceptedProbeVideo(job)) return;
      const update = await this.#runtime.waitForVideoUpdate(id, job.revision, { timeoutMs: 30_000 });
      if (update.kind === "missing" || update.kind === "detached") return;
      job = update.job ?? this.#runtime.getPublicVideoJob(id);
    }
  }

  #startAcceptedVideoDriver(id: string): void {
    this.#runtime.startVideoJob(id);
    if (this.#reconciliationFlights.has(id)) return;
    const flight = this.#watchAcceptedProbeVideo(id)
      .catch(() => { /* durable state is reconciled by the next startup */ })
      .finally(() => this.#reconciliationFlights.delete(id));
    this.#reconciliationFlights.set(id, flight);
  }

  /** Start GET/download-only recovery and continuously mirror its terminal result into probe evidence. */
  startBackgroundRecovery(): void {
    if (this.#closed) return;
    this.#runtime.startBackgroundRecovery();
    for (const job of this.#store.listVideoJobs()) {
      if (!job.probeOperationId) continue;
      const probe = this.#store.getCapabilityProbe(job.probeOperationId);
      if (probe?.steps.video.state !== "accepted" || probe.steps.video.videoJobId !== job.id) continue;
      this.#startAcceptedVideoDriver(job.id);
    }
    void this.sweepExpiredArtifacts().catch(() => { /* the periodic owner retries */ });
    this.#scheduleArtifactSweep();
  }

  #scheduleArtifactSweep(): void {
    if (this.#closed || this.#sweepTimer) return;
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = undefined;
      if (this.#closed) return;
      void this.sweepExpiredArtifacts()
        .catch(() => { /* durable work remains for the next pass */ })
        .finally(() => this.#scheduleArtifactSweep());
    }, this.#sweepIntervalMs);
    this.#sweepTimer.unref?.();
  }

  shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweepTimer) clearTimeout(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  acknowledge(input: CapabilityProbeAcknowledgement): CapabilityProbeStatus {
    if ((input.caller !== "interactive_cli" && input.caller !== "confirmed_gui") || !input.runtimeAttested || !input.humanConfirmed) {
      gateError("interactive_human_required");
    }
    const result = this.#store.acknowledgeCapabilityProbeStep({
      id: input.operationId,
      step: input.step,
      expectedRevision: input.expectedRevision,
    });
    if (result.kind !== "updated") gateError("stale_confirmation");
    return status(this.#store.publicCapabilityProbe(input.operationId)!);
  }

  async recordInspection(input: {
    operationId: string;
    step: CapabilityProbeStepKind;
    expectedRevision: number;
    caller: "interactive_cli";
    runtimeAttested: true;
    humanConfirmed: true;
  }): Promise<CapabilityProbeStatus> {
    if (input.caller !== "interactive_cli" || !input.runtimeAttested || !input.humanConfirmed) {
      gateError("interactive_human_required");
    }
    // The durable record clears the pin first; deletion is then best-effort and can be retried by retention.
    const result = this.#store.recordCapabilityProbeInspection({
      id: input.operationId,
      step: input.step,
      expectedRevision: input.expectedRevision,
    });
    if (result.kind !== "updated") gateError("stale_confirmation");
    await this.#attemptArtifactDeletion(result.deletion);
    return status(this.#store.publicCapabilityProbe(input.operationId)!);
  }

  async #attemptArtifactDeletion(deletion: CapabilityArtifactDeletion): Promise<boolean> {
    let removed = false;
    try {
      removed = await this.#removeArtifact(deletion.artifactId);
    } catch {
      // Durable work stays in the journal and startup/retention retries it.
    }
    // `false` includes unlink success whose containing-directory fsync failed.
    // The durable deletion row must survive even when the name is currently
    // absent; a retry confirms absence with a successful directory fsync.
    if (!removed) return false;
    return this.#store.completeCapabilityArtifactDeletion(deletion).kind === "updated";
  }

  /** Retry durable inspection/expiry deletion work and finalize only confirmed removals. */
  async sweepExpiredArtifacts(now = this.#now()): Promise<number> {
    const deletions = this.#store.listPendingCapabilityArtifactDeletions(now);
    let completed = 0;
    for (const deletion of deletions) {
      if (await this.#attemptArtifactDeletion(deletion)) completed += 1;
    }
    return completed;
  }

  /** Recover only durable GET/download work, then reconcile probe evidence from local job state. */
  async recoverOnStartup(signal?: AbortSignal): Promise<CapabilityProbeStatus[]> {
    const jobs = await this.#runtime.recoverOnStartup(signal);
    const operationIds = new Set<string>();
    for (const publicJob of jobs) {
      const job = this.#store.getVideoJob(publicJob.id);
      if (!job?.probeOperationId) continue;
      const probe = this.#store.getCapabilityProbe(job.probeOperationId);
      if (!probe || probe.steps.video.state !== "accepted") continue;
      if (job.state === "completed" && job.artifactId) {
        const verifiedAt = this.#now();
        this.#store.settleCapabilityProbeStep({
          id: probe.id,
          step: "video",
          expectedStepRevision: probe.steps.video.revision,
          state: "completed",
          dispatchCertainty: "completed",
          artifactId: job.artifactId,
          artifactExpiresAt: verifiedAt + PROBE_ARTIFACT_RETENTION_MS,
          videoJobId: job.id,
          verifiedAt,
        });
      } else if (["failed", "expired", "cancelled"].includes(job.state)) {
        this.#store.settleCapabilityProbeStep({
          id: probe.id,
          step: "video",
          expectedStepRevision: probe.steps.video.revision,
          state: "failed",
          dispatchCertainty: "definite_rejection",
          safeError: job.safeError ?? "upstream_failed",
          videoJobId: job.id,
        });
      }
      operationIds.add(probe.id);
    }
    await this.sweepExpiredArtifacts();
    return [...operationIds]
      .map(id => this.#store.publicCapabilityProbe(id))
      .filter((probe): probe is PublicCapabilityProbe => probe !== null)
      .map(status);
  }
}

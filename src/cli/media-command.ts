import { randomBytes } from "node:crypto";

import {
  attestLiveManagementProxy,
  sameAttestedRuntimeTarget,
  type AttestedLiveManagementProxy,
} from "../server/proxy-liveness";
import { interactiveConfirm } from "./interactive-confirm";
import { CliUsageError, RuntimeApiError } from "./runtime-api";
import { runningProxyUpdateHeaders } from "../oauth/login-cli";
import {
  MEDIA_ACTION_ATTESTATION_HEADER,
  type MediaActionAttestationInput,
} from "../lib/media-action-attestation";

export const MEDIA_USAGE = `Usage:
  ccx media [status] [--json]
  ccx media settings [--images on|off] [--videos on|off] [--source subscription_oauth|api_key]
  ccx media jobs [list] [--json]
  ccx media jobs wait <opaque-job-id> --revision <n> [--timeout <seconds>]
  ccx media probe
  ccx media acknowledge <opaque-operation-id> --revision <n>
  ccx media <open|reveal|ack-job> <opaque-job-id> --revision <n>
  ccx media recovery [status|reset|acknowledge] ...`;

export type MediaCommandStepState =
  | "pending"
  | "submitting"
  | "accepted"
  | "completed"
  | "failed"
  | "outcome_unknown"
  | "acknowledged";

export interface MediaCommandStatus {
  revision: number;
  source: "subscription_oauth" | "api_key" | null;
  bindingReady: boolean;
  imageModel: string;
  videoModel: string;
  videoDurationSeconds: 1;
  videoResolution: "1080p";
  apiKeyFallbackDisabled: boolean;
  billingAttribution: "unknown";
  ambiguousSubmissionRisk: boolean;
  releaseStatus: "feasibility_only";
  steps: { image: MediaCommandStepState; video: MediaCommandStepState };
  /** Safe local operation id. It is omitted until a durable probe exists. */
  operationId?: string;
  /** Semantic revision for independent image/video/source settings. */
  settingsRevision?: number;
}

export interface MediaCommandJob {
  id: string;
  revision: number;
  state: string;
  phase: "progress" | "human_action_required" | "completed" | "terminal";
  action: "wait" | "recover_auth" | "acknowledge" | "open" | "none";
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export interface MediaSettingsPatch {
  imagesEnabled?: boolean;
  videosEnabled?: boolean;
  authSource?: "subscription_oauth" | "api_key";
}

export interface MediaRecoveryStatus {
  id: string;
  revision: number;
  cause: string;
  readOnly: boolean;
  acknowledgementRequired: boolean;
  restartRequired: boolean;
}

export interface MediaCommandProbeOperation {
  id: string;
  revision: number;
  steps: { image: MediaCommandStepState; video: MediaCommandStepState };
}

export interface MediaCommandService {
  status(): Promise<MediaCommandStatus>;
  probe(input: {
    action: "probe";
    expectedRevision: number;
    confirmation: true;
  }): Promise<MediaCommandStatus>;
  acknowledge(input: {
    action: "acknowledge";
    operationId: string;
    expectedRevision: number;
    confirmation: true;
  }): Promise<MediaCommandStatus>;
  probeOperation?(id: string): Promise<MediaCommandProbeOperation | null>;
  settings?(patch: MediaSettingsPatch, expectedRevision: number): Promise<MediaCommandStatus>;
  jobs?(): Promise<MediaCommandJob[]>;
  job?(id: string): Promise<MediaCommandJob | null>;
  waitJob?(id: string, afterRevision: number, timeoutMs: number): Promise<MediaCommandJob | null>;
  actOnJob?(action: "acknowledge" | "open" | "reveal", id: string, expectedRevision: number): Promise<MediaCommandJob>;
  recovery?(): Promise<MediaRecoveryStatus | null>;
  recover?(action: "quarantine_reset" | "acknowledge", id: string, expectedRevision: number): Promise<MediaRecoveryStatus | null>;
}

export type ParsedMediaCommand =
  | { command: "status"; json: boolean }
  | { command: "probe" }
  | { command: "acknowledge"; operationId: string; revision: number }
  | { command: "settings"; patch: MediaSettingsPatch }
  | { command: "jobs"; json: boolean }
  | { command: "wait"; jobId: string; revision: number; timeoutMs: number }
  | { command: "job-action"; action: "open" | "reveal" | "acknowledge"; jobId: string; revision: number }
  | { command: "recovery-status" }
  | { command: "recovery-action"; action: "quarantine_reset" | "acknowledge"; id: string; revision: number };

export interface MediaCommandDeps {
  attest?: (expectedPid?: number) => Promise<AttestedLiveManagementProxy | null>;
  sameTarget?: (expected: AttestedLiveManagementProxy, current: AttestedLiveManagementProxy) => boolean;
  createService?: (target: AttestedLiveManagementProxy) => MediaCommandService;
  confirm?: (question: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  out?: (line: string) => void;
  error?: (line: string) => void;
}

const STEP_STATES: readonly MediaCommandStepState[] = [
  "pending", "submitting", "accepted", "completed", "failed", "outcome_unknown", "acknowledged",
];
const FIXED_IMAGE_MODEL = "grok-imagine-image-2.0";
const FIXED_VIDEO_MODEL = "grok-imagine-video-1.5";
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function usage(message: string): never {
  throw new CliUsageError(message, MEDIA_USAGE);
}

export function parseMediaArgs(argv: string[]): ParsedMediaCommand {
  const args = [...argv];
  const command = args.shift() ?? "status";
  if (args.includes("--yes")) usage("--yes is not supported for human-only media actions");
  if (command === "status") {
    let json = false;
    if (args[0] === "--json") {
      json = true;
      args.shift();
    }
    if (args.length > 0) usage("Unexpected media status arguments");
    return { command: "status", json };
  }
  if (command === "probe") {
    if (args.length > 0) usage("The capability probe uses fixed server-owned operations and accepts no overrides");
    return { command: "probe" };
  }
  if (command === "settings") {
    const patch: MediaSettingsPatch = {};
    while (args.length > 0) {
      const flag = args.shift();
      const value = args.shift();
      if (!value) usage(`${flag ?? "settings option"} requires a value`);
      if (flag === "--images" || flag === "--videos") {
        if (value !== "on" && value !== "off") usage(`${flag} must be on or off`);
        patch[flag === "--images" ? "imagesEnabled" : "videosEnabled"] = value === "on";
      } else if (flag === "--source") {
        if (value !== "subscription_oauth" && value !== "api_key") usage("--source must be subscription_oauth or api_key");
        patch.authSource = value;
      } else usage("Unknown media settings option");
    }
    if (Object.keys(patch).length === 0) usage("media settings requires at least one option");
    return { command: "settings", patch };
  }
  if (command === "jobs") {
    const sub = args[0];
    if (sub === undefined || sub === "list" || sub === "--json") {
      if (sub === "list") args.shift();
      const json = args.shift() === "--json";
      if (args.length > 0) usage("Unexpected media jobs arguments");
      return { command: "jobs", json };
    }
    if (sub === "wait") {
      args.shift();
      const jobId = args.shift();
      if (!jobId || !OPAQUE_ID.test(jobId)) usage("jobs wait requires one opaque job id");
      if (args.shift() !== "--revision") usage("jobs wait requires --revision");
      const revisionRaw = args.shift();
      if (!revisionRaw || !/^\d+$/.test(revisionRaw)) usage("--revision must be a nonnegative integer");
      let timeoutMs = 45_000;
      if (args[0] === "--timeout") {
        args.shift();
        const seconds = Number(args.shift());
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) usage("--timeout must be an integer from 1 to 300 seconds");
        timeoutMs = seconds * 1_000;
      }
      if (args.length > 0) usage("Unexpected media jobs wait arguments");
      return { command: "wait", jobId, revision: Number(revisionRaw), timeoutMs };
    }
    usage("jobs must be list or wait");
  }
  if (command === "open" || command === "reveal" || command === "ack-job") {
    const jobId = args.shift();
    if (!jobId || !OPAQUE_ID.test(jobId)) usage(`${command} requires one opaque job id`);
    if (args.shift() !== "--revision") usage(`${command} requires --revision`);
    const rawRevision = args.shift();
    if (!rawRevision || !/^\d+$/.test(rawRevision)) usage("--revision must be a nonnegative integer");
    if (args.length > 0) usage(`Unexpected media ${command} arguments`);
    return { command: "job-action", action: command === "ack-job" ? "acknowledge" : command, jobId, revision: Number(rawRevision) };
  }
  if (command === "recovery") {
    const sub = args.shift() ?? "status";
    if (sub === "status") {
      if (args.length > 0) usage("Unexpected media recovery status arguments");
      return { command: "recovery-status" };
    }
    if (sub !== "reset" && sub !== "acknowledge") usage("recovery must be status, reset, or acknowledge");
    const id = args.shift();
    if (!id || !OPAQUE_ID.test(id)) usage(`recovery ${sub} requires one opaque recovery id`);
    if (args.shift() !== "--revision") usage(`recovery ${sub} requires --revision`);
    const rawRevision = args.shift();
    if (!rawRevision || !/^\d+$/.test(rawRevision)) usage("--revision must be a nonnegative integer");
    if (args.length > 0) usage(`Unexpected media recovery ${sub} arguments`);
    return { command: "recovery-action", action: sub === "reset" ? "quarantine_reset" : "acknowledge", id, revision: Number(rawRevision) };
  }
  if (command === "ack" || command === "acknowledge") {
    const operationId = args.shift();
    if (!operationId || !OPAQUE_ID.test(operationId)) usage("acknowledge requires one opaque operation id");
    if (args.shift() !== "--revision") usage("acknowledge requires --revision");
    const rawRevision = args.shift();
    if (!rawRevision || !/^\d+$/.test(rawRevision)) usage("--revision must be a nonnegative integer");
    const revision = Number(rawRevision);
    if (!Number.isSafeInteger(revision)) usage("--revision is outside the supported range");
    if (args.length > 0) usage("Unexpected media acknowledge arguments");
    return { command: "acknowledge", operationId, revision };
  }
  usage("Unknown media command");
}

function safeText(value: unknown, max = 128): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > max
    || value.trim() !== value
    || /[\x00-\x1f\x7f]/.test(value)
  ) throw new RuntimeApiError("The media runtime returned an invalid safe status.", 502, null);
  return value;
}

/** Explicit allowlist: arbitrary server fields are never reflected to the terminal. */
function safeStatus(value: MediaCommandStatus): MediaCommandStatus {
  const record = value as unknown as Record<string, unknown>;
  const steps = record.steps as Record<string, unknown> | undefined;
  const imageStep = steps?.image;
  const videoStep = steps?.video;
  if (
    !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
    || (record.source !== null && record.source !== "subscription_oauth" && record.source !== "api_key")
    || typeof record.bindingReady !== "boolean"
    || record.imageModel !== FIXED_IMAGE_MODEL
    || record.videoModel !== FIXED_VIDEO_MODEL
    || record.videoDurationSeconds !== 1
    || record.videoResolution !== "1080p"
    || typeof record.apiKeyFallbackDisabled !== "boolean"
    || record.billingAttribution !== "unknown"
    || typeof record.ambiguousSubmissionRisk !== "boolean"
    || record.releaseStatus !== "feasibility_only"
    || typeof imageStep !== "string" || !STEP_STATES.includes(imageStep as MediaCommandStepState)
    || typeof videoStep !== "string" || !STEP_STATES.includes(videoStep as MediaCommandStepState)
  ) throw new RuntimeApiError("The media runtime returned an invalid safe status.", 502, null);
  return {
    revision: record.revision as number,
    source: record.source as MediaCommandStatus["source"],
    bindingReady: record.bindingReady as boolean,
    imageModel: safeText(record.imageModel),
    videoModel: safeText(record.videoModel),
    videoDurationSeconds: 1,
    videoResolution: "1080p",
    apiKeyFallbackDisabled: record.apiKeyFallbackDisabled as boolean,
    billingAttribution: "unknown",
    ambiguousSubmissionRisk: record.ambiguousSubmissionRisk as boolean,
    releaseStatus: "feasibility_only",
    steps: { image: imageStep as MediaCommandStepState, video: videoStep as MediaCommandStepState },
    ...(typeof record.operationId === "string" && OPAQUE_ID.test(record.operationId)
      ? { operationId: record.operationId }
      : {}),
    ...(Number.isSafeInteger(record.settingsRevision) && (record.settingsRevision as number) >= 0
      ? { settingsRevision: record.settingsRevision as number }
      : {}),
  };
}

function unavailableService(): MediaCommandService {
  const unavailable = async (): Promise<never> => {
    throw new RuntimeApiError(
      "The attested media runtime resource is unavailable in this build; no paid action was attempted.",
      503,
      null,
    );
  };
  return { status: unavailable, probe: unavailable, acknowledge: unavailable };
}

function exactSafeJob(value: unknown): MediaCommandJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeApiError("The media runtime returned an invalid safe job.", 502, null);
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" || !OPAQUE_ID.test(row.id)
    || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0
    || typeof row.state !== "string" || !/^[a-z_]+$/.test(row.state)
    || !["progress", "human_action_required", "completed", "terminal"].includes(String(row.phase))
    || !["wait", "recover_auth", "acknowledge", "open", "none"].includes(String(row.action))
    || typeof row.reason !== "string" || row.reason.length > 64 || !/^[a-z_]+$/.test(row.reason)
    || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.updatedAt)
  ) throw new RuntimeApiError("The media runtime returned an invalid safe job.", 502, null);
  return {
    id: row.id,
    revision: row.revision as number,
    state: row.state,
    phase: row.phase as MediaCommandJob["phase"],
    action: row.action as MediaCommandJob["action"],
    reason: row.reason,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
  };
}

function exactRecovery(value: unknown): MediaRecoveryStatus | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeApiError("The media runtime returned invalid recovery status.", 502, null);
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" || !OPAQUE_ID.test(row.id)
    || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0
    || typeof row.cause !== "string" || !/^[a-z_]+$/.test(row.cause)
    || typeof row.readOnly !== "boolean"
    || typeof row.acknowledgementRequired !== "boolean"
    || typeof row.restartRequired !== "boolean"
  ) throw new RuntimeApiError("The media runtime returned invalid recovery status.", 502, null);
  return {
    id: row.id,
    revision: row.revision as number,
    cause: row.cause,
    readOnly: row.readOnly,
    acknowledgementRequired: row.acknowledgementRequired,
    restartRequired: row.restartRequired,
  };
}

function exactProbeOperation(value: unknown): MediaCommandProbeOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeApiError("The media runtime returned an invalid safe probe.", 502, null);
  const row = value as Record<string, unknown>;
  const steps = row.steps as Record<string, unknown> | undefined;
  const image = steps?.image as Record<string, unknown> | undefined;
  const video = steps?.video as Record<string, unknown> | undefined;
  if (
    typeof row.id !== "string" || !OPAQUE_ID.test(row.id)
    || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0
    || typeof image?.state !== "string" || !STEP_STATES.includes(image.state as MediaCommandStepState)
    || typeof video?.state !== "string" || !STEP_STATES.includes(video.state as MediaCommandStepState)
  ) throw new RuntimeApiError("The media runtime returned an invalid safe probe.", 502, null);
  return {
    id: row.id,
    revision: row.revision as number,
    steps: { image: image.state as MediaCommandStepState, video: video.state as MediaCommandStepState },
  };
}

function createHttpMediaService(target: AttestedLiveManagementProxy, fetchImpl: typeof fetch = fetch): MediaCommandService {
  let latestResource: Record<string, unknown> | null = null;
  const request = async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
    const headers = runningProxyUpdateHeaders();
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    const response = await fetchImpl(`${target.baseUrl}${path}`, { ...init, headers });
    let value: unknown = null;
    try { value = await response.json(); } catch { /* handled as invalid below */ }
    if (!response.ok) throw new RuntimeApiError("Media management request was refused safely.", response.status, null);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeApiError("The media runtime returned invalid data.", 502, null);
    return value as Record<string, unknown>;
  };
  const read = async (): Promise<{ status: MediaCommandStatus; resource: Record<string, unknown> }> => {
    const resource = await request("/api/media?limit=100");
    latestResource = resource;
    const settings = resource.settings as Record<string, unknown> | undefined;
    const readiness = resource.readiness as Record<string, unknown> | undefined;
    const credential = readiness?.credential as Record<string, unknown> | undefined;
    const probe = resource.probe as Record<string, unknown> | null | undefined;
    const steps = probe?.steps as Record<string, { state?: unknown }> | undefined;
    const status: MediaCommandStatus = {
      revision: Number.isSafeInteger(probe?.revision) ? probe!.revision as number : resource.revision as number,
      source: settings?.authSource === "subscription_oauth" || settings?.authSource === "api_key" ? settings.authSource : null,
      bindingReady: credential?.state === "ready",
      imageModel: FIXED_IMAGE_MODEL,
      videoModel: FIXED_VIDEO_MODEL,
      videoDurationSeconds: 1,
      videoResolution: "1080p",
      apiKeyFallbackDisabled: resource.sourceFallback === "disabled",
      billingAttribution: "unknown",
      ambiguousSubmissionRisk: true,
      releaseStatus: "feasibility_only",
      steps: {
        image: typeof steps?.image?.state === "string" ? steps.image.state as MediaCommandStepState : "pending",
        video: typeof steps?.video?.state === "string" ? steps.video.state as MediaCommandStepState : "pending",
      },
      ...(typeof probe?.id === "string" ? { operationId: probe.id } : {}),
      ...(Number.isSafeInteger(resource.revision) ? { settingsRevision: resource.revision as number } : {}),
    };
    return { status: safeStatus(status), resource };
  };
  const postAction = (body: Record<string, unknown>) => {
    const envelope = {
      ...body,
      confirmation: true as const,
      caller: "interactive_cli" as const,
      nonce: randomBytes(32).toString("base64url"),
      issuedAt: Date.now(),
    } as MediaActionAttestationInput;
    const proof = target.proveMediaAction?.(envelope);
    if (!proof) throw new RuntimeApiError("The attested runtime cannot prove this media action.", 403, null);
    return request("/api/media/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", [MEDIA_ACTION_ATTESTATION_HEADER]: proof },
      body: JSON.stringify(envelope),
    });
  };
  return {
    status: async () => (await read()).status,
    async probe(input) {
      const current = (await read()).status;
      if (!current.operationId) throw new RuntimeApiError("No durable capability probe is available.", 409, null);
      await postAction({ action: "probe", target: "probe", id: current.operationId, expectedRevision: input.expectedRevision });
      return (await read()).status;
    },
    async acknowledge(input) {
      const current = await this.probeOperation!(input.operationId);
      const step = current?.steps.image === "outcome_unknown" ? "image"
        : current?.steps.video === "outcome_unknown" ? "video" : null;
      if (!step) throw new RuntimeApiError("No outcome-unknown probe step is available.", 409, null);
      await postAction({ action: "acknowledge", target: "probe", step, id: input.operationId, expectedRevision: input.expectedRevision });
      return (await read()).status;
    },
    async probeOperation(id) {
      try {
        const value = await request(`/api/media/probes/${encodeURIComponent(id)}`);
        return exactProbeOperation(value.probe);
      } catch (error) {
        if (error instanceof RuntimeApiError && error.status === 404) return null;
        throw error;
      }
    },
    async settings(patch, expectedRevision) {
      const envelope = {
        action: "settings" as const,
        target: "settings" as const,
        id: "media-settings",
        expectedRevision,
        ...patch,
        confirmation: true as const,
        caller: "interactive_cli" as const,
        nonce: randomBytes(32).toString("base64url"),
        issuedAt: Date.now(),
      } satisfies MediaActionAttestationInput;
      const proof = target.proveMediaAction?.(envelope);
      if (!proof) throw new RuntimeApiError("The attested runtime cannot prove this media settings action.", 403, null);
      const value = await request("/api/media", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", [MEDIA_ACTION_ATTESTATION_HEADER]: proof },
        body: JSON.stringify(envelope),
      });
      latestResource = value;
      return (await read()).status;
    },
    async jobs() {
      const value = await request("/api/media?limit=100");
      if (!Array.isArray(value.jobs)) throw new RuntimeApiError("The media runtime returned invalid jobs.", 502, null);
      return value.jobs.map(exactSafeJob);
    },
    async job(id) {
      try {
        const value = await request(`/api/media/jobs/${encodeURIComponent(id)}`);
        return exactSafeJob(value.job);
      } catch (error) {
        if (error instanceof RuntimeApiError && error.status === 404) return null;
        throw error;
      }
    },
    async waitJob(id, afterRevision, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const job = await this.job!(id);
        if (!job || job.revision > afterRevision || job.phase !== "progress") return job;
        if (Date.now() >= deadline) return job;
        await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
      }
    },
    async actOnJob(action, id, expectedRevision) {
      const value = await postAction({ action, target: "job", id, expectedRevision });
      if (value.job) return exactSafeJob(value.job);
      const current = await this.job!(id);
      if (!current) throw new RuntimeApiError("The media job is unavailable after the action.", 409, null);
      return current;
    },
    async recovery() {
      const value = await request("/api/media?limit=1");
      return exactRecovery(value.recovery);
    },
    async recover(action, id, expectedRevision) {
      await postAction({ action, target: "recovery", id, expectedRevision });
      return await this.recovery!();
    },
  };
}

function printStatus(value: MediaCommandStatus, out: (line: string) => void, json: boolean): void {
  const projected = safeStatus(value);
  if (json) {
    out(JSON.stringify(projected, null, 2));
    return;
  }
  out(`Media source: ${projected.source ?? "not configured"}`);
  out(`Binding readiness: ${projected.bindingReady ? "ready" : "blocked"}`);
  out(`Fixed image operation: ${projected.imageModel}`);
  out(`Fixed video operation: ${projected.videoModel}, 1 second, 1080p`);
  out(`API-key fallback: ${projected.apiKeyFallbackDisabled ? "disabled" : "not proven disabled"}`);
  out("Capability only; billing attribution: unknown");
  out(`Ambiguous-submit risk: ${projected.ambiguousSubmissionRisk ? "may consume quota without a result" : "not acknowledged"}`);
  out("Release status: feasibility only; this is not packaged verification");
  out(`Image step: ${projected.steps.image}`);
  out(`Video step: ${projected.steps.video}`);
}

function errorExit(error: unknown, write: (line: string) => void): number {
  if (error instanceof CliUsageError) {
    write(`Error: ${error.message}`);
    if (error.usage) write(error.usage);
    return 2;
  }
  if (error instanceof RuntimeApiError) {
    write("Error: Media command refused safely; no paid action was attempted.");
    return error.status === 404 ? 4 : error.status === 409 ? 5 : 1;
  }
  write("Error: Media command failed safely; no paid action was attempted.");
  return 1;
}

export async function handleMediaCommand(argv: string[], deps: MediaCommandDeps = {}): Promise<number> {
  const out = deps.out ?? (line => console.log(line));
  const writeError = deps.error ?? (line => console.error(line));
  let parsed: ParsedMediaCommand;
  try {
    parsed = parseMediaArgs(argv);
  } catch (error) {
    return errorExit(error, writeError);
  }
  const attest = deps.attest ?? (expectedPid => attestLiveManagementProxy(
    expectedPid === undefined ? {} : { expectedPid },
  ));
  const sameTarget = deps.sameTarget ?? sameAttestedRuntimeTarget;
  const createService = deps.createService ?? (target => createHttpMediaService(target, deps.fetchImpl));
  const confirm = deps.confirm ?? (question => interactiveConfirm({ question, defaultYes: false }));
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = deps.stdoutIsTTY ?? process.stdout.isTTY === true;

  try {
    const initial = await attest();
    if (!initial) {
      throw new RuntimeApiError(
        "Media command refused: the live runtime could not be authenticated.",
        503,
        null,
      );
    }
    const service = createService(initial);
    const preview = safeStatus(await service.status());
    printStatus(preview, out, parsed.command === "status" && parsed.json);
    if (parsed.command === "status") return 0;
    if (parsed.command === "jobs") {
      const jobs = await service.jobs?.();
      if (!jobs) throw new RuntimeApiError("Media jobs are unavailable.", 503, null);
      if (parsed.json) out(JSON.stringify(jobs, null, 2));
      else if (jobs.length === 0) out("No durable media jobs.");
      else for (const job of jobs) out(`${job.id}  ${job.state}  rev:${job.revision}  ${job.action}`);
      return 0;
    }
    if (parsed.command === "wait") {
      const job = await service.waitJob?.(parsed.jobId, parsed.revision, parsed.timeoutMs);
      if (!job) return 4;
      out(`${job.id}  ${job.state}  rev:${job.revision}  ${job.action}`);
      if (job.phase === "completed") return 0;
      if (job.phase === "human_action_required") return 6;
      if (job.phase === "terminal") return 7;
      return 8;
    }
    if (parsed.command === "recovery-status") {
      const recovery = await service.recovery?.();
      if (!recovery) out("Media recovery is ready.");
      else out(`${recovery.id}  ${recovery.cause}  rev:${recovery.revision}  ${recovery.acknowledgementRequired ? "acknowledgement-required" : "restart-required"}`);
      return 0;
    }
    if (
      parsed.command === "probe"
      && (preview.source !== "subscription_oauth" || !preview.bindingReady || !preview.apiKeyFallbackDisabled)
    ) {
      throw new RuntimeApiError("Media OAuth binding is not ready.", 403, null);
    }
    if (!stdinIsTTY || !stdoutIsTTY) {
      throw new RuntimeApiError("Media settings and paid/recovery actions require an interactive terminal.", 403, null);
    }
    let question: string;
    if (parsed.command === "settings") {
      const changes = [
        parsed.patch.imagesEnabled === undefined ? null : `images ${parsed.patch.imagesEnabled ? "on" : "off"}`,
        parsed.patch.videosEnabled === undefined ? null : `videos ${parsed.patch.videosEnabled ? "on" : "off"}`,
        parsed.patch.authSource === undefined ? null : `source ${parsed.patch.authSource}`,
      ].filter((value): value is string => value !== null);
      question = `Apply media settings: ${changes.join(", ")}?`;
    } else if (parsed.command === "probe") {
      question = "Run exactly one fixed image and one one-second 1080p video capability probe?";
    } else if (parsed.command === "acknowledge") {
      question = `Acknowledge outcome-unknown media operation ${parsed.operationId}?`;
    } else {
      question = parsed.command === "job-action"
        ? `${parsed.action === "acknowledge" ? "Acknowledge" : parsed.action === "reveal" ? "Reveal" : "Open"} media job ${parsed.jobId}?`
        : `${parsed.action === "acknowledge" ? "Acknowledge" : "Quarantine and reset"} media recovery fence ${parsed.id}?`;
    }
    if (!await confirm(question)) {
      writeError("Media action declined; no mutation or paid request was attempted.");
      return 1;
    }
    // Consent is bound to the runtime that rendered the preview. Re-prove it after the prompt.
    const fresh = await attest(initial.pid);
    if (!fresh || !sameTarget(initial, fresh)) {
      throw new RuntimeApiError("Media action refused because the attested runtime changed during confirmation.", 409, null);
    }
    const freshService = createService(fresh);
    const freshPreview = safeStatus(await freshService.status());
    if (parsed.command === "settings") {
      const expectedRevision = preview.settingsRevision ?? preview.revision;
      const freshRevision = freshPreview.settingsRevision ?? freshPreview.revision;
      if (freshRevision !== expectedRevision) {
        throw new RuntimeApiError("Media settings changed during confirmation.", 409, null);
      }
      const result = await freshService.settings?.(parsed.patch, expectedRevision);
      if (!result) throw new RuntimeApiError("Media settings are unavailable.", 503, null);
      printStatus(result, out, false);
      return 0;
    }
    if (parsed.command === "job-action") {
      const current = await freshService.job?.(parsed.jobId);
      if (!current || current.revision !== parsed.revision) {
        throw new RuntimeApiError("Media action refused because the job changed during confirmation.", 409, null);
      }
      const job = await freshService.actOnJob?.(parsed.action, parsed.jobId, parsed.revision);
      if (!job) throw new RuntimeApiError("Media job action is unavailable.", 503, null);
      out(`${job.id}  ${job.state}  rev:${job.revision}  ${job.action}`);
      return 0;
    }
    if (parsed.command === "recovery-action") {
      const current = await freshService.recovery?.();
      if (!current || current.id !== parsed.id || current.revision !== parsed.revision) {
        throw new RuntimeApiError("Media action refused because recovery state changed during confirmation.", 409, null);
      }
      const recovery = await freshService.recover?.(parsed.action, parsed.id, parsed.revision);
      if (recovery) out(`${recovery.id}  ${recovery.cause}  rev:${recovery.revision}  restart-required`);
      else out("Media recovery action applied; restart required.");
      return 0;
    }
    if (parsed.command === "probe") {
      if (freshPreview.revision !== preview.revision || freshPreview.operationId !== preview.operationId) {
        throw new RuntimeApiError("Media action refused because the probe changed during confirmation.", 409, null);
      }
    } else {
      const exact = freshPreview.operationId === parsed.operationId
        ? { id: freshPreview.operationId, revision: freshPreview.revision, steps: freshPreview.steps }
        : await freshService.probeOperation?.(parsed.operationId);
      if (!exact || exact.revision !== parsed.revision) {
        throw new RuntimeApiError("Media action refused because the probe changed during confirmation.", 409, null);
      }
    }
    const result = parsed.command === "probe"
      ? await freshService.probe({ action: "probe", expectedRevision: freshPreview.revision, confirmation: true })
      : await freshService.acknowledge({
          action: "acknowledge",
          operationId: parsed.operationId,
          expectedRevision: parsed.revision,
          confirmation: true,
        });
    printStatus(safeStatus(result), out, false);
    return 0;
  } catch (error) {
    return errorExit(error, writeError);
  }
}

/** xAI video submit/poll request shaping over the shared fixed-origin media transport. */
import type { MediaCredentialBinding } from "./types";
import {
  bindLegacyStaticApiKey,
  createStaticMediaCredentialLease,
} from "./media-credentials";
import { ambiguousMediaSuccess, mediaError } from "./media-errors";
import {
  requestXaiMediaJson,
  type XaiMediaTransportDeps,
} from "./xai-media-transport";
import type { LegacyXaiMediaAuth } from "./xai-client";

export interface XaiVideoSubmitRequest {
  prompt: string;
  model?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
}

export interface XaiVideoSubmitResult {
  requestId: string;
}

export interface XaiVideoPollResult {
  status: "processing" | "done" | "failed" | "expired";
  videoUrl?: string;
  progress?: number;
}

export interface XaiVideoClientOptions extends XaiMediaTransportDeps {
  /** Persisted absolute job deadline. Poll attempts cannot extend it. */
  deadlineAt?: number;
  /** Per-request ceiling, shortened by deadlineAt when supplied. */
  timeoutMs?: number;
}

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
const DEFAULT_VIDEO_MODEL = "grok-imagine-video";

function isBinding(value: MediaCredentialBinding | LegacyXaiMediaAuth): value is MediaCredentialBinding {
  return "authSource" in value && "slotRef" in value && "identityDigest" in value;
}

function transportContext(
  credential: MediaCredentialBinding | LegacyXaiMediaAuth,
  deps: XaiMediaTransportDeps,
): { binding: MediaCredentialBinding; deps: XaiMediaTransportDeps } {
  if (isBinding(credential)) return { binding: credential, deps };
  const binding = bindLegacyStaticApiKey(credential.token);
  return {
    binding,
    deps: { ...deps, lease: createStaticMediaCredentialLease(binding, credential.token) },
  };
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : undefined;
}

export async function submitVideoJob(
  req: XaiVideoSubmitRequest,
  credential: MediaCredentialBinding | LegacyXaiMediaAuth,
  signal?: AbortSignal,
  options: XaiVideoClientOptions = {},
): Promise<XaiVideoSubmitResult> {
  const body: Record<string, unknown> = {
    model: req.model ?? DEFAULT_VIDEO_MODEL,
    prompt: req.prompt,
  };
  if (typeof req.duration === "number") body.duration = req.duration;
  if (typeof req.resolution === "string") body.resolution = req.resolution;
  if (typeof req.aspectRatio === "string") body.aspect_ratio = req.aspectRatio;

  const { deadlineAt, timeoutMs = SUBMIT_TIMEOUT_MS, ...deps } = options;
  const context = transportContext(credential, deps);
  const response = await requestXaiMediaJson({
    operation: "video_submit",
    binding: context.binding,
    body,
    signal,
    timeoutMs,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  }, context.deps);
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw ambiguousMediaSuccess("malformed_response");
  }
  const value = response as { request_id?: unknown; id?: unknown };
  const requestId = safeRequestId(value.request_id) ?? safeRequestId(value.id);
  if (!requestId) throw ambiguousMediaSuccess("missing_result");
  return { requestId };
}

export async function pollVideoJob(
  requestId: string,
  credential: MediaCredentialBinding | LegacyXaiMediaAuth,
  signal?: AbortSignal,
  options: XaiVideoClientOptions = {},
): Promise<XaiVideoPollResult> {
  const { deadlineAt, timeoutMs = POLL_TIMEOUT_MS, ...deps } = options;
  const context = transportContext(credential, deps);
  const response = await requestXaiMediaJson({
    operation: "video_poll",
    binding: context.binding,
    requestId,
    signal,
    timeoutMs,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  }, context.deps);
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw mediaError({
      code: "upstream_failed",
      phase: "poll",
      certainty: "definite",
      reason: "malformed_response",
    });
  }
  const value = response as {
    status?: unknown;
    state?: unknown;
    video?: { url?: unknown };
    videos?: Array<{ url?: unknown }>;
    progress?: unknown;
  };
  const raw = typeof value.status === "string"
    ? value.status
    : typeof value.state === "string"
      ? value.state
      : undefined;
  if (!raw) {
    throw mediaError({
      code: "upstream_failed",
      phase: "poll",
      certainty: "definite",
      reason: "malformed_response",
    });
  }

  const normalized = raw.toLowerCase();
  let status: XaiVideoPollResult["status"];
  if (normalized === "done" || normalized === "completed" || normalized === "succeeded") status = "done";
  else if (normalized === "failed" || normalized === "error") status = "failed";
  else if (normalized === "expired" || normalized === "timeout") status = "expired";
  else status = "processing";

  const nestedUrl = value.video && typeof value.video.url === "string" ? value.video.url : undefined;
  const listUrl = Array.isArray(value.videos) && typeof value.videos[0]?.url === "string"
    ? value.videos[0].url
    : undefined;
  const videoUrl = nestedUrl ?? listUrl;
  const progress = typeof value.progress === "number" && Number.isFinite(value.progress)
    ? value.progress
    : undefined;
  return {
    status,
    ...(videoUrl ? { videoUrl } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
}

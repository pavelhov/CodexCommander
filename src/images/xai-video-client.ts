/** xAI video submit/poll request shaping over the shared fixed-origin media transport. */
import type { MediaCredentialBinding } from "./types";
import { ambiguousMediaSuccess, mediaError } from "./media-errors";
import {
  requestXaiMediaJson,
  type XaiMediaTransportDeps,
} from "./xai-media-transport";

export interface XaiVideoSubmitRequest {
  prompt: string;
  model?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  audio?: boolean;
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
export const XAI_VIDEO_MODEL = "grok-imagine-video-1.5";
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p"]);
const VIDEO_ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]);
const VIDEO_REQUEST_KEYS = new Set(["prompt", "model", "duration", "resolution", "aspectRatio", "audio"]);

function invalidVideoRequest(): never {
  throw mediaError({ code: "invalid_request", phase: "pre_dispatch", certainty: "definite" });
}

function normalizedSubmitBody(req: XaiVideoSubmitRequest): Record<string, unknown> {
  if (!req || typeof req !== "object" || Object.keys(req).some(key => !VIDEO_REQUEST_KEYS.has(key))) {
    return invalidVideoRequest();
  }
  if (typeof req.prompt !== "string" || !req.prompt.trim()) return invalidVideoRequest();
  if (req.model !== undefined && req.model !== XAI_VIDEO_MODEL) return invalidVideoRequest();
  const duration = req.duration ?? 6;
  const resolution = req.resolution ?? "720p";
  const aspectRatio = req.aspectRatio ?? "16:9";
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) return invalidVideoRequest();
  if (!VIDEO_RESOLUTIONS.has(resolution)) return invalidVideoRequest();
  if (!VIDEO_ASPECT_RATIOS.has(aspectRatio)) return invalidVideoRequest();
  if (req.audio !== undefined && typeof req.audio !== "boolean") return invalidVideoRequest();
  return {
    model: XAI_VIDEO_MODEL,
    prompt: req.prompt,
    duration,
    resolution,
    aspect_ratio: aspectRatio,
    ...(req.audio !== undefined ? { audio: req.audio } : {}),
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
  credential: MediaCredentialBinding,
  signal?: AbortSignal,
  options: XaiVideoClientOptions = {},
): Promise<XaiVideoSubmitResult> {
  const body = normalizedSubmitBody(req);

  const { deadlineAt, timeoutMs = SUBMIT_TIMEOUT_MS, ...deps } = options;
  const response = await requestXaiMediaJson({
    operation: "video_submit",
    binding: credential,
    body,
    signal,
    timeoutMs,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  }, deps);
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
  credential: MediaCredentialBinding,
  signal?: AbortSignal,
  options: XaiVideoClientOptions = {},
): Promise<XaiVideoPollResult> {
  const { deadlineAt, timeoutMs = POLL_TIMEOUT_MS, ...deps } = options;
  const response = await requestXaiMediaJson({
    operation: "video_poll",
    binding: credential,
    requestId,
    signal,
    timeoutMs,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  }, deps);
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

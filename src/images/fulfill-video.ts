import type { VideoCallResult } from "./types";
import { artifactHttpUrl } from "./artifacts";
import { snapshotAuthorizedMediaInputs, type MediaInputSnapshot } from "./media-input-snapshot";
import type { MediaInputHandleTable } from "./media-input-handles";

export const DEFAULT_VIDEO_DURATION_SECONDS = 6;
export const DEFAULT_VIDEO_RESOLUTION = "720p" as const;
export const DEFAULT_VIDEO_ASPECT_RATIO = "16:9" as const;

export type VideoResolution = "480p" | "720p" | "1080p";

const VIDEO_RESOLUTIONS = new Set<VideoResolution>(["480p", "720p", "1080p"]);
const VIDEO_ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]);
const VIDEO_ARGUMENTS = new Set([
  "prompt", "input", "duration", "resolution", "aspect_ratio", "audio",
  "starting_image_handle", "reference_image_handles",
]);

/** Validated v1 text-to-video arguments. Defaults are explicit before submission. */
export interface ParsedVideoArgs {
  ok: true;
  prompt: string;
  duration: number;
  resolution: VideoResolution;
  aspectRatio: string;
  audio?: boolean;
  mode: "text" | "starting_image" | "reference_images";
  startingImage?: MediaInputSnapshot;
  referenceImages?: readonly MediaInputSnapshot[];
}

export type ParsedVideoCallArgs = ParsedVideoArgs | { ok: false; error: string };

/**
 * Parse the exact v1 text-to-video schema. Unknown/media-input fields and invalid
 * values are rejected rather than silently dropped or clamped.
 */
export function parseVideoCallArgs(raw: string, handles?: MediaInputHandleTable): ParsedVideoCallArgs {
  let args: unknown;
  try {
    args = JSON.parse(raw || "{}");
  } catch {
    return { ok: false, error: "invalid arguments JSON" };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, error: "invalid arguments JSON" };
  }
  const obj = args as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!VIDEO_ARGUMENTS.has(key)) return { ok: false, error: `unsupported video argument: ${key}` };
  }

  if (Object.hasOwn(obj, "prompt") && Object.hasOwn(obj, "input")) {
    return { ok: false, error: "prompt and input cannot both be supplied" };
  }
  if (obj.input !== undefined && typeof obj.input !== "string") {
    return { ok: false, error: "input must be a string" };
  }
  const promptValue = obj.prompt ?? obj.input;
  const prompt = typeof promptValue === "string" ? promptValue.trim() : "";
  if (!prompt) return { ok: false, error: "missing prompt" };

  const duration = obj.duration === undefined ? DEFAULT_VIDEO_DURATION_SECONDS : obj.duration;
  if (!Number.isInteger(duration) || (duration as number) < 1 || (duration as number) > 15) {
    return { ok: false, error: "duration must be an integer from 1 through 15" };
  }

  const resolution = obj.resolution === undefined ? DEFAULT_VIDEO_RESOLUTION : obj.resolution;
  if (typeof resolution !== "string" || !VIDEO_RESOLUTIONS.has(resolution as VideoResolution)) {
    return { ok: false, error: "unsupported resolution" };
  }

  const aspectRatio = obj.aspect_ratio === undefined ? DEFAULT_VIDEO_ASPECT_RATIO : obj.aspect_ratio;
  if (typeof aspectRatio !== "string" || !VIDEO_ASPECT_RATIOS.has(aspectRatio)) {
    return { ok: false, error: "unsupported aspect_ratio" };
  }
  if (obj.audio !== undefined && typeof obj.audio !== "boolean") {
    return { ok: false, error: "audio must be a boolean" };
  }

  if (obj.starting_image_handle !== undefined && obj.reference_image_handles !== undefined) {
    return { ok: false, error: "starting_image_handle and reference_image_handles cannot both be supplied" };
  }
  let mode: ParsedVideoArgs["mode"] = "text";
  let startingImage: MediaInputSnapshot | undefined;
  let referenceImages: readonly MediaInputSnapshot[] | undefined;
  try {
    if (obj.starting_image_handle !== undefined) {
      if (typeof obj.starting_image_handle !== "string" || !obj.starting_image_handle) {
        return { ok: false, error: "invalid starting_image_handle" };
      }
      const input = handles?.resolve(obj.starting_image_handle);
      if (!input) return { ok: false, error: "unknown or stale starting_image_handle" };
      [startingImage] = snapshotAuthorizedMediaInputs([input]);
      mode = "starting_image";
    } else if (obj.reference_image_handles !== undefined) {
      if (!Array.isArray(obj.reference_image_handles)
        || obj.reference_image_handles.length < 1
        || obj.reference_image_handles.length > 7
        || obj.reference_image_handles.some(value => typeof value !== "string" || !value)) {
        return { ok: false, error: "reference_image_handles must contain one through seven handles" };
      }
      const labels = obj.reference_image_handles as string[];
      if (new Set(labels).size !== labels.length) {
        return { ok: false, error: "reference_image_handles cannot repeat a handle" };
      }
      const inputs = labels.map(label => handles?.resolve(label));
      if (inputs.some(input => !input)) return { ok: false, error: "unknown or stale reference_image_handle" };
      referenceImages = snapshotAuthorizedMediaInputs(inputs as NonNullable<(typeof inputs)[number]>[]);
      mode = "reference_images";
      if (resolution === "1080p") return { ok: false, error: "reference-image video does not support 1080p" };
    }
  } catch {
    return { ok: false, error: "invalid current-turn image input" };
  }

  return {
    ok: true,
    prompt,
    duration: duration as number,
    resolution: resolution as VideoResolution,
    aspectRatio,
    mode,
    ...(startingImage ? { startingImage } : {}),
    ...(referenceImages ? { referenceImages } : {}),
    ...(typeof obj.audio === "boolean" ? { audio: obj.audio } : {}),
  };
}

export interface VideoResultMetadata {
  duration?: number;
  resolution?: VideoResolution;
  aspectRatio?: string;
  audio?: boolean;
  jobId?: string;
}

/** Build the final local-only result after the durable runtime publishes an artifact. */
export function buildVideoResult(
  path: string,
  prompt: string,
  model: string,
  metadata: VideoResultMetadata = {},
): VideoCallResult {
  return {
    ok: true,
    model,
    prompt,
    path,
    files: [path],
    count: 1,
    markdown: `[Open video](${artifactHttpUrl(path)})`,
    ...metadata,
  };
}

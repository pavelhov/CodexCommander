import { pathToFileURL } from "node:url";

import type { VideoCallResult } from "./types";

export const DEFAULT_VIDEO_DURATION_SECONDS = 6;
export const DEFAULT_VIDEO_RESOLUTION = "720p" as const;
export const DEFAULT_VIDEO_ASPECT_RATIO = "16:9" as const;

export type VideoResolution = "480p" | "720p" | "1080p";

const VIDEO_RESOLUTIONS = new Set<VideoResolution>(["480p", "720p", "1080p"]);
const VIDEO_ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]);
const VIDEO_ARGUMENTS = new Set(["prompt", "duration", "resolution", "aspect_ratio", "audio"]);

/** Validated v1 text-to-video arguments. Defaults are explicit before submission. */
export interface ParsedVideoArgs {
  ok: true;
  prompt: string;
  duration: number;
  resolution: VideoResolution;
  aspectRatio: string;
  audio?: boolean;
}

export type ParsedVideoCallArgs = ParsedVideoArgs | { ok: false; error: string };

/**
 * Parse the exact v1 text-to-video schema. Unknown/media-input fields and invalid
 * values are rejected rather than silently dropped or clamped.
 */
export function parseVideoCallArgs(raw: string): ParsedVideoCallArgs {
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

  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
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

  return {
    ok: true,
    prompt,
    duration: duration as number,
    resolution: resolution as VideoResolution,
    aspectRatio,
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
    markdown: `[Open video](${pathToFileURL(path).href})`,
    ...metadata,
  };
}

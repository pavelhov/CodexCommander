/** xAI image request shaping over the shared fixed-origin media transport. */
import type { MediaCredentialBinding } from "./types";
import { ambiguousMediaSuccess, mediaError } from "./media-errors";
import {
  requestXaiMediaJson,
  type XaiMediaTransportDeps,
} from "./xai-media-transport";

export interface XaiImageRequest {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  quality?: string;
  imageUrl?: string;
}

export interface XaiImageResult {
  images: Array<{ b64_json?: string; url?: string }>;
}

const XAI_IMAGES_TIMEOUT_MS = 60_000;
const XAI_DEFAULT_MODEL = "grok-imagine-image-2.0";
const MAX_IMAGES_PER_RESULT = 4;

const XAI_ASPECT_RATIOS: ReadonlyArray<readonly [string, number]> = [
  ["1:1", 1],
  ["3:4", 0.75],
  ["4:3", 4 / 3],
  ["9:16", 0.5625],
  ["16:9", 16 / 9],
];

function mapSizeToAspectRatio(size?: string): string | undefined {
  if (!size) return undefined;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return undefined;
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  if (width <= 0 || height <= 0) return undefined;
  const ratio = width / height;
  let best = XAI_ASPECT_RATIOS[0]!;
  let bestDiff = Infinity;
  for (const candidate of XAI_ASPECT_RATIOS) {
    const diff = Math.abs(Math.log(ratio / candidate[1]));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best[0];
}

function mapQualityToResolution(quality?: string): string | undefined {
  if (!quality) return undefined;
  const normalized = quality.toLowerCase();
  if (normalized === "hd" || normalized === "high") return "2k";
  if (normalized === "standard" || normalized === "low" || normalized === "auto") return "1k";
  return undefined;
}

function normalizedImages(value: unknown): XaiImageResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw ambiguousMediaSuccess("malformed_response");
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0 || data.length > MAX_IMAGES_PER_RESULT) {
    throw ambiguousMediaSuccess("missing_result");
  }
  const images: XaiImageResult["images"] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw ambiguousMediaSuccess("malformed_response");
    const entry = raw as { b64_json?: unknown; url?: unknown };
    const b64 = typeof entry.b64_json === "string" && entry.b64_json.length > 0 ? entry.b64_json : undefined;
    const url = typeof entry.url === "string" && entry.url.length > 0 ? entry.url : undefined;
    if (!b64 && !url) throw ambiguousMediaSuccess("missing_result");
    images.push({ ...(b64 ? { b64_json: b64 } : {}), ...(url ? { url } : {}) });
  }
  return { images };
}

/**
 * Bound callers provide only MediaCredentialBinding. URL, headers, provider and bearer material
 * are deliberately absent from this API so a request cannot redirect the sealed media transport.
 */
export async function callXaiImages(
  req: XaiImageRequest,
  credential: MediaCredentialBinding,
  signal?: AbortSignal,
  timeoutMs: number = XAI_IMAGES_TIMEOUT_MS,
  deps: XaiMediaTransportDeps = {},
): Promise<XaiImageResult> {
  const isEdit = typeof req.imageUrl === "string" && req.imageUrl.length > 0;
  if (isEdit) {
    throw mediaError({
      code: "invalid_request",
      phase: "pre_dispatch",
      certainty: "definite",
    });
  }
  const body: Record<string, unknown> = {
    model: req.model ?? XAI_DEFAULT_MODEL,
    prompt: req.prompt,
    n: req.n ?? 1,
  };
  const aspectRatio = mapSizeToAspectRatio(req.size);
  const resolution = mapQualityToResolution(req.quality);
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  const response = await requestXaiMediaJson({
    operation: "image_generation",
    binding: credential,
    body,
    signal,
    timeoutMs,
  }, deps);
  return normalizedImages(response);
}

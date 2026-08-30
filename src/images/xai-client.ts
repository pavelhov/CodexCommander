/** xAI image request shaping over the shared fixed-origin media transport. */
import type { MediaCredentialBinding } from "./types";
import {
  bindLegacyStaticApiKey,
  createStaticMediaCredentialLease,
} from "./media-credentials";
import { ambiguousMediaSuccess } from "./media-errors";
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

/** @deprecated U3 removes this once every image handler passes MediaCredentialBinding. */
export interface LegacyXaiMediaAuth {
  baseUrl: string;
  token: string;
}

const XAI_IMAGES_TIMEOUT_MS = 60_000;
const XAI_DEFAULT_MODEL = "grok-imagine-image-quality";
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

function isBinding(value: MediaCredentialBinding | LegacyXaiMediaAuth): value is MediaCredentialBinding {
  return "authSource" in value && "slotRef" in value && "identityDigest" in value;
}

function transportContext(
  credential: MediaCredentialBinding | LegacyXaiMediaAuth,
  deps: XaiMediaTransportDeps,
): { binding: MediaCredentialBinding; deps: XaiMediaTransportDeps } {
  if (isBinding(credential)) return { binding: credential, deps };
  // Compatibility never uses the legacy base URL and never receives an OAuth-capable lease.
  const binding = bindLegacyStaticApiKey(credential.token);
  return {
    binding,
    deps: { ...deps, lease: createStaticMediaCredentialLease(binding, credential.token) },
  };
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
 * Bound callers provide only MediaCredentialBinding. The legacy auth overload exists temporarily
 * for U3 migration and still delegates through the same pinned transport without source fallback.
 */
export async function callXaiImages(
  req: XaiImageRequest,
  credential: MediaCredentialBinding | LegacyXaiMediaAuth,
  signal?: AbortSignal,
  timeoutMs: number = XAI_IMAGES_TIMEOUT_MS,
  deps: XaiMediaTransportDeps = {},
): Promise<XaiImageResult> {
  const isEdit = typeof req.imageUrl === "string" && req.imageUrl.length > 0;
  const body: Record<string, unknown> = {
    model: req.model ?? XAI_DEFAULT_MODEL,
    prompt: req.prompt,
    n: req.n ?? 1,
  };
  const aspectRatio = mapSizeToAspectRatio(req.size);
  const resolution = mapQualityToResolution(req.quality);
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (isEdit) body.image = { url: req.imageUrl, type: "image_url" };

  const context = transportContext(credential, deps);
  const response = await requestXaiMediaJson({
    operation: isEdit ? "image_edit" : "image_generation",
    binding: context.binding,
    body,
    signal,
    timeoutMs,
  }, context.deps);
  return normalizedImages(response);
}

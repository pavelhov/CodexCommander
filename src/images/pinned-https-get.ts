import { pinnedHttpGet, type PinnedAddress } from "../lib/pinned-http";
import { assessUrlDestination } from "../lib/destination-policy";
import { isIP } from "node:net";

export type { PinnedAddress } from "../lib/pinned-http";

export const DEFAULT_PINNED_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_PINNED_MEDIA_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_PINNED_MEDIA_DEADLINE_MS = 5 * 60_000;

export interface PinnedHttpsGetOptions {
  maxBytes?: number;
  idleTimeoutMs?: number;
  deadlineMs?: number;
}

/** Test seam: implementations must connect to `pinned` without re-resolving the URL. */
export type PinnedDownloadFn = (
  url: string,
  pinned: PinnedAddress,
  signal?: AbortSignal,
) => Promise<Response>;

/**
 * Sole credentialless media-artifact GET wrapper.
 * It exposes no caller headers and therefore cannot forward bearer, cookie,
 * proxy authorization, referrer, or custom provider metadata to a result URL.
 */
export async function pinnedHttpsGet(
  url: string,
  pinned: PinnedAddress,
  signal?: AbortSignal,
  options: PinnedHttpsGetOptions = {},
): Promise<Response> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("media artifact URL is invalid"); }
  if (parsed.protocol !== "https:") throw new Error("media artifact URL must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("media artifact URL must not contain credentials");
  if (parsed.hash) throw new Error("media artifact URL must not contain a fragment");
  if (url.length > 8_192 || !parsed.hostname) throw new Error("media artifact URL is invalid");
  const addressFamily = isIP(pinned.address);
  const pinnedHost = addressFamily === 6 ? `[${pinned.address}]` : pinned.address;
  const pinnedAssessment = addressFamily === 0 ? null : assessUrlDestination(`https://${pinnedHost}/`);
  if (
    !pinnedAssessment
    || pinnedAssessment.kind !== "public"
    || (pinned.family !== 4 && pinned.family !== 6)
    || pinned.family !== addressFamily
  ) throw new Error("media artifact pinned address is unsafe");
  const maxBytes = options.maxBytes ?? DEFAULT_PINNED_MEDIA_MAX_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_PINNED_MEDIA_IDLE_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_PINNED_MEDIA_DEADLINE_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 * 1024 * 1024) {
    throw new Error("media artifact byte limit is invalid");
  }
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 10 * 60_000) {
    throw new Error("media artifact timeout is invalid");
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 30 * 60_000) {
    throw new Error("media artifact deadline is invalid");
  }
  const response = await pinnedHttpGet(url, pinned, signal, {
    maxBytes,
    idleTimeoutMs,
    deadlineMs,
    rejectUnauthorized: true,
    context: "media artifact download",
  });
  if (!response.ok) throw new Error(`media artifact download failed: ${response.status}`);
  return response;
}

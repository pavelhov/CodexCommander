import { createHmac, randomBytes, type Hmac } from "node:crypto";

import type { XaiVideoSubmitRequest } from "./xai-video-client";

const CLIENT_REQUEST_ID_MAX = 256;
const SAFE_CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PROCESS_VIDEO_DIGEST_SECRET = randomBytes(32);

export interface VideoRequestSemanticsBinding {
  readonly providerId: string;
  readonly executor: string;
}

export interface CanonicalVideoRequestSemantics {
  readonly version: 1;
  readonly providerId: string;
  readonly executor: string;
  readonly model: string;
  readonly promptDigest: string;
  readonly mode: "text" | "starting_image" | "reference_images";
  readonly orderedSnapshotDigests: readonly string[];
  readonly duration: number;
  readonly resolution: string;
  readonly aspectRatio: string;
  readonly audio: boolean | null;
}

export type VideoOperationAdmissionScope =
  | { kind: "configured"; keyId: string }
  | { kind: "environment" }
  | { kind: "loopback" };

/** Request-local HMAC authority created only after data-plane admission succeeds. */
export interface VideoOperationDigestContext {
  readonly digestSecret: string | Uint8Array;
  readonly admission: VideoOperationAdmissionScope;
}

/** The only retry metadata allowed to cross into the durable media runtime. */
export interface VideoOperationIdentity {
  readonly operationKey: string;
  readonly requestSemanticsDigest: string;
}

export function isValidVideoClientRequestId(value: string | null | undefined): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= CLIENT_REQUEST_ID_MAX
    && SAFE_CLIENT_REQUEST_ID.test(value);
}

function privateDigest(
  domain: string,
  secret: string | Uint8Array,
  update: (hmac: Hmac) => void,
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(domain);
  hmac.update("\0");
  update(hmac);
  return `hmac-sha256:${hmac.digest("hex")}`;
}

function updateString(hmac: Hmac, marker: string, value: string): void {
  hmac.update(marker);
  hmac.update(String(Buffer.byteLength(value)));
  hmac.update(":");
  hmac.update(value);
}

function updateAdmissionScope(hmac: Hmac, admission: VideoOperationAdmissionScope): void {
  updateString(hmac, "A", admission.kind);
  if (admission.kind === "configured") updateString(hmac, "I", admission.keyId);
}

type JsonDigestFrame =
  | { kind: "value"; value: unknown }
  | { kind: "array"; value: unknown[]; index: number }
  | { kind: "object"; value: Record<string, unknown>; keys: string[]; index: number };

/**
 * Canonically feed one already-bounded JSON value into an HMAC without materializing
 * another whole-body string. The explicit frame stack avoids request-controlled recursion.
 */
function updateCanonicalJson(hmac: Hmac, root: unknown): void {
  const stack: JsonDigestFrame[] = [{ kind: "value", value: root }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        hmac.update("]");
        continue;
      }
      stack.push({ ...frame, index: frame.index + 1 });
      stack.push({ kind: "value", value: frame.value[frame.index] });
      continue;
    }
    if (frame.kind === "object") {
      if (frame.index >= frame.keys.length) {
        hmac.update("}");
        continue;
      }
      const key = frame.keys[frame.index]!;
      updateString(hmac, "K", key);
      stack.push({ ...frame, index: frame.index + 1 });
      stack.push({ kind: "value", value: frame.value[key] });
      continue;
    }

    const value = frame.value;
    if (value === null) {
      hmac.update("N");
    } else if (typeof value === "string") {
      updateString(hmac, "S", value);
    } else if (typeof value === "boolean") {
      hmac.update(value ? "T" : "F");
    } else if (typeof value === "number" && Number.isFinite(value)) {
      updateString(hmac, "D", JSON.stringify(value));
    } else if (Array.isArray(value)) {
      hmac.update("A");
      hmac.update(String(value.length));
      hmac.update("[");
      stack.push({ kind: "array", value, index: 0 });
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      hmac.update("O");
      hmac.update(String(keys.length));
      hmac.update("{");
      stack.push({ kind: "object", value: record, keys, index: 0 });
    } else {
      // Production callers pass JSON.parse output. Reject non-JSON test/internal values
      // rather than giving them a lossy identity that could collide with valid JSON.
      throw new TypeError("video operation identity requires a JSON value");
    }
  }
}

/**
 * Convert an untrusted retry-stable HTTP request identity into a principal-scoped private
 * journal key. Invalid or absent identities disable durable replay rather than falling back
 * to body hashing. The principal scope is HMAC input only and is never persisted directly.
 */
export function deriveVideoOperationKey(
  clientRequestId: string | null | undefined,
  context: VideoOperationDigestContext,
): string | undefined {
  if (!isValidVideoClientRequestId(clientRequestId)) return undefined;
  return privateDigest("codexcommander/video-operation/v2", context.digestSecret, hmac => {
    updateAdmissionScope(hmac, context.admission);
    updateString(hmac, "R", clientRequestId);
  });
}

/**
 * Keyed digest over every material field in the already-bounded parsed Responses body.
 * Canonical object-key ordering keeps semantically identical exact retries stable.
 */
export function deriveVideoRequestBodyDigest(
  body: unknown,
  context: VideoOperationDigestContext,
): string {
  return privateDigest("codexcommander/video-request-body/v2", context.digestSecret, hmac => {
    updateAdmissionScope(hmac, context.admission);
    updateCanonicalJson(hmac, body);
  });
}

function normalizedVideoMode(request: XaiVideoSubmitRequest): CanonicalVideoRequestSemantics["mode"] {
  return request.mode ?? "text";
}

/**
 * Build the prompt-free canonical semantics which must be bound before the durable submit fence.
 * Snapshot ordering is material. Base64 input bytes are deliberately excluded in favor of the
 * validated snapshot digests, so neither this record nor its durable digest retains raw inputs.
 */
export function canonicalVideoRequestSemantics(
  request: XaiVideoSubmitRequest,
  binding: VideoRequestSemanticsBinding = { providerId: "xai", executor: "xai-media-v1" },
  digestSecret: string | Uint8Array = PROCESS_VIDEO_DIGEST_SECRET,
): CanonicalVideoRequestSemantics {
  const mode = normalizedVideoMode(request);
  const orderedSnapshotDigests = mode === "starting_image"
    ? request.startingImage ? [request.startingImage.digest] : []
    : mode === "reference_images"
      ? request.referenceImages?.map(snapshot => snapshot.digest) ?? []
      : [];
  const promptDigest = privateDigest("codexcommander/video-prompt/v1", digestSecret, hmac => {
    updateString(hmac, "P", request.prompt);
  });
  return Object.freeze({
    version: 1,
    providerId: binding.providerId,
    executor: binding.executor,
    model: request.model ?? "grok-imagine-video-1.5",
    promptDigest,
    mode,
    orderedSnapshotDigests: Object.freeze([...orderedSnapshotDigests]),
    duration: request.duration ?? 6,
    resolution: request.resolution ?? "720p",
    aspectRatio: request.aspectRatio ?? "16:9",
    audio: request.audio ?? null,
  });
}

/**
 * Safe fallback for direct runtime callers that do not carry a server-derived body digest.
 * The process-local key prevents a persisted prompt digest from being correlated offline.
 */
export function deriveVideoRequestSemanticsDigest(
  request: XaiVideoSubmitRequest,
  binding: VideoRequestSemanticsBinding = { providerId: "xai", executor: "xai-media-v1" },
  digestSecret: string | Uint8Array = PROCESS_VIDEO_DIGEST_SECRET,
): string {
  const semantics = canonicalVideoRequestSemantics(request, binding, digestSecret);
  return privateDigest("codexcommander/video-submit-request/v2", digestSecret, hmac => {
    updateCanonicalJson(hmac, semantics);
  });
}

import { clearableDeadline } from "../lib/abort";
import { readBoundedResponseBody, type BoundedBodyResult } from "../lib/bounded-body";
import type { MediaCredentialBinding } from "./types";
import {
  defaultMediaCredentialLease,
  type MediaCredentialLease,
  type ResolvedMediaCredential,
} from "./media-credentials";
import {
  MediaTransportError,
  isMediaTransportError,
  mediaError,
  type MediaErrorPhase,
  type MediaErrorReason,
} from "./media-errors";

export const XAI_MEDIA_API_ROOT = "https://api.x.ai/v1";

export type XaiMediaOperation =
  | "image_generation"
  | "image_edit"
  | "video_submit"
  | "video_poll";

export interface XaiMediaTransportRequest {
  operation: XaiMediaOperation;
  binding: MediaCredentialBinding;
  body?: Record<string, unknown>;
  requestId?: string;
  signal?: AbortSignal;
  /** Per-attempt ceiling. The caller's persisted absolute deadline may shorten it. */
  timeoutMs?: number;
  /** Persisted absolute job deadline. Never extended by a retry or restart. */
  deadlineAt?: number;
}

export interface XaiMediaTransportDeps {
  fetchFn?: typeof globalThis.fetch;
  lease?: MediaCredentialLease;
  now?: () => number;
}

interface OperationSpec {
  phase: MediaErrorPhase;
  method: "GET" | "POST";
  url: (request: XaiMediaTransportRequest) => string;
  maxResponseBytes: number;
  defaultTimeoutMs: number;
}

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const IMAGE_RESPONSE_BYTES = 64 * 1024 * 1024;
const VIDEO_RESPONSE_BYTES = 1024 * 1024;
const POLL_RETRY_FALLBACK_MS = 5_000;
const POLL_RETRY_MIN_MS = 250;
const POLL_RETRY_MAX_MS = 60_000;

function invalidRequest(): MediaTransportError {
  return mediaError({ code: "invalid_request", phase: "pre_dispatch", certainty: "definite" });
}

function operationSpec(request: XaiMediaTransportRequest): OperationSpec {
  switch (request.operation) {
    case "image_generation":
      return {
        phase: "submit",
        method: "POST",
        url: () => `${XAI_MEDIA_API_ROOT}/images/generations`,
        maxResponseBytes: IMAGE_RESPONSE_BYTES,
        defaultTimeoutMs: 60_000,
      };
    case "image_edit":
      return {
        phase: "submit",
        method: "POST",
        url: () => `${XAI_MEDIA_API_ROOT}/images/edits`,
        maxResponseBytes: IMAGE_RESPONSE_BYTES,
        defaultTimeoutMs: 60_000,
      };
    case "video_submit":
      return {
        phase: "submit",
        method: "POST",
        url: () => `${XAI_MEDIA_API_ROOT}/videos/generations`,
        maxResponseBytes: VIDEO_RESPONSE_BYTES,
        defaultTimeoutMs: 60_000,
      };
    case "video_poll": {
      const id = request.requestId;
      if (
        typeof id !== "string"
        || id.length === 0
        || id.length > 512
        || id.trim() !== id
        || /[\x00-\x1f\x7f]/.test(id)
      ) throw invalidRequest();
      return {
        phase: "poll",
        method: "GET",
        url: () => `${XAI_MEDIA_API_ROOT}/videos/${encodeURIComponent(id)}`,
        maxResponseBytes: VIDEO_RESPONSE_BYTES,
        defaultTimeoutMs: 30_000,
      };
    }
  }
}

function effectiveTimeoutMs(
  request: XaiMediaTransportRequest,
  spec: OperationSpec,
  now: number,
): number {
  const requested = typeof request.timeoutMs === "number"
    && Number.isFinite(request.timeoutMs)
    && request.timeoutMs > 0
    ? Math.floor(request.timeoutMs)
    : spec.defaultTimeoutMs;
  if (request.deadlineAt === undefined) return requested;
  if (!Number.isFinite(request.deadlineAt)) throw invalidRequest();
  const remaining = Math.floor(request.deadlineAt - now);
  if (remaining <= 0) {
    throw mediaError({
      code: "timeout",
      phase: "pre_dispatch",
      certainty: "definite",
      reason: "timeout",
    });
  }
  return Math.min(requested, remaining);
}

function requestBody(request: XaiMediaTransportRequest, spec: OperationSpec): string | undefined {
  if (spec.method === "GET") {
    if (request.body !== undefined) throw invalidRequest();
    return undefined;
  }
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw invalidRequest();
  let body: string;
  try {
    body = JSON.stringify(request.body);
  } catch {
    throw invalidRequest();
  }
  if (!body || new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) throw invalidRequest();
  return body;
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    void operation.catch(() => undefined);
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function resolveCredential(
  binding: MediaCredentialBinding,
  lease: MediaCredentialLease,
  signal: AbortSignal,
): Promise<ResolvedMediaCredential> {
  try {
    return await withAbort(lease.resolve(binding), signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isMediaTransportError(error)) throw error;
    throw mediaError({
      code: "needs_auth",
      phase: "pre_dispatch",
      certainty: "definite",
      reason: "credential_unavailable",
    });
  }
}

function complete(body: BoundedBodyResult): boolean {
  return !body.truncated && !body.timedOut && !body.oversized;
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  timeoutMs: number,
): Promise<BoundedBodyResult> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
    return {
      text: "",
      truncated: true,
      timedOut: false,
      totalTimedOut: false,
      inactivityTimedOut: false,
      oversized: true,
      displaySafe: false,
    };
  }
  return readBoundedResponseBody(response, {
    signal,
    // Provider text is never surfaced. Replacement decoding lets complete non-2xx bodies
    // retain their authoritative status classification while malformed success JSON still fails.
    fatalUtf8: false,
    maxBytes,
    totalTimeoutMs: timeoutMs,
    firstByteTimeoutMs: Math.min(5_000, timeoutMs),
    inactivityTimeoutMs: Math.min(5_000, timeoutMs),
  });
}

function postAmbiguous(reason: MediaErrorReason, status?: number): MediaTransportError {
  return mediaError({
    code: "ambiguous_submission",
    phase: "submit",
    certainty: "ambiguous",
    reason,
    ...(status !== undefined ? { status } : {}),
  });
}

function pollRetryable(
  reason: MediaErrorReason,
  status?: number,
  retryAfterMs?: number,
): MediaTransportError {
  return mediaError({
    code: "poll_retryable",
    phase: "poll",
    certainty: "definite",
    retryable: true,
    reason,
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

function safePollRetryDelay(value: string | null, now: number): number {
  const text = value?.trim();
  let parsed: number | undefined;
  if (text && /^\d+$/.test(text)) {
    const seconds = Number(text);
    if (Number.isSafeInteger(seconds)) parsed = seconds * 1_000;
  } else if (text) {
    const timestamp = Date.parse(text);
    if (Number.isFinite(timestamp)) parsed = timestamp - now;
  }
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) return POLL_RETRY_FALLBACK_MS;
  return Math.min(Math.max(Math.ceil(parsed), POLL_RETRY_MIN_MS), POLL_RETRY_MAX_MS);
}

function incompleteError(spec: OperationSpec, body: BoundedBodyResult, status?: number): MediaTransportError {
  const reason: MediaErrorReason = body.oversized
    ? "oversized_response"
    : body.timedOut
      ? "timeout"
      : "incomplete_response";
  return spec.method === "POST" ? postAmbiguous(reason, status) : pollRetryable(reason, status);
}

function completeHttpError(
  spec: OperationSpec,
  status: number,
  retryAfter: string | null,
  now: number,
): MediaTransportError {
  if (status >= 300 && status < 400) {
    return spec.method === "POST"
      ? postAmbiguous("redirect", status)
      : mediaError({ code: "upstream_failed", phase: "poll", certainty: "definite", status, reason: "redirect" });
  }
  if (status === 401) {
    return mediaError({
      code: "needs_auth",
      phase: spec.phase,
      certainty: "definite",
      status,
      reason: "credential_unavailable",
    });
  }
  if (status === 400) {
    return mediaError({ code: "policy_rejected", phase: spec.phase, certainty: "definite", status, reason: "http_status" });
  }
  if (status === 403) {
    return mediaError({ code: "entitlement_denied", phase: spec.phase, certainty: "definite", status, reason: "http_status" });
  }
  if (status === 429) {
    return spec.method === "POST"
      ? mediaError({ code: "rate_limited", phase: "submit", certainty: "definite", status, reason: "http_status" })
      : pollRetryable("http_status", status, safePollRetryDelay(retryAfter, now));
  }
  if (spec.method === "POST") return postAmbiguous("http_status", status);
  if (status >= 500) return pollRetryable("http_status", status, safePollRetryDelay(retryAfter, now));
  // Poll GET is safe to issue again, but only its explicit table is retryable.
  return mediaError({ code: "upstream_failed", phase: "poll", certainty: "definite", status, reason: "http_status" });
}

function afterDispatchFailure(spec: OperationSpec, signal: AbortSignal, deadlineExpired: boolean): MediaTransportError {
  if (spec.method === "POST") {
    return postAmbiguous(
      deadlineExpired ? "timeout" : signal.aborted ? "cancelled" : "network",
    );
  }
  if (signal.aborted && !deadlineExpired) {
    return mediaError({ code: "cancelled", phase: "poll", certainty: "definite", reason: "cancelled" });
  }
  return pollRetryable(deadlineExpired ? "timeout" : "network");
}

function malformedSuccess(spec: OperationSpec): MediaTransportError {
  return spec.method === "POST"
    ? postAmbiguous("malformed_response")
    : mediaError({
        code: "upstream_failed",
        phase: "poll",
        certainty: "definite",
        reason: "malformed_response",
      });
}

/**
 * One sealed raw transport for every authenticated xAI media request.
 * It accepts no URL or caller headers, rejects redirects, and owns the sole OAuth-401 replay.
 */
export async function requestXaiMediaJson(
  request: XaiMediaTransportRequest,
  deps: XaiMediaTransportDeps = {},
): Promise<unknown> {
  const spec = operationSpec(request);
  const body = requestBody(request, spec);
  if (request.signal?.aborted) {
    throw mediaError({ code: "cancelled", phase: "pre_dispatch", certainty: "definite", reason: "cancelled" });
  }
  const timeoutMs = effectiveTimeoutMs(request, spec, (deps.now ?? Date.now)());
  const deadline = clearableDeadline(timeoutMs, request.signal);
  const lease = deps.lease ?? defaultMediaCredentialLease;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  let credential: ResolvedMediaCredential;
  try {
    credential = await resolveCredential(request.binding, lease, deadline.signal);
  } catch (error) {
    deadline.clear();
    if (deadline.didExpire()) {
      throw mediaError({ code: "timeout", phase: "pre_dispatch", certainty: "definite", reason: "timeout" });
    }
    if (request.signal?.aborted) {
      throw mediaError({ code: "cancelled", phase: "pre_dispatch", certainty: "definite", reason: "cancelled" });
    }
    if (!isMediaTransportError(error)) {
      throw mediaError({
        code: "needs_auth",
        phase: "pre_dispatch",
        certainty: "definite",
        reason: "credential_unavailable",
      });
    }
    throw error;
  }

  let oauthReplayUsed = false;
  try {
    for (;;) {
      let response: Response;
      try {
        response = await fetchFn(spec.url(request), {
          method: spec.method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.bearer}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body } : {}),
          redirect: "manual",
          signal: deadline.signal,
        });
      } catch {
        throw afterDispatchFailure(spec, request.signal ?? deadline.signal, deadline.didExpire());
      }

      let observed: BoundedBodyResult;
      try {
        observed = await readResponse(
          response,
          deadline.signal,
          response.ok ? spec.maxResponseBytes : MAX_ERROR_BYTES,
          timeoutMs,
        );
      } catch {
        throw afterDispatchFailure(spec, request.signal ?? deadline.signal, deadline.didExpire());
      }
      if (!complete(observed)) throw incompleteError(spec, observed, response.status);

      if (!response.ok) {
        if (
          response.status === 401
          && request.binding.authSource === "subscription_oauth"
          && credential.oauthSnapshot
          && !oauthReplayUsed
        ) {
          oauthReplayUsed = true;
          try {
            credential = await withAbort(
              lease.refreshAfterRejectedOAuth(request.binding, credential.oauthSnapshot),
              deadline.signal,
            );
          } catch {
            if (deadline.didExpire()) {
              throw mediaError({
                code: "timeout",
                phase: spec.phase,
                certainty: "definite",
                status: 401,
                reason: "timeout",
              });
            }
            if (request.signal?.aborted) {
              throw mediaError({
                code: "cancelled",
                phase: spec.phase,
                certainty: "definite",
                status: 401,
                reason: "cancelled",
              });
            }
            throw mediaError({
              code: "needs_auth",
              phase: spec.phase,
              certainty: "definite",
              status: 401,
              reason: "credential_unavailable",
            });
          }
          continue;
        }
        throw completeHttpError(
          spec,
          response.status,
          response.headers.get("retry-after"),
          (deps.now ?? Date.now)(),
        );
      }

      try {
        return JSON.parse(observed.text) as unknown;
      } catch {
        throw malformedSuccess(spec);
      }
    }
  } finally {
    deadline.clear();
  }
}

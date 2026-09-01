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
  type MediaFailureCategory,
  type MediaSafeFailureDetails,
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
  maxRequestBytes: number;
  maxResponseBytes: number;
  defaultTimeoutMs: number;
}

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_VIDEO_SUBMIT_REQUEST_BYTES = 72 * 1024 * 1024;
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
        maxRequestBytes: MAX_REQUEST_BYTES,
        maxResponseBytes: IMAGE_RESPONSE_BYTES,
        defaultTimeoutMs: 60_000,
      };
    case "image_edit":
      return {
        phase: "submit",
        method: "POST",
        url: () => `${XAI_MEDIA_API_ROOT}/images/edits`,
        maxRequestBytes: MAX_REQUEST_BYTES,
        maxResponseBytes: IMAGE_RESPONSE_BYTES,
        defaultTimeoutMs: 60_000,
      };
    case "video_submit":
      return {
        phase: "submit",
        method: "POST",
        url: () => `${XAI_MEDIA_API_ROOT}/videos/generations`,
        maxRequestBytes: MAX_VIDEO_SUBMIT_REQUEST_BYTES,
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
        maxRequestBytes: 0,
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
  if (!body || new TextEncoder().encode(body).byteLength > spec.maxRequestBytes) throw invalidRequest();
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

function failureDetails(input: Omit<MediaSafeFailureDetails, "version">): MediaSafeFailureDetails {
  return Object.freeze({ version: 1, ...input });
}

function postAmbiguous(
  reason: MediaErrorReason,
  status?: number,
  category: MediaFailureCategory = reason === "timeout" ? "timeout" : "unknown_upstream",
): MediaTransportError {
  return mediaError({
    code: "ambiguous_submission",
    phase: "submit",
    certainty: "ambiguous",
    reason,
    failure: failureDetails({
      origin: "transport",
      stage: "submission",
      category,
      retry: "fresh_authorization_required",
      recovery: "acknowledge_outcome_unknown",
      submissionCertainty: "outcome_unknown",
    }),
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
    failure: failureDetails({
      origin: "transport",
      stage: "polling",
      category: reason === "timeout" ? "timeout" : status !== undefined && status >= 500 ? "outage" : "unknown_upstream",
      retry: "retry_same_operation",
      recovery: "resume_existing_operation",
      submissionCertainty: "accepted",
    }),
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

type StructuredProviderCodeField = "error.code" | "code";

interface StructuredProviderCode {
  field: StructuredProviderCodeField;
  code: string;
}

function structuredProviderCode(text: string): StructuredProviderCode | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const top = typeof record.code === "string" ? record.code : undefined;
  const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : undefined;
  const nested = typeof error?.code === "string" ? error.code : undefined;
  if (top !== undefined && nested !== undefined && top !== nested) return undefined;
  const code = nested ?? top;
  if (!code || code.length > 64 || !/^[a-z][a-z0-9_]*$/.test(code)) return undefined;
  return { field: nested !== undefined ? "error.code" : "code", code };
}

function completeHttpError(
  operation: XaiMediaOperation,
  spec: OperationSpec,
  status: number,
  retryAfter: string | null,
  now: number,
  responseText: string,
): MediaTransportError {
  const evidence = structuredProviderCode(responseText);
  const submit = operation === "image_generation" || operation === "image_edit" || operation === "video_submit";
  // This allowlist is intentionally keyed by operation lifecycle, status, exact field, and
  // normalized code. Free-form messages and deferred-job codes cannot specialize submission.
  if (submit && status === 429 && evidence?.field === "error.code"
    && ["insufficient_quota", "usage_limit_exceeded", "credits_exhausted"].includes(evidence.code)) {
    return mediaError({
      code: "usage_exhausted", phase: "submit", certainty: "definite", status, reason: "http_status",
      failure: failureDetails({
        origin: "provider", stage: "submission", category: "usage_exhausted",
        retry: "retry_after_change", recovery: "request_new_operation", submissionCertainty: "definite_rejection",
      }),
    });
  }
  if (submit && status === 400 && evidence?.field === "error.code" && evidence.code === "invalid_api_key") {
    return mediaError({
      code: "needs_auth", phase: "submit", certainty: "definite", status, reason: "credential_unavailable",
      failure: failureDetails({
        origin: "provider", stage: "submission", category: "authentication",
        retry: "retry_after_change", recovery: "reauthenticate", submissionCertainty: "definite_rejection",
      }),
    });
  }
  if (submit && status === 400 && evidence?.field === "error.code"
    && (evidence.code === "content_moderation" || evidence.code === "safety_violation")) {
    return mediaError({
      code: "policy_rejected", phase: "submit", certainty: "definite", status, reason: "http_status",
      failure: failureDetails({
        origin: "provider", stage: "submission", category: "safety",
        retry: "not_retryable", recovery: "fix_request", submissionCertainty: "definite_rejection",
      }),
    });
  }
  if (submit && status === 400 && evidence?.field === "error.code" && evidence.code === "invalid_argument") {
    return mediaError({
      code: "policy_rejected", phase: "submit", certainty: "definite", status, reason: "http_status",
      failure: failureDetails({
        origin: "provider", stage: "submission", category: "validation",
        retry: "not_retryable", recovery: "fix_request", submissionCertainty: "definite_rejection",
      }),
    });
  }
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
      failure: failureDetails({
        origin: "provider", stage: spec.phase === "submit" ? "submission" : "polling", category: "authentication",
        retry: "retry_after_change", recovery: "reauthenticate",
        submissionCertainty: spec.phase === "submit" ? "definite_rejection" : "accepted",
      }),
    });
  }
  if (status === 400) {
    return mediaError({ code: "policy_rejected", phase: spec.phase, certainty: "definite", status, reason: "http_status" });
  }
  if (status === 403) {
    return mediaError({
      code: "entitlement_denied", phase: spec.phase, certainty: "definite", status, reason: "http_status",
      failure: failureDetails({
        origin: "provider", stage: spec.phase === "submit" ? "submission" : "polling", category: "permission",
        retry: "retry_after_change", recovery: "check_permission",
        submissionCertainty: spec.phase === "submit" ? "definite_rejection" : "accepted",
      }),
    });
  }
  if (status === 429) {
    return spec.method === "POST"
      ? mediaError({ code: "rate_limited", phase: "submit", certainty: "definite", status, reason: "http_status" })
      : pollRetryable("http_status", status, safePollRetryDelay(retryAfter, now));
  }
  if (spec.method === "POST") {
    const outage = status >= 500 && (evidence === undefined
      || evidence.code === "service_unavailable" || evidence.code === "internal_error");
    return postAmbiguous("http_status", status, outage ? "outage" : "unknown_upstream");
  }
  if (status >= 500) return pollRetryable("http_status", status, safePollRetryDelay(retryAfter, now));
  // Poll GET is safe to issue again, but only its explicit table is retryable.
  return mediaError({ code: "upstream_failed", phase: "poll", certainty: "definite", status, reason: "http_status" });
}

function afterDispatchFailure(spec: OperationSpec, signal: AbortSignal, deadlineExpired: boolean): MediaTransportError {
  if (spec.method === "POST") {
    const reason = deadlineExpired ? "timeout" : signal.aborted ? "cancelled" : "network";
    return postAmbiguous(reason, undefined, deadlineExpired ? "timeout" : signal.aborted ? "cancelled" : "outage");
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
 * It accepts no URL or caller headers, rejects redirects, and owns the sole safe OAuth-401 replay.
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
          && request.operation === "video_poll"
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
          request.operation,
          spec,
          response.status,
          response.headers.get("retry-after"),
          (deps.now ?? Date.now)(),
          observed.text,
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

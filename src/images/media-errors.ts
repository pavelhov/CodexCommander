/** Privacy-safe media failures. Raw provider bodies, URLs, credentials, and identities never enter this shape. */
export type MediaErrorCode =
  | "invalid_request"
  | "needs_auth"
  | "usage_exhausted"
  | "entitlement_denied"
  | "rate_limited"
  | "policy_rejected"
  | "ambiguous_submission"
  | "poll_retryable"
  | "upstream_failed"
  | "cancelled"
  | "timeout";

export type MediaDispatchCertainty = "definite" | "ambiguous";
export type MediaErrorPhase = "pre_dispatch" | "submit" | "poll";
export type MediaErrorReason =
  | "credential_unavailable"
  | "network"
  | "timeout"
  | "cancelled"
  | "redirect"
  | "incomplete_response"
  | "oversized_response"
  | "malformed_response"
  | "missing_result"
  | "http_status";

export type MediaSafeFailureCode =
  | "needs_auth"
  | "entitlement_denied"
  | "rate_limited"
  | "policy_rejected"
  | "ambiguous_submission"
  | "upstream_failed"
  | "cancelled"
  | "timeout";

export type MediaFailureOrigin = "local" | "credential" | "provider" | "transport" | "artifact";
export type MediaFailureStage =
  | "validation"
  | "credential_binding"
  | "submission"
  | "provider_processing"
  | "polling"
  | "artifact_download"
  | "artifact_validation"
  | "publication"
  | "wait";
export type MediaFailureCategory =
  | "validation"
  | "capability_mismatch"
  | "authentication"
  | "permission"
  | "usage_exhausted"
  | "rate_limited"
  | "safety"
  | "outage"
  | "timeout"
  | "expired"
  | "cancelled"
  | "artifact_invalid"
  | "artifact_expired"
  | "unknown_upstream";
export type MediaFailureRetry =
  | "not_retryable"
  | "retry_after_change"
  | "retry_same_operation"
  | "fresh_authorization_required";
export type MediaFailureRecovery =
  | "none"
  | "fix_request"
  | "reauthenticate"
  | "check_permission"
  | "wait_and_retry"
  | "resume_existing_operation"
  | "acknowledge_outcome_unknown"
  | "request_new_operation";
export type MediaSubmissionCertainty =
  | "not_sent"
  | "definite_rejection"
  | "accepted"
  | "outcome_unknown";

/** Stable, versioned, privacy-safe failure semantics shared by every projection. */
export interface MediaSafeFailureDetails {
  readonly version: 1;
  readonly origin: MediaFailureOrigin;
  readonly stage: MediaFailureStage;
  readonly category: MediaFailureCategory;
  readonly retry: MediaFailureRetry;
  readonly recovery: MediaFailureRecovery;
  readonly submissionCertainty: MediaSubmissionCertainty;
}

const SAFE_MESSAGES: Record<MediaErrorCode, string> = {
  invalid_request: "The media request is invalid.",
  needs_auth: "The selected media credential needs authentication.",
  usage_exhausted: "The selected media credential has no remaining usage allowance.",
  entitlement_denied: "The selected media credential is not entitled to this operation.",
  rate_limited: "The selected media credential is rate limited.",
  policy_rejected: "The media request was rejected by policy or validation.",
  ambiguous_submission: "The media submission outcome is unknown and must not be replayed.",
  poll_retryable: "The media job could not be polled safely at this time.",
  upstream_failed: "The media provider rejected the operation.",
  cancelled: "The media operation was cancelled.",
  timeout: "The media operation reached its deadline.",
};

export interface MediaTransportErrorInit {
  code: MediaErrorCode;
  phase: MediaErrorPhase;
  certainty: MediaDispatchCertainty;
  retryable?: boolean;
  status?: number;
  reason?: MediaErrorReason;
  /** Sanitized bounded delay hint for safe poll retries. Raw provider headers are never retained. */
  retryAfterMs?: number;
  failure?: MediaSafeFailureDetails;
}

function defaultFailure(init: MediaTransportErrorInit): MediaSafeFailureDetails {
  const notSent = init.phase === "pre_dispatch";
  const outcomeUnknown = init.certainty === "ambiguous";
  const stage: MediaFailureStage = init.phase === "pre_dispatch"
    ? init.reason === "credential_unavailable" ? "credential_binding" : "validation"
    : init.phase === "submit" ? "submission" : "polling";
  let category: MediaFailureCategory;
  switch (init.code) {
    case "invalid_request": category = "validation"; break;
    case "needs_auth": category = "authentication"; break;
    case "usage_exhausted": category = "usage_exhausted"; break;
    case "entitlement_denied": category = "permission"; break;
    case "rate_limited": category = "rate_limited"; break;
    case "policy_rejected": category = "validation"; break;
    case "timeout": category = "timeout"; break;
    case "cancelled": category = "cancelled"; break;
    default: category = "unknown_upstream"; break;
  }
  const submissionCertainty: MediaSubmissionCertainty = outcomeUnknown
    ? "outcome_unknown"
    : notSent ? "not_sent" : init.phase === "submit" ? "definite_rejection" : "accepted";
  const recovery: MediaFailureRecovery = outcomeUnknown
    ? "acknowledge_outcome_unknown"
    : category === "authentication" ? "reauthenticate"
      : category === "permission" ? "check_permission"
        : category === "validation" ? "fix_request"
          : init.phase === "poll" && init.retryable ? "resume_existing_operation"
            : category === "rate_limited" || category === "timeout"
              ? "wait_and_retry"
              : "request_new_operation";
  const retry: MediaFailureRetry = outcomeUnknown
    ? "fresh_authorization_required"
    : init.phase === "poll" && init.retryable ? "retry_same_operation"
      : category === "authentication" || category === "permission" || category === "usage_exhausted"
        ? "retry_after_change"
        : category === "rate_limited" || category === "timeout"
          ? "retry_after_change"
          : "not_retryable";
  return Object.freeze({ version: 1, origin: notSent ? "local" : "provider", stage, category, retry, recovery, submissionCertainty });
}

export class MediaTransportError extends Error {
  readonly code: MediaErrorCode;
  readonly phase: MediaErrorPhase;
  readonly certainty: MediaDispatchCertainty;
  readonly retryable: boolean;
  readonly status?: number;
  readonly reason?: MediaErrorReason;
  readonly retryAfterMs?: number;
  readonly failure: MediaSafeFailureDetails;

  constructor(init: MediaTransportErrorInit) {
    super(SAFE_MESSAGES[init.code]);
    this.name = "MediaTransportError";
    this.code = init.code;
    this.phase = init.phase;
    this.certainty = init.certainty;
    this.retryable = init.retryable ?? false;
    if (init.status !== undefined) this.status = init.status;
    if (init.reason !== undefined) this.reason = init.reason;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    this.failure = Object.freeze({ ...(init.failure ?? defaultFailure(init)) });
  }

  toJSON(): MediaTransportErrorInit & { message: string } {
    return {
      code: this.code,
      phase: this.phase,
      certainty: this.certainty,
      retryable: this.retryable,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      failure: this.failure,
      message: this.message,
    };
  }
}

export function mediaError(init: MediaTransportErrorInit): MediaTransportError {
  return new MediaTransportError(init);
}

export function isMediaTransportError(error: unknown): error is MediaTransportError {
  return error instanceof MediaTransportError;
}

export function safeMediaFailure(error: Pick<MediaTransportError, "code">): MediaSafeFailureCode {
  switch (error.code) {
    case "needs_auth": return "needs_auth";
    // The legacy durable enum cannot distinguish this yet. The versioned `failure`
    // object remains authoritative for new projections; conservative journals retain
    // the old rate-limited bucket until their schema migration lands.
    case "usage_exhausted": return "rate_limited";
    case "entitlement_denied": return "entitlement_denied";
    case "rate_limited": return "rate_limited";
    case "policy_rejected": return "policy_rejected";
    case "ambiguous_submission": return "ambiguous_submission";
    case "cancelled": return "cancelled";
    case "timeout": return "timeout";
    default: return "upstream_failed";
  }
}

/** Convert malformed or incomplete 2xx POST results into the same no-replay certainty contract. */
export function ambiguousMediaSuccess(reason: MediaErrorReason = "missing_result"): MediaTransportError {
  return mediaError({
    code: "ambiguous_submission",
    phase: "submit",
    certainty: "ambiguous",
    reason,
  });
}

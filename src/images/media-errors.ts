/** Privacy-safe media failures. Raw provider bodies, URLs, credentials, and identities never enter this shape. */
export type MediaErrorCode =
  | "invalid_request"
  | "needs_auth"
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

const SAFE_MESSAGES: Record<MediaErrorCode, string> = {
  invalid_request: "The media request is invalid.",
  needs_auth: "The selected media credential needs authentication.",
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
}

export class MediaTransportError extends Error {
  readonly code: MediaErrorCode;
  readonly phase: MediaErrorPhase;
  readonly certainty: MediaDispatchCertainty;
  readonly retryable: boolean;
  readonly status?: number;
  readonly reason?: MediaErrorReason;
  readonly retryAfterMs?: number;

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

/** Convert malformed or incomplete 2xx POST results into the same no-replay certainty contract. */
export function ambiguousMediaSuccess(reason: MediaErrorReason = "missing_result"): MediaTransportError {
  return mediaError({
    code: "ambiguous_submission",
    phase: "submit",
    certainty: "ambiguous",
    reason,
  });
}

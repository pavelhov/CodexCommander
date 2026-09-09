import { cleanupDispatchBody, cleanupResponseDispatch, dispatchHttpFetch, type DispatchHttpContext } from "../usage/dispatch-http";
/**
 * Shared upstream recovery helpers. A missing response does not prove that
 * inference never started. Ambiguous reset/5xx replay is therefore disabled
 * by default; internal callers must explicitly opt into multiple attempts.
 */
import { clearableDeadline } from "./abort";

const RESET_RETRY_MAX_ATTEMPTS = 1;
const RESET_RETRY_BASE_DELAY_MS = 150;
const RESET_RETRY_MAX_DELAY_MS = 1_000;

// Transient-5xx status retry layer (pre-stream only; implementation contract).
const TRANSIENT_RETRY_MAX_ATTEMPTS = 1;
const TRANSIENT_RETRY_BASE_DELAY_MS = 400;
const TRANSIENT_RETRY_MAX_DELAY_MS = 5_000;
// A failed attempt slower than this is the "slow 502" incident shape (191s observed on
// 2026-07-15): retrying it only duplicates upstream load past client timeouts — return it.
const TRANSIENT_RETRY_SLOW_ATTEMPT_MS = 15_000;

/**
 * Upstream statuses treated as transient: gateway errors and Cloudflare 52x.
 * 500 is included per the OpenAI SDK default (auto-retries >=500; Tier-2 proven in
 * the midstream retry investigation). 507 was observed in the 48h ledger
 * but is deliberately excluded (storage-class, not gateway-transient).
 */
export function isTransientUpstreamStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504
    || status === 520 || status === 521 || status === 522;
}

export interface RetryBackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  headers?: Headers;
}

export function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Best-effort, bounded cancellation of a response body before a retry backoff.
 *
 * The 429 paths release the unread body before waiting so sockets do not accumulate under a
 * rate-limit storm, but a never-settling `cancel()` promise must not be able to block the
 * abort-aware backoff (client cancel, `maxIntervalMs`, or the cumulative header deadline).
 * Cancellation is started and its rejection observed; the await is bounded by `timeoutMs`
 * and the abort signal. This mirrors the rotation-path guarantee (release is initiated, not
 * awaited forever) while preserving the resource-release intent of the same-target paths.
 */
export async function releaseResponseBodyBestEffort(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal | undefined,
  timeoutMs = 1_000,
): Promise<void> {
  if (!body) return;
  cleanupDispatchBody(body);
  if (signal?.aborted) {
    void body.cancel().catch(() => {});
    return;
  }
  const cancel = body.cancel().catch(() => {});
  if (!signal) {
    await Promise.race([cancel, new Promise<void>(resolve => setTimeout(resolve, timeoutMs))]);
    return;
  }
  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    /**
     * Abort hook: clear the bounded-body release timer and settle the promise so a
     * never-settling cancel() can never block the abort-aware backoff.
     */
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    void cancel.then(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * Abort-aware sleep that yields an adapter `heartbeat` at least every `heartbeatIntervalMs`.
 * The Responses bridge treats a returned iterator event as upstream liveness and aborts turns
 * that stay silent past the stall budget (default 300s), while a retryOn429 wait may legally
 * reach 600s — so deliberate waits must keep the watchdog fed or a long backoff is killed
 * mid-turn. The final chunk always yields once, which doubles as the post-wait liveness beat.
 */
export async function* sleepWithHeartbeats(
  ms: number,
  signal?: AbortSignal,
  heartbeatIntervalMs = 10_000,
): AsyncGenerator<{ type: "heartbeat" }> {
  if (ms <= 0) return;
  // Guard against a non-positive interval: a zero/negative step would spin the loop forever
  // while sleepWithAbort early-returns without ever observing the abort signal. NaN must be
  // normalized too: Math.max(1, NaN) is NaN, which would abort the wait after one beat.
  const stepMs = Number.isNaN(heartbeatIntervalMs) ? 1 : Math.max(1, heartbeatIntervalMs);
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, stepMs);
    await sleepWithAbort(chunk, signal);
    remaining -= chunk;
    yield { type: "heartbeat" };
  }
}

export interface SameTarget429WaitOptions {
  body: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
  delayMs: number;
  /**
   * When set, the wait yields adapter heartbeats so bridge stall watchdogs stay fed.
   * Omit for pre-stream recovery paths that have no stall watchdog.
   */
  heartbeatIntervalMs?: number;
}

/**
 * Shared pre-replay prep for opt-in same-target 429 waits:
 * release the unread 429 body, then sleep (optionally with heartbeats).
 * Callers still own attempt budgeting, abort re-checks, and the replay itself.
 */
export async function* prepareSameTarget429Wait(
  options: SameTarget429WaitOptions,
): AsyncGenerator<{ type: "heartbeat" }> {
  await releaseResponseBodyBestEffort(options.body, options.signal);
  if (options.heartbeatIntervalMs === undefined) {
    await sleepWithAbort(options.delayMs, options.signal);
    return;
  }
  yield* sleepWithHeartbeats(options.delayMs, options.signal, options.heartbeatIntervalMs);
}

export function isConnectionResetError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Aborts and timeouts are caller decisions / honest failures — never retryable.
  if (err.name === "AbortError" || err.name === "TimeoutError") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ECONNRESET" || code === "EPIPE") return true;
  const msg = err.message.toLowerCase();
  return msg.includes("socket connection was closed unexpectedly")
    || msg.includes("connection reset by peer");
}

function retryAfterDelayMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

export function retryBackoffDelayMs(attempt: number, opts: RetryBackoffOptions): number {
  const retryAfter = opts.headers ? retryAfterDelayMs(opts.headers) : undefined;
  if (retryAfter !== undefined) return Math.min(retryAfter, opts.maxDelayMs);
  const exp = Math.min(opts.baseDelayMs * (2 ** attempt), opts.maxDelayMs);
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
}

export function cancelResponseBodyBestEffort(res: Response): void {
  cleanupResponseDispatch(res);
  try {
    const cancellation = res.body?.cancel();
    if (cancellation) void cancellation.catch(() => {});
  } catch {
    // Cancellation is cleanup only; retries must not wait for or fail because of it.
  }
}

export async function fetchWithAttemptDeadline(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  preferIdentityEncoding = false,
  dispatch?: DispatchHttpContext,
): Promise<Response> {
  const attemptTimeout = clearableDeadline(timeoutMs, abortSignal);
  const headers = new Headers(init.headers);
  if (preferIdentityEncoding && !headers.has("accept-encoding")) {
    headers.set("accept-encoding", "identity");
  }
  try {
    return await dispatchHttpFetch(fetch, url, {
      ...init,
      headers,
      signal: attemptTimeout.signal,
    }, dispatch);
  } finally {
    // Only the header timer is cleared. The composed signal still contains the parent, so a
    // caller abort after headers continue to cancel consumption of the returned response body.
    attemptTimeout.clear();
  }
}

export interface ResetRetryOptions {
  abortSignal?: AbortSignal;
  /** Short host/path label for the retry warn log (no secrets/query strings). */
  label?: string;
  /** Total sends, including the first. More than one opts into ambiguous replay. */
  attempts?: number;
}

export interface TransientRetryOptions extends ResetRetryOptions {
  /** Test seam: per-attempt slow budget override (defaults to TRANSIENT_RETRY_SLOW_ATTEMPT_MS). */
  slowAttemptMs?: number;
}

export type UpstreamSendRecovery = "connection-reset" | "transient-5xx";
type ReplayableFetch = (recovery?: UpstreamSendRecovery) => Promise<Response>;

/**
 * Rejection thrown by the upstream retry helpers when the terminal attempt
 * rejects after earlier attempts already produced credential-visible evidence:
 * transient 5xx responses, or a connection reset after the request was read.
 *
 * That evidence proves the host and credential path were reached, so the
 * failure must stay account-attributed even though the terminal promise looks
 * like a transport rejection (issue #914 review: mixed 5xx/reset -> rejection
 * must not be downgraded to the account-neutral pre-connection class). The
 * original rejection is preserved as `cause` so its code and message stay
 * inspectable. Extracted from PR #966 (Yuxin-Qiao) with attribution.
 */
export class UpstreamRetryEvidenceError extends Error {
  constructor(
    public readonly transientStatuses: readonly number[],
    cause: unknown,
    /** True when a connection-reset retry already reached the origin. */
    public readonly resetSeen = false,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const kinds: string[] = [];
    if (transientStatuses.length > 0) kinds.push("transient 5xx response(s)");
    if (resetSeen) kinds.push("a credential-visible connection reset");
    super(
      kinds.length > 0
        ? `upstream fetch failed after ${kinds.join(" and ")}: ${detail}`
        : `upstream fetch failed: ${detail}`,
      { cause },
    );
    this.name = "UpstreamRetryEvidenceError";
  }
}

/**
 * Opt out of Bun's keep-alive pool after a connection-reset retry.
 *
 * Prefer the Bun fetch extension `keepalive: false` (transport-level) over
 * relying on the hop-by-hop `Connection: close` header alone — Bun has ignored
 * that header in past releases (oven-sh/bun#20492), so a header-only retry can
 * still reuse the same half-closed pooled socket. Still set Connection: close
 * as a belt-and-suspenders signal for intermediaries that honor it.
 */
export function applyUpstreamRecoveryInit<T extends RequestInit>(
  init: T,
  recovery?: UpstreamSendRecovery,
): T & { headers: Headers } {
  const headers = new Headers(init.headers);
  if (recovery !== "connection-reset") {
    return { ...init, headers };
  }
  headers.set("connection", "close");
  return { ...init, headers, keepalive: false };
}

/**
 * Run `doFetch`, retrying only connection-reset-shaped rejections (see
 * isConnectionResetError) with jittered backoff only when explicitly enabled.
 * A replayable body does not imply an inference request is safe to repeat.
 */
export async function fetchWithResetRetry(
  doFetch: ReplayableFetch,
  opts: ResetRetryOptions = {},
  firstRecovery?: UpstreamSendRecovery,
): Promise<Response> {
  const attempts = normalizedAttempts(opts.attempts, RESET_RETRY_MAX_ATTEMPTS);
  let lastError: unknown;
  let sawReset = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.abortSignal?.aborted) throw abortError(opts.abortSignal);
    try {
      return await doFetch(attempt === 0 ? firstRecovery : "connection-reset");
    } catch (err) {
      if (opts.abortSignal?.aborted) throw err;
      if (!isConnectionResetError(err)) {
        // A reset that already reached the origin is credential-visible
        // evidence: keep it attached so the terminal rejection cannot be
        // downgraded to the pre-connection neutral class (#914 review).
        if (sawReset) throw new UpstreamRetryEvidenceError([], err, true);
        throw err;
      }
      if (attempt === attempts - 1) throw err;
      sawReset = true;
      lastError = err;
      console.warn(
        `[upstream-retry] connection reset${opts.label ? ` (${opts.label})` : ""} — retrying (${attempt + 2}/${attempts})`,
      );
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: RESET_RETRY_BASE_DELAY_MS,
        maxDelayMs: RESET_RETRY_MAX_DELAY_MS,
      }), opts.abortSignal);
    }
  }
  throw lastError ?? new Error("upstream fetch failed");
}

/** One total send count across reset and HTTP-status recovery, never nested. */
export async function fetchWithTransientRetry(
  doFetch: ReplayableFetch,
  opts: TransientRetryOptions = {},
): Promise<Response> {
  const attempts = normalizedAttempts(opts.attempts, TRANSIENT_RETRY_MAX_ATTEMPTS);
  const slowAttemptMs = opts.slowAttemptMs ?? TRANSIENT_RETRY_SLOW_ATTEMPT_MS;
  const transientStatuses: number[] = [];
  let resetSeen = false;
  let recovery: UpstreamSendRecovery | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.abortSignal?.aborted) throw abortError(opts.abortSignal);
    const attemptStart = Date.now();
    let response: Response;
    try {
      response = await doFetch(recovery);
    } catch (error) {
      if (opts.abortSignal?.aborted) throw error;
      if (!isConnectionResetError(error) || attempt === attempts - 1) {
        if (transientStatuses.length || resetSeen) {
          throw new UpstreamRetryEvidenceError(transientStatuses, error, resetSeen);
        }
        throw error;
      }
      resetSeen = true;
      recovery = "connection-reset";
      await sleepWithAbort(retryBackoffDelayMs(attempt, {
        baseDelayMs: RESET_RETRY_BASE_DELAY_MS,
        maxDelayMs: RESET_RETRY_MAX_DELAY_MS,
      }), opts.abortSignal);
      continue;
    }
    if (!isTransientUpstreamStatus(response.status) || attempt === attempts - 1
      || opts.abortSignal?.aborted || Date.now() - attemptStart > slowAttemptMs) return response;
    transientStatuses.push(response.status);
    recovery = "transient-5xx";
    const delay = retryBackoffDelayMs(attempt, {
      baseDelayMs: TRANSIENT_RETRY_BASE_DELAY_MS,
      maxDelayMs: TRANSIENT_RETRY_MAX_DELAY_MS,
      headers: response.headers,
    });
    cancelResponseBodyBestEffort(response);
    await sleepWithAbort(delay, opts.abortSignal);
  }
  throw new Error("upstream send budget exhausted");
}

function normalizedAttempts(attempts: number | undefined, fallback: number): number {
  return attempts !== undefined && Number.isFinite(attempts)
    ? Math.max(1, Math.floor(attempts)) : fallback;
}

/**
 * Runtime-state-first proxy liveness with identity checking.
 *
 * Historically `ensure`/`start` probed only `config.port` and accepted ANY 2xx /healthz:
 * a proxy that started on a fallback port was invisible (duplicate starts, Codex synced
 * back to a dead port), and a foreign app answering 200 on the configured port counted
 * as "our proxy". Liveness now (1) prefers the pid + runtime-port record and (2) requires
 * the /healthz body to identify as CodexCommander.
 *
 * Lives outside cli.ts (which dispatches argv at module top level) so tests can import it.
 */
import { loadConfig, readAlivePid, readRuntimePort, verifyPidIdentity } from "../config";
import {
  ATTESTATION_CHALLENGE_HEADER,
  ATTESTATION_PROOF_HEADER,
  isOwnedHealthService,
} from "../identity";
import {
  createLocalAttestationChallenge,
  isLocalAttestationSecret,
  verifyLocalAttestationProof,
} from "../lib/local-management-attestation";

export interface HealthzIdentity {
  service?: unknown;
  status?: unknown;
  version?: unknown;
  uptime?: unknown;
  pid?: unknown;
  port?: unknown;
}

export interface RuntimeLivenessRecord {
  pid?: number;
  port: number;
  hostname?: string;
  /** Protected per-process key used only for the local management challenge. */
  attestationSecret?: string;
}

export interface LivenessIo {
  fetchFn?: typeof fetch;
  readPidFn?: () => number | null;
  /**
   * Full identity check of the passed candidate pid; must return the SAME pid or null.
   * Destructive callers only ever receive pids that passed this gate.
   */
  verifyPidFn?: (candidatePid: number) => number | null;
  readRuntimeFn?: (pid?: number) => RuntimeLivenessRecord | null;
  configFn?: () => { port?: number; hostname?: string };
  timeoutMs?: number;
  /**
   * How many times to retry a probe that failed with a transport error (timeout /
   * connection refused). Definitive answers (non-OK HTTP, foreign /healthz body, pid
   * mismatch) do not retry. Default 1 = no retry. Stop paths should pass 2–3 (#764).
   */
  attempts?: number;
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * Absolute wall-clock deadline for discovery. When set, each probe attempt aborts
   * once the remaining budget cannot cover another fetch — so multi-candidate
   * `findLiveProxy` under `SERVICE_STOP_LIVENESS` cannot overrun the stop-path
   * verification window (#764 / CodeRabbit).
   */
  deadlineAt?: number;
  nowFn?: () => number;
}

/** Default per-probe fetch ceiling shared by liveness and readiness probes. */
export const DEFAULT_PROBE_TIMEOUT_MS = 750;

/** Default probe options for service stop / orphan cleanup — a just-bound proxy can miss a single 750ms probe. */
export const SERVICE_STOP_LIVENESS: Pick<LivenessIo, "timeoutMs" | "attempts"> = {
  timeoutMs: 1500,
  attempts: 3,
};

export interface LiveProxy {
  pid: number | null;
  port: number;
  /** Raw bind hostname the probe succeeded against; compose URLs via `probeHostname`. */
  hostname?: string;
  /** Whether the successful probe used runtime-port metadata or the configured listen port. */
  source: "runtime" | "config";
}

export interface AttestedLiveManagementProxy extends LiveProxy {
  pid: number;
  source: "runtime";
  /** Canonical request root derived from the attested runtime record. */
  baseUrl: string;
}

export interface ManagementAttestationIo {
  fetchFn?: typeof fetch;
  readRuntimeFn?: (pid?: number) => RuntimeLivenessRecord | null;
  verifyPidFn?: (candidatePid: number) => number | null;
  timeoutMs?: number;
  /** Rotation recovery only. Each attempt re-discovers and re-attests from scratch. */
  attempts?: number;
  expectedPid?: number;
}

/**
 * Host to probe for a given bind hostname: wildcards answer on IPv4 loopback, and raw
 * IPv6 addresses must be bracketed or the composed URL is invalid.
 */
export function probeHostname(hostname: string | undefined): string {
  const trimmed = (hostname ?? "").trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") return "127.0.0.1";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

/**
 * True when a /healthz body identifies a CodexCommander proxy.
 */
export function isCodexCommanderHealthz(body: HealthzIdentity | null): boolean {
  return body !== null && isOwnedHealthService(body.service);
}

/** Identity-checked /healthz probe; null when unreachable, non-OK, or not our proxy. */
export async function proxyIdentityAt(
  port: number,
  opts: { hostname?: string; expectedPid?: number } = {},
  io: LivenessIo = {},
): Promise<{ pid: number | null } | null> {
  const fetchFn = io.fetchFn ?? fetch;
  const sleepFn = io.sleepFn ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const nowFn = io.nowFn ?? Date.now;
  const baseTimeoutMs = io.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const requestedAttempts = Math.trunc(io.attempts ?? 1);
  const attempts = Number.isNaN(requestedAttempts)
    ? 1
    : Math.max(1, Math.min(requestedAttempts, 5));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remainingMs = io.deadlineAt === undefined ? baseTimeoutMs : io.deadlineAt - nowFn();
    if (remainingMs <= 0) return null;
    const timeoutMs = Math.min(baseTimeoutMs, remainingMs);
    try {
      const res = await fetchFn(`http://${probeHostname(opts.hostname)}:${port}/healthz`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as HealthzIdentity | null;
      if (!isCodexCommanderHealthz(body)) return null;
      const pid = typeof body?.pid === "number" && Number.isSafeInteger(body.pid) && body.pid > 0
        ? body.pid
        : null;
      if (pid === null) return null;
      if (opts.expectedPid !== undefined && pid !== opts.expectedPid) return null;
      return { pid };
    } catch {
      // Transport failure (timeout / refused) — retry while budget remains; a proxy that
      // has only just begun listening can miss a single short probe (#764).
      if (attempt >= attempts) return null;
      if (io.deadlineAt !== undefined && io.deadlineAt - nowFn() <= 0) return null;
      await sleepFn(100);
    }
  }
  return null;
}

/**
 * Locate the live proxy: pid file → runtime-port record → identity probe. Falls back to
 * the configured port ONLY when no runtime record answers, so a fallback-port proxy is
 * found and a foreign listener on the configured port is rejected.
 */
export async function findLiveProxy(io: LivenessIo = {}): Promise<LiveProxy | null> {
  // Prefer the cheap alive-pid check: the Windows cmdline probe (WMIC/PowerShell) is too
  // expensive for waitForProxy's 150ms poll loop, and /healthz identity is the real trust gate.
  const readPidFn = io.readPidFn ?? readAlivePid;
  const verifyPidFn = io.verifyPidFn ?? verifyPidIdentity;
  const readRuntimeFn = io.readRuntimeFn ?? readRuntimePort;
  const configFn = io.configFn ?? loadConfig;
  const nowFn = io.nowFn ?? Date.now;
  const deadlineAt = io.deadlineAt;
  const probeIo: LivenessIo = io;
  const budgetExhausted = (): boolean =>
    deadlineAt !== undefined && nowFn() >= deadlineAt;

  // The cheap pid is discovery-only. Before it can appear in a returned (killable) result
  // it must pass the full identity check AND the verifier must echo the exact candidate —
  // a pidfile rewrite between discovery and verification can never swap in another process.
  const verifiedReportedPid = (reported: number | null): number | null => {
    if (reported === null) return null;
    if (!Number.isSafeInteger(reported) || reported <= 0) return null;
    const verified = verifyPidFn(reported);
    return verified === reported ? verified : null;
  };

  const pid = readPidFn();
  let probedPort: number | null = null;
  if (pid) {
    const runtime = readRuntimeFn(pid);
    if (runtime?.port) {
      if (budgetExhausted()) return null;
      probedPort = runtime.port;
      const identity = await proxyIdentityAt(runtime.port, { hostname: runtime.hostname, expectedPid: pid }, probeIo);
      if (identity) {
        return { pid, port: runtime.port, hostname: runtime.hostname, source: "runtime" };
      }
    }
  }

  // The pid file can be lost/corrupt while the proxy is alive (crash of a sibling command,
  // manual deletion). The current runtime record still identifies where it listens.
  const record = readRuntimeFn();
  if (record?.port && typeof record.pid === "number" && record.port !== probedPort) {
    if (budgetExhausted()) return null;
    const identity = await proxyIdentityAt(record.port, { hostname: record.hostname, expectedPid: record.pid }, probeIo);
    if (identity) {
      return { pid: verifiedReportedPid(identity.pid), port: record.port, hostname: record.hostname, source: "runtime" };
    }
  }

  const config = configFn();
  const port = config.port ?? 10100;
  if (budgetExhausted()) return null;
  const identity = await proxyIdentityAt(port, { hostname: config.hostname }, probeIo);
  if (identity) {
    return {
      pid: verifiedReportedPid(identity.pid),
      port,
      hostname: config.hostname,
      source: "config",
    };
  }
  return null;
}

function exactRuntimeRecord(
  record: RuntimeLivenessRecord | null,
  expected: { pid: number; port: number; hostname?: string; attestationSecret: string },
): boolean {
  return record?.pid === expected.pid
    && record.port === expected.port
    && record.hostname === expected.hostname
    && record.attestationSecret === expected.attestationSecret;
}

/**
 * Authenticate the exact listener named by the protected per-process runtime record.
 *
 * This is the credential/body release fence for local management clients. Public
 * `/healthz` identity alone is intentionally insufficient: a lookalike listener can
 * copy that JSON. The listener must prove possession of the runtime record's random
 * secret with the existing challenge/PID/port HMAC, and the record must remain byte-
 * equivalent in all security-relevant fields after the proof. A rotation retries only
 * by starting discovery and attestation again; no credential or caller body is passed
 * to either health probe.
 */
export async function attestLiveManagementProxy(
  io: ManagementAttestationIo = {},
): Promise<AttestedLiveManagementProxy | null> {
  const fetchFn = io.fetchFn ?? fetch;
  const readRuntimeFn = io.readRuntimeFn ?? readRuntimePort;
  const verifyPidFn = io.verifyPidFn ?? verifyPidIdentity;
  const requestedTimeoutMs = Math.trunc(io.timeoutMs ?? 4_000);
  const timeoutMs = Number.isNaN(requestedTimeoutMs)
    ? 4_000
    : Math.max(1, Math.min(requestedTimeoutMs, 30_000));
  const requestedAttempts = Math.trunc(io.attempts ?? 2);
  const attempts = Number.isNaN(requestedAttempts)
    ? 1
    : Math.max(1, Math.min(requestedAttempts, 3));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // Sensitive discovery starts from the protected record itself. Calling the
      // public liveness finder here would let a spoof feed an unbounded /healthz body
      // to its JSON parser before the HMAC fence.
      const record = readRuntimeFn();
      if (!record
        || !Number.isSafeInteger(record.pid)
        || (record.pid ?? 0) <= 0
        || !Number.isInteger(record.port)
        || record.port <= 0
        || record.port > 65535
        || !isLocalAttestationSecret(record.attestationSecret)) {
        continue;
      }
      const recordPid = record.pid as number;
      if (io.expectedPid !== undefined && recordPid !== io.expectedPid) continue;
      if (verifyPidFn(recordPid) !== recordPid) continue;
      const snapshot = {
        pid: recordPid,
        port: record.port,
        hostname: record.hostname,
        attestationSecret: record.attestationSecret,
      };
      const challenge = createLocalAttestationChallenge();
      const baseUrl = `http://${probeHostname(snapshot.hostname)}:${snapshot.port}`;
      const response = await fetchFn(`${baseUrl}/healthz`, {
        headers: { [ATTESTATION_CHALLENGE_HEADER]: challenge },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const proof = response.headers.get(ATTESTATION_PROOF_HEADER);
      const proved = response.ok && verifyLocalAttestationProof(
          snapshot.attestationSecret,
          challenge,
          snapshot.pid,
          snapshot.port,
          proof,
        );
      // The proof authenticates the exact PID/port; never parse a listener-controlled
      // body on this credential-release path. Cancellation bounds both declared-huge
      // and chunked/streaming spoof responses.
      await response.body?.cancel().catch(() => {});
      if (!proved) continue;

      // Detect restart/rotation after the proof before a caller can attach a token
      // or sensitive body. The caller must issue its request immediately on return.
      if (!exactRuntimeRecord(readRuntimeFn(snapshot.pid), snapshot)) continue;
      if (verifyPidFn(snapshot.pid) !== snapshot.pid) continue;
      return {
        pid: snapshot.pid,
        port: snapshot.port,
        hostname: snapshot.hostname,
        source: "runtime",
        baseUrl,
      };
    } catch {
      // Retry only by re-reading discovery state and issuing a fresh challenge.
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Readiness (/readyz) strict probe.
//
// Liveness (/healthz) confirms the process answers; readiness confirms the
// post-startup Codex sync has settled. A readiness probe is identity-checked the
// same way liveness is, AND additionally enforces the full /readyz contract so
// an adversarial or malformed body can never count as ready:
//
//  - HTTP 200 is required for status="ready"; HTTP 503 is required for pending
//    or failed. Any other HTTP/body-status pairing is an invalid contract.
//  - body.service must be an owned identity: canonical "codexcommander" or the
//    exact CodexCommander service identity.
//  - body.version must be a non-empty string.
//  - body.uptime must be a finite nonnegative number.
//  - body.pid must be a positive integer; when `expectedPid` is supplied it must
//    match exactly.
//  - body.port must be an integer in 1..65535 and equal the probed port.
//  - body.status must be exactly one of pending|ready|failed.
//
// Any unreachable, foreign, non-current, malformed, mismatched, or self-inconsistent
// response returns `null` so callers can never treat an invalid identity/contract
// as ready.
// ─────────────────────────────────────────────────────────────────────────────

interface ReadyzBody {
  service?: unknown;
  version?: unknown;
  uptime?: unknown;
  pid?: unknown;
  port?: unknown;
  status?: unknown;
}

export interface ReadinessProbeResult {
  /** True ONLY for a valid 200 + status="ready" body with a matching pid. */
  ready: boolean;
  /** Fixed sanitized status. A foreign/unreadable body yields a `null` RESULT, never a `null` status. */
  status: "ready" | "pending" | "failed";
  /** Positive integer pid from a valid body. */
  pid: number;
  /** Integer port from a valid body. */
  port: number;
}

export interface ReadinessProbeIo {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const READYZ_STATUS_VALUES = new Set<"ready" | "pending" | "failed">(["ready", "pending", "failed"]);

/**
 * Validate a parsed /readyz body against the strict contract. Returns the
 * sanitized probe result, or `null` when the body is foreign, non-current,
 * malformed, or fails the pid/port checks. Pure (no I/O) so it is fully
 * deterministic and unit-testable.
 */
export function validateReadyzBody(
  body: unknown,
  port: number,
  opts: { expectedPid?: number } = {},
): ReadinessProbeResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as ReadyzBody;
  if (!isOwnedHealthService(b.service)) return null;
  if (typeof b.version !== "string" || b.version.length === 0) return null;
  if (typeof b.uptime !== "number" || !Number.isFinite(b.uptime) || b.uptime < 0) return null;
  if (typeof b.pid !== "number" || !Number.isInteger(b.pid) || b.pid <= 0) return null;
  if (
    typeof b.port !== "number"
    || !Number.isInteger(b.port)
    || b.port < 1
    || b.port > 65535
    || b.port !== port
  ) return null;
  if (typeof b.status !== "string" || !READYZ_STATUS_VALUES.has(b.status as "ready" | "pending" | "failed")) return null;
  const status = b.status as "ready" | "pending" | "failed";
  if (opts.expectedPid !== undefined && b.pid !== opts.expectedPid) return null;
  return { ready: status === "ready", status, pid: b.pid, port: b.port };
}

/**
 * Identity- and contract-checked /readyz probe. Returns `null` when the
 * endpoint is unreachable or the body fails the strict contract (foreign 200,
 * health-only body, non-JSON, missing/malformed/mismatched fields,
 * wrong port/pid, or an HTTP/body-status inconsistency). Returns
 * `{ready:false, ...}` when the body is ours but pending or failed. Returns
 * `{ready:true, ...}` ONLY for a valid 200 body with `status:"ready"` and (when
 * requested) a matching pid.
 */
export async function probeReadiness(
  port: number,
  opts: { hostname?: string; expectedPid?: number } = {},
  io: ReadinessProbeIo = {},
): Promise<ReadinessProbeResult | null> {
  const fetchFn = io.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`http://${probeHostname(opts.hostname)}:${port}/readyz`, {
      signal: AbortSignal.timeout(io.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    // Parse even on 503: /readyz returns JSON with a sanitized status while pending.
    const body = (await res.json().catch(() => null)) as unknown;
    const parsed = validateReadyzBody(body, port, opts);
    if (!parsed) return null;
    // HTTP/body-status consistency: ready requires 200; pending/failed require 503.
    if (parsed.status === "ready" && res.status !== 200) return null;
    if (parsed.status !== "ready" && res.status !== 503) return null;
    return parsed;
  } catch {
    return null;
  }
}

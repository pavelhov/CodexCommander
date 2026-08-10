import type {
  CompanionHealthInfo,
  LaunchAtLoginReport,
  StartupHealth,
} from "../codex/autostart-health";

/**
 * Native-app companion startup state.
 *
 * The menu bar app is the only writer. It PUTs its freshly sampled launch-at-login
 * status using the admin token; the server stamps the observation time itself and
 * keeps a short in-memory lease. Client-supplied timestamps, TTLs, PIDs, paths, and
 * bundle metadata are never accepted or logged.
 *
 * The lease is advisory decoration only. The base service/shim diagnosis is cached
 * separately (startup-health-cache.ts) and is never overridden by a fresh lease:
 * every `/api/startup-health` response and settings seed is decorated at response
 * time, and a viable service always wins over the companion.
 */

export const COMPANION_BODY_VERSION = 1 as const;
export const COMPANION_HEARTBEAT_TARGET_MS = 30_000;
export const COMPANION_LEASE_TTL_MS = 90_000;

export interface CompanionLease {
  version: typeof COMPANION_BODY_VERSION;
  launchAtLogin: LaunchAtLoginReport;
  /** Server wall-clock timestamp (ms) when the lease was received. */
  observedAt: number;
}

const LAUNCH_AT_LOGIN_VALUES: readonly LaunchAtLoginReport[] = [
  "enabled",
  "disabled",
  "requires-approval",
  "unavailable",
];

let lease: CompanionLease | null = null;

export function recordCompanionLease(
  launchAtLogin: LaunchAtLoginReport,
  now: number = Date.now(),
): void {
  lease = { version: COMPANION_BODY_VERSION, launchAtLogin, observedAt: now };
}

/** The current fresh lease, or null once the 90s TTL has elapsed. Advisory only. */
export function currentCompanionLease(now: number = Date.now()): CompanionLease | null {
  if (!lease) return null;
  const age = now - lease.observedAt;
  // Fail closed on TTL expiry AND on a backwards-moving wall clock: a negative age
  // must never keep a lease fresh indefinitely.
  if (age < 0 || age >= COMPANION_LEASE_TTL_MS) return null;
  return lease;
}

/**
 * Test seam: in-memory state is process-global, so a focused suite can isolate
 * itself. Production restart semantics are covered by the fresh-module import test.
 */
export function clearCompanionLeaseForTests(): void {
  lease = null;
}

export type CompanionStartupBodyResult =
  | { ok: true; launchAtLogin: LaunchAtLoginReport }
  | { ok: false; error: string };

/**
 * Strict body validation for PUT /api/startup-health/companion. Only the exact
 * `{version: 1, launchAtLogin: <enum>}` shape is accepted; any extra key (including
 * client timestamps, TTLs, PIDs, paths, or bundle metadata) is rejected.
 */
export function parseCompanionStartupBody(raw: unknown): CompanionStartupBodyResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !("version" in record) || !("launchAtLogin" in record)) {
    return { ok: false, error: "body must contain exactly version and launchAtLogin" };
  }
  if (record.version !== COMPANION_BODY_VERSION) {
    return { ok: false, error: "version must be 1" };
  }
  if (!LAUNCH_AT_LOGIN_VALUES.includes(record.launchAtLogin as LaunchAtLoginReport)) {
    return {
      ok: false,
      error: "launchAtLogin must be enabled, disabled, requires-approval, or unavailable",
    };
  }
  return { ok: true, launchAtLogin: record.launchAtLogin as LaunchAtLoginReport };
}

function companionInfo(lease: CompanionLease): CompanionHealthInfo {
  return {
    launchAtLogin: lease.launchAtLogin,
    observedAt: lease.observedAt,
  };
}

interface EffectiveStartup {
  status: StartupHealth["status"];
  startupMethod: StartupHealth["startupMethod"];
  rebootSafe: boolean;
  crashRecovery: boolean;
  protection: StartupHealth["protection"];
}

/**
 * Precedence (locked contract):
 * - no local routing            => native/native   true/false
 * - owned local + viable service => protected/service true/true  (service wins)
 * - owned local + fresh enabled companion => caution/companion true/false
 * - shim stays conservative      => at-risk/shim   false/false
 * - other local (custom/unknown) => at-risk/none   false/false
 *
 * The companion is never credited for `custom-local`/`unknown` routing, and a fresh
 * lease never overrides `diagnosticStale` (the cache already fails closed there).
 */
function deriveEffectiveStartup(
  base: StartupHealth,
  companionLease: CompanionLease | null,
): EffectiveStartup {
  if (!base.localRoutingDependency) {
    return { status: "native", startupMethod: "native", rebootSafe: true, crashRecovery: false, protection: "none" };
  }
  if (base.diagnosticStale) {
    // Preserve the cache's fail-closed answer; do not resurrect protection or credit
    // a fresh companion lease while a probe is revalidating.
    return {
      status: base.status,
      startupMethod: base.startupMethod,
      rebootSafe: base.rebootSafe,
      crashRecovery: base.crashRecovery,
      protection: base.protection,
    };
  }
  const ownsRouting = base.routingKind === "codexcommander-local";
  if (ownsRouting && base.serviceViable) {
    return { status: "protected", startupMethod: "service", rebootSafe: true, crashRecovery: true, protection: "service" };
  }
  const companionCredited = ownsRouting
    && companionLease !== null
    && companionLease.launchAtLogin === "enabled";
  if (companionCredited) {
    return { status: "caution", startupMethod: "companion", rebootSafe: true, crashRecovery: false, protection: "companion" };
  }
  if (ownsRouting && base.shimCoverage !== "none") {
    return { status: "at-risk", startupMethod: "shim", rebootSafe: false, crashRecovery: false, protection: "shim" };
  }
  return { status: "at-risk", startupMethod: "none", rebootSafe: false, crashRecovery: false, protection: "none" };
}

/**
 * Decorate a base diagnosis with the current companion lease. The lease is
 * informational whenever it is fresh; it changes effective health only when the
 * precedence above credits it. `recommendedCommand` stays null for the
 * companion-managed case (the app owns startup), while the existing `commands`
 * shape still exposes `installService` as an optional crash-recovery action.
 */
export function decorateStartupHealth(
  base: StartupHealth,
  now: number = Date.now(),
): StartupHealth {
  const companionLease = currentCompanionLease(now);
  const companion = companionLease ? companionInfo(companionLease) : null;
  const effective = deriveEffectiveStartup(base, companionLease);
  return {
    ...base,
    status: effective.status,
    startupMethod: effective.startupMethod,
    rebootSafe: effective.rebootSafe,
    crashRecovery: effective.crashRecovery,
    protection: effective.protection,
    recommendedCommand: effective.status === "caution" ? null : base.recommendedCommand,
    companion,
  };
}

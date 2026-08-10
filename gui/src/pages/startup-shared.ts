import type { TKey } from "../i18n/shared";

export type StartupStatus = "native" | "protected" | "caution" | "at-risk";
export type StartupMethod = "native" | "service" | "companion" | "shim" | "none";
export type StartupProtection = "service" | "shim" | "companion" | "none";
export type StartupInstallAction = "install-service" | "install-shim";
export type CompanionLaunchAtLogin = "enabled" | "disabled" | "requires-approval" | "unavailable";

/**
 * Login state of the native companion app as observed by the server. `observedAt` is
 * the lease timestamp; a missing or zero lease means launch-at-login could not be
 * verified and must render as unknown, never as "disabled".
 */
export interface StartupCompanionStatus {
  launchAtLogin: CompanionLaunchAtLogin;
  observedAt: number;
}

export type StartupRoutingKind =
  | "native"
  | "codexcommander-local"
  | "custom-local"
  | "custom-remote"
  | "unknown";

export function isCodexCommanderLocalRouting(kind: StartupRoutingKind): boolean {
  return kind === "codexcommander-local";
}

export function startupRoutingKey(kind: StartupRoutingKind): TKey {
  if (isCodexCommanderLocalRouting(kind)) return "startup.routing.proxy";
  if (kind === "custom-local") return "startup.routing.customLocal";
  if (kind === "custom-remote") return "startup.routing.customRemote";
  if (kind === "unknown") return "startup.routing.unknown";
  return "startup.routing.native";
}

export interface StartupHealthData {
  status: StartupStatus;
  /** New contract: how the proxy comes up after login. Absent on legacy payloads. */
  startupMethod?: StartupMethod;
  /** New contract: crash-recovery service state. Absent on legacy payloads. */
  crashRecovery?: boolean;
  /** New contract: companion app login state. `undefined` = field not sent. */
  companion?: StartupCompanionStatus | null;
  routingKind: StartupRoutingKind;
  routingInjected: boolean;
  localRoutingDependency: boolean;
  autostartEnabled: boolean;
  rebootSafe: boolean;
  protection: StartupProtection;
  serviceInstalled: boolean;
  serviceViable: boolean;
  serviceEnabled: boolean;
  serviceRunning: boolean;
  serviceStale: boolean;
  serviceConflict: boolean;
  serviceSupported: boolean;
  shimInstalled: boolean;
  shimHealthy: boolean;
  shimCoverage: "full" | "cli-only" | "none";
  platform: string;
  recommendedCommand: string | null;
  diagnosticStale: boolean;
  commands: {
    installService: string;
    repairService: string;
    installShim: string;
    restoreNative: string;
  };
}

export interface TrayStatusData {
  supported: boolean;
  installed: boolean;
  running: boolean;
  stale: boolean;
  summary: string;
}

export function isTrayStatusData(value: unknown): value is TrayStatusData {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.supported === "boolean"
    && typeof row.installed === "boolean"
    && typeof row.running === "boolean"
    && typeof row.stale === "boolean"
    && typeof row.summary === "string";
}

export const STATUS_KEYS: Record<StartupStatus, TKey> = {
  native: "startup.status.native",
  protected: "startup.status.protected",
  caution: "startup.status.caution",
  "at-risk": "startup.status.atRisk",
};

export const SUMMARY_KEYS: Record<StartupStatus, TKey> = {
  native: "startup.summary.native",
  protected: "startup.summary.protected",
  caution: "startup.summary.caution",
  "at-risk": "startup.summary.atRisk",
};

export const PROTECTION_KEYS: Record<StartupProtection, TKey> = {
  service: "startup.protection.service",
  shim: "startup.protection.shim",
  companion: "startup.protection.companion",
  none: "startup.protection.none",
};

export const METHOD_KEYS: Record<StartupMethod, TKey> = {
  native: "startup.method.native",
  service: "startup.method.service",
  companion: "startup.method.companion",
  shim: "startup.method.shim",
  none: "startup.method.none",
};

/** True only when the companion lease was actually observed (nonzero timestamp). */
export function companionLeaseObserved(companion: StartupCompanionStatus | null | undefined): boolean {
  return companion != null && Number.isFinite(companion.observedAt) && companion.observedAt > 0;
}

/** True only when the companion verifiably launches at login. */
export function companionLaunchEnabled(data: StartupHealthData): boolean {
  return companionLeaseObserved(data.companion) && data.companion?.launchAtLogin === "enabled";
}

/** Startup method, preferring the new contract field with a legacy fallback. */
export function deriveStartupMethod(data: StartupHealthData): StartupMethod {
  if (data.startupMethod) return data.startupMethod;
  if (data.protection === "service") return "service";
  if (data.protection === "shim") return "shim";
  if (data.protection === "companion") return "companion";
  return data.status === "native" ? "native" : "none";
}

export type StartupHeroKind = "app-managed" | "protected" | "native" | "at-risk";

export type StartupMethodState = "ready" | "attention" | "unknown";

export interface StartupView {
  hero: StartupHeroKind;
  method: StartupMethod;
  methodState: StartupMethodState;
  crashRecovery: "on" | "off";
  /** The crash-recovery service can be installed from the primary row. */
  canEnableCrashRecovery: boolean;
  /** True while the companion lease is missing and login state cannot be verified. */
  companionLeaseMissing: boolean;
  /** At-risk keeps the repair affordances visible by opening Advanced up front. */
  advancedDefaultOpen: boolean;
}

/**
 * Single derivation for the Startup page so hero, primary rows, and Advanced stay
 * consistent. `failed` (stale diagnostics or fetch failure) always wins: stale data
 * must never render the calm app-managed state.
 */
export function deriveStartupView(data: StartupHealthData, failed: boolean): StartupView {
  const method = deriveStartupMethod(data);
  // A companion object without an observed lease is unknown, not "disabled".
  const companionLeaseMissing = data.companion != null && !companionLeaseObserved(data.companion);
  const companionOk = companionLaunchEnabled(data);
  const crashRecoveryOn = data.crashRecovery !== undefined
    ? data.crashRecovery
    : data.protection === "service" && data.serviceViable;

  let hero: StartupHeroKind;
  if (failed || data.status === "at-risk") {
    hero = "at-risk";
  } else if (data.status === "caution") {
    // Caution is app-managed only with a verified companion login; anything else
    // (disabled, approval pending, unavailable, or a missing lease) needs attention.
    hero = companionOk ? "app-managed" : "at-risk";
  } else if (data.status === "protected") {
    hero = "protected";
  } else {
    hero = "native";
  }

  let methodState: StartupMethodState;
  if (method === "native") {
    methodState = "ready";
  } else if (method === "companion") {
    methodState = companionOk ? "ready" : companionLeaseMissing ? "unknown" : "attention";
  } else if (method === "service") {
    methodState = data.serviceViable || data.rebootSafe ? "ready" : "attention";
  } else if (method === "shim") {
    methodState = data.shimHealthy && data.autostartEnabled ? "ready" : "attention";
  } else {
    methodState = "attention";
  }

  return {
    hero,
    method,
    methodState,
    crashRecovery: crashRecoveryOn ? "on" : "off",
    canEnableCrashRecovery: !failed && !crashRecoveryOn && data.serviceSupported,
    companionLeaseMissing,
    advancedDefaultOpen: hero === "at-risk",
  };
}

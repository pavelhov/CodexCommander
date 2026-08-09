import type { TKey } from "../i18n/shared";

export type StartupStatus = "native" | "protected" | "at-risk";
export type StartupProtection = "service" | "shim" | "none";
export type StartupInstallAction = "install-service" | "install-shim";
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
  "at-risk": "startup.status.atRisk",
};

export const SUMMARY_KEYS: Record<StartupStatus, TKey> = {
  native: "startup.summary.native",
  protected: "startup.summary.protected",
  "at-risk": "startup.summary.atRisk",
};

export const PROTECTION_KEYS: Record<StartupProtection, TKey> = {
  service: "startup.protection.service",
  shim: "startup.protection.shim",
  none: "startup.protection.none",
};

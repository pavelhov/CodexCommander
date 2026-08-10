import { codexAutoStartEnabled } from "../config";
import { diagnoseService, type ServiceDiagnostic } from "../service";
import type { CodexCommanderConfig } from "../types";
import { getCodexRoutingKind, type CodexRoutingKind } from "./inject";
import { diagnoseCodexShim, type CodexShimDiagnostic } from "./shim";

export type StartupProtection = "service" | "shim" | "companion" | "none";
export type StartupHealthStatus = "native" | "protected" | "caution" | "at-risk";
export type ShimCoverage = "full" | "cli-only" | "none";
/**
 * Which mechanism actually keeps Codex routing alive across a reboot or proxy
 * crash. `companion` is advisory (a fresh native-app lease), never a substitute
 * for a service diagnostic. The CLI-only shim stays conservative.
 */
export type StartupMethod = "native" | "service" | "companion" | "shim" | "none";

/**
 * The native app's launch-at-login self-report, kebab-cased on the wire. This is
 * advisory state the server never trusts for `custom-local`/`unknown` routing.
 */
export type LaunchAtLoginReport = "enabled" | "disabled" | "requires-approval" | "unavailable";

export interface CompanionHealthInfo {
  launchAtLogin: LaunchAtLoginReport;
  /** Server-side observation timestamp in epoch milliseconds; client timestamps are never accepted. */
  observedAt: number;
}

export interface StartupHealthInputs {
  routingKind: CodexRoutingKind;
  autostartEnabled: boolean;
  serviceInstalled: boolean;
  serviceViable: boolean;
  serviceEnabled: boolean;
  serviceRunning: boolean;
  serviceStale: boolean;
  serviceConflict: boolean;
  serviceSupported: boolean;
  shimInstalled: boolean;
  shimHealthy: boolean;
  platform: NodeJS.Platform;
  diagnosticStale?: boolean;
}

export interface StartupHealth {
  status: StartupHealthStatus;
  /** Effective startup mechanism after response-time decoration (base keeps `none`). */
  startupMethod: StartupMethod;
  /** Whether the active mechanism survives a proxy crash without user action. */
  crashRecovery: boolean;
  routingKind: CodexRoutingKind;
  routingInjected: boolean;
  localRoutingDependency: boolean;
  autostartEnabled: boolean;
  rebootSafe: boolean;
  protection: StartupProtection;
  /** Fresh native-app launch-at-login lease, decorated at response time. */
  companion: CompanionHealthInfo | null;
  serviceInstalled: boolean;
  serviceViable: boolean;
  serviceEnabled: boolean;
  serviceRunning: boolean;
  serviceStale: boolean;
  serviceConflict: boolean;
  shimInstalled: boolean;
  shimHealthy: boolean;
  shimCoverage: ShimCoverage;
  serviceSupported: boolean;
  platform: NodeJS.Platform;
  diagnosticStale: boolean;
  recommendedCommand: string | null;
  commands: {
    installService: string;
    repairService: string;
    installShim: string;
    restoreNative: string;
  };
}

const COMMANDS = {
  installService: "ccx service install",
  repairService: "ccx service repair",
  installShim: "ccx codex-shim install",
  restoreNative: "ccx restore",
} as const;

export function deriveStartupHealth(inputs: StartupHealthInputs): StartupHealth {
  const shimEffective = inputs.autostartEnabled && inputs.shimHealthy;
  const routingInjected = inputs.routingKind === "codexcommander-local";
  const localRoutingDependency = inputs.routingKind === "codexcommander-local"
    || inputs.routingKind === "custom-local"
    || inputs.routingKind === "unknown";
  // Script launchers never cover Codex Desktop/app-server surfaces. This is
  // intentionally conservative on every OS and for WSL-shared Codex homes.
  const shimCoverage: ShimCoverage = !shimEffective
    ? "none"
    : "cli-only";
  // We can only credit an codexcommander service/shim for routing that codexcommander owns.
  // An arbitrary localhost gateway has an independent lifecycle that CCX cannot repair.
  const ownsLocalRouting = inputs.routingKind === "codexcommander-local";
  const protection: StartupProtection = ownsLocalRouting && inputs.serviceViable
    ? "service"
    : ownsLocalRouting && shimEffective
      ? "shim"
      : "none";
  const rebootSafe = !localRoutingDependency || (ownsLocalRouting && inputs.serviceViable);
  // Base diagnosis never knows about the native companion: the server decorates the
  // lease only at response time, so the cached probe output stays companion-free.
  const startupMethod: StartupMethod = !localRoutingDependency
    ? "native"
    : ownsLocalRouting && inputs.serviceViable
      ? "service"
      : ownsLocalRouting && shimEffective
        ? "shim"
        : "none";
  const crashRecovery = ownsLocalRouting && inputs.serviceViable;
  const status: StartupHealthStatus = !localRoutingDependency
    ? "native"
    : rebootSafe
      ? "protected"
      : "at-risk";
  const recommendedCommand = status !== "at-risk"
    ? null
    : inputs.routingKind === "custom-local" || inputs.routingKind === "unknown"
      ? COMMANDS.restoreNative
    : inputs.serviceSupported
      // An already-registered service is refreshed in place: `repair` rewrites its assets
      // and restarts it without re-registering, so it needs no elevation on Windows and
      // cannot switch a WinSW install to Task Scheduler the way `install` would. Only a
      // genuinely absent (or conflicting, which needs uninstall-then-install) service
      // gets the registering command.
      ? (inputs.serviceInstalled && !inputs.serviceConflict ? COMMANDS.repairService : COMMANDS.installService)
      : COMMANDS.restoreNative;
  return {
    ...inputs,
    diagnosticStale: inputs.diagnosticStale ?? false,
    routingInjected,
    localRoutingDependency,
    status,
    startupMethod,
    crashRecovery,
    rebootSafe,
    protection,
    companion: null,
    shimCoverage,
    recommendedCommand,
    commands: { ...COMMANDS },
  };
}

export interface StartupHealthDiagnostics {
  routingKind?: CodexRoutingKind;
  service?: ServiceDiagnostic;
  shim?: CodexShimDiagnostic;
}

/** Collect current machine state without mutating config, services, or shims. */
export function collectStartupHealth(
  config: Pick<CodexCommanderConfig, "codexAutoStart">,
  diagnostics: StartupHealthDiagnostics = {},
): StartupHealth {
  const shim = diagnostics.shim ?? diagnoseCodexShim();
  const service = diagnostics.service ?? diagnoseService();
  return deriveStartupHealth({
    routingKind: diagnostics.routingKind ?? getCodexRoutingKind(),
    autostartEnabled: codexAutoStartEnabled(config),
    serviceInstalled: service.installed,
    serviceViable: service.viable,
    serviceEnabled: service.enabled,
    serviceRunning: service.running,
    serviceStale: service.stale,
    serviceConflict: service.conflict,
    serviceSupported: service.supported,
    shimInstalled: shim.installed,
    shimHealthy: shim.healthy,
    platform: process.platform,
  });
}

export function startupHealthSummary(health: StartupHealth): string {
  if (health.status === "native") return health.routingKind === "custom-remote"
    ? "custom remote Codex routing (no local restart dependency)"
    : "native Codex routing (no CodexCommander restart dependency)";
  if (health.status === "caution") {
    return "running via the menu bar companion (launch at login is enabled; service install is optional for crash recovery)";
  }
  if (health.protection === "service") return "protected by background service";
  const command = health.recommendedCommand ?? health.commands.restoreNative;
  if (health.routingKind === "unknown") return `AT RISK after restart (Codex routing could not be verified; run '${command}')`;
  if (health.routingKind === "custom-local") return `AT RISK after restart (custom local gateway lifecycle is not managed by CodexCommander; run '${command}')`;
  if (health.shimCoverage === "cli-only") return `AT RISK for Codex Desktop after restart (launcher shim covers CLI scripts only; run '${command}')`;
  if (health.serviceConflict) return `AT RISK after restart (background service managers conflict; run '${command}')`;
  if (health.serviceStale) return `AT RISK after restart (background service files are stale; run '${command}')`;
  if (health.serviceInstalled && !health.serviceViable) return `AT RISK after restart (installed service is disabled, stopped, or unhealthy; run '${command}')`;
  return `AT RISK after restart (no viable background service; run '${command}')`;
}

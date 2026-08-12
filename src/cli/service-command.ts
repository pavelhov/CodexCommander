import { existsSync, unlinkSync } from "node:fs";

import {
  prepareExplicitCodexRoutingStart,
  restoreNativeCodexRoutingForStop,
  type NativeCodexRoutingEscapeResult,
} from "../codex/inject";
import { stripGrokConfig, type GrokInjectResult } from "../grok/inject";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import {
  acquireProxyLifecycleAuthority,
  type ProxyLifecycleAuthority,
} from "../server/proxy-lifecycle-authority";
import {
  attestLiveManagementProxy,
  findLiveProxy,
  SERVICE_STOP_LIVENESS,
} from "../server/proxy-liveness";
import {
  proxyLifecycleLockLeaseHeaders,
  type ProxyLifecycleLockLease,
} from "../server/proxy-lifecycle-protocol";
import {
  armProxyServiceStartDelegation,
  clearProxyServiceStartDelegation,
  type ProxyServiceStartDelegation,
} from "../server/proxy-start-lock";
import { runningProxyUpdateHeaders } from "../oauth/login-cli";
import type { CodexSyncResult } from "../codex/sync";
import {
  assertServiceAuthEnvironment,
  assertServiceEnvironmentMatchesInstall,
  diagnoseService,
  inspectWindowsSchedulerServiceStatus,
  platformOps,
  proxyStillLiveAfterStop,
  readServiceBackend,
  removeServiceInstallState,
  repairService,
  reportServiceServing,
  resolveServiceListenPort,
  serviceDiagnosticsSummary,
  serviceStatusReport,
  serviceSupervisorInactiveAfterStop,
  stopServiceIfInstalled,
  stopTrackedProxyForServiceCommand,
  uninstallServiceIfInstalled,
  type ServiceBackend,
  type ServiceDiagnostic,
  type ServiceOps,
} from "../service";

export function normalizeServiceSubcommand(sub?: string): string {
  return sub ?? "install";
}

export interface ParsedServiceArgs {
  sub: string;
  backend: ServiceBackend | null;
  invalid: string[];
}

export function parseServiceArgs(args: string[]): ParsedServiceArgs {
  let sub: string | undefined;
  let backend: ServiceBackend | null = null;
  const invalid: string[] = [];
  for (const arg of args) {
    if (arg === "--native") {
      if (backend === "scheduler") invalid.push("--native (conflicts with --scheduler)");
      else backend = "native";
    } else if (arg === "--scheduler") {
      if (backend === "native") invalid.push("--scheduler (conflicts with --native)");
      else backend = "scheduler";
    } else if (arg.startsWith("--")) invalid.push(arg);
    else if (sub === undefined) sub = arg;
    else invalid.push(arg);
  }
  return { sub: normalizeServiceSubcommand(sub), backend, invalid };
}

export interface ServiceRoutingPreparationIo {
  prepareStart?: typeof prepareExplicitCodexRoutingStart;
  prepareStop?: typeof restoreNativeCodexRoutingForStop;
  stripGrok?: typeof stripGrokConfig;
}

export interface ServiceTerminationRoutingResult extends NativeCodexRoutingEscapeResult {
  codex: ReturnType<typeof restoreNativeCodexRoutingForStop>;
  grok: GrokInjectResult | null;
}

export function prepareServiceRoutingForStart(
  io: ServiceRoutingPreparationIo = {},
): NativeCodexRoutingEscapeResult {
  return (io.prepareStart ?? prepareExplicitCodexRoutingStart)();
}

export function prepareServiceRoutingForTermination(
  io: ServiceRoutingPreparationIo = {},
): ServiceTerminationRoutingResult {
  const codex = (io.prepareStop ?? restoreNativeCodexRoutingForStop)();
  if (!codex.success) return { ...codex, codex, grok: null };
  const grok = (io.stripGrok ?? stripGrokConfig)();
  if (!grok.ok) {
    return {
      success: false,
      changed: codex.changed || grok.changed,
      message: `${codex.message} ${grok.message}`,
      codex,
      grok,
    };
  }
  return {
    success: true,
    changed: codex.changed || grok.changed,
    message: `${codex.message} ${grok.message}`,
    codex,
    grok,
  };
}

type ServingVerb = "installed" | "started" | "repaired";

export interface ServiceCommandDependencies {
  platform: NodeJS.Platform;
  acquireAuthority(includeStart: boolean): Promise<ProxyLifecycleAuthority>;
  assertEnvironment(): void;
  assertAuthEnvironment(): void;
  readBackend(): ServiceBackend;
  operations(backend: ServiceBackend): ServiceOps | null;
  armServiceStartDelegation(ensureToken: string): ProxyServiceStartDelegation;
  clearServiceStartDelegation(delegation: ProxyServiceStartDelegation): void;
  prepareStart(): NativeCodexRoutingEscapeResult;
  syncStartedService(lease: ProxyLifecycleLockLease): Promise<ServiceStartedRoutingSyncResult>;
  prepareTermination(): ServiceTerminationRoutingResult;
  diagnose(): ServiceDiagnostic;
  repair(): Promise<void>;
  reportServing(verb: ServingVerb, options?: { port?: number }): Promise<boolean>;
  resolveListenPort(): number;
  statusReport(): Promise<string>;
  schedulerStatusReport(): Promise<string>;
  diagnosticsSummary(): string;
  cleanupTrackedProxy(lease: NonNullable<ReturnType<ProxyLifecycleAuthority["delegatedLease"]>>): Promise<void>;
  stopInstalledService(): boolean;
  uninstallInstalledService(): boolean;
  supervisorInactive(diagnostic: ServiceDiagnostic): boolean;
  probeStopped(canRespawn: boolean): Promise<{ port: number } | null>;
  finalProxyProbe(): Promise<{ port: number } | null>;
  removeState(): void;
  removeToken(): void;
  log(message: string): void;
  error(message: string): void;
  fail(): void;
}

function defaultDependencies(): ServiceCommandDependencies {
  return {
    platform: process.platform,
    acquireAuthority: includeStart => acquireProxyLifecycleAuthority({ includeStart }),
    assertEnvironment: assertServiceEnvironmentMatchesInstall,
    assertAuthEnvironment: assertServiceAuthEnvironment,
    readBackend: readServiceBackend,
    operations: platformOps,
    armServiceStartDelegation: armProxyServiceStartDelegation,
    clearServiceStartDelegation: clearProxyServiceStartDelegation,
    prepareStart: prepareServiceRoutingForStart,
    syncStartedService: syncStartedServiceRouting,
    prepareTermination: prepareServiceRoutingForTermination,
    diagnose: diagnoseService,
    repair: () => repairService(),
    reportServing: (verb, options) => reportServiceServing(verb, options),
    resolveListenPort: resolveServiceListenPort,
    statusReport: () => serviceStatusReport(),
    schedulerStatusReport: () => inspectWindowsSchedulerServiceStatus(),
    diagnosticsSummary: serviceDiagnosticsSummary,
    cleanupTrackedProxy: stopTrackedProxyForServiceCommand,
    stopInstalledService: stopServiceIfInstalled,
    uninstallInstalledService: uninstallServiceIfInstalled,
    supervisorInactive: serviceSupervisorInactiveAfterStop,
    probeStopped: canRespawn => proxyStillLiveAfterStop({ canRespawn }),
    finalProxyProbe: () => findLiveProxy({
      ...SERVICE_STOP_LIVENESS,
      deadlineAt: Date.now() + 7000,
    }),
    removeState: removeServiceInstallState,
    removeToken: () => {
      const path = serviceApiTokenFilePath();
      try { if (existsSync(path)) unlinkSync(path); } catch { /* token cleanup is best effort */ }
    },
    log: console.log,
    error: console.error,
    fail: () => { process.exitCode = 1; },
  };
}

export interface ServiceStartedRoutingSyncResult extends CodexSyncResult {
  activation?: { routing?: { status?: string } };
}

async function syncStartedServiceRouting(
  lease: ProxyLifecycleLockLease,
): Promise<ServiceStartedRoutingSyncResult> {
  const target = await attestLiveManagementProxy();
  if (!target || !target.lifecycleLockLeaseV1) {
    throw new Error("the live service could not prove delegated lifecycle sync support");
  }
  const headers = runningProxyUpdateHeaders();
  for (const [key, value] of Object.entries(proxyLifecycleLockLeaseHeaders(lease))) {
    headers.set(key, value);
  }
  const response = await fetch(`${target.baseUrl}/api/sync`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json().catch(() => null) as ServiceStartedRoutingSyncResult | null;
  if (!response.ok || !body || body.ok !== true || body.status === "refused") {
    throw new Error(body?.message || `service routing sync failed (${response.status})`);
  }
  return body;
}

function refusal(deps: ServiceCommandDependencies, message: string): false {
  deps.error(message);
  deps.fail();
  return false;
}

async function refuseFailedServiceConvergence(
  command: "install" | "repair" | "start",
  deps: ServiceCommandDependencies,
  detail: string,
): Promise<false> {
  try {
    const restored = deps.prepareTermination();
    return refusal(
      deps,
      restored.success
        ? `❌ service ${command} did not converge; Codex remains native/OFF: ${detail}`
        : `❌ service ${command} did not converge, and native Codex routing could not be verified: ${restored.message}`,
    );
  } catch (error) {
    return refusal(
      deps,
      `❌ service ${command} did not converge, and native Codex routing could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function convergeStartedServiceRouting(
  command: "install" | "repair" | "start",
  authority: ProxyLifecycleAuthority,
  deps: ServiceCommandDependencies,
): Promise<boolean> {
  try {
    await authority.acquireStart();
  } catch (error) {
    return refusal(
      deps,
      `❌ service ${command} did not converge; Codex remains native/OFF because routing authority is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    const prepared = deps.prepareStart();
    if (!prepared.success) {
      await refuseFailedServiceConvergence(command, deps, prepared.message);
      return false;
    }
    const lease = authority.delegatedLease();
    if (!lease) {
      await refuseFailedServiceConvergence(
        command,
        deps,
        "lifecycle authority was lost before routing synchronization",
      );
      return false;
    }
    const synced = await deps.syncStartedService(lease);
    const routeStatus = synced.activation?.routing?.status;
    const routingConverged = (synced.status === "applied" && routeStatus === "current")
      || (synced.status === "skipped"
        && synced.skippedReason === "external_provider"
        && routeStatus === "external");
    if (!synced.ok || !routingConverged) {
      await refuseFailedServiceConvergence(
        command,
        deps,
        synced.message || "routing synchronization did not apply",
      );
      return false;
    }
    return true;
  } catch (error) {
    await refuseFailedServiceConvergence(
      command,
      deps,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function prepareServiceManagerMutation(
  command: "install" | "repair" | "start",
  authority: ProxyLifecycleAuthority,
  deps: ServiceCommandDependencies,
): Promise<ProxyServiceStartDelegation | null> {
  try {
    await authority.acquireStart();
  } catch {
    refusal(deps, `❌ service ${command} refused because start authority is unavailable.`);
    return null;
  }
  const native = deps.prepareTermination();
  if (native.success) {
    try {
      // Publish the one-shot child proof while E + S are both held. Keep E
      // across the manager mutation, then release S so exactly one child can
      // consume the marker and bind.
      const delegation = deps.armServiceStartDelegation(authority.ensure.token);
      authority.releaseStart();
      return delegation;
    } catch (error) {
      refusal(
        deps,
        `❌ service ${command} refused because delegated startup could not be authorized: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
  refusal(
    deps,
    `❌ service ${command} refused before manager mutation because native routing could not be verified: ${native.message}`,
  );
  return null;
}

async function launchPreparedServiceChild(
  delegation: ProxyServiceStartDelegation,
  launch: () => void | Promise<void>,
  healthy: () => Promise<boolean>,
  authority: ProxyLifecycleAuthority,
  deps: ServiceCommandDependencies,
): Promise<boolean> {
  try {
    await launch();
    return await healthy();
  } finally {
    // Consumption normally removed the marker before bind. A manager refusal,
    // failed spawn, or health timeout clears the still-pending proof here. S
    // prevents this parent cleanup from racing the child's single consume and
    // remains held for the following convergence or failure release.
    await authority.acquireStart();
    deps.clearServiceStartDelegation(delegation);
  }
}

function validateLifecycleDiagnostic(
  diagnostic: ServiceDiagnostic,
  deps: ServiceCommandDependencies,
  action: "stop" | "uninstall",
): boolean {
  if (diagnostic.registrationState === "indeterminate"
    || diagnostic.supervisorState === "indeterminate") {
    return refusal(deps, `❌ Service ${action} refused because manager state is indeterminate.`);
  }
  if (diagnostic.stale) {
    return refusal(deps, `❌ Service ${action} refused because registration ownership or assets are stale.`);
  }
  return true;
}

/**
 * Shared stop/uninstall quiescence transaction.
 * E remains held throughout. S protects manager stop + tracked cleanup, is released
 * before the bounded Scheduler respawn window, and is reacquired by uninstall's
 * separate deletion gate.
 */
async function quiesceForLifecycleCommand(
  action: "stop" | "uninstall",
  authority: ProxyLifecycleAuthority,
  deps: ServiceCommandDependencies,
): Promise<ServiceTerminationRoutingResult | null> {
  const before = deps.diagnose();
  if (!validateLifecycleDiagnostic(before, deps, action)) return null;
  // Admission precedes routing mutation: an unknown/foreign/conflicting manager must
  // leave the clients' current route untouched.
  const routing = deps.prepareTermination();
  if (!routing.success) {
    refusal(
      deps,
      `❌ service ${action} refused; CodexCommander stayed running because native routing could not be verified: ${routing.message}`,
    );
    return null;
  }
  // This is the fixed admission gate: mutate the manager only after registration is
  // proven present. A failed status query is indeterminate above, never absence.
  if (before.registrationState === "present") {
    try { deps.stopInstalledService(); }
    catch (error) {
      refusal(deps, `❌ Service ${action} could not stop its manager: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  const lease = authority.delegatedLease();
  if (!lease) {
    refusal(deps, "❌ Service lifecycle coordination lost start authority.");
    return null;
  }
  try {
    await deps.cleanupTrackedProxy(lease);
  } catch (error) {
    refusal(deps, `❌ Failed to stop proxy: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  authority.releaseStart();

  const after = deps.diagnose();
  if (!deps.supervisorInactive(after)) {
    refusal(deps, `❌ Service ${action} did not confirm that its supervisor is inactive.`);
    return null;
  }
  let survivor: { port: number } | null;
  try {
    survivor = await deps.probeStopped(
      deps.platform === "win32" && before.backend === "scheduler",
    );
  } catch {
    refusal(deps, `❌ Service ${action} could not verify that the proxy stayed stopped.`);
    return null;
  }
  if (survivor) {
    refusal(deps, `❌ Service ${action} refused: a proxy is still listening on port ${survivor.port}.`);
    return null;
  }
  return routing;
}

export async function runServiceLifecycleCommand(
  args: string[],
  overrides: Partial<ServiceCommandDependencies> = {},
): Promise<void> {
  const deps = { ...defaultDependencies(), ...overrides };
  const parsed = parseServiceArgs(args);
  const command = parsed.sub;
  if (parsed.invalid.length > 0) {
    refusal(deps, `Unknown service option: ${parsed.invalid.join(" ")}`);
    return;
  }
  if (parsed.backend && command !== "install") {
    refusal(deps, "--native/--scheduler apply to `ccx service install` only; other subcommands use the installed backend.");
    return;
  }
  if (parsed.backend === "native" && deps.platform !== "win32") {
    refusal(deps, "--native (WinSW) is Windows-only.");
    return;
  }
  if (command === "repair") {
    deps.assertEnvironment();
    deps.assertAuthEnvironment();
    let authority: ProxyLifecycleAuthority;
    try { authority = await deps.acquireAuthority(false); }
    catch { refusal(deps, "❌ Service lifecycle coordination is unavailable."); return; }
    try {
      const delegation = await prepareServiceManagerMutation("repair", authority, deps);
      if (!delegation) return;
      try {
        const healthy = await launchPreparedServiceChild(
          delegation,
          () => deps.repair(),
          () => deps.reportServing("repaired"),
          authority,
          deps,
        );
        if (!healthy) {
          refusal(deps, "❌ service repair did not become healthy; Codex remains native/OFF.");
          return;
        }
        await convergeStartedServiceRouting("repair", authority, deps);
      } catch (error) {
        refusal(
          deps,
          `❌ service repair failed; Codex remains native/OFF: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally { authority.releaseAll(); }
    return;
  }

  const backend = parsed.backend ?? (deps.platform === "win32" ? deps.readBackend() : "scheduler");
  if (command === "status") {
    if (!(["darwin", "win32", "linux"] as NodeJS.Platform[]).includes(deps.platform)) {
      refusal(deps, "ccx service supports macOS (launchd), Windows (Task Scheduler), and Linux (systemd).");
      return;
    }
    deps.log(deps.platform === "win32" && backend === "scheduler"
      ? await deps.schedulerStatusReport()
      : await deps.statusReport());
    deps.log(`Diagnostics: ${deps.diagnosticsSummary()}`);
    return;
  }

  if (command === "install" || command === "start") {
    const ops = deps.operations(backend);
    if (!ops) {
      refusal(deps, "ccx service supports macOS (launchd), Windows (Task Scheduler), and Linux (systemd).");
      return;
    }
    deps.assertEnvironment();
    if (command === "install") deps.assertAuthEnvironment();
    let authority: ProxyLifecycleAuthority;
    try { authority = await deps.acquireAuthority(false); }
    catch { refusal(deps, "❌ Service lifecycle coordination is unavailable."); return; }
    try {
      const delegation = await prepareServiceManagerMutation(command, authority, deps);
      if (!delegation) return;
      try {
        if (command === "install") {
          const healthy = await launchPreparedServiceChild(
            delegation,
            () => ops.install(),
            () => deps.reportServing("installed", { port: deps.resolveListenPort() }),
            authority,
            deps,
          );
          if (!healthy) {
            refusal(deps, "❌ service install did not become healthy; Codex remains native/OFF.");
            return;
          }
          if (!await convergeStartedServiceRouting("install", authority, deps)) return;
          if (deps.platform === "linux") deps.log("   For auto-start on boot: loginctl enable-linger $USER");
        } else {
          const healthy = await launchPreparedServiceChild(
            delegation,
            () => ops.start(),
            () => deps.reportServing("started"),
            authority,
            deps,
          );
          if (!healthy) {
            refusal(deps, "❌ service start did not become healthy; Codex remains native/OFF.");
            return;
          }
          await convergeStartedServiceRouting("start", authority, deps);
        }
      } catch (error) {
        refusal(
          deps,
          `❌ service ${command} failed; Codex remains native/OFF: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally { authority.releaseAll(); }
    return;
  }

  if (command === "stop" || command === "uninstall" || command === "remove") {
    const action = command === "stop" ? "stop" : "uninstall";
    deps.assertEnvironment();
    let authority: ProxyLifecycleAuthority;
    try { authority = await deps.acquireAuthority(true); }
    catch { refusal(deps, "❌ Service lifecycle coordination is unavailable."); return; }
    try {
      const routing = await quiesceForLifecycleCommand(action, authority, deps);
      if (!routing) return;
      if (action === "stop") {
        deps.log("✅ service stopped + native client routing restored.");
        if (routing.grok?.changed) deps.log(`↩️  ${routing.grok.message}`);
        return;
      }
      if (routing.grok?.changed) deps.log(`↩️  ${routing.grok.message}`);

      // Deletion gate is intentionally visible: hold E, reacquire S, then prove no
      // replacement appeared before deleting registration/assets.
      try { await authority.acquireStart(); }
      catch { refusal(deps, "❌ Service lifecycle coordination is unavailable."); return; }
      let restarted: { port: number } | null;
      try { restarted = await deps.finalProxyProbe(); }
      catch { refusal(deps, "❌ Service uninstall refused because final proxy state is indeterminate."); return; }
      if (restarted) { refusal(deps, "❌ Service uninstall refused because a proxy restarted."); return; }
      const deletionDiagnostic = deps.diagnose();
      if (!validateLifecycleDiagnostic(deletionDiagnostic, deps, "uninstall")) return;
      if (!deps.supervisorInactive(deletionDiagnostic)) {
        refusal(deps, "❌ Service uninstall refused because its supervisor became active.");
        return;
      }
      try { deps.uninstallInstalledService(); }
      catch (error) {
        refusal(deps, `❌ Service uninstall failed: ${error instanceof Error ? error.message : String(error)}`);
        deps.error("The service may still be installed. Check with 'ccx service status' or remove manually.");
        return;
      }
      deps.removeState();
      deps.removeToken();
      deps.log("✅ service uninstalled.");
    } finally { authority.releaseAll(); }
    return;
  }

  refusal(
    deps,
    "Usage: ccx service [install|repair|start|stop|status|uninstall|remove] [--native|--scheduler]",
  );
}

export async function serviceCommand(...args: (string | undefined)[]): Promise<void> {
  await runServiceLifecycleCommand(args.filter((arg): arg is string => Boolean(arg)));
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codexAutoStartEnabled,
  loadConfig,
  readPid,
  readPidFileValue,
  readRuntimePort,
  removePid,
  removePidIfValueIs,
  removeRuntimePort,
  removeRuntimePortIfPidIs,
} from "../config";
import { restoreNativeCodexRoutingEscape } from "../codex/native-routing-escape";
import {
  currentExternalCodexModelProvider,
  prepareExplicitCodexRoutingStart,
  restoreNativeCodexRoutingForStop,
  type ExplicitCodexRoutingStartOptions,
} from "../codex/routing-transition";
import { hasRoutedCapableProviders } from "../codex/catalog/sync";
import { codexIntegrationEnabled, setIntegrationEnabled } from "../codex/desired-state";
import { reconcileJournal } from "../codex/journal";
import { stripGrokConfig } from "../grok/inject";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { stopProxy } from "../lib/process-control";
import {
  diagnoseService,
  isServiceOwnershipError,
  serviceStartableFromTray,
  startServiceIfInstalled,
  stopServiceIfInstalled,
  proxyStillLiveAfterStop,
  serviceSupervisorInactiveAfterStop,
} from "../service";
import {
  findLiveProxy,
  probeHostname,
  probeReadiness,
  type LiveProxy,
} from "../server/proxy-liveness";
import {
  acquireProxyLifecycleAuthority,
  type AcquireProxyLifecycleAuthorityOptions,
  type ProxyLifecycleAuthority,
} from "../server/proxy-lifecycle-authority";
import {
  PROXY_DELEGATED_START_ENV,
  proxyLifecycleLockLeaseHeaders,
  type ProxyLifecycleLockLease,
} from "../server/proxy-lifecycle-protocol";
import {
  armProxyServiceStartDelegation,
  clearProxyServiceStartDelegation,
  type ProxyServiceStartDelegation,
} from "../server/proxy-start-lock";
import { injectSystemEnv, revertSystemEnv } from "../server/system-env";
import type { CodexCommanderConfig } from "../types";
import { RuntimeApiError, runtimeRequest } from "./runtime-api";

export type ProxyLifecycleAction =
  | "status"
  | "ensure"
  | "start"
  | "stop"
  | "restart"
  | "restore-native"
  | "restore-back";
export type ProxyLifecycleState = "running" | "stopped" | "disabled" | "blocked" | "failed";

export interface ProxyLifecycleResult {
  schemaVersion: 1;
  action: ProxyLifecycleAction;
  ok: boolean;
  state: ProxyLifecycleState;
  changed: boolean;
  pid: number | null;
  port: number | null;
  message: string;
  /** Additive catalog-apply fields consumed by the native companion. */
  catalogUpdated?: boolean;
  codexRestartRequired?: boolean;
  staleWorkerCount?: number;
  stoppedWorkerCount?: number;
  survivingWorkerCount?: number;
  /** Restore Native reports config bytes separately from the durable switch. */
  configChanged?: boolean;
  desiredChanged?: boolean;
  routingAction?: "owned-fields-stripped" | "external-provider-preserved" | "unchanged" | "failed";
  errorCode?:
    | "AUTOSTART_DISABLED"
    | "SERVICE_BLOCKED"
    | "START_FAILED"
    | "STOP_FAILED"
    | "SYNC_FAILED"
    | "ROUTING_RECOVERY_REQUIRED"
    | "CODEX_RESTART_REQUIRED";
}

export type ProxyStartupReadiness = "ready" | "failed" | "timeout";

export interface ProxyCatalogSyncOutcome {
  status?: "applied" | "skipped" | "refused" | "failed";
  ok: boolean;
  skippedReason?: "desired_disabled" | "external_provider";
  message?: string;
  warning?: string;
  catalogQuality?: "live" | "retained" | "native-only";
  catalogWritten?: boolean;
  cacheSynced?: boolean;
  staleAppServerHint?: string;
  catalogState?: {
    state?: "fresh" | "stale" | "not_running" | "unknown";
    processes?: Array<{ pid?: number; startedAtMs?: number | null }>;
    catalogMtimeMs?: number | null;
  };
  lifecycleErrorCode?: "SYNC_FAILED";
}

export interface ProxyLifecycleLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const quietLogger: ProxyLifecycleLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface SpawnDetachedProxyOptions {
  port?: number;
  env?: NodeJS.ProcessEnv;
  entry?: string;
  spawnFn?: typeof spawn;
}

export interface ExplicitProxyStartIo {
  reconcile?: () => boolean | void;
  retireExplicitJournal?: ExplicitCodexRoutingStartOptions["retireExplicitJournal"];
  retireExternalJournal?: (provider: string) => boolean;
  journalPending?: () => boolean;
  externalProvider?: () => string | null;
  desiredEnabled?: ExplicitCodexRoutingStartOptions["desiredEnabled"];
  classifyActiveJournal?: ExplicitCodexRoutingStartOptions["classifyActiveJournal"];
  setEnabled?: typeof setIntegrationEnabled;
}

export interface EnsureProxyLifecycleIo extends ExplicitProxyStartIo {
  findLive?: () => Promise<LiveProxy | null>;
  loadConfig?: () => CodexCommanderConfig;
  diagnoseService?: typeof diagnoseService;
  startService?: () => boolean;
  armServiceStartDelegation?: (ensureToken: string) => ProxyServiceStartDelegation;
  clearServiceStartDelegation?: (delegation: ProxyServiceStartDelegation) => void;
  spawnStart?: (port?: number, env?: NodeJS.ProcessEnv) => Promise<void>;
  waitForProxy?: (timeoutMs?: number) => Promise<LiveProxy | null>;
  waitForReady?: (live: LiveProxy, timeoutMs?: number) => Promise<ProxyStartupReadiness>;
  syncLive?: (
    live: LiveProxy,
    config: CodexCommanderConfig,
    logger: ProxyLifecycleLogger,
    lifecycleLease: ProxyLifecycleLockLease,
  ) => Promise<ProxyCatalogSyncOutcome>;
  /** Explicit Start rollback when no owned endpoint became live. */
  restoreNative?: typeof restoreNativeCodexRoutingForStop;
  ensureCompanion?: () => Promise<boolean>;
  acquireAuthority?: ProxyLifecycleAuthorityAcquirer;
}

export interface EnsureProxyLifecycleOptions {
  action?: "ensure" | "start" | "restart";
  honorAutoStart?: boolean;
  ensureCompanion?: boolean;
  preferService?: boolean;
  startEnv?: NodeJS.ProcessEnv;
  waitTimeoutMs?: number;
  logger?: ProxyLifecycleLogger;
  io?: EnsureProxyLifecycleIo;
}

export interface StopProxyLifecycleOptions {
  action?: "stop" | "restart";
  logger?: ProxyLifecycleLogger;
  io?: StopProxyLifecycleIo;
}

export interface StopProxyLifecycleIo {
  diagnoseService?: typeof diagnoseService;
  stopService?: typeof stopServiceIfInstalled;
  restoreNative?: typeof restoreNativeCodexRoutingForStop;
  stripGrok?: typeof stripGrokConfig;
  findLive?: () => Promise<LiveProxy | null>;
  stopProxy?: typeof stopProxy;
  acquireAuthority?: ProxyLifecycleAuthorityAcquirer;
  findSurvivor?: () => Promise<{ port: number } | null>;
  verifyServiceStopped?: () => boolean;
  readPid?: typeof readPid;
  readPidFileValue?: typeof readPidFileValue;
  readRuntimePort?: typeof readRuntimePort;
  removePid?: typeof removePid;
  removeRuntimePort?: typeof removeRuntimePort;
  removePidIfValueIs?: typeof removePidIfValueIs;
  removeRuntimePortIfPidIs?: typeof removeRuntimePortIfPidIs;
}

export interface RoutingLifecycleIo extends ExplicitProxyStartIo {
  findLive?: () => Promise<LiveProxy | null>;
  escapeNative?: typeof restoreNativeCodexRoutingEscape;
  syncModels?: (
    port: number,
    lifecycleLease: ProxyLifecycleLockLease,
  ) => Promise<ProxyCatalogSyncOutcome>;
  acquireAuthority?: ProxyLifecycleAuthorityAcquirer;
}

/** Shared by direct CLI, tray Start, Restore Back, restart, and service parents. */
export const prepareExplicitProxyStart = prepareExplicitCodexRoutingStart;

export type ProxyLifecycleAuthorityAcquirer = (
  options?: AcquireProxyLifecycleAuthorityOptions,
) => Promise<ProxyLifecycleAuthority>;

export function prepareExplicitProxyStartWithIo(
  io: ExplicitProxyStartIo,
  protectedLiveOwnerPid?: number,
): ReturnType<typeof prepareExplicitCodexRoutingStart> {
  return prepareExplicitProxyStart({
    setEnabled: io.setEnabled,
    reconcile: io.reconcile,
    retireExplicitJournal: io.retireExplicitJournal,
    retireExternalJournal: io.retireExternalJournal,
    journalPending: io.journalPending,
    externalProvider: io.externalProvider,
    desiredEnabled: io.desiredEnabled,
    classifyActiveJournal: io.classifyActiveJournal,
    protectedLiveOwnerPid,
  });
}

async function failExplicitProxyStartWithoutLive(
  action: "ensure" | "start" | "restart",
  io: EnsureProxyLifecycleIo,
  authority: ProxyLifecycleAuthority,
  preparedChanged: boolean,
  failure: {
    state: Extract<ProxyLifecycleState, "disabled" | "blocked" | "failed">;
    message: string;
    errorCode: Extract<
      NonNullable<ProxyLifecycleResult["errorCode"]>,
      "AUTOSTART_DISABLED" | "SERVICE_BLOCKED" | "START_FAILED"
    >;
  },
): Promise<ProxyLifecycleResult> {
  if (action === "ensure") {
    return lifecycleResult(action, failure.state, {
      ok: failure.errorCode === "AUTOSTART_DISABLED",
      changed: preparedChanged,
      message: failure.message,
      errorCode: failure.errorCode,
    });
  }

  try {
    // A delegated child can release S once it has bound. Reacquire S under the
    // retained E lease before publishing the compensating OFF/native state.
    await authority.acquireStart();
    const restored = (io.restoreNative ?? restoreNativeCodexRoutingForStop)();
    return lifecycleResult(action, failure.state, {
      ok: false,
      changed: preparedChanged || restored.changed,
      message: restored.success
        ? `${failure.message} Native Codex routing was restored.`
        : `${failure.message} Native Codex routing rollback failed: ${restored.message}`,
      errorCode: failure.errorCode,
    });
  } catch (error) {
    return lifecycleResult(action, failure.state, {
      ok: false,
      changed: preparedChanged,
      message: `${failure.message} Native Codex routing rollback failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      errorCode: failure.errorCode,
    });
  }
}

/**
 * Locate a duplicate for `ccx start`. Runtime records still identify this state
 * home first; only the recordless fallback probe follows an explicit --port.
 */
export function findLiveProxyForStart(
  requestedPort: number | undefined,
  config: Pick<CodexCommanderConfig, "port" | "hostname">,
  findLive: typeof findLiveProxy = findLiveProxy,
): Promise<LiveProxy | null> {
  return findLive(requestedPort === undefined ? {} : {
    configFn: () => ({ port: requestedPort, hostname: config.hostname }),
  });
}

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

function lifecycleResult(
  action: ProxyLifecycleAction,
  state: ProxyLifecycleState,
  options: {
    ok: boolean;
    changed?: boolean;
    live?: LiveProxy | null;
    message: string;
    errorCode?: ProxyLifecycleResult["errorCode"];
    catalogUpdated?: boolean;
    codexRestartRequired?: boolean;
    staleWorkerCount?: number;
    stoppedWorkerCount?: number;
    survivingWorkerCount?: number;
  },
): ProxyLifecycleResult {
  return {
    schemaVersion: 1,
    action,
    ok: options.ok,
    state,
    changed: options.changed ?? false,
    pid: options.live?.pid ?? null,
    port: options.live?.port ?? null,
    message: options.message.slice(0, 240),
    ...(options.catalogUpdated !== undefined ? { catalogUpdated: options.catalogUpdated } : {}),
    ...(options.codexRestartRequired !== undefined
      ? { codexRestartRequired: options.codexRestartRequired }
      : {}),
    ...(options.staleWorkerCount !== undefined ? { staleWorkerCount: options.staleWorkerCount } : {}),
    ...(options.stoppedWorkerCount !== undefined ? { stoppedWorkerCount: options.stoppedWorkerCount } : {}),
    ...(options.survivingWorkerCount !== undefined ? { survivingWorkerCount: options.survivingWorkerCount } : {}),
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
  };
}

export function proxyStartArgv(port?: number, entry = process.argv[1]): string[] {
  if (!entry) throw new Error("CodexCommander CLI entry is unavailable");
  const argv = [entry, "start"];
  if (typeof port === "number" && Number.isSafeInteger(port) && port > 0 && port <= 65535) {
    argv.push("--port", String(port));
  }
  return argv;
}

/** Spawn the canonical foreground start command and resolve only after OS spawn succeeds. */
export function spawnDetachedProxyStart(options: SpawnDetachedProxyOptions = {}): Promise<void> {
  const spawnFn = options.spawnFn ?? spawn;
  const env = options.env ?? { ...process.env, [PROXY_DELEGATED_START_ENV]: "1" };
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(process.execPath, proxyStartArgv(options.port, options.entry), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: withProcessRuntimeProvenance(env),
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.once("error", error => finish(() => reject(error)));
    child.once("spawn", () => finish(() => {
      child.unref();
      resolve();
    }));
  });
}

export async function waitForProxy(timeoutMs = 12_000): Promise<LiveProxy | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const live = await findLiveProxy();
    if (live) return live;
    await Bun.sleep(150);
  }
  return null;
}

/**
 * Let the proxy-owned startup convergence finish before asking it to converge
 * again through the management plane.
 */
export async function waitForProxyReadiness(
  live: LiveProxy,
  timeoutMs = 20_000,
): Promise<ProxyStartupReadiness> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const result = await probeReadiness(live.port, {
      ...(live.hostname ? { hostname: live.hostname } : {}),
      ...(live.pid ? { expectedPid: live.pid } : {}),
    });
    if (result?.status === "ready") return "ready";
    if (result?.status === "failed") return "failed";
    await Bun.sleep(200);
  }
  return "timeout";
}

/** Fixed LaunchServices argv for the repo-built companion (or a registered release app). */
const MACOS_COMPANION_BUNDLE_ID = "com.codexcommander.menubar";
export const MACOS_COMPANION_PASSIVE_LAUNCH_ARG = "--ccx-passive-launch";

export function macOSCompanionOpenArguments(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    appPath?: string;
    exists?: (path: string) => boolean;
  } = {},
): string[] | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "darwin"
    || env.CCX_SERVICE === "1"
    || env[PROXY_DELEGATED_START_ENV] === "1"
    || env.CCX_DISABLE_COMPANION === "1") {
    return null;
  }
  const exists = options.exists ?? existsSync;
  if (options.appPath) {
    return exists(options.appPath)
      ? ["-g", options.appPath, "--args", MACOS_COMPANION_PASSIVE_LAUNCH_ARG]
      : ["-g", "-b", MACOS_COMPANION_BUNDLE_ID, "--args", MACOS_COMPANION_PASSIVE_LAUNCH_ARG];
  }
  const app = join(repoRoot, "dist", "macos", "CodexCommander.app");
  if (exists(app)) return ["-g", app, "--args", MACOS_COMPANION_PASSIVE_LAUNCH_ARG];
  return ["-g", "-b", MACOS_COMPANION_BUNDLE_ID, "--args", MACOS_COMPANION_PASSIVE_LAUNCH_ARG];
}

/** Best-effort source/release companion launch. Never starts from service children. */
export function ensureMacOSCompanionApp(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    appPath?: string;
    spawnFn?: typeof spawn;
  } = {},
): Promise<boolean> {
  const args = macOSCompanionOpenArguments(options);
  if (!args) return Promise.resolve(false);
  const env = options.env ?? process.env;
  const spawnFn = options.spawnFn ?? spawn;
  return new Promise<boolean>(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn("/usr/bin/open", args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (value) child.unref();
      resolve(value);
    };
    child.once("error", () => finish(false));
    child.once("spawn", () => finish(true));
  });
}

async function syncLiveProxy(
  live: LiveProxy,
  config: CodexCommanderConfig,
  logger: ProxyLifecycleLogger,
  lifecycleLease?: ProxyLifecycleLockLease,
): Promise<ProxyCatalogSyncOutcome> {
  let catalogSync: ProxyCatalogSyncOutcome;
  try {
    catalogSync = await runtimeRequest<ProxyCatalogSyncOutcome>("/api/sync", {
      method: "POST",
      ...(lifecycleLease ? { headers: proxyLifecycleLockLeaseHeaders(lifecycleLease) } : {}),
      signal: AbortSignal.timeout(45_000),
    }, {
      baseUrl: `http://${probeHostname(live.hostname)}:${live.port}`,
    });
  } catch (error) {
    const body = error instanceof RuntimeApiError && error.body && typeof error.body === "object"
      ? error.body as Partial<ProxyCatalogSyncOutcome>
      : null;
    catalogSync = {
      status: body?.status ?? "failed",
      ok: false,
      message: typeof body?.message === "string" && body.message
        ? body.message
        : "CodexCommander is running, but its Codex model catalog did not synchronize.",
      ...(typeof body?.warning === "string" ? { warning: body.warning } : {}),
      lifecycleErrorCode: "SYNC_FAILED",
    };
    logger.warn(catalogSync.message ?? "Model catalog sync failed.");
  }
  await injectSystemEnv(live.port, config).catch(() => {});
  try {
    const { syncGrokConfig } = await import("../grok/sync");
    const result = await syncGrokConfig(
      live.port,
      config,
      live.hostname ? { hostname: live.hostname } : {},
    );
    if (result.changed) logger.info("   + Grok Build config updated (~/.grok/config.toml)");
    else if (!result.ok) logger.warn(result.message);
  } catch (error) {
    logger.warn(`Grok Build config sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return catalogSync;
}

function isCurrentCatalogState(value: ProxyCatalogSyncOutcome["catalogState"]): boolean {
  if (!value || !["fresh", "stale", "not_running", "unknown"].includes(value.state ?? "")) return false;
  if (!Array.isArray(value.processes)) return false;
  if (value.catalogMtimeMs !== null && (typeof value.catalogMtimeMs !== "number" || !Number.isFinite(value.catalogMtimeMs))) {
    return false;
  }
  return value.processes.every(process => (
    typeof process.pid === "number"
    && Number.isInteger(process.pid)
    && process.pid > 0
    && (process.startedAtMs === null
      || (typeof process.startedAtMs === "number" && Number.isFinite(process.startedAtMs)))
  ));
}

function catalogSyncFailure(
  result: ProxyCatalogSyncOutcome,
  config: Pick<CodexCommanderConfig, "providers">,
): {
  errorCode: "SYNC_FAILED";
  message: string;
} | null {
  if (result.lifecycleErrorCode) {
    return {
      errorCode: result.lifecycleErrorCode,
      message: result.message ?? "CodexCommander model catalog synchronization failed.",
    };
  }
  if (result.ok && !isCurrentCatalogState(result.catalogState)) {
    return {
      errorCode: "SYNC_FAILED",
      message: "The running CodexCommander proxy returned an invalid catalog state. Restart it and retry.",
    };
  }
  const intentionalNativeOnly = result.status === "skipped"
    && (result.skippedReason === "desired_disabled" || result.skippedReason === "external_provider")
    && result.ok;
  if (intentionalNativeOnly) return null;
  const missingConfiguredRoutes = result.catalogQuality === "native-only"
    && hasRoutedCapableProviders(config);
  if (
    !result.ok
    || result.status === "refused"
    || (result.warning !== undefined && result.warning !== "")
    || missingConfiguredRoutes
  ) {
    return {
      errorCode: "SYNC_FAILED",
      message: result.message
        ?? "CodexCommander is running, but its Codex model catalog did not converge. Run `ccx sync` and retry.",
    };
  }
  return null;
}

interface CatalogSyncNotice {
  errorCode: "CODEX_RESTART_REQUIRED";
  message: string;
  catalogUpdated: boolean;
  codexRestartRequired: true;
  staleWorkerCount: number;
  stoppedWorkerCount: 0;
  survivingWorkerCount: number;
}

function staleCatalogWorkerCount(result: ProxyCatalogSyncOutcome): number {
  const status = result.catalogState;
  if (status?.state !== "stale" || !Array.isArray(status.processes)) return 0;
  const mtime = status.catalogMtimeMs;
  if (typeof mtime !== "number" || !Number.isFinite(mtime)) return 0;
  return status.processes.filter(process => (
    typeof process.startedAtMs === "number"
    && Number.isFinite(process.startedAtMs)
    && process.startedAtMs <= mtime
  )).length;
}

/** A stale Codex worker roster is actionable, but the CodexCommander proxy is healthy. */
function catalogSyncNotice(result: ProxyCatalogSyncOutcome): CatalogSyncNotice | null {
  const intentionalNativeOnly = result.status === "skipped"
    && (result.skippedReason === "desired_disabled" || result.skippedReason === "external_provider")
    && result.ok;
  if (intentionalNativeOnly) return null;
  const updateReady = result.catalogState?.state === "stale";
  if (!updateReady) return null;
  const staleWorkerCount = staleCatalogWorkerCount(result);
  return {
    errorCode: "CODEX_RESTART_REQUIRED",
    message: "Agent catalog update ready. Codex workers are using an older model roster.",
    catalogUpdated: result.catalogWritten === true || result.cacheSynced === true,
    codexRestartRequired: true,
    staleWorkerCount,
    stoppedWorkerCount: 0,
    survivingWorkerCount: staleWorkerCount,
  };
}

export async function proxyLifecycleStatus(
  action: ProxyLifecycleAction = "status",
): Promise<ProxyLifecycleResult> {
  const live = await findLiveProxy();
  return live
    ? lifecycleResult(action, "running", {
      ok: true,
      live,
      message: "CodexCommander proxy is running.",
    })
    : lifecycleResult(action, "stopped", {
      ok: true,
      message: "CodexCommander proxy is stopped.",
    });
}

/**
 * Idempotently converge on one identity-checked proxy. Detached start contenders may
 * overlap, but every foreground child serializes bind/publication through proxy-start.lock.
 */
export async function ensureProxyLifecycle(
  options: EnsureProxyLifecycleOptions = {},
): Promise<ProxyLifecycleResult> {
  const action = options.action ?? "ensure";
  const io = options.io ?? {};
  let authority: ProxyLifecycleAuthority;
  try {
    authority = await (io.acquireAuthority ?? acquireProxyLifecycleAuthority)();
  } catch {
    return lifecycleResult(action, "blocked", {
      ok: false,
      message: "CodexCommander lifecycle coordination is unavailable.",
      errorCode: "START_FAILED",
    });
  }
  let result: ProxyLifecycleResult;
  try {
    result = await ensureProxyLifecycleUnderLock(options, authority);
  } finally {
    authority.releaseAll();
  }
  if (result.state === "running" && options.ensureCompanion !== false) {
    await (io.ensureCompanion ?? ensureMacOSCompanionApp)().catch(() => false);
  }
  return result;
}

/** Caller holds proxy-ensure.lock across preparation, spawn, readiness and sync. */
async function ensureProxyLifecycleUnderLock(
  options: EnsureProxyLifecycleOptions = {},
  authority: ProxyLifecycleAuthority,
): Promise<ProxyLifecycleResult> {
  const action = options.action ?? "ensure";
  const logger = options.logger ?? quietLogger;
  const io = options.io ?? {};
  const findLive = io.findLive ?? findLiveProxy;
  let config = (io.loadConfig ?? loadConfig)();
  let preparedChanged = false;
  // Probe before mutating durable intent. Only this home's protected runtime
  // record may authorize retirement of a journal whose owner is still alive.
  let live = action === "start" ? await findLive() : null;
  if (action === "start" && live && (live.source !== "runtime" || live.pid === null)) {
    return lifecycleResult(action, "blocked", {
      ok: false,
      live,
      message: "A recordless or different-home proxy cannot authorize Codex routing changes.",
      errorCode: "START_FAILED",
    });
  }
  if (action === "start") {
    const prepared = prepareExplicitProxyStartWithIo(io, live?.pid ?? undefined);
    if (!prepared.success) {
      return lifecycleResult(action, "blocked", {
        ok: false,
        changed: prepared.changed,
        message: prepared.message,
        errorCode: "START_FAILED",
      });
    }
    preparedChanged = prepared.changed;
    try {
      config = (io.loadConfig ?? loadConfig)();
    } catch {
      return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
        state: "failed",
        message: "CodexCommander configuration could not be reloaded after enabling routing.",
        errorCode: "START_FAILED",
      });
    }
  }
  // Automatic ensure must preserve an intentional native/OFF state, including its
  // inert stale journal. Explicit Start has just cleaned that residue and enabled
  // integration, so it may reconcile even when the pre-mutation snapshot was OFF.
  if (action !== "start" && codexIntegrationEnabled(config)) {
    if (io.reconcile) io.reconcile();
    else if (!currentExternalCodexModelProvider()) reconcileJournal();
  }

  if (!live) {
    try {
      live = await findLive();
    } catch {
      return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
        state: "failed",
        message: "CodexCommander could not verify proxy liveness after enabling routing.",
        errorCode: "START_FAILED",
      });
    }
  }
  if (action === "start" && live && (live.source !== "runtime" || live.pid === null)) {
    return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
      state: "blocked",
      message: "A recordless or different-home proxy cannot authorize Codex routing changes.",
      errorCode: "START_FAILED",
    });
  }
  let startedHere = false;
  let serviceStartDelegation: ProxyServiceStartDelegation | undefined;
  let syncProblem: ReturnType<typeof catalogSyncFailure> = null;
  let syncNotice: ReturnType<typeof catalogSyncNotice> = null;
  if (!live && options.honorAutoStart && !codexAutoStartEnabled(config)) {
    return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
      state: "disabled",
      message: "Codex autostart is disabled.",
      errorCode: "AUTOSTART_DISABLED",
    });
  }

  // Another ensure may have started or stopped the proxy while this caller waited.
  if (!live) {
    try {
      live = await findLive();
    } catch {
      return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
        state: "failed",
        message: "CodexCommander could not verify proxy liveness after enabling routing.",
        errorCode: "START_FAILED",
      });
    }
  }
  if (action === "start" && live && (live.source !== "runtime" || live.pid === null)) {
    return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
      state: "blocked",
      message: "A recordless or different-home proxy cannot authorize Codex routing changes.",
      errorCode: "START_FAILED",
    });
  }
    if (!live) {
      const diagnose = io.diagnoseService ?? diagnoseService;
      let service: ReturnType<typeof diagnoseService> | null = null;
      if (options.preferService !== false) {
        try {
          service = diagnose();
        } catch {
          return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
            state: "blocked",
            message: "Installed background service could not be verified safely.",
            errorCode: "SERVICE_BLOCKED",
          });
        }
      }
      if (service?.installed && !serviceStartableFromTray(service)) {
        return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
          state: "blocked",
          message: "Installed background service needs repair before CodexCommander can start.",
          errorCode: "SERVICE_BLOCKED",
        });
      }
      try {
        if (service?.installed) {
          await authority.acquireStart();
          serviceStartDelegation = (
            io.armServiceStartDelegation ?? armProxyServiceStartDelegation
          )(authority.ensure.token);
          authority.releaseStart();
          const started = (io.startService ?? startServiceIfInstalled)();
          if (!started) throw new Error("Installed service could not be started");
        } else {
          const configuredPort = config.port;
          const port = typeof configuredPort === "number" && configuredPort > 0
            ? configuredPort
            : 10100;
          const spawnStart = io.spawnStart
            ?? ((selectedPort, env) => spawnDetachedProxyStart({ port: selectedPort, env }));
          await spawnStart(port, options.startEnv ?? {
            ...process.env,
            [PROXY_DELEGATED_START_ENV]: "1",
          });
        }
      } catch (error) {
        if (serviceStartDelegation) {
          try {
            await authority.acquireStart();
            (io.clearServiceStartDelegation ?? clearProxyServiceStartDelegation)(
              serviceStartDelegation,
            );
          } catch {
            // releaseAll below revokes E and any unconsumed marker with it.
          }
          serviceStartDelegation = undefined;
        }
        if (service?.installed || isServiceOwnershipError(error)) {
          return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
            state: "blocked",
            message: "Installed background service refused to start safely.",
            errorCode: "SERVICE_BLOCKED",
          });
        }
        return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
          state: "failed",
          message: "CodexCommander proxy could not be started.",
          errorCode: "START_FAILED",
        });
      }

      try {
        live = await (io.waitForProxy ?? waitForProxy)(options.waitTimeoutMs ?? 20_000);
      } catch {
        live = null;
      } finally {
        if (serviceStartDelegation) {
          try {
            await authority.acquireStart();
            (io.clearServiceStartDelegation ?? clearProxyServiceStartDelegation)(
              serviceStartDelegation,
            );
          } catch {
            // The subsequent authority path fails closed; releaseAll revokes E.
          }
          serviceStartDelegation = undefined;
        }
      }
      if (!live) {
        return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
          state: "failed",
          message: "CodexCommander proxy did not become healthy after starting.",
          errorCode: "START_FAILED",
        });
      }
      if (live.source !== "runtime" || live.pid === null) {
        return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
          state: "blocked",
          message: "The started proxy could not be verified as owned by this runtime.",
          errorCode: "START_FAILED",
        });
      }
      startedHere = true;
    }
    if (startedHere) {
      const readiness = await (io.waitForReady ?? waitForProxyReadiness)(
        live,
        Math.min(options.waitTimeoutMs ?? 20_000, 20_000),
      );
      if (readiness !== "ready") {
        logger.warn(`Startup catalog readiness was ${readiness}; retrying through the live proxy.`);
      }
    }
  await authority.acquireStart();
  const lifecycleLease = authority.delegatedLease();
  if (!lifecycleLease) {
    return await failExplicitProxyStartWithoutLive(action, io, authority, preparedChanged, {
      state: "blocked",
      message: "CodexCommander lifecycle coordination was lost before routing synchronization.",
      errorCode: "START_FAILED",
    });
  }
  const syncResult = await (io.syncLive ?? syncLiveProxy)(
    live,
    config,
    logger,
    lifecycleLease,
  );
  syncProblem = catalogSyncFailure(syncResult, config);
  syncNotice = catalogSyncNotice(syncResult);
  if (syncProblem) {
    return lifecycleResult(action, "running", {
      ok: false,
      changed: preparedChanged || startedHere,
      live,
      message: syncProblem.message,
      errorCode: syncProblem.errorCode,
    });
  }
  if (syncNotice) {
    return lifecycleResult(action, "running", {
      ok: true,
      changed: preparedChanged || startedHere,
      live,
      message: syncNotice.message,
      errorCode: syncNotice.errorCode,
      catalogUpdated: syncNotice.catalogUpdated,
      codexRestartRequired: syncNotice.codexRestartRequired,
      staleWorkerCount: syncNotice.staleWorkerCount,
      stoppedWorkerCount: syncNotice.stoppedWorkerCount,
      survivingWorkerCount: syncNotice.survivingWorkerCount,
    });
  }
  return lifecycleResult(action, "running", {
    ok: true,
    changed: preparedChanged || startedHere,
    live,
    message: startedHere ? "CodexCommander proxy started." : "CodexCommander proxy is already running.",
  });
}

interface ServiceStopResult {
  stopped: boolean;
  blocked: boolean;
  failed: boolean;
}

function admitLifecycleServiceStop(
  logger: ProxyLifecycleLogger,
  diagnose: typeof diagnoseService = diagnoseService,
): {
  installed: boolean;
  blocked: boolean;
} {
  try {
    const service = diagnose();
    if (service.registrationState === "indeterminate"
      || service.supervisorState === "indeterminate"
      || service.conflict
      || service.stale) {
      logger.error("Installed background service could not be verified safely.");
      return { installed: service.installed, blocked: true };
    }
    return { installed: service.registrationState === "present", blocked: false };
  } catch {
    logger.error("Installed background service could not be verified safely.");
    return { installed: false, blocked: true };
  }
}

function stopLifecycleService(
  logger: ProxyLifecycleLogger,
  installed: boolean,
  stopService: typeof stopServiceIfInstalled = stopServiceIfInstalled,
): ServiceStopResult {
  try {
    const stopped = stopService();
    if (installed && !stopped) {
      logger.error("Installed background service did not confirm that it stopped.");
      return { stopped: false, blocked: true, failed: true };
    }
    if (stopped) logger.info("🛑 Service manager stopped (won't respawn).");
    return { stopped, blocked: false, failed: false };
  } catch (error) {
    if (isServiceOwnershipError(error)) {
      logger.error(error.message);
      return { stopped: false, blocked: true, failed: true };
    }
    if (installed) {
      logger.error("Installed background service refused to stop safely.");
      return { stopped: false, blocked: true, failed: true };
    }
    logger.warn(`Service manager stop failed: ${error instanceof Error ? error.message : String(error)}`);
    return { stopped: false, blocked: false, failed: true };
  }
}

interface ManagedStateRestoreResult {
  ok: boolean;
  changed: boolean;
  grokMessage: string;
}

function restoreManagedClientState(
  logger: ProxyLifecycleLogger,
  io: Pick<StopProxyLifecycleIo, "restoreNative" | "stripGrok"> = {},
): ManagedStateRestoreResult {
  let ok = true;
  let changed = false;
  try {
    const restore = (io.restoreNative ?? restoreNativeCodexRoutingForStop)();
    changed ||= restore.changed;
    if (restore.success) logger.info(`↩️  ${restore.message}`);
    else {
      logger.warn(restore.message);
      return {
        ok: false,
        changed,
        grokMessage: "Grok Build config unchanged.",
      };
    }
  } catch (error) {
    logger.warn(`Native Codex restore failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      ok: false,
      changed,
      grokMessage: "Grok Build config unchanged.",
    };
  }

  let grokMessage = "Grok Build config unchanged.";
  try {
    const grok = (io.stripGrok ?? stripGrokConfig)();
    grokMessage = grok.message;
    changed ||= grok.changed;
    if (grok.changed) logger.info(`↩️  ${grok.message}`);
    else if (!grok.ok) {
      ok = false;
      logger.warn(grok.message);
    }
  } catch {
    ok = false;
    grokMessage = "Grok Build config cleanup failed.";
  }
  return { ok, changed, grokMessage };
}

/** Shared server-side preparation for POST /api/stop. It never exits the process. */
export function prepareExplicitProxyShutdown(
  options: {
    allowInstalledServiceStop?: boolean;
    serviceAlreadyStopped?: boolean;
  } = {},
): {
  accepted: boolean;
  status: 200 | 409;
  success: boolean;
  message: string;
} {
  const admission = admitLifecycleServiceStop(quietLogger);
  if (admission.blocked) {
    return {
      accepted: false,
      status: 409,
      success: false,
      message: "An installed background service could not be stopped safely; shared state was left unchanged.",
    };
  }
  if (admission.installed && options.allowInstalledServiceStop === false) {
    return {
      accepted: false,
      status: 409,
      success: false,
      message: "An installed background service owns this proxy; use menu or CLI Stop.",
    };
  }
  const restored = restoreManagedClientState(quietLogger);
  if (!restored.ok) {
    return {
      accepted: false,
      status: 409,
      success: false,
      message: "Native client routing could not be restored; CodexCommander stayed running.",
    };
  }
  const service = options.serviceAlreadyStopped
    ? { stopped: false, blocked: false, failed: false }
    : stopLifecycleService(quietLogger, admission.installed);
  if (service.blocked) {
    return {
      accepted: false,
      status: 409,
      success: false,
      message: "Native routing was restored, but the installed background service could not be stopped; CodexCommander stayed running.",
    };
  }
  const grokNote = restored.grokMessage === "Grok Build config unchanged."
    ? ""
    : ` ${restored.grokMessage}`;
  return {
    accepted: true,
    status: 200,
    success: !service.failed,
    message: !service.failed
      ? `Proxy stopping, native Codex restored.${grokNote}`
      : `Proxy stopping, but its service manager reported an error.${grokNote}`,
  };
}

export async function stopProxyLifecycle(
  options: StopProxyLifecycleOptions = {},
): Promise<ProxyLifecycleResult> {
  const action = options.action ?? "stop";
  const io = options.io ?? {};
  let authority: ProxyLifecycleAuthority;
  try {
    authority = await (io.acquireAuthority ?? acquireProxyLifecycleAuthority)({
      includeStart: true,
    });
  } catch {
    return lifecycleResult(action, "blocked", {
      ok: false,
      message: "CodexCommander lifecycle coordination is unavailable.",
      errorCode: "STOP_FAILED",
    });
  }
  try {
    return await stopProxyLifecycleUnderAuthority(options, authority);
  } finally {
    authority.releaseAll();
  }
}

/** Caller holds E + S; this releases S before respawn proof and leaves E to the caller. */
export async function stopProxyLifecycleUnderAuthority(
  options: StopProxyLifecycleOptions,
  authority: ProxyLifecycleAuthority,
): Promise<ProxyLifecycleResult> {
  const action = options.action ?? "stop";
  const logger = options.logger ?? quietLogger;
  const io = options.io ?? {};
  const lifecycleLease = authority.delegatedLease();
  if (!lifecycleLease) {
    return lifecycleResult(action, "blocked", {
      ok: false,
      message: "CodexCommander lifecycle coordination is unavailable.",
      errorCode: "STOP_FAILED",
    });
  }
  try {
  let stopFailed = false;
  let changed = false;
  const admission = admitLifecycleServiceStop(logger, io.diagnoseService);
  if (admission.blocked) {
    return lifecycleResult(action, "blocked", {
      ok: false,
      changed,
      message: "An installed background service could not be stopped safely; shared state was left unchanged.",
      errorCode: "SERVICE_BLOCKED",
    });
  }

  // Native routing is the precondition for terminating the endpoint. The
  // escape is config-only and cannot be blocked by transition coordinator DB
  // state; if it cannot be verified, leave both service and proxy alive.
  const restored = restoreManagedClientState(logger, io);
  changed ||= restored.changed;
  if (!restored.ok) {
    const live = await (io.findLive ?? findLiveProxy)().catch(() => null);
    return lifecycleResult(action, live ? "running" : "failed", {
      ok: false,
      changed,
      live,
      message: "Native client routing could not be restored; CodexCommander stayed running.",
      errorCode: "STOP_FAILED",
    });
  }

  const service = stopLifecycleService(logger, admission.installed, io.stopService);
  changed ||= service.stopped;
  if (service.blocked) {
    try { revertSystemEnv(); } catch { /* ownership-checked best effort */ }
    return lifecycleResult(action, "blocked", {
      ok: false,
      changed,
      message: "Native routing was restored, but the installed background service could not be stopped; the proxy stayed running.",
      errorCode: "SERVICE_BLOCKED",
    });
  }
  stopFailed ||= service.failed;

  const pid = (io.readPid ?? readPid)();
  if (pid) {
    try {
      await (io.stopProxy ?? stopProxy)(pid, { lifecycleLease });
      logger.info(`✅ Proxy (PID ${pid}) stopped.`);
      (io.removePid ?? removePid)(pid);
      (io.removeRuntimePort ?? removeRuntimePort)(pid);
      changed = true;
    } catch (error) {
      stopFailed = true;
      logger.error(`Failed to stop proxy (PID ${pid}).`);
      const detail = error instanceof Error ? error.message : String(error);
      if (detail) logger.error(detail);
    }
  } else {
    const stalePidValue = (io.readPidFileValue ?? readPidFileValue)();
    const staleRuntimePid = (io.readRuntimePort ?? readRuntimePort)()?.pid ?? null;
    const live = await (io.findLive ?? findLiveProxy)();
    if (live?.pid) {
      try {
        await (io.stopProxy ?? stopProxy)(live.pid, { lifecycleLease });
        logger.info(`✅ Proxy (PID ${live.pid}) stopped.`);
        changed = true;
      } catch (error) {
        stopFailed = true;
        logger.error(`Failed to stop proxy (PID ${live.pid}).`);
        const detail = error instanceof Error ? error.message : String(error);
        if (detail) logger.error(detail);
      }
    } else if (!service.stopped) {
      logger.info("No running proxy found.");
    }
    if (!stopFailed) {
      (io.removePidIfValueIs ?? removePidIfValueIs)(stalePidValue);
      (io.removeRuntimePortIfPidIs ?? removeRuntimePortIfPidIs)(staleRuntimePid);
    }
  }

  // Let a replacement acquire S while E still excludes every legitimate Start.
  // A survivor therefore proves an uncontrolled or still-active supervisor.
  authority.releaseStart();
  if (admission.installed) {
    try {
      if (!(io.verifyServiceStopped ?? serviceSupervisorInactiveAfterStop)()) {
        stopFailed = true;
        logger.error("The background service did not confirm an inactive state.");
      }
    } catch {
      stopFailed = true;
    }
  }
  let survivor: { port: number } | null = null;
  try {
    survivor = await (io.findSurvivor ?? proxyStillLiveAfterStop)();
  } catch {
    stopFailed = true;
  }
  if (survivor) {
    stopFailed = true;
    logger.error(`A proxy is still listening on port ${survivor.port}.`);
  }

  try { revertSystemEnv(); } catch { /* ownership-checked best effort */ }
  if (stopFailed) {
    return lifecycleResult(action, "failed", {
      ok: false,
      changed,
      message: "CodexCommander proxy stop did not complete cleanly.",
      errorCode: "STOP_FAILED",
    });
  }
  return lifecycleResult(action, "stopped", {
    ok: true,
    changed,
    message: changed ? "CodexCommander proxy stopped." : "CodexCommander proxy is already stopped.",
  });
  } finally {
    authority.releaseStart();
  }
}

/** Switch plain Codex to its native endpoint without changing proxy lifecycle. */
export async function restoreNativeRoutingLifecycle(
  io: RoutingLifecycleIo = {},
): Promise<ProxyLifecycleResult> {
  let authority: ProxyLifecycleAuthority;
  try {
    authority = await (io.acquireAuthority ?? acquireProxyLifecycleAuthority)({
      includeStart: true,
    });
  } catch {
    return lifecycleResult("restore-native", "blocked", {
      ok: false,
      message: "CodexCommander lifecycle coordination is unavailable.",
      errorCode: "STOP_FAILED",
    });
  }
  try {
    return await restoreNativeRoutingLifecycleUnderLocks(io);
  } finally {
    authority.releaseAll();
  }
}

async function restoreNativeRoutingLifecycleUnderLocks(
  io: RoutingLifecycleIo,
): Promise<ProxyLifecycleResult> {
  const live = await (io.findLive ?? findLiveProxy)().catch(() => null);
  let externalProvider: string | null = null;
  try { externalProvider = currentExternalCodexModelProvider(); } catch { /* escape reports the unreadable config */ }
  const restored = restoreNativeCodexRoutingForStop({
    setEnabled: io.setEnabled,
    escapeNative: io.escapeNative,
  });
  const result = lifecycleResult("restore-native", live ? "running" : restored.success ? "stopped" : "failed", {
    ok: restored.success,
    changed: restored.changed,
    live,
    message: restored.success
      ? "Codex now uses native routing. The CodexCommander proxy was left unchanged."
      : restored.message,
    errorCode: restored.success ? undefined : "STOP_FAILED",
  });
  return {
    ...result,
    configChanged: restored.configChanged,
    desiredChanged: restored.desiredChanged,
    routingAction: !restored.success
      ? "failed"
      : externalProvider
        ? "external-provider-preserved"
        : restored.configChanged
          ? "owned-fields-stripped"
          : "unchanged",
  };
}

/** Re-point plain Codex at an already-running proxy. */
export async function restoreBackRoutingLifecycle(
  io: RoutingLifecycleIo = {},
): Promise<ProxyLifecycleResult> {
  let authority: ProxyLifecycleAuthority;
  try {
    authority = await (io.acquireAuthority ?? acquireProxyLifecycleAuthority)({
      includeStart: true,
    });
  } catch {
    return lifecycleResult("restore-back", "blocked", {
      ok: false,
      message: "CodexCommander lifecycle coordination is unavailable.",
      errorCode: "START_FAILED",
    });
  }
  try {
    return await restoreBackRoutingLifecycleUnderLock(io, authority);
  } finally {
    authority.releaseAll();
  }
}

async function restoreBackRoutingLifecycleUnderLock(
  io: RoutingLifecycleIo,
  authority: ProxyLifecycleAuthority,
): Promise<ProxyLifecycleResult> {
  const live = await (io.findLive ?? findLiveProxy)().catch(() => null);
  if (!live) {
    return lifecycleResult("restore-back", "stopped", {
      ok: false,
      message: "No running CodexCommander proxy was found.",
      errorCode: "START_FAILED",
    });
  }
  if (live.source !== "runtime" || live.pid === null) {
    return lifecycleResult("restore-back", "blocked", {
      ok: false,
      live,
      message: "A recordless or different-home proxy cannot authorize Codex routing changes.",
      errorCode: "START_FAILED",
    });
  }
  const prepared = prepareExplicitProxyStartWithIo(io, live.pid);
  if (!prepared.success) {
    return lifecycleResult("restore-back", "running", {
      ok: false,
      changed: prepared.changed,
      live,
    message: prepared.message,
      errorCode: prepared.reason === "routing-recovery-unverified"
        ? "ROUTING_RECOVERY_REQUIRED"
        : "SYNC_FAILED",
    });
  }
  // Production sync runs inside the attested live proxy so the replacement
  // journal is owned by that same long-lived process, not this short-lived CLI.
  const lifecycleLease = authority.delegatedLease();
  if (!lifecycleLease) {
    return lifecycleResult("restore-back", "running", {
      ok: false,
      changed: prepared.changed,
      live,
      message: "CodexCommander lifecycle coordination was lost before routing synchronization.",
      errorCode: "SYNC_FAILED",
    });
  }
  const synced = io.syncModels
    ? await io.syncModels(live.port, lifecycleLease)
    : await syncLiveProxy(live, loadConfig(), quietLogger, lifecycleLease);
  if (!synced.ok || synced.status === "skipped") {
    return lifecycleResult("restore-back", "running", {
      ok: false,
      changed: prepared.changed,
      live,
      message: synced.message || "Codex routing was not switched back to CodexCommander.",
      errorCode: "SYNC_FAILED",
    });
  }
  return lifecycleResult("restore-back", "running", {
    ok: true,
    changed: true,
    live,
    message: "Codex now routes through the running CodexCommander proxy.",
  });
}

export async function restartProxyLifecycle(
  options: Omit<EnsureProxyLifecycleOptions, "action" | "honorAutoStart"> & {
    logger?: ProxyLifecycleLogger;
    stopIo?: StopProxyLifecycleIo;
  } = {},
): Promise<ProxyLifecycleResult> {
  const io = options.io ?? {};
  const acquireAuthority = io.acquireAuthority
    ?? options.stopIo?.acquireAuthority
    ?? acquireProxyLifecycleAuthority;
  let authority: ProxyLifecycleAuthority;
  try {
    authority = await acquireAuthority({ includeStart: true });
  } catch {
    return lifecycleResult("restart", "blocked", {
      ok: false,
      message: "CodexCommander lifecycle coordination is unavailable.",
      errorCode: "START_FAILED",
    });
  }
  try {
    const stopped = await stopProxyLifecycleUnderAuthority({
      action: "restart",
      logger: options.logger,
      io: options.stopIo,
    }, authority);
    if (!stopped.ok) return stopped;
    const prepared = prepareExplicitProxyStartWithIo(io);
    if (!prepared.success) {
      return lifecycleResult("restart", "stopped", {
        ok: false,
        changed: stopped.changed || prepared.changed,
        message: prepared.message,
        errorCode: "START_FAILED",
      });
    }
    const started = await ensureProxyLifecycleUnderLock({
      ...options,
      action: "restart",
      honorAutoStart: false,
    }, authority);
    return {
      ...started,
      changed: stopped.changed || prepared.changed || started.changed,
    };
  } finally {
    authority.releaseAll();
  }
}

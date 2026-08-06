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
import { currentExternalCodexModelProvider, restoreNativeCodex } from "../codex/inject";
import { reconcileJournal } from "../codex/journal";
import { syncModelsToCodex } from "../codex/sync";
import { stripGrokConfig } from "../grok/inject";
import { stopProxy } from "../lib/process-control";
import {
  diagnoseService,
  isServiceOwnershipError,
  serviceStartableFromTray,
  startServiceIfInstalled,
  stopServiceIfInstalled,
} from "../service";
import { findLiveProxy, type LiveProxy } from "../server/proxy-liveness";
import { acquireProxyEnsureLock } from "../server/proxy-start-lock";
import { injectSystemEnv, revertSystemEnv } from "../server/system-env";
import type { OcxConfig } from "../types";

export type ProxyLifecycleAction = "status" | "ensure" | "start" | "stop" | "restart";
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
  errorCode?: "AUTOSTART_DISABLED" | "SERVICE_BLOCKED" | "START_FAILED" | "STOP_FAILED";
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

export interface EnsureProxyLifecycleIo {
  findLive?: () => Promise<LiveProxy | null>;
  loadConfig?: () => OcxConfig;
  diagnoseService?: typeof diagnoseService;
  startService?: () => boolean;
  spawnStart?: (port?: number, env?: NodeJS.ProcessEnv) => Promise<void>;
  waitForProxy?: (timeoutMs?: number) => Promise<LiveProxy | null>;
  syncLive?: (live: LiveProxy, config: OcxConfig, logger: ProxyLifecycleLogger) => Promise<void>;
  ensureCompanion?: () => Promise<boolean>;
  reconcile?: () => void;
  acquireEnsureLock?: () => Promise<{ release(): void }>;
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
}

/**
 * Locate a duplicate for `ocx start`. Runtime records still identify this state
 * home first; only the recordless fallback probe follows an explicit --port.
 */
export function findLiveProxyForStart(
  requestedPort: number | undefined,
  config: Pick<OcxConfig, "port" | "hostname">,
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
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
  };
}

export function proxyStartArgv(port?: number, entry = process.argv[1]): string[] {
  if (!entry) throw new Error("OpenCodex CLI entry is unavailable");
  const argv = [entry, "start"];
  if (typeof port === "number" && Number.isSafeInteger(port) && port > 0 && port <= 65535) {
    argv.push("--port", String(port));
  }
  return argv;
}

/** Spawn the canonical foreground start command and resolve only after OS spawn succeeds. */
export function spawnDetachedProxyStart(options: SpawnDetachedProxyOptions = {}): Promise<void> {
  const spawnFn = options.spawnFn ?? spawn;
  const env = options.env ?? { ...process.env, OCX_SERVICE: "1" };
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(process.execPath, proxyStartArgv(options.port, options.entry), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
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

/** Fixed LaunchServices argv for the repo-built companion (or a registered release app). */
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
  if (platform !== "darwin" || env.OCX_SERVICE === "1" || env.OCX_DISABLE_COMPANION === "1") {
    return null;
  }
  const sourceApp = options.appPath ?? join(repoRoot, "dist", "macos", "OpenCodex.app");
  return (options.exists ?? existsSync)(sourceApp)
    ? ["-g", sourceApp]
    : ["-g", "-b", "com.opencodex.menubar"];
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
  config: OcxConfig,
  logger: ProxyLifecycleLogger,
): Promise<void> {
  await syncModelsToCodex(live.port).catch(error => {
    logger.warn(`Model sync skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
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
}

export async function proxyLifecycleStatus(
  action: ProxyLifecycleAction = "status",
): Promise<ProxyLifecycleResult> {
  const live = await findLiveProxy();
  return live
    ? lifecycleResult(action, "running", {
      ok: true,
      live,
      message: "OpenCodex proxy is running.",
    })
    : lifecycleResult(action, "stopped", {
      ok: true,
      message: "OpenCodex proxy is stopped.",
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
  const logger = options.logger ?? quietLogger;
  const io = options.io ?? {};
  const findLive = io.findLive ?? findLiveProxy;
  const config = (io.loadConfig ?? loadConfig)();
  if (io.reconcile) io.reconcile();
  else if (!currentExternalCodexModelProvider()) reconcileJournal();

  let live = await findLive();
  let startedHere = false;
  if (!live && options.honorAutoStart && !codexAutoStartEnabled(config)) {
    return lifecycleResult(action, "disabled", {
      ok: true,
      message: "Codex autostart is disabled.",
      errorCode: "AUTOSTART_DISABLED",
    });
  }

  // Every ensure serializes managed-client publication, including the already-live
  // path. Syncing Codex and Grok concurrently is still a write race even when no new
  // proxy process needs to be spawned.
  let ensureLock: { release(): void };
  try {
    ensureLock = await (io.acquireEnsureLock ?? acquireProxyEnsureLock)();
  } catch {
    return lifecycleResult(action, "blocked", {
      ok: false,
      message: "OpenCodex lifecycle coordination is unavailable.",
      errorCode: "START_FAILED",
    });
  }
  try {
    // Another ensure may have started or stopped the proxy while this caller waited.
    live = await findLive();
    if (!live) {
      const diagnose = io.diagnoseService ?? diagnoseService;
      let service: ReturnType<typeof diagnoseService> | null = null;
      if (options.preferService !== false) {
        try {
          service = diagnose();
        } catch {
          return lifecycleResult(action, "blocked", {
            ok: false,
            message: "Installed background service could not be verified safely.",
            errorCode: "SERVICE_BLOCKED",
          });
        }
      }
      if (service?.installed && !serviceStartableFromTray(service)) {
        return lifecycleResult(action, "blocked", {
          ok: false,
          message: "Installed background service needs repair before OpenCodex can start.",
          errorCode: "SERVICE_BLOCKED",
        });
      }
      try {
        if (service?.installed) {
          const started = (io.startService ?? startServiceIfInstalled)();
          if (!started) throw new Error("Installed service could not be started");
        } else {
          const configuredPort = config.port;
          const port = typeof configuredPort === "number" && configuredPort > 0
            ? configuredPort
            : 10100;
          const spawnStart = io.spawnStart
            ?? ((selectedPort, env) => spawnDetachedProxyStart({ port: selectedPort, env }));
          await spawnStart(port, options.startEnv ?? { ...process.env, OCX_SERVICE: "1" });
        }
      } catch (error) {
        if (service?.installed || isServiceOwnershipError(error)) {
          return lifecycleResult(action, "blocked", {
            ok: false,
            message: "Installed background service refused to start safely.",
            errorCode: "SERVICE_BLOCKED",
          });
        }
        return lifecycleResult(action, "failed", {
          ok: false,
          message: "OpenCodex proxy could not be started.",
          errorCode: "START_FAILED",
        });
      }

      live = await (io.waitForProxy ?? waitForProxy)(options.waitTimeoutMs ?? 20_000);
      if (!live) {
        return lifecycleResult(action, "failed", {
          ok: false,
          message: "OpenCodex proxy did not become healthy after starting.",
          errorCode: "START_FAILED",
        });
      }
      startedHere = true;
    }
    await (io.syncLive ?? syncLiveProxy)(live, config, logger);
  } finally {
    ensureLock.release();
  }
  if (options.ensureCompanion !== false) {
    await (io.ensureCompanion ?? ensureMacOSCompanionApp)().catch(() => false);
  }
  return lifecycleResult(action, "running", {
    ok: true,
    changed: startedHere,
    live,
    message: startedHere ? "OpenCodex proxy started." : "OpenCodex proxy is already running.",
  });
}

interface ServiceStopResult {
  stopped: boolean;
  blocked: boolean;
  failed: boolean;
}

function stopLifecycleService(logger: ProxyLifecycleLogger): ServiceStopResult {
  let installed = false;
  try {
    installed = diagnoseService().installed;
  } catch {
    logger.error("Installed background service could not be verified safely.");
    return { stopped: false, blocked: true, failed: true };
  }
  try {
    const stopped = stopServiceIfInstalled();
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
  restoreMessage: string;
  grokMessage: string;
}

function restoreManagedClientState(logger: ProxyLifecycleLogger): ManagedStateRestoreResult {
  let ok = true;
  let restoreMessage: string;
  try {
    const restore = restoreNativeCodex();
    restoreMessage = restore.message;
    if (restore.success) logger.info(`↩️  ${restore.message}`);
    else {
      ok = false;
      logger.warn(restore.message);
    }
  } catch (error) {
    ok = false;
    restoreMessage = error instanceof Error ? error.message : String(error);
    logger.warn("Native Codex restore failed.");
  }

  let grokMessage = "Grok Build config unchanged.";
  try {
    const grok = stripGrokConfig();
    grokMessage = grok.message;
    if (grok.changed) logger.info(`↩️  ${grok.message}`);
    else if (!grok.ok) {
      ok = false;
      logger.warn(grok.message);
    }
  } catch {
    ok = false;
    grokMessage = "Grok Build config cleanup failed.";
  }
  return { ok, restoreMessage, grokMessage };
}

/** Shared server-side preparation for POST /api/stop. It never exits the process. */
export function prepareExplicitProxyShutdown(): {
  accepted: boolean;
  status: 200 | 409;
  success: boolean;
  message: string;
} {
  const service = stopLifecycleService(quietLogger);
  if (service.blocked) {
    return {
      accepted: false,
      status: 409,
      success: false,
      message: "An installed background service could not be stopped safely; shared state was left unchanged.",
    };
  }
  const restored = restoreManagedClientState(quietLogger);
  const grokNote = restored.grokMessage === "Grok Build config unchanged."
    ? ""
    : ` ${restored.grokMessage}`;
  return {
    accepted: true,
    status: 200,
    success: restored.ok && !service.failed,
    message: restored.ok && !service.failed
      ? `Proxy stopping, native Codex restored.${grokNote}`
      : `Proxy stopping, but native Codex restore did not complete. Run \`ocx restore\`.${grokNote}`,
  };
}

export async function stopProxyLifecycle(
  options: StopProxyLifecycleOptions = {},
): Promise<ProxyLifecycleResult> {
  const action = options.action ?? "stop";
  const logger = options.logger ?? quietLogger;
  let stopFailed = false;
  let changed = false;
  const service = stopLifecycleService(logger);
  changed ||= service.stopped;
  if (service.blocked) {
    try { revertSystemEnv(); } catch { /* ownership-checked best effort */ }
    return lifecycleResult(action, "blocked", {
      ok: false,
      changed,
      message: "An installed background service could not be stopped safely; shared state was left unchanged.",
      errorCode: "SERVICE_BLOCKED",
    });
  }
  stopFailed ||= service.failed;

  const pid = readPid();
  if (pid) {
    try {
      await stopProxy(pid);
      logger.info(`✅ Proxy (PID ${pid}) stopped.`);
      removePid(pid);
      removeRuntimePort(pid);
      changed = true;
    } catch (error) {
      stopFailed = true;
      logger.error(`Failed to stop proxy (PID ${pid}).`);
      const detail = error instanceof Error ? error.message : String(error);
      if (detail) logger.error(detail);
    }
  } else {
    const stalePidValue = readPidFileValue();
    const staleRuntimePid = readRuntimePort()?.pid ?? null;
    const live = await findLiveProxy();
    if (live?.pid) {
      try {
        await stopProxy(live.pid);
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
      removePidIfValueIs(stalePidValue);
      removeRuntimePortIfPidIs(staleRuntimePid);
    }
  }

  const restored = restoreManagedClientState(logger);
  if (!restored.ok) stopFailed = true;
  try { revertSystemEnv(); } catch { /* ownership-checked best effort */ }
  if (stopFailed) {
    return lifecycleResult(action, "failed", {
      ok: false,
      changed,
      message: "OpenCodex proxy stop did not complete cleanly.",
      errorCode: "STOP_FAILED",
    });
  }
  return lifecycleResult(action, "stopped", {
    ok: true,
    changed,
    message: changed ? "OpenCodex proxy stopped." : "OpenCodex proxy is already stopped.",
  });
}

export async function restartProxyLifecycle(
  options: Omit<EnsureProxyLifecycleOptions, "action" | "honorAutoStart"> & {
    logger?: ProxyLifecycleLogger;
  } = {},
): Promise<ProxyLifecycleResult> {
  const stopped = await stopProxyLifecycle({ action: "restart", logger: options.logger });
  if (!stopped.ok) return stopped;
  const started = await ensureProxyLifecycle({
    ...options,
    action: "restart",
    honorAutoStart: false,
  });
  return { ...started, changed: stopped.changed || started.changed };
}

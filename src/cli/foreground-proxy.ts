import {
  loadConfig,
  readPid,
  removePid,
  removeRuntimePort,
  saveConfig,
  writePid,
  writeRuntimePort,
} from "../config";
import {
  currentExternalCodexModelProvider,
  restoreNativeCodexRoutingForStop,
} from "../codex/routing-transition";
import { shouldSyncCodexOnStart, shouldSyncGrokOnStart, syncCodexOnStartIfEnabled } from "../codex/desired-state";
import { reconcileJournal } from "../codex/journal";
import { buildDesktop3pRegistry } from "../claude/desktop-3p";
import { stripGrokConfig } from "../grok/inject";
import { installCrashGuards } from "../lib/crash-guard";
import { createLocalAttestationSecret } from "../lib/local-management-attestation";
import { loadServiceTokenFromFile } from "../lib/service-secrets";
import { startTokenGuardian } from "../oauth/token-guardian";
import { drainAndShutdown, isRecyclingForExit, startServer } from "../server";
import {
  acquireProxyLifecycleAuthority,
  type ProxyLifecycleAuthority,
} from "../server/proxy-lifecycle-authority";
import { PROXY_DELEGATED_START_ENV } from "../server/proxy-lifecycle-protocol";
import type { LiveProxy } from "../server/proxy-liveness";
import {
  findAvailablePort,
  isAddrInUse,
  PortUnavailableError,
  shouldPersistSelectedPort,
  waitForPortAvailable,
} from "../server/ports";
import { createReadinessGate, type ReadinessGate } from "../server/readiness";
import {
  acquireProxyStartLock,
  consumeProxyServiceStartDelegation,
  type ProxyServiceStartDelegation,
} from "../server/proxy-start-lock";
import { injectSystemEnv, revertSystemEnv } from "../server/system-env";
import { serviceEnvironmentOwnedHere } from "../service";
import type { CodexCommanderConfig } from "../types";
import {
  catalogSyncCanApply,
  syncCodexCatalogForCli,
  type CliCodexSyncResult,
  warnAfterCatalogWrite,
} from "./catalog-activation";
import { scheduleCatalogPrewarm } from "./catalog-prewarm";
import {
  ensureMacOSCompanionApp,
  findLiveProxyForStart,
  prepareExplicitProxyStartWithIo,
  replaceStaleRuntimeForExplicitStart,
  type EnsureProxyLifecycleIo,
  type ExplicitProxyStartIo,
  type ProxyLifecycleAuthorityAcquirer,
  type StaleRuntimeRetirement,
} from "./proxy-lifecycle";

type ForegroundServer = ReturnType<typeof startServer>;

export interface ForegroundProxyLogger {
  log(message: string): void;
  error(message: string): void;
}

const consoleLogger: ForegroundProxyLogger = {
  log: message => console.log(message),
  error: message => console.error(message),
};

export type ForegroundProxyStartArgs =
  | { ok: true; port?: number }
  | { ok: false; message: string };

export function parseForegroundProxyStartArgs(args: string[]): ForegroundProxyStartArgs {
  if (args.length === 0) return { ok: true };
  if (args.length !== 2 || args[0] !== "--port") {
    return { ok: false, message: "Usage: ccx start [--port <port>]" };
  }
  const value = args[1];
  const port = value && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { ok: false, message: "Invalid port number" };
  }
  return { ok: true, port };
}

export interface ForegroundPortIo {
  loadConfig?: () => CodexCommanderConfig;
  saveConfig?: typeof saveConfig;
  reclaimListenPort?: (
    port: number,
    hostname: string,
    options: {
      timeoutMs: number;
      intervalMs: number;
      scanIntervalMs: number;
      killCodexCommanderHolders: false;
      dropTcpRows: true;
    },
  ) => Promise<void>;
  findAvailablePort?: typeof findAvailablePort;
  logger?: ForegroundProxyLogger;
}

export async function chooseForegroundListenPort(
  requestedPort?: number,
  io: ForegroundPortIo = {},
): Promise<number> {
  const load = io.loadConfig ?? loadConfig;
  const config = load();
  const preferred = requestedPort ?? config.port ?? 10100;
  const hardPin = requestedPort !== undefined && requestedPort > 0;
  const hostname = config.hostname ?? "127.0.0.1";
  if (hardPin && preferred > 0) {
    const reclaim = io.reclaimListenPort
      ?? (await import("../server/port-reclaim")).reclaimListenPort;
    await reclaim(preferred, hostname, {
      timeoutMs: 60_000,
      intervalMs: 100,
      scanIntervalMs: 500,
      killCodexCommanderHolders: false,
      dropTcpRows: true,
    });
  }
  const selected = await (io.findAvailablePort ?? findAvailablePort)(preferred, hostname, {
    preferRetryMs: hardPin ? 5_000 : 750,
    preferRetryIntervalMs: 50,
    allowEphemeralFallback: !hardPin,
  });
  if (preferred > 0 && selected !== preferred) {
    (io.logger ?? consoleLogger).log(
      `⚠️  Port ${preferred} is busy; starting CodexCommander on ${selected}.`,
    );
  }
  if (shouldPersistSelectedPort(config.port, selected, preferred)) {
    config.port = selected;
    (io.saveConfig ?? saveConfig)(config);
  }
  return selected;
}

export function grokSyncFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Grok Build config sync failed: ${detail}. `
    + "~/.grok/config.toml may still point at a previous proxy port — "
    + "run 'ccx ensure' (or apply from the dashboard's Grok page) to repoint it.";
}

export interface ForegroundStartupInitializationIo {
  sleep?: (ms: number) => Promise<void>;
  injectSystemEnv?: typeof injectSystemEnv;
  syncCodexOnStart?: typeof syncCodexOnStartIfEnabled;
  warnAfterCatalogWrite?: () => void | Promise<void>;
  buildDesktopRegistry?: (config: CodexCommanderConfig) => void | Promise<void>;
  shouldSyncGrok?: typeof shouldSyncGrokOnStart;
  syncGrok?: (
    port: number,
    config: CodexCommanderConfig,
  ) => Promise<{ ok: boolean; changed: boolean; message: string }>;
  ensureCompanion?: () => Promise<boolean>;
  logger?: ForegroundProxyLogger;
}

async function buildForegroundDesktopRegistry(config: CodexCommanderConfig): Promise<void> {
  const { fetchAllModels } = await import("../server/management-api");
  const { visibleNativeSlugs, filterCatalogVisibleModels } = await import("../codex/catalog");
  const models = filterCatalogVisibleModels(await fetchAllModels(config), config);
  buildDesktop3pRegistry(
    [...visibleNativeSlugs(config)],
    models.map(model => ({
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
    })),
    config.claudeCode?.desktopProfile,
  );
}

async function syncForegroundGrok(
  port: number,
  config: CodexCommanderConfig,
): Promise<{ ok: boolean; changed: boolean; message: string }> {
  const { syncGrokConfig } = await import("../grok/sync");
  return syncGrokConfig(
    port,
    config,
    config.hostname ? { hostname: config.hostname } : {},
  );
}

export async function runForegroundStartupInitialization(
  context: {
    port: number;
    config: CodexCommanderConfig;
    readinessGate: ReadinessGate;
  },
  io: ForegroundStartupInitializationIo = {},
): Promise<void> {
  const { port, config, readinessGate } = context;
  const logger = io.logger ?? consoleLogger;
  await (io.sleep ?? Bun.sleep)(250);
  await (io.injectSystemEnv ?? injectSystemEnv)(port, config).catch(() => {});

  const startupSync = await (io.syncCodexOnStart ?? syncCodexOnStartIfEnabled)(
    port,
    config,
    undefined,
    readinessGate,
  );
  if (!startupSync.ran) logger.log("   Codex integration OFF; startup left Codex native.");
  if (startupSync.catalogWritten || startupSync.cacheSynced) {
    const warn = io.warnAfterCatalogWrite ?? (async () => {
      const { warnIfStaleCodexAppServersAfterStartupWrite } = await import(
        "../codex/app-server-processes"
      );
      warnIfStaleCodexAppServersAfterStartupWrite({ log: console });
    });
    await warn();
  }

  try {
    await (io.buildDesktopRegistry ?? buildForegroundDesktopRegistry)(config);
  } catch {
    // The registry is rebuilt lazily on the first /v1/models request.
  }

  // Grok convergence is intentionally a sibling of Desktop registry setup: one
  // optional integration failing must not leave the other pinned to an old port.
  if ((io.shouldSyncGrok ?? shouldSyncGrokOnStart)(config)) {
    try {
      const result = await (io.syncGrok ?? syncForegroundGrok)(port, config);
      if (result.changed) logger.log("   + Grok Build config updated (~/.grok/config.toml)");
      else if (!result.ok) logger.error(`⚠️  ${result.message}`);
    } catch (error) {
      logger.error(`⚠️  ${grokSyncFailureMessage(error)}`);
    }
  }
  await (io.ensureCompanion ?? ensureMacOSCompanionApp)().catch(() => false);
}

export interface ForegroundProxyStartIo {
  env?: NodeJS.ProcessEnv;
  logger?: ForegroundProxyLogger;
  loadServiceToken?: typeof loadServiceTokenFromFile;
  acquireAuthority?: ProxyLifecycleAuthorityAcquirer;
  acquireServiceStartLock?: typeof acquireProxyStartLock;
  consumeServiceStartDelegation?: () => ProxyServiceStartDelegation | null;
  loadConfig?: () => CodexCommanderConfig;
  readPid?: typeof readPid;
  removePid?: typeof removePid;
  removeRuntimePort?: typeof removeRuntimePort;
  writePid?: typeof writePid;
  writeRuntimePort?: typeof writeRuntimePort;
  findLive?: (
    requestedPort: number | undefined,
    config: Pick<CodexCommanderConfig, "port" | "hostname">,
  ) => Promise<LiveProxy | null>;
  replaceStaleRuntime?: (
    live: LiveProxy,
    authority: ProxyLifecycleAuthority,
    io?: EnsureProxyLifecycleIo,
  ) => Promise<StaleRuntimeRetirement>;
  staleReplacementIo?: EnsureProxyLifecycleIo;
  routing?: ExplicitProxyStartIo;
  syncCatalog?: typeof syncCodexCatalogForCli;
  catalogCanApply?: typeof catalogSyncCanApply;
  warnAfterCatalogWrite?: typeof warnAfterCatalogWrite;
  shouldSyncCodex?: typeof shouldSyncCodexOnStart;
  externalProvider?: () => string | null;
  reconcile?: () => boolean | void;
  choosePort?: (requestedPort?: number) => Promise<number>;
  startServer?: typeof startServer;
  scheduleCatalogPrewarm?: () => void;
  isAddrInUse?: typeof isAddrInUse;
  waitForPortAvailable?: typeof waitForPortAvailable;
  installCrashGuards?: typeof installCrashGuards;
  createReadinessGate?: typeof createReadinessGate;
  createAttestationSecret?: typeof createLocalAttestationSecret;
  startGuardian?: () => { stop(): void };
  isRecyclingForExit?: typeof isRecyclingForExit;
  revertSystemEnv?: typeof revertSystemEnv;
  restoreNative?: typeof restoreNativeCodexRoutingForStop;
  serviceEnvironmentOwnedHere?: typeof serviceEnvironmentOwnedHere;
  stripGrok?: typeof stripGrokConfig;
  drainAndShutdown?: typeof drainAndShutdown;
  initializeStartup?: typeof runForegroundStartupInitialization;
  initializationIo?: ForegroundStartupInitializationIo;
  onSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
  onExit?: (listener: () => void) => void;
  exit?: (code: number) => void;
  keepAlive?: () => void;
  waitForever?: () => Promise<never>;
}

async function acquireForegroundStartAuthority(
  mode: "explicit" | "delegated" | "service",
  io: ForegroundProxyStartIo,
): Promise<{
  authority?: ProxyLifecycleAuthority;
  mayMutateRouting: boolean;
  release(): void;
}> {
  if (mode === "explicit") {
    const authority = await (io.acquireAuthority ?? acquireProxyLifecycleAuthority)({
      includeStart: true,
    });
    return { authority, mayMutateRouting: true, release: () => authority.releaseAll() };
  }

  if (mode === "service") {
    // S serializes consumption of the one-shot marker stored in the exact E
    // owner record. A service process without that proof is autonomous: it
    // must release this probe and acquire the complete E -> S hierarchy.
    const delegatedStart = await (io.acquireServiceStartLock ?? acquireProxyStartLock)();
    try {
      const delegation = (
        io.consumeServiceStartDelegation ?? consumeProxyServiceStartDelegation
      )();
      if (delegation) {
        return { mayMutateRouting: false, release: () => delegatedStart.release() };
      }
    } catch (error) {
      delegatedStart.release();
      throw error;
    }
    delegatedStart.release();
    const authority = await (io.acquireAuthority ?? acquireProxyLifecycleAuthority)({
      includeStart: true,
    });
    return { authority, mayMutateRouting: true, release: () => authority.releaseAll() };
  }

  // A parent-delegated foreground child is the deliberate S-only participant.
  const start = await (io.acquireServiceStartLock ?? acquireProxyStartLock)();
  return { mayMutateRouting: false, release: () => start.release() };
}

export async function runForegroundProxyStart(
  args: string[],
  options: { block?: boolean; io?: ForegroundProxyStartIo } = {},
): Promise<number> {
  const io = options.io ?? {};
  const env = io.env ?? process.env;
  const logger = io.logger ?? consoleLogger;
  const parsed = parseForegroundProxyStartArgs(args);
  if (!parsed.ok) {
    logger.error(parsed.message);
    return 1;
  }

  const serviceToken = (io.loadServiceToken ?? loadServiceTokenFromFile)(env);
  if (serviceToken) env.CODEXCOMMANDER_API_AUTH_TOKEN = serviceToken;
  const serviceChild = env.CCX_SERVICE === "1";
  const delegatedStart = env[PROXY_DELEGATED_START_ENV] === "1";
  const parentDelegated = serviceChild || delegatedStart;
  const lifecycleMode = serviceChild ? "service" : delegatedStart ? "delegated" : "explicit";

  let lifecycle: Awaited<ReturnType<typeof acquireForegroundStartAuthority>>;
  try {
    lifecycle = await acquireForegroundStartAuthority(lifecycleMode, io);
  } catch (error) {
    logger.error(
      `❌ Could not coordinate proxy ${parentDelegated ? "startup" : "lifecycle"}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  let authorityReleased = false;
  const releaseAuthority = (): void => {
    if (authorityReleased) return;
    authorityReleased = true;
    lifecycle.release();
  };
  const load = io.loadConfig ?? loadConfig;
  const removePidFn = io.removePid ?? removePid;
  const removeRuntimePortFn = io.removeRuntimePort ?? removeRuntimePort;
  let port = 0;
  let server: ForegroundServer | undefined;
  let config = load();
  let explicitRoutingPrepared = false;
  let terminalStartupFailure: unknown;
  const readinessGate = (io.createReadinessGate ?? createReadinessGate)();
  const localAttestationSecret = (
    io.createAttestationSecret ?? createLocalAttestationSecret
  )();

  try {
    const existingPid = (io.readPid ?? readPid)();
    const live = await (io.findLive ?? findLiveProxyForStart)(parsed.port, config);
    let currentHomeLive = live?.source === "runtime" && live.pid !== null ? live : null;
    if (live && (serviceChild || !currentHomeLive)) {
      logger.error(currentHomeLive
        ? `⚠️  Proxy already running (PID ${currentHomeLive.pid}, port ${currentHomeLive.port}).`
        : `⚠️  A recordless or different-home proxy is already listening on port ${live.port}; Codex routing was left unchanged.`);
      return 1;
    }

    if (currentHomeLive && !parentDelegated) {
      if (!lifecycle.authority) {
        logger.error("❌ Explicit Start lost lifecycle authority before stale-runtime inspection.");
        return 1;
      }
      const replacement = await (
        io.replaceStaleRuntime ?? replaceStaleRuntimeForExplicitStart
      )(currentHomeLive, lifecycle.authority, io.staleReplacementIo);
      if (replacement.failed) {
        logger.error(`❌ ${replacement.failed.message}`);
        return 1;
      }
      currentHomeLive = replacement.live;
    }

    if (!parentDelegated) {
      const prepared = prepareExplicitProxyStartWithIo(
        io.routing ?? {},
        currentHomeLive?.pid ?? undefined,
      );
      if (!prepared.success) {
        logger.error(`❌ ${prepared.message}`);
        return 1;
      }
      explicitRoutingPrepared = true;
      config = load();
    }

    if (currentHomeLive) {
      let synced: CliCodexSyncResult;
      try {
        const lease = lifecycle.authority?.delegatedLease();
        if (!lease) throw new Error("Start lost lifecycle authority before live synchronization.");
        synced = await (io.syncCatalog ?? syncCodexCatalogForCli)(
          currentHomeLive,
          undefined,
          lease,
        );
      } catch (error) {
        logger.error(
          `❌ Proxy is already running, but Codex routing could not be synchronized: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return 1;
      }
      const externalProviderPreserved = synced.status === "skipped"
        && synced.skippedReason === "external_provider"
        && synced.ok;
      if (!externalProviderPreserved && !(io.catalogCanApply ?? catalogSyncCanApply)(synced, true)) {
        const detail = synced.warning?.trim() || synced.message?.trim()
          || "Codex routing did not reach a verified active state.";
        logger.error(
          `❌ Proxy is already running, but Codex routing did not synchronize: ${detail}`,
        );
        return 1;
      }
      if (synced.catalogWritten || synced.cacheSynced) {
        await (io.warnAfterCatalogWrite ?? warnAfterCatalogWrite)("activation");
      }
      logger.log(externalProviderPreserved
        ? `✅ Proxy already running (PID ${currentHomeLive.pid}, port ${currentHomeLive.port}); ${synced.message}`
        : `✅ Proxy already running (PID ${currentHomeLive.pid}, port ${currentHomeLive.port}); Codex now routes through it.`);
      return 0;
    }
    if (existingPid) removePidFn(existingPid);

    // A service child never chooses durable intent. It may reconcile only when
    // the parent-selected state is already ON; automatic ensure can therefore
    // start it while Codex remains intentionally native/OFF.
    if (serviceChild
      && lifecycle.mayMutateRouting
      && (io.shouldSyncCodex ?? shouldSyncCodexOnStart)(config)
      && !(io.externalProvider ?? currentExternalCodexModelProvider)()) {
      (io.reconcile ?? reconcileJournal)();
    }

    const choosePort = io.choosePort
      ?? (requested => chooseForegroundListenPort(requested, {
        loadConfig: load,
        logger,
      }));
    port = await choosePort(parsed.port);
    for (let attempt = 0; ; attempt++) {
      try {
        server = (io.startServer ?? startServer)(port, {
          localAttestationSecret,
          readinessGate,
        });
        (io.scheduleCatalogPrewarm ?? scheduleCatalogPrewarm)();
        break;
      } catch (error) {
        if (!(io.isAddrInUse ?? isAddrInUse)(error) || attempt >= 2) throw error;
        if (parsed.port !== undefined) {
          logger.log(`⚠️  Port ${port} was taken while starting; waiting to retry the same port...`);
          const hostname = load().hostname ?? "127.0.0.1";
          const freed = await (io.waitForPortAvailable ?? waitForPortAvailable)(
            port,
            hostname,
            { timeoutMs: 3_000, intervalMs: 50 },
          );
          if (!freed) {
            throw new PortUnavailableError(port, hostname);
          }
          continue;
        }
        logger.log(`⚠️  Port ${port} was taken while starting; picking another...`);
        port = await choosePort(parsed.port);
      }
    }
    (io.installCrashGuards ?? installCrashGuards)();
    (io.writePid ?? writePid)(process.pid);
    config = load();
    (io.writeRuntimePort ?? writeRuntimePort)({
      pid: process.pid,
      port,
      hostname: config.hostname,
      attestationSecret: localAttestationSecret,
      attestationProtocol: 2,
    });
  } catch (error) {
    if (explicitRoutingPrepared) {
      const restored = (io.restoreNative ?? restoreNativeCodexRoutingForStop)();
      if (!restored.success) {
        logger.error(`❌ Proxy startup failed and native Codex restore was refused: ${restored.message}`);
        if (server) {
          readinessGate.markFailed();
          terminalStartupFailure = error;
        } else {
          return 1;
        }
      }
    }
    if (server && terminalStartupFailure === undefined) {
      try {
        await (io.drainAndShutdown ?? drainAndShutdown)(server, 0);
      } catch {
        // Native routing is already safe; runtime-record cleanup is authoritative.
      }
      removePidFn(process.pid);
      removeRuntimePortFn(process.pid);
      server = undefined;
    }
    if (error instanceof PortUnavailableError) {
      logger.error(`❌ ${error.message}`);
      logger.error("   Stop whatever holds that port, or change config.port, then retry.");
      return 1;
    }
    if (terminalStartupFailure === undefined) throw error;
  } finally {
    if (!server) releaseAuthority();
  }
  if (!server) return 1;

  const guardian = (io.startGuardian ?? startTokenGuardian)();
  let cleaned = false;
  let cleanupSucceeded = true;
  // Native routing is a durable transition, not generic process cleanup. Exit
  // hooks and forced termination may clean local records but must not make a
  // native-routing claim without lifecycle authority.
  const syncCleanup = (): boolean => {
    if (cleaned) return cleanupSucceeded;
    cleaned = true;
    try {
      guardian.stop();
    } catch {
      // Cleanup continues so routing and runtime records are not stranded.
    }
    const recycling = (io.isRecyclingForExit ?? isRecyclingForExit)();
    if (!recycling) {
      try {
        (io.revertSystemEnv ?? revertSystemEnv)();
      } catch {
        // Environment teardown is best effort; native routing proof below is not.
      }
    }
    removePidFn(process.pid);
    removeRuntimePortFn(process.pid);
    if (!recycling
      && !serviceChild
      && (io.serviceEnvironmentOwnedHere ?? serviceEnvironmentOwnedHere)()) {
      try {
        (io.stripGrok ?? stripGrokConfig)();
      } catch {
        // Stop already owns the Codex safety decision; Grok cleanup is best effort here.
      }
    }
    return cleanupSucceeded;
  };

  let shuttingDown = false;
  let initialization: Promise<void> | undefined;
  const shutdown = (): void => {
    // Repeated signals are deliberately idempotent. A second signal must never
    // bypass a pending or refused native-routing transition and strand Codex on
    // a dead, untracked endpoint.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log("\n🛑 Shutting down CodexCommander proxy...");
    void (async () => {
      let shutdownAuthority: ProxyLifecycleAuthority | undefined;
      try {
        // A signal during startup retains the initial E + S pair through this
        // shutdown transition. Once startup has released it, acquire a fresh
        // E -> S pair before changing durable routing intent. This avoids both
        // recursive E acquisition and a Start interleaving ON around native
        // restoration.
        if (!serviceChild && !(io.isRecyclingForExit ?? isRecyclingForExit)()) {
          try {
            await initialization;
            if (authorityReleased) {
              shutdownAuthority = await (io.acquireAuthority ?? acquireProxyLifecycleAuthority)({
                includeStart: true,
              });
            }
            const restored = (io.restoreNative ?? restoreNativeCodexRoutingForStop)();
            if (!restored.success) {
              logger.error(`⚠️  Native Codex restore failed during shutdown: ${restored.message}`);
              if (shutdownAuthority) shutdownAuthority.releaseAll();
              else releaseAuthority();
              shuttingDown = false;
              return;
            }
          } catch (error) {
            logger.error(
              `⚠️  Could not coordinate native Codex restore during shutdown: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            if (shutdownAuthority) shutdownAuthority.releaseAll();
            else releaseAuthority();
            shuttingDown = false;
            return;
          }
        }
        await (io.drainAndShutdown ?? drainAndShutdown)(
          server,
          config.shutdownTimeoutMs ?? 5_000,
        );
      } finally {
        // A failed native-restore admission returns above: keep the endpoint
        // and records alive for a retry. Every other path can now tear down.
        if (!shuttingDown) return;
        const cleanupOk = syncCleanup();
        // releaseAll is explicitly S -> E. Keep both through drain and the
        // desired-OFF/native restoration above, then let a waiting Start run.
        try {
          if (shutdownAuthority) shutdownAuthority.releaseAll();
          else releaseAuthority();
        } finally {
          (io.exit ?? (code => process.exit(code)))(cleanupOk ? 0 : 1);
        }
      }
    })();
  };

  const onSignal = io.onSignal ?? ((signal, listener) => process.on(signal, listener));
  onSignal("SIGINT", shutdown);
  onSignal("SIGTERM", shutdown);
  onSignal("SIGHUP", shutdown);
  (io.onExit ?? (listener => process.on("exit", listener)))(syncCleanup);

  if (terminalStartupFailure !== undefined) {
    // Native restore was refused after bind. The listener is intentionally kept
    // alive, but startup convergence must not run against an incompletely
    // published runtime identity. Normal signal/exit handlers above remain
    // installed so a later explicit shutdown can retry the native transition.
    initialization = Promise.resolve();
  } else {
    const initializationIo = lifecycle.mayMutateRouting
      ? io.initializationIo
      : {
          ...io.initializationIo,
          injectSystemEnv: async () => ({
            injected: false,
            reason: "parent-delegated service startup",
          }),
          syncCodexOnStart: async () => {
            readinessGate.markReady();
            return { ran: false, catalogWritten: false, cacheSynced: false };
          },
          buildDesktopRegistry: async () => {},
          shouldSyncGrok: () => false,
        };
    initialization = (io.initializeStartup ?? runForegroundStartupInitialization)(
      { port, config, readinessGate },
      { ...initializationIo, logger: initializationIo?.logger ?? logger },
    ).catch(error => {
      // Once the listener is published, routing may already point at it. Keep
      // the endpoint and runtime identity alive in terminal-failed readiness so
      // an authenticated sync can recover it.
      readinessGate.markFailed();
      logger.error(
        `❌ CodexCommander startup initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  initialization = initialization.finally(() => {
    // If shutdown began while startup still held E + S, its cleanup owns the
    // release after draining and restoring native routing. Otherwise release
    // as soon as convergence completes so an ordinary Start can proceed.
    if (!shuttingDown) releaseAuthority();
  });

  if (options.block ?? true) {
    (io.keepAlive ?? (() => { setInterval(() => {}, 60_000); }))();
    await (io.waitForever ?? (() => new Promise<never>(() => {})))();
  }
  await initialization;
  return 0;
}

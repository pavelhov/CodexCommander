#!/usr/bin/env bun
import { currentExternalCodexModelProvider, restoreNativeCodex, shouldInjectApiAuthHeader } from "../codex/inject";
import { stripGrokConfig } from "../grok/inject";
import { restoreLegacyOpenaiHistory } from "../codex/history-provider";
import { reconcileJournal } from "../codex/journal";
import {
  getConfigDir,
  loadConfig,
  readPid,
  removePid,
  removeRuntimePort,
  saveConfig,
  writePid,
  writeRuntimePort,
} from "../config";
import { collectStatus } from "./status";
import { dispatchInternalCliCommand, type InternalCliCommand } from "./internal-dispatch";
import { installCrashGuards } from "../lib/crash-guard";
import { hasHelpFlag, printSubcommandUsage, printUsage, printVersion } from "./help";
import { findAvailablePort, isAddrInUse, PortUnavailableError, shouldPersistSelectedPort, waitForPortAvailable } from "../server/ports";
import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
import { stopProxy } from "../lib/process-control";
import { loadServiceTokenFromFile } from "../lib/service-secrets";
import { serviceCommand, serviceEnvironmentOwnedHere, serviceStatusSummary, stopServiceIfInstalled, uninstallServiceIfInstalled } from "../service";
import { startupHealthSummary } from "../codex/autostart-health";
import { drainAndShutdown, isRecyclingForExit, startServer } from "../server";
import { injectSystemEnv, revertSystemEnv } from "../server/system-env";
import { buildDesktop3pRegistry } from "../claude/desktop-3p";
import { uninstallShellHook } from "../server/system-env";
import { startTokenGuardian } from "../oauth/token-guardian";
import { startHistoryMigrationGuardian } from "../codex/history-migration-guardian";
import { maybeAutoRestoreCodexShim } from "./codex-shim-autorestore";
import { scheduleCatalogPrewarm } from "./catalog-prewarm";
import { maybeShowUpdatePrompt } from "../update/notify";
import { syncModelsToCodex } from "../codex/sync";
import { normalizeUpdateChannel, runGuiUpdateWorker } from "../update/job";
import { collectOrcaCodexHomeDiagnostic } from "../codex/home";
import { removeOwnedConfigState } from "../lib/config-ownership";
import { acquireProxyStartLock } from "../server/proxy-start-lock";
import {
  ensureProxyLifecycle,
  ensureMacOSCompanionApp,
  findLiveProxyForStart,
  restartProxyLifecycle,
  stopProxyLifecycle,
  type ProxyLifecycleLogger,
} from "./proxy-lifecycle";

const args = process.argv.slice(2);
const command = args[0];

if (command === "--version" || command === "-v" || command === "version") {
  printVersion();
  process.exit(0);
}

if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  if (command === "help" && args[1]) printSubcommandUsage(args[1]);
  else printUsage();
  process.exit(0);
}

if (command !== undefined && command !== "help" && hasHelpFlag(args.slice(1))) {
  printSubcommandUsage(command);
  process.exit(0);
}

if (command !== "__macos-lifecycle") maybeAutoRestoreCodexShim(command, args);

function parsePortOption(): number | undefined {
  if (args.length === 1) return undefined;
  if (args.length !== 3 || args[1] !== "--port") {
    console.error("Usage: ocx start [--port <port>]");
    process.exit(1);
  }
  const portIdx = args.indexOf("--port");
  if (portIdx === -1) return undefined;
  const value = args[portIdx + 1];
  const port = value && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error("Invalid port number");
    process.exit(1);
  }
  return port;
}

/**
 * A Grok fence sync that throws is best-effort by design — it must never block startup.
 * Reporting nothing, however, is what lets a STALE fence survive: `~/.grok/config.toml`
 * keeps naming whatever port the last successful sync wrote, and once that listener is
 * gone every grok turn retries against a refused connection while our own log stays
 * silent (2026-07-27 field report: 8 entries pinned to a dead 127.0.0.1:4179).
 * So say what failed and name the single command that repairs it.
 */
function grokSyncFailureMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Grok Build config sync failed: ${detail}. `
    + "~/.grok/config.toml may still point at a previous proxy port — "
    + "run 'ocx ensure' (or apply from the dashboard's Grok page) to repoint it.";
}

async function chooseListenPort(requestedPort?: number): Promise<number> {
  const config = loadConfig();
  const preferred = requestedPort ?? config.port ?? 10100;
  const hardPin = requestedPort !== undefined && requestedPort > 0;
  // Soft start: brief prefer-retry then ephemeral hop.
  // Explicit `--port` (service wrappers / update restart): wait for the pinned port
  // to free without killing any listener (healthy ocx / foreign). Never hop.
  if (hardPin && preferred > 0) {
    const { reclaimListenPort } = await import("../server/port-reclaim");
    await reclaimListenPort(preferred, config.hostname ?? "127.0.0.1", {
      // Ghost LISTEN rows with a dead PID can outlive the process for a while.
      // SetTcpEntry(DELETE_TCB) needs elevation (often returns 317), so the only
      // reliable non-admin recovery is to wait for the OS to release the TCB.
      timeoutMs: 60_000,
      intervalMs: 100,
      scanIntervalMs: 500,
      killOcxHolders: false,
      dropTcpRows: true,
    });
  }
  try {
    const selected = await findAvailablePort(preferred, config.hostname ?? "127.0.0.1", {
      // After reclaim, keep probing briefly — ghost rows sometimes clear between
      // the reclaim deadline and the final listen. Still never hop off `--port`.
      preferRetryMs: hardPin ? 5_000 : 750,
      preferRetryIntervalMs: 50,
      allowEphemeralFallback: !hardPin,
    });
    if (preferred > 0 && selected !== preferred) {
      console.log(`⚠️  Port ${preferred} is busy; starting opencodex on ${selected}.`);
    }
    if (shouldPersistSelectedPort(config.port, selected, preferred)) {
      config.port = selected;
      saveConfig(config);
    }
    return selected;
  } catch (err) {
    throw err;
  }
}

async function handleStart(options: { block?: boolean } = {}) {
  // Native (WinSW) service mode has no batch wrapper to read the service token file
  // into the environment, so the app loads it here before the server binds. The server
  // auth path reads OPENCODEX_API_AUTH_TOKEN from the environment.
  const serviceToken = loadServiceTokenFromFile(process.env);
  if (serviceToken) process.env.OPENCODEX_API_AUTH_TOKEN = serviceToken;
  const requestedPort = parsePortOption();

  // Interactive-only update prompt. Must run BEFORE we bind a port / write a
  // PID: choosing "Update now" installs globally and exits, so we never want a
  // live daemon holding resources while it overwrites its own binary.
  await maybeShowUpdatePrompt();

  // Hold one cross-process authority from the final identity check through listener
  // bind and runtime-record publication. Concurrent start/ensure children wait here,
  // then observe this exact PID instead of choosing another port.
  let startLock: Awaited<ReturnType<typeof acquireProxyStartLock>>;
  try {
    startLock = await acquireProxyStartLock();
  } catch (error) {
    console.error(`❌ Could not coordinate proxy startup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  let port = 0;
  let server: ReturnType<typeof startServer> | undefined;
  let config = loadConfig();
  let startLockReleased = false;
  const releaseStartLock = () => {
    if (startLockReleased) return;
    startLockReleased = true;
    startLock.release();
  };
  try {
    if (!currentExternalCodexModelProvider()) reconcileJournal();
    const existingPid = readPid();
    // Runtime records remain authoritative for this state home. With an explicit
    // port and no local records, however, do not let another OpenCodex home's
    // default-port listener masquerade as this instance and block the requested bind.
    const live = await findLiveProxyForStart(requestedPort, config);
    if (live) {
      console.error(`⚠️  Proxy already running (PID ${live.pid ?? existingPid ?? "unknown"}, port ${live.port}). Use 'ocx stop' first.`);
      process.exitCode = 1;
      return;
    }
    if (existingPid) removePid(existingPid);

    // The start lock closes the check-then-bind race. Soft starts may still re-pick if
    // an unrelated process takes the preferred port; hard-pinned starts never hop.
    port = await chooseListenPort(requestedPort);
    for (let attempt = 0; ; attempt++) {
      try {
        server = startServer(port);
        scheduleCatalogPrewarm();
        break;
      } catch (err) {
        if (!isAddrInUse(err) || attempt >= 2) throw err;
        if (requestedPort !== undefined) {
          console.log(`⚠️  Port ${port} was taken while starting; waiting to retry the same port...`);
          const hostname = loadConfig().hostname ?? "127.0.0.1";
          const freed = await waitForPortAvailable(port, hostname, { timeoutMs: 3_000, intervalMs: 50 });
          if (!freed) {
            console.error(`❌ Port ${port} stayed busy; refusing to hop to an ephemeral port.`);
            process.exitCode = 1;
            return;
          }
          continue;
        }
        console.log(`⚠️  Port ${port} was taken while starting; picking another...`);
        port = await chooseListenPort(requestedPort);
      }
    }
    installCrashGuards();
    writePid(process.pid);
    config = loadConfig();
    writeRuntimePort({ pid: process.pid, port, hostname: config.hostname });
  } catch (error) {
    if (server) {
      try { await drainAndShutdown(server, 0); } catch { /* startup is already failing */ }
      removePid(process.pid);
      removeRuntimePort(process.pid);
      server = undefined;
    }
    if (error instanceof PortUnavailableError) {
      console.error(`❌ ${error.message}`);
      console.error("   Stop whatever holds that port, or change config.port, then retry.");
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    // Successful startup keeps authority until initial managed-client publication is
    // complete. A just-bound Bun listener may not answer health while module startup
    // is still running; releasing here allowed a contender to spawn a second process.
    if (!server) releaseStartLock();
  }
  if (!server) return;
  try {
  // No pre-emptive snapshot here. `injectCodexConfig` journals the exact bytes it
  // is about to transform; snapshotting earlier only captured a baseline that could
  // already be stale by the time injection ran (#477).

  // Background proactive token refresh. No-op unless config.tokenGuardian.enabled; timer is unref'd
  // so it never keeps the process alive on its own. Stopped in syncCleanup so no refresh fires mid-drain.
  const guardian = startTokenGuardian();
  // Design B upgrade path: keep retrying the one-time opencodex→openai history migration in the
  // background — the first `ocx start` after an update usually races the Codex app's DB lock.
  // Loopback-only (legacy mode still forward-tags) and respects syncResumeHistory opt-out.
  let historyGuardian: ReturnType<typeof startHistoryMigrationGuardian> | undefined;

  let cleaned = false;
  let cleanupSucceeded = true;
  const syncCleanup = () => {
    if (cleaned) return cleanupSucceeded;
    cleaned = true;
    try { guardian.stop(); } catch { /* best-effort */ }
    try { historyGuardian?.stop(); } catch { /* best-effort */ }
    // Dashboard drain-and-restart (#563) must not tear down injection: the replacement
    // process expects Codex/Grok/env fences to still be in place.
    const recycling = isRecyclingForExit();
    if (!recycling) {
      try { revertSystemEnv(); } catch { /* best-effort */ }
    }
    removePid(process.pid);
    removeRuntimePort(process.pid);
    if (!recycling && !process.env.OCX_SERVICE && !currentExternalCodexModelProvider()) {
      try {
        const restored = restoreNativeCodex();
        if (!restored.success) {
          cleanupSucceeded = false;
          console.error(`⚠️  Native Codex restore failed during shutdown: ${restored.message}`);
        }
      } catch (error) {
        cleanupSucceeded = false;
        console.error(`⚠️  Native Codex restore failed during shutdown: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Same ownership rule as `ocx stop`: if the installed service belongs to another home, the
    // Grok fence is shared state we must not remove — that service keeps running and would be
    // left pointing nowhere. This guard also covers signal-driven exits, which is the path that
    // would otherwise bypass handleStop's gate entirely.
    if (!recycling && !process.env.OCX_SERVICE && serviceEnvironmentOwnedHere()) {
      try { stripGrokConfig(); } catch { /* best-effort restore */ }
    }
    return cleanupSucceeded;
  };

  let shuttingDown = false;
  let shutdownStartedAt = 0;
  // Terminal Ctrl-C delivers SIGINT to the whole foreground group AND the launcher
  // forwards its own — two signals land within milliseconds. Treat a duplicate inside
  // this window as the same Ctrl-C (one graceful drain); a deliberate later press
  // escalates to an immediate force-exit ("gradual kill").
  const FORCE_AFTER_MS = 500;
  const shutdown = () => {
    const now = Date.now();
    if (shuttingDown) {
      if (now - shutdownStartedAt < FORCE_AFTER_MS) return; // near-simultaneous duplicate — ignore
      console.log("\n⏹  Force shutdown (second signal).");
      try { syncCleanup(); } catch { /* best-effort */ }
      process.exit(130);
    }
    shuttingDown = true;
    shutdownStartedAt = now;
    console.log("\n🛑 Shutting down opencodex proxy...");
    void (async () => {
      try {
        await drainAndShutdown(server, config.shutdownTimeoutMs ?? 5000);
      } finally {
        const restored = syncCleanup(); // idempotent (cleaned-guard); also re-run by process.on("exit")
        process.exit(restored ? 0 : 1);
      }
    })();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The launcher (bin/ocx.mjs) forwards SIGHUP too (e.g. terminal close); handle it
  // gracefully here so it drains + cleans up instead of a default immediate kill.
  process.on("SIGHUP", shutdown);
  process.on("exit", syncCleanup);

  // Let module startup reach its resident wait before doing catalog/provider work.
  // Bun does not dispatch this just-created server while the entry module is still in
  // its initial top-level await chain; a detached initializer makes /healthz available
  // promptly while preserving the same startup work and cleanup handlers.
  const initialization = (async () => {
    // A zero-delay timer can win the first event-loop turn and immediately enter a
    // synchronous launchctl/catalog section. Leave a short, fixed health-publication
    // window so ensure/Finder callers can validate the listener before that work.
    await Bun.sleep(250);

    // System-wide env injection AFTER signal handlers are registered (crash safety:
    // syncCleanup reverts even if injection itself or subsequent startup steps fail).
    await injectSystemEnv(port, config).catch(() => {});

    await syncModelsToCodex(port).catch(() => {});
    if (!currentExternalCodexModelProvider() && !shouldInjectApiAuthHeader(config) && config.syncResumeHistory !== false) {
      historyGuardian = startHistoryMigrationGuardian();
    }
  // Build Desktop 3P alias registry so inbound claude-opus-4-8-{code} aliases (and legacy claude-opus-4-{code}) decode correctly.
    try {
      const { fetchAllModels } = await import("../server/management-api");
      const { visibleNativeSlugs, filterCatalogVisibleModels } = await import("../codex/catalog");
      const models = filterCatalogVisibleModels(await fetchAllModels(config), config);
      buildDesktop3pRegistry(
        [...visibleNativeSlugs(config)],
        models.map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow })),
        config.claudeCode?.desktopProfile,
      );
    } catch { /* best-effort — registry rebuilds on first /v1/models call */ }
  // Grok Build auto-registration: additive fenced block in ~/.grok/config.toml so an installed
  // grok CLI can pick opencodex-routed models without manual config. No-op when ~/.grok is
  // absent or the bind is non-loopback; removed again by stop/eject/uninstall/shutdown.
  // Deliberately a SIBLING of the Desktop-3P block above: nesting it there meant a catalog
  // failure skipped the fence entirely, even though syncGrokConfig handles that case itself.
    try {
      const { syncGrokConfig } = await import("../grok/sync");
      const r = await syncGrokConfig(port, config, config.hostname ? { hostname: config.hostname } : {});
      if (r.changed) console.log("   + Grok Build config updated (~/.grok/config.toml)");
      else if (!r.ok) console.error(`⚠️  ${r.message}`);
    } catch (err) {
      // Best-effort: grok integration must never block startup. But swallowing the error
      // silently is how a stale fence survives unnoticed — ~/.grok/config.toml keeps
      // pointing at whatever port the LAST successful sync wrote, and if that listener is
      // gone every grok turn retries against a refused connection with nothing in our log
      // to explain it. Name the failure and the one command that repairs it.
      console.error(`⚠️  ${grokSyncFailureMessage(err)}`);
    }
    await ensureMacOSCompanionApp().catch(() => false);
  })().catch(async error => {
    try { await drainAndShutdown(server, 0); } catch { /* startup is already failing */ }
    removePid(process.pid);
    removeRuntimePort(process.pid);
    throw error;
  }).finally(releaseStartLock);

  if (options.block ?? true) {
    void initialization.catch(error => {
      console.error(`❌ OpenCodex startup initialization failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
    setInterval(() => {}, 60_000);
    await new Promise<void>(() => {});
  }
  await initialization;
  } catch (error) {
    try { await drainAndShutdown(server, 0); } catch { /* startup is already failing */ }
    removePid(process.pid);
    removeRuntimePort(process.pid);
    throw error;
  } finally {
    releaseStartLock();
  }
}

const lifecycleLogger: ProxyLifecycleLogger = {
  info: message => console.log(message),
  warn: message => console.error(`⚠️  ${message}`),
  error: message => console.error(`❌ ${message}`),
};

async function handleEnsure() {
  const result = await ensureProxyLifecycle({
    honorAutoStart: true,
    ensureCompanion: true,
    logger: lifecycleLogger,
  });
  if (result.state === "disabled") {
    console.log(result.message);
    return;
  }
  if (result.ok) console.log(`✅ Proxy running on port ${result.port}`);
  else {
    console.error(`❌ ${result.message}`);
    process.exitCode = 1;
  }
}

/** Fixed tray action: start the proxy without depending on codexAutoStart. */
async function handleTrayProxyStart(): Promise<void> {
  const result = await ensureProxyLifecycle({
    honorAutoStart: false,
    ensureCompanion: false,
    logger: lifecycleLogger,
  });
  if (result.ok) console.log(`Proxy running on port ${result.port}.`);
  else {
    console.error(result.message);
    process.exitCode = 1;
  }
}

async function handleTrayProxyRestart(): Promise<void> {
  const result = await restartProxyLifecycle({
    ensureCompanion: false,
    logger: lifecycleLogger,
  });
  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
  }
}

async function handleStop() {
  const result = await stopProxyLifecycle({ logger: lifecycleLogger });
  if (!result.ok) process.exitCode = 1;
  return result.ok;
}

async function handleUninstall() {
  const failures: string[] = [];

  const runStep = async (label: string, step: () => void | boolean | Promise<void | boolean>) => {
    try {
      const changed = await step();
      if (changed === false) console.log(`- ${label}: not installed`);
      else console.log(`✅ ${label}`);
    } catch (err) {
      failures.push(label);
      console.error(`⚠️  ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await runStep("service stopped", () => stopServiceIfInstalled());

  await runStep("proxy stopped", async () => {
    const pid = readPid();
    if (!pid) return false;
    await stopProxy(pid);
    removePid(pid);
    removeRuntimePort(pid);
    return true;
  });

  await runStep("service removed", () => uninstallServiceIfInstalled());

  if (process.platform === "win32") {
    await runStep("Windows tray removed", async () => {
      const { getWindowsTrayStatus, uninstallWindowsTray } = await import("../tray/windows");
      const tray = getWindowsTrayStatus();
      if (!tray.installed && !tray.stale && !tray.running) return false;
      uninstallWindowsTray();
    });
  }

  await runStep("native Codex restored", () => {
    const r = restoreNativeCodex();
    if (!r.success) throw new Error(r.message);
  });

  await runStep("Grok Build config restored", () => {
    const r = stripGrokConfig();
    if (!r.ok) throw new Error(r.message);
    return r.changed;
  });

  await runStep("system env vars reverted", () => {
    const r = revertSystemEnv();
    if (!r.reverted && r.reason !== "no tracking file" && r.reason !== "not macOS") throw new Error(r.reason ?? "revert failed");
  });

  await runStep("shell hook removed", () => {
    const r = uninstallShellHook();
    if (!r.removed && r.reason !== "not installed" && r.reason !== "not macOS") throw new Error(r.reason ?? "remove failed");
  });

  try {
    const { uninstallCodexShim } = await import("../codex/shim");
    const r = uninstallCodexShim();
    console.log(r.removed ? "✅ Codex autostart shim removed" : "- Codex autostart shim removed: not installed");
  } catch (err) {
    failures.push("Codex autostart shim removed");
    console.error(`⚠️  Codex autostart shim removed failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (failures.length === 0) {
    await runStep("opencodex config removed", () => {
      const result = removeOwnedConfigState(getConfigDir());
      if (result.status === "absent") return false;
      if (result.status === "removed") return true;
      const residual = result.residualPaths.length > 0
        ? ` Residual path(s): ${result.residualPaths.join(", ")}`
        : "";
      throw new Error(`${result.status} uninstall: ${result.reason ?? "config state was not removed"}.${residual}`);
    });
  } else {
    console.error("Leaving opencodex config/backups in place so the failed restore step can be retried.");
  }

  if (failures.length > 0) {
    console.error(`\nUninstall finished with ${failures.length} failed step(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\n✅ opencodex local state removed. Remove the package with: npm uninstall -g @bitkyc08/opencodex");
}

async function handleStatus() {
  const statusArgs = args.slice(1);
  const wantsJson = statusArgs.length === 1 && statusArgs[0] === "--json";
  if (statusArgs.length > 1 || (statusArgs.length === 1 && !wantsJson)) {
    console.error("Usage: ocx status [--json]");
    process.exit(1);
  }

  const status = await collectStatus();
  if (wantsJson) {
    console.log(JSON.stringify(status.json, null, 2));
    return;
  }

  if (status.json.proxy.pid || status.json.proxy.health.ok) {
    console.log(`✅ Proxy: ${status.proxyLabel}`);
  } else {
    console.log(`❌ Proxy: ${status.proxyLabel}`);
  }
  console.log(`   Health: ${status.healthLabel}`);
  if (!(status.json.proxy.pid || status.json.proxy.health.ok)) {
    console.log("   ↳ Not running — Codex/Claude requests will fail with connection errors.");
    console.log("     Restart with 'ocx start', or install the persistent service: 'ocx service install'.");
  }
  console.log(`   Dashboard: ${status.json.dashboard.url}`);
  console.log(`   Config: ${status.json.paths.config}`);
  console.log(`   PID file: ${status.json.paths.pid}`);
  console.log(`   Runtime: ${status.json.paths.runtime}`);
  console.log(`   Runtime source: ${status.json.runtime.source}${status.json.runtime.overrideEnv ? ` (${status.json.runtime.overrideEnv})` : ""}`);
  console.log(`   Default provider: ${status.json.defaultProvider}`);
  console.log(`   Codex autostart: ${status.json.codexAutostart ? "enabled" : "disabled"}`);
  console.log(`   Restart safety: ${startupHealthSummary(status.json.startup)}`);
  console.log(`   Service: ${status.json.service.summary}`);
  console.log(`   ${status.json.codexShim.summary}`);
  console.log(`   Codex runtime: ${status.json.codexRuntime.path}`);
  console.log(`   Codex version: ${status.json.codexRuntime.version ?? "unknown"}`);
  console.log(`   Codex source: ${status.json.codexRuntime.source}`);
  console.log(`   Codex home: ${status.json.codexHome.effectiveCodexHome}`);
  if (status.json.codexHome.warning) {
    console.log(`   ⚠️  ${status.json.codexHome.warning}`);
    console.log(`      Action: ${status.json.codexHome.action}`);
  }
  console.log(`   Catalog clamp: ${status.json.codexRuntime.catalogClamp.active ? "active" : "inactive"}`);
  if (status.json.codexRuntime.catalogClamp.removedEfforts.length > 0) {
    console.log(`   Removed efforts: ${status.json.codexRuntime.catalogClamp.removedEfforts.join(", ")}`);
  }
  if (status.json.codexRuntime.warning) {
    console.log(`   ⚠️  ${status.json.codexRuntime.warning}`);
  }
  if (status.json.codexPlugins.applicable) {
    const icon = status.json.codexPlugins.stale ? "⚠️ " : "✅";
    console.log(`   ${icon} Codex bundled plugins: ${status.json.codexPlugins.summary}`);
    if (status.json.codexPlugins.suggestedRepair) {
      console.log(`      Suggested: ${status.json.codexPlugins.suggestedRepair}`);
    }
  }
  const { collectOAuthHealthEntriesForCli, oauthLoginSummary } = await import("../oauth");
  const { formatOAuthHealthForStatus } = await import("./status-oauth");
  console.log(`   OAuth logins:`);
  for (const e of oauthLoginSummary()) {
    console.log(`     ${e.provider.padEnd(10)} ${e.loggedIn ? `✓ logged in${e.email ? ` (${e.email})` : ""}` : "✗ not logged in"}`);
  }
  const oauthHealthBlock = formatOAuthHealthForStatus(await collectOAuthHealthEntriesForCli());
  if (oauthHealthBlock) {
    for (const line of oauthHealthBlock.split("\n")) {
      console.log(`   ${line}`);
    }
  }
}

function handleRecoverHistory() {
  if (args[1] !== "--legacy-openai") {
    console.error("Usage: ocx recover-history --legacy-openai");
    console.error("Only use this if an older syncResumeHistory build already remapped OpenAI Codex App history to opencodex before backup support existed.");
    process.exit(1);
  }
  const r = restoreLegacyOpenaiHistory();
  if (r.failed) {
    console.error(
      "⚠️  Recovery SKIPPED: the Codex history DB is locked (Codex app/IDE open?). Close it and rerun this command.",
    );
    process.exit(1);
  }
  console.log(`Recovered ${r.rows} legacy thread(s) to openai (${r.files} rollout file(s) updated).`);
}

switch (command) {
  case "init":
  case "setup": {
    const { runInit } = await import("./init");
    await runInit();
    break;
  }
  case "start":
    await handleStart();
    break;
  case "stop": {
    // Downtime warning lives HERE, not in handleStop: `restart`/tray-restart callers
    // re-start the proxy immediately, so warning there would contradict the next line.
    if (await handleStop()) {
      console.log("⚠️  Codex/Claude requests through the proxy will fail until it is restarted ('ocx start' or 'ocx service start').");
    }
    break;
  }
  case "restore":
  case "eject": {
    if (args[1] === "back") {
      // Reverse switch: re-point plain `codex` at the RUNNING proxy without touching its
      // lifecycle — the counterpart of `ocx restore`. Start/stop triggers are unchanged;
      // this only re-runs the same inject (config + catalog + history) `ocx start` does.
      const live = await findLiveProxy();
      if (!live) {
        console.error("No running proxy found. Run 'ocx start' — it injects opencodex automatically.");
        process.exit(1);
      }
      const synced = await syncModelsToCodex(live.port);
      if (!synced.ok) {
        process.exitCode = 1;
        console.error("Plain `codex` was not switched back to opencodex. Fix the reported Codex config issue and retry.");
        break;
      }
      const target = collectOrcaCodexHomeDiagnostic();
      console.log(`Plain \`codex\` now routes through opencodex in ${target.effectiveCodexHome} (undo with: ocx restore).`);
      break;
    }
    let r: { success: boolean; message: string };
    try {
      r = restoreNativeCodex();
    } catch (err) {
      r = { success: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (r.success) console.log(`✅ ${r.message}`);
    else {
      console.error(`⚠️  ${r.message}`);
      process.exitCode = 1;
    }
    try {
      const g = stripGrokConfig();
      if (g.changed) console.log(`✅ ${g.message}`);
      else if (!g.ok) {
        console.error(`⚠️  ${g.message}`);
        process.exitCode = 1;
      }
    } catch { /* best-effort */ }
    if (r.success) {
      console.log("Plain `codex` now runs natively (no proxy). Switch back with: ocx restore back");
    } else {
      console.error("Plain `codex` was not fully restored. Inspect $CODEX_HOME/config.toml before using native Codex.");
    }
    break;
  }
  case "recover-history":
    handleRecoverHistory();
    break;
  case "uninstall":
  case "remove":
    await handleUninstall();
    break;
  case "status":
    await handleStatus();
    break;
  case "doctor": {
    const { runDoctor } = await import("./doctor");
    await runDoctor(args.slice(1));
    break;
  }
  case "debug": {
    const { handleDebugCommand } = await import("./debug");
    await handleDebugCommand(args.slice(1));
    break;
  }
  case "ensure":
    await handleEnsure();
    break;
  case "login": {
    const { handleLogin } = await import("../oauth/login-cli");
    await handleLogin(args[1]);
    break;
  }
  case "logout": {
    const { removeCredential } = await import("../oauth/store");
    const name = (args[1] ?? "").trim().toLowerCase();
    await removeCredential(name);
    console.log(`Logged out of ${name || "(none)"}.`);
    break;
  }
  case "sync": {
    const restartCodex = args.slice(1).includes("--restart-codex");
    const synced = await syncModelsToCodex((await findLiveProxy())?.port);
    if (!synced.ok) {
      process.exitCode = 1;
      console.error("Codex sync did not complete. Fix the reported Codex config issue and retry.");
    }
    // Only warn/restart when a catalog or models_cache write actually happened. This is
    // deliberately not an `else`: refreshCodexModelCatalog runs before injectCodexConfig,
    // so a sync can fail (`ok: false`) after the catalog was already rewritten — which is
    // exactly when a long-lived app-server is holding the stale list.
    if (synced.catalogWritten || synced.cacheSynced) {
      const { afterCatalogWriteHandleAppServers } = await import("../codex/app-server-processes");
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
    }
    break;
  }
  case "v2": {
    const { cmdV2 } = await import("./v2");
    process.exitCode = await cmdV2(args.slice(1), {}, async () => (await findLiveProxy())?.port);
    break;
  }
  case "sync-cache": {
    const restartCodex = args.slice(1).includes("--restart-codex");
    const { invalidateCodexModelsCache } = await import("../codex/catalog");
    // Only warn/restart when models_cache was actually rewritten from a readable catalog.
    if (invalidateCodexModelsCache()) {
      const { afterCatalogWriteHandleAppServers } = await import("../codex/app-server-processes");
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
    }
    break;
  }
  case "gui": {
    const cfg = await import("../config");
    const config = cfg.loadConfig();
    const ensured = await ensureProxyLifecycle({
      honorAutoStart: false,
      ensureCompanion: true,
      logger: lifecycleLogger,
    });
    if (!ensured.ok || !ensured.port) {
      console.error("❌ Proxy did not become healthy after starting. Not opening the GUI.");
      process.exitCode = 1;
      break;
    }
    const live = await findLiveProxy();
    if (!live) {
      console.error("❌ Proxy identity disappeared before the GUI could open.");
      process.exitCode = 1;
      break;
    }
    // Open the host the proxy actually binds — `localhost` only answers for
    // loopback/wildcard binds, not a concrete LAN/IPv6 hostname.
    const guiHost = probeHostname(live?.hostname ?? config.hostname);
    const guiUrl = `http://${guiHost === "127.0.0.1" ? "localhost" : guiHost}:${live.port}`;
    console.log(`Opening ${guiUrl}`);
    const { openUrl } = await import("../lib/open-url");
    openUrl(guiUrl);
    break;
  }
  case "service":
    await serviceCommand(...args.slice(1));
    break;
  case "tray": {
    const { windowsTrayCommand } = await import("../tray/windows");
    await windowsTrayCommand(args.slice(1));
    break;
  }
  case "codex-shim": {
    const { codexShimStatus, installCodexShim, uninstallCodexShim } = await import("../codex/shim");
    switch (args[1]) {
      case "install": {
        const r = installCodexShim();
        console.log(r.installed ? `✅ ${r.message}` : `⚠️  ${r.message}`);
        break;
      }
      case "status":
        console.log(codexShimStatus());
        break;
      case "uninstall":
      case "remove": {
        const r = uninstallCodexShim();
        console.log(r.removed ? `✅ ${r.message}` : `⚠️  ${r.message}`);
        break;
      }
      default:
        console.error("Usage: ocx codex-shim <install|status|uninstall|remove>");
        process.exit(1);
    }
    break;
  }
  case "update": {
    // `ocx update --help` must print usage and exit WITHOUT side effects — running the
    // real self-update stops the proxy and drops in-flight routed streams (issue #168).
    if (hasHelpFlag(args.slice(1))) {
      printSubcommandUsage("update");
      break;
    }
    const { runUpdate } = await import("../update");
    await runUpdate();
    break;
  }
  case "__refresh-version": {
    // Hidden, detached helper spawned by the update prompt to refresh the
    // cached latest version without blocking the foreground start. Not in help.
    const { refreshVersionCache } = await import("../update/notify");
    const channel = args[1] === "preview" ? "preview" : "latest";
    await refreshVersionCache(channel);
    break;
  }
  case "__macos-lifecycle": {
    const { runMacOSLifecycleHelper } = await import("./macos-lifecycle");
    process.exitCode = await runMacOSLifecycleHelper(args.slice(1));
    break;
  }
  case "__tray-start":
  case "__tray-restart":
  case "__startup-health":
    await dispatchInternalCliCommand(command as InternalCliCommand, {
      trayStart: handleTrayProxyStart,
      trayRestart: handleTrayProxyRestart,
      startupHealth: async () => {
        const { collectStartupHealth } = await import("../codex/autostart-health");
        console.log(JSON.stringify(collectStartupHealth(loadConfig())));
      },
    });
    break;
  case "__tray-host": {
    const { runWindowsTrayHost } = await import("../tray/windows");
    await runWindowsTrayHost();
    break;
  }
  case "__gui-update-worker": {
    const jobId = args[1];
    if (!jobId) process.exit(1);
    const channel = normalizeUpdateChannel(args[2]);
    await runGuiUpdateWorker(jobId, channel, args[3] === "restart");
    break;
  }
  case "restart": {
    const result = await restartProxyLifecycle({
      ensureCompanion: true,
      logger: lifecycleLogger,
    });
    if (result.ok) console.log(`✅ Proxy restarted on port ${result.port}.`);
    else {
      console.error(`↩️  Restart aborted: ${result.message}`);
      process.exitCode = 1;
    }
    break;
  }
  case "health": {
    const healthArgs = args.slice(1);
    const wantsHealthJson = healthArgs.includes("--json");
    const live = await findLiveProxy();
    if (wantsHealthJson) {
      console.log(JSON.stringify({ ok: !!live, pid: live?.pid ?? null, port: live?.port ?? null }));
    } else {
      console.log(live ? `Proxy healthy (PID ${live.pid}, port ${live.port})` : "Proxy not healthy");
    }
    process.exit(live ? 0 : 1);
  }
    case "provider": {
    const { handleProviderCommand } = await import("./provider");
    await handleProviderCommand(args.slice(1));
    break;
  }
  case "account": {
    const { cmdAccount } = await import("./account");
    process.exitCode = await cmdAccount(args.slice(1));
    break;
  }
  case "models":
  case "model": {
    const { handleModels } = await import("./models");
    await handleModels(args.slice(1));
    break;
  }
  case "combo": {
    const { handleComboCommand } = await import("./combo");
    process.exitCode = await handleComboCommand(args.slice(1));
    break;
  }
  case "route": {
    if (args[1] !== "combo") {
      console.error("Usage: ocx route combo <subcommand>");
      process.exitCode = 2;
      break;
    }
    const { handleComboCommand } = await import("./combo");
    process.exitCode = await handleComboCommand(args.slice(2));
    break;
  }
  case "agent": {
    const { handleAgentCommand } = await import("./agent");
    process.exitCode = await handleAgentCommand(args.slice(1));
    break;
  }
  case "observe": {
    const { handleObserveCommand } = await import("./observe");
    process.exitCode = await handleObserveCommand(args.slice(1));
    break;
  }
  case "logs":
  case "usage":
  case "storage":
  case "memory": {
    const { handleObserveCommand } = await import("./observe");
    process.exitCode = await handleObserveCommand([command, ...args.slice(1)]);
    break;
  }
  case "access": {
    const { handleAccessCommand } = await import("./access");
    process.exitCode = await handleAccessCommand(args.slice(1));
    break;
  }
  case "api-key": {
    const { handleAccessCommand } = await import("./access");
    process.exitCode = await handleAccessCommand(["key", ...args.slice(1)]);
    break;
  }
  case "export": {
    const { handleExportCommand } = await import("./export-command");
    process.exitCode = await handleExportCommand(args.slice(1));
    break;
  }
  case "grok": {
    const { handleGrokCommand } = await import("./integrations");
    process.exitCode = await handleGrokCommand(args.slice(1));
    break;
  }
  case "integration": {
    const integration = args[1];
    if (integration === "grok") {
      const { handleGrokCommand } = await import("./integrations");
      process.exitCode = await handleGrokCommand(args.slice(2));
    } else if (integration === "claude") {
      const { handleClaudeConfigCommand } = await import("./integrations");
      process.exitCode = await handleClaudeConfigCommand(args.slice(2));
    } else {
      console.error("Usage: ocx integration <claude|grok> <subcommand>");
      process.exitCode = 2;
    }
    break;
  }
  case "system": {
    const { handleSystemCommand } = await import("./system-command");
    process.exitCode = await handleSystemCommand(args.slice(1));
    break;
  }
  case "config": {
    const { handleConfigCommand } = await import("./config-command");
    process.exitCode = await handleConfigCommand(args.slice(1));
    break;
  }
  case "claude": {
    const { cmdClaude } = await import("./claude");
    // "ocx claude desktop" → write Desktop 3P config
    if (args[1] === "desktop") {
      const { handleClaudeDesktopCommand } = await import("./claude-desktop");
      const exitCode = await handleClaudeDesktopCommand(args.slice(2));
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }
    if (args[1] === "config") {
      const { handleClaudeConfigCommand } = await import("./integrations");
      process.exitCode = await handleClaudeConfigCommand(args.slice(2));
      break;
    }
    process.exit(await cmdClaude(args.slice(1)));
  }
  case "opencode": {
    const { cmdOpencode } = await import("./opencode");
    process.exit(await cmdOpencode(args.slice(1)));
  }
    case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}

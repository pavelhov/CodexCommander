#!/usr/bin/env bun
import {
  loadConfig,
} from "../config";
import { collectStatus } from "./status";
import { dispatchInternalCliCommand, type InternalCliCommand } from "./internal-dispatch";
import { hasHelpFlag, printSubcommandUsage, printUsage, printVersion } from "./help";
import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
import { parseReadyArgs, runReady, type ReadyArgs } from "./ready";
import { serviceCommand } from "./service-command";
import { startupHealthSummary } from "../codex/autostart-health";
import { maybeAutoRestoreCodexShim } from "./codex-shim-autorestore";
import {
  applyInvalidatedCacheWorkers,
  applySynchronizedCatalogWorkers,
  bindCacheArtifactForApply,
  bindCatalogArtifactsForApply,
  catalogSyncCanApply,
  captureCatalogRestartFence,
  reportCatalogWorkerApply,
  syncCodexCatalogForCli,
  type CliCodexSyncResult,
  warnAfterCatalogWrite,
} from "./catalog-activation";
import { shouldSyncCodexOnStart } from "../codex/desired-state";
import { collectOrcaCodexHomeDiagnostic } from "../codex/home";
import { initializeNodeLauncherContext } from "./launcher-context";
import { runForegroundProxyStart } from "./foreground-proxy";
import { runUninstallCommand } from "./uninstall-command";
import {
  ensureProxyLifecycle,
  restoreBackRoutingLifecycle,
  restoreNativeRoutingLifecycle,
  restartProxyLifecycle,
  stopProxyLifecycle,
  type ProxyLifecycleLogger,
} from "./proxy-lifecycle";

initializeNodeLauncherContext();
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

// P1: pre-parse `ccx ready` and reject invalid arguments with exit 64 BEFORE
// maybeAutoRestoreCodexShim (or any discovery/probe/filesystem-capable global
// preflight) runs. `ready --help` / `help ready` already exited above, so this
// only sees ready args without a help flag. Valid args are stashed so the
// switch dispatch can call runReady without a second parse.
let readyArgs: ReadyArgs | undefined;
if (command === "ready") {
  const parsed = parseReadyArgs(args.slice(1));
  if (!parsed.ok) {
    console.error("Usage: ccx ready [--json] [--wait [--timeout <seconds>]]");
    console.error("  --timeout requires --wait; <seconds> must be a positive integer (1..300).");
    console.error("  Default wait timeout is 45 seconds.");
    process.exit(parsed.code);
  }
  readyArgs = parsed.args;
}

if (command !== "__macos-lifecycle") maybeAutoRestoreCodexShim(command, args);

const lifecycleLogger: ProxyLifecycleLogger = {
  info: message => console.log(message),
  warn: message => console.error(`⚠️  ${message}`),
  error: message => console.error(`❌ ${message}`),
};

async function handleEnsure() {
  const result = await ensureProxyLifecycle({
    honorAutoStart: true,
    ensureCompanion: true,
    replaceStaleRuntime: true,
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
    action: "start",
    honorAutoStart: false,
    ensureCompanion: false,
    replaceStaleRuntime: true,
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
    replaceStaleRuntime: true,
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

async function handleStatus() {
  const statusArgs = args.slice(1);
  const wantsJson = statusArgs.length === 1 && statusArgs[0] === "--json";
  if (statusArgs.length > 1 || (statusArgs.length === 1 && !wantsJson)) {
    console.error("Usage: ccx status [--json]");
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
    // The service summary a few lines below already tells a registered-but-not-serving
    // user to repair. Printing "install the persistent service" unconditionally
    // contradicted it in the same report, and install re-registers: UAC on Windows and a
    // possible WinSW-to-scheduler switch for someone who already has a service.
    const installed = status.json.startup.serviceInstalled && !status.json.startup.serviceConflict;
    console.log(installed
      ? "     Restart with 'ccx start', or refresh the installed service: 'ccx service repair'."
      : "     Restart with 'ccx start', or install the persistent service: 'ccx service install'.");
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

/**
 * `ccx ready` — arguments are pre-parsed above (before
 * maybeAutoRestoreCodexShim) so invalid usage exits 64 before any global
 * preflight. This handler only runs the dependency-injected runner in ./ready
 * and exits with the returned code; it performs no parsing and no I/O of its
 * own. The full behavior is unit-testable without spawning a subprocess.
 */
async function handleReady(args: ReadyArgs): Promise<never> {
  process.exit(await runReady(args));
}

switch (command) {
  case "init":
  case "setup": {
    const { runInit } = await import("./init");
    await runInit();
    break;
  }
  case "start":
    process.exitCode = await runForegroundProxyStart(args.slice(1));
    break;
  case "stop": {
    // Downtime warning lives HERE, not in handleStop: `restart`/tray-restart callers
    // re-start the proxy immediately, so warning there would contradict the next line.
    if (await handleStop()) {
      console.log("⚠️  Codex/Claude requests through the proxy will fail until it is restarted ('ccx start' or 'ccx service start').");
    }
    break;
  }
  case "restore":
  case "eject": {
    const restoreJson = args[1] === "--json";
    if (args[1] === "back") {
      const restored = await restoreBackRoutingLifecycle({ replaceStaleRuntime: true });
      if (!restored.ok) {
        process.exitCode = 1;
        console.error(restored.message);
        break;
      }
      const target = collectOrcaCodexHomeDiagnostic();
      console.log(`Plain \`codex\` now routes through CodexCommander in ${target.effectiveCodexHome} (undo with: ccx restore).`);
      break;
    }
    const restored = await restoreNativeRoutingLifecycle();
    if (restoreJson) {
      const message = restored.message;
      const configChanged = restored.configChanged ?? false;
      console.log(JSON.stringify({
        success: restored.ok,
        message,
        artifacts: {
          config: {
            state: restored.ok ? (configChanged ? "ok" : "skipped") : "failed",
            changed: configChanged,
            action: restored.routingAction ?? (restored.ok ? "unchanged" : "failed"),
            message,
          },
          catalog: {
            state: "skipped",
            changed: false,
            removed: 0,
            kept: 0,
            path: null,
            message: "Catalog was not accessed by the native-routing escape.",
          },
        },
      }));
      if (!restored.ok) process.exitCode = 1;
      break;
    }
    if (restored.ok) console.log(`✅ ${restored.message}`);
    else {
      console.error(`⚠️  ${restored.message}`);
      process.exitCode = 1;
    }
    if (restored.ok) {
      console.log("Codex integration is OFF and plain `codex` now runs natively. Switch back with: ccx restore back");
    } else {
      console.error("Plain `codex` was not fully restored. Inspect $CODEX_HOME/config.toml before using native Codex.");
    }
    break;
  }
  case "uninstall":
  case "remove":
    process.exitCode = await runUninstallCommand();
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
    // Capture consent + desired generation before any awaited discovery. The
    // same opaque fence is checked again immediately before every eligible
    // SIGTERM by the shared Apply helper.
    const restartFence = captureCatalogRestartFence(
      restartCodex && shouldSyncCodexOnStart(loadConfig()),
    );
    let synced: CliCodexSyncResult;
    const live = await findLiveProxy();
    try {
      synced = await syncCodexCatalogForCli(live);
    } catch (error) {
      process.exitCode = 1;
      console.error(`Codex sync did not complete: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    if (synced.status === "skipped") {
      console.log("Codex integration is OFF; sync skipped and no Codex files changed.");
    } else if (!synced.ok) {
      process.exitCode = 1;
      console.error("Codex sync did not complete. Fix the reported Codex config issue and retry.");
    } else if (live && synced.message) {
      // Local sync already emits its established progress messages. A live
      // server intentionally keeps its logs out of this CLI process.
      console.log(synced.message);
    }
    const synchronizedCatalogIsUsable = catalogSyncCanApply(synced, live !== null);
    if (restartCodex && synchronizedCatalogIsUsable) {
      // Explicit Apply also resolves a worker left stale by an earlier write,
      // even when this convergence is a semantic no-op with preserved mtimes.
      const applied = await applySynchronizedCatalogWorkers(
        bindCatalogArtifactsForApply(restartFence),
        synced,
      );
      if (!applied) {
        console.error("The saved configuration could not be fenced before synchronization; no Codex worker was stopped.");
        process.exitCode = 1;
      } else if (!reportCatalogWorkerApply(applied)) {
        process.exitCode = 1;
      }
    } else if (!restartCodex && (synced.catalogWritten || synced.cacheSynced)) {
      await warnAfterCatalogWrite("activation");
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
    if (!shouldSyncCodexOnStart(loadConfig())) {
      console.log("Codex integration is OFF; cache sync skipped and no Codex files changed.");
      break;
    }
    const restartFence = captureCatalogRestartFence(restartCodex);
    const { withCatalogWriteSerialization } = await import("../codex/catalog-write-serialization");
    const { invalidateCodexModelsCacheWithPermit } = await import("../codex/catalog/sync");
    const { getCodexHome } = await import("../codex/paths");
    const owningCodexHome = getCodexHome();
    const invalidated = withCatalogWriteSerialization(owningCodexHome, permit =>
      invalidateCodexModelsCacheWithPermit(permit, owningCodexHome));
    // Cache invalidation remains its own advanced command. Its exact cache mtime
    // is the evidence boundary, so only workers proven older than this write are
    // eligible for explicit interruption.
    if (invalidated.kind === "completed" && invalidated.value) {
      if (restartCodex) {
        const applied = await applyInvalidatedCacheWorkers(
          bindCacheArtifactForApply(restartFence),
        );
        if (!applied) {
          console.error("The saved configuration could not be fenced before cache invalidation; no Codex worker was stopped.");
          process.exitCode = 1;
        } else if (!reportCatalogWorkerApply(applied)) {
          process.exitCode = 1;
        }
      } else {
        await warnAfterCatalogWrite("cache");
      }
    }
    break;
  }
  case "gui": {
    const ensured = await ensureProxyLifecycle({
      honorAutoStart: false,
      ensureCompanion: true,
      replaceStaleRuntime: true,
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
    // Mint through the attested admin channel, then hand the short-lived bearer
    // to the browser without putting it in a launcher argv or console line.
    const guiHost = probeHostname(live.hostname);
    const baseUrl = `http://${guiHost}:${live.port}`;
    try {
      const { mintConfirmedGuiLaunch, openConfirmedGuiUrl } = await import("./gui-launch");
      const launch = await mintConfirmedGuiLaunch(baseUrl, live.port, "dashboard");
      console.log(`Opening ${launch.origin}`);
      openConfirmedGuiUrl(launch.url);
    } catch (error) {
      console.error(`❌ ${error instanceof Error ? error.message : "Could not open the CodexCommander dashboard."}`);
      process.exitCode = 1;
    }
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
        console.error("Usage: ccx codex-shim <install|status|uninstall|remove>");
        process.exit(1);
    }
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
  case "restart": {
    const result = await restartProxyLifecycle({
      ensureCompanion: true,
      replaceStaleRuntime: true,
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
  case "ready":
    // Fail-closed impossible-state guard: readyArgs is populated by the
    // preparse block before maybeAutoRestoreCodexShim, so reaching here
    // without it means dispatch diverged. Refuse with code 64 and perform
    // NO I/O (no discovery/probe). process.exit is `never`, narrowing below.
    if (!readyArgs) process.exit(64);
    await handleReady(readyArgs);
    break;
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
    if (args[1] !== "combo" && args[1] !== "policy") {
      console.error("Usage: ccx route <combo|policy> <subcommand>");
      process.exitCode = 2;
      break;
    }
    if (args[1] === "combo") {
      const { handleComboCommand } = await import("./combo");
      process.exitCode = await handleComboCommand(args.slice(2));
    } else {
      const { handleRoutePolicyCommand } = await import("./route-policy");
      process.exitCode = await handleRoutePolicyCommand(args.slice(2));
    }
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
    } else if (integration === "client") {
      const { handleClientIntegrationCommand } = await import("./integrations");
      process.exitCode = await handleClientIntegrationCommand(args.slice(2));
    } else {
      console.error("Usage: ccx integration <claude|grok|client> <subcommand>");
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
    // "ccx claude desktop" → write Desktop 3P config
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

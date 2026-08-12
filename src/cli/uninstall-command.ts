import { getConfigDir } from "../config";
import {
  restoreNativeCodexAsync,
  restoreNativeCodexRoutingEscape,
} from "../codex/inject";
import { stripGrokConfig } from "../grok/inject";
import { removeOwnedConfigArtifactsRetainingLifecycleRoot } from "../lib/config-ownership";
import { acquireProxyLifecycleAuthority } from "../server/proxy-lifecycle-authority";
import { proxyStillLiveAfterStop, uninstallServiceIfInstalled } from "../service";
import { revertSystemEnv } from "../server/system-env";
import { uninstallShellHook } from "../server/system-env";
import {
  stopProxyLifecycleUnderAuthority,
  type ProxyLifecycleLogger,
} from "./proxy-lifecycle";

export interface UninstallCommandLogger extends ProxyLifecycleLogger {
  log(message: string): void;
}

const consoleLogger: UninstallCommandLogger = {
  log: message => console.log(message),
  info: message => console.log(message),
  warn: message => console.error(`⚠️  ${message}`),
  error: message => console.error(`❌ ${message}`),
};

/** Full uninstall retains E from the native-safe Stop through terminal cleanup. */
export async function runUninstallCommand(
  logger: UninstallCommandLogger = consoleLogger,
): Promise<number> {
  let authority: Awaited<ReturnType<typeof acquireProxyLifecycleAuthority>>;
  try {
    authority = await acquireProxyLifecycleAuthority({ includeStart: true });
  } catch (error) {
    logger.error(`Uninstall could not acquire lifecycle authority: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const failures: string[] = [];
  const runStep = async (
    label: string,
    step: () => void | boolean | Promise<void | boolean>,
  ): Promise<void> => {
    try {
      const changed = await step();
      logger.log(changed === false ? `- ${label}: not installed` : `✅ ${label}`);
    } catch (error) {
      failures.push(label);
      logger.warn(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  try {
    const stopped = await stopProxyLifecycleUnderAuthority({ logger }, authority);
    if (!stopped.ok) {
      logger.error(`Uninstall stopped before removing anything: ${stopped.message}`);
      return 1;
    }
    logger.log(`✅ ${stopped.message}`);

    await runStep("service removed", () => uninstallServiceIfInstalled());
    if (process.platform === "win32") {
      await runStep("Windows tray removed", async () => {
        const { getWindowsTrayStatus, uninstallWindowsTray } = await import("../tray/windows");
        const tray = getWindowsTrayStatus();
        if (!tray.installed && !tray.stale && !tray.running) return false;
        uninstallWindowsTray();
      });
    }
    await runStep("native Codex restored", async () => {
      const restored = await restoreNativeCodexAsync();
      if (!restored.success) throw new Error(restored.message);
    });
    await runStep("Grok Build config restored", () => {
      const restored = stripGrokConfig();
      if (!restored.ok) throw new Error(restored.message);
      return restored.changed;
    });
    await runStep("system env vars reverted", () => {
      const restored = revertSystemEnv();
      if (!restored.reverted && restored.reason !== "no tracking file" && restored.reason !== "not macOS") {
        throw new Error(restored.reason ?? "revert failed");
      }
    });
    await runStep("shell hook removed", () => {
      const restored = uninstallShellHook();
      if (!restored.removed && restored.reason !== "not installed" && restored.reason !== "not macOS") {
        throw new Error(restored.reason ?? "remove failed");
      }
    });
    await runStep("Codex autostart shim removed", async () => {
      const { uninstallCodexShim } = await import("../codex/shim");
      return uninstallCodexShim().removed;
    });

    // E still excludes Start while both terminal properties are re-proven.
    await runStep("native Codex routing verified", () => {
      const native = restoreNativeCodexRoutingEscape();
      if (!native.success) throw new Error(native.message);
      return true;
    });
    await runStep("proxy absence verified", async () => {
      const survivor = await proxyStillLiveAfterStop();
      if (survivor) throw new Error(`a proxy is still listening on port ${survivor.port}`);
      return true;
    });

    if (failures.length === 0) {
      await runStep("CodexCommander local artifacts removed", () => {
        const result = removeOwnedConfigArtifactsRetainingLifecycleRoot(getConfigDir());
        if (result.status === "retained-root") return true;
        const residual = result.residualPaths.length > 0
          ? ` Residual path(s): ${result.residualPaths.join(", ")}`
          : "";
        throw new Error(`${result.status} uninstall: ${result.reason ?? "config artifacts were not removed"}.${residual}`);
      });
    } else {
      logger.error("Leaving CodexCommander config/backups in place so the failed restore step can be retried.");
    }

    if (failures.length > 0) {
      logger.error(`Uninstall finished with ${failures.length} failed step(s): ${failures.join(", ")}`);
      return 1;
    }
    logger.log("✅ CodexCommander local artifacts removed; lifecycle ownership metadata retained.");
    return 0;
  } finally {
    authority.releaseAll();
  }
}

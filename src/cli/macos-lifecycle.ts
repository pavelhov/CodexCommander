import {
  ensureProxyLifecycle,
  proxyLifecycleStatus,
  restoreBackRoutingLifecycle,
  restoreNativeRoutingLifecycle,
  restartProxyLifecycle,
  stopProxyLifecycle,
  type ProxyLifecycleAction,
  type ProxyLifecycleResult,
} from "./proxy-lifecycle";
import { prepareMacOSAppStart } from "./macos-first-run";
import {
  APPLY_CODEX_CATALOG_ACTION,
  type ApplyCodexCatalogLifecycleResult,
} from "../codex/catalog-apply";
import { applyCodexCatalogForCompanion } from "./catalog-activation";

export const MACOS_LIFECYCLE_HELPER_COMMAND = "__macos-lifecycle";
export const MACOS_LIFECYCLE_JSON_MAX_BYTES = 2 * 1024;

export type MacOSLifecycleAction = ProxyLifecycleAction | typeof APPLY_CODEX_CATALOG_ACTION;
export type MacOSLifecycleResult = ProxyLifecycleResult | ApplyCodexCatalogLifecycleResult;

const allowedActions = new Set<MacOSLifecycleAction>([
  "status",
  "ensure",
  "start",
  "stop",
  "restart",
  "restore-native",
  "restore-back",
  APPLY_CODEX_CATALOG_ACTION,
]);

function failedResult(action: MacOSLifecycleAction): MacOSLifecycleResult {
  if (action === APPLY_CODEX_CATALOG_ACTION) {
    return {
      schemaVersion: 1,
      action,
      ok: false,
      state: "failed",
      changed: false,
      pid: null,
      port: null,
      message: "Agent catalog update did not complete.",
      errorCode: "SYNC_FAILED",
      catalogUpdated: false,
      codexRestartRequired: false,
      staleWorkerCount: 0,
      stoppedWorkerCount: 0,
      survivingWorkerCount: 0,
    };
  }
  return {
    schemaVersion: 1,
    action,
    ok: false,
    state: "failed",
    changed: false,
    pid: null,
    port: null,
    message: "CodexCommander lifecycle action failed.",
    errorCode: action === "stop" || action === "restore-native"
      ? "STOP_FAILED"
      : action === "restore-back"
        ? "SYNC_FAILED"
        : "START_FAILED",
  };
}

export function encodeMacOSLifecycleResult(
  action: MacOSLifecycleAction,
  result: MacOSLifecycleResult,
): { frame: string; exitCode: 0 | 1 } {
  let emitted = result;
  let frame = `${JSON.stringify(emitted)}\n`;
  if (Buffer.byteLength(frame, "utf8") > MACOS_LIFECYCLE_JSON_MAX_BYTES) {
    emitted = failedResult(action);
    frame = `${JSON.stringify(emitted)}\n`;
  }
  return { frame, exitCode: emitted.ok ? 0 : 1 };
}

export interface MacOSLifecycleDeps {
  ensureProxyLifecycle?: typeof ensureProxyLifecycle;
  prepareMacOSAppStart?: typeof prepareMacOSAppStart;
}

export async function performMacOSLifecycleAction(
  action: MacOSLifecycleAction,
  deps: MacOSLifecycleDeps = {},
): Promise<MacOSLifecycleResult> {
  const ensure = deps.ensureProxyLifecycle ?? ensureProxyLifecycle;
  switch (action) {
    case "status":
      return proxyLifecycleStatus();
    case "ensure":
      return ensure({
        action,
        honorAutoStart: false,
        ensureCompanion: false,
        replaceStaleRuntime: true,
      });
    case "start":
      return ensure({
        action,
        honorAutoStart: false,
        ensureCompanion: false,
        replaceStaleRuntime: true,
        io: { prepareStart: deps.prepareMacOSAppStart ?? prepareMacOSAppStart },
      });
    case "stop":
      return stopProxyLifecycle();
    case "restart":
      return restartProxyLifecycle({ ensureCompanion: false, replaceStaleRuntime: true });
    case "restore-native":
      return restoreNativeRoutingLifecycle();
    case "restore-back":
      return restoreBackRoutingLifecycle({ replaceStaleRuntime: true });
    case APPLY_CODEX_CATALOG_ACTION:
      return applyCodexCatalogForCompanion();
  }
}

/**
 * Fixed app bridge: one allowlisted verb, one bounded secret-free JSON object on stdout.
 * Runtime diagnostics are suppressed for this process so they cannot corrupt the frame
 * or accidentally become an app-visible path/error channel.
 */
export async function runMacOSLifecycleHelper(args: string[]): Promise<number> {
  const requested = args.length === 1 ? args[0] : undefined;
  if (!requested || !allowedActions.has(requested as MacOSLifecycleAction)) {
    const invalid = failedResult("status");
    invalid.message = "Unsupported CodexCommander lifecycle action.";
    process.stdout.write(`${JSON.stringify(invalid)}\n`);
    return 2;
  }
  const action = requested as MacOSLifecycleAction;
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  let result: MacOSLifecycleResult;
  try {
    result = await performMacOSLifecycleAction(action);
  } catch {
    result = failedResult(action);
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  const encoded = encodeMacOSLifecycleResult(action, result);
  process.stdout.write(encoded.frame);
  return encoded.exitCode;
}

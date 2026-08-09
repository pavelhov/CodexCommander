import {
  ensureProxyLifecycle,
  proxyLifecycleStatus,
  restartProxyLifecycle,
  stopProxyLifecycle,
  type ProxyLifecycleAction,
  type ProxyLifecycleResult,
} from "./proxy-lifecycle";
import {
  APPLY_CODEX_CATALOG_ACTION,
  applyCodexCatalog,
  type ApplyCodexCatalogLifecycleResult,
} from "../codex/catalog-apply";

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
    message: "OpenCodex lifecycle action failed.",
    errorCode: action === "stop" ? "STOP_FAILED" : "START_FAILED",
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

async function perform(action: MacOSLifecycleAction): Promise<MacOSLifecycleResult> {
  switch (action) {
    case "status":
      return proxyLifecycleStatus();
    case "ensure":
    case "start":
      return ensureProxyLifecycle({
        action,
        honorAutoStart: false,
        ensureCompanion: false,
      });
    case "stop":
      return stopProxyLifecycle();
    case "restart":
      return restartProxyLifecycle({ ensureCompanion: false });
    case APPLY_CODEX_CATALOG_ACTION:
      return applyCodexCatalog();
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
    invalid.message = "Unsupported OpenCodex lifecycle action.";
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
    result = await perform(action);
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

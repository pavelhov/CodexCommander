import {
  ensureProxyLifecycle,
  proxyLifecycleStatus,
  restartProxyLifecycle,
  stopProxyLifecycle,
  type ProxyLifecycleAction,
  type ProxyLifecycleResult,
} from "./proxy-lifecycle";

export const MACOS_LIFECYCLE_HELPER_COMMAND = "__macos-lifecycle";
export const MACOS_LIFECYCLE_JSON_MAX_BYTES = 2 * 1024;

const allowedActions = new Set<ProxyLifecycleAction>([
  "status",
  "ensure",
  "start",
  "stop",
  "restart",
]);

function failedResult(action: ProxyLifecycleAction): ProxyLifecycleResult {
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
  action: ProxyLifecycleAction,
  result: ProxyLifecycleResult,
): { frame: string; exitCode: 0 | 1 } {
  let emitted = result;
  let frame = `${JSON.stringify(emitted)}\n`;
  if (Buffer.byteLength(frame, "utf8") > MACOS_LIFECYCLE_JSON_MAX_BYTES) {
    emitted = failedResult(action);
    frame = `${JSON.stringify(emitted)}\n`;
  }
  return { frame, exitCode: emitted.ok ? 0 : 1 };
}

async function perform(action: ProxyLifecycleAction): Promise<ProxyLifecycleResult> {
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
  }
}

/**
 * Fixed app bridge: one allowlisted verb, one bounded secret-free JSON object on stdout.
 * Runtime diagnostics are suppressed for this process so they cannot corrupt the frame
 * or accidentally become an app-visible path/error channel.
 */
export async function runMacOSLifecycleHelper(args: string[]): Promise<number> {
  const requested = args.length === 1 ? args[0] : undefined;
  if (!requested || !allowedActions.has(requested as ProxyLifecycleAction)) {
    const invalid = failedResult("status");
    invalid.message = "Unsupported OpenCodex lifecycle action.";
    process.stdout.write(`${JSON.stringify(invalid)}\n`);
    return 2;
  }
  const action = requested as ProxyLifecycleAction;
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
  let result: ProxyLifecycleResult;
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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isServiceOwnershipError, ServiceOwnershipError } from "../src/service";

const CLI_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
const INIT_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "init.ts"), "utf8");
const MACOS_LIFECYCLE_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "macos-lifecycle.ts"), "utf8");
const LIFECYCLE_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "proxy-lifecycle.ts"), "utf8");
const SERVICE_COMMAND_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "service-command.ts"), "utf8");
const MANAGEMENT_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "server", "management-api.ts"), "utf8");
const PROCESS_CONTROL_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "lib", "process-control.ts"), "utf8");

function sliceFn(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

// `src/cli/index.ts` runs its command switch on import, so the remaining command-dispatch
// assertions read that thin entrypoint. Foreground startup itself is covered through the
// dependency-injected module in tests/foreground-proxy.test.ts.
describe("Grok fence lifecycle wiring", () => {
  test("legacy tray Start uses explicit start semantics instead of automatic ensure", () => {
    const trayStart = sliceFn(CLI_SOURCE, "async function handleTrayProxyStart(", "async function handleTrayProxyRestart(");
    expect(trayStart).toContain('action: "start"');
    expect(trayStart).toContain("honorAutoStart: false");
    expect(trayStart).toContain("replaceStaleRuntime: true");
  });

  test("every background startup and Route Back entry point opts into attested stale recovery", () => {
    const ensure = sliceFn(CLI_SOURCE, "async function handleEnsure(", "/** Fixed tray action");
    const trayRestart = sliceFn(CLI_SOURCE, "async function handleTrayProxyRestart(", "async function handleStop(");
    const restore = sliceFn(CLI_SOURCE, 'case "restore":', 'case "doctor":');
    const gui = sliceFn(CLI_SOURCE, 'case "gui":', 'case "service":');
    const restart = sliceFn(CLI_SOURCE, 'case "restart":', 'case "ready":');
    const initRoute = sliceFn(INIT_SOURCE, "export async function routeCodexThroughLiveProxyFromInit(", "function replaceSetupConfigPreservingIntegrationIntent(");
    const macRestart = sliceFn(MACOS_LIFECYCLE_SOURCE, 'case "restart":', 'case "restore-native":');

    for (const source of [ensure, trayRestart, restore, gui, restart, initRoute, macRestart]) {
      expect(source).toContain("replaceStaleRuntime: true");
    }
  });

  test("ensure syncs Grok against the observed live bind host", () => {
    const syncFn = sliceFn(LIFECYCLE_SOURCE, "async function syncLiveProxy(", "export async function proxyLifecycleStatus(");
    // The live hostname is authoritative after either an existing or newly spawned proxy.
    expect(syncFn).toContain("live.hostname ? { hostname: live.hostname }");
  });

  test("handleStop restores native routing before service admission and termination", () => {
    const serviceStopFn = sliceFn(LIFECYCLE_SOURCE, "function stopLifecycleService(", "interface ManagedStateRestoreResult");
    const stopFn = sliceFn(LIFECYCLE_SOURCE, "export async function stopProxyLifecycle(", "export async function restartProxyLifecycle(");

    expect(serviceStopFn).toContain("isServiceOwnershipError(error)");
    expect(serviceStopFn).toContain("blocked: true");
    const admissionAt = stopFn.indexOf("if (admission.blocked)");
    const restoreAt = stopFn.indexOf("restoreManagedClientState(logger, io)");
    const serviceAt = stopFn.indexOf("stopLifecycleService(logger, admission.installed");
    const terminateAt = stopFn.indexOf("await (io.stopProxy ?? stopProxy)(pid,");
    expect(admissionAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(-1);
    expect(admissionAt).toBeGreaterThan(restoreAt);
    expect(serviceAt).toBeGreaterThan(admissionAt);
    expect(terminateAt).toBeGreaterThan(serviceAt);
    expect(stopFn.slice(restoreAt, serviceAt)).toContain("if (!restored.ok)");
    expect(stopFn.slice(restoreAt, serviceAt)).toContain("CodexCommander stayed running");
  });

  test("a refused Grok strip makes ccx stop fail instead of reporting success", () => {
    const restoreFn = sliceFn(LIFECYCLE_SOURCE, "function restoreManagedClientState(", "/** Shared server-side preparation");
    expect(restoreFn).toContain("else if (!grok.ok)");
    expect(restoreFn).toContain("ok = false");
  });

  test("a refused proxy stop reports WHY, not just that it failed", () => {
    const stopFn = sliceFn(LIFECYCLE_SOURCE, "export async function stopProxyLifecycle(", "export async function restartProxyLifecycle(");
    // stopProxy throws the ownership refusal ("run the stop from that home"). A bare
    // `catch {}` on these call sites strands the operator on a generic failure line, whose
    // natural next move is a manual kill — the teardown the 409 guard exists to prevent.
    const bareCatchAfterStopProxy = /await stopProxy\([^)]*\);[\s\S]{0,400}?\}\s*catch\s*\{/;
    expect(stopFn).not.toMatch(bareCatchAfterStopProxy);

    // Every proxy-stop error path binds the error and echoes its message.
    const detailEchoes = stopFn.match(/const detail = error instanceof Error \? error\.message : String\(error\);/g);
    expect(detailEchoes).toHaveLength(3);
    expect(stopFn.match(/if \(detail\) logger\.error\(detail\);/g)).toHaveLength(3);
  });

  test("handleStop returns its outcome so restart and the tray can react", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleStatus(");
    // process.exit() inside handleStop would strand runTrayProxyRestart's start() half.
    expect(stopFn).toContain("process.exitCode = 1");
    expect(stopFn).toContain("return result.ok");
    expect(stopFn).not.toContain("process.exit(1)");

    const restartAt = LIFECYCLE_SOURCE.indexOf("export async function restartProxyLifecycle(");
    expect(restartAt).toBeGreaterThan(-1);
    const restartFn = LIFECYCLE_SOURCE.slice(restartAt);
    expect(restartFn).toContain("if (!stopped.ok) return stopped");
    expect(restartFn).toContain("ensureProxyLifecycleUnderLock(");
  });

  test("handleStop treats an incomplete native Codex restore as a stop failure", () => {
    const restoreFn = sliceFn(LIFECYCLE_SOURCE, "function restoreManagedClientState(", "/** Shared server-side preparation");
    expect(restoreFn).toContain("if (restore.success)");
    expect(restoreFn).toContain("ok = false");
    expect(restoreFn).toContain("logger.warn(restore.message)");
  });

});

describe("service teardown owns both managed configs", () => {
  test("service stop strips the Grok fence and guards the platform stop on installation", () => {
    const prepare = sliceFn(
      SERVICE_COMMAND_SOURCE,
      "export function prepareServiceRoutingForTermination(",
      "type ServingVerb",
    );
    const quiesce = sliceFn(
      SERVICE_COMMAND_SOURCE,
      "async function quiesceForLifecycleCommand(",
      "export async function runServiceLifecycleCommand(",
    );
    expect(prepare).toContain("restoreNativeCodexRoutingForStop");
    expect(prepare).toContain("stripGrokConfig");
    // An unguarded manager stop ran a real unload even with nothing installed.
    expect(quiesce).toContain('before.registrationState === "present"');
    expect(quiesce).toContain("deps.stopInstalledService()");
  });

  test("service uninstall strips the Grok fence too", () => {
    const command = sliceFn(
      SERVICE_COMMAND_SOURCE,
      "export async function runServiceLifecycleCommand(",
      "export async function serviceCommand(",
    );
    expect(command).toContain('command === "uninstall"');
    expect(command).toContain("quiesceForLifecycleCommand(action, authority, deps)");
    expect(command).toContain("deps.removeState()");
  });
});

describe("ownership errors are distinguishable", () => {
  test("ownership mismatch is its own error type, plain failures are not", () => {
    expect(isServiceOwnershipError(new ServiceOwnershipError("mismatch"))).toBe(true);
    // Misclassifying an ordinary stop failure would block teardown that is safe to run.
    expect(isServiceOwnershipError(new Error("launchctl exited 1"))).toBe(false);
    expect(isServiceOwnershipError("not an error")).toBe(false);
  });

  test("the guard still throws the documented message", () => {
    expect(new ServiceOwnershipError("Service was installed with CODEX_HOME=/a").message)
      .toContain("Service was installed with CODEX_HOME");
  });
});

describe("POST /api/stop teardown", () => {
  test("refuses with 409 on ownership mismatch instead of throwing a 500", () => {
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");
    const prepareFn = sliceFn(LIFECYCLE_SOURCE, "export function prepareExplicitProxyShutdown(", "export async function stopProxyLifecycle(");

    expect(prepareFn).toContain("if (admission.blocked)");
    expect(prepareFn).toContain("status: 409");
    expect(prepareFn.indexOf("restoreManagedClientState(quietLogger)"))
      .toBeLessThan(prepareFn.indexOf("stopLifecycleService(quietLogger, admission.installed)"));
    expect(prepareFn).toContain("Native client routing could not be restored; CodexCommander stayed running.");
    expect(handler).toContain("prepared.status");
    // The refusal must return BEFORE the shutdown is scheduled: a refused stop keeps running.
    const refusalAt = handler.indexOf("409");
    const shutdownAt = handler.indexOf("drainAndShutdown");
    expect(refusalAt).toBeLessThan(shutdownAt);
  });

  test("strips the Grok fence on an accepted stop", () => {
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");
    const restoreFn = sliceFn(LIFECYCLE_SOURCE, "function restoreManagedClientState(", "/** Shared server-side preparation");
    expect(handler).toContain("lifecycle.prepareShutdown");
    expect(handler).toContain(".prepareExplicitProxyShutdown");
    expect(restoreFn).toContain("stripGrokConfig)()");
  });

  test("a 409 does not escalate to a forced kill", () => {
    // Escalating would run the daemon's cleanup and strip shared config while the foreign
    // service keeps the proxy alive — the exact hole the ownership gate exists to close.
    expect(PROCESS_CONTROL_SOURCE).toContain('if (res.status === 409) return "refused"');

    const stopProxyFn = sliceFn(PROCESS_CONTROL_SOURCE, "export async function stopProxy(", "export function killProxy(");
    const refusedAt = stopProxyFn.indexOf('graceful === "refused"');
    const killAt = stopProxyFn.indexOf("killProxyWithAuthorization(pid");
    expect(refusedAt).toBeGreaterThan(-1);
    expect(refusedAt).toBeLessThan(killAt);
    expect(stopProxyFn).toContain("throw new Error(");
  });
});

/**
 * Dashboard proxy restart admission.
 *
 * The serving process does not drain, stop its listener, mutate routing, or exit.
 * It only proves that one detached `__tray-restart` helper reached OS spawn. The
 * helper then uses the same canonical lifecycle as the tray: safe Stop restores
 * native Codex and persists OFF before termination, followed by explicit Start.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { getActiveTurnCount } from "../lifecycle";
import { withProcessRuntimeProvenance } from "../../lib/bun-runtime";

/** The API no longer owns a drain window; retained for the response schema. */
export const SYSTEM_RESTART_DRAIN_TIMEOUT_MS = 0;

const INHERITABLE_HARDENED_BUN_FLAGS = new Set([
  "--no-install",
  "--no-env-file",
  "--config=/dev/null",
]);

export interface DetachedRestartSpawnOptions {
  spawnFn?: typeof spawn;
  entry?: string;
  execArgv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface SystemRestartIo {
  /** Resolve only after OS spawn; call onExit if the helper later exits. */
  spawnHelper?: (onExit: () => void) => Promise<void>;
  getActiveTurnCount?: () => number;
}

interface SystemRestartAdmissionBase {
  activeTurnCount: number;
  drainTimeoutMs: number;
}

export type SerializedSystemRestartResult =
  | (SystemRestartAdmissionBase & { kind: "accepted" })
  | (SystemRestartAdmissionBase & { kind: "already-accepted" })
  | (SystemRestartAdmissionBase & { kind: "refused"; message: string });

let restartIo: SystemRestartIo = {};
let acceptedGeneration: symbol | undefined;
let restartAdmission: Promise<SerializedSystemRestartResult> | undefined;

/** Test seam — reset between tests. */
export function setSystemRestartIoForTests(io: SystemRestartIo = {}): void {
  restartIo = io;
  acceptedGeneration = undefined;
  restartAdmission = undefined;
}

/**
 * Re-exec only the current fixed CLI entry and internal restart command.
 * Packaged app runtimes retain their three hardened Bun flags; arbitrary debug,
 * eval, preload, or caller-selected flags are never forwarded.
 */
export function trayRestartHelperArgv(
  entry = process.argv[1],
  execArgv: readonly string[] = process.execArgv,
): string[] {
  if (!entry) throw new Error("CodexCommander CLI entry is unavailable");
  const seen = new Set<string>();
  const safeRuntimeFlags = execArgv.filter((arg) => {
    if (!INHERITABLE_HARDENED_BUN_FLAGS.has(arg) || seen.has(arg)) return false;
    seen.add(arg);
    return true;
  });
  return [...safeRuntimeFlags, entry, "__tray-restart"];
}

/**
 * Spawn the canonical tray restart helper and resolve only after the child's
 * `spawn` event. The exit listener intentionally remains after `unref()`: if
 * the helper refuses before Stop, the old endpoint is still live and may retry.
 */
export function spawnDetachedTrayRestart(
  onExit: () => void,
  options: DetachedRestartSpawnOptions = {},
): Promise<void> {
  const spawnFn = options.spawnFn ?? spawn;
  const childEnv = { ...(options.env ?? process.env) };
  // A management helper is never itself a supervised service child. Inheriting
  // this marker could suppress canonical native cleanup on a failed restart.
  delete childEnv.CCX_SERVICE;

  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(
        process.execPath,
        trayRestartHelperArgv(options.entry, options.execArgv),
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: withProcessRuntimeProvenance(childEnv),
        },
      );
    } catch {
      reject(new Error("restart_helper_spawn_refused"));
      return;
    }

    let spawnProven = false;
    let settled = false;
    const rejectBeforeSpawn = () => {
      if (settled) return;
      settled = true;
      child.off("spawn", handleSpawn);
      child.off("error", handleError);
      reject(new Error("restart_helper_spawn_refused"));
    };
    const handleError = () => {
      if (spawnProven) {
        onExit();
        return;
      }
      rejectBeforeSpawn();
    };
    const handleExit = () => {
      onExit();
      if (!spawnProven) rejectBeforeSpawn();
    };
    const handleSpawn = () => {
      if (settled) return;
      settled = true;
      spawnProven = true;
      child.unref();
      resolve();
    };

    child.once("error", handleError);
    child.once("exit", handleExit);
    child.once("spawn", handleSpawn);
  });
}

function snapshot(io: SystemRestartIo): SystemRestartAdmissionBase {
  return {
    activeTurnCount: (io.getActiveTurnCount ?? getActiveTurnCount)(),
    drainTimeoutMs: SYSTEM_RESTART_DRAIN_TIMEOUT_MS,
  };
}

function alreadyAccepted(io: SystemRestartIo): SerializedSystemRestartResult {
  return { kind: "already-accepted", ...snapshot(io) };
}

async function admitSystemRestart(io: SystemRestartIo): Promise<SerializedSystemRestartResult> {
  const generation = Symbol("dashboard-restart");
  let helperExited = false;
  const onExit = () => {
    helperExited = true;
    if (acceptedGeneration === generation) acceptedGeneration = undefined;
  };

  try {
    await (io.spawnHelper ?? ((exit) => spawnDetachedTrayRestart(exit)))(onExit);
    // A child that spawned and died before admission returned is not useful
    // acceptance; the live parent stays retryable.
    if (helperExited) throw new Error("restart_helper_exited");
    acceptedGeneration = generation;
    return { kind: "accepted", ...snapshot(io) };
  } catch {
    if (acceptedGeneration === generation) acceptedGeneration = undefined;
    return {
      kind: "refused",
      ...snapshot(io),
      message: "Restart helper could not be started; the proxy is still running. Retry Restart.",
    };
  }
}

/**
 * Single-flight helper spawn admission. Duplicate requests are accepted without
 * starting another helper. A spawn refusal or early helper exit re-arms retry.
 */
export async function acceptSerializedSystemRestart(
  io: SystemRestartIo = restartIo,
): Promise<SerializedSystemRestartResult> {
  if (acceptedGeneration) return alreadyAccepted(io);
  if (restartAdmission) {
    const result = await restartAdmission;
    return result.kind === "accepted" ? alreadyAccepted(io) : result;
  }

  const admission = admitSystemRestart(io);
  restartAdmission = admission;
  try {
    return await admission;
  } finally {
    if (restartAdmission === admission) restartAdmission = undefined;
  }
}

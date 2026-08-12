/**
 * `ccx service` — run the proxy as a background service that auto-starts on login and
 * auto-restarts on crash. macOS → launchd; Windows → Task Scheduler; Linux → systemd user unit.
 * The service sets CCX_SERVICE=1 so the proxy's shutdown handler does NOT restore native
 * Codex on a service-managed restart (the restarted instance re-injects); explicit stop/uninstall
 * restore it via the command.
 */
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { findLiveProxy, proxyIdentityAt, SERVICE_STOP_LIVENESS } from "./server/proxy-liveness";
import { existsSync, linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandUserPath, getConfigDir, readPid, removePid, removeRuntimePort, verifyPidIdentity } from "./config";
import { loadConfig } from "./config";
import { isWslRuntime } from "./codex/home";
import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV, durableBunRuntime } from "./lib/bun-runtime";
import type { BunRuntimeSource } from "./lib/bun-runtime";
import { isProcessAlive, stopProxy } from "./lib/process-control";
import type { ProxyLifecycleLockLease } from "./server/proxy-lifecycle-protocol";
import { serviceApiTokenFilePath } from "./lib/service-secrets";
import { randomUUID } from "node:crypto";
import {
  ELEVATION_REQUEST_TIMEOUT_MS,
  CCX_ELEVATED_PROTOCOL_FAILED,
  raceWithTimeout,
  resolveTrustedWindowsSchtasksExe,
  startElevatedSchtasksCreateAndRun,
  runWindowsElevated,
  toWindowsSchtasksError,
  WindowsElevationError,
  type ElevatedSchedulerOutcome,
  type ElevatedSchtasksCreateAndRunExecution,
  type ElevatedSchtasksCreateAndRunResult,
} from "./lib/windows-elevation";
import { defaultWinswEntry, installWinswService, startWinswService, stopWinswService, statusWinswRaw, uninstallWinswService, winswScmDefinitionOwned, winswStatusSummary, winswXmlPath, WINSW_SERVICE_ID, WINSW_SHA256, WINSW_VERSION } from "./lib/winsw";
import { hardenSecretDir, hardenSecretPath } from "./lib/windows-secret-acl";
import { windowsEnvIndirectBatchPathList, windowsEnvIndirectBatchValue } from "./lib/win-paths";
import { recordOwnedConfigPath } from "./lib/config-ownership";
import { assertPrivateServiceFile, ensurePrivateServiceDirectory, removeOwnedPrivateServiceFile, writePrivateServiceFile } from "./lib/service-files";
import {
  HOME_ENV,
  SERVICE_LABEL,
  SERVICE_TASK,
} from "./identity";

const LABEL = SERVICE_LABEL;
const TASK = SERVICE_TASK;

export type ServiceBackend = "scheduler" | "native";

/** Registration and runtime truth are deliberately independent. */
export type ServiceRegistrationState = "present" | "absent" | "indeterminate";
export type ServiceSupervisorState = "active" | "inactive" | "indeterminate";

export interface ServiceSupervisorProbe {
  registrationState: ServiceRegistrationState;
  supervisorState: ServiceSupervisorState;
  /** null means the manager could not answer the enablement question. */
  enabled: boolean | null;
  detail?: string;
}

function combineRegistrationStates(
  ...states: ServiceRegistrationState[]
): ServiceRegistrationState {
  if (states.includes("present")) return "present";
  return states.includes("indeterminate") ? "indeterminate" : "absent";
}

function combineSupervisorStates(
  ...states: ServiceSupervisorState[]
): ServiceSupervisorState {
  if (states.includes("active")) return "active";
  return states.includes("indeterminate") ? "indeterminate" : "inactive";
}

function cliEntry(): { bun: string; bunRuntimeSource: BunRuntimeSource; cli: string } {
  // Bake the bundled Bun shipped with the installed package rather than
  // a transient system Bun, so launchd/systemd/schtasks keep resolving even if a
  // standalone Bun is later removed. The CLI entry lives at src/cli/index.ts.
  //
  // Path and provenance come from ONE resolution so the marker can never describe a
  // different binary than the one actually baked.
  const runtime = durableBunRuntime();
  return { bun: runtime.path, bunRuntimeSource: runtime.source, cli: join(import.meta.dir, "cli", "index.ts") };
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function launchdLabel(): string {
  return LABEL;
}

function launchdLabels(): readonly string[] {
  return [LABEL];
}

/** Stable, user-facing launchd executable name shown by macOS Login Items. */
export function launchdExecutablePath(): string {
  return join(getConfigDir(), "CodexCommander");
}

const LAUNCHD_EXECUTABLE_MARKER = "# CodexCommander managed launchd launcher v1";

function launchdExecutableOwnedContent(content: string): boolean {
  // The launcher shape is `#!/bin/sh\n<marker>\nexec ...`: the marker is the
  // SECOND line. startsWith never matched (the shebang is first), which read
  // every managed launcher as foreign and refused its upgrade. Match the exact
  // marker line position instead.
  const secondLine = content.split("\n")[1];
  return secondLine === LAUNCHD_EXECUTABLE_MARKER;
}

type LaunchdExecutableDeps = {
  readInstallState?: () => ServiceInstallState | null;
  readPlist?: () => string;
};

function buildLaunchdExecutable(bun: string): string {
  // A regular unsigned file gives macOS a stable CodexCommander identity. Keeping Bun in
  // this tiny wrapper (instead of a symlink) avoids attributing the Login Item to
  // Bun's signer; "$@" keeps launchd's arguments tokenized rather than re-parsing a
  // command string.
  return `#!/bin/sh\n${LAUNCHD_EXECUTABLE_MARKER}\nexec ${shellQuote(resolve(bun))} "$@"\n`;
}

function launchdPlistTargetsExecutable(text: string, launcher: string): boolean {
  const argumentsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  const firstArgument = argumentsBlock
    ? /<string>([^<]*)<\/string>/.exec(argumentsBlock)?.[1]
    : undefined;
  return firstArgument === plistString(launcher);
}

function installedLaunchdExecutableEvidence(
  launcher: string,
  deps: LaunchdExecutableDeps,
): { state: ServiceInstallState; plist: string } | null {
  const state = (deps.readInstallState ?? readServiceInstallState)();
  if (!state?.bunPath) return null;
  if (normalizePathForCompare(state.codexCommanderHome) !== normalizePathForCompare(getConfigDir())) return null;
  try {
    const plist = (deps.readPlist ?? (() => readFileSync(plistPath(), "utf8")))();
    return launchdPlistTargetsExecutable(plist, launcher) ? { state, plist } : null;
  } catch {
    return null;
  }
}

function sameFsEntry(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function writeLaunchdExecutableNoClobber(launcher: string, content: string): void {
  const temp = `${launcher}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o700 });
    // link(2), unlike rename(2), refuses an existing destination. A file appearing
    // after our absence check is therefore preserved rather than overwritten.
    linkSync(temp, launcher);
  } finally {
    try { unlinkSync(temp); } catch { /* linked or never created */ }
  }
}

function replaceKnownLaunchdExecutable(
  launcher: string,
  before: Stats,
  content: string,
): void {
  const temp = `${launcher}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o700 });
    const current = lstatSync(launcher);
    if (!sameFsEntry(before, current)) {
      throw new Error(`Refusing to replace launchd executable changed during install: ${launcher}`);
    }
    unlinkSync(launcher);
    // Do not let a same-user race turn the update into an overwrite: if something
    // claims the name after unlink, preserve it and fail the install.
    linkSync(temp, launcher);
  } finally {
    try { unlinkSync(temp); } catch { /* linked or never created */ }
  }
}

export function ensureLaunchdExecutable(
  bun = cliEntry().bun,
  deps: LaunchdExecutableDeps = {},
): string {
  const launcher = launchdExecutablePath();
  const desired = buildLaunchdExecutable(bun);
  let metadata: Stats;
  try {
    metadata = lstatSync(launcher);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    writeLaunchdExecutableNoClobber(launcher, desired);
    recordOwnedConfigPath(getConfigDir(), launcher);
    return launcher;
  }

  if (metadata.isFile() && !metadata.isSymbolicLink()) {
    const current = readFileSync(launcher, "utf8");
    if (current === desired && (metadata.mode & 0o111) !== 0) return launcher;
  }

  const installed = installedLaunchdExecutableEvidence(launcher, deps);
  const previouslyManaged = Boolean(installed
    && metadata.isFile()
    && !metadata.isSymbolicLink()
    && launchdExecutableOwnedContent(readFileSync(launcher, "utf8")));
  if (!previouslyManaged) {
    throw new Error(`Refusing to replace foreign launchd executable: ${launcher}`);
  }

  replaceKnownLaunchdExecutable(launcher, metadata, desired);
  recordOwnedConfigPath(getConfigDir(), launcher);
  return launcher;
}

export function removeLaunchdExecutable(deps: LaunchdExecutableDeps = {}): boolean {
  const launcher = launchdExecutablePath();
  try {
    const metadata = lstatSync(launcher);
    const installed = installedLaunchdExecutableEvidence(launcher, deps);
    if (!installed) return false;
    const managed = metadata.isFile()
      && !metadata.isSymbolicLink()
      && launchdExecutableOwnedContent(readFileSync(launcher, "utf8"));
    if (!managed || !sameFsEntry(metadata, lstatSync(launcher))) return false;
    unlinkSync(launcher);
    return true;
  } catch {
    // An absent launcher or an entry we cannot prove is ours is deliberately left
    // alone. Uninstalling a service never grants authority over a foreign path.
    return false;
  }
}

/** Report a missing, outdated, non-executable, or modified managed launchd launcher. */
export function launchdExecutableDiagnostic(deps: LaunchdExecutableDeps = {}): string | null {
  const launcher = launchdExecutablePath();
  const installed = installedLaunchdExecutableEvidence(launcher, deps);
  if (!installed) {
    return `STALE launchd executable registration (${launcher}) — run 'ccx service install' to repair`;
  }
  try {
    const metadata = lstatSync(launcher);
    const healthy = metadata.isFile()
      && !metadata.isSymbolicLink()
      && (metadata.mode & 0o111) !== 0
      && readFileSync(launcher, "utf8") === buildLaunchdExecutable(installed.state.bunPath!);
    return healthy
      ? null
      : `STALE launchd executable (${launcher}) — run 'ccx service install' to repair`;
  } catch {
    return `STALE launchd executable (missing: ${launcher}) — run 'ccx service install' to repair`;
  }
}

function logPath(): string {
  return join(getConfigDir(), "service.log");
}

export function serviceLogPath(): string {
  return logPath();
}

function windowsServiceScriptPath(): string {
  return join(getConfigDir(), "codexcommander-service.cmd");
}

function windowsLauncherVbsPath(): string {
  return join(getConfigDir(), "codexcommander-service-launcher.vbs");
}

function windowsTaskXmlPath(): string {
  return join(getConfigDir(), "codexcommander-service-task.xml");
}

function serviceStatePath(): string {
  return join(getConfigDir(), "service-state.json");
}

function serviceStatePaths(): string[] {
  return [serviceStatePath()];
}

function currentCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? resolve(expandUserPath(raw)) : join(homedir(), ".codex");
}

function currentCodexCommanderHome(): string {
  return getConfigDir();
}

function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface ServiceInstallState {
  version: 3;
  codexHome: string;
  codexCommanderHome: string;
  /** Baked at install; lets status flag paths gone stale after npm prefix/nvm moves. */
  bunPath: string;
  cliPath: string;
  backend: ServiceBackend;
  winswVersion?: string;
  winswSha256?: string;
}

export function parseServiceInstallState(value: unknown): ServiceInstallState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 3) return null;
  if (typeof state.codexHome !== "string" || state.codexHome.length === 0) return null;
  if (typeof state.codexCommanderHome !== "string" || state.codexCommanderHome.length === 0) return null;
  for (const key of ["bunPath", "cliPath"] as const) {
    if (typeof state[key] !== "string" || state[key].length === 0) return null;
  }
  for (const key of ["winswVersion", "winswSha256"] as const) {
    if (state[key] !== undefined && (typeof state[key] !== "string" || state[key].length === 0)) return null;
  }
  if (state.backend !== "scheduler" && state.backend !== "native") return null;
  return state as unknown as ServiceInstallState;
}

export function writeServiceInstallState(backend: ServiceBackend = "scheduler"): void {
  const { bun, cli } = cliEntry();
  const state: ServiceInstallState = {
    version: 3,
    codexHome: currentCodexHome(),
    codexCommanderHome: currentCodexCommanderHome(),
    bunPath: bun,
    cliPath: cli,
    backend,
    ...(backend === "native" ? { winswVersion: WINSW_VERSION, winswSha256: WINSW_SHA256 } : {}),
  };
  for (const path of serviceStatePaths()) {
    recordOwnedConfigPath(getConfigDir(), path);
    ensurePrivateServiceDirectory(dirname(path));
    writePrivateServiceFile(path, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
      ownsExisting: (raw) => {
        const previous = parseServiceInstallState(JSON.parse(raw));
        return Boolean(previous && serviceHomeMatches(previous.codexCommanderHome, getConfigDir()));
      },
    });
    if (process.platform === "win32") hardenSecretPath(path, { required: true });
  }
}

function readServiceInstallState(): ServiceInstallState | null {
  for (const path of serviceStatePaths()) {
    try {
      assertPrivateServiceFile(path);
      const parsed = parseServiceInstallState(JSON.parse(readFileSync(path, "utf8")));
      if (parsed) return parsed;
    } catch { /* unreadable or invalid */ }
  }
  return null;
}

/** What ONE state path said. Absent, unreadable and invalid are different answers. */
export type ServiceStateEvidence =
  | { readonly path: string; readonly kind: "absent" }
  | { readonly path: string; readonly kind: "unreadable"; readonly reason: string }
  | { readonly path: string; readonly kind: "invalid" }
  | { readonly path: string; readonly kind: "valid"; readonly state: ServiceInstallState };

/**
 * Every state path, with what each one said.
 *
 * `readServiceInstallState` returns the FIRST path that parsed and discards the
 * rest, so a valid mirror beside a corrupt one reads as clean. That is the right
 * behavior for callers that just need the install state; it is the wrong input
 * for deciding ownership, where a disagreement between mirrors is exactly the
 * evidence that matters.
 */
export function inspectServiceStateEvidence(
  paths: readonly string[] = serviceStatePaths(),
): readonly ServiceStateEvidence[] {
  return paths.map((path): ServiceStateEvidence => {
    let raw: string;
    try {
      assertPrivateServiceFile(path);
      raw = readFileSync(path, "utf8");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      // ENOENT is an answer. EACCES, ENOTDIR and the rest are a failure to ask,
      // and collapsing them into absence is how a locked-down state file would
      // become permission to write.
      if (code === "ENOENT") return { path, kind: "absent" };
      return { path, kind: "unreadable", reason: code || String(error) };
    }
    let parsed: ServiceInstallState | null;
    try {
      parsed = parseServiceInstallState(JSON.parse(raw));
    } catch {
      return { path, kind: "invalid" };
    }
    return parsed ? { path, kind: "valid", state: parsed } : { path, kind: "invalid" };
  });
}

/** The homes this process is actually using, for comparison against a claim. */
export function currentServiceHomes(): { codexHome: string; codexCommanderHome: string } {
  return { codexHome: currentCodexHome(), codexCommanderHome: currentCodexCommanderHome() };
}

export function serviceHomeMatches(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

export function readServiceBackend(): ServiceBackend {
  return readServiceInstallState()?.backend === "native" ? "native" : "scheduler";
}

/**
 * The `ccx` argv that repairs an already-installed service.
 *
 * `repair` discovers the installed backend itself and, on Windows scheduler installs,
 * rewrites the wrapper assets and restarts the existing task WITHOUT `schtasks /create`
 * (see repairService below). `install` always reaches `/create`, which requires
 * elevation, so repair must never be implemented as an uninstall/install cycle.
 *
 */
export function serviceRepairArgs(): string[] {
  return ["service", "repair"];
}

/** The `ccx` argv that registers a service from scratch, preserving the chosen backend. */
export function serviceInstallArgs(): string[] {
  return readServiceBackend() === "native" ? ["service", "install", "--native"] : ["service", "install"];
}

/**
 * The service was installed under a different CODEX_HOME/CODEXCOMMANDER_HOME, so this process may not
 * touch it. Distinct from "stop failed": the manager was never even contacted, which means the
 * installed service is still live and shared state (native Codex config, the Grok fence) must be
 * left alone — tearing it down would strip config out from under a running service.
 */
export class ServiceOwnershipError extends Error {
  readonly code = "service-ownership-mismatch" as const;
}

export function isServiceOwnershipError(err: unknown): err is ServiceOwnershipError {
  return err instanceof ServiceOwnershipError;
}

/**
 * True when no installed service exists, or the installed one belongs to THIS
 * CODEX_HOME/CODEXCOMMANDER_HOME. Callers use it to decide whether they may tear down shared state
 * (native Codex config, the Grok fence) that a foreign service would still be relying on.
 */
export function serviceEnvironmentOwnedHere(): boolean {
  try {
    assertServiceEnvironmentMatchesInstall();
    return true;
  } catch (err) {
    if (isServiceOwnershipError(err)) return false;
    return true; // unrelated failure: fall back to the previous behavior rather than wedging
  }
}

export function assertServiceEnvironmentMatchesInstall(): void {
  const state = readServiceInstallState();
  if (!state) return;
  const expected = normalizePathForCompare(state.codexHome);
  const actual = normalizePathForCompare(currentCodexHome());
  if (expected !== actual) {
    throw new ServiceOwnershipError(
      `Service was installed with CODEX_HOME=${state.codexHome}, but current CODEX_HOME=${currentCodexHome()}. ` +
        "Run the service command from the same Codex home so native Codex restore updates the correct config.",
    );
  }
  const expectedCodexCommanderHome = normalizePathForCompare(state.codexCommanderHome);
  const actualCodexCommanderHome = normalizePathForCompare(currentCodexCommanderHome());
  if (expectedCodexCommanderHome !== actualCodexCommanderHome) {
    throw new ServiceOwnershipError(
      `Service was installed with CODEXCOMMANDER_HOME=${state.codexCommanderHome}, but current CODEXCOMMANDER_HOME=${currentCodexCommanderHome()}. ` +
        "Run the service command from the same CodexCommander home so service state and secrets match.",
    );
  }
}


function plistString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return normalized === "" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

/**
 * The `ccx` command a user should rerun for the service state they actually have.
 *
 * `installed` alone is not enough: `repairService()` refuses a Task-Scheduler-plus-WinSW
 * conflict outright, so recommending repair there names a command guaranteed to fail.
 * Install IS the valid conflict recovery, because `installWindows` removes the native
 * backend first. Exported so the guard tests the real selector rather than a copy of it.
 */
export function serviceRetryCommand(
  diag: Pick<ServiceDiagnostic, "installed" | "conflict"> = diagnoseService(),
): string {
  return diag.installed && !diag.conflict ? "ccx service repair" : "ccx service install";
}

export function assertServiceAuthEnvironment(): void {
  const config = loadConfig();
  if (isLoopbackHostname(config.hostname)) return;
  if (process.env.CODEXCOMMANDER_API_AUTH_TOKEN?.trim()) return;
  // Reached from `service repair` as well as `install`, so name a command that can
  // actually succeed (see serviceRetryCommand).
  const diag = diagnoseService();
  const retry = serviceRetryCommand(diag);
  throw new Error(
    `CODEXCOMMANDER_API_AUTH_TOKEN is required before ${diag.installed ? "refreshing" : "installing"} a service `
      + `for non-loopback hostname. Set it in the same shell, then rerun \`${retry}\`.`,
  );
}

function writeServiceApiTokenFile(): string | null {
  const token = process.env.CODEXCOMMANDER_API_AUTH_TOKEN?.trim();
  if (!token) return null;
  const path = serviceApiTokenFilePath();
  const dir = getConfigDir();
  recordOwnedConfigPath(dir, path);
  ensurePrivateServiceDirectory(dir);
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  writePrivateServiceFile(path, `${token}\n`, {
    mode: 0o600,
    // A token file is never executable and can exist only in our private config
    // directory.  We deliberately do not compare its secret value so rotating a
    // token does not leave it stale, but links/permissions are always rejected.
    ownsExisting: () => true,
  });
  if (process.platform === "win32") hardenSecretPath(path, { required: true });
  return path;
}

export function buildPlist(): string {
  const { bun, bunRuntimeSource, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = process.env.CODEX_HOME?.trim();
  const codexCommanderHome = process.env[HOME_ENV]?.trim();
  const kimiCodeHome = process.env.KIMI_CODE_HOME?.trim();
  const grokHome = process.env.GROK_HOME?.trim();
  const appRuntime = process.env.CCX_APP_RUNTIME === "1";
  const args = buildLaunchdArguments(cli);
  const envLines = [
    `    <key>CCX_SERVICE</key><string>1</string>`,
    `    <key>${BUN_RUNTIME_SOURCE_ENV}</key><string>${bunRuntimeSource}</string>`,
    `    <key>${BUN_RUNTIME_PATH_ENV}</key><string>${plistString(bun)}</string>`,
    `    <key>CCX_API_TOKEN_FILE</key><string>${plistString(serviceApiTokenFilePath())}</string>`,
    appRuntime ? `    <key>CCX_APP_RUNTIME</key><string>1</string>` : null,
    `    <key>PATH</key><string>${plistString(path)}</string>`,
    codexHome ? `    <key>CODEX_HOME</key><string>${plistString(codexHome)}</string>` : null,
    codexCommanderHome ? `    <key>${HOME_ENV}</key><string>${plistString(codexCommanderHome)}</string>` : null,
    kimiCodeHome ? `    <key>KIMI_CODE_HOME</key><string>${plistString(kimiCodeHome)}</string>` : null,
    grokHome ? `    <key>GROK_HOME</key><string>${plistString(grokHome)}</string>` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${plistString(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${envLines}
  </dict>
  <key>StandardOutPath</key><string>${plistString(log)}</string>
  <key>StandardErrorPath</key><string>${plistString(log)}</string>
</dict>
</plist>
`;
}

function buildLaunchdArguments(cli: string, port = resolveServiceListenPort()): string[] {
  return [launchdExecutablePath(), cli, "start", "--port", String(port)];
}

/** Deterministic name is not ownership: prove the on-disk launchd definition first. */
function ownsLaunchdPlist(content: string): boolean {
  return content.includes(`<key>Label</key><string>${plistString(LABEL)}</string>`)
    && launchdPlistTargetsExecutable(content, launchdExecutablePath());
}

function assertOwnedLaunchdPlist(path = plistPath()): void {
  assertPrivateServiceFile(path);
  if (!ownsLaunchdPlist(readFileSync(path, "utf8"))) {
    throw new Error(`Refusing to mutate foreign launchd definition: ${path}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Listen port baked into service wrappers / WinSW XML.
 * Priority: explicit override → CCX_BAKE_PORT (update restart) → config.port → 10100.
 * `config.port === 0` means ephemeral for interactive start; services need a stable pin,
 * so treat 0 / invalid like unset (default 10100) instead of baking `--port 0`.
 */
export function resolveServiceListenPort(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0 && override <= 65535) {
    return Math.trunc(override);
  }
  const baked = process.env.CCX_BAKE_PORT?.trim();
  if (baked && /^\d+$/.test(baked)) {
    const n = Number(baked);
    if (n > 0 && n <= 65535) return n;
  }
  const configured = loadConfig().port;
  if (typeof configured === "number" && configured > 0 && configured <= 65535) return configured;
  return 10100;
}

function buildServiceShellCommand(bun: string, cli: string, port = resolveServiceListenPort()): string {
  const tokenFile = serviceApiTokenFilePath();
  return `if [ -f ${shellQuote(tokenFile)} ]; then CODEXCOMMANDER_API_AUTH_TOKEN="$(cat ${shellQuote(tokenFile)})"; export CODEXCOMMANDER_API_AUTH_TOKEN; fi; exec ${shellQuote(bun)} ${shellQuote(cli)} start --port ${port}`;
}

/**
 * The `--port <n>` actually baked into the installed launchd plist, or null when it
 * cannot be read. macOS only — named for launchd rather than "service" so no caller
 * assumes it covers systemd or the Windows wrapper.
 *
 * `start` needs this because it does NOT rewrite the plist: an install made under
 * CCX_BAKE_PORT, or any later config.port edit, would otherwise leave launchd serving
 * one port while the confirmation probes another, failing a healthy service.
 *
 * Plists use tokenized ProgramArguments.
 */
export function launchdListenPort(deps: { readPlist?: () => string } = {}): number | null {
  try {
    const text = (deps.readPlist ?? (() => readFileSync(plistPath(), "utf8")))();
    const last = [...text.matchAll(/<string>--port<\/string>\s*<string>(\d{1,5})<\/string>/g)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

/** The `--port <n>` baked into the installed systemd user unit. Linux only. */
export function systemdListenPort(deps: { readUnit?: () => string } = {}): number | null {
  try {
    const text = (deps.readUnit ?? (() => readFileSync(unitPath(), "utf8")))();
    const last = [...text.matchAll(/start --port (\d{1,5})(?:\s|"|$)/gm)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Shared tail parser for the baked `--port <n>`.
 *
 * Terminators cover all three artifact shapes: whitespace (batch wrapper, systemd
 * unit), `"` (systemd's quoted ExecStart), `<` (WinSW's `</arguments>`), and `&` (an
 * XML-escaped quote). Matched LAST because every artifact carries the Bun and CLI
 * paths ahead of the argument, and a path containing the literal must not shadow it.
 */
function parseBakedListenPort(read: () => string): number | null {
  try {
    const last = [...read().matchAll(/start --port (\d{1,5})(?:\s|"|&|<|$)/gm)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

/** The `--port <n>` baked into the Task Scheduler wrapper. Windows scheduler backend. */
export function windowsListenPort(deps: { readScript?: () => string } = {}): number | null {
  return parseBakedListenPort(deps.readScript ?? (() => readFileSync(windowsServiceScriptPath(), "utf8")));
}

/**
 * The `--port <n>` baked into the WinSW XML's `<arguments>`. Windows native backend.
 *
 * Separate from {@link windowsListenPort} rather than one function branching on
 * `readServiceBackend()`: the recorded backend can disagree with what is actually on
 * disk (the `stale` / `backendStateMismatch` cases `deriveWindowsServiceDiagnostic`
 * exists to catch), and a reader that trusted it would then read the wrong file.
 * Each returns null when its own artifact is absent, so the chain needs no branch.
 */
export function winswListenPort(deps: { readXml?: () => string } = {}): number | null {
  return parseBakedListenPort(deps.readXml ?? (() => readFileSync(winswXmlPath(), "utf8")));
}

/**
 * The listen port of the INSTALLED service artifact, falling back to the configured
 * one. Each reader returns null off its own platform, so the chain needs no platform
 * branch — and on Windows both return null, preserving today's behavior.
 */
export function installedServiceListenPort(): number {
  return launchdListenPort()
    ?? systemdListenPort()
    ?? windowsListenPort()
    ?? winswListenPort()
    ?? resolveServiceListenPort();
}

export const SERVICE_INSTALL_HEALTH_MS = 20_000;

/**
 * Whether a proxy actually answers on the port this install/start just produced.
 *
 * Registration is not service: `launchctl list` reports a job that never bound, and
 * `systemctl is-active` reports a process that bound nothing. Probing is the only
 * thing that answers the question the user is actually asking.
 *
 * Probes the BAKED target rather than resolving one. `findLiveProxy` resolves through
 * pidfile -> runtime-port -> config.port, and a service reinstall has just invalidated
 * the first two while `resolveServiceListenPort` (CCX_BAKE_PORT precedence, config.port
 * === 0 normalization) can disagree with the third.
 *
 * Soft: returns the outcome, never throws; the caller chooses between a checkmark and
 * an actionable warning.
 */
export async function confirmServiceServing(
  deps: {
    port?: number;
    hostname?: string;
    probe?: (port: number, hostname: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: true; port: number } | { ok: false; port: number }> {
  const port = deps.port ?? installedServiceListenPort();
  const hostname = deps.hostname ?? loadConfig().hostname ?? "127.0.0.1";
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const probe = deps.probe ?? (async (p, h) => !!(await proxyIdentityAt(p, { hostname: h })));
  const deadline = now() + (deps.timeoutMs ?? SERVICE_INSTALL_HEALTH_MS);
  for (;;) {
    if (await probe(port, hostname)) return { ok: true, port };
    if (now() >= deadline) return { ok: false, port };
    await sleep(500);
  }
}

/**
 * Print the outcome of `install` / `start` / `repair` in terms of what the user cares
 * about — is it serving? — instead of whether the manager accepted the registration.
 *
 * Returns whether the service became live and sets `process.exitCode = 1` when it did
 * not. The lifecycle caller uses the boolean to restore native routing before releasing
 * its authority; the GUI update worker also reads the child's exit status.
 */
export async function reportServiceServing(
  verb: "installed" | "started" | "repaired",
  deps: Parameters<typeof confirmServiceServing>[0] = {},
): Promise<boolean> {
  const serving = await confirmServiceServing(deps);
  if (serving.ok) {
    console.log(`✅ CodexCommander service ${verb} and serving on port ${serving.port}.`);
    return true;
  }
  console.error(
    `⚠️  Service ${verb}, but no proxy answered on port ${serving.port} within `
    + `${Math.trunc(SERVICE_INSTALL_HEALTH_MS / 1000)}s.\n`
    + `   The manager registered the job; that is not the same as serving.\n`
    + `   Log:       ${serviceLogPath()}\n`
    + `   Meanwhile: ccx start   (serves in the foreground)`,
  );
  process.exitCode = 1;
  return false;
}

/**
 * The command that repairs the CURRENTLY INSTALLED backend without re-registering it.
 *
 * `ccx service repair` reads the recorded backend itself, so it cannot silently switch a
 * WinSW install to Task Scheduler the way a plain `ccx service install` would, and on
 * Windows it needs no elevation because it never calls `schtasks /create`.
 */
function serviceRepairCommand(): string {
  return "ccx service repair";
}

function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/%/g, "%%")
    .replace(/\n/g, "\\n")}"`;
}

function systemdEnvironmentAssignment(name: string, value: string | undefined): string | null {
  if (!value) return null;
  return `Environment=${systemdQuote(`${name}=${value}`)}`;
}

function systemdOutputTarget(value: string): string {
  // StandardOutput/StandardError use output specifiers such as append:/path.
  // Quoting the full specifier makes systemd reject it as an invalid output target.
  return value.replace(/%/g, "%%").replace(/\n/g, "\\n");
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Run `launchctl` and report BOTH streams regardless of exit status.
 *
 * `launchctl load` writes "Load failed: <n>: <reason>" to stderr and exits 0 for
 * every already-bootstrapped job. `sh()` above is execSync, which throws only on a
 * non-zero exit, so install and start both reported success for a load that did
 * nothing — leaving launchd running the PREVIOUS plist while a freshly written one
 * sat unused on disk. That is the 2026-08-02 report: `ccx service` prints a
 * checkmark, `launchctl list` shows the job, and the port answers nothing.
 *
 * spawnSync, NOT execFileSync: execFileSync discards stderr when the child exits 0,
 * which is precisely this case — a runner built on it returns an empty stderr and
 * the guard below can never fire. Measured on macOS 27.0.
 */
export function runLaunchctl(
  args: string[],
  deps: { run?: typeof spawnSync } = {},
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const run = deps.run ?? spawnSync;
  const result = run("/bin/launchctl", args, { encoding: "utf8", windowsHide: true });
  // `error` is set when the spawn itself failed (ENOENT off macOS) and `status` is
  // null for a signalled child; neither may be reported as success.
  if (result.error) {
    return { ok: false, stdout: "", stderr: String(result.error.message ?? ""), status: null };
  }
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    /*
     * The NUMBER, not just its zero-ness.
     *
     * `launchctl print` distinguishes "that domain does not exist" (112) from
     * "the domain answered and has no such service" (113), and an ownership
     * probe needs that difference: the second proves absence, the first only
     * proves we could not look. Collapsing both into `ok: false` forced callers
     * to parse stderr, which Apple does not treat as a stable interface.
     */
    status: result.status ?? null,
  };
}

/**
 * Whether launchctl output indicates the operation did not take. Needed because
 * `ok` alone is insufficient for the `load`/`unload` subcommands, which
 * report failure on stderr while exiting 0. `bootstrap` exits 5, so for that path
 * this is belt-and-braces rather than the only signal.
 */
export function launchctlLoadFailed(stderr: string): boolean {
  return /\b(?:Load|Bootstrap) failed\b/i.test(stderr);
}

/** launchd domain target for the current user's GUI session. */
function launchdGuiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/**
 * Whether launchd is running the job from the CURRENT plist. `launchctl list` only
 * proves domain membership — a job bootstrapped from an older plist stays listed
 * forever. `launchctl print` exposes the live `arguments`, which is the only way to
 * catch a load that silently no-op'd.
 */
export function launchdJobMatchesPlist(
  expectedArguments: string | readonly string[],
  deps: { run?: typeof runLaunchctl } = {},
): { loaded: boolean; matchesPlist: boolean } {
  const run = deps.run ?? runLaunchctl;
  const printed = run(["print", `${launchdGuiDomain()}/${LABEL}`]);
  if (!printed.ok) return { loaded: false, matchesPlist: false };
  // `print` writes the arguments block to stdout for a live job. Search both streams
  // anyway so a future launchctl that moves diagnostics between them cannot turn this
  // into a false negative — a false "stale" verdict would send users to `bootout` for
  // nothing.
  const printedText = `${printed.stdout}\n${printed.stderr}`;
  if (typeof expectedArguments === "string") {
    return { loaded: true, matchesPlist: printedText.includes(expectedArguments) };
  }
  const block = /arguments = \{([\s\S]*?)\n\s*\}/.exec(printedText)?.[1];
  const actualArguments = block
    ? block.split("\n").map(line => line.trim()).filter(Boolean)
    : [];
  const matchesPlist = actualArguments.length === expectedArguments.length
    && actualArguments.every((arg, index) => arg === expectedArguments[index]);
  return { loaded: true, matchesPlist };
}

/**
 * Decode schtasks stdout. `/query /xml` emits UTF-16LE (often with BOM) because the
 * registered task document is UTF-16; reading that as UTF-8 makes every health check
 * fail ("registration present but unhealthy") and rolls back a successful elevated create.
 */
export function decodeSchtasksOutput(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  const bomUtf16Le = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const bomUtf16Be = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff;
  const looksUtf16Le = buffer.length >= 4
    && buffer[1] === 0x00
    && buffer[3] === 0x00
    && buffer[0] !== 0x00;
  if (bomUtf16Le || looksUtf16Le) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "").trim();
  }
  if (bomUtf16Be) {
    // Swap pairs then decode as utf16le.
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1]!;
      swapped[i - 1] = buffer[i]!;
    }
    return swapped.toString("utf16le").trim();
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
}

function runFile(file: string, args: string[]): string {
  const buffer = execFileSync(file, args, {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as Buffer;
  return decodeSchtasksOutput(buffer);
}

function windowsSchtasks(): string {
  return resolveTrustedWindowsSchtasksExe();
}

function windowsWscript(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  return existsSync(candidate) ? candidate : "wscript.exe";
}

let querySchtasksForTests: ((args: string[]) => string) | null = null;

function querySchtasks(args: string[]): string {
  if (querySchtasksForTests) return querySchtasksForTests(args);
  return runFile(windowsSchtasks(), args);
}

/** Test-only seam for Task Scheduler query used by presence probes. */
export function setQuerySchtasksForTests(next: ((args: string[]) => string) | null): void {
  querySchtasksForTests = next;
}

function schtasks(args: string[]): string {
  try {
    return querySchtasks(args);
  } catch (error) {
    throw toWindowsSchtasksError(error, args);
  }
}

/** Tri-state Task Scheduler presence: never treat a failed query as proven absence. */
export type WindowsSchedulerTaskProbe =
  | { status: "present" }
  | { status: "absent" }
  | { status: "unknown"; detail: string };

export type WindowsSchedulerProxyProbe =
  | { status: "running"; port: number }
  | { status: "not-running" }
  | { status: "unknown" };

/**
 * Render Task Scheduler status without exposing localized `schtasks` table output.
 * The task probe answers installation state; the identity-checked health probe answers
 * runtime state. Keep probe details out of this user-facing line because they can contain
 * incorrectly decoded, locale-specific command output.
 */
export function formatWindowsSchedulerServiceStatus(
  task: WindowsSchedulerTaskProbe,
  proxy: WindowsSchedulerProxyProbe,
): string {
  if (task.status === "present") {
    if (proxy.status === "running") {
      return `✅ service installed (Task Scheduler); CodexCommander proxy running on port ${proxy.port}.`;
    }
    if (proxy.status === "not-running") {
      return "⚠️  service installed (Task Scheduler); CodexCommander proxy not running.";
    }
    return "⚠️  service installed (Task Scheduler); CodexCommander proxy status unknown.";
  }
  if (task.status === "absent") {
    if (proxy.status === "running") {
      return `❌ service not installed (Task Scheduler); CodexCommander proxy is running independently on port ${proxy.port}.`;
    }
    if (proxy.status === "unknown") {
      return "❌ service not installed (Task Scheduler); CodexCommander proxy status unknown.";
    }
    return "❌ service not installed (Task Scheduler).";
  }
  if (proxy.status === "running") {
    return `⚠️  Task Scheduler registration unknown; CodexCommander proxy running on port ${proxy.port}.`;
  }
  if (proxy.status === "not-running") {
    return "⚠️  service status unknown (Task Scheduler query failed); CodexCommander proxy not running.";
  }
  return "⚠️  service status unknown (Task Scheduler and proxy checks failed).";
}

export async function inspectWindowsSchedulerServiceStatus(io: {
  probeTask?: () => WindowsSchedulerTaskProbe;
  findProxy?: () => Promise<{ port: number } | null>;
} = {}): Promise<string> {
  let task: WindowsSchedulerTaskProbe;
  try {
    task = (io.probeTask ?? probeWindowsSchedulerTask)();
  } catch (error) {
    task = { status: "unknown", detail: schtasksErrorDetail(error) };
  }

  let proxy: WindowsSchedulerProxyProbe;
  try {
    const live = await (io.findProxy ?? findLiveProxy)();
    proxy = live ? { status: "running", port: live.port } : { status: "not-running" };
  } catch {
    proxy = { status: "unknown" };
  }

  return formatWindowsSchedulerServiceStatus(task, proxy);
}

function schtasksErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a schtasks CSV listing line refers to the given task name. */
export function windowsSchedulerCsvIncludesTask(csv: string, taskName: string): boolean {
  const needle = taskName.toLowerCase();
  for (const line of csv.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (!lower.includes(needle)) continue;
    // Prefer exact CSV field matches ("\TaskName" / "TaskName") before a substring hit.
    if (
      lower.includes(`"\\${needle}"`)
      || lower.includes(`"${needle}"`)
      || new RegExp(`(^|[,\\\\])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([,"]|$)`).test(lower)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Probe whether the CodexCommander Task Scheduler task exists.
 * Query failures fall back to a CSV listing before concluding absence; if both
 * fail, returns `unknown` so callers can fail closed instead of releasing locks.
 */
export function probeWindowsSchedulerTask(taskName = TASK): WindowsSchedulerTaskProbe {
  if (process.platform !== "win32") return { status: "absent" };

  let queryFailure: string | null = null;
  try {
    const out = querySchtasks(["/query", "/tn", taskName]);
    if (out.includes(taskName)) return { status: "present" };
  } catch (error) {
    queryFailure = schtasksErrorDetail(error);
  }

  try {
    const csv = querySchtasks(["/query", "/fo", "CSV"]);
    if (windowsSchedulerCsvIncludesTask(csv, taskName)) return { status: "present" };
    return { status: "absent" };
  } catch (error) {
    const listDetail = schtasksErrorDetail(error);
    const detail = queryFailure
      ? `Specific query failed (${queryFailure}); CSV listing also failed (${listDetail}).`
      : `Task query did not confirm presence and CSV listing failed (${listDetail}).`;
    return { status: "unknown", detail };
  }
}

/** Map Scheduler presence/XML into lifecycle truth without guessing after query failure. */
export function probeWindowsSchedulerSupervisor(deps: {
  probeTask?: () => WindowsSchedulerTaskProbe;
  readXml?: () => string;
} = {}): ServiceSupervisorProbe {
  let task: WindowsSchedulerTaskProbe;
  try {
    task = (deps.probeTask ?? probeWindowsSchedulerTask)();
  } catch (error) {
    task = { status: "unknown", detail: schtasksErrorDetail(error) };
  }
  if (task.status === "absent") {
    return { registrationState: "absent", supervisorState: "inactive", enabled: false };
  }
  if (task.status === "unknown") {
    return {
      registrationState: "indeterminate",
      supervisorState: "indeterminate",
      enabled: null,
      detail: task.detail,
    };
  }
  let xml: string;
  try {
    xml = (deps.readXml ?? (() => schtasks(["/query", "/tn", TASK, "/xml"])))();
  } catch (error) {
    return {
      registrationState: "present",
      supervisorState: "indeterminate",
      enabled: null,
      detail: `Task Scheduler XML could not be read: ${schtasksErrorDetail(error)}`,
    };
  }
  const state = readWindowsSchedulerXmlState(xml);
  if (!state.installed) {
    return {
      registrationState: "present",
      supervisorState: "indeterminate",
      enabled: null,
      detail: "Task Scheduler returned an unreadable registration",
    };
  }
  // Scheduler does not expose a reliable resident-wrapper state. An enabled owned
  // registration is conservatively active for stop admission; `/end` plus the bounded
  // child-respawn probe establishes quiescence.
  return {
    registrationState: "present",
    supervisorState: state.enabled ? "active" : "inactive",
    enabled: state.enabled,
  };
}

/** Map the WinSW SCM probe without treating an unavailable SCM as stopped/absent. */
export function probeWinswSupervisor(
  status: ReturnType<typeof statusWinswRaw> = statusWinswRaw(),
  deps: { queryDefinition?: () => string; executable?: string } = {},
): ServiceSupervisorProbe {
  if (status === "started") {
    return { registrationState: "present", supervisorState: "active", enabled: true };
  }
  if (status === "stopped") {
    return { registrationState: "present", supervisorState: "inactive", enabled: true };
  }
  if (status === "nonexistent") {
    return { registrationState: "absent", supervisorState: "inactive", enabled: false };
  }
  if (process.platform === "win32" || deps.queryDefinition) {
    try {
      const qc = (deps.queryDefinition ?? (() => execFileSync(
        existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "sc.exe"))
          ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "sc.exe")
          : "sc.exe",
        ["qc", WINSW_SERVICE_ID],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      )))();
      if (!winswScmDefinitionOwned(qc, deps.executable)) {
        return {
          registrationState: "present",
          supervisorState: "indeterminate",
          enabled: null,
          detail: "Windows service registration is not owned by CodexCommander",
        };
      }
    } catch {
      // `statusWinswRaw` already distinguishes a proven 1060 absence. Reaching this
      // branch means SCM presence/runtime is still unverified, so retain unknown.
    }
  }
  return {
    registrationState: "indeterminate",
    supervisorState: "indeterminate",
    enabled: null,
    detail: "Windows Service Control Manager status is unavailable",
  };
}

/** True when the Task Scheduler registration for the default proxy task is proven present. */
export function windowsSchedulerTaskInstalled(taskName = TASK): boolean {
  return probeWindowsSchedulerTask(taskName).status === "present";
}

/** A fixed task name is not authority to run, replace, or delete another task. */
export function assertOwnedWindowsSchedulerTask(taskName = TASK): boolean {
  const probe = probeWindowsSchedulerTask(taskName);
  if (probe.status === "absent") return false;
  if (probe.status === "unknown") {
    throw new Error(`Task Scheduler task ${taskName} ownership could not be verified: ${probe.detail}`);
  }
  let xml: string;
  try {
    xml = querySchtasks(["/query", "/tn", taskName, "/xml"]);
  } catch (error) {
    throw new Error(`Task Scheduler task ${taskName} XML could not be read; refusing mutation: ${schtasksErrorDetail(error)}`);
  }
  if (!windowsTaskRegistrationHealthy(xml)) {
    throw new Error(`Refusing to mutate foreign or unhealthy Task Scheduler task: ${taskName}`);
  }
  return true;
}

export interface WindowsSchedulerInstallVerification {
  taskInstalled: boolean;
  registrationHealthy: boolean;
  /** Well-formed XML that is PUBLISHED but policy-violating — permanent, never
   * worth a settle retry (vs an empty/unreadable view, which is publication
   * lag and transient). */
  registrationInvalid: boolean;
  assetsHealthy: boolean;
  nativeServiceAbsent: boolean;
  /** True when SCM probe failed; not a proven WinSW presence. */
  nativeStatusUnknown: boolean;
  conflict: boolean;
  ok: boolean;
  detail: string;
}

/** Pure postcondition evaluation for an elevated scheduler install. */
export function evaluateWindowsSchedulerInstallVerification(inputs: {
  taskInstalled: boolean;
  xml: string;
  assetsExist: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  wscript?: string;
  launcher?: string;
}): WindowsSchedulerInstallVerification {
  const registrationHealthy = inputs.xml.length > 0
    && windowsTaskRegistrationHealthy(inputs.xml, inputs.wscript, inputs.launcher);
  // Permanent invalidity: the XML IS published but violates the registration
  // contract — no amount of settling changes it. Empty/unreadable XML stays
  // transient (publication lag).
  const registrationInvalid = inputs.taskInstalled && inputs.xml.length > 0 && !registrationHealthy;
  const assetsHealthy = inputs.assetsExist;
  const nativeServiceAbsent = inputs.nativeStatus === "nonexistent";
  const nativeStatusUnknown = inputs.nativeStatus === "unknown";
  // Only treat proven WinSW presence as a backend conflict — never "unknown".
  const conflict = inputs.taskInstalled
    && (inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  const ok = inputs.taskInstalled && registrationHealthy && assetsHealthy && nativeServiceAbsent && !conflict;
  const detail = !inputs.taskInstalled
    ? "Task Scheduler task is not installed."
    : conflict
      ? `CONFLICT: Task Scheduler and native WinSW (${WINSW_SERVICE_ID}) are both present.`
      : !assetsHealthy
        ? "Required scheduler service assets are missing."
        : !registrationHealthy
          ? (inputs.xml.trim()
            ? "Task Scheduler registration is present but unhealthy."
            : "Task Scheduler task is present but its XML could not be read.")
          : nativeStatusUnknown
            ? "The Task Scheduler task was created, but CodexCommander could not verify that the native WinSW service is absent."
            : "ok";
  return {
    taskInstalled: inputs.taskInstalled,
    registrationHealthy,
    registrationInvalid,
    assetsHealthy,
    nativeServiceAbsent,
    nativeStatusUnknown,
    conflict,
    ok,
    detail,
  };
}

/** Conflict-free postcondition check for an elevated scheduler install. */
export function verifyWindowsSchedulerInstall(taskName = TASK): WindowsSchedulerInstallVerification {
  const taskInstalled = windowsSchedulerTaskInstalled(taskName);
  let xml = "";
  if (taskInstalled) {
    try { xml = querySchtasks(["/query", "/tn", taskName, "/xml"]); } catch { xml = ""; }
  }
  // After elevated create, non-elevated `/query /xml` can fail or return empty while the
  // task is still listed. Fall back to the on-disk document we registered.
  if (taskInstalled && !xml.trim()) {
    const diskPath = windowsTaskXmlPath();
    if (existsSync(diskPath)) {
      try { xml = decodeSchtasksOutput(readFileSync(diskPath)); } catch { /* keep empty */ }
    }
  }
  return evaluateWindowsSchedulerInstallVerification({
    taskInstalled,
    xml,
    assetsExist: [windowsServiceScriptPath(), windowsLauncherVbsPath(), windowsTaskXmlPath()].every(existsSync),
    nativeStatus: statusWinswRaw(),
  });
}

async function elevateSchtasks(args: string[]): Promise<void> {
  const exitCode = await runWindowsElevated(windowsSchtasks(), args);
  if (exitCode !== 0) {
    throw new Error(`Background service install failed with exit code ${exitCode}.`);
  }
}

async function rollbackElevatedSchedulerTask(taskName = TASK): Promise<string | null> {
  try {
    await elevateSchtasks(["/delete", "/tn", taskName, "/f"]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const probe = resolveWindowsSchedulerTaskProbe(taskName);
  if (probe.status === "absent") return null;
  if (probe.status === "unknown") {
    return `Task Scheduler task ${taskName} presence could not be verified after rollback: ${probe.detail}`;
  }
  return `Task Scheduler task ${taskName} is still present after rollback.`;
}

type ElevateCreateAndRunStart = (
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
) => ElevatedSchtasksCreateAndRunExecution;

type FinalizeHooks = {
  startElevateCreateAndRun?: ElevateCreateAndRunStart;
  /** Synchronous test hook — wraps a resolved result as an execution. */
  elevateCreateAndRun?: (
    schtasksPath: string,
    createArgs: string[],
    runArgs: string[],
    deleteArgs: string[],
  ) => Promise<ElevatedSchtasksCreateAndRunResult>;
  verify?: () => WindowsSchedulerInstallVerification;
  writeInstallState?: () => void;
  /** Preferred tri-state probe for security-sensitive reconciliation. */
  probeTask?: () => WindowsSchedulerTaskProbe;
  /** Boolean test hook; mapped to present/absent when probeTask is unset. */
  taskInstalled?: () => boolean;
  /** Defense-in-depth: late reconciliation must still own this attempt. */
  stillOwnsAttempt?: (attemptId: string) => boolean;
  requestTimeoutMs?: number;
  /** Test-only seam for the post-create settle backoff; real installs use a timer. */
  settleDelay?: (ms: number) => Promise<void>;
};

let finalizeHooks: FinalizeHooks | null = null;

function resolveWindowsSchedulerTaskProbe(taskName = TASK): WindowsSchedulerTaskProbe {
  if (finalizeHooks?.probeTask) return finalizeHooks.probeTask();
  if (finalizeHooks?.taskInstalled) {
    return finalizeHooks.taskInstalled() ? { status: "present" } : { status: "absent" };
  }
  return probeWindowsSchedulerTask(taskName);
}

/** Test-only hooks for elevated create+run finalization. */
export function setFinalizeWindowsSchedulerHooksForTests(hooks: FinalizeHooks | null): void {
  finalizeHooks = hooks;
}

function throwPartialInstall(parts: string[]): never {
  throw new Error(parts.filter(Boolean).join(" "));
}

/**
 * Reconcile an unrecognized elevated exit when we cannot trust the phase code.
 * Never invent a create-vs-run classification; inspect actual task state first.
 * An unverifiable probe must fail closed (partial / blocked), never release.
 */
async function reconcileUnknownElevatedOutcome(exitCode: number): Promise<void> {
  const probe = resolveWindowsSchedulerTaskProbe();
  const parts = [
    "The elevated Task Scheduler operation returned an unknown result.",
    `Exit code: ${exitCode}.`,
    "CodexCommander could not prove whether task creation completed, so installation state was not written.",
  ];
  if (probe.status === "unknown") {
    parts.push(`Task Scheduler presence could not be verified: ${probe.detail}`);
    parts.push("A partial Task Scheduler backend may remain.");
    throwPartialInstall(parts);
  }
  if (probe.status === "absent") {
    parts.push("No CodexCommander Task Scheduler task was found after the elevated operation.");
    throwPartialInstall(parts);
  }
  parts.push("A Task Scheduler task is present; attempting cleanup.");
  const rollbackError = await rollbackElevatedSchedulerTask();
  if (rollbackError) {
    parts.push(`Cleanup also failed: ${rollbackError}`);
    parts.push(`Remove the task manually with 'schtasks /delete /tn ${TASK} /f' if it remains.`);
  } else {
    parts.push("The elevated Task Scheduler task was removed.");
  }
  throwPartialInstall(parts);
}

type ApplyElevatedOptions = {
  attemptId: string;
  writeOnSuccess: boolean;
  stillOwnsAttempt?: (attemptId: string) => boolean;
};

function attemptStillOwned(options: ApplyElevatedOptions): boolean {
  const check = options.stillOwnsAttempt ?? finalizeHooks?.stillOwnsAttempt;
  return !check || check(options.attemptId);
}

/**
 * Bounded post-create backoff, 1.1s total. Task Scheduler's non-elevated view can
 * lag an elevated `/create` by a few hundred milliseconds, so a single verification
 * would roll back a task that is merely not visible yet.
 */
const SCHEDULER_SETTLE_DELAYS_MS = [50, 150, 300, 600] as const;

/**
 * Whether a failed verification is still worth re-checking after a short delay.
 *
 * Retrying is confined to states that a lagging scheduler view actually produces:
 * the task is not visible yet, or it is visible but its registration has not been
 * published in full. Everything else keeps its existing fail-closed meaning and is
 * rejected here so no delay can turn it into a pass:
 *
 * - a proven conflict (both backends present) is a real dual-backend install;
 * - missing assets are missing on disk, which no amount of waiting creates;
 * - a WinSW service that is proven present (`started`/`stopped`) is never absent
 *   later. This is checked independently of `conflict`, which only becomes true
 *   once the task itself is visible — while the task is still invisible the pair
 *   is `conflict: false` with `nativeServiceAbsent: false`, and that must not retry;
 * - unknown SCM status is unproven rather than transient, and has its own
 *   task-preserving branch below.
 */
/** Exported for tests: the transient-vs-permanent settle decision. */
export function schedulerVerificationMaySettle(v: WindowsSchedulerInstallVerification): boolean {
  if (v.ok) return false;
  if (v.conflict) return false;
  if (!v.assetsHealthy) return false;
  if (!v.nativeServiceAbsent) return false;
  // A published-but-invalid registration is permanent: no delay repairs it.
  if (v.registrationInvalid) return false;
  return !v.taskInstalled || !v.registrationHealthy;
}

function settleDelay(ms: number): Promise<void> {
  const hook = finalizeHooks?.settleDelay;
  if (hook) return hook(ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Verify the elevated install, re-checking only while the failure looks like a
 * scheduler view that has not caught up yet. Returns `null` when this attempt lost
 * ownership mid-settle: a newer attempt owns the task, so this one must neither
 * write install state nor roll anything back.
 */
async function verifyWindowsSchedulerInstallAfterSettle(
  options: ApplyElevatedOptions,
): Promise<WindowsSchedulerInstallVerification | null> {
  const verify = finalizeHooks?.verify ?? verifyWindowsSchedulerInstall;
  let verification = verify();
  for (const delayMs of SCHEDULER_SETTLE_DELAYS_MS) {
    if (!schedulerVerificationMaySettle(verification)) break;
    if (!attemptStillOwned(options)) return null;
    await settleDelay(delayMs);
    if (!attemptStillOwned(options)) return null;
    verification = verify();
  }
  return verification;
}

async function applyElevatedSchedulerResult(
  result: ElevatedSchtasksCreateAndRunResult,
  options: ApplyElevatedOptions,
): Promise<void> {
  if (!attemptStillOwned(options)) {
    return;
  }
  const outcome: ElevatedSchedulerOutcome = result.outcome;

  if (outcome === "create-failed") {
    throw new Error("Elevated schtasks /create failed. The Task Scheduler task was not registered.");
  }
  if (outcome === "run-failed-rolled-back") {
    throw new Error(
      "Elevated schtasks /run failed after the task was registered. The elevated process rolled the task back. Installation state was not written.",
    );
  }
  if (outcome === "run-failed-rollback-failed") {
    throwPartialInstall([
      "Elevated schtasks /run failed after the task was registered, and elevated rollback also failed.",
      "A partial Task Scheduler backend may remain.",
      `Remove the task manually with 'schtasks /delete /tn ${TASK} /f' if present.`,
      "Installation state was not written.",
    ]);
  }
  if (outcome !== "success") {
    await reconcileUnknownElevatedOutcome(result.exitCode);
  }

  const verification = await verifyWindowsSchedulerInstallAfterSettle(options);
  // Ownership moved to a newer attempt while settling; that attempt owns the outcome.
  if (!verification) return;
  if (!verification.ok) {
    // Preserve a healthy elevated task when WinSW absence cannot be proven (unknown SCM status).
    // Unknown is not a confirmed dual-backend conflict; install state is still withheld.
    const preserveElevatedTask = verification.taskInstalled
      && verification.registrationHealthy
      && verification.assetsHealthy
      && !verification.conflict
      && verification.nativeStatusUnknown;
    if (preserveElevatedTask) {
      throwPartialInstall([
        "Elevated Task Scheduler registration did not produce a conflict-free install.",
        verification.detail,
        "The elevated Task Scheduler task was left in place because native WinSW status could not be verified.",
        "Installation state was not written.",
      ]);
    }
    // Rollback deletes a real task, so it needs the same ownership fence as the
    // state write below: a stale attempt must never delete a newer attempt's task.
    if (!attemptStillOwned(options)) return;
    const rollbackError = await rollbackElevatedSchedulerTask();
    const parts = [
      "Elevated Task Scheduler registration did not produce a conflict-free install.",
      verification.detail,
    ];
    if (rollbackError) {
      parts.push(`Rollback also failed: ${rollbackError}`);
      parts.push(`Remove the task manually with 'schtasks /delete /tn ${TASK} /f' and the native service with 'sc delete ${WINSW_SERVICE_ID}' if present.`);
    } else {
      parts.push("The elevated Task Scheduler task was rolled back.");
    }
    parts.push("Installation state was not written.");
    throwPartialInstall(parts);
  }
  if (options.writeOnSuccess) {
    if (!attemptStillOwned(options)) {
      return;
    }
    (finalizeHooks?.writeInstallState ?? (() => writeServiceInstallState("scheduler")))();
  }
}

/** Outcome of late reconciliation after a request-level elevation timeout. */
export type ElevatedReconciliationOutcome =
  | "released"
  | "blocked-partial";

export type FinalizeWindowsSchedulerResult =
  | { kind: "done" }
  | {
      kind: "indeterminate";
      attemptId: string;
      /** Settles after the elevated transaction finishes and late reconciliation runs. */
      reconciliation: Promise<ElevatedReconciliationOutcome>;
    };

export type FinalizeWindowsSchedulerOptions = {
  attemptId?: string;
  stillOwnsAttempt?: (attemptId: string) => boolean;
  requestTimeoutMs?: number;
};

function startElevateExecution(
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  deleteArgs: string[],
): ElevatedSchtasksCreateAndRunExecution {
  if (finalizeHooks?.startElevateCreateAndRun) {
    return finalizeHooks.startElevateCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
  }
  if (finalizeHooks?.elevateCreateAndRun) {
    const completion = finalizeHooks.elevateCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
    return { completion, launcherPid: null };
  }
  return startElevatedSchtasksCreateAndRun(schtasksPath, createArgs, runArgs, deleteArgs);
}

function isPartialInstallError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /partial Task Scheduler/i.test(error.message)
    || /Cleanup also failed/i.test(error.message)
    || /left in place because native WinSW status could not be verified/i.test(error.message)
    || /Task Scheduler presence could not be verified/i.test(error.message);
}

/**
 * Re-register the scheduler task with elevation after a non-elevated install wrote assets.
 *
 * Request timeout does not kill the elevated launcher. On timeout this returns
 * `indeterminate` and keeps reconciling the eventual protocol result.
 */
export async function finalizeWindowsSchedulerServiceRegistration(
  script = windowsServiceScriptPath(),
  options?: FinalizeWindowsSchedulerOptions,
): Promise<FinalizeWindowsSchedulerResult> {
  if (process.platform !== "win32") {
    throw new Error("Windows scheduler registration is only supported on Windows.");
  }
  const attemptId = options?.attemptId ?? randomUUID();
  const stillOwnsAttempt = options?.stillOwnsAttempt ?? finalizeHooks?.stillOwnsAttempt;
  const createArgs = buildWindowsSchtasksCreateArgs(script);
  const runArgs = ["/run", "/tn", TASK];
  const deleteArgs = ["/delete", "/tn", TASK, "/f"];
  const started = startElevateExecution(windowsSchtasks(), createArgs, runArgs, deleteArgs);
  const timeoutMs = options?.requestTimeoutMs
    ?? finalizeHooks?.requestTimeoutMs
    ?? ELEVATION_REQUEST_TIMEOUT_MS;
  const applyOpts: ApplyElevatedOptions = { attemptId, writeOnSuccess: true, stillOwnsAttempt };

  let raced: { status: "completed"; value: ElevatedSchtasksCreateAndRunResult } | { status: "timed-out" };
  try {
    raced = await raceWithTimeout(started.completion, timeoutMs);
  } catch (error) {
    // Cancellation / launch failure / signal before or instead of a protocol result.
    // Signal after Start-Process may leave an elevated child; reconcile conservatively.
    if (error instanceof WindowsElevationError && error.reason === "terminated") {
      try {
        await reconcileUnknownElevatedOutcome(CCX_ELEVATED_PROTOCOL_FAILED);
      } catch (reconcileError) {
        // Prefer the reconciliation detail (partial install / cleanup guidance) over the
        // generic signal message so callers can block retries when a task remains.
        throw reconcileError;
      }
    }
    throw error;
  }

  if (raced.status === "completed") {
    await applyElevatedSchedulerResult(raced.value, applyOpts);
    return { kind: "done" };
  }

  const reconciliation = (async (): Promise<ElevatedReconciliationOutcome> => {
    try {
      const result = await started.completion;
      await applyElevatedSchedulerResult(result, applyOpts);
      return "released";
    } catch (error) {
      if (error instanceof WindowsElevationError && error.reason === "cancelled") {
        return "released";
      }
      if (error instanceof WindowsElevationError && error.reason === "launch-failed") {
        return "released";
      }
      if (error instanceof WindowsElevationError && error.reason === "terminated") {
        try {
          await reconcileUnknownElevatedOutcome(CCX_ELEVATED_PROTOCOL_FAILED);
          return "released";
        } catch (reconcileError) {
          return isPartialInstallError(reconcileError) ? "blocked-partial" : "released";
        }
      }
      // applyElevatedSchedulerResult failures are expected (create/run/conflict); swallow for background.
      if (isPartialInstallError(error)) {
        return "blocked-partial";
      }
      return "released";
    }
  })();

  return { kind: "indeterminate", attemptId, reconciliation };
}

/**
 * Pure post-restart / pre-install advisory check. Does not mutate state.
 * A process-local indeterminate lock cannot survive restart — callers must inspect reality.
 */
export function evaluateSchedulerInstallRestartReconciliation(inputs: {
  taskInstalled: boolean;
  registrationHealthy: boolean;
  assetsHealthy: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  installStateBackend: "scheduler" | "native" | null;
}): {
  status: "healthy" | "orphan-task" | "stale-install-state" | "conflict" | "unhealthy" | "unverified";
  detail: string;
} {
  const conflict = inputs.taskInstalled
    && (inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  if (conflict) {
    return {
      status: "conflict",
      detail: `CONFLICT: Task Scheduler and native WinSW (${WINSW_SERVICE_ID}) are both present.`,
    };
  }
  if (inputs.taskInstalled && inputs.nativeStatus === "unknown") {
    return {
      status: "unverified",
      detail: "The Task Scheduler task exists, but native WinSW status could not be verified.",
    };
  }
  if (inputs.taskInstalled && (!inputs.registrationHealthy || !inputs.assetsHealthy)) {
    return {
      status: "unhealthy",
      detail: !inputs.assetsHealthy
        ? "Required scheduler service assets are missing."
        : "Task Scheduler registration is present but unhealthy.",
    };
  }
  if (inputs.taskInstalled && inputs.installStateBackend !== "scheduler") {
    return {
      status: "orphan-task",
      detail: "A Task Scheduler task is present without matching scheduler install state.",
    };
  }
  if (!inputs.taskInstalled && inputs.installStateBackend === "scheduler") {
    return {
      status: "stale-install-state",
      detail: "Scheduler install state is present but the Task Scheduler task is absent.",
    };
  }
  return { status: "healthy", detail: "ok" };
}

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

type WindowsBatchValueKind = "raw" | "path" | "pathList";

function windowsBatchSet(name: string, value: string | undefined, kind: WindowsBatchValueKind = "raw"): string | null {
  if (!value) return null;
  const rendered =
    kind === "path" ? windowsEnvIndirectBatchValue(value, windowsBatchValue)
    : kind === "pathList" ? windowsEnvIndirectBatchPathList(value, windowsBatchValue)
    : windowsBatchValue(value);
  return `set "${name}=${rendered}"`;
}

function taskXmlString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * RunLevel check. Schema default is LeastPrivilege (omitted on export). Elevated
 * `schtasks /create` often rewrites the registered task to HighestAvailable even when
 * the source XML asked for LeastPrivilege — still InteractiveToken / same user.
 * Keep accepting HighestAvailable here: rejecting it would false-fail healthy elevated
 * installs, and windowsTaskRegistrationHealthy tests encode that contract.
 */
function taskXmlRunLevelAcceptable(principal: string): boolean {
  if (taskXmlHasPrefixedTag(principal, "RunLevel")) return false;
  const count = taskXmlElementCount(principal, "RunLevel");
  if (count === 0) return true;
  if (count > 1) return false;
  const value = new RegExp(`<RunLevel(?:\\s[^>]*?)?>\\s*([^<]*?)\\s*<\\/RunLevel>`, "i").exec(principal)?.[1]?.trim().toLowerCase();
  return value === "leastprivilege" || value === "highestavailable";
}

export function buildWindowsServiceScript(entry = cliEntry(), port = resolveServiceListenPort()): string {
  // Provenance rides along with the entry: a second durableBunRuntime() call here could
  // resolve differently from the binary the caller actually baked.
  const { bun, bunRuntimeSource, cli } = entry;
  const path = process.env.PATH ?? "";
  const lines = [
    "@echo off",
    "rem CodexCommander managed scheduler wrapper v1",
    "setlocal",
    // The wrapper console is hidden by the wscript launcher (window style 0), so switching
    // it to UTF-8 is safe (no leak into user shells) and lets cmd parse UTF-8 remnants.
    "chcp 65001 >nul",
    windowsBatchSet("CCX_SERVICE", "1"),
    windowsBatchSet(BUN_RUNTIME_SOURCE_ENV, bunRuntimeSource),
    windowsBatchSet(BUN_RUNTIME_PATH_ENV, bun, "path"),
    windowsBatchSet("PATH", path, "pathList"),
    windowsBatchSet("CODEX_HOME", process.env.CODEX_HOME?.trim(), "path"),
    windowsBatchSet(HOME_ENV, process.env[HOME_ENV]?.trim(), "path"),
    windowsBatchSet("KIMI_CODE_HOME", process.env.KIMI_CODE_HOME?.trim(), "path"),
    windowsBatchSet("GROK_HOME", process.env.GROK_HOME?.trim(), "path"),
    windowsBatchSet("CCX_API_TOKEN_FILE", serviceApiTokenFilePath(), "path"),
    windowsBatchSet("CCX_SERVICE_LOG", serviceLogPath(), "path"),
    windowsBatchSet("CCX_BUN", bun, "path"),
    windowsBatchSet("CCX_CLI", cli, "path"),
    'if exist "%CCX_API_TOKEN_FILE%" (',
    '  set /p CODEXCOMMANDER_API_AUTH_TOKEN=<"%CCX_API_TOKEN_FILE%"',
    ")",
    ":loop",
    '>>"%CCX_SERVICE_LOG%" echo [%DATE% %TIME%] codexcommander service wrapper start',
    '>>"%CCX_SERVICE_LOG%" echo bun="%CCX_BUN%"',
    `>>"%CCX_SERVICE_LOG%" echo bun_source="${bunRuntimeSource}"`,
    '>>"%CCX_SERVICE_LOG%" echo cli="%CCX_CLI%"',
    '>>"%CCX_SERVICE_LOG%" echo codexcommander_home="%CODEXCOMMANDER_HOME%"',
    '>>"%CCX_SERVICE_LOG%" echo codex_home="%CODEX_HOME%"',
    '>>"%CCX_SERVICE_LOG%" echo token_file="%CCX_API_TOKEN_FILE%"',
    `"%CCX_BUN%" "%CCX_CLI%" start --port ${port} >>"%CCX_SERVICE_LOG%" 2>&1`,
    "if %ERRORLEVEL% NEQ 0 (",
    '  >>"%CCX_SERVICE_LOG%" echo [%DATE% %TIME%] child exited with code %ERRORLEVEL%; restarting in 5s',
    // `timeout` needs console stdin and dies with "Input redirection is not supported"
    // under Task Scheduler, turning the 5s cooldown into a hot restart loop; ping doesn't.
    "  ping -n 6 127.0.0.1 >nul",
    "  goto loop",
    ")",
    "endlocal",
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\r\n")}\r\n`;
}

export function buildWindowsSchtasksCreateArgs(script = windowsServiceScriptPath()): string[] {
  const xml = script === windowsServiceScriptPath() ? windowsTaskXmlPath() : `${script}.xml`;
  return ["/create", "/tn", TASK, "/xml", xml, "/f"];
}

/**
 * VBS launcher that starts the batch wrapper with a hidden window (style 0).
 * bWaitOnReturn=True keeps wscript.exe resident for the wrapper's lifetime so the
 * scheduled task stays "running": MultipleInstancesPolicy=IgnoreNew keeps preventing
 * duplicates and `schtasks /end` still has a live task instance to stop. Without the
 * launcher, the console batch action shows a closable cmd window in the interactive
 * session (issue #165). VBS string literals escape `"` as `""`.
 */
export function buildWindowsLauncherVbs(script = windowsServiceScriptPath()): string {
  const escaped = script.replace(/"/g, '""');
  const lines = [
    "' CodexCommander service launcher — runs the batch wrapper with a hidden window.",
    "' Generated by `ccx service install`; do not edit.",
    'Set shell = CreateObject("WScript.Shell")',
    // WshShell.Run(command, windowStyle 0 = hidden, bWaitOnReturn True = stay resident).
    `shell.Run """${escaped}""", 0, True`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function ownsWindowsServiceScript(content: string): boolean {
  return content.startsWith("@echo off")
    && content.includes("rem CodexCommander managed scheduler wrapper v1")
    && content.includes('set "CCX_SERVICE=1"')
    && content.includes('start --port ');
}

function ownsWindowsLauncherVbs(content: string): boolean {
  return content.includes("' CodexCommander service launcher — runs the batch wrapper with a hidden window.")
    && content.includes("' Generated by `ccx service install`; do not edit.")
    && content.includes('CreateObject("WScript.Shell")');
}

function ownsWindowsTaskXml(content: string): boolean {
  return content.includes("<Description>CodexCommander proxy service wrapper</Description>")
    && content.includes("<LogonType>InteractiveToken</LogonType>")
    && content.includes("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
}

export function buildWindowsTaskXml(_script = windowsServiceScriptPath(), launcher = windowsLauncherVbsPath()): string {
  const escapedWscript = taskXmlString(windowsWscript());
  // Escape the launcher path independently for the <Arguments> element; quoting it
  // keeps spaces intact, and /b (batch mode) suppresses script error popups.
  const escapedLauncherArgs = taskXmlString(`/b /nologo "${launcher}"`);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>CodexCommander proxy service wrapper</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapedWscript}</Command>
      <Arguments>${escapedLauncherArgs}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function taskXmlSection(xml: string, tag: string): string {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml)?.[1] ?? "";
}

/** Drop comments and CDATA so a commented-out decoy cannot satisfy any check. */
function taskXmlWithoutCommentsAndCdata(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
}

/**
 * Count occurrences of an unprefixed tag, including the self-closing form. The
 * element boundary matters: `<EnabledExtra>` must not count as `Enabled`.
 */
function taskXmlElementCount(xml: string, tag: string): number {
  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*?)?\\s*\\/?>`, "gi"))?.length ?? 0;
}

/**
 * True when a namespace-prefixed form of the tag appears. A prefixed element bound
 * to the task namespace carries a real value, but this module parses by regex and
 * cannot resolve prefixes — so it fails closed instead of reading the element as
 * absent (which would silently apply the schema default).
 */
function taskXmlHasPrefixedTag(xml: string, tag: string): boolean {
  return new RegExp(`<[A-Za-z_][\\w.-]*:${tag}(?:[\\s/>])`, "i").test(xml);
}

/**
 * Compare an element that Task Scheduler may omit when exporting a registered task.
 * Absence means the documented schema default (#432); a present element must still
 * match exactly, so a malformed or explicitly unsafe value never reads as healthy.
 */
/**
 * Decode XML's five predefined entities, exactly once.
 *
 * Task Scheduler re-encodes element text when it exports a task, so a needle we
 * escaped ourselves can never match its output (#608). Compare decoded values
 * instead of encoded ones.
 *
 * The single pass is the point: decoding twice would turn `&amp;quot;` into `"`,
 * letting a doubly-encoded value impersonate the expected launcher path.
 */
function taskXmlDecodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => (
    name === "amp" ? "&"
      : name === "lt" ? "<"
        : name === "gt" ? ">"
          : name === "quot" ? "\""
            : "'"
  ));
}

/**
 * Exactly one unprefixed `<tag>` whose DECODED text equals `expected`.
 *
 * Unlike taskXmlOptionalValueEquals(), an absent element is NOT a pass: these
 * elements name what actually gets executed, so a missing <Command>/<Arguments>
 * must fail the health check rather than inherit a schema default.
 */
function taskXmlDecodedValueEquals(xml: string, tag: string, expected: string): boolean {
  // Same reasoning as the optional helper: `<t:Arguments>` must not read as absent.
  if (taskXmlHasPrefixedTag(xml, tag)) return false;
  if (taskXmlElementCount(xml, tag) !== 1) return false;
  // `[^<]*` refuses nested markup, so a decoy inside a child element cannot match.
  const value = new RegExp(`<${tag}(?:\\s[^>]*?)?>([^<]*)<\\/${tag}>`, "i").exec(xml)?.[1];
  if (value === undefined) return false;
  return taskXmlDecodeEntities(value).trim().toLowerCase() === expected.trim().toLowerCase();
}

function taskXmlOptionalValueEquals(xml: string, tag: string, expected: string): boolean {
  // Check the prefixed form first: treating `<t:Enabled>false</t:Enabled>` as an
  // omission would turn an explicitly disabled task into a healthy one.
  if (taskXmlHasPrefixedTag(xml, tag)) return false;
  const count = taskXmlElementCount(xml, tag);
  if (count === 0) return true;
  if (count > 1) return false;
  const value = new RegExp(`<${tag}(?:\\s[^>]*?)?>\\s*([^<]*?)\\s*<\\/${tag}>`, "i").exec(xml)?.[1];
  return value?.trim().toLowerCase() === expected.toLowerCase();
}

/** Validate the security/lifecycle-critical fields of the registered scheduler task. */
export function windowsTaskRegistrationHealthy(
  xml: string,
  wscript = windowsWscript(),
  launcher = windowsLauncherVbsPath(),
): boolean {
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  // taskXmlSection() takes the FIRST match and the schema allows arbitrary XML under
  // Task/Data, so a Data block placed before the real sections could shadow them.
  // We never emit Data, so its presence alone disqualifies the registration. Both
  // forms are rejected because taskXmlElementCount() ignores prefixed tags.
  if (taskXmlElementCount(scrubbed, "Data") > 0 || taskXmlHasPrefixedTag(scrubbed, "Data")) return false;
  const triggers = taskXmlSection(scrubbed, "Triggers");
  const trigger = taskXmlSection(triggers, "LogonTrigger");
  const principal = taskXmlSection(scrubbed, "Principal");
  const settings = taskXmlSection(scrubbed, "Settings");
  const action = taskXmlSection(scrubbed, "Exec");
  // A self-closing <LogonTrigger /> leaves an empty section, so look for the element
  // itself — scoped to <Triggers> so a decoy elsewhere cannot satisfy it.
  return taskXmlElementCount(triggers, "LogonTrigger") > 0
    && taskXmlOptionalValueEquals(trigger, "Enabled", "true")
    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
    && taskXmlRunLevelAcceptable(principal)
    && taskXmlOptionalValueEquals(settings, "Enabled", "true")
    && /<MultipleInstancesPolicy>\s*IgnoreNew\s*<\/MultipleInstancesPolicy>/i.test(settings)
    && /<ExecutionTimeLimit>\s*PT0S\s*<\/ExecutionTimeLimit>/i.test(settings)
    // Compare decoded VALUES, not encodings: Task Scheduler canonicalizes the
    // quotes we wrote as `&quot;` back to literal `"` on export, so an escaped
    // needle never matched and a healthy task read as permanently stale (#608).
    // Case-insensitive: elevated `schtasks /create` may rewrite System32 casing.
    && taskXmlDecodedValueEquals(action, "Command", wscript)
    && taskXmlDecodedValueEquals(action, "Arguments", `/b /nologo "${launcher}"`);
}

export interface WindowsSchedulerXmlState {
  installed: boolean;
  enabled: boolean;
  registrationHealthy: boolean;
}

/**
 * Single source of truth for reading a registered task's XML. Both the status
 * diagnostic and its tests go through here, so a partial fix cannot leave one
 * caller on an older, stricter reading of the same document (#432).
 */
export function readWindowsSchedulerXmlState(
  xml: string,
  wscript?: string,
  launcher?: string,
): WindowsSchedulerXmlState {
  const installed = xml.length > 0;
  if (!installed) return { installed: false, enabled: false, registrationHealthy: false };
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  const hasData = taskXmlElementCount(scrubbed, "Data") > 0 || taskXmlHasPrefixedTag(scrubbed, "Data");
  const settings = hasData ? "" : taskXmlSection(scrubbed, "Settings");
  return {
    installed: true,
    enabled: !hasData && taskXmlOptionalValueEquals(settings, "Enabled", "true"),
    registrationHealthy: windowsTaskRegistrationHealthy(xml, wscript, launcher),
  };
}

// ── macOS (launchd) ──
function installLaunchd(): void {
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  ensurePrivateServiceDirectory(getConfigDir());
  writeServiceApiTokenFile();
  ensureLaunchdExecutable();
  const p = plistPath();
  // Capture this BEFORE writing: the write below makes the plist exist unconditionally,
  // so a post-write existsSync would call every fresh install an "installed" service.
  const wasInstalled = existsSync(p);
  writePrivateServiceFile(p, buildPlist(), {
    mode: 0o600,
    parent: "physical",
    ownsExisting: ownsLaunchdPlist,
  });
  // Best-effort: an absent job is fine here, and a failed unload is caught by the
  // load verification below with a better message than a raw unload error.
  runLaunchctl(["unload", p]);
  const loaded = runLaunchctl(["load", "-w", p]);
  if (!loaded.ok || launchctlLoadFailed(loaded.stderr)) {
    // Do NOT write install state for a load that did not take: state describing an
    // unused plist is what made this failure invisible.
    throw new Error(
      `launchctl could not load ${p}: ${loaded.stderr || "load reported failure"}\n`
      + "A previous job may still be bootstrapped. Try:\n"
      + `  launchctl bootout ${launchdGuiDomain()}/${LABEL}\n`
      // macOS `service repair` delegates straight to installLaunchd, so this fires for
      // an already-installed service too; repair reloads it without re-registering.
      + `then re-run '${wasInstalled ? "ccx service repair" : "ccx service install"}'.`,
    );
  }
  writeServiceInstallState();
}
/**
 * Deps are named for the layer they replace, not for the process API: `launchctl`
 * returns a {@link runLaunchctl} result and `matches` a {@link launchdJobMatchesPlist}
 * result. Only `runLaunchctl` itself takes a spawnSync mock.
 *
 * Exported for the branch tests. Every parameter is optional, so this stays
 * assignable to `ServiceOps.start` (`() => void`) and `platformOps` wires the same
 * function the tests exercise.
 */
export function startLaunchd(deps: {
  launchctl?: typeof runLaunchctl;
  matches?: typeof launchdJobMatchesPlist;
  installedPort?: () => number;
  assertOwned?: (path: string) => void;
} = {}): void {
  const entry = cliEntry();
  const run = deps.launchctl ?? runLaunchctl;
  const p = plistPath();
  (deps.assertOwned ?? assertOwnedLaunchdPlist)(p);
  const loaded = run(["load", "-w", p]);
  if (loaded.ok && !launchctlLoadFailed(loaded.stderr)) return;
  // `Load failed` on start is AMBIGUOUS in a way it is not on install: the job may
  // already be bootstrapped from THIS plist, which is a no-op rather than an error.
  // `install` can assume a stale job (it just rewrote the plist); `start` cannot, and
  // throwing here would break `ccx service start` on every healthy service.
  const live = (deps.matches ?? launchdJobMatchesPlist)(
    buildLaunchdArguments(entry.cli, (deps.installedPort ?? installedServiceListenPort)()),
  );
  if (live.loaded && live.matchesPlist) {
    console.log("ℹ️  service was already loaded from the current plist; nothing to do.");
    return;
  }
  throw new Error(
    `launchctl could not load ${p}: ${loaded.stderr || "load reported failure"}\n`
    + (live.loaded
      ? `launchd is running an OLDER plist. Fix:\n  launchctl bootout ${launchdGuiDomain()}/${launchdLabel()}\n  ccx service repair`
      : "The job is not loaded. Run 'ccx service repair' to reload it."),
  );
}
function stopLaunchd(): void {
  for (const label of launchdLabels()) {
    const p = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    if (!existsSync(p)) continue;
    assertOwnedLaunchdPlist(p);
    sh(`launchctl unload "${p}"`);
  }
}

/** Read launchd state without converting a failed query into "not loaded". */
export function probeLaunchdSupervisor(deps: {
  registered?: boolean;
  run?: typeof runLaunchctl;
} = {}): ServiceSupervisorProbe {
  const artifactRegistered = deps.registered ?? existsSync(plistPath());
  const states: ServiceSupervisorProbe[] = launchdLabels().map(label => {
    const result = (deps.run ?? runLaunchctl)(["print", `${launchdGuiDomain()}/${label}`]);
    if (result.ok) {
      return { registrationState: "present", supervisorState: "active", enabled: true };
    }
    // 113 is launchctl's stable "service not found in an existing domain" status.
    // A missing GUI domain (112), spawn error, signal, or any other failure is not absence.
    if (result.status === 113) {
      return {
        registrationState: artifactRegistered ? "present" : "absent",
        supervisorState: "inactive",
        enabled: artifactRegistered,
      };
    }
    return {
      registrationState: artifactRegistered ? "present" : "indeterminate",
      supervisorState: "indeterminate",
      enabled: null,
      detail: result.stderr || `launchctl print failed with status ${String(result.status)}`,
    };
  });
  return {
    registrationState: combineRegistrationStates(...states.map(state => state.registrationState)),
    supervisorState: combineSupervisorStates(...states.map(state => state.supervisorState)),
    enabled: states.every(state => state.enabled === false)
      ? false
      : states.some(state => state.enabled === true) ? true : null,
    detail: states.map(state => state.detail).filter(Boolean).join("; ") || undefined,
  };
}
function uninstallLaunchd(): void {
  const owned: string[] = [];
  for (const label of launchdLabels()) {
    const p = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    if (!existsSync(p)) continue;
    assertOwnedLaunchdPlist(p);
    owned.push(p);
    try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
  }
  // Keep the plist and install state available while proving the launcher is ours.
  // A foreign file or symlink at the same path is preserved.
  removeLaunchdExecutable();
  for (const p of owned) removeOwnedPrivateServiceFile(p, ownsLaunchdPlist);
}

// ── Windows (Task Scheduler) ──
/**
 * In-place service-asset write that tolerates the transient EBUSY/EPERM/EACCES Windows
 * throws while the just-ended task's cmd.exe (or an AV scanner) still holds the file.
 */
function writeServiceAssetWithRetry(
  path: string,
  content: string,
  encoding: "utf8" | "utf16le",
  ownsExisting: (content: string) => boolean,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      writePrivateServiceFile(path, content, { encoding, mode: 0o600, ownsExisting });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 2 || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw err;
      Bun.sleepSync(150);
    }
  }
}

/**
 * Rewrite on-disk scheduler assets (script/VBS/XML) without re-registering the task.
 * Used by fresh install (before schtasks /create) and by repair (no elevation).
 */
function writeWindowsSchedulerAssets(): void {
  ensurePrivateServiceDirectory(getConfigDir());
  writeServiceApiTokenFile();
  const script = windowsServiceScriptPath();
  writeServiceAssetWithRetry(script, buildWindowsServiceScript(), "utf8", ownsWindowsServiceScript);
  // UTF-16LE + BOM: a BOM-less UTF-8 VBS mis-decodes non-ASCII (e.g. Korean) profile
  // paths on some WSH/codepage combinations — same contract as the task XML below.
  writeServiceAssetWithRetry(windowsLauncherVbsPath(), `\uFEFF${buildWindowsLauncherVbs(script)}`, "utf16le", ownsWindowsLauncherVbs);
  writeServiceAssetWithRetry(windowsTaskXmlPath(), `\uFEFF${buildWindowsTaskXml(script)}`, "utf16le", ownsWindowsTaskXml);
}

function installWindows(): void {
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  // Transactional backend switch: installing the scheduler backend removes a native
  // service first — two live managers would both respawn the proxy (conflict).
  if (statusWinswRaw() !== "nonexistent") {
    console.log("🔁 Removing the native (WinSW) service before installing the Task Scheduler backend...");
    try {
      uninstallWinswService();
    } catch (err) {
      throw new Error(`Cannot remove the native service before switching to Task Scheduler: ${err instanceof Error ? err.message : String(err)}. Remove it manually with 'sc delete ${WINSW_SERVICE_ID}' or retry.`);
    }
    if (statusWinswRaw() !== "nonexistent") {
      throw new Error(`Native service registration could not be re-verified after the removal attempt — aborting switch. Check 'sc.exe query ${WINSW_SERVICE_ID}' and remove it manually if present.`);
    }
  }
  // A deterministic task name may already belong to another program. Prove the
  // complete current registration before `/create /f` could replace it.
  assertOwnedWindowsSchedulerTask();
  // End a running task BEFORE rewriting the assets it is executing — cmd.exe reading the
  // script mid-rewrite runs a torn batch file, and its open handle can fail the write.
  try { stopWindows(); } catch { /* not running */ }
  writeWindowsSchedulerAssets();
  schtasks(buildWindowsSchtasksCreateArgs(windowsServiceScriptPath()));
  schtasks(["/run", "/tn", TASK]);
  writeServiceInstallState("scheduler");
}

export interface RepairServiceDeps {
  diagnose?: () => ServiceDiagnostic;
  assertEnv?: () => void;
  assertAuth?: () => void;
  writeSchedulerAssets?: () => void;
  stopScheduler?: () => void;
  startScheduler?: () => void;
  writeSchedulerState?: () => void;
  writeNativeState?: () => void;
  repairNative?: () => void | Promise<void>;
  repairLaunchd?: () => void;
  repairSystemd?: () => void;
  /** Test seam — defaults to process.platform so Linux CI cannot hit real installSystemd. */
  platform?: NodeJS.Platform;
}

/**
 * Repair an already-installed background service without Task Scheduler re-registration.
 *
 * Windows scheduler: rewrite assets + stop/start — no `schtasks /create`, no UAC.
 * Windows native: WinSW asset rewrite + restart (skips `install /p` when present).
 * macOS/Linux: re-run the user-level install/reload path.
 */
export async function repairService(deps: RepairServiceDeps = {}): Promise<void> {
  const diagnose = deps.diagnose ?? diagnoseService;
  const platform = deps.platform ?? process.platform;
  const diag = diagnose();
  if (!diag.supported) {
    throw new Error(`Background service is unsupported (${diag.summary}).`);
  }
  if (diag.conflict) {
    throw new Error(
      "Cannot repair while Task Scheduler and native WinSW are both present. "
        + "Run 'ccx service uninstall' then reinstall one backend with 'ccx service install'.",
    );
  }
  if (diag.registrationState === "indeterminate" || diag.supervisorState === "indeterminate") {
    throw new Error("Background service state is indeterminate. Restore service-manager access and retry.");
  }
  if (diag.registrationState === "absent") {
    throw new Error("Background service is not installed. Run 'ccx service install' first.");
  }

  (deps.assertEnv ?? assertServiceEnvironmentMatchesInstall)();
  (deps.assertAuth ?? assertServiceAuthEnvironment)();

  if (platform === "win32") {
    if (diag.backend === "native") {
      await (deps.repairNative ?? (() => installWinswService(defaultWinswEntry(import.meta.dir))))();
      (deps.writeNativeState ?? (() => writeServiceInstallState("native")))();
      return;
    }
    try { (deps.stopScheduler ?? stopWindows)(); } catch { /* not running */ }
    (deps.writeSchedulerAssets ?? writeWindowsSchedulerAssets)();
    (deps.startScheduler ?? startWindows)();
    (deps.writeSchedulerState ?? (() => writeServiceInstallState("scheduler")))();
    return;
  }
  if (platform === "darwin") {
    (deps.repairLaunchd ?? installLaunchd)();
    return;
  }
  if (platform === "linux") {
    (deps.repairSystemd ?? installSystemd)();
    return;
  }
  throw new Error(`Background service repair is unsupported on ${platform}.`);
}

/**
 * Opt-in native backend (`ccx service install --native`). Transactional: removes the
 * scheduler backend first; on failure the machine is left with NO service (explicitly
 * reported) — never a silent fallback to the scheduler.
 */
/** Refuse WinSW when the interactive user is a Microsoft account (SCM cannot authenticate it). */
export function assertWindowsNativeServiceAccountSupported(): void {
  if (process.platform !== "win32") return;
  const source = readWindowsPrincipalSource();
  if (source?.toLowerCase() === "microsoftaccount") {
    throw new Error(
      "The native (WinSW) service backend cannot run under a Microsoft-account Windows login. "
        + "Keep the Task Scheduler backend (`ccx service install`) or sign in with a local/domain account before `ccx service install --native`.",
    );
  }
}

function readWindowsPrincipalSource(): string | null {
  if (process.platform !== "win32") return null;
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(ps)) return null;
  try {
    const out = execFileSync(ps, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-LocalUser -Name $env:USERNAME -ErrorAction SilentlyContinue).PrincipalSource",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function installWindowsNative(): Promise<void> {
  assertWindowsNativeServiceAccountSupported();
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  ensurePrivateServiceDirectory(getConfigDir());
  writeServiceApiTokenFile();
  let hadScheduler = false;
  for (const taskName of windowsTaskNames()) {
    try {
      if (schtasks(["/query", "/tn", taskName]).includes(taskName)) {
        hadScheduler = true;
        break;
      }
    } catch { /* task absent */ }
  }
  if (hadScheduler) {
    console.log("🔁 Removing the Task Scheduler backend before installing the native (WinSW) service...");
    try { stopWindows(); } catch { /* not running */ }
    try {
      uninstallWindows();
    } catch (err) {
      throw new Error(`Cannot remove the Task Scheduler backend before switching to native: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Verify removal — schtasks /delete can silently fail if UAC or policy blocks it.
    try {
      if (windowsTaskNames().some(taskName => {
        try { return schtasks(["/query", "/tn", taskName]).includes(taskName); } catch { return false; }
      })) {
        throw new Error("Task Scheduler backend still present after removal — aborting switch.");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("still present")) throw e;
      /* query failure = task absent, which is what we want */
    }
  }
  try {
    await installWinswService(defaultWinswEntry(import.meta.dir));
  } catch (err) {
    if (hadScheduler) console.error("⚠️  Native install failed AFTER removing the Task Scheduler backend — no service is installed now. Run `ccx service install` to restore the scheduler backend, or retry `--native`.");
    throw err;
  }
  writeServiceInstallState("native");
}
function windowsTaskNames(): readonly string[] {
  return [TASK];
}

export interface WindowsSchedulerStartIo {
  assertOwned?: (taskName: string) => boolean;
  run?: (taskName: string) => void;
}

/** Start only a scheduler registration whose exact current ownership is proven. */
export function startOwnedWindowsSchedulerTask(io: WindowsSchedulerStartIo = {}): void {
  const assertOwned = io.assertOwned ?? assertOwnedWindowsSchedulerTask;
  const run = io.run ?? ((taskName: string) => schtasks(["/run", "/tn", taskName]));
  for (const taskName of windowsTaskNames()) {
    if (!assertOwned(taskName)) continue;
    run(taskName);
    return;
  }
  throw new Error(`Task Scheduler task ${TASK} is not installed; refusing to run an unowned task name.`);
}

function startWindows(): void {
  startOwnedWindowsSchedulerTask();
}

export function isWindowsSchedulerEndBenign(error: unknown): boolean {
  const detail = schtasksErrorDetail(error).toLowerCase();
  return detail.includes("no running instance")
    || detail.includes("not currently running")
    || detail.includes("0x41330");
}

/**
 * End the scheduler task. "Already stopped" is success; an unverified task or any
 * other `/end` failure blocks later proxy cleanup so an active supervisor cannot
 * respawn behind a reported-successful stop.
 *
 * Do not key a restart-window wait on `/end` failure: the #764 case is an `/end`
 * that *succeeds* while the wrapper survives and respawns. That verification lives
 * on the stop-verification path (poll across the restart window), not here.
 */
export function stopWindows(): void {
  for (const taskName of windowsTaskNames()) {
    const probe = probeWindowsSchedulerTask(taskName);
    if (probe.status === "absent") continue;
    if (probe.status === "unknown") {
      throw new Error(`Task Scheduler task ${taskName} presence could not be verified: ${probe.detail}`);
    }
    if (!assertOwnedWindowsSchedulerTask(taskName)) continue;
    try {
      schtasks(["/end", "/tn", taskName]);
    } catch (error) {
      if (!isWindowsSchedulerEndBenign(error)) throw error;
    }
  }
}
function statusWindowsXml(): string {
  for (const taskName of windowsTaskNames()) {
    const probe = probeWindowsSchedulerTask(taskName);
    if (probe.status === "absent") continue;
    if (probe.status === "unknown") {
      throw new Error(`Task Scheduler task ${taskName} presence could not be verified: ${probe.detail}`);
    }
    try {
      return schtasks(["/query", "/tn", taskName, "/xml"]);
    } catch (error) {
      throw new Error(
        `Task Scheduler task ${taskName} XML could not be read: ${schtasksErrorDetail(error)}`,
      );
    }
  }
  return "";
}
function uninstallWindows(): void {
  for (const taskName of windowsTaskNames()) {
    const owned = assertOwnedWindowsSchedulerTask(taskName);
    if (owned) {
      try {
        schtasks(["/delete", "/tn", taskName, "/f"]);
      } catch (error) {
        throw new Error(`Failed to delete Task Scheduler task ${taskName}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const afterDelete = probeWindowsSchedulerTask(taskName);
      if (afterDelete.status === "present") {
        throw new Error(`Task Scheduler task ${taskName} is still present after delete — refusing to remove service assets. Retry from an elevated shell.`);
      }
      if (afterDelete.status === "unknown") {
        throw new Error(`Task Scheduler task ${taskName} presence could not be verified after delete — refusing to remove service assets.`);
      }
    }
  }
  for (const path of [
    [join(getConfigDir(), "codexcommander-service.cmd"), ownsWindowsServiceScript, "utf8"] as const,
    [join(getConfigDir(), "codexcommander-service-launcher.vbs"), ownsWindowsLauncherVbs, "utf16le"] as const,
    [join(getConfigDir(), "codexcommander-service-task.xml"), ownsWindowsTaskXml, "utf16le"] as const,
  ]) {
    removeOwnedPrivateServiceFile(path[0], path[1], path[2]);
  }
}

/**
 * Warn when the paths baked into installed service assets no longer exist (npm prefix
 * moved, nvm switch, reinstall) — the service manager would restart-loop on a dead path
 * while `schtasks`/`launchctl` still report "installed".
 */
export function bakedServicePathsDiagnostic(): string | null {
  const state = readServiceInstallState();
  if (!state?.bunPath || !state?.cliPath) return null;
  const missing = [state.bunPath, state.cliPath].filter(path => !existsSync(path));
  if (missing.length === 0) return null;
  return `STALE baked paths (missing: ${missing.join(", ")}) — run 'ccx service repair' to re-bake`;
}

export function serviceDiagnosticsSummary(): string {
  const stale = bakedServicePathsDiagnostic();
  const launcherStale = process.platform === "darwin" && existsSync(plistPath())
    ? launchdExecutableDiagnostic()
    : null;
  const diagnostics = [stale, launcherStale].filter((value): value is string => Boolean(value));
  return diagnostics.length > 0
    ? `${diagnostics.join("; ")}; logs: ${serviceLogPath()}`
    : `logs: ${serviceLogPath()}`;
}

// ── Linux (systemd user unit) ──
function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitPath(): string {
  return join(unitDir(), `${TASK}.service`);
}

function ownsSystemdUnit(content: string): boolean {
  return content.includes("Description=CodexCommander Proxy Server")
    && content.includes(`ExecStart=${systemdQuote("/bin/sh")} -lc `)
    && content.includes("CCX_SERVICE=1");
}

function assertOwnedSystemdUnit(path = unitPath()): void {
  assertPrivateServiceFile(path);
  if (!ownsSystemdUnit(readFileSync(path, "utf8"))) {
    throw new Error(`Refusing to mutate foreign systemd definition: ${path}`);
  }
}

function systemdUnitName(): string {
  return TASK;
}

function systemdUnitNames(): readonly string[] {
  return [TASK];
}

export function buildUnit(): string {
  const { bun, bunRuntimeSource, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = systemdEnvironmentAssignment("CODEX_HOME", process.env.CODEX_HOME?.trim());
  const codexCommanderHome = systemdEnvironmentAssignment(HOME_ENV, process.env[HOME_ENV]?.trim());
  const kimiCodeHome = systemdEnvironmentAssignment("KIMI_CODE_HOME", process.env.KIMI_CODE_HOME?.trim());
  const grokHome = systemdEnvironmentAssignment("GROK_HOME", process.env.GROK_HOME?.trim());
  const envLines = [
    systemdEnvironmentAssignment("CCX_SERVICE", "1"),
    systemdEnvironmentAssignment(BUN_RUNTIME_SOURCE_ENV, bunRuntimeSource),
    systemdEnvironmentAssignment(BUN_RUNTIME_PATH_ENV, bun),
    systemdEnvironmentAssignment("PATH", path),
    codexHome,
    codexCommanderHome,
    kimiCodeHome,
    grokHome,
  ].filter((line): line is string => Boolean(line)).join("\n");
  return `[Unit]
Description=CodexCommander Proxy Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote("/bin/sh")} -lc ${systemdQuote(buildServiceShellCommand(bun, cli))}
Restart=on-failure
RestartSec=5
${envLines}
StandardOutput=${systemdOutputTarget(`append:${log}`)}
StandardError=${systemdOutputTarget(`append:${log}`)}

[Install]
WantedBy=default.target
`;
}

/** The per-user runtime dir systemd creates (holds the user-bus socket), or null. */
function userRuntimeDir(): string | null {
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (typeof process.getuid === "function") {
    const candidate = `/run/user/${process.getuid()}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * SSH sessions frequently start without `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`, so
 * `systemctl --user` can't find the user bus even when systemd is running. Point `XDG_RUNTIME_DIR`
 * at the per-user runtime dir when it exists so the `--user` probe and install commands reach the
 * bus. No-op when already set or when no runtime dir exists (e.g. genuinely non-systemd hosts).
 */
function ensureUserBusEnv(): void {
  if (process.env.XDG_RUNTIME_DIR) return;
  const dir = userRuntimeDir();
  if (dir) process.env.XDG_RUNTIME_DIR = dir;
}

function isSystemd(): boolean {
  try { execSync("systemctl --version", { stdio: "pipe" }); } catch { return false; }
  ensureUserBusEnv();
  // Prefer the user-bus probe; but an SSH session without a user D-Bus fails it even when systemd
  // is present (F9). Fall back to the per-user runtime dir existing — a strong signal the user
  // systemd instance is available — so a first-time `ccx service install` isn't wrongly refused.
  try { execSync("systemctl --user show-environment", { stdio: "pipe" }); return true; } catch { /* no user bus in this session */ }
  return userRuntimeDir() !== null;
}

function installSystemd(): void {
  ensureUserBusEnv(); // reach the user bus over a bare SSH session (F9)
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  ensurePrivateServiceDirectory(getConfigDir());
  writeServiceApiTokenFile();
  writePrivateServiceFile(unitPath(), buildUnit(), {
    mode: 0o600,
    parent: "physical",
    ownsExisting: ownsSystemdUnit,
  });
  sh("systemctl --user daemon-reload");
  sh(`systemctl --user enable ${TASK}`);
  sh(`systemctl --user restart ${TASK}`);
  writeServiceInstallState();
}
/**
 * Whether systemd's in-memory unit differs from the file on disk.
 *
 * The systemd analogue of launchd's stale-plist case: writing
 * `~/.config/systemd/user/<unit>` does not change the definition systemd has loaded
 * until `daemon-reload`, so a plain `systemctl start` would run the PREVIOUS
 * ExecStart. `NeedDaemonReload` is a per-unit property emitted as a bare
 * `NeedDaemonReload=yes|no` line; pass the unit name or `show` reports the manager's
 * own property instead, which answers a different question.
 *
 * Fail-open: if the query cannot run (no user bus, unit absent) we must not block a
 * start that would otherwise work.
 */
export function systemdNeedsDaemonReload(deps: { show?: () => string } = {}): boolean {
  try {
    const out = (deps.show ?? (() => sh(`systemctl --user show -p NeedDaemonReload ${systemdUnitName()}`)))();
    return /NeedDaemonReload\s*=\s*yes/i.test(out);
  } catch {
    return false;
  }
}

export interface SystemdStartIo {
  ensureBus?: () => void;
  exists?: (path: string) => boolean;
  assertOwned?: (path: string) => void;
  needsReload?: () => boolean;
  run?: (command: string) => void;
}

/** Start only the exact current systemd unit after proving its on-disk ownership. */
export function startOwnedSystemdUnit(io: SystemdStartIo = {}): void {
  (io.ensureBus ?? ensureUserBusEnv)();
  const path = unitPath();
  if (!(io.exists ?? existsSync)(path)) {
    throw new Error(`CodexCommander service is not installed: ${path}. Run \`ccx service install\` first.`);
  }
  (io.assertOwned ?? assertOwnedSystemdUnit)(path);
  const run = io.run ?? sh;
  // The unit on disk may be newer than what systemd loaded; starting now would run
  // the previous definition.
  //
  // `start` alone is not enough after a reload: it is a no-op on an already-active
  // unit, so the stale process would keep running the old ExecStart. NeedDaemonReload
  // compares disk against loaded, never loaded against running, so the only way to
  // make the running process match the file is to restart it.
  if ((io.needsReload ?? systemdNeedsDaemonReload)()) {
    console.log("ℹ️  unit file changed on disk; reloading systemd and restarting the service.");
    run("systemctl --user daemon-reload");
    run(`systemctl --user restart ${systemdUnitName()}`);
    return;
  }
  run(`systemctl --user start ${systemdUnitName()}`);
}

function startSystemd(): void {
  startOwnedSystemdUnit();
}
function stopSystemd(): void {
  for (const unit of systemdUnitNames()) {
    const path = join(unitDir(), `${unit}.service`);
    if (!existsSync(path)) continue;
    assertOwnedSystemdUnit(path);
    sh(`systemctl --user stop ${unit}`);
  }
}

/** Read systemd registration/runtime state without treating bus/query failure as inactive. */
export function probeSystemdSupervisor(deps: {
  registered?: boolean;
  show?: (unit?: string) => string;
} = {}): ServiceSupervisorProbe {
  ensureUserBusEnv();
  const show = deps.show ?? (unit => sh(
    `systemctl --user show ${unit ?? systemdUnitName()} -p LoadState -p ActiveState -p UnitFileState`,
  ));
  const states: ServiceSupervisorProbe[] = systemdUnitNames().map(unit => {
    const artifactRegistered = deps.registered
      ?? existsSync(join(unitDir(), `${unit}.service`));
    let output: string;
    try {
      output = show(unit);
    } catch (error) {
      return {
        registrationState: artifactRegistered ? "present" : "indeterminate",
        supervisorState: "indeterminate",
        enabled: null,
        detail: `systemctl query failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const properties = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator > 0) properties.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    const load = properties.get("LoadState");
    const active = properties.get("ActiveState");
    const unitFile = properties.get("UnitFileState");
    if (!active || !load) {
      return {
        registrationState: artifactRegistered ? "present" : "indeterminate",
        supervisorState: "indeterminate",
        enabled: null,
        detail: "systemctl returned incomplete service state",
      };
    }
    const registrationState: ServiceRegistrationState = artifactRegistered || load !== "not-found"
      ? "present"
      : "absent";
    let supervisorState: ServiceSupervisorState;
    if (["active", "activating", "reloading", "deactivating"].includes(active)) {
      supervisorState = "active";
    } else if (["inactive", "failed"].includes(active)) {
      supervisorState = "inactive";
    } else {
      supervisorState = "indeterminate";
    }
    const enabled = unitFile === undefined
      ? null
      : ["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"].includes(unitFile);
    return { registrationState, supervisorState, enabled };
  });
  return {
    registrationState: combineRegistrationStates(...states.map(state => state.registrationState)),
    supervisorState: combineSupervisorStates(...states.map(state => state.supervisorState)),
    enabled: states.every(state => state.enabled === false)
      ? false
      : states.some(state => state.enabled === true) ? true : null,
    detail: states.map(state => state.detail).filter(Boolean).join("; ") || undefined,
  };
}
function uninstallSystemd(): void {
  const owned: string[] = [];
  for (const unit of systemdUnitNames()) {
    const path = join(unitDir(), `${unit}.service`);
    if (!existsSync(path)) continue;
    assertOwnedSystemdUnit(path);
    owned.push(path);
    try { sh(`systemctl --user disable --now ${unit}`); } catch { /* absent */ }
  }
  for (const path of owned) removeOwnedPrivateServiceFile(path, ownsSystemdUnit);
  try { sh("systemctl --user daemon-reload"); } catch { /* best-effort */ }
}

export type ServiceOps = {
  install: () => void | Promise<void>;
  start: () => void;
};

export function platformOps(backend: ServiceBackend = "scheduler"): ServiceOps | null {
  if (process.platform === "darwin")
    return { install: installLaunchd, start: startLaunchd };
  if (process.platform === "win32") {
    if (backend === "native")
      return { install: installWindowsNative, start: startWinswService };
    return { install: installWindows, start: startWindows };
  }
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) {
      console.error("Docker detected. Run 'ccx start' directly instead of using the service manager.");
      process.exit(1);
    }
    if (!isSystemd() && !existsSync(unitPath())) {
      console.error("systemd not found. Run 'ccx start' under your process supervisor.");
      if (isWslRuntime()) {
        console.error("WSL detected: enable systemd by adding [boot] systemd=true to /etc/wsl.conf, then run 'wsl --shutdown' from Windows and reopen the distro (WSL 0.67.6+).");
      }
      process.exit(1);
    }
    return { install: installSystemd, start: startSystemd };
  }
  return null;
}

function verifiedKillTarget(pid: number | null | undefined): number | null {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const verified = verifyPidIdentity(pid);
  return verified === pid ? verified : null;
}

/**
 * Whether a proxy is still answering after the service manager claimed to stop it.
 *
 * `ops.stop()` reports the outcome of the STOP COMMAND, not of the process. A Windows scheduler
 * task whose wrapper survives `schtasks /end` respawns its child a few seconds later, so a stop
 * that returned success can still leave a live proxy — and `ccx service stop` then restored
 * native Codex on top of a running one (#764). The tracked-pid cleanup does not catch it either:
 * the respawned child writes a different pid, or none this process knows about.
 *
 * Probed rather than assumed, and bounded. The respawn risk is specific to a supervisor that can
 * restart its child — the Windows scheduler wrapper — so only that case pays the restart window.
 * Everywhere else a single probe answers the question, because nothing is going to bring the
 * proxy back after `launchctl unload` or `systemctl stop`. Making every platform wait 7s on a
 * stop that already succeeded would trade one bug for a worse everyday one.
 */
export async function proxyStillLiveAfterStop(deps: {
  findProxy?: () => Promise<{ port: number } | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Whether the stopped supervisor can respawn its child; only then is polling worth the wait. */
  canRespawn?: boolean;
} = {}): Promise<{ port: number } | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const canRespawn = deps.canRespawn ?? process.platform === "win32";
  const deadline = now() + (canRespawn ? 7000 : 0);
  // Single-shot (non-respawn) still needs one full SERVICE_STOP_LIVENESS budget; respawn
  // polling shares the outer deadline so multi-candidate discovery cannot overrun it.
  const findProxy = deps.findProxy ?? (() => {
    const probeDeadline = canRespawn
      ? deadline
      : now() + (SERVICE_STOP_LIVENESS.timeoutMs! * SERVICE_STOP_LIVENESS.attempts! + 250);
    return findLiveProxy({ ...SERVICE_STOP_LIVENESS, deadlineAt: probeDeadline, nowFn: now });
  });
  let lastProbeUncertain = false;
  for (;;) {
    try {
      const live = await findProxy();
      lastProbeUncertain = false;
      if (live) return live;
    } catch {
      // A probe failure is not proof the proxy is gone; keep polling until the deadline,
      // then fail closed if the terminal observation is still indeterminate.
      lastProbeUncertain = true;
    }
    if (now() >= deadline) {
      if (lastProbeUncertain) throw new Error("Proxy stop liveness could not be verified.");
      return null;
    }
    await sleep(1000);
  }
}

async function stopTrackedProxyIfRunning(
  lifecycleLease: ProxyLifecycleLockLease,
): Promise<void> {
  const pid = readPid();
  const trackedKillPid = verifiedKillTarget(pid);
  if (trackedKillPid !== null && isProcessAlive(trackedKillPid)) {
    await stopProxy(trackedKillPid, { lifecycleLease });
    removePid(trackedKillPid);
    removeRuntimePort(trackedKillPid);
  } else if (pid) {
    removePid(pid);
    removeRuntimePort(pid);
  }
  // Orphan recovery: the pid file can be missing/stale while the service wrapper keeps
  // a live proxy running — mirror `ccx stop`'s identity-checked findLiveProxy fallback.
  // Cap multi-candidate discovery so stop cleanup cannot hang for three full retry budgets.
  const live = await findLiveProxy({
    ...SERVICE_STOP_LIVENESS,
    deadlineAt: Date.now() + 7000,
  });
  const liveKillPid = verifiedKillTarget(live?.pid);
  if (liveKillPid !== null) {
    await stopProxy(liveKillPid, { lifecycleLease });
    removePid(liveKillPid);
    removeRuntimePort(liveKillPid);
  }
}

/** Cleanup is a required step; failure propagates and cannot become a success-shaped result. */
export async function stopTrackedProxyForServiceCommand(
  lifecycleLease: ProxyLifecycleLockLease,
): Promise<void> {
  await stopTrackedProxyIfRunning(lifecycleLease);
}

/**
 * Start an installed, viable service without producing CLI output. Shared lifecycle
 * coordinators perform their own identity-checked health wait and user-facing reporting.
 * Returns false when no service is installed; stale, conflicting, or foreign installs
 * fail closed instead of being bypassed by an unmanaged proxy.
 */
export function startServiceIfInstalled(): boolean {
  assertServiceEnvironmentMatchesInstall();
  const diagnostic = diagnoseService();
  if (!diagnostic.installed) return false;
  if (!serviceStartableFromTray(diagnostic)) {
    throw new Error("Installed service is not safe to start; repair or remove it first");
  }
  const backend: ServiceBackend = process.platform === "win32"
    ? readServiceBackend()
    : "scheduler";
  const ops = platformOps(backend);
  if (!ops) throw new Error(`Background service is unsupported on ${process.platform}`);
  ops.start();
  return true;
}

/**
 * If a service is installed, stop it so the process manager doesn't respawn after `ccx stop`.
 * Returns true if a service was found and stopped.
 */
export function stopServiceIfInstalled(): boolean {
  assertServiceEnvironmentMatchesInstall();
  if (process.platform === "darwin") {
    const probe = probeLaunchdSupervisor();
    if (probe.registrationState === "indeterminate"
      || (probe.registrationState === "present" && probe.supervisorState === "indeterminate")) {
      throw new Error(`launchd status could not be verified: ${probe.detail ?? "unknown error"}`);
    }
    if (probe.registrationState === "absent") return false;
    if (probe.supervisorState === "active") stopLaunchd();
    return true;
  } else if (process.platform === "win32") {
    // Query BOTH backends regardless of state: a failed switch or stale state can leave
    // two managers installed, and either one would respawn the proxy after `ccx stop`.
    let stopped = false;
    for (const taskName of windowsTaskNames()) {
      const probe = probeWindowsSchedulerTask(taskName);
      if (probe.status === "unknown") {
        throw new Error(`Task Scheduler task ${taskName} presence could not be verified: ${probe.detail}`);
      }
      if (probe.status === "present") {
        stopWindows();
        stopped = true;
        break;
      }
    }
    const nativeStatus = statusWinswRaw();
    const native = probeWinswSupervisor(nativeStatus);
    if (native.registrationState === "indeterminate") {
      // Unknown SCM status is not absence. Attempt the ownership-checked stop so a
      // known Scheduler registration can still be quiesced when a second native
      // registration may exist; any unverified/foreign definition throws closed.
      stopWinswService();
      stopped = true;
    } else if (native.registrationState === "present") {
      if (native.supervisorState === "active") stopWinswService();
      stopped = true;
    }
    if (stopped) return true;
  } else if (process.platform === "linux" && isSystemd()) {
    const probe = probeSystemdSupervisor();
    if (probe.registrationState === "indeterminate"
      || (probe.registrationState === "present" && probe.supervisorState === "indeterminate")) {
      throw new Error(`systemd status could not be verified: ${probe.detail ?? "unknown error"}`);
    }
    if (probe.registrationState === "absent") return false;
    if (probe.supervisorState === "active") stopSystemd();
    return true;
  }
  return false;
}

/** Delete install-state files so later service inspection cannot report a removed install. */
export function removeServiceInstallState(paths: readonly string[] = serviceStatePaths()): void {
  for (const path of paths) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
  }
}

export interface SystemdUninstallIo {
  exists?: () => boolean;
  uninstall?: () => void;
  removeState?: () => void;
}

/** Remove systemd state only after the owned unit was successfully verified and removed. */
export function uninstallOwnedSystemdIfPresent(io: SystemdUninstallIo = {}): boolean {
  const exists = io.exists ?? (() => existsSync(unitPath()));
  if (!exists()) return false;
  (io.uninstall ?? uninstallSystemd)();
  (io.removeState ?? removeServiceInstallState)();
  return true;
}

/**
 * Best-effort service removal for full uninstall. Unlike `ccx service uninstall`, this is quiet
 * when no service exists and never exits the process just because the platform has no service
 * manager.
 */
export function uninstallServiceIfInstalled(): boolean {
  assertServiceEnvironmentMatchesInstall();
  if (process.platform === "darwin") {
    const probe = probeLaunchdSupervisor();
    if (probe.registrationState === "indeterminate"
      || (probe.registrationState === "present" && probe.supervisorState === "indeterminate")) {
      throw new Error(`launchd status could not be verified before uninstall: ${probe.detail ?? "unknown error"}`);
    }
    if (probe.registrationState === "absent") return false;
    uninstallLaunchd();
    removeServiceInstallState();
    return true;
  } else if (process.platform === "win32") {
    let removed = false;
    for (const taskName of windowsTaskNames()) {
      const probe = probeWindowsSchedulerTask(taskName);
      if (probe.status === "unknown") {
        throw new Error(`Task Scheduler task ${taskName} presence could not be verified before uninstall: ${probe.detail}`);
      }
      if (probe.status === "present") { uninstallWindows(); removed = true; break; }
    }
    const native = probeWinswSupervisor();
    if (native.registrationState === "indeterminate") {
      // Unknown is possibly installed, never absence. The WinSW helper independently
      // proves SCM ownership (or a stale owned registration) before deleting.
      uninstallWinswService();
      removed = true;
    }
    else if (native.registrationState === "present") {
      uninstallWinswService();
      removed = true;
    }
    if (removed) { removeServiceInstallState(); return true; }
  } else if (process.platform === "linux") {
    return uninstallOwnedSystemdIfPresent();
  }
  return false;
}

/** True if a background service (launchd/systemd/Task Scheduler) is installed. */
export function isServiceInstalled(): boolean {
  return diagnoseService().installed;
}

/**
 * True when an installed background service can actually supervise the proxy.
 * Presence alone is not enough: stale/missing assets, conflicts, and disabled
 * registrations report `installed` but will not bring the proxy back after exit.
 */
export function isServiceViable(): boolean {
  return diagnoseService().viable;
}

export interface ServiceDiagnostic {
  supported: boolean;
  registrationState: ServiceRegistrationState;
  supervisorState: ServiceSupervisorState;
  /** Compatibility projection: true for present or indeterminate, false only for proven absence. */
  installed: boolean;
  enabled: boolean;
  running: boolean;
  viable: boolean;
  startable: boolean;
  stale: boolean;
  conflict: boolean;
  backend: ServiceBackend | "launchd" | "systemd" | null;
  summary: string;
}

/** Windows tray may restart a healthy-but-stopped native service; stale/conflicting installs remain blocked. */
export function serviceStartableFromTray(service: ServiceDiagnostic): boolean {
  return service.registrationState === "present"
    && service.supervisorState !== "indeterminate"
    && service.startable && !service.stale && !service.conflict;
}

export interface WindowsServiceDiagnosticInputs {
  /**
   * Raw `schtasks /query /xml` output; empty when no task is registered. Passed as
   * XML rather than pre-computed booleans so every caller reads the document through
   * readWindowsSchedulerXmlState() — a second, stricter reading elsewhere would
   * silently reintroduce the stale-status false positive (#432).
   */
  schedulerXml: string;
  /** Authoritative Scheduler probe. Defaults from schedulerXml for compatibility callers. */
  schedulerProbe?: ServiceSupervisorProbe;
  /** Whether the on-disk service assets exist. A filesystem concern, not an XML one. */
  schedulerAssetsPresent: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  recordedBackend: ServiceBackend | null;
  staleBakedPaths: boolean;
  nativeRepairAssetsOnly: boolean;
  diagnostics: string;
}

export function deriveWindowsServiceDiagnostic(inputs: WindowsServiceDiagnosticInputs): ServiceDiagnostic {
  const schedulerState = readWindowsSchedulerXmlState(inputs.schedulerXml);
  const schedulerProbe = inputs.schedulerProbe ?? {
    registrationState: schedulerState.installed ? "present" : "absent",
    supervisorState: schedulerState.installed && schedulerState.enabled ? "active" : "inactive",
    enabled: schedulerState.installed ? schedulerState.enabled : false,
  } satisfies ServiceSupervisorProbe;
  const schedulerInstalled = schedulerProbe.registrationState === "present";
  const schedulerIndeterminate = schedulerProbe.registrationState === "indeterminate"
    || schedulerProbe.supervisorState === "indeterminate";
  const schedulerEnabled = schedulerProbe.enabled === true;
  const schedulerAssetsHealthy = inputs.schedulerAssetsPresent && schedulerState.registrationHealthy;
  const nativeProbe = probeWinswSupervisor(inputs.nativeStatus);
  const nativeInstalled = nativeProbe.registrationState === "present";
  const nativeIndeterminate = nativeProbe.registrationState === "indeterminate"
    || nativeProbe.supervisorState === "indeterminate";
  const conflict = schedulerInstalled && nativeInstalled;
  const backendStateMismatch = schedulerInstalled
    ? inputs.recordedBackend !== "scheduler"
    : nativeInstalled && inputs.recordedBackend !== "native";
  const stale = inputs.staleBakedPaths
    || (schedulerInstalled && !schedulerAssetsHealthy)
    || backendStateMismatch
    || (inputs.nativeStatus === "nonexistent" && inputs.nativeRepairAssetsOnly);
  const backend = schedulerInstalled ? "scheduler"
    : nativeInstalled ? "native"
      : schedulerIndeterminate && inputs.recordedBackend === "scheduler" ? "scheduler"
        : nativeIndeterminate && inputs.recordedBackend === "native" ? "native"
          : null;
  const registrationState: ServiceRegistrationState = schedulerInstalled || nativeInstalled
    ? "present"
    : schedulerIndeterminate || nativeIndeterminate ? "indeterminate" : "absent";
  const supervisorState: ServiceSupervisorState = conflict
    ? "indeterminate"
    : schedulerIndeterminate || nativeIndeterminate ? "indeterminate"
      : schedulerInstalled ? schedulerProbe.supervisorState
        : nativeInstalled ? nativeProbe.supervisorState
          : "inactive";
  const installed = registrationState !== "absent";
  const enabled = schedulerInstalled ? schedulerEnabled : nativeProbe.enabled === true;
  const running = supervisorState === "active";
  const viable = registrationState === "present" && supervisorState === "active"
    && !schedulerIndeterminate && !nativeIndeterminate && !conflict && !stale
    && (schedulerInstalled ? schedulerEnabled && schedulerAssetsHealthy : inputs.nativeStatus === "started");
  const startable = registrationState === "present" && !schedulerIndeterminate && !nativeIndeterminate
    && !conflict && !stale
    && (schedulerInstalled
      ? schedulerEnabled && schedulerAssetsHealthy
      : inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  const detail = schedulerIndeterminate || nativeIndeterminate
    ? "service manager status indeterminate — retry after manager access is restored"
    : conflict
    ? "CONFLICT: Task Scheduler and native WinSW are both present — run 'ccx service uninstall' then reinstall one"
    : stale
      ? "stale or missing service assets — run 'ccx service repair'"
      : schedulerInstalled
        ? schedulerEnabled ? "Task Scheduler enabled" : "Task Scheduler disabled"
        : nativeInstalled
          ? `native (WinSW ${WINSW_VERSION}): ${inputs.nativeStatus}`
          : "not installed";
  const summary = registrationState === "absent"
    ? `not installed (${inputs.diagnostics})`
    : registrationState === "indeterminate"
      ? `installation status indeterminate, ${detail} (${inputs.diagnostics})`
      : `installed, ${detail} (${inputs.diagnostics})`;
  return {
    supported: true,
    registrationState,
    supervisorState,
    installed,
    enabled,
    running,
    viable,
    startable,
    stale,
    conflict,
    backend,
    summary,
  };
}

/**
 * Fail-closed restart diagnostic. Presence alone is never enough: conflicting
 * managers, stale baked paths, disabled registrations, and unknown/stopped
 * native managers cannot claim that Codex will reconnect after a reboot.
 */
export function diagnoseService(): ServiceDiagnostic {
  const diagnostics = serviceDiagnosticsSummary();
  if (process.platform === "darwin") {
    const probe = probeLaunchdSupervisor();
    const installed = probe.registrationState !== "absent";
    const running = probe.supervisorState === "active";
    const enabled = probe.enabled === true;
    const stale = probe.registrationState === "present" && (
      bakedServicePathsDiagnostic() !== null
      || launchdExecutableDiagnostic() !== null
    );
    const viable = probe.registrationState === "present" && running && !stale;
    const summary = probe.registrationState === "absent" ? `not installed (${diagnostics})`
      : probe.registrationState === "indeterminate" ? `installation status indeterminate (launchd; ${diagnostics})`
      : stale ? `installed, but stale (launchd; ${diagnostics})`
        : running ? `installed and loaded (launchd; ${diagnostics})`
          : `installed, not loaded (launchd; ${diagnostics})`;
    return {
      supported: true,
      registrationState: probe.registrationState,
      supervisorState: probe.supervisorState,
      installed,
      enabled,
      running,
      viable,
      startable: probe.registrationState === "present" && probe.supervisorState !== "indeterminate" && !stale,
      stale,
      conflict: false,
      backend: "launchd",
      summary,
    };
  }
  if (process.platform === "win32") {
    const schedulerProbe = probeWindowsSchedulerSupervisor();
    let schedulerXml = "";
    if (schedulerProbe.registrationState === "present" && schedulerProbe.supervisorState !== "indeterminate") {
      try { schedulerXml = statusWindowsXml(); } catch { /* the probe below remains authoritative */ }
    }
    const schedulerAssetsPresent = [windowsServiceScriptPath(), windowsLauncherVbsPath(), windowsTaskXmlPath()]
      .every(existsSync);
    const nativeStatus = statusWinswRaw();
    const installState = readServiceInstallState();
    const recordedBackend: ServiceBackend | null = !installState
      ? null
      : installState.backend === "native" ? "native" : "scheduler";
    return deriveWindowsServiceDiagnostic({
      schedulerXml,
      schedulerProbe,
      schedulerAssetsPresent,
      nativeStatus,
      recordedBackend,
      staleBakedPaths: bakedServicePathsDiagnostic() !== null,
      nativeRepairAssetsOnly: Boolean(winswStatusSummary()),
      diagnostics,
    });
  }
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) return { supported: false, registrationState: "absent", supervisorState: "inactive", installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "unsupported in Docker" };
    if (!isSystemd()) return { supported: false, registrationState: "indeterminate", supervisorState: "indeterminate", installed: true, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "unsupported: systemd not found" };
    const probe = probeSystemdSupervisor();
    const installed = probe.registrationState !== "absent";
    const enabled = probe.enabled === true;
    const running = probe.supervisorState === "active";
    const stale = probe.registrationState === "present" && bakedServicePathsDiagnostic() !== null;
    const viable = probe.registrationState === "present" && enabled && running && !stale;
    const summary = probe.registrationState === "absent" ? `not installed (${diagnostics})`
      : probe.registrationState === "indeterminate" ? `installation status indeterminate (systemd user; ${diagnostics})`
      : stale ? `installed, but stale (systemd user; ${diagnostics})`
        : viable ? `installed, enabled and running (systemd user; ${diagnostics})`
          : probe.supervisorState === "indeterminate" ? `installed, but runtime status is indeterminate (systemd user; ${diagnostics})`
            : `installed, but ${!enabled ? "disabled" : "not running"} (systemd user; ${diagnostics})`;
    return { supported: true, registrationState: probe.registrationState, supervisorState: probe.supervisorState, installed, enabled, running, viable, startable: probe.registrationState === "present" && probe.supervisorState !== "indeterminate" && !stale, stale, conflict: false, backend: "systemd", summary };
  }
  return { supported: false, registrationState: "absent", supervisorState: "inactive", installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: `unsupported on ${process.platform}` };
}

/** Registration-level proof used while E is still held after a manager stop. */
export function serviceSupervisorInactiveAfterStop(
  diagnostic: ServiceDiagnostic = diagnoseService(),
): boolean {
  if (diagnostic.registrationState === "indeterminate"
    || diagnostic.supervisorState === "indeterminate") return false;
  if (diagnostic.registrationState === "absent") return true;
  // Task Scheduler registration remains enabled after `/end`; its only reliable
  // stop proof is the bounded replacement probe performed by the caller.
  if (process.platform === "win32" && diagnostic.backend === "scheduler") return true;
  if (diagnostic.stale || diagnostic.conflict) return false;
  return diagnostic.supervisorState === "inactive";
}

export function serviceStatusSummary(): string {
  return diagnoseService().summary;
}

/**
 * Status a human can act on: registration state, whether a proxy actually answers,
 * and — when it does not — whether launchd is running the plist we have on disk.
 *
 * `launchctl list` membership cannot distinguish "serving", "bootstrapped from an
 * older plist", and "loaded but never bound"; the reported failure was the middle
 * one presented as the first.
 *
 * Resolves the port through `confirmServiceServing`, i.e. the same
 * `installedServiceListenPort()` path install/start/repair use, so those surfaces can
 * never disagree about one service. The budget is short (2 probes) because this is a
 * status read, not a post-install wait.
 */
export async function serviceStatusReport(
  deps: {
    diagnose?: () => ServiceDiagnostic;
    serving?: () => Promise<{ ok: boolean; port: number }>;
    matchesPlist?: () => { loaded: boolean; matchesPlist: boolean };
  } = {},
): Promise<string> {
  const diag = (deps.diagnose ?? diagnoseService)();
  if (!diag.installed) return `❌ ${diag.summary}`;

  const serving = await (deps.serving ?? (() => confirmServiceServing({ timeoutMs: 1_500 })))();
  if (serving.ok) return `✅ ${diag.summary}\n   Serving on port ${serving.port}.`;

  // The dep is consulted FIRST; the platform check only guards the default. Wrapping
  // the whole expression in a darwin check would discard an injected seam on
  // Linux/Windows and make the stale-plist case untestable there.
  const stalePlist = deps.matchesPlist?.() ?? (process.platform === "darwin"
    ? (() => {
        const entry = cliEntry();
        // Pass the INSTALLED port explicitly: the default second argument is
        // resolveServiceListenPort(), which reads CCX_BAKE_PORT/config.port, so after
        // a config edit the expected arguments would never match and every run would
        // print a false "OLDER plist".
        return launchdJobMatchesPlist(
          buildLaunchdArguments(entry.cli, installedServiceListenPort()),
        );
      })()
    : null);
  const staleLine = stalePlist && stalePlist.loaded && !stalePlist.matchesPlist
    ? "   launchd is running an OLDER plist than the one on disk.\n"
      + `   Fix:    launchctl bootout gui/$(id -u)/${LABEL} && ccx service repair\n`
    : "";

  return `⚠️  ${diag.summary}\n`
    + `   Registered, but no proxy is answering on port ${serving.port}.\n`
    + staleLine
    + `   Log:    ${serviceLogPath()}\n`
    + `   Repair: ${serviceRepairCommand()}\n`
    + "   Meanwhile: ccx start           (serves in the foreground)";
}

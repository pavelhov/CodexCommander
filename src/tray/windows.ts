import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath, getConfigDir } from "../config";
import { BUN_RUNTIME_SOURCES, durableBunRuntime } from "../lib/bun-runtime";
import type { BunRuntimeSource } from "../lib/bun-runtime";
import { forgetEphemeralSecretPath, hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { recordOwnedConfigPath } from "../lib/config-ownership";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_PARENT_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion";
const TRAY_STATE_VERSION = 3;
const FOREIGN_RUN_VALUE = "<foreign-or-unreadable-registry-value>";
const TRAY_ICON_FILES = [
  "codexcommander-tray-online.ico",
  "codexcommander-tray-warning.ico",
  "codexcommander-tray-offline.ico",
] as const;

export interface WindowsTrayEntry {
  bun: string;
  /** Provenance of `bun`, resolved together with it. */
  bunRuntimeSource: BunRuntimeSource;
  cli: string;
  script: string;
  launcherPath: string;
  codexHome: string;
  codexCommanderHome: string;
}

interface WindowsTrayState extends WindowsTrayEntry {
  version: 3;
  runValue: string;
  runCommand: string;
}

export interface WindowsTrayStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  stale: boolean;
  summary: string;
}

function trayStatePath(): string {
  return join(getConfigDir(), "tray-state.json");
}

function trayHeartbeatPath(): string {
  return join(getConfigDir(), "tray-heartbeat.json");
}

function installedTrayScriptPath(): string {
  return join(getConfigDir(), "codexcommander-tray.ps1");
}

function installedTrayIconPaths(): string[] {
  return TRAY_ICON_FILES.map(name => join(getConfigDir(), name));
}

export function windowsTrayStatePathsOwned(
  state: Pick<WindowsTrayEntry, "script" | "launcherPath" | "codexCommanderHome">,
  configDir = getConfigDir(),
): boolean {
  if (resolve(state.codexCommanderHome) !== resolve(configDir)) return false;
  const scriptOwned = resolve(state.script) === resolve(join(configDir, "codexcommander-tray.ps1"));
  if (!scriptOwned) return false;
  return resolve(state.launcherPath) === resolve(join(configDir, "codexcommander-tray.vbs"));
}

function sourceTrayScriptPath(): string {
  return join(import.meta.dir, "windows-tray.ps1");
}

function sourceTrayIconPaths(): string[] {
  return TRAY_ICON_FILES.map(name => join(import.meta.dir, "assets", name));
}

function currentCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? resolve(expandUserPath(raw)) : join(homedir(), ".codex");
}

function currentEntry(): WindowsTrayEntry {
  const runtime = durableBunRuntime();
  return {
    bun: runtime.path,
    bunRuntimeSource: runtime.source,
    cli: join(import.meta.dir, "..", "cli", "index.ts"),
    script: installedTrayScriptPath(),
    launcherPath: installedTrayLauncherPath(),
    codexHome: currentCodexHome(),
    codexCommanderHome: getConfigDir(),
  };
}

export function windowsTrayRunValue(codexCommanderHome: string): string {
  const normalized = resolve(codexCommanderHome).replace(/[\\/](?:\.)?[\\/]*$/, "").toLowerCase();
  return `CodexCommanderTray-${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

export function windowsPowerShellPath(systemRoot = process.env.SystemRoot): string {
  const candidate = join(
    systemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return existsSync(candidate) ? candidate : "powershell.exe";
}

function registryExe(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  return existsSync(candidate) ? candidate : "reg.exe";
}

function runRegistry(args: string[]): string {
  return execFileSync(registryExe(), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function safePath(value: string): string {
  if (/[\u0000-\u001f\"]/.test(value)) {
    throw new Error("Windows tray paths cannot contain quotes or control characters.");
  }
  return value;
}

export function windowsTrayProcessArgs(entry: WindowsTrayEntry, mode: "Run" | "Stop" = "Run", hostPid?: number): string[] {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", safePath(entry.script),
    "-BunPath", safePath(entry.bun),
    "-BunRuntimeSource", entry.bunRuntimeSource,
    "-CliPath", safePath(entry.cli),
    "-CodexHome", safePath(entry.codexHome),
    "-CodexCommanderHome", safePath(entry.codexCommanderHome),
    "-Mode", mode,
  ];
  if (Number.isSafeInteger(hostPid) && (hostPid ?? 0) > 0) args.push("-HostPid", String(hostPid));
  return args;
}

function quoteRunValue(value: string): string {
  safePath(value);
  return `\"${value}\"`;
}

function installedTrayLauncherPath(): string {
  return join(getConfigDir(), "codexcommander-tray.vbs");
}

function quoteVbsPath(value: string): string {
  return value.replace(/"/g, '""');
}

/** Full PowerShell invocation used by the owned VBS launcher (not written to HKCU Run). */
export function buildWindowsTrayPowerShellCommand(entry: WindowsTrayEntry, powershell = windowsPowerShellPath()): string {
  return [
    quoteRunValue(powershell),
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", quoteRunValue(entry.script),
    "-BunPath", quoteRunValue(entry.bun),
    "-BunRuntimeSource", entry.bunRuntimeSource,
    "-CliPath", quoteRunValue(entry.cli),
    "-CodexHome", quoteRunValue(entry.codexHome),
    "-CodexCommanderHome", quoteRunValue(entry.codexCommanderHome),
    "-Mode", "Run",
  ].join(" ");
}

/** Short HKCU Run command (must stay ≤260 chars under long Windows user/npm paths). */
export function buildWindowsTrayRunCommand(entry: WindowsTrayEntry): string {
  const wscript = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  return `${quoteRunValue(wscript)} //B //NoLogo ${quoteRunValue(entry.launcherPath)}`;
}

export function buildWindowsTrayLauncherScript(entry: WindowsTrayEntry, powershell = windowsPowerShellPath()): string {
  const command = buildWindowsTrayPowerShellCommand(entry, powershell);
  // VBS CreateObject("WScript.Shell").Run command, 0, False — hidden, non-blocking.
  return [
    "' CodexCommander-owned tray launcher — do not edit by hand.",
    `CreateObject("WScript.Shell").Run "${quoteVbsPath(command)}", 0, False`,
    "",
  ].join("\r\n");
}

function readState(): WindowsTrayState | null {
  try {
    const state = JSON.parse(readFileSync(trayStatePath(), "utf8")) as Partial<WindowsTrayState>;
    if (state.version !== TRAY_STATE_VERSION) return null;
    for (const key of ["bun", "cli", "script", "launcherPath", "codexHome", "codexCommanderHome", "runValue", "runCommand"] as const) {
      if (typeof state[key] !== "string" || state[key].length === 0) return null;
    }
    if (!BUN_RUNTIME_SOURCES.some(source => source === state.bunRuntimeSource)) return null;
    const valid = state as WindowsTrayState;
    for (const value of [valid.bun, valid.cli, valid.script, valid.launcherPath, valid.codexHome, valid.codexCommanderHome]) safePath(value);
    // State is advisory, not an authority for executable or deletion paths. In
    // particular, never let a forged state file redirect PowerShell -File.
    if (!windowsTrayStatePathsOwned(valid)) return null;
    if (valid.runValue !== windowsTrayRunValue(valid.codexCommanderHome)) return null;
    return valid;
  } catch {
    return null;
  }
}

export interface WindowsTrayOwnedFileIO {
  write(path: string, contents: string | Buffer): void;
  harden(path: string): void;
  rename(source: string, destination: string): void;
  unlink(path: string): void;
}

export function replaceWindowsTrayOwnedFile(
  path: string,
  contents: string | Buffer,
  io: WindowsTrayOwnedFileIO = {
    write: (target, value) => writeFileSync(target, value, { mode: 0o600 }),
    harden: target => {
      try { chmodSync(target, 0o600); } catch { /* best-effort */ }
      if (process.platform !== "win32") return;
      // Destination-keyed timeout memo: retries share one memo per final path.
      const hardened = hardenSecretPath(target, { required: true, timeoutMemoKey: path });
      if (!hardened.ok) throw new Error("Windows tray ACL hardening did not complete; refusing to persist executable state.");
    },
    rename: renameSync,
    unlink: unlinkSync,
  },
): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  io.write(temporary, contents);
  let renamed = false;
  try {
    io.harden(temporary);
    io.rename(temporary, path);
    renamed = true;
    forgetEphemeralSecretPath(temporary);
  } finally {
    if (!renamed) {
      try {
        io.unlink(temporary);
        forgetEphemeralSecretPath(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") forgetEphemeralSecretPath(temporary);
      }
    }
  }
}

function writeState(
  entry: WindowsTrayEntry,
  runValue: string,
  runCommand: string,
): void {
  const path = trayStatePath();
  replaceWindowsTrayOwnedFile(path, JSON.stringify({ version: TRAY_STATE_VERSION, ...entry, runValue, runCommand }, null, 2) + "\n");
}

export function parseWindowsTrayRunValue(output: string, runValue: string): string | null {
  const escaped = runValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escaped}\\s+(\\S+)\\s*(.*)$`, "mi").exec(output);
  if (!match || match[1] !== "REG_SZ" || !match[2]?.trim()) return FOREIGN_RUN_VALUE;
  return match[2].trim();
}

export function windowsRegistryParentShowsRunKey(output: string): boolean {
  const expected = RUN_KEY.toLowerCase();
  return output.split(/\r?\n/).some(line => line.trim().toLowerCase()
    .replace(/^hkey_current_user\\/, "hkcu\\") === expected);
}

export type WindowsRegistryRunner = (args: string[]) => string;
export type WindowsRegistryAsyncRunner = (args: string[]) => Promise<string>;

function registryExitCode(error: unknown): number | null {
  const value = error as { status?: unknown; code?: unknown };
  const code = Number(value.status ?? value.code);
  return Number.isFinite(code) ? code : null;
}

function syncRegistryAbsenceIsProven(run: WindowsRegistryRunner): boolean {
  try {
    run(["query", RUN_KEY, "/reg:64"]);
    return true;
  } catch (runError) {
    if (registryExitCode(runError) !== 1) return false;
    try {
      const parent = run(["query", RUN_PARENT_KEY, "/reg:64"]);
      return !windowsRegistryParentShowsRunKey(parent);
    } catch {
      return false;
    }
  }
}

export function readWindowsTrayRunValueWithRunner(runValue: string, run: WindowsRegistryRunner): string | null {
  try {
    const output = run(["query", RUN_KEY, "/v", runValue, "/reg:64"]);
    return parseWindowsTrayRunValue(output, runValue);
  } catch (error) {
    if (registryExitCode(error) === 1) {
      // reg.exe also uses exit 1 for access/query failures. Only treat the
      // value as absent after proving Run is readable or does not exist under
      // a readable CurrentVersion parent.
      if (syncRegistryAbsenceIsProven(run)) return null;
    }
    throw new Error("Unable to verify the owned Windows tray registry value; refusing to change persistence.");
  }
}

function readOwnedRunValue(runValue = windowsTrayRunValue(getConfigDir())): string | null {
  return readWindowsTrayRunValueWithRunner(runValue, runRegistry);
}

function runRegistryAsync(args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(registryExe(), args, {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(stdout.trim());
    });
  });
}

async function asyncRegistryAbsenceIsProven(run: WindowsRegistryAsyncRunner): Promise<boolean> {
  try {
    await run(["query", RUN_KEY, "/reg:64"]);
    return true;
  } catch (runError) {
    if (registryExitCode(runError) !== 1) return false;
    try {
      const parent = await run(["query", RUN_PARENT_KEY, "/reg:64"]);
      return !windowsRegistryParentShowsRunKey(parent);
    } catch {
      return false;
    }
  }
}

export async function readWindowsTrayRunValueWithAsyncRunner(
  runValue: string,
  run: WindowsRegistryAsyncRunner,
): Promise<string | null> {
  try {
    const output = await run(["query", RUN_KEY, "/v", runValue, "/reg:64"]);
    return parseWindowsTrayRunValue(output, runValue);
  } catch (error) {
    if (registryExitCode(error) === 1 && await asyncRegistryAbsenceIsProven(run)) {
      return null;
    }
    throw new Error("Unable to verify Windows tray registry status.");
  }
}

async function readOwnedRunValueAsync(runValue = windowsTrayRunValue(getConfigDir())): Promise<string | null> {
  return readWindowsTrayRunValueWithAsyncRunner(runValue, runRegistryAsync);
}

function readHeartbeat(): { pid: number; hostPid?: number; timestamp: number } | null {
  try {
    const heartbeat = JSON.parse(readFileSync(trayHeartbeatPath(), "utf8").replace(/^\uFEFF/, "")) as { pid?: unknown; hostPid?: unknown; timestamp?: unknown };
    if (!Number.isSafeInteger(heartbeat.pid) || (heartbeat.pid as number) <= 0 || typeof heartbeat.timestamp !== "number") return null;
    const hostPid = Number.isSafeInteger(heartbeat.hostPid) && (heartbeat.hostPid as number) > 0 ? heartbeat.hostPid as number : undefined;
    return { pid: heartbeat.pid as number, hostPid, timestamp: heartbeat.timestamp };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function heartbeatProcessAlive(heartbeat = readHeartbeat()): boolean {
  return Boolean(heartbeat && processAlive(heartbeat.pid));
}

function heartbeatRunning(): boolean {
  const heartbeat = readHeartbeat();
  return Boolean(heartbeat && Date.now() - heartbeat.timestamp <= 15_000 && heartbeatProcessAlive(heartbeat));
}

function waitForHeartbeat(expected: boolean, timeoutMs = 8_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (heartbeatRunning() === expected) return true;
    Bun.sleepSync(100);
  }
  return heartbeatRunning() === expected;
}

function waitForTrayExit(previous: ReturnType<typeof readHeartbeat>, timeoutMs = 15_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const powershellExited = !previous || !processAlive(previous.pid);
    const hostExited = !previous?.hostPid || !processAlive(previous.hostPid);
    if (!heartbeatProcessAlive() && powershellExited && hostExited) return true;
    Bun.sleepSync(100);
  }
  const powershellExited = !previous || !processAlive(previous.pid);
  const hostExited = !previous?.hostPid || !processAlive(previous.hostPid);
  return !heartbeatProcessAlive() && powershellExited && hostExited;
}

export function windowsTrayRegistrationIsStale(inputs: {
  registered: boolean;
  registrationOwned: boolean;
  running: boolean;
  heartbeatFresh: boolean;
}): boolean {
  if (!inputs.registered && inputs.running) return true;
  if (inputs.registered && !inputs.registrationOwned) return true;
  return inputs.running && !inputs.heartbeatFresh;
}

function trayStatusFrom(registered: string | null): WindowsTrayStatus {
  const state = readState();
  const heartbeat = readHeartbeat();
  const running = heartbeatProcessAlive(heartbeat);
  const registrationOwned = state !== null
    && registered === state.runCommand
    && [state.bun, state.cli, state.script, state.launcherPath, ...installedTrayIconPaths()]
      .every(path => existsSync(path));
  const stale = windowsTrayRegistrationIsStale({
    registered: registered !== null,
    registrationOwned,
    running,
    heartbeatFresh: Boolean(heartbeat && Date.now() - heartbeat.timestamp <= 15_000),
  });
  const installed = registered !== null && state !== null && registered === state.runCommand && !stale;
  const summary = registered === null
    ? running ? "unregistered tray process is still running" : "not installed"
    : stale
      ? "startup registration is foreign, stale, or points to missing package files"
      : running
        ? "installed and running"
        : "installed, not currently running";
  return { supported: true, installed, running, stale, summary };
}

export function getWindowsTrayStatus(): WindowsTrayStatus {
  if (process.platform !== "win32") {
    return { supported: false, installed: false, running: false, stale: false, summary: `unsupported on ${process.platform}` };
  }
  return trayStatusFrom(readOwnedRunValue());
}

export async function getWindowsTrayStatusAsync(): Promise<WindowsTrayStatus> {
  if (process.platform !== "win32") {
    return { supported: false, installed: false, running: false, stale: false, summary: `unsupported on ${process.platform}` };
  }
  const runValue = windowsTrayRunValue(getConfigDir());
  const registered = await readOwnedRunValueAsync(runValue);
  return trayStatusFrom(registered);
}

function assertWindows(): void {
  if (process.platform !== "win32") throw new Error(`The CodexCommander tray is Windows-only (current platform: ${process.platform}).`);
}

const DETACHED_TRAY_HOST_LAUNCHER = [
  "$startInfo = New-Object System.Diagnostics.ProcessStartInfo",
  "$startInfo.FileName = $env:CCX_TRAY_HOST_BUN",
  "$startInfo.Arguments = $env:CCX_TRAY_HOST_ARGS",
  "$startInfo.UseShellExecute = $true",
  "$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden",
  "$child = [System.Diagnostics.Process]::Start($startInfo)",
  "if ($null -eq $child) { throw 'Windows tray host did not start.' }",
  "$child.Dispose()",
].join("; ");

const DETACHED_TRAY_HOST_LAUNCHER_B64 = Buffer.from(DETACHED_TRAY_HOST_LAUNCHER, "utf16le").toString("base64");

export function launchWindowsTrayHost(entry: WindowsTrayEntry): void {
  const validated = validateWindowsTrayHostEntry(entry);
  const bun = validated.bun;
  const cli = validated.cli;
  execFileSync(windowsPowerShellPath(), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    DETACHED_TRAY_HOST_LAUNCHER_B64,
  ], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 15_000,
    env: {
      ...process.env,
      CCX_TRAY_HOST_BUN: bun,
      CCX_TRAY_HOST_ARGS: `${quoteRunValue(cli)} __tray-host`,
      CCX_TRAY_ENTRY_B64: Buffer.from(JSON.stringify(validated), "utf8").toString("base64"),
    },
  });
}

function spawnTray(state: WindowsTrayEntry): void {
  launchWindowsTrayHost(state);
}

function validateWindowsTrayHostEntry(value: Partial<WindowsTrayEntry>): WindowsTrayEntry {
  for (const key of ["bun", "cli", "script", "launcherPath", "codexHome", "codexCommanderHome"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) throw new Error(`Invalid tray host field: ${key}`);
    safePath(value[key]);
  }
  if (!BUN_RUNTIME_SOURCES.some(source => source === value.bunRuntimeSource)) {
    throw new Error("Invalid tray host field: bunRuntimeSource");
  }
  return value as WindowsTrayEntry;
}

export function parseWindowsTrayHostEntry(encoded: string | undefined): WindowsTrayEntry {
  if (!encoded) throw new Error("Missing tray host entry.");
  const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Partial<WindowsTrayEntry>;
  return validateWindowsTrayHostEntry(value);
}

/** Detached Bun host keeps the attached WinForms PowerShell process alive. */
export async function runWindowsTrayHost(): Promise<void> {
  assertWindows();
  const entry = parseWindowsTrayHostEntry(process.env.CCX_TRAY_ENTRY_B64);
  delete process.env.CCX_TRAY_ENTRY_B64;
  delete process.env.CCX_TRAY_HOST_BUN;
  delete process.env.CCX_TRAY_HOST_ARGS;
  const child = spawn(windowsPowerShellPath(), windowsTrayProcessArgs(entry, "Run", process.pid), {
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", code => {
      if (code && code !== 0) rejectPromise(new Error(`Windows tray host exited with code ${code}.`));
      else resolvePromise();
    });
  });
}

function signalTrayStop(entry: WindowsTrayEntry = currentEntry()): ReturnType<typeof readHeartbeat> {
  const previous = readHeartbeat();
  // The stop event name depends only on the current home. Never execute paths
  // recovered from tray-state.json while attempting cleanup or repair.
  execFileSync(windowsPowerShellPath(), windowsTrayProcessArgs(entry, "Stop"), {
    stdio: "ignore",
    windowsHide: true,
    timeout: 15_000,
  });
  return previous;
}

export function installWindowsTray(startNow = true): WindowsTrayStatus {
  assertWindows();
  const entry = currentEntry();
  const sourceScript = sourceTrayScriptPath();
  const iconPairs = sourceTrayIconPaths().map((source, index) => ({ source, installed: installedTrayIconPaths()[index] }));
  for (const path of [entry.bun, entry.cli, sourceScript, ...iconPairs.map(pair => pair.source)]) {
    if (!existsSync(path)) throw new Error(`Cannot install the tray because a required file is missing: ${path}`);
  }
  recordOwnedConfigPath(getConfigDir(), trayStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  const launcherPath = entry.launcherPath;
  const runCommand = buildWindowsTrayRunCommand(entry);
  if (runCommand.length > 260) {
    throw new Error(`Tray Run command exceeds the Windows 260-character limit (${runCommand.length} chars).`);
  }
  const runValue = windowsTrayRunValue(entry.codexCommanderHome);
  const existing = readOwnedRunValue(runValue);
  const state = readState();
  if (existing && (!state || existing !== state.runCommand)) {
    throw new Error(`Refusing to replace a foreign or unowned HKCU Run value named ${runValue}.`);
  }
  if (existsSync(entry.script) && (!state || resolve(state.script) !== resolve(entry.script))) {
    throw new Error(`Refusing to overwrite an unowned tray script at ${entry.script}.`);
  }
  if (existsSync(launcherPath) && (!state || resolve(state.launcherPath) !== resolve(launcherPath))) {
    throw new Error(`Refusing to overwrite an unowned tray launcher at ${launcherPath}.`);
  }
  if (!state && iconPairs.some(pair => existsSync(pair.installed))) {
    throw new Error("Refusing to overwrite unowned Windows tray icon assets.");
  }
  const wasRunning = heartbeatProcessAlive();
  if (wasRunning && !state) {
    throw new Error("Refusing to replace an unowned running tray process. Exit it before installing.");
  }
  if (wasRunning && state) {
    const previous = signalTrayStop();
    if (!waitForTrayExit(previous)) throw new Error("The old tray did not exit; refusing to replace its persistent script.");
  }

  const previousStateBytes = existsSync(trayStatePath()) ? readFileSync(trayStatePath()) : null;
  const previousScriptBytes = existsSync(entry.script) ? readFileSync(entry.script) : null;
  const previousLauncherBytes = existsSync(launcherPath) ? readFileSync(launcherPath) : null;
  const previousIconBytes = new Map(iconPairs.map(pair => [
    pair.installed,
    existsSync(pair.installed) ? readFileSync(pair.installed) : null,
  ]));
  const restorePreviousInstall = () => {
    try {
      if (previousScriptBytes) replaceWindowsTrayOwnedFile(entry.script, previousScriptBytes);
      else if (existsSync(entry.script)) unlinkSync(entry.script);
    } catch { /* rollback best-effort */ }
    try {
      if (previousLauncherBytes) replaceWindowsTrayOwnedFile(launcherPath, previousLauncherBytes);
      else if (existsSync(launcherPath)) unlinkSync(launcherPath);
    } catch { /* rollback best-effort */ }
    for (const [path, contents] of previousIconBytes) {
      try {
        if (contents) replaceWindowsTrayOwnedFile(path, contents);
        else if (existsSync(path)) unlinkSync(path);
      } catch { /* rollback best-effort */ }
    }
    try {
      if (previousStateBytes) replaceWindowsTrayOwnedFile(trayStatePath(), previousStateBytes);
      else if (existsSync(trayStatePath())) unlinkSync(trayStatePath());
    } catch { /* rollback best-effort */ }
    try {
      if (existing !== null) runRegistry(["add", RUN_KEY, "/v", runValue, "/t", "REG_SZ", "/d", existing, "/f", "/reg:64"]);
      else runRegistry(["delete", RUN_KEY, "/v", runValue, "/f", "/reg:64"]);
    } catch { /* rollback best-effort */ }
    if (wasRunning && state && !heartbeatRunning()) {
      try {
        spawnTray(currentEntry());
        waitForHeartbeat(true);
      } catch { /* retain the primary installation failure */ }
    }
  };

  try {
    const hardenedDir = hardenSecretDir(getConfigDir(), { required: true });
    if (!hardenedDir.ok) throw new Error("Windows tray directory ACL hardening did not complete; refusing to install persistence.");
    replaceWindowsTrayOwnedFile(entry.script, readFileSync(sourceScript));
    for (const pair of iconPairs) replaceWindowsTrayOwnedFile(pair.installed, readFileSync(pair.source));
    replaceWindowsTrayOwnedFile(launcherPath, Buffer.from("\uFEFF" + buildWindowsTrayLauncherScript(entry), "utf16le"));
    runRegistry(["add", RUN_KEY, "/v", runValue, "/t", "REG_SZ", "/d", runCommand, "/f", "/reg:64"]);
    writeState(entry, runValue, runCommand);
  } catch (error) {
    restorePreviousInstall();
    throw error;
  }
  if (startNow && !heartbeatRunning()) spawnTray(entry);
  if (startNow && !waitForHeartbeat(true)) {
    restorePreviousInstall();
    throw new Error("The tray startup registration was installed, but the tray process did not become healthy.");
  }
  return getWindowsTrayStatus();
}

export function startWindowsTray(): WindowsTrayStatus {
  assertWindows();
  const state = readState();
  if (!state || readOwnedRunValue(state.runValue) !== state.runCommand) throw new Error("The tray is not installed. Install it first.");
  // Persisted state proves registration ownership but never selects an
  // executable. Resolve every launch path from the running installation.
  if (!heartbeatRunning()) spawnTray(currentEntry());
  if (!waitForHeartbeat(true)) throw new Error("The tray process did not become healthy after launch.");
  return getWindowsTrayStatus();
}

export function stopWindowsTray(): WindowsTrayStatus {
  assertWindows();
  let previous = readHeartbeat();
  if (previous) {
    previous = signalTrayStop();
  }
  if (!waitForTrayExit(previous)) throw new Error("The tray did not exit after the stop signal. Its login registration was preserved.");
  return getWindowsTrayStatus();
}

export function uninstallWindowsTray(): WindowsTrayStatus {
  assertWindows();
  const state = readState();
  const existing = state ? readOwnedRunValue(state.runValue) : readOwnedRunValue();
  if (existing && (!state || existing !== state.runCommand)) {
    throw new Error(`Refusing to remove a foreign or unowned HKCU Run value named ${state?.runValue ?? windowsTrayRunValue(getConfigDir())}.`);
  }
  let previous = readHeartbeat();
  if (previous) {
    previous = signalTrayStop();
  }
  if (!waitForTrayExit(previous)) throw new Error("The tray did not exit; refusing to remove its owned registration or state.");
  if (existing) runRegistry(["delete", RUN_KEY, "/v", state?.runValue ?? windowsTrayRunValue(getConfigDir()), "/f", "/reg:64"]);
  const ownedPaths = [trayStatePath(), trayHeartbeatPath(), ...(state ? [state.launcherPath] : [])];
  if (state?.script && resolve(state.script) === resolve(installedTrayScriptPath())) ownedPaths.push(state.script);
  if (state) ownedPaths.push(...installedTrayIconPaths());
  for (const path of [installedTrayScriptPath(), installedTrayLauncherPath()]) {
    try { if (existsSync(path)) ownedPaths.push(path); } catch { /* best effort */ }
  }
  for (const path of ownedPaths) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
  }
  return getWindowsTrayStatus();
}

/** Update hook: refresh trusted paths and relaunch only when the tray was already installed. */
export function repairWindowsTrayIfInstalled(startNow = true): WindowsTrayStatus | null {
  if (process.platform !== "win32" || !readState()) return null;
  return installWindowsTray(startNow);
}

export async function windowsTrayCommand(args: string[]): Promise<void> {
  const wantsJson = args.includes("--json");
  const startNow = !args.includes("--no-start");
  const values = args.filter(value => value !== "--json" && value !== "--no-start");
  const sub = values[0] ?? "status";
  if (args.includes("--no-start") && sub !== "install" || values.length > 1 || !["install", "start", "stop", "status", "uninstall", "remove"].includes(sub)) {
    console.error("Usage: ccx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]");
    process.exitCode = 1;
    return;
  }
  try {
    const status = sub === "install" ? installWindowsTray(startNow)
      : sub === "start" ? startWindowsTray()
        : sub === "stop" ? stopWindowsTray()
          : sub === "uninstall" || sub === "remove" ? uninstallWindowsTray()
            : getWindowsTrayStatus();
    console.log(wantsJson ? JSON.stringify(status) : `Windows tray: ${status.summary}`);
  } catch (error) {
    if (wantsJson) console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    else console.error(`Windows tray error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

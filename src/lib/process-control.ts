import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isCodexCommanderStartCommandLine,
  loadConfig,
  readRuntimePort,
} from "../config";
import { API_KEY_HEADER, HOME_ENV, readEnv } from "../identity";
import { configuredAdminToken } from "./admin-secrets";
import { isLocalAttestationSecret } from "./local-management-attestation";
import {
  attestLiveManagementProxy,
  type RuntimeLivenessRecord,
} from "../server/proxy-liveness";
import {
  proxyLifecycleLockLeaseHeaders,
  type ProxyLifecycleLockLease,
} from "../server/proxy-lifecycle-protocol";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  const marker = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    Atomics.wait(marker, 0, 0, 50);
  }
  return !isProcessAlive(pid);
}

/** Injectable seams so the graceful-stop flow is unit-testable without a live proxy. */
export interface GracefulStopIo {
  fetchFn?: typeof fetch;
  readRuntime?: (pid?: number) => RuntimeLivenessRecord | null;
  verifyPidFn?: (candidatePid: number) => number | null;
  attestLiveManagementProxyImpl?: typeof attestLiveManagementProxy;
  waitExit?: (pid: number, timeoutMs: number) => boolean;
  env?: Record<string, string | undefined>;
  exitTimeoutMs?: number;
  lifecycleLease?: ProxyLifecycleLockLease;
}

interface ProtectedRuntimeIdentity {
  readonly pid: number;
  readonly port: number;
  readonly hostname?: string;
  readonly attestationSecret: string;
}

/** Opaque, non-logging identity used only to detect PID reuse before a signal. */
export interface ProxySignalIdentity {
  readonly pid: number;
  readonly argvSha256: string;
  readonly birthIdentity: string;
  readonly ownerIdentity: string;
}

export interface StopProxyIo {
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  isAlive?: (pid: number) => boolean;
  waitExit?: (pid: number, timeoutMs: number) => boolean;
  readRuntime?: (pid?: number) => RuntimeLivenessRecord | null;
  readProcessIdentity?: (pid: number) => ProxySignalIdentity | null;
  gracefulStop?: (pid: number, lease?: ProxyLifecycleLockLease) => Promise<GracefulStopResult>;
  lifecycleLease?: ProxyLifecycleLockLease;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  taskkill?: (pid: number) => void;
  waitStoppedPort?: (
    runtime: { port: number; hostname?: string } | null | undefined,
  ) => Promise<void>;
}

interface ForcedStopAuthorization {
  readonly runtime: ProtectedRuntimeIdentity;
  readonly process: ProxySignalIdentity;
}

/**
 * Host to POST /api/stop against: follow the recorded bind hostname when it names a
 * concrete address (a proxy bound to ::1 or a LAN IP is unreachable on 127.0.0.1);
 * loopback aliases and wildcard binds all answer on IPv4 loopback.
 */
export function gracefulStopHost(hostname: string | undefined): string {
  const trimmed = (hostname ?? "").trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === "localhost" || trimmed === "127.0.0.1" || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") {
    return "127.0.0.1";
  }
  if (lower === "::1" || lower === "[::1]") return "[::1]";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

/**
 * Outcome of a graceful stop attempt. `"refused"` is distinct from failure: the proxy answered
 * that it must NOT be stopped from here, so callers must not escalate to a forced kill.
 */
export type GracefulStopResult = boolean | "refused";

/**
 * Ask a running proxy to stop itself via the management API (`POST /api/stop`), which
 * drains in-flight turns, restores native Codex, and cleans its pid/runtime files.
 * This is the only way to get a GRACEFUL stop on Windows, where the POSIX
 * SIGTERM-then-SIGKILL ladder does not exist and `taskkill /F` gives the proxy no
 * chance to run its shutdown handlers. Returns false when the proxy can't be reached
 * or doesn't exit in time — callers fall back to {@link killProxy}. Returns `"refused"`
 * when the proxy declines the stop (HTTP 409), which callers must NOT force past.
 */
export async function stopProxyGracefully(pid: number, io: GracefulStopIo = {}): Promise<GracefulStopResult> {
  const readRuntime = io.readRuntime ?? readRuntimePort;
  const fetchFn = io.fetchFn ?? fetch;
  const attest = io.attestLiveManagementProxyImpl ?? attestLiveManagementProxy;
  const target = await attest({
    fetchFn,
    readRuntimeFn: readRuntime,
    verifyPidFn: io.verifyPidFn,
    expectedPid: pid,
    timeoutMs: io.exitTimeoutMs ? Math.min(io.exitTimeoutMs, 10_000) : 10_000,
  });
  if (!target) return false;
  // Older proxies do not understand the delegated E/S lease. The caller has
  // already restored native routing, so fall through to the identity-checked
  // signal ladder instead of entering the old server-side restore path.
  if (io.lifecycleLease && !target.lifecycleLockLeaseV1) return false;
  const env = io.env ?? process.env;
  const headers: Record<string, string> = {};
  const token = configuredAdminToken(readEnv(HOME_ENV, env as NodeJS.ProcessEnv), env as NodeJS.ProcessEnv);
  if (token) headers[API_KEY_HEADER] = token;
  if (io.lifecycleLease) {
    Object.assign(headers, proxyLifecycleLockLeaseHeaders(io.lifecycleLease));
  }
  try {
    const res = await fetchFn(`${target.baseUrl}/api/stop`, {
      method: "POST",
      headers,
      // Hung proxies with many CLOSE_WAIT clients can be slow to accept; give them
      // longer than a health poll so we prefer drain over taskkill /F.
      signal: AbortSignal.timeout(io.exitTimeoutMs ? Math.min(io.exitTimeoutMs, 10_000) : 10_000),
    });
    // 409 is the proxy REFUSING to stop (a service installed under another home owns it and
    // would respawn it anyway). That is a policy answer, not a dead endpoint — escalating to
    // SIGTERM here would run the daemon's cleanup and strip shared config out from under the
    // still-running service. Report the refusal instead of forcing.
    if (res.status === 409) return "refused";
    if (!res.ok) return false;
  } catch {
    return false;
  }
  const waitExit = io.waitExit ?? waitForExit;
  // Honor the server's own drain window: /api/stop answers 200 first, then drains for
  // config.shutdownTimeoutMs. Waiting less than that hard-kills mid-drain.
  const exitTimeoutMs = io.exitTimeoutMs ?? drainDeadlineMs();
  return waitExit(pid, exitTimeoutMs);
}

function drainDeadlineMs(): number {
  try {
    return (loadConfig().shutdownTimeoutMs ?? 5000) + 3000;
  } catch {
    return 8000;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function protectedRuntimeIdentity(
  record: RuntimeLivenessRecord | null,
  expectedPid: number,
): ProtectedRuntimeIdentity | null {
  if (!record
    || record.pid !== expectedPid
    || !Number.isSafeInteger(record.pid)
    || expectedPid <= 1
    || !Number.isInteger(record.port)
    || record.port <= 0
    || record.port > 65_535
    || (record.hostname !== undefined && typeof record.hostname !== "string")
    || !isLocalAttestationSecret(record.attestationSecret)) {
    return null;
  }
  return {
    pid: expectedPid,
    port: record.port,
    ...(record.hostname !== undefined ? { hostname: record.hostname } : {}),
    attestationSecret: record.attestationSecret,
  };
}

function sameProtectedRuntime(
  expected: ProtectedRuntimeIdentity,
  current: RuntimeLivenessRecord | null,
): boolean {
  return current?.pid === expected.pid
    && current.port === expected.port
    && current.hostname === expected.hostname
    && current.attestationSecret === expected.attestationSecret;
}

function sameProxySignalIdentity(
  expected: ProxySignalIdentity,
  current: ProxySignalIdentity | null,
): boolean {
  return current !== null
    && current.pid === expected.pid
    && current.argvSha256 === expected.argvSha256
    && current.birthIdentity === expected.birthIdentity
    && current.ownerIdentity === expected.ownerIdentity;
}

function linuxProcessBirthIdentity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 follows a parenthesized comm which may itself contain spaces.
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 2).split(/\s+/);
    const rawStartTicks = fields[19];
    return rawStartTicks && /^\d+$/.test(rawStartTicks)
      ? `linux-ticks:${rawStartTicks}`
      : null;
  } catch {
    return null;
  }
}

function linuxProcessIdentity(
  pid: number,
  getuid: () => number | undefined,
): ProxySignalIdentity | null {
  try {
    const expectedUid = getuid();
    if (expectedUid === undefined) return null;
    const birthBefore = linuxProcessBirthIdentity(pid);
    if (!birthBefore) return null;
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const uidMatch = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    const uids = uidMatch ? uidMatch.slice(1).map(Number) : [];
    if (uids.length !== 4 || uids.some(uid => !Number.isSafeInteger(uid) || uid !== expectedUid)) {
      return null;
    }
    const argv = readFileSync(`/proc/${pid}/cmdline`);
    if (argv.length === 0) return null;
    const commandLine = argv.toString("utf8").replace(/\0/g, " ").trim();
    if (!commandLine || !isCodexCommanderStartCommandLine(commandLine)) return null;
    const birthAfter = linuxProcessBirthIdentity(pid);
    if (birthAfter !== birthBefore) return null;
    return {
      pid,
      argvSha256: sha256(argv),
      birthIdentity: birthAfter,
      ownerIdentity: `uid:${expectedUid}`,
    };
  } catch {
    return null;
  }
}

function darwinProcessIdentity(
  pid: number,
  getuid: () => number | undefined,
): ProxySignalIdentity | null {
  try {
    const expectedUid = getuid();
    if (expectedUid === undefined) return null;
    const output = execFileSync(
      "ps",
      ["-o", "pid=,uid=,lstart=,command=", "-p", String(pid)],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      },
    ).trim();
    const match = /^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(output);
    if (!match) return null;
    const observedPid = Number(match[1]);
    const uid = Number(match[2]);
    const birth = match[3]!.trim();
    const commandLine = match[4]!.trim();
    if (observedPid !== pid
      || uid !== expectedUid
      || !Number.isFinite(Date.parse(birth))
      || !isCodexCommanderStartCommandLine(commandLine)) {
      return null;
    }
    return {
      pid,
      argvSha256: sha256(commandLine),
      birthIdentity: `darwin-lstart:${birth}`,
      ownerIdentity: `uid:${uid}`,
    };
  } catch {
    return null;
  }
}

function windowsProcessIdentity(pid: number): ProxySignalIdentity | null {
  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
      `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\"`,
      "if($null -eq $p -or [string]::IsNullOrWhiteSpace($p.CommandLine)){return}",
      "$o=Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop",
      "if($null -eq $o -or $o.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($o.User)){return}",
      "$owner=if($o.Domain){\"$($o.Domain)\\$($o.User)\"}else{$o.User}",
      "if($owner -ine $me){return}",
      "$argv=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.CommandLine))",
      "$born=$p.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",
      "[pscustomobject]@{pid=[int]$p.ProcessId;birth=$born;argv=$argv;owner=$owner}|ConvertTo-Json -Compress",
    ].join("\n");
    const output = execFileSync("powershell.exe", [
      "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden",
      "-Command", script,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    }).trim();
    if (!output) return null;
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (parsed.pid !== pid
      || typeof parsed.birth !== "string"
      || !/^\d+$/.test(parsed.birth)
      || typeof parsed.argv !== "string"
      || typeof parsed.owner !== "string"
      || !parsed.owner.trim()) {
      return null;
    }
    const argv = Buffer.from(parsed.argv, "base64");
    const commandLine = argv.toString("utf8");
    if (!commandLine || !isCodexCommanderStartCommandLine(commandLine)) return null;
    return {
      pid,
      argvSha256: sha256(argv),
      birthIdentity: `windows-ticks:${parsed.birth}`,
      ownerIdentity: `owner:${parsed.owner.toLowerCase()}`,
    };
  } catch {
    return null;
  }
}

function readCurrentUserProxyIdentity(
  pid: number,
  platform: NodeJS.Platform,
  getuid: () => number | undefined,
): ProxySignalIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (platform === "win32") return windowsProcessIdentity(pid);
  if (platform === "darwin") return darwinProcessIdentity(pid, getuid);
  if (platform === "linux") return linuxProcessIdentity(pid, getuid);
  return null;
}

function captureForcedStopAuthorization(
  pid: number,
  io: StopProxyIo,
): ForcedStopAuthorization | null {
  const readRuntime = io.readRuntime ?? readRuntimePort;
  const runtime = protectedRuntimeIdentity(readRuntime(pid), pid);
  if (!runtime) return null;
  const platform = io.platform ?? process.platform;
  const getuid = io.getuid ?? (() => {
    try {
      return typeof process.getuid === "function" ? process.getuid() : undefined;
    } catch {
      return undefined;
    }
  });
  const processIdentity = (io.readProcessIdentity
    ?? (candidatePid => readCurrentUserProxyIdentity(candidatePid, platform, getuid)))(pid);
  return processIdentity ? { runtime, process: processIdentity } : null;
}

function forcedStopAuthorizationStillMatches(
  expected: ForcedStopAuthorization,
  io: StopProxyIo,
): boolean {
  const readRuntime = io.readRuntime ?? readRuntimePort;
  if (!sameProtectedRuntime(expected.runtime, readRuntime(expected.runtime.pid))) return false;
  const platform = io.platform ?? process.platform;
  const getuid = io.getuid ?? (() => {
    try {
      return typeof process.getuid === "function" ? process.getuid() : undefined;
    } catch {
      return undefined;
    }
  });
  const current = (io.readProcessIdentity
    ?? (candidatePid => readCurrentUserProxyIdentity(candidatePid, platform, getuid)))(expected.process.pid);
  return sameProxySignalIdentity(expected.process, current);
}

function forcedStopRefusal(): Error {
  return new Error(
    "Forced proxy stop was refused because the protected runtime or process identity changed.",
  );
}

/** Graceful-first stop: management-API drain, then an exact-identity kill ladder. */
export async function stopProxy(pid: number, io: StopProxyIo = {}): Promise<void> {
  const isAlive = io.isAlive ?? isProcessAlive;
  if (!isAlive(pid)) return;
  // Capture before the potentially long HMAC attestation, request, drain and
  // wait. A same-number replacement is never adopted as the fallback target.
  const authorization = captureForcedStopAuthorization(pid, io);
  const readRuntime = io.readRuntime ?? readRuntimePort;
  const runtime = readRuntime(pid);
  const graceful = await (io.gracefulStop
    ? io.gracefulStop(pid, io.lifecycleLease)
    : stopProxyGracefully(pid, { readRuntime, lifecycleLease: io.lifecycleLease }));
  if (graceful === "refused") {
    // The proxy refused on purpose (foreign service owns it). Forcing would strip shared
    // config while that service keeps the proxy alive.
    throw new Error(
      "The running proxy refused to stop: a service installed under a different "
      + "CODEX_HOME/CODEXCOMMANDER_HOME owns it. Run the stop from that home.",
    );
  }
  if (graceful) {
    await (io.waitStoppedPort ?? waitForStoppedPort)(runtime);
    return;
  }
  if (!authorization) throw forcedStopRefusal();
  killProxyWithAuthorization(pid, authorization, io);
  await (io.waitStoppedPort ?? waitForStoppedPort)(runtime);
}

/** After stop/kill, wait for the former listen port to become bindable (Windows drain). */
async function waitForStoppedPort(
  runtime: { port: number; hostname?: string } | null | undefined,
): Promise<void> {
  if (!runtime?.port) return;
  try {
    const { reclaimListenPort } = await import("../server/port-reclaim");
    await reclaimListenPort(runtime.port, runtime.hostname ?? "127.0.0.1", {
      timeoutMs: 15_000,
      intervalMs: 100,
      scanIntervalMs: 500,
      // The exact old identity is gone once the kill ladder returns. A numeric
      // PID allowlist could hit a newly started replacement, so this phase only
      // waits/drops orphaned TCP rows and never signals another process.
      killCodexCommanderHolders: false,
      onlyKillPids: [],
    });
  } catch {
    /* best-effort — callers that need a hard guarantee reclaim again before bind */
  }
}

function killProxyWithAuthorization(
  pid: number,
  authorization: ForcedStopAuthorization,
  io: StopProxyIo,
): void {
  const isAlive = io.isAlive ?? isProcessAlive;
  const waitExit = io.waitExit ?? waitForExit;
  const platform = io.platform ?? process.platform;
  if (!isAlive(pid)) return;
  if (!forcedStopAuthorizationStillMatches(authorization, io)) throw forcedStopRefusal();
  if (platform === "win32") {
    // Windows process.kill(SIGTERM/SIGINT) is TerminateProcess — not a graceful signal.
    // Graceful drain happens only via stopProxyGracefully() (POST /api/stop). This path
    // is the hard fallback: taskkill /T /F so the process tree exits (ghost LISTEN /
    // CLOSE_WAIT are then cleared by reclaimListenPort / SetTcpEntry).
    const taskkill = io.taskkill ?? ((targetPid: number) => {
      const executable = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
      execFileSync(executable, ["/PID", String(targetPid), "/T", "/F"], {
        stdio: "pipe",
        windowsHide: true,
      });
    });
    try {
      taskkill(pid);
    } catch (err) {
      if (isAlive(pid)) throw err;
    }
  } else {
    const signal = io.signal ?? ((targetPid, value) => { process.kill(targetPid, value); });
    signal(pid, "SIGTERM");
    if (!waitExit(pid, 5000) && isAlive(pid)) {
      // SIGTERM's five-second grace is another PID-reuse/exec window. Never
      // escalate without the original runtime, owner, argv and birth evidence.
      if (!forcedStopAuthorizationStillMatches(authorization, io)) throw forcedStopRefusal();
      signal(pid, "SIGKILL");
    }
  }
  if (!waitExit(pid, 5000)) throw new Error("The verified proxy process did not exit.");
}

/**
 * Immediate hard-stop API retained for callers that do not have a preceding
 * graceful phase. It captures and revalidates the same protected identity
 * before signaling; missing or ambiguous evidence is a refusal.
 */
export function killProxy(pid: number, io: StopProxyIo = {}): void {
  const isAlive = io.isAlive ?? isProcessAlive;
  if (!isAlive(pid)) return;
  const authorization = captureForcedStopAuthorization(pid, io);
  if (!authorization) throw forcedStopRefusal();
  killProxyWithAuthorization(pid, authorization, io);
}

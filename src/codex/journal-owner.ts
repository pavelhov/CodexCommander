import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** OS evidence, never a wall-clock comparison against the journal timestamp. */
export interface JournalOwnerIdentity {
  platform: "darwin" | "linux";
  bootId: string;
  birthToken?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validJournalOwnerIdentity(value: unknown): value is JournalOwnerIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return (identity.platform === "darwin" || identity.platform === "linux")
    && typeof identity.bootId === "string" && UUID.test(identity.bootId)
    && (identity.birthToken === undefined
      || (typeof identity.birthToken === "string" && identity.birthToken.length > 0
        && identity.birthToken.length < 128));
}

export interface JournalOwnerIo {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  command?: (file: string, args: string[]) => string;
  probe?: (pid: number) => void;
  readIdentity?: (pid: number) => JournalOwnerIdentity | undefined;
}

export function readJournalOwnerIdentity(
  pid: number,
  io: JournalOwnerIo = {},
): JournalOwnerIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const platform = io.platform ?? process.platform;
  const read = io.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const command = io.command ?? ((file: string, args: string[]) => execFileSync(file, args, {
    encoding: "utf8", timeout: 1_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
  }));
  try {
    const bootId = (platform === "darwin"
      ? command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])
      : platform === "linux" ? read("/proc/sys/kernel/random/boot_id") : "").trim().toLowerCase();
    if (!UUID.test(bootId) || (platform !== "darwin" && platform !== "linux")) return undefined;
    let birthToken: string | undefined;
    try {
      if (platform === "linux") {
        const stat = read(`/proc/${pid}/stat`);
        const close = stat.lastIndexOf(")");
        const ticks = close < 0 ? undefined : stat.slice(close + 2).trim().split(/\s+/)[19];
        if (ticks && /^\d+$/.test(ticks)) birthToken = ticks;
      } else {
        const start = command("/bin/ps", ["-p", String(pid), "-o", "lstart="]).trim();
        if (/^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(start)
          && Number.isFinite(Date.parse(start))) birthToken = start.replace(/\s+/g, " ");
      }
    } catch { /* A boot-session witness remains useful if process details are unavailable. */ }
    return { platform, bootId, ...(birthToken ? { birthToken } : {}) };
  } catch {
    return undefined;
  }
}

export function journalOwnerIsProvenDead(
  journal: { pid: number; ownerIdentity?: JournalOwnerIdentity },
  io: JournalOwnerIo = {},
): boolean {
  if (!Number.isSafeInteger(journal.pid) || journal.pid <= 0) return false;
  let permissionDenied = false;
  try {
    (io.probe ?? ((pid: number) => { process.kill(pid, 0); }))(journal.pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code !== "EPERM") return false;
    permissionDenied = true;
  }
  const recorded = journal.ownerIdentity;
  if (!validJournalOwnerIdentity(recorded)) return false;
  const current = (io.readIdentity ?? readJournalOwnerIdentity)(journal.pid);
  if (!validJournalOwnerIdentity(current) || current.platform !== recorded.platform) return false;
  // A different boot session proves the original owner is gone even when the
  // reused PID belongs to a privileged process that we cannot signal.
  if (current.bootId.toLowerCase() !== recorded.bootId.toLowerCase()) return true;
  if (permissionDenied) return false;
  return recorded.birthToken !== undefined && current.birthToken !== undefined
    && recorded.birthToken !== current.birthToken;
}

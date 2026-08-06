import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir, hardenConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { isProcessAlive } from "../lib/process-control";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";

export const PROXY_START_LOCK_NAME = "proxy-start.lock";
export const PROXY_ENSURE_LOCK_NAME = "proxy-ensure.lock";
export const PROXY_START_LOCK_WAIT_MS = 75_000;
export const PROXY_START_LOCK_STALE_MS = 120_000;
const MAX_LOCK_BYTES = 4 * 1024;

interface ProxyStartLockRecord {
  version: 1;
  token: string;
  pid: number;
  createdAt: number;
}

interface LockSnapshot {
  bytes: string;
  stats: Pick<Stats, "dev" | "ino" | "mtimeMs" | "size">;
  record: ProxyStartLockRecord | null;
}

export interface ProxyStartLock {
  readonly token: string;
  release(): void;
}

export interface ProxyStartLockOptions {
  path?: string;
  waitTimeoutMs?: number;
  staleAfterMs?: number;
  pollMinMs?: number;
  pollMaxMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  processAlive?: (pid: number) => boolean;
  beforeReclaim?: () => void;
  beforeRelease?: () => void;
}

export class ProxyStartLockError extends Error {
  readonly code = "PROXY_START_LOCK_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProxyStartLockError";
  }
}

/** Expected only while an O_EXCL winner is still publishing its small record. */
class ProxyStartLockSnapshotChangedError extends Error {}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sameIdentity(
  left: Pick<Stats, "dev" | "ino" | "mtimeMs" | "size">,
  right: Pick<Stats, "dev" | "ino" | "mtimeMs" | "size">,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

function parseRecord(value: string): ProxyStartLockRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<ProxyStartLockRecord>;
    if (parsed.version !== 1
      || typeof parsed.token !== "string"
      || !/^[0-9a-f-]{36}$/i.test(parsed.token)
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid ?? 0) <= 0
      || typeof parsed.createdAt !== "number"
      || !Number.isFinite(parsed.createdAt)) return null;
    return parsed as ProxyStartLockRecord;
  } catch {
    return null;
  }
}

function readSnapshot(path: string): LockSnapshot {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new ProxyStartLockError("Proxy start lock is not a safe regular file");
  }
  if (before.size < 0 || before.size > MAX_LOCK_BYTES) {
    throw new ProxyStartLockError("Proxy start lock is too large");
  }
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw new ProxyStartLockError("Proxy start lock is owned by another user");
  }
  const bytes = readFileSync(path, "utf8");
  const after = lstatSync(path);
  if (!sameIdentity(before, after)) {
    throw new ProxyStartLockSnapshotChangedError("Proxy start lock changed while being inspected");
  }
  return {
    bytes,
    stats: before,
    record: parseRecord(bytes),
  };
}

function sameSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.bytes === right.bytes && sameIdentity(left.stats, right.stats);
}

function lockPath(): string {
  return join(getConfigDir(), PROXY_START_LOCK_NAME);
}

function prepareLockPath(path: string, explicitPath: boolean): void {
  const configDir = explicitPath ? dirname(path) : getConfigDir();
  assertNotRealHomeUnderTest(configDir);
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  hardenConfigDir();
  recordOwnedConfigPath(configDir, path);
}

/**
 * Cross-process start serialization held from the final liveness check through bind and
 * PID/runtime publication. A dead owner is reclaimed only after two identical snapshots;
 * a live owner is never evicted merely because startup is slow.
 */
export async function acquireProxyStartLock(
  options: ProxyStartLockOptions = {},
): Promise<ProxyStartLock> {
  const path = options.path ?? lockPath();
  const waitTimeoutMs = options.waitTimeoutMs ?? PROXY_START_LOCK_WAIT_MS;
  const staleAfterMs = options.staleAfterMs ?? PROXY_START_LOCK_STALE_MS;
  const pollMinMs = options.pollMinMs ?? 25;
  const pollMaxMs = options.pollMaxMs ?? 75;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const processAlive = options.processAlive ?? isProcessAlive;
  if (waitTimeoutMs < 0 || staleAfterMs <= 0 || pollMinMs < 0 || pollMaxMs < pollMinMs) {
    throw new ProxyStartLockError("Invalid proxy start lock timing options");
  }

  prepareLockPath(path, options.path !== undefined);
  const startedAt = now();
  for (;;) {
    const token = randomUUID();
    const record: ProxyStartLockRecord = {
      version: 1,
      token,
      pid: process.pid,
      createdAt: now(),
    };
    const bytes = `${JSON.stringify(record)}\n`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, bytes, "utf8");
      fsyncSync(descriptor);
      const created = fstatSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
      const owned = readSnapshot(path);
      if (owned.bytes !== bytes || !sameIdentity(owned.stats, created)) {
        throw new ProxyStartLockError("Proxy start lock changed during creation");
      }
      let released = false;
      return {
        token,
        release(): void {
          if (released) return;
          released = true;
          try {
            const observed = readSnapshot(path);
            if (!sameSnapshot(owned, observed)) return;
            options.beforeRelease?.();
            const current = readSnapshot(path);
            if (sameSnapshot(owned, current)) unlinkSync(path);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") {
              console.warn("[opencodex] Proxy start lock release was deferred to stale recovery.");
            }
          }
        },
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* best effort */ }
      }
      if (errorCode(error) !== "EEXIST") {
        throw error instanceof ProxyStartLockError
          ? error
          : new ProxyStartLockError("Could not create proxy start lock", { cause: error });
      }
    }

    let observed: LockSnapshot;
    try {
      observed = readSnapshot(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      if (error instanceof ProxyStartLockSnapshotChangedError) {
        const elapsed = now() - startedAt;
        if (elapsed >= waitTimeoutMs) {
          throw new ProxyStartLockError(
            `Timed out after ${waitTimeoutMs}ms waiting for proxy startup coordination`,
          );
        }
        await sleep(Math.min(waitTimeoutMs - elapsed, Math.max(1, pollMinMs)));
        continue;
      }
      throw error instanceof ProxyStartLockError
        ? error
        : new ProxyStartLockError("Could not inspect proxy start lock", { cause: error });
    }

    const recordAge = now() - Math.max(
      observed.stats.mtimeMs,
      observed.record?.createdAt ?? observed.stats.mtimeMs,
    );
    const deadOwner = observed.record ? !processAlive(observed.record.pid) : false;
    const malformedAndAged = !observed.record && recordAge > staleAfterMs;
    if (deadOwner || malformedAndAged) {
      options.beforeReclaim?.();
      try {
        const current = readSnapshot(path);
        if (sameSnapshot(observed, current)) {
          unlinkSync(path);
          continue;
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
      }
    }

    const elapsed = now() - startedAt;
    if (elapsed >= waitTimeoutMs) {
      throw new ProxyStartLockError(
        `Timed out after ${waitTimeoutMs}ms waiting for proxy startup coordination`,
      );
    }
    const jitter = pollMinMs + Math.floor(random() * (pollMaxMs - pollMinMs + 1));
    await sleep(Math.min(waitTimeoutMs - elapsed, jitter));
  }
}

/** Serialize detached ensure callers so only one of them spawns a foreground child. */
export function acquireProxyEnsureLock(
  options: ProxyStartLockOptions = {},
): Promise<ProxyStartLock> {
  return acquireProxyStartLock({
    ...options,
    path: options.path ?? join(getConfigDir(), PROXY_ENSURE_LOCK_NAME),
  });
}

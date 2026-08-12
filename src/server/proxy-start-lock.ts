import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
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
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import type { ProxyLifecycleLockLease } from "./proxy-lifecycle-protocol";

export {
  PROXY_ENSURE_LEASE_HEADER,
  PROXY_LIFECYCLE_LEASE_CAPABILITY_HEADER,
  PROXY_LIFECYCLE_LEASE_CAPABILITY_VALUE,
  PROXY_START_LEASE_HEADER,
  advertiseProxyLifecycleLockLease,
  proxyLifecycleLockLeaseHeaders,
  proxySupportsLifecycleLockLease,
  readProxyLifecycleLockLeaseHeaders,
  type ProxyLifecycleLockLease,
  type ProxyLifecycleLockLeaseHeaderState,
} from "./proxy-lifecycle-protocol";

export const PROXY_START_LOCK_NAME = "proxy-start.lock";
export const PROXY_ENSURE_LOCK_NAME = "proxy-ensure.lock";
export const PROXY_START_LOCK_WAIT_MS = 75_000;
export const PROXY_START_LOCK_STALE_MS = 120_000;
export const PROXY_SERVICE_START_DELEGATION_TTL_MS = 120_000;
const MAX_LOCK_BYTES = 4 * 1024;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProxyStartLockRecord {
  version: 1;
  token: string;
  pid: number;
  createdAt: number;
  serviceStartDelegation?: ProxyServiceStartDelegationRecord;
}

interface ProxyServiceStartDelegationRecord {
  version: 1;
  purpose: "service-child-start";
  token: string;
  ensureToken: string;
  issuedAt: number;
  expiresAt: number;
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

export interface ProxyServiceStartDelegation {
  readonly token: string;
  readonly ensureToken: string;
  readonly ownerPid: number;
  readonly expiresAt: number;
}

export interface ProxyServiceStartDelegationOptions {
  ensurePath?: string;
  now?: () => number;
  processAlive?: (pid: number) => boolean;
}

export interface ArmProxyServiceStartDelegationOptions
  extends ProxyServiceStartDelegationOptions {
  ttlMs?: number;
}

export interface ProxyLifecycleLockLeaseValidationOptions {
  ensurePath?: string;
  startPath?: string;
  processAlive?: (pid: number) => boolean;
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
    const delegation = parsed.serviceStartDelegation;
    if (delegation !== undefined && (
      !delegation
      || delegation.version !== 1
      || delegation.purpose !== "service-child-start"
      || typeof delegation.token !== "string"
      || !/^[0-9a-f-]{36}$/i.test(delegation.token)
      || delegation.ensureToken !== parsed.token
      || typeof delegation.issuedAt !== "number"
      || !Number.isFinite(delegation.issuedAt)
      || typeof delegation.expiresAt !== "number"
      || !Number.isFinite(delegation.expiresAt)
      || delegation.expiresAt <= delegation.issuedAt
      || delegation.expiresAt - delegation.issuedAt > PROXY_SERVICE_START_DELEGATION_TTL_MS
    )) return null;
    return parsed as ProxyStartLockRecord;
  } catch {
    return null;
  }
}

function ensureLockPath(path?: string): string {
  return path ?? join(getConfigDir(), PROXY_ENSURE_LOCK_NAME);
}

/**
 * Replace the contents of the same lock inode. This deliberately does not use
 * rename: if the E owner disappears while a child is consuming delegation,
 * an in-flight write must never recreate a released authority record.
 */
function rewriteSnapshotRecord(
  path: string,
  observed: LockSnapshot,
  record: ProxyStartLockRecord,
): LockSnapshot {
  const bytes = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_LOCK_BYTES) {
    throw new ProxyStartLockError("Proxy start lock update is too large");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r+");
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(observed.stats, opened)) {
      throw new ProxyStartLockSnapshotChangedError(
        "Proxy start lock changed before it could be updated",
      );
    }
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, bytes, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const current = readSnapshot(path);
    if (current.bytes !== bytes
      || current.stats.dev !== observed.stats.dev
      || current.stats.ino !== observed.stats.ino) {
      throw new ProxyStartLockSnapshotChangedError(
        "Proxy start lock changed while it was being updated",
      );
    }
    return current;
  } catch (error) {
    throw error instanceof ProxyStartLockError
      || error instanceof ProxyStartLockSnapshotChangedError
      ? error
      : new ProxyStartLockError("Could not update proxy start delegation", { cause: error });
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

/**
 * Publish one bounded, exact-E-owner service launch delegation. Callers hold E
 * and S while arming, then release S before asking the platform manager to
 * launch its child.
 */
export function armProxyServiceStartDelegation(
  ensureToken: string,
  options: ArmProxyServiceStartDelegationOptions = {},
): ProxyServiceStartDelegation {
  const path = ensureLockPath(options.ensurePath);
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? isProcessAlive;
  const ttlMs = options.ttlMs ?? PROXY_SERVICE_START_DELEGATION_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > PROXY_SERVICE_START_DELEGATION_TTL_MS) {
    throw new ProxyStartLockError("Invalid service start delegation lifetime");
  }
  const observed = readSnapshot(path);
  const owner = observed.record;
  if (!owner
    || owner.token !== ensureToken
    || owner.pid !== process.pid
    || !processAlive(owner.pid)) {
    throw new ProxyStartLockError(
      "Service start delegation requires the exact live proxy ensure owner",
    );
  }
  if (owner.serviceStartDelegation) {
    throw new ProxyStartLockError("A service start delegation is already pending");
  }
  const issuedAt = now();
  if (!Number.isFinite(issuedAt)) {
    throw new ProxyStartLockError("Invalid service start delegation clock");
  }
  const marker: ProxyServiceStartDelegationRecord = {
    version: 1,
    purpose: "service-child-start",
    token: randomUUID(),
    ensureToken: owner.token,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  };
  rewriteSnapshotRecord(path, observed, { ...owner, serviceStartDelegation: marker });
  return {
    token: marker.token,
    ensureToken: owner.token,
    ownerPid: owner.pid,
    expiresAt: marker.expiresAt,
  };
}

/** Clear a still-unconsumed delegation without disturbing its owning E lease. */
export function clearProxyServiceStartDelegation(
  delegation: Pick<ProxyServiceStartDelegation, "token" | "ensureToken" | "ownerPid">,
  options: ProxyServiceStartDelegationOptions = {},
): void {
  const path = ensureLockPath(options.ensurePath);
  let observed: LockSnapshot;
  try {
    observed = readSnapshot(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const owner = observed.record;
  const marker = owner?.serviceStartDelegation;
  if (!owner || !marker
    || owner.token !== delegation.ensureToken
    || owner.pid !== delegation.ownerPid
    || marker.token !== delegation.token) return;
  const { serviceStartDelegation: _removed, ...withoutDelegation } = owner;
  rewriteSnapshotRecord(path, observed, withoutDelegation);
}

/**
 * Consume the service marker while the caller owns S. S is the cross-process
 * single-consumer primitive: a replay or concurrent child sees no marker.
 */
export function consumeProxyServiceStartDelegation(
  options: ProxyServiceStartDelegationOptions = {},
): ProxyServiceStartDelegation | null {
  const path = ensureLockPath(options.ensurePath);
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? isProcessAlive;
  let observed: LockSnapshot;
  try {
    observed = readSnapshot(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const owner = observed.record;
  if (!owner) {
    throw new ProxyStartLockError("Proxy ensure authority record is malformed");
  }
  const marker = owner.serviceStartDelegation;
  if (!marker) return null;
  const currentTime = now();
  if (!Number.isFinite(currentTime)) {
    throw new ProxyStartLockError("Invalid service start delegation clock");
  }
  if (marker.ensureToken !== owner.token || !processAlive(owner.pid)) return null;
  const { serviceStartDelegation: _removed, ...withoutDelegation } = owner;
  rewriteSnapshotRecord(path, observed, withoutDelegation);
  if (currentTime < marker.issuedAt || currentTime >= marker.expiresAt) return null;
  return {
    token: marker.token,
    ensureToken: owner.token,
    ownerPid: owner.pid,
    expiresAt: marker.expiresAt,
  };
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
            let observed = readSnapshot(path);
            if (observed.record?.token !== token || observed.record.pid !== process.pid) return;
            options.beforeRelease?.();
            for (let attempt = 0; attempt < 3; attempt++) {
              const current = readSnapshot(path);
              if (current.record?.token !== token || current.record.pid !== process.pid) return;
              if (sameSnapshot(observed, current)) {
                unlinkSync(path);
                return;
              }
              // An authorized child may have consumed the marker in-place.
              // Retry only while the exact random capability and owner remain.
              observed = current;
            }
          } catch (error) {
            if (errorCode(error) !== "ENOENT") {
              console.warn("[codexcommander] Proxy start lock release was deferred to stale recovery.");
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

/**
 * Read-only validation for a delegated shutdown. Both tokens must still name the
 * existing E/S files, and both files must have the same live owner. Validation
 * never creates, repairs, reclaims, or releases either lock.
 */
export function validateProxyLifecycleLockLease(
  lease: ProxyLifecycleLockLease,
  options: ProxyLifecycleLockLeaseValidationOptions = {},
): boolean {
  try {
    const ensure = readSnapshot(
      options.ensurePath ?? join(getConfigDir(), PROXY_ENSURE_LOCK_NAME),
    );
    const start = readSnapshot(
      options.startPath ?? join(getConfigDir(), PROXY_START_LOCK_NAME),
    );
    if (!ensure.record || !start.record
      || ensure.record.token !== lease.ensureToken
      || start.record.token !== lease.startToken
      || ensure.record.pid !== start.record.pid) return false;
    if (!(options.processAlive ?? isProcessAlive)(ensure.record.pid)) return false;

    const stableEnsure = readSnapshot(
      options.ensurePath ?? join(getConfigDir(), PROXY_ENSURE_LOCK_NAME),
    );
    const stableStart = readSnapshot(
      options.startPath ?? join(getConfigDir(), PROXY_START_LOCK_NAME),
    );
    if (!sameSnapshot(ensure, stableEnsure) || !sameSnapshot(start, stableStart)) return false;
    return true;
  } catch {
    return false;
  }
}

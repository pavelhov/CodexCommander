import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import { assertStableLockFile, openStableLockFile, type StableLockFile } from "../codex/native-main-lock-file";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";

export const MEDIA_RECOVERY_FENCE_FILENAME = "media-recovery-fence.json";
export const MEDIA_RECOVERY_FENCE_VERSION = 2;
export const LEGACY_MEDIA_RECOVERY_FENCE_VERSION = 1;
export const MEDIA_RECOVERY_COORDINATOR_FILENAME = "media-recovery-coordinator.sqlite";
const SQLITE_COMPANION_SUFFIXES = ["-journal", "-wal", "-shm"] as const;
const claimedRecoveryCoordinatorPaths = new Set<string>();

export type MediaRecoveryCause = "old_schema" | "future_schema" | "corrupt" | "unsafe" | "unavailable";

export interface MediaRecoveryFence {
  version: typeof LEGACY_MEDIA_RECOVERY_FENCE_VERSION | typeof MEDIA_RECOVERY_FENCE_VERSION;
  id: string;
  revision: number;
  acknowledged: boolean;
  restartRequired: true;
  createdAt: number;
  acknowledgedAt?: number;
  cause: Exclude<MediaRecoveryCause, "future_schema">;
}

export interface MediaRecoveryCoordinatorLease {
  assertOwned(): void;
  close(): void;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function assertPrivateDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.nlink < 1) {
    throw new Error("media recovery directory is unsafe");
  }
  if (process.platform === "win32") {
    if (!hardenSecretDir(path, { required: true, timeoutMemoKey: `${path}::media-recovery` }).ok) {
      throw new Error("media recovery directory is unsafe");
    }
  } else {
    const uid = process.getuid?.();
    if (uid === undefined || stats.uid !== uid || (stats.mode & 0o777) !== 0o700) {
      throw new Error("media recovery directory is unsafe");
    }
  }
}

function assertPrivateFile(path: string, stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error("media recovery file is unsafe");
  }
  if (process.platform === "win32") {
    if (!hardenSecretPath(path, { required: true, timeoutMemoKey: `${path}::media-recovery` }).ok) {
      throw new Error("media recovery file is unsafe");
    }
  } else {
    const uid = process.getuid?.();
    if (uid === undefined || stats.uid !== uid || (stats.mode & 0o777) !== 0o600) {
      throw new Error("media recovery file is unsafe");
    }
  }
}

function parseFence(value: unknown): MediaRecoveryFence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.some(key => ![
    "version", "id", "revision", "acknowledged", "restartRequired", "createdAt", "acknowledgedAt", "cause",
  ].includes(key))) return null;
  if (
    (row.version !== LEGACY_MEDIA_RECOVERY_FENCE_VERSION && row.version !== MEDIA_RECOVERY_FENCE_VERSION)
    || typeof row.id !== "string" || !/^[0-9a-f-]{36}$/.test(row.id)
    || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0
    || typeof row.acknowledged !== "boolean"
    || row.restartRequired !== true
    || !["old_schema", "corrupt", "unsafe", "unavailable"].includes(String(row.cause))
    || !Number.isSafeInteger(row.createdAt) || (row.createdAt as number) <= 0
    || (row.acknowledgedAt !== undefined
      && (!Number.isSafeInteger(row.acknowledgedAt) || (row.acknowledgedAt as number) <= 0))
    || (row.acknowledged !== (row.acknowledgedAt !== undefined))
    || (typeof row.acknowledgedAt === "number" && row.acknowledgedAt < (row.createdAt as number))
  ) return null;
  const revision = row.revision as number;
  if (
    row.version === LEGACY_MEDIA_RECOVERY_FENCE_VERSION
      ? (row.acknowledged ? revision !== 1 : revision !== 0)
      : (row.acknowledged ? (revision !== 1 && revision !== 2) : revision !== 0)
  ) return null;
  return {
    version: row.version,
    id: row.id,
    revision,
    acknowledged: row.acknowledged,
    restartRequired: true,
    createdAt: row.createdAt as number,
    cause: row.cause as MediaRecoveryFence["cause"],
    ...(typeof row.acknowledgedAt === "number" ? { acknowledgedAt: row.acknowledgedAt } : {}),
  };
}

export function mediaRecoveryFencePathForJournal(journalPath: string): string {
  return join(dirname(journalPath), MEDIA_RECOVERY_FENCE_FILENAME);
}

export function mediaRecoveryCoordinatorPathForJournal(journalPath: string): string {
  return join(dirname(journalPath), MEDIA_RECOVERY_COORDINATOR_FILENAME);
}

export function acquireMediaRecoveryCoordinatorForJournal(
  journalPath: string,
): MediaRecoveryCoordinatorLease {
  const path = mediaRecoveryCoordinatorPathForJournal(journalPath);
  if (claimedRecoveryCoordinatorPaths.has(path)) throw new Error("media recovery acknowledgement is busy");
  claimedRecoveryCoordinatorPaths.add(path);
  let file: StableLockFile | undefined;
  let database: Database | undefined;
  let closed = false;
  try {
    const existing = lstatIfPresent(path);
    if (existing) assertPrivateFile(path, existing);
    for (const suffix of SQLITE_COMPANION_SUFFIXES) {
      const sidecar = `${path}${suffix}`;
      const stats = lstatIfPresent(sidecar);
      if (stats) assertPrivateFile(sidecar, stats);
    }
    file = openStableLockFile(path);
    if (!existing || process.platform === "win32") {
      if (process.platform !== "win32") chmodSync(path, 0o600);
      if (!hardenSecretPath(path, { required: true, timeoutMemoKey: `${path}::coordinator` }).ok) {
        throw new Error("media recovery coordinator could not be secured");
      }
    }
    const hardened = lstatSync(path);
    assertPrivateFile(path, hardened);
    assertStableLockFile(path, file);
    database = new Database(path, { create: true, strict: true });
    database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = NORMAL; PRAGMA journal_mode = DELETE");
    database.exec("BEGIN EXCLUSIVE");
    database.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_schema LIMIT 1").get();
    assertStableLockFile(path, file);
    const retainedDatabase = database;
    const retainedFile = file;
    database = undefined;
    file = undefined;
    return {
      assertOwned() {
        if (closed) throw new Error("media recovery coordinator is closed");
        assertStableLockFile(path, retainedFile);
      },
      close() {
        if (closed) return;
        closed = true;
        try { retainedDatabase.exec("ROLLBACK"); } catch { /* close still releases */ }
        try { retainedDatabase.close(); } finally {
          try { retainedFile.close(); } finally { claimedRecoveryCoordinatorPaths.delete(path); }
        }
      },
    };
  } catch (error) {
    try { database?.exec("ROLLBACK"); } catch { /* close below */ }
    try { database?.close(); } catch { /* mapped below */ }
    try { file?.close(); } catch { /* mapped below */ }
    claimedRecoveryCoordinatorPaths.delete(path);
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (/busy|locked/i.test(message)) throw new Error("media recovery acknowledgement is busy");
    throw error;
  }
}

export function readMediaRecoveryFenceForJournal(journalPath: string): MediaRecoveryFence | null {
  const path = mediaRecoveryFencePathForJournal(journalPath);
  const stats = lstatIfPresent(path);
  if (!stats) return null;
  assertPrivateDirectory(dirname(path));
  assertPrivateFile(path, stats);
  if (stats.size < 2 || stats.size > 4_096) throw new Error("media recovery fence is malformed");
  const parsed = parseFence(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed) throw new Error("media recovery fence is malformed");
  return parsed;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFence(left: MediaRecoveryFence, right: MediaRecoveryFence): boolean {
  return left.version === right.version
    && left.id === right.id
    && left.revision === right.revision
    && left.acknowledged === right.acknowledged
    && left.createdAt === right.createdAt
    && left.acknowledgedAt === right.acknowledgedAt
    && left.cause === right.cause;
}

/**
 * An acknowledged fence is an admission authority. Re-synchronize and
 * revalidate its exact file while the recovery coordinator is held so a prior
 * rename whose directory sync failed cannot authorize fresh paid work.
 */
export function readDurableMediaRecoveryFenceForJournal(
  journalPath: string,
): MediaRecoveryFence | null {
  const observed = readMediaRecoveryFenceForJournal(journalPath);
  if (!observed?.acknowledged) return observed;
  const path = mediaRecoveryFencePathForJournal(journalPath);
  const before = lstatSync(path);
  assertPrivateFile(path, before);
  let fileFd: number | undefined;
  let directoryFd: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fileFd = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fileFd);
    assertPrivateFile(path, opened);
    if (!sameFileIdentity(before, opened) || before.size !== opened.size) {
      throw new Error("media recovery fence changed while synchronizing");
    }
    fsyncSync(fileFd);
    const afterFileSync = lstatSync(path);
    assertPrivateFile(path, afterFileSync);
    if (!sameFileIdentity(opened, afterFileSync) || opened.size !== afterFileSync.size) {
      throw new Error("media recovery fence changed while synchronizing");
    }
    closeSync(fileFd);
    fileFd = undefined;
    directoryFd = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(directoryFd);
    closeSync(directoryFd);
    directoryFd = undefined;
  } finally {
    if (fileFd !== undefined) {
      try { closeSync(fileFd); } catch { /* mapped by the caller */ }
    }
    if (directoryFd !== undefined) {
      try { closeSync(directoryFd); } catch { /* mapped by the caller */ }
    }
  }
  const durable = readMediaRecoveryFenceForJournal(journalPath);
  if (!durable || !sameFence(observed, durable)) {
    throw new Error("media recovery fence changed while synchronizing");
  }
  return durable;
}

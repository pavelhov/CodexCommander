import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  assertStableLockFile,
  openStableLockFile,
  type StableLockFile,
} from "../codex/native-main-lock-file";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import {
  acquireMediaJournalOwnerLease,
  defaultMediaJournalPath,
  MEDIA_JOURNAL_SCHEMA_VERSION,
} from "./video-job-store";

const FENCE_FILENAME = "media-recovery-fence.json";
const FENCE_VERSION = 1;

export type MediaRecoveryCause = "old_schema" | "future_schema" | "corrupt" | "unsafe" | "unavailable";

export interface MediaRecoveryFence {
  id: string;
  revision: number;
  acknowledged: boolean;
  restartRequired: true;
  createdAt: number;
  acknowledgedAt?: number;
  cause: Exclude<MediaRecoveryCause, "future_schema">;
}

export interface MediaRecoveryInspection {
  cause: MediaRecoveryCause;
  readOnly: boolean;
}

interface StableJournalSnapshot {
  readonly path: string;
  readonly file: StableLockFile;
  readonly dev: number;
  readonly ino: number;
}

interface LockedJournalInspection {
  readonly inspection: MediaRecoveryInspection;
  close(): void;
}

function mediaDirectory(): string {
  return dirname(defaultMediaJournalPath());
}

export function mediaRecoveryFencePath(): string {
  return join(mediaDirectory(), FENCE_FILENAME);
}

function assertPrivateDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.nlink < 1) {
    throw new Error("media recovery directory is unsafe");
  }
  if (process.platform === "win32") {
    if (!hardenSecretDir(path, { required: true, timeoutMemoKey: `${path}::media-recovery` }).ok) throw new Error("media recovery directory is unsafe");
  } else {
    const uid = process.getuid?.();
    if (uid === undefined || stats.uid !== uid || (stats.mode & 0o777) !== 0o700) throw new Error("media recovery directory is unsafe");
  }
}

function assertPrivateFile(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error("media recovery file is unsafe");
  }
  if (process.platform === "win32") {
    if (!hardenSecretPath(path, { required: true, timeoutMemoKey: `${path}::media-recovery` }).ok) throw new Error("media recovery file is unsafe");
  } else {
    const uid = process.getuid?.();
    if (uid === undefined || stats.uid !== uid || (stats.mode & 0o777) !== 0o600) throw new Error("media recovery file is unsafe");
  }
}

function parseFence(value: unknown): MediaRecoveryFence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.some(key => !["version", "id", "revision", "acknowledged", "restartRequired", "createdAt", "acknowledgedAt", "cause"].includes(key))) return null;
  if (
    row.version !== FENCE_VERSION
    || typeof row.id !== "string" || !/^[0-9a-f-]{36}$/.test(row.id)
    || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0
    || typeof row.acknowledged !== "boolean"
    || row.restartRequired !== true
    || !["old_schema", "corrupt", "unsafe", "unavailable"].includes(String(row.cause))
    || !Number.isSafeInteger(row.createdAt) || (row.createdAt as number) <= 0
    || (row.acknowledgedAt !== undefined && (!Number.isSafeInteger(row.acknowledgedAt) || (row.acknowledgedAt as number) <= 0))
  ) return null;
  return {
    id: row.id,
    revision: row.revision as number,
    acknowledged: row.acknowledged,
    restartRequired: true,
    createdAt: row.createdAt as number,
    cause: row.cause as MediaRecoveryFence["cause"],
    ...(typeof row.acknowledgedAt === "number" ? { acknowledgedAt: row.acknowledgedAt } : {}),
  };
}

export function readMediaRecoveryFence(): MediaRecoveryFence | null {
  const path = mediaRecoveryFencePath();
  if (!existsSync(path)) return null;
  assertPrivateDirectory(dirname(path));
  assertPrivateFile(path);
  const stats = lstatSync(path);
  if (stats.size < 2 || stats.size > 4_096) throw new Error("media recovery fence is malformed");
  const parsed = parseFence(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed) throw new Error("media recovery fence is malformed");
  return parsed;
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function openStableJournalSnapshot(path: string): StableJournalSnapshot {
  assertPrivateFile(path);
  const file = openStableLockFile(path);
  try {
    assertStableLockFile(path, file);
    const stats = lstatSync(path);
    assertPrivateFile(path);
    return { path, file, dev: stats.dev, ino: stats.ino };
  } catch (error) {
    file.close();
    throw error;
  }
}

function assertStableJournalSnapshot(snapshot: StableJournalSnapshot): void {
  assertStableLockFile(snapshot.path, snapshot.file);
  const stats = lstatSync(snapshot.path);
  assertPrivateFile(snapshot.path);
  if (stats.dev !== snapshot.dev || stats.ino !== snapshot.ino) {
    throw new Error("media journal identity changed");
  }
}

function sqliteBusyOrLocked(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /\b(?:busy|locked)\b/i.test(message);
}

function classifyOpenJournal(db: Database): MediaRecoveryInspection {
  try {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    return !Number.isSafeInteger(version)
      ? { cause: "corrupt", readOnly: false }
      : (version as number) > MEDIA_JOURNAL_SCHEMA_VERSION
        ? { cause: "future_schema", readOnly: true }
        : (version as number) < MEDIA_JOURNAL_SCHEMA_VERSION
          ? { cause: "old_schema", readOnly: false }
          : { cause: "corrupt", readOnly: false };
  } catch (error) {
    if (sqliteBusyOrLocked(error)) throw error;
    return { cause: "corrupt", readOnly: false };
  }
}

/**
 * Classify through a read-only connection first, then (only for a journal that
 * may be quarantined) hold an EXCLUSIVE lock on the primary SQLite inode while
 * reclassifying it. Future-schema journals never pass through a read-write open.
 */
function lockAndInspectStableJournal(snapshot: StableJournalSnapshot): LockedJournalInspection {
  let reader: Database | undefined;
  let db: Database | undefined;
  let transactionOpen = false;
  try {
    reader = new Database(snapshot.path, { readonly: true, strict: true });
    reader.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON");
    const initial = classifyOpenJournal(reader);
    reader.close();
    reader = undefined;
    assertStableJournalSnapshot(snapshot);
    if (initial.cause === "future_schema") {
      return { inspection: initial, close() {} };
    }

    db = new Database(snapshot.path, { strict: true });
    db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = NORMAL");
    // Keep BEGIN separate: Bun's multi-statement exec reports only the final
    // statement, which can hide SQLITE_BUSY from the lock acquisition.
    db.exec("BEGIN EXCLUSIVE");
    transactionOpen = true;
    db.exec("PRAGMA query_only = ON");
    const inspection = classifyOpenJournal(db);
    assertStableJournalSnapshot(snapshot);
    const locked = db;
    return {
      inspection,
      close() {
        if (transactionOpen) {
          transactionOpen = false;
          try { locked.exec("ROLLBACK"); } catch { /* close still releases the inode lock */ }
        }
        try { locked.close(); } catch { /* quarantine may already have moved the locked inode */ }
      },
    };
  } catch (error) {
    try { reader?.close(); } catch { /* mapped below */ }
    if (transactionOpen) {
      try { db?.exec("ROLLBACK"); } catch { /* close below */ }
    }
    try { db?.close(); } catch { /* mapped below */ }
    throw error;
  }
}

function readOnlyInspection(error: unknown): MediaRecoveryInspection {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unsafe|ownership|permission|secured|identity/i.test(message)
    ? { cause: "unsafe", readOnly: true }
    : { cause: "unavailable", readOnly: true };
}

/**
 * SQLite's default Win32 VFS opens the primary with read/write sharing but not
 * FILE_SHARE_DELETE. Quarantine must retain both that SQLite handle and the
 * stable identity descriptor until the primary move; closing them first would
 * let a non-cooperating writer replace or mutate the journal between proof and
 * rename. Windows therefore exposes inspection only and never creates a fence
 * or moves journal bytes.
 */
function inspectionForPlatform(
  inspection: MediaRecoveryInspection,
  platform: NodeJS.Platform,
): MediaRecoveryInspection {
  return !mediaJournalQuarantineSupported(platform) && !inspection.readOnly
    ? { ...inspection, readOnly: true }
    : inspection;
}

/** Whether this host can move a journal without releasing its proof handles. */
export function mediaJournalQuarantineSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

function writeFence(record: MediaRecoveryFence, expected?: MediaRecoveryFence): void {
  const path = mediaRecoveryFencePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  assertPrivateDirectory(dir);
  if (expected) {
    const current = readMediaRecoveryFence();
    if (!current || current.id !== expected.id || current.revision !== expected.revision || current.acknowledged !== expected.acknowledged) {
      throw new Error("media recovery fence changed concurrently");
    }
  } else if (existsSync(path)) {
    throw new Error("media recovery fence already exists");
  }
  const temp = join(dir, `.${randomUUID()}.media-recovery.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify({ version: FENCE_VERSION, ...record })}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    if (!hardenSecretPath(temp, { required: true, timeoutMemoKey: path }).ok) throw new Error("media recovery fence could not be secured");
    assertPrivateFile(temp);
    renameSync(temp, path);
    assertPrivateFile(path);
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* private fail-closed residue */ }
  }
}

export function inspectMediaJournalRecovery(error?: unknown): MediaRecoveryInspection {
  const journal = defaultMediaJournalPath();
  let owner: ReturnType<typeof acquireMediaJournalOwnerLease> | undefined;
  let snapshot: StableJournalSnapshot | undefined;
  let primary: LockedJournalInspection | undefined;
  try {
    assertPrivateDirectory(dirname(journal));
    if (!existsSync(journal)) return { cause: "unavailable", readOnly: true };
    owner = acquireMediaJournalOwnerLease(journal);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const candidate = `${journal}${suffix}`;
      if (existsSync(candidate)) assertPrivateFile(candidate);
    }
    snapshot = openStableJournalSnapshot(journal);
    primary = lockAndInspectStableJournal(snapshot);
    assertStableJournalSnapshot(snapshot);
    owner.assertOwned();
    return inspectionForPlatform(primary.inspection, process.platform);
  } catch (caught) {
    return readOnlyInspection(caught ?? error);
  } finally {
    primary?.close();
    snapshot?.file.close();
    owner?.close();
  }
}

/**
 * Establish the durable unknown-work fence before moving any journal byte. A
 * crash can therefore leave a partial quarantine, but can never silently admit
 * new video work. Artifacts live in a sibling directory and are never touched.
 */
export function quarantineMediaJournal(expectedRevision: number): MediaRecoveryFence {
  if (expectedRevision !== 0) throw new Error("media recovery revision changed");
  const dir = mediaDirectory();
  const journal = defaultMediaJournalPath();
  let owner: ReturnType<typeof acquireMediaJournalOwnerLease> | undefined;
  let snapshot: StableJournalSnapshot | undefined;
  let primary: LockedJournalInspection | undefined;
  try {
    assertPrivateDirectory(dir);
    if (!existsSync(journal)) throw new Error("media recovery is read-only");
    owner = acquireMediaJournalOwnerLease(journal);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const candidate = `${journal}${suffix}`;
      if (existsSync(candidate)) assertPrivateFile(candidate);
    }
    snapshot = openStableJournalSnapshot(journal);
    primary = lockAndInspectStableJournal(snapshot);
    const inspection = inspectionForPlatform(primary.inspection, process.platform);
    if (inspection.readOnly || inspection.cause === "future_schema") throw new Error("media recovery is read-only");
    const previousFence = readMediaRecoveryFence();
    if (previousFence && !previousFence.acknowledged) throw new Error("media recovery fence already exists");
    const fence: MediaRecoveryFence = {
      id: randomUUID(),
      revision: 0,
      acknowledged: false,
      restartRequired: true,
      createdAt: Date.now(),
      cause: inspection.cause as MediaRecoveryFence["cause"],
    };
    // Fence only while the exact journal inode and exclusive owner lease are
    // both still held. A live runtime therefore cannot be reset underneath.
    assertStableJournalSnapshot(snapshot);
    owner.assertOwned();
    writeFence(fence, previousFence ?? undefined);
    const quarantine = join(dir, `quarantine-${fence.id}`);
    mkdirSync(quarantine, { mode: 0o700 });
    if (process.platform !== "win32") chmodSync(quarantine, 0o700);
    assertPrivateDirectory(quarantine);
    // Move DELETE-mode sidecars first and the stable primary inode last. The
    // owner coordinator is permanent lock state, not journal data.
    for (const suffix of ["-journal", "-wal", "-shm", ""]) {
      const candidate = `${journal}${suffix}`;
      if (!existsSync(candidate)) continue;
      assertStableJournalSnapshot(snapshot);
      owner.assertOwned();
      assertPrivateFile(candidate);
      renameSync(candidate, join(quarantine, basename(candidate)));
    }
    fsyncDirectory(quarantine);
    fsyncDirectory(dir);
    return fence;
  } catch (error) {
    if (error instanceof Error && /busy|locked/i.test(error.message)) {
      throw new Error("media recovery is read-only");
    }
    throw error;
  } finally {
    primary?.close();
    snapshot?.file.close();
    owner?.close();
  }
}

export function acknowledgeMediaRecoveryFence(id: string, expectedRevision: number): MediaRecoveryFence | null {
  const current = readMediaRecoveryFence();
  if (!current || current.id !== id || current.revision !== expectedRevision || current.acknowledged) return null;
  const next: MediaRecoveryFence = {
    ...current,
    revision: current.revision + 1,
    acknowledged: true,
    acknowledgedAt: Date.now(),
  };
  writeFence(next, current);
  return next;
}

/** An acknowledged fence permits a clean journal only on the next process start. */
export function mediaRecoveryBlocksStartup(): MediaRecoveryFence | null {
  const fence = readMediaRecoveryFence();
  return fence && !fence.acknowledged ? fence : null;
}

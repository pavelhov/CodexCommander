import { Database } from "bun:sqlite";
import { dlopen, FFIType, type Library } from "bun:ffi";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  assertStableLockFile,
  openStableLockFile,
  type StableLockFile,
} from "../codex/native-main-lock-file";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import {
  acquireMediaRecoveryCoordinatorForJournal,
  MEDIA_RECOVERY_FENCE_VERSION,
  mediaRecoveryFencePathForJournal,
  readMediaRecoveryFenceForJournal,
  type MediaRecoveryCause,
  type MediaRecoveryFence,
} from "./media-recovery-fence";
import {
  acquireMediaJournalOwnerLease,
  defaultMediaJournalPath,
  mediaJournalRecoveryOwnerPathForJournal,
  MEDIA_JOURNAL_SCHEMA_VERSION,
} from "./video-job-store";
import { videoOperationReplaySecretPathForJournal } from "./video-operation-secret";

const QUARANTINE_MANIFEST_FILENAME = "media-recovery-manifest.json";
const QUARANTINE_MANIFEST_TEMP_FILENAME = ".media-recovery-manifest.tmp";
const QUARANTINE_MANIFEST_VERSION = 2;
const SQLITE_COMPANION_SUFFIXES = ["-journal", "-wal", "-shm"] as const;
const SQLITE_LOCK_BYTE_START = 0x4000_0000;
const SQLITE_LOCK_BYTE_LENGTH = 512;
const POSIX_LOCKF_UNLOCK = 0;
const POSIX_LOCKF_TRY = 2;

const POSIX_SQLITE_LOCK_FUNCTIONS = {
  lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
  lockf: { args: [FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
} as const;

type PosixSqliteLockLibrary = Library<typeof POSIX_SQLITE_LOCK_FUNCTIONS>;
type PosixSqliteLockSymbols = PosixSqliteLockLibrary["symbols"];
let posixSqliteLockLibrary: PosixSqliteLockLibrary | null | undefined;

export type { MediaRecoveryCause, MediaRecoveryFence } from "./media-recovery-fence";

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

interface LegacyPrimaryProof {
  assertOwned(): void;
  close(): void;
}

interface AuthoritativeMediaFile {
  readonly path: string;
  readonly name: string;
  readonly role: "journal_sidecar" | "replay_secret" | "journal" | "owner_sidecar" | "owner";
  /** SQLite lock state may legitimately change or disappear when proof handles close. */
  readonly volatile: boolean;
}

interface QuarantineManifestEntry {
  readonly name: string;
  readonly volatile: boolean;
  readonly dev?: string;
  readonly ino?: string;
  readonly size?: string;
  readonly mtimeMs?: string;
}

interface QuarantineManifest {
  readonly fenceId: string;
  readonly files: readonly QuarantineManifestEntry[];
}

export interface MediaJournalQuarantineTestOptions {
  /** Test-only crash seam after the durable fence and before the first move. */
  afterFence?: () => void;
  /** Test-only crash seam after each authoritative file move. */
  afterMove?: (name: string) => void;
}

export interface MediaRecoveryAcknowledgeTestOptions {
  /** Test-only interleaving seam after the cross-process acknowledgement lease. */
  afterRecoveryLease?: () => void;
  /** Test-only crash seam after each resumed authoritative file move. */
  afterMove?: (name: string) => void;
  /** Test-only crash seam after writing the migration manifest temp, before fsync. */
  afterManifestTempWrite?: () => void;
  /** Test-only crash seam after the migration manifest temp is durable. */
  afterManifestTempSync?: () => void;
  /** Test-only crash seam after manifest rename, before directory fsync. */
  afterManifestRename?: () => void;
  /** Test-only crash seam after an existing manifest is durably rebound. */
  afterManifestDurable?: () => void;
  /** Test-only fault seam for completed-bundle directory synchronization. */
  fsyncDirectory?: (path: string) => void;
  /** Test-only crash seam after the completed bundle is directory-synchronized. */
  afterCompletionSync?: () => void;
  /** Test-only fault seam after the acknowledged fence rename. */
  fenceFsyncDirectory?: (path: string) => void;
}

function mediaDirectory(): string {
  return dirname(defaultMediaJournalPath());
}

export function mediaRecoveryFencePath(): string {
  return mediaRecoveryFencePathForJournal(defaultMediaJournalPath());
}

function authoritativeMediaFiles(journal: string): readonly AuthoritativeMediaFile[] {
  const owner = mediaJournalRecoveryOwnerPathForJournal(journal);
  return [
    ...SQLITE_COMPANION_SUFFIXES.map(suffix => ({
      path: `${journal}${suffix}`,
      name: basename(`${journal}${suffix}`),
      role: "journal_sidecar" as const,
      volatile: suffix === "-shm",
    })),
    {
      path: videoOperationReplaySecretPathForJournal(journal),
      name: basename(videoOperationReplaySecretPathForJournal(journal)),
      role: "replay_secret" as const,
      volatile: false,
    },
    {
      path: journal,
      name: basename(journal),
      role: "journal" as const,
      volatile: false,
    },
    ...SQLITE_COMPANION_SUFFIXES.map(suffix => ({
      path: `${owner}${suffix}`,
      name: basename(`${owner}${suffix}`),
      role: "owner_sidecar" as const,
      volatile: true,
    })),
    {
      path: owner,
      name: basename(owner),
      role: "owner" as const,
      volatile: false,
    },
  ];
}

function filesystemErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") return null;
    throw error;
  }
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

function privateFileStats(path: string): Stats {
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
  return stats;
}

function assertPrivateFile(path: string): void {
  privateFileStats(path);
}

export function readMediaRecoveryFence(): MediaRecoveryFence | null {
  return readMediaRecoveryFenceForJournal(defaultMediaJournalPath());
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

function quarantineDirectory(fenceId: string): string {
  return join(mediaDirectory(), `quarantine-${fenceId}`);
}

function quarantineManifestPath(fenceId: string): string {
  return join(quarantineDirectory(fenceId), QUARANTINE_MANIFEST_FILENAME);
}

function manifestIdentity(stats: Stats): Omit<QuarantineManifestEntry, "name"> {
  return {
    volatile: false,
    dev: String(stats.dev),
    ino: String(stats.ino),
    size: String(stats.size),
    mtimeMs: String(stats.mtimeMs),
  };
}

function manifestEntry(file: AuthoritativeMediaFile): QuarantineManifestEntry {
  return manifestEntryAt(file.name, file.path);
}

function manifestEntryAt(name: string, path: string): QuarantineManifestEntry {
  return { name, ...manifestIdentity(privateFileStats(path)) };
}

function sameManifestIdentity(entry: QuarantineManifestEntry, stats: Stats): boolean {
  if (entry.volatile) return true;
  const observed = manifestIdentity(stats);
  return entry.dev === observed.dev
    && entry.ino === observed.ino
    && entry.size === observed.size
    && entry.mtimeMs === observed.mtimeMs;
}

function assertManifestIdentity(path: string, entry: QuarantineManifestEntry): void {
  if (!sameManifestIdentity(entry, privateFileStats(path))) {
    throw new Error("media recovery bundle identity changed");
  }
}

function validManifestScalar(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && /^-?[0-9]+(?:\.[0-9]+)?$/.test(value);
}

function parseQuarantineManifest(value: unknown, fenceId: string): QuarantineManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["version", "fenceId", "files"].includes(key))) return null;
  if (row.version !== QUARANTINE_MANIFEST_VERSION || row.fenceId !== fenceId || !Array.isArray(row.files)) return null;
  const definitions = authoritativeMediaFiles(defaultMediaJournalPath());
  const knownNames = new Set(definitions.map(file => file.name));
  const volatileNames = new Set(definitions.filter(file => file.volatile).map(file => file.name));
  const files: QuarantineManifestEntry[] = [];
  const seen = new Set<string>();
  if (row.files.length < 2 || row.files.length > definitions.length) return null;
  for (const raw of row.files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some(key => !["name", "volatile", "dev", "ino", "size", "mtimeMs"].includes(key))) return null;
    const volatile = entry.volatile === true;
    if (
      typeof entry.name !== "string"
      || !knownNames.has(entry.name)
      || !seen.add(entry.name)
      || (volatile !== volatileNames.has(entry.name))
      || (volatile
        ? Object.keys(entry).some(key => !["name", "volatile"].includes(key))
        : entry.volatile !== false
          || !validManifestScalar(entry.dev)
          || !validManifestScalar(entry.ino)
          || !validManifestScalar(entry.size)
          || !validManifestScalar(entry.mtimeMs))
    ) return null;
    files.push(volatile
      ? { name: entry.name, volatile: true }
      : {
          name: entry.name,
          volatile: false,
          dev: entry.dev as string,
          ino: entry.ino as string,
          size: entry.size as string,
          mtimeMs: entry.mtimeMs as string,
        });
  }
  const primaryName = basename(defaultMediaJournalPath());
  const ownerName = basename(mediaJournalRecoveryOwnerPathForJournal(defaultMediaJournalPath()));
  if (
    !seen.has(primaryName)
    || !seen.has(ownerName)
    || [...volatileNames].some(name => !seen.has(name))
  ) return null;
  const canonicalNames = definitions.map(file => file.name).filter(name => seen.has(name));
  if (files.some((entry, index) => entry.name !== canonicalNames[index])) return null;
  return { fenceId, files };
}

function serializedQuarantineManifest(
  fenceId: string,
  files: readonly QuarantineManifestEntry[],
): string {
  return `${JSON.stringify({
    version: QUARANTINE_MANIFEST_VERSION,
    fenceId,
    files,
  })}\n`;
}

function createQuarantineManifest(
  fenceId: string,
  files: readonly QuarantineManifestEntry[],
  options: {
    allowExistingDirectory?: boolean;
    afterTempWrite?: () => void;
    afterTempSync?: () => void;
    afterRename?: () => void;
  } = {},
): QuarantineManifest {
  const dir = quarantineDirectory(fenceId);
  const path = quarantineManifestPath(fenceId);
  const temp = join(dir, QUARANTINE_MANIFEST_TEMP_FILENAME);
  const serialized = serializedQuarantineManifest(fenceId, files);
  const existingDirectory = lstatIfPresent(dir);
  if (existingDirectory) {
    if (!options.allowExistingDirectory) {
      throw new Error("media recovery bundle path changed concurrently");
    }
    assertPrivateDirectory(dir);
  } else {
    mkdirSync(dir, { mode: 0o700 });
  }
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  assertPrivateDirectory(dir);
  if (lstatIfPresent(path)) throw new Error("media recovery manifest already exists");
  let fd: number | undefined;
  try {
    const existingTemp = lstatIfPresent(temp);
    if (existingTemp) {
      privateFileStats(temp);
      const staged = readFileSync(temp, "utf8");
      if (staged !== serialized) {
        let validButDifferent = false;
        try {
          validButDifferent = parseQuarantineManifest(JSON.parse(staged), fenceId) !== null;
        } catch { /* a torn temp is safe to replace before publication */ }
        if (validButDifferent) throw new Error("media recovery bundle identity changed");
        unlinkSync(temp);
        fsyncDirectory(dir);
      }
    }
    const createTemp = !lstatIfPresent(temp);
    if (createTemp) {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, serialized, "utf8");
      options.afterTempWrite?.();
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      if (process.platform !== "win32") chmodSync(temp, 0o600);
      if (!hardenSecretPath(temp, { required: true, timeoutMemoKey: path }).ok) {
        throw new Error("media recovery manifest could not be secured");
      }
    }
    assertPrivateFile(temp);
    if (readFileSync(temp, "utf8") !== serialized) {
      throw new Error("media recovery manifest changed before publication");
    }
    if (!createTemp) {
      fd = openSync(temp, "r");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    }
    options.afterTempSync?.();
    if (lstatIfPresent(path)) throw new Error("media recovery manifest already exists");
    renameSync(temp, path);
    assertPrivateFile(path);
    options.afterRename?.();
    fsyncDirectory(dir);
    fsyncDirectory(dirname(dir));
    return { fenceId, files };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  }
}

function readQuarantineManifest(fenceId: string): QuarantineManifest {
  const dir = quarantineDirectory(fenceId);
  const path = quarantineManifestPath(fenceId);
  assertPrivateDirectory(dir);
  const stats = privateFileStats(path);
  if (stats.size < 2 || stats.size > 16_384) throw new Error("media recovery manifest is malformed");
  const parsed = parseQuarantineManifest(JSON.parse(readFileSync(path, "utf8")), fenceId);
  if (!parsed) throw new Error("media recovery manifest is malformed");
  return parsed;
}

function readDurableQuarantineManifest(
  fenceId: string,
  assertRecoveryOwned: () => void,
): QuarantineManifest {
  const dir = quarantineDirectory(fenceId);
  const path = quarantineManifestPath(fenceId);
  assertPrivateDirectory(dir);
  const before = privateFileStats(path);
  if (before.size < 2 || before.size > 16_384) throw new Error("media recovery manifest is malformed");
  let fd: number | undefined;
  let serialized: string;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("media recovery manifest changed while synchronizing");
    }
    serialized = readFileSync(fd, "utf8");
    const parsed = parseQuarantineManifest(JSON.parse(serialized), fenceId);
    if (!parsed) throw new Error("media recovery manifest is malformed");
    assertRecoveryOwned();
    fsyncSync(fd);
    const afterSync = privateFileStats(path);
    if (
      afterSync.dev !== opened.dev
      || afterSync.ino !== opened.ino
      || afterSync.size !== opened.size
    ) throw new Error("media recovery manifest changed while synchronizing");
    closeSync(fd);
    fd = undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  fsyncDirectory(dir);
  fsyncDirectory(dirname(dir));
  assertRecoveryOwned();
  const rebound = privateFileStats(path);
  if (rebound.dev !== before.dev || rebound.ino !== before.ino || rebound.size !== before.size) {
    throw new Error("media recovery manifest changed while synchronizing");
  }
  if (readFileSync(path, "utf8") !== serialized) {
    throw new Error("media recovery manifest changed while synchronizing");
  }
  return readQuarantineManifest(fenceId);
}

function manifestEntriesByName(manifest: QuarantineManifest): ReadonlyMap<string, QuarantineManifestEntry> {
  return new Map(manifest.files.map(entry => [entry.name, entry]));
}

function assertNoUnrecordedAuthoritativeFiles(manifest: QuarantineManifest): void {
  const recorded = manifestEntriesByName(manifest);
  const quarantine = quarantineDirectory(manifest.fenceId);
  const allowedQuarantineNames = new Set([QUARANTINE_MANIFEST_FILENAME, ...recorded.keys()]);
  for (const name of readdirSync(quarantine)) {
    if (!allowedQuarantineNames.has(name)) {
      throw new Error("media recovery bundle contains an unrecorded companion");
    }
  }
  for (const file of authoritativeMediaFiles(defaultMediaJournalPath())) {
    const source = lstatIfPresent(file.path);
    const destinationPath = join(quarantine, file.name);
    const destination = lstatIfPresent(destinationPath);
    if ((source || destination) && !recorded.has(file.name)) {
      throw new Error("media recovery bundle contains an unrecorded companion");
    }
  }
}

function moveManifestEntry(
  file: AuthoritativeMediaFile,
  entry: QuarantineManifestEntry,
  fenceId: string,
): boolean {
  const destination = join(quarantineDirectory(fenceId), file.name);
  const sourceStats = lstatIfPresent(file.path);
  const destinationStats = lstatIfPresent(destination);
  if (sourceStats && destinationStats) throw new Error("media recovery bundle path changed concurrently");
  if (destinationStats) {
    assertManifestIdentity(destination, entry);
    return false;
  }
  if (!sourceStats) {
    if (entry.volatile) return false;
    throw new Error("media recovery bundle is incomplete");
  }
  assertManifestIdentity(file.path, entry);
  if (lstatIfPresent(destination)) throw new Error("media recovery bundle path changed concurrently");
  renameSync(file.path, destination);
  if (lstatIfPresent(file.path)) throw new Error("media recovery bundle source was not retired");
  assertManifestIdentity(destination, entry);
  return true;
}

function assertCompleteQuarantineManifest(
  manifest: QuarantineManifest,
  injectedDirectorySync?: (path: string) => void,
): void {
  assertNoUnrecordedAuthoritativeFiles(manifest);
  const definitions = new Map(authoritativeMediaFiles(defaultMediaJournalPath()).map(file => [file.name, file]));
  const quarantine = quarantineDirectory(manifest.fenceId);
  for (const entry of manifest.files) {
    const file = definitions.get(entry.name);
    if (!file || lstatIfPresent(file.path)) throw new Error("media recovery bundle is incomplete");
    const destination = lstatIfPresent(join(quarantine, entry.name));
    if (entry.volatile) {
      if (destination) assertPrivateFile(join(quarantine, entry.name));
    } else {
      if (!destination) throw new Error("media recovery bundle is incomplete");
      assertManifestIdentity(join(quarantine, entry.name), entry);
    }
  }
  const syncDirectory = injectedDirectorySync ?? fsyncDirectory;
  syncDirectory(quarantine);
  syncDirectory(dirname(quarantine));
}

function assertQuarantineStagedForAcknowledgement(manifest: QuarantineManifest): void {
  assertNoUnrecordedAuthoritativeFiles(manifest);
  const definitions = new Map(authoritativeMediaFiles(defaultMediaJournalPath()).map(file => [file.name, file]));
  const quarantine = quarantineDirectory(manifest.fenceId);
  for (const entry of manifest.files) {
    const file = definitions.get(entry.name);
    if (!file) throw new Error("media recovery manifest is malformed");
    const source = lstatIfPresent(file.path);
    const destinationPath = join(quarantine, entry.name);
    const destination = lstatIfPresent(destinationPath);
    if (file.role === "owner") {
      if (!source || destination) throw new Error("media recovery bundle is incomplete");
      assertManifestIdentity(file.path, entry);
    } else if (entry.volatile) {
      if (source) throw new Error("media recovery bundle is incomplete");
      if (destination) assertPrivateFile(destinationPath);
    } else {
      if (source || !destination) throw new Error("media recovery bundle is incomplete");
      assertManifestIdentity(destinationPath, entry);
    }
  }
  fsyncDirectory(quarantine);
  fsyncDirectory(dirname(quarantine));
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

function posixSqliteLockSymbols(): PosixSqliteLockSymbols | null {
  if (posixSqliteLockLibrary !== undefined) return posixSqliteLockLibrary?.symbols ?? null;
  if (process.platform !== "darwin" && process.platform !== "linux") {
    posixSqliteLockLibrary = null;
    return null;
  }
  const candidates = process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", "libc.so"];
  for (const candidate of candidates) {
    try {
      posixSqliteLockLibrary = dlopen(candidate, POSIX_SQLITE_LOCK_FUNCTIONS);
      return posixSqliteLockLibrary.symbols;
    } catch {
      // Try the next fixed platform libc name; unavailable locking fails closed.
    }
  }
  posixSqliteLockLibrary = null;
  return null;
}

/**
 * Take SQLite's complete POSIX main-file lock-byte span without opening SQLite
 * or touching a missing companion. This proof is used only to finish the old
 * fixed companion-first mover, and is released before SQLite opens the now
 * coherent quarantine bundle.
 */
function acquirePrimaryJournalProof(snapshot: StableJournalSnapshot): LegacyPrimaryProof {
  const symbols = posixSqliteLockSymbols();
  if (!symbols) throw legacyMigrationError("the primary journal lock proof is unavailable");
  assertStableJournalSnapshot(snapshot);
  const seek = Number(symbols.lseek(snapshot.file.fd, SQLITE_LOCK_BYTE_START, 0));
  if (seek !== SQLITE_LOCK_BYTE_START) {
    throw legacyMigrationError("the primary journal lock proof is unavailable");
  }
  if (symbols.lockf(snapshot.file.fd, POSIX_LOCKF_TRY, SQLITE_LOCK_BYTE_LENGTH) !== 0) {
    throw legacyMigrationError("the legacy journal is busy");
  }
  let closed = false;
  try {
    assertStableJournalSnapshot(snapshot);
  } catch (error) {
    try {
      symbols.lseek(snapshot.file.fd, SQLITE_LOCK_BYTE_START, 0);
      symbols.lockf(snapshot.file.fd, POSIX_LOCKF_UNLOCK, SQLITE_LOCK_BYTE_LENGTH);
    } catch { /* retain the original identity error */ }
    throw error;
  }
  return {
    assertOwned() {
      if (closed) throw legacyMigrationError("the primary journal lock proof was released");
      const opened = fstatSync(snapshot.file.fd);
      if (opened.dev !== snapshot.dev || opened.ino !== snapshot.ino) {
        throw legacyMigrationError("the primary journal lock proof changed identity");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      const repositioned = Number(symbols.lseek(snapshot.file.fd, SQLITE_LOCK_BYTE_START, 0));
      if (
        repositioned !== SQLITE_LOCK_BYTE_START
        || symbols.lockf(snapshot.file.fd, POSIX_LOCKF_UNLOCK, SQLITE_LOCK_BYTE_LENGTH) !== 0
      ) throw legacyMigrationError("the primary journal lock proof could not be released");
    },
  };
}

const SQLITE_ROLLBACK_JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

function hasHotRollbackJournal(primaryPath: string): boolean {
  const path = `${primaryPath}-journal`;
  const before = lstatIfPresent(path);
  if (!before) return false;
  privateFileStats(path);
  if (before.size <= 512) return false;
  let fd: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("media recovery bundle identity changed");
    }
    const header = Buffer.alloc(SQLITE_ROLLBACK_JOURNAL_MAGIC.byteLength);
    if (readSync(fd, header, 0, header.byteLength, 0) !== header.byteLength) return false;
    const after = privateFileStats(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error("media recovery bundle identity changed");
    }
    return header.equals(SQLITE_ROLLBACK_JOURNAL_MAGIC);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sqliteBusyOrLocked(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /\b(?:busy|locked)\b/i.test(message);
}

function fsyncStableCompanion(path: string): void {
  const before = privateFileStats(path);
  let fd: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("media recovery bundle identity changed while synchronizing");
    }
    fsyncSync(fd);
    const after = privateFileStats(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error("media recovery bundle identity changed while synchronizing");
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A graceful SQLite close checkpoints the last WAL connection and would make
 * identities captured while the recovery lock is held stale. Normalize the
 * committed frames first, while the exact primary is still exclusively owned,
 * so the eventual close is byte-stable and the manifest describes a coherent
 * ordinary-backup bundle rather than a pre-close transient.
 */
function normalizeWalForStableManifest(db: Database, snapshot: StableJournalSnapshot): void {
  const walPath = `${snapshot.path}-wal`;
  const wal = lstatIfPresent(walPath);
  if (!wal || wal.size === 0) return;
  privateFileStats(walPath);
  const checkpoint = db.query<{
    busy: number;
    log: number;
    checkpointed: number;
  }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (!checkpoint || checkpoint.busy !== 0 || checkpoint.log !== 0) {
    throw new Error("media journal is busy");
  }
  assertStableJournalSnapshot(snapshot);
  fsyncSync(snapshot.file.fd);
  if (lstatIfPresent(walPath)) fsyncStableCompanion(walPath);
  fsyncDirectory(dirname(snapshot.path));
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
    db.exec("PRAGMA busy_timeout = 0");
    const lockingMode = db.query<{ locking_mode: string }, []>("PRAGMA locking_mode = EXCLUSIVE").get()?.locking_mode;
    if (lockingMode?.toLowerCase() !== "exclusive") {
      throw new Error("media journal exclusive locking is unavailable");
    }
    normalizeWalForStableManifest(db, snapshot);
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
        locked.close();
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

/**
 * A genuine hot DELETE journal cannot be opened read-only: SQLite must first
 * consume it to roll the primary back. Legacy acknowledgement already holds
 * the recovery coordinator, owner lease, and stable primary inode, so recover
 * that exact crash state before capturing the v2 manifest identities.
 */
function lockAndInspectLegacyJournal(snapshot: StableJournalSnapshot): LockedJournalInspection {
  if (!hasHotRollbackJournal(snapshot.path)) return lockAndInspectStableJournal(snapshot);
  if (lstatIfPresent(`${snapshot.path}-wal`)) {
    throw legacyMigrationError("a hot rollback journal is mixed with WAL state");
  }
  let db: Database | undefined;
  let transactionOpen = false;
  try {
    assertStableJournalSnapshot(snapshot);
    db = new Database(snapshot.path, { strict: true });
    db.exec("PRAGMA busy_timeout = 0");
    const lockingMode = db.query<{ locking_mode: string }, []>("PRAGMA locking_mode = EXCLUSIVE").get()?.locking_mode;
    if (lockingMode?.toLowerCase() !== "exclusive") {
      throw legacyMigrationError("the recovery journal exclusive lock is unavailable");
    }
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
        locked.close();
      },
    };
  } catch (error) {
    if (transactionOpen) {
      try { db?.exec("ROLLBACK"); } catch { /* close below */ }
    }
    try { db?.close(); } catch { /* mapped by the caller */ }
    throw error;
  }
}

function legacyMigrationError(reason: string): Error {
  return new Error(
    `legacy media recovery cannot be migrated safely (${reason}); `
    + "restore the exact media journal, replay secret, and recovery owner bundle from a coherent backup, then retry acknowledgement",
  );
}

function assertExactLegacyQuarantineContents(fenceId: string): boolean {
  const dir = quarantineDirectory(fenceId);
  const stats = lstatIfPresent(dir);
  if (!stats) return false;
  assertPrivateDirectory(dir);
  const allowed = new Set([
    QUARANTINE_MANIFEST_FILENAME,
    QUARANTINE_MANIFEST_TEMP_FILENAME,
    ...authoritativeMediaFiles(defaultMediaJournalPath()).map(file => file.name),
  ]);
  for (const name of readdirSync(dir)) {
    if (!allowed.has(name)) throw legacyMigrationError("the quarantine contains an unrecognized file");
  }
  return true;
}

interface LegacyFileObservation {
  readonly file: AuthoritativeMediaFile;
  readonly source: Stats | null;
  readonly destinationPath: string;
  readonly destination: Stats | null;
}

function observeLegacyFiles(
  fenceId: string,
  definitions: readonly AuthoritativeMediaFile[],
): readonly LegacyFileObservation[] {
  const quarantine = quarantineDirectory(fenceId);
  return definitions.map(file => {
    const source = lstatIfPresent(file.path);
    const destinationPath = join(quarantine, file.name);
    const destination = lstatIfPresent(destinationPath);
    if (source) privateFileStats(file.path);
    if (destination) privateFileStats(destinationPath);
    if (source && destination) {
      throw legacyMigrationError(`both source and quarantine contain ${file.role}`);
    }
    return { file, source, destinationPath, destination };
  });
}

/**
 * Upgrade the fixed legacy layout while the caller holds the global recovery
 * coordinator. The old mover relocated SQLite companions before the primary,
 * but never moved replay authority or the recovery owner. Complete that fixed
 * mover under a non-mutating SQLite-compatible primary proof, open the coherent
 * quarantine bundle, then publish v2 identities before the normal mover runs.
 */
function migrateLegacyQuarantineManifest(
  fence: MediaRecoveryFence,
  assertRecoveryOwned: () => void,
  afterMove?: (name: string) => void,
  afterManifestTempWrite?: () => void,
  afterManifestTempSync?: () => void,
  afterManifestRename?: () => void,
): QuarantineManifest {
  if (fence.version === MEDIA_RECOVERY_FENCE_VERSION) {
    throw new Error("media recovery bundle is incomplete");
  }
  const journal = defaultMediaJournalPath();
  const definitions = authoritativeMediaFiles(journal);
  const journalFile = definitions.find(file => file.role === "journal");
  const ownerFile = definitions.find(file => file.role === "owner");
  if (!journalFile || !ownerFile) throw new Error("media recovery definitions are incomplete");
  let owner: ReturnType<typeof acquireMediaJournalOwnerLease> | undefined;
  let snapshot: StableJournalSnapshot | undefined;
  let primary: LockedJournalInspection | undefined;
  let manifestProof: LegacyPrimaryProof | undefined;
  try {
    assertRecoveryOwned();
    const quarantineExists = assertExactLegacyQuarantineContents(fence.id);
    let observations = observeLegacyFiles(fence.id, definitions);
    const ownerObservation = observations.find(value => value.file.role === "owner");
    if (!ownerObservation?.source || ownerObservation.destination) {
      throw legacyMigrationError("the legacy recovery owner is not intact at its source path");
    }
    const replaySecretObservation = observations.find(value => value.file.role === "replay_secret");
    if (!replaySecretObservation?.source || replaySecretObservation.destination) {
      throw legacyMigrationError("the legacy replay secret is not intact at its source path");
    }
    for (const observation of observations) {
      if (
        (observation.file.role === "replay_secret" || observation.file.role === "owner_sidecar")
        && observation.destination
      ) {
        throw legacyMigrationError(`legacy recovery could not have moved ${observation.file.role}`);
      }
    }
    owner = acquireMediaJournalOwnerLease(journal, { requireExisting: true });
    assertRecoveryOwned();
    owner.assertOwned();

    const journalObservation = observations.find(value => value.file.role === "journal");
    if (!journalObservation || (!journalObservation.source && !journalObservation.destination)) {
      throw legacyMigrationError("the primary journal is missing");
    }
    if (journalObservation.destination && !quarantineExists) {
      throw legacyMigrationError("the quarantined primary has no private bundle directory");
    }
    if (fence.acknowledged && journalObservation.source) {
      throw legacyMigrationError("an acknowledged legacy fence did not finish moving the primary journal");
    }

    const sidecars = observations.filter(value => value.file.role === "journal_sidecar");
    let primaryPath: string;
    if (journalObservation.destination) {
      if (sidecars.some(value => value.source)) {
        throw legacyMigrationError("a completed legacy primary has a source-side SQLite companion");
      }
      primaryPath = journalObservation.destinationPath;
    } else {
      let observedSource = false;
      for (const sidecar of sidecars) {
        if (sidecar.source) observedSource = true;
        if (sidecar.destination && observedSource) {
          throw legacyMigrationError("legacy SQLite companions do not match the fixed move order");
        }
      }
      snapshot = openStableJournalSnapshot(journalFile.path);
      let proof: LegacyPrimaryProof | undefined;
      try {
        proof = acquirePrimaryJournalProof(snapshot);
        assertRecoveryOwned();
        owner.assertOwned();
        const lockedObservations = observeLegacyFiles(fence.id, definitions);
        for (let index = 0; index < observations.length; index += 1) {
          const before = observations[index]!;
          const locked = lockedObservations[index]!;
          if (before.file.role === "owner_sidecar") continue;
          if (
            Boolean(before.source) !== Boolean(locked.source)
            || Boolean(before.destination) !== Boolean(locked.destination)
            || (before.source && locked.source
              && (before.source.dev !== locked.source.dev || before.source.ino !== locked.source.ino))
            || (before.destination && locked.destination
              && (before.destination.dev !== locked.destination.dev || before.destination.ino !== locked.destination.ino))
          ) throw legacyMigrationError("the authoritative bundle changed before primary lock proof");
        }
        const quarantine = quarantineDirectory(fence.id);
        if (!quarantineExists) {
          mkdirSync(quarantine, { mode: 0o700 });
          if (process.platform !== "win32") chmodSync(quarantine, 0o700);
          assertPrivateDirectory(quarantine);
        }
        // Complete the old destinations-prefix mover while a competing SQLite
        // writer cannot acquire any main-file lock byte. Moving the primary
        // last makes every crash state a retryable prefix. Only after the
        // renamed bundle and both directories are durable do we release the
        // raw proof and let SQLite open the coherent quarantine path.
        for (const sidecar of lockedObservations.filter(
          value => value.file.role === "journal_sidecar",
        )) {
          if (!sidecar.source) continue;
          proof.assertOwned();
          assertStableJournalSnapshot(snapshot);
          assertRecoveryOwned();
          owner.assertOwned();
          const identity = manifestIdentity(sidecar.source);
          const entry = { name: sidecar.file.name, ...identity };
          assertManifestIdentity(sidecar.file.path, entry);
          if (lstatIfPresent(sidecar.destinationPath)) {
            throw legacyMigrationError("a SQLite companion appeared in quarantine");
          }
          renameSync(sidecar.file.path, sidecar.destinationPath);
          if (lstatIfPresent(sidecar.file.path)) {
            throw legacyMigrationError("a SQLite companion source was not retired");
          }
          assertManifestIdentity(sidecar.destinationPath, entry);
          afterMove?.(sidecar.file.name);
        }
        proof.assertOwned();
        assertStableJournalSnapshot(snapshot);
        assertRecoveryOwned();
        owner.assertOwned();
        const primaryIdentity = manifestIdentity(journalObservation.source!);
        const primaryEntry = { name: journalFile.name, ...primaryIdentity };
        assertManifestIdentity(journalFile.path, primaryEntry);
        if (lstatIfPresent(journalObservation.destinationPath)) {
          throw legacyMigrationError("the primary journal appeared in quarantine");
        }
        renameSync(journalFile.path, journalObservation.destinationPath);
        if (lstatIfPresent(journalFile.path)) {
          throw legacyMigrationError("the primary journal source was not retired");
        }
        assertManifestIdentity(journalObservation.destinationPath, primaryEntry);
        proof.assertOwned();
        afterMove?.(journalFile.name);
        fsyncDirectory(quarantine);
        fsyncDirectory(dirname(journal));
        proof.assertOwned();
      } finally {
        try { proof?.close(); } finally {
          snapshot?.file.close();
          snapshot = undefined;
        }
      }
      primaryPath = journalObservation.destinationPath;
    }

    if (!primary) {
      snapshot = openStableJournalSnapshot(primaryPath);
      primary = lockAndInspectLegacyJournal(snapshot);
    }
    const lockedSnapshot = snapshot;
    if (!lockedSnapshot) throw new Error("media recovery journal proof is unavailable");
    if (primary.inspection.cause === "future_schema") {
      throw legacyMigrationError("the recovered journal has a future schema");
    }
    // SQLite recovery and WAL close-time normalization must finish before any
    // identity becomes authoritative. Reacquire the raw primary proof only
    // after the default VFS is fully closed; the canonical source path has
    // already been retired, so no path-based writer can enter this handoff.
    primary.close();
    primary = undefined;
    assertStableJournalSnapshot(lockedSnapshot);
    manifestProof = acquirePrimaryJournalProof(lockedSnapshot);
    manifestProof.assertOwned();
    fsyncSync(lockedSnapshot.file.fd);
    for (const suffix of ["-journal", "-wal"] as const) {
      const companion = `${lockedSnapshot.path}${suffix}`;
      if (lstatIfPresent(companion)) fsyncStableCompanion(companion);
    }
    fsyncDirectory(dirname(lockedSnapshot.path));
    manifestProof.assertOwned();
    assertRecoveryOwned();
    owner.assertOwned();

    if (!assertExactLegacyQuarantineContents(fence.id) && journalObservation.destination) {
      throw legacyMigrationError("the quarantine directory disappeared");
    }
    observations = observeLegacyFiles(fence.id, definitions);
    manifestProof.assertOwned();
    const stableJournal = observations.find(value => value.file.role === "journal");
    const stableOwner = observations.find(value => value.file.role === "owner");
    if (
      !stableJournal
      || (!stableJournal.source && !stableJournal.destination)
      || !stableOwner?.source
      || stableOwner.destination
    ) {
      throw legacyMigrationError("the authoritative bundle changed while it was locked");
    }
    const manifestFiles = observations.flatMap(observation => {
      if (observation.file.volatile) {
        return [{ name: observation.file.name, volatile: true } satisfies QuarantineManifestEntry];
      }
      const path = observation.source ? observation.file.path
        : observation.destination ? observation.destinationPath
          : undefined;
      return path ? [manifestEntryAt(observation.file.name, path)] : [];
    });
    assertRecoveryOwned();
    manifestProof.assertOwned();
    const manifest = createQuarantineManifest(fence.id, manifestFiles, {
      allowExistingDirectory: true,
      afterTempWrite: afterManifestTempWrite,
      afterTempSync: afterManifestTempSync,
      afterRename: afterManifestRename,
    });
    assertExactLegacyQuarantineContents(fence.id);
    assertStableJournalSnapshot(lockedSnapshot);
    manifestProof.assertOwned();
    assertRecoveryOwned();
    owner.assertOwned();
    const entries = manifestEntriesByName(manifest);
    const published = observeLegacyFiles(fence.id, definitions);
    for (const observation of published) {
      const entry = entries.get(observation.file.name);
      if (!entry || entry.volatile) continue;
      const path = observation.source ? observation.file.path
        : observation.destination ? observation.destinationPath
          : undefined;
      if (!path) throw legacyMigrationError("an authoritative file disappeared during manifest publication");
      assertManifestIdentity(path, entry);
    }
    let primaryAtSource = stableJournal.source !== null;
    for (const file of definitions) {
      const entry = entries.get(file.name);
      if (!entry || entry.volatile || file.role === "owner") continue;
      if (primaryAtSource) assertStableJournalSnapshot(lockedSnapshot);
      manifestProof.assertOwned();
      assertRecoveryOwned();
      owner.assertOwned();
      if (moveManifestEntry(file, entry, fence.id)) afterMove?.(file.name);
      if (file.role === "journal") primaryAtSource = false;
    }
    fsyncDirectory(quarantineDirectory(fence.id));
    fsyncDirectory(dirname(journal));
    manifestProof.assertOwned();
    return manifest;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("legacy media recovery")) throw error;
    const reason = sqliteBusyOrLocked(error) ? "the legacy journal is busy" : "the legacy bundle could not be verified";
    throw legacyMigrationError(reason);
  } finally {
    try { primary?.close(); } finally {
      try { manifestProof?.close(); } finally {
        snapshot?.file.close();
        owner?.close();
      }
    }
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

function writeFence(
  record: MediaRecoveryFence,
  expected?: MediaRecoveryFence,
  injectedDirectorySync?: (path: string) => void,
): void {
  if (record.version !== MEDIA_RECOVERY_FENCE_VERSION) {
    throw new Error("media recovery fence version is not writable");
  }
  const path = mediaRecoveryFencePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  assertPrivateDirectory(dir);
  if (expected) {
    const current = readMediaRecoveryFence();
    if (
      !current
      || current.version !== expected.version
      || current.id !== expected.id
      || current.revision !== expected.revision
      || current.acknowledged !== expected.acknowledged
      || current.createdAt !== expected.createdAt
      || current.acknowledgedAt !== expected.acknowledgedAt
      || current.cause !== expected.cause
    ) {
      throw new Error("media recovery fence changed concurrently");
    }
  } else if (lstatIfPresent(path)) {
    throw new Error("media recovery fence already exists");
  }
  const temp = join(dir, `.${randomUUID()}.media-recovery.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    if (!hardenSecretPath(temp, { required: true, timeoutMemoKey: path }).ok) throw new Error("media recovery fence could not be secured");
    assertPrivateFile(temp);
    renameSync(temp, path);
    assertPrivateFile(path);
    (injectedDirectorySync ?? fsyncDirectory)(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { if (lstatIfPresent(temp)) unlinkSync(temp); } catch { /* private fail-closed residue */ }
  }
}

export function inspectMediaJournalRecovery(error?: unknown): MediaRecoveryInspection {
  const journal = defaultMediaJournalPath();
  let owner: ReturnType<typeof acquireMediaJournalOwnerLease> | undefined;
  let snapshot: StableJournalSnapshot | undefined;
  let primary: LockedJournalInspection | undefined;
  try {
    assertPrivateDirectory(dirname(journal));
    if (!lstatIfPresent(journal)) return { cause: "unavailable", readOnly: true };
    owner = acquireMediaJournalOwnerLease(journal);
    for (const suffix of SQLITE_COMPANION_SUFFIXES) {
      const candidate = `${journal}${suffix}`;
      if (lstatIfPresent(candidate)) assertPrivateFile(candidate);
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
export function quarantineMediaJournal(
  expectedRevision: number,
  testOptions: MediaJournalQuarantineTestOptions = {},
): MediaRecoveryFence {
  if (expectedRevision !== 0) throw new Error("media recovery revision changed");
  if (!mediaJournalQuarantineSupported()) throw new Error("media recovery is read-only");
  const dir = mediaDirectory();
  const journal = defaultMediaJournalPath();
  let coordinator: ReturnType<typeof acquireMediaRecoveryCoordinatorForJournal> | undefined;
  let owner: ReturnType<typeof acquireMediaJournalOwnerLease> | undefined;
  let snapshot: StableJournalSnapshot | undefined;
  let primary: LockedJournalInspection | undefined;
  try {
    assertPrivateDirectory(dir);
    if (!lstatIfPresent(journal)) throw new Error("media recovery is read-only");
    coordinator = acquireMediaRecoveryCoordinatorForJournal(journal);
    owner = acquireMediaJournalOwnerLease(journal);
    const authoritative = authoritativeMediaFiles(journal);
    for (const file of authoritative) {
      if (lstatIfPresent(file.path)) assertPrivateFile(file.path);
    }
    snapshot = openStableJournalSnapshot(journal);
    primary = lockAndInspectStableJournal(snapshot);
    const inspection = inspectionForPlatform(primary.inspection, process.platform);
    if (inspection.readOnly || inspection.cause === "future_schema") throw new Error("media recovery is read-only");
    const previousFence = readMediaRecoveryFence();
    if (previousFence && (
      previousFence.version !== MEDIA_RECOVERY_FENCE_VERSION
      || !previousFence.acknowledged
    )) throw new Error("media recovery fence already exists");
    const fence: MediaRecoveryFence = {
      version: MEDIA_RECOVERY_FENCE_VERSION,
      id: randomUUID(),
      revision: 0,
      acknowledged: false,
      restartRequired: true,
      createdAt: Date.now(),
      cause: inspection.cause as MediaRecoveryFence["cause"],
    };
    const manifestFiles = authoritative.flatMap(file => {
      if (file.volatile) {
        return [{ name: file.name, volatile: true } satisfies QuarantineManifestEntry];
      }
      return lstatIfPresent(file.path) ? [manifestEntry(file)] : [];
    });
    // Fence only while the exact journal inode and exclusive owner lease are
    // both still held. A live runtime therefore cannot be reset underneath.
    assertStableJournalSnapshot(snapshot);
    coordinator.assertOwned();
    owner.assertOwned();
    const manifest = createQuarantineManifest(fence.id, manifestFiles);
    assertStableJournalSnapshot(snapshot);
    coordinator.assertOwned();
    owner.assertOwned();
    writeFence(fence, previousFence ?? undefined);
    testOptions.afterFence?.();
    const entries = manifestEntriesByName(manifest);
    let primaryAtSource = true;
    // Keep the recovery-owner primary at its source path until acknowledgement.
    // It is the cross-process coordinator that makes a stale store preflight
    // rejoin the fence protocol instead of creating a clean journal early.
    for (const file of authoritative) {
      const entry = entries.get(file.name);
      if (!entry || entry.volatile || file.role === "owner") continue;
      if (primaryAtSource) assertStableJournalSnapshot(snapshot);
      coordinator.assertOwned();
      owner.assertOwned();
      if (moveManifestEntry(file, entry, fence.id)) testOptions.afterMove?.(file.name);
      if (file.role === "journal") primaryAtSource = false;
    }
    primary.close();
    primary = undefined;
    snapshot.file.close();
    snapshot = undefined;
    owner.close();
    owner = undefined;
    for (const file of authoritative) {
      const entry = entries.get(file.name);
      if (!entry?.volatile) continue;
      if (moveManifestEntry(file, entry, fence.id)) testOptions.afterMove?.(file.name);
    }
    assertQuarantineStagedForAcknowledgement(manifest);
    coordinator.assertOwned();
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
    coordinator?.close();
  }
}

export function acknowledgeMediaRecoveryFence(
  id: string,
  expectedRevision: number,
  testOptions: MediaRecoveryAcknowledgeTestOptions = {},
): MediaRecoveryFence | null {
  if (!mediaJournalQuarantineSupported()) throw new Error("media recovery is read-only");
  const observed = readMediaRecoveryFence();
  if (
    !observed
    || observed.id !== id
    || observed.revision !== expectedRevision
    || (observed.acknowledged && observed.version === MEDIA_RECOVERY_FENCE_VERSION)
  ) return null;
  let coordinator: ReturnType<typeof acquireMediaRecoveryCoordinatorForJournal> | undefined;
  try {
    coordinator = acquireMediaRecoveryCoordinatorForJournal(defaultMediaJournalPath());
    const current = readMediaRecoveryFence();
    if (
      !current
      || current.id !== id
      || current.revision !== expectedRevision
      || (current.acknowledged && current.version === MEDIA_RECOVERY_FENCE_VERSION)
    ) return null;
    testOptions.afterRecoveryLease?.();
    coordinator.assertOwned();
    const journal = defaultMediaJournalPath();
    const definitions = authoritativeMediaFiles(journal);
    const stagedManifest = lstatIfPresent(quarantineManifestPath(current.id))
      ? readQuarantineManifest(current.id)
      : migrateLegacyQuarantineManifest(
          current,
          () => coordinator!.assertOwned(),
          testOptions.afterMove,
          testOptions.afterManifestTempWrite,
          testOptions.afterManifestTempSync,
          testOptions.afterManifestRename,
        );
    coordinator.assertOwned();
    const manifest = readDurableQuarantineManifest(
      stagedManifest.fenceId,
      () => coordinator!.assertOwned(),
    );
    testOptions.afterManifestDurable?.();
    coordinator.assertOwned();
    assertNoUnrecordedAuthoritativeFiles(manifest);
    const entries = manifestEntriesByName(manifest);
    const ownerFile = definitions.find(file => file.role === "owner");
    const ownerEntry = ownerFile ? entries.get(ownerFile.name) : undefined;
    if (!ownerFile || !ownerEntry) throw new Error("media recovery manifest is malformed");
    const ownerAtSource = lstatIfPresent(ownerFile.path) !== null;
    const ownerAtDestination = lstatIfPresent(join(quarantineDirectory(current.id), ownerFile.name)) !== null;
    let owner: ReturnType<typeof acquireMediaJournalOwnerLease> | undefined;
    let snapshot: StableJournalSnapshot | undefined;
    let proof: LegacyPrimaryProof | undefined;
    try {
      if (ownerAtSource) {
        if (ownerAtDestination) throw new Error("media recovery bundle path changed concurrently");
        assertManifestIdentity(ownerFile.path, ownerEntry);
        owner = acquireMediaJournalOwnerLease(journal, { requireExisting: true });
        assertManifestIdentity(ownerFile.path, ownerEntry);
      } else if (!ownerAtDestination) {
        throw new Error("media recovery bundle is incomplete");
      }

      const journalFile = definitions.find(file => file.role === "journal");
      const journalEntry = journalFile ? entries.get(journalFile.name) : undefined;
      if (!journalFile || !journalEntry) throw new Error("media recovery manifest is malformed");
      const quarantinedJournal = join(quarantineDirectory(current.id), journalFile.name);
      const journalAtSource = lstatIfPresent(journalFile.path) !== null;
      const journalAtDestination = lstatIfPresent(quarantinedJournal) !== null;
      if (journalAtSource === journalAtDestination) {
        throw new Error(journalAtSource
          ? "media recovery bundle path changed concurrently"
          : "media recovery bundle is incomplete");
      }
      const provenJournalPath = journalAtSource ? journalFile.path : quarantinedJournal;
      assertManifestIdentity(provenJournalPath, journalEntry);
      snapshot = openStableJournalSnapshot(provenJournalPath);
      proof = acquirePrimaryJournalProof(snapshot);
      proof.assertOwned();
      coordinator.assertOwned();
      assertManifestIdentity(provenJournalPath, journalEntry);

      if (ownerAtSource) {
        let primaryAtSource = journalAtSource;
        for (const file of definitions) {
          const entry = entries.get(file.name);
          if (!entry || entry.volatile) continue;
          if (primaryAtSource && snapshot) assertStableJournalSnapshot(snapshot);
          proof.assertOwned();
          owner!.assertOwned();
          if (moveManifestEntry(file, entry, current.id)) testOptions.afterMove?.(file.name);
          if (file.role === "journal") {
            primaryAtSource = false;
            proof.assertOwned();
          }
        }
        owner!.close();
        owner = undefined;
      }
      for (const file of definitions) {
        const entry = entries.get(file.name);
        if (!entry?.volatile) continue;
        proof.assertOwned();
        if (moveManifestEntry(file, entry, current.id)) testOptions.afterMove?.(file.name);
      }
      proof.assertOwned();
      coordinator.assertOwned();
      assertCompleteQuarantineManifest(manifest, testOptions.fsyncDirectory);
      proof.assertOwned();
      testOptions.afterCompletionSync?.();
      const next: MediaRecoveryFence = {
        ...current,
        version: MEDIA_RECOVERY_FENCE_VERSION,
        revision: current.revision + 1,
        acknowledged: true,
        acknowledgedAt: Math.max(Date.now(), current.createdAt, current.acknowledgedAt ?? 0),
      };
      writeFence(next, current, testOptions.fenceFsyncDirectory);
      proof.assertOwned();
      return next;
    } finally {
      try { owner?.close(); } finally {
        try { proof?.close(); } finally {
          snapshot?.file.close();
        }
      }
    }
  } finally {
    coordinator?.close();
  }
}

/** An acknowledged fence permits a clean journal only on the next process start. */
export function mediaRecoveryBlocksStartup(): MediaRecoveryFence | null {
  const fence = readMediaRecoveryFence();
  return fence && (
    fence.version !== MEDIA_RECOVERY_FENCE_VERSION
    || !fence.acknowledged
  ) ? fence : null;
}

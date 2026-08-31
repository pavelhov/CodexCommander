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

import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import {
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
  try {
    assertPrivateDirectory(dirname(journal));
    if (!existsSync(journal)) return { cause: "unavailable", readOnly: true };
    assertPrivateFile(journal);
    for (const base of [journal, `${journal}.recovery-owner.sqlite`]) {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        const candidate = `${base}${suffix}`;
        if (existsSync(candidate)) assertPrivateFile(candidate);
      }
    }
    const db = new Database(journal, { readonly: true, strict: true });
    try {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
      if (!Number.isSafeInteger(version)) return { cause: "corrupt", readOnly: false };
      if ((version as number) > MEDIA_JOURNAL_SCHEMA_VERSION) return { cause: "future_schema", readOnly: true };
      if ((version as number) < MEDIA_JOURNAL_SCHEMA_VERSION) return { cause: "old_schema", readOnly: false };
      return { cause: "corrupt", readOnly: false };
    } finally {
      db.close();
    }
  } catch {
    const message = error instanceof Error ? error.message : "";
    return /unsafe|ownership|permission|secured|identity/i.test(message)
      ? { cause: "unsafe", readOnly: true }
      : { cause: "unavailable", readOnly: true };
  }
}

/**
 * Establish the durable unknown-work fence before moving any journal byte. A
 * crash can therefore leave a partial quarantine, but can never silently admit
 * new video work. Artifacts live in a sibling directory and are never touched.
 */
export function quarantineMediaJournal(expectedRevision: number): MediaRecoveryFence {
  if (expectedRevision !== 0) throw new Error("media recovery revision changed");
  const inspection = inspectMediaJournalRecovery();
  if (inspection.readOnly || inspection.cause === "future_schema") throw new Error("media recovery is read-only");
  const previousFence = readMediaRecoveryFence();
  if (previousFence && !previousFence.acknowledged) throw new Error("media recovery fence already exists");
  const dir = mediaDirectory();
  const journal = defaultMediaJournalPath();
  const fence: MediaRecoveryFence = {
    id: randomUUID(),
    revision: 0,
    acknowledged: false,
    restartRequired: true,
    createdAt: Date.now(),
    cause: inspection.cause as MediaRecoveryFence["cause"],
  };
  // An acknowledged fence has completed its restart boundary and may be
  // atomically superseded by a later, independently identified recovery.
  writeFence(fence, previousFence ?? undefined);
  const quarantine = join(dir, `quarantine-${fence.id}`);
  mkdirSync(quarantine, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(quarantine, 0o700);
  assertPrivateDirectory(quarantine);
  for (const base of [journal, `${journal}.recovery-owner.sqlite`]) {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const candidate = `${base}${suffix}`;
      if (!existsSync(candidate)) continue;
      assertPrivateFile(candidate);
      renameSync(candidate, join(quarantine, basename(candidate)));
    }
  }
  fsyncDirectory(quarantine);
  fsyncDirectory(dir);
  return fence;
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

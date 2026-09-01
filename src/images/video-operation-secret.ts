import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { hardenSecretPath } from "../lib/windows-secret-acl";

const VIDEO_REPLAY_SECRET_BYTES = 32;

export interface VideoReplaySecretReconcileOptions {
  journalPath: string;
  witnessFingerprint?: Uint8Array;
  hasRetryRecords: boolean;
  /** Fault-injection seam; production uses the required platform durability path. */
  fsyncDirectory?: (directory: string) => void;
}

export interface VideoReplaySecretReconcileResult {
  secret: Uint8Array;
  fingerprint: Uint8Array;
  witnessChanged: boolean;
}

export interface VideoReplaySecretLease {
  assertAvailable(): void;
  close(): void;
}

type SecretFileInspection =
  | { kind: "missing" }
  | { kind: "valid"; stats: Stats; secret: Uint8Array }
  | { kind: "replaceable_corrupt"; stats: Stats };

function secretError(message: string): Error {
  const error = new Error(message);
  error.name = "MediaJournalError";
  return error;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function secretPathForJournal(journalPath: string): string {
  return join(dirname(journalPath), `${basename(journalPath)}.video-replay-secret`);
}

function assertPrivateRegularFile(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw secretError("The private video replay secret file is unsafe.");
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || stats.uid !== uid || (stats.mode & 0o777) !== 0o600) {
      throw secretError("The private video replay secret file has unsafe ownership or permissions.");
    }
  }
}

function readStableSecret(path: string, expected: Stats): Uint8Array {
  let fd: number | undefined;
  try {
    const flags = process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
    fd = openSync(path, flags);
    const openedBefore = fstatSync(fd);
    assertPrivateRegularFile(openedBefore);
    if (!sameFile(expected, openedBefore) || openedBefore.size !== VIDEO_REPLAY_SECRET_BYTES) {
      throw secretError("The private video replay secret changed while opening.");
    }
    const bytes = readFileSync(fd);
    const openedAfter = fstatSync(fd);
    const pathAfter = lstatSync(path);
    assertPrivateRegularFile(openedAfter);
    assertPrivateRegularFile(pathAfter);
    if (bytes.byteLength !== VIDEO_REPLAY_SECRET_BYTES
      || !sameFile(openedBefore, openedAfter)
      || !sameFile(openedAfter, pathAfter)
      || openedBefore.size !== openedAfter.size) {
      throw secretError("The private video replay secret changed while reading.");
    }
    return new Uint8Array(bytes);
  } catch (error) {
    if (error instanceof Error && error.name === "MediaJournalError") throw error;
    throw secretError("The private video replay secret is unavailable.");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function inspectSecretFile(path: string): SecretFileInspection {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    throw secretError("The private video replay secret is unavailable.");
  }
  assertPrivateRegularFile(stats);
  if (process.platform === "win32") {
    try {
      if (!hardenSecretPath(path, { required: true, timeoutMemoKey: `${path}::video-replay` }).ok) {
        throw secretError("The private video replay secret file could not be secured.");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "MediaJournalError") throw error;
      throw secretError("The private video replay secret file could not be secured.");
    }
    const hardened = lstatSync(path);
    assertPrivateRegularFile(hardened);
    if (!sameFile(stats, hardened)) {
      throw secretError("The private video replay secret changed while securing.");
    }
    stats = hardened;
  }
  if (stats.size !== VIDEO_REPLAY_SECRET_BYTES) {
    return { kind: "replaceable_corrupt", stats };
  }
  return { kind: "valid", stats, secret: readStableSecret(path, stats) };
}

function readSecretFromDescriptor(fd: number): Uint8Array {
  const bytes = Buffer.alloc(VIDEO_REPLAY_SECRET_BYTES);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    if (read <= 0) throw secretError("The private video replay secret is unavailable.");
    offset += read;
  }
  return new Uint8Array(bytes);
}

function assertRetainedSecret(
  path: string,
  fd: number,
  identity: Stats,
  expectedSecret: Uint8Array,
): void {
  try {
    if (process.platform === "win32") {
      if (!hardenSecretPath(path, { required: true, timeoutMemoKey: `${path}::video-replay` }).ok) {
        throw secretError("The private video replay secret file could not be secured.");
      }
    }
    const descriptorBefore = fstatSync(fd);
    const pathBefore = lstatSync(path);
    assertPrivateRegularFile(descriptorBefore);
    assertPrivateRegularFile(pathBefore);
    if (
      !sameFile(identity, descriptorBefore)
      || !sameFile(descriptorBefore, pathBefore)
      || descriptorBefore.size !== VIDEO_REPLAY_SECRET_BYTES
    ) throw secretError("The private video replay secret changed while in use.");
    const observed = readSecretFromDescriptor(fd);
    const descriptorAfter = fstatSync(fd);
    const pathAfter = lstatSync(path);
    assertPrivateRegularFile(descriptorAfter);
    assertPrivateRegularFile(pathAfter);
    if (
      !sameFile(descriptorBefore, descriptorAfter)
      || !sameFile(descriptorAfter, pathAfter)
      || descriptorAfter.size !== VIDEO_REPLAY_SECRET_BYTES
      || observed.byteLength !== expectedSecret.byteLength
      || !timingSafeEqual(observed, expectedSecret)
    ) throw secretError("The private video replay secret changed while in use.");
  } catch (error) {
    if (error instanceof Error && error.name === "MediaJournalError") throw error;
    throw secretError("The private video replay secret is unavailable.");
  }
}

/** Retain and continuously validate the exact replay authority used by a live store. */
export function retainVideoOperationReplaySecret(
  journalPath: string,
  expectedSecret: Uint8Array,
): VideoReplaySecretLease {
  if (expectedSecret.byteLength !== VIDEO_REPLAY_SECRET_BYTES) {
    throw secretError("The private video replay secret is unavailable.");
  }
  const path = secretPathForJournal(journalPath);
  const inspected = inspectSecretFile(path);
  if (
    inspected.kind !== "valid"
    || inspected.secret.byteLength !== expectedSecret.byteLength
    || !timingSafeEqual(inspected.secret, expectedSecret)
  ) throw secretError("The private video replay secret changed before use.");
  let fd: number | undefined;
  try {
    const flags = process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
    fd = openSync(path, flags);
    const identity = fstatSync(fd);
    assertPrivateRegularFile(identity);
    if (!sameFile(inspected.stats, identity) || identity.size !== VIDEO_REPLAY_SECRET_BYTES) {
      throw secretError("The private video replay secret changed before use.");
    }
    let closed = false;
    const retainedFd = fd;
    fd = undefined;
    const lease: VideoReplaySecretLease = {
      assertAvailable() {
        if (closed) throw secretError("The private video replay secret lease is closed.");
        assertRetainedSecret(path, retainedFd, identity, expectedSecret);
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(retainedFd);
      },
    };
    lease.assertAvailable();
    return lease;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* mapped below */ }
    }
    if (error instanceof Error && error.name === "MediaJournalError") throw error;
    throw secretError("The private video replay secret is unavailable.");
  }
}

function fsyncDirectoryRequired(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    throw secretError("The private video replay secret directory could not be synchronized.");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function syncDirectory(directory: string, injected?: (directory: string) => void): void {
  if (injected) {
    try {
      injected(directory);
      return;
    } catch {
      throw secretError("The private video replay secret directory could not be synchronized.");
    }
  }
  if (process.platform !== "win32") fsyncDirectoryRequired(directory);
}

function proveSecretDurable(
  path: string,
  expected: Stats,
  injectedDirectorySync?: (directory: string) => void,
): Uint8Array {
  let fd: number | undefined;
  try {
    const flags = process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
    fd = openSync(path, flags);
    const opened = fstatSync(fd);
    assertPrivateRegularFile(opened);
    if (!sameFile(expected, opened) || opened.size !== VIDEO_REPLAY_SECRET_BYTES) {
      throw secretError("The private video replay secret changed before synchronization.");
    }
    fsyncSync(fd);
    const after = lstatSync(path);
    assertPrivateRegularFile(after);
    if (!sameFile(opened, after) || after.size !== VIDEO_REPLAY_SECRET_BYTES) {
      throw secretError("The private video replay secret changed during synchronization.");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "MediaJournalError") throw error;
    throw secretError("The private video replay secret file could not be synchronized.");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
  syncDirectory(dirname(path), injectedDirectorySync);
  const verified = inspectSecretFile(path);
  if (verified.kind !== "valid" || !sameFile(expected, verified.stats)) {
    throw secretError("The private video replay secret changed after synchronization.");
  }
  return verified.secret;
}

function createSecretDirect(
  path: string,
  injectedDirectorySync?: (directory: string) => void,
): Uint8Array {
  const secret = randomBytes(VIDEO_REPLAY_SECRET_BYTES);
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, secret);
    fsyncSync(fd);
    const written = fstatSync(fd);
    if (!written.isFile() || written.nlink !== 1 || written.size !== VIDEO_REPLAY_SECRET_BYTES) {
      throw secretError("The private video replay secret file was not written safely.");
    }
    closeSync(fd);
    fd = undefined;
    if (process.platform === "win32") {
      try {
        if (!hardenSecretPath(path, { required: true, timeoutMemoKey: `${path}::video-replay` }).ok) {
          throw secretError("The private video replay secret file could not be secured.");
        }
      } catch (error) {
        if (error instanceof Error && error.name === "MediaJournalError") throw error;
        throw secretError("The private video replay secret file could not be secured.");
      }
    } else {
      chmodSync(path, 0o600);
    }
    const published = lstatSync(path);
    assertPrivateRegularFile(published);
    return proveSecretDurable(path, published, injectedDirectorySync);
  } catch (error) {
    if (error instanceof Error && error.name === "MediaJournalError") throw error;
    throw secretError("The private video replay secret could not be created.");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function removeReplaceableCorruptSecret(
  path: string,
  expected: Stats,
  injectedDirectorySync?: (directory: string) => void,
): void {
  try {
    const current = lstatSync(path);
    assertPrivateRegularFile(current);
    if (!sameFile(expected, current)) {
      throw secretError("The private video replay secret changed before replacement.");
    }
    unlinkSync(path);
    syncDirectory(dirname(path), injectedDirectorySync);
  } catch (error) {
    if (error instanceof Error && error.name === "MediaJournalError") throw error;
    throw secretError("The private video replay secret could not be replaced safely.");
  }
}

export function fingerprintVideoOperationReplaySecret(secret: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(secret).digest());
}

export function equalVideoOperationReplayFingerprint(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/**
 * Reconcile the owner-only file with its no-secret journal witness. Callers must
 * hold the media journal owner lease and commit a changed witness only after this
 * function has returned successfully.
 */
export function reconcileVideoOperationReplaySecret(
  options: VideoReplaySecretReconcileOptions,
): VideoReplaySecretReconcileResult {
  const path = secretPathForJournal(options.journalPath);
  const witness = options.witnessFingerprint;
  if (witness && witness.byteLength !== 32) {
    throw secretError("The media replay authority witness is malformed.");
  }
  if (!witness && options.hasRetryRecords) {
    throw secretError("The media replay authority witness is missing while retry records remain.");
  }

  let inspected = inspectSecretFile(path);
  if (inspected.kind === "valid") {
    const fingerprint = fingerprintVideoOperationReplaySecret(inspected.secret);
    if (witness && equalVideoOperationReplayFingerprint(witness, fingerprint)) {
      return { secret: inspected.secret, fingerprint, witnessChanged: false };
    }
    if (options.hasRetryRecords) {
      throw secretError("The private video replay secret does not match retained retry records.");
    }
    const secret = proveSecretDurable(path, inspected.stats, options.fsyncDirectory);
    return {
      secret,
      fingerprint: fingerprintVideoOperationReplaySecret(secret),
      witnessChanged: true,
    };
  }

  if (options.hasRetryRecords) {
    throw secretError("The private video replay secret is unavailable while retry records remain.");
  }
  if (inspected.kind === "replaceable_corrupt") {
    removeReplaceableCorruptSecret(path, inspected.stats, options.fsyncDirectory);
    inspected = { kind: "missing" };
  }
  if (inspected.kind !== "missing") {
    throw secretError("The private video replay secret is unavailable.");
  }
  const secret = createSecretDirect(path, options.fsyncDirectory);
  return {
    secret,
    fingerprint: fingerprintVideoOperationReplaySecret(secret),
    witnessChanged: true,
  };
}

export function videoOperationReplaySecretPathForJournal(journalPath: string): string {
  return secretPathForJournal(journalPath);
}

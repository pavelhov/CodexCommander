import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType, type Library } from "bun:ffi";

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(png|jpe?g|webp|gif|mp4|webm)$/i;
const VIDEO_ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(mp4|webm)$/i;
const PRIVATE_VIDEO_TEMP_RE = /^\.ccx-video-[A-Za-z0-9._-]{1,200}\.tmp$/;
const MAX_VIDEO_ARTIFACT_BYTES = 200 * 1024 * 1024;

export interface ArtifactPinAuthority {
  protectedArtifactIds(): ReadonlySet<string>;
  /** Exact durable video reservations eligible for temp→final crash completion. */
  recoverablePublicationArtifactIds?(): ReadonlySet<string>;
  /** Exact expired reservations eligible for validated temp+final deletion. */
  expiredLinkedPublicationArtifactIds?(): ReadonlySet<string>;
  /** Non-mutating phase-one decision required before any owner may release a pin. */
  canReleaseArtifactForPrune?(artifactId: string): ArtifactPinPreflightResult;
  releaseArtifactForPrune?(artifactId: string): ArtifactPinReleaseResult;
  /** Durable prepare-delete rows which still retain their private artifact id. */
  pendingArtifactDeletionIds?(): ReadonlySet<string>;
  /** Clear one prepared artifact id only after unlink + directory fsync. */
  finalizeArtifactPrune?(artifactId: string): ArtifactPinFinalizeResult;
}

export type ArtifactPinPreflightResult = "releasable" | "protected" | "conflict" | "not_owned";
export type ArtifactPinReleaseResult = "released" | "protected" | "conflict" | "not_owned";
export type ArtifactPinFinalizeResult = "finalized" | "protected" | "conflict" | "not_owned";

export interface ArtifactRetentionIo {
  /** Test-only race seam invoked before the final anchored identity check. */
  beforeUnlinkFile?: (dir: string, name: string) => void;
  /** Test-only fault seam. Production uses unlinkSync. */
  unlinkFile?: (path: string) => void;
  /** Test-only rollback seam for failed linked-publication directory sync. */
  linkFile?: (existingPath: string, newPath: string) => void;
  /** Test-only fault seam. Production fsyncs POSIX directories and is a no-op on Windows. */
  syncDirectory?: (dir: string) => boolean;
}

export interface ArtifactRetentionOptions {
  dir: string;
  maxFiles: number;
  protectedArtifactIds?: ReadonlySet<string>;
  /** Operation-local durable owners, combined with live registered owners by identity. */
  pinAuthorities?: readonly ArtifactPinAuthority[];
  onArtifactPruned?: (artifactId: string) => void;
  staleTempAgeMs?: number;
  /** Maximum unlinked stale private video temps removed by one pass. */
  maxStaleTemps?: number;
  now?: number;
  io?: ArtifactRetentionIo;
}

export interface ArtifactRetentionResult {
  prunedArtifactIds: string[];
  removedStaleTemps: string[];
  blocked: boolean;
}

const registeredPinAuthorities = new Set<ArtifactPinAuthority>();

/**
 * Register one live durable pin authority. The returned disposer is idempotent.
 * Image-only prune callers automatically consult every registered video store.
 */
export function registerArtifactPinAuthority(authority: ArtifactPinAuthority): () => void {
  registeredPinAuthorities.add(authority);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    registeredPinAuthorities.delete(authority);
  };
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateArtifactDirectory(stats: Stats): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.nlink < 1) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o777) === 0o700;
}

const POSIX_DIRECTORY_FUNCTIONS = {
  openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  linkat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.i32],
    returns: FFIType.i32,
  },
} as const;

type PosixDirectoryLibrary = Library<typeof POSIX_DIRECTORY_FUNCTIONS>;
type PosixDirectorySymbols = PosixDirectoryLibrary["symbols"];
let posixDirectoryLibrary: PosixDirectoryLibrary | null | undefined;

function posixDirectorySymbols(): PosixDirectorySymbols | null {
  if (posixDirectoryLibrary !== undefined) return posixDirectoryLibrary?.symbols ?? null;
  if (process.platform !== "darwin" && process.platform !== "linux") {
    posixDirectoryLibrary = null;
    return null;
  }
  const candidates = process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", "libc.so"];
  for (const candidate of candidates) {
    try {
      posixDirectoryLibrary = dlopen(candidate, POSIX_DIRECTORY_FUNCTIONS);
      return posixDirectoryLibrary.symbols;
    } catch {
      // Try the next platform libc name; path validation still protects fallback operations.
    }
  }
  posixDirectoryLibrary = null;
  return null;
}

function cEntryName(name: string): Buffer {
  return Buffer.from(`${name}\0`);
}

function safeArtifactEntryName(name: string): boolean {
  return ARTIFACT_ID_RE.test(name) || PRIVATE_VIDEO_TEMP_RE.test(name);
}

interface ArtifactDirectoryAnchor {
  readonly dir: string;
  readonly fd: number;
  readonly identity: Stats;
  readonly posix: PosixDirectorySymbols | null;
}

function artifactDirectoryMatches(anchor: ArtifactDirectoryAnchor): boolean {
  try {
    const opened = fstatSync(anchor.fd);
    const current = lstatSync(anchor.dir);
    return privateArtifactDirectory(opened)
      && privateArtifactDirectory(current)
      && sameIdentity(anchor.identity, opened)
      && sameIdentity(opened, current);
  } catch {
    return false;
  }
}

function openArtifactDirectory(dir: string): ArtifactDirectoryAnchor | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(dir);
    if (!privateArtifactDirectory(before)) return null;
    fd = openSync(
      dir,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(fd);
    const after = lstatSync(dir);
    if (
      !privateArtifactDirectory(opened)
      || !privateArtifactDirectory(after)
      || !sameIdentity(before, opened)
      || !sameIdentity(opened, after)
    ) {
      closeSync(fd);
      return null;
    }
    return { dir, fd, identity: opened, posix: posixDirectorySymbols() };
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* opening already failed closed */ }
    }
    return null;
  }
}

function closeArtifactDirectory(anchor: ArtifactDirectoryAnchor): void {
  try { closeSync(anchor.fd); } catch { /* pass is already complete */ }
}

interface AnchoredFile {
  readonly fd: number;
  readonly stats: Stats;
}

function openAnchoredFile(anchor: ArtifactDirectoryAnchor, name: string): AnchoredFile | null {
  if (!safeArtifactEntryName(name)) return null;
  if (!artifactDirectoryMatches(anchor)) return null;
  let fd: number | undefined;
  try {
    if (anchor.posix) {
      fd = anchor.posix.openat(
        anchor.fd,
        cEntryName(name),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      if (fd < 0) return null;
      const stats = fstatSync(fd);
      if (!artifactDirectoryMatches(anchor)) {
        closeSync(fd);
        return null;
      }
      return { fd, stats };
    }

    const path = join(anchor.dir, name);
    const before = lstatSync(path);
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(fd);
    const after = lstatSync(path);
    if (!sameIdentity(before, stats) || !sameIdentity(stats, after) || !artifactDirectoryMatches(anchor)) {
      closeSync(fd);
      return null;
    }
    return { fd, stats };
  } catch {
    if (fd !== undefined && fd >= 0) {
      try { closeSync(fd); } catch { /* failed closed */ }
    }
    return null;
  }
}

function closeAnchoredFile(file: AnchoredFile): void {
  try { closeSync(file.fd); } catch { /* validation is already complete */ }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function anchoredNameIsAbsent(anchor: ArtifactDirectoryAnchor, name: string): boolean {
  if (!safeArtifactEntryName(name)) return false;
  if (!artifactDirectoryMatches(anchor)) return false;
  try {
    lstatSync(join(anchor.dir, name));
    return false;
  } catch (error) {
    return errorCode(error) === "ENOENT" && artifactDirectoryMatches(anchor);
  }
}

function unlinkAnchoredName(
  anchor: ArtifactDirectoryAnchor,
  name: string,
  io: ArtifactRetentionIo,
  expected: Stats,
): boolean {
  if (!safeArtifactEntryName(name)) return false;
  try { io.beforeUnlinkFile?.(anchor.dir, name); } catch { return false; }
  if (!artifactDirectoryMatches(anchor)) return false;
  const current = openAnchoredFile(anchor, name);
  if (!current) return false;
  try {
    if (!sameIdentity(expected, current.stats)) return false;
  } finally {
    closeAnchoredFile(current);
  }
  if (!artifactDirectoryMatches(anchor)) return false;
  try {
    if (io.unlinkFile) {
      io.unlinkFile(join(anchor.dir, name));
    } else if (anchor.posix) {
      if (anchor.posix.unlinkat(anchor.fd, cEntryName(name), 0) !== 0) return false;
    } else {
      const path = join(anchor.dir, name);
      const before = lstatSync(path);
      if (!sameIdentity(expected, before) || !artifactDirectoryMatches(anchor)) return false;
      unlinkSync(path);
    }
    return artifactDirectoryMatches(anchor);
  } catch {
    return false;
  }
}

function syncAnchoredDirectory(anchor: ArtifactDirectoryAnchor, io: ArtifactRetentionIo): boolean {
  if (!artifactDirectoryMatches(anchor)) return false;
  try {
    const synced = io.syncDirectory ? io.syncDirectory(anchor.dir) : (() => {
      if (process.platform !== "win32") fsyncSync(anchor.fd);
      return true;
    })();
    return synced && artifactDirectoryMatches(anchor);
  } catch {
    return false;
  }
}

function linkAnchoredNames(
  anchor: ArtifactDirectoryAnchor,
  existingName: string,
  newName: string,
  io: ArtifactRetentionIo,
): boolean {
  if (!safeArtifactEntryName(existingName) || !safeArtifactEntryName(newName)) return false;
  if (!artifactDirectoryMatches(anchor)) return false;
  try {
    if (io.linkFile) {
      io.linkFile(join(anchor.dir, existingName), join(anchor.dir, newName));
    } else if (anchor.posix) {
      if (anchor.posix.linkat(anchor.fd, cEntryName(existingName), anchor.fd, cEntryName(newName), 0) !== 0) {
        return false;
      }
    } else {
      linkSync(join(anchor.dir, existingName), join(anchor.dir, newName));
    }
    return artifactDirectoryMatches(anchor);
  } catch {
    return false;
  }
}

function safeRegularFile(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
}

function privateUnlinkedVideoTemp(stats: Stats): boolean {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1
    || stats.size < 0
    || stats.size > MAX_VIDEO_ARTIFACT_BYTES
  ) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o777) === 0o600;
}

function privateLinkedVideoFile(stats: Stats): boolean {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 2
    || stats.size < 12
    || stats.size > MAX_VIDEO_ARTIFACT_BYTES
  ) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o777) === 0o600;
}

function videoMagicMatches(id: string, header: Uint8Array): boolean {
  const signature = Buffer.from(header).toString("latin1");
  if (id.toLowerCase().endsWith(".mp4")) return signature.slice(4, 8) === "ftyp";
  if (id.toLowerCase().endsWith(".webm")) return signature.startsWith("\x1a\x45\xdf\xa3");
  return false;
}

/**
 * Prove the exact crash state emitted by video publication. Generic artifact-looking hard links
 * are never completed: the final must be a durable runtime-owned video reservation, the only
 * other link to the private temp inode, and contain bounded magic matching its extension.
 */
function linkedPublishedVideoArtifact(
  anchor: ArtifactDirectoryAnchor,
  names: readonly string[],
  temp: Stats,
  durableArtifactIds: ReadonlySet<string>,
): string | null {
  if (!privateLinkedVideoFile(temp)) return null;
  let match: string | null = null;
  for (const name of names) {
    if (!VIDEO_ARTIFACT_ID_RE.test(name) || !durableArtifactIds.has(name)) continue;
    const candidate = openAnchoredFile(anchor, name);
    if (!candidate) continue;
    try {
      if (!privateLinkedVideoFile(candidate.stats) || !sameIdentity(temp, candidate.stats)) continue;
      if (match !== null) return null;
      match = name;
    } finally {
      closeAnchoredFile(candidate);
    }
  }
  if (match === null) return null;

  const final = openAnchoredFile(anchor, match);
  if (!final) return null;
  try {
    if (
      !privateLinkedVideoFile(final.stats)
      || !sameIdentity(temp, final.stats)
    ) return null;
    const header = Buffer.alloc(12);
    if (readSync(final.fd, header, 0, header.length, 0) !== header.length || !videoMagicMatches(match, header)) {
      return null;
    }
    return match;
  } finally {
    closeAnchoredFile(final);
  }
}

interface ExpiredLinkedPublication {
  readonly artifactId: string;
  readonly artifactStats: Stats;
  readonly tempName: string;
  readonly tempStats: Stats;
}

/** Prove the exact private two-name publication shape for one expired reservation. */
function expiredLinkedPublication(
  anchor: ArtifactDirectoryAnchor,
  names: readonly string[],
  artifactId: string,
): ExpiredLinkedPublication | null {
  if (!VIDEO_ARTIFACT_ID_RE.test(artifactId)) return null;
  const final = openAnchoredFile(anchor, artifactId);
  if (!final) return null;
  try {
    if (!privateLinkedVideoFile(final.stats)) return null;
    const header = Buffer.alloc(12);
    if (
      readSync(final.fd, header, 0, header.length, 0) !== header.length
      || !videoMagicMatches(artifactId, header)
    ) return null;

    let match: { name: string; stats: Stats } | null = null;
    for (const name of names) {
      if (!PRIVATE_VIDEO_TEMP_RE.test(name)) continue;
      const temp = openAnchoredFile(anchor, name);
      if (!temp) continue;
      try {
        if (!privateLinkedVideoFile(temp.stats) || !sameIdentity(final.stats, temp.stats)) continue;
        if (match !== null) return null;
        match = { name, stats: temp.stats };
      } finally {
        closeAnchoredFile(temp);
      }
    }
    return match ? {
      artifactId,
      artifactStats: final.stats,
      tempName: match.name,
      tempStats: match.stats,
    } : null;
  } finally {
    closeAnchoredFile(final);
  }
}

function retentionAuthorities(explicit: readonly ArtifactPinAuthority[] = []): ArtifactPinAuthority[] {
  return [...new Set<ArtifactPinAuthority>([...registeredPinAuthorities, ...explicit])];
}

interface ArtifactAuthoritySnapshot {
  protectedIds: ReadonlySet<string>;
  recoverablePublicationIds: ReadonlySet<string>;
  expiredLinkedPublicationIds: ReadonlySet<string>;
  pendingDeletionIds: ReadonlySet<string>;
}

function collectAuthoritySnapshot(authorities: readonly ArtifactPinAuthority[]): ArtifactAuthoritySnapshot | null {
  const protectedIds = new Set<string>();
  const recoverablePublicationIds = new Set<string>();
  const expiredLinkedPublicationIds = new Set<string>();
  const pendingDeletionIds = new Set<string>();
  try {
    for (const authority of authorities) {
      const owned = authority.protectedArtifactIds();
      for (const id of owned) protectedIds.add(id);
      const ownedPendingDeletionIds = authority.pendingArtifactDeletionIds?.() ?? new Set<string>();
      for (const id of ownedPendingDeletionIds) pendingDeletionIds.add(id);
      if (authority.recoverablePublicationArtifactIds) {
        // Recovery authority is narrower than retention authority by construction:
        // an id must be durable in the same owner snapshot to authorize publication.
        for (const id of authority.recoverablePublicationArtifactIds()) {
          if (owned.has(id)) recoverablePublicationIds.add(id);
        }
      }
      if (authority.expiredLinkedPublicationArtifactIds) {
        // Expiry cleanup is authorized only by the same owner that retained the
        // durable pending-deletion id; unrelated authorities cannot compose it.
        for (const id of authority.expiredLinkedPublicationArtifactIds()) {
          if (ownedPendingDeletionIds.has(id)) expiredLinkedPublicationIds.add(id);
        }
      }
    }
    return { protectedIds, recoverablePublicationIds, expiredLinkedPublicationIds, pendingDeletionIds };
  } catch {
    // A corrupt/closed/future journal must fail retention closed. Deleting while
    // the durable pin snapshot is unavailable could strand completed jobs.
    return null;
  }
}

interface ArtifactReleaseBatch {
  finalizers: Array<(artifactId: string) => ArtifactPinFinalizeResult>;
}

function releasePins(artifactId: string, authorities: readonly ArtifactPinAuthority[]): ArtifactReleaseBatch | null {
  try {
    const owners = authorities
      .filter(authority => authority.protectedArtifactIds().has(artifactId));
    const releases: Array<(artifactId: string) => ArtifactPinReleaseResult> = [];
    const finalizers: Array<(artifactId: string) => ArtifactPinFinalizeResult> = [];
    // Phase one is strictly read-only. A transient owner without an explicit
    // release preflight is a hard pin, so no durable owner can be tombstoned
    // before a later authority vetoes deletion.
    for (const authority of owners) {
      const preflight = authority.canReleaseArtifactForPrune;
      const release = authority.releaseArtifactForPrune;
      const finalize = authority.finalizeArtifactPrune;
      if (!preflight || !release || !finalize) return null;
      if (preflight.call(authority, artifactId) !== "releasable") return null;
      releases.push(id => release.call(authority, id));
      finalizers.push(id => finalize.call(authority, id));
    }
    // No JS authority registration/removal can interleave with this synchronous
    // phase. Durable releases still recheck their own CAS state.
    for (const release of releases) {
      const result = release(artifactId);
      if (result !== "released" && result !== "not_owned") return null;
    }
    return authorities.every(authority => !authority.protectedArtifactIds().has(artifactId))
      ? { finalizers }
      : null;
  } catch {
    return null;
  }
}

function unlinkMediaArtifactFromAnchor(
  anchor: ArtifactDirectoryAnchor,
  artifactId: string,
  io: ArtifactRetentionIo,
  expected?: Stats,
): boolean {
  if (!ARTIFACT_ID_RE.test(artifactId)) return false;
  const opened = openAnchoredFile(anchor, artifactId);
  if (!opened) {
    // A retry after unlink-before-fsync must durably confirm the absent name
    // before any journal finalizer is allowed to clear pending delete work.
    return expected === undefined
      && anchoredNameIsAbsent(anchor, artifactId)
      && syncAnchoredDirectory(anchor, io);
  }
  try {
    if (!safeRegularFile(opened.stats)) return false;
    if (expected && !sameIdentity(expected, opened.stats)) return false;
    return unlinkAnchoredName(anchor, artifactId, io, opened.stats)
      && syncAnchoredDirectory(anchor, io);
  } finally {
    closeAnchoredFile(opened);
  }
}

function unlinkExpiredLinkedPublicationDurably(
  anchor: ArtifactDirectoryAnchor,
  publication: ExpiredLinkedPublication,
  io: ArtifactRetentionIo,
): boolean {
  // Remove the private temp first. If the second unlink fails, the remaining
  // final becomes an ordinary single-link pending deletion on the next pass.
  if (!unlinkAnchoredName(anchor, publication.tempName, io, publication.tempStats)) return false;
  if (!unlinkAnchoredName(anchor, publication.artifactId, io, publication.artifactStats)) return false;
  return syncAnchoredDirectory(anchor, io);
}

/**
 * An expired linked-publication reservation may fall back to the ordinary
 * pending-delete path only when its final is a proven single-link file, or
 * when both publication names are already absent. If the final disappeared
 * while any private publication temp was present in this pass's stable
 * directory snapshot, its inode can no longer be associated with the
 * reservation; retain the journal obligation instead of orphaning bytes.
 */
function canDeleteExpiredPublicationAsOrdinaryArtifact(
  anchor: ArtifactDirectoryAnchor,
  names: readonly string[],
  artifactId: string,
): boolean {
  const final = openAnchoredFile(anchor, artifactId);
  if (final) {
    try {
      return safeRegularFile(final.stats);
    } finally {
      closeAnchoredFile(final);
    }
  }
  if (!anchoredNameIsAbsent(anchor, artifactId)) return false;
  return !names.some(name => PRIVATE_VIDEO_TEMP_RE.test(name));
}

/** Exact unlink whose success includes durable containing-directory metadata. */
export function unlinkMediaArtifactDurably(
  dir: string,
  artifactId: string,
  io: ArtifactRetentionIo = {},
  expected?: Stats,
): boolean {
  if (!ARTIFACT_ID_RE.test(artifactId)) return false;
  const anchor = openArtifactDirectory(dir);
  if (!anchor) return false;
  try {
    return unlinkMediaArtifactFromAnchor(anchor, artifactId, io, expected);
  } finally {
    closeArtifactDirectory(anchor);
  }
}

function finalizeArtifactPrune(batch: ArtifactReleaseBatch, artifactId: string): boolean {
  try {
    for (const finalize of batch.finalizers) {
      const result = finalize(artifactId);
      if (result !== "finalized" && result !== "not_owned") return false;
    }
    return true;
  } catch {
    return false;
  }
}

function pendingDeletionBatch(
  artifactId: string,
  authorities: readonly ArtifactPinAuthority[],
): ArtifactReleaseBatch | null {
  try {
    const owners = authorities.filter(authority => authority.pendingArtifactDeletionIds?.().has(artifactId));
    if (owners.length === 0) return null;
    const finalizers: ArtifactReleaseBatch["finalizers"] = [];
    for (const authority of owners) {
      const finalize = authority.finalizeArtifactPrune;
      if (!finalize) return null;
      finalizers.push(id => finalize.call(authority, id));
    }
    return { finalizers };
  } catch {
    return null;
  }
}

/** Delete one exact opaque artifact only after every registered durable pin is released. */
export function removeMediaArtifact(dir: string, artifactId: string, io: ArtifactRetentionIo = {}): boolean {
  if (!ARTIFACT_ID_RE.test(artifactId)) return false;
  const anchor = openArtifactDirectory(dir);
  if (!anchor) return false;
  try {
    const authorities = retentionAuthorities();
    const snapshot = collectAuthoritySnapshot(authorities);
    if (!snapshot || !artifactDirectoryMatches(anchor)) return false;
    const existingPending = pendingDeletionBatch(artifactId, authorities);
    if (existingPending) {
      if (snapshot.protectedIds.has(artifactId)) return false;
      return unlinkMediaArtifactFromAnchor(anchor, artifactId, io)
        && finalizeArtifactPrune(existingPending, artifactId);
    }
    const released = releasePins(artifactId, authorities);
    if (!released) return false;
    return unlinkMediaArtifactFromAnchor(anchor, artifactId, io)
      && finalizeArtifactPrune(released, artifactId);
  } finally {
    closeArtifactDirectory(anchor);
  }
}

/**
 * Single image/video retention coordinator. It never follows links, rechecks
 * identity immediately before unlink, preserves all durable pins, and reports
 * every deliberate artifact deletion to the caller.
 */
export function pruneMediaArtifacts(options: ArtifactRetentionOptions): ArtifactRetentionResult {
  const result: ArtifactRetentionResult = {
    prunedArtifactIds: [],
    removedStaleTemps: [],
    blocked: false,
  };
  if (!Number.isSafeInteger(options.maxFiles)) return result;
  const anchor = openArtifactDirectory(options.dir);
  if (!anchor) return { ...result, blocked: true };
  const io = options.io ?? {};
  const finish = (): ArtifactRetentionResult => {
    if (!artifactDirectoryMatches(anchor)) result.blocked = true;
    return result;
  };
  try {
    const countPruningEnabled = options.maxFiles > 0;
    const authorities = retentionAuthorities(options.pinAuthorities);
    const authoritySnapshot = collectAuthoritySnapshot(authorities);
    if (!authoritySnapshot || !artifactDirectoryMatches(anchor)) {
      result.blocked = true;
      return result;
    }

    let names: string[];
    try {
      if (!artifactDirectoryMatches(anchor)) throw new Error("artifact directory identity changed");
      names = readdirSync(options.dir);
      if (!artifactDirectoryMatches(anchor)) throw new Error("artifact directory identity changed");
    } catch {
      result.blocked = true;
      return result;
    }

    const explicitProtectedIds = options.protectedArtifactIds ?? new Set<string>();
    // Retry durable prepare-delete rows before ordinary count pruning, including
    // confirmed-absent names left by unlink-before-fsync crashes.
    let pendingDeletionBlocked = false;
    for (const artifactId of authoritySnapshot.pendingDeletionIds) {
      if (explicitProtectedIds.has(artifactId) || authoritySnapshot.protectedIds.has(artifactId)) {
        pendingDeletionBlocked = true;
        continue;
      }
      const batch = pendingDeletionBatch(artifactId, authorities);
      const isExpiredLinkedPublication = authoritySnapshot.expiredLinkedPublicationIds.has(artifactId);
      const expiredPublication = isExpiredLinkedPublication
        ? expiredLinkedPublication(anchor, names, artifactId)
        : null;
      const deleted = expiredPublication
        ? unlinkExpiredLinkedPublicationDurably(anchor, expiredPublication, io)
        : !isExpiredLinkedPublication
          || canDeleteExpiredPublicationAsOrdinaryArtifact(anchor, names, artifactId)
          ? unlinkMediaArtifactFromAnchor(anchor, artifactId, io)
          : false;
      if (!batch || !deleted) {
        pendingDeletionBlocked = true;
        continue;
      }
      if (!finalizeArtifactPrune(batch, artifactId)) {
        pendingDeletionBlocked = true;
        continue;
      }
      result.prunedArtifactIds.push(artifactId);
      try { options.onArtifactPruned?.(artifactId); } catch { /* durable deletion remains authoritative */ }
    }

    // Complete only exact active/recoverable temp+final publications. The final
    // remains pinned and only the redundant private temp name is removed.
    for (const name of names) {
      if (!PRIVATE_VIDEO_TEMP_RE.test(name)) continue;
      const observed = openAnchoredFile(anchor, name);
      if (!observed) continue;
      let linkedFinal: string | null;
      try {
        linkedFinal = linkedPublishedVideoArtifact(
          anchor,
          names,
          observed.stats,
          authoritySnapshot.recoverablePublicationIds,
        );
        if (linkedFinal === null) continue;
        if (!unlinkAnchoredName(anchor, name, io, observed.stats)) continue;
      } finally {
        closeAnchoredFile(observed);
      }
      if (!syncAnchoredDirectory(anchor, io)) {
        // Restore the fail-closed two-link shape when directory durability could
        // not be confirmed. Runtime adoption independently validates and syncs.
        linkAnchoredNames(anchor, linkedFinal, name, io);
        continue;
      }
      result.removedStaleTemps.push(name);
    }

    const now = options.now ?? Date.now();
    const staleTempAgeMs = options.staleTempAgeMs;
    const maxStaleTemps = options.maxStaleTemps ?? 32;
    const cleanStalePartial = staleTempAgeMs !== undefined
      && Number.isSafeInteger(staleTempAgeMs)
      && staleTempAgeMs >= 0
      && Number.isSafeInteger(maxStaleTemps)
      && maxStaleTemps > 0;
    if (cleanStalePartial) {
      const staleTemps: Array<{ name: string; stats: Stats }> = [];
      for (const name of names) {
        if (!PRIVATE_VIDEO_TEMP_RE.test(name)) continue;
        const opened = openAnchoredFile(anchor, name);
        if (!opened) continue;
        try {
          if (
            privateUnlinkedVideoTemp(opened.stats)
            && Number.isFinite(opened.stats.mtimeMs)
            && now - opened.stats.mtimeMs >= staleTempAgeMs
          ) staleTemps.push({ name, stats: opened.stats });
        } finally {
          closeAnchoredFile(opened);
        }
      }
      staleTemps.sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs || a.name.localeCompare(b.name));
      for (const temp of staleTemps.slice(0, maxStaleTemps)) {
        if (!unlinkAnchoredName(anchor, temp.name, io, temp.stats)) continue;
        if (!syncAnchoredDirectory(anchor, io)) continue;
        result.removedStaleTemps.push(temp.name);
      }
    }

    // A non-positive cap disables count pruning, not validated publication or
    // bounded stale-private-temp recovery.
    if (!countPruningEnabled || pendingDeletionBlocked) return finish();

    const artifacts: Array<{ name: string; stats: Stats }> = [];
    for (const name of names) {
      if (!ARTIFACT_ID_RE.test(name)) continue;
      if (authoritySnapshot.pendingDeletionIds.has(name)) continue;
      const opened = openAnchoredFile(anchor, name);
      if (!opened) continue;
      try {
        if (safeRegularFile(opened.stats)) artifacts.push({ name, stats: opened.stats });
      } finally {
        closeAnchoredFile(opened);
      }
    }
    if (artifacts.length <= options.maxFiles) return finish();

    artifacts.sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs || a.name.localeCompare(b.name));
    let retained = artifacts.length;
    for (const artifact of artifacts) {
      if (retained <= options.maxFiles) break;
      if (explicitProtectedIds.has(artifact.name)) continue;
      if (!artifactDirectoryMatches(anchor)) {
        result.blocked = true;
        break;
      }
      const released = releasePins(artifact.name, authorities);
      if (!released) continue;
      // Once prepare-delete is durable, a failed unlink/sync must not make a
      // newer artifact pay the same cap debt. The pending row owns the retry.
      if (!unlinkMediaArtifactFromAnchor(anchor, artifact.name, io, artifact.stats)) break;
      if (!finalizeArtifactPrune(released, artifact.name)) break;
      retained -= 1;
      result.prunedArtifactIds.push(artifact.name);
      try { options.onArtifactPruned?.(artifact.name); } catch { /* deletion remains authoritative */ }
    }
    return finish();
  } finally {
    closeArtifactDirectory(anchor);
  }
}

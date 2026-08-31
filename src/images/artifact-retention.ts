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

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(png|jpe?g|webp|gif|mp4|webm)$/i;
const VIDEO_ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(mp4|webm)$/i;
const PRIVATE_VIDEO_TEMP_RE = /^\.ccx-video-[A-Za-z0-9._-]{1,200}\.tmp$/;
const MAX_VIDEO_ARTIFACT_BYTES = 200 * 1024 * 1024;

export interface ArtifactPinAuthority {
  protectedArtifactIds(): ReadonlySet<string>;
  /** Exact durable video reservations eligible for temp→final crash completion. */
  recoverablePublicationArtifactIds?(): ReadonlySet<string>;
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

function safeRegularFile(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
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
  dir: string,
  names: readonly string[],
  temp: Stats,
  durableArtifactIds: ReadonlySet<string>,
): string | null {
  if (!privateLinkedVideoFile(temp)) return null;
  let match: string | null = null;
  for (const name of names) {
    if (!VIDEO_ARTIFACT_ID_RE.test(name) || !durableArtifactIds.has(name)) continue;
    try {
      const candidate = lstatSync(join(dir, name));
      if (!privateLinkedVideoFile(candidate) || !sameIdentity(temp, candidate)) continue;
      if (match !== null) return null;
      match = name;
    } catch {
      // Racing candidates do not prove a recoverable publication link.
    }
  }
  if (match === null) return null;

  const finalPath = join(dir, match);
  let fd: number | undefined;
  try {
    fd = openSync(finalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    const finalCurrent = lstatSync(finalPath);
    if (
      !privateLinkedVideoFile(opened)
      || !privateLinkedVideoFile(finalCurrent)
      || !sameIdentity(temp, opened)
      || !sameIdentity(opened, finalCurrent)
    ) return null;
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || !videoMagicMatches(match, header)) {
      return null;
    }
    return match;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function retentionAuthorities(explicit: readonly ArtifactPinAuthority[] = []): ArtifactPinAuthority[] {
  return [...new Set<ArtifactPinAuthority>([...registeredPinAuthorities, ...explicit])];
}

interface ArtifactAuthoritySnapshot {
  protectedIds: ReadonlySet<string>;
  recoverablePublicationIds: ReadonlySet<string>;
  pendingDeletionIds: ReadonlySet<string>;
}

function collectAuthoritySnapshot(authorities: readonly ArtifactPinAuthority[]): ArtifactAuthoritySnapshot | null {
  const protectedIds = new Set<string>();
  const recoverablePublicationIds = new Set<string>();
  const pendingDeletionIds = new Set<string>();
  try {
    for (const authority of authorities) {
      const owned = authority.protectedArtifactIds();
      for (const id of owned) protectedIds.add(id);
      if (authority.recoverablePublicationArtifactIds) {
        // Recovery authority is narrower than retention authority by construction:
        // an id must be durable in the same owner snapshot to authorize publication.
        for (const id of authority.recoverablePublicationArtifactIds()) {
          if (owned.has(id)) recoverablePublicationIds.add(id);
        }
      }
      for (const id of authority.pendingArtifactDeletionIds?.() ?? []) pendingDeletionIds.add(id);
    }
    return { protectedIds, recoverablePublicationIds, pendingDeletionIds };
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

function defaultSyncDirectory(dir: string): boolean {
  if (process.platform === "win32") return true;
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Exact unlink whose success includes durable containing-directory metadata. */
export function unlinkMediaArtifactDurably(
  dir: string,
  artifactId: string,
  io: ArtifactRetentionIo = {},
  expected?: Stats,
): boolean {
  if (!ARTIFACT_ID_RE.test(artifactId)) return false;
  const path = join(dir, artifactId);
  const syncDirectory = io.syncDirectory ?? defaultSyncDirectory;
  try {
    const observed = lstatSync(path);
    if (!safeRegularFile(observed)) return false;
    if (expected && !sameIdentity(expected, observed)) return false;
    const current = lstatSync(path);
    if (!safeRegularFile(current) || !sameIdentity(observed, current)) return false;
    (io.unlinkFile ?? unlinkSync)(path);
    return syncDirectory(dir);
  } catch (error) {
    // A retry after unlink-before-fsync must durably confirm the absent name
    // before any journal finalizer is allowed to clear pending delete work.
    if (!expected && errorCode(error) === "ENOENT") return syncDirectory(dir);
    return false;
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
  const authorities = retentionAuthorities();
  const snapshot = collectAuthoritySnapshot(authorities);
  if (!snapshot) return false;
  const existingPending = pendingDeletionBatch(artifactId, authorities);
  if (existingPending) {
    if (snapshot.protectedIds.has(artifactId)) return false;
    return unlinkMediaArtifactDurably(dir, artifactId, io)
      && finalizeArtifactPrune(existingPending, artifactId);
  }
  const released = releasePins(artifactId, authorities);
  if (!released) return false;
  return unlinkMediaArtifactDurably(dir, artifactId, io)
    && finalizeArtifactPrune(released, artifactId);
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

  const countPruningEnabled = options.maxFiles > 0;
  const authorities = retentionAuthorities(options.pinAuthorities);
  const authoritySnapshot = collectAuthoritySnapshot(authorities);
  if (!authoritySnapshot) {
    return { ...result, blocked: true };
  }

  let names: string[];
  try {
    names = readdirSync(options.dir);
  } catch {
    return { ...result, blocked: true };
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
    if (!batch || !unlinkMediaArtifactDurably(options.dir, artifactId, options.io)) {
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

  const now = options.now ?? Date.now();
  const staleTempAgeMs = options.staleTempAgeMs;
  const cleanStalePartial = staleTempAgeMs !== undefined
    && Number.isSafeInteger(staleTempAgeMs)
    && staleTempAgeMs >= 0;
  for (const name of names) {
    if (!PRIVATE_VIDEO_TEMP_RE.test(name)) continue;
    const path = join(options.dir, name);
    try {
      const observed = lstatSync(path);
      const linkedFinal = linkedPublishedVideoArtifact(
        options.dir,
        names,
        observed,
        authoritySnapshot.recoverablePublicationIds,
      );
      const stalePartial = cleanStalePartial
        && safeRegularFile(observed)
        && now - observed.mtimeMs >= staleTempAgeMs;
      // Only a durable exact reservation plus private validated video bytes proves
      // publication. Removing that temp is completion, not count retention.
      if (linkedFinal === null && !stalePartial) continue;
      const current = lstatSync(path);
      if (!sameIdentity(observed, current)) continue;
      const currentLinkedFinal = linkedPublishedVideoArtifact(
        options.dir,
        names,
        current,
        authoritySnapshot.recoverablePublicationIds,
      );
      if (linkedFinal !== null ? currentLinkedFinal !== linkedFinal : !safeRegularFile(current)) continue;
      unlinkSync(path);
      let directorySynced = false;
      try {
        directorySynced = (options.io?.syncDirectory ?? defaultSyncDirectory)(options.dir);
      } catch { /* handled as an unconfirmed unlink below */ }
      if (!directorySynced) {
        // Restore the fail-closed two-link shape when directory durability could
        // not be confirmed. Runtime adoption will retry validation + fsync.
        if (linkedFinal !== null) {
          try {
            (options.io?.linkFile ?? linkSync)(join(options.dir, linkedFinal), path);
          } catch { /* adoption must independently fsync before it may complete */ }
        }
        continue;
      }
      result.removedStaleTemps.push(name);
    } catch {
      // Partial/crash cleanup is best effort and never widens artifact pruning.
    }
  }

  // A non-positive cap disables count pruning, not validated recovery of a
  // durable runtime-owned video reservation.
  if (!countPruningEnabled || pendingDeletionBlocked) return result;

  // Pending delete work is retried above and never re-enters release preparation.

  const artifacts: Array<{ name: string; path: string; stats: Stats }> = [];
  for (const name of names) {
    if (!ARTIFACT_ID_RE.test(name)) continue;
    if (authoritySnapshot.pendingDeletionIds.has(name)) continue;
    const path = join(options.dir, name);
    try {
      const stats = lstatSync(path);
      if (!safeRegularFile(stats)) continue;
      artifacts.push({ name, path, stats });
    } catch {
      // An entry racing with publication/removal is simply not a prune candidate.
    }
  }
  if (artifacts.length <= options.maxFiles) return result;

  artifacts.sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs || a.name.localeCompare(b.name));
  let retained = artifacts.length;
  for (const artifact of artifacts) {
    if (retained <= options.maxFiles) break;
    if (explicitProtectedIds.has(artifact.name)) continue;
    const released = releasePins(artifact.name, authorities);
    if (!released) continue;
    // Once prepare-delete is durable, a failed unlink/sync must not make a
    // newer artifact pay the same cap debt. The pending row owns the retry.
    if (!unlinkMediaArtifactDurably(options.dir, artifact.name, options.io, artifact.stats)) break;
    if (!finalizeArtifactPrune(released, artifact.name)) break;
    retained -= 1;
    result.prunedArtifactIds.push(artifact.name);
    try { options.onArtifactPruned?.(artifact.name); } catch { /* deletion remains authoritative */ }
  }
  return result;
}

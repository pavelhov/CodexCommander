import { lstatSync, readdirSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(png|jpe?g|webp|gif|mp4|webm)$/i;
const PRIVATE_VIDEO_TEMP_RE = /^\.ccx-video-[A-Za-z0-9._-]{1,200}\.tmp$/;

export interface ArtifactPinAuthority {
  protectedArtifactIds(): ReadonlySet<string>;
  releaseArtifactForPrune?(artifactId: string): ArtifactPinReleaseResult;
}

export type ArtifactPinReleaseResult = "released" | "protected" | "conflict" | "not_owned";

export interface ArtifactRetentionOptions {
  dir: string;
  maxFiles: number;
  protectedArtifactIds?: ReadonlySet<string>;
  onArtifactPruned?: (artifactId: string) => void;
  staleTempAgeMs?: number;
  now?: number;
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

function linkedPublishedArtifact(dir: string, names: readonly string[], temp: Stats): string | null {
  if (!temp.isFile() || temp.isSymbolicLink() || temp.nlink !== 2) return null;
  let match: string | null = null;
  for (const name of names) {
    if (!ARTIFACT_ID_RE.test(name)) continue;
    try {
      const candidate = lstatSync(join(dir, name));
      if (!candidate.isFile() || candidate.isSymbolicLink() || !sameIdentity(temp, candidate)) continue;
      if (match !== null) return null;
      match = name;
    } catch {
      // Racing candidates do not prove a recoverable publication link.
    }
  }
  return match;
}

function collectRegisteredProtectedIds(): ReadonlySet<string> | null {
  const protectedIds = new Set<string>();
  try {
    for (const authority of registeredPinAuthorities) {
      for (const id of authority.protectedArtifactIds()) protectedIds.add(id);
    }
    return protectedIds;
  } catch {
    // A corrupt/closed/future journal must fail retention closed. Deleting while
    // the durable pin snapshot is unavailable could strand completed jobs.
    return null;
  }
}

function releaseRegisteredPins(artifactId: string): boolean {
  try {
    const owners = [...registeredPinAuthorities]
      .filter(authority => authority.protectedArtifactIds().has(artifactId));
    for (const authority of owners) {
      if (!authority.releaseArtifactForPrune) return false;
      const result = authority.releaseArtifactForPrune(artifactId);
      if (result !== "released" && result !== "not_owned") return false;
    }
    return [...registeredPinAuthorities]
      .every(authority => !authority.protectedArtifactIds().has(artifactId));
  } catch {
    return false;
  }
}

function unlinkArtifact(dir: string, artifactId: string): boolean {
  if (!ARTIFACT_ID_RE.test(artifactId)) return false;
  const path = join(dir, artifactId);
  try {
    const observed = lstatSync(path);
    if (!safeRegularFile(observed)) return false;
    const current = lstatSync(path);
    if (!safeRegularFile(current) || !sameIdentity(observed, current)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Delete one exact opaque artifact only after every registered durable pin is released. */
export function removeMediaArtifact(dir: string, artifactId: string): boolean {
  if (!ARTIFACT_ID_RE.test(artifactId)) return false;
  const protectedIds = collectRegisteredProtectedIds();
  if (!protectedIds) return false;
  if (!releaseRegisteredPins(artifactId)) return false;
  return unlinkArtifact(dir, artifactId);
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
  if (!Number.isSafeInteger(options.maxFiles) || options.maxFiles <= 0) return result;

  const registeredProtectedIds = collectRegisteredProtectedIds();
  if (!registeredProtectedIds) return { ...result, blocked: true };
  const explicitProtectedIds = options.protectedArtifactIds ?? new Set<string>();

  let names: string[];
  try {
    names = readdirSync(options.dir);
  } catch {
    return { ...result, blocked: true };
  }

  const now = options.now ?? Date.now();
  const staleTempAgeMs = options.staleTempAgeMs;
  if (staleTempAgeMs !== undefined && Number.isSafeInteger(staleTempAgeMs) && staleTempAgeMs >= 0) {
    for (const name of names) {
      if (!PRIVATE_VIDEO_TEMP_RE.test(name)) continue;
      const path = join(options.dir, name);
      try {
        const observed = lstatSync(path);
        const linkedFinal = linkedPublishedArtifact(options.dir, names, observed);
        if ((!safeRegularFile(observed) && linkedFinal === null) || now - observed.mtimeMs < staleTempAgeMs) continue;
        const current = lstatSync(path);
        if (!sameIdentity(observed, current)) continue;
        if (!safeRegularFile(current) && linkedPublishedArtifact(options.dir, names, current) !== linkedFinal) continue;
        unlinkSync(path);
        result.removedStaleTemps.push(name);
      } catch {
        // Stale partial cleanup is best effort and never widens artifact pruning.
      }
    }
  }

  const artifacts: Array<{ name: string; path: string; stats: Stats }> = [];
  for (const name of names) {
    if (!ARTIFACT_ID_RE.test(name)) continue;
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
    if (!releaseRegisteredPins(artifact.name)) continue;
    try {
      const current = lstatSync(artifact.path);
      if (!safeRegularFile(current) || !sameIdentity(artifact.stats, current)) continue;
      unlinkSync(artifact.path);
      retained -= 1;
      result.prunedArtifactIds.push(artifact.name);
      try { options.onArtifactPruned?.(artifact.name); } catch { /* deletion remains authoritative */ }
    } catch {
      // Retention is best effort. A later coordinated pass can retry safely.
    }
  }
  return result;
}

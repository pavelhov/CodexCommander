import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";

/** Which kinds of logical leaf may authorize a snapshot. */
export type CodexSurfaceLeafPolicy = "regular-or-symlink" | "regular-only";

/**
 * The filesystem fields that bind an observation to one directory entry or
 * target generation. Nanosecond bigint values avoid discarding stat precision.
 */
interface CodexSurfaceFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export type CodexSurfaceSnapshot =
  | {
      readonly kind: "absent";
      readonly logicalPath: string;
    }
  | {
      readonly kind: "file";
      readonly logicalPath: string;
      readonly bytes: Buffer;
      /** Exact UTF-8 decoding, or null when decoding would change the bytes. */
      readonly text: string | null;
      /** Full stable observation retained for ownership and mode decisions. */
      readonly entryStat: BigIntStats;
      readonly canonicalTarget: string;
      /** Full stable observation retained for ownership and mode decisions. */
      readonly targetStat: BigIntStats;
      readonly symbolicLink: boolean;
    };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function identity(stat: BigIntStats): CodexSurfaceFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameIdentity(
  left: CodexSurfaceFileIdentity,
  right: CodexSurfaceFileIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function allowedLeaf(stat: BigIntStats, policy: CodexSurfaceLeafPolicy): boolean {
  return stat.isFile()
    || (policy === "regular-or-symlink" && stat.isSymbolicLink());
}

function exactUtf8(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

/**
 * Capture a stable, symlink-aware file observation for compare-before-mutate
 * decisions. A null result means the surface was unsupported, unreadable, or
 * changed while it was being observed. Only absence at the initial lstat is
 * classified as an absent snapshot; a dangling link or later disappearance is
 * unstable and therefore fails closed.
 */
export function readCodexSurfaceSnapshot(
  logicalPath: string,
  leafPolicy: CodexSurfaceLeafPolicy = "regular-or-symlink",
): CodexSurfaceSnapshot | null {
  let entryBefore: BigIntStats;
  try {
    entryBefore = lstatSync(logicalPath, { bigint: true });
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "absent", logicalPath } : null;
  }

  try {
    if (!allowedLeaf(entryBefore, leafPolicy)) return null;
    const symbolicLink = entryBefore.isSymbolicLink();

    // Canonicalize even a regular leaf: any parent component can itself be a
    // link, and that resolution is part of the authority being captured.
    const canonicalTarget = realpathSync.native(logicalPath);
    const targetBefore = statSync(canonicalTarget, { bigint: true });
    if (!targetBefore.isFile()) return null;

    const bytes = readFileSync(canonicalTarget);
    const targetAfter = statSync(canonicalTarget, { bigint: true });
    const entryAfter = lstatSync(logicalPath, { bigint: true });
    const canonicalAfter = realpathSync.native(logicalPath);

    if (
      !targetAfter.isFile()
      || !allowedLeaf(entryAfter, leafPolicy)
      || entryAfter.isSymbolicLink() !== symbolicLink
      || canonicalAfter !== canonicalTarget
      || !sameIdentity(identity(entryBefore), identity(entryAfter))
      || !sameIdentity(identity(targetBefore), identity(targetAfter))
    ) return null;

    return {
      kind: "file",
      logicalPath,
      bytes,
      text: exactUtf8(bytes),
      entryStat: entryAfter,
      canonicalTarget,
      targetStat: targetAfter,
      symbolicLink,
    };
  } catch {
    return null;
  }
}

/** Compare both bytes and every filesystem authority bound by the snapshot. */
export function sameCodexSurfaceSnapshot(
  expected: CodexSurfaceSnapshot,
  current: CodexSurfaceSnapshot,
): boolean {
  if (expected.logicalPath !== current.logicalPath) return false;
  if (expected.kind === "absent" || current.kind === "absent") {
    return expected.kind === current.kind;
  }
  return expected.bytes.equals(current.bytes)
    && expected.canonicalTarget === current.canonicalTarget
    && expected.symbolicLink === current.symbolicLink
    && sameIdentity(identity(expected.entryStat), identity(current.entryStat))
    && sameIdentity(identity(expected.targetStat), identity(current.targetStat));
}

/** Return exact text for a file snapshot, or the caller's absent representation. */
export function codexSurfaceText(
  snapshot: CodexSurfaceSnapshot,
  absentValue: "" | null,
): string | null {
  return snapshot.kind === "file" ? snapshot.text : absentValue;
}

/**
 * Small no-follow primitives for files a background service will execute or use
 * as credentials.  Service paths are deterministic, so treating an existing
 * name as permission to overwrite it would give any local process an easy
 * symlink/hardlink write primitive.
 */
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

function sameEntry(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink && a.mode === b.mode;
}

function privateMode(stat: Stats): boolean {
  // Windows ACLs are applied by the caller. POSIX service state/secrets must not
  // be readable or replaceable by another local account.
  return process.platform === "win32" || (stat.mode & 0o077) === 0;
}

export function ensurePrivateServiceDirectory(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Cannot create private service directory ${dir}: ${String(error)}`);
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateMode(stat)) {
    throw new Error(`Refusing unsafe service directory: ${dir}`);
  }
}

export function ensurePhysicalServiceDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing non-physical service directory: ${dir}`);
  }
}

export function assertPrivateServiceFile(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !privateMode(stat)) {
    throw new Error(`Refusing unsafe service file: ${path}`);
  }
  return stat;
}

export type PrivateServiceWriteOptions = {
  encoding?: "utf8" | "utf16le";
  mode?: number;
  /** Existing files must prove current ownership before replacement. */
  ownsExisting?: (content: string) => boolean;
  /** LaunchAgents/systemd have user-controlled but not necessarily mode-0700 parents. */
  parent?: "private" | "physical";
};

/**
 * Write a private regular file without ever following an existing link. Fresh
 * writes use link(2) no-clobber. Replacements re-stat the known file immediately
 * before unlinking it, then use link(2) again: a competing replacement wins and
 * is preserved rather than overwritten. There is intentionally no rename-over-
 * existing fallback because it reintroduces the race this function removes.
 */
export function writePrivateServiceFile(path: string, content: string | Uint8Array, options: PrivateServiceWriteOptions = {}): void {
  if (options.parent === "physical") ensurePhysicalServiceDirectory(dirname(path));
  else ensurePrivateServiceDirectory(dirname(path));
  const encoding = options.encoding ?? "utf8";
  const mode = options.mode ?? 0o600;
  let existing: Stats | null = null;
  try {
    existing = assertPrivateServiceFile(path);
    const current = readFileSync(path, encoding);
    if (!options.ownsExisting?.(current)) {
      throw new Error(`Refusing to replace foreign service file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { encoding, mode, flag: "wx" });
    // Best effort on filesystems that do not support fsync; failure is surfaced
    // rather than silently declaring an on-disk credential durable.
    const fd = openSync(temp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (existing) {
      const now = assertPrivateServiceFile(path);
      if (!sameEntry(existing, now)) throw new Error(`Refusing service file changed during replacement: ${path}`);
      unlinkSync(path);
    }
    linkSync(temp, path); // no-clobber: protects the absent-name race
  } finally {
    try { unlinkSync(temp); } catch { /* already linked or never created */ }
  }
}

/** Remove only a private, single-link file whose current content proves ownership. */
export function removeOwnedPrivateServiceFile(path: string, owns: (content: string) => boolean, encoding: "utf8" | "utf16le" = "utf8"): boolean {
  try {
    const before = assertPrivateServiceFile(path);
    if (!owns(readFileSync(path, encoding))) return false;
    if (!sameEntry(before, assertPrivateServiceFile(path))) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}

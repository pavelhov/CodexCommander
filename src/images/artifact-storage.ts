import { lstatSync, type Stats } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import type { PinnedAddress } from "./pinned-https-get";

const ARTIFACT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function getArtifactsDir(): string {
  return join(getConfigDir(), "artifacts");
}

export async function ensureArtifactsDirectory(): Promise<string> {
  const dir = getArtifactsDir();
  recordOwnedConfigPath(getConfigDir(), dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let stats = lstatSync(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("artifact directory is unsafe");
  }
  if (process.platform === "win32") {
    hardenSecretDir(dir, { required: true, timeoutMemoKey: `${dir}::artifacts` });
  } else {
    await chmod(dir, 0o700);
  }
  stats = lstatSync(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("artifact directory is unsafe");
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || stats.uid !== uid || (stats.mode & 0o777) !== 0o700) {
      throw new Error("artifact directory is not owner-only");
    }
  }
  return dir;
}

export function artifactExtension(id: string): string | null {
  const ext = id.split(".").pop()?.toLowerCase();
  return ext && ARTIFACT_CONTENT_TYPES[ext] ? ext : null;
}

export function artifactContentType(id: string): string | null {
  const ext = artifactExtension(id);
  return ext ? ARTIFACT_CONTENT_TYPES[ext] ?? null : null;
}

export function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function privateArtifactFileWithLinks(stats: Stats, links: number): boolean {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== links) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o777) === 0o600;
}

export function privateArtifactFile(stats: Stats): boolean {
  return privateArtifactFileWithLinks(stats, 1);
}

export function timestampPrefix(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
    "-",
    String(now.getMilliseconds()).padStart(3, "0"),
  ].join("");
}

export async function syncArtifactDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function pickPinnedAddress(addresses: PinnedAddress[]): PinnedAddress {
  return addresses.find(address => address.family === 4) ?? addresses[0]!;
}

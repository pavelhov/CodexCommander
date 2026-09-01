import { constants, existsSync, lstatSync, type Stats } from "node:fs";
import { link, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { assessUrlDestination, resolvePublicAddresses } from "../lib/destination-policy";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import {
  artifactExtension,
  ensureArtifactsDirectory,
  pickPinnedAddress,
  privateArtifactFile,
  privateArtifactFileWithLinks,
  sameFileIdentity,
  syncArtifactDirectory,
  timestampPrefix,
} from "./artifact-storage";
import { pinnedHttpsGet } from "./pinned-https-get";

const VIDEO_ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(mp4|webm)$/i;
const PRIVATE_VIDEO_TEMP_RE = /^\.ccx-video-[A-Za-z0-9._-]{1,200}\.tmp$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export const MAX_VIDEO_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB
/** Aggregate per-turn video download cap (600 MiB = 3 × max single download). */
const MAX_VIDEO_BYTES_PER_TURN = MAX_VIDEO_DOWNLOAD_BYTES * 3;

export interface VideoBudget {
  spent: number;
  /** Ceiling on total bytes across all downloads this turn. */
  cap: number;
}

export function createVideoBudget(): VideoBudget {
  return { spent: 0, cap: MAX_VIDEO_BYTES_PER_TURN };
}

/** Charge bytes to the budget; returns false if the ceiling would be exceeded. */
export function chargeVideoBudget(budget: VideoBudget, bytes: number): boolean {
  if (budget.spent + bytes > budget.cap) return false;
  budget.spent += bytes;
  return true;
}

export function guessVideoExtFromMagic(bytes: Uint8Array): string {
  if (bytes.byteLength < 12) throw new Error("video data too short for magic byte sniffing");
  const sig = Buffer.from(bytes.slice(0, 12)).toString("latin1");
  // MP4/QuickTime/MOV: bytes 4-7 == "ftyp" (ISO BMFF)
  if (sig.slice(4, 8) === "ftyp") return "mp4";
  // WebM/Matroska: \x1a\x45\xdf\xa3
  if (sig.startsWith("\x1a\x45\xdf\xa3")) return "webm";
  throw new Error("unrecognized video format — magic bytes do not match MP4 or WebM");
}

export type VideoArtifactExtension = "mp4" | "webm";

/** Reserve an opaque final artifact id before any final-name publication. */
export function reserveVideoArtifactId(ext: VideoArtifactExtension): string {
  if (ext !== "mp4" && ext !== "webm") throw new Error("video artifact extension is invalid");
  return `vid-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`;
}

export interface VideoArtifactDownloadOptions {
  /** Existing durable reservation reused after a crash/retry. */
  reservedArtifactId?: string;
  /** Must commit the id to durable downloading state before publication starts. */
  onReserveArtifact?: (artifactId: string) => void | Promise<void>;
  /** Internal durability-test seam; production uses an artifact-directory fsync. */
  syncDirectory?: (dir: string) => Promise<void>;
  /** Internal publication-race test seam; production uses an atomic no-replace link. */
  linkArtifact?: (tempPath: string, finalPath: string) => Promise<void>;
}

function selectVideoArtifactId(
  options: VideoArtifactDownloadOptions,
  ext: VideoArtifactExtension,
): string {
  const artifactId = options.reservedArtifactId ?? reserveVideoArtifactId(ext);
  if (
    !VIDEO_ARTIFACT_ID_RE.test(artifactId)
    || basename(artifactId) !== artifactId
    || artifactExtension(artifactId) !== ext
  ) throw new Error("video artifact reservation is invalid");
  return artifactId;
}

function artifactFsErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function validateVideoTemp(path: string, expectedExt: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!privateArtifactFile(stats) || stats.size < 12 || stats.size > MAX_VIDEO_DOWNLOAD_BYTES) {
      throw new Error("video artifact validation failed before publication");
    }
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < header.length || guessVideoExtFromMagic(header) !== expectedExt) {
      throw new Error("video artifact validation failed before publication");
    }
  } finally {
    await handle.close();
  }
}

async function validatePublishedVideo(path: string, expectedExt: string): Promise<void> {
  const before = lstatSync(path);
  if (!privateArtifactFile(before)) throw new Error("reserved video artifact is unsafe");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    const after = lstatSync(path);
    if (
      !privateArtifactFile(stats)
      || !privateArtifactFile(after)
      || !sameFileIdentity(before, stats)
      || !sameFileIdentity(stats, after)
      || stats.size < 12
      || stats.size > MAX_VIDEO_DOWNLOAD_BYTES
    ) throw new Error("reserved video artifact is unsafe");
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || guessVideoExtFromMagic(header) !== expectedExt) {
      throw new Error("reserved video artifact has invalid media bytes");
    }
  } finally {
    await handle.close();
  }
}

async function validateLinkedPublishedVideo(path: string, expectedExt: string): Promise<void> {
  const before = lstatSync(path);
  if (!privateArtifactFileWithLinks(before, 2)) throw new Error("reserved video artifact is unsafe");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    const after = lstatSync(path);
    if (
      !privateArtifactFileWithLinks(stats, 2)
      || !privateArtifactFileWithLinks(after, 2)
      || !sameFileIdentity(before, stats)
      || !sameFileIdentity(stats, after)
      || stats.size < 12
      || stats.size > MAX_VIDEO_DOWNLOAD_BYTES
    ) throw new Error("reserved video artifact is unsafe");
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || guessVideoExtFromMagic(header) !== expectedExt) {
      throw new Error("reserved video artifact has invalid media bytes");
    }
  } finally {
    await handle.close();
  }
}

/** Complete the exact link(temp, final) crash state without accepting arbitrary hard links. */
async function recoverLinkedVideoPublication(
  dir: string,
  finalPath: string,
  expectedExt: string,
  syncDirectory: (dir: string) => Promise<void> = syncArtifactDirectory,
): Promise<boolean> {
  let finalBefore: Stats;
  try {
    finalBefore = lstatSync(finalPath);
  } catch {
    return false;
  }
  if (!privateArtifactFileWithLinks(finalBefore, 2)) return false;
  const matches: Array<{ path: string; stats: Stats }> = [];
  for (const name of await readdir(dir)) {
    if (!PRIVATE_VIDEO_TEMP_RE.test(name)) continue;
    const path = join(dir, name);
    try {
      const stats = lstatSync(path);
      if (privateArtifactFileWithLinks(stats, 2) && sameFileIdentity(finalBefore, stats)) {
        matches.push({ path, stats });
      }
    } catch {
      // A racing or missing temp cannot prove this narrow crash state.
    }
  }
  if (matches.length !== 1) return false;
  await validateLinkedPublishedVideo(finalPath, expectedExt);
  const match = matches[0]!;
  const finalCurrent = lstatSync(finalPath);
  const tempCurrent = lstatSync(match.path);
  if (
    !privateArtifactFileWithLinks(finalCurrent, 2)
    || !privateArtifactFileWithLinks(tempCurrent, 2)
    || !sameFileIdentity(finalBefore, finalCurrent)
    || !sameFileIdentity(match.stats, tempCurrent)
    || !sameFileIdentity(finalCurrent, tempCurrent)
  ) return false;
  await unlink(match.path);
  await syncDirectory(dir);
  return true;
}

/**
 * Publish a fully written video under its opaque final id with an atomic,
 * no-replace hard link. The private temp and final share one filesystem.
 */
async function publishVideoArtifact(
  dir: string,
  ext: string,
  artifactId: string,
  write: (handle: FileHandle) => Promise<void>,
  options: Pick<VideoArtifactDownloadOptions, "syncDirectory" | "linkArtifact"> = {},
): Promise<string> {
  if (!VIDEO_ARTIFACT_ID_RE.test(artifactId) || artifactExtension(artifactId) !== ext || basename(artifactId) !== artifactId) {
    throw new Error("video artifact reservation is invalid");
  }
  const syncDirectory = options.syncDirectory ?? syncArtifactDirectory;
  const linkArtifact = options.linkArtifact ?? link;
  const finalPath = join(dir, artifactId);
  if (existsSync(finalPath)) {
    await recoverLinkedVideoPublication(dir, finalPath, ext, syncDirectory);
    await validatePublishedVideo(finalPath, ext);
    await syncDirectory(dir);
    await validatePublishedVideo(finalPath, ext);
    return finalPath;
  }
  const token = crypto.randomUUID();
  const tempPath = join(dir, `.ccx-video-${token}.tmp`);
  let handle: FileHandle | undefined;
  let published = false;
  try {
    handle = await open(tempPath, "wx", 0o600);
    if (process.platform === "win32") {
      hardenSecretPath(tempPath, { required: true, timeoutMemoKey: `${dir}::video-artifact` });
    }
    await write(handle);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await validateVideoTemp(tempPath, ext);
    // link() is an atomic no-replace publication primitive. Unlike rename(), it
    // cannot overwrite a concurrently created final artifact.
    await linkArtifact(tempPath, finalPath);
    published = true;
    try {
      await unlink(tempPath);
    } catch (error) {
      // A retry/retention pass may have completed this exact nlink=2 crash
      // state after publication. Missing temp is success; every other unlink
      // failure still rejects and removes the final in the catch below.
      if (artifactFsErrorCode(error) !== "ENOENT") throw error;
    }
    await syncDirectory(dir);
    await validatePublishedVideo(finalPath, ext);
    return finalPath;
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* cleanup continues */ }
    }
    try { await unlink(tempPath); } catch { /* absent */ }
    if (published) {
      try { await unlink(finalPath); } catch { /* cleanup remains best effort */ }
      try { await syncDirectory(dir); } catch { /* preserve original failure */ }
    }
    if (artifactFsErrorCode(error) === "EEXIST") {
      // Another publisher may have completed the exact durable reservation.
      await validatePublishedVideo(finalPath, ext);
      await syncDirectory(dir);
      await validatePublishedVideo(finalPath, ext);
      return finalPath;
    }
    throw error;
  }
}

/**
 * Adopt already-published bytes for one exact durable reservation without DNS,
 * provider polling, or a signed URL. Returns null only when no final file exists;
 * an unsafe or invalid existing file is a hard failure.
 */
export async function adoptReservedVideoArtifact(
  artifactId: string,
  options: { syncDirectory?: (dir: string) => Promise<void> } = {},
): Promise<string | null> {
  if (!VIDEO_ARTIFACT_ID_RE.test(artifactId) || basename(artifactId) !== artifactId) {
    throw new Error("video artifact reservation is invalid");
  }
  const ext = artifactExtension(artifactId);
  if (ext !== "mp4" && ext !== "webm") throw new Error("video artifact reservation is invalid");
  const dir = await ensureArtifactsDirectory();
  const finalPath = join(dir, artifactId);
  if (!existsSync(finalPath)) return null;
  const syncDirectory = options.syncDirectory ?? syncArtifactDirectory;
  await recoverLinkedVideoPublication(dir, finalPath, ext, syncDirectory);
  await validatePublishedVideo(finalPath, ext);
  // Even an already-single-link final can be the visible result of an earlier
  // unlink whose directory sync failed. Never complete the durable job until
  // the exact reserved name is confirmed in directory metadata.
  await syncDirectory(dir);
  await validatePublishedVideo(finalPath, ext);
  return finalPath;
}

/**
 * Download a video from a URL to an artifact file with a 200 MiB hard cap, streaming the body
 * to disk to avoid buffering. SSRF protection reuses the same destination policy + pinned HTTPS
 * as image downloads. Format is sniffed from magic bytes.
 */
export async function downloadVideoToArtifact(
  url: string,
  budget?: VideoBudget,
  signal?: AbortSignal,
  options: VideoArtifactDownloadOptions = {},
): Promise<string> {
  // For data: URLs, handle inline (unlikely for video but keep parity)
  if (url.startsWith("data:")) {
    const commaIdx = url.indexOf(",");
    if (commaIdx < 0) throw new Error("video data URI is invalid");
    const meta = url.slice(0, commaIdx);
    const data = url.slice(commaIdx + 1);
    const isBase64 = meta.includes(";base64");
    if (!isBase64) throw new Error("non-base64 data URI for video is not supported");
    if (!BASE64_RE.test(data) || data.length % 4 !== 0) throw new Error("video data URI is not valid base64");
    const buf = Buffer.from(data, "base64");
    if (buf.byteLength === 0) throw new Error("video data URI is empty");
    if (buf.byteLength > MAX_VIDEO_DOWNLOAD_BYTES) throw new Error("video data URI exceeds size cap");
    if (budget && !chargeVideoBudget(budget, buf.byteLength)) {
      throw new Error("video data URI exceeds per-turn download budget");
    }
    const ext = guessVideoExtFromMagic(buf) as VideoArtifactExtension;
    const artifactId = selectVideoArtifactId(options, ext);
    await options.onReserveArtifact?.(artifactId);
    const dir = await ensureArtifactsDirectory();
    return publishVideoArtifact(dir, ext, artifactId, async handle => {
      await handle.writeFile(buf);
    }, options);
  }

  // SSRF protection: same validation as downloadImageToArtifact
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { throw new Error("video URL is not valid"); }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`video URL must use HTTPS, got ${parsedUrl.protocol}`);
  }
  const assessment = assessUrlDestination(url);
  if (assessment && assessment.kind !== "public" && assessment.kind !== "hostname") {
    throw new Error(`video URL targets ${assessment.detail}`);
  }
  const resolved = await resolvePublicAddresses(url, "video");
  const pinned = pickPinnedAddress(resolved.addresses);
  const resp = await pinnedHttpsGet(url, pinned, signal, { maxBytes: MAX_VIDEO_DOWNLOAD_BYTES });
  if (!resp.ok) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    throw new Error("video download failed: " + resp.status);
  }

  const dir = await ensureArtifactsDirectory();

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("video download returned no body");

  // Buffer at least 12 bytes for magic-byte sniffing before opening the temp file.
  // A single read() can return fewer bytes; accumulate until we have enough.
  try {
    const sniffChunks: Uint8Array[] = [];
    let sniffLen = 0;
    while (sniffLen < 12) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      sniffChunks.push(value);
      sniffLen += value.byteLength;
    }
    if (sniffLen === 0) {
      throw new Error("video download returned empty body");
    }
    const sniffBuf = Buffer.concat(sniffChunks);
    const ext = guessVideoExtFromMagic(new Uint8Array(sniffBuf)) as VideoArtifactExtension;
    const artifactId = selectVideoArtifactId(options, ext);
    await options.onReserveArtifact?.(artifactId);
    const published = await publishVideoArtifact(dir, ext, artifactId, async handle => {
      // Write all buffered chunks and set up accounting.
      let totalBytes = sniffBuf.byteLength;
      if (budget && !chargeVideoBudget(budget, totalBytes)) {
        throw new Error("video download exceeds per-turn budget");
      }
      if (totalBytes > MAX_VIDEO_DOWNLOAD_BYTES) {
        throw new Error("video download exceeds size cap");
      }
      await handle.write(new Uint8Array(sniffBuf));
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (budget && !chargeVideoBudget(budget, value.byteLength)) {
          throw new Error("video download exceeds per-turn budget");
        }
        if (totalBytes > MAX_VIDEO_DOWNLOAD_BYTES) {
          throw new Error("video download exceeds size cap");
        }
        await handle.write(value);
      }
    }, options);
    try { await reader.cancel(); } catch { /* ignore */ }
    reader.releaseLock();
    return published;
  } catch (err) {
    try { await reader.cancel(); } catch { /* ignore */ }
    reader.releaseLock();
    throw err;
  }
}

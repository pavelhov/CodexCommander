import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { chmod, link, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { getConfigDir } from "../config";
import { assessUrlDestination, resolvePublicAddresses } from "../lib/destination-policy";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { ARTIFACT_HTTP_PREFIX } from "../identity";
import {
  pinnedHttpsGet,
  type PinnedAddress,
  type PinnedDownloadFn,
} from "./pinned-https-get";
import { pruneMediaArtifacts, removeMediaArtifact, unlinkMediaArtifactDurably } from "./artifact-retention";

export { pinnedHttpsGet } from "./pinned-https-get";
export type { PinnedAddress, PinnedDownloadFn } from "./pinned-https-get";

const MAX_DECODED_BYTES_PER_IMAGE = 50 * 1024 * 1024;
const MAX_DECODED_BYTES_PER_RESPONSE = 100 * 1024 * 1024;
/** Hard cap for remote image downloads (also enforced inside pinnedHttpsGet). */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB
/** Idle timeout for pinned HTTPS connect/headers/body when no AbortSignal is provided. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/**
 * Upper bound on the raw base64 string length before it is decoded. Base64
 * encoding expands 3 decoded bytes to 4 encoded chars, so this corresponds to
 * MAX_DECODED_BYTES_PER_IMAGE. Checking this in the adapter (before calling
 * materializeInlineImage) rejects oversized payloads before normalization
 * copies them — see Wibias R4 finding 5.
 */
export const MAX_ENCODED_BYTES_PER_IMAGE = Math.ceil(MAX_DECODED_BYTES_PER_IMAGE * 4 / 3);

/** Default cap on files retained under artifacts/. Oldest files are pruned when exceeded. */
export const DEFAULT_ARTIFACT_KEEP_COUNT = 200;

/** Opaque artifact HTTP path prefix (data-plane, API-auth gated). */
export { ARTIFACT_HTTP_PREFIX };

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(png|jpe?g|webp|gif|mp4|webm)$/i;
const PRIVATE_VIDEO_TEMP_RE = /^\.ccx-video-[A-Za-z0-9._-]{1,200}\.tmp$/;
const ARTIFACT_STREAM_CHUNK_BYTES = 256 * 1024;

const ARTIFACT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
};

// Strict alphabet check: Buffer.from(..., "base64") silently ignores invalid
// characters, so malformed payloads would otherwise decode to garbage bytes.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ImageBudget {
  spent: number;
}

export function createImageBudget(): ImageBudget {
  return { spent: 0 };
}

/** Atomically reserve `bytes` against the per-response budget (no await between check and charge). */
export function chargeImageBudget(budget: ImageBudget | undefined, bytes: number): void {
  if (!budget) return;
  if (budget.spent + bytes > MAX_DECODED_BYTES_PER_RESPONSE) {
    throw new Error(`image response exceeds ${MAX_DECODED_BYTES_PER_RESPONSE} byte per-response cap`);
  }
  budget.spent += bytes;
}

export function getArtifactsDir(): string {
  return join(getConfigDir(), "artifacts");
}

async function ensureArtifactsDirectory(): Promise<string> {
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

function artifactExtension(id: string): string | null {
  const ext = id.split(".").pop()?.toLowerCase();
  return ext && ARTIFACT_CONTENT_TYPES[ext] ? ext : null;
}

function artifactContentType(id: string): string | null {
  const ext = artifactExtension(id);
  return ext ? ARTIFACT_CONTENT_TYPES[ext] ?? null : null;
}

/**
 * Markdown-safe relative URL for a materialized artifact. Opaque filename only —
 * never expose host filesystem paths to model-visible content.
 */
export function artifactHttpUrl(filePath: string): string {
  const name = basename(filePath);
  if (!ARTIFACT_ID_RE.test(name)) {
    throw new Error("artifact filename is not a valid opaque id");
  }
  return `${ARTIFACT_HTTP_PREFIX}/${name}`;
}

/**
 * Resolve an opaque artifact id to an absolute path under the artifacts dir.
 * Rejects traversal (`..`, absolute paths, separators).
 */
export function resolveArtifactPath(id: string): string | null {
  if (!ARTIFACT_ID_RE.test(id)) return null;
  const dir = resolve(getArtifactsDir());
  const candidate = resolve(dir, id);
  if (candidate !== dir && !candidate.startsWith(dir + sep)) return null;
  if (!existsSync(candidate)) return null;
  try {
    const stats = lstatSync(candidate);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) return null;
  } catch {
    return null;
  }
  return candidate;
}

export function readArtifactBytes(id: string): { bytes: Buffer; contentType: string } | null {
  const path = resolveArtifactPath(id);
  if (!path) return null;
  const bytes = readFileSync(path);
  const contentType = artifactContentType(path) ?? "application/octet-stream";
  return { bytes, contentType };
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateArtifactFileWithLinks(stats: Stats, links: number): boolean {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== links) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o777) === 0o600;
}

function privateArtifactFile(stats: Stats): boolean {
  return privateArtifactFileWithLinks(stats, 1);
}

function privateArtifactDirectory(stats: Stats): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o777) === 0o700;
}

function magicMatchesExtension(bytes: Uint8Array, ext: string): boolean {
  if (ext === "mp4" || ext === "webm") {
    try { return guessVideoExtFromMagic(bytes) === ext; } catch { return false; }
  }
  const sniffed = sniffImageExtension(bytes);
  return sniffed === ext || (sniffed === "jpg" && ext === "jpeg");
}

type ArtifactByteRange = { start: number; end: number };

function parseArtifactRange(value: string, size: number): ArtifactByteRange | null {
  if (/[^\x20-\x7e]/.test(value) || value.includes(",") || !/^bytes=/i.test(value)) return null;
  const spec = value.slice(6);
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (!match[1] && !match[2])) return null;
  const parse = (raw: string): number | null => {
    if (!/^\d+$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  if (!match[1]) {
    const suffix = parse(match[2]!);
    if (suffix === null || suffix === 0 || size === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = parse(match[1]);
  if (start === null || start >= size) return null;
  if (!match[2]) return { start, end: size - 1 };
  const requestedEnd = parse(match[2]);
  if (requestedEnd === null || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function closeQuietlyFd(fd: number): void {
  try { closeSync(fd); } catch { /* already closed */ }
}

/**
 * Open, validate, and stream one artifact through a single no-follow file
 * descriptor. The pathname is rechecked against the opened identity before any
 * bytes are returned, so a later replacement cannot retarget the response.
 */
export async function createArtifactResponse(
  id: string,
  method: "GET" | "HEAD",
  rangeHeader: string | null,
): Promise<Response | null> {
  if (!ARTIFACT_ID_RE.test(id)) return null;
  const ext = artifactExtension(id);
  const contentType = artifactContentType(id);
  if (!ext || !contentType) return null;

  const dir = resolve(getArtifactsDir());
  let dirStats: Stats;
  let before: Stats;
  const path = resolve(dir, id);
  if (!path.startsWith(dir + sep)) return null;
  try {
    dirStats = lstatSync(dir);
    before = lstatSync(path);
  } catch {
    return null;
  }
  if (!privateArtifactDirectory(dirStats) || !privateArtifactFile(before)) return null;
  if (process.platform === "win32") {
    if (!hardenSecretDir(dir, { required: false }).ok || !hardenSecretPath(path, { required: false }).ok) {
      return null;
    }
    try {
      dirStats = lstatSync(dir);
      before = lstatSync(path);
    } catch {
      return null;
    }
    if (!privateArtifactDirectory(dirStats) || !privateArtifactFile(before)) return null;
  }

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  let stats: Stats;
  try {
    stats = fstatSync(fd);
    const after = lstatSync(path);
    if (
      !privateArtifactFile(stats)
      || !privateArtifactFile(after)
      || !sameFileIdentity(before, stats)
      || !sameFileIdentity(stats, after)
    ) {
      closeQuietlyFd(fd);
      return null;
    }
    const maxBytes = ext === "mp4" || ext === "webm" ? MAX_VIDEO_DOWNLOAD_BYTES : MAX_DOWNLOAD_BYTES;
    if (!Number.isSafeInteger(stats.size) || stats.size <= 0 || stats.size > maxBytes) {
      closeQuietlyFd(fd);
      return null;
    }
    const header = Buffer.alloc(Math.min(12, stats.size));
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    if (bytesRead !== header.length || !magicMatchesExtension(header, ext)) {
      closeQuietlyFd(fd);
      return null;
    }
  } catch {
    closeQuietlyFd(fd);
    return null;
  }

  const commonHeaders = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  let status = 200;
  let start = 0;
  let end = stats.size - 1;
  if (rangeHeader !== null) {
    const range = parseArtifactRange(rangeHeader, stats.size);
    if (!range) {
      closeQuietlyFd(fd);
      commonHeaders.set("content-range", `bytes */${stats.size}`);
      commonHeaders.set("content-length", "0");
      return new Response(null, { status: 416, headers: commonHeaders });
    }
    status = 206;
    start = range.start;
    end = range.end;
    commonHeaders.set("content-range", `bytes ${start}-${end}/${stats.size}`);
  }
  commonHeaders.set("content-length", String(end - start + 1));
  if (method === "HEAD") {
    closeQuietlyFd(fd);
    return new Response(null, { status, headers: commonHeaders });
  }

  let position = start;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeQuietlyFd(fd);
  };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position > end) {
        close();
        controller.close();
        return;
      }
      const length = Math.min(ARTIFACT_STREAM_CHUNK_BYTES, end - position + 1);
      const chunk = Buffer.allocUnsafe(length);
      try {
        const bytesRead = readSync(fd, chunk, 0, length, position);
        if (bytesRead <= 0) throw new Error("artifact changed during streaming");
        position += bytesRead;
        controller.enqueue(chunk.subarray(0, bytesRead));
        if (position > end) {
          close();
          controller.close();
        }
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel() {
      close();
    },
  });
  return new Response(body, { status, headers: commonHeaders });
}

/**
 * Decode + validate base64 image bytes (alphabet, size, magic). Used by CCA
 * Images fallback before returning b64_json and by materializeInlineImage.
 */
export function decodeValidatedImageBase64(base64Data: string): Buffer {
  const normalized = base64Data.replace(/\s+/g, "");
  if (!BASE64_RE.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("inline image data is not valid base64");
  }
  if (normalized.length > MAX_ENCODED_BYTES_PER_IMAGE) {
    throw new Error(`inline image exceeds ${MAX_DECODED_BYTES_PER_IMAGE} byte per-image cap`);
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const decodedBytes = (normalized.length / 4) * 3 - padding;
  if (decodedBytes === 0) throw new Error("inline image data is empty after base64 decode");
  if (decodedBytes > MAX_DECODED_BYTES_PER_IMAGE) {
    throw new Error(`inline image exceeds ${MAX_DECODED_BYTES_PER_IMAGE} byte per-image cap`);
  }
  const buf = Buffer.from(normalized, "base64");
  guessExtFromMagic(buf);
  return buf;
}

/**
 * Best-effort retention cap: when the artifact directory holds more than `maxFiles`,
 * delete the oldest (by mtime) until the count is back under the limit. Synchronous
 * on purpose — it runs right after each successful write and touches at most a handful
 * of files. All errors are swallowed and logged so a prune failure never breaks an image write.
 */
export function pruneOldArtifacts(dir: string, maxFiles: number): void {
  const result = pruneMediaArtifacts({ dir, maxFiles });
  if (result.blocked && maxFiles > 0) {
    console.warn("[images] prune: artifact directory could not be read");
  }
}

function timestampPrefix(): string {
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

/**
 * Write a buffer to a unique artifact file using `flag: "wx"` (exclusive create).
 * Collisions on the random UUID suffix are astronomically unlikely, but `wx`
 * would surface them as EEXIST; retry a few times with a fresh UUID before
 * giving up so a fluke name clash can never fail an image write.
 */
async function writeArtifactUnique(
  dir: string,
  prefix: string,
  buf: Uint8Array,
  ext: string,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const suffix = attempt === 0 ? crypto.randomUUID() : `${crypto.randomUUID()}-${attempt}`;
    const filePath = join(dir, `${prefix}${timestampPrefix()}-${suffix}.${ext}`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(filePath, "wx", 0o600);
      if (process.platform === "win32") {
        hardenSecretPath(filePath, { required: true, timeoutMemoKey: `${dir}::artifact-file` });
      }
      await handle.writeFile(buf);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncArtifactDirectory(dir);
      return filePath;
    } catch (e) {
      if (handle) {
        try { await handle.close(); } catch { /* cleanup continues */ }
      }
      try { await unlink(filePath); } catch { /* absent or collision */ }
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "EEXIST" && attempt < 3) continue;
      throw e;
    }
  }
}

/** Sniff a recognized image extension, or null when the payload is empty/non-image. */
export function sniffImageExtension(bytes: Uint8Array): "png" | "jpg" | "webp" | "gif" | null {
  if (bytes.byteLength === 0) return null;
  const sig = Buffer.from(bytes.slice(0, 12)).toString("latin1");
  // Full 8-byte PNG signature (89 50 4E 47 0D 0A 1A 0A) — reject truncated/malformed prefixes.
  if (sig.startsWith("\x89PNG\r\n\x1a\n")) return "png";
  if (sig.startsWith("\xff\xd8\xff")) return "jpg";
  if (sig.startsWith("RIFF") && sig.slice(8, 12) === "WEBP") return "webp";
  if (sig.startsWith("GIF8")) return "gif";
  return null;
}

export function guessExtFromMagic(bytes: Uint8Array): string {
  const ext = sniffImageExtension(bytes);
  if (!ext) {
    throw new Error("unrecognized image format — magic bytes do not match PNG, JPEG, WebP, or GIF");
  }
  return ext;
}

/** Prune after a full image batch while preserving every artifact in the response being returned. */
export function pruneArtifacts(
  keepCount?: number,
  protectedArtifactIds: ReadonlySet<string> = new Set(),
): void {
  const maxFiles = keepCount ?? DEFAULT_ARTIFACT_KEEP_COUNT;
  const result = pruneMediaArtifacts({ dir: getArtifactsDir(), maxFiles, protectedArtifactIds });
  if (result.blocked && maxFiles > 0) {
    console.warn("[images] prune: artifact directory could not be read");
  }
}

export async function materializeInlineImage(
  base64Data: string,
  budget?: ImageBudget,
): Promise<string> {
  const dir = await ensureArtifactsDirectory();

  const buf = decodeValidatedImageBase64(base64Data);
  chargeImageBudget(budget, buf.length);

  // Sniff actual format from decoded bytes rather than trusting the declared mimeType.
  const ext = sniffImageExtension(buf);
  if (!ext) throw new Error("inline image data is not a recognized image");
  // Retention is post-batch via pruneArtifacts (see fulfill.ts) so a tight keepCount
  // cannot delete earlier images from the same call before their paths are returned.
  return writeArtifactUnique(dir, "img-", buf, ext);
}

/**
 * HTTPS GET that connects to a previously validated address while keeping the
 * original hostname for SNI / Host. The custom `lookup` never asks the OS
 * resolver again, so a rebinding answer cannot redirect the TCP peer.
 *
 * Returns a streaming Response so callers can enforce byte caps while reading;
 * the transport also destroys the request if `maxBytes` is exceeded mid-stream.
 */
function pickPinnedAddress(addresses: PinnedAddress[]): PinnedAddress {
  return addresses.find(a => a.family === 4) ?? addresses[0]!;
}

/** Delete one opaque artifact after its durable inspection record releases the pin. */
export async function removeArtifactById(id: string): Promise<boolean> {
  if (!ARTIFACT_ID_RE.test(id)) return false;
  const dir = resolve(getArtifactsDir());
  const candidate = resolve(dir, id);
  if (!candidate.startsWith(dir + sep)) return false;
  return removeMediaArtifact(dir, id);
}

/**
 * Exact deletion primitive for a capability artifact whose durable probe row already records
 * pending deletion. It deliberately bypasses generic pin release, revalidates the private file
 * identity immediately before unlink, and leaves journal finalization to the probe owner's CAS.
 */
export async function removePendingCapabilityArtifactById(id: string): Promise<boolean> {
  if (!ARTIFACT_ID_RE.test(id)) return false;
  const dir = resolve(getArtifactsDir());
  const candidate = resolve(dir, id);
  if (!candidate.startsWith(dir + sep)) return false;
  try {
    const observed = lstatSync(candidate);
    if (!privateArtifactFile(observed)) return false;
    const current = lstatSync(candidate);
    if (!privateArtifactFile(current) || !sameFileIdentity(observed, current)) return false;
    return unlinkMediaArtifactDurably(dir, id, {}, observed);
  } catch (error) {
    // A prior unlink-before-fsync attempt is completed only by durably syncing
    // the directory while the exact name remains absent.
    if (artifactFsErrorCode(error) === "ENOENT") return unlinkMediaArtifactDurably(dir, id);
    return false;
  }
}

export async function downloadImageToArtifact(
  url: string,
  budget?: ImageBudget,
  signal?: AbortSignal,
  options?: { pinnedDownload?: PinnedDownloadFn },
): Promise<string> {
  if (url.startsWith("data:")) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (!m) throw new Error("data URL is not a valid base64 image");
    return materializeInlineImage(m[2], budget);
  }

  // SSRF protection: validate the provider-returned URL before fetching.
  // Require HTTPS strictly — plain HTTP and all other schemes (ftp, file, …) are rejected.
  // Resolve DNS once, then pin that public address for the HTTPS connect (SNI/Host keep
  // the original hostname) so a rebinding answer cannot retarget the TCP peer.
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { throw new Error("image URL is not valid"); }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`image URL must use HTTPS, got ${parsedUrl.protocol}`);
  }
  // Reject literal private/loopback/link-local/metadata addresses.
  const assessment = assessUrlDestination(url);
  if (assessment && assessment.kind !== "public" && assessment.kind !== "hostname") {
    throw new Error(`image URL targets ${assessment.detail}`);
  }
  const resolved = await resolvePublicAddresses(url);
  const pinned = pickPinnedAddress(resolved.addresses);
  const download = options?.pinnedDownload ?? pinnedHttpsGet;
  const resp = await download(url, pinned, signal);
  if (!resp.ok) {
    // Custom `pinnedDownload` seams may still return a failed Response with a
    // live body; cancel it so unread error payloads cannot keep the socket warm.
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    throw new Error("image download failed: " + resp.status);
  }

  // Stream the body with a hard byte cap so a missing/lying Content-Length or a
  // compromised CDN URL cannot exhaust memory before the size check runs.
  if (!resp.body) throw new Error("image download returned no body");
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new Error(`image download exceeds ${MAX_DOWNLOAD_BYTES} byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore cancel errors */ }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }

  if (bytes.byteLength === 0) throw new Error("image download returned empty body");
  const ext = sniffImageExtension(bytes);
  if (!ext) throw new Error("image download did not contain a recognized image");

  chargeImageBudget(budget, bytes.length);

  const dir = await ensureArtifactsDirectory();

  // Retention is post-batch via pruneArtifacts (see fulfill.ts).
  return writeArtifactUnique(dir, "dl-", bytes, ext);
}

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
    !ARTIFACT_ID_RE.test(artifactId)
    || basename(artifactId) !== artifactId
    || artifactExtension(artifactId) !== ext
  ) throw new Error("video artifact reservation is invalid");
  return artifactId;
}

async function syncArtifactDirectory(dir: string): Promise<void> {
  // POSIX needs a directory fsync for rename durability. Windows does not expose
  // a portable directory handle through node:fs; its rename is committed by the
  // filesystem before the promise resolves.
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
  if (!ARTIFACT_ID_RE.test(artifactId) || artifactExtension(artifactId) !== ext || basename(artifactId) !== artifactId) {
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
  if (!ARTIFACT_ID_RE.test(artifactId) || basename(artifactId) !== artifactId) {
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

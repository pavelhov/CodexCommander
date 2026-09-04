import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { ARTIFACT_HTTP_PREFIX } from "../identity";

const MAX_DECODED_BYTES_PER_IMAGE = 50 * 1024 * 1024;
const MAX_DECODED_BYTES_PER_RESPONSE = 100 * 1024 * 1024;
/** Hard cap for an image artifact served from disk. */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

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

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(png|jpe?g|webp|gif)$/i;
const ARTIFACT_STREAM_CHUNK_BYTES = 256 * 1024;

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
function artifactExtension(id: string): "png" | "jpg" | "jpeg" | "webp" | "gif" | null {
  const ext = id.split(".").pop()?.toLowerCase();
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "gif"
    ? ext
    : null;
}

export function artifactContentType(id: string): string | null {
  const ext = artifactExtension(id);
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return null;
}

function privateArtifactDirectory(stats: Stats): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o777) === 0o700;
}

function privateArtifactFile(stats: Stats): boolean {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o777) === 0o600;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type ArtifactByteRange = { start: number; end: number };

function parseArtifactRange(value: string, size: number): ArtifactByteRange | null {
  if (/[^\x20-\x7e]/.test(value) || value.includes(",") || !/^bytes=/i.test(value)) return null;
  const match = /^(\d*)-(\d*)$/.exec(value.slice(6));
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

function closeQuietly(fd: number): void {
  try { closeSync(fd); } catch { /* already closed */ }
}

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
  const path = resolve(dir, id);
  if (!path.startsWith(dir + sep)) return null;
  let dirStats: Stats;
  let before: Stats;
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
      || !Number.isSafeInteger(stats.size)
      || stats.size <= 0
      || stats.size > MAX_DOWNLOAD_BYTES
    ) {
      closeQuietly(fd);
      return null;
    }
    const header = Buffer.alloc(Math.min(12, stats.size));
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    const sniffed = sniffImageExtension(header);
    if (bytesRead !== header.length || (sniffed !== ext && !(sniffed === "jpg" && ext === "jpeg"))) {
      closeQuietly(fd);
      return null;
    }
  } catch {
    closeQuietly(fd);
    return null;
  }

  const headers = new Headers({
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
      closeQuietly(fd);
      headers.set("content-range", `bytes */${stats.size}`);
      headers.set("content-length", "0");
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    start = range.start;
    end = range.end;
    headers.set("content-range", `bytes ${start}-${end}/${stats.size}`);
  }
  headers.set("content-length", String(end - start + 1));
  if (method === "HEAD") {
    closeQuietly(fd);
    return new Response(null, { status, headers });
  }

  let position = start;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeQuietly(fd);
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
  return new Response(body, { status, headers });
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
  // A non-positive maxFiles disables pruning entirely (do not delete everything).
  if (maxFiles <= 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.warn(`[images] prune: could not read ${dir}:`, e instanceof Error ? e.message : e);
    return;
  }
  if (entries.length <= maxFiles) return;

  let stats: Array<{ name: string; mtime: number }>;
  try {
    stats = entries.map(name => {
      const st = statSync(join(dir, name));
      return { name, mtime: st.mtimeMs };
    });
  } catch (e) {
    console.warn(`[images] prune: could not stat files in ${dir}:`, e instanceof Error ? e.message : e);
    return;
  }

  // Sort oldest-first, delete the excess.
  stats.sort((a, b) => a.mtime - b.mtime);
  const toDelete = stats.slice(0, stats.length - maxFiles);
  for (const { name } of toDelete) {
    try {
      unlinkSync(join(dir, name));
    } catch (e) {
      console.warn(`[images] prune: could not delete ${name}:`, e instanceof Error ? e.message : e);
    }
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
    try {
      await writeFile(filePath, buf, { mode: 0o600, flag: "wx" });
      if (process.platform === "win32" && !hardenSecretPath(filePath, { required: true }).ok) {
        throw new Error("artifact file ACL hardening failed");
      }
      return filePath;
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "EEXIST") {
        if (attempt < 3) continue;
        throw e;
      }
      // `writeFile` can leave a partially-written file when it fails after the
      // exclusive create succeeds. EEXIST is the one exception: that name was
      // already owned by a concurrent writer and must never be removed here.
      try { await unlink(filePath); } catch { /* absent or cleanup failed */ }
      throw e;
    }
  }
}

async function ensureArtifactsDirectory(): Promise<string> {
  const dir = getArtifactsDir();
  recordOwnedConfigPath(getConfigDir(), dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    if (!hardenSecretDir(dir, { required: true, timeoutMemoKey: `${dir}::artifacts` }).ok) {
      throw new Error("artifact directory ACL hardening failed");
    }
  } else {
    await chmod(dir, 0o700);
  }
  const stats = lstatSync(dir);
  if (!privateArtifactDirectory(stats)) throw new Error("artifact directory is unsafe");
  return dir;
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

/** Prune `CODEXCOMMANDER_HOME/artifacts` after a full image batch has been written. */
export function pruneArtifacts(keepCount?: number): void {
  pruneOldArtifacts(getArtifactsDir(), keepCount ?? DEFAULT_ARTIFACT_KEEP_COUNT);
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
  // Retention is post-batch so a tight keepCount
  // cannot delete earlier images from the same call before their paths are returned.
  return writeArtifactUnique(dir, "img-", buf, ext);
}

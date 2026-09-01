import { createHash } from "node:crypto";

import { mediaError } from "./media-errors";

export type MediaInputMimeType = "image/png" | "image/jpeg" | "image/webp";

/**
 * Execution-private bytes which have already been authorized by the current-turn egress envelope.
 * Source URLs, filenames, paths, and caller metadata are deliberately not representable.
 */
export interface AuthorizedMediaInput {
  readonly bytes: Uint8Array;
  readonly mimeType: MediaInputMimeType;
}

/** Metadata-minimized transport value. Raw bytes and source locators never enter this DTO. */
export interface MediaInputSnapshot {
  readonly mimeType: MediaInputMimeType;
  readonly dataUri: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
}

export interface MediaInputSnapshotLimits {
  readonly maxBytesPerImage: number;
  readonly maxAggregateDecodedBytes: number;
  readonly maxPixelsPerImage: number;
}

export const DEFAULT_MEDIA_INPUT_SNAPSHOT_LIMITS: MediaInputSnapshotLimits = Object.freeze({
  maxBytesPerImage: 20 * 1024 * 1024,
  maxAggregateDecodedBytes: 50 * 1024 * 1024,
  maxPixelsPerImage: 100_000_000,
});

function invalidSnapshot(): never {
  throw mediaError({
    code: "invalid_request",
    phase: "pre_dispatch",
    certainty: "definite",
  });
}

function boundedPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function checkedPixels(width: number, height: number, maxPixels: number): void {
  if (!boundedPositiveInteger(width) || !boundedPositiveInteger(height)) invalidSnapshot();
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 0) invalidSnapshot();
  if (width > Math.floor(maxPixels / height)) invalidSnapshot();
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let i = 0; i < length; i += 1) result += String.fromCharCode(bytes[offset + i]!);
  return result;
}

function canonicalPng(bytes: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) invalidSnapshot();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let outputLength = 8;
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  const retainedAncillary = new Set(["tRNS"]);
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) invalidSnapshot();
    const length = view.getUint32(offset, false);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) invalidSnapshot();
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) invalidSnapshot();
    if (!sawHeader && type !== "IHDR") invalidSnapshot();
    if (type === "IHDR") {
      if (sawHeader || length !== 13) invalidSnapshot();
      width = view.getUint32(offset + 8, false);
      height = view.getUint32(offset + 12, false);
      sawHeader = true;
    } else if (type === "IDAT") {
      sawImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData) invalidSnapshot();
      sawEnd = true;
    }
    const critical = type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
    if (critical || retainedAncillary.has(type)) {
      const chunk = bytes.subarray(offset, chunkEnd);
      parts.push(chunk);
      outputLength += chunk.length;
    }
    offset = chunkEnd;
    if (sawEnd) break;
  }
  if (!sawHeader || !sawImageData || !sawEnd) invalidSnapshot();
  return { bytes: concat(parts, outputLength), width, height };
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function canonicalJpeg(bytes: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalidSnapshot();
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let outputLength = 2;
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) invalidSnapshot();
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) invalidSnapshot();
    const marker = bytes[offset++]!;
    if (marker === 0xd9) break;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalidSnapshot();
    if (bytes.length - offset < 2) invalidSnapshot();
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) invalidSnapshot();
    const segmentStart = offset - 2;
    const segmentEnd = offset + segmentLength;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) invalidSnapshot();
      height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
    }
    if (marker === 0xda) {
      let scanEnd = segmentEnd;
      for (;;) {
        if (scanEnd + 1 >= bytes.length) invalidSnapshot();
        if (bytes[scanEnd] !== 0xff) {
          scanEnd += 1;
          continue;
        }
        const next = bytes[scanEnd + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          scanEnd += 2;
          continue;
        }
        if (next !== 0xd9) invalidSnapshot();
        const scan = bytes.subarray(segmentStart, scanEnd + 2);
        parts.push(scan);
        outputLength += scan.length;
        sawScan = true;
        offset = bytes.length;
        break;
      }
      break;
    }
    // APPn and COM hold EXIF/XMP/IPTC/comments, filenames, thumbnails, and unrelated metadata.
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!metadata) {
      const segment = bytes.subarray(segmentStart, segmentEnd);
      parts.push(segment);
      outputLength += segment.length;
    }
    offset = segmentEnd;
  }
  if (!width || !height || !sawScan) invalidSnapshot();
  return { bytes: concat(parts, outputLength), width, height };
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function canonicalWebp(bytes: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    invalidSnapshot();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredEnd = view.getUint32(4, true) + 8;
  if (declaredEnd !== bytes.length) invalidSnapshot();
  const chunks: Uint8Array[] = [];
  let chunksLength = 0;
  let offset = 12;
  let width = 0;
  let height = 0;
  let sawVisual = false;
  while (offset < declaredEnd) {
    if (declaredEnd - offset < 8) invalidSnapshot();
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const padded = length + (length & 1);
    const chunkEnd = offset + 8 + padded;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > declaredEnd) invalidSnapshot();
    const data = offset + 8;
    let retained = bytes.subarray(offset, chunkEnd);
    if (type === "VP8X") {
      if (length !== 10) invalidSnapshot();
      width = readUint24Le(bytes, data + 4) + 1;
      height = readUint24Le(bytes, data + 7) + 1;
      retained = bytes.slice(offset, chunkEnd);
      // Clear ICC, EXIF, and XMP presence bits after removing those chunks.
      retained[8] = retained[8]! & ~(0x20 | 0x08 | 0x04);
    } else if (type === "VP8 ") {
      if (length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
        invalidSnapshot();
      }
      width ||= ((bytes[data + 7]! << 8) | bytes[data + 6]!) & 0x3fff;
      height ||= ((bytes[data + 9]! << 8) | bytes[data + 8]!) & 0x3fff;
      sawVisual = true;
    } else if (type === "VP8L") {
      if (length < 5 || bytes[data] !== 0x2f) invalidSnapshot();
      width ||= 1 + bytes[data + 1]! + ((bytes[data + 2]! & 0x3f) << 8);
      height ||= 1 + (bytes[data + 2]! >> 6) + (bytes[data + 3]! << 2) + ((bytes[data + 4]! & 0x0f) << 10);
      sawVisual = true;
    } else if (type === "ANMF") {
      if (length < 16) invalidSnapshot();
      sawVisual = true;
    }
    if (type !== "EXIF" && type !== "XMP " && type !== "ICCP") {
      chunks.push(retained);
      chunksLength += retained.length;
    }
    offset = chunkEnd;
  }
  if (!width || !height || !sawVisual) invalidSnapshot();
  const output = new Uint8Array(12 + chunksLength);
  output.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(output.buffer).setUint32(4, output.length - 8, true);
  output.set(new TextEncoder().encode("WEBP"), 8);
  let writeOffset = 12;
  for (const chunk of chunks) {
    output.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  return { bytes: output, width, height };
}

function canonicalize(input: AuthorizedMediaInput): {
  bytes: Uint8Array;
  mimeType: MediaInputMimeType;
  width: number;
  height: number;
} {
  if (!(input?.bytes instanceof Uint8Array)) invalidSnapshot();
  let canonical: { bytes: Uint8Array; width: number; height: number };
  if (input.mimeType === "image/png") canonical = canonicalPng(input.bytes);
  else if (input.mimeType === "image/jpeg") canonical = canonicalJpeg(input.bytes);
  else if (input.mimeType === "image/webp") canonical = canonicalWebp(input.bytes);
  else invalidSnapshot();
  return { ...canonical, mimeType: input.mimeType };
}

/**
 * Materialize bounded private snapshots only after authorization. Aggregate and per-image limits
 * are checked against incoming decoded bytes before any canonical/base64 output allocation.
 */
export function snapshotAuthorizedMediaInputs(
  inputs: readonly AuthorizedMediaInput[],
  overrides: Partial<MediaInputSnapshotLimits> = {},
): readonly MediaInputSnapshot[] {
  if (!Array.isArray(inputs)) invalidSnapshot();
  const limits: MediaInputSnapshotLimits = { ...DEFAULT_MEDIA_INPUT_SNAPSHOT_LIMITS, ...overrides };
  if (!boundedPositiveInteger(limits.maxBytesPerImage)
    || !boundedPositiveInteger(limits.maxAggregateDecodedBytes)
    || !Number.isSafeInteger(limits.maxPixelsPerImage)
    || limits.maxPixelsPerImage < 0) invalidSnapshot();
  let aggregate = 0;
  for (const input of inputs) {
    if (!(input?.bytes instanceof Uint8Array) || input.bytes.byteLength > limits.maxBytesPerImage) invalidSnapshot();
    aggregate += input.bytes.byteLength;
    if (!Number.isSafeInteger(aggregate) || aggregate > limits.maxAggregateDecodedBytes) invalidSnapshot();
  }
  const result: MediaInputSnapshot[] = [];
  for (const input of inputs) {
    const canonical = canonicalize(input);
    checkedPixels(canonical.width, canonical.height, limits.maxPixelsPerImage);
    const digest = `sha256:${createHash("sha256").update(canonical.mimeType).update("\0").update(canonical.bytes).digest("hex")}`;
    result.push(Object.freeze({
      mimeType: canonical.mimeType,
      dataUri: `data:${canonical.mimeType};base64,${Buffer.from(canonical.bytes).toString("base64")}`,
      digest,
      byteLength: canonical.bytes.byteLength,
      width: canonical.width,
      height: canonical.height,
    }));
  }
  return Object.freeze(result);
}


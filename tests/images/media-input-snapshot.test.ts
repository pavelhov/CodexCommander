import { describe, expect, test } from "bun:test";

import {
  snapshotAuthorizedMediaInputs,
  type AuthorizedMediaInput,
} from "../../src/images/media-input-snapshot";

const PNG_1X1 = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

function withPngText(bytes: Uint8Array, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const chunk = new Uint8Array(12 + payload.length);
  new DataView(chunk.buffer).setUint32(0, payload.length);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(payload, 8);
  // The snapshot parser drops ancillary metadata without interpreting it. The CRC is
  // intentionally opaque here because provider egress must not retain this chunk.
  const iend = bytes.length - 12;
  const result = new Uint8Array(bytes.length + chunk.length);
  result.set(bytes.subarray(0, iend));
  result.set(chunk, iend);
  result.set(bytes.subarray(iend), iend + chunk.length);
  return result;
}

function jpegWithExif(text: string): Uint8Array {
  const metadata = new TextEncoder().encode(text);
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, 0x00, metadata.length + 2, ...metadata,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00, 0xff, 0xd9,
  ]);
}

function webpWithExif(text: string): Uint8Array {
  const metadata = new TextEncoder().encode(text);
  const metadataPadded = metadata.length + (metadata.length & 1);
  const output = new Uint8Array(12 + 8 + metadataPadded + 8 + 6);
  const view = new DataView(output.buffer);
  output.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, output.length - 8, true);
  output.set(new TextEncoder().encode("WEBP"), 8);
  output.set(new TextEncoder().encode("EXIF"), 12);
  view.setUint32(16, metadata.length, true);
  output.set(metadata, 20);
  const vp8l = 20 + metadataPadded;
  output.set(new TextEncoder().encode("VP8L"), vp8l);
  view.setUint32(vp8l + 4, 5, true);
  output.set([0x2f, 0, 0, 0, 0], vp8l + 8);
  return output;
}

describe("snapshotAuthorizedMediaInputs", () => {
  test("validates and metadata-minimizes authorized PNG bytes", () => {
    const sentinel = "private-filename-and-comment.png";
    const input: AuthorizedMediaInput = {
      bytes: withPngText(PNG_1X1, sentinel),
      mimeType: "image/png",
    };
    const [snapshot] = snapshotAuthorizedMediaInputs([input]);
    expect(snapshot).toMatchObject({
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    expect(snapshot!.dataUri).toStartWith("data:image/png;base64,");
    expect(Buffer.from(snapshot!.dataUri.split(",")[1]!, "base64").includes(sentinel)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(sentinel);
    expect(snapshot!.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("rejects MIME disagreement, per-image/aggregate bytes, and pixel excess", () => {
    expect(() => snapshotAuthorizedMediaInputs([{ bytes: PNG_1X1, mimeType: "image/jpeg" }]))
      .toThrow();
    expect(() => snapshotAuthorizedMediaInputs([
      { bytes: PNG_1X1, mimeType: "image/png" },
      { bytes: PNG_1X1, mimeType: "image/png" },
    ], { maxAggregateDecodedBytes: PNG_1X1.length }))
      .toThrow();
    expect(() => snapshotAuthorizedMediaInputs([
      { bytes: PNG_1X1, mimeType: "image/png" },
    ], { maxPixelsPerImage: 0 }))
      .toThrow();
  });

  test("strips JPEG APP metadata and WebP EXIF while retaining canonical visual containers", () => {
    const sentinel = "source-path/private-camera-name";
    const snapshots = snapshotAuthorizedMediaInputs([
      { bytes: jpegWithExif(sentinel), mimeType: "image/jpeg" },
      { bytes: webpWithExif(sentinel), mimeType: "image/webp" },
    ]);
    expect(snapshots.map(item => [item.mimeType, item.width, item.height])).toEqual([
      ["image/jpeg", 1, 1],
      ["image/webp", 1, 1],
    ]);
    for (const snapshot of snapshots) {
      expect(Buffer.from(snapshot.dataUri.split(",")[1]!, "base64").includes(sentinel)).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain(sentinel);
    }
  });

  test("rejects truncated PNG, JPEG, and WebP before base64 materialization", () => {
    for (const [bytes, mimeType] of [
      [PNG_1X1.subarray(0, 20), "image/png"],
      [jpegWithExif("x").subarray(0, 18), "image/jpeg"],
      [webpWithExif("x").subarray(0, 18), "image/webp"],
    ] as const) {
      expect(() => snapshotAuthorizedMediaInputs([{ bytes, mimeType }])).toThrow();
    }
  });
});

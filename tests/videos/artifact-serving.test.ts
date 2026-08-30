import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { getDefaultConfig, saveConfig } from "../../src/config";
import {
  artifactHttpUrl,
  createArtifactResponse,
  getArtifactsDir,
} from "../../src/images/artifacts";
import { startServer } from "../../src/server";

const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x0c]),
  Buffer.from("ftypisom", "ascii"),
  Buffer.from("0123456789abcdef", "ascii"),
]);
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from("webm-payload", "ascii"),
]);

const previousHome = process.env.CODEXCOMMANDER_HOME;
const previousToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccx-artifact-serving-"));
  process.env.CODEXCOMMANDER_HOME = root;
  process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "artifact-test-token";
  saveConfig({
    ...getDefaultConfig(),
    hostname: "0.0.0.0",
    clientIntegrations: { codex: false },
  });
  mkdirSync(getArtifactsDir(), { recursive: true, mode: 0o700 });
  chmodSync(getArtifactsDir(), 0o700);
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (previousToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = previousToken;
  await rm(root, { recursive: true, force: true });
});

function putArtifact(name: string, bytes: Uint8Array): string {
  const path = join(getArtifactsDir(), name);
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function authHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", "Bearer artifact-test-token");
  return headers;
}

describe("video-aware artifact data plane", () => {
  test.each([
    ["vid-full.mp4", MP4, "video/mp4"],
    ["vid-full.webm", WEBM, "video/webm"],
  ] as const)("serves authenticated full GET and HEAD for %s", async (name, bytes, mime) => {
    const path = putArtifact(name, bytes);
    const route = artifactHttpUrl(path);
    const server = startServer(0, { mediaRuntime: null });
    try {
      const denied = await fetch(new URL(route, server.url));
      expect(denied.status).toBe(401);

      const get = await fetch(new URL(route, server.url), { headers: authHeaders() });
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toBe(mime);
      expect(get.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect(get.headers.get("accept-ranges")).toBe("bytes");
      expect(Buffer.from(await get.arrayBuffer())).toEqual(Buffer.from(bytes));

      const head = await fetch(new URL(route, server.url), { method: "HEAD", headers: authHeaders() });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe(mime);
      expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect(head.headers.get("accept-ranges")).toBe("bytes");
      expect((await head.arrayBuffer()).byteLength).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("serves normal, open-ended, and suffix ranges and rejects malformed ranges", async () => {
    const path = putArtifact("vid-range.mp4", MP4);
    const route = artifactHttpUrl(path);
    const server = startServer(0, { mediaRuntime: null });
    try {
      const requestRange = (range: string) => fetch(new URL(route, server.url), {
        headers: authHeaders({ range }),
      });
      const normal = await requestRange("bytes=4-7");
      expect(normal.status).toBe(206);
      expect(normal.headers.get("content-range")).toBe(`bytes 4-7/${MP4.length}`);
      expect(normal.headers.get("content-length")).toBe("4");
      expect(await normal.text()).toBe("ftyp");

      const openEnded = await requestRange("bytes=8-");
      expect(openEnded.status).toBe(206);
      expect(openEnded.headers.get("content-range")).toBe(`bytes 8-${MP4.length - 1}/${MP4.length}`);

      const suffix = await requestRange("bytes=-4");
      expect(suffix.status).toBe(206);
      expect(await suffix.text()).toBe("cdef");

      for (const invalid of [
        "bytes=999-1000",
        "bytes=7-4",
        "bytes=0-1,4-5",
        "bytes=--1",
        "bytes=9007199254740992-",
        "items=0-1",
      ]) {
        const response = await requestRange(invalid);
        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe(`bytes */${MP4.length}`);
        expect(response.headers.get("content-length")).toBe("0");
      }
      const control = await createArtifactResponse(basename(path), "GET", "bytes=1-2\nignored");
      expect(control?.status).toBe(416);
      expect(control?.headers.get("content-range")).toBe(`bytes */${MP4.length}`);
    } finally {
      await server.stop(true);
    }
  });

  test("rejects methods, origins, nested paths, symlinks, hardlinks, and wrong magic", async () => {
    const path = putArtifact("vid-safe.mp4", MP4);
    const dir = getArtifactsDir();
    symlinkSync(path, join(dir, "vid-link.mp4"));
    linkSync(path, join(dir, "vid-hard.mp4"));
    putArtifact("vid-wrong.mp4", Buffer.from("not an mp4 payload", "ascii"));
    const server = startServer(0, { mediaRuntime: null });
    try {
      const base = new URL(artifactHttpUrl(path), server.url);
      const method = await fetch(base, { method: "POST", headers: authHeaders() });
      expect(method.status).toBe(405);
      expect(method.headers.get("allow")).toBe("GET, HEAD");

      const origin = await fetch(base, {
        headers: authHeaders({ origin: "https://attacker.invalid" }),
      });
      expect(origin.status).toBe(403);

      for (const suffix of [
        `${basename(path)}/nested`,
        "%2e%2e%2fvid-safe.mp4",
        "vid-link.mp4",
        "vid-hard.mp4",
        "vid-wrong.mp4",
      ]) {
        const response = await fetch(new URL(`/v1/codexcommander/artifacts/${suffix}`, server.url), {
          headers: authHeaders(),
        });
        expect(response.status).toBe(404);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("streams from one verified file identity even if the path is replaced before consumption", async () => {
    const path = putArtifact("vid-identity.mp4", MP4);
    const response = await createArtifactResponse("vid-identity.mp4", "GET", null);
    expect(response?.status).toBe(200);
    renameSync(path, `${path}.old`);
    putArtifact("vid-identity.mp4", Buffer.concat([MP4.subarray(0, 12), Buffer.from("replacement") ]));
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(MP4);
  });

  test("streams a large bounded video without changing its response contract", async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    MP4.copy(bytes, 0);
    const path = putArtifact("vid-large.mp4", bytes);
    const response = await createArtifactResponse(basename(path), "GET", null);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-length")).toBe(String(bytes.length));
    const reader = response!.body!.getReader();
    let chunks = 0;
    let received = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks += 1;
      received += value.byteLength;
      expect(value.byteLength).toBeLessThanOrEqual(256 * 1024);
    }
    expect(chunks).toBeGreaterThan(1);
    expect(received).toBe(bytes.length);
  });
});

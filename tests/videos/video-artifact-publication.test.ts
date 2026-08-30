import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

let nextResponse: () => Response = () => { throw new Error("test response is not configured"); };
mock.module("../../src/images/pinned-https-get", () => ({
  pinnedHttpsGet: async () => nextResponse(),
}));

const { downloadVideoToArtifact, reserveVideoArtifactId } = await import("../../src/images/artifacts");

const MP4_HEADER = new Uint8Array([
  0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);
const previousHome = process.env.CODEXCOMMANDER_HOME;
let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccx-video-publication-"));
  process.env.CODEXCOMMANDER_HOME = root;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

async function waitForOneEntry(dir: string): Promise<string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    if (entries.length > 0) return entries;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("video writer did not create its private work file");
}

describe("atomic video artifact publication", () => {
  test("streaming keeps only a temp name visible until atomic final publication", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    nextResponse = () => new Response(new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(MP4_HEADER);
      },
    }), { status: 200 });

    const pending = downloadVideoToArtifact("https://93.184.216.34/video");
    const artifactDir = join(root, "artifacts");
    const duringWrite = await waitForOneEntry(artifactDir);
    controller.close();
    const published = await pending;

    expect(duringWrite.some(name => /\.(?:mp4|webm)$/i.test(name))).toBe(false);
    expect(duringWrite.some(name => name.endsWith(".tmp"))).toBe(true);
    expect(await readdir(artifactDir)).toEqual([basename(published)]);
    expect(published).toMatch(/\.mp4$/);
  });

  test("a stream failure after a partial write removes the temp and publishes no final artifact", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    nextResponse = () => new Response(new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(MP4_HEADER);
      },
    }), { status: 200 });

    const pending = downloadVideoToArtifact("https://93.184.216.34/video");
    const artifactDir = join(root, "artifacts");
    await waitForOneEntry(artifactDir);
    controller.error(new Error("simulated stream loss"));
    await expect(pending).rejects.toThrow("simulated stream loss");
    expect(await readdir(artifactDir)).toEqual([]);
  });

  test("data URI publication leaves one validated final artifact and no temp", async () => {
    const encoded = Buffer.from(MP4_HEADER).toString("base64");
    const published = await downloadVideoToArtifact(`data:video/mp4;base64,${encoded}`);
    expect(await readdir(join(root, "artifacts"))).toEqual([basename(published)]);
    expect(published).toMatch(/\.mp4$/);
  });

  test.each([
    ["empty", new Uint8Array(0), /empty/],
    ["wrong magic", new TextEncoder().encode("not-video-data"), /magic|format/],
  ] as const)("rejects %s bodies and leaves no partial", async (_name, bytes, message) => {
    nextResponse = () => new Response(bytes, { status: 200 });
    await expect(downloadVideoToArtifact("https://93.184.216.34/signed-result"))
      .rejects.toThrow(message);
    expect(await readdir(join(root, "artifacts"))).toEqual([]);
  });

  test("rejects redirects and private result targets without retaining signed URL text", async () => {
    nextResponse = () => new Response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/private" },
    });
    let redirectError = "";
    try {
      await downloadVideoToArtifact("https://93.184.216.34/private-token-value");
    } catch (error) {
      redirectError = error instanceof Error ? error.message : String(error);
    }
    expect(redirectError).toMatch(/failed|302/);
    expect(redirectError).not.toContain("private-token-value");
    await expect(downloadVideoToArtifact("https://127.0.0.1/result"))
      .rejects.toThrow(/loopback/);
  });

  test("an aborted replacement never deletes a prior valid reserved artifact", async () => {
    const artifactId = reserveVideoArtifactId("mp4");
    const encoded = Buffer.from(MP4_HEADER).toString("base64");
    const published = await downloadVideoToArtifact(
      `data:video/mp4;base64,${encoded}`,
      undefined,
      undefined,
      { reservedArtifactId: artifactId },
    );
    const before = await Bun.file(published).arrayBuffer();

    nextResponse = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(MP4_HEADER);
      },
    }), { status: 200 });
    // The already durable exact reservation wins without replacement.
    expect(await downloadVideoToArtifact(
      "https://93.184.216.34/signed-result",
      undefined,
      undefined,
      { reservedArtifactId: artifactId },
    )).toBe(published);
    expect(await Bun.file(published).arrayBuffer()).toEqual(before);
    expect(await readdir(join(root, "artifacts"))).toEqual([artifactId]);
  });
});

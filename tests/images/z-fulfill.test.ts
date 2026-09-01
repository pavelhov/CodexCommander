import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { ImageBridgePlan } from "../../src/images/types";
import type { XaiImageRequest } from "../../src/images/xai-client";
import { mediaError } from "../../src/images/media-errors";
import { pruneMediaArtifacts, registerArtifactPinAuthority } from "../../src/images/artifact-retention";

const PREV_HOME = process.env.CODEXCOMMANDER_HOME;
let fulfillImageCall: typeof import("../../src/images/fulfill")["fulfillImageCall"];
let imageFulfillmentTailSnapshot: typeof import("../../src/images/fulfill")["imageFulfillmentTailSnapshot"];
let safeMediaToolResult: typeof import("../../src/images/fulfill")["safeMediaToolResult"];
let testHome = "";

beforeAll(async () => {
  testHome = join(tmpdir(), "ccx-test-" + randomUUID());
  process.env.CODEXCOMMANDER_HOME = testHome;
  mock.restore();
  const actualArtifacts = await import("../../src/images/artifacts");
  mock.module("../../src/images/xai-client", () => ({
    callXaiImages: async (req: XaiImageRequest, _auth: unknown, _signal?: AbortSignal, timeoutMs?: number) => {
      xaiCalls.push(req);
      capturedTimeoutMs = timeoutMs;
      if (xaiError) throw xaiError;
      return xaiResult;
    },
  }));
  mock.module("../../src/images/artifacts", () => ({
    ...actualArtifacts,
    artifactHttpUrl: (path: string) => `/v1/codexcommander/artifacts/${path.split(/[\\/]/).at(-1)}`,
    createImageBudget: () => ({ spent: 0 }),
    getArtifactsDir: () => join(testHome, "artifacts"),
    materializeInlineImage: async () => materializeFn(matIdx++),
    downloadImageToArtifact: async () => downloadFn(dlIdx++),
    pruneArtifacts: (keepCount?: number) => pruneImpl(keepCount),
    resolveArtifactPath: (id: string) => join(testHome, "artifacts", id),
  }));
  ({
    fulfillImageCall,
    imageFulfillmentTailSnapshot,
    safeMediaToolResult,
  } = await import(`../../src/images/fulfill?fulfill=${Date.now()}`));
});
afterAll(() => { if (PREV_HOME === undefined) delete process.env.CODEXCOMMANDER_HOME; else process.env.CODEXCOMMANDER_HOME = PREV_HOME; mock.restore(); });

// --- Mutable mock state (reset() restores defaults before each test) ---
let xaiResult: { images: Array<{ b64_json?: string; url?: string }> } = { images: [{ b64_json: "dGVzdA==" }] };
let xaiError: Error | null = null;
const xaiCalls: XaiImageRequest[] = [];
let matIdx = 0;
let dlIdx = 0;
let pruneCalls = 0;
let pruneImpl: (keepCount?: number) => void = () => { pruneCalls++; };
let materializeFn: (i: number) => Promise<string> = async (i) => touchArtifact(`img-${i}.png`);
let downloadFn: (i: number) => Promise<string> = async (i) => touchArtifact(`dl-${i}.png`);

let capturedTimeoutMs: number | undefined;

function touchArtifact(name: string): string {
  const dir = join(testHome || process.env.CODEXCOMMANDER_HOME!, "artifacts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "x");
  return path;
}

const plan = {
  auth: {
    authSource: "api_key",
    providerKind: "canonical",
    slotRef: "media-slot:test",
    identityDigest: "sha256:test",
  },
  model: "grok-imagine-image-2.0",
  toolNames: new Set(["image_gen"]),
} as ImageBridgePlan;

function reset(): void {
  xaiResult = { images: [{ b64_json: "dGVzdA==" }] };
  xaiError = null;
  xaiCalls.length = 0;
  capturedTimeoutMs = undefined;
  matIdx = 0;
  dlIdx = 0;
  pruneCalls = 0;
  pruneImpl = () => { pruneCalls++; };
  materializeFn = async (i) => touchArtifact(`img-${i}.png`);
  downloadFn = async (i) => touchArtifact(`dl-${i}.png`);
}

describe("fulfillImageCall", () => {
  test("provider-safe result serialization omits every private/internal field", () => {
    const privatePath = touchArtifact("img-safe-result.png");
    const serialized = JSON.stringify(safeMediaToolResult({
      ok: true,
      model: "private-model-sentinel",
      prompt: "private-prompt-sentinel",
      path: privatePath,
      files: [privatePath],
      count: 1,
      jobId: "must-not-enter-image-results",
      markdown: `![image](file://${privatePath})`,
    }, "image"));
    expect(JSON.parse(serialized)).toEqual({
      ok: true,
      status: "completed",
      artifacts: ["/v1/codexcommander/artifacts/img-safe-result.png"],
      markdown: "![image](/v1/codexcommander/artifacts/img-safe-result.png)",
    });
    expect(serialized).not.toContain("/Users/test/");
    expect(serialized).not.toContain('"path"');
    expect(serialized).not.toContain('"files"');
    expect(serialized).not.toContain("private-model-sentinel");
    expect(serialized).not.toContain("private-prompt-sentinel");
    expect(serialized).not.toContain("file://");

    const externalPath = "/Users/test/private/home-user-sentinel.png";
    const external = JSON.stringify(safeMediaToolResult({
      ok: true,
      model: "private-model",
      prompt: "private-prompt",
      path: externalPath,
      files: [externalPath],
      count: 1,
    }, "image"));
    expect(JSON.parse(external)).toEqual({ ok: true, status: "completed" });
    expect(external).not.toContain("home-user-sentinel");
  });

  test("provider-safe failures collapse raw errors to an opaque status", () => {
    const serialized = JSON.stringify(safeMediaToolResult({
      ok: false,
      model: "private-model",
      prompt: "private-prompt",
      files: [],
      count: 0,
      error: "download failed for https://provider.invalid/result?token=must-not-leak",
    }, "video"));
    expect(JSON.parse(serialized)).toEqual({ ok: false, status: "failed" });
    expect(serialized).not.toContain("provider.invalid");
    expect(serialized).not.toContain("must-not-leak");
  });

  test("provider-safe video recovery results retain only bounded local job ids", () => {
    for (const [error, status] of [
      ["video_busy: another video job is active", "busy"],
      ["video_detached: generation continues", "detached"],
      ["video job ended in state failed", "failed"],
    ] as const) {
      expect(safeMediaToolResult({
        ok: false,
        model: "private-model",
        prompt: "private-prompt",
        files: [],
        count: 0,
        jobId: "018f0f51-9db8-7f42-a9d8-4b9dfbd26e0f",
        error,
      }, "video")).toEqual({
        ok: false,
        status,
        jobId: "018f0f51-9db8-7f42-a9d8-4b9dfbd26e0f",
      });
    }

    const base = {
      model: "private-model",
      prompt: "private-prompt",
      files: [],
      count: 0,
      jobId: "local-job-id",
    };
    expect(safeMediaToolResult({ ...base, ok: false, error: "video_busy" }, "image"))
      .toEqual({ ok: false, status: "busy" });
    expect(safeMediaToolResult({ ...base, ok: false, error: "video artifact is unavailable locally" }, "video"))
      .toEqual({ ok: false, status: "artifact_unavailable" });
    const completedPath = touchArtifact("completed-video.mp4");
    expect(safeMediaToolResult({ ...base, ok: true, files: [completedPath], path: completedPath }, "video"))
      .toEqual({
        ok: true,
        status: "completed",
        artifacts: ["/v1/codexcommander/artifacts/completed-video.mp4"],
        markdown: "[Open video](/v1/codexcommander/artifacts/completed-video.mp4)",
      });
    expect(safeMediaToolResult({
      ...base,
      ok: false,
      jobId: `local-${"x".repeat(64)}`,
      error: "video_detached",
    }, "video")).toEqual({ ok: false, status: "detached" });
    expect(safeMediaToolResult({
      ...base,
      ok: false,
      jobId: "https://provider.invalid/private",
      error: "video job ended in state failed",
    }, "video")).toEqual({ ok: false, status: "failed" });

    const outcomeUnknown = {
      ...base,
      ok: false,
      jobId: "018f0f51-9db8-7f42-a9d8-4b9dfbd26e0f",
      error: "submission_outcome_unknown: https://provider.invalid/result?token=must-not-leak",
      path: "/private/local/video.mp4",
      artifactId: "private-artifact-id",
      credential: "private-credential",
    };
    expect(safeMediaToolResult(outcomeUnknown, "video")).toEqual({
      ok: false,
      status: "submission_outcome_unknown",
      jobId: "018f0f51-9db8-7f42-a9d8-4b9dfbd26e0f",
    });
  });

  test("valid args → ok:true with file", async () => {
    reset();
    const r = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat", n: 2 }) },
      plan, { spent: 0 },
    );
    expect(r.ok).toBe(true);
    expect(r.files.length).toBe(1);
  });

  test("plan.timeoutMs is forwarded to callXaiImages", async () => {
    reset();
    const timedPlan = { ...plan, timeoutMs: 12_345 } as ImageBridgePlan;
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat" }) },
      timedPlan, { spent: 0 },
    );
    expect(capturedTimeoutMs).toBe(12_345);
  });

  test("missing prompt → ok:false 'missing prompt'", async () => {
    reset();
    const r = await fulfillImageCall({ id: "c1", name: "image_gen", arguments: "{}" }, plan, { spent: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing prompt");
  });

  test("invalid JSON args → ok:false 'invalid arguments JSON'", async () => {
    reset();
    const r = await fulfillImageCall({ id: "c1", name: "image_gen", arguments: "{bad" }, plan, { spent: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid arguments JSON");
  });

  test("xAI throws → ok:false with error message", async () => {
    reset();
    xaiError = new Error("xAI images API returned 500");
    const r = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x" }) }, plan, { spent: 0 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("500");
  });

  test("ambiguous xAI submission preserves certainty as a typed no-replay result", async () => {
    reset();
    xaiError = mediaError({
      code: "ambiguous_submission",
      phase: "submit",
      certainty: "ambiguous",
      reason: "network",
    });
    const r = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x" }) }, plan, { spent: 0 },
    );
    expect(r).toMatchObject({
      ok: false,
      error: "submission_outcome_unknown",
      dispatchCertainty: "ambiguous",
    });
  });

  test("b64_json result → materialized via materializeInlineImage", async () => {
    reset();
    xaiResult = { images: [{ b64_json: "dGVzdA==" }] };
    await fulfillImageCall({ id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` }, plan, { spent: 0 });
    expect(matIdx).toBe(1);
    expect(dlIdx).toBe(0);
  });

  test("URL result → materialized via downloadImageToArtifact", async () => {
    reset();
    xaiResult = { images: [{ url: "https://cdn.example.com/i.png" }] };
    await fulfillImageCall({ id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` }, plan, { spent: 0 });
    expect(dlIdx).toBe(1);
    expect(matIdx).toBe(0);
  });

  test("all images fail → ok:false", async () => {
    reset();
    xaiResult = { images: [{ b64_json: "invalid-provider-bytes" }, { url: "https://cdn.example.com/i.png" }] };
    materializeFn = async () => { throw new Error("invalid inline image"); };
    downloadFn = async () => { throw new Error("disk full"); };
    const r = await fulfillImageCall({ id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` }, plan, { spent: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("image artifact unavailable after provider completion");
    expect(r.paidSubmissionConsumed).toBe(true);
    expect(safeMediaToolResult(r, "image")).toEqual({ ok: false, status: "artifact_unavailable" });
    expect(matIdx).toBe(1);
    expect(dlIdx).toBe(1);
  });

  test("one of two images fails → ok:true with 1 file", async () => {
    reset();
    xaiResult = { images: [{ b64_json: "AAA=" }, { b64_json: "QkI=" }] };
    materializeFn = async (i) => { if (i === 1) throw new Error("partial fail"); return touchArtifact(`img-${i}.png`); };
    const r = await fulfillImageCall({ id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` }, plan, { spent: 0 });
    expect(r.ok).toBe(true);
    expect(r.files.length).toBe(1);
    expect(r.paidSubmissionConsumed).toBe(true);
  });

  test("prunes once after the full batch and omits deleted paths", async () => {
    reset();
    const { unlinkSync } = await import("node:fs");
    xaiResult = { images: [{ b64_json: "AAA=" }, { b64_json: "QkI=" }] };
    const written: string[] = [];
    materializeFn = async (i) => {
      const path = touchArtifact(`batch-${i}.png`);
      written.push(path);
      return path;
    };
    pruneImpl = () => {
      pruneCalls++;
      unlinkSync(written[0]!);
    };
    const r = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` },
      { ...plan, artifactsKeepCount: 1 } as ImageBridgePlan,
      { spent: 0 },
    );
    expect(pruneCalls).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([written[1]]);
    expect(r.path).toBe(written[1]);
  });

  test("concurrent paid batches protect unregistered bytes and each other under older-pin pressure", async () => {
    reset();
    const artifactsDir = join(testHome, "artifacts");
    const olderPinnedId = "older-durable-video.mp4";
    const olderPinned = touchArtifact(olderPinnedId);
    const oldSeconds = (Date.now() - 60_000) / 1_000;
    const { utimesSync } = await import("node:fs");
    utimesSync(olderPinned, oldSeconds, oldSeconds);
    const unregisterPin = registerArtifactPinAuthority({
      protectedArtifactIds: () => new Set([olderPinnedId]),
      releaseArtifactForPrune: () => "protected",
    });
    let secondWritten!: () => void;
    const secondWrittenPromise = new Promise<void>(resolve => { secondWritten = resolve; });
    let releaseSecond!: () => void;
    const releaseSecondPromise = new Promise<void>(resolve => { releaseSecond = resolve; });
    const written: string[] = [];
    materializeFn = async (index) => {
      const path = touchArtifact(`concurrent-${index}.png`);
      written.push(path);
      if (index === 1) {
        secondWritten();
        await releaseSecondPromise;
      }
      return path;
    };
    pruneImpl = (keepCount = 1) => {
      pruneCalls += 1;
      pruneMediaArtifacts({ dir: artifactsDir, maxFiles: keepCount });
    };
    const concurrentPlan = { ...plan, artifactsKeepCount: 1 } as ImageBridgePlan;
    const first = fulfillImageCall(
      { id: "concurrent-a", name: "image_gen", arguments: `{"prompt":"a"}` },
      concurrentPlan,
      { spent: 0 },
    );
    const second = fulfillImageCall(
      { id: "concurrent-b", name: "image_gen", arguments: `{"prompt":"b"}` },
      concurrentPlan,
      { spent: 0 },
    );
    try {
      await secondWrittenPromise;
      // The second file exists but its materializer has deliberately not returned its path yet.
      // Any unrelated retention pass in this window must fail safe.
      expect(pruneMediaArtifacts({ dir: artifactsDir, maxFiles: 1 }).prunedArtifactIds).toEqual([]);
      expect(written.every(path => existsSync(path))).toBe(true);
      releaseSecond();
      const results = await Promise.all([first, second]);
      expect(results.every(result => result.ok)).toBe(true);
      expect(written.every(path => existsSync(path))).toBe(true);
      expect(pruneCalls).toBe(2);
    } finally {
      releaseSecond();
      unregisterPin();
      await Promise.allSettled([first, second]);
    }
  });

  test("forwards prompt, model, and n to callXaiImages", async () => {
    reset();
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat", n: 2 }) },
      plan, { spent: 0 },
    );
    expect(xaiCalls.length).toBe(1);
    expect(xaiCalls[0]!.prompt).toBe("a cat");
    expect(xaiCalls[0]!.model).toBe(plan.model);
    expect(xaiCalls[0]!.n).toBe(2);
  });

  test("rejects n > 4 before provider dispatch", async () => {
    reset();
    const result = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x", n: 100 }) },
      plan, { spent: 0 },
    );
    expect(result).toMatchObject({ ok: false, count: 0, error: "image count must be an integer from 1 through 4" });
    expect(xaiCalls).toHaveLength(0);
  });

  test("image_url edit input is rejected before xAI dispatch", async () => {
    reset();
    const result = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x", image_url: "https://example.com/i.png" }) },
      plan, { spent: 0 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("grok_image_edits_unsupported");
    expect(xaiCalls).toHaveLength(0);
  });

  test("plan.defaultSize and defaultQuality fill omitted args", async () => {
    reset();
    const sizedPlan = {
      ...plan,
      defaultSize: "1024x1024",
      defaultQuality: "hd",
    } as ImageBridgePlan;
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat" }) },
      sizedPlan, { spent: 0 },
    );
    expect(xaiCalls[0]!.size).toBe("1024x1024");
    expect(xaiCalls[0]!.quality).toBe("hd");
  });

  test("explicit size/quality override plan defaults", async () => {
    reset();
    const sizedPlan = {
      ...plan,
      defaultSize: "1024x1024",
      defaultQuality: "hd",
    } as ImageBridgePlan;
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat", size: "512x512", quality: "standard" }) },
      sizedPlan, { spent: 0 },
    );
    expect(xaiCalls[0]!.size).toBe("512x512");
    expect(xaiCalls[0]!.quality).toBe("standard");
  });

  test("markdown uses a file: URI for Windows-safe destinations", async () => {
    reset();
    const r = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat" }) },
      plan, { spent: 0 },
    );
    expect(r.ok).toBe(true);
    expect(r.path).toBeDefined();
    expect(r.markdown).toMatch(/^!\[image\]\(file:\/\//);
    expect(r.files[0]).toBe(r.path);
    expect(r.markdown).not.toContain("\\");
  });

  test("image fulfillment 65 returns busy before provider or artifact work and reports path bytes", async () => {
    reset();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    materializeFn = async (i) => {
      await gate;
      return touchArtifact(`bounded-${i}.png`);
    };
    const calls = Array.from({ length: 64 }, (_, index) => fulfillImageCall(
      { id: `call-${index}`, name: "image_gen", arguments: JSON.stringify({ prompt: `image-${index}` }) },
      plan,
      { spent: 0 },
    ));
    while (xaiCalls.length < 64) await Bun.sleep(1);
    const snapshot = imageFulfillmentTailSnapshot();
    expect(snapshot.active).toBe(64);
    expect(snapshot.currentBytes).toBeGreaterThan(0);
    const busy = await fulfillImageCall(
      { id: "call-65", name: "image_gen", arguments: JSON.stringify({ prompt: "must-not-run" }) },
      plan,
      { spent: 0 },
    );
    expect(busy.error).toBe("image_fulfillment_busy");
    expect(xaiCalls.length).toBe(64);
    release();
    await Promise.all(calls);
    expect(imageFulfillmentTailSnapshot().active).toBe(0);
  });
});

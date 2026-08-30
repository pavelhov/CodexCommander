import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";

const PREV_HOME = process.env.CODEXCOMMANDER_HOME;
beforeAll(() => { process.env.CODEXCOMMANDER_HOME = join(tmpdir(), "ccx-prune-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.CODEXCOMMANDER_HOME; else process.env.CODEXCOMMANDER_HOME = PREV_HOME; });

const { pruneOldArtifacts, pruneArtifacts, DEFAULT_ARTIFACT_KEEP_COUNT } = await import("../../src/images/artifacts");
const {
  pruneMediaArtifacts,
  registerArtifactPinAuthority,
} = await import("../../src/images/artifact-retention");

function touch(path: string, content: string = "x", ageMs = 0): void {
  writeFileSync(path, content);
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(path, t, t);
  }
}

// Minimal valid 1×1 PNG (full 8-byte signature).
const MIN_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("pruneOldArtifacts", () => {
  test("count <= maxFiles → no deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-keep-"));
    for (let i = 0; i < 5; i++) touch(join(dir, `f${i}.png`));
    pruneOldArtifacts(dir, 10);
    expect(readdirSync(dir).length).toBe(5);
  });

  test("count > maxFiles → oldest deleted until under limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-trim-"));
    for (let i = 0; i < 10; i++) {
      touch(join(dir, `f${i}.png`), "data", (10 - i) * 1000);
    }
    pruneOldArtifacts(dir, 5);
    const remaining = readdirSync(dir);
    expect(remaining.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(remaining).not.toContain(`f${i}.png`);
    }
    for (let i = 5; i < 10; i++) {
      expect(remaining).toContain(`f${i}.png`);
    }
  });

  test("maxFiles <= 0 disables pruning (does not wipe directory)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-disable-"));
    for (let i = 0; i < 4; i++) touch(join(dir, `f${i}.png`));
    pruneOldArtifacts(dir, 0);
    expect(readdirSync(dir).length).toBe(4);
    pruneOldArtifacts(dir, -1);
    expect(readdirSync(dir).length).toBe(4);
  });

  test("nonexistent dir → logs warn, no throw", () => {
    expect(() => pruneOldArtifacts(join(tmpdir(), "does-not-exist-" + randomUUID()), 10)).not.toThrow();
  });

  test("default keep count is 200", () => {
    expect(DEFAULT_ARTIFACT_KEEP_COUNT).toBe(200);
  });
});

describe("pruneArtifacts: integration with materializeInlineImage", () => {
  test("writing >keepCount images then pruning keeps newest", async () => {
    const { materializeInlineImage } = await import("../../src/images/artifacts");
    const KEEP = 3;
    const TOTAL = 6;
    const written: string[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const path = await materializeInlineImage(MIN_PNG_B64);
      written.push(path);
      await new Promise(r => setTimeout(r, 5));
    }
    pruneArtifacts(KEEP);
    const dir = dirname(written[0]!);
    const remaining = readdirSync(dir);
    expect(remaining.length).toBe(KEEP);
    for (let i = 0; i < TOTAL; i++) {
      const fname = basename(written[i]!);
      const shouldExist = i >= TOTAL - KEEP;
      expect(remaining.includes(fname)).toBe(shouldExist);
      expect(existsSync(written[i]!)).toBe(shouldExist);
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test("mixed image/video retention preserves pins and reports deliberate pruning", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-mixed-"));
    touch(join(dir, "vid-pinned.mp4"), "pinned", 10_000);
    touch(join(dir, "img-old.png"), "old", 9_000);
    touch(join(dir, "vid-old.webm"), "old-video", 8_000);
    touch(join(dir, "img-recent.png"), "recent", 1_000);
    const reported: string[] = [];
    const result = pruneMediaArtifacts({
      dir,
      maxFiles: 2,
      protectedArtifactIds: new Set(["vid-pinned.mp4"]),
      onArtifactPruned: id => { reported.push(id); },
    });
    expect(readdirSync(dir).sort()).toEqual(["img-recent.png", "vid-pinned.mp4"]);
    expect(result.prunedArtifactIds.sort()).toEqual(["img-old.png", "vid-old.webm"]);
    expect(reported.sort()).toEqual(result.prunedArtifactIds.sort());
  });

  test("registered pin authorities protect video ids from legacy image prune callers", () => {
    const dir = getArtifactsDirForTest();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    touch(join(dir, "vid-job.mp4"), "video", 10_000);
    touch(join(dir, "img-new.png"), "image", 1_000);
    const unregister = registerArtifactPinAuthority({
      protectedArtifactIds: () => new Set(["vid-job.mp4"]),
    });
    try {
      pruneArtifacts(1);
      expect(readdirSync(dir)).toContain("vid-job.mp4");
    } finally {
      unregister();
    }
  });

  test("stale private temp files are cleaned without following symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-temp-"));
    const old = join(dir, ".ccx-video-stale.tmp");
    touch(old, "partial", 60_000);
    const outside = join(dir, "outside.txt");
    touch(outside, "outside");
    symlinkSync(outside, join(dir, ".ccx-video-link.tmp"));
    const result = pruneMediaArtifacts({ dir, maxFiles: 10, staleTempAgeMs: 1_000, now: Date.now() });
    expect(result.removedStaleTemps).toEqual([".ccx-video-stale.tmp"]);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(dir, ".ccx-video-link.tmp"))).toBe(true);
  });

  test("stale temp cleanup repairs a crash between no-replace link and temp unlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-linked-temp-"));
    const temp = join(dir, ".ccx-video-published.tmp");
    const final = join(dir, "vid-recovered.mp4");
    touch(temp, "durable-video", 60_000);
    linkSync(temp, final);
    expect(lstatSync(final).nlink).toBe(2);
    const result = pruneMediaArtifacts({ dir, maxFiles: 10, staleTempAgeMs: 1_000, now: Date.now() });
    expect(result.removedStaleTemps).toEqual([".ccx-video-published.tmp"]);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(final)).toBe(true);
    expect(lstatSync(final).nlink).toBe(1);
  });
});

function getArtifactsDirForTest(): string {
  return join(process.env.CODEXCOMMANDER_HOME!, "artifacts");
}

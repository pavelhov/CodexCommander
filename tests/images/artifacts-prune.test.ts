import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";

const PREV_HOME = process.env.CODEXCOMMANDER_HOME;
beforeAll(() => { process.env.CODEXCOMMANDER_HOME = join(tmpdir(), "ccx-prune-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.CODEXCOMMANDER_HOME; else process.env.CODEXCOMMANDER_HOME = PREV_HOME; });

const {
  adoptReservedVideoArtifact,
  pruneOldArtifacts,
  pruneArtifacts,
  DEFAULT_ARTIFACT_KEEP_COUNT,
} = await import("../../src/images/artifacts");
const {
  pruneMediaArtifacts,
  removeMediaArtifact,
  registerArtifactPinAuthority,
} = await import("../../src/images/artifact-retention");
const { beginImageArtifactMaterialization } = await import("../../src/images/fulfill");

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
const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

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

  test("rejects an existing artifact-directory symlink without deleting its target", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-dir-symlink-"));
    const outside = join(root, "outside");
    const artifacts = join(root, "artifacts");
    mkdirSync(outside, { mode: 0o700 });
    touch(join(outside, "img-old.png"), "outside-old", 10_000);
    touch(join(outside, "img-new.png"), "outside-new", 1_000);
    symlinkSync(outside, artifacts, process.platform === "win32" ? "junction" : "dir");
    try {
      const result = pruneMediaArtifacts({ dir: artifacts, maxFiles: 1 });
      expect(result.blocked).toBe(true);
      expect(removeMediaArtifact(artifacts, "img-old.png")).toBe(false);
      expect(existsSync(join(outside, "img-old.png"))).toBe(true);
      expect(existsSync(join(outside, "img-new.png"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory swap before unlink cannot redirect deletion outside the anchored directory", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-dir-swap-"));
    const artifacts = join(root, "artifacts");
    const outside = join(root, "outside");
    const displaced = join(root, "displaced-artifacts");
    mkdirSync(artifacts, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    touch(join(artifacts, "img-old.png"), "owned-old", 10_000);
    touch(join(artifacts, "img-new.png"), "owned-new", 1_000);
    touch(join(outside, "img-old.png"), "outside-old", 10_000);
    touch(join(outside, "img-new.png"), "outside-new", 1_000);
    let swapped = false;
    try {
      const result = pruneMediaArtifacts({
        dir: artifacts,
        maxFiles: 1,
        io: {
          beforeUnlinkFile: () => {
            if (swapped) return;
            swapped = true;
            renameSync(artifacts, displaced);
            renameSync(outside, artifacts);
          },
        },
      });
      expect(swapped).toBe(true);
      expect(result.blocked).toBe(true);
      expect(result.prunedArtifactIds).toEqual([]);
      expect(existsSync(join(artifacts, "img-old.png"))).toBe(true);
      expect(existsSync(join(artifacts, "img-new.png"))).toBe(true);
      expect(existsSync(join(displaced, "img-old.png"))).toBe(true);
      expect(existsSync(join(displaced, "img-new.png"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test("operation-local pin authorities combine with registered owners and dedupe by identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-explicit-owner-"));
    touch(join(dir, "vid-owned.mp4"), "video", 10_000);
    touch(join(dir, "img-new.png"), "image", 1_000);
    let releases = 0;
    let state: "completed" | "pending" | "pruned" = "completed";
    const authority = {
      protectedArtifactIds: () => state === "completed" ? new Set(["vid-owned.mp4"]) : new Set<string>(),
      canReleaseArtifactForPrune: () => state === "completed" ? "releasable" as const : "not_owned" as const,
      releaseArtifactForPrune: () => {
        releases += 1;
        state = "pending";
        return "released" as const;
      },
      pendingArtifactDeletionIds: () => state === "pending" ? new Set(["vid-owned.mp4"]) : new Set<string>(),
      finalizeArtifactPrune: () => {
        state = "pruned";
        return "finalized" as const;
      },
    };
    const unregister = registerArtifactPinAuthority(authority);
    try {
      const result = pruneMediaArtifacts({
        dir,
        maxFiles: 1,
        pinAuthorities: [authority, authority],
      });
      expect(result.prunedArtifactIds).toEqual(["vid-owned.mp4"]);
      expect(releases).toBe(1);
    } finally {
      unregister();
    }
  });

  test("a later transient hard pin vetoes before an earlier durable owner is released", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-two-phase-veto-"));
    const artifactId = "vid-two-phase.mp4";
    const artifact = join(dir, artifactId);
    touch(artifact, "durable-video", 10_000);
    touch(join(dir, "img-new.png"), "new-image", 1_000);
    let durableState: "completed" | "pending" | "artifact_pruned" = "completed";
    let releases = 0;
    const unregisterDurable = registerArtifactPinAuthority({
      protectedArtifactIds: () => durableState === "completed" ? new Set([artifactId]) : new Set<string>(),
      canReleaseArtifactForPrune: () => durableState === "completed" ? "releasable" : "not_owned",
      releaseArtifactForPrune: () => {
        releases += 1;
        durableState = "pending";
        return "released";
      },
      pendingArtifactDeletionIds: () => durableState === "pending" ? new Set([artifactId]) : new Set<string>(),
      finalizeArtifactPrune: () => {
        durableState = "artifact_pruned";
        return "finalized";
      },
    });
    const unregisterTransient = registerArtifactPinAuthority({
      protectedArtifactIds: () => new Set([artifactId]),
      releaseArtifactForPrune: () => "protected",
    });
    try {
      expect(pruneMediaArtifacts({ dir, maxFiles: 1 }).prunedArtifactIds).toEqual(["img-new.png"]);
      expect(releases).toBe(0);
      expect(durableState).toBe("completed");
      expect(existsSync(artifact)).toBe(true);

      unregisterTransient();
      touch(join(dir, "img-later.png"), "later-image");
      expect(pruneMediaArtifacts({ dir, maxFiles: 1 }).prunedArtifactIds).toEqual([artifactId]);
      expect(releases).toBe(1);
      expect(durableState).toBe("artifact_pruned");
      expect(existsSync(artifact)).toBe(false);
    } finally {
      unregisterTransient();
      unregisterDurable();
    }
  });

  test("pending-delete-only authority retries independently of recovery capability and cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-pending-only-"));
    const artifactId = "vid-pending-only.mp4";
    const artifact = join(dir, artifactId);
    touch(artifact, "pending-delete");
    let pending = true;
    let finalized = 0;
    const unregister = registerArtifactPinAuthority({
      protectedArtifactIds: () => new Set<string>(),
      pendingArtifactDeletionIds: () => pending ? new Set([artifactId]) : new Set<string>(),
      finalizeArtifactPrune: () => {
        pending = false;
        finalized += 1;
        return "finalized";
      },
    });
    try {
      expect(pruneMediaArtifacts({ dir, maxFiles: 0 }).prunedArtifactIds).toEqual([artifactId]);
      expect(finalized).toBe(1);
      expect(existsSync(artifact)).toBe(false);
    } finally {
      unregister();
    }
  });

  test("exact removal keeps a pending delete intact while another owner transiently pins it", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-pending-cross-owner-pin-"));
    const artifactId = "vid-pending-cross-owner.mp4";
    const artifact = join(dir, artifactId);
    touch(artifact, "pending-delete");
    let pending = true;
    let finalized = 0;
    const unregisterPending = registerArtifactPinAuthority({
      protectedArtifactIds: () => new Set<string>(),
      pendingArtifactDeletionIds: () => pending ? new Set([artifactId]) : new Set<string>(),
      finalizeArtifactPrune: () => {
        pending = false;
        finalized += 1;
        return "finalized";
      },
    });
    const unregisterTransient = registerArtifactPinAuthority({
      protectedArtifactIds: () => new Set([artifactId]),
    });
    try {
      expect(removeMediaArtifact(dir, artifactId)).toBe(false);
      expect(pending).toBe(true);
      expect(finalized).toBe(0);
      expect(existsSync(artifact)).toBe(true);

      unregisterTransient();
      expect(removeMediaArtifact(dir, artifactId)).toBe(true);
      expect(pending).toBe(false);
      expect(finalized).toBe(1);
      expect(existsSync(artifact)).toBe(false);
    } finally {
      unregisterTransient();
      unregisterPending();
    }
  });

  test("stale private temp files are cleaned without following symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-temp-"));
    const old = join(dir, ".ccx-video-stale.tmp");
    writeFileSync(old, "partial", { mode: 0o600 });
    const oldTime = (Date.now() - 60_000) / 1000;
    utimesSync(old, oldTime, oldTime);
    const outside = join(dir, "outside.txt");
    touch(outside, "outside");
    symlinkSync(outside, join(dir, ".ccx-video-link.tmp"));
    const result = pruneMediaArtifacts({ dir, maxFiles: 10, staleTempAgeMs: 1_000, now: Date.now() });
    expect(result.removedStaleTemps).toEqual([".ccx-video-stale.tmp"]);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(dir, ".ccx-video-link.tmp"))).toBe(true);
  });

  test("production pruning repairs a crash between no-replace link and temp unlink immediately", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-linked-temp-"));
    const temp = join(dir, ".ccx-video-published.tmp");
    const final = join(dir, "vid-recovered.mp4");
    writeFileSync(temp, MP4, { mode: 0o600 });
    linkSync(temp, final);
    expect(lstatSync(final).nlink).toBe(2);
    const unregister = registerArtifactPinAuthority({
      protectedArtifactIds: () => new Set(["vid-recovered.mp4"]),
      recoverablePublicationArtifactIds: () => new Set(["vid-recovered.mp4"]),
    });
    try {
      pruneOldArtifacts(dir, 10);
      expect(existsSync(temp)).toBe(false);
      expect(existsSync(final)).toBe(true);
      expect(lstatSync(final).nlink).toBe(1);
    } finally {
      unregister();
    }
  });

  test("cap zero disables count pruning but still completes linked publication", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-zero-linked-temp-"));
    const temp = join(dir, ".ccx-video-published-zero.tmp");
    const final = join(dir, "vid-recovered-zero.mp4");
    const unrelated = join(dir, "img-unrelated.png");
    writeFileSync(temp, MP4, { mode: 0o600 });
    touch(unrelated, "unrelated", 120_000);
    linkSync(temp, final);

    const authority = {
      protectedArtifactIds: () => new Set(["vid-recovered-zero.mp4"]),
      recoverablePublicationArtifactIds: () => new Set(["vid-recovered-zero.mp4"]),
    };
    const result = pruneMediaArtifacts({ dir, maxFiles: 0, pinAuthorities: [authority] });

    expect(result.prunedArtifactIds).toEqual([]);
    expect(result.removedStaleTemps).toEqual([".ccx-video-published-zero.tmp"]);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(final)).toBe(true);
    expect(lstatSync(final).nlink).toBe(1);
    expect(existsSync(unrelated)).toBe(true);
  });

  test("expired publication authority durably removes the exact private temp and final before finalizing", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-expired-linked-"));
    const artifactId = "vid-expired-linked.mp4";
    const temp = join(dir, ".ccx-video-expired-linked.tmp");
    const final = join(dir, artifactId);
    writeFileSync(temp, MP4, { mode: 0o600 });
    linkSync(temp, final);
    let pending = true;
    let finalized = 0;
    const authority = {
      protectedArtifactIds: () => new Set<string>(),
      pendingArtifactDeletionIds: () => pending ? new Set([artifactId]) : new Set<string>(),
      expiredLinkedPublicationArtifactIds: () => new Set([artifactId]),
      finalizeArtifactPrune: () => {
        expect(existsSync(temp)).toBe(false);
        expect(existsSync(final)).toBe(false);
        pending = false;
        finalized += 1;
        return "finalized" as const;
      },
    };

    const result = pruneMediaArtifacts({ dir, maxFiles: 0, pinAuthorities: [authority] });
    expect(result.prunedArtifactIds).toEqual([artifactId]);
    expect(result.removedStaleTemps).toEqual([]);
    expect(finalized).toBe(1);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(final)).toBe(false);
  });

  test("expired linked deletion keeps its journal obligation until both absent names are durably confirmed", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-expired-linked-sync-"));
    const artifactId = "vid-expired-linked-sync.mp4";
    const temp = join(dir, ".ccx-video-expired-linked-sync.tmp");
    const final = join(dir, artifactId);
    writeFileSync(temp, MP4, { mode: 0o600 });
    linkSync(temp, final);
    let pending = true;
    let finalized = 0;
    const authority = {
      protectedArtifactIds: () => new Set<string>(),
      pendingArtifactDeletionIds: () => pending ? new Set([artifactId]) : new Set<string>(),
      expiredLinkedPublicationArtifactIds: () => new Set([artifactId]),
      finalizeArtifactPrune: () => {
        pending = false;
        finalized += 1;
        return "finalized" as const;
      },
    };

    const failed = pruneMediaArtifacts({
      dir,
      maxFiles: 0,
      pinAuthorities: [authority],
      io: { syncDirectory: () => false },
    });
    expect(failed.prunedArtifactIds).toEqual([]);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(final)).toBe(false);
    expect(pending).toBe(true);
    expect(finalized).toBe(0);

    const retried = pruneMediaArtifacts({ dir, maxFiles: 0, pinAuthorities: [authority] });
    expect(retried.prunedArtifactIds).toEqual([artifactId]);
    expect(pending).toBe(false);
    expect(finalized).toBe(1);
  });

  test("expired linked deletion does not finalize an absent final while a private temp is orphaned", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-expired-orphan-temp-"));
    const artifactId = "vid-expired-orphan.mp4";
    const temp = join(dir, ".ccx-video-expired-orphan.tmp");
    writeFileSync(temp, MP4, { mode: 0o600 });
    let finalized = 0;
    const authority = {
      protectedArtifactIds: () => new Set<string>(),
      pendingArtifactDeletionIds: () => new Set([artifactId]),
      expiredLinkedPublicationArtifactIds: () => new Set([artifactId]),
      finalizeArtifactPrune: () => {
        finalized += 1;
        return "finalized" as const;
      },
    };

    const result = pruneMediaArtifacts({
      dir,
      maxFiles: 0,
      maxStaleTemps: 0,
      pinAuthorities: [authority],
    });
    expect(result.prunedArtifactIds).toEqual([]);
    expect(result.removedStaleTemps).toEqual([]);
    expect(finalized).toBe(0);
    expect(existsSync(temp)).toBe(true);
  });

  test("expired publication authority rejects wrong magic, arbitrary hardlinks, and symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-expired-reject-"));
    const dir = join(root, "artifacts");
    mkdirSync(dir, { mode: 0o700 });
    const wrongMagicId = "vid-expired-wrong-magic.mp4";
    const wrongMagicTemp = join(dir, ".ccx-video-expired-wrong.tmp");
    writeFileSync(wrongMagicTemp, Buffer.from("not-video-data"), { mode: 0o600 });
    linkSync(wrongMagicTemp, join(dir, wrongMagicId));

    const arbitraryId = "vid-expired-arbitrary.mp4";
    const arbitraryOutside = join(root, "arbitrary-outside.mp4");
    writeFileSync(arbitraryOutside, MP4, { mode: 0o600 });
    linkSync(arbitraryOutside, join(dir, arbitraryId));

    const symlinkId = "vid-expired-symlink.mp4";
    const symlinkOutside = join(root, "symlink-outside.mp4");
    writeFileSync(symlinkOutside, MP4, { mode: 0o600 });
    symlinkSync(symlinkOutside, join(dir, symlinkId), "file");

    const ids = new Set([wrongMagicId, arbitraryId, symlinkId]);
    let finalized = 0;
    try {
      const result = pruneMediaArtifacts({
        dir,
        maxFiles: 0,
        pinAuthorities: [{
          protectedArtifactIds: () => new Set<string>(),
          pendingArtifactDeletionIds: () => ids,
          expiredLinkedPublicationArtifactIds: () => ids,
          finalizeArtifactPrune: () => {
            finalized += 1;
            return "finalized";
          },
        }],
      });
      expect(result.prunedArtifactIds).toEqual([]);
      expect(finalized).toBe(0);
      expect(lstatSync(wrongMagicTemp).nlink).toBe(2);
      expect(lstatSync(join(dir, wrongMagicId)).nlink).toBe(2);
      expect(existsSync(arbitraryOutside)).toBe(true);
      expect(existsSync(join(dir, arbitraryId))).toBe(true);
      expect(existsSync(symlinkOutside)).toBe(true);
      expect(lstatSync(join(dir, symlinkId)).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("linked publication is not reported recovered until its directory sync succeeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-linked-sync-fault-"));
    const artifactId = "vid-linked-sync-fault.mp4";
    const temp = join(dir, ".ccx-video-linked-sync-fault.tmp");
    const final = join(dir, artifactId);
    writeFileSync(temp, MP4, { mode: 0o600 });
    linkSync(temp, final);
    const authority = {
      protectedArtifactIds: () => new Set([artifactId]),
      recoverablePublicationArtifactIds: () => new Set([artifactId]),
    };

    const failed = pruneMediaArtifacts({
      dir,
      maxFiles: 0,
      pinAuthorities: [authority],
      io: { syncDirectory: () => false },
    });
    expect(failed.removedStaleTemps).toEqual([]);
    expect(lstatSync(temp).nlink).toBe(2);
    expect(lstatSync(final).nlink).toBe(2);

    const retried = pruneMediaArtifacts({ dir, maxFiles: 0, pinAuthorities: [authority] });
    expect(retried.removedStaleTemps).toEqual([".ccx-video-linked-sync-fault.tmp"]);
    expect(existsSync(temp)).toBe(false);
    expect(lstatSync(final).nlink).toBe(1);
  });

  test("single-link adoption still requires directory sync when relink rollback failed", async () => {
    const dir = getArtifactsDirForTest();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const artifactId = "vid-linked-relink-fault.mp4";
    const temp = join(dir, ".ccx-video-linked-relink-fault.tmp");
    const final = join(dir, artifactId);
    writeFileSync(temp, MP4, { mode: 0o600 });
    linkSync(temp, final);
    const authority = {
      protectedArtifactIds: () => new Set([artifactId]),
      recoverablePublicationArtifactIds: () => new Set([artifactId]),
    };
    const failed = pruneMediaArtifacts({
      dir,
      maxFiles: 0,
      pinAuthorities: [authority],
      io: {
        syncDirectory: () => false,
        linkFile: () => { throw new Error("injected relink failure"); },
      },
    });
    expect(failed.removedStaleTemps).toEqual([]);
    expect(existsSync(temp)).toBe(false);
    expect(lstatSync(final).nlink).toBe(1);

    await expect(adoptReservedVideoArtifact(artifactId, {
      syncDirectory: async () => { throw new Error("injected directory sync failure"); },
    })).rejects.toThrow("injected directory sync failure");
    expect(await adoptReservedVideoArtifact(artifactId)).toBe(final);
  });

  test.each([
    ["unknown reservation", "vid-unknown.mp4", MP4],
    ["wrong extension", "img-linked.png", MP4],
    ["invalid magic", "vid-invalid.mp4", Buffer.from("not-video-data")],
  ] as const)("linked cleanup rejects %s", (_case, finalName, bytes) => {
    const dir = mkdtempSync(join(tmpdir(), "prune-reject-linked-"));
    const temp = join(dir, ".ccx-video-rejected.tmp");
    const final = join(dir, finalName);
    writeFileSync(temp, bytes, { mode: 0o600 });
    linkSync(temp, final);
    const owned = _case === "unknown reservation" ? new Set<string>() : new Set([finalName]);

    const result = pruneMediaArtifacts({
      dir,
      maxFiles: 0,
      pinAuthorities: [{
        protectedArtifactIds: () => owned,
        recoverablePublicationArtifactIds: () => owned,
      }],
    });

    expect(result.removedStaleTemps).toEqual([]);
    expect(lstatSync(temp).nlink).toBe(2);
    expect(lstatSync(final).nlink).toBe(2);
  });

  test("linked cleanup rejects non-private mode where ownership modes are authoritative", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "prune-reject-mode-"));
    const temp = join(dir, ".ccx-video-public.tmp");
    const final = join(dir, "vid-public.mp4");
    writeFileSync(temp, MP4, { mode: 0o600 });
    linkSync(temp, final);
    chmodSync(temp, 0o640);

    const result = pruneMediaArtifacts({
      dir,
      maxFiles: 0,
      pinAuthorities: [{
        protectedArtifactIds: () => new Set(["vid-public.mp4"]),
        recoverablePublicationArtifactIds: () => new Set(["vid-public.mp4"]),
      }],
    });

    expect(result.removedStaleTemps).toEqual([]);
    expect(lstatSync(temp).nlink).toBe(2);
    expect(lstatSync(final).nlink).toBe(2);
  });

  test("linked cleanup rejects identities with more than the exact temp and final links", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-reject-multiple-links-"));
    const temp = join(dir, ".ccx-video-multiple.tmp");
    const final = join(dir, "vid-multiple.mp4");
    const extra = join(dir, "vid-extra.mp4");
    writeFileSync(temp, MP4, { mode: 0o600 });
    linkSync(temp, final);
    linkSync(temp, extra);

    const result = pruneMediaArtifacts({
      dir,
      maxFiles: 0,
      pinAuthorities: [{
        protectedArtifactIds: () => new Set(["vid-multiple.mp4", "vid-extra.mp4"]),
        recoverablePublicationArtifactIds: () => new Set(["vid-multiple.mp4", "vid-extra.mp4"]),
      }],
    });

    expect(result.removedStaleTemps).toEqual([]);
    expect(lstatSync(temp).nlink).toBe(3);
    expect(lstatSync(final).nlink).toBe(3);
    expect(lstatSync(extra).nlink).toBe(3);
  });

  test("directory-wide image materialization protection cannot authorize unknown video recovery", () => {
    const dir = getArtifactsDirForTest();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, ".ccx-video-image-guard.tmp");
    const final = join(dir, "vid-image-guard-unknown.mp4");
    writeFileSync(temp, MP4, { mode: 0o600 });
    linkSync(temp, final);
    const finishMaterialization = beginImageArtifactMaterialization();
    try {
      const result = pruneMediaArtifacts({ dir, maxFiles: 0 });
      expect(result.removedStaleTemps).toEqual([]);
      expect(lstatSync(temp).nlink).toBe(2);
      expect(lstatSync(final).nlink).toBe(2);
    } finally {
      finishMaterialization();
    }
  });
});

function getArtifactsDirForTest(): string {
  return join(process.env.CODEXCOMMANDER_HOME!, "artifacts");
}

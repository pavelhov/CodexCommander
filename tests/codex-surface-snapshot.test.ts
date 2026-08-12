import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  codexSurfaceText,
  readCodexSurfaceSnapshot,
  sameCodexSurfaceSnapshot,
} from "../src/codex/codex-surface-snapshot";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ccx-surface-snapshot-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex surface snapshots", () => {
  test("distinguishes initial absence from a stable regular file", () => {
    const path = join(tempRoot(), "config.toml");
    const absent = readCodexSurfaceSnapshot(path);
    expect(absent).toEqual({ kind: "absent", logicalPath: path });
    expect(codexSurfaceText(absent!, null)).toBeNull();

    writeFileSync(path, "model = \"native\"\n");
    const file = readCodexSurfaceSnapshot(path);
    expect(file?.kind).toBe("file");
    if (!file || file.kind !== "file") throw new Error("expected file snapshot");
    expect(file.bytes.equals(Buffer.from("model = \"native\"\n"))).toBe(true);
    expect(file.text).toBe("model = \"native\"\n");
    expect(file.symbolicLink).toBe(false);
    expect(codexSurfaceText(file, null)).toBe("model = \"native\"\n");
  });

  test("retains binary bytes but exposes text only for an exact UTF-8 round trip", () => {
    const path = join(tempRoot(), "binary");
    const bytes = Buffer.from([0x66, 0x80, 0x6f]);
    writeFileSync(path, bytes);

    const snapshot = readCodexSurfaceSnapshot(path);
    expect(snapshot?.kind).toBe("file");
    if (!snapshot || snapshot.kind !== "file") throw new Error("expected file snapshot");
    expect(snapshot.bytes.equals(bytes)).toBe(true);
    expect(snapshot.text).toBeNull();
  });

  test("binds symlink leaf and canonical target while regular-only rejects it", () => {
    const root = tempRoot();
    const target = join(root, "target.toml");
    const link = join(root, "config.toml");
    writeFileSync(target, "native\n");
    symlinkSync(target, link, "file");

    const snapshot = readCodexSurfaceSnapshot(link, "regular-or-symlink");
    expect(snapshot?.kind).toBe("file");
    if (!snapshot || snapshot.kind !== "file") throw new Error("expected symlink snapshot");
    expect(snapshot.symbolicLink).toBe(true);
    expect(snapshot.canonicalTarget).toBe(realpathSync.native(target));
    expect(readCodexSurfaceSnapshot(link, "regular-only")).toBeNull();
  });

  test("detects an equal-byte replacement through filesystem identity", () => {
    const root = tempRoot();
    const path = join(root, "config.toml");
    const replacement = join(root, "replacement.toml");
    writeFileSync(path, "same bytes\n");
    const before = readCodexSurfaceSnapshot(path);
    writeFileSync(replacement, "same bytes\n");
    renameSync(replacement, path);
    const after = readCodexSurfaceSnapshot(path);

    expect(before?.kind).toBe("file");
    expect(after?.kind).toBe("file");
    expect(before && after && sameCodexSurfaceSnapshot(before, after)).toBe(false);
  });

  test("requires the same logical surface as well as the same target", () => {
    const root = tempRoot();
    const target = join(root, "target.toml");
    const first = join(root, "first.toml");
    const second = join(root, "second.toml");
    writeFileSync(target, "native\n");
    symlinkSync(target, first, "file");
    symlinkSync(target, second, "file");

    const left = readCodexSurfaceSnapshot(first);
    const right = readCodexSurfaceSnapshot(second);
    expect(left && right && sameCodexSurfaceSnapshot(left, right)).toBe(false);
  });
});

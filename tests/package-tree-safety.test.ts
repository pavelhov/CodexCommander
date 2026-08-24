import { describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafePackageFile, assertSafePackageTree } from "../scripts/package-tree-safety";

function withTree(body: (root: string, outside: string) => void): void {
  const sandbox = mkdtempSync(join(tmpdir(), "ccx-package-tree-"));
  const root = join(sandbox, "package");
  const outside = join(sandbox, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  try {
    body(root, outside);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("package source-tree safety", () => {
  test("ships the canonical delegation skill through the package src tree", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
      files?: string[];
    };

    expect(packageJson.files).toContain("src");
    expect(await Bun.file(new URL("../src/skills/codexcommander-delegation/SKILL.md", import.meta.url)).exists()).toBe(true);
  });

  test("accepts a fully physical package tree without modifying its source modes", () => withTree(root => {
    const dist = join(root, "gui", "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    const index = join(dist, "index.html");
    const asset = join(dist, "assets", "app.js");
    writeFileSync(index, "<!doctype html>");
    writeFileSync(asset, "export {};");
    chmodSync(index, 0o600);
    chmodSync(asset, 0o600);

    assertSafePackageTree(dist, "gui/dist", root);

    expect(lstatSync(index).mode & 0o777).toBe(0o600);
    expect(lstatSync(asset).mode & 0o777).toBe(0o600);
  }));

  test("rejects a symbolic source root, file, and directory without mutating another tree", () => withTree((root, outside) => {
    const external = join(outside, "secret.txt");
    writeFileSync(external, "keep-this-external-content");
    chmodSync(external, 0o600);
    const dist = join(root, "gui", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "safe");
    const sourceRootLink = join(root, "linked-dist");
    symlinkSync(dist, sourceRootLink);
    expect(() => assertSafePackageTree(sourceRootLink, "linked root", root)).toThrow("symbolic link");

    symlinkSync(external, join(dist, "external.txt"));
    expect(() => assertSafePackageTree(dist, "gui/dist", root)).toThrow("symbolic link");
    expect(lstatSync(external).mode & 0o777).toBe(0o600);
    expect(readFileSync(external, "utf8")).toBe("keep-this-external-content");
  }));

  test("rejects a symbolic directory and a multiply-linked external file without source mutation", () => withTree((root, outside) => {
    const dist = join(root, "gui", "dist");
    mkdirSync(dist, { recursive: true });
    const normal = join(dist, "index.html");
    writeFileSync(normal, "safe");
    chmodSync(normal, 0o600);
    const externalDir = join(outside, "assets");
    mkdirSync(externalDir);
    writeFileSync(join(externalDir, "external.js"), "external");
    symlinkSync(externalDir, join(dist, "assets"));
    expect(() => assertSafePackageTree(dist, "gui/dist", root)).toThrow("symbolic link");
    expect(lstatSync(normal).mode & 0o777).toBe(0o600);
    rmSync(join(dist, "assets"));

    const external = join(outside, "shared.txt");
    writeFileSync(external, "do-not-modify");
    chmodSync(external, 0o600);
    linkSync(external, join(dist, "shared.txt"));
    expect(() => assertSafePackageTree(dist, "gui/dist", root)).toThrow("multiply-linked");
    expect(lstatSync(external).mode & 0o777).toBe(0o600);
    expect(readFileSync(external, "utf8")).toBe("do-not-modify");
  }));

  test("requires single-link regular package files", () => withTree((root, outside) => {
    const external = join(outside, "launcher.mjs");
    writeFileSync(external, "#!/usr/bin/env bun");
    const linked = join(root, "ccx.mjs");
    linkSync(external, linked);
    expect(() => assertSafePackageFile(linked, "launcher", root)).toThrow("multiply linked");
  }));
});

import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveGuiFile } from "../src/server/gui-static";

function withGuiTree(body: (guiDist: string, outside: string) => void): void {
  const sandbox = mkdtempSync(join(tmpdir(), "ccx-gui-static-"));
  const guiDist = join(sandbox, "gui", "dist");
  const outside = join(sandbox, "outside");
  mkdirSync(guiDist, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(guiDist, "index.html"), "<!doctype html><title>dashboard</title>");
  try {
    body(guiDist, outside);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("GUI static filesystem containment", () => {
  test("serves a physical file under a physical GUI root", () => withGuiTree(guiDist => {
    mkdirSync(join(guiDist, "assets"));
    writeFileSync(join(guiDist, "assets", "app.js"), "export {};");
    expect(serveGuiFile("/assets/app.js", guiDist)?.status).toBe(200);
  }));

  test("refuses a symlinked GUI root", () => withGuiTree((guiDist, outside) => {
    const rootLink = join(outside, "dist-link");
    symlinkSync(guiDist, rootLink);
    expect(serveGuiFile("/", rootLink)).toBeNull();
  }));

  test("does not serve a symlinked file or directory", () => withGuiTree((guiDist, outside) => {
    writeFileSync(join(outside, "secret.txt"), "not a GUI asset");
    symlinkSync(join(outside, "secret.txt"), join(guiDist, "secret.txt"));
    mkdirSync(join(outside, "assets"));
    writeFileSync(join(outside, "assets", "stolen.js"), "outside");
    symlinkSync(join(outside, "assets"), join(guiDist, "assets"));

    expect(serveGuiFile("/secret.txt", guiDist)).toBeNull();
    expect(serveGuiFile("/assets/stolen.js", guiDist)).toBeNull();
  }));

  test("does not serve a hard-linked file from outside the GUI tree", () => withGuiTree((guiDist, outside) => {
    const external = join(outside, "secret.js");
    writeFileSync(external, "not a GUI asset");
    linkSync(external, join(guiDist, "leaked.js"));

    expect(serveGuiFile("/leaked.js", guiDist)).toBeNull();
  }));
});

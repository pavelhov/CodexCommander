import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

let failAfterCreate = false;
let createCollision = false;

// The native write may create a file before reporting an I/O failure. Keep the
// normal filesystem operations real and expose only that partial-write seam.
mock.module("node:fs/promises", () => ({
  chmod,
  mkdir,
  writeFile: async (path: string, data: Uint8Array, options?: { mode?: number }) => {
    const handle = await open(path, "wx", options?.mode);
    try {
      await handle.writeFile(createCollision ? "pre-existing collision" : data);
    } finally {
      await handle.close();
    }
    if (createCollision) {
      createCollision = false;
      throw Object.assign(new Error("simulated collision"), { code: "EEXIST" });
    }
    if (failAfterCreate) {
      failAfterCreate = false;
      const error = Object.assign(new Error("simulated partial write"), { code: "EIO" });
      throw error;
    }
  },
}));

const { materializeInlineImage } = await import("../../src/images/artifacts");

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
let tempHome: string | undefined;
let savedHome: string | undefined;

afterEach(() => {
  failAfterCreate = false;
  createCollision = false;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
  if (savedHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = savedHome;
  savedHome = undefined;
});

describe("artifact unique writes", () => {
  test("removes a file created before a write failure is reported", async () => {
    savedHome = process.env.CODEXCOMMANDER_HOME;
    tempHome = mkdtempSync(join(tmpdir(), "ccx-artifact-write-"));
    process.env.CODEXCOMMANDER_HOME = tempHome;
    failAfterCreate = true;

    await expect(materializeInlineImage(TINY_PNG)).rejects.toThrow("simulated partial write");
    expect(readdirSync(join(tempHome, "artifacts"))).toEqual([]);
  });

  test("does not remove a pre-existing collision target", async () => {
    savedHome = process.env.CODEXCOMMANDER_HOME;
    tempHome = mkdtempSync(join(tmpdir(), "ccx-artifact-write-"));
    process.env.CODEXCOMMANDER_HOME = tempHome;
    createCollision = true;

    await materializeInlineImage(TINY_PNG);
    const files = readdirSync(join(tempHome, "artifacts"));
    expect(files).toHaveLength(2);
    expect(files.some(file => readFileSync(join(tempHome!, "artifacts", file), "utf8") === "pre-existing collision")).toBe(true);
  });
});

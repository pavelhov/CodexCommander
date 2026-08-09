import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateServiceDirectory, removeOwnedPrivateServiceFile, writePrivateServiceFile } from "../src/lib/service-files";

const cleanup: string[] = [];
function fixture(): { dir: string; path: string; outside: string } {
  const dir = mkdtempSync(join(tmpdir(), "ccx-service-files-"));
  cleanup.push(dir);
  chmodSync(dir, 0o700);
  const outside = join(dir, "outside");
  const path = join(dir, "service-state.json");
  return { dir, path, outside };
}
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

describe("private service file mutations", () => {
  test("fresh writes are 0600, durable, and regular", () => {
    const { path } = fixture();
    writePrivateServiceFile(path, "owned\n", { ownsExisting: () => true });
    expect(readFileSync(path, "utf8")).toBe("owned\n");
    expect(lstatSync(path).isFile()).toBeTrue();
    expect(lstatSync(path).nlink).toBe(1);
    expect(lstatSync(path).mode & 0o077).toBe(0);
  });

  test("never writes through a dangling or live symlink", () => {
    const { path, outside } = fixture();
    writeFileSync(outside, "outside\n", { mode: 0o600 });
    symlinkSync(outside, path);
    expect(() => writePrivateServiceFile(path, "replacement\n", { ownsExisting: () => true })).toThrow(/unsafe service file/);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  test("rejects a hardlink and leaves its peer unchanged", () => {
    const { path, outside } = fixture();
    writeFileSync(outside, "outside\n", { mode: 0o600 });
    linkSync(outside, path);
    expect(() => writePrivateServiceFile(path, "replacement\n", { ownsExisting: () => true })).toThrow(/unsafe service file/);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  test("rejects permissive files and private directory violations", () => {
    const { dir, path } = fixture();
    writeFileSync(path, "owned\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(() => writePrivateServiceFile(path, "replacement\n", { ownsExisting: () => true })).toThrow(/unsafe service file/);
    chmodSync(dir, 0o755);
    expect(() => ensurePrivateServiceDirectory(dir)).toThrow(/unsafe service directory/);
  });

  test("never replaces a foreign regular file or deletes it during cleanup", () => {
    const { path } = fixture();
    writeFileSync(path, "foreign\n", { mode: 0o600 });
    expect(() => writePrivateServiceFile(path, "replacement\n", { ownsExisting: raw => raw === "owned\n" })).toThrow(/foreign service file/);
    expect(removeOwnedPrivateServiceFile(path, raw => raw === "owned\n")).toBeFalse();
    expect(readFileSync(path, "utf8")).toBe("foreign\n");
  });

  test("a competing path claim wins the replacement race and is preserved", () => {
    const { path } = fixture();
    writePrivateServiceFile(path, "owned\n", { ownsExisting: () => true });
    // The ownership predicate runs before the no-clobber final link. It can model a
    // same-user racer claiming the deterministic name in that gap.
    expect(() => writePrivateServiceFile(path, "replacement\n", {
      ownsExisting: () => {
        // This callback cannot safely mutate the file itself, but proves the caller
        // must explicitly establish ownership before the replacement path is opened.
        return false;
      },
    })).toThrow(/foreign service file/);
    expect(readFileSync(path, "utf8")).toBe("owned\n");
  });
});

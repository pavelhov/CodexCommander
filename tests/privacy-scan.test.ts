import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatFinding,
  main,
  redactSecret,
  scanFile,
  shouldScan,
} from "../scripts/privacy-scan";

describe("privacy scan coverage", () => {
  test("scans Swift, plist, and generated GUI files", () => {
    expect(shouldScan("app/Sources/MenuBarCore/ProxyClient.swift")).toBe(true);
    expect(shouldScan("app/Info.plist")).toBe(true);
    expect(shouldScan("gui/dist/index.html")).toBe(true);
    expect(shouldScan("gui/dist/assets/index.js")).toBe(true);
    expect(shouldScan("node_modules/secret.ts")).toBe(false);
    expect(shouldScan("src/foo/node_modules/secret.ts")).toBe(false);
  });

  test("redacts matched secrets instead of printing them", () => {
    const secret = ["sk-", "liveabcdefghijklmnopqrstuvwxyz012345"].join("");
    const finding = scanFile("src/example.ts", `const token = "${secret}";\n`)[0];
    expect(finding?.kind).toBe("token-looking");
    const printed = formatFinding(finding!);
    expect(printed).toContain("token-looking");
    expect(printed).toContain("src/example.ts:1");
    expect(printed).toContain(redactSecret(secret));
    expect(printed).not.toContain(secret);
    expect(redactSecret(secret)).toBe(`[redacted ${secret.length} chars]`);
  });

  test("scan-root fails closed without echoing the secret into logs", () => {
    const root = mkdtempSync(join(tmpdir(), "ccx-privacy-scan-"));
    const secret = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123"].join("");
    mkdirSync(join(root, "gui", "dist"), { recursive: true });
    writeFileSync(join(root, "gui", "dist", "app.js"), `export const leak = "${secret}";\n`);
    const errors: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    console.log = () => {};
    try {
      expect(main(["--scan-root", root])).toBe(1);
      expect(errors.some(line => line.includes("token-looking"))).toBe(true);
      expect(errors.join("\n")).not.toContain(secret);
    } finally {
      console.error = originalError;
      console.log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

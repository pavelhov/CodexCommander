import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-contract regressions for the F9 systemd no-DBUS SSH detection (E) and the
// F4 explicit-localhost bind symmetry (D). These files run top-level or
// platform-gated logic, so guard the invariants at the source level (repo convention — see
// ccx-launcher-source.test.ts / service.test.ts).
const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

describe("systemd detection tolerates a no-DBUS SSH session (F9)", () => {
  const src = read("src/service.ts");
  test("isSystemd falls back to the per-user runtime dir when the user-bus probe fails", () => {
    expect(src).toContain("function userRuntimeDir()");
    expect(src).toContain("function ensureUserBusEnv()");
    // The version probe passing + a runtime dir existing is enough — not a hard fail on the --user probe.
    expect(src).toMatch(/catch \{ \/\* no user bus in this session \*\/ \}\s*\n\s*return userRuntimeDir\(\) !== null;/);
  });
  test("install ensures the user-bus env before touching systemctl --user", () => {
    expect(src).toMatch(/function installSystemd\(\): void \{\s*\n\s*ensureUserBusEnv\(\);/);
  });
});

describe("server bind canonicalizes explicit localhost but preserves wildcards (F4 symmetry)", () => {
  const src = read("src/server/index.ts");
  test("literal localhost binds to 127.0.0.1; 0.0.0.0/:: exposure is untouched", () => {
    expect(src).toContain("const configuredHost = config.hostname?.trim();");
    expect(src).toContain('!configuredHost || /^localhost$/i.test(configuredHost) ? "127.0.0.1"');
    expect(src).toContain("hostname: bindHost,");
    // Must not blanket-rewrite the bind host (that would break intentional 0.0.0.0 exposure).
    expect(src).not.toContain('hostname: "127.0.0.1",');
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stopProxyLifecycle } from "../src/cli/proxy-lifecycle";
import type { ProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";

const TEST_DIR = join(import.meta.dir, ".tmp-stale-state-purge-test");
let prevCodexCommanderHome: string | undefined;

describe("snapshot-guarded stale-state purge", () => {
  beforeEach(() => {
    prevCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (prevCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = prevCodexCommanderHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("removePidIfValueIs deletes only when the file still matches the snapshot", async () => {
    const { getPidPath, removePidIfValueIs } = await import("../src/config");

    writeFileSync(getPidPath(), "123");
    removePidIfValueIs(999); // concurrent start rewrote the file since the snapshot
    expect(existsSync(getPidPath())).toBe(true);
    expect(readFileSync(getPidPath(), "utf-8")).toBe("123");

    removePidIfValueIs(123);
    expect(existsSync(getPidPath())).toBe(false);

    removePidIfValueIs(null); // nothing on disk: no-op, no throw
  });

  test("removeRuntimePortIfPidIs deletes matching and invalid-snapshot records, keeps fresh ones", async () => {
    const { getConfigDir, removeRuntimePortIfPidIs } = await import("../src/config");
    const runtimePath = join(getConfigDir(), "runtime-port.json");

    writeFileSync(runtimePath, JSON.stringify({ schemaVersion: 1, pid: 42, port: 58195 }));
    removeRuntimePortIfPidIs(7); // a different (fresh) record — keep it
    expect(existsSync(runtimePath)).toBe(true);

    removeRuntimePortIfPidIs(42);
    expect(existsSync(runtimePath)).toBe(false);

    // Invalid content snapshots as null and is purged as stale.
    writeFileSync(runtimePath, "not json");
    removeRuntimePortIfPidIs(null);
    expect(existsSync(runtimePath)).toBe(false);
  });

  test("canonical Stop snapshots stale state before probing and purges through the guards", async () => {
    const calls: string[] = [];
    let startHeld = true;
    const authority: ProxyLifecycleAuthority = {
      deadlineAt: Number.POSITIVE_INFINITY,
      ensure: { token: "E", release: () => authority.releaseAll() },
      get start() {
        return startHeld ? { token: "S", release: () => authority.releaseStart() } : undefined;
      },
      acquireStart: async () => ({ token: "S", release: () => authority.releaseStart() }),
      delegatedLease: () => startHeld ? { ensureToken: "E", startToken: "S" } : undefined,
      releaseStart: () => { startHeld = false; },
      releaseAll: () => { startHeld = false; },
    };
    const result = await stopProxyLifecycle({
      io: {
        acquireAuthority: async () => authority,
        diagnoseService: () => ({
          supported: true,
          installed: false,
          enabled: false,
          running: false,
          viable: false,
          startable: false,
          stale: false,
          conflict: false,
          backend: null,
          summary: "not installed",
        }),
        restoreNative: () => ({
          success: true,
          changed: false,
          desiredChanged: false,
          configChanged: false,
          message: "native",
        }),
        stripGrok: () => ({ ok: true, changed: false, message: "native" }),
        stopService: () => false,
        readPid: () => null,
        readPidFileValue: () => { calls.push("snapshot-pid"); return 101; },
        readRuntimePort: () => { calls.push("snapshot-runtime"); return { schemaVersion: 1, pid: 202, port: 10100 }; },
        findLive: async () => { calls.push("probe"); return null; },
        removePidIfValueIs: value => { calls.push(`purge-pid:${value}`); },
        removeRuntimePortIfPidIs: value => { calls.push(`purge-runtime:${value}`); },
        findSurvivor: async () => null,
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "snapshot-pid",
      "snapshot-runtime",
      "probe",
      "purge-pid:101",
      "purge-runtime:202",
    ]);
  });

  test("gui opens the actual bind host", () => {
    const cliSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
    expect(cliSource).toContain("const guiHost = probeHostname(live.hostname)");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopProxyLifecycleUnderAuthority } from "../src/cli/proxy-lifecycle";
import { acquireProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
import type { ServiceDiagnostic } from "../src/service";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("full uninstall command", () => {
  test("CLI exposes a one-shot local state cleanup command", async () => {
    const cli = await readText("src/cli/index.ts");
    const uninstall = await readText("src/cli/uninstall-command.ts");

    expect(cli).toContain('case "uninstall"');
    expect(cli).toContain("runUninstallCommand()");
    expect(cli).not.toContain("async function handleUninstall()");
    expect(uninstall).toContain("uninstallServiceIfInstalled");
    expect(uninstall).toContain("uninstallCodexShim");
    expect(uninstall).toContain("restoreNativeCodex");
    expect(uninstall).toContain("removeOwnedConfigArtifactsRetainingLifecycleRoot(getConfigDir())");
    expect(uninstall).not.toContain("rmSync(getConfigDir()");
  });

  test("service cleanup has a quiet best-effort helper", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain("export function uninstallServiceIfInstalled()");
    expect(service).toContain("uninstallLaunchd");
    expect(service).toContain("uninstallWindows");
    expect(service).toContain("uninstallSystemd");
  });

  test("a concurrent Start stays paused after Stop while uninstall retains E", async () => {
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-uninstall-held-e-"));
    const previousHome = process.env.CODEXCOMMANDER_HOME;
    process.env.CODEXCOMMANDER_HOME = ccxHome;
    const calls: string[] = [];
    let contender: { release(): void } | null = null;
    try {
      const authority = await acquireProxyLifecycleAuthority({ includeStart: true });
      const service = (): ServiceDiagnostic => ({
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
      });
      const stopped = await stopProxyLifecycleUnderAuthority({
        io: {
          diagnoseService: service,
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
          readPidFileValue: () => null,
          readRuntimePort: () => null,
          findLive: async () => null,
          findSurvivor: async () => null,
        },
      }, authority);
      expect(stopped.ok).toBe(true);
      expect(authority.start).toBeUndefined();

      let startEntered = false;
      const concurrentStart = acquireProxyLifecycleAuthority({
        waitTimeoutMs: 2_000,
      }).then(nextAuthority => {
        contender = nextAuthority.ensure;
        startEntered = true;
        calls.push("start-entered");
      });
      await Bun.sleep(30);
      expect(startEntered).toBe(false);

      // These are the caller-owned cleanup and terminal proof window. The Stop helper
      // released only S; the real E file still excludes the queued Start contender.
      calls.push("cleanup", "native-proof", "no-live-proof", "release-E");
      authority.releaseAll();
      await concurrentStart;
      expect(calls).toEqual([
        "cleanup",
        "native-proof",
        "no-live-proof",
        "release-E",
        "start-entered",
      ]);
    } finally {
      contender?.release();
      if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previousHome;
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });
});

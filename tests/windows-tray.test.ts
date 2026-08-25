import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWindowsTrayLauncherScript,
  buildWindowsTrayPowerShellCommand,
  buildWindowsTrayRunCommand,
  launchWindowsTrayHost,
  parseWindowsTrayHostEntry,
  parseWindowsTrayRunValue,
  readWindowsTrayRunValueWithAsyncRunner,
  readWindowsTrayRunValueWithRunner,
  replaceWindowsTrayOwnedFile,
  windowsTrayProcessArgs,
  windowsTrayRunValue,
  windowsTrayStatePathsOwned,
  windowsTrayRegistrationIsStale,
  windowsRegistryParentShowsRunKey,
  type WindowsTrayEntry,
} from "../src/tray/windows";
import {
  hardenSecretPath,
  hardenedSecretPathCountForTests,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../src/lib/windows-secret-acl";
import { handleManagementAPI } from "../src/server/management-api";
import type { CodexCommanderConfig } from "../src/types";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "./helpers/test-budget";

const entry: WindowsTrayEntry = {
  bun: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\bun.exe",
  bunRuntimeSource: "bundled",
  cli: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\src\\cli\\index.ts",
  script: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\src\\tray\\windows-tray.ps1",
  launcherPath: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\.codexcommander\\codexcommander-tray.vbs",
  codexHome: "C:\\사용자 공간\\.codex",
  codexCommanderHome: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\.codexcommander",
};

describe("Windows tray packaging and command safety", () => {
  test("owned-file temp cleanup forgets successful ACL memos and retains failed removals", () => {
    const root = mkdtempSync(join(tmpdir(), "ccx-tray-acl-"));
    const target = join(root, "tray-state.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ccx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    const write = (path: string, contents: string | Buffer): void => {
      writeFileSync(path, contents, { mode: 0o600 });
    };
    const harden = (path: string): void => {
      hardenSecretPath(path, { required: true });
    };
    try {
      replaceWindowsTrayOwnedFile(target, "success", {
        write,
        harden,
        rename: renameSync,
        unlink: unlinkSync,
      });
      expect(hardenedSecretPathCountForTests()).toBe(0);

      expect(() => replaceWindowsTrayOwnedFile(target, "failure", {
        write,
        harden,
        rename: () => { throw new Error("injected rename failure"); },
        unlink: () => { throw Object.assign(new Error("injected unlink failure"), { code: "EPERM" }); },
      })).toThrow("injected rename failure");
      expect(hardenedSecretPathCountForTests()).toBe(1);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses fixed argv for the hidden PowerShell host", () => {
    const args = windowsTrayProcessArgs(entry);
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args).toContain("-STA");
    expect(args).toContain(entry.script);
    expect(args).toContain(entry.bun);
    expect(args).toContain(entry.cli);
    expect(args).not.toContain("-Command");
    expect(windowsTrayProcessArgs(entry, "Run", 4242)).toContain("4242");
  });

  test("passes the Bun provenance through to the tray host (#848)", () => {
    // The tray relaunches the proxy itself, so a tray-started service would otherwise
    // reach doctor with no provenance and be reported as unknown.
    const args = windowsTrayProcessArgs(entry);
    expect(args).toContain("-BunRuntimeSource");
    expect(args[args.indexOf("-BunRuntimeSource") + 1]).toBe("bundled");

    const overrideCommand = buildWindowsTrayPowerShellCommand(
      { ...entry, bunRuntimeSource: "override" },
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(overrideCommand).toContain("-BunRuntimeSource override");
  });

  test("quotes metacharacter and Unicode paths without shell interpolation", () => {
    const powershellCommand = buildWindowsTrayPowerShellCommand(entry, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellCommand).toContain(`-File "${entry.script}"`);
    expect(powershellCommand).toContain(`-CodexCommanderHome "${entry.codexCommanderHome}"`);
    expect(powershellCommand).not.toContain("cmd /c");
    expect(powershellCommand).not.toContain("-Command");
    const runCommand = buildWindowsTrayRunCommand(entry);
    expect(runCommand.toLowerCase()).toContain("wscript.exe");
    expect(runCommand.length).toBeLessThanOrEqual(260);
  });
  test("keeps UNC backslashes literal in the VBS Run command", () => {
    const uncRoot = "\\\\server\\share";
    const uncEntry: WindowsTrayEntry = {
      bun: `${uncRoot}\\tools\\bun.exe`,
      bunRuntimeSource: "bundled",
      cli: `${uncRoot}\\repo\\src\\cli\\index.ts`,
      script: `${uncRoot}\\repo\\src\\tray\\windows-tray.ps1`,
      launcherPath: `${uncRoot}\\codexcommander\\codexcommander-tray.vbs`,
      codexHome: "C:\\Users\\Test\\.codex",
      codexCommanderHome: `${uncRoot}\\codexcommander`,
    };
    const launcher = buildWindowsTrayLauncherScript(uncEntry);
    expect(launcher).toContain(`${uncRoot}\\tools\\bun.exe`);
    expect(launcher).not.toMatch(/\\\\\\\\server/);
  });


  test("preserves non-ASCII paths in the tray launcher script and UTF-16LE install encoding", () => {
    const launcher = buildWindowsTrayLauncherScript(entry);
    expect(launcher).toContain("사용자 공간");
    const encoded = Buffer.from("\uFEFF" + launcher, "utf16le");
    expect(encoded.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))).toBe(true);
    expect(encoded.toString("utf16le")).toContain("사용자 공간");
  });

  test("rejects quote and control-character path injection", () => {
    expect(() => windowsTrayProcessArgs({ ...entry, codexCommanderHome: 'C:\\bad" -Command whoami' })).toThrow();
    expect(() => windowsTrayProcessArgs({ ...entry, cli: "C:\\bad\r\nwhoami" })).toThrow();
  });

  test("never trusts state-selected executable or deletion paths", () => {
    const home = "C:\\Users\\Test\\.codexcommander";
    expect(windowsTrayStatePathsOwned({
      codexCommanderHome: home,
      script: join(home, "codexcommander-tray.ps1"),
      launcherPath: join(home, "codexcommander-tray.vbs"),
    }, home)).toBe(true);
    expect(windowsTrayStatePathsOwned({
      codexCommanderHome: home,
      script: "C:\\attacker\\payload.ps1",
      launcherPath: join(home, "codexcommander-tray.vbs"),
    }, home)).toBe(false);
    expect(windowsTrayStatePathsOwned({
      codexCommanderHome: home,
      script: join(home, "codexcommander-tray.ps1"),
      launcherPath: "C:\\victim\\document.txt",
    }, home)).toBe(false);
  });

  test("rejects tray host payloads without the current launcher and Bun provenance", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    expect(parseWindowsTrayHostEntry(encode(entry))).toEqual(entry);

    const { launcherPath: _launcherPath, ...withoutLauncher } = entry;
    expect(() => parseWindowsTrayHostEntry(encode(withoutLauncher))).toThrow("launcherPath");

    const { bunRuntimeSource: _bunRuntimeSource, ...withoutProvenance } = entry;
    expect(() => parseWindowsTrayHostEntry(encode(withoutProvenance))).toThrow("bunRuntimeSource");
    expect(() => parseWindowsTrayHostEntry(encode({ ...entry, bunRuntimeSource: "unknown" })))
      .toThrow("bunRuntimeSource");
  });

  test("treats a live unregistered tray as stale so uninstall cannot skip it", () => {
    expect(windowsTrayRegistrationIsStale({
      registered: false,
      registrationOwned: false,
      running: true,
      heartbeatFresh: true,
    })).toBe(true);
    expect(windowsTrayRegistrationIsStale({
      registered: false,
      registrationOwned: false,
      running: false,
      heartbeatFresh: false,
    })).toBe(false);
  });

  test("normalizes equivalent homes to one owned Run value", () => {
    expect(windowsTrayRunValue("C:\\Users\\Test\\.codexcommander"))
      .toBe(windowsTrayRunValue("C:\\Users\\Test\\.codexcommander\\."));
  });

  test("treats an unexpected registry type or unreadable value as foreign", () => {
    const value = "CodexCommanderTray-test";
    const command = '"C:\\Windows\\powershell.exe" -File "C:\\tray.ps1"';
    expect(parseWindowsTrayRunValue(`    ${value}    REG_SZ    ${command}`, value)).toBe(command);
    expect(parseWindowsTrayRunValue(`    ${value}    REG_EXPAND_SZ    ${command}`, value)).not.toBe(command);
    expect(parseWindowsTrayRunValue("unexpected output", value)).not.toBeNull();
  });

  test("distinguishes a missing Run key from an unreadable existing key", () => {
    const parent = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    ].join("\r\n");
    expect(windowsRegistryParentShowsRunKey(parent)).toBe(true);
    expect(windowsRegistryParentShowsRunKey(parent.replace(/\\Run\r?\n?$/, ""))).toBe(false);
  });

  test("fails closed when registry absence cannot be proven", async () => {
    const value = "CodexCommanderTray-test";
    const statusError = (status: number) => Object.assign(new Error(`reg exit ${status}`), { status });
    const codeError = (code: number) => Object.assign(new Error(`reg exit ${code}`), { code });

    expect(readWindowsTrayRunValueWithRunner(value, args => {
      if (args.includes("/v")) throw statusError(1);
      if (args[1]?.endsWith("\\Run")) return "readable";
      throw new Error("unexpected query");
    })).toBeNull();
    expect(() => readWindowsTrayRunValueWithRunner(value, () => { throw statusError(5); }))
      .toThrow("refusing to change persistence");
    expect(() => readWindowsTrayRunValueWithRunner(value, args => {
      if (args.includes("/v")) throw statusError(1);
      throw statusError(5);
    })).toThrow("refusing to change persistence");

    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v")) throw codeError(1);
      if (args[1]?.endsWith("\\Run")) return "readable";
      throw new Error("unexpected query");
    })).resolves.toBeNull();
    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async () => { throw codeError(5); }))
      .rejects.toThrow("Unable to verify Windows tray registry status");
    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v")) throw codeError(1);
      throw codeError(5);
    })).rejects.toThrow("Unable to verify Windows tray registry status");
  });

  test("proves a missing Run key only through the readable parent path", async () => {
    const value = "CodexCommanderTray-test";
    const syncCalls: string[][] = [];
    const syncResult = readWindowsTrayRunValueWithRunner(value, args => {
      syncCalls.push(args);
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("missing"), { status: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer";
    });
    expect(syncResult).toBeNull();
    expect(syncCalls).toEqual([
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", value, "/reg:64"],
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/reg:64"],
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion", "/reg:64"],
    ]);

    const asyncCalls: string[][] = [];
    const asyncResult = await readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      asyncCalls.push(args);
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("missing"), { code: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer";
    });
    expect(asyncResult).toBeNull();
    expect(asyncCalls).toEqual(syncCalls);

    expect(() => readWindowsTrayRunValueWithRunner(value, args => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("unreadable"), { status: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    })).toThrow("refusing to change persistence");

    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("unreadable"), { code: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    })).rejects.toThrow("Unable to verify Windows tray registry status");

    const parentFailureSync = (args: string[]): string => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) throw Object.assign(new Error("missing"), { status: 1 });
      throw Object.assign(new Error("parent unreadable"), { status: 5 });
    };
    expect(() => readWindowsTrayRunValueWithRunner(value, parentFailureSync))
      .toThrow("refusing to change persistence");
    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) throw Object.assign(new Error("missing"), { code: 1 });
      throw Object.assign(new Error("parent unreadable"), { code: 5 });
    })).rejects.toThrow("Unable to verify Windows tray registry status");
  });

  test("PowerShell controller uses mutex/event shutdown and bans command evaluation", () => {
    const typescript = readFileSync(join(import.meta.dir, "..", "src", "tray", "windows.ts"), "utf8");
    const source = readFileSync(join(import.meta.dir, "..", "src", "tray", "windows-tray.ps1"), "utf8");
    expect(typescript).not.toContain("\u0000");
    expect(typescript).toContain("const TRAY_STATE_VERSION = 3");
    expect(typescript).toContain("CCX_TRAY_ENTRY_B64");
    expect(typescript).toContain("$startInfo.UseShellExecute = $true");
    expect(source).toContain("System.Threading.Mutex");
    expect(source).toContain("System.Threading.EventWaitHandle");
    expect(source).toContain("GetFullPath");
    expect(source).toContain("GetPathRoot");
    expect(source).toContain("$heartbeat.hostPid = $HostPid");
    expect(source).toContain('Start-CodexCommanderCommand @("__tray-restart")');
    expect(source).toContain('Load-TrayIcon "codexcommander-tray-online.ico"');
    expect(source).toContain('Load-TrayIcon "codexcommander-tray-warning.ico"');
    expect(source).toContain('Load-TrayIcon "codexcommander-tray-offline.ico"');
    expect(source).toContain('$path = Join-Path $CodexCommanderHome "runtime-port.json"');
    expect(source).toContain('@("schemaVersion", "pid", "port", "hostname", "attestationSecret", "attestationProtocol")');
    expect(source).toContain('(Test-JsonInteger $value.attestationProtocol) -and [int64]$value.attestationProtocol -eq 2');
    expect(source).toContain("[int64]$value.schemaVersion -ne 1");
    expect(source).toContain('throw "invalid runtime-port schema"');
    expect(source).not.toContain('Join-Path $CodexCommanderHome "config.json"');
    expect(source).toContain("$notify.Icon = $offlineIcon");
    expect(source).not.toContain("$menu.add_Opening({ Update-TrayState })");
    expect(source).not.toContain("Invoke-Expression");
    expect(source).not.toContain("taskkill");
    expect(source).not.toContain("Stop-Process");
    expect(source).toContain('[Parameter(Mandatory = $true)][ValidateSet("override", "bundled", "process")][ValidateNotNullOrEmpty()][string]$BunRuntimeSource');
    expect(source).not.toContain('ValidateSet("", "override"');
    expect(source).not.toContain("if ($BunRuntimeSource)");
  });

  // This test really does launch PowerShell, which really does launch a Bun child, and
  // then rebinds the port to prove the child did not inherit the listen socket. Those
  // processes ARE the assertion — there is no version of this proof that fakes them.
  //
  // So the budget has to cover work the test genuinely performs. Production allows
  // PowerShell 15s (`execFileSync` timeout in src/tray/windows.ts), while Bun's default
  // test budget is 5s; a contended windows-latest runner lands between the two and the
  // test fails at ~5.1s having done nothing wrong.
  //
  // Raising a budget is NOT the general answer to a flaky test. Earlier in this same
  // round the sidebar route tests were fixed by DELETING their real `gh` spawn, because
  // spawning a binary was incidental to what those tests claimed. The distinction is
  // whether the wait is intrinsic to the assertion. Here it is; there it was not.
  const PID_FILE_WAIT_MS = INTERNAL_DEADLINE_MS;
  const TRAY_LAUNCH_TIMEOUT_MS = SPAWN_BUDGET_MS;

  test("launches the detached tray host without retaining the proxy listen socket", async () => {
    if (process.platform !== "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "ccx-tray-inheritance-"));
    const pidPath = join(directory, "child.pid");
    const childPath = join(directory, "child & %TEMP% 테스트.ts");
    copyFileSync(join(import.meta.dir, "helpers", "windows-tray-inheritance-child.ts"), childPath);
    const previousPidPath = process.env.CCX_TRAY_TEST_PID_FILE;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const port = server.port;
    let childPid = 0;
    let replacement: ReturnType<typeof Bun.serve> | undefined;

    try {
      process.env.CCX_TRAY_TEST_PID_FILE = pidPath;
      launchWindowsTrayHost({
        ...entry,
        bun: process.execPath,
        cli: childPath,
      });
      const pidDeadline = Date.now() + PID_FILE_WAIT_MS;
      while (!existsSync(pidPath) && Date.now() < pidDeadline) {
        await Bun.sleep(25);
      }
      // Name what actually went wrong. A bare `false` here means "the pid file is
      // missing" and nothing about whether PowerShell never started, the child died,
      // or the runner was simply slow — which is most of the work in diagnosing it.
      expect(
        existsSync(pidPath),
        `tray child never wrote ${pidPath} within ${PID_FILE_WAIT_MS}ms`,
      ).toBe(true);
      childPid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      expect(() => process.kill(childPid, 0)).not.toThrow();

      await server.stop(true);
      replacement = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: () => new Response("replacement"),
      });
      expect(replacement.port).toBe(port);
      expect(() => process.kill(childPid, 0)).not.toThrow();
    } finally {
      if (previousPidPath === undefined) delete process.env.CCX_TRAY_TEST_PID_FILE;
      else process.env.CCX_TRAY_TEST_PID_FILE = previousPidPath;
      if (replacement) await replacement.stop(true);
      await server.stop(true);
      if (childPid > 0) {
        try { process.kill(childPid); } catch { /* exact test child already exited */ }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, { timeout: TRAY_LAUNCH_TIMEOUT_MS });

  test("ships branded multi-size Windows tray icons", () => {
    const assets = join(import.meta.dir, "..", "src", "tray", "assets");
    for (const name of ["online", "warning", "offline"]) {
      const path = join(assets, `codexcommander-tray-${name}.ico`);
      expect(existsSync(path)).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.readUInt16LE(0)).toBe(0);
      expect(bytes.readUInt16LE(2)).toBe(1);
      expect(bytes.readUInt16LE(4)).toBeGreaterThanOrEqual(7);
    }
  });

  test("serves tray status without blocking the proxy event loop", async () => {
    if (process.platform !== "win32") return;
    const url = new URL("http://localhost/api/windows-tray");
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const responsePromise = handleManagementAPI(
      new Request(url),
      url,
      { port: 10100, providers: {}, defaultProvider: "openai" } as CodexCommanderConfig,
    );
    await Bun.sleep(50);
    expect(timerFired).toBe(true);
    clearTimeout(timer);
    const response = await responsePromise;
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.supported).toBe(true);
    expect(typeof body.installed).toBe("boolean");
    expect(typeof body.running).toBe("boolean");
  });

  test("copies the tray script into the hardened home with transactional replacement", () => {
    const root = join(import.meta.dir, "..");
    const tray = readFileSync(join(root, "src", "tray", "windows.ts"), "utf8");
    expect(tray).toContain('join(getConfigDir(), "codexcommander-tray.ps1")');
    expect(tray).toContain('join(import.meta.dir, "assets", name)');
    expect(tray).toContain("installedTrayIconPaths()");
    expect(tray).toContain("const hardened = hardenSecretPath(target, { required: true, timeoutMemoKey: path })");
    expect(tray).toContain("if (!hardened.ok)");
    expect(tray).toContain("if (!hardenedDir.ok)");
    expect(tray).toContain("refusing to replace its persistent script");
    expect(tray).toContain("restorePreviousInstall");
    expect(tray).toContain("previousStateBytes");
    expect(tray).toContain("previousScriptBytes");
    expect(tray).toContain('windowsTrayProcessArgs(entry, "Stop")');
    expect(tray).not.toContain("spawnTray(state)");
    expect(tray).toContain("return readWindowsTrayRunValueWithRunner(runValue, runRegistry)");
    expect(tray).toContain("return readWindowsTrayRunValueWithAsyncRunner(runValue, runRegistryAsync)");
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";

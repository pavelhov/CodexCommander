import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { windowsEnvIndirectBatchValue } from "../src/lib/win-paths";
import { assertServiceAuthEnvironment, assertServiceEnvironmentMatchesInstall, bakedServicePathsDiagnostic, confirmServiceServing, ensureLaunchdExecutable, launchdExecutableDiagnostic, launchdExecutablePath, launchdListenPort, systemdListenPort, buildPlist, buildUnit, buildWindowsLauncherVbs, buildWindowsSchtasksCreateArgs, buildWindowsServiceScript, buildWindowsTaskXml, deriveWindowsServiceDiagnostic, launchctlLoadFailed, launchdJobMatchesPlist, parseServiceInstallState, probeLaunchdSupervisor, probeSystemdSupervisor, readWindowsSchedulerXmlState, removeLaunchdExecutable, repairService, resolveServiceListenPort, runLaunchctl, serviceLogPath, serviceStartableFromTray, serviceStatusReport, serviceRetryCommand, serviceStatusSummary, startOwnedSystemdUnit, systemdNeedsDaemonReload, windowsListenPort, winswListenPort, startLaunchd, windowsTaskRegistrationHealthy } from "../src/service";
import type { ServiceDiagnostic } from "../src/service";
import { normalizeServiceSubcommand, parseServiceArgs, prepareServiceRoutingForStart, prepareServiceRoutingForTermination, runServiceLifecycleCommand, type ServiceCommandDependencies } from "../src/cli/service-command";
import type { ProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
import { buildWinswXml } from "../src/lib/winsw";
import { serviceApiTokenFilePath } from "../src/lib/service-secrets";
import type { CodexCommanderConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-service-test");
const previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousApiAuthToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;

afterEach(() => {
  if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousApiAuthToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = previousApiAuthToken;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

function pathVariants(path: string): string[] {
  const batchPath = windowsEnvIndirectBatchValue(path, windowsBatchValue);
  return [...new Set([
    path,
    path.replace(/\\/g, "\\\\"),
    batchPath,
    batchPath.replace(/\\/g, "\\\\"),
  ])];
}

function expectTextToContainPath(text: string, path: string): void {
  expect(pathVariants(path).some(candidate => text.includes(candidate))).toBe(true);
}

function serviceConfig(port: number): CodexCommanderConfig {
  return {
    port,
    multiAgentGuidanceEnabled: true,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
  };
}

describe("service listen-port bake", () => {
  test("resolveServiceListenPort prefers override, then CCX_BAKE_PORT, then config", () => {
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    saveConfig(serviceConfig(10100));
    expect(resolveServiceListenPort(18765)).toBe(18765);
    const prev = process.env.CCX_BAKE_PORT;
    try {
      process.env.CCX_BAKE_PORT = "15555";
      expect(resolveServiceListenPort()).toBe(15555);
      delete process.env.CCX_BAKE_PORT;
      expect(resolveServiceListenPort()).toBe(10100);
      saveConfig(serviceConfig(0));
      expect(resolveServiceListenPort()).toBe(10100);
    } finally {
      if (prev === undefined) delete process.env.CCX_BAKE_PORT;
      else process.env.CCX_BAKE_PORT = prev;
    }
  });

  test("service definitions bake start --port", () => {
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    saveConfig(serviceConfig(13337));
    const script = buildWindowsServiceScript({ bun: "C:\\CodexCommander\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\CodexCommander\\cli.ts" });
    expect(script).toContain("start --port 13337");
    const plist = buildPlist();
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<string>--port</string>");
    expect(plist).toContain("<string>13337</string>");
    expect(buildUnit()).toContain("start --port 13337");
  });

  test("app-owned service preserves the signed-bundle update boundary", () => {
    const previous = process.env.CCX_APP_RUNTIME;
    try {
      process.env.CCX_APP_RUNTIME = "1";
      const plist = buildPlist();
      expect(plist).toContain("<key>CCX_APP_RUNTIME</key><string>1</string>");
    } finally {
      if (previous === undefined) delete process.env.CCX_APP_RUNTIME;
      else process.env.CCX_APP_RUNTIME = previous;
    }
  });
});

describe("systemd service unit", () => {
  test("bare service command defaults to the install/update/start path", async () => {
    expect(normalizeServiceSubcommand()).toBe("install");
    expect(normalizeServiceSubcommand("start")).toBe("start");
    expect(normalizeServiceSubcommand("nope")).toBe("nope");

    expect(parseServiceArgs([])).toEqual({ sub: "install", backend: null, invalid: [] });
  });

  test("uses unquoted append targets for service logs", () => {
    const unit = buildUnit();

    expect(unit).toContain("StandardOutput=append:");
    expect(unit).toContain("StandardError=append:");
    expect(unit).not.toContain('StandardOutput="append:');
    expect(unit).not.toContain('StandardError="append:');
  });

  test("preserves custom Codex and CodexCommander homes", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
    const oldKimiCodeHome = process.env.KIMI_CODE_HOME;
    const oldGrokHome = process.env.GROK_HOME;
    const oldApiAuthToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home";
      process.env.CODEXCOMMANDER_HOME = "/tmp/codexcommander-home";
      process.env.KIMI_CODE_HOME = "/tmp/kimi-code-home";
      process.env.GROK_HOME = '/tmp/grok-"home\\100%';
      process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "local-secret";
      const unit = buildUnit();
      expect(unit).toContain('Environment="CODEX_HOME=/tmp/codex-home"');
      expect(unit).toContain('Environment="CODEXCOMMANDER_HOME=/tmp/codexcommander-home"');
      expect(unit).toContain('Environment="KIMI_CODE_HOME=/tmp/kimi-code-home"');
      expect(unit).toContain('Environment="GROK_HOME=/tmp/grok-\\"home\\\\100%%"');
      expectTextToContainPath(unit, serviceApiTokenFilePath());
      expect(unit).not.toContain("local-secret");
      expect(unit).not.toContain("Environment=\"CODEXCOMMANDER_API_AUTH_TOKEN=");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = oldCodexCommanderHome;
      if (oldKimiCodeHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = oldKimiCodeHome;
      if (oldGrokHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = oldGrokHome;
      if (oldApiAuthToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
      else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });

  test("service start proves the systemd user unit before shelling out", async () => {
    const service = await readText("src/service.ts");
    const installSystemd = service.slice(service.indexOf("function installSystemd()"), service.indexOf("export interface SystemdStartIo"));
    const calls: string[] = [];

    startOwnedSystemdUnit({
      ensureBus: () => { calls.push("bus"); },
      exists: () => true,
      assertOwned: () => { calls.push("owned"); },
      needsReload: () => false,
      run: command => { calls.push(command); },
    });
    expect(calls).toEqual(["bus", "owned", "systemctl --user start codexcommander-proxy"]);

    calls.length = 0;
    expect(() => startOwnedSystemdUnit({
      ensureBus: () => { calls.push("bus"); },
      exists: () => true,
      assertOwned: () => { throw new Error("foreign systemd definition"); },
      needsReload: () => false,
      run: command => { calls.push(command); },
    })).toThrow("foreign systemd definition");
    expect(calls).toEqual(["bus"]);

    const writeAt = installSystemd.indexOf("writePrivateServiceFile(unitPath(), buildUnit()");
    const reloadAt = installSystemd.indexOf("systemctl --user daemon-reload");
    const enableAt = installSystemd.indexOf("systemctl --user enable");
    const restartAt = installSystemd.indexOf("systemctl --user restart");
    expect(writeAt).toBeGreaterThan(-1);
    expect(writeAt).toBeLessThan(reloadAt);
    expect(reloadAt).toBeLessThan(enableAt);
    expect(enableAt).toBeLessThan(restartAt);
    expect(installSystemd).not.toContain("ccx service install");
  });
});

describe("service install auth preflight", () => {
  test("rejects non-loopback service install without a persisted API token", () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
    saveConfig({
      port: 10100,
      multiAgentGuidanceEnabled: true,
      hostname: "0.0.0.0",
      providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" } },
      defaultProvider: "openai",
    } as CodexCommanderConfig);

    expect(() => assertServiceAuthEnvironment()).toThrow("CODEXCOMMANDER_API_AUTH_TOKEN");
  });

  test("allows non-loopback service install when the API token is in the service environment", () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      port: 10100,
      multiAgentGuidanceEnabled: true,
      hostname: "0.0.0.0",
      providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" } },
      defaultProvider: "openai",
    } as CodexCommanderConfig);

    expect(() => assertServiceAuthEnvironment()).not.toThrow();
  });

  test("rejects restore operations from a different CODEX_HOME than service install", () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    process.env.CODEX_HOME = "/tmp/current-codex-home";
    writeFileSync(join(TEST_DIR, "service-state.json"), JSON.stringify({
      version: 3,
      codexHome: "/tmp/installed-codex-home",
      codexCommanderHome: TEST_DIR,
      bunPath: process.execPath,
      cliPath: join(import.meta.dir, "service.test.ts"),
      backend: "scheduler",
    }) + "\n");
    chmodSync(join(TEST_DIR, "service-state.json"), 0o600);

    expect(() => assertServiceEnvironmentMatchesInstall()).toThrow("Service was installed with CODEX_HOME");
  });
});

describe("Windows service task", () => {
  test("builds schtasks create args from XML instead of runtime flags", () => {
    const script = "C:\\Users\\a&b\\.codexcommander\\codexcommander-service.cmd";
    const args = buildWindowsSchtasksCreateArgs(script);

    expect(args).toContain("/create");
    expect(args).toContain("/xml");
    expect(args[args.indexOf("/xml") + 1]).toBe(`${script}.xml`);
    expect(args).not.toContain("/tr");
    expect(args).not.toContain("/sc");
    expect(args).not.toContain("/du");
    expect(args).not.toContain("/rl");
    expect(args).not.toContain("highest");
    expect(args.join(" ")).toContain("a&b");
  });

  test("builds service-like Task Scheduler XML settings", () => {
    const script = "C:\\Users\\a&b\\.codexcommander\\codexcommander-service.cmd";
    const launcher = "C:\\Users\\a&b\\.codexcommander\\codexcommander-service-launcher.vbs";
    const xml = buildWindowsTaskXml(script, launcher);

    expect(xml).toContain('<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">');
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("<Count>3</Count>");
    // The action is wscript running the hidden VBS launcher, never the console batch directly.
    expect(xml).toMatch(/<Command>.*wscript\.exe<\/Command>/);
    expect(xml).toContain('<Arguments>/b /nologo &quot;C:\\Users\\a&amp;b\\.codexcommander\\codexcommander-service-launcher.vbs&quot;</Arguments>');
    expect(xml).not.toContain("<Command>C:\\Users\\a&amp;b\\.codexcommander\\codexcommander-service.cmd</Command>");
  });

  test("validates the registered scheduler action, trigger, principal, and settings", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher).replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    expect(windowsTaskRegistrationHealthy(xml, wscript, launcher)).toBe(true);
    for (const mutated of [
      xml.replace("<LogonTrigger>", "<BootTrigger>"),
      xml.replace("InteractiveToken", "Password"),
      xml.replace("LeastPrivilege", "InvalidLevel"),
      xml.replace("IgnoreNew", "Parallel"),
      xml.replace(wscript, "C:\\Windows\\System32\\cmd.exe"),
      xml.replace(launcher, "C:\\Temp\\foreign.vbs"),
    ]) expect(windowsTaskRegistrationHealthy(mutated, wscript, launcher)).toBe(false);
  });

  // --- #432: Task Scheduler omits schema defaults when exporting ---------------

  test("accepts canonicalized scheduler XML with omitted defaults", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // Windows drops elements equal to their schema default when it exports a task:
    // Trigger/Settings Enabled default to true and RunLevel defaults to LeastPrivilege.
    const canonical = xml
      .replace("<LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>", "<LogonTrigger />")
      .replace("    <RunLevel>LeastPrivilege</RunLevel>\n", "")
      .replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Hidden>");
    expect(canonical).toContain("<LogonTrigger />");
    expect(canonical).not.toContain("RunLevel");

    expect(windowsTaskRegistrationHealthy(canonical, wscript, launcher)).toBe(true);
    expect(readWindowsSchedulerXmlState(canonical, wscript, launcher)).toMatchObject({
      installed: true,
      enabled: true,
      registrationHealthy: true,
    });
  });

  // --- #608: Task Scheduler canonicalizes escaped text when exporting ---------

  test("accepts an export whose Arguments quotes were canonicalized", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // We write `&quot;`; Task Scheduler hands the same value back with literal
    // quotes. Comparing encodings made a healthy task read as permanently stale.
    const canonical = xml.replace(
      `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
      `<Arguments>/b /nologo "${launcher}"</Arguments>`,
    );
    expect(canonical).toContain(`<Arguments>/b /nologo "${launcher}"</Arguments>`);
    expect(windowsTaskRegistrationHealthy(canonical, wscript, launcher)).toBe(true);
    // The escaped form we emit must keep working too.
    expect(windowsTaskRegistrationHealthy(xml, wscript, launcher)).toBe(true);
  });

  test("accepts a canonicalized export whose launcher path contains an ampersand", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\a&b\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // `&` stays `&amp;` (it must, or the XML is malformed); only the quotes flip.
    const canonical = xml.replace(
      "<Arguments>/b /nologo &quot;C:\\Users\\a&amp;b\\.codexcommander\\service-launcher.vbs&quot;</Arguments>",
      "<Arguments>/b /nologo \"C:\\Users\\a&amp;b\\.codexcommander\\service-launcher.vbs\"</Arguments>",
    );
    expect(windowsTaskRegistrationHealthy(canonical, wscript, launcher)).toBe(true);
  });

  test("the canonicalization tolerance does not weaken the launcher check", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const canonicalArgs = `<Arguments>/b /nologo "${launcher}"</Arguments>`;
    const canonical = xml.replace(
      `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
      canonicalArgs,
    );

    for (const [reason, mutated] of [
      // A foreign launcher must still be refused in the canonical shape.
      ["foreign launcher", canonical.replace(launcher, "C:\\Temp\\foreign.vbs")],
      // A foreign interpreter, likewise.
      ["foreign command", canonical.replace(wscript, "C:\\Windows\\System32\\cmd.exe")],
      // Decoding twice would accept this; we decode once.
      ["double-encoded quotes", xml.replace(
        `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
        `<Arguments>/b /nologo &amp;quot;${launcher}&amp;quot;</Arguments>`,
      )],
      // Absence is not a schema default here — it means nothing runs.
      ["missing Arguments", canonical.replace(canonicalArgs, "")],
      // Two elements make "which one runs?" ambiguous.
      ["duplicate Arguments", canonical.replace(canonicalArgs, `${canonicalArgs}${canonicalArgs}`)],
      // A namespace-prefixed element must not read as absent.
      ["prefixed Arguments", canonical.replace("<Arguments>", "<t:Arguments>").replace("</Arguments>", "</t:Arguments>")],
    ] as const) {
      expect(windowsTaskRegistrationHealthy(mutated, wscript, launcher), reason).toBe(false);
    }
  });

  test("accepts elevated-create rewrites (HighestAvailable, path casing, raw quotes)", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>C:\\WINDOWS\\System32\\wscript.exe</Command>`)
      .replace("<RunLevel>LeastPrivilege</RunLevel>", "<RunLevel>HighestAvailable</RunLevel>")
      .replace(
        `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
        `<Arguments>/b /nologo "${launcher}"</Arguments>`,
      );
    expect(windowsTaskRegistrationHealthy(xml, wscript, launcher)).toBe(true);
  });

  test("rejects explicit unsafe values even though defaults may be omitted", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);

    // Trigger disabled explicitly.
    expect(windowsTaskRegistrationHealthy(
      xml.replace("<LogonTrigger>\n      <Enabled>true</Enabled>", "<LogonTrigger>\n      <Enabled>false</Enabled>"),
      wscript,
      launcher,
    )).toBe(false);
    // Settings disabled explicitly.
    const settingsDisabled = xml.replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>");
    expect(windowsTaskRegistrationHealthy(settingsDisabled, wscript, launcher)).toBe(false);
    expect(readWindowsSchedulerXmlState(settingsDisabled, wscript, launcher).enabled).toBe(false);
  });

  test("a decoy trigger outside Triggers does not satisfy the logon requirement", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const bootOnly = xml.replace("<LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>", "<BootTrigger />");

    // The schema allows arbitrary XML under Task/Data, and comments could smuggle a
    // decoy too — neither may stand in for a real logon trigger.
    for (const decoyed of [
      bootOnly.replace("<Triggers>", "<Data><LogonTrigger /></Data>\n  <Triggers>"),
      bootOnly.replace("<Triggers>", "<!-- <LogonTrigger /> -->\n  <Triggers>"),
    ]) expect(windowsTaskRegistrationHealthy(decoyed, wscript, launcher)).toBe(false);
  });

  test("namespace-prefixed values are not mistaken for omissions", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);

    // A prefixed element carries a real value; reading it as "absent, use the
    // default" would turn an explicitly disabled or elevated task into a healthy one.
    for (const prefixed of [
      xml.replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <t:Enabled>false</t:Enabled>\n    <Hidden>"),
      xml.replace("<RunLevel>LeastPrivilege</RunLevel>", "<t:RunLevel>HighestAvailable</t:RunLevel>"),
    ]) expect(windowsTaskRegistrationHealthy(prefixed, wscript, launcher)).toBe(false);
  });

  test("a Data block disqualifies the registration", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    // taskXmlSection() takes the first match, so a Data block placed ahead of the
    // real sections could shadow them. We never emit Data, prefixed or not.
    const shadowedSettings = xml
      .replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>")
      .replace("<Triggers>", "<Data><Settings><Enabled>true</Enabled></Settings></Data>\n  <Triggers>");
    const shadowedPrincipal = xml
      .replace("LeastPrivilege", "HighestAvailable")
      .replace("<Triggers>", "<Data><Principal><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Data>\n  <Triggers>");
    const prefixedData = xml
      .replace("    <Enabled>true</Enabled>\n    <Hidden>", "    <Enabled>false</Enabled>\n    <Hidden>")
      .replace("<Triggers>", "<t:Data><Settings><Enabled>true</Enabled></Settings></t:Data>\n  <Triggers>");

    for (const shadowed of [shadowedSettings, shadowedPrincipal, prefixedData]) {
      expect(windowsTaskRegistrationHealthy(shadowed, wscript, launcher)).toBe(false);
      expect(readWindowsSchedulerXmlState(shadowed, wscript, launcher).enabled).toBe(false);
    }
  });

  test("duplicate elements are not trusted", () => {
    const wscript = "C:\\Windows\\System32\\wscript.exe";
    const launcher = "C:\\Users\\Test\\.codexcommander\\service-launcher.vbs";
    const xml = buildWindowsTaskXml("ignored.cmd", launcher)
      .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const duplicated = xml.replace(
      "    <Enabled>true</Enabled>\n    <Hidden>",
      "    <Enabled>true</Enabled>\n    <Enabled>false</Enabled>\n    <Hidden>",
    );
    expect(windowsTaskRegistrationHealthy(duplicated, wscript, launcher)).toBe(false);
  });

  test("hidden launcher VBS stays resident and escapes quotes in the wrapper path", () => {
    const vbs = buildWindowsLauncherVbs('C:\\Users\\quo"te\\.codexcommander\\codexcommander-service.cmd');

    // windowStyle 0 (hidden) + bWaitOnReturn True (resident, so IgnoreNew and /end keep working).
    expect(vbs).toContain(", 0, True");
    expect(vbs).toContain('shell.Run """C:\\Users\\quo""te\\.codexcommander\\codexcommander-service.cmd""", 0, True');
    expect(vbs).toContain('CreateObject("WScript.Shell")');
  });

  test("hidden launcher VBS carries non-ASCII profile paths verbatim", () => {
    const vbs = buildWindowsLauncherVbs("C:\\Users\\한글사용자\\.codexcommander\\codexcommander-service.cmd");

    expect(vbs).toContain("C:\\Users\\한글사용자\\.codexcommander\\codexcommander-service.cmd");
  });

  test("writes the launcher VBS with a UTF-16 BOM so non-ASCII paths survive WSH decoding", async () => {
    const service = await Bun.file(new URL("../src/service.ts", import.meta.url)).text();

    expect(service).toContain('writeServiceAssetWithRetry(windowsLauncherVbsPath(), `\\uFEFF${buildWindowsLauncherVbs(script)}`, "utf16le", ownsWindowsLauncherVbs)');
    // Uninstall must clean the launcher asset alongside the script and task XML.
    const uninstallWindows = service.slice(service.indexOf("function uninstallWindows()"), service.indexOf("function serviceDiagnosticsSummary"));
    expect(uninstallWindows).toContain('"codexcommander-service-launcher.vbs"');
  });

  test("writes Task Scheduler XML with a UTF-16 BOM for schtasks", async () => {
    const service = await Bun.file(new URL("../src/service.ts", import.meta.url)).text();

    expect(service).toContain('writeServiceAssetWithRetry(windowsTaskXmlPath(), `\\uFEFF${buildWindowsTaskXml(script)}`, "utf16le", ownsWindowsTaskXml)');
  });

  test("escapes environment values that would break out of set quotes", () => {
    const oldPath = process.env.PATH;
    const oldCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
    const oldKimiCodeHome = process.env.KIMI_CODE_HOME;
    const oldGrokHome = process.env.GROK_HOME;
    const oldApiAuthToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
    try {
      process.env.PATH = 'C:\\safe" & echo PWNED & rem "';
      process.env.CODEXCOMMANDER_HOME = 'C:\\ccx" & del C:\\important & rem "';
      process.env.KIMI_CODE_HOME = 'C:\\kimi" & del C:\\important & rem "';
      process.env.GROK_HOME = 'C:\\grok" & del C:\\important & rem "';
      process.env.CODEXCOMMANDER_API_AUTH_TOKEN = 'token" & echo LEAK & rem "';
      const script = buildWindowsServiceScript();
      expect(script).toContain('set "PATH=C:\\safe & echo PWNED & rem "');
      expect(script).toContain('set "CODEXCOMMANDER_HOME=C:\\ccx & del C:\\important & rem "');
      expect(script).toContain('set "KIMI_CODE_HOME=C:\\kimi & del C:\\important & rem "');
      expect(script).toContain('set "GROK_HOME=C:\\grok & del C:\\important & rem "');
      expect(script).toContain('set "CCX_API_TOKEN_FILE=');
      expect(script).toContain('set /p CODEXCOMMANDER_API_AUTH_TOKEN=<"%CCX_API_TOKEN_FILE%"');
      expect(script).not.toContain('set "PATH=C:\\safe" & echo PWNED');
      expect(script).not.toContain('set "CODEXCOMMANDER_HOME=C:\\ccx" & del');
      expect(script).not.toContain('set "KIMI_CODE_HOME=C:\\kimi" & del');
      expect(script).not.toContain('set "GROK_HOME=C:\\grok" & del');
      expect(script).not.toContain("token & echo LEAK");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = oldCodexCommanderHome;
      if (oldKimiCodeHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = oldKimiCodeHome;
      if (oldGrokHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = oldGrokHome;
      if (oldApiAuthToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
      else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });

  test("escapes service executable paths through variables", () => {
    const script = buildWindowsServiceScript({
      bun: "C:\\Bun&Dir\\100%bun^\\bun.exe",
      bunRuntimeSource: "bundled",
      cli: "C:\\CodexCommander&Dir\\cli.ts",
    });

    expect(script).toContain('set "CCX_BUN=C:\\Bun&Dir\\100%%bun^^\\bun.exe"');
    expect(script).toContain('set "CCX_CLI=C:\\CodexCommander&Dir\\cli.ts"');
    expect(script).toContain('"%CCX_BUN%" "%CCX_CLI%" start --port');
    expect(script).not.toContain('"C:\\Bun&Dir\\100%bun^\\bun.exe"');
  });

  test("switches the wrapper console to UTF-8 and sleeps via ping (timeout dies without console stdin)", () => {
    const script = buildWindowsServiceScript({ bun: "C:\\CodexCommander\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\CodexCommander\\cli.ts" });

    expect(script).toContain("chcp 65001 >nul");
    expect(script.indexOf("chcp 65001 >nul")).toBeLessThan(script.indexOf('set "CCX_SERVICE=1"'));
    expect(script).toContain("ping -n 6 127.0.0.1 >nul");
    expect(script).not.toContain("timeout /t");
  });

  test("rewrites profile-relative paths to env indirection so non-ASCII usernames survive OEM-codepage batch parsing", () => {
    const oldUserProfile = process.env.USERPROFILE;
    const oldAppData = process.env.APPDATA;
    try {
      process.env.USERPROFILE = "C:\\Users\\한글사용자";
      process.env.APPDATA = "C:\\Users\\한글사용자\\AppData\\Roaming";
      const script = buildWindowsServiceScript({
        bun: "C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe",
        bunRuntimeSource: "bundled",
        cli: "C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\node_modules\\codexcommander\\src\\cli.ts",
      });

      expect(script).toContain('set "CCX_BUN=%APPDATA%\\npm\\node_modules\\bun\\bin\\bun.exe"');
      expect(script).toContain('set "CCX_CLI=%APPDATA%\\npm\\node_modules\\codexcommander\\src\\cli.ts"');
      expect(script).not.toContain('set "CCX_BUN=C:\\Users\\한글사용자');
    } finally {
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = oldAppData;
    }
  });

  test("writes token-safe startup identity and child output to the service log", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
    const oldApiAuthToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "C:\\codex-home";
      process.env.CODEXCOMMANDER_HOME = TEST_DIR;
      process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "local-secret";
      const script = buildWindowsServiceScript({
        bun: "C:\\CodexCommander\\bun.exe",
        bunRuntimeSource: "bundled",
        cli: "C:\\CodexCommander\\cli.ts",
      });

      expectTextToContainPath(script, serviceLogPath());
      expect(script).toContain('set "CCX_SERVICE_LOG=');
      expect(script).toContain("codexcommander service wrapper start");
      expect(script).toContain('echo bun="%CCX_BUN%"');
      expect(script).toContain('echo bun_source="');
      expect(script).toContain('echo cli="%CCX_CLI%"');
      expect(script).toContain('set "CODEXCOMMANDER_HOME=');
      expect(script).toContain('echo codexcommander_home="%CODEXCOMMANDER_HOME%"');
      expect(script).toContain('echo codex_home="%CODEX_HOME%"');
      expect(script).toContain('echo token_file="%CCX_API_TOKEN_FILE%"');
      expect(script).toMatch(/"%CCX_BUN%" "%CCX_CLI%" start --port \d+ >>"%CCX_SERVICE_LOG%" 2>&1/);
      expect(script).toContain("child exited with code %ERRORLEVEL%");
      expect(script).not.toContain("local-secret");
      expect(script).not.toContain('set "CODEXCOMMANDER_API_AUTH_TOKEN=');
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = oldCodexCommanderHome;
      if (oldApiAuthToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
      else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });
});

describe("launchd service plist", () => {
  test("every durable launcher stamps the Bun provenance paired with the binary it baked (#848)", () => {
    const inheritedOverride = process.env.CCX_BUN_PATH;
    const inheritedSource = process.env.CCX_BUN_RUNTIME_SOURCE;
    const inheritedPath = process.env.CCX_BUN_RUNTIME_PATH;
    const overrideBun = join(TEST_DIR, "provenance-override-bun.exe");
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(overrideBun, "x".repeat(2 * 1024 * 1024));
    try {
      // CCX_BUN_PATH is consumed by the Node launcher before Bun can load a
      // project dotenv. Once Bun is running, an unpaired value is untrusted and
      // must never be persisted into a durable launcher.
      delete process.env.CCX_BUN_RUNTIME_SOURCE;
      delete process.env.CCX_BUN_RUNTIME_PATH;
      process.env.CCX_BUN_PATH = overrideBun;
      const plist = buildPlist();
      expect(plist).not.toContain("<key>CCX_BUN_RUNTIME_SOURCE</key><string>override</string>");
      expect(plist).not.toContain(overrideBun);

      const unit = buildUnit();
      expect(unit).not.toContain('Environment="CCX_BUN_RUNTIME_SOURCE=override"');
      expect(unit).not.toContain(overrideBun);

      const script = buildWindowsServiceScript();
      expect(script).not.toContain('set "CCX_BUN_RUNTIME_SOURCE=override"');
      expect(script).not.toContain(overrideBun);

      // A source/path pair stamped by the Node launcher is accepted only when it
      // names the Bun executable that is actually running this process.
      process.env.CCX_BUN_RUNTIME_SOURCE = "override";
      process.env.CCX_BUN_RUNTIME_PATH = process.execPath;
      const trustedPlist = buildPlist();
      expect(trustedPlist).toContain("<key>CCX_BUN_RUNTIME_SOURCE</key><string>override</string>");
      expectTextToContainPath(trustedPlist, process.execPath);
      expect(buildUnit()).toContain('Environment="CCX_BUN_RUNTIME_SOURCE=override"');
      expect(buildWindowsServiceScript()).toContain('set "CCX_BUN_RUNTIME_SOURCE=override"');
    } finally {
      if (inheritedOverride === undefined) delete process.env.CCX_BUN_PATH;
      else process.env.CCX_BUN_PATH = inheritedOverride;
      if (inheritedSource === undefined) delete process.env.CCX_BUN_RUNTIME_SOURCE;
      else process.env.CCX_BUN_RUNTIME_SOURCE = inheritedSource;
      if (inheritedPath === undefined) delete process.env.CCX_BUN_RUNTIME_PATH;
      else process.env.CCX_BUN_RUNTIME_PATH = inheritedPath;
    }
  });

  test("runs the named CodexCommander executable directly", () => {
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    const plist = buildPlist();

    expectTextToContainPath(plist, launchdExecutablePath());
    expect(plist).not.toContain("<string>/bin/sh</string>");
    expect(plist).not.toContain("<string>-lc</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<string>--port</string>");
  });

  test("creates a stable unsigned CodexCommander launcher that forwards tokenized arguments", () => {
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    const bun = join(TEST_DIR, "bun-one");

    const launcher = ensureLaunchdExecutable(bun);
    expect(launcher).toBe(launchdExecutablePath());
    const metadata = lstatSync(launcher);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.mode & 0o111).not.toBe(0);
    const content = readFileSync(launcher, "utf8");
    expect(content).toContain("CodexCommander managed launchd launcher v1");
    expect(content).toContain(`exec '${bun}' "$@"`);
  });

  test("updates only a launcher proven by install state and the installed plist", () => {
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    const firstBun = join(TEST_DIR, "bun-one");
    const secondBun = join(TEST_DIR, "bun-two");
    const launcher = ensureLaunchdExecutable(firstBun);
    const state = {
      version: 3 as const,
      codexHome: TEST_DIR,
      codexCommanderHome: TEST_DIR,
      bunPath: firstBun,
      cliPath: join(TEST_DIR, "cli.ts"),
      backend: "scheduler" as const,
    };
    const deps = { readInstallState: () => state, readPlist: () => buildPlist() };

    ensureLaunchdExecutable(secondBun, deps);
    expect(lstatSync(launcher).isSymbolicLink()).toBe(false);
    expect(readFileSync(launcher, "utf8")).toContain(`exec '${secondBun}' "$@"`);
  });

  test("refuses the previous managed Bun symlink even with installed service evidence", () => {
    if (process.platform === "win32") return;
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    const firstBun = join(TEST_DIR, "bun-one");
    const secondBun = join(TEST_DIR, "bun-two");
    const launcher = launchdExecutablePath();
    symlinkSync(firstBun, launcher);
    const state = {
      version: 3 as const,
      codexHome: TEST_DIR,
      codexCommanderHome: TEST_DIR,
      bunPath: firstBun,
      cliPath: join(TEST_DIR, "cli.ts"),
      backend: "scheduler" as const,
    };

    const deps = {
      readInstallState: () => state,
      readPlist: () => buildPlist(),
    };

    expect(() => ensureLaunchdExecutable(secondBun, deps)).toThrow(/foreign/);
    expect(lstatSync(launcher).isSymbolicLink()).toBe(true);
    expect(readlinkSync(launcher)).toBe(firstBun);
    expect(removeLaunchdExecutable(deps)).toBe(false);
    expect(readlinkSync(launcher)).toBe(firstBun);
  });

  test("never replaces a foreign regular file or symlink", () => {
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    const launcher = launchdExecutablePath();
    const bun = join(TEST_DIR, "bun");
    const noInstalledService = { readInstallState: () => null };

    writeFileSync(launcher, "user-owned");
    expect(() => ensureLaunchdExecutable(bun, noInstalledService)).toThrow(/foreign/);
    expect(readFileSync(launcher, "utf8")).toBe("user-owned");

    if (process.platform === "win32") return;
    unlinkSync(launcher);
    symlinkSync(bun, launcher);
    expect(() => ensureLaunchdExecutable(bun, noInstalledService)).toThrow(/foreign/);
    expect(readlinkSync(launcher)).toBe(bun);
    expect(removeLaunchdExecutable(noInstalledService)).toBe(false);
    expect(readlinkSync(launcher)).toBe(bun);
  });

  test("uninstall removes only a launcher proven to belong to this service", () => {
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    const bun = join(TEST_DIR, "bun");
    const launcher = ensureLaunchdExecutable(bun);
    const state = {
      version: 3 as const,
      codexHome: TEST_DIR,
      codexCommanderHome: TEST_DIR,
      bunPath: bun,
      cliPath: join(TEST_DIR, "cli.ts"),
      backend: "scheduler" as const,
    };

    expect(removeLaunchdExecutable({
      readInstallState: () => state,
      readPlist: () => buildPlist(),
    })).toBe(true);
    expect(existsSync(launcher)).toBe(false);
  });

  test("diagnoses a missing or modified launcher without replacing it", () => {
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    const bun = join(TEST_DIR, "bun");
    const launcher = ensureLaunchdExecutable(bun);
    const state = {
      version: 3 as const,
      codexHome: TEST_DIR,
      codexCommanderHome: TEST_DIR,
      bunPath: bun,
      cliPath: join(TEST_DIR, "cli.ts"),
      backend: "scheduler" as const,
    };
    const deps = { readInstallState: () => state, readPlist: () => buildPlist() };

    expect(launchdExecutableDiagnostic(deps)).toBeNull();
    unlinkSync(launcher);
    expect(launchdExecutableDiagnostic(deps)).toContain("missing");
    writeFileSync(launcher, "user-owned", { mode: 0o700 });
    expect(launchdExecutableDiagnostic(deps)).toContain("STALE");
    expect(readFileSync(launcher, "utf8")).toBe("user-owned");
  });

  test("preserves custom Codex and CodexCommander homes", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
    const oldKimiCodeHome = process.env.KIMI_CODE_HOME;
    const oldGrokHome = process.env.GROK_HOME;
    const oldApiAuthToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home";
      process.env.CODEXCOMMANDER_HOME = "/tmp/codexcommander-home";
      process.env.KIMI_CODE_HOME = "/tmp/kimi-code-home";
      process.env.GROK_HOME = "/tmp/grok-home & <profile>";
      process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "local-secret";
      const plist = buildPlist();
      expect(plist).toContain("<key>CODEX_HOME</key><string>/tmp/codex-home</string>");
      expect(plist).toContain("<key>CODEXCOMMANDER_HOME</key><string>/tmp/codexcommander-home</string>");
      expect(plist).toContain("<key>KIMI_CODE_HOME</key><string>/tmp/kimi-code-home</string>");
      expect(plist).toContain("<key>GROK_HOME</key><string>/tmp/grok-home &amp; &lt;profile&gt;</string>");
      expect(plist).toContain("<key>CCX_API_TOKEN_FILE</key>");
      expectTextToContainPath(plist, serviceApiTokenFilePath());
      expect(plist).not.toContain("local-secret");
      expect(plist).not.toContain("<key>CODEXCOMMANDER_API_AUTH_TOKEN</key>");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = oldCodexCommanderHome;
      if (oldKimiCodeHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = oldKimiCodeHome;
      if (oldGrokHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = oldGrokHome;
      if (oldApiAuthToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
      else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = oldApiAuthToken;
    }
  });
});

describe("service lifecycle cleanup ordering", () => {
  const diagnostic = (
    registrationState: ServiceDiagnostic["registrationState"] = "present",
    supervisorState: ServiceDiagnostic["supervisorState"] = "active",
  ): ServiceDiagnostic => ({
    supported: true,
    registrationState,
    supervisorState,
    installed: registrationState !== "absent",
    enabled: supervisorState === "active",
    running: supervisorState === "active",
    viable: registrationState === "present" && supervisorState === "active",
    startable: registrationState === "present" && supervisorState !== "indeterminate",
    stale: false,
    conflict: false,
    backend: "systemd",
    summary: `${registrationState}/${supervisorState}`,
  });

  function fakeAuthority(calls: string[], initialStartHeld: boolean): ProxyLifecycleAuthority {
    let startHeld = initialStartHeld;
    const value: ProxyLifecycleAuthority = {
      deadlineAt: Number.POSITIVE_INFINITY,
      ensure: { token: "E", release: () => value.releaseAll() },
      get start() { return startHeld ? { token: "S", release: () => value.releaseStart() } : undefined; },
      acquireStart: async () => {
        calls.push("reacquire-S");
        startHeld = true;
        return { token: "S2", release: () => value.releaseStart() };
      },
      delegatedLease: () => startHeld ? { ensureToken: "E", startToken: "S" } : undefined,
      releaseStart: () => {
        if (!startHeld) return;
        startHeld = false;
        calls.push("release-S");
      },
      releaseAll: () => {
        value.releaseStart();
        calls.push("release-E");
      },
    };
    return value;
  }

  function commandDeps(calls: string[], diagnoses: ServiceDiagnostic[]): Partial<ServiceCommandDependencies> {
    return {
      platform: "linux",
      acquireAuthority: async includeStart => {
        calls.push(`acquire-${includeStart ? "ES" : "E"}`);
        return fakeAuthority(calls, includeStart);
      },
      assertEnvironment: () => { calls.push("environment"); },
      assertAuthEnvironment: () => { calls.push("auth"); },
      readBackend: () => "scheduler",
      operations: () => ({
        install: async () => { calls.push("install"); },
        start: () => { calls.push("start"); },
        stop: () => { calls.push("manager-stop"); },
        uninstall: () => { calls.push("uninstall"); },
      }),
      armServiceStartDelegation: ensureToken => {
        calls.push(`arm-delegation:${ensureToken}`);
        return {
          token: "delegation",
          ensureToken,
          ownerPid: process.pid,
          expiresAt: Date.now() + 1_000,
        };
      },
      clearServiceStartDelegation: () => { calls.push("clear-delegation"); },
      prepareStart: () => { calls.push("route-start"); return { success: true, changed: true, message: "ready" }; },
      syncStartedService: async lease => {
        calls.push(`sync-started:${lease.ensureToken}/${lease.startToken}`);
        return {
          status: "applied",
          ok: true,
          added: 1,
          catalogPath: "/tmp/models.json",
          catalogExists: true,
          catalogWritten: true,
          cacheSynced: true,
          catalogQuality: "live",
          rehydrated: 0,
          message: "synced",
          activation: { routing: { status: "current" } },
        };
      },
      prepareTermination: () => {
        calls.push("route-native");
        const codex = { success: true, changed: true, message: "native" };
        return { ...codex, codex, grok: { ok: true, changed: false, message: "native" } };
      },
      diagnose: () => {
        calls.push("diagnose");
        return diagnoses.shift() ?? diagnostic("present", "inactive");
      },
      cleanupTrackedProxy: async () => { calls.push("cleanup"); },
      stopInstalledService: () => { calls.push("manager-stop"); return true; },
      uninstallInstalledService: () => { calls.push("uninstall"); return true; },
      supervisorInactive: value => value.supervisorState === "inactive",
      probeStopped: async canRespawn => { calls.push(`probe-${canRespawn ? "bounded" : "once"}`); return null; },
      finalProxyProbe: async () => { calls.push("deletion-probe"); return null; },
      removeState: () => { calls.push("remove-state"); },
      removeToken: () => { calls.push("remove-token"); },
      reportServing: async verb => { calls.push(`serving-${verb}`); return true; },
      resolveListenPort: () => 10100,
      statusReport: async () => "status",
      schedulerStatusReport: async () => "scheduler-status",
      diagnosticsSummary: () => "diagnostics",
      repair: async () => { calls.push("repair"); },
      log: message => { calls.push(`log:${message}`); },
      error: message => { calls.push(`error:${message}`); },
      fail: () => { calls.push("fail"); },
    };
  }

  test("install, start, and repair remain native during manager mutation, then sync under E+S", async () => {
    for (const [args, spawn] of [[[], "install"], [["start"], "start"], [["repair"], "repair"]] as const) {
      const calls: string[] = [];
      await runServiceLifecycleCommand([...args], commandDeps(calls, []));
      const nativeAt = calls.indexOf("route-native");
      const spawnAt = calls.indexOf(spawn);
      const enabledAt = calls.indexOf("route-start");
      const syncedAt = calls.indexOf("sync-started:E/S");
      expect(nativeAt).toBeGreaterThan(-1);
      expect(nativeAt).toBeLessThan(spawnAt);
      expect(spawnAt).toBeLessThan(enabledAt);
      expect(enabledAt).toBeLessThan(syncedAt);
      expect(calls.slice(nativeAt, spawnAt)).toEqual([
        "route-native",
        "arm-delegation:E",
        "release-S",
      ]);
      expect(calls.indexOf("clear-delegation")).toBeGreaterThan(spawnAt);
      expect(calls.indexOf("clear-delegation")).toBeLessThan(enabledAt);
      expect(calls.slice(spawnAt, syncedAt)).toContain("reacquire-S");
    }
  });

  test("macOS, Linux, and both Windows service parents use the same one-shot child proof", async () => {
    for (const [platform, backend, args] of [
      ["darwin", "scheduler", ["start"]],
      ["linux", "scheduler", ["start"]],
      ["win32", "scheduler", ["start"]],
      ["win32", "native", ["install", "--native"]],
    ] as const) {
      const calls: string[] = [];
      await runServiceLifecycleCommand([...args], {
        ...commandDeps(calls, []),
        platform,
        readBackend: () => backend,
      });
      const launchAt = Math.max(calls.indexOf("start"), calls.indexOf("install"));
      expect(calls.indexOf("arm-delegation:E")).toBeLessThan(launchAt);
      expect(calls.indexOf("release-S")).toBeLessThan(launchAt);
      expect(calls.indexOf("clear-delegation")).toBeGreaterThan(launchAt);
      expect(calls.indexOf("clear-delegation")).toBeLessThan(
        calls.indexOf("route-start"),
      );
      expect(calls).not.toContain("fail");
    }
  });

  test("service manager start failure leaves the pre-mutation native route in place", async () => {
    const calls: string[] = [];
    await runServiceLifecycleCommand(["start"], {
      ...commandDeps(calls, []),
      operations: () => ({
        install: async () => { calls.push("install"); },
        start: () => { calls.push("start-refused"); throw new Error("manager refused"); },
        stop: () => {},
        uninstall: () => {},
      }),
    });

    expect(calls).toEqual([
      "environment", "acquire-E", "reacquire-S", "route-native", "arm-delegation:E",
      "release-S", "start-refused", "reacquire-S", "clear-delegation",
      "error:❌ service start failed; Codex remains native/OFF: manager refused",
      "fail", "release-S", "release-E",
    ]);
  });

  test("service readiness timeout leaves the pre-mutation native route in place", async () => {
    const calls: string[] = [];
    await runServiceLifecycleCommand(["start"], {
      ...commandDeps(calls, []),
      reportServing: async verb => { calls.push(`serving-${verb}:timeout`); return false; },
    });

    expect(calls).toEqual([
      "environment", "acquire-E", "reacquire-S", "route-native", "arm-delegation:E",
      "release-S", "start", "serving-started:timeout", "reacquire-S", "clear-delegation",
      "error:❌ service start did not become healthy; Codex remains native/OFF.",
      "fail", "release-S", "release-E",
    ]);
  });

  test("service routing preparation short-circuits Grok when Codex native escape fails", () => {
    const calls: string[] = [];
    const failed = prepareServiceRoutingForTermination({
      prepareStop: () => {
        calls.push("codex");
        return {
          success: false,
          changed: false,
          desiredChanged: false,
          configChanged: false,
          message: "escape refused",
        };
      },
      stripGrok: () => {
        calls.push("grok");
        return { ok: true, changed: true, message: "stripped" };
      },
    });

    expect(failed.success).toBe(false);
    expect(failed.grok).toBeNull();
    expect(calls).toEqual(["codex"]);
  });

  test("service routing preparation proves Codex before stripping Grok", () => {
    const calls: string[] = [];
    const prepared = prepareServiceRoutingForTermination({
      prepareStop: () => {
        calls.push("codex");
        return {
          success: true,
          changed: true,
          desiredChanged: true,
          configChanged: true,
          message: "native",
        };
      },
      stripGrok: () => {
        calls.push("grok");
        return { ok: true, changed: false, message: "already native" };
      },
    });

    expect(prepared.success).toBe(true);
    expect(calls).toEqual(["codex", "grok"]);
  });

  test("service start preparation forwards a refusal without running another path", () => {
    const calls: string[] = [];
    const result = prepareServiceRoutingForStart({
      prepareStart: () => {
        calls.push("prepare");
        return { success: false, changed: false, message: "journal remains" };
      },
    });
    expect(result).toEqual({ success: false, changed: false, message: "journal remains" });
    expect(calls).toEqual(["prepare"]);
  });

  test("stop proves admission before routing and releases S before postconditions", async () => {
    const calls: string[] = [];
    await runServiceLifecycleCommand(["stop"], commandDeps(calls, [
      diagnostic("present", "active"),
      diagnostic("present", "inactive"),
    ]));
    expect(calls).toEqual([
      "environment", "acquire-ES", "diagnose", "route-native", "manager-stop",
      "cleanup", "release-S", "diagnose", "probe-once",
      "log:✅ service stopped + native client routing restored.", "release-E",
    ]);
  });

  test("indeterminate admission leaves routing and manager untouched", async () => {
    const calls: string[] = [];
    await runServiceLifecycleCommand(["stop"], commandDeps(calls, [
      diagnostic("indeterminate", "indeterminate"),
    ]));
    expect(calls).toEqual([
      "environment", "acquire-ES", "diagnose",
      "error:❌ Service stop refused because manager state is indeterminate.",
      "fail", "release-S", "release-E",
    ]);
  });

  test("uninstall releases S for proof and reacquires it for the deletion gate", async () => {
    const calls: string[] = [];
    await runServiceLifecycleCommand(["uninstall"], commandDeps(calls, [
      diagnostic("present", "active"),
      diagnostic("present", "inactive"),
      diagnostic("present", "inactive"),
    ]));
    expect(calls).toEqual([
      "environment", "acquire-ES", "diagnose", "route-native", "manager-stop", "cleanup",
      "release-S", "diagnose", "probe-once", "reacquire-S", "deletion-probe", "diagnose",
      "uninstall", "remove-state", "remove-token", "log:✅ service uninstalled.",
      "release-S", "release-E",
    ]);
  });

  test("Windows service install ends the running task before rewriting its assets, with write retry", async () => {
    const service = await readText("src/service.ts");
    const assetsHelper = service.slice(
      service.indexOf("function writeWindowsSchedulerAssets()"),
      service.indexOf("function installWindows()"),
    );
    const installWindows = service.slice(service.indexOf("function installWindows()"), service.indexOf("async function installWindowsNative()"));

    const stopAt = installWindows.indexOf("stopWindows();");
    const assetsAt = installWindows.indexOf("writeWindowsSchedulerAssets();");
    const createAt = installWindows.indexOf("buildWindowsSchtasksCreateArgs");
    expect(stopAt).toBeGreaterThan(-1);
    expect(assetsAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(assetsAt);
    expect(assetsAt).toBeLessThan(createAt);
    expect(installWindows).not.toContain("writeFileSync(script");
    expect(assetsHelper).toContain("writeServiceAssetWithRetry(script");
    expect(assetsHelper).toContain("writeServiceAssetWithRetry(windowsTaskXmlPath()");
    // Retry helper tolerates transient Windows file locks from the just-ended task.
    expect(service).toContain('code !== "EBUSY" && code !== "EPERM" && code !== "EACCES"');
  });

  test("Windows service uninstall verifies task deletion before removing assets", async () => {
    const service = await readText("src/service.ts");
    const uninstallWindows = service.slice(service.indexOf("function uninstallWindows()"), service.indexOf("function serviceDiagnosticsSummary()"));

    expect(uninstallWindows).toContain("for (const taskName of windowsTaskNames())");
    expect(uninstallWindows).toContain("assertOwnedWindowsSchedulerTask(taskName)");
    expect(uninstallWindows).toContain('"codexcommander-service.cmd"');
    expect(uninstallWindows).toContain('"codexcommander-service-task.xml"');
    expect(uninstallWindows).toContain("removeOwnedPrivateServiceFile(path[0], path[1], path[2])");
    expect(uninstallWindows).toContain("refusing to remove service assets");
  });

  test("Windows service start never runs an absent, foreign, or unverifiable task", async () => {
    const { startOwnedWindowsSchedulerTask } = await import("../src/service");
    const runs: string[] = [];

    expect(() => startOwnedWindowsSchedulerTask({
      assertOwned: () => false,
      run: (taskName) => { runs.push(taskName); },
    })).toThrow(/not installed.*unowned/i);
    expect(runs).toEqual([]);

    expect(() => startOwnedWindowsSchedulerTask({
      assertOwned: () => { throw new Error("foreign or unverifiable registration"); },
      run: (taskName) => { runs.push(taskName); },
    })).toThrow("foreign or unverifiable registration");
    expect(runs).toEqual([]);

    startOwnedWindowsSchedulerTask({
      assertOwned: () => true,
      run: (taskName) => { runs.push(taskName); },
    });
    expect(runs).toEqual(["codexcommander-proxy"]);
  });

  test("full uninstall preserves a foreign or unverifiable systemd unit and its install state", async () => {
    const { uninstallOwnedSystemdIfPresent } = await import("../src/service");
    let stateRemoved = false;

    expect(() => uninstallOwnedSystemdIfPresent({
      exists: () => true,
      uninstall: () => { throw new Error("foreign systemd unit"); },
      removeState: () => { stateRemoved = true; },
    })).toThrow("foreign systemd unit");
    expect(stateRemoved).toBe(false);

    expect(uninstallOwnedSystemdIfPresent({
      exists: () => false,
      uninstall: () => { throw new Error("must not run"); },
      removeState: () => { stateRemoved = true; },
    })).toBe(false);
    expect(stateRemoved).toBe(false);
  });

  test("only the Windows Scheduler backend receives the bounded respawn proof", async () => {
    for (const [platform, backend, expected] of [
      ["win32", "scheduler", "probe-bounded"],
      ["win32", "native", "probe-once"],
      ["linux", "scheduler", "probe-once"],
    ] as const) {
      const calls: string[] = [];
      const backendDiagnostic = (state: ServiceDiagnostic["supervisorState"]): ServiceDiagnostic => ({
        ...diagnostic("present", state),
        backend,
      });
      await runServiceLifecycleCommand(["stop"], {
        ...commandDeps(calls, [backendDiagnostic("active"), backendDiagnostic("inactive")]),
        platform,
        readBackend: () => backend,
      });
      expect(calls).toContain(expected);
    }
  });

  test("tracked proxy cleanup verifies health-reported pids before stopProxy", async () => {
    const service = await readText("src/service.ts");
    expect(service).toContain("function verifiedKillTarget(pid: number | null | undefined): number | null");
    expect(service).toContain("const liveKillPid = verifiedKillTarget(live?.pid);");
    expect(service).toContain("const trackedKillPid = verifiedKillTarget(pid);");
  });
  test("service stop refuses success while the proxy is still live", async () => {
    const calls: string[] = [];
    await runServiceLifecycleCommand(["stop"], {
      ...commandDeps(calls, [diagnostic("present", "active"), diagnostic("present", "inactive")]),
      probeStopped: async () => ({ port: 10100 }),
    });
    expect(calls.some(call => call.includes("proxy is still listening on port 10100"))).toBe(true);
    expect(calls).toContain("fail");
    expect(calls.some(call => call.startsWith("log:✅"))).toBe(false);
  });

  test("native install refuses Microsoft-account logins before removing the scheduler backend", async () => {
    const service = await readText("src/service.ts");
    const installNative = service.slice(service.indexOf("async function installWindowsNative()"), service.indexOf("function startWindows()"));
    expect(installNative.indexOf("assertWindowsNativeServiceAccountSupported()")).toBeLessThan(installNative.indexOf("uninstallWindows()"));
    expect(service).toContain("Microsoft-account Windows login");
  });

  test("tracked cleanup failure blocks proof and success", async () => {
    const calls: string[] = [];
    await runServiceLifecycleCommand(["stop"], {
      ...commandDeps(calls, [diagnostic("present", "active")]),
      cleanupTrackedProxy: async () => { calls.push("cleanup"); throw new Error("kill failed"); },
    });
    expect(calls.some(call => call.includes("Failed to stop proxy: kill failed"))).toBe(true);
    expect(calls.some(call => call.startsWith("probe-"))).toBe(false);
    expect(calls.some(call => call.startsWith("log:✅"))).toBe(false);
  });

  test("stop and uninstall do not consult start/install platform operations", async () => {
    for (const command of ["stop", "uninstall"] as const) {
      const calls: string[] = [];
      await runServiceLifecycleCommand([command], {
        ...commandDeps(calls, [
          diagnostic("absent", "inactive"),
          diagnostic("absent", "inactive"),
        ]),
        operations: () => { throw new Error("start-only platform probe must not run"); },
      });
      expect(calls).not.toContain("fail");
      expect(calls.some(call => call.startsWith("log:✅"))).toBe(true);
    }
  });
});

describe("service diagnostics", () => {
  // deriveWindowsServiceDiagnostic now reads the registration XML itself, so these
  // helpers express the old boolean fixtures as the documents that produce them.
  // buildWindowsTaskXml() emits exactly the Command/Arguments the validator expects
  // when both use the same defaults, so the fixture leaves the launcher default alone.
  const healthyTaskXml = () => buildWindowsTaskXml();
  /** Registered but reporting an explicitly disabled task. */
  const disabledTaskXml = () => healthyTaskXml()
    .replace("<Enabled>true</Enabled>\n    <Hidden>", "<Enabled>false</Enabled>\n    <Hidden>");

  const base = {
    schedulerXml: "",
    schedulerAssetsPresent: true,
    nativeStatus: "nonexistent" as const,
    recordedBackend: null,
    staleBakedPaths: false,
    nativeRepairAssetsOnly: false,
    diagnostics: "logs: test",
  };
  const installedEnabled = { schedulerXml: healthyTaskXml() };
  const installedDisabled = { schedulerXml: disabledTaskXml() };

  test("fails closed for disabled, stale, conflicting, stopped, and ghost Windows services", () => {
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedEnabled, recordedBackend: "scheduler" })).toMatchObject({ viable: true, backend: "scheduler" });
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedDisabled })).toMatchObject({ viable: false, enabled: false });
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedEnabled, staleBakedPaths: true })).toMatchObject({ viable: false, stale: true });
    expect(deriveWindowsServiceDiagnostic({ ...base, ...installedEnabled, nativeStatus: "started" })).toMatchObject({ viable: false, conflict: true });
    expect(deriveWindowsServiceDiagnostic({ ...base, nativeStatus: "stopped" })).toMatchObject({ installed: true, viable: false, startable: false, stale: true, running: false });
    expect(deriveWindowsServiceDiagnostic({ ...base, nativeRepairAssetsOnly: true })).toMatchObject({ installed: false, viable: false, stale: true });
    // Missing on-disk assets while the task remains registered — the post-update status line.
    const missingAssets = deriveWindowsServiceDiagnostic({
      ...base,
      ...installedEnabled,
      recordedBackend: "scheduler",
      schedulerAssetsPresent: false,
    });
    expect(missingAssets).toMatchObject({ installed: true, viable: false, stale: true, startable: false });
    expect(missingAssets.summary).toContain("stale or missing service assets");
  });

  test("a stopped healthy WinSW service remains startable from the tray", () => {
    const stoppedNative = deriveWindowsServiceDiagnostic({ ...base, nativeStatus: "stopped", recordedBackend: "native" });
    expect(serviceStartableFromTray(stoppedNative)).toBe(true);
    expect(serviceStartableFromTray({ ...stoppedNative, stale: true })).toBe(false);
    expect(serviceStartableFromTray({ ...stoppedNative, conflict: true })).toBe(false);
    expect(serviceStartableFromTray(deriveWindowsServiceDiagnostic({ ...base, nativeStatus: "unknown" }))).toBe(false);
    const disabledScheduler = deriveWindowsServiceDiagnostic({ ...base, ...installedDisabled });
    expect(serviceStartableFromTray(disabledScheduler)).toBe(false);
    const mismatchedScheduler = deriveWindowsServiceDiagnostic({
      ...base,
      ...installedEnabled,
      recordedBackend: "native",
    });
    expect(mismatchedScheduler).toMatchObject({ backend: "scheduler", stale: true, viable: false, startable: false });
  });

  test("manager probe failures remain indeterminate instead of becoming absence", () => {
    expect(probeLaunchdSupervisor({
      registered: false,
      run: () => ({ ok: false, stdout: "", stderr: "domain unavailable", status: 112 }),
    })).toMatchObject({
      registrationState: "indeterminate",
      supervisorState: "indeterminate",
      enabled: null,
    });
    expect(probeLaunchdSupervisor({
      registered: false,
      run: () => ({ ok: false, stdout: "", stderr: "not found", status: 113 }),
    })).toMatchObject({
      registrationState: "absent",
      supervisorState: "inactive",
    });
    expect(probeSystemdSupervisor({
      registered: false,
      show: () => { throw new Error("no user bus"); },
    })).toMatchObject({
      registrationState: "indeterminate",
      supervisorState: "indeterminate",
      enabled: null,
    });
    expect(probeSystemdSupervisor({
      registered: false,
      show: () => "LoadState=not-found\nActiveState=inactive\nUnitFileState=disabled",
    })).toMatchObject({
      registrationState: "absent",
      supervisorState: "inactive",
      enabled: false,
    });
  });

  test("unknown WinSW presence is not reported as absent or a proven conflict", () => {
    const unknown = deriveWindowsServiceDiagnostic({
      ...base,
      nativeStatus: "unknown",
      recordedBackend: "native",
    });
    expect(unknown).toMatchObject({
      registrationState: "indeterminate",
      supervisorState: "indeterminate",
      installed: true,
      conflict: false,
      viable: false,
      startable: false,
    });
    const schedulerWithUnknownNative = deriveWindowsServiceDiagnostic({
      ...base,
      ...installedEnabled,
      recordedBackend: "scheduler",
      nativeStatus: "unknown",
    });
    expect(schedulerWithUnknownNative).toMatchObject({
      registrationState: "present",
      supervisorState: "indeterminate",
      installed: true,
      conflict: false,
      viable: false,
    });
  });

  test("rejects malformed service backend state instead of defaulting it to scheduler", () => {
    const valid = {
      version: 3,
      codexHome: "C:\\codex",
      codexCommanderHome: "C:\\codexcommander",
      bunPath: "C:\\bun\\bun.exe",
      cliPath: "C:\\codexcommander\\src\\cli\\index.ts",
      backend: "scheduler",
    };
    expect(parseServiceInstallState(valid)?.backend).toBe("scheduler");
    expect(parseServiceInstallState({ ...valid, backend: "garbage" })).toBeNull();
    expect(parseServiceInstallState({ ...valid, backend: undefined })).toBeNull();
    expect(parseServiceInstallState({ ...valid, version: 2, backend: "scheduler" })).toBeNull();
    expect(parseServiceInstallState({ ...valid, version: 1, backend: undefined })).toBeNull();
  });

  test("status summary exposes the service log path", () => {
    const summary = serviceStatusSummary();

    expectTextToContainPath(summary, serviceLogPath());
  });

  test("flags stale baked service paths recorded at install time", () => {
    const oldCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
    const stateDir = join(TEST_DIR, "baked-paths-home");
    try {
      process.env.CODEXCOMMANDER_HOME = stateDir;
      mkdirSync(stateDir, { recursive: true });
      const statePath = join(stateDir, "service-state.json");

      const missing = join(stateDir, "gone", "bun");
      writeFileSync(statePath, JSON.stringify({
        version: 3,
        codexHome: stateDir,
        codexCommanderHome: stateDir,
        bunPath: missing,
        cliPath: join(import.meta.dir, "service.test.ts"),
        backend: "scheduler",
      }), "utf8");
      chmodSync(statePath, 0o600);
      const diagnostic = bakedServicePathsDiagnostic();
      expect(diagnostic).toContain("STALE baked paths");
      expect(diagnostic).toContain(missing);

      writeFileSync(statePath, JSON.stringify({
        version: 3,
        codexHome: stateDir,
        codexCommanderHome: stateDir,
        bunPath: join(import.meta.dir, "service.test.ts"),
        cliPath: join(import.meta.dir, "service.test.ts"),
        backend: "scheduler",
      }), "utf8");
      chmodSync(statePath, 0o600);
      expect(bakedServicePathsDiagnostic()).toBeNull();

      // Malformed current state files without baked paths stay silent.
      writeFileSync(statePath, JSON.stringify({ version: 3, codexHome: stateDir, codexCommanderHome: stateDir, backend: "scheduler" }), "utf8");
      expect(bakedServicePathsDiagnostic()).toBeNull();
    } finally {
      if (oldCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = oldCodexCommanderHome;
    }
  });

  test("direct service status prints the diagnostics line", async () => {
    const calls: string[] = [];
    await runServiceLifecycleCommand(["status"], {
      platform: "linux",
      readBackend: () => "scheduler",
      operations: () => ({ install: () => {}, start: () => {}, stop: () => {}, uninstall: () => {} }),
      statusReport: async () => "status",
      diagnosticsSummary: () => "diagnostics",
      log: message => { calls.push(`log:${message}`); },
    });
    expect(calls).toContain("log:status");
    expect(calls).toContain("log:Diagnostics: diagnostics");
  });
});

describe("service repair", () => {
  const baseDiag = {
    supported: true,
    registrationState: "present" as const,
    supervisorState: "active" as const,
    installed: true,
    enabled: true,
    running: true,
    viable: false,
    startable: true,
    stale: true,
    conflict: false,
    backend: "scheduler" as const,
    summary: "stale",
  };

  test("scheduler repair rewrites assets and restarts without schtasks create", async () => {
    const calls: string[] = [];
    await repairService({
      platform: "win32",
      diagnose: () => baseDiag,
      assertEnv: () => { calls.push("env"); },
      assertAuth: () => { calls.push("auth"); },
      stopScheduler: () => { calls.push("stop"); },
      writeSchedulerAssets: () => { calls.push("assets"); },
      startScheduler: () => { calls.push("start"); },
      writeSchedulerState: () => { calls.push("state"); },
      repairNative: async () => { calls.push("native"); },
      repairSystemd: () => { calls.push("systemd"); },
    });
    expect(calls).toEqual(["env", "auth", "stop", "assets", "start", "state"]);
  });

  test("repair rejects when nothing is installed", async () => {
    await expect(repairService({
      platform: "win32",
      diagnose: () => ({ ...baseDiag, registrationState: "absent", supervisorState: "inactive", installed: false, backend: null, summary: "not installed" }),
      writeSchedulerAssets: () => { throw new Error("should not write"); },
      repairSystemd: () => { throw new Error("should not install systemd"); },
    })).rejects.toThrow(/not installed/i);
  });

  test("repair rejects conflict without touching assets", async () => {
    let wrote = false;
    await expect(repairService({
      platform: "win32",
      diagnose: () => ({ ...baseDiag, conflict: true, summary: "CONFLICT" }),
      writeSchedulerAssets: () => { wrote = true; },
      repairSystemd: () => { throw new Error("should not install systemd"); },
    })).rejects.toThrow(/both present/i);
    expect(wrote).toBe(false);
  });

  test("native repair uses the WinSW repair path and refreshes install state", async () => {
    const calls: string[] = [];
    await repairService({
      platform: "win32",
      diagnose: () => ({ ...baseDiag, backend: "native" }),
      assertEnv: () => {},
      assertAuth: () => {},
      repairNative: async () => { calls.push("native"); },
      writeNativeState: () => { calls.push("native-state"); },
      writeSchedulerAssets: () => { calls.push("scheduler"); },
      repairSystemd: () => { calls.push("systemd"); },
    });
    expect(calls).toEqual(["native", "native-state"]);
  });
});

/**
 * `launchctl load` reports failure on stderr and exits 0 for an already-bootstrapped
 * job, so `sh()` (execSync — throws only on a non-zero exit) treated a load that did
 * nothing as success. launchd then kept running the PREVIOUS plist while a freshly
 * written one sat unused, which is the 2026-08-02 report: `ccx service` prints a
 * checkmark, `launchctl list` shows the job, and the port answers nothing.
 *
 * Measured on macOS 27.0:
 *   $ launchctl load -w ~/Library/LaunchAgents/com.codexcommander.proxy.plist
 *   Load failed: 5: Input/output error
 *   $ echo $?
 *   0
 */
describe("launchctl load verification", () => {
  describe("launchctlLoadFailed", () => {
    test("detects the legacy load failure that exits 0", () => {
      expect(launchctlLoadFailed(
        "Load failed: 5: Input/output error\nTry running `launchctl bootstrap` as root for richer errors.",
      )).toBe(true);
    });

    test("detects a bootstrap failure", () => {
      expect(launchctlLoadFailed("Bootstrap failed: 37: Operation already in progress")).toBe(true);
    });

    test("stays false for clean output", () => {
      expect(launchctlLoadFailed("")).toBe(false);
    });
  });

  describe("runLaunchctl", () => {
    test("reports ok with trimmed stdout on a clean run", () => {
      const out = runLaunchctl(["print", "gui/501/x"], {
        run: (() => ({ status: 0, stdout: "  ok  ", stderr: "" })) as never,
      });
      // `status` is carried through now: a boolean cannot tell "no such service"
      // (113) from "no such domain" (112), and only the first is an answer.
      expect(out).toEqual({ ok: true, stdout: "ok", stderr: "", status: 0 });
    });

    /**
     * The regression guard. `execFileSync` discards stderr when the child exits 0,
     * so a runner built on it returns stderr:"" here and the whole fix silently
     * no-ops on a real machine while its unit tests stay green.
     */
    test("surfaces stderr even when the child exits 0", () => {
      const out = runLaunchctl(["load", "-w", "/x.plist"], {
        run: (() => ({
          status: 0,
          stdout: "",
          stderr: "Load failed: 5: Input/output error\nTry running `launchctl bootstrap` as root...",
        })) as never,
      });
      expect(out.ok).toBe(true);
      expect(launchctlLoadFailed(out.stderr)).toBe(true);
    });

    test("reports not-ok on a real non-zero exit (bootstrap)", () => {
      const out = runLaunchctl(["bootstrap", "gui/501", "/x.plist"], {
        run: (() => ({ status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" })) as never,
      });
      expect(out.ok).toBe(false);
      expect(launchctlLoadFailed(out.stderr)).toBe(true);
    });

    test("treats a spawn failure as not-ok rather than success", () => {
      const out = runLaunchctl(["load", "-w", "/x.plist"], {
        run: (() => ({ error: new Error("spawn /bin/launchctl ENOENT"), status: null, stdout: null, stderr: null })) as never,
      });
      expect(out.ok).toBe(false);
      expect(out.stderr).toContain("ENOENT");
    });
  });

  describe("launchdJobMatchesPlist", () => {
    // Shape captured from a real `launchctl print gui/$(id -u)/com.codexcommander.proxy`
    // run on macOS 27.0: the arguments block is tab-indented one level, entries two.
    const args = ["/h/.codexcommander/CodexCommander", "/pkg/src/cli/index.ts", "start", "--port", "10100"];
    const printed = (values: readonly string[]) => [
      "\targuments = {",
      ...values.map(value => `\t\t${value}`),
      "\t}",
    ].join("\n");

    test("reports matching when print shows the current arguments", () => {
      expect(launchdJobMatchesPlist(args, {
        run: () => ({ ok: true, stdout: printed(args), stderr: "" }),
      })).toEqual({ loaded: true, matchesPlist: true });
    });

    test("reports loaded-but-stale when print shows different arguments", () => {
      const old = ["/h/.codexcommander/CodexCommander", "/old/pkg/src/cli/index.ts", "start", "--port", "10100"];
      expect(launchdJobMatchesPlist(args, {
        run: () => ({ ok: true, stdout: printed(old), stderr: "" }),
      })).toEqual({ loaded: true, matchesPlist: false });
    });

    test("reports not loaded when print fails", () => {
      expect(launchdJobMatchesPlist(args, {
        run: () => ({ ok: false, stdout: "", stderr: "Could not find service" }),
      })).toEqual({ loaded: false, matchesPlist: false });
    });
  });

  describe("startLaunchd", () => {
    // A runLaunchctl RESULT, not a spawnSync result.
    const failedLoad = () => ({ ok: true, stdout: "", stderr: "Load failed: 5: Input/output error" });
    const cleanLoad = () => ({ ok: true, stdout: "", stderr: "" });
    const installedPort = () => 10100;

    test("does not silently re-bake a stale Bun runtime during start", () => {
      process.env.CODEXCOMMANDER_HOME = TEST_DIR;
      mkdirSync(TEST_DIR, { recursive: true });
      const installedBun = join(TEST_DIR, "installed-bun");
      const launcher = ensureLaunchdExecutable(installedBun);
      const before = readFileSync(launcher, "utf8");

      startLaunchd({ launchctl: cleanLoad, assertOwned: () => {} });

      expect(readFileSync(launcher, "utf8")).toBe(before);
      expect(readFileSync(launcher, "utf8")).toContain(installedBun);
    });

    test("returns without consulting launchd when the load is clean", () => {
      expect(() => startLaunchd({
        launchctl: cleanLoad,
        assertOwned: () => {},
        matches: () => { throw new Error("must not be consulted on a clean load"); },
      })).not.toThrow();
    });

    /**
     * launchctl emits `Load failed` for EVERY already-bootstrapped job, including a
     * correct one, so `ccx service start` on a healthy service hits it every time.
     * An unconditional throw would break the most common benign invocation.
     */
    test("treats an already-loaded matching job as a no-op", () => {
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(() => startLaunchd({
          launchctl: failedLoad,
          assertOwned: () => {},
          matches: () => ({ loaded: true, matchesPlist: true }),
          installedPort,
        })).not.toThrow();
      } finally {
        log.mockRestore();
      }
    });

    // not.toThrow() alone would still pass if the guard regressed; assert the branch.
    test("says so when the job was already loaded from the current plist", () => {
      const lines: string[] = [];
      const log = spyOn(console, "log").mockImplementation(m => { lines.push(String(m)); });
      try {
        startLaunchd({ launchctl: failedLoad, assertOwned: () => {}, matches: () => ({ loaded: true, matchesPlist: true }), installedPort });
      } finally {
        log.mockRestore();
      }
      expect(lines.join("\n")).toContain("already loaded");
    });

    test("throws with the bootout hint when the loaded job is stale", () => {
      expect(() => startLaunchd({
        launchctl: failedLoad,
        assertOwned: () => {},
        matches: () => ({ loaded: true, matchesPlist: false }),
        installedPort,
      })).toThrow(/bootout/);
    });

    test("throws with the repair hint when no job is loaded", () => {
      // The plist exists (this is an installed service) — reloading it is `repair`,
      // not a re-registration.
      expect(() => startLaunchd({
        launchctl: failedLoad,
        assertOwned: () => {},
        matches: () => ({ loaded: false, matchesPlist: false }),
      })).toThrow(/service repair/);
    });

    test("refuses a foreign or unverifiable plist before invoking launchctl", () => {
      let launched = false;
      expect(() => startLaunchd({
        assertOwned: () => { throw new Error("foreign launchd definition"); },
        launchctl: () => { launched = true; return { ok: true, stdout: "", stderr: "" }; },
      })).toThrow("foreign launchd definition");
      expect(launched).toBe(false);
    });
  });
});

/**
 * Registration is not service. `launchctl load` succeeding (or `systemctl enable`,
 * or `schtasks /run`) proves the manager accepted the job, not that the proxy bound
 * a port — so `install`/`start` printed a green checkmark for a service that never
 * served. These helpers answer the second question.
 */
describe("auth preflight retry command (260804 #970 follow-up)", () => {
  // Calls the PRODUCTION selector, not a copy of its logic. An earlier version of this
  // test re-implemented the predicate as a local lambda and would have stayed green with
  // the fix reverted — a guard that cannot fail is worse than no guard.
  test("serviceRetryCommand picks the command that can actually succeed", () => {
    // Registered and healthy enough to refresh in place: repair, no elevation needed.
    expect(serviceRetryCommand({ installed: true, conflict: false })).toBe("ccx service repair");
    // Nothing registered: repairService() would refuse, so install is the only option.
    expect(serviceRetryCommand({ installed: false, conflict: false })).toBe("ccx service install");
    // Task Scheduler AND WinSW both present: repairService() refuses this outright
    // (see the conflict guard in repairService), and installWindows removes the native
    // backend first, so install is the valid recovery.
    expect(serviceRetryCommand({ installed: true, conflict: true })).toBe("ccx service install");
  });
});

describe("service serving confirmation", () => {
  describe("launchdListenPort", () => {
    test("reads the port baked into the plist, not the current config", () => {
      expect(launchdListenPort({
        readPlist: () => "<string>--port</string>\n<string>18222</string>",
      })).toBe(18222);
    });

    test("ignores a path that contains a decoy port", () => {
      expect(launchdListenPort({
        readPlist: () => [
          "<string>/opt/start --port 9999/bun</string>",
          "<string>--port</string>",
          "<string>18222</string>",
        ].join("\n"),
      })).toBe(18222);
    });

    test("does not parse obsolete shell-command launchd definitions", () => {
      expect(launchdListenPort({
        readPlist: () => "<string>exec '/b' '/c' start --port 18222</string>",
      })).toBeNull();
    });

    test("returns null when there is no port to read", () => {
      expect(launchdListenPort({ readPlist: () => "<string>no port here</string>" })).toBeNull();
    });

    test("rejects out-of-range ports rather than probing them", () => {
      expect(launchdListenPort({ readPlist: () => "<string>--port</string><string>0</string>" })).toBeNull();
      expect(launchdListenPort({ readPlist: () => "<string>--port</string><string>70000</string>" })).toBeNull();
    });

    // Linux/Windows hit this on every call: plistPath() has nothing to read.
    test("returns null when the plist cannot be read", () => {
      expect(launchdListenPort({ readPlist: () => { throw new Error("ENOENT"); } })).toBeNull();
    });
  });

  describe("systemdListenPort", () => {
    test("reads the port out of the unit's ExecStart line", () => {
      expect(systemdListenPort({
        readUnit: () => 'ExecStart="/bin/sh" -lc "exec \'/b\' \'/c\' start --port 18222"\n',
      })).toBe(18222);
    });

    test("returns null when the unit cannot be read", () => {
      expect(systemdListenPort({ readUnit: () => { throw new Error("ENOENT"); } })).toBeNull();
    });

    test("rejects out-of-range ports", () => {
      expect(systemdListenPort({ readUnit: () => "ExecStart=... start --port 0\n" })).toBeNull();
    });
  });

  describe("confirmServiceServing", () => {
    test("returns the baked port once the proxy answers", async () => {
      let calls = 0;
      const out = await confirmServiceServing({
        port: 10100,
        hostname: "127.0.0.1",
        probe: async () => ++calls >= 2,
        sleep: async () => {},
        now: () => 0,
        timeoutMs: 5_000,
      });
      expect(out).toEqual({ ok: true, port: 10100 });
    });

    test("gives up at the deadline instead of hanging", async () => {
      let now = 0;
      const out = await confirmServiceServing({
        port: 10100,
        probe: async () => false,
        sleep: async ms => { now += ms; },
        now: () => now,
        timeoutMs: 2_000,
      });
      expect(out).toEqual({ ok: false, port: 10100 });
    });

    test("probes at least once even with a zero budget", async () => {
      let probes = 0;
      await confirmServiceServing({
        port: 10100,
        probe: async () => { probes += 1; return false; },
        sleep: async () => {},
        now: () => 0,
        timeoutMs: 0,
      });
      expect(probes).toBe(1);
    });

    // A service reinstall invalidates the pidfile, so resolving the target through
    // it (findLiveProxy) would report a serving service as dead. Ask the baked port.
    test("probes the port it was given rather than resolving one", async () => {
      const seen: number[] = [];
      await confirmServiceServing({
        port: 18999,
        probe: async p => { seen.push(p); return true; },
        sleep: async () => {},
        now: () => 0,
      });
      expect(seen).toEqual([18999]);
    });
  });

  /**
   * `ccx service status` printed raw `launchctl list` output, which reports a
   * registered job identically whether it is serving, bound to nothing, or running
   * an older plist. The reporter hit exactly that: a checkmark next to a dead port.
   */
  describe("serviceStatusReport", () => {
    const installedDiag = (): ServiceDiagnostic => ({
      supported: true,
      installed: true,
      enabled: true,
      running: true,
      viable: true,
      startable: true,
      stale: false,
      conflict: false,
      backend: "launchd",
      summary: "installed and loaded (launchd)",
    });

    test("reports the serving port when a proxy answers", async () => {
      const out = await serviceStatusReport({
        diagnose: installedDiag,
        serving: async () => ({ ok: true, port: 10100 }),
      });
      expect(out).toContain("Serving on port 10100");
    });

    test("names the log path and the repair command when nothing answers", async () => {
      const out = await serviceStatusReport({
        diagnose: installedDiag,
        serving: async () => ({ ok: false, port: 10100 }),
        matchesPlist: () => ({ loaded: true, matchesPlist: true }),
      });
      expect(out).toContain("no proxy is answering on port 10100");
      // Registered but not serving: repair refreshes it without demanding elevation.
      expect(out).toContain("ccx service repair");
      expect(out).toContain("ccx start");
    });

    // The injected seam must win on every platform: the default is darwin-gated,
    // the dep is not, so this case has to run on Linux and Windows CI too.
    test("adds the bootout hint when launchd runs an older plist", async () => {
      const out = await serviceStatusReport({
        diagnose: installedDiag,
        serving: async () => ({ ok: false, port: 10100 }),
        matchesPlist: () => ({ loaded: true, matchesPlist: false }),
      });
      expect(out).toContain("OLDER plist");
      expect(out).toContain("bootout");
    });

    test("reports not-installed without probing", async () => {
      let probed = false;
      const out = await serviceStatusReport({
        diagnose: () => ({ ...installedDiag(), installed: false, summary: "not installed" }),
        serving: async () => { probed = true; return { ok: false, port: 0 }; },
      });
      expect(out).toContain("not installed");
      expect(probed).toBe(false);
    });
  });

  /**
   * systemd's analogue of the macOS stale-plist case: writing the unit file does not
   * change the definition systemd has loaded until `daemon-reload`, so `ccx service
   * start` would run the PREVIOUS ExecStart.
   */
  describe("systemdNeedsDaemonReload", () => {
    test("detects a unit changed on disk", () => {
      expect(systemdNeedsDaemonReload({ show: () => "NeedDaemonReload=yes" })).toBe(true);
    });

    test("is false when systemd is already in sync", () => {
      expect(systemdNeedsDaemonReload({ show: () => "NeedDaemonReload=no" })).toBe(false);
    });

    // No user bus, or not installed: never block a start we cannot judge.
    test("is false when the query fails", () => {
      expect(systemdNeedsDaemonReload({ show: () => { throw new Error("no bus"); } })).toBe(false);
    });
  });

  test("systemdListenPort reads the port out of a real generated unit", () => {
    expect(systemdListenPort({ readUnit: () => buildUnit() })).toBe(resolveServiceListenPort());
  });

  test("service start reloads and restarts an owned changed systemd unit", () => {
    const calls: string[] = [];
    startOwnedSystemdUnit({
      ensureBus: () => { calls.push("bus"); },
      exists: () => true,
      assertOwned: () => { calls.push("owned"); },
      needsReload: () => true,
      run: command => { calls.push(command); },
    });
    expect(calls).toEqual([
      "bus",
      "owned",
      "systemctl --user daemon-reload",
      "systemctl --user restart codexcommander-proxy",
    ]);
  });

  /**
   * Windows bakes the port into two different artifacts depending on backend: the
   * scheduler wrapper (`codexcommander-service.cmd`) and the WinSW XML. Both must be
   * readable or `start` probes a port the service was never told to use.
   */
  describe("windowsListenPort", () => {
    test("reads the port baked into the scheduler wrapper", () => {
      expect(windowsListenPort({
        readScript: () => '"%CCX_BUN%" "%CCX_CLI%" start --port 18222 >>"%LOG%" 2>&1',
      })).toBe(18222);
    });

    // Every `set "…"` line precedes the exec line, so a decoy in a path must lose.
    test("prefers the argument tail over a path that looks like one", () => {
      expect(windowsListenPort({
        readScript: () => 'set "CCX_BUN=C:\\start --port 9999\\bun.exe"\r\n"%CCX_BUN%" "%CCX_CLI%" start --port 18222\r\n',
      })).toBe(18222);
    });

    test("returns null when the wrapper cannot be read", () => {
      expect(windowsListenPort({ readScript: () => { throw new Error("ENOENT"); } })).toBeNull();
    });

    test("rejects out-of-range ports", () => {
      expect(windowsListenPort({ readScript: () => "start --port 0 " })).toBeNull();
      expect(windowsListenPort({ readScript: () => "start --port 70000 " })).toBeNull();
    });

    // The generated wrapper is the real contract; assert against it, not a sketch.
    test("reads the port out of a real generated wrapper", () => {
      expect(windowsListenPort({ readScript: () => buildWindowsServiceScript() }))
        .toBe(resolveServiceListenPort());
    });
  });

  describe("winswListenPort", () => {
    test("reads the port out of the WinSW <arguments> element", () => {
      expect(winswListenPort({
        readXml: () => "  <arguments>&quot;C:\\pkg\\cli.ts&quot; start --port 18222</arguments>",
      })).toBe(18222);
    });

    // Scheduler install, or any non-Windows host: the XML is simply absent.
    test("returns null when the XML cannot be read", () => {
      expect(winswListenPort({ readXml: () => { throw new Error("ENOENT"); } })).toBeNull();
    });

    test("reads the port out of a real generated WinSW XML", () => {
      const xml = buildWinswXml({ bun: "C:\\pkg\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\pkg\\src\\cli\\index.ts" });
      expect(winswListenPort({ readXml: () => xml })).toBe(resolveServiceListenPort());
    });
  });
});

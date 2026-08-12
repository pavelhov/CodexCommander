import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const binPath = join(repoRoot, "bin", "ccx.mjs");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("CLI subcommand help", () => {
  test("version commands print a single script-friendly line", () => {
    for (const args of [["--version"], ["-v"], ["version"]]) {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toMatch(/^CodexCommander \d+\.\d+\.\d+/);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }
  }, { timeout: 20_000 });

  test("help command routes to subcommand help", () => {
    const result = runCli(["help", "start"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: ccx start [--port <port>]");
    expect(result.stdout).toContain("Start the proxy server and sync models to Codex.");
  });

  test("init help describes proof-bound routing instead of direct config injection", () => {
    for (const command of ["init", "setup"]) {
      const result = runCli(["help", command]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("optionally route through a proven live proxy");
      expect(result.stdout).not.toContain("Codex config injection");
    }
  });

  test("top-level help forms exit before Codex shim auto-restore can mutate launchers", () => {
    const codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-help-shim-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "ccx-help-shim-bin-"));
    try {
      const wrapper = join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
      const backup = join(binDir, process.platform === "win32" ? "codex.codexcommander-real.cmd" : "codex.codexcommander-real");
      const statePath = join(codexCommanderHome, "codex-shim.json");
      const replacement = "replacement that help must not promote\n";
      writeFileSync(wrapper, replacement, "utf8");
      writeFileSync(backup, "known-good prior launcher\n", "utf8");
      if (process.platform !== "win32") chmodSync(wrapper, 0o755);
      writeFileSync(statePath, `${JSON.stringify({
        version: 1,
        platform: process.platform,
        wrappers: [{
          wrapperPath: wrapper,
          originalPath: wrapper,
          backupPath: backup,
        }],
      }, null, 2)}\n`, "utf8");
      const stateBefore = readFileSync(statePath);
      const backupBefore = readFileSync(backup);
      Bun.sleepSync(120);

      for (const args of [[], ["help"], ["--help"], ["-h"]]) {
        const result = runCli(args, { CODEXCOMMANDER_HOME: codexCommanderHome, PATH: binDir });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("CodexCommander (ccx)");
        expect(readFileSync(wrapper, "utf8")).toBe(replacement);
        expect(readFileSync(backup)).toEqual(backupBefore);
        expect(readFileSync(statePath)).toEqual(stateBefore);
      }
    } finally {
      rmSync(codexCommanderHome, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("tray help documents the install-only no-start flag", () => {
    const result = runCli(["help", "tray"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--no-start");
  });

  test("unknown command with help flag remains an error", () => {
    const result = runCli(["foobar", "--help"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: foobar");
    expect(result.stdout).toContain("CodexCommander (ccx)");
  });

  test("status prints diagnostics without starting the proxy", () => {
    const codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-status-"));
    try {
      const configPath = join(codexCommanderHome, "config.json");
      const codexRuntime = join(codexCommanderHome, process.platform === "win32" ? "codex.cmd" : "codex");
      writeFileSync(
        codexRuntime,
        process.platform === "win32"
          ? "@echo off\r\necho codex-cli 1.2.3\r\n"
          : "#!/bin/sh\necho 'codex-cli 1.2.3'\n",
        "utf8",
      );
      if (process.platform !== "win32") chmodSync(codexRuntime, 0o755);
      writeFileSync(configPath, JSON.stringify({
        port: 9,
        multiAgentGuidanceEnabled: true,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
          },
        },
        defaultProvider: "openai",
        codexAutoStart: false,
      }), "utf8");

      const result = spawnSync(process.execPath, [cliPath, "status"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CODEXCOMMANDER_HOME: codexCommanderHome,
          CODEX_CLI_PATH: codexRuntime,
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Proxy:");
      expect(result.stdout).toContain("Health: http://127.0.0.1:9/healthz");
      expect(result.stdout).toContain("Dashboard: http://localhost:9/");
      expect(result.stdout).toContain(`Config: ${configPath}`);
      expect(result.stdout).toContain(`PID file: ${join(codexCommanderHome, "codexcommander.pid")}`);
      expect(result.stdout).toContain("Runtime:");
      expect(result.stdout).toContain("Runtime source:");
      expect(result.stdout).toContain("Default provider: openai");
      expect(result.stdout).toContain("Codex autostart: disabled");
      expect(result.stdout).toContain("Service:");
      expect(result.stdout).toContain(join(codexCommanderHome, "service.log"));
      expect(result.stdout).toContain("Codex autostart shim");
    } finally {
      rmSync(codexCommanderHome, { recursive: true, force: true });
    }
  });

  test("restore --help prints usage without mutating Codex config", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-help-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const before = [
        'model_provider = "codexcommander"',
        "",
        "[model_providers.codexcommander]",
        'base_url = "http://localhost:10100/v1"',
        'wire_api = "responses"',
        "",
      ].join("\n");
      writeFileSync(configPath, before, "utf8");

      const result = spawnSync(process.execPath, [cliPath, "restore", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: ccx restore");
      expect(result.stdout).not.toContain("Plain `codex` now runs natively");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("mutating command help exits before local state changes", () => {
    const codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-help-state-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-help-codex-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const markerPath = join(codexCommanderHome, "service-state.json");
      const before = 'model_provider = "codexcommander"\n';
      writeFileSync(configPath, before, "utf8");
      writeFileSync(markerPath, '{"installed":true}', "utf8");

      const cases = [
        { args: ["stop", "--help"], expected: "Usage: ccx stop" },
        { args: ["uninstall", "--help"], expected: "Usage: ccx uninstall" },
        { args: ["service", "uninstall", "--help"], expected: "Usage: ccx service" },
        { args: ["codex-shim", "uninstall", "--help"], expected: "Usage: ccx codex-shim" },
      ];

      for (const testCase of cases) {
        const result = runCli(testCase.args, {
          CODEX_HOME: codexHome,
          CODEXCOMMANDER_HOME: codexCommanderHome,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(testCase.expected);
        expect(readFileSync(configPath, "utf8")).toBe(before);
        expect(readFileSync(markerPath, "utf8")).toBe('{"installed":true}');
      }
    } finally {
      rmSync(codexCommanderHome, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("start rejects unknown and partially numeric port arguments", () => {
    const cases = [
      { args: ["start", "--port", "123abc"], expected: "Invalid port number" },
      { args: ["start", "--bad"], expected: "Usage: ccx start [--port <port>]" },
      { args: ["start", "--port", "1234", "--extra"], expected: "Usage: ccx start [--port <port>]" },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).not.toContain("Plain `codex`");
    }
  });

  test("start help wins before port validation", () => {
    const result = runCli(["start", "--port", "123abc", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: ccx start [--port <port>]");
  });

  test("invalid service and codex-shim usage include remove alias", () => {
    const cases = [
      { args: ["service", "nope"], expected: "Usage: ccx service [install|repair|start|stop|status|uninstall|remove]" },
      { args: ["codex-shim", "nope"], expected: "Usage: ccx codex-shim <install|status|uninstall|remove>" },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).toBe("");
    }
  });
});

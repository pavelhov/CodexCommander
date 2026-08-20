import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

type ProductionSnapshot = {
  result: unknown;
  expectedDefault: Record<string, unknown>;
  expectedMissing: Record<string, unknown>;
  appRaw: string | null;
  appConfig: unknown;
  appEntries: string[];
  codexRaw: string | null;
  codexEntries: string[];
};

/**
 * Import the production policy only after both homes are configured. The child
 * also replaces fetch so an accidental provider/network call fails the probe.
 */
function runProductionScenario(options: { appRaw?: string; codexRaw?: string }): ProductionSnapshot {
  const root = mkdtempSync(join(tmpdir(), "ccx-macos-first-run-"));
  const appHome = join(root, "app-home");
  const codexHome = join(root, "codex-home");
  mkdirSync(appHome);
  mkdirSync(codexHome);
  if (options.appRaw !== undefined) writeFileSync(join(appHome, "config.json"), options.appRaw, "utf8");
  if (options.codexRaw !== undefined) writeFileSync(join(codexHome, "config.toml"), options.codexRaw, "utf8");

  const script = `
    globalThis.fetch = () => { throw new Error("network blocked by macOS first-run test"); };
    const { existsSync, readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { getDefaultConfig, validateConfigCandidate } = await import("./src/config.ts");
    const { prepareMacOSAppStart } = await import("./src/cli/macos-first-run.ts");
    const appHome = process.env.CODEXCOMMANDER_HOME;
    const codexHome = process.env.CODEX_HOME;
    const appPath = join(appHome, "config.json");
    const codexPath = join(codexHome, "config.toml");
    const raw = path => existsSync(path) ? readFileSync(path, "utf8") : null;
    const parse = value => {
      if (value === null) return null;
      try { return JSON.parse(value); } catch { return null; }
    };
    console.log(JSON.stringify({
      result: prepareMacOSAppStart(),
      expectedDefault: validateConfigCandidate(getDefaultConfig()).config,
      expectedMissing: validateConfigCandidate({
        ...getDefaultConfig(),
        clientIntegrations: { codex: false },
      }).config,
      appRaw: raw(appPath),
      appConfig: parse(raw(appPath)),
      appEntries: readdirSync(appHome).sort(),
      codexRaw: raw(codexPath),
      codexEntries: readdirSync(codexHome).sort(),
    }));
  `;
  try {
    const child = Bun.spawnSync([process.execPath, "--eval", script], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CODEXCOMMANDER_HOME: appHome,
        CODEX_HOME: codexHome,
        CCX_TEST_NETWORK_BLOCKED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(child.stdout).trim();
    const stderr = new TextDecoder().decode(child.stderr).trim();
    if (child.exitCode !== 0) {
      throw new Error(`production probe failed (${child.exitCode}): ${stderr || stdout}`);
    }
    const line = stdout.split("\n").at(-1);
    if (!line) throw new Error(`production probe returned no JSON: ${stderr}`);
    return JSON.parse(line) as ProductionSnapshot;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const existingConfigBytes = `${JSON.stringify({
  port: 12001,
  providers: {
    openai: {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    },
  },
  defaultProvider: "openai",
  multiAgentGuidanceEnabled: true,
})}\n`;
const codexConfigBytes = 'model = "gpt-5.5"\n';

describe("macOS first-run preparation (production filesystem paths)", () => {
  test("fresh app plus initialized Codex enables normal explicit routing", () => {
    const snapshot = runProductionScenario({ codexRaw: codexConfigBytes });
    expect(snapshot.result).toEqual({ ok: true, changed: true, enableCodexRouting: true });
    expect(snapshot.appConfig).toEqual(snapshot.expectedDefault);
    expect(snapshot.appRaw).toBe(`${JSON.stringify(snapshot.expectedDefault, null, 2)}\n`);
    expect(snapshot.appEntries).toEqual([
      ".codexcommander-owner.json",
      ".codexcommander-uninstall.json",
      "config-mutation.sqlite",
      "config.json",
    ]);
    expect(snapshot.codexRaw).toBe(codexConfigBytes);
    expect(snapshot.codexEntries).toEqual(["config.toml"]);
  });

  test("fresh app plus missing Codex persists integration off and requests setup", () => {
    const snapshot = runProductionScenario({});
    expect(snapshot.result).toEqual({
      ok: true,
      changed: true,
      enableCodexRouting: false,
      setupRequired: "codex-first-run",
    });
    expect(snapshot.appConfig).toEqual(snapshot.expectedMissing);
    expect(snapshot.appRaw).toBe(`${JSON.stringify(snapshot.expectedMissing, null, 2)}\n`);
    expect(snapshot.appEntries).toEqual([
      ".codexcommander-owner.json",
      ".codexcommander-uninstall.json",
      "config-mutation.sqlite",
      "config.json",
    ]);
    expect(snapshot.codexRaw).toBeNull();
    expect(snapshot.codexEntries).toEqual([]);
  });

  test("existing config is never replaced even when Codex is missing", () => {
    const snapshot = runProductionScenario({ appRaw: existingConfigBytes });
    expect(snapshot.result).toEqual({
      ok: true,
      changed: false,
      enableCodexRouting: true,
      setupRequired: "codex-first-run",
    });
    expect(snapshot.appRaw).toBe(existingConfigBytes);
    expect(snapshot.appEntries).toEqual(["config.json"]);
    expect(snapshot.codexRaw).toBeNull();
    expect(snapshot.codexEntries).toEqual([]);
  });

  test("typed initialization refusals become a secret-free app error", () => {
    const invalidAppBytes = "{\n";
    const snapshot = runProductionScenario({ appRaw: invalidAppBytes, codexRaw: codexConfigBytes });
    expect(snapshot.result).toEqual({
      ok: false,
      changed: false,
      message: "CodexCommander configuration needs repair; no files were changed.",
      errorCode: "CONFIGURATION_REQUIRED",
    });
    expect(snapshot.appRaw).toBe(invalidAppBytes);
    expect(snapshot.appEntries).toEqual(["config.json"]);
    expect(snapshot.codexRaw).toBe(codexConfigBytes);
    expect(snapshot.codexEntries).toEqual(["config.toml"]);
  });
});

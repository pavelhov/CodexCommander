import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  codexEntries: string[] | null;
  codexHomeIsFile: boolean;
  childStdout: string;
  childStderr: string;
};

/**
 * Import the production policy only after both homes are configured. The child
 * also replaces fetch so an accidental provider/network call fails the probe.
 */
function runProductionScenario(options: {
  appRaw?: string;
  codexRaw?: string;
  codexHomeFileRaw?: string;
}): ProductionSnapshot {
  const root = mkdtempSync(join(tmpdir(), "ccx-macos-first-run-"));
  const appHome = join(root, "app-home");
  const codexHome = join(root, "codex-home");
  mkdirSync(appHome);
  mkdirSync(codexHome);
  if (options.appRaw !== undefined) writeFileSync(join(appHome, "config.json"), options.appRaw, "utf8");
  if (options.codexRaw !== undefined) writeFileSync(join(codexHome, "config.toml"), options.codexRaw, "utf8");

  const script = `
    globalThis.fetch = () => { throw new Error("network blocked by macOS first-run test"); };
    const { rmSync, writeFileSync } = await import("node:fs");
    const { getDefaultConfig, validateConfigCandidate } = await import("./src/config.ts");
    const { prepareMacOSAppStart } = await import("./src/cli/macos-first-run.ts");
    const codexHome = process.env.CODEX_HOME;
    if (process.env.CCX_TEST_REPLACE_CODEX_HOME === "1") {
      rmSync(codexHome, { recursive: true, force: true });
      writeFileSync(codexHome, process.env.CCX_TEST_CODEX_SENTINEL ?? "", "utf8");
    }
    console.log(JSON.stringify({
      result: prepareMacOSAppStart(),
      expectedDefault: validateConfigCandidate(getDefaultConfig()).config,
      expectedMissing: validateConfigCandidate({
        ...getDefaultConfig(),
        clientIntegrations: { codex: false },
      }).config,
    }));
  `;
  try {
    const childEnv = {
      ...process.env,
      CODEXCOMMANDER_HOME: appHome,
      CODEX_HOME: codexHome,
      CCX_TEST_NETWORK_BLOCKED: "1",
      ...(options.codexHomeFileRaw === undefined
        ? {}
        : {
          CCX_TEST_REPLACE_CODEX_HOME: "1",
          CCX_TEST_CODEX_SENTINEL: options.codexHomeFileRaw,
        }),
    };
    const child = Bun.spawnSync([process.execPath, "--eval", script], {
      cwd: REPO_ROOT,
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    if (child.exitCode !== 0) {
      throw new Error(`production probe failed (${child.exitCode}): ${stderr || stdout}`);
    }
    if (stderr !== "") throw new Error(`production probe wrote stderr: ${stderr}`);
    let payload: Pick<ProductionSnapshot, "result" | "expectedDefault" | "expectedMissing">;
    try {
      payload = JSON.parse(stdout) as typeof payload;
    } catch (error) {
      throw new Error(`production probe returned non-JSON stdout: ${JSON.stringify(stdout)}`, { cause: error });
    }

    const appPath = join(appHome, "config.json");
    const appRaw = existsSync(appPath) ? readFileSync(appPath, "utf8") : null;
    const appConfig = appRaw === null ? null : (() => {
      try { return JSON.parse(appRaw); } catch { return null; }
    })();
    const appEntries = readdirSync(appHome).sort();
    const codexHomeStat = lstatSync(codexHome);
    const codexHomeIsFile = codexHomeStat.isFile();
    const codexRaw = codexHomeIsFile
      ? readFileSync(codexHome, "utf8")
      : (() => {
        const codexPath = join(codexHome, "config.toml");
        return existsSync(codexPath) ? readFileSync(codexPath, "utf8") : null;
      })();
    const codexEntries = codexHomeIsFile ? null : readdirSync(codexHome).sort();
    return {
      ...payload,
      appRaw,
      appConfig,
      appEntries,
      codexRaw,
      codexEntries,
      codexHomeIsFile,
      childStdout: stdout,
      childStderr: stderr,
    };
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

  test("an ENOTDIR Codex home is present-or-unreadable, not missing", () => {
    const codexSentinel = "codex-home-file-sentinel";
    const snapshot = runProductionScenario({ codexHomeFileRaw: codexSentinel });
    expect(snapshot.result).toEqual({ ok: true, changed: true, enableCodexRouting: true });
    expect(snapshot.appConfig).toEqual(snapshot.expectedDefault);
    expect(snapshot.appRaw).toBe(`${JSON.stringify(snapshot.expectedDefault, null, 2)}\n`);
    expect(snapshot.appEntries).toEqual([
      ".codexcommander-owner.json",
      ".codexcommander-uninstall.json",
      "config-mutation.sqlite",
      "config.json",
    ]);
    expect(snapshot.codexHomeIsFile).toBe(true);
    expect(snapshot.codexRaw).toBe(codexSentinel);
    expect(snapshot.codexEntries).toBeNull();
    expect(snapshot.childStdout).not.toContain(codexSentinel);
    expect(snapshot.childStderr).toBe("");
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
    const secretSentinel = "macos-first-run-secret-sentinel";
    const invalidAppBytes = `{"secret":"${secretSentinel}"\n`;
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
    expect(snapshot.childStdout).not.toContain(secretSentinel);
    expect(snapshot.childStderr).toBe("");
  });
});

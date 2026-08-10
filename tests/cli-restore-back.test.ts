import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimOwnedServiceHome } from "./helpers/owned-service-home";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";
import { MANAGED_AGENTS_TABLE_MARKER, MANAGED_SUBAGENT_DEFAULT_MARKER } from "../src/codex/subagent-defaults";

setDefaultTimeout(30_000);

const repoRoot = join(import.meta.dir, "..");

function ownedEnvironment(codexHome: string, ccxHome: string): Record<string, string> {
  const home = join(ccxHome, "home");
  mkdirSync(home, { recursive: true });
  return { HOME: home, USERPROFILE: home, ...claimOwnedServiceHome(codexHome, ccxHome, home).env };
}

function currentConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
    ...overrides,
  };
}

describe("ccx restore back", () => {
  test("restore durably disables Codex in an isolated home", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-restore-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-restore-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig()), "utf8");
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ccxHome), CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome, CI: "1" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(ccxHome, "config.json"), "utf8")).clientIntegrations.codex).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Codex integration is OFF and plain `codex` now runs natively.");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("restore --json emits a schema-complete envelope on the already-OFF no-op path", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-json-noop-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-json-noop-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig({
        clientIntegrations: { codex: false },
      })), "utf8");
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore", "--json"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ccxHome), CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        success: boolean;
        artifacts: Record<"config" | "catalog", { state: string; changed: boolean; message: string }>;
      };
      // Early exits must stay shape-stable with CodexNativeRestoreResult:
      // consumers never special-case a valid outcome.
      expect(envelope.success).toBe(true);
      for (const key of ["config", "catalog"] as const) {
        expect(envelope.artifacts[key].state).toBe("skipped");
        expect(envelope.artifacts[key].changed).toBe(false);
        expect(typeof envelope.artifacts[key].message).toBe("string");
      }
      expect(envelope.artifacts.catalog).toHaveProperty("removed", 0);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("sync treats durable OFF as a successful no-write policy result", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-sync-off-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-sync-off-home-"));
    try {
      const configPath = join(codexHome, "config.toml");
      writeFileSync(configPath, 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig({
        clientIntegrations: { codex: false },
      })), "utf8");
      const before = statSync(configPath).mtimeMs;
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "sync"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ccxHome), CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome, CI: "1" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Codex integration is OFF; sync skipped and no Codex files changed.");
      expect(statSync(configPath).mtimeMs).toBe(before);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("sync exits nonzero when managed-default cleanup is ambiguous", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-sync-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-sync-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), [
        MANAGED_AGENTS_TABLE_MARKER,
        "[agents]",
        MANAGED_SUBAGENT_DEFAULT_MARKER,
        "[notice]",
        'default_subagent_model = "gpt-5.6-sol"',
        "",
      ].join("\n"), "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig({
        providers: {
          fixture: {
            adapter: "openai-chat",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "fixture-key",
            allowPrivateNetwork: true,
            models: ["fixture-model"],
          },
        },
        defaultProvider: "fixture",
      })), "utf8");
      const codexCliPath = createCodexRuntimeFixture(ccxHome);

      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "sync"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...ownedEnvironment(codexHome, ccxHome),
          CODEX_HOME: codexHome,
          CODEXCOMMANDER_HOME: ccxHome,
          CODEX_CLI_PATH: codexCliPath,
          CI: "1",
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Codex sync did not complete");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("help documents both directions of the switch", () => {
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-help-home-"));
    try {
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig()), "utf8");
      const run = (...cliArgs: string[]) => spawnSync(process.execPath, ["run", "src/cli/index.ts", ...cliArgs], {
        cwd: repoRoot,
        env: { ...process.env, CODEXCOMMANDER_HOME: ccxHome, CI: "1" },
        encoding: "utf8",
      });
      const usage = run("help");
      expect(usage.status).toBe(0);
      expect(`${usage.stdout}\n${usage.stderr}`).toContain("ccx restore back");
      const restoreHelp = run("help", "restore");
      expect(restoreHelp.status).toBe(0);
      expect(`${restoreHelp.stdout}\n${restoreHelp.stderr}`).toContain("ccx restore [back]");
    } finally {
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });
});

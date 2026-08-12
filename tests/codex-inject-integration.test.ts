import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import {
  MANAGED_AGENTS_TABLE_MARKER,
  MANAGED_SUBAGENT_DEFAULT_MARKER,
} from "../src/codex/subagent-defaults";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

// Full injectCodexConfig runs in a subprocess with isolated CODEX_HOME/CODEXCOMMANDER_HOME so
// module-level path constants bind to the temp dirs (same pattern as codex-journal.test.ts).
function runInject(
  codexHome: string,
  ccxHome: string,
  configJson = "{}",
  optionsJson = "{}",
): { stdout: string; status: number } {
  const script = `
    const { injectCodexConfig } = require("./src/codex/inject");
    injectCodexConfig(
      10100,
      JSON.parse(process.env.TEST_CCX_CONFIG),
      JSON.parse(process.env.TEST_INJECT_OPTIONS),
    ).then(r => {
      console.log(JSON.stringify(r));
    });
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEXCOMMANDER_HOME: ccxHome,
      TEST_CCX_CONFIG: configJson,
      TEST_INJECT_OPTIONS: optionsJson,
    },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
}

function runRestore(codexHome: string, ccxHome: string): { stdout: string; status: number } {
  const script = `
    const { restoreNativeCodex } = require("./src/codex/inject");
    console.log(JSON.stringify(restoreNativeCodex()));
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
}

describe("injectCodexConfig integration (Design B)", () => {
  let codexHome: string;
  let ccxHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "ccx-inject-codex-"));
    ccxHome = mkdtempSync(join(tmpdir(), "ccx-inject-home-"));
  });

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(ccxHome, { recursive: true, force: true });
  });

  test("re-inject over a Design B config is idempotent", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ccxHome).status).toBe(0);
    const configPath = join(codexHome, "config.toml");
    const profilePath = join(codexHome, "codexcommander.config.toml");
    const first = readFileSync(configPath, "utf8");
    const firstProfile = readFileSync(profilePath, "utf8");
    const sentinel = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(configPath, sentinel, sentinel);
    utimesSync(profilePath, sentinel, sentinel);
    const configMtime = lstatSync(configPath, { bigint: true }).mtimeNs;
    const profileMtime = lstatSync(profilePath, { bigint: true }).mtimeNs;
    expect(runInject(codexHome, ccxHome).status).toBe(0);
    const second = readFileSync(configPath, "utf8");

    expect(second.match(/openai_base_url/g)?.length).toBe(1);
    expect(second.match(/Auto-injected by CodexCommander/g)?.length).toBe(1);
    expect(second).toBe(first);
    expect(readFileSync(profilePath, "utf8")).toBe(firstProfile);
    expect(lstatSync(configPath, { bigint: true }).mtimeNs).toBe(configMtime);
    expect(lstatSync(profilePath, { bigint: true }).mtimeNs).toBe(profileMtime);
  });

  test("expected config generation fences the post-catalog injection gap", () => {
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.5"\n';
    writeFileSync(configPath, original, "utf8");

    const result = runInject(
      codexHome,
      ccxHome,
      "{}",
      JSON.stringify({ expectedConfigGeneration: { value: 1 } }),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false, status: "stale" });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "codexcommander.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "codexcommander-journal.json"))).toBe(false);
  });

  test("exact admitted config authority fences a manual byte rewrite before injection", () => {
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.5"\n';
    writeFileSync(configPath, original, "utf8");
    const script = `
      const { writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      const { loadConfig } = require("./src/config");
      const { captureCatalogConfigAuthority } = require("./src/codex/catalog-admission");
      const { injectCodexConfig } = require("./src/codex/inject");
      const config = loadConfig();
      const authority = captureCatalogConfigAuthority(config);
      writeFileSync(
        join(process.env.CODEXCOMMANDER_HOME, "config.json"),
        JSON.stringify(config, null, 2) + "\\n",
      );
      const result = await injectCodexConfig(10100, config, { expectedConfigAuthority: authority });
      console.log(JSON.stringify(result));
    `;
    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ success: false, status: "stale" });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "codexcommander.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "codexcommander-journal.json"))).toBe(false);
  });

  test("fastMode=false forces fast_mode=false in both config and profile", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ccxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("[features]");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");

    const profile = readFileSync(join(codexHome, "codexcommander.config.toml"), "utf8");
    expect(profile).toContain("fast_mode = false");
    expect(profile).not.toContain("fast_mode = true");
  });

  test("fastMode=true adds fast_mode=true to a config without a [features] table", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ccxHome, JSON.stringify({ fastMode: true }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("[features]");
    expect(config).toContain("fast_mode = true");

    const profile = readFileSync(join(codexHome, "codexcommander.config.toml"), "utf8");
    expect(profile).toContain("fast_mode = true");
  });

  test("fastMode unset preserves the user's existing fast_mode setting", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n\n[features]\nfast_mode = false\n', "utf8");

    const r = runInject(codexHome, ccxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");

    const profile = readFileSync(join(codexHome, "codexcommander.config.toml"), "utf8");
    expect(profile).not.toContain("fast_mode");
  });

  test("fastMode unset does not add a [features] table to a config that lacks one", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ccxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).not.toContain("[features]");
    expect(config).not.toContain("fast_mode");

    const profile = readFileSync(join(codexHome, "codexcommander.config.toml"), "utf8");
    expect(profile).not.toContain("fast_mode");
  });

  test("fastMode=false updates a commented [features] header without duplicating the table", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.5"',
      "",
      "[features] # user comment",
      "fast_mode = true",
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ccxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
    expect(Bun.TOML.parse(config).features.fast_mode).toBe(false);
  });

  test("fastMode=false updates a quoted [\"features\"] header without duplicating the table", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.5"',
      "",
      '["features"]',
      "fast_mode = true",
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ccxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
    expect(Bun.TOML.parse(config).features.fast_mode).toBe(false);
  });

  test("fastMode=false updates a quoted \"fast_mode\" key", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.5"',
      "",
      "[features]",
      '"fast_mode" = true',
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ccxHome, JSON.stringify({ fastMode: false }));
    expect(r.status).toBe(0);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("fast_mode = false");
    expect(config).not.toContain("fast_mode = true");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
    expect(Bun.TOML.parse(config).features.fast_mode).toBe(false);
  });

  test("opt-in injects native subagent defaults, removes them when disabled, and restores the native config", () => {
    const original = [
      'model = "gpt-5.5"',
      "",
      "[notice]",
      "hide = true",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");
    const enabled = JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    });

    expect(runInject(codexHome, ccxHome, enabled).status).toBe(0);
    const injected = readFileSync(join(codexHome, "config.toml"), "utf8");
    const profile = readFileSync(join(codexHome, "codexcommander.config.toml"), "utf8");
    expect(injected).toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(injected).toContain('default_subagent_model = "gpt-5.6-sol"');
    expect(injected).toContain('default_subagent_reasoning_effort = "high"');
    expect(injected).toContain(MANAGED_AGENTS_TABLE_MARKER);
    expect(profile).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(profile).not.toContain("default_subagent_model");

    expect(runInject(codexHome, ccxHome, "{}").status).toBe(0);
    const disabled = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(disabled).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(disabled).not.toContain("default_subagent_model");
    expect(disabled).not.toContain("default_subagent_reasoning_effort");
    expect(disabled).toContain("[notice]\nhide = true");

    expect(runInject(codexHome, ccxHome, enabled).status).toBe(0);
    expect(runRestore(codexHome, ccxHome).status).toBe(0);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("opt-in preserves a user-owned native default pair and reports the conflict", () => {
    const original = [
      'model = "gpt-5.5"',
      "",
      "[agents]",
      'default_subagent_model = "user/model" # owned by user',
      'default_subagent_reasoning_effort = "medium"',
      "max_threads = 6",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const result = runInject(codexHome, ccxHome, JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).message).toContain("user-owned agents.default_subagent_model");

    const injected = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(injected).toContain('default_subagent_model = "user/model" # owned by user');
    expect(injected).toContain('default_subagent_reasoning_effort = "medium"');
    expect(injected).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(injected).not.toContain('default_subagent_model = "gpt-5.6-sol"');
  });

  test("sync-disabled injection cleans managed-default residue before journaling and restore", () => {
    const residue = [
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_model = "stale/routed-model"',
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      'default_subagent_reasoning_effort = "high"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), residue, "utf8");

    const injectedResult = runInject(codexHome, ccxHome, "{}");
    expect(injectedResult.status).toBe(0);
    expect(JSON.parse(injectedResult.stdout).success).toBe(true);
    const injected = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(injected).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(injected).not.toContain("default_subagent_model");
    expect(() => Bun.TOML.parse(injected)).not.toThrow();

    const restoredResult = runRestore(codexHome, ccxHome);
    expect(restoredResult.status).toBe(0);
    expect(JSON.parse(restoredResult.stdout).success).toBe(true);
    const restored = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(restored).not.toContain(MANAGED_AGENTS_TABLE_MARKER);
    expect(restored).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(restored).not.toContain("default_subagent_model");
    expect(restored).toContain("[features]\nfast_mode = true");
  });

  test("ambiguous managed-default residue refuses injection without changing files", () => {
    const ambiguous = [
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      "",
      'default_subagent_model = "stale/routed-model"',
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), ambiguous, "utf8");

    const result = runInject(codexHome, ccxHome, "{}");
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(false);
    expect(payload.message).toContain("injection refused");
    expect(payload.message).toContain("orphaned managed subagent default marker");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(ambiguous);
    expect(existsSync(join(codexHome, "codexcommander.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "codexcommander-journal.json"))).toBe(false);
  });

  test("kept-user-base-url: reports routing NOT injected and leaves the user's override alone", () => {
    writeFileSync(join(codexHome, "config.toml"), [
      'openai_base_url = "https://my-own-gateway.example/v1"',
      'model = "gpt-5.5"',
      "",
    ].join("\n"), "utf8");

    const r = runInject(codexHome, ccxHome, JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    }));
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).not.toContain("All models now route through codexcommander proxy");
    expect(result.nativeSubagentDefaultsWarning).toContain("user-owned root openai_base_url");

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('openai_base_url = "https://my-own-gateway.example/v1"');
    expect(config).not.toContain("# Auto-injected by CodexCommander\nopenai_base_url");
    expect(config).not.toContain(MANAGED_SUBAGENT_DEFAULT_MARKER);
    expect(config).not.toContain("default_subagent_model");
  });

  test("external model provider retains config, session history, and journal when its profile surface is indeterminate", () => {
    const original = [
      'model_provider = "custom"',
      'model = "third-party-model"',
      "",
      "[model_providers.custom]",
      'name = "Provider Manager"',
      'base_url = "https://gateway.example/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir);
    const profilePath = join(codexHome, "codexcommander.config.toml");
    const profile = "sentinel profile\n";
    writeFileSync(profilePath, profile, "utf8");
    const rolloutPath = join(sessionsDir, "rollout-custom.jsonl");
    const rollout = JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-custom", model_provider: "custom", source: "cli", cwd: codexHome },
    }) + "\n";
    writeFileSync(rolloutPath, rollout, "utf8");
    const dbPath = join(codexHome, "state_5.sqlite");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
      source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL
    )`);
    db.run(`INSERT INTO threads VALUES ('thread-custom', ?, 'custom', 'cli', 'hello', 1)`, rolloutPath);
    db.close();
    const dbBefore = readFileSync(dbPath);
    const journalPath = join(codexHome, "codexcommander-journal.json");
    const journal = JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });
    writeFileSync(journalPath, journal, "utf8");

    const r = runInject(codexHome, ccxHome, JSON.stringify({
      syncCodexSubagentDefaults: true,
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "high",
    }));
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).toContain('external model_provider "custom"');
    expect(result.message).toContain("http://127.0.0.1:10100/v1");
    expect(result.message).toContain("Responses passthrough");
    expect(result.nativeSubagentDefaultsWarning).toContain("external model_provider");

    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(readFileSync(profilePath, "utf8")).toBe(profile);
    expect(readFileSync(dbPath).equals(dbBefore)).toBe(true);
    expect(readFileSync(rolloutPath, "utf8")).toBe(rollout);
    expect(readFileSync(journalPath, "utf8")).toBe(journal);
  });

  test("external-provider preservation refuses a changed provider before any write", () => {
    const original = 'model_provider = "openai"\nmodel = "gpt-5.6-sol"\n';
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const r = runInject(
      codexHome,
      ccxHome,
      "{}",
      JSON.stringify({ expectedExternalProvider: "custom" }),
    );

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(false);
    expect(result.message).toContain("changed before it could be preserved");
    expect(result.message).toContain("no files were changed");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "codexcommander.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "codexcommander-journal.json"))).toBe(false);
  });

  // Regression for #1090: the reporter's Windows shape — CRLF line endings, an external
  // root model_provider, a coexisting [model_providers.codexcommander] table, and a [windows]
  // section — must survive injectCodexConfig byte-for-byte. The external-provider guard
  // runs on raw (pre-EOL-normalized) content, so CRLF parsing is part of what this proves.
  test("#1090: CRLF Windows config with external deepseek provider and codexcommander table stays byte-for-byte unchanged", () => {
    const original = [
      'model = "deepseek-v4-flash"',
      'model_provider = "deepseek"',
      "",
      "[model_providers.codexcommander]",
      'name = "codexcommander"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      'env_key = "CODEX_DEEPSEEK_API_KEY"',
      "",
      "[windows]",
      'sandbox = "unelevated"',
      "",
    ].join("\r\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const r = runInject(codexHome, ccxHome);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("routing NOT injected");
    expect(result.message).toContain('external model_provider "deepseek"');

    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("restoreNativeCodex retains the journal when an external provider has an indeterminate profile surface", () => {
    const configPath = join(codexHome, "config.toml");
    const config = 'model_provider = "custom"\nmodel = "third-party-model"\n';
    writeFileSync(configPath, config, "utf8");
    const profilePath = join(codexHome, "codexcommander.config.toml");
    const profile = 'model_provider = "custom"\n';
    writeFileSync(profilePath, profile, "utf8");

    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir);
    const rolloutPath = join(sessionsDir, "rollout-custom.jsonl");
    const rollout = JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-custom", model_provider: "custom", source: "cli", cwd: codexHome },
    }) + "\n";
    writeFileSync(rolloutPath, rollout, "utf8");
    const dbPath = join(codexHome, "state_5.sqlite");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
      source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL
    )`);
    db.run(`INSERT INTO threads VALUES ('thread-custom', ?, 'custom', 'cli', 'hello', 1)`, rolloutPath);
    db.close();
    const dbBefore = readFileSync(dbPath);

    const journalPath = join(codexHome, "codexcommander-journal.json");
    const journal = JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    });
    writeFileSync(journalPath, journal, "utf8");

    const r = runRestore(codexHome, ccxHome);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain('External Codex provider "custom" preserved');
    expect(readFileSync(configPath, "utf8")).toBe(config);
    expect(readFileSync(profilePath, "utf8")).toBe(profile);
    expect(readFileSync(dbPath).equals(dbBefore)).toBe(true);
    expect(readFileSync(rolloutPath, "utf8")).toBe(rollout);
    expect(readFileSync(journalPath, "utf8")).toBe(journal);
  });

  test("provider selected through a named root profile is also preserved", () => {
    const original = [
      'profile = "work"',
      'model_provider = "openai"',
      "",
      "[profiles.work]",
      'model_provider = "custom"',
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const r = runInject(codexHome, ccxHome);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).message).toContain('external model_provider "custom"');
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("invalid TOML with an apparent external provider fails closed without writing", () => {
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model_provider = "custom"',
      "[model_providers.custom]",
      'base_url = "https://external.example/v1"',
      "broken = [",
      "",
    ].join("\n");
    writeFileSync(configPath, original, "utf8");

    const result = runInject(codexHome, ccxHome);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false });
    expect(JSON.parse(result.stdout).message).toContain("not valid TOML");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "codexcommander.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "codexcommander-journal.json"))).toBe(false);
  });

  test("external provider guidance includes the admission header for non-loopback binds", () => {
    const original = 'model_provider = "custom"\n';
    writeFileSync(join(codexHome, "config.toml"), original, "utf8");

    const r = runInject(codexHome, ccxHome, JSON.stringify({ hostname: "192.168.1.20" }));
    expect(r.status).toBe(0);
    const message = JSON.parse(r.stdout).message;
    expect(message).toContain("http://192.168.1.20:10100/v1");
    expect(message).toContain("x-codexcommander-api-key from CODEXCOMMANDER_API_AUTH_TOKEN");
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
  });

  test("non-loopback hostname uses the provider-table injection", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    const r = runInject(codexHome, ccxHome, JSON.stringify({ hostname: "192.168.1.20" }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model_provider = "codexcommander"');
    expect(config).toContain("[model_providers.codexcommander]");
    expect(config).toContain('env_http_headers = { "x-codexcommander-api-key" = "CODEXCOMMANDER_API_AUTH_TOKEN" }');
    expect(config).toContain('base_url = "http://192.168.1.20:10100/v1"');
    expect(config).not.toContain("openai_base_url");
  });

  test("CRLF config (Windows-edited) stays uniformly CRLF after injection", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\r\n\r\n[features]\r\nfast_mode = true\r\n', "utf8");

    expect(runInject(codexHome, ccxHome).status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(config).toContain('openai_base_url = "http://127.0.0.1:10100/v1"');
    // Every newline is CRLF — no mixed-EOL file on Windows.
    expect(config.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(config).toContain("\r\n");

    // Idempotent re-inject keeps the CRLF form stable.
    expect(runInject(codexHome, ccxHome).status).toBe(0);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(config);
  });

  test("LF config gains no carriage returns from injection", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ccxHome).status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(config).toContain("openai_base_url");
    expect(config).not.toContain("\r");
  });

  test("inject does not turn on multi_agent_v2; fresh installs stay on Codex's default v1 surface until the user opts in", () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");

    expect(runInject(codexHome, ccxHome).status).toBe(0);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");

    expect(config).not.toContain("[features.multi_agent_v2]");
    expect(config).not.toContain("multi_agent_v2 = true");
    expect(config).not.toContain("multi_agent_v2 = {");
  });
});

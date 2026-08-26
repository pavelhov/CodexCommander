import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function backupPathForTestCatalog(codexHome: string, codexCommanderHome: string, catalogName: string): string {
  const catalogPath = join(realpathSync.native(codexHome), catalogName);
  const normalized = process.platform === "win32" ? resolve(catalogPath).toLowerCase() : resolve(catalogPath);
  const backupId = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(codexCommanderHome, `catalog-backup-${backupId}.json`);
}

function runScript(codexHome: string, codexCommanderHome: string, script: string): { stdout: string; status: number } {
  const codexCliPath = createCodexRuntimeFixture(codexCommanderHome);
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEXCOMMANDER_HOME: codexCommanderHome,
      CODEX_CLI_PATH: codexCliPath,
    },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
}

describe("Codex catalog restore", () => {
  let codexHome: string;
  let codexCommanderHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "ccx-catalog-home-"));
    codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-catalog-ccx-"));
  });

  afterEach(() => {
    if (existsSync(codexHome)) rmSync(codexHome, { recursive: true, force: true });
    if (existsSync(codexCommanderHome)) rmSync(codexCommanderHome, { recursive: true, force: true });
  });

  // These process-boundary integration cases can exceed Bun's default budget on
  // loaded Windows and macOS hosts. Keep assertions strict while allowing startup.
  test("drops routed entries without overwriting user-added native entries", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5" },
        { slug: "opencode-go/deepseek-v4-pro" },
        {
          slug: "gpt-5.6-sol",
          owned_by: "combo",
          codexcommander_catalog_kind: "combo-native-alias-v1",
        },
        { slug: "user-native" },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, codexCommanderHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog();
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 2, kept: 2 });
    const slugs = JSON.parse(readFileSync(catalogPath, "utf8")).models.map((m: { slug: string }) => m.slug);
    expect(slugs).toEqual(["gpt-5.5", "user-native"]);
  }, { timeout: 45_000 });

  test("fallback restore repairs only enabled natives with unanimously visible account clones", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(join(codexCommanderHome, "config.json"), JSON.stringify({
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
      disabledModels: ["gpt-5.4", "desktop/gpt-5.5"],
    }), "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", visibility: "hide", priority: 7 },
        { slug: "gpt-5.4", visibility: "hide" },
        { slug: "gpt-5.3-codex-spark", visibility: "hide" },
        { slug: "user-native", visibility: "hide" },
        {
          slug: "team/gpt-5.5",
          visibility: "list",
          codexcommander_catalog_kind: "account-selector-v1",
        },
        {
          slug: "desktop/gpt-5.5",
          visibility: "hide",
          codexcommander_catalog_kind: "account-selector-v1",
        },
        {
          slug: "team/gpt-5.4",
          visibility: "list",
          codexcommander_catalog_kind: "account-selector-v1",
        },
        { slug: "provider/gpt-5.3-codex-spark", visibility: "list" },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, codexCommanderHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const first = restoreCodexCatalog();
      const second = restoreCodexCatalog();
      console.log(JSON.stringify({ first, second }));
    `);

    expect(r.status).toBe(0);
    const resolvedCatalogPath = join(realpathSync.native(codexHome), "catalog.json");
    expect(JSON.parse(r.stdout)).toEqual({
      first: { removed: 4, kept: 4, path: resolvedCatalogPath },
      second: { removed: 0, kept: 4, path: resolvedCatalogPath },
    });
    const restored = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(restored.find(model => model.slug === "gpt-5.5")).toMatchObject({
      visibility: "list",
      priority: 7,
    });
    expect(restored.find(model => model.slug === "gpt-5.4")?.visibility).toBe("hide");
    expect(restored.find(model => model.slug === "gpt-5.3-codex-spark")?.visibility).toBe("hide");
    expect(restored.find(model => model.slug === "user-native")?.visibility).toBe("hide");
    expect(restored.some(model => String(model.slug).includes("/"))).toBe(false);
  }, { timeout: 15_000 });

  test("fallback restore leaves hidden natives untouched when current config is unreadable", () => {
    const catalogPath = join(codexHome, "catalog.json");
    const configPath = join(codexCommanderHome, "config.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(configPath, "{", "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", visibility: "hide" },
        {
          slug: "team/gpt-5.5",
          visibility: "list",
          codexcommander_catalog_kind: "account-selector-v1",
        },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, codexCommanderHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      console.log(JSON.stringify(restoreCodexCatalog()));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 1, kept: 1 });
    expect(JSON.parse(readFileSync(catalogPath, "utf8")).models).toEqual([
      { slug: "gpt-5.5", visibility: "hide" },
    ]);
    expect(readFileSync(configPath, "utf8")).toBe("{");
  }, { timeout: 15_000 });

  test("backup restore repairs only later native additions with trusted visible clones", () => {
    const catalogPath = join(codexHome, "catalog.json");
    const backupPath = backupPathForTestCatalog(codexHome, codexCommanderHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(backupPath, JSON.stringify({
      models: [{ slug: "gpt-5.4", visibility: "hide", priority: 50 }],
    }, null, 2) + "\n");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.4", visibility: "hide", priority: 0 },
        { slug: "gpt-5.5", visibility: "hide", priority: 7 },
        { slug: "gpt-5.3-codex-spark", visibility: "hide" },
        {
          slug: "team/gpt-5.4",
          visibility: "list",
          codexcommander_catalog_kind: "account-selector-v1",
        },
        {
          slug: "team/gpt-5.5",
          visibility: "list",
          codexcommander_catalog_kind: "account-selector-v1",
        },
        {
          slug: "team/gpt-5.3-codex-spark",
          visibility: "list",
          codexcommander_catalog_kind: "account-selector-v1",
        },
        {
          slug: "desktop/gpt-5.3-codex-spark",
          visibility: "hide",
          codexcommander_catalog_kind: "account-selector-v1",
        },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, codexCommanderHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      console.log(JSON.stringify(restoreCodexCatalog()));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 4, kept: 3 });
    const restored = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(restored).toEqual([
      { slug: "gpt-5.4", visibility: "hide", priority: 50 },
      { slug: "gpt-5.5", visibility: "list", priority: 7 },
      { slug: "gpt-5.3-codex-spark", visibility: "hide" },
    ]);
  }, { timeout: 15_000 });

  test("uses pristine backup while preserving native entries added after sync", () => {
    const catalogPath = join(codexHome, "catalog.json");
    const backupPath = backupPathForTestCatalog(codexHome, codexCommanderHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(backupPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 50 },
        { slug: "codex-mini", priority: 60 },
      ],
    }, null, 2) + "\n");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 0, supports_websockets: true },
        { slug: "codex-mini", priority: 60, supports_websockets: true },
        { slug: "umans/umans-kimi-k2.7" },
        { slug: "user-native", priority: 10 },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, codexCommanderHome, `
      const { restoreCodexCatalog } = require("./src/codex/catalog");
      const result = restoreCodexCatalog();
      console.log(JSON.stringify(result));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 1, kept: 3 });
    const restored = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(restored).toEqual([
      { slug: "gpt-5.5", priority: 50 },
      { slug: "codex-mini", priority: 60 },
      { slug: "user-native", priority: 10 },
    ]);
  }, { timeout: 45_000 });

  test("sync applies native-only subagent priority selections", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 50, base_instructions: "native", visibility: "list" },
        { slug: "gpt-5.4", priority: 0, base_instructions: "native", visibility: "list" },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, codexCommanderHome, `
      const { saveConfig } = require("./src/config");
      const { captureCatalogAdmissionSnapshot } = require("./src/codex/catalog-admission");
      const { convergeCodexCatalog } = require("./src/codex/convergence");
      (async () => {
        const config = {
          port: 10100,
          multiAgentGuidanceEnabled: true,
          providers: { openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
            disabled: true,
          } },
          defaultProvider: "openai",
          subagentModels: [{ model: "gpt-5.5" }],
        };
        saveConfig(config);
        const result = await convergeCodexCatalog(captureCatalogAdmissionSnapshot(config), {
          action: "converge", scope: "catalog", reason: "api-sync", mode: "explicit", deadlineMs: 1000,
        });
        console.log(JSON.stringify(result.projection));
      })();
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ added: 0 });
    const synced = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(synced.find(m => m.slug === "gpt-5.5")?.priority).toBe(0);
    expect(synced.find(m => m.slug === "gpt-5.4")?.priority).toBeGreaterThan(100);
  }, { timeout: 45_000 });

  test("sync advertises documented Codex-native additions omitted by the bundled catalog", () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        {
          slug: "gpt-5.5",
          priority: 0,
          base_instructions: "native",
          visibility: "list",
          context_window: 272_000,
          max_context_window: 272_000,
        },
        {
          slug: "gpt-5.4",
          priority: 2,
          base_instructions: "native",
          visibility: "list",
          context_window: 272_000,
          max_context_window: 1_000_000,
        },
      ],
    }, null, 2) + "\n");

    const r = runScript(codexHome, codexCommanderHome, `
      const { saveConfig } = require("./src/config");
      const { captureCatalogAdmissionSnapshot } = require("./src/codex/catalog-admission");
      const { convergeCodexCatalog } = require("./src/codex/convergence");
      (async () => {
        const config = {
          port: 10100,
          multiAgentGuidanceEnabled: true,
          providers: { openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
            disabled: true,
          } },
          defaultProvider: "openai",
          subagentModels: [{ model: "gpt-5.5" }, { model: "gpt-5.4" }, { model: "gpt-5.3-codex-spark" }, { model: "gpt-5.6-sol" }],
        };
        saveConfig(config);
        const result = await convergeCodexCatalog(captureCatalogAdmissionSnapshot(config), {
          action: "converge", scope: "catalog", reason: "api-sync", mode: "explicit", deadlineMs: 1000,
        });
        console.log(JSON.stringify(result.projection));
      })();
    `);

    expect(r.status).toBe(0);
    const synced = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<Record<string, unknown>>;
    expect(synced.map(m => m.slug)).toContain("gpt-5.3-codex-spark");
    expect(synced.map(m => m.slug)).toContain("gpt-5.6-sol");
    expect(synced.map(m => m.slug)).toContain("gpt-5.6-terra");
    expect(synced.map(m => m.slug)).toContain("gpt-5.6-luna");
    expect(synced.find(m => m.slug === "gpt-5.4")?.max_context_window).toBe(1_000_000);
  }, { timeout: 45_000 });
});

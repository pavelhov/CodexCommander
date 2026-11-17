import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../src/config";
import { resetCatalogRuntimeStateForTests } from "../src/codex/catalog";
import {
  loadBundledCodexCatalog,
  setBundledCatalogCacheForTests,
} from "../src/codex/catalog/bundled";
import { resetNativeLiveCatalogStateForTests } from "../src/codex/catalog/native-live";
import type { RawCatalog, RawEntry } from "../src/codex/catalog/parsing";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import {
  persistCodexRuntime,
  resetCodexRuntimeResolveCacheForTests,
  setCodexRuntimeResolveCacheForTests,
} from "../src/codex/runtime";
import { createManagementConvergeCodex } from "../src/codex/management-convergence";
import { createCatalogConvergeRequest } from "../src/codex/catalog-admission";
import * as nativeProfileStartup from "../src/codex/native-profile-startup";
import type { CodexCommanderConfig } from "../src/types";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";

setDefaultTimeout(30_000);

const nativeSlugs = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra",
  "gpt-6-sol", "gpt-6-luna", "gpt-reserve", "gpt-daybreak-blue-latest",
  "gpt-daybreak-red-latest", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.2-sol",
];
const routedIds = Array.from({ length: 195 }, (_, index) => `worker-${index}`);
const savedEnvironment = {
  codexHome: process.env.CODEX_HOME,
  commanderHome: process.env.CODEXCOMMANDER_HOME,
  cli: process.env.CODEX_CLI_PATH,
  path: process.env.PATH,
};
let home: string;
let fetchSpy: ReturnType<typeof spyOn>;
let gateSpy: ReturnType<typeof spyOn>;

function nativeCatalog(bundled: boolean, instructions = "Bundled native instructions"): RawCatalog {
  return {
    models: nativeSlugs.map((slug, priority) => ({
      slug,
      display_name: slug,
      description: "Native fixture",
      priority,
      visibility: "list",
      base_instructions: bundled ? instructions : "Live native instructions",
      shell_type: bundled ? "unified_exec" : "shell_command",
      include_apps_usage_instructions: !bundled,
      include_plugin_usage_instructions: !bundled,
      supports_reasoning_effort_updates: bundled,
      node_repl_auto_review_required: bundled,
      supports_experimental_context: bundled,
      context_window: 272_000,
      max_context_window: 872_000,
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"]
        .map(effort => ({ effort, description: effort })),
    })),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ccx-template-stability-"));
  process.env.CODEX_HOME = home;
  process.env.CODEXCOMMANDER_HOME = home;
  process.env.PATH = "";
  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  resetNativeLiveCatalogStateForTests();
  gateSpy = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    new Response(JSON.stringify(nativeCatalog(false)), {
      headers: { "content-type": "application/json" },
    })) as never);
});

afterEach(() => {
  fetchSpy.mockRestore();
  gateSpy.mockRestore();
  if (savedEnvironment.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedEnvironment.codexHome;
  if (savedEnvironment.commanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = savedEnvironment.commanderHome;
  if (savedEnvironment.cli === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = savedEnvironment.cli;
  if (savedEnvironment.path === undefined) delete process.env.PATH;
  else process.env.PATH = savedEnvironment.path;
  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  resetNativeLiveCatalogStateForTests();
  rmSync(home, { recursive: true, force: true });
});

function runtimeFixture(directory: string, catalog: RawCatalog | string, version = "0.150.0") {
  const cli = createCodexRuntimeFixture(directory, { version, catalog });
  if (process.platform === "win32") {
    // Keep the 16-row fixture outside cmd.exe's inline command-length limit.
    writeFileSync(join(directory, "bundled-template.json"), typeof catalog === "string" ? catalog : JSON.stringify(catalog));
    writeFileSync(cli, [
      "@echo off",
      'if "%~1"=="--version" (',
      `  echo codex-cli ${version}`,
      ') else if "%~1"=="debug" if "%~2"=="models" if "%~3"=="--bundled" (',
      '  type "%~dp0bundled-template.json"',
      ")",
    ].join("\r\n"));
  }
  return cli;
}

function setup(options: { custom?: boolean; seed?: boolean; signedIn?: boolean } = {}) {
  const bundled = nativeCatalog(true);
  const cli = runtimeFixture(home, bundled);
  const runtime = { command: cli, version: "0.150.0", source: "environment" as const };
  process.env.CODEX_CLI_PATH = cli;
  persistCodexRuntime(runtime, { configDir: home });
  const catalogName = options.custom ? "custom-catalog.json" : "codexcommander-catalog.json";
  const catalogPath = join(home, catalogName);
  writeFileSync(join(home, "config.toml"), `model_catalog_json = "${catalogName}"\n`);
  if (options.seed !== false) {
    writeFileSync(catalogPath, JSON.stringify(nativeCatalog(false)));
  }
  if (options.signedIn !== false) {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: { access_token: "fixture-token", account_id: "fixture-account" },
    }));
  }
  const defaults = getDefaultConfig();
  const config: CodexCommanderConfig = {
    ...defaults,
    providers: {
      openai: { ...defaults.providers.openai!, liveModels: false },
      fixture: {
        adapter: "openai-chat",
        baseUrl: "https://fixture.invalid/v1",
        models: routedIds,
        liveModels: false,
      },
    },
    subagentModels: ["gpt-5.5", "fixture/worker-0", "fixture/worker-1", "fixture/worker-2", "fixture/worker-3"]
      .map(model => ({ model })),
  };
  saveConfig(config);
  return { bundled, cli, runtime, catalogPath, config };
}

function snapshot(path: string) {
  return { bytes: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs };
}

function assertMetadata(path: string, instructions: string, liveNative = true) {
  const rows = JSON.parse(readFileSync(path, "utf8")).models as RawEntry[];
  expect(rows).toHaveLength(211);
  const routed = rows.filter(row => String(row.slug).includes("/"));
  expect(routed).toHaveLength(195);
  for (const row of routed) {
    expect(row.base_instructions).toBe(instructions);
    expect(row.shell_type).toBe("unified_exec");
    expect(row.include_apps_usage_instructions).toBe(false);
    expect(row.include_plugin_usage_instructions).toBe(false);
    expect(row.supports_reasoning_effort_updates).toBe(true);
    expect(row.node_repl_auto_review_required).toBe(true);
  }
  if (liveNative) {
    for (const row of rows.filter(row => !String(row.slug).includes("/"))) {
      expect(row.supports_experimental_context).toBe(false);
      expect(row.base_instructions).toBe("Live native instructions");
    }
  }
}

async function assertUnchanged(config: CodexCommanderConfig, path: string) {
  const before = snapshot(path);
  const cachePath = join(home, "models_cache.json");
  const beforeCache = snapshot(cachePath);
  const result = await refreshCodexModelCatalog(config);
  expect(result.catalogDisposition?.status).toBe("committed");
  expect(result.catalogWritten).toBe(false);
  expect(result.cacheSynced).toBe(false);
  expect(snapshot(path)).toEqual(before);
  expect(snapshot(cachePath)).toEqual(beforeCache);
}

test("default refresh keeps all catalog metadata stable across cold, warm, expired and failed bundled probes", async () => {
  const { bundled, cli, runtime, catalogPath, config } = setup();
  expect((await refreshCodexModelCatalog(config)).catalogDisposition?.status).toBe("committed");
  assertMetadata(catalogPath, "Bundled native instructions");
  await assertUnchanged(config, catalogPath);

  setBundledCatalogCacheForTests(runtime, bundled, { expiresAt: 0 });
  await assertUnchanged(config, catalogPath);
  assertMetadata(catalogPath, "Bundled native instructions");

  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  resetNativeLiveCatalogStateForTests();
  await assertUnchanged(config, catalogPath);
  assertMetadata(catalogPath, "Bundled native instructions");

  setBundledCatalogCacheForTests(runtime, bundled, { expiresAt: 0 });
  runtimeFixture(home, "not-json");
  await assertUnchanged(config, catalogPath);
  assertMetadata(catalogPath, "Bundled native instructions");

  const changedBundle = nativeCatalog(true, "Updated bundled instructions");
  runtimeFixture(home, changedBundle);
  setBundledCatalogCacheForTests(runtime, bundled, { expiresAt: 0 });
  expect((await refreshCodexModelCatalog(config)).catalogWritten).toBe(true);
  assertMetadata(catalogPath, "Updated bundled instructions");
  await assertUnchanged(config, catalogPath);
  expect(existsSync(cli)).toBe(true);
});

test("a warm bundled memo preserves an existing custom catalog's template", async () => {
  const { catalogPath, config } = setup({ custom: true, signedIn: false });
  const custom = nativeCatalog(true, "Custom native instructions");
  writeFileSync(catalogPath, JSON.stringify(custom));
  expect(loadBundledCodexCatalog()).not.toBeNull();
  await refreshCodexModelCatalog(config);
  assertMetadata(catalogPath, "Custom native instructions", false);
  await assertUnchanged(config, catalogPath);
});

for (const custom of [false, true]) {
  test(`a ${custom ? "custom" : "default"} catalog without valid disk sources bootstraps from bundled metadata`, async () => {
    const { catalogPath, config } = setup({ custom, seed: false, signedIn: false });
    expect((await refreshCodexModelCatalog(config)).catalogDisposition?.status).toBe("committed");
    assertMetadata(catalogPath, "Bundled native instructions", false);
    await assertUnchanged(config, catalogPath);
  });
}

test("a failed probe for a different runtime cannot reuse the old bundled memo", () => {
  setup({ signedIn: false });
  expect(loadBundledCodexCatalog()).not.toBeNull();
  const directory = join(home, "other-runtime");
  mkdirSync(directory);
  const other = runtimeFixture(directory, "not-json", "0.151.0");
  process.env.CODEX_CLI_PATH = other;
  const runtime = { command: other, version: "0.151.0", source: "environment" as const };
  persistCodexRuntime(runtime, { configDir: home });
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] }, { discoverAlternatives: false });
  expect(loadBundledCodexCatalog()).toBeNull();
});

test("a first bundled probe failure keeps the established observed catalog fallback", async () => {
  const { cli, runtime, catalogPath, config } = setup();
  runtimeFixture(home, "not-json");
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] }, { discoverAlternatives: false });
  expect((await refreshCodexModelCatalog(config)).catalogDisposition?.status).toBe("committed");
  const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as RawEntry[];
  expect(rows).toHaveLength(211);
  for (const row of rows) expect(row.base_instructions).toBe("Live native instructions");
  await assertUnchanged(config, catalogPath);
  expect(existsSync(cli)).toBe(true);
});

test("retained live metadata and absent native capability fields survive unchanged refreshes", async () => {
  const { catalogPath, config } = setup();
  const live = nativeCatalog(false);
  delete live.models![0]!.supports_experimental_context;
  fetchSpy.mockImplementation((async () => new Response(JSON.stringify(live), {
    headers: { "content-type": "application/json" },
  })) as never);
  await refreshCodexModelCatalog(config);
  const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as RawEntry[];
  expect(rows.find(row => row.slug === nativeSlugs[0])).not.toHaveProperty("supports_experimental_context");
  fetchSpy.mockImplementation((async () => { throw new Error("fixture offline"); }) as never);
  resetNativeLiveCatalogStateForTests();
  await assertUnchanged(config, catalogPath);
});

test("management convergence uses the same settled bundled template", async () => {
  const { bundled, runtime, catalogPath, config } = setup();
  writeFileSync(join(home, "config.toml"), [
    "# Auto-injected by CodexCommander",
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    'model_catalog_json = "codexcommander-catalog.json"',
    "",
  ].join("\n"));
  await refreshCodexModelCatalog(config);
  setBundledCatalogCacheForTests(runtime, bundled, { expiresAt: 0 });
  const before = snapshot(catalogPath);
  const result = await createManagementConvergeCodex(config)(createCatalogConvergeRequest({ deadlineMs: 1_000 }));
  expect(result.catalogRefresh.status).toBe("committed");
  expect(result.changed).toBe(false);
  expect(snapshot(catalogPath)).toEqual(before);
  assertMetadata(catalogPath, "Bundled native instructions");
});

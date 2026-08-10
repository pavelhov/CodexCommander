/**
 * /api/injection-model effort support (implementation contract):
 * PUT validates the reasoning effort against the Codex ladder, clears it with the
 * model, and GET surfaces `{ effort, efforts }` next to the existing model picker.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigPath, getDefaultConfig, loadConfig } from "../src/config";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import { handleManagementAPI } from "../src/server/management-api";
import { CODEX_REASONING_LEVELS } from "../src/reasoning-effort";
import type { CodexCommanderConfig } from "../src/types";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

setDefaultTimeout(30_000);

const savedHome = process.env.CODEXCOMMANDER_HOME;
const savedCodexCliPath = process.env.CODEX_CLI_PATH;
let tempHome: string | null = null;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ccx-injection-model-codex-");
  process.env.CODEX_CLI_PATH = createCodexRuntimeFixture(isolatedCodexHome.path);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = savedHome;
  if (savedCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = savedCodexCliPath;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (tempHome) { rmSync(tempHome, { recursive: true, force: true }); tempHome = null; }
});

function isolatedHome(): void {
  tempHome = mkdtempSync(join(tmpdir(), "ccx-injection-"));
  process.env.CODEXCOMMANDER_HOME = tempHome;
}

function makeConfig(overrides: Partial<CodexCommanderConfig> = {}): CodexCommanderConfig {
  return { ...getDefaultConfig(), ...overrides };
}

async function put(config: CodexCommanderConfig, body: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/injection-model", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {
    // This file changes CODEX_HOME after static imports. Keep ordinary route
    // tests off the developer's native config; the subprocess regression below
    // loads the real reconciler only after installing its isolated homes.
    reconcileManagementNativeSubagentDefaults: async () => ({
      status: "skipped",
      reason: "routing-not-owned",
    }),
  });
  expect(res).not.toBeNull();
  return res!;
}

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function runManagedDefaultsSave(codexHome: string, commanderHome: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const script = `
    const { writeFileSync, readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { getDefaultConfig, loadConfig, saveConfigPreservingClaudeCode } = require("./src/config");
    const { injectCodexConfig, getCodexRoutingKind } = require("./src/codex/inject");
    const { handleManagementAPI } = require("./src/server/management-api");
    const { ManagementRequest } = require("./tests/helpers/management-auth");

    const config = {
      ...getDefaultConfig(),
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "high",
    };
    saveConfigPreservingClaudeCode(config);
    writeFileSync(join(process.env.CODEX_HOME, "codexcommander-catalog.json"), '{"models":[]}\\n');
    const initial = await injectCodexConfig(10100, config);
    if (!initial.success || getCodexRoutingKind() !== "codexcommander-local") {
      throw new Error("failed to establish managed routing: " + JSON.stringify(initial));
    }

    const req = new ManagementRequest("http://localhost/api/injection-model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncCodexSubagentDefaults: true }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), config, {
      loadConfigForCatalogActivation: loadConfig,
      codexRoutingKindForActivation: getCodexRoutingKind,
      catalogArtifactProofForActivation: () => "current",
      collectCodexAppServerCatalogState: () => ({
        state: "stale",
        catalogMtimeMs: Date.now(),
        processes: [{ pid: 4242, commandLine: "codex app-server", startedAtMs: 1 }],
      }),
    }, "confirmed-gui-session");
    console.log(JSON.stringify({
      status: response.status,
      body: await response.json(),
      nativeConfig: readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8"),
    }));
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEXCOMMANDER_HOME: commanderHome,
    },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function runUnownedDefaultsSave(
  codexHome: string,
  commanderHome: string,
  mode: "off" | "native" | "external",
): { status: number; stdout: string; stderr: string } {
  const script = `
    const { readFileSync } = require("node:fs");
    const { getDefaultConfig, saveConfigPreservingClaudeCode } = require("./src/config");
    const { getCodexRoutingKind } = require("./src/codex/inject");
    const { handleManagementAPI } = require("./src/server/management-api");
    const { ManagementRequest } = require("./tests/helpers/management-auth");
    const config = {
      ...getDefaultConfig(),
      ...(process.env.TEST_MODE === "off" ? { clientIntegrations: { codex: false } } : {}),
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "high",
    };
    saveConfigPreservingClaudeCode(config);
    const nativePath = process.env.CODEX_HOME + "/config.toml";
    const before = readFileSync(nativePath, "utf8");
    const req = new ManagementRequest("http://localhost/api/injection-model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncCodexSubagentDefaults: true }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), config);
    console.log(JSON.stringify({
      status: response.status,
      body: await response.json(),
      before,
      after: readFileSync(nativePath, "utf8"),
      routingKind: getCodexRoutingKind(),
    }));
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEXCOMMANDER_HOME: commanderHome,
      TEST_MODE: mode,
    },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

describe("/api/injection-model reasoning effort", () => {
  test("PUT model+effort roundtrips; GET surfaces effort + ladder", async () => {
    isolatedHome();
    const config = makeConfig();
    const putRes = await put(config, { model: "openai/gpt-5.6-sol", effort: "xhigh" });
    expect(await putRes.json()).toEqual({ ok: true, multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: false, model: "openai/gpt-5.6-sol", effort: "xhigh", prompt: null });
    expect(config.injectionEffort).toBe("xhigh");

    const getRes = await handleManagementAPI(
      new Request("http://localhost/api/injection-model"), new URL("http://localhost/api/injection-model"), config,
    );
    const data = await getRes!.json() as { model: string | null; effort: string | null; efforts: string[] };
    expect(data.model).toBe("openai/gpt-5.6-sol");
    expect(data.effort).toBe("xhigh");
    expect(data.efforts).toEqual(CODEX_REASONING_LEVELS.map(l => l.effort));
  });

  test("prompt key: set, keep-when-absent, clear, reject non-string", async () => {
    isolatedHome();
    const config = makeConfig();
    const setRes = await put(config, { model: "openai/gpt-5.6-sol", prompt: "RULES {{model}} {{roster}}" });
    expect(((await setRes.json()) as { prompt: string | null }).prompt).toBe("RULES {{model}} {{roster}}");
    expect(config.injectionPrompt).toBe("RULES {{model}} {{roster}}");
    // absent key leaves it unchanged
    await put(config, { model: "openai/gpt-5.6-sol", effort: "xhigh" });
    expect(config.injectionPrompt).toBe("RULES {{model}} {{roster}}");
    // null clears
    await put(config, { model: "openai/gpt-5.6-sol", prompt: null });
    expect(config.injectionPrompt).toBeUndefined();
    // non-string rejected
    const bad = await put(config, { model: "openai/gpt-5.6-sol", prompt: 42 });
    expect(bad.status).toBe(400);
  });

  test("invalid effort is rejected with 400 and leaves config untouched", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "high" });
    const res = await put(config, { model: "anthropic/claude-sonnet-5", effort: "turbo" });
    expect(res.status).toBe(400);
    expect(config.injectionModel).toBe("openai/gpt-5.6-sol");
    expect(config.injectionEffort).toBe("high");
  });

  test("clearing the effort alone keeps the model", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "max" });
    const res = await put(config, { model: "openai/gpt-5.6-sol", effort: null });
    expect(await res.json()).toEqual({ ok: true, multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: false, model: "openai/gpt-5.6-sol", effort: null, prompt: null });
    expect(config.injectionEffort).toBeUndefined();
  });

  test("clearing the model clears the effort too", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "max" });
    const res = await put(config, { model: null });
    expect(await res.json()).toEqual({ ok: true, multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: false, model: null, effort: null, prompt: null });
    expect(config.injectionModel).toBeUndefined();
    expect(config.injectionEffort).toBeUndefined();
  });

  test("effort key absent leaves a stored effort unchanged while the model stays", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "ultra" });
    const res = await put(config, { model: "anthropic/claude-sonnet-5" });
    expect(await res.json()).toEqual({ ok: true, multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: false, model: "anthropic/claude-sonnet-5", effort: "ultra", prompt: null });
  });

  test("GET round-trips combo aliases and excludes an alias-disabled combo", async () => {
    const alias = "deepseek-v4-flash";
    const config = makeConfig({
      defaultProvider: "a",
      providers: {
        a: {
          adapter: "openai-chat",
          baseUrl: "https://a.example/v1",
          liveModels: false,
          models: ["m1"],
          modelContextWindows: { m1: 128_000 },
        },
      },
      combos: {
        free: { alias, targets: [{ provider: "a", model: "m1" }] },
      },
      injectionModel: alias,
    });

    let response = await handleManagementAPI(
      new Request("http://localhost/api/injection-model"), new URL("http://localhost/api/injection-model"), config,
    );
    let data = await response!.json() as {
      model: string | null;
      available: Array<{ provider: string; model: string; namespaced: string }>;
    };
    expect(data.model).toBe(alias);
    expect(data.available).toContainEqual({ provider: "combo", model: "free", namespaced: alias });
    expect(data.available.some(model => model.namespaced === "combo/free")).toBe(false);

    config.disabledModels = [alias];
    response = await handleManagementAPI(
      new Request("http://localhost/api/injection-model"), new URL("http://localhost/api/injection-model"), config,
    );
    data = await response!.json() as typeof data;
    expect(data.available.some(model => model.namespaced === alias)).toBe(false);
  }, 15_000);
});

describe("/api/injection-model guidance kill switch + partial update", () => {
  test.each([
    ["off", 'model = "gpt-5.6-terra"\n', "integration-disabled", "native"],
    ["native", 'model = "gpt-5.6-terra"\n', "routing-not-owned", "native"],
    ["external", 'model_provider = "external"\n\n[model_providers.external]\nbase_url = "https://example.test/v1"\n', "routing-not-owned", "custom-remote"],
  ] as const)("%s Save preserves unowned native config", (mode, nativeConfig, reason, routingKind) => {
    const codexHome = mkdtempSync(join(tmpdir(), `ccx-injection-${mode}-codex-`));
    const commanderHome = mkdtempSync(join(tmpdir(), `ccx-injection-${mode}-home-`));
    try {
      writeFileSync(join(codexHome, "config.toml"), nativeConfig, "utf8");
      const result = runUnownedDefaultsSave(codexHome, commanderHome, mode);
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as {
        status: number;
        body: { nativeDefaultsRefresh: { status: string; reason: string } };
        before: string;
        after: string;
        routingKind: string;
      };
      expect(output.status).toBe(200);
      expect(output.body.nativeDefaultsRefresh).toEqual({ status: "skipped", reason });
      expect(output.after).toBe(output.before);
      expect(output.routingKind).toBe(routingKind);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(commanderHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("managed Save reconciles native defaults and reports reload-required without signaling", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-injection-managed-codex-"));
    const commanderHome = mkdtempSync(join(tmpdir(), "ccx-injection-managed-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.6-terra"\n', "utf8");
      const result = runManagedDefaultsSave(codexHome, commanderHome);
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as {
        status: number;
        body: {
          nativeDefaultsRefresh: { status: string };
          activation: {
            workers: { status: string };
            apply: { required: boolean; allowed: boolean; reason: string };
          };
        };
        nativeConfig: string;
      };
      expect(output.status).toBe(200);
      expect(output.body.nativeDefaultsRefresh).toMatchObject({ status: "reconciled" });
      expect(output.nativeConfig).toContain("# Managed by CodexCommander: native subagent defaults table");
      expect(output.nativeConfig).toContain('default_subagent_model = "gpt-5.6-terra"');
      expect(output.nativeConfig).toContain('default_subagent_reasoning_effort = "high"');
      expect(output.body.activation.workers.status).toBe("reload_required");
      expect(output.body.activation.apply).toMatchObject({
        required: true,
        allowed: true,
      });
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(commanderHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("flag-only PUT preserves model, effort, and prompt in memory and on disk", async () => {
    isolatedHome();
    const config = makeConfig({
      multiAgentGuidanceEnabled: true,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{model}} {{roster}}",
    });

    const response = await put(config, { multiAgentGuidanceEnabled: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      multiAgentGuidanceEnabled: false,
      syncCodexSubagentDefaults: false,
      model: "gpt-5.6-terra",
      effort: "max",
      prompt: "RULES {{model}} {{roster}}",
    });
    expect(config).toMatchObject({
      multiAgentGuidanceEnabled: false,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{model}} {{roster}}",
    });
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as CodexCommanderConfig;
    expect(persisted).toMatchObject({
      multiAgentGuidanceEnabled: false,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{model}} {{roster}}",
    });
  });

  test("explicit model clear clears effort but preserves prompt and guidance flag", async () => {
    isolatedHome();
    const config = makeConfig({
      multiAgentGuidanceEnabled: false,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{roster}}",
    });

    const response = await put(config, { model: null });
    expect(await response.json()).toEqual({
      ok: true,
      multiAgentGuidanceEnabled: false,
      syncCodexSubagentDefaults: false,
      model: null,
      effort: null,
      prompt: "RULES {{roster}}",
    });
    expect(config.injectionModel).toBeUndefined();
    expect(config.injectionEffort).toBeUndefined();
    expect(config.injectionPrompt).toBe("RULES {{roster}}");
    expect(config.multiAgentGuidanceEnabled).toBe(false);
  });

  test("subagent-default sync is opt-in, model-bound, partial, and normalized on disk", async () => {
    isolatedHome();
    const config = makeConfig();

    let response = await handleManagementAPI(
      new Request("http://localhost/api/injection-model"),
      new URL("http://localhost/api/injection-model"),
      config,
    );
    expect(await response!.json()).toMatchObject({
      syncCodexSubagentDefaults: false,
      model: null,
    });

    response = await put(config, { syncCodexSubagentDefaults: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "syncCodexSubagentDefaults requires an injection model" });
    expect(config.syncCodexSubagentDefaults).toBeUndefined();
    expect(existsSync(getConfigPath())).toBe(false);

    response = await put(config, { syncCodexSubagentDefaults: "true" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "syncCodexSubagentDefaults must be a boolean" });

    response = await put(config, {
      model: "gpt-5.6-terra",
      effort: "max",
      syncCodexSubagentDefaults: true,
    });
    expect(await response.json()).toMatchObject({
      syncCodexSubagentDefaults: true,
      model: "gpt-5.6-terra",
      effort: "max",
    });
    expect(config.syncCodexSubagentDefaults).toBe(true);

    response = await put(config, { effort: "high" });
    expect(await response.json()).toMatchObject({ syncCodexSubagentDefaults: true, effort: "high" });
    expect(config.syncCodexSubagentDefaults).toBe(true);

    response = await put(config, { syncCodexSubagentDefaults: false });
    expect(await response.json()).toMatchObject({ syncCodexSubagentDefaults: false, model: "gpt-5.6-terra" });
    expect(config.syncCodexSubagentDefaults).toBeUndefined();
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8"))).not.toHaveProperty("syncCodexSubagentDefaults");
  });

  test("clearing the injection model also clears subagent-default sync", async () => {
    isolatedHome();
    const config = makeConfig({
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      syncCodexSubagentDefaults: true,
    });

    const response = await put(config, { model: null });
    expect(await response.json()).toMatchObject({
      syncCodexSubagentDefaults: false,
      model: null,
      effort: null,
    });
    expect(config.injectionModel).toBeUndefined();
    expect(config.injectionEffort).toBeUndefined();
    expect(config.syncCodexSubagentDefaults).toBeUndefined();
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8"))).not.toHaveProperty("syncCodexSubagentDefaults");
  });

  test("clearing model with sync on and unsupported inherited effort returns 200 and clears all", async () => {
    isolatedHome();
    const config = makeConfig({
      injectionModel: "legacy/model",
      injectionEffort: "provider-specific",
      syncCodexSubagentDefaults: true,
    });

    const response = await put(config, { model: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      syncCodexSubagentDefaults: false,
      model: null,
      effort: null,
    });
    expect(config.injectionModel).toBeUndefined();
    expect(config.injectionEffort).toBeUndefined();
    expect(config.syncCodexSubagentDefaults).toBeUndefined();
  });

  test("a latent model-less sync flag stays off during a model-only partial update", async () => {
    isolatedHome();
    const config = makeConfig({ syncCodexSubagentDefaults: true });

    let response = await handleManagementAPI(
      new Request("http://localhost/api/injection-model"),
      new URL("http://localhost/api/injection-model"),
      config,
    );
    expect(await response!.json()).toMatchObject({
      syncCodexSubagentDefaults: false,
      model: null,
    });

    response = await put(config, { model: "gpt-5.6-terra" });
    expect(await response.json()).toMatchObject({
      syncCodexSubagentDefaults: false,
      model: "gpt-5.6-terra",
    });
    expect(config.syncCodexSubagentDefaults).toBeUndefined();
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8"))).not.toHaveProperty("syncCodexSubagentDefaults");
  });

  test("rejects a whitespace-only model without mutating existing settings", async () => {
    isolatedHome();
    const config = makeConfig({
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "high",
      syncCodexSubagentDefaults: true,
    });
    const before = structuredClone(config);

    const response = await put(config, { model: "   " });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "model must be a nonblank string or null" });
    expect(config).toEqual(before);
    expect(existsSync(getConfigPath())).toBe(false);
  });

  test("rejects an old raw nested selector without mutating existing settings", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "gpt-5.6-terra", injectionEffort: "high" });
    const before = structuredClone(config);

    const response = await put(config, { model: "openrouter/anthropic/claude-sonnet-5" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "model must be a canonical selector or null" });
    expect(config).toEqual(before);
  });

  test("rejects native-default opt-in when a legacy stored effort is not Codex-supported", async () => {
    isolatedHome();
    const config = makeConfig({
      injectionModel: "legacy/model",
      injectionEffort: "provider-specific",
    });
    const before = structuredClone(config);

    const response = await put(config, { syncCodexSubagentDefaults: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "syncCodexSubagentDefaults requires a supported Codex reasoning effort",
    });
    expect(config).toEqual(before);
    expect(existsSync(getConfigPath())).toBe(false);
  });

  test.each([
    ["null", null],
    ["array", []],
    ["scalar", "text"],
  ] as const)("rejects top-level %s before any partial-update key check", async (_label, body) => {
    isolatedHome();
    const config = makeConfig({
      multiAgentGuidanceEnabled: true,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "high",
      injectionPrompt: "RULES",
    });
    const before = structuredClone(config);

    const response = await put(config, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "body must be a JSON object" });
    expect(config).toEqual(before);
    expect(existsSync(getConfigPath())).toBe(false);
  });

  test("guidance flag and injection settings survive save, catalog sync, and reload", async () => {
    isolatedHome();
    const config = makeConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      multiAgentGuidanceEnabled: true,
      multiAgentMode: "v2",
      subagentModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{roster}}",
    });
    await put(config, { multiAgentGuidanceEnabled: false });

    let flagSeenBySync: boolean | undefined;
    await refreshCodexModelCatalog(config, {
      prepareConfigGeneration: () => {},
      captureCatalogAdmissionSnapshot: syncedConfig => {
        flagSeenBySync = syncedConfig.multiAgentGuidanceEnabled;
        return {} as never;
      },
      convergeCodexCatalog: async () => ({
        changed: false,
        catalogRefresh: { status: "committed", changed: false, degraded: false, notices: [] },
        projection: {
          admittedGeneration: { value: 0 },
          admittedConfigAuthority: {
            generation: { value: 0 },
            semanticIdentity: "semantic",
            contentIdentity: "content",
          },
          added: 0,
          path: join(tempHome!, "missing-catalog.json"),
          catalogWritten: false,
          cacheSynced: false,
          comboOmissions: [],
          catalogQuality: "native-only",
          rehydrated: 0,
        },
      }),
      existsSync: () => false,
    });
    expect(flagSeenBySync).toBe(false);
    expect(config.multiAgentMode).toBe("v2");

    const reloaded = loadConfig();
    expect(reloaded).toMatchObject({
      multiAgentGuidanceEnabled: false,
      multiAgentMode: "v2",
      subagentModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{roster}}",
    });
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";

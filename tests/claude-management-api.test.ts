import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import * as systemEnv from "../src/server/system-env";
import type { CodexCommanderConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";

// Full-suite Windows load: startServer + multi-PUT management flows often exceed bun's
// default 5s per-test budget (same flake class as 810fa115 / kiro-oauth).
setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let previousClaudeConfigDir: string | undefined;
let previousDesktopConfigDir: string | undefined;
let previousCodexCliPath: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

const originalPlatform = process.platform;

beforeEach(() => {
  previousHome = process.env.CODEXCOMMANDER_HOME;
  previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  previousDesktopConfigDir = process.env.CODEXCOMMANDER_CLAUDE_DESKTOP_CONFIG_DIR;
  previousCodexCliPath = process.env.CODEX_CLI_PATH;
  isolatedCodexHome = installIsolatedCodexHome("ccx-claude-mgmt-");
  process.env.CODEX_CLI_PATH = createCodexRuntimeFixture(isolatedCodexHome.path);
  testDir = mkdtempSync(join(tmpdir(), "ccx-claude-mgmt-"));
  process.env.CODEXCOMMANDER_HOME = testDir;
  // These API tests intentionally toggle agent injection off. Never let that
  // prune the developer's real ~/.claude/agents directory.
  process.env.CLAUDE_CONFIG_DIR = join(testDir, "claude");
  process.env.CODEXCOMMANDER_CLAUDE_DESKTOP_CONFIG_DIR = join(testDir, "claude-desktop");
  saveConfig({
    port: 0,
    multiAgentGuidanceEnabled: true,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, liveModels: false, models: ["test-model"] },
    },
  } as CodexCommanderConfig);
});

afterEach(() => {
  setPlatform(originalPlatform);
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  if (previousDesktopConfigDir === undefined) delete process.env.CODEXCOMMANDER_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.CODEXCOMMANDER_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
  if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCodexCliPath;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

test("GET /api/claude-code returns defaults + available + aliases", async () => {
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.enabled).toBe(true);
    expect(d).not.toHaveProperty("model");
    expect(d.smallFastModel).toBe("");
    expect(d.modelMap).toEqual({});
    expect(d.available).toContain("mock/test-model");
    // Aliases preview uses the readable CLI-surface family (implementation contract / audit 051 #2).
    expect(d.aliases.some((a: { id: string }) => a.id === "claude-ccx2-mock--test-model")).toBe(true);
    expect(typeof d.port).toBe("number");
  } finally {
    await server.stop(true);
  }
});

test("PUT round-trips settings and persists to config", async () => {
  const server = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        smallFastModel: " mock/test-model ",
        modelMap: { "claude-sonnet-4-5": "mock/test-model" },
      }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as Record<string, unknown>;
    expect(putBody.ok).toBe(true);
    expect(putBody.enabled).toBe(false);

    const persisted = loadConfig();
    expect(persisted.claudeCode).toEqual({
      enabled: false,
      smallFastModel: "mock/test-model",
      modelMap: { "claude-sonnet-4-5": "mock/test-model" },
    });

    // Clearing the helper slot with "" deletes it; partial PUT leaves other fields alone.
    const clear = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ smallFastModel: "" }),
    });
    expect(clear.status).toBe(200);
    const after = loadConfig();
    expect(after.claudeCode?.smallFastModel).toBeUndefined();
    expect(after.claudeCode?.enabled).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("PUT round-trips three-state authMode", async () => {
  const server = startServer(0);
  try {
    // An absent config key is AUTO, not subscription: the old coercion turned every
    // save into a sticky manual subscription.
    let get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("auto");

    // proxy persists to config and reads back.
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "proxy" }),
    });
    expect(put.status).toBe(200);
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("proxy");
    expect(loadConfig().claudeCode?.authMode).toBe("proxy");

    // subscription now stores the literal so an explicit choice survives auth changes.
    const back = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "subscription" }),
    });
    expect(back.status).toBe(200);
    expect(loadConfig().claudeCode?.authMode).toBe("subscription");
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("subscription");

    // "auto" is the return path: it deletes the key so detection drives the mode again.
    const auto = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "auto" }),
    });
    expect(auto.status).toBe(200);
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("auto");
  } finally {
    await server.stop(true);
  }
});

test("GET exposes the resolved marker mode and its provenance", async () => {
  const server = startServer(0);
  try {
    const get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(["proxy", "subscription"]).toContain(get.markerMode);
    expect(["manual", "auto-present", "auto-absent", "auto-unknown"]).toContain(get.authModeOrigin);
    expect(typeof get.admissionKeyActive).toBe("boolean");
    // The badge must say it is daemon-side: a terminal-exported key is invisible here.
    expect(get.detectionScope).toBe("daemon");
  } finally {
    await server.stop(true);
  }
});

// The auto-kill regression: saving an unrelated field must not convert auto into a
// sticky manual mode (implementation contract §3).
test("an unrelated PUT leaves an auto config on auto", async () => {
  const server = startServer(0);
  try {
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(200);
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
    const get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("auto");
  } finally {
    await server.stop(true);
  }
});

test("auto survives a restart", async () => {
  const first = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", first.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "auto", enabled: true }),
    });
    expect(put.status).toBe(200);
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
  } finally {
    await first.stop(true);
  }

  const second = startServer(0);
  try {
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
    const get = await fetch(new URL("/api/claude-code", second.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("auto");
  } finally {
    await second.stop(true);
  }
});

test("toggling Claude on does not pin a fresh install to subscription", async () => {
  const first = startServer(0);
  try {
    await fetch(new URL("/api/claude-code", first.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
  } finally {
    await first.stop(true);
  }
  const second = startServer(0);
  try {
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
  } finally {
    await second.stop(true);
  }
});

test("PUT rejects an unknown authMode value", async () => {
  const server = startServer(0);
  try {
    const bad = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "passthrough" }),
    });
    expect(bad.status).toBe(400);
  } finally {
    await server.stop(true);
  }
});

test("PUT rejects invalid authMode values (invalid string + non-string)", async () => {
  const server = startServer(0);
  try {
    for (const bad of ["x", 42]) {
      const r = await fetch(new URL("/api/claude-code", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authMode: bad }),
      });
      expect(r.status).toBe(400);
    }
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
  } finally {
    await server.stop(true);
  }
});

test("authMode-only PUT triggers system-env reconciliation (audit R2 #1)", async () => {
  const applySpy = spyOn(systemEnv, "applySystemEnvToggle").mockResolvedValue({ reverted: false, reason: "test" });
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "proxy" }), // no systemEnv field in the body
    });
    expect(r.status).toBe(200);
    expect(applySpy).toHaveBeenCalled();
  } finally {
    applySpy.mockRestore();
    await server.stop(true);
  }
});

test("Claude sidecar overrides round-trip, partially update, clear, and reject unknown backends", async () => {
  const server = startServer(0);
  const put = (body: unknown) => fetch(new URL("/api/claude-code", server.url), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    let response = await put({
      webSearchSidecar: { backend: "anthropic", model: "claude-search" },
      visionSidecar: { backend: "openai", model: "gpt-vision" },
    });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode).toMatchObject({
      webSearchSidecar: { backend: "anthropic", model: "claude-search" },
      visionSidecar: { backend: "openai", model: "gpt-vision" },
    });

    let get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.webSearchSidecar).toEqual({ backend: "anthropic", model: "claude-search" });
    expect(get.visionSidecar).toEqual({ backend: "openai", model: "gpt-vision" });

    // Nested partial updates preserve omitted fields and omitted sections.
    response = await put({ webSearchSidecar: { model: "claude-search-2" } });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode?.webSearchSidecar).toEqual({ backend: "anthropic", model: "claude-search-2" });
    expect(loadConfig().claudeCode?.visionSidecar).toEqual({ backend: "openai", model: "gpt-vision" });

    // null backend is the explicit Auto/inherit transition; empty model deletes only model.
    response = await put({
      webSearchSidecar: { backend: null },
      visionSidecar: { backend: null, model: "" },
    });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode?.webSearchSidecar).toEqual({ model: "claude-search-2" });
    expect(loadConfig().claudeCode?.visionSidecar).toBeUndefined();
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.webSearchSidecar).toEqual({ model: "claude-search-2" });
    expect(get.visionSidecar).toBeUndefined();

    // null and empty sections both clear the whole override.
    response = await put({ webSearchSidecar: null, visionSidecar: {} });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode?.webSearchSidecar).toBeUndefined();
    expect(loadConfig().claudeCode?.visionSidecar).toBeUndefined();

    await put({ webSearchSidecar: { backend: "openai", model: "stable" } });
    const beforeInvalid = loadConfig().claudeCode;
    for (const body of [
      { webSearchSidecar: { backend: "other" } },
      { visionSidecar: { backend: "other" } },
      { webSearchSidecar: [] },
    ]) {
      response = await put(body);
      expect(response.status).toBe(400);
      expect(loadConfig().claudeCode).toEqual(beforeInvalid);
    }
  } finally {
    await server.stop(true);
  }
});

test("PUT immediately restores generated agents after re-enable and roster changes", async () => {
  const server = startServer(0);
  const agentsDir = join(process.env.CLAUDE_CONFIG_DIR!, "agents");
  try {
    const enable = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ injectAgents: true }),
    });
    expect(enable.status).toBe(200);
    expect(readdirSync(agentsDir).some(name => name === "ccx-gpt-5-6-sol.md")).toBe(true);

    const disable = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ injectAgents: false }),
    });
    expect(disable.status).toBe(200);
    expect(readdirSync(agentsDir)).toEqual([]);

    const reenable = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ injectAgents: true }),
    });
    expect(reenable.status).toBe(200);
    expect(readdirSync(agentsDir).some(name => name === "ccx-gpt-5-6-sol.md")).toBe(true);

    const roster = await fetch(new URL("/api/subagent-models", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: ["gpt-5.6-terra"] }),
    });
    expect(roster.status).toBe(200);
    expect(readdirSync(agentsDir)).toEqual(["ccx-gpt-5-6-terra.md"]);
  } finally {
    await server.stop(true);
  }
});

test("PUT/GET round-trips auto-context (implementation contract 020)", async () => {
  const server = startServer(0);
  try {
    // Defaults: on, window null (GUI shows the 350000 placeholder).
    let get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.autoContext).toBe(true);
    expect(get.autoCompactWindow).toBeNull();
    expect(get.blockedSkills).toBeNull(); // null = built-in default (claude-api)

    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoContext: false, autoCompactWindow: 400_000, blockedSkills: ["claude-api", "my-skill"] }),
    });
    expect(put.status).toBe(200);
    let persisted = loadConfig();
    expect(persisted.claudeCode?.autoContext).toBe(false);
    expect(persisted.claudeCode?.autoCompactWindow).toBe(400_000);
    expect(persisted.claudeCode?.blockedSkills).toEqual(["claude-api", "my-skill"]);
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.autoContext).toBe(false);
    expect(get.autoCompactWindow).toBe(400_000);
    expect(get.blockedSkills).toEqual(["claude-api", "my-skill"]);

    // true drops the key (default-on); null resets the window to default.
    const clear = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoContext: true, autoCompactWindow: null, blockedSkills: null }),
    });
    expect(clear.status).toBe(200);
    persisted = loadConfig();
    expect(persisted.claudeCode?.autoContext).toBeUndefined();
    expect(persisted.claudeCode?.autoCompactWindow).toBeUndefined();
    expect(persisted.claudeCode?.blockedSkills).toBeUndefined();
  } finally {
    await server.stop(true);
  }
});

test("GET exposes contextWindows and the configured helper-model environment", async () => {
  const server = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ smallFastModel: " mock/other-model " }),
    });
    expect(put.status).toBe(200);
    const persisted = loadConfig();
    expect(persisted.claudeCode?.smallFastModel).toBe("mock/other-model");

    const get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, any>;
    expect(typeof get.contextWindows).toBe("object");
    expect(get.effectiveModelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("mock/other-model");
    expect(get.effectiveModelEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe("mock/other-model");
  } finally {
    await server.stop(true);
  }
});

test("PUT validation rejects bad shapes", async () => {
  const server = startServer(0);
  try {
    const cases: [Record<string, unknown>, string][] = [
      [{ enabled: "yes" }, "enabled must be a boolean"],
      [{ unsupportedSetting: true }, "unknown Claude Code setting: unsupportedSetting"],
      [{ autoContext: "on" }, "autoContext must be a boolean"],
      [{ injectAgents: "on" }, "injectAgents must be a boolean"],
      [{ blockedSkills: "claude-api" }, "blockedSkills must be an array of non-empty strings, or null"],
      [{ blockedSkills: [""] }, "blockedSkills must be an array of non-empty strings, or null"],
      [{ blockedSkills: [1] }, "blockedSkills must be an array of non-empty strings, or null"],
      [{ autoCompactWindow: 50_000 }, "autoCompactWindow must be an integer between 100000 and 1000000, or null"],
      [{ autoCompactWindow: 2_000_000 }, "autoCompactWindow must be an integer between 100000 and 1000000, or null"],
      [{ autoCompactWindow: 350_000.5 }, "autoCompactWindow must be an integer between 100000 and 1000000, or null"],
      [{ autoCompactWindow: "350000" }, "autoCompactWindow must be an integer between 100000 and 1000000, or null"],
      [{ modelMap: ["a"] }, "modelMap must be an object of string->string, or null"],
      [{ modelMap: { "": "x" } }, "modelMap entries must be non-empty strings"],
      [{ modelMap: { a: "" } }, "modelMap entries must be non-empty strings"],
      [{ modelMap: { a: 3 } }, "modelMap entries must be non-empty strings"],
    ];
    for (const [body, error] of cases) {
      const r = await fetch(new URL("/api/claude-code", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe(error);
    }
    expect(loadConfig().claudeCode).toBeUndefined(); // nothing persisted on rejects
  } finally {
    await server.stop(true);
  }
});

test("GET /api/claude-code reports Auto-connect support on Darwin", async () => {
  setPlatform("darwin");
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.autoConnectSupported).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("GET /api/claude-code reports Auto-connect unsupported outside Darwin", async () => {
  saveConfig({
    ...loadConfig(),
    claudeCode: { systemEnv: true },
  } as CodexCommanderConfig);
  setPlatform("linux");
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.systemEnv).toBe(true);              // raw stored preference
    expect(d.autoConnectSupported).toBe(false);  // effective capability
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop profile GET, PUT and apply round-trip four-family assignments", async () => {
  const server = startServer(0);
  try {
    const initial = await fetch(new URL("/api/claude-desktop", server.url)).then(r => r.json()) as Record<string, any>;
    expect(initial.profile.version).toBe(1);
    expect(initial.models.some((model: { route: string }) => model.route === "mock/test-model")).toBe(true);
    expect(initial.profile.assignments["mock/test-model"].family).toBe("opus");

    const edited = structuredClone(initial.profile);
    edited.assignments["mock/test-model"].family = "sonnet";
    edited.defaults.opus = Object.keys(edited.assignments)
      .filter(route => edited.assignments[route].family === "opus")
      .sort()[0] ?? null;
    edited.defaults.sonnet = "mock/test-model";
    const put = await fetch(new URL("/api/claude-desktop", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: edited }),
    });
    expect(put.status).toBe(200);
    expect(loadConfig().claudeCode?.desktopProfile?.defaults.sonnet).toBe("mock/test-model");

    const alias = loadConfig().claudeCode?.desktopProfile?.assignments["mock/test-model"]?.alias;
    const discovery = await fetch(new URL("/v1/models?flavor=anthropic", server.url)).then(r => r.json()) as { data: Array<{ id: string }> };
    expect(discovery.data.some(model => model.id === alias)).toBe(true);

    const apply = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "static" }),
    });
    expect(apply.status).toBe(200);
    const result = await apply.json() as { path: string; applied: boolean };
    expect(result.applied).toBe(true);
    expect(result.path.startsWith(process.env.CODEXCOMMANDER_CLAUDE_DESKTOP_CONFIG_DIR!)).toBe(true);
    const appliedConfig = JSON.parse(readFileSync(result.path, "utf8")) as { inferenceGatewayBaseUrl: string };
    expect(appliedConfig.inferenceGatewayBaseUrl).toBe(new URL(server.url).origin);
  } finally {
    await server.stop(true);
  }
});

/*
 * Mechanism guard for #859: the apply route must keep building the alias
 * registry in the serving process. (The CLI→daemon delegation half is pinned
 * in tests/claude-desktop-cli.test.ts; this module-global registry is shared
 * in-process, so this test guards the route, not the delegation.)
 */
test("Claude Desktop apply installs the alias registry in the serving process (#859)", async () => {
  const { resolveDesktop3pAlias, activeDesktop3pAlias } = await import("../src/claude/desktop-3p");
  // A provider unique to this test: no prior test can have populated its
  // alias, so resolution proves THIS apply built the registry in-process.
  const seeded = loadConfig();
  seeded.providers = {
    ...seeded.providers,
    unique859: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model-x"] },
  };
  saveConfig(seeded);
  const server = startServer(0);
  try {
    const apply = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "static" }),
    });
    expect(apply.status).toBe(200);
    // Without another /v1/models discovery call, the serving process must now
    // decode the alias the CLI would have generated.
    const alias = activeDesktop3pAlias("unique859", "test-model-x");
    expect(resolveDesktop3pAlias(alias)).toBe("unique859/test-model-x");
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop apply honors the profile in the request body over daemon-stale config (#859)", async () => {
  const server = startServer(0);
  try {
    const current = await fetch(new URL("/api/claude-desktop", server.url)).then(r => r.json()) as Record<string, any>;
    const edited = structuredClone(current.profile);
    edited.assignments["mock/test-model"].family = "sonnet";
    edited.defaults.sonnet = "mock/test-model";
    edited.defaults.opus = Object.keys(edited.assignments)
      .filter(route => edited.assignments[route].family === "opus")
      .sort()[0] ?? null;

    const apply = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "static", profile: edited }),
    });
    expect(apply.status).toBe(200);
    // The delegated profile wins: persisted state shows sonnet, not the stale opus.
    expect(loadConfig().claudeCode?.desktopProfile?.assignments["mock/test-model"]?.family).toBe("sonnet");
    expect(loadConfig().claudeCode?.desktopProfile?.defaults.sonnet).toBe("mock/test-model");

    const badProfile = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "static", profile: { version: 2 } }),
    });
    expect(badProfile.status).toBe(400);
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop apply validates the mode body", async () => {
  const server = startServer(0);
  try {
    const missing = await fetch(new URL("/api/claude-desktop/apply", server.url), { method: "POST" });
    expect(missing.status).toBe(400);

    const bad = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "nonsense" }),
    });
    expect(bad.status).toBe(400);

    const hybrid = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "hybrid" }),
    });
    expect(hybrid.status).toBe(200);
    const result = await hybrid.json() as { path: string };
    const written = JSON.parse(readFileSync(result.path, "utf8")) as { modelDiscoveryEnabled: boolean };
    expect(written.modelDiscoveryEnabled).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop PUT rejects invalid JSON profile without mutating saved config", async () => {
  const server = startServer(0);
  try {
    const before = structuredClone(loadConfig());
    const put = await fetch(new URL("/api/claude-desktop", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: { version: 1, assignments: {}, defaults: { opus: "missing", fable: null, sonnet: null, haiku: null } } }),
    });
    expect(put.status).toBe(400);
    expect(loadConfig()).toEqual(before);
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop PUT retains but cannot move an unavailable route", async () => {
  const seeded = loadConfig();
  seeded.claudeCode = {
    desktopProfile: {
      version: 1,
      assignments: {
        "missing/old-model": { family: "opus", alias: "claude-opus-4-8-20260101" },
      },
      defaults: { opus: "missing/old-model", fable: null, sonnet: null, haiku: null },
    },
  };
  saveConfig(seeded);
  const server = startServer(0);
  try {
    const state = await fetch(new URL("/api/claude-desktop", server.url)).then(r => r.json()) as Record<string, any>;
    expect(state.models.find((model: { route: string }) => model.route === "missing/old-model")?.available).toBe(false);
    const edited = structuredClone(state.profile);
    edited.assignments["missing/old-model"].family = "haiku";
    edited.defaults.opus = Object.keys(edited.assignments).filter(route => edited.assignments[route].family === "opus").sort()[0] ?? null;
    edited.defaults.haiku = "missing/old-model";
    const put = await fetch(new URL("/api/claude-desktop", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: edited }),
    });
    expect(put.status).toBe(400);
    expect((await put.json() as { error: string }).error).toContain("사용할 수 없는 모델");
    expect(loadConfig().claudeCode?.desktopProfile?.assignments["missing/old-model"]?.family).toBe("opus");
  } finally {
    await server.stop(true);
  }
});

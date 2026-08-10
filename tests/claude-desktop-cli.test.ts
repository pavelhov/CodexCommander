import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProfile, handleClaudeDesktopCommand } from "../src/cli/claude-desktop";
import { buildClaudeDesktopState } from "../src/server/management-api";
import { loadConfig, saveConfig } from "../src/config";
import type { CodexCommanderConfig } from "../src/types";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

setDefaultTimeout(45_000);

let dir = "";
let previousHome: string | undefined;
let previousDesktopDir: string | undefined;
let previousCodexCliPath: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.CODEXCOMMANDER_HOME;
  previousDesktopDir = process.env.CODEXCOMMANDER_CLAUDE_DESKTOP_CONFIG_DIR;
  previousCodexCliPath = process.env.CODEX_CLI_PATH;
  dir = mkdtempSync(join(tmpdir(), "ccx-desktop-cli-"));
  isolatedCodexHome = installIsolatedCodexHome("ccx-desktop-cli-codex-");
  process.env.CODEX_CLI_PATH = createCodexRuntimeFixture(isolatedCodexHome.path);
  process.env.CODEXCOMMANDER_HOME = join(dir, "ccx");
  process.env.CODEXCOMMANDER_CLAUDE_DESKTOP_CONFIG_DIR = join(dir, "desktop");
  saveConfig({
    port: 10100,
    multiAgentGuidanceEnabled: true,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, liveModels: false, models: ["test-model"] },
    },
  } as CodexCommanderConfig);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (previousDesktopDir === undefined) delete process.env.CODEXCOMMANDER_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.CODEXCOMMANDER_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopDir;
  if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCodexCliPath;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  rmSync(dir, { recursive: true, force: true });
});

test("show --json, move, default and export use the same persisted profile", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["show", "--json"])).toBe(0);
    const state = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(state.profile.assignments["mock/test-model"].family).toBe("opus");

    expect(await handleClaudeDesktopCommand(["move", "mock/test-model", "sonnet", "--default"])).toBe(0);
    expect(loadConfig().claudeCode?.desktopProfile?.defaults.sonnet).toBe("mock/test-model");

    const target = join(dir, "profile.json");
    expect(await handleClaudeDesktopCommand(["export", target])).toBe(0);
    const exported = JSON.parse(readFileSync(target, "utf8"));
    expect(exported.assignments["mock/test-model"].family).toBe("sonnet");
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("import rejects invalid profiles without replacing saved state", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleClaudeDesktopCommand(["move", "mock/test-model", "haiku", "--default"]);
    const before = structuredClone(loadConfig().claudeCode?.desktopProfile);
    const source = join(dir, "bad.json");
    writeFileSync(source, JSON.stringify({ version: 1, assignments: {}, defaults: { opus: "missing", fable: null, sonnet: null, haiku: null } }));
    expect(await handleClaudeDesktopCommand(["import", source])).toBe(1);
    expect(loadConfig().claudeCode?.desktopProfile).toEqual(before);
    expect(error).toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

test("desktopNativeModels:false omits native/* from show and exported profile", async () => {
  saveConfig({
    port: 10100,
    multiAgentGuidanceEnabled: true,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, liveModels: false, models: ["test-model"] },
    },
    claudeCode: { desktopNativeModels: false },
  } as CodexCommanderConfig);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["show", "--json"])).toBe(0);
    const state = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(state.models.every((model: { route: string }) => !model.route.startsWith("native/"))).toBe(true);
    expect(Object.keys(state.profile.assignments).every((route: string) => !route.startsWith("native/"))).toBe(true);

    const target = join(dir, "desktop-profile.json");
    expect(await handleClaudeDesktopCommand(["export", target])).toBe(0);
    const exported = JSON.parse(readFileSync(target, "utf8"));
    expect(Object.keys(exported.assignments).every((route: string) => !route.startsWith("native/"))).toBe(true);
  } finally {
    log.mockRestore();
  }
});

/*
 * #859. The Desktop alias reverse-map is process-local to whichever process
 * builds it. When a live proxy exists, apply must run inside THAT process
 * through the management API; a local-only write leaves the serving daemon
 * unable to decode aliases and the provider 400s.
 */
test("apply delegates to the live proxy management API instead of writing locally", async () => {
  const state = await buildClaudeDesktopState(loadConfig());
  const posted: unknown[] = [];
  const result = await applyProfile(state.profile, {
    findLiveProxyImpl: async () => ({ pid: 4242, port: 10100, hostname: "127.0.0.1", source: "runtime" }),
    postApplyImpl: async (profile) => {
      posted.push(profile);
      return { ok: true, path: "/daemon-side/path" };
    },
  });
  expect(posted.length).toBe(1);
  // The profile must cross the boundary; dropping it reintroduces #859's
  // stale-daemon variant.
  expect(posted[0]).toEqual(state.profile);
  expect(result.ok).toBe(true);
  expect(result.path).toBe("/daemon-side/path");
  // No local Desktop config write: the daemon performed it.
  expect(existsSync(join(dir, "desktop"))).toBe(false);
  // The CLI still persisted the profile itself.
  expect(loadConfig().claudeCode?.desktopProfile).toBeDefined();
});

test("apply writes locally only when no proxy is running", async () => {
  const state = await buildClaudeDesktopState(loadConfig());
  const result = await applyProfile(state.profile, {
    findLiveProxyImpl: async () => null,
    postApplyImpl: async () => {
      throw new Error("must not be called without a live proxy");
    },
  });
  expect(result.ok).toBe(true);
  expect(existsSync(join(dir, "desktop"))).toBe(true);
});

test("apply is the single Desktop write command", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    // Deterministic: no live proxy in the test environment, so apply writes locally.
    const noProxy = { findLiveProxyImpl: async () => null };
    expect(await handleClaudeDesktopCommand(["apply"], noProxy)).toBe(0);
    expect(await handleClaudeDesktopCommand([], noProxy)).toBe(1);
    expect(readFileSync(join(process.env.CODEXCOMMANDER_CLAUDE_DESKTOP_CONFIG_DIR!, "_meta.json"), "utf8")).toContain("codexcommander");
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

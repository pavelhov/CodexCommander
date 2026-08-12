import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armClaudeCodeBaseline,
  getConfigPath,
  loadConfig,
  readConfigDiagnostics,
  reconcileLiveConfigFromDisk,
  saveConfig,
  saveConfigPreservingClaudeCode,
} from "../src/config";
import { rateLimitRetryPolicyFor } from "../src/providers/key-failover";
import type { CodexCommanderConfig } from "../src/types";

/**
 * A user hand-edits `config.json` while the proxy runs. `saveConfig` serializes the
 * WHOLE object, so ANY later service-time save rewrites `claudeCode` from memory and
 * the edit vanishes with no visible cause (#488, implementation contract H1).
 */

let home: string;
let previousHome: string | undefined;

/** Merge a patch into the on-disk config.json, simulating a user hand-edit. */
function writeDiskConfig(patch: Record<string, unknown>): void {
  const current = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
  writeFileSync(getConfigPath(), JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
}

/** Read the current on-disk config.json as a plain record. */
function diskConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
}

function loadErrorMessage(): string {
  try {
    loadConfig();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected loadConfig to reject the invalid current config");
}

beforeEach(() => {
  previousHome = process.env.CODEXCOMMANDER_HOME;
  home = mkdtempSync(join(tmpdir(), "ccx-user-edits-"));
  process.env.CODEXCOMMANDER_HOME = home;
  saveConfig({
    port: 10100,
    multiAgentGuidanceEnabled: true,
    defaultProvider: "test",
    providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true } },
    claudeCode: { authMode: "subscription" },
  } as unknown as CodexCommanderConfig);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test("a hand edit made while the service holds memory survives a guarded save", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });

  saveConfigPreservingClaudeCode(live);

  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
  expect(live.claudeCode?.authMode).toBe("proxy");
});

// THE case the per-writer design could not cover: the save that clobbers `claudeCode`
// does not touch `claudeCode` at all.
test("an unrelated save does not clobber the hand edit", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });

  live.disabledModels = ["test/one"];
  saveConfigPreservingClaudeCode(live);

  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
  expect(diskConfig().disabledModels).toEqual(["test/one"]);
});

test("an unrelated live save cannot resurrect stale Codex ON after Stop persisted OFF", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ clientIntegrations: { codex: false, grok: true } });

  live.disabledModels = ["test/one"];
  saveConfigPreservingClaudeCode(live);

  expect(diskConfig().clientIntegrations).toEqual({ codex: false, grok: true });
  expect(live.clientIntegrations).toEqual({ codex: false, grok: true });
});

test("a deliberate live Codex toggle still wins and rebases its integration baseline", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ clientIntegrations: { codex: false } });
  live.clientIntegrations = { codex: true };

  saveConfigPreservingClaudeCode(live);
  expect(diskConfig().clientIntegrations).toEqual({ codex: true });

  writeDiskConfig({ clientIntegrations: { codex: false, grok: false } });
  live.disabledModels = ["test/two"];
  saveConfigPreservingClaudeCode(live);
  expect(diskConfig().clientIntegrations).toEqual({ codex: false, grok: false });
});

test("an unrelated save refuses to overwrite an invalid persisted subagent effort", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "subscription", subagentEffort: "ultra" } });

  live.disabledModels = ["test/one"];
  expect(() => saveConfigPreservingClaudeCode(live)).toThrow("invalid CodexCommander config");

  expect(live.claudeCode).toEqual({ authMode: "subscription" });
  expect(diskConfig().claudeCode).toEqual({ authMode: "subscription", subagentEffort: "ultra" });
});

// R3-2: arming must be eager. A lazy "arm on first save" loses exactly this edit.
test("an edit made before the first save still survives", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);           // startup
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });  // user edits, no save yet
  live.port = 10101;
  saveConfigPreservingClaudeCode(live);  // the service's FIRST save

  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

// R3-2: the baseline is per instance, so an unrelated loadConfig() cannot refresh it.
test("an unrelated loadConfig does not refresh the armed baseline", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });

  const other = loadConfig();            // some CLI path elsewhere
  expect(other.claudeCode?.authMode).toBe("proxy");

  saveConfigPreservingClaudeCode(live);
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

test.each([
  ["an out-of-range field", { attempts: 0, intervalMs: 120 }],
  ["an unknown field", { attempt: 5, intervalMs: 120 }],
  ["a non-object policy", "enabled"],
  ["an invalid master switch", { enabled: "false", intervalMs: 120 }],
] as const)("retryOn429 rejects %s instead of normalizing it", (_label, retryOn429) => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429,
      },
    },
  });
  const diagnostics = readConfigDiagnostics();
  expect(diagnostics.source).toBe("fallback");
  expect(diagnostics.error).toContain("retryOn429");
});

test("an intentionally empty retryOn429 policy still resolves as enabled (presence = opt-in)", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: {},
      },
    },
  });
  const live = loadConfig();
  expect(live.providers.test.retryOn429).toEqual({});
  // Object presence is the opt-in contract: an explicit `retryOn429: {}` resolves to the
  // enabled defaults, exactly like the documented hand-written config.
  expect(rateLimitRetryPolicyFor(live.providers.test)).toEqual({
    enabled: true,
    attempts: 3,
    intervalMs: 5_000,
    maxIntervalMs: 60_000,
    respectRetryAfter: true,
  });
});

test("config diagnostics reject invalid retryOn429 without normalization", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: { attempts: 0 },
      },
    },
  });
  const diagnostics = readConfigDiagnostics();
  expect(diagnostics.source).toBe("fallback");
  expect(diagnostics.error).toContain("retryOn429");
});

test("invalid retryOn429 errors never expose the raw value", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: "sk-super-secret-abc123",
      },
    },
  });
  const message = loadErrorMessage();
  expect(message).not.toContain("sk-super-secret-abc123");
  expect(message).toContain("providers.test.retryOn429");
});

test("unrecognized retryOn429 field names are redacted from load errors", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: { "sk-super-secret-9876": true, intervalMs: 120 },
      },
    },
  });
  const message = loadErrorMessage();
  expect(message).not.toContain("sk-super-secret-9876");
  expect(message).toContain("unrecognized field");
});

test("unrecognized retryOn429 field names with control characters are omitted from load errors", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: { "evil\nattempt": true, intervalMs: 120 },
      },
    },
  });
  const message = loadErrorMessage();
  expect(message).not.toContain("evil\nattempt");
  expect(message).toContain("unrecognized field");
});

test("provider names are redacted from strict-load errors", () => {
  writeDiskConfig({
    providers: {
      "sk-super-secret-9876": {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: "enabled",
      },
    },
  });
  const message = loadErrorMessage();
  expect(message).not.toContain("sk-super-secret-9876");
  expect(message).toContain("[REDACTED]");
});

test("provider names with control characters are JSON-escaped in strict-load errors", () => {
  writeDiskConfig({
    providers: {
      "evil\nprovider": {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: "enabled",
      },
    },
  });
  const message = loadErrorMessage();
  expect(message).not.toContain("evil\nprovider");
  expect(message).toContain('"evil\\nprovider"');
});

// R4-1: the request path. A 429 mid-turn rotates a key and saves, with no user action.
test("a 429 key rotation does not clobber the hand edit", async () => {
  const { rotateKeyOn429 } = await import("../src/providers/key-failover");
  const live = loadConfig();
  live.providers.pool = {
    adapter: "openai-chat",
    baseUrl: "http://127.0.0.1:1/v1",
    allowPrivateNetwork: true,
    apiKey: "key-a",
    apiKeyPool: [
      { id: "a", key: "key-a" },
      { id: "b", key: "key-b" },
    ],
  } as never;
  saveConfig(live);
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });

  const rotated = rotateKeyOn429(live, "pool", null, Date.now(), "key-a");
  expect(rotated?.apiKey).toBe("key-b");
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

// Both sides changed: ours wins and the baseline rebases, so the NEXT edit starts fresh.
test("our own change wins a conflict and rebases the baseline", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });
  live.claudeCode = { authMode: "subscription", systemEnv: true };

  saveConfigPreservingClaudeCode(live);
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("subscription");

  // Rebased: a fresh hand edit on top of OUR value is preserved by the next save.
  writeDiskConfig({ claudeCode: { authMode: "proxy", systemEnv: true } });
  live.port = 10102;
  saveConfigPreservingClaudeCode(live);
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

test("OAuth reconciliation keeps a pending live Claude subtree authoritative", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  const persistedBaseline = loadConfig();
  live.claudeCode = { authMode: "subscription", systemEnv: true };
  live.disabledModels = ["pending/model"];
  writeDiskConfig({
    claudeCode: { authMode: "proxy" },
    contextCapValue: 240_000,
  });

  reconcileLiveConfigFromDisk(live, persistedBaseline);

  expect(live.claudeCode).toEqual({ authMode: "subscription", systemEnv: true });
  expect(live.disabledModels).toEqual(["pending/model"]);
  expect(live.contextCapValue).toBe(240_000);

  saveConfigPreservingClaudeCode(live);
  expect(diskConfig().claudeCode).toEqual({ authMode: "subscription", systemEnv: true });
  expect(diskConfig().disabledModels).toEqual(["pending/model"]);
  expect(diskConfig().contextCapValue).toBe(240_000);
});

test("OAuth reconciliation adopts a guarded Claude edit that predates its disk snapshot", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });
  const persistedBaseline = loadConfig();

  reconcileLiveConfigFromDisk(live, persistedBaseline);

  expect(live.claudeCode).toEqual({ authMode: "proxy" });
  saveConfigPreservingClaudeCode(live);
  expect(diskConfig().claudeCode).toEqual({ authMode: "proxy" });
});

// Structural compare, not JSON.stringify: key order must not fake an external edit.
test("a key-order-only difference is not treated as an external edit", () => {
  const live = loadConfig();
  live.claudeCode = { authMode: "subscription", systemEnv: true };
  saveConfig(live);
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { systemEnv: true, authMode: "subscription" } });

  live.claudeCode = { authMode: "proxy", systemEnv: true };
  saveConfigPreservingClaudeCode(live);
  // No spurious "their edit wins" branch: our real change lands.
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

test("an invalid config file blocks the guarded save and remains untouched", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeFileSync(getConfigPath(), "{ not json");

  live.claudeCode = { authMode: "proxy" };
  expect(() => saveConfigPreservingClaudeCode(live)).toThrow("invalid_json");
  expect(readFileSync(getConfigPath(), "utf8")).toBe("{ not json");
});

test("an invalid config file also blocks every unarmed save and remains untouched", () => {
  const live = loadConfig();
  writeFileSync(getConfigPath(), "{ not json");

  expect(() => saveConfig(live)).toThrow("invalid_json");
  expect(() => saveConfigPreservingClaudeCode(live)).toThrow("invalid_json");
  expect(readFileSync(getConfigPath(), "utf8")).toBe("{ not json");
});

test("an unarmed config may replace a different schema-valid current config", () => {
  const live = loadConfig();
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });

  live.claudeCode = { authMode: "subscription" };
  saveConfigPreservingClaudeCode(live);
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("subscription");
});

test("an invalid providers hand edit blocks the guarded save", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ providers: { handEdited: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:2/v1", allowPrivateNetwork: true } } });

  live.port = 10103;
  expect(() => saveConfigPreservingClaudeCode(live)).toThrow("defaultProvider");
  expect(Object.keys(diskConfig().providers as Record<string, unknown>)).toEqual(["handEdited"]);
});

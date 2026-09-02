import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { upsertOAuthProvider } from "../src/oauth";
import { notifyRunningProxyAfterOAuthLogin } from "../src/oauth/login-cli";
import { startServer } from "../src/server";
import type { CodexCommanderConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";

const XAI_RECONCILIATION_FIELDS = [
  "adapter",
  "authMode",
  "baseUrl",
  "defaultModel",
  "liveModels",
  "modelContextWindows",
  "modelInputModalities",
  "modelReasoningEfforts",
  "models",
  "noReasoningModels",
  "noVisionModels",
  "parallelToolCalls",
  "preserveReasoningContentModels",
  "reasoningEfforts",
] as const;

/**
 * Regression: CLI OAuth login used to POST the bare OAuth preset into a running proxy.
 * That wiped the preserved apiKey / apiKeyPool / authMode:"key" that runLogin had just
 * written, then saved the stripped entry back to disk.
 */
let testDir = "";
let previousHome: string | undefined;
let previousCodexCliPath: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function keyModeXaiConfig(port = 0): CodexCommanderConfig {
  return {
    port,
    multiAgentGuidanceEnabled: true,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "live-update-sentinel-key",
        apiKeyPool: [{ id: "livekey01", key: "live-update-sentinel-key" }],
        liveModels: false,
        models: ["grok-4.5"],
      },
    },
  } as CodexCommanderConfig;
}

beforeEach(() => {
  previousHome = process.env.CODEXCOMMANDER_HOME;
  previousCodexCliPath = process.env.CODEX_CLI_PATH;
  isolatedCodexHome = installIsolatedCodexHome("ccx-oauth-live-codex-");
  process.env.CODEX_CLI_PATH = createCodexRuntimeFixture(isolatedCodexHome.path);
  testDir = mkdtempSync(join(tmpdir(), "ccx-oauth-live-"));
  process.env.CODEXCOMMANDER_HOME = testDir;
  saveConfig(keyModeXaiConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCodexCliPath;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("CLI OAuth live-update credential preservation", () => {
  test("notify after OAuth login keeps key billing on live and disk configs", async () => {
    const attestationSecret = "A".repeat(43);
    const server = startServer(0, {
      localAttestationSecret: attestationSecret,
      managementApi: { refreshCodexCatalog: async () => {} },
    });
    try {
      const port = server.port!;
      const boot = loadConfig();
      boot.port = port;
      saveConfig(boot);
      const beforeLiveUpdate = await fetch(new URL("/api/providers", server.url)).then(r => r.json()) as Array<{
        name: string;
        defaultModel?: string;
      }>;
      expect(beforeLiveUpdate.find(entry => entry.name === "xai")?.defaultModel).toBeUndefined();

      // Mirror runLogin()'s disk write: upsert preserves key material, then save.
      const afterLogin = loadConfig();
      upsertOAuthProvider(afterLogin, "xai");
      // This is a safe routing-only change made after the listener has started. It proves
      // reconciliation updates live routing rather than only preserving credentials on disk.
      afterLogin.providers.xai!.defaultModel = "grok-4.20-0309-reasoning";
      saveConfig(afterLogin);
      expect(afterLogin.providers.xai!.authMode).toBe("key");
      expect(afterLogin.providers.xai!.apiKey).toBe("live-update-sentinel-key");

      const expectedPostedProvider = structuredClone(afterLogin.providers.xai!);
      delete expectedPostedProvider.apiKey;
      delete expectedPostedProvider.apiKeyPool;

      let reconciliationBody: Record<string, unknown> | null = null;
      const rotatedKey = "newer-live-update-key";
      const observedFetch: typeof fetch = async (input, init) => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        const method = input instanceof Request ? input.method : init?.method;
        const body = input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
        if (new URL(requestUrl).pathname === "/api/providers" && method === "POST") {
          reconciliationBody = JSON.parse(body) as Record<string, unknown>;
          const rotated = await fetch(new URL("/api/providers/keys", server.url), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "xai", key: rotatedKey }),
          });
          if (!rotated.ok) throw new Error(`failed to rotate test key (HTTP ${rotated.status})`);
        }
        return globalThis.fetch(input, init);
      };
      await notifyRunningProxyAfterOAuthLogin("xai", {
        fetchFn: observedFetch,
        readRuntimeFn: () => ({
          pid: process.pid,
          port,
          hostname: "127.0.0.1",
          attestationSecret,
          attestationProtocol: 2,
        }),
        verifyPidFn: candidate => candidate,
      });
      const postedProvider = reconciliationBody?.provider as Record<string, unknown> | undefined;
      expect(reconciliationBody).toEqual({ name: "xai", provider: expectedPostedProvider });
      expect(postedProvider).toEqual(expectedPostedProvider);
      expect(Object.keys(postedProvider ?? {}).sort()).toEqual([...XAI_RECONCILIATION_FIELDS].sort());

      const listed = await fetch(new URL("/api/providers", server.url)).then(r => r.json()) as Array<{
        name: string;
        authMode?: string;
        hasApiKey?: boolean;
        defaultModel?: string;
      }>;
      const live = listed.find(entry => entry.name === "xai");
      expect(live?.authMode).toBe("key");
      expect(live?.hasApiKey).toBe(true);
      expect(live?.defaultModel).toBe("grok-4.20-0309-reasoning");

      const pool = await fetch(new URL("/api/providers/keys?name=xai", server.url)).then(r => r.json()) as {
        activeId: string | null;
        keys: Array<{ id: string; active: boolean }>;
      };
      expect(pool.activeId).toBeTruthy();
      expect(pool.keys.some(entry => entry.active)).toBe(true);

      const disk = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8")) as CodexCommanderConfig;
      expect(disk.providers.xai!.authMode).toBe("key");
      expect(disk.providers.xai!.apiKey).toBe(rotatedKey);
      expect(disk.providers.xai!.apiKeyPool?.some(entry => entry.key === rotatedKey)).toBe(true);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a reached proxy rejection is visible and leaves persisted xAI credentials untouched", async () => {
    const attestationSecret = "B".repeat(43);
    const server = startServer(0, {
      localAttestationSecret: attestationSecret,
      managementApi: { refreshCodexCatalog: async () => {} },
    });
    try {
      const port = server.port!;
      const boot = loadConfig();
      boot.port = port;
      saveConfig(boot);
      const before = readFileSync(join(testDir, "config.json"), "utf8");
      const rejectingFetch: typeof fetch = async (input, init) => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        const method = input instanceof Request ? input.method : init?.method;
        if (new URL(requestUrl).pathname === "/api/providers" && method === "POST") {
          return Response.json({ error: "stale live provider" }, { status: 409 });
        }
        return globalThis.fetch(input, init);
      };

      await expect(notifyRunningProxyAfterOAuthLogin("xai", {
        fetchFn: rejectingFetch,
        readRuntimeFn: () => ({
          pid: process.pid,
          port,
          hostname: "127.0.0.1",
          attestationSecret,
          attestationProtocol: 2,
        }),
        verifyPidFn: candidate => candidate,
      })).rejects.toThrow(/^running proxy rejected the provider update \(HTTP 409\)$/);
      expect(readFileSync(join(testDir, "config.json"), "utf8")).toBe(before);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);
});

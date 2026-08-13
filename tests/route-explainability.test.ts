import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import { appendUsageEntry, resetUsageReadCacheForTests, type PersistedUsageEntry } from "../src/usage/log";
import { closeRequestHistoryIndex } from "../src/routing/history/indexer";
import { candidateCapabilityEvidence } from "../src/routing/capability";
import type { CodexCommanderConfig } from "../src/types";
import { installIsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.CODEXCOMMANDER_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ccx-explain-"));
  process.env.CODEXCOMMANDER_HOME = testDir;
  resetUsageReadCacheForTests();
  closeRequestHistoryIndex();
});

afterEach(() => {
  closeRequestHistoryIndex();
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function config(): CodexCommanderConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://a.example/v1",
        apiKey: "ka",
        models: ["m1"],
        modelContextWindows: { m1: 200_000 },
        parallelToolCalls: true,
      },
    },
    routingProfiles: {
      fast: { candidates: [{ provider: "a", model: "m1" }] },
    },
  };
}

function tracedEntry(requestId: string): PersistedUsageEntry {
  return {
    requestId,
    timestamp: 1_700_000_000_000,
    provider: "a",
    model: "m1",
    requestedModel: "policy/fast",
    status: 200,
    durationMs: 1234,
    usageStatus: "reported",
    routeDecision: {
      version: 1,
      decisionId: "abc123def456",
      createdAt: 1_700_000_000_000,
      requestedModel: "policy/fast",
      routeKind: "policy",
      profile: { id: "fast", revision: "0123456789abcdef" },
      requirements: [],
      candidates: [{
        provider: "a",
        model: "m1",
        eligible: true,
        exclusions: [],
        score: { total: 1, components: { configuredPriority: 1 } },
      }],
      selected: { candidateIndex: 0, provider: "a", model: "m1", reason: "policy-selected" },
    },
    attempts: [
      { ordinal: 1, provider: "a", model: "m1", adapter: "openai-chat", status: 200, durationMs: 1200, sendCount: 1, recoveryKinds: [], usageStatus: "reported" },
    ],
  };
}

async function apiGet(path: string, cfg: CodexCommanderConfig): Promise<Response> {
  const req = new ManagementRequest(`http://localhost${path}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), cfg, { refreshCodexCatalog: async () => {} });
  expect(response).not.toBeNull();
  return response!;
}

describe("route explainability (RI-09)", () => {
  test("route-decision endpoint merges trace, attempts, and outcome", async () => {
    appendUsageEntry(tracedEntry("explain-me"));
    const response = await apiGet("/api/request-history/explain-me/route-decision", config());
    expect(response.status).toBe(200);
    const body = await response.json() as {
      requestId?: string;
      routeDecision?: { routeKind?: string; profile?: { id?: string; revision?: string } };
      attemptSequence?: Array<{ ordinal?: number }>;
      outcome?: { status?: number; durationMs?: number };
      summary?: { requestedModel?: string; routeKind?: string | null; profileId?: string; finalProvider?: string; finalModel?: string };
    };
    expect(body.requestId).toBe("explain-me");
    expect(body.routeDecision?.routeKind).toBe("policy");
    expect(body.routeDecision?.profile).toEqual({ id: "fast", revision: "0123456789abcdef" });
    expect(body.attemptSequence).toHaveLength(1);
    expect(body.attemptSequence![0]!.ordinal).toBe(1);
    expect(body.outcome).toMatchObject({ status: 200, durationMs: 1234 });
    expect(body.summary).toMatchObject({
      requestedModel: "policy/fast",
      routeKind: "policy",
      profileId: "fast",
      finalProvider: "a",
      finalModel: "m1",
    });
  });

  test("unknown request ids return 404", async () => {
    const response = await apiGet("/api/request-history/missing/route-decision", config());
    expect(response.status).toBe(404);
  });

  test("pre-trace rows explain with null routeDecision and their attempts", async () => {
    appendUsageEntry({
      requestId: "legacy-row",
      timestamp: 1_700_000_000_000,
      provider: "a",
      model: "m1",
      status: 503,
      durationMs: 50,
      usageStatus: "unreported",
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", adapter: "openai-chat", status: 503, durationMs: 50, sendCount: 1, recoveryKinds: ["transient-5xx"], usageStatus: "unreported" },
      ],
    });
    const response = await apiGet("/api/request-history/legacy-row/route-decision", config());
    expect(response.status).toBe(200);
    const body = await response.json() as { routeDecision?: unknown; summary?: { routeKind?: string | null } };
    expect(body.routeDecision).toBeNull();
    expect(body.summary?.routeKind).toBeNull();
  });

  test("combo rows report the physical final attempt, not the virtual combo model", async () => {
    appendUsageEntry({
      requestId: "combo-row",
      timestamp: 1_700_000_000_000,
      provider: "combo",
      model: "fast-fallback",
      requestedModel: "combo/fast-fallback",
      status: 200,
      durationMs: 900,
      usageStatus: "reported",
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", adapter: "openai-chat", status: 503, durationMs: 100, sendCount: 1, recoveryKinds: ["transient-5xx"], usageStatus: "unreported" },
        { ordinal: 2, provider: "b", model: "m2", adapter: "openai-chat", status: 200, durationMs: 800, sendCount: 1, recoveryKinds: [], usageStatus: "reported" },
      ],
    });
    const response = await apiGet("/api/request-history/combo-row/route-decision", config());
    expect(response.status).toBe(200);
    const body = await response.json() as {
      summary?: { finalProvider?: string; finalModel?: string };
      attemptSequence?: Array<{ provider?: string; model?: string }>;
    };
    expect(body.attemptSequence).toHaveLength(2);
    expect(body.summary).toMatchObject({ finalProvider: "b", finalModel: "m2" });
  });

  test("dry-run without candidate evidence assembles canonical evidence", async () => {
    const cfg = config();
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "fast", evidence: {} }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), cfg, { refreshCodexCatalog: async () => {} });
    expect(response!.status).toBe(200);
    const body = await response!.json() as {
      candidates?: Array<{ capability?: { contextWindow?: number; encryptedCodexTasks?: boolean }; health?: object; quota?: object; cost?: object }>;
    };
    expect(body.candidates?.[0]?.capability?.contextWindow).toBe(200_000);
    expect(body.candidates?.[0]?.health).toBeDefined();
    expect(body.candidates?.[0]?.quota).toBeDefined();
    expect(body.candidates?.[0]?.cost).toBeDefined();
  });

  test("malformed candidates remain invalid_candidates 400", async () => {
    const cfg = config();
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "fast", candidates: [{ model: "m1" }] }),
    });
    const response = await handleManagementAPI(req, new URL(req.url), cfg, { refreshCodexCatalog: async () => {} });
    expect(response!.status).toBe(400);
    const body = await response!.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_candidates");
  });

  test("absent provider leaves encryptedCodexTasks unknown", () => {
    const evidence = candidateCapabilityEvidence(config(), "missing-provider", "m1");
    expect(Object.prototype.hasOwnProperty.call(evidence, "encryptedCodexTasks")).toBe(false);
  });

  test("explicit custom-model metadata is trusted without generated-catalog inference", () => {
    const cfg = config();
    cfg.providers.custom = {
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      apiKey: "kc",
      models: ["vendor/model"],
      contextWindow: 64_000,
      modelContextWindows: { "vendor/model": 96_000 },
      modelInputModalities: { "vendor/model": ["text"] },
    };
    cfg.customModels = [{
      id: "custom-row",
      provider: "custom",
      modelId: "vendor/model",
      contextWindow: 250_000,
      inputModalities: ["text", "image"],
    }];

    expect(candidateCapabilityEvidence(cfg, "custom", "vendor/model")).toMatchObject({
      contextWindow: 250_000,
      image: true,
      tools: true,
    });
  });

  test("model metadata lookup keeps family and case-fold semantics", () => {
    const cfg = config();
    cfg.providers.custom = {
      adapter: "bare",
      baseUrl: "https://custom.example/v1",
      apiKey: "kc",
      models: ["Model:tag"],
      modelContextWindows: { Model: 180_000 },
      modelInputModalities: { "model:TAG": ["text", "image"] },
      modelReasoningEfforts: { Model: ["low", "high"] },
    };

    expect(candidateCapabilityEvidence(cfg, "custom", "Model:tag")).toMatchObject({
      contextWindow: 180_000,
      image: true,
      reasoningEfforts: ["low", "high"],
    });
  });

  test("provider-wide reasoning metadata remains canonical evidence", () => {
    const cfg = config();
    cfg.providers.custom = {
      adapter: "bare",
      baseUrl: "https://custom.example/v1",
      apiKey: "kc",
      models: ["mystery"],
      reasoningEfforts: ["high", "low", "not-a-codex-tier"],
    };

    expect(candidateCapabilityEvidence(cfg, "custom", "mystery").reasoningEfforts)
      .toEqual(["low", "high"]);
  });

  test("transport-owned registry-wide reasoning metadata remains canonical evidence", () => {
    const cfg = config();
    cfg.providers["cline-pass"] = {
      adapter: "openai-chat",
      baseUrl: "https://api.cline.bot/api/v1",
      apiKey: "kc",
      models: ["cline-pass/kimi-k3"],
    };

    expect(candidateCapabilityEvidence(cfg, "cline-pass", "cline-pass/kimi-k3").reasoningEfforts)
      .toEqual(["low"]);
  });

  test("provider-wide reasoning takes precedence over registry-wide defaults", () => {
    const cfg = config();
    cfg.providers["cline-pass"] = {
      adapter: "openai-chat",
      baseUrl: "https://api.cline.bot/api/v1",
      apiKey: "kc",
      models: ["cline-pass/kimi-k3"],
      reasoningEfforts: ["high"],
    };

    expect(candidateCapabilityEvidence(cfg, "cline-pass", "cline-pass/kimi-k3").reasoningEfforts)
      .toEqual(["high"]);
  });

  test("trusted model reasoning and no-reasoning facts beat provider-wide defaults", () => {
    const cfg = config();
    cfg.providers["opencode-go"] = {
      adapter: "openai-chat",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "kc",
      models: ["deepseek-v4-flash", "kimi-k2.7-code"],
      reasoningEfforts: ["high"],
    };

    expect(candidateCapabilityEvidence(cfg, "opencode-go", "deepseek-v4-flash").reasoningEfforts)
      .toEqual(["low", "high", "max"]);
    expect(candidateCapabilityEvidence(cfg, "opencode-go", "kimi-k2.7-code").reasoningEfforts)
      .toEqual([]);
  });

  test("trusted registry per-model context beats a provider-wide fallback", () => {
    const cfg = config();
    cfg.providers["cline-pass"] = {
      adapter: "openai-chat",
      baseUrl: "https://api.cline.bot/api/v1",
      apiKey: "kc",
      models: ["cline-pass/kimi-k3"],
      contextWindow: 2_000_000,
    };

    expect(candidateCapabilityEvidence(cfg, "cline-pass", "cline-pass/kimi-k3").contextWindow)
      .toBe(1_048_576);
  });

  test("provider context caps lower trusted policy evidence", () => {
    const cfg = config();
    cfg.providerContextCaps = { a: 150_000 };

    expect(candidateCapabilityEvidence(cfg, "a", "m1").contextWindow).toBe(150_000);
  });

  test("explicit custom-model context remains the user's routing assertion", () => {
    const cfg = config();
    cfg.providers.custom = {
      adapter: "bare",
      baseUrl: "https://custom.example/v1",
      apiKey: "kc",
      models: ["mystery"],
    };
    cfg.customModels = [{
      id: "custom-row",
      provider: "custom",
      modelId: "mystery",
      contextWindow: 250_000,
    }];
    cfg.providerContextCaps = { custom: 150_000 };

    expect(candidateCapabilityEvidence(cfg, "custom", "mystery").contextWindow).toBe(250_000);
  });

  test("same-named custom transports do not inherit registry capabilities", () => {
    const cfg = config();
    cfg.providers["opencode-go"] = {
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      apiKey: "kc",
      models: ["deepseek-v4-flash"],
    };

    const evidence = candidateCapabilityEvidence(cfg, "opencode-go", "deepseek-v4-flash");
    expect(Object.prototype.hasOwnProperty.call(evidence, "contextWindow")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(evidence, "image")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(evidence, "reasoningEfforts")).toBe(false);
    expect(evidence.tools).toBe(true);
  });

  test("unknown custom-model facts stay unknown", () => {
    const cfg = config();
    cfg.providers.custom = {
      adapter: "bare",
      baseUrl: "https://custom.example/v1",
      apiKey: "kc",
      models: ["mystery"],
    };
    cfg.customModels = [{ id: "custom-row", provider: "custom", modelId: "mystery" }];

    const evidence = candidateCapabilityEvidence(cfg, "custom", "mystery");
    expect(Object.prototype.hasOwnProperty.call(evidence, "contextWindow")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(evidence, "image")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(evidence, "reasoningEfforts")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(evidence, "tools")).toBe(false);
  });

  test("persisted catalog rows cannot become routing capability authority", () => {
    const home = installIsolatedCodexHome("ccx-route-evidence-");
    try {
      // Deliberately uses the obsolete in-memory shape the removed reader
      // accepted. Generated catalog artifacts are presentation state, not
      // verified provider capability evidence.
      writeFileSync(join(home.path, "codexcommander-catalog.json"), JSON.stringify({
        models: [
          {
            provider: "custom",
            id: "vendor/model",
            contextWindow: 900_000,
            inputModalities: ["image"],
            reasoningEfforts: ["low", "max"],
            capabilities: ["tools"],
          },
          { provider: "chat", id: "plain", capabilities: [] },
        ],
      }));
      const cfg = config();
      cfg.providers.custom = {
        adapter: "bare",
        baseUrl: "https://custom.example/v1",
        apiKey: "kc",
        models: ["vendor/model"],
      };
      cfg.providers.chat = {
        adapter: "openai-chat",
        baseUrl: "https://chat.example/v1",
        apiKey: "kchat",
        models: ["plain"],
      };

      const untrusted = candidateCapabilityEvidence(cfg, "custom", "vendor/model");
      for (const key of ["contextWindow", "image", "reasoningEfforts", "tools"]) {
        expect(Object.prototype.hasOwnProperty.call(untrusted, key)).toBe(false);
      }
      expect(candidateCapabilityEvidence(cfg, "chat", "plain").tools).toBe(true);
    } finally {
      home.restore();
    }
  });

  test("CLI logs explain encodes request ids and supports --json", async () => {
    const { handleObserveCommand } = await import("../src/cli/observe");
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const payload = {
      requestId: "id with spaces",
      summary: { finalProvider: "a", finalModel: "m1" },
    };
    const code = await handleObserveCommand(["logs", "explain", "id with spaces", "--json"], {
      baseUrl: "http://cli.test",
      fetchImpl: async (input, init) => {
        const path = String(input).replace("http://cli.test", "");
        calls.push({ path, init });
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/request-history/id%20with%20spaces/route-decision");
  });

  test("CLI logs explain rejects missing request ids", async () => {
    const { handleObserveCommand } = await import("../src/cli/observe");
    const code = await handleObserveCommand(["logs", "explain"], {
      baseUrl: "http://cli.test",
      fetchImpl: async () => {
        throw new Error("should not request");
      },
    });
    expect(code).toBe(2);
  });

  test("CLI route policy evaluate posts dry-run evidence and rejects option-like ids", async () => {
    const { handleRoutePolicyCommand } = await import("../src/cli/route-policy");
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const ok = await handleRoutePolicyCommand(["evaluate", "fast", "--tools", "--json"], {
      baseUrl: "http://cli.test",
      attestLiveManagementProxyImpl: async () => ({
        pid: 4242,
        port: 80,
        hostname: "cli.test",
        source: "runtime",
        baseUrl: "http://cli.test",
      }),
      fetchImpl: async (input, init) => {
        const path = String(input).replace("http://cli.test", "");
        calls.push({ path, init });
        return new Response(JSON.stringify({ selectedIndex: 0, candidates: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(ok).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/routing-profiles/dry-run");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init?.body ?? "{}")) as {
      profile?: string;
      evidence?: { toolsRequired?: boolean };
    };
    expect(body).toEqual({ profile: "fast", evidence: { toolsRequired: true } });

    const bad = await handleRoutePolicyCommand(["evaluate", "--json"], {
      baseUrl: "http://cli.test",
      fetchImpl: async () => {
        throw new Error("should not request");
      },
    });
    expect(bad).toBe(2);
  });
});

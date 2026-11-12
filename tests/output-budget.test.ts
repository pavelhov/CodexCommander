import { describe, expect, test } from "bun:test";
import { getDefaultConfig, validateConfigCandidate } from "../src/config";
import { effectiveOutputTokenPolicy, knownModelOutputTokenLimit, resolveNativeAnthropicOutputTokens, resolveOutputTokenBudget } from "../src/output-budget";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { routeModel } from "../src/router";
import { resolveAdapter, resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import type { CodexCommanderConfig, CodexCommanderParsedRequest, CodexCommanderProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

function provider(id = "anthropic-apikey"): CodexCommanderProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry(id)!), _registryId: id };
}

function parsed(modelId = "claude-fable-5-2", maxOutputTokens?: number): CodexCommanderParsedRequest {
  return { modelId, options: { maxOutputTokens }, context: { messages: [] }, stream: false };
}

describe("model output capacity", () => {
  test.each([
    ["anthropic-apikey", "claude-fable-5-2", 128_000],
    ["anthropic", "claude-opus-5-5", 128_000],
    ["anthropic", "claude-haiku-4-5", 64_000],
    ["openai-apikey", "gpt-5.4", 128_000],
    ["deepseek", "deepseek-v4-flash", 384_000],
    ["minimax", "minimax-m2.5", 131_072],
    ["minimax", "MiniMax-M2.5", 131_072],
    ["openrouter", "openai/gpt-oss-120b", 131_072],
  ])("%s %s resolves the canonical output capacity", (id, modelId, expected) => {
    expect(knownModelOutputTokenLimit(provider(id), modelId)).toBe(expected);
  });

  test("direct canonical Anthropic adapter resolves capacity without a route stamp", () => {
    expect(knownModelOutputTokenLimit({ adapter: "anthropic", baseUrl: "https://api.anthropic.com/v1/messages" }, "claude-fable-5-2")).toBe(128_000);
  });

  test.each(["unknown", "meta-llama/llama-3-8b-instruct", "nex-agi/deepseek-v3.1-nex-n1", "openrouter/auto"])("unknown or inconsistent OpenRouter capacity remains unset for %s", modelId => {
    expect(knownModelOutputTokenLimit(provider("openrouter"), modelId)).toBeUndefined();
  });

  test("custom destinations do not borrow canonical model capacities", () => {
    const custom = { ...provider(), baseUrl: "https://example.test/anthropic" };
    expect(knownModelOutputTokenLimit(custom, "claude-fable-5-2")).toBeUndefined();
    expect(resolveOutputTokenBudget({ ...custom, _outputTokenPolicy: "model-max" }, parsed(), 8192)).toBe(8192);
  });

  test.each([
    ["opencode-go", "minimax-m2.5", "anthropic"],
    ["deepseek", "deepseek-v4-flash", "openai-responses"],
  ])("%s %s retains capacity after resolving its %s wire", (id, modelId, adapter) => {
    const initial = provider(id);
    const resolved = resolveWireProtocolOverride(id, modelId, initial, "responses");
    expect(resolved.adapter).toBe(adapter);
    expect(knownModelOutputTokenLimit(resolved, modelId)).toBe(knownModelOutputTokenLimit(initial, modelId));
    expect(knownModelOutputTokenLimit(resolved, modelId)).toBeGreaterThan(8192);
  });
});

describe("output token policy", () => {
  test("model-max replaces lower and higher explicit caps with a known allowance without mutating options", () => {
    for (const explicit of [32_768, 160_000]) {
      const request = parsed("claude-fable-5-2", explicit);
      expect(resolveOutputTokenBudget({ ...provider(), _outputTokenPolicy: "model-max" }, request)).toBe(128_000);
      expect(request.options.maxOutputTokens).toBe(explicit);
    }
  });

  test("request policy honors explicit and configured defaults before canonical capacity", () => {
    const configured = { ...provider(), modelMaxOutputTokens: { "claude-fable-5-2": 16_000 }, defaultMaxOutputTokens: 24_000 };
    expect(resolveOutputTokenBudget(configured, parsed("claude-fable-5-2", 32_768))).toBe(32_768);
    expect(resolveOutputTokenBudget(configured, parsed())).toBe(16_000);
    expect(resolveOutputTokenBudget({ ...configured, modelMaxOutputTokens: undefined }, parsed())).toBe(24_000);
    expect(resolveOutputTokenBudget(provider(), parsed(), 8192)).toBe(128_000);
  });

  test("unknown model-max models retain explicit, configured and adapter fallback behavior", () => {
    const configured = { ...provider(), _outputTokenPolicy: "model-max" as const, defaultMaxOutputTokens: 24_000 };
    expect(resolveOutputTokenBudget(configured, parsed("unknown", 4096), 8192)).toBe(4096);
    expect(resolveOutputTokenBudget(configured, parsed("unknown"), 8192)).toBe(24_000);
    expect(resolveOutputTokenBudget(provider(), parsed("unknown"), 8192)).toBe(8192);
    expect(resolveOutputTokenBudget(provider(), parsed("unknown"))).toBeUndefined();
  });

  test("compaction ignores model-max and configured model output defaults", () => {
    const configured = { ...provider(), _outputTokenPolicy: "model-max" as const, defaultMaxOutputTokens: 128_000 };
    const request = { ...parsed(), _compactionRequest: true };
    expect(resolveOutputTokenBudget(configured, request, 8192)).toBe(8192);
    expect(resolveOutputTokenBudget(configured, { ...request, options: { maxOutputTokens: 4096 } }, 8192)).toBe(4096);
  });

  test("native Anthropic passthrough changes only known ordinary model-max totals", () => {
    expect(resolveNativeAnthropicOutputTokens("model-max", "claude-fable-5-2", 32_768, false)).toBe(128_000);
    expect(resolveNativeAnthropicOutputTokens("model-max", "claude-haiku-4-5", undefined, false)).toBe(64_000);
    expect(resolveNativeAnthropicOutputTokens("request", "claude-fable-5-2", 32_768, false)).toBe(32_768);
    expect(resolveNativeAnthropicOutputTokens("model-max", "claude-fable-5-2", 8192, true)).toBe(8192);
    expect(resolveNativeAnthropicOutputTokens("model-max", "unknown", 4096, false)).toBe(4096);
  });

  test("config validates the optional global enum and keeps registry capacity facts out of saved seeds", () => {
    const defaults = getDefaultConfig();
    expect(defaults.outputTokenPolicy).toBe("model-max");
    expect(effectiveOutputTokenPolicy({})).toBe("model-max");
    expect(effectiveOutputTokenPolicy({ outputTokenPolicy: "request" })).toBe("request");
    expect(validateConfigCandidate(defaults).ok).toBe(true);
    expect(validateConfigCandidate({ ...defaults, outputTokenPolicy: "model-max" }).ok).toBe(true);
    expect(validateConfigCandidate({ ...defaults, outputTokenPolicy: "request" }).ok).toBe(true);
    expect(validateConfigCandidate({ ...defaults, outputTokenPolicy: "unlimited" }).ok).toBe(false);
    const seed = providerConfigSeed(getProviderRegistryEntry("anthropic-apikey")!);
    expect(seed).not.toHaveProperty("modelOutputTokenLimits");
    expect(seed).not.toHaveProperty("_registryId");
  });

  test.each(["anthropic-apikey/claude-fable-5-2", "claude-fable-5-2", "unknown", "combo/one", "policy/one"])("routing stamps the global policy for %s without changing config", modelId => {
    const configured = provider();
    delete configured._registryId;
    const config: CodexCommanderConfig = {
      port: 10100,
      defaultProvider: "anthropic-apikey",
      outputTokenPolicy: "model-max",
      providers: { "anthropic-apikey": configured },
      combos: { one: { targets: [{ provider: "anthropic-apikey", model: "claude-fable-5-2" }] } },
      routingProfiles: { one: { candidates: [{ provider: "anthropic-apikey", model: "claude-fable-5-2" }] } },
    };
    const before = JSON.stringify(config);
    const route = routeModel(config, modelId);
    expect(route.provider._outputTokenPolicy).toBe("model-max");
    expect(route.provider._registryId).toBe("anthropic-apikey");
    expect(JSON.stringify(config)).toBe(before);
    expect(routeModel({ ...config, outputTokenPolicy: undefined }, modelId).provider._outputTokenPolicy).toBe("model-max");
    expect(routeModel({ ...config, outputTokenPolicy: "request" }, modelId).provider._outputTokenPolicy).toBe("request");
  });

  test.each([
    [undefined, 128_000],
    ["request", 32_768],
  ] as const)("routed Anthropic requests apply global policy %s through the adapter entry point", async (policy, expected) => {
    const config: CodexCommanderConfig = {
      port: 10100,
      defaultProvider: "anthropic-apikey",
      providers: { "anthropic-apikey": { ...provider(), apiKey: "test-output-policy-key" } },
      ...(policy ? { outputTokenPolicy: policy } : {}),
    };
    const route = routeModel(config, "anthropic-apikey/claude-fable-5-2");
    const request = parsed(route.modelId, 32_768);
    const adapter = withTestTranslatorBudget(resolveAdapter(route.provider));
    const wire = await adapter.buildRequest(request);
    expect(JSON.parse(wire.body).max_tokens).toBe(expected);
    expect(request.options.maxOutputTokens).toBe(32_768);
  });
});

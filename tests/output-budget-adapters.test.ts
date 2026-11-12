import { describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import type { InboundWire } from "../src/providers/registry";
import { routeModel } from "../src/router";
import { resolveAdapter, resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import type { CodexCommanderConfig, CodexCommanderParsedRequest, CodexCommanderProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

async function routedBody(
  providerName: string,
  modelId: string,
  options: CodexCommanderParsedRequest["options"] = {},
  overrides: Partial<CodexCommanderProviderConfig> = {},
  policy: CodexCommanderConfig["outputTokenPolicy"] = "model-max",
  compaction = false,
  inbound: InboundWire = "chat",
) {
  const registry = getProviderRegistryEntry(providerName);
  const provider = {
    ...(registry ? providerConfigSeed(registry) : { adapter: "openai-chat", baseUrl: "https://example.test/v1" }),
    apiKey: "test-output-budget-key",
    ...overrides,
  };
  const config: CodexCommanderConfig = {
    port: 10100,
    defaultProvider: providerName,
    outputTokenPolicy: policy,
    providers: { [providerName]: provider },
  };
  const route = routeModel(config, `${providerName}/${modelId}`);
  route.provider = resolveWireProtocolOverride(providerName, route.modelId, route.provider, inbound);
  const adapter = withTestTranslatorBudget(resolveAdapter(route.provider));
  const request = await adapter.buildRequest({
    modelId: route.modelId,
    stream: false,
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    options,
    _rawBody: { model: route.modelId, input: "hello", ...(options.maxOutputTokens !== undefined ? { max_output_tokens: options.maxOutputTokens } : {}) },
    ...(compaction ? { _compactionRequest: true } : {}),
  });
  return JSON.parse(request.body) as Record<string, any>;
}

describe("routed output token policy on adapter wires", () => {
  test("chat raises the wire allowance while preserving caller-sized thinking", async () => {
    const body = await routedBody("deepseek", "deepseek-v4-flash", { maxOutputTokens: 8_000, reasoning: "high" }, {
      thinkingBudgetModels: ["deepseek-v4-flash"],
      reasoningEffortMap: { high: "high" },
    });
    expect(body.max_tokens).toBe(384_000);
    expect(body.thinking_budget).toBe(6_000);
  });

  test("chat preserves explicit request limits under the default policy", async () => {
    const body = await routedBody("deepseek", "deepseek-v4-flash", { maxOutputTokens: 8_000 }, {}, "request");
    expect(body.max_tokens).toBe(8_000);
  });

  test("chat uses the known model allowance when the request omits a limit", async () => {
    const body = await routedBody("deepseek", "deepseek-v4-flash", {}, {}, "request");
    expect(body.max_tokens).toBe(384_000);
  });

  test("unknown custom chat models keep their existing configured fallback", async () => {
    const body = await routedBody("custom", "unknown", { maxOutputTokens: 8_000 }, { defaultMaxOutputTokens: 16_000 });
    expect(body.max_tokens).toBe(8_000);
    const omitted = await routedBody("custom", "unknown", {}, { defaultMaxOutputTokens: 16_000 });
    expect(omitted.max_tokens).toBe(16_000);
  });

  test("model-max never raises compaction requests", async () => {
    const body = await routedBody("deepseek", "deepseek-v4-flash", { maxOutputTokens: 8_000 }, {}, "model-max", true);
    expect(body.max_tokens).toBe(8_000);
  });

  test("AI Studio, Vertex, and Cloud Code Assist apply the same Gemini allowance", async () => {
    for (const providerName of ["google", "google-vertex", "google-antigravity"]) {
      const body = await routedBody(providerName, "gemini-3.5-flash", { maxOutputTokens: 8_000 }, { project: "test-output-budget-project" });
      const request = providerName === "google-antigravity" ? body.request : body;
      expect(request.generationConfig.maxOutputTokens).toBe(65_536);
    }
  });

  test("Google request policy preserves an explicit limit and fills an omitted allowance", async () => {
    const explicit = await routedBody("google", "gemini-3.5-flash", { maxOutputTokens: 8_000 }, {}, "request");
    const omitted = await routedBody("google", "gemini-3.5-flash", {}, {}, "request");
    expect(explicit.generationConfig.maxOutputTokens).toBe(8_000);
    expect(omitted.generationConfig.maxOutputTokens).toBe(65_536);
  });

  test("Command Code retains its 64k fallback for an unknown model", async () => {
    const omitted = await routedBody("command-code", "unknown");
    const explicit = await routedBody("command-code", "unknown", { maxOutputTokens: 8_000 });
    expect(omitted.params.max_tokens).toBe(64_000);
    expect(explicit.params.max_tokens).toBe(8_000);
  });

  test("API-key Responses raises only known model-max requests", async () => {
    const known = await routedBody("openai-apikey", "gpt-5.4", { maxOutputTokens: 8_000 });
    const omitted = await routedBody("openai-apikey", "gpt-5.4");
    const omittedRequestPolicy = await routedBody("openai-apikey", "gpt-5.4", {}, {}, "request");
    const requestPolicy = await routedBody("openai-apikey", "gpt-5.4", { maxOutputTokens: 8_000 }, {}, "request");
    const unknown = await routedBody("openai-apikey", "unknown", { maxOutputTokens: 8_000 });
    const compaction = await routedBody("openai-apikey", "gpt-5.4", { maxOutputTokens: 8_000 }, {}, "model-max", true);
    expect(known.max_output_tokens).toBe(128_000);
    expect(omitted.max_output_tokens).toBe(128_000);
    expect(omittedRequestPolicy).not.toHaveProperty("max_output_tokens");
    expect(requestPolicy.max_output_tokens).toBe(8_000);
    expect(unknown.max_output_tokens).toBe(8_000);
    expect(compaction.max_output_tokens).toBe(8_000);
  });

  test("a reviewed mixed-wire gateway keeps its known allowance on the Responses wire", async () => {
    const body = await routedBody("deepseek", "deepseek-v4-flash", { maxOutputTokens: 8_000 }, {
      modelAdapters: { "deepseek-v4-flash": "openai-responses" },
    });
    expect(body.max_output_tokens).toBe(384_000);
    const registryDefault = await routedBody("deepseek", "deepseek-v4-flash", { maxOutputTokens: 8_000 }, {}, "model-max", false, "responses");
    expect(registryDefault.max_output_tokens).toBe(384_000);
  });

  test("forward requests never inject a policy output cap and preserve existing stripping", async () => {
    const native = await routedBody("openai", "gpt-5.4");
    const custom = await routedBody("custom", "gpt-5.4", { maxOutputTokens: 8_000 }, {
      adapter: "openai-responses",
      authMode: "forward",
    });
    expect(native).not.toHaveProperty("max_output_tokens");
    expect(custom).not.toHaveProperty("max_output_tokens");
  });
});

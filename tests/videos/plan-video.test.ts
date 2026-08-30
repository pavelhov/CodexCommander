import { describe, expect, test } from "bun:test";
import { planVideoBridge } from "../../src/images/plan";
import type { CodexCommanderConfig, CodexCommanderParsedRequest, CodexCommanderProviderConfig } from "../../src/types";
import { VIDEO_GEN_TOOL_NAME } from "../../src/images/synthetic-tool";
import { buildMediaExecutionPlan, buildMediaReadinessSnapshot } from "../../src/images/capabilities";

function makeConfig(overrides: Partial<CodexCommanderConfig> = {}): CodexCommanderConfig {
  const xai: CodexCommanderProviderConfig = {
    name: "xai",
    baseUrl: "https://api.x.ai/v1",
    authMode: "key",
    apiKey: "xai-test-key",
  };
  return {
    providers: { xai },
    ...overrides,
  } as unknown as CodexCommanderConfig;
}

function makeParsed(): CodexCommanderParsedRequest {
  return { stream: true, context: { messages: [] } } as unknown as CodexCommanderParsedRequest;
}

function makeProvider(host: string): CodexCommanderProviderConfig {
  return { baseUrl: `https://${host}`, authMode: "key", apiKey: "other-key" } as unknown as CodexCommanderProviderConfig;
}

describe("planVideoBridge", () => {
  test("returns undefined when videoBridgeEnabled is not true", async () => {
    const config = makeConfig({ images: { videoBridgeEnabled: false } } as unknown as CodexCommanderConfig);
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("returns undefined when videoBridgeEnabled is missing", async () => {
    const config = makeConfig({ images: {} } as unknown as CodexCommanderConfig);
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("returns plan when enabled with valid xAI provider", async () => {
    const config = makeConfig({ images: { videoBridgeEnabled: true } } as unknown as CodexCommanderConfig);
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeDefined();
    expect(plan!.model).toBe("grok-imagine-video");
    expect(plan!.auth.token).toBe("xai-test-key");
    expect(plan!.auth.baseUrl).toBe("https://api.x.ai/v1");
    expect(plan!.toolNames.has(VIDEO_GEN_TOOL_NAME)).toBe(true);
  });

  test("returns undefined for OpenAI native passthrough", async () => {
    const config = makeConfig({ images: { videoBridgeEnabled: true } } as unknown as CodexCommanderConfig);
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.openai.com"));
    expect(plan).toBeUndefined();
  });

  test("returns undefined when no xAI provider available", async () => {
    const config: CodexCommanderConfig = {
      providers: { anthropic: makeProvider("api.anthropic.com") },
      images: { videoBridgeEnabled: true },
    } as unknown as CodexCommanderConfig;
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("returns undefined when xAI provider uses oauth (no API key)", async () => {
    const config: CodexCommanderConfig = {
      providers: { xai: { baseUrl: "https://api.x.ai/v1", authMode: "oauth", apiKey: undefined } },
      images: { videoBridgeEnabled: true },
    } as unknown as CodexCommanderConfig;
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeUndefined();
  });

  test("respects custom videoBridgeModel", async () => {
    const config = makeConfig({ images: { videoBridgeEnabled: true, videoBridgeModel: "custom-video-model" } } as unknown as CodexCommanderConfig);
    const plan = await planVideoBridge(config, makeParsed(), makeProvider("api.anthropic.com"));
    expect(plan).toBeDefined();
    expect(plan!.model).toBe("custom-video-model");
  });
});

describe("media video capability contract", () => {
  test("video can be eligible while the image bridge stays native", () => {
    const config = makeConfig({
      images: {
        bridgeEnabled: false,
        videoBridgeEnabled: true,
        authSource: "subscription_oauth",
      },
    } as unknown as CodexCommanderConfig);
    const snapshot = buildMediaReadinessSnapshot(config, { subscription_oauth: "ready" });
    const plan = buildMediaExecutionPlan(snapshot, {
      surface: "responses",
      routeEligible: true,
      imageToolRequested: true,
      videoToolRequested: true,
    });

    expect(plan.image).toMatchObject({ toolEligible: false, executionEligible: false, reason: "disabled" });
    expect(plan.video).toMatchObject({ toolEligible: true, executionEligible: true, reason: null });
  });

  test("an enabled but unready video remains visibly blocked without becoming eligible", () => {
    const config = makeConfig({
      images: { bridgeEnabled: false, videoBridgeEnabled: true, authSource: "api_key" },
    } as unknown as CodexCommanderConfig);
    const snapshot = buildMediaReadinessSnapshot(config, { api_key: "missing" });
    const plan = buildMediaExecutionPlan(snapshot, {
      surface: "responses",
      routeEligible: true,
      imageToolRequested: false,
      videoToolRequested: true,
    });

    expect(snapshot.video).toMatchObject({ state: "blocked", reason: "credential_unavailable" });
    expect(plan.video).toMatchObject({
      toolEligible: false,
      executionEligible: false,
      reason: "credential_unavailable",
    });
  });
});

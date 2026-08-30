import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexCommanderConfig, CodexCommanderProviderConfig, CodexCommanderParsedRequest } from "../../src/types";
import { buildMediaExecutionPlan, buildMediaReadinessSnapshot } from "../../src/images/capabilities";
import type { MediaCredentialBinding } from "../../src/images/types";

const PREV_HOME = process.env.CODEXCOMMANDER_HOME;
let planImageBridge: typeof import("../../src/images/plan")["planImageBridge"];
let MAX_IMAGE_TIMEOUT_MS: typeof import("../../src/images/plan")["MAX_IMAGE_TIMEOUT_MS"];

/** Mutable token that the mocked getValidAccessToken resolves to. */
let tokenResult: string | null = null;

beforeAll(async () => {
  process.env.CODEXCOMMANDER_HOME = join(tmpdir(), "ccx-test-" + randomUUID());
  const actualOauth = await import("../../src/oauth/index");
  mock.module("../../src/oauth/index", () => ({
    ...actualOauth,
    getValidAccessToken: async () => tokenResult,
  }));
  ({ planImageBridge, MAX_IMAGE_TIMEOUT_MS } = await import("../../src/images/plan"));
});
afterAll(() => { if (PREV_HOME === undefined) delete process.env.CODEXCOMMANDER_HOME; else process.env.CODEXCOMMANDER_HOME = PREV_HOME; mock.restore(); });

beforeEach(() => {
  tokenResult = null;
});

function makeConfig(
  providers: Record<string, Partial<CodexCommanderProviderConfig>>,
  images?: {
    bridgeEnabled?: boolean;
    videoBridgeEnabled?: boolean;
    authSource?: "subscription_oauth" | "api_key";
    bridgeModel?: string;
    timeoutMs?: number;
  },
): CodexCommanderConfig {
  return {
    port: 0,
    defaultProvider: "test",
    providers: Object.fromEntries(
      Object.entries(providers).map(([k, v]) => [k, { adapter: "openai-chat", baseUrl: "https://api.test.com", ...v }]),
    ),
    ...(images ? { images } : {}),
  } as CodexCommanderConfig;
}

function makeParsed(withImageGen: boolean): CodexCommanderParsedRequest {
  return {
    modelId: "test-model",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
    ...(withImageGen ? { _imageGeneration: { toolNames: new Set(["image_gen"]) } } : {}),
  } as CodexCommanderParsedRequest;
}

const routed = { adapter: "openai-chat", baseUrl: "https://api.anthropic.com" } as CodexCommanderProviderConfig;
const openaiRouted = { adapter: "openai-chat", baseUrl: "https://api.openai.com" } as CodexCommanderProviderConfig;

describe("planImageBridge", () => {
  test("bridgeEnabled false → undefined", async () => {
    expect(await planImageBridge(makeConfig({ test: routed }, { bridgeEnabled: false }), makeParsed(true), routed)).toBeUndefined();
  });

  test("bridgeEnabled not set → undefined (opt-in required)", async () => {
    // xAI provider configured but images.bridgeEnabled is absent — must not bridge.
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } });
    expect(await planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
  });

  test("_imageGeneration not set → undefined", async () => {
    expect(await planImageBridge(makeConfig({ test: routed }, { bridgeEnabled: true }), makeParsed(false), routed)).toBeUndefined();
  });

  test("routedProvider is api.openai.com → undefined", async () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    expect(await planImageBridge(cfg, makeParsed(true), openaiRouted)).toBeUndefined();
  });

  test("no xAI provider → undefined", async () => {
    expect(await planImageBridge(makeConfig({ test: routed }, { bridgeEnabled: true }), makeParsed(true), routed)).toBeUndefined();
  });

  test("xAI provider but apiKey empty and no OAuth → undefined", async () => {
    tokenResult = null;
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "" } }, { bridgeEnabled: true });
    expect(await planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
  });

  test("xAI provider with API key → returns plan with correct model", async () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(plan!.model).toBe("grok-imagine-image-quality");
    expect(plan!.auth.token).toBe("test-token");
    expect(plan!.auth.baseUrl).toBe("https://api.x.ai/v1");
  });

  test("xAI provider with OAuth only (no API key) → undefined (API-key-only bridge)", async () => {
    tokenResult = "fake-oauth-123";
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai" } }, { bridgeEnabled: true });
    expect(await planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
    tokenResult = null;
  });

  test("custom-named provider with api.x.ai baseUrl → found via fallback", async () => {
    const cfg = makeConfig({ mygrok: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(plan!.provider).toBe(cfg.providers.mygrok);
  });

  test("custom bridgeModel is honored", async () => {
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } },
      { bridgeEnabled: true, bridgeModel: "custom-img-model" },
    );
    expect((await planImageBridge(cfg, makeParsed(true), routed))!.model).toBe("custom-img-model");
  });

  test("images.timeoutMs is forwarded onto the plan", async () => {
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } },
      { bridgeEnabled: true, timeoutMs: 120_000 },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan!.timeoutMs).toBe(120_000);
  });

  test("images.timeoutMs above ceiling is clamped", async () => {
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } },
      { bridgeEnabled: true, timeoutMs: 999_999_999 },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan!.timeoutMs).toBe(MAX_IMAGE_TIMEOUT_MS);
  });

  test("toolNames includes IMAGE_GEN_TOOL_NAME so the loop can intercept synthetic calls", async () => {
    const { IMAGE_GEN_TOOL_NAME } = await import("../../src/images/synthetic-tool");
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    // The plan always merges in IMAGE_GEN_TOOL_NAME, even if _imageGeneration.toolNames
    // only contained the original hosted tool name.
    expect(plan!.toolNames.has(IMAGE_GEN_TOOL_NAME)).toBe(true);
  });

  test("baseUrl is pinned to registry regardless of config override", async () => {
    // config 里 xai provider 的 baseUrl 被改成恶意 host
    const cfg = makeConfig(
      { xai: { adapter: "openai-chat", baseUrl: "https://evil.example.com/v1", apiKey: "test-key" } },
      { bridgeEnabled: true },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    // auth.baseUrl 必须是 registry pin 的地址，不是 config 里的恶意地址
    expect(plan!.auth.baseUrl).toBe("https://api.x.ai/v1");
  });

  test("custom-named provider with api.x.ai baseUrl does NOT get built-in OAuth token", async () => {
    tokenResult = "should-not-be-used";
    // provider 名为 "my-xai"，baseUrl 指向 api.x.ai，没有 apiKey
    const cfg = makeConfig(
      { "my-xai": { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1" } },
      { bridgeEnabled: true },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    // 没有 apiKey 也没有 "xai" 的 OAuth → 没有 token → 没有 plan
    expect(plan).toBeUndefined();
    tokenResult = null;
  });

  test("authMode oauth does not arm the bridge even with a stale apiKey", async () => {
    tokenResult = "oauth-token";
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "stale-key", authMode: "oauth" } },
      { bridgeEnabled: true },
    );
    expect(await planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
    tokenResult = null;
  });

  test("authMode key does not fall back to stored OAuth", async () => {
    tokenResult = "oauth-token";
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "", authMode: "key" } },
      { bridgeEnabled: true },
    );
    expect(await planImageBridge(cfg, makeParsed(true), routed)).toBeUndefined();
    tokenResult = null;
  });
});

describe("media image capability contract", () => {
  const sources = ["api_key", "subscription_oauth"] as const;

  test("keeps image and video capability states independent for both credential sources", () => {
    for (const authSource of sources) {
      for (const bridgeEnabled of [false, true]) {
        for (const videoBridgeEnabled of [false, true]) {
          const config = makeConfig(
            { xai: { baseUrl: "https://api.x.ai/v1" } },
            { bridgeEnabled, videoBridgeEnabled, authSource },
          );
          const snapshot = buildMediaReadinessSnapshot(config, {
            api_key: "ready",
            subscription_oauth: "ready",
          });
          expect(snapshot.authSource).toBe(authSource);
          expect(snapshot.image.state).toBe(bridgeEnabled ? "ready" : "disabled");
          expect(snapshot.video.state).toBe(videoBridgeEnabled ? "ready" : "disabled");
        }
      }
    }
  });

  test("uses only the selected source and produces a redacted blocked snapshot", () => {
    const config = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "xai-secret-key-suffix" } },
      { bridgeEnabled: true, videoBridgeEnabled: true, authSource: "subscription_oauth" },
    );
    const snapshot = buildMediaReadinessSnapshot(config, {
      api_key: "ready",
      subscription_oauth: "reauthentication_required",
      token: "oauth-secret",
      accountId: "private-account",
    } as never);

    expect(snapshot).toMatchObject({
      authSource: "subscription_oauth",
      credential: { state: "blocked", reason: "reauthentication_required" },
      image: { state: "blocked", reason: "reauthentication_required" },
      video: { state: "blocked", reason: "reauthentication_required" },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("xai-secret-key-suffix");
    expect(serialized).not.toContain("oauth-secret");
    expect(serialized).not.toContain("private-account");
  });

  test("fails closed when an enabled in-memory config was not normalized with an auth source", () => {
    const config = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "must-not-arm" } },
      { bridgeEnabled: true, videoBridgeEnabled: false },
    );
    const snapshot = buildMediaReadinessSnapshot(config, { api_key: "ready" });

    expect(snapshot).toMatchObject({
      authSource: null,
      credential: { state: "blocked", reason: "auth_source_missing", provider: null },
      image: { state: "blocked", reason: "auth_source_missing" },
      video: { state: "disabled", reason: "disabled" },
    });
  });

  test("fails closed with migration guidance for ambiguous legacy xAI API-key aliases", () => {
    const config = makeConfig(
      {
        first: { baseUrl: "https://api.x.ai/v1" },
        second: { baseUrl: "https://cli-chat-proxy.grok.com" },
      },
      { bridgeEnabled: true, videoBridgeEnabled: false, authSource: "api_key" },
    );
    const snapshot = buildMediaReadinessSnapshot(config, { api_key: "ready" });
    expect(snapshot.credential).toMatchObject({
      state: "blocked",
      reason: "ambiguous_xai_provider",
      recovery: expect.stringContaining("providers.xai"),
    });
    expect(snapshot.image.state).toBe("blocked");
  });

  test("canonical xai suppresses aliases and subscription OAuth requires canonical xai", () => {
    const canonical = makeConfig(
      {
        xai: { baseUrl: "https://configured.example/v1" },
        alias: { baseUrl: "https://api.x.ai/v1" },
      },
      { bridgeEnabled: true, videoBridgeEnabled: false, authSource: "api_key" },
    );
    expect(buildMediaReadinessSnapshot(canonical, { api_key: "ready" }).credential)
      .toMatchObject({ state: "ready", provider: "canonical" });

    const aliasOnly = makeConfig(
      { alias: { baseUrl: "https://api.x.ai/v1" } },
      { bridgeEnabled: true, videoBridgeEnabled: false, authSource: "subscription_oauth" },
    );
    expect(buildMediaReadinessSnapshot(aliasOnly, { subscription_oauth: "ready" }).credential)
      .toMatchObject({ state: "blocked", reason: "canonical_xai_provider_missing" });

    const oneEnabledAlias = makeConfig(
      {
        enabled: { baseUrl: "https://api.x.ai/v1" },
        ignored: { baseUrl: "https://cli-chat-proxy.grok.com", disabled: true },
      },
      { bridgeEnabled: true, videoBridgeEnabled: false, authSource: "api_key" },
    );
    expect(buildMediaReadinessSnapshot(oneEnabledAlias, { api_key: "ready" }).credential)
      .toMatchObject({ state: "ready", provider: "legacy_alias" });

    const disabledCanonical = makeConfig(
      {
        xai: { baseUrl: "https://configured.example/v1", disabled: true },
        alias: { baseUrl: "https://api.x.ai/v1" },
      },
      { bridgeEnabled: true, videoBridgeEnabled: false, authSource: "api_key" },
    );
    expect(buildMediaReadinessSnapshot(disabledCanonical, { api_key: "ready" }).credential)
      .toMatchObject({ state: "blocked", reason: "xai_provider_disabled" });
  });

  test("request eligibility is separate from readiness and contains no credential binding", () => {
    const config = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "private-key" } },
      { bridgeEnabled: true, videoBridgeEnabled: false, authSource: "api_key" },
    );
    const snapshot = buildMediaReadinessSnapshot(config, { api_key: "ready" });
    const plan = buildMediaExecutionPlan(snapshot, {
      surface: "responses",
      routeEligible: true,
      imageToolRequested: true,
      videoToolRequested: true,
    });

    expect(plan.image).toMatchObject({ toolEligible: true, executionEligible: true });
    expect(plan.video).toMatchObject({ toolEligible: false, executionEligible: false, reason: "disabled" });
    expect(plan).not.toHaveProperty("binding");
    expect(JSON.stringify(plan)).not.toContain("private-key");
  });

  test("execution credential binding contains opaque metadata only", () => {
    const binding = {
      authSource: "api_key",
      providerKind: "legacy_alias",
      slotRef: "media-slot:opaque",
      identityDigest: "sha256:stable-non-secret-digest",
    } satisfies MediaCredentialBinding;

    expect(Object.keys(binding).sort()).toEqual([
      "authSource",
      "identityDigest",
      "providerKind",
      "slotRef",
    ]);
    expect(binding).not.toHaveProperty("provider");
    expect(binding).not.toHaveProperty("baseUrl");
    expect(binding).not.toHaveProperty("token");
  });
});

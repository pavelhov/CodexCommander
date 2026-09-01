import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexCommanderConfig, CodexCommanderProviderConfig, CodexCommanderParsedRequest } from "../../src/types";
import { buildMediaExecutionPlan, buildMediaReadinessSnapshot, resolveMediaRoute } from "../../src/images/capabilities";
import type { MediaCredentialBinding } from "../../src/images/types";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";

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
    ...(images ? {
      images: {
        ...(images.bridgeEnabled === true && images.authSource === undefined ? { authSource: "api_key" as const } : {}),
        ...images,
      },
    } : {}),
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

  test("selected image capability plans the stable tool without client media wording or declaration", async () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(false), routed);
    expect(plan?.toolNames.has("image_gen")).toBe(true);
  });

  test("native api.openai.com route is eligible when the image opt-in is on", async () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(true), openaiRouted);
    expect(plan).toBeDefined();
    expect(plan!.bindAuth!()).toMatchObject({ authSource: "api_key", providerKind: "canonical" });
  });

  test("no xAI provider → undefined", async () => {
    expect(await planImageBridge(makeConfig({ test: routed }, { bridgeEnabled: true }), makeParsed(true), routed)).toBeUndefined();
  });

  test("xAI provider but apiKey empty remains advertised and binds only on proposal", async () => {
    tokenResult = null;
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(() => plan!.bindAuth!()).toThrow();
  });

  test("xAI provider with API key → returns plan with correct model", async () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(plan!.model).toBe("grok-imagine-image-2.0");
    const auth = plan!.bindAuth!();
    expect(auth).toMatchObject({ authSource: "api_key", providerKind: "canonical" });
    expect(auth).not.toHaveProperty("token");
    expect(auth).not.toHaveProperty("baseUrl");
  });

  test("subscription OAuth binds the canonical xAI slot without consulting an API key", async () => {
    const cfg = makeConfig(
      { xai: { baseUrl: "https://attacker.invalid/ignored", apiKey: "must-not-be-used", authMode: "oauth" } },
      { bridgeEnabled: true, authSource: "subscription_oauth" },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed, {
      getOAuthAccountSet: () => ({
        activeAccountId: "oauth-slot",
        accounts: [{
          id: "oauth-slot",
          credential: { accessToken: "ephemeral", accountId: "stable-subject" },
        }],
      } as never),
    });
    const auth = plan!.bindAuth!();
    expect(auth).toMatchObject({ authSource: "subscription_oauth", providerKind: "canonical" });
    expect(JSON.stringify(auth)).not.toContain("must-not-be-used");
    expect(JSON.stringify(auth)).not.toContain("ephemeral");
  });

  test("custom-named provider with api.x.ai baseUrl cannot arm paid media", async () => {
    const cfg = makeConfig({ mygrok: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { bridgeEnabled: true });
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeUndefined();
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

  test("credential binding never carries a caller-configurable base URL", async () => {
    // config 里 xai provider 的 baseUrl 被改成恶意 host
    const cfg = makeConfig(
      { xai: { adapter: "openai-chat", baseUrl: "https://evil.example.com/v1", apiKey: "test-key" } },
      { bridgeEnabled: true },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    const auth = plan!.bindAuth!();
    expect(auth).not.toHaveProperty("baseUrl");
    expect(JSON.stringify(auth)).not.toContain("evil.example.com");
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

  test("selected subscription OAuth does not fall back to a stale API key", async () => {
    tokenResult = "oauth-token";
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "stale-key", authMode: "oauth" } },
      { bridgeEnabled: true, authSource: "subscription_oauth" },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(() => plan!.bindAuth!()).toThrow();
    tokenResult = null;
  });

  test("authMode key does not fall back to stored OAuth", async () => {
    tokenResult = "oauth-token";
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "", authMode: "key" } },
      { bridgeEnabled: true },
    );
    const plan = await planImageBridge(cfg, makeParsed(true), routed);
    expect(plan).toBeDefined();
    expect(() => plan!.bindAuth!()).toThrow();
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
      { bridgeEnabled: true, videoBridgeEnabled: false, authSource: undefined },
    );
    const snapshot = buildMediaReadinessSnapshot(config, { api_key: "ready" });

    expect(snapshot).toMatchObject({
      authSource: null,
      credential: { state: "blocked", reason: "auth_source_missing", provider: null },
      image: { state: "blocked", reason: "auth_source_missing" },
      video: { state: "disabled", reason: "disabled" },
    });
  });

  test("fails closed with canonical migration guidance for legacy xAI API-key aliases", () => {
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
      reason: "canonical_xai_provider_missing",
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
      .toMatchObject({ state: "blocked", reason: "canonical_xai_provider_missing" });

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

describe("provider-owned media route contract", () => {
  test("xAI owns a typed descriptor that is derived for settings but never seeded into config", () => {
    const xai = PROVIDER_REGISTRY.find(entry => entry.id === "xai")!;
    const descriptor = xai.media!;

    expect(descriptor).toMatchObject({
      version: 1,
      executor: "xai-media-v1",
      credentialSources: ["api_key", "subscription_oauth"],
      operations: {
        image: { model: "grok-imagine-image-2.0" },
        video: {
          model: "grok-imagine-video-1.5",
          modes: {
            text: { inputCount: { min: 0, max: 0 }, resolutions: ["480p", "720p", "1080p"] },
            starting_image: { inputCount: { min: 1, max: 1 }, resolutions: ["480p", "720p", "1080p"] },
            reference_images: { inputCount: { min: 1, max: 7 }, resolutions: ["480p", "720p"] },
          },
        },
      },
      inputLimits: {
        mimeTypes: ["image/jpeg", "image/png", "image/webp"],
        maxBytesPerImage: 20 * 1024 * 1024,
        maxAggregateDecodedBytes: 50 * 1024 * 1024,
        maxPixelsPerImage: 100_000_000,
        maxSerializedRequestBytes: 72 * 1024 * 1024,
      },
    });
    expect(deriveProviderPresets().find(row => row.id === "xai")?.media).toEqual(descriptor);
    expect(providerConfigSeed(xai)).not.toHaveProperty("media");
  });

  test("independent explicit None and invalid configured routes never fall back", () => {
    const config = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "test-token" } },
      { bridgeEnabled: true, videoBridgeEnabled: true, authSource: "api_key" },
    );
    config.media = { imageGenerator: null, videoGenerator: "removed-provider" };

    expect(resolveMediaRoute(config, "image")).toMatchObject({
      configured: null,
      source: "explicit",
      state: "none",
      providerId: null,
    });
    expect(resolveMediaRoute(config, "video")).toMatchObject({
      configured: "removed-provider",
      source: "explicit",
      state: "provider_missing",
      providerId: "removed-provider",
    });
  });

  test("a selected descriptor reports unsupported authentication separately from missing credentials", () => {
    const config = makeConfig(
      { xai: { baseUrl: "https://api.x.ai/v1", apiKey: "test-token" } },
      { bridgeEnabled: true, authSource: "api_key" },
    );
    config.media = { imageGenerator: "xai" };
    const xai = PROVIDER_REGISTRY.find(entry => entry.id === "xai")!;
    const original = xai.media!;
    xai.media = { ...original, credentialSources: ["subscription_oauth"] };
    try {
      expect(resolveMediaRoute(config, "image")).toMatchObject({ state: "auth_source_unsupported" });
      expect(buildMediaReadinessSnapshot(config, { api_key: "missing" }).image)
        .toMatchObject({ state: "blocked", reason: "auth_source_unsupported" });
    } finally {
      xai.media = original;
    }
  });
});

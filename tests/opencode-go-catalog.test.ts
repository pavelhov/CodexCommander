/**
 * OpenCode Go provider catalog + trusted transport registry drift guard.
 *
 * The registry pins the last-known-good Zen Go lineup (25 ids from
 * `GET https://opencode.ai/zen/go/v1/models`, verified 2026-08-05) and every trusted id owns
 * an explicit wire fact from the official endpoint table
 * (https://opencode.ai/docs/go/#endpoints):
 *
 * - Qwen 3.5/3.6/3.7/3.8 and MiniMax M2.5/M2.7/M3 -> Anthropic Messages (hard pin, types.ts)
 * - GPT-5.6 Luna and Grok 4.5                      -> OpenAI Responses (registry wire default)
 * - the remaining 15 known-compatible rows         -> OpenAI Chat Completions (wire default)
 *
 * The trust policy is registry-only and canonical-host-only: a same-named provider pointed at
 * any other destination receives none of it, and live-discovered ids outside the trusted set
 * are quarantined — never guessed onto a wire. Any upstream lineup drift flips one of these
 * assertions instead of silently changing routing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { listJawcodeModelMetadata } from "../src/generated/jawcode-model-metadata";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { resolveProviderModelDiscovery } from "../src/providers/model-discovery";
import {
  PROVIDER_REGISTRY,
  providerMatchesRegistryTransport,
  providerModelWireDefault,
  type ProviderRegistryEntry,
} from "../src/providers/registry";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { isWirePinnedModel, MODEL_ADAPTER_OVERRIDE_ALLOWED, type CodexCommanderConfig, type CodexCommanderProviderConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const CANONICAL_BASE_URL = "https://opencode.ai/zen/go/v1";
const CANONICAL_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

/** The approved last-good lineup (existence-only endpoint; see registry comment). */
const TRUSTED_MODEL_IDS = [
  "minimax-m3", "minimax-m2.7", "minimax-m2.5",
  "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
  "glm-5.2", "glm-5.1", "glm-5",
  "deepseek-v4-pro", "deepseek-v4-flash",
  "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus",
  "mimo-v2-pro", "mimo-v2-omni", "mimo-v2.5-pro", "mimo-v2.5",
  "hy3", "hy3-preview",
  "gpt-5.6-luna", "grok-4.5",
];
const ANTHROPIC_WIRE_MODEL_IDS = [
  "minimax-m2.5", "minimax-m2.7", "minimax-m3",
  "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max",
];
const RESPONSES_WIRE_MODEL_IDS = ["gpt-5.6-luna", "grok-4.5"];
const CHAT_WIRE_MODEL_IDS = TRUSTED_MODEL_IDS.filter(id =>
  !ANTHROPIC_WIRE_MODEL_IDS.includes(id) && !RESPONSES_WIRE_MODEL_IDS.includes(id));
/** Advertised but not Go-plan callable (issue #82): trusted id, compatibility-excluded from pickers. */
const COMPATIBILITY_EXCLUDED_IDS = ["hy3-preview"];
/** Trusted ids with no generated jawcode bundle row yet; the registry owns their metadata. */
const REGISTRY_OWNED_METADATA_IDS = ["gpt-5.6-luna", "hy3-preview", "qwen3.8-max"];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("opencode-go");
});

function registryEntry(): ProviderRegistryEntry {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "opencode-go");
  if (!entry) throw new Error("missing opencode-go registry entry");
  return entry;
}

function canonicalProvider(overrides: Partial<CodexCommanderProviderConfig> = {}): CodexCommanderProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: CANONICAL_BASE_URL,
    authMode: "key",
    apiKey: "go-test-key",
    ...overrides,
  } as CodexCommanderProviderConfig;
}

function canonicalConfig(overrides: Partial<CodexCommanderProviderConfig> = {}): CodexCommanderConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "opencode-go",
    providers: { "opencode-go": canonicalProvider(overrides) },
  } as unknown as CodexCommanderConfig);
}

function liveCatalogPayload(extraIds: string[] = []): string {
  return JSON.stringify({
    object: "list",
    data: [...TRUSTED_MODEL_IDS, ...extraIds].map(id => ({ id, object: "model", owned_by: "opencode" })),
  });
}

describe("OpenCode Go trusted catalog", () => {
  test("pins the canonical destination and the exact last-good 25 model ids", () => {
    const entry = registryEntry();
    expect(entry).toMatchObject({
      id: "opencode-go",
      adapter: "openai-chat",
      baseUrl: CANONICAL_BASE_URL,
      authKind: "key",
      liveModels: true,
      preserveCustomDestination: true,
    });
    expect(entry.models).toHaveLength(25);
    expect([...(entry.models ?? [])].sort()).toEqual([...TRUSTED_MODEL_IDS].sort());
    expect(new Set(entry.models).size).toBe(25);
    expect(entry.models).toContain(entry.defaultModel);
  });

  test("the live-discovery trust filter admits exactly the pinned ids", () => {
    const filter = registryEntry().modelDiscovery?.filter;
    expect(filter).toEqual({
      anyOf: [{ path: ["id"], equalsAny: expect.arrayContaining(TRUSTED_MODEL_IDS) }],
    });
    const equalsAny = (filter?.anyOf?.[0] as { equalsAny: readonly string[] }).equalsAny;
    expect([...equalsAny].sort()).toEqual([...TRUSTED_MODEL_IDS].sort());
  });

  test("config seeds and key-login derivations never persist the trust policy", () => {
    const seed = providerConfigSeed(registryEntry());
    expect(seed.models).toHaveLength(25);
    expect(seed.liveModels).toBe(true);
    for (const forbidden of ["modelDiscovery", "modelWireDefaults", "preserveCustomDestination"]) {
      expect(seed).not.toHaveProperty(forbidden);
      expect(KEY_LOGIN_PROVIDERS["opencode-go"]).not.toHaveProperty(forbidden);
    }
  });
});

describe("OpenCode Go per-model transport registry", () => {
  test("every trusted id owns exactly one explicit wire fact", () => {
    expect(ANTHROPIC_WIRE_MODEL_IDS).toHaveLength(8);
    expect(RESPONSES_WIRE_MODEL_IDS).toHaveLength(2);
    expect(CHAT_WIRE_MODEL_IDS).toHaveLength(15);
    expect([
      ...ANTHROPIC_WIRE_MODEL_IDS,
      ...RESPONSES_WIRE_MODEL_IDS,
      ...CHAT_WIRE_MODEL_IDS,
    ].sort()).toEqual([...TRUSTED_MODEL_IDS].sort());

    const defaults = registryEntry().modelWireDefaults ?? {};
    for (const id of RESPONSES_WIRE_MODEL_IDS) expect(defaults[id]).toBe("openai-responses");
    // The Anthropic rows are a hard pin in types.ts, and the chat rows keep the provider-wide
    // openai-chat adapter — neither belongs in an overridable wire-default map.
    for (const id of ANTHROPIC_WIRE_MODEL_IDS) {
      expect(isWirePinnedModel("opencode-go", id)).toBe(true);
      expect(defaults[id]).toBeUndefined();
    }
    for (const id of CHAT_WIRE_MODEL_IDS) expect(defaults[id]).toBeUndefined();
    expect(Object.keys(defaults).sort()).toEqual([...RESPONSES_WIRE_MODEL_IDS].sort());
  });

  test("resolves each trusted model onto its documented wire on the canonical host", () => {
    for (const id of ANTHROPIC_WIRE_MODEL_IDS) {
      expect(resolveWireProtocolOverride("opencode-go", id, canonicalProvider()).adapter).toBe("anthropic");
    }
    for (const id of RESPONSES_WIRE_MODEL_IDS) {
      expect(resolveWireProtocolOverride("opencode-go", id, canonicalProvider()).adapter).toBe("openai-responses");
    }
    for (const id of CHAT_WIRE_MODEL_IDS) {
      expect(resolveWireProtocolOverride("opencode-go", id, canonicalProvider()).adapter).toBe("openai-chat");
    }
  });

  test("a configured modelAdapters override still wins over a registry wire default", () => {
    // Registry defaults are defaults: an explicit, allowed override remains distinguishable
    // and wins. The Anthropic pin is the exception — config validation rejects overrides for
    // pinned models because the upstream speaks exactly one wire for them.
    const provider = canonicalProvider({ modelAdapters: { "grok-4.5": "openai-chat" } });
    expect(resolveWireProtocolOverride("opencode-go", "grok-4.5", provider).adapter).toBe("openai-chat");
    expect(MODEL_ADAPTER_OVERRIDE_ALLOWED.has("openai-chat")).toBe(true);
  });

  test("trust facts never attach to a same-named provider on a lookalike destination", () => {
    const lookalike = canonicalProvider({ baseUrl: "https://evil.example/zen/go/v1" });
    expect(providerMatchesRegistryTransport("opencode-go", lookalike)).toBe(false);
    expect(
      providerModelWireDefault("opencode-go", lookalike, "grok-4.5", MODEL_ADAPTER_OVERRIDE_ALLOWED, "responses"),
    ).toBeUndefined();
    expect(resolveWireProtocolOverride("opencode-go", "grok-4.5", lookalike).adapter).toBe("openai-chat");
    expect(resolveProviderModelDiscovery("opencode-go", lookalike).spec).toBeUndefined();

    const enriched: CodexCommanderProviderConfig = { adapter: "openai-chat", baseUrl: "https://evil.example/zen/go/v1" };
    enrichProviderFromRegistry("opencode-go", enriched);
    expect(enriched.models).toBeUndefined();
    expect(enriched.liveModels).toBeUndefined();

    // A different adapter on the canonical URL is also a custom row: registry facts detach.
    const rewired = canonicalProvider({ adapter: "openai-responses" });
    expect(providerMatchesRegistryTransport("opencode-go", rewired)).toBe(false);
    expect(resolveWireProtocolOverride("opencode-go", "glm-5.2", rewired).adapter).toBe("openai-responses");

    // The Anthropic pin is a correctness pin (the upstream speaks one wire for these models),
    // not a trust fact — it is deliberately destination-independent.
    expect(resolveWireProtocolOverride("opencode-go", "minimax-m3", lookalike).adapter).toBe("anthropic");
  });
});

describe("OpenCode Go live-catalog quarantine", () => {
  test("unknown live models are quarantined; advertised-but-uncallable rows stay hidden", async () => {
    let requestedUrl: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(liveCatalogPayload(["future-live-model"]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const models = await gatherRoutedModels(canonicalConfig());
    const ids = models.filter(row => row.provider === "opencode-go").map(row => row.id);

    expect(requestedUrl).toBe(CANONICAL_MODELS_URL);
    expect(ids.sort()).toEqual(
      TRUSTED_MODEL_IDS.filter(id => !COMPATIBILITY_EXCLUDED_IDS.includes(id)).sort(),
    );
    expect(ids).not.toContain("future-live-model");
    expect(ids).not.toContain("hy3-preview");

    // Registry-owned metadata reaches rows the generated bundle does not cover yet.
    expect(models.find(row => row.id === "qwen3.8-max")).toMatchObject({
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
    });
    expect(models.find(row => row.id === "gpt-5.6-luna")).toMatchObject({
      contextWindow: 1_050_000,
      inputModalities: ["text", "image"],
    });
  });

  test("a failed live discovery falls back to the pinned static lineup", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const models = await gatherRoutedModels(canonicalConfig());
    const ids = models.filter(row => row.provider === "opencode-go").map(row => row.id);

    expect(ids.sort()).toEqual(
      TRUSTED_MODEL_IDS.filter(id => !COMPATIBILITY_EXCLUDED_IDS.includes(id)).sort(),
    );
  });

  test("the generated jawcode bundle stays inside the trusted set with a named metadata gap", () => {
    const bundleIds = listJawcodeModelMetadata("opencode-go").map(row => row.id);
    expect(new Set(bundleIds).size).toBe(bundleIds.length);
    for (const id of bundleIds) {
      expect(TRUSTED_MODEL_IDS).toContain(id);
    }
    // If a regeneration adds or drops bundle rows, this exact gap flips and forces a conscious
    // review here instead of silently changing catalog metadata.
    expect(TRUSTED_MODEL_IDS.filter(id => !bundleIds.includes(id)).sort())
      .toEqual([...REGISTRY_OWNED_METADATA_IDS].sort());
    for (const id of COMPATIBILITY_EXCLUDED_IDS) expect(bundleIds).not.toContain(id);
  });
});

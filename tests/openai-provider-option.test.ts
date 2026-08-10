import { describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../src/config";
import { deriveInitProviders, deriveProviderPresets, listRegistryEntries, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry, providerCodexAccountMode } from "../src/providers/registry";
import {
  isCanonicalOpenAiForwardProvider,
  OPENAI_API_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
} from "../src/providers/openai-tiers";

describe("OpenAI single-provider option foundation", () => {
  test("locks exact ids and modes", () => {
    expect(OPENAI_CODEX_PROVIDER_ID).toBe("openai");
    expect(OPENAI_API_PROVIDER_ID).toBe("openai-apikey");
    expect(providerCodexAccountMode("openai")).toBe("pool");
    expect(providerCodexAccountMode("openai", { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "direct" })).toBe("direct");
    expect(providerCodexAccountMode("openai-apikey")).toBeUndefined();
    expect(providerCodexAccountMode("custom-forward")).toBeUndefined();
  });

  test("accepts canonical transport with either account mode", () => {
    const canonical = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward" as const,
    };
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, codexAccountMode: "pool" })).toBe(true);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, codexAccountMode: "direct", baseUrl: `${canonical.baseUrl}/` })).toBe(true);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, adapter: "openai-chat" })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, authMode: "key" })).toBe(false);
    expect(isCanonicalOpenAiForwardProvider({ ...canonical, baseUrl: `${canonical.baseUrl}?x=1` })).toBe(false);
  });

  test("publishes one Codex-login registry, preset, init, and default row", () => {
    for (const rows of [listRegistryEntries(), deriveProviderPresets(), deriveInitProviders()]) {
      expect(rows.filter(entry => entry.id === OPENAI_CODEX_PROVIDER_ID)).toHaveLength(1);
    }
    const registry = getProviderRegistryEntry(OPENAI_CODEX_PROVIDER_ID)!;
    expect(providerConfigSeed(registry)).toMatchObject({ codexAccountMode: "pool" });
    expect(getDefaultConfig().providers.openai).toMatchObject({ codexAccountMode: "pool" });
  });
});

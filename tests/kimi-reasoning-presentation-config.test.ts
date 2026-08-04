import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/codex/catalog";
import { applyProviderConfigHints } from "../src/codex/catalog/provider-fetch";
import { getDefaultConfig, validateConfigCandidate } from "../src/config";
import {
  deriveKeyLoginMap,
  deriveOAuthProviderConfig,
  enrichProviderFromRegistry,
  providerConfigSeed,
} from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { routeModel } from "../src/router";
import { providerManagementConfigError } from "../src/server/auth-cors";
import type { OcxProviderConfig } from "../src/types";

describe("Kimi reasoning-content presentation config", () => {
  test("accepts only raw or summary at disk and management validation boundaries", () => {
    const defaults = getDefaultConfig();
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      reasoningContentMode: "raw",
    } satisfies OcxProviderConfig;

    expect(validateConfigCandidate({
      ...defaults,
      defaultProvider: "custom",
      providers: { custom: provider },
    }).ok).toBe(true);
    expect(providerManagementConfigError("custom", provider)).toBeNull();

    const invalid = { ...provider, reasoningContentMode: "progress" };
    expect(validateConfigCandidate({
      ...defaults,
      defaultProvider: "custom",
      providers: { custom: invalid },
    }).ok).toBe(false);
    expect(providerManagementConfigError("custom", invalid)).toBe(
      "provider custom reasoningContentMode must be one of: raw, summary",
    );
  });

  test("canonical OAuth and API-key Kimi seeds inherit summary presentation without overriding user choices", () => {
    expect(deriveOAuthProviderConfig("kimi")).toMatchObject({
      reasoningContentMode: "summary",
      modelSupportsReasoningSummaries: { k3: true, "k3[1m]": true },
    });
    expect(deriveKeyLoginMap()["kimi-code"]).toMatchObject({
      reasoningContentMode: "summary",
      modelSupportsReasoningSummaries: { k3: true, "k3[1m]": true },
    });

    for (const providerId of ["kimi", "kimi-code"]) {
      const entry = getProviderRegistryEntry(providerId)!;
      const seed = providerConfigSeed(entry);

      expect(seed.reasoningContentMode).toBe("summary");
      expect(seed.modelSupportsReasoningSummaries).toEqual({ k3: true, "k3[1m]": true });
      expect(seed.modelDefaultReasoningEfforts?.k3).toBe("max");

      const existing: OcxProviderConfig = {
        adapter: entry.adapter,
        baseUrl: entry.baseUrl,
      };
      enrichProviderFromRegistry(providerId, existing);
      expect(existing.reasoningContentMode).toBe("summary");
      expect(existing.modelSupportsReasoningSummaries).toEqual({ k3: true, "k3[1m]": true });

      const optedOut: OcxProviderConfig = {
        adapter: entry.adapter,
        baseUrl: entry.baseUrl,
        reasoningContentMode: "raw",
        modelSupportsReasoningSummaries: { k3: false },
      };
      enrichProviderFromRegistry(providerId, optedOut);
      expect(optedOut.reasoningContentMode).toBe("raw");
      expect(optedOut.modelSupportsReasoningSummaries).toEqual({ k3: false, "k3[1m]": true });
    }
  });

  test("runtime routing backfills stale persisted Kimi providers and preserves explicit opt-outs", () => {
    const defaults = getDefaultConfig();
    for (const providerId of ["kimi", "kimi-code"]) {
      const entry = getProviderRegistryEntry(providerId)!;
      const staleProvider: OcxProviderConfig = {
        adapter: entry.adapter,
        baseUrl: entry.baseUrl,
        authMode: entry.authKind === "oauth" ? "oauth" : "key",
        models: ["k3", "k3[1m]"],
      };
      const staleConfig = {
        ...defaults,
        defaultProvider: providerId,
        providers: { [providerId]: staleProvider },
      };

      const routed = routeModel(staleConfig, `${providerId}/k3`).provider;
      expect(routed.reasoningContentMode).toBe("summary");
      expect(routed.modelSupportsReasoningSummaries).toEqual({ k3: true, "k3[1m]": true });
      expect(staleProvider.reasoningContentMode).toBeUndefined();
      expect(staleProvider.modelSupportsReasoningSummaries).toBeUndefined();

      const optedOut = routeModel({
        ...staleConfig,
        providers: { [providerId]: {
          ...staleProvider,
          reasoningContentMode: "raw" as const,
          modelSupportsReasoningSummaries: { k3: false },
        } },
      }, `${providerId}/k3`).provider;
      expect(optedOut.reasoningContentMode).toBe("raw");
      expect(optedOut.modelSupportsReasoningSummaries).toEqual({ k3: false, "k3[1m]": true });
    }

  });

  test("advertises summaries for K3 variants while preserving Ultra and conservative legacy rows", () => {
    const provider = providerConfigSeed(getProviderRegistryEntry("kimi")!);
    const models = ["k3", "k3[1m]", "kimi-k2.7-code"].map(id =>
      applyProviderConfigHints("kimi", provider, { provider: "kimi", id }));
    const entries = buildCatalogEntries(null, [], models);
    const bySlug = new Map(entries.map(entry => [entry.slug, entry]));

    for (const slug of ["kimi/k3", "kimi/k3[1m]"]) {
      const entry = bySlug.get(slug);
      expect(entry?.supports_reasoning_summaries).toBe(true);
      expect(entry?.default_reasoning_level).toBe("max");
      expect((entry?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
        .toContain("ultra");
    }
    expect(bySlug.get("kimi/kimi-k2.7-code")?.supports_reasoning_summaries).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  CODEX_NATIVE_ALIAS_CATALOG_KIND,
  applyNativeVisibility,
  buildCatalogEntries,
  desktopAllowlistSuppressedNativeSlugs,
  exactComboCatalogSlugs,
  mergeCatalogEntriesForSync,
  mergeCatalogModelsWithNativeRecovery,
  mergeLiveRoutedEntriesWithRetained,
  nativeModelRows,
} from "../src/codex/catalog";
import {
  catalogHasRoutedEntries,
  findNativeTemplate,
  type CatalogModel,
  type RawEntry,
} from "../src/codex/catalog/parsing";
import {
  comboConfigError,
  comboDisabledModelSelectors,
} from "../src/combos";
import { routeModel } from "../src/router";
import type { CodexCommanderConfig } from "../src/types";

const slug = "gpt-5.6-sol";

function aliasModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "nova-sol",
    provider: "combo",
    alias: slug,
    nativeAlias: true,
    displayName: "Nova1 - Sol",
    owned_by: "combo",
    contextWindow: 128_000,
    maxInputTokens: 100_000,
    inputModalities: ["text", "image"],
    reasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "medium",
    ...overrides,
  };
}

describe("Codex Desktop native-alias compatibility", () => {
  test("requires an explicit supported and labeled native alias", () => {
    const providers = {
      nova: { adapter: "openai-chat", baseUrl: "https://nova.example/v1" },
    } as CodexCommanderConfig["providers"];
    const target = { targets: [{ provider: "nova", model: "codex/gpt-5.6-sol" }] };

    expect(comboConfigError("route", { ...target, alias: slug }, providers))
      .toContain("nativeAlias=true");
    expect(comboConfigError("route", { ...target, alias: slug, nativeAlias: true }, providers))
      .toContain("displayName is required");
    expect(comboConfigError("route", {
      ...target,
      alias: slug,
      nativeAlias: true,
      displayName: "Nova1 - Sol",
    }, providers)).toBeNull();
    expect(comboDisabledModelSelectors("nova", { alias: slug, nativeAlias: true }))
      .toEqual(["combo/nova"]);
  });

  test("routes a bare alias before native OpenAI while preserving exact account routing", () => {
    const config: CodexCommanderConfig = {
      port: 10100,
      defaultProvider: "a",
      providers: {
        a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", models: ["m1"] },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
      codexAccountNamespaces: { main: "@main" },
      combos: {
        nova: {
          alias: slug,
          nativeAlias: true,
          displayName: "Nova1 - Sol",
          targets: [{ provider: "a", model: "m1" }],
        },
      },
    };

    expect(routeModel(config, slug)).toMatchObject({
      providerName: "a",
      modelId: "m1",
      combo: { comboId: "nova" },
    });
    expect(routeModel(config, "combo/nova")).toMatchObject({ providerName: "a", modelId: "m1" });
    expect(routeModel(config, `main/${slug}`)).toMatchObject({
      providerName: "openai",
      modelId: slug,
      codexAccountNamespace: "main",
    });
  });

  test("replaces the native picker row with one labeled routed row", () => {
    const rows = buildCatalogEntries(
      null,
      [slug],
      [aliasModel()],
      [slug],
      false,
      "default",
      new Set([slug]),
      ["main"],
      new Set([slug]),
    );
    expect(rows.filter(row => row.slug === slug)).toEqual([
      expect.objectContaining({
        display_name: "Nova1 - Sol",
        owned_by: "combo",
        codexcommander_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
        priority: 0,
      }),
    ]);
    expect(rows.find(row => row.slug === `main/${slug}`)?.priority).not.toBe(0);
    expect(applyNativeVisibility(rows, new Set([slug])).find(row => row.slug === slug)?.visibility)
      .toBe("list");
  });

  test("omits disabled native account clones while keeping the compatibility combo", () => {
    const rows = buildCatalogEntries(
      null,
      [slug],
      [aliasModel()],
      undefined,
      false,
      "default",
      new Set([slug]),
      ["main"],
      new Set([slug]),
      new Set([slug]),
    );
    expect(rows.find(row => row.slug === slug)?.codexcommander_catalog_kind)
      .toBe(CODEX_NATIVE_ALIAS_CATALOG_KIND);
    expect(rows.find(row => row.slug === `main/${slug}`)).toBeUndefined();
  });

  test("a separately generated account clone does not inherit a featured native-alias rank", () => {
    const rows = buildCatalogEntries(
      null,
      [slug],
      [],
      [slug],
      false,
      "default",
      new Set([slug]),
      ["main"],
      new Set([slug]),
    );
    expect(rows.find(row => row.slug === `main/${slug}`)?.priority).not.toBe(0);
  });

  test("treats native aliases as routed state and never as native templates", () => {
    const routedAlias: RawEntry = {
      slug,
      base_instructions: "template",
      owned_by: "combo",
      codexcommander_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
    };
    expect(catalogHasRoutedEntries({ models: [routedAlias] })).toBe(true);
    expect(findNativeTemplate({ models: [routedAlias] })).toBeNull();
  });

  test("deep-clones native recovery metadata", () => {
    const source: RawEntry = {
      slug,
      supported_reasoning_levels: [{ effort: "medium" }],
      service_tiers: [{ id: "priority", display_name: "Fast" }],
    };
    const recovered = mergeCatalogModelsWithNativeRecovery([], [[source]])[0]!;
    (recovered.supported_reasoning_levels as Array<unknown>).push({ effort: "ultra" });
    (recovered.service_tiers as Array<Record<string, unknown>>)[0]!.display_name = "Changed";
    expect(source.supported_reasoning_levels).toEqual([{ effort: "medium" }]);
    expect(source.service_tiers).toEqual([{ id: "priority", display_name: "Fast" }]);
  });

  test("preserves a configured native alias across an empty routed gather", () => {
    const existing: RawEntry = {
      slug,
      display_name: "Nova1 - Sol",
      owned_by: "combo",
      codexcommander_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
      visibility: "list",
    };
    const rows = mergeCatalogEntriesForSync(
      [existing], [], new Map(), [], false, new Set(), null, new Set(), new Set(),
      "default", new Set([slug]), false, true, [], [slug], new Set([slug]),
    );
    expect(rows.find(row => row.slug === slug)).toMatchObject({
      display_name: "Nova1 - Sol",
      codexcommander_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
    });
  });

  test("does not retain a native alias when every backing provider is disabled", () => {
    const config: CodexCommanderConfig = {
      port: 10100,
      defaultProvider: "nova",
      providers: {
        nova: {
          adapter: "openai-chat",
          baseUrl: "https://nova.example/v1",
          disabled: true,
        },
      },
      combos: {
        nova: {
          alias: slug,
          nativeAlias: true,
          displayName: "Nova1 - Sol",
          targets: [{ provider: "nova", model: "sol" }],
        },
      },
    };
    const retained: RawEntry = {
      slug,
      display_name: "Nova1 - Sol",
      owned_by: "combo",
      codexcommander_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
      visibility: "list",
    };
    expect(exactComboCatalogSlugs(config)).toEqual(new Set());
    expect(mergeLiveRoutedEntriesWithRetained(
      [],
      { models: [retained] },
      config,
      new Set(),
      false,
    )).toEqual({ entries: [], retainedRows: [] });
  });

  test("a provider model with a native-looking raw id cannot erase native metadata", () => {
    const native: RawEntry = {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Native",
      base_instructions: "native instructions",
      comp_hash: "trusted-native-hash",
      priority: 4,
      visibility: "list",
    };
    const routed: RawEntry = {
      slug: "vendor/gpt-5.5",
      display_name: "vendor/gpt-5.5",
      description: "Routed via CodexCommander → vendor (vendor).",
      base_instructions: "routed instructions",
      priority: 5,
      visibility: "list",
    };
    const rows = mergeCatalogEntriesForSync(
      [native],
      [routed],
      new Map(),
      [],
      false,
      new Set(["gpt-5.5"]),
      native,
      new Set(),
      new Set(["vendor"]),
      "default",
      new Set(),
      false,
      true,
      [],
      ["gpt-5.5"],
    );
    expect(rows.find(row => row.slug === "gpt-5.5")).toMatchObject({
      comp_hash: "trusted-native-hash",
      base_instructions: "native instructions",
    });
    expect(rows.some(row => row.slug === "vendor/gpt-5.5")).toBe(true);
  });

  test("hides the shadowed native management row and activates allowlist pruning", () => {
    const config = {
      disabledModels: [slug, "gpt-5.5"],
      combos: {
        nova: {
          alias: slug,
          nativeAlias: true,
          displayName: "Nova1 - Sol",
          targets: [{ provider: "nova", model: "codex/gpt-5.6-sol" }],
        },
      },
    };
    expect(nativeModelRows(config).some(row => row.slug === slug)).toBe(false);
    expect(desktopAllowlistSuppressedNativeSlugs(config))
      .toEqual(new Set([slug, "gpt-5.5"]));
  });
});

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readCodexCatalogPath, resetCatalogRuntimeStateForTests, syncCatalogModels } from "../src/codex/catalog";
import type { CodexCommanderConfig } from "../src/types";

setDefaultTimeout(30_000);

async function syncCatalog(config: Pick<CodexCommanderConfig, "providers"> & Partial<CodexCommanderConfig>): Promise<string> {
  const warnings: string[] = [];
  const warning = spyOn(console, "warn").mockImplementation((...values) => {
    warnings.push(values.map(String).join(" "));
  });
  try {
    await syncCatalogModels({
      port: 10100,
      defaultProvider: Object.keys(config.providers)[0] ?? "openai",
      ...config,
    } as CodexCommanderConfig, testCatalogDeps());
    return warnings.join("\n");
  } finally {
    warning.mockRestore();
  }
}

function nativeEntry(slug: string, priority: number): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "native",
    priority,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [{ effort: "medium", description: "m" }],
  };
}

function testCatalogDeps() {
  return {
    commandCandidates: () => ["codex-fixture"],
    execFileSync: () => JSON.stringify({ models: [nativeEntry("gpt-5.5", 0)] }),
  };
}

function routedEntry(slug: string, priority: number): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "routed",
    priority,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [],
  };
}

/** Row shape CodexCommander itself generates for routed models (ownership signature). */
function ccxAuthoredEntry(slug: string, priority: number): Record<string, unknown> {
  return {
    ...routedEntry(slug, priority),
    description: `Routed via CodexCommander → ${slug} (test-owner).`,
  };
}

describe("Codex catalog sync hardening", () => {
  let codexHome: string;
  let codexCommanderHome: string;
  let previousCodexHome: string | undefined;
  let previousCodexCommanderHome: string | undefined;

  beforeEach(() => {
    previousCodexHome = process.env.CODEX_HOME;
    previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
    codexHome = mkdtempSync(join(tmpdir(), "ccx-sync-home-"));
    codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-sync-ccx-"));
    process.env.CODEX_HOME = codexHome;
    process.env.CODEXCOMMANDER_HOME = codexCommanderHome;
    resetCatalogRuntimeStateForTests();
  });

  afterEach(() => {
    resetCatalogRuntimeStateForTests();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
    if (existsSync(codexHome)) rmSync(codexHome, { recursive: true, force: true });
    if (existsSync(codexCommanderHome)) rmSync(codexCommanderHome, { recursive: true, force: true });
  });

  test("Gap B: drops retired OpenAI-family natives but keeps supported + user natives", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        nativeEntry("gpt-5.4", 1),
        nativeEntry("gpt-5.4-mini", 2),
        nativeEntry("gpt-5.3-codex-spark", 3),
        nativeEntry("gpt-5.6-sol", 4),
        nativeEntry("gpt-5.6-terra", 5),
        nativeEntry("gpt-5.6-luna", 6),
        nativeEntry("gpt-5.3-codex", 104),   // retired -> drop
        nativeEntry("gpt-5.2", 104),          // retired -> drop
        nativeEntry("codex-auto-review", 104),// retired -> drop
        nativeEntry("user-native", 10),       // user-added -> keep
      ],
    }, null, 2) + "\n");

    await syncCatalog({ providers: {} });

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("gpt-5.5");
    expect(slugs).toContain("gpt-5.4");
    expect(slugs).toContain("gpt-5.4-mini");
    expect(slugs).toContain("gpt-5.3-codex-spark");
    expect(slugs).toContain("gpt-5.6-sol");
    expect(slugs).toContain("gpt-5.6-terra");
    expect(slugs).toContain("gpt-5.6-luna");
    expect(slugs).toContain("user-native");           // genuine user native preserved
    expect(slugs).not.toContain("gpt-5.3-codex");      // retired dropped
    expect(slugs).not.toContain("gpt-5.2");            // retired dropped
    expect(slugs).not.toContain("codex-auto-review");  // retired dropped
  });

  test("Gap A: an empty routed fetch preserves existing routed entries on disk", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        { slug: "kiro/claude-opus-4.8", display_name: "kiro", description: "r", priority: 5, visibility: "list", base_instructions: "x", supported_reasoning_levels: [] },
        { slug: "opencode-go/glm-5.2", display_name: "go", description: "r", priority: 5, visibility: "list", base_instructions: "x", supported_reasoning_levels: [] },
      ],
    }, null, 2) + "\n");

    // config has NO providers => gatherRoutedModels returns [] (transient empty fetch).
    const warnings = await syncCatalog({ providers: {} });
    expect(warnings).toContain("routed model fetch returned empty; preserving 2 existing routed entries");

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("kiro/claude-opus-4.8");   // routed preserved despite empty fetch
    expect(slugs).toContain("opencode-go/glm-5.2");
    expect(slugs).toContain("gpt-5.5");
  });

  test("account rows reconcile idempotently and independently from provider outages", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    const firstCatalogPath = join(codexCommanderHome, "first-catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    const accountMarker = "account-selector-v1";
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        {
          ...nativeEntry("gpt-5.5", 0),
          comp_hash: "native-5.5-hash",
          base_instructions: "Native 5.5 instructions",
          model_messages: { instructions_template: "Native 5.5 instructions" },
          tool_mode: null,
          context_window: 128_000,
          max_context_window: 128_000,
          auto_compact_token_limit: 115_200,
        },
        {
          ...nativeEntry("gpt-5.4", 1),
          comp_hash: "native-5.4-hash",
          base_instructions: "Native 5.4 instructions",
          model_messages: { instructions_template: "Native 5.4 instructions" },
          tool_mode: "code_mode_only",
        },
        nativeEntry("gpt-5.4-mini", 2),
        routedEntry("vendor/stable-model", 5),
        { ...routedEntry("foreign/gpt-5.5", 6), description: "Foreign provider description" },
        {
          ...routedEntry("team/gpt-5.5", 7),
          display_name: "Stale provider row with a colliding slug",
        },
        {
          ...nativeEntry("removed/gpt-5.5", 8),
          description: "Retired generated row",
          codexcommander_catalog_kind: accountMarker,
        },
      ],
    }, null, 2) + "\n");

    const config: Pick<CodexCommanderConfig, "providers"> & Partial<CodexCommanderConfig> = {
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          liveModels: false,
        },
      },
      codexAccounts: [{
        id: "stored-team-account",
        email: "private@example.test",
        alias: "Private Display Name",
        isMain: false,
      }],
      codexAccountNamespaces: {
        desktop: "@main",
        team: "stored-team-account",
        removed: "missing-account",
      },
    };
    const firstWarnings = await syncCatalog(config);
    writeFileSync(firstCatalogPath, readFileSync(catalogPath));
    const secondWarnings = await syncCatalog(config);
    const warnings = `${firstWarnings}\n${secondWarnings}`;
    expect(warnings).toContain("routed model fetch returned empty; preserving 2 existing routed entries");
    expect(warnings).not.toContain("account selector collision");

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      display_name?: string;
      description?: string;
      visibility?: string;
      comp_hash?: string;
      codexcommander_catalog_kind?: string;
      base_instructions?: string;
      model_messages?: { instructions_template?: string };
      tool_mode?: string | null;
      context_window?: number;
      max_context_window?: number;
      auto_compact_token_limit?: number;
    }>;
    const firstRows = JSON.parse(readFileSync(firstCatalogPath, "utf8")).models as typeof rows;
    expect(rows).toEqual(firstRows);
    const firstBare = firstRows.find(row => row.slug === "gpt-5.5");
    const firstTeam = firstRows.find(row => row.slug === "team/gpt-5.5");
    expect(firstBare).toMatchObject({
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 244_800,
    });
    expect(firstTeam).toMatchObject({
      context_window: firstBare?.context_window,
      max_context_window: firstBare?.max_context_window,
      auto_compact_token_limit: firstBare?.auto_compact_token_limit,
    });
    expect(rows.some(row => row.slug === "vendor/stable-model")).toBe(true);
    expect(rows.some(row => row.slug === "foreign/gpt-5.5")).toBe(true);
    expect(rows.some(row => row.slug === "removed/gpt-5.5")).toBe(false);
    expect(rows.find(row => row.slug === "gpt-5.5")?.visibility).toBe("hide");
    expect(rows.find(row => row.slug === "desktop/gpt-5.5")?.visibility).toBe("list");
    const bare = rows.find(row => row.slug === "gpt-5.5");
    const team = rows.find(row => row.slug === "team/gpt-5.5");
    expect(team).toMatchObject({
      display_name: "team / 5.5",
      codexcommander_catalog_kind: accountMarker,
      comp_hash: "native-5.5-hash",
      visibility: "list",
    });
    expect(team?.description).toBe(bare?.description);
    expect(rows.filter(row => row.slug === "team/gpt-5.5")).toHaveLength(1);
    for (const selector of ["desktop", "team"]) {
      expect(rows.some(row => row.slug === `${selector}/gpt-5.4`)).toBe(true);
      expect(rows.some(row => row.slug === `${selector}/gpt-5.4-mini`)).toBe(true);
    }
    for (const nativeSlug of ["gpt-5.5", "gpt-5.4"]) {
      const native = rows.find(row => row.slug === nativeSlug);
      const qualified = rows.find(row => row.slug === `team/${nativeSlug}`);
      expect(qualified).toMatchObject({
        comp_hash: native?.comp_hash,
        base_instructions: native?.base_instructions,
        model_messages: native?.model_messages,
        tool_mode: native?.tool_mode,
      });
    }
    expect(JSON.stringify(rows)).not.toContain("stored-team-account");
    expect(JSON.stringify(rows)).not.toContain("private@example.test");
    expect(JSON.stringify(rows)).not.toContain("Private Display Name");
  });

  test("a live provider row shadowed by an account selector warns once per runtime generation", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [nativeEntry("gpt-5.5", 0)],
    }, null, 2) + "\n");

    const config: Pick<CodexCommanderConfig, "providers"> & Partial<CodexCommanderConfig> = {
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          liveModels: false,
        },
        team: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          liveModels: false,
          models: ["gpt-5.5"],
        },
      },
      codexAccounts: [{ id: "stored-team-account", isMain: false }],
      codexAccountNamespaces: { team: "stored-team-account" },
    };
    const firstWarnings = await syncCatalog(config);
    const secondWarnings = await syncCatalog(config);
    resetCatalogRuntimeStateForTests();
    const thirdWarnings = await syncCatalog(config);
    const warnings = `${firstWarnings}\n${secondWarnings}\n${thirdWarnings}`;
    expect((warnings.match(/account selector collision on "team\/gpt-5\.5"/g) ?? []).length).toBe(2);

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      codexcommander_catalog_kind?: string;
    }>;
    expect(rows.filter(row => row.slug === "team/gpt-5.5")).toEqual([
      expect.objectContaining({ codexcommander_catalog_kind: "account-selector-v1" }),
    ]);
  });

  test("non-OpenAI-only sync omits account rows without reprioritizing routed models", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({ models: [nativeEntry("gpt-5.5", 0)] }, null, 2) + "\n");

    await syncCatalog({
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          liveModels: false,
          models: ["static-model"],
        },
      },
      codexAccountNamespaces: { desktop: "@main" },
    });

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      priority?: number;
    }>;
    expect(rows.find(row => row.slug === "mock/static-model")?.priority).toBe(5);
    expect(rows.some(row => row.slug === "gpt-5.5")).toBe(false);
    expect(rows.some(row => row.slug === "desktop/gpt-5.5")).toBe(false);
  });

  test("disabled canonical OpenAI keeps bare bootstrap rows but omits unrouteable account rows", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [nativeEntry("gpt-5.5", 0)],
    }, null, 2) + "\n");

    await syncCatalog({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          disabled: true,
          liveModels: false,
        },
      },
      codexAccounts: [{ id: "stored-side-account", isMain: false }],
      codexAccountNamespaces: { team: "stored-side-account" },
    });

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      visibility?: string;
    }>;
    expect(rows.find(row => row.slug === "gpt-5.5")?.visibility).toBe("list");
    expect(rows.some(row => row.slug.startsWith("team/"))).toBe(false);
  });

  test("account sync recovers supported natives that were hidden before selectors existed", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        { ...nativeEntry("gpt-5.5", 0), visibility: "hide" },
        nativeEntry("gpt-5.4", 1),
      ],
    }, null, 2) + "\n");

    await syncCatalog({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          liveModels: false,
        },
      },
      disabledModels: ["gpt-5.4", "team/gpt-5.5"],
      codexAccounts: [{ id: "stored-side-account", isMain: false }],
      codexAccountNamespaces: { desktop: "@main", team: "stored-side-account" },
    });

    const rows = JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{
      slug: string;
      visibility?: string;
      codexcommander_catalog_kind?: string;
    }>;
    expect(rows.find(row => row.slug === "gpt-5.5")?.visibility).toBe("hide");
    // Generated rows recover from stale bare visibility, but still honor explicit native disables.
    expect(rows.find(row => row.slug === "team/gpt-5.5")).toMatchObject({
      visibility: "hide",
      codexcommander_catalog_kind: "account-selector-v1",
    });
    expect(rows.find(row => row.slug === "desktop/gpt-5.5")).toMatchObject({
      visibility: "list",
      codexcommander_catalog_kind: "account-selector-v1",
    });
    expect(rows.find(row => row.slug === "team/gpt-5.4")?.visibility).toBe("hide");
  });

  test("default catalog path merges from disk instead of replacing it with bundled rows", async () => {
    const catalogPath = join(codexHome, "codexcommander-catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'openai_base_url = "http://127.0.0.1:10100/v1"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        nativeEntry("user-native", 4),
        routedEntry("kiro/claude-opus-4.8", 5),
        routedEntry("opencode-go/glm-5.2", 6),
      ],
    }, null, 2) + "\n");

    // Force the default-path bundled shortcut to succeed. The fixture intentionally returns only
    // a native row so this test fails if sync uses the bundled catalog as its merge input.
    const warnings = await syncCatalog({ providers: {} });
    expect(warnings).toContain("routed model fetch returned empty; preserving 2 existing routed entries");

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("gpt-5.5");
    expect(slugs).toContain("user-native");
    expect(slugs).toContain("kiro/claude-opus-4.8");
    expect(slugs).toContain("opencode-go/glm-5.2");
  });

  test("empty routed refresh drops compatibility-excluded rows while preserving other routed entries", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        routedEntry("kiro/claude-opus-4.8", 5),
        routedEntry("opencode-go/glm-5.2", 6),
        routedEntry("opencode-go/hy3-preview", 7),
      ],
    }, null, 2) + "\n");

    const warnings = await syncCatalog({ providers: {} });
    expect(warnings).toContain("routed model fetch returned empty; preserving 2 existing routed entries");

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("kiro/claude-opus-4.8");
    expect(slugs).toContain("opencode-go/glm-5.2");
    expect(slugs).not.toContain("opencode-go/hy3-preview");
  });

  /*
   * #759. A provider advertised `input_modalities: [..., "video"]`, which Codex parses as a
   * closed text|image|audio enum, so it rejected the ENTIRE catalog file: plugins, apps and
   * MCP servers all went to zero over one model's metadata, with only "Unable to load apps"
   * on screen.
   *
   * The provider-side filter and the ensureStrictCatalogFields normalization cover entry
   * construction, and unit tests already pin those. This covers the case those miss: a
   * poisoned row ALREADY on disk, which sync deliberately preserves when no provider is
   * configured and must repair on the way back out.
   *
   * The model must survive. Asserting only "no video in the output" would pass just as
   * happily if sync dropped the row instead of cleaning it, which would quietly delete a
   * provider model and call it a fix.
   */
  test("a poisoned routed row already on disk is repaired, not dropped, by the next sync", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    const poisoned = {
      ...routedEntry("zenmux/meta-muse-spark-1.1", 5),
      input_modalities: ["text", "image", "video"],
    };
    writeFileSync(catalogPath, JSON.stringify({
      models: [nativeEntry("gpt-5.5", 0), poisoned],
    }, null, 2) + "\n");

    await syncCatalog({ providers: {} });

    const written = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models: Array<{ slug: string; input_modalities?: unknown }>;
    };
    const row = written.models.find(m => m.slug === "zenmux/meta-muse-spark-1.1");
    // Survives the sync rather than being discarded as unparseable.
    expect(row).toBeDefined();
    expect(row!.input_modalities).toEqual(["text", "image"]);

    // And nothing anywhere in the written file is outside the enum Codex accepts, because one
    // bad value in any entry rejects the whole file.
    const outOfEnum = written.models.flatMap(m => (
      Array.isArray(m.input_modalities)
        ? (m.input_modalities as unknown[]).filter(v => v !== "text" && v !== "image" && v !== "audio")
        : []
    ));
    expect(outOfEnum).toEqual([]);
  });

  /*
   * #855. Deleting a provider must remove the rows CodexCommander generated for it
   * on the next sync. Rows authored by foreign tooling (Cursor, user edits)
   * stay preserved — the ownership signature in the generated description is
   * what separates the two.
   */
  test("drops CodexCommander-authored rows of a deleted provider, keeps foreign rows", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        ccxAuthoredEntry("future-grok/old-model", 5),
        routedEntry("cursor/composer-2.5", 6),
      ],
    }, null, 2) + "\n");

    await syncCatalog({
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          liveModels: false,
          models: ["fresh-model"],
        },
      },
    });

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).not.toContain("future-grok/old-model");
    expect(slugs).toContain("cursor/composer-2.5");
    expect(slugs).toContain("openai/fresh-model");
  });

  test("empty-gather transient protection still drops deleted-provider ghost rows", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        ccxAuthoredEntry("future-grok/old-model", 5),
        ccxAuthoredEntry("openai/keep-model", 6),
        routedEntry("cursor/composer-2.5", 7),
      ],
    }, null, 2) + "\n");

    // A configured provider that gathers zero rows: sync takes the
    // preserve-existing branch. The deleted provider's authored row must
    // still go; the configured provider's authored row and the foreign row
    // stay (transient protection).
    await syncCatalog({
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          liveModels: false,
          models: [],
        },
      },
    });

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).not.toContain("future-grok/old-model");
    expect(slugs).toContain("openai/keep-model");
    expect(slugs).toContain("cursor/composer-2.5");
  });

  test("preserves existing routed entries for providers absent from the current sync config", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        routedEntry("cursor/composer-2.5", 5),
        routedEntry("openai/stale-model", 6),
      ],
    }, null, 2) + "\n");

    await syncCatalog({
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          liveModels: false,
          models: ["fresh-model"],
        },
      },
    });

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("cursor/composer-2.5");
    expect(slugs).toContain("openai/fresh-model");
    expect(slugs).not.toContain("openai/stale-model");
  });

  test("replaces existing routed entries for providers present in the current sync config", async () => {
    const catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, JSON.stringify({
      models: [
        nativeEntry("gpt-5.5", 0),
        routedEntry("cursor/stale-model", 5),
        routedEntry("xai/grok-5-code", 6),
      ],
    }, null, 2) + "\n");

    await syncCatalog({
      providers: {
        cursor: {
          adapter: "cursor",
          baseUrl: "https://api2.cursor.sh",
          liveModels: false,
          models: ["composer-2.5"],
        },
      },
    });

    const slugs = (JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(m => m.slug);
    expect(slugs).toContain("cursor/composer-2.5");
    expect(slugs).toContain("xai/grok-5-code");
    expect(slugs).not.toContain("cursor/stale-model");
  });

  test("readCodexCatalogPath honors CODEX_HOME at call time", () => {
    const alternateHome = join(codexHome, "alternate-codex-home");
    mkdirSync(alternateHome, { recursive: true });
    writeFileSync(join(alternateHome, "config.toml"), 'model_catalog_json = "nested/catalog.json"\n', "utf8");

    process.env.CODEX_HOME = alternateHome;
    expect(readCodexCatalogPath()).toBe(resolve(realpathSync.native(alternateHome), "nested/catalog.json"));
  });
});

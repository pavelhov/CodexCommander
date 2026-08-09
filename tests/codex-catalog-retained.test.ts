import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resetCatalogRuntimeStateForTests,
  syncCatalogModels,
} from "../src/codex/catalog";
import { retainedRoutedCatalogPath } from "../src/codex/catalog/parsing";
import {
  CONFIG_UNINSTALL_MANIFEST,
  recordOwnedConfigPath,
} from "../src/lib/config-ownership";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

function nativeEntry(slug = "gpt-5.5"): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "native",
    priority: 0,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [{ effort: "medium", description: "m" }],
  };
}

function nativeCatalog(): string {
  return `${JSON.stringify({ models: [nativeEntry()] }, null, 2)}\n`;
}

function catalogDeps() {
  return {
    commandCandidates: () => ["codex-fixture"],
    execFileSync: () => JSON.stringify({ models: [nativeEntry()] }),
  };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://models.example.test/v1",
    ...overrides,
  } as OcxProviderConfig;
}

function config(providers: Record<string, OcxProviderConfig>, overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: Object.keys(providers)[0] ?? "openai",
    providers,
    ...overrides,
  } as OcxConfig;
}

function liveEmptyProvider(): OcxProviderConfig {
  return provider({
    liveModels: true,
    fetch: ((input: RequestInfo | URL) => globalThis.fetch(input)) as typeof fetch,
  } as Partial<OcxProviderConfig>);
}

describe("retained routed Codex catalog", () => {
  let codexHome: string;
  let opencodexHome: string;
  let catalogPath: string;
  let previousCodexHome: string | undefined;
  let previousOpenCodexHome: string | undefined;

  beforeEach(() => {
    previousCodexHome = process.env.CODEX_HOME;
    previousOpenCodexHome = process.env.OPENCODEX_HOME;
    codexHome = mkdtempSync(join(tmpdir(), "ocx-retained-codex-"));
    opencodexHome = mkdtempSync(join(tmpdir(), "ocx-retained-home-"));
    process.env.CODEX_HOME = codexHome;
    process.env.OPENCODEX_HOME = opencodexHome;
    // Initialize the same owned-home metadata a normal OpenCodex install has;
    // the snapshot write itself must add its path to this existing manifest.
    expect(recordOwnedConfigPath(opencodexHome, join(opencodexHome, "config.json"))).toBe(true);
    catalogPath = join(codexHome, "catalog.json");
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n', "utf8");
    writeFileSync(catalogPath, nativeCatalog(), "utf8");
    globalThis.fetch = (async () => Response.json({ data: [] })) as typeof fetch;
    resetCatalogRuntimeStateForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCatalogRuntimeStateForTests();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpenCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(opencodexHome, { recursive: true, force: true });
  });

  test("a live routed sync creates an owned mode-600 last-known-good snapshot", async () => {
    const result = await syncCatalogModels(config({
      vendor: provider({ liveModels: false, models: ["alpha"] }),
    }), catalogDeps());

    expect(result.catalogQuality).toBe("live");
    expect(result.rehydrated).toBe(0);
    const snapshotPath = retainedRoutedCatalogPath();
    expect(existsSync(snapshotPath)).toBe(true);
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { models: Array<{ slug: string }> };
    expect(snapshot.models.map(model => model.slug)).toContain("vendor/alpha");
    const manifest = JSON.parse(readFileSync(join(opencodexHome, CONFIG_UNINSTALL_MANIFEST), "utf8")) as {
      paths: string[];
    };
    expect(manifest.paths).toContain("codex-routed-retained.json");
  });

  test("native restore plus empty live discovery rehydrates the retained routed catalog", async () => {
    const liveConfig = config({
      vendor: provider({ liveModels: false, models: ["alpha"] }),
    });
    await syncCatalogModels(liveConfig, catalogDeps());
    const retainedBefore = readFileSync(retainedRoutedCatalogPath(), "utf8");

    writeFileSync(catalogPath, nativeCatalog(), "utf8");
    resetCatalogRuntimeStateForTests();
    const result = await syncCatalogModels(config({ vendor: liveEmptyProvider() }), catalogDeps());

    expect(result.catalogQuality).toBe("retained");
    expect(result.rehydrated).toBe(1);
    const active = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<{ slug: string }> };
    expect(active.models.map(model => model.slug)).toContain("vendor/alpha");
    expect(readFileSync(retainedRoutedCatalogPath(), "utf8")).toBe(retainedBefore);
  });

  test("partial discovery combines live providers with retained missing providers", async () => {
    await syncCatalogModels(config({
      vendor: provider({ liveModels: false, models: ["alpha"] }),
      peer: provider({ liveModels: false, models: ["beta"] }),
    }), catalogDeps());

    writeFileSync(catalogPath, nativeCatalog(), "utf8");
    resetCatalogRuntimeStateForTests();
    const result = await syncCatalogModels(config({
      vendor: provider({ liveModels: false, models: ["alpha"] }),
      peer: liveEmptyProvider(),
    }), catalogDeps());

    expect(result.catalogQuality).toBe("retained");
    expect(result.rehydrated).toBe(1);
    const active = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<{ slug: string }> };
    const slugs = active.models.map(model => model.slug);
    expect(slugs).toContain("vendor/alpha");
    expect(slugs).toContain("peer/beta");
  });

  test("removed, disabled, and intentionally empty providers are never resurrected", async () => {
    await syncCatalogModels(config({
      vendor: provider({ liveModels: false, models: ["alpha"] }),
      removed: provider({ liveModels: false, models: ["old"] }),
    }), catalogDeps());

    writeFileSync(catalogPath, nativeCatalog(), "utf8");
    resetCatalogRuntimeStateForTests();
    const disabled = await syncCatalogModels(config(
      { vendor: liveEmptyProvider() },
      { disabledModels: ["vendor/alpha"] },
    ), catalogDeps());
    expect(disabled.catalogQuality).toBe("native-only");
    let active = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<{ slug: string }> };
    expect(active.models.map(model => model.slug)).not.toContain("vendor/alpha");
    expect(active.models.map(model => model.slug)).not.toContain("removed/old");

    writeFileSync(catalogPath, nativeCatalog(), "utf8");
    resetCatalogRuntimeStateForTests();
    const intentionallyEmpty = await syncCatalogModels(config({
      vendor: provider({ liveModels: false, models: [] }),
    }), catalogDeps());
    expect(intentionallyEmpty.catalogQuality).toBe("native-only");
    active = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<{ slug: string }> };
    expect(active.models.map(model => model.slug)).not.toContain("vendor/alpha");
  });
});

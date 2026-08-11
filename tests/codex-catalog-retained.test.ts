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
} from "../src/codex/catalog";
import { retainedRoutedCatalogPath } from "../src/codex/catalog/parsing";
import {
  CONFIG_UNINSTALL_MANIFEST,
  recordOwnedConfigPath,
} from "../src/lib/config-ownership";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../src/types";
import { convergeCatalogForTest } from "./helpers/catalog-convergence";

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

function provider(overrides: Partial<CodexCommanderProviderConfig> = {}): CodexCommanderProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://models.example.test/v1",
    ...overrides,
  } as CodexCommanderProviderConfig;
}

function config(providers: Record<string, CodexCommanderProviderConfig>, overrides: Partial<CodexCommanderConfig> = {}): CodexCommanderConfig {
  return {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    defaultProvider: Object.keys(providers)[0] ?? "openai",
    providers,
    ...overrides,
  } as CodexCommanderConfig;
}

function liveEmptyProvider(): CodexCommanderProviderConfig {
  return provider({
    liveModels: true,
  } as Partial<CodexCommanderProviderConfig>);
}

describe("retained routed Codex catalog", () => {
  let codexHome: string;
  let codexCommanderHome: string;
  let catalogPath: string;
  let previousCodexHome: string | undefined;
  let previousCodexCommanderHome: string | undefined;

  beforeEach(() => {
    previousCodexHome = process.env.CODEX_HOME;
    previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
    codexHome = mkdtempSync(join(tmpdir(), "ccx-retained-codex-"));
    codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-retained-home-"));
    process.env.CODEX_HOME = codexHome;
    process.env.CODEXCOMMANDER_HOME = codexCommanderHome;
    // Initialize the same owned-home metadata a normal CodexCommander install has;
    // the snapshot write itself must add its path to this existing manifest.
    expect(recordOwnedConfigPath(codexCommanderHome, join(codexCommanderHome, "config.json"))).toBe(true);
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
    if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(codexCommanderHome, { recursive: true, force: true });
  });

  test("a live routed sync creates an owned mode-600 last-known-good snapshot", async () => {
    const result = await convergeCatalogForTest(config({
      vendor: provider({ liveModels: false, models: ["alpha"] }),
    }));

    expect(result.catalogQuality).toBe("live");
    expect(result.rehydrated).toBe(0);
    const snapshotPath = retainedRoutedCatalogPath();
    expect(existsSync(snapshotPath)).toBe(true);
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { models: Array<{ slug: string }> };
    expect(snapshot.models.map(model => model.slug)).toContain("vendor/alpha");
    const manifest = JSON.parse(readFileSync(join(codexCommanderHome, CONFIG_UNINSTALL_MANIFEST), "utf8")) as {
      paths: string[];
    };
    expect(manifest.paths).toContain("codex-routed-retained.json");
  });

  test("native restore plus empty live discovery rehydrates the retained routed catalog", async () => {
    const liveConfig = config({
      vendor: provider({ liveModels: false, models: ["alpha"] }),
    });
    await convergeCatalogForTest(liveConfig);
    const retainedBefore = readFileSync(retainedRoutedCatalogPath(), "utf8");

    writeFileSync(catalogPath, nativeCatalog(), "utf8");
    resetCatalogRuntimeStateForTests();
    const result = await convergeCatalogForTest(config({ vendor: liveEmptyProvider() }));

    expect(result.catalogQuality).toBe("retained");
    expect(result.rehydrated).toBe(1);
    const active = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<{ slug: string }> };
    expect(active.models.map(model => model.slug)).toContain("vendor/alpha");
    expect(readFileSync(retainedRoutedCatalogPath(), "utf8")).toBe(retainedBefore);
  });

  test("partial discovery combines live providers with retained missing providers", async () => {
    await convergeCatalogForTest(config({
      vendor: provider({ liveModels: false, models: ["alpha"] }),
      peer: provider({ liveModels: false, models: ["beta"] }),
    }));

    writeFileSync(catalogPath, nativeCatalog(), "utf8");
    resetCatalogRuntimeStateForTests();
    const result = await convergeCatalogForTest(config({
      vendor: provider({ liveModels: false, models: ["alpha"] }),
      peer: liveEmptyProvider(),
    }));

    expect(result.catalogQuality).toBe("retained");
    expect(result.rehydrated).toBe(1);
    const active = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<{ slug: string }> };
    const slugs = active.models.map(model => model.slug);
    expect(slugs).toContain("vendor/alpha");
    expect(slugs).toContain("peer/beta");
  });

  test("removed, disabled, and intentionally empty providers are never resurrected", async () => {
    await convergeCatalogForTest(config({
      vendor: provider({ liveModels: false, models: ["alpha"] }),
      removed: provider({ liveModels: false, models: ["old"] }),
    }));

    writeFileSync(catalogPath, nativeCatalog(), "utf8");
    resetCatalogRuntimeStateForTests();
    const disabled = await convergeCatalogForTest(config(
      { vendor: liveEmptyProvider() },
      { disabledModels: ["vendor/alpha"] },
    ));
    expect(disabled.catalogQuality).toBe("native-only");
    let active = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<{ slug: string }> };
    expect(active.models.map(model => model.slug)).not.toContain("vendor/alpha");
    expect(active.models.map(model => model.slug)).not.toContain("removed/old");

    writeFileSync(catalogPath, nativeCatalog(), "utf8");
    resetCatalogRuntimeStateForTests();
    const intentionallyEmpty = await convergeCatalogForTest(config({
      vendor: provider({ liveModels: false, models: [] }),
    }));
    expect(intentionallyEmpty.catalogQuality).toBe("native-only");
    active = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<{ slug: string }> };
    expect(active.models.map(model => model.slug)).not.toContain("vendor/alpha");
  });
});

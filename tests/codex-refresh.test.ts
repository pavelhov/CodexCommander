import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateCodexModelsCache } from "../src/codex/catalog";
import { getDefaultConfig } from "../src/config";
import { refreshCodexModelCatalog, type RefreshDeps } from "../src/codex/refresh";
import type { ConvergeRequest } from "../src/codex/convergence-types";
import type { CodexCommanderConfig } from "../src/types";

const config: CodexCommanderConfig = getDefaultConfig();

const tempHomes: string[] = [];

function installTempHomes(): { codexHome: string; codexCommanderHome: string; restore(): void } {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
  const codexHome = mkdtempSync(join(tmpdir(), "ccx-refresh-codex-"));
  const codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-refresh-ccx-"));
  tempHomes.push(codexHome, codexCommanderHome);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEXCOMMANDER_HOME = codexCommanderHome;

  return {
    codexHome,
    codexCommanderHome,
    restore() {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(codexCommanderHome, { recursive: true, force: true });
    },
  };
}

function nativeCatalogFixture(slug = "gpt-5.5"): string {
  return JSON.stringify({
    models: [{
      slug,
      display_name: slug,
      description: "native",
      priority: 9,
      visibility: "list",
      base_instructions: "You are Codex, a coding agent based on GPT-5.",
      supported_reasoning_levels: [{ effort: "medium", description: "m" }],
    }],
  }, null, 2) + "\n";
}

afterEach(() => {
  for (const path of tempHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Codex catalog refresh", () => {
  test("projects the canonical convergence result and fixed explicit request", async () => {
    let request: ConvergeRequest | undefined;
    const result = await refreshCodexModelCatalog(config, {
      prepareConfigGeneration: () => {},
      captureCatalogAdmissionSnapshot: () => ({} as never),
      convergeCodexCatalog: async (_snapshot, received) => {
        request = received;
        return {
          changed: true,
          catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] },
          projection: {
            admittedGeneration: { value: 7 },
            admittedConfigAuthority: {
              generation: { value: 7 },
              semanticIdentity: "semantic",
              contentIdentity: "content",
            },
            added: 2,
            path: "/tmp/codexcommander-catalog.json",
            catalogWritten: true,
            cacheSynced: true,
            comboOmissions: [],
            catalogQuality: "live",
            rehydrated: 0,
          },
        };
      },
      existsSync: () => true,
    } as RefreshDeps);

    expect(request).toEqual({
      action: "converge",
      scope: "catalog",
      reason: "api-sync",
      mode: "explicit",
      deadlineMs: 1_000,
    });
    expect(result).toMatchObject({
      added: 2,
      path: "/tmp/codexcommander-catalog.json",
      catalogExists: true,
      catalogWritten: true,
      cacheSynced: true,
      catalogQuality: "live",
      rehydrated: 0,
    });
  });

  test("reports catalogWritten true after canonical convergence rewrites a real catalog file", async () => {
    const home = installTempHomes();
    try {
      const catalogPath = join(home.codexHome, "nested", "catalog.json");
      mkdirSync(join(home.codexHome, "nested"), { recursive: true });
      writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "nested/catalog.json"\n', "utf8");
      writeFileSync(catalogPath, nativeCatalogFixture("gpt-5.6-sol"), "utf8");
      const before = readFileSync(catalogPath, "utf8");

      const result = await refreshCodexModelCatalog(config);
      const after = readFileSync(catalogPath, "utf8");
      const rewritten = JSON.parse(after);

      expect(result.path).toBe(join(realpathSync.native(home.codexHome), "nested", "catalog.json"));
      expect(result.catalogWritten).toBe(true);
      expect(after).not.toBe(before);
      expect(rewritten.models[0].slug).toBe("gpt-5.6-sol");
      expect(rewritten.models[0].display_name).toBe("GPT-5.6-Sol");
      expect(rewritten.models[0].context_window).toBeGreaterThan(0);
    } finally {
      home.restore();
    }
  });

  test("invalidateCodexModelsCache reports real cache write success and failure cases", () => {
    const success = installTempHomes();
    try {
      writeFileSync(join(success.codexHome, "config.toml"), 'model_catalog_json = "codexcommander-catalog.json"\n', "utf8");
      writeFileSync(join(success.codexHome, "codexcommander-catalog.json"), nativeCatalogFixture("gpt-5.6-sol"), "utf8");

      expect(invalidateCodexModelsCache()).toBe(true);
      const cache = JSON.parse(readFileSync(join(success.codexHome, "models_cache.json"), "utf8"));
      expect(cache.fetched_at).toBe("2000-01-01T00:00:00Z");
      expect(cache.client_version).toBe("0.0.0");
      expect(cache.models[0].slug).toBe("gpt-5.6-sol");
    } finally {
      success.restore();
    }

    const missingCatalog = installTempHomes();
    try {
      writeFileSync(join(missingCatalog.codexHome, "config.toml"), 'model_catalog_json = "missing-catalog.json"\n', "utf8");

      expect(invalidateCodexModelsCache()).toBe(false);
      expect(existsSync(join(missingCatalog.codexHome, "models_cache.json"))).toBe(false);
    } finally {
      missingCatalog.restore();
    }

    const malformedCatalog = installTempHomes();
    try {
      writeFileSync(join(malformedCatalog.codexHome, "config.toml"), 'model_catalog_json = "codexcommander-catalog.json"\n', "utf8");
      writeFileSync(join(malformedCatalog.codexHome, "codexcommander-catalog.json"), "{not-json", "utf8");

      expect(invalidateCodexModelsCache()).toBe(false);
      expect(existsSync(join(malformedCatalog.codexHome, "models_cache.json"))).toBe(false);
    } finally {
      malformedCatalog.restore();
    }

    const unwritableCache = installTempHomes();
    try {
      writeFileSync(join(unwritableCache.codexHome, "config.toml"), 'model_catalog_json = "codexcommander-catalog.json"\n', "utf8");
      writeFileSync(join(unwritableCache.codexHome, "codexcommander-catalog.json"), nativeCatalogFixture(), "utf8");
      mkdirSync(join(unwritableCache.codexHome, "models_cache.json"));

      expect(invalidateCodexModelsCache()).toBe(false);
    } finally {
      unwritableCache.restore();
    }
  });
});

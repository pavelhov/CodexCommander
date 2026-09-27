import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lastNativeDiscoveryStatus,
  peekNativeLiveCatalog,
  refreshNativeLiveCatalog,
  resetNativeLiveCatalogStateForTests,
} from "../src/codex/catalog/native-live";
import { degradedNativeDiscoveryDrops } from "../src/codex/convergence";
import * as runtimeModule from "../src/codex/runtime";
import { persistCodexRuntime, resetCodexRuntimeResolveCacheForTests, resolveCodexRuntime } from "../src/codex/runtime";
import { resetBundledCatalogCacheForTests } from "../src/codex/catalog/bundled";
import { resetSupportedNativeSlugMemoForTests } from "../src/codex/catalog/metadata";
import { resetCatalogRuntimeStateForTests } from "../src/codex/catalog";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import { getDefaultConfig, saveConfig } from "../src/config";
import * as nativeProfileStartup from "../src/codex/native-profile-startup";
import { bundledCatalogFixture, createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";
import type { CodexCommanderConfig } from "../src/types";

const previousHome = process.env.CODEX_HOME;
const previousConfig = process.env.CODEXCOMMANDER_HOME;
const previousCli = process.env.CODEX_CLI_PATH;
const previousPath = process.env.PATH;
const dirs: string[] = [];

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousConfig === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousConfig;
  if (previousCli === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCli;
  process.env.PATH = previousPath;
  resetNativeLiveCatalogStateForTests();
  resetBundledCatalogCacheForTests();
  resetCodexRuntimeResolveCacheForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccx-native-guard-"));
  dirs.push(dir);
  return dir;
}

const token = { accessToken: "fixture-token", chatgptAccountId: "fixture-account" };
const row = (slug: string) => ({ slug, display_name: slug, supported_reasoning_levels: [], context_window: 1000 });
const gpt6 = ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"];

function modelsResponse(slugs: string[]): Response {
  return new Response(JSON.stringify({ models: slugs.map(row) }), { headers: { "content-type": "application/json" } });
}

function openAiConfig(extra: Partial<CodexCommanderConfig> = {}): CodexCommanderConfig {
  return {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    defaultProvider: "openai",
    ...extra,
  } as CodexCommanderConfig;
}

describe("native discovery with a broken runtime probe", () => {
  test("falls back to the persisted runtime and keeps the retained identity", async () => {
    const dir = tempDir();
    const good = { command: "/fixture/codex", version: "0.150.0", source: "configured" as const };
    persistCodexRuntime(good, { configDir: dir });
    const base = { configDir: dir, codexHome: dir, token };
    const first = await refreshNativeLiveCatalog({ ...base, runtime: good, fetch: async () => modelsResponse(gpt6) });
    expect(first.source).toBe("live");

    const broken = { command: "codex", version: null, source: "fallback" as never };
    const retained = await refreshNativeLiveCatalog({
      ...base, runtime: broken, force: true, fetch: async () => { throw new Error("offline"); },
    });
    expect(retained.source).toBe("retained");
    expect(retained.identity).toBe(first.identity);
    expect(retained.catalog?.models?.map(model => model.slug)).toEqual(gpt6);

    let url = "";
    const live = await refreshNativeLiveCatalog({
      ...base, runtime: broken, force: true, fetch: async input => { url = String(input); return modelsResponse(gpt6); },
    });
    expect(live.source).toBe("live");
    expect(live.identity).toBe(first.identity);
    expect(url).toContain("client_version=0.150.0");
  });

  test("an explicit CODEX_CLI_PATH that differs from the persisted command does not reuse it", async () => {
    const dir = tempDir();
    persistCodexRuntime({ command: "/fixture/codex", version: "0.150.0", source: "configured" }, { configDir: dir });
    process.env.CODEX_CLI_PATH = "/fixture/other-codex";
    const result = await refreshNativeLiveCatalog({
      configDir: dir, codexHome: dir, token, runtime: { command: "codex", version: null, source: "fallback" } as never,
      fetch: async () => modelsResponse(gpt6),
    });
    expect(result).toMatchObject({ source: "unavailable", reason: "runtime" });
  });

  test("reports runtime only without any usable runtime, and auth only without a token", async () => {
    const dir = tempDir();
    const runtime = await refreshNativeLiveCatalog({
      configDir: dir, codexHome: dir, token, runtime: { command: "codex", version: "not-a-version", source: "fallback" } as never,
      fetch: async () => modelsResponse(gpt6),
    });
    expect(runtime).toMatchObject({ source: "unavailable", reason: "runtime" });
    expect(lastNativeDiscoveryStatus()).toEqual({ source: "unavailable", reason: "runtime", fetchedAt: null });

    const good = { command: "/fixture/codex", version: "0.150.0", source: "configured" as const };
    const auth = await refreshNativeLiveCatalog({ configDir: dir, codexHome: dir, token: null, runtime: good, fetch: async () => modelsResponse(gpt6) });
    expect(auth).toMatchObject({ source: "unavailable", reason: "auth" });
    expect(peekNativeLiveCatalog({ configDir: dir, codexHome: dir, token: null, runtime: good })).toMatchObject({ reason: "auth" });
  });

  test("a failure outside claim contention is not reported as busy", async () => {
    const dir = tempDir();
    const result = await refreshNativeLiveCatalog({
      configDir: dir, codexHome: dir, token,
      runtime: () => { throw new Error("probe crashed"); },
      fetch: async () => modelsResponse(gpt6),
    });
    expect(result.source).toBe("unavailable");
    expect(result.reason).toBe("runtime");
  });
});

describe("degraded native discovery guard", () => {
  const prior = { models: [...gpt6, "gpt-5.6-sol"].map(row) };
  const shrunk = { models: ["gpt-5.6-sol"].map(row) };
  const unavailable = { source: "unavailable", catalog: null, fetchedAt: null, identity: null, reason: "runtime" } as const;
  const runtimeReason = { source: "unavailable", reason: "runtime", fetchedAt: null } as const;

  test("flags prior native models the degraded candidate would drop", () => {
    expect(degradedNativeDiscoveryDrops(openAiConfig(), unavailable, prior, shrunk, false, runtimeReason).sort()).toEqual([...gpt6].sort());
  });

  test("allows legitimate publishes", () => {
    // Fresh home: no prior evidence.
    expect(degradedNativeDiscoveryDrops(openAiConfig(), unavailable, null, shrunk, false, runtimeReason)).toEqual([]);
    // Genuine logout.
    expect(degradedNativeDiscoveryDrops(openAiConfig(), { ...unavailable, reason: "auth" }, prior, shrunk, false,
      { source: "unavailable", reason: "auth", fetchedAt: null })).toEqual([]);
    // Native OpenAI excluded by provider configuration.
    const noOpenAi = openAiConfig({
      providers: { other: { adapter: "anthropic", baseUrl: "https://example.invalid" } } as never,
      defaultProvider: "other",
    });
    expect(degradedNativeDiscoveryDrops(noOpenAi, unavailable, prior, shrunk, false, runtimeReason)).toEqual([]);
    // User-disabled models.
    expect(degradedNativeDiscoveryDrops(openAiConfig({ disabledModels: gpt6 }), unavailable, prior, shrunk, false, runtimeReason)).toEqual([]);
    // Admitted live or retained native catalog.
    expect(degradedNativeDiscoveryDrops(openAiConfig(), { ...unavailable, source: "retained", catalog: shrunk, reason: undefined } as never,
      prior, shrunk, false, runtimeReason)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("restart with a broken runtime probe", () => {
  function setup(dir: string) {
    process.env.CODEX_HOME = dir;
    process.env.CODEXCOMMANDER_HOME = dir;
    const catalog = bundledCatalogFixture(gpt6);
    const cli = createCodexRuntimeFixture(dir, { version: "0.150.0", catalog });
    process.env.CODEX_CLI_PATH = cli;
    resetCodexRuntimeResolveCacheForTests();
    const runtime = resolveCodexRuntime({ discoverAlternatives: false }).runtime;
    persistCodexRuntime(runtime, { configDir: dir });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "fixture-account" } }));
    writeFileSync(join(dir, "codexcommander-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
    const config = openAiConfig();
    saveConfig(config);
    return { cli, runtime, catalog, config };
  }

  function breakRuntime(cli: string) {
    // The menu bar app runs with a bare PATH, so the bare `codex` fallback
    // cannot reach a developer's installed CLI either.
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    writeFileSync(cli, "#!/bin/sh\nexit 1\n", "utf8");
    resetCodexRuntimeResolveCacheForTests();
    resetBundledCatalogCacheForTests();
    resetNativeLiveCatalogStateForTests();
    resetSupportedNativeSlugMemoForTests();
    resetCatalogRuntimeStateForTests();
    // Reproduce the incident's failed probe exactly, and keep discovery from
    // reaching an app bundle installed on the test machine.
    // The command is a missing temp path so no installed CLI is ever executed.
    return spyOn(runtimeModule, "resolveAndPersistCodexRuntime").mockReturnValue({
      runtime: { command: join(cli, "..", "missing-fallback-codex"), version: null, source: "fallback" },
      failures: [],
    });
  }

  function slugs(path: string): string[] {
    return (JSON.parse(readFileSync(path, "utf8")).models as { slug: string }[]).map(model => model.slug);
  }

  test("keeps gpt-6 models when a matching retained snapshot exists", async () => {
    const dir = tempDir();
    const { cli, runtime, config } = setup(dir);
    let probe: ReturnType<typeof spyOn> | undefined;
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("offline"); }) as never);
    try {
      const seeded = await refreshNativeLiveCatalog({ runtime, force: true, fetch: async () => modelsResponse(gpt6) });
      expect(seeded.source).toBe("live");
      probe = breakRuntime(cli);
      await refreshCodexModelCatalog(config);
      const catalogPath = join(dir, "codexcommander-catalog.json");
      expect(slugs(catalogPath)).toEqual(expect.arrayContaining(gpt6));
      expect(lastNativeDiscoveryStatus()?.reason ?? null).not.toBe("auth");
    } finally {
      probe?.mockRestore();
      blocked.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("skips and writes nothing when discovery is degraded without a snapshot", async () => {
    const dir = tempDir();
    const { cli, config } = setup(dir);
    const cachePath = join(dir, "models_cache.json");
    writeFileSync(cachePath, `${JSON.stringify({ fetched_at: "2000-01-01T00:00:00Z", client_version: "0.0.0", models: gpt6.map(row) })}\n`);
    let probe: ReturnType<typeof spyOn> | undefined;
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("offline"); }) as never);
    try {
      probe = breakRuntime(cli);
      // The incident's persisted selection was an unusable wrapper too, so
      // neither the probe nor the persisted runtime yields a bundled catalog.
      persistCodexRuntime({ command: join(dir, "missing-codex"), version: null, source: "configured" }, { configDir: dir });
      const catalogPath = join(dir, "codexcommander-catalog.json");
      const beforeCatalog = readFileSync(catalogPath, "utf8");
      const beforeCache = readFileSync(cachePath, "utf8");
      const result = await refreshCodexModelCatalog(config);
      expect(result.catalogDisposition).toMatchObject({ status: "skipped", reason: "busy", retryable: true });
      expect(readFileSync(catalogPath, "utf8")).toBe(beforeCatalog);
      expect(readFileSync(cachePath, "utf8")).toBe(beforeCache);
      expect(lastNativeDiscoveryStatus()?.reason).toBe("runtime");
    } finally {
      probe?.mockRestore();
      blocked.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("a fresh home without prior evidence still publishes", async () => {
    const dir = tempDir();
    const { config } = setup(dir);
    const catalogPath = join(dir, "codexcommander-catalog.json");
    rmSync(catalogPath);
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("offline"); }) as never);
    try {
      resetNativeLiveCatalogStateForTests();
      const result = await refreshCodexModelCatalog(config);
      expect(result.catalogDisposition?.status).not.toBe("skipped");
      expect(existsSync(catalogPath)).toBe(true);
    } finally {
      blocked.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

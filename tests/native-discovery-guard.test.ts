import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lastNativeDiscoveryStatus,
  peekNativeLiveCatalog,
  refreshNativeLiveCatalog,
  resetNativeLiveCatalogStateForTests,
  nativeLiveCatalogSnapshotPath,
} from "../src/codex/catalog/native-live";
import { carriedNativeDiscoveryRows } from "../src/codex/convergence";
import * as runtimeModule from "../src/codex/runtime";
import { persistCodexRuntime, resetCodexRuntimeResolveCacheForTests, resolveCodexRuntime } from "../src/codex/runtime";
import { resetBundledCatalogCacheForTests } from "../src/codex/catalog/bundled";
import { resetSupportedNativeSlugMemoForTests, supportedNativeOpenAiSlugSet } from "../src/codex/catalog/metadata";
import { resetCatalogRuntimeStateForTests } from "../src/codex/catalog";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import { getDefaultConfig, saveConfig } from "../src/config";
import * as nativeProfileStartup from "../src/codex/native-profile-startup";
import { bundledCatalogFixture, createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";
import type { CodexCommanderConfig } from "../src/types";
import { readCodexTokensResult } from "../src/codex/auth-collision";
import { routeModel } from "../src/router";
import { createManagementConvergeCodex } from "../src/codex/management-convergence";
import { createCatalogConvergeRequest } from "../src/codex/catalog-admission";
import { startServer } from "../src/server/index";
import { configuredSubagentModelMatchesEntry, effectiveSubagentRoster } from "../src/codex/catalog/sync";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "../src/codex/catalog/account-models";
import { currentNativeCatalogOwner, nativeCatalogOwnerDecision, nativeCatalogOwnerPath, writeNativeCatalogOwner } from "../src/codex/catalog/native-owner";
import { nativeOpenAiContextWindow } from "../src/codex/catalog/metadata";
import { nativeEffortClamp } from "../src/codex/catalog/effort";

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
  test("classifies a malformed credential as transient and a valid empty object as signed out", async () => {
    const dir = tempDir();
    process.env.CODEX_HOME = dir;
    const path = join(dir, "auth.json");
    writeFileSync(path, "{");
    expect(readCodexTokensResult().status).toBe("invalid");
    const options = { codexHome: dir, configDir: dir, runtime: { command: "/fixture/codex", version: "0.150.0" } };
    expect((await refreshNativeLiveCatalog(options)).reason).toBe("credentials");
    writeFileSync(path, "{}");
    expect(readCodexTokensResult().status).toBe("signed-out");
    expect((await refreshNativeLiveCatalog(options)).reason).toBe("auth");
    unlinkSync(path);
    expect(readCodexTokensResult().status).toBe("missing");
    expect((await refreshNativeLiveCatalog(options)).reason).toBe("auth");
  });

  test("keeps a successful fetch when runtime persistence fails", async () => {
    const dir = tempDir();
    const runtime = { command: "/fixture/codex", version: "0.150.0", source: "configured" as const };
    const probe = spyOn(runtimeModule, "resolveAndPersistCodexRuntime").mockReturnValue({ runtime, failures: [], persistError: "disk" });
    try {
      const result = await refreshNativeLiveCatalog({ configDir: dir, codexHome: dir, token, fetch: async () => modelsResponse(gpt6) });
      expect(result.source).toBe("live");
      expect(peekNativeLiveCatalog({ configDir: dir, codexHome: dir, token }).catalog?.models?.map(model => model.slug)).toEqual(gpt6);
    } finally { probe.mockRestore(); }
  });

  test("keeps fetched rows in process when the snapshot cannot be written", async () => {
    const dir = tempDir();
    const blockedPath = join(dir, "not-a-directory");
    writeFileSync(blockedPath, "fixture");
    const runtime = { command: "/fixture/codex", version: "0.150.0" };
    const result = await refreshNativeLiveCatalog({ configDir: blockedPath, codexHome: dir, token,
      runtime, fetch: async () => modelsResponse(gpt6) });
    expect(result).toMatchObject({ source: "live", reason: "disk" });
    expect(peekNativeLiveCatalog({ configDir: blockedPath, codexHome: dir, token, runtime }).catalog?.models?.map(model => model.slug)).toEqual(gpt6);
  });

  test("a slow earlier refresh cannot overwrite a newer outcome", async () => {
    const dir = tempDir();
    let release!: (value: Response) => void;
    const slow = new Promise<Response>(resolve => { release = resolve; });
    const base = { configDir: dir, codexHome: dir, runtime: { command: "/fixture/codex", version: "0.150.0" } };
    const older = refreshNativeLiveCatalog({ ...base, token: { ...token, chatgptAccountId: "older" }, fetch: async () => slow });
    const newer = await refreshNativeLiveCatalog({ ...base, token, fetch: async () => modelsResponse(gpt6) });
    expect(newer.source).toBe("live");
    release(new Response("", { status: 503 }));
    expect((await older).reason).toBe("response");
    expect(lastNativeDiscoveryStatus()?.source).toBe("live");
  });

  test("a mid-flight identity change never returns the old retained snapshot", async () => {
    const dir = tempDir();
    const base = { configDir: dir, codexHome: dir, runtime: { command: "/fixture/codex", version: "0.150.0" } };
    let active = token;
    expect((await refreshNativeLiveCatalog({ ...base, token: () => active, fetch: async () => modelsResponse(gpt6) })).source).toBe("live");
    const result = await refreshNativeLiveCatalog({ ...base, token: () => active, force: true,
      fetch: async () => {
        active = { ...token, chatgptAccountId: "new-account" };
        return modelsResponse(gpt6);
      } });
    expect(result).toMatchObject({ source: "unavailable", reason: "snapshot", catalog: null });
  });
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

describe("degraded native discovery carry", () => {
  const prior = { models: [...gpt6, "gpt-5.6-sol"].map(row) };
  const unavailable = { source: "unavailable", catalog: null, fetchedAt: null, identity: null, reason: "runtime" } as const;
  function signedInHome() {
    const dir = tempDir();
    process.env.CODEX_HOME = dir;
    process.env.CODEXCOMMANDER_HOME = dir;
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "fixture-account" } }));
    return dir;
  }

  test("keeps prior native rows independent of the bundled memo", () => {
    signedInHome();
    expect(carriedNativeDiscoveryRows(openAiConfig(), unavailable, prior).map(entry => entry.slug)).toEqual([...gpt6, "gpt-5.6-sol"]);
  });

  test("honors intentional drops", () => {
    const home = signedInHome();
    // Fresh home: no prior evidence.
    expect(carriedNativeDiscoveryRows(openAiConfig(), unavailable, null)).toEqual([]);
    // Genuine logout.
    writeFileSync(join(home, "auth.json"), JSON.stringify({}));
    expect(carriedNativeDiscoveryRows(openAiConfig(), unavailable, prior)).toEqual([]);
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "fixture-account" } }));
    // Native OpenAI excluded by provider configuration.
    const noOpenAi = openAiConfig({
      providers: { other: { adapter: "anthropic", baseUrl: "https://example.invalid" } } as never,
      defaultProvider: "other",
    });
    expect(carriedNativeDiscoveryRows(noOpenAi, unavailable, prior)).toEqual([]);
    // User-disabled models.
    expect(carriedNativeDiscoveryRows(openAiConfig({ disabledModels: gpt6 }), unavailable, prior).map(entry => entry.slug)).toEqual(["gpt-5.6-sol"]);
    // Admitted live or retained native catalog.
    expect(carriedNativeDiscoveryRows(openAiConfig(), { ...unavailable, source: "retained", catalog: prior, reason: undefined } as never,
      prior)).toEqual([]);
  });

  test("an API-key-only auth file is a confirmed sign-out", async () => {
    const home = signedInHome();
    writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture-key" }));
    expect(readCodexTokensResult().status).toBe("signed-out");
    expect((await refreshNativeLiveCatalog({ codexHome: home, configDir: home,
      runtime: { command: "/fixture/codex", version: "0.150.0" } })).reason).toBe("auth");
    expect(carriedNativeDiscoveryRows(openAiConfig(), unavailable, prior)).toEqual([]);
  });

  test("a token without an account id reports auth but is not confirmed signed out", async () => {
    const home = signedInHome();
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token" } }));
    const result = await refreshNativeLiveCatalog({ codexHome: home, configDir: home,
      runtime: { command: "/fixture/codex", version: "0.150.0" } });
    expect(result.reason).toBe("auth");
    expect(carriedNativeDiscoveryRows(openAiConfig(), unavailable, prior).map(entry => entry.slug)).toContain("gpt-6-sol");
  });

  test("a truncated or unreadable auth file preserves prior rows", () => {
    const home = signedInHome();
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, "{");
    expect(carriedNativeDiscoveryRows(openAiConfig(), unavailable, prior).map(entry => entry.slug)).toEqual([...gpt6, "gpt-5.6-sol"]);
    unlinkSync(authPath);
    mkdirSync(authPath);
    expect(readCodexTokensResult().status).toBe("unreadable");
    expect(carriedNativeDiscoveryRows(openAiConfig(), unavailable, prior).map(entry => entry.slug)).toEqual([...gpt6, "gpt-5.6-sol"]);
  });

  test("a fresh live outcome does not override this gather's unavailable peek", async () => {
    const home = signedInHome();
    const runtime = { command: "/fixture/codex", version: "0.150.0", source: "configured" as const };
    persistCodexRuntime(runtime, { configDir: home });
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    try {
      const live = await refreshNativeLiveCatalog({ runtime, codexHome: home, configDir: home,
        fetch: async () => modelsResponse(gpt6) });
      expect(live.source).toBe("live");
      expect(lastNativeDiscoveryStatus()?.source).toBe("live");
      writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "fixture-account" }, changed: true }));
      const peek = peekNativeLiveCatalog({ codexHome: home, configDir: home });
      expect(peek.catalog).toBeNull();
      expect(carriedNativeDiscoveryRows(openAiConfig(), peek, prior).map(entry => entry.slug)).toEqual([...gpt6, "gpt-5.6-sol"]);
    } finally { blocked.mockRestore(); }
  });

  test("a bundled-listed mode switch excludes formerly hidden rows", () => {
    signedInHome();
    const withVisibility = { models: [
      { ...row("gpt-6-sol"), visibility: "list" },
      { ...row("gpt-6-luna"), visibility: "hide" },
    ] };
    expect(carriedNativeDiscoveryRows(openAiConfig({ nativeCatalogMode: "bundled-listed" }), unavailable, withVisibility)
      .map(entry => entry.slug)).toEqual(["gpt-6-sol"]);
  });

  test("listed mode keeps a hidden bare row when its account selector is visible", () => {
    signedInHome();
    const withSelector = { models: [
      { ...row("gpt-6-sol"), visibility: "hide" },
      { ...row("main/gpt-6-sol"), visibility: "list", codexcommander_catalog_kind: "account-selector-v1" },
    ] };
    expect(carriedNativeDiscoveryRows(openAiConfig({ nativeCatalogMode: "bundled-listed" }), unavailable, withSelector)
      .map(entry => entry.slug)).toEqual(["gpt-6-sol"]);
  });

  test("a live-only native alias is intentionally suppressed during an outage", () => {
    signedInHome();
    const config = openAiConfig({ combos: {
      routed: { alias: "gpt-6-sol", nativeAlias: true, displayName: "Routed Sol",
        targets: [{ provider: "openai", model: "gpt-5.6-sol" }] },
    } as CodexCommanderConfig["combos"] });
    expect(carriedNativeDiscoveryRows(config, unavailable, prior).map(entry => entry.slug)).not.toContain("gpt-6-sol");
  });

  test("a carried bare slug still routes to the native OpenAI provider", () => {
    signedInHome();
    expect(routeModel(openAiConfig(), "gpt-6-sol")).toMatchObject({
      providerName: "openai", modelId: "gpt-6-sol", routeKind: "native",
    });
  });
});

describe.skipIf(process.platform === "win32")("restart with a broken runtime probe", () => {
  function setup(dir: string, bundledSlugs = gpt6) {
    process.env.CODEX_HOME = dir;
    process.env.CODEXCOMMANDER_HOME = dir;
    const catalog = bundledCatalogFixture(bundledSlugs);
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

  function setupWithPublishedGpt6(dir: string) {
    const result = setup(dir, ["gpt-5.6-sol"]);
    const catalogPath = join(dir, "codexcommander-catalog.json");
    const prior = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: unknown[] };
    prior.models.push(...gpt6.map(row));
    writeFileSync(catalogPath, JSON.stringify(prior));
    return { ...result, catalogPath };
  }

  test("a nonmemoized listed-mode miss never borrows the all-mode slug set", () => {
    const dir = tempDir();
    const hidden = bundledCatalogFixture(["gpt-6-sol"]);
    hidden.models[0]!.visibility = "hide";
    process.env.CODEX_HOME = dir;
    process.env.CODEXCOMMANDER_HOME = dir;
    process.env.CODEX_CLI_PATH = createCodexRuntimeFixture(dir, { version: "0.150.0", catalog: hidden });
    resetCodexRuntimeResolveCacheForTests();
    const runtime = resolveCodexRuntime({ discoverAlternatives: false }).runtime;
    persistCodexRuntime(runtime, { configDir: dir });
    const all = supportedNativeOpenAiSlugSet({ nativeCatalogMode: "bundled-all" });
    const listed = supportedNativeOpenAiSlugSet({ nativeCatalogMode: "bundled-listed" });
    expect(all.has("gpt-6-sol")).toBe(true);
    expect(listed.has("gpt-6-sol")).toBe(false);
    expect(listed.has("gpt-5.5")).toBe(true);
  });

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

  test("a warm bundled catalog without gpt-6 still carries published gpt-6", async () => {
    const dir = tempDir();
    const { config, catalogPath } = setupWithPublishedGpt6(dir);
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("offline"); }) as never);
    try {
      const result = await refreshCodexModelCatalog(config);
      expect(result.catalogDisposition).toMatchObject({ status: "committed", degraded: true });
      expect(slugs(catalogPath)).toEqual(expect.arrayContaining(gpt6));
    } finally { blocked.mockRestore(); fetchSpy.mockRestore(); }
  });

  test("account A's published-only rows never reach account B while discovery is degraded", async () => {
    const dir = tempDir();
    const { catalogPath, config } = setupWithPublishedGpt6(dir);
    const prior = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<Record<string, unknown>> };
    const sol = prior.models.find(entry => entry.slug === "gpt-6-sol")!;
    sol.context_window = 123456;
    sol.supported_reasoning_levels = [{ effort: "ultra" }];
    writeFileSync(catalogPath, JSON.stringify(prior));
    writeNativeCatalogOwner(currentNativeCatalogOwner(dir)!);
    expect(nativeOpenAiContextWindow("gpt-6-sol")).toBe(123456);
    expect(nativeEffortClamp("gpt-6-sol", "ultra")).toBeNull();
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "account-b" } }));
    resetNativeLiveCatalogStateForTests();
    const outage = { source: "unavailable", catalog: null, fetchedAt: null, identity: null, reason: "network" } as const;
    expect(nativeCatalogOwnerDecision(dir)).toBe("mismatch");
    expect(carriedNativeDiscoveryRows(config, outage, prior, dir)).toEqual([]);
    expect(effectiveSubagentRoster(["gpt-6-sol"], "v2", prior.models).advertised).toEqual([]);
    expect(nativeOpenAiContextWindow("gpt-6-sol")).not.toBe(123456);
    expect(nativeEffortClamp("gpt-6-sol", "ultra")).toBe("xhigh");
    const gate = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(true);
    const server = startServer(0);
    try {
      const catalog = await fetch(new URL("/v1/models?client_version=0.150.0", server.url))
        .then(response => response.json()) as { models: Array<{ slug: string }> };
      const plain = await fetch(new URL("/v1/models", server.url))
        .then(response => response.json()) as { data: Array<{ id: string }> };
      expect(catalog.models.map(entry => entry.slug)).not.toContain("gpt-6-sol");
      expect(plain.data.map(entry => entry.id)).not.toContain("gpt-6-sol");
    } finally { await server.stop(true); gate.mockRestore(); }
  });

  test("owner decisions handle runtime updates, legacy snapshots, and unreadable auth", async () => {
    const dir = tempDir();
    const { runtime, config, catalogPath } = setupWithPublishedGpt6(dir);
    const prior = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<Record<string, unknown>> };
    const outage = { source: "unavailable", catalog: null, fetchedAt: null, identity: null, reason: "network" } as const;
    writeNativeCatalogOwner(currentNativeCatalogOwner(dir)!);
    // Runtime version is deliberately outside the account owner hash.
    persistCodexRuntime({ ...runtime, version: "0.151.0" }, { configDir: dir });
    expect(nativeCatalogOwnerDecision(dir)).toBe("match");
    expect(carriedNativeDiscoveryRows(config, outage, prior, dir).map(entry => entry.slug)).toContain("gpt-6-sol");
    writeFileSync(join(dir, "auth.json"), "{");
    expect(nativeCatalogOwnerDecision(dir)).toBe("unknown");
    expect(carriedNativeDiscoveryRows(config, outage, prior, dir).map(entry => entry.slug)).toContain("gpt-6-sol");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "fixture-account" } }));
    unlinkSync(nativeCatalogOwnerPath());
    expect(nativeCatalogOwnerDecision(dir)).toBe("unknown");
    persistCodexRuntime(runtime, { configDir: dir });
    const live = await refreshNativeLiveCatalog({ runtime, force: true,
      fetch: async () => modelsResponse(gpt6) });
    expect(live.source).toBe("live");
    expect(nativeCatalogOwnerDecision(dir)).toBe("match");
    writeFileSync(nativeCatalogOwnerPath(), "{");
    expect(nativeCatalogOwnerDecision(dir)).toBe("match");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "account-b" } }));
    expect(nativeCatalogOwnerDecision(dir)).toBe("mismatch");
  });

  test("a live B publish replaces A's owner and B rows carry on the next outage", async () => {
    const dir = tempDir();
    const { config, catalogPath, runtime } = setupWithPublishedGpt6(dir);
    writeNativeCatalogOwner(currentNativeCatalogOwner(dir)!);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "account-b" } }));
    const gate = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => modelsResponse(["gpt-6-luna"])) as never);
    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args.map(String).join(" ")); });
    try {
      expect((await refreshNativeLiveCatalog({ runtime, force: true, fetch: async () => modelsResponse(["gpt-6-luna"]) })).source).toBe("live");
      expect((await refreshCodexModelCatalog(config)).catalogDisposition?.status).toBe("committed");
      const ownerFile = nativeCatalogOwnerPath();
      const saved = readFileSync(ownerFile, "utf8");
      expect(saved).toContain(currentNativeCatalogOwner(dir)!);
      expect(saved).not.toContain("account-b");
      if (process.platform !== "win32") expect(statSync(ownerFile).mode & 0o777).toBe(0o600);
      expect(slugs(catalogPath)).toContain("gpt-6-luna");
      expect(slugs(catalogPath)).not.toContain("gpt-6-sol");
      unlinkSync(nativeLiveCatalogSnapshotPath(dir));
      resetNativeLiveCatalogStateForTests();
      fetchSpy.mockImplementation((async () => { throw new Error("offline"); }) as never);
      const degraded = await refreshCodexModelCatalog(config);
      expect(degraded.catalogDisposition).toMatchObject({ status: "committed" });
      expect(slugs(catalogPath)).toContain("gpt-6-luna");
      expect(slugs(catalogPath)).not.toContain("gpt-6-sol");
      expect(warnings.join(" ")).not.toContain("account-b");
      expect(warnings.join(" ")).not.toContain("fixture-account");
    } finally { gate.mockRestore(); fetchSpy.mockRestore(); warnSpy.mockRestore(); }
  });

  test("both HTTP model shapes and the roster retain carried rows", async () => {
    const dir = tempDir();
    const { catalogPath, config } = setupWithPublishedGpt6(dir);
    const prior = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<Record<string, unknown>> };
    const levels = [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }];
    for (const slug of ["gpt-6-sol", "gpt-6-luna"]) {
      prior.models.find(entry => entry.slug === slug)!.supported_reasoning_levels = levels;
    }
    writeFileSync(catalogPath, JSON.stringify(prior));
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    try {
      for (const selectors of [false, true]) {
        const current = selectors ? { ...config, codexAccountNamespaces: { main: "@main" } } : config;
        saveConfig(current);
        const offline = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("offline"); }) as never);
        try {
          expect((await refreshCodexModelCatalog(current)).catalogDisposition).toMatchObject({ status: "committed", degraded: true });
        } finally { offline.mockRestore(); }
        const disk = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<{ slug: string; visibility?: string; supported_reasoning_levels?: unknown[] }> };
        for (const slug of ["gpt-6-sol", "gpt-6-luna"]) {
          expect(disk.models.find(entry => entry.slug === (selectors ? `main/${slug}` : slug))?.visibility).toBe("list");
          expect(disk.models.find(entry => entry.slug === slug)?.supported_reasoning_levels).toEqual(levels);
        }
        expect(effectiveSubagentRoster(["gpt-6-sol", "gpt-6-luna"], "v2", disk.models).advertised
          .map(entry => entry.model)).toEqual(expect.arrayContaining(
            ["gpt-6-sol", "gpt-6-luna"].map(slug => selectors ? `main/${slug}` : slug),
          ));
        expect(routeModel(current, "gpt-6-sol")).toMatchObject({ providerName: "openai", routeKind: "native" });
        expect(nativeEffortClamp("gpt-6-sol", "ultra")).toBeNull();
        blocked.mockReturnValue(true);
        const server = startServer(0);
        try {
          const catalog = await fetch(new URL("/v1/models?client_version=0.150.0", server.url))
            .then(response => response.json()) as { models: Array<{ slug: string; visibility?: string }> };
          const plain = await fetch(new URL("/v1/models", server.url))
            .then(response => response.json()) as { data: Array<{ id: string }> };
          for (const slug of ["gpt-6-sol", "gpt-6-luna"]) {
            expect(catalog.models.find(entry => entry.slug === slug)).toBeDefined();
            expect(plain.data.map(entry => entry.id)).toContain(slug);
            if (selectors) {
              expect(catalog.models.find(entry => entry.slug === `main/${slug}`)?.visibility).toBe("list");
              expect(plain.data.map(entry => entry.id)).toContain(`main/${slug}`);
            }
          }
          const roster = effectiveSubagentRoster(["gpt-6-sol", "gpt-6-luna"], "v2", catalog.models);
          expect(roster.advertised.map(entry => entry.model)).toEqual(expect.arrayContaining(
            ["gpt-6-sol", "gpt-6-luna"].map(slug => selectors ? `main/${slug}` : slug),
          ));
        } finally { await server.stop(true); blocked.mockReturnValue(false); }
      }
      expect(slugs(catalogPath)).toEqual(expect.arrayContaining(gpt6));
    } finally { blocked.mockRestore(); }
  });

  test("a retired account-bound native row does not match a bare selector while discovery is healthy", async () => {
    const dir = tempDir();
    const { runtime } = setup(dir);
    const live = await refreshNativeLiveCatalog({ runtime, force: true,
      fetch: async () => modelsResponse(["gpt-6-sol"]) });
    expect(live.source).toBe("live");
    expect(configuredSubagentModelMatchesEntry("gpt-6-retired", {
      slug: "main/gpt-6-retired",
      codexcommander_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      visibility: "list",
    })).toBe(false);
  });

  test("healthy live publication followed by an outage is byte-identical", async () => {
    const dir = tempDir();
    const { config, runtime } = setup(dir, ["gpt-5.6-sol"]);
    const catalogPath = join(dir, "codexcommander-catalog.json");
    const openGate = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => modelsResponse(gpt6)) as never);
    try {
      expect((await refreshNativeLiveCatalog({ runtime, force: true, fetch: async () => modelsResponse(gpt6) })).source).toBe("live");
      expect((await refreshCodexModelCatalog(config)).catalogDisposition?.status).toBe("committed");
      const catalogBytes = readFileSync(catalogPath, "utf8");
      const cachePath = join(dir, "models_cache.json");
      const cacheBytes = readFileSync(cachePath, "utf8");
      const priorOrder = (JSON.parse(catalogBytes).models as Array<{ slug: string }>).map(entry => entry.slug);
      unlinkSync(nativeLiveCatalogSnapshotPath(dir));
      resetNativeLiveCatalogStateForTests();
      fetchSpy.mockImplementation((async () => { throw new Error("offline"); }) as never);
      const degraded = await refreshCodexModelCatalog(config);
      expect(degraded.catalogDisposition).toMatchObject({ status: "committed", changed: false });
      expect(readFileSync(catalogPath, "utf8")).toBe(catalogBytes);
      expect((JSON.parse(readFileSync(catalogPath, "utf8")).models as Array<{ slug: string }>).map(entry => entry.slug)).toEqual(priorOrder);
      expect(readFileSync(cachePath, "utf8")).toBe(cacheBytes);
    } finally { openGate.mockRestore(); fetchSpy.mockRestore(); }
  });

  test("healthy listed mode keeps the established catalog and both model-list shapes", async () => {
    const dir = tempDir();
    const { config, runtime } = setup(dir, ["gpt-5.6-sol", "gpt-6-sol"]);
    const catalogPath = join(dir, "codexcommander-catalog.json");
    const gate = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    try {
      const live = await refreshNativeLiveCatalog({ runtime, force: true,
        fetch: async () => new Response(JSON.stringify(bundledCatalogFixture(["gpt-5.6-sol", "gpt-6-sol"])),
          { headers: { "content-type": "application/json" } }),
      });
      expect(live.source).toBe("live");
      await refreshCodexModelCatalog(config);
      const baseline = readFileSync(catalogPath, "utf8");
      const listShapes = async () => {
        const server = startServer(0);
        try {
          const plain = await fetch(new URL("/v1/models", server.url)).then(response => response.json()) as { data: Array<{ id: string }> };
          const catalog = await fetch(new URL("/v1/models?client_version=0.150.0", server.url)).then(response => response.json()) as { models: Array<{ slug: string }> };
          return { plain: plain.data.map(row => row.id), catalog: catalog.models.map(row => row.slug) };
        } finally { await server.stop(true); }
      };
      const before = await listShapes();
      const listed = { ...config, nativeCatalogMode: "bundled-listed" as const };
      saveConfig(listed);
      await refreshCodexModelCatalog(listed);
      expect(readFileSync(catalogPath, "utf8")).toBe(baseline);
      expect(await listShapes()).toEqual(before);
    } finally { gate.mockRestore(); }
  });

  test("healthy discovery with a selector keeps bundled native visibility and excludes old published rows", async () => {
    const dir = tempDir();
    const { runtime, config } = setup(dir, ["gpt-5.6-sol", "gpt-6-sol"]);
    const bundled = bundledCatalogFixture(["gpt-5.6-sol", "gpt-6-sol"]);
    bundled.models[0]!.visibility = "hide";
    createCodexRuntimeFixture(dir, { version: "0.150.0", catalog: bundled });
    resetBundledCatalogCacheForTests();
    resetSupportedNativeSlugMemoForTests();
    writeFileSync(join(dir, "codexcommander-catalog.json"), JSON.stringify({
      models: [...bundled.models, { ...row("gpt-6-retired"), visibility: "list" }],
    }));
    saveConfig({ ...config, codexAccountNamespaces: { main: "@main" } });
    const gate = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    try {
      const live = await refreshNativeLiveCatalog({ runtime, force: true,
        fetch: async () => modelsResponse(["gpt-6-sol"]) });
      expect(live.source).toBe("live");

      const server = startServer(0);
      try {
        const response = await fetch(new URL("/v1/models?client_version=0.150.0", server.url));
        expect(response.status).toBe(200);
        const catalog = await response.json() as { models: Array<{ slug: string; visibility?: string }> };
        const visibility = new Map(catalog.models.map(entry => [entry.slug, entry.visibility]));
        expect(visibility.get("gpt-5.6-sol")).toBe("hide");
        expect(visibility.get("main/gpt-5.6-sol")).toBe("list");
        expect(visibility.get("gpt-6-sol")).toBe("hide");
        expect(visibility.get("main/gpt-6-sol")).toBe("list");
        expect(visibility.has("gpt-6-retired")).toBe(false);
        expect(visibility.has("main/gpt-6-retired")).toBe(false);
      } finally { await server.stop(true); }
    } finally { gate.mockRestore(); }
  });

  test("an unrelated disabled selector edit commits during an outage", async () => {
    const dir = tempDir();
    const { config, catalogPath } = setupWithPublishedGpt6(dir);
    const edited = { ...config, disabledModels: ["provider/unrelated"] };
    saveConfig(edited);
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("offline"); }) as never);
    try {
      const result = await refreshCodexModelCatalog(edited);
      expect(result.catalogDisposition).toMatchObject({ status: "committed" });
      expect(slugs(catalogPath)).toEqual(expect.arrayContaining(gpt6));
    } finally { blocked.mockRestore(); fetchSpy.mockRestore(); }
  });

  test("management convergence carries published natives during an outage", async () => {
    const dir = tempDir();
    const { config, catalogPath } = setupWithPublishedGpt6(dir);
    writeFileSync(join(dir, "config.toml"), [
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      'model_catalog_json = "codexcommander-catalog.json"',
      "",
    ].join("\n"));
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("offline"); }) as never);
    try {
      const result = await createManagementConvergeCodex(config)(createCatalogConvergeRequest({ deadlineMs: 1_000 }));
      expect(result.catalogRefresh).toMatchObject({ status: "committed", degraded: true });
      expect(slugs(catalogPath)).toEqual(expect.arrayContaining(gpt6));
    } finally { blocked.mockRestore(); fetchSpy.mockRestore(); }
  });

  test("confirmed logout publishes the native retirement immediately", async () => {
    const dir = tempDir();
    const { config, catalogPath } = setupWithPublishedGpt6(dir);
    unlinkSync(join(dir, "auth.json"));
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    try {
      const result = await refreshCodexModelCatalog(config);
      expect(result.catalogDisposition).toMatchObject({ status: "committed" });
      expect(slugs(catalogPath)).not.toContain("gpt-6-sol");
    } finally { blocked.mockRestore(); }
  });

  test("excluding native OpenAI publishes the removal during an outage", async () => {
    const dir = tempDir();
    const { catalogPath } = setupWithPublishedGpt6(dir);
    const config = openAiConfig({ providers: {
      other: { adapter: "anthropic", baseUrl: "https://example.invalid", liveModels: false, models: [] },
    } as CodexCommanderConfig["providers"], defaultProvider: "other" });
    saveConfig(config);
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("offline"); }) as never);
    try {
      const result = await refreshCodexModelCatalog(config);
      expect(result.catalogDisposition).toMatchObject({ status: "committed" });
      expect(slugs(catalogPath)).not.toContain("gpt-6-sol");
    } finally { blocked.mockRestore(); fetchSpy.mockRestore(); }
  });

  test("disabled native models are removed during an outage", async () => {
    const dir = tempDir();
    const { config, catalogPath } = setupWithPublishedGpt6(dir);
    const edited = { ...config, disabledModels: gpt6 };
    saveConfig(edited);
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("offline"); }) as never);
    try {
      const result = await refreshCodexModelCatalog(edited);
      expect(result.catalogDisposition).toMatchObject({ status: "committed" });
      expect(slugs(catalogPath)).not.toContain("gpt-6-sol");
    } finally { blocked.mockRestore(); fetchSpy.mockRestore(); }
  });

  test("a mode switch publishes hidden-row removal during an outage", async () => {
    const dir = tempDir();
    const { config, catalogPath } = setupWithPublishedGpt6(dir);
    const edited = { ...config, nativeCatalogMode: "bundled-listed" as const };
    saveConfig(edited);
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("offline"); }) as never);
    try {
      const result = await refreshCodexModelCatalog(edited);
      expect(result.catalogDisposition).toMatchObject({ status: "committed" });
      expect(slugs(catalogPath)).not.toContain("gpt-6-sol");
    } finally { blocked.mockRestore(); fetchSpy.mockRestore(); }
  });

  test("a recovered live catalog retires a model absent upstream", async () => {
    const dir = tempDir();
    const { config, catalogPath, runtime } = setupWithPublishedGpt6(dir);
    const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
    try {
      const live = await refreshNativeLiveCatalog({ runtime, force: true, fetch: async () => modelsResponse(["gpt-5.6-sol"]) });
      expect(live.source).toBe("live");
      const result = await refreshCodexModelCatalog(config);
      expect(result.catalogDisposition).toMatchObject({ status: "committed" });
      expect(slugs(catalogPath)).not.toContain("gpt-6-sol");
    } finally { blocked.mockRestore(); }
  });

  test("commits and keeps native rows when discovery is degraded without a snapshot", async () => {
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
      const result = await refreshCodexModelCatalog(config);
      expect(result.catalogDisposition).toMatchObject({ status: "committed", degraded: true });
      expect(result.catalogDisposition?.status === "committed" ? result.catalogDisposition.notices : []).toContain("native-discovery");
      expect(slugs(catalogPath)).toEqual(expect.arrayContaining(gpt6));
      expect(slugs(cachePath)).toEqual(expect.arrayContaining(gpt6));
      const firstCatalog = readFileSync(catalogPath, "utf8");
      const again = await refreshCodexModelCatalog(config);
      expect(again.catalogDisposition).toMatchObject({ status: "committed", changed: false });
      expect(readFileSync(catalogPath, "utf8")).toBe(firstCatalog);
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

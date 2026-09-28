import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshNativeLiveCatalog, peekNativeLiveCatalog, resetNativeLiveCatalogStateForTests } from "../src/codex/catalog/native-live";
import { listCatalogNativeSlugs, nativeOpenAiSlugs, nativeReasoningEfforts } from "../src/codex/catalog/metadata";
import { mergeCatalogEntriesForSync, mergeCatalogModelsWithNativeRecovery } from "../src/codex/catalog/sync";
import { nativeEffortClamp } from "../src/codex/catalog/effort";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import { startServer } from "../src/server/index";
import { drainAndShutdown, resetLifecycleDrainStateForTests } from "../src/server/lifecycle";
import * as nativeProfileStartup from "../src/codex/native-profile-startup";
import { saveConfig } from "../src/config";
import { resetBundledCatalogCacheForTests } from "../src/codex/catalog/bundled";
import { persistCodexRuntime, resetCodexRuntimeResolveCacheForTests, resolveCodexRuntime } from "../src/codex/runtime";
import { bundledCatalogFixture, createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";

const previousHome = process.env.CODEX_HOME;
const previousConfig = process.env.CODEXCOMMANDER_HOME;
const previousCli = process.env.CODEX_CLI_PATH;
const dirs: string[] = [];

/** Windows may release completed cmd.exe or ACL handles just after shutdown. */
function removeTree(path: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (!new Set(["EPERM", "EBUSY", "ENOTEMPTY"]).has(code)) throw error;
      lastError = error;
      Bun.sleepSync(50);
    }
  }
  throw lastError;
}

beforeEach(() => resetNativeLiveCatalogStateForTests());
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousConfig === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousConfig;
  if (previousCli === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCli;
  resetBundledCatalogCacheForTests();
  resetNativeLiveCatalogStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  resetLifecycleDrainStateForTests();
  for (const dir of dirs.splice(0)) removeTree(dir);
});

test("identity-matched live Sol and Luna reach native roster and sync with distinct ladders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccx-live-integration-"));
  dirs.push(dir);
  process.env.CODEX_HOME = dir;
  process.env.CODEXCOMMANDER_HOME = dir;
  const astra = {
    ...bundledCatalogFixture(["gpt-6-astra"]).models[0],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
  };
  process.env.CODEX_CLI_PATH = createCodexRuntimeFixture(dir, { version: "0.146.0", catalog: { models: [astra] } });
  resetCodexRuntimeResolveCacheForTests();
  const runtime = resolveCodexRuntime({ discoverAlternatives: false }).runtime;
  persistCodexRuntime(runtime, { configDir: dir });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "account-one" } }));
  const sol = {
    ...astra, slug: "gpt-6-sol", display_name: "GPT-6 Sol", context_window: 300000,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }],
  };
  const luna = {
    ...astra, slug: "gpt-6-luna", display_name: "GPT-6 Luna", context_window: 200000,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }],
  };
  const refreshed = await refreshNativeLiveCatalog({ runtime, force: true, fetch: async () => new Response(JSON.stringify({ models: [astra, sol, luna] }), {
    headers: { "content-type": "application/json" },
  }) });
  expect(refreshed.source).toBe("live");
  expect(peekNativeLiveCatalog().source).toBe("retained");
  expect(listCatalogNativeSlugs()).toContain("gpt-6-sol");
  expect(listCatalogNativeSlugs()).toContain("gpt-6-luna");
  expect(nativeReasoningEfforts("gpt-6-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  expect(nativeReasoningEfforts("gpt-6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(nativeEffortClamp("gpt-6-sol", "ultra")).toBeNull();
  expect(nativeEffortClamp("gpt-6-luna", "ultra")).toBe("max");

  writeFileSync(join(dir, "codexcommander-catalog.json"), JSON.stringify({ models: [astra] }));
  const config = {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    providers: { openai: { adapter: "openai-responses" as const, baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const } },
    defaultProvider: "openai",
  };
  saveConfig(config);
  const blockedDuringSync = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(true);
  try {
    const busy = await refreshCodexModelCatalog(config);
    expect(busy.catalogDisposition).toMatchObject({ status: "committed" });
  } finally {
    blockedDuringSync.mockRestore();
  }
  const committed = await refreshCodexModelCatalog(config);
  expect(committed.catalogDisposition.status).toBe("committed");
  expect(peekNativeLiveCatalog().source).toBe("retained");
  const disk = JSON.parse(readFileSync(join(dir, "codexcommander-catalog.json"), "utf8")) as { models: typeof sol[] };
  expect(disk.models.find(row => row.slug === "gpt-6-sol")?.supported_reasoning_levels).toEqual(sol.supported_reasoning_levels);
  expect(disk.models.find(row => row.slug === "gpt-6-luna")?.supported_reasoning_levels).toEqual(luna.supported_reasoning_levels);

  // The standalone test server has no native-main lifetime owner. Keep its
  // profile gate open only while asserting the catalog HTTP projection.
  const openGate = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
  const server = startServer(0);
  try {
    // Server startup can harden auth.json, changing its ctime. A claimed
    // refresh then re-admits the fingerprint used by request-time peeks.
    const readmitted = await refreshNativeLiveCatalog({ force: true, fetch: async () => new Response(JSON.stringify({ models: [astra, sol, luna] }), {
      headers: { "content-type": "application/json" },
    }) });
    expect(readmitted.source).toBe("live");
    expect(peekNativeLiveCatalog()).toMatchObject({ source: "retained" });
    expect(listCatalogNativeSlugs()).toContain("gpt-6-sol");
    const response = await fetch(new URL("/v1/models?client_version=0.146.0", server.url));
    expect(response.ok).toBe(true);
    const served = await response.json() as { models: typeof sol[] };
    for (const slug of ["gpt-6-sol", "gpt-6-luna"]) {
      const fromDisk = disk.models.find(row => row.slug === slug);
      const fromHttp = served.models.find(row => row.slug === slug);
      expect(fromHttp?.context_window).toBe(fromDisk?.context_window);
      expect(fromHttp?.supported_reasoning_levels).toEqual(fromDisk?.supported_reasoning_levels);
    }
    openGate.mockReturnValue(true);
    expect(nativeReasoningEfforts("gpt-6-sol")).toContain("ultra");
    expect(nativeEffortClamp("gpt-6-sol", "ultra")).toBeNull();
    const degradedResponse = await fetch(new URL("/v1/models?client_version=0.146.0", server.url));
    expect(degradedResponse.ok).toBe(true);
    const degraded = await degradedResponse.json() as { models: typeof sol[] };
    expect(degraded.models.map(row => row.slug)).toEqual(expect.arrayContaining(["gpt-6-sol", "gpt-6-luna"]));
    openGate.mockReturnValue(false);
  } finally {
    await drainAndShutdown(server, 5_000);
    openGate.mockRestore();
  }

  const memoGate = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  try {
    expect(peekNativeLiveCatalog().source).toBe("retained");
    expect(listCatalogNativeSlugs()).toContain("gpt-6-sol");
  } finally {
    clock.mockRestore();
    memoGate.mockRestore();
  }
  const blocked = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(true);
  try {
    expect(peekNativeLiveCatalog().source).toBe("unavailable");
    expect(listCatalogNativeSlugs()).not.toContain("gpt-6-sol");
    let attemptedNetwork = false;
    const rejected = await refreshNativeLiveCatalog({ force: true, fetch: async () => {
      attemptedNetwork = true;
      return new Response("{}");
    } });
    expect(rejected.reason).toBe("busy");
    expect(attemptedNetwork).toBe(false);
  } finally {
    blocked.mockRestore();
  }

  const merged = mergeCatalogEntriesForSync(
    [astra], [], new Map(), [], false, new Set(), astra, new Set(), new Set(),
    "default", new Set(), false, true, [], ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
    new Set(), [astra, sol, luna],
  );
  expect(merged.find(row => row.slug === "gpt-6-sol")?.supported_reasoning_levels).toEqual(sol.supported_reasoning_levels);
  expect(merged.find(row => row.slug === "gpt-6-luna")?.supported_reasoning_levels).toEqual(luna.supported_reasoning_levels);

  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "other-token", account_id: "account-two" } }));
  expect(peekNativeLiveCatalog().source).toBe("unavailable");
  expect(listCatalogNativeSlugs()).not.toContain("gpt-6-sol");
  expect(listCatalogNativeSlugs()).not.toContain("gpt-6-luna");
}, { timeout: 30_000 });

test("an admitted account can recover newer Codex cache rows absent from the bundled catalog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccx-native-cache-recovery-"));
  dirs.push(dir);
  process.env.CODEX_HOME = dir;
  process.env.CODEXCOMMANDER_HOME = dir;
  const astra = bundledCatalogFixture(["gpt-6-astra"]).models[0]!;
  process.env.CODEX_CLI_PATH = createCodexRuntimeFixture(dir, { version: "0.146.0", catalog: { models: [astra] } });
  resetCodexRuntimeResolveCacheForTests();
  const runtime = resolveCodexRuntime({ discoverAlternatives: false }).runtime;
  persistCodexRuntime(runtime, { configDir: dir });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "account-one" } }));
  const openGate = spyOn(nativeProfileStartup, "isNativeMainTrafficBlocked").mockReturnValue(false);
  const admitted = await refreshNativeLiveCatalog({ runtime, force: true, fetch: async () => new Response(JSON.stringify({ models: [astra] }), {
    headers: { "content-type": "application/json" },
  }) });
  expect(admitted.source).toBe("live");
  expect(peekNativeLiveCatalog().source).toBe("retained");
  const sol = { ...astra, slug: "gpt-6-sol", display_name: "GPT-6 Sol", priority: 2 };
  const routed = { ...sol, slug: "provider/gpt-6-sol" };
  const synthetic = { ...sol, slug: "gpt-6-fake", codexcommander_native_source: "synthetic-fallback" };
  writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ models: [sol, routed, synthetic] }));
  expect(nativeOpenAiSlugs()).toContain("gpt-6-sol");
  expect(nativeOpenAiSlugs()).not.toContain("gpt-6-fake");
  const recovered = mergeCatalogModelsWithNativeRecovery([astra], [[sol, routed, synthetic]]);
  expect(recovered.map(row => row.slug)).toContain("gpt-6-sol");
  expect(recovered.map(row => row.slug)).not.toContain("gpt-6-fake");
  writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ models: [] }));
  expect(nativeOpenAiSlugs()).not.toContain("gpt-6-sol");
  openGate.mockRestore();
}, { timeout: 30_000 });

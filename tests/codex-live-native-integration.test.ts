import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshNativeLiveCatalog, peekNativeLiveCatalog } from "../src/codex/catalog/native-live";
import { listCatalogNativeSlugs, nativeReasoningEfforts } from "../src/codex/catalog/metadata";
import { mergeCatalogEntriesForSync } from "../src/codex/catalog/sync";
import { nativeEffortClamp } from "../src/codex/catalog/effort";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import { startServer } from "../src/server/index";
import * as nativeProfileStartup from "../src/codex/native-profile-startup";
import { saveConfig } from "../src/config";
import { resetBundledCatalogCacheForTests } from "../src/codex/catalog/bundled";
import { persistCodexRuntime, resetCodexRuntimeResolveCacheForTests, resolveCodexRuntime } from "../src/codex/runtime";
import { bundledCatalogFixture, createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";

const previousHome = process.env.CODEX_HOME;
const previousConfig = process.env.CODEXCOMMANDER_HOME;
const previousCli = process.env.CODEX_CLI_PATH;
const dirs: string[] = [];
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousConfig === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousConfig;
  if (previousCli === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCli;
  resetBundledCatalogCacheForTests();
  resetCodexRuntimeResolveCacheForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
  } finally {
    await server.stop(true);
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
});

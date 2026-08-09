import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { loadConfig, saveConfig } from "../src/config";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { ManagementRequest, managementHeaders } from "./helpers/management-auth";
import type { CodexCommanderConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, `.tmp-api-catalog-route-${process.pid}`);
const previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  if (previousCodexCommanderHome === undefined) mkdirSync(TEST_DIR, { recursive: true });
  process.env.CODEXCOMMANDER_HOME = TEST_DIR;
  isolatedCodexHome = null;
  saveConfig({
    port: 10100,
    hostname: "127.0.0.1",
    multiAgentGuidanceEnabled: true,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model"] },
    },
  } as CodexCommanderConfig);
});

afterEach(() => {
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (previousCodexCommanderHome === undefined) {
    delete process.env.CODEXCOMMANDER_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  } else {
    process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
  }
});

describe("GET /api/catalog route (#709)", () => {
  test("returns the on-disk catalog and omits sync runtime probes for version hint", async () => {
    isolatedCodexHome = installIsolatedCodexHome("ccx-api-catalog-");
    const catalog = {
      models: [{
        slug: "mock/test-model",
        display_name: "Mock Test",
        description: "fixture",
        priority: 1,
        visibility: "list",
        base_instructions: "You are a helpful coding assistant.",
        input_modalities: ["text"],
      }],
    };
    writeFileSync(join(isolatedCodexHome.path, "codexcommander-catalog.json"), JSON.stringify(catalog));

    const url = new URL("http://localhost/api/catalog");
    const response = await handleManagementAPI(
      new ManagementRequest(url, { headers: managementHeaders() }),
      url,
      loadConfig(),
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual(catalog);
    expect(response!.headers.get("x-codexcommander-codex-version")).toBeNull();
  });

  test("returns 404 when the catalog file is missing", async () => {
    isolatedCodexHome = installIsolatedCodexHome("ccx-api-catalog-missing-");
    const url = new URL("http://localhost/api/catalog");
    const response = await handleManagementAPI(
      new ManagementRequest(url, { headers: managementHeaders() }),
      url,
      loadConfig(),
    );
    expect(response?.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "catalog not found" });
  });
});

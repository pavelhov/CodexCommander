import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { CodexCommanderConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): CodexCommanderConfig {
  return {
    port: 0,
    multiAgentGuidanceEnabled: true,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "key-first-000111222333",
        apiKeyPool: [{ id: "first-key", key: "key-first-000111222333" }],
      },
    },
  } as CodexCommanderConfig;
}

beforeEach(() => {
  previousHome = process.env.CODEXCOMMANDER_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ccx-provider-keys-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ccx-provider-keys-"));
  process.env.CODEXCOMMANDER_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("provider API key pool", () => {
  test("xAI key management remains available while chat auth stays OAuth", async () => {
    const cfg = baseConfig();
    cfg.defaultProvider = "xai";
    cfg.providers = {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
      },
    };
    saveConfig(cfg);
    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "xai", key: "xai-media-key-000111222333" }),
      });
      expect(add.status).toBe(201);
      const first = await add.json() as { id: string };
      const addSecond = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "xai", key: "xai-media-key-444555666777" }),
      });
      expect(addSecond.status).toBe(201);
      const listed = await fetch(new URL("/api/providers/keys?name=xai", server.url)).then(response => response.json()) as {
        activeId: string | null;
        keys: Array<{ id: string; active: boolean }>;
      };
      expect(listed.activeId).toBeTruthy();
      expect(listed.keys).toHaveLength(2);
      expect(loadDiskConfig().providers.xai!.authMode).toBe("oauth");

      const select = await fetch(new URL("/api/providers/keys/active", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "xai", id: first.id }),
      });
      expect(select.status).toBe(200);
      expect(loadDiskConfig().providers.xai!.authMode).toBe("oauth");

      const remove = await fetch(new URL(`/api/providers/keys?name=xai&id=${first.id}`, server.url), { method: "DELETE" });
      expect(remove.status).toBe(200);
      expect(loadDiskConfig().providers.xai!.authMode).toBe("oauth");
    } finally {
      await server.stop(true);
    }
  });

  test("GET does not salvage a legacy bare apiKey", async () => {
    const legacy = baseConfig();
    delete legacy.providers["opencode-go"]!.apiKeyPool;
    saveConfig(legacy);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { activeId: string | null; keys: Array<{ id: string; masked: string; active: boolean }> };
      expect(body.activeId).toBeNull();
      expect(body.keys).toEqual([]);
      expect(JSON.stringify(body).includes("key-first-000111222333")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("POST adds + activates; PUT switches; DELETE removes and promotes", async () => {
    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "key-second-444555666777" }),
      });
      expect(add.status).toBe(201);
      const { id: secondId } = await add.json() as { id: string };

      let list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as { activeId: string; keys: Array<{ id: string; active: boolean }> };
      expect(list.keys.length).toBe(2);
      expect(list.activeId).toBe(secondId); // new key becomes active

      // config.json mirrors the active key into apiKey
      const cfg = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      expect(cfg.providers["opencode-go"].apiKey).toBe("key-second-444555666777");

      const firstId = list.keys.find(k => k.id !== secondId)!.id;
      const rename = await fetch(new URL("/api/providers/keys/alias", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: secondId, alias: "Work key" }),
      });
      expect(rename.status).toBe(200);
      const renamed = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as { keys: Array<{ id: string; label?: string }> };
      expect(renamed.keys.find(key => key.id === secondId)?.label).toBe("Work key");
      const put = await fetch(new URL("/api/providers/keys/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: firstId }),
      });
      expect(put.status).toBe(200);
      list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as typeof list;
      expect(list.activeId).toBe(firstId);

      // Remove the active key: the other one is promoted.
      const del = await fetch(new URL(`/api/providers/keys?name=opencode-go&id=${firstId}`, server.url), { method: "DELETE" });
      expect(del.status).toBe(200);
      list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as typeof list;
      expect(list.keys.length).toBe(1);
      expect(list.activeId).toBe(secondId);
      const cfg2 = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      expect(cfg2.providers["opencode-go"].apiKey).toBe("key-second-444555666777");
    } finally {
      await server.stop(true);
    }
  });

  test("unknown provider 404; empty key 400", async () => {
    const server = startServer(0);
    try {
      const missing = await fetch(new URL("/api/providers/keys?name=nope", server.url));
      expect(missing.status).toBe(404);
      const bad = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "   " }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});

function loadDiskConfig(): CodexCommanderConfig {
  return JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8")) as CodexCommanderConfig;
}

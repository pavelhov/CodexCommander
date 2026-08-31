import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, setPersistedConfigMutationBeforeCommitForTests } from "../src/config";
import { startServer } from "../src/server";
import { handleManagementAPI } from "../src/server/management-api";
import { listProviderApiKeys } from "../src/providers/api-keys";
import type { MediaManagementRuntime } from "../src/server/management/media-routes";
import {
  createMediaActionAttestationProof,
  type MediaActionAttestationInput,
  verifyMediaActionAttestationProof,
} from "../src/lib/media-action-attestation";
import { createLocalAttestationSecret } from "../src/lib/local-management-attestation";
import type { CodexCommanderConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { ManagementRequest } from "./helpers/management-auth";

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
  setPersistedConfigMutationBeforeCommitForTests(null);
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("provider API key pool", () => {
  test("raw admin cannot mutate the canonical xAI media key pool", async () => {
    const cfg = baseConfig();
    cfg.defaultProvider = "xai";
    cfg.providers = {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        apiKey: "xai-media-key-000111222333",
        apiKeyPool: [
          { id: "xai-first", key: "xai-media-key-000111222333" },
          { id: "xai-second", key: "xai-media-key-444555666777" },
        ],
      },
    };
    saveConfig(cfg);
    const server = startServer(0);
    try {
      const before = await fetch(new URL("/api/providers/keys?name=xai", server.url)).then(response => response.json()) as {
        revision: number;
      };
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "xai", key: "xai-media-key-new", expectedRevision: before.revision }),
      });
      expect(add.status).toBe(403);
      const select = await fetch(new URL("/api/providers/keys/active", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "xai", id: "xai-second", expectedRevision: before.revision }),
      });
      expect(select.status).toBe(403);
      const alias = await fetch(new URL("/api/providers/keys/alias", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "xai", id: "xai-first", alias: "raw admin", expectedRevision: before.revision }),
      });
      expect(alias.status).toBe(403);
      const remove = await fetch(new URL("/api/providers/keys?name=xai&id=xai-first", server.url), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "xai", id: "xai-first", expectedRevision: before.revision }),
      });
      expect(remove.status).toBe(403);
      expect(loadDiskConfig().providers.xai).toMatchObject({
        authMode: "oauth",
        apiKey: "xai-media-key-000111222333",
        apiKeyPool: [{ id: "xai-first" }, { id: "xai-second" }],
      });
    } finally {
      await server.stop(true);
    }
  });

  test("confirmed GUI and exact single-use CLI proof mutate xAI without changing chat auth", async () => {
    const cfg = baseConfig();
    cfg.defaultProvider = "xai";
    cfg.providers = {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        apiKey: "xai-media-key-first",
        apiKeyPool: [{ id: "xai-first", key: "xai-media-key-first" }],
      },
    };
    saveConfig(cfg);
    const secret = createLocalAttestationSecret();
    const pid = 4_321;
    const port = 10_100;
    const now = 2_000_000_000_000;
    const consumed = new Set<string>();
    const runtime: MediaManagementRuntime = {
      state: "ready",
      authorizeInteractiveCliAction: (input, proof) => {
        if (consumed.has(input.nonce) || !verifyMediaActionAttestationProof(secret, input, pid, port, proof, now)) return false;
        consumed.add(input.nonce);
        return true;
      },
    };
    const direct = async (
      path: string,
      init: RequestInit = {},
      principal: "admin-token" | "confirmed-gui-session" = "admin-token",
    ) => {
      const req = new ManagementRequest(`http://127.0.0.1:10100${path}`, init);
      return (await handleManagementAPI(req, new URL(req.url), cfg, { mediaManagement: runtime }, principal))!;
    };

    let listed = await (await direct("/api/providers/keys?name=xai")).json() as { revision: number; activeId: string };
    const added = await direct("/api/providers/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "xai", key: "xai-media-key-second", expectedRevision: listed.revision }),
    }, "confirmed-gui-session");
    expect(added.status).toBe(201);
    expect(cfg.providers.xai!.authMode).toBe("oauth");

    listed = await (await direct("/api/providers/keys?name=xai")).json() as typeof listed;
    const aliasEnvelope = {
      action: "xai_key_alias",
      target: "xai_key",
      name: "xai",
      id: "xai-first",
      alias: "Media primary",
      expectedRevision: listed.revision,
      confirmation: true,
      caller: "interactive_cli",
      nonce: "a".repeat(43),
      issuedAt: now,
    } satisfies MediaActionAttestationInput;
    const sendAlias = (body: MediaActionAttestationInput, proof: string | null) => direct("/api/providers/keys/alias", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(proof ? { "x-codexcommander-media-action-proof": proof } : {}),
      },
      body: JSON.stringify(body),
    });
    const aliasProof = createMediaActionAttestationProof(secret, aliasEnvelope, pid, port);
    expect((await sendAlias({ ...aliasEnvelope, alias: "Changed after confirmation" }, aliasProof)).status).toBe(403);
    expect((await sendAlias(aliasEnvelope, aliasProof)).status).toBe(200);
    expect(cfg.providers.xai!.apiKeyPool?.find(key => key.id === "xai-first")?.label).toBe("Media primary");

    listed = await (await direct("/api/providers/keys?name=xai")).json() as typeof listed;
    const envelope = {
      action: "xai_key_select",
      target: "xai_key",
      name: "xai",
      id: "xai-first",
      expectedRevision: listed.revision,
      confirmation: true,
      caller: "interactive_cli",
      nonce: "x".repeat(43),
      issuedAt: now,
    } satisfies MediaActionAttestationInput;
    const send = (body: MediaActionAttestationInput, proof: string | null) => direct("/api/providers/keys/active", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(proof ? { "x-codexcommander-media-action-proof": proof } : {}),
      },
      body: JSON.stringify(body),
    });
    const changed = { ...envelope, id: "not-the-confirmed-key" };
    expect((await send(envelope, createMediaActionAttestationProof(secret, changed, pid, port))).status).toBe(403);
    const proof = createMediaActionAttestationProof(secret, envelope, pid, port);
    expect((await send(envelope, proof)).status).toBe(200);
    expect(cfg.providers.xai!.apiKey).toBe("xai-media-key-first");
    expect((await send(envelope, proof)).status).toBe(403);
    expect(cfg.providers.xai!.authMode).toBe("oauth");
  });

  test("attested xAI key mutation rejects a stale persisted revision without erasing a competing writer", async () => {
    const cfg = baseConfig();
    cfg.defaultProvider = "xai";
    cfg.providers = {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        apiKey: "xai-media-key-first",
        apiKeyPool: [{ id: "xai-first", key: "xai-media-key-first" }],
      },
    };
    saveConfig(cfg);
    const revision = listDiskXaiRevision();
    setPersistedConfigMutationBeforeCommitForTests(() => {
      const competing = loadConfig();
      const key = "xai-media-key-competing";
      competing.providers.xai!.apiKey = key;
      competing.providers.xai!.apiKeyPool = [{ id: "xai-competing", key }];
      saveConfig(competing);
    });

    const req = new ManagementRequest("http://127.0.0.1:10100/api/providers/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "xai",
        key: "xai-media-key-proposed",
        expectedRevision: revision,
      }),
    });
    const response = (await handleManagementAPI(
      req,
      new URL(req.url),
      cfg,
      {},
      "confirmed-gui-session",
    ))!;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "stale xAI key pool revision" });

    const persisted = loadDiskConfig();
    expect(persisted.providers.xai).toMatchObject({
      authMode: "oauth",
      apiKey: "xai-media-key-competing",
      apiKeyPool: [{ id: "xai-competing", key: "xai-media-key-competing" }],
    });
    expect(JSON.stringify(persisted)).not.toContain("xai-media-key-proposed");
    expect(listProviderApiKeys(cfg, "xai").revision).toBe(listProviderApiKeys(persisted, "xai").revision);
  });

  test("xAI alias CAS cannot restore a key removed by a competing persisted writer", async () => {
    const first = "xai-media-key-first";
    const second = "xai-media-key-second";
    const cfg = baseConfig();
    cfg.defaultProvider = "xai";
    cfg.providers = {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
        apiKey: first,
        apiKeyPool: [
          { id: "xai-first", key: first },
          { id: "xai-second", key: second },
        ],
      },
    };
    saveConfig(cfg);
    const revision = listProviderApiKeys(cfg, "xai").revision;
    setPersistedConfigMutationBeforeCommitForTests(() => {
      const competing = loadConfig();
      competing.providers.xai!.apiKey = second;
      competing.providers.xai!.apiKeyPool = [{ id: "xai-second", key: second }];
      saveConfig(competing);
    });

    const req = new ManagementRequest("http://127.0.0.1:10100/api/providers/keys/alias", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "xai",
        id: "xai-first",
        alias: "must not restore",
        expectedRevision: revision,
      }),
    });
    const response = (await handleManagementAPI(
      req,
      new URL(req.url),
      cfg,
      {},
      "confirmed-gui-session",
    ))!;
    expect(response.status).toBe(409);
    expect(loadDiskConfig().providers.xai).toMatchObject({
      apiKey: second,
      apiKeyPool: [{ id: "xai-second", key: second }],
    });
    expect(cfg.providers.xai!.apiKeyPool?.some(key => key.id === "xai-first")).toBe(false);
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

function listDiskXaiRevision(): number {
  const { revision } = listProviderApiKeys(loadDiskConfig(), "xai");
  return revision;
}

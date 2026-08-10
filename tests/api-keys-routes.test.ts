import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readConfigDiagnostics, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { CodexCommanderConfig } from "../src/types";

// The /api/keys handlers had no direct test before this file: GET masking, POST
// persistence and DELETE semantics were only ever exercised through a CLI fixture
// that stubbed the runtime.

const ADMIN_TOKEN = "admin-secret-for-key-routes";
const previousHome = process.env.CODEXCOMMANDER_HOME;
const previousDataToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
const previousAdminToken = process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
let testHome = "";

function baseConfig(): CodexCommanderConfig {
  return {
    port: 0,
    multiAgentGuidanceEnabled: true,
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "provider-credential-placeholder",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

function configPath(): string {
  return join(testHome, "config.json");
}

function readRawConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
}

function writeRawConfig(value: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify(value, null, 2));
}

/**
 * `/api/*` always requires the management token — a loopback bind relaxes the
 * DATA plane, not this one (src/server/management-auth.ts requireManagementAuth).
 */
async function keysRequest(
  server: { url: URL },
  method: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(new URL("/api/keys", server.url), {
    method,
    headers: { "Content-Type": "application/json", "x-codexcommander-api-key": ADMIN_TOKEN },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  try { json = await res.json() as Record<string, unknown>; } catch { /* empty body */ }
  return { status: res.status, json };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ccx-api-keys-routes-"));
  process.env.CODEXCOMMANDER_HOME = testHome;
  delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
  process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("POST /api/keys", () => {
  test("persists a key and returns the full secret exactly once", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "deploy" });
      expect(created.status).toBe(201);
      expect(created.json.name).toBe("deploy");
      expect(created.json.key).toMatch(/^ccx_data_[0-9a-f]{40}$/);

      const stored = loadConfig().apiKeys ?? [];
      expect(stored).toHaveLength(1);
      expect(stored[0]!.key).toBe(created.json.key as string);
    } finally {
      await server.stop(true);
    }
  });

  test("two keys differ in the eight random hex the list actually shows", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const first = await keysRequest(server, "POST", { name: "one" });
      const second = await keysRequest(server, "POST", { name: "two" });
      const a = first.json.key as string;
      const b = second.json.key as string;
      expect(a).not.toBe(b);
      // The displayed prefix must discriminate; masking 8 characters showed the
      // fixed `ccx_data` literal for every key ever generated.
      expect(a.slice(0, 17)).not.toBe(b.slice(0, 17));
    } finally {
      await server.stop(true);
    }
  });

  test("generation does not depend on provider credentials", async () => {
    const config = baseConfig();
    delete config.providers.test!.apiKey;
    saveConfig(config);
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "no-providers" });
      expect(created.status).toBe(201);
      expect(created.json.key).toMatch(/^ccx_data_[0-9a-f]{40}$/);
    } finally {
      await server.stop(true);
    }
  });

  test("the POST handler no longer reads provider API keys", async () => {
    const source = readFileSync(new URL("../src/server/management/oauth-account-routes.ts", import.meta.url), "utf-8");
    const start = source.indexOf('url.pathname === "/api/keys" && req.method === "POST"');
    const end = source.indexOf('url.pathname === "/api/keys" && req.method === "PATCH"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).not.toContain("p.apiKey");
    expect(handler).not.toContain("CryptoHasher");
    expect(handler).toContain("randomBytes(20)");
  });

  test.each([
    ["a 65-character name", { name: "x".repeat(65) }],
    ["an embedded control character", { name: "a\u0000b" }],
    ["a trailing newline", { name: "deploy\n" }],
    ["a tab-only name", { name: "\t" }],
    ["a numeric name", { name: 42 }],
    ["an array name", { name: [] }],
    ["an object name", { name: {} }],
  ])("rejects %s with 400 and persists nothing", async (_label, body) => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", body);
      expect(created.status).toBe(400);
      expect(loadConfig().apiKeys ?? []).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a malformed JSON body is a 400, not a 500", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", "{not json");
      expect(created.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});

describe("GET /api/keys", () => {
  test("serves a discriminating prefix and never the secret", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const first = await keysRequest(server, "POST", { name: "one" });
      await keysRequest(server, "POST", { name: "two" });

      const listed = await keysRequest(server, "GET");
      expect(listed.status).toBe(200);
      const rows = listed.json.keys as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.key).toBeUndefined();
        expect(String(row.prefix)).toHaveLength(20); // 17 + "..."
      }
      expect(rows[0]!.prefix).not.toBe(rows[1]!.prefix);
      expect(JSON.stringify(listed.json)).not.toContain(first.json.key as string);
    } finally {
      await server.stop(true);
    }
  });
});

describe("PATCH /api/keys", () => {
  test("renames a key without echoing key material", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "before" });
      const renamed = await keysRequest(server, "PATCH", { id: created.json.id, name: "after" });
      expect(renamed.status).toBe(200);
      expect(renamed.json.name).toBe("after");
      expect(renamed.json.key).toBeUndefined();

      const listed = await keysRequest(server, "GET");
      const rows = listed.json.keys as Array<Record<string, unknown>>;
      expect(rows[0]!.name).toBe("after");
    } finally {
      await server.stop(true);
    }
  });

  test("an unknown id is 404 and changes nothing", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "keep" });
      const renamed = await keysRequest(server, "PATCH", { id: "nope", name: "other" });
      expect(renamed.status).toBe(404);
      expect((loadConfig().apiKeys ?? [])[0]!.name).toBe("keep");
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    ["an empty name", (id: string) => ({ id, name: "  " })],
    ["a non-string id", () => ({ id: 42, name: "x" })],
  ])("rejects %s with 400", async (_label, build) => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "keep" });
      const renamed = await keysRequest(server, "PATCH", build(created.json.id as string));
      expect(renamed.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});

describe("DELETE /api/keys", () => {
  test("removes a known key", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "temp" });
      const removed = await keysRequest(server, "DELETE", { id: created.json.id });
      expect(removed.status).toBe(200);
      expect(loadConfig().apiKeys ?? []).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("an unknown id is 404, not a fake successful revocation", async () => {
    saveConfig(baseConfig());
    const server = startServer(0);
    try {
      await keysRequest(server, "POST", { name: "keep" });
      const removed = await keysRequest(server, "DELETE", { id: "never-existed" });
      expect(removed.status).toBe(404);
      expect(loadConfig().apiKeys ?? []).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
  });
});

describe("apiKeys current config schema", () => {
  function installInvalidRows(rows: unknown): Record<string, unknown> {
    const raw = structuredClone(baseConfig()) as unknown as Record<string, unknown>;
    raw.apiKeys = rows;
    writeRawConfig(raw);
    return raw;
  }

  test("a non-array apiKeys value rejects the entire persisted config", () => {
    installInvalidRows("oops");
    expect(() => loadConfig()).toThrow("apiKeys");
    expect(readConfigDiagnostics()).toMatchObject({
      source: "fallback",
      error: expect.stringContaining("apiKeys"),
    });
  });

  test("one malformed row rejects valid siblings instead of salvaging a subset", () => {
    const raw = installInvalidRows([
      { id: "good", name: "usable", key: "ccx_data_usable", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "", name: 7 },
    ]);
    expect(() => loadConfig()).toThrow("apiKeys");
    expect(readRawConfig()).toEqual(raw);
    expect(readConfigDiagnostics().source).toBe("fallback");
  });

  test("malformed identity and metadata reject the credential array", () => {
    for (const row of [
      { id: 7, name: "bad-id", key: "ccx_data_badid", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "bad-name", name: 7, key: "ccx_data_badname", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "bad-date", name: "bad-date", key: "ccx_data_baddate", createdAt: 7 },
      { id: "bad-secret", name: "bad-secret", key: " ccx_data_badsecret ", createdAt: "2026-07-31T00:00:00.000Z" },
    ]) {
      installInvalidRows([row]);
      expect(() => loadConfig()).toThrow("apiKeys");
      expect(readConfigDiagnostics().source).toBe("fallback");
    }
  });

  test("duplicate ids reject the entire current credential array", () => {
    installInvalidRows([
      { id: "same", name: "one", key: "ccx_data_dupone", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "same", name: "two", key: "ccx_data_duptwo", createdAt: "2026-07-31T00:00:00.000Z" },
    ]);
    expect(() => loadConfig()).toThrow("duplicate API-key id");
    expect(readConfigDiagnostics()).toMatchObject({
      source: "fallback",
      error: expect.stringContaining("duplicate API-key id"),
    });
  });

  test("removed or unknown row fields are rejected rather than preserved", () => {
    installInvalidRows([{
      id: "extra",
      name: "extra",
      key: "ccx_data_extra",
      createdAt: "2026-07-31T00:00:00.000Z",
      futureField: "not-current",
    }]);
    expect(() => loadConfig()).toThrow("apiKeys");
    expect(readConfigDiagnostics()).toMatchObject({
      source: "fallback",
      error: expect.stringContaining("unrecognized field"),
    });
  });

  test("saveConfig rejects malformed in-memory rows without writing them", () => {
    const current = baseConfig();
    current.apiKeys = [{
      id: "",
      name: "invalid",
      key: "ccx_data_invalid",
      createdAt: "2026-07-31T00:00:00.000Z",
    }];
    expect(() => saveConfig(current)).toThrow("Cannot persist invalid CodexCommander config");
    expect(readConfigDiagnostics().source).toBe("default");
  });

  test("fully current rows load and survive a management mutation", async () => {
    const config = baseConfig();
    config.apiKeys = [{
      id: "current",
      name: "current",
      key: "ccx_data_current",
      createdAt: "2026-07-31T00:00:00.000Z",
    }];
    saveConfig(config);

    const server = startServer(0);
    try {
      const created = await keysRequest(server, "POST", { name: "second" });
      expect(created.status).toBe(201);
      const persisted = loadConfig().apiKeys ?? [];
      expect(persisted).toHaveLength(2);
      expect(persisted[0]).toEqual(config.apiKeys[0]!);
    } finally {
      await server.stop(true);
    }
  });
});

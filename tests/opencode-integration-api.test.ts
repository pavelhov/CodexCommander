import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

const ADMISSION_TOKEN = "ocx_test_integration_admission_secret";

function config(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "go-user-key",
        authMode: "key",
        liveModels: false,
        models: ["gpt-5.6-luna", "qwen3.8-max"],
        modelContextWindows: { "gpt-5.6-luna": 1_000_000 },
      },
    },
  } as OcxConfig;
}

describe("OpenCode integration management API", () => {
  let root: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-opencode-api-"));
    previous = {
      OPENCODEX_HOME: process.env.OPENCODEX_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      OPENCODEX_API_AUTH_TOKEN: process.env.OPENCODEX_API_AUTH_TOKEN,
    };
    process.env.OPENCODEX_HOME = join(root, "ocx-state");
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    process.env.OPENCODEX_API_AUTH_TOKEN = ADMISSION_TOKEN;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function api(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(`http://127.0.0.1:10100${path}`);
    const response = await handleManagementAPI(
      new Request(url, { ...init, headers: { Host: url.host, ...(init?.headers ?? {}) } }),
      url,
      config(),
      { saveConfigPreservingClaudeCode: () => {}, refreshCodexCatalog: async () => {} },
    );
    expect(response).not.toBeNull();
    return response!;
  }

  test("GET reports installation and an unapplied integration without mutating", async () => {
    const response = await api("/api/integrations/opencode");
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body.integration.state).toBe("not_applied");
    expect(typeof body.installation.desktopInstalled).toBe("boolean");
    expect(typeof body.installation.cliInstalled).toBe("boolean");
    expect(body.downloadUrl).toBe("https://opencode.ai/download");
    expect(existsSync(join(root, "xdg", "opencode", "opencode.json"))).toBe(false);
  });

  test("Apply writes a file reference and never serializes the token", async () => {
    const response = await api("/api/integrations/opencode/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoConnect: true }),
    });
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.integration.state).toBe("applied");
    expect(body.integration.autoConnect).toBe(true);

    const configPath = join(root, "xdg", "opencode", "opencode.json");
    const applied = readFileSync(configPath, "utf8");
    const journal = readFileSync(join(root, "ocx-state", "integrations", "opencode", "journal.json"), "utf8");
    expect(applied).toContain('"opencodex"');
    expect(applied).toContain("{file:");
    expect(applied).not.toContain(ADMISSION_TOKEN);
    expect(journal).not.toContain(ADMISSION_TOKEN);
    expect(JSON.stringify(body)).not.toContain(ADMISSION_TOKEN);
  }, 15_000);

  test("Restore removes a newly-created client config exactly", async () => {
    await api("/api/integrations/opencode/apply", { method: "POST" });
    const configPath = join(root, "xdg", "opencode", "opencode.json");
    expect(existsSync(configPath)).toBe(true);

    const response = await api("/api/integrations/opencode/restore", { method: "POST" });
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body.restored).toBe(true);
    expect(body.exact).toBe(true);
    expect(body.integration.state).toBe("not_applied");
    expect(existsSync(configPath)).toBe(false);
  }, 15_000);

  test("invalid apply and restore bodies fail before any mutation", async () => {
    const apply = await api("/api/integrations/opencode/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoConnect: "yes" }),
    });
    expect(apply.status).toBe(400);
    const restore = await api("/api/integrations/opencode/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "replace-everything" }),
    });
    expect(restore.status).toBe(400);
    expect(existsSync(join(root, "xdg", "opencode", "opencode.json"))).toBe(false);
  });
});

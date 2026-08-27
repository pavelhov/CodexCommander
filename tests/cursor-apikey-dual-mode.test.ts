import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCursorRunBearerCache,
  cursorCredentialLooksLikeJwt,
  cursorUserApiKeyNeedsExchange,
  materializeCursorRunBearer,
  validateCursorApiKey,
} from "../src/adapters/cursor/run-bearer";
import * as cursorLiveModels from "../src/adapters/cursor/live-models";
import { KEY_LOGIN_PROVIDERS, listKeyLoginProviders } from "../src/oauth/key-providers";
import { providerConfigFromKeyLoginProvider } from "../src/oauth/login-cli";
import { addProviderApiKey, isKeyAuthProvider } from "../src/providers/api-keys";
import { deriveKeyLoginMap } from "../src/providers/derive";
import { routeModel } from "../src/router";
import type { CodexCommanderConfig } from "../src/types";
import { isCursorKeyAuthOverride, providerAuthSurface } from "../gui/src/provider-workspace/auth";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCursorRunBearerCache();
  mock.restore();
});

function jwtAccess(expSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, sub: "cursor-user" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function cursorKeyConfig(authMode: "key" | "oauth", apiKey = "cursor-test-key"): CodexCommanderConfig {
  return {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    defaultProvider: "cursor",
    providers: {
      cursor: {
        adapter: "cursor",
        baseUrl: "https://api2.cursor.sh",
        authMode,
        apiKey,
        apiKeyPool: [{ id: "aaaaaaaa", key: apiKey }],
      },
    },
  };
}

describe("Cursor API-key dual-mode contract", () => {
  test("key-login list includes cursor when allowKeyAuthOverride and dashboardUrl are set", async () => {
    expect(KEY_LOGIN_PROVIDERS.cursor).toMatchObject({
      adapter: "cursor",
      dashboardUrl: "https://cursor.com/dashboard/api",
      liveModels: true,
      defaultModel: "auto",
    });
    expect(listKeyLoginProviders().some(row => row.id === "cursor")).toBe(true);
    expect(deriveKeyLoginMap().cursor?.dashboardUrl).toBe("https://cursor.com/dashboard/api");
    expect(Object.keys(deriveKeyLoginMap())).not.toContain("github-copilot");
    const keyProvidersSource = await Bun.file("src/oauth/key-providers.ts").text();
    expect(keyProvidersSource).toContain("validateCursorApiKey");
    expect(keyProvidersSource).toContain('provider.adapter === "cursor"');
  });

  test("CLI key-login payload sets authMode key so routing honors the pasted secret", () => {
    const provider = providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.cursor!, "crsr_dashboard");
    expect(provider).toMatchObject({
      adapter: "cursor",
      baseUrl: "https://api2.cursor.sh",
      authMode: "key",
      apiKey: "crsr_dashboard",
      defaultModel: "auto",
    });
    const config: CodexCommanderConfig = {
      port: 10100,
      defaultProvider: "cursor",
      providers: { cursor: provider },
    };
    const routed = routeModel(config, "cursor/auto").provider;
    expect(routed.authMode).toBe("key");
    expect(routed.apiKey).toBe("crsr_dashboard");
  });

  test("explicit key billing routes; oauth default still wins without a usable key", () => {
    expect(routeModel(cursorKeyConfig("key"), "cursor/auto").provider.authMode).toBe("key");
    expect(routeModel(cursorKeyConfig("oauth"), "cursor/auto").provider.authMode).toBe("oauth");
    const missing = cursorKeyConfig("key", "${CCX_TEST_CURSOR_API_KEY_MISSING}");
    const previous = process.env.CCX_TEST_CURSOR_API_KEY_MISSING;
    delete process.env.CCX_TEST_CURSOR_API_KEY_MISSING;
    try {
      const routed = routeModel(missing, "cursor/auto").provider;
      expect(routed.authMode).toBe("oauth");
      expect(routed.apiKey).toBeUndefined();
      expect(missing.providers.cursor!.authMode).toBe("key");
    } finally {
      if (previous === undefined) delete process.env.CCX_TEST_CURSOR_API_KEY_MISSING;
      else process.env.CCX_TEST_CURSOR_API_KEY_MISSING = previous;
    }
  });

  test("API-key pool accepts an oauth Cursor row and flips billing to key", () => {
    const previousHome = process.env.CODEXCOMMANDER_HOME;
    const testHome = mkdtempSync(join(tmpdir(), "ccx-cursor-apikey-"));
    process.env.CODEXCOMMANDER_HOME = testHome;
    try {
      const config = cursorKeyConfig("oauth");
      delete config.providers.cursor!.apiKey;
      delete config.providers.cursor!.apiKeyPool;
      expect(isKeyAuthProvider(config.providers.cursor!)).toBe(true);
      const result = addProviderApiKey(config, "cursor", "crsr_pasted_from_dashboard");
      expect("id" in result).toBe(true);
      expect(config.providers.cursor!.authMode).toBe("key");
      expect(config.providers.cursor!.apiKey).toBe("crsr_pasted_from_dashboard");
      expect(routeModel(config, "cursor/auto").provider.authMode).toBe("key");
    } finally {
      if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previousHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("GUI Settings surface keeps OAuth accounts and exposes the API-key pool", () => {
    const oauthCursor = {
      name: "cursor",
      adapter: "cursor" as const,
      baseUrl: "https://api2.cursor.sh",
      authMode: "oauth" as const,
      hasApiKey: false,
    };
    const keyCursor = { ...oauthCursor, authMode: "key" as const, hasApiKey: true };
    expect(providerAuthSurface(oauthCursor)).toBe("oauth-accounts");
    expect(providerAuthSurface(keyCursor)).toBe("api-keys");
    expect(isCursorKeyAuthOverride(oauthCursor)).toBe(true);
    expect(isCursorKeyAuthOverride(keyCursor)).toBe(true);
    expect(isCursorKeyAuthOverride({ name: "xai", adapter: "openai-chat" })).toBe(false);
  });
});

describe("Cursor dashboard key exchange vs raw Bearer", () => {
  test("classifies JWT access tokens vs crsr_ dashboard keys", () => {
    expect(cursorCredentialLooksLikeJwt(jwtAccess())).toBe(true);
    expect(cursorUserApiKeyNeedsExchange(jwtAccess())).toBe(false);
    expect(cursorUserApiKeyNeedsExchange("crsr_live_user_key")).toBe(true);
    expect(cursorUserApiKeyNeedsExchange("CRSR_LIVE_USER_KEY")).toBe(true);
    expect(cursorUserApiKeyNeedsExchange("key_cloud_agents")).toBe(false);
    expect(cursorUserApiKeyNeedsExchange("test-token")).toBe(false);
  });

  test("uses an unexpired JWT as the Run Bearer without calling exchange", async () => {
    const token = jwtAccess();
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    expect(await materializeCursorRunBearer(token)).toBe(token);
    expect(fetches).toBe(0);
  });

  test("exchanges a crsr_ dashboard key and caches the access token", async () => {
    const access = jwtAccess();
    let fetches = 0;
    let seenAuth = "";
    let seenUrl = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetches++;
      seenUrl = String(input);
      seenAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      return new Response(JSON.stringify({ accessToken: access, refreshToken: "crsr_live_user_key" }), { status: 200 });
    }) as typeof fetch;
    expect(await materializeCursorRunBearer("crsr_live_user_key")).toBe(access);
    expect(seenUrl).toBe("https://api2.cursor.sh/auth/exchange_user_api_key");
    expect(seenAuth).toBe("Bearer crsr_live_user_key");
    expect(await materializeCursorRunBearer("crsr_live_user_key")).toBe(access);
    expect(fetches).toBe(1);
  });

  test("live transport keeps the original secret so a crsr_ key can be re-exchanged", async () => {
    const source = await Bun.file("src/adapters/cursor/live-transport.ts").text();
    expect(source).toContain("materializeCursorRunBearer(this.token");
    expect(source).not.toMatch(/this\.token\s*=\s*await materializeCursorRunBearer/);
    expect(source).toContain("authorization: `Bearer ${runBearer}`");
  });

  test("leaves Cloud Agents-style keys untouched so Run/GetUsableModels fail honestly", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response("nope", { status: 401 });
    }) as typeof fetch;
    expect(await materializeCursorRunBearer("key_cloud_agents_secret")).toBe("key_cloud_agents_secret");
    expect(fetches).toBe(0);
  });
});

describe("Cursor key validation path", () => {
  test("accepts a secret that already works as a GetUsableModels Bearer and never hits GET /models", async () => {
    const spy = spyOn(cursorLiveModels, "fetchCursorUsableModels").mockResolvedValue({ ok: true, models: ["auto"] });
    let fetches = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetches++;
      throw new Error(`unexpected fetch ${String(input)}`);
    }) as typeof fetch;
    try {
      expect(await validateCursorApiKey("working-bearer")).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ apiKey: "working-bearer" });
      expect(fetches).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("exchanges a crsr_ key after GetUsableModels auth-fails, then accepts the access token", async () => {
    const access = jwtAccess();
    const spy = spyOn(cursorLiveModels, "fetchCursorUsableModels").mockImplementation(async opts => {
      if (opts.apiKey === access) return { ok: true, models: ["auto"] };
      return { ok: false, error: "auth", detail: "HTTP 401" };
    });
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(String((init?.headers as Record<string, string> | undefined)?.Authorization)).toBe("Bearer crsr_needs_exchange");
      return new Response(JSON.stringify({ accessToken: access }), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await validateCursorApiKey("crsr_needs_exchange")).toBe(true);
      expect(spy.mock.calls.map(call => call[0]?.apiKey)).toEqual(["crsr_needs_exchange", access]);
    } finally {
      spy.mockRestore();
    }
  });

  test("rejects a secret that fails GetUsableModels and is not exchangeable", async () => {
    const spy = spyOn(cursorLiveModels, "fetchCursorUsableModels").mockResolvedValue({
      ok: false,
      error: "auth",
      detail: "HTTP 401",
    });
    try {
      expect(await validateCursorApiKey("key_cloud_agents")).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

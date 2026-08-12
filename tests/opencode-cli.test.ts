import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelCache } from "../src/codex/model-cache";
import { loadServiceTokenFromFile, serviceApiTokenFilePath } from "../src/lib/service-secrets";
import {
  OPENCODE_API_KEY_ENV,
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_CONFIG_CONTENT_ENV,
  OPENCODE_PROVIDER_ID,
  SCHEMA_REQUIRED_OUTPUT_BUDGET,
  buildOpencodeEnv,
  buildOpencodeProviderBlockFromCatalog,
  fetchOpencodeProxyModels,
  isOpencodeRuntimeConfigError,
  mergeOpencodeRuntimeConfig,
  opencodeApiKey,
  opencodeCatalogFromProxyRows,
  opencodeGlobalConfigPath,
  opencodeNotFoundHint,
  opencodeProviderOverridePath,
  opencodeProxyBaseUrl,
  opencodeProxyStartEnv,
  parseJsonc,
  serializeOpencodeRuntimeConfig,
} from "../src/cli/opencode";
import type { OpencodeCatalogModel } from "../src/clients/config-export";
import type { CodexCommanderConfig } from "../src/types";
import {
  ATTESTATION_CHALLENGE_HEADER,
  ATTESTATION_PROOF_HEADER,
} from "../src/identity";
import { createLocalAttestationProof } from "../src/lib/local-management-attestation";
import { PROXY_DELEGATED_START_ENV } from "../src/server/proxy-lifecycle-protocol";

function cfg(extra?: Partial<CodexCommanderConfig>): CodexCommanderConfig {
  return {
    port: 10100,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://x/v1" } },
    ...extra,
  } as CodexCommanderConfig;
}

function nativeModel(id: string, contextWindow?: number): OpencodeCatalogModel {
  return { namespaced: id, native: true, provider: "openai", id, contextWindow };
}

function routedModel(
  provider: string,
  id: string,
  extra: Pick<OpencodeCatalogModel, "contextWindow" | "displayName"> = {},
): OpencodeCatalogModel {
  return { namespaced: `${provider}/${id}`, native: false, provider, id, ...extra };
}

describe("ccx opencode provider block", () => {
  test("points at the live proxy port over the OpenAI-compatible surface", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10123, []);
    expect(block.options.baseURL).toBe("http://127.0.0.1:10123/v1");
    expect(block.npm).toBe("@ai-sdk/openai-compatible");
  });

  test("uses probeHostname for IPv6 and specific-interface binds", () => {
    expect(buildOpencodeProviderBlockFromCatalog(10100, [], "::1").options.baseURL)
      .toBe("http://[::1]:10100/v1");
    expect(buildOpencodeProviderBlockFromCatalog(10100, [], "192.168.4.10").options.baseURL)
      .toBe("http://192.168.4.10:10100/v1");
    expect(opencodeProxyBaseUrl(8080, "fe80::1")).toBe("http://[fe80::1]:8080/v1");
  });

  test("apiKey is an env reference, never a literal secret", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, []);
    expect(block.options.apiKey).toBe(OPENCODE_API_KEY_ENV_REF);
    expect(JSON.stringify(block)).not.toContain("sk-");
  });

  test("non-loopback binds add x-codexcommander-api-key via env reference", () => {
    const block = buildOpencodeProviderBlockFromCatalog(
      10100,
      [],
      "0.0.0.0",
      cfg({ hostname: "0.0.0.0" }),
    );
    expect(block.options.headers).toEqual({ "x-codexcommander-api-key": OPENCODE_API_KEY_ENV_REF });
    expect(block.options.apiKey).toBeUndefined();
    expect(JSON.stringify(block.options)).not.toContain("sk-");
  });

  test("loopback binds use apiKey and omit the dedicated admission header", () => {
    const block = buildOpencodeProviderBlockFromCatalog(
      10100,
      [],
      "127.0.0.1",
      cfg({ hostname: "127.0.0.1" }),
    );
    expect(block.options.apiKey).toBe(OPENCODE_API_KEY_ENV_REF);
    expect(block.options.headers).toBeUndefined();
  });

  test("routed models key on provider/id, native slugs stay bare", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [
      nativeModel("gpt-5.6-sol"),
      routedModel("kiro", "glm-5"),
    ]);
    expect(Object.keys(block.models).sort()).toEqual(["gpt-5.6-sol", "kiro/glm-5"]);
  });

  test("limit.context is emitted only from an authoritative contextWindow — never guessed", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [
      routedModel("kiro", "with-window", { contextWindow: 200_000 }),
      routedModel("kiro", "no-window"),
      routedModel("kiro", "zero-window", { contextWindow: 0 }),
    ]);
    expect(block.models["kiro/with-window"]?.limit?.context).toBe(200_000);
    expect(block.models["kiro/no-window"]?.limit).toBeUndefined();
    expect(block.models["kiro/zero-window"]?.limit).toBeUndefined();
  });

  test("limit.output rides along with context because opencode's schema requires the pair", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [
      routedModel("kiro", "m", { contextWindow: 200_000 }),
    ]);
    expect(block.models["kiro/m"]?.limit).toEqual({ context: 200_000, output: SCHEMA_REQUIRED_OUTPUT_BUDGET });
  });

  test("limit.output is clamped to the context window for small-context models", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [
      routedModel("local", "tiny", { contextWindow: 8_192 }),
    ]);
    expect(block.models["local/tiny"]?.limit).toEqual({ context: 8_192, output: 8_192 });
  });

  test("native slugs pick up authoritative context windows from the resolver", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [
      nativeModel("gpt-5.4", 1_000_000),
      nativeModel("unknown-native"),
    ]);
    expect(block.models["gpt-5.4"]?.limit).toEqual({ context: 1_000_000, output: SCHEMA_REQUIRED_OUTPUT_BUDGET });
    expect(block.models["unknown-native"]?.limit).toBeUndefined();
  });

  test("displayName is used for the label when the catalog provides one", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [
      routedModel("kiro", "glm-5", { displayName: "GLM-5" }),
      routedModel("kiro", "qwen3-coder-next"),
    ]);
    expect(block.models["kiro/glm-5"]?.name).toBe("GLM-5 (kiro)");
    expect(block.models["kiro/qwen3-coder-next"]?.name).toBe("qwen3-coder-next (kiro)");
  });

  test("duplicate keys keep the first entry instead of throwing", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [
      routedModel("kiro", "dup", { displayName: "First" }),
      routedModel("kiro", "dup", { displayName: "Second" }),
    ]);
    expect(block.models["kiro/dup"]?.name).toBe("First (kiro)");
  });

});

describe("ccx opencode runtime config", () => {
  test("serializes only the generated provider block for OPENCODE_CONFIG_CONTENT", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [routedModel("kiro", "glm-5")]);
    const runtime = mergeOpencodeRuntimeConfig(undefined, block);
    expect(isOpencodeRuntimeConfigError(runtime)).toBe(false);
    if (isOpencodeRuntimeConfigError(runtime)) return;
    const parsed = JSON.parse(serializeOpencodeRuntimeConfig(runtime)) as { provider?: Record<string, unknown> };
    expect(Object.keys(parsed.provider ?? {})).toEqual([OPENCODE_PROVIDER_ID]);
    expect(parsed.provider?.[OPENCODE_PROVIDER_ID]).toBeTruthy();
  });

  test("merges inherited inline settings and overrides only provider.codexcommander", () => {
    const inherited = JSON.stringify({
      model: "other/default",
      agents: { coder: { model: "x" } },
      provider: {
        other: { npm: "@other/pkg", name: "Other" },
        [OPENCODE_PROVIDER_ID]: { npm: "stale", name: "Stale" },
      },
    });
    const block = buildOpencodeProviderBlockFromCatalog(10100, [routedModel("kiro", "glm-5")]);
    const merged = mergeOpencodeRuntimeConfig(inherited, block);
    expect(isOpencodeRuntimeConfigError(merged)).toBe(false);
    if (isOpencodeRuntimeConfigError(merged)) return;
    expect(merged.model).toBe("other/default");
    expect(merged.agents).toEqual({ coder: { model: "x" } });
    expect(merged.provider.other).toEqual({ npm: "@other/pkg", name: "Other" });
    expect(merged.provider[OPENCODE_PROVIDER_ID]).toEqual(block);
  });

  test("rejects invalid inherited OPENCODE_CONFIG_CONTENT", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, []);
    expect(mergeOpencodeRuntimeConfig("{ not json", block)).toEqual({ error: "OPENCODE_CONFIG_CONTENT is not valid JSON." });
    expect(mergeOpencodeRuntimeConfig("[]", block)).toEqual({ error: "OPENCODE_CONFIG_CONTENT must be a JSON object." });
    expect(mergeOpencodeRuntimeConfig(JSON.stringify({ provider: "bad" }), block))
      .toEqual({ error: "OPENCODE_CONFIG_CONTENT provider must be a JSON object when present." });
  });
});

describe("ccx opencode JSONC parsing", () => {
  test("plain JSON parses unchanged", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 });
  });

  test("line and block comments are accepted", () => {
    expect(parseJsonc('{\n // lead\n "a": 1 /* trail */\n}')).toEqual({ a: 1 });
  });

  test("trailing commas are accepted", () => {
    expect(parseJsonc('{"a":[1,2,],"b":2,}')).toEqual({ a: [1, 2], b: 2 });
  });

  test("comment-like and comma-like text inside strings is preserved", () => {
    expect(parseJsonc('{"url":"http://x/v1","note":"a // b /* c */","t":"x,"}'))
      .toEqual({ url: "http://x/v1", note: "a // b /* c */", t: "x," });
  });

  test("escaped quotes do not break string tracking", () => {
    expect(parseJsonc('{"a":"he said \\"hi\\" // not a comment"}'))
      .toEqual({ a: 'he said "hi" // not a comment' });
  });

  test("genuinely malformed input still throws", () => {
    expect(() => parseJsonc("{ not json")).toThrow();
  });
});

describe("ccx opencode proxy model catalog", () => {
  const ENV_KEY = "CCX_TEST_OPENCODE_PROXY_ONLY_KEY";
  const RESOLVED = "proxy-only-resolved-key";
  const PROVIDER = "proxyenv";

  test("uses /api/models namespaced selectors and resolves env-backed provider keys only in the proxy", async () => {
    const originalFetch = globalThis.fetch;
    let requestedAuth: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("proxyenv.test")) {
        requestedAuth = new Headers(init?.headers).get("authorization") ?? undefined;
        if (requestedAuth === `Bearer ${RESOLVED}`) {
          return new Response(JSON.stringify({
            data: [{ id: "live-via-proxy-env", context_length: 128_000 }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("unauthorized", { status: 401 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    const config = {
      port: 10100,
      defaultProvider: PROVIDER,
      providers: {
        [PROVIDER]: {
          adapter: "openai-chat",
          authMode: "key",
          baseUrl: "https://proxyenv.test/v1",
          apiKey: `\${${ENV_KEY}}`,
          models: ["static-fallback"],
          // Discovery runs on the pinned transport; hand it back the stub above.
          fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
        },
      },
    } as CodexCommanderConfig;

    const previous = process.env[ENV_KEY];
    const previousAdmin = process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
    const previousData = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
    delete process.env[ENV_KEY];
    clearModelCache(PROVIDER);
    try {
      const { fetchAllModels } = await import("../src/server/management/shared");
      const cliModels = await fetchAllModels(config);
      const cliIds = cliModels.filter(m => m.provider === PROVIDER).map(m => m.id).sort();
      expect(cliIds).toEqual(["static-fallback"]);
      expect(cliIds).not.toContain("live-via-proxy-env");

      process.env[ENV_KEY] = RESOLVED;
      clearModelCache(PROVIDER);
      requestedAuth = undefined;

      const { handleManagementAPI } = await import("../src/server/management-api");
      const modelsRes = await handleManagementAPI(
        new Request("http://localhost/api/models"),
        new URL("http://localhost/api/models"),
        config,
      );
      const rows = await modelsRes!.json() as Array<{
        namespaced?: string;
        contextWindow?: number;
      }>;
      expect(requestedAuth).toBe(`Bearer ${RESOLVED}`);

      const liveRow = rows.find(r => r.namespaced === `${PROVIDER}/live-via-proxy-env`);
      expect(liveRow).toBeTruthy();
      expect(liveRow?.contextWindow).toBe(128_000);

      const catalog = opencodeCatalogFromProxyRows(rows, config);
      expect(catalog.map(m => m.namespaced)).toContain(`${PROVIDER}/live-via-proxy-env`);

      const block = buildOpencodeProviderBlockFromCatalog(10100, catalog, undefined, config);
      expect(block.models[`${PROVIDER}/live-via-proxy-env`]?.limit?.context).toBe(128_000);
      expect(block.models[`${PROVIDER}/live-via-proxy-env`]?.name).toBe("live-via-proxy-env (proxyenv)");

      process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = "admin-management-secret";
      process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "data-inference-secret";
      const attestationSecret = "A".repeat(43);
      const fetched = await fetchOpencodeProxyModels(
        { port: 10100, hostname: "127.0.0.1", pid: 1, source: "runtime" },
        {
          managementAttestation: {
            readRuntimeFn: () => ({ pid: 1, port: 10100, hostname: "127.0.0.1", attestationSecret }),
            verifyPidFn: candidate => candidate,
          },
          fetchImpl: async (url, init) => {
            if (String(url).endsWith("/healthz")) {
              const headers = new Headers(init?.headers);
              expect(headers.get("X-CodexCommander-API-Key")).toBeNull();
              const challenge = headers.get(ATTESTATION_CHALLENGE_HEADER)!;
              const proof = createLocalAttestationProof(attestationSecret, challenge, 1, 10100)!;
              return new Response("ignored", { headers: { [ATTESTATION_PROOF_HEADER]: proof } });
            }
            expect(String(url)).toBe("http://127.0.0.1:10100/api/models");
            expect(new Headers(init?.headers).get("X-CodexCommander-API-Key")).toBe("admin-management-secret");
            expect(new Headers(init?.headers).get("X-CodexCommander-API-Key")).not.toBe("data-inference-secret");
            return new Response(JSON.stringify(rows), { status: 200 });
          },
        },
      );
      expect(fetched.find(r => r.namespaced === `${PROVIDER}/live-via-proxy-env`)).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache(PROVIDER);
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
      if (previousAdmin === undefined) delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
      else process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = previousAdmin;
      if (previousData === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
      else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = previousData;
    }
  });

  test("fetchOpencodeProxyModels aborts stalled /api/models fetch and body reads", async () => {
    const live = { port: 10100, hostname: "127.0.0.1", pid: 1, source: "runtime" as const };
    const attested = async () => ({
      ...live,
      baseUrl: "http://127.0.0.1:10100",
    });
    const stall = (init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });

    await expect(fetchOpencodeProxyModels(live, {
      timeoutMs: 25,
      attestLiveManagementProxyImpl: attested,
      fetchImpl: async (_url, init) => stall(init),
    })).rejects.toThrow("Management API timed out while fetching /api/models.");

    await expect(fetchOpencodeProxyModels(live, {
      timeoutMs: 25,
      attestLiveManagementProxyImpl: attested,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => {}),
      } as Response),
    })).rejects.toThrow("Management API timed out while fetching /api/models.");
  });

  test("opencodeCatalogFromProxyRows omits disabled and direct-mode native rows", () => {
    const directConfig = cfg({
      providers: {
        mock: { adapter: "openai-chat", baseUrl: "http://x/v1" },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    const rows = [
      { namespaced: "gpt-5.6-sol", native: true, disabled: false, provider: "openai", id: "gpt-5.6-sol" },
      { namespaced: "gpt-5.5", native: true, disabled: true, provider: "openai", id: "gpt-5.5" },
      { namespaced: "kiro/glm-5", native: false, disabled: false, provider: "kiro", id: "glm-5", displayName: "GLM-5" },
    ];
    expect(opencodeCatalogFromProxyRows(rows, directConfig).map(m => m.namespaced)).toEqual(["kiro/glm-5"]);

    const poolConfig = cfg({
      providers: {
        mock: { adapter: "openai-chat", baseUrl: "http://x/v1" },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
    });
    expect(opencodeCatalogFromProxyRows(rows, poolConfig).map(m => m.namespaced)).toEqual([
      "gpt-5.6-sol",
      "kiro/glm-5",
    ]);
  });
});

describe("ccx opencode project-layer detection", () => {
  test("detects a global config that redefines our provider key", () => {
    const home = mkdtempSync(join(tmpdir(), "ccx-opencode-global-"));
    const globalDir = join(home, ".config", "opencode");
    mkdirSync(globalDir, { recursive: true });
    const globalPath = join(globalDir, "opencode.json");
    writeFileSync(globalPath, JSON.stringify({ provider: { [OPENCODE_PROVIDER_ID]: { npm: "x" } } }));
    expect(opencodeProviderOverridePath(join(home, "project"), { XDG_CONFIG_HOME: join(home, ".config") }, home))
      .toBe(globalPath);
  });

  test("detects a project config that redefines our provider key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccx-opencode-proj-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { [OPENCODE_PROVIDER_ID]: { npm: "x" } } }));
    expect(opencodeProviderOverridePath(dir)).toBe(join(dir, "opencode.json"));
  });

  test("detects opencode.jsonc and parent directories up to the git root", () => {
    const root = mkdtempSync(join(tmpdir(), "ccx-opencode-proj-root-"));
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "packages", "opencode.jsonc"), `{
      // project override
      "provider": { "${OPENCODE_PROVIDER_ID}": { "npm": "x" } }
    }`);
    expect(opencodeProviderOverridePath(join(root, "packages", "app"))).toBe(join(root, "packages", "opencode.jsonc"));
  });

  test("does not walk above the git root", () => {
    const root = mkdtempSync(join(tmpdir(), "ccx-opencode-proj-stop-"));
    const parent = join(root, "parent");
    const repo = join(parent, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(root, "opencode.json"), JSON.stringify({ provider: { [OPENCODE_PROVIDER_ID]: { npm: "x" } } }));
    expect(opencodeProviderOverridePath(join(repo, "src"))).toBeNull();
  });

  test("ignores a project config that defines other providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccx-opencode-proj-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { other: { npm: "x" } } }));
    expect(opencodeProviderOverridePath(dir)).toBeNull();
  });

  test("no project config is not a warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccx-opencode-proj-"));
    expect(opencodeProviderOverridePath(dir)).toBeNull();
  });
});

describe("ccx opencode env assembly", () => {
  test("OPENCODE_CONFIG_CONTENT carries only the runtime provider block", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [routedModel("kiro", "glm-5")]);
    const built = buildOpencodeEnv(block, "sk-ccx-123", { OPENCODE_CONFIG: "/user/mine.json", PATH: "/bin" });
    expect(isOpencodeRuntimeConfigError(built)).toBe(false);
    if (isOpencodeRuntimeConfigError(built)) return;
    expect(built.OPENCODE_CONFIG).toBe("/user/mine.json");
    expect(built.PATH).toBe("/bin");
    const parsed = JSON.parse(built[OPENCODE_CONFIG_CONTENT_ENV]!) as { provider?: Record<string, unknown> };
    expect(Object.keys(parsed.provider ?? {})).toEqual([OPENCODE_PROVIDER_ID]);
  });

  test("preserves inherited inline settings in OPENCODE_CONFIG_CONTENT", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [routedModel("kiro", "glm-5")]);
    const inherited = JSON.stringify({
      model: "custom/model",
      provider: { other: { npm: "@other/pkg" } },
    });
    const built = buildOpencodeEnv(block, "sk-ccx-123", { [OPENCODE_CONFIG_CONTENT_ENV]: inherited });
    expect(isOpencodeRuntimeConfigError(built)).toBe(false);
    if (isOpencodeRuntimeConfigError(built)) return;
    const parsed = JSON.parse(built[OPENCODE_CONFIG_CONTENT_ENV]!) as {
      model?: string;
      provider?: Record<string, unknown>;
    };
    expect(parsed.model).toBe("custom/model");
    expect(parsed.provider?.other).toEqual({ npm: "@other/pkg" });
    expect(parsed.provider?.[OPENCODE_PROVIDER_ID]).toEqual(block);
  });

  test("surfaces invalid inherited OPENCODE_CONFIG_CONTENT as an error", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, []);
    expect(buildOpencodeEnv(block, "sk-ccx-123", { [OPENCODE_CONFIG_CONTENT_ENV]: "[]" }))
      .toEqual({ error: "OPENCODE_CONFIG_CONTENT must be a JSON object." });
  });

  test("the admission key travels in the child env, matching the config's {env:…} reference", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, []);
    const built = buildOpencodeEnv(block, "sk-ccx-123", {});
    expect(isOpencodeRuntimeConfigError(built)).toBe(false);
    if (isOpencodeRuntimeConfigError(built)) return;
    expect(built[OPENCODE_API_KEY_ENV]).toBe("sk-ccx-123");
    expect(built[OPENCODE_CONFIG_CONTENT_ENV]).not.toContain("sk-ccx-123");
  });
});

describe("ccx opencode admission key", () => {
  test("the environment token wins over a configured API key", () => {
    const config = cfg({ apiKeys: [{ id: "1", name: "main", key: "sk-cfg", createdAt: "2026-01-01" }] });
    expect(opencodeApiKey(config, { CODEXCOMMANDER_API_AUTH_TOKEN: "sk-env" })).toBe("sk-env");
  });

  test("falls back to the hardened service token file before config.apiKeys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccx-opencode-token-"));
    const tokenFile = join(dir, "service-api-token");
    writeFileSync(tokenFile, "sk-service\n", "utf8");
    const config = cfg({ apiKeys: [{ id: "1", name: "main", key: "sk-cfg", createdAt: "2026-01-01" }] });
    expect(opencodeApiKey(config, { CCX_API_TOKEN_FILE: tokenFile })).toBe("sk-service");
  });

  test("falls back to the configured proxy API key", () => {
    const config = cfg({ apiKeys: [{ id: "1", name: "main", key: "sk-cfg", createdAt: "2026-01-01" }] });
    expect(opencodeApiKey(config, {})).toBe("sk-cfg");
  });

  test("falls back to a placeholder on an open loopback proxy", () => {
    expect(opencodeApiKey(cfg(), {})).toBe("ccx");
  });
});

describe("ccx opencode proxy auto-start env", () => {
  test("passes CCX_API_TOKEN_FILE to ccx start when only the hardened service token exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccx-opencode-start-"));
    const tokenFile = join(dir, "service-api-token");
    writeFileSync(tokenFile, "sk-service-only\n", "utf8");
    const config = cfg({ hostname: "0.0.0.0", apiKeys: [] as CodexCommanderConfig["apiKeys"] });

    const startEnv = opencodeProxyStartEnv({ CCX_API_TOKEN_FILE: tokenFile });
    expect(startEnv.CODEXCOMMANDER_API_AUTH_TOKEN).toBeUndefined();
    expect(startEnv.CCX_API_TOKEN_FILE).toBe(tokenFile);
    expect(startEnv[PROXY_DELEGATED_START_ENV]).toBe("1");
    expect(startEnv.CCX_SERVICE).toBeUndefined();
    expect(JSON.stringify(startEnv)).not.toContain("sk-service-only");
    expect(loadServiceTokenFromFile(startEnv)).toBe("sk-service-only");
    expect(opencodeApiKey(config, startEnv)).toBe("sk-service-only");
  });

  test("defaults CCX_API_TOKEN_FILE when admission env token is absent", () => {
    const startEnv = opencodeProxyStartEnv({ hostname: "0.0.0.0" });
    expect(startEnv.CODEXCOMMANDER_API_AUTH_TOKEN).toBeUndefined();
    expect(startEnv.CCX_API_TOKEN_FILE).toBe(serviceApiTokenFilePath());
    expect(startEnv[PROXY_DELEGATED_START_ENV]).toBe("1");
    expect(startEnv.CCX_SERVICE).toBeUndefined();
  });

  test("does not inject CCX_API_TOKEN_FILE when CODEXCOMMANDER_API_AUTH_TOKEN is already set", () => {
    const startEnv = opencodeProxyStartEnv({ CODEXCOMMANDER_API_AUTH_TOKEN: "sk-env", hostname: "0.0.0.0" });
    expect(startEnv.CODEXCOMMANDER_API_AUTH_TOKEN).toBe("sk-env");
    expect(startEnv.CCX_API_TOKEN_FILE).toBeUndefined();
  });
});

describe("ccx opencode global config path", () => {
  test("global path follows XDG_CONFIG_HOME when set", () => {
    expect(opencodeGlobalConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(join("/xdg", "opencode", "opencode.json"));
    expect(opencodeGlobalConfigPath({}, "/home/u")).toBe(join("/home/u", ".config", "opencode", "opencode.json"));
  });
});

describe("ccx opencode not-found hint", () => {
  test("cmd.exe reports command-not-found as 9009", () => {
    expect(opencodeNotFoundHint(9009, null, "win32")).toContain("npm install -g opencode-ai");
  });

  test("signal exits and other platforms are not hints", () => {
    expect(opencodeNotFoundHint(9009, "SIGTERM", "win32")).toBeNull();
    expect(opencodeNotFoundHint(9009, null, "linux")).toBeNull();
    expect(opencodeNotFoundHint(0, null, "win32")).toBeNull();
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";

import { describe, expect, test } from "bun:test";
import type { CodexCommanderConfig } from "../../src/types";
import type { ProviderAccountSet } from "../../src/oauth/types";
import {
  bindMediaCredential,
  createMediaCredentialLease,
} from "../../src/images/media-credentials";
import { MediaTransportError } from "../../src/images/media-errors";

function config(provider: CodexCommanderConfig["providers"][string]): CodexCommanderConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: { xai: provider },
    images: { bridgeEnabled: true, videoBridgeEnabled: true, authSource: "api_key" },
  } as CodexCommanderConfig;
}

function oauthAccounts(activeAccountId = "slot-a"): ProviderAccountSet {
  return {
    activeAccountId,
    accounts: [
      {
        id: "slot-a",
        credential: {
          access: "oauth-access-a",
          refresh: "oauth-refresh-a",
          expires: Date.now() + 60_000,
          accountId: "subject-a",
          source: "oauth",
        },
      },
      {
        id: "slot-b",
        credential: {
          access: "oauth-access-b",
          refresh: "oauth-refresh-b",
          expires: Date.now() + 60_000,
          accountId: "subject-b",
          source: "oauth",
        },
      },
    ],
  };
}

describe("media credential binding", () => {
  test("OAuth binds the original stable subject and ignores a later active-account change", async () => {
    const cfg = config({
      adapter: "openai-chat",
      baseUrl: "https://custom.invalid/v1",
      authMode: "oauth",
    });
    cfg.images!.authSource = "subscription_oauth";
    let accounts = oauthAccounts("slot-a");
    const binding = bindMediaCredential(cfg, {
      getOAuthAccountSet: () => accounts,
    });
    expect(binding.authSource).toBe("subscription_oauth");
    expect(binding.providerKind).toBe("canonical");
    expect(JSON.stringify(binding)).not.toContain("slot-a");
    expect(JSON.stringify(binding)).not.toContain("subject-a");

    accounts = oauthAccounts("slot-b");
    const requested: string[] = [];
    const lease = createMediaCredentialLease({
      loadConfig: () => cfg,
      getOAuthAccountSet: () => accounts,
      getOAuthSnapshotForAccount: async (_provider, accountId) => {
        requested.push(accountId);
        return {
          provider: "xai",
          accountId,
          generation: "generation-a",
          accessToken: "resolved-access-a",
        };
      },
    });
    const resolved = await lease.resolve(binding);
    expect(resolved.bearer).toBe("resolved-access-a");
    expect(requested).toEqual(["slot-a"]);
  });

  test("missing slot or changed OAuth subject becomes needs_auth", async () => {
    const cfg = config({ adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" });
    cfg.images!.authSource = "subscription_oauth";
    let accounts = oauthAccounts();
    const binding = bindMediaCredential(cfg, { getOAuthAccountSet: () => accounts });
    const lease = createMediaCredentialLease({
      loadConfig: () => cfg,
      getOAuthAccountSet: () => accounts,
      getOAuthSnapshotForAccount: async () => {
        throw new Error("must not resolve a mismatched slot");
      },
    });

    accounts = { activeAccountId: "slot-b", accounts: [oauthAccounts().accounts[1]!] };
    await expect(lease.resolve(binding)).rejects.toMatchObject({ code: "needs_auth", certainty: "definite" });

    accounts = oauthAccounts();
    accounts.accounts[0]!.credential.accountId = "replacement-subject";
    await expect(lease.resolve(binding)).rejects.toMatchObject({ code: "needs_auth", certainty: "definite" });
  });

  test("OAuth binding requires a stable stored subject", () => {
    const cfg = config({ adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" });
    cfg.images!.authSource = "subscription_oauth";
    const accounts = oauthAccounts();
    delete accounts.accounts[0]!.credential.accountId;
    expect(() => bindMediaCredential(cfg, { getOAuthAccountSet: () => accounts })).toThrow(MediaTransportError);
    try {
      bindMediaCredential(cfg, { getOAuthAccountSet: () => accounts });
    } catch (error) {
      expect(error).toMatchObject({ code: "needs_auth", phase: "pre_dispatch" });
      expect(String(error)).not.toContain("oauth-access-a");
      expect(String(error)).not.toContain("oauth-refresh-a");
    }
  });

  test("API-key binding pins the selected slot and resolved-key digest without consulting OAuth", async () => {
    const envName = "CCX_TEST_MEDIA_BOUND_KEY";
    const previous = process.env[envName];
    process.env[envName] = "initial-key-material";
    try {
      const cfg = config({
        adapter: "openai-chat",
        baseUrl: "https://attacker.invalid/v1",
        authMode: "oauth",
        apiKey: `\${${envName}}`,
        apiKeyPool: [{ id: "media-slot", key: `\${${envName}}` }],
      });
      let oauthCalls = 0;
      const binding = bindMediaCredential(cfg);
      expect(JSON.stringify(binding)).not.toContain(envName);
      expect(JSON.stringify(binding)).not.toContain("initial-key-material");
      expect(cfg.providers.xai!.authMode).toBe("oauth");

      const lease = createMediaCredentialLease({
        loadConfig: () => cfg,
        getOAuthAccountSet: () => { oauthCalls += 1; return oauthAccounts(); },
        getOAuthSnapshotForAccount: async () => {
          oauthCalls += 1;
          throw new Error("OAuth must not be consulted");
        },
      });
      expect((await lease.resolve(binding)).bearer).toBe("initial-key-material");
      expect(oauthCalls).toBe(0);

      process.env[envName] = "rotated-key-material";
      await expect(lease.resolve(binding)).rejects.toMatchObject({ code: "needs_auth" });
      expect(oauthCalls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  test("only one unambiguous legacy xAI API-key alias may bind", () => {
    const legacy: CodexCommanderConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "legacy-media",
      providers: {
        "legacy-media": {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/custom/path",
          apiKey: "legacy-key-material",
        },
      },
      images: { bridgeEnabled: true, authSource: "api_key" },
    } as CodexCommanderConfig;
    const binding = bindMediaCredential(legacy);
    expect(binding.providerKind).toBe("legacy_alias");
    expect(JSON.stringify(binding)).not.toContain("legacy-media");
    expect(JSON.stringify(binding)).not.toContain("legacy-key-material");

    legacy.providers.second = {
      adapter: "openai-chat",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      apiKey: "second-key-material",
    };
    expect(() => bindMediaCredential(legacy)).toThrow(MediaTransportError);
  });
});

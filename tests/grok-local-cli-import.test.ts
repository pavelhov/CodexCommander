import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginXai } from "../src/oauth/xai";
import {
  forceRefreshOAuthAccessSnapshot,
  getValidAccessTokenForAccount,
  getValidAccessTokenSnapshot,
  OAUTH_PROVIDERS,
  refreshXaiAccountWithLock,
  refreshXaiLocalCliAccountWithLock,
  XAI_LOCAL_CLI_REFRESH_REQUIRED,
} from "../src/oauth";
import {
  getAccountCredential,
  getAccountSet,
  getAuthStorePath,
  saveCredential,
} from "../src/oauth/store";

const originalHome = process.env.HOME;
const originalGrokHome = process.env.GROK_HOME;
const originalOcxHome = process.env.OPENCODEX_HOME;
const originalXaiRefresh = OAUTH_PROVIDERS.xai!.refresh;
const originalFetch = globalThis.fetch;
let testRoot: string;
let grokHome: string;

function writeGrokCliCredential(options: {
  user: string;
  generation: number;
  expiresAtMs: number;
}): { access: string; bytes: string } {
  const access = `grok-access-${options.generation}`;
  const bytes = `${JSON.stringify({
    "https://auth.x.ai::openid profile email offline_access": {
      key: access,
      refresh_token: `grok-cli-refresh-${options.generation}`,
      expires_at: new Date(options.expiresAtMs).toISOString(),
      user_id: options.user,
      email: `${options.user}@example.com`,
      auth_mode: "oidc",
      oidc_issuer: "https://auth.x.ai",
    },
  }, null, 2)}\n`;
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(join(grokHome, "auth.json"), bytes, { mode: 0o600 });
  return { access, bytes };
}

async function seedLinkedCredential(options: {
  user?: string;
  generation?: number;
  expiresAtMs?: number;
  refresh?: string;
} = {}): Promise<string> {
  const user = options.user ?? "grok-linked-user";
  const generation = options.generation ?? 1;
  await saveCredential("xai", {
    access: `grok-access-${generation}`,
    refresh: options.refresh ?? "",
    expires: options.expiresAtMs ?? Date.now() - 1,
    accountId: user,
    email: `${user}@example.com`,
    source: "local-cli",
  });
  return getAccountSet("xai")!.activeAccountId;
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "ocx-grok-local-cli-"));
  grokHome = join(testRoot, "grok");
  process.env.HOME = testRoot;
  process.env.GROK_HOME = grokHome;
  process.env.OPENCODEX_HOME = join(testRoot, "ocx");
});

afterEach(() => {
  OAUTH_PROVIDERS.xai!.refresh = originalXaiRefresh;
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
  if (originalOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOcxHome;
  rmSync(testRoot, { recursive: true, force: true });
});

describe("Grok CLI read-only login import", () => {
  test("provider login imports a fresh CLI access generation without its refresh grant", async () => {
    const written = writeGrokCliCredential({
      user: "grok-import-user",
      generation: 1,
      expiresAtMs: Date.now() + 10 * 60_000,
    });
    const progress: string[] = [];
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("browser login must not start for a fresh CLI token");
    }) as typeof fetch;

    const credential = await OAUTH_PROVIDERS.xai!.login({
      onProgress: message => progress.push(message),
    });

    expect(credential).toMatchObject({
      access: written.access,
      refresh: "",
      source: "local-cli",
      accountId: "grok-import-user",
    });
    expect(progress).toEqual(["Found a fresh Grok CLI token, linking read-only"]);
    expect(fetchCalls).toBe(0);
  });

  test("import-only mode rejects a stale CLI token without starting browser auth", async () => {
    writeGrokCliCredential({
      user: "grok-import-user",
      generation: 1,
      expiresAtMs: Date.now() - 60_000,
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("browser auth must not start in import-only mode");
    }) as typeof fetch;

    await expect(loginXai({}, { importLocal: "only" })).rejects.toThrow(
      "Run `grok` once to refresh its login",
    );
    expect(fetchCalls).toBe(0);
  });
});

describe("Grok CLI linked-token renewal", () => {
  test("scrubs a fresh legacy native refresh grant before fast return or backup", async () => {
    const expires = Date.now() + 10 * 60_000;
    const authPath = getAuthStorePath();
    mkdirSync(process.env.OPENCODEX_HOME!, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, `${JSON.stringify({
      xai: {
        access: "grok-legacy-fresh",
        refresh: "native-refresh-must-not-survive",
        expires,
        accountId: "grok-linked-user",
        email: "grok-linked-user@example.com",
        source: "local-cli",
      },
    })}\n`, { mode: 0o600 });
    const accountId = getAccountSet("xai")!.activeAccountId;

    await expect(getValidAccessTokenForAccount("xai", accountId)).resolves.toBe("grok-legacy-fresh");
    await saveCredential("cursor", {
      access: "cursor-access",
      refresh: "cursor-refresh",
      expires,
      accountId: "cursor-user",
    });

    expect(getAccountCredential("xai", accountId)?.refresh).toBe("");
    expect(readFileSync(authPath, "utf8")).not.toContain("native-refresh-must-not-survive");
    expect(readFileSync(`${authPath}.pre-multiauth`, "utf8")).not.toContain("native-refresh-must-not-survive");
  });

  test("scrubs a native Grok refresh grant from an existing migration backup", async () => {
    const expires = Date.now() + 10 * 60_000;
    const authPath = getAuthStorePath();
    await saveCredential("xai", {
      access: "grok-clean-current",
      refresh: "",
      expires,
      accountId: "grok-linked-user",
      email: "grok-linked-user@example.com",
      source: "local-cli",
    });
    const legacy = {
      xai: {
        access: "grok-old-backup",
        refresh: "native-refresh-in-old-backup",
        expires,
        accountId: "grok-linked-user",
        email: "grok-linked-user@example.com",
        source: "local-cli",
      },
    };
    writeFileSync(`${authPath}.pre-multiauth`, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const accountId = getAccountSet("xai")!.activeAccountId;

    await expect(getValidAccessTokenForAccount("xai", accountId)).resolves.toBe("grok-clean-current");

    expect(readFileSync(`${authPath}.pre-multiauth`, "utf8"))
      .not.toContain("native-refresh-in-old-backup");
  });

  test("adopts a newer same-account generation without IdP refresh or CLI-store writes", async () => {
    const accountId = await seedLinkedCredential();
    const written = writeGrokCliCredential({
      user: "grok-linked-user",
      generation: 2,
      expiresAtMs: Date.now() + 10 * 60_000,
    });
    let refreshCalls = 0;
    OAUTH_PROVIDERS.xai!.refresh = async () => {
      refreshCalls++;
      throw new Error("must not spend a Grok CLI refresh grant");
    };

    await expect(getValidAccessTokenForAccount("xai", accountId)).resolves.toBe(written.access);
    expect(refreshCalls).toBe(0);
    expect(getAccountCredential("xai", accountId)).toMatchObject({
      access: written.access,
      refresh: "",
      source: "local-cli",
      accountId: "grok-linked-user",
    });
    expect(readFileSync(join(grokHome, "auth.json"), "utf8")).toBe(written.bytes);
  });

  test("clears a legacy copied refresh grant even when no fresh CLI generation exists", async () => {
    const accountId = await seedLinkedCredential({ refresh: "legacy-copied-refresh" });
    writeGrokCliCredential({
      user: "grok-linked-user",
      generation: 1,
      expiresAtMs: Date.now() - 60_000,
    });
    let refreshCalls = 0;
    OAUTH_PROVIDERS.xai!.refresh = async () => {
      refreshCalls++;
      throw new Error("must not spend a Grok CLI refresh grant");
    };

    await expect(getValidAccessTokenForAccount("xai", accountId)).rejects.toThrow(
      XAI_LOCAL_CLI_REFRESH_REQUIRED,
    );
    expect(refreshCalls).toBe(0);
    expect(getAccountCredential("xai", accountId)?.refresh).toBe("");
    expect(getAccountCredential("xai", accountId)?.source).toBe("local-cli");
  });

  test("refuses a fresh generation from a different Grok account", async () => {
    const accountId = await seedLinkedCredential();
    writeGrokCliCredential({
      user: "grok-other-user",
      generation: 2,
      expiresAtMs: Date.now() + 10 * 60_000,
    });

    await expect(getValidAccessTokenForAccount("xai", accountId)).rejects.toThrow(
      "Grok CLI is signed in to a different account",
    );
    expect(getAccountCredential("xai", accountId)?.accountId).toBe("grok-linked-user");
  });

  test("401 replay adopts an externally rotated fresh CLI generation", async () => {
    const now = Date.now();
    const initialExpires = now + 10 * 60_000;
    const initial = writeGrokCliCredential({
      user: "grok-linked-user",
      generation: 1,
      expiresAtMs: initialExpires,
    });
    await saveCredential("xai", {
      access: initial.access,
      refresh: "legacy-copied-refresh",
      expires: initialExpires,
      accountId: "grok-linked-user",
      email: "grok-linked-user@example.com",
      source: "local-cli",
    });
    const rejected = await getValidAccessTokenSnapshot("xai");
    const rotated = writeGrokCliCredential({
      user: "grok-linked-user",
      generation: 2,
      expiresAtMs: initialExpires + 5 * 60_000,
    });

    const refreshed = await forceRefreshOAuthAccessSnapshot(rejected);
    expect(refreshed.accessToken).toBe(rotated.access);
    expect(getAccountCredential("xai", rejected.accountId)).toMatchObject({
      access: rotated.access,
      refresh: "",
      source: "local-cli",
    });
  });

  test("401 replay refuses an older-but-fresh same-account generation", async () => {
    const now = Date.now();
    await saveCredential("xai", {
      access: "grok-access-newer",
      refresh: "",
      expires: now + 20 * 60_000,
      accountId: "grok-linked-user",
      email: "grok-linked-user@example.com",
      source: "local-cli",
    });
    const rejected = await getValidAccessTokenSnapshot("xai");
    writeGrokCliCredential({
      user: "grok-linked-user",
      generation: 1,
      expiresAtMs: now + 10 * 60_000,
    });

    await expect(forceRefreshOAuthAccessSnapshot(rejected)).rejects.toThrow(
      XAI_LOCAL_CLI_REFRESH_REQUIRED,
    );
    expect(getAccountCredential("xai", rejected.accountId)?.access).toBe("grok-access-newer");
  });

  test("401 replay refuses an equal-expiry generation because recency is ambiguous", async () => {
    const expires = Date.now() + 10 * 60_000;
    await saveCredential("xai", {
      access: "grok-access-current",
      refresh: "",
      expires,
      accountId: "grok-linked-user",
      email: "grok-linked-user@example.com",
      source: "local-cli",
    });
    const rejected = await getValidAccessTokenSnapshot("xai");
    writeGrokCliCredential({
      user: "grok-linked-user",
      generation: 1,
      expiresAtMs: expires,
    });

    await expect(forceRefreshOAuthAccessSnapshot(rejected)).rejects.toThrow(
      XAI_LOCAL_CLI_REFRESH_REQUIRED,
    );
    expect(getAccountCredential("xai", rejected.accountId)?.access).toBe("grok-access-current");
  });

  test("scrubs a superseding local credential during legacy-grant cleanup", async () => {
    const accountId = await seedLinkedCredential({ refresh: "legacy-native-refresh" });
    const caller = getAccountCredential("xai", accountId)!;
    const winnerExpires = Date.now() + 15 * 60_000;

    await expect(refreshXaiLocalCliAccountWithLock("xai", accountId, caller, {
      beforeScrubPersist: async () => {
        await saveCredential("xai", {
          access: "grok-concurrent-winner",
          refresh: "concurrent-native-refresh",
          expires: winnerExpires,
          accountId: "grok-linked-user",
          email: "grok-linked-user@example.com",
          source: "local-cli",
        });
      },
    })).resolves.toBe("grok-concurrent-winner");
    expect(getAccountCredential("xai", accountId)).toMatchObject({
      access: "grok-concurrent-winner",
      refresh: "",
      source: "local-cli",
    });
  });

  test("scrubs a superseding local credential during access-generation adoption", async () => {
    const accountId = await seedLinkedCredential();
    const caller = getAccountCredential("xai", accountId)!;
    const diskExpires = Date.now() + 10 * 60_000;
    writeGrokCliCredential({
      user: "grok-linked-user",
      generation: 2,
      expiresAtMs: diskExpires,
    });

    await expect(refreshXaiLocalCliAccountWithLock("xai", accountId, caller, {
      beforeAdoptPersist: async () => {
        await saveCredential("xai", {
          access: "grok-concurrent-winner",
          refresh: "concurrent-native-refresh",
          expires: diskExpires + 5 * 60_000,
          accountId: "grok-linked-user",
          email: "grok-linked-user@example.com",
          source: "local-cli",
        });
      },
    })).resolves.toBe("grok-concurrent-winner");
    expect(getAccountCredential("xai", accountId)).toMatchObject({
      access: "grok-concurrent-winner",
      refresh: "",
      source: "local-cli",
    });
  });

  test("direct xAI refresh never invokes the IdP for a local-cli caller", async () => {
    const accountId = await seedLinkedCredential();
    const caller = getAccountCredential("xai", accountId)!;
    let refreshCalls = 0;
    const def = {
      ...OAUTH_PROVIDERS.xai!,
      refresh: async () => {
        refreshCalls++;
        throw new Error("must not invoke xAI refresh for a native CLI grant");
      },
    };

    await expect(refreshXaiAccountWithLock("xai", accountId, def, caller)).rejects.toThrow(
      XAI_LOCAL_CLI_REFRESH_REQUIRED,
    );
    expect(refreshCalls).toBe(0);
  });

  test("OpenCodex-owned refresh stops if ownership changes to local-cli while waiting", async () => {
    await saveCredential("xai", {
      access: "oauth-stale",
      refresh: "oauth-refresh",
      expires: 1,
      accountId: "grok-linked-user",
      source: "oauth",
    });
    const accountId = getAccountSet("xai")!.activeAccountId;
    const caller = getAccountCredential("xai", accountId)!;
    let refreshCalls = 0;
    const def = {
      ...OAUTH_PROVIDERS.xai!,
      refresh: async () => {
        refreshCalls++;
        throw new Error("must not invoke xAI refresh after ownership changes");
      },
    };
    const intentLock = {
      acquire: async () => {
        await saveCredential("xai", {
          access: "grok-local-winner",
          refresh: "native-refresh-must-be-scrubbed",
          expires: Date.now() + 10 * 60_000,
          accountId: "grok-linked-user",
          source: "local-cli",
        });
        return { ownerId: "test-owner", release() {} };
      },
    };

    await expect(refreshXaiAccountWithLock("xai", accountId, def, caller, { intentLock }))
      .resolves.toBe("grok-local-winner");
    expect(refreshCalls).toBe(0);
    expect(getAccountCredential("xai", accountId)?.refresh).toBe("");
  });

  test("OpenCodex-owned refresh scrubs local-cli ownership that wins during exchange", async () => {
    await saveCredential("xai", {
      access: "oauth-stale",
      refresh: "oauth-refresh",
      expires: 1,
      accountId: "grok-linked-user",
      source: "oauth",
    });
    const accountId = getAccountSet("xai")!.activeAccountId;
    const caller = getAccountCredential("xai", accountId)!;
    let exchangeStarted!: () => void;
    let releaseExchange!: () => void;
    const started = new Promise<void>(resolve => { exchangeStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseExchange = resolve; });
    let refreshCalls = 0;
    const pending = refreshXaiAccountWithLock("xai", accountId, {
      ...OAUTH_PROVIDERS.xai!,
      refresh: async () => {
        refreshCalls++;
        exchangeStarted();
        await gate;
        return {
          access: "oauth-loser",
          refresh: "oauth-loser-refresh",
          expires: Date.now() + 10 * 60_000,
        };
      },
    }, caller);
    await started;
    await saveCredential("xai", {
      access: "grok-local-winner",
      refresh: "native-refresh-raced-in",
      expires: Date.now() + 15 * 60_000,
      accountId: "grok-linked-user",
      source: "local-cli",
    });
    releaseExchange();

    await expect(pending).resolves.toBe("grok-local-winner");
    expect(refreshCalls).toBe(1);
    expect(getAccountCredential("xai", accountId)).toMatchObject({
      access: "grok-local-winner",
      refresh: "",
      source: "local-cli",
    });
  });

  test("OpenCodex-owned xAI credentials retain normal refresh behavior", async () => {
    await saveCredential("xai", {
      access: "oauth-old",
      refresh: "oauth-refresh",
      expires: Date.now() - 1,
      accountId: "grok-oauth-user",
      source: "oauth",
    });
    const accountId = getAccountSet("xai")!.activeAccountId;
    let refreshCalls = 0;
    OAUTH_PROVIDERS.xai!.refresh = async () => {
      refreshCalls++;
      return {
        access: "oauth-fresh",
        refresh: "oauth-refresh-2",
        expires: Date.now() + 10 * 60_000,
      };
    };

    await expect(getValidAccessTokenForAccount("xai", accountId)).resolves.toBe("oauth-fresh");
    expect(refreshCalls).toBe(1);
    expect(getAccountCredential("xai", accountId)).toMatchObject({
      access: "oauth-fresh",
      refresh: "oauth-refresh-2",
      source: "oauth",
    });
  });
});

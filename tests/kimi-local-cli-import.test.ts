import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginKimi } from "../src/oauth/kimi";
import {
  forceRefreshOAuthAccessSnapshot,
  getValidAccessTokenForAccount,
  getValidAccessTokenSnapshot,
  KIMI_LOCAL_CLI_REFRESH_REQUIRED,
  OAUTH_PROVIDERS,
} from "../src/oauth";
import {
  getAccountCredential,
  getAccountSet,
  saveCredential,
} from "../src/oauth/store";

const originalHome = process.env.HOME;
const originalKimiHome = process.env.KIMI_CODE_HOME;
const originalCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
const originalKimiRefresh = OAUTH_PROVIDERS.kimi!.refresh;
const originalFetch = globalThis.fetch;
let testRoot: string;
let kimiHome: string;

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

function writeKimiCliCredential(options: {
  user: string;
  generation: number;
  expiresAtMs: number;
}): { access: string; bytes: string } {
  const access = jwtWithClaims({ user_id: options.user, generation: options.generation });
  const bytes = `${JSON.stringify({
    access_token: access,
    refresh_token: `cli-refresh-${options.generation}`,
    expires_at: Math.floor(options.expiresAtMs / 1000),
    expires_in: 900,
    scope: "coding",
    token_type: "Bearer",
  }, null, 2)}\n`;
  const dir = join(kimiHome, "credentials");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kimi-code.json"), bytes, { mode: 0o600 });
  return { access, bytes };
}

async function seedLinkedCredential(options: {
  user?: string;
  generation?: number;
  expiresAtMs?: number;
} = {}): Promise<string> {
  const user = options.user ?? "kimi-linked-user";
  const generation = options.generation ?? 1;
  const expiresAtMs = options.expiresAtMs ?? Date.now() - 1;
  const access = jwtWithClaims({ user_id: user, generation });
  await saveCredential("kimi", {
    access,
    refresh: "",
    expires: expiresAtMs,
    accountId: user,
    source: "local-cli",
  });
  return getAccountSet("kimi")!.activeAccountId;
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "ccx-kimi-local-cli-"));
  kimiHome = join(testRoot, "kimi");
  process.env.HOME = testRoot;
  process.env.KIMI_CODE_HOME = kimiHome;
  process.env.CODEXCOMMANDER_HOME = join(testRoot, "ccx");
});

afterEach(() => {
  OAUTH_PROVIDERS.kimi!.refresh = originalKimiRefresh;
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = originalKimiHome;
  if (originalCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = originalCodexCommanderHome;
  rmSync(testRoot, { recursive: true, force: true });
});

describe("Kimi Code CLI read-only login import", () => {
  test("provider login imports a fresh CLI access generation without its refresh grant", async () => {
    const written = writeKimiCliCredential({
      user: "kimi-import-user",
      generation: 1,
      expiresAtMs: Date.now() + 10 * 60_000,
    });
    const progress: string[] = [];
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("device flow must not start for a fresh CLI token");
    }) as typeof fetch;

    const credential = await OAUTH_PROVIDERS.kimi!.login({
      onProgress: message => progress.push(message),
    });

    expect(credential.access).toBe(written.access);
    expect(credential.refresh).toBe("");
    expect(credential.source).toBe("local-cli");
    expect(credential.accountId).toBe("kimi-import-user");
    expect(progress).toEqual(["Found a fresh Kimi Code CLI token, linking read-only"]);
    expect(fetchCalls).toBe(0);
  });

  test("import-only mode rejects a stale CLI token without starting device auth", async () => {
    writeKimiCliCredential({
      user: "kimi-import-user",
      generation: 1,
      expiresAtMs: Date.now() - 60_000,
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("device flow must not start in import-only mode");
    }) as typeof fetch;

    await expect(loginKimi({}, { importLocal: "only" })).rejects.toThrow(
      "Run `kimi` once to refresh its login",
    );
    expect(fetchCalls).toBe(0);
  });

  test("ordinary login skips a fresh identity-less CLI token and starts independent device auth", async () => {
    const credentials = join(kimiHome, "credentials");
    mkdirSync(credentials, { recursive: true });
    writeFileSync(join(credentials, "kimi-code.json"), JSON.stringify({
      access_token: "opaque-access",
      refresh_token: "opaque-refresh",
      expires_at: Math.floor((Date.now() + 10 * 60_000) / 1000),
    }));
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("upstream unavailable", { status: 503 });
    }) as typeof fetch;

    await expect(OAUTH_PROVIDERS.kimi!.login({})).rejects.toThrow("Kimi device authorization failed: 503");
    expect(fetchCalls).toBe(1);
  });
});

describe("Kimi Code CLI linked-token renewal", () => {
  test("adopts a newer same-account CLI generation without refreshing or writing the CLI store", async () => {
    const accountId = await seedLinkedCredential();
    const written = writeKimiCliCredential({
      user: "kimi-linked-user",
      generation: 2,
      expiresAtMs: Date.now() + 10 * 60_000,
    });
    let refreshCalls = 0;
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      refreshCalls++;
      throw new Error("must not refresh a CLI-owned Kimi grant");
    };

    await expect(getValidAccessTokenForAccount("kimi", accountId)).resolves.toBe(written.access);

    expect(refreshCalls).toBe(0);
    expect(getAccountCredential("kimi", accountId)).toMatchObject({
      access: written.access,
      refresh: "",
      source: "local-cli",
      accountId: "kimi-linked-user",
    });
    expect(readFileSync(join(kimiHome, "credentials", "kimi-code.json"), "utf8")).toBe(written.bytes);
  });

  test("fails actionably when the CLI has no newer fresh generation", async () => {
    const accountId = await seedLinkedCredential();
    writeKimiCliCredential({
      user: "kimi-linked-user",
      generation: 1,
      expiresAtMs: Date.now() - 60_000,
    });
    let refreshCalls = 0;
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      refreshCalls++;
      throw new Error("must not refresh a CLI-owned Kimi grant");
    };

    await expect(getValidAccessTokenForAccount("kimi", accountId)).rejects.toThrow(
      KIMI_LOCAL_CLI_REFRESH_REQUIRED,
    );
    expect(refreshCalls).toBe(0);
    expect(getAccountSet("kimi")!.accounts[0]!.needsReauth).toBe(true);
  });

  test("refuses to adopt a fresh CLI generation from a different account", async () => {
    const accountId = await seedLinkedCredential();
    writeKimiCliCredential({
      user: "kimi-other-user",
      generation: 2,
      expiresAtMs: Date.now() + 10 * 60_000,
    });

    await expect(getValidAccessTokenForAccount("kimi", accountId)).rejects.toThrow(
      "Kimi CLI is signed in to a different account",
    );
    expect(getAccountCredential("kimi", accountId)?.accountId).toBe("kimi-linked-user");
  });

  test("fails closed when token generations have no verifiable account identity", async () => {
    await saveCredential("kimi", {
      access: "opaque-old-access",
      refresh: "",
      expires: Date.now() - 1,
      source: "local-cli",
    });
    const accountId = getAccountSet("kimi")!.activeAccountId;
    const credentials = join(kimiHome, "credentials");
    mkdirSync(credentials, { recursive: true });
    writeFileSync(join(credentials, "kimi-code.json"), JSON.stringify({
      access_token: "opaque-new-access",
      refresh_token: "cli-owned-refresh",
      expires_at: Math.floor((Date.now() + 10 * 60_000) / 1000),
    }));
    let refreshCalls = 0;
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      refreshCalls++;
      throw new Error("must not refresh a CLI-owned Kimi grant");
    };

    await expect(getValidAccessTokenForAccount("kimi", accountId)).rejects.toThrow(
      "no verifiable account identity",
    );
    expect(refreshCalls).toBe(0);
    expect(getAccountCredential("kimi", accountId)?.access).toBe("opaque-old-access");
  });

  test("401 replay adopts an externally rotated fresh CLI generation", async () => {
    const now = Date.now();
    const initialExpires = Math.floor((now + 10 * 60_000) / 1000) * 1000;
    const initial = writeKimiCliCredential({
      user: "kimi-linked-user",
      generation: 1,
      expiresAtMs: initialExpires,
    });
    await saveCredential("kimi", {
      access: initial.access,
      refresh: "",
      expires: initialExpires,
      accountId: "kimi-linked-user",
      source: "local-cli",
    });
    const rejected = await getValidAccessTokenSnapshot("kimi");
    const rotated = writeKimiCliCredential({
      user: "kimi-linked-user",
      generation: 2,
      expiresAtMs: now + 20 * 60_000,
    });
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      throw new Error("must not refresh a CLI-owned Kimi grant");
    };

    const replay = await forceRefreshOAuthAccessSnapshot(rejected);

    expect(replay.accessToken).toBe(rotated.access);
    expect(getAccountCredential("kimi", rejected.accountId)?.refresh).toBe("");
  });

  test("401 replay refuses an older-but-fresh same-account CLI generation", async () => {
    const now = Date.now();
    const storedAccess = jwtWithClaims({ user_id: "kimi-linked-user", generation: 2 });
    await saveCredential("kimi", {
      access: storedAccess,
      refresh: "",
      expires: now + 20 * 60_000,
      accountId: "kimi-linked-user",
      source: "local-cli",
    });
    const rejected = await getValidAccessTokenSnapshot("kimi");
    const before = getAccountCredential("kimi", rejected.accountId);
    const older = writeKimiCliCredential({
      user: "kimi-linked-user",
      generation: 1,
      expiresAtMs: now + 10 * 60_000,
    });
    let refreshCalls = 0;
    OAUTH_PROVIDERS.kimi!.refresh = async () => {
      refreshCalls++;
      throw new Error("must not refresh a CLI-owned Kimi grant");
    };

    await expect(forceRefreshOAuthAccessSnapshot(rejected)).rejects.toThrow(
      KIMI_LOCAL_CLI_REFRESH_REQUIRED,
    );

    expect(refreshCalls).toBe(0);
    expect(getAccountCredential("kimi", rejected.accountId)).toEqual(before);
    expect(readFileSync(join(kimiHome, "credentials", "kimi-code.json"), "utf8")).toBe(older.bytes);
  });

  test("401 replay keeps normal refresh behavior for CodexCommander-owned Kimi credentials", async () => {
    await saveCredential("kimi", {
      access: "ccx-old-access",
      refresh: "ccx-owned-refresh",
      expires: Date.now() + 10 * 60_000,
      accountId: "ccx-kimi-user",
      source: "oauth",
    });
    const rejected = await getValidAccessTokenSnapshot("kimi");
    let refreshCalls = 0;
    OAUTH_PROVIDERS.kimi!.refresh = async refresh => {
      refreshCalls++;
      expect(refresh).toBe("ccx-owned-refresh");
      return {
        access: "ccx-fresh-access",
        refresh: "ccx-rotated-refresh",
        expires: Date.now() + 10 * 60_000,
      };
    };

    const replay = await forceRefreshOAuthAccessSnapshot(rejected);

    expect(replay.accessToken).toBe("ccx-fresh-access");
    expect(refreshCalls).toBe(1);
    expect(getAccountCredential("kimi", rejected.accountId)?.refresh).toBe("ccx-rotated-refresh");
  });
});

import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setIcaclsRunnerForTests } from "../src/lib/windows-secret-acl";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-accounts-test");
const ACCOUNTS_PATH = join(TEST_DIR, "codex-accounts.json");

function refreshGrantFingerprint(refreshToken: string): string {
  return createHash("sha256").update(`codex-refresh-grant:${refreshToken}`).digest("hex");
}

function refreshLockPathForToken(refreshToken: string): string {
  const digest = createHash("sha256").update(refreshGrantFingerprint(refreshToken)).digest("hex").slice(0, 32);
  return join(TEST_DIR, `codex-refresh-${digest}.lock`);
}

describe("codex-account-store CRUD", () => {
  beforeEach(() => {
    // These exercises cover credential-store contention, not Windows ACL behavior.
    // Avoid spawning icacls for every fixture write; its lingering handle makes
    // the fixed fixture directory flaky under `bun test --isolate` on Windows.
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    setIcaclsRunnerForTests(null);
    delete process.env.CODEXCOMMANDER_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("save and load credential round-trip", async () => {
    const { saveCodexAccountCredential, getCodexAccountCredential } = await import("../src/codex/account-store");
    const cred = { accessToken: "tk_a", refreshToken: "rf_a", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc_a" };
    saveCodexAccountCredential("work", cred);
    expect(existsSync(ACCOUNTS_PATH)).toBe(true);
    const loaded = getCodexAccountCredential("work");
    expect(loaded).toEqual(cred);
  });

  test("an authorized fresh save replaces a malformed store with the current envelope", async () => {
    const { saveCodexAccountCredential } = await import("../src/codex/account-store");
    writeFileSync(ACCOUNTS_PATH, "{not valid json", "utf8");

    saveCodexAccountCredential("fresh", {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "new-account",
    });

    const raw = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf8")) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);
    expect(raw.accounts).toMatchObject({
      fresh: {
        credential: {
          accessToken: "new-access",
          refreshToken: "new-refresh",
          chatgptAccountId: "new-account",
        },
        generation: 1,
      },
    });
    expect(readdirSync(TEST_DIR).filter(name => name.startsWith("codex-accounts.json.invalid-"))).toHaveLength(0);
  });

  test("malformed JSON fails closed without backup, rewrite, or salvage", async () => {
    const { loadCodexAccountStore } = await import("../src/codex/account-store");
    const malformed = "{not valid json";
    writeFileSync(ACCOUNTS_PATH, malformed, "utf8");

    expect(loadCodexAccountStore()).toEqual({});
    expect(readFileSync(ACCOUNTS_PATH, "utf8")).toBe(malformed);
    expect(readdirSync(TEST_DIR).filter(name => name.startsWith("codex-accounts.json.invalid-"))).toHaveLength(0);
  });

  test("unversioned and non-current envelopes fail closed without migration", async () => {
    const { loadCodexAccountStore } = await import("../src/codex/account-store");
    const cred = {
      accessToken: "stale-access",
      refreshToken: "stale-refresh",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "stale-account",
    };
    const record = {
      credential: cred,
      generation: 1,
      refreshGrantFingerprint: refreshGrantFingerprint(cred.refreshToken),
    };

    for (const raw of [
      { stale: record },
      { accounts: { stale: record } },
      { schemaVersion: 0, accounts: { stale: record } },
      { schemaVersion: 2, accounts: { stale: record } },
    ]) {
      const encoded = JSON.stringify(raw);
      writeFileSync(ACCOUNTS_PATH, encoded, "utf8");
      expect(loadCodexAccountStore()).toEqual({});
      expect(readFileSync(ACCOUNTS_PATH, "utf8")).toBe(encoded);
    }
    expect(readdirSync(TEST_DIR).filter(name => name.startsWith("codex-accounts.json.invalid-"))).toHaveLength(0);
  });

  test("current envelope and account rows reject unknown keys without salvaging valid siblings", async () => {
    const { loadCodexAccountStore } = await import("../src/codex/account-store");
    const cred = {
      accessToken: "valid-access",
      refreshToken: "valid-refresh",
      expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "valid-account",
    };
    const valid = {
      credential: cred,
      generation: 1,
      refreshGrantFingerprint: refreshGrantFingerprint(cred.refreshToken),
    };
    const malformedEnvelopes = [
      { schemaVersion: 1, accounts: { valid }, unexpected: true },
      { schemaVersion: 1, accounts: { "invalid/account": valid } },
      { schemaVersion: 1, accounts: Object.fromEntries([["valid", valid], ["__proto__", valid]]) },
      { schemaVersion: 1, accounts: { valid, malformed: { ...valid, unexpected: true } } },
      {
        schemaVersion: 1,
        accounts: {
          valid,
          malformed: { ...valid, credential: { ...cred, unexpected: true } },
        },
      },
    ];

    for (const raw of malformedEnvelopes) {
      writeFileSync(ACCOUNTS_PATH, JSON.stringify(raw), "utf8");
      expect(loadCodexAccountStore()).toEqual({});
    }
  });

  test("active records without the current refresh-grant fingerprint are rejected", async () => {
    const { loadCodexAccountStore } = await import("../src/codex/account-store");
    writeFileSync(ACCOUNTS_PATH, JSON.stringify({
      schemaVersion: 1,
      accounts: {
        stale: {
          credential: {
            accessToken: "stale-access",
            refreshToken: "stale-refresh",
            expiresAt: Date.now() + 3600_000,
            chatgptAccountId: "stale-account",
          },
          generation: 1,
        },
      },
    }), "utf8");

    expect(loadCodexAccountStore()).toEqual({});
    expect(readdirSync(TEST_DIR).filter(name => name.startsWith("codex-accounts.json.invalid-"))).toHaveLength(0);
  });

  test("new saves write the exact current envelope and generation wrapper records", async () => {
    const { readCodexAccountRecord, saveCodexAccountCredential } = await import("../src/codex/account-store");
    const cred = { accessToken: "tk_a", refreshToken: "rf_a", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc_a" };
    saveCodexAccountCredential("wrapped", cred);

    const raw = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["schemaVersion", "accounts"]);
    expect(raw.schemaVersion).toBe(1);
    expect((raw.accounts as Record<string, unknown>).wrapped).toMatchObject({ credential: cred, generation: 1 });
    expect(readCodexAccountRecord("wrapped")).toMatchObject({ credential: cred, generation: 1 });
  });

  test("credential writers reject invalid account-map keys before changing bytes", async () => {
    const { saveCodexAccountCredential } = await import("../src/codex/account-store");
    const cred = { accessToken: "tk_a", refreshToken: "rf_a", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc_a" };
    saveCodexAccountCredential("valid", cred);
    const before = readFileSync(ACCOUNTS_PATH, "utf8");

    for (const id of ["", "invalid/account", "__proto__", "constructor"]) {
      expect(() => saveCodexAccountCredential(id, cred)).toThrow("Cannot persist an invalid Codex account store");
      expect(readFileSync(ACCOUNTS_PATH, "utf8")).toBe(before);
    }
  });

  test("remove credential deletes entry", async () => {
    const { saveCodexAccountCredential, removeCodexAccountCredential, getCodexAccountCredential, listCodexAccountIds, readCodexAccountRecord } = await import("../src/codex/account-store");
    saveCodexAccountCredential("temp", { accessToken: "t", refreshToken: "r", expiresAt: 0, chatgptAccountId: "c" });
    removeCodexAccountCredential("temp");
    expect(getCodexAccountCredential("temp")).toBeNull();
    expect(listCodexAccountIds()).not.toContain("temp");
    expect(readCodexAccountRecord("temp")).toMatchObject({ generation: 2 });
    expect(readCodexAccountRecord("temp")?.deletedAt).toBeNumber();
  });

  test("tokenful tombstones are rejected by the current record schema", async () => {
    const { getCodexAccountCredential, listCodexAccountIds, loadCodexAccountStore } = await import("../src/codex/account-store");
    const cred = { accessToken: "deleted_tk", refreshToken: "deleted_rf", expiresAt: Date.now() + 3600_000, chatgptAccountId: "deleted_acc" };
    writeFileSync(ACCOUNTS_PATH, JSON.stringify({
      schemaVersion: 1,
      accounts: {
        deleted: { credential: cred, generation: 2, deletedAt: Date.now() },
      },
    }, null, 2));

    expect(getCodexAccountCredential("deleted")).toBeNull();
    expect(loadCodexAccountStore()).toEqual({});
    expect(listCodexAccountIds()).not.toContain("deleted");
    expect(readdirSync(TEST_DIR).some(name => name.startsWith("codex-accounts.json.invalid-"))).toBe(false);
  });

  test("listCodexAccountIds returns stored ids", async () => {
    const { saveCodexAccountCredential, listCodexAccountIds } = await import("../src/codex/account-store");
    saveCodexAccountCredential("a", { accessToken: "1", refreshToken: "1", expiresAt: 0, chatgptAccountId: "1" });
    saveCodexAccountCredential("b", { accessToken: "2", refreshToken: "2", expiresAt: 0, chatgptAccountId: "2" });
    expect(listCodexAccountIds()).toContain("a");
    expect(listCodexAccountIds()).toContain("b");
  });

  test("getValidCodexToken returns cached token when not expired", async () => {
    const { saveCodexAccountCredential, getValidCodexToken } = await import("../src/codex/account-store");
    const future = Date.now() + 3600_000;
    saveCodexAccountCredential("fresh", { accessToken: "valid_tk", refreshToken: "rf", expiresAt: future, chatgptAccountId: "acc_id" });
    const result = await getValidCodexToken("fresh");
    expect(result.accessToken).toBe("valid_tk");
    expect(result.chatgptAccountId).toBe("acc_id");
    expect(result.generation).toBe(1);
  });

  test("getValidCodexToken throws when account not found", async () => {
    const { getValidCodexToken } = await import("../src/codex/account-store");
    try {
      await getValidCodexToken("nonexistent-local-alias");
      throw new Error("expected getValidCodexToken to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("credential is unavailable");
      expect((err as Error).message).not.toContain("nonexistent-local-alias");
    }
  });

  test("refresh failure errors do not expose aliases or upstream descriptions", async () => {
    const {
      getValidCodexToken,
      saveCodexAccountCredential,
      TokenRefreshError,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("sensitive-local-alias", {
      accessToken: "sensitive-access-token",
      refreshToken: "sensitive-refresh-token",
      expiresAt: 0,
      chatgptAccountId: "sensitive-account-id",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "sensitive-refresh-token was revoked for sensitive-account-id",
    }), { status: 400 })) as typeof fetch;

    try {
      await getValidCodexToken("sensitive-local-alias");
      throw new Error("expected getValidCodexToken to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenRefreshError);
      const message = (err as Error).message;
      expect(message).toContain("Codex token refresh failed");
      expect(message).not.toContain("sensitive-local-alias");
      expect(message).not.toContain("sensitive-access-token");
      expect(message).not.toContain("sensitive-refresh-token");
      expect(message).not.toContain("sensitive-account-id");
      expect(message).not.toContain("invalid_grant");
      expect(message).not.toContain("revoked for");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("generation CAS accepts only the current live generation", async () => {
    const {
      getCodexAccountCredential,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex/account-store");
    const first = { accessToken: "first", refreshToken: "first-r", expiresAt: 1, chatgptAccountId: "acc" };
    const second = { accessToken: "second", refreshToken: "second-r", expiresAt: 2, chatgptAccountId: "acc" };
    saveCodexAccountCredential("cas", first);
    const generation = readCodexAccountRecord("cas")!.generation;

    expect(saveCodexAccountCredentialIfGeneration("cas", generation, second)).toBe(true);
    expect(getCodexAccountCredential("cas")).toEqual(second);
    expect(readCodexAccountRecord("cas")!.generation).toBe(generation + 1);
    expect(saveCodexAccountCredentialIfGeneration("cas", generation, first)).toBe(false);
    expect(getCodexAccountCredential("cas")).toEqual(second);
  });

  test("validation metadata survives credential replacement and CAS refresh saves", async () => {
    const {
      markCodexAccountValidated,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex/account-store");
    const first = { accessToken: "first", refreshToken: "first-r", expiresAt: 1, chatgptAccountId: "acc" };
    const second = { accessToken: "second", refreshToken: "second-r", expiresAt: 2, chatgptAccountId: "acc" };
    const third = { accessToken: "third", refreshToken: "third-r", expiresAt: 3, chatgptAccountId: "acc" };

    saveCodexAccountCredential("validated", first);
    markCodexAccountValidated("validated", 1234);
    saveCodexAccountCredential("validated", second);
    expect(readCodexAccountRecord("validated")).toMatchObject({
      credential: second,
      lastCodexValidatedAt: 1234,
      lastCodexValidationStatus: "ok",
    });

    const generation = readCodexAccountRecord("validated")!.generation;
    expect(saveCodexAccountCredentialIfGeneration("validated", generation, third)).toBe(true);
    expect(readCodexAccountRecord("validated")).toMatchObject({
      credential: third,
      lastCodexValidatedAt: 1234,
      lastCodexValidationStatus: "ok",
    });
  });

  test("validation failure records a redacted reason without changing the last successful validation", async () => {
    const {
      markCodexAccountValidated,
      markCodexAccountValidationFailed,
      readCodexAccountRecord,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("failed-warmup", { accessToken: "sensitive-access", refreshToken: "sensitive-refresh", expiresAt: 1, chatgptAccountId: "sensitive-account" });
    markCodexAccountValidated("failed-warmup", 1234);
    markCodexAccountValidationFailed("failed-warmup", "http_status:401");

    const record = readCodexAccountRecord("failed-warmup")!;
    expect(record.lastCodexValidatedAt).toBe(1234);
    expect(record.lastCodexValidationStatus).toBe("failed");
    expect(record.lastCodexValidationError).toBe("http_status:401");
    expect(JSON.stringify(record)).not.toContain("sensitive-access revoked");
  });

  test("successful refresh returns bumped generation and persists rotated refresh token", async () => {
    const {
      getCodexAccountCredential,
      getValidCodexToken,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      refreshGrantFingerprintForToken,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("refresh-success", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const startGeneration = readCodexAccountRecord("refresh-success")!.generation;
    const startFingerprint = readCodexAccountRecord("refresh-success")!.refreshGrantFingerprint;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: "new",
      refresh_token: "new-r",
      expires_in: 3600,
    }), { status: 200 })) as typeof fetch;

    try {
      const result = await getValidCodexToken("refresh-success");
      expect(result).toEqual({ accessToken: "new", chatgptAccountId: "acc", generation: startGeneration + 1 });
      expect(getCodexAccountCredential("refresh-success")).toMatchObject({ accessToken: "new", refreshToken: "new-r" });
      expect(readCodexAccountRecord("refresh-success")!.refreshGrantFingerprint).not.toBe(startFingerprint);
      expect(readCodexAccountRecord("refresh-success")!.refreshGrantFingerprint).toBe(refreshGrantFingerprintForToken("new-r"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refresh waits behind file lock and reuses credential refreshed by another process", async () => {
    const {
      getValidCodexToken,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("refresh-wait", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const generation = readCodexAccountRecord("refresh-wait")!.generation;
    const lockPath = refreshLockPathForToken("old-r");
    writeFileSync(lockPath, JSON.stringify({ acquiredAt: Date.now(), pid: 12345 }) + "\n");
    const refreshed = { accessToken: "other-process", refreshToken: "other-r", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc" };
    const release = setTimeout(() => {
      saveCodexAccountCredentialIfGeneration("refresh-wait", generation, refreshed);
      unlinkSync(lockPath);
    }, 20);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("fetch should not be called after another process refreshed");
    }) as typeof fetch;

    try {
      const result = await getValidCodexToken("refresh-wait");
      expect(result.accessToken).toBe("other-process");
      expect(result.chatgptAccountId).toBe("acc");
      expect(result.generation).toBe(2);
    } finally {
      clearTimeout(release);
      globalThis.fetch = originalFetch;
    }
  });

  test("stale refresh lock is reclaimed", async () => {
    const { getValidCodexToken, saveCodexAccountCredential } = await import("../src/codex/account-store");
    saveCodexAccountCredential("refresh-stale-lock", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    writeFileSync(refreshLockPathForToken("old-r"), JSON.stringify({ acquiredAt: Date.now() - 61_000, pid: 12345 }) + "\n");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 })) as typeof fetch;

    try {
      const result = await getValidCodexToken("refresh-stale-lock");
      expect(result.accessToken).toBe("new");
      expect(result.generation).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("same refresh grant joins a live flight", async () => {
    const {
      getCodexAccountCredential,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("alias-a", { accessToken: "old-a", refreshToken: "shared-r", expiresAt: 0, chatgptAccountId: "acc" });
    saveCodexAccountCredential("alias-b", { accessToken: "old-b", refreshToken: "shared-r", expiresAt: 0, chatgptAccountId: "acc" });
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return new Response(JSON.stringify({
        access_token: "shared-new",
        refresh_token: "shared-rotated",
        expires_in: 3600,
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const [first, second] = await Promise.all([
        getValidCodexToken("alias-a"),
        getValidCodexToken("alias-b"),
      ]);
      expect(fetchCalls).toBe(1);
      expect(first.accessToken).toBe("shared-new");
      expect(second.accessToken).toBe("shared-new");
      expect(getCodexAccountCredential("alias-a")).toMatchObject({ accessToken: "shared-new", refreshToken: "shared-rotated" });
      expect(getCodexAccountCredential("alias-b")).toMatchObject({ accessToken: "shared-new", refreshToken: "shared-rotated" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("33rd distinct refresh grant is rejected before file lock and fetch", async () => {
    const {
      CodexCredentialRefreshBusyError,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    for (let index = 0; index < 33; index++) {
      saveCodexAccountCredential(`flight-${index}`, {
        accessToken: `old-${index}`,
        refreshToken: `refresh-${index}`,
        expiresAt: 0,
        chatgptAccountId: `account-${index}`,
      });
    }
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      await gate;
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    try {
      const admitted = Array.from({ length: 32 }, (_, index) => getValidCodexToken(`flight-${index}`));
      await Promise.resolve();
      await expect(getValidCodexToken("flight-32")).rejects.toBeInstanceOf(CodexCredentialRefreshBusyError);
      expect(fetchCalls).toBe(32);
      release();
      await Promise.all(admitted);
    } finally {
      release();
      globalThis.fetch = originalFetch;
    }
  });

  test("stale refresh flight is aborted and replaced without deleting the replacement", async () => {
    const {
      CodexCredentialRefreshStaleError,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("stale-flight", {
      accessToken: "old",
      refreshToken: "stale-refresh",
      expiresAt: 0,
      chatgptAccountId: "account",
    });
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (_input, init) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({ access_token: "replacement", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const first = getValidCodexToken("stale-flight");
    try {
      while (fetchCalls === 0) await Promise.resolve();
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now + 120_001);
      try {
        const replacement = getValidCodexToken("stale-flight");
        await expect(first).rejects.toBeInstanceOf(CodexCredentialRefreshStaleError);
        expect((await replacement).accessToken).toBe("replacement");
      } finally {
        clock.mockRestore();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stale generation cannot overwrite replacement", async () => {
    const {
      getCodexAccountCredential,
      readCodexAccountRecord,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex/account-store");
    const original = { accessToken: "original", refreshToken: "original-r", expiresAt: 1, chatgptAccountId: "acc" };
    const replacement = { accessToken: "replacement", refreshToken: "replacement-r", expiresAt: 2, chatgptAccountId: "acc" };
    const stale = { accessToken: "stale", refreshToken: "stale-r", expiresAt: 3, chatgptAccountId: "acc" };
    saveCodexAccountCredential("replace-race", original);
    const generation = readCodexAccountRecord("replace-race")!.generation;
    saveCodexAccountCredential("replace-race", replacement);

    expect(saveCodexAccountCredentialIfGeneration("replace-race", generation, stale)).toBe(false);
    expect(getCodexAccountCredential("replace-race")).toEqual(replacement);
  });

  test("stale generation cannot recreate after tombstone", async () => {
    const {
      getCodexAccountCredential,
      readCodexAccountRecord,
      removeCodexAccountCredential,
      saveCodexAccountCredential,
      saveCodexAccountCredentialIfGeneration,
    } = await import("../src/codex/account-store");
    const original = { accessToken: "original", refreshToken: "original-r", expiresAt: 1, chatgptAccountId: "acc" };
    const stale = { accessToken: "stale", refreshToken: "stale-r", expiresAt: 2, chatgptAccountId: "acc" };
    saveCodexAccountCredential("delete-race", original);
    const generation = readCodexAccountRecord("delete-race")!.generation;
    removeCodexAccountCredential("delete-race");

    expect(saveCodexAccountCredentialIfGeneration("delete-race", generation, stale)).toBe(false);
    expect(getCodexAccountCredential("delete-race")).toBeNull();
    expect(readCodexAccountRecord("delete-race")?.deletedAt).toBeNumber();
  });

  test("refresh finishing after delete does not recreate credential", async () => {
    const {
      CodexCredentialGenerationConflictError,
      getCodexAccountCredential,
      getValidCodexToken,
      readCodexAccountRecord,
      removeCodexAccountCredential,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    saveCodexAccountCredential("refresh-delete", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      removeCodexAccountCredential("refresh-delete");
      return new Response(JSON.stringify({ access_token: "stale", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    try {
      await expect(getValidCodexToken("refresh-delete")).rejects.toBeInstanceOf(CodexCredentialGenerationConflictError);
      expect(getCodexAccountCredential("refresh-delete")).toBeNull();
      expect(readCodexAccountRecord("refresh-delete")?.deletedAt).toBeNumber();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refresh finishing after replacement does not overwrite replacement", async () => {
    const {
      CodexCredentialGenerationConflictError,
      getCodexAccountCredential,
      getValidCodexToken,
      saveCodexAccountCredential,
    } = await import("../src/codex/account-store");
    const replacement = { accessToken: "replacement", refreshToken: "replacement-r", expiresAt: Date.now() + 3600_000, chatgptAccountId: "acc" };
    saveCodexAccountCredential("refresh-replace", { accessToken: "old", refreshToken: "old-r", expiresAt: 0, chatgptAccountId: "acc" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      saveCodexAccountCredential("refresh-replace", replacement);
      return new Response(JSON.stringify({ access_token: "stale", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    try {
      await expect(getValidCodexToken("refresh-replace")).rejects.toBeInstanceOf(CodexCredentialGenerationConflictError);
      expect(getCodexAccountCredential("refresh-replace")).toEqual(replacement);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

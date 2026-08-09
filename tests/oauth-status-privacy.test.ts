import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLoginStatus, getValidAccessToken, UnsupportedOAuthProviderError } from "../src/oauth";
import { saveCredential } from "../src/oauth/store";

const TEST_DIR = join(import.meta.dir, ".tmp-oauth-status-privacy-test");
let previousCodexCommanderHome: string | undefined;

describe("OAuth status privacy", () => {
  beforeEach(() => {
    previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.CODEXCOMMANDER_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("getLoginStatus returns a masked provider email", async () => {
    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "person@example.test",
      accountId: "acct-xai",
      source: "local-cli",
    });

    const status = getLoginStatus("xai");

    expect(status.loggedIn).toBe(true);
    expect(status.email).toBe("p***n@example.test");
    expect(status.source).toBe("local-cli");
    expect(JSON.stringify(status)).not.toContain("person@example.test");
    expect(JSON.stringify(status)).not.toContain("access-token");
    expect(JSON.stringify(status)).not.toContain("refresh-token");
  });

  test("saveCredential persists only the credential allowlist", async () => {
    const existingId = "existing-account";
    writeFileSync(join(TEST_DIR, "auth.json"), JSON.stringify({
      schemaVersion: 1,
      providers: {
        existing: {
          activeAccountId: existingId,
          accounts: [{
            id: existingId,
            credential: {
              access: "existing-access",
              refresh: "existing-refresh",
              expires: Date.now() + 60_000,
              source: "manual",
            },
          }],
        },
      },
    }), "utf8");

    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "person@example.test",
      accountId: "acct-xai",
      source: "credential-file",
      prompt: "secret prompt",
      headers: { authorization: "Bearer leaked" },
      idToken: "jwt-secret",
    } as never);

    const stored = readFileSync(join(TEST_DIR, "auth.json"), "utf8");

    expect(stored).toContain("access-token");
    expect(stored).toContain("refresh-token");
    expect(stored).toContain("existing-access");
    expect(stored).toContain("\"source\": \"credential-file\"");
    expect(stored).not.toContain("secret prompt");
    expect(stored).not.toContain("Bearer leaked");
    expect(stored).not.toContain("jwt-secret");
  });

  test("getLoginStatus rejects a store with invalid source metadata", async () => {
    const accountId = "xai-account";
    writeFileSync(join(TEST_DIR, "auth.json"), JSON.stringify({
      schemaVersion: 1,
      providers: {
        xai: {
          activeAccountId: accountId,
          accounts: [{
            id: accountId,
            credential: {
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
              source: "oauth<script>",
            },
          }],
        },
      },
    }), "utf8");

    const status = getLoginStatus("xai");

    expect(status.loggedIn).toBe(false);
    expect(status.source).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("oauth<script>");
  });

  test("stale credentials for removed OAuth providers fail as unsupported provider config", async () => {
    await saveCredential("removed-provider", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });

    await expect(getValidAccessToken("removed-provider")).rejects.toBeInstanceOf(UnsupportedOAuthProviderError);
  });

  test("malformed oauth token store is backed up before a new credential save overwrites it", async () => {
    const authPath = join(TEST_DIR, "auth.json");
    writeFileSync(authPath, "{not valid json", "utf8");

    await saveCredential("xai", {
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 60_000,
    });

    const backups = readdirSync(TEST_DIR).filter(name => name.startsWith("auth.json.invalid-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(TEST_DIR, backups[0]), "utf8")).toBe("{not valid json");
  });
});

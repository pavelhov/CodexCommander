import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectKimiCliToken,
  parseClaudeOauthPayload,
  parseKimiCliCredential,
  readClaudeCredentialsFile,
} from "../src/oauth/local-token-detect";

let tmp: string;
let prevConfigDir: string | undefined;
let prevKimiHome: string | undefined;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ocx-claude-detect-"));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  prevKimiHome = process.env.KIMI_CODE_HOME;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  if (prevKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = prevKimiHome;
});

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("Kimi Code read-only credential detection", () => {
  test("reads Unix-second expiry and discards the rotating refresh grant", () => {
    const home = join(tmp, "kimi-a");
    const credentials = join(home, "credentials");
    mkdirSync(credentials, { recursive: true });
    const access = jwtWithClaims({ user_id: "kimi-local-user" });
    writeFileSync(join(credentials, "kimi-code.json"), JSON.stringify({
      access_token: access,
      refresh_token: "cli-owned-refresh",
      expires_at: 2_000_000_000,
    }));
    process.env.KIMI_CODE_HOME = home;

    expect(detectKimiCliToken()).toEqual({
      access,
      refresh: "",
      expires: 2_000_000_000_000,
      accountId: "kimi-local-user",
      source: "local-cli",
    });
  });

  test("rejects malformed, tombstoned, and missing-expiry records", () => {
    expect(parseKimiCliCredential("not json")).toBeNull();
    expect(parseKimiCliCredential(JSON.stringify({
      access_token: "",
      refresh_token: "unused",
      expires_at: 2_000_000_000,
    }))).toBeNull();
    expect(parseKimiCliCredential(JSON.stringify({
      access_token: "access-only",
      refresh_token: "unused",
    }))).toBeNull();
  });

  test("refuses oversized credential files", () => {
    const home = join(tmp, "kimi-oversized");
    const credentials = join(home, "credentials");
    mkdirSync(credentials, { recursive: true });
    writeFileSync(join(credentials, "kimi-code.json"), " ".repeat(65 * 1024));
    process.env.KIMI_CODE_HOME = home;

    expect(detectKimiCliToken()).toBeNull();
  });

  test("refuses a symlinked credential file", () => {
    if (process.platform === "win32") return;
    const home = join(tmp, "kimi-symlink");
    const credentials = join(home, "credentials");
    const target = join(home, "actual.json");
    mkdirSync(credentials, { recursive: true });
    writeFileSync(target, JSON.stringify({
      access_token: "local-access",
      refresh_token: "local-refresh",
      expires_at: 2_000_000_000,
    }));
    symlinkSync(target, join(credentials, "kimi-code.json"));
    process.env.KIMI_CODE_HOME = home;

    expect(detectKimiCliToken()).toBeNull();
  });
});

describe("Claude Code credentials file fallback (Linux/Windows)", () => {
  test("reads .credentials.json from CLAUDE_CONFIG_DIR", () => {
    const dir = join(tmp, "claude-a");
    mkdirSync(dir, { recursive: true });
    const payload = { claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1234 } };
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify(payload));
    process.env.CLAUDE_CONFIG_DIR = dir;

    const raw = readClaudeCredentialsFile();
    expect(raw).not.toBeNull();
    const creds = parseClaudeOauthPayload(raw!);
    expect(creds).toEqual({ access: "at-1", refresh: "rt-1", expires: 1234, source: "local-cli" });
  });

  test("returns null when the credentials file is missing", () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude-missing");
    expect(readClaudeCredentialsFile()).toBeNull();
  });

  test("parse rejects payloads without both tokens", () => {
    expect(parseClaudeOauthPayload(JSON.stringify({ claudeAiOauth: { accessToken: "only" } }))).toBeNull();
    expect(parseClaudeOauthPayload("not json")).toBeNull();
  });
});

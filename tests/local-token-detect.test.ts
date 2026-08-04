import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectGrokCliToken,
  detectKimiCliToken,
  parseClaudeOauthPayload,
  parseGrokCliCredential,
  parseKimiCliCredential,
  readClaudeCredentialsFile,
} from "../src/oauth/local-token-detect";

let tmp: string;
let prevConfigDir: string | undefined;
let prevGrokHome: string | undefined;
let prevKimiHome: string | undefined;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ocx-claude-detect-"));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  prevGrokHome = process.env.GROK_HOME;
  prevKimiHome = process.env.KIMI_CODE_HOME;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  if (prevGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = prevGrokHome;
  if (prevKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = prevKimiHome;
});

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("Grok CLI read-only credential detection", () => {
  test("respects GROK_HOME and discards the rotating refresh grant", () => {
    const home = join(tmp, "grok-a");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      "https://auth.x.ai::openid profile": {
        key: "grok-access",
        refresh_token: "grok-cli-owned-refresh",
        expires_at: "2033-05-18T03:33:20.000Z",
        user_id: "grok-user",
        email: "GROK@EXAMPLE.COM",
      },
    }));
    process.env.GROK_HOME = home;

    expect(detectGrokCliToken()).toEqual({
      access: "grok-access",
      refresh: "",
      expires: 2_000_000_000_000,
      accountId: "grok-user",
      email: "grok@example.com",
      source: "local-cli",
    });
  });

  test("rejects malformed, missing-expiry, and identity-less records", () => {
    expect(parseGrokCliCredential("not json")).toBeNull();
    expect(parseGrokCliCredential(JSON.stringify({
      "https://auth.x.ai::scope": { key: "grok-access", user_id: "user" },
    }))).toBeNull();
    expect(parseGrokCliCredential(JSON.stringify({
      "https://auth.x.ai::scope": {
        key: "grok-access",
        expires_at: "2033-05-18T03:33:20.000Z",
      },
    }))).toBeNull();
  });

  test("uses principal_id when user_id is absent", () => {
    expect(parseGrokCliCredential(JSON.stringify({
      "https://auth.x.ai::scope": {
        key: "grok-access",
        expires_at: "2033-05-18T03:33:20.000Z",
        principal_id: "principal-1",
      },
    }))).toMatchObject({ accountId: "principal-1", refresh: "", source: "local-cli" });
  });

  test("refuses oversized and symlinked credential files", () => {
    const oversized = join(tmp, "grok-oversized");
    mkdirSync(oversized, { recursive: true });
    writeFileSync(join(oversized, "auth.json"), " ".repeat(65 * 1024));
    process.env.GROK_HOME = oversized;
    expect(detectGrokCliToken()).toBeNull();

    if (process.platform === "win32") return;
    const linked = join(tmp, "grok-symlink");
    const target = join(tmp, "grok-actual.json");
    mkdirSync(linked, { recursive: true });
    writeFileSync(target, JSON.stringify({
      "https://auth.x.ai::scope": {
        key: "grok-access",
        expires_at: "2033-05-18T03:33:20.000Z",
        user_id: "user",
      },
    }));
    symlinkSync(target, join(linked, "auth.json"));
    process.env.GROK_HOME = linked;
    expect(detectGrokCliToken()).toBeNull();
  });
});

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

/**
 * Local token auto-detection for supported local clients. Read-only: never writes to
 * external credential stores.
 */
import { execSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { identityFromKimiTokens } from "./kimi";
import type { OAuthCredentials } from "./types";

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const MAX_KIMI_CREDENTIAL_BYTES = 64 * 1024;

function readBoundedRegularFile(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    const pathMetadata = lstatSync(path);
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) return null;
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedMetadata = fstatSync(fd);
    if (!openedMetadata.isFile() || openedMetadata.size <= 0 || openedMetadata.size > maxBytes) {
      return null;
    }
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null);
      if (count === 0) break;
      total += count;
    }
    return total > 0 && total <= maxBytes
      ? bytes.toString("utf8", 0, total)
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort after read failure */ }
    }
  }
}

/** Kimi Code home: `KIMI_CODE_HOME` override, else `~/.kimi-code`. */
function kimiCodeHome(): string {
  const explicit = process.env.KIMI_CODE_HOME;
  return explicit && explicit.length > 0
    ? explicit
    : join(process.env.HOME ?? homedir(), ".kimi-code");
}

/**
 * Parse Kimi Code's persisted token without taking ownership of its rotating refresh grant.
 *
 * The refresh token is consulted only for signed account identity, then discarded. CodexCommander
 * links to fresh CLI access-token generations read-only; it must never refresh or write Kimi's
 * credential store independently of the CLI's own cross-process lock.
 */
export function parseKimiCliCredential(raw: string): OAuthCredentials | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const access = data.access_token;
    const refresh = data.refresh_token;
    const expiresAtSeconds = data.expires_at;
    if (
      typeof access !== "string"
      || access.length === 0
      || typeof expiresAtSeconds !== "number"
      || !Number.isFinite(expiresAtSeconds)
      || expiresAtSeconds <= 0
    ) {
      return null;
    }
    const identity = identityFromKimiTokens(
      access,
      typeof refresh === "string" && refresh.length > 0 ? refresh : undefined,
    );
    return {
      access,
      // Fail closed if this credential ever escapes the local-CLI refresh branch.
      refresh: "",
      expires: expiresAtSeconds * 1000,
      ...identity,
      source: "local-cli",
    };
  } catch {
    return null;
  }
}

/** Read-only detection of the current Kimi Code CLI credential generation. */
export function detectKimiCliToken(): OAuthCredentials | null {
  const path = join(kimiCodeHome(), "credentials", "kimi-code.json");
  const raw = readBoundedRegularFile(path, MAX_KIMI_CREDENTIAL_BYTES);
  return raw ? parseKimiCliCredential(raw) : null;
}

/** Claude Code config dir: `CLAUDE_CONFIG_DIR` override, else `~/.claude`. */
function claudeConfigDir(): string {
  const explicit = process.env.CLAUDE_CONFIG_DIR?.trim();
  return explicit ? explicit : join(homedir(), ".claude");
}

/** Read the Claude Code OAuth credential from the macOS Keychain (darwin only). */
function readClaudeKeychain(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execSync(`security find-generic-password -s "${CLAUDE_KEYCHAIN_SERVICE}" -w`, {
      encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read the Claude Code credential file (`<config-dir>/.credentials.json`).
 * Claude Code writes this on Linux/Windows (and on macOS when the Keychain is
 * unavailable); it carries the same `claudeAiOauth` payload as the Keychain item.
 * Exported for tests.
 */
export function readClaudeCredentialsFile(): string | null {
  const path = join(claudeConfigDir(), ".credentials.json");
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** Keychain first on macOS, then the cross-platform credentials file. */
function readClaudeSecureStorage(): string | null {
  // An explicit config-dir override identifies a separate Claude installation/profile.
  // Do not let the default macOS Keychain entry shadow that requested credential file.
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) return readClaudeCredentialsFile() ?? readClaudeKeychain();
  return readClaudeKeychain() ?? readClaudeCredentialsFile();
}

export function parseClaudeOauthPayload(raw: string): OAuthCredentials | null {
  try {
    const data = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } };
    const o = data.claudeAiOauth;
    if (!o?.accessToken || !o?.refreshToken) return null;
    return { access: o.accessToken, refresh: o.refreshToken, expires: o.expiresAt ?? 0, source: "local-cli" };
  } catch {
    return null;
  }
}

export function detectClaudeCodeToken(): OAuthCredentials | null {
  const raw = readClaudeSecureStorage();
  if (!raw) return null;
  return parseClaudeOauthPayload(raw);
}

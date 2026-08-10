/**
 * Local evidence that a configured provider credential completed real inference.
 * Public model catalogs (notably OpenCode Go) are not authentication probes.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFile,
  getConfigDir,
  resolveEnvValue,
  withConfigMutationLockSync,
} from "../config";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../types";

const STATE_VERSION = 1 as const;
const STATE_MAX_BYTES = 128 * 1024;
const pending = new Set<string>();
let cachedRoot = "";
let cachedState: VerificationState | null = null;

interface VerificationRow {
  credentialId: string;
  verifiedAt: number;
}

interface VerificationState {
  version: typeof STATE_VERSION;
  providers: Record<string, VerificationRow>;
}

export type ProviderCredentialVerification = "not_configured" | "unverified" | "verified";

function statePath(): string {
  return join(getConfigDir(), "provider-credential-verification.json");
}

function emptyState(): VerificationState {
  return { version: STATE_VERSION, providers: {} };
}

function isRow(value: unknown): value is VerificationRow {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as VerificationRow).credentialId === "string"
    && /^[0-9a-f]{64}$/.test((value as VerificationRow).credentialId)
    && typeof (value as VerificationRow).verifiedAt === "number"
    && Number.isFinite((value as VerificationRow).verifiedAt);
}

function parseState(value: unknown): VerificationState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== STATE_VERSION || !raw.providers || typeof raw.providers !== "object" || Array.isArray(raw.providers)) return null;
  const providers: Record<string, VerificationRow> = {};
  for (const [name, row] of Object.entries(raw.providers as Record<string, unknown>)) {
    if (!isRow(row)) return null;
    providers[name] = row;
  }
  return { version: STATE_VERSION, providers };
}

function readState(fresh = false): VerificationState | null {
  const root = getConfigDir();
  if (!fresh && cachedRoot === root && cachedState) return cachedState;
  const path = statePath();
  if (!existsSync(path)) {
    cachedRoot = root;
    cachedState = emptyState();
    return cachedState;
  }
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > STATE_MAX_BYTES) return null;
    const state = parseState(JSON.parse(readFileSync(path, "utf8")));
    if (!state) return null;
    cachedRoot = root;
    cachedState = state;
    return state;
  } catch {
    return null;
  }
}

function credentialId(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function canonicalOpenCodeGo(provider: CodexCommanderProviderConfig): boolean {
  try {
    const url = new URL(provider.baseUrl);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "opencode.ai"
      && url.port === ""
      && url.pathname.replace(/\/+$/, "") === "/zen/go/v1"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function configuredCredential(config: CodexCommanderConfig, providerName: string): string | null {
  const provider = config.providers[providerName];
  if (!provider || providerName !== "opencode-go" || !canonicalOpenCodeGo(provider)) return null;
  return resolveEnvValue(provider.apiKey)?.trim() || null;
}

export function providerCredentialVerification(
  config: CodexCommanderConfig,
  providerName: string,
): ProviderCredentialVerification | null {
  const provider = config.providers[providerName];
  if (!provider || providerName !== "opencode-go" || !canonicalOpenCodeGo(provider)) return null;
  const key = configuredCredential(config, providerName);
  if (!key) return "not_configured";
  return readState()?.providers[providerName]?.credentialId === credentialId(key)
    ? "verified"
    : "unverified";
}

/**
 * Record success once per active key. The first successful request schedules a
 * small protected metadata write; subsequent requests are memory-only reads.
 */
export function noteProviderCredentialVerified(
  config: CodexCommanderConfig,
  providerName: string,
  routedKey?: string,
): void {
  if (providerName !== "opencode-go") return;
  const provider = config.providers[providerName];
  if (!provider || !canonicalOpenCodeGo(provider)) return;
  const key = routedKey?.trim() || configuredCredential(config, providerName);
  if (!key) return;
  const id = credentialId(key);
  if (readState()?.providers[providerName]?.credentialId === id) return;
  const pendingKey = `${getConfigDir()}\0${providerName}\0${id}`;
  if (pending.has(pendingKey)) return;
  pending.add(pendingKey);
  queueMicrotask(() => {
    try {
      withConfigMutationLockSync(() => {
        const state = readState(true);
        // Malformed state is never silently replaced; the provider remains
        // unverified until the user repairs/removes that metadata file.
        if (!state) return;
        if (state.providers[providerName]?.credentialId === id) return;
        const next: VerificationState = {
          version: STATE_VERSION,
          providers: {
            ...state.providers,
            [providerName]: { credentialId: id, verifiedAt: Date.now() },
          },
        };
        atomicWriteFile(statePath(), `${JSON.stringify(next, null, 2)}\n`);
        cachedRoot = getConfigDir();
        cachedState = next;
      });
    } catch {
      // Verification metadata is diagnostic; a failed write never fails inference.
    } finally {
      pending.delete(pendingKey);
    }
  });
}

export function resetCredentialVerificationCacheForTests(): void {
  cachedRoot = "";
  cachedState = null;
  pending.clear();
}

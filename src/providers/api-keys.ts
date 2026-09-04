/**
 * Multi-key pool for key-auth providers (the API-key twin of OAuth multiauth).
 *
 * `provider.apiKey` stays the single source of truth for routing — it always mirrors the
 * ACTIVE pool entry, so the router/adapters never learn about the pool. The pool itself
 * lives in `provider.apiKeyPool` in config.json (same file that already holds apiKey).
 */
import { createHash } from "node:crypto";
import { saveConfigPreservingClaudeCode } from "../config";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../types";

export interface ProviderApiKeyInfo {
  id: string;
  label?: string;
  /** First/last 4 chars only; env references (`${VAR}`) are shown verbatim (not secrets). */
  masked: string;
  active: boolean;
  addedAt?: number;
}

export const PROVIDER_API_KEY_LABEL_MAX_LENGTH = 80;
const UNSAFE_PROVIDER_API_KEY_LABEL = /[\\/\p{Cc}\p{Cf}\p{Cs}]/u;

export type SanitizedProviderApiKeyLabel =
  | { ok: true; label?: string }
  | { ok: false; error: string };

/** A key label is display-only and must never become a secret or path side channel. */
export function sanitizeProviderApiKeyLabel(
  value: unknown,
  keyMaterial?: string | readonly string[],
): SanitizedProviderApiKeyLabel {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (typeof value !== "string") return { ok: false, error: "label must be a string" };
  const label = value.trim();
  if (!label) return { ok: true };
  if (
    Array.from(label).length > PROVIDER_API_KEY_LABEL_MAX_LENGTH
    || UNSAFE_PROVIDER_API_KEY_LABEL.test(label)
  ) {
    return { ok: false, error: "label must be at most 80 printable characters without path separators" };
  }
  const secrets = typeof keyMaterial === "string" ? [keyMaterial] : keyMaterial ?? [];
  if (secrets.some(secret => secret && label.includes(secret))) {
    return { ok: false, error: "label must not contain API key material" };
  }
  return { ok: true, label };
}

function isEnvReference(value: string): boolean {
  return /^\$\{?\w+\}?$/.test(value);
}

export function maskApiKey(value: string): string {
  if (isEnvReference(value)) return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/** Content-derived id: re-adding the same key upserts instead of duplicating. */
export function apiKeyPoolEntryId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/**
 * True for providers whose upstream auth is a configured API key (not oauth/forward).
 * Cursor is OAuth-default dual-mode: a pasted dashboard key is stored on the same provider
 * row, so the pool APIs must accept `authMode: "oauth"` when the adapter is `cursor`.
 */
export function isKeyAuthProvider(provider: CodexCommanderProviderConfig): boolean {
  if (provider.authMode === "forward") return false;
  if (provider.authMode === "oauth") return provider.adapter === "cursor";
  return true;
}

/** Trim and reject blank / CRLF-bearing secrets. Shared by pool writes and OAuth upsert. */
export function sanitizeApiKeyValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !/[\r\n]/.test(trimmed) ? trimmed : undefined;
}

/**
 * The persisted key shape is canonical only when every pool row is valid and the active
 * `apiKey` exactly mirrors one row. Old bare keys and malformed pools are intentionally not
 * repaired: they require an explicit user add/re-auth action.
 */
export function currentProviderApiKeyPool(
  provider: CodexCommanderProviderConfig,
): NonNullable<CodexCommanderProviderConfig["apiKeyPool"]> | undefined {
  const pool = provider.apiKeyPool;
  if (!Array.isArray(pool) || pool.length === 0 || typeof provider.apiKey !== "string") return undefined;
  if (sanitizeApiKeyValue(provider.apiKey) !== provider.apiKey) return undefined;
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const entry of pool) {
    if (!entry || typeof entry !== "object") return undefined;
    if (typeof entry.id !== "string" || !entry.id || entry.id.trim() !== entry.id || ids.has(entry.id)) return undefined;
    if (sanitizeApiKeyValue(entry.key) !== entry.key || keys.has(entry.key)) return undefined;
    if (entry.label !== undefined && (typeof entry.label !== "string" || !entry.label.trim())) return undefined;
    if (entry.addedAt !== undefined && (!Number.isFinite(entry.addedAt) || entry.addedAt < 0)) return undefined;
    ids.add(entry.id);
    keys.add(entry.key);
  }
  const keyMaterial = [provider.apiKey, ...pool.map(entry => entry.key)];
  for (const entry of pool) {
    const label = sanitizeProviderApiKeyLabel(entry.label, keyMaterial);
    if (!label.ok || label.label !== entry.label) return undefined;
  }
  return pool.some(entry => entry.key === provider.apiKey) ? pool : undefined;
}

export function listProviderApiKeys(config: CodexCommanderConfig, name: string): { activeId: string | null; keys: ProviderApiKeyInfo[] } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { activeId: null, keys: [] };
  const pool = currentProviderApiKeyPool(provider);
  if (!pool) return { activeId: null, keys: [] };
  const activeId = pool.find(entry => entry.key === provider.apiKey)!.id;
  return {
    activeId,
    keys: pool.map(entry => ({
      id: entry.id,
      ...(entry.label ? { label: entry.label } : {}),
      masked: maskApiKey(entry.key),
      active: entry.id === activeId,
      ...(entry.addedAt !== undefined ? { addedAt: entry.addedAt } : {}),
    })),
  };
}

/** Add (or upsert) a key and make it ACTIVE. Persists config. */
export function addProviderApiKey(config: CodexCommanderConfig, name: string, key: string, label?: string): { id: string } | { error: string } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { error: "provider does not use API-key auth" };
  if (typeof key !== "string" || !key.trim()) return { error: "key is required" };
  const trimmed = sanitizeApiKeyValue(key);
  if (!trimmed) return { error: "key must not include line breaks" };
  // An explicit add is the recovery action for a missing or invalid pool: start fresh
  // instead of incorporating unverified credential material.
  const pool = currentProviderApiKeyPool(provider) ? [...provider.apiKeyPool!] : [];
  const sanitizedLabel = sanitizeProviderApiKeyLabel(label, [trimmed, ...pool.map(entry => entry.key)]);
  if (!sanitizedLabel.ok) return { error: sanitizedLabel.error };
  const id = apiKeyPoolEntryId(trimmed);
  const existing = pool.find(e => e.id === id);
  if (existing) {
    if (sanitizedLabel.label) existing.label = sanitizedLabel.label;
  } else {
    pool.push({ id, key: trimmed, ...(sanitizedLabel.label ? { label: sanitizedLabel.label } : {}), addedAt: Date.now() });
  }
  provider.apiKeyPool = pool;
  provider.apiKey = trimmed;
  // Dual-mode OAuth presets (Cursor) keep oauth as default until a key is pasted.
  // Routing only honors the key when authMode is explicitly "key".
  if (provider.adapter === "cursor") provider.authMode = "key";
  saveConfigPreservingClaudeCode(config);
  return { id };
}

/** Switch the ACTIVE key (mirrors into `provider.apiKey`). Persists config. */
export function setActiveProviderApiKey(config: CodexCommanderConfig, name: string, id: string): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  const pool = currentProviderApiKeyPool(provider);
  if (!pool) return false;
  const entry = pool.find(e => e.id === id);
  if (!entry) return false;
  provider.apiKey = entry.key;
  saveConfigPreservingClaudeCode(config);
  return true;
}

/** Rename a key slot without changing its id, secret, or active routing state. */
export function setProviderApiKeyLabel(config: CodexCommanderConfig, name: string, id: string, label: string | undefined): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  const pool = currentProviderApiKeyPool(provider);
  if (!pool) return false;
  const entry = pool.find(e => e.id === id);
  if (!entry) return false;
  const sanitizedLabel = sanitizeProviderApiKeyLabel(label, pool.map(candidate => candidate.key));
  if (!sanitizedLabel.ok) return false;
  if (sanitizedLabel.label) entry.label = sanitizedLabel.label;
  else delete entry.label;
  saveConfigPreservingClaudeCode(config);
  return true;
}

/** Remove one key; removing the active one promotes the first remaining. Persists config. */
export function removeProviderApiKey(config: CodexCommanderConfig, name: string, id: string): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  const pool = currentProviderApiKeyPool(provider);
  if (!pool) return false;
  const entry = pool.find(e => e.id === id);
  if (!entry) return false;
  provider.apiKeyPool = pool.filter(e => e.id !== id);
  if (provider.apiKey === entry.key) {
    const next = provider.apiKeyPool[0];
    if (next) provider.apiKey = next.key;
    else delete provider.apiKey;
  }
  if (provider.apiKeyPool.length === 0) delete provider.apiKeyPool;
  saveConfigPreservingClaudeCode(config);
  return true;
}

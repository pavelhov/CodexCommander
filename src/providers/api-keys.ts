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

export interface ProviderApiKeyList {
  revision: number;
  activeId: string | null;
  keys: ProviderApiKeyInfo[];
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

/** True for providers whose upstream auth is a configured API key (not oauth/forward). */
export function isKeyAuthProvider(provider: CodexCommanderProviderConfig): boolean {
  return provider.authMode !== "oauth" && provider.authMode !== "forward";
}

/**
 * Whether the management plane may maintain a dormant key pool for this provider row.
 * Canonical xAI is dual-source for media: its chat route may remain OAuth while media binds
 * an explicitly selected API-key slot. Managing that pool must never mutate chat authMode.
 */
export function supportsManagedProviderApiKeys(
  name: string,
  provider: CodexCommanderProviderConfig,
): boolean {
  return isKeyAuthProvider(provider) || (name === "xai" && provider.authMode === "oauth");
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
  return pool.some(entry => entry.key === provider.apiKey) ? pool : undefined;
}

function providerApiKeyPoolRevision(activeId: string | null, keys: ProviderApiKeyInfo[]): number {
  const semantic = JSON.stringify({
    activeId,
    keys: keys.map(key => ({ id: key.id, label: key.label ?? null })),
  });
  return Number.parseInt(createHash("sha256").update(semantic).digest("hex").slice(0, 12), 16);
}

export function listProviderApiKeys(config: CodexCommanderConfig, name: string): ProviderApiKeyList {
  const provider = config.providers[name];
  if (!provider || !supportsManagedProviderApiKeys(name, provider)) {
    return { revision: providerApiKeyPoolRevision(null, []), activeId: null, keys: [] };
  }
  const pool = currentProviderApiKeyPool(provider);
  if (!pool) return { revision: providerApiKeyPoolRevision(null, []), activeId: null, keys: [] };
  const activeId = pool.find(entry => entry.key === provider.apiKey)!.id;
  const keys = pool.map(entry => ({
    id: entry.id,
    ...(entry.label ? { label: entry.label } : {}),
    masked: maskApiKey(entry.key),
    active: entry.id === activeId,
    ...(entry.addedAt !== undefined ? { addedAt: entry.addedAt } : {}),
  }));
  return {
    revision: providerApiKeyPoolRevision(activeId, keys),
    activeId,
    keys,
  };
}

type ProviderApiKeyMutationOptions = { persist?: boolean };

function persistProviderApiKeyMutation(
  config: CodexCommanderConfig,
  options: ProviderApiKeyMutationOptions | undefined,
): void {
  if (options?.persist !== false) saveConfigPreservingClaudeCode(config);
}

/** Add (or upsert) a key and make it ACTIVE. Persists config unless explicitly composed inside a persisted-config mutation. */
export function addProviderApiKey(
  config: CodexCommanderConfig,
  name: string,
  key: string,
  label?: string,
  options?: ProviderApiKeyMutationOptions,
): { id: string } | { error: string } {
  const provider = config.providers[name];
  if (!provider || !supportsManagedProviderApiKeys(name, provider)) return { error: "provider does not use API-key auth" };
  if (typeof key !== "string" || !key.trim()) return { error: "key is required" };
  const trimmed = sanitizeApiKeyValue(key);
  if (!trimmed) return { error: "key must not include line breaks" };
  // An explicit add is the recovery action for a missing or invalid pool: start fresh
  // instead of incorporating unverified credential material.
  const pool = currentProviderApiKeyPool(provider) ? [...provider.apiKeyPool!] : [];
  const id = apiKeyPoolEntryId(trimmed);
  const existing = pool.find(e => e.id === id);
  if (existing) {
    if (label?.trim()) existing.label = label.trim();
  } else {
    pool.push({ id, key: trimmed, ...(label?.trim() ? { label: label.trim() } : {}), addedAt: Date.now() });
  }
  provider.apiKeyPool = pool;
  provider.apiKey = trimmed;
  persistProviderApiKeyMutation(config, options);
  return { id };
}

/** Switch the ACTIVE key (mirrors into `provider.apiKey`). Persists config unless composed inside a persisted-config mutation. */
export function setActiveProviderApiKey(
  config: CodexCommanderConfig,
  name: string,
  id: string,
  options?: ProviderApiKeyMutationOptions,
): boolean {
  const provider = config.providers[name];
  if (!provider || !supportsManagedProviderApiKeys(name, provider)) return false;
  const pool = currentProviderApiKeyPool(provider);
  if (!pool) return false;
  const entry = pool.find(e => e.id === id);
  if (!entry) return false;
  provider.apiKey = entry.key;
  persistProviderApiKeyMutation(config, options);
  return true;
}

/** Rename a key slot without changing its id, secret, or active routing state. */
export function setProviderApiKeyLabel(
  config: CodexCommanderConfig,
  name: string,
  id: string,
  label: string | undefined,
  options?: ProviderApiKeyMutationOptions,
): boolean {
  const provider = config.providers[name];
  if (!provider || !supportsManagedProviderApiKeys(name, provider)) return false;
  const pool = currentProviderApiKeyPool(provider);
  if (!pool) return false;
  const entry = pool.find(e => e.id === id);
  if (!entry) return false;
  const trimmedLabel = label?.trim();
  if (trimmedLabel) entry.label = trimmedLabel;
  else delete entry.label;
  persistProviderApiKeyMutation(config, options);
  return true;
}

/** Remove one key; removing the active one promotes the first remaining. Persists config unless composed inside a persisted-config mutation. */
export function removeProviderApiKey(
  config: CodexCommanderConfig,
  name: string,
  id: string,
  options?: ProviderApiKeyMutationOptions,
): boolean {
  const provider = config.providers[name];
  if (!provider || !supportsManagedProviderApiKeys(name, provider)) return false;
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
  persistProviderApiKeyMutation(config, options);
  return true;
}

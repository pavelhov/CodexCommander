import { createHash } from "node:crypto";
import { loadConfig, resolveEnvValue } from "../config";
import {
  forceRefreshOAuthAccessSnapshot,
  getValidAccessTokenSnapshotForAccount,
  type OAuthAccessSnapshot,
} from "../oauth";
import { getAccountSet } from "../oauth/store";
import type { ProviderAccount, ProviderAccountSet } from "../oauth/types";
import {
  currentProviderApiKeyPool,
  sanitizeApiKeyValue,
} from "../providers/api-keys";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../types";
import type { MediaCredentialBinding, MediaProviderKind } from "./types";
import { MediaTransportError, mediaError } from "./media-errors";

const SLOT_DOMAIN = "ccx-xai-media-slot-v1";
const OAUTH_IDENTITY_DOMAIN = "ccx-xai-media-oauth-subject-v1";
const KEY_IDENTITY_DOMAIN = "ccx-xai-media-api-key-v1";
const XAI_MEDIA_HOSTS = new Set(["api.x.ai", "cli-chat-proxy.grok.com"]);

function digest(domain: string, value: string): string {
  return `sha256:${createHash("sha256").update(domain).update("\0").update(value).digest("hex")}`;
}

function slotRef(kind: "oauth" | "key", providerKind: MediaProviderKind, providerName: string, slot: string): string {
  return `media-slot:${createHash("sha256")
    .update(SLOT_DOMAIN)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(providerKind)
    .update("\0")
    .update(providerName)
    .update("\0")
    .update(slot)
    .digest("hex")}`;
}

function needsAuth(): MediaTransportError {
  return mediaError({ code: "needs_auth", phase: "pre_dispatch", certainty: "definite" });
}

interface ProviderSlot {
  name: "xai";
  kind: "canonical";
  provider: CodexCommanderProviderConfig;
}

function configuredProvider(config: CodexCommanderConfig): ProviderSlot {
  const canonical = Object.hasOwn(config.providers, "xai") ? config.providers.xai : undefined;
  if (!canonical || canonical.disabled === true) throw needsAuth();
  // Paid media authority is intentionally narrower than ordinary provider
  // routing. Only the human-attested canonical xai credential may arm work;
  // hostname-matched legacy aliases remain usable for chat but never media.
  return { name: "xai", kind: "canonical", provider: canonical };
}

function isLegacyXaiMediaProvider(provider: CodexCommanderProviderConfig): boolean {
  try {
    return XAI_MEDIA_HOSTS.has(new URL(provider.baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

interface KeySlot {
  storedSlot: string;
  storedValue: string;
}

function configuredKeySlots(provider: CodexCommanderProviderConfig): KeySlot[] {
  if (Object.hasOwn(provider, "apiKeyPool")) {
    const pool = currentProviderApiKeyPool(provider);
    // A present pool that is empty, malformed, or does not canonically mirror
    // apiKey must never revive the separately billed legacy bare-key path.
    return pool?.map(entry => ({ storedSlot: `pool:${entry.id}`, storedValue: entry.key })) ?? [];
  }
  const bare = sanitizeApiKeyValue(provider.apiKey);
  return bare ? [{ storedSlot: "legacy-bare", storedValue: bare }] : [];
}

function selectedKeySlot(provider: CodexCommanderProviderConfig): KeySlot {
  const candidates = configuredKeySlots(provider);
  const active = Object.hasOwn(provider, "apiKeyPool")
    ? candidates.find(entry => entry.storedValue === provider.apiKey)
    : candidates[0];
  if (!active) throw needsAuth();
  return active;
}

function resolvedKey(storedValue: string): string {
  const value = sanitizeApiKeyValue(resolveEnvValue(storedValue));
  if (!value) throw needsAuth();
  return value;
}

function stableSubject(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && value.trim() === value
    && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : undefined;
}

function stableOAuthAccount(set: ProviderAccountSet | null, accountId?: string): ProviderAccount {
  if (!set) throw needsAuth();
  const id = accountId ?? set.activeAccountId;
  if (!id || id.length > 128 || id.trim() !== id || /[\x00-\x1f\x7f]/.test(id)) throw needsAuth();
  const account = set.accounts.find(candidate => candidate.id === id);
  if (!account || account.needsReauth || !stableSubject(account.credential.accountId)) throw needsAuth();
  return account;
}

export interface BindMediaCredentialDeps {
  getOAuthAccountSet?: (provider: string) => ProviderAccountSet | null;
}

/** Bind the one explicitly configured source without resolving or retaining a bearer. */
export function bindMediaCredential(
  config: CodexCommanderConfig,
  deps: BindMediaCredentialDeps = {},
): MediaCredentialBinding {
  const source = config.images?.authSource;
  if (source !== "api_key" && source !== "subscription_oauth") throw needsAuth();
  const selected = configuredProvider(config);
  if (source === "subscription_oauth") {
    if (selected.kind !== "canonical") throw needsAuth();
    const account = stableOAuthAccount((deps.getOAuthAccountSet ?? getAccountSet)("xai"));
    const subject = stableSubject(account.credential.accountId)!;
    return {
      authSource: source,
      providerKind: "canonical",
      slotRef: slotRef("oauth", "canonical", "xai", account.id),
      identityDigest: digest(OAUTH_IDENTITY_DOMAIN, subject),
    };
  }

  const key = selectedKeySlot(selected.provider);
  const bearer = resolvedKey(key.storedValue);
  return {
    authSource: source,
    providerKind: selected.kind,
    slotRef: slotRef("key", selected.kind, selected.name, key.storedSlot),
    identityDigest: digest(KEY_IDENTITY_DOMAIN, bearer),
  };
}

export interface ResolvedMediaCredential {
  /** Ephemeral request-only bearer. Never persist, log, or serialize this value. */
  readonly bearer: string;
  /** Present only for the exact OAuth generation sent on the attempt. */
  readonly oauthSnapshot?: OAuthAccessSnapshot;
}

export interface MediaCredentialLease {
  resolve(binding: MediaCredentialBinding): Promise<ResolvedMediaCredential>;
  refreshAfterRejectedOAuth(
    binding: MediaCredentialBinding,
    rejected: OAuthAccessSnapshot,
  ): Promise<ResolvedMediaCredential>;
}

export interface MediaCredentialLeaseDeps {
  loadConfig?: () => CodexCommanderConfig;
  getOAuthAccountSet?: (provider: string) => ProviderAccountSet | null;
  getOAuthSnapshotForAccount?: (provider: string, accountId: string) => Promise<OAuthAccessSnapshot>;
  forceRefreshOAuth?: (rejected: OAuthAccessSnapshot) => Promise<OAuthAccessSnapshot>;
}

function findBoundOAuthAccount(
  binding: MediaCredentialBinding,
  getSet: (provider: string) => ProviderAccountSet | null,
): ProviderAccount {
  if (binding.authSource !== "subscription_oauth" || binding.providerKind !== "canonical") throw needsAuth();
  const set = getSet("xai");
  if (!set) throw needsAuth();
  const account = set.accounts.find(candidate =>
    slotRef("oauth", "canonical", "xai", candidate.id) === binding.slotRef);
  if (!account) throw needsAuth();
  const stable = stableOAuthAccount(set, account.id);
  if (digest(OAUTH_IDENTITY_DOMAIN, stableSubject(stable.credential.accountId)!) !== binding.identityDigest) throw needsAuth();
  return stable;
}

function findBoundKey(config: CodexCommanderConfig, binding: MediaCredentialBinding): string {
  if (binding.authSource !== "api_key") throw needsAuth();
  const providerCandidates: Array<{
    name: string;
    kind: MediaProviderKind;
    provider: CodexCommanderProviderConfig;
  }> = [];
  if (binding.providerKind === "canonical") {
    const selected = configuredProvider(config);
    providerCandidates.push(selected);
  } else {
    // Upgrade compatibility only: an already-durable accepted job may finish
    // GET/poll/download work through its exact former alias slot. New binding
    // never enters this branch, so aliases cannot arm another paid POST.
    for (const [name, provider] of Object.entries(config.providers)) {
      if (name === "xai" || !isLegacyXaiMediaProvider(provider)) continue;
      providerCandidates.push({ name, kind: "legacy_alias", provider });
    }
  }

  const matchingBearers: string[] = [];
  for (const selected of providerCandidates) {
    const candidates = configuredKeySlots(selected.provider);
    const candidate = candidates.find(item =>
      slotRef("key", selected.kind, selected.name, item.storedSlot) === binding.slotRef);
    if (!candidate) continue;
    const bearer = resolvedKey(candidate.storedValue);
    if (digest(KEY_IDENTITY_DOMAIN, bearer) === binding.identityDigest) matchingBearers.push(bearer);
  }
  if (matchingBearers.length !== 1) throw needsAuth();
  return matchingBearers[0]!;
}

/** Exact-slot dynamic lease backed by the existing generation-aware OAuth subsystem and live config. */
export function createMediaCredentialLease(deps: MediaCredentialLeaseDeps = {}): MediaCredentialLease {
  const config = deps.loadConfig ?? loadConfig;
  const accountSet = deps.getOAuthAccountSet ?? getAccountSet;
  const snapshotForAccount = deps.getOAuthSnapshotForAccount ?? getValidAccessTokenSnapshotForAccount;
  const forceRefresh = deps.forceRefreshOAuth ?? forceRefreshOAuthAccessSnapshot;

  const resolveOAuth = async (binding: MediaCredentialBinding): Promise<ResolvedMediaCredential> => {
    const account = findBoundOAuthAccount(binding, accountSet);
    let snapshot: OAuthAccessSnapshot;
    try {
      snapshot = await snapshotForAccount("xai", account.id);
    } catch {
      throw needsAuth();
    }
    if (snapshot.provider !== "xai" || snapshot.accountId !== account.id || !snapshot.accessToken) throw needsAuth();
    // Token acquisition may refresh and persist the account. Recheck the stable subject before dispatch.
    findBoundOAuthAccount(binding, accountSet);
    return { bearer: snapshot.accessToken, oauthSnapshot: snapshot };
  };

  return {
    async resolve(binding) {
      if (binding.authSource === "api_key") {
        let loaded: CodexCommanderConfig;
        try {
          loaded = config();
        } catch {
          throw needsAuth();
        }
        return { bearer: findBoundKey(loaded, binding) };
      }
      return resolveOAuth(binding);
    },

    async refreshAfterRejectedOAuth(binding, rejected) {
      const account = findBoundOAuthAccount(binding, accountSet);
      if (
        rejected.provider !== "xai"
        || rejected.accountId !== account.id
        || !rejected.generation
        || !rejected.accessToken
      ) throw needsAuth();
      let refreshed: OAuthAccessSnapshot;
      try {
        refreshed = await forceRefresh(rejected);
      } catch {
        throw needsAuth();
      }
      if (refreshed.provider !== "xai" || refreshed.accountId !== account.id || !refreshed.accessToken) throw needsAuth();
      findBoundOAuthAccount(binding, accountSet);
      return { bearer: refreshed.accessToken, oauthSnapshot: refreshed };
    },
  };
}

export const defaultMediaCredentialLease = createMediaCredentialLease();

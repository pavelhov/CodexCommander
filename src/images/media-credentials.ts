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

const XAI_MEDIA_HOSTS = new Set(["api.x.ai", "cli-chat-proxy.grok.com"]);
const SLOT_DOMAIN = "ccx-xai-media-slot-v1";
const OAUTH_IDENTITY_DOMAIN = "ccx-xai-media-oauth-subject-v1";
const KEY_IDENTITY_DOMAIN = "ccx-xai-media-api-key-v1";

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

function isXaiHostname(baseUrl: string): boolean {
  try {
    return XAI_MEDIA_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

interface ProviderSlot {
  name: string;
  kind: MediaProviderKind;
  provider: CodexCommanderProviderConfig;
}

function configuredProvider(config: CodexCommanderConfig, source: MediaCredentialBinding["authSource"]): ProviderSlot {
  const canonical = Object.hasOwn(config.providers, "xai") ? config.providers.xai : undefined;
  if (canonical) {
    if (canonical.disabled === true) throw needsAuth();
    return { name: "xai", kind: "canonical", provider: canonical };
  }
  if (source === "subscription_oauth") throw needsAuth();
  const aliases = Object.entries(config.providers).filter(([, provider]) =>
    provider.disabled !== true && isXaiHostname(provider.baseUrl));
  if (aliases.length !== 1) throw needsAuth();
  return { name: aliases[0]![0], kind: "legacy_alias", provider: aliases[0]![1] };
}

interface KeySlot {
  storedSlot: string;
  storedValue: string;
}

function selectedKeySlot(provider: CodexCommanderProviderConfig): KeySlot {
  const pool = currentProviderApiKeyPool(provider);
  if (pool) {
    const active = pool.find(entry => entry.key === provider.apiKey);
    if (!active) throw needsAuth();
    return { storedSlot: `pool:${active.id}`, storedValue: active.key };
  }
  const bare = sanitizeApiKeyValue(provider.apiKey);
  if (!bare) throw needsAuth();
  return { storedSlot: "legacy-bare", storedValue: bare };
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
  const selected = configuredProvider(config, source);
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
  const selected = configuredProvider(config, "api_key");
  if (selected.kind !== binding.providerKind) throw needsAuth();
  const candidates: KeySlot[] = [];
  const pool = currentProviderApiKeyPool(selected.provider);
  if (pool) {
    for (const entry of pool) candidates.push({ storedSlot: `pool:${entry.id}`, storedValue: entry.key });
  } else {
    const bare = sanitizeApiKeyValue(selected.provider.apiKey);
    if (bare) candidates.push({ storedSlot: "legacy-bare", storedValue: bare });
  }
  const candidate = candidates.find(item =>
    slotRef("key", selected.kind, selected.name, item.storedSlot) === binding.slotRef);
  if (!candidate) throw needsAuth();
  const bearer = resolvedKey(candidate.storedValue);
  if (digest(KEY_IDENTITY_DOMAIN, bearer) !== binding.identityDigest) throw needsAuth();
  return bearer;
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

/**
 * Temporary U2 compatibility seam for the legacy bridge plans that still carry one API key.
 * The shared transport still pins the origin, owns retry classification, and cannot consult OAuth.
 * U3/U5 must remove this once every handler passes MediaCredentialBinding.
 */
export function createStaticMediaCredentialLease(
  binding: MediaCredentialBinding,
  token: string,
): MediaCredentialLease {
  const bearer = sanitizeApiKeyValue(token);
  if (!bearer || binding.authSource !== "api_key") throw needsAuth();
  return {
    async resolve(candidate) {
      if (
        candidate.authSource !== "api_key"
        || candidate.slotRef !== binding.slotRef
        || candidate.identityDigest !== binding.identityDigest
      ) throw needsAuth();
      return { bearer };
    },
    async refreshAfterRejectedOAuth() {
      throw needsAuth();
    },
  };
}

/** Create a non-secret binding used only to route a legacy key through the shared transport. */
export function bindLegacyStaticApiKey(token: string): MediaCredentialBinding {
  const bearer = sanitizeApiKeyValue(token);
  if (!bearer) throw needsAuth();
  return {
    authSource: "api_key",
    providerKind: "canonical",
    slotRef: digest(SLOT_DOMAIN, `legacy-static\0${bearer}`),
    identityDigest: digest(KEY_IDENTITY_DOMAIN, bearer),
  };
}

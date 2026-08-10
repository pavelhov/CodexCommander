/**
 * Providers deep-link helpers for `#providers/<encoded-provider-id>/<tab>`.
 *
 * Pure URL parsing only: never treats provider ids as URLs/HTML, never carries
 * tokens/secrets, and never invents history entries (callers choose replace vs navigate).
 */

import { normalizeHashPath } from "./hash-routing";

/** Whitelisted detail tabs that may appear in the hash. */
export const PROVIDER_ROUTE_TABS = [
  "overview",
  "models",
  "usage",
  "accounts",
  "settings",
] as const;

export type ProviderRouteTab = (typeof PROVIDER_ROUTE_TABS)[number];

/**
 * Mirror of the server-side provider-name grammar (`isValidProviderName` in src/config.ts):
 * letters, numbers, dot, underscore, hyphen; no leading/trailing separator; max 64.
 * Reserved prototype keys are rejected so a hash segment can never widen Object scope.
 */
const PROVIDER_ROUTE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const RESERVED_PROVIDER_ROUTE_IDS = new Set(["__proto__", "prototype", "constructor"]);

export function isProviderRouteTab(value: string): value is ProviderRouteTab {
  return (PROVIDER_ROUTE_TABS as readonly string[]).includes(value);
}

/** True when `id` is a safe provider config key shape (decoded form). */
export function isSafeProviderRouteId(id: string): boolean {
  return id.length > 0
    && PROVIDER_ROUTE_ID_PATTERN.test(id)
    && !RESERVED_PROVIDER_ROUTE_IDS.has(id.toLowerCase());
}

/** Encode a validated provider id for a hash path segment. */
export function encodeProviderRouteId(providerId: string): string {
  return encodeURIComponent(providerId);
}

/**
 * Decode a single path segment exactly once and validate the result.
 * Rejects invalid encoding, unsafe shapes, and anything that looks like a URL.
 */
export function decodeProviderRouteId(segment: string): string | null {
  if (!segment) return null;
  // A raw slash or scheme fragment must never survive into the id.
  if (segment.includes("/") || segment.includes("\\") || segment.includes(":")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  // Decode exactly once: a still-encoded payload is not a provider id.
  if (decoded.includes("%")) return null;
  if (!isSafeProviderRouteId(decoded)) return null;
  return decoded;
}

export type ProviderRouteSelection = {
  providerId: string;
  tab: ProviderRouteTab;
};

export type ProviderHashResolution = {
  /** Whether App should keep this hash under the providers page. */
  belongs: boolean;
  /** Passive rewrite target, or null when the hash is already canonical enough. */
  replaceTo: string | null;
  /** Selected provider + tab when the hash points at a detail view. */
  selection: ProviderRouteSelection | null;
};

/** Build the canonical providers deep link for a provider + tab. */
export function providerRouteHash(
  providerId: string,
  tab: ProviderRouteTab = "overview",
): string {
  return `providers/${encodeProviderRouteId(providerId)}/${tab}`;
}

/**
 * Resolve a providers-page hash.
 *
 * - `#providers` → list
 * - `#providers/<id>` → detail overview (accepted without rewrite)
 * - `#providers/<id>/<tab>` → detail tab
 * - malformed id / encoding → replace to `#providers`
 * - unknown tab → replace to that provider's overview
 */
export function resolveProvidersHash(rawHash: string): ProviderHashResolution {
  const raw = normalizeHashPath(rawHash);
  if (raw === "providers") {
    return { belongs: true, replaceTo: null, selection: null };
  }
  if (!raw.startsWith("providers/")) {
    return { belongs: false, replaceTo: "providers", selection: null };
  }

  const rest = raw.slice("providers/".length);
  if (!rest) {
    return { belongs: true, replaceTo: "providers", selection: null };
  }

  const segments = rest.split("/");
  if (segments.length > 2) {
    const providerId = decodeProviderRouteId(segments[0] ?? "");
    if (!providerId) {
      return { belongs: false, replaceTo: "providers", selection: null };
    }
    return {
      belongs: true,
      replaceTo: providerRouteHash(providerId, "overview"),
      selection: { providerId, tab: "overview" },
    };
  }

  const providerId = decodeProviderRouteId(segments[0] ?? "");
  if (!providerId) {
    return { belongs: false, replaceTo: "providers", selection: null };
  }

  if (segments.length === 1) {
    return {
      belongs: true,
      replaceTo: null,
      selection: { providerId, tab: "overview" },
    };
  }

  const tabSegment = segments[1] ?? "";
  if (!isProviderRouteTab(tabSegment)) {
    return {
      belongs: true,
      replaceTo: providerRouteHash(providerId, "overview"),
      selection: { providerId, tab: "overview" },
    };
  }

  return {
    belongs: true,
    replaceTo: null,
    selection: { providerId, tab: tabSegment },
  };
}

/** Read the current (or provided) hash as a provider selection, if any. */
export function readProviderSelectionFromHash(hash?: string): ProviderRouteSelection | null {
  const raw = normalizeHashPath(
    hash ?? (typeof window !== "undefined" ? window.location.hash : ""),
  );
  if (!raw.startsWith("providers")) return null;
  return resolveProvidersHash(raw).selection;
}

/** Pure hash → page resolution used by App route state. */

import { normalizeHashPath } from "./hash-routing";
import { resolveProvidersHash } from "./provider-route";

export type Page =
  | "dashboard"
  | "startup"
  | "providers"
  | "models"
  | "combos"
  | "subagents"
  | "logs"
  | "usage"
  | "storage"
  | "codex-auth"
  | "integrations"
  | "routing";

export const VALID_PAGES = new Set<Page>([
  "dashboard",
  "startup",
  "providers",
  "models",
  "combos",
  "subagents",
  "logs",
  "usage",
  "storage",
  "codex-auth",
  "integrations",
  "routing",
]);

export function readPageFromHash(hash?: string): Page {
  const raw = normalizeHashPath(
    hash ?? (typeof window !== "undefined" ? window.location.hash : ""),
  );
  // Sub-views use a "/" suffix (e.g. #logs/debug); the first segment is the page id.
  const pageId = raw.split("/")[0] as Page;
  return VALID_PAGES.has(pageId) ? pageId : "dashboard";
}

/**
 * Dashboard section tabs live in the hash so refresh/bookmark/back-forward keep the
 * choice, mirroring Logs (`#logs` / `#logs/debug`). Overview is the bare `#dashboard`,
 * so it has no suffix entry here.
 */
export const DASHBOARD_TAB_HASHES = ["dashboard/providers", "dashboard/models"] as const;

/**
 * Integrations uses a wrapping outer tab strip. Claude Desktop is a nested
 * route owned by the Claude family panel, but it still has to be registered
 * here or App normalization strips it before Claude can read it.
 */
export const INTEGRATION_TAB_HASHES = [
  "integrations/keys",
  "integrations/codex",
  "integrations/claude",
  "integrations/claude/desktop",
  "integrations/grok",
  "integrations/opencode",
  "integrations/pi",
  "integrations/hermes",
  "integrations/openclaw",
  "integrations/kimi",
  "integrations/gajae",
] as const;

export function hashBelongsToPage(rawHash: string, page: Page): boolean {
  if (rawHash === page) return true;
  if (page === "logs" && rawHash === "logs/debug") return true;
  if (page === "dashboard"
    && (DASHBOARD_TAB_HASHES as readonly string[]).includes(rawHash)) {
    return true;
  }
  if (page === "providers") {
    return resolveProvidersHash(rawHash).belongs;
  }
  if (page === "integrations"
    && (INTEGRATION_TAB_HASHES as readonly string[]).includes(rawHash)) return true;
  return false;
}


/** Result of resolving an incoming hash. */
export type AppHashChangeAction = {
  page: Page;
  /** When non-null, passively replace the hash (no new history entry). */
  replaceTo: string | null;
};

/**
 * Resolve what App should do for the current location hash.
 * Any rewrite this returns is passive: callers apply it with replaceState, never a
 * push, so Back is never trapped on a hash the router immediately corrects.
 */
export function resolveAppHashChange(rawHash: string): AppHashChangeAction {
  const nextPage = readPageFromHash(rawHash);

  // Providers detail deep links: keep valid ones, passively rewrite malformed ones.
  if (nextPage === "providers" && rawHash.startsWith("providers/")) {
    const resolved = resolveProvidersHash(rawHash);
    if (!resolved.belongs) {
      return { page: "providers", replaceTo: resolved.replaceTo ?? "providers" };
    }
    return { page: "providers", replaceTo: resolved.replaceTo };
  }

  // An unrecognised sub-hash is normalised away rather than left in the URL.
  if (!hashBelongsToPage(rawHash, nextPage)) {
    return { page: nextPage, replaceTo: nextPage };
  }

  return { page: nextPage, replaceTo: null };
}

/**
 * Hash used by navigation chrome after passive route correction. `replaceHash`
 * intentionally emits no hashchange event, so consumers that keep their own
 * selected-row state must resolve the replacement up front as well.
 */
export function resolvedNavigationHash(hash: string): string {
  const rawHash = normalizeHashPath(hash);
  return resolveAppHashChange(rawHash).replaceTo ?? rawHash;
}

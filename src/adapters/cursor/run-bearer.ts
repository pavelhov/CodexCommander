/**
 * Cursor Run Bearer materialization for pasted dashboard keys.
 *
 * Cursor OAuth refresh already POSTs to `/auth/exchange_user_api_key` with the refresh
 * token as Bearer. Dashboard user API keys (`crsr_…` from https://cursor.com/dashboard/api)
 * use that same exchange before they are valid AgentService/Run Bearers.
 *
 * Access JWTs and other opaque secrets are used as-is: GetUsableModels/Run already accept
 * a working Bearer, and Cloud Agents keys from `api.cursor.com` are a different product.
 */
import { createHash } from "node:crypto";
import { getTokenExpiry, refreshCursorToken } from "../../oauth/cursor";
import { fetchCursorUsableModels } from "./live-models";

const CURSOR_USER_API_KEY_PREFIX = "crsr_";

interface CachedCursorBearer {
  access: string;
  expires: number;
}

const bearerCache = new Map<string, CachedCursorBearer>();

function cacheId(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function cursorCredentialLooksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every(part => part.length > 0);
}

/** Dashboard user API keys need `/auth/exchange_user_api_key` before Run/GetUsableModels. */
export function cursorUserApiKeyNeedsExchange(token: string): boolean {
  return token.trim().toLowerCase().startsWith(CURSOR_USER_API_KEY_PREFIX);
}

export function clearCursorRunBearerCache(): void {
  bearerCache.clear();
}

/**
 * Return a Bearer that AgentService/Run and GetUsableModels will accept.
 *
 * - Unexpired JWTs (OAuth access tokens, already-exchanged session tokens): use as-is.
 * - `crsr_` dashboard user API keys: exchange, then cache the access token until JWT expiry.
 * - Anything else (including Cloud Agents `key_` secrets): use as-is. Validation/Run fail honestly.
 */
export async function materializeCursorRunBearer(raw: string, signal?: AbortSignal): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const id = cacheId(trimmed);
  const cached = bearerCache.get(id);
  if (cached && cached.expires > Date.now()) return cached.access;

  if (cursorCredentialLooksLikeJwt(trimmed) && getTokenExpiry(trimmed) > Date.now()) {
    bearerCache.set(id, { access: trimmed, expires: getTokenExpiry(trimmed) });
    return trimmed;
  }

  if (!cursorUserApiKeyNeedsExchange(trimmed)) return trimmed;

  const creds = await refreshCursorToken(trimmed, signal);
  const expires = creds.expires ?? getTokenExpiry(creds.access);
  bearerCache.set(id, { access: creds.access, expires });
  return creds.access;
}

/**
 * Best-effort paste validation: probe GetUsableModels with the raw secret, then exchange a
 * dashboard `crsr_` key if that probe is an auth failure. Never uses OpenAI-style GET /models.
 */
export async function validateCursorApiKey(
  key: string,
  baseUrl?: string,
): Promise<boolean | "unknown"> {
  const raw = await fetchCursorUsableModels({ apiKey: key, baseUrl });
  if (raw.ok) return true;
  if (raw.error !== "auth") return "unknown";
  try {
    const bearer = await materializeCursorRunBearer(key);
    if (bearer === key) return false;
    const exchanged = await fetchCursorUsableModels({ apiKey: bearer, baseUrl });
    if (exchanged.ok) return true;
    if (exchanged.error === "auth") return false;
    return "unknown";
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/\b401\b|\b403\b/.test(message)) return false;
    return "unknown";
  }
}

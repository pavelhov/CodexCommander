import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { adminApiTokenFilePath } from "../lib/admin-secrets";
import {
  ADMIN_AUTH_REQUIRED_MESSAGE,
  ADMIN_KEY_PREFIX,
  API_KEY_HEADER,
  CSRF_HEADER,
  GUI_ORIGIN_HEADER,
  GUI_SESSION_PREFIX,
} from "../identity";
import { forgetEphemeralSecretPath, forgetHardenedSecretPath, hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import type { CodexCommanderConfig } from "../types";
import {
  isAllowedManagementOrigin,
  isApiAuthRequired,
  isDataPlaneAdmissionSecret,
  isLoopbackHostname,
  managementRequestOrigin,
  parseHttpHost,
} from "./auth-cors";

const GUI_SESSION_TTL_MS = 5 * 60_000;
const GUI_SESSION_LIMIT = 128;

interface GuiSessionRecord {
  csrfToken: string;
  origin: string;
  expiresAt: number;
}

export interface GuiSessionBootstrap extends GuiSessionRecord {
  token: string;
}

export type ManagementAuthState =
  | {
    available: true;
    token: string;
    source: "environment" | "file";
    sessions: Map<string, GuiSessionRecord>;
  }
  | { available: false; reason: string };

function fail(reason: string): ManagementAuthState {
  return { available: false, reason };
}

function assertSafeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("management token directory is not a regular directory");
  chmodSync(path, 0o700);
  let hardened: { ok: boolean };
  try {
    hardened = hardenSecretDir(path, { required: true });
  } catch {
    // required:true hardening now fails closed on genuine ACL timeouts too;
    // keep the actionable guidance in the surfaced reason.
    hardened = { ok: false };
  }
  if (!hardened.ok) {
    throw new Error(
      "management token directory ACL hardening did not complete; set CODEXCOMMANDER_ADMIN_AUTH_TOKEN to use an environment token instead of a file-backed token",
    );
  }
}

function readExistingToken(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) {
    throw new Error("management token path is not a regular secret file");
  }
  chmodSync(path, 0o600);
  let hardened: { ok: boolean };
  try {
    hardened = hardenSecretPath(path, { required: true });
  } catch {
    hardened = { ok: false };
  }
  if (!hardened.ok) {
    throw new Error(
      "management token file ACL hardening did not complete; set CODEXCOMMANDER_ADMIN_AUTH_TOKEN to use an environment token instead of a file-backed token",
    );
  }
  const token = readFileSync(path, "utf8").trim();
  const secret = token.startsWith(ADMIN_KEY_PREFIX) ? token.slice(ADMIN_KEY_PREFIX.length) : "";
  if (secret.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new Error("management token file is invalid");
  }
  return token;
}

export function removeManagementTokenPathBestEffort(
  path: string,
  remove: (path: string) => void = unlinkSync,
  options?: { ephemeral?: boolean },
): void {
  // Temps get the full ephemeral release (success + both timeout namespaces);
  // stable token paths drop only the success memo — destination-keyed timeout
  // memos are intentional anti-restall state.
  const forget = options?.ephemeral ? forgetEphemeralSecretPath : forgetHardenedSecretPath;
  try {
    remove(path);
    forget(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") forget(path);
    /* other failures retain fail-closed state for the caller */
  }
}

function createTokenFile(path: string): string {
  const directory = dirname(path);
  const token = `${ADMIN_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const temporary = join(directory, `.${randomUUID()}.admin-token.tmp`);
  let linked = false;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${token}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temporary, 0o600);
    let temporaryHardened: { ok: boolean };
    try {
      // Destination-keyed timeout memo (the final token path), not the temp.
      temporaryHardened = hardenSecretPath(temporary, { required: true, timeoutMemoKey: path });
    } catch {
      temporaryHardened = { ok: false };
    }
    if (!temporaryHardened.ok) {
      throw new Error(
        "management token temporary ACL hardening did not complete; set CODEXCOMMANDER_ADMIN_AUTH_TOKEN to use an environment token instead of a file-backed token",
      );
    }
    try {
      linkSync(temporary, path);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return readExistingToken(path);
      throw error;
    }
    let finalHardened: { ok: boolean };
    try {
      finalHardened = hardenSecretPath(path, { required: true });
    } catch {
      finalHardened = { ok: false };
    }
    if (!finalHardened.ok) {
      throw new Error(
        "management token file ACL hardening did not complete; set CODEXCOMMANDER_ADMIN_AUTH_TOKEN to use an environment token instead of a file-backed token",
      );
    }
    return token;
  } catch (error) {
    if (linked) removeManagementTokenPathBestEffort(path);
    throw error;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    removeManagementTokenPathBestEffort(temporary, unlinkSync, { ephemeral: true });
  }
}

function ready(token: string, source: "environment" | "file", config: CodexCommanderConfig): ManagementAuthState {
  if (isDataPlaneAdmissionSecret(token, config)) {
    return fail("management credential conflicts with a data-plane credential");
  }
  return { available: true, token, source, sessions: new Map() };
}

export function initializeManagementAuthState(config: CodexCommanderConfig): ManagementAuthState {
  const environmentToken = process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN?.trim();
  if (environmentToken) {
    return ready(environmentToken, "environment", config);
  }
  try {
    const path = adminApiTokenFilePath();
    assertSafeDirectory(dirname(path));
    let token: string;
    try {
      token = readExistingToken(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      token = createTokenFile(path);
    }
    return ready(token, "file", config);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "management token initialization failed");
  }
}

function equalSecret(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function removeExpiredSessions(state: Extract<ManagementAuthState, { available: true }>, now = Date.now()): void {
  for (const [token, session] of state.sessions) {
    if (session.expiresAt <= now) state.sessions.delete(token);
  }
}

function randomSessionSecret(): string {
  return `${GUI_SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function issueGuiSession(
  req: Request,
  config: CodexCommanderConfig,
  state: ManagementAuthState,
): GuiSessionBootstrap | null {
  if (isApiAuthRequired(config) || !state.available || req.method !== "GET" || !isAllowedManagementOrigin(req, config)) return null;
  const host = parseHttpHost(req.headers.get("Host"));
  if (!host || !isLoopbackHostname(host.hostname)) return null;
  const origin = managementRequestOrigin(req, config);
  if (!origin) return null;
  const now = Date.now();
  removeExpiredSessions(state, now);
  while (state.sessions.size >= GUI_SESSION_LIMIT) {
    const oldest = state.sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    state.sessions.delete(oldest);
  }
  const token = randomSessionSecret();
  const session: GuiSessionRecord = {
    csrfToken: randomBytes(32).toString("base64url"),
    origin,
    expiresAt: now + GUI_SESSION_TTL_MS,
  };
  state.sessions.set(token, session);
  return { token, ...session };
}

/**
 * Which credential actually authorized a management request.
 *
 * `admin-token` is the raw token from disk/env: anything running as the user can
 * read it, including a coding agent. `gui-session` is a session token this process
 * minted for a browser, and it only authorizes a mutation after the origin and the
 * per-session CSRF token match. Consent-bearing routes must key off this value
 * rather than off request headers, which the token holder can forge freely.
 */
export type ManagementPrincipal = "admin-token" | "gui-session";

/**
 * The principal for a request that already passed `requireManagementAuth`. Kept as a
 * separate resolution (rather than a changed return type) so every existing caller
 * keeps its `Response | null` contract; the value is derived from the same session
 * table and the same CSRF comparison the gate uses, so the two cannot disagree.
 */
export function managementPrincipal(
  req: Request,
  state: ManagementAuthState,
  config?: CodexCommanderConfig,
): ManagementPrincipal | null {
  if (!state.available) return null;
  const actual = req.headers.get(API_KEY_HEADER)?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!actual) return null;
  if (equalSecret(actual, state.token)) return "admin-token";
  if (!config) return null;
  removeExpiredSessions(state);
  return state.sessions.has(actual) ? "gui-session" : null;
}

export function requireManagementAuth(
  req: Request,
  state: ManagementAuthState,
  config?: CodexCommanderConfig,
): Response | null {
  if (!state.available) {
    return Response.json({
      error: "management API unavailable",
      reason: state.reason,
      hint: "Set CODEXCOMMANDER_ADMIN_AUTH_TOKEN to bypass file-backed admin token ACL hardening",
    }, { status: 503 });
  }
  const actual = req.headers.get(API_KEY_HEADER)?.trim()
    || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (actual && equalSecret(actual, state.token)) return null;
  if (actual && config) {
    removeExpiredSessions(state);
    const session = state.sessions.get(actual);
    if (session) {
      const requestOrigin = managementRequestOrigin(req, config);
      const claimedOrigin = req.headers.get(GUI_ORIGIN_HEADER);
      const browserOrigin = req.headers.get("Origin");
      const sameOrigin = requestOrigin === session.origin
        && claimedOrigin === session.origin
        && (!browserOrigin || browserOrigin === session.origin);
      const safeMethod = req.method === "GET" || req.method === "HEAD";
      const csrf = req.headers.get(CSRF_HEADER)?.trim();
      if (sameOrigin && (safeMethod || (browserOrigin === session.origin && !!csrf && equalSecret(csrf, session.csrfToken)))) {
        return null;
      }
    }
  }
  return Response.json({ error: ADMIN_AUTH_REQUIRED_MESSAGE }, { status: 401 });
}

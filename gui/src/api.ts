import { promptForAdminToken, type AdminTokenVerifier } from "./admin-token-dialog";

let installed = false;
/** Shared 401 refresh gate — concurrent waiters join one prompt / token resolution. */
let resolutionInFlight: Promise<string | null> | null = null;
/** Unwrapped fetch captured at install time for the one-time launch exchange and
 * raw-admin verification, neither of which may enter the global 401 retry path. */
let rawFetch: typeof fetch | null = null;
/**
 * After the user cancels (or submits blank) once, suppress further prompts for this page
 * lifetime so a staggered 401 fan-out does not reopen the dialog N times (#647 / Codex).
 * A full reload clears module state and allows prompting again.
 */
let promptCancelled = false;

type AdminTokenPrompt = (verifyToken: AdminTokenVerifier) => Promise<string | null>;
let requestAdminToken: AdminTokenPrompt = promptForAdminToken;

const GUI_LAUNCH_EXCHANGE_PATH = "/api/gui-launch-exchange";
const GUI_LAUNCH_TICKET_PARAM = "ccx-launch-ticket";
const GUI_LAUNCH_ROUTE_PARAM = "ccx-route";
/** Safe authenticated read used to validate a raw admin token before closing the sign-in form. */
const ADMIN_TOKEN_VALIDATION_PATH = "/api/settings";

/**
 * Loopback is not an authenticated browser origin: another local OS user can
 * bind the expected port and serve a convincing page while the real proxy is
 * stopped. Never release the durable admin token to such a page. Remote
 * operator deployments may keep the explicit token prompt because their
 * origin (normally TLS) is the listener-authentication boundary.
 */
export function isBrowserLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (normalized === "" || normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1") return true;

  const octets = normalized.split(".");
  if (octets.length === 4
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127) return true;

  // URL parsers may retain dotted IPv4 or canonicalize it to the final two
  // hextets. Both forms below cover IPv4-mapped 127/8 loopback addresses.
  const mappedPrefix = normalized.startsWith("::ffff:")
    ? "::ffff:"
    : normalized.startsWith("0:0:0:0:0:ffff:")
      ? "0:0:0:0:0:ffff:"
      : null;
  if (mappedPrefix) {
    const mapped = normalized.slice(mappedPrefix.length);
    if (mapped.startsWith("127.")) return true;
    const firstMappedHextet = mapped.split(":", 1)[0];
    return /^7f[0-9a-f]{2}$/.test(firstMappedHextet ?? "");
  }
  return false;
}

export function isRawAdminPromptAllowed(): boolean {
  return window.location.protocol === "https:"
    && !isBrowserLoopbackHostname(window.location.hostname);
}

function needsApiAuth(input: RequestInfo | URL): boolean {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.href);
    // Absolute cross-origin URLs must never get the local API token or 401 prompt.
    if (url.origin !== window.location.origin) return false;
    return url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** In-memory only — never write tokens to web storage (XSS can read sessionStorage/localStorage). */
let memoryToken: string | null = null;
let memoryCsrfToken: string | null = null;
let memorySessionOrigin: string | null = null;
let memoryConfirmedGuiLaunch = false;
let memoryAdminCredential = false;
let guiLaunchCapabilityReady: Promise<boolean> = Promise.resolve(false);
const guiLaunchCapabilityListeners = new Set<() => void>();

function setConfirmedGuiLaunch(confirmed: boolean): void {
  if (memoryConfirmedGuiLaunch === confirmed) return;
  memoryConfirmedGuiLaunch = confirmed;
  for (const listener of guiLaunchCapabilityListeners) listener();
}

function setAdminCredential(admin: boolean): void {
  if (memoryAdminCredential === admin) return;
  memoryAdminCredential = admin;
  for (const listener of guiLaunchCapabilityListeners) listener();
}

function readToken(): string | null {
  return memoryToken;
}

function storeToken(token: string): void {
  memoryToken = token;
  setConfirmedGuiLaunch(false);
  setAdminCredential(true);
}

function clearToken(): void {
  memoryToken = null;
  memoryCsrfToken = null;
  memorySessionOrigin = null;
  setConfirmedGuiLaunch(false);
  setAdminCredential(false);
}

/** Clear memory only when it still holds `expected` (avoid wiping a newer concurrent store). */
function clearTokenIfCurrent(expected: string | null): void {
  if (expected != null && readToken() === expected) clearToken();
}

/** Validate and store a server-minted GUI session; rejects anything bound to another origin. */
function storeSession(
  token: string | null,
  csrfToken: string | null,
  origin: string | null,
  confirmedLaunch = false,
): boolean {
  if (!token?.startsWith("ccx_session_")
    || !csrfToken
    || origin !== window.location.origin) return false;
  memoryToken = token;
  memoryCsrfToken = csrfToken;
  memorySessionOrigin = origin;
  setAdminCredential(false);
  setConfirmedGuiLaunch(confirmedLaunch);
  return true;
}

function isGuiLaunchRoute(route: string | null): route is string {
  return route !== null
    && route.length > 0
    && route.length <= 512
    && !route.startsWith("/")
    && !route.includes("#")
    && !/[\u0000-\u001f\u007f]/.test(route);
}

/**
 * Read the process-local handoff out of the fragment, then scrub it before any
 * network request or React render. Ordinary application hashes are untouched.
 */
function takeGuiLaunchFragment(): { ticket: string; route: string } | null {
  const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  const params = new URLSearchParams(raw);
  if (!params.has(GUI_LAUNCH_TICKET_PARAM)) return null;
  const ticket = params.get(GUI_LAUNCH_TICKET_PARAM);
  const route = params.get(GUI_LAUNCH_ROUTE_PARAM);
  const validRoute = isGuiLaunchRoute(route);
  const replacement = `${window.location.pathname}${window.location.search}${validRoute ? `#${route}` : ""}`;
  window.history.replaceState(window.history.state, "", replacement);
  return ticket?.startsWith("ccx_launch_") && validRoute ? { ticket, route } : null;
}

async function exchangeGuiLaunchFragment(
  launch: { ticket: string; route: string } | null,
): Promise<boolean> {
  if (!launch || !rawFetch) return false;
  try {
    const response = await rawFetch(GUI_LAUNCH_EXCHANGE_PATH, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(launch),
    });
    if (!response.ok) return false;
    const value: unknown = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const envelope = value as Record<string, unknown>;
    const session = envelope.session;
    if (session === null || typeof session !== "object" || Array.isArray(session)) return false;
    const record = session as Record<string, unknown>;
    const stored = envelope.route === launch.route
      && record.confirmedLaunch === true
      && storeSession(
        typeof record.token === "string" ? record.token : null,
        typeof record.csrfToken === "string" ? record.csrfToken : null,
        typeof record.origin === "string" ? record.origin : null,
        true,
      );
    return stored;
  } catch {
    return false;
  }
}

async function verifyAdminToken(token: string): ReturnType<AdminTokenVerifier> {
  if (!rawFetch) return "unavailable";
  try {
    const [input, init] = withToken(ADMIN_TOKEN_VALIDATION_PATH, { cache: "no-store" }, token);
    const response = await rawFetch(input, init);
    if (response.status === 401) return "rejected";
    return response.ok ? "accepted" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function withToken(input: RequestInfo | URL, init: RequestInit | undefined, token: string): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const isSession = token.startsWith("ccx_session_");
  headers.set("X-CodexCommander-API-Key", token);
  if (memorySessionOrigin && memoryCsrfToken && isSession) {
    headers.set("X-CodexCommander-GUI-Origin", memorySessionOrigin);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      headers.set("X-CodexCommander-CSRF-Token", memoryCsrfToken);
    }
  }
  if (input instanceof Request) return [new Request(input, { headers }), init ? { ...init, headers } : undefined];
  return [input, { ...init, headers }];
}

/**
 * Resolve a token after a 401. Concurrent callers share one in-flight resolution so a dashboard
 * fan-out opens at most one credential dialog per /api request wave (#647). Re-reads
 * memoryToken before prompting so waiters that wake after another request already stored a token
 * do not re-prompt.
 */
async function resolveTokenAfter401(failedToken: string | null): Promise<string | null> {
  if (promptCancelled) return null;
  if (resolutionInFlight) return resolutionInFlight;

  // A loopback listener has not proven it is the protected CodexCommander
  // process. The launcher ticket is the only browser management handoff on
  // loopback, so a manual, expired, or failed launch must simply relaunch.
  if (!isRawAdminPromptAllowed()) {
    promptCancelled = true;
    return null;
  }

  resolutionInFlight = (async () => {
    if (promptCancelled) return null;
    const current = readToken();
    if (current && current !== failedToken) return current;

    const prompted = await requestAdminToken(verifyAdminToken);
    if (prompted) {
      storeToken(prompted);
      return prompted;
    }
    promptCancelled = true;
    return null;
  })().finally(() => {
    resolutionInFlight = null;
  });

  return resolutionInFlight;
}

export function installApiAuthFetch(): void {
  if (installed) return;
  installed = true;
  const originalFetch = window.fetch.bind(window);
  rawFetch = originalFetch;
  const launch = takeGuiLaunchFragment();
  guiLaunchCapabilityReady = exchangeGuiLaunchFragment(launch);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!needsApiAuth(input)) return originalFetch(input, init);

    // A launcher-confirmed page must finish its one-time exchange before the
    // dashboard fan-out attempts any authenticated management request.
    await guiLaunchCapabilityReady;

    const token = readToken();
    const [firstInput, firstInit] = token ? withToken(input, init, token) : [input, init];
    const response = await originalFetch(firstInput, firstInit);
    if (response.status !== 401) return response;

    // Another request may have stored a token while this one was in flight (or while prompt blocked).
    const refreshed = readToken();
    if (refreshed && refreshed !== token) {
      const [retryInput, retryInit] = withToken(input, init, refreshed);
      const retry = await originalFetch(retryInput, retryInit);
      if (retry.status !== 401) return retry;
      clearTokenIfCurrent(refreshed);
    } else {
      clearTokenIfCurrent(token);
    }

    const nextToken = await resolveTokenAfter401(token);
    if (!nextToken) return response;

    const [retryInput, retryInit] = withToken(input, init, nextToken);
    const retry = await originalFetch(retryInput, retryInit);
    if (retry.status === 401) clearTokenIfCurrent(nextToken);
    return retry;
  };
}

export function isConfirmedGuiLaunch(): boolean {
  return memoryConfirmedGuiLaunch;
}

export function isGuiMutationAuthorized(): boolean {
  return memoryConfirmedGuiLaunch || memoryAdminCredential;
}

export function whenGuiLaunchCapabilitySettles(): Promise<boolean> {
  return guiLaunchCapabilityReady;
}

export function subscribeGuiLaunchCapability(listener: () => void): () => void {
  guiLaunchCapabilityListeners.add(listener);
  return () => guiLaunchCapabilityListeners.delete(listener);
}

/** Test-only capability seam for component tests that do not install App auth. */
export function setConfirmedGuiLaunchForTests(confirmed: boolean): void {
  memoryAdminCredential = false;
  setConfirmedGuiLaunch(confirmed);
  guiLaunchCapabilityReady = Promise.resolve(confirmed);
}

/** Test-only: allow a fresh `installApiAuthFetch()` in the same module instance. */
export function resetApiAuthFetchForTests(adminTokenPrompt: AdminTokenPrompt = promptForAdminToken): void {
  installed = false;
  memoryToken = null;
  memoryCsrfToken = null;
  memorySessionOrigin = null;
  memoryConfirmedGuiLaunch = false;
  memoryAdminCredential = false;
  guiLaunchCapabilityReady = Promise.resolve(false);
  guiLaunchCapabilityListeners.clear();
  resolutionInFlight = null;
  rawFetch = null;
  promptCancelled = false;
  requestAdminToken = adminTokenPrompt;
}

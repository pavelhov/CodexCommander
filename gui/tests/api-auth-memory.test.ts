import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  installApiAuthFetch,
  isBrowserLoopbackHostname,
  isConfirmedGuiLaunch,
  resetApiAuthFetchForTests,
  whenGuiLaunchCapabilitySettles,
} from "../src/api";

const globals = ["document", "window", "navigator", "sessionStorage", "fetch"] as const;
const CONFIRMED_GUI_SESSION_STORAGE_KEY = "codexcommander.confirmed-gui-session.v1";
const CONFIRMED_GUI_SESSION_TOKEN = `ccx_session_${"S".repeat(43)}`;
const CONFIRMED_GUI_SESSION_CSRF = "C".repeat(43);
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let originalPrompt: typeof window.prompt;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    fetch: { configurable: true, value: testWindow.fetch.bind(testWindow) },
  });
  originalPrompt = window.prompt;
  resetApiAuthFetchForTests(async () => {
    return window.prompt("CodexCommander admin token (CODEXCOMMANDER_ADMIN_AUTH_TOKEN)")?.trim() || null;
  });
  sessionStorage.clear();
});

afterEach(() => {
  window.prompt = originalPrompt;
  resetApiAuthFetchForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function installMockAuthFetch(handler: typeof fetch): Promise<void> {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: handler });
  Object.defineProperty(window, "fetch", { configurable: true, value: handler });
  installApiAuthFetch();
  // installApiAuthFetch replaces window.fetch — keep globalThis in sync for bare `fetch()`.
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });
}

function useRemoteOperatorOrigin(): void {
  window.location.href = "https://operator.example/";
}

test("loopback classification covers aliases and the full OS loopback families", () => {
  for (const hostname of [
    "localhost",
    "LOCALHOST.",
    "dashboard.localhost",
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.254",
    "::1",
    "[::1]",
    "::ffff:127.0.0.9",
    "[::ffff:7f00:1]",
    "0:0:0:0:0:ffff:7fff:1",
  ]) {
    expect(isBrowserLoopbackHostname(hostname)).toBe(true);
  }
  for (const hostname of ["example.test", "192.0.2.10", "126.255.255.255", "128.0.0.1", "::2"]) {
    expect(isBrowserLoopbackHostname(hostname)).toBe(false);
  }
});

test("a manual loopback page never prompts for or validates a durable admin token", async () => {
  let promptCalls = 0;
  const seenPaths: string[] = [];
  const mockFetch = (async (input: RequestInfo | URL) => {
    seenPaths.push(new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname);
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "must-not-leave-the-browser";
  };
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(401);
  expect(promptCalls).toBe(0);
  expect(seenPaths).toEqual(["/api/config"]);
  expect(seenPaths).not.toContain("/api/settings");
});

test("a plaintext remote page never prompts for or validates a durable admin token", async () => {
  window.location.href = "http://operator.example/";
  let promptCalls = 0;
  const seenPaths: string[] = [];
  const mockFetch = (async (input: RequestInfo | URL) => {
    seenPaths.push(new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname);
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "must-not-cross-plaintext-http";
  };
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(401);
  expect(promptCalls).toBe(0);
  expect(seenPaths).toEqual(["/api/config"]);
  expect(seenPaths).not.toContain("/api/settings");
});

test("prompted API tokens stay memory-only and are not written to sessionStorage", async () => {
  useRemoteOperatorOrigin();
  let authorized = false;
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("X-CodexCommander-API-Key") === "fresh-token") {
      authorized = true;
      return new Response("{}", { status: 200 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => "fresh-token";

  await installMockAuthFetch(mockFetch);

  const res = await fetch("/api/config");
  expect(res.status).toBe(200);
  expect(authorized).toBe(true);
  expect(sessionStorage.length).toBe(0);
});

test("a confirmed launch session survives a same-tab reload and is ready before the first API request", async () => {
  const launchTicket = `ccx_launch_${"A".repeat(43)}`;
  const expiresAt = Date.now() + 60_000;
  window.location.hash = `ccx-launch-ticket=${launchTicket}&ccx-route=dashboard`;
  let exchangeCalls = 0;
  const seenApiRequests: Array<{ key: string | null; origin: string | null; csrf: string | null }> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname === "/api/gui-launch-exchange") {
      exchangeCalls += 1;
      return Response.json({
        route: "dashboard",
        session: {
          token: CONFIRMED_GUI_SESSION_TOKEN,
          csrfToken: CONFIRMED_GUI_SESSION_CSRF,
          origin: window.location.origin,
          expiresAt,
          confirmedLaunch: true,
        },
      });
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    seenApiRequests.push({
      key: headers.get("X-CodexCommander-API-Key"),
      origin: headers.get("X-CodexCommander-GUI-Origin"),
      csrf: headers.get("X-CodexCommander-CSRF-Token"),
    });
    return Response.json({ ok: true });
  }) as typeof fetch;

  await installMockAuthFetch(mockFetch);
  expect(await whenGuiLaunchCapabilitySettles()).toBe(true);
  const stored = JSON.parse(sessionStorage.getItem(CONFIRMED_GUI_SESSION_STORAGE_KEY) ?? "null");
  expect(stored).toEqual({
    version: 1,
    token: CONFIRMED_GUI_SESSION_TOKEN,
    csrfToken: CONFIRMED_GUI_SESSION_CSRF,
    origin: window.location.origin,
    expiresAt,
    confirmedLaunch: true,
  });

  // Model a module reload while preserving this tab's sessionStorage.
  resetApiAuthFetchForTests();
  await installMockAuthFetch(mockFetch);
  expect(isConfirmedGuiLaunch()).toBe(true);
  expect(await whenGuiLaunchCapabilitySettles()).toBe(true);
  expect(exchangeCalls).toBe(1);
  expect((await fetch("/api/config")).status).toBe(200);
  expect((await fetch("/api/settings", { method: "PUT", body: "{}" })).status).toBe(200);
  expect(seenApiRequests).toEqual([
    { key: CONFIRMED_GUI_SESSION_TOKEN, origin: window.location.origin, csrf: null },
    { key: CONFIRMED_GUI_SESSION_TOKEN, origin: window.location.origin, csrf: CONFIRMED_GUI_SESSION_CSRF },
  ]);
});

test("rehydration rejects and removes malformed, foreign, expired, or overlong session records", async () => {
  const valid = {
    version: 1,
    token: CONFIRMED_GUI_SESSION_TOKEN,
    csrfToken: CONFIRMED_GUI_SESSION_CSRF,
    origin: window.location.origin,
    expiresAt: Date.now() + 60_000,
    confirmedLaunch: true,
  };
  const invalidRecords: string[] = [
    "{not-json",
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, token: "ccx_session_short" }),
    JSON.stringify({ ...valid, csrfToken: "short" }),
    JSON.stringify({ ...valid, origin: "http://127.0.0.1" }),
    JSON.stringify({ ...valid, expiresAt: Date.now() - 1 }),
    JSON.stringify({ ...valid, expiresAt: Date.now() + (9 * 60 * 60_000) }),
    JSON.stringify({ ...valid, confirmedLaunch: false }),
    JSON.stringify({ ...valid, unexpected: true }),
  ];
  const seenApiKeys: Array<string | null> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenApiKeys.push(new Headers(init?.headers).get("X-CodexCommander-API-Key"));
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;

  for (const raw of invalidRecords) {
    resetApiAuthFetchForTests();
    sessionStorage.setItem(CONFIRMED_GUI_SESSION_STORAGE_KEY, raw);
    await installMockAuthFetch(mockFetch);
    expect(isConfirmedGuiLaunch()).toBe(false);
    expect((await fetch("/api/config")).status).toBe(401);
    expect(sessionStorage.getItem(CONFIRMED_GUI_SESSION_STORAGE_KEY)).toBeNull();
  }
  expect(seenApiKeys).toEqual(invalidRecords.map(() => null));
});

test("a 401 clears a rehydrated confirmed session and fails closed on loopback", async () => {
  sessionStorage.setItem(CONFIRMED_GUI_SESSION_STORAGE_KEY, JSON.stringify({
    version: 1,
    token: CONFIRMED_GUI_SESSION_TOKEN,
    csrfToken: CONFIRMED_GUI_SESSION_CSRF,
    origin: window.location.origin,
    expiresAt: Date.now() + 60_000,
    confirmedLaunch: true,
  }));
  const seenApiKeys: Array<string | null> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenApiKeys.push(new Headers(init?.headers).get("X-CodexCommander-API-Key"));
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect(isConfirmedGuiLaunch()).toBe(true);
  expect((await fetch("/api/config")).status).toBe(401);
  expect(seenApiKeys).toEqual([CONFIRMED_GUI_SESSION_TOKEN]);
  expect(isConfirmedGuiLaunch()).toBe(false);
  expect(sessionStorage.getItem(CONFIRMED_GUI_SESSION_STORAGE_KEY)).toBeNull();
});

test("an in-memory confirmed session expires before a later request and clears its stored record", async () => {
  const expiresAt = Date.now() + 60_000;
  sessionStorage.setItem(CONFIRMED_GUI_SESSION_STORAGE_KEY, JSON.stringify({
    version: 1,
    token: CONFIRMED_GUI_SESSION_TOKEN,
    csrfToken: CONFIRMED_GUI_SESSION_CSRF,
    origin: window.location.origin,
    expiresAt,
    confirmedLaunch: true,
  }));
  const seenApiKeys: Array<string | null> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenApiKeys.push(new Headers(init?.headers).get("X-CodexCommander-API-Key"));
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);
  expect(isConfirmedGuiLaunch()).toBe(true);

  const originalDateNow = Date.now;
  try {
    Date.now = () => expiresAt;
    expect((await fetch("/api/config")).status).toBe(401);
  } finally {
    Date.now = originalDateNow;
  }
  expect(seenApiKeys).toEqual([null]);
  expect(isConfirmedGuiLaunch()).toBe(false);
  expect(sessionStorage.getItem(CONFIRMED_GUI_SESSION_STORAGE_KEY)).toBeNull();
});

test("a successful fresh launch replaces an older stored session", async () => {
  const oldToken = `ccx_session_${"O".repeat(43)}`;
  sessionStorage.setItem(CONFIRMED_GUI_SESSION_STORAGE_KEY, JSON.stringify({
    version: 1,
    token: oldToken,
    csrfToken: "D".repeat(43),
    origin: window.location.origin,
    expiresAt: Date.now() + 60_000,
    confirmedLaunch: true,
  }));
  window.location.hash = `ccx-launch-ticket=ccx_launch_${"N".repeat(43)}&ccx-route=logs`;
  const seenApiKeys: Array<string | null> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname === "/api/gui-launch-exchange") {
      return Response.json({
        route: "logs",
        session: {
          token: CONFIRMED_GUI_SESSION_TOKEN,
          csrfToken: CONFIRMED_GUI_SESSION_CSRF,
          origin: window.location.origin,
          expiresAt: Date.now() + 120_000,
          confirmedLaunch: true,
        },
      });
    }
    seenApiKeys.push(new Headers(init?.headers).get("X-CodexCommander-API-Key"));
    return Response.json({ ok: true });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect(await whenGuiLaunchCapabilitySettles()).toBe(true);
  expect((await fetch("/api/config")).status).toBe(200);
  expect(seenApiKeys).toEqual([CONFIRMED_GUI_SESSION_TOKEN]);
  expect(JSON.parse(sessionStorage.getItem(CONFIRMED_GUI_SESSION_STORAGE_KEY) ?? "null").token)
    .toBe(CONFIRMED_GUI_SESSION_TOKEN);
});

test("a failed fresh launch falls back to an already-valid stored session", async () => {
  const storedToken = `ccx_session_${"F".repeat(43)}`;
  const storedCsrf = "G".repeat(43);
  const storedRecord = {
    version: 1,
    token: storedToken,
    csrfToken: storedCsrf,
    origin: window.location.origin,
    expiresAt: Date.now() + 60_000,
    confirmedLaunch: true,
  };
  sessionStorage.setItem(CONFIRMED_GUI_SESSION_STORAGE_KEY, JSON.stringify(storedRecord));
  window.location.hash = `ccx-launch-ticket=ccx_launch_${"X".repeat(43)}&ccx-route=logs`;
  let exchangeCalls = 0;
  const seenApiKeys: Array<string | null> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname === "/api/gui-launch-exchange") {
      exchangeCalls += 1;
      return new Response("expired", { status: 401 });
    }
    seenApiKeys.push(new Headers(init?.headers).get("X-CodexCommander-API-Key"));
    return Response.json({ ok: true });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect(await whenGuiLaunchCapabilitySettles()).toBe(true);
  expect(isConfirmedGuiLaunch()).toBe(true);
  expect((await fetch("/api/config")).status).toBe(200);
  expect(exchangeCalls).toBe(1);
  expect(seenApiKeys).toEqual([storedToken]);
  expect(JSON.parse(sessionStorage.getItem(CONFIRMED_GUI_SESSION_STORAGE_KEY) ?? "null"))
    .toEqual(storedRecord);
});

test("blocked sessionStorage falls back to a memory-only confirmed session", async () => {
  const blockedStorage = {
    getItem(): string | null { throw new Error("blocked"); },
    setItem(): void { throw new Error("blocked"); },
    removeItem(): void { throw new Error("blocked"); },
    clear(): void { throw new Error("blocked"); },
    key(): string | null { return null; },
    length: 0,
  } satisfies Storage;
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: blockedStorage });
  window.location.hash = `ccx-launch-ticket=ccx_launch_${"B".repeat(43)}&ccx-route=dashboard`;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname === "/api/gui-launch-exchange") {
      return Response.json({
        route: "dashboard",
        session: {
          token: CONFIRMED_GUI_SESSION_TOKEN,
          csrfToken: CONFIRMED_GUI_SESSION_CSRF,
          origin: window.location.origin,
          expiresAt: Date.now() + 60_000,
          confirmedLaunch: true,
        },
      });
    }
    const key = new Headers(init?.headers).get("X-CodexCommander-API-Key");
    return new Response("{}", { status: key === CONFIRMED_GUI_SESSION_TOKEN ? 200 : 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect(await whenGuiLaunchCapabilitySettles()).toBe(true);
  expect(isConfirmedGuiLaunch()).toBe(true);
  expect((await fetch("/api/config")).status).toBe(200);
});

test("validates prompted tokens with a safe read before retrying the failed request", async () => {
  useRemoteOperatorOrigin();
  const validationResults: string[] = [];
  const seenRequests: Array<[string, string | null]> = [];
  resetApiAuthFetchForTests(async (verifyToken) => {
    validationResults.push(await verifyToken("wrong-token"));
    validationResults.push(await verifyToken("fresh-token"));
    return "fresh-token";
  });

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost/");
    const key = new Headers(init?.headers).get("X-CodexCommander-API-Key");
    seenRequests.push([url.pathname, key]);
    if (url.pathname === "/api/settings" && key === "fresh-token") {
      return new Response("{}", { status: 200 });
    }
    if (url.pathname === "/api/config" && key === "fresh-token") {
      return new Response("{}", { status: 200 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(200);
  expect(validationResults).toEqual(["rejected", "accepted"]);
  expect(seenRequests).toContainEqual(["/api/settings", "wrong-token"]);
  expect(seenRequests).toContainEqual(["/api/settings", "fresh-token"]);
  expect(seenRequests).not.toContainEqual(["/api/config", "wrong-token"]);
  expect(sessionStorage.length).toBe(0);
});

test("cross-origin /api/* requests do not receive the API key or token prompt", async () => {
  useRemoteOperatorOrigin();
  let promptCalls = 0;
  let phase: "seed" | "cross" = "seed";
  const seenHeaders: Array<string | null> = [];
  const stateful = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(headers.get("X-CodexCommander-API-Key"));
    if (phase === "seed") {
      if (headers.get("X-CodexCommander-API-Key") === "local-token") return new Response("{}", { status: 200 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "local-token";
  };
  await installMockAuthFetch(stateful);

  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(1);

  phase = "cross";
  const beforeCrossPrompts = promptCalls;
  seenHeaders.length = 0;
  const cross = await fetch("https://evil.example/api/config");
  expect(cross.status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(beforeCrossPrompts);
});

test("concurrent 401s share one token prompt and all retry with the stored token", async () => {
  useRemoteOperatorOrigin();
  // Repro for #647: many /api/* requests start without a token (dashboard fan-out).
  // Delivering 401s one-by-one after each auth cycle finishes matches the browser case where
  // window.prompt blocks the main thread: each continuation still holds a captured null token
  // and must reuse the in-memory token from an earlier request instead of prompting again.
  let promptCalls = 0;
  const release401: Array<() => void> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("X-CodexCommander-API-Key") === "shared-token") {
      return new Response("{}", { status: 200 });
    }
    await new Promise<void>((resolve) => {
      release401.push(resolve);
    });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "shared-token";
  };
  await installMockAuthFetch(mockFetch);

  const endpoints = [
    "/api/config",
    "/api/providers",
    "/api/models",
    "/api/selected-models",
    "/api/disabled-models",
    "/api/effort-caps",
    "/api/sidecar-settings",
    "/api/injection-model",
    "/api/v2",
    "/api/keys",
    "/api/provider-presets",
    "/api/key-providers",
    "/api/oauth/providers",
    "/api/codex-auth/accounts",
  ];
  const pending = endpoints.map((path) => fetch(path).then((r) => r.status));
  // Let every request reach the 401 gate before any response is delivered.
  for (let i = 0; i < 20 && release401.length < endpoints.length; i += 1) {
    await Promise.resolve();
  }
  expect(release401.length).toBe(endpoints.length);

  for (let i = 0; i < endpoints.length; i += 1) {
    const done = pending[i]!;
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    release401.shift()!();
    for (let spin = 0; spin < 50 && !settled; spin += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
  }

  const statuses = await Promise.all(pending);
  expect(promptCalls).toBe(1);
  expect([...new Set(statuses)]).toEqual([200]);
});

test("stale concurrent 401 does not clear a token refreshed by another request", async () => {
  useRemoteOperatorOrigin();
  // Codex/CodeRabbit race: request A prompts and stores T2; request B still holding stale T1
  // must not wipe T2 (clearTokenIfCurrent) before its re-read / shared gate join.
  let promptCalls = 0;
  let acceptV1 = true;
  const release401: Array<() => void> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const key = headers.get("X-CodexCommander-API-Key");
    if (key === "token-v2") return new Response("{}", { status: 200 });
    if (acceptV1 && key === "token-v1") return new Response("{}", { status: 200 });
    if (key === "token-v1") {
      await new Promise<void>((resolve) => {
        release401.push(resolve);
      });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "token-v1";
  };
  await installMockAuthFetch(mockFetch);
  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(1);

  acceptV1 = false;
  promptCalls = 0;
  window.prompt = () => {
    promptCalls += 1;
    return "token-v2";
  };

  const pending = [fetch("/api/config"), fetch("/api/providers")].map((p) => p.then((r) => r.status));
  for (let i = 0; i < 20 && release401.length < 2; i += 1) {
    await Promise.resolve();
  }
  expect(release401.length).toBe(2);

  for (let i = 0; i < 2; i += 1) {
    const done = pending[i]!;
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    release401.shift()!();
    for (let spin = 0; spin < 50 && !settled; spin += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
  }

  const statuses = await Promise.all(pending);
  expect(promptCalls).toBe(1);
  expect([...new Set(statuses)]).toEqual([200]);
});

test("canceling the token prompt once does not reopen it for the rest of the 401 fan-out", async () => {
  useRemoteOperatorOrigin();
  let promptCalls = 0;
  const release401: Array<() => void> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("X-CodexCommander-API-Key")) {
      return new Response("{}", { status: 200 });
    }
    await new Promise<void>((resolve) => {
      release401.push(resolve);
    });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return null;
  };
  await installMockAuthFetch(mockFetch);

  const endpoints = ["/api/config", "/api/providers", "/api/models", "/api/keys"];
  const pending = endpoints.map((path) => fetch(path).then((r) => r.status));
  for (let i = 0; i < 20 && release401.length < endpoints.length; i += 1) {
    await Promise.resolve();
  }
  expect(release401.length).toBe(endpoints.length);

  for (let i = 0; i < endpoints.length; i += 1) {
    const done = pending[i]!;
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    release401.shift()!();
    for (let spin = 0; spin < 50 && !settled; spin += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
  }

  const statuses = await Promise.all(pending);
  expect(promptCalls).toBe(1);
  expect([...new Set(statuses)]).toEqual([401]);
});

test("data-plane requests never receive the management token or prompt", async () => {
  let promptCalls = 0;
  let phase: "seed" | "cross" = "seed";
  const seenHeaders: Array<string | null> = [];
  const stateful = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(headers.get("X-CodexCommander-API-Key"));
    if (phase === "seed") {
      if (headers.get("X-CodexCommander-API-Key") === "local-token") return new Response("{}", { status: 200 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "local-token";
  };
  await installMockAuthFetch(stateful);

  expect((await fetch("/v1/models")).status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(0);

  phase = "cross";
  const beforeCrossPrompts = promptCalls;
  seenHeaders.length = 0;
  const cross = await fetch("https://evil.example/v1/models");
  expect(cross.status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(beforeCrossPrompts);
});

test("an expired confirmed loopback session fails closed and requires relaunch", async () => {
  const launchTicket = `ccx_launch_${"A".repeat(43)}`;
  window.location.hash = `ccx-launch-ticket=${launchTicket}&ccx-route=dashboard`;
  let promptCalls = 0;
  let exchangeCalls = 0;
  const seenApiKeys: Array<string | null> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "http://localhost/");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.pathname === "/api/gui-launch-exchange") {
      exchangeCalls += 1;
      return Response.json({
        route: "dashboard",
        session: {
          token: `ccx_session_${"E".repeat(43)}`,
          csrfToken: "E".repeat(43),
          origin: "http://localhost",
          expiresAt: Date.now() - 1,
          confirmedLaunch: true,
        },
      });
    }
    seenApiKeys.push(headers.get("X-CodexCommander-API-Key"));
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "manual-admin-token";
  };
  await installMockAuthFetch(mockFetch);

  const res = await fetch("/api/config");
  expect(res.status).toBe(401);
  expect(promptCalls).toBe(0);
  expect(exchangeCalls).toBe(1);
  expect(seenApiKeys).toEqual([null]);
  expect(isConfirmedGuiLaunch()).toBe(false);
});

test("a launch exchange session for another origin is rejected without a loopback token prompt", async () => {
  window.location.hash = `ccx-launch-ticket=ccx_launch_${"B".repeat(43)}&ccx-route=dashboard`;
  let promptCalls = 0;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "http://localhost/");
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/gui-launch-exchange") {
      return Response.json({
        route: "dashboard",
        session: {
          token: `ccx_session_${"F".repeat(43)}`,
          csrfToken: "F".repeat(43),
          origin: "http://192.0.2.10:10100",
          expiresAt: Date.now() + 60_000,
          confirmedLaunch: true,
        },
      });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "manual-admin-token";
  };
  await installMockAuthFetch(mockFetch);

  const res = await fetch("/api/config");
  expect(res.status).toBe(401);
  expect(promptCalls).toBe(0);
  expect(isConfirmedGuiLaunch()).toBe(false);
});

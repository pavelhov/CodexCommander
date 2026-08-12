import { afterEach, describe, expect, test } from "bun:test";
import {
  installApiAuthFetch,
  isConfirmedGuiLaunch,
  resetApiAuthFetchForTests,
  whenGuiLaunchCapabilitySettles,
} from "../gui/src/api";

const originalWindow = globalThis.window;
const originalSessionStorage = globalThis.sessionStorage;
const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
  resetApiAuthFetchForTests();
  Object.assign(globalThis, {
    window: originalWindow,
    sessionStorage: originalSessionStorage,
    localStorage: originalLocalStorage,
  });
});

describe("GUI confirmed launch exchange", () => {
  test("scrubs the ticket, stores only the confirmed session per tab, and leaves data requests untouched", async () => {
    const ticket = `ccx_launch_${"A".repeat(43)}`;
    const sessionToken = `ccx_session_${"S".repeat(43)}`;
    const csrfToken = "C".repeat(43);
    const expiresAt = Date.now() + 60_000;
    const location = new URL(`http://localhost:10100/#ccx-launch-ticket=${ticket}&ccx-route=subagents`);
    const seen: Array<{ url: string; method: string; headers: Headers; body?: BodyInit | null; hash: string }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen.push({
        url: input instanceof Request ? input.url : String(input),
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
        body: init?.body,
        hash: location.hash,
      });
      if (String(input) === "/api/gui-launch-exchange") {
        return Response.json({
          route: "subagents",
          session: {
            token: sessionToken,
            csrfToken,
            origin: "http://localhost:10100",
            expiresAt,
            confirmedLaunch: true,
          },
        });
      }
      return Response.json({ ok: true });
    };
    const sessionValues = new Map<string, string>();
    let localStorageWrites = 0;
    const localStorage = {
      getItem: () => null,
      setItem: () => { localStorageWrites += 1; },
      removeItem: () => { localStorageWrites += 1; },
    };
    const sessionStorage = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
      removeItem: (key: string) => { sessionValues.delete(key); },
    };
    Object.assign(globalThis, {
      localStorage,
      sessionStorage,
      window: {
        location,
        sessionStorage,
        history: {
          state: null,
          replaceState(_state: unknown, _title: string, next: string) {
            location.href = new URL(next, location).href;
          },
        },
        fetch: fetchImpl,
        prompt: () => null,
      },
    });

    installApiAuthFetch();
    expect(location.hash).toBe("#subagents");
    expect(await whenGuiLaunchCapabilitySettles()).toBe(true);
    expect(isConfirmedGuiLaunch()).toBe(true);
    await window.fetch("/api/config");
    await window.fetch("/api/settings", { method: "PUT", body: "{}" });
    await window.fetch("/v1/models");

    expect(seen).toHaveLength(4);
    expect(seen[0]?.url).toBe("/api/gui-launch-exchange");
    expect(seen[0]?.hash).toBe("#subagents");
    expect(seen[0]?.headers.get("x-codexcommander-api-key")).toBeNull();
    expect(JSON.parse(String(seen[0]?.body))).toEqual({ ticket, route: "subagents" });
    expect(seen[1]?.headers.get("x-codexcommander-api-key")).toBe(sessionToken);
    expect(seen[1]?.headers.get("x-codexcommander-gui-origin")).toBe("http://localhost:10100");
    expect(seen[1]?.headers.get("x-codexcommander-csrf-token")).toBeNull();
    expect(seen[2]?.headers.get("x-codexcommander-api-key")).toBe(sessionToken);
    expect(seen[2]?.headers.get("x-codexcommander-csrf-token")).toBe(csrfToken);
    expect(seen[3]?.headers.get("x-codexcommander-api-key")).toBeNull();
    expect(seen[3]?.headers.get("x-codexcommander-gui-origin")).toBeNull();
    expect(localStorageWrites).toBe(0);
    expect([...sessionValues.values()].map(value => JSON.parse(value))).toEqual([{
      version: 1,
      token: sessionToken,
      csrfToken,
      origin: "http://localhost:10100",
      expiresAt,
      confirmedLaunch: true,
    }]);
  });
});

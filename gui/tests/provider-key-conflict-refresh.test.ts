import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { type ApiKeyEntry, useProviderAccountPools } from "../src/hooks/useProviderAccountPools";

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
const staleKeys: ApiKeyEntry[] = [
  { id: "stale-active", masked: "…stale", active: true },
  { id: "stale-inactive", masked: "…other", active: false },
];
const freshKeys: ApiKeyEntry[] = [
  { id: "fresh-active", masked: "…fresh", active: true },
  { id: "fresh-inactive", masked: "…new", active: false },
];

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let switchKey: (() => Promise<void>) | null = null;
let snapshot: { keys: ApiKeyEntry[]; revision: number | undefined } | null = null;
let notifications: Array<{ message: string; ok: boolean | undefined }> = [];

function HookHarness() {
  const aliveRef = useRef(true);
  const pools = useProviderAccountPools({
    apiBase: "http://localhost:10100",
    t: key => key,
    config: {
      port: 10100,
      defaultProvider: "xai",
      providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", hasApiKey: true } },
    },
    oauthStatus: {},
    aliveRef,
    notify: (message, ok) => { notifications.push({ message, ok }); },
    fetchConfig: async () => {},
    fetchOauth: async () => {},
    fetchProviderQuotas: async () => {},
    codexActiveNeedsReauth: false,
  });
  useEffect(() => {
    snapshot = { keys: pools.keyPools.xai ?? [], revision: pools.keyPoolRevisions.xai };
    switchKey = () => pools.switchApiKey("xai", staleKeys[1]!);
  });
  return null;
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = null;
  switchKey = null;
  snapshot = null;
  notifications = [];
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => { current.unmount(); });
  }
  await testWindow.happyDOM.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountStalePool(refresh: () => Response): Promise<{ mutation: Record<string, unknown> | null; getCalls: () => number }> {
  let mutation: Record<string, unknown> | null = null;
  let keyGets = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/providers/keys" && (!init?.method || init.method === "GET")) {
        keyGets += 1;
        return keyGets === 1
          ? Response.json({ revision: 7, keys: staleKeys })
          : refresh();
      }
      if (url.pathname === "/api/providers/keys/active" && init?.method === "PUT") {
        mutation = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ error: "stale xAI key pool revision" }, { status: 409 });
      }
      return Response.json({});
    },
  });
  await act(async () => {
    root = createRoot(testWindow.document.createElement("div") as unknown as HTMLElement);
    root.render(createElement(HookHarness));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(snapshot).toEqual({ keys: staleKeys, revision: 7 });
  return { get mutation() { return mutation; }, getCalls: () => keyGets };
}

test("xAI stale key mutation refreshes canonical keys and revision before reporting the conflict", async () => {
  const observed = await mountStalePool(() => Response.json({ revision: 8, keys: freshKeys }));

  await act(async () => {
    await switchKey?.();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(observed.mutation).toEqual({ name: "xai", id: "stale-inactive", expectedRevision: 7 });
  expect(observed.getCalls()).toBe(2);
  expect(snapshot).toEqual({ keys: freshKeys, revision: 8 });
  expect(notifications).toEqual([{ message: "stale xAI key pool revision", ok: false }]);
});

test("a failed xAI stale-state refresh keeps the last known-good keys and revision", async () => {
  const observed = await mountStalePool(() => Response.json({ error: "unavailable" }, { status: 503 }));

  await act(async () => {
    await switchKey?.();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(observed.getCalls()).toBe(2);
  expect(snapshot).toEqual({ keys: staleKeys, revision: 7 });
  expect(notifications).toEqual([{ message: "stale xAI key pool revision", ok: false }]);
});

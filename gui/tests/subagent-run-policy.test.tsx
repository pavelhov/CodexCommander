import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Window } from "happy-dom";
import { useSubagentRunPolicy, type SubagentRunPolicy } from "../src/pages/use-subagent-run-policy";

/**
 * The hook drafts changes against a committed server snapshot and saves per
 * endpoint group. These tests pin the load/dirty/save contract, including the
 * partial-failure path where a failed group keeps its draft while a successful
 * group reconciles from the re-read.
 */

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

type FetchCall = { url: string; method: string; body?: Record<string, unknown> };

const serverState = {
  v2: { enabled: true, multiAgentMode: "default", maxConcurrentThreadsPerSession: null as number | null },
  fallback: { models: ["gpt-5"], pollMs: 60_000, available: ["gpt-5", "gpt-5-mini"] },
  effortCaps: { effortCap: null as string | null, subagentEffortCap: "low" as string | null, efforts: ["low", "medium", "high"] },
};

let calls: FetchCall[] = [];
let failFallbackPut = false;

function installFetch() {
  calls = [];
  failFallbackPut = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });

    if (url.endsWith("/api/v2")) {
      if (method === "PUT") {
        if (body && typeof body.multiAgentMode === "string") serverState.v2.multiAgentMode = body.multiAgentMode;
        if (body && "maxConcurrentThreadsPerSession" in body
            && (body.maxConcurrentThreadsPerSession === null || typeof body.maxConcurrentThreadsPerSession === "number")) {
          serverState.v2.maxConcurrentThreadsPerSession = body.maxConcurrentThreadsPerSession;
        }
        return Response.json({ ok: true, ...serverState.v2 });
      }
      return Response.json(serverState.v2);
    }
    if (url.endsWith("/api/subagent-model-fallback")) {
      if (method === "PUT") {
        if (failFallbackPut) return Response.json({ error: "fallback store unavailable" }, { status: 500 });
        if (body && Array.isArray(body.models)) serverState.fallback.models = body.models as string[];
        if (body && typeof body.pollMs === "number") serverState.fallback.pollMs = body.pollMs;
        return Response.json({ ok: true, models: serverState.fallback.models, pollMs: serverState.fallback.pollMs });
      }
      return Response.json(serverState.fallback);
    }
    if (url.endsWith("/api/effort-caps")) {
      if (method === "PUT") {
        if (body && "effortCap" in body) serverState.effortCaps.effortCap = body.effortCap as string | null;
        if (body && "subagentEffortCap" in body) serverState.effortCaps.subagentEffortCap = body.subagentEffortCap as string | null;
        return Response.json({ ok: true, effortCap: serverState.effortCaps.effortCap, subagentEffortCap: serverState.effortCaps.subagentEffortCap });
      }
      return Response.json(serverState.effortCaps);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
}

function resetServerState() {
  serverState.v2 = { enabled: true, multiAgentMode: "default", maxConcurrentThreadsPerSession: null };
  serverState.fallback = { models: ["gpt-5"], pollMs: 60_000, available: ["gpt-5", "gpt-5-mini"] };
  serverState.effortCaps = { effortCap: null, subagentEffortCap: "low", efforts: ["low", "medium", "high"] };
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
  resetServerState();
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const API_BASE = "http://localhost";

async function mountPolicy(): Promise<{ root: Root; ref: { current: SubagentRunPolicy | null } }> {
  const ref: { current: SubagentRunPolicy | null } = { current: null };
  function Probe() {
    ref.current = useSubagentRunPolicy(API_BASE);
    return null;
  }
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(host as never);
    root.render(<Probe />);
  });
  // Flush the initial load effect and its fetch promises.
  await act(async () => { await Promise.resolve(); });
  return { root, ref };
}

function hook(ref: { current: SubagentRunPolicy | null }): SubagentRunPolicy {
  if (!ref.current) throw new Error("hook not mounted");
  return ref.current;
}

function puts(): FetchCall[] {
  return calls.filter(c => c.method === "PUT");
}

test("loads the initial policy from all three endpoints", async () => {
  const { root, ref } = await mountPolicy();
  const h = hook(ref);
  expect(h.loaded).toBe(true);
  expect(h.loading).toBe(false);
  expect(h.error).toBeNull();
  expect(h.mode).toBe("default");
  expect(h.concurrency).toBeNull();
  expect(h.fallbackModels).toEqual(["gpt-5"]);
  expect(h.fallbackAvailable).toEqual(["gpt-5", "gpt-5-mini"]);
  expect(h.pollMs).toBe(60_000);
  expect(h.effortCap).toBeNull();
  expect(h.subagentEffortCap).toBe("low");
  expect(h.efforts).toEqual(["low", "medium", "high"]);
  expect(h.dirty).toBe(false);

  const gets = calls.filter(c => c.method === "GET").map(c => c.url);
  expect(gets).toContain(`${API_BASE}/api/v2`);
  expect(gets).toContain(`${API_BASE}/api/subagent-model-fallback`);
  expect(gets).toContain(`${API_BASE}/api/effort-caps`);

  await act(async () => { root.unmount(); });
});

test("tracks dirty state as drafts change and revert", async () => {
  const { root, ref } = await mountPolicy();
  expect(hook(ref).dirty).toBe(false);

  act(() => { hook(ref).setMode("v2"); });
  expect(hook(ref).dirty).toBe(true);

  act(() => { hook(ref).setPollMs(30_000); });
  expect(hook(ref).dirty).toBe(true);

  act(() => {
    hook(ref).setMode("default");
    hook(ref).setPollMs(60_000);
  });
  expect(hook(ref).dirty).toBe(false);

  await act(async () => { root.unmount(); });
});

test("keeps the classic v1 and concurrent v2 protocol values intact", async () => {
  const { root, ref } = await mountPolicy();
  act(() => { hook(ref).setMode("v1"); });
  calls = [];
  await act(async () => { expect(await hook(ref).save()).toBe(true); });
  expect(puts().find(call => call.url.endsWith("/api/v2"))?.body).toEqual({ multiAgentMode: "v1" });

  act(() => { hook(ref).setMode("v2"); });
  calls = [];
  await act(async () => { expect(await hook(ref).save()).toBe(true); });
  expect(puts().find(call => call.url.endsWith("/api/v2"))?.body).toEqual({ multiAgentMode: "v2" });

  await act(async () => { root.unmount(); });
});

test("save with no changes emits no PUT and reports success", async () => {
  const { root, ref } = await mountPolicy();
  calls = [];

  let result: boolean | undefined;
  await act(async () => {
    result = await hook(ref).save();
  });
  expect(result).toBe(true);
  expect(puts()).toEqual([]);
  expect(hook(ref).error).toBeNull();
  expect(hook(ref).saving).toBe(false);

  await act(async () => { root.unmount(); });
});

test("save sends one PUT per changed group with only the changed fields", async () => {
  const { root, ref } = await mountPolicy();
  act(() => {
    hook(ref).setMode("v2");
    hook(ref).setPollMs(30_000);
    hook(ref).setEffortCap("high");
  });
  calls = [];

  let result: boolean | undefined;
  await act(async () => {
    result = await hook(ref).save();
  });
  expect(result).toBe(true);

  const sent = puts();
  expect(sent).toHaveLength(3);
  const byUrl = new Map(sent.map(c => [c.url, c.body]));
  // Concurrency did not change, so it must not ride along in the /api/v2 body.
  expect(byUrl.get(`${API_BASE}/api/v2`)).toEqual({ multiAgentMode: "v2" });
  // models did not change, so only pollMs is sent to the fallback endpoint.
  expect(byUrl.get(`${API_BASE}/api/subagent-model-fallback`)).toEqual({ pollMs: 30_000 });
  expect(byUrl.get(`${API_BASE}/api/effort-caps`)).toEqual({ effortCap: "high" });

  // Successful save reconciles from the re-read: drafts match the server now.
  const h = hook(ref);
  expect(h.error).toBeNull();
  expect(h.dirty).toBe(false);
  expect(h.mode).toBe("v2");
  expect(h.pollMs).toBe(30_000);
  expect(h.effortCap).toBe("high");

  await act(async () => { root.unmount(); });
});

test("explicit null clears a configured concurrency limit", async () => {
  serverState.v2.maxConcurrentThreadsPerSession = 8;
  const { root, ref } = await mountPolicy();
  expect(hook(ref).concurrency).toBe(8);

  act(() => { hook(ref).setConcurrency(null); });
  calls = [];
  let result: boolean | undefined;
  await act(async () => { result = await hook(ref).save(); });

  expect(result).toBe(true);
  expect(puts().find(call => call.url.endsWith("/api/v2"))?.body).toEqual({ maxConcurrentThreadsPerSession: null });
  expect(hook(ref).concurrency).toBeNull();
  expect(hook(ref).dirty).toBe(false);

  await act(async () => { root.unmount(); });
});

test("partial failure sets error, keeps the failed group's draft, reconciles the rest", async () => {
  const { root, ref } = await mountPolicy();
  failFallbackPut = true;
  act(() => {
    hook(ref).setMode("v2");
    hook(ref).setPollMs(30_000);
  });
  calls = [];

  let result: boolean | undefined;
  await act(async () => {
    result = await hook(ref).save();
  });

  // Never claim success when any request failed.
  expect(result).toBe(false);
  const h = hook(ref);
  expect(h.error).toContain("fallback");
  expect(h.error).toContain("fallback store unavailable");

  // Both groups were attempted.
  const sentUrls = puts().map(c => c.url);
  expect(sentUrls).toContain(`${API_BASE}/api/v2`);
  expect(sentUrls).toContain(`${API_BASE}/api/subagent-model-fallback`);

  // The successful v2 group reconciled against the re-read server state.
  expect(h.mode).toBe("v2");
  // The failed fallback group keeps the unsaved draft instead of the server's
  // unchanged value, so the user can retry without re-entering it.
  expect(h.pollMs).toBe(30_000);
  expect(h.dirty).toBe(true);
  expect(h.saving).toBe(false);

  await act(async () => { root.unmount(); });
});

test("locally invalid pollMs never reaches the wire", async () => {
  const { root, ref } = await mountPolicy();
  act(() => { hook(ref).setPollMs(100); });
  calls = [];

  let result: boolean | undefined;
  await act(async () => {
    result = await hook(ref).save();
  });
  expect(result).toBe(false);
  expect(puts().filter(c => c.url.endsWith("/api/subagent-model-fallback"))).toEqual([]);
  expect(hook(ref).error).toContain("fallback");
  expect(hook(ref).dirty).toBe(true);

  await act(async () => { root.unmount(); });
});

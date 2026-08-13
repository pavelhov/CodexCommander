import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { readSessionListCache, writeSessionListCache } from "../src/session-list-cache";
import Usage from "../src/pages/Usage";
import type { UsageReport } from "../src/usage-report-validation";

/**
 * Phase 1b contract: the Usage page only ever caches validated successful reports.
 * Error envelopes and malformed summaries are rejected before any persistence, a
 * defined zero cost renders $0.00 (only a genuinely missing legacy field shows
 * "Unavailable"), a cold failure shows the failed-cold Notice with retry, and a
 * failed refresh keeps last-known-good data with the stale/error banner.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

function summary(overrides: Partial<UsageReport["summary"]> = {}) {
  return {
    requests: 0,
    measuredRequests: 0,
    reportedRequests: 0,
    unreportedRequests: 0,
    unsupportedRequests: 0,
    estimatedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    coverageRatio: 1,
    estimatedCostUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    unmeteredRequests: 0,
    ...overrides,
  };
}

function validReport(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    range: "30d",
    surface: "all",
    since: null,
    generatedAt: 1,
    summary: summary(),
    days: [],
    models: [],
    providers: [],
    historyTruncated: false,
    truncatedPrefixBytes: 0,
    entriesTruncated: false,
    entriesDropped: 0,
    ...overrides,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow.sessionStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function renderUsage(apiBase: string): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <Usage apiBase={apiBase} />
      </LanguageProvider>,
    );
  });
  return { container, root };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

test("cost row renders $0.00 for a defined zero", async () => {
  globalThis.fetch = (async () =>
    Response.json(validReport({ summary: summary({ requests: 3, estimatedCostUsd: 0 }) }))) as typeof fetch;
  const { container, root } = await renderUsage("http://usage-zero");
  try {
    await waitFor(() => (container.textContent ?? "").includes("$0.00"));
    expect(container.textContent).toContain("$0.00");
    expect(container.textContent).not.toContain("Unavailable");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("legacy undefined cost field renders Unavailable", async () => {
  const legacy = validReport({ summary: summary({ requests: 3 }) });
  // Simulate a pre-validation session-cache seed from an older server: no cost fields.
  const { estimatedCostUsd: _cost, pricedRequests: _priced, unpricedRequests: _unpriced, unmeteredRequests: _unmetered, ...legacySummary } = legacy.summary;
  const legacyReport = { ...legacy, summary: legacySummary };
  writeSessionListCache("ccx.usage.v1:http://usage-legacy:30d:all", legacyReport);
  // The revalidation also answers with the legacy shape, so it is rejected and the
  // seeded last-known-good payload (with undefined cost) stays on screen.
  globalThis.fetch = (async () => Response.json(legacyReport)) as typeof fetch;

  const { container, root } = await renderUsage("http://usage-legacy");
  try {
    await waitFor(() => (container.textContent ?? "").includes("Unavailable"));
    expect(container.textContent).toContain("Unavailable");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a 200 response with an error envelope is rejected and never cached", async () => {
  const key = "ccx.usage.v1:http://usage-error-envelope:30d:all";
  globalThis.fetch = (async () =>
    Response.json({ error: "read_failed", range: "30d", surface: "all" })) as typeof fetch;

  const { container, root } = await renderUsage("http://usage-error-envelope");
  try {
    await waitFor(() => (container.textContent ?? "").includes("Retry"));
    expect(container.textContent).toContain("Retry");
    expect(readSessionListCache(key)).toBeNull();
    expect(testWindow.sessionStorage.getItem(key)).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("401 cold failure shows the failed-cold Notice with retry", async () => {
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;

  const { container, root } = await renderUsage("http://usage-401");
  try {
    await waitFor(() => (container.textContent ?? "").includes("Retry"));
    expect(container.textContent).toContain("Retry");
    expect(container.querySelector("button")).not.toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("refresh failure retains last-good data and shows the stale/error banner", async () => {
  const key = "ccx.usage.v1:http://usage-stale:30d:all";
  const good = validReport({ summary: summary({ requests: 42, totalTokens: 9000, estimatedCostUsd: 1.25 }) });
  // Last-known-good payload is seeded from the session cache; the quiet revalidation fails.
  writeSessionListCache(key, good);
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

  const { container, root } = await renderUsage("http://usage-stale");
  try {
    await waitFor(() => (container.textContent ?? "").includes("42"));
    expect(container.textContent).toContain("42");
    // The stale/error banner appears next to the retained data.
    await waitFor(() => (container.textContent ?? "").includes("Could not load usage data"));
    expect(container.textContent).toContain("Could not load usage data");
    // The failed refresh must not have wiped the held cache.
    expect(readSessionListCache(key)).not.toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

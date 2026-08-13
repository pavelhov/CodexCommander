import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * Store-level contract for the usage-report domain store: key derivation, singleflight
 * dedupe, AbortController cancellation, and persistence of validated reports only.
 *
 * sessionStorage is installed BEFORE the store module is imported so zustand persist
 * captures it (Bun isolates module registries per test file).
 */
const testWindow = new Window({ url: "http://localhost/" });
Object.defineProperties(globalThis, {
  document: { configurable: true, value: testWindow.document },
  window: { configurable: true, value: testWindow },
  navigator: { configurable: true, value: testWindow.navigator },
  sessionStorage: { configurable: true, value: testWindow.sessionStorage },
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  clearUsageReportStoresForTests,
  usageReportKey,
  useUsageReportStore,
  USAGE_REPORT_STORAGE_NAME,
} = await import("../src/usage-report-store");

type UsageReport = import("../src/usage-report-validation").UsageReport;

function validReport(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    range: "30d",
    surface: "all",
    since: null,
    generatedAt: 1,
    summary: {
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
    },
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
  clearUsageReportStoresForTests();
  testWindow.sessionStorage.clear();
});

afterEach(() => {
  clearUsageReportStoresForTests();
  globalThis.fetch = undefined as unknown as typeof fetch;
});

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

test("usage report key derives from apiBase/range/surface", () => {
  expect(usageReportKey("http://localhost:1234", "30d", "all")).toBe("http://localhost:1234:30d:all");
  expect(usageReportKey("http://x", "7d", "codex")).toBe("http://x:7d:codex");
});

test("singleflight dedupes concurrent subscribers into one fetch", async () => {
  let calls = 0;
  const gates: Array<() => void> = [];
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise<void>(resolve => gates.push(resolve));
    return Response.json(validReport());
  }) as typeof fetch;

  const key = usageReportKey("http://sf", "30d", "all");
  useUsageReportStore.getState().ensure(key, "http://sf", "30d", "all");
  useUsageReportStore.getState().ensure(key, "http://sf", "30d", "all");
  useUsageReportStore.getState().ensure(key, "http://sf", "30d", "all");
  expect(calls).toBe(1);

  gates[0]!();
  await flush();
  expect(useUsageReportStore.getState().entries[key]?.data).toBeDefined();
  expect(useUsageReportStore.getState().entries[key]?.hasSucceeded).toBe(true);
});

test("refresh aborts the previous in-flight request for the same key", async () => {
  let aborted = false;
  const gates: Array<() => void> = [];
  globalThis.fetch = (async (_input, init) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; });
    await new Promise<void>(resolve => gates.push(resolve));
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return Response.json(validReport());
  }) as typeof fetch;

  const key = usageReportKey("http://abort", "30d", "all");
  useUsageReportStore.getState().ensure(key, "http://abort", "30d", "all");
  useUsageReportStore.getState().refresh(key, "http://abort", "30d", "all");
  expect(aborted).toBe(true);

  gates[0]!();
  gates[1]!();
  await flush();
  expect(useUsageReportStore.getState().entries[key]?.data).toBeDefined();
});

test("persists only validated successful reports with a timestamp", async () => {
  // An error envelope must never reach the persisted slice.
  globalThis.fetch = (async () =>
    Response.json({ error: "read_failed", range: "30d", surface: "all" })) as typeof fetch;
  const key = usageReportKey("http://persist", "30d", "all");
  useUsageReportStore.getState().ensure(key, "http://persist", "30d", "all");
  await flush();
  let parsed = JSON.parse(testWindow.sessionStorage.getItem(USAGE_REPORT_STORAGE_NAME) ?? "{}");
  expect(parsed.state?.entries?.[key]).toBeUndefined();
  expect(useUsageReportStore.getState().entries[key]?.data).toBeUndefined();

  // A validated success is persisted as data + timestamp only.
  globalThis.fetch = (async () => Response.json(validReport())) as typeof fetch;
  useUsageReportStore.getState().refresh(key, "http://persist", "30d", "all");
  await flush();
  parsed = JSON.parse(testWindow.sessionStorage.getItem(USAGE_REPORT_STORAGE_NAME) ?? "{}");
  const persisted = parsed.state?.entries?.[key];
  expect(persisted?.data).toBeDefined();
  expect(typeof persisted?.persistedAt).toBe("number");
  // Never errors or in-flight flags in the persisted slice.
  expect(persisted).not.toHaveProperty("error");
  expect(persisted).not.toHaveProperty("loading");
  expect(persisted).not.toHaveProperty("refreshing");
});

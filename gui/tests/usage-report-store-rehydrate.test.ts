import { expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * Rehydration contract for the usage-report store: sessionStorage seeds become store
 * entries marked `seedNeedsRevalidate`, and the first subscriber quiet-revalidates
 * (exactly one fetch) without ever blanking the seeded data.
 *
 * The store module may already be loaded by another test file (Bun shares the module
 * registry within one run), so the seed is written and `rehydrateUsageReportForTests`
 * is invoked explicitly instead of relying on creation-time hydration.
 */
const testWindow = new Window({ url: "http://localhost/" });
Object.defineProperties(globalThis, {
  document: { configurable: true, value: testWindow.document },
  window: { configurable: true, value: testWindow },
  navigator: { configurable: true, value: testWindow.navigator },
  sessionStorage: { configurable: true, value: testWindow.sessionStorage },
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEED_KEY = "http://rehydrate:30d:all";
const seedReport = {
  range: "30d",
  surface: "all",
  since: null,
  generatedAt: 1,
  summary: {
    requests: 7,
    measuredRequests: 7,
    reportedRequests: 7,
    unreportedRequests: 0,
    unsupportedRequests: 0,
    estimatedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 500,
    coverageRatio: 1,
    estimatedCostUsd: 0.25,
    pricedRequests: 7,
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
} as const;

testWindow.sessionStorage.setItem(
  "ccx.usage-reports.v1",
  JSON.stringify({
    state: {
      entries: {
        [SEED_KEY]: { data: seedReport, persistedAt: 1234 },
      },
    },
    version: 0,
  }),
);

const {
  clearUsageReportStoresForTests,
  rehydrateUsageReportForTests,
  useUsageReportStore,
} = await import("../src/usage-report-store");

// Re-run persist rehydration against the seeded sessionStorage above.
rehydrateUsageReportForTests();

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

function reseed(): void {
  testWindow.sessionStorage.setItem(
    "ccx.usage-reports.v1",
    JSON.stringify({
      state: {
        entries: {
          [SEED_KEY]: { data: seedReport, persistedAt: 1234 },
        },
      },
      version: 0,
    }),
  );
  rehydrateUsageReportForTests();
}

test("rehydrated seed is available with seedNeedsRevalidate set", () => {
  const entry = useUsageReportStore.getState().entries[SEED_KEY];
  expect(entry?.data).toEqual(seedReport);
  expect(entry?.persistedAt).toBe(1234);
  expect(entry?.seedNeedsRevalidate).toBe(true);
});

test("first subscriber quiet-revalidates the seed with exactly one fetch", async () => {
  clearUsageReportStoresForTests();
  // Re-seed after clearing so this test owns a fresh seed.
  reseed();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ ...seedReport, generatedAt: 2 });
  }) as typeof fetch;

  useUsageReportStore.getState().ensure(SEED_KEY, "http://rehydrate", "30d", "all");
  // A second concurrent subscriber must dedupe onto the same revalidation.
  useUsageReportStore.getState().ensure(SEED_KEY, "http://rehydrate", "30d", "all");
  await flush();
  expect(calls).toBe(1);
  const entry = useUsageReportStore.getState().entries[SEED_KEY];
  expect(entry?.data?.generatedAt).toBe(2);
  expect(entry?.seedNeedsRevalidate).toBe(false);
  expect(entry?.hasSucceeded).toBe(true);
});

test("a failed refresh keeps the seeded last-good data", async () => {
  clearUsageReportStoresForTests();
  reseed();
  const entry = useUsageReportStore.getState().entries[SEED_KEY];
  expect(entry?.data).toEqual(seedReport);
  globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
  useUsageReportStore.getState().refresh(SEED_KEY, "http://rehydrate", "30d", "all");
  await flush();
  const after = useUsageReportStore.getState().entries[SEED_KEY];
  expect(after?.data).toEqual(seedReport);
  expect(after?.lastAttemptOk).toBe(false);
});

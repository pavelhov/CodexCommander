import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * Store-level contract for the provider-quota domain store: keyed by apiBase,
 * singleflight dedupe, force-refresh TTL bypass, stale-seed rejection at rehydrate,
 * and the privacy invariant — the persisted slice never carries account identities.
 *
 * sessionStorage is installed before the store module is imported so zustand persist
 * sees it (Bun shares the module registry within one run, so the lazy storage reads
 * whatever sessionStorage is current at each call).
 */
const testWindow = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
const INSTALLED_GLOBALS = ["document", "window", "navigator", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previousGlobals = Object.fromEntries(
  INSTALLED_GLOBALS.map(key => [key, Reflect.get(globalThis, key)]),
) as Record<(typeof INSTALLED_GLOBALS)[number], unknown>;
Object.defineProperties(globalThis, {
  document: { configurable: true, value: testWindow.document },
  window: { configurable: true, value: testWindow },
  navigator: { configurable: true, value: testWindow.navigator },
  sessionStorage: { configurable: true, value: testWindow.sessionStorage },
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  clearProviderQuotaStoresForTests,
  PROVIDER_QUOTA_STORAGE_NAME,
  quotaAvailabilityFromResponse,
  rehydrateProviderQuotaForTests,
  unavailableQuotaProviders,
  useProviderQuotaStore,
} = await import("../src/provider-quota-store");

const now = Date.now();
const aggregation = {
  kind: "capacity-weighted-v1",
  scope: "routable-known",
  presentation: "aggregate",
  incomplete: false,
  excludedAccounts: 0,
  unknownPlanAccounts: 0,
  partialWindowAccounts: 0,
};

function report(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    label: "OpenAI (Codex login)",
    source: "chatgpt:wham",
    updatedAt: now,
    quota: { weeklyPercent: 20, updatedAt: now },
    aggregation,
    ...overrides,
  };
}

function quotaResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

beforeEach(() => {
  clearProviderQuotaStoresForTests();
  testWindow.sessionStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaStoresForTests();
});

afterAll(() => {
  testWindow.close();
  for (const key of INSTALLED_GLOBALS) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

test("force refresh adds the server TTL bypass (?refresh=1)", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return quotaResponse({ reports: [report()], availability: [] });
  }) as typeof fetch;

  useProviderQuotaStore.getState().ensure("");
  await flush();
  useProviderQuotaStore.getState().refresh("", { force: true });
  await flush();
  expect(urls).toEqual(["/api/provider-quotas", "/api/provider-quotas?refresh=1"]);
});

test("singleflight dedupes concurrent subscribers into one fetch", async () => {
  let calls = 0;
  const gates: Array<() => void> = [];
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise<void>(resolve => gates.push(resolve));
    return quotaResponse({ reports: [report()], availability: [] });
  }) as typeof fetch;

  useProviderQuotaStore.getState().ensure("");
  useProviderQuotaStore.getState().ensure("");
  useProviderQuotaStore.getState().ensure("");
  expect(calls).toBe(1);
  gates[0]!();
  await flush();
  expect(useProviderQuotaStore.getState().entries[""]?.reports.openai).toBeDefined();
  expect(useProviderQuotaStore.getState().entries[""]?.hasSucceeded).toBe(true);
});

test("persists only reports and a timestamp — never account identities", async () => {
  // A hostile/legacy server response carrying account identity fields must never reach
  // sessionStorage: the store projects the wire shape, not the raw payload — including
  // identity fields stashed INSIDE quota or aggregation.
  const payload = {
    reports: [report({
      // Stray identity fields on the wire row (the real server never emits these).
      accountId: "acct_12345",
      account: { email: "acct@example.com" },
      quota: {
        weeklyPercent: 20,
        updatedAt: now,
        accountId: "acct_12345",
        account: { email: "acct@example.com" },
      },
      aggregation: {
        ...aggregation,
        currentAccount: {
          isMain: true,
          plan: "pro",
          quota: { weeklyPercent: 8, updatedAt: now },
          email: "acct@example.com",
          accountId: "acct_12345",
        },
      },
    })],
    availability: [{ provider: "openai", status: "available", checkedAt: now }],
    // Stray top-level identity fields.
    accountId: "acct_12345",
    account: { email: "acct@example.com" },
  };
  globalThis.fetch = (async () => quotaResponse(payload)) as typeof fetch;
  useProviderQuotaStore.getState().ensure("");
  await flush();

  const persisted = testWindow.sessionStorage.getItem(PROVIDER_QUOTA_STORAGE_NAME) ?? "";
  expect(persisted).toContain("openai");
  expect(persisted).not.toContain("acct@example.com");
  expect(persisted).not.toContain("acct_12345");
  expect(persisted).not.toContain("accountId");
  const parsed = JSON.parse(persisted);
  const entry = parsed.state.entries[""];
  expect(entry.reports.openai.provider).toBeUndefined();
  expect(entry.reports.openai.label).toBe("OpenAI (Codex login)");
  expect(entry.reports.openai.quota.weeklyPercent).toBe(20);
  expect(typeof entry.updatedAt).toBe("number");
});

test("a failed fetch keeps the last-known-good reports", async () => {
  globalThis.fetch = (async () => quotaResponse({ reports: [report()], availability: [] })) as typeof fetch;
  useProviderQuotaStore.getState().ensure("");
  await flush();

  globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
  useProviderQuotaStore.getState().refresh("");
  await flush();
  const entry = useProviderQuotaStore.getState().entries[""];
  expect(entry?.reports.openai).toBeDefined();
  expect(entry?.lastAttemptOk).toBe(false);
});

test("stale rehydrated seeds are rejected at rehydrate", async () => {
  const old = Date.now() - 31 * 60_000;
  testWindow.sessionStorage.setItem(PROVIDER_QUOTA_STORAGE_NAME, JSON.stringify({
    state: {
      entries: {
        "": { reports: { openai: report({ updatedAt: old }) }, updatedAt: old },
      },
    },
    version: 0,
  }));
  rehydrateProviderQuotaForTests();
  const entry = useProviderQuotaStore.getState().entries[""];
  // The stale row was dropped: either no entry, or an entry without reports.
  expect(entry?.reports).toBeUndefined();
});

test("quotaAvailabilityFromResponse projects provider/status/reason/checkedAt only", () => {
  const projected = quotaAvailabilityFromResponse([
    { provider: "xai", status: "unavailable", reason: "upstream_unavailable", checkedAt: 123, email: "x@example.com", accountId: "acct_1" },
    { provider: "openai", status: "available", checkedAt: 456 },
    { provider: "anthropic", status: "unavailable", reason: "unknown_reason_code", checkedAt: 789 },
    { provider: "" },
    null,
    "garbage",
  ]);
  expect(projected).toEqual({
    xai: { status: "unavailable", reason: "upstream_unavailable", checkedAt: 123 },
    openai: { status: "available", checkedAt: 456 },
    // Unknown reason codes are dropped (never projected onto the DOM path).
    anthropic: { status: "unavailable", checkedAt: 789 },
  });
});

test("unavailableQuotaProviders lists only non-available providers without reports, sorted", () => {
  const availability = {
    xai: { status: "unavailable", reason: "upstream_unavailable", checkedAt: 1 },
    openai: { status: "available", checkedAt: 2 },
    anthropic: { status: "stale", reason: "reauth_required", checkedAt: 3 },
    grok: { status: "unavailable", checkedAt: 4 },
  };
  const reports = { openai: {}, anthropic: {} };
  expect(unavailableQuotaProviders(availability, reports)).toEqual([
    { provider: "grok" },
    { provider: "xai", reason: "upstream_unavailable" },
  ]);
});

test("a successful fetch populates availability; refresh updates it", async () => {
  globalThis.fetch = (async () => quotaResponse({
    reports: [report()],
    availability: [{ provider: "xai", status: "unavailable", reason: "upstream_unavailable", checkedAt: now }],
  })) as typeof fetch;
  useProviderQuotaStore.getState().ensure("");
  await flush();
  expect(useProviderQuotaStore.getState().entries[""]?.availability).toEqual({
    xai: { status: "unavailable", reason: "upstream_unavailable", checkedAt: now },
  });

  globalThis.fetch = (async () => quotaResponse({
    reports: [report()],
    availability: [{ provider: "xai", status: "available", checkedAt: now }],
  })) as typeof fetch;
  useProviderQuotaStore.getState().refresh("");
  await flush();
  expect(useProviderQuotaStore.getState().entries[""]?.availability.xai).toEqual({
    status: "available",
    checkedAt: now,
  });
});

test("a failed fetch keeps the last-known-good availability", async () => {
  globalThis.fetch = (async () => quotaResponse({
    reports: [report()],
    availability: [{ provider: "xai", status: "unavailable", reason: "upstream_unavailable", checkedAt: now }],
  })) as typeof fetch;
  useProviderQuotaStore.getState().ensure("");
  await flush();

  globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
  useProviderQuotaStore.getState().refresh("");
  await flush();
  const entry = useProviderQuotaStore.getState().entries[""];
  expect(entry?.availability.xai.reason).toBe("upstream_unavailable");
  expect(entry?.lastAttemptOk).toBe(false);
});

test("availability is never persisted to sessionStorage", async () => {
  const payload = {
    reports: [report()],
    availability: [
      { provider: "xai", status: "unavailable", reason: "upstream_unavailable", checkedAt: now, email: "x@example.com", accountId: "acct_xai" },
    ],
  };
  globalThis.fetch = (async () => quotaResponse(payload)) as typeof fetch;
  useProviderQuotaStore.getState().ensure("");
  await flush();

  const persisted = testWindow.sessionStorage.getItem(PROVIDER_QUOTA_STORAGE_NAME) ?? "";
  const parsed = JSON.parse(persisted) as { state: { entries: Record<string, unknown> } };
  const entry = parsed.state.entries[""] as Record<string, unknown>;
  expect(entry).not.toHaveProperty("availability");
  expect(persisted).not.toContain("upstream_unavailable");
  expect(persisted).not.toContain("acct_xai");
  expect(persisted).not.toContain("x@example.com");
});

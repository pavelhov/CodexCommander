import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import {
  clearProviderQuotaStoresForTests,
  PROVIDER_QUOTA_STORAGE_NAME,
  useProviderQuotaStore,
} from "../src/provider-quota-store";
import { DashboardOverviewHead } from "../src/pages/dashboard-overview-head";
import { DashboardPlanQuotaSection } from "../src/pages/dashboard-plan-quota-section";
import type { UsageSummary30d } from "../src/pages/dashboard-shared";

/**
 * Phase 1c contract: the Dashboard overview shows a 30-day estimated cost stat with a
 * request-coverage line ($0.00 for a defined zero, "—" when absent), and the Plan &
 * quota section renders per-provider plans / quota windows / reference spend from the
 * provider-quota store — never persisting account identities.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  clearProviderQuotaStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow.sessionStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  clearProviderQuotaStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

const NOW = Date.now();
const aggregation = {
  kind: "capacity-weighted-v1",
  scope: "routable-known",
  presentation: "aggregate",
  incomplete: false,
  excludedAccounts: 0,
  unknownPlanAccounts: 0,
  partialWindowAccounts: 0,
  weekly: { usedPercent: 31, includedAccounts: 2, excludedAccounts: 0, incomplete: false, updatedAt: NOW },
};

test("Dashboard cost stat renders the 30-day estimate and coverage line", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const usage30d: UsageSummary30d = {
    summary: {
      requests: 5,
      totalTokens: 9000,
      coverageRatio: 0.8,
      estimatedCostUsd: 1.25,
      pricedRequests: 4,
      unpricedRequests: 1,
      unmeteredRequests: 0,
    },
  };
  const props = {
    locale: "en" as const,
    health: { status: "ok", version: "1.0", uptime: 100 },
    providers: [],
    usage30d,
    usageLoading: false,
    healthLoading: false,
    startupHealth: null,
    projectConfigWarnings: [],
    maMode: "default" as const,
    maBusy: false,
    maHelpTriggerRef: { current: null },
    maHelpOpen: false,
    setMaHelpOpen: () => {},
    switchMaMode: async () => {},
  };
  await act(async () => {
    root.render(
      <LanguageProvider>
        <DashboardOverviewHead {...props} />
      </LanguageProvider>,
    );
  });
  try {
    const text = container.textContent ?? "";
    expect(text).toContain("Est. cost (30d)");
    expect(text).toContain("1.25");
    expect(text).toContain("4 priced · 1 unpriced · 0 unmetered requests");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Dashboard cost stat renders $0.00 for a defined zero and — when absent", async () => {
  const { createRoot } = await import("react-dom/client");
  const base = {
    locale: "en" as const,
    health: { status: "ok", version: "1.0", uptime: 100 },
    providers: [],
    usageLoading: false,
    healthLoading: false,
    startupHealth: null,
    projectConfigWarnings: [],
    maMode: "default" as const,
    maBusy: false,
    maHelpTriggerRef: { current: null },
    maHelpOpen: false,
    setMaHelpOpen: () => {},
    switchMaMode: async () => {},
  };
  const zeroContainer = document.createElement("div");
  document.body.append(zeroContainer);
  const zeroRoot = createRoot(zeroContainer);
  await act(async () => {
    zeroRoot.render(
      <LanguageProvider>
        <DashboardOverviewHead
          {...base}
          usage30d={{
            summary: {
              requests: 0,
              totalTokens: 0,
              coverageRatio: 1,
              estimatedCostUsd: 0,
              pricedRequests: 0,
              unpricedRequests: 0,
              unmeteredRequests: 0,
            },
          }}
        />
      </LanguageProvider>,
    );
  });
  try {
    expect(zeroContainer.textContent ?? "").toContain("$0.00");
    // A defined zero must never fall back to the ~$0.0000 estimate rendering.
    expect(zeroContainer.textContent ?? "").not.toContain("~");
  } finally {
    await act(async () => { zeroRoot.unmount(); });
    zeroContainer.remove();
  }
  const absentContainer = document.createElement("div");
  document.body.append(absentContainer);
  const absentRoot = createRoot(absentContainer);
  await act(async () => {
    absentRoot.render(
      <LanguageProvider>
        <DashboardOverviewHead {...base} usage30d={null} />
      </LanguageProvider>,
    );
  });
  try {
    expect(absentContainer.textContent ?? "").toContain("—");
  } finally {
    await act(async () => { absentRoot.unmount(); });
    absentContainer.remove();
  }
});

test("Plan & quota section renders provider plan, windows, and reference spend", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      reports: [
        {
          provider: "openai",
          label: "OpenAI (Codex login)",
          source: "chatgpt:wham",
          updatedAt: NOW,
          quota: { weeklyPercent: 31, updatedAt: NOW },
          aggregation,
        },
        {
          provider: "opencode-go",
          label: "OpenCode Go",
          source: "opencode-go:published-caps-2026-08-05+local-estimate",
          updatedAt: NOW,
          quota: {
            referenceWindows: [{
              id: "five_hour",
              label: "5-hour",
              windowSeconds: 18_000,
              publishedLimitUsd: 12,
              observedSpendUsd: 1.25,
              observedTokens: 42_000,
              observedRequests: 3,
              pricedRequests: 2,
              unpricedRequests: 1,
              unmeasuredRequests: 0,
              coverage: "partial",
            }],
            updatedAt: NOW,
          },
          aggregation: undefined,
        },
      ],
      availability: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <DashboardPlanQuotaSection apiBase="http://plan-quota" />
      </LanguageProvider>,
    );
  });
  try {
    await waitFor(() => (container.textContent ?? "").includes("Plan & quota"));
    await waitFor(() => (container.textContent ?? "").includes("Configured-weight pool estimate"));
    const text = container.textContent ?? "";
    expect(text).toContain("OpenAI (Codex login)");
    expect(text).toContain("31% used");
    expect(text).toContain("OpenCode Go");
    expect(text).toContain("$12 published cap");
    expect(text).toContain("$1.25 observed through CodexCommander");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Plan & quota section never persists account identities to sessionStorage", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      reports: [
        {
          provider: "openai",
          label: "OpenAI (Codex login)",
          source: "chatgpt:wham",
          updatedAt: NOW,
          quota: { weeklyPercent: 31, updatedAt: NOW },
          aggregation,
          // Stray identity fields the real server never emits.
          accountId: "acct_12345",
          account: { email: "acct@example.com" },
          quota: {
            weeklyPercent: 31,
            updatedAt: NOW,
            accountId: "acct_12345",
            account: { email: "acct@example.com" },
          },
        },
      ],
      availability: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <DashboardPlanQuotaSection apiBase="http://plan-quota-privacy" />
      </LanguageProvider>,
    );
  });
  try {
    await waitFor(() => (container.textContent ?? "").includes("OpenAI (Codex login)"));
    const persisted = testWindow.sessionStorage.getItem(PROVIDER_QUOTA_STORAGE_NAME) ?? "";
    expect(persisted).not.toContain("acct@example.com");
    expect(persisted).not.toContain("acct_12345");
    expect(persisted).not.toContain("accountId");
    expect(useProviderQuotaStore.getState().entries["http://plan-quota-privacy"]?.reports.openai?.accountId).toBeUndefined();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

function openaiReport(): Record<string, unknown> {
  return {
    provider: "openai",
    label: "OpenAI (Codex login)",
    source: "chatgpt:wham",
    updatedAt: NOW,
    quota: { weeklyPercent: 31, updatedAt: NOW },
    aggregation,
  };
}

test("Plan & quota renders a full-width strip for unavailable providers with per-reason actions", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      reports: [openaiReport()],
      availability: [
        { provider: "xai", status: "unavailable", reason: "upstream_unavailable", checkedAt: NOW },
        { provider: "anthropic", status: "unavailable", reason: "reauth_required", checkedAt: NOW },
        { provider: "kimi", status: "unavailable", reason: "local_cli_refresh_required", checkedAt: NOW },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <DashboardPlanQuotaSection apiBase="http://plan-quota-unavailable" />
      </LanguageProvider>,
    );
  });
  try {
    await waitFor(() => (container.textContent ?? "").includes("Quota unavailable"));
    const strip = container.querySelector(".dash-plan-quota-unavailable");
    expect(strip).toBeTruthy();
    const text = strip?.textContent ?? "";
    expect(text).toContain("xAI Grok");
    expect(text).toContain("Temporarily unavailable");
    expect(text).toContain("Anthropic");
    expect(text).toContain("Sign in required");
    expect(text).toContain("Kimi");
    expect(text).toContain("Login needs refresh");
    // Reauth rows deep-link to the provider; retryable rows share one Retry.
    expect(text).toContain("Manage Anthropic");
    expect(text).toContain("Retry quota check");
    const manageLink = Array.from(strip?.querySelectorAll("a") ?? [])
      .find(anchor => anchor.textContent?.includes("Manage Anthropic"));
    expect(manageLink?.getAttribute("href")).toBe("#providers/anthropic/overview");
    expect(Array.from(strip?.querySelectorAll("button") ?? []).length).toBe(1);
    // F6: the strip has no live-region role; each message span is the live region
    // and contains no interactive descendants.
    expect(strip?.getAttribute("role")).toBeNull();
    const statusSpans = strip?.querySelectorAll('[role="status"]') ?? [];
    expect(statusSpans.length).toBe(3);
    for (const span of Array.from(statusSpans)) {
      expect(span.querySelector("button, a")).toBeNull();
    }
    // F4: grid precedes the strip, strip precedes the disclaimer.
    expect(strip?.previousElementSibling?.classList.contains("dash-sidecar-grid")).toBe(true);
    expect(strip?.nextElementSibling?.textContent).toContain("Provider-reported caps and local estimates");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("reauth-only strip deep-links to the provider and offers no quota retry", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({
      reports: [],
      availability: [
        { provider: "anthropic", status: "unavailable", reason: "reauth_required", checkedAt: NOW },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <DashboardPlanQuotaSection apiBase="http://plan-quota-reauth-only" />
      </LanguageProvider>,
    );
  });
  try {
    await waitFor(() => (container.textContent ?? "").includes("Sign in required"));
    expect(container.textContent).toContain("Manage Anthropic");
    expect(Array.from(container.querySelectorAll("button"))
      .some(button => button.textContent?.includes("Retry"))).toBe(false);
    expect(urls.every(url => !url.includes("refresh=1"))).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Plan & quota strip Retry forces refresh and disappears once the provider reports", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    if (String(input).includes("refresh=1")) {
      return new Response(JSON.stringify({
        reports: [openaiReport(), { ...openaiReport(), provider: "xai", label: "xAI Grok" }],
        availability: [{ provider: "xai", status: "available", checkedAt: NOW }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      reports: [openaiReport()],
      availability: [
        { provider: "xai", status: "unavailable", reason: "upstream_unavailable", checkedAt: NOW },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <DashboardPlanQuotaSection apiBase="http://plan-quota-retry" />
      </LanguageProvider>,
    );
  });
  try {
    await waitFor(() => (container.textContent ?? "").includes("Quota unavailable"));
    const strip = container.querySelector(".dash-plan-quota-unavailable");
    expect(strip).toBeTruthy();
    const retry = Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === "Retry quota check");
    expect(retry).toBeTruthy();
    await act(async () => { retry?.click(); });
    await waitFor(() => urls.some(url => url.includes("refresh=1")));
    await waitFor(() => !container.querySelector(".dash-plan-quota-unavailable"));
    expect((container.textContent ?? "")).toContain("xAI Grok");
    expect((container.textContent ?? "")).not.toContain("Temporarily unavailable");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Plan & quota strip stays hidden when providers are available or availability is absent", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      reports: [openaiReport()],
      availability: [{ provider: "xai", status: "available", checkedAt: NOW }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <DashboardPlanQuotaSection apiBase="http://plan-quota-available" />
      </LanguageProvider>,
    );
  });
  try {
    await waitFor(() => (container.textContent ?? "").includes("Plan & quota"));
    expect(container.querySelector(".dash-plan-quota-unavailable")).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }

  // No availability data at all: still no strip.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      reports: [openaiReport()],
      availability: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  const container2 = document.createElement("div");
  document.body.append(container2);
  const root2 = createRoot(container2);
  await act(async () => {
    root2.render(
      <LanguageProvider>
        <DashboardPlanQuotaSection apiBase="http://plan-quota-no-availability" />
      </LanguageProvider>,
    );
  });
  try {
    await waitFor(() => (container2.textContent ?? "").includes("Plan & quota"));
    expect(container2.querySelector(".dash-plan-quota-unavailable")).toBeNull();
  } finally {
    await act(async () => { root2.unmount(); });
    container2.remove();
  }
});

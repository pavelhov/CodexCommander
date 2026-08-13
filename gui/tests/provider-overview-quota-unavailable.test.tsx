import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ProviderQuotaReportView } from "../src/provider-workspace/report";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const item = {
  name: "xai",
  adapter: "openai-chat",
  baseUrl: "https://api.x.ai/v1",
  authMode: "oauth",
  hasApiKey: false,
} as WorkspaceItem;

async function mountOverview(props: {
  quotaReport?: ProviderQuotaReportView;
  quotaUnavailableReason?: string;
  onRetryQuota?: () => void;
}): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderOverview
          item={item}
          quotaReport={props.quotaReport}
          quotaUnavailableReason={props.quotaUnavailableReason}
          onRetryQuota={props.onRetryQuota}
        />
      </LanguageProvider>,
    );
  });
  return { root, container };
}

test("renders the quota-unavailable notice with reason copy and Retry when no report exists", async () => {
  const { root, container } = await mountOverview({
    quotaUnavailableReason: "upstream_unavailable",
    onRetryQuota: () => {},
  });
  try {
    const text = container.textContent ?? "";
    expect(text).toContain("Quota unavailable");
    expect(text).toContain("Temporarily unavailable");
    expect(text).toContain("Retry");
    expect(text).not.toContain("Rate limits");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("reauth reasons map to their dedicated copy", async () => {
  const { root, container } = await mountOverview({ quotaUnavailableReason: "reauth_required" });
  try {
    expect(container.textContent ?? "").toContain("Sign in required");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("Retry invokes onRetryQuota", async () => {
  let retried = false;
  const { root, container } = await mountOverview({
    quotaUnavailableReason: "local_cli_refresh_required",
    onRetryQuota: () => { retried = true; },
  });
  try {
    const retry = Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === "Retry");
    expect(retry).toBeTruthy();
    await act(async () => { retry?.click(); });
    expect(retried).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("quota card (not the notice) renders when a report exists", async () => {
  const report: ProviderQuotaReportView = {
    label: "xAI Grok",
    source: "xai:api",
    updatedAt: Date.now(),
    quota: { weeklyPercent: 10 },
    aggregation: undefined,
  };
  const { root, container } = await mountOverview({
    quotaReport: report,
    quotaUnavailableReason: "upstream_unavailable",
  });
  try {
    const text = container.textContent ?? "";
    expect(text).toContain("Rate limits");
    expect(text).not.toContain("Temporarily unavailable");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("no notice and no quota card when neither report nor reason exists", async () => {
  const { root, container } = await mountOverview({});
  try {
    const text = container.textContent ?? "";
    expect(text).not.toContain("Rate limits");
    expect(text).not.toContain("Quota unavailable");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

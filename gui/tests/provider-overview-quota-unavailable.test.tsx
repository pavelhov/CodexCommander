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
  accountNeedsReauth?: boolean;
  onReauthenticate?: () => void;
  itemOverrides?: Partial<WorkspaceItem>;
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
          item={{ ...item, ...props.itemOverrides }}
          quotaReport={props.quotaReport}
          quotaUnavailableReason={props.quotaUnavailableReason}
          onRetryQuota={props.onRetryQuota}
          accountNeedsReauth={props.accountNeedsReauth}
          onReauthenticate={props.onReauthenticate}
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
    // F6: the warning container has no live-region role; the message span does,
    // and no interactive control lives inside it.
    const warnings = container.querySelectorAll(".pws-auth-summary--warn");
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.getAttribute("role")).toBeNull();
    const status = warnings[0]?.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Temporarily unavailable");
    expect(status?.querySelector("button, a")).toBeNull();
    const retry = Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent?.trim() === "Retry");
    expect(retry).toBeTruthy();
    expect(status?.contains(retry as Node)).toBe(false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("reauth_required is owned by the auth warning, not a second quota warning", async () => {
  let reauthed = false;
  const { root, container } = await mountOverview({
    quotaUnavailableReason: "reauth_required",
    onRetryQuota: () => { throw new Error("quota retry must not be offered when auth owns the warning"); },
    onReauthenticate: () => { reauthed = true; },
    itemOverrides: { activeNeedsReauth: true },
  });
  try {
    const warnings = container.querySelectorAll(".pws-auth-summary--warn");
    expect(warnings.length).toBe(1);
    const text = container.textContent ?? "";
    expect(text).toContain("Needs attention");
    expect(text).toContain("Active account needs re-authentication");
    expect(text).toContain("Re-authenticate");
    expect(text).not.toContain("Quota unavailable");
    expect(text).not.toContain("Sign in required");
    expect(text).not.toContain("Retry");
    const warn = warnings[0]!;
    expect(warn.getAttribute("role")).toBeNull();
    const status = warn.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Needs attention");
    expect(status?.querySelector("button, a")).toBeNull();
    await act(async () => {
      (Array.from(container.querySelectorAll("button"))
        .find(button => button.textContent?.trim() === "Re-authenticate"))?.click();
    });
    expect(reauthed).toBe(true);
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

test("local_cli_refresh_required alone is owned by the quota notice, not the auth warning", async () => {
  const { root, container } = await mountOverview({
    quotaUnavailableReason: "local_cli_refresh_required",
    onRetryQuota: () => {},
    itemOverrides: { activeNeedsReauth: true },
    accountNeedsReauth: false,
  });
  try {
    const warnings = container.querySelectorAll(".pws-auth-summary--warn");
    expect(warnings.length).toBe(1);
    const text = container.textContent ?? "";
    expect(text).toContain("Quota unavailable");
    expect(text).toContain("Login needs refresh");
    expect(text).toContain("Retry");
    expect(text).not.toContain("Active account needs re-authentication");
    expect(text).not.toContain("Re-authenticate");
    // The connection status row still surfaces attention (status metadata only).
    expect(text).toContain("Needs attention");
    const warn = warnings[0]!;
    expect(warn.getAttribute("role")).toBeNull();
    const status = warn.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Login needs refresh");
    expect(status?.querySelector("button, a")).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("local CLI refresh plus a genuine account reauth shows both warnings", async () => {
  const { root, container } = await mountOverview({
    quotaUnavailableReason: "local_cli_refresh_required",
    onRetryQuota: () => {},
    onReauthenticate: () => {},
    itemOverrides: { activeNeedsReauth: true },
    accountNeedsReauth: true,
  });
  try {
    expect(container.querySelectorAll(".pws-auth-summary--warn").length).toBe(2);
    const text = container.textContent ?? "";
    expect(text).toContain("Login needs refresh");
    expect(text).toContain("Retry");
    expect(text).toContain("Active account needs re-authentication");
    expect(text).toContain("Re-authenticate");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("reauth_required without merged attention keeps the quota notice visible", async () => {
  const { root, container } = await mountOverview({
    quotaUnavailableReason: "reauth_required",
    onRetryQuota: () => {},
  });
  try {
    const text = container.textContent ?? "";
    expect(text).toContain("Quota unavailable");
    expect(text).toContain("Sign in required");
    expect(text).toContain("Retry");
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

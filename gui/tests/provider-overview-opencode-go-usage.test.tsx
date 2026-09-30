import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import type { ProviderModelUsageRow } from "../src/components/provider-workspace/types";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const item = {
  name: "opencode-go",
  adapter: "openai-chat",
  baseUrl: "https://opencode.ai/zen/go/v1",
  authMode: "key",
  hasApiKey: true,
} as WorkspaceItem;

const modelUsage: ProviderModelUsageRow[] = [
  { model: "glm-5", requests: 3, measuredRequests: 3, totalTokens: 400, inputTokens: 250, outputTokens: 150, shareRatio: 0.2 },
  { model: "deepseek-v4", requests: 7, measuredRequests: 7, totalTokens: 1600, inputTokens: 1000, outputTokens: 600, shareRatio: 0.8 },
];

async function mountOverview(providerItem: WorkspaceItem, usage = modelUsage, totals = { requests: 10, measuredRequests: 10, totalTokens: 2000 }): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderOverview item={providerItem} usageTotals={totals} modelUsage={usage} />
      </LanguageProvider>,
    );
  });
  return { root, container };
}

test("OpenCode Go overview shows 30-day provider totals and per-model request and token counts", async () => {
  const { root, container } = await mountOverview(item);
  try {
    const section = container.querySelector('section[aria-label="Usage (last 30 days)"]');
    expect(section).toBeTruthy();
    const metrics = Array.from(section?.querySelectorAll(".pws-usage-metric") ?? []);
    expect(metrics.map(metric => [
      metric.querySelector(".pws-usage-metric-value")?.textContent,
      metric.querySelector(".pws-usage-metric-label")?.textContent,
    ])).toEqual([["10", "requests"], ["2.0k", "tokens"]]);
    const table = section?.querySelector("table");
    expect(table?.caption?.textContent).toBe("Model breakdown");
    const rows = Array.from(table?.querySelectorAll("tbody tr") ?? []);
    expect(rows.map(row => Array.from(row.querySelectorAll("td"), cell => cell.textContent))).toEqual([
      ["deepseek-v4", "7", "1.6k"],
      ["glm-5", "3", "400"],
    ]);
    expect(section?.textContent).not.toContain("balance");
    expect(section?.textContent).not.toContain("Est. cost");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("OpenCode Go labels completed requests with no token measurement as unreported", async () => {
  const rows: ProviderModelUsageRow[] = [
    { model: "no-usage", requests: 2, measuredRequests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, shareRatio: 1 },
  ];
  const { root, container } = await mountOverview(item, rows, { requests: 2, measuredRequests: 0, totalTokens: 0 });
  try {
    const section = container.querySelector('section[aria-label="Usage (last 30 days)"]');
    expect(section?.textContent).toContain("unreported");
    expect(section?.textContent).not.toContain("0 tokens");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("OpenCode Go labels partially measured provider and model token totals", async () => {
  const rows: ProviderModelUsageRow[] = [
    { model: "partial", requests: 4, measuredRequests: 2, totalTokens: 70, inputTokens: 40, outputTokens: 30, shareRatio: 1 },
  ];
  const { root, container } = await mountOverview(item, rows, { requests: 4, measuredRequests: 2, totalTokens: 70 });
  try {
    const section = container.querySelector('section[aria-label="Usage (last 30 days)"]');
    expect(section?.textContent).toContain("Partial");
    expect(section?.textContent).toContain("70");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("OpenCode Go does not infer measurement coverage from legacy cached token totals", async () => {
  const rows: ProviderModelUsageRow[] = [
    { model: "legacy", requests: 1, totalTokens: 99, inputTokens: 60, outputTokens: 39, shareRatio: 1 },
  ];
  const { root, container } = await mountOverview(item, rows, { requests: 1, measuredRequests: 0, totalTokens: 99 });
  try {
    const row = container.querySelector("tbody tr");
    expect(row?.textContent).toContain("unreported");
    expect(row?.textContent).not.toContain("99");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("model summary stays scoped to OpenCode Go", async () => {
  const { root, container } = await mountOverview({ ...item, name: "deepseek" });
  try {
    expect(container.querySelector('section[aria-label="Usage (last 30 days)"]')).toBeNull();
    expect(container.textContent).not.toContain("deepseek-v4");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("OpenCode Go overview does not invent zero usage when no report is available", async () => {
  const { root, container } = await mountOverview(item, []);
  try {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <ProviderOverview item={item} />
        </LanguageProvider>,
      );
    });
    const section = container.querySelector('section[aria-label="Usage (last 30 days)"]');
    expect(section?.textContent).toContain("No usage recorded yet.");
    expect(section?.querySelector(".pws-usage-metrics")).toBeNull();
    expect(section?.querySelector("table")).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderCatalog, { type AccountLoginRow, type CatalogTier } from "../src/components/provider-catalog/ProviderCatalog";
import type { CatalogPreset } from "../src/components/provider-catalog/provider-presets";

/**
 * The catalog search used to filter only the selected tier's bucket — and on
 * the Accounts tab it filtered nothing at all, because the rows rendered there
 * are account login rows, not presets. A query now searches every tier (plus
 * the login rows) at once and renders grouped, tier-labelled results, so a
 * Paid provider like opencode go surfaces even when the user typed from the
 * Accounts tab. No-query tab behavior must stay exactly as before.
 */

/** Mirrors src/providers/registry.ts: opencode-go is keyed Paid, opencode-free keyless Free. */
const PRESETS: CatalogPreset[] = [
  { id: "openai", label: "OpenAI", adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", auth: "forward" },
  { id: "opencode-free", label: "OpenCode Free", adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", auth: "key", keyOptional: true },
  { id: "opencode-go", label: "opencode go", adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", auth: "key" },
  { id: "deepseek", label: "DeepSeek", adapter: "openai-chat", baseUrl: "https://api.deepseek.com", auth: "key" },
];

const ACCOUNT_ROWS: AccountLoginRow[] = [
  { id: "openai", label: "ChatGPT", kind: "codex", href: "#codex-auth" },
  { id: "claude", label: "Claude", kind: "oauth" },
];

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let active: Root | null = null;
let selected: string[] = [];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  selected = [];
});

afterEach(async () => {
  if (active) {
    const root = active;
    active = null;
    await act(async () => { root.unmount(); });
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(initialTier: CatalogTier): Promise<HTMLDivElement> {
  // Use the GLOBAL document (which beforeEach points at testWindow): React reads
  // globals, so a container created off the raw window object is not the same
  // document it renders into, and synthetic input events never reach it.
  const container = document.createElement("div");
  document.body.append(container);
  // Import AFTER beforeEach installed the globals: a module-level import binds
  // react-dom to whatever document existed at load time.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  active = root;
  await act(async () => {
    root.render(
      <LanguageProvider>
        <ProviderCatalog
          presets={PRESETS}
          initialTier={initialTier}
          onSelectPreset={p => selected.push(p.id)}
          onSelectCustom={() => selected.push("custom")}
          accountRows={ACCOUNT_ROWS}
          onLogin={() => {}}
          onCancelLogin={() => {}}
          onLogout={() => {}}
        />
      </LanguageProvider>,
    );
  });
  return container;
}

/** React tracks the last value it wrote; set through the prototype so the
 *  synthetic change event is not swallowed as a no-op. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const proto = Object.getPrototypeOf(input) as object;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    (input as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker?.setValue("");
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never);
  });
}

function searchInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(".provider-catalog-search")!;
}

/** Visible row titles in DOM order (preset buttons and account login rows). */
function rowTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".provider-catalog-rows .list-row .title")].map(el => el.textContent ?? "");
}

function groupLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".provider-catalog-group-label")].map(el => el.textContent ?? "");
}

function tab(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(el => el.textContent === name);
  if (!found) throw new Error(`tab not found: ${name}`);
  return found;
}

function tierButton(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(".provider-catalog-tab")]
    .find(el => el.textContent === name);
  if (!found) throw new Error(`tier button not found: ${name}`);
  return found;
}

test("searching 'opencode' from the Accounts tab surfaces the Paid opencode go preset, grouped and tier-labelled", async () => {
  const container = await mount("accounts");
  await typeInto(searchInput(container), "opencode");

  // The Paid provider is visible without guessing the Paid tab — the fix for
  // the silent single-tier filter.
  expect(rowTitles(container)).toContain("opencode go");
  expect(rowTitles(container)).toContain("OpenCode Free");
  // Groups carry the existing tab strings as tier labels, Free before Paid,
  // and no Accounts group: neither the ChatGPT login row nor the
  // accounts-bucket openai preset matches "opencode".
  expect(groupLabels(container)).toEqual(["Free", "Paid"]);
  expect(rowTitles(container)).not.toContain("DeepSeek");
  expect(rowTitles(container)).not.toContain("ChatGPT");
  expect(rowTitles(container)).not.toContain("OpenAI");
  // Groups are exposed to assistive technology with the tier name.
  const groups = [...container.querySelectorAll('[role="group"]')];
  expect(groups.map(g => g.getAttribute("aria-label"))).toEqual(["Free", "Paid"]);
});

test("account login rows are filtered by the query", async () => {
  const container = await mount("accounts");
  await typeInto(searchInput(container), "claude");

  expect(groupLabels(container)).toEqual(["Accounts"]);
  expect(rowTitles(container)).toEqual(["Claude"]);
});

test("search from the Free tab surfaces Paid matches without switching tabs", async () => {
  const container = await mount("free");
  await typeInto(searchInput(container), "opencode");

  expect(rowTitles(container)).toContain("opencode go");
  expect(rowTitles(container)).toContain("OpenCode Free");
  expect(groupLabels(container)).toEqual(["Free", "Paid"]);
  // The visual tier choice remains, but ARIA no longer claims that one tab
  // controls a panel while results from every tier are shown.
  expect(container.querySelector(".provider-catalog-tab.active")?.textContent).toBe("Free");
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.querySelectorAll('[role="tab"]').length).toBe(0);
});

test("cross-tier search suspends tab semantics while all tier groups are visible", async () => {
  const container = await mount("accounts");
  await typeInto(searchInput(container), "opencode");

  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.querySelectorAll('[role="tab"]').length).toBe(0);
  expect(container.querySelector('[role="group"][aria-label="Paid"]')).not.toBeNull();
});

test("a query with no match anywhere renders the existing no-match empty state", async () => {
  const container = await mount("paid");
  await typeInto(searchInput(container), "zzz-no-such-provider");

  expect(rowTitles(container)).toEqual([]);
  expect(groupLabels(container)).toEqual([]);
  expect(container.textContent).toContain("No match.");
});

test("clicking a cross-tier search result selects that preset", async () => {
  const container = await mount("accounts");
  await typeInto(searchInput(container), "opencode");

  const row = [...container.querySelectorAll<HTMLButtonElement>(".provider-catalog-rows button.list-row")]
    .find(el => el.textContent?.includes("opencode go"));
  expect(row).toBeDefined();
  await click(row!);
  expect(selected).toEqual(["opencode-go"]);
});

test("no-query tab behavior is preserved: tabs filter per tier and clear the query", async () => {
  const container = await mount("accounts");

  // Accounts tab with no query: login rows only, never preset rows.
  expect(rowTitles(container)).toEqual(["ChatGPT", "Claude"]);
  expect(groupLabels(container)).toEqual([]);

  // Free tab: free presets only; Paid tab: paid presets only.
  await click(tab(container, "Free"));
  expect(rowTitles(container)).toEqual(["OpenCode Free"]);
  await click(tab(container, "Paid"));
  // No usage data yet: stable alphabetical order.
  expect(rowTitles(container)).toEqual(["DeepSeek", "opencode go"]);

  // Typing a query then switching tabs clears it, restoring the full tier list.
  await typeInto(searchInput(container), "opencode");
  expect(rowTitles(container)).toContain("OpenCode Free");
  await click(tierButton(container, "Paid"));
  expect(searchInput(container).value).toBe("");
  expect(rowTitles(container)).toEqual(["DeepSeek", "opencode go"]);
  expect(groupLabels(container)).toEqual([]);
});

test("search results keep usage-ranked order within a tier group", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  active = root;
  await act(async () => {
    root.render(
      <LanguageProvider>
        <ProviderCatalog
          presets={PRESETS}
          usageRank={{ deepseek: 5, "opencode-go": 9 }}
          initialTier="paid"
          onSelectPreset={() => {}}
          onSelectCustom={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await typeInto(searchInput(container as HTMLDivElement), "e");

  const paidGroup = [...container.querySelectorAll('[role="group"]')]
    .find(g => g.getAttribute("aria-label") === "Paid")!;
  const titles = [...paidGroup.querySelectorAll(".list-row .title")].map(el => el.textContent);
  expect(titles).toEqual(["opencode go", "DeepSeek"]);
});

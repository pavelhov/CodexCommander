import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { OverviewRow } from "../src/pages/integrations/overview-clients";
import { deriveModelReadiness, deriveProviderReadiness } from "../src/pages/integrations/client-apps-readiness";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

function row(overrides: Partial<OverviewRow> & Pick<OverviewRow, "id" | "hash" | "labelKey">): OverviewRow {
  return {
    state: "absent",
    installed: true,
    applied: false,
    detail: "/tmp/client.json",
    detailKey: null,
    detailVars: null,
    toggle: overrides.id,
    toggleBlocked: null,
    togglePath: "/tmp/client.json",
    status: null,
    ...overrides,
  } as OverviewRow;
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountWorkspace(overrides: {
  providerState?: "checking" | "available" | "unavailable";
  modelState?: "checking" | "available" | "unavailable";
  historyState?: "checking" | "available" | "unavailable";
} = {}): Promise<void> {
  const [{ createRoot }, { LanguageProvider }, { default: ClientAppsWorkspace }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/ClientAppsWorkspace"),
  ]);
  const rows: OverviewRow[] = [
    row({
      id: "codex",
      hash: "integrations/codex",
      labelKey: "integrations.tab.codex",
      state: "current",
      applied: true,
      toggle: "codex",
    }),
    row({
      id: "claude",
      hash: "integrations/claude",
      labelKey: "integrations.tab.claude",
      state: "current",
      applied: true,
      toggle: "claude",
    }),
    row({
      id: "opencode",
      hash: "integrations/opencode",
      labelKey: "integrations.tab.opencode",
      state: "unknown",
      installed: false,
      toggle: null,
    }),
  ];

  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ClientAppsWorkspace
          rows={rows}
          providers={[
            { name: "OpenCode Go", adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", authMode: "key", hasApiKey: true },
            { name: "Anthropic", adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", hasApiKey: true },
          ]}
          providerState={overrides.providerState ?? "available"}
          visibleModelCount={15}
          modelState={overrides.modelState ?? "available"}
          proxyState="running"
          keysRow={{
            hash: "integrations/keys",
            labelKey: "integrations.tab.keys",
            state: "issued",
            detailKey: "integrations.detail.keyCount",
            detailVars: { count: "2" },
          }}
          history={[]}
          historyState={overrides.historyState ?? "available"}
          pending={false}
          results={{}}
          bulkPending={false}
          bulkTargetCount={1}
          bulkResult={null}
          onRefresh={() => {}}
          onToggle={() => {}}
          onDisableAll={() => {}}
          onRestore={() => {}}
        />
      </LanguageProvider>,
    );
  });
}

test("Client Apps explains the provider → proxy → client relationship", async () => {
  await mountWorkspace();
  const text = container.textContent ?? "";
  expect(text).toContain("Provider accounts");
  expect(text).toContain("CodexCommander proxy");
  expect(text).toContain("Client apps");
  expect(text).toContain("Configuration readiness, not inferred app activity.");
  expect(text).toContain("15 in CodexCommander catalog");
});

test("configured clients and available clients are separate, with OpenCode explained", async () => {
  await mountWorkspace();
  const configuredClaude = container.querySelector('[data-client="claude"]');
  const availableOpenCode = container.querySelector('.client-apps-available [data-client="opencode"]');
  expect(configuredClaude?.querySelector(".switch")).not.toBeNull();
  expect(availableOpenCode).not.toBeNull();
  expect(availableOpenCode?.querySelector(".switch")).toBeNull();
  expect(availableOpenCode?.textContent).toContain("Checking…");
  expect(availableOpenCode?.textContent).not.toContain("Install before connecting");
  expect(container.textContent).toContain("OpenCode Go is a model provider. OpenCode is a client app.");
});

test("API Access is presented as client authentication, separate from provider credentials", async () => {
  await mountWorkspace();
  const banner = container.querySelector(".client-apps-access-banner");
  expect(banner?.textContent).toContain("Need a key for another app?");
  expect(banner?.textContent).toContain("provider credentials stay under Providers");
  expect(banner?.textContent).toContain("2 key(s) issued");
});

test("provider readiness excludes keyed providers with no key and preserves keyless providers", () => {
  const missingKey = {
    name: "Missing key",
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    authMode: "key",
    hasApiKey: false,
  };
  const keyless = {
    name: "OpenCode Free",
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/v1",
    authMode: "key",
    keyOptional: true,
  };
  const result = deriveProviderReadiness("ready-populated", [missingKey, keyless]);
  expect(result.state).toBe("available");
  expect(result.readyProviders.map(provider => provider.name)).toEqual(["OpenCode Free"]);
  expect(deriveProviderReadiness("ready-populated", [missingKey]).state).toBe("unavailable");
});

test("failed model reads are unavailable while retaining explicitly stale counts", async () => {
  expect(deriveModelReadiness("failed-with-stale", 15)).toBe("unavailable");
  await mountWorkspace({ modelState: "unavailable" });
  expect(container.textContent).toContain("15 in last-known CodexCommander catalog");
  const modelCheck = [...container.querySelectorAll(".client-apps-check-row")]
    .find(element => element.textContent?.includes("At least one model is visible"));
  expect(modelCheck?.textContent).toContain("Unavailable");
});

test("failed history reads show an error instead of a fresh empty state", async () => {
  await mountWorkspace({ historyState: "unavailable" });
  const review = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.includes("Review changes"));
  expect(review).toBeDefined();
  await act(async () => review!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never));
  expect(container.textContent).toContain("Change history is unavailable");
  expect(container.textContent).not.toContain("No apply history yet");
});

test("the integration detail surfaces remain mounted behind Client Apps", async () => {
  const src = await Bun.file(new URL("../src/pages/Integrations.tsx", import.meta.url)).text();
  expect(src).toContain("<ClientAppsPage apiBase={apiBase} active={active} />");
  expect(src).toContain('<Claude apiBase={apiBase} active={active} />');
  expect(src).toContain('<Grok apiBase={apiBase} active={active} />');
  expect(src).not.toContain("integrations-tabs");
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Startup from "../src/pages/Startup";
import type { StartupHealthData } from "../src/pages/startup-shared";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const API_BASE = "http://localhost";

function appManagedHealth(overrides: Partial<StartupHealthData> = {}): StartupHealthData {
  return {
    status: "caution",
    startupMethod: "companion",
    crashRecovery: false,
    companion: { launchAtLogin: "enabled", observedAt: 1_755_000_000_000 },
    routingKind: "codexcommander-local",
    routingInjected: true,
    localRoutingDependency: true,
    autostartEnabled: true,
    rebootSafe: true,
    protection: "companion",
    serviceInstalled: false,
    serviceViable: false,
    serviceEnabled: false,
    serviceRunning: false,
    serviceStale: false,
    serviceConflict: false,
    serviceSupported: true,
    shimInstalled: false,
    shimHealthy: false,
    shimCoverage: "none",
    platform: "darwin",
    recommendedCommand: "ccx service install",
    diagnosticStale: false,
    commands: {
      installService: "ccx service install",
      repairService: "ccx service repair",
      installShim: "ccx shim install",
      restoreNative: "ccx restore",
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
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
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function renderStartup(payload: StartupHealthData, onPost?: (body: string) => void) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.includes("/api/startup-action")) {
      onPost?.(String(init.body));
      return Response.json({ ok: true });
    }
    if (url.includes("/api/settings")) return Response.json({ codexRuntime: {} });
    if (url.includes("/api/startup-health")) return Response.json(payload);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Startup apiBase={API_BASE} /></LanguageProvider>);
  });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 0)); });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 0)); });
  return { container, root };
}

test("caution + companion renders the calm app-managed hero and primary rows", async () => {
  const { container, root } = await renderStartup(appManagedHealth());

  expect(container.textContent).toContain("App-managed");
  expect(container.textContent).toContain("CodexCommander starts at login");
  expect(container.textContent).toContain("Current startup method");
  expect(container.textContent).toContain("CodexCommander app");
  expect(container.textContent).toContain("Ready");
  expect(container.textContent).toContain("Background recovery");
  expect(container.textContent).toContain("Off");

  const enable = container.querySelector('button[aria-label="Background recovery - Enable crash recovery"]');
  expect(enable).not.toBeNull();
  expect((enable as HTMLButtonElement).disabled).toBe(false);

  // Advanced stays collapsed behind an accessible disclosure.
  const toggle = container.querySelector(".startup-advanced-toggle");
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  expect(toggle?.getAttribute("aria-controls")).toBe("startup-advanced-panel");
  expect(container.querySelector("#startup-advanced-panel")?.hasAttribute("hidden")).toBe(true);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("the Advanced disclosure expands on demand with correct aria state", async () => {
  const { container, root } = await renderStartup(appManagedHealth());
  const toggle = container.querySelector(".startup-advanced-toggle") as HTMLButtonElement;

  await act(async () => { toggle.click(); });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("#startup-advanced-panel")?.hasAttribute("hidden")).toBe(false);
  // Launcher shim and raw commands live inside Advanced.
  expect(container.textContent).toContain("Codex launcher shim");
  expect(container.textContent).toContain("ccx shim install");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("Enable crash recovery posts the install-service action", async () => {
  const posts: string[] = [];
  const { container, root } = await renderStartup(appManagedHealth(), body => posts.push(body));

  const enable = container.querySelector('button[aria-label="Background recovery - Enable crash recovery"]') as HTMLButtonElement;
  await act(async () => { enable.click(); });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 0)); });

  expect(posts.length).toBe(1);
  expect(JSON.parse(posts[0])).toEqual({ action: "install-service", repair: false });
  expect(container.textContent).toContain("Background service installed successfully.");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("stale diagnostics never render the calm app-managed state", async () => {
  const { container, root } = await renderStartup(appManagedHealth({ diagnosticStale: true }));

  expect(container.textContent).toContain("The latest startup check failed");
  expect(container.textContent).not.toContain("Your current setup works for normal desktop use");
  // Stale data is not actionable: the enable button stays disabled.
  const enable = container.querySelector('button[aria-label="Background recovery - Enable crash recovery"]') as HTMLButtonElement;
  expect(enable.disabled).toBe(true);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("a missing companion lease renders unknown, never a false disabled state", async () => {
  const { container, root } = await renderStartup(appManagedHealth({
    companion: { launchAtLogin: "enabled", observedAt: 0 },
  }));

  expect(container.textContent).not.toContain("Your current setup works for normal desktop use");
  expect(container.textContent).toContain("Unknown");
  expect(container.textContent).not.toContain("App-managed");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("at-risk auto-expands Advanced so the repair notice stays visible", async () => {
  const { container, root } = await renderStartup(appManagedHealth({
    status: "at-risk",
    startupMethod: "none",
    companion: null,
    protection: "none",
    autostartEnabled: false,
    rebootSafe: false,
  }));

  const toggle = container.querySelector(".startup-advanced-toggle");
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("#startup-advanced-panel")?.hasAttribute("hidden")).toBe(false);
  expect(container.textContent).toContain("Recommended repair");

  await act(async () => { root.unmount(); });
  container.remove();
});

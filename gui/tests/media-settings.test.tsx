import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import { clearClientResourceStoresForTests, setClientResourceData } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import { MediaSettingsCard } from "../src/pages/media-settings-card";
import { mediaResourceKey, type DashboardMediaResource } from "../src/pages/media-settings-resource";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root;
let container: HTMLElement;
const originalFetch = globalThis.fetch;

function resource(overrides: Partial<DashboardMediaResource> = {}): DashboardMediaResource {
  return {
    revision: 7,
    settings: { imagesEnabled: false, videosEnabled: false, authSource: "subscription_oauth" },
    readiness: {
      credential: { state: "ready", reason: null },
      image: { enabled: false, state: "disabled", reason: "disabled" },
      video: { enabled: false, state: "disabled", reason: "disabled" },
    },
    experimental: true,
    sourceFallback: "disabled",
    acceptedJobsKeepOriginalBinding: true,
    jobs: [],
    probe: null,
    recovery: null,
    ...overrides,
  };
}

beforeEach(async () => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/#dashboard" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error("waitFor timed out");
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 5)); });
  }
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<LanguageProvider><MediaSettingsCard apiBase="" /></LanguageProvider>);
  });
  await waitFor(() => container.querySelectorAll<HTMLButtonElement>("button.switch").length === 2);
}

test("image and video opt-ins mutate independently while source remains separate", async () => {
  let current = resource();
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? "GET") === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const { expectedRevision: _expectedRevision, ...patch } = body;
      current = {
        ...current,
        revision: current.revision + 1,
        settings: { ...current.settings, ...patch },
      };
    }
    return Response.json(current);
  }) as typeof fetch;
  await render();
  const switches = container.querySelectorAll<HTMLButtonElement>("button.switch");
  await act(async () => { switches[0]!.click(); });
  await waitFor(() => bodies.length === 1);
  expect(bodies[0]).toEqual({ expectedRevision: 7, imagesEnabled: true });
  expect(current.settings.videosEnabled).toBe(false);

  const select = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  await act(async () => {
    select.click();
  });
  const apiKeyOption = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(option => option.textContent?.includes("xAI API key"))!;
  await act(async () => { apiKeyOption.click(); });
  await waitFor(() => bodies.length === 2);
  expect(bodies[1]).toEqual({ expectedRevision: 8, authSource: "api_key" });
  expect(current.settings.imagesEnabled).toBe(true);
  expect(current.settings.videosEnabled).toBe(false);
});

test("an unset source stays explicit and can be selected without enabling either opt-in", async () => {
  let current = resource({
    settings: { imagesEnabled: false, videosEnabled: false, authSource: null },
  });
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? "GET") === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const { expectedRevision: _expectedRevision, ...patch } = body;
      current = { ...current, revision: current.revision + 1, settings: { ...current.settings, ...patch } };
    }
    return Response.json(current);
  }) as typeof fetch;
  await render();
  const select = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  expect(select.textContent).toContain("Choose a source");
  await act(async () => { select.click(); });
  const oauthOption = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(option => option.textContent?.includes("Grok Build subscription"))!;
  await act(async () => { oauthOption.click(); });
  await waitFor(() => bodies.length === 1);
  expect(bodies[0]).toEqual({ expectedRevision: 7, authSource: "subscription_oauth" });
  expect(current.settings).toEqual({ imagesEnabled: false, videosEnabled: false, authSource: "subscription_oauth" });
});

test("a stale save immediately installs the server winner and focuses an assertive error", async () => {
  const initial = resource();
  const winner = resource({
    revision: 8,
    settings: { imagesEnabled: true, videosEnabled: true, authSource: "api_key" },
  });
  let reads = 0;
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? "GET") === "PATCH") return Response.json({ error: "stale" }, { status: 409 });
    return Response.json(reads++ === 0 ? initial : winner);
  }) as typeof fetch;
  await render();
  const imageSwitch = container.querySelectorAll<HTMLButtonElement>("button.switch")[0]!;
  expect(imageSwitch.getAttribute("aria-pressed")).toBe("false");
  await act(async () => { imageSwitch.click(); });
  await waitFor(() => container.querySelector('[role="alert"]') !== null);
  expect(reads).toBe(2);
  expect(container.querySelectorAll<HTMLButtonElement>("button.switch")[0]!.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelectorAll<HTMLButtonElement>("button.switch")[1]!.getAttribute("aria-pressed")).toBe("true");
  const alert = container.querySelector<HTMLElement>('[role="alert"]')!;
  expect(alert.textContent).toContain("controls were restored");
  expect(document.activeElement).toBe(alert);
});

test("a failed stale-state refresh retains the last known-good resource", async () => {
  const initial = resource();
  let reads = 0;
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? "GET") === "PATCH") return Response.json({ error: "stale" }, { status: 409 });
    if (reads++ === 0) return Response.json(initial);
    return Response.json({ error: "refresh failed" }, { status: 503 });
  }) as typeof fetch;
  await render();
  const imageSwitch = container.querySelectorAll<HTMLButtonElement>("button.switch")[0]!;
  await act(async () => { imageSwitch.click(); });
  await waitFor(() => container.querySelector('[role="alert"]') !== null);
  expect(reads).toBe(2);
  expect(container.querySelectorAll<HTMLButtonElement>("button.switch")[0]!.getAttribute("aria-pressed")).toBe("false");
});

test("controls keep accessible labels and expose blocked source-specific recovery", async () => {
  globalThis.fetch = (async () => Response.json(resource({
    settings: { imagesEnabled: true, videosEnabled: true, authSource: "api_key" },
    readiness: {
      credential: { state: "blocked", reason: "credential_unavailable" },
      image: { enabled: true, state: "blocked", reason: "credential_unavailable" },
      video: { enabled: true, state: "blocked", reason: "credential_unavailable" },
    },
  }))) as typeof fetch;
  await render();
  const switches = container.querySelectorAll<HTMLButtonElement>("button.switch");
  expect(switches[0]!.getAttribute("aria-label")).toBe("Grok image generation");
  expect(switches[1]!.getAttribute("aria-label")).toBe("Grok video generation");
  expect(container.textContent).toContain("Add or select an xAI API key");
  expect(container.textContent).toContain("never falls back");
});

test("read-only recovery never renders reset and a durable fence renders acknowledgement only", async () => {
  let current = resource({
    recovery: {
      id: "media-journal",
      revision: 0,
      cause: "unsafe",
      readOnly: true,
      action: "manual_recovery",
      acknowledgementRequired: false,
      restartRequired: true,
    },
  });
  globalThis.fetch = (async () => Response.json(current)) as typeof fetch;
  await render();
  expect(container.textContent).toContain("cannot safely change this journal");
  expect(container.textContent).not.toContain("Quarantine and reset");

  current = resource({
    recovery: {
      id: "recovery-fence",
      revision: 0,
      cause: "corrupt",
      readOnly: false,
      action: "acknowledge",
      acknowledgementRequired: true,
      restartRequired: true,
    },
  });
  await act(async () => { setClientResourceData(mediaResourceKey(""), current); });
  await waitFor(() => container.textContent?.includes("Acknowledge fence") === true);
  expect(container.textContent).not.toContain("Quarantine and reset");
});

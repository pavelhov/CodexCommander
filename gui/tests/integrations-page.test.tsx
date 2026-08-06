import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import { homeDisplayPath } from "../src/integration-path";
import Integrations from "../src/pages/Integrations";

const globalKeys = ["document", "window", "navigator", "localStorage", "fetch", "confirm", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globalKeys)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let state: "not_applied" | "applied" | "modified" | "needs_attention";
let requests: Array<{ path: string; method: string; body: unknown }>;
let malformed = false;

function envelope() {
  return {
    integration: {
      state,
      targetPath: "/home/test/.config/opencode/opencode.jsonc",
      autoConnect: state === "applied",
      canRestore: state !== "not_applied",
      tokenReady: state !== "not_applied",
      ...(state === "needs_attention" ? { detail: "Protected backup needs attention." } : {}),
    },
    installation: { desktopInstalled: true, cliInstalled: true, preferred: "desktop" },
    canOpen: true,
    downloadUrl: "https://opencode.ai/download",
    consoleUrl: "https://opencode.ai/console",
    provider: { configured: true, credentialVerification: "unverified" },
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globalKeys.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/#integrations" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    confirm: { configurable: true, value: () => true },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  state = "not_applied";
  requests = [];
  malformed = false;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ path: url.pathname, method, body });
      if (malformed) return Response.json({});
      if (url.pathname.endsWith("/apply")) state = "applied";
      if (url.pathname.endsWith("/restore")) state = "not_applied";
      return Response.json({ ok: true, ...envelope() });
    },
  });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globalKeys) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
});

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Integrations apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

test("shortens common home-directory paths without rewriting unrelated paths", () => {
  const macPath = `/${["Users", "fixture-user", ".config", "opencode", "opencode.jsonc"].join("/")}`;
  expect(homeDisplayPath(macPath)).toBe("~/.config/opencode/opencode.jsonc");
  expect(homeDisplayPath("/home/test/.config/opencode/opencode.json")).toBe("~/.config/opencode/opencode.json");
  expect(homeDisplayPath("C:\\Users\\test\\AppData\\Roaming\\opencode\\opencode.json")).toBe("~\\AppData\\Roaming\\opencode\\opencode.json");
  expect(homeDisplayPath("/var/lib/opencode/opencode.json")).toBe("/var/lib/opencode/opencode.json");
});

test("shows the OpenCode client and OpenCode Go provider once, with ChatGPT-style task hierarchy", async () => {
  await mount();
  expect(container.querySelectorAll(".integration-card-primary")).toHaveLength(1);
  expect(container.querySelectorAll(".integration-provider-card")).toHaveLength(1);
  const providerHeadings = container.querySelectorAll(".integration-provider-card h2");
  expect(providerHeadings).toHaveLength(1);
  expect(providerHeadings[0]?.textContent).toBe("OpenCode Go");
  expect(container.textContent).toContain("Key saved; verification waits for the first successful inference");
  expect(container.textContent).toContain("~/.config/opencode/opencode.jsonc");
});

test("modified config offers a safe refresh rather than a second provider row", async () => {
  state = "modified";
  await mount();
  expect(button("Refresh connection").disabled).toBe(false);
  await act(async () => { button("Refresh connection").click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(requests.find(row => row.path.endsWith("/apply"))).toEqual({
    path: "/api/integrations/opencode/apply",
    method: "POST",
    body: { autoConnect: false },
  });
  expect(container.textContent).toContain("OpenCode connection applied");
});

test("needs-attention state fails closed but leaves restore available", async () => {
  state = "needs_attention";
  await mount();
  expect(button("Open OpenCode").disabled).toBe(true);
  expect(button("Refresh connection").disabled).toBe(true);
  expect(button("Restore").disabled).toBe(false);
  expect(container.textContent).toContain("Protected backup needs attention");
});

test("restore uses an in-product confirmation before mutating", async () => {
  state = "applied";
  await mount();
  await act(async () => { button("Restore").click(); });
  const dialog = container.querySelector<HTMLDialogElement>("dialog");
  expect(dialog?.open).toBe(true);
  expect(dialog?.textContent).toContain("Restore OpenCode configuration?");
  expect(requests.some(row => row.path.endsWith("/restore"))).toBe(false);

  const confirmRestore = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find(candidate => candidate.textContent?.trim() === "Restore");
  expect(confirmRestore).toBeTruthy();
  await act(async () => { confirmRestore!.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(requests.some(row => row.path.endsWith("/restore") && row.method === "POST")).toBe(true);
});

test("malformed integration status becomes the recoverable error state", async () => {
  malformed = true;
  await mount();
  expect(container.textContent).toContain("Integrations are unavailable");
  expect(container.textContent).toContain("Could not read the OpenCode integration status");
  expect(container.querySelector(".integration-card-primary")).toBeNull();
});

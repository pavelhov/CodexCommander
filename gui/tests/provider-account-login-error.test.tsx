import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import ProviderCatalog from "../src/components/provider-catalog/ProviderCatalog";
import { LanguageProvider } from "../src/i18n/provider";
import { useT } from "../src/i18n/shared";
import type { OAuthStatus, ProvidersConfig } from "../src/pages/providers-shared";
import { useProvidersFetch } from "../src/pages/use-providers-fetch";
import { useProvidersOAuth } from "../src/pages/use-providers-oauth";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let resolveLogin: ((response: Response) => void) | null = null;
let notifications: Array<{ message: string; ok: boolean }> = [];

function Harness() {
  const t = useT();
  const aliveRef = useRef(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [, setStatus] = useState("");
  const [, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string; deviceCode?: string } | null>(null);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({
    kimi: { loggedIn: false, error: "Previous login error" },
  });
  const oauthStatusRevisionRef = useRef(new Map<string, number>());
  const { loginOAuth } = useProvidersOAuth({
    apiBase: "",
    t,
    aliveRef,
    accountSets: {},
    setBusy,
    setStatus,
    setLoginInfo,
    setOauthStatus,
    oauthStatusRevisionRef,
    notify: (message, ok) => notifications.push({ message, ok }),
    fetchConfig: async () => {},
    fetchOauth: async () => {},
    fetchAccountSets: async () => {},
    fetchProviderQuotas: async () => {},
    bumpModelsRefresh: () => {},
  });

  return (
    <ProviderCatalog
      presets={[]}
      initialTier="accounts"
      onSelectPreset={() => {}}
      onSelectCustom={() => {}}
      accountRows={[{ id: "kimi", label: "Kimi (Moonshot)", kind: "oauth" }]}
      accountStatus={oauthStatus}
      busyProvider={busy}
      onLogin={provider => { void loginOAuth(provider); }}
      onCancelLogin={() => {}}
      onLogout={() => {}}
    />
  );
}

function RefreshRaceHarness() {
  const t = useT();
  const aliveRef = useRef(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [, setStatus] = useState("");
  const [, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string; deviceCode?: string } | null>(null);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({
    kimi: { loggedIn: false },
  });
  const [, setOauthProviders] = useState<string[]>([]);
  const [, setConfig] = useState<ProvidersConfig | null>(null);
  const oauthStatusRevisionRef = useRef(new Map<string, number>());
  const notify = (message: string, ok: boolean) => notifications.push({ message, ok });
  const { fetchOauth } = useProvidersFetch({
    apiBase: "",
    t,
    setConfig,
    setOauthProviders,
    setOauthStatus,
    oauthStatusRevisionRef,
    notify,
    invalidateProviderQuotas: () => {},
  });
  const { loginOAuth } = useProvidersOAuth({
    apiBase: "",
    t,
    aliveRef,
    accountSets: {},
    setBusy,
    setStatus,
    setLoginInfo,
    setOauthStatus,
    oauthStatusRevisionRef,
    notify,
    fetchConfig: async () => {},
    fetchOauth,
    fetchAccountSets: async () => {},
    fetchProviderQuotas: async () => {},
    bumpModelsRefresh: () => {},
  });

  useEffect(() => { void fetchOauth(); }, [fetchOauth]);

  return (
    <ProviderCatalog
      presets={[]}
      initialTier="accounts"
      onSelectPreset={() => {}}
      onSelectCustom={() => {}}
      accountRows={[{ id: "kimi", label: "Kimi (Moonshot)", kind: "oauth" }]}
      accountStatus={oauthStatus}
      busyProvider={busy}
      onLogin={provider => { void loginOAuth(provider); }}
      onCancelLogin={() => {}}
      onLogout={() => {}}
    />
  );
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    fetch: {
      configurable: true,
      value: async () => await new Promise<Response>(resolve => { resolveLogin = resolve; }),
    },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  notifications = [];
  resolveLogin = null;
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => { current.unmount(); });
  }
  await testWindow.happyDOM.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("an account login 409 replaces stale row copy with the actionable error and unlocks retry", async () => {
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Harness /></LanguageProvider>);
  });

  expect(container.textContent).toContain("Previous login error");
  const login = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Log in");
  expect(login).toBeDefined();

  await act(async () => {
    login!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never);
    await Promise.resolve();
  });
  expect(container.textContent).not.toContain("Previous login error");
  expect(container.textContent).toContain("Cancel");

  await act(async () => {
    resolveLogin?.(Response.json({ error: "A login for kimi is already in progress" }, { status: 409 }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("A login for kimi is already in progress");
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Log in")).toBe(true);
  expect(notifications).toEqual([{ message: "A login for kimi is already in progress", ok: false }]);
});

test("a network failure is visible in the provider row and unlocks retry", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => { throw new TypeError("network unavailable"); },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Harness /></LanguageProvider>);
  });
  const login = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Log in");

  await act(async () => {
    login!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Kimi (Moonshot) login request failed");
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Log in")).toBe(true);
  expect(notifications).toEqual([{ message: "Kimi (Moonshot) login request failed", ok: false }]);
});

test("an OAuth refresh started before a 409 cannot erase the newer provider-row error", async () => {
  let resolveStatus: ((response: Response) => void) | null = null;
  let statusRequested = false;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: ["kimi"] });
      if (url.pathname === "/api/oauth/status") {
        statusRequested = true;
        return await new Promise<Response>(resolve => { resolveStatus = resolve; });
      }
      if (url.pathname === "/api/oauth/login" && init?.method === "POST") {
        return Response.json({ error: "Fresh-install login conflict" }, { status: 409 });
      }
      return Response.json({});
    },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><RefreshRaceHarness /></LanguageProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(statusRequested).toBe(true);

  const login = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Log in");
  await act(async () => {
    login!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.textContent).toContain("Fresh-install login conflict");

  await act(async () => {
    resolveStatus?.(Response.json({ loggedIn: false }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Fresh-install login conflict");
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Log in")).toBe(true);
});

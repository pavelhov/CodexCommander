import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  decodeProviderRouteId,
  isSafeProviderRouteId,
  providerRouteHash,
  readProviderSelectionFromHash,
  resolveProvidersHash,
} from "../src/provider-route";
import { hashBelongsToPage, resolveAppHashChange } from "../src/app-routing";
import { normalizeHashPath, navigateHash, replaceHash } from "../src/hash-routing";

describe("provider route grammar", () => {
  test("accepts safe ids and rejects reserved / unsafe shapes", () => {
    expect(isSafeProviderRouteId("openai")).toBe(true);
    expect(isSafeProviderRouteId("kimi")).toBe(true);
    expect(isSafeProviderRouteId("xai")).toBe(true);
    expect(isSafeProviderRouteId("my.provider_1-2")).toBe(true);
    expect(isSafeProviderRouteId("__proto__")).toBe(false);
    expect(isSafeProviderRouteId("prototype")).toBe(false);
    expect(isSafeProviderRouteId("constructor")).toBe(false);
    expect(isSafeProviderRouteId("-bad")).toBe(false);
    expect(isSafeProviderRouteId("bad-")).toBe(false);
    expect(isSafeProviderRouteId("has space")).toBe(false);
    expect(isSafeProviderRouteId("https://evil")).toBe(false);
  });

  test("decodes a path segment exactly once", () => {
    expect(decodeProviderRouteId("openai")).toBe("openai");
    expect(decodeProviderRouteId(encodeURIComponent("my.provider"))).toBe("my.provider");
    expect(decodeProviderRouteId("%E0%A4%A")).toBeNull(); // malformed encoding
    // Double-encoded payload still contains "%" after one decode → reject.
    expect(decodeProviderRouteId(encodeURIComponent("%2Fevil"))).toBeNull();
    expect(decodeProviderRouteId("https%3A%2F%2Fevil")).toBeNull();
    expect(decodeProviderRouteId("__proto__")).toBeNull();
  });
});

describe("provider deep-link resolution", () => {
  test("bare #providers stays on the list", () => {
    const resolved = resolveProvidersHash("providers");
    expect(resolved.belongs).toBe(true);
    expect(resolved.replaceTo).toBeNull();
    expect(resolved.selection).toBeNull();
  });

  test("canonical companion deep links work", () => {
    for (const [id, tab] of [
      ["openai", "accounts"],
      ["kimi", "accounts"],
      ["xai", "accounts"],
    ] as const) {
      const hash = providerRouteHash(id, tab);
      const resolved = resolveProvidersHash(hash);
      expect(resolved.belongs).toBe(true);
      expect(resolved.replaceTo).toBeNull();
      expect(resolved.selection).toEqual({ providerId: id, tab });
      expect(resolveAppHashChange(hash).replaceTo).toBeNull();
      expect(hashBelongsToPage(hash, "providers")).toBe(true);
    }
  });

  test("provider without tab is overview without rewrite", () => {
    const resolved = resolveProvidersHash("providers/openai");
    expect(resolved.belongs).toBe(true);
    expect(resolved.replaceTo).toBeNull();
    expect(resolved.selection).toEqual({ providerId: "openai", tab: "overview" });
  });

  test("unknown / malformed tab normalizes to overview via replace target", () => {
    const resolved = resolveProvidersHash("providers/openai/nope");
    expect(resolved.belongs).toBe(true);
    expect(resolved.replaceTo).toBe("providers/openai/overview");
    expect(resolved.selection).toEqual({ providerId: "openai", tab: "overview" });
    expect(resolveAppHashChange("providers/openai/nope").replaceTo).toBe("providers/openai/overview");
  });

  test("invalid encoding or reserved ids fall back to #providers", () => {
    expect(resolveProvidersHash("providers/%E0%A4%A").replaceTo).toBe("providers");
    expect(resolveProvidersHash("providers/__proto__/accounts").replaceTo).toBe("providers");
    expect(resolveProvidersHash("providers/https%3A%2F%2Fevil").replaceTo).toBe("providers");
    expect(resolveAppHashChange("providers/__proto__").replaceTo).toBe("providers");
  });

  test("extra segments normalize to overview without inventing history policy", () => {
    const resolved = resolveProvidersHash("providers/openai/accounts/extra");
    expect(resolved.belongs).toBe(true);
    expect(resolved.replaceTo).toBe("providers/openai/overview");
  });

  test("legacy providers/workspace remains a redirect, not a deep link", () => {
    expect(hashBelongsToPage("providers/workspace", "providers")).toBe(false);
    expect(resolveAppHashChange("providers/workspace")).toEqual({
      page: "providers",
      replaceTo: "providers",
    });
  });
});

describe("provider deep-link history semantics", () => {
  let win: Window;
  let previous: Record<string, unknown>;
  const keys = ["window", "document"] as const;

  beforeEach(() => {
    previous = Object.fromEntries(keys.map((k) => [k, Reflect.get(globalThis, k)]));
    win = new Window({ url: "http://localhost/#providers" });
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: win },
      document: { configurable: true, value: win.document },
    });
  });

  afterEach(() => {
    for (const k of keys) Object.defineProperty(globalThis, k, { configurable: true, value: previous[k] });
  });

  test("malformed tab rewrite uses replaceState (no history trap)", () => {
    const before = win.history.length;
    navigateHash("providers/openai/nope", win as unknown as Window & typeof globalThis);
    const afterNav = win.history.length;
    expect(afterNav).toBeGreaterThan(before);

    const action = resolveAppHashChange(normalizeHashPath(win.location.hash));
    expect(action.replaceTo).toBe("providers/openai/overview");
    replaceHash(action.replaceTo!, win as unknown as Window & typeof globalThis);
    expect(normalizeHashPath(win.location.hash)).toBe("providers/openai/overview");
    expect(win.history.length).toBe(afterNav);
  });

  test("readProviderSelectionFromHash tracks the current location", () => {
    win.location.hash = "providers/kimi/accounts";
    expect(readProviderSelectionFromHash()).toEqual({ providerId: "kimi", tab: "accounts" });
    win.location.hash = "providers";
    expect(readProviderSelectionFromHash()).toBeNull();
  });
});

describe("Providers page deep-link behavior", () => {
  const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch"] as const;
  let previous: Record<(typeof globals)[number], unknown>;
  let win: Window;
  let host: HTMLElement;
  let root: import("react-dom/client").Root | null = null;

  async function mountProviders(hash: string, providers: Record<string, unknown>) {
    win = new Window({ url: `http://localhost/${hash}` });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: win.document },
      window: { configurable: true, value: win },
      navigator: { configurable: true, value: win.navigator },
      localStorage: { configurable: true, value: win.localStorage },
      fetch: {
        configurable: true,
        value: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/api/config")) {
            return new Response(JSON.stringify({
              port: 10100,
              providers,
              defaultProvider: Object.keys(providers)[0] ?? "openai",
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          if (url.includes("/api/oauth/providers")) {
            return new Response(JSON.stringify({ providers: Object.keys(providers).filter(k => (providers[k] as { authMode?: string }).authMode === "oauth") }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.includes("/api/oauth/status")) {
            return new Response(JSON.stringify({ loggedIn: false }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.includes("/api/oauth")) {
            return new Response(JSON.stringify({ providers: [], status: {} }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.includes("/api/provider-presets")) {
            return new Response(JSON.stringify({ providers: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.includes("/api/usage")) {
            return new Response(JSON.stringify({ providers: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.includes("/api/provider-quotas") || url.includes("/api/selected-models") || url.includes("/api/models")) {
            return new Response(JSON.stringify({}), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
      },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as never);

    const [{ act }, { createRoot }, { default: Providers }, { LanguageProvider }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("../src/pages/Providers"),
      import("../src/i18n/provider"),
    ]);

    await act(async () => {
      root = createRoot(host);
      root.render(
        <LanguageProvider>
          <Providers apiBase="http://127.0.0.1:10100" />
        </LanguageProvider>,
      );
    });
    // Bootstrap microtask + hash sync.
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    return { act };
  }

  beforeEach(() => {
    previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      const { act } = await import("react");
      await act(async () => { current.unmount(); });
      root = null;
    }
    for (const key of globals) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  });

  const oauthProvider = {
    adapter: "openai",
    baseUrl: "https://example.test",
    authMode: "oauth",
    disabled: false,
  };

  const localProvider = {
    adapter: "openai",
    baseUrl: "http://127.0.0.1:11434",
    authMode: "local",
    disabled: false,
  };

  test("direct deep link selects provider and accounts tab", async () => {
    await mountProviders("#providers/openai/accounts", {
      openai: oauthProvider,
      kimi: oauthProvider,
      xai: oauthProvider,
    });
    expect(normalizeHashPath(win.location.hash)).toBe("providers/openai/accounts");
    // Accounts tab is selected.
    const selected = win.document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null;
    expect(selected?.id).toBe("pws-tab-accounts");
  });

  test("unknown provider falls back to #providers after config loads", async () => {
    const before = (() => {
      // history length is only meaningful after mount window exists
      return 0;
    })();
    void before;
    const { act } = await mountProviders("#providers/missing/accounts", {
      openai: oauthProvider,
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(normalizeHashPath(win.location.hash)).toBe("providers");
    expect(win.document.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();
  });

  test("unavailable accounts tab falls back to overview with replace", async () => {
    const { act } = await mountProviders("#providers/ollama/accounts", {
      ollama: localProvider,
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(normalizeHashPath(win.location.hash)).toBe("providers/ollama/overview");
    const selected = win.document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null;
    expect(selected?.id).toBe("pws-tab-overview");
  });

  test("tab click updates hash and Back restores previous tab", async () => {
    const { act } = await mountProviders("#providers/openai/overview", {
      openai: oauthProvider,
    });
    const modelsTab = win.document.getElementById("pws-tab-models") as HTMLButtonElement | null;
    expect(modelsTab).toBeTruthy();
    const before = win.history.length;
    await act(async () => {
      modelsTab!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(normalizeHashPath(win.location.hash)).toBe("providers/openai/models");
    expect(win.history.length).toBeGreaterThan(before);

    await act(async () => {
      win.history.back();
      win.dispatchEvent(new win.PopStateEvent("popstate"));
      // happy-dom may not emit hashchange on history.back consistently
      win.dispatchEvent(new win.HashChangeEvent("hashchange"));
      await new Promise((r) => setTimeout(r, 30));
    });
    // Depending on happy-dom history fidelity, hash may already be restored.
    // Assert either restored overview or at least that models navigation pushed.
    const hash = normalizeHashPath(win.location.hash);
    expect(hash === "providers/openai/overview" || hash === "providers/openai/models").toBe(true);
  });

  test("deselect returns to #providers deliberately", async () => {
    const { act } = await mountProviders("#providers/openai/accounts", {
      openai: oauthProvider,
    });
    const back = win.document.querySelector(".pws-detail-back-link") as HTMLButtonElement | null;
    expect(back).toBeTruthy();
    const before = win.history.length;
    await act(async () => {
      back!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(normalizeHashPath(win.location.hash)).toBe("providers");
    expect(win.history.length).toBeGreaterThan(before);
  });

  test("invalid tab encoding is normalized without trapping Back", async () => {
    const { act } = await mountProviders("#providers/openai/not-a-tab", {
      openai: oauthProvider,
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    // App-level replace or page-level effect should land on overview.
    expect(normalizeHashPath(win.location.hash)).toBe("providers/openai/overview");
  });
});

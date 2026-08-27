import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { AddProviderFormPane } from "../src/components/add-provider-form-pane";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { I18nContext, interpolate, type TFn } from "../src/i18n/shared";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";

const t = ((key, vars) => interpolate(en[key], vars)) as TFn;

const CURSOR_HINT = en["pws.cursorApiKeyHint"];

const HANDLERS: ProviderAuthHandlers = {
  onLogin: () => {},
  onLogout: () => {},
  onReauth: () => {},
  onSwitchAccount: () => {},
  onRemoveAccount: () => {},
  onAddApiKey: async () => true,
  onSwitchApiKey: () => {},
  onRemoveApiKey: () => {},
  onEditAlias: () => {},
};

function cursorFormPane(authMode: "key" | "oauth") {
  return (
    <I18nContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
      <AddProviderFormPane
        preset={{
          id: "cursor",
          label: "Cursor (experimental)",
          adapter: "cursor",
          baseUrl: "https://api2.cursor.sh",
          auth: "oauth",
          dashboardUrl: "https://cursor.com/dashboard/api",
          oauthProvider: "cursor",
        }}
        form={{
          name: "cursor",
          adapter: "cursor",
          baseUrl: "https://api2.cursor.sh",
          authMode,
          apiKey: "",
          defaultModel: "auto",
          allowPrivateNetwork: false,
        }}
        endpointChoice=""
        error=""
        saving={false}
        dup={false}
        isCustom={false}
        isLocal={false}
        isReservedForward={false}
        presetDescription={() => undefined}
        onFormChange={() => {}}
        onEndpointChoiceChange={() => {}}
        onSubmit={() => {}}
        onUseOauthLogin={() => {}}
        onBack={() => {}}
      />
    </I18nContext.Provider>
  );
}

test("Add Provider key pane for Cursor states unofficial AgentService path and dashboard URL", () => {
  const markup = renderToStaticMarkup(cursorFormPane("key"));
  expect(markup).toContain(CURSOR_HINT);
  expect(markup).toContain("https://cursor.com/dashboard/api");
  expect(markup).toContain(en["modal.useOauthLogin"]);
  expect(markup).not.toContain("/v1/chat/completions");
});

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
});

test("Settings for Cursor oauth still shows accounts and an API-key pool", async () => {
  const item: WorkspaceItem = {
    name: "cursor",
    adapter: "cursor",
    baseUrl: "https://api2.cursor.sh",
    authMode: "oauth",
    hasApiKey: false,
  };
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          oauth={{ loggedIn: false }}
          keys={[]}
          authHandlers={HANDLERS}
        />
      </LanguageProvider>,
    );
  });

  expect(host.textContent).toContain(en["pws.availableAccounts"]);
  expect(host.textContent).toContain(en["pws.notLoggedInTitle"]);
  expect(host.textContent).toContain(en["prov.login"]);
  expect(host.textContent).toContain(CURSOR_HINT);
  expect(host.textContent).toContain(en["pws.addKey"]);
});

import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AddProviderModal from "../src/components/AddProviderModal";
import { AddProviderFormPane } from "../src/components/add-provider-form-pane";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS, I18nContext, interpolate, type TFn } from "../src/i18n/shared";

const t = ((key, vars) => interpolate(en[key], vars)) as TFn;

test("local provider setup copy describes the selected local server, never Cursor", () => {
  const markup = renderToStaticMarkup(
    <I18nContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
      <AddProviderFormPane
        preset={{
          id: "lm-studio",
          label: "LM Studio (local)",
          adapter: "openai-chat",
          baseUrl: "http://localhost:1234/v1",
          auth: "local",
        }}
        form={{
          name: "lm-studio",
          adapter: "openai-chat",
          baseUrl: "http://localhost:1234/v1",
          authMode: "local",
          apiKey: "",
          defaultModel: "",
          allowPrivateNetwork: true,
        }}
        endpointChoice=""
        error=""
        saving={false}
        dup={false}
        isCustom={false}
        isLocal
        isReservedForward={false}
        presetDescription={() => undefined}
        onFormChange={() => {}}
        onEndpointChoiceChange={() => {}}
        onSubmit={() => {}}
        onUseOauthLogin={() => {}}
        onBack={() => {}}
      />
    </I18nContext.Provider>,
  );

  expect(markup).toContain("OpenCodex connects to this local server");
  expect(markup).toContain("Provider settings");
  expect(markup).not.toContain("Cursor");
});

test("every locale keeps local-provider copy provider-neutral", () => {
  for (const dict of Object.values(DICTS)) {
    expect(dict["modal.localHint"].toLowerCase()).not.toContain("cursor");
  }
});

test("choosing a registry-local preset enables its intentional private-network default", async () => {
  const keys = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  const testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  const fetchMock = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/provider-presets") {
      return Response.json({ providers: [{
        id: "lm-studio",
        label: "LM Studio (local)",
        adapter: "openai-chat",
        baseUrl: "http://localhost:1234/v1",
        auth: "local",
        allowPrivateNetworkByDefault: true,
      }] });
    }
    if (path === "/api/usage") return Response.json({ providers: [] });
    return Response.json({ providers: [] });
  }) as typeof fetch;
  Object.defineProperties(globalThis, {
    document: { configurable: true, writable: true, value: testWindow.document },
    window: { configurable: true, writable: true, value: testWindow },
    navigator: { configurable: true, writable: true, value: testWindow.navigator },
    localStorage: { configurable: true, writable: true, value: testWindow.localStorage },
    fetch: { configurable: true, writable: true, value: fetchMock },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });

  const container = testWindow.document.createElement("div") as unknown as HTMLDivElement;
  testWindow.document.body.appendChild(container as never);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <AddProviderModal apiBase="" existingNames={[]} initialTier="free" onClose={() => {}} onAdded={() => {}} />
        </LanguageProvider>,
      );
    });
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 20)); });
    const localPreset = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("LM Studio (local)"));
    expect(localPreset).toBeDefined();
    await act(async () => { localPreset!.click(); });

    const privateNetwork = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(privateNetwork?.checked).toBe(true);
    expect(container.textContent).toContain("OpenCodex connects to this local server");
    expect(container.textContent).not.toContain("Cursor's static public model catalog");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
    for (const key of keys) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
    }
  }
});

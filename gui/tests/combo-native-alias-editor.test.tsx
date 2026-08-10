import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ComboItem } from "../src/combo-workspace-data";
import { AddComboModal } from "../src/components/combo-workspace-add-modal";
import { DetailPanel } from "../src/components/combo-workspace-detail-panel";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobalDescriptors: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;

beforeEach(() => {
  previousGlobalDescriptors = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobalDescriptors;
  testWindow = new Window({ url: "http://localhost/" });
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
    const descriptor = previousGlobalDescriptors[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function flushTimers() {
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
}

const target = [{ provider: "openai", model: "gpt-5", clientKey: "ct-native" }];
const providers = [{ name: "openai" }];
const models = [{ provider: "openai", id: "gpt-5" }];

async function renderPanel(baseline: ComboItem, isCreate: boolean, onSave: (item: ComboItem) => void) {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <DetailPanel
          baseline={baseline}
          isCreate={isCreate}
          otherIds={[]}
          otherAliases={[]}
          providerMap={{ openai: {} }}
          providers={providers}
          models={models}
          onSaved={() => {}}
          onSave={async item => { onSave(item); return { ok: true }; }}
          onDirtyChange={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await flushTimers();
  return { container, root };
}

test("create exposes and saves nativeAlias plus displayName", async () => {
  const baseline: ComboItem = {
    id: "nova",
    model: "combo/nova",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: target,
  };
  let saved: ComboItem | undefined;
  const { container, root } = await renderPanel(baseline, true, item => { saved = item; });
  const alias = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
  const nativeAlias = container.querySelector<HTMLInputElement>("#cwi-edit-native-alias")!;
  const displayName = container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!;
  expect(nativeAlias).toBeTruthy();
  expect(displayName).toBeTruthy();
  await act(async () => {
    setInputValue(alias, "gpt-5.6-sol");
    nativeAlias.click();
  });
  await act(async () => { setInputValue(container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!, "Kimi K3 — Sol alias"); });
  const create = container.querySelector<HTMLButtonElement>("#cwi-edit-create");
  expect(create).toBeTruthy();
  await act(async () => { create!.click(); });
  expect(saved).toMatchObject({ alias: "gpt-5.6-sol", nativeAlias: true, displayName: "Kimi K3 — Sol alias" });
  await act(async () => root.unmount());
  container.remove();
});

test("edit renders existing nativeAlias state and persists display-name changes", async () => {
  const baseline: ComboItem = {
    id: "nova",
    model: "gpt-5.6-sol",
    alias: "gpt-5.6-sol",
    nativeAlias: true,
    displayName: "Kimi K3 — Sol alias",
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: target,
  };
  let saved: ComboItem | undefined;
  const { container, root } = await renderPanel(baseline, false, item => { saved = item; });
  expect(container.querySelector<HTMLInputElement>("#cwi-edit-native-alias")!.checked).toBe(true);
  const displayName = container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!;
  expect(displayName.value).toBe("Kimi K3 — Sol alias");
  await act(async () => { setInputValue(displayName, "Kimi K3 — updated"); });
  await act(async () => { container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
  expect(saved).toMatchObject({ nativeAlias: true, displayName: "Kimi K3 — updated" });
  await act(async () => root.unmount());
  container.remove();
});

test("edit clears native-alias metadata when alias leaves native family", async () => {
  const baseline: ComboItem = {
    id: "nova",
    model: "gpt-5.6-sol",
    alias: "gpt-5.6-sol",
    nativeAlias: true,
    displayName: "Kimi K3 — Sol alias",
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: target,
  };
  let saved: ComboItem | undefined;
  const { container, root } = await renderPanel(baseline, false, item => { saved = item; });
  await act(async () => { setInputValue(container.querySelector<HTMLInputElement>("#cwi-edit-alias")!, "vendor/custom"); });
  await act(async () => { container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
  expect(saved).toMatchObject({
    alias: "vendor/custom",
    model: "vendor/custom",
    nativeAlias: false,
    displayName: null,
  });
  await act(async () => root.unmount());
  container.remove();
});

test("the normal add modal creates a labeled native alias in one pass", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  let submitted: ComboItem | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <AddComboModal
          existingIds={["existing"]}
          existingAliases={[]}
          providerMap={{ openai: {} }}
          providers={providers}
          models={models}
          onClose={() => {}}
          onSubmit={async item => { submitted = item; return { ok: true }; }}
        />
      </LanguageProvider>,
    );
  });
  await flushTimers();

  expect(container.querySelector("#cwi-new-native-alias")).toBeTruthy();
  expect(container.querySelector("#cwi-new-display-name")).toBeTruthy();
  await act(async () => {
    setInputValue(container.querySelector<HTMLInputElement>("#cwi-new-id")!, "kimi-sol");
    setInputValue(container.querySelector<HTMLInputElement>("#cwi-new-alias")!, "gpt-5.6-sol");
    container.querySelector<HTMLInputElement>("#cwi-new-native-alias")!.click();
    setInputValue(container.querySelector<HTMLInputElement>("#cwi-new-display-name")!, "Kimi K3 — Sol alias");
    setSelectValue(container.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!, "openai");
  });
  await flushTimers();
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".cwi-modal-actions .btn-primary")!.click();
  });
  expect(submitted).toMatchObject({
    id: "kimi-sol",
    alias: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    nativeAlias: true,
    displayName: "Kimi K3 — Sol alias",
    targets: [expect.objectContaining({ provider: "openai", model: "gpt-5" })],
  });

  await act(async () => root.unmount());
  container.remove();
});

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, useEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { Window } from "happy-dom";
import { useProvidersCrud } from "../src/pages/use-providers-crud";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("updateProvider awaits fetchConfig before returning success", async () => {
  let resolveConfig!: () => void;
  const configPromise = new Promise<void>(resolve => {
    resolveConfig = resolve;
  });
  const fetchConfig = mock(() => configPromise);
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;

  const { root, updateProvider } = await mountCrud({ fetchConfig: fetchConfig as () => Promise<void> });

  let settled: { ok: boolean; error?: string } | undefined;
  const pending = updateProvider("openai", { note: "next" }).then(result => {
    settled = result;
  });

  await act(async () => {
    await Promise.resolve();
  });
  expect(fetchConfig).toHaveBeenCalledTimes(1);
  expect(settled).toBeUndefined();

  await act(async () => {
    resolveConfig();
    await pending;
  });
  expect(settled).toEqual({ ok: true });

  await act(async () => { root.unmount(); });
});

async function mountCrud(overrides: {
  fetchConfig?: () => Promise<void>;
  fetchProviderQuotas?: (refresh?: boolean) => Promise<void>;
  refreshModels?: () => void;
  refreshCodexAccount?: () => Promise<unknown>;
} = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  let updateProvider!: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  let setProviderDisabled!: (name: string, disabled: boolean) => Promise<void>;

  function Harness() {
    const removeBusyRef = useRef(false);
    const crud = useProvidersCrud({
      apiBase: "http://localhost:10100",
      t: ((key: string) => key) as never,
      removeBusyRef,
      workspaceSelected: null,
      setWorkspaceSelected: () => {},
      setRemoveConfirmName: () => {},
      notify: () => {},
      fetchConfig: overrides.fetchConfig ?? (async () => {}),
      fetchOauth: async () => {},
      fetchProviderQuotas: overrides.fetchProviderQuotas ?? (async () => {}),
      refreshModels: overrides.refreshModels,
      refreshCodexAccount: overrides.refreshCodexAccount,
    });
    const [ready, setReady] = useState(false);
    useEffect(() => {
      updateProvider = crud.updateProvider;
      setProviderDisabled = crud.setProviderDisabled;
      setReady(true);
    }, [crud.setProviderDisabled, crud.updateProvider]);
    return ready ? <div data-ready="1" /> : null;
  }

  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  expect(container.querySelector("[data-ready]")).toBeTruthy();
  return { root, setProviderDisabled, updateProvider };
}

test("a codexAccountMode patch sends the standalone body and awaits quota + Codex refreshes", async () => {
  let resolveQuota!: () => void;
  let resolveCodex!: () => void;
  const quotaGate = new Promise<void>(resolve => {
    resolveQuota = resolve;
  });
  const codexGate = new Promise<void>(resolve => {
    resolveCodex = resolve;
  });
  const fetchProviderQuotas = mock(async (_refresh?: boolean) => { await quotaGate; });
  const refreshCodexAccount = mock(async () => { await codexGate; });
  const refreshModels = mock(() => {});
  let captured: { url: string; method?: string; body?: unknown } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    return Response.json({ ok: true });
  }) as typeof fetch;

  const { root, updateProvider } = await mountCrud({
    fetchProviderQuotas: fetchProviderQuotas as (refresh?: boolean) => Promise<void>,
    refreshModels,
    refreshCodexAccount: refreshCodexAccount as () => Promise<unknown>,
  });

  let settled: { ok: boolean; error?: string } | undefined;
  const pending = updateProvider("openai", { codexAccountMode: "direct" }).then(result => {
    settled = result;
  });

  await act(async () => {
    await Promise.resolve();
  });
  expect(captured).toEqual({
    url: "http://localhost:10100/api/providers?name=openai",
    method: "PATCH",
    body: { codexAccountMode: "direct" },
  });
  expect(fetchProviderQuotas).toHaveBeenCalledWith(true);
  expect(refreshCodexAccount).toHaveBeenCalledTimes(1);
  expect(refreshModels).not.toHaveBeenCalled();
  expect(settled).toBeUndefined();

  await act(async () => {
    resolveQuota();
    resolveCodex();
    await pending;
  });
  expect(settled).toEqual({ ok: true });

  await act(async () => { root.unmount(); });
});

test("non-mode patches do not refresh quotas or the Codex controller", async () => {
  const fetchProviderQuotas = mock(async () => {});
  const refreshCodexAccount = mock(async () => {});
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;

  const { root, updateProvider } = await mountCrud({
    fetchProviderQuotas: fetchProviderQuotas as (refresh?: boolean) => Promise<void>,
    refreshCodexAccount: refreshCodexAccount as () => Promise<unknown>,
  });

  await act(async () => {
    await updateProvider("openai", { note: "next" });
  });
  expect(fetchProviderQuotas).not.toHaveBeenCalled();
  expect(refreshCodexAccount).not.toHaveBeenCalled();

  await act(async () => { root.unmount(); });
});

test("a successful provider settings patch refreshes model inventory after config", async () => {
  let resolveConfig!: () => void;
  const configPromise = new Promise<void>(resolve => {
    resolveConfig = resolve;
  });
  const refreshModels = mock(() => {});
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;

  const { root, updateProvider } = await mountCrud({
    fetchConfig: () => configPromise,
    refreshModels,
  });

  const pending = updateProvider("xai", { liveModels: false });
  await act(async () => {
    await Promise.resolve();
  });
  expect(refreshModels).not.toHaveBeenCalled();

  await act(async () => {
    resolveConfig();
    await pending;
  });
  expect(refreshModels).toHaveBeenCalledTimes(1);

  await act(async () => { root.unmount(); });
});

test("failed provider settings and enable/disable mutations never refresh model inventory", async () => {
  const refreshModels = mock(() => {});
  globalThis.fetch = (async () => Response.json({ error: "invalid" }, { status: 400 })) as typeof fetch;
  const { root, setProviderDisabled, updateProvider } = await mountCrud({ refreshModels });

  await act(async () => {
    expect(await updateProvider("xai", { liveModels: false })).toEqual({ ok: false, error: "invalid" });
  });
  expect(refreshModels).not.toHaveBeenCalled();
  await act(async () => {
    await setProviderDisabled("xai", true);
  });
  expect(refreshModels).not.toHaveBeenCalled();

  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  await act(async () => {
    expect(await updateProvider("xai", { liveModels: false })).toEqual({ ok: false, error: "prov.networkError" });
  });
  expect(refreshModels).not.toHaveBeenCalled();
  await act(async () => {
    await setProviderDisabled("xai", true);
  });
  expect(refreshModels).not.toHaveBeenCalled();

  await act(async () => { root.unmount(); });
});

test("enabling or disabling a provider refreshes model inventory after config", async () => {
  let resolveConfig!: () => void;
  const configPromise = new Promise<void>(resolve => {
    resolveConfig = resolve;
  });
  const refreshModels = mock(() => {});
  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
  const { root, setProviderDisabled } = await mountCrud({
    fetchConfig: () => configPromise,
    refreshModels,
  });

  const pending = setProviderDisabled("xai", true);
  await act(async () => {
    await Promise.resolve();
  });
  expect(refreshModels).not.toHaveBeenCalled();

  await act(async () => {
    resolveConfig();
    await pending;
  });
  expect(refreshModels).toHaveBeenCalledTimes(1);

  await act(async () => { root.unmount(); });
});

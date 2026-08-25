import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * While a Subagents save is in flight, toggle/remove/reorder must be blocked;
 * after success, `chosen` reconciles from `d.applied`.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let available: string[] = [];
let chosen: string[] = [];
let putCount = 0;
let releasePut: (() => void) | null = null;
let putGate: Promise<void> | null = null;
let appliedOnSave: string[] = [];
let caseSequence = 0;
let apiBase = "";

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  available = ["a-1", "a-2", "a-3", "a-4"];
  chosen = ["a-1", "a-2"];
  apiBase = `/busy-${++caseSequence}`;
  putCount = 0;
  appliedOnSave = ["a-1"];
  putGate = new Promise<void>((resolve) => {
    releasePut = resolve;
  });

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/subagent-models") && init?.method === "PUT") {
        const payload = JSON.parse(String(init.body)) as { roster?: Array<{ model?: unknown }>; models?: string[] };
        const requested = Array.isArray(payload.roster)
          ? payload.roster.map(entry => entry.model).filter((model): model is string => typeof model === "string")
          : payload.models ?? [];
        if (requested.length === 0) return Response.json({ error: "missing roster" }, { status: 400 });
        putCount += 1;
        await putGate;
        chosen = [...appliedOnSave];
        return {
          ok: true,
          status: 200,
          json: async () => ({ applied: appliedOnSave }),
          text: async () => JSON.stringify({ applied: appliedOnSave }),
        } as unknown as Response;
      }
      if (path.endsWith("/api/subagent-models")) return Response.json({ available, chosen, catalogState: { state: "fresh" } });
      if (path.endsWith("/api/models")) {
        return Response.json(available.map(id => ({ provider: "openai", id, namespaced: id, native: true })));
      }
      if (path.endsWith("/api/injection-model")) {
        return Response.json({ model: null, effort: null, efforts: ["low", "high"], available: [], multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: false });
      }
      if (path.endsWith("/api/v2")) return Response.json({ multiAgentMode: "default", maxConcurrentThreadsPerSession: null });
      if (path.endsWith("/api/subagent-model-fallback")) return Response.json({ models: [], pollMs: 60_000, available });
      if (path.endsWith("/api/effort-caps")) return Response.json({ effortCap: null, subagentEffortCap: null, efforts: ["low", "high"] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
    root = null;
  }
  releasePut?.();
  releasePut = null;
  putGate = null;
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount() {
  // ReactDOM must bind to the happy-dom globals installed by beforeEach.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Subagents apiBase={apiBase} />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

function addToggle(id: string): HTMLButtonElement {
  const row = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.getAttribute("aria-label") ?? "").includes(`Add ${id} to configured roster`),
  );
  if (!row) throw new Error(`add toggle not found: ${id}`);
  return row as unknown as HTMLButtonElement;
}

/** Active-roster remove only (the library also has a remove toggle). */
function removeButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll(".swi-roster-actions button")).filter((b) =>
    /^Remove /.test(b.getAttribute("aria-label") ?? ""),
  ) as unknown as HTMLButtonElement[];
}

function moveUp(id: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === `Move ${id} up`,
  );
  if (!btn) throw new Error(`move-up not found: ${id}`);
  return btn as unknown as HTMLButtonElement;
}

function saveButton(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(".swi-roster .swi-card-footer .btn-primary");
  if (!btn) throw new Error("Save roster button not found");
  return btn as unknown as HTMLButtonElement;
}

test("blocks edits while save is busy and reconciles chosen from applied", async () => {
  await mount();

  expect(removeButtons().length).toBe(2);
  expect(container.textContent).toContain("2 of 5");

  // Reordering makes the roster dirty; a clean roster has no reason to write.
  await act(async () => { moveUp("a-2").click(); });

  await act(async () => {
    saveButton().click();
  });

  expect(putCount).toBe(1);
  expect(saveButton().disabled).toBe(true);
  expect(removeButtons().every((b) => b.disabled)).toBe(true);
  expect(addToggle("a-3").disabled).toBe(true);
  expect(moveUp("a-1").disabled).toBe(true);

  // Force clicks past disabled attributes — state guards must still no-op.
  await act(async () => {
    addToggle("a-3").dispatchEvent(new (globalThis as { window: Window }).window.MouseEvent("click", { bubbles: true }));
    removeButtons()[1]!.dispatchEvent(new (globalThis as { window: Window }).window.MouseEvent("click", { bubbles: true }));
    moveUp("a-1").dispatchEvent(new (globalThis as { window: Window }).window.MouseEvent("click", { bubbles: true }));
  });

  // Featured list unchanged while the gated PUT is outstanding.
  expect(removeButtons().length).toBe(2);
  expect(container.textContent).toContain("2 of 5");
  expect(putCount).toBe(1);

  await act(async () => {
    releasePut?.();
    releasePut = null;
    await Promise.resolve();
  });

  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

  // Server applied only a-1 — local chosen must reconcile.
  expect(removeButtons().length).toBe(1);
  expect(removeButtons()[0]!.getAttribute("aria-label")).toBe("Remove a-1");
  expect(saveButton().disabled).toBe(true);
  expect(container.textContent).toContain("1 of 5");
});

test("rapid Save clicks issue only one PUT until the first settles", async () => {
  await mount();

  await act(async () => { moveUp("a-2").click(); });

  await act(async () => {
    const btn = saveButton();
    btn.click();
    btn.click();
    btn.click();
  });

  expect(putCount).toBe(1);
  expect(saveButton().disabled).toBe(true);

  await act(async () => {
    releasePut?.();
    releasePut = null;
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(saveButton().disabled).toBe(true);

  // Re-arm a gated PUT and confirm a later click can fire again.
  putGate = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  await act(async () => { addToggle("a-2").click(); });
  await act(async () => {
    saveButton().click();
  });
  expect(putCount).toBe(2);

  await act(async () => {
    releasePut?.();
    releasePut = null;
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(saveButton().disabled).toBe(true);
});

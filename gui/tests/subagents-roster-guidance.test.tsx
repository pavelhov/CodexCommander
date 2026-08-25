import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { LanguageProvider } from "../src/i18n/provider";

type RosterEntry = { model: string; guidance?: string };

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let roster: RosterEntry[] = [];
let requests: Array<{ url: string; init?: RequestInit }> = [];
let putGate: Promise<void> | null = null;
let releasePut: (() => void) | null = null;
let rosterReadGate: Promise<void> | null = null;
let releaseRosterRead: (() => void) | null = null;
let delayedRoster: RosterEntry[] | null = null;
let apiBase = "";
let sequence = 0;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
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
  roster = [{ model: "a-1" }];
  requests = [];
  putGate = null;
  releasePut = null;
  rosterReadGate = null;
  releaseRosterRead = null;
  delayedRoster = null;
  apiBase = `/roster-guidance-${++sequence}`;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const path = String(url);
      requests.push({ url: path, init });
      if (path.endsWith("/api/subagent-models") && init?.method === "PUT") {
        if (putGate) await putGate;
        roster = JSON.parse(String(init.body)).roster as RosterEntry[];
        return Response.json({ applied: roster.map(entry => entry.model), roster });
      }
      if (path.endsWith("/api/subagent-models")) {
        const gate = rosterReadGate;
        rosterReadGate = null;
        if (gate) await gate;
        const responseRoster = gate ? delayedRoster ?? roster : roster;
        return Response.json({
          available: ["a-1", "a-2", "a-3"],
          chosen: responseRoster.map(entry => entry.model),
          roster: responseRoster,
          catalogState: { state: "fresh" },
        });
      }
      if (path.endsWith("/api/models")) {
        return Response.json(["a-1", "a-2", "a-3"].map(id => ({ provider: "openai", id, namespaced: id, native: true })));
      }
      if (path.endsWith("/api/injection-model")) return Response.json({ model: null, effort: null, efforts: ["low", "high"], available: [], multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: false });
      if (path.endsWith("/api/v2")) return Response.json({ multiAgentMode: "default", maxConcurrentThreadsPerSession: null });
      if (path.endsWith("/api/subagent-model-fallback")) return Response.json({ models: [], pollMs: 60_000, available: [] });
      if (path.endsWith("/api/effort-caps")) return Response.json({ effortCap: null, subagentEffortCap: null, efforts: ["low", "high"] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  releasePut?.();
  releaseRosterRead?.();
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mount() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Subagents apiBase={apiBase} /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}

function guidanceButton(model = "a-1"): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(candidate =>
    candidate.getAttribute("aria-label") === `Add guidance for ${model}` || candidate.getAttribute("aria-label") === `Edit guidance for ${model}`,
  );
  if (!button) throw new Error(`guidance disclosure not found for ${model}`);
  return button as HTMLButtonElement;
}

function textarea(): HTMLTextAreaElement {
  const field = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!field) throw new Error("guidance textarea not found");
  return field;
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(candidate => candidate.textContent?.trim() === "Save roster");
  if (!button) throw new Error("Save roster button not found");
  return button as HTMLButtonElement;
}

function moveUp(model: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(candidate => candidate.getAttribute("aria-label") === `Move ${model} up`);
  if (!button) throw new Error(`move-up control not found for ${model}`);
  return button as HTMLButtonElement;
}

async function setGuidance(value: string) {
  await act(async () => {
    const field = textarea();
    const setValue = Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(field, value);
    field.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

test("adds optional guidance and persists canonical roster objects", async () => {
  await mount();
  expect(guidanceButton().textContent).toContain("Add guidance");
  await act(async () => { guidanceButton().click(); });
  expect(textarea().getAttribute("aria-label")).toBe("Guidance");
  await setGuidance("Use for independent review");
  expect(saveButton().disabled).toBe(false);
  await act(async () => { saveButton().click(); });
  const put = requests.find(request => request.init?.method === "PUT");
  expect(put?.init?.body).toBe(JSON.stringify({ roster: [{ model: "a-1", guidance: "Use for independent review" }] }));
});

test("disclosure exposes stable expanded and controlled-field semantics", async () => {
  await mount();
  expect(guidanceButton().getAttribute("aria-expanded")).toBe("false");
  expect(guidanceButton().getAttribute("aria-controls")).toBe("subagent-guidance-a-1");
  await act(async () => { guidanceButton().click(); });
  expect(guidanceButton().getAttribute("aria-expanded")).toBe("true");
  expect(textarea().id).toBe("subagent-guidance-a-1");
});

test("shows a muted guidance preview when the row is collapsed", async () => {
  roster = [{ model: "a-1", guidance: "Use for independent review" }];
  await mount();
  expect(guidanceButton().textContent).toContain("Edit guidance");
  const preview = container.querySelector<HTMLElement>(".swi-roster-guidance-preview");
  expect(preview?.textContent).toBe("Use for independent review");
  expect(preview?.getAttribute("title")).toBe("Use for independent review");
});

test("trims whitespace-only guidance out of dirty state", async () => {
  await mount();
  await act(async () => { guidanceButton().click(); });
  await setGuidance("   ");
  expect(saveButton().disabled).toBe(true);
});

test("does not let the five-second poll clobber unsaved guidance", async () => {
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  let poll: (() => void) | null = null;
  Object.defineProperty(globalThis, "setInterval", { configurable: true, value: (callback: () => void, ms: number) => {
    if (ms === 5_000) poll = callback;
    return 1;
  } });
  Object.defineProperty(globalThis, "clearInterval", { configurable: true, value: () => {} });
  try {
    await mount();
    await act(async () => { guidanceButton().click(); });
    await setGuidance("local draft");
    roster = [{ model: "a-1", guidance: "server replacement" }];
    await act(async () => { poll?.(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(textarea().value).toBe("local draft");
  } finally {
    Object.defineProperty(globalThis, "setInterval", { configurable: true, value: previousSetInterval });
    Object.defineProperty(globalThis, "clearInterval", { configurable: true, value: previousClearInterval });
  }
});

test("disables the disclosure and textarea while the roster saves", async () => {
  await mount();
  await act(async () => { guidanceButton().click(); });
  await setGuidance("draft");
  putGate = new Promise<void>(resolve => { releasePut = resolve; });
  await act(async () => { saveButton().click(); });
  expect(guidanceButton().disabled).toBe(true);
  expect(textarea().disabled).toBe(true);
  await act(async () => { releasePut?.(); releasePut = null; await Promise.resolve(); });
});

test("blocks an over-limit guidance value and exposes an invalid textarea", async () => {
  await mount();
  await act(async () => { guidanceButton().click(); });
  await setGuidance("x".repeat(161));
  expect(textarea().getAttribute("aria-invalid")).toBe("true");
  expect(container.textContent).toContain("Guidance is too long");
  expect(saveButton().disabled).toBe(true);
});

test("canonical whitespace guidance does not block a separate roster edit", async () => {
  roster = [{ model: "a-1" }, { model: "a-2" }];
  await mount();
  await act(async () => { guidanceButton().click(); });
  await setGuidance(" ".repeat(161));
  await act(async () => { moveUp("a-2").click(); });
  expect(saveButton().disabled).toBe(false);
  await act(async () => { saveButton().click(); });
  const put = requests.find(request => request.init?.method === "PUT");
  expect(put?.init?.body).toBe(JSON.stringify({ roster: [{ model: "a-2" }, { model: "a-1" }] }));
});

test("accepts decomposed Unicode that canonicalizes to the 160-code-point guidance boundary", async () => {
  await mount();
  await act(async () => { guidanceButton().click(); });
  await setGuidance("e\u0301".repeat(160));
  expect(textarea().getAttribute("aria-invalid")).toBeNull();
  expect(container.textContent).toContain("160/160");
  expect(saveButton().disabled).toBe(false);
});

test("textarea arrow keys do not reorder the roster and Escape keeps its draft", async () => {
  roster = [{ model: "a-1" }, { model: "a-2" }];
  await mount();
  await act(async () => { guidanceButton("a-2").click(); });
  await setGuidance("draft remains");
  await act(async () => {
    textarea().dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, altKey: true }));
    textarea().dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(Array.from(container.querySelectorAll(".swi-roster-name")).map(node => node.textContent?.trim())).toEqual(["a-1", "a-2"]);
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () => { guidanceButton("a-2").click(); });
  expect(textarea().value).toBe("draft remains");
});

test("an aborted stale poll cannot overwrite guidance saved after that poll began", async () => {
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  let poll: (() => void) | null = null;
  Object.defineProperty(globalThis, "setInterval", { configurable: true, value: (callback: () => void, ms: number) => {
    if (ms === 5_000) poll = callback;
    return 1;
  } });
  Object.defineProperty(globalThis, "clearInterval", { configurable: true, value: () => {} });
  try {
    await mount();
    delayedRoster = [{ model: "a-1" }];
    rosterReadGate = new Promise<void>(resolve => { releaseRosterRead = resolve; });
    await act(async () => { poll?.(); await Promise.resolve(); });
    await act(async () => { guidanceButton().click(); });
    await setGuidance("saved guidance");
    await act(async () => { saveButton().click(); });
    releaseRosterRead?.();
    releaseRosterRead = null;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(textarea().value).toBe("saved guidance");
  } finally {
    Object.defineProperty(globalThis, "setInterval", { configurable: true, value: previousSetInterval });
    Object.defineProperty(globalThis, "clearInterval", { configurable: true, value: previousClearInterval });
  }
});

test("keeps the guidance disclosure visible while the 620px stylesheet hides arrows", async () => {
  const css = await Bun.file(new URL("../src/styles-subagents-workspace.css", import.meta.url)).text();
  const compactStart = css.indexOf("@container subagents-workspace (max-width: 620px)");
  const compactEnd = css.indexOf("@media (prefers-reduced-motion", compactStart);
  const compact = css.slice(compactStart, compactEnd);
  expect(compact).toMatch(/\.swi-roster-actions \.swi-roster-arrow\s*\{\s*display: none/);
  expect(compact).not.toMatch(/\.swi-roster-guidance[^}]*display:\s*none/);
});

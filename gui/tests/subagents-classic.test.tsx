import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * Behavioural contract for the denser Subagents workspace: five-slot cap,
 * add/remove via the rail, and the exact save request.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: { url: string; init?: RequestInit }[] = [];
let available: string[] = [];
let chosen: string[] = [];
let modelRows: Array<Record<string, unknown>> = [];
let catalogState: { state: "fresh" | "stale"; processes?: Array<{ pid: number; startedAtMs: number }> } = { state: "fresh" };
let policyMode: "v1" | "default" | "v2" = "default";
let messageDelivery: "encrypted" | "plaintext" = "encrypted";
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

  requests = [];
  available = ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6"];
  chosen = [];
  modelRows = available.map(id => ({ provider: "openai", id, namespaced: id, native: true }));
  catalogState = { state: "fresh" };
  policyMode = "default";
  messageDelivery = "encrypted";
  apiBase = `/classic-${++caseSequence}`;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const path = String(url);
      const method = init?.method ?? "GET";
      if (path.endsWith("/api/subagent-models")) {
        if (method === "PUT") {
          const models = JSON.parse(String(init?.body)).models as string[];
          chosen = models;
          return Response.json({ ok: true, applied: models, catalogRefresh: { ok: true } });
        }
        return Response.json({ available, chosen, catalogState });
      }
      if (path.endsWith("/api/models")) {
        return Response.json(modelRows);
      }
      if (path.endsWith("/api/injection-model")) {
        return Response.json({ model: null, effort: null, efforts: ["low", "high"], available: [], multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: false });
      }
      if (path.endsWith("/api/v2")) return Response.json({
        multiAgentMode: policyMode,
        multiAgentV2MessageDelivery: messageDelivery,
        maxConcurrentThreadsPerSession: null,
      });
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
    await act(async () => { current.unmount(); });
    root = null;
  }
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
  // Subagents defers its initial load through setTimeout(0), so a macrotask flush is required.
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

/** Library add/remove toggles are labelled from sub.workspace.addToFeatured / removeFromFeatured. */
function addToggle(id: string): HTMLButtonElement {
  const row = Array.from(container.querySelectorAll("button"))
    .find((b) => (b.getAttribute("aria-label") ?? "").includes(`Add ${id} to active roster`));
  if (!row) throw new Error(`add toggle not found: ${id}`);
  return row as unknown as HTMLButtonElement;
}

/** Active-roster remove only (the library also exposes remove toggles). */
function removeButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll(".swi-roster-actions button")).filter((b) =>
    /^Remove /.test(b.getAttribute("aria-label") ?? "")) as unknown as HTMLButtonElement[];
}

test("renders one active roster, one agent library, and one run-policy card", async () => {
  await mount();
  expect(container.querySelector(".subagents-workspace-shell")).toBeTruthy();
  expect(container.querySelectorAll(".subagents-command-card").length).toBe(3);
  const headings = Array.from(container.querySelectorAll(".swi-card-title"))
    .map(node => node.textContent?.trim());
  expect(headings).toEqual(["Active Roster", "Agent Library", "Run Policy"]);
  expect(container.textContent).toContain("Use roster as worker guidance");
  expect(container.textContent).toContain("No preferred model — Codex chooses from roster");
});

test("shows the V2 encryption compatibility notice only for the V2 protocol", async () => {
  policyMode = "v2";
  await mount();
  expect(container.textContent).toContain("cannot be read by external providers (#92)");

  const currentRoot = root!;
  await act(async () => { currentRoot.unmount(); });
  root = null;
  policyMode = "v1";
  await mount();
  expect(container.textContent).not.toContain("external providers cannot read (#92)");
});

test("shows the plaintext privacy notice when Codex defaults may select V2", async () => {
  policyMode = "default";
  messageDelivery = "plaintext";
  await mount();
  expect(container.textContent).toContain("including messages to native workers");
  expect(container.textContent).toContain("Start a new session after saving");
});

test("caps featured selections at five", async () => {
  await mount();

  // Six models available, six clicks — only five may land.
  for (const id of available) {
    const toggle = addToggle(id);
    if (!toggle.disabled) {
      await act(async () => { toggle.click(); });
    }
  }

  expect(removeButtons().length).toBe(5);
  expect(container.textContent).toContain("5 of 5");
  // The sixth add toggle is disabled rather than silently appended.
  expect(addToggle(available[5]!).disabled).toBe(true);

  // The cap lives in TWO places: the disabled attribute above (presentation) and the
  // state guard in toggle(). Force a click past the disabled attribute so a weakened
  // state guard cannot hide behind the UI check.
  await act(async () => { addToggle(available[5]!).dispatchEvent(new (globalThis as any).window.MouseEvent("click", { bubbles: true })); });
  expect(removeButtons().length).toBe(5);

  // And save must never ship more than five.
  const save = Array.from(container.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Save roster") as HTMLButtonElement | undefined;
  await act(async () => { save!.click(); });
  const put = requests.find((r) => r.init?.method === "PUT");
  expect(JSON.parse(String(put!.init!.body)).models.length).toBe(5);
});

test("saves the featured order with PUT and the models payload", async () => {
  await mount();

  await act(async () => { addToggle("a-1").click(); });
  await act(async () => { addToggle("a-2").click(); });

  const save = Array.from(container.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Save roster") as HTMLButtonElement | undefined;
  expect(save).toBeDefined();
  await act(async () => { save!.click(); });

  const put = requests.find((r) => r.init?.method === "PUT");
  expect(put).toBeDefined();
  expect(put!.url).toContain("/api/subagent-models");
  expect(put!.init?.body).toBe(JSON.stringify({ models: ["a-1", "a-2"] }));
});

test("shows truthful catalog state, capability filters, and keyboard reordering", async () => {
  available = ["reason-agent", "vision-agent", "plain-agent"];
  chosen = ["reason-agent", "vision-agent"];
  catalogState = {
    state: "stale",
    processes: [
      { pid: 1001, startedAtMs: 1 },
      { pid: 1002, startedAtMs: 2 },
    ],
  };
  modelRows = [
    {
      provider: "openai",
      id: "reason-agent",
      namespaced: "reason-agent",
      native: true,
      reasoningEfforts: ["low", "high"],
      contextWindow: 1_000_000,
      parallelToolCalls: true,
    },
    {
      provider: "openai",
      id: "vision-agent",
      namespaced: "vision-agent",
      native: true,
      inputModalities: ["text", "image"],
      contextWindow: 200_000,
    },
    { provider: "openai", id: "plain-agent", namespaced: "plain-agent", native: true },
  ];

  await mount();
  expect(container.textContent).toContain("Restart needed");
  expect(container.textContent).toContain("differs from 2 running Codex session(s)");
  expect(container.textContent).toContain("Reasoning");
  expect(container.textContent).toContain("Tools");

  const visionFilter = Array.from(container.querySelectorAll<HTMLButtonElement>(".swi-filter"))
    .find(button => button.textContent?.trim() === "Vision")!;
  await act(async () => { visionFilter.click(); });
  const visibleLibraryNames = Array.from(container.querySelectorAll(".swi-library-row .swi-library-name"))
    .map(node => node.textContent?.trim());
  expect(visibleLibraryNames).toEqual(["vision-agent"]);

  const firstGrip = container.querySelector<HTMLButtonElement>('button[aria-label="Drag reason-agent, currently position 1"]')!;
  await act(async () => {
    firstGrip.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  const rosterNames = Array.from(container.querySelectorAll(".swi-roster-name")).map(node => node.textContent?.trim());
  expect(rosterNames).toEqual(["vision-agent", "reason-agent"]);
  expect(container.querySelector<HTMLButtonElement>(".swi-roster .btn-primary")?.disabled).toBe(false);
});

test("revalidates live catalog status when revisiting a warm command-center cache", async () => {
  catalogState = { state: "stale", processes: [{ pid: 1001, startedAtMs: 1 }] };
  await mount();
  expect(container.textContent).toContain("Restart needed");
  const firstReads = requests.filter(request => request.url.endsWith("/api/subagent-models") && !request.init?.method).length;

  const firstRoot = root!;
  await act(async () => { firstRoot.unmount(); });
  root = null;
  catalogState = { state: "fresh" };

  await mount();
  const secondReads = requests.filter(request => request.url.endsWith("/api/subagent-models") && !request.init?.method).length;
  expect(secondReads).toBeGreaterThan(firstReads);
  expect(container.textContent).toContain("Catalog current");
  expect(container.textContent).not.toContain("Restart needed");
});

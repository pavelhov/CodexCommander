import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { LanguageProvider } from "../src/i18n/provider";
import { setConfirmedGuiLaunchForTests } from "../src/api";

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
let advertised: string[] = [];
let excluded: Array<{ configured: string; catalogModel?: string; reason: string }> = [];
let modelRows: Array<Record<string, unknown>> = [];
let catalogState: { state: "fresh" | "stale"; processes?: Array<{ pid: number; startedAtMs: number }> } = { state: "fresh" };
let policyMode: "v1" | "default" | "v2" = "default";
let messageDelivery: "encrypted" | "plaintext" = "encrypted";
let catalogRefresh: Record<string, unknown> = { status: "committed", changed: true };
let activation: Record<string, unknown> | undefined;
let saveResponseOverride: Record<string, unknown> | undefined;
let activityResponse: Response | null = null;
let failRosterReads = false;
let holdRosterReads: Promise<void> | null = null;
let releaseRosterReads: (() => void) | null = null;
let caseSequence = 0;
let apiBase = "";

beforeEach(() => {
  setConfirmedGuiLaunchForTests(true);
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
  advertised = [];
  excluded = [];
  modelRows = available.map(id => ({ provider: "openai", id, namespaced: id, native: true }));
  catalogState = { state: "fresh" };
  policyMode = "default";
  messageDelivery = "encrypted";
  catalogRefresh = { status: "committed", changed: true };
  activation = undefined;
  saveResponseOverride = undefined;
  activityResponse = null;
  failRosterReads = false;
  holdRosterReads = null;
  releaseRosterReads = null;
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
          const overrideApplied = saveResponseOverride?.applied;
          const applied = Array.isArray(overrideApplied)
            ? overrideApplied.filter((model): model is string => typeof model === "string")
            : models;
          chosen = applied;
          return Response.json({
            ok: true,
            applied,
            advertised,
            excluded,
            catalogRefresh,
            activation,
            ...saveResponseOverride,
          });
        }
        if (failRosterReads) return Response.json({ error: "refresh failed" }, { status: 503 });
        if (holdRosterReads) await holdRosterReads;
        return Response.json({ available, chosen, advertised, excluded, catalogState, activation });
      }
      if (path.endsWith("/api/agent-activity")) {
        return activityResponse ?? Response.json({ activeTurnCount: 0 });
      }
      if (path.endsWith("/api/codex-catalog/apply")) {
        activation = {
          schemaVersion: 1,
          desired: { revision: "revision-1", chosen, protocol: "v2" },
          catalog: { status: "current", advertised, excluded },
          routing: { status: "current", kind: "codexcommander-local" },
          workers: { status: "current", runningCount: 1, staleCount: 0, evidence: "verified" },
          apply: { required: false, allowed: false, reason: "already-current" },
        };
        return Response.json({ ok: true, outcome: "applied", activation, stoppedWorkerCount: 1, survivingWorkerCount: 0 });
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
  setConfirmedGuiLaunchForTests(false);
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
    .find((b) => (b.getAttribute("aria-label") ?? "").includes(`Add ${id} to configured roster`));
  if (!row) throw new Error(`add toggle not found: ${id}`);
  return row as unknown as HTMLButtonElement;
}

/** Configured-roster remove only (the library also exposes remove toggles). */
function removeButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll(".swi-roster-actions button")).filter((b) =>
    /^Remove /.test(b.getAttribute("aria-label") ?? "")) as unknown as HTMLButtonElement[];
}

test("renders one configured roster, one agent library, and one run-policy card", async () => {
  await mount();
  expect(container.querySelector(".subagents-workspace-shell")).toBeTruthy();
  expect(container.querySelectorAll(".subagents-command-card").length).toBe(3);
  const headings = Array.from(container.querySelectorAll(".swi-card-title"))
    .map(node => node.textContent?.trim());
  expect(headings).toEqual(["Configured Roster", "Agent Library", "Run Policy"]);
  expect(container.textContent).toContain("Use roster as worker guidance");
  expect(container.textContent).toContain("No preferred model");
});

test("shows the encrypted V2 compatibility notice for base and V2, but not classic V1", async () => {
  policyMode = "v2";
  await mount();
  expect(container.textContent).toContain("V2 tasks are encrypted; external providers cannot read them");

  const v2Root = root!;
  await act(async () => { v2Root.unmount(); });
  root = null;
  policyMode = "default";
  await mount();
  expect(container.textContent).toContain("V2 tasks are encrypted; external providers cannot read them");

  const currentRoot = root!;
  await act(async () => { currentRoot.unmount(); });
  root = null;
  policyMode = "v1";
  await mount();
  expect(container.textContent).not.toContain("V2 tasks are encrypted");
});

test("shows the plaintext privacy notice when Codex defaults may select V2", async () => {
  policyMode = "default";
  messageDelivery = "plaintext";
  await mount();
  expect(container.textContent).toContain("including messages to native workers");
  expect(container.textContent).toContain("Task-message delivery from this parent is plaintext");
  expect(container.textContent).toContain("does not require Apply");
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

test("warns when the roster persists but catalog convergence is skipped", async () => {
  catalogRefresh = { status: "skipped", reason: "busy", retryable: true };
  activation = {
    desired: { revision: "revision-1", chosen: ["a-1"], protocol: "default" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "not_injected", kind: "native" },
    workers: { status: "not_running" },
    apply: { required: true, allowed: true, reason: "routing-not-injected" },
  };
  await mount();

  await act(async () => { addToggle("a-1").click(); });
  const save = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === "Save roster") as HTMLButtonElement;
  await act(async () => { save.click(); });

  expect(container.textContent).toContain("catalog could not be refreshed cleanly");
  expect(container.textContent).toContain("Existing workers were not restarted");
});

test("shows the latest durable roster when a save is superseded", async () => {
  saveResponseOverride = { superseded: true, applied: ["a-2"] };
  await mount();

  await act(async () => { addToggle("a-1").click(); });
  const save = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === "Save roster") as HTMLButtonElement;
  await act(async () => { save.click(); });

  expect(container.querySelector(".notice-warn")?.textContent).toContain("superseded by a newer change");
  expect(container.querySelector(".notice-warn")?.textContent).toContain("latest saved roster is shown");
  expect(Array.from(container.querySelectorAll(".swi-roster-name")).map(node => node.textContent?.trim())).toEqual(["a-2"]);
});

test("explains an intentional catalog skip when Codex integration is off", async () => {
  catalogRefresh = { status: "skipped", reason: "refused", retryable: false };
  activation = {
    desired: { revision: "revision-1", chosen: ["a-1"], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "not_required", kind: "native" },
    workers: { status: "not_running" },
    apply: { required: false, allowed: false, reason: "integration-disabled" },
  };
  await mount();

  await act(async () => { addToggle("a-1").click(); });
  const save = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === "Save roster") as HTMLButtonElement;
  await act(async () => { save.click(); });

  expect(container.textContent).toContain("Codex integration is off");
  expect(container.textContent).toContain("routing and catalog files were left unchanged");
  expect(container.textContent).not.toContain("catalog could not be refreshed cleanly");
});

test("explains that native routing needs an explicit Apply after Save", async () => {
  catalogRefresh = { status: "skipped", reason: "refused", retryable: false };
  activation = {
    desired: { revision: "revision-1", chosen: ["a-1"], protocol: "default" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "not_injected", kind: "native" },
    workers: { status: "not_running" },
    apply: { required: true, allowed: true, reason: "routing-not-injected" },
  };
  await mount();

  await act(async () => { addToggle("a-1").click(); });
  const save = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === "Save roster") as HTMLButtonElement;
  await act(async () => { save.click(); });

  expect(container.textContent).toContain("still using native routing");
  expect(container.textContent).toContain("choose Apply to Codex when you are ready");
  expect(container.textContent).not.toContain("catalog could not be refreshed cleanly");
});

test("explains that unowned or unknown routing files are preserved", async () => {
  catalogRefresh = { status: "skipped", reason: "refused", retryable: false };
  activation = {
    desired: { revision: "revision-1", chosen: ["a-1"], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "unknown", kind: "unknown" },
    workers: { status: "unknown" },
    apply: { required: false, allowed: false, reason: "routing-unknown" },
  };
  await mount();

  await act(async () => { addToggle("a-1").click(); });
  const save = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === "Save roster") as HTMLButtonElement;
  await act(async () => { save.click(); });

  expect(container.textContent).toContain("Existing Codex routing and catalog files were preserved");
  expect(container.textContent).toContain("could not verify that it owns the current routing");
  expect(container.textContent).not.toContain("catalog could not be refreshed cleanly");
});

test("makes manual ChatGPT restart primary and keeps guarded worker restart as an advanced fallback", async () => {
  activation = {
    schemaVersion: 1,
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "current", kind: "codexcommander-local" },
    workers: { status: "reload_required", runningCount: 1, staleCount: 1, evidence: "verified" },
    apply: { required: true, allowed: true, reason: "reload-required" },
  };
  await mount();

  expect(container.textContent).toContain("Restart ChatGPT");
  expect(container.textContent).toContain("Quit ChatGPT completely");
  expect(container.textContent).toContain("most reliable way to load the roster");
  expect(requests.some(request => request.url.endsWith("/api/agent-activity"))).toBe(false);
  const applyButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.trim() === "Force-restart workers")!;
  await act(async () => { applyButton.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(requests.some(request => request.url.endsWith("/api/agent-activity"))).toBe(true);
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("No active proxy work was detected");

  const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))
    .find(button => button.textContent?.trim() === "Apply to Codex")!;
  await act(async () => { confirm.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  const applyRequest = requests.find(request => request.url.endsWith("/api/codex-catalog/apply"));
  expect(applyRequest?.init?.method).toBe("POST");
  expect(applyRequest?.init?.body).toBe(JSON.stringify({ expectedDesiredRevision: "revision-1", confirmInterrupt: true }));
  expect(container.textContent).toContain("Applied CodexCommander routing and the catalog to Codex");
  expect(container.textContent).toContain("Codex workers current");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(false);
});

test("offers Apply to reconcile a pending catalog before any worker interruption", async () => {
  activation = {
    schemaVersion: 1,
    desired: { revision: "revision-1", chosen: ["a-1"], protocol: "default" },
    catalog: { status: "pending", advertised: [], excluded: [{ configured: "a-1", reason: "missing_catalog_entry" }] },
    routing: { status: "current", kind: "codexcommander-local" },
    workers: { status: "reload_required", runningCount: 1, staleCount: 1, evidence: "verified" },
    apply: { required: true, allowed: true, reason: "catalog-not-ready" },
  };
  await mount();

  expect(container.textContent).toContain("Apply needed");
  expect(container.textContent).toContain("first synchronizes routing and catalog files");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(true);
});

test("manual dashboard still gives reliable restart guidance while force restart stays launcher-gated", async () => {
  setConfirmedGuiLaunchForTests(false);
  activation = {
    schemaVersion: 1,
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "current", kind: "codexcommander-local" },
    workers: { status: "reload_required", runningCount: 1, staleCount: 1, evidence: "verified" },
    apply: { required: true, allowed: false, reason: "confirmed-launch-required" },
  };
  await mount();

  expect(container.textContent).toContain("Restart ChatGPT");
  expect(container.textContent).toContain("Quit ChatGPT completely");
  expect(container.textContent).toContain("This dashboard is read-only for Apply");
  expect(container.textContent).toContain("Open it with `ccx gui`");
  expect(container.textContent).not.toContain("Force-restart workers");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(false);
});

test("confirmed-launch-required keeps Apply read-only even outside the manual-restart branch", async () => {
  setConfirmedGuiLaunchForTests(false);
  activation = {
    schemaVersion: 1,
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "not_injected", kind: "native" },
    workers: { status: "not_running", runningCount: 0, staleCount: 0 },
    apply: { required: true, allowed: false, reason: "confirmed-launch-required" },
  };
  await mount();

  expect(container.textContent).toContain("This dashboard is read-only for Apply");
  expect(container.textContent).toContain("Open it with `ccx gui`");
  expect(container.textContent).not.toContain("Force-restart workers");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(false);
});

test("polls the command center on the surface poll interval", async () => {
  const priorSetInterval = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
  const priorClearInterval = Object.getOwnPropertyDescriptor(globalThis, "clearInterval");
  const polls: Array<{ handler: () => void; ms: number }> = [];
  const recordPoll = (handler: () => void, ms?: number, ..._args: unknown[]) => {
    polls.push({ handler, ms: typeof ms === "number" ? ms : 0 });
    return polls.length;
  };
  Object.defineProperty(globalThis, "setInterval", { configurable: true, value: recordPoll });
  Object.defineProperty(globalThis, "clearInterval", { configurable: true, value: () => {} });
  try {
    await mount();

    const surfacePoll = polls.find(poll => poll.ms === 5000);
    expect(surfacePoll).toBeDefined();

    const readsBefore = requests.filter(request => request.url.endsWith("/api/subagent-models") && !request.init?.method).length;
    await act(async () => {
      surfacePoll!.handler();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const readsAfter = requests.filter(request => request.url.endsWith("/api/subagent-models") && !request.init?.method).length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
  } finally {
    if (priorSetInterval) Object.defineProperty(globalThis, "setInterval", priorSetInterval);
    if (priorClearInterval) Object.defineProperty(globalThis, "clearInterval", priorClearInterval);
  }
});

test("polled revalidation never clobbers unsaved roster edits", async () => {
  const priorSetInterval = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
  const priorClearInterval = Object.getOwnPropertyDescriptor(globalThis, "clearInterval");
  const polls: Array<{ handler: () => void; ms: number }> = [];
  const recordPoll = (handler: () => void, ms?: number, ..._args: unknown[]) => {
    polls.push({ handler, ms: typeof ms === "number" ? ms : 0 });
    return polls.length;
  };
  Object.defineProperty(globalThis, "setInterval", { configurable: true, value: recordPoll });
  Object.defineProperty(globalThis, "clearInterval", { configurable: true, value: () => {} });
  try {
    await mount();
    const surfacePoll = polls.find(poll => poll.ms === 5000);
    expect(surfacePoll).toBeDefined();

    // User toggles a model but does not save; the server still reports the old roster.
    await act(async () => { addToggle("a-1").click(); });
    expect(removeButtons().length).toBe(1);

    await act(async () => {
      surfacePoll!.handler();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // The unsaved selection survives the polled revalidation.
    expect(removeButtons().length).toBe(1);
    expect(Array.from(container.querySelectorAll(".swi-roster-name")).map(node => node.textContent?.trim())).toEqual(["a-1"]);
  } finally {
    if (priorSetInterval) Object.defineProperty(globalThis, "setInterval", priorSetInterval);
    if (priorClearInterval) Object.defineProperty(globalThis, "clearInterval", priorClearInterval);
  }
});

test("seeded stale activation never paints an actionable banner before the first live fetch resolves", async () => {
  const seed = {
    available,
    chosen: [],
    advertised,
    excluded,
    models: modelRows,
    catalogState: { state: "stale", processes: [{ pid: 1001, startedAtMs: 1 }] },
    activation: {
      desiredRevision: "revision-1",
      reloadRequired: true,
      applyAllowed: false,
      workerState: "reload_required",
      catalogStatus: "current",
      applyReason: "confirmed-launch-required",
      routingStatus: "current",
      routingKind: "codexcommander-local",
      protocol: "v2",
      advertised: [],
      excluded: [],
    },
    metadataLimited: false,
  };
  testWindow.sessionStorage.setItem(`ccx.subagents.v2:${apiBase}`, JSON.stringify(seed));

  holdRosterReads = new Promise<void>(resolve => { releaseRosterReads = resolve; });
  await mount();

  // While the live revalidation is in flight the seed must not paint stale action banners.
  expect(container.textContent).not.toContain("Restart ChatGPT");
  expect(container.textContent).not.toContain("Quit ChatGPT completely");
  expect(container.textContent).not.toContain("Force-restart workers");
  expect(container.textContent).not.toContain("Apply to Codex");
  expect(container.textContent).not.toContain("This dashboard is read-only for Apply");

  // Live state says everything is current; after the fetch resolves the banner updates.
  activation = {
    schemaVersion: 1,
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "current", kind: "codexcommander-local" },
    workers: { status: "current", runningCount: 1, staleCount: 0 },
    apply: { required: false, allowed: false, reason: "already-current" },
  };
  releaseRosterReads!();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });

  expect(container.textContent).toContain("Codex workers current");
  expect(container.textContent).not.toContain("Quit ChatGPT completely");
  expect(container.textContent).not.toContain("Force-restart workers");
});

test("an omitted Apply permission never enables process interruption", async () => {
  activation = {
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "current", kind: "codexcommander-local" },
    workers: { status: "reload_required" },
    apply: { required: true, reason: "reload-required" },
  };
  await mount();

  expect(container.textContent).toContain("Restart ChatGPT");
  expect(container.textContent).not.toContain("Force-restart workers");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(false);
});

test("a malformed Apply permission remains unavailable", async () => {
  activation = {
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "current", kind: "codexcommander-local" },
    workers: { status: "reload_required" },
    apply: { required: true, allowed: "true", reason: "reload-required" },
  };
  await mount();

  expect(container.textContent).toContain("Restart ChatGPT");
  expect(container.textContent).not.toContain("Force-restart workers");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(false);
});

test("an incoherent routing status and kind fail closed", async () => {
  activation = {
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "current", kind: "custom-remote" },
    workers: { status: "reload_required" },
    apply: { required: true, allowed: true, reason: "reload-required" },
  };
  await mount();

  expect(container.textContent).toContain("Apply unavailable");
  expect(container.textContent).toContain("routing could not be classified safely");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(false);
});

test("native Codex routing offers full route and catalog reconciliation", async () => {
  activation = {
    schemaVersion: 1,
    desired: { revision: "revision-1", chosen: [], protocol: "default" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "not_injected", kind: "native" },
    workers: { status: "not_running", runningCount: 0, staleCount: 0, evidence: "no-processes" },
    apply: { required: true, allowed: true, reason: "routing-not-injected" },
  };
  await mount();

  expect(container.textContent).toContain("Apply needed");
  expect(container.textContent).toContain("Codex is still using native routing");
  expect(container.textContent).toContain("connects Codex to CodexCommander");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(true);
});

test("external Codex routing is explained and never overwritten by Apply", async () => {
  activation = {
    schemaVersion: 1,
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "external", kind: "custom-remote" },
    workers: { status: "reload_required", runningCount: 1, staleCount: 1, evidence: "process-start-vs-activation-fence" },
    apply: { required: true, allowed: false, reason: "external-routing" },
  };
  await mount();

  expect(container.textContent).toContain("Apply unavailable");
  expect(container.textContent).toContain("custom routing that CodexCommander does not own");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(false);
});

test("unknown Codex routing explains the fail-closed Apply state", async () => {
  activation = {
    schemaVersion: 1,
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "unknown", kind: "unknown" },
    workers: { status: "current", runningCount: 1, staleCount: 0, evidence: "process-start-vs-activation-fence" },
    apply: { required: false, allowed: false, reason: "routing-unknown" },
  };
  await mount();

  expect(container.textContent).toContain("Apply unavailable");
  expect(container.textContent).toContain("routing could not be classified safely");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(false);
});

test("a disabled Codex integration is informational rather than actionable", async () => {
  activation = {
    schemaVersion: 1,
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "not_required", kind: "native" },
    workers: { status: "reload_required", runningCount: 1, staleCount: 1, evidence: "process-start-vs-activation-fence" },
    apply: { required: true, allowed: false, reason: "integration-disabled" },
  };
  await mount();

  expect(container.textContent).toContain("Codex integration off");
  expect(container.textContent).toContain("roster remains saved in CodexCommander");
  expect(container.textContent).not.toContain("Apply unavailable");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Apply to Codex")).toBe(false);
});

test("keeps the mutation response authoritative when follow-up roster refresh fails", async () => {
  await mount();
  await act(async () => { addToggle("a-1").click(); });
  activation = {
    desired: { revision: "revision-2", chosen: ["a-1"], protocol: "v2" },
    catalog: { status: "current", advertised: ["a-1"], excluded: [] },
    routing: { status: "current", kind: "codexcommander-local" },
    workers: { status: "reload_required", runningCount: 1, staleCount: 1 },
    apply: { required: true, allowed: true, reason: "reload-required" },
  };
  failRosterReads = true;
  const save = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.trim() === "Save roster")!;
  await act(async () => {
    save.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  expect(container.textContent).toContain("Restart ChatGPT");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Force-restart workers")).toBe(true);
});

test("confirmation starts on Cancel, restores focus, and Escape closes safely", async () => {
  activation = {
    desired: { revision: "revision-1", chosen: [], protocol: "v2" },
    catalog: { status: "current", advertised: [], excluded: [] },
    routing: { status: "current", kind: "codexcommander-local" },
    workers: { status: "reload_required", runningCount: 1, staleCount: 1 },
    apply: { required: true, allowed: true, reason: "reload-required" },
  };
  await mount();
  const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.trim() === "Force-restart workers")!;
  trigger.focus();
  await act(async () => {
    trigger.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  const dialog = container.querySelector('[role="alertdialog"]')!;
  const cancel = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.trim() === "Cancel")!;
  expect(document.activeElement).toBe(cancel);

  await act(async () => {
    window.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
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
  expect(container.textContent).toContain("Codex workers current");
  expect(container.textContent).not.toContain("Restart needed");
});

test("warns when a fresh catalog does not advertise every saved roster model", async () => {
  chosen = ["gpt-5.6-sol", "opencode-go/glm-5.2", "kimi/k3[1m]", "xai/grok-4.5", "opencode-go/deepseek-v4-flash"];
  available = [...chosen];
  advertised = chosen.slice(0, 3);
  excluded = chosen.slice(3).map(configured => ({
    configured,
    catalogModel: configured,
    reason: "outside_display_limit",
  }));
  modelRows = chosen.map(namespaced => {
    const slash = namespaced.indexOf("/");
    return slash < 0
      ? { provider: "openai", id: namespaced, namespaced, native: true }
      : { provider: namespaced.slice(0, slash), id: namespaced.slice(slash + 1), namespaced };
  });

  await mount();

  expect(container.textContent).toContain("Codex workers current");
  expect(container.textContent).toContain("This roster controls spawn_agent, not the top-level Codex Desktop picker");
  expect(container.textContent).toContain("roster models are not currently advertised");
  expect(container.textContent).toContain("xai/grok-4.5");
  expect(container.textContent).toContain("opencode-go/deepseek-v4-flash");
  expect(container.textContent).toContain("roster is not fully effective");
});

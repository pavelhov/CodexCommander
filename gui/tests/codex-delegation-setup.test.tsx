import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import CodexDelegationSetupCard from "../src/components/subagents-workspace/CodexDelegationSetupCard";
import {
  useCodexDelegationSetup,
  type CodexDelegationMode,
  type CodexDelegationSetupController,
  type CodexDelegationStatus,
} from "../src/pages/use-codex-delegation-setup";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

function makeStatus(state: CodexDelegationStatus["state"] = "not-installed", mode: CodexDelegationMode | null = null): CodexDelegationStatus {
  return {
    schemaVersion: 1, state, installedMode: mode,
    artifacts: {
      skill: { state: mode ? "current" : "absent", displayPath: "$HOME/.agents/skills/codexcommander-delegation/SKILL.md" },
      agentsPolicy: { state: mode ? "current" : "absent", displayPath: "$CODEX_HOME/AGENTS.md" },
    },
    override: { state: "absent" }, activation: "effective",
    previews: {
      balanced: { skillText: "balanced skill from server", agentsBlockText: "balanced policy from server" },
      orchestrator: { skillText: "orchestrator skill from server", agentsBlockText: "orchestrator policy from server" },
    },
    copyPrompts: { balanced: "balanced manual prompt from server", orchestrator: "orchestrator manual prompt from server" },
  };
}

function makeArtifactStatus(
  state: CodexDelegationStatus["state"],
  skill: CodexDelegationStatus["artifacts"]["skill"]["state"],
  agentsPolicy: CodexDelegationStatus["artifacts"]["agentsPolicy"]["state"],
  mode: CodexDelegationMode | null,
): CodexDelegationStatus {
  const value = makeStatus(state, mode);
  value.artifacts.skill.state = skill;
  value.artifacts.agentsPolicy.state = agentsPolicy;
  return value;
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document }, window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator }, localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.append(container as never);
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); root = null; });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function flush() { await new Promise(resolve => setTimeout(resolve, 0)); }

async function render(node: React.ReactNode) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root = createRoot(container); root.render(<LanguageProvider>{node}</LanguageProvider>); await flush(); });
}

function findButton(label: string, within: ParentNode = container): HTMLButtonElement | null {
  return Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.trim() === label) ?? null;
}

function button(label: string, within: ParentNode = container): HTMLButtonElement {
  const found = findButton(label, within);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function radio(mode: CodexDelegationMode): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[value="${mode}"]`);
  if (!found) throw new Error(`Missing radio: ${mode}`);
  return found;
}

function directController(value: CodexDelegationStatus | null, overrides: Partial<CodexDelegationSetupController> = {}): CodexDelegationSetupController {
  return {
    loaded: value !== null, status: value, selectedMode: value?.installedMode ?? "balanced", busy: false, error: null,
    setSelectedMode: () => {}, install: async () => true, uninstall: async () => true, reload: async () => {}, ...overrides,
  };
}

async function mountDirect(value: CodexDelegationStatus | null, overrides: Partial<CodexDelegationSetupController> = {}) {
  function Harness() {
    const [mode, setMode] = useState<CodexDelegationMode>(overrides.selectedMode ?? value?.installedMode ?? "balanced");
    return <CodexDelegationSetupCard delegationSetup={{ ...directController(value, overrides), selectedMode: mode, setSelectedMode: setMode }} />;
  }
  await render(<Harness />);
}

async function mountHook(apiBase = "/hook") {
  function Harness() { return <CodexDelegationSetupCard delegationSetup={useCodexDelegationSetup(apiBase)} />; }
  await render(<Harness />);
}

async function openApply(label: "Install" | "Update" | "Repair" | "Change mode") {
  await act(async () => { button(label).click(); await flush(); });
  return container.querySelector<HTMLElement>('[role="dialog"]')!;
}

test("loading never makes a false not-installed claim", async () => {
  await mountDirect(null);
  expect(container.textContent).toContain("Loading delegation setup");
  expect(container.textContent).not.toContain("Not installed");
});

test("fresh Install requires preview confirmation, sends exact Balanced PUT, and shows the new-task reminder", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let current = makeStatus();
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (init?.method === "PUT") { current = makeStatus("current", "balanced"); return Response.json({ ok: true, status: current }); }
    return Response.json(current);
  };
  await mountHook("/fresh");
  expect(radio("balanced").checked).toBe(true);
  const dialog = await openApply("Install");
  expect(dialog.textContent).toContain("balanced skill from server");
  expect(requests.some(request => request.init?.method === "PUT")).toBe(false);
  await act(async () => { button("Install", dialog).click(); await flush(); });
  const put = requests.find(request => request.init?.method === "PUT")!;
  expect(put.url).toBe("/fresh/api/codex-delegation");
  expect(put.init?.headers).toEqual({ "Content-Type": "application/json" });
  expect(put.init?.body).toBe('{"mode":"balanced"}');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Start a new Codex task");
});

test("Orchestrator selection changes server preview and exact Install PUT", async () => {
  const requests: RequestInit[] = [];
  let current = makeStatus();
  globalThis.fetch = async (_url, init) => {
    requests.push(init ?? {});
    if (init?.method === "PUT") { current = makeStatus("current", "orchestrator"); return Response.json({ ok: true, status: current }); }
    return Response.json(current);
  };
  await mountHook();
  await act(async () => { radio("orchestrator").click(); });
  const dialog = await openApply("Install");
  expect(dialog.textContent).toContain("orchestrator skill from server");
  expect(dialog.textContent).not.toContain("balanced skill from server");
  await act(async () => { button("Install", dialog).click(); await flush(); });
  expect(requests.find(init => init.method === "PUT")?.body).toBe('{"mode":"orchestrator"}');
});

for (const [state, action] of [["update-available", "Update"], ["partial", "Repair"]] as const) {
  test(`${action} confirms its preview and sends the installed mode PUT`, async () => {
    const requests: RequestInit[] = [];
    let current = makeStatus(state, "balanced");
    globalThis.fetch = async (_url, init) => {
      requests.push(init ?? {});
      if (init?.method === "PUT") { current = makeStatus("current", "balanced"); return Response.json({ ok: true, status: current }); }
      return Response.json(current);
    };
    await mountHook(`/${action.toLowerCase()}`);
    const dialog = await openApply(action);
    expect(requests.some(init => init.method === "PUT")).toBe(false);
    await act(async () => { button(action, dialog).click(); await flush(); });
    expect(requests.find(init => init.method === "PUT")?.body).toBe('{"mode":"balanced"}');
  });
}

test("installed Change mode confirms truthfully and sends the selected exact PUT", async () => {
  const requests: RequestInit[] = [];
  let current = makeStatus("current", "balanced");
  globalThis.fetch = async (_url, init) => {
    requests.push(init ?? {});
    if (init?.method === "PUT") { current = makeStatus("current", "orchestrator"); return Response.json({ ok: true, status: current }); }
    return Response.json(current);
  };
  await mountHook("/change");
  expect(container.textContent).toContain("Ready");
  expect(button("Remove")).toBeTruthy();
  await act(async () => { radio("orchestrator").click(); });
  const dialog = await openApply("Change mode");
  expect(dialog.textContent).toContain("orchestrator policy from server");
  expect(requests.some(init => init.method === "PUT")).toBe(false);
  await act(async () => { button("Change mode", dialog).click(); await flush(); });
  expect(requests.find(init => init.method === "PUT")?.body).toBe('{"mode":"orchestrator"}');
});

for (const state of ["conflict", "unsafe"] as const) {
  test(`${state} refuses automatic mutation and projects its distinct reason`, async () => {
    const value = makeStatus(state);
    value.artifacts.skill.reason = state === "conflict" ? "ownership_conflict" : "unsafe_path";
    let installs = 0;
    await mountDirect(value, { install: async () => { installs++; return true; } });
    expect(button("Install").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(state === "conflict" ? "existing file is not managed" : "could not be safely verified");
    button("Install").click();
    expect(installs).toBe(0);
  });
}

test("shadowed current install is truthful and never claims Ready", async () => {
  const value = makeStatus("current", "balanced"); value.activation = "shadowed"; value.override.state = "active";
  await mountDirect(value);
  expect(container.textContent).toContain("Installed, but AGENTS.override.md is active");
  expect(container.textContent).not.toContain("Ready");
});

test("manual details are collapsed and copy the selected server prompt only after clipboard success", async () => {
  const writes: string[] = [];
  Object.defineProperty(testWindow.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { writes.push(text); } } });
  await mountDirect(makeStatus());
  const details = container.querySelector("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  await act(async () => { details.querySelector("summary")!.click(); radio("orchestrator").click(); });
  expect(button("Copy setup").textContent).toBe("Copy setup");
  await act(async () => { button("Copy setup").click(); await flush(); });
  expect(writes).toEqual(["orchestrator manual prompt from server"]);
  expect(button("Copied")).toBeTruthy();
});

test("manual copy failure gives honest unavailable feedback and never claims copied", async () => {
  Object.defineProperty(testWindow.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
  Object.defineProperty(testWindow.document, "execCommand", { configurable: true, value: () => false });
  await mountDirect(makeStatus());
  const details = container.querySelector("details")!;
  await act(async () => { details.querySelector("summary")!.click(); button("Copy setup").click(); await flush(); });
  expect(button("Copy unavailable")).toBeTruthy();
  expect(container.textContent).not.toContain("Copied");
});

test("Remove sends no DELETE before confirm, retains the failed dialog error, then closes and reminds on success", async () => {
  const requests: RequestInit[] = [];
  let deletes = 0; let current = makeStatus("current", "balanced");
  globalThis.fetch = async (_url, init) => {
    requests.push(init ?? {});
    if (init?.method === "DELETE") {
      deletes++;
      if (deletes === 1) return Response.json({ error: "locked" }, { status: 500 });
      current = makeStatus(); return Response.json({ ok: true, status: current });
    }
    return Response.json(current);
  };
  await mountHook("/remove");
  await act(async () => { button("Remove").click(); await flush(); });
  let dialog = container.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(requests.some(init => init.method === "DELETE")).toBe(false);
  await act(async () => { button("Remove", dialog).click(); await flush(); });
  dialog = container.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("request failed");
  expect(requests.find(init => init.method === "DELETE")?.body).toBeUndefined();
  await act(async () => { button("Remove", dialog).click(); await flush(); });
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Start a new Codex task");
});

for (const [name, initial] of [
  ["current", makeArtifactStatus("current", "current", "current", "balanced")],
  ["update available", makeArtifactStatus("update-available", "outdated", "current", "balanced")],
  ["partial managed skill", makeArtifactStatus("partial", "current", "absent", null)],
  ["partial managed policy", makeArtifactStatus("partial", "absent", "outdated", "balanced")],
  ["compatibility collision", makeArtifactStatus("conflict", "current", "outdated", "balanced")],
  ["compatibility collision with managed skill", makeArtifactStatus("conflict", "current", "absent", null)],
  ["compatibility collision with managed policy", makeArtifactStatus("conflict", "absent", "outdated", "balanced")],
] as const) {
  test(`${name} exposes confirmed Remove and sends a bodyless DELETE`, async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let current = initial;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (init?.method === "DELETE") {
        current = makeStatus();
        return Response.json({ ok: true, status: current });
      }
      return Response.json(current);
    };
    await mountHook(`/remove-${name.replaceAll(" ", "-")}`);
    const remove = findButton("Remove");
    expect(remove).not.toBeNull();
    await act(async () => { remove!.click(); await flush(); });
    const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog).toBeTruthy();
    expect(requests.some(request => request.init?.method === "DELETE")).toBe(false);
    await act(async () => { button("Remove", dialog).click(); await flush(); });
    const deletion = requests.find(request => request.init?.method === "DELETE")!;
    expect(deletion.url).toBe(`/remove-${name.replaceAll(" ", "-")}/api/codex-delegation`);
    expect(deletion.init?.body).toBeUndefined();
  });
}

for (const [name, value] of [
  ["aggregate state without managed artifacts", makeArtifactStatus("partial", "absent", "absent", null)],
  ["foreign skill", makeArtifactStatus("conflict", "foreign", "current", "balanced")],
  ["ambiguous agents markers", makeArtifactStatus("conflict", "current", "foreign", "balanced")],
  ["aggregate unsafe", makeArtifactStatus("unsafe", "current", "current", "balanced")],
] as const) {
  test(`${name} never exposes Remove`, async () => {
    let uninstalls = 0;
    await mountDirect(value, { uninstall: async () => { uninstalls++; return true; } });
    expect(Array.from(container.querySelectorAll("button")).some(item => item.textContent?.trim() === "Remove")).toBe(false);
    expect(uninstalls).toBe(0);
  });
}

test("initial GET failure shows Retry and a successful retry restores truthful status", async () => {
  let reads = 0;
  globalThis.fetch = async () => ++reads === 1 ? Response.json({ error: "offline" }, { status: 503 }) : Response.json(makeStatus("current", "orchestrator"));
  await mountHook("/retry-initial");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("request failed");
  await act(async () => { button("Retry").click(); await flush(); });
  expect(reads).toBe(2);
  expect(container.textContent).toContain("Ready");
  expect(radio("orchestrator").checked).toBe(true);
});

test("retained-status refresh failure keeps truth, exposes Retry, and clears the error after recovery", async () => {
  let reads = 0; const current = makeStatus("current", "balanced");
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PUT") return Response.json({ ok: true, status: current });
    reads++;
    if (reads === 2) return Response.json({ error: "refresh failed" }, { status: 503 });
    return Response.json(current);
  };
  await mountHook("/retry-retained");
  const dialog = await openApply("Change mode");
  await act(async () => { button("Change mode", dialog).click(); await flush(); });
  expect(container.textContent).toContain("Ready");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("request failed");
  await act(async () => { button("Retry").click(); await flush(); });
  expect(reads).toBe(3);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Ready");
});

test("a superseded GET cannot replace the newer status", async () => {
  let resolveFirst!: (response: Response) => void; let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    if (reads === 1) return new Promise<Response>(resolve => { resolveFirst = resolve; });
    return Response.json(makeStatus("current", "orchestrator"));
  };
  function Harness() {
    const setup = useCodexDelegationSetup("/race");
    return <><button type="button" onClick={() => { void setup.reload(); }}>Force reload</button><span data-state>{setup.status?.installedMode ?? "none"}</span></>;
  }
  await render(<Harness />);
  await act(async () => { button("Force reload").click(); await flush(); });
  expect(container.querySelector("[data-state]")?.textContent).toBe("orchestrator");
  await act(async () => { resolveFirst(Response.json(makeStatus("current", "balanced"))); await flush(); });
  expect(container.querySelector("[data-state]")?.textContent).toBe("orchestrator");
});

test("unmount aborts the outstanding GET and suppresses its late result", async () => {
  let signal: AbortSignal | undefined; let resolveRead!: (response: Response) => void;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(resolve => { resolveRead = resolve; });
  };
  function Harness() { const setup = useCodexDelegationSetup("/unmount"); return <span>{setup.loaded ? "loaded" : "pending"}</span>; }
  await render(<Harness />);
  await act(async () => { root?.unmount(); root = null; });
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolveRead(Response.json(makeStatus("current", "balanced"))); await flush(); });
  expect(container.textContent).toBe("");
});

test("malformed status is rejected as a visible retriable error", async () => {
  globalThis.fetch = async () => Response.json({ schemaVersion: 1, state: "current" });
  await mountHook("/malformed");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("request failed");
  expect(button("Retry")).toBeTruthy();
  expect(container.textContent).not.toContain("Ready");
});

test("in-flight mutation disables every automatic control and announces busy state", async () => {
  let resolvePut!: (response: Response) => void; const current = makeStatus("current", "balanced");
  globalThis.fetch = async (_url, init) => init?.method === "PUT"
    ? new Promise<Response>(resolve => { resolvePut = resolve; })
    : Response.json(current);
  await mountHook("/busy");
  const dialog = await openApply("Change mode");
  await act(async () => { button("Change mode", dialog).click(); await flush(); });
  expect(container.querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
  expect(button("Preview").disabled).toBe(true);
  expect(button("Change mode").disabled).toBe(true);
  expect(button("Remove").disabled).toBe(true);
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("Working");
  await act(async () => { resolvePut(Response.json({ ok: true, status: current })); await flush(); });
});

test("preview and remove dialogs take the documented safe initial focus", async () => {
  await mountDirect(makeStatus("current", "balanced"));
  await openApply("Change mode");
  await act(async () => { await flush(); });
  expect(document.activeElement).toBe(button("Change mode", container.querySelector('[role="dialog"]')!));
  await act(async () => { button("Close").click(); await flush(); button("Remove").click(); await flush(); });
  await act(async () => { await flush(); });
  expect(document.activeElement).toBe(button("Cancel", container.querySelector('[role="alertdialog"]')!));
});

test("preview and remove dialogs trap forward and reverse Tab at their boundaries", async () => {
  await mountDirect(makeStatus("current", "balanced"));
  const preview = await openApply("Change mode");
  const close = button("Close", preview); const confirm = button("Change mode", preview);
  confirm.focus(); confirm.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  expect(document.activeElement).toBe(close);
  close.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
  expect(document.activeElement).toBe(confirm);
  await act(async () => { close.click(); await flush(); button("Remove").click(); await flush(); });
  const remove = container.querySelector<HTMLElement>('[role="alertdialog"]')!;
  const cancel = button("Cancel", remove); const confirmRemove = button("Remove", remove);
  confirmRemove.focus(); confirmRemove.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  expect(document.activeElement).toBe(cancel);
});

test("Escape and backdrop close each dialog and restore its actual opener", async () => {
  await mountDirect(makeStatus("current", "balanced"));
  const previewOpener = button("Preview"); previewOpener.focus();
  await act(async () => { previewOpener.click(); await flush(); });
  await act(async () => { window.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape" })); await flush(); });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(previewOpener);
  const removeOpener = button("Remove"); removeOpener.focus();
  await act(async () => { removeOpener.click(); await flush(); });
  const backdrop = container.querySelector('[role="alertdialog"]')!.parentElement!;
  await act(async () => { backdrop.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true })); await flush(); });
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.activeElement).toBe(removeOpener);
});

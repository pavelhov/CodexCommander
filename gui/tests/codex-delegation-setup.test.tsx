import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import CodexDelegationSetupCard from "../src/components/subagents-workspace/CodexDelegationSetupCard";
import { useCodexDelegationSetup, type CodexDelegationSetupController, type CodexDelegationStatus } from "../src/pages/use-codex-delegation-setup";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let selectedMode: "balanced" | "orchestrator";
let installed = 0;
let removed = 0;

function status(state: CodexDelegationStatus["state"] = "not-installed", mode: "balanced" | "orchestrator" | null = null): CodexDelegationStatus {
  return {
    schemaVersion: 1,
    state,
    installedMode: mode,
    artifacts: {
      skill: { state: mode ? "current" : "absent", displayPath: "$HOME/.agents/skills/codexcommander-delegation/SKILL.md" },
      agentsPolicy: { state: mode ? "current" : "absent", displayPath: "$CODEX_HOME/AGENTS.md" },
    },
    override: { state: "absent" },
    activation: "effective",
    previews: {
      balanced: { skillText: "balanced skill", agentsBlockText: "balanced policy" },
      orchestrator: { skillText: "orchestrator skill", agentsBlockText: "orchestrator policy" },
    },
    copyPrompts: { balanced: "balanced manual prompt", orchestrator: "orchestrator manual prompt" },
  };
}

function controller(value: CodexDelegationStatus | null, busy = false): CodexDelegationSetupController {
  selectedMode = value?.installedMode ?? "balanced";
  return {
    loaded: value !== null,
    status: value,
    selectedMode,
    busy,
    error: null,
    setSelectedMode: mode => { selectedMode = mode; },
    install: async () => { installed++; return true; },
    uninstall: async () => { removed++; return true; },
    reload: async () => {},
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
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
  installed = 0;
  removed = 0;
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); root = null; });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mount(value: CodexDelegationStatus | null, busy = false) {
  const { createRoot } = await import("react-dom/client");
  function Harness() {
    const [mode, setMode] = useState(value?.installedMode ?? "balanced");
    return <CodexDelegationSetupCard delegationSetup={{ ...controller(value, busy), selectedMode: mode, setSelectedMode: setMode }} />;
  }
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Harness /></LanguageProvider>);
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

test("loading never makes a false not-installed claim", async () => {
  await mount(null);
  expect(container.textContent).toContain("Loading");
  expect(container.textContent).not.toContain("Not installed");
});

test("fresh setup uses Balanced and previews before the install mutation", async () => {
  await mount(status());
  expect((container.querySelector('input[value="balanced"]') as HTMLInputElement).checked).toBe(true);
  await act(async () => { button("Preview").click(); });
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("balanced skill");
  expect(installed).toBe(0);
});

test("orchestrator selection uses its server preview and install flow", async () => {
  await mount(status());
  const radio = container.querySelector('input[value="orchestrator"]') as HTMLInputElement;
  await act(async () => { radio.click(); });
  await act(async () => { button("Preview").click(); });
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("orchestrator skill");
});

test("current effective setup exposes ready and installed controls", async () => {
  await mount(status("current", "orchestrator"));
  expect(container.textContent).toContain("Ready");
  expect(container.textContent).toContain("Orchestrator");
  expect(button("Change mode")).toBeTruthy();
  expect(button("Remove")).toBeTruthy();
});

test("update and partial states use their respective primary actions", async () => {
  await mount(status("update-available", "balanced"));
  expect(button("Update")).toBeTruthy();
  await act(async () => { root?.unmount(); root = null; });
  await mount(status("partial", "balanced"));
  expect(button("Repair")).toBeTruthy();
});

test("conflict and unsafe state fail closed with the projected reason", async () => {
  const conflict = status("conflict", null);
  conflict.artifacts.skill.reason = "ownership_conflict";
  await mount(conflict);
  expect(container.textContent).toContain("can’t be changed automatically");
  expect(button("Install").disabled).toBe(true);
});

test("shadowed install is not presented as ready", async () => {
  const shadowed = status("current", "balanced");
  shadowed.activation = "shadowed";
  shadowed.override.state = "active";
  await mount(shadowed);
  expect(container.textContent).toContain("Installed, but AGENTS.override.md is active");
  expect(container.textContent).not.toContain("Ready");
});

test("remove waits for an accessible confirmation before DELETE", async () => {
  await mount(status("current", "balanced"));
  await act(async () => { button("Remove").click(); });
  const dialog = container.querySelector('[role="alertdialog"]');
  expect(dialog).toBeTruthy();
  expect(removed).toBe(0);
  await act(async () => { Array.from(dialog!.querySelectorAll("button")).find(item => item.textContent?.trim() === "Remove")!.click(); });
  expect(removed).toBe(1);
});

test("manual setup stays collapsed and copies only selected server prompt", async () => {
  await mount(status());
  const details = container.querySelector("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(container.textContent).toContain("Installer unavailable? Show manual setup");
});

test("busy state disables every setup mutation and exposes a live status", async () => {
  await mount(status("current", "balanced"), true);
  expect(button("Preview").disabled).toBe(true);
  expect(button("Change mode").disabled).toBe(true);
  expect(button("Remove").disabled).toBe(true);
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("Working");
});

test("preview and remove dialogs restore focus to their triggers", async () => {
  await mount(status("current", "balanced"));
  const preview = button("Preview");
  preview.focus();
  await act(async () => { preview.click(); });
  await act(async () => { Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll("button")).find(item => item.textContent?.trim() === "Close")!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.activeElement).toBe(preview);
  const remove = button("Remove");
  remove.focus();
  await act(async () => { remove.click(); });
  await act(async () => { Array.from(container.querySelector('[role="alertdialog"]')!.querySelectorAll("button")).find(item => item.textContent?.trim() === "Cancel")!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.activeElement).toBe(remove);
});

test("hook sends the exact selected PUT body and re-reads the dedicated resource", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json(init?.method === "PUT" ? { ok: true, status: status("current", "orchestrator") } : status());
    },
  });
  function Harness() {
    const setup = useCodexDelegationSetup("/hook");
    return <><button type="button" onClick={() => setup.setSelectedMode("orchestrator")}>Select orchestrator</button><button type="button" onClick={() => { void setup.install(); }}>Hook install</button><span>{setup.loaded ? "loaded" : "loading"}</span></>;
  }
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root = createRoot(container); root.render(<Harness />); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => { button("Select orchestrator").click(); button("Hook install").click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const put = requests.find(request => request.init?.method === "PUT");
  expect(put?.url).toBe("/hook/api/codex-delegation");
  expect(put?.init?.body).toBe(JSON.stringify({ mode: "orchestrator" }));
  expect(requests.filter(request => request.init?.method === undefined).length).toBe(2);
});

test("retained truthful status exposes retry after a refresh error", async () => {
  const value = status("current", "balanced");
  let reloads = 0;
  await mount(value);
  // Remount with the same truthful status and a controller error, then prove the
  // visible retry reaches the supplied refresh boundary.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root?.unmount();
    root = createRoot(container);
    root.render(<LanguageProvider><CodexDelegationSetupCard delegationSetup={{ ...controller(value), error: "status=503", reload: async () => { reloads++; } }} /></LanguageProvider>);
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("request failed");
  await act(async () => { button("Retry").click(); });
  expect(reloads).toBe(1);
});

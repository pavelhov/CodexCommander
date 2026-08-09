import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { readJsonOrThrow } from "../fetch-json";
import type { StartupHealthStatus } from "../startup-health-ui";
import type { StartupRoutingKind } from "./startup-shared";

export type DashboardSection = "overview" | "providers" | "models";

export function readDashboardSectionFromHash(): DashboardSection {
  const raw = window.location.hash.replace(/^#\/?/, "");
  if (raw === "dashboard/providers") return "providers";
  if (raw === "dashboard/models") return "models";
  return "overview";
}

/** Overview is the bare `#dashboard`; the other sections carry a suffix. */
export function dashboardHashForSection(section: DashboardSection): string {
  return section === "overview" ? "dashboard" : `dashboard/${section}`;
}

/** Like readJsonOrThrow, but rejects empty/204 bodies that would otherwise yield undefined. */
export async function requireJson<T>(res: Response, fallbackMessage?: string): Promise<T> {
  const data = await readJsonOrThrow<T>(res, fallbackMessage);
  if (data === undefined) throw new Error(fallbackMessage ?? "empty response");
  return data;
}

export interface HealthData { status: string; version: string; uptime: number }
export interface ProviderInfo { name: string; adapter: string; baseUrl: string; defaultModel?: string; hasApiKey: boolean }
export interface ModelInfo { id: string; provider: string; namespaced: string; owned_by?: string }
export interface SettingsData {
  codexAutoStart: boolean;
  port: number;
  hostname: string;
  /** IANA zone of the machine running the proxy, used to render log timestamps (#725). */
  timeZone?: string;
  startupHealth?: {
    status: "native" | "protected" | "at-risk";
    routingKind: StartupRoutingKind;
    autostartEnabled: boolean;
    shimCoverage: "full" | "cli-only" | "none";
    diagnosticStale: boolean;
  };
}
export type SidecarBackend = "openai" | "anthropic";
export interface SidecarSetting { backend?: SidecarBackend; model: string }
export interface SidecarData { webSearch: SidecarSetting; vision: SidecarSetting }
export interface SidecarPatch {
  webSearch?: { backend?: SidecarBackend | null; model?: string };
  vision?: { backend?: SidecarBackend | null; model?: string };
}
export type { ShadowCallData } from "./shadow-call-source";
export interface UsageSummary30d { summary: { requests: number; totalTokens: number; coverageRatio: number } }
export interface SyncResult {
  ok: boolean;
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  cacheSynced: boolean;
  message: string;
  warning?: string;
  nativeSubagentDefaultsWarning?: string;
  staleAppServerHint?: string;
  projectConfigWarnings?: ProjectCodexConfigWarning[];
}
export interface ProjectCodexConfigWarning {
  path: string;
  code: string;
  detail: string;
  message: string;
}
export interface ProjectCodexConfigGroup {
  path: string;
  issues: string[];
  bypass: string;
}
export const EFFORT_CAP_LEVELS = ["low", "medium", "high", "xhigh"];

export function mergeSidecarSetting(
  current: SidecarSetting,
  update?: { backend?: SidecarBackend | null; model?: string },
): SidecarSetting {
  const merged = { ...current };
  if (update?.model !== undefined) merged.model = update.model;
  if (update?.backend === null) delete merged.backend;
  else if (update?.backend !== undefined) merged.backend = update.backend;
  return merged;
}

export function sidecarModelOptions(models: ModelInfo[]) {
  const out: Array<{ value: string; label: string }> = [];
  for (const model of models) {
    if (model.provider === "openai" || model.provider === "anthropic") {
      out.push({ value: model.id, label: `${model.provider}/${model.id}` });
    }
  }
  return out;
}

/** Options for shadow-call replacement models use the proxy's canonical routing id. */
export function shadowCallModelOptions(models: ModelInfo[], current: string | undefined) {
  const out = [{ value: "", label: "—" }, ...models.map(model => ({ value: model.namespaced, label: model.namespaced }))];
  if (current && !out.some(option => option.value === current)) out.push({ value: current, label: current });
  return out;
}

export function sidecarBackendForModel(models: ModelInfo[], modelId: string): SidecarBackend {
  return models.find(model => model.id === modelId)?.provider === "anthropic" ? "anthropic" : "openai";
}

let lastInputWasKeyboard = false;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("keydown", () => { lastInputWasKeyboard = true; }, { capture: true, passive: true });
  window.addEventListener("pointerdown", () => { lastInputWasKeyboard = false; }, { capture: true, passive: true });
}

function focusTriggerQuietly(trigger: HTMLButtonElement | null) {
  if (!trigger) return;
  if (lastInputWasKeyboard) {
    trigger.focus({ preventScroll: true });
    return;
  }
  try {
    trigger.focus({ preventScroll: true, focusVisible: false });
  } catch {
    trigger.focus({ preventScroll: true });
  }
}

export function useModalDialog(open: boolean, triggerRef: RefObject<HTMLButtonElement | null>) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) dialog.showModal();
      return;
    }

    if (dialog.open) dialog.close();
    focusTriggerQuietly(triggerRef.current);
  }, [open, triggerRef]);

  useEffect(() => () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    focusTriggerQuietly(triggerRef.current);
  }, [triggerRef]);

  return dialogRef;
}

export type { StartupHealthStatus };

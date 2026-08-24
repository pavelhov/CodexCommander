import { useCallback, useEffect, useRef, useState } from "react";

export type CodexDelegationMode = "balanced" | "orchestrator";
export type CodexDelegationArtifactState = "absent" | "current" | "outdated" | "foreign" | "unsafe";

export interface CodexDelegationStatus {
  schemaVersion: 1;
  state: "not-installed" | "current" | "update-available" | "partial" | "conflict" | "unsafe";
  installedMode: CodexDelegationMode | null;
  artifacts: {
    skill: { state: CodexDelegationArtifactState; displayPath: string; reason?: string };
    agentsPolicy: { state: CodexDelegationArtifactState; displayPath: string; reason?: string };
  };
  override: { state: "absent" | "empty" | "active" | "unsafe" };
  activation: "effective" | "shadowed" | "unknown";
  previews: Record<CodexDelegationMode, { skillText: string; agentsBlockText: string }>;
  copyPrompts: Record<CodexDelegationMode, string>;
}

type MutationResponse = { ok?: boolean; status?: CodexDelegationStatus; error?: string };

export interface CodexDelegationSetupController {
  loaded: boolean;
  status: CodexDelegationStatus | null;
  selectedMode: CodexDelegationMode;
  busy: boolean;
  error: string | null;
  setSelectedMode(mode: CodexDelegationMode): void;
  install(): Promise<boolean>;
  uninstall(): Promise<boolean>;
  reload(): Promise<void>;
}

const modes = ["balanced", "orchestrator"] as const;
const states = ["not-installed", "current", "update-available", "partial", "conflict", "unsafe"] as const;
const artifacts = ["absent", "current", "outdated", "foreign", "unsafe"] as const;
const includes = <T extends string>(items: readonly T[], value: unknown): value is T => typeof value === "string" && items.includes(value as T);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function isStatus(value: unknown): value is CodexDelegationStatus {
  const data = record(value); const artifactSet = record(data?.artifacts); const skill = record(artifactSet?.skill); const policy = record(artifactSet?.agentsPolicy); const previews = record(data?.previews); const balanced = record(previews?.balanced); const orchestrator = record(previews?.orchestrator); const prompts = record(data?.copyPrompts); const override = record(data?.override);
  return data?.schemaVersion === 1 && includes(states, data.state) && (data.installedMode === null || includes(modes, data.installedMode))
    && !!skill && !!policy && includes(artifacts, skill.state) && includes(artifacts, policy.state) && typeof skill.displayPath === "string" && typeof policy.displayPath === "string"
    && !!balanced && !!orchestrator && typeof balanced.skillText === "string" && typeof balanced.agentsBlockText === "string" && typeof orchestrator.skillText === "string" && typeof orchestrator.agentsBlockText === "string"
    && !!prompts && typeof prompts.balanced === "string" && typeof prompts.orchestrator === "string" && !!override && includes(["absent", "empty", "active", "unsafe"] as const, override.state) && includes(["effective", "shadowed", "unknown"] as const, data.activation);
}

async function responseError(response: Response): Promise<string> {
  try {
    const data = await response.json() as MutationResponse;
    return typeof data.error === "string" ? data.error : `status=${response.status}`;
  } catch {
    return `status=${response.status}`;
  }
}

export function useCodexDelegationSetup(apiBase: string): CodexDelegationSetupController {
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<CodexDelegationStatus | null>(null);
  const [selectedMode, setSelectedMode] = useState<CodexDelegationMode>("balanced");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const selectedModeRef = useRef<CodexDelegationMode>("balanced");
  const selectedModeInitialized = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const chooseMode = useCallback((mode: CodexDelegationMode) => {
    selectedModeRef.current = mode;
    setSelectedMode(mode);
  }, []);

  const reload = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch(`${apiBase}/api/codex-delegation`, { signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const next: unknown = await response.json();
      if (!isStatus(next)) throw new Error("invalid delegation status");
      if (controller.signal.aborted) return;
      setStatus(next);
      if (!selectedModeInitialized.current) {
        selectedModeInitialized.current = true;
        const nextMode = next.installedMode ?? "balanced";
        selectedModeRef.current = nextMode;
        setSelectedMode(nextMode);
      }
      setError(null);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setLoaded(true);
    }
  }, [apiBase]);

  useEffect(() => {
    void (async () => { await reload(); })();
    return () => requestRef.current?.abort();
  }, [reload]);

  const mutate = useCallback(async (method: "PUT" | "DELETE"): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/codex-delegation`, method === "PUT" ? {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: selectedModeRef.current }),
      } : { method });
      const payload = await response.json() as MutationResponse;
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `status=${response.status}`);
      await reload();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [apiBase, reload]);

  return { loaded, status, selectedMode, busy, error, setSelectedMode: chooseMode, install: () => mutate("PUT"), uninstall: () => mutate("DELETE"), reload };
}

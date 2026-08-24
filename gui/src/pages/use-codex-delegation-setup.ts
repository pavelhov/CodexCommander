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

function isMode(value: unknown): value is CodexDelegationMode {
  return value === "balanced" || value === "orchestrator";
}

function isStatus(value: unknown): value is CodexDelegationStatus {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<CodexDelegationStatus>;
  return data.schemaVersion === 1 && typeof data.state === "string" && (isMode(data.installedMode) || data.installedMode === null);
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
  const chooseMode = useCallback((mode: CodexDelegationMode) => {
    selectedModeRef.current = mode;
    setSelectedMode(mode);
  }, []);

  const reload = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/codex-delegation`);
      if (!response.ok) throw new Error(await responseError(response));
      const next: unknown = await response.json();
      if (!isStatus(next)) throw new Error("invalid delegation status");
      setStatus(next);
      const nextMode = next.installedMode ?? (selectedModeRef.current === "orchestrator" ? "orchestrator" : "balanced");
      selectedModeRef.current = nextMode;
      setSelectedMode(nextMode);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  }, [apiBase]);

  useEffect(() => {
    void (async () => { await reload(); })();
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

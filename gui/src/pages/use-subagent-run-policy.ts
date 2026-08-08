import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Draft/commit controller for the subagent run-policy endpoints:
 *
 * - `GET/PUT /api/v2` — multiAgentMode + maxConcurrentThreadsPerSession.
 * - `GET/PUT /api/subagent-model-fallback` — fallback chain + poll interval.
 * - `GET/PUT /api/effort-caps` — global and subagent reasoning-effort ceilings.
 *
 * The hook keeps a committed snapshot of what the server last reported and a
 * draft the caller edits through the setters. `save()` sends one PUT per
 * endpoint group that actually changed (with only the changed fields), then
 * re-reads every endpoint so successful groups reconcile against what the
 * server stored. Groups whose PUT failed keep their unsaved draft values, so
 * `dirty` stays true for them and the user can retry without re-entering
 * anything. `save()` resolves `true` only when every attempt succeeded.
 */

export type MultiAgentMode = "v1" | "default" | "v2";

type GroupName = "v2" | "fallback" | "effort-caps";

type Snapshot = {
  mode: MultiAgentMode;
  concurrency: number | null;
  fallbackModels: string[];
  pollMs: number;
  effortCap: string | null;
  subagentEffortCap: string | null;
};

const DEFAULT_POLL_MS = 60_000;
const POLL_MS_MIN = 5_000;
const POLL_MS_MAX = 600_000;

function parseMode(value: unknown): MultiAgentMode {
  return value === "v1" || value === "v2" ? value : "default";
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function readErrorMessage(res: Response): Promise<string> {
  let msg = `status=${res.status}`;
  try {
    const data: unknown = await res.json();
    if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
      msg = (data as { error: string }).error;
    }
  } catch { /* non-JSON error body: keep the status line */ }
  return msg;
}

export function useSubagentRunPolicy(apiBase: string) {
  const [committed, setCommitted] = useState<Snapshot | null>(null);
  const [mode, setMode] = useState<MultiAgentMode>("default");
  const [concurrency, setConcurrency] = useState<number | null>(null);
  const [fallbackModels, setFallbackModels] = useState<string[]>([]);
  const [fallbackAvailable, setFallbackAvailable] = useState<string[]>([]);
  const [pollMs, setPollMs] = useState<number>(DEFAULT_POLL_MS);
  const [effortCap, setEffortCap] = useState<string | null>(null);
  const [subagentEffortCap, setSubagentEffortCap] = useState<string | null>(null);
  const [efforts, setEfforts] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const readAll = useCallback(async (): Promise<{ snap: Snapshot; available: string[]; efforts: string[] }> => {
    const [v2Res, fbRes, ecRes] = await Promise.all([
      fetch(`${apiBase}/api/v2`),
      fetch(`${apiBase}/api/subagent-model-fallback`),
      fetch(`${apiBase}/api/effort-caps`),
    ]);
    const bad: string[] = [];
    if (!v2Res.ok) bad.push("v2");
    if (!fbRes.ok) bad.push("fallback");
    if (!ecRes.ok) bad.push("effort-caps");
    if (bad.length > 0) throw new Error(`load=${bad.join(",")}`);
    const [v2, fb, ec]: [unknown, unknown, unknown] = await Promise.all([
      v2Res.json(), fbRes.json(), ecRes.json(),
    ]);
    const v2o = (v2 && typeof v2 === "object" ? v2 : {}) as Record<string, unknown>;
    const fbo = (fb && typeof fb === "object" ? fb : {}) as Record<string, unknown>;
    const eco = (ec && typeof ec === "object" ? ec : {}) as Record<string, unknown>;
    return {
      snap: {
        mode: parseMode(v2o.multiAgentMode),
        concurrency: typeof v2o.maxConcurrentThreadsPerSession === "number"
          && Number.isFinite(v2o.maxConcurrentThreadsPerSession)
          ? v2o.maxConcurrentThreadsPerSession
          : null,
        fallbackModels: parseStringArray(fbo.models),
        pollMs: typeof fbo.pollMs === "number" && Number.isFinite(fbo.pollMs) ? fbo.pollMs : DEFAULT_POLL_MS,
        effortCap: parseNullableString(eco.effortCap),
        subagentEffortCap: parseNullableString(eco.subagentEffortCap),
      },
      available: parseStringArray(fbo.available),
      efforts: parseStringArray(eco.efforts),
    };
  }, [apiBase]);

  const applySnapshot = useCallback((fresh: { snap: Snapshot; available: string[]; efforts: string[] }) => {
    setCommitted(fresh.snap);
    setMode(fresh.snap.mode);
    setConcurrency(fresh.snap.concurrency);
    setFallbackModels(fresh.snap.fallbackModels);
    setPollMs(fresh.snap.pollMs);
    setEffortCap(fresh.snap.effortCap);
    setSubagentEffortCap(fresh.snap.subagentEffortCap);
    setFallbackAvailable(fresh.available);
    setEfforts(fresh.efforts);
  }, []);

  useEffect(() => {
    let cancelled = false;
    readAll().then(fresh => {
      if (cancelled) return;
      applySnapshot(fresh);
      setLoaded(true);
      setError(null);
    }).catch((e: unknown) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : String(e));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [readAll, applySnapshot]);

  const dirty = committed !== null && (
    mode !== committed.mode
    || concurrency !== committed.concurrency
    || !sameStrings(fallbackModels, committed.fallbackModels)
    || pollMs !== committed.pollMs
    || effortCap !== committed.effortCap
    || subagentEffortCap !== committed.subagentEffortCap
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!committed || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const failures: string[] = [];
    const failedGroups = new Set<GroupName>();

    const put = async (group: GroupName, path: string, body: Record<string, unknown>): Promise<void> => {
      try {
        const res = await fetch(`${apiBase}${path}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          failures.push(`${group}: ${await readErrorMessage(res)}`);
          failedGroups.add(group);
        }
      } catch (e) {
        failures.push(`${group}: ${e instanceof Error ? e.message : String(e)}`);
        failedGroups.add(group);
      }
    };

    const tasks: Promise<void>[] = [];

    const v2Body: Record<string, unknown> = {};
    if (mode !== committed.mode) v2Body.multiAgentMode = mode;
    if (concurrency !== committed.concurrency) v2Body.maxConcurrentThreadsPerSession = concurrency;
    if (Object.keys(v2Body).length > 0) {
      if ("maxConcurrentThreadsPerSession" in v2Body
          && concurrency !== null
          && (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1)) {
        // Null deliberately restores the Codex default; other invalid values
        // never reach the wire.
        failures.push("v2: maxConcurrentThreadsPerSession must be an integer >= 1, or null");
        failedGroups.add("v2");
      } else {
        tasks.push(put("v2", "/api/v2", v2Body));
      }
    }

    const fbBody: Record<string, unknown> = {};
    if (!sameStrings(fallbackModels, committed.fallbackModels)) fbBody.models = fallbackModels;
    if (pollMs !== committed.pollMs) fbBody.pollMs = pollMs;
    if (Object.keys(fbBody).length > 0) {
      if ("pollMs" in fbBody && (!Number.isInteger(pollMs) || pollMs < POLL_MS_MIN || pollMs > POLL_MS_MAX)) {
        failures.push("fallback: pollMs must be an integer between 5000 and 600000");
        failedGroups.add("fallback");
      } else {
        tasks.push(put("fallback", "/api/subagent-model-fallback", fbBody));
      }
    }

    const ecBody: Record<string, unknown> = {};
    if (effortCap !== committed.effortCap) ecBody.effortCap = effortCap;
    if (subagentEffortCap !== committed.subagentEffortCap) ecBody.subagentEffortCap = subagentEffortCap;
    if (Object.keys(ecBody).length > 0) {
      tasks.push(put("effort-caps", "/api/effort-caps", ecBody));
    }

    await Promise.all(tasks);

    // Re-read every endpoint after the attempts: successful groups adopt what
    // the server actually stored; failed groups keep their unsaved draft.
    try {
      const fresh = await readAll();
      setCommitted(fresh.snap);
      setFallbackAvailable(fresh.available);
      setEfforts(fresh.efforts);
      if (!failedGroups.has("v2")) {
        setMode(fresh.snap.mode);
        setConcurrency(fresh.snap.concurrency);
      }
      if (!failedGroups.has("fallback")) {
        setFallbackModels(fresh.snap.fallbackModels);
        setPollMs(fresh.snap.pollMs);
      }
      if (!failedGroups.has("effort-caps")) {
        setEffortCap(fresh.snap.effortCap);
        setSubagentEffortCap(fresh.snap.subagentEffortCap);
      }
    } catch (e) {
      failures.push(`reload=${e instanceof Error ? e.message : String(e)}`);
    }

    if (failures.length > 0) setError(failures.join("; "));
    savingRef.current = false;
    setSaving(false);
    return failures.length === 0;
  }, [apiBase, committed, mode, concurrency, fallbackModels, pollMs, effortCap, subagentEffortCap, readAll]);

  const reload = useCallback(async (): Promise<boolean> => {
    try {
      const fresh = await readAll();
      applySnapshot(fresh);
      setLoaded(true);
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [readAll, applySnapshot]);

  return {
    loaded,
    loading,
    saving,
    error,
    mode,
    setMode,
    concurrency,
    setConcurrency,
    fallbackModels,
    setFallbackModels,
    fallbackAvailable,
    pollMs,
    setPollMs,
    effortCap,
    setEffortCap,
    subagentEffortCap,
    setSubagentEffortCap,
    efforts,
    dirty,
    save,
    reload,
  };
}

export type SubagentRunPolicy = ReturnType<typeof useSubagentRunPolicy>;

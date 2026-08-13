import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { useI18n } from "../i18n/shared";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import {
  PROJECT_CONFIG_DIAGNOSTICS_POLL_MS,
  STARTUP_HEALTH_STALE_RETRY_MS,
  probeNeedsFastRetry,
  seedStartupHealthFromSettings,
  type StartupHealthStatus,
} from "../startup-health-ui";
import {
  fetchDashboardMaMode,
  fetchDashboardModels,
  fetchDashboardMultiAgent,
  fetchDashboardOverview,
  fetchDashboardSettings,
  fetchDashboardSidecars,
  fetchProjectConfigDiagnostics,
  fetchStartupHealth,
  normalizeInjectionSelection,
  type DashboardEpochRefs,
} from "./dashboard-core-poll";
import { useUsageReport } from "../usage-report-store";
import {
  type DashboardSection,
  type HealthData,
  type ModelInfo,
  type ProjectCodexConfigGroup,
  type ProviderInfo,
  type SettingsData,
  type ShadowCallData,
  type SidecarData,
  type SidecarPatch,
  type SyncResult,
  type UsageSummary30d,
  mergeSidecarSetting,
  readDashboardSectionFromHash,
  requireJson,
  sidecarModelOptions,
  useModalDialog,
} from "./dashboard-shared";

const CONTROLS_CACHE_PREFIX = "ccx.dash.controls.v1:";
const OVERVIEW_CACHE_PREFIX = "ccx.dash.overview.v1:";
const STARTUP_CACHE_PREFIX = "ccx.dash.startup.v1:";
const MA_MODE_CACHE_PREFIX = "ccx.dash.maMode.v1:";

type CachedControls = {
  settings?: SettingsData | null;
  sidecar?: SidecarData | null;
  shadowCall?: ShadowCallData | null;
};

type CachedOverview = {
  health: HealthData;
  providers: ProviderInfo[];
};

type MaMode = "v1" | "default" | "v2";

function controlsCacheKey(apiBase: string): string {
  return `${CONTROLS_CACHE_PREFIX}${apiBase}`;
}

export function useDashboardData(apiBase: string) {
  const { locale, t } = useI18n();
  // The hash is the source of truth for the active section (#dashboard, …).
  const [selectedSection, setSelectedSection] = useState<DashboardSection>(readDashboardSectionFromHash);
  const [modelQuery, setModelQuery] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const cachedControls = useMemo(
    () => readSessionListCache<CachedControls>(controlsCacheKey(apiBase)),
    [apiBase],
  );
  const cachedOverview = useMemo(
    () => readSessionListCache<CachedOverview>(`${OVERVIEW_CACHE_PREFIX}${apiBase}`),
    [apiBase],
  );
  const cachedStartup = useMemo(() => {
    const cached = readSessionListCache<StartupHealthStatus>(`${STARTUP_CACHE_PREFIX}${apiBase}`);
    return cached === "error" ? null : cached;
  }, [apiBase]);
  const cachedMaMode = useMemo(
    () => readSessionListCache<MaMode>(`${MA_MODE_CACHE_PREFIX}${apiBase}`),
    [apiBase],
  );
  const [health, setHealth] = useState<HealthData | null>(() => cachedOverview?.health ?? null);
  const [startupHealth, setStartupHealth] = useState<StartupHealthStatus | null>(() => cachedStartup);
  const [providers, setProviders] = useState<ProviderInfo[]>(() => cachedOverview?.providers ?? []);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(() => cachedControls?.settings ?? null);
  const [sidecar, setSidecar] = useState<SidecarData | null>(() => cachedControls?.sidecar ?? null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(() => cachedControls?.shadowCall ?? null);
  const [sidecarSaving, setSidecarSaving] = useState(false);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [maMode, setMaMode] = useState<MaMode>(() => cachedMaMode ?? "default");
  const [maBusy, setMaBusy] = useState(false);
  const [maHelpOpen, setMaHelpOpen] = useState(false);
  const [effortCapHelpOpen, setEffortCapHelpOpen] = useState(false);
  const [shadowCallHelpOpen, setShadowCallHelpOpen] = useState(false);
  const [injectionModel, setInjectionModel] = useState<string>("");
  const [injectionEffort, setInjectionEffort] = useState<string>("");
  const [injectionEfforts, setInjectionEfforts] = useState<string[]>([]);
  const [injectionAvailable, setInjectionAvailable] = useState<Array<{ provider: string; model: string; namespaced: string }>>([]);
  const [injectionSaving, setInjectionSaving] = useState(false);
  const [multiAgentGuidanceEnabled, setMultiAgentGuidanceEnabled] = useState(true);
  const [syncCodexSubagentDefaults, setSyncCodexSubagentDefaults] = useState(false);
  const [effortCap, setEffortCap] = useState<string>("");
  const [subagentEffortCap, setSubagentEffortCap] = useState<string>("");
  const [effortCapSaving, setEffortCapSaving] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [projectConfigWarnings, setProjectConfigWarnings] = useState<ProjectCodexConfigGroup[]>([]);
  const settingsRequestEpochRef = useRef(0);
  const settingsMutationEpochRef = useRef(0);
  const settingsMutationInFlightRef = useRef(false);
  const shadowCallRequestEpochRef = useRef(0);
  const shadowCallMutationEpochRef = useRef(0);
  const shadowCallMutationInFlightRef = useRef(false);
  const [error, setError] = useState(false);
  const effortCapHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const maHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const shadowCallHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const effortCapHelpDialogRef = useModalDialog(effortCapHelpOpen, effortCapHelpTriggerRef);
  const maHelpDialogRef = useModalDialog(maHelpOpen, maHelpTriggerRef);
  const shadowCallHelpDialogRef = useModalDialog(shadowCallHelpOpen, shadowCallHelpTriggerRef);

  useEffect(() => {
    const onHash = () => setSelectedSection(readDashboardSectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const startupHealthRef = useRef<StartupHealthStatus | null>(cachedStartup);
  /** Bumped whenever the dedicated startup-health poll commits; core polls ignore older generations. */
  const startupHealthGenerationRef = useRef(0);
  const epochRefs = useRef<DashboardEpochRefs>({
    settingsRequestEpochRef,
    settingsMutationEpochRef,
    settingsMutationInFlightRef,
    shadowCallRequestEpochRef,
    shadowCallMutationEpochRef,
    shadowCallMutationInFlightRef,
  }).current;

  const startupHealthPoll = useKeyedClientResource(
    `dashboard-startup-health:${apiBase}`,
    [apiBase],
    (signal) => fetchStartupHealth(apiBase, signal),
    { pollMs: 30_000 },
  );

  /*
   * `/api/startup-health` answers instantly from a 30s cache and resolves the real probe in the
   * background, so a cold answer is a conservative placeholder. Waiting for the next 30s tick is
   * what made the chip look stuck until an unrelated action (refresh quota, tab hop) remounted it.
   * Re-ask in ~2s while the server says it is still working.
   */
  const startupHealthStale = probeNeedsFastRetry(startupHealthPoll.data);
  const refreshStartupHealth = startupHealthPoll.refresh;
  useEffect(() => {
    if (!startupHealthStale) return;
    const timer = window.setTimeout(() => { void refreshStartupHealth(); }, STARTUP_HEALTH_STALE_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [startupHealthStale, refreshStartupHealth]);

  // Wave 1: status/uptime/providers must not wait on injection-model / usage.
  const overviewPoll = useKeyedClientResource(
    `dashboard-overview:${apiBase}`,
    [apiBase],
    (signal) => fetchDashboardOverview(apiBase, signal),
    { pollMs: 5000 },
  );
  const overviewReady = health !== null || overviewPoll.data !== undefined;

  // Preferences that are just config — never gate on overview or injection.
  const maModePoll = useKeyedClientResource(
    `dashboard-ma-mode:${apiBase}`,
    [apiBase],
    (signal) => fetchDashboardMaMode(apiBase, signal),
    { pollMs: 5000 },
  );

  const sidecarPoll = useKeyedClientResource(
    `dashboard-sidecars:${apiBase}`,
    [apiBase],
    async (signal) => {
      const startupHealthGeneration = startupHealthGenerationRef.current;
      const data = await fetchDashboardSidecars(apiBase, signal, epochRefs);
      return { ...data, startupHealthGeneration };
    },
    { pollMs: 5000 },
  );

  const settingsPoll = useKeyedClientResource(
    `dashboard-settings:${apiBase}`,
    [apiBase],
    async (signal) => {
      const startupHealthGeneration = startupHealthGenerationRef.current;
      const data = await fetchDashboardSettings(apiBase, signal, epochRefs);
      return { ...data, startupHealthGeneration };
    },
    { pollMs: 5000 },
  );

  // Wave 2: heavier peers start after overview commits (or session seed) to cut contention.
  const multiAgentPoll = useKeyedClientResource(
    `dashboard-multi-agent:${apiBase}`,
    [apiBase],
    (signal) => fetchDashboardMultiAgent(apiBase, signal),
    { pollMs: 5000, enabled: overviewReady },
  );

  // Usage is owned by the shared usage-report store (key `${apiBase}:30d:all`). The Usage
  // page selects the same entry, so both surfaces dedupe into one in-flight fetch. Keeping
  // it out of the client-resource polls means usage can never delay health/settings commits.
  const usageReport = useUsageReport(apiBase, "30d", "all");
  const usage30d = useMemo<UsageSummary30d | null>(() => {
    const report = usageReport.data;
    if (!report) return null;
    return {
      summary: {
        requests: report.summary.requests,
        totalTokens: report.summary.totalTokens,
        coverageRatio: report.summary.coverageRatio,
      },
    };
  }, [usageReport.data]);

  const diagnosticsPoll = useKeyedClientResource(
    `dashboard-diagnostics:${apiBase}`,
    [apiBase],
    (signal) => fetchProjectConfigDiagnostics(apiBase, signal),
    { pollMs: PROJECT_CONFIG_DIAGNOSTICS_POLL_MS, enabled: overviewReady },
  );

  const modelsPoll = useKeyedClientResource(
    `dashboard-models:${apiBase}`,
    [apiBase, error],
    (signal) => fetchDashboardModels(apiBase, signal),
    { enabled: overviewReady && !error },
  );

  /* eslint-disable react-hooks/set-state-in-effect -- mirror client-resource snapshots into mutable dashboard UI state that handlers also update */
  useEffect(() => {
    if (startupHealthPoll.data !== undefined) {
      const probe = startupHealthPoll.data;
      startupHealthGenerationRef.current += 1;
      setStartupHealth(probe.status);
      startupHealthRef.current = probe.status;
      // Never persist hard errors — a cold SWR miss used to poison revisits.
      // A stale answer is a placeholder too: caching it makes the next visit start from
      // the server's guess instead of asking again.
      if (probe.status !== "error" && !probe.stale) {
        writeSessionListCache(`${STARTUP_CACHE_PREFIX}${apiBase}`, probe.status);
      }
    }
  }, [startupHealthPoll.data, apiBase]);

  useEffect(() => {
    const data = overviewPoll.data;
    if (!data) return;
    if (data.health) {
      setHealth(data.health);
      setProviders(data.providers);
      writeSessionListCache(`${OVERVIEW_CACHE_PREFIX}${apiBase}`, {
        health: data.health,
        providers: data.providers,
      });
    }
    setError(data.error);
  }, [overviewPoll.data, apiBase]);

  useEffect(() => {
    if (maModePoll.data === undefined) return;
    setMaMode(maModePoll.data.maMode);
    writeSessionListCache(`${MA_MODE_CACHE_PREFIX}${apiBase}`, maModePoll.data.maMode);
  }, [maModePoll.data, apiBase]);

  // Derived — avoids setState-on-prop-change for the resolved flag. Cache / poll / optimistic
  // save (which writes the same cache key) all count as resolved for MA UI.
  const maModeResolved = maModePoll.data !== undefined || cachedMaMode !== null;

  useEffect(() => {
    const data = multiAgentPoll.data;
    if (!data) return;
    if (data.injection) {
      setMultiAgentGuidanceEnabled(data.injection.multiAgentGuidanceEnabled);
      setSyncCodexSubagentDefaults(data.injection.syncCodexSubagentDefaults);
      setInjectionModel(data.injection.injectionModel);
      setInjectionEffort(data.injection.injectionEffort);
      setInjectionEfforts(data.injection.injectionEfforts);
      setInjectionAvailable(data.injection.injectionAvailable);
    }
    if (data.effortCaps) {
      setEffortCap(data.effortCaps.effortCap);
      setSubagentEffortCap(data.effortCaps.subagentEffortCap);
    }
  }, [multiAgentPoll.data]);

  useEffect(() => {
    const data = sidecarPoll.data;
    if (!data) return;
    setSidecar(data.sidecar);
    if (data.shadowCall !== undefined) setShadowCall(data.shadowCall);
    const prev = readSessionListCache<CachedControls>(controlsCacheKey(apiBase)) ?? {};
    writeSessionListCache(controlsCacheKey(apiBase), {
      ...prev,
      sidecar: data.sidecar,
      ...(data.shadowCall !== undefined ? { shadowCall: data.shadowCall } : {}),
    });
  }, [sidecarPoll.data, apiBase]);

  useEffect(() => {
    const data = settingsPoll.data;
    if (!data) return;
    if (data.settings !== undefined) setSettings(data.settings);
    // Latest-wins: only seed from settings when no newer dedicated probe has committed
    // while this settings poll was in flight. Always merge against the live ref.
    if (
      data.startupHealthSeed !== undefined
      && data.startupHealthGeneration === startupHealthGenerationRef.current
    ) {
      const merged = seedStartupHealthFromSettings(startupHealthRef.current, data.startupHealthSeed);
      setStartupHealth(merged);
      startupHealthRef.current = merged;
      if (merged) writeSessionListCache(`${STARTUP_CACHE_PREFIX}${apiBase}`, merged);
    }
    if (data.settings !== undefined) {
      const prev = readSessionListCache<CachedControls>(controlsCacheKey(apiBase)) ?? {};
      writeSessionListCache(controlsCacheKey(apiBase), {
        ...prev,
        settings: data.settings,
      });
    }
  }, [settingsPoll.data, apiBase]);

  useEffect(() => {
    if (diagnosticsPoll.data) setProjectConfigWarnings(diagnosticsPoll.data);
  }, [diagnosticsPoll.data]);

  useEffect(() => {
    if (modelsPoll.data) setModels(modelsPoll.data);
    setModelsLoading(modelsPoll.loading);
  }, [modelsPoll.data, modelsPoll.loading]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => () => {
    settingsRequestEpochRef.current += 1;
    shadowCallRequestEpochRef.current += 1;
  }, []);

  const grouped = useMemo(() => {
    const g: Record<string, ModelInfo[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);
  const filteredGroups = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return grouped;
    const out: Array<[string, ModelInfo[]]> = [];
    for (const [provider, rows] of grouped) {
      const hits = rows.filter(m => m.id.toLowerCase().includes(q) || provider.toLowerCase().includes(q));
      if (hits.length > 0) out.push([provider, hits]);
    }
    return out;
  }, [grouped, modelQuery]);
  const sidecarModels = useMemo(() => {
    const opts = sidecarModelOptions(models);
    for (const id of [sidecar?.webSearch.model, sidecar?.vision.model]) {
      if (id && !opts.some(option => option.value === id)) {
        opts.unshift({ value: id, label: id });
      }
    }
    return opts;
  }, [models, sidecar]);

  const saveSidecar = async (patch: SidecarPatch) => {
    if (!sidecar || sidecarSaving) return;
    const previous = sidecar;
    const next = {
      webSearch: mergeSidecarSetting(sidecar.webSearch, patch.webSearch),
      vision: mergeSidecarSetting(sidecar.vision, patch.vision),
    };
    setSidecarSaving(true);
    setSidecar(next);
    try {
      const res = await fetch(`${apiBase}/api/sidecar-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await requireJson<SidecarData>(res, "save failed");
      setSidecar({ webSearch: data.webSearch, vision: data.vision });
      const prev = readSessionListCache<CachedControls>(controlsCacheKey(apiBase)) ?? {};
      writeSessionListCache(controlsCacheKey(apiBase), {
        ...prev,
        sidecar: { webSearch: data.webSearch, vision: data.vision },
      });
    } catch {
      setSidecar(previous);
    } finally {
      setSidecarSaving(false);
    }
  };

  async function saveShadowCall(patch: Partial<ShadowCallData>) {
    if (!shadowCall || shadowCallSaving) return;
    const previous = shadowCall;
    const updated = { ...shadowCall, ...patch };
    setShadowCallSaving(true);
    shadowCallMutationInFlightRef.current = true;
    setShadowCall(updated);
    try {
      const res = await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("shadow-call save failed");
      shadowCallMutationEpochRef.current += 1;
    } catch {
      setShadowCall(previous);
    } finally {
      shadowCallMutationInFlightRef.current = false;
      setShadowCallSaving(false);
    }
  }

  const switchMaMode = async (mode: "v1" | "default" | "v2") => {
    if (maBusy || maMode === mode) return;
    setMaBusy(true);
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiAgentMode: mode }),
      });
      if (r.ok) {
        setMaMode(mode);
        writeSessionListCache(`${MA_MODE_CACHE_PREFIX}${apiBase}`, mode);
      }
    } catch { /* ignore */ }
    finally { setMaBusy(false); }
  };

  const saveInjection = async (patch: {
    multiAgentGuidanceEnabled?: boolean;
    syncCodexSubagentDefaults?: boolean;
    model?: string | null;
    effort?: string | null;
  }) => {
    if (injectionSaving) return;
    setInjectionSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/injection-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("injection save failed");
      const getRes = await fetch(`${apiBase}/api/injection-model`);
      const data = await requireJson<{
        multiAgentGuidanceEnabled?: boolean;
        syncCodexSubagentDefaults?: boolean;
        model?: string | null;
        effort?: string | null;
        efforts?: string[];
        available?: Array<{ provider: string; model: string; namespaced: string }>;
      }>(getRes);
      const normalized = normalizeInjectionSelection(data);
      setMultiAgentGuidanceEnabled(normalized.multiAgentGuidanceEnabled);
      setSyncCodexSubagentDefaults(normalized.syncCodexSubagentDefaults);
      setInjectionModel(normalized.injectionModel);
      setInjectionEffort(normalized.injectionEffort);
      if (Array.isArray(data.efforts)) setInjectionEfforts(data.efforts);
      if (Array.isArray(data.available)) setInjectionAvailable(data.available);
    } catch { /* keep the last committed UI state */ }
    finally { setInjectionSaving(false); }
  };

  const toggleCodexAutoStart = async () => {
    if (!settings || settingsSaving) return;
    const next = !settings.codexAutoStart;
    setSettingsSaving(true);
    settingsMutationInFlightRef.current = true;
    setSettings({ ...settings, codexAutoStart: next });
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAutoStart: next }),
      });
      const data = await requireJson<{ codexAutoStart: boolean; startupHealth?: SettingsData["startupHealth"] }>(res, "save failed");
      settingsMutationEpochRef.current += 1;
      setSettings(prev => prev ? { ...prev, codexAutoStart: data.codexAutoStart, startupHealth: data.startupHealth ?? prev.startupHealth } : prev);
    } catch {
      setSettings(prev => prev ? { ...prev, codexAutoStart: !next } : prev);
      setError(true);
    } finally {
      settingsMutationInFlightRef.current = false;
      setSettingsSaving(false);
    }
  };

  // Clears the sync result/error in this hook. The dashboard toast owns its own dismissal
  // timer but must publish the dismissal here: syncResult/syncError live above the dashboard
  // tabs, so a component-local flag alone would let a stale result remount as a fresh toast
  // after the Overview panel unmounts and comes back.
  const clearSyncFeedback = useCallback(() => {
    setSyncResult(null);
    setSyncError(null);
  }, []);

  const runSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const res = await fetch(`${apiBase}/api/sync`, { method: "POST" });
      const data = await requireJson<SyncResult & { projectConfigGrouped?: ProjectCodexConfigGroup[] }>(res, "sync failed");
      setSyncResult(data);
      if (data.projectConfigGrouped) setProjectConfigWarnings(data.projectConfigGrouped);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  return {
    apiBase,
    locale, t,
    selectedSection, setSelectedSection,
    modelQuery, setModelQuery,
    expandedProviders, setExpandedProviders,
    health, startupHealth, providers, models, settings, sidecar, shadowCall, usage30d,
    usageLoading: usageReport.loading && !usage30d,
    healthLoading: overviewPoll.loading && !health,
    sidecarSaving, shadowCallSaving, modelsLoading, settingsSaving, syncing,
    maMode, maModeResolved, maBusy, setMaHelpOpen, maHelpOpen,
    effortCapHelpOpen, setEffortCapHelpOpen, shadowCallHelpOpen, setShadowCallHelpOpen,
    injectionModel, injectionEffort, injectionEfforts, injectionAvailable, injectionSaving,
    multiAgentGuidanceEnabled, syncCodexSubagentDefaults, saveInjection,
    effortCap, subagentEffortCap, effortCapSaving, setEffortCap, setSubagentEffortCap, setEffortCapSaving,
    syncResult, syncError, projectConfigWarnings, error,
    effortCapHelpTriggerRef, maHelpTriggerRef, shadowCallHelpTriggerRef,
    effortCapHelpDialogRef, maHelpDialogRef, shadowCallHelpDialogRef,
    filteredGroups, sidecarModels,
    saveSidecar, saveShadowCall, switchMaMode, toggleCodexAutoStart, runSync, clearSyncFeedback,
  };
}

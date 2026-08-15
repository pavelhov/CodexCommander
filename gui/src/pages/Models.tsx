import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Switch, Notice, EmptyState, Select } from "../ui";
import {
  IconAlert,
  IconBot,
  IconBoxes,
  IconCheck,
  IconChevron,
  IconHardDrive,
  IconInfo,
  IconSearch,
  IconShuffle,
} from "../icons";
import { useT } from "../i18n/shared";
import type { TFn, TKey } from "../i18n/shared";
import { modelLabel } from "../model-display";
import { formatNamespacedModelId, formatProviderDisplayName } from "../provider-icons";
import { type ComboItem, parseComboList } from "../combo-workspace-data";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { setClientResourceData } from "../client-resource";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { providerRouteHash } from "../provider-route";
import {
  buildProviderModelGroups,
  type ConfiguredProviderSummary,
  type ProviderModelGroup,
} from "../models-groups";
import {
  fetchSelectedModels,
  modelVisible,
  putModelVisibility,
  shouldApplyLoadGeneration,
  type ProviderModelMap,
  type ModelVisibilityScope,
  type ModelVisibilityTarget,
} from "../model-visibility";
import {
  activeModelOptions,
  CAP_OPTION_SET,
  CAP_OPTIONS,
  collectDisabledNamespaced,
  CUSTOM_OPTION,
  fmtK,
  PAGE,
  readCollapsedProviders,
  readCombosOpen,
  THREAD_OPTION_SET,
  THREAD_OPTIONS,
  writeCollapsedProviders,
  writeCombosOpen,
  discoveryFailureLabel,
  isPositiveContextCap,
  summarizeContextPolicy,
  type ModelRow,
  type ProviderContextCapsResponse,
  type ShadowCallData,
  type V2Status,
} from "./models-shared";
import { EmptyProviderHint } from "./models-provider-hints";
import { shadowCallModelOptions } from "./dashboard-shared";
import { parseShadowCallData, shadowSourceModelBadge, shadowSourceModelLabel } from "./shadow-call-source";

type CachedModelsPage = {
  models: ModelRow[];
  providers: ConfiguredProviderSummary[];
  selectedModels: ProviderModelMap;
  disabled: string[];
  contextCaps: Record<string, number>;
  contextCapValue: number;
};

function requireProviderContextCaps(
  data: ProviderContextCapsResponse | undefined,
  message: string,
): ProviderContextCapsResponse {
  if (
    !data
    || !Number.isInteger(data.value)
    || data.value <= 0
    || data.caps === null
    || typeof data.caps !== "object"
    || Array.isArray(data.caps)
    || Object.values(data.caps).some(value => !Number.isInteger(value) || value <= 0)
  ) {
    throw new Error(message);
  }
  return data;
}

function requireV2Status(data: V2Status | undefined, message: string): V2Status {
  if (
    !data
    || typeof data.enabled !== "boolean"
    || typeof data.agentsMaxThreadsConflict !== "boolean"
    || (data.maxConcurrentThreadsPerSession !== null
      && (!Number.isInteger(data.maxConcurrentThreadsPerSession) || data.maxConcurrentThreadsPerSession < 1))
    || (data.multiAgentMode !== "v1" && data.multiAgentMode !== "default" && data.multiAgentMode !== "v2")
  ) {
    throw new Error(message);
  }
  return data;
}

/** Session JSON is untrusted — only seed rows that survive parseComboList (targets always arrays). */
function readCachedCombos(value: unknown): ComboItem[] | null {
  if (!Array.isArray(value)) return null;
  return parseComboList({ combos: value });
}

export default function Models({ apiBase }: { apiBase: string }) {
  const t: TFn = useT();
  const cacheKey = `ccx.models.catalog.v1:${apiBase}`;
  const cached = useMemo(() => readSessionListCache<CachedModelsPage>(cacheKey), [cacheKey]);
  const [models, setModels] = useState<ModelRow[]>(() => cached?.models ?? []);
  const [providers, setProviders] = useState<ConfiguredProviderSummary[]>(() => cached?.providers ?? []);
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set(cached?.disabled ?? []));
  const [selectedModels, setSelectedModels] = useState<ProviderModelMap | null>(() => cached?.selectedModels ?? null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [limit, setLimit] = useState<Record<string, number>>({});
  const [contextCaps, setContextCaps] = useState<Record<string, number>>(() => cached?.contextCaps ?? {});
  const [contextCapValue, setContextCapValue] = useState(() => cached?.contextCapValue ?? 350_000);
  const [contextCapDraft, setContextCapDraft] = useState(() => cached?.contextCapValue ?? 350_000);
  const [contextDraftMode, setContextDraftMode] = useState<"full" | "limited">("full");
  const [customCap, setCustomCap] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const initialCollapsed = readCollapsedProviders();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapsed ?? new Set());
  const needsDefaultCollapseRef = useRef(initialCollapsed === null);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  // Feedback generation: a repeated identical message (same success string, same validation
  // error) must still re-arm the toast timer. Clearing `status` alone is not enough — a
  // second identical value bails out of React's state diff, so the old timer would dismiss
  // the new toast early. Every publish bumps the generation.
  const [feedbackGen, setFeedbackGen] = useState(0);
  const publishFeedback = (nextOk: boolean, message: string) => {
    setOk(nextOk);
    setStatus(message);
    setFeedbackGen(g => g + 1);
  };
  // Transient action feedback as a fixed toast: appearing or auto-clearing it never shifts
  // the workspace below (the old inline Notice pushed the whole model grid down by its
  // height on every apply). The timer itself just clears the status again.
  useEffect(() => {
    if (!status) return;
    const holdMs = ok ? 6000 : 8000;
    const timer = setTimeout(() => setStatus(""), holdMs);
    return () => clearTimeout(timer);
  }, [status, ok, feedbackGen]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const loadPendingRef = useRef(false);
  // null while the canonical collaboration settings have not loaded.
  const [v2, setV2] = useState<V2Status | null>(null);
  const [v2LoadError, setV2LoadError] = useState("");
  const [v2Busy, setV2Busy] = useState(false);
  const [v2Note, setV2Note] = useState("");
  const v2BusyRef = useRef(false);
  const [threadsCustom, setThreadsCustom] = useState("");
  const [showThreadsCustom, setShowThreadsCustom] = useState(false);
  const [v2HelpOpen, setV2HelpOpen] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [customModalMode, setCustomModalMode] = useState<"add" | "edit">("add");
  const [customModalProvider, setCustomModalProvider] = useState("");
  const [customModalId, setCustomModalId] = useState("");
  const [customFormModelId, setCustomFormModelId] = useState("");
  const [customFormDisplayName, setCustomFormDisplayName] = useState("");
  const [customFormContextWindow, setCustomFormContextWindow] = useState("");
  const [customFormShowCustomCtx, setCustomFormShowCustomCtx] = useState(false);
  const [customFormModalities, setCustomFormModalities] = useState<string[]>(["text"]);
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState("");
  const [hoveredModel, setHoveredModel] = useState<{ namespaced: string; rect: DOMRect } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);
  const [behaviorEditor, setBehaviorEditor] = useState<"collaboration" | "context" | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Combo summary section. null = cold load with no seed (pending strut). Failed reads stay
  // null + combosError so an API error never masquerades as "no combos configured".
  const combosCacheKey = `ccx.models.combos.v1:${apiBase}`;
  const seededCombos = useMemo(() => {
    const own = readCachedCombos(readSessionListCache<unknown>(combosCacheKey));
    if (own !== null) return own;
    // Reuse the Combos workspace session snapshot when Models opens first in the session.
    const workspace = readSessionListCache<{ combos?: unknown }>(`ccx.combos.workspace.v1:${apiBase}`);
    return readCachedCombos(workspace?.combos);
  }, [apiBase, combosCacheKey]);
  const combosResource = useDataSurface<ComboItem[]>(
    `models-combos:${apiBase}`,
    [apiBase],
    async (signal) => {
      const r = await fetch(`${apiBase}/api/combos`, { signal });
      const j = await readJsonOrThrow<unknown>(r);
      const next = parseComboList(j);
      writeSessionListCache(combosCacheKey, next);
      return next;
    },
    { isEmpty: () => false, initialData: seededCombos ?? undefined },
  );
  const combosState = combosResource.state;
  // Keep a previously painted card on a later failure so the catalog does not yank down.
  const combos = combosState.data ?? seededCombos;
  // Announce failures even when stale/seeded rows remain (layout kept; freshness not faked).
  const combosError = combosState.showError;
  const [combosOpen, setCombosOpen] = useState(readCombosOpen);

  // App owns the in-session view mode; fallback to persisted mode for isolated renders/tests.
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const toggleCombosOpen = () => {
    const next = !combosOpen;
    writeCombosOpen(next);
    setCombosOpen(next);
  };

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const shadowModelOptions = useMemo(
    () => activeModelOptions(models, disabled, selectedModels ?? {}, t),
    [models, disabled, selectedModels, t],
  );
  const shadowCallOptions = useMemo(() => {
    const activeNamespaced = new Set(shadowModelOptions.map(option => option.value));
    return shadowCallModelOptions(models.filter(model => activeNamespaced.has(model.namespaced)), shadowCall?.model);
  }, [models, shadowCall?.model, shadowModelOptions]);

  const loadShadowCall = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/api/shadow-call-settings`);
      const data = await readJsonIfOk<unknown>(r);
      if (data) setShadowCall(parseShadowCallData(data));
    } catch { /* network or malformed response: retain the last good setting */ }
  }, [apiBase]);

  const loadV2 = useCallback(async () => {
    // Never let a toggle in flight be clobbered by the poll (same single-flight rule as models).
    if (v2BusyRef.current) return;
    try {
      const r = await fetch(`${apiBase}/api/v2`);
      const data = requireV2Status(
        await readJsonOrThrow<V2Status>(r, t("models.loadFail")),
        t("models.loadFail"),
      );
      setV2(data);
      setV2LoadError("");
    } catch (error) {
      // Keep the last confirmed collaboration settings visible. A malformed
      // successful poll is an error, not evidence that the feature disappeared.
      setV2LoadError(error instanceof Error ? error.message : t("models.loadFail"));
    }
  }, [apiBase, t]);

  const fetchCatalog = useCallback(async (signal: AbortSignal): Promise<CachedModelsPage> => {
    const [modelsRes, capsRes, providersRes, selectionData] = await Promise.all([
      fetch(`${apiBase}/api/models`),
      fetch(`${apiBase}/api/provider-context-caps`),
      fetch(`${apiBase}/api/providers`),
      fetchSelectedModels(apiBase),
    ]);
    const [data, capsPayload, providerData] = await Promise.all([
      readJsonOrThrow<ModelRow[]>(modelsRes),
      readJsonOrThrow<ProviderContextCapsResponse>(capsRes),
      readJsonOrThrow<ConfiguredProviderSummary[]>(providersRes),
    ]);
    if (data === undefined || providerData === undefined) {
      throw new Error("models payload missing");
    }
    const capsData = requireProviderContextCaps(capsPayload, "models payload missing");
    if (signal.aborted) throw new Error("models request aborted");
    const nextDisabled = collectDisabledNamespaced(data);
    const next = {
      models: data,
      providers: providerData,
      selectedModels: selectionData,
      disabled: [...nextDisabled],
      contextCaps: capsData.caps,
      contextCapValue: capsData.value,
    } satisfies CachedModelsPage;
    writeSessionListCache(cacheKey, next);
    return next;
  }, [apiBase, cacheKey]);

  const applyCatalog = useCallback((next: CachedModelsPage) => {
    const nextGroups = buildProviderModelGroups(next.models, next.providers);
    setSelectedProvider(prev => (
      prev !== null && !nextGroups.some(group => group.provider === prev)
        ? null
        : prev
    ));
    setModels(next.models);
    setProviders(next.providers);
    setDisabled(new Set(next.disabled));
    setSelectedModels(next.selectedModels);
    setContextCapValue(next.contextCapValue);
    setContextCaps(next.contextCaps);
  }, []);

  const catalogResource = useDataSurface<CachedModelsPage>(
    cacheKey,
    [apiBase],
    async (signal) => {
      const next = await fetchCatalog(signal);
      // A manual mutation refresh may have invalidated this request while its JSON was decoding.
      // Do not let the aborted catalog repaint controls after the newer result is applied.
      if (signal.aborted) throw new Error("models request aborted");
      applyCatalog(next);
      return next;
    },
    { isEmpty: () => false, pollMs: 10_000, initialData: cached ?? undefined },
  );
  const catalogState = catalogResource.state;

  const load = useCallback(async (force = false): Promise<boolean> => {
    if (loadPendingRef.current && !force) return false;
    loadPendingRef.current = true;
    const generation = ++loadGenerationRef.current;
    try {
      const next = await fetchCatalog(new AbortController().signal);
      if (!shouldApplyLoadGeneration(generation, loadGenerationRef.current)) return false;
      applyCatalog(next);
      // Follow-up mutation refreshes retain their existing awaitable contract while publishing
      // the result through the same shared store used by the initial catalog subscription.
      setClientResourceData(cacheKey, next);
      return true;
    } catch {
      return false;
    } finally {
      if (shouldApplyLoadGeneration(generation, loadGenerationRef.current)) {
        loadPendingRef.current = false;
      }
    }
  }, [applyCatalog, cacheKey, fetchCatalog]);

  // Shadow/v2 controls must not wait on the models catalog (live discovery can be slow).
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadShadowCall();
      void loadV2();
    }, 0);
    const timer = window.setInterval(() => {
      if (!v2BusyRef.current) void loadV2();
    }, 10000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(timer);
    };
  }, [loadShadowCall, loadV2]);

  const groups = useMemo(
    () => buildProviderModelGroups(models, providers),
    [models, providers],
  );

  const routedProviderNames = useMemo(
    () => groups.filter(group => !group.native && group.rows.length > 0).map(group => group.provider),
    [groups],
  );
  const contextPolicy = useMemo(
    () => summarizeContextPolicy(routedProviderNames, contextCaps, contextCapValue),
    [contextCapValue, contextCaps, routedProviderNames],
  );

  // One-shot default collapse. It stays an effect on `groups` so CACHED groups collapse
  // immediately on first paint, even when revalidation is slow or fails; moving it into
  // the load() success path would render cached providers expanded and leave them
  // expanded whenever the refresh errors.
  useEffect(() => {
    if (!needsDefaultCollapseRef.current) return;
    if (groups.length === 0) return;
    needsDefaultCollapseRef.current = false;
    const all = new Set(groups.map(group => group.provider));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(all);
    writeCollapsedProviders(all);
  }, [groups]);

  const effectiveVisibleCount = useMemo(() => {
    if (!selectedModels) return 0;
    return models.filter(model => modelVisible(
      selectedModels,
      model.provider,
      model.id,
      model.native === true,
      disabled.has(model.namespaced),
    )).length;
  }, [disabled, models, selectedModels]);

  const applyVisibility = async (
    scope: ModelVisibilityScope,
    provider: string,
    targets: ModelVisibilityTarget[],
    enabled: boolean,
  ) => {
    ++loadGenerationRef.current;
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    let errorKey: "models.saveFailed" | "models.networkError" | null = null;
    try {
      const response = await putModelVisibility(apiBase, scope, provider, targets, enabled);
      if (!response.ok) errorKey = "models.saveFailed";
    } catch {
      errorKey = "models.networkError";
    } finally {
      const refreshed = await load(true);
      if (errorKey) {
        setOk(false);
        setStatus(t(errorKey));
      } else if (refreshed) {
        setOk(true);
        setStatus(t("models.applied"));
      }
      setBusy(false);
      busyRef.current = false;
    }
  };

  const toggleProviderCap = async (provider: string) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    // Any positive stored value means the provider is capped. Treat a stale value as
    // capped too, so the first click always removes the policy instead of silently
    // replacing it with the current global value.
    const enabled = !isPositiveContextCap(contextCaps[provider]);
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, enabled }),
      });
      try {
        const data = requireProviderContextCaps(
          await readJsonOrThrow<ProviderContextCapsResponse>(r, t("models.capSaveFailed")),
          t("models.capSaveFailed"),
        );
        setContextCapValue(data.value);
        setContextCaps(data.caps);
        setOk(true);
        setStatus(t("models.capApplied"));
        await load(true);
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.capSaveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };
  const toggleCollapse = (p: string) => {
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p); else n.add(p);
      writeCollapsedProviders(n);
      return n;
    });
  };
  const setAllCollapsed = (collapse: boolean) => {
    setCollapsed(() => {
      const n = collapse ? new Set(groups.map(group => group.provider)) : new Set<string>();
      writeCollapsedProviders(n);
      return n;
    });
  };

  const putCap = async (body: Record<string, unknown>) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      try {
        const data = requireProviderContextCaps(
          await readJsonOrThrow<ProviderContextCapsResponse>(r, t("models.capSaveFailed")),
          t("models.capSaveFailed"),
        );
        setContextCapValue(data.value);
        setContextCaps(data.caps);
        setOk(true);
        setStatus(t("models.capApplied"));
        await load(true);
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.capSaveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const onSelectCap = (raw: string) => {
    if (raw === CUSTOM_OPTION) { setShowCustom(true); setCustomCap(String(contextCapDraft)); return; }
    setShowCustom(false);
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) setContextCapDraft(Math.floor(value));
  };

  const applyCustomCap = () => {
    const value = Number(customCap.replace(/[_,\s]/g, ""));
    if (!Number.isFinite(value) || value <= 0) { publishFeedback(false, t("models.capSaveFailed")); return; }
    setShowCustom(false);
    setContextCapDraft(Math.floor(value));
  };

  const toggleContextEditor = () => {
    if (behaviorEditor === "context") {
      setBehaviorEditor(null);
      return;
    }
    setContextDraftMode(contextPolicy.state === "uncapped" ? "full" : "limited");
    setContextCapDraft(contextCapValue);
    setCustomCap(String(contextCapValue));
    setShowCustom(false);
    setBehaviorEditor("context");
  };

  const applyContextPolicy = () => {
    if (contextDraftMode === "full") {
      void putCap({ setAll: false });
      return;
    }
    if (!Number.isFinite(contextCapDraft) || contextCapDraft <= 0) {
      setOk(false);
      setStatus(t("models.capSaveFailed"));
      return;
    }
    void putCap({ value: Math.floor(contextCapDraft), setAll: true });
  };

  const saveShadowCall = async (patch: Partial<ShadowCallData>) => {
    if (!shadowCall || shadowCallSaving) return;
    const previous = shadowCall;
    setShadowCallSaving(true);
    setShadowCall({ ...shadowCall, ...patch });
    try {
      const response = await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const saved = parseShadowCallData(
        await readJsonOrThrow<unknown>(response, t("models.saveFailed")),
      );
      setShadowCall(saved);
    } catch (error) {
      setShadowCall(previous);
      setOk(false);
      setStatus(error instanceof Error ? error.message : t("models.saveFailed"));
    } finally {
      setShadowCallSaving(false);
    }
  };

  const setMultiAgentMode = async (mode: "v1" | "default" | "v2") => {
    if (!v2 || v2BusyRef.current) return;
    if (v2.multiAgentMode === mode) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiAgentMode: mode }),
      });
      try {
        const data = await readJsonOrThrow<V2Status & { warnings?: string[] }>(r, t("models.saveFailed"));
        setV2(requireV2Status(data, t("models.saveFailed")));
        setOk(true);
        setStatus(t("models.v2Applied"));
        setV2Note((data?.warnings ?? []).join(" "));
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.saveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setV2Busy(false);
      v2BusyRef.current = false;
    }
  };

  const putV2Threads = async (value: number) => {
    // Same guards as the flag toggle: single-flight + server-side idempotence
    // (setMaxConcurrentThreads no-ops on equal value), so a re-selected current
    // value or a double click can never double-write config.toml.
    if (!v2 || v2BusyRef.current) return;
    if (!Number.isInteger(value) || value < 1) { publishFeedback(false, t("models.v2ThreadsInvalid")); return; }
    if (v2.maxConcurrentThreadsPerSession === value) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrentThreadsPerSession: value }),
      });
      try {
        const data = await readJsonOrThrow<V2Status & { warnings?: string[] }>(r, t("models.saveFailed"));
        setV2(requireV2Status(data, t("models.saveFailed")));
        setOk(true);
        setStatus(t("models.v2ThreadsApplied"));
        setShowThreadsCustom(false);
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.saveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setV2Busy(false);
      v2BusyRef.current = false;
    }
  };

  const onSelectThreads = (raw: string) => {
    if (raw === CUSTOM_OPTION) { setShowThreadsCustom(true); setThreadsCustom(String(v2?.maxConcurrentThreadsPerSession ?? "")); return; }
    setShowThreadsCustom(false);
    void putV2Threads(Number(raw));
  };

  const onRowEnter = (namespaced: string, el: HTMLElement) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredModel({ namespaced, rect: el.getBoundingClientRect() });
    }, 300);
  };

  const onRowFocus = (namespaced: string, el: HTMLElement) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredModel({ namespaced, rect: el.getBoundingClientRect() });
  };

  const onRowLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHoveredModel(null), 120);
  };

  const keepRowTipOpen = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  };

  const addCustomModel = async (
    provider: string,
    modelId: string,
    displayName?: string,
    contextWindow?: number,
    inputModalities?: string[],
  ) => {
    setCustomSaving(true);
    setCustomError("");
    try {
      const r = await fetch(`${apiBase}/api/custom-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelId, displayName, contextWindow, inputModalities }),
      });
      try {
        await readJsonOrThrow(r, t("models.customSaveFailed"));
        setCustomModalOpen(false);
        publishFeedback(true, t("models.customAdded"));
        await load(true);
      } catch (e) {
        setCustomError(e instanceof Error ? e.message : t("models.customSaveFailed"));
      }
    } catch {
      setCustomError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const updateCustomModel = async (id: string, patch: Record<string, unknown>) => {
    setCustomSaving(true);
    setCustomError("");
    try {
      const r = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      try {
        await readJsonOrThrow(r, t("models.customSaveFailed"));
        setCustomModalOpen(false);
        publishFeedback(true, t("models.customUpdated"));
        await load(true);
      } catch (e) {
        setCustomError(e instanceof Error ? e.message : t("models.customSaveFailed"));
      }
    } catch {
      setCustomError(t("models.networkError"));
    } finally {
      setCustomSaving(false);
    }
  };

  const deleteCustomModel = async (id: string) => {
    try {
      const r = await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r.ok) {
        publishFeedback(true, t("models.customDeleted"));
        await load(true);
      } else {
        publishFeedback(false, t("models.customSaveFailed"));
      }
    } catch {
      publishFeedback(false, t("models.networkError"));
    }
  };

  const catalog = catalogState.data ?? cached;

  // A session seed keeps the workspace usable during the first shared-resource revalidation.
  // Without a catalog, the skeleton owns the only live region for this transition.
  if (catalogState.showSkeleton && !catalog) {
    return (
      <DataSurfaceSkeleton label={t("models.loading")} rows={5} />
    );
  }
  if (catalogState.kind === "failed-cold") {
    const reason = catalogState.error instanceof Error ? catalogState.error.message : t("models.loadFail");
    return (
      <>
        <Notice tone="err">{reason}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => catalogResource.refresh()}>{t("common.retry")}</button>
      </>
    );
  }

  const selectedModelMap = selectedModels ?? {};

  const renderGroup = (group: ProviderModelGroup<ModelRow>) => {
    const { provider, rows, native, liveModels, discovery } = group;
    const q = catalogQuery.trim().toLowerCase();
    const isCollapsed = collapsed.has(provider) && q === "";
    // Final visibility, not just the disable flag: a model is visible to Codex only when the
    // provider allowlist admits it AND it is not disabled. Reading `disabled` alone made the
    // switches disagree with what the picker actually offers.
    const isVisible = (model: ModelRow) => modelVisible(
      selectedModelMap,
      provider,
      model.id,
      model.native === true,
      disabled.has(model.namespaced),
    );
    const activeCount = rows.filter(isVisible).length;
    const providerCap = contextCaps[provider];
    const capOn = isPositiveContextCap(providerCap);
    const isNative = native;
    const discoveryFailure = liveModels && discovery?.status === "failed" ? discovery : undefined;
    const discoveryLabel = t(liveModels ? "models.discoveryAutoOn" : "models.discoveryAutoOff");
    const providerSettingsHref = `#${providerRouteHash(provider, "settings")}`;
    const providerMatchesQuery = provider.toLowerCase().includes(q);
    const filtered = q && !providerMatchesQuery
      ? rows.filter(model => (
        model.id.toLowerCase().includes(q)
        || model.namespaced.toLowerCase().includes(q)
        || model.displayName?.toLowerCase().includes(q)
      ))
      : rows;
    // Display-only: enabled models float to the top of each provider group so they
    // stay findable in long lists. The sort is stable, so the server order is kept
    // inside each partition, and this does not affect the picker order above
    // (visibility toggles still only filter).
    const sorted = filtered.toSorted((a, b) => Number(!isVisible(a)) - Number(!isVisible(b)));
    const shown = limit[provider] ?? PAGE;
    const visible = sorted.slice(0, shown);
    const remaining = filtered.length - visible.length;
     // An empty provider has nothing to send: keep both bulk buttons inert so we never PUT an
     // empty target list (the management API rejects it with 400).
     const hasRows = rows.length > 0;
     const allOn = !hasRows || rows.every(isVisible);
     const allOff = !hasRows || rows.every(m => !isVisible(m));
     const bulkToggle = (enable: boolean) => {
       if (!hasRows) return;
       void applyVisibility(
         "provider",
         provider,
         rows.map(m => ({ id: m.id, native: m.native === true })),
         enable,
       );
     };
    return (
      <div key={provider} className="models-provider-group">
       <div className={`group-head models-provider-head${isCollapsed ? "" : " open"}`}>
          <div className="models-provider-identity">
            <button
              type="button"
              className="row models-provider-toggle"
              onClick={() => toggleCollapse(provider)}
              aria-expanded={!isCollapsed}
            >
              <IconChevron style={{ width: 14, height: 14, color: "var(--muted)", transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform .12s" }} />
              <span className="text-body font-semibold">{provider}</span>
              {isNative && <span className="models-chip muted mono text-caption">{t("models.nativeGroupLabel")}</span>}
              {discoveryFailure && (
                <span
                  className="badge badge-amber"
                  role="status"
                  title={discoveryFailureLabel(t, discoveryFailure)}
                >
                  {t("models.discoveryFailedBadge")}
                </span>
              )}
            </button>
            {!isNative && (
              <a
                className={`models-provider-discovery${liveModels ? " is-live" : " is-static"}`}
                href={providerSettingsHref}
                aria-label={`${discoveryLabel}. ${t("models.openProviderSettings")}`}
              >
                <span className="models-provider-discovery-dot" aria-hidden="true" />
                {discoveryLabel}
              </a>
            )}
          </div>
          <span className="models-provider-visible mono text-label">
            <span className="sr-only">{t("models.tableVisible")}: </span>
            {t("models.visibleCount", { active: activeCount, total: rows.length })}
          </span>
          {isNative ? (
            <span className="models-context-policy models-context-policy--full">
              <span className="sr-only">{t("models.tableContext")}: </span>
              <IconCheck aria-hidden="true" />
              {t("models.contextProviderNative")}
            </span>
          ) : (
            <span className={`models-context-policy${capOn ? " models-context-policy--capped" : " models-context-policy--full"}`}>
              <span className="sr-only">{t("models.tableContext")}: </span>
              {capOn ? <IconInfo aria-hidden="true" /> : <IconCheck aria-hidden="true" />}
              {capOn
                ? t("models.contextProviderCapped", { value: fmtK(providerCap) })
                : t("models.contextProviderFull")}
            </span>
          )}
          <div className="row models-provider-actions">
            {!isNative && (
              <button
                type="button"
                className="btn btn-ghost btn-sm text-caption"
                onClick={() => {
                  setCustomModalMode("add");
                  setCustomModalProvider(provider);
                  setCustomModalId("");
                  setCustomFormModelId("");
                  setCustomFormDisplayName("");
                  setCustomFormContextWindow("");
                  setCustomFormShowCustomCtx(false);
                  setCustomFormModalities(["text"]);
                  setCustomError("");
                  setCustomModalOpen(true);
                }}
                aria-label={t("models.customAdd")}
                aria-haspopup="dialog"
              >+</button>
            )}
            <button type="button" className="btn btn-ghost btn-sm text-caption" disabled={busy || allOn} onClick={() => bulkToggle(true)}>{t("models.allOn")}</button>
            <button type="button" className="btn btn-ghost btn-sm text-caption" disabled={busy || allOff} onClick={() => bulkToggle(false)}>{t("models.allOff")}</button>
          </div>
        </div>
        {!isCollapsed && (
          <div className="models-provider-body">
            {isNative && <p className="muted text-label models-provider-hint">{t("models.nativeHint")}</p>}
            {rows.length === 0 && (
              <EmptyProviderHint provider={provider} liveModels={liveModels} discovery={discovery} showFailureBadge={false} />
            )}
             {visible.map(m => {
               // The row reflects the same final-visibility answer as the count and the picker.
               const off = !isVisible(m);
               return (
                 <div
                   key={m.namespaced}
                   className="model-row-wrap"
                   onMouseEnter={(e) => onRowEnter(m.namespaced, e.currentTarget)}
                   onMouseLeave={onRowLeave}
                   onFocus={(e) => onRowFocus(m.namespaced, e.currentTarget)}
                   onBlur={(e) => {
                     if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoveredModel(null);
                   }}
                 >
                   <div className="row models-model-row">
                     <Switch on={!off} onClick={() => void applyVisibility("models", provider, [{ id: m.id, native: m.native === true }], off)} disabled={busy} label={m.native ? m.id : m.namespaced} />
                      <code className="mono text-control" style={{ color: off ? "var(--faint)" : "var(--text)", textDecoration: off ? "line-through" : "none" }}>{m.native ? modelLabel(m.id) : formatNamespacedModelId(m.namespaced, t)}</code>
                     {m.custom && (
                       <span className="models-chip muted mono text-caption">
                         {t("models.customBadge")}
                       </span>
                     )}
                     {m.contextCapped && <span className="models-chip muted mono text-caption">{t("models.contextCappedValue", { value: fmtK(m.contextCap ?? contextCapValue) })}</span>}
                   </div>
                   {hoveredModel?.namespaced === m.namespaced && (() => {
                     const r = hoveredModel.rect;
                     const tipTop = r.bottom + 4;
                     const flipUp = tipTop + 360 > window.innerHeight;
                     return (
                       <div
                         className={`model-tip${m.custom ? " has-actions" : ""}${flipUp ? " flip-up" : ""}`}
                         role="tooltip"
                         style={{
                           position: "fixed",
                           left: r.left + 24,
                           ...(flipUp
                             ? { bottom: window.innerHeight - r.top + 4 }
                             : { top: tipTop }),
                         }}
                         onMouseEnter={keepRowTipOpen}
                         onMouseLeave={onRowLeave}
                       >
                          <div className="model-tip-id">{m.native ? m.id : m.namespaced}</div>
                         {m.displayName && <div className="model-tip-display">{m.displayName}</div>}
                         {m.custom && (
                           <span className="models-chip models-chip--tip muted mono text-caption">
                             {t("models.customBadge")}
                           </span>
                         )}
                         <div className="model-tip-grid">
                           <span className="model-tip-key">{t("models.tipProvider")}</span>
                           <span className="model-tip-val">{formatProviderDisplayName(m.provider, t)}</span>
                           {(m.contextWindow || m.contextCap) && (
                             <>
                               <span className="model-tip-key">{t("models.tipContext")}</span>
                               <span className="model-tip-val">{fmtK(m.contextWindow ?? m.contextCap ?? 0)}</span>
                             </>
                           )}
                           {m.inputModalities && m.inputModalities.length > 0 && (
                             <>
                               <span className="model-tip-key">{t("models.tipModalities")}</span>
                               <span className="model-tip-val">{m.inputModalities.join(", ")}</span>
                             </>
                           )}
                           <span className="model-tip-key">{t("models.tipStatus")}</span>
                           <span className="model-tip-val">{off ? t("models.tipDisabled") : t("models.tipActive")}</span>
                         </div>
                         {m.custom && m.customId && (
                           <div className="model-tip-actions">
                             <button
                               type="button"
                               className="btn btn-ghost btn-sm text-caption"
                               onClick={() => {
                                 setCustomModalMode("edit");
                                 setCustomModalProvider(m.provider);
                                 setCustomModalId(m.customId!);
                                 setCustomFormModelId(m.id);
                                 setCustomFormDisplayName(m.displayName ?? "");
                                 setCustomFormContextWindow(m.contextWindow ? String(m.contextWindow) : "");
                                 setCustomFormShowCustomCtx(false);
                                 setCustomFormModalities(m.inputModalities ?? ["text"]);
                                 setCustomError("");
                                 setCustomModalOpen(true);
                                 setHoveredModel(null);
                               }}
                             >{t("models.customEdit")}</button>
                             <button
                               type="button"
                               className="btn btn-ghost btn-sm text-caption"
                               style={{ color: "var(--red)" }}
                               onClick={() => {
                                 if (window.confirm(t("models.customDeleteConfirm", { name: m.displayName ?? m.id }))) {
                                   void deleteCustomModel(m.customId!);
                                 }
                                 setHoveredModel(null);
                               }}
                             >{t("models.customDelete")}</button>
                           </div>
                         )}
                       </div>
                     );
                   })()}
                 </div>
               );
             })}
             {remaining > 0 && (
               <button
                 type="button"
                 onClick={() => setLimit(prev => ({ ...prev, [provider]: shown + PAGE }))}
                 className="btn btn-ghost btn-sm models-show-more"
               >{t("models.showMore", { n: remaining })}</button>
             )}
           </div>
         )}
       </div>
     );
  };

  const providerScopedGroups = selectedProvider
    ? groups.filter(group => group.provider === selectedProvider)
    : groups;
  const normalizedCatalogQuery = catalogQuery.trim().toLowerCase();
  const visibleGroups = normalizedCatalogQuery
    ? providerScopedGroups.filter(group => (
      group.provider.toLowerCase().includes(normalizedCatalogQuery)
      || group.rows.some(model => (
        model.id.toLowerCase().includes(normalizedCatalogQuery)
        || model.namespaced.toLowerCase().includes(normalizedCatalogQuery)
        || model.displayName?.toLowerCase().includes(normalizedCatalogQuery)
      ))
    ))
    : providerScopedGroups;

  const contextStateLabel = contextPolicy.state === "uncapped"
    ? t("models.contextStateUncapped")
    : contextPolicy.state === "limited"
      ? t("models.contextStateLimited", { value: fmtK(contextCapValue) })
      : t("models.contextStateMixed");
  const contextStateDescription = contextPolicy.state === "uncapped"
    ? t("models.contextDescUncapped")
    : contextPolicy.state === "limited"
      ? t("models.contextDescLimited", { value: fmtK(contextCapValue) })
      : t("models.contextDescMixed", {
        capped: contextPolicy.capped,
        total: contextPolicy.total,
      });
  const contextDraftUnchanged = contextDraftMode === "full"
    ? contextPolicy.state === "uncapped"
    : contextPolicy.state === "limited" && contextCapDraft === contextCapValue;

  const controlsBlock = (
    <section className="models-behavior" aria-labelledby="models-current-behavior">
      <h3 id="models-current-behavior" className="models-section-title">{t("models.currentBehavior")}</h3>
      {v2LoadError && <Notice tone="err">{v2LoadError}</Notice>}
      <div className={`models-behavior-panel${v2 ? "" : " models-behavior-panel--single"}`}>
        {v2 && (
          <div className="models-behavior-item">
            <div className="models-behavior-item-head">
              <span className="models-behavior-title"><IconBot aria-hidden="true" />{t("models.collaborationTitle")}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-expanded={behaviorEditor === "collaboration"}
                aria-controls="models-collaboration-editor"
                onClick={() => setBehaviorEditor(current => current === "collaboration" ? null : "collaboration")}
              >
                {t("models.change")}
              </button>
            </div>
            <div className="models-behavior-status-row">
              <span className="models-behavior-pill">{t(`models.modeLabel_${v2.multiAgentMode}` as TKey)}</span>
              <span className="models-behavior-positive"><IconCheck aria-hidden="true" />{t(`models.modeStatus_${v2.multiAgentMode}` as TKey)}</span>
            </div>
            <p>{t(`models.modeDesc_${v2.multiAgentMode}` as TKey)}</p>
          </div>
        )}
        <div className="models-behavior-item">
          <div className="models-behavior-item-head">
            <span className="models-behavior-title"><IconHardDrive aria-hidden="true" />{t("models.contextTitle")}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-expanded={behaviorEditor === "context"}
              aria-controls="models-context-editor"
              onClick={toggleContextEditor}
            >
              {t("models.change")}
            </button>
          </div>
          <div className="models-behavior-status-row">
            <span className="models-behavior-pill">{contextStateLabel}</span>
            <span className={`models-behavior-positive${contextPolicy.state === "mixed" ? " models-behavior-positive--mixed" : ""}`}>
              {contextPolicy.state === "mixed" ? <IconInfo aria-hidden="true" /> : <IconCheck aria-hidden="true" />}
              {contextStateDescription}
            </span>
          </div>
        </div>
      </div>

      {behaviorEditor === "collaboration" && v2 && (
        <div id="models-collaboration-editor" className="models-behavior-editor">
          <div className="models-behavior-editor-head">
            <div>
              <strong>{t("models.collaborationTitle")}</strong>
              <span className="models-editor-kicker">{t("models.newSessionsOnly")}</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBehaviorEditor(null)}>{t("common.close")}</button>
          </div>
          <div className="models-mode-options" role="radiogroup" aria-label={t("models.collaborationTitle")}>
            {(["v1", "default", "v2"] as const).map(mode => (
              <label
                key={mode}
                className={`models-mode-option${v2.multiAgentMode === mode ? " models-mode-option--selected" : ""}`}
              >
                <input
                  className="sr-only models-option-radio"
                  type="radio"
                  name="models-collaboration-mode"
                  value={mode}
                  checked={v2.multiAgentMode === mode}
                  disabled={v2Busy}
                  onChange={() => void setMultiAgentMode(mode)}
                />
                <span className="models-mode-option-title">{t(`models.modeLabel_${mode}` as TKey)}</span>
                <span>{t(`models.modeOptionDesc_${mode}` as TKey)}</span>
              </label>
            ))}
          </div>
          {v2.enabled && (
            <div className="models-thread-row">
              <span className="muted text-control">{t("models.v2ThreadsLabel")}</span>
              <Select
                value={showThreadsCustom
                  ? CUSTOM_OPTION
                  : (v2.maxConcurrentThreadsPerSession !== null
                    ? (THREAD_OPTION_SET.has(v2.maxConcurrentThreadsPerSession) ? String(v2.maxConcurrentThreadsPerSession) : CUSTOM_OPTION)
                    : "")}
                options={[
                  ...(v2.maxConcurrentThreadsPerSession === null
                    ? [{ value: "", label: t("models.v2ThreadsDefault") }] : []),
                  ...(v2.maxConcurrentThreadsPerSession !== null
                    && !THREAD_OPTION_SET.has(v2.maxConcurrentThreadsPerSession) && !showThreadsCustom
                    ? [{ value: CUSTOM_OPTION, label: String(v2.maxConcurrentThreadsPerSession) }] : []),
                  ...THREAD_OPTIONS.map(value => ({ value: String(value), label: String(value) })),
                  { value: CUSTOM_OPTION, label: t("models.custom") },
                ]}
                onChange={onSelectThreads}
                disabled={v2Busy}
                label={t("models.v2ThreadsLabel")}
              />
              {showThreadsCustom && (
                <>
                  <input
                    className="input models-thread-input"
                    inputMode="numeric"
                    value={threadsCustom}
                    onChange={event => setThreadsCustom(event.target.value)}
                    onKeyDown={event => { if (event.key === "Enter") void putV2Threads(Number(threadsCustom.replace(/[_,\s]/g, ""))); }}
                    disabled={v2Busy}
                    aria-label={t("models.v2ThreadsLabel")}
                  />
                  <button type="button" className="btn btn-sm" disabled={v2Busy} onClick={() => void putV2Threads(Number(threadsCustom.replace(/[_,\s]/g, "")))}>
                    {t("models.v2ThreadsApply")}
                  </button>
                </>
              )}
              <button type="button" className="btn btn-ghost btn-sm models-info-button" onClick={() => setV2HelpOpen(true)} aria-label={t("models.v2DocsLink")} aria-haspopup="dialog">
                <IconInfo aria-hidden="true" />
              </button>
            </div>
          )}
          {v2.enabled && v2.agentsMaxThreadsConflict && <span className="models-editor-error">{t("models.v2Conflict")}</span>}
          {v2Note && <span className="muted text-label">{v2Note}</span>}
        </div>
      )}

      {behaviorEditor === "context" && (
        <div id="models-context-editor" className="models-behavior-editor">
          <div className="models-behavior-editor-head">
            <div>
              <strong>{t("models.contextPolicyTitle")}</strong>
              <span className="models-editor-kicker">{t("models.contextPolicyScope")}</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBehaviorEditor(null)}>{t("common.close")}</button>
          </div>
          <div className="models-context-options" role="radiogroup" aria-label={t("models.contextPolicyTitle")}>
            <div className={`models-context-option${contextDraftMode === "full" ? " models-context-option--selected" : ""}`}>
              <label className="models-context-option-copy">
                <input
                  className="sr-only models-option-radio"
                  type="radio"
                  name="models-context-policy"
                  value="full"
                  checked={contextDraftMode === "full"}
                  disabled={busy}
                  onChange={() => setContextDraftMode("full")}
                />
                <strong>{t("models.contextUseFull")}</strong>
                <span>{t("models.contextUseFullHint")}</span>
              </label>
            </div>
            <div className={`models-context-option models-context-option--limit${contextDraftMode === "limited" ? " models-context-option--selected" : ""}`}>
              <label className="models-context-option-copy">
                <input
                  className="sr-only models-option-radio"
                  type="radio"
                  name="models-context-policy"
                  value="limited"
                  checked={contextDraftMode === "limited"}
                  disabled={busy}
                  onChange={() => setContextDraftMode("limited")}
                />
                <strong>{t("models.contextSetLimit")}</strong>
                <span>{t("models.contextSetLimitHint")}</span>
              </label>
              <div className="models-context-limit-controls">
                <Select
                  value={showCustom ? CUSTOM_OPTION : (CAP_OPTION_SET.has(contextCapDraft) ? String(contextCapDraft) : CUSTOM_OPTION)}
                  options={[
                    ...(!CAP_OPTION_SET.has(contextCapDraft) && !showCustom
                      ? [{ value: String(contextCapDraft), label: fmtK(contextCapDraft) }] : []),
                    ...CAP_OPTIONS.map(value => ({ value: String(value), label: fmtK(value) })),
                    { value: CUSTOM_OPTION, label: t("models.custom") },
                  ]}
                  onChange={onSelectCap}
                  disabled={busy || contextDraftMode !== "limited"}
                  label={t("models.contextCapLabel")}
                />
                {showCustom && (
                  <>
                    <input
                      className="input models-context-limit-input"
                      inputMode="numeric"
                      placeholder={t("models.customPlaceholder")}
                      value={customCap}
                      onChange={event => setCustomCap(event.target.value)}
                      onKeyDown={event => { if (event.key === "Enter") applyCustomCap(); }}
                      disabled={busy}
                      aria-label={t("models.customPlaceholder")}
                    />
                    <button type="button" onClick={applyCustomCap} disabled={busy} className="btn btn-ghost btn-sm">{t("models.customApply")}</button>
                  </>
                )}
              </div>
            </div>
          </div>
          {contextPolicy.state === "mixed" && (
            <p className="models-context-mixed-note">{t("models.contextMixedHint", { capped: contextPolicy.capped, total: contextPolicy.total })}</p>
          )}
          <div className="models-context-apply-row">
            <span className="muted text-label">
              {contextDraftMode === "limited"
                ? t("models.contextApplyLimitHint", { value: fmtK(contextCapDraft) })
                : t("models.contextApplyFullHint")}
            </span>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || routedProviderNames.length === 0 || contextDraftUnchanged} onClick={applyContextPolicy}>
              {t("models.contextApply")}
            </button>
          </div>
          {routedProviderNames.length > 0 && (
            <div className="models-context-overrides">
              <div className="models-context-overrides-head">
                <strong>{t("models.contextOverrides")}</strong>
                <span>{t("models.contextOverridesHint")}</span>
              </div>
              {routedProviderNames.map(provider => {
                const providerCap = contextCaps[provider];
                const capOn = isPositiveContextCap(providerCap);
                return (
                  <div key={provider} className="models-context-override-row">
                    <div>
                      <span className="models-context-override-name">{provider}</span>
                      <span className={`models-context-policy${capOn ? " models-context-policy--capped" : " models-context-policy--full"}`}>
                        {capOn ? <IconInfo aria-hidden="true" /> : <IconCheck aria-hidden="true" />}
                        {capOn
                          ? t("models.contextProviderCapped", { value: fmtK(providerCap) })
                          : t("models.contextProviderFull")}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => void toggleProviderCap(provider)}
                      aria-label={capOn
                        ? t("models.contextProviderUseFullAria", { provider })
                        : t("models.contextProviderLimitAria", { provider, value: fmtK(contextCapValue) })}
                    >
                      {capOn
                        ? t("models.contextProviderUseFull")
                        : t("models.contextProviderLimit", { value: fmtK(contextCapValue) })}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );

  const combosBlock = (
    <>
      {combos === null && !combosError && (
        <div className="card models-combos-card" aria-busy="true">
          <div className="row models-combos-empty-head">
            <div className="row models-field-row" style={{ minWidth: 0 }}>
              <IconShuffle width={14} height={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              <strong>{t("nav.combos")}</strong>
              <span className="muted text-label">{t("common.loading")}</span>
            </div>
          </div>
        </div>
      )}
      {combos === null && combosError && (
        <div className="models-inline-error" role="alert">
          <span>{t("models.combosLoadFailed")}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => combosResource.refresh()}>{t("common.retry")}</button>
        </div>
      )}
      {combos !== null && combos.length === 0 && (
        <div className="card models-combos-card">
          <div className="row models-combos-empty-head">
            <div className="row models-field-row" style={{ minWidth: 0 }}>
              <IconShuffle width={14} height={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              <strong>{t("nav.combos")}</strong>
              <span className="muted text-label">{t("models.combosEmpty")}</span>
            </div>
            <a className="btn btn-sm" href="#combos" style={{ flexShrink: 0 }}>{t("models.combosSetup")}</a>
          </div>
        </div>
      )}
      {combos !== null && combos.length > 0 && combosError && (
        <div className="models-inline-error" role="alert">
          <span>{t("models.combosLoadFailed")}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => combosResource.refresh()}>{t("common.retry")}</button>
        </div>
      )}
      {combos !== null && combos.length > 0 && combosOpen && (
        <div className="card models-combos-card">
          <div className="row group-head models-field-row open">
            <div className="row models-field-row" style={{ flex: 1, minWidth: 0 }}>
              <IconShuffle width={14} height={14} aria-hidden="true" style={{ flexShrink: 0 }} />
              <strong>{t("nav.combos")}</strong>
              <span className="muted mono text-label">{t("models.combosActive", { count: combos.length })}</span>
            </div>
            <button type="button" className="btn btn-sm btn-ghost" onClick={toggleCombosOpen}>{t("common.close")}</button>
            <a className="btn btn-sm btn-ghost" href="#combos">{t("models.combosSetup")}</a>
          </div>
          <div>
            {combos.map(combo => (
              <div key={combo.id} className="row models-combo-row">
                <span className="mono leading-ui">{combo.model}</span>
                <span className="muted text-label">{combo.strategy} · {combo.targets.length}</span>
              </div>
            ))}
            <a className="row muted models-combos-add" href="#combos">+ {t("models.combosAdd")}</a>
          </div>
        </div>
      )}
    </>
  );

  const catalogToolbar = (
    <div className="models-catalog-toolbar">
      <label className="models-catalog-search">
        <IconSearch aria-hidden="true" />
        <input
          type="search"
          value={catalogQuery}
          onChange={event => setCatalogQuery(event.target.value)}
          placeholder={t("models.catalogSearch")}
          aria-label={t("models.catalogSearch")}
        />
      </label>
      <div className="row models-catalog-actions">
        <button type="button" className="btn btn-ghost btn-sm text-caption" onClick={() => setAllCollapsed(true)} disabled={busy}>
          <IconChevron width={12} height={12} aria-hidden="true" /> {t("models.collapseAll")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm text-caption" onClick={() => setAllCollapsed(false)} disabled={busy}>
          <IconChevron width={12} height={12} aria-hidden="true" style={{ transform: "rotate(90deg)" }} /> {t("models.expandAll")}
        </button>
        {combos !== null && combos.length > 0 ? (
          <button type="button" className="btn btn-ghost btn-sm text-caption" onClick={toggleCombosOpen} aria-expanded={combosOpen}>
            <IconShuffle width={13} height={13} aria-hidden="true" /> {t("nav.combos")} <span className="mono">{combos.length}</span>
          </button>
        ) : (
          <a className="btn btn-ghost btn-sm text-caption" href="#combos">
            <IconShuffle width={13} height={13} aria-hidden="true" /> {t("nav.combos")}
          </a>
        )}
      </div>
    </div>
  );

  const advancedBlock = (
    <div className="models-advanced">
      <div className="models-advanced-head">
        <button
          type="button"
          className="models-advanced-toggle"
          aria-expanded={advancedOpen}
          aria-describedby="models-advanced-description"
          onClick={() => setAdvancedOpen(open => !open)}
        >
          <IconChevron aria-hidden="true" style={{ transform: advancedOpen ? "rotate(90deg)" : "none" }} />
          <strong>{t("models.advanced")}</strong>
          <span>{t("models.advancedHint")}</span>
        </button>
        <span id="models-advanced-description" className="sr-only">
          {t("models.shadowCallInterceptHint", { models: shadowSourceModelLabel(shadowCall?.sourceModels) })}
        </span>
        <span
          className="models-advanced-info"
          title={t("models.shadowCallInterceptHint", { models: shadowSourceModelLabel(shadowCall?.sourceModels) })}
          aria-hidden="true"
        ><IconInfo /></span>
      </div>
      {advancedOpen && (
        <div className="models-advanced-body" aria-busy={!shadowCall || undefined}>
          <div className="models-shadow-row row text-control">
            <span className="models-shadow-label">{t("models.shadowCallIntercept")}</span>
            <code className="text-caption models-shadow-warning">{t("models.shadowCallOriginal", { models: shadowSourceModelBadge(shadowCall?.sourceModels) })}</code>
            <Switch on={shadowCall?.enabled ?? false} onClick={() => void saveShadowCall({ enabled: !shadowCall?.enabled })} disabled={!shadowCall || shadowCallSaving} label={t("models.shadowCallIntercept")} />
            <div className="models-shadow-model-slot">
              <Select value={shadowCall?.model ?? ""} options={shadowCallOptions} onChange={value => { setShadowCall(current => current ? { ...current, model: value } : current); void saveShadowCall({ model: value }); }} disabled={!shadowCall || shadowCallSaving || !shadowCall.enabled} label={t("models.shadowCallIntercept")} />
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const emptyStateBlock = (
    <>
      {groups.length === 0 && (
        <EmptyState icon={<IconBoxes />} title={t("models.noRouted")}>
          {t("models.noRoutedHint")}
        </EmptyState>
      )}
    </>
  );

  const modalsBlock = (
    <>
      {v2HelpOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("models.v2Label")} onClick={() => setV2HelpOpen(false)} onKeyDown={e => { if (e.key === "Escape") setV2HelpOpen(false); }}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{t("models.v2Label")}</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setV2HelpOpen(false)} aria-label={t("common.close")}>&times;</button>
            </div>
            <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
              {t("models.v2Help")}
            </div>
            <div className="models-help-link">
              <a className="text-control" href="https://github.com/pavelhov/CodexCommander/blob/main/docs-site/src/content/docs/guides/sub-agent-surface.md" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {t("models.v2DocsLink")}
              </a>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => setV2HelpOpen(false)}>{t("common.ok")}</button>
            </div>
          </div>
        </div>
      )}

      {customModalOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("models.customAdd")}
          onClick={() => { if (!customSaving) setCustomModalOpen(false); }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !customSaving) setCustomModalOpen(false);
          }}
        >
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                {customModalMode === "add"
                  ? t("models.customAddTitle", { provider: formatProviderDisplayName(customModalProvider, t) })
                  : t("models.customEditTitle", { provider: formatProviderDisplayName(customModalProvider, t) })}
              </h3>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCustomModalOpen(false)}
                disabled={customSaving}
                aria-label={t("common.close")}
              >&times;</button>
            </div>

            {customError && <Notice tone="err">{customError}</Notice>}

            <div className="models-field-stack">
              <label className="text-label models-field">
                {t("models.customFieldModelId")}
                <input
                  className="input"
                  value={customFormModelId}
                  onChange={e => setCustomFormModelId(e.target.value)}
                  disabled={customSaving}
                  placeholder={t("models.customFieldModelIdPlaceholder")}
                  autoFocus
                />
              </label>

              <label className="text-label models-field">
                {t("models.customFieldDisplayName")}
                <input
                  className="input"
                  value={customFormDisplayName}
                  onChange={e => setCustomFormDisplayName(e.target.value)}
                  disabled={customSaving}
                  placeholder={t("models.customFieldDisplayNamePlaceholder")}
                />
              </label>

              <label className="text-label models-field">
                {t("models.customFieldContext")}
                <div className="row models-field-row">
                  <Select
                    value={customFormShowCustomCtx ? CUSTOM_OPTION : customFormContextWindow}
                    options={[
                      { value: "", label: "—" },
                      { value: "100000", label: "100k" },
                      { value: "128000", label: "128k" },
                      { value: "200000", label: "200k" },
                      { value: "256000", label: "256k" },
                      { value: "352000", label: "352k" },
                      { value: "500000", label: "500k" },
                      { value: "1000000", label: "1M" },
                      { value: CUSTOM_OPTION, label: t("models.custom") },
                    ]}
                    onChange={v => {
                      if (v === CUSTOM_OPTION) {
                        setCustomFormShowCustomCtx(true);
                        return;
                      }
                      setCustomFormShowCustomCtx(false);
                      setCustomFormContextWindow(v);
                    }}
                    disabled={customSaving}
                    label={t("models.customFieldContext")}
                  />
                  {customFormShowCustomCtx && (
                    <input
                      className="input"
                      style={{ width: 120 }}
                      inputMode="numeric"
                      value={customFormContextWindow}
                      onChange={e => setCustomFormContextWindow(e.target.value)}
                      disabled={customSaving}
                      placeholder={t("models.customPlaceholder")}
                      aria-label={t("models.customFieldContext")}
                    />
                  )}
                </div>
              </label>

              <div className="text-label models-field">
                {t("models.customFieldModalities")}
                <div className="row models-field-row">
                  {(["text", "image", "audio"] as const).map(mod => (
                    <label key={mod} className="row models-modality-option">
                      <input
                        type="checkbox"
                        checked={customFormModalities.includes(mod)}
                        onChange={e => {
                          setCustomFormModalities(prev => (
                            e.target.checked ? [...prev, mod] : prev.filter(m => m !== mod)
                          ));
                        }}
                        disabled={customSaving}
                      />
                      <span className="text-control">{mod}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCustomModalOpen(false)} disabled={customSaving}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={customSaving || !customFormModelId.trim()}
                onClick={() => {
                  const modelId = customFormModelId.trim();
                  const displayName = customFormDisplayName.trim();
                  const ctxVal = customFormContextWindow ? Number(customFormContextWindow.replace(/[_,\s]/g, "")) : undefined;
                  const contextWindow = ctxVal && ctxVal > 0 ? Math.floor(ctxVal) : undefined;
                  if (customModalMode === "add") {
                    void addCustomModel(
                      customModalProvider,
                      modelId,
                      displayName || undefined,
                      contextWindow,
                      customFormModalities.length > 0 ? customFormModalities : undefined,
                    );
                  } else {
                    void updateCustomModel(customModalId, {
                      modelId,
                      displayName,
                      contextWindow: contextWindow ?? null,
                      inputModalities: customFormModalities,
                    });
                  }
                }}
              >
                {customSaving
                  ? t("models.customSaving")
                  : (customModalMode === "add" ? t("models.customAddBtn") : t("models.customEditBtn"))}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="models-workspace-shell">
      <div className="page-head">
        <h2>{t("nav.models")}</h2>
        <div className="row">
          <span className="muted mono text-label">{t("models.active", { active: effectiveVisibleCount, total: models.length })}</span>
        </div>
      </div>
      <p className="page-sub">{t("models.subtitle")}</p>
      {status && (
        <div className={`action-toast notice ${ok ? "notice-ok" : "notice-err"}`} role="status" aria-live="polite">
          {ok ? <IconCheck /> : <IconAlert />}
          <span>{status}</span>
        </div>
      )}
      {/* Keep the last-good catalog interactive but make a failed revalidation explicit. */}
      {catalogState.showError && <Notice tone="err">{t("models.loadFail")}</Notice>}
      <div className="models-workspace-root" aria-busy={catalogState.refreshing || undefined}>
        <aside className="models-workspace-rail" aria-label={t("nav.models")}>
          <div className="models-workspace-rail-header">
            <span className="models-workspace-rail-title">{t("models.workspace.providers")}</span>
            <span className="models-workspace-rail-count">{groups.length}</span>
          </div>
          <div className="models-workspace-rail-list">
            <button
              type="button"
              className={`models-workspace-rail-row${selectedProvider === null ? " models-workspace-rail-row--selected" : ""}`}
              onClick={() => setSelectedProvider(null)}
              aria-current={selectedProvider === null ? "true" : undefined}
            >
              <span className="models-workspace-rail-name" title={t("models.workspace.allProviders")}>{t("models.workspace.allProviders")}</span>
              <span className="models-workspace-rail-meta">{t("models.active", { active: effectiveVisibleCount, total: models.length })}</span>
            </button>
            {groups.map(group => {
              const { provider, rows } = group;
              // Same final-visibility rule as the provider card, so the rail never disagrees with it.
              const activeCount = rows.filter(m => modelVisible(
                selectedModelMap,
                provider,
                m.id,
                m.native === true,
                disabled.has(m.namespaced),
              )).length;
              return (
                <button
                  key={provider}
                  type="button"
                  className={`models-workspace-rail-row${selectedProvider === provider ? " models-workspace-rail-row--selected" : ""}`}
                  onClick={() => setSelectedProvider(provider)}
                  aria-current={selectedProvider === provider ? "true" : undefined}
                >
                  <span className="models-workspace-rail-name" title={formatProviderDisplayName(provider, t)}>{formatProviderDisplayName(provider, t)}</span>
                  <span className="models-workspace-rail-meta">{t("models.active", { active: activeCount, total: rows.length })}</span>
                </button>
              );
            })}
          </div>
        </aside>
        <section className="models-workspace-main" aria-label={t("models.workspace.mainAria")}>
          {controlsBlock}
          {catalogToolbar}
          {combosBlock}
          <div className="models-provider-columns" aria-hidden="true">
            <span>{t("models.tableProvider")}</span>
            <span>{t("models.tableVisible")}</span>
            <span>{t("models.tableContext")}</span>
            <span>{t("models.tableActions")}</span>
          </div>
          <div className="models-provider-list">
            {
              // eslint-disable-next-line react-hooks/refs -- The hover ref is only read by row event handlers nested in this renderer.
              visibleGroups.map(group => renderGroup(group))
            }
          </div>
          {normalizedCatalogQuery && visibleGroups.length === 0 && (
            <EmptyState icon={<IconSearch />} title={t("models.searchEmptyTitle")}>
              {t("models.searchEmptyHint")}
            </EmptyState>
          )}
          {groups.length === 0 && emptyStateBlock}
          {models.some(model => model.custom) && (
            <div className="row muted text-label models-custom-summary">
              <span className="models-chip mono text-caption">{t("models.customSummary", { count: models.filter(model => model.custom).length })}</span>
            </div>
          )}
          <div className="row muted text-label leading-body models-order-hint">
            <IconInfo width={15} height={15} aria-hidden="true" />
            <span className="models-order-hint-copy">
              <span>{t("models.orderHint")}</span>
              <span>{t("models.catalogBehaviorHint")}</span>
            </span>
          </div>
          {advancedBlock}
        </section>
      </div>
      {modalsBlock}
    </div>
  );

}

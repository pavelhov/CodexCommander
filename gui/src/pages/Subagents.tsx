import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import SubagentsWorkspace, {
  FEATURED_MAX,
  type AgentModelRow,
  type CatalogState,
} from "../components/subagents-workspace/SubagentsWorkspace";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { useSubagentDelegation } from "./use-subagent-delegation";
import { useSubagentRunPolicy } from "./use-subagent-run-policy";
import { useCodexDelegationSetup } from "./use-codex-delegation-setup";
import { deriveRosterReachability, type RosterProjections } from "./subagent-roster-reachability";
import SubagentRunPolicySection from "../components/subagents-workspace/SubagentRunPolicySection";
import { setClientResourceData } from "../client-resource";
import {
  isConfirmedGuiLaunch,
  subscribeGuiLaunchCapability,
  whenGuiLaunchCapabilitySettles,
} from "../api";

type SubagentsSnapshot = {
  available: string[];
  chosen: string[];
  advertised: string[];
  excluded: RosterExclusion[];
  models: AgentModelRow[];
  catalogState?: CatalogState;
  activation?: CatalogActivation;
  metadataLimited?: boolean;
};

type RosterExclusion = {
  configured: string;
  catalogModel?: string;
  reason: string;
};

type SaveResponse = {
  superseded?: boolean;
  applied?: string[];
  advertised?: string[];
  excluded?: RosterExclusion[];
  catalogRefresh?: {
    ok?: boolean;
    status?: "committed" | "skipped" | "failed";
    reason?: string;
    notices?: string[];
  };
  activation?: unknown;
};

type CatalogActivation = {
  desiredRevision: string | null;
  reloadRequired: boolean;
  applyAllowed: boolean;
  workerState: string | null;
  catalogStatus: string | null;
  applyReason: string | null;
  routingStatus: "current" | "not_injected" | "external" | "unknown" | "not_required";
  routingKind: "native" | "codexcommander-local" | "custom-local" | "custom-remote" | "unknown";
  protocol: string | null;
  projections?: RosterProjections;
  desiredChosen?: string[];
  advertised: string[];
  excluded: RosterExclusion[];
};

type ApplyDialogState = "idle" | "active" | "unknown";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const routingStatuses = ["current", "not_injected", "external", "unknown", "not_required"] as const;
const routingKinds = ["native", "codexcommander-local", "custom-local", "custom-remote", "unknown"] as const;
const catalogStatuses = ["current", "pending", "degraded", "unknown"] as const;
const workerStates = ["current", "reload_required", "not_running", "unknown"] as const;
const applyReasons = [
  "reload-required",
  "routing-not-injected",
  "external-routing",
  "routing-unknown",
  "integration-disabled",
  "already-current",
  "no-workers",
  "worker-state-unknown",
  "catalog-not-ready",
  "confirmed-launch-required",
] as const;

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : null;
}

function routingPairIsCoherent(
  status: (typeof routingStatuses)[number],
  kind: (typeof routingKinds)[number],
): boolean {
  if (status === "current") return kind === "codexcommander-local";
  if (status === "not_injected") return kind === "native";
  if (status === "external") return kind === "custom-local" || kind === "custom-remote";
  if (status === "unknown") return kind === "unknown";
  return true;
}

/** Parse display fields defensively while keeping Apply authorization strict. */
function parseActivation(value: unknown): CatalogActivation | undefined {
  const activation = asRecord(value);
  if (!activation) return undefined;
  const desired = asRecord(activation.desired);
  const workers = asRecord(activation.workers);
  const apply = asRecord(activation.apply);
  const catalog = asRecord(activation.catalog);
  const routing = asRecord(activation.routing);
  const revision = typeof activation.desiredRevision === "string"
    ? activation.desiredRevision
    : typeof activation.revision === "string"
      ? activation.revision
      : typeof desired?.revision === "string" ? desired.revision : null;
  const desiredRevision = revision !== null && revision.length >= 4 && revision.length <= 128
    ? revision
    : null;
  const rawWorkerState = typeof workers?.status === "string"
    ? workers.status
    : typeof workers?.state === "string"
      ? workers.state
    : typeof activation.workerState === "string"
      ? activation.workerState
      : typeof activation.state === "string" ? activation.state : null;
  const workerState = rawWorkerState === "fresh"
    ? "current"
    : rawWorkerState === "stale"
      ? "reload_required"
      : enumValue(rawWorkerState, workerStates);
  const catalogStatus = enumValue(catalog?.status, catalogStatuses);
  const parsedRoutingStatus = enumValue(routing?.status, routingStatuses);
  const parsedRoutingKind = enumValue(routing?.kind, routingKinds);
  const routingPairValid = parsedRoutingStatus !== null
    && parsedRoutingKind !== null
    && routingPairIsCoherent(parsedRoutingStatus, parsedRoutingKind);
  const routingStatus = routingPairValid ? parsedRoutingStatus : "unknown";
  const routingKind = routingPairValid ? parsedRoutingKind : "unknown";
  const applyReason = enumValue(apply?.reason, applyReasons);
  const reloadRequired = apply?.required === true
    || activation.reloadRequired === true
    || workerState === "reload_required"
    || routingStatus === "not_injected";
  const routingCanApply = routingStatus === "current" || routingStatus === "not_injected";
  const reasonCanApply = applyReason === "reload-required"
    || applyReason === "routing-not-injected"
    || applyReason === "catalog-not-ready";
  // Apply can interrupt a background worker and rewrite Codex routing. Require
  // the complete current authorization shape; missing, malformed, or
  // contradictory fields always disable the client action.
  const applyAllowed = apply?.allowed === true
    && apply?.required === true
    && desiredRevision !== null
    && routingCanApply
    && workerState !== null
    && workerState !== "unknown"
    && reasonCanApply;
  const advertised = Array.isArray(catalog?.advertised)
    ? catalog.advertised.filter((model): model is string => typeof model === "string")
    : [];
  const excluded = Array.isArray(catalog?.excluded)
    ? catalog.excluded.flatMap(value => {
        const item = asRecord(value);
        return typeof item?.configured === "string" && typeof item.reason === "string"
          ? [{
              configured: item.configured,
              reason: item.reason,
              ...(typeof item.catalogModel === "string" ? { catalogModel: item.catalogModel } : {}),
            }]
          : [];
      })
    : [];
  const desiredChosen = Array.isArray(desired?.chosen)
    ? desired.chosen.filter((model): model is string => typeof model === "string" && model.length > 0)
    : undefined;
  const projectionsValue = catalog?.projections;
  const projections = projectionsValue !== null
    && typeof projectionsValue === "object"
    && !Array.isArray(projectionsValue)
    ? projectionsValue as RosterProjections
    : undefined;
  return {
    desiredRevision,
    reloadRequired,
    applyAllowed,
    workerState,
    catalogStatus,
    applyReason,
    routingStatus,
    routingKind,
    protocol: typeof desired?.protocol === "string" ? desired.protocol : null,
    projections,
    desiredChosen,
    advertised,
    excluded,
  };
}

function applyOutcome(value: unknown): string | null {
  const response = asRecord(value);
  if (!response) return null;
  for (const key of ["outcome", "status", "result"] as const) {
    if (typeof response[key] === "string") return response[key];
  }
  return null;
}

async function readApplyResponse(response: Response, fallback: string): Promise<{ data: unknown; ok: boolean }> {
  if (response.ok) return { data: await readJsonOrThrow<unknown>(response, fallback), ok: true };
  try {
    return { data: await response.json(), ok: false };
  } catch {
    throw new Error(fallback);
  }
}

function seedSubagents(cacheKey: string): SubagentsSnapshot | null {
  return readSessionListCache<SubagentsSnapshot>(cacheKey);
}

export default function Subagents({ apiBase }: { apiBase: string }) {
  const t = useT();
  const cacheKey = `ccx.subagents.v2:${apiBase}`;
  const cached = seedSubagents(cacheKey);
  const [chosen, setChosen] = useState<string[]>(() => cached?.chosen ?? []);
  const [committedChosen, setCommittedChosen] = useState<string[]>(() => cached?.chosen ?? []);
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"ok" | "warn" | "err">("ok");
  const [busy, setBusy] = useState(false);
  const [applyDialog, setApplyDialog] = useState<ApplyDialogState | null>(null);
  const [catalogLive, setCatalogLive] = useState(false);
  const [confirmedGuiLaunch, setConfirmedGuiLaunch] = useState(isConfirmedGuiLaunch);
  /** Sync guard: state-only `busy` can miss clicks before the disabled re-render commits. */
  const saveInFlight = useRef(false);
  const catalogRefreshRequested = useRef(false);
  const applyInFlight = useRef(false);
  /** Last server-persisted roster; the dirty guard for polled revalidations. */
  const committedChosenRef = useRef<string[]>(cached?.chosen ?? []);
  const applyTriggerRef = useRef<HTMLButtonElement>(null);
  const applyCancelRef = useRef<HTMLButtonElement>(null);
  const applyConfirmRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy);
  const delegation = useSubagentDelegation(apiBase);
  const runPolicy = useSubagentRunPolicy(apiBase);
  const delegationSetup = useCodexDelegationSetup(apiBase);

  const loadSubagents = useCallback(async (): Promise<SubagentsSnapshot> => {
    const rosterRequest = fetch(`${apiBase}/api/subagent-models`)
      .then(res => readJsonOrThrow<{
        available?: string[];
        chosen?: string[];
        advertised?: string[];
        excluded?: RosterExclusion[];
        catalogState?: CatalogState;
        activation?: unknown;
      }>(res, t("sub.loadFail")));
    const metadataRequest = fetch(`${apiBase}/api/models`)
      .then(res => readJsonOrThrow<AgentModelRow[]>(res, t("sub.metadataLoadFail")))
      .then(rows => Array.isArray(rows) ? rows : [])
      .catch(() => null);
    const [response, modelRows] = await Promise.all([rosterRequest, metadataRequest]);
    if (!response) throw new Error(t("sub.loadFail"));
    const available = response.available ?? [];
    // Preserve configured exact selectors even when a provider is temporarily
    // unavailable. The roster endpoint is the persistence authority; the live
    // catalog only controls what can be added from the library right now.
    const nextChosen = response.chosen ?? [];
    const next: SubagentsSnapshot = {
      available,
      chosen: nextChosen,
      advertised: response.advertised ?? [],
      excluded: response.excluded ?? [],
      models: (modelRows ?? []).filter(model => !model.disabled),
      catalogState: response.catalogState,
      activation: parseActivation(response.activation),
      metadataLimited: modelRows === null,
    };
    // The 5s surface poll must never clobber unsaved roster edits: adopt the
    // server list only while the visible roster matches the last committed one.
    setChosen(previous => {
      const committed = committedChosenRef.current;
      if (previous.length === committed.length && previous.every((model, index) => model === committed[index])) {
        return nextChosen;
      }
      return previous;
    });
    setCommittedChosen(next.chosen);
    setCatalogLive(true);
    writeSessionListCache(cacheKey, next);
    return next;
  }, [apiBase, cacheKey, t]);

  const resource = useDataSurface<SubagentsSnapshot>(
    cacheKey,
    [apiBase],
    loadSubagents,
    { isEmpty: () => false, initialData: cached ?? undefined, pollMs: 5000 },
  );
  const { state } = resource;
  const load = resource.refresh;
  const snapshot = state.data ?? cached;
  const available = snapshot?.available ?? [];
  const models = snapshot?.models ?? [];
  const hasRoutedModels = models.some(model => model.native !== true && model.namespaced.includes("/"));
  const catalogState = catalogLive ? snapshot?.catalogState : undefined;
  // The sessionStorage seed is a warm-cache convenience, not live process state.
  // Gate activation-derived UI (banners, Apply/force-restart affordances) on the
  // first live fetch completing — mirroring `catalogState` — so a stale seed can
  // never paint an actionable banner as final state before revalidation resolves.
  const activation = catalogLive ? snapshot?.activation : undefined;
  const reloadRequired = activation?.reloadRequired === true;
  const applyAllowed = activation?.applyAllowed === true;
  const integrationDisabled = activation?.routingStatus === "not_required"
    || activation?.applyReason === "integration-disabled";
  const externalRouting = !integrationDisabled && (activation?.routingStatus === "external"
    || activation?.applyReason === "external-routing");
  const unknownRouting = !integrationDisabled && !externalRouting && (activation?.routingStatus === "unknown"
    || activation?.applyReason === "routing-unknown");
  const routingBlocked = integrationDisabled || externalRouting || unknownRouting;
  const routingNotInjected = activation?.routingStatus === "not_injected";
  const catalogReady = activation?.catalogStatus === "current" || activation?.catalogStatus === "degraded";
  const catalogNeedsConvergence = activation?.catalogStatus === "pending" || activation?.catalogStatus === "unknown";
  const manualRestartRequired = catalogReady
    && activation?.routingStatus === "current"
    && activation?.workerState === "reload_required";
  const canApply = applyAllowed && confirmedGuiLaunch;
  const launcherRequired = reloadRequired && !routingBlocked && (
    activation?.applyReason === "confirmed-launch-required" || (applyAllowed && !confirmedGuiLaunch)
  );
  // Reachability is derived from the server-observed roster, never the draft:
  // a draft row absent from the server's projection computation must get no
  // reachability claim (deriveRosterReachability returns an empty map for
  // malformed/absent projections).
  const serverRoster = activation?.desiredChosen ?? committedChosen;
  const rosterReachability = useMemo(
    () => deriveRosterReachability(serverRoster, activation?.projections),
    [serverRoster, activation?.projections],
  );
  const protocol = enumValue(activation?.protocol, ["v1", "default", "v2"] as const);

  useEffect(() => {
    const update = () => setConfirmedGuiLaunch(isConfirmedGuiLaunch());
    const unsubscribe = subscribeGuiLaunchCapability(update);
    void whenGuiLaunchCapabilitySettles().then(update);
    return unsubscribe;
  }, []);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    committedChosenRef.current = committedChosen;
  }, [committedChosen]);

  useEffect(() => {
    if (!applyDialog) return;
    const focused = document.activeElement;
    const previouslyFocused = focused && "focus" in focused
      ? focused as HTMLElement
      : null;
    const fallbackTrigger = applyTriggerRef.current;
    applyCancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busyRef.current) setApplyDialog(null);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = applyCancelRef.current?.closest('[role="alertdialog"]');
      const focusable = dialog
        ? [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        : [];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      else fallbackTrigger?.focus();
    };
  }, [applyDialog]);

  // A warm data-surface cache can skip the loader on a route revisit. Catalog
  // freshness is live process state, so force one bounded revalidation instead
  // of silently dropping the stale/current badge until another mutation.
  useEffect(() => {
    if (!snapshot || catalogLive || catalogRefreshRequested.current) return;
    catalogRefreshRequested.current = true;
    load();
  }, [catalogLive, load, snapshot]);
  const rosterDirty = useMemo(
    () => chosen.length !== committedChosen.length || chosen.some((model, index) => model !== committedChosen[index]),
    [chosen, committedChosen],
  );

  /** Focus-only affordance: scroll to and focus the protocol mode Select. Never changes or saves the draft. */
  const useConcurrentV2 = useCallback(() => {
    const target = document.getElementById("subagent-policy-mode");
    if (!(target instanceof HTMLButtonElement)) return;
    const reduced = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
    target.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    target.focus({ preventScroll: true });
  }, []);

  const toggle = (model: string) => {
    if (busy) return;
    setStatus("");
    setChosen(previous => previous.includes(model)
      ? previous.filter(value => value !== model)
      : previous.length >= FEATURED_MAX ? previous : [...previous, model]);
  };

  const move = (index: number, direction: -1 | 1) => {
    if (busy) return;
    setStatus("");
    setChosen(previous => {
      const next = [...previous];
      const destination = index + direction;
      if (destination < 0 || destination >= next.length) return previous;
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  };

  const reorder = (from: number, to: number) => {
    if (busy) return;
    setStatus("");
    setChosen(previous => {
      if (from === to || from < 0 || to < 0 || from >= previous.length || to >= previous.length) return previous;
      const next = [...previous];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  };

  const save = async () => {
    if (busy || saveInFlight.current || !rosterDirty) return;
    saveInFlight.current = true;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: chosen }),
      });
      const data = await readJsonOrThrow<SaveResponse>(response, t("sub.saveFailed"));
      const applied = data?.applied ?? chosen;
      const advertised = data?.advertised ?? [];
      const excluded = data?.excluded ?? [];
      const parsedActivation = parseActivation(data?.activation);
      const nextActivation = parsedActivation ?? snapshot?.activation;
      const nextSnapshot: SubagentsSnapshot = {
        available,
        chosen: applied,
        advertised: parsedActivation ? parsedActivation.advertised : advertised,
        excluded: parsedActivation ? parsedActivation.excluded : excluded,
        models,
        catalogState: snapshot?.catalogState,
        activation: nextActivation,
        metadataLimited: snapshot?.metadataLimited,
      };
      setChosen(applied);
      setCommittedChosen(applied);
      setClientResourceData(cacheKey, nextSnapshot);
      writeSessionListCache(cacheKey, nextSnapshot);
      const refreshStatus = data?.catalogRefresh?.status;
      const refreshFailed = data?.catalogRefresh?.ok === false
        || (refreshStatus !== undefined && refreshStatus !== "committed");
      const policySkipped = refreshStatus === "skipped" && data?.catalogRefresh?.reason === "refused";
      const saveIntegrationDisabled = policySkipped && (nextActivation?.routingStatus === "not_required"
        || nextActivation?.applyReason === "integration-disabled");
      const saveNeedsApply = policySkipped && (nextActivation?.routingStatus === "not_injected"
        || nextActivation?.applyReason === "routing-not-injected");
      const saveRoutingPreserved = policySkipped && (nextActivation?.routingStatus === "external"
        || nextActivation?.routingStatus === "unknown"
        || nextActivation?.applyReason === "external-routing"
        || nextActivation?.applyReason === "routing-unknown");
      const superseded = data?.superseded === true;
      const saveWarned = superseded
        || saveIntegrationDisabled
        || saveNeedsApply
        || saveRoutingPreserved
        || refreshFailed
        || excluded.length > 0;
      setStatusTone(saveWarned ? "warn" : "ok");
      setStatus(superseded
        ? t("sub.savedSuperseded")
        : saveIntegrationDisabled
          ? t("sub.savedIntegrationDisabled", { n: applied.length })
          : saveNeedsApply
            ? t("sub.savedNeedsApply", { n: applied.length })
            : saveRoutingPreserved
              ? t("sub.savedRoutingPreserved", { n: applied.length })
              : refreshFailed
                ? t("sub.savedRefreshFailed", { n: applied.length })
                : excluded.length > 0
                  ? t("sub.savedExcluded", { n: applied.length, missing: excluded.length })
                  : t("sub.saved", { n: applied.length }));
      load();
    } catch (error) {
      setStatusTone("err");
      setStatus(error instanceof Error && error.message ? error.message : t("sub.networkError"));
    } finally {
      saveInFlight.current = false;
      setBusy(false);
    }
  };

  const prepareApply = async () => {
    if (busy || applyInFlight.current || !activation?.desiredRevision || !canApply) return;
    setStatus("");
    try {
      const response = await fetch(`${apiBase}/api/agent-activity`);
      const activity = await readJsonOrThrow<Record<string, unknown>>(response, t("sub.applyActivityFailed"));
      const activeTurnCount = typeof activity?.activeTurnCount === "number" && activity.activeTurnCount > 0
        ? activity.activeTurnCount
        : 0;
      setApplyDialog(activeTurnCount > 0 ? "active" : "idle");
    } catch {
      // The Apply endpoint remains the final safety fence. Do not hide the
      // action merely because advisory activity data could not be read.
      setApplyDialog("unknown");
    }
  };

  const apply = async () => {
    if (busy || applyInFlight.current || !activation?.desiredRevision || !canApply) return;
    applyInFlight.current = true;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`${apiBase}/api/codex-catalog/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedDesiredRevision: activation.desiredRevision, confirmInterrupt: true }),
      });
      const { data, ok } = await readApplyResponse(response, t("sub.applyFailed"));
      const outcome = applyOutcome(data);
      if (!ok && outcome !== "superseded" && outcome !== "blocked") {
        throw new Error(t("sub.applyFailed"));
      }
      const messageKey = outcome === "applied"
        ? "sub.apply.applied"
        : outcome === "already_current"
          ? "sub.apply.alreadyCurrent"
          : outcome === "no_workers"
            ? "sub.apply.noWorkers"
            : outcome === "partial"
              ? "sub.apply.partial"
              : outcome === "superseded"
                ? "sub.apply.superseded"
                : outcome === "blocked"
                  ? "sub.apply.blocked"
                  : "sub.apply.completed";
      setStatusTone(outcome === "partial" || outcome === "no_workers" || outcome === "blocked" || outcome === "superseded" ? "warn" : "ok");
      setStatus(t(messageKey));
      const responseActivation = parseActivation(asRecord(data)?.activation);
      if (responseActivation && snapshot) {
        const nextSnapshot: SubagentsSnapshot = {
          ...snapshot,
          advertised: responseActivation.advertised,
          excluded: responseActivation.excluded,
          activation: responseActivation,
        };
        setClientResourceData(cacheKey, nextSnapshot);
        writeSessionListCache(cacheKey, nextSnapshot);
      }
      setApplyDialog(null);
      load();
    } catch (error) {
      setStatusTone("err");
      setStatus(error instanceof Error && error.message ? error.message : t("sub.applyFailed"));
    } finally {
      applyInFlight.current = false;
      setBusy(false);
    }
  };

  const saveRunPolicy = async () => {
    const saved = await runPolicy.save();
    if (saved) await load();
    return saved;
  };

  if (state.showSkeleton && !snapshot) {
    return <DataSurfaceSkeleton label={t("sub.loading")} rows={7} />;
  }

  if (state.kind === "failed-cold") {
    const reason = state.error instanceof Error ? state.error.message : t("sub.loadFail");
    return (
      <>
        <Notice tone="err">{reason}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load()}>{t("common.retry")}</button>
      </>
    );
  }

  const catalogLabel = activation
    ? integrationDisabled
      ? t("sub.catalog.integrationDisabled")
      : externalRouting || unknownRouting
        ? t("sub.catalog.applyUnavailable")
        : catalogNeedsConvergence
          ? applyAllowed
            ? t("sub.catalog.applyNeeded")
            : activation.catalogStatus === "unknown"
              ? t("sub.catalog.unknown")
              : t("sub.catalog.pending")
          : reloadRequired
            ? manualRestartRequired
              ? t("sub.catalog.restartChatGPT")
              : applyAllowed
                ? t("sub.catalog.applyNeeded")
                : t("sub.catalog.applyUnavailable")
            : activation.workerState === "current" || activation.workerState === "fresh"
              ? t("sub.catalog.current")
              : activation.workerState === "not_running" && catalogReady
                ? t("sub.catalog.nextSession")
                : activation.workerState === "unknown"
                  ? t("sub.catalog.unknown")
                  : null
    : catalogState?.state === "fresh"
      ? t("sub.catalog.current")
      : catalogState?.state === "stale"
        ? t("sub.catalog.restartNeeded")
        : catalogState?.state === "not_running"
          ? t("sub.catalog.nextSession")
          : catalogState?.state === "unknown"
            ? t("sub.catalog.unknown")
            : null;
  const catalogBadgeState = activation
    ? integrationDisabled
      ? "not_required"
      : externalRouting || unknownRouting
        ? "unknown"
        : catalogNeedsConvergence
          ? activation.catalogStatus === "unknown" ? "unknown" : "stale"
          : reloadRequired
            ? applyAllowed ? "stale" : activation.catalogStatus === "unknown" ? "unknown" : "stale"
            : activation.workerState === "current" ? "fresh" : activation.workerState ?? undefined
    : catalogState?.state;
  const excluded = snapshot?.excluded ?? [];
  const excludedModels = excluded.map(item => item.configured).join(", ");

  return (
    <>
      <div className="page-head subagents-page-head">
        <div>
          <h2>{t("sub.pageTitle")}</h2>
          <p className="subagents-page-subtitle">{t("sub.pageSubtitle")}</p>
        </div>
        {catalogLabel && (
          <span className={`subagents-catalog-badge subagents-catalog-badge--${catalogBadgeState}`}>
            <span aria-hidden="true" />{catalogLabel}
          </span>
        )}
      </div>
      {hasRoutedModels && (
        <Notice tone="warn">{t("sub.desktopPickerLimit")}</Notice>
      )}
      {status && <Notice tone={statusTone}>{status}</Notice>}
      {excluded.length > 0 && (
        <Notice tone="warn">
          {t("sub.roster.excludedNotice", { n: excluded.length, models: excludedModels })}
        </Notice>
      )}
      {externalRouting && <Notice tone="warn">{t("sub.catalog.externalRoutingNotice")}</Notice>}
      {unknownRouting && <Notice tone="warn">{t("sub.catalog.unknownRoutingNotice")}</Notice>}
      {integrationDisabled && (
        <p className="subagents-activation-note">{t("sub.catalog.integrationDisabledNotice")}</p>
      )}
      {manualRestartRequired && (
        <Notice tone="warn">
          <div className="subagents-activation-notice">
            <span>{t("sub.catalog.restartChatGPTNotice")}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => load()}
              disabled={busy}
            >{t("sub.catalog.checkStatusAction")}</button>
          </div>
        </Notice>
      )}
      {manualRestartRequired && launcherRequired && (
        <Notice tone="warn">{t("sub.catalog.launcherRequiredNotice")}</Notice>
      )}
      {manualRestartRequired && canApply && (
        <div className="subagents-force-restart">
          <span>{t("sub.catalog.forceRestartNotice")}</span>
          <button
            ref={applyTriggerRef}
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => { void prepareApply(); }}
            disabled={busy || !activation?.desiredRevision}
          >{t("sub.catalog.forceRestartAction")}</button>
        </div>
      )}
      {reloadRequired && !manualRestartRequired && !routingBlocked && (
        <Notice tone="warn">
          <div className="subagents-activation-notice">
            <span>{t(
              launcherRequired
                ? "sub.catalog.launcherRequiredNotice"
                : applyAllowed
                ? catalogNeedsConvergence
                  ? "sub.catalog.pendingNotice"
                  : routingNotInjected
                    ? "sub.catalog.routingNotInjectedNotice"
                    : "sub.catalog.applyNotice"
                : activation?.catalogStatus !== "current" && activation?.catalogStatus !== "degraded"
                  ? "sub.catalog.pendingNotice"
                  : "sub.catalog.blockedNotice",
            )}</span>
            {canApply && <button
              ref={applyTriggerRef}
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => { void prepareApply(); }}
              disabled={busy || !activation?.desiredRevision}
            >{t("sub.catalog.applyAction")}</button>}
          </div>
        </Notice>
      )}
      {reloadRequired && !manualRestartRequired && !routingBlocked && <p className="subagents-activation-note">{t("sub.catalog.newTaskNote")}</p>}
      {!activation && catalogState?.state === "stale" && (
        <Notice tone="warn">{t("sub.catalog.legacyStaleNotice", { n: catalogState.processes?.length ?? 0, cmd: "ccx sync --restart-codex" })}</Notice>
      )}
      {((!reloadRequired && !routingBlocked && catalogReady && activation?.workerState === "not_running")
        || (!activation && catalogState?.state === "not_running"))
        && <Notice tone="warn">{t("sub.catalog.notRunningNotice")}</Notice>}
      {snapshot?.metadataLimited && <Notice tone="warn">{t("sub.metadataLimited")}</Notice>}
      {state.showError && <Notice tone="err">{t("sub.loadFail")}</Notice>}
      <SubagentsWorkspace
        available={available}
        models={models}
        chosen={chosen}
        busy={busy}
        rosterDirty={rosterDirty}
        protocol={protocol}
        rosterReachability={rosterReachability}
        onUseConcurrentV2={useConcurrentV2}
        onToggle={toggle}
        onMove={move}
        onReorder={reorder}
        onSave={() => { void save(); }}
        delegation={{
          loaded: delegation.loaded,
          model: delegation.model,
          effort: delegation.effort,
          efforts: delegation.efforts,
          available: delegation.available,
          guidanceEnabled: delegation.guidanceEnabled,
          syncCodexDefaults: delegation.syncCodexDefaults,
          saving: delegation.saving,
          onSave: delegation.save,
        }}
        runPolicy={(
          <SubagentRunPolicySection
            policy={{ ...runPolicy, save: saveRunPolicy }}
            delegation={{
              loaded: delegation.loaded,
              saving: delegation.saving,
              error: delegation.error,
              model: delegation.model,
              effort: delegation.effort,
              efforts: delegation.efforts,
              available: delegation.available,
              guidanceEnabled: delegation.guidanceEnabled,
              syncCodexDefaults: delegation.syncCodexDefaults,
              onSave: delegation.save,
              onReload: delegation.reload,
            }}
          />
        )}
        delegationSetup={delegationSetup}
      />
      {applyDialog && (
        <div className="dialog-backdrop" onMouseDown={() => { if (!busy) setApplyDialog(null); }}>
          <div
            className="dialog subagents-apply-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="subagents-apply-title"
            aria-describedby="subagents-apply-description"
            onMouseDown={event => event.stopPropagation()}
          >
            <h3 id="subagents-apply-title">{t("sub.apply.dialogTitle")}</h3>
            <p id="subagents-apply-description">{t(
              applyDialog === "active"
                ? "sub.apply.dialogActive"
                : applyDialog === "unknown"
                  ? "sub.apply.dialogUnknown"
                  : "sub.apply.dialogIdle",
            )}</p>
            <div className="dialog-actions">
              <button ref={applyCancelRef} type="button" className="btn btn-ghost" onClick={() => setApplyDialog(null)} disabled={busy}>{t("common.cancel")}</button>
              <button ref={applyConfirmRef} type="button" className="btn btn-primary" onClick={() => { void apply(); }} disabled={busy}>
                {busy ? t("sub.applying") : t("sub.apply.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

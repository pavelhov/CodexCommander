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
import SubagentRunPolicySection from "../components/subagents-workspace/SubagentRunPolicySection";

type SubagentsSnapshot = {
  available: string[];
  chosen: string[];
  advertised: string[];
  excluded: RosterExclusion[];
  models: AgentModelRow[];
  catalogState?: CatalogState;
  metadataLimited?: boolean;
};

type RosterExclusion = {
  configured: string;
  catalogModel?: string;
  reason: string;
};

type SaveResponse = {
  applied?: string[];
  advertised?: string[];
  excluded?: RosterExclusion[];
  catalogRefresh?: {
    ok?: boolean;
    status?: string;
    notices?: string[];
  };
};

function seedSubagents(cacheKey: string): SubagentsSnapshot | null {
  return readSessionListCache<SubagentsSnapshot>(cacheKey);
}

export default function Subagents({ apiBase }: { apiBase: string }) {
  const t = useT();
  const cacheKey = `ocx.subagents.v2:${apiBase}`;
  const cached = seedSubagents(cacheKey);
  const [chosen, setChosen] = useState<string[]>(() => cached?.chosen ?? []);
  const [committedChosen, setCommittedChosen] = useState<string[]>(() => cached?.chosen ?? []);
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"ok" | "warn" | "err">("ok");
  const [busy, setBusy] = useState(false);
  const [catalogLive, setCatalogLive] = useState(false);
  /** Sync guard: state-only `busy` can miss clicks before the disabled re-render commits. */
  const saveInFlight = useRef(false);
  const catalogRefreshRequested = useRef(false);
  const delegation = useSubagentDelegation(apiBase);
  const runPolicy = useSubagentRunPolicy(apiBase);

  const loadSubagents = useCallback(async (): Promise<SubagentsSnapshot> => {
    const rosterRequest = fetch(`${apiBase}/api/subagent-models`)
      .then(res => readJsonOrThrow<{
        available?: string[];
        chosen?: string[];
        advertised?: string[];
        excluded?: RosterExclusion[];
        catalogState?: CatalogState;
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
      metadataLimited: modelRows === null,
    };
    setChosen(next.chosen);
    setCommittedChosen(next.chosen);
    setCatalogLive(true);
    writeSessionListCache(cacheKey, next);
    return next;
  }, [apiBase, cacheKey, t]);

  const resource = useDataSurface<SubagentsSnapshot>(
    cacheKey,
    [apiBase],
    loadSubagents,
    { isEmpty: () => false, initialData: cached ?? undefined },
  );
  const { state } = resource;
  const load = resource.refresh;
  const snapshot = state.data ?? cached;
  const available = snapshot?.available ?? [];
  const models = snapshot?.models ?? [];
  const catalogState = catalogLive ? snapshot?.catalogState : undefined;

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
      setChosen(applied);
      setCommittedChosen(applied);
      writeSessionListCache(cacheKey, {
        available,
        chosen: applied,
        advertised,
        excluded,
        models,
        catalogState: snapshot?.catalogState,
        metadataLimited: snapshot?.metadataLimited,
      });
      const refreshFailed = data?.catalogRefresh?.ok === false || data?.catalogRefresh?.status === "failed";
      setStatusTone(refreshFailed || excluded.length > 0 ? "warn" : "ok");
      setStatus(refreshFailed
        ? t("sub.savedRefreshFailed", { n: applied.length, cmd: "ocx sync --restart-codex" })
        : excluded.length > 0
          ? t("sub.savedExcluded", { n: applied.length, missing: excluded.length })
          : t("sub.saved", { n: applied.length, cmd: "ocx sync --restart-codex" }));
      load();
    } catch (error) {
      setStatusTone("err");
      setStatus(error instanceof Error && error.message ? error.message : t("sub.networkError"));
    } finally {
      saveInFlight.current = false;
      setBusy(false);
    }
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

  const catalogLabel = catalogState?.state === "fresh"
    ? t("sub.catalog.current")
    : catalogState?.state === "stale"
      ? t("sub.catalog.restartNeeded")
      : catalogState?.state === "not_running"
        ? t("sub.catalog.nextSession")
        : catalogState?.state === "unknown"
          ? t("sub.catalog.unknown")
          : null;
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
          <span className={`subagents-catalog-badge subagents-catalog-badge--${catalogState?.state}`}>
            <span aria-hidden="true" />{catalogLabel}
          </span>
        )}
      </div>
      {status && <Notice tone={statusTone}>{status}</Notice>}
      {excluded.length > 0 && (
        <Notice tone="warn">
          {t("sub.roster.excludedNotice", { n: excluded.length, models: excludedModels })}
        </Notice>
      )}
      {catalogState?.state === "stale" && (
        <Notice tone="warn">
          {t("sub.catalog.staleNotice", { n: catalogState.processes?.length ?? 0, cmd: "ocx sync --restart-codex" })}
        </Notice>
      )}
      {catalogState?.state === "not_running" && <Notice tone="warn">{t("sub.catalog.notRunningNotice")}</Notice>}
      {snapshot?.metadataLimited && <Notice tone="warn">{t("sub.metadataLimited")}</Notice>}
      {state.showError && <Notice tone="err">{t("sub.loadFail")}</Notice>}
      <SubagentsWorkspace
        available={available}
        models={models}
        chosen={chosen}
        busy={busy}
        rosterDirty={rosterDirty}
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
            policy={runPolicy}
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
      />
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { useT } from "../../i18n/shared";
import type { ModelRow } from "../models-shared";
import { Notice } from "../../ui";
import ClientAppsWorkspace, {
  type ClientAppsProvider,
  type ProxyReadState,
} from "./ClientAppsWorkspace";
import ConsequenceDialog, { type ConsequenceCopy } from "./ConsequenceDialog";
import RestoreDialog from "./RestoreDialog";
import { describeRefusal } from "./refusal-copy";
import {
  buildOverviewRows,
  type ApiKeyReadPhase,
  type OverviewRow,
} from "./overview-clients";
import {
  loadApiKeyCount,
  loadClaudeCodeStatus,
  loadClaudeDesktopStatus,
  loadCodexRoutingStatus,
  loadGrokFenceStatus,
  loadIntegrationJournal,
  loadIntegrationStates,
  toggleIntegration,
  type IntegrationJournalRow,
  type IntegrationStatus,
} from "./integration-api";
import {
  loadNativeIntegrations,
  toggleNativeIntegration,
  type NativeStatus,
} from "./native-api";
import {
  deriveModelReadiness,
  deriveProviderReadiness,
  resourceReadState,
} from "./client-apps-readiness";
import { loadOpenCodeIntegration } from "./opencode-integration-api";

const GROK_DISABLE_COPY: ConsequenceCopy = {
  titleKey: "integrations.dialog.grok.title",
  changesKey: "integrations.dialog.grok.changes",
  breakageKey: "integrations.dialog.grok.breakage",
  undoKey: "integrations.dialog.grok.undo",
  confirmKey: "integrations.dialog.grok.confirm",
};

const DESKTOP_DISABLE_COPY: ConsequenceCopy = {
  titleKey: "integrations.dialog.desktop.title",
  changesKey: "integrations.dialog.desktop.changes",
  breakageKey: "integrations.dialog.desktop.breakage",
  undoKey: "integrations.dialog.desktop.undo",
  sideEffectKey: "integrations.dialog.desktop.restart",
  confirmKey: "integrations.dialog.desktop.confirm",
};

function isApplied(status: IntegrationStatus): boolean {
  return status.state === "current" || status.state === "stale";
}

export default function ClientAppsPage({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT();
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [restoring, setRestoring] = useState<IntegrationJournalRow | null>(null);
  const [cardResults, setCardResults] = useState<Partial<Record<OverviewRow["id"], { tone: "ok" | "err"; text: string }>>>({});
  const [pendingToggle, setPendingToggle] = useState<OverviewRow | null>(null);
  const [cardPending, setCardPending] = useState<OverviewRow["id"] | null>(null);
  const restoreFocusRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (pendingToggle !== null) return;
    const trigger = restoreFocusRef.current;
    if (!trigger) return;
    restoreFocusRef.current = null;
    if (trigger.isConnected) trigger.focus();
  }, [pendingToggle]);

  const fetchStates = useCallback(
    async (signal: AbortSignal) => (await loadIntegrationStates(apiBase, signal)).clients,
    [apiBase],
  );
  const fetchHistory = useCallback(
    async (signal: AbortSignal) => (await loadIntegrationJournal(apiBase, undefined, signal)).operations,
    [apiBase],
  );
  const fetchCodex = useCallback((signal: AbortSignal) => loadCodexRoutingStatus(apiBase, signal), [apiBase]);
  const fetchKeyCount = useCallback((signal: AbortSignal) => loadApiKeyCount(apiBase, signal), [apiBase]);
  const fetchClaude = useCallback((signal: AbortSignal) => loadClaudeCodeStatus(apiBase, signal), [apiBase]);
  const fetchClaudeDesktop = useCallback((signal: AbortSignal) => loadClaudeDesktopStatus(apiBase, signal), [apiBase]);
  const fetchGrok = useCallback((signal: AbortSignal) => loadGrokFenceStatus(apiBase, signal), [apiBase]);
  const fetchOpenCode = useCallback(
    (signal: AbortSignal) => loadOpenCodeIntegration(apiBase, signal, t("integrations.loadFailed")),
    [apiBase, t],
  );
  const fetchNative = useCallback(
    async (signal: AbortSignal) => (await loadNativeIntegrations(apiBase, signal))?.clients ?? null,
    [apiBase],
  );
  const fetchProviders = useCallback(async (signal: AbortSignal): Promise<ClientAppsProvider[]> => {
    // Reuse the safe config DTO: unlike the summary endpoint it includes the
    // keyOptional bit needed to recognize keyless providers as genuinely ready.
    const response = await fetch(`${apiBase}/api/config`, { signal });
    if (!response.ok) throw new Error(String(response.status));
    const payload = await response.json() as { providers?: Record<string, Omit<ClientAppsProvider, "name">> };
    return Object.entries(payload.providers ?? {})
      .map(([name, provider]) => ({ ...provider, name }))
      .filter(provider => provider.disabled !== true);
  }, [apiBase]);
  const fetchModels = useCallback(async (signal: AbortSignal): Promise<ModelRow[]> => {
    const response = await fetch(`${apiBase}/api/models`, { signal });
    if (!response.ok) throw new Error(String(response.status));
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("invalid model catalog response");
    return payload as ModelRow[];
  }, [apiBase]);
  const fetchProxyHealth = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    const response = await fetch(`${apiBase}/healthz`, { cache: "no-store", signal });
    return response.ok;
  }, [apiBase]);

  const statesResource = useDataSurface<IntegrationStatus[]>(
    `integration-states:${apiBase}`,
    [apiBase],
    fetchStates,
    { isEmpty: rows => rows.length === 0, enabled: active },
  );
  const historyResource = useDataSurface<IntegrationJournalRow[]>(
    `integration-journal-all:${apiBase}`,
    [apiBase],
    fetchHistory,
    { isEmpty: rows => rows.length === 0, enabled: active },
  );
  const codexResource = useDataSurface(`integration-codex:${apiBase}`, [apiBase], fetchCodex, { isEmpty: value => value === null, enabled: active });
  const keysResource = useDataSurface(`integration-keys:${apiBase}`, [apiBase], fetchKeyCount, { isEmpty: () => false, enabled: active });
  const claudeResource = useDataSurface(`integration-claude:${apiBase}`, [apiBase], fetchClaude, { isEmpty: value => value === null, enabled: active });
  const claudeDesktopResource = useDataSurface(`integration-claude-desktop:${apiBase}`, [apiBase], fetchClaudeDesktop, { isEmpty: value => value === null, enabled: active });
  const grokResource = useDataSurface(`integration-grok:${apiBase}`, [apiBase], fetchGrok, { isEmpty: value => value === null, enabled: active });
  const openCodeResource = useDataSurface(`integrations-opencode:${apiBase}`, [apiBase], fetchOpenCode, { isEmpty: () => false, enabled: active });
  const nativeResource = useDataSurface<NativeStatus[] | null>(`integration-native:${apiBase}`, [apiBase], fetchNative, { isEmpty: value => value === null, enabled: active });
  const providersResource = useDataSurface<ClientAppsProvider[]>(`client-apps-providers:${apiBase}`, [apiBase], fetchProviders, { isEmpty: value => value.length === 0, enabled: active });
  const modelsResource = useDataSurface<ModelRow[]>(`client-apps-models:${apiBase}`, [apiBase], fetchModels, { isEmpty: value => value.length === 0, enabled: active });
  const proxyResource = useDataSurface<boolean>(`client-apps-proxy:${apiBase}`, [apiBase], fetchProxyHealth, { isEmpty: value => value === false, enabled: active });

  const clients = statesResource.state.data ?? [];
  const history = historyResource.state.data ?? [];
  const appliedClients = clients.filter(isApplied);
  const clientsSettled = statesResource.state.kind !== "cold" && statesResource.state.kind !== "retrying-cold";
  const openCodeSettled = openCodeResource.state.kind !== "cold" && openCodeResource.state.kind !== "retrying-cold";
  const native = nativeResource.state.data ?? null;
  const nativeSettled = native !== null;
  const keyPhase: ApiKeyReadPhase = keysResource.state.kind === "cold" || keysResource.state.kind === "retrying-cold"
    ? "checking"
    : keysResource.state.kind === "failed-cold" || keysResource.state.kind === "failed-with-stale"
      ? "unavailable"
      : "settled";
  const { keysRow, rows } = buildOverviewRows({
    clients,
    clientsSettled,
    codex: codexResource.state.data ?? null,
    keyCount: keysResource.state.data ?? null,
    keyPhase,
    claude: claudeResource.state.data ?? null,
    claudeDesktop: claudeDesktopResource.state.data ?? null,
    grok: grokResource.state.data ?? null,
    opencode: openCodeResource.state.data ?? null,
    opencodeSettled: openCodeSettled,
    native,
    nativeSettled,
  });
  const visibleModelCount = modelsResource.state.data
    ? modelsResource.state.data.filter(model => !model.disabled).length
    : null;
  const { readyProviders, state: providerState } = deriveProviderReadiness(
    providersResource.state.kind,
    providersResource.state.data ?? [],
  );
  const modelState = deriveModelReadiness(modelsResource.state.kind, visibleModelCount);
  const historyState = resourceReadState(historyResource.state.kind);
  const proxyState: ProxyReadState = proxyResource.state.kind === "cold" || proxyResource.state.kind === "retrying-cold"
    ? "checking"
    : proxyResource.state.data === true ? "running" : "unavailable";

  const refresh = () => {
    statesResource.refresh();
    historyResource.refresh();
    codexResource.refresh();
    keysResource.refresh();
    claudeResource.refresh();
    claudeDesktopResource.refresh();
    grokResource.refresh();
    openCodeResource.refresh();
    nativeResource.refresh();
    providersResource.refresh();
    modelsResource.refresh();
    proxyResource.refresh();
  };

  const disableAll = async () => {
    if (bulkPending || appliedClients.length === 0) return;
    if (!confirm([t("integrations.bulk.title"), t("integrations.bulk.body")].join("\n\n"))) return;
    setBulkPending(true);
    setBulkResult(null);
    const failed: string[] = [];
    // Sequential: every client mutation shares ownership bookkeeping.
    for (const client of appliedClients) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- serialized ownership writes
        await toggleIntegration(apiBase, client.clientId, false);
      } catch (error) {
        failed.push(`${client.clientId}: ${describeRefusal(t, error)}`);
      }
    }
    let unsettled = false;
    try {
      const confirmed = await loadIntegrationStates(apiBase);
      unsettled = confirmed.clients.some(isApplied);
    } catch {
      failed.push(t("integrations.error.stale"));
    }
    if (unsettled && failed.length === 0) failed.push(t("integrations.error.stale"));
    refresh();
    setBulkPending(false);
    setBulkResult(failed.length === 0
      ? { tone: "ok", text: t("integrations.bulk.success") }
      : { tone: "err", text: t("integrations.bulk.partial", { clients: failed.join("; ") }) });
  };

  const refreshNativeDetails = () => {
    nativeResource.refresh();
    claudeResource.refresh();
    grokResource.refresh();
  };
  const setCardResult = (id: OverviewRow["id"], result: { tone: "ok" | "err"; text: string } | null) => {
    setCardResults(current => {
      const next = { ...current };
      if (result) next[id] = result;
      else delete next[id];
      return next;
    });
  };
  const toggleCard = async (row: OverviewRow, next: boolean) => {
    if (cardPending || !row.toggle) return;
    setCardPending(row.id);
    setCardResult(row.id, null);
    try {
      if (row.status) {
        await toggleIntegration(apiBase, row.status.clientId, next);
        refresh();
      } else if (row.toggle === "claude" || row.toggle === "grok" || row.toggle === "codex" || row.toggle === "claude-desktop") {
        const result = await toggleNativeIntegration(apiBase, row.toggle, next);
        if (result.reason === "non_loopback_removed") {
          setCardResult(row.id, { tone: "ok", text: t(result.changed ? "integrations.native.msg.nonLoopbackRemoved" : "integrations.native.msg.nonLoopbackRemovedNoop") });
        } else if (result.reason === "non_loopback_superseded") {
          setCardResult(row.id, { tone: "ok", text: t("integrations.native.msg.nonLoopbackSuperseded") });
        }
        refreshNativeDetails();
      }
    } catch (error) {
      setCardResult(row.id, { tone: "err", text: describeRefusal(t, error, undefined, row.togglePath ?? undefined) });
      refreshNativeDetails();
    } finally {
      setCardPending(null);
    }
  };
  const requestToggle = (row: OverviewRow, next: boolean) => {
    if (row.status || next || row.id === "claude" || row.toggle === null) {
      void toggleCard(row, next);
      return;
    }
    const activeElement = document.activeElement;
    restoreFocusRef.current = activeElement?.tagName === "BUTTON" ? activeElement as HTMLButtonElement : null;
    setPendingToggle(row);
  };

  return (
    <>
      {statesResource.state.kind === "failed-cold" && <div className="client-apps-load-notice"><Notice tone="err">{t("integrations.error.load")}</Notice></div>}
      {statesResource.state.kind === "failed-with-stale" && <div className="client-apps-load-notice"><Notice tone="err">{t("integrations.error.stale")}</Notice></div>}
      <ClientAppsWorkspace
        rows={rows}
        providers={readyProviders}
        providerState={providerState}
        visibleModelCount={visibleModelCount}
        modelState={modelState}
        proxyState={proxyState}
        keysRow={keysRow}
        history={history}
        historyState={historyState}
        pending={cardPending !== null}
        results={cardResults}
        bulkPending={bulkPending}
        bulkTargetCount={appliedClients.length}
        bulkResult={bulkResult}
        onRefresh={refresh}
        onToggle={row => requestToggle(row, !(row.toggleOn ?? row.applied))}
        onDisableAll={() => void disableAll()}
        onRestore={setRestoring}
      />
      {restoring && <RestoreDialog apiBase={apiBase} row={restoring} onClose={() => setRestoring(null)} onRestored={refresh} />}
      {pendingToggle && (
        <ConsequenceDialog
          copy={{ ...(pendingToggle.toggle === "claude-desktop" ? DESKTOP_DISABLE_COPY : GROK_DISABLE_COPY), vars: { path: pendingToggle.togglePath ?? "" } }}
          onClose={() => setPendingToggle(null)}
          onConfirm={async () => {
            await toggleCard(pendingToggle, false);
            setPendingToggle(null);
          }}
        />
      )}
    </>
  );
}

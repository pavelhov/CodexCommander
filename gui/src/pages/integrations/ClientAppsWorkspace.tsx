import { useMemo, useRef, useState } from "react";
import {
  IconActivity,
  IconBoxes,
  IconCheck,
  IconChevron,
  IconInfo,
  IconKey,
  IconLink,
  IconMonitor,
  IconRefresh,
  IconRoute,
  IconServer,
  IconTerminal,
} from "../../icons";
import { navigateHash } from "../../hash-routing";
import { useT, type TKey } from "../../i18n/shared";
import { formatProviderDisplayName, providerIconSrc } from "../../provider-icons";
import type { WorkspaceProvider } from "../../provider-workspace/catalog";
import { Notice, Switch } from "../../ui";
import IntegrationStateBadge from "./IntegrationStateBadge";
import { describeRefusal } from "./refusal-copy";
import { NativeApiError } from "./native-api";
import type { ApiKeysOverviewRow, OverviewRow } from "./overview-clients";
import type { IntegrationJournalRow } from "./integration-api";

export interface ClientAppsProvider extends WorkspaceProvider {
  name: string;
}

export type ProxyReadState = "checking" | "running" | "unavailable";
export type ResourceReadState = "checking" | "available" | "unavailable";

const KIND_KEY: Record<IntegrationJournalRow["kind"], TKey> = {
  apply: "integrations.kind.apply",
  disable: "integrations.kind.disable",
  refresh: "integrations.kind.refresh",
  restore: "integrations.kind.restore",
};

const CLIENT_MARKS: Partial<Record<OverviewRow["id"], string>> = {
  claude: "/provider-icons/claude-color.svg",
  claudeDesktop: "/provider-icons/claude-color.svg",
  grok: "/provider-icons/grok.svg",
  opencode: "/provider-icons/opencode.svg",
  pi: "/provider-icons/pi.svg",
  kimi: "/provider-icons/kimi-color.svg",
};

function ClientMark({ row }: { row: OverviewRow }) {
  const src = CLIENT_MARKS[row.id];
  if (src) {
    return (
      <span className="client-apps-mark" aria-hidden="true">
        <img src={src} alt="" />
      </span>
    );
  }
  const Icon = row.id === "codex"
    ? IconTerminal
    : row.id === "openclaw"
      ? IconActivity
      : IconBoxes;
  return <span className="client-apps-mark" aria-hidden="true"><Icon /></span>;
}

function ProviderChip({ provider }: { provider: ClientAppsProvider }) {
  const t = useT();
  const src = providerIconSrc(provider.name, provider);
  return (
    <span className="client-apps-flow-chip">
      {src ? <img src={src} alt="" aria-hidden="true" /> : <IconServer aria-hidden="true" />}
      {formatProviderDisplayName(provider.name, t)}
    </span>
  );
}

function translatedDetail(row: OverviewRow, t: ReturnType<typeof useT>): string | null {
  return row.detail ?? (row.detailKey ? t(row.detailKey, row.detailVars ?? undefined) : null);
}

function blockedText(row: OverviewRow, t: ReturnType<typeof useT>): string | null {
  const blocked = row.toggleBlocked !== null
    && (row.applied || row.toggleBlocked.reason === "orphaned_marker");
  if (!blocked || !row.toggleBlocked || (row.toggle !== "claude" && row.toggle !== "grok")) return null;
  return describeRefusal(t, new NativeApiError(409, {
    error: "native integration change refused",
    code: "native_integration_refused",
    clientId: row.toggle,
    reason: row.toggleBlocked.reason,
    message: row.toggleBlocked.message,
  }), undefined, row.togglePath ?? undefined);
}

function ClientListRow({
  row,
  selected,
  visibleModelCount,
  modelState,
  pending,
  result,
  onSelect,
  onOpen,
  onToggle,
}: {
  row: OverviewRow;
  selected: boolean;
  visibleModelCount: number | null;
  modelState: ResourceReadState;
  pending: boolean;
  result: { tone: "ok" | "err"; text: string } | null;
  onSelect: () => void;
  onOpen: () => void;
  onToggle: (() => void) | null;
}) {
  const t = useT();
  const label = t(row.labelKey);
  const refusal = blockedText(row, t);
  const toggleBlocked = refusal !== null;
  const canToggle = row.id !== "codex" && row.toggle !== null && onToggle !== null;
  const switchLabel = t("clientApps.action.toggle", {
    action: row.applied ? t("integrations.action.disable") : t("integrations.action.apply"),
    client: label,
  });
  return (
    <li className={`client-apps-row${selected ? " is-selected" : ""}`} data-client={row.id}>
      <button type="button" className="client-apps-row-main" onClick={onSelect} aria-pressed={selected}>
        <ClientMark row={row} />
        <span className="client-apps-row-copy">
          <span className="client-apps-row-title">{label}</span>
          <span className="client-apps-row-meta">
            <IntegrationStateBadge state={row.state} installed={row.installed} />
            {visibleModelCount !== null && row.installed && (
              <span>{t(modelState === "unavailable" ? "clientApps.modelsVisibleStale" : "clientApps.modelsVisible", { count: visibleModelCount })}</span>
            )}
            {row.id === "codex" && <span>{t("clientApps.codexManaged")}</span>}
          </span>
        </span>
      </button>
      <div className="client-apps-row-actions">
        {canToggle ? (
          <Switch
            on={row.toggleOn ?? row.applied}
            onClick={onToggle!}
            disabled={row.state === "unknown"
              || !row.installed
              || row.state === "conflict"
              || row.state === "unsafe"
              || toggleBlocked
              || pending}
            label={switchLabel}
          />
        ) : (
          <button type="button" className="btn btn-ghost" onClick={onOpen}>
            {t(row.applied ? "clientApps.action.viewConnection" : "clientApps.action.setUp")}
          </button>
        )}
      </div>
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
      {refusal && <p className="client-apps-row-refusal">{refusal}</p>}
    </li>
  );
}

function AvailableClient({ row, onSelect, onOpen }: {
  row: OverviewRow;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  const availabilityKey = row.state === "unknown"
    ? "integrations.state.unknown"
    : row.installed
      ? "clientApps.available.detected"
      : "clientApps.available.notDetected";
  return (
    <li className="client-apps-available-row" data-client={row.id}>
      <button type="button" className="client-apps-available-main" onClick={onSelect}>
        <ClientMark row={row} />
        <span>
          <strong>{t(row.labelKey)}</strong>
          <small>{t(availabilityKey)}</small>
        </span>
      </button>
      <button type="button" className="btn btn-ghost" onClick={onOpen}>
        {t(row.state !== "unknown" && row.installed ? "clientApps.action.setUp" : "clientApps.action.details")}
        <IconChevron aria-hidden="true" />
      </button>
    </li>
  );
}

function CheckRow({ state, label }: { state: ResourceReadState; label: string }) {
  const t = useT();
  const ok = state === "available";
  const checking = state === "checking";
  return (
    <li className={`client-apps-check-row${ok ? " is-ok" : ""}`}>
      {ok ? <IconCheck aria-hidden="true" /> : checking ? <IconRefresh aria-hidden="true" /> : <IconInfo aria-hidden="true" />}
      <span>{label}</span>
      <strong>{t(checking ? "clientApps.check.checking" : ok ? "clientApps.check.available" : "clientApps.check.unavailable")}</strong>
    </li>
  );
}

export default function ClientAppsWorkspace({
  rows,
  providers,
  providerState,
  visibleModelCount,
  modelState,
  proxyState,
  keysRow,
  history,
  historyState,
  pending,
  results,
  bulkPending,
  bulkTargetCount,
  bulkResult,
  onRefresh,
  onToggle,
  onDisableAll,
  onRestore,
}: {
  rows: OverviewRow[];
  providers: ClientAppsProvider[];
  providerState: ResourceReadState;
  visibleModelCount: number | null;
  modelState: ResourceReadState;
  proxyState: ProxyReadState;
  keysRow: ApiKeysOverviewRow;
  history: IntegrationJournalRow[];
  historyState: ResourceReadState;
  pending: boolean;
  results: Partial<Record<OverviewRow["id"], { tone: "ok" | "err"; text: string }>>;
  bulkPending: boolean;
  bulkTargetCount: number;
  bulkResult: { tone: "ok" | "err"; text: string } | null;
  onRefresh: () => void;
  onToggle: (row: OverviewRow) => void;
  onDisableAll: () => void;
  onRestore: (row: IntegrationJournalRow) => void;
}) {
  const t = useT();
  const availableRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<OverviewRow["id"] | null>(null);
  const configuredRows = useMemo(() => rows.filter(row => row.id !== "codex" && row.applied), [rows]);
  const availableRows = useMemo(() => rows.filter(row => row.id !== "codex" && !row.applied), [rows]);
  const codexRow = rows.find(row => row.id === "codex") ?? null;

  const selected = rows.find(row => row.id === selectedId)
    ?? rows.find(row => row.id === "opencode")
    ?? codexRow
    ?? rows[0]
    ?? null;
  const selectedHistory = selected ? history.filter(row => row.clientId === selected.id) : [];
  const latestRestore = selectedHistory.find(row => row.snapshot !== "expired") ?? null;
  const configuredCount = rows.filter(row => row.applied).length;
  const providerChips = providers.slice(0, 3);
  const configuredChips = rows.filter(row => row.applied).slice(0, 3);
  const keysDetail = keysRow.detailKey ? t(keysRow.detailKey, keysRow.detailVars ?? undefined) : null;

  return (
    <section className="client-apps-workspace">
      <header className="client-apps-page-head">
        <div>
          <h2>{t("nav.clientApps")}</h2>
          <p>{t("clientApps.subtitle")}</p>
        </div>
        <div className="client-apps-page-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => availableRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
          >
            {t("clientApps.action.addClient")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onRefresh}>
            <IconRefresh aria-hidden="true" /> {t("clientApps.action.refresh")}
          </button>
        </div>
      </header>

      <nav className="client-apps-flow" aria-label={t("clientApps.flow.aria")}>
        <button type="button" className="client-apps-flow-stage" onClick={() => navigateHash("providers")}>
          <span className="client-apps-flow-icon"><IconServer aria-hidden="true" /></span>
          <span>
            <strong>{t("clientApps.flow.providers")}</strong>
            <small>{providerState === "checking"
              ? t("integrations.state.unknown")
              : providerState === "unavailable"
                ? t("clientApps.check.unavailable")
                : t("clientApps.flow.providersCount", { count: providers.length })}</small>
            <em>{t("clientApps.flow.providersHelp")}</em>
          </span>
        </button>
        <span className="client-apps-flow-arrow" aria-hidden="true">→</span>
        <button type="button" className="client-apps-flow-stage" onClick={() => navigateHash("startup")}>
          <span className="client-apps-flow-icon"><IconLink aria-hidden="true" /></span>
          <span>
            <strong>{t("clientApps.flow.proxy")}</strong>
            <small>{t(proxyState === "checking"
              ? "clientApps.flow.proxyChecking"
              : proxyState === "running"
                ? "clientApps.flow.proxyRunning"
                : "clientApps.flow.proxyUnavailable")}</small>
            <em>{t("clientApps.flow.proxyHelp")}</em>
          </span>
        </button>
        <span className="client-apps-flow-arrow" aria-hidden="true">→</span>
        <button type="button" className="client-apps-flow-stage is-current" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          <span className="client-apps-flow-icon"><IconMonitor aria-hidden="true" /></span>
          <span>
            <strong>{t("clientApps.flow.clients")}</strong>
            <small>{t("clientApps.flow.clientsCount", { count: configuredCount })}</small>
            <em>{t("clientApps.flow.clientsHelp")}</em>
          </span>
        </button>
        <div className="client-apps-flow-chips client-apps-flow-chips--providers">
          {providerChips.map(provider => <ProviderChip key={provider.name} provider={provider} />)}
        </div>
        <div className="client-apps-flow-chips client-apps-flow-chips--clients">
          {configuredChips.map(row => (
            <button key={row.id} type="button" className="client-apps-flow-chip" onClick={() => setSelectedId(row.id)}>
              <ClientMark row={row} /> {t(row.labelKey)}
            </button>
          ))}
        </div>
      </nav>

      <div className="client-apps-content-grid">
        <section className="client-apps-catalog" aria-labelledby="client-apps-catalog-title">
          <h3 id="client-apps-catalog-title">{t("clientApps.yourClients")}</h3>
          {codexRow && (
            <ul className="client-apps-list client-apps-list--core">
              <ClientListRow
                row={codexRow}
                selected={selected?.id === codexRow.id}
                visibleModelCount={visibleModelCount}
                modelState={modelState}
                pending={pending}
                result={results[codexRow.id] ?? null}
                onSelect={() => setSelectedId(codexRow.id)}
                onOpen={() => navigateHash(codexRow.hash)}
                onToggle={null}
              />
            </ul>
          )}

          {configuredRows.length > 0 && (
            <ul className="client-apps-list">
              {configuredRows.map(row => (
                <ClientListRow
                  key={row.id}
                  row={row}
                  selected={selected?.id === row.id}
                  visibleModelCount={visibleModelCount}
                  modelState={modelState}
                  pending={pending}
                  result={results[row.id] ?? null}
                  onSelect={() => setSelectedId(row.id)}
                  onOpen={() => navigateHash(row.hash)}
                  onToggle={row.toggle ? () => onToggle(row) : null}
                />
              ))}
            </ul>
          )}

          <div ref={availableRef} className="client-apps-available">
            <h3>{t("clientApps.available.title")}</h3>
            {availableRows.length > 0 ? (
              <ul>
                {availableRows.map(row => (
                  <AvailableClient
                    key={row.id}
                    row={row}
                    onSelect={() => setSelectedId(row.id)}
                    onOpen={() => navigateHash(row.hash)}
                  />
                ))}
              </ul>
            ) : (
              <p className="client-apps-empty">{t("clientApps.available.empty")}</p>
            )}
          </div>
        </section>

        <aside className="client-apps-detail" aria-live="polite">
          <div className="client-apps-detail-head">
            <div>
              <h3>{t("clientApps.check.title")}</h3>
              <p>{t("clientApps.check.subtitle")}</p>
            </div>
            <span className={`client-apps-proxy-pill is-${proxyState}`}>
              {t(proxyState === "checking"
                ? "clientApps.flow.proxyChecking"
                : proxyState === "running"
                  ? "clientApps.flow.proxyRunning"
                  : "clientApps.flow.proxyUnavailable")}
            </span>
          </div>

          <ul className="client-apps-check-list">
            <CheckRow state={providerState} label={t("clientApps.check.providers")} />
            <CheckRow state={proxyState === "running" ? "available" : proxyState} label={t("clientApps.check.proxy")} />
            <CheckRow state={modelState} label={t("clientApps.check.models")} />
          </ul>

          {selected ? (
            <div className="client-apps-selected">
              <div className="client-apps-selected-title">
                <ClientMark row={selected} />
                <div>
                  <h3>{t(selected.labelKey)}</h3>
                  <IntegrationStateBadge state={selected.state} installed={selected.installed} />
                </div>
              </div>
              <dl>
                <div>
                  <dt>{t("clientApps.detail.config")}</dt>
                  <dd>{translatedDetail(selected, t) ?? t("integrations.status.unknown")}</dd>
                </div>
                <div>
                  <dt>{t("clientApps.detail.models")}</dt>
                  <dd>{visibleModelCount !== null
                    ? t(modelState === "unavailable" ? "clientApps.modelsVisibleStale" : "clientApps.modelsVisible", { count: visibleModelCount })
                    : t(modelState === "checking" ? "clientApps.check.checking" : "clientApps.check.unavailable")}</dd>
                </div>
                <div>
                  <dt>{t("clientApps.detail.routing")}</dt>
                  <dd>{t("clientApps.detail.routingValue")}</dd>
                </div>
              </dl>
              <button type="button" className="btn btn-primary client-apps-primary-action" onClick={() => navigateHash(selected.hash)}>
                {t(selected.applied ? "clientApps.action.viewConnection" : "clientApps.action.setUp")}
              </button>
              <div className="client-apps-detail-links">
                <button type="button" onClick={() => navigateHash("routing")}><IconRoute aria-hidden="true" />{t("clientApps.action.openRouting")}<IconChevron aria-hidden="true" /></button>
                <button type="button" onClick={() => setHistoryOpen(open => !open)}><IconActivity aria-hidden="true" />{t("clientApps.action.reviewChanges")}<IconChevron aria-hidden="true" /></button>
                {selected.id !== "opencode" && (
                  <button type="button" disabled={!latestRestore} onClick={() => latestRestore && onRestore(latestRestore)}><IconRefresh aria-hidden="true" />{t("clientApps.action.restoreBackup")}<IconChevron aria-hidden="true" /></button>
                )}
              </div>
              {selected.id === "opencode" && (
                <Notice tone="warn">{t("clientApps.opencodeDistinction")}</Notice>
              )}
            </div>
          ) : (
            <p className="client-apps-empty">{t("clientApps.detail.none")}</p>
          )}
        </aside>
      </div>

      <section className="client-apps-access-banner">
        <span className="client-apps-access-icon"><IconKey aria-hidden="true" /></span>
        <div>
          <h3>{t("clientApps.apiAccess.title")}</h3>
          <p>{t("clientApps.apiAccess.body")}</p>
          {keysDetail && <small>{keysDetail}</small>}
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => navigateHash(keysRow.hash)}>
          {t("nav.apiAccess")} <IconChevron aria-hidden="true" />
        </button>
      </section>

      {historyOpen && (
        <section className="client-apps-history" aria-labelledby="client-apps-history-title">
          <div className="client-apps-history-head">
            <div>
              <h3 id="client-apps-history-title">{t("clientApps.history.title")}</h3>
              <p>{t("clientApps.history.body")}</p>
            </div>
            <button type="button" className="btn btn-ghost" disabled={bulkPending || bulkTargetCount === 0} onClick={onDisableAll}>
              {t("clientApps.action.disableManagedConfigs")}
            </button>
          </div>
          {bulkResult && <Notice tone={bulkResult.tone}>{bulkResult.text}</Notice>}
          {historyState === "unavailable" && (
            <Notice tone="err">{t("clientApps.history.unavailable")}</Notice>
          )}
          {historyState === "checking" ? (
            <p className="client-apps-empty">{t("clientApps.check.checking")}</p>
          ) : history.length === 0 && historyState === "available" ? (
            <p className="client-apps-empty">{t("integrations.rollback.empty")}</p>
          ) : history.length > 0 ? (
            <ul className="integration-history">
              {history.map(row => (
                <li key={row.opId}>
                  <span className="integration-history-kind">{t(KIND_KEY[row.kind])}</span>
                  <span className="integration-history-client">{row.clientId}</span>
                  <span className="integration-history-at">{new Date(row.at).toLocaleString()}</span>
                  {row.snapshot === "expired" ? (
                    <span className="badge badge-muted">{t("integrations.action.snapshotExpired")}</span>
                  ) : (
                    <button type="button" className="btn btn-ghost" onClick={() => onRestore(row)}>
                      {row.undoable ? t("integrations.action.undo") : t("integrations.action.restorePoint")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
    </section>
  );
}

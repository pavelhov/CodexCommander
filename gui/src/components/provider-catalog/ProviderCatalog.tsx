/**
 * ProviderCatalog — the browse surface of the add-provider modal: Accounts /
 * Free / Paid tabs over a single searchable scroll list, and account login
 * rows on the Accounts tab. A non-empty query searches every tier at once —
 * presets across Accounts/Free/Paid plus the account login rows — and renders
 * grouped, tier-labelled results, so a match living under another tab surfaces
 * instead of silently filtering only the selected tier. Presentational:
 * presets/usage arrive via props; view state (tab, query) lives here;
 * selection lifts up.
 */
import { useMemo, useState } from "react";
import { useT } from "../../i18n/shared";
import {
  bucketPresets,
  filterPresets,
  type CatalogPreset,
} from "./provider-presets";

export type AccountLoginStatus = { loggedIn: boolean; email?: string; error?: string };
export type AccountLoginRow = {
  id: string;
  label: string;
  kind: "oauth" | "key" | "codex";
  statusLabel?: string;
  /** Optional deep-link for codex/account-pool management. */
  href?: string;
};

export type CatalogTier = "accounts" | "free" | "paid";

const EMPTY_USAGE_RANK: Record<string, number> = {};
const EMPTY_ACCOUNT_ROWS: AccountLoginRow[] = [];
const EMPTY_ACCOUNT_STATUS: Record<string, AccountLoginStatus> = {};

/** Case-insensitive query over account login rows — same label/id semantics as filterPresets. */
function filterAccountRows(rows: AccountLoginRow[], query: string): AccountLoginRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r => r.label.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
}

export default function ProviderCatalog({
  presets,
  usageRank = EMPTY_USAGE_RANK,
  presetsLoading = false,
  initialTier = "free",
  onSelectPreset,
  onSelectCustom,
  accountRows = EMPTY_ACCOUNT_ROWS,
  accountStatus = EMPTY_ACCOUNT_STATUS,
  busyProvider = null,
  onLogin,
  onCancelLogin,
  onLogout,
}: {
  presets: CatalogPreset[];
  usageRank?: Record<string, number>;
  presetsLoading?: boolean;
  initialTier?: CatalogTier;
  onSelectPreset: (preset: CatalogPreset) => void;
  onSelectCustom: () => void;
  /** Accounts-tab login rows; empty (default) degrades to preset-only rendering. */
  accountRows?: AccountLoginRow[];
  accountStatus?: Record<string, AccountLoginStatus>;
  busyProvider?: string | null;
  onLogin?: (provider: string) => void;
  onCancelLogin?: (provider: string) => void;
  onLogout?: (provider: string) => void;
}) {
  const t = useT();
  const [tier, setTier] = useState<CatalogTier>(initialTier);
  const [query, setQuery] = useState("");

  const catalog = useMemo(() => presets.filter(p => p.id !== "custom"), [presets]);

  /** Usage-ranked order only after usage arrives; until then keep stable label order
   * so a slow /api/usage (~5s cold) cannot flash a catalog resort. */
  const ranked = useMemo(() => {
    const hasUsage = Object.keys(usageRank).length > 0;
    return catalog.toSorted((a, b) => {
      if (hasUsage) {
        const ra = usageRank[a.id] ?? 0;
        const rb = usageRank[b.id] ?? 0;
        if (rb !== ra) return rb - ra;
      }
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
    });
  }, [catalog, usageRank]);

  const buckets = useMemo(() => bucketPresets(ranked), [ranked]);
  const tierList = buckets[tier];
  const rows = useMemo(() => filterPresets(tierList, query), [tierList, query]);

  /** A non-empty (post-trim) query switches the list into cross-tier search mode. */
  const searching = query.trim() !== "";
  /** Search mode matches across every tier plus the account login rows — never
   * just the selected tab — so "opencode" typed on Accounts still finds the
   * Paid opencode-go preset instead of rendering an empty Accounts list. */
  const accountMatches = useMemo(() => filterAccountRows(accountRows, query), [accountRows, query]);
  const freeMatches = useMemo(() => filterPresets(buckets.free, query), [buckets, query]);
  const paidMatches = useMemo(() => filterPresets(buckets.paid, query), [buckets, query]);
  const searchEmpty = accountMatches.length === 0 && freeMatches.length === 0 && paidMatches.length === 0;

  const badges = (p: CatalogPreset) => {
    const auth = p.codexAccountMode === "direct" ? <span className="badge badge-green">{t("modal.badge.direct")}</span>
      : p.codexAccountMode === "pool" ? <span className="badge badge-accent">{t("modal.badge.pool")}</span>
      : p.auth === "oauth" ? <span className="badge badge-accent">{t("modal.badge.oauth")}</span>
      : p.auth === "forward" ? <span className="badge badge-green">{t("modal.badge.codexLogin")}</span>
      : p.auth === "local" ? <span className="badge badge-amber">{t("modal.badge.local")}</span>
      : p.keyOptional ? null // keyless free: the Free badge alone says it all
      : <span className="badge badge-muted">{t("modal.badge.apiKey")}</span>;
    // Free pricing is orthogonal to auth: NVIDIA (freeTier + key required) shows BOTH
    // the Free badge and the API-key badge — free pricing never hides a key requirement.
    const free = (p.freeTier || p.keyOptional) && p.auth === "key"
      ? <span className="badge badge-green">{t("modal.badge.free")}</span>
      : null;
    return <>{free}{auth}</>;
  };

  const presetRow = (p: CatalogPreset) => (
    <button type="button" key={p.id} className="list-row" onClick={() => onSelectPreset(p)}>
      <div>
        <div className="title">{p.label}</div>
        <div className="sub"><code className="chip">{p.adapter}</code>{p.note ? ` · ${p.note}` : ""}</div>
      </div>
      <div className="provider-catalog-badges">{badges(p)}</div>
    </button>
  );

  const accountRow = (row: AccountLoginRow) => {
    const status = accountStatus[row.id];
    const busy = busyProvider === row.id;
    const loggedIn = !!status?.loggedIn;
    const statusText = loggedIn
      ? (status?.email ?? row.statusLabel ?? t("modal.accountLoggedIn"))
      : (status?.error ?? row.statusLabel ?? t("modal.accountLoggedOut"));
    return (
      <div key={row.id} className="list-row provider-catalog-account-row">
        <div>
          <div className="title">{row.label}</div>
          <div className="sub">{statusText}</div>
        </div>
        <div className="provider-catalog-badges">
          {row.kind === "key" ? null : row.kind === "codex" ? (
            <>
              {loggedIn && (
                <a className="btn btn-ghost" href={row.href ?? "#codex-auth"}>{t("modal.accountManage")}</a>
              )}
              {onLogin && (
                <button type="button"
                  className={loggedIn ? "btn btn-ghost" : "btn btn-primary"}
                  disabled={busy}
                  onClick={() => { if (!busy) onLogin(row.id); }}
                >
                  {busy ? t("codexAuth.enablingOpenai") : loggedIn ? t("modal.accountAdd") : t("modal.accountLogin")}
                </button>
              )}
            </>
          ) : loggedIn ? (
            onLogout && <button type="button" className="btn btn-ghost" onClick={() => onLogout(row.id)}>{t("modal.accountLogout")}</button>
          ) : busy ? (
            onCancelLogin && <button type="button" className="btn btn-ghost" onClick={() => onCancelLogin(row.id)}>{t("common.cancel")}</button>
          ) : (
            onLogin && <button type="button" className="btn btn-primary" onClick={() => onLogin(row.id)}>{t("modal.accountLogin")}</button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="provider-catalog">
      <div className="provider-catalog-tabs" role={searching ? undefined : "tablist"}>
        {(["accounts", "free", "paid"] as const).map(candidate => (
          <button type="button"
            key={candidate}
            role={searching ? undefined : "tab"}
            aria-selected={searching ? undefined : tier === candidate}
            className={`provider-catalog-tab${tier === candidate ? " active" : ""}`}
            onClick={() => { setTier(candidate); setQuery(""); }}
          >
            {t(candidate === "accounts" ? "modal.tab.accounts" : candidate === "free" ? "modal.tab.free" : "modal.tab.paid")}
          </button>
        ))}
      </div>

      {tier === "accounts" && !searching && (
        <div className="provider-catalog-accounts-hint muted text-label">
          {t("modal.accountsHint")}
        </div>
      )}

      <input
        className="input provider-catalog-search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t("modal.search")}
      />

      <div className="provider-catalog-rows">
        {searching ? (
          <>
            {presetsLoading && searchEmpty && (
              <div className="muted text-control provider-catalog-empty">{t("modal.catalogLoading")}</div>
            )}
            {accountMatches.length > 0 && (
              <div className="provider-catalog-group" role="group" aria-label={t("modal.tab.accounts")}>
                <div className="provider-catalog-group-label muted text-label">{t("modal.tab.accounts")}</div>
                {accountMatches.map(accountRow)}
              </div>
            )}
            {freeMatches.length > 0 && (
              <div className="provider-catalog-group" role="group" aria-label={t("modal.tab.free")}>
                <div className="provider-catalog-group-label muted text-label">{t("modal.tab.free")}</div>
                {freeMatches.map(presetRow)}
              </div>
            )}
            {paidMatches.length > 0 && (
              <div className="provider-catalog-group" role="group" aria-label={t("modal.tab.paid")}>
                <div className="provider-catalog-group-label muted text-label">{t("modal.tab.paid")}</div>
                {paidMatches.map(presetRow)}
              </div>
            )}
            {!presetsLoading && searchEmpty && (
              <div className="muted text-control provider-catalog-empty">{t("modal.noMatch")}</div>
            )}
          </>
        ) : (
          <>
            {presetsLoading && rows.length === 0 && (
              <div className="muted text-control provider-catalog-empty">{t("modal.catalogLoading")}</div>
            )}
            {tier !== "accounts" && rows.map(presetRow)}
            {tier !== "accounts" && !presetsLoading && rows.length === 0 && (
              <div className="muted text-control provider-catalog-empty">{t("modal.noMatch")}</div>
            )}

            {tier === "accounts" && accountRows.map(accountRow)}
            {tier === "accounts" && accountRows.length === 0 && !presetsLoading && (
              <div className="muted text-control provider-catalog-empty">{t("modal.noMatch")}</div>
            )}
          </>
        )}
      </div>

      <div className="provider-catalog-footer">
        <div style={{ flex: 1 }} />
        {tier !== "accounts" && (
          <button type="button" className="link-btn" onClick={onSelectCustom}>{t("modal.notListed")}</button>
        )}
      </div>
    </div>
  );
}

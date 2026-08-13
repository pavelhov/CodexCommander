/**
 * Dashboard "Plan & quota" section.
 *
 * Fed by the shared provider-quota store (keyed by apiBase) — the same entry the
 * Providers workspace shell selects, so both surfaces dedupe into one fetch and share
 * last-known-good data. Reuses the workspace parsing (accountQuotaFromReport /
 * capacityAggregationFromReport / referenceQuotaFromReport) and the
 * ProviderCapacityQuota presentation so both surfaces share semantics: per-provider
 * plan, 5h/week/month windows, and observed reference spend vs published caps —
 * always labeled provider-reported / estimates, never billed spend.
 *
 * Styling reuses existing dashboard tokens/classes (panel, dash-sidecar-grid,
 * pws-capacity-*, muted/text-caption/mono); no new stylesheet is introduced.
 */
import { useEffect } from "react";
import { useI18n, useT, type TFn, type TKey } from "../i18n/shared";
import { useProviderQuota } from "../provider-quota-store";
import { formatProviderDisplayName } from "../provider-icons";
import {
  formatQuotaSourceLabel,
  referenceQuotaFromReport,
  type ProviderQuotaReferenceWindowView,
  type ProviderQuotaReportView,
} from "../provider-workspace/report";
import { formatRequestCount, formatTokenCount } from "../provider-workspace/usage";
import { ProviderCapacityQuota } from "../components/provider-workspace/ProviderCapacityQuota";

const REFERENCE_WINDOW_KEYS: Record<ProviderQuotaReferenceWindowView["id"], TKey> = {
  five_hour: "pws.reference.fiveHour",
  weekly: "pws.reference.weekly",
  monthly: "pws.reference.monthly",
};

function referenceObservedLabel(
  window: ProviderQuotaReferenceWindowView,
  locale: string,
  t: TFn,
): string {
  if (window.observedRequests === 0) return t("pws.reference.noTraffic");
  if (window.observedSpendUsd !== undefined) {
    const amount = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: window.observedSpendUsd < 0.01 ? 4 : 2,
    }).format(window.observedSpendUsd);
    return t("pws.reference.spendObserved", { amount });
  }
  if (window.observedTokens > 0) {
    return t("pws.reference.tokensObserved", { tokens: formatTokenCount(window.observedTokens, locale) });
  }
  return t("pws.reference.requestsObserved", { requests: formatRequestCount(window.observedRequests, locale) });
}

function PlanQuotaReference({ report, locale }: { report: ProviderQuotaReportView; locale: string }) {
  const t = useT();
  const reference = referenceQuotaFromReport(report);
  if (!reference) return null;
  const money = (amount: number) => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: amount >= 10 ? 0 : 2,
  }).format(amount);
  return (
    <div className="pws-reference-quota" style={{ marginTop: 10 }}>
      <div className="muted text-caption" style={{ marginBottom: 6 }}>{t("dash.planQuota.referenceIntro")}</div>
      {reference.windows.map(window => (
        <div key={window.id} style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <strong className="text-caption">{t(REFERENCE_WINDOW_KEYS[window.id])}</strong>
          <span className="mono text-caption">
            {t("pws.reference.publishedCap", { amount: money(window.publishedLimitUsd) })}
          </span>
          <span className="muted text-caption">{referenceObservedLabel(window, locale, t)}</span>
        </div>
      ))}
    </div>
  );
}

export function DashboardPlanQuotaSection({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { locale } = useI18n();
  const quota = useProviderQuota(apiBase);
  // First subscriber on this surface: fetch (singleflight dedupes against the
  // Providers workspace shell; a rehydrated session seed quiet-revalidates).
  const ensure = quota.ensure;
  useEffect(() => {
    ensure();
  }, [ensure]);

  const entries = Object.entries(quota.reports);
  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="dash-plan-quota-title">
      <div className="panel-head">
        <h3 id="dash-plan-quota-title" className="panel-title">{t("dash.planQuota.title")}</h3>
        <span className="muted text-caption">{t("dash.planQuota.hint")}</span>
      </div>
      {entries.length === 0 ? (
        <p className="muted" style={{ marginTop: 10 }}>
          {quota.loading ? t("dash.planQuota.loading") : t("dash.planQuota.empty")}
        </p>
      ) : (
        <div className="dash-sidecar-grid" style={{ marginTop: 12 }}>
          {entries.map(([provider, report]) => (
            <div className="dash-sidecar-card" key={provider}>
              <div className="dash-sidecar-card__row">
                <strong>{formatProviderDisplayName(provider, t)}</strong>
                {report.source?.trim() && (
                  <span className="muted text-caption">{formatQuotaSourceLabel(report.source)}</span>
                )}
              </div>
              <ProviderCapacityQuota report={report} pending={false} />
              <PlanQuotaReference report={report} locale={locale} />
            </div>
          ))}
        </div>
      )}
      <p className="muted text-caption" style={{ marginTop: 12 }}>{t("dash.planQuota.disclaimer")}</p>
    </section>
  );
}

import type { TFn } from "../i18n/shared";
import type { ProviderQuotaReferenceWindowView } from "./report";
import { formatRequestCount, formatTokenCount } from "./usage";

/** Local proxy observations, with no inferred provider balance or cap. */
export function referenceObservedLabels(
  window: ProviderQuotaReferenceWindowView,
  locale: string,
  t: TFn,
): string[] {
  if (window.observedRequests === 0) return [t("pws.reference.noTraffic")];
  const labels: string[] = [];
  if (window.observedSpendUsd !== undefined) {
    const amount = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: window.observedSpendUsd < 0.01 ? 4 : 2,
    }).format(window.observedSpendUsd);
    labels.push(t("pws.reference.spendObserved", { amount }));
  }
  if (window.observedTokens > 0) {
    labels.push(t("pws.reference.tokensObserved", { tokens: formatTokenCount(window.observedTokens, locale) }));
  }
  labels.push(t("pws.reference.requestsObserved", { requests: formatRequestCount(window.observedRequests, locale) }));
  return labels;
}

export function referenceCoverageLabel(
  coverage: ProviderQuotaReferenceWindowView["coverage"],
  t: TFn,
): string | null {
  if (coverage === "none") return null;
  return t(coverage === "complete"
    ? "pws.reference.estimate"
    : coverage === "partial"
      ? "pws.reference.partial"
      : "pws.reference.tokensOnly");
}

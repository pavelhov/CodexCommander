/**
 * provider-workspace/report.ts — pure derivations for the workspace detail
 * panels (WP090): quota-report → AccountQuota adaptation, quota source labels,
 * and the models-tab filter. No React, no fetch.
 */
import type { AccountQuota } from "../codex-quota-utils";

/** Wire shape of one /api/provider-quotas report row as the workspace consumes it. */
export interface ProviderQuotaReportView {
  label?: string;
  source?: string;
  updatedAt?: number;
  quota?: unknown;
}

export type ProviderQuotaReferenceCoverage = "none" | "complete" | "partial" | "unpriced";

export interface ProviderQuotaReferenceWindowView {
  id: "five_hour" | "weekly" | "monthly";
  label: string;
  windowSeconds: number;
  publishedLimitUsd: number;
  observedSpendUsd?: number;
  observedTokens: number;
  observedRequests: number;
  pricedRequests: number;
  unpricedRequests: number;
  unmeasuredRequests: number;
  coverage: ProviderQuotaReferenceCoverage;
}

export interface ProviderQuotaLimitEventView {
  limitName: "5 hour" | "weekly" | "monthly";
  observedAt: number;
  resetAt?: number;
}

export interface ProviderReferenceQuotaView {
  windows: ProviderQuotaReferenceWindowView[];
  observedLimitEvent?: ProviderQuotaLimitEventView;
}

const REFERENCE_IDS = new Set<ProviderQuotaReferenceWindowView["id"]>(["five_hour", "weekly", "monthly"]);
const COVERAGE_VALUES = new Set<ProviderQuotaReferenceCoverage>(["none", "complete", "partial", "unpriced"]);
const LIMIT_NAMES = new Set<ProviderQuotaLimitEventView["limitName"]>(["5 hour", "weekly", "monthly"]);

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validTimestamp(value: unknown): number | undefined {
  const timestamp = finiteNonNegative(value);
  return timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime())
    ? timestamp
    : undefined;
}

/**
 * Parse published-cap/local-observation reports without adapting them to percentage bars.
 * These values are deliberately a distinct shape: turning spend/caps into "remaining" would
 * imply a provider balance that OpenCode Go does not expose.
 */
export function referenceQuotaFromReport(report?: ProviderQuotaReportView): ProviderReferenceQuotaView | null {
  const quota = report?.quota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return null;
  const q = quota as Record<string, unknown>;
  const windows = Array.isArray(q.referenceWindows)
    ? q.referenceWindows.flatMap(raw => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const row = raw as Record<string, unknown>;
        const id = typeof row.id === "string" && REFERENCE_IDS.has(row.id as ProviderQuotaReferenceWindowView["id"])
          ? row.id as ProviderQuotaReferenceWindowView["id"]
          : null;
        const coverage = typeof row.coverage === "string" && COVERAGE_VALUES.has(row.coverage as ProviderQuotaReferenceCoverage)
          ? row.coverage as ProviderQuotaReferenceCoverage
          : null;
        const windowSeconds = finiteNonNegative(row.windowSeconds);
        const publishedLimitUsd = finiteNonNegative(row.publishedLimitUsd);
        const observedTokens = finiteNonNegative(row.observedTokens);
        const observedRequests = finiteNonNegative(row.observedRequests);
        const pricedRequests = finiteNonNegative(row.pricedRequests);
        const unpricedRequests = finiteNonNegative(row.unpricedRequests);
        const unmeasuredRequests = finiteNonNegative(row.unmeasuredRequests);
        if (!id || !coverage || typeof row.label !== "string" || !row.label.trim()
          || !windowSeconds || !publishedLimitUsd
          || observedTokens === undefined || observedRequests === undefined
          || pricedRequests === undefined || unpricedRequests === undefined || unmeasuredRequests === undefined) return [];
        const observedSpendUsd = finiteNonNegative(row.observedSpendUsd);
        const hasObservation = observedRequests > 0 || observedTokens > 0 || observedSpendUsd !== undefined;
        const internallyComplete = hasObservation
          && observedRequests > 0
          && pricedRequests === observedRequests
          && unpricedRequests === 0
          && unmeasuredRequests === 0
          && observedSpendUsd !== undefined;
        const normalizedCoverage: ProviderQuotaReferenceCoverage = !hasObservation
          ? "none"
          : coverage === "complete" && !internallyComplete
            ? "partial"
            : coverage;
        return [{
          id,
          label: row.label,
          windowSeconds,
          publishedLimitUsd,
          ...(observedSpendUsd !== undefined ? { observedSpendUsd } : {}),
          observedTokens,
          observedRequests,
          pricedRequests,
          unpricedRequests,
          unmeasuredRequests,
          coverage: normalizedCoverage,
        } satisfies ProviderQuotaReferenceWindowView];
      })
    : [];

  let observedLimitEvent: ProviderQuotaLimitEventView | undefined;
  if (q.observedLimitEvent && typeof q.observedLimitEvent === "object" && !Array.isArray(q.observedLimitEvent)) {
    const event = q.observedLimitEvent as Record<string, unknown>;
    const limitName = typeof event.limitName === "string" && LIMIT_NAMES.has(event.limitName as ProviderQuotaLimitEventView["limitName"])
      ? event.limitName as ProviderQuotaLimitEventView["limitName"]
      : null;
    const observedAt = validTimestamp(event.observedAt);
    const resetAt = validTimestamp(event.resetAt);
    if (limitName && observedAt !== undefined) {
      observedLimitEvent = { limitName, observedAt, ...(resetAt !== undefined ? { resetAt } : {}) };
    }
  }

  if (windows.length === 0 && !observedLimitEvent) return null;
  return { windows, ...(observedLimitEvent ? { observedLimitEvent } : {}) };
}

/** Narrow an unknown quota payload into the AccountQuota display shape (null when unusable). */
export function accountQuotaFromReport(report?: ProviderQuotaReportView): AccountQuota | null {
  const quota = report?.quota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return null;
  const q = quota as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const windows = Array.isArray(q.customWindows)
    ? (q.customWindows as unknown[]).flatMap(w => {
        if (!w || typeof w !== "object") return [];
        const row = w as Record<string, unknown>;
        if (typeof row.label !== "string" || num(row.percent) === undefined) return [];
        return [{
          label: row.label,
          percent: row.percent as number,
          ...(num(row.resetAt) !== undefined ? { resetAt: row.resetAt as number } : {}),
        }];
      })
    : [];
  const out: AccountQuota = {
    ...(num(q.fiveHourPercent) !== undefined ? { fiveHourPercent: q.fiveHourPercent as number } : {}),
    ...(num(q.fiveHourResetAt) !== undefined ? { fiveHourResetAt: q.fiveHourResetAt as number } : {}),
    ...(num(q.weeklyPercent) !== undefined ? { weeklyPercent: q.weeklyPercent as number } : {}),
    ...(num(q.weeklyResetAt) !== undefined ? { weeklyResetAt: q.weeklyResetAt as number } : {}),
    ...(num(q.monthlyPercent) !== undefined ? { monthlyPercent: q.monthlyPercent as number } : {}),
    ...(num(q.monthlyResetAt) !== undefined ? { monthlyResetAt: q.monthlyResetAt as number } : {}),
    ...(windows.length > 0 ? { customWindows: windows } : {}),
    updatedAt: num(q.updatedAt) ?? report?.updatedAt ?? Date.now(),
  };
  const hasSignal = out.fiveHourPercent !== undefined
    || out.weeklyPercent !== undefined
    || out.monthlyPercent !== undefined
    || (out.customWindows?.length ?? 0) > 0;
  return hasSignal ? out : null;
}

/** Human label for a quota report source id (e.g. "cursor:period-usage"). */
export function formatQuotaSourceLabel(source: string | undefined): string {
  if (!source?.trim()) return "";
  const [provider, path] = source.split(":", 2);
  if (!path) return source;
  return `${provider} · ${path.replace(/-/g, " ").replace(/\+/g, " + ")}`;
}

/**
 * Models-tab list derivation: live models, else configured static ids, else
 * the default model as a single-row fallback; filtered by substring query.
 */
export function filterModels(
  base: string[],
  defaultModel: string | undefined,
  query: string,
  configuredModels: string[] | undefined,
  customModels: string[],
  /**
   * Whether the last successful discovery returned any rows, taken from the server. Required:
   * inferring it by subtracting custom ids from `base` misreads a live catalog as custom-only
   * whenever a custom id also appears upstream, which wrongly keeps the configured fallback
   * authoritative.
   */
  hasLiveModels: boolean,
): string[] {
  const fallback = configuredModels && configuredModels.length > 0
    ? configuredModels
    : defaultModel ? [defaultModel] : [];
  const primary = hasLiveModels ? base : fallback;
  const list = [...new Set([...primary, ...customModels])];
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(id => id.toLowerCase().includes(q));
}

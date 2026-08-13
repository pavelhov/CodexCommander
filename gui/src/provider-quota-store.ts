/**
 * Domain store for GET /api/provider-quotas.
 *
 * Keyed by apiBase and shared by the Providers workspace shell and the Dashboard
 * "Plan & quota" section, so both surfaces dedupe into one in-flight fetch and
 * share the same last-known-good data. The shell's quotaRefreshEpoch /
 * quotaForceRefresh semantics map to a refresh({ force }) action (force adds the
 * server-side ?refresh=1 TTL bypass).
 *
 * Privacy invariant: only quota reports (provider/label/source/quota/updatedAt +
 * aggregation) and a timestamp are persisted — never account emails or ids. The
 * wire shape from src/providers/quota.ts already avoids identities; this store
 * does not add any.
 */

import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { useCallback } from "react";
import {
  capacityAggregationFromReport,
  type ProviderQuotaReportView,
} from "./provider-workspace/report";

export const PROVIDER_QUOTA_STORAGE_NAME = "ccx.provider-quotas.v1";
/** Same freshness bound the workspace shell applied to its session cache. */
const QUOTA_REPORT_MAX_AGE_MS = 30 * 60_000;

export interface ProviderQuotaData {
  reports: Record<string, ProviderQuotaReportView>;
  authAttention: Record<string, boolean>;
  updatedAt?: number;
}

export interface ProviderQuotaEntry extends ProviderQuotaData {
  loading: boolean;
  refreshing: boolean;
  hasSucceeded: boolean;
  lastAttemptOk: boolean;
  error?: unknown;
  /** True for a rehydrated seed: the first subscriber must quiet-revalidate. */
  seedNeedsRevalidate: boolean;
}

export type ProviderQuotaResource = ProviderQuotaData & {
  key: string;
  error: unknown;
  loading: boolean;
  refreshing: boolean;
  hasSucceeded: boolean;
  lastAttemptOk: boolean;
  ensure: (opts?: { force?: boolean }) => void;
  refresh: (opts?: { force?: boolean }) => void;
};

/** The persisted slice — quota reports + timestamp only. */
interface PersistedQuotaSlice {
  entries: Record<string, { reports: Record<string, ProviderQuotaReportView>; updatedAt: number }>;
}

interface ProviderQuotaStoreState {
  entries: Record<string, ProviderQuotaEntry>;
  /** One in-flight controller per apiBase; singleflight + cancellation. */
  inflight: Record<string, AbortController | null>;
  ensure: (apiBase: string, opts?: { force?: boolean }) => void;
  refresh: (apiBase: string, opts?: { force?: boolean }) => void;
  clearForTests: () => void;
}

/**
 * Per-row ingest validation: keep a report row when it is fresh (updatedAt within
 * QUOTA_REPORT_MAX_AGE_MS), has a quota object, and carries no malformed optional
 * fields. Deep shape validation is left to the consumers' parsers
 * (capacityAggregationFromReport / accountQuotaFromReport / referenceQuotaFromReport),
 * which return null for unusable payloads.
 */
function quotaReportFromRow(value: unknown, now: number): ProviderQuotaReportView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) return null;
  if (now - row.updatedAt >= QUOTA_REPORT_MAX_AGE_MS) return null;
  if (!row.quota || typeof row.quota !== "object" || Array.isArray(row.quota)) return null;
  if (row.label !== undefined && typeof row.label !== "string") return null;
  if (row.source !== undefined && typeof row.source !== "string") return null;
  return {
    ...(typeof row.label === "string" ? { label: row.label } : {}),
    ...(typeof row.source === "string" ? { source: row.source } : {}),
    updatedAt: row.updatedAt,
    quota: row.quota,
    // ProviderQuotaReportView declares aggregation as required; consumers treat
    // undefined as "no capacity aggregation" (capacityAggregationFromReport returns
    // null), so reference-window-only reports stay representable.
    aggregation: "aggregation" in row ? row.aggregation : undefined,
  };
}

/** Strict display filter matching the workspace shell's prior session-cache behavior. */
export function freshQuotaReport(value: unknown, now: number): ProviderQuotaReportView | null {
  const report = quotaReportFromRow(value, now);
  if (!report || report.aggregation === undefined) return null;
  return capacityAggregationFromReport(report) ? report : null;
}

export function freshQuotaReportRecord(value: unknown, now = Date.now()): Record<string, ProviderQuotaReportView> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, ProviderQuotaReportView> = {};
  for (const [provider, raw] of Object.entries(value)) {
    const report = freshQuotaReport(raw, now);
    if (provider.trim() && report) out[provider] = report;
  }
  return out;
}

function freshQuotaReportsFromResponse(value: unknown, now = Date.now()): Record<string, ProviderQuotaReportView> {
  if (!Array.isArray(value)) return {};
  const out: Record<string, ProviderQuotaReportView> = {};
  for (const raw of value) {
    const row = raw as Record<string, unknown> | null;
    const provider = row?.provider;
    const report = row ? quotaReportFromRow(row, now) : null;
    if (typeof provider === "string" && provider.trim() && report) out[provider] = report;
  }
  return out;
}

/**
 * The quota endpoint may discover an auth problem after the account list was read.
 * Project only fixed, privacy-safe reason codes so an open surface cannot keep
 * saying Connected until its next account refresh.
 */
export function quotaAuthAttentionFromResponse(value: unknown): Record<string, boolean> {
  if (!Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.provider !== "string" || !row.provider.trim()) continue;
    if (row.reason === "reauth_required" || row.reason === "local_cli_refresh_required") {
      out[row.provider] = true;
    }
  }
  return out;
}

const sessionStorageLazy: PersistStorage<PersistedQuotaSlice> = {
  getItem: (name) => {
    try {
      const raw = sessionStorage.getItem(name);
      if (!raw) return null;
      return JSON.parse(raw) as StorageValue<PersistedQuotaSlice>;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      sessionStorage.setItem(name, JSON.stringify(value));
    } catch {
      /* private mode / no sessionStorage in this runtime */
    }
  },
  removeItem: (name) => {
    try {
      sessionStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

function emptyEntry(): ProviderQuotaEntry {
  return {
    reports: {},
    authAttention: {},
    loading: false,
    refreshing: false,
    hasSucceeded: false,
    lastAttemptOk: false,
    seedNeedsRevalidate: false,
  };
}

function fetchQuotas(
  set: (partial: Partial<ProviderQuotaStoreState> | ((state: ProviderQuotaStoreState) => Partial<ProviderQuotaStoreState>)) => void,
  get: () => ProviderQuotaStoreState,
  apiBase: string,
  options?: { force?: boolean; replace?: boolean },
): void {
  const key = apiBase;
  const inflight = get().inflight[key];
  // Singleflight: concurrent subscribers dedupe onto the in-flight request.
  if (inflight && options?.replace !== true) return;
  inflight?.abort();
  const controller = new AbortController();
  set(state => {
    const existing = state.entries[key];
    return {
      inflight: { ...state.inflight, [key]: controller },
      entries: {
        ...state.entries,
        [key]: {
          ...(existing ?? emptyEntry()),
          loading: existing?.reports === undefined || Object.keys(existing.reports).length === 0
            ? true
            : false,
          refreshing: true,
          error: undefined,
          seedNeedsRevalidate: false,
        },
      },
    };
  });

  void (async () => {
    try {
      const response = await fetch(`${apiBase}/api/provider-quotas${options?.force ? "?refresh=1" : ""}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
      const data = (await response.json()) as { reports?: unknown; availability?: unknown } | null;
      if (get().inflight[key] !== controller) return;
      const reports = freshQuotaReportsFromResponse(data?.reports);
      const authAttention = quotaAuthAttentionFromResponse(data?.availability);
      set(state => ({
        inflight: { ...state.inflight, [key]: null },
        entries: {
          ...state.entries,
          [key]: {
            reports,
            authAttention,
            updatedAt: Date.now(),
            error: undefined,
            loading: false,
            refreshing: false,
            hasSucceeded: true,
            lastAttemptOk: true,
            seedNeedsRevalidate: false,
          },
        },
      }));
    } catch (error) {
      if (controller.signal.aborted || get().inflight[key] !== controller) return;
      set(state => ({
        inflight: { ...state.inflight, [key]: null },
        entries: {
          ...state.entries,
          [key]: {
            ...(state.entries[key] ?? emptyEntry()),
            error: error === undefined ? new Error("provider quota load failed") : error,
            loading: false,
            refreshing: false,
            lastAttemptOk: false,
          },
        },
      }));
    }
  })();
}

export const useProviderQuotaStore = create<ProviderQuotaStoreState>()(
  persist(
    (set, get) => ({
      entries: {},
      inflight: {},
      ensure: (apiBase, opts) => {
        const key = apiBase;
        if (get().inflight[key] && opts?.force !== true) return;
        const entry = get().entries[key];
        // Cold start, rehydrated seed, or a previously cold-failed key: fetch
        // (quiet for a seed, cold otherwise). Singleflight dedupes subscribers.
        if (!entry || entry.seedNeedsRevalidate || !entry.hasSucceeded) {
          fetchQuotas(set, get, apiBase, { force: opts?.force, replace: opts?.force === true });
          return;
        }
        // Healthy cached data — nothing to do.
      },
      refresh: (apiBase, opts) => {
        fetchQuotas(set, get, apiBase, { ...opts, replace: true });
      },
      clearForTests: () => {
        for (const controller of Object.values(get().inflight)) controller?.abort();
        set({ entries: {}, inflight: {} });
      },
    }),
    {
      name: PROVIDER_QUOTA_STORAGE_NAME,
      storage: sessionStorageLazy,
      partialize: (state): PersistedQuotaSlice => ({
        entries: Object.fromEntries(
          Object.entries(state.entries)
            .filter(([, entry]) => entry.updatedAt !== undefined && Object.keys(entry.reports).length > 0)
            .map(([key, entry]) => [
              key,
              { reports: entry.reports, updatedAt: entry.updatedAt as number },
            ]),
        ),
      }),
      merge: (persisted, current) => {
        const persistedEntries =
          (persisted as Partial<PersistedQuotaSlice> | undefined)?.entries ?? {};
        const now = Date.now();
        const entries: Record<string, ProviderQuotaEntry> = { ...current.entries };
        for (const [key, value] of Object.entries(persistedEntries)) {
          if (!value || !value.reports) continue;
          const freshReports = freshQuotaReportRecord(value.reports, now) ?? {};
          if (Object.keys(freshReports).length === 0) continue;
          entries[key] = {
            ...(entries[key] ?? emptyEntry()),
            reports: freshReports,
            updatedAt: value.updatedAt,
            seedNeedsRevalidate: true,
          };
        }
        return { ...current, entries };
      },
    },
  ),
);

/**
 * Select the provider-quota entry for an apiBase. The caller decides when to fetch:
 * `ensure` starts a cold/quiet fetch (singleflight), `refresh` always re-fetches and
 * replaces any in-flight request (used for quotaRefreshEpoch/quotaForceRefresh).
 */
export function useProviderQuota(apiBase: string): ProviderQuotaResource {
  const key = apiBase;
  const entry = useProviderQuotaStore(state => state.entries[key]);
  const ensureAction = useProviderQuotaStore(state => state.ensure);
  const refreshAction = useProviderQuotaStore(state => state.refresh);

  const ensure = useCallback(
    (opts?: { force?: boolean }) => ensureAction(key, opts),
    [key, ensureAction],
  );
  const refresh = useCallback(
    (opts?: { force?: boolean }) => refreshAction(key, opts),
    [key, refreshAction],
  );

  return {
    key,
    reports: entry?.reports ?? {},
    authAttention: entry?.authAttention ?? {},
    updatedAt: entry?.updatedAt,
    error: entry?.error,
    loading: entry?.loading ?? false,
    refreshing: entry?.refreshing ?? false,
    hasSucceeded: entry?.hasSucceeded ?? false,
    lastAttemptOk: entry?.lastAttemptOk ?? false,
    ensure,
    refresh,
  };
}

/** Test-only: drop every entry and abort in-flight work so suite order cannot reuse data. */
export function clearProviderQuotaStoresForTests(): void {
  useProviderQuotaStore.getState().clearForTests();
}

/** Test-only: seed an entry as if it were rehydrated from sessionStorage. */
export function seedProviderQuotaForTests(
  apiBase: string,
  data: { reports: Record<string, ProviderQuotaReportView>; updatedAt: number },
): void {
  useProviderQuotaStore.setState(state => ({
    entries: {
      ...state.entries,
      [apiBase]: {
        ...emptyEntry(),
        reports: data.reports,
        updatedAt: data.updatedAt,
        seedNeedsRevalidate: true,
      },
    },
  }));
}

/** Test-only: re-run persist rehydration against the current sessionStorage. */
export function rehydrateProviderQuotaForTests(): void {
  void useProviderQuotaStore.persist.rehydrate();
}

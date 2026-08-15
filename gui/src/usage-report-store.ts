/**
 * Domain store for GET /api/usage reports.
 *
 * Replaces the Usage page's private memory cache and the dashboard's usage poll
 * with one keyed store shared by every surface: Usage page and Dashboard select
 * the same entry for `${apiBase}:30d:all`, so concurrent subscribers dedupe into
 * a single in-flight fetch (singleflight) and share the same AbortController
 * cancellation semantics as `client-resource`.
 *
 * Persistence: zustand `persist` with sessionStorage stores ONLY validated
 * successful reports plus a timestamp — never errors, never in-flight state.
 * On rehydrate, seeded entries are marked `seedNeedsRevalidate` so the first
 * subscriber quiet-revalidates instead of trusting the seed forever.
 */

import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { useCallback, useEffect } from "react";
import {
  parseUsageReport,
  type UsageRange,
  type UsageReport,
  type UsageSurface,
} from "./usage-report-validation";

export type UsageReportResource = {
  key: string;
  data: UsageReport | undefined;
  error: unknown;
  loading: boolean;
  refreshing: boolean;
  hasSucceeded: boolean;
  lastAttemptOk: boolean;
  refresh: (opts?: { forceLoading?: boolean; replace?: boolean }) => void;
};

export interface UsageReportEntry {
  data?: UsageReport;
  error?: unknown;
  loading: boolean;
  refreshing: boolean;
  hasSucceeded: boolean;
  lastAttemptOk: boolean;
  /** Epoch ms when the report was persisted. */
  persistedAt?: number;
  /** True for a rehydrated seed: the first subscriber must quiet-revalidate. */
  seedNeedsRevalidate: boolean;
}

/** The persisted slice — validated reports + timestamp only. */
interface PersistedUsageSlice {
  entries: Record<string, { data: UsageReport; persistedAt: number }>;
}

interface UsageReportStoreState {
  entries: Record<string, UsageReportEntry>;
  /** One in-flight controller per key; singleflight + cancellation. */
  inflight: Record<string, AbortController | null>;
  ensure: (key: string, apiBase: string, range: UsageRange, surface: UsageSurface) => void;
  refresh: (
    key: string,
    apiBase: string,
    range: UsageRange,
    surface: UsageSurface,
    opts?: { forceLoading?: boolean; replace?: boolean },
  ) => void;
  clearForTests: () => void;
}

export const USAGE_REPORT_STORAGE_NAME = "ccx.usage-reports.v1";

/**
 * sessionStorage resolved lazily at each call instead of captured at module load:
 * GUI tests install the happy-dom sessionStorage per file/per test, and the store
 * must read whatever storage is current when a read/write happens.
 */
const sessionStorageLazy: PersistStorage<PersistedUsageSlice> = {
  getItem: (name) => {
    try {
      const raw = sessionStorage.getItem(name);
      if (!raw) return null;
      return JSON.parse(raw) as StorageValue<PersistedUsageSlice>;
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

export function usageReportKey(apiBase: string, range: UsageRange, surface: UsageSurface): string {
  return `${apiBase}:${range}:${surface}`;
}

function emptyEntry(): UsageReportEntry {
  return {
    loading: false,
    refreshing: false,
    hasSucceeded: false,
    lastAttemptOk: false,
    seedNeedsRevalidate: false,
  };
}

function fetchReport(
  set: (partial: Partial<UsageReportStoreState> | ((state: UsageReportStoreState) => Partial<UsageReportStoreState>)) => void,
  get: () => UsageReportStoreState,
  key: string,
  apiBase: string,
  range: UsageRange,
  surface: UsageSurface,
  options?: { forceLoading?: boolean; replace?: boolean },
): void {
  const inflight = get().inflight[key];
  // Singleflight: concurrent subscribers dedupe onto the in-flight request.
  if (inflight && options?.replace !== true) return;
  // Remember whether this request was a quiet revalidation of a rehydrated seed so a
  // failed revalidation can restore the retry flag for the next subscriber.
  const existingEntry = get().entries[key];
  const wasSeed = existingEntry?.seedNeedsRevalidate === true && existingEntry.data !== undefined;
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
          loading: options?.forceLoading === true || existing?.data === undefined,
          refreshing: true,
          error: undefined,
          seedNeedsRevalidate: false,
        },
      },
    };
  });

  void (async () => {
    try {
      const response = await fetch(`${apiBase}/api/usage?range=${range}&surface=${surface}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
      const data = parseUsageReport(await response.json());
      if (get().inflight[key] !== controller) return;
      set(state => ({
        inflight: { ...state.inflight, [key]: null },
        entries: {
          ...state.entries,
          [key]: {
            data,
            error: undefined,
            loading: false,
            refreshing: false,
            hasSucceeded: true,
            lastAttemptOk: true,
            persistedAt: Date.now(),
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
            error: error === undefined ? new Error("usage report load failed") : error,
            loading: false,
            refreshing: false,
            lastAttemptOk: false,
            // A failed revalidation of a rehydrated seed keeps the seed as last-known-good
            // (hasSucceeded) and re-arms the quiet retry for the next subscriber.
            hasSucceeded: state.entries[key]?.hasSucceeded === true || wasSeed,
            seedNeedsRevalidate: wasSeed,
          },
        },
      }));
    }
  })();
}

export const useUsageReportStore = create<UsageReportStoreState>()(
  persist(
    (set, get) => ({
      entries: {},
      inflight: {},
      ensure: (key, apiBase, range, surface) => {
        if (get().inflight[key]) return;
        const entry = get().entries[key];
        if (!entry) {
          fetchReport(set, get, key, apiBase, range, surface, { forceLoading: true });
          return;
        }
        if (entry.seedNeedsRevalidate) {
          // Quiet revalidation of a rehydrated seed: keep the seed visible, no skeleton.
          fetchReport(set, get, key, apiBase, range, surface, {});
          return;
        }
        if (entry.data === undefined && !entry.hasSucceeded) {
          // A previously cold-failed key retries on the next subscriber.
          fetchReport(set, get, key, apiBase, range, surface, { forceLoading: true });
          return;
        }
        // Healthy cached data — nothing to do.
      },
      refresh: (key, apiBase, range, surface, opts) => {
        fetchReport(set, get, key, apiBase, range, surface, { ...opts, replace: opts?.replace !== false });
      },
      clearForTests: () => {
        for (const controller of Object.values(get().inflight)) controller?.abort();
        set({ entries: {}, inflight: {} });
      },
    }),
    {
      name: USAGE_REPORT_STORAGE_NAME,
      storage: sessionStorageLazy,
      partialize: (state): PersistedUsageSlice => ({
        entries: Object.fromEntries(
          Object.entries(state.entries)
            .filter(([, entry]) => entry.data !== undefined)
            .map(([key, entry]) => [
              key,
              { data: entry.data as UsageReport, persistedAt: entry.persistedAt ?? Date.now() },
            ]),
        ),
      }),
      merge: (persisted, current) => {
        const persistedEntries =
          (persisted as Partial<PersistedUsageSlice> | undefined)?.entries ?? {};
        const entries: Record<string, UsageReportEntry> = { ...current.entries };
        for (const [key, value] of Object.entries(persistedEntries)) {
          if (value && value.data !== undefined) {
            entries[key] = {
              ...(entries[key] ?? emptyEntry()),
              data: value.data,
              persistedAt: value.persistedAt,
              seedNeedsRevalidate: true,
              // A rehydrated seed is last-known-good data: it reads as succeeded so the
              // UI does not mistake "showing a seed" for "never succeeded".
              hasSucceeded: true,
            };
          }
        }
        return { ...current, entries };
      },
    },
  ),
);

/**
 * Select a usage report and keep it fresh. The key derives from
 * apiBase/range/surface, so the Usage page's 30d/all and the Dashboard's 30d/all
 * share one store entry and one in-flight fetch.
 */
export function useUsageReport(
  apiBase: string,
  range: UsageRange,
  surface: UsageSurface,
): UsageReportResource {
  const key = usageReportKey(apiBase, range, surface);
  const entry = useUsageReportStore(state => state.entries[key]);
  const ensure = useUsageReportStore(state => state.ensure);
  const refreshAction = useUsageReportStore(state => state.refresh);

  useEffect(() => {
    ensure(key, apiBase, range, surface);
  }, [key, apiBase, range, surface, ensure]);

  const refresh = useCallback(
    (opts?: { forceLoading?: boolean; replace?: boolean }) => {
      refreshAction(key, apiBase, range, surface, opts);
    },
    [key, apiBase, range, surface, refreshAction],
  );

  return {
    key,
    data: entry?.data,
    error: entry?.error,
    loading: entry?.loading ?? false,
    refreshing: entry?.refreshing ?? false,
    hasSucceeded: entry?.hasSucceeded ?? false,
    lastAttemptOk: entry?.lastAttemptOk ?? false,
    refresh,
  };
}

/** Test-only: drop every entry and abort in-flight work so suite order cannot reuse data. */
export function clearUsageReportStoresForTests(): void {
  useUsageReportStore.getState().clearForTests();
}

/** Test-only: seed an entry as if it were rehydrated from sessionStorage. */
export function seedUsageReportForTests(key: string, data: UsageReport, persistedAt = Date.now()): void {
  useUsageReportStore.setState(state => ({
    entries: {
      ...state.entries,
      [key]: { ...emptyEntry(), data, persistedAt, seedNeedsRevalidate: true, hasSucceeded: true },
    },
  }));
}

/** Test-only: re-run persist rehydration against the current sessionStorage. */
export function rehydrateUsageReportForTests(): void {
  void useUsageReportStore.persist.rehydrate();
}

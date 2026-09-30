import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearModelCache,
  evictOldestModelCacheForBudget,
  getFreshCached,
  getProviderDiscoveryStatus,
  getProviderLiveModelCount,
  getStaleCached,
  invalidateModelCacheFreshness,
  isModelsFetchCoolingDown,
  markModelsFetchFailure,
  markProviderDiscoveryFailed,
  markProviderDiscoveryOk,
  modelCacheRetainedStoreSnapshot,
  setCached,
} from "../src/codex/model-cache";

beforeEach(() => clearModelCache());
afterEach(() => clearModelCache());

describe("provider model cache explicit refresh", () => {
  test("invalidates only the requested freshness and cooldown while preserving fallback provenance", () => {
    const models = [{ provider: "first", id: "vendor/model-🙂" }];
    setCached("first", models, 10);
    setCached("second", [{ provider: "second", id: "other" }], 20);
    markProviderDiscoveryOk("first", 1);
    markProviderDiscoveryFailed("first", { reason: "network" });
    markModelsFetchFailure("first", 25);
    markModelsFetchFailure("second", 25);
    const retainedBefore = modelCacheRetainedStoreSnapshot();

    invalidateModelCacheFreshness("first");

    expect(getFreshCached("first", 100, 30)).toBeNull();
    expect(getStaleCached("first")).toBe(models);
    expect(getProviderLiveModelCount("first")).toBe(1);
    expect(getProviderDiscoveryStatus("first")).toEqual({ status: "failed", reason: "network" });
    expect(isModelsFetchCoolingDown("first", 100, 30)).toBe(false);
    expect(getFreshCached("second", 100, 30)).not.toBeNull();
    expect(isModelsFetchCoolingDown("second", 100, 30)).toBe(true);
    expect(modelCacheRetainedStoreSnapshot()).toEqual(retainedBefore);

    setCached("first", models, 40);
    expect(getFreshCached("first", 100, 50)).toBe(models);
  });

  test("global invalidation preserves byte accounting and original oldest eviction order", () => {
    // Insert the newer entry first to catch accidental Map-order eviction after invalidation.
    const newer = [{ provider: "newer", id: "new-model" }];
    const older = [{ provider: "older", id: "old-model-🙂" }];
    setCached("newer", newer, 20);
    setCached("older", older, 10);
    markProviderDiscoveryOk("older", 1);
    markProviderDiscoveryOk("newer", 1);
    markModelsFetchFailure("older", 25);
    markModelsFetchFailure("uncached", 25);
    const before = modelCacheRetainedStoreSnapshot();
    const olderBytes = new TextEncoder().encode("older").byteLength
      + new TextEncoder().encode(JSON.stringify(older)).byteLength;

    invalidateModelCacheFreshness();

    expect(getFreshCached("older", 100, 30)).toBeNull();
    expect(getFreshCached("newer", 100, 30)).toBeNull();
    expect(getStaleCached("older")).toBe(older);
    expect(getStaleCached("newer")).toBe(newer);
    expect(getProviderDiscoveryStatus("older")).toEqual({ status: "ok" });
    expect(getProviderLiveModelCount("older")).toBe(1);
    expect(getProviderLiveModelCount("newer")).toBe(1);
    expect(isModelsFetchCoolingDown("older", 100, 30)).toBe(false);
    expect(isModelsFetchCoolingDown("uncached", 100, 30)).toBe(false);
    expect(modelCacheRetainedStoreSnapshot()).toEqual(before);
    expect(evictOldestModelCacheForBudget()).toBe(olderBytes);
    expect(getStaleCached("older")).toBeNull();
    expect(getStaleCached("newer")).toBe(newer);
    expect(modelCacheRetainedStoreSnapshot()).toMatchObject({ count: 1, bytes: before.bytes - olderBytes, oldestAt: 20 });
  });

  test("actual cache removal still clears rows, provenance, and failure cooldown", () => {
    setCached("removed", [{ provider: "removed", id: "model" }], 10);
    markProviderDiscoveryOk("removed", 1);
    markModelsFetchFailure("removed", 25);
    invalidateModelCacheFreshness("removed");

    clearModelCache("removed");

    expect(getStaleCached("removed")).toBeNull();
    expect(getProviderLiveModelCount("removed")).toBeUndefined();
    expect(getProviderDiscoveryStatus("removed")).toBeUndefined();
    expect(isModelsFetchCoolingDown("removed", 100, 30)).toBe(false);
    expect(modelCacheRetainedStoreSnapshot()).toMatchObject({ count: 0, bytes: 0, oldestAt: null });
  });
});

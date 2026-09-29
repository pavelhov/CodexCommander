import { describe, expect, test } from "bun:test";
import { accountQuotaFromReport, formatQuotaSourceLabel, referenceQuotaFromReport } from "../src/provider-workspace/report";

const currentAggregation = () => ({
  kind: "capacity-weighted-v1",
  scope: "routable-known",
  presentation: "coverage-only",
  incomplete: false,
  excludedAccounts: 0,
  unknownPlanAccounts: 0,
  partialWindowAccounts: 0,
});

describe("OpenCode Go reference quota reports", () => {
  const report = {
    source: "opencode-go:published-caps-2026-08-05+local-estimate",
    aggregation: currentAggregation(),
    quota: {
      referenceWindows: [{
        id: "five_hour",
        label: "5-hour",
        windowSeconds: 18_000,
        publishedLimitUsd: 12,
        observedSpendUsd: 1.25,
        observedTokens: 42_000,
        observedRequests: 3,
        pricedRequests: 2,
        unpricedRequests: 1,
        unmeasuredRequests: 0,
        coverage: "partial",
      }],
      observedLimitEvent: {
        limitName: "5 hour",
        observedAt: 1_700_000_000_000,
        resetAt: 1_700_018_000_000,
      },
      updatedAt: 1_700_000_000_000,
    },
  };

  test("ignores stale legacy caps and keeps observations distinct from percentage quota bars", () => {
    expect(accountQuotaFromReport(report)).toBeNull();
    expect(referenceQuotaFromReport(report)).toEqual({
      windows: [expect.objectContaining({
        id: "five_hour",
        observedSpendUsd: 1.25,
        coverage: "partial",
      })],
      observedLimitEvent: {
        limitName: "5 hour",
        observedAt: 1_700_000_000_000,
        resetAt: 1_700_018_000_000,
      },
    });
    expect(referenceQuotaFromReport(report)?.windows[0]).not.toHaveProperty("publishedLimitUsd");
    expect(formatQuotaSourceLabel(report.source)).toBe("opencode-go · local observations");
  });

  test("accepts local observation rows without a published cap", () => {
    const { publishedLimitUsd: _legacyCap, ...currentWindow } = report.quota.referenceWindows[0];
    const parsed = referenceQuotaFromReport({
      source: "opencode-go:local-observations",
      aggregation: currentAggregation(),
      quota: { referenceWindows: [currentWindow] },
    });
    expect(parsed?.windows[0]).toEqual(expect.objectContaining({
      id: "five_hour",
      observedSpendUsd: 1.25,
      observedTokens: 42_000,
      observedRequests: 3,
    }));
  });

  test("adapts live Go usage windows to the same quota bars as Codex", () => {
    const quota = accountQuotaFromReport({
      source: "opencode-go:usage-api",
      aggregation: null,
      quota: {
        fiveHourPercent: 12.5,
        fiveHourResetAt: 1_780_000_000_000,
        weeklyPercent: 40,
        weeklyResetAt: 1_780_100_000_000,
        monthlyPercent: 65,
        monthlyResetAt: 1_780_200_000_000,
        updatedAt: 1_779_900_000_000,
      },
    });
    expect(quota).toEqual(expect.objectContaining({
      fiveHourPercent: 12.5,
      weeklyPercent: 40,
      monthlyPercent: 65,
    }));
  });

  test("drops malformed rows instead of inventing values", () => {
    expect(referenceQuotaFromReport({ aggregation: currentAggregation(), quota: { referenceWindows: [{
      id: "five_hour",
      label: "5-hour",
      windowSeconds: 18_000,
      coverage: "complete",
    }] } })).toBeNull();
  });

  test("drops an out-of-range reset timestamp before it reaches Intl formatting", () => {
    const parsed = referenceQuotaFromReport({
      aggregation: currentAggregation(),
      quota: {
        referenceWindows: report.quota.referenceWindows,
        observedLimitEvent: {
          limitName: "weekly",
          observedAt: 1_700_000_000_000,
          resetAt: Number.MAX_VALUE,
        },
      },
    });

    expect(parsed?.observedLimitEvent).toEqual({
      limitName: "weekly",
      observedAt: 1_700_000_000_000,
    });
  });

  test("degrades inconsistent complete coverage instead of overstating an estimate", () => {
    const inconsistent = {
      ...report.quota.referenceWindows[0],
      coverage: "complete",
      observedRequests: 3,
      pricedRequests: 2,
      unpricedRequests: 1,
    };
    const parsed = referenceQuotaFromReport({ aggregation: currentAggregation(), quota: { referenceWindows: [inconsistent] } });
    expect(parsed?.windows[0]?.coverage).toBe("partial");
  });
});

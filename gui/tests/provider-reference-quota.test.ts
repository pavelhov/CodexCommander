import { describe, expect, test } from "bun:test";
import { accountQuotaFromReport, referenceQuotaFromReport } from "../src/provider-workspace/report";

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

  test("keeps published caps and observations distinct from percentage quota bars", () => {
    expect(accountQuotaFromReport(report)).toBeNull();
    expect(referenceQuotaFromReport(report)).toEqual({
      windows: [expect.objectContaining({
        id: "five_hour",
        publishedLimitUsd: 12,
        observedSpendUsd: 1.25,
        coverage: "partial",
      })],
      observedLimitEvent: {
        limitName: "5 hour",
        observedAt: 1_700_000_000_000,
        resetAt: 1_700_018_000_000,
      },
    });
  });

  test("drops malformed rows instead of inventing values", () => {
    expect(referenceQuotaFromReport({ aggregation: currentAggregation(), quota: { referenceWindows: [{
      id: "five_hour",
      label: "5-hour",
      windowSeconds: 18_000,
      publishedLimitUsd: -12,
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

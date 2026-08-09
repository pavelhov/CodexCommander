import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendUsageEntry, resetUsageReadCacheForTests } from "../src/usage/log";
import { clearProviderQuotaCache, fetchProviderQuotaReports, openCodeGoReferenceWindowsForTest } from "../src/providers/quota";
import type { CodexCommanderConfig } from "../src/types";

function config(baseUrl = "https://opencode.ai/zen/go/v1"): CodexCommanderConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl,
        authMode: "key",
        apiKey: "go-key",
      },
    },
  } as CodexCommanderConfig;
}

describe("OpenCode Go published caps and local observations", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccx-go-quota-"));
    previousHome = process.env.CODEXCOMMANDER_HOME;
    process.env.CODEXCOMMANDER_HOME = root;
    clearProviderQuotaCache();
    resetUsageReadCacheForTests();
  });

  afterEach(() => {
    clearProviderQuotaCache();
    resetUsageReadCacheForTests();
    if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  test("shows official reference caps without inventing remaining percentages", async () => {
    const response = await fetchProviderQuotaReports(config(), true);
    const report = response.reports.find(row => row.provider === "opencode-go");
    expect(report).toBeDefined();
    expect(report!.quota.fiveHourPercent).toBeUndefined();
    expect(report!.quota.weeklyPercent).toBeUndefined();
    expect(report!.quota.monthlyPercent).toBeUndefined();
    expect(report!.quota.referenceWindows?.map(row => [row.id, row.publishedLimitUsd])).toEqual([
      ["five_hour", 12],
      ["weekly", 30],
      ["monthly", 60],
    ]);
    expect(report!.quota.referenceWindows?.every(row => row.coverage === "none")).toBe(true);
  });

  test("labels locally measured spend as partial when any model is unpriced", async () => {
    const now = Date.now();
    appendUsageEntry({
      requestId: "priced",
      timestamp: now - 60_000,
      provider: "opencode-go",
      model: "minimax-m2.5",
      status: 200,
      durationMs: 100,
      usageStatus: "reported",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      totalTokens: 1_000_000,
    });
    appendUsageEntry({
      requestId: "unpriced",
      timestamp: now - 30_000,
      provider: "opencode-go",
      model: "unknown-live-model",
      status: 200,
      durationMs: 100,
      usageStatus: "reported",
      usage: { inputTokens: 100, outputTokens: 20 },
      totalTokens: 120,
    });
    appendUsageEntry({
      requestId: "unmeasured",
      timestamp: now - 10_000,
      provider: "opencode-go",
      model: "unknown-live-model",
      status: 502,
      durationMs: 100,
      usageStatus: "unreported",
    });

    const report = (await fetchProviderQuotaReports(config(), true)).reports[0]!;
    const fiveHour = report.quota.referenceWindows?.find(row => row.id === "five_hour")!;
    expect(fiveHour.observedSpendUsd).toBeCloseTo(0.3, 8);
    expect(fiveHour.observedTokens).toBe(1_000_120);
    expect(fiveHour.observedRequests).toBe(3);
    expect(fiveHour.pricedRequests).toBe(1);
    expect(fiveHour.unpricedRequests).toBe(1);
    expect(fiveHour.unmeasuredRequests).toBe(1);
    expect(fiveHour.coverage).toBe("partial");
  });

  test("degrades windows whose retained usage history starts inside the cap period", () => {
    const now = Date.now();
    const recent: Parameters<typeof openCodeGoReferenceWindowsForTest>[0] = [{
      requestId: "recent-only",
      timestamp: now - 60_000,
      provider: "opencode-go",
      model: "minimax-m2.5",
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      usage: { inputTokens: 1_000, outputTokens: 10 },
      totalTokens: 1_010,
    }];
    const truncated = openCodeGoReferenceWindowsForTest(recent, now, true);
    expect(truncated.every(window => window.coverage === "partial")).toBe(true);

    const retainedBeforeEveryWindow = openCodeGoReferenceWindowsForTest([{
      ...recent[0]!,
      requestId: "old-retained-row",
      timestamp: now - 31 * 24 * 60 * 60 * 1000,
    }, ...recent], now, true);
    expect(retainedBeforeEveryWindow.find(window => window.id === "monthly")?.coverage).toBe("complete");
  });

  test("surfaces an observed upstream limit event and Retry-After reset", async () => {
    const observedAt = Date.now() - 1_000;
    appendUsageEntry({
      requestId: "limit-event",
      timestamp: observedAt,
      provider: "opencode-go",
      model: "gpt-5.6-luna",
      status: 429,
      durationMs: 200,
      usageStatus: "unreported",
      errorCode: "rate_limit_exceeded",
      upstreamError: 'GoUsageLimitError metadata={"limitName":"weekly"}',
      upstreamRetryAfter: "3600",
    });

    const report = (await fetchProviderQuotaReports(config(), true)).reports[0]!;
    expect(report.quota.observedLimitEvent?.limitName).toBe("weekly");
    expect(report.quota.observedLimitEvent?.observedAt).toBe(observedAt + 200);
    expect(report.quota.observedLimitEvent?.resetAt).toBe(observedAt + 200 + 3_600_000);
  });

  test("does not keep an already-expired zero-second limit event active", async () => {
    appendUsageEntry({
      requestId: "expired-limit-event",
      timestamp: Date.now() - 1_000,
      provider: "opencode-go",
      model: "gpt-5.6-luna",
      status: 429,
      durationMs: 100,
      usageStatus: "unreported",
      upstreamError: 'GoUsageLimitError metadata={"limitName":"5 hour"}',
      upstreamRetryAfter: "0",
    });

    const report = (await fetchProviderQuotaReports(config(), true)).reports[0]!;
    expect(report.quota.observedLimitEvent).toBeUndefined();
  });

  test("never attaches Go subscription facts to a lookalike destination", async () => {
    const response = await fetchProviderQuotaReports(config("https://evil.example/zen/go/v1"), true);
    expect(response.reports.some(row => row.provider === "opencode-go")).toBe(false);
  });
});

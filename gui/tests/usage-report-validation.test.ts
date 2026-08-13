import { expect, test } from "bun:test";
import {
  parseUsageReport,
  UsageReportValidationError,
  type UsageReport,
} from "../src/usage-report-validation";

/** Element-level validation: days/models/providers rows must be well-formed, not cast. */

function validReport(): UsageReport {
  return {
    range: "30d",
    surface: "all",
    since: null,
    generatedAt: 1,
    summary: {
      requests: 3,
      measuredRequests: 3,
      reportedRequests: 3,
      unreportedRequests: 0,
      unsupportedRequests: 0,
      estimatedRequests: 0,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 150,
      coverageRatio: 1,
      estimatedCostUsd: 0.25,
      pricedRequests: 3,
      unpricedRequests: 0,
      unmeteredRequests: 0,
    },
    days: [{
      date: "2026-08-01",
      requests: 3,
      measuredRequests: 3,
      reportedRequests: 3,
      totalTokens: 150,
      models: [{ model: "gpt-5", provider: "openai", requests: 3, totalTokens: 150 }],
    }],
    models: [{
      provider: "openai",
      model: "gpt-5",
      requests: 3,
      measuredRequests: 3,
      reportedRequests: 3,
      estimatedRequests: 0,
      totalTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
      shareRatio: 1,
    }],
    providers: [{
      provider: "openai",
      requests: 3,
      measuredRequests: 3,
      reportedRequests: 3,
      estimatedRequests: 0,
      totalTokens: 150,
      shareRatio: 1,
    }],
    historyTruncated: false,
    truncatedPrefixBytes: 0,
    entriesTruncated: false,
    entriesDropped: 0,
  };
}

function mutate(report: UsageReport, mutate: (draft: Record<string, unknown>) => void): unknown {
  const draft = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  mutate(draft);
  return draft;
}

test("a well-formed report passes element validation", () => {
  const parsed = parseUsageReport(validReport());
  expect(parsed.days).toHaveLength(1);
  expect(parsed.models[0]?.totalTokens).toBe(150);
  expect(parsed.providers[0]?.shareRatio).toBe(1);
});

test("a malformed model row rejects the whole report", () => {
  const body = mutate(validReport(), draft => {
    ((draft.models as Array<Record<string, unknown>>)[0]!).totalTokens = "many";
  });
  expect(() => parseUsageReport(body)).toThrow(UsageReportValidationError);
  expect(() => parseUsageReport(body)).toThrow(/models\[0\]\.totalTokens/);
});

test("a malformed day row rejects the whole report", () => {
  const body = mutate(validReport(), draft => {
    ((draft.days as Array<Record<string, unknown>>)[0]!).requests = null;
  });
  expect(() => parseUsageReport(body)).toThrow(UsageReportValidationError);
  expect(() => parseUsageReport(body)).toThrow(/days\[0\]\.requests/);
});

test("a malformed day-model row rejects the whole report", () => {
  const body = mutate(validReport(), draft => {
    ((draft.days as Array<Record<string, unknown>>)[0]!.models as Array<Record<string, unknown>>)[0]!.provider = 42;
  });
  expect(() => parseUsageReport(body)).toThrow(UsageReportValidationError);
  expect(() => parseUsageReport(body)).toThrow(/day models\[0\]\.provider/);
});

test("a malformed provider row rejects the whole report", () => {
  const body = mutate(validReport(), draft => {
    ((draft.providers as Array<Record<string, unknown>>)[0]!).shareRatio = undefined;
  });
  expect(() => parseUsageReport(body)).toThrow(UsageReportValidationError);
  expect(() => parseUsageReport(body)).toThrow(/providers\[0\]\.shareRatio/);
});

test("a non-array collection rejects the whole report", () => {
  const body = mutate(validReport(), draft => {
    draft.models = "not-an-array";
  });
  expect(() => parseUsageReport(body)).toThrow(UsageReportValidationError);
});

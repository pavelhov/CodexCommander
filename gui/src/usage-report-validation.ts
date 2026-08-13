/**
 * Validation for GET /api/usage reports.
 *
 * The Usage page and the usage-report domain store both consume this contract:
 * only validated successful reports may be cached or persisted. Error envelopes
 * (HTTP-level or body-level `error`) and malformed summaries are rejected here
 * before any cache write, so a transient read failure can never shadow
 * last-known-good data.
 */

export type UsageRange = "all" | "30d" | "7d";
export type UsageSurface = "all" | "codex" | "claude" | "grok";

export interface UsageSummaryTotals {
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
  /** Required in the success DTO — the management API always emits these. */
  estimatedCostUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
  unmeteredRequests: number;
}

export interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  totalTokens: number;
}

export interface UsageDay {
  date: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  totalTokens: number;
  models: UsageDayModel[];
}

export interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

export interface UsageProvider {
  provider: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  shareRatio: number;
}

export interface UsageReport {
  range: UsageRange;
  surface: UsageSurface;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  historyTruncated: boolean;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
}

/** Typed validation failure — callers must not persist the rejected payload. */
export class UsageReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageReportValidationError";
  }
}

const REQUIRED_SUMMARY_FIELDS: (keyof UsageSummaryTotals)[] = [
  "requests",
  "measuredRequests",
  "reportedRequests",
  "unreportedRequests",
  "unsupportedRequests",
  "estimatedRequests",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "coverageRatio",
  "estimatedCostUsd",
  "pricedRequests",
  "unpricedRequests",
  "unmeteredRequests",
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSummary(value: unknown): UsageSummaryTotals {
  if (!isRecord(value)) {
    throw new UsageReportValidationError("usage report summary is not an object");
  }
  for (const key of REQUIRED_SUMMARY_FIELDS) {
    if (!isFiniteNumber(value[key])) {
      throw new UsageReportValidationError(
        `usage report summary field "${key}" is missing or not a finite number`,
      );
    }
  }
  return {
    ...(value as unknown as UsageSummaryTotals),
    cacheReadInputTokens: isFiniteNumber(value.cacheReadInputTokens) ? value.cacheReadInputTokens : undefined,
    cacheCreationInputTokens: isFiniteNumber(value.cacheCreationInputTokens) ? value.cacheCreationInputTokens : undefined,
  };
}

/**
 * Parse and validate a GET /api/usage success body. Throws
 * `UsageReportValidationError` for error envelopes, non-object bodies, invalid
 * range/surface, missing collection fields, and missing or malformed required
 * summary fields. Callers must only persist the returned value.
 */
export function parseUsageReport(body: unknown): UsageReport {
  if (!isRecord(body)) {
    throw new UsageReportValidationError("usage report is not an object");
  }
  if (body.error !== undefined) {
    throw new UsageReportValidationError(`usage report rejected (${String(body.error)})`);
  }
  const range = body.range;
  if (range !== "all" && range !== "30d" && range !== "7d") {
    throw new UsageReportValidationError("usage report range is missing or invalid");
  }
  const surface = body.surface;
  if (surface !== "all" && surface !== "codex" && surface !== "claude" && surface !== "grok") {
    throw new UsageReportValidationError("usage report surface is missing or invalid");
  }
  if (!Array.isArray(body.days) || !Array.isArray(body.models) || !Array.isArray(body.providers)) {
    throw new UsageReportValidationError("usage report days/models/providers must be arrays");
  }
  if (!isFiniteNumber(body.generatedAt)) {
    throw new UsageReportValidationError("usage report generatedAt is missing or not a finite number");
  }
  return {
    range,
    surface,
    since: isFiniteNumber(body.since) ? body.since : null,
    generatedAt: body.generatedAt,
    summary: parseSummary(body.summary),
    days: body.days as UsageDay[],
    models: body.models as UsageModel[],
    providers: body.providers as UsageProvider[],
    historyTruncated: body.historyTruncated === true,
    truncatedPrefixBytes: isFiniteNumber(body.truncatedPrefixBytes) ? body.truncatedPrefixBytes : 0,
    entriesTruncated: body.entriesTruncated === true,
    entriesDropped: isFiniteNumber(body.entriesDropped) ? body.entriesDropped : 0,
  };
}

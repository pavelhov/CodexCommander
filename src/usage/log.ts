import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { usageDisplayTotalTokens } from "./totals";
import type { CodexCommanderUsage } from "../types";
import { normalizeRouteDecisionTrace, type RouteDecisionTraceV1 } from "../routing/trace";

export type UsageStatus = "reported" | "unreported" | "unsupported" | "estimated";
export const USAGE_LOG_SCHEMA_VERSION = 1 as const;
type UsageSurface = "codex" | "claude" | "claude-desktop" | "grok";

/**
 * Recovery kinds recorded per attempt in the usage log; the GUI renders localized labels
 * for these wire values.
 */
export type AttemptRecoveryKind =
  | "transient-5xx"
  | "connection-reset"
  | "oauth-401"
  | "key-429"
  | "rate-limit-429"
  | "anthropic-oauth-429"
  | "image-413";

export interface PersistedUsageAttempt {
  ordinal: number;
  provider: string;
  model: string;
  adapter: string;
  status: number;
  durationMs: number;
  /** TTFT relative to THIS attempt's start (WP4); unset for non-streaming/tool-only. */
  firstOutputMs?: number;
  sendCount: number;
  recoveryKinds: AttemptRecoveryKind[];
  usageStatus: UsageStatus;
  inputTokenEstimate?: number;
  usage?: CodexCommanderUsage;
  totalTokens?: number;
  errorCode?: string;
  /** Target-specific reasoning intent and exact adapter-normalized wire parameter. */
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
}

export interface PersistedUsageEntry {
  requestId: string;
  timestamp: number;
  provider: string;
  model: string;
  /** Explicit client product. Every persisted row carries this; `codex` is not implicit. */
  surface?: UsageSurface;
  /** Matched configured key id; absent for environment/loopback admissions and
   *  for every row written before attribution existed. */
  apiKeyId?: string;
  admissionKind?: "configured" | "environment" | "loopback";
  /** The inbound wire, not the client product — see `surface`. */
  inboundProtocol?: "responses" | "chat" | "messages";
  /** Best-effort chat/session correlation for Logs grouping (#330). */
  conversationId?: string;
  resolvedModel?: string;
  requestedModel?: string;
  /** Reasoning effort / service-tier metadata for GUI Logs after restart. */
  requestedEffort?: string;
  /** Adapter-normalized tier and exact upstream parameter emitted for this request. */
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  status: number;
  durationMs: number;
  /** TTFT relative to the request start (WP4); unset for non-streaming/tool-only. */
  firstOutputMs?: number;
  usageStatus: UsageStatus;
  usage?: CodexCommanderUsage;
  totalTokens?: number;
  attempts?: PersistedUsageAttempt[];
  // Failure diagnostics (implementation contract): persisted for
  // status>=400 or non-completed terminals so incidents survive the in-memory ring buffer.
  errorCode?: string;
  terminalStatus?: string;
  closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow";
  /** Already redacted + capped at capture (request-log.ts redactSecretString().slice(0,500)). */
  upstreamError?: string;
  /**
   * Bounded route-decision trace (RI-01): why this provider/model/account was
   * selected. Optional on current rows that have no captured decision. Never
   * contains prompts, credentials, or hidden reasoning.
   */
  routeDecision?: RouteDecisionTraceV1;
  /** Validated upstream Retry-After value captured for an observed quota event. */
  upstreamRetryAfter?: string;
}

const KNOWN_USAGE_SURFACES = new Set<UsageSurface>(["codex", "claude", "claude-desktop", "grok"]);

/**
 * Writer guard for the explicitly versioned persisted surface enum. Unknown values are
 * never written, and readers reject rows that do not carry one of these values.
 */
export function isKnownUsageSurface(value: unknown): value is UsageSurface {
  return typeof value === "string" && KNOWN_USAGE_SURFACES.has(value as UsageSurface);
}

const KNOWN_ADMISSION_KINDS = new Set<NonNullable<PersistedUsageEntry["admissionKind"]>>([
  "configured", "environment", "loopback",
]);

const KNOWN_INBOUND_PROTOCOLS = new Set<NonNullable<PersistedUsageEntry["inboundProtocol"]>>([
  "responses", "chat", "messages",
]);

/** Same closed-set discipline as `isKnownUsageSurface`: an old or corrupted row
 *  carrying an unexpected value drops the field instead of poisoning the enum. */
export function isKnownAdmissionKind(value: unknown): value is NonNullable<PersistedUsageEntry["admissionKind"]> {
  return typeof value === "string" && KNOWN_ADMISSION_KINDS.has(value as NonNullable<PersistedUsageEntry["admissionKind"]>);
}

export function isKnownInboundProtocol(value: unknown): value is NonNullable<PersistedUsageEntry["inboundProtocol"]> {
  return typeof value === "string" && KNOWN_INBOUND_PROTOCOLS.has(value as NonNullable<PersistedUsageEntry["inboundProtocol"]>);
}

export function usageLogPath(): string {
  return join(getConfigDir(), "usage.jsonl");
}

export function usageTotalTokens(usage: CodexCommanderUsage | undefined): number | undefined {
  return usageDisplayTotalTokens(usage);
}

/**
 * Providers whose adapters can only estimate usage (no authoritative per-turn frame).
 * Callers should pass the route ADAPTER when available; the name-prefix match is a
 * fallback for paths that only know the configured provider name (e.g. "cursor-mykey").
 */
function isEstimatedUsageProvider(providerOrAdapter: string): boolean {
  return providerOrAdapter === "kiro" || providerOrAdapter.startsWith("kiro-")
    || providerOrAdapter === "cursor" || providerOrAdapter.startsWith("cursor-");
}

export function usageForFinalLog(provider: string, usage: CodexCommanderUsage | undefined): CodexCommanderUsage | undefined {
  if (!usage) return undefined;
  const { cachedInputTokens: _cachedInputTokens, ...current } = usage;
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? usage.cachedInputTokens;
  return {
    ...current,
    ...(typeof cacheReadInputTokens === "number" ? { cacheReadInputTokens } : {}),
    ...(usage.estimated || isEstimatedUsageProvider(provider) ? { estimated: true } : {}),
  };
}

export function usageStatusForFinalLog(usage: CodexCommanderUsage | undefined): UsageStatus {
  if (!usage) return "unreported";
  return usage.estimated ? "estimated" : "reported";
}

function normalizeUsageValue(usage: CodexCommanderUsage | undefined): CodexCommanderUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    // Absolute active-context checkpoint (types.ts). Stateful providers such as Kiro report
    // per-attempt usage only, so this field is the ONLY carrier of the cumulative context
    // figure once the log records raw adapter usage instead of re-parsing the bridged wire
    // (usageFromBridge, request-log.ts). Omitting it here silently dropped Kiro's context
    // growth from every persisted row. It is deliberately NOT folded into totalTokens:
    // a checkpoint is not a per-request total and must never be summed across requests.
    ...(typeof usage.contextTotalTokens === "number" ? { contextTotalTokens: usage.contextTotalTokens } : {}),
    ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
    // Provider adapters may expose their upstream field as `cachedInputTokens`.
    // The persisted schema has exactly one cache-read field, so translate that
    // current wire value at capture time rather than retaining a second ledger form.
    ...(typeof (usage.cacheReadInputTokens ?? usage.cachedInputTokens) === "number"
      ? { cacheReadInputTokens: usage.cacheReadInputTokens ?? usage.cachedInputTokens }
      : {}),
    ...(typeof usage.cacheCreationInputTokens === "number" ? { cacheCreationInputTokens: usage.cacheCreationInputTokens } : {}),
    ...(typeof usage.reasoningOutputTokens === "number" ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
    ...(usage.estimated ? { estimated: true } : {}),
  };
}

const ATTEMPT_RECOVERY_KINDS = new Set<AttemptRecoveryKind>([
  "transient-5xx",
  "connection-reset",
  "oauth-401",
  "key-429",
  "rate-limit-429",
  "anthropic-oauth-429",
  "image-413",
]);
const USAGE_STATUSES = new Set<UsageStatus>([
  "reported",
  "unreported",
  "unsupported",
  "estimated",
]);

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeAttemptUsage(raw: unknown): CodexCommanderUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  if (!isNonNegativeFiniteNumber(usage.inputTokens)
    || !isNonNegativeFiniteNumber(usage.outputTokens)) return null;
  for (const key of [
    "contextTotalTokens",
    "totalTokens",
    "cachedInputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (key in usage && !isNonNegativeFiniteNumber(usage[key])) return null;
  }
  if ("estimated" in usage && typeof usage.estimated !== "boolean") return null;
  return normalizeUsageValue(usage as unknown as CodexCommanderUsage) ?? null;
}

function normalizeUsageAttempt(raw: unknown): PersistedUsageAttempt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const attempt = raw as Record<string, unknown>;
  if (typeof attempt.ordinal !== "number" || !Number.isInteger(attempt.ordinal)
    || attempt.ordinal < 1
    || typeof attempt.provider !== "string" || !attempt.provider
    || typeof attempt.model !== "string" || !attempt.model
    || typeof attempt.adapter !== "string" || !attempt.adapter
    || typeof attempt.status !== "number" || !Number.isInteger(attempt.status)
    || attempt.status < 100 || attempt.status > 599
    || typeof attempt.durationMs !== "number" || !Number.isFinite(attempt.durationMs)
    || attempt.durationMs < 0
    || typeof attempt.sendCount !== "number" || !Number.isInteger(attempt.sendCount)
    || attempt.sendCount < 0
    || typeof attempt.usageStatus !== "string"
    || !USAGE_STATUSES.has(attempt.usageStatus as UsageStatus)) {
    return null;
  }
  if ("inputTokenEstimate" in attempt
    && !isNonNegativeFiniteNumber(attempt.inputTokenEstimate)) return null;
  if ("firstOutputMs" in attempt
    && !isNonNegativeFiniteNumber(attempt.firstOutputMs)) return null;
  if ("totalTokens" in attempt
    && !isNonNegativeFiniteNumber(attempt.totalTokens)) return null;
  const usage = "usage" in attempt ? normalizeAttemptUsage(attempt.usage) : undefined;
  if ("usage" in attempt && usage === null) return null;
  const recoveryKinds = Array.isArray(attempt.recoveryKinds)
    ? [...new Set(attempt.recoveryKinds.filter(
      (value): value is AttemptRecoveryKind => typeof value === "string"
        && ATTEMPT_RECOVERY_KINDS.has(value as AttemptRecoveryKind),
    ))]
    : [];
  return {
    ordinal: attempt.ordinal as number,
    provider: attempt.provider,
    model: attempt.model,
    adapter: attempt.adapter,
    status: attempt.status,
    durationMs: attempt.durationMs,
    ...(isNonNegativeFiniteNumber(attempt.firstOutputMs)
      ? { firstOutputMs: attempt.firstOutputMs }
      : {}),
    sendCount: attempt.sendCount as number,
    recoveryKinds,
    usageStatus: attempt.usageStatus as UsageStatus,
    ...(isNonNegativeFiniteNumber(attempt.inputTokenEstimate)
      ? { inputTokenEstimate: attempt.inputTokenEstimate }
      : {}),
    ...(usage ? { usage } : {}),
    ...(isNonNegativeFiniteNumber(attempt.totalTokens)
      ? { totalTokens: attempt.totalTokens }
      : {}),
    ...(typeof attempt.errorCode === "string" ? { errorCode: attempt.errorCode } : {}),
    ...(typeof attempt.requestedEffort === "string" && attempt.requestedEffort
      ? { requestedEffort: capMetadataString(attempt.requestedEffort) }
      : {}),
    ...(typeof attempt.effectiveEffort === "string" && attempt.effectiveEffort
      ? { effectiveEffort: capMetadataString(attempt.effectiveEffort) }
      : {}),
    ...(typeof attempt.reasoningWireField === "string" && attempt.reasoningWireField
      ? { reasoningWireField: capMetadataString(attempt.reasoningWireField) }
      : {}),
    ...(isValidReasoningWireValue(attempt.reasoningWireField, attempt.reasoningWireValue)
      ? typeof attempt.reasoningWireValue === "string"
        ? { reasoningWireValue: capMetadataString(attempt.reasoningWireValue) }
        : { reasoningWireValue: attempt.reasoningWireValue }
      : {}),
  };
}

/**
 * Pairing rule for reasoning diagnostics, shared with the live request-log capture path:
 * a non-empty string, a non-negative finite number, or a boolean only for
 * `reasoning.enabled`. The field name itself is validated separately at capture time.
 */
export function isValidReasoningWireValue(
  wireField: unknown,
  wireValue: unknown,
): wireValue is string | number | boolean {
  return (typeof wireValue === "string" && wireValue.length > 0)
    || (typeof wireValue === "number" && Number.isFinite(wireValue) && wireValue >= 0)
    || (wireField === "reasoning.enabled" && typeof wireValue === "boolean");
}

function normalizedAttempts(raw: unknown): PersistedUsageAttempt[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeUsageAttempt)
    .filter((attempt): attempt is PersistedUsageAttempt => attempt !== null);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function isNonEmptyString(value: unknown, max = MAX_METADATA_STRING_LEN): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isCurrentUsageValue(raw: unknown): raw is CodexCommanderUsage {
  if (!isPlainRecord(raw) || !hasOnlyKeys(raw, [
    "inputTokens", "outputTokens", "contextTotalTokens", "totalTokens",
    "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens", "estimated",
  ])) return false;
  if (!isNonNegativeFiniteNumber(raw.inputTokens) || !isNonNegativeFiniteNumber(raw.outputTokens)) return false;
  for (const key of [
    "contextTotalTokens", "totalTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens",
  ] as const) {
    if (key in raw && !isNonNegativeFiniteNumber(raw[key])) return false;
  }
  if ("estimated" in raw && typeof raw.estimated !== "boolean") return false;
  const cacheRead = isNonNegativeFiniteNumber(raw.cacheReadInputTokens) ? raw.cacheReadInputTokens : 0;
  const cacheWrite = isNonNegativeFiniteNumber(raw.cacheCreationInputTokens) ? raw.cacheCreationInputTokens : 0;
  return cacheRead + cacheWrite <= raw.inputTokens;
}

function isCurrentUsageAttempt(raw: unknown): raw is PersistedUsageAttempt {
  if (!isPlainRecord(raw) || !hasOnlyKeys(raw, [
    "ordinal", "provider", "model", "adapter", "status", "durationMs", "firstOutputMs", "sendCount",
    "recoveryKinds", "usageStatus", "inputTokenEstimate", "usage", "totalTokens", "errorCode",
    "requestedEffort", "effectiveEffort", "reasoningWireField", "reasoningWireValue",
  ])) return false;
  if (!Number.isInteger(raw.ordinal) || (raw.ordinal as number) < 1
    || !isNonEmptyString(raw.provider, 256) || !isNonEmptyString(raw.model, 512) || !isNonEmptyString(raw.adapter, 128)
    || !Number.isInteger(raw.status) || (raw.status as number) < 100 || (raw.status as number) > 599
    || !isNonNegativeFiniteNumber(raw.durationMs) || !Number.isInteger(raw.sendCount) || (raw.sendCount as number) < 0
    || typeof raw.usageStatus !== "string" || !USAGE_STATUSES.has(raw.usageStatus as UsageStatus)
    || !Array.isArray(raw.recoveryKinds) || !raw.recoveryKinds.every(kind => typeof kind === "string" && ATTEMPT_RECOVERY_KINDS.has(kind as AttemptRecoveryKind))) return false;
  if (("firstOutputMs" in raw && !isNonNegativeFiniteNumber(raw.firstOutputMs))
    || ("inputTokenEstimate" in raw && !isNonNegativeFiniteNumber(raw.inputTokenEstimate))
    || ("totalTokens" in raw && !isNonNegativeFiniteNumber(raw.totalTokens))
    || ("usage" in raw && !isCurrentUsageValue(raw.usage))
    || ("errorCode" in raw && !isNonEmptyString(raw.errorCode))
    || ("requestedEffort" in raw && !isNonEmptyString(raw.requestedEffort))
    || ("effectiveEffort" in raw && !isNonEmptyString(raw.effectiveEffort))
    || ("reasoningWireField" in raw && !isNonEmptyString(raw.reasoningWireField))
    || ("reasoningWireValue" in raw && !isValidReasoningWireValue(raw.reasoningWireField, raw.reasoningWireValue))) return false;
  return true;
}

const MAX_METADATA_STRING_LEN = 64;
function capMetadataString(s: string): string {
  return s.length > MAX_METADATA_STRING_LEN ? s.slice(0, MAX_METADATA_STRING_LEN) : s;
}

export function normalizePersistedRetryAfter(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 && seconds <= 40 * 24 * 60 * 60
      ? trimmed
      : undefined;
  }
  // Persist only IMF-fixdate, the current HTTP-date wire form. Date.parse accepts
  // arbitrary prose containing a date; using it alone would turn Retry-After into a
  // small but unnecessary attacker-controlled metadata channel.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) {
    return undefined;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === trimmed
    ? trimmed
    : undefined;
}

/** Test seam for the write-time, secret-safe serializer. Readers do not use it. */
export function normalizeUsageEntryForTest(entry: PersistedUsageEntry): PersistedUsageEntry {
  return normalizeUsageEntry(entry);
}

function normalizeUsageEntry(entry: PersistedUsageEntry): PersistedUsageEntry {
  const attempts = normalizedAttempts(entry.attempts);
  const routeDecision = entry.routeDecision
    ? normalizeRouteDecisionTrace(entry.routeDecision)
    : undefined;
  return {
    requestId: entry.requestId,
    timestamp: entry.timestamp,
    provider: entry.provider,
    model: entry.model,
    // The writer knows the request origin. A missing internal marker is the native
    // Codex surface, never an ambiguity carried into durable state.
    surface: isKnownUsageSurface(entry.surface) ? entry.surface : "codex",
    ...(typeof entry.apiKeyId === "string" && entry.apiKeyId.trim()
      // Deliberately NOT capped. `capMetadataString` protects free-form metadata
      // from unbounded growth, but this is a lookup key: truncating it makes the
      // persisted id stop matching the configured one, and the rollup silently
      // reports zero for a key that is very much in use.
      ? { apiKeyId: entry.apiKeyId }
      : {}),
    ...(isKnownAdmissionKind(entry.admissionKind) ? { admissionKind: entry.admissionKind } : {}),
    ...(isKnownInboundProtocol(entry.inboundProtocol) ? { inboundProtocol: entry.inboundProtocol } : {}),
    ...(typeof entry.conversationId === "string" && entry.conversationId.trim()
      ? { conversationId: entry.conversationId.trim().slice(0, 128) }
      : {}),
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
    ...(typeof entry.requestedEffort === "string" && entry.requestedEffort
      ? { requestedEffort: capMetadataString(entry.requestedEffort) }
      : {}),
    ...(typeof entry.effectiveEffort === "string" && entry.effectiveEffort
      ? { effectiveEffort: capMetadataString(entry.effectiveEffort) }
      : {}),
    ...(typeof entry.reasoningWireField === "string" && entry.reasoningWireField
      ? { reasoningWireField: capMetadataString(entry.reasoningWireField) }
      : {}),
    ...(isValidReasoningWireValue(entry.reasoningWireField, entry.reasoningWireValue)
      ? typeof entry.reasoningWireValue === "string"
        ? { reasoningWireValue: capMetadataString(entry.reasoningWireValue) }
        : { reasoningWireValue: entry.reasoningWireValue }
      : {}),
    ...(typeof entry.requestedServiceTier === "string" && entry.requestedServiceTier
      ? { requestedServiceTier: capMetadataString(entry.requestedServiceTier) }
      : {}),
    ...(typeof entry.requestedSpeedLabel === "string" && entry.requestedSpeedLabel
      ? { requestedSpeedLabel: capMetadataString(entry.requestedSpeedLabel) }
      : {}),
    ...(typeof entry.configuredServiceTier === "string" && entry.configuredServiceTier
      ? { configuredServiceTier: capMetadataString(entry.configuredServiceTier) }
      : {}),
    ...(typeof entry.configuredSpeedLabel === "string" && entry.configuredSpeedLabel
      ? { configuredSpeedLabel: capMetadataString(entry.configuredSpeedLabel) }
      : {}),
    ...(typeof entry.modelSupportsServiceTier === "boolean"
      ? { modelSupportsServiceTier: entry.modelSupportsServiceTier }
      : {}),
    ...(typeof entry.responseServiceTier === "string" && entry.responseServiceTier
      ? { responseServiceTier: capMetadataString(entry.responseServiceTier) }
      : {}),
    status: entry.status,
    durationMs: entry.durationMs,
    ...(isNonNegativeFiniteNumber(entry.firstOutputMs)
      ? { firstOutputMs: entry.firstOutputMs }
      : {}),
    usageStatus: entry.usageStatus,
    ...(entry.usage ? { usage: normalizeUsageValue(entry.usage) } : {}),
    ...(typeof entry.totalTokens === "number" ? { totalTokens: entry.totalTokens } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.terminalStatus ? { terminalStatus: entry.terminalStatus } : {}),
    ...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
    ...(entry.upstreamError ? { upstreamError: entry.upstreamError } : {}),
    ...(routeDecision ? { routeDecision } : {}),
    ...(normalizePersistedRetryAfter(entry.upstreamRetryAfter)
      ? { upstreamRetryAfter: normalizePersistedRetryAfter(entry.upstreamRetryAfter) }
      : {}),
  };
}

/**
 * Decode exactly the current durable usage-log shape. This intentionally does
 * not normalize, fill defaults, split cache fields, or salvage individual
 * attempts: a row is either a current row or it is ignored.
 */
export function decodeUsageRow(raw: unknown): PersistedUsageEntry | null {
  if (!isPlainRecord(raw) || raw.schemaVersion !== USAGE_LOG_SCHEMA_VERSION || !hasOnlyKeys(raw, [
    "schemaVersion", "requestId", "timestamp", "provider", "model", "surface", "apiKeyId", "admissionKind",
    "inboundProtocol", "conversationId", "resolvedModel", "requestedModel", "requestedEffort", "effectiveEffort",
    "reasoningWireField", "reasoningWireValue", "requestedServiceTier", "requestedSpeedLabel", "configuredServiceTier",
    "configuredSpeedLabel", "modelSupportsServiceTier", "responseServiceTier", "status", "durationMs", "firstOutputMs",
    "usageStatus", "usage", "totalTokens", "attempts", "errorCode", "terminalStatus", "closeReason", "upstreamError",
    "routeDecision", "upstreamRetryAfter",
  ])) return null;
  if (!isNonEmptyString(raw.requestId, 256) || !isNonNegativeFiniteNumber(raw.timestamp)
    || !isNonEmptyString(raw.provider, 256) || !isNonEmptyString(raw.model, 512)
    || !isKnownUsageSurface(raw.surface) || !Number.isInteger(raw.status)
    || (raw.status as number) < 100 || (raw.status as number) > 599
    || !isNonNegativeFiniteNumber(raw.durationMs)
    || typeof raw.usageStatus !== "string" || !USAGE_STATUSES.has(raw.usageStatus as UsageStatus)) return null;
  if (("apiKeyId" in raw && !isNonEmptyString(raw.apiKeyId, 512))
    || ("admissionKind" in raw && !isKnownAdmissionKind(raw.admissionKind))
    || ("inboundProtocol" in raw && !isKnownInboundProtocol(raw.inboundProtocol))
    || ("conversationId" in raw && !isNonEmptyString(raw.conversationId, 128))
    || ("resolvedModel" in raw && !isNonEmptyString(raw.resolvedModel, 512))
    || ("requestedModel" in raw && !isNonEmptyString(raw.requestedModel, 512))
    || ("requestedEffort" in raw && !isNonEmptyString(raw.requestedEffort))
    || ("effectiveEffort" in raw && !isNonEmptyString(raw.effectiveEffort))
    || ("reasoningWireField" in raw && !isNonEmptyString(raw.reasoningWireField))
    || ("reasoningWireValue" in raw && !isValidReasoningWireValue(raw.reasoningWireField, raw.reasoningWireValue))
    || ("requestedServiceTier" in raw && !isNonEmptyString(raw.requestedServiceTier))
    || ("requestedSpeedLabel" in raw && !isNonEmptyString(raw.requestedSpeedLabel))
    || ("configuredServiceTier" in raw && !isNonEmptyString(raw.configuredServiceTier))
    || ("configuredSpeedLabel" in raw && !isNonEmptyString(raw.configuredSpeedLabel))
    || ("modelSupportsServiceTier" in raw && typeof raw.modelSupportsServiceTier !== "boolean")
    || ("responseServiceTier" in raw && !isNonEmptyString(raw.responseServiceTier))
    || ("firstOutputMs" in raw && !isNonNegativeFiniteNumber(raw.firstOutputMs))
    || ("usage" in raw && !isCurrentUsageValue(raw.usage))
    || ("totalTokens" in raw && !isNonNegativeFiniteNumber(raw.totalTokens))
    || ("attempts" in raw && (!Array.isArray(raw.attempts) || raw.attempts.length === 0 || !raw.attempts.every(isCurrentUsageAttempt)))
    || ("errorCode" in raw && !isNonEmptyString(raw.errorCode))
    || ("terminalStatus" in raw && !isNonEmptyString(raw.terminalStatus))
    || ("closeReason" in raw && !["terminal", "client_cancel", "non_stream", "body_stall", "body_overflow"].includes(raw.closeReason as string))
    || ("upstreamError" in raw && !isNonEmptyString(raw.upstreamError, 500))
    || ("routeDecision" in raw && !normalizeRouteDecisionTrace(raw.routeDecision))
    || ("upstreamRetryAfter" in raw && normalizePersistedRetryAfter(raw.upstreamRetryAfter) !== raw.upstreamRetryAfter)) return null;
  const { schemaVersion: _schemaVersion, ...entry } = raw;
  return entry as unknown as PersistedUsageEntry;
}

function ensureUsageLogDir(): void {
  const dir = getConfigDir();
  recordOwnedConfigPath(dir, usageLogPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on platforms that ignore chmod */ }
}

export function appendUsageEntry(entry: PersistedUsageEntry): void {
  const normalized = normalizeUsageEntry(entry);
  const row = { schemaVersion: USAGE_LOG_SCHEMA_VERSION, ...normalized };
  // Logging is best effort, but it must never create a row the current reader
  // cannot understand. Invalid internal capture is dropped instead of becoming
  // a future compatibility obligation.
  if (!decodeUsageRow(row)) return;
  ensureUsageLogDir();
  const path = usageLogPath();
  appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms that ignore chmod */ }
}

export type UsageLogRevision = {
  path: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

let usageReadCacheStats = { fullReads: 0, tailReads: 0, parsedLines: 0 };
const MANAGEMENT_USAGE_MAX_READ_BYTES = 64 * 1024 * 1024;
const MANAGEMENT_USAGE_READ_CHUNK_BYTES = 1024 * 1024;
const MANAGEMENT_USAGE_MAX_ENTRIES = 500_000;
const MANAGEMENT_USAGE_FLIGHT_STALE_MS = 30_000;
export interface ManagementUsageSnapshot {
  entries: PersistedUsageEntry[];
  revision: UsageLogRevision;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
}
let managementUsageReadInflight: {
  key: string;
  promise: Promise<ManagementUsageSnapshot>;
  startedAt: number;
  abort: AbortController;
} | null = null;

/** Test-only observability for proving that unchanged prefixes are not reparsed. */
export function usageReadCacheStatsForTests(): Readonly<typeof usageReadCacheStats> {
  return { ...usageReadCacheStats };
}

export function resetUsageReadCacheForTests(): void {
  usageReadCacheStats = { fullReads: 0, tailReads: 0, parsedLines: 0 };
  managementUsageReadInflight?.abort.abort();
  managementUsageReadInflight = null;
}

function readExactly(fd: number, length: number, position: number): Buffer | null {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, output, offset, length - offset, position + offset);
    if (read === 0) return null;
    offset += read;
  }
  return output;
}

function usageLogRevision(path: string, stat: ReturnType<typeof fstatSync>): UsageLogRevision {
  if (!stat.isFile()) throw new Error("usage log is not a regular file");
  return {
    path,
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    birthtimeMs: Number(stat.birthtimeMs),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

export function usageLogRevisionKey(revision: UsageLogRevision | null): string {
  if (!revision) return "missing";
  return [
    revision.path,
    revision.dev,
    revision.ino,
    revision.birthtimeMs,
    revision.size,
    revision.mtimeMs,
    revision.ctimeMs,
  ].join("\0");
}

export function currentUsageLogRevision(): UsageLogRevision | null {
  const path = usageLogPath();
  if (!existsSync(path)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    return usageLogRevision(path, fstatSync(fd));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function parseUsageTextCooperatively(text: string, signal: AbortSignal): Promise<{
  entries: PersistedUsageEntry[];
  entriesDropped: number;
}> {
  const lines = text.split(/\r?\n/);
  usageReadCacheStats.parsedLines += lines.filter(line => line.trim()).length;
  const entries: PersistedUsageEntry[] = [];
  const batchSize = 1_000;
  for (let offset = 0; offset < lines.length; offset += batchSize) {
    if (signal.aborted) throw signal.reason;
    entries.push(...parseUsageLines(lines.slice(offset, offset + batchSize)));
    if (offset + batchSize < lines.length) {
      // JSON parsing dominates large-log startup. Yield between bounded batches so
      // Bun can continue serving health and settings requests on the same thread.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  if (entries.length <= MANAGEMENT_USAGE_MAX_ENTRIES) return { entries, entriesDropped: 0 };
  const entriesDropped = entries.length - MANAGEMENT_USAGE_MAX_ENTRIES;
  return { entries: entries.slice(-MANAGEMENT_USAGE_MAX_ENTRIES), entriesDropped };
}

async function readUsageEntriesFullCooperatively(
  path: string,
  signal: AbortSignal,
  maxReadBytes: number,
): Promise<ManagementUsageSnapshot> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const size = Number(stat.size);
    const start = Math.max(0, size - maxReadBytes);
    const chunks: Buffer[] = [];
    for (let position = start; position < size;) {
      if (signal.aborted) throw signal.reason;
      const length = Math.min(MANAGEMENT_USAGE_READ_CHUNK_BYTES, size - position);
      const chunk = readExactly(fd, length, position);
      if (chunk === null) throw new Error("usage log changed while it was being read");
      chunks.push(chunk);
      position += length;
    }
    let bytes = Buffer.concat(chunks);
    let truncatedPrefixBytes = start;
    if (start > 0) {
      const preceding = readExactly(fd, 1, start - 1);
      if (preceding === null) throw new Error("usage log changed while it was being read");
      if (preceding[0] !== 0x0a) {
        const newline = bytes.indexOf(0x0a);
        if (newline < 0) {
          truncatedPrefixBytes += bytes.byteLength;
          bytes = Buffer.alloc(0);
        } else {
          truncatedPrefixBytes += newline + 1;
          bytes = bytes.subarray(newline + 1);
        }
      }
    }
    const parsed = await parseUsageTextCooperatively(bytes.toString("utf-8"), signal);
    usageReadCacheStats.fullReads += 1;
    return {
      entries: parsed.entries,
      revision: usageLogRevision(path, stat),
      truncatedPrefixBytes,
      entriesTruncated: parsed.entriesDropped > 0,
      entriesDropped: parsed.entriesDropped,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Management API reader: full parses yield between bounded batches and concurrent
 * callers share work only when they observed the same exact file revision. Parsed rows
 * are returned to the request and never retained in module state.
 */
export async function readUsageSnapshotForManagement(maxReadBytes = MANAGEMENT_USAGE_MAX_READ_BYTES): Promise<{
  entries: PersistedUsageEntry[];
  revision: UsageLogRevision | null;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
}> {
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) throw new RangeError("management usage max read bytes must be positive");
  const path = usageLogPath();
  if (!existsSync(path)) return { entries: [], revision: null, truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0 };
  const observed = currentUsageLogRevision();
  const key = `${usageLogRevisionKey(observed)}\0${maxReadBytes}`;
  const existing = managementUsageReadInflight;
  if (existing?.key === key && Date.now() - existing.startedAt <= MANAGEMENT_USAGE_FLIGHT_STALE_MS) {
    const shared = await existing.promise;
    return { ...shared, entries: shared.entries.slice() };
  }
  existing?.abort.abort(new Error("management usage read superseded"));
  const abort = new AbortController();
  const promise = readUsageEntriesFullCooperatively(path, abort.signal, maxReadBytes);
  managementUsageReadInflight = { key, promise, startedAt: Date.now(), abort };
  try {
    const snapshot = await promise;
    return { ...snapshot, entries: snapshot.entries.slice() };
  } finally {
    if (managementUsageReadInflight?.promise === promise) managementUsageReadInflight = null;
  }
}

export async function readUsageEntriesForManagement(): Promise<PersistedUsageEntry[]> {
  return (await readUsageSnapshotForManagement()).entries;
}

export function readUsageEntries(): PersistedUsageEntry[] {
  const path = usageLogPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  const entries: PersistedUsageEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = decodeUsageRow(JSON.parse(line));
      if (parsed) entries.push(parsed);
    } catch {
      /* keep reading after a partially written or hand-edited line */
    }
  }
  return entries;
}

function parseUsageLines(lines: string[]): PersistedUsageEntry[] {
  const entries: PersistedUsageEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = decodeUsageRow(JSON.parse(line));
      if (parsed) entries.push(parsed);
    } catch {
      /* skip partial / hand-edited lines */
    }
  }
  return entries;
}

/**
 * Read only the newest `limit` usage.jsonl rows without loading the whole append-only
 * file into memory. Used by request-log hydration on `ccx start`.
 */
export function readRecentUsageEntries(limit: number): PersistedUsageEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const path = usageLogPath();
  if (!existsSync(path)) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size <= 0) return [];
    // Trace-sized rows (up to MAX_TRACE_BYTES, RI-01) need a larger per-row
    // budget than the pre-trace ledger; keep expanding until the window covers
    // the file start or the whole file so a restart never hydrates nothing.
    let windowBytes = Math.min(size, Math.max(64 * 1024, Math.ceil(limit) * 20 * 1024));
    while (true) {
      const start = Math.max(0, size - windowBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString("utf-8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl < 0) {
          if (start === 0) break;
          windowBytes = Math.min(size, windowBytes * 4);
          continue;
        }
        text = text.slice(nl + 1);
      }
      const lines = text.split(/\r?\n/).filter(line => line.trim());
      // Parse ALL lines first, then take the last N valid entries. This way corrupt
      // or partial lines are filtered out during parsing and we always return the
      // most recent N valid rows (not N physical lines minus corrupt ones).
      const entries = parseUsageLines(lines);
      if (entries.length >= limit || start === 0 || windowBytes >= size) return entries.slice(-limit);
      if (windowBytes >= size) break;
      windowBytes = Math.min(size, windowBytes * 4);
    }
    return [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

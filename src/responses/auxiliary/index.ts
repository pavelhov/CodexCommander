/**
 * Request-scoped Responses auxiliary coordinator for web search, image generation, and
 * text-to-video. One bounded outer model loop owns adapter execution, replay, progress, usage,
 * continuation state, and independent handler allowances.
 */
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../../adapters/base";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createAdapterEventQueue } from "../../adapters/run-turn-queue";
import type { AdapterEvent, CodexCommanderMessage, CodexCommanderParsedRequest, CodexCommanderProviderContinuationState, CodexCommanderRequestOptions, CodexCommanderThinkingContent, CodexCommanderUsage, RateLimitRetryPolicy } from "../../types";
import { isIncompleteAdapterTerminalEvent, namespacedToolName } from "../../types";
import type { AttemptRecoveryKind } from "../../usage/log";
import { bridgeToResponsesSSE } from "../../bridge";
import { clearableDeadline, idleDeadline } from "../../lib/abort";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { fetchWithResetRetry, prepareSameTarget429Wait } from "../../lib/upstream-retry";
import { rateLimitRetryDelayMs } from "../../providers/key-failover";
import {
  isTranslatorBudgetExceededError,
  TRANSLATOR_MAX_TURN_BYTES,
  TranslatorBudgetExceededError,
} from "../../lib/translator-budget";
import { parseStreamWithProgress, RoutedModelInactivityError, WebSearchStreamProtocolError } from "../../web-search/progress-stream";
import {
  createImageArtifactProtectionScope,
  fulfillImageCall,
  safeMediaToolResult,
} from "../../images/fulfill";
import { parseVideoCallArgs, buildVideoResult } from "../../images/fulfill-video";
import { createImageBudget, pruneArtifacts, resolveArtifactPath } from "../../images/artifacts";
import {
  getDefaultModelVideoRuntime,
  mediaRecoveryJobId,
  type ModelVideoRuntime,
} from "../../images/media-runtime";
import type { VideoOperationIdentity } from "../../images/video-operation-key";
import { buildVideoTool, IMAGE_GEN_TOOL_NAME, VIDEO_GEN_TOOL_NAME } from "../../images/synthetic-tool";
import type { ImageBridgePlan, MediaCredentialBinding, VideoBridgePlan } from "../../images/types";
import { runWebSearch, type SidecarOutcome } from "../../web-search/executor";
import { runAnthropicWebSearch } from "../../web-search/anthropic-executor";
import { formatWebSearchResults } from "../../web-search/format-result";
import { WEB_SEARCH_TOOL_NAME } from "../../web-search/synthetic-tool";
import type { AuxiliaryHandlerAllowances, AuxiliaryToolCall, AuxiliaryWebSearchPlan } from "./types";
import {
  rewriteHostedImageGenerationForBridge,
  repairOversizedReplayCallIds,
  rewriteVideoGenerationForBridge,
  type HostedImageBridgeRewriteMode,
  type VideoBridgeRewriteMode,
} from "../../adapters/openai-responses";
import {
  appendNativeAuxiliaryTurn,
  finalizeNativeResponsesSse,
  inspectNativeResponsesSse,
  type NativeCompletedArtifact,
} from "./native-replay";

export * from "./native-replay";
export * from "./types";
export * from "./user-intent";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};

const CONNECT_TIMEOUT_MS = 200_000;
const STALL_TIMEOUT_MS = 200_000;
export const DEFAULT_MAX_ROUNDS = 3;
/** Absolute ceiling so a hand-edited `images.maxRounds: 10000` cannot unbound paid xAI calls. */
export const MAX_ROUNDS_HARD_LIMIT = 10;
/** Cap paid xAI image fulfillments per turn (parallel calls in one round count separately). */
export const MAX_IMAGE_CALLS_PER_TURN = 10;
/** V1 admits at most one paid text-to-video submission per current user turn. */
export const MAX_VIDEO_CALLS_PER_TURN = 1;
const VIDEO_WAITING_STATES = new Set([
  "queued",
  "submitting",
  "accepted",
  "polling",
  "needs_auth",
  "downloading",
  "download_failed",
]);

type RuntimeVideoJob = NonNullable<ReturnType<ModelVideoRuntime["getPublicVideoJob"]>>;

function acquireCompletedVideoDeliveryLease(
  runtime: ModelVideoRuntime,
  job: RuntimeVideoJob,
  leases: Array<() => void>,
  leasedArtifactIds: Set<string>,
  preacquiredRelease?: () => void,
): void {
  if (job.state !== "completed" || !job.artifactId || leasedArtifactIds.has(job.artifactId)) {
    preacquiredRelease?.();
    return;
  }
  const release = preacquiredRelease ?? runtime.acquireArtifactDeliveryLease?.(job.artifactId);
  if (!release) return;
  leasedArtifactIds.add(job.artifactId);
  leases.push(release);
}

/** Pure no-dispatch validation shared by native and translated batch preflight. */
function imageArgumentError(raw: string): string | undefined {
  let args: unknown;
  try {
    args = JSON.parse(raw || "{}");
  } catch {
    return "invalid arguments JSON";
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "invalid arguments JSON";
  const obj = args as Record<string, unknown>;
  const prompt = typeof obj.prompt === "string" ? obj.prompt : typeof obj.input === "string" ? obj.input : "";
  if (!prompt) return "missing prompt";
  if (obj.n !== undefined && (!Number.isInteger(obj.n) || (obj.n as number) < 1 || (obj.n as number) > 4)) {
    return "image count must be an integer from 1 through 4";
  }
  const imageUrl = typeof obj.image_url === "string"
    ? obj.image_url
    : typeof obj.image === "string"
      ? obj.image
      : undefined;
  return imageUrl ? "grok_image_edits_unsupported" : undefined;
}

function imageRequestedCount(raw: string): number {
  try {
    const args = JSON.parse(raw || "{}") as { n?: unknown };
    return typeof args?.n === "number" && Number.isInteger(args.n) ? args.n : 1;
  } catch {
    return 1;
  }
}

function bindPlanAuth(plan: ImageBridgePlan | VideoBridgePlan): MediaCredentialBinding {
  const binding = plan.auth ?? plan.bindAuth?.();
  if (!binding) throw new Error("needs_auth");
  return binding;
}

/** Add request-local handle context to the canonical tool created by the native rewrite. */
function rewriteNativeVideoHandleContext(body: unknown, videoPlan: VideoBridgePlan): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const source = body as Record<string, unknown>;
  const { videoGeneration: _marker, ...tool } = buildVideoTool(videoPlan.mediaInputs?.descriptions ?? []);
  const replacement = { type: "function", ...tool };
  const rewriteTools = (value: unknown): unknown => Array.isArray(value)
    ? value.map(item => item && typeof item === "object" && !Array.isArray(item)
      && (item as Record<string, unknown>).type === "function"
      && (item as Record<string, unknown>).name === VIDEO_GEN_TOOL_NAME
      ? replacement
      : item)
    : value;
  const tools = rewriteTools(source.tools);
  const input = Array.isArray(source.input) ? source.input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return record.type === "additional_tools" && Array.isArray(record.tools)
      ? { ...record, tools: rewriteTools(record.tools) }
      : item;
  }) : source.input;
  return { ...source, ...(tools !== undefined ? { tools } : {}), ...(input !== undefined ? { input } : {}) };
}

function parsedAuxiliaryCallArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function combineUsage(
  a: CodexCommanderUsage | undefined,
  b: CodexCommanderUsage | undefined,
): CodexCommanderUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.contextTotalTokens !== undefined || b.contextTotalTokens !== undefined
      ? { contextTotalTokens: Math.max(a.contextTotalTokens ?? 0, b.contextTotalTokens ?? 0) }
      : {}),
    ...(a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined
      ? { cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) }
      : {}),
    ...(a.cacheReadInputTokens !== undefined || b.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0) }
      : {}),
    ...(a.cacheCreationInputTokens !== undefined || b.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0) }
      : {}),
    ...(a.reasoningOutputTokens !== undefined || b.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: (a.reasoningOutputTokens ?? 0) + (b.reasoningOutputTokens ?? 0) }
      : {}),
    ...(a.estimated || b.estimated ? { estimated: true } : {}),
  };
}

/**
 * Clamp a configured maxRounds value to a safe integer in [0, MAX_ROUNDS_HARD_LIMIT].
 * Non-finite / non-number inputs fall back to DEFAULT_MAX_ROUNDS.
 */
export function clampImageMaxRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  return Math.max(0, Math.min(MAX_ROUNDS_HARD_LIMIT, Math.floor(value)));
}

/** Clamp one independently configured handler allowance without borrowing from another. */
export function clampAuxiliaryAllowance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_ROUNDS_HARD_LIMIT, Math.floor(value)));
}

/** Two model passes (initial/final) plus every enabled handler's clamped opportunities. */
export function deriveAuxiliaryGlobalCeiling(allowances: AuxiliaryHandlerAllowances): number {
  return 2
    + clampAuxiliaryAllowance(allowances.webSearch)
    + clampAuxiliaryAllowance(allowances.image)
    + clampAuxiliaryAllowance(allowances.video);
}

/** Drop unavailable auxiliary tool choices without changing another handler's selection. */
function stripMediaToolChoice(
  options: CodexCommanderRequestOptions,
  plan?: ImageBridgePlan,
  videoPlan?: VideoBridgePlan,
  availability: { webSearch: boolean; image: boolean; video: boolean } = { webSearch: false, image: false, video: false },
): CodexCommanderRequestOptions {
  const tc = options.toolChoice;
  if (!tc || typeof tc !== "object") return options;
  const isMediaTool = (name: string): boolean =>
    (!availability.webSearch && name === WEB_SEARCH_TOOL_NAME) ||
    (!availability.image && (name === IMAGE_GEN_TOOL_NAME || (plan?.toolNames.has(name) ?? false))) ||
    (!availability.video && (name === VIDEO_GEN_TOOL_NAME || (videoPlan?.toolNames.has(name) ?? false)));
  if ("name" in tc && typeof tc.name === "string") {
    if (isMediaTool(tc.name)) {
      return { ...options, toolChoice: "auto" };
    }
    return options;
  }
  if ("allowedTools" in tc && Array.isArray(tc.allowedTools)) {
    const filtered = tc.allowedTools.filter(name => !isMediaTool(name));
    if (filtered.length === tc.allowedTools.length) return options;
    if (filtered.length === 0) return { ...options, toolChoice: "auto" };
    return { ...options, toolChoice: { ...tc, allowedTools: filtered } };
  }
  return options;
}

export interface AuxiliaryToolNameSets {
  webSearch: boolean;
  image: ReadonlySet<string>;
  video: ReadonlySet<string>;
}

function validAuxiliaryToolCallId(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !/[\x00-\x1f\x7f]/.test(value);
}

function toolCallIdCollisionKey(
  value: string,
  collisionKey?: (id: string) => string,
): string | undefined {
  try {
    const key = collisionKey?.(value) ?? value;
    return validAuxiliaryToolCallId(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

function historicalToolCallIds(
  messages: readonly CodexCommanderMessage[],
  collisionKey?: (id: string) => string,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const key = toolCallIdCollisionKey(part.id, collisionKey);
        if (key) ids.add(key);
      }
    } else if (message.role === "toolResult") {
      const key = toolCallIdCollisionKey(message.toolCallId, collisionKey);
      if (key) ids.add(key);
    }
  }
  return ids;
}

/** Only exact, unnamespaced synthetic aliases are intercepted. */
export function scanAuxiliaryToolCalls(
  events: AdapterEvent[],
  names: AuxiliaryToolNameSets,
  existingToolCallIds: ReadonlySet<string> = new Set(),
  collisionKey?: (id: string) => string,
): { calls: AuxiliaryToolCall[]; passthrough: AdapterEvent[]; hasRealToolCall: boolean; malformedSyntheticCall: boolean } {
  const calls: AuxiliaryToolCall[] = [];
  const passthrough: AdapterEvent[] = [];
  let hasRealToolCall = false;
  let malformedSyntheticCall = false;
  const seenToolCallIds = new Set<string>();
  let pending: { name: string; id: string; argsBuf: string; events: AdapterEvent[] } | null = null;
  const handlerFor = (name: string): AuxiliaryToolCall["handler"] | undefined => {
    if (name.includes("__")) return undefined;
    if (names.webSearch && name === "web_search") return "web_search";
    if (names.image.has(name)) return "image";
    if (names.video.has(name)) return "video";
    return undefined;
  };
  const flushPending = (completed: boolean): void => {
    if (!pending) return;
    const handler = handlerFor(pending.name);
    if (handler && completed) calls.push({ id: pending.id, name: pending.name, args: pending.argsBuf, handler });
    else if (handler) malformedSyntheticCall = true;
    else {
      passthrough.push(...pending.events);
      hasRealToolCall = true;
    }
    pending = null;
  };
  for (const event of events) {
    if (event.type === "tool_call_start") {
      flushPending(false);
      const idKey = toolCallIdCollisionKey(event.id, collisionKey);
      if (
        !validAuxiliaryToolCallId(event.id)
        || !idKey
        || !event.name
        || seenToolCallIds.has(idKey)
        || existingToolCallIds.has(idKey)
      ) malformedSyntheticCall = true;
      if (idKey) seenToolCallIds.add(idKey);
      pending = { name: event.name, id: event.id, argsBuf: "", events: [event] };
    } else if (event.type === "tool_call_delta" && pending) {
      pending.argsBuf += event.arguments;
      pending.events.push(event);
    } else if (event.type === "tool_call_end" && pending) {
      pending.events.push(event);
      flushPending(true);
    } else if (event.type === "tool_call_delta" || event.type === "tool_call_end") {
      malformedSyntheticCall = true;
      passthrough.push(event);
    } else {
      flushPending(false);
      passthrough.push(event);
    }
  }
  flushPending(false);
  return { calls, passthrough, hasRealToolCall, malformedSyntheticCall };
}

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const e of events) yield e;
}

/**
 * Collect thinking / redacted_thinking blocks that preceded an image tool call, preserving
 * stream order and per-block signatures. Anthropic extended thinking REQUIRES the assistant
 * message containing tool_use to start with its signed thinking blocks — flattening multiple
 * blocks into one signature 400s on replay.
 */
function extractIterationThinking(events: AdapterEvent[]): CodexCommanderThinkingContent[] {
  const parts: CodexCommanderThinkingContent[] = [];
  let thinking = "";
  let signature: string | undefined;
  let rawReasoning = "";

  const flushVisible = () => {
    if (!thinking && !signature) return;
    parts.push({
      type: "thinking",
      thinking,
      ...(signature ? { signature } : {}),
    });
    thinking = "";
    signature = undefined;
  };
  const flushRaw = () => {
    if (!rawReasoning) return;
    parts.push({ type: "thinking", thinking: rawReasoning });
    rawReasoning = "";
  };

  for (const e of events) {
    if (e.type === "thinking_delta") {
      flushRaw();
      thinking += e.thinking;
    } else if (e.type === "reasoning_raw_delta") {
      // OpenAI-compatible providers emit raw reasoning instead of signed
      // thinking; DeepSeek thinking mode requires it back alongside replayed
      // tool_calls (mirrors src/web-search/loop.ts, issue #950).
      flushVisible();
      rawReasoning += e.text;
    } else if (e.type === "thinking_signature") {
      signature = e.signature;
      flushVisible();
    } else if (e.type === "redacted_thinking") {
      flushVisible();
      flushRaw();
      parts.push({ type: "thinking", thinking: "", redacted: [e.data] });
    }
  }
  flushVisible();
  flushRaw();
  return parts;
}

function parseWebSearchQueries(args: string): string[] {
  try {
    const parsed: unknown = JSON.parse(args || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const value = parsed as { query?: unknown; queries?: unknown };
    if (Array.isArray(value.queries)) {
      const queries = value.queries.filter((query): query is string => typeof query === "string" && query.trim().length > 0);
      if (queries.length > 0) return queries;
    }
    return typeof value.query === "string" && value.query.trim().length > 0 ? [value.query] : [];
  } catch {
    return [];
  }
}

function normalizeWebSearchQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function forcedWebSearchAnswerNudge(): CodexCommanderMessage {
  return {
    role: "developer",
    content:
      "Answer the user's question now using the web search results already gathered above. "
      + "Ground the answer in those results and reference relevant returned sources when available.",
    timestamp: Date.now(),
  };
}

function jsonError(
  status: number,
  message: string,
  errorType = "upstream_error",
  code: string | null = null,
): Response {
  return new Response(JSON.stringify({ error: { message, type: errorType, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAFE_AUXILIARY_ERROR_TYPES = new Set([
  "authentication_error",
  "client_cancelled",
  "client_closed_request",
  "insufficient_quota",
  "invalid_request_error",
  "permission_error",
  "rate_limit_error",
  "server_error",
  "upstream_error",
]);

const SAFE_AUXILIARY_ERROR_CODES = new Set([
  "client_cancelled",
  "client_closed_request",
  "context_length_exceeded",
  "cyber_policy",
  "insufficient_quota",
  "invalid_api_key",
  "invalid_request_error",
  "origin_rejected",
  "permission_denied",
  "previous_response_not_found",
  "rate_limit_exceeded",
  "server_is_overloaded",
  "subscription_required",
  "tool_catalog_too_large",
  "translation_buffer_limit",
  "upstream_server_error",
]);

type AuxiliaryFailurePhase = "request" | "stream";

function structuredAuxiliaryFailureStatus(event: Extract<AdapterEvent, { type: "error" }>): number {
  if (Number.isInteger(event.status) && event.status! >= 400 && event.status! <= 599) return event.status!;
  if (
    event.code === "client_cancelled"
    || event.code === "client_closed_request"
    || event.errorType === "client_cancelled"
    || event.errorType === "client_closed_request"
  ) return 499;
  if (
    event.code === "context_length_exceeded"
    || event.code === "cyber_policy"
    || event.code === "invalid_request_error"
    || event.code === "origin_rejected"
    || event.code === "previous_response_not_found"
    || event.code === "tool_catalog_too_large"
    || event.errorType === "invalid_request_error"
  ) return 400;
  if (event.code === "invalid_api_key" || event.errorType === "authentication_error") return 401;
  if (
    event.code === "permission_denied"
    || event.code === "subscription_required"
    || event.errorType === "permission_error"
  ) return 403;
  if (
    event.code === "insufficient_quota"
    || event.code === "rate_limit_exceeded"
    || event.errorType === "insufficient_quota"
    || event.errorType === "rate_limit_error"
  ) return 429;
  if (event.code === "server_is_overloaded") return 503;
  return 502;
}

function safeAuxiliaryFailureMessage(status: number, phase: AuxiliaryFailurePhase): string {
  if (status === 401) return "Provider authentication failed during the auxiliary request";
  if (status === 403) return "Provider denied the auxiliary request";
  if (status === 429) return "Provider rate limit exceeded during the auxiliary request";
  if (status === 499) return "Client closed the auxiliary request";
  if (status === 504) return "Provider auxiliary request timed out";
  if (status >= 400 && status < 500) return `Provider rejected the auxiliary request (status ${status})`;
  return phase === "stream"
    ? "Provider auxiliary stream failed"
    : "Provider auxiliary request failed";
}

/** Hard provider/parse failure inside an iteration. The eager first iteration converts it to a
 *  non-2xx jsonError; later (already-streaming) iterations surface it as an in-stream error event. */
class LoopError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errorType?: string,
    readonly code?: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "LoopError";
  }
}

function safeAdapterLoopError(
  event: Extract<AdapterEvent, { type: "error" }>,
  phase: AuxiliaryFailurePhase,
): LoopError {
  const status = structuredAuxiliaryFailureStatus(event);
  const errorType = event.errorType && SAFE_AUXILIARY_ERROR_TYPES.has(event.errorType)
    ? event.errorType
    : undefined;
  const code = event.code && SAFE_AUXILIARY_ERROR_CODES.has(event.code) ? event.code : undefined;
  return new LoopError(
    status,
    safeAuxiliaryFailureMessage(status, phase),
    errorType,
    code,
    typeof event.retryable === "boolean" ? event.retryable : undefined,
  );
}

function safeUnknownLoopError(status: number, phase: AuxiliaryFailurePhase): LoopError {
  return new LoopError(status, safeAuxiliaryFailureMessage(status, phase), "upstream_error");
}

/**
 * Dependencies for one request-scoped auxiliary loop.
 */
export interface ResponsesAuxiliaryLoopDeps {
  parsed: CodexCommanderParsedRequest;
  adapter: ProviderAdapter;
  incomingMeta: IncomingMeta;
  plan?: ImageBridgePlan;
  videoPlan?: VideoBridgePlan;
  /** Optional routed web-search handler executed by the same outer model loop. */
  webSearchPlan?: AuxiliaryWebSearchPlan;
  /** Per-video generation timeout (ms) including polling. */
  videoTimeoutMs?: number;
  /** Paired private retry identity derived only after authenticated request admission. */
  videoOperationIdentity?: VideoOperationIdentity;
  /** Lazy durable identity derivation, invoked only for a locally valid video proposal. */
  resolveVideoOperationIdentity?: () => VideoOperationIdentity | undefined;
  /** Server-owned durable video runtime. Tests may inject the same narrow contract. */
  videoRuntime?: ModelVideoRuntime;
  /** Headers forwarded from the original request (e.g. Codex auth). Cloned per iteration. */
  forwardHeaders?: Headers;
  /** Called before each routed-model dispatch in the bridge loop, for attempt telemetry. Same-target 429 replays pass the `rate-limit-429` recovery kind. */
  onAttemptSend?: (recovery?: AttemptRecoveryKind) => void;
  /** Called after each upstream request is built (parity with web-search / normal path). */
  onRequestBuilt?: (request: AdapterRequest) => void;
  abortSignal?: AbortSignal;
  onFirstOutput?: () => void;
  /** Max image-generation rounds before forcing a final answer. Defaults to 3; clamped to [0, 10]. */
  maxRounds?: number;
  /** Independent image handler allowance. Falls back to maxRounds for compatibility. */
  imageMaxRounds?: number;
  /** Independent video handler allowance. Falls back to maxRounds for compatibility. */
  videoMaxRounds?: number;
  /** Connect / response-header budget for non-runTurn iterations. */
  connectTimeoutMs?: number;
  /** Stall budget (seconds) forwarded to bridgeToResponsesSSE; also bounds runTurn collect. */
  stallTimeoutSec?: number;
  /** Provider-specific fetch (e.g. xAI transport wrapper). Falls back to global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Raw adapter usage at the terminal event, pre wire-normalization (see bridgeToResponsesSSE onUsage). */
  onUsage?: (usage: CodexCommanderUsage | undefined) => void;
  /**
   * Optional 429 key-failover for the routed (non-xAI) model. Return a rebuilt adapter for the
   * rotated key, or null when the pool is exhausted.
   */
  on429?: (retryAfterHeader: string | null) => ProviderAdapter | null;
  /** Opt-in same-target 429 policy (key-auth providers). When present, 429 replays on the SAME key before on429 rotation. */
  retryOn429Policy?: Required<RateLimitRetryPolicy> | null;
  /** Called when the bridged Responses stream completes (parity with runTurn / routed paths). */
  onCompletedResponse?: (response: Record<string, unknown>, providerState?: CodexCommanderProviderContinuationState) => void;
  /** WebSocket Responses path only — leave response id empty for protocol compatibility. */
  forceEmptyResponseId?: boolean;
  /** Request-visible tool parameter schemas for integer argument canonicalization at the Responses bridge. */
  toolParameterSchemas?: ReadonlyMap<string, Record<string, unknown>>;
  /** Raw Responses adapter route: buffer only synthetic iterations and relay final SSE raw. */
  nativeResponses?: boolean;
}

/** Compatibility type for historical direct image-loop callers. */
export type ImageBridgeDeps = ResponsesAuxiliaryLoopDeps;

async function runNativeResponsesMediaLoop(deps: ResponsesAuxiliaryLoopDeps): Promise<Response> {
  const { parsed, plan, videoPlan, videoTimeoutMs, abortSignal } = deps;
  if (!plan && !videoPlan) return jsonError(500, "native media bridge plan is missing");
  let adapter = deps.adapter;
  const translatorBudget = deps.incomingMeta.translatorBudget;
  const legacyMaxRounds = clampImageMaxRounds(deps.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const imageMaxRounds = plan
    ? clampImageMaxRounds(deps.imageMaxRounds ?? legacyMaxRounds)
    : 0;
  const videoMaxRounds = videoPlan
    ? clampImageMaxRounds(deps.videoMaxRounds ?? legacyMaxRounds)
    : 0;
  const globalCeiling = deriveAuxiliaryGlobalCeiling({ webSearch: 0, image: imageMaxRounds, video: videoMaxRounds });
  const connectTimeoutMs = typeof deps.connectTimeoutMs === "number" && Number.isFinite(deps.connectTimeoutMs) && deps.connectTimeoutMs > 0
    ? Math.floor(deps.connectTimeoutMs)
    : CONNECT_TIMEOUT_MS;
  const stallTimeoutMs = typeof deps.stallTimeoutSec === "number" && Number.isFinite(deps.stallTimeoutSec) && deps.stallTimeoutSec > 0
    ? Math.floor(deps.stallTimeoutSec * 1000)
    : STALL_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const internalAbort = new AbortController();
  const linkAbort = () => internalAbort.abort(abortSignal?.reason);
  if (abortSignal) {
    if (abortSignal.aborted) linkAbort();
    else abortSignal.addEventListener("abort", linkAbort, { once: true });
  }
  const signal = internalAbort.signal;
  const imageBudget = createImageBudget();
  let replayBody = parsed._rawBody;
  const auxiliaryNames = new Set<string>([
    ...(plan ? [IMAGE_GEN_TOOL_NAME] : []),
    ...(videoPlan ? [VIDEO_GEN_TOOL_NAME] : []),
  ]);
  // One same-target 429 allowance spans every native replay iteration in this request.
  const rateLimitRetryPolicy = deps.retryOn429Policy ?? null;
  let rateLimitRetries = 0;
  let firstOutput = false;
  const noteFirstOutput = () => {
    if (firstOutput) return;
    firstOutput = true;
    deps.onFirstOutput?.();
  };

  const fetchIteration = async (modes: {
    image: HostedImageBridgeRewriteMode;
    video: VideoBridgeRewriteMode;
  }, failurePhase: AuxiliaryFailurePhase, onHeartbeat?: () => void): Promise<Response> => {
    let rawBody = replayBody;
    if (plan) rawBody = rewriteHostedImageGenerationForBridge(rawBody, modes.image);
    if (videoPlan) {
      rawBody = rewriteVideoGenerationForBridge(rawBody, modes.video, videoPlan.toolNames);
      if (modes.video === "synthetic") rawBody = rewriteNativeVideoHandleContext(rawBody, videoPlan);
    }
    const iterParsed: CodexCommanderParsedRequest = {
      ...parsed,
      stream: true,
      _rawBody: rawBody,
    };
    let deadline = clearableDeadline(connectTimeoutMs, signal);
    let request: AdapterRequest | undefined;
    try {
      request = await adapter.buildRequest(iterParsed, {
        headers: deps.forwardHeaders ? new Headers(deps.forwardHeaders) : new Headers(),
        abortSignal: deadline.signal,
        translatorBudget,
      });
      try { deps.onRequestBuilt?.(request); } catch { /* diagnostics are best effort */ }
      const send = async (recovery?: AttemptRecoveryKind): Promise<Response> => adapter.fetchResponse
        ? (deps.onAttemptSend?.(recovery), adapter.fetchResponse(request!, {
            abortSignal: deadline.signal,
            timeoutMs: connectTimeoutMs,
            returnRawErrors: true,
            stream: true,
          }))
        : fetchWithResetRetry(
            retryRecovery => {
              deps.onAttemptSend?.(retryRecovery ?? recovery);
              const headers = new Headers(request!.headers);
              if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
              return fetchImpl(request!.url, {
                method: request!.method,
                headers,
                body: request!.body,
                signal: deadline.signal,
              });
            },
            { abortSignal: deadline.signal, label: "native-media-bridge-loop" },
          );
      let response = await send();
      while (
        response.status === 429
        && rateLimitRetryPolicy !== null
        && rateLimitRetries < rateLimitRetryPolicy.attempts
      ) {
        rateLimitRetries += 1;
        const retryAfterHeader = response.headers.get("retry-after");
        deadline.clear();
        try {
          for await (const _ of prepareSameTarget429Wait({
            body: response.body,
            signal,
            delayMs: rateLimitRetryDelayMs(rateLimitRetryPolicy, retryAfterHeader, Date.now()),
            heartbeatIntervalMs: Math.min(10_000, Math.max(250, stallTimeoutMs / 2)),
          })) {
            onHeartbeat?.();
          }
        } catch (error) {
          if (signal.aborted) throw new LoopError(499, "client closed request during native media bridge");
          throw error;
        }
        if (signal.aborted) throw new LoopError(499, "client closed request during native media bridge");
        deadline = clearableDeadline(connectTimeoutMs, signal);
        onHeartbeat?.();
        response = await send("rate-limit-429");
      }
      while (response.status === 429 && deps.on429) {
        const rotated = deps.on429(response.headers.get("retry-after"));
        if (!rotated) break;
        try { await response.body?.cancel(); } catch { /* best effort */ }
        adapter = rotated;
        request.releaseBodyObservation?.();
        request = await adapter.buildRequest(iterParsed, {
          headers: deps.forwardHeaders ? new Headers(deps.forwardHeaders) : new Headers(),
          abortSignal: deadline.signal,
          translatorBudget,
        });
        try { deps.onRequestBuilt?.(request); } catch { /* diagnostics are best effort */ }
        onHeartbeat?.();
        response = await send("key-429");
      }
      if (!response.ok) {
        try {
          await readBoundedResponseBody(response, { signal, maxBytes: 65_536 });
        } catch {
          if (signal.aborted) throw safeUnknownLoopError(499, failurePhase);
          throw safeUnknownLoopError(response.status, failurePhase);
        }
        throw safeUnknownLoopError(response.status, failurePhase);
      }
      return response;
    } catch (error) {
      if (signal.aborted) throw safeUnknownLoopError(499, failurePhase);
      if (deadline.didExpire()) throw safeUnknownLoopError(504, failurePhase);
      if (error instanceof LoopError) throw error;
      throw safeUnknownLoopError(502, failurePhase);
    } finally {
      request?.releaseBodyObservation?.();
      deadline.clear();
    }
  };

  let firstResponse: Response;
  try {
    firstResponse = await fetchIteration({
      image: imageMaxRounds > 0 ? "synthetic" : "omit",
      video: videoMaxRounds > 0 ? "synthetic" : "omit",
    }, "request");
  } catch (error) {
    if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
    const failure = error instanceof LoopError ? error : safeUnknownLoopError(502, "request");
    return jsonError(failure.status, failure.message, failure.errorType, failure.code ?? null);
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const drive = async () => {
        const imageArtifacts = createImageArtifactProtectionScope();
        const videoDeliveryLeases: Array<() => void> = [];
        const leasedVideoArtifactIds = new Set<string>();
        const enqueueKeepalive = () => {
          if (signal.aborted) return;
          noteFirstOutput();
          try { controller.enqueue(encoder.encode(": ccx-auxiliary\n\n")); } catch { /* closed */ }
        };
        let current = firstResponse;
        let imageRoundsUsed = 0;
        let videoRoundsUsed = 0;
        let paidCalls = 0;
        let imageSubmissionOutcomeUnknown = false;
        let imagePaidSubmissionConsumedWithoutArtifact = false;
        let videoSubmissionBudgetUsed = 0;
        let hiddenUsage: CodexCommanderUsage | undefined;
        const completedArtifacts: NativeCompletedArtifact[] = [];
        try {
          for (;;) {
            let keepaliveOpen = true;
            const keepalive = setInterval(() => {
              if (!keepaliveOpen || signal.aborted) return;
              enqueueKeepalive();
            }, 2_000);
            let observed: Awaited<ReturnType<typeof readBoundedResponseBody>>;
            try {
              observed = await readBoundedResponseBody(current, {
                signal,
                fatalUtf8: true,
                maxBytes: TRANSLATOR_MAX_TURN_BYTES,
                totalTimeoutMs: 24 * 60 * 60 * 1000,
                firstByteTimeoutMs: stallTimeoutMs,
                inactivityTimeoutMs: stallTimeoutMs,
              });
            } finally {
              keepaliveOpen = false;
              clearInterval(keepalive);
            }
            if (observed.timedOut) throw new LoopError(504, `native Responses stream stalled during ${videoPlan ? "media" : "image"} bridge`);
            if (observed.oversized || observed.truncated || !observed.displaySafe) {
              throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
            }
            const rawBytes = encoder.encode(observed.text).byteLength;
            translatorBudget.chargeRetained(rawBytes, { kind: "retained_collectors" });
            let inspection;
            try {
              inspection = inspectNativeResponsesSse(
                observed.text,
                auxiliaryNames,
                [replayBody, repairOversizedReplayCallIds(replayBody)],
              );
            } finally {
              translatorBudget.releaseRetained(rawBytes, { kind: "retained_collectors" });
            }

            if (
              inspection.terminal !== "completed"
              || inspection.auxiliaryCalls.length === 0
              || inspection.hasUnsafeActionableCall
            ) {
              const usage = combineUsage(hiddenUsage, inspection.usage);
              deps.onUsage?.(usage);
              const finalized = finalizeNativeResponsesSse(inspection.raw, usage, completedArtifacts);
              if (finalized.completedResponse) deps.onCompletedResponse?.(finalized.completedResponse);
              noteFirstOutput();
              controller.enqueue(encoder.encode(finalized.raw));
              controller.close();
              return;
            }
            const hasImageCall = inspection.auxiliaryCalls.some(call => plan !== undefined && call.name === IMAGE_GEN_TOOL_NAME);
            const hasVideoCall = inspection.auxiliaryCalls.some(call => videoPlan !== undefined && call.name === VIDEO_GEN_TOOL_NAME);
            if (hasImageCall && imageRoundsUsed >= imageMaxRounds) {
              throw new LoopError(409, `image auxiliary allowance exhausted; global iteration ceiling ${globalCeiling}`);
            }
            if (hasVideoCall && videoRoundsUsed >= videoMaxRounds) {
              throw new LoopError(409, `video auxiliary allowance exhausted; global iteration ceiling ${globalCeiling}`);
            }

            const outputs = new Map<string, string>();
            const replayDisabledAtRoundStart = imagePaidSubmissionConsumedWithoutArtifact;
            const videoArguments = new Map<string, Extract<ReturnType<typeof parseVideoCallArgs>, { ok: true }>>();
            const argumentErrors = new Map<string, string>();
            for (const call of inspection.auxiliaryCalls) {
              if (videoPlan && call.name === VIDEO_GEN_TOOL_NAME) {
                const args = parseVideoCallArgs(call.arguments, videoPlan.mediaInputs);
                if (args.ok) videoArguments.set(call.callId, args);
                else argumentErrors.set(call.callId, args.error);
              } else if (plan && call.name === IMAGE_GEN_TOOL_NAME) {
                const error = imageArgumentError(call.arguments);
                if (error) argumentErrors.set(call.callId, error);
              }
            }
            const videoCallCount = inspection.auxiliaryCalls.filter(call =>
              videoPlan !== undefined && call.name === VIDEO_GEN_TOOL_NAME).length;
            const videoBatchError = videoCallCount > MAX_VIDEO_CALLS_PER_TURN
              ? `video call batch exceeds the per-turn maximum of ${MAX_VIDEO_CALLS_PER_TURN}`
              : undefined;
            const imageRequestedTotal = inspection.auxiliaryCalls
              .filter(call => plan !== undefined && call.name === IMAGE_GEN_TOOL_NAME)
              .reduce((sum, call) => sum + imageRequestedCount(call.arguments), 0);
            const imageBatchBudgetError = imageRequestedTotal > MAX_IMAGE_CALLS_PER_TURN - paidCalls
              ? `image call batch exceeds the remaining per-turn budget of ${Math.max(0, MAX_IMAGE_CALLS_PER_TURN - paidCalls)}`
              : undefined;
            const videoBatchBudgetError = videoCallCount > 0
              && videoSubmissionBudgetUsed >= MAX_VIDEO_CALLS_PER_TURN
              ? `video call budget exhausted (max ${MAX_VIDEO_CALLS_PER_TURN} per turn)`
              : undefined;
            const mediaBatchError = videoBatchError
              ?? imageBatchBudgetError
              ?? videoBatchBudgetError
              ?? (argumentErrors.size > 0 ? "auxiliary batch contains invalid arguments" : undefined);
            const invalidArgumentBatch = mediaBatchError !== undefined;
            for (const call of inspection.auxiliaryCalls) {
              if (videoPlan && call.name === VIDEO_GEN_TOOL_NAME) {
                const keepalive = setInterval(enqueueKeepalive, 2_000);
                try {
                  let result;
                  if (invalidArgumentBatch) {
                    result = {
                      ok: false,
                      model: videoPlan.model,
                      prompt: "",
                      files: [],
                      count: 0,
                      error: videoBatchError
                        ?? argumentErrors.get(call.callId)
                        ?? mediaBatchError,
                    };
                  } else if (videoSubmissionBudgetUsed >= MAX_VIDEO_CALLS_PER_TURN) {
                    result = {
                      ok: false,
                      model: videoPlan.model,
                      prompt: "",
                      files: [],
                      count: 0,
                      error: `video call budget exhausted (max ${MAX_VIDEO_CALLS_PER_TURN} per turn)`,
                    };
                  } else {
                    const args = videoArguments.get(call.callId)!;
                      let operationIdentity = deps.videoOperationIdentity;
                      if (!operationIdentity && deps.resolveVideoOperationIdentity) {
                        try { operationIdentity = deps.resolveVideoOperationIdentity(); } catch { /* typed denial below */ }
                      }
                      const runtime = deps.videoRuntime ?? getDefaultModelVideoRuntime();
                      if (deps.resolveVideoOperationIdentity && !operationIdentity) {
                        result = {
                          ok: false, model: videoPlan.model, prompt: "", files: [], count: 0,
                          error: "video retry protection is unavailable",
                        };
                      } else if (!runtime) {
                        result = {
                          ok: false,
                          model: videoPlan.model,
                          prompt: "",
                          files: [],
                          count: 0,
                          error: "video recovery is unavailable (recovery_blocked)",
                        };
                      } else {
                        // Debit before awaiting the paid POST. A concurrently acknowledged
                        // ambiguous submission must not reopen this turn; only busy proves that
                        // no dispatch occurred and refunds the request-local allowance.
                        videoSubmissionBudgetUsed += 1;
                        const deliveryRuntime: ModelVideoRuntime = runtime;
                        try {
                          const binding = bindPlanAuth(videoPlan);
                          const submission = await runtime.submitVideo({
                            binding,
                            deadlineAt: Date.now() + (videoTimeoutMs ?? 300_000),
                            ...(operationIdentity ?? {}),
                            request: {
                              prompt: args.prompt,
                              model: videoPlan.model,
                              ...(args.mode !== "text" ? { mode: args.mode } : {}),
                              ...(args.startingImage ? { startingImage: args.startingImage } : {}),
                              ...(args.referenceImages ? { referenceImages: args.referenceImages } : {}),
                              duration: args.duration,
                              resolution: args.resolution,
                              aspectRatio: args.aspectRatio,
                              ...(args.audio !== undefined ? { audio: args.audio } : {}),
                            },
                            signal,
                          });
                          if (submission.kind === "busy") {
                            videoSubmissionBudgetUsed -= 1;
                            result = {
                              ok: false,
                              model: videoPlan.model,
                              prompt: "",
                              files: [],
                              count: 0,
                              ...(submission.job ? { jobId: submission.job.id } : {}),
                              error: "video_busy: another video job is active for this credential",
                            };
                          } else {
                            let job = submission.job;
                            acquireCompletedVideoDeliveryLease(
                              deliveryRuntime,
                              job,
                              videoDeliveryLeases,
                              leasedVideoArtifactIds,
                              submission.kind === "replay" ? submission.releaseArtifactDeliveryLease : undefined,
                            );
                            if (VIDEO_WAITING_STATES.has(job.state)) {
                              runtime.startVideoJob(job.id);
                              enqueueKeepalive();
                            }
                            while (VIDEO_WAITING_STATES.has(job.state)) {
                              const update = await runtime.waitForVideoUpdate(job.id, job.revision, {
                                signal,
                                timeoutMs: 2_000,
                              });
                              if (update.kind === "timeout") {
                                enqueueKeepalive();
                                continue;
                              }
                              if (update.kind === "updated") {
                                job = update.job;
                                acquireCompletedVideoDeliveryLease(
                                  deliveryRuntime,
                                  job,
                                  videoDeliveryLeases,
                                  leasedVideoArtifactIds,
                                );
                                enqueueKeepalive();
                                continue;
                              }
                              if (signal.aborted) throw new LoopError(499, "client closed request during video-bridge");
                              result = {
                                ok: false,
                                model: videoPlan.model,
                                prompt: "",
                                files: [],
                                count: 0,
                                jobId: job.id,
                                error: `video_detached: generation continues as job ${job.id}; inspect it in the dashboard or with ccx media status`,
                              };
                              break;
                            }
                            if (!result) {
                              if (job.state === "completed" && job.artifactId) {
                                acquireCompletedVideoDeliveryLease(
                                  deliveryRuntime,
                                  job,
                                  videoDeliveryLeases,
                                  leasedVideoArtifactIds,
                                );
                                const path = resolveArtifactPath(job.artifactId);
                                result = path
                                  ? buildVideoResult(path, args.prompt, videoPlan.model, {
                                      duration: args.duration,
                                      resolution: args.resolution,
                                      aspectRatio: args.aspectRatio,
                                      ...(args.audio !== undefined ? { audio: args.audio } : {}),
                                      jobId: job.id,
                                    })
                                  : {
                                      ok: false,
                                      model: videoPlan.model,
                                      prompt: "",
                                      files: [],
                                      count: 0,
                                      jobId: job.id,
                                      error: "video artifact is not available locally",
                                    };
                              } else {
                                const guidance = job.state === "outcome_unknown"
                                  ? "the submission outcome is unknown; acknowledge it in the dashboard or CLI before retrying"
                                  : `video job ended in state ${job.state}`;
                                result = {
                                  ok: false,
                                  model: videoPlan.model,
                                  prompt: "",
                                  files: [],
                                  count: 0,
                                  jobId: job.id,
                                  error: `${guidance}${job.safeError ? ` (${job.safeError})` : ""}`,
                                };
                              }
                            }
                          }
                        } catch (error) {
                          if (signal.aborted) throw new LoopError(499, "client closed request during video-bridge");
                          const recoveryJobId = mediaRecoveryJobId(error);
                          result = recoveryJobId
                            ? {
                                ok: false,
                                model: videoPlan.model,
                                prompt: "",
                                files: [],
                                count: 0,
                                jobId: recoveryJobId,
                                error: "submission_outcome_unknown",
                              }
                            : {
                                ok: false,
                                model: videoPlan.model,
                                prompt: "",
                                files: [],
                                count: 0,
                                error: error instanceof Error ? error.message : String(error),
                              };
                        }
                      }
                  }
                  imageArtifacts.protect(result.files);
                  const safeResult = safeMediaToolResult(result, "video");
                  if (safeResult.ok && safeResult.status === "completed") {
                    for (const url of safeResult.artifacts ?? []) completedArtifacts.push({ kind: "video", url });
                  }
                  outputs.set(call.callId, JSON.stringify(safeResult));
                } finally {
                  clearInterval(keepalive);
                }
                continue;
              }
              if (!plan || call.name !== IMAGE_GEN_TOOL_NAME) continue;
              let result;
              if (invalidArgumentBatch) {
                result = {
                  ok: false,
                  model: plan.model,
                  prompt: "",
                  files: [],
                  count: 0,
                  error: videoBatchError
                    ?? argumentErrors.get(call.callId)
                    ?? mediaBatchError,
                };
              } else if (imageSubmissionOutcomeUnknown) {
                result = {
                  ok: false,
                  model: plan.model,
                  prompt: "",
                  files: [],
                  count: 0,
                  error: "submission_outcome_unknown: image generation is disabled for the rest of this turn",
                  dispatchCertainty: "ambiguous" as const,
                };
              } else if (replayDisabledAtRoundStart) {
                result = {
                  ok: false,
                  model: plan.model,
                  prompt: "",
                  files: [],
                  count: 0,
                  error: "image artifact unavailable; paid submission replay is disabled for this turn",
                  paidSubmissionConsumed: true,
                };
              } else if (paidCalls >= MAX_IMAGE_CALLS_PER_TURN) {
                result = {
                  ok: false,
                  model: plan.model,
                  prompt: "",
                  files: [],
                  count: 0,
                  error: `image call budget exhausted (max ${MAX_IMAGE_CALLS_PER_TURN} per turn)`,
                };
              } else {
                paidCalls += imageRequestedCount(call.arguments);
                try {
                  const binding = bindPlanAuth(plan);
                  result = await fulfillImageCall(
                    { id: call.callId, name: call.name, arguments: call.arguments },
                    { ...plan, auth: binding },
                    imageBudget,
                    signal,
                    imageArtifacts,
                  );
                } catch {
                  result = { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "needs_auth" };
                }
                if (result.dispatchCertainty === "ambiguous") {
                  imageSubmissionOutcomeUnknown = true;
                }
                if (result.paidSubmissionConsumed && !result.ok) {
                  imagePaidSubmissionConsumedWithoutArtifact = true;
                }
              }
              imageArtifacts.protect(result.files);
              const safeResult = safeMediaToolResult(result, "image");
              if (safeResult.ok && safeResult.status === "completed") {
                for (const url of safeResult.artifacts ?? []) completedArtifacts.push({ kind: "image", url });
              }
              outputs.set(call.callId, JSON.stringify(safeResult));
            }
            hiddenUsage = combineUsage(hiddenUsage, inspection.usage);
            replayBody = appendNativeAuxiliaryTurn(replayBody, inspection.outputItems, outputs);
            if (hasImageCall) imageRoundsUsed += 1;
            if (hasVideoCall) videoRoundsUsed += 1;
            noteFirstOutput();
            controller.enqueue(encoder.encode(": ccx-auxiliary\n\n"));
            current = await fetchIteration({
              image: !imageSubmissionOutcomeUnknown
                && !imagePaidSubmissionConsumedWithoutArtifact
                && imageRoundsUsed < imageMaxRounds
                ? "synthetic"
                : "omit",
              video: videoSubmissionBudgetUsed < MAX_VIDEO_CALLS_PER_TURN
                && videoRoundsUsed < videoMaxRounds
                ? "synthetic"
                : "omit",
            }, "stream", enqueueKeepalive);
          }
        } catch (error) {
          if (signal.aborted) {
            try { controller.close(); } catch { /* closed */ }
            return;
          }
          deps.onUsage?.(hiddenUsage);
          const failure = error instanceof LoopError ? error : safeUnknownLoopError(502, "stream");
          const payload = {
            type: "response.failed",
            response: {
              status: "failed",
              output: [],
              error: { type: "server_error", code: "upstream_server_error", message: failure.message },
            },
          };
          noteFirstOutput();
          controller.enqueue(encoder.encode(`event: response.failed\ndata: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`));
          controller.close();
        } finally {
          for (const release of videoDeliveryLeases.splice(0)) release();
          imageArtifacts.close();
          if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
        }
      };
      void drive();
    },
    cancel(reason) {
      internalAbort.abort(reason);
      if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

/**
 * Run the selected adapter in one bounded agentic loop. Semantic model output stays buffered until
 * synthetic calls validate, while progress and renderer-safe search cells stream live.
 */
export async function runResponsesAuxiliaryLoop(deps: ResponsesAuxiliaryLoopDeps): Promise<Response> {
  if (deps.nativeResponses && (deps.plan || deps.videoPlan) && !deps.adapter.runTurn && !deps.webSearchPlan) {
    return runNativeResponsesMediaLoop(deps);
  }
  const translatorBudget = deps.incomingMeta.translatorBudget;
  const { parsed, plan, videoPlan, webSearchPlan, videoTimeoutMs, abortSignal } = deps;
  let adapter = deps.adapter;
  const legacyMaxRounds = clampImageMaxRounds(deps.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const imageMaxRounds = plan
    ? clampImageMaxRounds(deps.imageMaxRounds ?? legacyMaxRounds)
    : 0;
  const videoMaxRounds = videoPlan
    ? clampImageMaxRounds(deps.videoMaxRounds ?? legacyMaxRounds)
    : 0;
  const webSearchMax = webSearchPlan ? clampAuxiliaryAllowance(webSearchPlan.maxSearches) : 0;
  const HARD_CAP = deriveAuxiliaryGlobalCeiling({ webSearch: webSearchMax, image: imageMaxRounds, video: videoMaxRounds });
  const connectTimeoutMs = typeof deps.connectTimeoutMs === "number" && Number.isFinite(deps.connectTimeoutMs) && deps.connectTimeoutMs > 0
    ? Math.floor(deps.connectTimeoutMs)
    : CONNECT_TIMEOUT_MS;
  const stallTimeoutMs = typeof deps.stallTimeoutSec === "number" && Number.isFinite(deps.stallTimeoutSec) && deps.stallTimeoutSec > 0
    ? Math.floor(deps.stallTimeoutSec * 1000)
    : STALL_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let paidImageCalls = 0;
  let imageSubmissionOutcomeUnknown = false;
  let imagePaidSubmissionConsumedWithoutArtifact = false;
  let videoSubmissionBudgetUsed = 0;
  let hiddenUsage: CodexCommanderUsage | undefined;

  const takeUsageFrom = (events: AdapterEvent[]): void => {
    for (const e of events) {
      if ((e.type === "done" || e.type === "incomplete") && e.usage) {
        hiddenUsage = combineUsage(hiddenUsage, e.usage);
      }
    }
  };

  const messages: CodexCommanderMessage[] = [...parsed.context.messages];
  let webSearchesExecuted = 0;
  let webSearchExecutedCount = 0;
  const failedWebSearchQueries = new Set<string>();
  const allTools = parsed.context.tools ?? [];
  // Forced-final must strip every image/video-generation alias the plans know about — not only
  // tools flagged `imageGeneration:true` or `videoGeneration:true`. Hosted `image_generation` /
  // function aliases would otherwise remain callable after that handler is exhausted.
  const toolsForAvailability = (availability: { webSearch: boolean; image: boolean; video: boolean }) => allTools.filter(t => {
    if (!availability.webSearch && t.webSearch) return false;
    if (!availability.image && t.imageGeneration) return false;
    if (!availability.video && t.videoGeneration) return false;
    if (!availability.image && plan && plan.toolNames.has(t.name)) return false;
    if (!availability.image && plan && t.namespace && plan.toolNames.has(namespacedToolName(t.namespace, t.name))) return false;
    if (!availability.video && videoPlan && !t.namespace && videoPlan.toolNames.has(t.name)) return false;
    return true;
  });
  const budget = createImageBudget();

  // Link an internal AbortController to the turn signal so a client cancel of the SSE body aborts
  // in-flight model fetches AND the sidecar.
  const internalAbort = new AbortController();
  const linkAbort = (): void => internalAbort.abort(abortSignal?.reason);
  if (abortSignal) {
    if (abortSignal.aborted) linkAbort();
    else abortSignal.addEventListener("abort", linkAbort, { once: true });
  }
  const signal = internalAbort.signal;

  interface IterationResponse {
    response: Response;
    responseAdapter: ProviderAdapter;
  }
  type IterationSplit = ReturnType<typeof scanAuxiliaryToolCalls>;

  // Same-target 429 budget is per REQUEST, not per model iteration: later image rounds inherit
  // what earlier rounds left of `attempts`, so a bounded multi-round turn can never exceed the
  // configured replay count in total (a per-round reset would multiply it by maxRounds).
  const rateLimitRetryPolicy = deps.retryOn429Policy ?? null;
  let rateLimitRetries = 0;

  // Acquire one iteration's final response headers. The first call is drained eagerly so an initial
  // connect/header/HTTP failure stays a non-2xx JSON response — except for runTurn adapters, which
  // have no HTTP status surface and must not block SSE headers behind queue.collect().
  /**
   * Fetch one auxiliary iteration's final response headers, applying the response-header
   * deadline and the same-target 429 retry policy (with awaited body release and deadline
   * restart) before the `on429` key rotation.
   */
  const prepareIterationEvents = async function* (
    availability: { webSearch: boolean; image: boolean; video: boolean },
    forceFinal: boolean,
  ): AsyncGenerator<AdapterEvent, IterationResponse> {
    const iterMessages = forceFinal && webSearchExecutedCount > 0
      ? [...messages, forcedWebSearchAnswerNudge()]
      : messages;
    const iterParsed: CodexCommanderParsedRequest = {
      ...parsed,
      stream: true,
      context: { ...parsed.context, messages: iterMessages, tools: toolsForAvailability(availability) },
      options: stripMediaToolChoice(parsed.options, plan, videoPlan, availability),
    };

    // runTurn adapters (Cursor) own all upstream communication via an emit callback. They don't
    // expose buildRequest/fetchResponse/parseStream to the bridge, so collect their events through
    // an AdapterEventQueue and wrap them in a pseudo-response whose parseStream replays them.
    if (adapter.runTurn) {
      const queue = createAdapterEventQueue({
        onBacklogExceeded: () => internalAbort.abort("runTurn backlog exceeded"),
      });
      // Attempt telemetry must fire at dispatch time (parity with fetchOnce), not after collect.
      deps.onAttemptSend?.();
      void adapter
        .runTurn(
          iterParsed,
          {
            headers: deps.forwardHeaders ? new Headers(deps.forwardHeaders) : new Headers(),
            abortSignal: signal,
            translatorBudget,
          },
          queue.push,
        )
        .then(() => queue.close())
        .catch(() => {
          queue.push({
            type: "error",
            message: "Provider auxiliary request failed",
            status: 502,
            errorType: "upstream_error",
            code: "upstream_server_error",
          });
          queue.close();
        });

      // Bound collect with a real *idle* deadline that resets on each emitted event.
      // A fixed wall-clock race would abort legitimate long Cursor turns that keep
      // producing tokens. Do NOT manufacture adapter heartbeats here — bridgeToResponsesSSE
      // treats those as upstream activity and would defeat the stall guard. SSE keepalives
      // come from the bridge heartbeat interval instead.
      //
      // On idle expiry: abort the runTurn signal AND close the queue so the consumer
      // unblocks even when adapter.runTurn ignores cancellation and never settles.
      let timedOut = false;
      const idle = idleDeadline(stallTimeoutMs, () => {
        timedOut = true;
        // Cancel the fire-and-forget runTurn so a well-behaved adapter can stop.
        internalAbort.abort(`runTurn inactivity timeout after ${stallTimeoutMs}ms`);
        // Independently unblock queue.stream() — do not wait for runTurn to observe abort.
        queue.close();
      });
      const events: AdapterEvent[] = [];
      try {
        idle.reset();
        for await (const event of queue.stream()) {
          if (timedOut) break;
          idle.reset();
          events.push(event);
        }
      } finally {
        idle.cancel();
      }
      if (timedOut) {
        throw new LoopError(504, `runTurn inactivity timeout after ${stallTimeoutMs}ms during image-bridge`);
      }

      // Preserve Cursor conversation continuity across image-loop iterations. runTurn mutates
      // iterParsed (shallow copy); copy the id back onto the shared parsed request.
      if (iterParsed._cursorConversationId) {
        parsed._cursorConversationId = iterParsed._cursorConversationId;
      }

      // runTurn adapters signal errors via {type:"error"} events, not HTTP status codes.
      const errorEvent = events.find(e => e.type === "error");
      if (errorEvent && errorEvent.type === "error") {
        if (errorEvent.code === "translation_buffer_limit") {
          throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
        }
        throw safeAdapterLoopError(errorEvent, "stream");
      }

      const wrappedAdapter: ProviderAdapter = {
        ...adapter,
        async *parseStream() {
          for (const e of events) yield e;
        },
      };
      return { response: new Response(new Uint8Array(0), { status: 200 }), responseAdapter: wrappedAdapter };
    }

    let headerDeadline = clearableDeadline(connectTimeoutMs, signal);
    try {
      /**
       * Build and fetch one auxiliary iteration on the given adapter, under the iteration
       * header deadline. The caller owns same-target 429 replays and key rotation around it.
       * The outbound request is cached per adapter so a same-target replay reuses the EXACT
       * URL, serialized body, and headers (builder runs once per target sequence).
       */
      let cachedRequest: AdapterRequest | undefined;
      let cachedAdapter: ProviderAdapter | undefined;
      /**
       * Build and fetch one auxiliary iteration on the given adapter, under the iteration
       * header deadline. The caller owns same-target 429 replays and key rotation around it.
       */
      const fetchOnce = async (requestAdapter: ProviderAdapter, recovery?: AttemptRecoveryKind): Promise<IterationResponse> => {
        let request: AdapterRequest;
        if (cachedRequest !== undefined && cachedAdapter === requestAdapter) {
          request = cachedRequest;
        } else {
          request = await requestAdapter.buildRequest(iterParsed, {
            headers: deps.forwardHeaders ? new Headers(deps.forwardHeaders) : new Headers(),
            abortSignal: headerDeadline.signal,
            translatorBudget,
          });
          try { deps.onRequestBuilt?.(request); } catch { /* diagnostics are best-effort */ }
          cachedRequest = request;
          cachedAdapter = requestAdapter;
        }
        let response: Response;
        try {
          if (requestAdapter.fetchResponse) {
            deps.onAttemptSend?.(recovery);
            response = await requestAdapter.fetchResponse(request, {
              abortSignal: headerDeadline.signal,
              timeoutMs: connectTimeoutMs,
              returnRawErrors: true,
              stream: true,
            });
          } else {
            response = await fetchWithResetRetry(
              (retryRecovery) => {
                // Record every helper-driven send (the callback runs for the first attempt and
                // each connection-reset replay); preserve the caller's recovery kind
                // (rate-limit-429 / key-429) when the retry layer supplies none.
                deps.onAttemptSend?.(retryRecovery ?? recovery);
                const h = new Headers(request.headers);
                if (!h.has("accept-encoding")) h.set("accept-encoding", "identity");
                return fetchImpl(request.url, {
                  method: request.method,
                  headers: h,
                  body: request.body,
                  signal: headerDeadline.signal,
                });
              },
              { abortSignal: headerDeadline.signal, label: "image-bridge-loop" },
            );
          }
        } finally {
          request.releaseBodyObservation?.();
        }
        return { response, responseAdapter: requestAdapter };
      };

      let prepared = await fetchOnce(adapter);
      // Same-target 429 wait-and-retry (opt-in `retryOn429`) BEFORE key rotation: a primary-key
      // rate-limit blip replays on the SAME key; rotation only runs after attempts exhaust.
      while (
        prepared.response.status === 429
        && rateLimitRetryPolicy !== null
        && rateLimitRetries < rateLimitRetryPolicy.attempts
      ) {
        rateLimitRetries += 1;
        // Release unread body + heartbeat-fed wait via the shared same-target helper.
        const retryAfterHeader = prepared.response.headers.get("retry-after");
        // The old header deadline must not stay armed across the deliberate wait: clear it
        // before sleeping so a stale expiry can never race the client-cancel path.
        headerDeadline.clear();
        try {
          yield* prepareSameTarget429Wait({
            body: prepared.response.body,
            signal,
            delayMs: rateLimitRetryDelayMs(rateLimitRetryPolicy, retryAfterHeader, Date.now()),
            heartbeatIntervalMs: Math.min(10_000, Math.max(250, stallTimeoutMs / 2)),
          });
        } catch {
          throw new LoopError(499, "client closed request during image-bridge");
        }
        // Client cancellation wins over any stale-deadline edge: re-check before telemetry/replay.
        if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
        // The deliberate backoff must not consume the cumulative response-header deadline:
        // start a fresh one so the replay gets a new connect budget (504 stays reserved for real
        // upstream latency).
        headerDeadline = clearableDeadline(connectTimeoutMs, signal);
        // Stall-watchdog seam between bounded retry fetches.
        yield { type: "heartbeat" };
        prepared = await fetchOnce(adapter, "rate-limit-429");
      }
      // 429 key-failover parity with web-search / normal routed path.
      while (prepared.response.status === 429 && deps.on429) {
        const rotated = deps.on429(prepared.response.headers.get("retry-after"));
        if (!rotated) break;
        try { void prepared.response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
        adapter = rotated;
        yield { type: "heartbeat" };
        prepared = await fetchOnce(adapter, "key-429");
      }

      // Final headers have arrived. Clear only the deadline timer before ANY body read.
      headerDeadline.clear();
      if (!prepared.response.ok) {
        try {
          await readBoundedResponseBody(prepared.response, { signal });
        } catch {
          if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
          throw safeUnknownLoopError(prepared.response.status, "request");
        }
        throw safeUnknownLoopError(prepared.response.status, "request");
      }
      return prepared;
    } catch (error) {
      if (isTranslatorBudgetExceededError(error)) throw error;
      if (headerDeadline.didExpire()) {
        throw new LoopError(504, `Provider response-header timeout after ${connectTimeoutMs}ms during image-bridge`);
      }
      if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
      if (error instanceof LoopError) throw error;
      throw safeUnknownLoopError(502, "request");
    } finally {
      headerDeadline.clear();
    }
  };

  const prepareIterationDrained = async (
    availability: { webSearch: boolean; image: boolean; video: boolean },
    forceFinal: boolean,
  ): Promise<IterationResponse> => {
    const it = prepareIterationEvents(availability, forceFinal);
    let r = await it.next();
    while (!r.done) r = await it.next();
    return r.value;
  };

  // Consume and validate one successful response body. Only invisible heartbeat events escape while
  // semantic output remains buffered for safe scanning.
  const consumeIterationEvents = async function* (prepared: IterationResponse): AsyncGenerator<AdapterEvent, IterationSplit> {
    const events: AdapterEvent[] = [];
    let adapterTerminalFailure: Extract<AdapterEvent, { type: "error" }> | undefined;
    try {
      const rawParse = prepared.responseAdapter.parseStream.bind(prepared.responseAdapter);
      const parse: ProviderAdapter["parseStream"] = async function* (response, budget) {
        for await (const event of rawParse(response, budget)) {
          if (event.type === "error") adapterTerminalFailure = event;
          yield event;
        }
      };
      for await (const event of parseStreamWithProgress(prepared.response, parse, {
        signal,
        inactivityTimeoutMs: webSearchPlan?.routedModelStallTimeoutMs ?? stallTimeoutMs,
        translatorBudget,
      })) {
        if (event.type === "heartbeat") yield event;
        else if (webSearchPlan && event.type === "text_delta" && event.phase === "commentary") yield event;
        else events.push(event);
      }
    } catch (error) {
      if (isTranslatorBudgetExceededError(error)) throw error;
      if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
      if (adapterTerminalFailure) throw safeAdapterLoopError(adapterTerminalFailure, "stream");
      if (error instanceof RoutedModelInactivityError) throw safeUnknownLoopError(504, "stream");
      if (error instanceof WebSearchStreamProtocolError) throw safeUnknownLoopError(502, "stream");
      throw safeUnknownLoopError(502, "stream");
    }

    const terminalIndexes = events.flatMap((event, index) =>
      event.type === "done" || event.type === "incomplete" || event.type === "error" ? [index] : []);
    if (terminalIndexes.length !== 1 || terminalIndexes[0] !== events.length - 1) {
      throw new LoopError(502, `Image-bridge adapter stream protocol error: expected one final terminal event, received ${terminalIndexes.length}`);
    }
    const terminal = events[terminalIndexes[0]!];
    if (terminal.type === "error") {
      if (terminal.code === "translation_buffer_limit") {
        throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
      }
      throw safeAdapterLoopError(terminal, "stream");
    }
    const collisionKey = prepared.responseAdapter.toolCallIdCollisionKey;
    const split = scanAuxiliaryToolCalls(events, {
      webSearch: webSearchPlan !== undefined,
      image: plan?.toolNames ?? new Set<string>(),
      video: videoPlan?.toolNames ?? new Set<string>(),
    }, historicalToolCallIds(messages, collisionKey), collisionKey);
    if (split.malformedSyntheticCall) {
      throw new LoopError(502, "Auxiliary adapter stream protocol error: unterminated synthetic tool call");
    }
    if (isIncompleteAdapterTerminalEvent(terminal) && split.calls.length > 0) {
      throw new LoopError(502, "Auxiliary adapter stream protocol error: incomplete synthetic tool turn");
    }
    return split;
  };

  async function* executeWebSearchCall(call: AuxiliaryToolCall): AsyncGenerator<
    AdapterEvent,
    { args: Record<string, unknown>; content: string; isError: boolean }
  > {
    if (!webSearchPlan) {
      return { args: {}, content: "web search handler is unavailable", isError: true };
    }
    const queries = parseWebSearchQueries(call.args);
    const outcomes: { query: string; outcome: SidecarOutcome }[] = [];
    let beganCell = false;
    if (queries.length === 0) {
      webSearchesExecuted += 1;
      outcomes.push({
        query: "",
        outcome: { text: "", sources: [], error: "the model called web_search with an empty query" },
      });
    }
    for (const query of queries) {
      yield { type: "heartbeat" };
      let outcome: SidecarOutcome;
      const normalized = normalizeWebSearchQuery(query);
      if (failedWebSearchQueries.has(normalized)) {
        outcome = {
          text: "",
          sources: [],
          error: "this query already failed earlier in the turn; answer from existing context",
        };
      } else if (webSearchesExecuted >= webSearchMax) {
        outcome = {
          text: "",
          sources: [],
          error: `web_search allowance exhausted; global iteration ceiling ${HARD_CAP}`,
        };
      } else {
        if (!beganCell) {
          beganCell = true;
          yield { type: "web_search_call_begin", id: call.id };
        }
        try {
          outcome = webSearchPlan.backend === "anthropic" && webSearchPlan.anthropicSidecar
            ? await runAnthropicWebSearch(
                query,
                webSearchPlan.anthropicSidecar.providerName,
                webSearchPlan.anthropicSidecar.provider,
                webSearchPlan.settings,
                signal,
              )
            : await runWebSearch(
                query,
                webSearchPlan.hostedTool,
                webSearchPlan.forwardProvider!,
                webSearchPlan.selectedForwardHeaders,
                webSearchPlan.settings,
                signal,
                webSearchPlan.recordSidecarOutcome,
              );
          if (signal.aborted) throw new LoopError(499, "client closed request during web-search");
        } catch (error) {
          if (error instanceof LoopError) throw error;
          if (signal.aborted) throw new LoopError(499, "client closed request during web-search");
          outcome = {
            text: "",
            sources: [],
            error: "sidecar failed",
          };
        }
        webSearchesExecuted += 1;
        webSearchExecutedCount += 1;
        if (outcome.error) failedWebSearchQueries.add(normalized);
      }
      outcomes.push({ query, outcome });
    }

    if (beganCell) {
      const sources: { url: string; title?: string }[] = [];
      const seenSources = new Set<string>();
      for (const { outcome } of outcomes) {
        for (const source of outcome.sources) {
          if (seenSources.has(source.url)) continue;
          seenSources.add(source.url);
          sources.push(source.title ? { url: source.url, title: source.title } : { url: source.url });
        }
      }
      yield {
        type: "web_search_call_end",
        id: call.id,
        queries,
        status: outcomes.some(item => !item.outcome.error) ? "completed" : "failed",
        ...(sources.length > 0 ? { sources } : {}),
      };
    }

    const args: Record<string, unknown> = queries.length > 1
      ? { queries }
      : { query: queries[0] ?? "" };
    return {
      args,
      content: formatWebSearchResults(outcomes, !!parsed._structuredOutput),
      isError: outcomes.every(item => !!item.outcome.error),
    };
  }

  // Eagerly acquire only the FIRST iteration's final headers so connect/header/HTTP failures remain
  // non-2xx JSON. Skip for runTurn adapters: their "headers" are synthetic, and awaiting
  // queue.collect() before returning SSE starves clients of headers/heartbeats on slow first turns.
  const skipEagerDrain = !!adapter.runTurn;
  let firstPrepared: IterationResponse | undefined;
  if (!skipEagerDrain) {
    try {
      const initialAvailability = {
        webSearch: webSearchMax > 0,
        image: imageMaxRounds > 0,
        video: videoMaxRounds > 0,
      };
      firstPrepared = await prepareIterationDrained(
        initialAvailability,
        !initialAvailability.webSearch && !initialAvailability.image && !initialAvailability.video,
      );
    } catch (e) {
      if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
      const failure = e instanceof LoopError ? e : safeUnknownLoopError(502, "request");
      return jsonError(failure.status, failure.message, failure.errorType, failure.code ?? null);
    }
  }

  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeform = new Set<string>();
  const toolSearch = new Set<string>();
  for (const t of parsed.context.tools ?? []) {
    if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
    if (t.freeform) freeform.add(t.name);
    if (t.toolSearch) toolSearch.add(t.name);
  }

  // Drive the remaining iterations live. Image generation runs interleaved with the real sidecar
  // timing; the final answer's passthrough events come last.
  async function* produce(): AsyncGenerator<AdapterEvent> {
    const imageArtifacts = createImageArtifactProtectionScope();
    const videoDeliveryLeases: Array<() => void> = [];
    const leasedVideoArtifactIds = new Set<string>();
    let prepared = firstPrepared;
    let imageRoundsUsed = 0;
    let videoRoundsUsed = 0;
    try {
      for (let i = 0; i < HARD_CAP; i++) {
        const atGlobalCeiling = i === HARD_CAP - 1;
        const availability = {
          webSearch: !atGlobalCeiling && webSearchesExecuted < webSearchMax,
          image: !atGlobalCeiling
            && !imageSubmissionOutcomeUnknown
            && !imagePaidSubmissionConsumedWithoutArtifact
            && imageRoundsUsed < imageMaxRounds,
          video: !atGlobalCeiling && videoRoundsUsed < videoMaxRounds,
        };
        const forceFinal = !availability.webSearch && !availability.image && !availability.video;
        try {
          // First loop turn reuses the eager HEADERS when present. runTurn (and later iterations)
          // acquire headers inside the live SSE stream so clients already have the response open.
          if (!prepared || i > 0) {
            yield { type: "heartbeat" };
            prepared = yield* prepareIterationEvents(availability, forceFinal);
          }
          // Raw-byte progress heartbeats reach the bridge; semantic events remain buffered.
          const split = yield* consumeIterationEvents(prepared);
          prepared = undefined;

          const exhaustedCall = split.calls.find(call =>
            (call.handler === "web_search" && !availability.webSearch)
            || (call.handler === "image" && !availability.image)
            || (call.handler === "video" && !availability.video));
          if (exhaustedCall) {
            const exhaustedHandler = exhaustedCall.handler;
            throw new LoopError(
              409,
              `${exhaustedHandler} auxiliary allowance exhausted; global iteration ceiling ${HARD_CAP}`,
            );
          }
          if (atGlobalCeiling && split.calls.length > 0) {
            throw new LoopError(409, `auxiliary global iteration ceiling ${HARD_CAP} exhausted`);
          }

          // Loop (fulfill + re-ask) ONLY when the model's actionable output is purely image_gen. A
          // real tool call means this turn is terminal for Codex — finalize so those calls reach
          // Codex. forceFinal also finalizes.
          const shouldLoop = split.calls.length > 0 && !split.hasRealToolCall && !forceFinal;
          if (!shouldLoop) {
            if (forceFinal) {
              const completed = split.passthrough.some(event => event.type === "done");
              const visibleText = split.passthrough.some(event =>
                event.type === "text_delta"
                && event.phase !== "commentary"
                && event.text.trim().length > 0);
              if (completed && !split.hasRealToolCall && !visibleText) {
                throw new LoopError(502, "forced-final auxiliary pass produced no usable assistant output");
              }
            }
            if (hiddenUsage) {
              for (let i = split.passthrough.length - 1; i >= 0; i--) {
                const e = split.passthrough[i];
                if (e?.type === "done" || e?.type === "incomplete") {
                  split.passthrough[i] = { ...e, usage: combineUsage(hiddenUsage, e.usage) };
                  break;
                }
              }
            }
            yield* replay(split.passthrough);
            return;
          }

          // Discarded iteration still contributed tokens — accumulate for the final onUsage.
          takeUsageFrom(split.passthrough);

          if (split.calls.some(call => call.handler === "image")) imageRoundsUsed += 1;
          if (split.calls.some(call => call.handler === "video")) videoRoundsUsed += 1;

          // Fulfill each image/video call, then inject ONE assistant turn (thinking once + all tool
          // calls) so Anthropic extended-thinking continuations stay valid across parallel calls.
          const iterationThinking = extractIterationThinking(split.passthrough);
          const fulfilled: Array<{
            call: AuxiliaryToolCall;
            args: Record<string, unknown>;
            content: string;
            isError: boolean;
            result?: Awaited<ReturnType<typeof fulfillImageCall>>;
          }> = [];

          // Paid media fulfillment is batch-atomic at the validation boundary. Parse and validate
          // every intercepted image/video call before the first provider submission so a valid
          // call cannot spend before a malformed, unauthorized, over-count, or over-budget sibling
          // later in model order is discovered.
          const parsedMediaArgs = new Map<AuxiliaryToolCall, Record<string, unknown>>();
          const videoArguments = new Map<
            AuxiliaryToolCall,
            Extract<ReturnType<typeof parseVideoCallArgs>, { ok: true }>
          >();
          const mediaArgumentErrors = new Map<AuxiliaryToolCall, string>();
          const mediaCalls = split.calls.filter(call => call.handler === "image" || call.handler === "video");
          for (const call of mediaCalls) {
            parsedMediaArgs.set(call, parsedAuxiliaryCallArguments(call.args));
            if (call.handler === "video") {
              if (!videoPlan) {
                mediaArgumentErrors.set(call, "video generation is not authorized for this turn");
                continue;
              }
              const args = parseVideoCallArgs(call.args, videoPlan.mediaInputs);
              if (args.ok) videoArguments.set(call, args);
              else mediaArgumentErrors.set(call, args.error);
              continue;
            }
            if (!plan) {
              mediaArgumentErrors.set(call, "image generation is not authorized for this turn");
              continue;
            }
            const error = imageArgumentError(call.args);
            if (error) mediaArgumentErrors.set(call, error);
          }

          const videoCallCount = split.calls.filter(call => call.handler === "video").length;
          const videoBatchError = videoCallCount > MAX_VIDEO_CALLS_PER_TURN
            ? `video call batch exceeds the per-turn maximum of ${MAX_VIDEO_CALLS_PER_TURN}`
            : undefined;
          const imageRequestedTotal = split.calls.filter(call => call.handler === "image")
            .reduce((sum, call) => sum + imageRequestedCount(call.args), 0);
          const imageBatchBudgetError = imageRequestedTotal > MAX_IMAGE_CALLS_PER_TURN - paidImageCalls
            ? `image call batch exceeds the remaining per-turn budget of ${Math.max(0, MAX_IMAGE_CALLS_PER_TURN - paidImageCalls)}`
            : undefined;
          const videoBatchBudgetError = videoCallCount > 0
            && videoSubmissionBudgetUsed >= MAX_VIDEO_CALLS_PER_TURN
            ? `video call budget exhausted (max ${MAX_VIDEO_CALLS_PER_TURN} per turn)`
            : undefined;
          const mediaBatchError = videoBatchError
            ?? imageBatchBudgetError
            ?? videoBatchBudgetError
            ?? (mediaArgumentErrors.size > 0 ? "auxiliary batch contains invalid media arguments" : undefined);

          for (const call of split.calls) {
            if (call.handler === "web_search") {
              const search = executeWebSearchCall(call);
              let next = await search.next();
              while (!next.done) {
                yield next.value;
                next = await search.next();
              }
              fulfilled.push({ call, ...next.value });
              continue;
            }
            const isVideoCall = call.handler === "video";
            if (isVideoCall) {
              if (mediaBatchError) {
                const vResult = {
                  ok: false, model: videoPlan?.model ?? "", prompt: "", files: [], count: 0,
                  error: mediaArgumentErrors.get(call) ?? mediaBatchError,
                };
                fulfilled.push({
                  call,
                  result: vResult,
                  args: parsedMediaArgs.get(call) ?? {},
                  content: JSON.stringify(safeMediaToolResult(vResult, "video")),
                  isError: true,
                });
                continue;
              }
              if (videoSubmissionBudgetUsed >= MAX_VIDEO_CALLS_PER_TURN) {
                const vResult = {
                  ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0,
                  error: `video call budget exhausted (max ${MAX_VIDEO_CALLS_PER_TURN} per turn)`,
                };
                fulfilled.push({
                  call,
                  result: vResult,
                  args: parsedMediaArgs.get(call) ?? {},
                  content: JSON.stringify(safeMediaToolResult(vResult, "video")),
                  isError: true,
                });
                continue;
              }
              const vArgs = videoArguments.get(call)!;
              let vResult;
              const videoTimeout = videoTimeoutMs ?? 300_000;
              try {
                  const videoDeadline = Date.now() + videoTimeout;
                  let operationIdentity = deps.videoOperationIdentity;
                  if (!operationIdentity && deps.resolveVideoOperationIdentity) {
                    try { operationIdentity = deps.resolveVideoOperationIdentity(); } catch { /* typed denial below */ }
                  }
                  const runtime = deps.videoRuntime ?? getDefaultModelVideoRuntime();
                  if (deps.resolveVideoOperationIdentity && !operationIdentity) {
                    vResult = {
                      ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0,
                      error: "video retry protection is unavailable",
                    };
                  } else if (!runtime) {
                    vResult = {
                      ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0,
                      error: "video recovery is unavailable (recovery_blocked)",
                    };
                  } else {
                    // Debit before dispatch settles: an ambiguous paid POST can be acknowledged
                    // concurrently and release durable admission, but it must not reopen this
                    // turn's one-submission allowance. Busy is the only proven no-dispatch result.
                    videoSubmissionBudgetUsed += 1;
                    const binding = bindPlanAuth(videoPlan!);
                    const submission = await runtime.submitVideo({
                      binding,
                      deadlineAt: videoDeadline,
                      ...(operationIdentity ?? {}),
                      request: {
                        prompt: vArgs.prompt,
                        model: videoPlan!.model,
                        ...(vArgs.mode !== "text" ? { mode: vArgs.mode } : {}),
                        ...(vArgs.startingImage ? { startingImage: vArgs.startingImage } : {}),
                        ...(vArgs.referenceImages ? { referenceImages: vArgs.referenceImages } : {}),
                        duration: vArgs.duration,
                        resolution: vArgs.resolution,
                        aspectRatio: vArgs.aspectRatio,
                        ...(vArgs.audio !== undefined ? { audio: vArgs.audio } : {}),
                      },
                      signal,
                    });
                    if (submission.kind === "busy") {
                      videoSubmissionBudgetUsed -= 1;
                      vResult = {
                        ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0,
                        ...(submission.job ? { jobId: submission.job.id } : {}),
                        error: "video_busy: another video job is active for this credential",
                      };
                    } else {
                      let job = submission.job;
                      acquireCompletedVideoDeliveryLease(
                        runtime,
                        job,
                        videoDeliveryLeases,
                        leasedVideoArtifactIds,
                        submission.kind === "replay" ? submission.releaseArtifactDeliveryLease : undefined,
                      );
                      if (VIDEO_WAITING_STATES.has(job.state)) {
                        runtime.startVideoJob(job.id);
                        // Terminal replays skip this progress item entirely. In particular,
                        // a completed replay owns its delivery lease before any new yield.
                        yield {
                          type: "text_delta",
                          phase: "commentary",
                          text: `Video accepted. Job ${job.id} is generating in the background.`,
                        };
                      }
                      while (VIDEO_WAITING_STATES.has(job.state)) {
                        const update = await runtime.waitForVideoUpdate(job.id, job.revision, {
                          signal,
                          timeoutMs: 2_000,
                        });
                        if (update.kind === "timeout") {
                          yield { type: "heartbeat" };
                          continue;
                        }
                        if (update.kind === "updated") {
                          job = update.job;
                          acquireCompletedVideoDeliveryLease(
                            runtime,
                            job,
                            videoDeliveryLeases,
                            leasedVideoArtifactIds,
                          );
                          yield { type: "heartbeat" };
                          continue;
                        }
                        if (signal.aborted) throw new LoopError(499, "client closed request during video-bridge");
                        vResult = {
                          ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0,
                          jobId: job.id,
                          error: `video_detached: generation continues as job ${job.id}; inspect it in the dashboard or with ccx media status`,
                        };
                        break;
                      }
                      if (!vResult) {
                        if (job.state === "completed" && job.artifactId) {
                          acquireCompletedVideoDeliveryLease(
                            runtime,
                            job,
                            videoDeliveryLeases,
                            leasedVideoArtifactIds,
                          );
                          const path = resolveArtifactPath(job.artifactId);
                          vResult = path
                            ? buildVideoResult(path, vArgs.prompt, videoPlan!.model, {
                                duration: vArgs.duration,
                                resolution: vArgs.resolution,
                                aspectRatio: vArgs.aspectRatio,
                                ...(vArgs.audio !== undefined ? { audio: vArgs.audio } : {}),
                                jobId: job.id,
                              })
                            : {
                                ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0,
                                jobId: job.id,
                                error: "video artifact is not available locally",
                              };
                        } else {
                          const guidance = job.state === "outcome_unknown"
                            ? "the submission outcome is unknown; acknowledge it in the dashboard or CLI before retrying"
                            : `video job ended in state ${job.state}`;
                          vResult = {
                            ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0,
                            jobId: job.id,
                            error: `${guidance}${job.safeError ? ` (${job.safeError})` : ""}`,
                          };
                        }
                      }
                    }
                  }
              } catch (e) {
                if (signal.aborted) {
                  throw new LoopError(499, "client closed request during video-bridge");
                } else {
                  const recoveryJobId = mediaRecoveryJobId(e);
                  vResult = recoveryJobId
                    ? {
                        ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0,
                        jobId: recoveryJobId,
                        error: "submission_outcome_unknown",
                      }
                    : {
                        ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0,
                        error: e instanceof Error ? e.message : String(e),
                      };
                }
              }
              if (signal.aborted) throw new LoopError(499, "client closed request during video-bridge");
              // Runtime completion pins are deliberately short-lived. Adopt successful video
              // paths into the request scope before a later handler can await and expose them to
              // concurrent retention before replay.
              imageArtifacts.protect(vResult.files);
              fulfilled.push({
                call,
                result: vResult,
                args: parsedMediaArgs.get(call) ?? {},
                content: JSON.stringify(safeMediaToolResult(vResult, "video")),
                isError: !vResult.ok,
              });
            } else {
              yield { type: "heartbeat" };
              if (!plan) {
                const unavailable = { ok: false, model: "", prompt: "", files: [], count: 0, error: "image bridge not configured" };
                fulfilled.push({
                  call,
                  result: unavailable,
                  args: {},
                  content: JSON.stringify(safeMediaToolResult(unavailable, "image")),
                  isError: true,
                });
                continue;
              }
              let result: Awaited<ReturnType<typeof fulfillImageCall>>;
              if (mediaBatchError) {
                result = {
                  ok: false,
                  model: plan.model,
                  prompt: "",
                  files: [],
                  count: 0,
                  error: mediaArgumentErrors.get(call) ?? mediaBatchError,
                };
              } else if (imageSubmissionOutcomeUnknown) {
                result = {
                  ok: false,
                  model: plan.model,
                  prompt: "",
                  files: [],
                  count: 0,
                  error: "submission_outcome_unknown: image generation is disabled for the rest of this turn",
                  dispatchCertainty: "ambiguous",
                };
              } else if (paidImageCalls >= MAX_IMAGE_CALLS_PER_TURN) {
                result = {
                  ok: false,
                  model: plan.model,
                  prompt: "",
                  files: [],
                  count: 0,
                  error: `image call budget exhausted (max ${MAX_IMAGE_CALLS_PER_TURN} per turn)`,
                };
              } else {
                paidImageCalls += imageRequestedCount(call.args);
                try {
                  const binding = bindPlanAuth(plan);
                  result = await fulfillImageCall(
                    { id: call.id, name: call.name, arguments: call.args },
                    { ...plan, auth: binding }, budget, signal, imageArtifacts,
                  );
                } catch {
                  result = { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "needs_auth" };
                }
                if (result.dispatchCertainty === "ambiguous") {
                  imageSubmissionOutcomeUnknown = true;
                }
                if (result.paidSubmissionConsumed && !result.ok) {
                  imagePaidSubmissionConsumedWithoutArtifact = true;
                }
              }
              imageArtifacts.protect(result.files);
              if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
              fulfilled.push({
                call,
                result,
                args: parsedMediaArgs.get(call) ?? {},
                content: JSON.stringify(safeMediaToolResult(result, "image")),
                isError: !result.ok,
              });
            }
          }
          // Prune artifacts once after the entire batch so a tight keepCount
          // cannot delete a video from an earlier call in this same iteration.
          // Durable video jobs own their pins. The legacy generic pruner is image-only here.
          if (plan) pruneArtifacts(plan.artifactsKeepCount);
          // Drop results whose artifact files were pruned — never hand the model a dead path.
          for (const f of fulfilled) {
            if (!f.result || !f.result.ok || !f.result.files || f.result.files.length === 0) continue;
            const survivors = f.result.files.filter(p => existsSync(p));
            if (survivors.length === f.result.files.length) continue; // nothing pruned
            if (survivors.length === 0) {
              f.result = {
                ok: false, model: f.result.model, prompt: f.result.prompt ?? "",
                files: [], count: 0,
                error: "artifact was pruned before delivery (increase artifactsKeepCount)",
              } as typeof f.result;
            } else {
              // Some files survived — refresh from survivors
              f.result = { ...f.result, files: survivors, count: survivors.length };
              const primary = survivors[0]!;
              (f.result as { path?: string }).path = primary;
              if ("markdown" in f.result && f.result.markdown) {
                // Image markdown references the primary path; video uses pathToFileURL
                if (f.result.markdown.startsWith("![")) {
                  (f.result as { markdown: string }).markdown = `![image](${pathToFileURL(primary).href})`;
                } else {
                  (f.result as { markdown: string }).markdown = `[video](${pathToFileURL(primary).href})`;
                }
              }
            }
            f.content = JSON.stringify(safeMediaToolResult(
              f.result,
              f.call.handler === "video" ? "video" : "image",
            ));
            f.isError = !f.result.ok;
          }
          const now = Date.now();
          messages.push({
            role: "assistant",
            content: [
              ...iterationThinking,
              ...fulfilled.map(({ call, args }) => ({
                type: "toolCall" as const,
                id: call.id,
                name: call.name,
                arguments: args,
              })),
            ],
            timestamp: now,
          });
          for (const { call, content, isError } of fulfilled) {
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content,
              isError,
              timestamp: now,
            });
          }
        } catch (e) {
          if (isTranslatorBudgetExceededError(e)) {
            yield {
              type: "error",
              status: 502,
              errorType: "upstream_error",
              code: e.code,
              message: "upstream translation buffer exceeded the safe limit",
              ...(hiddenUsage ? { usage: hiddenUsage } : {}),
            };
          } else {
            const failure = e instanceof LoopError ? e : safeUnknownLoopError(502, "request");
            yield {
              type: "error",
              message: failure.message,
              status: failure.status,
              ...(failure.errorType ? { errorType: failure.errorType } : {}),
              ...(failure.code ? { code: failure.code } : {}),
              ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
              ...(hiddenUsage ? { usage: hiddenUsage } : {}),
            };
          }
          return;
        }
      }
    } finally {
      for (const release of videoDeliveryLeases.splice(0)) release();
      imageArtifacts.close();
      if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
    }
  }

  const sse = bridgeToResponsesSSE(
    produce(), parsed.modelId, toolNsMap, freeform, toolSearch, () => {
      internalAbort.abort("client closed responses stream");
    }, 2_000,
    {
      translatorBudget,
      replayCacheScope: parsed._clientThreadId ?? "global",
      ...(deps.toolParameterSchemas ? { toolParameterSchemas: deps.toolParameterSchemas } : {}),
      ...(deps.forceEmptyResponseId ? { responseId: "" } : {}),
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      stallTimeoutSec: deps.stallTimeoutSec,
      ...(deps.onFirstOutput ? { onFirstOutput: deps.onFirstOutput } : {}),
      ...(deps.onUsage ? {
        // Terminal done/incomplete already includes hiddenUsage (merged above). Do not
        // add it again here or request logs double-count multi-iteration image turns.
        onUsage: (usage: CodexCommanderUsage | undefined) => deps.onUsage?.(usage),
      } : {}),
      ...(deps.onCompletedResponse ? { onCompletedResponse: deps.onCompletedResponse } : {}),
    },
  );
  return new Response(sse, { headers: SSE_HEADERS });
}

/** Compatibility value for historical direct image-loop callers. */
export const runWithImageBridge = runResponsesAuxiliaryLoop;

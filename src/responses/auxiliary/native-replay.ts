import type { CodexCommanderUsage } from "../../types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface NativeResponsesAuxiliaryCall {
  call: Record<string, unknown>;
  callId: string;
  name: string;
  arguments: string;
}

export interface NativeResponsesInspection {
  raw: string;
  outputItems: Record<string, unknown>[];
  auxiliaryCalls: NativeResponsesAuxiliaryCall[];
  hasRealFunctionCall: boolean;
  /** Any non-exact, malformed, namespaced, duplicate-id, or future actionable output item. */
  hasUnsafeActionableCall: boolean;
  completedResponse?: Record<string, unknown>;
  usage?: CodexCommanderUsage;
  terminal: "completed" | "incomplete" | "failed";
}

interface ParsedSsePayloads {
  payloads: Record<string, unknown>[];
  malformed: boolean;
}

function ssePayloads(raw: string): ParsedSsePayloads {
  const payloads: Record<string, unknown>[] = [];
  let malformed = false;
  let terminalSeen = false;
  let doneSeen = false;
  let lastSequenceNumber: number | undefined;
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    if (!frame.trim()) continue;
    if (doneSeen) {
      malformed = true;
      continue;
    }
    const lines = frame.split(/\r?\n/);
    const eventNames = lines
      .filter(line => line.startsWith("event:"))
      .map(line => line.slice(6).replace(/^ /, ""));
    const data = lines
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) {
      if (eventNames.length > 0) malformed = true;
      if (terminalSeen) malformed = true;
      continue;
    }
    if (data === "[DONE]") {
      if (eventNames.length > 0 || !terminalSeen) malformed = true;
      doneSeen = true;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(data);
      const payload = record(parsed);
      if (!payload) {
        malformed = true;
        continue;
      }
      if (typeof payload.type !== "string" || payload.type.length === 0) {
        malformed = true;
        continue;
      }
      if (Object.hasOwn(payload, "sequence_number")) {
        const sequenceNumber = payload.sequence_number;
        if (
          typeof sequenceNumber !== "number"
          || !Number.isSafeInteger(sequenceNumber)
          || sequenceNumber < 0
          || (lastSequenceNumber !== undefined && sequenceNumber <= lastSequenceNumber)
        ) {
          malformed = true;
        } else {
          lastSequenceNumber = sequenceNumber;
        }
      }
      if (terminalSeen) malformed = true;
      if (
        eventNames.length > 1
        || (eventNames.length === 1 && eventNames[0] !== payload.type)
      ) {
        malformed = true;
      }
      payloads.push(payload);
      if (
        payload.type === "response.completed"
        || payload.type === "response.incomplete"
        || payload.type === "response.failed"
        || payload.type === "error"
      ) {
        terminalSeen = true;
      }
    } catch {
      // Unknown/non-JSON provider frames remain in `raw` and are relayed unchanged on a final
      // iteration, but make any synthetic paid-call iteration fail closed.
      malformed = true;
    }
  }
  return { payloads, malformed };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function nativeUsage(value: unknown): CodexCommanderUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  const inputDetails = record(usage.input_tokens_details);
  const outputDetails = record(usage.output_tokens_details);
  return {
    inputTokens,
    outputTokens,
    ...(inputDetails ? { cachedInputTokens: nonNegativeInteger(inputDetails.cached_tokens) } : {}),
    ...(outputDetails ? { reasoningOutputTokens: nonNegativeInteger(outputDetails.reasoning_tokens) } : {}),
  };
}

function responsesUsage(usage: CodexCommanderUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { input_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
    ...(usage.reasoningOutputTokens !== undefined
      ? { output_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens } }
      : {}),
  };
}

/**
 * Replace only the terminal native usage counters after hidden synthetic iterations. Unknown
 * response fields, output items, lifecycle events, and provider extensions stay provider-native.
 */
export function mergeNativeResponsesCompletedUsage(
  raw: string,
  usage: CodexCommanderUsage | undefined,
): string {
  if (!usage) return raw;
  const frames = raw.split(/(\r?\n\r?\n)/);
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 2) {
    const frame = frames[frameIndex] ?? "";
    if (!frame) continue;
    const tokens = frame.split(/(\r?\n)/);
    const dataIndexes: number[] = [];
    for (let index = 0; index < tokens.length; index += 2) {
      if ((tokens[index] ?? "").startsWith("data:")) dataIndexes.push(index);
    }
    if (dataIndexes.length === 0) continue;
    const json = dataIndexes
      .map(index => (tokens[index] ?? "").slice(5).replace(/^ /, ""))
      .join("\n");
    try {
      const payload = record(JSON.parse(json));
      const response = record(payload?.response);
      if ((payload?.type !== "response.completed" && payload?.type !== "response.incomplete") || !response) continue;
      const priorUsage = record(response.usage);
      const nextUsage = responsesUsage(usage);
      const inputDetails = record(priorUsage?.input_tokens_details);
      const outputDetails = record(priorUsage?.output_tokens_details);
      if (inputDetails || nextUsage.input_tokens_details) {
        nextUsage.input_tokens_details = {
          ...(inputDetails ?? {}),
          ...(record(nextUsage.input_tokens_details) ?? {}),
        };
      }
      if (outputDetails || nextUsage.output_tokens_details) {
        nextUsage.output_tokens_details = {
          ...(outputDetails ?? {}),
          ...(record(nextUsage.output_tokens_details) ?? {}),
        };
      }
      const firstDataIndex = dataIndexes[0]!;
      const firstDataLine = tokens[firstDataIndex] ?? "data:";
      const marker = firstDataLine.startsWith("data: ") ? "data: " : "data:";
      tokens[firstDataIndex] = `${marker}${JSON.stringify({
        ...payload,
        response: { ...response, usage: { ...(priorUsage ?? {}), ...nextUsage } },
      })}`;
      for (const extraDataIndex of dataIndexes.slice(1)) {
        tokens[extraDataIndex] = "";
        if (/^\r?\n$/.test(tokens[extraDataIndex + 1] ?? "")) tokens[extraDataIndex + 1] = "";
      }
      frames[frameIndex] = tokens.join("");
    } catch {
      // Non-JSON or nonterminal frames remain byte-identical.
    }
  }
  return frames.join("");
}

/**
 * Inspect one fully bounded native SSE iteration without translating any provider item. The raw
 * bytes (decoded UTF-8 text) remain the relay authority; parsed records are used only to decide
 * whether an exact synthetic function call must be fulfilled and replayed.
 */
export function inspectNativeResponsesSse(
  raw: string,
  auxiliaryNames: ReadonlySet<string>,
  replayIdentityBodies: readonly unknown[] = [],
): NativeResponsesInspection {
  const { payloads, malformed: malformedSsePayload } = ssePayloads(raw);
  const completedEvents = payloads.filter(payload => payload.type === "response.completed");
  const incompleteEvents = payloads.filter(payload => payload.type === "response.incomplete");
  const failedEvents = payloads.filter(payload => payload.type === "response.failed" || payload.type === "error");
  const completedEvent = completedEvents.at(-1);
  const incompleteEvent = incompleteEvents.at(-1);
  const failedEvent = failedEvents.at(-1);
  const terminalLifecycleConflict = completedEvents.length + incompleteEvents.length + failedEvents.length !== 1;
  const terminal: NativeResponsesInspection["terminal"] = completedEvent
    ? "completed"
    : incompleteEvent
      ? "incomplete"
      : "failed";
  const terminalEvent = completedEvent ?? incompleteEvent;
  const terminalResponse = record(terminalEvent?.response);
  const terminalResponseMalformed = terminalEvent !== undefined && terminalResponse === undefined;
  const terminalResponseStatusMalformed = (completedEvent !== undefined && terminalResponse?.status !== "completed")
    || (incompleteEvent !== undefined && terminalResponse?.status !== "incomplete");
  const completedResponse = completedEvent ? terminalResponse : undefined;
  const terminalOutputPresent = terminalResponse !== undefined && Object.hasOwn(terminalResponse, "output");
  const terminalHasOutput = Array.isArray(terminalResponse?.output);
  const terminalRawItems = terminalHasOutput ? terminalResponse.output as unknown[] : [];
  const terminalOutputMalformed = (terminalOutputPresent && !terminalHasOutput)
    || terminalRawItems.some(item => record(item) === undefined);
  const terminalOutputItems = terminalRawItems
    .map(record)
    .filter((item): item is Record<string, unknown> => item !== undefined);
  const donePayloads = payloads.filter(payload => payload.type === "response.output_item.done");
  const doneOutputMalformed = donePayloads.some(payload => record(payload.item) === undefined);
  const doneOutputItems = donePayloads
    .map(payload => record(payload.item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  const outputItems = terminalHasOutput ? terminalOutputItems : doneOutputItems;

  const hasReplayCriticalCallField = (item: Record<string, unknown>): boolean =>
    Object.hasOwn(item, "call_id")
    || Object.hasOwn(item, "arguments")
    || Object.hasOwn(item, "namespace");
  const hasNonEmptyItemId = (item: Record<string, unknown>): boolean =>
    typeof item.id === "string" && item.id.trim().length > 0;
  const isValidHostedWebSearchAction = (value: unknown): boolean => {
    const action = record(value);
    if (!action || typeof action.type !== "string") return false;
    if (action.type === "search") {
      const hasQuery = Object.hasOwn(action, "query");
      const hasQueries = Object.hasOwn(action, "queries");
      if (!hasQuery && !hasQueries) return false;
      const queryValid = !hasQuery
        || (typeof action.query === "string" && action.query.trim().length > 0);
      const queriesValid = !hasQueries
        || (Array.isArray(action.queries)
          && action.queries.length > 0
          && action.queries.every(query => typeof query === "string" && query.trim().length > 0));
      return queryValid && queriesValid;
    }
    if (action.type === "open_page") return typeof action.url === "string" && action.url.length > 0;
    return action.type === "find_in_page"
      && typeof action.url === "string"
      && action.url.length > 0
      && typeof action.pattern === "string"
      && action.pattern.length > 0;
  };
  const isSafeCompletedHostedWebSearch = (item: Record<string, unknown>): boolean =>
    !hasReplayCriticalCallField(item)
    && item.type === "web_search_call"
    && item.status === "completed"
    && hasNonEmptyItemId(item)
    && isValidHostedWebSearchAction(item.action);
  const isValidPassiveOutputItem = (item: Record<string, unknown>): boolean => {
    if (hasReplayCriticalCallField(item) || !hasNonEmptyItemId(item)) return false;
    if (item.type === "reasoning") {
      if (Object.hasOwn(item, "status") && item.status !== "completed") return false;
      const hasPayload = Object.hasOwn(item, "summary")
        || Object.hasOwn(item, "content")
        || Object.hasOwn(item, "encrypted_content");
      if (!hasPayload) return false;
      if (Object.hasOwn(item, "summary")) {
        if (!Array.isArray(item.summary) || !item.summary.every(part => {
          const summary = record(part);
          return summary?.type === "summary_text" && typeof summary.text === "string";
        })) return false;
      }
      if (Object.hasOwn(item, "content")) {
        if (!Array.isArray(item.content) || !item.content.every(part => {
          const content = record(part);
          return content?.type === "reasoning_text" && typeof content.text === "string";
        })) return false;
      }
      return !Object.hasOwn(item, "encrypted_content") || typeof item.encrypted_content === "string";
    }
    if (item.type !== "message" || item.status !== "completed" || item.role !== "assistant") {
      return false;
    }
    if (!Array.isArray(item.content) || item.content.length === 0) return false;
    return item.content.every(part => {
      const content = record(part);
      return content !== undefined
        && ((content.type === "output_text" && typeof content.text === "string")
          || (content.type === "text" && typeof content.text === "string")
          || (content.type === "refusal" && typeof content.refusal === "string"));
    });
  };
  const isPotentiallyActionable = (item: Record<string, unknown>): boolean => {
    if (hasReplayCriticalCallField(item)) return true;
    if (isSafeCompletedHostedWebSearch(item)) return false;
    return !isValidPassiveOutputItem(item);
  };

  // A provider may supply either the terminal output snapshot or output_item.done events. When it
  // supplies both, the call-shaped authority must agree before any paid proxy-owned action runs.
  // Otherwise a real/malformed call can be hidden in one view while an exact auxiliary call is
  // presented in the other. Compare the replay-critical identity rather than incidental provider
  // extensions, whose presence may legitimately differ between the incremental and terminal item.
  const outputAuthorityFingerprint = (item: Record<string, unknown>): string => {
    const ownField = (key: string): [boolean, unknown] => [
      Object.hasOwn(item, key),
      Object.hasOwn(item, key) ? item[key] : null,
    ];
    const action = record(item.action);
    const hostedSearchAction = item.type === "web_search_call" && action
      ? [
          [Object.hasOwn(action, "type"), action.type ?? null],
          [Object.hasOwn(action, "query"), action.query ?? null],
          [Object.hasOwn(action, "queries"), action.queries ?? null],
          [Object.hasOwn(action, "url"), action.url ?? null],
          [Object.hasOwn(action, "pattern"), action.pattern ?? null],
        ]
      : null;
    const passiveCore = item.type === "message"
      ? (item.content as unknown[] | undefined)?.map(part => {
          const content = record(part);
          return content
            ? [content.type ?? null, content.text ?? null, content.refusal ?? null]
            : null;
        }) ?? null
      : item.type === "reasoning"
        ? [
            item.summary ?? null,
            item.content ?? null,
            [Object.hasOwn(item, "encrypted_content"), item.encrypted_content ?? null],
          ]
        : null;
    return JSON.stringify([
      ownField("type"),
      ownField("id"),
      ownField("call_id"),
      ownField("name"),
      ownField("arguments"),
      ownField("namespace"),
      ownField("status"),
      ownField("role"),
      hostedSearchAction,
      passiveCore,
    ]);
  };
  const doneCallAuthority = doneOutputItems.map(outputAuthorityFingerprint);
  const terminalCallAuthority = terminalOutputItems.map(outputAuthorityFingerprint);
  const outputAuthorityMismatch = terminalHasOutput
    && donePayloads.length > 0
    && (doneCallAuthority.length !== terminalCallAuthority.length
      || doneCallAuthority.some((value, index) => value !== terminalCallAuthority[index]));

  // Only known passive items and a structurally completed provider-hosted search may coexist with
  // paid proxy-owned calls. Unknown/future output types fail closed instead of relying on suffixes.
  const actionableItems = outputItems.filter(isPotentiallyActionable);
  const functionCalls = outputItems.filter(item => item.type === "function_call");
  const exactAuxiliaryCalls = actionableItems.filter(item =>
    item.type === "function_call"
    && typeof item.id === "string"
    && item.id.trim().length > 0
    && typeof item.call_id === "string"
    && item.call_id.trim().length > 0
    && typeof item.name === "string"
    && typeof item.arguments === "string"
    && item.status === "completed"
    && !Object.hasOwn(item, "namespace")
    && auxiliaryNames.has(item.name));
  const auxiliaryCalls = exactAuxiliaryCalls
    .map(item => ({
      call: { ...item },
      callId: item.call_id as string,
      name: item.name as string,
      arguments: item.arguments as string,
    }));
  const callIds = new Set<string>();
  const existingItemIds = new Set<string>();
  const existingCallIds = new Set<string>();
  for (const replayBody of replayIdentityBodies) {
    const replaySource = record(replayBody);
    const replayInput = Array.isArray(replaySource?.input) ? replaySource.input : [];
    for (const value of replayInput) {
      const item = record(value);
      if (!item) continue;
      if (typeof item.id === "string" && item.id.trim().length > 0) existingItemIds.add(item.id);
      if (typeof item.call_id === "string" && item.call_id.trim().length > 0) existingCallIds.add(item.call_id);
    }
  }
  const hasDuplicateCallId = auxiliaryCalls.some(call => {
    if (existingCallIds.has(call.callId) || callIds.has(call.callId)) return true;
    callIds.add(call.callId);
    return false;
  });
  const itemIds = new Set<string>();
  const hasInvalidOrDuplicateItemId = outputItems.some(item => {
    if (!hasNonEmptyItemId(item)) return true;
    const itemId = item.id as string;
    if (existingItemIds.has(itemId) || itemIds.has(itemId)) return true;
    itemIds.add(itemId);
    return false;
  });
  const hasUnsafeActionableCall = malformedSsePayload
    || terminalOutputMalformed
    || doneOutputMalformed
    || outputAuthorityMismatch
    || terminalLifecycleConflict
    || terminalResponseMalformed
    || terminalResponseStatusMalformed
    || actionableItems.length !== auxiliaryCalls.length
    || hasDuplicateCallId
    || hasInvalidOrDuplicateItemId;
  return {
    raw,
    outputItems,
    auxiliaryCalls,
    hasRealFunctionCall: functionCalls.length > auxiliaryCalls.length,
    hasUnsafeActionableCall,
    ...(completedResponse ? { completedResponse } : {}),
    ...(terminalResponse?.usage ? { usage: nativeUsage(terminalResponse.usage) } : {}),
    terminal: failedEvent && !completedEvent && !incompleteEvent ? "failed" : terminal,
  };
}

export interface NativeAuxiliaryReplayPair {
  call: Record<string, unknown>;
  output: Record<string, unknown>;
}

/** Build an exact Responses function-call replay pair without chat translation. */
export function nativeAuxiliaryReplayPair(
  callItem: unknown,
  output: string,
): NativeAuxiliaryReplayPair | undefined {
  const call = record(callItem);
  if (!call || call.type !== "function_call" || typeof call.call_id !== "string" || typeof call.name !== "string") {
    return undefined;
  }
  return {
    call: { ...call },
    output: { type: "function_call_output", call_id: call.call_id, output },
  };
}

/** Append replay items to a clone while preserving every pre-existing native item. */
export function appendNativeAuxiliaryReplay(
  body: unknown,
  pairs: readonly NativeAuxiliaryReplayPair[],
): unknown {
  const source = record(body);
  if (!source || !Array.isArray(source.input) || pairs.length === 0) return body;
  return {
    ...source,
    input: [...source.input, ...pairs.flatMap(pair => [pair.call, pair.output])],
  };
}

/** Replay every exact native output item, inserting only the proxy-authored tool result pair. */
export function appendNativeAuxiliaryTurn(
  body: unknown,
  outputItems: readonly Record<string, unknown>[],
  outputs: ReadonlyMap<string, string>,
): unknown {
  const source = record(body);
  if (!source || outputItems.length === 0) return body;
  const input = Array.isArray(source.input)
    ? source.input
    : typeof source.input === "string"
      ? [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: source.input }],
        }]
      : source.input === undefined
        ? []
        : undefined;
  if (!input) return body;
  const replay: Record<string, unknown>[] = [];
  for (const item of outputItems) {
    replay.push({ ...item });
    if (item.type !== "function_call" || typeof item.call_id !== "string") continue;
    const output = outputs.get(item.call_id);
    if (output === undefined) continue;
    replay.push({ type: "function_call_output", call_id: item.call_id, output });
  }
  return { ...source, input: [...input, ...replay] };
}

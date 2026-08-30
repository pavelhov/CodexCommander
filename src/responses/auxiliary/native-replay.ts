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
  completedResponse?: Record<string, unknown>;
  usage?: CodexCommanderUsage;
  terminal: "completed" | "incomplete" | "failed";
}

function ssePayloads(raw: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    if (!frame.trim()) continue;
    const data = frame.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      const payload = record(parsed);
      if (payload) payloads.push(payload);
    } catch {
      // Unknown/non-JSON provider frames remain in `raw` and are relayed unchanged on a final
      // iteration. They cannot authorize a synthetic paid call.
    }
  }
  return payloads;
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
  return raw.replace(/(^|\r?\n)(data:\s*)(\{[^\r\n]*\})(?=\r?\n|$)/g, (line, prefix, marker, json) => {
    try {
      const payload = record(JSON.parse(json));
      const response = record(payload?.response);
      if ((payload?.type !== "response.completed" && payload?.type !== "response.incomplete") || !response) return line;
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
      return `${prefix}${marker}${JSON.stringify({
        ...payload,
        response: { ...response, usage: { ...(priorUsage ?? {}), ...nextUsage } },
      })}`;
    } catch {
      return line;
    }
  });
}

/**
 * Inspect one fully bounded native SSE iteration without translating any provider item. The raw
 * bytes (decoded UTF-8 text) remain the relay authority; parsed records are used only to decide
 * whether an exact synthetic function call must be fulfilled and replayed.
 */
export function inspectNativeResponsesSse(
  raw: string,
  auxiliaryNames: ReadonlySet<string>,
): NativeResponsesInspection {
  const payloads = ssePayloads(raw);
  const completedEvent = [...payloads].reverse().find(payload => payload.type === "response.completed");
  const incompleteEvent = [...payloads].reverse().find(payload => payload.type === "response.incomplete");
  const failedEvent = [...payloads].reverse().find(payload => payload.type === "response.failed" || payload.type === "error");
  const terminal: NativeResponsesInspection["terminal"] = completedEvent
    ? "completed"
    : incompleteEvent
      ? "incomplete"
      : "failed";
  const terminalResponse = record((completedEvent ?? incompleteEvent)?.response);
  const completedResponse = completedEvent ? terminalResponse : undefined;
  let outputItems = Array.isArray(terminalResponse?.output)
    ? terminalResponse.output.map(record).filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
  if (outputItems.length === 0) {
    outputItems = payloads
      .filter(payload => payload.type === "response.output_item.done")
      .map(payload => record(payload.item))
      .filter((item): item is Record<string, unknown> => item !== undefined);
  }

  const functionCalls = outputItems.filter(item =>
    item.type === "function_call"
    && typeof item.call_id === "string"
    && typeof item.name === "string");
  const auxiliaryCalls = functionCalls
    .filter(item => auxiliaryNames.has(item.name as string))
    .map(item => ({
      call: { ...item },
      callId: item.call_id as string,
      name: item.name as string,
      arguments: typeof item.arguments === "string" ? item.arguments : "",
    }));
  return {
    raw,
    outputItems,
    auxiliaryCalls,
    hasRealFunctionCall: functionCalls.length > auxiliaryCalls.length,
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
  if (!source || !Array.isArray(source.input) || outputItems.length === 0) return body;
  const replay: Record<string, unknown>[] = [];
  for (const item of outputItems) {
    replay.push({ ...item });
    if (item.type !== "function_call" || typeof item.call_id !== "string") continue;
    const output = outputs.get(item.call_id);
    if (output === undefined) continue;
    replay.push({ type: "function_call_output", call_id: item.call_id, output });
  }
  return { ...source, input: [...source.input, ...replay] };
}

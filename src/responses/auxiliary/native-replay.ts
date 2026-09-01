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

export interface NativeCompletedArtifact {
  kind: "image" | "video";
  url: string;
}

export interface NativeResponsesFinalization {
  raw: string;
  /** The exact terminal response snapshot after usage and artifact delivery patches. */
  completedResponse?: Record<string, unknown>;
}

const ARTIFACT_URL_RE = /^\/v1\/codexcommander\/artifacts\/([A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(png|jpe?g|webp|gif|mp4|webm))$/i;
const IMAGE_ARTIFACT_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const VIDEO_ARTIFACT_EXTENSIONS = new Set(["mp4", "webm"]);

interface EditableSseFrame {
  tokens: string[];
  dataIndexes: number[];
  payload: Record<string, unknown>;
}

function editableSseFrame(frame: string): EditableSseFrame | undefined {
  const tokens = frame.split(/(\r?\n)/);
  const dataIndexes: number[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    if ((tokens[index] ?? "").startsWith("data:")) dataIndexes.push(index);
  }
  if (dataIndexes.length === 0) return undefined;
  const json = dataIndexes
    .map(index => (tokens[index] ?? "").slice(5).replace(/^ /, ""))
    .join("\n");
  try {
    const payload = record(JSON.parse(json));
    return payload ? { tokens, dataIndexes, payload } : undefined;
  } catch {
    return undefined;
  }
}

function replaceEditableFramePayload(frame: EditableSseFrame, payload: Record<string, unknown>): string {
  const firstDataIndex = frame.dataIndexes[0]!;
  const firstDataLine = frame.tokens[firstDataIndex] ?? "data:";
  const marker = firstDataLine.startsWith("data: ") ? "data: " : "data:";
  frame.tokens[firstDataIndex] = `${marker}${JSON.stringify(payload)}`;
  for (const extraDataIndex of frame.dataIndexes.slice(1)) {
    frame.tokens[extraDataIndex] = "";
    if (/^\r?\n$/.test(frame.tokens[extraDataIndex + 1] ?? "")) {
      frame.tokens[extraDataIndex + 1] = "";
    }
  }
  return frame.tokens.join("");
}

function mergeNativeTerminalUsage(
  raw: string,
  usage: CodexCommanderUsage | undefined,
): string {
  if (!usage) return raw;
  const frames = raw.split(/(\r?\n\r?\n)/);
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 2) {
    const editable = editableSseFrame(frames[frameIndex] ?? "");
    if (!editable) continue;
    const response = record(editable.payload.response);
    if (
      (editable.payload.type !== "response.completed" && editable.payload.type !== "response.incomplete")
      || !response
    ) continue;
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
    const payload = {
      ...editable.payload,
      response: { ...response, usage: { ...(priorUsage ?? {}), ...nextUsage } },
    };
    frames[frameIndex] = replaceEditableFramePayload(editable, payload);
  }
  return frames.join("");
}

function safeCompletedArtifacts(
  artifacts: readonly NativeCompletedArtifact[],
): NativeCompletedArtifact[] {
  const seen = new Set<string>();
  const safe: NativeCompletedArtifact[] = [];
  for (const artifact of artifacts) {
    if (!artifact || (artifact.kind !== "image" && artifact.kind !== "video") || typeof artifact.url !== "string") {
      continue;
    }
    const match = ARTIFACT_URL_RE.exec(artifact.url);
    if (!match) continue;
    const extension = match[2]!.toLowerCase();
    const extensionMatchesKind = artifact.kind === "image"
      ? IMAGE_ARTIFACT_EXTENSIONS.has(extension)
      : artifact.kind === "video" && VIDEO_ARTIFACT_EXTENSIONS.has(extension);
    if (!extensionMatchesKind || seen.has(artifact.url)) continue;
    seen.add(artifact.url);
    safe.push({ kind: artifact.kind, url: artifact.url });
  }
  return safe;
}

function containsExactArtifactUrl(text: string, url: string): boolean {
  let offset = text.indexOf(url);
  while (offset >= 0) {
    const before = offset === 0 ? "" : text[offset - 1]!;
    const afterOffset = offset + url.length;
    const after = afterOffset === text.length ? "" : text[afterOffset]!;
    const afterNext = afterOffset + 1 >= text.length ? "" : text[afterOffset + 1]!;
    const boundaryBefore = !before || /[\s([<{"'=]/.test(before);
    const boundaryAfter = !after
      || /[\s)\]}>"',!]/.test(after)
      || (after === "." && (!afterNext || /\s/.test(afterNext)));
    if (boundaryBefore && boundaryAfter) return true;
    offset = text.indexOf(url, offset + 1);
  }
  return false;
}

function visibleAssistantTexts(payloads: readonly Record<string, unknown>[], response: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const assistantItemIds = new Set<string>();
  const scanMessage = (value: unknown): void => {
    const message = record(value);
    if (!message || message.type !== "message" || message.role !== "assistant") return;
    if (typeof message.id === "string") assistantItemIds.add(message.id);
    if (!Array.isArray(message.content)) return;
    for (const value of message.content) {
      const part = record(value);
      if (!part) continue;
      if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  };
  if (Array.isArray(response.output)) response.output.forEach(scanMessage);
  for (const payload of payloads) {
    scanMessage(payload.item);
  }
  for (const payload of payloads) {
    if (
      (payload.type === "response.output_text.delta" || payload.type === "response.output_text.done")
      && typeof payload.item_id === "string"
      && assistantItemIds.has(payload.item_id)
    ) {
      const text = payload.type === "response.output_text.delta" ? payload.delta : payload.text;
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts;
}

function uniqueMessageId(payloads: readonly Record<string, unknown>[], response: Record<string, unknown>): string {
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    const item = record(value);
    if (typeof item?.id === "string") ids.add(item.id);
  };
  if (Array.isArray(response.output)) response.output.forEach(collect);
  for (const payload of payloads) {
    collect(payload.item);
    if (typeof payload.item_id === "string") ids.add(payload.item_id);
  }
  const base = "msg_ccx_completed_artifacts";
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function artifactLifecyclePayloads(
  item: Record<string, unknown>,
  markdown: string,
  outputIndex: number,
): Record<string, unknown>[] {
  const itemId = item.id as string;
  const part = { type: "output_text", text: markdown, annotations: [] };
  const inProgressItem = { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] };
  const payloads: Record<string, unknown>[] = [
    { type: "response.output_item.added", output_index: outputIndex, item: inProgressItem },
    {
      type: "response.content_part.added", item_id: itemId, output_index: outputIndex,
      content_index: 0, part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta", item_id: itemId, output_index: outputIndex,
      content_index: 0, delta: markdown,
    },
    {
      type: "response.output_text.done", item_id: itemId, output_index: outputIndex,
      content_index: 0, text: markdown,
    },
    {
      type: "response.content_part.done", item_id: itemId, output_index: outputIndex,
      content_index: 0, part,
    },
    { type: "response.output_item.done", output_index: outputIndex, item },
  ];
  return payloads;
}

interface ArtifactSequenceAllocation {
  first: number;
  terminal: number;
}

/**
 * Reserve one strictly increasing safe-integer slot per synthetic lifecycle event plus
 * the patched terminal event. `undefined` preserves an entirely unsequenced provider
 * stream; `null` means the provider exhausted the integer space and injection must be
 * skipped atomically.
 */
function allocateArtifactSequenceNumbers(
  terminalSequence: unknown,
  priorSequenceNumber: number | undefined,
  lifecycleLength: number,
): ArtifactSequenceAllocation | null | undefined {
  let first: number;
  if (
    typeof terminalSequence === "number"
    && Number.isSafeInteger(terminalSequence)
    && terminalSequence >= 0
  ) {
    first = terminalSequence;
  } else if (priorSequenceNumber !== undefined) {
    // Compare before addition so MAX_SAFE_INTEGER can never round or repeat.
    if (priorSequenceNumber >= Number.MAX_SAFE_INTEGER) return null;
    first = priorSequenceNumber + 1;
  } else {
    return undefined;
  }
  if (!Number.isSafeInteger(lifecycleLength) || lifecycleLength < 0) return null;
  // The terminal consumes the slot immediately after every lifecycle event.
  if (first > Number.MAX_SAFE_INTEGER - lifecycleLength) return null;
  return { first, terminal: first + lifecycleLength };
}

/**
 * Finalize a bounded native Responses stream. Provider frames remain byte-identical except for
 * the terminal response snapshot, whose usage and output may be patched. Artifact Markdown is
 * synthesized only from request-owned, completed, authenticated artifact references and only
 * when a structurally authoritative completed response does not already show that reference.
 */
export function finalizeNativeResponsesSse(
  raw: string,
  usage: CodexCommanderUsage | undefined,
  completedArtifacts: readonly NativeCompletedArtifact[] = [],
): NativeResponsesFinalization {
  const usageMerged = mergeNativeTerminalUsage(raw, usage);
  const safeArtifacts = safeCompletedArtifacts(completedArtifacts);
  const parsed = ssePayloads(usageMerged);
  const completed = parsed.payloads.filter(payload => payload.type === "response.completed");
  const otherTerminals = parsed.payloads.filter(payload =>
    payload.type === "response.incomplete"
    || payload.type === "response.failed"
    || payload.type === "error");
  const terminalPayload = completed.length === 1 && otherTerminals.length === 0
    ? completed[0]
    : undefined;
  const terminalResponse = record(terminalPayload?.response);
  const terminalOutput = Array.isArray(terminalResponse?.output)
    ? terminalResponse.output.map(record)
    : undefined;
  const outputIndexesValid = terminalOutput !== undefined && parsed.payloads.every(payload => {
    if (!Object.hasOwn(payload, "output_index")) return true;
    const value = payload.output_index;
    if (
      typeof value !== "number"
      || !Number.isSafeInteger(value)
      || value < 0
      || value >= Number.MAX_SAFE_INTEGER
    ) return false;
    const bindsTerminalOutput = payload.type === "response.output_item.added"
      || payload.type === "response.output_item.done"
      || payload.type === "response.output_text.delta"
      || payload.type === "response.output_text.done"
      || payload.type === "response.content_part.added"
      || payload.type === "response.content_part.done"
      || payload.type === "response.function_call_arguments.delta"
      || payload.type === "response.function_call_arguments.done";
    if (!bindsTerminalOutput) return true;
    if (value >= terminalOutput.length) return false;
    const terminalItem = terminalOutput[value];
    if (!terminalItem) return false;
    const eventItem = record(payload.item);
    const eventItemId = typeof eventItem?.id === "string"
      ? eventItem.id
      : typeof payload.item_id === "string"
        ? payload.item_id
        : undefined;
    return eventItemId !== undefined
      && typeof terminalItem.id === "string"
      && eventItemId === terminalItem.id;
  });
  const authoritative = !parsed.malformed
    && outputIndexesValid
    && terminalResponse?.status === "completed"
    && terminalOutput !== undefined
    && terminalOutput.every(item => item !== undefined);
  if (!authoritative || !terminalPayload || !terminalResponse) {
    return { raw: usageMerged };
  }
  if (safeArtifacts.length === 0) {
    return { raw: usageMerged, completedResponse: terminalResponse };
  }

  const visibleTexts = visibleAssistantTexts(parsed.payloads, terminalResponse);
  const missingArtifacts = safeArtifacts.filter(artifact =>
    !visibleTexts.some(text => containsExactArtifactUrl(text, artifact.url)));
  if (missingArtifacts.length === 0) {
    return { raw: usageMerged, completedResponse: terminalResponse };
  }
  const markdown = missingArtifacts
    .map(artifact => artifact.kind === "image"
      ? `![image](${artifact.url})`
      : `[Open video](${artifact.url})`)
    .join("\n\n");
  const output = terminalOutput as Record<string, unknown>[];
  const messageId = uniqueMessageId(parsed.payloads, terminalResponse);
  const message = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: markdown, annotations: [] }],
  };
  const outputIndex = output.length;
  const terminalSequence = terminalPayload.sequence_number;
  const priorSequenceNumber = parsed.payloads.reduce<number | undefined>((highest, payload) => {
    if (payload === terminalPayload) return highest;
    const value = payload.sequence_number;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return highest;
    return highest === undefined ? value : Math.max(highest, value);
  }, undefined);
  const bareLifecycle = artifactLifecyclePayloads(message, markdown, outputIndex);
  const sequenceAllocation = allocateArtifactSequenceNumbers(
    terminalSequence,
    priorSequenceNumber,
    bareLifecycle.length,
  );
  // Never emit a partial artifact lifecycle or unsafe/repeated sequence numbers. The original
  // authoritative terminal stream remains the deterministic fallback when integer space is gone.
  if (sequenceAllocation === null) {
    return { raw: usageMerged, completedResponse: terminalResponse };
  }
  const lifecycle: Record<string, unknown>[] = sequenceAllocation === undefined
    ? bareLifecycle
    : bareLifecycle.map((payload, index) => ({
        ...payload,
        sequence_number: sequenceAllocation.first + index,
      }));
  const patchedResponse = { ...terminalResponse, output: [...output, message] };
  const patchedTerminal = {
    ...terminalPayload,
    ...(sequenceAllocation === undefined
      ? {}
      : { sequence_number: sequenceAllocation.terminal }),
    response: patchedResponse,
  };

  const frames = usageMerged.split(/(\r?\n\r?\n)/);
  let terminalFrameIndex = -1;
  let editableTerminal: EditableSseFrame | undefined;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 2) {
    const editable = editableSseFrame(frames[frameIndex] ?? "");
    if (editable?.payload.type !== "response.completed") continue;
    terminalFrameIndex = frameIndex;
    editableTerminal = editable;
    break;
  }
  if (terminalFrameIndex < 0 || !editableTerminal) return { raw: usageMerged };
  const newline = usageMerged.includes("\r\n") ? "\r\n" : "\n";
  const injected = lifecycle
    .map(payload => `event: ${payload.type}${newline}data: ${JSON.stringify(payload)}${newline}${newline}`)
    .join("");
  frames[terminalFrameIndex] = injected + replaceEditableFramePayload(editableTerminal, patchedTerminal);
  return { raw: frames.join(""), completedResponse: patchedResponse };
}

/**
 * Replace only the terminal native usage counters after hidden synthetic iterations. Unknown
 * response fields, output items, lifecycle events, and provider extensions stay provider-native.
 */
export function mergeNativeResponsesCompletedUsage(
  raw: string,
  usage: CodexCommanderUsage | undefined,
): string {
  return finalizeNativeResponsesSse(raw, usage).raw;
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

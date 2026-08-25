import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { buildToolBridgeMaps } from "../src/server/responses/collaboration";
import type { AdapterEvent, CodexCommanderParsedRequest, CodexCommanderTool } from "../src/types";

const model = "routed/model";
const waitAgentEvents: AdapterEvent[] = [
  { type: "tool_call_start", id: "call_1", name: "collaboration__wait_agent" },
  { type: "tool_call_delta", arguments: '{"timeout_ms":300000.0}' },
  { type: "tool_call_end", id: "call_1" },
  { type: "done" },
];
const waitAgentSchema = {
  type: "object",
  properties: { timeout_ms: { type: "number" } },
};
const waitAgentSchemas = new Map([
  ["collaboration__wait_agent", waitAgentSchema],
]);
const integerCountSchema = {
  type: "object",
  properties: { timeout_ms: { type: "integer" } },
};
const stringTimeoutSchema = {
  type: "object",
  properties: { timeout_ms: { type: "string" } },
};

async function* source(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

function functionCallItem(json: Record<string, unknown>): Record<string, unknown> {
  const output = json.output as Record<string, unknown>[];
  const item = output.find(entry => entry.type === "function_call");
  expect(item).toBeDefined();
  return item!;
}

function completedFunctionCallArguments(json: Record<string, unknown>): string {
  return functionCallItem(json).arguments as string;
}

function parsedWithTools(tools: CodexCommanderTool[]): CodexCommanderParsedRequest {
  return {
    modelId: model,
    context: { messages: [], tools },
    stream: false,
    options: {},
  };
}

function tool(name: string, parameters: Record<string, unknown>, namespace?: string): CodexCommanderTool {
  return {
    name,
    description: name,
    parameters,
    ...(namespace ? { namespace } : {}),
  };
}

function waitAgentCall(name: string): AdapterEvent[] {
  return [
    { type: "tool_call_start", id: "call_1", name },
    { type: "tool_call_delta", arguments: '{"timeout_ms":300000.0}' },
    { type: "tool_call_end", id: "call_1" },
    { type: "done" },
  ];
}

async function collectBridged(
  events: AdapterEvent[],
  options?: {
    toolParameterSchemas?: ReadonlyMap<string, Record<string, unknown>>;
    toolNsMap?: Map<string, { namespace: string; name: string }>;
  },
): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  return collectSse(bridgeToResponsesSSE(
    source(events),
    model,
    options?.toolNsMap,
    undefined,
    undefined,
    undefined,
    undefined,
    { toolParameterSchemas: options?.toolParameterSchemas },
  ));
}

async function streamedFunctionCall(
  events: AdapterEvent[],
  options?: {
    toolParameterSchemas?: ReadonlyMap<string, Record<string, unknown>>;
    toolNsMap?: Map<string, { namespace: string; name: string }>;
  },
): Promise<{ deltas: string[]; done?: string; item?: Record<string, unknown> }> {
  const frames = await collectBridged(events, options);
  const deltas = frames
    .filter(frame => frame.event === "response.function_call_arguments.delta")
    .map(frame => frame.data.delta as string);
  const doneFrame = frames.find(frame => frame.event === "response.function_call_arguments.done");
  const item = frames
    .filter(frame => frame.event === "response.output_item.done")
    .map(frame => frame.data.item as Record<string, unknown>)
    .find(entry => entry?.type === "function_call");
  return {
    deltas,
    done: doneFrame?.data.arguments as string | undefined,
    item,
  };
}

describe("Responses bridge integer argument canonicalization", () => {
  test("repairs integral timeout_ms floats when a request schema is supplied", async () => {
    const json = buildResponseJSON(waitAgentEvents, model, { toolParameterSchemas: waitAgentSchemas });
    expect(completedFunctionCallArguments(json)).toBe('{"timeout_ms":300000}');

    const streamed = await streamedFunctionCall(waitAgentEvents, { toolParameterSchemas: waitAgentSchemas });
    expect(streamed.deltas).toEqual(['{"timeout_ms":300000.0}']);
    expect(streamed.done).toBe('{"timeout_ms":300000}');
    expect(streamed.item).toMatchObject({
      type: "function_call",
      status: "completed",
      arguments: '{"timeout_ms":300000}',
    });
  });

  test("preserves original argument bytes without a schema", async () => {
    const json = buildResponseJSON(waitAgentEvents, model);
    expect(completedFunctionCallArguments(json)).toBe('{"timeout_ms":300000.0}');

    const streamed = await streamedFunctionCall(waitAgentEvents);
    expect(streamed.deltas).toEqual(['{"timeout_ms":300000.0}']);
    expect(streamed.done).toBe('{"timeout_ms":300000.0}');
    expect(streamed.item).toMatchObject({ arguments: '{"timeout_ms":300000.0}' });
  });

  test("preserves fractional timeout_ms and unrelated numeric floats", async () => {
    const fractionalEvents: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "collaboration__wait_agent" },
      { type: "tool_call_delta", arguments: '{"timeout_ms":300000.5}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ];
    const temperatureEvents: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_2", name: "collaboration__wait_agent" },
      { type: "tool_call_delta", arguments: '{"temperature":1.0}' },
      { type: "tool_call_end", id: "call_2" },
      { type: "done" },
    ];

    expect(completedFunctionCallArguments(
      buildResponseJSON(fractionalEvents, model, { toolParameterSchemas: waitAgentSchemas }),
    )).toBe('{"timeout_ms":300000.5}');
    expect(completedFunctionCallArguments(
      buildResponseJSON(temperatureEvents, model, { toolParameterSchemas: waitAgentSchemas }),
    )).toBe('{"temperature":1.0}');

    const streamedFractional = await streamedFunctionCall(fractionalEvents, { toolParameterSchemas: waitAgentSchemas });
    expect(streamedFractional.deltas).toEqual(['{"timeout_ms":300000.5}']);
    expect(streamedFractional.done).toBe('{"timeout_ms":300000.5}');
    expect(streamedFractional.item).toMatchObject({ arguments: '{"timeout_ms":300000.5}' });

    const streamedTemperature = await streamedFunctionCall(temperatureEvents, { toolParameterSchemas: waitAgentSchemas });
    expect(streamedTemperature.deltas).toEqual(['{"temperature":1.0}']);
    expect(streamedTemperature.done).toBe('{"temperature":1.0}');
    expect(streamedTemperature.item).toMatchObject({ arguments: '{"temperature":1.0}' });
  });

  test("restores namespaced tools while looking up the original wire-name schema", async () => {
    const maps = buildToolBridgeMaps(parsedWithTools([
      tool("wait_agent", waitAgentSchema, "collaboration"),
    ]));
    expect(maps.toolParameterSchemas.get("collaboration__wait_agent")).toBe(waitAgentSchema);

    const events = waitAgentCall("collaboration__wait_agent");
    expect(completedFunctionCallArguments(buildResponseJSON(events, model, {
      toolNsMap: maps.toolNsMap,
      toolParameterSchemas: maps.toolParameterSchemas,
    }))).toBe('{"timeout_ms":300000}');

    const streamed = await streamedFunctionCall(events, {
      toolNsMap: maps.toolNsMap,
      toolParameterSchemas: maps.toolParameterSchemas,
    });
    expect(streamed.deltas).toEqual(['{"timeout_ms":300000.0}']);
    expect(streamed.done).toBe('{"timeout_ms":300000}');
    expect(streamed.item).toMatchObject({
      name: "wait_agent",
      namespace: "collaboration",
      arguments: '{"timeout_ms":300000}',
    });
  });

  test("keeps distinct schemas when two namespaces share a bare tool name", async () => {
    const maps = buildToolBridgeMaps(parsedWithTools([
      tool("wait_agent", waitAgentSchema, "collaboration"),
      tool("wait_agent", stringTimeoutSchema, "other"),
    ]));
    expect(maps.toolParameterSchemas.get("collaboration__wait_agent")).toBe(waitAgentSchema);
    expect(maps.toolParameterSchemas.get("other__wait_agent")).toBe(stringTimeoutSchema);
    expect(maps.toolParameterSchemas.has("wait_agent")).toBe(false);

    const collab = waitAgentCall("collaboration__wait_agent");
    const other = waitAgentCall("other__wait_agent");
    expect(completedFunctionCallArguments(buildResponseJSON(collab, model, {
      toolNsMap: maps.toolNsMap,
      toolParameterSchemas: maps.toolParameterSchemas,
    }))).toBe('{"timeout_ms":300000}');
    expect(completedFunctionCallArguments(buildResponseJSON(other, model, {
      toolNsMap: maps.toolNsMap,
      toolParameterSchemas: maps.toolParameterSchemas,
    }))).toBe('{"timeout_ms":300000.0}');

    const streamedCollab = await streamedFunctionCall(collab, {
      toolNsMap: maps.toolNsMap,
      toolParameterSchemas: maps.toolParameterSchemas,
    });
    expect(streamedCollab.done).toBe('{"timeout_ms":300000}');
    expect(streamedCollab.item).toMatchObject({ name: "wait_agent", namespace: "collaboration" });

    const streamedOther = await streamedFunctionCall(other, {
      toolNsMap: maps.toolNsMap,
      toolParameterSchemas: maps.toolParameterSchemas,
    });
    expect(streamedOther.deltas).toEqual(['{"timeout_ms":300000.0}']);
    expect(streamedOther.done).toBe('{"timeout_ms":300000.0}');
    expect(streamedOther.item).toMatchObject({
      name: "wait_agent",
      namespace: "other",
      arguments: '{"timeout_ms":300000.0}',
    });
  });

  test("does not let a namespaced alias overwrite a real bare tool schema", async () => {
    const maps = buildToolBridgeMaps(parsedWithTools([
      tool("wait_agent", stringTimeoutSchema),
      tool("wait_agent", waitAgentSchema, "collaboration"),
    ]));
    expect(maps.toolParameterSchemas.get("wait_agent")).toBe(stringTimeoutSchema);
    expect(maps.toolParameterSchemas.get("collaboration__wait_agent")).toBe(waitAgentSchema);

    expect(completedFunctionCallArguments(buildResponseJSON(waitAgentCall("wait_agent"), model, {
      toolNsMap: maps.toolNsMap,
      toolParameterSchemas: maps.toolParameterSchemas,
    }))).toBe('{"timeout_ms":300000.0}');
    expect(completedFunctionCallArguments(buildResponseJSON(waitAgentCall("collaboration__wait_agent"), model, {
      toolNsMap: maps.toolNsMap,
      toolParameterSchemas: maps.toolParameterSchemas,
    }))).toBe('{"timeout_ms":300000}');
  });

  test("repairs from a qualified-only external schema map after namespace restoration", async () => {
    const toolNsMap = new Map([
      ["collaboration__wait_agent", { namespace: "collaboration", name: "wait_agent" }],
    ]);
    const events = waitAgentCall("collaboration__wait_agent");
    expect(completedFunctionCallArguments(buildResponseJSON(events, model, {
      toolNsMap,
      toolParameterSchemas: waitAgentSchemas,
    }))).toBe('{"timeout_ms":300000}');

    const streamed = await streamedFunctionCall(events, {
      toolNsMap,
      toolParameterSchemas: waitAgentSchemas,
    });
    expect(streamed.deltas).toEqual(['{"timeout_ms":300000.0}']);
    expect(streamed.done).toBe('{"timeout_ms":300000}');
    expect(streamed.item).toMatchObject({
      name: "wait_agent",
      namespace: "collaboration",
      arguments: '{"timeout_ms":300000}',
    });
  });

  test("does not canonicalize incomplete buffered or streaming tool calls", async () => {
    const openCall: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "collaboration__wait_agent" },
      { type: "tool_call_delta", arguments: '{"timeout_ms":300000.0}' },
    ];
    const errorJson = buildResponseJSON(
      [...openCall, { type: "error", message: "upstream failed", status: 502, errorType: "upstream_error" }],
      model,
      { toolParameterSchemas: waitAgentSchemas },
    );
    expect(errorJson.status).toBe("failed");
    expect(functionCallItem(errorJson)).toMatchObject({
      status: "incomplete",
      arguments: '{"timeout_ms":300000.0}',
    });

    const incompleteJson = buildResponseJSON(
      [...openCall, { type: "incomplete", reason: "adapter_eof" }],
      model,
      { toolParameterSchemas: waitAgentSchemas },
    );
    expect(incompleteJson.status).toBe("incomplete");
    expect(functionCallItem(incompleteJson)).toMatchObject({
      status: "incomplete",
      arguments: '{"timeout_ms":300000.0}',
    });

    const errorStream = await streamedFunctionCall(
      [...openCall, { type: "error", message: "upstream failed", status: 502, errorType: "upstream_error" }],
      { toolParameterSchemas: waitAgentSchemas },
    );
    expect(errorStream.deltas).toEqual(['{"timeout_ms":300000.0}']);
    expect(errorStream.done).toBeUndefined();
    expect(errorStream.item).toMatchObject({
      status: "incomplete",
      arguments: '{"timeout_ms":300000.0}',
    });

    const incompleteStream = await streamedFunctionCall(
      [...openCall, { type: "incomplete", reason: "adapter_eof" }],
      { toolParameterSchemas: waitAgentSchemas },
    );
    expect(incompleteStream.deltas).toEqual(['{"timeout_ms":300000.0}']);
    expect(incompleteStream.done).toBeUndefined();
    expect(incompleteStream.item).toMatchObject({
      status: "incomplete",
      arguments: '{"timeout_ms":300000.0}',
    });
  });
});

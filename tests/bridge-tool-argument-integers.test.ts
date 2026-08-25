import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

const model = "routed/model";
const waitAgentEvents: AdapterEvent[] = [
  { type: "tool_call_start", id: "call_1", name: "collaboration__wait_agent" },
  { type: "tool_call_delta", arguments: '{"timeout_ms":300000.0}' },
  { type: "tool_call_end", id: "call_1" },
  { type: "done" },
];
const waitAgentSchemas = new Map([
  ["collaboration__wait_agent", {
    type: "object",
    properties: { timeout_ms: { type: "number" } },
  }],
]);

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

function completedFunctionCallArguments(json: Record<string, unknown>): string {
  const output = json.output as Record<string, unknown>[];
  const item = output.find(entry => entry.type === "function_call");
  expect(item).toBeDefined();
  return item!.arguments as string;
}

async function streamedFunctionCallArguments(
  events: AdapterEvent[],
  options?: { toolParameterSchemas?: ReadonlyMap<string, Record<string, unknown>> },
): Promise<{ done: string; item: string }> {
  const frames = await collectSse(bridgeToResponsesSSE(
    source(events),
    model,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { toolParameterSchemas: options?.toolParameterSchemas },
  ));
  const doneFrame = frames.find(frame => frame.event === "response.function_call_arguments.done");
  expect(doneFrame).toBeDefined();
  const completedItem = frames
    .filter(frame => frame.event === "response.output_item.done")
    .map(frame => frame.data.item as Record<string, unknown>)
    .find(item => item?.type === "function_call" && item.status === "completed");
  expect(completedItem).toBeDefined();
  return {
    done: doneFrame!.data.arguments as string,
    item: completedItem!.arguments as string,
  };
}

describe("Responses bridge integer argument canonicalization", () => {
  test("repairs integral timeout_ms floats when a request schema is supplied", async () => {
    const json = buildResponseJSON(waitAgentEvents, model, { toolParameterSchemas: waitAgentSchemas });
    expect(completedFunctionCallArguments(json)).toBe('{"timeout_ms":300000}');

    const streamed = await streamedFunctionCallArguments(waitAgentEvents, { toolParameterSchemas: waitAgentSchemas });
    expect(streamed.done).toBe('{"timeout_ms":300000}');
    expect(streamed.item).toBe('{"timeout_ms":300000}');
  });

  test("preserves original argument bytes without a schema", async () => {
    const json = buildResponseJSON(waitAgentEvents, model);
    expect(completedFunctionCallArguments(json)).toBe('{"timeout_ms":300000.0}');

    const streamed = await streamedFunctionCallArguments(waitAgentEvents);
    expect(streamed.done).toBe('{"timeout_ms":300000.0}');
    expect(streamed.item).toBe('{"timeout_ms":300000.0}');
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

    const streamedFractional = await streamedFunctionCallArguments(fractionalEvents, { toolParameterSchemas: waitAgentSchemas });
    expect(streamedFractional.done).toBe('{"timeout_ms":300000.5}');
    expect(streamedFractional.item).toBe('{"timeout_ms":300000.5}');

    const streamedTemperature = await streamedFunctionCallArguments(temperatureEvents, { toolParameterSchemas: waitAgentSchemas });
    expect(streamedTemperature.done).toBe('{"temperature":1.0}');
    expect(streamedTemperature.item).toBe('{"temperature":1.0}');
  });
});

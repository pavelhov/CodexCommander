import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { buildToolBridgeMaps } from "../src/server/responses/collaboration";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { buildCursorToolDefinitions, responsesToolNameFromCursorWire } from "../src/adapters/cursor/tool-definitions";
import type { AdapterEvent } from "../src/types";

const tools = [
  { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Run JavaScript" }] },
  { type: "namespace", name: "other", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] },
];
const input = 'const value = "hello";\ntext(value);';
const parsed = () => parseRequest({ model: "test", input: "Run code", tools });
const maps = () => buildToolBridgeMaps(parsed());
function events(name: string, complete = true): AdapterEvent[] {
  return [
    { type: "tool_call_start", id: "call_1", name },
    { type: "tool_call_delta", arguments: JSON.stringify({ input }) },
    ...(complete ? [{ type: "tool_call_end" } as AdapterEvent, { type: "done" } as AdapterEvent] : []),
  ];
}
async function stream(name: string, complete = true) {
  const m = maps();
  async function* source() { yield* events(name, complete); }
  const text = await new Response(bridgeToResponsesSSE(source(), "test", m.toolNsMap, m.freeformToolNames)).text();
  return text.split("\n\n").filter(frame => frame.startsWith("event: ")).map(frame => JSON.parse(frame.split("\ndata: ")[1]!));
}

test("registers nested custom tools with namespace and a raw input wrapper", () => {
  expect(parsed().context.tools?.[0]).toMatchObject({ name: "exec", namespace: "functions", freeform: true, parameters: { required: ["input"] } });
  expect(buildCursorToolDefinitions(parsed().context.tools).map(tool => tool.name)).toEqual(["functions__exec", "other__exec"]);
  expect(responsesToolNameFromCursorWire("mcp_codexcommander-responses_functions__exec")).toBe("functions__exec");
  expect(maps().freeformToolNames).toEqual(new Set(["functions__exec"]));
});

test("collected custom call preserves namespace and raw input while another namespace stays a function", () => {
  const output = buildResponseJSON(events("functions__exec"), "test", maps()).output as Record<string, unknown>[];
  expect(output[0]).toMatchObject({ type: "custom_tool_call", name: "exec", namespace: "functions", input, status: "completed" });
  const other = buildResponseJSON(events("other__exec"), "test", maps()).output as Record<string, unknown>[];
  expect(other[0]).toMatchObject({ type: "function_call", name: "exec", namespace: "other" });
});

test("streamed custom call preserves namespace in added, completed and interrupted items", async () => {
  for (const complete of [true, false]) {
    const frames = await stream("functions__exec", complete);
    const items = frames.filter(f => f.item?.type === "custom_tool_call").map(f => f.item);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ namespace: "functions", name: "exec", input: "", status: "in_progress" });
    expect(items[1]).toMatchObject({ namespace: "functions", input, status: complete ? "completed" : "incomplete" });
  }
  const frames = await stream("other__exec");
  expect(frames.find(f => f.item)?.item).toMatchObject({ type: "function_call", namespace: "other", name: "exec" });
});

test("custom call replay keeps namespace on the call and its result", () => {
  const replay = parseRequest({ model: "test", tools, input: [
    { type: "custom_tool_call", call_id: "call_1", name: "exec", namespace: "functions", input },
    { type: "custom_tool_call_output", call_id: "call_1", output: "hello" },
  ] });
  expect(replay.context.messages[0]?.content[0]).toMatchObject({ type: "toolCall", name: "exec", namespace: "functions", arguments: { input } });
  expect(replay.context.messages[1]).toMatchObject({ toolName: "exec", toolNamespace: "functions" });
});

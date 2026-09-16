import { describe, expect, test } from "bun:test";
import { buildResponseJSON } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import { applyCursorToolBudget, CURSOR_TOOL_BYTES_LIMIT, CURSOR_TOOL_COUNT_LIMIT } from "../src/adapters/cursor/request-builder";
import { buildCursorToolDefinitions, buildCursorToolGuidanceSystemNote, cursorMcpToolsEncodedSize, responsesToolNameFromCursorWire } from "../src/adapters/cursor/tool-definitions";
import type { CodexCommanderTool } from "../src/types";

const imagegen: CodexCommanderTool = { namespace: "image_gen", name: "imagegen", description: "Generate or edit an image", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } };
const viewImage: CodexCommanderTool = { namespace: "functions", name: "view_image", description: "View a local image", parameters: { type: "object", properties: { path: { type: "string" } } } };
const wait: CodexCommanderTool = { namespace: "functions", name: "wait", description: "Wait for a yielded executor", parameters: {} };
const exec: CodexCommanderTool = { name: "exec", description: "Run JavaScript with tools and generatedImage", freeform: true, parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } };

describe("Cursor client image tools", () => {
  test.each(["count", "bytes"])("retains image tools and code executor under %s pressure", pressure => {
    const filler: CodexCommanderTool[] = Array.from({ length: CURSOR_TOOL_COUNT_LIMIT + 10 }, (_, index) => ({
      name: `filler_${index}`, namespace: "mcp__filler", description: pressure === "bytes" ? "x".repeat(1200) : "Filler", parameters: {},
    }));
    const retainedImage = { ...imagegen, description: "x".repeat(2000) };
    const retainedExec = { ...exec, namespace: "functions" };
    const budget = applyCursorToolBudget([...filler, retainedImage, viewImage, retainedExec, wait], "auto");
    expect(budget.tools.includes(retainedImage)).toBe(true);
    expect(budget.tools.includes(viewImage)).toBe(true);
    expect(budget.tools.includes(retainedExec)).toBe(true);
    expect(budget.tools.includes(wait)).toBe(true);
    expect(budget.tools.length).toBeLessThanOrEqual(CURSOR_TOOL_COUNT_LIMIT);
    expect(cursorMcpToolsEncodedSize(budget.tools)).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
  });

  test("retains the bare executor wait tool ahead of search-loaded catalog filler", () => {
    const filler: CodexCommanderTool[] = Array.from({ length: CURSOR_TOOL_COUNT_LIMIT }, (_, index) => ({
      name: `loaded_${index}`, namespace: "mcp__filler", description: "Discovered tool", parameters: {}, loadedFromToolSearch: true,
    }));
    const bareWait = { ...wait, namespace: undefined };
    const budget = applyCursorToolBudget([...filler, exec, bareWait], "auto");
    expect(budget.tools).toContain(exec);
    expect(budget.tools).toContain(bareWait);
    expect(budget.tools.length).toBeLessThanOrEqual(CURSOR_TOOL_COUNT_LIMIT);
  });

  test("guidance names the registered client tools and distinguishes native GenerateImage", () => {
    const note = buildCursorToolGuidanceSystemNote([imagegen, viewImage]);
    expect(note).toContain("For image generation or editing, call `image_gen__imagegen`");
    expect(note).toContain("For local image inspection, call `functions__view_image`");
    expect(note).toContain("Cursor-native `GenerateImage`");
    expect(note).toContain("shell commands or SDK scripts");
    expect(note).not.toContain("tools.image_gen__imagegen");
  });

  test("executor-only guidance allows documented nested tools without inventing image availability", () => {
    const note = buildCursorToolGuidanceSystemNote([exec]);
    expect(note).toContain("`exec` is the client JavaScript tool executor");
    expect(note).toContain("only when the client instructions list them");
    expect(note).toContain("JSON `input` string");
    expect(note).not.toContain("call `image_gen__imagegen`");
    expect(note).not.toContain("tools.image_gen__imagegen");
  });

  test("does not classify remote tools with matching local names as client image routes", () => {
    const remote = [imagegen, viewImage, exec].map(tool => ({ ...tool, namespace: "mcp__remote" }));
    const note = buildCursorToolGuidanceSystemNote(remote);
    expect(note).not.toContain("For image generation or editing, call");
    expect(note).not.toContain("For local image inspection, call");
    expect(note).not.toContain("is the client JavaScript tool executor");
  });

  test("does not advertise missing or choice-filtered image tools", () => {
    expect(buildCursorToolGuidanceSystemNote([])).toBeUndefined();
    const note = buildCursorToolGuidanceSystemNote([imagegen, exec], { name: "exec" });
    expect(note).not.toContain("call `image_gen__imagegen`");
    expect(buildCursorToolDefinitions([imagegen, exec], { name: "exec" }).map(tool => tool.name)).toEqual(["exec"]);
    expect(applyCursorToolBudget([imagegen, exec], "none").tools).toEqual([]);
  });

  test("Responses image namespace and executor input round-trip without native-tool substitution", () => {
    const parsed = parseRequest({ model: "cursor/auto", input: "Create a landscape", tools: [
      { type: "namespace", name: "image_gen", tools: [{ type: "function", name: imagegen.name, description: imagegen.description, parameters: imagegen.parameters }] },
      { type: "custom", name: "exec", description: exec.description },
    ] });
    const definitions = buildCursorToolDefinitions(parsed.context.tools);
    expect(definitions.map(tool => tool.name)).toEqual(["image_gen__imagegen", "exec"]);
    const name = responsesToolNameFromCursorWire("mcp_codexcommander-responses_image_gen__imagegen");
    const input = 'const result = await tools.image_gen__imagegen({prompt:"landscape"}); generatedImage(result);';
    const result = buildResponseJSON([
      { type: "tool_call_start", id: "image_call", name },
      { type: "tool_call_delta", arguments: '{"prompt":"landscape"}' },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "exec_call", name: "exec" },
      { type: "tool_call_delta", arguments: JSON.stringify({ input }) },
      { type: "tool_call_end" }, { type: "done" },
    ], "cursor/auto", { toolNsMap: new Map([[name, { namespace: "image_gen", name: "imagegen" }]]), freeformToolNames: new Set(["exec"]) });
    expect(result.output).toMatchObject([
      { type: "function_call", namespace: "image_gen", name: "imagegen", arguments: '{"prompt":"landscape"}' },
      { type: "custom_tool_call", name: "exec", input },
    ]);
  });
});

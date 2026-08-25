import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
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

function outputOf(response: Record<string, unknown>): Record<string, unknown>[] {
  return response.output as Record<string, unknown>[];
}

describe("buffered bridge terminal handling", () => {
  test("terminal-less text is incomplete with adapter_eof", () => {
    const response = buildResponseJSON([
      { type: "text_delta", text: "partial answer" },
    ], "m");

    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details).toEqual({ reason: "adapter_eof" });
    expect(outputOf(response)[0]).toMatchObject({
      type: "message",
      content: [{ type: "output_text", text: "partial answer" }],
    });
  });

  test("terminal-less open function call is incomplete", () => {
    const response = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "js" },
      { type: "tool_call_delta", arguments: '{"code":"tru' },
    ], "m");

    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details).toEqual({ reason: "adapter_eof" });
    expect(outputOf(response)).toContainEqual(expect.objectContaining({
      type: "function_call",
      call_id: "call_1",
      status: "incomplete",
      arguments: '{"code":"tru',
    }));
  });

  test("terminal-less open tool-search call preserves truncated arguments", () => {
    const response = buildResponseJSON([
      { type: "tool_call_start", id: "search_1", name: "tool_search" },
      { type: "tool_call_delta", arguments: '{"query":"repo' },
    ], "m", { toolSearchToolNames: new Set(["tool_search"]) });

    expect(response.status).toBe("incomplete");
    expect(outputOf(response)).toContainEqual(expect.objectContaining({
      type: "function_call",
      call_id: "search_1",
      name: "tool_search",
      status: "incomplete",
      arguments: '{"query":"repo',
    }));
    expect(outputOf(response).some(item => item.type === "tool_search_call")).toBe(false);
  });

  test("streaming terminal-less output emits only response.incomplete", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "partial answer" },
    ]), "m"));

    expect(frames.filter(frame => frame.event === "response.incomplete")).toHaveLength(1);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
    expect(frames.some(frame => frame.event === "response.failed")).toBe(false);
    expect(frames.find(frame => frame.event === "response.incomplete")?.data.response).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "adapter_eof" },
    });
  });

  test("explicit done remains completed", () => {
    const response = buildResponseJSON([
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ], "m");

    expect(response.status).toBe("completed");
    expect(response.incomplete_details).toBeUndefined();
  });

  test("completed tool call remains completed after explicit done", () => {
    const response = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "js" },
      { type: "tool_call_delta", arguments: '{"code":"true"}' },
      { type: "tool_call_end" },
      { type: "done" },
    ], "m");

    expect(outputOf(response)).toContainEqual(expect.objectContaining({
      type: "function_call",
      call_id: "call_1",
      status: "completed",
    }));
  });

  test("explicit error remains failed", () => {
    const response = buildResponseJSON([
      { type: "text_delta", text: "partial" },
      { type: "error", message: "upstream failed" },
    ], "m");

    expect(response.status).toBe("failed");
    expect(response.incomplete_details).toBeUndefined();
  });

  test("explicit incomplete reason remains unchanged", () => {
    const response = buildResponseJSON([
      { type: "text_delta", text: "partial" },
      { type: "incomplete", reason: "max_output_tokens" },
    ], "m");

    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });
});

describe("buffered compaction terminal guard", () => {
  test("terminal-less compaction output is not emitted", () => {
    const response = buildResponseJSON([
      { type: "text_delta", text: "partial summary" },
    ], "m", { compaction: true });

    expect(response.status).toBe("incomplete");
    expect(outputOf(response).some(item => item.type === "compaction")).toBe(false);
  });

  test("explicit done emits a compaction item", () => {
    const response = buildResponseJSON([
      { type: "text_delta", text: "summary" },
      { type: "done" },
    ], "m", { compaction: true });

    expect(response.status).toBe("completed");
    expect(outputOf(response).filter(item => item.type === "compaction")).toHaveLength(1);
  });

  test("explicit error and incomplete do not emit compaction items", () => {
    const errorResponse = buildResponseJSON([
      { type: "text_delta", text: "partial" },
      { type: "error", message: "upstream failed" },
    ], "m", { compaction: true });
    const incompleteResponse = buildResponseJSON([
      { type: "text_delta", text: "partial" },
      { type: "incomplete", reason: "max_output_tokens" },
    ], "m", { compaction: true });

    expect(outputOf(errorResponse).some(item => item.type === "compaction")).toBe(false);
    expect(outputOf(incompleteResponse).some(item => item.type === "compaction")).toBe(false);
  });
});

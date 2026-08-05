import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { decodeReasoningEnvelope } from "../src/responses/reasoning-envelope";
import { parseRequest } from "../src/responses/parser";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
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

const sseOpts = (hide: boolean) => ({ hideThinkingSummary: hide });

describe("hidden raw reasoning (hideThinkingSummary parity for reasoning_raw_delta)", () => {
  test("streamed hidden: no reasoning_text deltas, envelope-only item, tool calls untouched", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "chain " },
      { type: "reasoning_raw_delta", text: "of thought" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, sseOpts(true)));

    expect(frames.some(f => f.event === "response.reasoning_text.delta")).toBe(false);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const reasoning = output.filter(o => o.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].content).toBeUndefined();
    expect(reasoning[0].summary).toEqual([]);
    const envelope = decodeReasoningEnvelope(reasoning[0].encrypted_content as string);
    expect(envelope?.txt).toBe("chain of thought");
    const fc = output.find(o => o.type === "function_call") as Record<string, unknown>;
    expect(fc).toMatchObject({ call_id: "call_1", name: "read_file" });
  });

  test("streamed visible (flag off): current raw shape unchanged", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "visible raw" },
      { type: "done" },
    ]), "routed/model"));
    expect(frames.some(f => f.event === "response.reasoning_text.delta")).toBe(true);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({
      type: "reasoning", summary: [],
      content: [{ type: "reasoning_text", text: "visible raw" }],
    });
  });

  test("streamed summary presentation uses native summary events and preserves following tools", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "checking ", presentation: "summary" },
      { type: "reasoning_raw_delta", text: "the files", presentation: "summary" },
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "routed/model"));

    expect(frames.filter(f => f.event === "response.reasoning_summary_text.delta").map(f => f.data.delta).join(""))
      .toBe("checking the files");
    expect(frames.some(f => f.event === "response.reasoning_text.delta")).toBe(false);
    expect(frames.some(f => f.event === "response.output_text.delta")).toBe(false);

    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "checking the files" }],
    });
    expect(output[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "read_file" });
  });

  test("streamed hidden summary presentation keeps the txt-only replay envelope", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "reasoning_raw_delta", text: "private progress", presentation: "summary" },
      { type: "done" },
    ]), "routed/model", undefined, undefined, undefined, undefined, undefined, sseOpts(true)));

    expect(frames.some(f => f.event === "response.reasoning_summary_text.delta")).toBe(false);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const reasoning = (completed.output as Record<string, unknown>[]).find(item => item.type === "reasoning")!;
    expect(reasoning.summary).toEqual([]);
    expect(reasoning.content).toBeUndefined();
    expect(decodeReasoningEnvelope(reasoning.encrypted_content as string)?.txt).toBe("private progress");
  });

  test("cancelling after a summary delta invokes upstream cancellation without assistant commentary", async () => {
    let cancelled = 0;
    let release!: () => void;
    const waitForCancel = new Promise<void>(resolve => { release = resolve; });
    async function* summaryThenWait(): AsyncGenerator<AdapterEvent> {
      yield { type: "reasoning_raw_delta", text: "still checking", presentation: "summary" };
      await waitForCancel;
    }
    const stream = bridgeToResponsesSSE(summaryThenWait(), "routed/model", undefined, undefined, undefined, () => {
      cancelled += 1;
      release();
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    while (!wire.includes("response.reasoning_summary_text.delta")) {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      wire += decoder.decode(value, { stream: true });
    }

    await reader.cancel("client stopped");
    expect(cancelled).toBe(1);
    expect(wire).not.toContain("response.output_text.delta");
  });

  test("streamed hidden: thrown upstream still flushes the envelope before response.failed", async () => {
    async function* throwing(): AsyncGenerator<AdapterEvent> {
      yield { type: "reasoning_raw_delta", text: "doomed thought" };
      throw new Error("upstream exploded");
    }
    const frames = await collectSse(bridgeToResponsesSSE(throwing(), "routed/model", undefined, undefined, undefined, undefined, undefined, sseOpts(true)));
    const failed = frames.find(f => f.event === "response.failed");
    expect(failed).toBeDefined();
    const added = frames.filter(f => f.event === "response.output_item.added")
      .map(f => f.data.item as Record<string, unknown>)
      .filter(i => i.type === "reasoning");
    expect(added).toHaveLength(1);
    expect(decodeReasoningEnvelope(added[0].encrypted_content as string)?.txt).toBe("doomed thought");
  });

  test("streamed visible summary closes its native item before a thrown upstream failure", async () => {
    async function* throwing(): AsyncGenerator<AdapterEvent> {
      yield { type: "reasoning_raw_delta", text: "partial progress", presentation: "summary" };
      throw new Error("upstream exploded");
    }
    const frames = await collectSse(bridgeToResponsesSSE(throwing(), "routed/model"));
    const summaryDone = frames.find(frame => frame.event === "response.reasoning_summary_text.done");
    const itemDone = frames.find(frame => frame.event === "response.output_item.done");
    const failedIndex = frames.findIndex(frame => frame.event === "response.failed");

    expect(summaryDone?.data.text).toBe("partial progress");
    expect(itemDone?.data.item).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "partial progress" }],
    });
    expect(frames.indexOf(itemDone!)).toBeLessThan(failedIndex);
  });

  test("non-streaming hidden: envelope-only item instead of raw content", () => {
    const json = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "quiet" },
      { type: "done" },
    ], "routed/model", { hideThinkingSummary: true });
    const output = (json as { output: Record<string, unknown>[] }).output;
    const reasoning = output.find(o => o.type === "reasoning") as Record<string, unknown>;
    expect(reasoning.content).toBeUndefined();
    expect(decodeReasoningEnvelope(reasoning.encrypted_content as string)?.txt).toBe("quiet");
  });

  test("non-streaming visible: raw shape unchanged", () => {
    const json = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "loud" },
      { type: "done" },
    ], "routed/model", {});
    const output = (json as { output: Record<string, unknown>[] }).output;
    expect(output.find(o => o.type === "reasoning")).toMatchObject({
      content: [{ type: "reasoning_text", text: "loud" }],
    });
  });

  test("non-streaming summary presentation uses summary output", () => {
    const json = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "visible progress", presentation: "summary" },
      { type: "tool_call_start", id: "call_2", name: "list_files" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ], "routed/model", {});
    const output = (json as { output: Record<string, unknown>[] }).output;
    expect(output[0]).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "visible progress" }],
    });
    expect(output[1]).toMatchObject({ type: "function_call", call_id: "call_2", name: "list_files" });
    expect(output.some(o => o.type === "message")).toBe(false);
  });

  test("non-streaming hidden summary presentation preserves the txt-only replay envelope", () => {
    const json = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "hidden progress", presentation: "summary" },
      { type: "done" },
    ], "routed/model", { hideThinkingSummary: true });
    const reasoning = (json as { output: Record<string, unknown>[] }).output.find(o => o.type === "reasoning")!;
    expect(reasoning.summary).toEqual([]);
    expect(reasoning.content).toBeUndefined();
    expect(decodeReasoningEnvelope(reasoning.encrypted_content as string)?.txt).toBe("hidden progress");
  });

  test("replay: envelope-only item round-trips into reasoning_content for preserve-listed models", () => {
    const json = buildResponseJSON([
      { type: "reasoning_raw_delta", text: "replay me" },
      { type: "done" },
    ], "routed/model", { hideThinkingSummary: true });
    const reasoningItem = (json as { output: Record<string, unknown>[] }).output.find(o => o.type === "reasoning");
    const parsed = parseRequest({
      model: "glm-5.2",
      stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        reasoningItem,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    const adapter = createOpenAIChatAdapter({
      adapter: "openai-chat", baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKey: "k",
      preserveReasoningContentModels: ["glm-5.2"],
    });
    const body = JSON.parse(adapter.buildRequest(parsed).body) as { messages: Record<string, unknown>[] };
    const assistant = body.messages.find(m => m.role === "assistant" && m.reasoning_content !== undefined);
    expect(assistant?.reasoning_content).toBe("replay me");
  });
});

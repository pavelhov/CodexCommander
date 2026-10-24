import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../src/adapters/anthropic";
import { parseRequest } from "../src/responses/parser";
import { encodeReasoningEnvelope, decodeReasoningEnvelope, CCX_REASONING_PREFIX } from "../src/responses/reasoning-envelope";
import type { AdapterEvent, CodexCommanderProviderConfig, CodexCommanderThinkingContent } from "../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "./helpers/translator-budget";

const createAnthropicAdapter = (...args: Parameters<typeof createAnthropicAdapterProduction>) =>
  withTestTranslatorBudget(createAnthropicAdapterProduction(...args));

const provider: CodexCommanderProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-test",
};

function sseResponse(frames: string[]): Response {
  const body = frames.join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function collect(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function frame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

async function drainSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function sseItems(sse: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const json = JSON.parse(line.slice(6)) as { type?: string; item?: Record<string, unknown> };
      if (json.type === "response.output_item.done" && json.item) items.push(json.item);
    } catch { /* partial */ }
  }
  return items;
}

describe("anthropic thinking-signature capture", () => {
  test("signature_delta on a thinking block yields thinking_signature", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await collect(adapter.parseStream!(sseResponse([
      frame("message_start", { message: { usage: { input_tokens: 1 } } }),
      frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "let me think" } }),
      frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "AbCdEf1234567890sig==" } }),
      frame("content_block_stop", { index: 0 }),
      frame("message_stop", {}),
    ])));
    expect(events).toContainEqual({ type: "thinking_delta", thinking: "let me think" });
    expect(events).toContainEqual({ type: "thinking_signature", signature: "AbCdEf1234567890sig==" });
  });

  test("signature_delta outside a thinking block is ignored (block-scoped)", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await collect(adapter.parseStream!(sseResponse([
      frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "StraySignature123456" } }),
      frame("content_block_stop", { index: 0 }),
      frame("message_stop", {}),
    ])));
    expect(events.find(e => e.type === "thinking_signature")).toBeUndefined();
  });

  test("redacted_thinking blocks surface with their opaque data", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await collect(adapter.parseStream!(sseResponse([
      frame("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: "OPAQUE1" } }),
      frame("content_block_stop", { index: 0 }),
      frame("message_stop", {}),
    ])));
    expect(events).toContainEqual({ type: "redacted_thinking", data: "OPAQUE1" });
  });
});

describe("bridge ccxr1 envelope emission", () => {
  const baseEvents: AdapterEvent[] = [
    { type: "thinking_delta", thinking: "hidden chain" },
    { type: "thinking_signature", signature: "RealSig1234567890==" },
    { type: "text_delta", text: "answer" },
    { type: "done", usage: { inputTokens: 1, outputTokens: 2 } },
  ];

  test("SSE: reasoning item carries the envelope with the signature", async () => {
    async function* gen() { yield* baseEvents; }
    const sse = await drainSse(bridgeToResponsesSSE(gen(), "claude-x"));
    const reasoning = sseItems(sse).find(i => i.type === "reasoning");
    expect(reasoning).toBeDefined();
    const env = decodeReasoningEnvelope(reasoning!.encrypted_content as string);
    expect(env?.sig).toBe("RealSig1234567890==");
  });

  test("SSE hideThinkingSummary: envelope-only reasoning item, no text leak", async () => {
    async function* gen() { yield* baseEvents; }
    const sse = await drainSse(bridgeToResponsesSSE(gen(), "claude-x", undefined, undefined, undefined, undefined, 2000, { hideThinkingSummary: true }));
    const reasoning = sseItems(sse).find(i => i.type === "reasoning");
    expect(reasoning).toBeDefined();
    expect(reasoning!.summary).toEqual([]);
    expect(sse).not.toContain("hidden chain".replace(" ", "\\u0020")); // no raw leak in visible frames
    expect(sse.split("reasoning_summary_text.delta").length).toBe(1); // no summary deltas emitted
    const env = decodeReasoningEnvelope(reasoning!.encrypted_content as string);
    expect(env?.sig).toBe("RealSig1234567890==");
    expect(env?.txt).toBe("hidden chain"); // signed text survives inside the envelope only
  });

  test("JSON: reasoning item carries envelope; redacted blocks included", async () => {
    const response = buildResponseJSON([
      { type: "redacted_thinking", data: "RED1" },
      ...baseEvents,
    ], "claude-x");
    const output = response.output as Record<string, unknown>[];
    const reasoning = output.find(i => i.type === "reasoning");
    expect(reasoning).toBeDefined();
    const env = decodeReasoningEnvelope(reasoning!.encrypted_content as string);
    expect(env?.sig).toBe("RealSig1234567890==");
    expect(env?.red).toEqual(["RED1"]);
  });

  test("redacted-only turn still emits an envelope reasoning item (SSE)", async () => {
    async function* gen(): AsyncGenerator<AdapterEvent> {
      yield { type: "redacted_thinking", data: "ONLYRED" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const sse = await drainSse(bridgeToResponsesSSE(gen(), "claude-x"));
    const reasoning = sseItems(sse).find(i => i.type === "reasoning" && typeof i.encrypted_content === "string");
    expect(reasoning).toBeDefined();
    const env = decodeReasoningEnvelope(reasoning!.encrypted_content as string);
    expect(env?.red).toEqual(["ONLYRED"]);
  });
});

describe("parser ccxr1 decode + anthropic replay", () => {
  test("reasoning input with ccxr1 envelope restores the real signature", async () => {
    const encrypted = encodeReasoningEnvelope({ sig: "RealSig1234567890==", red: ["RED1"] });
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "chain" }], encrypted_content: encrypted },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant");
    expect(assistant).toBeDefined();
    const thinking = (assistant as unknown as { content: CodexCommanderThinkingContent[] }).content.find(p => p.type === "thinking");
    expect(thinking?.signature).toBe("RealSig1234567890==");
    expect(thinking?.redacted).toEqual(["RED1"]);
  });

  // Kiro emits its reasoningContentEvent at the END of an assistant turn (after content AND tool
  // calls), so a krc-only envelope belongs to the turn BEFORE it. Folding it forward like ordinary
  // reasoning would attach turn N's blob to turn N+1 and hand Kiro a mismatched blob.
  test("krc-only reasoning attaches to the preceding assistant turn", async () => {
    const parsed = parseRequest({
      model: "kiro/gpt-5.6-sol",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "first" }] },
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encodeReasoningEnvelope({ krc: "BLOB1" }) },
        { type: "message", role: "user", content: [{ type: "input_text", text: "more" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "second" }] },
      ],
    });
    const assistants = parsed.context.messages.filter(m => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect((assistants[0] as { kiroRedactedReasoning?: string }).kiroRedactedReasoning).toBe("BLOB1");
    expect((assistants[1] as { kiroRedactedReasoning?: string }).kiroRedactedReasoning).toBeUndefined();
  });

  test("krc-only reasoning with no preceding assistant turn is dropped, not mis-paired", async () => {
    const parsed = parseRequest({
      model: "kiro/gpt-5.6-sol",
      input: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encodeReasoningEnvelope({ krc: "ORPHAN" }) },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant");
    expect((assistant as { kiroRedactedReasoning?: string }).kiroRedactedReasoning).toBeUndefined();
  });

  test("hidden signed text (txt) is restored as the thinking body", async () => {
    const encrypted = encodeReasoningEnvelope({ sig: "RealSig1234567890==", txt: "the hidden signed text" });
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: encrypted },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant");
    const thinking = (assistant as unknown as { content: CodexCommanderThinkingContent[] }).content.find(p => p.type === "thinking");
    expect(thinking?.thinking).toBe("the hidden signed text");
  });

  test("native (non-ccxr1) encrypted_content keeps the placeholder signature", async () => {
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "chain" }], encrypted_content: "gAAAAABopaqueOpenAI" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant");
    const thinking = (assistant as unknown as { content: CodexCommanderThinkingContent[] }).content.find(p => p.type === "thinking");
    // placeholder JSON.stringify signature — adapter's validity gate rejects it on replay
    expect(thinking?.signature?.startsWith("{")).toBe(true);
  });

  test("anthropic buildRequest replays thinking + redacted blocks verbatim", async () => {
    const adapter = createAnthropicAdapter(provider);
    const encrypted = encodeReasoningEnvelope({ sig: "RealSig1234567890==", red: ["REDDATA"] });
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "chain" }], encrypted_content: encrypted },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "function_call_output", call_id: "call_1", output: "done" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    const req = await adapter.buildRequest(parsed) as { body: string };
    const body = JSON.parse(req.body) as { messages: { role: string; content: unknown }[] };
    const assistant = body.messages.find(m => m.role === "assistant" && Array.isArray(m.content)
      && (m.content as { type: string }[]).some(c => c.type === "thinking"));
    expect(assistant).toBeDefined();
    const content = assistant!.content as { type: string; thinking?: string; signature?: string; data?: string }[];
    const redIdx = content.findIndex(c => c.type === "redacted_thinking");
    const thinkIdx = content.findIndex(c => c.type === "thinking");
    expect(redIdx).toBeGreaterThanOrEqual(0);
    expect(content[redIdx].data).toBe("REDDATA");
    expect(thinkIdx).toBeGreaterThan(redIdx);
    expect(content[thinkIdx].signature).toBe("RealSig1234567890==");
    expect(content[thinkIdx].thinking).toBe("chain");
  });

  test("two signed reasoning siblings replay with each signature attached to its own text", async () => {
    const adapter = createAnthropicAdapter(provider);
    const firstEnvelope = encodeReasoningEnvelope({
      sig: "FirstRealSignature123456==",
      txt: "first signed chain",
    });
    const secondEnvelope = encodeReasoningEnvelope({
      sig: "SecondRealSignature123456==",
      txt: "second signed chain",
    });
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_first", summary: [], encrypted_content: firstEnvelope },
        { type: "reasoning", id: "rs_second", summary: [], encrypted_content: secondEnvelope },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    const parsedAssistant = parsed.context.messages.find(message => message.role === "assistant") as {
      content: CodexCommanderThinkingContent[];
    };
    const parsedThinking = parsedAssistant.content.filter(part => part.type === "thinking");

    expect(parsedThinking).toHaveLength(2);
    expect(parsedThinking.map(part => ({
      thinking: part.thinking,
      signature: part.signature,
    }))).toEqual([
      { thinking: "first signed chain", signature: "FirstRealSignature123456==" },
      { thinking: "second signed chain", signature: "SecondRealSignature123456==" },
    ]);

    const request = await adapter.buildRequest(parsed) as { body: string };
    const body = JSON.parse(request.body) as {
      messages: Array<{
        role: string;
        content: Array<{ type: string; thinking?: string; signature?: string; text?: string }>;
      }>;
    };
    const replayedAssistant = body.messages.find(message => message.role === "assistant");
    const replayedThinking = replayedAssistant?.content.filter(block => block.type === "thinking");

    expect(replayedThinking).toEqual([
      { type: "thinking", thinking: "first signed chain", signature: "FirstRealSignature123456==" },
      { type: "thinking", thinking: "second signed chain", signature: "SecondRealSignature123456==" },
    ]);
  });
});

describe("passthrough scrub of ccxr1 envelopes", () => {
  test("sanitize strips ccxr1 encrypted_content even with empty content", async () => {
    const { createResponsesPassthroughAdapter } = await import("../src/adapters/openai-responses");
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", passthrough: true,
    } as CodexCommanderProviderConfig));
    expect(adapter.passthrough).toBe(true);
    const body = {
      model: "gpt-5.5",
      input: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: CCX_REASONING_PREFIX + Buffer.from(JSON.stringify({ sig: "RealSig1234567890==" })).toString("base64") },
      ],
    };
    // Build the outgoing request the adapter would send; the ccxr1 envelope must be stripped.
    const req = await adapter.buildRequest({ _rawBody: body, model: "gpt-5.5", messages: [], options: {} } as never) as { body?: string };
    expect(req.body ?? "").not.toContain(CCX_REASONING_PREFIX);
    expect(req.body ?? "").toContain('"rs_1"'); // reasoning item itself survives
  });
});

describe("signed thinking block boundaries + opaque envelope preservation (0.1.25)", () => {
  test("SSE adjacent signed thinking blocks keep each text paired with its own signature", async () => {
    async function* gen(): AsyncGenerator<AdapterEvent> {
      yield { type: "thinking_delta", thinking: "first" };
      yield { type: "thinking_signature", signature: "FirstRealSignature123456==" };
      yield { type: "thinking_delta", thinking: "second" };
      yield { type: "thinking_signature", signature: "SecondRealSignature123456==" };
      yield { type: "text_delta", text: "answer" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const sse = await drainSse(bridgeToResponsesSSE(gen(), "claude-x"));
    const reasoning = sseItems(sse).filter(i => i.type === "reasoning");
    expect(reasoning.map(i => ({
      text: (i.summary as { text: string }[]).map(s => s.text).join(""),
      sig: decodeReasoningEnvelope(i.encrypted_content as string)?.sig,
    }))).toEqual([
      { text: "first", sig: "FirstRealSignature123456==" },
      { text: "second", sig: "SecondRealSignature123456==" },
    ]);
  });

  test("SSE and JSON agree on mixed redacted/visible/empty-signed block order", async () => {
    const events: AdapterEvent[] = [
      { type: "redacted_thinking", data: "RED_A" },
      { type: "thinking_delta", thinking: "visible one" },
      { type: "thinking_signature", signature: "SigOneRealSignature1234==" },
      { type: "redacted_thinking", data: "RED_B" },
      { type: "thinking_signature", signature: "SigEmptyRealSignature12==" },
      { type: "tool_call_start", id: "toolu_1", name: "shell" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    async function* gen(): AsyncGenerator<AdapterEvent> { yield* events; }
    const sse = await drainSse(bridgeToResponsesSSE(gen(), "claude-x"));
    const shape = (items: Record<string, unknown>[]) => items.filter(i => i.type === "reasoning").map(i => {
      const env = decodeReasoningEnvelope(i.encrypted_content as string);
      return { sig: env?.sig, red: env?.red };
    });
    const expected = [
      { sig: "SigOneRealSignature1234==", red: ["RED_A"] },
      { sig: "SigEmptyRealSignature12==", red: ["RED_B"] },
    ];
    expect(shape(sseItems(sse))).toEqual(expected);
    expect(shape(buildResponseJSON(events, "claude-x").output as Record<string, unknown>[])).toEqual(expected);
  });

  test("parser keeps a ccxr1 signature-only envelope as an empty signed thinking block", () => {
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_empty", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: "EmptySignedRealSig123456==" }) },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "done" },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant") as { content: { type: string }[] };
    expect(assistant.content.map(p => p.type)).toEqual(["thinking", "toolCall"]);
    const thinking = assistant.content[0] as CodexCommanderThinkingContent;
    expect(thinking.thinking).toBe("");
    expect(thinking.signature).toBe("EmptySignedRealSig123456==");
  });

  test("parser keeps a ccxr1 redacted-only envelope without inventing a signature", () => {
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_red", summary: [], encrypted_content: encodeReasoningEnvelope({ red: ["ONLY_RED"] }) },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant") as { content: { type: string }[] };
    const thinking = assistant.content.find(p => p.type === "thinking") as CodexCommanderThinkingContent | undefined;
    expect(thinking?.redacted).toEqual(["ONLY_RED"]);
    expect(thinking?.signature).toBeUndefined();
    expect(thinking?.thinking).toBe("");
  });

  test("parser keeps adjacent unsigned text from absorbing a redacted-only envelope", () => {
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_red", summary: [{ type: "summary_text", text: "redacted note" }], encrypted_content: encodeReasoningEnvelope({ red: ["KEEP_RED"] }) },
        { type: "reasoning", id: "rs_plain", summary: [{ type: "summary_text", text: "plain" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant") as { content: { type: string }[] };
    const thinking = assistant.content.filter(p => p.type === "thinking") as CodexCommanderThinkingContent[];
    expect(thinking.flatMap(p => p.redacted ?? [])).toEqual(["KEEP_RED"]);
  });

  test("native encrypted-only and invalid ccxr1 reasoning remain dropped", () => {
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_native", summary: [], encrypted_content: "gAAAAABopaqueOpenAI" },
        { type: "reasoning", id: "rs_bad", summary: [], encrypted_content: `${CCX_REASONING_PREFIX}!!notbase64json` },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
    });
    const assistant = parsed.context.messages.find(m => m.role === "assistant") as { content: { type: string }[] };
    expect(assistant.content.map(p => p.type)).toEqual(["text"]);
  });

  for (const mode of ["sse", "json"] as const) {
    test(`${mode}: Opus empty-signed + adjacent signed blocks survive response → parseRequest → Anthropic tool-result continuation`, async () => {
      const events: AdapterEvent[] = [
        { type: "thinking_signature", signature: "EmptySignedRealSig123456==" },
        { type: "redacted_thinking", data: "RED_MID" },
        { type: "thinking_delta", thinking: "first" },
        { type: "thinking_signature", signature: "FirstRealSignature123456==" },
        { type: "thinking_delta", thinking: "second" },
        { type: "thinking_signature", signature: "SecondRealSignature123456==" },
        { type: "tool_call_start", id: "toolu_1", name: "shell" },
        { type: "tool_call_delta", arguments: "{}" },
        { type: "tool_call_end" },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "toolUse" } as AdapterEvent,
      ];
      let output: Record<string, unknown>[];
      if (mode === "sse") {
        async function* gen(): AsyncGenerator<AdapterEvent> { yield* events; }
        output = sseItems(await drainSse(bridgeToResponsesSSE(gen(), "claude-x")));
      } else {
        output = buildResponseJSON(events, "claude-x").output as Record<string, unknown>[];
      }
      const call = output.find(i => i.type === "function_call") as { call_id: string };
      const parsed = parseRequest({
        model: "anthropic/claude-x",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
          ...output,
          { type: "function_call_output", call_id: call.call_id, output: "done" },
        ],
      });
      const adapter = createAnthropicAdapter(provider);
      const body = JSON.parse((await adapter.buildRequest(parsed) as { body: string }).body) as {
        messages: Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
      };
      const assistant = body.messages.find(m => m.role === "assistant")!;
      const blocks = (assistant.content as Array<Record<string, unknown>>).map(b => {
        if (b.type === "thinking") return { type: b.type, thinking: b.thinking, signature: b.signature };
        if (b.type === "redacted_thinking") return { type: b.type, data: b.data };
        return { type: b.type };
      });
      expect(blocks).toEqual([
        { type: "thinking", thinking: "", signature: "EmptySignedRealSig123456==" },
        { type: "redacted_thinking", data: "RED_MID" },
        { type: "thinking", thinking: "first", signature: "FirstRealSignature123456==" },
        { type: "thinking", thinking: "second", signature: "SecondRealSignature123456==" },
        { type: "tool_use" },
      ]);
      const next = body.messages[body.messages.indexOf(assistant) + 1];
      expect(next.role).toBe("user");
      expect((next.content as Array<{ type: string }>)[0].type).toBe("tool_result");
    });
  }
});

describe("anthropic signature fragments at the block boundary (0.1.25)", () => {
  const fragmentedStream = () => sseResponse([
    frame("message_start", { message: { usage: { input_tokens: 1 } } }),
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "first" } }),
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "FirstReal" } }),
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "Signature123456==" } }),
    frame("content_block_stop", { index: 0 }),
    frame("content_block_start", { index: 1, content_block: { type: "thinking", thinking: "" } }),
    frame("content_block_delta", { index: 1, delta: { type: "signature_delta", signature: "EmptySigned" } }),
    frame("content_block_delta", { index: 1, delta: { type: "signature_delta", signature: "RealSig123456==" } }),
    frame("content_block_stop", { index: 1 }),
    frame("content_block_start", { index: 2, content_block: { type: "thinking", thinking: "" } }),
    frame("content_block_delta", { index: 2, delta: { type: "thinking_delta", thinking: "second" } }),
    frame("content_block_delta", { index: 2, delta: { type: "signature_delta", signature: "SecondRealSignature123456==" } }),
    frame("content_block_stop", { index: 2 }),
    frame("content_block_start", { index: 3, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 3, delta: { type: "text_delta", text: "answer" } }),
    frame("content_block_stop", { index: 3 }),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
    frame("message_stop", {}),
  ]);
  const expected = [
    { text: "first", sig: "FirstRealSignature123456==" },
    { text: "", sig: "EmptySignedRealSig123456==" },
    { text: "second", sig: "SecondRealSignature123456==" },
  ];
  const shape = (items: Record<string, unknown>[]) => items.filter(i => i.type === "reasoning").map(i => ({
    text: ((i.summary as { text: string }[] | undefined) ?? []).map(s => s.text).join(""),
    sig: decodeReasoningEnvelope(i.encrypted_content as string)?.sig,
  }));

  test("adapter emits one whole signature per completed thinking block", async () => {
    const adapter = createAnthropicAdapter(provider);
    const events = await collect(adapter.parseStream!(fragmentedStream()));
    expect(events.filter(e => e.type === "thinking_signature")).toEqual(expected.map(e => ({ type: "thinking_signature", signature: e.sig })));
  });

  test("adapter never emits a partial signature for a block cut off before content_block_stop", async () => {
    const adapter = createAnthropicAdapter(provider);
    const budget = createTestTranslatorBudget();
    const events = await collect(adapter.parseStream!(sseResponse([
      frame("message_start", { message: { usage: { input_tokens: 1 } } }),
      frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "PartialFragment" } }),
    ]), budget));
    expect(events.filter(e => e.type === "error")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "thinking_signature" || e.type === "done")).toBe(false);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("adapter SSE → bridge SSE and JSON agree on whole per-block signatures", async () => {
    const adapter = createAnthropicAdapter(provider);
    const sse = await drainSse(bridgeToResponsesSSE(adapter.parseStream!(fragmentedStream()), "claude-x"));
    expect(shape(sseItems(sse))).toEqual(expected);
    const events = await collect(createAnthropicAdapter(provider).parseStream!(fragmentedStream()));
    expect(shape(buildResponseJSON(events, "claude-x").output as Record<string, unknown>[])).toEqual(expected);
  });
});

describe("trailing Anthropic redacted blocks preserve replay order", () => {
  for (const mode of ["sse", "json"] as const) {
    for (const hideThinkingSummary of [false, true]) {
      for (const next of ["tool", "text"] as const) {
        test(`${mode}, hidden=${hideThinkingSummary}: signed thinking then redacted block stays before ${next}`, async () => {
          const signature = "FirstRealSignature123456==";
          const adapter = createAnthropicAdapter(provider);
          let output: Record<string, unknown>[];
          if (mode === "sse") {
            const frames = [
              frame("message_start", { message: {} }),
              frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
              frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "first" } }),
              frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature } }),
              frame("content_block_stop", { index: 0 }),
              frame("content_block_start", { index: 1, content_block: { type: "redacted_thinking", data: "RED_AFTER_FIRST" } }),
              frame("content_block_stop", { index: 1 }),
              frame("content_block_start", { index: 2, content_block: next === "tool"
                ? { type: "tool_use", id: "toolu_1", name: "shell" } : { type: "text", text: "" } }),
              frame("content_block_delta", { index: 2, delta: next === "tool"
                ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text: "answer" } }),
              frame("content_block_stop", { index: 2 }),
              frame("message_delta", { delta: { stop_reason: next === "tool" ? "tool_use" : "end_turn" } }),
              frame("message_stop", {}),
            ];
            output = sseItems(await drainSse(bridgeToResponsesSSE(
              adapter.parseStream(sseResponse(frames)), "claude-x",
              undefined, undefined, undefined, undefined, 0, { hideThinkingSummary },
            )));
          } else {
            const events = await adapter.parseResponse!(new Response(JSON.stringify({
              content: [
                { type: "thinking", thinking: "first", signature },
                { type: "redacted_thinking", data: "RED_AFTER_FIRST" },
                next === "tool" ? { type: "tool_use", id: "toolu_1", name: "shell", input: {} }
                  : { type: "text", text: "answer" },
              ],
              stop_reason: next === "tool" ? "tool_use" : "end_turn",
            })));
            output = buildResponseJSON(events, "claude-x", { hideThinkingSummary }).output as Record<string, unknown>[];
          }
          expect(output.map(item => item.type)).toEqual(["reasoning", "reasoning", next === "tool" ? "function_call" : "message"]);
          if (hideThinkingSummary) expect(output.filter(item => item.type === "reasoning").every(item => (item.summary as unknown[]).length === 0)).toBe(true);
          const parsed = parseRequest({
            model: "anthropic/claude-x",
            input: [
              { type: "message", role: "user", content: "go" },
              ...output,
              ...(next === "tool" ? [{ type: "function_call_output", call_id: "toolu_1", output: "done" }]
                : [{ type: "message", role: "user", content: "next" }]),
            ],
          });
          const body = JSON.parse(String((await adapter.buildRequest(parsed)).body)) as {
            messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
          };
          const assistant = body.messages.find(message => message.role === "assistant")!;
          expect(assistant.content.map(block => {
            if (block.type === "thinking") return { type: block.type, thinking: block.thinking, signature: block.signature };
            if (block.type === "redacted_thinking") return { type: block.type, data: block.data };
            return { type: block.type };
          })).toEqual([
            { type: "thinking", thinking: "first", signature },
            { type: "redacted_thinking", data: "RED_AFTER_FIRST" },
            { type: next === "tool" ? "tool_use" : "text" },
          ]);
          if (next === "tool") {
            const toolResult = body.messages[body.messages.indexOf(assistant) + 1];
            expect(toolResult.role).toBe("user");
            expect(toolResult.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
          }
        });
      }
    }
  }
});

describe("unterminated Anthropic thinking blocks fail closed", () => {
  function openThinkingFrames(type: "thinking" | "reasoning" = "thinking") {
    return [
      frame("message_start", { message: {} }),
      frame("content_block_start", { index: 0, content_block: { type } }),
      frame("content_block_delta", { index: 0, delta: type === "thinking"
        ? { type: "thinking_delta", thinking: "unfinished" } : { type: "reasoning_delta", reasoning: "unfinished" } }),
      frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "PartialFragment" } }),
    ];
  }
  const endings = {
    "stop reason then EOF": [frame("message_delta", { delta: { stop_reason: "end_turn" } })],
    "message_stop": [frame("message_delta", { delta: { stop_reason: "tool_use" } }), frame("message_stop", {})],
    "new content block": [
      frame("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { index: 1, delta: { type: "text_delta", text: "answer" } }),
      frame("content_block_stop", { index: 1 }),
      frame("message_delta", { delta: { stop_reason: "end_turn" } }), frame("message_stop", {}),
    ],
  };
  for (const type of ["thinking", "reasoning"] as const) {
    for (const [name, ending] of Object.entries(endings)) {
      test(`${type}: ${name} cannot complete or publish a partial signature`, async () => {
        const budget = createTestTranslatorBudget();
        const events = await collect(createAnthropicAdapter(provider).parseStream(sseResponse([
          ...openThinkingFrames(type), ...ending,
        ]), budget));
        expect(events.filter(event => event.type === "error")).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("content_block_stop") });
        expect(events.some(event => event.type === "done" || event.type === "thinking_signature" || event.type === "text_delta")).toBe(false);
        expect(budget.snapshot().currentBytes).toBe(0);
      });
    }
  }

  test("EOF tolerance cannot complete visible text followed by an open thinking block", async () => {
    const budget = createTestTranslatorBudget();
    const events = await collect(createAnthropicAdapter({ ...provider, anthropicEofTolerance: true }).parseStream(sseResponse([
      frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "earlier visible text" } }),
      frame("content_block_stop", { index: 0 }),
      ...openThinkingFrames(),
    ]), budget));
    expect(events.filter(event => event.type === "error")).toHaveLength(1);
    expect(events.some(event => event.type === "done" || event.type === "thinking_signature")).toBe(false);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("a closed signed thinking block may complete at stop_reason plus EOF", async () => {
    const budget = createTestTranslatorBudget();
    const events = await collect(createAnthropicAdapter(provider).parseStream(sseResponse([
      ...openThinkingFrames(), frame("content_block_stop", { index: 0 }),
      frame("message_delta", { delta: { stop_reason: "end_turn" } }),
    ]), budget));
    expect(events.filter(event => event.type === "thinking_signature")).toEqual([{ type: "thinking_signature", signature: "PartialFragment" }]);
    expect(events.filter(event => event.type === "done")).toHaveLength(1);
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("an upstream error discards signature fragments and releases their retained bytes", async () => {
    const budget = createTestTranslatorBudget();
    const events = await collect(createAnthropicAdapter(provider).parseStream(sseResponse([
      ...openThinkingFrames(), frame("error", { error: { message: "fixture upstream error" } }),
    ]), budget));
    expect(events.filter(event => event.type === "error")).toEqual([{ type: "error", message: "fixture upstream error" }]);
    expect(events.some(event => event.type === "done" || event.type === "thinking_signature")).toBe(false);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("transport failure releases an actually retained signature and propagates its error", async () => {
    const budget = createTestTranslatorBudget();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) {
      controller = value;
      controller.enqueue(new TextEncoder().encode([...openThinkingFrames(), frame("ping", {})].join("")));
    } }));
    const iterator = createAnthropicAdapter(provider).parseStream(response, budget);
    expect((await iterator.next()).value).toMatchObject({ type: "thinking_delta" });
    expect((await iterator.next()).value).toEqual({ type: "heartbeat" });
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    controller.error(new Error("fixture transport failure"));
    await expect(iterator.next()).rejects.toThrow("fixture transport failure");
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("iterator cancellation releases an actually retained signature and cancels upstream", async () => {
    const budget = createTestTranslatorBudget();
    let cancelled = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode([...openThinkingFrames(), frame("ping", {})].join(""))); },
      cancel() { cancelled++; },
    }));
    const iterator = createAnthropicAdapter(provider).parseStream(response, budget);
    expect((await iterator.next()).value).toMatchObject({ type: "thinking_delta" });
    expect((await iterator.next()).value).toEqual({ type: "heartbeat" });
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    await iterator.return(undefined);
    expect(cancelled).toBe(1);
    expect(budget.snapshot().currentBytes).toBe(0);
  });
});

describe("anthropic signature collector translator budget (0.1.25)", () => {
  test("many small signature fragments over the turn cap fail once with translation_buffer_limit and release retained bytes", async () => {
    const adapter = createAnthropicAdapter(provider);
    const budget = createTestTranslatorBudget({ maxTurnBytes: 4096 });
    const fragments = Array.from({ length: 400 }, () =>
      frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "FakeSigFragment0" } }));
    const events = await collect(adapter.parseStream!(sseResponse([
      frame("message_start", { message: { usage: { input_tokens: 1 } } }),
      frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      ...fragments,
      frame("content_block_stop", { index: 0 }),
      frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      frame("message_stop", {}),
    ]), budget));
    const errors = events.filter(e => e.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { code?: string }).code).toBe("translation_buffer_limit");
    expect(events[events.length - 1]?.type).toBe("error");
    expect(events.some(e => e.type === "thinking_signature" || e.type === "done")).toBe(false);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("a completed signed block releases its retained signature bytes", async () => {
    const adapter = createAnthropicAdapter(provider);
    const budget = createTestTranslatorBudget({ maxTurnBytes: 4096 });
    const events = await collect(adapter.parseStream!(sseResponse([
      frame("message_start", { message: { usage: { input_tokens: 1 } } }),
      frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      ...Array.from({ length: 20 }, () =>
        frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "FakeSigFragment0" } })),
      frame("content_block_stop", { index: 0 }),
      frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      frame("message_stop", {}),
    ]), budget));
    expect(events.filter(e => e.type === "thinking_signature")).toEqual([
      { type: "thinking_signature", signature: "FakeSigFragment0".repeat(20) },
    ]);
    expect(budget.snapshot().currentBytes).toBe(0);
  });
});

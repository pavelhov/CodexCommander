import { describe, expect, test } from "bun:test";
import {
  analyzeTerminalTurn,
  buildContinuationRequest,
  guardTerminalEventStream,
} from "../src/server/responses/terminal-guard";
import { buildResponseJSON } from "../src/bridge";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { withTestTranslatorBudget } from "./helpers/translator-budget";
import type { AdapterEvent, CodexCommanderParsedRequest } from "../src/types";

function anthropicThinkingTurn(withTool = false): Response {
  const frame = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const frames = [frame("message_start", { message: { usage: { input_tokens: 10 } } })];
  let index = 0;
  for (const block of [
    { type: "redacted_thinking", data: "FAKE_REDACTED_BEFORE" },
    { type: "thinking", thinking: "first signed chain", signature: "FakeFirstSignature123456==" },
    { type: "redacted_thinking", data: "FAKE_REDACTED_MIDDLE" },
    { type: "thinking", thinking: "", signature: "FakeEmptySignature123456==" },
    { type: "thinking", thinking: "second signed chain", signature: "FakeSecondSignature123456==" },
    { type: "redacted_thinking", data: "FAKE_REDACTED_AFTER" },
  ]) {
    frames.push(frame("content_block_start", {
      index, content_block: block.type === "thinking" ? { type: "thinking", thinking: "" } : block,
    }));
    if (block.type === "thinking") {
      if (block.thinking) frames.push(frame("content_block_delta", {
        index, delta: { type: "thinking_delta", thinking: block.thinking },
      }));
      // Real streams fragment signatures; the adapter closes each complete signature at stop.
      for (const signature of [block.signature!.slice(0, 7), block.signature!.slice(7)]) {
        frames.push(frame("content_block_delta", { index, delta: { type: "signature_delta", signature } }));
      }
    }
    frames.push(frame("content_block_stop", { index }));
    index += 1;
  }
  frames.push(frame("content_block_start", { index, content_block: { type: "text", text: "" } }));
  frames.push(frame("content_block_delta", { index, delta: { type: "text_delta", text: "I'll fix the parser." } }));
  frames.push(frame("content_block_stop", { index }));
  if (withTool) {
    index += 1;
    frames.push(frame("content_block_start", {
      index, content_block: { type: "tool_use", id: "toolu_fake", name: "exec_command", input: {} },
    }));
    frames.push(frame("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: "{}" } }));
    frames.push(frame("content_block_stop", { index }));
  }
  frames.push(frame("message_delta", { delta: { stop_reason: withTool ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } }));
  frames.push(frame("message_stop", {}));
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

function parsed(userText: string, withTools = true): CodexCommanderParsedRequest {
  return {
    modelId: "se-claude-opus-4.8",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: userText, timestamp: 1 }],
      ...(withTools ? { tools: [{ name: "exec_command", description: "run a command", parameters: {} }] } : {}),
    },
  };
}

describe("terminal guard", () => {
  test("recognizes an actionable no-tool completion as suspicious", () => {
    const analysis = analyzeTerminalTurn(parsed("请检查这个问题并修复代码"), [
      { type: "text_delta", text: "我接下来会修改相关文件。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("continue");
    expect(analysis.hasToolCall).toBe(false);
  });

  test("treats an explicit continue command as actionable", () => {
    const analysis = analyzeTerminalTurn(parsed("继续"), [
      { type: "text_delta", text: "Let me poll again for completion." },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("continue");
  });

  test("does not continue when the user explicitly requested a plan without tool execution", () => {
    const analysis = analyzeTerminalTurn(parsed("先给我一个修改方案，暂时不要调用工具，只回复计划"), [
      { type: "text_delta", text: "我会先列出修改计划。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
  });

  test("does not force tools for an ordinary plan/proposal request without explicit tool prohibition", () => {
    // Regression (#394 review blocker 2): a plain 'write a concise implementation plan' request
    // must NOT be treated as a suspicious no-tool completion, even though it contains the
    // actionable verbs 'write'/'implementation'. Otherwise the guard nudges Claude to run tools
    // against a plan-only ask, causing side effects.
    for (const ask of [
      "Write a concise implementation plan for this change",
      "Give me a high-level plan before we start",
      "Draft a migration plan for the schema",
      "Propose an approach for refactoring the router",
      "先写一个实现方案",
      "给我一个重构计划",
    ]) {
      const analysis = analyzeTerminalTurn(parsed(ask), [
        { type: "text_delta", text: "Here is the plan: 1) ... 2) ... 3) ..." },
        { type: "done" },
      ]);
      expect(analysis.decision).toBe("pass");
      expect(analysis.reason).toBe("no_actionable_request");
    }
  });

  test("does not auto-repeat an explicit continue after a recent tool-backed turn", () => {
    const request = parsed("继续");
    request.context.messages = [
      { role: "user", content: "请检查代码", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "exec_command", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_1", toolName: "exec_command", content: "ok", isError: false, timestamp: 3 },
      { role: "user", content: "继续", timestamp: 4 },
    ];

    const analysis = analyzeTerminalTurn(request, [
      { type: "text_delta", text: "已经完成了。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
    expect(analysis.reason).toBe("recent_tool_activity");
  });

  test("continues when the last assistant message was a plan-only stop after earlier tools", () => {
    const request = parsed("继续");
    request.context.messages = [
      { role: "user", content: "请检查代码", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "exec_command", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_1", toolName: "exec_command", content: "ok", isError: false, timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "Let me verify the final result." }], timestamp: 4 },
      { role: "user", content: "继续", timestamp: 5 },
    ];

    const analysis = analyzeTerminalTurn(request, [
      { type: "text_delta", text: "Let me poll again for completion." },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("continue");
  });

  test("does not continue a normal explanatory answer", () => {
    const analysis = analyzeTerminalTurn(parsed("为什么会出现这个错误？", false), [
      { type: "text_delta", text: "这是因为请求在上游被限流。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
  });

  test("does not continue a substantive final answer that merely contains a completion phrase", () => {
    const analysis = analyzeTerminalTurn(parsed("请检查这个问题并给出分析"), [
      { type: "text_delta", text: `已完成分析。${"这是完整结论和依据。".repeat(30)}` },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
    expect(analysis.reason).toBe("substantive_answer");
  });

  test("does not continue after a real tool call", () => {
    const analysis = analyzeTerminalTurn(parsed("请检查并修复代码"), [
      { type: "tool_call_start", id: "call_1", name: "exec_command" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "text_delta", text: "已完成。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
    expect(analysis.hasToolCall).toBe(true);
  });

  test("does not auto-continue an explicit clarification question", () => {
    const analysis = analyzeTerminalTurn(parsed("请修复这个问题"), [
      { type: "text_delta", text: "需要我修改哪个文件？" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
    expect(analysis.reason).toBe("waiting_for_user");
  });

  test("builds an internal continuation request without changing the original history", () => {
    const original = parsed("请检查这个问题并修复代码");
    const next = buildContinuationRequest(original, [
      { type: "text_delta", text: "我接下来会修改相关文件。" },
      { type: "done" },
    ]);

    expect(original.context.messages).toHaveLength(1);
    expect(next.context.messages).toHaveLength(3);
    expect(next.context.messages[1]).toMatchObject({ role: "assistant" });
    expect(next.context.messages[2]).toMatchObject({ role: "developer" });
  });

  test("replays native signed blocks, empty signed blocks and redactions intact in the no-tool continuation", async () => {
    const adapter = withTestTranslatorBudget(createAnthropicAdapter({
      adapter: "anthropic", baseUrl: "https://example.test", apiKey: "sk-test",
    }));
    const original = parsed("Fix the parser");
    original.modelId = "claude-opus-5-5";
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(anthropicThinkingTurn())) events.push(event);
    expect(analyzeTerminalTurn(original, events).decision).toBe("continue");

    const expectedContent = [
      { type: "redacted_thinking", data: "FAKE_REDACTED_BEFORE" },
      { type: "thinking", thinking: "first signed chain", signature: "FakeFirstSignature123456==" },
      { type: "redacted_thinking", data: "FAKE_REDACTED_MIDDLE" },
      { type: "thinking", thinking: "", signature: "FakeEmptySignature123456==" },
      { type: "thinking", thinking: "second signed chain", signature: "FakeSecondSignature123456==" },
      { type: "redacted_thinking", data: "FAKE_REDACTED_AFTER" },
      { type: "text", text: "I'll fix the parser." },
    ];
    const assistantContent = async (next: CodexCommanderParsedRequest) => {
      const request = await adapter.buildRequest(next) as { body: string };
      const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: unknown }> };
      return body.messages.find(message => message.role === "assistant")?.content;
    };
    expect(await assistantContent(buildContinuationRequest(original, events))).toEqual(expectedContent);
    expect(original.context.messages).toHaveLength(1);

    let continuations = 0;
    const output: AdapterEvent[] = [];
    for await (const event of guardTerminalEventStream({
      parsed: original,
      firstEvents: (async function* () { yield* events; })(),
      adapterName: "anthropic",
      continuation: async next => {
        continuations += 1;
        expect(await assistantContent(next)).toEqual(expectedContent);
        return (async function* (): AsyncGenerator<AdapterEvent> {
          yield { type: "tool_call_start", id: "toolu_next", name: "exec_command" };
          yield { type: "tool_call_delta", arguments: "{}" };
          yield { type: "tool_call_end" };
          yield { type: "done" };
        })();
      },
    })) output.push(event);
    expect(continuations).toBe(1);
    expect(output.filter(event => event.type === "assistant_boundary")).toHaveLength(1);
    expect(output.filter(event => event.type === "thinking_signature")).toEqual(events.filter(event => event.type === "thinking_signature"));
    expect(output.filter(event => event.type === "redacted_thinking")).toEqual(events.filter(event => event.type === "redacted_thinking"));
    expect(output.filter(event => event.type === "done")).toHaveLength(1);
    expect(output.some(event => event.type === "tool_call_start")).toBe(true);
  });

  test("native signed thinking does not activate the guard without available tools or after a tool call", async () => {
    for (const withTool of [false, true]) {
      const adapter = withTestTranslatorBudget(createAnthropicAdapter({
        adapter: "anthropic", baseUrl: "https://example.test", apiKey: "sk-test",
      }));
      let continuations = 0;
      const output: AdapterEvent[] = [];
      for await (const event of guardTerminalEventStream({
        parsed: parsed("Fix the parser", withTool),
        firstEvents: adapter.parseStream(anthropicThinkingTurn(withTool)),
        adapterName: "anthropic",
        continuation: () => {
          continuations += 1;
          return (async function* (): AsyncGenerator<AdapterEvent> { yield { type: "done" }; })();
        },
      })) output.push(event);
      expect(continuations).toBe(0);
      expect(output.some(event => event.type === "assistant_boundary")).toBe(false);
      expect(output.filter(event => event.type === "thinking_signature")).toHaveLength(3);
      expect(output.filter(event => event.type === "done")).toHaveLength(1);
      expect(output.some(event => event.type === "tool_call_start")).toBe(withTool);
    }
  });

  test("can guard a fetch-based adapter stream with a continuation callback", async () => {
    let continuations = 0;
    const actual: AdapterEvent[] = [];
    for await (const event of guardTerminalEventStream({
      parsed: parsed("请检查这个问题并修复代码"),
      firstEvents: (async function* () {
        yield { type: "text_delta", text: "我接下来会修改相关文件。" } as AdapterEvent;
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } } as AdapterEvent;
      })(),
      continuation: next => {
        continuations += 1;
        expect(next.context.messages.at(-1)).toMatchObject({ role: "developer" });
        return (async function* () {
          yield { type: "tool_call_start", id: "call_1", name: "exec_command" } as AdapterEvent;
          yield { type: "tool_call_end" } as AdapterEvent;
          yield { type: "done", usage: { inputTokens: 20, outputTokens: 3 } } as AdapterEvent;
        })();
      },
      adapterName: "anthropic",
    })) actual.push(event);

    expect(continuations).toBe(1);
    expect(actual.filter(event => event.type === "done")).toHaveLength(1);
    expect(actual.some(event => event.type === "assistant_boundary")).toBe(true);
    expect(actual.at(-1)).toMatchObject({ usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 } });
  });

  test("stops after the configured continuation bound", async () => {
    let continuations = 0;
    const actual: AdapterEvent[] = [];
    const suspicious = () => (async function* () {
      yield { type: "text_delta", text: "Let me check again." } as AdapterEvent;
      yield { type: "done" } as AdapterEvent;
    })();

    for await (const event of guardTerminalEventStream({
      parsed: parsed("继续"),
      firstEvents: suspicious(),
      continuation: () => {
        continuations += 1;
        return suspicious();
      },
      adapterName: "anthropic",
      maxAutoContinuations: 1,
    })) actual.push(event);

    expect(continuations).toBe(1);
    expect(actual.filter(event => event.type === "assistant_boundary")).toHaveLength(1);
    expect(actual.filter(event => event.type === "done")).toHaveLength(1);
  });

  test("serializes the guarded boundary as separate assistant output items", () => {
    const response = buildResponseJSON([
      { type: "text_delta", text: "我接下来会修改。" },
      { type: "assistant_boundary" },
      { type: "tool_call_start", id: "call_1", name: "exec_command" },
      { type: "tool_call_end" },
      { type: "done" },
    ], "se-claude-opus-4.8");

    expect((response.output as { type: string }[]).map(item => item.type)).toEqual(["message", "function_call"]);
  });
});

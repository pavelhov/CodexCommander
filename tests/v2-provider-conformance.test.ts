import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { handleResponses } from "../src/server/responses";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

const routeCases = [
  { label: "xAI Chat", adapter: "openai-chat", terminal: "stream-done", provider: "xai", model: "xai/grok-4.5" },
  { label: "Kimi Chat", adapter: "openai-chat", terminal: "stream-done", provider: "kimi-code", model: "kimi-code/kimi-k2.7-code" },
  { label: "DeepSeek V4 bounded Responses", adapter: "openai-responses", terminal: "synthesized-done", provider: "deepseek", model: "deepseek/deepseek-v4-flash" },
  { label: "native OpenAI Responses", adapter: "openai-responses", terminal: "passthrough", provider: "openai", model: "gpt-5.6-sol" },
] as const;

type RouteCase = typeof routeCases[number];
type JsonRecord = Record<string, unknown>;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function collaborationNamespace(): JsonRecord {
  const empty = (name: string): JsonRecord => ({
    type: "function",
    name,
    parameters: { type: "object", properties: {} },
  });
  return {
    type: "namespace",
    name: "collaboration",
    tools: [
      empty("spawn_agent"),
      empty("followup_task"),
      empty("interrupt_agent"),
      empty("list_agents"),
      empty("send_message"),
      {
        type: "function",
        name: "wait_agent",
        parameters: {
          type: "object",
          properties: {
            timeout_ms: { type: "number" },
            retry_after: { type: "number" },
          },
          required: ["timeout_ms"],
        },
      },
    ],
  };
}

function v2Request(model: string, stream = true): JsonRecord {
  return {
    model,
    stream,
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [collaborationNamespace()],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "complete this collaboration turn" }],
      },
    ],
  };
}

function seededProvider(name: "xai" | "kimi-code" | "deepseek"): CodexCommanderProviderConfig {
  return {
    ...providerConfigSeed(getProviderRegistryEntry(name)!),
    apiKey: "test-key",
    authMode: "key",
  };
}

function configFor(route: RouteCase): CodexCommanderConfig {
  if (route.provider === "openai") {
    return {
      port: 0,
      defaultProvider: "openai",
      providers: {
        openai: {
          ...providerConfigSeed(getProviderRegistryEntry("openai")!),
          codexAccountMode: "direct",
        },
      },
    } as CodexCommanderConfig;
  }
  return {
    port: 0,
    defaultProvider: route.provider,
    multiAgentV2MessageDelivery: "plaintext",
    providers: { [route.provider]: seededProvider(route.provider) },
  } as CodexCommanderConfig;
}

function chatToolAndAnswerSse(): string {
  const toolCall = {
    index: 0,
    id: "call_wait",
    function: {
      name: "collaboration__wait_agent",
      arguments: "{\"timeout_ms\":120.0,\"retry_after\":1.5}",
    },
  };
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "terminal answer" } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function responsesCompletedJson(): JsonRecord {
  return {
    id: "resp_deepseek",
    object: "response",
    status: "completed",
    output: [{
      type: "message",
      id: "msg_deepseek",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "terminal answer" }],
    }],
  };
}

function nativeCompletedSse(): string {
  const item = {
    type: "function_call",
    id: "fc_native",
    call_id: "call_native",
    namespace: "collaboration",
    name: "wait_agent",
    arguments: "{\"timeout_ms\":120.0,\"retry_after\":1.5}",
    status: "completed",
  };
  const response = {
    id: "resp_native",
    object: "response",
    status: "completed",
    output: [item, {
      type: "message",
      id: "msg_native",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "terminal answer" }],
    }],
  };
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function ssePayloads(text: string): JsonRecord[] {
  return text.split(/\r?\n/)
    .filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6)) as JsonRecord);
}

function completedResponse(payloads: JsonRecord[]): JsonRecord {
  const completed = payloads.filter(payload => payload.type === "response.completed");
  expect(completed).toHaveLength(1);
  return completed[0]!.response as JsonRecord;
}

function hasCompletedAssistantMessage(output: unknown): boolean {
  return Array.isArray(output) && output.some(item => {
    const record = item as JsonRecord;
    return record.type === "message"
      && record.role === "assistant"
      && record.status === "completed"
      && Array.isArray(record.content)
      && (record.content as JsonRecord[]).some(part => part.type === "output_text");
  });
}

function completedAssistantOutputText(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  const message = output.find(item => {
    const record = item as JsonRecord;
    return record.type === "message"
      && record.role === "assistant"
      && record.status === "completed";
  }) as JsonRecord | undefined;
  const part = Array.isArray(message?.content)
    ? (message.content as JsonRecord[]).find(candidate => candidate.type === "output_text")
    : undefined;
  return typeof part?.text === "string" ? part.text : undefined;
}

describe("V2 provider route-class conformance", () => {
  for (const route of routeCases.filter((candidate): candidate is Extract<RouteCase, { adapter: "openai-chat" }> => candidate.adapter === "openai-chat")) {
    test(`${route.label} preserves V2 namespace and completed numeric tool arguments`, async () => {
      let upstreamBody: JsonRecord | undefined;
      globalThis.fetch = (async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body ?? "{}")) as JsonRecord;
        return new Response(chatToolAndAnswerSse(), {
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;

      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(v2Request(route.model)),
      }), configFor(route), { model: "", provider: "" });
      const text = await response.text();
      const payloads = ssePayloads(text);

      expect(upstreamBody?.stream).toBe(true);
      const wireTools = upstreamBody?.tools as JsonRecord[];
      const waitTool = wireTools.find(tool => tool.function && (tool.function as JsonRecord).name === "collaboration__wait_agent");
      expect(waitTool).toBeDefined();
      expect(((waitTool!.function as JsonRecord).parameters as JsonRecord).properties).toMatchObject({
        timeout_ms: { type: "number" },
        retry_after: { type: "number" },
      });

      const completedCall = payloads.find(payload => payload.type === "response.output_item.done")?.item as JsonRecord;
      expect(completedCall).toMatchObject({
        type: "function_call",
        namespace: "collaboration",
        name: "wait_agent",
        call_id: "call_wait",
        status: "completed",
      });
      expect(completedCall.arguments).toBe("{\"timeout_ms\":120,\"retry_after\":1.5}");
      const argumentDone = payloads.find(payload => payload.type === "response.function_call_arguments.done");
      expect(argumentDone?.arguments).toBe("{\"timeout_ms\":120,\"retry_after\":1.5}");

      const completed = completedResponse(payloads);
      const completedSnapshotCall = (completed.output as JsonRecord[])
        .find(item => item.type === "function_call");
      expect(completedSnapshotCall).toMatchObject({
        namespace: "collaboration",
        name: "wait_agent",
        status: "completed",
        arguments: "{\"timeout_ms\":120,\"retry_after\":1.5}",
      });
      expect(hasCompletedAssistantMessage(completed.output)).toBe(true);
      expect(completedAssistantOutputText(completed.output)).toBe("terminal answer");
      expect(text).toContain("data: [DONE]");
    });
  }

  test("DeepSeek V4 bounded Responses synthesizes a completed stream on its native route", async () => {
    const route = routeCases.find(candidate => candidate.provider === "deepseek")!;
    let upstreamUrl = "";
    let upstreamBody: JsonRecord | undefined;
    globalThis.fetch = (async (input, init) => {
      upstreamUrl = String(input);
      upstreamBody = JSON.parse(String(init?.body ?? "{}")) as JsonRecord;
      return Response.json(responsesCompletedJson());
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(v2Request(route.model)),
    }), configFor(route), { model: "", provider: "" });
    const text = await response.text();
    const payloads = ssePayloads(text);

    expect(upstreamUrl).toBe("https://api.deepseek.com/responses");
    expect(upstreamBody).toMatchObject({ stream: false });
    expect(upstreamBody).not.toHaveProperty("messages");
    const completed = completedResponse(payloads);
    expect(hasCompletedAssistantMessage(completed.output)).toBe(true);
    expect(completedAssistantOutputText(completed.output)).toBe("terminal answer");
    expect(text).toContain("data: [DONE]");
  });

  test("native OpenAI Responses preserves V2 request and terminal payloads without integer rewriting", async () => {
    const route = routeCases.find(candidate => candidate.provider === "openai")!;
    const requestBody = v2Request(route.model);
    const upstreamSse = nativeCompletedSse();
    let upstreamUrl = "";
    let upstreamBody: JsonRecord | undefined;
    globalThis.fetch = (async (input, init) => {
      upstreamUrl = String(input);
      upstreamBody = JSON.parse(String(init?.body ?? "{}")) as JsonRecord;
      return new Response(upstreamSse, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify(requestBody),
    }), configFor(route), { model: "", provider: "" });
    const text = await response.text();

    expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(upstreamBody).toEqual(requestBody);
    expect(text).toBe(upstreamSse);
    expect(text).toContain("120.0");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { handleResponses } from "../src/server/responses";
import {
  inspectResponseLogJson,
  inspectResponseLogSsePayload,
  type RequestLogContext,
} from "../src/server/request-log";
import type { AdapterEvent, OcxConfig } from "../src/types";
import {
  V2_PLAINTEXT_COLLABORATION_NAMESPACE,
  markV2PlaintextCollaborationJson,
  restoreV2PlaintextCollaborationJson,
  rewriteV2PlaintextCollaborationRequest,
} from "../src/responses/v2-plaintext-collaboration";

const originalFetch = globalThis.fetch;
const originalUsageDebug = process.env.OPENCODEX_USAGE_DEBUG;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUsageDebug === undefined) delete process.env.OPENCODEX_USAGE_DEBUG;
  else process.env.OPENCODEX_USAGE_DEBUG = originalUsageDebug;
});

function messageTool(name: string, encrypted = true): Record<string, unknown> {
  return {
    type: "function",
    name,
    description: `${name} description`,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message text", ...(encrypted ? { encrypted: true } : {}) },
      },
      required: ["message"],
    },
  };
}

function collaborationNamespace(): Record<string, unknown> {
  return {
    type: "namespace",
    name: "collaboration",
    description: "V2 collaboration",
    tools: [
      messageTool("followup_task"),
      { type: "function", name: "interrupt_agent", parameters: { type: "object", properties: {} } },
      { type: "function", name: "list_agents", parameters: { type: "object", properties: {} } },
      messageTool("send_message"),
      messageTool("spawn_agent"),
      { type: "function", name: "wait_agent", parameters: { type: "object", properties: {} } },
    ],
  };
}

function messageSchema(tool: unknown): Record<string, unknown> | undefined {
  const record = tool as { parameters?: { properties?: { message?: Record<string, unknown> } } };
  return record.parameters?.properties?.message;
}

describe("native V2 plaintext collaboration request rewrite", () => {
  test("aliases a complete Responses-Lite namespace, replay, and tool choice atomically", () => {
    const namespace = collaborationNamespace();
    const body = {
      model: "gpt-5.6-sol",
      input: [
        { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec" }, namespace] },
        {
          type: "function_call",
          namespace: "collaboration",
          name: "wait_agent",
          call_id: "call_1",
          arguments: "{\"message\":\"do not rewrite collaboration inside strings\"}",
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        tools: [
          { type: "function", namespace: "collaboration", name: "spawn_agent" },
          { type: "function", namespace: "mcp", name: "lookup" },
        ],
      },
    };
    const before = JSON.stringify(body);

    const rewritten = rewriteV2PlaintextCollaborationRequest(body);
    expect(rewritten).toMatchObject({ activated: true, reason: "activated" });
    expect(JSON.stringify(body)).toBe(before);

    const output = rewritten.body as typeof body;
    const aliased = output.input[0]!.tools![1] as ReturnType<typeof collaborationNamespace>;
    expect(aliased.name).toBe(V2_PLAINTEXT_COLLABORATION_NAMESPACE);
    const tools = aliased.tools as Record<string, unknown>[];
    for (const name of ["spawn_agent", "send_message", "followup_task"]) {
      expect(messageSchema(tools.find(tool => tool.name === name))).not.toHaveProperty("encrypted");
    }
    expect(tools.find(tool => tool.name === "wait_agent")).toEqual(
      (namespace.tools as Record<string, unknown>[]).find(tool => tool.name === "wait_agent"),
    );
    expect(output.input[1]).toMatchObject({
      namespace: V2_PLAINTEXT_COLLABORATION_NAMESPACE,
      call_id: "call_1",
    });
    expect(output.input[1]!.arguments).toContain("collaboration inside strings");
    expect(output.tool_choice.tools[0]).toMatchObject({ namespace: V2_PLAINTEXT_COLLABORATION_NAMESPACE });
    expect(output.tool_choice.tools[1]).toMatchObject({ namespace: "mcp" });
  });

  test("supports top-level and deferred tool declaration containers", () => {
    const body = {
      tools: [collaborationNamespace()],
      input: [{ type: "tool_search_output", tools: [collaborationNamespace()] }],
    };
    const rewritten = rewriteV2PlaintextCollaborationRequest(body);
    expect(rewritten.activated).toBe(true);
    const output = rewritten.body as typeof body;
    expect(output.tools[0]).toMatchObject({ name: V2_PLAINTEXT_COLLABORATION_NAMESPACE });
    expect(output.input[0]!.tools[0]).toMatchObject({ name: V2_PLAINTEXT_COLLABORATION_NAMESPACE });
  });

  test("fails closed on a partial schema or alias collision", () => {
    const partial = collaborationNamespace();
    partial.tools = (partial.tools as Record<string, unknown>[]).filter(tool => tool.name !== "followup_task");
    const partialBody = { input: [{ type: "additional_tools", tools: [partial] }] };
    const partialResult = rewriteV2PlaintextCollaborationRequest(partialBody);
    expect(partialResult).toEqual({ body: partialBody, activated: false, reason: "schema_mismatch" });

    const collisionBody = {
      tools: [
        collaborationNamespace(),
        { type: "namespace", name: V2_PLAINTEXT_COLLABORATION_NAMESPACE, tools: [] },
      ],
    };
    const collisionResult = rewriteV2PlaintextCollaborationRequest(collisionBody);
    expect(collisionResult).toEqual({ body: collisionBody, activated: false, reason: "alias_collision" });
  });

  test("fails closed when one message field is already plaintext", () => {
    const namespace = collaborationNamespace();
    const tools = namespace.tools as Record<string, unknown>[];
    tools[tools.findIndex(tool => tool.name === "send_message")] = messageTool("send_message", false);
    const body = { tools: [namespace] };
    const result = rewriteV2PlaintextCollaborationRequest(body);
    expect(result).toEqual({ body, activated: false, reason: "schema_mismatch" });
  });
});

describe("native V2 plaintext collaboration response restore", () => {
  test("restores every lifecycle namespace and marks only plaintext message calls", () => {
    const payload = JSON.stringify({
      type: "response.completed",
      response: {
        output: [
          {
            type: "function_call",
            namespace: V2_PLAINTEXT_COLLABORATION_NAMESPACE,
            name: "spawn_agent",
            arguments: "{\"message\":\"keep alias text ocx_collaboration_plaintext\"}",
          },
          {
            type: "function_call",
            namespace: V2_PLAINTEXT_COLLABORATION_NAMESPACE,
            name: "wait_agent",
            arguments: "{}",
          },
          {
            type: "namespace",
            name: V2_PLAINTEXT_COLLABORATION_NAMESPACE,
            tools: [],
          },
        ],
      },
    });
    const restored = JSON.parse(restoreV2PlaintextCollaborationJson(payload)) as {
      response: { output: Record<string, unknown>[] };
    };

    expect(restored.response.output[0]).toMatchObject({
      namespace: "collaboration",
      name: "spawn_agent",
      encrypted_function_args: [],
    });
    expect(restored.response.output[0]!.arguments).toContain("ocx_collaboration_plaintext");
    expect(restored.response.output[1]).toMatchObject({ namespace: "collaboration", name: "wait_agent" });
    expect(restored.response.output[1]).not.toHaveProperty("encrypted_function_args");
    expect(restored.response.output[2]).toMatchObject({ type: "namespace", name: "collaboration" });
  });

  test("does not replace unexpected ciphertext markers or malformed JSON", () => {
    const payload = JSON.stringify({
      type: "function_call",
      namespace: V2_PLAINTEXT_COLLABORATION_NAMESPACE,
      name: "send_message",
      arguments: "{}",
      encrypted_function_args: ["message"],
    });
    const restored = JSON.parse(restoreV2PlaintextCollaborationJson(payload)) as Record<string, unknown>;
    expect(restored).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: ["message"],
    });
    expect(restoreV2PlaintextCollaborationJson(restoreV2PlaintextCollaborationJson(payload)))
      .toBe(restoreV2PlaintextCollaborationJson(payload));
    expect(restoreV2PlaintextCollaborationJson("not json")).toBe("not json");
  });

  test("marks canonical calls from routed Responses-native providers without touching lifecycle tools", () => {
    const payload = JSON.stringify({
      output: [
        { type: "function_call", namespace: "collaboration", name: "send_message", arguments: "{}" },
        { type: "function_call", namespace: "collaboration", name: "wait_agent", arguments: "{}" },
        {
          type: "function_call",
          namespace: "collaboration",
          name: "followup_task",
          arguments: "{}",
          encrypted_function_args: ["message"],
        },
      ],
    });
    const marked = JSON.parse(markV2PlaintextCollaborationJson(payload)) as {
      output: Record<string, unknown>[];
    };
    expect(marked.output[0]).toMatchObject({ encrypted_function_args: [] });
    expect(marked.output[1]).not.toHaveProperty("encrypted_function_args");
    expect(marked.output[2]).toMatchObject({ encrypted_function_args: ["message"] });
  });
});

function nativeConfig(delivery: "encrypted" | "plaintext"): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    multiAgentV2MessageDelivery: delivery,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

function routedResponsesConfig(delivery: "encrypted" | "plaintext"): OcxConfig {
  return {
    port: 0,
    defaultProvider: "responses-native",
    multiAgentV2MessageDelivery: delivery,
    providers: {
      "responses-native": {
        adapter: "openai-responses",
        baseUrl: "https://api.deepseek.com",
        authMode: "key",
        apiKey: "test-key",
      },
    },
  } as OcxConfig;
}

function nativeV2Body(stream = true): Record<string, unknown> {
  return {
    model: "gpt-5.6-sol",
    stream,
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "custom", name: "exec" }, collaborationNamespace()],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "delegate" }] },
    ],
  };
}

function routedV2Body(stream = true): Record<string, unknown> {
  return { ...nativeV2Body(stream), model: "responses-native/v4" };
}

function completedSse(namespace: string): string {
  const item = {
    type: "function_call",
    id: "fc_probe",
    call_id: "call_probe",
    namespace,
    name: "spawn_agent",
    arguments: "{\"message\":\"V2_PLAINTEXT_OK\",\"task_name\":\"probe\"}",
    status: "completed",
  };
  const response = {
    id: "resp_probe",
    object: "response",
    status: "completed",
    model: "gpt-5.6-sol",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  return [
    `data: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}`,
    "",
    `data: ${JSON.stringify({ type: "response.completed", response })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function completedJson(namespace: string): Record<string, unknown> {
  return {
    id: "resp_probe_json",
    object: "response",
    status: "completed",
    model: "gpt-5.6-sol",
    output: [{
      type: "function_call",
      id: "fc_probe_json",
      call_id: "call_probe_json",
      namespace,
      name: "followup_task",
      arguments: "{\"target\":\"worker\",\"message\":\"JSON_OK\"}",
      status: "completed",
    }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

function bridgeNamespaceMap(): Map<string, { namespace: string; name: string }> {
  return new Map([
    ["flat_spawn", { namespace: "collaboration", name: "spawn_agent" }],
    ["flat_wait", { namespace: "collaboration", name: "wait_agent" }],
  ]);
}

describe("routed V2 plaintext collaboration bridge", () => {
  test("marks only message-bearing collaboration calls in streaming and batch output", async () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_spawn", name: "flat_spawn" },
      { type: "tool_call_delta", arguments: "{\"message\":\"build\"}" },
      { type: "tool_call_end", id: "call_spawn" },
      { type: "tool_call_start", id: "call_wait", name: "flat_wait" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end", id: "call_wait" },
      { type: "done" },
    ];
    const streamText = await new Response(bridgeToResponsesSSE(
      replay(events),
      "kimi/k3[1m]",
      bridgeNamespaceMap(),
      undefined,
      undefined,
      undefined,
      undefined,
      { plaintextV2Collaboration: true },
    )).text();
    const payloads = streamText.split(/\r?\n/)
      .filter(line => line.startsWith("data: {") )
      .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const streamItems = payloads.flatMap(payload => {
      const item = (payload as { item?: Record<string, unknown> }).item;
      const output = (payload as { response?: { output?: Record<string, unknown>[] } }).response?.output;
      return [...(item ? [item] : []), ...(output ?? [])];
    }).filter(item => item.type === "function_call" && item.status === "completed");
    expect(streamItems.filter(item => item.name === "spawn_agent").length).toBeGreaterThanOrEqual(2);
    for (const item of streamItems.filter(item => item.name === "spawn_agent")) {
      expect(item.encrypted_function_args).toEqual([]);
    }
    for (const item of streamItems.filter(item => item.name === "wait_agent")) {
      expect(item).not.toHaveProperty("encrypted_function_args");
    }

    const batch = buildResponseJSON(events, "kimi/k3[1m]", {
      toolNsMap: bridgeNamespaceMap(),
      plaintextV2Collaboration: true,
    });
    const batchItems = batch.output as Record<string, unknown>[];
    expect(batchItems.find(item => item.name === "spawn_agent")).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
    });
    expect(batchItems.find(item => item.name === "wait_agent")).not.toHaveProperty("encrypted_function_args");
  });

  test("does not mark routed calls when plaintext delivery is disabled", () => {
    const json = buildResponseJSON([
      { type: "tool_call_start", id: "call_spawn", name: "flat_spawn" },
      { type: "tool_call_delta", arguments: "{\"message\":\"build\"}" },
      { type: "tool_call_end", id: "call_spawn" },
      { type: "done" },
    ], "kimi/k3[1m]", { toolNsMap: bridgeNamespaceMap() });
    expect((json.output as Record<string, unknown>[])[0]).not.toHaveProperty("encrypted_function_args");
  });
});

describe("plaintext V2 usage-debug privacy", () => {
  test("keeps metadata inspection but suppresses persisted JSON and SSE body samples", () => {
    process.env.OPENCODEX_USAGE_DEBUG = "1";
    const logCtx: RequestLogContext = {
      model: "kimi/k3[1m]",
      provider: "kimi",
      suppressUsageDebugBodySample: true,
    };
    inspectResponseLogJson(logCtx, JSON.stringify({
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      output: [{ arguments: "{\"message\":\"private task\"}" }],
    }));
    inspectResponseLogSsePayload(logCtx, JSON.stringify({
      type: "response.completed",
      response: { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
    }));
    expect(logCtx.usage).toMatchObject({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    expect(logCtx.usageDebugBodyKind).toBeUndefined();
    expect(logCtx.usageDebugBodySample).toBeUndefined();
  });
});

describe("native V2 plaintext collaboration handleResponses integration", () => {
  test("aliases the ChatGPT request and restores every streamed client item", async () => {
    let upstreamBody = "";
    globalThis.fetch = (async (_input, init) => {
      upstreamBody = typeof init?.body === "string" ? init.body : "";
      return new Response(completedSse(V2_PLAINTEXT_COLLABORATION_NAMESPACE), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify(nativeV2Body()),
    }), nativeConfig("plaintext"), logCtx);
    const upstream = JSON.parse(upstreamBody) as { input: Array<{ type: string; tools?: Record<string, unknown>[] }> };
    const declaration = upstream.input[0]!.tools![1] as { name: string; tools: Record<string, unknown>[] };
    expect(declaration.name).toBe(V2_PLAINTEXT_COLLABORATION_NAMESPACE);
    expect(messageSchema(declaration.tools.find(tool => tool.name === "spawn_agent"))).not.toHaveProperty("encrypted");
    expect(logCtx.suppressUsageDebugBodySample).toBe(true);

    const payloads = (await response.text())
      .split(/\r?\n/)
      .filter(line => line.startsWith("data: {") )
      .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const items = payloads.flatMap(payload => {
      const direct = (payload as { item?: Record<string, unknown> }).item;
      const output = (payload as { response?: { output?: Record<string, unknown>[] } }).response?.output;
      return [...(direct ? [direct] : []), ...(output ?? [])];
    }).filter(item => item.type === "function_call");
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(item).toMatchObject({
        namespace: "collaboration",
        name: "spawn_agent",
        encrypted_function_args: [],
      });
    }
  });

  test("restores the bounded JSON response after aliasing the native request", async () => {
    let upstreamBody = "";
    globalThis.fetch = (async (_input, init) => {
      upstreamBody = typeof init?.body === "string" ? init.body : "";
      return Response.json(completedJson(V2_PLAINTEXT_COLLABORATION_NAMESPACE));
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify(nativeV2Body(false)),
    }), nativeConfig("plaintext"), logCtx);
    expect(response.status).toBe(200);
    const upstream = JSON.parse(upstreamBody) as { input: Array<{ tools?: Record<string, unknown>[] }> };
    expect(upstream.input[0]!.tools![1]).toMatchObject({
      type: "namespace",
      name: V2_PLAINTEXT_COLLABORATION_NAMESPACE,
    });
    const client = await response.json() as { output: Record<string, unknown>[] };
    expect(client.output[0]).toMatchObject({
      namespace: "collaboration",
      name: "followup_task",
      encrypted_function_args: [],
    });
  });

  test("keeps the native encrypted request byte-semantics when plaintext mode is off", async () => {
    let upstreamBody = "";
    globalThis.fetch = (async (_input, init) => {
      upstreamBody = typeof init?.body === "string" ? init.body : "";
      return new Response(completedSse("collaboration"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify(nativeV2Body()),
    }), nativeConfig("encrypted"), logCtx);
    await response.text();

    const upstream = JSON.parse(upstreamBody) as { input: Array<{ tools?: Record<string, unknown>[] }> };
    const declaration = upstream.input[0]!.tools![1] as { name: string; tools: Record<string, unknown>[] };
    expect(declaration.name).toBe("collaboration");
    expect(messageSchema(declaration.tools.find(tool => tool.name === "spawn_agent"))).toMatchObject({ encrypted: true });
    expect(logCtx.suppressUsageDebugBodySample).toBeUndefined();
  });
});

describe("routed Responses-native V2 plaintext integration", () => {
  test("adds the plaintext sentinel without aliasing the external provider namespace", async () => {
    let upstreamBody = "";
    globalThis.fetch = (async (_input, init) => {
      upstreamBody = typeof init?.body === "string" ? init.body : "";
      return new Response(completedSse("collaboration"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(routedV2Body()),
    }), routedResponsesConfig("plaintext"), logCtx);

    expect(response.status).toBe(200);
    expect(upstreamBody).toContain('"name":"collaboration"');
    expect(upstreamBody).not.toContain(V2_PLAINTEXT_COLLABORATION_NAMESPACE);
    const payloads = (await response.text())
      .split(/\r?\n/)
      .filter(line => line.startsWith("data: {") )
      .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const items = payloads.flatMap(payload => {
      const direct = (payload as { item?: Record<string, unknown> }).item;
      const output = (payload as { response?: { output?: Record<string, unknown>[] } }).response?.output;
      return [...(direct ? [direct] : []), ...(output ?? [])];
    }).filter(item => item.type === "function_call");
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(item).toMatchObject({
        namespace: "collaboration",
        name: "spawn_agent",
        encrypted_function_args: [],
      });
    }
    expect(logCtx.suppressUsageDebugBodySample).toBe(true);
  });

  test("preserves non-JSON upstream error status while failing closed on an unknown success body", async () => {
    for (const [upstreamStatus, expectedStatus] of [[429, 429], [200, 502]] as const) {
      globalThis.fetch = (async () => new Response("upstream text body", {
        status: upstreamStatus,
        headers: { "content-type": "text/plain", "retry-after": "7" },
      })) as typeof fetch;
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(routedV2Body()),
      }), routedResponsesConfig("plaintext"), { model: "", provider: "" });
      expect(response.status).toBe(expectedStatus);
      const text = await response.text();
      if (upstreamStatus === 429) {
        expect(text).toBe("upstream text body");
        expect(response.headers.get("retry-after")).toBe("7");
      } else {
        expect(text).toContain("unsupported response content type");
      }
    }
  });
});

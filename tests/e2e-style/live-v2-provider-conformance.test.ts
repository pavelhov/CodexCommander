import { expect, test } from "bun:test";

const liveEnabled = process.env.CCX_LIVE_V2_CONFORMANCE === "1";
const liveTest = liveEnabled ? test : test.skip;

const PROXY_BASE_URL = "http://127.0.0.1:10100";
const DISCOVERY_DEADLINE_MS = 10_000;
const TARGET_DEADLINE_MS = 120_000;

type JsonRecord = Record<string, unknown>;

interface RouteTarget {
  route: string;
  model: string;
}

interface SanitizedEvidence {
  route: string;
  status: number | "deadline" | "error";
  elapsedMs: number;
  toolTerminal: boolean;
  responseTerminal: boolean;
}

const routeTargets: readonly RouteTarget[] = [
  { route: "xAI/Grok translated Chat", model: "xai/grok-4.5" },
  { route: "Kimi translated Chat", model: "kimi-code/kimi-k2.7-code" },
  { route: "DeepSeek V4 bounded Responses", model: "deepseek/deepseek-v4-flash" },
  { route: "native OpenAI Responses", model: "gpt-5.6-sol" },
];

function messageTool(name: string): JsonRecord {
  return {
    type: "function",
    name,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", encrypted: true },
      },
      required: ["message"],
    },
  };
}

function collaborationNamespace(): JsonRecord {
  return {
    type: "namespace",
    name: "collaboration",
    tools: [
      messageTool("spawn_agent"),
      messageTool("followup_task"),
      { type: "function", name: "interrupt_agent", parameters: { type: "object", properties: {} } },
      { type: "function", name: "list_agents", parameters: { type: "object", properties: {} } },
      messageTool("send_message"),
      {
        type: "function",
        name: "wait_agent",
        parameters: {
          type: "object",
          properties: { timeout_ms: { type: "number" } },
          required: ["timeout_ms"],
        },
      },
    ],
  };
}

function initialRequest(model: string): JsonRecord {
  return {
    model,
    stream: true,
    max_output_tokens: 512,
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [collaborationNamespace()],
      },
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "Call collaboration.wait_agent once with timeout_ms 10000, then wait for its result before giving a final answer.",
        }],
      },
    ],
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", namespace: "collaboration", name: "wait_agent" }],
    },
  };
}

function continuationRequest(model: string, responseId: string, callId: string): JsonRecord {
  return {
    model,
    stream: true,
    max_output_tokens: 512,
    previous_response_id: responseId,
    input: [{
      type: "function_call_output",
      call_id: callId,
      output: "{\"status\":\"timeout\"}",
    }],
    tool_choice: "none",
  };
}

function ssePayloads(text: string): JsonRecord[] {
  const payloads: JsonRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payloads.push(parsed as JsonRecord);
      }
    } catch {
      // The probe classifies malformed/non-JSON frames structurally and never logs frame data.
    }
  }
  return payloads;
}

function completedResponse(payloads: readonly JsonRecord[]): JsonRecord | undefined {
  const terminal = payloads.findLast(payload => payload.type === "response.completed");
  const response = terminal?.response;
  return response && typeof response === "object" && !Array.isArray(response)
    ? response as JsonRecord
    : undefined;
}

function completedItems(payloads: readonly JsonRecord[]): JsonRecord[] {
  const items: JsonRecord[] = [];
  for (const payload of payloads) {
    if (payload.type === "response.output_item.done") {
      const item = payload.item;
      if (item && typeof item === "object" && !Array.isArray(item)) items.push(item as JsonRecord);
    }
  }
  const snapshotOutput = completedResponse(payloads)?.output;
  if (Array.isArray(snapshotOutput)) {
    for (const item of snapshotOutput) {
      if (item && typeof item === "object" && !Array.isArray(item)) items.push(item as JsonRecord);
    }
  }
  return items;
}

function completedWaitCall(payloads: readonly JsonRecord[]): JsonRecord | undefined {
  return completedItems(payloads).find(item => item.type === "function_call"
    && item.namespace === "collaboration"
    && item.name === "wait_agent"
    && item.status === "completed"
    && typeof item.call_id === "string");
}

function hasTerminalAnswer(payloads: readonly JsonRecord[]): boolean {
  const response = completedResponse(payloads);
  if (response?.status !== "completed" || !Array.isArray(response.output)) return false;
  return response.output.some(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const message = item as JsonRecord;
    return message.type === "message"
      && message.role === "assistant"
      && message.status === "completed"
      && Array.isArray(message.content)
      && message.content.some(part => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return false;
        return (part as JsonRecord).type === "output_text"
          && typeof (part as JsonRecord).text === "string";
      });
  });
}

async function postResponses(body: JsonRecord, signal: AbortSignal): Promise<{ status: number; payloads: JsonRecord[] }> {
  const response = await fetch(`${PROXY_BASE_URL}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status, payloads: [] };
  }
  return { status: response.status, payloads: ssePayloads(await response.text()) };
}

async function configuredTargets(): Promise<RouteTarget[]> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), DISCOVERY_DEADLINE_MS);
  try {
    const response = await fetch(`${PROXY_BASE_URL}/v1/models`, { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("live V2 model discovery was not successful");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("live V2 model discovery returned an invalid catalog");
    }
    const data = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as JsonRecord).data
      : undefined;
    if (!Array.isArray(data)) throw new Error("live V2 model discovery returned an invalid catalog");
    const available = new Set(data.flatMap(row => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const id = (row as JsonRecord).id;
      return typeof id === "string" ? [id] : [];
    }));
    return routeTargets.filter(target => available.has(target.model));
  } finally {
    clearTimeout(deadline);
  }
}

async function probeTarget(target: RouteTarget): Promise<SanitizedEvidence> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), TARGET_DEADLINE_MS);
  let status: SanitizedEvidence["status"] = "error";
  let toolTerminal = false;
  let responseTerminal = false;

  try {
    const first = await postResponses(initialRequest(target.model), controller.signal);
    status = first.status;
    const waitCall = completedWaitCall(first.payloads);
    toolTerminal = waitCall !== undefined;
    const responseId = completedResponse(first.payloads)?.id;
    const callId = waitCall?.call_id;
    if (typeof responseId === "string" && typeof callId === "string") {
      const final = await postResponses(
        continuationRequest(target.model, responseId, callId),
        controller.signal,
      );
      status = final.status;
      responseTerminal = hasTerminalAnswer(final.payloads);
    }
  } catch {
    status = controller.signal.aborted ? "deadline" : "error";
  } finally {
    clearTimeout(deadline);
  }

  return {
    route: target.route,
    status,
    elapsedMs: Math.round(performance.now() - startedAt),
    toolTerminal,
    responseTerminal,
  };
}

liveTest("configured V2 provider routes complete one collaboration wait and final answer", async () => {
  const targets = await configuredTargets();
  expect(targets.length).toBeGreaterThan(0);

  const evidence = await Promise.all(targets.map(probeTarget));
  for (const item of evidence) {
    console.log(JSON.stringify(item));
    expect(item.status).toBe(200);
    expect(item.toolTerminal).toBe(true);
    expect(item.responseTerminal).toBe(true);
  }
}, DISCOVERY_DEADLINE_MS + TARGET_DEADLINE_MS + 5_000);

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
  status: number | "deadline" | "discovery_error" | "error" | "missing";
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

function objectParameters(properties: JsonRecord, required?: string[]): JsonRecord {
  return {
    type: "object",
    properties,
    ...(required ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * Construct the current Codex-owned MultiAgentV2 declarations only in the enabled request
 * path. The contract source is codex-rs/core/src/tools/handlers/multi_agents_spec.rs; CCX has
 * no canonical schema export of its own. In particular, the reserved native namespace needs
 * exact required fields, encrypted message fields, and closed parameter objects.
 */
function currentCollaborationNamespace(): JsonRecord {
  const encryptedMessage = (description: string): JsonRecord => ({
    type: "string",
    description,
    encrypted: true,
  });
  return {
    type: "namespace",
    name: "collaboration",
    description: "Tools for spawning and managing sub-agents.",
    tools: [
      {
        type: "function",
        name: "followup_task",
        description: "Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle.",
        strict: false,
        parameters: objectParameters({
          target: { type: "string", description: "Agent id or canonical task name to send a follow-up task to (from spawn_agent)." },
          message: encryptedMessage("Message text to send to the target agent."),
        }, ["target", "message"]),
      },
      {
        type: "function",
        name: "interrupt_agent",
        description: "Interrupt an agent's current turn, if any, and return its previous status.",
        strict: false,
        parameters: objectParameters({
          target: { type: "string", description: "Agent id or canonical task name to interrupt (from spawn_agent)." },
        }, ["target"]),
      },
      {
        type: "function",
        name: "list_agents",
        description: "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
        strict: false,
        parameters: objectParameters({
          path_prefix: { type: "string", description: "Task-path prefix filter without a trailing slash. Omit to list all live agents." },
        }),
      },
      {
        type: "function",
        name: "send_message",
        description: "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
        strict: false,
        parameters: objectParameters({
          target: { type: "string", description: "Relative or canonical task name to message (from spawn_agent)." },
          message: encryptedMessage("Message text to queue on the target agent."),
        }, ["target", "message"]),
      },
      {
        type: "function",
        name: "spawn_agent",
        description: "Spawns an agent to work on the specified task.",
        strict: false,
        parameters: objectParameters({
          task_name: { type: "string", description: "Task name for the new agent. Use lowercase letters, digits, and underscores." },
          message: encryptedMessage("Initial plain-text task for the new agent."),
          fork_turns: { type: "string", description: "Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string." },
          agent_type: { type: "string", description: "Agent type override for the new agent. Omit unless explicitly asked." },
          model: { type: "string", description: "Model override for the new agent. Omit unless an explicit override is needed." },
          reasoning_effort: { type: "string", description: "Reasoning effort override for the new agent. Omit to inherit the parent effort." },
        }, ["task_name", "message"]),
      },
      {
        type: "function",
        name: "wait_agent",
        description: "Wait for a mailbox update from any live agent, including queued messages and final-status notifications.",
        strict: false,
        parameters: objectParameters({
          timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000." },
        }),
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
        tools: [currentCollaborationNamespace()],
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
    await cancelBodyQuietly(response);
    return { status: response.status, payloads: [] };
  }
  return { status: response.status, payloads: ssePayloads(await response.text()) };
}

async function cancelBodyQuietly(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation errors carry transport detail and never escape the sanitizer boundary.
  }
}

function catalogModelIds(payload: unknown): Set<string> | null {
  const data = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as JsonRecord).data
    : undefined;
  if (!Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const id = (row as JsonRecord).id;
    if (typeof id !== "string") return null;
    ids.add(id);
  }
  return ids;
}

test("live V2 catalog parser accepts valid ids and an empty catalog", () => {
  expect(catalogModelIds({ data: [{ id: "xai/grok-4.5" }, { id: "gpt-5.6-sol" }] }))
    .toEqual(new Set(["xai/grok-4.5", "gpt-5.6-sol"]));
  expect(catalogModelIds({ data: [] })).toEqual(new Set());
});

test("live V2 catalog parser rejects every malformed row shape", () => {
  for (const data of [
    [null],
    [42],
    ["x"],
    [[{ id: "nested" }]],
    [{}],
    [{ id: 42 }],
  ]) {
    expect(catalogModelIds({ data })).toBeNull();
  }
});

async function availableModels(): Promise<Set<string> | null> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), DISCOVERY_DEADLINE_MS);
  try {
    const response = await fetch(`${PROXY_BASE_URL}/v1/models`, { signal: controller.signal });
    if (!response.ok) {
      await cancelBodyQuietly(response);
      return null;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    return catalogModelIds(payload);
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

function emptyEvidence(target: RouteTarget, status: "discovery_error" | "missing"): SanitizedEvidence {
  return {
    route: target.route,
    status,
    elapsedMs: 0,
    toolTerminal: false,
    responseTerminal: false,
  };
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
  const available = await availableModels();
  const evidence = available === null
    ? routeTargets.map(target => emptyEvidence(target, "discovery_error"))
    : await Promise.all(routeTargets.map(target => available.has(target.model)
      ? probeTarget(target)
      : Promise.resolve(emptyEvidence(target, "missing"))));
  for (const item of evidence) {
    console.log(JSON.stringify(item));
  }

  expect(evidence.length).toBe(4);
  for (const item of evidence) {
    expect(item.status).toBe(200);
    expect(item.toolTerminal).toBe(true);
    expect(item.responseTerminal).toBe(true);
  }
}, DISCOVERY_DEADLINE_MS + TARGET_DEADLINE_MS + 5_000);

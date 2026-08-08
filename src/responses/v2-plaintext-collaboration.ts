export const V2_PLAINTEXT_COLLABORATION_NAMESPACE = "ocx_collaboration_plaintext";

const CLIENT_COLLABORATION_NAMESPACE = "collaboration";
const PLAINTEXT_MESSAGE_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"]);

export function isV2PlaintextMessageCall(namespace: unknown, name: unknown): boolean {
  return namespace === CLIENT_COLLABORATION_NAMESPACE
    && typeof name === "string"
    && PLAINTEXT_MESSAGE_TOOLS.has(name);
}

/** Additive fields understood by stock Codex 0.147+ as an explicit plaintext V2 call. */
export function v2PlaintextFunctionCallFields(
  enabled: boolean,
  namespace: unknown,
  name: unknown,
): { encrypted_function_args: [] } | Record<string, never> {
  return enabled && isV2PlaintextMessageCall(namespace, name)
    ? { encrypted_function_args: [] }
    : {};
}

type JsonObject = Record<string, unknown>;

export interface V2PlaintextCollaborationRequestRewrite {
  body: unknown;
  activated: boolean;
  reason: "activated" | "missing_schema" | "schema_mismatch" | "alias_collision";
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestToolGroups(body: JsonObject): unknown[][] {
  const groups: unknown[][] = [];
  if (Array.isArray(body.tools)) groups.push(body.tools);
  if (!Array.isArray(body.input)) return groups;
  for (const item of body.input) {
    if (!isObject(item) || !Array.isArray(item.tools)) continue;
    if (item.type === "additional_tools" || item.type === "tool_search_output") {
      groups.push(item.tools);
    }
  }
  return groups;
}

function isAliasDeclaration(tool: unknown): boolean {
  return isObject(tool)
    && tool.type === "namespace"
    && tool.name === V2_PLAINTEXT_COLLABORATION_NAMESPACE;
}

function inspectCollaborationNamespace(tool: unknown): "absent" | "complete" | "invalid" {
  if (!isObject(tool) || tool.type !== "namespace" || tool.name !== CLIENT_COLLABORATION_NAMESPACE) {
    return "absent";
  }
  if (!Array.isArray(tool.tools) || tool.tools.length === 0) return "invalid";

  const seen = new Set<string>();
  for (const candidate of tool.tools) {
    if (!isObject(candidate) || candidate.type !== "function" || typeof candidate.name !== "string") {
      continue;
    }
    if (!PLAINTEXT_MESSAGE_TOOLS.has(candidate.name)) continue;
    if (seen.has(candidate.name)) return "invalid";
    seen.add(candidate.name);

    const message = isObject(candidate.parameters)
      && isObject(candidate.parameters.properties)
      ? candidate.parameters.properties.message
      : undefined;
    if (!isObject(message) || message.encrypted !== true) return "invalid";
  }
  return seen.size === PLAINTEXT_MESSAGE_TOOLS.size ? "complete" : "invalid";
}

function rewriteMessageTool(tool: unknown): unknown {
  if (
    !isObject(tool)
    || tool.type !== "function"
    || typeof tool.name !== "string"
    || !PLAINTEXT_MESSAGE_TOOLS.has(tool.name)
    || !isObject(tool.parameters)
    || !isObject(tool.parameters.properties)
    || !isObject(tool.parameters.properties.message)
  ) return tool;

  const { encrypted: _encrypted, ...message } = tool.parameters.properties.message;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        message,
      },
    },
  };
}

function rewriteToolGroup(tools: unknown[]): unknown[] {
  let changed = false;
  const rewritten = tools.map(tool => {
    if (!isObject(tool) || tool.type !== "namespace" || tool.name !== CLIENT_COLLABORATION_NAMESPACE) {
      return tool;
    }
    changed = true;
    return {
      ...tool,
      name: V2_PLAINTEXT_COLLABORATION_NAMESPACE,
      tools: (tool.tools as unknown[]).map(rewriteMessageTool),
    };
  });
  return changed ? rewritten : tools;
}

function rewriteNamespaceSelector(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map(entry => {
      const rewritten = rewriteNamespaceSelector(entry);
      changed ||= rewritten !== entry;
      return rewritten;
    });
    return changed ? entries : value;
  }
  if (!isObject(value)) return value;

  let changed = false;
  const rewritten: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = rewriteNamespaceSelector(entry);
    rewritten[key] = next;
    changed ||= next !== entry;
  }
  if (value.namespace === CLIENT_COLLABORATION_NAMESPACE) {
    rewritten.namespace = V2_PLAINTEXT_COLLABORATION_NAMESPACE;
    changed = true;
  }
  return changed ? rewritten : value;
}

/**
 * Replace Codex's reserved encrypted V2 namespace with an ordinary plaintext wire namespace.
 *
 * The ChatGPT backend validates the reserved `collaboration` schema byte-for-semantics and rejects
 * removing its encrypted message markers in place. The transform is therefore atomic: every visible
 * collaboration namespace must expose the complete known three-message schema, and no alias may
 * already exist. A partial/future schema stays untouched so the existing encrypted fail-closed path
 * remains authoritative.
 */
export function rewriteV2PlaintextCollaborationRequest(
  body: unknown,
): V2PlaintextCollaborationRequestRewrite {
  if (!isObject(body)) return { body, activated: false, reason: "missing_schema" };

  const groups = requestToolGroups(body);
  if (groups.some(group => group.some(isAliasDeclaration))) {
    return { body, activated: false, reason: "alias_collision" };
  }

  let declarations = 0;
  for (const group of groups) {
    for (const tool of group) {
      const state = inspectCollaborationNamespace(tool);
      if (state === "invalid") return { body, activated: false, reason: "schema_mismatch" };
      if (state === "complete") declarations += 1;
    }
  }
  if (declarations === 0) return { body, activated: false, reason: "missing_schema" };

  const tools = Array.isArray(body.tools) ? rewriteToolGroup(body.tools) : body.tools;
  let input = body.input;
  if (Array.isArray(body.input)) {
    let changed = false;
    const rewrittenInput = body.input.map(item => {
      if (!isObject(item)) return item;
      if (
        (item.type === "additional_tools" || item.type === "tool_search_output")
        && Array.isArray(item.tools)
      ) {
        const rewrittenTools = rewriteToolGroup(item.tools);
        if (rewrittenTools === item.tools) return item;
        changed = true;
        return { ...item, tools: rewrittenTools };
      }
      if (item.type === "function_call" && item.namespace === CLIENT_COLLABORATION_NAMESPACE) {
        changed = true;
        return { ...item, namespace: V2_PLAINTEXT_COLLABORATION_NAMESPACE };
      }
      return item;
    });
    if (changed) input = rewrittenInput;
  }

  const toolChoice = rewriteNamespaceSelector(body.tool_choice);
  return {
    body: {
      ...body,
      ...(Array.isArray(body.tools) ? { tools } : {}),
      ...(Array.isArray(body.input) ? { input } : {}),
      ...(Object.hasOwn(body, "tool_choice") ? { tool_choice: toolChoice } : {}),
    },
    activated: true,
    reason: "activated",
  };
}

function restoreResponseValue(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map(entry => {
      const restored = restoreResponseValue(entry);
      changed ||= restored.changed;
      return restored.value;
    });
    return changed ? { value: entries, changed: true } : { value, changed: false };
  }
  if (!isObject(value)) return { value, changed: false };

  let changed = false;
  const restored: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = restoreResponseValue(entry);
    restored[key] = result.value;
    changed ||= result.changed;
  }

  if (value.type === "namespace" && value.name === V2_PLAINTEXT_COLLABORATION_NAMESPACE) {
    restored.name = CLIENT_COLLABORATION_NAMESPACE;
    changed = true;
  }
  if (value.namespace === V2_PLAINTEXT_COLLABORATION_NAMESPACE) {
    restored.namespace = CLIENT_COLLABORATION_NAMESPACE;
    changed = true;
    if (
      value.type === "function_call"
      && isV2PlaintextMessageCall(CLIENT_COLLABORATION_NAMESPACE, value.name)
      && (value.encrypted_function_args === undefined
        || (Array.isArray(value.encrypted_function_args) && value.encrypted_function_args.length === 0))
    ) {
      restored.encrypted_function_args = [];
    }
  }
  return changed ? { value: restored, changed: true } : { value, changed: false };
}

function markCanonicalResponseValue(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map(entry => {
      const marked = markCanonicalResponseValue(entry);
      changed ||= marked.changed;
      return marked.value;
    });
    return changed ? { value: entries, changed: true } : { value, changed: false };
  }
  if (!isObject(value)) return { value, changed: false };

  let changed = false;
  const marked: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = markCanonicalResponseValue(entry);
    marked[key] = result.value;
    changed ||= result.changed;
  }
  if (
    value.type === "function_call"
    && isV2PlaintextMessageCall(value.namespace, value.name)
    && (value.encrypted_function_args === undefined
      || (Array.isArray(value.encrypted_function_args) && value.encrypted_function_args.length === 0))
  ) {
    marked.encrypted_function_args = [];
    changed = true;
  }
  return changed ? { value: marked, changed: true } : { value, changed: false };
}

/** Restore one non-streaming Responses document without rewriting argument-string contents. */
export function restoreV2PlaintextCollaborationJson(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const restored = restoreResponseValue(parsed);
  return restored.changed ? JSON.stringify(restored.value) : text;
}

/** Mark canonical collaboration calls returned by a routed Responses-native provider. */
export function markV2PlaintextCollaborationJson(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const marked = markCanonicalResponseValue(parsed);
  return marked.changed ? JSON.stringify(marked.value) : text;
}

/** Client-facing SSE payload rewrite; framing/chunk buffering is owned by sse-payload-rewrite.ts. */
export function createV2PlaintextCollaborationRestoreRewrite(
  active: boolean,
): ((payload: string) => string) | undefined {
  return active ? restoreV2PlaintextCollaborationJson : undefined;
}

export function createV2PlaintextCollaborationMarkerRewrite(
  active: boolean,
): ((payload: string) => string) | undefined {
  return active ? markV2PlaintextCollaborationJson : undefined;
}

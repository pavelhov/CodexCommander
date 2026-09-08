/** Fixed public synthetic inputs only. These are adapter probes, never native-client captures. */
export const syntheticBody = {
  model: "fixture-model", input: [
    { role: "user", content: [{ type: "input_text", text: "fixture prompt" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] },
    { type: "reasoning", id: "fixture-reasoning", encrypted_content: "fixture-encrypted-content" },
    { type: "function_call", call_id: "fixture-call", name: "fixture_tool", arguments: '{"fixture":true}' },
    { type: "function_call_output", call_id: "fixture-call", output: "fixture tool output" },
  ],
  tools: [{ type: "function", name: "fixture_tool", parameters: { type: "object", properties: { fixture: { type: "boolean" } } } }],
  metadata: { own_task: "fixture-own", parent_task: "fixture-parent", account_selector: "fixture-account-a" },
  unknown_extension: { keep: "fixture unknown field" },
  reasoning: { effort: "low" }, service_tier: "default", stream: true,
} as const;
export const fixtures = [
  { id: "success", fault: "success" }, { id: "continuation", fault: "success", continuation: true },
  { id: "second-account", fault: "success", secondAccount: true },
  { id: "unauthorized", fault: "401" }, { id: "rate-limit", fault: "429" },
  { id: "transient-retry", fault: "503" }, { id: "reset-retry", fault: "reset" },
  { id: "eof", fault: "eof" }, { id: "cancel-before-headers", fault: "cancel-before" },
  { id: "cancel-after-output", fault: "cancel-after" },
] as const;
export type Fixture = (typeof fixtures)[number];
export const successSSE = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"fixture-response","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n';

/** Complete synthetic event sequence accepted by native Responses consumers. */
const nativeMessage = { id: "fixture-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture output", annotations: [] }] };
export const nativeSuccessSSE = [
  { type: "response.created", response: { id: "fixture-response", status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { ...nativeMessage, status: "in_progress", content: [] } },
  { type: "response.content_part.added", item_id: "fixture-message", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
  { type: "response.output_text.delta", item_id: "fixture-message", output_index: 0, content_index: 0, delta: "fixture output" },
  { type: "response.output_text.done", item_id: "fixture-message", output_index: 0, content_index: 0, text: "fixture output" },
  { type: "response.content_part.done", item_id: "fixture-message", output_index: 0, content_index: 0, part: nativeMessage.content[0] },
  { type: "response.output_item.done", output_index: 0, item: nativeMessage },
  { type: "response.completed", response: { id: "fixture-response", status: "completed", output: [nativeMessage], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

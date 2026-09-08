import { createDispatchRequest, type DispatchAttempt, type DispatchMetadata } from "./dispatch";
import { observeDispatch, responseDispatch, type DispatchHttpContext } from "./dispatch-http";

/** Sidecars have their own logical work, with provenance only when the caller owns a parent.
 * Resolved provider/auth snapshots are not canonical identity objects, so no identity alias is guessed. */
export function sidecarDispatch(parent: DispatchAttempt | undefined, protocol: DispatchMetadata["protocol"], clientSignal?: AbortSignal, sidecarKind?: DispatchMetadata["sidecarKind"]): DispatchHttpContext {
  let attempt: DispatchAttempt | undefined;
  observeDispatch(() => {
    const request = parent ? parent.child() : createDispatchRequest();
    attempt = request.attempt({ surface: "sidecar", protocol, sidecarKind });
  });
  return { attempt, clientSignal };
}

/** Only materialized frames from the existing reader enter here; no payload is retained. */
export function observeSidecarFrame(response: Response, frame: Record<string, unknown>): void {
  observeDispatch(() => {
    const send = responseDispatch(response);
    if (!send) return;
    const type = frame.type;
    const value = frame.response && typeof frame.response === "object" ? frame.response as Record<string, unknown> : frame;
    const message = frame.message && typeof frame.message === "object" ? frame.message as Record<string, unknown> : value;
    const raw = message.usage ?? frame.usage;
    if (raw && typeof raw === "object") {
      const u = raw as Record<string, unknown>;
      send.usage({ provenance: "provider", completeness: "partial",
        ...(typeof u.input_tokens === "number" ? { inputTokens: u.input_tokens } : {}),
        ...(typeof u.output_tokens === "number" ? { outputTokens: u.output_tokens } : {}),
        ...(typeof u.cache_read_input_tokens === "number" ? { cacheReadInputTokens: u.cache_read_input_tokens } : {}),
        ...(typeof u.cache_creation_input_tokens === "number" ? { cacheCreationInputTokens: u.cache_creation_input_tokens } : {}),
      });
    }
    if (type === "response.output_text.delta" || type === "content_block_delta") send.output();
    if (type === "response.completed" || type === "message_stop") send.terminal("protocol_success");
    else if (type === "response.failed" || type === "response.incomplete" || type === "error" || value.status === "failed" || value.status === "incomplete") send.terminal("protocol_failure");
    else if (type === "response.done" && value.status === "completed") send.terminal("protocol_success");
  });
}

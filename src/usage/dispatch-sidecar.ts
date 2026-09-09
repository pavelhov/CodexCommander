import { createDispatchRequest, type DispatchAttempt, type DispatchMetadata, type DispatchUsage } from "./dispatch";
import { observeDispatch, responseDispatch, rawDispatchUsage, type DispatchHttpContext } from "./dispatch-http";

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

const responseUsage = new WeakMap<Response, { usage?: DispatchUsage; outputFinal: boolean }>();

/** Only materialized frames from the existing reader enter here; no payload is retained. */
export function observeSidecarFrame(response: Response, frame: Record<string, unknown>): void {
  observeDispatch(() => {
    const send = responseDispatch(response);
    if (!send) return;
    const type = frame.type;
    const value = frame.response && typeof frame.response === "object" ? frame.response as Record<string, unknown> : frame;
    const message = frame.message && typeof frame.message === "object" ? frame.message as Record<string, unknown> : value;
    const raw = message.usage ?? frame.usage;
    const protocol = typeof type === "string" && (type.startsWith("message_") || type.startsWith("content_block")) ? "messages" : "responses";
    const snapshot = responseUsage.get(response) ?? { outputFinal: false };
    const output = raw && typeof raw === "object" ? (raw as Record<string, unknown>).output_tokens : undefined;
    if (type === "message_delta" && typeof output === "number" && Number.isFinite(output)
      && output >= 0 && output <= Number.MAX_SAFE_INTEGER) snapshot.outputFinal = true;
    const final = protocol === "messages" ? snapshot.outputFinal
      : type === "response.completed" || (type === "response.done" && value.status === "completed");
    // Content-only frames must not consume the bounded usage-revision budget.
    if (raw || type === "message_stop") {
      const usage = rawDispatchUsage(raw ?? {}, protocol, final, snapshot.usage);
      if (usage) { snapshot.usage = usage; responseUsage.set(response, snapshot); send.usage(usage); }
    }
    if (type === "response.output_text.delta" || type === "content_block_delta") send.output();
    if (type === "response.completed" || type === "message_stop") send.terminal("protocol_success");
    else if (type === "response.failed" || type === "response.incomplete" || type === "error" || value.status === "failed" || value.status === "incomplete") send.terminal("protocol_failure");
    else if (type === "response.done" && value.status === "completed") send.terminal("protocol_success");
  });
}

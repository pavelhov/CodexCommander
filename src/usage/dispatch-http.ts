import type { AdapterEvent, CodexCommanderUsage } from "../types";
import { recordDispatchObserverFailure, type DispatchAttempt, type DispatchMetadata, type DispatchSend } from "./dispatch";

/** Process-local observer context. Never spread this into a RequestInit or wire payload. */
export interface DispatchHttpContext {
  attempt?: DispatchAttempt;
  reason?: DispatchMetadata["reason"];
  clientSignal?: AbortSignal;
}
const attemptSends = new WeakMap<DispatchAttempt, number>();
const sendCleanup = new WeakMap<DispatchSend, () => void>();
export function cleanupDispatchSend(send: DispatchSend | undefined): void { if (send) observeDispatch(() => sendCleanup.get(send)?.()); }
export function cleanupResponseDispatch(response: Response): void { cleanupDispatchSend(responseDispatch(response)); }
const responseSends = new WeakMap<Response, DispatchSend>();
const bodySends = new WeakMap<ReadableStream<Uint8Array>, DispatchSend>();
export function cleanupDispatchBody(body: ReadableStream<Uint8Array>): void { cleanupDispatchSend(bodySends.get(body)); }
export function responseDispatch(response: Response): DispatchSend | undefined { return responseSends.get(response); }
/** Optional observer implementations are untrusted to the inference path. */
export function observeDispatch(observe: () => void): void { try { observe(); } catch { recordDispatchObserverFailure(); } }

/** Invoke exactly one final fetch executor; do not read or wrap its response body. */
export async function dispatchHttpFetch(
  executor: typeof fetch,
  input: string | URL,
  init: RequestInit,
  context?: DispatchHttpContext,
): Promise<Response> {
  let send: DispatchSend | undefined;
  observeDispatch(() => { const attempt = context?.attempt;
    if (!attempt) return;
    const prior = attemptSends.get(attempt) ?? 0;
    attemptSends.set(attempt, prior + 1);
    send = attempt.start({ transport: "http", reason: context.reason ?? (prior ? "retry" : "initial") }); });
  if (send && typeof send !== "object" && typeof send !== "function") { recordDispatchObserverFailure(); send = undefined; }
  if (send) {
    const listeners: Array<() => void> = [];
    sendCleanup.set(send, () => { for (const remove of listeners.splice(0)) remove(); });
    const observeAbort = (signal: AbortSignal | null | undefined, who: "client" | "upstream") => {
      if (!signal) return;
      const record = () => observeDispatch(() => send!.cancel(who));
      if (signal.aborted) record(); else { signal.addEventListener("abort", record, { once: true }); listeners.push(() => signal.removeEventListener("abort", record)); }
    };
    observeDispatch(() => observeAbort(context?.clientSignal, "client"));
    observeDispatch(() => observeAbort(init.signal, "upstream"));
  }
  try {
    const response = await executor(input, init);
    if (send) {
      responseSends.set(response, send);
      if (response.body) bodySends.set(response.body, send);
      observeDispatch(() => send!.headers(response.status));
      // A non-success HTTP response is itself a protocol failure; 2xx headers prove no completion.
      if (!response.ok) observeDispatch(() => send!.terminal("protocol_failure"));
    }
    return response;
  } catch (error) {
    observeDispatch(() => send?.terminal(init.signal?.aborted ? "upstream_abort" : "transport_failure"));
    cleanupDispatchSend(send);
    throw error;
  }
}

export function observeDispatchUsage(send: DispatchSend | undefined, usage: CodexCommanderUsage | undefined): void {
  if (!usage) return;
  observeDispatch(() => send?.usage({
    provenance: usage.estimated ? "estimated" : "provider",
    completeness: "partial",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
  }));
}
const adapterTerminals = new WeakSet<Response>();
export function closeAdapterObservation(response: Response): void {
  adapterTerminals.add(response);
  observeDispatch(() => responseDispatch(response)?.terminal("unknown"));
  cleanupResponseDispatch(response);
}
export function observeAdapterEvent(response: Response, event: AdapterEvent): void {
  const send = responseDispatch(response);
  if (!send || adapterTerminals.has(response)) return;
  observeDispatch(() => {
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      adapterTerminals.add(response);
      observeDispatchUsage(send, event.usage);
      send.terminal(event.type === "done" ? "protocol_success" : "protocol_failure");
    } else if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_call_start" || event.type === "tool_call_delta") send.output();
  });
}
/** Observe the existing event iterator without adding a reader, prefetch, or recovery. */
export async function* observeAdapterStream(response: Response, events: AsyncIterable<AdapterEvent>): AsyncGenerator<AdapterEvent> {
  try {
    for await (const event of events) { observeAdapterEvent(response, event); yield event; }
    observeDispatch(() => responseDispatch(response)?.terminal("unknown"));
  } catch (error) {
    observeDispatch(() => responseDispatch(response)?.terminal("protocol_failure"));
    throw error;
  } finally { cleanupResponseDispatch(response); }
}

import { createDispatchRequest, recordDispatchObserverFailure, type DispatchRequest, type DispatchSend } from "./dispatch";
import { observeDispatch } from "./dispatch-http";

const pending = new WeakMap<object, Set<DispatchSend>>();
const MAX_PENDING = 64;
const MAX_FRAME_BYTES = 1024 * 1024;

/** Transparent sideband observer. Only explicit response.create invokes local inference.
 * Audio/VAD, session setup, tool replies, and control frames are not local model sends.
 * A server-generated response cannot safely be assigned to a pending create without a proven
 * correlation, so completion and usage remain unknown on this transparent relay. */
export function sendLiveInferenceFrame(owner: object, frame: string | Buffer, send: () => void, request?: DispatchRequest): void {
  let dispatch: DispatchSend | undefined;
  observeDispatch(() => {
    if ((typeof frame === "string" ? Buffer.byteLength(frame) : frame.length) > MAX_FRAME_BYTES) { recordDispatchObserverFailure(); return; }
    let value: unknown;
    try { value = JSON.parse(typeof frame === "string" ? frame : frame.toString("utf8")); } catch { recordDispatchObserverFailure(); return; }
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") { recordDispatchObserverFailure(); return; }
    if ((value as { type: string }).type !== "response.create") return;
    dispatch = (request ?? createDispatchRequest()).attempt({ surface: "realtime", protocol: "provider" }).start({ transport: "websocket", reason: "initial" });
    let sends = pending.get(owner);
    if (!sends) { sends = new Set(); pending.set(owner, sends); }
    if (sends.size >= MAX_PENDING) {
      const oldest = sends.values().next().value!;
      oldest.terminal("unknown"); sends.delete(oldest);
    }
    sends.add(dispatch);
  });
  try { send(); } catch (error) {
    observeDispatch(() => { dispatch?.terminal("transport_failure"); if (dispatch) pending.get(owner)?.delete(dispatch); });
    throw error;
  }
}

/** Called at the existing socket teardown, never adds cancellation or changes its timing. */
export function closeLiveInferenceObservation(owner: object, clientCancelled = false): void {
  observeDispatch(() => {
    const sends = pending.get(owner);
    if (!sends) return;
    for (const send of sends) {
      if (clientCancelled) send.cancel("client");
      send.terminal("unknown");
    }
    pending.delete(owner);
  });
}

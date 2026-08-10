import { appendDebugLogLine } from "./debug-log-buffer";
import { isDebugEnabled } from "./debug-settings";
import { redactSecrets } from "./redact";

function emitDebugLine(line: string): void {
  if (!isDebugEnabled()) return;
  try {
    appendDebugLogLine(line);
    console.error(line);
  } catch {
    /* diagnostics must never affect request handling */
  }
}

// Opt-in provider diagnostics. Streaming adapters stay quiet unless provider debug is on
// (`ccx debug provider on`, GUI Logs toggle, or CCX_DEBUG=1). Tail with `ccx debug provider logs -f`.

export function debugDroppedFrame(adapter: string, payload: string): void {
  if (!isDebugEnabled()) return;
  emitDebugLine(`[ccx:frame-drop] ${adapter}: dropped malformed upstream frame (payload redacted, bytes=${payload.length})`);
}

/** Provider-agnostic diagnostic logging: `[ccx:<adapter>:<event>] {...}`. */
export function debugProviderDiagnostic(adapter: string, event: string, details: Record<string, unknown>): void {
  if (!isDebugEnabled()) return;
  try {
    emitDebugLine(`[ccx:${adapter}:${event}] ${JSON.stringify(redactSecrets(details))}`);
  } catch {
    /* diagnostics must never affect request handling */
  }
}

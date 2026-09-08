import { join } from "node:path";
import { captureRequest, guardedFetch, type FixtureCapture, type WireCapture } from "./inference-recorder";
import { nativeSuccessSSE } from "../fixtures/inference-accounting/fixtures";
import type { DispatchEvent } from "../../src/usage/dispatch";

/** Full production Responses WebSocket ingress, disconnected and reconnected between generations.
 * Caller must provide an isolated child with disposable CODEXCOMMANDER_HOME/CODEX_HOME. */
export async function runWebSocketReconnectFixture(sourceRoot: string): Promise<FixtureCapture> {
  const originalFetch = globalThis.fetch; const OriginalWebSocket = globalThis.WebSocket;
  const origins = new Set<string>(); const websocketOrigins = new Set<string>();
  const wire: WireCapture[] = []; let rejected = false; let completed = 0;
  globalThis.fetch = guardedFetch(origins, originalFetch);
  globalThis.WebSocket = class extends OriginalWebSocket {
    constructor(input: string | URL, protocols?: string | string[]) {
      const url = new URL(input);
      if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !websocketOrigins.has(url.origin) || url.username || url.password) throw new Error("offline WebSocket destination rejected");
      super(url, protocols);
    }
  } as typeof WebSocket;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try { wire.push(await captureRequest(request)); } catch { rejected = true; return new Response(null, { status: 400 }); }
    return new Response(nativeSuccessSSE, { headers: { "content-type": "text/event-stream" } });
  } });
  origins.add(`http://127.0.0.1:${upstream.port}`);
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const config = await import(join(sourceRoot, "src/config.ts"));
    const runtime = await import(join(sourceRoot, "src/server/index.ts"));
    config.saveConfig({ port: 0, hostname: "127.0.0.1", websockets: true, multiAgentGuidanceEnabled: false, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-responses", baseUrl: `http://127.0.0.1:${upstream.port}`, authMode: "key", allowPrivateNetwork: true } } });
    server = runtime.startServer(0, { managementAuthState: { available: false, reason: "offline fixture" } });
    const websocketOrigin = `ws://127.0.0.1:${server!.port}`; websocketOrigins.add(websocketOrigin);
    for (let generation = 0; generation < 2; generation++) {
      const ws = new WebSocket(`${websocketOrigin}/v1/responses`);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("offline websocket generation timed out")), 3000);
          ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "response.create", model: "fixture/fixture-model", input: "fixture prompt" })), { once: true });
          ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("offline websocket error")); }, { once: true });
          ws.addEventListener("message", event => {
            try {
              if (typeof event.data !== "string" || event.data.length > 65536) throw new Error("offline websocket frame rejected");
              const message = JSON.parse(event.data);
              if (message.type === "response.completed") { clearTimeout(timer); completed++; resolve(); }
              else if (message.type === "error" || message.type === "response.failed") { clearTimeout(timer); reject(new Error("offline websocket generation failed")); }
            } catch { clearTimeout(timer); reject(new Error("offline websocket frame rejected")); }
          });
        });
      } finally {
        await new Promise<void>(resolve => { if (ws.readyState === WebSocket.CLOSED) return resolve(); const timer = setTimeout(resolve, 1000); ws.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true }); ws.close(); });
      }
    }
    if (rejected || wire.length !== 2 || completed !== 2) throw new Error("websocket reconnect count mismatch");
    const available = await Bun.file(join(sourceRoot, "src/usage/dispatch.ts")).exists();
    let events: DispatchEvent[] = []; let summary: unknown = null;
    if (available) {
      const accounting = await import(join(sourceRoot, "src/usage/dispatch.ts"));
      const path = join(config.getConfigDir(), "dispatch.jsonl"); const file = Bun.file(path);
      if (file.size > 65536) throw new Error("offline websocket journal too large");
      events = (await file.text()).trim().split("\n").map(line => { const event = accounting.normalizeDispatchEvent(JSON.parse(line)); if (!event) throw new Error("offline websocket journal rejected"); return event; });
      if (events.filter(event => event.kind === "request").length !== 2 || events.filter(event => event.kind === "start").length !== 2) throw new Error("websocket ingress accounting duplicated");
      summary = accounting.foldDispatchEvents(events);
    }
    return { id: "responses-websocket-reconnect", wire, sends: wire.length, clientAttempts: 2, outcome: "two_completed_generations", response: "", faultInjection: "close_reopen_between_generations", telemetry: { available, events, summary } };
  } finally { await server?.stop(true); upstream.stop(true); globalThis.fetch = originalFetch; globalThis.WebSocket = OriginalWebSocket; }
}

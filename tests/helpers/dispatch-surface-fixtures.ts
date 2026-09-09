import { join } from "node:path";
import type { DispatchEvent } from "../../src/usage/dispatch";
import type { CodexCommanderProviderConfig } from "../../src/types";

/** Executes production vision admission and adapter consumption, with only fixed loopback traffic.
 * Intended for an isolated fixture child: the guard also covers dynamic source imports.
 * No credential, header, raw request, or remote payload is returned or written. */
export async function runSidecarDispatchFixture(sourceRoot: string, failure = true) {
  const originalFetch = globalThis.fetch;
  const events: DispatchEvent[] = [];
  let sends = 0;
  let sidecarSends = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const pathname = new URL(req.url).pathname;
      if (req.method !== "POST" || !["/responses", "/chat/completions"].includes(pathname)) return new Response(null, { status: 400 });
      await req.arrayBuffer(); // Existing recorder consumer; never retained.
      sends++;
      if (pathname === "/responses") {
        sidecarSends++;
        if (failure) return new Response("synthetic sidecar failure", { status: 503 });
        return new Response('data: {"type":"response.output_text.delta","delta":"synthetic caption"}\n\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n', { headers: { "content-type": "text/event-stream" } });
      }
      return new Response('data: {"choices":[{"delta":{"content":"synthetic main answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  const allowedOrigin = upstream.url.origin;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== allowedOrigin) throw new Error("surface fixture blocked non-loopback destination");
    if ((init as RequestInit & { proxy?: unknown } | undefined)?.proxy != null) throw new Error("surface fixture blocked explicit proxy");
    const response = await originalFetch(input, { ...init, redirect: "manual", proxy: null } as RequestInit);
    if (response.status >= 300 && response.status < 400) throw new Error("surface fixture blocked redirect");
    return response;
  }) as typeof fetch;
  let vision: typeof import("../../src/vision") | undefined;
  try {
    const accountingPath = join(sourceRoot, "src/usage/dispatch.ts");
    const accounting: typeof import("../../src/usage/dispatch") | undefined = await Bun.file(accountingPath).exists() ? await import(accountingPath) : undefined;
    const observer: typeof import("../../src/usage/dispatch-http") | undefined = accounting ? await import(join(sourceRoot, "src/usage/dispatch-http.ts")) : undefined;
    vision = await import(join(sourceRoot, "src/vision/index.ts"));
    const { parseRequest } = await import(join(sourceRoot, "src/responses/parser.ts")) as typeof import("../../src/responses/parser");
    const { createOpenAIChatAdapter } = await import(join(sourceRoot, "src/adapters/openai-chat.ts")) as typeof import("../../src/adapters/openai-chat");
    const { createTranslatorBudget } = await import(join(sourceRoot, "src/lib/translator-budget.ts")) as typeof import("../../src/lib/translator-budget");
    const parent = accounting?.createDispatchRequest(event => events.push(event)).attempt({ surface: "responses", protocol: "chat" });
    const provider: CodexCommanderProviderConfig = { adapter: "openai-responses", authMode: "forward", baseUrl: allowedOrigin };
    vision!.setVisionDescriptionCache();
    vision!.resetVisionDescriptionCache();
    const parsed = () => parseRequest({ model: "synthetic", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "synthetic image question" }, { type: "input_image", image_url: "data:image/png;base64,YQ==" }] }] });
    const request = parsed();
    const plan: import("../../src/vision").VisionPlan = { backend: "openai", forwardSidecar: { providerName: "openai", provider, accountMode: "direct", authContext: { kind: "main", accountId: null }, headers: new Headers() }, settings: { model: "synthetic-vision", timeoutMs: 2000 }, maxDescriptionsPerTurn: 8 };
    const budget = createTranslatorBudget();
    try {
      await vision!.describeImagesInPlace(request, plan, new Headers(), undefined, undefined, budget, parent);
      const beforeCache = sends;
      if (!failure) await vision!.describeImagesInPlace(parsed(), plan, new Headers(), undefined, undefined, budget, parent);
      const cacheHitSendCount = failure ? null : sends - beforeCache;
      const mainProvider: CodexCommanderProviderConfig = { adapter: "openai-chat", baseUrl: allowedOrigin, apiKey: "synthetic-fixture" };
      const adapter = createOpenAIChatAdapter(mainProvider);
      const built = await adapter.buildRequest(request, { headers: new Headers(), translatorBudget: budget });
      const init = { method: built.method, headers: built.headers, body: built.body };
      const response = observer ? await observer.dispatchHttpFetch(fetch, built.url, init, { attempt: parent }) : await fetch(built.url, init);
      let mainText = "";
      const stream = adapter.parseStream(response, budget);
      for await (const event of observer ? observer.observeAdapterStream(response, stream) : stream) if (event.type === "text_delta") mainText += event.text;
      if (mainText !== "synthetic main answer") throw new Error("unexpected fixture main output");
      const folded = accounting?.foldDispatchEvents(events);
      return {
        scenario: failure ? "sidecar-failure-main-success" : "vision-cache-hit",
        scope: "production vision admission and main adapter on guarded loopback; full Responses integration tested separately",
        sendCount: sends, sidecarSendCount: sidecarSends, cacheHitSendCount, mainText,
        requestCount: folded?.requests.length ?? null, attemptCount: folded?.attempts.length ?? null,
        outcomes: folded?.sends.map(send => send.outcome) ?? [],
        coverage: folded ? (folded.complete ? "complete" : "incomplete") : "unavailable",
        events,
        sourceFiles: ["src/vision/index.ts", "src/vision/describe.ts", "src/adapters/openai-chat.ts"],
        testCommand: "bun test tests/dispatch-surfaces.test.ts",
      };
    } finally { budget.dispose(); }
  } finally {
    vision?.resetVisionDescriptionCache();
    globalThis.fetch = originalFetch;
    upstream.stop(true);
  }
}

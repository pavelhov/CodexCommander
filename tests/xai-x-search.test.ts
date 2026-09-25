import { afterEach, describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { routeModel } from "../src/router";
import { getProviderRegistryEntry } from "../src/providers/registry";
import {
  buildXSearchTool,
  buildWebSearchTool,
  isXSearchModel,
  parseXSearchArgs,
  parseXSearchResponse,
  planXaiXSearch,
  planXSearchOnlyLoop,
  runXaiXSearch,
  type XaiXSearchSidecar,
} from "../src/web-search";
import { runWithWebSearch, scanEventsForWebSearch } from "../src/web-search/loop";
import type { ProviderAdapter } from "../src/adapters/base";
import type { AdapterEvent, CodexCommanderConfig, CodexCommanderMessage, CodexCommanderProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const SECRET = "xai-test-bearer-do-not-leak";

const xaiProvider: CodexCommanderProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://api.x.ai/v1",
  apiKey: SECRET,
  headers: { "x-transport": "grok" },
};

function config(overrides: Partial<CodexCommanderConfig> = {}): CodexCommanderConfig {
  return { port: 10100, defaultProvider: "xai", providers: { xai: xaiProvider }, ...overrides };
}

function parsed(tools: unknown[] = []) {
  return parseRequest({ model: "xai/grok-4.7", input: "What are people saying on X?", stream: true, tools });
}

function xaiBody(): Record<string, unknown> {
  return {
    output: [
      { type: "custom_tool_call", call_id: "xs_1", name: "x_keyword_search", input: "{}" },
      {
        type: "message",
        content: [{
          type: "output_text",
          text: "Grok 4.7 shipped today, per @xai.",
          annotations: [
            { type: "url_citation", url: "https://x.com/xai/status/1", title: "1" },
            { type: "url_citation", url: "https://x.com/xai/status/1", title: "1" },
            { type: "url_citation", url: "https://x.com/elonmusk/status/2", title: "Launch post" },
            { type: "url_citation", url: "javascript:alert(1)" },
          ],
        }],
      },
    ],
    usage: { server_side_tool_usage_details: { x_search_calls: 2, x_posts_fetched: 5, x_users_fetched: 1 } },
  };
}

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };

function sidecar(respond: (c: Captured) => Response | Promise<Response>, captured: Captured[] = []): XaiXSearchSidecar {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Captured = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    captured.push(c);
    return respond(c);
  }) as typeof fetch;
  return { provider: { ...xaiProvider, fetch: fetchImpl }, model: "grok-4.7", timeoutMs: 5_000 };
}

let warnings: string[] = [];
const originalWarn = console.warn;
const originalFetch = globalThis.fetch;
function captureWarnings(): void {
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
}
afterEach(() => { console.warn = originalWarn; globalThis.fetch = originalFetch; });

describe("xAI x_search planning", () => {
  test("registry marks only grok-4.7 as an X-search model", () => {
    expect(isXSearchModel("xai", "grok-4.7")).toBe(true);
    expect(isXSearchModel("xai", "grok-4.6")).toBe(false);
    expect(isXSearchModel("openrouter", "grok-4.7")).toBe(false);
  });

  test("plans only for xai grok-4.7 with a bearer, unless disabled or client-defined", () => {
    const plan = planXaiXSearch(config(), parsed(), "xai", xaiProvider, "grok-4.7");
    expect(plan?.model).toBe("grok-4.7");
    expect(plan?.timeoutMs).toBeGreaterThanOrEqual(90_000);

    expect(planXaiXSearch(config(), parsed(), "xai", xaiProvider, "grok-4.6")).toBeUndefined();
    expect(planXaiXSearch(config(), parsed(), "anthropic", xaiProvider, "grok-4.7")).toBeUndefined();
    expect(planXaiXSearch(config(), parsed(), "xai", { ...xaiProvider, apiKey: undefined }, "grok-4.7")).toBeUndefined();
    expect(planXaiXSearch(config({ webSearchSidecar: { xSearch: false } }), parsed(), "xai", xaiProvider, "grok-4.7")).toBeUndefined();
    const clientTool = parsed([{ type: "function", name: "x_search", description: "mine", parameters: {} }]);
    expect(planXaiXSearch(config(), clientTool, "xai", xaiProvider, "grok-4.7")).toBeUndefined();
  });

  test("x-search-only loop plan never carries a web-search backend", () => {
    const plan = planXSearchOnlyLoop(config(), 90_000);
    expect(plan.forwardSidecar).toBeUndefined();
    expect(plan.anthropicSidecar).toBeUndefined();
    expect(plan.maxSearches).toBeGreaterThan(0);
    expect(plan.stallTimeoutSec).toBeGreaterThanOrEqual(90);
  });

  test("synthetic tool is filtered from the forced-answer pass", () => {
    const tool = buildXSearchTool();
    expect(tool.name).toBe("x_search");
    expect(tool.webSearch).toBe(true);
  });
});

describe("x_search argument validation", () => {
  test("keeps valid handles and dates and prefers the allow-list", () => {
    const args = parseXSearchArgs(JSON.stringify({
      query: "  grok launch  ",
      allowed_x_handles: ["@xai", "bad handle!", "xai", "elonmusk"],
      excluded_x_handles: ["spam"],
      from_date: "2026-09-01",
      to_date: "yesterday",
    }));
    expect(args).toEqual({ query: "grok launch", allowedHandles: ["xai", "elonmusk"], fromDate: "2026-09-01" });
    expect(parseXSearchArgs("{not json").query).toBe("");
    expect(parseXSearchArgs(JSON.stringify({ query: "q", allowed_x_handles: Array.from({ length: 30 }, (_, i) => `h${i}`) })).allowedHandles).toHaveLength(20);
  });
});

describe("xAI x_search executor", () => {
  test("posts the hosted x_search tool to /responses on the routed transport", async () => {
    captureWarnings();
    const captured: Captured[] = [];
    const out = await runXaiXSearch(
      { query: "grok 4.7", excludedHandles: ["spam"], fromDate: "2026-09-20" },
      sidecar(() => Response.json(xaiBody()), captured),
    );
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe("https://api.x.ai/v1/responses");
    expect(req.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(req.headers.get("x-transport")).toBe("grok");
    expect(req.body.model).toBe("grok-4.7");
    expect(req.body.store).toBe(false);
    expect(req.body.tools).toEqual([{ type: "x_search", excluded_x_handles: ["spam"], from_date: "2026-09-20" }]);
    expect(out.error).toBeUndefined();
    expect(out.text).toContain("Grok 4.7 shipped");
    expect(out.sources).toEqual([
      { url: "https://x.com/xai/status/1" },
      { url: "https://x.com/elonmusk/status/2", title: "Launch post" },
    ]);
    // Only aggregate counts are logged: no query, bearer, or answer text.
    const logged = warnings.join("\n");
    expect(logged).toContain("2 searches, 5 posts, 1 profiles");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("grok 4.7");
    expect(logged).not.toContain("shipped");
  });

  test("non-2xx maps to a status message without leaking the body", async () => {
    captureWarnings();
    const out = await runXaiXSearch({ query: "q" }, sidecar(() => new Response(`upstream said ${SECRET}`, { status: 403 })));
    expect(out.error).toContain("HTTP 403");
    expect(out.error).not.toContain(SECRET);
    expect(warnings.join("\n")).not.toContain(SECRET);
  });

  test("oversized X search responses stop at the byte cap", async () => {
    captureWarnings();
    const oversized = "x".repeat(4 * 1024 * 1024 + 1);
    const out = await runXaiXSearch({ query: "q" }, sidecar(() => new Response(oversized)));
    expect(out.error).toBe("xAI X search response was too large");
  });

  test("empty answers are errors; custom_tool_call items are ignored", () => {
    expect(parseXSearchResponse({ output: [{ type: "custom_tool_call", name: "x_user_search" }] }).error).toBe("x_search produced no answer");
  });

  test("top-level X citations survive missing inline annotations", () => {
    const out = parseXSearchResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "A cited answer." }] }],
      citations: ["https://x.com/xai/status/42", "https://x.ai/news", "https://x.com/xai/status/42"],
    });
    expect(out.sources).toEqual([{ url: "https://x.com/xai/status/42" }]);
  });

  test("top-level X citations remain visible alongside unrelated inline annotations", () => {
    const out = parseXSearchResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "A cited answer.", annotations: [
        { type: "url_citation", url: "https://x.ai/news", title: "xAI News" },
      ] }] }],
      citations: ["https://x.com/xai/status/42"],
    });
    expect(out.sources).toEqual([
      { url: "https://x.ai/news", title: "xAI News" },
      { url: "https://x.com/xai/status/42" },
    ]);
  });

  test("parent abort yields a cancelled result", async () => {
    captureWarnings();
    const ac = new AbortController();
    const hang = sidecar(c => new Promise<Response>((_r, reject) => {
      void c;
      ac.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = runXaiXSearch({ query: "q" }, hang, ac.signal);
    ac.abort();
    expect((await pending).error).toBe("X search cancelled");
  });

  test("deadline yields a timeout error", async () => {
    captureWarnings();
    const s = sidecar(() => new Promise<Response>(() => undefined));
    const fetchImpl = s.provider.fetch!;
    s.provider.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const p = fetchImpl(input, init);
      return new Promise<Response>((resolve, reject) => {
        void p.then(resolve, reject);
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as typeof fetch;
    s.timeoutMs = 20;
    expect((await runXaiXSearch({ query: "q" }, s)).error).toBe("xAI X search timed out");
  });
});

describe("web-search loop intercepts x_search", () => {
  function onePassAdapter(events: AdapterEvent[]): ProviderAdapter {
    return {
      name: "grok-chat",
      buildRequest: () => ({ url: "https://api.x.ai/v1/chat/completions", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() { for (const event of events) yield event; },
      async parseResponse() { throw new Error("unreachable"); },
    };
  }

  test("scan leaves a client x_search call alone unless X search is active", () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "c1", name: "x_search" },
      { type: "tool_call_delta", arguments: "{\"query\":\"q\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    expect(scanEventsForWebSearch(events).calls).toHaveLength(0);
    const active = scanEventsForWebSearch(events, true);
    expect(active.calls).toEqual([{ id: "c1", queries: ["q"], kind: "x", xArgs: { query: "q" } }]);
    expect(active.hasRealToolCall).toBe(false);
    const clientWebCall = events.map(event => event.type === "tool_call_start" ? { ...event, name: "web_search" } : event);
    const xOnly = scanEventsForWebSearch(clientWebCall, true, false);
    expect(xOnly.calls).toHaveLength(0);
    expect(xOnly.hasRealToolCall).toBe(true);
  });

  test("a non-streaming Grok response remains JSON", async () => {
    const request = parsed();
    request.stream = false;
    request.context.tools = [buildXSearchTool()];
    const res = await runWithWebSearch({
      parsed: request,
      adapter: onePassAdapter([{ type: "text_delta", text: "No search needed." }, { type: "done" }]),
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      backend: "openai", hostedTool: {}, selectedForwardHeaders: new Headers(),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 90_000 }, maxSearches: 3,
      xSearch: sidecar(() => Response.json(xaiBody())), webSearchEnabled: false,
    });
    expect(res.headers.get("content-type")).toBe("application/json");
    expect((await res.json() as { output: unknown[] }).output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message" }),
    ]));
  });

  test("a mixed X search and shell batch runs search and forwards shell", async () => {
    captureWarnings();
    const request = parsed([{ type: "function", name: "shell", description: "run", parameters: {} }]);
    request.context.tools = [...(request.context.tools ?? []), buildXSearchTool()];
    const captured: Captured[] = [];
    const res = await runWithWebSearch({
      parsed: request,
      adapter: onePassAdapter([
        { type: "tool_call_start", id: "xs_mixed", name: "x_search" },
        { type: "tool_call_delta", arguments: '{"query":"same topic"}' },
        { type: "tool_call_end" },
        { type: "tool_call_start", id: "shell_mixed", name: "shell" },
        { type: "tool_call_delta", arguments: '{"cmd":"ls"}' },
        { type: "tool_call_end" },
        { type: "done" },
      ]),
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      backend: "openai", hostedTool: {}, selectedForwardHeaders: new Headers(),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 90_000 }, maxSearches: 3,
      xSearch: sidecar(() => Response.json(xaiBody()), captured), webSearchEnabled: false,
    });
    const text = await res.text();
    expect(captured).toHaveLength(1);
    expect(text).toContain("web_search_call");
    expect(text).toContain("shell_mixed");
    expect(text).not.toContain("xs_mixed\",\"name\":\"x_search");
  });

  test("a failed query on one backend does not suppress the other backend", async () => {
    captureWarnings();
    for (const first of ["x_search", "web_search"] as const) {
      const second = first === "x_search" ? "web_search" : "x_search";
      const passes: AdapterEvent[][] = [first, second].map((name, index) => [
        { type: "tool_call_start", id: `search_${index}`, name },
        { type: "tool_call_delta", arguments: '{"query":"same topic"}' },
        { type: "tool_call_end" },
        { type: "done" },
      ]);
      passes.push([{ type: "text_delta", text: "Answer after both tools." }, { type: "done" }]);
      let pass = 0;
      const adapter = onePassAdapter([]);
      adapter.parseStream = async function* () { for (const event of passes[pass++] ?? []) yield event; };
      let webCalls = 0;
      globalThis.fetch = (async () => {
        webCalls++;
        return first === "web_search"
          ? new Response("unavailable", { status: 503 })
          : new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Web result"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
      }) as typeof fetch;
      const xCalls: Captured[] = [];
      const request = parsed([{ type: "web_search" }]);
      request.context.tools = [...(request.context.tools ?? []), buildXSearchTool(), buildWebSearchTool()];
      const res = await runWithWebSearch({
        parsed: request, adapter,
        incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
        backend: "openai", hostedTool: { type: "web_search" },
        forwardProvider: { adapter: "openai-responses", baseUrl: "https://chatgpt.test/v1", authMode: "forward" },
        selectedForwardHeaders: new Headers({ authorization: "Bearer test" }),
        settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 5_000 }, maxSearches: 3,
        xSearch: sidecar(() => first === "x_search" ? new Response("unavailable", { status: 503 }) : Response.json(xaiBody()), xCalls),
        webSearchEnabled: true,
      });
      const text = await res.text();
      expect(text).toContain("Answer after both tools.");
      expect(xCalls).toHaveLength(1);
      expect(webCalls).toBe(1);
      globalThis.fetch = originalFetch;
    }
  });

  test("runs the sidecar, streams a completed search cell with x.com sources, then the answer", async () => {
    captureWarnings();
    const passes: AdapterEvent[][] = [
      [
        { type: "tool_call_start", id: "xs_call", name: "x_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "grok 4.7 launch", allowed_x_handles: ["xai"] }) },
        { type: "tool_call_end" },
        { type: "done" },
      ],
      [
        { type: "text_delta", text: "Summary from X." },
        { type: "tool_call_start", id: "shell_1", name: "shell" },
        { type: "tool_call_delta", arguments: "{\"cmd\":\"ls\"}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    ];
    const seenContexts: CodexCommanderMessage[][] = [];
    let pass = 0;
    const adapter: ProviderAdapter = {
      name: "grok-chat",
      buildRequest: (p) => {
        seenContexts.push([...p.context.messages]);
        return { url: "https://api.x.ai/v1/chat/completions", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() { for (const e of passes[pass++]!) yield e; },
      async parseResponse() { throw new Error("unreachable"); },
    };
    const captured: Captured[] = [];
    const request = parsed([{ type: "function", name: "shell", description: "run", parameters: {} }]);
    request.context.tools = [...(request.context.tools ?? []), buildXSearchTool()];
    const loopPlan = planXSearchOnlyLoop(config(), 5_000);
    const res = await runWithWebSearch({
      parsed: request,
      adapter,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      backend: loopPlan.backend,
      hostedTool: loopPlan.hostedTool,
      selectedForwardHeaders: new Headers(),
      settings: loopPlan.settings,
      maxSearches: loopPlan.maxSearches,
      xSearch: sidecar(() => Response.json(xaiBody()), captured),
      webSearchEnabled: false,
    });
    const text = await res.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.tools).toEqual([{ type: "x_search", allowed_x_handles: ["xai"] }]);
    expect(text).toContain("web_search_call");
    expect(text).toContain("https://x.com/xai/status/1");
    expect(text).toContain("Summary from X.");
    // The real function call still reaches Codex; the synthetic x_search call never does.
    expect(text).toContain("\"shell\"");
    expect(text).not.toContain("xs_call\",\"name\":\"x_search");
    // The second pass replays the x_search call and its result.
    const replay = seenContexts[1]!;
    const toolResult = replay.find(m => m.role === "toolResult");
    expect(toolResult && "toolName" in toolResult ? toolResult.toolName : undefined).toBe("x_search");
    expect(JSON.stringify(replay)).toContain("https://x.com/elonmusk/status/2");
  });
});

describe("grok-4.7 static metadata and catalog routing", () => {
  test("registry seeds grok-4.7 with context, effort, and image input", () => {
    const xai = getProviderRegistryEntry("xai");
    expect(xai?.models).toContain("grok-4.7");
    expect(xai?.modelContextWindows?.["grok-4.7"]).toBe(500_000);
    expect(xai?.modelReasoningEfforts?.["grok-4.7"]).toContain("xhigh");
    expect(xai?.modelInputModalities?.["grok-4.7"]).toEqual(["text", "image"]);
  });

  test("xai/grok-4.7 is in the catalog and routes without live discovery", async () => {
    clearModelCache("xai");
    const cfg: CodexCommanderConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: { xai: { baseUrl: "https://api.x.ai/v1", adapter: "openai-chat", authMode: "key", apiKey: SECRET, liveModels: false } },
    };
    const models = await gatherRoutedModels(cfg);
    const grok47 = models.find(m => m.provider === "xai" && m.id === "grok-4.7");
    expect(grok47?.contextWindow).toBe(500_000);
    const route = routeModel(cfg, "xai/grok-4.7");
    expect(route.providerName).toBe("xai");
    expect(route.modelId).toBe("grok-4.7");
  });
});

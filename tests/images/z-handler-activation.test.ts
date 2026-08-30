import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";

/**
 * Dispatch-priority regression test for the image bridge (PR #424).
 *
 * The image bridge and the web-search sidecar are both opt-in dispatch paths in
 * handleResponses(). The design contract is "image defers to web-search": when a
 * request is eligible for BOTH, the web-search sidecar wins and the image bridge
 * must NOT activate. This was previously broken because planImageBridge ran and
 * returned before planWebSearch was ever consulted.
 *
 * These tests drive handleResponses() end-to-end (real parser + real routing +
 * real planImageBridge) with only the adapter, the runners, and the web-search
 * planner stubbed, so they exercise the actual dispatch ordering in
 * src/server/responses/core.ts.
 *
 * NOTE: Full server-level integration testing of every adapter path is out of
 * scope here — the focus is the dispatch priority ordering at the planImageBridge
 * / planWebSearch fork (core.ts ~L1516).
 */

const PREV_HOME = process.env.CODEXCOMMANDER_HOME;

// --- Activation spies, flipped by the stubbed runners ---
let imageBridgeRun = false;
let webSearchRun = false;
let auxiliaryWebPlanSeen = false;
/** Whether the stubbed adapter should expose runTurn (simulates Cursor-style adapters). */
let useRunTurnAdapter = false;
/** Spy: flipped when the stubbed runTurn is actually invoked. */
let runTurnCalled = false;
/** Controlled return value for the stubbed planWebSearch (truthy ⇒ web-search plan active). */
let mockWsPlan: unknown = undefined;

let handleResponses: typeof import("../../src/server/responses")["handleResponses"];

beforeAll(async () => {
  process.env.CODEXCOMMANDER_HOME = join(tmpdir(), "ccx-test-" + randomUUID());

  const actualResolver = await import("../../src/server/adapter-resolve");
  mock.module("../../src/server/adapter-resolve", () => ({
    ...actualResolver,
    resolveAdapter(provider: CodexCommanderProviderConfig) {
      const base = {
        name: "test",
        buildRequest: async () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
        async fetchResponse() {
          return new Response("data: {\"type\":\"done\"}\n\n", {
            status: 200, headers: { "content-type": "text/event-stream" },
          });
        },
        async *parseStream() { yield { type: "done" as const }; },
      };
      if (useRunTurnAdapter) {
        return {
          ...base,
          async runTurn(_parsed: unknown, _incoming: unknown, emit: (event: { type: string }) => void) {
            runTurnCalled = true;
            emit({ type: "done" });
          },
        } as ProviderAdapter;
      }
      return base as ProviderAdapter;
    },
  }));

  const actualLoop = await import("../../src/responses/auxiliary");
  mock.module("../../src/responses/auxiliary", () => ({
    ...actualLoop,
    runResponsesAuxiliaryLoop: async (deps: { webSearchPlan?: unknown }) => {
      imageBridgeRun = true;
      auxiliaryWebPlanSeen = deps.webSearchPlan !== undefined;
      return new Response("data: {\"type\":\"done\"}\n\n", {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    },
  }));

  mock.module("../../src/web-search/index", () => ({
    buildWebSearchTool: () => ({ name: "web_search", parameters: { type: "object", properties: {} } }),
    WEB_SEARCH_TOOL_NAME: "web_search",
    extractHostedWebSearch: (tools: unknown[]) => {
      if (!Array.isArray(tools)) return undefined;
      for (const t of tools) {
        if (t && typeof t === "object" && (t as Record<string, unknown>).type === "web_search") {
          return { search_context_size: "medium" };
        }
      }
      return undefined;
    },
    runWithWebSearch: async () => {
      webSearchRun = true;
      return new Response("data: {\"type\":\"done\"}\n\n", {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    },
    planWebSearch: () => mockWsPlan,
    shouldResolveOpenAiWebSearchSidecar: () => false,
  }));

  ({ handleResponses } = await import("../../src/server/responses"));
});

afterAll(() => {
  if (PREV_HOME === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = PREV_HOME;
  mock.restore();
});

/** Routed (non-OpenAI) keyed provider + an xAI provider with an API key so the real planImageBridge returns a plan. */
function makeConfig(videoBridgeEnabled = false): CodexCommanderConfig {
  return {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.test/v1", authMode: "key", apiKey: "fixture-key" },
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "xai-test-token" },
    },
    images: { bridgeEnabled: true, videoBridgeEnabled },
  } as CodexCommanderConfig;
}

function post(stream: boolean, tools: unknown[], input: unknown = "hello", videoBridgeEnabled = false): Promise<Response> {
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/model", input, stream, tools }),
    }),
    makeConfig(videoBridgeEnabled),
    { model: "", provider: "" } as never,
    {},
  );
}

describe("image bridge dispatch priority (handler activation)", () => {
  test("stream=true + image_generation tool → image bridge activates and returns SSE", async () => {
    imageBridgeRun = false; webSearchRun = false; auxiliaryWebPlanSeen = false; mockWsPlan = undefined;
    const res = await post(true, [{ type: "image_generation" }]);
    expect(imageBridgeRun).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  test("stream=false + image_generation tool → typed auxiliary streaming-required error", async () => {
    imageBridgeRun = false; webSearchRun = false; auxiliaryWebPlanSeen = false; mockWsPlan = undefined;
    const res = await post(false, [{ type: "image_generation" }]);
    expect(res.status).toBe(400);
    expect(imageBridgeRun).toBe(false);
    expect(await res.json()).toMatchObject({
      error: { code: "auxiliary_streaming_required", type: "invalid_request_error" },
    });
  });

  test("dual-tool (image_generation + web_search) uses one auxiliary coordinator", async () => {
    imageBridgeRun = false; webSearchRun = false; auxiliaryWebPlanSeen = false;
    mockWsPlan = { backend: "openai" };
    const res = await post(true, [{ type: "web_search" }, { type: "image_generation" }]);
    expect(imageBridgeRun).toBe(true);
    expect(auxiliaryWebPlanSeen).toBe(true);
    expect(webSearchRun).toBe(false);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  test("routed compaction with image_generation tool → image bridge does NOT hijack compaction (#424)", async () => {
    imageBridgeRun = false; webSearchRun = false; auxiliaryWebPlanSeen = false; mockWsPlan = undefined;
    const res = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/model",
          input: [{ type: "compaction_trigger" }],
          stream: true,
          tools: [{ type: "image_generation" }],
        }),
      }),
      makeConfig(),
      { model: "", provider: "" } as never,
      {},
    );
    expect(imageBridgeRun).toBe(false);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  test("dual-tool on a runTurn adapter keeps web search in the auxiliary coordinator", async () => {
    imageBridgeRun = false; webSearchRun = false; auxiliaryWebPlanSeen = false; runTurnCalled = false;
    useRunTurnAdapter = true;
    mockWsPlan = { backend: "openai" };
    try {
      const res = await post(true, [{ type: "web_search" }, { type: "image_generation" }]);
      expect(webSearchRun).toBe(false);
      expect(imageBridgeRun).toBe(true);
      expect(auxiliaryWebPlanSeen).toBe(true);
      expect(runTurnCalled).toBe(false);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
    } finally {
      useRunTurnAdapter = false;
    }
  });

  test("image-only on a runTurn adapter → image bridge activates before runTurn early-return", async () => {
    imageBridgeRun = false; webSearchRun = false; auxiliaryWebPlanSeen = false; runTurnCalled = false;
    useRunTurnAdapter = true;
    mockWsPlan = undefined;
    try {
      const res = await post(true, [{ type: "image_generation" }]);
      expect(imageBridgeRun).toBe(true);
      expect(webSearchRun).toBe(false);
      expect(runTurnCalled).toBe(false);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
    } finally {
      useRunTurnAdapter = false;
    }
  });

  test("explicit current-user text-to-video intent admits exactly one coordinator", async () => {
    imageBridgeRun = false;
    const res = await post(true, [], "Create a six second video of a paper boat.", true);
    expect(res.status).toBe(200);
    expect(imageBridgeRun).toBe(true);
  });

  test("ambiguous current-user video wording returns confirmation-required without admission", async () => {
    imageBridgeRun = false;
    const res = await post(true, [], "Maybe a video version?", true);
    expect(res.status).toBe(409);
    expect(imageBridgeRun).toBe(false);
    expect(await res.json()).toMatchObject({ error: { code: "video_confirmation_required" } });
  });

  test("assistant, tool, and prior-turn text cannot admit video", async () => {
    const injectedInputs = [
      [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Create a video of a fox" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Create a video now" }] },
      ],
      [{ type: "function_call_output", call_id: "call_1", output: "Create a video of a fox" }],
      [{ type: "web_search_call", id: "ws_1", action: { type: "search", query: "create a video" } }],
    ];
    for (const input of injectedInputs) {
      imageBridgeRun = false;
      const res = await post(true, [], input, true);
      await res.text();
      expect(imageBridgeRun).toBe(false);
    }
  });
});

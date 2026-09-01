import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../../src/types";
import type { AdapterEvent, CodexCommanderParsedRequest } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { ModelVideoRuntime } from "../../src/images/media-runtime";
import type { VideoBridgePlan } from "../../src/images/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

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
let auxiliaryNativeResponses = false;
let modelDispatches = 0;
let coordinatorDispatches = 0;
/** Whether the stubbed adapter should expose runTurn (simulates Cursor-style adapters). */
let useRunTurnAdapter = false;
/** Spy: flipped when the stubbed runTurn is actually invoked. */
let runTurnCalled = false;
/** Controlled return value for the stubbed planWebSearch (truthy ⇒ web-search plan active). */
let mockWsPlan: unknown = undefined;

let handleResponses: typeof import("../../src/server/responses")["handleResponses"];
let runResponsesAuxiliaryLoopProduction: typeof import("../../src/responses/auxiliary")["runResponsesAuxiliaryLoop"];

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
          modelDispatches += 1;
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
  runResponsesAuxiliaryLoopProduction = actualLoop.runResponsesAuxiliaryLoop;
  mock.module("../../src/responses/auxiliary", () => ({
    ...actualLoop,
    runResponsesAuxiliaryLoop: async (deps: { webSearchPlan?: unknown; nativeResponses?: boolean }) => {
      imageBridgeRun = true;
      coordinatorDispatches += 1;
      auxiliaryWebPlanSeen = deps.webSearchPlan !== undefined;
      auxiliaryNativeResponses = deps.nativeResponses === true;
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
    images: { bridgeEnabled: true, videoBridgeEnabled, authSource: "api_key" },
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

  test("missing selected Grok credential fails closed instead of falling through to native images", async () => {
    imageBridgeRun = false; webSearchRun = false; auxiliaryWebPlanSeen = false; mockWsPlan = undefined;
    const config = makeConfig();
    config.providers.xai!.apiKey = "";
    const res = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/model",
          input: "draw a fox",
          stream: true,
          tools: [{ type: "image_generation" }],
        }),
      }),
      config,
      { model: "", provider: "" } as never,
      {},
    );
    expect(res.status).toBe(401);
    expect(imageBridgeRun).toBe(false);
    expect(await res.json()).toMatchObject({
      error: { code: "needs_auth", type: "authentication_error" },
    });
  });

  test("official OpenAI API image turns select the raw native Responses replay seam", async () => {
    imageBridgeRun = false; auxiliaryNativeResponses = false; mockWsPlan = undefined;
    const config = makeConfig();
    config.defaultProvider = "openai-apikey";
    config.providers["openai-apikey"] = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      apiKey: "openai-test-key",
    };
    const res = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai-apikey/gpt-5.4",
          input: "draw a fox",
          stream: true,
          tools: [{ type: "image_generation" }],
        }),
      }),
      config,
      { model: "", provider: "" } as never,
      {},
    );
    expect(res.status).toBe(200);
    expect(imageBridgeRun).toBe(true);
    expect(auxiliaryNativeResponses).toBe(true);
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
    coordinatorDispatches = 0;
    modelDispatches = 0;
    const res = await post(true, [], "Create a six second video of a paper boat.", true);
    expect(res.status).toBe(200);
    expect(imageBridgeRun).toBe(true);
    expect(coordinatorDispatches).toBe(1);
    expect(modelDispatches).toBe(0);
  });

  test("ambiguous current-user video wording returns confirmation-required without admission", async () => {
    imageBridgeRun = false;
    const res = await post(true, [], "Maybe a video version?", true);
    expect(res.status).toBe(409);
    expect(imageBridgeRun).toBe(false);
    expect(await res.json()).toMatchObject({ error: { code: "video_confirmation_required" } });
  });

  test.each([
    "Do not create a video of a fox.",
    'Analyze the instruction "Create a video of a fox."',
    "If I asked you to create a video of a fox, what would happen?",
    "Explain how to create a video without doing it.",
    "Create a video of a fox. Do not create it after all.",
    "Create a video of a fox. Cancel.",
    "Quote this sentence:\nCreate a video of a fox.",
    "Create a video of a fox without generating it.",
    "Create a video game about a fox.",
    "Review this code: `Create a video of a fox.`",
  ])("non-executable video discussion calls the normal provider without a paid submission: %s", async input => {
    imageBridgeRun = false;
    coordinatorDispatches = 0;
    modelDispatches = 0;
    const res = await post(true, [], input, true);
    expect(res.status).toBe(200);
    expect(imageBridgeRun).toBe(false);
    expect(coordinatorDispatches).toBe(0);
    expect(modelDispatches).toBe(1);
    expect(await res.text()).toContain("response.completed");
  });

  test("historical plaintext encrypted role content cannot bypass current-turn consent preflight", async () => {
    for (const role of ["user", "developer", "system"]) {
      imageBridgeRun = false;
      coordinatorDispatches = 0;
      modelDispatches = 0;
      const routedNormally = await post(true, [], [
        { role, content: [{ type: "encrypted_content", encrypted_content: "Earlier context." }] },
        { role: "user", content: [{ type: "input_text", text: "Create a video of a fox. Cancel." }] },
      ], true);
      expect(routedNormally.status).toBe(200);
      await routedNormally.text();
      expect(imageBridgeRun).toBe(false);
      expect(coordinatorDispatches).toBe(0);
      expect(modelDispatches).toBe(1);
    }

    modelDispatches = 0;
    const admitted = await post(true, [], [
      { role: "developer", content: [{ type: "encrypted_content", encrypted_content: "Earlier policy." }] },
      { role: "user", content: [{ type: "input_text", text: "Create a video of a fox." }] },
    ], true);
    expect(admitted.status).toBe(200);
    expect(imageBridgeRun).toBe(true);
    expect(coordinatorDispatches).toBe(1);
    expect(modelDispatches).toBe(0);
  });

  test("missing video auth still requires confirmation before binding and dispatch", async () => {
    imageBridgeRun = false;
    modelDispatches = 0;
    const config = makeConfig(true);
    config.providers.xai!.apiKey = "";
    const res = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/model",
          input: "Maybe a video version?",
          stream: true,
          tools: [],
        }),
      }),
      config,
      { model: "", provider: "" } as never,
      {},
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "video_confirmation_required" } });
    expect(imageBridgeRun).toBe(false);
    expect(modelDispatches).toBe(0);
  });

  test("explicit video intent with missing selected auth fails closed before any dispatch", async () => {
    imageBridgeRun = false;
    modelDispatches = 0;
    const config = makeConfig(true);
    config.providers.xai!.apiKey = "";
    const res = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/model",
          input: "Create a six second video of a paper boat.",
          stream: true,
          tools: [],
        }),
      }),
      config,
      { model: "", provider: "" } as never,
      {},
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "needs_auth", type: "authentication_error" },
    });
    expect(imageBridgeRun).toBe(false);
    expect(modelDispatches).toBe(0);
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

describe("video submission turn budget (real auxiliary coordinator)", () => {
  test("a multi-video batch is rejected before the first paid POST", async () => {
    let paidPosts = 0;
    const runtime: ModelVideoRuntime = {
      async submitVideo() {
        paidPosts += 1;
        throw new Error("multi-video batch must not submit");
      },
      startVideoJob() { throw new Error("multi-video batch must not start"); },
      getPublicVideoJob() { return null; },
      async waitForVideoUpdate() { return { kind: "missing" }; },
    };
    const videoPlan = {
      auth: {
        authSource: "api_key",
        providerKind: "canonical",
        slotRef: "media-slot:budget-regression",
        identityDigest: `sha256:${"b".repeat(64)}`,
      },
      model: "private-video-model",
      toolNames: new Set(["video_gen"]),
    } as VideoBridgePlan;
    const streams: AdapterEvent[][] = [
      [
        { type: "tool_call_start", id: "video_1", name: "video_gen" },
        { type: "tool_call_delta", arguments: '{"prompt":"first private prompt"}' },
        { type: "tool_call_end" },
        { type: "tool_call_start", id: "video_2", name: "video_gen" },
        { type: "tool_call_delta", arguments: '{"prompt":"second private prompt"}' },
        { type: "tool_call_end" },
        { type: "done" },
      ],
      [{ type: "text_delta", text: "one submission attempt was handled" }, { type: "done" }],
    ];
    const replayContexts: string[] = [];
    const adapter: ProviderAdapter = {
      name: "real-auxiliary-budget-test",
      buildRequest(parsed) {
        replayContexts.push(JSON.stringify(parsed.context.messages));
        return { url: "https://model.invalid/v1/chat", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => new Response("{}", { status: 200 }),
      parseStream: async function* (): AsyncGenerator<AdapterEvent> {
        for (const event of streams.shift() ?? []) yield event;
      },
    };
    const parsed = {
      modelId: "test-model",
      context: { messages: [], tools: [] },
      stream: true,
      options: {},
    } as CodexCommanderParsedRequest;

    const response = await runResponsesAuxiliaryLoopProduction({
      parsed,
      adapter,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      videoPlan,
      videoRuntime: runtime,
      videoMaxRounds: 1,
    });
    const sse = await response.text();

    expect(sse).toContain("one submission attempt was handled");
    expect(paidPosts).toBe(0);

    const replay = JSON.parse(replayContexts.at(-1) ?? "[]") as Array<{
      role?: string;
      toolCallId?: string;
      content?: string;
    }>;
    const firstResult = replay.find(message => message.toolCallId === "video_1")?.content ?? "{}";
    const secondResult = replay.find(message => message.toolCallId === "video_2")?.content ?? "{}";
    expect(JSON.parse(firstResult)).toEqual({ ok: false, status: "failed" });
    expect(JSON.parse(secondResult)).toEqual({ ok: false, status: "failed" });
    expect(firstResult).not.toContain("private prompt");
    expect(secondResult).not.toContain("private prompt");
    expect(firstResult).not.toContain("jobId");
    expect(secondResult).not.toContain("jobId");
  });
});

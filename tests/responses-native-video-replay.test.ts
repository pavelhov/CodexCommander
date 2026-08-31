import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { ProviderAdapter } from "../src/adapters/base";
import { rewriteVideoGenerationForBridge } from "../src/adapters/openai-responses";
import type { ModelVideoRuntime } from "../src/images/media-runtime";
import type { ImageBridgePlan, VideoBridgePlan } from "../src/images/types";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { appendNativeAuxiliaryTurn } from "../src/responses/auxiliary/native-replay";
import type { CodexCommanderParsedRequest } from "../src/types";

const TEST_HOME = join(import.meta.dir, ".tmp-native-video-replay");
const ARTIFACT_ID = "native-video.mp4";
const ARTIFACT = join(TEST_HOME, "artifacts", ARTIFACT_ID);
const previousHome = process.env.CODEXCOMMANDER_HOME;
let runResponsesAuxiliaryLoop: typeof import("../src/responses/auxiliary")["runResponsesAuxiliaryLoop"];

const videoPlan: VideoBridgePlan = {
  auth: {
    authSource: "api_key",
    providerKind: "canonical",
    slotRef: "media-slot:private-sentinel",
    identityDigest: `sha256:${"b".repeat(64)}`,
  },
  model: "private-video-model",
  toolNames: new Set(["video_gen", "generate_video"]),
};

const imagePlan: ImageBridgePlan = {
  auth: videoPlan.auth,
  model: "private-image-model",
  toolNames: new Set(["image_generation", "image_gen"]),
};

beforeAll(async () => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(join(TEST_HOME, "artifacts"), { recursive: true });
  chmodSync(TEST_HOME, 0o700);
  process.env.CODEXCOMMANDER_HOME = TEST_HOME;
  ({ runResponsesAuxiliaryLoop } = await import(`../src/responses/auxiliary?native-video-replay=${Date.now()}`));
});

beforeEach(() => {
  mkdirSync(join(TEST_HOME, "artifacts"), { recursive: true });
  writeFileSync(ARTIFACT, "video");
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
});

function sse(payloads: Array<Record<string, unknown>>): Response {
  const text = payloads.map(payload => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`).join("")
    + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function parsedRequest(): CodexCommanderParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
    _rawBody: {
      model: "gpt-5.6-sol",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "make a short video" }] },
        {
          type: "additional_tools",
          tools: [{ type: "function", name: "generate_video", parameters: { type: "object" } }],
        },
      ],
      tools: [
        { type: "function", name: "real_tool", parameters: { type: "object" } },
        { type: "image_generation", size: "1024x1024" },
      ],
      tool_choice: {
        type: "allowed_tools",
        tools: [
          { type: "function", name: "generate_video" },
          { type: "image_generation" },
        ],
      },
      stream: true,
      provider_extension: { keep: "exact" },
    },
  };
}

function adapterFor(
  upstream: Response[],
  builtBodies: Record<string, unknown>[],
): ProviderAdapter {
  return {
    name: "openai-responses",
    buildRequest(parsed) {
      builtBodies.push(structuredClone(parsed._rawBody) as Record<string, unknown>);
      return { url: "https://native.invalid/responses", method: "POST", headers: {}, body: "{}" };
    },
    async fetchResponse() {
      const response = upstream.shift();
      if (!response) throw new Error("unexpected extra native iteration");
      return response;
    },
    async *parseStream() {
      throw new Error("native raw replay must not use lossy AdapterEvent translation");
    },
  };
}

test("native media replay executes video_gen, appends a safe result, and relays final SSE losslessly", async () => {
  const hostedSearch = {
    type: "web_search_call",
    id: "ws_native",
    status: "completed",
    action: { type: "search", query: "provider-completed context" },
  };
  const call = {
    type: "function_call",
    id: "fc_video",
    call_id: "call_video",
    name: "video_gen",
    arguments: JSON.stringify({
      prompt: "private prompt sentinel",
      duration: 3,
      resolution: "720p",
      aspect_ratio: "16:9",
    }),
    status: "completed",
    provider_extension: { preserve: true },
  };
  const first = sse([
    { type: "response.output_item.done", output_index: 0, item: hostedSearch },
    { type: "response.output_item.done", output_index: 1, item: call },
    {
      type: "response.completed",
      response: {
        id: "resp_video",
        status: "completed",
        output: [hostedSearch, call],
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      },
    },
  ]);
  const finalExtension = { exact: "native-final" };
  const finalDelta = {
    type: "response.output_text.delta",
    item_id: "msg_final",
    output_index: 0,
    content_index: 0,
    delta: "Video ready",
    provider_extension: finalExtension,
  };
  const finalResponse = {
    id: "resp_final",
    status: "completed",
    output: [],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  };
  // The terminal JSON deliberately spans multiple SSE data lines. Hidden first-iteration usage
  // still has to merge without losing the delta frame or provider extension.
  const second = new Response(
    `event: ${finalDelta.type}\ndata: ${JSON.stringify(finalDelta)}\n\n`
      + `event: response.completed\ndata: {"type":"response.completed",\n`
      + `data: "response":${JSON.stringify(finalResponse)}}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  const now = Date.now();
  let submitInput: Parameters<ModelVideoRuntime["submitVideo"]>[0] | undefined;
  let startedJob: string | undefined;
  let leaseActive = false;
  let leaseReleased = false;
  const runtime: ModelVideoRuntime = {
    async submitVideo(input) {
      submitInput = input;
      return {
        kind: "accepted",
        job: {
          id: "job_native_video",
          revision: 2,
          state: "completed",
          deadlineAt: now + 60_000,
          artifactId: ARTIFACT_ID,
          createdAt: now,
          updatedAt: now,
        },
      };
    },
    startVideoJob(id) { startedJob = id; },
    getPublicVideoJob() { return null; },
    async waitForVideoUpdate() { throw new Error("completed job must not poll"); },
    acquireArtifactDeliveryLease(id) {
      expect(id).toBe(ARTIFACT_ID);
      leaseActive = true;
      return () => {
        leaseActive = false;
        leaseReleased = true;
      };
    },
  };
  const builtBodies: Record<string, unknown>[] = [];
  const budget = createTranslatorBudget();
  try {
    const response = await runResponsesAuxiliaryLoop({
      parsed: parsedRequest(),
      adapter: adapterFor([first, second], builtBodies),
      incomingMeta: { headers: new Headers(), translatorBudget: budget },
      plan: imagePlan,
      videoPlan,
      videoRuntime: runtime,
      nativeResponses: true,
      imageMaxRounds: 2,
      videoMaxRounds: 2,
    });
    const text = await response.text();

    expect(text).toContain(JSON.stringify(finalExtension));
    expect(text).not.toContain("fc_video");
    expect(text).toContain('"usage":{"input_tokens":14,"output_tokens":6,"total_tokens":20}');
    expect(submitInput?.request).toEqual({
      prompt: "private prompt sentinel",
      model: "private-video-model",
      duration: 3,
      resolution: "720p",
      aspectRatio: "16:9",
    });
    expect(startedJob).toBe("job_native_video");
    expect(leaseActive).toBe(false);
    expect(leaseReleased).toBe(true);

    expect(builtBodies).toHaveLength(2);
    expect(builtBodies[0]!.provider_extension).toEqual({ keep: "exact" });
    expect(builtBodies[0]!.parallel_tool_calls).toBe(false);
    const firstTools = [
      ...(builtBodies[0]!.tools as Record<string, unknown>[]),
      ...((builtBodies[0]!.input as Array<{ type?: string; tools?: Record<string, unknown>[] }>)
        .flatMap(item => item.type === "additional_tools" ? item.tools ?? [] : [])),
    ];
    expect(firstTools).toContainEqual(expect.objectContaining({ type: "function", name: "image_gen" }));
    expect(firstTools).toContainEqual(expect.objectContaining({ type: "function", name: "video_gen" }));
    expect(firstTools.some(tool => tool.name === "generate_video")).toBe(false);

    const replayInput = builtBodies[1]!.input as Record<string, unknown>[];
    expect(replayInput.slice(-3)[0]).toEqual(hostedSearch);
    expect(replayInput.slice(-2)[0]).toEqual(call);
    const replayOutput = replayInput.at(-1);
    expect(replayOutput).toMatchObject({ type: "function_call_output", call_id: "call_video" });
    expect(JSON.parse(String(replayOutput?.output))).toEqual({
      ok: true,
      status: "completed",
      artifacts: [`/v1/codexcommander/artifacts/${ARTIFACT_ID}`],
      markdown: `[Open video](/v1/codexcommander/artifacts/${ARTIFACT_ID})`,
    });
    const replayText = JSON.stringify(replayOutput);
    expect(replayText).not.toContain(TEST_HOME);
    expect(replayText).not.toContain("private prompt sentinel");
    expect(replayText).not.toContain("private-video-model");
    const secondTools = [
      ...(builtBodies[1]!.tools as Record<string, unknown>[]),
      ...((builtBodies[1]!.input as Array<{ type?: string; tools?: Record<string, unknown>[] }>)
        .flatMap(item => item.type === "additional_tools" ? item.tools ?? [] : [])),
    ];
    expect(secondTools).toContainEqual(expect.objectContaining({ type: "function", name: "image_gen" }));
    expect(secondTools.some(tool => tool.name === "video_gen" || tool.name === "generate_video")).toBe(false);
    expect(builtBodies[1]!.tool_choice).toEqual({
      type: "allowed_tools",
      tools: [{ type: "function", name: "image_gen" }],
    });
  } finally {
    budget.dispose();
  }
});

test("native ambiguous video submission consumes the turn even after durable acknowledgement", async () => {
  const calls = ["one", "two"].map(suffix => ({
    type: "function_call",
    id: `fc_${suffix}`,
    call_id: `call_${suffix}`,
    name: "video_gen",
    arguments: JSON.stringify({ prompt: `private ${suffix}` }),
    status: "completed",
  }));
  const first = sse([
    ...calls.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    { type: "response.completed", response: { id: "resp_calls", status: "completed", output: calls } },
  ]);
  const second = sse([
    { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "Unable to confirm." },
    { type: "response.completed", response: { id: "resp_final", status: "completed", output: [] } },
  ]);

  const { MediaRuntime } = await import("../src/images/media-runtime");
  const { openVideoJobStore } = await import("../src/images/video-job-store");
  const store = openVideoJobStore({ path: join(TEST_HOME, "ambiguous-native.sqlite") });
  const durableRuntime = new MediaRuntime(store, {
    submitVideoJob: async () => {
      throw new Error("private provider failure https://provider.invalid/signed?token=secret");
    },
  });
  let submissions = 0;
  const runtime: ModelVideoRuntime = {
    async submitVideo(input) {
      submissions += 1;
      try {
        return await durableRuntime.submitVideo(input);
      } catch (error) {
        const uncertain = store.listVideoJobs()[0];
        expect(uncertain?.state).toBe("outcome_unknown");
        expect(durableRuntime.acknowledgeOutcomeUnknown(uncertain!.id, uncertain!.revision)?.state).toBe("acknowledged");
        throw error;
      }
    },
    startVideoJob(id) { durableRuntime.startVideoJob(id); },
    getPublicVideoJob(id) { return durableRuntime.getPublicVideoJob(id); },
    waitForVideoUpdate(id, revision, options) {
      return durableRuntime.waitForVideoUpdate(id, revision, options);
    },
  };
  const builtBodies: Record<string, unknown>[] = [];
  const budget = createTranslatorBudget();
  try {
    const parsed = parsedRequest();
    (parsed._rawBody as Record<string, unknown>).input = "make two videos";
    const response = await runResponsesAuxiliaryLoop({
      parsed,
      adapter: adapterFor([first, second], builtBodies),
      incomingMeta: { headers: new Headers(), translatorBudget: budget },
      videoPlan,
      videoRuntime: runtime,
      nativeResponses: true,
      videoMaxRounds: 2,
    });
    expect(await response.text()).toContain("Unable to confirm.");
    expect(submissions).toBe(1);
    expect(store.listVideoJobs()[0]?.state).toBe("acknowledged");

    const outputs = (builtBodies[1]!.input as Record<string, unknown>[])
      .filter(item => item.type === "function_call_output")
      .map(item => JSON.parse(String(item.output)) as Record<string, unknown>);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ ok: false, status: "submission_outcome_unknown" });
    expect(outputs[0]?.jobId).toBeString();
    expect(outputs[1]).toEqual({ ok: false, status: "failed" });
    expect(JSON.stringify(outputs)).not.toContain("provider.invalid");
    expect(JSON.stringify(outputs)).not.toContain("private one");
    expect(JSON.stringify(outputs)).not.toContain("private-video-model");
    const secondTools = builtBodies[1]!.tools as Record<string, unknown>[];
    expect(secondTools.some(tool => tool.name === "video_gen" || tool.name === "generate_video")).toBe(false);
    expect((builtBodies[1]!.input as Record<string, unknown>[])[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "make two videos" }],
    });
  } finally {
    budget.dispose();
    await durableRuntime.shutdown();
    rmSync(join(TEST_HOME, "ambiguous-native.sqlite"), { force: true });
  }
});

test("native replay rejects namespaced, mixed actionable, malformed, and duplicate-id batches before spend", async () => {
  const exactCall = {
    type: "function_call",
    id: "fc_exact",
    call_id: "call_exact",
    name: "video_gen",
    arguments: JSON.stringify({ prompt: "must not dispatch" }),
    status: "completed",
  };
  const cases: Array<{ name: string; output: Record<string, unknown>[] }> = [
    {
      name: "namespaced",
      output: [{ ...exactCall, namespace: "mcp", id: "fc_namespaced", call_id: "call_namespaced" }],
    },
    {
      name: "custom",
      output: [exactCall, { type: "custom_tool_call", id: "custom_unsafe", call_id: "custom_call", name: "shell", input: "pwd" }],
    },
    {
      name: "tool-search",
      output: [exactCall, { type: "tool_search_call", id: "search_unsafe", call_id: "search_call", arguments: "{}" }],
    },
    {
      name: "local-shell",
      output: [exactCall, { type: "local_shell_call", id: "shell_unsafe", call_id: "shell_call", action: { command: "pwd" } }],
    },
    {
      name: "future",
      output: [exactCall, { type: "future_tool_call", id: "future_unsafe", call_id: "future_call" }],
    },
    {
      name: "malformed",
      output: [exactCall, { type: "function_call", id: "malformed_unsafe", name: "video_gen", arguments: "{}" }],
    },
    {
      name: "duplicate",
      output: [exactCall, { ...exactCall, id: "fc_duplicate" }],
    },
    {
      name: "unexposed-alias",
      output: [{ ...exactCall, id: "fc_alias", call_id: "call_alias", name: "generate_video" }],
    },
    {
      name: "namespace-null",
      output: [{ ...exactCall, id: "fc_namespace_null", call_id: "call_namespace_null", namespace: null }],
    },
    {
      name: "future-action",
      output: [exactCall, { type: "computer_action", id: "ca_1", input: "click" }],
    },
    {
      name: "missing-item-id",
      output: [{
        type: "function_call", call_id: "call_missing_id", name: "video_gen",
        arguments: JSON.stringify({ prompt: "must not dispatch" }), status: "completed",
      }],
    },
    {
      name: "missing-status",
      output: [{
        type: "function_call", id: "fc_missing_status", call_id: "call_missing_status",
        name: "video_gen", arguments: JSON.stringify({ prompt: "must not dispatch" }),
      }],
    },
    {
      name: "failed-status",
      output: [{ ...exactCall, id: "fc_failed_status", call_id: "call_failed_status", status: "failed" }],
    },
    {
      name: "duplicate-item-id",
      output: [exactCall, { ...exactCall, call_id: "call_distinct" }],
    },
    {
      name: "duplicate-passive-id",
      output: [exactCall, {
        type: "message", id: exactCall.id, status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "hidden" }],
      }],
    },
    {
      name: "empty-message",
      output: [exactCall, { type: "message", id: "msg_empty", status: "completed", role: "assistant" }],
    },
    {
      name: "empty-reasoning",
      output: [exactCall, { type: "reasoning", id: "rs_empty" }],
    },
  ];
  let submissions = 0;
  const runtime: ModelVideoRuntime = {
    async submitVideo() {
      submissions += 1;
      throw new Error("must not submit unsafe native batches");
    },
    startVideoJob() { throw new Error("must not start unsafe native batches"); },
    getPublicVideoJob() { return null; },
    async waitForVideoUpdate() { return { kind: "missing" }; },
  };

  for (const item of cases) {
    const first = sse([
      ...item.output.map((outputItem, output_index) => ({
        type: "response.output_item.done",
        output_index,
        item: outputItem,
      })),
      {
        type: "response.completed",
        response: { id: `resp_${item.name}`, status: "completed", output: item.output },
      },
    ]);
    const builtBodies: Record<string, unknown>[] = [];
    const budget = createTranslatorBudget();
    try {
      const response = await runResponsesAuxiliaryLoop({
        parsed: parsedRequest(),
        adapter: adapterFor([first], builtBodies),
        incomingMeta: { headers: new Headers(), translatorBudget: budget },
        videoPlan,
        videoRuntime: runtime,
        nativeResponses: true,
        videoMaxRounds: 2,
      });
      const text = await response.text();
      expect(text).toContain(`resp_${item.name}`);
      expect(builtBodies).toHaveLength(1);
    } finally {
      budget.dispose();
    }
  }
  expect(submissions).toBe(0);
});

test("native replay rejects inconsistent or malformed terminal authority before spend", async () => {
  const realCall = {
    type: "function_call",
    id: "fc_real_hidden",
    call_id: "real_1",
    name: "shell",
    arguments: "{}",
    status: "completed",
  };
  const videoCall = {
    type: "function_call",
    id: "fc_video_visible",
    call_id: "vid_1",
    name: "video_gen",
    arguments: JSON.stringify({ prompt: "must not dispatch" }),
    status: "completed",
  };
  const cases: Array<{ name: string; payloads: Array<Record<string, unknown>> }> = [
    {
      name: "inconsistent-call-set",
      payloads: [
        { type: "response.output_item.done", output_index: 0, item: realCall },
        { type: "response.output_item.done", output_index: 1, item: videoCall },
        {
          type: "response.completed",
          response: { id: "resp_inconsistent", status: "completed", output: [videoCall] },
        },
      ],
    },
    {
      name: "conflicting-terminal",
      payloads: [
        { type: "response.output_item.done", output_index: 0, item: videoCall },
        {
          type: "response.completed",
          response: { id: "resp_conflict", status: "completed", output: [videoCall] },
        },
        { type: "response.failed", response: { id: "resp_conflict", status: "failed" } },
      ],
    },
    {
      name: "non-array-output",
      payloads: [
        { type: "response.output_item.done", output_index: 0, item: videoCall },
        {
          type: "response.completed",
          response: { id: "resp_non_array", status: "completed", output: "malformed" },
        },
      ],
    },
    {
      name: "missing-terminal-response",
      payloads: [
        { type: "response.output_item.done", output_index: 0, item: videoCall },
        { type: "response.completed" },
      ],
    },
    {
      name: "failed-completed-status",
      payloads: [
        { type: "response.output_item.done", output_index: 0, item: videoCall },
        {
          type: "response.completed",
          response: { id: "resp_bad_status", status: "failed", output: [videoCall] },
        },
      ],
    },
    {
      name: "missing-completed-status",
      payloads: [
        { type: "response.output_item.done", output_index: 0, item: videoCall },
        { type: "response.completed", response: { id: "resp_missing_status", output: [videoCall] } },
      ],
    },
    {
      name: "namespace-presence-mismatch",
      payloads: [
        { type: "response.output_item.done", output_index: 0, item: { ...videoCall, namespace: null } },
        {
          type: "response.completed",
          response: { id: "resp_namespace_mismatch", status: "completed", output: [videoCall] },
        },
      ],
    },
    {
      name: "hosted-search-action-mismatch",
      payloads: [
        {
          type: "response.output_item.done", output_index: 0,
          item: { type: "web_search_call", id: "ws_mismatch", status: "completed", action: { type: "search", query: "one" } },
        },
        { type: "response.output_item.done", output_index: 1, item: videoCall },
        {
          type: "response.completed",
          response: {
            id: "resp_search_mismatch", status: "completed",
            output: [
              { type: "web_search_call", id: "ws_mismatch", status: "completed", action: { type: "search", query: "two" } },
              videoCall,
            ],
          },
        },
      ],
    },
    {
      name: "hosted-search-malformed-present-queries",
      payloads: [
        {
          type: "response.output_item.done", output_index: 0,
          item: {
            type: "web_search_call", id: "ws_malformed", status: "completed",
            action: { type: "search", query: "valid", queries: [123] },
          },
        },
        { type: "response.output_item.done", output_index: 1, item: videoCall },
        {
          type: "response.completed",
          response: {
            id: "resp_search_malformed", status: "completed",
            output: [
              {
                type: "web_search_call", id: "ws_malformed", status: "completed",
                action: { type: "search", query: "valid", queries: [123] },
              },
              videoCall,
            ],
          },
        },
      ],
    },
    {
      name: "passive-content-mismatch",
      payloads: [
        {
          type: "response.output_item.done", output_index: 0,
          item: {
            type: "message", id: "msg_mismatch", status: "completed", role: "assistant",
            content: [{ type: "output_text", text: "one" }],
          },
        },
        { type: "response.output_item.done", output_index: 1, item: videoCall },
        {
          type: "response.completed",
          response: {
            id: "resp_message_mismatch", status: "completed",
            output: [
              {
                type: "message", id: "msg_mismatch", status: "completed", role: "assistant",
                content: [{ type: "output_text", text: "two" }],
              },
              videoCall,
            ],
          },
        },
      ],
    },
  ];
  let submissions = 0;
  const runtime: ModelVideoRuntime = {
    async submitVideo() {
      submissions += 1;
      throw new Error("inconsistent native output must not submit video");
    },
    startVideoJob() { throw new Error("inconsistent native output must not start video"); },
    getPublicVideoJob() { return null; },
    async waitForVideoUpdate() { return { kind: "missing" }; },
  };
  for (const item of cases) {
    const builtBodies: Record<string, unknown>[] = [];
    const budget = createTranslatorBudget();
    try {
      const response = await runResponsesAuxiliaryLoop({
        parsed: parsedRequest(),
        adapter: adapterFor([sse(item.payloads)], builtBodies),
        incomingMeta: { headers: new Headers(), translatorBudget: budget },
        videoPlan,
        videoRuntime: runtime,
        nativeResponses: true,
        videoMaxRounds: 1,
      });
      await response.text();
      expect(submissions).toBe(0);
      expect(builtBodies).toHaveLength(1);
    } finally {
      budget.dispose();
    }
  }
});

test("native replay rejects malformed or contradictory SSE framing before spend", async () => {
  const videoCall = {
    type: "function_call",
    id: "fc_framing",
    call_id: "call_framing",
    name: "video_gen",
    arguments: JSON.stringify({ prompt: "must not dispatch" }),
    status: "completed",
  };
  const payloads = [
    { type: "response.output_item.done", output_index: 0, item: videoCall },
    {
      type: "response.completed",
      response: { id: "resp_framing", status: "completed", output: [videoCall] },
    },
  ];
  const valid = payloads.map(payload =>
    `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`).join("") + "data: [DONE]\n\n";
  const malformedStreams = [
    `event: response.failed\n\n${valid}`,
    `event: response.failed\ndata: [DONE]\n\n${valid}`,
    `data: not-json\n\n${valid}`,
    `data: {}\n\n${valid}`,
    `data: [DONE]\n\n${valid}`,
    `event: response.completed\ndata: ${JSON.stringify(payloads[1])}\n\nevent: response.output_item.done\ndata: ${JSON.stringify(payloads[0])}\n\ndata: [DONE]\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ ...payloads[0], sequence_number: 5 })}\n\nevent: response.completed\ndata: ${JSON.stringify({ ...payloads[1], sequence_number: 4 })}\n\ndata: [DONE]\n\n`,
    `event: response.failed\ndata: ${JSON.stringify(payloads[1])}\n\ndata: [DONE]\n\n`,
  ];
  let submissions = 0;
  const runtime: ModelVideoRuntime = {
    async submitVideo() {
      submissions += 1;
      throw new Error("malformed SSE must not submit video");
    },
    startVideoJob() { throw new Error("malformed SSE must not start video"); },
    getPublicVideoJob() { return null; },
    async waitForVideoUpdate() { return { kind: "missing" }; },
  };

  for (const raw of malformedStreams) {
    const builtBodies: Record<string, unknown>[] = [];
    const budget = createTranslatorBudget();
    try {
      const response = await runResponsesAuxiliaryLoop({
        parsed: parsedRequest(),
        adapter: adapterFor([
          new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } }),
        ], builtBodies),
        incomingMeta: { headers: new Headers(), translatorBudget: budget },
        videoPlan,
        videoRuntime: runtime,
        nativeResponses: true,
        videoMaxRounds: 1,
      });
      await response.text();
      expect(submissions).toBe(0);
      expect(builtBodies).toHaveLength(1);
    } finally {
      budget.dispose();
    }
  }
});

test("native replay rejects an entire malformed-argument batch before any paid submission", async () => {
  const validCall = {
    type: "function_call",
    id: "fc_valid_batch",
    call_id: "call_valid_batch",
    name: "video_gen",
    arguments: JSON.stringify({ prompt: "must remain undispatched" }),
    status: "completed",
  };
  const invalidCall = {
    type: "function_call",
    id: "fc_invalid_batch",
    call_id: "call_invalid_batch",
    name: "video_gen",
    arguments: "{not-json",
    status: "completed",
  };
  let submissions = 0;
  const runtime: ModelVideoRuntime = {
    async submitVideo() {
      submissions += 1;
      throw new Error("malformed native batch must not submit video");
    },
    startVideoJob() { throw new Error("malformed native batch must not start video"); },
    getPublicVideoJob() { return null; },
    async waitForVideoUpdate() { return { kind: "missing" }; },
  };

  for (const calls of [[validCall, invalidCall], [invalidCall, validCall]]) {
    const builtBodies: Record<string, unknown>[] = [];
    const budget = createTranslatorBudget();
    try {
      const first = sse([
        ...calls.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
        { type: "response.completed", response: { id: "resp_bad_args", status: "completed", output: calls } },
      ]);
      const final = sse([
        { type: "response.completed", response: { id: "resp_after_bad_args", status: "completed", output: [] } },
      ]);
      const response = await runResponsesAuxiliaryLoop({
        parsed: parsedRequest(),
        adapter: adapterFor([first, final], builtBodies),
        incomingMeta: { headers: new Headers(), translatorBudget: budget },
        videoPlan,
        videoRuntime: runtime,
        nativeResponses: true,
        videoMaxRounds: 1,
      });
      await response.text();
      expect(submissions).toBe(0);
      expect(builtBodies).toHaveLength(2);
      const outputs = (builtBodies[1]!.input as Record<string, unknown>[])
        .filter(item => item.type === "function_call_output");
      expect(outputs).toHaveLength(2);
    } finally {
      budget.dispose();
    }
  }
});

test("native replay rejects new item or call ids that collide with replay history before spend", async () => {
  let submissions = 0;
  const runtime: ModelVideoRuntime = {
    async submitVideo() {
      submissions += 1;
      throw new Error("identity-colliding native batch must not submit video");
    },
    startVideoJob() { throw new Error("identity-colliding native batch must not start video"); },
    getPublicVideoJob() { return null; },
    async waitForVideoUpdate() { return { kind: "missing" }; },
  };
  const priorCall = {
    type: "function_call",
    id: "fc_prior",
    call_id: "call_prior",
    name: "real_tool",
    arguments: "{}",
    status: "completed",
  };

  for (const collision of ["item", "call"] as const) {
    const nextCall = {
      type: "function_call",
      id: collision === "item" ? priorCall.id : `fc_new_${collision}`,
      call_id: collision === "call" ? priorCall.call_id : `call_new_${collision}`,
      name: "video_gen",
      arguments: JSON.stringify({ prompt: "must remain undispatched" }),
      status: "completed",
    };
    const first = sse([
      { type: "response.output_item.done", output_index: 0, item: nextCall },
      { type: "response.completed", response: { id: `resp_${collision}_collision`, status: "completed", output: [nextCall] } },
    ]);
    const parsed = parsedRequest();
    const raw = parsed._rawBody as Record<string, unknown>;
    raw.input = [
      priorCall,
      { type: "function_call_output", call_id: priorCall.call_id, output: "{}" },
      ...(raw.input as unknown[]),
    ];
    const builtBodies: Record<string, unknown>[] = [];
    const budget = createTranslatorBudget();
    try {
      const response = await runResponsesAuxiliaryLoop({
        parsed,
        adapter: adapterFor([first], builtBodies),
        incomingMeta: { headers: new Headers(), translatorBudget: budget },
        videoPlan,
        videoRuntime: runtime,
        nativeResponses: true,
        videoMaxRounds: 1,
      });
      await response.text();
      expect(submissions).toBe(0);
      expect(builtBodies).toHaveLength(1);
    } finally {
      budget.dispose();
    }
  }

  const oversizedCallId = "x".repeat(65);
  const repairedAlias = `call_ccx_${createHash("sha256").update(oversizedCallId).digest("hex").slice(0, 55)}`;
  for (const [kind, emittedCallId] of [["raw", oversizedCallId], ["normalized", repairedAlias]] as const) {
    const collisionCall = {
      type: "function_call",
      id: `fc_${kind}_collision`,
      call_id: emittedCallId,
      name: "video_gen",
      arguments: JSON.stringify({ prompt: "must remain undispatched" }),
      status: "completed",
    };
    const parsed = parsedRequest();
    const raw = parsed._rawBody as Record<string, unknown>;
    raw.input = [
      { ...priorCall, id: "fc_oversized_prior", call_id: oversizedCallId },
      { type: "function_call_output", call_id: oversizedCallId, output: "{}" },
      ...(raw.input as unknown[]),
    ];
    const builtBodies: Record<string, unknown>[] = [];
    const budget = createTranslatorBudget();
    try {
      const response = await runResponsesAuxiliaryLoop({
        parsed,
        adapter: adapterFor([sse([
          { type: "response.output_item.done", output_index: 0, item: collisionCall },
          {
            type: "response.completed",
            response: { id: `resp_${kind}_collision`, status: "completed", output: [collisionCall] },
          },
        ])], builtBodies),
        incomingMeta: { headers: new Headers(), translatorBudget: budget },
        videoPlan,
        videoRuntime: runtime,
        nativeResponses: true,
        videoMaxRounds: 1,
      });
      await response.text();
      expect(submissions).toBe(0);
      expect(builtBodies).toHaveLength(1);
    } finally {
      budget.dispose();
    }
  }
});

test("video omit rewrite relaxes required only when no callable declaration remains", () => {
  const onlyVideo = {
    input: [{
      type: "additional_tools",
      tools: [{ type: "function", name: "generate_video", parameters: { type: "object" } }],
    }],
    tool_choice: "required",
  };
  expect(rewriteVideoGenerationForBridge(onlyVideo, "omit", videoPlan.toolNames)).toEqual({
    input: [{ type: "additional_tools", tools: [] }],
    tool_choice: "auto",
  });
  expect(onlyVideo.tool_choice).toBe("required");

  const topLevelReal = {
    tools: [
      { type: "function", name: "video_gen", parameters: { type: "object" } },
      { type: "function", name: "real_tool", parameters: { type: "object" } },
    ],
    tool_choice: "required",
  };
  expect(rewriteVideoGenerationForBridge(topLevelReal, "omit", videoPlan.toolNames)).toEqual({
    tools: [{ type: "function", name: "real_tool", parameters: { type: "object" } }],
    tool_choice: "required",
  });

  const additionalHosted = {
    input: [{
      type: "additional_tools",
      tools: [{ type: "function", name: "video_gen" }, { type: "web_search" }],
    }],
    tool_choice: "required",
  };
  expect(rewriteVideoGenerationForBridge(additionalHosted, "omit", videoPlan.toolNames)).toEqual({
    input: [{ type: "additional_tools", tools: [{ type: "web_search" }] }],
    tool_choice: "required",
  });

  const namespaced = {
    tools: [{ type: "function", namespace: "mcp", name: "video_gen" }],
    input: [{
      type: "additional_tools",
      tools: [{ type: "function", namespace: "mcp", name: "generate_video" }],
    }],
    tool_choice: { type: "function", namespace: "mcp", name: "video_gen" },
  };
  const synthetic = rewriteVideoGenerationForBridge(
    namespaced,
    "synthetic",
    videoPlan.toolNames,
  ) as typeof namespaced & { parallel_tool_calls?: boolean };
  expect(synthetic.tools).toContainEqual({ type: "function", namespace: "mcp", name: "video_gen" });
  expect(synthetic.tools).toContainEqual(expect.objectContaining({ type: "function", name: "video_gen" }));
  expect(synthetic.tools.filter(tool => tool.namespace === undefined && tool.name === "video_gen")).toHaveLength(1);
  expect(synthetic.input[0]?.tools).toEqual([
    { type: "function", namespace: "mcp", name: "generate_video" },
  ]);
  expect(synthetic.tool_choice).toEqual({ type: "function", namespace: "mcp", name: "video_gen" });
  expect(synthetic.parallel_tool_calls).toBe(false);

  const omitted = rewriteVideoGenerationForBridge(
    synthetic,
    "omit",
    videoPlan.toolNames,
  ) as typeof namespaced;
  expect(omitted.tools).toEqual([{ type: "function", namespace: "mcp", name: "video_gen" }]);
  expect(omitted.input).toEqual(namespaced.input);
  expect(omitted.tool_choice).toEqual(namespaced.tool_choice);
});

test("native replay appends exact call/output pairs when the original body omitted input", () => {
  const call = {
    type: "function_call",
    id: "fc_absent",
    call_id: "call_absent",
    name: "video_gen",
    arguments: "{}",
  };
  expect(appendNativeAuxiliaryTurn(
    { model: "gpt-5.6-sol" },
    [call],
    new Map([["call_absent", '{"ok":false,"status":"invalid_request"}']]),
  )).toEqual({
    model: "gpt-5.6-sol",
    input: [
      call,
      {
        type: "function_call_output",
        call_id: "call_absent",
        output: '{"ok":false,"status":"invalid_request"}',
      },
    ],
  });
});

test("native media retries one 429 on the same exact request before key rotation", async () => {
  let bodyReleased = false;
  const rateLimited = new Response(new ReadableStream<Uint8Array>({
    cancel() { bodyReleased = true; },
  }), { status: 429, headers: { "retry-after": "0" } });
  const invalidCall = {
    type: "function_call",
    id: "fc_invalid",
    call_id: "call_invalid",
    name: "video_gen",
    arguments: "{}",
    status: "completed",
  };
  const first = sse([
    { type: "response.output_item.done", output_index: 0, item: invalidCall },
    { type: "response.completed", response: { id: "resp_invalid", status: "completed", output: [invalidCall] } },
  ]);
  const final = sse([
    { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "Invalid request." },
    { type: "response.completed", response: { id: "resp_final", status: "completed", output: [] } },
  ]);
  const upstream = [rateLimited, first, final];
  const fetchedBodies: string[] = [];
  const builtBodies: Record<string, unknown>[] = [];
  const recoveries: Array<string | undefined> = [];
  let rotations = 0;
  let fetches = 0;
  const adapter: ProviderAdapter = {
    name: "openai-responses",
    buildRequest(parsed) {
      builtBodies.push(structuredClone(parsed._rawBody) as Record<string, unknown>);
      return {
        url: "https://native.invalid/responses",
        method: "POST",
        headers: {},
        body: JSON.stringify(parsed._rawBody),
      };
    },
    async fetchResponse(request) {
      fetches += 1;
      fetchedBodies.push(String(request.body));
      if (fetches === 2) expect(bodyReleased).toBe(true);
      const response = upstream.shift();
      if (!response) throw new Error("unexpected extra retry fetch");
      return response;
    },
    async *parseStream() { throw new Error("native replay must remain raw"); },
  };
  const budget = createTranslatorBudget();
  try {
    const response = await runResponsesAuxiliaryLoop({
      parsed: parsedRequest(),
      adapter,
      incomingMeta: { headers: new Headers(), translatorBudget: budget },
      videoPlan,
      nativeResponses: true,
      videoMaxRounds: 1,
      retryOn429Policy: {
        enabled: true,
        attempts: 1,
        intervalMs: 1,
        maxIntervalMs: 1,
        respectRetryAfter: false,
      },
      onAttemptSend: recovery => recoveries.push(recovery),
      on429: () => {
        rotations += 1;
        return null;
      },
    });
    expect(await response.text()).toContain("Invalid request.");
    expect(fetches).toBe(3);
    expect(builtBodies).toHaveLength(2);
    expect(fetchedBodies[0]).toBe(fetchedBodies[1]);
    expect(recoveries).toEqual([undefined, "rate-limit-429", undefined]);
    expect(rotations).toBe(0);
  } finally {
    budget.dispose();
  }
});

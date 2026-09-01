import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAdapter } from "../src/adapters/base";
import type { ImageBridgePlan } from "../src/images/types";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import type { CodexCommanderParsedRequest, CodexCommanderUsage } from "../src/types";
import { registerArtifactPinAuthority } from "../src/images/artifact-retention";
import { pruneArtifacts } from "../src/images/artifacts";

const TEST_HOME = join(import.meta.dir, ".tmp-native-image-replay");
const ARTIFACT = join(TEST_HOME, "artifacts", "native-image.png");
const previousHome = process.env.CODEXCOMMANDER_HOME;
let runResponsesAuxiliaryLoop: typeof import("../src/responses/auxiliary")["runResponsesAuxiliaryLoop"];
let fulfillCalls = 0;
let ambiguousFulfillment = false;
let consumedWithoutArtifact = false;

beforeAll(async () => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(join(TEST_HOME, "artifacts"), { recursive: true });
  writeFileSync(ARTIFACT, "image");
  process.env.CODEXCOMMANDER_HOME = TEST_HOME;
  const actualFulfill = await import("../src/images/fulfill");
  mock.module("../src/images/fulfill", () => ({
    ...actualFulfill,
    fulfillImageCall: async () => {
      fulfillCalls += 1;
      return ambiguousFulfillment
        ? {
            ok: false,
            model: "grok-imagine-image-2.0",
            prompt: "paper fox",
            files: [],
            count: 0,
            error: "submission_outcome_unknown",
            dispatchCertainty: "ambiguous" as const,
          }
        : consumedWithoutArtifact
          ? {
              ok: false,
              model: "grok-imagine-image-2.0",
              prompt: "paper fox",
              files: [],
              count: 0,
              error: "image artifact unavailable after provider completion",
              paidSubmissionConsumed: true,
            }
        : {
            ok: true,
            model: "grok-imagine-image-2.0",
            prompt: "paper fox",
            path: ARTIFACT,
            files: [ARTIFACT],
            count: 1,
            markdown: `![image](file://${ARTIFACT})`,
          };
    },
    imageFulfillmentTailSnapshot: () => ({ currentBytes: 0, highWaterBytes: 0, active: 0 }),
  }));
  ({ runResponsesAuxiliaryLoop } = await import(`../src/responses/auxiliary?native-replay=${Date.now()}`));
});

beforeEach(() => {
  mkdirSync(join(TEST_HOME, "artifacts"), { recursive: true });
  writeFileSync(ARTIFACT, "image");
  fulfillCalls = 0;
  ambiguousFulfillment = false;
  consumedWithoutArtifact = false;
});

afterAll(() => {
  mock.restore();
  rmSync(TEST_HOME, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
});

function sse(payloads: Array<Record<string, unknown>>): Response {
  const text = payloads.map(payload => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`).join("")
    + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("native image bridge replays exact provider items and relays the final native SSE losslessly", async () => {
  const olderPinnedId = "older-native-video.mp4";
  const olderPinned = join(TEST_HOME, "artifacts", olderPinnedId);
  writeFileSync(olderPinned, "video");
  const oldSeconds = (Date.now() - 60_000) / 1_000;
  utimesSync(olderPinned, oldSeconds, oldSeconds);
  const unregisterPin = registerArtifactPinAuthority({
    protectedArtifactIds: () => new Set([olderPinnedId]),
    releaseArtifactForPrune: () => "protected",
  });
  const reasoning = {
    type: "reasoning",
    id: "rs_native",
    encrypted_content: "opaque-native-reasoning",
    summary: [{ type: "summary_text", text: "kept" }],
    provider_extension: { reasoning: true },
  };
  const call = {
    type: "function_call",
    id: "fc_native",
    call_id: "call_native",
    name: "image_gen",
    arguments: "{\"prompt\":\"paper fox\"}",
    status: "completed",
    provider_extension: { lifecycle: "kept" },
  };
  const first = sse([
    { type: "response.created", response: { id: "resp_first", status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...call, status: "in_progress" } },
    { type: "response.function_call_arguments.done", item_id: "fc_native", output_index: 1, arguments: call.arguments },
    { type: "response.output_item.done", output_index: 1, item: call },
    {
      type: "response.completed",
      response: {
        id: "resp_first",
        status: "completed",
        output: [reasoning, call],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    },
  ]);
  const nativeWebEvent = {
    type: "response.web_search_call.in_progress",
    item_id: "ws_native",
    output_index: 0,
    provider_extension: { exact: "preserve-me" },
  };
  const finalResponse = {
    id: "resp_final",
    status: "completed",
    output: [{
      type: "message",
      id: "msg_final",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done", annotations: [] }],
      provider_extension: { message: true },
    }],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    provider_extension: { response: true },
  };
  const second = sse([
    nativeWebEvent,
    { type: "response.output_text.delta", item_id: "msg_final", output_index: 0, content_index: 0, delta: "Done" },
    { type: "response.completed", response: finalResponse },
  ]);

  const builtBodies: Record<string, unknown>[] = [];
  const upstream = [first, second];
  const adapter: ProviderAdapter = {
    name: "openai-responses",
    buildRequest(parsed) {
      builtBodies.push(structuredClone(parsed._rawBody) as Record<string, unknown>);
      return { url: "https://native.invalid/responses", method: "POST", headers: {}, body: "{}" };
    },
    async fetchResponse() {
      const response = upstream.shift();
      if (!response) throw new Error("unexpected extra native iteration");
      if (upstream.length === 0) {
        pruneArtifacts(1);
        expect(existsSync(ARTIFACT)).toBe(true);
      }
      return response;
    },
    async *parseStream() {
      throw new Error("native raw replay must not use lossy AdapterEvent translation");
    },
  };
  const parsed: CodexCommanderParsedRequest = {
    modelId: "gpt-5.6-sol",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
    _rawBody: {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "draw a paper fox" }] }],
      tools: [{ type: "web_search" }, { type: "image_generation", size: "1024x1024" }],
      stream: true,
      provider_extension: { request: true },
    },
  };
  const plan: ImageBridgePlan = {
    auth: {
      authSource: "api_key",
      providerKind: "canonical",
      slotRef: "media-slot:test",
      identityDigest: "sha256:test",
    },
    model: "grok-imagine-image-2.0",
    toolNames: new Set(["image_generation", "image_gen"]),
    artifactsKeepCount: 1,
  };
  let usage: CodexCommanderUsage | undefined;
  let completed: Record<string, unknown> | undefined;
  const budget = createTranslatorBudget();
  try {
    const response = await runResponsesAuxiliaryLoop({
      parsed,
      adapter,
      incomingMeta: { headers: new Headers(), translatorBudget: budget },
      plan,
      nativeResponses: true,
      imageMaxRounds: 2,
      onUsage: value => { usage = value; },
      onCompletedResponse: value => { completed = value; },
    });
    const text = await response.text();

    expect(text).toContain(JSON.stringify(nativeWebEvent));
    expect(text).toContain("preserve-me");
    expect(text).toContain("provider_extension");
    expect(text).not.toContain("fc_native");
    expect(text).toContain('"usage":{"input_tokens":15,"output_tokens":7,"total_tokens":22}');
    expect(text).toContain("![image](/v1/codexcommander/artifacts/native-image.png)");
    expect(text.indexOf("response.output_item.added")).toBeLessThan(text.indexOf("response.completed"));
    expect(builtBodies).toHaveLength(2);
    expect(builtBodies[0]!.provider_extension).toEqual({ request: true });
    expect(builtBodies[0]!.tools).toContainEqual(expect.objectContaining({ type: "function", name: "image_gen" }));

    const replayInput = builtBodies[1]!.input as Record<string, unknown>[];
    expect(replayInput.slice(-3)).toEqual([
      reasoning,
      call,
      {
        type: "function_call_output",
        call_id: "call_native",
        output: JSON.stringify({
          ok: true,
          status: "completed",
          artifacts: ["/v1/codexcommander/artifacts/native-image.png"],
          markdown: "![image](/v1/codexcommander/artifacts/native-image.png)",
        }),
      },
    ]);
    const upstreamToolResult = String(replayInput.at(-1)?.output ?? "");
    expect(upstreamToolResult).not.toContain(TEST_HOME);
    expect(upstreamToolResult).not.toContain("/Users/");
    expect(upstreamToolResult).not.toContain('"path"');
    expect(upstreamToolResult).not.toContain('"files"');
    expect(upstreamToolResult).not.toContain("paper fox");
    expect(upstreamToolResult).not.toContain("grok-imagine-image-2.0");
    expect(usage).toMatchObject({ inputTokens: 15, outputTokens: 7 });
    expect(completed).toMatchObject({
      id: "resp_final",
      provider_extension: { response: true },
      output: [
        expect.objectContaining({ id: "msg_final" }),
        expect.objectContaining({
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{
            type: "output_text",
            text: "![image](/v1/codexcommander/artifacts/native-image.png)",
            annotations: [],
          }],
        }),
      ],
    });
  } finally {
    unregisterPin();
    budget.dispose();
  }
});

test("an ambiguous native image POST removes image availability and blocks a second paid call", async () => {
  ambiguousFulfillment = true;
  const calls = ["one", "two"].map((suffix, index) => ({
    type: "function_call",
    id: `fc_${suffix}`,
    call_id: `call_${suffix}`,
    name: "image_gen",
    arguments: JSON.stringify({ prompt: index === 0 ? "paper fox" : "must not dispatch" }),
    status: "completed",
  }));
  const first = sse([
    ...calls.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    {
      type: "response.completed",
      response: { id: "resp_ambiguous", status: "completed", output: calls },
    },
  ]);
  const second = sse([
    {
      type: "response.output_text.delta",
      item_id: "msg_final",
      output_index: 0,
      content_index: 0,
      delta: "The submission outcome is unknown.",
    },
    {
      type: "response.completed",
      response: {
        id: "resp_final",
        status: "completed",
        output: [{
          type: "message",
          id: "msg_final",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "The submission outcome is unknown.", annotations: [] }],
        }],
      },
    },
  ]);
  const builtBodies: Record<string, unknown>[] = [];
  const upstream = [first, second];
  const adapter: ProviderAdapter = {
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
  const parsed: CodexCommanderParsedRequest = {
    modelId: "gpt-5.6-sol",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
    _rawBody: {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "draw" }] }],
      tools: [{ type: "image_generation" }],
      stream: true,
    },
  };
  const plan: ImageBridgePlan = {
    auth: {
      authSource: "api_key",
      providerKind: "canonical",
      slotRef: "media-slot:test",
      identityDigest: "sha256:test",
    },
    model: "grok-imagine-image-2.0",
    toolNames: new Set(["image_generation", "image_gen"]),
  };
  const budget = createTranslatorBudget();
  try {
    const response = await runResponsesAuxiliaryLoop({
      parsed,
      adapter,
      incomingMeta: { headers: new Headers(), translatorBudget: budget },
      plan,
      nativeResponses: true,
      imageMaxRounds: 2,
    });
    const text = await response.text();

    expect(text).toContain("The submission outcome is unknown.");
    expect(fulfillCalls).toBe(1);
    expect(builtBodies).toHaveLength(2);
    expect(builtBodies[1]!.tools).toEqual([]);
    const replayText = JSON.stringify(builtBodies[1]!.input);
    expect(replayText).toContain("submission_outcome_unknown");
    expect(replayText).not.toContain("disabled for the rest of this turn");
    expect(replayText).not.toContain('"path"');
    expect(replayText).not.toContain('"files"');
  } finally {
    budget.dispose();
  }
});

test("known-success paid POST with no artifact is not replayed by the native bridge", async () => {
  consumedWithoutArtifact = true;
  const call = {
    type: "function_call",
    id: "fc_consumed",
    call_id: "call_consumed",
    name: "image_gen",
    arguments: JSON.stringify({ prompt: "paper fox" }),
    status: "completed",
  };
  const first = sse([
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { id: "resp_consumed", status: "completed", output: [call] } },
  ]);
  const second = sse([
    {
      type: "response.output_text.delta",
      item_id: "msg_final",
      output_index: 0,
      content_index: 0,
      delta: "The paid image could not be stored.",
    },
    {
      type: "response.completed",
      response: {
        id: "resp_final",
        status: "completed",
        output: [{
          type: "message",
          id: "msg_final",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "The paid image could not be stored.", annotations: [] }],
        }],
      },
    },
  ]);
  const builtBodies: Record<string, unknown>[] = [];
  const upstream = [first, second];
  const adapter: ProviderAdapter = {
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
  const parsed: CodexCommanderParsedRequest = {
    modelId: "gpt-5.6-sol",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
    _rawBody: {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "draw" }] }],
      tools: [{ type: "image_generation" }],
      stream: true,
    },
  };
  const plan: ImageBridgePlan = {
    auth: {
      authSource: "api_key",
      providerKind: "canonical",
      slotRef: "media-slot:test",
      identityDigest: "sha256:test",
    },
    model: "grok-imagine-image-2.0",
    toolNames: new Set(["image_generation", "image_gen"]),
  };
  const budget = createTranslatorBudget();
  try {
    const response = await runResponsesAuxiliaryLoop({
      parsed,
      adapter,
      incomingMeta: { headers: new Headers(), translatorBudget: budget },
      plan,
      nativeResponses: true,
      imageMaxRounds: 3,
    });
    expect(await response.text()).toContain("could not be stored");
    expect(fulfillCalls).toBe(1);
    expect(builtBodies).toHaveLength(2);
    expect(builtBodies[1]!.tools).toEqual([]);
    const replayInput = builtBodies[1]!.input as Array<{ type?: string; output?: string }>;
    const replayOutput = replayInput.find(item => item.type === "function_call_output")?.output;
    expect(JSON.parse(String(replayOutput))).toEqual({ ok: false, status: "artifact_unavailable" });
    const replay = JSON.stringify(replayInput);
    expect(replay).not.toContain("paidSubmissionConsumed");
    expect(replay).not.toContain("provider completion");
  } finally {
    budget.dispose();
  }
});

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAdapter } from "../src/adapters/base";
import type { ImageBridgePlan } from "../src/images/types";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import type { CodexCommanderParsedRequest, CodexCommanderUsage } from "../src/types";

const TEST_HOME = join(import.meta.dir, ".tmp-native-image-replay");
const ARTIFACT = join(TEST_HOME, "artifacts", "native-image.png");
const previousHome = process.env.CODEXCOMMANDER_HOME;
let runResponsesAuxiliaryLoop: typeof import("../src/responses/auxiliary")["runResponsesAuxiliaryLoop"];

beforeAll(async () => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(join(TEST_HOME, "artifacts"), { recursive: true });
  writeFileSync(ARTIFACT, "image");
  process.env.CODEXCOMMANDER_HOME = TEST_HOME;
  mock.module("../src/images/fulfill", () => ({
    fulfillImageCall: async () => ({
      ok: true,
      model: "grok-imagine-image-2.0",
      prompt: "paper fox",
      path: ARTIFACT,
      files: [ARTIFACT],
      count: 1,
      markdown: `![image](file://${ARTIFACT})`,
    }),
  }));
  ({ runResponsesAuxiliaryLoop } = await import(`../src/responses/auxiliary?native-replay=${Date.now()}`));
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
    expect(builtBodies).toHaveLength(2);
    expect(builtBodies[0]!.provider_extension).toEqual({ request: true });
    expect(builtBodies[0]!.tools).toContainEqual(expect.objectContaining({ type: "function", name: "image_gen" }));

    const replayInput = builtBodies[1]!.input as Record<string, unknown>[];
    expect(replayInput.slice(-3)).toEqual([
      reasoning,
      call,
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call_native",
        output: expect.stringContaining("grok-imagine-image-2.0"),
      }),
    ]);
    expect(usage).toMatchObject({ inputTokens: 15, outputTokens: 7 });
    expect(completed).toMatchObject({ id: "resp_final", provider_extension: { response: true } });
  } finally {
    budget.dispose();
  }
});

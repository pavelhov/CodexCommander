import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { ProviderAdapter } from "../src/adapters/base";
import { rewriteVideoGenerationForBridge } from "../src/adapters/openai-responses";
import type { ModelVideoRuntime } from "../src/images/media-runtime";
import type { ImageBridgePlan, VideoBridgePlan } from "../src/images/types";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import {
  appendNativeAuxiliaryTurn,
  finalizeNativeResponsesSse,
} from "../src/responses/auxiliary/native-replay";
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

const PRIVATE_UPSTREAM_FAILURE = [
  "provider-body-marker-must-not-reach-client",
  "https://storage.example.invalid/private/output.mp4?X-Amz-Signature=signed-url-secret",
  "/" + ["Users", "private-account", "workspace", "secret.txt"].join("/"),
  "owner@example.test",
  "acct_private_123456",
].join(" ");

function expectPrivateUpstreamFailureAbsent(clientText: string): void {
  for (const fragment of PRIVATE_UPSTREAM_FAILURE.split(" ")) {
    expect(clientText).not.toContain(fragment);
  }
}

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

test("native pre-header failures never reflect upstream response bodies", async () => {
  const budget = createTranslatorBudget();
  try {
    const response = await runResponsesAuxiliaryLoop({
      parsed: parsedRequest(),
      adapter: adapterFor([new Response(PRIVATE_UPSTREAM_FAILURE, { status: 418 })], []),
      incomingMeta: { headers: new Headers(), translatorBudget: budget },
      videoPlan,
      nativeResponses: true,
      videoMaxRounds: 1,
    });
    const body = await response.text();

    expect(response.status).toBe(418);
    expect(JSON.parse(body)).toEqual({
      error: {
        message: "Provider rejected the auxiliary request (status 418)",
        type: "upstream_error",
        code: null,
      },
    });
    expectPrivateUpstreamFailureAbsent(body);
  } finally {
    budget.dispose();
  }
});

test("native in-stream failures never reflect upstream response bodies", async () => {
  const invalidCall = {
    type: "function_call",
    id: "fc_private_failure",
    call_id: "call_private_failure",
    name: "video_gen",
    arguments: "{}",
    status: "completed",
  };
  const first = sse([
    { type: "response.output_item.done", output_index: 0, item: invalidCall },
    {
      type: "response.completed",
      response: { id: "resp_private_failure", status: "completed", output: [invalidCall] },
    },
  ]);
  const budget = createTranslatorBudget();
  try {
    const response = await runResponsesAuxiliaryLoop({
      parsed: parsedRequest(),
      adapter: adapterFor([first, new Response(PRIVATE_UPSTREAM_FAILURE, { status: 503 })], []),
      incomingMeta: { headers: new Headers(), translatorBudget: budget },
      videoPlan,
      nativeResponses: true,
      videoMaxRounds: 1,
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("event: response.failed");
    expect(body).toContain('"type":"server_error"');
    expect(body).toContain('"code":"upstream_server_error"');
    expect(body).toContain('"message":"Provider auxiliary stream failed"');
    expectPrivateUpstreamFailureAbsent(body);
  } finally {
    budget.dispose();
  }
});

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
    output: [{
      type: "message",
      id: "msg_final",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Video ready", annotations: [] }],
    }],
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
      videoOperationIdentity: {
        operationKey: `hmac-sha256:${"9".repeat(64)}`,
        requestSemanticsDigest: `hmac-sha256:${"8".repeat(64)}`,
      },
      nativeResponses: true,
      imageMaxRounds: 2,
      videoMaxRounds: 2,
    });
    const text = await response.text();

    expect(text).toContain(JSON.stringify(finalExtension));
    expect(text).not.toContain("fc_video");
    expect(text).toContain('"usage":{"input_tokens":14,"output_tokens":6,"total_tokens":20}');
    expect(text).toContain(`[Open video](/v1/codexcommander/artifacts/${ARTIFACT_ID})`);
    expect(submitInput?.request).toEqual({
      prompt: "private prompt sentinel",
      model: "private-video-model",
      duration: 3,
      resolution: "720p",
      aspectRatio: "16:9",
    });
    expect(submitInput?.operationKey).toBe(`hmac-sha256:${"9".repeat(64)}`);
    expect(submitInput?.requestSemanticsDigest).toBe(`hmac-sha256:${"8".repeat(64)}`);
    expect(startedJob).toBeUndefined();
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

test("native completed-artifact finalizer injects one ordered lifecycle and patches terminal authority", () => {
  const imageUrl = "/v1/codexcommander/artifacts/already-visible.png";
  const videoUrl = "/v1/codexcommander/artifacts/final-video.webm";
  const secondImageUrl = "/v1/codexcommander/artifacts/second-image.jpg";
  const firstMessage = {
    type: "message",
    id: "msg_ccx_completed_artifacts",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: `Existing ${imageUrl}`, annotations: [] }],
  };
  const collision = {
    type: "reasoning",
    id: "msg_ccx_completed_artifacts_2",
    status: "completed",
    summary: [{ type: "summary_text", text: "kept" }],
  };
  const preserved = `event: response.provider_extension\r\ndata: ${JSON.stringify({
    type: "response.provider_extension",
    sequence_number: 8,
    provider_extension: { exact: true, internal_url: videoUrl },
  })}\r\n\r\n`;
  const terminal = {
    type: "response.completed",
    sequence_number: 9,
    provider_extension: { terminal: "kept" },
    response: {
      id: "resp_artifacts",
      status: "completed",
      output: [firstMessage, collision],
      provider_extension: { internal_url: videoUrl },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  };
  const raw = `event: response.output_item.done\r\ndata: ${JSON.stringify({
    type: "response.output_item.done", sequence_number: 7, output_index: 0, item: firstMessage,
  })}\r\n\r\n${preserved}event: response.completed\r\ndata: ${JSON.stringify(terminal)}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const completedArtifact = {
    kind: "video" as const,
    url: videoUrl,
    prompt: "private prompt must not render",
    model: "private model must not render",
    path: "/private/artifacts/final-video.webm",
    jobId: "private-job-id",
    markdown: "[arbitrary](https://signed.invalid/private)",
  };

  const finalized = finalizeNativeResponsesSse(raw, {
    inputTokens: 4,
    outputTokens: 3,
  }, [
    { kind: "image", url: imageUrl },
    { kind: "image", url: imageUrl },
    completedArtifact,
    { kind: "image", url: secondImageUrl },
    { kind: "image", url: videoUrl },
    { kind: "video", url: "https://signed.invalid/private.mp4?token=secret" },
    { kind: "video", url: "/v1/codexcommander/artifacts/../../private.mp4" },
  ]);

  expect(finalized.raw).toContain(preserved);
  expect(finalized.raw.endsWith("data: [DONE]\r\n\r\n")).toBe(true);
  expect(finalized.raw).not.toContain("signed.invalid");
  expect(finalized.raw).not.toContain("token=secret");
  expect(finalized.raw).not.toContain("private prompt must not render");
  expect(finalized.raw).not.toContain("private model must not render");
  expect(finalized.raw).not.toContain("private-job-id");
  expect(finalized.raw).not.toContain("/private/artifacts");
  const payloads = finalized.raw.split(/\r\n\r\n/).flatMap(frame => {
    const data = frame.split("\r\n").filter(line => line.startsWith("data: "));
    if (data.length !== 1 || data[0] === "data: [DONE]") return [];
    return [JSON.parse(data[0]!.slice(6)) as Record<string, unknown>];
  });
  const types = payloads.map(payload => payload.type);
  expect(types.slice(-7)).toEqual([
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  expect(payloads.slice(-7).map(payload => payload.sequence_number)).toEqual([9, 10, 11, 12, 13, 14, 15]);
  for (const payload of payloads.slice(-7, -1)) expect(payload.output_index).toBe(2);
  const added = payloads.at(-7)?.item as Record<string, unknown>;
  const done = payloads.at(-2)?.item as Record<string, unknown>;
  expect(added.id).toBe("msg_ccx_completed_artifacts_3");
  expect(done).toMatchObject({
    id: "msg_ccx_completed_artifacts_3",
    status: "completed",
    content: [{
      type: "output_text",
      text: `[Open video](${videoUrl})\n\n![image](${secondImageUrl})`,
      annotations: [],
    }],
  });
  expect(finalized.completedResponse).toMatchObject({
    id: "resp_artifacts",
    provider_extension: { internal_url: videoUrl },
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
  });
  expect((finalized.completedResponse?.output as unknown[])).toHaveLength(3);
});

test("native completed-artifact finalizer bounds sequence allocation at MAX_SAFE_INTEGER", () => {
  const artifact = {
    kind: "video" as const,
    url: "/v1/codexcommander/artifacts/sequence-boundary.mp4",
  };
  const rawWithTerminalSequence = (sequenceNumber: number) => {
    const terminal = {
      type: "response.completed",
      sequence_number: sequenceNumber,
      response: { id: "resp_sequence_boundary", status: "completed", output: [] },
    };
    return `event: response.completed\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`;
  };
  const payloads = (raw: string) => raw.split(/\r?\n\r?\n/).flatMap(frame => {
    const line = frame.split(/\r?\n/).find(value => value.startsWith("data: "));
    if (!line || line === "data: [DONE]") return [];
    return [JSON.parse(line.slice(6)) as Record<string, unknown>];
  });

  // Six lifecycle events plus the patched terminal consume exactly the final seven safe integers.
  const lastSafeFirst = Number.MAX_SAFE_INTEGER - 6;
  const exactBoundary = finalizeNativeResponsesSse(
    rawWithTerminalSequence(lastSafeFirst),
    undefined,
    [artifact],
  );
  const exactPayloads = payloads(exactBoundary.raw);
  expect(exactPayloads.map(payload => payload.sequence_number)).toEqual([
    lastSafeFirst,
    lastSafeFirst + 1,
    lastSafeFirst + 2,
    lastSafeFirst + 3,
    lastSafeFirst + 4,
    lastSafeFirst + 5,
    Number.MAX_SAFE_INTEGER,
  ]);
  expect(new Set(exactPayloads.map(payload => payload.sequence_number)).size).toBe(7);
  expect(exactBoundary.raw).toContain(artifact.url);
  expect((exactBoundary.completedResponse?.output as unknown[])).toHaveLength(1);

  // One fewer available slot must leave the authoritative provider stream byte-identical.
  const exhaustedRaw = rawWithTerminalSequence(lastSafeFirst + 1);
  const exhausted = finalizeNativeResponsesSse(exhaustedRaw, undefined, [artifact]);
  expect(exhausted.raw).toBe(exhaustedRaw);
  expect(exhausted.raw).not.toContain(artifact.url);
  expect(exhausted.completedResponse?.output).toEqual([]);

  // A sequence-less terminal cannot allocate after an upstream event already used the maximum.
  const priorMaxRaw = [
    `event: response.provider_extension\ndata: ${JSON.stringify({
      type: "response.provider_extension",
      sequence_number: Number.MAX_SAFE_INTEGER,
      provider_extension: { kept: true },
    })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_prior_max", status: "completed", output: [] },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  const priorMax = finalizeNativeResponsesSse(priorMaxRaw, undefined, [artifact]);
  expect(priorMax.raw).toBe(priorMaxRaw);
  expect(priorMax.raw).not.toContain(artifact.url);
  expect(priorMax.completedResponse?.output).toEqual([]);
});

test("native completed-artifact finalizer fails closed on non-completed or malformed authority", () => {
  const artifact = { kind: "video" as const, url: "/v1/codexcommander/artifacts/must-not-render.mp4" };
  const cases = [
    [
      { type: "response.incomplete", response: { id: "incomplete", status: "incomplete", output: [] } },
    ],
    [
      { type: "response.failed", response: { id: "failed", status: "failed", output: [] } },
    ],
    [
      { type: "response.completed", response: { id: "bad-status", status: "failed", output: [] } },
    ],
    [
      { type: "response.completed", response: { id: "bad-output", status: "completed", output: "private-path" } },
    ],
    [
      {
        type: "response.output_text.delta", item_id: "msg", output_index: -1,
        content_index: 0, delta: "malformed index",
      },
      { type: "response.completed", response: { id: "bad-index", status: "completed", output: [] } },
    ],
    [
      { type: "response.completed", response: { id: "conflict", status: "completed", output: [] } },
      { type: "response.failed", response: { id: "conflict", status: "failed", output: [] } },
    ],
  ];
  for (const events of cases) {
    const raw = events.map(payload =>
      `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`).join("") + "data: [DONE]\n\n";
    const finalized = finalizeNativeResponsesSse(raw, undefined, [artifact]);
    expect(finalized.raw).toBe(raw);
    expect(finalized.raw).not.toContain(artifact.url);
    expect(finalized.completedResponse).toBeUndefined();
  }
  const malformed = `data: not-json\n\nevent: response.completed\ndata: ${JSON.stringify({
    type: "response.completed", response: { id: "malformed", status: "completed", output: [] },
  })}\n\ndata: [DONE]\n\n`;
  expect(finalizeNativeResponsesSse(malformed, undefined, [artifact]).raw).toBe(malformed);
});

test("native completed-artifact finalizer rejects sparse or mismatched output-index authority", () => {
  const artifact = { kind: "video" as const, url: "/v1/codexcommander/artifacts/final-video.mp4" };
  const terminalItem = {
    type: "message",
    id: "msg_terminal",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Done", annotations: [] }],
  };
  const terminal = {
    type: "response.completed",
    response: { id: "resp", status: "completed", output: [terminalItem] },
  };
  const rawWith = (outputIndex: number, itemId: string) => [
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: outputIndex,
      item: { ...terminalItem, id: itemId },
    })}`,
    `event: response.completed\ndata: ${JSON.stringify(terminal)}`,
    "data: [DONE]",
    "",
  ].join("\n\n");

  const sparse = rawWith(8, terminalItem.id);
  expect(finalizeNativeResponsesSse(sparse, undefined, [artifact])).toEqual({ raw: sparse });
  const mismatched = rawWith(0, "msg_other");
  expect(finalizeNativeResponsesSse(mismatched, undefined, [artifact])).toEqual({ raw: mismatched });
});

test("native completed-artifact finalizer dedupes only visible assistant text", () => {
  const url = "/v1/codexcommander/artifacts/visibility.png";
  const reasoningPayload = {
    type: "response.completed",
    response: {
      id: "reasoning_only",
      status: "completed",
      output: [{
        type: "reasoning",
        id: "rs_private",
        status: "completed",
        summary: [{ type: "summary_text", text: `internal ${url}` }],
      }],
    },
  };
  const reasoningOnly = `event: response.completed\ndata: ${JSON.stringify(reasoningPayload)}\n\ndata: [DONE]\n\n`;
  const rendered = finalizeNativeResponsesSse(reasoningOnly, undefined, [{ kind: "image", url }]);
  expect(rendered.raw).toContain(`![image](${url})`);

  const visiblePayload = {
    type: "response.completed",
    response: {
      id: "assistant_visible",
      status: "completed",
      output: [{
        type: "message",
        id: "msg_visible",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: `Already here: ${url}`, annotations: [] }],
      }],
    },
  };
  const visibleRaw = `event: response.completed\ndata: ${JSON.stringify(visiblePayload)}\n\ndata: [DONE]\n\n`;
  expect(finalizeNativeResponsesSse(visibleRaw, undefined, [{ kind: "image", url }]).raw).toBe(visibleRaw);
});

test("native busy and detached video results never synthesize artifact delivery", async () => {
  const call = {
    type: "function_call",
    id: "fc_nonterminal_video",
    call_id: "call_nonterminal_video",
    name: "video_gen",
    arguments: JSON.stringify({ prompt: "private nonterminal prompt" }),
    status: "completed",
  };
  const first = sse([
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { id: "resp_call", status: "completed", output: [call] } },
  ]);
  const final = sse([
    { type: "response.completed", response: { id: "resp_final", status: "completed", output: [] } },
  ]);
  const now = Date.now();
  for (const mode of ["busy", "detached"] as const) {
    const builtBodies: Record<string, unknown>[] = [];
    const job = {
      id: `job_${mode}`,
      revision: 1,
      state: "accepted" as const,
      deadlineAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    };
    const runtime: ModelVideoRuntime = {
      async submitVideo() {
        return mode === "busy"
          ? { kind: "busy", reservationId: "reservation_busy", job }
          : { kind: "accepted", job };
      },
      startVideoJob() {},
      getPublicVideoJob() { return null; },
      async waitForVideoUpdate() { return { kind: "detached", job }; },
    };
    const budget = createTranslatorBudget();
    try {
      const response = await runResponsesAuxiliaryLoop({
        parsed: parsedRequest(),
        adapter: adapterFor([first.clone(), final.clone()], builtBodies),
        incomingMeta: { headers: new Headers(), translatorBudget: budget },
        videoPlan,
        videoRuntime: runtime,
        nativeResponses: true,
        videoMaxRounds: 1,
      });
      const raw = await response.text();
      expect(raw).not.toContain("/v1/codexcommander/artifacts/");
      expect(raw).not.toContain("[Open video]");
      const output = (builtBodies[1]!.input as Record<string, unknown>[])
        .find(item => item.type === "function_call_output")?.output;
      expect(JSON.parse(String(output))).toMatchObject({ ok: false, status: mode });
    } finally {
      budget.dispose();
    }
  }
});

test("native replay rejects a multi-video batch before any paid submission", async () => {
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

  let submissions = 0;
  const runtime: ModelVideoRuntime = {
    async submitVideo() {
      submissions += 1;
      throw new Error("multi-video batch must not submit");
    },
    startVideoJob() { throw new Error("multi-video batch must not start"); },
    getPublicVideoJob() { return null; },
    async waitForVideoUpdate() { return { kind: "missing" }; },
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
      videoMaxRounds: 1,
    });
    expect(await response.text()).toContain("Unable to confirm.");
    expect(submissions).toBe(0);

    const outputs = (builtBodies[1]!.input as Record<string, unknown>[])
      .filter(item => item.type === "function_call_output")
      .map(item => JSON.parse(String(item.output)) as Record<string, unknown>);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toEqual({ ok: false, status: "failed" });
    expect(outputs[1]).toEqual({ ok: false, status: "failed" });
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
  }
});

test("native replay rejects image-budget overflow before an earlier video can submit", async () => {
  const videoCall = {
    type: "function_call",
    id: "fc_budget_video",
    call_id: "call_budget_video",
    name: "video_gen",
    arguments: JSON.stringify({ prompt: "must not dispatch" }),
    status: "completed",
  };
  const imageCalls = Array.from({ length: 11 }, (_, index) => ({
    type: "function_call",
    id: `fc_budget_image_${index}`,
    call_id: `call_budget_image_${index}`,
    name: "image_gen",
    arguments: JSON.stringify({ prompt: `private image ${index}` }),
    status: "completed",
  }));
  const calls = [videoCall, ...imageCalls];
  const first = sse([
    ...calls.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    { type: "response.completed", response: { id: "resp_budget_batch", status: "completed", output: calls } },
  ]);
  const second = sse([
    { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "Budget rejected." },
    { type: "response.completed", response: { id: "resp_budget_final", status: "completed", output: [] } },
  ]);
  let submissions = 0;
  const abort = new AbortController();
  const runtime: ModelVideoRuntime = {
    async submitVideo() {
      submissions += 1;
      abort.abort();
      throw new Error("budget preflight must run before video submission");
    },
    startVideoJob() { throw new Error("budget-overflow batch must not start"); },
    getPublicVideoJob() { return null; },
    async waitForVideoUpdate() { return { kind: "missing" }; },
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
      abortSignal: abort.signal,
      nativeResponses: true,
      imageMaxRounds: 1,
      videoMaxRounds: 1,
    });
    expect(await response.text()).toContain("Budget rejected.");
    expect(submissions).toBe(0);
    expect(builtBodies).toHaveLength(2);
  } finally {
    budget.dispose();
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

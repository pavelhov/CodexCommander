import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import {
  appendNativeAuxiliaryReplay,
  deriveAuxiliaryGlobalCeiling,
  nativeAuxiliaryReplayPair,
  runResponsesAuxiliaryLoop,
  scanAuxiliaryToolCalls,
} from "../src/responses/auxiliary";
import type { AdapterEvent, CodexCommanderParsedRequest } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const PRIVATE_ERROR_MATERIAL = [
  ["Author", "ization: Be", "arer fixture", "-private-terminal-value"].join(""),
  "prompt=private castle prompt",
  "/" + ["Users", "private", "work", "secret.txt"].join("/"),
  "https://media.example.invalid/output.mp4?X-Amz-" + "Signature=private-signature",
].join(" ");

function parsedAuxiliaryRequest(): CodexCommanderParsedRequest {
  return {
    modelId: "auxiliary-error-fixture",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
  } as CodexCommanderParsedRequest;
}

function requestFixtureAdapter(overrides: Partial<ProviderAdapter>): ProviderAdapter {
  return {
    name: "auxiliary-error-fixture",
    buildRequest() {
      return { url: "https://model.invalid/v1/chat", method: "POST", headers: {}, body: "{}" };
    },
    async fetchResponse() {
      return new Response("{}", { status: 200 });
    },
    async *parseStream() {
      yield { type: "done" };
    },
    ...overrides,
  };
}

describe("Responses auxiliary coordinator", () => {
  test("derives one global runaway ceiling without cross-reducing handler allowances", () => {
    expect(deriveAuxiliaryGlobalCeiling({ webSearch: 3, image: 4, video: 2 })).toBe(11);
    expect(deriveAuxiliaryGlobalCeiling({ webSearch: 0, image: 4, video: 2 })).toBe(8);
    expect(deriveAuxiliaryGlobalCeiling({ webSearch: 3, image: 0, video: 0 })).toBe(5);
  });

  test("clamps every handler independently and preserves zero semantics", () => {
    expect(deriveAuxiliaryGlobalCeiling({ webSearch: -1, image: 10_000, video: Number.NaN })).toBe(12);
  });

  test("intercepts exact unnamespaced aliases and forwards namespaced real tools", () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "img", name: "image_gen" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "real", name: "mcp__studio__video_gen" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    const split = scanAuxiliaryToolCalls(events, {
      image: new Set(["image_gen"]),
      video: new Set(["video_gen"]),
      webSearch: true,
    });
    expect(split.calls).toEqual([{ id: "img", name: "image_gen", args: "{}", handler: "image" }]);
    expect(split.hasRealToolCall).toBe(true);
    expect(split.passthrough.filter(event => event.type.startsWith("tool_call"))).toHaveLength(3);
  });

  test("marks unterminated, orphaned, duplicate, and empty-id tool framing malformed", () => {
    const names = {
      image: new Set(["image_gen"]),
      video: new Set(["video_gen"]),
      webSearch: true,
    };
    const cases: AdapterEvent[][] = [
      [
        { type: "tool_call_start", id: "unfinished", name: "video_gen" },
        { type: "tool_call_delta", arguments: '{"prompt":"x"}' },
        { type: "done" },
      ],
      [{ type: "tool_call_delta", arguments: "{}" }, { type: "done" }],
      [{ type: "tool_call_end" }, { type: "done" }],
      [
        { type: "tool_call_start", id: "duplicate", name: "video_gen" },
        { type: "tool_call_end" },
        { type: "tool_call_start", id: "duplicate", name: "image_gen" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
      [
        { type: "tool_call_start", id: "", name: "video_gen" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
      [
        { type: "tool_call_start", id: "   ", name: "video_gen" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    ];
    for (const events of cases) {
      expect(scanAuxiliaryToolCalls(events, names).malformedSyntheticCall).toBe(true);
    }
    expect(scanAuxiliaryToolCalls([
      { type: "tool_call_start", id: "historical", name: "video_gen" },
      { type: "tool_call_end" },
      { type: "done" },
    ], names, new Set(["historical"])).malformedSyntheticCall).toBe(true);
  });

  test("native replay preserves reasoning and exact function-call fields", () => {
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "video_gen",
      arguments: '{"prompt":"paper boat"}',
      status: "completed",
      provider_extension: { keep: true },
    };
    const pair = nativeAuxiliaryReplayPair(call, '{"ok":true}');
    expect(pair?.call).toEqual(call);
    const replayed = appendNativeAuxiliaryReplay({
      input: [{ type: "reasoning", id: "rs_1", encrypted_content: "opaque" }],
    }, pair ? [pair] : []) as { input: unknown[] };
    expect(replayed.input).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
      call,
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
    ]);
  });

  test("sanitizes a 200-stream terminal failure while preserving structured semantics", async () => {
    const adapter = requestFixtureAdapter({
      async *parseStream() {
        yield {
          type: "error",
          message: PRIVATE_ERROR_MATERIAL,
          status: 401,
          errorType: "authentication_error",
          code: "invalid_api_key",
          retryable: false,
        };
      },
    });
    const response = await runResponsesAuxiliaryLoop({
      parsed: parsedAuxiliaryRequest(),
      adapter,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      imageMaxRounds: 0,
      videoMaxRounds: 0,
    });
    const sse = await response.text();

    expect(response.status).toBe(200);
    expect(sse).toContain("event: response.failed");
    expect(sse).toContain("Provider authentication failed during the auxiliary request");
    expect(sse).toContain('"type":"authentication_error"');
    expect(sse).toContain('"code":"invalid_api_key"');
    for (const fragment of PRIVATE_ERROR_MATERIAL.split(" ")) expect(sse).not.toContain(fragment);
  });

  test("sanitizes a thrown transport failure in the eager JSON response", async () => {
    const adapter = requestFixtureAdapter({
      async fetchResponse() {
        throw new Error(PRIVATE_ERROR_MATERIAL);
      },
    });
    const response = await runResponsesAuxiliaryLoop({
      parsed: parsedAuxiliaryRequest(),
      adapter,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      imageMaxRounds: 0,
      videoMaxRounds: 0,
    });
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(body)).toEqual({
      error: {
        message: "Provider auxiliary request failed",
        type: "upstream_error",
        code: null,
      },
    });
    for (const fragment of PRIVATE_ERROR_MATERIAL.split(" ")) expect(body).not.toContain(fragment);
  });

  test("never reflects a non-2xx upstream body or formatter output", async () => {
    const adapter = requestFixtureAdapter({
      async fetchResponse() {
        return new Response(PRIVATE_ERROR_MATERIAL, { status: 418 });
      },
      formatErrorBody(_status, _headers, payloadText) {
        return `formatted ${payloadText}`;
      },
    });
    const response = await runResponsesAuxiliaryLoop({
      parsed: parsedAuxiliaryRequest(),
      adapter,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      imageMaxRounds: 0,
      videoMaxRounds: 0,
    });
    const body = await response.text();

    expect(response.status).toBe(418);
    expect(body).toContain("Provider rejected the auxiliary request (status 418)");
    expect(body).not.toContain("formatted");
    for (const fragment of PRIVATE_ERROR_MATERIAL.split(" ")) expect(body).not.toContain(fragment);
  });
});

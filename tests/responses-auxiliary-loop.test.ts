import { describe, expect, test } from "bun:test";
import {
  appendNativeAuxiliaryReplay,
  deriveAuxiliaryGlobalCeiling,
  nativeAuxiliaryReplayPair,
  scanAuxiliaryToolCalls,
} from "../src/responses/auxiliary";
import type { AdapterEvent } from "../src/types";

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
});

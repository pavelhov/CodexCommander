import { describe, expect, test } from "bun:test";
import {
  currentUserAuthoredText,
  deriveCurrentUserVideoIntent,
} from "../src/responses/auxiliary/user-intent";

describe("Responses structural current-user media provenance", () => {
  test.each([
    "hello",
    "Can I manage end-to-end stories and videos?",
    "Create two videos.",
    "Do not create a video.",
    "text-to-video",
    "Create a video only after I approve.",
    "Create a video with unsupported Unicode: а",
  ])("wording cannot grant or withhold tool eligibility: %s", input => {
    expect(deriveCurrentUserVideoIntent({ input })).toEqual({ state: "eligible" });
  });

  test("matches parser semantics for typed and type-less current user messages", () => {
    for (const item of [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] },
    ]) {
      expect(deriveCurrentUserVideoIntent({ input: [item] })).toEqual({ state: "eligible" });
    }
  });

  test("assistant, tool, delegated, replay, compaction, malformed, and prior user tails are ineligible", () => {
    const inputs = [
      [{ role: "user", content: [{ type: "input_text", text: "create video" }] }, { role: "assistant", content: [] }],
      [{ type: "function_call_output", call_id: "c", output: "create video" }],
      [{ type: "web_search_call", id: "w", action: {} }],
      [{ type: "agent_message", content: [{ type: "input_text", text: "create video" }] }],
      [{ type: "compaction", encrypted_content: "create video" }],
      [{ role: "user", content: [] }],
    ];
    for (const input of inputs) {
      expect(deriveCurrentUserVideoIntent({ input })).toEqual({ state: "none" });
    }
  });

  test("additional_tools after the current user does not replace the tail", () => {
    const body = { input: [
      { role: "user", content: [{ type: "input_text", text: "exact user scope" }] },
      { type: "additional_tools", tools: [{ type: "function", name: "x" }] },
    ] };
    expect(currentUserAuthoredText(body)).toBe("exact user scope");
    expect(deriveCurrentUserVideoIntent(body)).toEqual({ state: "eligible" });
  });
});

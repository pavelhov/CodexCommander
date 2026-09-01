import { describe, expect, test } from "bun:test";

import { deriveCurrentUserVideoIntent } from "../src/responses/auxiliary/user-intent";
import { planImageBridge, planVideoBridge } from "../src/images/plan";
import type { CodexCommanderConfig, CodexCommanderParsedRequest } from "../src/types";

const parsed = {
  context: { messages: [], tools: [] }, stream: true, options: {}, modelId: "fixture/model",
} as CodexCommanderParsedRequest;

function config(key = "xai-key"): CodexCommanderConfig {
  return {
    providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: key } },
    images: { bridgeEnabled: true, videoBridgeEnabled: true, authSource: "api_key" },
  } as CodexCommanderConfig;
}

describe("Responses media proposal policy", () => {
  test.each([
    "Can I manage end-to-end stories and videos?",
    "hello",
    "Do not create a video.",
    "video",
  ])("wording does not change genuine-current-human eligibility: %s", input => {
    expect(deriveCurrentUserVideoIntent({ input })).toEqual({ state: "eligible" });
  });

  test("historical, assistant, tool, and compaction-like tails cannot mint authority", () => {
    const tails = [
      [{ role: "user", content: [{ type: "input_text", text: "video" }] }, { role: "assistant", content: [] }],
      [{ type: "function_call_output", call_id: "c", output: "create video" }],
      [{ type: "compaction", encrypted_content: "create video" }],
      [{ type: "agent_message", content: [{ type: "input_text", text: "create video" }] }],
    ];
    for (const input of tails) expect(deriveCurrentUserVideoIntent({ input })).toEqual({ state: "none" });
  });

  test("enabled plans are advertised without binding missing credentials", async () => {
    const unready = config("");
    const image = await planImageBridge(unready, parsed, unready.providers.xai!);
    const video = await planVideoBridge(unready, parsed, unready.providers.xai!);
    expect(image?.toolNames.has("image_gen")).toBe(true);
    expect(video?.toolNames.has("video_gen")).toBe(true);
    expect(image?.auth).toBeUndefined();
    expect(video?.auth).toBeUndefined();
    expect(() => image?.bindAuth?.()).toThrow();
    expect(() => video?.bindAuth?.()).toThrow();
  });
});

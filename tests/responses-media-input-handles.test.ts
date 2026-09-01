import { describe, expect, test } from "bun:test";

import { buildMediaInputHandleTable } from "../src/images/media-input-handles";
import { buildVideoTool } from "../src/images/synthetic-tool";
import { parseVideoCallArgs } from "../src/images/fulfill-video";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const inline = `data:image/png;base64,${PNG}`;

function request(content: unknown[], prefix: unknown[] = []) {
  return { input: [...prefix, { type: "message", role: "user", content }] };
}

describe("request-local media input handles", () => {
  test("assigns stable position handles and preserves duplicate image positions", () => {
    const table = buildMediaInputHandleTable(request([
      { type: "input_text", text: "animate one" },
      { type: "input_image", image_url: inline },
      { type: "input_image", image_url: inline },
    ]));
    expect(table.descriptions).toEqual([
      { handle: "current_user_image_1", ordinal: 1 },
      { handle: "current_user_image_2", ordinal: 2 },
    ]);
    expect(table.resolve("current_user_image_1")?.bytes).toEqual(table.resolve("current_user_image_2")?.bytes);

    const tool = buildVideoTool(table.descriptions);
    expect(tool.description).toContain("current_user_image_1 (image 1)");
    expect(JSON.stringify(tool)).not.toContain(PNG);
    expect(JSON.stringify(tool)).not.toContain("data:image");
  });

  test("excludes history, file ids, remote URLs, assistant/tool tails, and malformed images", () => {
    const table = buildMediaInputHandleTable(request([
      { type: "input_image", file_id: "file_secret" },
      { type: "input_image", image_url: "https://private.example/image.png" },
      { type: "input_image", image_url: "data:image/png;base64," },
      { type: "input_text", text: "ordinary chat" },
    ], [{ type: "message", role: "user", content: [{ type: "input_image", image_url: inline }] }]));
    expect(table.descriptions).toEqual([]);
    expect(buildMediaInputHandleTable({ input: [
      { type: "message", role: "user", content: [{ type: "input_image", image_url: inline }] },
      { type: "function_call_output", call_id: "c", output: "done" },
    ] }).descriptions).toEqual([]);
  });

  test("resolves one starting image or ordered references only after a valid proposal", () => {
    const table = buildMediaInputHandleTable(request(Array.from({ length: 7 }, () => ({
      type: "input_image", image_url: inline,
    }))));
    expect(parseVideoCallArgs(JSON.stringify({
      prompt: "animate", starting_image_handle: "current_user_image_1",
    }), table)).toMatchObject({ ok: true, mode: "starting_image", startingImage: { mimeType: "image/png" } });
    expect(parseVideoCallArgs(JSON.stringify({
      prompt: "reference", reference_image_handles: ["current_user_image_2", "current_user_image_1"],
    }), table)).toMatchObject({ ok: true, mode: "reference_images" });
    expect(parseVideoCallArgs(JSON.stringify({
      prompt: "mixed", starting_image_handle: "current_user_image_1",
      reference_image_handles: ["current_user_image_2"],
    }), table)).toMatchObject({ ok: false });
    expect(parseVideoCallArgs(JSON.stringify({
      prompt: "repeat", reference_image_handles: ["current_user_image_1", "current_user_image_1"],
    }), table)).toMatchObject({ ok: false });
    expect(parseVideoCallArgs(JSON.stringify({
      prompt: "invented", starting_image_handle: "current_user_image_99",
    }), table)).toMatchObject({ ok: false });
    expect(parseVideoCallArgs(JSON.stringify({
      prompt: "too large", resolution: "1080p", reference_image_handles: ["current_user_image_1"],
    }), table)).toMatchObject({ ok: false });
  });
});

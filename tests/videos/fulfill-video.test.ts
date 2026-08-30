import { describe, expect, test } from "bun:test";
import { buildVideoResult, parseVideoCallArgs } from "../../src/images/fulfill-video";

describe("parseVideoCallArgs", () => {
  test("parses the complete strict text-to-video shape", () => {
    expect(parseVideoCallArgs(JSON.stringify({
      prompt: "hello",
      duration: 5,
      resolution: "1080p",
      aspect_ratio: "16:9",
      audio: true,
    }))).toEqual({
      ok: true,
      prompt: "hello",
      duration: 5,
      resolution: "1080p",
      aspectRatio: "16:9",
      audio: true,
    });
  });

  test("applies deterministic normal defaults", () => {
    expect(parseVideoCallArgs(JSON.stringify({ prompt: "test" }))).toEqual({
      ok: true,
      prompt: "test",
      duration: 6,
      resolution: "720p",
      aspectRatio: "16:9",
    });
  });

  test("accepts the duration boundaries", () => {
    expect(parseVideoCallArgs(JSON.stringify({ prompt: "test", duration: 1 }))).toMatchObject({ ok: true, duration: 1 });
    expect(parseVideoCallArgs(JSON.stringify({ prompt: "test", duration: 15 }))).toMatchObject({ ok: true, duration: 15 });
  });

  test.each([0, 16, 1.5])("rejects invalid duration %p instead of clamping", duration => {
    expect(parseVideoCallArgs(JSON.stringify({ prompt: "test", duration })))
      .toEqual({ ok: false, error: "duration must be an integer from 1 through 15" });
  });

  test.each(["480p", "720p", "1080p"])("accepts %s resolution", resolution => {
    expect(parseVideoCallArgs(JSON.stringify({ prompt: "test", resolution })))
      .toMatchObject({ ok: true, resolution });
  });

  test.each(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"])("accepts ratio %s", aspect_ratio => {
    expect(parseVideoCallArgs(JSON.stringify({ prompt: "test", aspect_ratio })))
      .toMatchObject({ ok: true, aspectRatio: aspect_ratio });
  });

  test("rejects input as an alias for prompt", () => {
    expect(parseVideoCallArgs(JSON.stringify({ input: "world" })))
      .toEqual({ ok: false, error: "unsupported video argument: input" });
  });

  test.each(["", "   "])("rejects an empty prompt", prompt => {
    expect(parseVideoCallArgs(JSON.stringify({ prompt }))).toEqual({ ok: false, error: "missing prompt" });
  });

  test("fails on invalid JSON and null", () => {
    expect(parseVideoCallArgs("not json")).toEqual({ ok: false, error: "invalid arguments JSON" });
    expect(parseVideoCallArgs("null")).toEqual({ ok: false, error: "invalid arguments JSON" });
  });

  test("rejects invalid enum and audio values", () => {
    expect(parseVideoCallArgs(JSON.stringify({ prompt: "test", resolution: "4k" })))
      .toEqual({ ok: false, error: "unsupported resolution" });
    expect(parseVideoCallArgs(JSON.stringify({ prompt: "test", aspect_ratio: "5:4" })))
      .toEqual({ ok: false, error: "unsupported aspect_ratio" });
    expect(parseVideoCallArgs(JSON.stringify({ prompt: "test", audio: "yes" })))
      .toEqual({ ok: false, error: "audio must be a boolean" });
  });

  test.each(["image", "image_url", "reference", "reference_images", "video_url", "mode"])(
    "rejects non-text or unknown field %s",
    field => {
      expect(parseVideoCallArgs(JSON.stringify({ prompt: "test", [field]: "unsafe" })))
        .toEqual({ ok: false, error: `unsupported video argument: ${field}` });
    },
  );
});

describe("buildVideoResult", () => {
  test("builds a local result with generation metadata", () => {
    const result = buildVideoResult("/tmp/vid-123.mp4", "dance", "grok-imagine-video-1.5", {
      duration: 6,
      resolution: "720p",
      aspectRatio: "16:9",
      audio: true,
    });
    expect(result).toMatchObject({
      ok: true,
      path: "/tmp/vid-123.mp4",
      prompt: "dance",
      model: "grok-imagine-video-1.5",
      files: ["/tmp/vid-123.mp4"],
      count: 1,
      duration: 6,
      resolution: "720p",
      aspectRatio: "16:9",
      audio: true,
    });
    expect(result.markdown).toContain("file://");
  });
});

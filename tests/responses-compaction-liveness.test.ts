import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { bridgeToResponsesSSE } from "../src/bridge";
import { decodeCompactionSummary } from "../src/responses/compaction";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

// Anthropic's Messages streaming wire format; these are upstream events, not the
// response.heartbeat frames the bridge itself emits to keep Codex connected.
const ANTHROPIC_PING = 'event: ping\ndata: {"type":"ping"}\n\n';
const THINKING_START = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":0}}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}',
].join("\n\n") + "\n\n";
const SUMMARY_END = [
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"test-signature"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Progress and next steps."}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n") + "\n\n";

// Only the bridge's beat clock is virtual. A macrotask boundary lets the real SSE
// decoder, adapter, bridge and client reader finish processing each supplied chunk.
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function compactionStream() {
  const encoder = new TextEncoder();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let beat: (() => void) | undefined;
  let stopped = false;
  let cancellations = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    source.close();
  };
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
  }), { headers: { "content-type": "text/event-stream" } });
  const budget = createTestTranslatorBudget();
  const adapter = createAnthropicAdapter({
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "test-key",
  });
  const stream = bridgeToResponsesSSE(
    adapter.parseStream(upstream, budget),
    "anthropic/claude-opus-5-5",
    undefined, undefined, undefined,
    () => { cancellations += 1; stop(); },
    2_000,
    {
      translatorBudget: budget,
      compaction: true,
      timers: {
        setInterval(handler) { beat = handler; return 1; },
        clearInterval() { beat = undefined; },
      },
    },
  );
  const result = new Response(stream).text();
  return {
    result,
    stop,
    cancellations: () => cancellations,
    async send(chunk: string) {
      if (!stopped) source.enqueue(encoder.encode(chunk));
      await settle();
    },
    async advanceBeats(count: number) {
      for (let index = 0; index < count; index++) beat?.();
      await settle();
    },
  };
}

describe("Anthropic remote compaction liveness", () => {
  test("real pings keep a long thinking phase alive until one complete summary arrives", async () => {
    const turn = compactionStream();
    try {
      await turn.send(THINKING_START);
      // Ten minutes of ping-only thought, beyond the default five-minute stall
      // window. Every gap is only 150 seconds, so the upstream remains alive.
      for (let index = 0; index < 4; index++) {
        await turn.send(ANTHROPIC_PING);
        await turn.advanceBeats(75);
      }
      expect(turn.cancellations()).toBe(0);
      await turn.send(SUMMARY_END);
      turn.stop();
      const text = await turn.result;
      const frames = text.split("\n\n")
        .map(frame => frame.split("\n").find(line => line.startsWith("data: "))?.slice(6))
        .filter((data): data is string => Boolean(data) && data !== "[DONE]")
        .map(data => JSON.parse(data) as Record<string, unknown>);
      const completed = frames.filter(frame => frame.type === "response.completed");
      expect(completed).toHaveLength(1);
      const response = completed[0]!.response as { output: Array<{ type: string; encrypted_content: string }> };
      expect(response.output).toHaveLength(1);
      expect(response.output[0]!.type).toBe("compaction");
      expect(decodeCompactionSummary(response.output[0]!.encrypted_content)).toBe("Progress and next steps.");
      expect(text).toContain("response.heartbeat");
      expect(text).not.toContain("response.output_text.delta");
      expect(text).not.toContain("response.reasoning_summary_text.delta");
      expect(text).not.toContain("upstream_stall_timeout");
      // The bridge cancels its upstream once when the terminal is complete too.
      expect(turn.cancellations()).toBe(1);
    } finally {
      turn.stop();
      await turn.result;
    }
  });

  test("silence after a real ping still times out and cancels without installing a summary", async () => {
    const turn = compactionStream();
    try {
      await turn.send(THINKING_START + ANTHROPIC_PING);
      // One tick acknowledges the last real activity; the next 150 are silence.
      // Bridge-generated client keepalives must not reset this watchdog.
      await turn.advanceBeats(151);
      const text = await turn.result;
      expect(text).toContain("response.heartbeat");
      expect(text).toContain("upstream_stall_timeout");
      expect(text).not.toContain("response.completed");
      expect(text).not.toContain('"type":"compaction"');
      expect(turn.cancellations()).toBe(1);
    } finally {
      turn.stop();
      await turn.result;
    }
  });

  test("unknown and malformed records cannot keep compaction alive", async () => {
    const turn = compactionStream();
    try {
      await turn.send(THINKING_START);
      for (let index = 0; index < 4; index++) {
        await turn.send('event: unknown\ndata: {"type":"unknown"}\n\nevent: ping\ndata: not-json\n\nevent: ping\ndata: {}\n\n');
        await turn.advanceBeats(50);
      }
      const text = await turn.result;
      expect(text).toContain("upstream_stall_timeout");
      expect(text).not.toContain('"type":"compaction"');
      expect(turn.cancellations()).toBe(1);
    } finally {
      turn.stop();
      await turn.result;
    }
  });
});

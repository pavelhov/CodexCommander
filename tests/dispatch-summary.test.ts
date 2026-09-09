import { describe, expect, test } from "bun:test";
import { createDispatchRequest, type DispatchEvent } from "../src/usage/dispatch";
import { summarizeDispatchEvents } from "../src/usage/dispatch-summary";
import { dispatchHttpFetch } from "../src/usage/dispatch-http";
import { observeSidecarFrame } from "../src/usage/dispatch-sidecar";

const available = { sourcePresent: true };
function fixture(count = 1) {
  const events: DispatchEvent[] = [];
  const request = createDispatchRequest(e => events.push(e));
  const attempt = request.attempt();
  const sends = Array.from({ length: count }, () => attempt.start());
  for (const send of sends) send.terminal("protocol_success");
  return { events, sends, attempt };
}
describe("dispatch consumption reconciliation", () => {
  test("counts ordinary work independently and folds usage revisions once", () => {
    const { events, sends } = fixture();
    sends[0]!.usage({ provenance: "provider", completeness: "partial", inputTokens: 100 });
    sends[0]!.usage({ provenance: "provider", completeness: "complete", inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 40, reasoningOutputTokens: 5 });
    const result = summarizeDispatchEvents([...events, ...events.slice(3)], available);
    expect(result.counts).toMatchObject({ requests: 1, attempts: 1, sends: 1, terminals: 1, missingUsage: 0 });
    expect(result.providerTokens).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, observedSends: 1 });
    expect(result.complete).toBe(true);
  });
  test("nine sends and only final usage is a known subtotal with eight missing", () => {
    const { events, sends } = fixture(9);
    sends[8]!.usage({ provenance: "provider", completeness: "complete", inputTokens: 10, outputTokens: 2 });
    const result = summarizeDispatchEvents(events, available);
    expect(result.counts).toMatchObject({ requests: 1, attempts: 1, sends: 9, missingUsage: 8 });
    expect(result.providerTokens.totalTokens).toBe(12);
    expect(result.complete).toBe(false);
  });
  test("cumulative checkpoints and unlike credits never enter token subtotal", () => {
    const { events, sends } = fixture(3);
    sends[0]!.usage({ provenance: "cumulative", completeness: "complete", contextTotalTokens: 400 });
    sends[1]!.usage({ provenance: "provider_credits", completeness: "complete", credits: 0.25 });
    sends[2]!.usage({ provenance: "estimated", completeness: "complete", inputTokens: 12, outputTokens: 2 });
    const result = summarizeDispatchEvents(events, available);
    expect(result.providerTokens.observedSends).toBe(0);
    expect(result.estimatedTokens.totalTokens).toBe(14);
    expect(result.cumulativeObservations).toHaveLength(1);
    expect(result.providerCreditObservations).toHaveLength(1);
    expect(result.complete).toBe(false);
  });
  test("empty, missing, corrupted, truncated and degraded sources cannot prove zero", () => {
    expect(summarizeDispatchEvents([], available).complete).toBe(false);
    const { events, sends } = fixture();
    sends[0]!.usage({ provenance: "provider", completeness: "complete", inputTokens: 0, outputTokens: 0 });
    for (const coverage of [{ sourcePresent: false }, { ...available, invalidRows: 1 }, { ...available, truncated: true }, { ...available, degradation: { appendFailures: 1 } }]) {
      expect(summarizeDispatchEvents(events, coverage).complete).toBe(false);
    }
    expect(summarizeDispatchEvents(events, available).complete).toBe(true);
  });
  test("partial failed sidecar preserves known input and missing consumption", () => {
    const events: DispatchEvent[] = [];
    const send = createDispatchRequest(e => events.push(e)).attempt().start({ surface: "sidecar" });
    send.usage({ provenance: "provider", completeness: "partial", inputTokens: 4 });
    send.terminal("protocol_failure");
    const result = summarizeDispatchEvents(events, available);
    expect(result.counts.partialUsage).toBe(1);
    expect(result.providerTokens.totalTokens).toBe(4);
    expect(result.complete).toBe(false);
  });
  test("Anthropic sidecar input and output frames merge with cache-inclusive input", async () => {
    const events: DispatchEvent[] = [];
    const attempt = createDispatchRequest(e => events.push(e)).attempt();
    const response = await dispatchHttpFetch((async () => new Response()) as typeof fetch, "https://fixture.invalid", {}, { attempt });
    observeSidecarFrame(response, { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 0 } } });
    observeSidecarFrame(response, { type: "message_delta", usage: { output_tokens: 8 } });
    observeSidecarFrame(response, { type: "message_stop" });
    const result = summarizeDispatchEvents(events, available);
    expect(result.providerTokens).toEqual({ inputTokens: 20, outputTokens: 8, totalTokens: 28, observedSends: 1 });
    expect(result.complete).toBe(true);
  });
  test("Responses sidecar details are subsets and absent details stay unknown", async () => {
    const events: DispatchEvent[] = [];
    const attempt = createDispatchRequest(e => events.push(e)).attempt();
    const response = await dispatchHttpFetch((async () => new Response()) as typeof fetch, "https://fixture.invalid", {}, { attempt });
    observeSidecarFrame(response, { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 7 }, output_tokens_details: { reasoning_tokens: 3 } } } });
    const result = summarizeDispatchEvents(events, available);
    expect(result.providerTokens.totalTokens).toBe(28);
    expect(events.filter(e => e.kind === "usage").at(-1)?.usage).toMatchObject({ cacheReadInputTokens: 7, reasoningOutputTokens: 3, completeness: "complete" });
  });
});

test("sidecar content frames do not exhaust bounded revisions and missing Anthropic cache stays partial", async () => {
  const events: DispatchEvent[] = [];
  const attempt = createDispatchRequest(e => events.push(e)).attempt();
  const response = await dispatchHttpFetch((async () => new Response()) as typeof fetch, "https://fixture.invalid", {}, { attempt });
  observeSidecarFrame(response, { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } });
  for (let n = 0; n < 100; n++) observeSidecarFrame(response, { type: "content_block_delta" });
  observeSidecarFrame(response, { type: "message_delta", usage: { output_tokens: 7 } });
  observeSidecarFrame(response, { type: "message_stop" });
  expect(events.filter(e => e.kind === "usage")).toHaveLength(3);
  const result = summarizeDispatchEvents(events, available);
  expect(result.providerTokens.totalTokens).toBe(17);
  expect(result.counts.partialUsage).toBe(1);
  expect(result.complete).toBe(false);
});

test("Responses absent breakdowns stay unknown while inclusive measured totals are complete", async () => {
  const events: DispatchEvent[] = [];
  const attempt = createDispatchRequest(e => events.push(e)).attempt();
  const response = await dispatchHttpFetch((async () => new Response()) as typeof fetch, "https://fixture.invalid", {}, { attempt });
  observeSidecarFrame(response, { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 0 } } });
  const usage = events.find(e => e.kind === "usage")?.usage;
  expect(usage?.cacheReadInputTokens).toBeUndefined();
  expect(usage?.reasoningOutputTokens).toBeUndefined();
  expect(summarizeDispatchEvents(events, available).complete).toBe(true);
});

test("an initial Anthropic output zero without final usage never becomes complete", async () => {
  const events: DispatchEvent[] = [];
  const attempt = createDispatchRequest(e => events.push(e)).attempt();
  const response = await dispatchHttpFetch((async () => new Response()) as typeof fetch, "https://fixture.invalid", {}, { attempt });
  observeSidecarFrame(response, { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  observeSidecarFrame(response, { type: "message_stop" });
  expect(summarizeDispatchEvents(events, available).complete).toBe(false);
});

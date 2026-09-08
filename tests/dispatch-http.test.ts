import { describe, expect, test } from "bun:test";
import { fetchWithTransientRetry } from "../src/lib/upstream-retry";
import { fetchWithHeaderTimeout } from "../src/server/responses/fetch-helpers";

describe("HTTP dispatch characterization", () => {
  test("nested reset and status retries retain nine final executor calls", async () => {
    let sends = 0;
    const executor = (async () => {
      sends++;
      if (sends % 3 !== 0) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return new Response("synthetic", { status: sends === 9 ? 200 : 503, headers: { "retry-after": "0" } });
    }) as typeof fetch;
    const controller = new AbortController();
    const result = await fetchWithTransientRetry(() => fetchWithHeaderTimeout("http://localhost.invalid", {}, controller.signal, 1000, false, executor), { attempts: 3, slowAttemptMs: 10000 });
    expect(sends).toBe(9);
    expect(await result.text()).toBe("synthetic");
  });

  test("pre-aborted final helper still invokes executor, retry wrapper does not", async () => {
    let sends = 0;
    const controller = new AbortController(); controller.abort();
    const executor = (async (_url: unknown, init: RequestInit) => { sends++; expect(init.signal?.aborted).toBe(true); throw controller.signal.reason; }) as typeof fetch;
    await expect(fetchWithHeaderTimeout("http://localhost.invalid", {}, controller.signal, 1000, false, executor)).rejects.toThrow();
    expect(sends).toBe(1);
    await expect(fetchWithTransientRetry(() => fetchWithHeaderTimeout("http://localhost.invalid", {}, controller.signal, 1000, false, executor), { abortSignal: controller.signal })).rejects.toThrow();
    expect(sends).toBe(1);
  });

  test("header completion retains parent abort linkage and does not consume body", async () => {
    const controller = new AbortController(); let wireSignal: AbortSignal | null | undefined;
    const response = new Response("synthetic");
    const executor = (async (_url: unknown, init: RequestInit) => { wireSignal = init.signal; return response; }) as typeof fetch;
    const result = await fetchWithHeaderTimeout("http://localhost.invalid", {}, controller.signal, 5, false, executor);
    expect(result).toBe(response); expect(response.bodyUsed).toBe(false);
    await Bun.sleep(15); expect(wireSignal?.aborted).toBe(false);
    controller.abort(); expect(wireSignal?.aborted).toBe(true);
  });
});

import { createDispatchRequest, dispatchObserverHealth, foldDispatchEvents, type DispatchEvent } from "../src/usage/dispatch";
import { cleanupResponseDispatch, dispatchHttpFetch, observeAdapterStream, responseDispatch } from "../src/usage/dispatch-http";
import { createSseInspector } from "../src/server/relay";
import { handleResponses } from "../src/server/responses/core";
import { handleChatCompletions } from "../src/server/chat-completions";
import { handleClaudeMessages, handleClaudeCountTokens } from "../src/server/claude-messages";
import { handleResponsesCompact } from "../src/server/responses/compact";
import type { RequestLogContext } from "../src/server/request-log";
import type { AdapterEvent, CodexCommanderConfig } from "../src/types";

function accounting() {
  const events: DispatchEvent[] = [];
  const request = createDispatchRequest(event => events.push(event));
  return { events, request, attempt: request.attempt() };
}
const syntheticUrl = "http://127.0.0.1:1/v1/responses";

describe("passive final HTTP accounting", () => {
  test("nine sends are recorded beneath nested retries without changing result", async () => {
    const { events, attempt } = accounting(); let calls = 0;
    const controller = new AbortController();
    const executor = (async () => { calls++; if (calls % 3) throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); return new Response("synthetic", { status: calls === 9 ? 200 : 503, headers: { "retry-after": "0" } }); }) as typeof fetch;
    const result = await fetchWithTransientRetry(() => fetchWithHeaderTimeout(syntheticUrl, {}, controller.signal, 1000, false, executor, false, { attempt, clientSignal: controller.signal }), { attempts: 3, slowAttemptMs: 10000 });
    expect(calls).toBe(9); expect(await result.text()).toBe("synthetic");
    expect(foldDispatchEvents(events).sends).toHaveLength(9);
    expect(foldDispatchEvents(events).sends.at(-1)?.outcome).toBe("unknown");
    expect(events.filter(e => e.kind === "start").map(e => e.metadata?.reason)).toEqual(["initial", ...Array(8).fill("retry")]);
    cleanupResponseDispatch(result);
  });

  test("headers are intermediate; HTTP errors, SSE errors and EOF remain distinct", async () => {
    const { events, attempt } = accounting();
    for (const [status, payload] of [[503, ""], [200, '{"type":"response.failed"}'], [200, '{"type":"response.output_text.delta","delta":"synthetic"}']] as const) {
      const response = await dispatchHttpFetch((async () => new Response(payload, { status })) as typeof fetch, syntheticUrl, {}, { attempt });
      const logCtx: RequestLogContext = { model: "test", provider: "test", dispatchSend: responseDispatch(response) };
      const inspector = createSseInspector({ logCtx });
      inspector.feed(new TextEncoder().encode(`data: ${payload}\n\n`)); inspector.finish(); inspector.dispose();
    }
    expect(foldDispatchEvents(events).sends.map(send => send.outcome)).toEqual(["protocol_failure", "protocol_failure", "unknown"]);
    expect(foldDispatchEvents(events).sends[2]?.outputObserved).toBe(true);
  });

  test("terminal survives later delivery failure and cancellation stays orthogonal", async () => {
    const { events, attempt } = accounting(); const client = new AbortController();
    const response = await dispatchHttpFetch((async () => new Response("")) as typeof fetch, syntheticUrl, { signal: client.signal }, { attempt, clientSignal: client.signal });
    async function* source(): AsyncGenerator<AdapterEvent> { yield { type: "done", usage: { inputTokens: 4, outputTokens: 2 } }; client.abort(); throw new Error("delivery failed"); }
    await expect((async () => { for await (const _ of observeAdapterStream(response, source())) { /* original consumer */ } })()).rejects.toThrow("delivery failed");
    const send = foldDispatchEvents(events).sends[0]!;
    expect(send.outcome).toBe("protocol_success"); expect(send.clientCancelled).toBe(true); expect(send.upstreamCancelled).toBe(true);
  });

  test("throwing observers degrade health and never replace original result or error", async () => {
    const failures = dispatchObserverHealth().observerFailures;
    const bad = { attempt: { start() { throw new Error("observer failure"); } } } as Parameters<typeof dispatchHttpFetch>[3];
    const response = new Response("synthetic");
    expect(await dispatchHttpFetch((async () => response) as typeof fetch, syntheticUrl, {}, bad)).toBe(response);
    const error = new Error("wire failure");
    await expect(dispatchHttpFetch((async () => { throw error; }) as typeof fetch, syntheticUrl, {}, bad)).rejects.toBe(error);
    expect(dispatchObserverHealth().observerFailures).toBe(failures + 2);
    expect(response.bodyUsed).toBe(false);
  });

  test("delivery teardown removes listeners from reused parent signals", async () => {
    const { attempt } = accounting(); const controller = new AbortController();
    let added = 0; let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal); const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => { added++; return add(...args); }) as typeof add;
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => { removed++; return remove(...args); }) as typeof remove;
    for (let i = 0; i < 5; i++) { const response = await dispatchHttpFetch((async () => new Response("")) as typeof fetch, syntheticUrl, { signal: controller.signal }, { attempt, clientSignal: controller.signal }); cleanupResponseDispatch(response); cleanupResponseDispatch(response); }
    expect(added).toBe(10); expect(removed).toBe(added);
  });
});

const config: CodexCommanderConfig = {
  port: 0, defaultProvider: "mock", multiAgentGuidanceEnabled: false,
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic", allowPrivateNetwork: true, liveModels: false, models: ["test"] } },
  claudeCode: { anthropicBaseUrl: "http://127.0.0.1:1" },
} as CodexCommanderConfig;

describe("ordinary inference scope integration", () => {
  for (const surface of ["responses", "chat", "messages", "compact"] as const) test(`${surface} initializes an ordinary attempt at the actual send`, async () => {
    const { events, request } = accounting(); events.splice(1); // discard helper's unused attempt
    const logCtx: RequestLogContext = { model: "mock/test", provider: "mock", dispatchRequest: request };
    const original = globalThis.fetch; let calls = 0; let captured = "";
    globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
      calls++; captured = String(init.body);
      if (surface === "messages") return Response.json({ type: "message", stop_reason: "end_turn", content: [{ type: "text", text: "synthetic" }], usage: { input_tokens: 4, output_tokens: 2 } });
      if (JSON.parse(captured).stream) return new Response('data: {"id":"synthetic","choices":[{"index":0,"delta":{"role":"assistant","content":"synthetic"},"finish_reason":null}]}\n\ndata: {"id":"synthetic","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      return Response.json({ id: "synthetic", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "synthetic" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
    }) as typeof fetch;
    try {
      const req = new Request(`http://localhost/v1/${surface}`, { method: "POST", headers: { "content-type": "application/json", ...(surface === "messages" ? { authorization: "Bearer sk-ant-oat01-synthetic", "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-cli/2.1.200" } : {}) }, body: JSON.stringify(surface === "responses" || surface === "compact" ? { model: "mock/test", stream: false, input: "synthetic" } : { model: surface === "messages" ? "claude-synthetic" : "mock/test", stream: false, max_tokens: 10, messages: [{ role: "user", content: "synthetic" }] }) });
      const response = surface === "responses" ? await handleResponses(req, config, logCtx) : surface === "chat" ? await handleChatCompletions(req, config, logCtx) : surface === "messages" ? await handleClaudeMessages(req, config, logCtx) : await handleResponsesCompact(req, config, logCtx);
      await response.text();
      expect(calls).toBe(1);
      const folded = foldDispatchEvents(events); expect(folded.requests).toHaveLength(1); expect(folded.attempts).toHaveLength(1); expect(folded.sends).toHaveLength(1); expect(folded.sends[0]?.outcome).toBe("protocol_success");
      expect(captured).not.toContain("dispatch"); expect(captured).not.toContain(request.requestRef);
      expect(logCtx.attempts).toBeUndefined(); // preserve existing legacy-row summary authority
    } finally { globalThis.fetch = original; }
  });
});

test("combo fallback owns separate attempts under one logical request", async () => {
  const events: DispatchEvent[] = []; const request = createDispatchRequest(event => events.push(event));
  const logCtx: RequestLogContext = { model: "combo/dispatch-test", provider: "combo", dispatchRequest: request };
  const comboConfig = { ...config, providers: { ...config.providers, backup: { ...config.providers.mock! } }, combos: { "dispatch-test": { strategy: "failover", targets: [{ provider: "mock", model: "test" }, { provider: "backup", model: "test" }] } } } as CodexCommanderConfig;
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return calls === 1 ? Response.json({ error: { message: "synthetic failure" } }, { status: 403 }) : Response.json({ id: "synthetic", choices: [{ index: 0, message: { role: "assistant", content: "synthetic" }, finish_reason: "stop" }] }); }) as typeof fetch;
  try {
    const response = await handleResponses(new Request(syntheticUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "combo/dispatch-test", input: "synthetic", stream: false }) }), comboConfig, logCtx);
    await response.text(); const folded = foldDispatchEvents(events);
    expect(calls).toBe(2); expect(folded.requests).toHaveLength(1); expect(folded.attempts).toHaveLength(2); expect(folded.sends).toHaveLength(2);
    expect(folded.sends.map(send => send.outcome)).toEqual(["protocol_failure", "protocol_success"]);
  } finally { globalThis.fetch = original; }
});

test("native compact observes existing JSON consumer and preserves payload", async () => {
  const events: DispatchEvent[] = []; const request = createDispatchRequest(event => events.push(event));
  const logCtx: RequestLogContext = { model: "", provider: "", dispatchRequest: request };
  const nativeConfig = { ...config, providers: { "openai-apikey": { ...config.providers.mock!, adapter: "openai-responses", authMode: "key" } } } as CodexCommanderConfig;
  const payload = { object: "response.compaction", output: [], usage: { input_tokens: 5, output_tokens: 2 } };
  const original = globalThis.fetch; globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
  try {
    const response = await handleResponsesCompact(new Request(syntheticUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai-apikey/gpt-5.5", input: [] }) }), nativeConfig, logCtx);
    expect(await response.json()).toEqual(payload); const folded = foldDispatchEvents(events);
    expect(folded.sends).toHaveLength(1); expect(folded.sends[0]?.outcome).toBe("protocol_success");
  } finally { globalThis.fetch = original; }
});

import { readDispatchJournal } from "../src/usage/dispatch-log";
test("native count_tokens is excluded from inference sends", async () => {
  const before = readDispatchJournal(); const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ input_tokens: 4 }); }) as typeof fetch;
  try {
    const response = await handleClaudeCountTokens(new Request("http://localhost/v1/messages/count_tokens", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat01-synthetic", "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-cli/2.1.200" }, body: JSON.stringify({ model: "claude-synthetic", messages: [{ role: "user", content: "synthetic" }] }) }), config);
    expect(await response.json()).toEqual({ input_tokens: 4 }); expect(calls).toBe(1); const after = readDispatchJournal(); expect(after.requests).toHaveLength(before.requests.length); expect(after.attempts).toHaveLength(before.attempts.length); expect(after.sends).toHaveLength(before.sends.length);
  } finally { globalThis.fetch = original; }
});

test("HTTP observer records session header presence without retaining values or changing init", async () => {
  const { events, attempt } = accounting();
  const headers = new Headers({ session_id: "private-session-value", "x-codex-turn-state": "private-routing-value" });
  const init: RequestInit = { headers };
  const executor = (async (_url: unknown, seen: RequestInit) => { expect(seen).toBe(init); return new Response(); }) as typeof fetch;
  await dispatchHttpFetch(executor, syntheticUrl, init, { attempt });
  const start = events.find(event => event.kind === "start");
  expect(start?.metadata?.sessionPresent).toBe(true);
  expect(start?.metadata?.routingHintPresent).toBeUndefined();
  expect(JSON.stringify(events)).not.toContain("private-");
});

test("session presence leaves arbitrary header iterators untouched and handles materialized names", async () => {
  let iterations = 0;
  const iterable = { *[Symbol.iterator]() { iterations++; yield ["session-id", "private-session"]; } };
  for (const [headers, expected] of [[iterable, undefined], [{ "Thread-Id": "private-session" }, true], [[["SESSION-ID", "private-session"]], true], [{ accept: "text/event-stream" }, false]] as const) {
    const { events, attempt } = accounting();
    const executor = (async () => new Response()) as typeof fetch;
    await dispatchHttpFetch(executor, syntheticUrl, { headers: headers as HeadersInit }, { attempt });
    expect(events.find(event => event.kind === "start")?.metadata?.sessionPresent).toBe(expected);
  }
  expect(iterations).toBe(0);
});

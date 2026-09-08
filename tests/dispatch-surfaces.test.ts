import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createDispatchRequest, dispatchObserverHealth, foldDispatchEvents, type DispatchEvent } from "../src/usage/dispatch";
import { observeAdapterStream } from "../src/usage/dispatch-http";
import { runWebSearch } from "../src/web-search/executor";
import { createCommandCodeAdapter } from "../src/adapters/command-code";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { handleImages } from "../src/server/images";
import { handleLive } from "../src/server/live";
import { handleSearch } from "../src/server/search";
import type { RequestLogContext } from "../src/server/request-log";
import type { CodexCommanderConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { runSidecarDispatchFixture } from "./helpers/dispatch-surface-fixtures";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const root = join(import.meta.dir, "..");
function accounting() { const events: DispatchEvent[] = []; const request = createDispatchRequest(event => events.push(event)); return { events, request }; }

test("failed vision sidecar and successful main preserve separate outcomes and parent provenance", async () => {
  const result = await runSidecarDispatchFixture(root);
  expect(result.sendCount).toBe(2);
  expect(result.requestCount).toBe(2);
  expect(result.attemptCount).toBe(2);
  expect(result.outcomes).toEqual(["protocol_failure", "protocol_success"]);
  expect(result.coverage).toBe("complete");
  expect(result.mainText).toBe("synthetic main answer");
  const child = result.events.find(event => event.kind === "request" && event.parentRequestRef);
  expect(child?.parentAttemptRef).toBeDefined();
});

test("vision cache hit performs no inference and no extra child scope", async () => {
  const result = await runSidecarDispatchFixture(root, false);
  expect(result.cacheHitSendCount).toBe(0);
  expect(result.sendCount).toBe(2);
  expect(result.sidecarSendCount).toBe(1);
  expect(result.requestCount).toBe(2);
  expect(result.outcomes).toEqual(["protocol_success", "protocol_success"]);
});

test("search reset retries observe final sends and preserve partial EOF as unknown", async () => {
  const { events, request } = accounting();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" });
    return new Response('data: {"type":"response.output_text.delta","delta":"synthetic answer"}\n\n');
  }) as typeof fetch;
  const result = await runWebSearch("synthetic", { type: "web_search" }, { adapter: "openai-responses", baseUrl: "http://127.0.0.1:1" }, new Headers(), { model: "synthetic", reasoning: "low", timeoutMs: 1000 }, undefined, undefined, request.attempt());
  expect(result.text).toBe("synthetic answer");
  expect(calls).toBe(2);
  expect(foldDispatchEvents(events).sends.map(send => send.outcome)).toEqual(["transport_failure", "unknown"]);
});

test("Command Code synthetic EOF done does not assert upstream completion", async () => {
  const { events, request } = accounting();
  const executor = (async () => new Response('{"type":"text-delta","text":"synthetic"}\n')) as typeof fetch;
  const adapter = createCommandCodeAdapter({ adapter: "command-code", baseUrl: "http://127.0.0.1:1", fetch: executor });
  const response = await adapter.fetchResponse!({ url: "http://127.0.0.1:1", method: "POST", headers: {}, body: "{}" }, { dispatch: { attempt: request.attempt() } });
  const budget = createTranslatorBudget();
  const types: string[] = [];
  try { for await (const event of observeAdapterStream(response, adapter.parseStream(response, budget))) types.push(event.type); } finally { budget.dispose(); }
  expect(types).toEqual(["text_delta", "done"]);
  expect(foldDispatchEvents(events).sends[0]?.outcome).toBe("unknown");
});

const keyed = { adapter: "openai-responses" as const, baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic" };
const config: CodexCommanderConfig = { port: 0, defaultProvider: "ccx-fixture-private", providers: { "ccx-fixture-private": keyed, "openai-apikey": { ...keyed, baseUrl: "https://api.openai.com/v1" } }, images: { provider: "ccx-fixture-private" } };

test("standalone images count inference; Live call setup is excluded as session control", async () => {
  for (const surface of ["images", "realtime"] as const) {
    const { events, request } = accounting();
    const log: RequestLogContext = { dispatchRequest: request };
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ synthetic: true }); }) as typeof fetch;
    const req = new Request(`http://localhost/v1/${surface === "images" ? "images/generations" : "live"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "synthetic", model: "synthetic" }) });
    const result = surface === "images" ? await handleImages(req, config, "generations", log) : await handleLive(req, config, log);
    if (result.status !== 200) throw new Error(await result.text());
    expect(calls).toBe(1);
    const folded = foldDispatchEvents(events);
    expect(folded.requests).toHaveLength(1);
    expect(folded.requests[0]?.parentRequestRef).toBeUndefined();
    expect(folded.sends).toHaveLength(surface === "images" ? 1 : 0);
    if (surface === "images") {
      expect(folded.sends[0]?.start.metadata?.surface).toBe(surface);
      expect(folded.sends[0]?.outcome).toBe("unknown");
    }
  }
});

test("search observer retains stable route alias and never exposes provider identity", async () => {
  const { events, request } = accounting();
  const provider = { adapter: "openai-responses" as const, authMode: "forward" as const, baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "direct" as const };
  globalThis.fetch = (async () => Response.json({ output: "synthetic" })) as typeof fetch;
  const cfg: CodexCommanderConfig = { port: 0, defaultProvider: "openai", providers: { openai: provider } };
  const response = await handleSearch(new Request("http://localhost/v1/alpha/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "synthetic-account" })}`, "chatgpt-account-id": "synthetic-account" }, body: '{"query":"synthetic"}' }), cfg, { dispatchRequest: request });
  if (response.status !== 200) throw new Error(await response.text());
  const folded = foldDispatchEvents(events);
  expect(folded.sends).toHaveLength(1);
  expect(folded.sends[0]?.start.metadata?.surface).toBe("search");
  expect(folded.sends[0]?.start.metadata?.routeRef).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(events)).not.toContain("synthetic-private-provider");
  expect(JSON.stringify(events)).not.toContain("Bearer");
  expect(folded.sends[0]?.start.metadata?.accountRef).toBeUndefined();
});

import { sendLiveInferenceFrame, closeLiveInferenceObservation } from "../src/usage/dispatch-live";

test("live sideband counts explicit creates once at final send; tool/control/audio frames are excluded", () => {
  const { events, request } = accounting();
  const owner = {};
  const frames = ['{"type":"response.create"}', '{"type":"session.update"}', '{"type":"input_audio_buffer.append","audio":"synthetic"}', '{"type":"conversation.item.create","item":{"type":"function_call_output"}}'];
  const sent: string[] = [];
  for (const frame of frames) sendLiveInferenceFrame(owner, frame, () => { sent.push(frame); }, request);
  expect(sent).toEqual(frames);
  expect(foldDispatchEvents(events).sends).toHaveLength(1);
  closeLiveInferenceObservation(owner, true);
  const folded = foldDispatchEvents(events);
  expect(folded.sends[0]?.outcome).toBe("unknown");
  expect(folded.sends[0]?.clientCancelled).toBe(true);
  expect(folded.sends[0]?.upstreamCancelled).toBe(false);
});

test("live sideband reconnect sends count independently and write errors preserve original error", () => {
  const { events, request } = accounting();
  const error = new Error("synthetic disconnect");
  expect(() => sendLiveInferenceFrame({}, '{"type":"response.create"}', () => { throw error; }, request)).toThrow(error);
  const reconnected = {};
  sendLiveInferenceFrame(reconnected, '{"type":"response.create"}', () => {}, request);
  closeLiveInferenceObservation(reconnected);
  expect(foldDispatchEvents(events).sends.map(send => send.outcome)).toEqual(["transport_failure", "unknown"]);
});

// Executable coverage inventory. Every direct fetch in these U3 surfaces must be classified;
// adding a leaf changes the AST count and fails this test until its evidence is reviewed.
// Shared Responses/chat/messages/compact/combo leaves are tested in dispatch-http.test.ts.
import ts from "typescript";
const surfaceInventory = [
  { file: "src/adapters/command-code.ts", observed: 1, excluded: 0, evidence: "tests/command-code-provider.test.ts", classification: "fetchCommandCode final injected executor; outer effort retry calls it twice. Catalog refresh is owned by command-code-models, not inference." },
  { file: "src/adapters/mimo-free.ts", observed: 2, excluded: 1, evidence: "tests/mimo-free-provider.test.ts", classification: "two inference POST sites; raw fetchJwt bootstrap is credential acquisition, excluded" },
  { file: "src/vision/describe.ts", observed: 1, excluded: 0, evidence: "tests/dispatch-surfaces.test.ts", classification: "uncached vision description under reset retry; cache hit executes no leaf" },
  { file: "src/vision/anthropic-describe.ts", observed: 1, excluded: 0, evidence: "tests/vision-anthropic.test.ts", classification: "Anthropic description inference; OAuth acquisition is excluded" },
  { file: "src/web-search/executor.ts", observed: 1, excluded: 0, evidence: "tests/dispatch-surfaces.test.ts", classification: "Responses search generation under reset retry" },
  { file: "src/web-search/anthropic-executor.ts", observed: 1, excluded: 0, evidence: "tests/web-search-anthropic.test.ts", classification: "Anthropic search generation; OAuth acquisition excluded" },
  { file: "src/web-search/loop.ts", observed: 1, excluded: 0, evidence: "tests/web-search.test.ts", classification: "fallback executor observed once; custom adapter calls carry scope, parser owns terminal evidence" },
  { file: "src/server/images.ts", observed: 2, excluded: 0, evidence: "tests/server-images.test.ts", classification: "ordinary opaque Images POST and Google internal generateContent are inference; auth/project discovery excluded" },
  { file: "src/server/search.ts", observed: 1, excluded: 0, evidence: "tests/server-search.test.ts", classification: "standalone alpha/search POST; exact selectors retain credential policy and only provider alias" },
  { file: "src/server/live.ts", observed: 0, excluded: 1, evidence: "tests/server-live.test.ts", classification: "SDP realtime/calls session negotiation is control, not a proven inference send" },
  { file: "src/server/ws-bridge.ts", observed: 0, excluded: 0, evidence: "tests/ws-endpoint.test.ts", classification: "Responses WS ingress/egress only; handleResponses owns its final internal sends; warmup generate:false has none" },
  { file: "src/codex/warmup.ts", observed: 1, excluded: 0, evidence: "tests/dispatch-validation.test.ts", classification: "warmup is real generation; fallback models retain separate targets" },
  { file: "src/oauth/key-providers.ts", observed: 1, excluded: 2, evidence: "tests/dispatch-validation.test.ts", classification: "Anthropic messages ping is inference; Google and generic models GET are catalog-only exclusions" },
] as const;

test("all direct HTTP leaves in the U3 inventory have inference or source-backed exclusion evidence", async () => {
  for (const row of surfaceInventory) {
    const text = await Bun.file(join(root, row.file)).text();
    const tree = ts.createSourceFile(row.file, text, ts.ScriptTarget.Latest, true);
    let observed = 0;
    let excluded = 0;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(tree);
        if (name === "dispatchHttpFetch") observed++;
        if (name === "fetch" || name === "globalThis.fetch") excluded++;
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    expect({ file: row.file, observed, excluded }).toEqual({ file: row.file, observed: row.observed, excluded: row.excluded });
    expect(row.classification.length).toBeGreaterThan(20);
    expect(await Bun.file(join(root, row.evidence)).exists()).toBe(true);
  }
});

test("native frame leaves and named non-inference exclusions remain classified", async () => {
  const cursorFile = "src/adapters/cursor/live-transport.ts";
  const cursorText = await Bun.file(join(root, cursorFile)).text();
  const cursorTree = ts.createSourceFile(cursorFile, cursorText, ts.ScriptTarget.Latest, true);
  const writes: string[] = [];
  function visitCursor(node: ts.Node) {
    if (ts.isCallExpression(node) && /this\.stream\??\.write$/.test(node.expression.getText(cursorTree))) writes.push(node.arguments[0]?.getText(cursorTree) ?? "");
    ts.forEachChild(node, visitCursor);
  }
  visitCursor(cursorTree);
  // Initial inference, client heartbeat, KV response, native exec replies, interaction response.
  expect(writes).toHaveLength(5);
  expect(writes.filter(value => value === "initialFrame")).toHaveLength(1);
  expect(cursorText).toContain('this.input.dispatch?.attempt?.start(');

  const serverFile = "src/server/index.ts";
  const serverText = await Bun.file(join(root, serverFile)).text();
  const serverTree = ts.createSourceFile(serverFile, serverText, ts.ScriptTarget.Latest, true);
  let upstreamWrites = 0;
  function visitServer(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(serverTree) === "upstream.send") {
      upstreamWrites++;
      let ancestor: ts.Node | undefined = node.parent;
      while (ancestor && !(ts.isCallExpression(ancestor) && ancestor.expression.getText(serverTree) === "sendLiveInferenceFrame")) ancestor = ancestor.parent;
      expect(ancestor).toBeDefined();
    }
    ts.forEachChild(node, visitServer);
  }
  visitServer(serverTree);
  expect(upstreamWrites).toBe(2); // queued and already-open final sideband writes

  const exclusions = [
    ["src/adapters/cursor/live-models.ts", "GetUsableModels", "catalog discovery, not inference"],
    ["src/codex/auth-api.ts", "/wham/usage", "quota polling, not inference"],
    ["src/oauth/chatgpt.ts", "TOKEN_URL", "OAuth exchange/refresh, not inference"],
    ["src/server/management/logs-usage-routes.ts", "usage", "management log/usage reads, not inference"],
    ["src/server/claude-messages.ts", "/v1/messages/count_tokens", "token counting without generation"],
    ["src/adapters/mimo-free.ts", "BOOTSTRAP_URL", "JWT bootstrap, not chat generation"],
  ];
  for (const [file, boundary, reason] of exclusions) {
    expect(await Bun.file(join(root, file!)).text()).toContain(boundary!);
    expect(reason!.length).toBeGreaterThan(10);
  }
});


test("live observation byte limit includes UTF-8 expansion without changing delivery", () => {
  const events: DispatchEvent[] = [];
  const request = createDispatchRequest(event => events.push(event));
  const frame = JSON.stringify({ type: "response.create", input: "界".repeat(400_000) });
  let delivered = false;
  sendLiveInferenceFrame({}, frame, () => { delivered = true; }, request);
  expect(delivered).toBe(true);
  expect(events.filter(event => event.kind === "start")).toHaveLength(0);
});


test("unclassifiable live frames reduce observer coverage without changing delivery", () => {
  const before = dispatchObserverHealth().observerFailures;
  let calls = 0;
  sendLiveInferenceFrame({}, "{invalid", () => { calls++; });
  expect(calls).toBe(1);
  expect(dispatchObserverHealth().observerFailures).toBe(before + 1);
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearResponseStateMemoryForTests, flushResponseState } from "../src/responses/state";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { nativeOwner, rememberNativeArtifacts } from "../src/codex/native-ownership";
import { nativeRequestOwner } from "../src/responses/native-policy";
import { noteSubagentModelFailure, resetSubagentModelFallbackStateForTests, setSubagentQuotaPrimeForTests } from "../src/codex/subagent-model-fallback";
import { selectForwardHeaders } from "../src/server/ws-bridge";
import { handleResponses, handleResponsesCompact } from "../src/server/responses";
import type { CodexCommanderConfig } from "../src/types";
const originalFetch = globalThis.fetch;
const originalHome = process.env.CODEXCOMMANDER_HOME;
const originalCodexHome = process.env.CODEX_HOME;
const dirs: string[] = [];
afterEach(() => resetSubagentModelFallbackStateForTests());
afterEach(async () => { await flushResponseState(); clearResponseStateMemoryForTests(); globalThis.fetch = originalFetch; if (originalHome === undefined) delete process.env.CODEXCOMMANDER_HOME; else process.env.CODEXCOMMANDER_HOME = originalHome; if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function config(): CodexCommanderConfig {
 const dir = mkdtempSync(join(tmpdir(), "ccx-native-policy-")); dirs.push(dir); process.env.CODEXCOMMANDER_HOME = dir; process.env.CODEX_HOME = dir;
 return { port: 0, defaultProvider: "openai", multiAgentGuidanceEnabled: false, providers: { openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct", baseUrl: "https://chatgpt.com/backend-api/codex" } } } as CodexCommanderConfig;
}
function request(body: unknown, headers: Record<string,string> = {}) { return new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-native-token", ...headers }, body: JSON.stringify(body) }); }
for (const compact of [false, true]) test(`native ${compact ? "compact" : "responses"} ingress preserves opaque history and native metadata in one send`, async () => {
 const cfg = config(); const sends: { body: any; headers: Headers }[] = [];
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { sends.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) }); return Response.json({ id: "resp_native", object: "response", status: "completed", output: [] }); }) as typeof fetch;
 const body = { model: "openai/gpt-5.4", stream: false, store: false, service_tier: "priority", input: [{ type: "reasoning", id: "rs_native", encrypted_content: "opaque-ciphertext", summary: [], content: [{ type: "reasoning_text", text: "readable history" }] }, { type: "message", id: "msg_native", role: "user", content: [{ type: "input_text", text: "continue" }] }], client_metadata: { thread_id: "own-task" }, include: ["reasoning.encrypted_content"] };
 const response = await (compact ? handleResponsesCompact : handleResponses)(request(body, { "x-codex-routing-hint": "model=gpt-5.4;tier=priority", "x-openai-internal-codex-responses-lite": "true", "x-openai-memgen-request": "true", "user-agent": "codex-native-fixture" }), cfg, {});
 expect(response.status).toBe(200); await response.text(); expect(sends).toHaveLength(1); expect(sends[0]!.body.input).toEqual(body.input); expect(sends[0]!.body.client_metadata).toEqual(body.client_metadata); expect(sends[0]!.headers.get("x-codex-routing-hint")).toBe("model=gpt-5.4;tier=priority");
 for (const name of ["x-openai-internal-codex-responses-lite", "x-openai-memgen-request"]) expect(sends[0]!.headers.get(name)).toBe("true");
 expect(sends[0]!.headers.get("user-agent")).toBe("codex-native-fixture");
});
test("unknown turn state is omitted without replay or an extra send", async () => {
 const cfg = config(); let sends = 0; globalThis.fetch = (async (_url: unknown, init: RequestInit) => { sends++; expect(new Headers(init.headers).has("x-codex-turn-state")).toBe(false); return Response.json({ status: "completed", output: [] }); }) as typeof fetch;
 const response = await handleResponses(request({ model: "openai/gpt-5.4", input: "continue", stream: false }, { "x-codex-turn-state": "foreign-state" }), cfg, {});
 expect(response.status).toBe(200); expect(sends).toBe(1);
});

for (const compact of [false, true]) test(`native ${compact ? "compact" : "responses"} preserves ciphertext from another account and omits stale routing hints`, async () => {
 const cfg = config(); const input = [{ type: "reasoning", encrypted_content: "foreign-native-ciphertext", summary: [] }, { role: "user", content: "continue" }];
 rememberNativeArtifacts({ output: input }, undefined, nativeOwner("another-account", "old-generation"));
 let sends = 0;
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { sends++; const wire = JSON.parse(String(init.body)); expect(wire.input).toEqual(input); expect(new Headers(init.headers).has("x-codex-routing-hint")).toBe(false); return Response.json({ id: "resp_switch", status: "completed", output: [] }); }) as typeof fetch;
 const response = await (compact ? handleResponsesCompact : handleResponses)(request({ model: "openai/gpt-5.4", stream: false, input }, { "x-codex-routing-hint": "model=old-model;tier=priority" }), cfg, {});
 expect(response.status).toBe(200); await response.text(); expect(sends).toBe(1);
});

test("same task can materialize a native HTTP reference after account switch and restart; sibling cannot", async () => {
 const cfg = config(); const sent: any[] = [];
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return Response.json({ id: `resp_chain_${sent.length}`, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "prior answer" }] }] }); }) as typeof fetch;
 const first = await handleResponses(request({ model: "openai/gpt-5.4", stream: false, input: [{ role: "user", content: "initial history" }], client_metadata: { thread_id: "task-a" } }), cfg, {}); await first.text();
 await flushResponseState(); clearResponseStateMemoryForTests();
 const sibling = await handleResponses(request({ model: "openai/gpt-5.4", stream: false, input: "new question", previous_response_id: "resp_chain_1", client_metadata: { thread_id: "task-b", parent_thread_id: "task-a" } }), cfg, {});
 expect(sibling.status).toBe(409); expect(sent).toHaveLength(1);
 const continuation = await handleResponses(request({ model: "openai/gpt-5.4", stream: false, input: "new question", previous_response_id: "resp_chain_1", client_metadata: { thread_id: "task-a" } }, { authorization: "Bearer switched-native-token" }), cfg, {});
 expect(continuation.status).toBe(200); await continuation.text(); expect(sent).toHaveLength(2); expect(sent[1].previous_response_id).toBeUndefined(); expect(sent[1].input).toHaveLength(3); expect(sent[1].input[0].content).toBe("initial history");
});

test("native API known reference passes once without local replay; foreign missing reference is unavailable", async () => {
 const cfg = config(); cfg.defaultProvider = "openai-apikey"; cfg.providers = { "openai-apikey": { adapter: "openai-responses", authMode: "key", apiKey: "fixture-api-key", baseUrl: "https://api.openai.com/v1" } };
 const sent: any[] = [];
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return Response.json({ id: `resp_api_${sent.length}`, status: "completed", output: [] }); }) as typeof fetch;
 let response = await handleResponses(request({ model: "openai-apikey/gpt-5.4", stream: false, input: "first" }), cfg, {}); await response.text();
 response = await handleResponses(request({ model: "openai-apikey/gpt-5.4", stream: false, input: "delta", previous_response_id: "resp_api_1" }), cfg, {}); expect(response.status).toBe(200); await response.text();
 expect(sent).toHaveLength(2); expect(sent[1].input).toBe("delta"); expect(sent[1].previous_response_id).toBe("resp_api_1");
 response = await handleResponses(request({ model: "openai-apikey/gpt-5.4", stream: false, input: "delta", previous_response_id: "unavailable-reference" }), cfg, {}); expect(response.status).toBe(409); expect(sent).toHaveLength(2);
});

test("native sticky state stays within its issuing turn, including bridge ingress", async () => {
 const cfg = config(); const seen: Headers[] = [];
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { seen.push(new Headers(init.headers)); return Response.json({ id: `resp_turn_${seen.length}`, status: "completed", output: [] }, { headers: { "x-codex-turn-state": "issued-turn-token" } }); }) as typeof fetch;
 for (const [turn, token] of [["turn-a", undefined], ["turn-a", "issued-turn-token"], ["turn-b", "issued-turn-token"]]) {
  const headers = selectForwardHeaders(new Headers({ authorization: "Bearer test-native-token", "x-codex-turn-metadata": JSON.stringify({ turn_id: turn }), "x-openai-internal-codex-responses-lite": "true", ...(token ? { "x-codex-turn-state": token } : {}) }));
  const response = await handleResponses(request({ model: "openai/gpt-5.4", stream: false, input: "continue" }, Object.fromEntries(headers)), cfg, {}, { inboundTransport: "websocket" }); expect(response.status).toBe(200); await response.text();
 }
 expect(seen).toHaveLength(3); expect(seen[0]!.has("x-codex-turn-state")).toBe(false); expect(seen[1]!.get("x-codex-turn-state")).toBe("issued-turn-token"); expect(seen[2]!.has("x-codex-turn-state")).toBe(false); expect(seen.every(h => h.get("x-openai-internal-codex-responses-lite") === "true")).toBe(true);
});

for (const compact of [false, true]) test(`native ${compact ? "compact" : "responses"} exact second account returns opaque rejection without retry or stripping`, async () => {
 const cfg = config(); cfg.codexAccounts = [{ id: "second", email: "second@example.test", logLabel: "p000002", isMain: false, chatgptAccountId: "second-wire" }]; cfg.codexAccountNamespaces = { side: "second" };
 saveCodexAccountCredential("second", { accessToken: "second-fixture-token", refreshToken: "second-fixture-refresh", expiresAt: Date.now() + 300_000, chatgptAccountId: "second-wire" });
 const input = [{ type: "reasoning", id: "rs_native", encrypted_content: "foreign-ciphertext", summary: [] }, { role: "user", content: "continue" }]; let sends = 0;
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { sends++; const wire = JSON.parse(String(init.body)); expect(wire.model).toBe("gpt-5.4"); expect(wire.input).toEqual(input); expect(new Headers(init.headers).get("authorization")).toBe("Bearer second-fixture-token"); return Response.json({ error: { message: "encrypted content rejected" } }, { status: 400 }); }) as typeof fetch;
 const response = await (compact ? handleResponsesCompact : handleResponses)(request({ model: "side/gpt-5.4", stream: false, input }), cfg, {}); expect(response.status).toBe(400); expect(await response.text()).toContain("encrypted content rejected"); expect(sends).toBe(1);
});

test("proxy envelopes receive narrow repair without changing native siblings", async () => {
 const cfg = config(); const nativeItem = { type: "reasoning", id: "rs_keep", encrypted_content: "opaque-native", content: [{ type: "reasoning_text", text: "native-readable" }], summary: [] };
 let wire: any;
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { wire = JSON.parse(String(init.body)); return Response.json({ id: "resp_mixed", status: "completed", output: [] }); }) as typeof fetch;
 const response = await handleResponses(request({ model: "openai/gpt-5.4", stream: false, input: [nativeItem, { type: "reasoning", encrypted_content: "ccxr1:fixture", content: [{ type: "reasoning_text", text: "translated" }] }, { role: "user", content: "continue" }] }), cfg, {}); expect(response.status).toBe(200); await response.text(); expect(wire.input[0]).toEqual(nativeItem); expect(wire.input[1].encrypted_content).toBeUndefined();
});

for (const compact of [false, true]) test(`native ${compact ? "compact" : "responses"} preserves model-only routing hint when service tier is absent`, async () => {
 const cfg = config(); let sends = 0;
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { sends++; expect(new Headers(init.headers).get("x-codex-routing-hint")).toBe("model=gpt-5.4"); expect(JSON.parse(String(init.body)).service_tier).toBeUndefined(); return Response.json({ id: "resp_hint_only", status: "completed", output: [] }); }) as typeof fetch;
 const response = await (compact ? handleResponsesCompact : handleResponses)(request({ model: "openai/gpt-5.4", stream: false, input: "hello" }, { "x-codex-routing-hint": "model=gpt-5.4" }), cfg, {});
 expect(response.status).toBe(200); await response.text(); expect(sends).toBe(1);
});

test("same-account canonical continuation with full input never appends cached history", async () => {
 const cfg = config(); const sent: any[] = [];
 const initial = { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] };
 const reply = { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] };
 const full = [initial, reply, { type: "reasoning", id: "rs_full", encrypted_content: "opaque-full", summary: [] }, { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }];
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return Response.json({ id: `resp_full_${sent.length}`, status: "completed", output: [reply] }); }) as typeof fetch;
 let response = await handleResponses(request({ model: "openai/gpt-5.4", stream: false, input: [initial], client_metadata: { thread_id: "same-native-task" } }), cfg, {}); await response.text();
 response = await handleResponses(request({ model: "openai/gpt-5.4", stream: false, input: full, client_metadata: { thread_id: "same-native-task" } }), cfg, {}); expect(response.status).toBe(200); await response.text();
 expect(sent).toHaveLength(2); expect(sent[1].input).toEqual(full); expect(sent[1].previous_response_id).toBeUndefined();
});


test("native API provenance fingerprints the resolved environment credential", () => {
 const previous = process.env.CCX_NATIVE_POLICY_TEST_KEY;
 const provider = { adapter: "openai-responses", authMode: "key" as const, apiKey: "$CCX_NATIVE_POLICY_TEST_KEY", baseUrl: "https://api.openai.com/v1" };
 try {
  process.env.CCX_NATIVE_POLICY_TEST_KEY = "native-env-key-first";
  const first = nativeRequestOwner(provider, new Headers());
  expect(first).toEqual(nativeRequestOwner({ ...provider, apiKey: "native-env-key-first" }, new Headers()));
  process.env.CCX_NATIVE_POLICY_TEST_KEY = "native-env-key-second";
  expect(nativeRequestOwner(provider, new Headers())).not.toEqual(first);
  delete process.env.CCX_NATIVE_POLICY_TEST_KEY;
  expect(nativeRequestOwner(provider, new Headers())).toBeUndefined();
 } finally {
  if (previous === undefined) delete process.env.CCX_NATIVE_POLICY_TEST_KEY;
  else process.env.CCX_NATIVE_POLICY_TEST_KEY = previous;
 }
});

for (const destination of ["explicit", "fallback", "wire-override"]) test(`native history remains scoped and complete on ${destination} external route`, async () => {
 const fallback = destination !== "explicit";
 const wireOverride = destination === "wire-override";
 const cfg = config();
 cfg.providers.external = { adapter: wireOverride ? "openai-responses" : "openai-chat", authMode: "key", apiKey: "fixture-key", baseUrl: wireOverride ? "https://api.openai.com/v1" : "https://external.example.test/v1", ...(wireOverride ? { modelAdapters: { fixture: "openai-chat" } } : {}) };
 cfg.subagentModelFallback = ["external/fixture"];
 const sent: { url: string; body: any }[] = [];
 globalThis.fetch = (async (url: unknown, init: RequestInit) => {
  sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
  return String(url).includes("/chat/completions")
   ? Response.json({ id: "chat_fixture", choices: [{ message: { role: "assistant", content: "continued" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
   : Response.json({ id: "resp_scoped", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "prior answer" }] }] });
 }) as typeof fetch;
 await (await handleResponses(request({ model: "gpt-5.4", stream: false, input: "initial history", client_metadata: { thread_id: "owner-task" } }), cfg, {})).text();
 if (fallback) {
  setSubagentQuotaPrimeForTests(async () => {});
  noteSubagentModelFailure("gpt-5.4", "429", cfg);
 }
 const next = (task?: string, reference = "resp_scoped") => request({ model: fallback ? "gpt-5.4" : "external/fixture", stream: false, input: "new question", previous_response_id: reference,
  ...(task ? { client_metadata: { thread_id: task } } : {}) }, fallback ? { "x-openai-subagent": "collab_spawn" } : {});
 for (const task of ["sibling-task", undefined]) {
  const rejected = await handleResponses(next(task), cfg, {});
  expect(rejected.status).toBe(409); expect(sent).toHaveLength(1);
 }
 if (fallback) {
  expect((await handleResponses(next("owner-task", "missing-reference"), cfg, {})).status).toBe(409);
  expect(sent).toHaveLength(1);
 }
 const continued = await handleResponses(next("owner-task"), cfg, {});
 expect(continued.status).toBe(200); await continued.text(); expect(sent).toHaveLength(2);
 expect(sent[1]!.url).toContain("/chat/completions");
 const wire = JSON.stringify(sent[1]!.body.messages);
 expect(wire).toContain("initial history"); expect(wire).toContain("prior answer"); expect(wire).toContain("new question");
});


test("native full-input tool continuations keep roster guidance in the stable initial block", async () => {
 const cfg = config(); cfg.multiAgentGuidanceEnabled = true; cfg.subagentModels = [{ model: "gpt-5.4" }];
 const oldState = process.env.CCX_APP_SERVER_CATALOG_STATE_OVERRIDE;
 process.env.CCX_APP_SERVER_CATALOG_STATE_OVERRIDE = "fresh";
 writeFileSync(join(process.env.CODEX_HOME!, "codexcommander-catalog.json"), JSON.stringify({ models: [{ slug: "gpt-5.4", visibility: "list", priority: 0, multi_agent_version: "v2", supported_reasoning_levels: [{ effort: "low", description: "low" }] }] }));
 const sent: any[] = [];
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return Response.json({ id: `resp_guidance_${sent.length}`, status: "completed", output: [] }); }) as typeof fetch;
 const initial = [{ type: "message", role: "developer", content: [{ type: "input_text", text: "Client policy" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "Game spec" }] }];
 try {
  for (let turn = 0; turn < 3; turn++) {
   const input = [...initial, ...Array.from({ length: turn }, (_, i) => [{ type: "custom_tool_call", call_id: `call_${i}`, name: "fixture", input: "read" }, { type: "custom_tool_call_output", call_id: `call_${i}`, output: `test result ${i}` }]).flat()];
   const response = await handleResponses(request({ model: "gpt-5.4", stream: false, input, tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } }] }), cfg, {});
   expect(response.status).toBe(200); await response.text();
   expect(sent).toHaveLength(turn + 1);
   expect(sent[turn].input[1].role).toBe("developer");
   expect(sent[turn].input[1].content[0].text).toContain("<multi_agent_mode>");
   expect(sent[turn].input.at(-1)).toEqual(input.at(-1));
   if (turn) expect(sent[turn].input.slice(0, sent[turn - 1].input.length)).toEqual(sent[turn - 1].input);
  }
 } finally {
  if (oldState === undefined) delete process.env.CCX_APP_SERVER_CATALOG_STATE_OVERRIDE;
  else process.env.CCX_APP_SERVER_CATALOG_STATE_OVERRIDE = oldState;
 }
});

test("native reference tool continuations reuse stored guidance exactly once", async () => {
 const cfg = config(); cfg.multiAgentGuidanceEnabled = true; cfg.subagentModels = [{ model: "gpt-5.4" }];
 const oldState = process.env.CCX_APP_SERVER_CATALOG_STATE_OVERRIDE;
 process.env.CCX_APP_SERVER_CATALOG_STATE_OVERRIDE = "fresh";
 writeFileSync(join(process.env.CODEX_HOME!, "codexcommander-catalog.json"), JSON.stringify({ models: [{ slug: "gpt-5.4", visibility: "list", priority: 0, multi_agent_version: "v2", supported_reasoning_levels: [{ effort: "low", description: "low" }] }] }));
 const sent: any[] = [];
 globalThis.fetch = (async (_url: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return Response.json({ id: `resp_guidance_${sent.length}`, status: "completed", output: [{ type: "custom_tool_call", call_id: `call_${sent.length-1}`, name: "fixture", input: "read" }] }); }) as typeof fetch;
 const initial = [{ type: "message", role: "developer", content: [{ type: "input_text", text: "Client policy" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "Game spec" }] }];
 try {
  for (let turn = 0; turn < 3; turn++) {
   const input = turn === 0 ? initial : [{ type: "custom_tool_call_output", call_id: `call_${turn-1}`, output: `test result ${turn-1}` }];
   const response = await handleResponses(request({ model: "gpt-5.4", stream: false, input, ...(turn ? { previous_response_id: `resp_guidance_${turn}` } : {}), client_metadata: { thread_id: "guidance-reference-fixture" }, tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } }] }), cfg, {});
   expect(response.status).toBe(200); await response.text();
   expect(sent).toHaveLength(turn + 1);
   expect(sent[turn].input.filter((item: any) => item.role === "developer" && JSON.stringify(item.content).includes("<multi_agent_mode>")).length).toBe(1);
   expect(sent[turn].input[1].role).toBe("developer");
   expect(sent[turn].input[1].content[0].text).toContain("<multi_agent_mode>");
   expect(sent[turn].input.at(-1)).toEqual(input.at(-1));
   if (turn) expect(sent[turn].input.slice(0, sent[turn - 1].input.length)).toEqual(sent[turn - 1].input);
   if (turn === 0) { await flushResponseState(); clearResponseStateMemoryForTests(); }
  }
 } finally {
  if (oldState === undefined) delete process.env.CCX_APP_SERVER_CATALOG_STATE_OVERRIDE;
  else process.env.CCX_APP_SERVER_CATALOG_STATE_OVERRIDE = oldState;
 }
});

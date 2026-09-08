import { create, toBinary } from "@bufbuild/protobuf";
import { AgentServerMessageSchema, InteractionUpdateSchema } from "../src/adapters/cursor/gen/agent_pb";
import { EventEmitter } from "node:events";
import { createCursorProtobufEventState } from "../src/adapters/cursor/protobuf-events";
import type { DispatchSend } from "../src/usage/dispatch";
import http2 from "node:http2";
import { describe, expect, spyOn, test } from "bun:test";
import { createLiveCursorTransport } from "../src/adapters/cursor/live-transport";
import { encodeConnectFrame, CONNECT_FLAG_END_STREAM } from "../src/adapters/cursor/framing";
import { createDispatchRequest, type DispatchEvent } from "../src/usage/dispatch";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

async function fixture(payload: Uint8Array) {
  const events: DispatchEvent[] = [];
  const server = http2.createServer();
  let received = 0;
  server.on("stream", stream => {
    stream.on("data", chunk => { received += chunk.length; });
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    stream.end(payload);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const transport = createLiveCursorTransport({
    provider: { adapter: "cursor", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-token" },
    translatorBudget: createTestTranslatorBudget(),
    dispatch: { attempt: createDispatchRequest(event => events.push(event)).attempt() },
  });
  let failure: unknown;
  const messages = [];
  try {
    for await (const message of transport.run({ modelId: "composer-2", conversationId: "fixture", system: [], messages: [{ role: "user", content: "hello" }] })) messages.push(message);
  } catch (error) { failure = error; }
  finally {
    await transport.close?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return { events, messages, failure, received };
}

describe("Cursor dispatch at native run frame", () => {
  test("characterizes complete empty protobuf frame EOF without inventing done", async () => {
    const result = await fixture(encodeConnectFrame(new Uint8Array()));
    expect(result.failure).toBeUndefined();
    expect(result.messages).toEqual([]);
    expect(result.received).toBeGreaterThan(0);
    expect(result.events.filter(event => event.kind === "start")).toHaveLength(1);
    expect(result.events.find(event => event.kind === "terminal")?.outcome).toBe("unknown");
  });
  test("Connect success envelope without turnEnded remains unknown", async () => {
    const result = await fixture(encodeConnectFrame(new TextEncoder().encode("{}"), { flags: CONNECT_FLAG_END_STREAM }));
    expect(result.failure).toBeUndefined();
    expect(result.events.find(event => event.kind === "terminal")?.outcome).toBe("unknown");
  });
  test("actual provider turnEnded proves semantic completion", async () => {
    const payload = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message: { case: "turnEnded", value: {} } }) },
    }));
    const result = await fixture(encodeConnectFrame(payload));
    expect(result.failure).toBeUndefined();
    expect(result.messages.some(message => message.type === "done")).toBe(true);
    expect(result.events.find(event => event.kind === "terminal")?.outcome).toBe("protocol_success");
  });
  test("Connect error trailer beats subsequent EOF", async () => {
    const result = await fixture(encodeConnectFrame(new TextEncoder().encode('{"error":{"code":"invalid_argument"}}'), { flags: CONNECT_FLAG_END_STREAM }));
    expect(result.failure).toBeDefined();
    expect(result.events.filter(event => event.kind === "terminal").map(event => event.outcome)).toEqual(["protocol_failure"]);
  });
});


test("initial write invocation counts even if it throws before h2 commit; later writes are excluded", async () => {
  const events: DispatchEvent[] = [];
  let writes = 0;
  const stream = Object.assign(new EventEmitter(), {
    write() { writes++; throw new Error("write failure fixture"); }, close() {},
  });
  const session = Object.assign(new EventEmitter(), { request: () => stream, close() {} });
  const dial = spyOn(http2, "connect").mockReturnValue(session as unknown as http2.ClientHttp2Session);
  const transport = createLiveCursorTransport({ provider: { adapter: "cursor", apiKey: "test-token" }, translatorBudget: createTestTranslatorBudget(), dispatch: { attempt: createDispatchRequest(event => events.push(event)).attempt() } });
  try {
    await expect((async () => {
      for await (const _message of transport.run({ modelId: "composer-2", conversationId: "fixture", system: [], messages: [] })) { /* existing consumer */ }
    })()).rejects.toThrow("write failure fixture");
    expect(writes).toBe(1);
    expect(transport.requestCommitted?.()).toBe(false);
    expect(events.filter(event => event.kind === "start")).toHaveLength(1);
    expect(events.find(event => event.kind === "terminal")?.outcome).toBe("transport_failure");
    await transport.writeClient({ type: "kv_stored", key: "fixture" });
    expect(events.filter(event => event.kind === "start")).toHaveLength(1);
  } finally { await transport.close?.(); dial.mockRestore(); }
});

test("checkpoint usage stays cumulative context and never becomes additive input spend", () => {
  const events: DispatchEvent[] = [];
  const transport = createLiveCursorTransport({ provider: { adapter: "cursor", apiKey: "test-token" }, translatorBudget: createTestTranslatorBudget() });
  const internal = transport as unknown as { dispatchSend: DispatchSend; observeUsage(state: ReturnType<typeof createCursorProtobufEventState>): void };
  internal.dispatchSend = createDispatchRequest(event => events.push(event)).attempt().start();
  const state = createCursorProtobufEventState();
  state.contextTokens = 1200;
  state.usage.outputTokens = 30;
  internal.observeUsage(state);
  expect(events.find(event => event.kind === "usage")?.usage).toEqual({ provenance: "cumulative", completeness: "partial", contextTotalTokens: 1200 });
});

test("preparation failure cannot create a send", async () => {
  const events: DispatchEvent[] = [];
  const transport = createLiveCursorTransport({ provider: { adapter: "cursor", apiKey: "test-token" }, translatorBudget: createTestTranslatorBudget(), dispatch: { attempt: createDispatchRequest(event => events.push(event)).attempt() } });
  (transport as unknown as { prepareMcp(): Promise<void> }).prepareMcp = async () => { throw new Error("preparation fixture"); };
  await expect((async () => { for await (const _message of transport.run({ modelId: "composer-2", conversationId: "fixture", system: [], messages: [] })) {} })()).rejects.toThrow("preparation fixture");
  expect(events.filter(event => event.kind === "start")).toHaveLength(0);
});

test("offline reconnect fixture counts both final write invocations but only one peer request", async () => {
  const { runCursorReconnectFixture } = await import("./helpers/cursor-dispatch-fixture");
  const result = await runCursorReconnectFixture();
  expect(result.requestCount).toBe(2);
  expect(result.attemptCount).toBe(2);
  expect(result.peerRequests).toBe(1);
  expect(result.sendCount).toBe(2);
  expect(result.outcomes).toEqual(["transport_failure", "protocol_success"]);
  expect(result.reasons).toEqual(["initial", "retry"]);
});

test("local tool suspension records cancellation without claiming provider success", async () => {
  const events: DispatchEvent[] = [];
  const transport = createLiveCursorTransport({ provider: { adapter: "cursor", apiKey: "test-token" }, translatorBudget: createTestTranslatorBudget() });
  const internal = transport as unknown as { dispatchSend: DispatchSend; cancelCursorRun(): void };
  internal.dispatchSend = createDispatchRequest(event => events.push(event)).attempt().start();
  internal.cancelCursorRun();
  await transport.close?.();
  expect(events.filter(event => event.kind === "terminal").map(event => event.outcome)).toEqual(["unknown"]);
  expect(events.filter(event => event.kind === "cancel").map(event => event.cancellation)).toEqual(["upstream"]);
});

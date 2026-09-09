import { create, toBinary } from "@bufbuild/protobuf";
import { AgentServerMessageSchema, InteractionUpdateSchema } from "../../src/adapters/cursor/gen/agent_pb";
import { encodeConnectFrame } from "../../src/adapters/cursor/framing";
import http2 from "node:http2";
import { EventEmitter } from "node:events";
import { spyOn } from "bun:test";
import { createDispatchRequest, type DispatchEvent } from "../../src/usage/dispatch";
import { createTranslatorBudget } from "../../src/lib/translator-budget";

/** Offline production-path reconnect fixture. sourceRoot may select an isolated baseline checkout. */
export async function runCursorReconnectFixture(sourceRoot = process.cwd()) {
  const { createLiveCursorTransport } = await import(`${sourceRoot}/src/adapters/cursor/live-transport.ts`);
  const { runCursorTurnWithRetry } = await import(`${sourceRoot}/src/adapters/cursor/transport-retry.ts`);
  const events: DispatchEvent[] = [];
  const translatorBudget = createTranslatorBudget();
  let requestCount = 0;
  let attemptCount = 0;
  let peerRequests = 0;
  const server = http2.createServer();
  server.on("stream", stream => {
    peerRequests++;
    stream.on("data", () => {});
    (stream as http2.ServerHttp2Stream).respond({ ":status": 200, "content-type": "application/connect+proto" });
    const terminal = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message: { case: "turnEnded", value: {} } }) },
    }));
    stream.end(Buffer.concat([Buffer.from(encodeConnectFrame(terminal)), Buffer.from([2, 0, 0, 0, 2, 123, 125])]));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const connect = http2.connect.bind(http2);
  let dials = 0;
  const dial = spyOn(http2, "connect").mockImplementation(((...args: Parameters<typeof http2.connect>) => {
    if (dials++ === 0) {
      const stream = Object.assign(new EventEmitter(), {
        write() { requestCount++; throw new Error("fixture ECONNRESET before connect"); }, close() {},
      });
      return Object.assign(new EventEmitter(), { request: () => stream, close() {} }) as unknown as http2.ClientHttp2Session;
    }
    const session = connect(...args);
    const request = session.request.bind(session);
    session.request = ((...requestArgs: Parameters<typeof session.request>) => {
      const stream = request(...requestArgs);
      const write = stream.write.bind(stream);
      let first = true;
      stream.write = ((...writeArgs: Parameters<typeof stream.write>) => {
        if (first) { first = false; requestCount++; }
        return write(...writeArgs);
      }) as typeof stream.write;
      return stream;
    }) as typeof session.request;
    return session;
  }) as typeof http2.connect);
  try {
    await runCursorTurnWithRetry((input: Parameters<typeof createLiveCursorTransport>[0]) => {
      attemptCount++;
      return createLiveCursorTransport(input);
    }, {
      provider: { adapter: "cursor", baseUrl: `http://127.0.0.1:${port}`, apiKey: "test-token" },
      translatorBudget,
      dispatch: { attempt: createDispatchRequest(event => events.push(event)).attempt() },
    }, { modelId: "composer-2", conversationId: "reconnect-fixture", system: [], messages: [] }, undefined, () => {});
    return {
      scenario: "cursor_native_h2_precommit_reconnect",
      requestCount, attemptCount, peerRequests,
      sendCount: events.some(event => event.kind === "start") ? events.filter(event => event.kind === "start").length : null,
      accountingAvailable: events.some(event => event.kind === "start"),
      events: events.some(event => event.kind === "start") ? events : [],
      outcomes: events.filter(event => event.kind === "terminal").map(event => event.outcome),
      reasons: events.filter(event => event.kind === "start").map(event => event.metadata?.reason),
      coverage: "offline native HTTP/2 initial-write invocation and precommit retry; not WebSocket",
      sourceFiles: ["src/adapters/cursor/live-transport.ts", "src/adapters/cursor/transport-retry.ts"],
      testCommand: "bun test tests/cursor-dispatch.test.ts",
    };
  } finally {
    dial.mockRestore();
    translatorBudget.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

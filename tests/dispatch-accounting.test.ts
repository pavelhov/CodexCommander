import { expect, test } from "bun:test";
import { createDispatchRequest, foldDispatchEvents, dispatchObserverHealth, type DispatchEvent } from "../src/usage/dispatch";

test("one send folds intermediate observations, first terminal and orthogonal cancellation", () => {
  const events: DispatchEvent[] = [];
  const request = createDispatchRequest(event => { events.push(event); });
  const send = request.attempt().start({ transport: "http", reason: "initial" });
  send.headers(200); send.headers(201); send.output(); send.output();
  send.usage({ provenance: "provider", completeness: "partial", inputTokens: 5 });
  send.terminal("protocol_success"); send.terminal("protocol_failure"); send.cancel("client");
  const folded = foldDispatchEvents([...events, ...events]);
  expect(folded.sends).toHaveLength(1);
  expect(folded.sends[0]).toMatchObject({ outcome: "protocol_success", clientCancelled: true, headersObserved: true, outputObserved: true });
  expect(folded.sends[0]?.usage).toEqual({ provenance: "provider", completeness: "partial", inputTokens: 5 });
  expect(events).toHaveLength(8);
});

test("unmatched write-ahead start is unknown, scopes use unique refs and independent ordinals", () => {
  const events: DispatchEvent[] = [];
  const a = createDispatchRequest(e => { events.push(e); });
  const b = createDispatchRequest(e => { events.push(e); });
  const attempt = a.attempt();
  expect(attempt.start().ordinal).toBe(1);
  expect(attempt.start().ordinal).toBe(2);
  expect(b.attempt().start().ordinal).toBe(1);
  expect(new Set(events.filter(e => e.kind === "start").map(e => e.sendRef)).size).toBe(3);
  expect(a.requestRef).not.toBe(b.requestRef);
  expect(foldDispatchEvents(events).sends.every(s => s.outcome === "unknown")).toBe(true);
  expect(foldDispatchEvents(events).complete).toBe(false);
});

test("observer exceptions cannot change executor results", () => {
  const before = dispatchObserverHealth().observerFailures;
  const send = createDispatchRequest(() => { throw new Error("observer"); }).attempt().start();
  const value = (() => { send.headers(200); send.terminal("protocol_success"); return 42; })();
  expect(value).toBe(42);
  expect(dispatchObserverHealth().observerFailures).toBe(before + 5);
});

 test("request and attempt counts preserve zero-send scopes", () => {
  const events: DispatchEvent[] = [];
  const request = createDispatchRequest(e => { events.push(e); });
  request.attempt(); request.attempt();
  const folded = foldDispatchEvents(events);
  expect(folded.requests).toHaveLength(1); expect(folded.attempts).toHaveLength(2); expect(folded.sends).toHaveLength(0);
});

test("only locally minted account aliases are emitted, aliases are stable per object", async () => {
  const { dispatchAlias } = await import("../src/usage/dispatch");
  const events: DispatchEvent[] = [];
  const account = {};
  const alias = dispatchAlias(account);
  expect(dispatchAlias(account)).toBe(alias);
  expect(dispatchAlias({})).not.toBe(alias);
  const request = createDispatchRequest(e => { events.push(e); });
  request.attempt().start({ accountRef: alias });
  request.attempt().start({ accountRef: crypto.randomUUID(), routeRef: { ref: crypto.randomUUID() } } as never);
  const starts = events.filter(e => e.kind === "start");
  expect(starts[0]?.metadata?.accountRef).toBe(alias.ref);
  expect(starts[1]?.metadata).not.toHaveProperty("accountRef");
  expect(starts[1]?.metadata).not.toHaveProperty("routeRef");
});

test("unknown EOF is distinct from upstream abort and terminal remains first-wins", () => {
  const events: DispatchEvent[] = [];
  const attempt = createDispatchRequest(e => { events.push(e); }).attempt();
  const a = attempt.start(); a.terminal("unknown"); a.terminal("protocol_success");
  const b = attempt.start(); b.cancel("upstream"); b.terminal("upstream_abort");
  expect(foldDispatchEvents(events).sends.map(s => s.outcome)).toEqual(["unknown", "upstream_abort"]);
  expect(foldDispatchEvents(events).complete).toBe(false);
});

test("invalid terminal is rejected before it can suppress valid completion", () => {
  const events: DispatchEvent[] = [];
  const send = createDispatchRequest(e => { events.push(e); }).attempt().start();
  send.terminal("arbitrary-secret" as never); send.terminal("protocol_success");
  expect(foldDispatchEvents(events).sends[0]?.outcome).toBe("protocol_success");
});

test("child requests share sink and preserve opaque parent provenance", () => {
  const events: DispatchEvent[] = [];
  const parent = createDispatchRequest(e => { events.push(e); });
  const attempt = parent.attempt();
  const child = attempt.child(); child.attempt().start();
  const childRequest = events.find(e => e.requestRef === child.requestRef && e.kind === "request");
  expect(childRequest?.parentRequestRef).toBe(parent.requestRef);
  expect(childRequest?.parentAttemptRef).toBe(attempt.attemptRef);
  expect(foldDispatchEvents(events).requests).toHaveLength(2);
});

test("latest usage revision replaces partial evidence without aggregating cumulative observations", () => {
  const events: DispatchEvent[] = [];
  const send = createDispatchRequest(e => { events.push(e); }).attempt().start();
  send.usage({ provenance: "cumulative", completeness: "partial", contextTotalTokens: 100 });
  send.usage({ provenance: "provider", completeness: "complete", inputTokens: 10, outputTokens: 2 });
  expect(foldDispatchEvents([...events, ...events]).sends[0]?.usage).toEqual({ provenance: "provider", completeness: "complete", inputTokens: 10, outputTokens: 2 });
});

test("elapsed observation time stays nonnegative when wall clock moves backward", async () => {
  const { spyOn } = await import("bun:test");
  const events: DispatchEvent[] = [];
  const send = createDispatchRequest(e => { events.push(e); }).attempt().start();
  const clock = spyOn(Date, "now").mockReturnValue(1);
  try { send.headers(200); send.terminal("protocol_success"); } finally { clock.mockRestore(); }
  expect(events.at(-1)?.timestamp).toBe(1);
  expect(events.at(-1)?.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(events.at(-1)?.elapsedMs).toBeGreaterThanOrEqual(events.find(e => e.kind === "start")!.elapsedMs!);
});

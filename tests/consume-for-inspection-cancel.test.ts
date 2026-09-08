import { beforeEach, describe, expect, test } from "bun:test";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  getInspectionCounters,
  resetInspectionCountersForTest,
  type SseInspector,
} from "../src/server/relay";
import type { RequestLogContext } from "../src/server/request-log";

// Regression for issue #44: native-passthrough turns are inspected on a teed background stream.
// Codex disconnects the instant it finishes reading, so the inspection stream is frequently
// aborted. The cancel path must finalize (onCancel) and release the turn (onDone) instead of
// silently dropping the /api/logs entry.

function pendingStream(): ReadableStream<Uint8Array> {
  // A stream whose read never resolves on its own — only reader.cancel() (via abort) ends it.
  return new ReadableStream<Uint8Array>({ start() {}, pull() { /* never enqueue/close */ } });
}

function closingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
}

const tick = () => new Promise(r => setTimeout(r, 5));
const encoder = new TextEncoder();

function controlledStream(): {
  stream: ReadableStream<Uint8Array>;
  push(chunk: Uint8Array): void;
  close(): void;
  cancelReasons: unknown[];
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelReasons: unknown[] = [];
  return {
    stream: new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull() { /* producer is test-controlled */ },
      cancel(reason) { cancelReasons.push(reason); },
    }),
    push(chunk) { controller.enqueue(chunk); },
    close() { controller.close(); },
    cancelReasons,
  };
}

function completedFrame(id: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({
    type: "response.completed",
    response: { id, status: "completed", output: [] },
  })}\n\n`);
}

function failedFrame(message: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({
    type: "response.failed",
    response: { status: "failed", error: { message } },
  })}\n\n`);
}

function inspectionSpy(): { inspector: SseInspector; finishes: () => number; disposes: () => number } {
  let finishCount = 0;
  let disposeCount = 0;
  return {
    inspector: {
      feed() {},
      finish() { finishCount += 1; },
      dispose() { disposeCount += 1; },
      reported: () => false,
      terminalSeen: () => false,
    },
    finishes: () => finishCount,
    disposes: () => disposeCount,
  };
}

beforeEach(() => resetInspectionCountersForTest());

describe("consumeForInspection cancel finalization (#44)", () => {
  test("already-aborted signal → onCancel + onDone fire, onTerminal does not", () => {
    const ac = new AbortController();
    ac.abort();
    let terminal = 0, cancel = 0, done = 0;
    consumeForInspection(pendingStream(), () => terminal++, ac.signal, () => done++, undefined, () => cancel++);
    expect(cancel).toBe(1);
    expect(done).toBe(1);
    expect(terminal).toBe(0);
  });

  test("mid-drain abort → onCancel + onDone fire, onTerminal suppressed", async () => {
    const ac = new AbortController();
    let terminal = 0, cancel = 0, done = 0;
    consumeForInspection(pendingStream(), () => terminal++, ac.signal, () => done++, undefined, () => cancel++);
    ac.abort();
    await tick();
    expect(cancel).toBe(1);
    expect(done).toBe(1);
    expect(terminal).toBe(0);
  });

  test("clean close without a terminal payload → onTerminal(incomplete), not a cancel", async () => {
    let terminalStatus: string | null = null;
    let cancel = 0, done = 0;
    consumeForInspection(closingStream(), s => { terminalStatus = s; }, undefined, () => done++, undefined, () => cancel++);
    await tick();
    expect(terminalStatus).toBe("incomplete");
    expect(cancel).toBe(0);
    expect(done).toBe(1);
  });

});

describe("immediate post-disconnect cancellation", () => {
  for (const metadataOnly of [false, true]) {
    test(`${metadataOnly ? "metadata" : "terminal"} inspection aborts synchronously, even with legacy drain bounds`, async () => {
      const source = controlledStream();
      const clientGone = new AbortController();
      const upstream = new AbortController();
      let dones = 0;
      const options = { clientGoneSignal: clientGone.signal, upstream,
        drainBounds: { ms: 60_000, bytes: 32 * 1024 * 1024 } };
      const done = new Promise<void>(resolve => {
        const finish = () => { dones++; resolve(); };
        if (metadataOnly) consumeForResponseLogMetadata(source.stream, {} as RequestLogContext,
          undefined, finish, undefined, undefined, options);
        else consumeForInspection(source.stream, () => {}, undefined, finish,
          undefined, undefined, undefined, undefined, options);
      });
      const reason = new DOMException("client closed", "AbortError");
      clientGone.abort(reason);
      expect(upstream.signal.aborted).toBe(true);
      expect(upstream.signal.reason).toBe(reason);
      expect(source.cancelReasons).toEqual([reason]);
      await done;
      expect(dones).toBe(1);
      expect(getInspectionCounters().postCancelDrainStops).toBe(0);
    });
  }

  for (const terminal of [completedFrame("settled"), failedFrame("failed")]) {
    test("preserves an already-settled terminal while aborting immediately", async () => {
      const source = controlledStream();
      const clientGone = new AbortController();
      const upstream = new AbortController();
      let terminals = 0, cancels = 0;
      const done = new Promise<void>(resolve => consumeForInspection(source.stream,
        () => { terminals++; }, undefined, resolve, undefined, () => { cancels++; },
        undefined, undefined, { clientGoneSignal: clientGone.signal, upstream }));
      source.push(terminal);
      clientGone.abort();
      expect(upstream.signal.aborted).toBe(true);
      await done;
      expect(terminals).toBe(1);
      expect(cancels).toBe(0);
    });
  }

  test("silent upstream finalizes one cancellation without a synthetic failure", async () => {
    const clientGone = new AbortController();
    let terminals = 0, cancels = 0, dones = 0;
    const done = new Promise<void>(resolve => consumeForInspection(pendingStream(),
      () => { terminals++; }, undefined, () => { dones++; resolve(); }, undefined,
      () => { cancels++; }, undefined, undefined, { clientGoneSignal: clientGone.signal }));
    clientGone.abort();
    clientGone.abort();
    await done;
    expect([terminals, cancels, dones]).toEqual([0, 1, 1]);
  });
});

describe("inspection consumer teardown", () => {
  test("both public consumers dispose their inspector in finally", async () => {
    const terminalSpy = inspectionSpy();
    const metadataSpy = inspectionSpy();
    const terminalDone = new Promise<void>(resolve => {
      consumeForInspection(
        closingStream(),
        () => {},
        undefined,
        resolve,
        undefined,
        undefined,
        undefined,
        undefined,
        { inspectorFactory: () => terminalSpy.inspector },
      );
    });
    const metadataDone = new Promise<void>(resolve => {
      consumeForResponseLogMetadata(
        closingStream(),
        {} as RequestLogContext,
        undefined,
        resolve,
        undefined,
        undefined,
        { inspectorFactory: () => metadataSpy.inspector },
      );
    });

    await Promise.all([terminalDone, metadataDone]);
    expect(terminalSpy.finishes()).toBe(1);
    expect(terminalSpy.disposes()).toBe(1);
    expect(metadataSpy.finishes()).toBe(1);
    expect(metadataSpy.disposes()).toBe(1);
  });
});

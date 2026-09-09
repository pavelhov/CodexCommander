import { describe, expect, test } from "bun:test";
import { UpstreamSendBudget } from "../src/lib/upstream-send-budget";
import { fetchWithResetRetry, fetchWithTransientRetry } from "../src/lib/upstream-retry";
import { fetchWithHeaderTimeout } from "../src/server/responses/fetch-helpers";
import { consumeForInspection, createSseInspector, relaySseWithFailedTail } from "../src/server/relay";
import { relaySseEagerBounded } from "../src/server/relay-eager";
import { handleResponses } from "../src/server/responses/core";
import type { CodexCommanderConfig } from "../src/types";

for (const streamMode of ["safe-tee", "eager-relay"] as const) {
  test(`${streamMode} request-signal cancellation is not an upstream failure`, async () => {
    const client = new AbortController();
    let wireSignal: AbortSignal | null | undefined;
    let sends = 0;
    let cancels = 0;
    const terminals: string[] = [];
    let finish!: () => void;
    const cancelled = new Promise<void>(resolve => { finish = resolve; });
    const executor = (async (_url: unknown, init: RequestInit) => {
      expect(String(_url).startsWith("http://127.0.0.1:1/")).toBe(true);
      sends++;
      wireSignal = init.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"synthetic"}\n\n'));
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const config = { port: 0, defaultProvider: "recovery-fixture", streamMode, multiAgentGuidanceEnabled: false,
      providers: { "recovery-fixture": { adapter: "openai-responses", baseUrl: "http://127.0.0.1:1/v1",
        authMode: "forward", codexAccountMode: "direct", allowPrivateNetwork: true, liveModels: false, fetch: executor } },
    } as CodexCommanderConfig;
    const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic" },
      body: JSON.stringify({ model: "recovery-fixture/test", input: "synthetic", stream: true }),
    }), config, { model: "", provider: "" }, {
      abortSignal: client.signal,
      onNativePassthroughTerminal: status => terminals.push(status),
      onNativePassthroughCancel: () => { cancels++; finish(); },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    client.abort(new DOMException("client stopped", "AbortError"));
    expect(wireSignal?.aborted).toBe(true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cancelled, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("cancel callback missing")), 1000);
      })]);
      expect(terminals).toEqual([]);
      expect(cancels).toBe(1);
      expect(sends).toBe(1);
    } finally {
      clearTimeout(timeout);
      await reader.cancel().catch(() => {});
    }
  });
}

describe("inference recovery defaults", () => {
  test("normal protocol completion is distinct from client cancellation", async () => {
    let cancellations = 0;
    let completions = 0;
    const source = new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
    const relayed = relaySseWithFailedTail(source.body!, new AbortController(),
      () => { cancellations++; }, () => { completions++; });
    expect(await new Response(relayed).text()).toContain("response.completed");
    expect(completions).toBe(1);
    expect(cancellations).toBe(0);
  });
  for (const helper of [fetchWithResetRetry, fetchWithTransientRetry]) {
    test(`${helper.name} never replays an ambiguous reset by default`, async () => {
      let sends = 0;
      const error = Object.assign(new Error("reset after request accepted"), { code: "ECONNRESET" });
      await expect(helper(async () => { sends++; throw error; })).rejects.toBe(error);
      expect(sends).toBe(1);
    });
  }
  for (const status of [500, 502, 503, 504, 520, 521, 522]) {
    test(`returns ${status} intact without another inference send`, async () => {
      let sends = 0;
      const response = new Response("provider failure", { status });
      expect(await fetchWithTransientRetry(async () => { sends++; return response; })).toBe(response);
      expect(sends).toBe(1);
      expect(await response.text()).toBe("provider failure");
    });
  }

  test("initial and recovery sends share a cap even through separate helper calls", async () => {
    const budget = new UpstreamSendBudget(1000);
    const signal = new AbortController().signal;
    let sends = 0;
    const executor = (async () => { sends++; return new Response(null, { status: 429 }); }) as typeof fetch;
    const send = () => fetchWithHeaderTimeout("http://127.0.0.1:1", {}, signal, 1000,
      false, executor, false, undefined, budget);
    await send();
    await send();
    await expect(send()).rejects.toThrow("send budget exhausted");
    expect(sends).toBe(2);
  });

  test("recovery cannot reset the deadline or send after it expires", async () => {
    let clock = 0;
    const budget = new UpstreamSendBudget(1000, 2, () => clock);
    const signal = new AbortController().signal;
    expect(budget.reserve(signal)).toBe(1000);
    clock = 900;
    expect(budget.reserve(signal)).toBe(100);
    const expired = new UpstreamSendBudget(1000, 2, () => clock);
    expired.reserve(signal);
    clock = 1900;
    let sends = 0;
    const executor = (async () => { sends++; return new Response(); }) as typeof fetch;
    await expect(fetchWithHeaderTimeout("http://127.0.0.1:1", {}, signal, 1000,
      false, executor, false, undefined, expired)).rejects.toThrow("deadline elapsed");
    expect(sends).toBe(0);
  });
});

for (const shape of ["tee", "eager"] as const) {
  test(`${shape} loopback cancellation aborts immediately and closes the upstream connection`, async () => {
    let resolveRemoteAbort!: () => void;
    const remoteAbort = new Promise<void>(resolve => { resolveRemoteAbort = resolve; });
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req) {
        req.signal.addEventListener("abort", resolveRemoteAbort, { once: true });
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"synthetic"}\n\n'));
          },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const upstream = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    let cancels = 0;
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, { signal: upstream.signal });
      let client: ReadableStream<Uint8Array>;
      if (shape === "eager") {
        const inspector = createSseInspector({});
        client = relaySseEagerBounded(response.body!, upstream, {
          inspectChunk: chunk => inspector.feed(chunk), finishInspection: () => inspector.finish(),
          disposeInspection: () => inspector.dispose(), sawTerminal: () => inspector.terminalSeen(),
          onSynthetic: () => { throw new Error("cancellation must not become a synthetic failure"); },
          onClientCancel: () => { cancels++; }, onDone: resolveDone,
        });
      } else {
        const [native, inspection] = response.body!.tee();
        const gone = new AbortController();
        consumeForInspection(inspection, () => {}, undefined, resolveDone, undefined,
          () => { cancels++; }, undefined, undefined, { clientGoneSignal: gone.signal, upstream });
        client = relaySseWithFailedTail(native, upstream, reason => gone.abort(reason));
      }
      const reader = client.getReader();
      expect((await reader.read()).done).toBe(false);
      const started = performance.now();
      const cancellation = reader.cancel("test client left");
      expect(upstream.signal.aborted).toBe(true);
      expect(performance.now() - started).toBeLessThan(100);
      await Promise.race([
        Promise.all([cancellation, done, remoteAbort]),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("upstream did not close")), 2000); }),
      ]);
      expect(cancels).toBe(1);
    } finally {
      clearTimeout(timeout);
      upstream.abort();
      await server.stop(true);
    }
  });
}

import { afterEach, describe, expect, test } from "bun:test";
import { normalizePersistedRetryAfter } from "../src/usage/log";
import { recordUpstreamRetryAfter } from "../src/server/request-log";
import { responseWithDeferredRequestLog } from "../src/server/relay";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig } from "../src/types";

describe("persisted upstream Retry-After", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("accepts bounded delta-seconds and canonical HTTP dates", () => {
    expect(normalizePersistedRetryAfter(" 3600 ")).toBe("3600");
    expect(normalizePersistedRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT"))
      .toBe("Sun, 06 Nov 1994 08:49:37 GMT");
  });

  test("rejects arbitrary headers, parseable prose, and unbounded delays", () => {
    expect(normalizePersistedRetryAfter("secret-token; expires 06 Nov 1994")).toBeUndefined();
    expect(normalizePersistedRetryAfter("Sunday, 06-Nov-94 08:49:37 GMT")).toBeUndefined();
    expect(normalizePersistedRetryAfter(String(41 * 24 * 60 * 60))).toBeUndefined();
  });

  test("capture is first-valid-value wins and never retains an invalid header", () => {
    const context = { model: "x", provider: "opencode-go" };
    recordUpstreamRetryAfter(context, "bearer super-secret-value");
    expect(context).not.toHaveProperty("upstreamRetryAfter");
    recordUpstreamRetryAfter(context, "120");
    recordUpstreamRetryAfter(context, "240");
    expect(context).toHaveProperty("upstreamRetryAfter", "120");
  });

  async function driveOpenCodeGoError(upstreamRetryAfter?: string) {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: {
        type: "rate_limit_error",
        message: 'GoUsageLimitError metadata={"limitName":"weekly"}',
      },
    }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        ...(upstreamRetryAfter !== undefined ? { "retry-after": upstreamRetryAfter } : {}),
      },
    })) as typeof fetch;
    const config = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "opencode-go",
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://opencode.ai/zen/go/v1",
          authMode: "key",
          apiKey: "test-go-key",
        },
      },
    } as OcxConfig;
    const context = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "opencode-go/gpt-5.6-luna", input: "ping", stream: false }),
    }), config, context);
    const logs: Array<{ upstreamRetryAfter?: string }> = [];
    const logged = responseWithDeferredRequestLog(
      response,
      "retry-origin-test",
      Date.now(),
      context,
      entry => logs.push(entry),
    );
    await logged.text();
    return { context, response, logs };
  }

  test("a synthetic client retry delay never becomes upstream quota evidence", async () => {
    const result = await driveOpenCodeGoError();
    expect(result.context).not.toHaveProperty("upstreamRetryAfter");
    expect(result.logs[0]).not.toHaveProperty("upstreamRetryAfter");

    const context = { model: "x", provider: "opencode-go" };
    const logs: Array<{ upstreamRetryAfter?: string }> = [];
    const synthetic = responseWithDeferredRequestLog(
      new Response("client retry", { status: 429, headers: { "retry-after": "2" } }),
      "synthetic-retry-test",
      Date.now(),
      context,
      entry => logs.push(entry),
    );
    await synthetic.text();
    expect(context).not.toHaveProperty("upstreamRetryAfter");
    expect(logs[0]).not.toHaveProperty("upstreamRetryAfter");
  });

  test("a real upstream retry delay survives the client wrapper and persistence path", async () => {
    const result = await driveOpenCodeGoError("3600");
    expect(result.context).toHaveProperty("upstreamRetryAfter", "3600");
    expect(result.logs[0]).toHaveProperty("upstreamRetryAfter", "3600");
  });
});

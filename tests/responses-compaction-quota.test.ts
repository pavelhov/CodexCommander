import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, handleResponsesCompact } from "../src/server/responses";
import { saveCredential, getAccountSet, setActiveAccount } from "../src/oauth/store";
import { clearAnthropicAccountPoolState, rotateAnthropicAccountOn429 } from "../src/oauth/anthropic-routing";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../src/providers/quota";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const originalHome = process.env.CODEXCOMMANDER_HOME;
let temporaryHome: string | undefined;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache("anthropic");
  if (originalHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = originalHome;
  if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true });
  temporaryHome = undefined;
});

function config(overrides: Partial<CodexCommanderProviderConfig> = {}): CodexCommanderConfig {
  return { port: 0, defaultProvider: "gw", multiAgentGuidanceEnabled: false,
    providers: { gw: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "test-key", ...overrides } },
  } as CodexCommanderConfig;
}
function request({ stream = false, fresh = true, model = "gw/claude-fable-5-2" } = {}): Request {
  return new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, input: [ { role: "user", content: "earlier turn" }, ...(fresh ? [{ type: "compaction_trigger" }] : []) ] }),
  });
}
function rejectedHeaders(window = "5h"): Record<string, string> {
  return { "retry-after": "5807", [`anthropic-ratelimit-unified-${window}-status`]: "rejected",
    [`anthropic-ratelimit-unified-${window}-reset`]: String(Math.floor(Date.now() / 1000) + 5807) };
}
function rejected(headers: Record<string, string> = {}, error: Record<string, unknown> = { type: "rate_limit_error", message: "Requests are currently limited" }): Response {
  return new Response(JSON.stringify({ error }), { status: 429, headers: { "content-type": "application/json", "retry-after": "5807", ...headers } });
}
function stream(events: Record<string, unknown>[], headers: Record<string, string> = {}): Response {
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", ...headers } });
}
function successfulStream(): Response {
  return stream([
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "complete summary" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
  ]);
}

describe("fresh routed Anthropic compaction quota recovery", () => {
  test.each([false, true])("HTTP rejection stays 429 and terminates quota retries for stream=%s", async clientStream => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return rejected(rejectedHeaders()); }) as typeof fetch;
    const cfg = config({ retryOn429: { attempts: 3, intervalMs: 10, maxIntervalMs: 10 } });
    const response = await handleResponses(request({ stream: clientStream }), cfg, { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5807");
    expect(await response.json()).toEqual({ error: { type: "insufficient_quota", code: "insufficient_quota", message: expect.stringContaining("Requests are currently limited") } });
    expect(calls).toBe(1);
  });

  test.each(["5h", "7d"])("%s rejection is supported by v1 and preserves diagnostic headers", async window => {
    globalThis.fetch = (async () => rejected(rejectedHeaders(window))) as typeof fetch;
    const response = await handleResponsesCompact(request(), config(), { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5807");
    expect((await response.json()).error.code).toBe("insufficient_quota");
  });

  test("explicit structured quota code bypasses same-target waiting", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return rejected({}, { type: "insufficient_quota", message: "No credits available" }); }) as typeof fetch;
    const response = await handleResponses(request(), config({ retryOn429: { attempts: 2, intervalMs: 10, maxIntervalMs: 10 } }), { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("insufficient_quota");
    expect(calls).toBe(1);
  });

  const unproven = [
    {},
    { "anthropic-ratelimit-unified-status": "rejected" },
    { "anthropic-ratelimit-unified-overage-status": "rejected" },
    { "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-reset": "1" },
    { "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-reset": "nonsense" },
    { ...rejectedHeaders(), "anthropic-ratelimit-unified-status": "allowed" },
    { ...rejectedHeaders(), "anthropic-ratelimit-unified-5h-status": "allowed_warning" },
    { ...rejectedHeaders(), "anthropic-ratelimit-unified-overage-status": "allowed" },
    { ...rejectedHeaders(), "anthropic-ratelimit-unified-overage-status": "allowed_warning" },
    { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "unknown", "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 5807) },
  ];
  test.each(unproven)("unproven or contradictory quota evidence retains normal retries: %j", async headers => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return rejected(headers as Record<string, string>); }) as typeof fetch;
    const response = await handleResponses(request(), config({ retryOn429: { attempts: 1, intervalMs: 1, maxIntervalMs: 1 } }), { model: "", provider: "" });
    expect(calls).toBe(2);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5807");
    expect((await response.json()).error.code).toBe("rate_limit_exceeded");
  });

  test.each(["stale", "mismatched", "fresh but unbound"])("%s cached quota cannot promote a generic 429", async sample => {
    setCachedProviderAccountQuotaForTests("anthropic", sample === "mismatched" ? "another-account" : "active-account", {
      fiveHourPercent: 100, fiveHourResetAt: Date.now() + 5807_000,
      updatedAt: Date.now() - (sample === "stale" ? 3600_000 : 0),
    });
    globalThis.fetch = (async () => rejected()) as typeof fetch;
    const response = await handleResponses(request(), config(), { model: "", provider: "" });
    expect((await response.json()).error.code).toBe("rate_limit_exceeded");
  });

  test.each(["ordinary", "custom endpoint", "different adapter"])("%s remains outside this policy", async mode => {
    globalThis.fetch = (async () => rejected(rejectedHeaders())) as typeof fetch;
    const cfg = config(mode === "custom endpoint" ? { baseUrl: "https://gateway.example" } : mode === "different adapter" ? { adapter: "openai-chat" } : {});
    const response = await handleResponses(request({ fresh: mode !== "ordinary" }), cfg, { model: "", provider: "" });
    expect((await response.json()).error.code).toBe("rate_limit_exceeded");
  });

  test.each(["headers", "structured"])("SSE %s evidence emits terminal quota with no partial compaction", async proof => {
    globalThis.fetch = (async () => stream([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "partial summary" } },
      { type: "error", error: { type: proof === "structured" ? "insufficient_quota" : "rate_limit_error", message: "Credits unavailable" } },
    ], proof === "headers" ? rejectedHeaders() : {})) as typeof fetch;
    const response = await handleResponses(request({ stream: true }), config(), { model: "", provider: "" });
    const text = await response.text();
    expect(text).toContain('"code":"insufficient_quota"');
    expect(text).toContain('"type":"response.failed"');
    expect(text).not.toContain('"type":"compaction"');
    expect(text).not.toContain("partial summary");
  });

  test("v1 internal SSE preserves terminal quota instead of converting it to 502", async () => {
    globalThis.fetch = (async () => stream([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } },
      { type: "error", error: { type: "rate_limit_error", message: "Credits unavailable" } },
    ], rejectedHeaders())) as typeof fetch;
    const response = await handleResponsesCompact(request(), config(), { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5807");
    expect((await response.json()).error.code).toBe("insufficient_quota");
  });

  test.each(["five_hour", "seven_day"])("native representative %s rejection terminates promptly", async claim => {
    globalThis.fetch = (async () => rejected({ "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": claim,
      "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 5807),
    })) as typeof fetch;
    const response = await handleResponses(request(), config(), { model: "", provider: "" });
    expect((await response.json()).error.code).toBe("insufficient_quota");
  });

  test("quota error without upstream Retry-After does not manufacture a retry deadline", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { type: "insufficient_quota", message: "Credits unavailable" } }), {
      status: 429, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const response = await handleResponses(request(), config(), { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  test.each(["authentication_error", "invalid_request_error", "overloaded_error"])("SSE %s with quota headers retains its original error", async type => {
    globalThis.fetch = (async () => stream([{ type: "error", error: { type, message: "Unrelated upstream failure" } }], rejectedHeaders())) as typeof fetch;
    const response = await handleResponses(request({ stream: true }), config(), { model: "", provider: "" });
    const text = await response.text();
    expect(text).not.toContain('"code":"insufficient_quota"');
    expect(text).toContain("Unrelated upstream failure");
    expect(text).not.toContain('"type":"compaction"');
  });

  test.each(["insufficient_quota", "rate_limit_error"])("nonstream error envelope %s does not install a partial summary", async type => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ type: "error", error: { type, message: "Credits unavailable" } }), {
      headers: { "content-type": "application/json", ...rejectedHeaders() },
    })) as typeof fetch;
    const response = await handleResponses(request(), config(), { model: "", provider: "" });
    const json = await response.json();
    expect(json.status).toBe("failed");
    expect(json.error.code).toBe("insufficient_quota");
    expect(json.output).toEqual([]);
  });

  test.each(["compaction", "compaction_summary", "context_compaction"])("stored %s replay never enables quota recovery", async type => {
    globalThis.fetch = (async () => rejected(rejectedHeaders())) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gw/claude-fable-5-2", stream: false, input: [{ type, encrypted_content: "ccx1:cHJldmlvdXMgc3VtbWFyeQ==" }, { role: "user", content: "continue" }] }),
    });
    const response = await handleResponses(req, config(), { model: "", provider: "" });
    expect((await response.json()).error.code).toBe("rate_limit_exceeded");
  });

  test("ordinary SSE error remains unchanged even when the upstream has quota evidence", async () => {
    globalThis.fetch = (async () => stream([{ type: "error", error: { type: "insufficient_quota", message: "Credits unavailable" } }], rejectedHeaders())) as typeof fetch;
    const response = await handleResponses(request({ stream: true, fresh: false }), config(), { model: "", provider: "" });
    expect(await response.text()).not.toContain('"code":"insufficient_quota"');
  });

  test.each(["success", "generic", "exhausted", "precooled"])("Anthropic OAuth failover %s uses final account evidence before quota mapping", async outcome => {
    temporaryHome = mkdtempSync(join(tmpdir(), "ccx-compaction-quota-"));
    process.env.CODEXCOMMANDER_HOME = temporaryHome;
    for (const id of ["first", "second"]) await saveCredential("anthropic", {
      access: `test-access-${id}`, refresh: `test-refresh-${id}`, expires: Date.now() + 3600_000, accountId: `fixture-${id}`,
    });
    const accounts = getAccountSet("anthropic")!;
    const first = accounts.accounts.find(a => a.credential.accountId === "fixture-first")!;
    await setActiveAccount("anthropic", first.id);
    const authorizations: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return authorizations.length === 1 ? rejected(rejectedHeaders())
        : outcome === "success" ? successfulStream() : rejected(outcome === "exhausted" ? rejectedHeaders() : {});
    }) as typeof fetch;
    const cfg = { ...config(), defaultProvider: "anthropic", providers: { anthropic: { ...config().providers.gw!, authMode: "oauth" as const, apiKey: undefined } }, anthropicAccountPool: { enabled: true } };
    if (outcome === "precooled") {
      for (const account of accounts.accounts) rotateAnthropicAccountOn429(cfg, account.id, "5807");
    }
    const response = await handleResponses(request({ stream: true, model: "anthropic/claude-fable-5-2" }), cfg, { model: "", provider: "" });
    const text = await response.text();
    if (outcome === "precooled") {
      expect(authorizations).toEqual([]);
      expect(response.status).toBe(429);
      expect(JSON.parse(text).error.code).toBe("rate_limit_exceeded");
      return;
    }
    expect(authorizations).toEqual(["Bearer test-access-first", "Bearer test-access-second"]);
    if (outcome === "success") {
      expect(text).toContain('"type":"compaction"');
      expect(text).toContain('"type":"response.completed"');
      expect(text).not.toContain('"code":"insufficient_quota"');
    } else {
      expect(response.status).toBe(429);
      expect(JSON.parse(text).error.code).toBe(outcome === "exhausted" ? "insufficient_quota" : "rate_limit_exceeded");
      expect(text).not.toContain('"type":"compaction"');
    }
  });
});

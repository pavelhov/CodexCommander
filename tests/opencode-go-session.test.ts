import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses/core";
import { handleChatCompletions } from "../src/server/chat-completions";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { resolveOpenCodeGoTransport } from "../src/providers/opencode-go-transport";
import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../src/types";

function goProvider(overrides: Partial<CodexCommanderProviderConfig> = {}): CodexCommanderProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("opencode-go")!), apiKey: "go-test-key", ...overrides };
}

describe("OpenCode Go session affinity", () => {
  test("keeps one opaque session per task, distinct from the parent task", () => {
    const provider = goProvider();
    const headers = new Headers({ "thread-id": "child-1", "x-codex-parent-thread-id": "parent" });
    const first = resolveOpenCodeGoTransport("opencode-go", provider, headers);
    const repeat = resolveOpenCodeGoTransport("opencode-go", provider, headers);
    const sibling = resolveOpenCodeGoTransport("opencode-go", provider, new Headers({
      "thread-id": "child-2", "x-codex-parent-thread-id": "parent",
    }));
    expect(first.headers?.["x-opencode-session"]).toBe(repeat.headers?.["x-opencode-session"]);
    expect(first.headers?.["x-opencode-session"]).not.toBe(sibling.headers?.["x-opencode-session"]);
    expect(first.headers?.["x-opencode-session"]).toMatch(/^ccx_[0-9a-f]{32}$/);
    expect(first.headers?.["x-opencode-session"]).not.toContain("child-1");
  });

  test("accepts Codex session and explicit Go headers, with an isolated request fallback", () => {
    const provider = goProvider();
    const native = resolveOpenCodeGoTransport("opencode-go", provider, new Headers({ session_id: "codex-session" }));
    const explicit = resolveOpenCodeGoTransport("opencode-go", provider, new Headers({ "x-opencode-session": "client-session" }));
    const noIdentity1 = resolveOpenCodeGoTransport("opencode-go", provider, new Headers());
    const noIdentity2 = resolveOpenCodeGoTransport("opencode-go", provider, new Headers());
    expect(native.headers?.["x-opencode-session"]).toBeTruthy();
    expect(explicit.headers?.["x-opencode-session"]).toBeTruthy();
    expect(noIdentity1.headers?.["x-opencode-session"]).not.toBe(noIdentity2.headers?.["x-opencode-session"]);
  });

  test("honors operator headers and never changes a lookalike provider", () => {
    const configured = goProvider({ headers: { "X-OpenCode-Session": "operator-session" } });
    const resolved = resolveOpenCodeGoTransport("opencode-go", configured, new Headers({ session_id: "task" }));
    expect(resolved.headers?.["X-OpenCode-Session"]).toBe("operator-session");
    expect(resolved.headers?.["x-opencode-session"]).toBeUndefined();
    expect(resolved.headers?.["User-Agent"]).toBe("CodexCommander");
    const fullyConfigured = goProvider({ headers: { "X-OpenCode-Session": "operator-session", "User-Agent": "operator-client" } });
    expect(resolveOpenCodeGoTransport("opencode-go", fullyConfigured, new Headers())).toBe(fullyConfigured);
    const lookalike = goProvider({ baseUrl: "https://example.com/zen/go/v1" });
    expect(resolveOpenCodeGoTransport("opencode-go", lookalike, new Headers({ session_id: "task" }))).toBe(lookalike);
    expect(resolveOpenCodeGoTransport("other", goProvider(), new Headers({ session_id: "task" })).headers).toBeUndefined();
  });

  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("sends V4.1 Flash with the session header on the Codex Responses bridge", async () => {
    const outbound: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    const config = { providers: { "opencode-go": goProvider() } } as unknown as CodexCommanderConfig;
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "child-1" },
      body: JSON.stringify({ model: "opencode-go/deepseek-v4.1-flash", input: "Say OK", stream: true }),
    });
    const response = await handleResponses(req, config, { model: "", provider: "" });
    await response.text();
    expect(outbound[0]?.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(outbound[0]?.headers.get("x-opencode-session")).toMatch(/^ccx_[0-9a-f]{32}$/);
    expect(outbound[0]?.headers.get("user-agent")).toBe("CodexCommander");
  });

  test("keeps the session header across Go's Chat, Anthropic, and Responses wires", async () => {
    const outbound: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    const config = { providers: { "opencode-go": goProvider() } } as unknown as CodexCommanderConfig;
    for (const [model, path] of [
      ["glm-5.3-flash", "/chat/completions"],
      ["qwen3.8-flash", "/messages"],
      ["qwen3.8-max", "/messages"],
      ["gpt-5.6-luna", "/responses"],
    ]) {
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": `go-${model}` },
        body: JSON.stringify({ model: `opencode-go/${model}`, input: "Say OK", stream: true }),
      });
      const response = await handleResponses(req, config, { model: "", provider: "" });
      await response.text();
      const sent = outbound.at(-1);
      expect(sent?.url).toBe(`https://opencode.ai/zen/go/v1${path}`);
      expect(sent?.headers.get("x-opencode-session")).toMatch(/^ccx_[0-9a-f]{32}$/);
      expect(sent?.headers.get("user-agent")).toBe("CodexCommander");
    }
  });

  test("keeps an explicit client session through the Chat Completions bridge", async () => {
    const outbound: Headers[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(new Headers(init?.headers));
      return Response.json({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    const config = { providers: { "opencode-go": goProvider() } } as unknown as CodexCommanderConfig;
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-session": "chat-client-session" },
      body: JSON.stringify({
        model: "opencode-go/deepseek-v4.1-flash",
        messages: [{ role: "user", content: "Say OK" }],
        stream: false,
      }),
    });
    const response = await handleChatCompletions(req, config, { model: "", provider: "" });
    await response.text();
    const expected = resolveOpenCodeGoTransport(
      "opencode-go", goProvider(), new Headers({ "x-opencode-session": "chat-client-session" }),
    ).headers?.["x-opencode-session"];
    expect(outbound[0]?.get("x-opencode-session")).toBe(expected);
  });
});

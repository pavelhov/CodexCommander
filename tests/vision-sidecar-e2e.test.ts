import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { CodexCommanderConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";

// Issue #88: text-only input models (DeepSeek, ...) get "eyes" — the vision sidecar describes
// attached images via a vision-capable forward model and replaces them with text BEFORE the main
// call. These tests observe the fallback path actually firing end-to-end (activation evidence),
// and that models outside `noVisionModels` keep their images untouched (regression guard).

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let sidecar: ReturnType<typeof Bun.serve> | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousHome = process.env.CODEXCOMMANDER_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ccx-vision-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ccx-vision-e2e-"));
  process.env.CODEXCOMMANDER_HOME = testDir;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  sidecar?.stop(true);
  sidecar = null;
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";
const CAPTION = "A red square logo with the word CODEXCOMMANDER in white monospace text.";
const UNCONFIRMED_VIDEO_INPUTS = [
  "Create a video of a fox. Please wait for my confirmation.",
  "Create a video of a fox?",
  "Produce two videos about safe bicycle maintenance.",
  "Could you create a video of a fox?",
] as const;

/** Fake ChatGPT forward backend: answers /responses with an SSE caption stream. */
function serveSidecar(onRequest: (req: Request, bodyText: string) => void) {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const bodyText = await req.text();
      onRequest(req, bodyText);
      const sse = [
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: CAPTION })}`,
        "",
        "data: [DONE]",
        "", "",
      ].join("\n");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

/** Fake text-only upstream (openai-chat wire): records the forwarded body. */
function serveUpstream(record: (bodyText: string) => void) {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      record(await req.text());
      return new Response(JSON.stringify({
        id: "chatcmpl-vision-1", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "I see a red logo." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }), { headers: { "content-type": "application/json" } });
    },
  });
}

function baseRequest(model: string) {
  return {
    model, stream: false,
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "what does this logo say?" },
      { type: "input_image", image_url: PNG_DATA_URL },
    ]}],
  };
}

function videoPassthroughConfig(upstreamPort: number, withXai = false): CodexCommanderConfig {
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "passthrough",
    multiAgentGuidanceEnabled: true,
    providers: {
      passthrough: {
        adapter: "openai-responses",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        allowPrivateNetwork: true,
        apiKey: "key-alpha-000111222333",
      },
      ...(withXai ? {
        xai: {
          adapter: "openai-chat" as const,
          baseUrl: "https://api.x.ai/v1",
          apiKey: "xai-test-token",
        },
      } : {}),
    },
    images: { videoBridgeEnabled: true, authSource: "api_key" },
  } as CodexCommanderConfig;
}

function postResponses(serverUrl: URL, body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL("/v1/responses", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("vision sidecar fallback (issue #88, end-to-end)", () => {
  test("noVisionModels request fires the sidecar and forwards the caption instead of the image", async () => {
    let upstreamBody = "";
    let sidecarBody = "";
    let sidecarAuth: string | null = null;
    let sidecarAccount: string | null = null;
    let sidecarHits = 0;
    upstream = serveUpstream(b => { upstreamBody = b; });
    sidecar = serveSidecar((req, b) => {
      sidecarHits += 1;
      sidecarBody = b;
      sidecarAuth = req.headers.get("authorization");
      sidecarAccount = req.headers.get("chatgpt-account-id");
    });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      const prefix = "/backend-api/codex";
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
        return originalFetch(new URL(`${url.pathname.slice(prefix.length)}${url.search}`, sidecar!.url), init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const config: CodexCommanderConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "textonly",
      multiAgentGuidanceEnabled: true,
      providers: {
        textonly: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountMode: "direct",
        },
      },
      images: { videoBridgeEnabled: true, authSource: "api_key" },
    } as CodexCommanderConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const token = fakeChatGptJwt({ chatgpt_account_id: "acct-vision-sidecar" });
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": "acct-vision-sidecar",
        },
        body: JSON.stringify(baseRequest("textonly/blind-model")),
      });
      expect(res.status).toBe(200);

      // Activation evidence: the sidecar actually ran, got the image + OAuth passthrough.
      expect(sidecarHits).toBe(1);
      expect(sidecarAuth).toBe(`Bearer ${token}`);
      expect(sidecarAccount).toBe("acct-vision-sidecar");
      expect(sidecarBody).toContain("input_image");
      expect(sidecarBody).toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");

      // The text-only upstream saw the caption, not the image bytes.
      expect(upstreamBody).toContain(CAPTION);
      expect(upstreamBody).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain("image_url");
    } finally {
      await server.stop(true);
    }
  });

  test.each(UNCONFIRMED_VIDEO_INPUTS)(
    "video confirmation blocks passthrough before any upstream call: %s",
    async input => {
      let upstreamHits = 0;
      upstream = serveUpstream(() => { upstreamHits += 1; });
      saveConfig(videoPassthroughConfig(upstream.port, true));
      let videoSubmissionAttempts = 0;
      globalThis.fetch = ((request, init) => {
        const requestUrl = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
        if (new URL(requestUrl).hostname === "api.x.ai") {
          videoSubmissionAttempts += 1;
          throw new Error("unconfirmed video intent must not reach xAI");
        }
        return originalFetch(request, init);
      }) as typeof fetch;
      const server = startServer(0);
      try {
        const res = await postResponses(server.url, { model: "passthrough/model", input, stream: false });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ error: { code: "video_confirmation_required" } });
        expect(upstreamHits).toBe(0);
        expect(videoSubmissionAttempts).toBe(0);
      } finally {
        await server.stop(true);
      }
    },
  );

  test("malformed video-shaped request retains the normal parser error", async () => {
    let upstreamHits = 0;
    upstream = serveUpstream(() => { upstreamHits += 1; });
    saveConfig(videoPassthroughConfig(upstream.port));
    const server = startServer(0);
    try {
      const res = await postResponses(server.url, {
        model: "passthrough/model",
        input: "Create a video of a fox. Cancel.",
        stream: "invalid",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_request_error" } });
      expect(upstreamHits).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("non-video request still dispatches on the native passthrough path", async () => {
    let upstreamHits = 0;
    upstream = serveUpstream(() => { upstreamHits += 1; });
    saveConfig(videoPassthroughConfig(upstream.port));
    const server = startServer(0);
    try {
      const res = await postResponses(server.url, {
        model: "passthrough/model",
        input: "Summarize this paragraph.",
        stream: false,
      });
      expect(res.status).toBe(200);
      expect(upstreamHits).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("explicit video command enters native Responses replay with the video tool", async () => {
    let upstreamHits = 0;
    let upstreamBody = "";
    upstream = serveSidecar((_req, body) => {
      upstreamHits += 1;
      upstreamBody = body;
    });
    saveConfig(videoPassthroughConfig(upstream.port, true));
    const server = startServer(0);
    try {
      const res = await postResponses(server.url, {
        model: "passthrough/model",
        input: "Create a six second video of a paper boat at sea.",
        stream: true,
        tools: [{ type: "web_search" }],
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(upstreamHits).toBe(1);
      expect(upstreamBody).toContain('"name":"video_gen"');
      expect(upstreamBody).toContain('"type":"web_search"');
    } finally {
      await server.stop(true);
    }
  });

  test("type-less and plaintext encrypted-content user messages share the early consent gate", async () => {
    let upstreamHits = 0;
    const upstreamBodies: string[] = [];
    upstream = serveSidecar((_req, body) => {
      upstreamHits += 1;
      upstreamBodies.push(body);
    });
    saveConfig(videoPassthroughConfig(upstream.port, true));
    const server = startServer(0);
    try {
      const routedNormally = await postResponses(server.url, {
        model: "passthrough/model",
        input: [{
          role: "user",
          content: [{
            type: "encrypted_content",
            encrypted_content: "Create a video of a fox. Cancel.",
          }],
        }],
        stream: true,
      });
      expect(routedNormally.status).toBe(200);
      await routedNormally.text();
      expect(upstreamHits).toBe(1);
      expect(upstreamBodies[0]).not.toContain('"name":"video_gen"');

      const admitted = await postResponses(server.url, {
        model: "passthrough/model",
        input: [{
          role: "user",
          content: [{ type: "input_text", text: "Create a short video of a paper boat." }],
        }],
        stream: true,
      });
      expect(admitted.status).toBe(200);
      await admitted.text();
      expect(upstreamHits).toBe(2);
      expect(upstreamBodies[1]).toContain('"name":"video_gen"');

      const delegated = await postResponses(server.url, {
        model: "passthrough/model",
        input: [{
          type: "agent_message",
          author: "worker",
          recipient: "parent",
          content: [{
            type: "encrypted_content",
            encrypted_content: "Create a six second video of a paper boat.",
          }],
        }],
        stream: true,
      });
      expect(delegated.status).toBe(200);
      await delegated.text();
      expect(upstreamHits).toBe(3);
      expect(upstreamBodies[2]).not.toContain('"name":"video_gen"');
    } finally {
      await server.stop(true);
    }
  });

  test("video confirmation blocks both the vision sidecar and routed provider", async () => {
    let upstreamHits = 0;
    let sidecarHits = 0;
    upstream = serveUpstream(() => { upstreamHits += 1; });
    sidecar = serveSidecar(() => { sidecarHits += 1; });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      const prefix = "/backend-api/codex";
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
        return originalFetch(new URL(`${url.pathname.slice(prefix.length)}${url.search}`, sidecar!.url), init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const config: CodexCommanderConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "textonly",
      multiAgentGuidanceEnabled: true,
      providers: {
        textonly: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountMode: "direct",
        },
      },
      images: { videoBridgeEnabled: true, authSource: "api_key" },
    } as CodexCommanderConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const token = fakeChatGptJwt({ chatgpt_account_id: "acct-vision-video-gate" });
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": "acct-vision-video-gate",
        },
        body: JSON.stringify({
          ...baseRequest("textonly/blind-model"),
          input: [{ type: "message", role: "user", content: [
            { type: "input_text", text: "Maybe a video version?" },
            { type: "input_image", image_url: PNG_DATA_URL },
          ] }],
        }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "video_confirmation_required" } });
      expect(sidecarHits).toBe(0);
      expect(upstreamHits).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("models outside noVisionModels keep their image untouched (no sidecar call)", async () => {
    let upstreamBody = "";
    let sidecarHits = 0;
    upstream = serveUpstream(b => { upstreamBody = b; });
    sidecar = serveSidecar(() => { sidecarHits += 1; });

    const config: CodexCommanderConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "seeing",
      multiAgentGuidanceEnabled: true,
      providers: {
        seeing: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
    } as CodexCommanderConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer forward-oauth-token" },
        body: JSON.stringify(baseRequest("seeing/vision-model")),
      });
      expect(res.status).toBe(200);
      expect(sidecarHits).toBe(0);
      expect(upstreamBody).toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain(CAPTION);
    } finally {
      await server.stop(true);
    }
  });

  /*
   * #1043 activation evidence. The registry classification is only useful if the
   * strip actually fires for a Zen model, so this drives the real path with the
   * built-in `opencode-zen` list rather than a fixture list, and asserts the
   * observable effect: the image bytes are gone from the upstream body and the
   * omission marker is there instead.
   *
   * `big-pickle` is the id that reproduced the reported 400 verbatim against the
   * live endpoint (implementation contract).
   */
  test("a text-only Zen model has its image stripped before the upstream request (#1043)", async () => {
    let upstreamBody = "";
    upstream = serveUpstream(b => { upstreamBody = b; });

    const zen = PROVIDER_REGISTRY.find(p => p.id === "opencode-zen");
    expect(zen?.noVisionModels).toContain("big-pickle");

    const config: CodexCommanderConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "zenlike",
      multiAgentGuidanceEnabled: true,
      providers: {
        // A custom provider carrying the REGISTRY's list verbatim. The built-in
        // opencode-zen entry pins its own baseUrl, so it cannot be aimed at a local
        // upstream; what is under test is the classification, which is read from the
        // registry above rather than written out here.
        zenlike: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: zen?.noVisionModels,
        },
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
    } as CodexCommanderConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer forward-oauth-token" },
        body: JSON.stringify(baseRequest("zenlike/big-pickle")),
      });
      expect(res.status).toBe(200);
      // The effect, not merely a 200: no image bytes on the wire, marker present.
      expect(upstreamBody).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).toContain("[image omitted");
    } finally {
      await server.stop(true);
    }
  });

  test("a vision-capable Zen model keeps its image (#1043 negative case)", async () => {
    let upstreamBody = "";
    upstream = serveUpstream(b => { upstreamBody = b; });

    const zen = PROVIDER_REGISTRY.find(p => p.id === "opencode-zen");
    // Measured as accepting images; classifying it would silently degrade it.
    expect(zen?.noVisionModels).not.toContain("mimo-v2.5-free");

    const config: CodexCommanderConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "zenlike",
      multiAgentGuidanceEnabled: true,
      providers: {
        zenlike: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: zen?.noVisionModels,
        },
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
    } as CodexCommanderConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer forward-oauth-token" },
        body: JSON.stringify(baseRequest("zenlike/mimo-v2.5-free")),
      });
      expect(res.status).toBe(200);
      expect(upstreamBody).toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain("[image omitted");
    } finally {
      await server.stop(true);
    }
  });
});

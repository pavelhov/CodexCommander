import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { callXaiImages } from "../../src/images/xai-client";
import type { MediaCredentialBinding } from "../../src/images/types";
import { createStaticMediaCredentialLease } from "../../src/images/media-credentials";

const PREV_HOME = process.env.CODEXCOMMANDER_HOME;
beforeAll(() => { process.env.CODEXCOMMANDER_HOME = join(tmpdir(), "ccx-test-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.CODEXCOMMANDER_HOME; else process.env.CODEXCOMMANDER_HOME = PREV_HOME; });

const AUTH = { baseUrl: "https://api.x.ai", token: "test-token" };
const BINDING: MediaCredentialBinding = {
  authSource: "api_key",
  providerKind: "canonical",
  slotRef: "media-slot:test",
  identityDigest: "sha256:test",
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Replace globalThis.fetch with a stub that captures the request and returns a canned response. */
function stubFetch(status: number, body: unknown): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("callXaiImages", () => {
  test("bound operation resolves bearer inside transport and pins origin/headers", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    const lease = createStaticMediaCredentialLease(BINDING, "bound-transport-token");
    await callXaiImages({ prompt: "bound" }, BINDING, undefined, 5_000, { lease });
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/images/generations");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer bound-transport-token");
    expect([...headers.keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(calls[0]!.init?.redirect).toBe("manual");
  });

  test("legacy compatibility ignores base URL and cannot trigger OAuth fallback", async () => {
    const calls = stubFetch(401, { error: "rejected" });
    await expect(callXaiImages(
      { prompt: "legacy" },
      { baseUrl: "https://attacker.invalid/steal", token: "legacy-only-token" },
    )).rejects.toMatchObject({ code: "needs_auth", certainty: "definite" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/images/generations");
  });

  test("complete POST rejection table is exhaustive for the API-key source", async () => {
    const rows = [
      [400, "policy_rejected"],
      [401, "needs_auth"],
      [403, "entitlement_denied"],
      [429, "rate_limited"],
    ] as const;
    for (const [status, code] of rows) {
      let calls = 0;
      const fetchFn = (async () => {
        calls += 1;
        return new Response(JSON.stringify({ raw: "provider-body-sentinel" }), { status });
      }) as typeof fetch;
      const lease = createStaticMediaCredentialLease(BINDING, "key-source-only");
      let caught: unknown;
      try {
        await callXaiImages({ prompt: "status table" }, BINDING, undefined, 5_000, { lease, fetchFn });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code, status, certainty: "definite", retryable: false });
      expect(JSON.stringify(caught)).not.toContain("provider-body-sentinel");
      expect(calls).toBe(1);
    }
  });

  test("OAuth 403/429/network failures never refresh and never consult an API key", async () => {
    const oauthBinding = { ...BINDING, authSource: "subscription_oauth" } as const;
    const snapshot = {
      provider: "xai",
      accountId: "internal-slot",
      generation: "generation",
      accessToken: "oauth-only-access",
    };
    for (const outcome of [403, 429, "network"] as const) {
      let refreshes = 0;
      let sends = 0;
      const lease = {
        resolve: async () => ({ bearer: "oauth-only-access", oauthSnapshot: snapshot }),
        refreshAfterRejectedOAuth: async () => {
          refreshes += 1;
          throw new Error("must not refresh");
        },
      };
      const fetchFn = (async () => {
        sends += 1;
        if (outcome === "network") throw new Error("network-sentinel");
        return new Response(JSON.stringify({ raw: "body-sentinel" }), { status: outcome });
      }) as typeof fetch;
      await expect(callXaiImages(
        { prompt: "oauth isolation" }, oauthBinding, undefined, 5_000, { lease, fetchFn },
      )).rejects.toBeInstanceOf(Error);
      expect(refreshes).toBe(0);
      expect(sends).toBe(1);
    }
  });

  test("safe errors and console output redact credentials, prompts, bodies, identities, and signed URLs", async () => {
    const sentinels = [
      "credential-sentinel",
      "prompt-sentinel",
      "identity-sentinel",
      "body-sentinel",
      "https://cdn.invalid/result?signature=signed-url-sentinel",
    ];
    const lines: string[] = [];
    const previousWarn = console.warn;
    const previousError = console.error;
    console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
    console.error = (...args) => { lines.push(args.map(String).join(" ")); };
    try {
      const fetchFn = (async () => new Response(JSON.stringify({
        error: "body-sentinel",
        identity: "identity-sentinel",
        url: "https://cdn.invalid/result?signature=signed-url-sentinel",
      }), { status: 403 })) as typeof fetch;
      const secretBinding = { ...BINDING, identityDigest: "sha256:identity-sentinel" };
      const lease = createStaticMediaCredentialLease(secretBinding, "credential-sentinel");
      let caught: unknown;
      try {
        await callXaiImages(
          { prompt: "prompt-sentinel" }, secretBinding, undefined, 5_000, { lease, fetchFn },
        );
      } catch (error) {
        caught = error;
      }
      const exposed = `${JSON.stringify(caught)}\n${String(caught)}\n${lines.join("\n")}`;
      for (const sentinel of sentinels) expect(exposed).not.toContain(sentinel);
    } finally {
      console.warn = previousWarn;
      console.error = previousError;
    }
  });

  test("POST network, 5xx, redirect, malformed, and oversized success are ambiguous and never replayed", async () => {
    const cases: Array<{ name: string; fetchFn: typeof fetch }> = [
      { name: "network", fetchFn: (async () => { throw new Error("raw network detail"); }) as typeof fetch },
      { name: "5xx", fetchFn: (async () => new Response("upstream detail", { status: 503 })) as typeof fetch },
      { name: "redirect", fetchFn: (async () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } })) as typeof fetch },
      { name: "malformed", fetchFn: (async () => new Response("not-json", { status: 200 })) as typeof fetch },
      {
        name: "oversized",
        fetchFn: (async () => new Response(new Uint8Array(65 * 1024 * 1024), { status: 200 })) as typeof fetch,
      },
    ];
    for (const item of cases) {
      let calls = 0;
      const fetchFn = (async (input, init) => {
        calls += 1;
        return item.fetchFn(input, init);
      }) as typeof fetch;
      const lease = createStaticMediaCredentialLease(BINDING, "bound-token");
      await expect(callXaiImages(
        { prompt: item.name }, BINDING, undefined, 5_000, { lease, fetchFn },
      )).rejects.toMatchObject({ code: "ambiguous_submission", certainty: "ambiguous" });
      expect(calls).toBe(1);
    }
  });

  test("no imageUrl → POST /images/generations", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "a cat" }, AUTH);
    expect(calls[0]!.url).toContain("/images/generations");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  test("with imageUrl → POST /images/edits", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "edit this", imageUrl: "https://example.com/img.png" }, AUTH);
    expect(calls[0]!.url).toContain("/images/edits");
  });

  test("request body has correct model, prompt, n", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "a dog", model: "grok-imagine-fast", n: 3 }, AUTH);
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}");
    expect(body.model).toBe("grok-imagine-fast");
    expect(body.prompt).toBe("a dog");
    expect(body.n).toBe(3);
  });

  test("complete non-2xx returns typed status without provider body", async () => {
    stubFetch(429, { error: "rate limited" });
    await expect(callXaiImages({ prompt: "x" }, AUTH)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      certainty: "definite",
    });
  });

  test("incomplete 401 is ambiguous, never replayed, and cancels its body", async () => {
    let cancelled = false;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"rejected"}'));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await expect(callXaiImages({ prompt: "x" }, AUTH, undefined, 25)).rejects.toMatchObject({
      code: "ambiguous_submission",
      certainty: "ambiguous",
      reason: "timeout",
    });
    expect(calls).toBe(1);
    expect(cancelled).toBe(true);
  });

  test("2xx with b64_json → returns normalized XaiImageResult", async () => {
    stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    const result = await callXaiImages({ prompt: "x" }, AUTH);
    expect(result.images.length).toBe(1);
    expect(result.images[0]!.b64_json).toBe("dGVzdA==");
  });

  test("2xx with url → returns images[0].url", async () => {
    stubFetch(200, { data: [{ url: "https://cdn.example.com/img.png" }] });
    const result = await callXaiImages({ prompt: "x" }, AUTH);
    expect(result.images[0]!.url).toBe("https://cdn.example.com/img.png");
  });

  test("caller abort propagates into the composed signal", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    const controller = new AbortController();
    await callXaiImages({ prompt: "x" }, AUTH, controller.signal);
    const passed = calls[0]!.init?.signal as AbortSignal;
    expect(passed.aborted).toBe(false);
    controller.abort("client gone");
    expect(passed.aborted).toBe(true);
  });

  test("custom timeoutMs is composed into the abort signal", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "x" }, AUTH, undefined, 5_000);
    const passed = calls[0]!.init?.signal as AbortSignal;
    expect(passed).toBeDefined();
    expect(passed.aborted).toBe(false);
  });

  test("successful completion clears the attempt deadline instead of aborting later", async () => {
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input, init) => {
      seenSignal = init?.signal;
      return new Response(JSON.stringify({ data: [{ b64_json: "dGVzdA==" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await callXaiImages({ prompt: "x" }, AUTH, undefined, 50);
    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(seenSignal!.aborted).toBe(false);
  });

  test("trailing slash on baseUrl does not produce double-slash URL", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "x" }, { baseUrl: "https://api.x.ai/v1/", token: "test-token" });
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/images/generations");
  });

  test("size/quality mapped to aspect_ratio/resolution, no passthrough", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "x", size: "1024x1792", quality: "hd" }, AUTH);
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}");
    expect(body.aspect_ratio).toBe("9:16");
    expect(body.resolution).toBe("2k");
    expect(body).not.toHaveProperty("size");
    expect(body).not.toHaveProperty("quality");
  });

  test("square size → 1:1", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "x", size: "1024x1024" }, AUTH);
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}");
    expect(body.aspect_ratio).toBe("1:1");
    expect(body).not.toHaveProperty("resolution");
  });

  test("quality: standard → 1k", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "x", quality: "standard" }, AUTH);
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}");
    expect(body.resolution).toBe("1k");
    expect(body).not.toHaveProperty("aspect_ratio");
  });

  test("unknown size/quality dropped", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "x", size: "weird", quality: "ultra" }, AUTH);
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}");
    expect(body).not.toHaveProperty("aspect_ratio");
    expect(body).not.toHaveProperty("resolution");
    expect(body).not.toHaveProperty("size");
    expect(body).not.toHaveProperty("quality");
  });
});

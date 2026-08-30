import { describe, expect, test, mock, afterEach } from "bun:test";
import { submitVideoJob, pollVideoJob } from "../../src/images/xai-video-client";
import type { MediaCredentialBinding } from "../../src/images/types";
import { createStaticMediaCredentialLease } from "../../src/images/media-credentials";

const auth = { baseUrl: "https://api.x.ai/v1", token: "test-key" };
const binding: MediaCredentialBinding = {
  authSource: "subscription_oauth",
  providerKind: "canonical",
  slotRef: "media-oauth-slot:test",
  identityDigest: "sha256:test",
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("submitVideoJob", () => {
  test("OAuth 401 refreshes and replays exactly once", async () => {
    const attempts: string[] = [];
    const fetchMock = mock((_url: string, init: RequestInit) => {
      attempts.push(new Headers(init.headers).get("authorization") ?? "");
      return Promise.resolve(attempts.length === 1
        ? mockFetchResponse({}, 401)
        : mockFetchResponse({ request_id: "refreshed-job" }));
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const rejected = {
      provider: "xai",
      accountId: "opaque-internal-slot",
      generation: "old-generation",
      accessToken: "old-access",
    };
    let refreshes = 0;
    const lease = {
      resolve: async () => ({ bearer: "old-access", oauthSnapshot: rejected }),
      refreshAfterRejectedOAuth: async () => {
        refreshes += 1;
        return {
          bearer: "fresh-access",
          oauthSnapshot: { ...rejected, generation: "new-generation", accessToken: "fresh-access" },
        };
      },
    };
    const result = await submitVideoJob({ prompt: "refresh" }, binding, undefined, { lease });
    expect(result.requestId).toBe("refreshed-job");
    expect(refreshes).toBe(1);
    expect(attempts).toEqual(["Bearer old-access", "Bearer fresh-access"]);
  });

  test("a second complete OAuth 401 stops after one replay", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return mockFetchResponse({}, 401);
    }) as typeof fetch;
    const rejected = {
      provider: "xai",
      accountId: "opaque-internal-slot",
      generation: "old-generation",
      accessToken: "old-access",
    };
    let refreshes = 0;
    const lease = {
      resolve: async () => ({ bearer: "old-access", oauthSnapshot: rejected }),
      refreshAfterRejectedOAuth: async () => {
        refreshes += 1;
        return { bearer: "fresh-access", oauthSnapshot: { ...rejected, accessToken: "fresh-access" } };
      },
    };
    await expect(submitVideoJob({ prompt: "refresh" }, binding, undefined, { lease }))
      .rejects.toMatchObject({ code: "needs_auth", certainty: "definite" });
    expect(attempts).toBe(2);
    expect(refreshes).toBe(1);
  });

  test("missing request id after dispatch is ambiguous", async () => {
    globalThis.fetch = (async () => mockFetchResponse({ accepted: true })) as typeof fetch;
    const lease = createStaticMediaCredentialLease({ ...binding, authSource: "api_key" }, "key-only");
    await expect(submitVideoJob(
      { prompt: "missing id" }, { ...binding, authSource: "api_key" }, undefined, { lease },
    )).rejects.toMatchObject({ code: "ambiguous_submission", certainty: "ambiguous" });
  });

  test("returns request_id from response", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ request_id: "vid-123" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await submitVideoJob({ prompt: "a cat playing piano" }, auth);
    expect(result.requestId).toBe("vid-123");
  });

  test("accepts id field as fallback", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ id: "vid-456" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await submitVideoJob({ prompt: "sunset" }, auth);
    expect(result.requestId).toBe("vid-456");
  });

  test("sends correct POST body", async () => {
    let capturedBody: string | undefined;
    const fetchMock = mock((url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve(mockFetchResponse({ request_id: "r1" }));
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await submitVideoJob(
      { prompt: "dance", model: "grok-imagine-video", duration: 5, resolution: "720p", aspectRatio: "16:9" },
      auth,
    );

    const body = JSON.parse(capturedBody!);
    expect(body.prompt).toBe("dance");
    expect(body.model).toBe("grok-imagine-video");
    expect(body.duration).toBe(5);
    expect(body.resolution).toBe("720p");
    expect(body.aspect_ratio).toBe("16:9");
  });

  test("throws on non-2xx response", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ error: "rate limited" }, 429)));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await expect(submitVideoJob({ prompt: "test" }, auth)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      certainty: "definite",
    });
  });

  test("throws when request_id is missing", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ foo: "bar" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await expect(submitVideoJob({ prompt: "test" }, auth)).rejects.toMatchObject({
      code: "ambiguous_submission",
      reason: "missing_result",
    });
  });
});

describe("pollVideoJob", () => {
  test("GET classifies only 429/5xx/network outcomes as safe runtime retries and does not replay itself", async () => {
    const cases: Array<Response | Error> = [
      mockFetchResponse({}, 429),
      mockFetchResponse({}, 503),
      new Error("network detail"),
    ];
    for (const outcome of cases) {
      let attempts = 0;
      const fetchFn = (async () => {
        attempts += 1;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }) as typeof fetch;
      const keyBinding = { ...binding, authSource: "api_key" } as const;
      const lease = createStaticMediaCredentialLease(keyBinding, "key-only");
      await expect(pollVideoJob("vid-safe-retry", keyBinding, undefined, { lease, fetchFn }))
        .rejects.toMatchObject({ code: "poll_retryable", retryable: true, certainty: "definite" });
      expect(attempts).toBe(1);
    }
  });

  test("GET redirect is rejected without replay and never forwards bearer to Location", async () => {
    let attempts = 0;
    const fetchFn = (async () => {
      attempts += 1;
      return new Response(null, { status: 307, headers: { location: "https://attacker.invalid/result" } });
    }) as typeof fetch;
    const keyBinding = { ...binding, authSource: "api_key" } as const;
    const lease = createStaticMediaCredentialLease(keyBinding, "key-only");
    await expect(pollVideoJob("vid-redirect", keyBinding, undefined, { lease, fetchFn }))
      .rejects.toMatchObject({ code: "upstream_failed", retryable: false });
    expect(attempts).toBe(1);
  });

  test("returns done status with video URL", async () => {
    let calls = 0;
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({
      status: "done",
      video: { url: "https://cdn.x.ai/video.mp4" },
    })).then(response => { calls += 1; return response; }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await pollVideoJob("vid-123", auth);
    expect(result.status).toBe("done");
    expect(result.videoUrl).toBe("https://cdn.x.ai/video.mp4");
    expect(calls).toBe(1); // Result URL is returned to the credentialless downloader, never fetched here.
  });

  test("normalizes completed → done", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ status: "completed" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await pollVideoJob("vid-123", auth);
    expect(result.status).toBe("done");
  });

  test("normalizes error → failed", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ state: "error" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await pollVideoJob("vid-123", auth);
    expect(result.status).toBe("failed");
  });

  test("returns processing for unknown status", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ status: "rendering" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await pollVideoJob("vid-123", auth);
    expect(result.status).toBe("processing");
  });

  test("throws on non-2xx response", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({}, 401)));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await expect(pollVideoJob("vid-123", auth)).rejects.toMatchObject({
      code: "needs_auth",
      status: 401,
      retryable: false,
    });
  });

  test("uses GET method on poll URL", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    const fetchMock = mock((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init.method;
      return Promise.resolve(mockFetchResponse({ status: "processing" }));
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await pollVideoJob("vid-789", { baseUrl: "https://attacker.invalid", token: "test-key" });
    expect(capturedUrl).toBe("https://api.x.ai/v1/videos/vid-789");
    expect(capturedMethod).toBe("GET");
  });

  test("expired absolute deadline fails before resolving credentials or dispatching GET", async () => {
    let leaseCalls = 0;
    let fetchCalls = 0;
    const keyBinding = { ...binding, authSource: "api_key" } as const;
    const lease = {
      resolve: async () => { leaseCalls += 1; return { bearer: "unexpected" }; },
      refreshAfterRejectedOAuth: async () => { throw new Error("unexpected"); },
    };
    const fetchFn = (async () => {
      fetchCalls += 1;
      return mockFetchResponse({ status: "processing" });
    }) as typeof fetch;
    await expect(pollVideoJob("vid-expired", keyBinding, undefined, {
      lease,
      fetchFn,
      deadlineAt: Date.now() - 1,
    })).rejects.toMatchObject({ code: "timeout", phase: "pre_dispatch", certainty: "definite" });
    expect(leaseCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("encodes requestId in poll URL", async () => {
    let capturedUrl: string | undefined;
    const fetchMock = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchResponse({ status: "processing" }));
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await pollVideoJob("req/with?special&chars", auth);
    expect(capturedUrl).toContain(encodeURIComponent("req/with?special&chars"));
    // Must NOT contain the raw special chars in the path
    expect(capturedUrl).not.toMatch(/\/videos\/req\/with/);
  });
});

import { describe, expect, test } from "bun:test";

import type { MediaCredentialBinding } from "../../src/images/types";
import { pollVideoJob, submitVideoJob, XAI_VIDEO_MODEL } from "../../src/images/xai-video-client";
import { createStaticMediaCredentialLease } from "../helpers/static-media-credential-lease";

const oauthBinding: MediaCredentialBinding = {
  authSource: "subscription_oauth",
  providerKind: "canonical",
  slotRef: "media-oauth-slot:test",
  identityDigest: "sha256:test",
};
const keyBinding: MediaCredentialBinding = { ...oauthBinding, authSource: "api_key" };

function keyLease() {
  return createStaticMediaCredentialLease(keyBinding, "key-only");
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("submitVideoJob", () => {
  test("serializes the stable 1.5 text-to-video contract including 1080p and audio", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const result = await submitVideoJob({
      prompt: "dance",
      model: XAI_VIDEO_MODEL,
      duration: 15,
      resolution: "1080p",
      aspectRatio: "9:16",
      audio: true,
    }, keyBinding, undefined, {
      lease: keyLease(),
      fetchFn: (async (url, init) => {
        capturedUrl = String(url);
        capturedBody = String(init?.body);
        return json({ request_id: "vid-123" });
      }) as typeof fetch,
    });

    expect(result).toEqual({ requestId: "vid-123" });
    expect(capturedUrl).toBe("https://api.x.ai/v1/videos/generations");
    expect(JSON.parse(capturedBody)).toEqual({
      model: "grok-imagine-video-1.5",
      prompt: "dance",
      duration: 15,
      resolution: "1080p",
      aspect_ratio: "9:16",
      audio: true,
    });
  });

  test("serializes deterministic defaults", async () => {
    let captured: Record<string, unknown> | undefined;
    await submitVideoJob({ prompt: "default" }, keyBinding, undefined, {
      lease: keyLease(),
      fetchFn: (async (_url, init) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ id: "vid-default" });
      }) as typeof fetch,
    });
    expect(captured).toEqual({
      model: "grok-imagine-video-1.5",
      prompt: "default",
      duration: 6,
      resolution: "720p",
      aspect_ratio: "16:9",
    });
  });

  test.each([
    { prompt: "bad", duration: 0 },
    { prompt: "bad", duration: 16 },
    { prompt: "bad", duration: 1.5 },
    { prompt: "bad", resolution: "4k" },
    { prompt: "bad", aspectRatio: "5:4" },
    { prompt: "bad", model: "grok-imagine-video" },
    { prompt: "bad", image_url: "https://example.test/input.png" },
  ])("rejects invalid/non-text input before credential resolution or POST: %j", async request => {
    let leaseCalls = 0;
    let fetchCalls = 0;
    const lease = {
      resolve: async () => { leaseCalls += 1; return { bearer: "unexpected" }; },
      refreshAfterRejectedOAuth: async () => { throw new Error("unexpected"); },
    };
    await expect(submitVideoJob(request as never, keyBinding, undefined, {
      lease,
      fetchFn: (async () => { fetchCalls += 1; return json({ request_id: "unexpected" }); }) as typeof fetch,
    })).rejects.toMatchObject({ code: "invalid_request", phase: "pre_dispatch" });
    expect(leaseCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("OAuth 401 refreshes and replays exactly once", async () => {
    const authorizations: string[] = [];
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
    const result = await submitVideoJob({ prompt: "refresh" }, oauthBinding, undefined, {
      lease,
      fetchFn: (async (_url, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        return authorizations.length === 1 ? json({}, 401) : json({ request_id: "refreshed-job" });
      }) as typeof fetch,
    });
    expect(result.requestId).toBe("refreshed-job");
    expect(refreshes).toBe(1);
    expect(authorizations).toEqual(["Bearer old-access", "Bearer fresh-access"]);
  });

  test("complete rejection and ambiguous-success classifications are preserved", async () => {
    await expect(submitVideoJob({ prompt: "rate" }, keyBinding, undefined, {
      lease: keyLease(),
      fetchFn: (async () => json({}, 429)) as typeof fetch,
    })).rejects.toMatchObject({ code: "rate_limited", certainty: "definite", status: 429 });
    await expect(submitVideoJob({ prompt: "missing" }, keyBinding, undefined, {
      lease: keyLease(),
      fetchFn: (async () => json({ accepted: true })) as typeof fetch,
    })).rejects.toMatchObject({ code: "ambiguous_submission", certainty: "ambiguous" });
  });
});

describe("pollVideoJob", () => {
  test("refreshes the same OAuth account after a complete poll 401 without any submit", async () => {
    let polls = 0;
    let refreshes = 0;
    const rejected = {
      provider: "xai",
      accountId: "bound-account",
      generation: "generation-1",
      accessToken: "old",
    };
    const lease = {
      resolve: async () => ({ bearer: "old", oauthSnapshot: rejected }),
      refreshAfterRejectedOAuth: async (candidate: MediaCredentialBinding, snapshot: typeof rejected) => {
        expect(candidate).toBe(oauthBinding);
        expect(snapshot.accountId).toBe("bound-account");
        refreshes += 1;
        return { bearer: "fresh", oauthSnapshot: { ...rejected, generation: "generation-2", accessToken: "fresh" } };
      },
    };
    const result = await pollVideoJob("accepted-id", oauthBinding, undefined, {
      lease,
      fetchFn: (async () => {
        polls += 1;
        return polls === 1 ? json({}, 401) : json({ status: "done", video: { url: "https://cdn.example/video.mp4" } });
      }) as typeof fetch,
    });
    expect(result).toEqual({ status: "done", videoUrl: "https://cdn.example/video.mp4" });
    expect(refreshes).toBe(1);
    expect(polls).toBe(2);
  });

  test.each([429, 500, 503])("classifies HTTP %d as one safe GET retry outcome", async status => {
    let attempts = 0;
    await expect(pollVideoJob("vid-safe-retry", keyBinding, undefined, {
      lease: keyLease(),
      fetchFn: (async () => { attempts += 1; return json({}, status); }) as typeof fetch,
    })).rejects.toMatchObject({ code: "poll_retryable", retryable: true, certainty: "definite" });
    expect(attempts).toBe(1);
  });

  test("carries only a bounded Retry-After delay hint for safe poll retries", async () => {
    const rows = [
      ["2", 2_000],
      ["0", 250],
      ["999999999", 60_000],
      ["not-a-delay", 5_000],
    ] as const;
    for (const [retryAfter, retryAfterMs] of rows) {
      let caught: unknown;
      try {
        await pollVideoJob("vid-retry-delay", keyBinding, undefined, {
          lease: keyLease(),
          fetchFn: (async () => json({}, 429, { "Retry-After": retryAfter })) as typeof fetch,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "poll_retryable",
        retryable: true,
        retryAfterMs,
      });
      expect(caught).not.toHaveProperty("retryAfter");
    }
  });

  test("normalizes pending, failed, expired, and completed results", async () => {
    const outcomes = [
      [{ status: "rendering" }, "processing"],
      [{ state: "error" }, "failed"],
      [{ status: "expired" }, "expired"],
      [{ status: "completed", videos: [{ url: "https://cdn.example/result.mp4" }] }, "done"],
    ] as const;
    for (const [body, status] of outcomes) {
      const result = await pollVideoJob("vid-status", keyBinding, undefined, {
        lease: keyLease(),
        fetchFn: (async () => json(body)) as typeof fetch,
      });
      expect(result.status).toBe(status);
    }
  });

  test("uses a fixed encoded GET URL and rejects redirects", async () => {
    let capturedUrl = "";
    await expect(pollVideoJob("req/with?special", keyBinding, undefined, {
      lease: keyLease(),
      fetchFn: (async (url) => {
        capturedUrl = String(url);
        return new Response(null, { status: 307, headers: { location: "https://attacker.invalid" } });
      }) as typeof fetch,
    })).rejects.toMatchObject({ code: "upstream_failed", retryable: false });
    expect(capturedUrl).toBe(`https://api.x.ai/v1/videos/${encodeURIComponent("req/with?special")}`);
  });

  test("expired absolute deadline performs zero credential or GET work", async () => {
    let leaseCalls = 0;
    let fetchCalls = 0;
    await expect(pollVideoJob("vid-expired", keyBinding, undefined, {
      deadlineAt: 10,
      now: () => 11,
      lease: {
        resolve: async () => { leaseCalls += 1; return { bearer: "unexpected" }; },
        refreshAfterRejectedOAuth: async () => { throw new Error("unexpected"); },
      },
      fetchFn: (async () => { fetchCalls += 1; return json({ status: "processing" }); }) as typeof fetch,
    })).rejects.toMatchObject({ code: "timeout", phase: "pre_dispatch" });
    expect(leaseCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import {
  createReadinessGate,
  runStartupReadinessSync,
} from "../src/server/readiness";
import {
  attestLiveManagementProxy,
  findLiveProxy,
  isCodexCommanderHealthz,
  probeHostname,
  probeReadiness,
  proxyIdentityAt,
  validateReadyzBody,
  runtimeReplacementDisposition,
} from "../src/server/proxy-liveness";
import {
  createLocalAttestationMetadataProof,
  createLocalAttestationProof,
} from "../src/lib/local-management-attestation";
import {
  ATTESTATION_CHALLENGE_HEADER,
  ATTESTATION_METADATA_PROOF_HEADER,
  ATTESTATION_PROOF_HEADER,
} from "../src/identity";
import { PROXY_LIFECYCLE_LEASE_CAPABILITY_HEADER } from "../src/server/proxy-start-lock";
import {
  PROXY_LIFECYCLE_COMPATIBILITY_GENERATION_HEADER,
  PROXY_RUNTIME_VERSION_HEADER,
} from "../src/server/proxy-lifecycle-protocol";

function healthz(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const OURS = { status: "ok", service: "codexcommander", version: "0.1.0", uptime: 12, pid: 4242, port: 10100 };

describe("isCodexCommanderHealthz", () => {
  test("accepts the explicit service marker", () => {
    expect(isCodexCommanderHealthz(OURS)).toBe(true);
  });

  test("rejects foreign bodies", () => {
    expect(isCodexCommanderHealthz(null)).toBe(false);
    expect(isCodexCommanderHealthz({ status: "ok" })).toBe(false);
    expect(isCodexCommanderHealthz({ service: "something-else", status: "ok", version: "1", uptime: 1 })).toBe(false);
    expect(isCodexCommanderHealthz({ healthy: true } as never)).toBe(false);
  });
});

describe("probeHostname", () => {
  test("wildcards and empty answer on IPv4 loopback; concrete hosts pass through", () => {
    expect(probeHostname(undefined)).toBe("127.0.0.1");
    expect(probeHostname("0.0.0.0")).toBe("127.0.0.1");
    expect(probeHostname("::")).toBe("127.0.0.1");
    expect(probeHostname("192.168.1.20")).toBe("192.168.1.20");
  });

  test("raw IPv6 hosts are bracketed so the healthz URL stays valid", () => {
    expect(probeHostname("::1")).toBe("[::1]");
    expect(probeHostname("[::1]")).toBe("[::1]");
    expect(probeHostname("2001:db8::5")).toBe("[2001:db8::5]");
  });
});

describe("proxyIdentityAt", () => {
  test("returns the reported pid for our proxy", async () => {
    const identity = await proxyIdentityAt(10100, {}, { fetchFn: (async () => healthz(OURS)) as typeof fetch });
    expect(identity).toEqual({ pid: 4242 });
  });

  test("rejects foreign 200s, non-OK responses, and pid mismatches", async () => {
    expect(await proxyIdentityAt(10100, {}, { fetchFn: (async () => healthz({ ok: true })) as typeof fetch })).toBeNull();
    expect(await proxyIdentityAt(10100, {}, { fetchFn: (async () => healthz(OURS, 503)) as typeof fetch })).toBeNull();
    expect(await proxyIdentityAt(10100, { expectedPid: 1 }, { fetchFn: (async () => healthz(OURS)) as typeof fetch })).toBeNull();
    expect(await proxyIdentityAt(10100, {}, { fetchFn: (async () => { throw new Error("refused"); }) as typeof fetch })).toBeNull();
  });

  test("rejects an identity body without a current process pid", async () => {
    const { pid: _pid, ...pidless } = OURS;
    expect(await proxyIdentityAt(10100, {}, {
      fetchFn: (async () => healthz(pidless)) as typeof fetch,
    })).toBeNull();
  });

  test("retries transport failures and succeeds on a later attempt (#764)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const identity = await proxyIdentityAt(10100, {}, {
      attempts: 3,
      timeoutMs: 50,
      sleepFn: async (ms) => { sleeps.push(ms); },
      fetchFn: (async () => {
        calls += 1;
        if (calls < 3) throw new Error("timeout");
        return healthz(OURS);
      }) as typeof fetch,
    });
    expect(identity).toEqual({ pid: 4242 });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 100]);
  });

  test("does not retry a definitive foreign /healthz body", async () => {
    let calls = 0;
    const identity = await proxyIdentityAt(10100, {}, {
      attempts: 3,
      fetchFn: (async () => {
        calls += 1;
        return healthz({ ok: true });
      }) as typeof fetch,
    });
    expect(identity).toBeNull();
    expect(calls).toBe(1);
  });

  test("NaN attempts fall back to a single probe", async () => {
    let calls = 0;
    const identity = await proxyIdentityAt(10100, {}, {
      attempts: Number.NaN,
      fetchFn: (async () => {
        calls += 1;
        return healthz(OURS);
      }) as typeof fetch,
    });
    expect(identity).toEqual({ pid: 4242 });
    expect(calls).toBe(1);
  });

  test("honors an aggregate deadline across transport retries", async () => {
    let calls = 0;
    let clock = 1_000;
    const identity = await proxyIdentityAt(10100, {}, {
      attempts: 3,
      timeoutMs: 1_500,
      deadlineAt: 1_000 + 1_200,
      nowFn: () => clock,
      sleepFn: async () => { clock += 100; },
      fetchFn: (async () => {
        calls += 1;
        clock += 1_500;
        throw new Error("timeout");
      }) as typeof fetch,
    });
    expect(identity).toBeNull();
    // First attempt spends the budget; remaining retries must not fire.
    expect(calls).toBe(1);
  });
});

describe("attestLiveManagementProxy", () => {
  const pid = 4242;
  const port = 19191;
  const hostname = "127.0.0.1";

  function record(secret: string, attestationProtocol?: 2) {
    return { pid, port, hostname, attestationSecret: secret, ...(attestationProtocol ? { attestationProtocol } : {}) };
  }

  function proofResponse(
    secret: string,
    input: string | URL | Request,
    init?: RequestInit,
    lifecycleLease = false,
    runtime?: { version: string; generation: number; v2?: boolean; signedVersion?: string; signedGeneration?: number },
  ): Response {
    expect(String(input)).toBe(`http://${hostname}:${port}/healthz`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-codexcommander-api-key")).toBeNull();
    expect(init?.body).toBeUndefined();
    const challenge = headers.get(ATTESTATION_CHALLENGE_HEADER)!;
    const proof = createLocalAttestationProof(secret, challenge, pid, port)!;
    const responseHeaders = new Headers({ [ATTESTATION_PROOF_HEADER]: proof });
    if (lifecycleLease) responseHeaders.set(PROXY_LIFECYCLE_LEASE_CAPABILITY_HEADER, "1");
    if (runtime) {
      responseHeaders.set(PROXY_RUNTIME_VERSION_HEADER, runtime.version);
      responseHeaders.set(PROXY_LIFECYCLE_COMPATIBILITY_GENERATION_HEADER, String(runtime.generation));
      if (runtime.v2) responseHeaders.set(
        ATTESTATION_METADATA_PROOF_HEADER,
        createLocalAttestationMetadataProof(secret, challenge, pid, port, runtime.signedVersion ?? runtime.version, runtime.signedGeneration ?? runtime.generation, lifecycleLease)!,
      );
    }
    return new Response("ignored", { headers: responseHeaders });
  }

  test("authenticates one exact protected runtime record without reading health JSON", async () => {
    const secret = "A".repeat(43);
    const target = await attestLiveManagementProxy({
      readRuntimeFn: () => record(secret),
      verifyPidFn: candidate => candidate,
      fetchFn: (async (input, init) => proofResponse(secret, input, init)) as typeof fetch,
    });
    expect(target).toMatchObject({
      pid,
      port,
      hostname,
      source: "runtime",
      baseUrl: `http://${hostname}:${port}`,
      lifecycleLockLeaseV1: false,
    });
    expect(target?.runtimeRecordIdentity).toMatch(/^4242:19191:127\.0\.0\.1:1:[a-f0-9]{64}$/);
  });

  test("captures the authenticated lifecycle-lease capability header", async () => {
    const secret = "A".repeat(43);
    const target = await attestLiveManagementProxy({
      readRuntimeFn: () => record(secret),
      verifyPidFn: candidate => candidate,
      fetchFn: (async (input, init) => proofResponse(secret, input, init, true)) as typeof fetch,
    });
    expect(target?.lifecycleLockLeaseV1).toBe(true);
  });

  test("captures authenticated runtime version and compatibility-generation headers", async () => {
    const secret = "A".repeat(43);
    const target = await attestLiveManagementProxy({
      readRuntimeFn: () => record(secret, 2),
      verifyPidFn: candidate => candidate,
      fetchFn: (async (input, init) => proofResponse(
        secret,
        input,
        init,
        true,
        { version: "1.2.3", generation: 7, v2: true },
      )) as typeof fetch,
    });
    expect(target).toMatchObject({ runtimeVersion: "1.2.3", lifecycleCompatibilityGeneration: 7 });
  });

  test("a v2 runtime rejects stripped metadata", async () => {
    const secret = "A".repeat(43);
    const recordV2 = () => record(secret, 2);
    expect(await attestLiveManagementProxy({
      attempts: 1,
      readRuntimeFn: recordV2,
      verifyPidFn: candidate => candidate,
      fetchFn: (async (input, init) => proofResponse(secret, input, init)) as typeof fetch,
    })).toBeNull();
  });

  test("a v2 runtime rejects altered present metadata", async () => {
    const secret = "A".repeat(43);
    expect(await attestLiveManagementProxy({
      attempts: 1,
      readRuntimeFn: () => record(secret, 2),
      verifyPidFn: candidate => candidate,
      fetchFn: (async (input, init) => proofResponse(
        secret, input, init, true,
        { version: "9.9.9", generation: 7, signedVersion: "1.2.3", signedGeneration: 7, v2: true },
      )) as typeof fetch,
    })).toBeNull();
  });

  test("a v2 runtime rejects non-canonical or unsafe generation headers", async () => {
    const secret = "A".repeat(43);
    for (const generation of ["02", "9007199254740992"]) {
      expect(await attestLiveManagementProxy({
        attempts: 1,
        readRuntimeFn: () => record(secret, 2),
        verifyPidFn: candidate => candidate,
        fetchFn: (async (input, init) => {
          const response = proofResponse(secret, input, init, true, { version: "1.2.3", generation: 2, v2: true });
          response.headers.set(PROXY_LIFECYCLE_COMPATIBILITY_GENERATION_HEADER, generation);
          return response;
        }) as typeof fetch,
      })).toBeNull();
    }
  });

  test("rejects missing/malformed records and wrong proofs", async () => {
    let fetchCalls = 0;
    for (const runtime of [
      null,
      { pid, port, hostname },
      record("short"),
      { ...record("A".repeat(43)), pid: undefined },
    ]) {
      expect(await attestLiveManagementProxy({
        attempts: 1,
        readRuntimeFn: () => runtime,
        verifyPidFn: candidate => candidate,
        fetchFn: (async () => {
          fetchCalls += 1;
          return new Response("should not be reached");
        }) as typeof fetch,
      })).toBeNull();
    }
    expect(fetchCalls).toBe(0);

    const secret = "A".repeat(43);
    expect(await attestLiveManagementProxy({
      attempts: 1,
      readRuntimeFn: () => record(secret),
      verifyPidFn: candidate => candidate,
      fetchFn: (async () => new Response("spoof", {
        headers: { [ATTESTATION_PROOF_HEADER]: "B".repeat(43) },
      })) as typeof fetch,
    })).toBeNull();
  });

  test("a record rotation retries from a fresh record and challenge", async () => {
    const first = "A".repeat(43);
    const second = "B".repeat(43);
    let reads = 0;
    let challenges = 0;
    const target = await attestLiveManagementProxy({
      attempts: 2,
      readRuntimeFn: () => {
        reads += 1;
        // attempt 1 pre=A, post=B; attempt 2 pre/post=B
        return record(reads === 1 ? first : second);
      },
      verifyPidFn: candidate => candidate,
      fetchFn: (async (input, init) => {
        challenges += 1;
        return proofResponse(challenges === 1 ? first : second, input, init);
      }) as typeof fetch,
    });
    expect(target?.baseUrl).toBe(`http://${hostname}:${port}`);
    expect(challenges).toBe(2);
  });

  test("never consumes declared-huge or unbounded streaming spoof bodies", async () => {
    const secret = "A".repeat(43);
    let pulls = 0;
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() { cancels += 1; },
    });
    const target = await attestLiveManagementProxy({
      attempts: 1,
      readRuntimeFn: () => record(secret),
      verifyPidFn: candidate => candidate,
      fetchFn: (async (_input, init) => {
        const challenge = new Headers(init?.headers).get(ATTESTATION_CHALLENGE_HEADER)!;
        const proof = createLocalAttestationProof(secret, challenge, pid, port)!;
        return new Response(body, {
          headers: {
            "content-length": String(1024 ** 3),
            [ATTESTATION_PROOF_HEADER]: proof,
          },
        });
      }) as typeof fetch,
    });
    expect(target).not.toBeNull();
    expect(cancels).toBe(1);
    expect(pulls).toBeLessThanOrEqual(1);
  });
});

describe("runtime replacement metadata", () => {
  const base = {
    pid: 1,
    port: 10100,
    source: "runtime" as const,
    baseUrl: "http://127.0.0.1:10100",
    lifecycleLockLeaseV1: true,
  };
  const expected = { version: "1.2.3", lifecycleCompatibilityGeneration: 2 };

  test("only both absent headers are legacy stale", () => {
    expect(runtimeReplacementDisposition(base, expected)).toBe("stale");
    expect(runtimeReplacementDisposition({ ...base, runtimeVersion: "1.2.3" }, expected)).toBe("unknown");
    expect(runtimeReplacementDisposition({ ...base, lifecycleCompatibilityGeneration: 2 }, expected)).toBe("unknown");
  });

  test("invalid and contradictory metadata refuses replacement while newer evidence dominates", () => {
    expect(runtimeReplacementDisposition({ ...base, runtimeVersion: "nope", lifecycleCompatibilityGeneration: 2 }, expected)).toBe("unknown");
    expect(runtimeReplacementDisposition({ ...base, runtimeVersion: "1.2.2", lifecycleCompatibilityGeneration: 3 }, expected)).toBe("newer");
    expect(runtimeReplacementDisposition({ ...base, runtimeVersion: "1.2.4", lifecycleCompatibilityGeneration: 1 }, expected)).toBe("newer");
  });

  test("compares SemVer prereleases before stable releases and ignores build metadata", () => {
    expect(runtimeReplacementDisposition({ ...base, runtimeVersion: "1.2.3-alpha.2", lifecycleCompatibilityGeneration: 2 }, expected)).toBe("stale");
    expect(runtimeReplacementDisposition({ ...base, runtimeVersion: "1.2.3+build.9", lifecycleCompatibilityGeneration: 2 }, expected)).toBe("compatible");
    expect(runtimeReplacementDisposition({ ...base, runtimeVersion: "1.2.3-999999999999999999999999", lifecycleCompatibilityGeneration: 2 }, {
      version: "1.2.3-1000000000000000000000000", lifecycleCompatibilityGeneration: 2,
    })).toBe("stale");
  });
});

describe("findLiveProxy", () => {
  test("prefers the runtime-port record over config.port (fallback-port starts are found)", async () => {
    const urls: string[] = [];
    const live = await findLiveProxy({
      readPidFn: () => 4242,
      readRuntimeFn: pid => (pid === 4242 ? { port: 58195 } : null),
      configFn: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return healthz(OURS);
      }) as typeof fetch,
    });

    expect(live).toEqual({ pid: 4242, port: 58195, source: "runtime" });
    expect(urls).toEqual(["http://127.0.0.1:58195/healthz"]);
  });

  test("falls back to config.port only when no runtime record answers, taking pid from the body", async () => {
    const live = await findLiveProxy({
      readPidFn: () => null,
      readRuntimeFn: () => null,
      configFn: () => ({ port: 10100 }),
      verifyPidFn: candidate => candidate,
      fetchFn: (async () => healthz(OURS)) as typeof fetch,
    });

    expect(live).toEqual({ pid: 4242, port: 10100, source: "config" });
  });

  test("a foreign listener on the configured port is not treated as our proxy", async () => {
    const live = await findLiveProxy({
      readPidFn: () => null,
      readRuntimeFn: () => null,
      configFn: () => ({ port: 10100 }),
      fetchFn: (async () => healthz({ status: "ok" })) as typeof fetch,
    });

    expect(live).toBeNull();
  });

  test("adopts an orphaned runtime record when the pid file is lost (identity-checked)", async () => {
    const urls: string[] = [];
    const live = await findLiveProxy({
      readPidFn: () => null,
      readRuntimeFn: () => ({ pid: 4242, port: 58195, hostname: "::1" }),
      configFn: () => ({ port: 10100 }),
      verifyPidFn: candidate => candidate,
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return healthz(OURS);
      }) as typeof fetch,
    });

    expect(live).toEqual({ pid: 4242, port: 58195, hostname: "::1", source: "runtime" });
    expect(urls).toEqual(["http://[::1]:58195/healthz"]);
  });

  test("ignores a retired runtime hint without a pid", async () => {
    const live = await findLiveProxy({
      readPidFn: () => null,
      readRuntimeFn: () => ({ port: 58195 }),
      configFn: () => ({ port: 10100 }),
      verifyPidFn: candidate => candidate,
      fetchFn: (async (url: string | URL | Request) => {
        if (String(url).includes("58195")) throw new Error("retired hint must not be probed");
        return healthz(OURS);
      }) as typeof fetch,
    });

    expect(live).toEqual({ pid: 4242, port: 10100, source: "config" });
  });

  test("an orphaned record whose healthz pid mismatches is rejected (config fallback still runs)", async () => {
    const live = await findLiveProxy({
      readPidFn: () => null,
      readRuntimeFn: () => ({ pid: 1111, port: 58195, hostname: undefined }),
      configFn: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) =>
        String(url).includes("58195") ? healthz({ ...OURS, pid: 9999 }) : healthz({ status: "ok" })) as typeof fetch,
    });

    expect(live).toBeNull();
  });

  test("a runtime record whose healthz reports a different pid is rejected", async () => {
    const live = await findLiveProxy({
      readPidFn: () => 1111,
      verifyPidFn: () => null,
      readRuntimeFn: () => ({ port: 58195 }),
      configFn: () => ({ port: 58195 }),
      fetchFn: (async () => healthz({ ...OURS, pid: 9999 })) as typeof fetch,
    });

    // healthz-reported pids must pass identity verification before they become kill targets.
    expect(live).toEqual({ pid: null, port: 58195, source: "config" });
  });

});

// ── findLiveProxy single-deadline candidate gating ───────────────────────────
// The absolute deadlineAt must gate EVERY internal candidate probe, not just
// the first. proxyIdentityAt recomputes the remaining budget against the
// injected nowFn before each attempt: a non-positive remaining aborts without
// fetching, and each probe's timeoutMs is capped to min(existing per-probe cap,
// positive remaining). Existing no-deadline callers keep their current
// semantics (no deadlineAt → unbounded per-probe default).
describe("findLiveProxy single-deadline candidate gating", () => {
  test("deadline already expired before the first probe → no fetch, returns null", async () => {
    let fetchCalls = 0;
    const live = await findLiveProxy({
      deadlineAt: 1000,
      nowFn: () => 2000, // already past the deadline before any probe
      readPidFn: () => 4242,
      readRuntimeFn: pid => (pid === 4242 ? { port: 58195 } : null),
      configFn: () => ({ port: 10100 }),
      fetchFn: (async () => { fetchCalls++; return healthz(OURS); }) as typeof fetch,
    });
    expect(live).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test("first candidate fetch crosses the deadline → fetch count 1, no later candidate", async () => {
    let clock = 1000;
    const urls: string[] = [];
    const live = await findLiveProxy({
      deadlineAt: 2000,
      nowFn: () => clock,
      // Two sequential candidates wired: pid path → port 58195; config fallback → 10100.
      readPidFn: () => 4242,
      readRuntimeFn: pid => (pid === 4242 ? { port: 58195 } : null),
      configFn: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        // The first (and only) probe receives a real AbortSignal that is
        // positive and not yet aborted (safe injected signal state).
        const sig = init?.signal as AbortSignal | undefined;
        expect(sig).toBeTruthy();
        expect(sig?.aborted).toBe(false);
        // Advance the clock PAST the deadline inside the first fetch so the
        // next candidate's budget check terminates discovery.
        clock = 3000; // > deadlineAt (2000)
        // Foreign body → identity null → would normally fall through to config.
        return healthz({ status: "ok" });
      }) as typeof fetch,
    });
    expect(live).toBeNull();
    // Only the runtime-record probe ran; the config-fallback fetch never started.
    expect(urls).toEqual(["http://127.0.0.1:58195/healthz"]);
    expect(urls).toHaveLength(1);
  });

  test("per-probe timeoutMs is capped to the positive remaining (min of cap and remaining)", async () => {
    // Spy on AbortSignal.timeout to read the exact ms passed to proxyIdentityAt.
    // Scoped and restored in finally; no real timer is consumed.
    const calls: number[] = [];
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => {
      const signal = originalTimeout(ms);
      calls.push(ms); // record only after the signal was actually constructed
      return signal;
    }) as typeof AbortSignal.timeout;
    try {
      let clock = 1000;
      await findLiveProxy({
        deadlineAt: 1300, // remaining = 300 at the first probe (< 750 cap)
        nowFn: () => clock,
        readPidFn: () => 4242,
        readRuntimeFn: () => ({ port: 58195 }),
        configFn: () => ({ port: 10100 }),
        fetchFn: (async () => {
          clock = 2000; // cross deadline so no second probe
          return healthz({ status: "ok" });
        }) as typeof fetch,
      });
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
    // timeoutMs = min(750 default cap, 300 remaining) = 300, exactly once.
    expect(calls).toEqual([300]);
  });

  test("per-probe timeoutMs never exceeds the cap even when remaining is large", async () => {
    const calls: number[] = [];
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => {
      const signal = originalTimeout(ms);
      calls.push(ms); // record only after the signal was actually constructed
      return signal;
    }) as typeof AbortSignal.timeout;
    try {
      let clock = 1000;
      await findLiveProxy({
        deadlineAt: 100000, // remaining ≈ 99000 ≫ 750 cap
        timeoutMs: 750, // explicit per-probe cap, mirroring the production wiring
        nowFn: () => clock,
        readPidFn: () => 4242,
        readRuntimeFn: () => ({ port: 58195 }),
        configFn: () => ({ port: 10100 }),
        fetchFn: (async () => {
          clock = 100001; // cross deadline so no second probe
          return healthz({ status: "ok" });
        }) as typeof fetch,
      });
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
    // timeoutMs capped at 750 even though remaining is ~99000.
    expect(calls).toEqual([750]);
  });

  test("no deadlineAt retains the existing multi-candidate fallback behavior (two fetches)", async () => {
    // Without deadlineAt the pid path failing falls through to config, which
    // succeeds — proving the deadline gate is inert when deadlineAt is unset.
    const urls: string[] = [];
    const live = await findLiveProxy({
      readPidFn: () => 4242,
      verifyPidFn: candidate => candidate,
      readRuntimeFn: pid => (pid === 4242 ? { port: 58195 } : null),
      configFn: () => ({ port: 10100 }),
      fetchFn: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return String(url).includes("58195")
          ? healthz({ ...OURS, pid: 9999 }) // mismatched pid → identity null on runtime probe
          : healthz(OURS); // config fallback adopts the reported pid
      }) as typeof fetch,
    });
    expect(urls).toEqual(["http://127.0.0.1:58195/healthz", "http://127.0.0.1:10100/healthz"]);
    expect(urls).toHaveLength(2);
    expect(live).toEqual({ pid: 4242, port: 10100, hostname: undefined, source: "config" });
  });
});

// ── per-server readiness gate (closure, no module-global state) ────────────────

describe("createReadinessGate", () => {
  test("a fresh gate starts pending", () => {
    const gate = createReadinessGate();
    expect(gate.getStatus()).toBe("pending");
  });

  test("markReady transitions pending → ready", () => {
    const gate = createReadinessGate();
    gate.markReady();
    expect(gate.getStatus()).toBe("ready");
  });

  test("markFailed transitions pending → failed", () => {
    const gate = createReadinessGate();
    gate.markFailed();
    expect(gate.getStatus()).toBe("failed");
  });

  test("two gates are fully independent (no shared module-global state)", () => {
    const a = createReadinessGate();
    const b = createReadinessGate();
    a.markReady();
    b.markFailed();
    expect(a.getStatus()).toBe("ready");
    expect(b.getStatus()).toBe("failed");
  });

  test("status transitions at most once (ready then failed stays ready)", () => {
    const gate = createReadinessGate();
    gate.markReady();
    gate.markFailed();
    expect(gate.getStatus()).toBe("ready");
  });

  test("status transitions at most once (failed then ready stays failed)", () => {
    const gate = createReadinessGate();
    gate.markFailed();
    gate.markReady();
    expect(gate.getStatus()).toBe("failed");
  });

  test("the gate exposes only the fixed status enum (no reason/changedAt payload)", () => {
    const gate = createReadinessGate();
    gate.markFailed();
    // Only the sanitized status enum is reachable; the interface surface is fixed.
    expect(gate.getStatus()).toBe("failed");
    // JSON.stringify of a method-only object returns "{}", so it cannot prove
    // the absence of closure-held diagnostic fields. Assert the own-property
    // surface directly: exactly the three control methods and no data field.
    expect(Object.keys(gate).sort()).toEqual(["getStatus", "markFailed", "markReady", "recoverReady"]);
    // The only readable value is the fixed sanitized enum.
    expect(["pending", "ready", "failed"]).toContain(gate.getStatus());
  });

  test("an explicit successful-sync recovery can promote a failed gate", () => {
    const gate = createReadinessGate();
    gate.markFailed();
    gate.recoverReady();
    expect(gate.getStatus()).toBe("ready");
  });

  test("recovery cannot bypass an in-flight pending startup", () => {
    const gate = createReadinessGate();
    gate.recoverReady();
    expect(gate.getStatus()).toBe("pending");

    // Startup remains authoritative and can still settle the pending gate.
    gate.markFailed();
    expect(gate.getStatus()).toBe("failed");
  });

  test("recovery is idempotent once the gate is already ready", () => {
    const gate = createReadinessGate();
    gate.markReady();
    gate.recoverReady();
    expect(gate.getStatus()).toBe("ready");
  });
});

// ── runStartupReadinessSync drives the gate from the sync outcome ──────────────

describe("runStartupReadinessSync", () => {
  test("ok=true with no warning → ready", async () => {
    const gate = createReadinessGate();
    await runStartupReadinessSync(gate, async () => ({ ok: true }));
    expect(gate.getStatus()).toBe("ready");
  });

  test("ok=true with non-warning extras (external-provider short circuit) → ready", async () => {
    const gate = createReadinessGate();
    await runStartupReadinessSync(gate, async () => ({ ok: true, added: 0, message: "injected" }));
    expect(gate.getStatus()).toBe("ready");
  });

  test("ok=true with empty-string warning → ready", async () => {
    const gate = createReadinessGate();
    await runStartupReadinessSync(gate, async () => ({ ok: true, warning: "" }));
    expect(gate.getStatus()).toBe("ready");
  });

  test("ok=false → failed", async () => {
    const gate = createReadinessGate();
    await runStartupReadinessSync(gate, async () => ({ ok: false, message: "x" }));
    expect(gate.getStatus()).toBe("failed");
  });

  test("ok=true with nonempty warning → failed", async () => {
    const gate = createReadinessGate();
    await runStartupReadinessSync(gate, async () => ({ ok: true, warning: "catalog sync skipped: no source" }));
    expect(gate.getStatus()).toBe("failed");
  });

  test("null result → failed", async () => {
    const gate = createReadinessGate();
    await runStartupReadinessSync(gate, async () => null);
    expect(gate.getStatus()).toBe("failed");
  });

  test("syncFn that throws → failed (never rejects)", async () => {
    const gate = createReadinessGate();
    await runStartupReadinessSync(gate, async () => { throw new Error("boom"); });
    expect(gate.getStatus()).toBe("failed");
  });

  test("transition is one-shot: a later failing sync does not flip a ready gate", async () => {
    const gate = createReadinessGate();
    await runStartupReadinessSync(gate, async () => ({ ok: true }));
    await runStartupReadinessSync(gate, async () => { throw new Error("late"); });
    expect(gate.getStatus()).toBe("ready");
  });

  test("syncFn is awaited exactly once", async () => {
    const gate = createReadinessGate();
    let calls = 0;
    await runStartupReadinessSync(gate, async () => { calls++; return { ok: true }; });
    expect(calls).toBe(1);
    expect(gate.getStatus()).toBe("ready");
  });
});

// ── validateReadyzBody: strict contract (pure) ─────────────────────────────────

const VALID_BODY = { service: "codexcommander", version: "0.1.0", uptime: 12, pid: 4242, port: 10100, status: "ready" as const };

describe("validateReadyzBody strict contract", () => {
  test("accepts a well-formed ready body and echoes the sanitized fields", () => {
    expect(validateReadyzBody(VALID_BODY, 10100)).toEqual({ ready: true, status: "ready", pid: 4242, port: 10100 });
  });

  test("accepts the canonical codexcommander service marker", () => {
    expect(validateReadyzBody({ ...VALID_BODY, service: "codexcommander" }, 10100))
      .toEqual({ ready: true, status: "ready", pid: 4242, port: 10100 });
  });

  test("accepts pending/failed bodies as not-ready with the same fixed status", () => {
    expect(validateReadyzBody({ ...VALID_BODY, status: "pending" }, 10100)).toEqual({ ready: false, status: "pending", pid: 4242, port: 10100 });
    expect(validateReadyzBody({ ...VALID_BODY, status: "failed" }, 10100)).toEqual({ ready: false, status: "failed", pid: 4242, port: 10100 });
  });

  test("rejects a foreign service marker", () => {
    expect(validateReadyzBody({ ...VALID_BODY, service: "other-app" }, 10100)).toBeNull();
  });

  test("rejects a health-only body without a service marker", () => {
    expect(validateReadyzBody({ status: "ok", version: "2.6.16", uptime: 5, pid: 4242, port: 10100 }, 10100)).toBeNull();
  });

  test("rejects missing version", () => {
    expect(validateReadyzBody({ service: "codexcommander", uptime: 1, pid: 4242, port: 10100, status: "ready" }, 10100)).toBeNull();
  });

  test("rejects empty-string version", () => {
    expect(validateReadyzBody({ ...VALID_BODY, version: "" }, 10100)).toBeNull();
  });

  test("rejects non-string version", () => {
    expect(validateReadyzBody({ ...VALID_BODY, version: 1 }, 10100)).toBeNull();
  });

  test("rejects missing pid", () => {
    expect(validateReadyzBody({ service: "codexcommander", version: "v", uptime: 1, port: 10100, status: "ready" }, 10100)).toBeNull();
  });

  test("rejects non-integer / non-positive pid", () => {
    expect(validateReadyzBody({ ...VALID_BODY, pid: 0 }, 10100)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, pid: -1 }, 10100)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, pid: 1.5 }, 10100)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, pid: "4242" }, 10100)).toBeNull();
  });

  test("rejects missing port", () => {
    expect(validateReadyzBody({ service: "codexcommander", version: "v", uptime: 1, pid: 4242, status: "ready" }, 10100)).toBeNull();
  });

  test("rejects out-of-range / non-integer port", () => {
    expect(validateReadyzBody({ ...VALID_BODY, port: 0 }, 0)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, port: 65536 }, 65536)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, port: 1.5 }, 1)).toBeNull();
  });

  test("rejects a port that does not equal the probed port", () => {
    expect(validateReadyzBody(VALID_BODY, 9999)).toBeNull();
  });

  test("rejects missing/malformed uptime (negative, NaN, Infinity, non-number)", () => {
    expect(validateReadyzBody({ ...VALID_BODY, uptime: -1 }, 10100)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, uptime: Number.NaN }, 10100)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, uptime: Number.POSITIVE_INFINITY }, 10100)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, uptime: "12" }, 10100)).toBeNull();
  });

  test("rejects missing/malformed status (not a fixed enum value)", () => {
    expect(validateReadyzBody({ service: "codexcommander", version: "v", uptime: 1, pid: 4242, port: 10100 }, 10100)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, status: "ok" }, 10100)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, status: "READY" }, 10100)).toBeNull();
    expect(validateReadyzBody({ ...VALID_BODY, status: 1 }, 10100)).toBeNull();
  });

  test("rejects an expectedPid mismatch", () => {
    expect(validateReadyzBody(VALID_BODY, 10100, { expectedPid: 1 })).toBeNull();
  });

  test("accepts the expectedPid when it matches", () => {
    expect(validateReadyzBody(VALID_BODY, 10100, { expectedPid: 4242 })?.ready).toBe(true);
  });

  test("uptime zero is allowed (just-started proxy)", () => {
    expect(validateReadyzBody({ ...VALID_BODY, uptime: 0 }, 10100)?.ready).toBe(true);
  });

  test("non-object / null bodies are rejected", () => {
    expect(validateReadyzBody(null, 10100)).toBeNull();
    expect(validateReadyzBody("codexcommander", 10100)).toBeNull();
    expect(validateReadyzBody(undefined, 10100)).toBeNull();
  });
});

// ── probeReadiness: strict HTTP + contract enforcement ─────────────────────────

function readyz(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const READY_BODY = { service: "codexcommander", version: "0.1.0", uptime: 12, pid: 4242, port: 10100, status: "ready" };
const PENDING_BODY = { service: "codexcommander", version: "0.1.0", uptime: 1, pid: 4242, port: 10100, status: "pending" };
const FAILED_BODY = { service: "codexcommander", version: "0.1.0", uptime: 1, pid: 4242, port: 10100, status: "failed" };

describe("probeReadiness happy path", () => {
  test("accepts a correct 200 + ready body", async () => {
    const probe = await probeReadiness(10100, { expectedPid: 4242 }, { fetchFn: (async () => readyz(READY_BODY, 200)) as typeof fetch });
    expect(probe).toEqual({ ready: true, status: "ready", pid: 4242, port: 10100 });
  });

  test("returns ready=false with status for a pending 503 body", async () => {
    const probe = await probeReadiness(10100, {}, { fetchFn: (async () => readyz(PENDING_BODY, 503)) as typeof fetch });
    expect(probe).toEqual({ ready: false, status: "pending", pid: 4242, port: 10100 });
  });

  test("returns ready=false with status for a failed 503 body", async () => {
    const probe = await probeReadiness(10100, {}, { fetchFn: (async () => readyz(FAILED_BODY, 503)) as typeof fetch });
    expect(probe).toEqual({ ready: false, status: "failed", pid: 4242, port: 10100 });
  });
});

describe("probeReadiness adversarial contract (never counts ready)", () => {
  test("rejects 503 + ready (HTTP/body-status inconsistency)", async () => {
    const probe = await probeReadiness(10100, {}, { fetchFn: (async () => readyz(READY_BODY, 503)) as typeof fetch });
    expect(probe).toBeNull();
  });

  test("rejects 200 + pending (HTTP/body-status inconsistency)", async () => {
    const probe = await probeReadiness(10100, {}, { fetchFn: (async () => readyz(PENDING_BODY, 200)) as typeof fetch });
    expect(probe).toBeNull();
  });

  test("rejects 200 + failed (HTTP/body-status inconsistency)", async () => {
    const probe = await probeReadiness(10100, {}, { fetchFn: (async () => readyz(FAILED_BODY, 200)) as typeof fetch });
    expect(probe).toBeNull();
  });

  test("rejects a foreign 200 body (service mismatch)", async () => {
    const probe = await probeReadiness(10100, {}, {
      fetchFn: (async () => readyz({ service: "other-app", status: "ready", version: "v", uptime: 1, pid: 4242, port: 10100 }, 200)) as typeof fetch,
    });
    expect(probe).toBeNull();
  });

  test("rejects a health-only body without a service marker", async () => {
    const probe = await probeReadiness(10100, {}, {
      fetchFn: (async () => readyz({ status: "ok", version: "2.6.16", uptime: 5, pid: 4242, port: 10100 }, 200)) as typeof fetch,
    });
    expect(probe).toBeNull();
  });

  test("rejects a body missing version", async () => {
    const probe = await probeReadiness(10100, {}, {
      fetchFn: (async () => readyz({ service: "codexcommander", uptime: 1, pid: 4242, port: 10100, status: "ready" }, 200)) as typeof fetch,
    });
    expect(probe).toBeNull();
  });

  test("rejects a body missing pid", async () => {
    const probe = await probeReadiness(10100, {}, {
      fetchFn: (async () => readyz({ service: "codexcommander", version: "v", uptime: 1, port: 10100, status: "ready" }, 200)) as typeof fetch,
    });
    expect(probe).toBeNull();
  });

  test("rejects a body missing port", async () => {
    const probe = await probeReadiness(10100, {}, {
      fetchFn: (async () => readyz({ service: "codexcommander", version: "v", uptime: 1, pid: 4242, status: "ready" }, 200)) as typeof fetch,
    });
    expect(probe).toBeNull();
  });

  test("rejects a body whose port does not equal the probed port", async () => {
    const probe = await probeReadiness(10100, {}, {
      fetchFn: (async () => readyz({ ...READY_BODY, port: 9999 }, 200)) as typeof fetch,
    });
    expect(probe).toBeNull();
  });

  test("rejects a body whose pid does not match expectedPid", async () => {
    const probe = await probeReadiness(10100, { expectedPid: 1 }, { fetchFn: (async () => readyz(READY_BODY, 200)) as typeof fetch });
    expect(probe).toBeNull();
  });

  test("rejects malformed uptime (negative)", async () => {
    const probe = await probeReadiness(10100, {}, {
      fetchFn: (async () => readyz({ ...READY_BODY, uptime: -1 }, 200)) as typeof fetch,
    });
    expect(probe).toBeNull();
  });

  test("rejects malformed status (not a fixed enum value)", async () => {
    const probe = await probeReadiness(10100, {}, {
      fetchFn: (async () => readyz({ ...READY_BODY, status: "ok" }, 200)) as typeof fetch,
    });
    expect(probe).toBeNull();
  });

  test("returns null when unreachable", async () => {
    const probe = await probeReadiness(10100, {}, { fetchFn: (async () => { throw new Error("refused"); }) as typeof fetch });
    expect(probe).toBeNull();
  });

  test("returns null for non-JSON body", async () => {
    const probe = await probeReadiness(10100, {}, {
      fetchFn: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
    });
    expect(probe).toBeNull();
  });

  test("returns null for a 500 body (neither 200 nor 503)", async () => {
    const probe = await probeReadiness(10100, {}, {
      fetchFn: (async () => readyz(READY_BODY, 500)) as typeof fetch,
    });
    expect(probe).toBeNull();
  });
});

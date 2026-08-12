import { describe, expect, test } from "bun:test";
import {
  ProxyLifecycleAuthorityError,
  acquireProxyLifecycleAuthority,
} from "../src/server/proxy-lifecycle-authority";
import {
  PROXY_ENSURE_LEASE_HEADER,
  PROXY_LIFECYCLE_LEASE_CAPABILITY_HEADER,
  PROXY_LIFECYCLE_LEASE_CAPABILITY_VALUE,
  PROXY_START_LEASE_HEADER,
  advertiseProxyLifecycleLockLease,
  proxyLifecycleLockLeaseHeaders,
  proxySupportsLifecycleLockLease,
  readProxyLifecycleLockLeaseHeaders,
} from "../src/server/proxy-lifecycle-protocol";
import {
  ProxyStartLockError,
  type ProxyStartLock,
} from "../src/server/proxy-start-lock";

function fakeLock(token: string, release: () => void = () => {}): ProxyStartLock {
  return { token, release };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("proxy lifecycle authority", () => {
  test("acquires E before S using the remaining budget from one absolute deadline", async () => {
    let currentTime = 1_000;
    const calls: Array<{ lock: "E" | "S"; waitTimeoutMs: number | undefined }> = [];
    const ensure = fakeLock("ensure-token");
    const start = fakeLock("start-token");

    const authority = await acquireProxyLifecycleAuthority({
      includeStart: true,
      deadlineAt: 1_100,
      now: () => currentTime,
      acquireEnsureLock: async options => {
        calls.push({ lock: "E", waitTimeoutMs: options?.waitTimeoutMs });
        currentTime = 1_035;
        return ensure;
      },
      acquireStartLock: async options => {
        calls.push({ lock: "S", waitTimeoutMs: options?.waitTimeoutMs });
        return start;
      },
    });

    expect(calls).toEqual([
      { lock: "E", waitTimeoutMs: 100 },
      { lock: "S", waitTimeoutMs: 65 },
    ]);
    expect(authority.deadlineAt).toBe(1_100);
    expect(authority.ensure.token).toBe("ensure-token");
    expect(authority.start?.token).toBe("start-token");
    authority.releaseAll();
  });

  test("rolls back E and preserves the low-level cause when initial S acquisition fails", async () => {
    let ensureReleases = 0;
    const lowLevelCause = new ProxyStartLockError("S is occupied");
    let caught: unknown;

    try {
      await acquireProxyLifecycleAuthority({
        includeStart: true,
        acquireEnsureLock: async () => fakeLock("ensure-token", () => {
          ensureReleases += 1;
        }),
        acquireStartLock: async () => {
          throw lowLevelCause;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProxyLifecycleAuthorityError);
    expect((caught as ProxyLifecycleAuthorityError).name).toBe("ProxyLifecycleAuthorityError");
    expect((caught as ProxyLifecycleAuthorityError).code)
      .toBe("PROXY_LIFECYCLE_AUTHORITY_UNAVAILABLE");
    expect((caught as Error).cause).toBe(lowLevelCause);
    expect(ensureReleases).toBe(1);
  });

  test("normalizes a synchronously thrown S acquisition and rolls back E", async () => {
    const releases: string[] = [];
    const lowLevelCause = new ProxyStartLockError("synchronous S refusal");
    let caught: unknown;

    try {
      await acquireProxyLifecycleAuthority({
        includeStart: true,
        acquireEnsureLock: async () => fakeLock("E", () => releases.push("E")),
        acquireStartLock: () => { throw lowLevelCause; },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProxyLifecycleAuthorityError);
    expect((caught as Error).cause).toBe(lowLevelCause);
    expect(releases).toEqual(["E"]);
  });

  test("does not invoke S after E consumes the shared absolute deadline", async () => {
    let currentTime = 1_000;
    let startAcquisitions = 0;
    const releases: string[] = [];

    await expect(acquireProxyLifecycleAuthority({
      includeStart: true,
      deadlineAt: 1_100,
      now: () => currentTime,
      acquireEnsureLock: async () => {
        currentTime = 1_101;
        return fakeLock("E", () => releases.push("E"));
      },
      acquireStartLock: async () => {
        startAcquisitions += 1;
        return fakeLock("S", () => releases.push("S"));
      },
    })).rejects.toBeInstanceOf(ProxyLifecycleAuthorityError);

    expect(startAcquisitions).toBe(0);
    expect(releases).toEqual(["E"]);
  });

  test("rejects and releases S before E when S arrives after the deadline", async () => {
    let currentTime = 1_000;
    const releases: string[] = [];

    await expect(acquireProxyLifecycleAuthority({
      includeStart: true,
      deadlineAt: 1_100,
      now: () => currentTime,
      acquireEnsureLock: async () => fakeLock("E", () => releases.push("E")),
      acquireStartLock: async () => {
        currentTime = 1_101;
        return fakeLock("S", () => releases.push("S"));
      },
    })).rejects.toBeInstanceOf(ProxyLifecycleAuthorityError);

    expect(releases).toEqual(["S", "E"]);
  });

  test("releaseAll is idempotent and releases S before E", async () => {
    const releases: string[] = [];
    const authority = await acquireProxyLifecycleAuthority({
      includeStart: true,
      acquireEnsureLock: async () => fakeLock("E", () => releases.push("E")),
      acquireStartLock: async () => fakeLock("S", () => releases.push("S")),
    });

    authority.releaseAll();
    authority.releaseAll();
    authority.releaseStart();
    authority.ensure.release();
    authority.start?.release();

    expect(releases).toEqual(["S", "E"]);
    expect(authority.start).toBeUndefined();
    expect(authority.delegatedLease()).toBeUndefined();
  });

  test("releaseStart is idempotent while retaining E", async () => {
    const releases: string[] = [];
    const authority = await acquireProxyLifecycleAuthority({
      includeStart: true,
      acquireEnsureLock: async () => fakeLock("E", () => releases.push("E")),
      acquireStartLock: async () => fakeLock("S", () => releases.push("S")),
    });

    authority.releaseStart();
    authority.releaseStart();

    expect(releases).toEqual(["S"]);
    expect(authority.start).toBeUndefined();
    expect(authority.ensure.token).toBe("E");
    authority.releaseAll();
    expect(releases).toEqual(["S", "E"]);
  });

  test("reacquiring S creates a new handle that an old exposed handle cannot release", async () => {
    const releases: string[] = [];
    let startNumber = 0;
    const authority = await acquireProxyLifecycleAuthority({
      acquireEnsureLock: async () => fakeLock("E", () => releases.push("E")),
      acquireStartLock: async () => {
        startNumber += 1;
        const token = `S-${startNumber}`;
        return fakeLock(token, () => releases.push(token));
      },
    });

    const first = await authority.acquireStart();
    expect(await authority.acquireStart()).toBe(first);
    first.release();
    const second = await authority.acquireStart();

    expect(second.token).toBe("S-2");
    expect(authority.ensure.token).toBe("E");
    first.release();
    expect(authority.start).toBe(second);
    expect(releases).toEqual(["S-1"]);

    second.release();
    expect(releases).toEqual(["S-1", "S-2"]);
    authority.releaseAll();
    expect(releases).toEqual(["S-1", "S-2", "E"]);
  });

  test("delegated proof exists only while both locks are held and is fresh after reacquisition", async () => {
    let startNumber = 0;
    const authority = await acquireProxyLifecycleAuthority({
      acquireEnsureLock: async () => fakeLock("E"),
      acquireStartLock: async () => fakeLock(`S-${++startNumber}`),
    });

    expect(authority.delegatedLease()).toBeUndefined();
    await authority.acquireStart();
    const firstProof = authority.delegatedLease();
    const anotherFirstProof = authority.delegatedLease();
    expect(firstProof).toEqual({ ensureToken: "E", startToken: "S-1" });
    expect(anotherFirstProof).toEqual(firstProof);
    expect(anotherFirstProof).not.toBe(firstProof);

    authority.releaseStart();
    expect(authority.delegatedLease()).toBeUndefined();
    await authority.acquireStart();
    const secondProof = authority.delegatedLease();
    expect(secondProof).toEqual({ ensureToken: "E", startToken: "S-2" });
    expect(secondProof).not.toBe(firstProof);

    authority.releaseAll();
    expect(authority.delegatedLease()).toBeUndefined();
  });

  test("direct exposed start and ensure releases keep authority state coherent", async () => {
    const releases: string[] = [];
    let startNumber = 0;
    const authority = await acquireProxyLifecycleAuthority({
      includeStart: true,
      acquireEnsureLock: async () => fakeLock("E", () => releases.push("E")),
      acquireStartLock: async () => {
        const token = `S-${++startNumber}`;
        return fakeLock(token, () => releases.push(token));
      },
    });

    authority.start?.release();
    expect(authority.start).toBeUndefined();
    expect(authority.delegatedLease()).toBeUndefined();
    expect((await authority.acquireStart()).token).toBe("S-2");

    authority.ensure.release();
    expect(releases).toEqual(["S-1", "S-2", "E"]);
    expect(authority.start).toBeUndefined();
    expect(authority.delegatedLease()).toBeUndefined();
    await expect(authority.acquireStart()).rejects.toBeInstanceOf(ProxyLifecycleAuthorityError);
  });

  test("a release during shared pending S acquisition revokes and releases the arriving lock", async () => {
    const pending = deferred<ProxyStartLock>();
    const releases: string[] = [];
    let acquisitions = 0;
    const authority = await acquireProxyLifecycleAuthority({
      acquireEnsureLock: async () => fakeLock("E", () => releases.push("E")),
      acquireStartLock: () => {
        acquisitions += 1;
        return pending.promise;
      },
    });

    const firstAttempt = authority.acquireStart();
    const secondAttempt = authority.acquireStart();
    const attemptsSettled = Promise.allSettled([firstAttempt, secondAttempt]);
    await Promise.resolve();
    expect(acquisitions).toBe(1);
    authority.releaseAll();
    pending.resolve(fakeLock("S", () => releases.push("S")));

    const results = await attemptsSettled;
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(ProxyLifecycleAuthorityError);
      }
    }
    expect(releases).toEqual(["S", "E"]);
    expect(authority.start).toBeUndefined();
  });
});

describe("proxy lifecycle lease protocol", () => {
  test("builds and parses the all-or-nothing lease header pair", () => {
    const lease = { ensureToken: "ensure-token", startToken: "start-token" };
    const values = proxyLifecycleLockLeaseHeaders(lease);

    expect(values).toEqual({
      [PROXY_ENSURE_LEASE_HEADER]: "ensure-token",
      [PROXY_START_LEASE_HEADER]: "start-token",
    });
    expect(readProxyLifecycleLockLeaseHeaders(new Headers())).toEqual({ kind: "none" });

    for (const invalid of [
      new Headers({ [PROXY_ENSURE_LEASE_HEADER]: "ensure-token" }),
      new Headers({ [PROXY_START_LEASE_HEADER]: "start-token" }),
      new Headers({
        [PROXY_ENSURE_LEASE_HEADER]: "",
        [PROXY_START_LEASE_HEADER]: "start-token",
      }),
    ]) {
      expect(readProxyLifecycleLockLeaseHeaders(invalid)).toEqual({ kind: "invalid" });
    }

    expect(readProxyLifecycleLockLeaseHeaders(new Headers(values))).toEqual({
      kind: "lease",
      lease,
    });
  });

  test("advertises and recognizes only the exact lifecycle lease capability", () => {
    const headers = new Headers();
    expect(proxySupportsLifecycleLockLease(headers)).toBe(false);

    advertiseProxyLifecycleLockLease(headers);
    expect(headers.get(PROXY_LIFECYCLE_LEASE_CAPABILITY_HEADER))
      .toBe(PROXY_LIFECYCLE_LEASE_CAPABILITY_VALUE);
    expect(proxySupportsLifecycleLockLease(headers)).toBe(true);

    headers.set(PROXY_LIFECYCLE_LEASE_CAPABILITY_HEADER, "true");
    expect(proxySupportsLifecycleLockLease(headers)).toBe(false);
  });
});

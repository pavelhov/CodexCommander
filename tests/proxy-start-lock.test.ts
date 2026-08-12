import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProxyStartLockError,
  acquireProxyStartLock,
  armProxyServiceStartDelegation,
  clearProxyServiceStartDelegation,
  consumeProxyServiceStartDelegation,
  validateProxyLifecycleLockLease,
} from "../src/server/proxy-start-lock";

const roots: string[] = [];

function sandbox(): { root: string; lockPath: string } {
  const root = mkdtempSync(join(tmpdir(), "ccx-start-lock-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return { root, lockPath: join(root, "proxy-start.lock") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("proxy start lock", () => {
  test("service delegation is bound to the exact E owner and consumed once under S", async () => {
    const { root } = sandbox();
    const ensurePath = join(root, "proxy-ensure.lock");
    const startPath = join(root, "proxy-start.lock");
    const ensure = await acquireProxyStartLock({ path: ensurePath, waitTimeoutMs: 0 });
    const parentStart = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    const delegation = armProxyServiceStartDelegation(ensure.token, {
      ensurePath,
      now: () => 100,
      ttlMs: 1_000,
    });
    parentStart.release();

    const childStart = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    expect(consumeProxyServiceStartDelegation({
      ensurePath,
      now: () => 101,
      processAlive: () => true,
    })).toEqual(delegation);
    childStart.release();

    const replayStart = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    expect(consumeProxyServiceStartDelegation({
      ensurePath,
      now: () => 102,
      processAlive: () => true,
    })).toBeNull();
    replayStart.release();
    ensure.release();
    expect(existsSync(ensurePath)).toBe(false);
  });

  test("service delegation refuses a wrong E owner and wrong-owner clear cannot revoke it", async () => {
    const { root } = sandbox();
    const ensurePath = join(root, "proxy-ensure.lock");
    const startPath = join(root, "proxy-start.lock");
    const ensure = await acquireProxyStartLock({ path: ensurePath, waitTimeoutMs: 0 });
    const parentStart = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });

    expect(() => armProxyServiceStartDelegation(randomUUID(), { ensurePath }))
      .toThrow(ProxyStartLockError);
    const delegation = armProxyServiceStartDelegation(ensure.token, { ensurePath });
    clearProxyServiceStartDelegation({
      ...delegation,
      ensureToken: randomUUID(),
    }, { ensurePath });
    parentStart.release();
    const childStart = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    expect(consumeProxyServiceStartDelegation({ ensurePath, processAlive: () => true }))
      .toMatchObject({ token: delegation.token, ensureToken: ensure.token });
    childStart.release();
    ensure.release();
  });

  test("stale and crashed service delegation proofs cannot authorize S-only startup", async () => {
    const { root } = sandbox();
    const ensurePath = join(root, "proxy-ensure.lock");
    const startPath = join(root, "proxy-start.lock");
    const ensure = await acquireProxyStartLock({ path: ensurePath, waitTimeoutMs: 0 });
    const parentStart = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    armProxyServiceStartDelegation(ensure.token, {
      ensurePath,
      now: () => 100,
      ttlMs: 10,
    });
    parentStart.release();
    const staleStart = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    expect(consumeProxyServiceStartDelegation({
      ensurePath,
      now: () => 110,
      processAlive: () => true,
    })).toBeNull();
    staleStart.release();

    const secondParentStart = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    armProxyServiceStartDelegation(ensure.token, {
      ensurePath,
      now: () => 200,
      ttlMs: 10,
    });
    secondParentStart.release();
    const crashedStart = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    expect(consumeProxyServiceStartDelegation({
      ensurePath,
      now: () => 201,
      processAlive: () => false,
    })).toBeNull();
    crashedStart.release();
    ensure.release();
  });

  test("concurrent service consumers cannot both claim one delegation", async () => {
    const { root } = sandbox();
    const ensurePath = join(root, "proxy-ensure.lock");
    const startPath = join(root, "proxy-start.lock");
    const ensure = await acquireProxyStartLock({ path: ensurePath, waitTimeoutMs: 0 });
    const parentStart = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    const delegation = armProxyServiceStartDelegation(ensure.token, { ensurePath });
    parentStart.release();

    const consume = async () => {
      const start = await acquireProxyStartLock({
        path: startPath,
        waitTimeoutMs: 1_000,
        pollMinMs: 1,
        pollMaxMs: 2,
      });
      try {
        return consumeProxyServiceStartDelegation({ ensurePath, processAlive: () => true });
      } finally {
        start.release();
      }
    };
    const results = await Promise.all([consume(), consume()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)?.token).toBe(delegation.token);
    ensure.release();
  });

  test("releasing E clears an unconsumed service launch marker", async () => {
    const { root } = sandbox();
    const ensurePath = join(root, "proxy-ensure.lock");
    const ensure = await acquireProxyStartLock({ path: ensurePath, waitTimeoutMs: 0 });
    armProxyServiceStartDelegation(ensure.token, { ensurePath });
    ensure.release();
    expect(existsSync(ensurePath)).toBe(false);
    expect(consumeProxyServiceStartDelegation({ ensurePath })).toBeNull();
  });

  test("delegated lifecycle validation requires both exact tokens from one live owner", async () => {
    const { root } = sandbox();
    const ensurePath = join(root, "proxy-ensure.lock");
    const startPath = join(root, "proxy-start.lock");
    const ensure = await acquireProxyStartLock({ path: ensurePath, waitTimeoutMs: 0 });
    const start = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    const options = { ensurePath, startPath, processAlive: () => true };

    expect(validateProxyLifecycleLockLease({
      ensureToken: ensure.token,
      startToken: start.token,
    }, options)).toBe(true);
    expect(validateProxyLifecycleLockLease({
      ensureToken: start.token,
      startToken: ensure.token,
    }, options)).toBe(false);
    expect(validateProxyLifecycleLockLease({
      ensureToken: ensure.token,
      startToken: start.token,
    }, { ...options, processAlive: () => false })).toBe(false);

    start.release();
    ensure.release();
  });

  test("delegated lifecycle validation rejects a lock pair changed before its stable re-read", async () => {
    const { root } = sandbox();
    const ensurePath = join(root, "proxy-ensure.lock");
    const startPath = join(root, "proxy-start.lock");
    const ensure = await acquireProxyStartLock({ path: ensurePath, waitTimeoutMs: 0 });
    const start = await acquireProxyStartLock({ path: startPath, waitTimeoutMs: 0 });
    const replacement = `${JSON.stringify({
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
    })}\n`;

    expect(validateProxyLifecycleLockLease({
      ensureToken: ensure.token,
      startToken: start.token,
    }, {
      ensurePath,
      startPath,
      processAlive: () => {
        writeFileSync(startPath, replacement, { mode: 0o600 });
        return true;
      },
    })).toBe(false);

    start.release();
    ensure.release();
  });

  test("is exclusive and becomes immediately reusable after an owned release", async () => {
    const { lockPath } = sandbox();
    const first = await acquireProxyStartLock({ path: lockPath, waitTimeoutMs: 0 });
    await expect(acquireProxyStartLock({
      path: lockPath,
      waitTimeoutMs: 0,
    })).rejects.toBeInstanceOf(ProxyStartLockError);

    first.release();
    const second = await acquireProxyStartLock({ path: lockPath, waitTimeoutMs: 0 });
    expect(second.token).not.toBe(first.token);
    second.release();
  });

  test("reclaims a dead owner without waiting for the age threshold", async () => {
    const { lockPath } = sandbox();
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      token: randomUUID(),
      pid: 987_654_321,
      createdAt: Date.now(),
    })}\n`, { mode: 0o600 });

    const acquired = await acquireProxyStartLock({
      path: lockPath,
      waitTimeoutMs: 0,
      processAlive: () => false,
    });
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe(acquired.token);
    acquired.release();
  });

  test("compare-before-delete preserves a successor that replaces the stale lock", async () => {
    const { lockPath } = sandbox();
    writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      token: randomUUID(),
      pid: 987_654_321,
      createdAt: 0,
    })}\n`, { mode: 0o600 });
    const successor = `${JSON.stringify({
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
    })}\n`;

    await expect(acquireProxyStartLock({
      path: lockPath,
      waitTimeoutMs: 0,
      processAlive: pid => pid === process.pid,
      beforeReclaim: () => writeFileSync(lockPath, successor, { mode: 0o600 }),
    })).rejects.toBeInstanceOf(ProxyStartLockError);
    expect(readFileSync(lockPath, "utf8")).toBe(successor);
  });
});

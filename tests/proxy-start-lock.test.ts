import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProxyStartLockError,
  acquireProxyStartLock,
} from "../src/server/proxy-start-lock";

const roots: string[] = [];

function sandbox(): { root: string; lockPath: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-start-lock-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return { root, lockPath: join(root, "proxy-start.lock") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("proxy start lock", () => {
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

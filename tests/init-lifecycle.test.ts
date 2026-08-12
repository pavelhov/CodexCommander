import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { routeCodexThroughLiveProxyFromInit } from "../src/cli/init";
import {
  acquireProxyLifecycleAuthority,
  type AcquireProxyLifecycleAuthorityOptions,
  type ProxyLifecycleAuthority,
} from "../src/server/proxy-lifecycle-authority";
import type { ProxyStartLock, ProxyStartLockOptions } from "../src/server/proxy-start-lock";

function authority(calls: string[] = []): ProxyLifecycleAuthority {
  let startHeld = true;
  const value: ProxyLifecycleAuthority = {
    deadlineAt: Number.POSITIVE_INFINITY,
    ensure: { token: "ensure-token", release: () => value.releaseAll() },
    get start() {
      return startHeld ? { token: "start-token", release: () => value.releaseStart() } : undefined;
    },
    acquireStart: async () => {
      startHeld = true;
      return { token: "start-token", release: () => value.releaseStart() };
    },
    delegatedLease: () => startHeld
      ? { ensureToken: "ensure-token", startToken: "start-token" }
      : undefined,
    releaseStart: () => {
      if (!startHeld) return;
      startHeld = false;
      calls.push("release-S");
    },
    releaseAll: () => {
      value.releaseStart();
      calls.push("release-E");
    },
  };
  return value;
}

function mutex(onWait?: () => void): (options?: ProxyStartLockOptions) => Promise<ProxyStartLock> {
  let held = false;
  let sequence = 0;
  const waiters: Array<() => void> = [];
  return async () => {
    if (held) {
      onWait?.();
      await new Promise<void>(resolve => waiters.push(resolve));
    }
    held = true;
    sequence += 1;
    let released = false;
    return {
      token: `token-${sequence}`,
      release: () => {
        if (released) return;
        released = true;
        held = false;
        waiters.shift()?.();
      },
    };
  };
}

describe("ccx init Codex routing lifecycle", () => {
  test("preserves a concurrent Stop's durable OFF intent while replacing setup fields", () => {
    const home = mkdtempSync(join(tmpdir(), "ccx-init-lifecycle-"));
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "config.json"), JSON.stringify({
        port: 10100,
        managementUsageMaxReadBytes: 64 * 1024 * 1024,
        appOwnedMemoryBudgetMb: 256,
        providers: { old: { adapter: "openai-chat", baseUrl: "https://old.example/v1" } },
        defaultProvider: "old",
        clientIntegrations: { codex: false, grok: false },
        subagentModels: ["gpt-5.4"],
        multiAgentGuidanceEnabled: true,
        websockets: false,
        codexAutoStart: true,
        codexShimAutoRestore: true,
      }));
      const child = Bun.spawnSync({
        cmd: [process.execPath, "-e", `
          const { getDefaultConfig } = await import("./src/config.ts");
          const { persistInitConfig } = await import("./src/cli/init.ts");
          persistInitConfig({
            ...getDefaultConfig(),
            port: 10200,
            providers: { next: { adapter: "openai-chat", baseUrl: "https://next.example/v1" } },
            defaultProvider: "next",
          });
        `],
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, CODEXCOMMANDER_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(new TextDecoder().decode(child.stderr)).toBe("");
      expect(child.exitCode).toBe(0);
      const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      expect(saved).toMatchObject({
        port: 10200,
        defaultProvider: "next",
        clientIntegrations: { codex: false, grok: false },
      });
      expect(Object.keys(saved.providers)).toEqual(["next"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("leaves Codex unchanged when no live proxy exists", async () => {
    const calls: string[] = [];
    const result = await routeCodexThroughLiveProxyFromInit({
      acquireAuthority: async () => authority(calls),
      findLive: async () => {
        calls.push("find-live");
        return null;
      },
      setEnabled: () => {
        calls.push("enable");
        return { ok: true, status: "committed", enabled: true };
      },
      syncModels: async () => {
        calls.push("sync");
        return { status: "applied", ok: true };
      },
    });

    expect(result).toMatchObject({ ok: false, state: "stopped", errorCode: "START_FAILED" });
    expect(result.message).toContain("No running CodexCommander proxy");
    expect(calls).toEqual(["find-live", "release-S", "release-E"]);
  });

  test("routes through a proven current-home proxy under the delegated lifecycle lease", async () => {
    const calls: string[] = [];
    const result = await routeCodexThroughLiveProxyFromInit({
      acquireAuthority: async options => {
        expect(options).toMatchObject({ includeStart: true });
        calls.push("acquire-E-S");
        return authority(calls);
      },
      findLive: async () => ({ pid: 42, port: 10123, source: "runtime" }),
      journalPending: () => false,
      externalProvider: () => null,
      setEnabled: (client, enabled) => {
        calls.push(`enabled:${client}:${enabled}`);
        return { ok: true, status: "committed", enabled };
      },
      syncModels: async (port, lease) => {
        calls.push(`sync:${port}:${lease.ensureToken}:${lease.startToken}`);
        return { status: "applied", ok: true, message: "synced" };
      },
    });

    expect(result).toMatchObject({ ok: true, state: "running", pid: 42, port: 10123 });
    expect(calls).toEqual([
      "acquire-E-S",
      "enabled:codex:true",
      "sync:10123:ensure-token:start-token",
      "release-S",
      "release-E",
    ]);
  });

  test("waits behind Stop authority before any routing mutation", async () => {
    let notifyWaiting!: () => void;
    const waiting = new Promise<void>(resolve => { notifyWaiting = resolve; });
    const acquireEnsureLock = mutex(notifyWaiting);
    const acquireStartLock = mutex();
    const acquireAuthority = (options: AcquireProxyLifecycleAuthorityOptions = {}) => (
      acquireProxyLifecycleAuthority({
        ...options,
        waitTimeoutMs: 2_000,
        acquireEnsureLock,
        acquireStartLock,
      })
    );
    const stopAuthority = await acquireAuthority({ includeStart: true });
    const calls: string[] = [];

    const routing = routeCodexThroughLiveProxyFromInit({
      acquireAuthority,
      findLive: async () => {
        calls.push("find-live");
        return { pid: 42, port: 10100, source: "runtime" };
      },
      journalPending: () => false,
      externalProvider: () => null,
      setEnabled: (_client, enabled) => {
        calls.push("enable");
        return { ok: true, status: "committed", enabled };
      },
      syncModels: async () => {
        calls.push("sync");
        return { status: "applied", ok: true };
      },
    });

    await waiting;
    expect(calls).toEqual([]);
    stopAuthority.releaseAll();

    expect(await routing).toMatchObject({ ok: true, state: "running" });
    expect(calls).toEqual(["find-live", "enable", "sync"]);
  });

  test("refuses without mutation when lifecycle authority is unavailable", async () => {
    const calls: string[] = [];
    const result = await routeCodexThroughLiveProxyFromInit({
      acquireAuthority: async () => { throw new Error("Stop owns lifecycle authority"); },
      findLive: async () => {
        calls.push("find-live");
        return { pid: 42, port: 10100, source: "runtime" };
      },
      setEnabled: () => {
        calls.push("enable");
        return { ok: true, status: "committed", enabled: true };
      },
      syncModels: async () => {
        calls.push("sync");
        return { status: "applied", ok: true };
      },
    });

    expect(result).toMatchObject({ ok: false, state: "blocked", errorCode: "START_FAILED" });
    expect(calls).toEqual([]);
  });
});

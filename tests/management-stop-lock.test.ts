import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import {
  PROXY_ENSURE_LEASE_HEADER,
  PROXY_START_LEASE_HEADER,
} from "../src/server/proxy-lifecycle-protocol";
import type { ProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
import type { CodexCommanderConfig } from "../src/types";

const config = {
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
  shutdownTimeoutMs: 50,
} as CodexCommanderConfig;

function stopRequest(headers?: HeadersInit): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Host", "127.0.0.1");
  return new Request("http://127.0.0.1/api/stop", { method: "POST", headers: requestHeaders });
}

describe("management stop lifecycle lease", () => {
  test("raw stop holds E then S through drain and through the exit callback", async () => {
    const calls: string[] = [];
    let callback: (() => void | Promise<void>) | undefined;
    let ensureHeld = false;
    let startHeld = false;
    const authority: ProxyLifecycleAuthority = {
      deadlineAt: 8_000,
      ensure: { token: "ensure", release: () => {} },
      get start() {
        return startHeld ? { token: "start", release: () => this.releaseStart() } : undefined;
      },
      async acquireStart() {
        startHeld = true;
        return { token: "start", release: () => this.releaseStart() };
      },
      delegatedLease: () => ensureHeld && startHeld
        ? { ensureToken: "ensure", startToken: "start" }
        : undefined,
      releaseStart() {
        if (!startHeld) return;
        calls.push("release-S");
        startHeld = false;
      },
      releaseAll() {
        this.releaseStart();
        if (!ensureHeld) return;
        calls.push("release-E");
        ensureHeld = false;
      },
    };
    const req = stopRequest();
    const response = await handleManagementAPI(req, new URL(req.url), config, {
      proxyStopLifecycle: {
        acquireAuthority: async options => {
          expect(options).toMatchObject({ includeStart: true, waitTimeoutMs: 8_000 });
          calls.push("acquire-E");
          ensureHeld = true;
          calls.push("acquire-S");
          startHeld = true;
          return authority;
        },
        prepareShutdown: options => {
          calls.push("prepare");
          expect(options?.allowInstalledServiceStop).toBe(false);
          expect(options?.serviceAlreadyStopped).toBe(false);
          return { accepted: true, status: 200, success: true, message: "stopping" };
        },
        schedule: scheduled => { calls.push("schedule"); callback = scheduled; },
        drain: async () => { calls.push("drain"); },
        exit: () => {
          calls.push(`exit:${ensureHeld}:${startHeld}`);
        },
      },
    });

    expect(response?.status).toBe(200);
    expect(calls).toEqual(["acquire-E", "acquire-S", "prepare", "schedule"]);
    expect(ensureHeld).toBe(true);
    expect(startHeld).toBe(true);
    await callback?.();
    expect(calls).toEqual([
      "acquire-E", "acquire-S", "prepare", "schedule", "drain",
      "exit:true:true", "release-S", "release-E",
    ]);
  });

  test("successful Stop mirrors durable Codex OFF into the live server config", async () => {
    const liveConfig = {
      ...config,
      clientIntegrations: { codex: true, grok: true },
    } as CodexCommanderConfig;
    let callback: (() => void | Promise<void>) | undefined;
    const authority: ProxyLifecycleAuthority = {
      deadlineAt: 8_000,
      ensure: { token: "ensure", release: () => {} },
      start: { token: "start", release: () => {} },
      acquireStart: async () => ({ token: "start", release: () => {} }),
      delegatedLease: () => ({ ensureToken: "ensure", startToken: "start" }),
      releaseStart: () => {},
      releaseAll: () => {},
    };
    const req = stopRequest();
    const response = await handleManagementAPI(req, new URL(req.url), liveConfig, {
      proxyStopLifecycle: {
        acquireAuthority: async () => authority,
        prepareShutdown: () => ({ accepted: true, status: 200, success: true, message: "stopping" }),
        schedule: scheduled => { callback = scheduled; },
        drain: async () => {},
        exit: () => {},
      },
    });

    expect(response?.status).toBe(200);
    expect(liveConfig.clientIntegrations).toEqual({ codex: false, grok: true });
    await callback?.();
  });

  test("authority acquisition failure does not prepare shutdown", async () => {
    const calls: string[] = [];
    const req = stopRequest();
    const response = await handleManagementAPI(req, new URL(req.url), config, {
      proxyStopLifecycle: {
        acquireAuthority: async () => {
          calls.push("acquire-authority");
          throw new Error("busy");
        },
        prepareShutdown: () => { calls.push("prepare"); throw new Error("must not run"); },
      },
    });
    expect(response?.status).toBe(409);
    expect(calls).toEqual(["acquire-authority"]);
  });

  test("authority acquisition receives one 8s E-to-S absolute budget", async () => {
    const req = stopRequest();
    let optionsSeen: unknown;
    const response = await handleManagementAPI(req, new URL(req.url), config, {
      proxyStopLifecycle: {
        acquireAuthority: async options => {
          optionsSeen = options;
          throw new Error("busy");
        },
        prepareShutdown: () => {
          throw new Error("must not prepare without authority");
        },
      },
    });

    expect(response?.status).toBe(409);
    expect(optionsSeen).toEqual({ includeStart: true, waitTimeoutMs: 8_000 });
  });

  test("preparation and scheduling refusals release raw authority S then E", async () => {
    for (const refusal of ["prepare", "schedule"] as const) {
      const calls: string[] = [];
      let startHeld = true;
      let ensureHeld = true;
      const lifecycleAuthority: ProxyLifecycleAuthority = {
        deadlineAt: 8_000,
        ensure: { token: "ensure", release: () => {} },
        get start() {
          return startHeld ? { token: "start", release: () => this.releaseStart() } : undefined;
        },
        async acquireStart() {
          throw new Error("not used");
        },
        delegatedLease: () => ({ ensureToken: "ensure", startToken: "start" }),
        releaseStart() {
          if (!startHeld) return;
          startHeld = false;
          calls.push("release-S");
        },
        releaseAll() {
          this.releaseStart();
          if (!ensureHeld) return;
          ensureHeld = false;
          calls.push("release-E");
        },
      };
      const req = stopRequest();
      const response = await handleManagementAPI(req, new URL(req.url), config, {
        proxyStopLifecycle: {
          acquireAuthority: async () => lifecycleAuthority,
          prepareShutdown: () => {
            calls.push("prepare");
            if (refusal === "prepare") throw new Error("fixture refusal");
            return { accepted: true, status: 200, success: true, message: "stopping" };
          },
          schedule: () => {
            calls.push("schedule");
            throw new Error("fixture refusal");
          },
        },
      });

      expect(response?.status).toBe(409);
      expect(calls).toEqual(refusal === "prepare"
        ? ["prepare", "release-S", "release-E"]
        : ["prepare", "schedule", "release-S", "release-E"]);
    }
  });

  test("valid delegated tokens skip acquisition but still prepare", async () => {
    const calls: string[] = [];
    let callback: (() => void | Promise<void>) | undefined;
    const req = stopRequest({
      [PROXY_ENSURE_LEASE_HEADER]: "ensure-secret",
      [PROXY_START_LEASE_HEADER]: "start-secret",
    });
    const response = await handleManagementAPI(req, new URL(req.url), config, {
      proxyStopLifecycle: {
        validateLease: lease => {
          calls.push("validate");
          return lease.ensureToken === "ensure-secret" && lease.startToken === "start-secret";
        },
        acquireAuthority: async () => { throw new Error("must not acquire"); },
        prepareShutdown: options => {
          calls.push("prepare");
          expect(options?.allowInstalledServiceStop).toBe(true);
          expect(options?.serviceAlreadyStopped).toBe(true);
          return { accepted: true, status: 200, success: true, message: "stopping" };
        },
        schedule: scheduled => { calls.push("schedule"); callback = scheduled; },
        drain: async () => { calls.push("drain"); },
        exit: () => { calls.push("exit"); },
      },
    });
    expect(response?.status).toBe(200);
    expect(calls).toEqual(["validate", "prepare", "schedule"]);
    await callback?.();
    expect(calls).toEqual(["validate", "prepare", "schedule", "drain", "exit"]);
  });

  test("delegated stop never releases the caller-owned lifecycle lease", async () => {
    const calls: string[] = [];
    let callback: (() => void | Promise<void>) | undefined;
    const req = stopRequest({
      [PROXY_ENSURE_LEASE_HEADER]: "ensure-secret",
      [PROXY_START_LEASE_HEADER]: "start-secret",
    });
    const response = await handleManagementAPI(req, new URL(req.url), config, {
      proxyStopLifecycle: {
        validateLease: () => true,
        acquireAuthority: async () => {
          calls.push("acquire");
          throw new Error("delegated stop must not acquire");
        },
        prepareShutdown: () => ({ accepted: true, status: 200, success: true, message: "stopping" }),
        schedule: scheduled => { callback = scheduled; },
        drain: async () => { calls.push("drain"); },
        exit: () => { calls.push("exit"); },
      },
    });

    expect(response?.status).toBe(200);
    await callback?.();
    expect(calls).toEqual(["drain", "exit"]);
  });

  test("partial or invalid delegated tokens fail generically without disclosure", async () => {
    for (const headers of [
      { [PROXY_ENSURE_LEASE_HEADER]: "ensure-secret" },
      {
        [PROXY_ENSURE_LEASE_HEADER]: "ensure-secret",
        [PROXY_START_LEASE_HEADER]: "start-secret",
      },
    ]) {
      const calls: string[] = [];
      const req = stopRequest(headers);
      const response = await handleManagementAPI(req, new URL(req.url), config, {
        proxyStopLifecycle: {
          validateLease: () => { calls.push("validate"); return false; },
          acquireAuthority: async () => { calls.push("acquire"); throw new Error("must not run"); },
          prepareShutdown: () => { calls.push("prepare"); throw new Error("must not run"); },
        },
      });
      const body = await response!.text();
      expect(response?.status).toBe(409);
      expect(body).not.toContain("ensure-secret");
      expect(body).not.toContain("start-secret");
      expect(calls).not.toContain("acquire");
      expect(calls).not.toContain("prepare");
    }
  });
});

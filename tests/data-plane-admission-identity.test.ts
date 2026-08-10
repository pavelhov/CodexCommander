import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  hasValidApiAuth,
  isDataPlaneAdmissionSecret,
  isProxyAdmissionSecret,
  requireResponsesApiAuth,
  resolveApiAuth,
  resolveDataPlaneAdmissionSecret,
  resolveResponsesApiAuth,
} from "../src/server/auth-cors";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { buildResponsesWsData } from "../src/server/ws-bridge";
import type { CodexCommanderConfig } from "../src/types";

// The admission path already knew WHICH key matched and threw it away. These
// tests pin two things at once: the id now survives, and no admission decision
// changed while it started surviving.

const previousDataToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
const previousAdminToken = process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;

function remoteConfig(): CodexCommanderConfig {
  return {
    port: 0,
    multiAgentGuidanceEnabled: true,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true, models: ["gpt-test"] },
    },
    apiKeys: [
      { id: "first-key", name: "first", key: "ccx_data_firstsecret", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "second-key", name: "second", key: "ccx_data_secondsecret", createdAt: "2026-07-31T00:00:00.000Z" },
    ],
  };
}

function loopbackConfig(): CodexCommanderConfig {
  return { ...remoteConfig(), hostname: "127.0.0.1" };
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://proxy.test/v1/responses", { method: "POST", headers });
}

beforeEach(() => {
  delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
});

afterEach(() => {
  if (previousDataToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = previousDataToken;
});

describe("resolveDataPlaneAdmissionSecret", () => {
  test("names the configured key that actually matched", () => {
    const config = remoteConfig();
    expect(resolveDataPlaneAdmissionSecret("ccx_data_firstsecret", config)).toEqual({
      kind: "configured",
      keyId: "first-key",
    });
  });

  test("resolves the SECOND key to its own id, not the first", () => {
    const config = remoteConfig();
    // The whole point of the refactor: the id must be the matched entry's, not
    // whichever entry happens to be first.
    expect(resolveDataPlaneAdmissionSecret("ccx_data_secondsecret", config)).toEqual({
      kind: "configured",
      keyId: "second-key",
    });
  });

  test("the environment token has no configured key to name", () => {
    process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "env-secret";
    expect(resolveDataPlaneAdmissionSecret("env-secret", remoteConfig())).toEqual({ kind: "environment" });
  });

  test.each([
    ["an unknown token", "not-a-key"],
    ["an empty token", ""],
    ["whitespace only", "   "],
  ])("rejects %s", (_label, token) => {
    expect(resolveDataPlaneAdmissionSecret(token, remoteConfig())).toBeNull();
  });

  test("a key that only shares a prefix does not match", () => {
    expect(resolveDataPlaneAdmissionSecret("ccx_data_first", remoteConfig())).toBeNull();
  });
});

describe("no admission decision changed", () => {
  test.each([
    ["configured key", "ccx_data_firstsecret", true],
    ["second configured key", "ccx_data_secondsecret", true],
    ["unknown token", "nope", false],
    ["empty token", "", false],
  ])("isDataPlaneAdmissionSecret agrees with the resolver for %s", (_label, token, expected) => {
    const config = remoteConfig();
    expect(isDataPlaneAdmissionSecret(token, config)).toBe(expected);
    expect(resolveDataPlaneAdmissionSecret(token, config) !== null).toBe(expected);
  });

  test("the never-forward-upstream guard still recognizes a configured key", () => {
    const config = remoteConfig();
    expect(isProxyAdmissionSecret("ccx_data_firstsecret", config)).toBe(true);
    expect(isProxyAdmissionSecret("sk-some-upstream-key", config)).toBe(false);
  });

  test("the never-forward-upstream guard recognizes every canonical ccx_ prefix", () => {
    // A ccx_-prefixed secret that slipped through here would be forwarded to an
    // upstream provider — the leak this guard exists to prevent.
    const config = remoteConfig();
    for (const token of [
      "ccx_data_firstsecret",
      `ccx_data_${"b".repeat(40)}`,
      `ccx_admin_${"c".repeat(43)}`,
      `ccx_session_${"d".repeat(43)}`,
    ]) {
      expect(isProxyAdmissionSecret(token, config)).toBe(true);
    }
    expect(isProxyAdmissionSecret(`ccx_${"e".repeat(40)}`, config)).toBe(false);
    expect(isProxyAdmissionSecret("ccx_provider_upstream", config)).toBe(false);
    expect(isProxyAdmissionSecret("sk-some-upstream-key", config)).toBe(false);
  });
});

describe("the two wrappers still differ", () => {
  test("bearer is accepted by the broad path and rejected by the Responses path", () => {
    const config = remoteConfig();
    const bearer = request({ authorization: "Bearer ccx_data_firstsecret" });

    // /v1/models and /v1/messages take bearer...
    expect(resolveApiAuth(bearer, config)).toEqual({ kind: "configured", keyId: "first-key" });
    expect(hasValidApiAuth(bearer, config)).toBe(true);

    // ...but Responses/Chat must not, because Authorization there may belong to
    // Codex Direct passthrough.
    expect(resolveResponsesApiAuth(request({ authorization: "Bearer ccx_data_firstsecret" }), config)).toBeNull();
    expect(requireResponsesApiAuth(request({ authorization: "Bearer ccx_data_firstsecret" }), config)?.status).toBe(401);
  });

  test("x-api-key is accepted only by the broad path", () => {
    const config = remoteConfig();
    expect(resolveApiAuth(request({ "x-api-key": "ccx_data_firstsecret" }), config)).not.toBeNull();
    expect(resolveResponsesApiAuth(request({ "x-api-key": "ccx_data_firstsecret" }), config)).toBeNull();
  });

  test("the dedicated header works on both", () => {
    const config = remoteConfig();
    const dedicated = () => request({ "x-codexcommander-api-key": "ccx_data_secondsecret" });
    expect(resolveApiAuth(dedicated(), config)).toEqual({ kind: "configured", keyId: "second-key" });
    expect(resolveResponsesApiAuth(dedicated(), config)).toEqual({ kind: "configured", keyId: "second-key" });
    expect(requireResponsesApiAuth(dedicated(), config)).toBeNull();
  });
});

describe("loopback binds", () => {
  test("admit without reading a token, and say so", () => {
    const config = loopbackConfig();
    expect(resolveApiAuth(request(), config)).toEqual({ kind: "loopback" });
    expect(resolveResponsesApiAuth(request(), config)).toEqual({ kind: "loopback" });
    expect(hasValidApiAuth(request(), config)).toBe(true);
    expect(requireResponsesApiAuth(request(), config)).toBeNull();
  });
});

describe("the Responses WebSocket handshake", () => {
  test("opens for a configured key", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccx-admission-ws-"));
    const previousHome = process.env.CODEXCOMMANDER_HOME;
    process.env.CODEXCOMMANDER_HOME = home;
    process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = "admin-secret-for-ws";
    const config = remoteConfig();
    config.websockets = true;
    saveConfig(config);
    const server = startServer(0);
    try {
      const target = new URL("/v1/responses", server.url);
      target.protocol = "ws:";
      const opened = await new Promise<boolean>(resolve => {
        const socket = new WebSocket(target, {
          headers: { "X-CodexCommander-API-Key": "ccx_data_secondsecret" },
        } as unknown as string[]);
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { socket.close(); } catch { /* already closed */ }
          resolve(value);
        };
        socket.addEventListener("open", () => finish(true));
        socket.addEventListener("error", () => finish(false));
        socket.addEventListener("close", () => finish(false));
        const timer = setTimeout(() => finish(false), 5_000);
      });
      // The handshake now branches on the resolver rather than the boolean
      // wrapper, so this pins that the rewrite did not change who gets in.
      expect(opened).toBe(true);
    } finally {
      await server.stop(true);
      if (previousAdminToken === undefined) delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
      else process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = previousAdminToken;
      if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * `ws.data` is not reachable from a client socket, so this phase cannot prove
   * end-to-end that the admission arrives in the per-frame context — nothing
   * READS it yet. What is provable here is that the handshake stores it and the
   * type carries it; phase 3, which adds the consumer, drives a real frame and
   * asserts the emitted log row carries the key id.
   */
  test("the upgrade payload carries the resolved admission", () => {
    // This is the exact object the handshake hands to `server.upgrade`, so
    // dropping `admission` from the payload fails here rather than passing a
    // socket-opened assertion that never looked at it.
    const headers = new Headers({ "x-forwarded-for": "ignored" });
    const payload = buildResponsesWsData(headers, { kind: "configured", keyId: "second-key" });
    expect(payload.admission).toEqual({ kind: "configured", keyId: "second-key" });
    expect(payload.headers).toBe(headers);
  });

  // The phase-2 guard that asserted no telemetry symbols existed yet has served
  // its purpose and is gone: phase 3 is what adds them, and a guard that must be
  // deleted by the next commit is a scheduling note, not a test. What survives is
  // the payload assertion above, which stays true regardless of who consumes it.
});

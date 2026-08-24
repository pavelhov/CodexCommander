import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { CodexCommanderConfig } from "../src/types";
import { serveGuiFile } from "../src/server/gui-static";
import { isProxyAdmissionSecret } from "../src/server/auth-cors";
import {
  initializeManagementAuthState,
  exchangeGuiLaunchTicket,
  issueGuiLaunchTicket,
  managementPrincipal,
  removeManagementTokenPathBestEffort,
  requireManagementAuth,
} from "../src/server/management-auth";
import {
  hardenSecretPath,
  hardenedSecretPathCountForTests,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
  timedOutSecretPathCountForTests,
  hardenSecretDir,
} from "../src/lib/windows-secret-acl";
import {
  verifyLocalAttestationProof,
} from "../src/lib/local-management-attestation";
import { ATTESTATION_CHALLENGE_HEADER, ATTESTATION_PROOF_HEADER } from "../src/identity";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";
import type { CodexDelegationMutation, CodexDelegationStatus } from "../src/codex/delegation-installer";

const previousHome = process.env.CODEXCOMMANDER_HOME;
const previousDataToken = process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
const previousAdminToken = process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
const previousCodexCliPath = process.env.CODEX_CLI_PATH;
let testHome = "";

function remoteConfig(): CodexCommanderConfig {
  return {
    port: 0,
    multiAgentGuidanceEnabled: true,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

function delegationStatusForManagementAuthTest(): CodexDelegationStatus {
  return {
    schemaVersion: 1,
    state: "not-installed",
    installedMode: null,
    artifacts: {
      skill: { state: "absent", displayPath: "$HOME/.agents/skills/codexcommander-delegation/SKILL.md" },
      agentsPolicy: { state: "absent", displayPath: "$CODEX_HOME/AGENTS.md" },
    },
    override: { state: "absent" },
    activation: "effective",
    previews: {
      balanced: { skillText: "managed skill", agentsBlockText: "managed AGENTS block" },
      orchestrator: { skillText: "managed skill", agentsBlockText: "managed AGENTS block" },
    },
    copyPrompts: { balanced: "managed copy prompt", orchestrator: "managed copy prompt" },
  };
}

function websocketHandshakeOpens(url: URL, token: string): Promise<boolean> {
  return new Promise(resolve => {
    const target = new URL("/v1/responses", url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(target, {
      headers: { "X-CodexCommander-API-Key": token },
    } as unknown as string[]);
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(opened);
    };
    socket.addEventListener("open", () => finish(true));
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("close", () => finish(false));
    const timer = setTimeout(() => finish(false), 5_000);
  });
}

function rawHttpRequest(port: number, request: string): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) return reject(error);
      const match = raw.match(/^HTTP\/1\.[01] (\d{3})/);
      resolve({ status: match ? Number(match[1]) : 0, raw });
    };
    const socket = createConnection({ host: "127.0.0.1", port }, () => socket.write(request));
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => finish(new Error("raw HTTP request timed out")));
    socket.on("data", chunk => { raw += chunk; });
    socket.on("end", () => finish());
    socket.on("error", error => finish(error));
  });
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ccx-management-auth-"));
  process.env.CODEXCOMMANDER_HOME = testHome;
  process.env.CODEXCOMMANDER_API_AUTH_TOKEN = "data-secret";
  process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = "admin-secret";
  process.env.CODEX_CLI_PATH = createCodexRuntimeFixture(testHome);
});

afterEach(() => {
  setIcaclsRunnerForTests(null);
  setPlatformForTests(null);
  resetHardenedStateForTests();
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
  else process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCodexCliPath;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("management and data-plane credential separation", () => {
  test("healthz proves the listener owns the protected runtime secret", async () => {
    const secret = "A".repeat(43);
    const challenge = "B".repeat(43);
    const server = startServer(0, { localAttestationSecret: secret });
    try {
      const health = await fetch(new URL("/healthz", server.url), {
        headers: { [ATTESTATION_CHALLENGE_HEADER]: challenge },
      });
      const proof = health.headers.get(ATTESTATION_PROOF_HEADER);
      expect(verifyLocalAttestationProof(secret, challenge, process.pid, server.port, proof)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("management-token temp cleanup forgets successful ACL memos and retains failed removals", () => {
    const temporary = join(testHome, ".admin-token.tmp");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ccx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    try {
      writeFileSync(temporary, "secret", { mode: 0o600 });
      hardenSecretPath(temporary, { required: true });
      removeManagementTokenPathBestEffort(temporary);
      expect(hardenedSecretPathCountForTests()).toBe(0);

      writeFileSync(temporary, "secret", { mode: 0o600 });
      hardenSecretPath(temporary, { required: true });
      removeManagementTokenPathBestEffort(temporary, () => {
        throw Object.assign(new Error("injected unlink failure"), { code: "EPERM" });
      });
      expect(hardenedSecretPathCountForTests()).toBe(1);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("stable-path cleanup drops only the success memo; temp cleanup releases all", () => {
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ccx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => ({ success: false, exitCode: null, timedOut: true, stdout: "" }));
    const stable = join(testHome, "admin-api-token");
    const temp = join(testHome, ".admin-token.tmp");
    writeFileSync(stable, "x", { mode: 0o600 });
    writeFileSync(temp, "y", { mode: 0o600 });
    try {
      // Optional timeouts memoize by path (required:false soft-fails).
      expect(hardenSecretPath(stable, { required: false }).ok).toBe(false);
      expect(hardenSecretPath(temp, { required: false }).ok).toBe(false);
      expect(timedOutSecretPathCountForTests()).toBe(2);
      // Stable cleanup: success memo gone, timeout memos UNTOUCHED (anti-restall).
      removeManagementTokenPathBestEffort(stable);
      expect(timedOutSecretPathCountForTests()).toBe(2);
      // Temp cleanup with the ephemeral flag: only the temp's memo is released;
      // the stable destination memo still stands.
      removeManagementTokenPathBestEffort(temp, unlinkSync, { ephemeral: true });
      expect(timedOutSecretPathCountForTests()).toBe(1);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("final-path timeout memo survives stable-path cleanup (anti-restall)", async () => {
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ccx-test-user";
    delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    // The temp harden succeeds; the FINAL path harden times out.
    let calls = 0;
    setIcaclsRunnerForTests(() => {
      calls += 1;
      // Production runs 3 icacls per harden: directory (1-3), temp (4-6),
      // final token path (7-9) — the timeout must land on the FINAL path.
      return calls <= 6
        ? { success: true, exitCode: 0, timedOut: false, stdout: "" }
        : { success: false, exitCode: null, timedOut: true, stdout: "" };
    });
    try {
      initializeManagementAuthState(remoteConfig());
      expect(timedOutSecretPathCountForTests()).toBe(1);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("data and management environment tokens authorize only their own planes", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const managementWithDataToken = await fetch(new URL("/api/config", server.url), {
        headers: { "x-codexcommander-api-key": "data-secret" },
      });
      expect(managementWithDataToken.status).toBe(401);

      const managementWithAdminToken = await fetch(new URL("/api/config", server.url), {
        headers: { "x-codexcommander-api-key": "admin-secret" },
      });
      expect(managementWithAdminToken.status).toBe(200);

      const dataWithDataToken = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-codexcommander-api-key": "data-secret" },
      });
      expect(dataWithDataToken.status).toBe(200);

      const dataWithAdminToken = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-codexcommander-api-key": "admin-secret" },
      });
      expect(dataWithAdminToken.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("fresh route observation stays behind management auth and is never cached", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0, {
      managementApi: { getCodexRoutingKind: () => "native" },
    });
    try {
      const path = new URL("/api/codex-routing", server.url);
      expect((await fetch(path)).status).toBe(401);
      expect((await fetch(path, {
        headers: { "x-codexcommander-api-key": "data-secret" },
      })).status).toBe(401);

      const response = await fetch(path, {
        headers: { "x-codexcommander-api-key": "admin-secret" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        schemaVersion: 1,
        routingKind: "native",
        routingInjected: false,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("a management token that matches the data environment token closes only the management plane", async () => {
    process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = "data-secret";
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-codexcommander-api-key": "data-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-codexcommander-api-key": "data-secret" },
      });
      expect(management.status).toBe(503);
    } finally {
      await server.stop(true);
    }
  });

  test("a management token that matches a configured data key closes only the management plane", async () => {
    delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
    const config = remoteConfig();
    config.apiKeys = [{
      id: "conflict",
      name: "Conflicting data key",
      key: "admin-secret",
      createdAt: "2026-07-28T00:00:00.000Z",
    }];
    saveConfig(config);
    const server = startServer(0);
    try {
      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-codexcommander-api-key": "admin-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-codexcommander-api-key": "admin-secret" },
      });
      expect(management.status).toBe(503);
    } finally {
      await server.stop(true);
    }
  });

  test("a protected management token file is generated and remains management-only", async () => {
    delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const adminToken = readFileSync(join(testHome, "admin-api-token"), "utf8").trim();
      expect(adminToken).toMatch(/^ccx_admin_[A-Za-z0-9_-]{43}$/);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-codexcommander-api-key": adminToken },
      });
      expect(management.status).toBe(200);

      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-codexcommander-api-key": adminToken },
      });
      expect(data.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("an icacls timeout keeps the management plane closed without stopping the data plane", async () => {
    delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target.includes(".admin-token.tmp")) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });

    const server = startServer(0);
    try {
      const health = await fetch(new URL("/healthz", server.url));
      expect(health.status).toBe(200);

      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-codexcommander-api-key": "data-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-codexcommander-api-key": "ccx_admin_unhardened" },
      });
      expect(management.status).toBe(503);
      const body = await management.json() as { error?: string; hint?: string; reason?: string };
      expect(body.error).toBe("management API unavailable");
      expect(body.hint).toContain("CODEXCOMMANDER_ADMIN_AUTH_TOKEN");
      expect(typeof body.reason).toBe("string");
      expect(body.reason!.length).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a configured data key satisfies the remote data-plane startup requirement", async () => {
    delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
    const config = remoteConfig();
    config.apiKeys = [{
      id: "configured",
      name: "Configured data key",
      key: "ccx_data_configured-secret",
      createdAt: "2026-07-28T00:00:00.000Z",
    }];
    saveConfig(config);

    const server = startServer(0);
    try {
      const data = await fetch(new URL("/v1/models", server.url), {
        headers: { "x-codexcommander-api-key": "ccx_data_configured-secret" },
      });
      expect(data.status).toBe(200);

      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-codexcommander-api-key": "ccx_data_configured-secret" },
      });
      expect(management.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("management browser origins must match the request origin exactly", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const server = startServer(0);
    try {
      const crossPort = await fetch(new URL("/api/config", server.url), {
        headers: {
          "x-codexcommander-api-key": "admin-secret",
          origin: "http://127.0.0.1:65534",
        },
      });
      expect(crossPort.status).toBe(403);

      const sameOrigin = await fetch(new URL("/api/config", server.url), {
        headers: {
          "x-codexcommander-api-key": "admin-secret",
          origin: server.url.origin,
        },
      });
      expect(sameOrigin.status).toBe(200);
      expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(server.url.origin);
    } finally {
      await server.stop(true);
    }
  });

  test("a static GUI page never embeds a management bearer", async () => {
    const guiDist = join(testHome, "gui");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(guiDist);
    writeFileSync(join(guiDist, "index.html"), "<!doctype html><html><head></head><body></body></html>");
    const page = serveGuiFile("/", guiDist);
    expect(page?.headers.get("cache-control")).toBe("no-store");
    const html = await page?.text();
    expect(html).not.toContain("codexcommander-session-token");
    expect(html).not.toContain("codexcommander-session-csrf");
    expect(html).not.toContain("ccx_session_");
  });

  test("launch tickets are single-use, exact-origin/route bound, and create a confirmed principal", () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    const state = initializeManagementAuthState(config);
    const now = Date.now();
    const mintRequest = new Request("http://127.0.0.1:10100/api/gui-launch-ticket", {
      method: "POST",
      headers: { Host: "127.0.0.1:10100" },
    });
    const issued = issueGuiLaunchTicket(mintRequest, "subagents", config, state, now);
    expect(issued).toMatchObject({
      origin: "http://127.0.0.1:10100",
      route: "subagents",
      expiresAt: now + 30_000,
    });
    expect(issued?.ticket).toMatch(/^ccx_launch_[A-Za-z0-9_-]{43}$/);

    const wrongOrigin = new Request("http://127.0.0.1:10100/api/gui-launch-exchange", {
      method: "POST",
      headers: { Host: "127.0.0.1:10100", Origin: "http://localhost:10100" },
    });
    expect(exchangeGuiLaunchTicket(
      wrongOrigin,
      issued?.ticket,
      "subagents",
      config,
      state,
      now + 1,
    )).toBeNull();

    const exactOrigin = new Request("http://127.0.0.1:10100/api/gui-launch-exchange", {
      method: "POST",
      headers: { Host: "127.0.0.1:10100", Origin: "http://127.0.0.1:10100" },
    });
    // The failed origin attempt consumed the bearer before comparison.
    expect(exchangeGuiLaunchTicket(
      exactOrigin,
      issued?.ticket,
      "subagents",
      config,
      state,
      now + 2,
    )).toBeNull();

    const second = issueGuiLaunchTicket(mintRequest, "subagents", config, state, now + 10)!;
    expect(exchangeGuiLaunchTicket(
      exactOrigin,
      second.ticket,
      "wrong-route",
      config,
      state,
      now + 11,
    )).toBeNull();
    expect(exchangeGuiLaunchTicket(
      exactOrigin,
      second.ticket,
      "subagents",
      config,
      state,
      now + 12,
    )).toBeNull();

    const third = issueGuiLaunchTicket(mintRequest, "subagents", config, state, now + 20)!;
    const session = exchangeGuiLaunchTicket(
      exactOrigin,
      third.ticket,
      "subagents",
      config,
      state,
      now + 21,
    );
    expect(session).toMatchObject({
      origin: "http://127.0.0.1:10100",
      confirmedLaunch: true,
      expiresAt: now + 8 * 60 * 60_000 + 21,
    });
    const authorized = new Request("http://127.0.0.1:10100/api/settings", {
      method: "PUT",
      headers: {
        Host: "127.0.0.1:10100",
        Origin: "http://127.0.0.1:10100",
        "x-codexcommander-api-key": session?.token ?? "",
        "x-codexcommander-gui-origin": "http://127.0.0.1:10100",
        "x-codexcommander-csrf-token": session?.csrfToken ?? "",
      },
    });
    expect(requireManagementAuth(authorized, state, config)).toBeNull();
    expect(managementPrincipal(authorized, state, config)).toBe("confirmed-gui-session");
  });

  test("launch tickets expire, are bounded, and disappear with process state", () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    const state = initializeManagementAuthState(config);
    const mintRequest = new Request("http://127.0.0.1:10100/api/gui-launch-ticket", {
      method: "POST",
      headers: { Host: "127.0.0.1:10100" },
    });
    const exchangeRequest = new Request("http://127.0.0.1:10100/api/gui-launch-exchange", {
      method: "POST",
      headers: { Host: "127.0.0.1:10100", Origin: "http://127.0.0.1:10100" },
    });
    const expired = issueGuiLaunchTicket(mintRequest, "dashboard", config, state, 10_000)!;
    expect(exchangeGuiLaunchTicket(
      exchangeRequest,
      expired.ticket,
      "dashboard",
      config,
      state,
      40_000,
    )).toBeNull();

    const issued = Array.from({ length: 17 }, (_, index) => (
      issueGuiLaunchTicket(mintRequest, `dashboard/${index}`, config, state, 50_000 + index)!
    ));
    expect(exchangeGuiLaunchTicket(
      exchangeRequest,
      issued[0]!.ticket,
      issued[0]!.route,
      config,
      state,
      50_100,
    )).toBeNull();
    expect(exchangeGuiLaunchTicket(
      exchangeRequest,
      issued[16]!.ticket,
      issued[16]!.route,
      config,
      state,
      50_100,
    )?.confirmedLaunch).toBe(true);

    const beforeRestart = issueGuiLaunchTicket(mintRequest, "dashboard", config, state, 60_000)!;
    const replacementState = initializeManagementAuthState(config);
    expect(exchangeGuiLaunchTicket(
      exchangeRequest,
      beforeRestart.ticket,
      "dashboard",
      config,
      replacementState,
      60_001,
    )).toBeNull();
  });

  test("legacy GUI bootstrap is a no-store tombstone and never returns credentials", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/codexcommander-session", server.url), {
        headers: { Host: server.url.host },
      });
      expect(response.status).toBe(410);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

      const html = await response.text();
      expect(html).not.toContain("codexcommander-session-token");
      expect(html).not.toContain("ccx_session_");
    } finally {
      await server.stop(true);
    }
  });

  test("admin launch-ticket mint remains available when data-plane auth is enabled", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/gui-launch-ticket", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codexcommander-api-key": "admin-secret",
        },
        body: JSON.stringify({ route: "dashboard" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        origin: server.url.origin,
        route: "dashboard",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("pre-auth launch exchange rejects unbound or unbounded bodies before ticket consumption", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const server = startServer(0);
    try {
      const mint = async () => {
        const response = await fetch(new URL("/api/gui-launch-ticket", server.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codexcommander-api-key": "admin-secret",
          },
          body: JSON.stringify({ route: "dashboard" }),
        });
        expect(response.status).toBe(200);
        return response.json() as Promise<{ ticket: string; route: string }>;
      };
      const ticket = await mint();
      const exchange = new URL("/api/gui-launch-exchange", server.url);
      const body = JSON.stringify({ ticket: ticket.ticket, route: ticket.route });

      const get = await fetch(exchange);
      expect(get.status).toBe(400);
      expect(get.headers.get("cache-control")).toBe("no-store");

      const missingOrigin = await fetch(exchange, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(missingOrigin.status).toBe(401);
      expect(missingOrigin.headers.get("cache-control")).toBe("no-store");

      const wrongOrigin = await fetch(exchange, {
        method: "POST",
        headers: { Origin: "http://localhost:65534", "content-type": "application/json" },
        body,
      });
      expect(wrongOrigin.status).toBe(401);
      expect(wrongOrigin.headers.get("access-control-allow-origin")).not.toBe("http://localhost:65534");

      const hostileHost = await fetch(exchange, {
        method: "POST",
        headers: { Host: "attacker.test", Origin: "http://attacker.test", "content-type": "application/json" },
        body,
      });
      expect(hostileHost.status).toBe(401);
      expect(hostileHost.headers.get("access-control-allow-origin")).not.toBe("http://attacker.test");

      const compressed = await fetch(exchange, {
        method: "POST",
        headers: {
          Origin: server.url.origin,
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body,
      });
      expect(compressed.status).toBe(415);
      expect(compressed.headers.get("cache-control")).toBe("no-store");

      const oversized = `${body.slice(0, -1)},"padding":"${"x".repeat(2_100)}"}`;
      const first = oversized.slice(0, 1_000);
      const second = oversized.slice(1_000);
      const rawLarge = await rawHttpRequest(server.port, [
        "POST /api/gui-launch-exchange HTTP/1.1",
        `Host: ${server.url.host}`,
        `Origin: ${server.url.origin}`,
        "Content-Type: application/json",
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        `${Buffer.byteLength(first).toString(16)}\r\n${first}\r\n${Buffer.byteLength(second).toString(16)}\r\n${second}\r\n0`,
        "",
        "",
      ].join("\r\n"));
      expect(rawLarge.status).toBe(413);
      expect(rawLarge.raw.toLowerCase()).toContain("cache-control: no-store");

      const malformedLength = await rawHttpRequest(server.port, [
        "POST /api/gui-launch-exchange HTTP/1.1",
        `Host: ${server.url.host}`,
        `Origin: ${server.url.origin}`,
        "Content-Type: application/json",
        "Content-Length: -1",
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
      // Bun's HTTP parser may close malformed framing before application code
      // (status 0) or synthesize 400; either outcome refuses it before body bytes.
      expect([0, 400]).toContain(malformedLength.status);

      // All preflight/body refusals happened before the live ticket was looked up.
      const accepted = await fetch(exchange, {
        method: "POST",
        headers: { Origin: server.url.origin, "Content-Type": "Application/JSON; Charset=UTF-8" },
        body,
      });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("cache-control")).toBe("no-store");
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("manual GUI requests have no API access while confirmed and admin principals may mutate", async () => {
    delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const state = initializeManagementAuthState(config);
    const server = startServer(0, { managementAuthState: state });
    try {
      expect((await fetch(new URL("/api/settings", server.url))).status).toBe(401);
      expect((await fetch(new URL("/api/provider-quotas?refresh=1", server.url))).status).toBe(401);
      expect((await fetch(new URL("/api/providers?name=test", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "confirmed authorization regression" }),
      })).status).toBe(401);
      expect((await fetch(new URL("/api/providers/test?name=test", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })).status).toBe(401);

      const mintedResponse = await fetch(new URL("/api/gui-launch-ticket", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codexcommander-api-key": "admin-secret",
        },
        body: JSON.stringify({ route: "providers/test/settings" }),
      });
      expect(mintedResponse.status).toBe(200);
      const minted = await mintedResponse.json() as { ticket: string; route: string };
      const exchangeResponse = await fetch(new URL("/api/gui-launch-exchange", server.url), {
        method: "POST",
        headers: { Origin: server.url.origin, "content-type": "application/json" },
        body: JSON.stringify({ ticket: minted.ticket, route: minted.route }),
      });
      expect(exchangeResponse.status).toBe(200);
      const exchanged = await exchangeResponse.json() as {
        session: { token: string; csrfToken: string; origin: string; confirmedLaunch: boolean };
      };
      expect(exchanged.session.confirmedLaunch).toBe(true);
      const confirmedHeaders = {
        Origin: server.url.origin,
        "content-type": "application/json",
        "x-codexcommander-api-key": exchanged.session.token,
        "x-codexcommander-gui-origin": exchanged.session.origin,
        "x-codexcommander-csrf-token": exchanged.session.csrfToken,
      };
      expect((await fetch(new URL("/api/providers?name=test", server.url), {
        method: "PATCH",
        headers: confirmedHeaders,
        body: JSON.stringify({ note: "confirmed authorization regression" }),
      })).status).toBe(200);
      expect((await fetch(new URL("/api/providers?name=test", server.url), {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-codexcommander-api-key": "admin-secret",
        },
        body: JSON.stringify({ note: "admin authorization regression" }),
      })).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("Codex delegation changes require both a confirmed GUI session and its origin/CSRF proof", async () => {
    delete process.env.CODEXCOMMANDER_API_AUTH_TOKEN;
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const state = initializeManagementAuthState(config);
    const mutations: CodexDelegationMutation[] = [];
    const server = startServer(0, {
      managementAuthState: state,
      managementApi: {
        inspectCodexDelegation: delegationStatusForManagementAuthTest,
        mutateCodexDelegation: mutation => {
          mutations.push(mutation);
          return {
            ok: true,
            changed: true,
            status: delegationStatusForManagementAuthTest(),
          };
        },
      },
    });
    try {
      const mintedResponse = await fetch(new URL("/api/gui-launch-ticket", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codexcommander-api-key": "admin-secret",
        },
        body: JSON.stringify({ route: "subagents" }),
      });
      expect(mintedResponse.status).toBe(200);
      const minted = await mintedResponse.json() as { ticket: string; route: string };
      const exchangeResponse = await fetch(new URL("/api/gui-launch-exchange", server.url), {
        method: "POST",
        headers: { Origin: server.url.origin, "content-type": "application/json" },
        body: JSON.stringify({ ticket: minted.ticket, route: minted.route }),
      });
      expect(exchangeResponse.status).toBe(200);
      const exchanged = await exchangeResponse.json() as {
        session: { token: string; csrfToken: string; origin: string };
      };

      const missingBrowserProof = await fetch(new URL("/api/codex-delegation", server.url), {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-codexcommander-api-key": exchanged.session.token,
        },
        body: JSON.stringify({ mode: "balanced" }),
      });
      expect(missingBrowserProof.status).toBe(401);
      expect(mutations).toEqual([]);

      const confirmed = await fetch(new URL("/api/codex-delegation", server.url), {
        method: "PUT",
        headers: {
          Origin: exchanged.session.origin,
          "content-type": "application/json",
          "x-codexcommander-api-key": exchanged.session.token,
          "x-codexcommander-gui-origin": exchanged.session.origin,
          "x-codexcommander-csrf-token": exchanged.session.csrfToken,
        },
        body: JSON.stringify({ mode: "orchestrator" }),
      });
      expect(confirmed.status).toBe(200);
      expect(mutations).toEqual([{ action: "install", mode: "orchestrator" }]);

      const rawAdmin = await fetch(new URL("/api/codex-delegation", server.url), {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-codexcommander-api-key": "admin-secret",
        },
        body: JSON.stringify({ mode: "balanced" }),
      });
      expect(rawAdmin.status).toBe(403);
      expect(mutations).toEqual([{ action: "install", mode: "orchestrator" }]);
    } finally {
      await server.stop(true);
    }
  });

  test("all local credential shapes are rejected by the upstream-forwarding guard", () => {
    const config = remoteConfig();
    config.apiKeys = [{
      id: "manual",
      name: "Manual data key",
      key: "manually-configured-data-secret",
      createdAt: "2026-07-28T00:00:00.000Z",
    }];
    for (const secret of [
      "data-secret",
      "admin-secret",
      "manually-configured-data-secret",
      "ccx_data_generated",
      "ccx_admin_generated",
      "ccx_session_generated",
    ]) {
      expect(isProxyAdmissionSecret(secret, config)).toBe(true);
    }
    expect(isProxyAdmissionSecret("ccx_provider_upstream", config)).toBe(false);
  });

  test("Responses authentication and WebSocket handshakes accept data credentials only", async () => {
    const config = remoteConfig();
    config.websockets = true;
    saveConfig(config);
    const server = startServer(0);
    try {
      for (const rejected of ["admin-secret", "ccx_session_browser-secret"]) {
        const response = await fetch(new URL("/v1/responses", server.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codexcommander-api-key": rejected,
          },
          body: JSON.stringify({ model: "test/gpt-test", input: "hello" }),
        });
        expect(response.status).toBe(401);
        expect(await websocketHandshakeOpens(server.url, rejected)).toBe(false);
      }
      expect(await websocketHandshakeOpens(server.url, "data-secret")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("an invalid existing management token file keeps management unavailable", async () => {
    delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    writeFileSync(join(testHome, "admin-api-token"), "corrupt-token\n", { mode: 0o600 });
    const server = startServer(0);
    try {
      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-codexcommander-api-key": "corrupt-token" },
      });
      expect(management.status).toBe(503);
      expect(readFileSync(join(testHome, "admin-api-token"), "utf8")).toBe("corrupt-token\n");
      expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS); // binds a real server + live fetches; windows runner measured ~5.04s against Bun's 5s default.

  test("an existing management token ACL hardening failure keeps management unavailable", async () => {
    delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const adminToken = `ccx_admin_${"b".repeat(43)}`;
    writeFileSync(join(testHome, "admin-api-token"), `${adminToken}\n`, { mode: 0o600 });
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target.endsWith("admin-api-token")) {
        return { success: false, exitCode: 5, timedOut: false, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    const server = startServer(0);
    try {
      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-codexcommander-api-key": adminToken },
      });
      expect(management.status).toBe(503);
      expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("directory ACL timeout keeps management unavailable and names CODEXCOMMANDER_ADMIN_AUTH_TOKEN", () => {
    delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const adminToken = `ccx_admin_${"d".repeat(43)}`;
    writeFileSync(join(testHome, "admin-api-token"), `${adminToken}\n`, { mode: 0o600 });
    process.env.USERNAME ??= "tester";
    setPlatformForTests("win32");
    // Timeout only the management-token directory. File hardens must succeed so
    // startServer → saveConfig can atomic-write on real win32; Linux CI skips
    // that path via process.platform and hid the blanket-timeout failure mode.
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target === testHome) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();
    // Probe only: startServer would re-harden the same home for config mutation
    // and poison/conflict with this required directory timeout. HTTP 503 coverage
    // for ACL timeouts lives in "an icacls timeout keeps the management plane closed".
    const state = initializeManagementAuthState(remoteConfig());
    expect(state.available).toBe(false);
    if (state.available) return;
    expect(state.reason).toContain("CODEXCOMMANDER_ADMIN_AUTH_TOKEN");
  });

  test("required management harden retries after a soft loadConfig directory timeout", async () => {
    delete process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN;
    saveConfig(remoteConfig());
    const adminToken = `ccx_admin_${"f".repeat(43)}`;
    writeFileSync(join(testHome, "admin-api-token"), `${adminToken}\n`, { mode: 0o600 });
    process.env.USERNAME ??= "tester";
    setPlatformForTests("win32");

    let softPhase = true;
    let requiredPhaseCalls = 0;
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target.endsWith("admin-api-token")) {
        return { success: true, exitCode: 0, timedOut: false, stdout: "" };
      }
      if (softPhase) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      requiredPhaseCalls += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();

    const soft = hardenSecretDir(testHome, { required: false });
    expect(soft.ok).toBe(false);
    expect(soft.diagnostics).toMatch(/timed out|budget exhausted|previous attempt/i);

    softPhase = false;
    const state = initializeManagementAuthState(remoteConfig());
    expect(state.available).toBe(true);
    if (!state.available) return;
    expect(state.source).toBe("file");
    expect(requiredPhaseCalls).toBeGreaterThan(0);
  });

  test("CODEXCOMMANDER_ADMIN_AUTH_TOKEN bypasses file-backed ACL hardening", async () => {
    process.env.CODEXCOMMANDER_ADMIN_AUTH_TOKEN = "env-admin-secret";
    saveConfig(remoteConfig());
    process.env.USERNAME ??= "tester";
    setPlatformForTests("win32");
    // Env-token init never needs file ACL. Time out management-token paths so a
    // broken file-backed ACL cannot be what made management available; allow
    // other file hardens so startServer → saveConfig works on real win32
    // (config-mutation directory harden soft-fails home timeouts).
    setIcaclsRunnerForTests(args => {
      const target = args[0] ?? "";
      if (target === testHome || target.endsWith("admin-api-token")) {
        return { success: false, exitCode: null, timedOut: true, stdout: "" };
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    resetHardenedStateForTests();

    const state = initializeManagementAuthState(remoteConfig());
    expect(state.available).toBe(true);
    if (!state.available) return;
    expect(state.source).toBe("environment");

    const server = startServer(0);
    try {
      const management = await fetch(new URL("/api/config", server.url), {
        headers: { "x-codexcommander-api-key": "env-admin-secret" },
      });
      expect(management.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});

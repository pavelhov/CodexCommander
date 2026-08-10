/**
 * The Codex switch route.
 *
 * The thing worth proving here is not that a boolean lands in a file. It is that
 * turning Codex OFF is not `ccx stop`: the proxy keeps serving, `/healthz` keeps
 * answering, other clients keep routing, and only Codex goes back to its own
 * path. A per-client switch that took the whole proxy down would be a kill
 * switch with a misleading label.
 *
 * The second thing is ordering. Intent is persisted BEFORE artifacts converge,
 * so a process that dies between the two leaves a decision the next start can
 * act on — rather than artifacts the next start silently undoes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { CodexSyncResult } from "../src/codex/sync";
import type { CodexCommanderConfig } from "../src/types";

let fixtureRoot = "";
let previousCodexCommanderHome: string | undefined;
const cleanup: string[] = [];

function baseConfig(): CodexCommanderConfig {
  return {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    } as CodexCommanderConfig["providers"],
    defaultProvider: "openai",
  };
}

function currentSyncResult(): CodexSyncResult {
  return {
    status: "applied",
    ok: true,
    added: 1,
    catalogPath: join(fixtureRoot, "models.json"),
    catalogExists: true,
    catalogWritten: true,
    cacheSynced: true,
    catalogQuality: "live",
    rehydrated: 0,
    message: "Codex integration is current",
  };
}

function testDeps(overrides: Partial<ManagementApiDeps> = {}): ManagementApiDeps {
  return {
    fetchAllModels: async () => [] as never,
    syncModelsToCodex: async () => currentSyncResult(),
    ...overrides,
  } as ManagementApiDeps;
}

function dispatch(config: CodexCommanderConfig, path: string, init?: RequestInit, deps: ManagementApiDeps = testDeps()) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return handleManagementAPI(
    new Request(url, { ...init, headers: { Host: url.host, ...(init?.headers ?? {}) } }),
    url,
    config,
    deps,
  );
}

async function put(config: CodexCommanderConfig, body: unknown, deps?: ManagementApiDeps) {
  const res = await dispatch(config, "/api/native-integrations/codex", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, deps);
  return { status: res!.status, body: await res!.json() as Record<string, unknown> };
}

function persistedCodexIntent(): unknown {
  const raw = JSON.parse(readFileSync(join(fixtureRoot, "config.json"), "utf8")) as Record<string, unknown>;
  return (raw.clientIntegrations as Record<string, unknown> | undefined)?.codex;
}

beforeEach(() => {
  previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
  fixtureRoot = mkdtempSync(join(tmpdir(), "ccx-codex-toggle-"));
  cleanup.push(fixtureRoot);
  process.env.CODEXCOMMANDER_HOME = fixtureRoot;
  writeFileSync(join(fixtureRoot, "config.json"), JSON.stringify(baseConfig(), null, 2));
  writeFileSync(join(fixtureRoot, "service-state.json"), JSON.stringify({
    version: 3,
    codexHome: process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    codexCommanderHome: fixtureRoot,
    bunPath: process.execPath,
    cliPath: join(import.meta.dir, "../src/cli/index.ts"),
    backend: "scheduler",
  }), { mode: 0o600 });
});

afterEach(() => {
  if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("request validation", () => {
  test("a non-boolean enabled is rejected before anything is written", async () => {
    const result = await put(baseConfig(), { enabled: "false" });
    expect(result.status).toBe(400);
    expect(persistedCodexIntent()).toBeUndefined();
  });

  test("a missing enabled is rejected before anything is written", async () => {
    const result = await put(baseConfig(), {});
    expect(result.status).toBe(400);
    expect(persistedCodexIntent()).toBeUndefined();
  });
});

describe("turning Codex off", () => {
  test("persists the decision so it survives the next start", async () => {
    const result = await put(baseConfig(), { enabled: false });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, clientId: "codex" });
    expect(result.body.artifacts).toMatchObject({
      config: { state: expect.any(String) },
      catalog: { state: expect.any(String) },
    });
    // The decision is on disk. Without this, an OFF lasts until the next
    // `ccx start` re-syncs over it, which is the defect this phase exists for.
    expect(persistedCodexIntent()).toBe(false);
  });

  /**
   * THE PROXY STAYS UP. The user asked for this in exactly these terms: they may
   * want everything except Codex routed. If turning Codex off stopped the proxy,
   * every other client would lose its routing too.
   */
  test("the management API keeps serving other routes afterwards", async () => {
    await put(baseConfig(), { enabled: false });

    // `/healthz` is served by the request router rather than the management API,
    // so the observable claim HERE is that the management surface itself is
    // still answering — the route did not tear the process down or leave a
    // lock/flight wedged behind it.
    const others = await dispatch(baseConfig(), "/api/native-integrations");
    expect(others!.status).toBe(200);
    const body = await others!.json() as { clients: { clientId: string }[] };
    expect(body.clients.some(c => c.clientId === "claude")).toBe(true);

    // And the switch is re-usable immediately: a wedged in-flight guard would
    // return 409 here rather than a normal answer.
    const again = await put(baseConfig(), { enabled: false });
    expect(again.status).toBe(200);
  });

  test("turning it off twice is honest about the second one changing nothing", async () => {
    const first = await put(baseConfig(), { enabled: false });
    const second = await put(baseConfig(), { enabled: false });
    expect(first.body.changed).toBe(true);
    expect(second.body.changed).toBe(false);
    expect(persistedCodexIntent()).toBe(false);
  });
});

describe("turning Codex back on", () => {
  test("removes the key rather than storing true", async () => {
    await put(baseConfig(), { enabled: false });
    expect(persistedCodexIntent()).toBe(false);

    const result = await put(baseConfig(), { enabled: true });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      clientId: "codex",
      state: "current",
      desiredEnabled: true,
    });
    // Absence is ON, so an untouched config and a re-enabled one are identical.
    expect(persistedCodexIntent()).toBeUndefined();
  });
});

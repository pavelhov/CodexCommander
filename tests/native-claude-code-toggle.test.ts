import { expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import type { CodexCommanderConfig } from "../src/types";

/**
 * Route contract for implementation contract
 *
 * The toggle writes one field of codexcommander's own config, so there is nothing to
 * snapshot and nothing to journal — turning it back on is the undo. What DOES
 * need proving is that it agrees with the older `PUT /api/claude-code` about the
 * block's invariants, not merely about the flag.
 */

function baseConfig(overrides: Partial<CodexCommanderConfig> = {}): CodexCommanderConfig {
  return {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true },
    },
    ...overrides,
  } as CodexCommanderConfig;
}

/**
 * `saveConfigPreservingClaudeCode` is injected as a no-op spy on purpose: the
 * production function writes the developer's real CODEXCOMMANDER_HOME, and
 * ManagementApiDeps carries this seam precisely so a fixture config cannot
 * overwrite it (src/server/management/context.ts).
 */
function dispatch(config: CodexCommanderConfig, path: string, init?: RequestInit) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const saved: CodexCommanderConfig[] = [];
  const response = handleManagementAPI(
    new Request(url, { ...init, headers: { Host: url.host, ...(init?.headers ?? {}) } }),
    url,
    config,
    { saveConfigPreservingClaudeCode: c => { saved.push(structuredClone(c)); } },
  );
  return { response, saved };
}

async function put(config: CodexCommanderConfig, enabled: boolean) {
  const { response, saved } = dispatch(config, "/api/native-integrations/claude", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const res = await response;
  return { status: res!.status, body: await res!.json() as Record<string, unknown>, saved };
}

test("an absent claudeCode block reads as ON", async () => {
  // Only an explicit `false` means off — all six read sites agree, so the
  // status must not report a config that has never been touched as disabled.
  const { response } = dispatch(baseConfig(), "/api/native-integrations");
  const body = await (await response)!.json() as { clients: { clientId: string; state: string; installed: boolean }[] };
  const claude = body.clients.find(c => c.clientId === "claude");
  expect(claude?.state).toBe("current");
  // The surface exists wherever the proxy does; there is no separate install.
  expect(claude?.installed).toBe(true);
});

test("disabling sets the flag and reports absent", async () => {
  const config = baseConfig({ claudeCode: { enabled: true } });
  const { status, body, saved } = await put(config, false);
  expect(status).toBe(200);
  expect(body.changed).toBe(true);
  expect(body.state).toBe("absent");
  expect(config.claudeCode?.enabled).toBe(false);
  expect(saved).toHaveLength(1);
});

test("a toggle to the current value changes nothing and persists nothing", async () => {
  const config = baseConfig({ claudeCode: { enabled: true } });
  const { status, body, saved } = await put(config, true);
  expect(status).toBe(200);
  expect(body.changed).toBe(false);
  // The point of the guard: no write at all, not merely an idempotent one.
  expect(saved).toHaveLength(0);
});

test("creating the block stores only the requested toggle", async () => {
  const config = baseConfig();
  expect(config.claudeCode).toBeUndefined();
  await put(config, false);
  expect(config.claudeCode).toEqual({ enabled: false });
});

test("the toggle preserves every other claudeCode field", async () => {
  // It is a toggle, not a settings surface: the Claude tab owns these and a
  // switch that quietly dropped them would be a data-loss bug.
  const config = baseConfig({
    claudeCode: { enabled: true, smallFastModel: "anthropic/claude-haiku-5", systemEnv: true, injectAgents: false },
  });
  await put(config, false);
  expect(config.claudeCode?.smallFastModel).toBe("anthropic/claude-haiku-5");
  expect(config.claudeCode?.systemEnv).toBe(true);
  expect(config.claudeCode?.injectAgents).toBe(false);
});

test("a non-boolean enabled is rejected", async () => {
  const { response } = dispatch(baseConfig(), "/api/native-integrations/claude", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: "yes" }),
  });
  const res = await response;
  expect(res!.status).toBe(400);
});

test("genuine lock contention refuses 409 config_busy, a broken lock is a 500", async () => {
  /*
   * `ConfigMutationLockError` wraps EVERY acquisition failure behind one
   * constant `code`, so only the cause separates a conflict from a lock we
   * could not open. Mapping the whole class to a retryable 409 would tell the
   * user to retry an unopenable file, which fails identically forever.
   */
  const lockError = (causeCode?: string) => Object.assign(
    new Error("Config mutation already in progress"),
    { code: "CONFIG_MUTATION_LOCK_UNAVAILABLE", cause: causeCode ? { code: causeCode } : undefined },
  );

  for (const [causeCode, expectedStatus, expectedReason, expectedCode] of [
    ["SQLITE_BUSY", 409, "config_busy", "native_integration_refused"],
    [undefined, 500, "write_failed", "native_integration_failed"],
  ] as const) {
    const config = baseConfig({ claudeCode: { enabled: true } });
    const url = new URL("http://127.0.0.1:10100/api/native-integrations/claude");
    const res = await handleManagementAPI(
      new Request(url, {
        method: "PUT",
        headers: { Host: url.host, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      url,
      config,
      { saveConfigPreservingClaudeCode: () => { throw lockError(causeCode); } },
    );
    expect(res!.status).toBe(expectedStatus);
    const body = await res!.json() as { reason: string; code: string };
    expect(body.reason).toBe(expectedReason);
    // The envelope's `code` is part of the contract (030 acceptance row 2):
    // refused below 500, failed at 500 — a silent swap would mislead the GUI.
    expect(body.code).toBe(expectedCode);
  }
});

test("enabling WITH a change flips the flag and reports current", async () => {
  // The other direction of acceptance row 1 (wp3 A-gate): every sibling test
  // toggles off or toggles-to-current; this is the one that proves ON works.
  const config = baseConfig({ claudeCode: { enabled: false } });
  const { status, body, saved } = await put(config, true);
  expect(status).toBe(200);
  expect(body.changed).toBe(true);
  expect(body.state).toBe("current");
  expect(config.claudeCode?.enabled).toBe(true);
  expect(saved).toHaveLength(1);
  expect(saved[0]!.claudeCode).toEqual({ enabled: true });
});

test("a held REAL config transaction refuses 409 config_busy, and release lets a retry through", async () => {
  /*
   * Acceptance (audit r7 #2): a real second connection holding the lock, not
   * a mocked throw. The holder runs the same `PRAGMA busy_timeout = 0;
   * BEGIN IMMEDIATE` the lock itself uses (src/config.ts:1771), so the route's
   * own acquisition fails with SQLITE_BUSY exactly as cross-process contention
   * would. The route runs the REAL saveConfigPreservingClaudeCode — no seam —
   * against a fixture CODEXCOMMANDER_HOME.
   */
  const { Database } = await import("bun:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ccx-lock-"));
  const previousHome = process.env.CODEXCOMMANDER_HOME;
  process.env.CODEXCOMMANDER_HOME = fixtureRoot;
  const holder = new Database(join(fixtureRoot, "config-mutation.sqlite"), { create: true });
  try {
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const putReal = (config: CodexCommanderConfig) => {
      const url = new URL("http://127.0.0.1:10100/api/native-integrations/claude");
      return handleManagementAPI(
        new Request(url, {
          method: "PUT",
          headers: { Host: url.host, "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }),
        url,
        config,
        // NO persistence seam: the real saveConfigPreservingClaudeCode runs.
        {},
      );
    };
    const refused = await putReal(baseConfig({ claudeCode: { enabled: true } }));
    expect(refused!.status).toBe(409);
    const refusedBody = await refused!.json() as { code: string; reason: string };
    expect(refusedBody.code).toBe("native_integration_refused");
    expect(refusedBody.reason).toBe("config_busy");

    holder.exec("ROLLBACK");
    holder.close();
    /*
     * A FRESH config object, not the refused one (wp3 A-gate): the route
     * mutates the in-memory config before persistence, so the refused object
     * already reads disabled and would short-circuit at the idempotent guard
     * without ever re-acquiring the lock.
     */
    const retry = await putReal(baseConfig({ claudeCode: { enabled: true } }));
    expect(retry!.status).toBe(200);
    const retryBody = await retry!.json() as { changed: boolean; state: string };
    expect(retryBody.changed).toBe(true);
    expect(retryBody.state).toBe("absent");
  } finally {
    try { holder.exec("ROLLBACK"); } catch { /* already closed */ }
    try { holder.close(); } catch { /* already closed */ }
    if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = previousHome;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

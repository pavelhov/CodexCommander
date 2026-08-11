import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAccessCommand } from "../src/cli/access";
import { handleAgentCommand } from "../src/cli/agent";
import { handleComboCommand } from "../src/cli/combo";
import { handleConfigCommand } from "../src/cli/config-command";
import { handleClientIntegrationCommand, handleGrokCommand } from "../src/cli/integrations";
import { handleModelsRuntimeCommand } from "../src/cli/models-runtime";
import { handleObserveCommand } from "../src/cli/observe";
import { handleProviderRuntimeCommand } from "../src/cli/provider-runtime";
import { handleSystemCommand, SYSTEM_USAGE } from "../src/cli/system-command";

type Recorded = { path: string; method: string; body: unknown };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  process.exitCode = 0;
});

function fakeRuntime(responder?: (req: Request, body: unknown) => unknown) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      requests.push({ path: `${url.pathname}${url.search}`, method: req.method, body });
      const custom = responder?.(req, body);
      if (custom !== undefined) return Response.json(custom);
      return Response.json({ ok: true });
    },
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    requests,
    deps: {
      baseUrl,
      attestLiveManagementProxyImpl: async () => ({
        pid: 4242,
        port: server.port,
        hostname: "127.0.0.1",
        source: "runtime" as const,
        baseUrl,
      }),
    },
  };
}

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.[jt]sx?$/.test(name) ? [path] : [];
  });
}

describe("headless GUI parity CLI", () => {
  test("observe logs accepts only the current logs envelope", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const current = fakeRuntime(() => ({
        timeZone: "America/New_York",
        total: 1,
        logs: [{ id: "req-1", timestamp: "2026-08-09T12:00:00.000Z", status: 200 }],
      }));
      expect(await handleObserveCommand(["logs", "--json"], current.deps)).toBe(0);

      for (const stale of [
        [{ id: "req-1" }],
        { entries: [{ id: "req-1" }] },
        { requests: [{ id: "req-1" }] },
        { logs: [{ id: "req-1" }] },
      ]) {
        const runtime = fakeRuntime(() => stale);
        expect(await handleObserveCommand(["logs", "--json"], runtime.deps)).toBe(1);
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("system update is unknown and performs no management request", async () => {
    let fetchCalls = 0;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await handleSystemCommand(["update"], {
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: (() => {
          fetchCalls += 1;
          throw new Error("unexpected updater request");
        }) as typeof fetch,
      });
      expect(code).toBe(2);
      expect(fetchCalls).toBe(0);
      expect(errorSpy.mock.calls.map(call => String(call[0])).join("\n"))
        .toContain("unknown system command update");
      expect(SYSTEM_USAGE).not.toContain("update");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("every GUI management endpoint belongs to a documented CLI resource", () => {
    const guiRoot = join(import.meta.dir, "..", "gui", "src");
    const endpoints = new Set<string>();
    for (const path of sourceFiles(guiRoot)) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/\/api\/[A-Za-z0-9_./-]+/g)) {
        endpoints.add(match[0].replace(/\.+$/, "").replace(/\/$/, ""));
      }
    }
    const coverage: Array<[string, string]> = [
      ["/api/claude-code", "ccx claude config"],
      ["/api/claude-desktop", "ccx claude desktop"],
      ["/api/claude/", "ccx observe"],
      ["/api/codex-auth", "ccx account"],
      ["/api/oauth", "ccx account"],
      ["/api/providers/keys", "ccx account"],
      ["/api/providers", "ccx provider"],
      ["/api/provider-", "ccx provider/models"],
      ["/api/selected-models", "ccx models"],
      ["/api/custom-models", "ccx models"],
      ["/api/model", "ccx models"],
      ["/api/combos", "ccx combo"],
      ["/api/client-config", "ccx export"],
      ["/api/client-integrations", "ccx integration client"],
      // GUI-only for now: the overview card switches for Claude Code and Grok.
      // Their effect is already reachable from the CLI by other names —
      // `ccx grok apply` regenerates the fence and `ccx stop` strips it, and
      // the Claude flag flips through `ccx claude config` — so a dedicated
      // `ccx integration native` verb would duplicate existing commands rather
      // than add a capability. Listed so the sweep stays exhaustive.
      ["/api/native-integrations", "(none — GUI-only)"],
      ["/api/debug", "ccx debug/observe"],
      ["/api/diagnostics", "ccx system"],
      ["/api/effort", "ccx agent"],
      // The fragment exchange is the browser half of `ccx gui`; it consumes the
      // one-time launcher ticket and is not a standalone headless operation.
      ["/api/gui-launch-exchange", "ccx gui (browser handoff)"],
      ["/api/grok", "ccx grok"],
      ["/api/injection", "ccx agent"],
      ["/api/integrations/opencode", "ccx opencode"],
      ["/api/keys", "ccx access"],
      ["/api/logs", "ccx observe"],
      // Short-lived proxy request leases are advisory UI telemetry. Persistent
      // request history remains available through `ccx observe logs`.
      ["/api/agent-activity", "ccx observe logs"],
      ["/api/config", "ccx config"],
      ["/api/settings", "ccx system"],
      // Routing Intelligence (RI-04..RI-10): profiles + dry-run are mirrored by
      // `ccx route policy`. Analytics is GUI-first for now; the same request
      // history remains available through observe/index tooling.
      ["/api/routing-profiles", "ccx route policy"],
      ["/api/routing-analytics", "(none — GUI analytics surface; history via ccx observe/logs)"],
      ["/api/shadow", "ccx models"],
      ["/api/sidecar", "ccx agent"],
      ["/api/startup", "ccx system"],
      ["/api/stop", "ccx stop"],
      ["/api/storage", "ccx observe"],
      ["/api/subagent", "ccx agent"],
      ["/api/codex-catalog", "ccx system sync --restart-codex"],
      ["/api/sync", "ccx system sync"],
      ["/api/system", "ccx observe/system"],
      ["/api/usage", "ccx observe usage"],
      ["/api/v2", "ccx v2/agent"],
      ["/api/windows-tray", "ccx tray"],
    ];
    const uncovered = [...endpoints].filter(endpoint => !coverage.some(([prefix]) => endpoint === prefix || endpoint.startsWith(prefix)));
    expect(uncovered).toEqual([]);
  });

  test("provider edit reuses the management provider patch", async () => {
    const runtime = fakeRuntime();
    const code = await handleProviderRuntimeCommand("edit", [
      "ark", "--base-url", "https://example.test/v1", "--api-key-transport", "bearer", "--enabled", "off", "--live-models", "on", "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{
      path: "/api/providers?name=ark",
      method: "PATCH",
      body: { baseUrl: "https://example.test/v1", apiKeyTransport: "bearer", disabled: true, liveModels: true },
    }]);
  });

  test("provider edit --headers sends the parsed block and - clears it", async () => {
    const runtime = fakeRuntime();
    const code = await handleProviderRuntimeCommand("edit", [
      "agw", "--headers", '{"x-app":"cli","anthropic-version":"2023-06-01"}', "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{
      path: "/api/providers?name=agw",
      method: "PATCH",
      body: { headers: { "x-app": "cli", "anthropic-version": "2023-06-01" } },
    }]);

    const clearRuntime = fakeRuntime();
    const clearCode = await handleProviderRuntimeCommand("edit", ["agw", "--headers", "-", "--json"], clearRuntime.deps);
    expect(clearCode).toBe(0);
    expect(clearRuntime.requests[0]?.body).toEqual({ headers: null });
  });

  test("provider edit rejects malformed --headers JSON without a request", async () => {
    const runtime = fakeRuntime();
    const code = await handleProviderRuntimeCommand("edit", ["agw", "--headers", "{not json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);

    const arrayRuntime = fakeRuntime();
    const arrayCode = await handleProviderRuntimeCommand("edit", ["agw", "--headers", '["x-app"]'], arrayRuntime.deps);
    expect(arrayCode).toBe(2);
    expect(arrayRuntime.requests).toEqual([]);
  });

  test("provider edit usage errors redact --headers values", async () => {
    const errorSpy = spyOn(console, "error");
    try {
      // `--headers={...}` is not consumed by takeOption, so the value lands in the
      // leftovers rejectArgs reports. Header values can carry tokens, so they must
      // never be echoed to stderr.
      const runtime = fakeRuntime();
      const code = await handleProviderRuntimeCommand(
        "edit",
        ["agw", "--headers={\"x-app\":\"cli\",\"X-Token\":\"sk-leak-value\"}"],
        runtime.deps,
      );
      expect(code).toBe(2);
      expect(runtime.requests).toEqual([]);
      const stderr = errorSpy.mock.calls.map(call => String(call[0])).join("\n");
      expect(stderr).toContain("--headers=<redacted>");
      expect(stderr).not.toContain("sk-leak-value");
      expect(stderr).not.toContain("X-Token");

      errorSpy.mockClear();
      // Repeating the option leaves the second flag AND its value in the leftovers.
      const repeatRuntime = fakeRuntime();
      const repeatCode = await handleProviderRuntimeCommand(
        "edit",
        ["agw", "--headers", "{\"X-Token\":\"sk-leak-value\"}", "--headers", "{\"X-Other\":\"v\"}"],
        repeatRuntime.deps,
      );
      expect(repeatCode).toBe(2);
      const repeatStderr = errorSpy.mock.calls.map(call => String(call[0])).join("\n");
      expect(repeatStderr).toContain("--headers <redacted>");
      expect(repeatStderr).not.toContain("sk-leak-value");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("provider test treats a static catalog as neutral", async () => {
    const runtime = fakeRuntime(() => ({ applicable: false, reason: "static_catalog", latencyMs: 0 }));
    const code = await handleProviderRuntimeCommand("test", ["google-antigravity", "--json"], runtime.deps);
    expect(code).toBe(0);
    expect(process.exitCode).not.toBe(1);
    expect(runtime.requests).toEqual([{
      path: "/api/providers/test?name=google-antigravity",
      method: "POST",
      body: null,
    }]);
  });

  test("model context all maps to the atomic GUI endpoint", async () => {
    const runtime = fakeRuntime();
    const code = await handleModelsRuntimeCommand("context", ["all", "on", "--json"], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]).toEqual({ path: "/api/provider-context-caps", method: "PUT", body: { setAll: true } });
  });

  test("combo set parses ordered weighted targets", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand([
      "set", "fast", "--targets", "ark/model-a:2,openai/gpt-5.5", "--strategy", "failover", "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]?.body).toEqual({
      id: "fast",
      combo: {
        strategy: "failover",
        stickyLimit: 1,
        targets: [
          { provider: "ark", model: "model-a", weight: 2 },
          { provider: "openai", model: "gpt-5.5" },
        ],
      },
    });
  });

  test("combo set forwards the explicit native-alias compatibility contract", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand([
      "set", "nova-sol",
      "--targets", "Nova1/codex/gpt-5.6-sol",
      "--alias", "gpt-5.6-sol",
      "--native-alias",
      "--display-name", "Nova1 - codex-gpt-5.6-sol",
      "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]?.body).toMatchObject({
      id: "nova-sol",
      combo: {
        alias: "gpt-5.6-sol",
        nativeAlias: true,
        displayName: "Nova1 - codex-gpt-5.6-sol",
        targets: [{ provider: "Nova1", model: "codex/gpt-5.6-sol" }],
      },
    });
  });

  test("agent effort and roster use the same live mutation routes as GUI", async () => {
    const runtime = fakeRuntime();
    expect(await handleAgentCommand(["effort", "set", "--main", "high", "--subagent", "medium", "--json"], runtime.deps)).toBe(0);
    expect(await handleAgentCommand(["subagents", "set", "a/model,b/model", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests.map(row => [row.path, row.body])).toEqual([
      ["/api/effort-caps", { effortCap: "high", subagentEffortCap: "medium" }],
      ["/api/subagent-models", { models: ["a/model", "b/model"] }],
    ]);
  });

  test("API key create returns the one-time key through the access command", async () => {
    const runtime = fakeRuntime((req) => new URL(req.url).pathname === "/api/keys"
      ? { id: "key-1", name: "deploy", key: "ccx_secret" }
      : undefined);
    expect(await handleAccessCommand(["key", "create", "deploy", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests[0]).toEqual({ path: "/api/keys", method: "POST", body: { name: "deploy" } });
  });

  test("Grok include edits the persisted exclusion set before apply", async () => {
    const runtime = fakeRuntime((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/grok" && req.method === "GET") return { excluded: ["a", "b"] };
      return undefined;
    });
    expect(await handleGrokCommand(["include", "a", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests[1]).toEqual({ path: "/api/grok/selection", method: "PUT", body: { excluded: ["b"] } });
  });

  test("client integration toggles hit the exact management routes", async () => {
    const runtime = fakeRuntime();
    expect(await handleClientIntegrationCommand(["enable", "--client", "hermes", "--json"], runtime.deps)).toBe(0);
    expect(await handleClientIntegrationCommand(["disable", "--client", "hermes", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests.map(row => [row.path, row.method, row.body])).toEqual([
      ["/api/client-integrations/hermes", "PUT", { enabled: true }],
      ["/api/client-integrations/hermes", "PUT", { enabled: false }],
    ]);
  });

  test("restore refuses to guess about drift, and forwards the confirmation when given", async () => {
    /*
     * Replacing edits a user made after the snapshot is their decision, so the
     * flag has to travel exactly as typed. Defaulting it to true would make
     * the headless path quietly more destructive than the GUI.
     */
    const runtime = fakeRuntime();
    expect(await handleClientIntegrationCommand(["restore", "--op", "op-1", "--json"], runtime.deps)).toBe(0);
    expect(await handleClientIntegrationCommand(
      ["restore", "--op", "op-1", "--confirm-drift", "--json"],
      runtime.deps,
    )).toBe(0);
    expect(runtime.requests.map(row => row.body)).toEqual([
      { opId: "op-1", confirmDrift: false },
      { opId: "op-1", confirmDrift: true },
    ]);
  });

  test("a client integration command without its required target fails instead of guessing", async () => {
    const runtime = fakeRuntime();
    // No `--client`: picking one for the user would write a config they never named.
    expect(await handleClientIntegrationCommand(["enable", "--json"], runtime.deps)).not.toBe(0);
    expect(await handleClientIntegrationCommand(["restore", "--json"], runtime.deps)).not.toBe(0);
    expect(runtime.requests).toEqual([]);
  });

  test("config set validates the complete candidate before the atomic write", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccx-cli-config-"));
    const previous = process.env.CODEXCOMMANDER_HOME;
    process.env.CODEXCOMMANDER_HOME = home;
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({
        port: 10100,
        multiAgentGuidanceEnabled: true,
        providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
        defaultProvider: "openai",
      }));
      expect(await handleConfigCommand(["set", "codexAutoStart", "false", "--json"])).toBe(0);
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).codexAutoStart).toBe(false);
      expect(await handleConfigCommand(["set", "port", "-1", "--json"])).not.toBe(0);
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).port).toBe(10100);
    } finally {
      if (previous === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("config set and import reject an invalid app-owned memory budget without persisting the normalized default", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccx-cli-memory-budget-"));
    const previous = process.env.CODEXCOMMANDER_HOME;
    process.env.CODEXCOMMANDER_HOME = home;
    try {
      const configPath = join(home, "config.json");
      const importPath = join(home, "invalid-import.json");
      const original = JSON.stringify({
        port: 10100,
        multiAgentGuidanceEnabled: true,
        providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
        defaultProvider: "openai",
        appOwnedMemoryBudgetMb: 128,
      });
      writeFileSync(configPath, original);
      writeFileSync(importPath, JSON.stringify({
        ...JSON.parse(original),
        appOwnedMemoryBudgetMb: 4097,
      }));

      expect(await handleConfigCommand(["set", "appOwnedMemoryBudgetMb", "63", "--json"])).not.toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(await handleConfigCommand(["import", importPath, "--yes", "--json"])).not.toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(original);
    } finally {
      if (previous === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("config set refuses an invalid existing file instead of rebuilding it from defaults", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccx-cli-invalid-config-"));
    const previous = process.env.CODEXCOMMANDER_HOME;
    process.env.CODEXCOMMANDER_HOME = home;
    const configPath = join(home, "config.json");
    const invalid = "{ not json";
    try {
      writeFileSync(configPath, invalid);
      expect(await handleConfigCommand(["set", "port", "10101", "--json"])).not.toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(invalid);
    } finally {
      if (previous === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("config set releases the manual pin when it writes the selection order", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccx-cli-priority-pin-"));
    const previous = process.env.CODEXCOMMANDER_HOME;
    process.env.CODEXCOMMANDER_HOME = home;
    const configPath = join(home, "config.json");
    const base = {
      port: 10100,
      multiAgentGuidanceEnabled: true,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      defaultProvider: "openai",
      activeCodexAccountPinned: "work",
    };
    const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
    const readPin = () => readConfig().activeCodexAccountPinned;
    try {
      // The whole map, one entry, and a removal are all the operator restating the
      // order, so each releases the pin -- otherwise it keeps capping the tier
      // ceiling at "work" and the order just written has no visible effect.
      for (const { argv, expected } of [
        { argv: ["set", "codexAccountPriorities", '{"work":1}'], expected: { work: 1 } },
        { argv: ["set", "codexAccountPriorities.work", "2"], expected: { work: 2 } },
        { argv: ["unset", "codexAccountPriorities"], expected: undefined },
      ]) {
        writeFileSync(configPath, JSON.stringify({ ...base, codexAccountPriorities: { work: 0 } }));
        expect(await handleConfigCommand([...argv, "--json"])).toBe(0);
        expect(readPin()).toBeUndefined();
        expect(readConfig().codexAccountPriorities).toEqual(expected);
      }

      // An unrelated field is not a statement about ordering, so the pin survives.
      writeFileSync(configPath, JSON.stringify({ ...base, codexAccountPriorities: { work: 1 } }));
      expect(await handleConfigCommand(["set", "autoSwitchThreshold", "50", "--json"])).toBe(0);
      expect(readPin()).toBe("work");
    } finally {
      if (previous === undefined) delete process.env.CODEXCOMMANDER_HOME;
      else process.env.CODEXCOMMANDER_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

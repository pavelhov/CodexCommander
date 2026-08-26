import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getConfigPath,
  getDefaultConfig,
  saveConfig,
  setPersistedConfigMutationBeforeCommitForTests,
} from "../src/config";
import { handleManagementAPI, type ManagementApiDeps } from "../src/server/management-api";
import {
  setGrokApplyFlightTestHooks,
} from "../src/server/management/agent-settings-routes";
import type { ProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
import type { CodexCommanderConfig } from "../src/types";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";

type Surface = {
  readonly name: string;
  readonly path: string;
  readonly body: unknown;
  readonly prepare?: (config: CodexCommanderConfig) => void;
  readonly expectedWork: readonly string[];
};

const surfaces: readonly Surface[] = [
  {
    name: "multi-agent settings",
    path: "/api/v2",
    body: { multiAgentMode: "default" },
    prepare: config => { config.multiAgentMode = "v2"; },
    expectedWork: ["save", "converge"],
  },
  {
    name: "request-user-input feature",
    path: "/api/codex-auth/features/default-mode-request-user-input",
    body: { enabled: true },
    expectedWork: ["toggle-default-mode-request-user-input"],
  },
  {
    name: "native subagent defaults",
    path: "/api/injection-model",
    body: { model: "gpt-5.6-terra" },
    prepare: config => {
      config.injectionModel = "gpt-5.6-sol";
      config.syncCodexSubagentDefaults = true;
    },
    expectedWork: ["save", "reconcile-native-defaults"],
  },
  {
    name: "subagent roster",
    path: "/api/subagent-models",
    body: { models: ["gpt-5.6-terra"] },
    expectedWork: ["save", "converge", "sync-claude-agents"],
  },
  {
    name: "Grok apply",
    path: "/api/grok/apply",
    body: undefined,
    expectedWork: ["apply-grok"],
  },
];

const savedCommanderHome = process.env.CODEXCOMMANDER_HOME;
const savedCodexHome = process.env.CODEX_HOME;
let commanderHome = "";
let codexHome = "";

beforeEach(() => {
  commanderHome = mkdtempSync(join(tmpdir(), "ccx-agent-settings-lifecycle-"));
  codexHome = mkdtempSync(join(tmpdir(), "ccx-agent-settings-codex-"));
  process.env.CODEXCOMMANDER_HOME = commanderHome;
  process.env.CODEX_HOME = codexHome;
  writeFileSync(join(codexHome, "config.toml"), "[features]\ndefault_mode_request_user_input = false\n");
});

afterEach(() => {
  setGrokApplyFlightTestHooks(null);
  setPersistedConfigMutationBeforeCommitForTests(null);
  if (savedCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = savedCommanderHome;
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  rmSync(commanderHome, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function lifecycleAuthority(
  events: string[],
  held: { ensure: boolean; start: boolean },
): ProxyLifecycleAuthority {
  const authority: ProxyLifecycleAuthority = {
    deadlineAt: Number.POSITIVE_INFINITY,
    ensure: { token: "ensure", release: () => authority.releaseAll() },
    get start() {
      return held.start
        ? { token: "start", release: () => authority.releaseStart() }
        : undefined;
    },
    acquireStart: async () => authority.start!,
    delegatedLease: () => held.ensure && held.start
      ? { ensureToken: "ensure", startToken: "start" }
      : undefined,
    releaseStart: () => {
      if (!held.start) return;
      events.push("release-S");
      held.start = false;
    },
    releaseAll: () => {
      authority.releaseStart();
      if (!held.ensure) return;
      events.push("release-E");
      held.ensure = false;
    },
  };
  return authority;
}

function configFor(surface: Surface): CodexCommanderConfig {
  const config = getDefaultConfig();
  config.clientIntegrations = { "claude-desktop": false };
  surface.prepare?.(config);
  saveConfig(config);
  return config;
}

function requestFor(surface: Surface): Request {
  return new Request(`http://127.0.0.1${surface.path}`, {
    method: surface.path === "/api/grok/apply" ? "POST" : "PUT",
    headers: {
      Host: "127.0.0.1",
      ...(surface.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: surface.body === undefined ? undefined : JSON.stringify(surface.body),
  });
}

function mutationDeps(
  events: string[],
  assertHeld: () => void,
): ManagementApiDeps {
  const record = (name: string): void => {
    assertHeld();
    events.push(name);
  };
  return {
    saveConfigPreservingClaudeCode: () => { record("save"); },
    toggleDefaultModeRequestUserInput: enabled => {
      record("toggle-default-mode-request-user-input");
      writeFileSync(
        join(codexHome, "config.toml"),
        `[features]\ndefault_mode_request_user_input = ${enabled}\n`,
      );
    },
    reconcileManagementNativeSubagentDefaults: async () => {
      record("reconcile-native-defaults");
      return { status: "skipped", reason: "routing-not-owned" };
    },
    createManagementConvergeCodex: catalogConvergenceFactory(() => { record("converge"); }),
    syncClaudeAgentDefsBestEffort: () => { record("sync-claude-agents"); },
    resetCodexAppServerCatalogStateCache: () => {},
    collectCodexAppServerCatalogState: () => ({
      state: "not_running",
      processes: [],
      catalogMtimeMs: null,
    }),
    catalogArtifactProofForActivation: () => "not-required",
    codexRoutingKindForActivation: () => "native",
  };
}

describe("agent settings lifecycle authority", () => {
  for (const surface of surfaces) {
    test(`${surface.name} refusal is retryable and makes zero mutations`, async () => {
      const config = configFor(surface);
      const before = structuredClone(config);
      const events: string[] = [];
      const deps = mutationDeps(events, () => {
        throw new Error("mutation ran without lifecycle authority");
      });
      deps.proxyStopLifecycle = {
        acquireAuthority: async options => {
          events.push(`acquire:${String(options?.includeStart)}`);
          throw new Error("private lock path and token must never cross the API");
        },
      };
      setGrokApplyFlightTestHooks({
        run: async () => {
          events.push("apply-grok");
          return { ok: true, changed: false, message: "ok" };
        },
      });

      const request = requestFor(surface);
      const response = await handleManagementAPI(request, new URL(request.url), config, deps);

      expect(response?.status).toBe(409);
      expect(response?.headers.get("Retry-After")).toBe("1");
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      expect(await response?.json()).toEqual({
        error: "Proxy lifecycle is busy; no Codex or Grok settings were changed.",
        reason: "config_busy",
        retryable: true,
      });
      expect(events).toEqual(["acquire:true"]);
      expect(config).toEqual(before);
    });

    test(`${surface.name} waits for E then S and releases S then E after convergence`, async () => {
      const config = configFor(surface);
      const before = structuredClone(config);
      const events: string[] = [];
      const held = { ensure: false, start: false };
      const acquisitionStarted = deferred<void>();
      const admission = deferred<ProxyLifecycleAuthority>();
      const deps = mutationDeps(events, () => {
        expect(held).toEqual({ ensure: true, start: true });
      });
      deps.proxyStopLifecycle = {
        acquireAuthority: async options => {
          events.push(`acquire:${String(options?.includeStart)}`);
          acquisitionStarted.resolve();
          return admission.promise;
        },
      };
      setGrokApplyFlightTestHooks({
        run: async () => {
          expect(held).toEqual({ ensure: true, start: true });
          events.push("apply-grok");
          return { ok: true, changed: false, message: "ok" };
        },
      });

      const request = requestFor(surface);
      const pending = handleManagementAPI(request, new URL(request.url), config, deps);
      await acquisitionStarted.promise;
      expect(events).toEqual(["acquire:true"]);
      expect(config).toEqual(before);

      held.ensure = true;
      held.start = true;
      admission.resolve(lifecycleAuthority(events, held));
      const response = await pending;

      expect(response?.status).toBe(200);
      expect(events).toEqual([
        "acquire:true",
        ...surface.expectedWork,
        "release-S",
        "release-E",
      ]);
      expect(held).toEqual({ ensure: false, start: false });
    });
  }
});

function rosterRequest(body?: unknown): Request {
  return new Request("http://127.0.0.1/api/subagent-models", {
    method: body === undefined ? "GET" : "PUT",
    headers: { Host: "127.0.0.1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rosterPatchRequest(body: unknown): Request {
  return new Request("http://127.0.0.1/api/subagent-models", {
    method: "PATCH",
    headers: { Host: "127.0.0.1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rosterApiDeps(events: string[]): ManagementApiDeps {
  return {
    saveConfigPreservingClaudeCode: () => { events.push("save"); },
    createManagementConvergeCodex: catalogConvergenceFactory(() => { events.push("converge"); }),
    syncClaudeAgentDefsBestEffort: () => { events.push("sync-claude-agents"); },
    fetchAllModels: async () => [],
    visibleNativeSlugs: () => [],
    resetCodexAppServerCatalogStateCache: () => {},
    collectCodexAppServerCatalogState: () => ({
      state: "not_running",
      processes: [],
      catalogMtimeMs: null,
    }),
    catalogArtifactProofForActivation: () => "not-required",
    codexRoutingKindForActivation: () => "native",
  };
}

async function putSubagentModels(
  config: CodexCommanderConfig,
  deps: ManagementApiDeps,
  body: unknown,
): Promise<Response> {
  const request = rosterRequest(body);
  return (await handleManagementAPI(request, new URL(request.url), config, deps))!;
}

async function patchSubagentModels(
  config: CodexCommanderConfig,
  deps: ManagementApiDeps,
  body: unknown,
): Promise<Response> {
  const request = rosterPatchRequest(body);
  return (await handleManagementAPI(request, new URL(request.url), config, deps))!;
}

async function getSubagentModels(
  config: CodexCommanderConfig,
  deps: ManagementApiDeps,
): Promise<Record<string, unknown>> {
  const request = rosterRequest();
  const response = await handleManagementAPI(request, new URL(request.url), config, deps);
  expect(response?.status).toBe(200);
  return await response!.json() as Record<string, unknown>;
}

describe("subagent roster management API", () => {
  test("PATCH guidance changes one row on the newest roster after a concurrent edit", async () => {
    const config = getDefaultConfig();
    config.subagentModels = [
      { model: "gpt-5.6-luna", guidance: "Old note" },
      { model: "xai/grok-4.6" },
    ];
    saveConfig(config);
    const deps = rosterApiDeps([]);
    delete deps.saveConfigPreservingClaudeCode;

    setPersistedConfigMutationBeforeCommitForTests(() => {
      const competing = structuredClone(config);
      competing.subagentModels = [
        { model: "xai/grok-4.6", guidance: "Concurrent note" },
        { model: "gpt-5.6-luna", guidance: "Old note" },
      ];
      writeFileSync(getConfigPath(), JSON.stringify(competing));
    });

    const response = await patchSubagentModels(config, deps, {
      model: "gpt-5.6-luna",
      guidance: "Updated note",
    });

    expect(response.status).toBe(200);
    expect((await response.json() as Record<string, unknown>).roster).toEqual([
      { model: "xai/grok-4.6", guidance: "Concurrent note" },
      { model: "gpt-5.6-luna", guidance: "Updated note" },
    ]);
  });

  test("PATCH guidance keeps the roster validation and unknown-model contract", async () => {
    const config = getDefaultConfig();
    saveConfig(config);
    const deps = rosterApiDeps([]);
    const unsafe = await patchSubagentModels(config, deps, {
      model: "gpt-5.6-luna",
      guidance: "review\nlater",
    });
    expect(unsafe.status).toBe(400);
    expect((await unsafe.json() as { error: string }).error).toContain("unsafe");

    const unknown = await patchSubagentModels(config, deps, {
      model: "missing/model",
      guidance: "Review",
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { error: string }).error).toContain("missing/model");
  });

  test("PATCH guidance is idempotent when setting the existing note or clearing an empty note", async () => {
    const config = getDefaultConfig();
    config.subagentModels = [
      { model: "gpt-5.6-luna", guidance: "Already set" },
      { model: "xai/grok-4.6" },
    ];
    saveConfig(config);
    const deps = rosterApiDeps([]);
    delete deps.saveConfigPreservingClaudeCode;

    const same = await patchSubagentModels(config, deps, {
      model: "gpt-5.6-luna",
      guidance: "Already set",
    });
    expect(same.status).toBe(200);
    expect((await same.json() as Record<string, unknown>).roster).toEqual(config.subagentModels);

    const clear = await patchSubagentModels(config, deps, {
      model: "xai/grok-4.6",
      guidance: null,
    });
    expect(clear.status).toBe(200);
    expect((await clear.json() as Record<string, unknown>).roster).toEqual(config.subagentModels);
  });

  test("PUT roster round-trips guidance while GET retains the chosen id projection", async () => {
    const config = getDefaultConfig();
    const events: string[] = [];
    const deps = rosterApiDeps(events);

    const response = await putSubagentModels(config, deps, {
      roster: [
        { model: "xai/grok-4.6", guidance: "Use for independent review" },
        { model: "gpt-5.6-luna" },
      ],
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.applied).toEqual(["xai/grok-4.6", "gpt-5.6-luna"]);
    expect(body.roster).toEqual([
      { model: "xai/grok-4.6", guidance: "Use for independent review" },
      { model: "gpt-5.6-luna" },
    ]);
    const got = await getSubagentModels(config, deps);
    expect(got.chosen).toEqual(["xai/grok-4.6", "gpt-5.6-luna"]);
    expect(got.roster).toEqual([
      { model: "xai/grok-4.6", guidance: "Use for independent review" },
      { model: "gpt-5.6-luna" },
    ]);
  });

  test("PUT models preserves guidance while changing roster order", async () => {
    const config = getDefaultConfig();
    const events: string[] = [];
    const deps = rosterApiDeps(events);
    await putSubagentModels(config, deps, {
      roster: [
        { model: "xai/grok-4.6", guidance: "Review" },
        { model: "gpt-5.6-luna" },
      ],
    });

    const response = await putSubagentModels(config, deps, {
      models: ["gpt-5.6-luna", "xai/grok-4.6"],
    });

    expect(response.status).toBe(200);
    expect((await response.json() as Record<string, unknown>).roster).toEqual([
      { model: "gpt-5.6-luna" },
      { model: "xai/grok-4.6", guidance: "Review" },
    ]);
  });

  test("guidance-only PUT persists without catalog convergence or Claude sync", async () => {
    const config = getDefaultConfig();
    const events: string[] = [];
    const deps = rosterApiDeps(events);
    await putSubagentModels(config, deps, { models: ["gpt-5.6-luna"] });
    events.length = 0;

    const response = await putSubagentModels(config, deps, {
      roster: [{ model: "gpt-5.6-luna", guidance: "Fast mechanical work" }],
    });

    expect(response.status).toBe(200);
    expect(events).toEqual(["save"]);
    expect((await response.json() as Record<string, unknown>).roster).toEqual([
      { model: "gpt-5.6-luna", guidance: "Fast mechanical work" },
    ]);
  });

  test("PUT rejects ambiguous or unsafe roster payloads", async () => {
    const config = getDefaultConfig();
    const deps = rosterApiDeps([]);
    const cases: readonly [string, unknown][] = [
      ["both selector forms", { models: ["gpt-5.6-luna"], roster: [{ model: "gpt-5.6-luna" }] }],
      ["missing selector form", {}],
      ["more than five entries", { roster: ["a", "b", "c", "d", "e", "f"].map(model => ({ model })) }],
      ["duplicate models", { roster: [{ model: "gpt-5.6-luna" }, { model: "gpt-5.6-luna" }] }],
      ["non-canonical selector", { roster: [{ model: "openai/default/gpt-5.6-luna" }] }],
      ["tag guidance", { roster: [{ model: "gpt-5.6-luna", guidance: "<tag>" }] }],
      ["line separator", { roster: [{ model: "gpt-5.6-luna", guidance: "review\u2028later" }] }],
      ["paragraph separator", { roster: [{ model: "gpt-5.6-luna", guidance: "review\u2029later" }] }],
      ["right-to-left override", { roster: [{ model: "gpt-5.6-luna", guidance: "review\u202elater" }] }],
      ["carriage return", { roster: [{ model: "gpt-5.6-luna", guidance: "review\rlater" }] }],
      ["line feed", { roster: [{ model: "gpt-5.6-luna", guidance: "review\nlater" }] }],
      ["token-shaped guidance", { roster: [{ model: "gpt-5.6-luna", guidance: "sk-abcdefgh" }] }],
      ["161 Unicode code points", { roster: [{ model: "gpt-5.6-luna", guidance: "😀".repeat(161) }] }],
    ];

    for (const [, body] of cases) {
      const response = await putSubagentModels(config, deps, body);
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("roster");
    }
  });

  test("PUT canonicalizes blank, NFC, and exact-boundary guidance", async () => {
    const config = getDefaultConfig();
    const deps = rosterApiDeps([]);

    const blank = await putSubagentModels(config, deps, {
      roster: [{ model: "gpt-5.6-luna", guidance: " \t " }],
    });
    expect(blank.status).toBe(200);
    expect((await blank.json() as Record<string, unknown>).roster).toEqual([
      { model: "gpt-5.6-luna" },
    ]);

    const boundary = await putSubagentModels(config, deps, {
      roster: [{ model: "gpt-5.6-luna", guidance: ` e\u0301${"😀".repeat(159)} ` }],
    });
    expect(boundary.status).toBe(200);
    expect((await boundary.json() as Record<string, unknown>).roster).toEqual([
      { model: "gpt-5.6-luna", guidance: `\u00e9${"😀".repeat(159)}` },
    ]);
  });
});

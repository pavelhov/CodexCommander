import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDefaultConfig, saveConfig } from "../src/config";
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

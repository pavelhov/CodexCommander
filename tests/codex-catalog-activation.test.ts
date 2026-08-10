import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CodexCatalogDesiredSnapshot,
  codexCatalogDesiredRevision,
  codexCatalogActivationFenceMtimeMs,
  inspectCodexCatalogActivation,
} from "../src/codex/catalog-activation";
import type { CatalogConfigAuthoritySnapshot } from "../src/codex/catalog-admission";
import {
  handleCatalogActivationRoutes,
  resetCatalogApplyFlightForTests,
} from "../src/server/management/catalog-activation-routes";
import { handleAgentSettingsRoutes } from "../src/server/management/agent-settings-routes";
import type { ManagementContext } from "../src/server/management/context";
import type { CodexCommanderConfig } from "../src/types";

let previousCodexHome: string | undefined;
let codexHome = "";

function config(overrides: Partial<CodexCommanderConfig> = {}): CodexCommanderConfig {
  return {
    port: 10100,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-responses",
        baseUrl: "http://127.0.0.1:10100/v1",
        models: ["gpt-5.6-luna"],
      },
    },
    subagentModels: ["gpt-5.6-luna"],
    ...overrides,
  } as CodexCommanderConfig;
}

function writeCatalog(multiAgentVersion: "v1" | "v2" = "v2"): void {
  writeFileSync(join(codexHome, "codexcommander-catalog.json"), JSON.stringify({
    models: [{
      slug: "gpt-5.6-luna",
      display_name: "Luna",
      visibility: "list",
      priority: 0,
      multi_agent_version: multiAgentVersion,
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
    }],
  }));
}

function desiredSnapshot(
  cfg: CodexCommanderConfig,
  generation: number,
  semanticIdentity = "same-semantic-config",
): CodexCatalogDesiredSnapshot {
  const authority: CatalogConfigAuthoritySnapshot = {
    generation: { value: generation },
    semanticIdentity,
    contentIdentity: "same-config-content",
  };
  return {
    config: cfg,
    authority,
    revision: codexCatalogDesiredRevision(cfg, authority),
  };
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ccx-catalog-activation-"));
  mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  writeFileSync(join(codexHome, "config.toml"), [
    "# Auto-injected by CodexCommander",
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    `model_catalog_json = "${join(codexHome, "codexcommander-catalog.json")}"`,
    "",
  ].join("\n"));
  writeCatalog();
  resetCatalogApplyFlightForTests();
});

afterEach(() => {
  resetCatalogApplyFlightForTests();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
});

describe("Codex catalog activation state", () => {
  test("separates a current disk projection from a stale running worker", () => {
    const state = inspectCodexCatalogActivation(config({ multiAgentMode: "v2" }), {
      state: "stale",
      catalogMtimeMs: 200,
      processes: [{ pid: 10, startedAtMs: 100 }],
    }, undefined, undefined, undefined, "codexcommander-local");

    expect(state).toMatchObject({
      schemaVersion: 1,
      desired: { chosen: ["gpt-5.6-luna"], protocol: "v2" },
      catalog: { status: "current", advertised: ["gpt-5.6-luna"] },
      routing: { status: "current", kind: "codexcommander-local" },
      workers: { status: "reload_required", runningCount: 1, staleCount: 1 },
      apply: { required: true, allowed: true, reason: "reload-required" },
    });
  });

  test("reports both protocol projections instead of hardcoding V2", () => {
    writeCatalog("v1");
    const state = inspectCodexCatalogActivation(config(), {
      state: "not_running",
      catalogMtimeMs: null,
      processes: [],
    }, undefined, undefined, undefined, "codexcommander-local");

    expect(state.catalog.projections.v1.advertised).toEqual(["gpt-5.6-luna"]);
    expect(state.catalog.projections.v2.advertised).toEqual([]);
    expect(state.catalog.projections.v2.excluded).toMatchObject([
      { configured: "gpt-5.6-luna", reason: "surface_incompatible" },
    ]);
    expect(state.catalog.advertised).toEqual(["gpt-5.6-luna"]);
    expect(state.apply).toEqual({ required: false, allowed: false, reason: "no-workers" });
  });

  test("desired revisions are semantic and opaque", () => {
    const left = config();
    const right = {
      providers: left.providers,
      subagentModels: left.subagentModels,
      defaultProvider: left.defaultProvider,
      port: left.port,
    } as CodexCommanderConfig;
    expect(codexCatalogDesiredRevision(left)).toBe(codexCatalogDesiredRevision(right));
    expect(codexCatalogDesiredRevision(left)).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(codexCatalogDesiredRevision(config({ subagentModels: [] })))
      .not.toBe(codexCatalogDesiredRevision(left));
    const beforeBootChange = codexCatalogDesiredRevision(left);
    writeFileSync(join(codexHome, "config.toml"), "[agents]\nmax_threads = 7\n");
    expect(codexCatalogDesiredRevision(left)).not.toBe(beforeBootChange);
  });

  test("the activation fence includes native Codex boot-config changes", () => {
    const catalogPath = join(codexHome, "codexcommander-catalog.json");
    const configPath = join(codexHome, "config.toml");
    utimesSync(catalogPath, 100, 100);
    utimesSync(configPath, 200, 200);
    expect(codexCatalogActivationFenceMtimeMs()).toBe(200_000);
  });

  test("catalog status detects saved roster order that is not reflected on disk", () => {
    writeFileSync(join(codexHome, "codexcommander-catalog.json"), JSON.stringify({
      models: [
        { slug: "fixture/a", visibility: "list", priority: 0, multi_agent_version: "v2" },
        { slug: "fixture/b", visibility: "list", priority: 1, multi_agent_version: "v2" },
      ],
    }));
    const state = inspectCodexCatalogActivation(config({
      multiAgentMode: "v2",
      subagentModels: ["fixture/b", "fixture/a"],
    }), {
      state: "not_running",
      catalogMtimeMs: null,
      processes: [],
    }, undefined, undefined, undefined, "codexcommander-local");

    expect(state.catalog.advertised).toEqual(["fixture/a", "fixture/b"]);
    expect(state.catalog.status).toBe("pending");
  });

  test("a session-only no-op disposition does not dirty a current catalog", () => {
    const state = inspectCodexCatalogActivation(config({ multiAgentMode: "v2" }), {
      state: "not_running",
      catalogMtimeMs: null,
      processes: [],
    }, { status: "skipped", reason: "not-requested", retryable: false }, undefined, undefined, "codexcommander-local");

    expect(state.catalog.status).toBe("current");
  });

  test("mutation-only degradation does not disappear from activation on immediate GET", () => {
    const cfg = config({ multiAgentMode: "v2" });
    const workers = { state: "not_running" as const, catalogMtimeMs: null, processes: [] };
    const mutation = inspectCodexCatalogActivation(cfg, workers, {
      status: "committed",
      changed: false,
      degraded: true,
      notices: ["provider-network"],
    }, undefined, "current", "codexcommander-local");
    const immediateGet = inspectCodexCatalogActivation(
      cfg,
      workers,
      undefined,
      undefined,
      "current",
      "codexcommander-local",
    );

    expect(mutation.catalog.status).toBe("current");
    expect(immediateGet.catalog.status).toBe(mutation.catalog.status);
  });

  test("artifact proof distinguishes unproven startup state from disk drift", () => {
    const cfg = config({ multiAgentMode: "v2" });
    const authority = desiredSnapshot(cfg, 1).authority;
    const workers = { state: "not_running" as const, catalogMtimeMs: null, processes: [] };

    expect(inspectCodexCatalogActivation(cfg, workers, undefined, authority, "unproven", "codexcommander-local").catalog.status)
      .toBe("unknown");
    expect(inspectCodexCatalogActivation(cfg, workers, undefined, authority, "drifted", "codexcommander-local").catalog.status)
      .toBe("pending");
    expect(inspectCodexCatalogActivation(cfg, workers, undefined, authority, "current", "codexcommander-local").catalog.status)
      .toBe("current");
  });

  test("a non-ready catalog remains actionable even with a current or absent worker", () => {
    const cfg = config({ multiAgentMode: "v2" });
    const authority = desiredSnapshot(cfg, 1).authority;
    for (const workers of [
      { state: "fresh" as const, catalogMtimeMs: 200, processes: [{ pid: 10, startedAtMs: 300 }] },
      { state: "not_running" as const, catalogMtimeMs: null, processes: [] },
    ]) {
      const state = inspectCodexCatalogActivation(
        cfg,
        workers,
        undefined,
        authority,
        "unproven",
        "codexcommander-local",
      );
      expect(state.catalog.status).toBe("unknown");
      expect(state.apply).toEqual({ required: true, allowed: true, reason: "catalog-not-ready" });
    }
  });

  test("native routing makes Apply required even when no worker is running", () => {
    writeFileSync(join(codexHome, "config.toml"), `model_catalog_json = "${join(codexHome, "codexcommander-catalog.json")}"\n`);
    const state = inspectCodexCatalogActivation(config({ multiAgentMode: "v2" }), {
      state: "not_running",
      catalogMtimeMs: null,
      processes: [],
    }, undefined, undefined, undefined, "native");

    expect(state.routing).toEqual({ status: "not_injected", kind: "native" });
    expect(state.apply).toEqual({ required: true, allowed: true, reason: "routing-not-injected" });
  });
});

function routeContext(options: {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  principal?: ManagementContext["principal"];
  cfg?: CodexCommanderConfig;
  workerState?: "fresh" | "stale" | "not_running" | "unknown";
  apply?: ManagementContext["deps"]["applyCodexCatalogWorkers"];
  sync?: ManagementContext["deps"]["syncModelsToCodex"];
  converge?: ManagementContext["convergeCodexCatalog"];
  routing?: ManagementContext["deps"]["codexRoutingKindForActivation"];
}): ManagementContext {
  const cfg = options.cfg ?? config({ multiAgentMode: "v2" });
  const state = options.workerState ?? "stale";
  const workerStatus = state === "not_running"
    ? { state, catalogMtimeMs: null, processes: [] }
    : state === "unknown"
      ? { state, catalogMtimeMs: null, processes: [] }
      : {
          state,
          catalogMtimeMs: 200,
          processes: [{ pid: 10, startedAtMs: state === "stale" ? 100 : 300 }],
        };
  const request = new Request(`http://localhost${options.path}`, {
    method: options.method,
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    req: request,
    url: new URL(request.url),
    config: cfg,
    principal: options.principal,
    deps: {
      collectCodexAppServerCatalogState: () => workerStatus,
      resetCodexAppServerCatalogStateCache: () => {},
      loadConfigForCatalogActivation: () => cfg,
      catalogArtifactProofForActivation: () => "current",
      codexRoutingKindForActivation: options.routing ?? (() => "codexcommander-local"),
      readRuntimePort: () => ({ pid: process.pid, port: cfg.port, hostname: "127.0.0.1", startedAt: new Date().toISOString() }),
      syncModelsToCodex: options.sync ?? (async () => ({
        status: "applied",
        ok: true,
        added: 0,
        catalogPath: join(codexHome, "codexcommander-catalog.json"),
        catalogExists: true,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "live",
        rehydrated: 0,
        message: "synchronized",
      })),
      ...(options.apply ? { applyCodexCatalogWorkers: options.apply } : {}),
    },
    convergeCodexCatalog: options.converge ?? (async () => ({
      status: "committed",
      changed: false,
      degraded: false,
      notices: [],
    })),
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

describe("catalog activation management routes", () => {
  test("GET returns the additive no-store activation observation", async () => {
    const response = await handleCatalogActivationRoutes(routeContext({
      method: "GET",
      path: "/api/codex-catalog/status",
    }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toMatchObject({
      activation: {
        workers: { status: "reload_required" },
        apply: { required: true, allowed: false, reason: "confirmed-launch-required" },
      },
    });

    const confirmed = await handleCatalogActivationRoutes(routeContext({
      method: "GET",
      path: "/api/codex-catalog/status",
      principal: "confirmed-gui-session",
    }));
    expect(await confirmed?.json()).toMatchObject({
      activation: { apply: { required: true, allowed: true, reason: "reload-required" } },
    });
  });

  test("POST requires origin-bound GUI consent even with a valid-shaped body", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    for (const principal of ["admin-token", undefined] as const) {
      const response = await handleCatalogActivationRoutes(routeContext({
        method: "POST",
        path: "/api/codex-catalog/apply",
        principal,
        cfg,
        body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      }));
      expect(response?.status).toBe(403);
    }
  });

  test("POST converges, revalidates, and returns only count-level process results", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    let applied = 0;
    const ctx = routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      apply: async revalidate => {
        expect(await revalidate()).toBe(true);
        applied += 1;
        return { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 };
      },
    });
    let observations = 0;
    ctx.deps.collectCodexAppServerCatalogState = () => observations++ === 0
      ? { state: "stale", catalogMtimeMs: 200, processes: [{ pid: 10, startedAtMs: 100 }] }
      : { state: "fresh", catalogMtimeMs: 200, processes: [{ pid: 11, startedAtMs: 300 }] };
    const response = await handleCatalogActivationRoutes(ctx);
    expect(applied).toBe(1);
    expect(response?.status).toBe(200);
    const body = await response?.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      outcome: "applied",
      stoppedWorkerCount: 1,
      survivingWorkerCount: 0,
    });
    expect(JSON.stringify(body)).not.toMatch(/pid|commandLine|catalog-must-not-cross/);
  });

  test("POST repairs native routing before applying and handles an absent worker", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    let routing: "native" | "codexcommander-local" = "native";
    let syncs = 0;
    let applies = 0;
    const response = await handleCatalogActivationRoutes(routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      workerState: "not_running",
      body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      routing: () => routing,
      sync: async () => {
        syncs += 1;
        routing = "codexcommander-local";
        return {
          status: "applied",
          ok: true,
          added: 0,
          catalogPath: join(codexHome, "codexcommander-catalog.json"),
          catalogExists: true,
          catalogWritten: false,
          cacheSynced: false,
          catalogQuality: "live",
          rehydrated: 0,
          message: "synchronized",
        };
      },
      apply: async () => {
        applies += 1;
        return { outcome: "no_workers", staleWorkerCount: 0, stoppedWorkerCount: 0, survivingWorkerCount: 0 };
      },
    }));

    expect(syncs).toBe(1);
    expect(applies).toBe(0);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      ok: true,
      outcome: "no_workers",
      activation: {
        routing: { status: "current", kind: "codexcommander-local" },
        workers: { status: "not_running" },
      },
    });
  });

  test("POST never signals when full sync leaves external routing in place", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    let applies = 0;
    const response = await handleCatalogActivationRoutes(routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      routing: () => "custom-remote",
      apply: async () => {
        applies += 1;
        return { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 };
      },
    }));

    expect(applies).toBe(0);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      ok: false,
      outcome: "blocked",
      activation: { routing: { status: "external", kind: "custom-remote" } },
      stoppedWorkerCount: 0,
    });
  });

  test("routing drift at the per-signal fence prevents interruption", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    let routingReads = 0;
    const response = await handleCatalogActivationRoutes(routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      routing: () => routingReads++ === 0 ? "codexcommander-local" : "custom-local",
      apply: async revalidate => revalidate()
        ? { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 }
        : { outcome: "superseded", staleWorkerCount: 1, stoppedWorkerCount: 0, survivingWorkerCount: 1 },
    }));

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      ok: false,
      outcome: "superseded",
      stoppedWorkerCount: 0,
      activation: { routing: { status: "external", kind: "custom-local" } },
    });
  });

  test("a failed full sync never enters the signal operation", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    let applies = 0;
    const response = await handleCatalogActivationRoutes(routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      sync: async () => ({
        status: "refused",
        ok: false,
        added: 0,
        catalogPath: null,
        catalogExists: false,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "native-only",
        rehydrated: 0,
        message: "refused",
      }),
      apply: async () => {
        applies += 1;
        return { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 };
      },
    }));

    expect(applies).toBe(0);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ ok: false, outcome: "blocked" });
  });

  test("an intentional full-sync skip is a conflict and never enters the signal operation", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    let applies = 0;
    const response = await handleCatalogActivationRoutes(routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      sync: async () => ({
        status: "skipped",
        skippedReason: "external_provider",
        ok: true,
        added: 0,
        catalogPath: null,
        catalogExists: false,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "native-only",
        rehydrated: 0,
        message: "preserved external provider",
      }),
      apply: async () => {
        applies += 1;
        return { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 };
      },
    }));

    expect(applies).toBe(0);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      ok: false,
      outcome: "blocked",
      stoppedWorkerCount: 0,
      message: "Codex is using an external model provider, so CodexCommander preserved that routing and stopped no process.",
    });
  });

  test("the HTTP adapter preserves the shared core's authoritative outcome and counts", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    const response = await handleCatalogActivationRoutes(routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      apply: async () => ({
        outcome: "applied",
        staleWorkerCount: 1,
        stoppedWorkerCount: 1,
        survivingWorkerCount: 0,
      }),
    }));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      ok: true,
      outcome: "applied",
      staleWorkerCount: 1,
      stoppedWorkerCount: 1,
      survivingWorkerCount: 0,
      activation: { workers: { status: "reload_required", staleCount: 1 } },
    });
  });

  test("a completed A-B-A save is superseded by the monotonic desired revision", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    const initial = desiredSnapshot(cfg, 1);
    const afterAba = desiredSnapshot(cfg, 3);
    let converged = 0;
    let applied = 0;
    const ctx = routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      body: { expectedDesiredRevision: initial.revision, confirmInterrupt: true },
      converge: async () => {
        converged += 1;
        return { status: "committed", changed: false, degraded: false, notices: [] };
      },
      apply: async () => {
        applied += 1;
        return { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 };
      },
    });
    ctx.deps.captureCatalogDesiredSnapshotForActivation = () => afterAba;

    const response = await handleCatalogActivationRoutes(ctx);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ outcome: "superseded" });
    expect(converged).toBe(0);
    expect(applied).toBe(0);
  });

  test("a generation change at the per-signal fence prevents interruption", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    const initial = desiredSnapshot(cfg, 1);
    const changed = desiredSnapshot(cfg, 2);
    let reads = 0;
    const ctx = routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      body: { expectedDesiredRevision: initial.revision, confirmInterrupt: true },
      apply: async revalidate => revalidate()
        ? { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 }
        : { outcome: "superseded", staleWorkerCount: 1, stoppedWorkerCount: 0, survivingWorkerCount: 1 },
    });
    ctx.deps.captureCatalogDesiredSnapshotForActivation = () => {
      reads += 1;
      return reads <= 2 ? initial : changed;
    };

    const response = await handleCatalogActivationRoutes(ctx);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      ok: false,
      outcome: "superseded",
      stoppedWorkerCount: 0,
    });
  });

  test("authoritative catalog drift at the per-signal fence prevents interruption", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    let artifactProof: "current" | "drifted" = "current";
    const ctx = routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      apply: async revalidate => {
        artifactProof = "drifted";
        return revalidate()
          ? { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 }
          : { outcome: "superseded", staleWorkerCount: 1, stoppedWorkerCount: 0, survivingWorkerCount: 1 };
      },
    });
    ctx.deps.catalogArtifactProofForActivation = () => artifactProof;

    const response = await handleCatalogActivationRoutes(ctx);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      ok: false,
      outcome: "superseded",
      stoppedWorkerCount: 0,
      activation: { catalog: { status: "pending" } },
    });
  });

  test("unknown worker identity fails closed without entering the signal operation", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    let applied = 0;
    const response = await handleCatalogActivationRoutes(routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      workerState: "unknown",
      body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      apply: async () => {
        applied += 1;
        return { outcome: "applied", staleWorkerCount: 0, stoppedWorkerCount: 0, survivingWorkerCount: 0 };
      },
    }));
    expect(response?.status).toBe(409);
    expect(applied).toBe(0);
    expect(await response?.json()).toMatchObject({ ok: false, outcome: "blocked" });
  });

  test("the browser adapter preserves canonical no-worker, current, unknown, and partial outcomes", async () => {
    const cfg = config({ multiAgentMode: "v2" });
    const cases = [
      { workerState: "not_running" as const, outcome: "no_workers", stale: 0, surviving: 0 },
      { workerState: "fresh" as const, outcome: "already_current", stale: 0, surviving: 0 },
      { workerState: "unknown" as const, outcome: "blocked", stale: 0, surviving: 0 },
      { workerState: "stale" as const, outcome: "partial", stale: 1, surviving: 1 },
    ];
    for (const item of cases) {
      const response = await handleCatalogActivationRoutes(routeContext({
        method: "POST",
        path: "/api/codex-catalog/apply",
        principal: "confirmed-gui-session",
        cfg,
        workerState: item.workerState,
        body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
        apply: async () => ({
          outcome: "partial",
          staleWorkerCount: 1,
          stoppedWorkerCount: 0,
          survivingWorkerCount: 1,
        }),
      }));
      expect(await response?.json()).toMatchObject({
        outcome: item.outcome,
        staleWorkerCount: item.stale,
        stoppedWorkerCount: 0,
        survivingWorkerCount: item.surviving,
      });
    }
  });

  test("a warning-bearing degraded sync never signals", async () => {
    const cfg = config({
      multiAgentMode: "v2",
      subagentModels: ["fixture/missing"],
    });
    let applied = 0;
    const response = await handleCatalogActivationRoutes(routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      cfg,
      body: { expectedDesiredRevision: codexCatalogDesiredRevision(cfg), confirmInterrupt: true },
      sync: async () => ({
        status: "applied",
        ok: true,
        added: 0,
        catalogPath: join(codexHome, "codexcommander-catalog.json"),
        catalogExists: true,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "retained",
        rehydrated: 1,
        message: "synchronized with retained rows",
        warning: "provider authentication unavailable",
      }),
      apply: async () => {
        applied += 1;
        return { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 };
      },
    }));

    expect(response?.status).toBe(409);
    expect(applied).toBe(0);
    expect(await response?.json()).toMatchObject({
      outcome: "blocked",
      activation: { catalog: { status: "pending" } },
    });
  });

  test("a stale desired revision is superseded before convergence or signaling", async () => {
    let converged = 0;
    let applied = 0;
    const response = await handleCatalogActivationRoutes(routeContext({
      method: "POST",
      path: "/api/codex-catalog/apply",
      principal: "confirmed-gui-session",
      body: { expectedDesiredRevision: "v1:stale", confirmInterrupt: true },
      converge: async () => {
        converged += 1;
        return { status: "committed", changed: false, degraded: false, notices: [] };
      },
      apply: async () => {
        applied += 1;
        return { outcome: "applied", staleWorkerCount: 1, stoppedWorkerCount: 1, survivingWorkerCount: 0 };
      },
    }));
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ outcome: "superseded" });
    expect(converged).toBe(0);
    expect(applied).toBe(0);
  });

  test("roster validation rejects overflow and duplicates instead of silently truncating", async () => {
    let saves = 0;
    const request = (models: string[]) => {
      const ctx = routeContext({
        method: "POST",
        path: "/api/codex-catalog/status",
      });
      ctx.req = new Request("http://localhost/api/subagent-models", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ models }),
      });
      ctx.url = new URL(ctx.req.url);
      ctx.deps.saveConfigPreservingClaudeCode = () => { saves += 1; };
      return handleAgentSettingsRoutes(ctx);
    };

    expect((await request(["a", "b", "c", "d", "e", "f"]))?.status).toBe(400);
    expect((await request(["a/model", "a/model"]))?.status).toBe(400);
    expect(saves).toBe(0);
  });
});

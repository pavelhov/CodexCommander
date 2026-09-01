import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncModelsToCodex } from "../src/codex/sync";
import { handleManagementAPI } from "../src/server/management-api";
import { resolveCodexCoordinatorDatabasePath, resolveEffectiveUserIdentity } from "../src/codex/user-identity";
import { MANAGED_AGENTS_TABLE_MARKER, MANAGED_SUBAGENT_DEFAULT_MARKER } from "../src/codex/subagent-defaults";
import type { CodexCommanderConfig } from "../src/types";
import type { OrcaCodexHomeDiagnostic } from "../src/codex/home";
import type { ProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
import {
  PROXY_ENSURE_LEASE_HEADER,
  PROXY_START_LEASE_HEADER,
} from "../src/server/proxy-lifecycle-protocol";
import { claimOwnedServiceHome } from "./helpers/owned-service-home";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";

setDefaultTimeout(30_000);

const TEST_DIR = join(import.meta.dir, ".tmp-codex-sync-api");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
const TEST_CCX_HOME = join(TEST_DIR, "ccx");
const TEST_HOME = join(TEST_DIR, "home");
const repoRoot = join(import.meta.dir, "..");
let prevCodexHome: string | undefined;
let prevCodexCommanderHome: string | undefined;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let previousCodexCliPath: string | undefined;
let testCoordinatorPath = "";

const config = {
  port: 0,
  multiAgentGuidanceEnabled: true,
  defaultProvider: "fixture",
  providers: {
    fixture: {
      adapter: "openai-chat",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture-key",
      allowPrivateNetwork: true,
      models: ["fixture-model"],
    },
  },
} as CodexCommanderConfig;

function claimTempHome(codexHome: string, ccxHome: string, home: string): Record<string, string> {
  return claimOwnedServiceHome(codexHome, ccxHome, home).env;
}

const admittedSync = () => ({ kind: "admitted" as const });
const preparedSync = () => ({
  kind: "ready" as const,
  state: { nativeGeneration: 0, currentTxId: null },
});

function homeDiagnostic(overrides: Partial<OrcaCodexHomeDiagnostic> = {}): OrcaCodexHomeDiagnostic {
  return {
    applicable: false,
    mismatch: false,
    effectiveCodexHome: "C:\\Users\\[USER]\\.codex",
    appCodexHome: "C:\\Users\\[USER]\\.codex",
    orcaCodexHome: null,
    warning: null,
    action: null,
    ...overrides,
  };
}

describe("GUI/CLI Codex sync backend", () => {
  beforeEach(() => {
    prevCodexHome = process.env.CODEX_HOME;
    prevCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    previousCodexCliPath = process.env.CODEX_CLI_PATH;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    mkdirSync(TEST_CCX_HOME, { recursive: true });
    mkdirSync(TEST_HOME, { recursive: true });
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    process.env.CODEXCOMMANDER_HOME = TEST_CCX_HOME;
    process.env.HOME = TEST_HOME;
    process.env.USERPROFILE = TEST_HOME;
    process.env.CODEX_CLI_PATH = createCodexRuntimeFixture(TEST_DIR);
    testCoordinatorPath = resolveCodexCoordinatorDatabasePath(
      resolveEffectiveUserIdentity(),
      realpathSync.native(TEST_CODEX_HOME),
    );
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      rmSync(`${testCoordinatorPath}${suffix}`, { force: true });
    }
    writeFileSync(join(TEST_CODEX_HOME, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    writeFileSync(join(TEST_CCX_HOME, "config.json"), JSON.stringify(config));
    claimTempHome(TEST_CODEX_HOME, TEST_CCX_HOME, TEST_HOME);
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = prevCodexCommanderHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previousCodexCliPath;
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      rmSync(`${testCoordinatorPath}${suffix}`, { force: true });
    }
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });
  test("returns the structured sync result used by POST /api/sync", async () => {
    let injectedPort = 0;
    let injectedCatalogPath: string | null | undefined;
    const order: string[] = [];

    const logs: string[] = [];
    const errors: string[] = [];
    const result = await syncModelsToCodex(12345, config, { log: line => logs.push(String(line)), error: line => errors.push(String(line)) }, {
      admitCodexWrite: admittedSync,
      reconcileJournal: () => {
        order.push("journal");
        return false;
      },
      prepareCodexTransitionState: () => {
        order.push("coordinator");
        return { kind: "ready", state: { nativeGeneration: 0, currentTxId: null } };
      },
      refreshCodexModelCatalog: async () => {
        order.push("catalog");
        return {
          added: 3,
          path: "/tmp/codexcommander-catalog.json",
          catalogExists: true,
          catalogWritten: true,
          cacheSynced: true,
          comboOmissions: [],
        };
      },
      injectCodexConfig: async (port, _config, options) => {
        order.push("inject");
        injectedPort = port;
        injectedCatalogPath = options.catalogPath;
        return { success: true, message: "injected" };
      },
      currentExternalCodexModelProvider: () => null,
      collectCodexHomeDiagnostic: () => homeDiagnostic(),
    });

    expect(injectedPort).toBe(12345);
    expect(injectedCatalogPath).toBe("/tmp/codexcommander-catalog.json");
    expect(order).toEqual(["journal", "coordinator", "catalog", "inject"]);
    expect(result).toEqual({
      status: "applied",
      ok: true,
      added: 3,
      catalogPath: "/tmp/codexcommander-catalog.json",
      catalogExists: true,
      catalogWritten: true,
      cacheSynced: true,
      message: "injected",
    });
    expect(logs).toContain("   Target Codex home: C:\\Users\\[USER]\\.codex");
    expect(errors).toEqual([]);
  });

  test("refuses before catalog publication when the current coordinator is unavailable", async () => {
    let refreshed = false;
    let injected = false;

    const result = await syncModelsToCodex(12345, config, null, {
      admitCodexWrite: admittedSync,
      prepareCodexTransitionState: () => ({ kind: "unavailable", reason: "busy" }),
      refreshCodexModelCatalog: async () => {
        refreshed = true;
        throw new Error("must not refresh");
      },
      injectCodexConfig: async () => {
        injected = true;
        throw new Error("must not inject");
      },
      currentExternalCodexModelProvider: () => null,
    });

    expect(result).toEqual({
      status: "refused",
      ok: false,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "native-only",
      rehydrated: 0,
      message: "Codex sync refused before catalog publication because the transition coordinator is busy; retry the sync.",
    });
    expect(refreshed).toBe(false);
    expect(injected).toBe(false);
  });

  test("surfaces ambiguous coordinator state without publishing catalog residue", async () => {
    let refreshed = false;
    let injected = false;
    const result = await syncModelsToCodex(12345, config, null, {
      admitCodexWrite: admittedSync,
      prepareCodexTransitionState: () => ({
        kind: "state-ambiguous",
        message: "The current coordinator row is missing.",
      }),
      refreshCodexModelCatalog: async () => {
        refreshed = true;
        throw new Error("must not refresh");
      },
      injectCodexConfig: async () => {
        injected = true;
        throw new Error("must not inject");
      },
      currentExternalCodexModelProvider: () => null,
    });

    expect(result).toEqual({
      status: "refused",
      ok: false,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "native-only",
      rehydrated: 0,
      message: "Codex sync refused before catalog publication: The current coordinator row is missing.",
    });
    expect(refreshed).toBe(false);
    expect(injected).toBe(false);
  });

  test("returns a policy skip without touching the catalog or config", async () => {
    let refreshed = false;
    let injected = false;
    writeFileSync(join(TEST_CCX_HOME, "config.json"), JSON.stringify({
      ...config,
      clientIntegrations: { codex: false },
    }));
    const result = await syncModelsToCodex(12345, config, null, {
      admitCodexWrite: admittedSync,
      prepareCodexTransitionState: () => { throw new Error("OFF must not prepare the coordinator"); },
      refreshCodexModelCatalog: async () => {
        refreshed = true;
        throw new Error("must not refresh");
      },
      injectCodexConfig: async () => {
        injected = true;
        throw new Error("must not inject");
      },
    });

    expect(result).toMatchObject({ status: "skipped", skippedReason: "desired_disabled", ok: true });
    expect(refreshed).toBe(false);
    expect(injected).toBe(false);
  });

  test("an OFF race after catalog commit preserves truthful artifact receipts", async () => {
    const result = await syncModelsToCodex(12345, config, null, {
      admitCodexWrite: admittedSync,
      prepareCodexTransitionState: preparedSync,
      refreshCodexModelCatalog: async () => ({
        added: 2,
        path: "/tmp/codexcommander-catalog.json",
        catalogExists: true,
        catalogWritten: true,
        cacheSynced: true,
        comboOmissions: [],
        catalogQuality: "live" as const,
        rehydrated: 0,
        catalogDisposition: {
          status: "committed" as const,
          changed: true,
          degraded: false,
          notices: [],
        },
      }),
      injectCodexConfig: async () => ({
        success: true,
        status: "skipped",
        skippedReason: "desired_disabled",
        message: "Codex integration is OFF; no Codex config, catalog, cache, or history was changed.",
      }),
      currentExternalCodexModelProvider: () => null,
    });

    expect(result).toMatchObject({
      status: "skipped",
      skippedReason: "desired_disabled",
      ok: true,
      added: 2,
      catalogPath: "/tmp/codexcommander-catalog.json",
      catalogExists: true,
      catalogWritten: true,
      cacheSynced: true,
      catalogQuality: "live",
      rehydrated: 0,
    });
    expect(result.message).toContain("catalog changes from this sync were published");
  });

  /**
   * The lost-transition race, with a REAL second process. The caller's config
   * snapshot says ON; while provider discovery is awaited, another process
   * persists OFF. The under-lock re-read inside the real injector must observe
   * the fresh persisted intent and skip — the snapshot must not win.
   *
   * Runs entirely in a child process with its own temp CODEX_HOME, because the
   * injector resolves its config path at module load: an in-process variant
   * would silently address the suite's isolated home instead of the fixture.
   */
  test("a competing OFF during catalog discovery becomes the discriminated skip", async () => {
    const raceRoot = mkdtempSync(join(tmpdir(), "ccx-sync-lost-transition-"));
    const raceCodexHome = join(raceRoot, ".codex");
    const raceCodexCommanderHome = join(raceRoot, ".codexcommander");
    const raceHome = join(raceRoot, "home");
    mkdirSync(raceCodexHome, { recursive: true });
    mkdirSync(raceCodexCommanderHome, { recursive: true });
    mkdirSync(raceHome, { recursive: true });
    try {
      writeFileSync(join(raceCodexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(raceCodexCommanderHome, "config.json"), JSON.stringify(config));
      const serviceManagerEnv = claimTempHome(raceCodexHome, raceCodexCommanderHome, raceHome);
      const script = [
        'const { spawnSync } = require("node:child_process");',
        'const { loadConfig } = require("./src/config");',
        'const { syncModelsToCodex } = require("./src/codex/sync");',
        'const { injectCodexConfig } = require("./src/codex/inject");',
        '(async () => {',
        '  const snapshot = loadConfig(); // admitted BEFORE the flip: reads as ON',
        '  const result = await syncModelsToCodex(12345, snapshot, null, {',
        '    prepareCodexTransitionState: () => ({ kind: "ready", state: { nativeGeneration: 0, currentTxId: null } }),',
        '    refreshCodexModelCatalog: async () => {',
        '      // The provider-discovery window: a second real process persists OFF.',
        '      const flip = spawnSync(process.execPath, ["--eval",',
        '        \'const { setIntegrationEnabled } = require("./src/codex/desired-state");\'',
        '        + \'const r = setIntegrationEnabled("codex", false);\'',
        '        + \'if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); }\',',
        '      ], { cwd: process.cwd(), env: process.env, encoding: "utf8" });',
        '      if (flip.status !== 0) throw new Error("flip failed: " + flip.stderr);',
        '      return { added: 0, path: "/tmp/none.json", catalogExists: false, catalogWritten: false, cacheSynced: false, comboOmissions: [] };',
        '    },',
        '    injectCodexConfig, // the REAL injector; its under-lock re-read is the claim',
        '  });',
        '  console.log(JSON.stringify({ status: result.status, skippedReason: result.skippedReason, ok: result.ok }));',
        '})();',
      ].join("\n");
      const before = readFileSync(join(raceCodexHome, "config.toml"), "utf8");
      const child = spawnSync(process.execPath, ["--eval", script], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: raceHome,
          USERPROFILE: raceHome,
          CODEX_HOME: raceCodexHome,
          CODEXCOMMANDER_HOME: raceCodexCommanderHome,
          ...serviceManagerEnv,
        },
        encoding: "utf8",
      });
      expect(child.status).toBe(0);
      const line = child.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
      expect(JSON.parse(line)).toMatchObject({ status: "skipped", skippedReason: "desired_disabled", ok: true });
      // The stale ON snapshot wrote nothing: the fixture config is untouched.
      expect(readFileSync(join(raceCodexHome, "config.toml"), "utf8")).toBe(before);
    } finally {
      rmSync(raceRoot, { recursive: true, force: true });
    }
  });

  test("surfaces combo catalog omissions in sync result and CLI stderr (#484)", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const omission = {
      id: "k3k3",
      targets: ["kimi/k3", "xianyu/kimi-k3"],
      reason: "incomplete_metadata" as const,
      message: "[codexcommander] Combo \"k3k3\" is omitted from the catalog because member capabilities are incomplete: kimi/k3, xianyu/kimi-k3.",
    };
    const result = await syncModelsToCodex(12345, config, { log: line => logs.push(String(line)), error: line => errors.push(String(line)) }, {
      admitCodexWrite: admittedSync,
      prepareCodexTransitionState: preparedSync,
      refreshCodexModelCatalog: async () => ({
        added: 1,
        path: "/tmp/codexcommander-catalog.json",
        catalogExists: true,
        catalogWritten: true,
        cacheSynced: true,
        comboOmissions: [omission],
      }),
      injectCodexConfig: async () => ({ success: true, message: "injected" }),
      currentExternalCodexModelProvider: () => null,
      collectCodexHomeDiagnostic: () => homeDiagnostic(),
    });

    expect(result.comboOmissions).toEqual([omission]);
    expect(result.warning).toContain("1 combo omitted from the catalog");
    expect(errors).toEqual([
      "1 combo omitted from the catalog because member capabilities are incomplete.",
    ]);
  });

  test("CLI sync summary uses incompatible_modalities reason, not incomplete (#516)", async () => {
    const errors: string[] = [];
    const omission = {
      id: "disjoint",
      targets: ["a/m1", "b/m2"],
      reason: "incompatible_modalities" as const,
      message: "[codexcommander] Combo \"disjoint\" is omitted from the catalog because members have no common input modalities: a/m1, b/m2.",
    };
    const result = await syncModelsToCodex(12345, config, { log: () => {}, error: line => errors.push(String(line)) }, {
      admitCodexWrite: admittedSync,
      prepareCodexTransitionState: preparedSync,
      refreshCodexModelCatalog: async () => ({
        added: 0,
        path: "/tmp/codexcommander-catalog.json",
        catalogExists: true,
        catalogWritten: true,
        cacheSynced: true,
        comboOmissions: [omission],
      }),
      injectCodexConfig: async () => ({ success: true, message: "injected" }),
      currentExternalCodexModelProvider: () => null,
      collectCodexHomeDiagnostic: () => homeDiagnostic(),
    });

    expect(result.comboOmissions).toEqual([omission]);
    expect(result.warning).toBe(
      "1 combo omitted from the catalog because members have no common input modalities.",
    );
    expect(errors).toEqual([
      "1 combo omitted from the catalog because members have no common input modalities.",
    ]);
    expect(errors.join("\n")).not.toContain("member capabilities are incomplete");
  });

  test("keeps injection fallback behavior when catalog refresh throws", async () => {
    let injectedCatalogPath: string | null | undefined = "unset";

    const result = await syncModelsToCodex(undefined, config, null, {
      admitCodexWrite: admittedSync,
      prepareCodexTransitionState: preparedSync,
      refreshCodexModelCatalog: async () => {
        throw new Error("catalog boom");
      },
      injectCodexConfig: async (_port, _config, options) => {
        injectedCatalogPath = options.catalogPath;
        return { success: true, message: "injected fallback" };
      },
      currentExternalCodexModelProvider: () => null,
    });

    expect(injectedCatalogPath).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.catalogPath).toBeNull();
    expect(result.warning).toContain("catalog boom");
  });

  test("native-only catalog quality is actionable when routed providers are configured", async () => {
    const errors: string[] = [];
    const result = await syncModelsToCodex(10100, config, {
      log: () => {},
      error: line => errors.push(String(line)),
    }, {
      admitCodexWrite: admittedSync,
      prepareCodexTransitionState: preparedSync,
      refreshCodexModelCatalog: async () => ({
        added: 0,
        path: "/tmp/codexcommander-catalog.json",
        catalogExists: true,
        catalogWritten: true,
        cacheSynced: true,
        comboOmissions: [],
        catalogQuality: "native-only",
        rehydrated: 0,
      }),
      injectCodexConfig: async () => ({ success: true, message: "injected" }),
      currentExternalCodexModelProvider: () => null,
      collectCodexHomeDiagnostic: () => homeDiagnostic(),
    });

    expect(result.ok).toBe(true);
    expect(result.catalogQuality).toBe("native-only");
    expect(result.warning).toContain("Codex left native-only");
    expect(result.warning).toContain("ccx sync");
    expect(errors.join("\n")).toContain("provider discovery returned nothing");
  });

  test("retained catalog quality is converged without a native-only warning", async () => {
    const result = await syncModelsToCodex(10100, config, null, {
      admitCodexWrite: admittedSync,
      prepareCodexTransitionState: preparedSync,
      refreshCodexModelCatalog: async () => ({
        added: 0,
        path: "/tmp/codexcommander-catalog.json",
        catalogExists: true,
        catalogWritten: true,
        cacheSynced: true,
        comboOmissions: [],
        catalogQuality: "retained",
        rehydrated: 2,
      }),
      injectCodexConfig: async () => ({ success: true, message: "injected" }),
      currentExternalCodexModelProvider: () => null,
      collectCodexHomeDiagnostic: () => homeDiagnostic(),
    });

    expect(result).toMatchObject({
      ok: true,
      catalogQuality: "retained",
      rehydrated: 2,
    });
    expect(result.warning).toBeUndefined();
  });

  test("returns native subagent default conflicts as structured warnings", async () => {
    const result = await syncModelsToCodex(10100, config, null, {
      admitCodexWrite: admittedSync,
      prepareCodexTransitionState: preparedSync,
      refreshCodexModelCatalog: async () => ({
        added: 0,
        path: "/tmp/codexcommander-catalog.json",
        catalogExists: true,
        cacheSynced: true,
      }),
      injectCodexConfig: async () => ({
        success: true,
        message: "injected with a preserved user setting",
        nativeSubagentDefaultsWarning: "Native Codex sub-agent defaults were not injected: user-owned agents.default_subagent_model preserved.",
      }),
      currentExternalCodexModelProvider: () => null,
    });

    expect(result.ok).toBe(true);
    expect(result.nativeSubagentDefaultsWarning).toContain("user-owned agents.default_subagent_model preserved");
  });

  test("POST /api/sync exposes an actionable error when native defaults are ambiguous", () => {
    const ccxHome = join(TEST_DIR, "codexcommander");
    mkdirSync(ccxHome, { recursive: true });
    writeFileSync(join(TEST_CODEX_HOME, "config.toml"), [
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      "",
      'default_subagent_model = "gpt-5.6-sol"',
      "",
    ].join("\n"), "utf8");

    const child = spawnSync(process.execPath, ["-e", `
      const { handleManagementAPI } = await import("./src/server/management-api.ts");
      const config = { port: 10100, defaultProvider: "openai", providers: {} };
      const response = await handleManagementAPI(
        new Request("http://localhost/api/sync", { method: "POST", headers: { Host: "localhost" } }),
        new URL("http://localhost/api/sync"),
        config,
      );
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    `], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CODEX_HOME: TEST_CODEX_HOME, CODEXCOMMANDER_HOME: ccxHome },
      encoding: "utf8",
    });

    expect(child.status).toBe(0);
    const payload = JSON.parse(child.stdout.trim()) as {
      status: number;
      body: { ok: boolean; error?: string; message: string };
    };
    expect(payload.status).toBe(500);
    expect(payload.body.ok).toBe(false);
    expect(payload.body.error).toBe(payload.body.message);
    expect(payload.body.error).toContain("inspect");
    expect(payload.body.error).toContain(join(TEST_CODEX_HOME, "config.toml"));
  });

  test("POST /api/sync promotes failed readiness only after a clean full sync", async () => {
    let recovered = 0;
    const syncResult = {
      status: "applied" as const,
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: true,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "live" as const,
      rehydrated: 0,
      message: "synced",
    };
    const request = new Request("http://localhost/api/sync", { method: "POST" });
    const response = await handleManagementAPI(request, new URL(request.url), config, {
      syncModelsToCodex: async () => syncResult,
      readRuntimePort: () => ({ pid: process.pid, port: 10100, hostname: "127.0.0.1", startedAt: new Date().toISOString() }),
      resetCodexAppServerCatalogStateCache: () => {},
      collectCodexAppServerCatalogState: () => ({ state: "not_running", processes: [], catalogMtimeMs: null }),
      captureCatalogDesiredSnapshotForActivation: () => ({
        config,
        authority: {
          generation: { value: 1 },
          semanticIdentity: "semantic",
          contentIdentity: "content",
          referenceIdentity: "reference",
        },
        revision: "revision",
      }) as never,
      catalogArtifactProofForActivation: () => "current",
      codexRoutingKindForActivation: () => "codexcommander-local",
      readinessGate: { recoverReady: () => { recovered += 1; } },
    });

    expect(response?.status).toBe(200);
    expect(recovered).toBe(1);

    const degradedRequest = new Request("http://localhost/api/sync", { method: "POST" });
    await handleManagementAPI(degradedRequest, new URL(degradedRequest.url), config, {
      syncModelsToCodex: async () => ({ ...syncResult, warning: "provider discovery incomplete" }),
      readRuntimePort: () => null,
      resetCodexAppServerCatalogStateCache: () => {},
      collectCodexAppServerCatalogState: () => ({ state: "not_running", processes: [], catalogMtimeMs: null }),
      captureCatalogDesiredSnapshotForActivation: () => ({
        config,
        authority: {
          generation: { value: 1 },
          semanticIdentity: "semantic",
          contentIdentity: "content",
          referenceIdentity: "reference",
        },
        revision: "revision",
      }) as never,
      catalogArtifactProofForActivation: () => "current",
      codexRoutingKindForActivation: () => "codexcommander-local",
      readinessGate: { recoverReady: () => { recovered += 1; } },
    });
    expect(recovered).toBe(1);
  });

  test("raw POST /api/sync waits for E then S and observes OFF before mutation", async () => {
    let admitAuthority!: (authority: ProxyLifecycleAuthority) => void;
    let authorityRequested!: () => void;
    const authorityRequest = new Promise<void>(resolve => { authorityRequested = resolve; });
    const authorityAdmission = new Promise<ProxyLifecycleAuthority>(resolve => { admitAuthority = resolve; });
    const releases: string[] = [];
    let released = false;
    const authority: ProxyLifecycleAuthority = {
      deadlineAt: Number.POSITIVE_INFINITY,
      ensure: { token: "ensure-token", release: () => authority.releaseAll() },
      start: { token: "start-token", release: () => authority.releaseStart() },
      acquireStart: async () => authority.start!,
      delegatedLease: () => released
        ? undefined
        : { ensureToken: "ensure-token", startToken: "start-token" },
      releaseStart: () => { releases.push("S"); },
      releaseAll: () => {
        if (released) return;
        released = true;
        releases.push("S", "E");
      },
    };
    let syncConfig: CodexCommanderConfig | null = null;
    let includeStart: boolean | undefined;
    const request = new Request("http://localhost/api/sync", { method: "POST" });
    const pending = handleManagementAPI(request, new URL(request.url), config, {
      proxyStopLifecycle: {
        acquireAuthority: async options => {
          includeStart = options?.includeStart;
          authorityRequested();
          return authorityAdmission;
        },
      },
      syncModelsToCodex: async (_port, current) => {
        syncConfig = current;
        return {
          status: "skipped",
          skippedReason: "desired_disabled",
          ok: true,
          added: 0,
          catalogPath: null,
          catalogExists: false,
          catalogWritten: false,
          cacheSynced: false,
          catalogQuality: "native-only",
          rehydrated: 0,
          message: "disabled",
        };
      },
      readRuntimePort: () => null,
      resetCodexAppServerCatalogStateCache: () => {},
      collectCodexAppServerCatalogState: () => ({ state: "not_running", processes: [], catalogMtimeMs: null }),
      captureCatalogDesiredSnapshotForActivation: () => ({
        config: { ...config, clientIntegrations: { codex: false } },
        authority: {
          generation: { value: 1 },
          semanticIdentity: "semantic",
          contentIdentity: "content",
          referenceIdentity: "reference",
        },
        revision: "disabled-revision",
      }) as never,
      catalogArtifactProofForActivation: () => "unproven",
      codexRoutingKindForActivation: () => "native",
    });

    await authorityRequest;
    expect(includeStart).toBe(true);
    expect(syncConfig).toBeNull();
    writeFileSync(join(TEST_CCX_HOME, "config.json"), JSON.stringify({
      ...config,
      clientIntegrations: { codex: false },
    }));
    admitAuthority(authority);

    const response = await pending;
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      status: "skipped",
      skippedReason: "desired_disabled",
      ok: true,
    });
    expect(syncConfig?.clientIntegrations?.codex).toBe(false);
    expect(releases).toEqual(["S", "E"]);
  });

  test("POST /api/sync accepts only a validated complete delegated E/S lease", async () => {
    let syncCalls = 0;
    let validations = 0;
    const syncResult = {
      status: "applied" as const,
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: true,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "live" as const,
      rehydrated: 0,
      message: "synced",
    };
    const activationSeams = {
      syncModelsToCodex: async () => { syncCalls += 1; return syncResult; },
      readRuntimePort: () => null,
      resetCodexAppServerCatalogStateCache: () => {},
      collectCodexAppServerCatalogState: () => ({ state: "not_running" as const, processes: [], catalogMtimeMs: null }),
      captureCatalogDesiredSnapshotForActivation: () => ({
        config,
        authority: {
          generation: { value: 1 },
          semanticIdentity: "semantic",
          contentIdentity: "content",
          referenceIdentity: "reference",
        },
        revision: "revision",
      }) as never,
      catalogArtifactProofForActivation: () => "current" as const,
      codexRoutingKindForActivation: () => "codexcommander-local" as const,
    };
    const delegated = new Request("http://localhost/api/sync", {
      method: "POST",
      headers: {
        [PROXY_ENSURE_LEASE_HEADER]: "ensure-secret",
        [PROXY_START_LEASE_HEADER]: "start-secret",
      },
    });
    const accepted = await handleManagementAPI(delegated, new URL(delegated.url), config, {
      ...activationSeams,
      proxyStopLifecycle: {
        validateLease: lease => {
          validations += 1;
          return lease.ensureToken === "ensure-secret" && lease.startToken === "start-secret";
        },
        acquireAuthority: async () => { throw new Error("delegated sync must not reacquire"); },
      },
    });
    expect(accepted?.status).toBe(200);
    expect(validations).toBe(1);
    expect(syncCalls).toBe(1);

    const partial = new Request("http://localhost/api/sync", {
      method: "POST",
      headers: { [PROXY_ENSURE_LEASE_HEADER]: "ensure-secret" },
    });
    const refused = await handleManagementAPI(partial, new URL(partial.url), config, {
      ...activationSeams,
      proxyStopLifecycle: {
        validateLease: () => { throw new Error("partial proof must fail before validation"); },
        acquireAuthority: async () => { throw new Error("partial proof must not reacquire"); },
      },
    });
    expect(refused?.status).toBe(409);
    expect(await refused?.json()).toMatchObject({ status: "refused", ok: false });
    expect(syncCalls).toBe(1);
  });

  test("POST /api/sync never promotes from a torn desired, artifact, or routing observation", async () => {
    const syncResult = {
      status: "applied" as const,
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: true,
      catalogWritten: false,
      cacheSynced: false,
      catalogQuality: "live" as const,
      rehydrated: 0,
      message: "synced",
    };
    const snapshot = (revision: string) => ({
      config,
      authority: {
        generation: { value: 1 },
        semanticIdentity: "semantic",
        contentIdentity: "content",
        referenceIdentity: "reference",
      },
      revision,
    }) as never;
    const dispatch = async (overrides: {
      capture: () => never;
      artifact: () => "current" | "drifted";
      routing: () => "codexcommander-local" | "native";
      recover: () => void;
    }) => {
      const request = new Request("http://localhost/api/sync", { method: "POST" });
      return handleManagementAPI(request, new URL(request.url), config, {
        syncModelsToCodex: async () => syncResult,
        readRuntimePort: () => null,
        resetCodexAppServerCatalogStateCache: () => {},
        collectCodexAppServerCatalogState: () => ({ state: "not_running", processes: [], catalogMtimeMs: null }),
        captureCatalogDesiredSnapshotForActivation: overrides.capture,
        catalogArtifactProofForActivation: overrides.artifact,
        codexRoutingKindForActivation: overrides.routing,
        readinessGate: { recoverReady: overrides.recover },
      });
    };

    let recovered = 0;
    let desiredReads = 0;
    await dispatch({
      capture: () => snapshot(++desiredReads === 1 ? "revision-a" : "revision-b"),
      artifact: () => "current",
      routing: () => "codexcommander-local",
      recover: () => { recovered += 1; },
    });
    expect(recovered).toBe(0);

    let artifactReads = 0;
    await dispatch({
      capture: () => snapshot("revision-a"),
      artifact: () => ++artifactReads === 1 ? "current" : "drifted",
      routing: () => "codexcommander-local",
      recover: () => { recovered += 1; },
    });
    expect(recovered).toBe(0);

    let routingReads = 0;
    await dispatch({
      capture: () => snapshot("revision-a"),
      artifact: () => "current",
      routing: () => ++routingReads === 1 ? "codexcommander-local" : "native",
      recover: () => { recovered += 1; },
    });
    expect(recovered).toBe(0);
  });

  test("POST /api/sync recovery accepts only coherent intentional skip states", async () => {
    const snapshot = (desiredConfig: CodexCommanderConfig) => ({
      config: desiredConfig,
      authority: {
        generation: { value: 1 },
        semanticIdentity: "semantic",
        contentIdentity: "content",
        referenceIdentity: "reference",
      },
      revision: "stable-revision",
    }) as never;
    const disabledConfig = {
      ...config,
      clientIntegrations: { ...config.clientIntegrations, codex: false },
    } as CodexCommanderConfig;
    let recovered = 0;
    const disabledRequest = new Request("http://localhost/api/sync", { method: "POST" });
    await handleManagementAPI(disabledRequest, new URL(disabledRequest.url), config, {
      syncModelsToCodex: async () => ({
        status: "skipped",
        skippedReason: "desired_disabled",
        ok: true,
        added: 0,
        catalogPath: null,
        catalogExists: false,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "native-only",
        rehydrated: 0,
        message: "disabled",
      }),
      readRuntimePort: () => null,
      resetCodexAppServerCatalogStateCache: () => {},
      collectCodexAppServerCatalogState: () => ({ state: "not_running", processes: [], catalogMtimeMs: null }),
      captureCatalogDesiredSnapshotForActivation: () => snapshot(disabledConfig),
      // No Commander-owned artifact is expected while integration is OFF.
      catalogArtifactProofForActivation: () => "unproven",
      codexRoutingKindForActivation: () => "native",
      readinessGate: { recoverReady: () => { recovered += 1; } },
    });
    expect(recovered).toBe(1);

    const staleCommanderRouteRequest = new Request("http://localhost/api/sync", { method: "POST" });
    await handleManagementAPI(staleCommanderRouteRequest, new URL(staleCommanderRouteRequest.url), config, {
      syncModelsToCodex: async () => ({
        status: "skipped",
        skippedReason: "desired_disabled",
        ok: true,
        added: 0,
        catalogPath: null,
        catalogExists: false,
        catalogWritten: false,
        cacheSynced: false,
        catalogQuality: "native-only",
        rehydrated: 0,
        message: "disabled but stale route remains",
      }),
      readRuntimePort: () => null,
      resetCodexAppServerCatalogStateCache: () => {},
      collectCodexAppServerCatalogState: () => ({ state: "not_running", processes: [], catalogMtimeMs: null }),
      captureCatalogDesiredSnapshotForActivation: () => snapshot(disabledConfig),
      catalogArtifactProofForActivation: () => "unproven",
      codexRoutingKindForActivation: () => "codexcommander-local",
      readinessGate: { recoverReady: () => { recovered += 1; } },
    });
    expect(recovered).toBe(1);

    const externalRequest = new Request("http://localhost/api/sync", { method: "POST" });
    await handleManagementAPI(externalRequest, new URL(externalRequest.url), config, {
      syncModelsToCodex: async () => ({
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
        message: "external preserved",
      }),
      readRuntimePort: () => null,
      resetCodexAppServerCatalogStateCache: () => {},
      collectCodexAppServerCatalogState: () => ({ state: "not_running", processes: [], catalogMtimeMs: null }),
      captureCatalogDesiredSnapshotForActivation: () => snapshot(config),
      catalogArtifactProofForActivation: () => "unproven",
      codexRoutingKindForActivation: () => "custom-remote",
      readinessGate: { recoverReady: () => { recovered += 1; } },
    });
    expect(recovered).toBe(2);

    const incoherentRequest = new Request("http://localhost/api/sync", { method: "POST" });
    await handleManagementAPI(incoherentRequest, new URL(incoherentRequest.url), config, {
      syncModelsToCodex: async () => ({
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
        message: "incoherent",
      }),
      readRuntimePort: () => null,
      resetCodexAppServerCatalogStateCache: () => {},
      collectCodexAppServerCatalogState: () => ({ state: "not_running", processes: [], catalogMtimeMs: null }),
      captureCatalogDesiredSnapshotForActivation: () => snapshot(disabledConfig),
      catalogArtifactProofForActivation: () => "unproven",
      codexRoutingKindForActivation: () => "custom-remote",
      readinessGate: { recoverReady: () => { recovered += 1; } },
    });
    expect(recovered).toBe(2);
  });

  test("skips catalog refresh before preserving an external provider", async () => {
    let refreshed = false;
    let injectedCatalogPath: string | null | undefined = "unset";
    let expectedExternalProvider: string | undefined;
    const logs: string[] = [];
    const errors: string[] = [];
    const mismatch = homeDiagnostic({
      applicable: true,
      mismatch: true,
      effectiveCodexHome: "C:\\Users\\[USER]\\AppData\\Roaming\\orca\\codex-runtime-home\\home",
      orcaCodexHome: "C:\\Users\\[USER]\\AppData\\Roaming\\orca\\codex-runtime-home\\home",
      warning: "Orca target does not reach the app",
      action: "migrate the installed service",
    });
    const result = await syncModelsToCodex(10100, config, { log: line => logs.push(String(line)), error: line => errors.push(String(line)) }, {
      admitCodexWrite: () => { throw new Error("external providers must not enter write admission"); },
      prepareCodexTransitionState: () => { throw new Error("external providers must not prepare the coordinator"); },
      refreshCodexModelCatalog: async () => {
        refreshed = true;
        throw new Error("must not refresh");
      },
      injectCodexConfig: async (_port, _config, options) => {
        injectedCatalogPath = options.catalogPath;
        expectedExternalProvider = options.expectedExternalProvider;
        return { success: true, message: "external provider preserved" };
      },
      currentExternalCodexModelProvider: () => "custom",
      collectCodexHomeDiagnostic: () => mismatch,
    });

    expect(refreshed).toBe(false);
    expect(injectedCatalogPath).toBeUndefined();
    expect(expectedExternalProvider).toBe("custom");
    expect(result).toEqual({
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
      message: "external provider preserved",
    });
    expect(logs).toContain(`   Target Codex home: ${mismatch.effectiveCodexHome}`);
    expect(errors).toEqual([
      `WARNING: ${mismatch.warning}`,
      `Action: ${mismatch.action}`,
    ]);
  });

  test("a clean first sync prepares the coordinator before routed catalog residue", async () => {
    const catalogPath = join(TEST_CODEX_HOME, "codexcommander-catalog.json");
    expect(existsSync(testCoordinatorPath)).toBe(false);
    const script = [
      'const { existsSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      'const { loadConfig } = require("./src/config");',
      'const { injectCodexConfig } = require("./src/codex/inject");',
      'const { syncModelsToCodex } = require("./src/codex/sync");',
      'const { readCodexTransitionState } = require("./src/codex/transition-state");',
      'const { resolveCodexCoordinatorDatabasePath, resolveEffectiveUserIdentity } = require("./src/codex/user-identity");',
      '(async () => {',
      '  const codexHome = process.env.CODEX_HOME;',
      '  const coordinatorPath = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), realpathSync.native(codexHome));',
      '  const catalogPath = join(codexHome, "codexcommander-catalog.json");',
      '  const before = existsSync(coordinatorPath);',
      '  let during;',
      '  const result = await syncModelsToCodex(12345, loadConfig(), null, {',
      '    admitCodexWrite: () => ({ kind: "admitted" }),',
      '    prepareCodexTransitionState: readCodexTransitionState,',
      '    refreshCodexModelCatalog: async () => {',
      '      during = readCodexTransitionState();',
      '      writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: "fixture/fixture-model", description: "Routed via CodexCommander → fixture/fixture-model" }] }));',
      '      return { added: 1, path: catalogPath, catalogExists: true, catalogWritten: true, cacheSynced: false, catalogQuality: "live", rehydrated: 0, comboOmissions: [] };',
      '    },',
      '    injectCodexConfig,',
      '    currentExternalCodexModelProvider: () => null,',
      '  });',
      '  console.log(JSON.stringify({ before, during, result, after: readCodexTransitionState(), config: readFileSync(join(codexHome, "config.toml"), "utf8") }));',
      '})();',
    ].join("\n");
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: TEST_HOME,
        USERPROFILE: TEST_HOME,
        CODEX_HOME: TEST_CODEX_HOME,
        CODEXCOMMANDER_HOME: TEST_CCX_HOME,
      },
      encoding: "utf8",
    });

    expect(child.status).toBe(0);
    const payload = JSON.parse(child.stdout.trim()) as {
      before: boolean;
      during: { kind: string; state?: { nativeGeneration: number; currentTxId: string | null } };
      result: { status: string; ok: boolean; catalogWritten: boolean };
      after: { kind: string; state?: { nativeGeneration: number } };
      config: string;
    };
    expect(payload.before).toBe(false);
    expect(payload.during).toEqual({
      kind: "ready",
      state: { nativeGeneration: 0, currentTxId: null },
    });
    expect(payload.result).toMatchObject({ status: "applied", ok: true, catalogWritten: true });
    expect(payload.after).toMatchObject({ kind: "ready", state: { nativeGeneration: 1 } });
    expect(payload.config).toContain("CodexCommander");
    expect(existsSync(catalogPath)).toBe(true);
  });

  test("service-home refusal happens before coordinator preparation", async () => {
    let prepared = false;
    let refreshed = false;
    let injected = false;
    const result = await syncModelsToCodex(12345, config, null, {
      admitCodexWrite: () => ({
        kind: "refused",
        authority: "service-home",
        message: "another service home owns Codex",
      }),
      prepareCodexTransitionState: () => {
        prepared = true;
        return preparedSync();
      },
      refreshCodexModelCatalog: async () => {
        refreshed = true;
        throw new Error("must not refresh");
      },
      injectCodexConfig: async () => {
        injected = true;
        throw new Error("must not inject");
      },
      currentExternalCodexModelProvider: () => null,
    });

    expect(result).toMatchObject({ status: "refused", authority: "service-home", ok: false });
    expect(prepared).toBe(false);
    expect(refreshed).toBe(false);
    expect(injected).toBe(false);
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";

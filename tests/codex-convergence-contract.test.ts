import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  captureCatalogAdmissionSnapshot,
  captureCatalogConfigAuthority,
  CatalogAdmissionStaleConfigError,
  createCatalogConvergeRequest,
} from "../src/codex/catalog-admission";
import {
  codexCatalogConvergenceReceiptMatchesCurrent,
  commitCodexCatalogCandidate,
  convergeCodexCatalog,
  gatherCodexCatalogCandidate,
  readCodexCatalogConvergenceReceipt,
  resetCodexCatalogConvergenceReceiptForTests,
  type CodexCatalogCandidate,
} from "../src/codex/convergence";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND, resetCatalogRuntimeStateForTests } from "../src/codex/catalog";
import {
  persistCodexRuntime,
  resetCodexRuntimeResolveCacheForTests,
  setCodexRuntimeResolveCacheForTests,
} from "../src/codex/runtime";
import {
  invalidateBundledCatalogCache,
  setBundledCatalogCacheForTests,
} from "../src/codex/catalog/bundled";
import {
  resolveCodexCatalogSerializationDatabasePath,
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { saveConfig } from "../src/config";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import { syncModelsToCodex } from "../src/codex/sync";
import { createManagementConvergeCodex } from "../src/codex/management-convergence";
import { handleManagementAPI } from "../src/server/management-api";
import type { CodexCommanderConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";

let root = "";
let codexHome = "";
let codexCommanderHome = "";
let previousCodexHome: string | undefined;
let previousCodexCommanderHome: string | undefined;
let previousCodexCliPath: string | undefined;

function config(port = 10100): CodexCommanderConfig {
  return {
    port,
    multiAgentGuidanceEnabled: true,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
  };
}

function sourceCatalog(marker = "original"): string {
  return `${JSON.stringify({
    marker,
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Native",
      priority: 1,
      visibility: "list",
      base_instructions: "You are Codex.",
      supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    }],
  }, null, 2)}\n`;
}

function explicitCatalogConvergeRequest() {
  return {
    action: "converge",
    scope: "catalog",
    reason: "api-sync",
    mode: "explicit",
    deadlineMs: 1_000,
  } as const;
}

function writeManagedRouting(): void {
  writeFileSync(join(codexHome, "config.toml"), [
    "# Auto-injected by CodexCommander",
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    'model_catalog_json = "codexcommander-catalog.json"',
    "",
  ].join("\n"));
}

function manifest(base: string): string[] {
  const out: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path, { bigint: true });
      const name = relative(base, path);
      if (entry.isDirectory()) {
        out.push(`${name}|dir|${stat.mode}|${stat.mtimeNs}`);
        visit(path);
      } else {
        const bytes = readFileSync(path);
        out.push(`${name}|file|${stat.mode}|${stat.mtimeNs}|${bytes.length}|${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  };
  visit(base);
  return out.sort();
}

async function candidate(): Promise<CodexCatalogCandidate> {
  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config()));
  expect(gathered.kind).toBe("candidate");
  return (gathered as Extract<typeof gathered, { kind: "candidate" }>).candidate;
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
  previousCodexCliPath = process.env.CODEX_CLI_PATH;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ccx-convergence-")));
  codexHome = join(root, "codex");
  codexCommanderHome = join(root, "codexcommander");
  mkdirSync(codexHome);
  mkdirSync(codexCommanderHome);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEXCOMMANDER_HOME = codexCommanderHome;
  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  resetCodexCatalogConvergenceReceiptForTests();
  saveConfig(config());
  writeFileSync(join(codexHome, "codexcommander-catalog.json"), sourceCatalog());
});

afterEach(() => {
  const identity = resolveEffectiveUserIdentity();
  const kPath = resolveCodexCatalogSerializationDatabasePath(identity, codexHome);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${kPath}${suffix}`, { force: true });
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
  if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCodexCliPath;
  rmSync(root, { recursive: true, force: true });
});

test("T1 gather performs no filesystem write and does not materialize a runtime probe home", async () => {
  process.env.CODEX_CLI_PATH = join(root, "must-not-execute");
  const before = manifest(root);
  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config()));
  expect(gathered.kind).toBe("candidate");
  expect(manifest(root)).toEqual(before);
  expect(existsSync(join(root, "probe-home"))).toBe(false);
  delete process.env.CODEX_CLI_PATH;
});

test("production sync primes a bundled source before an observe-only fresh-home gather", async () => {
  if (process.platform === "win32") return;

  rmSync(join(codexHome, "codexcommander-catalog.json"));
  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  const fakeCodex = join(root, "codex-fixture");
  writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.146.0"
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  cat <<'CCX_CATALOG'
${sourceCatalog("fresh-bundled")}CCX_CATALOG
  exit 0
fi
exit 1
`);
  chmodSync(fakeCodex, 0o700);
  process.env.CODEX_CLI_PATH = fakeCodex;

  const live: CodexCommanderConfig = {
    ...config(),
    defaultProvider: "vendor",
    providers: {
      ...config().providers,
      vendor: {
        adapter: "openai-chat",
        baseUrl: "https://vendor.example/v1",
        liveModels: false,
        models: ["alpha"],
      },
    },
  };
  saveConfig(live);
  const synced = await syncModelsToCodex(10100, live, null, {
    admitCodexWrite: () => ({ kind: "admitted" }),
    prepareCodexTransitionState: () => ({
      kind: "ready",
      state: { nativeGeneration: 0, currentTxId: null },
    }),
    refreshCodexModelCatalog,
    injectCodexConfig: async () => ({ success: true, message: "injected" }),
    currentExternalCodexModelProvider: () => null,
  });
  expect(synced).toMatchObject({
    status: "applied",
    ok: true,
    catalogExists: true,
    catalogWritten: true,
    cacheSynced: true,
    catalogQuality: "live",
  });
  if (!synced.catalogPath) throw new Error("fresh production sync did not expose its catalog path");
  const written = JSON.parse(readFileSync(synced.catalogPath, "utf8")) as {
    models: Array<{ slug?: string }>;
  };
  expect(written.models.map(entry => entry.slug)).toContain("vendor/alpha");
});

test("commit is fixed-order, receipt-exact, and a consumed candidate cannot be replayed", async () => {
  const gathered = await candidate();
  const first = await commitCodexCatalogCandidate(gathered, 1_000);
  expect(first).toEqual({
    kind: "committed",
    changed: true,
    writes: { keyedBackup: "written", catalog: "written", cache: "written" },
  });
  const after = manifest(root);
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({
    kind: "stale",
    reason: "candidate-consumed",
  });
  expect(manifest(root)).toEqual(after);
});

test("a semantic no-op preserves catalog and cache mtimes and reports no artifact writes", async () => {
  const first = await candidate();
  expect((await commitCodexCatalogCandidate(first, 1_000)).kind).toBe("committed");

  const catalogPath = join(codexHome, "codexcommander-catalog.json");
  const cachePath = join(codexHome, "models_cache.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, unknown>;
  const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
  // Exercise semantic equality rather than byte equality: whitespace and object key order differ.
  writeFileSync(catalogPath, JSON.stringify(Object.fromEntries(Object.entries(catalog).reverse())));
  writeFileSync(cachePath, JSON.stringify(Object.fromEntries(Object.entries(cache).reverse())));
  const beforeCatalogMtime = lstatSync(catalogPath, { bigint: true }).mtimeNs;
  const beforeCacheMtime = lstatSync(cachePath, { bigint: true }).mtimeNs;

  const second = await candidate();
  expect(await commitCodexCatalogCandidate(second, 1_000)).toEqual({
    kind: "committed",
    changed: false,
    writes: { keyedBackup: "preserved", catalog: "not-written", cache: "not-written" },
  });
  expect(lstatSync(catalogPath, { bigint: true }).mtimeNs).toBe(beforeCatalogMtime);
  expect(lstatSync(cachePath, { bigint: true }).mtimeNs).toBe(beforeCacheMtime);
});

test("a committed semantic no-op republishes its receipt, accepts native cache churn, and detects catalog drift", async () => {
  const request = explicitCatalogConvergeRequest();
  const first = await convergeCodexCatalog(captureCatalogAdmissionSnapshot(config()), request);
  expect(first.catalogRefresh.status).toBe("committed");

  resetCodexCatalogConvergenceReceiptForTests();
  const noOp = await convergeCodexCatalog(captureCatalogAdmissionSnapshot(config()), request);
  expect(noOp).toMatchObject({
    changed: false,
    catalogRefresh: { status: "committed", changed: false },
  });
  expect(readCodexCatalogConvergenceReceipt()).toMatchObject({
    targets: {
      catalogPath: join(codexHome, "codexcommander-catalog.json"),
      cachePath: join(codexHome, "models_cache.json"),
    },
  });

  const catalogPath = join(codexHome, "codexcommander-catalog.json");
  const cachePath = join(codexHome, "models_cache.json");
  const matches = (current: CodexCommanderConfig) => codexCatalogConvergenceReceiptMatchesCurrent({
    config: current,
    catalogPath,
  });
  expect(matches({ ...config(), multiAgentV2MessageDelivery: "plaintext" })).toBe(true);
  expect(matches({ ...config(), shutdownTimeoutMs: 1_234 })).toBe(true);
  expect(matches({ ...config(), websockets: true })).toBe(false);
  // The global cap value is a setter default, not a catalog input until one or
  // more concrete providerContextCaps entries are enabled.
  expect(matches({ ...config(), contextCapValue: 32_000 })).toBe(true);
  expect(matches({ ...config(), providerContextCaps: { openai: 32_000 } })).toBe(false);

  const nativeConfigPath = join(codexHome, "config.toml");
  writeFileSync(nativeConfigPath, "[features]\nmulti_agent_v2 = true\n");
  expect(matches(config())).toBe(false);
  rmSync(nativeConfigPath);
  expect(matches(config())).toBe(true);

  const catalogBytesBefore = readFileSync(catalogPath, "utf8");
  const catalog = JSON.parse(catalogBytesBefore) as { models: Array<Record<string, unknown>> };
  catalog.models[0]!.display_name = "same-slug metadata drift";
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  expect(matches(config())).toBe(false);

  writeFileSync(catalogPath, catalogBytesBefore);
  expect(matches(config())).toBe(true);
  const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
  cache.client_version = "same-roster cache drift";
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  expect(matches(config())).toBe(true);
  rmSync(cachePath);
  expect(matches(config())).toBe(true);
});

test("a partial catalog commit publishes no convergence receipt", async () => {
  if (process.platform === "win32") return;

  const selectedDir = join(root, "selected-catalog-parent");
  const selectedCatalog = join(selectedDir, "catalog.json");
  mkdirSync(selectedDir);
  writeFileSync(selectedCatalog, sourceCatalog("selected"));
  writeFileSync(
    join(codexHome, "config.toml"),
    `model_catalog_json = ${JSON.stringify(selectedCatalog)}\n`,
  );
  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config()));
  expect(gathered.kind).toBe("candidate");
  if (gathered.kind !== "candidate") throw new Error(JSON.stringify(gathered));

  resetCodexCatalogConvergenceReceiptForTests();
  chmodSync(codexHome, 0o500);
  try {
    expect(await commitCodexCatalogCandidate(gathered.candidate, 1_000)).toEqual({
      kind: "failed",
      surface: "disk",
      writes: { keyedBackup: "written", catalog: "written", cache: "not-written" },
    });
  } finally {
    chmodSync(codexHome, 0o700);
  }
  expect(readCodexCatalogConvergenceReceipt()).toBeNull();
});

test("a cache write before retained-LKG failure is reported as a partial commit", async () => {
  if (process.platform === "win32") return;

  const live: CodexCommanderConfig = {
    ...config(),
    defaultProvider: "vendor",
    providers: {
      ...config().providers,
      vendor: {
        adapter: "openai-chat",
        baseUrl: "https://vendor.example/v1",
        liveModels: false,
        models: ["alpha"],
      },
    },
  };
  saveConfig(live);
  expect((await convergeCodexCatalog(
    captureCatalogAdmissionSnapshot(live),
    explicitCatalogConvergeRequest(),
  )).catalogRefresh.status).toBe("committed");

  const cachePath = join(codexHome, "models_cache.json");
  const retainedPath = join(codexCommanderHome, "codex-routed-retained.json");
  expect(readFileSync(retainedPath, "utf8")).toContain("vendor/alpha");
  const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
  cache.client_version = "drifted-before-partial";
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  rmSync(retainedPath);
  const blockedRetainedDir = join(root, "blocked-retained-parent");
  const blockedRetainedTarget = join(blockedRetainedDir, "retained.json");
  mkdirSync(blockedRetainedDir);
  writeFileSync(blockedRetainedTarget, '{"models":[]}\n');
  symlinkSync(blockedRetainedTarget, retainedPath);
  chmodSync(blockedRetainedDir, 0o500);
  resetCatalogRuntimeStateForTests();

  const result = await convergeCodexCatalog(
    captureCatalogAdmissionSnapshot(live),
    explicitCatalogConvergeRequest(),
  ).finally(() => chmodSync(blockedRetainedDir, 0o700));
  expect(result.catalogRefresh).toEqual({
    status: "failed",
    reason: "disk",
    phase: "commit",
    retryable: false,
    partialWrite: true,
  });
  expect(result.projection).toMatchObject({ catalogWritten: false, cacheSynced: true });
  expect(readCodexCatalogConvergenceReceipt()).toBeNull();
});

test("artifact no-op detection is independent when only the cache has drifted", async () => {
  const first = await candidate();
  expect((await commitCodexCatalogCandidate(first, 1_000)).kind).toBe("committed");

  const catalogPath = join(codexHome, "codexcommander-catalog.json");
  const cachePath = join(codexHome, "models_cache.json");
  const catalogMtime = lstatSync(catalogPath, { bigint: true }).mtimeNs;
  const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
  cache.client_version = "drifted";
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);

  const second = await candidate();
  expect(await commitCodexCatalogCandidate(second, 1_000)).toEqual({
    kind: "committed",
    changed: true,
    writes: { keyedBackup: "preserved", catalog: "not-written", cache: "written" },
  });
  expect(lstatSync(catalogPath, { bigint: true }).mtimeNs).toBe(catalogMtime);
  expect((JSON.parse(readFileSync(cachePath, "utf8")) as { client_version: string }).client_version).toBe("0.0.0");
});

test("generation drift rejects before every catalog target write", async () => {
  const gathered = await candidate();
  const before = manifest(codexHome);
  saveConfig(config(20200));
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({ kind: "stale", reason: "generation" });
  expect(manifest(codexHome)).toEqual(before);
});

test("admission cannot bind stale decoded config A to already-current generation B", () => {
  const stale = config();
  saveConfig(config(20200));
  expect(() => captureCatalogAdmissionSnapshot(stale)).toThrow(CatalogAdmissionStaleConfigError);
});

test("management convergence projects stale config authority as a retryable stale skip", async () => {
  writeManagedRouting();
  const stale = config();
  saveConfig(config(20200));
  const outcome = await createManagementConvergeCodex(stale)(
    createCatalogConvergeRequest({ deadlineMs: 1_000 }),
  );
  expect(outcome).toMatchObject({
    kind: "catalog-only",
    changed: false,
    catalogRefresh: { status: "skipped", reason: "stale", retryable: true },
  });
});

test("manual config-byte drift is rejected even when it did not bump generation", () => {
  const admitted = config();
  writeFileSync(join(codexCommanderHome, "config.json"), `${JSON.stringify(config(30300), null, 2)}\n`);
  expect(() => captureCatalogAdmissionSnapshot(admitted)).toThrow(CatalogAdmissionStaleConfigError);
});

test("manual equivalent-byte rewrite after gather is fenced before publication", async () => {
  const gathered = await candidate();
  const configPath = join(codexCommanderHome, "config.json");
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as CodexCommanderConfig;
  writeFileSync(configPath, JSON.stringify(parsed));
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({
    kind: "stale",
    reason: "generation",
  });
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("config authority keeps a monotonic ABA fence while preserving semantic identity", () => {
  const a = config();
  const before = captureCatalogConfigAuthority(a);
  saveConfig(config(20200));
  saveConfig(a);
  const after = captureCatalogConfigAuthority(a);
  expect(after.semanticIdentity).toBe(before.semanticIdentity);
  expect(after.generation.value).toBeGreaterThan(before.generation.value);
});

test("production sync cannot publish stale config A after save B wins after gather", async () => {
  const a: CodexCommanderConfig = {
    ...config(),
    defaultProvider: "vendor",
    providers: {
      ...config().providers,
      vendor: {
        adapter: "openai-chat",
        baseUrl: "https://vendor.example/v1",
        liveModels: false,
        models: ["alpha"],
      },
    },
  };
  saveConfig(a);
  const catalogPath = join(codexHome, "codexcommander-catalog.json");
  const before = readFileSync(catalogPath, "utf8");
  let injected = false;
  let savedB = false;
  const result = await syncModelsToCodex(10100, a, null, {
    admitCodexWrite: () => ({ kind: "admitted" }),
    prepareCodexTransitionState: () => ({
      kind: "ready",
      state: { nativeGeneration: 0, currentTxId: null },
    }),
    refreshCodexModelCatalog: current => refreshCodexModelCatalog(current, {
      captureCatalogAdmissionSnapshot,
      prepareConfigGeneration: () => {},
      existsSync,
      convergeCodexCatalog: (snapshot, request) => convergeCodexCatalog(snapshot, request, {
        onCommitBegin: () => {
          savedB = true;
          saveConfig({ ...a, port: 20200 });
        },
      }),
    }),
    injectCodexConfig: async () => {
      injected = true;
      return { success: true, message: "must not inject" };
    },
    currentExternalCodexModelProvider: () => null,
  });
  expect(savedB).toBe(true);
  expect(result).toMatchObject({ status: "refused", ok: false });
  expect(result.message).toContain("configuration changed during catalog discovery");
  expect(injected).toBe(false);
  expect(readFileSync(catalogPath, "utf8")).toBe(before);
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
  expect(existsSync(join(codexCommanderHome, "codex-routed-retained.json"))).toBe(false);
});

test("home-selection drift rejects before every catalog target write", async () => {
  const gathered = await candidate();
  const other = join(root, "other-codex");
  mkdirSync(other);
  process.env.CODEX_HOME = other;
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({ kind: "stale", reason: "home-selection" });
  expect(readdirSync(other)).toEqual([]);
});

test("same-inode source drift rejects before every catalog target write", async () => {
  const gathered = await candidate();
  const path = join(codexHome, "codexcommander-catalog.json");
  const inode = lstatSync(path).ino;
  writeFileSync(path, sourceCatalog("drifted"));
  expect(lstatSync(path).ino).toBe(inode);
  const drifted = readFileSync(path, "utf8");
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({ kind: "stale", reason: "source-observation" });
  expect(readFileSync(path, "utf8")).toBe(drifted);
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("target identity drift wins before source comparison and writes nothing", async () => {
  const gathered = await candidate();
  const path = join(codexHome, "codexcommander-catalog.json");
  const moved = join(codexHome, "moved.json");
  renameSync(path, moved);
  writeFileSync(path, readFileSync(moved));
  const before = readFileSync(path, "utf8");
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({ kind: "stale", reason: "target-identity" });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("used process-local authority drift rejects before every catalog target write", async () => {
  const runtime = { command: "/tmp/codex", version: "0.146.0", source: "environment" as const };
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] }, { discoverAlternatives: false });
  setBundledCatalogCacheForTests(runtime, JSON.parse(sourceCatalog("bundled")) as never);
  const gathered = await candidate();
  invalidateBundledCatalogCache();
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({ kind: "stale", reason: "process-local" });
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("a routed-only active catalog cannot hide native Codex models from the source catalog", async () => {
  const live = config();
  live.providers.xai = {
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authMode: "oauth",
    liveModels: false,
    models: ["grok-4.5"],
  };
  saveConfig(live);
  writeFileSync(join(codexHome, "codexcommander-catalog.json"), `${JSON.stringify({
    models: [{
      slug: "xai/grok-4.5",
      description: "Routed via CodexCommander → xai (xai).",
      priority: 5,
    }],
  }, null, 2)}\n`);

  const runtime = { command: "/tmp/codex", version: "0.146.0", source: "environment" as const };
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] });
  setBundledCatalogCacheForTests(runtime, JSON.parse(sourceCatalog("bundled")) as never);

  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(live));
  expect(gathered.kind).toBe("candidate");
  const committed = await commitCodexCatalogCandidate(
    (gathered as Extract<typeof gathered, { kind: "candidate" }>).candidate,
    1_000,
  );
  expect(committed.kind).toBe("committed");

  const slugs = (JSON.parse(readFileSync(join(codexHome, "codexcommander-catalog.json"), "utf8")) as {
    models: Array<{ slug: string }>;
  }).models.map(model => model.slug);
  expect(slugs).toContain("gpt-5.6-sol");
  expect(slugs).toContain("xai/grok-4.5");
  const cachedSlugs = (JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8")) as {
    models: Array<{ slug: string }>;
  }).models.map(model => model.slug);
  expect(cachedSlugs).toContain("gpt-5.6-sol");
  expect(cachedSlugs).toContain("xai/grok-4.5");
});

test("catalog-only commit never creates the native pair or routing artifacts", async () => {
  const gathered = await candidate();
  expect((await commitCodexCatalogCandidate(gathered, 1_000)).kind).toBe("committed");
  const nativeDb = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), codexHome);
  expect(existsSync(nativeDb)).toBe(false);
  expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
  expect(manifest(root).join("\n")).not.toContain("journal");
});

test("management convergence restores omitted natives and commits one configured native alias", async () => {
  const runtime = { command: "/tmp/codex", version: "0.146.0", source: "environment" as const };
  const bundled = JSON.parse(sourceCatalog("bundled")) as { models: Array<Record<string, unknown>> };
  bundled.models.push({
    ...bundled.models[0],
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
  });
  persistCodexRuntime(runtime, { configDir: codexCommanderHome, now: () => 0 });
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] }, { discoverAlternatives: false });
  setBundledCatalogCacheForTests(runtime, bundled as never);

  writeFileSync(join(codexHome, "codexcommander-catalog.json"), `${JSON.stringify({
    models: [{
      ...bundled.models[0],
      display_name: "Nova1 - Sol",
      description: "Routed via CodexCommander → combo (combo).",
      owned_by: "combo",
      codexcommander_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
      input_modalities: ["text", "image"],
    }],
  }, null, 2)}\n`);

  const live: CodexCommanderConfig = {
    ...config(),
    defaultProvider: "Nova1",
    providers: {
      ...config().providers,
      Nova1: {
        adapter: "openai-chat",
        baseUrl: "https://nova.example/v1",
        liveModels: false,
        models: [],
      },
    },
    combos: {
      nova: {
        alias: "gpt-5.6-sol",
        nativeAlias: true,
        displayName: "Nova1 - Sol",
        targets: [{ provider: "Nova1", model: "codex/gpt-5.6-sol" }],
      },
    },
  };
  saveConfig(live);

  const beforeGather = manifest(root);
  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(live));
  expect(gathered.kind).toBe("candidate");
  expect(manifest(root)).toEqual(beforeGather);
  if (gathered.kind !== "candidate") throw new Error(JSON.stringify(gathered));
  const committed = await commitCodexCatalogCandidate(gathered.candidate, 1_000);
  expect(committed).toMatchObject({ kind: "committed" });

  const written = JSON.parse(readFileSync(join(codexHome, "codexcommander-catalog.json"), "utf8")) as {
    models: Array<Record<string, unknown>>;
  };
  expect(written.models.find(entry => entry.slug === "gpt-5.5")).toMatchObject({
    display_name: "GPT-5.5",
  });
  expect(written.models.filter(entry => entry.slug === "gpt-5.6-sol")).toEqual([
    expect.objectContaining({
      display_name: "Nova1 - Sol",
      owned_by: "combo",
      codexcommander_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
    }),
  ]);
}, { timeout: 20_000 });

test("management convergence rehydrates a missing configured provider from admitted retained bytes", async () => {
  const runtime = { command: "/tmp/codex", version: "0.146.0", source: "environment" as const };
  const bundled = JSON.parse(sourceCatalog("bundled-retained")) as {
    models: Array<Record<string, unknown>>;
  };
  persistCodexRuntime(runtime, { configDir: codexCommanderHome, now: () => 0 });
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] }, { discoverAlternatives: false });
  setBundledCatalogCacheForTests(runtime, bundled as never);

  const retainedPeer = {
    ...bundled.models[0],
    slug: "peer/beta",
    display_name: "peer/beta",
    description: "Routed via CodexCommander → peer (peer).",
    owned_by: "peer",
    input_modalities: ["text"],
  };
  writeFileSync(join(codexCommanderHome, "codex-routed-retained.json"), `${JSON.stringify({
    models: [retainedPeer],
  }, null, 2)}\n`);

  const live: CodexCommanderConfig = {
    ...config(),
    defaultProvider: "vendor",
    providers: {
      ...config().providers,
      vendor: {
        adapter: "openai-chat",
        baseUrl: "https://vendor.example/v1",
        liveModels: false,
        models: ["alpha"],
      },
      peer: {
        adapter: "openai-chat",
        baseUrl: "https://peer.example/v1",
      },
    },
  };
  saveConfig(live);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith("https://peer.example/")) {
      return new Response("unavailable", { status: 503 });
    }
    throw new Error(`unexpected fetch: ${String(input)}`);
  }) as typeof fetch;
  try {
    const beforeGather = manifest(root);
    const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(live));
    expect(gathered.kind).toBe("candidate");
    expect(manifest(root)).toEqual(beforeGather);
    if (gathered.kind !== "candidate") throw new Error(JSON.stringify(gathered));
    expect((await commitCodexCatalogCandidate(gathered.candidate, 1_000)).kind).toBe("committed");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const written = JSON.parse(readFileSync(join(codexHome, "codexcommander-catalog.json"), "utf8")) as {
    models: Array<{ slug?: string }>;
  };
  const slugs = written.models.map(entry => entry.slug);
  expect(slugs).toContain("vendor/alpha");
  expect(slugs).toContain("peer/beta");
}, { timeout: 20_000 });

test("canonical live convergence advances retained LKG idempotently and outage recovery uses it", async () => {
  const live: CodexCommanderConfig = {
    ...config(),
    defaultProvider: "vendor",
    providers: {
      ...config().providers,
      vendor: {
        adapter: "openai-chat",
        baseUrl: "https://vendor.example/v1",
        liveModels: false,
        models: ["alpha"],
      },
    },
  };
  saveConfig(live);

  const first = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(live));
  expect(first.kind).toBe("candidate");
  if (first.kind !== "candidate") throw new Error(JSON.stringify(first));
  expect((await commitCodexCatalogCandidate(first.candidate, 1_000)).kind).toBe("committed");

  const retainedPath = join(codexCommanderHome, "codex-routed-retained.json");
  const retained = readFileSync(retainedPath, "utf8");
  expect((JSON.parse(retained) as { models: Array<{ slug?: string }> }).models.map(row => row.slug))
    .toContain("vendor/alpha");
  const sentinel = new Date("2000-01-01T00:00:00.000Z");
  utimesSync(retainedPath, sentinel, sentinel);
  const retainedMtime = lstatSync(retainedPath, { bigint: true }).mtimeNs;

  const repeated = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(live));
  expect(repeated.kind).toBe("candidate");
  if (repeated.kind !== "candidate") throw new Error(JSON.stringify(repeated));
  expect(await commitCodexCatalogCandidate(repeated.candidate, 1_000)).toMatchObject({
    kind: "committed",
    changed: false,
  });
  expect(readFileSync(retainedPath, "utf8")).toBe(retained);
  expect(lstatSync(retainedPath, { bigint: true }).mtimeNs).toBe(retainedMtime);

  const outage: CodexCommanderConfig = {
    ...live,
    providers: {
      ...live.providers,
      vendor: {
        adapter: "openai-chat",
        baseUrl: "https://vendor.example/v1",
      },
    },
  };
  saveConfig(outage);
  writeFileSync(join(codexHome, "codexcommander-catalog.json"), sourceCatalog("restored-native"));
  resetCatalogRuntimeStateForTests();

  const recovered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(outage));
  expect(recovered.kind).toBe("candidate");
  if (recovered.kind !== "candidate") throw new Error(JSON.stringify(recovered));
  expect((await commitCodexCatalogCandidate(recovered.candidate, 1_000)).kind).toBe("committed");
  const active = JSON.parse(readFileSync(join(codexHome, "codexcommander-catalog.json"), "utf8")) as {
    models: Array<{ slug?: string }>;
  };
  expect(active.models.map(row => row.slug)).toContain("vendor/alpha");
}, { timeout: 20_000 });

test("management Save and production sync publish identical catalog, cache, and retained bytes", async () => {
  writeManagedRouting();
  const live: CodexCommanderConfig = {
    ...config(),
    defaultProvider: "vendor",
    providers: {
      ...config().providers,
      vendor: {
        adapter: "openai-chat",
        baseUrl: "https://vendor.example/v1",
        liveModels: false,
        models: ["alpha"],
      },
    },
  };
  saveConfig(live);
  const management = await convergeCodexCatalog(
    captureCatalogAdmissionSnapshot(live),
    createCatalogConvergeRequest({ deadlineMs: 1_000 }),
  );
  expect(management.catalogRefresh.status).toBe("committed");

  const catalogPath = join(codexHome, "codexcommander-catalog.json");
  const cachePath = join(codexHome, "models_cache.json");
  const retainedPath = join(codexCommanderHome, "codex-routed-retained.json");
  const expected = {
    catalog: readFileSync(catalogPath, "utf8"),
    cache: readFileSync(cachePath, "utf8"),
    retained: readFileSync(retainedPath, "utf8"),
  };

  writeFileSync(catalogPath, sourceCatalog());
  rmSync(cachePath, { force: true });
  rmSync(retainedPath, { force: true });
  const injected: Array<{
    catalogPath?: string | null;
    generation?: number;
    configContentIdentity?: string;
  }> = [];
  const synced = await syncModelsToCodex(10100, live, null, {
    admitCodexWrite: () => ({ kind: "admitted" }),
    prepareCodexTransitionState: () => ({
      kind: "ready",
      state: { nativeGeneration: 0, currentTxId: null },
    }),
    refreshCodexModelCatalog,
    injectCodexConfig: async (_port, _config, options) => {
      injected.push({
        catalogPath: options.catalogPath,
        generation: options.expectedConfigGeneration?.value,
        configContentIdentity: options.expectedConfigAuthority?.contentIdentity,
      });
      return { success: true, message: "injected" };
    },
    currentExternalCodexModelProvider: () => null,
  });

  expect(synced).toMatchObject({
    status: "applied",
    ok: true,
    catalogWritten: true,
    cacheSynced: true,
    catalogQuality: "live",
  });
  const admittedAuthority = captureCatalogConfigAuthority(live);
  expect(injected).toEqual([{
    catalogPath,
    generation: admittedAuthority.generation.value,
    configContentIdentity: admittedAuthority.contentIdentity,
  }]);
  expect({
    catalog: readFileSync(catalogPath, "utf8"),
    cache: readFileSync(cachePath, "utf8"),
    retained: readFileSync(retainedPath, "utf8"),
  }).toEqual(expected);

  const sentinel = new Date("2000-01-01T00:00:00.000Z");
  for (const path of [catalogPath, cachePath, retainedPath]) utimesSync(path, sentinel, sentinel);
  const mtimes = [catalogPath, cachePath, retainedPath]
    .map(path => lstatSync(path, { bigint: true }).mtimeNs);
  const noOp = await syncModelsToCodex(10100, live, null, {
    admitCodexWrite: () => ({ kind: "admitted" }),
    prepareCodexTransitionState: () => ({
      kind: "ready",
      state: { nativeGeneration: 0, currentTxId: null },
    }),
    refreshCodexModelCatalog,
    injectCodexConfig: async () => ({ success: true, message: "injected" }),
    currentExternalCodexModelProvider: () => null,
  });
  expect(noOp).toMatchObject({
    status: "applied",
    ok: true,
    added: 0,
    catalogWritten: false,
    cacheSynced: false,
    catalogQuality: "live",
  });
  expect([catalogPath, cachePath, retainedPath]
    .map(path => lstatSync(path, { bigint: true }).mtimeNs)).toEqual(mtimes);
});

test("management convergence clamps routed efforts to the admitted Codex catalog ladder", async () => {
  const runtime = { command: "/tmp/codex", version: "0.146.0", source: "environment" as const };
  const bundled = JSON.parse(sourceCatalog("bundled-efforts")) as {
    models: Array<Record<string, unknown>>;
  };
  bundled.models[0]!.supported_reasoning_levels = ["low", "medium", "high", "xhigh"]
    .map(effort => ({ effort, description: effort }));
  persistCodexRuntime(runtime, { configDir: codexCommanderHome, now: () => 0 });
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] }, { discoverAlternatives: false });
  setBundledCatalogCacheForTests(runtime, bundled as never);

  const live: CodexCommanderConfig = {
    ...config(),
    defaultProvider: "vendor",
    providers: {
      ...config().providers,
      vendor: {
        adapter: "openai-chat",
        baseUrl: "https://vendor.example/v1",
        liveModels: false,
        models: ["alpha"],
      },
    },
  };
  saveConfig(live);

  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(live));
  expect(gathered.kind).toBe("candidate");
  if (gathered.kind !== "candidate") throw new Error(JSON.stringify(gathered));
  expect((await commitCodexCatalogCandidate(gathered.candidate, 1_000)).kind).toBe("committed");

  const written = JSON.parse(readFileSync(join(codexHome, "codexcommander-catalog.json"), "utf8")) as {
    models: Array<{ slug?: string; supported_reasoning_levels?: Array<{ effort?: string }> }>;
  };
  const routed = written.models.find(entry => entry.slug === "vendor/alpha");
  const efforts = routed?.supported_reasoning_levels?.map(level => level.effort) ?? [];
  expect(efforts).toEqual(["low", "medium", "high", "xhigh"]);
  expect(efforts).not.toContain("max");
  expect(efforts).not.toContain("ultra");
}, { timeout: 20_000 });

test("the total lazy adapter preserves a persisted-success route when factory construction fails", async () => {
  const live = config();
  const request = new ManagementRequest("http://localhost/api/disabled-models", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ models: ["gpt-5.6-sol"] }),
  });
  const response = await handleManagementAPI(request, new URL(request.url), live, {
    saveConfigPreservingClaudeCode: () => {},
    createManagementConvergeCodex: () => { throw new Error("factory exploded"); },
  });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    ok: true,
    disabled: ["gpt-5.6-sol"],
    catalogRefresh: {
      status: "failed",
      reason: "disk",
      phase: "gather",
      partialWrite: false,
    },
  });
});

test("the route inventory contains exactly the specified 6 + 6 + 2 + 2 convergence calls", () => {
  const counts = Object.fromEntries([
    ["provider-routes.ts", 6],
    ["model-routes.ts", 6],
    ["combo-routes.ts", 2],
    ["agent-settings-routes.ts", 2],
  ].map(([file, expected]) => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "server", "management", file as string), "utf8");
    const count = source.match(/await convergeCodexCatalog\([^)]*\)/g)?.length ?? 0;
    expect(count).toBe(expected);
    expect(source).not.toContain("refreshCodexCatalogBestEffort");
    return [file, count];
  }));
  expect(counts).toEqual({
    "provider-routes.ts": 6,
    "model-routes.ts": 6,
    "combo-routes.ts": 2,
    "agent-settings-routes.ts": 2,
  });
});

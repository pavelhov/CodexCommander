import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

interface LifecycleResult {
  coordinatorKind: string;
  gatherKind: string;
  commitKind: string;
  commitChanged: boolean;
  publishedCatalogSlugs: string[];
  publishedCacheSlugs: string[];
  injected: {
    success: boolean;
    message: string;
    keepsNativeProviderIdentity: boolean;
    pointsAtProxy: boolean;
    advertisesPublishedCatalog: boolean;
  };
  restored: {
    success: boolean;
    message: string;
    exactNativeConfig: boolean;
    catalogSlugs: string[];
  };
  projectDataUnchanged: {
    afterCatalogCommit: boolean;
    afterInjection: boolean;
    afterRestore: boolean;
  };
}

let root = "";
let codexHome = "";
let codexCommanderHome = "";
let statePath = "";
let rolloutPaths: string[] = [];
let stateBefore: Buffer;
let rolloutsBefore: Buffer[] = [];

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runLifecycle(nativeConfig: string): { result: LifecycleResult; stderr: string } {
  const script = String.raw`
    const { createHash } = require("node:crypto");
    const { readFileSync, rmSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");

    const codexHome = process.env.CODEX_HOME;
    const protectedPaths = JSON.parse(process.env.TEST_PROTECTED_PATHS);
    const nativeConfig = Buffer.from(process.env.TEST_NATIVE_CONFIG_BASE64, "base64").toString("utf8");
    const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
    const protectedHashes = Object.fromEntries(protectedPaths.map(path => [path, hash(path)]));
    const projectDataUnchanged = () => protectedPaths.every(path => hash(path) === protectedHashes[path]);
    const slugs = path => JSON.parse(readFileSync(path, "utf8")).models.map(model => model.slug);

    const config = {
      port: 10100,
      multiAgentGuidanceEnabled: true,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "oauth",
          liveModels: false,
          models: ["grok-4.5"],
        },
      },
      defaultProvider: "openai",
    };
    const nativeCatalog = {
      marker: "hermetic-native-source",
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        description: "Native",
        priority: 1,
        visibility: "list",
        supported_in_api: true,
        shell_type: "shell_command",
        base_instructions: "You are Codex.",
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
      }],
    };

    const cleanupPaths = [];
    try {
      const { saveConfig } = require("./src/config");
      const { captureCatalogAdmissionSnapshot } = require("./src/codex/catalog-admission");
      const { gatherCodexCatalogCandidate, commitCodexCatalogCandidate } = require("./src/codex/convergence");
      const { injectCodexConfig, restoreNativeCodexAsync } = require("./src/codex/inject");
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      const { setCodexRuntimeResolveCacheForTests } = require("./src/codex/runtime");
      const { setBundledCatalogCacheForTests } = require("./src/codex/catalog/bundled");
      const {
        resolveCodexCatalogSerializationDatabasePath,
        resolveCodexCoordinatorDatabasePath,
        resolveEffectiveUserIdentity,
      } = require("./src/codex/user-identity");

      const identity = resolveEffectiveUserIdentity();
      cleanupPaths.push(
        resolveCodexCatalogSerializationDatabasePath(identity, codexHome),
        resolveCodexCoordinatorDatabasePath(identity, codexHome),
      );

      saveConfig(config);
      // Production sync establishes N while Codex is still native, before a routed
      // catalog is published. Exercise that same public lifecycle edge here.
      const coordinator = readCodexTransitionState();
      if (coordinator.kind !== "ready") throw new Error("coordinator preparation failed: " + coordinator.kind);
      const catalogPath = join(codexHome, "codexcommander-catalog.json");
      // Reproduce the incident input only after the normal lifecycle has established
      // its coordinator: Codex's active catalog contains routed rows and no natives.
      writeFileSync(catalogPath, JSON.stringify({
        models: [{
          slug: "xai/grok-4.5",
          description: "Routed via CodexCommander → xai (xai).",
          priority: 5,
        }],
      }, null, 2) + "\n");
      const runtime = { command: "/tmp/codex-hermetic-fixture", version: "0.146.0", source: "environment" };
      setCodexRuntimeResolveCacheForTests({ runtime, failures: [] });
      setBundledCatalogCacheForTests(runtime, nativeCatalog);

      const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config));
      if (gathered.kind !== "candidate") throw new Error("catalog gather did not produce a candidate");
      const committed = await commitCodexCatalogCandidate(gathered.candidate, 1_000);
      if (committed.kind !== "committed") throw new Error("catalog commit did not complete: " + committed.kind);

      const cachePath = join(codexHome, "models_cache.json");
      const afterCatalogCommit = projectDataUnchanged();
      const publishedCatalogSlugs = slugs(catalogPath);
      const publishedCacheSlugs = slugs(cachePath);

      const injection = await injectCodexConfig(10100, config, { catalogPath });
      const afterInjection = projectDataUnchanged();
      const injectedConfig = readFileSync(join(codexHome, "config.toml"), "utf8");

      const restore = await restoreNativeCodexAsync();
      const afterRestore = projectDataUnchanged();
      const restoredCatalogSlugs = slugs(catalogPath);

      console.log(JSON.stringify({
        coordinatorKind: coordinator.kind,
        gatherKind: gathered.kind,
        commitKind: committed.kind,
        commitChanged: committed.changed,
        publishedCatalogSlugs,
        publishedCacheSlugs,
        injected: {
          success: injection.success,
          message: injection.message,
          keepsNativeProviderIdentity: !injectedConfig.includes('model_provider = "codexcommander"'),
          pointsAtProxy: injectedConfig.includes('openai_base_url = "http://127.0.0.1:10100/v1"'),
          advertisesPublishedCatalog: injectedConfig.includes('model_catalog_json = "' + catalogPath.replaceAll("\\", "\\\\") + '"'),
        },
        restored: {
          success: restore.success,
          message: restore.message,
          exactNativeConfig: readFileSync(join(codexHome, "config.toml"), "utf8") === nativeConfig,
          catalogSlugs: restoredCatalogSlugs,
        },
        projectDataUnchanged: { afterCatalogCommit, afterInjection, afterRestore },
      }));
    } finally {
      for (const path of cleanupPaths) {
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
          try { rmSync(path + suffix, { force: true }); } catch {}
        }
      }
    }
  `;

  const child = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEXCOMMANDER_HOME: codexCommanderHome,
      TEST_NATIVE_CONFIG_BASE64: Buffer.from(nativeConfig).toString("base64"),
      TEST_PROTECTED_PATHS: JSON.stringify([statePath, ...rolloutPaths]),
    },
    encoding: "utf8",
  });
  if (child.status !== 0) {
    throw new Error(`lifecycle child failed (${child.status}):\n${child.stderr || child.stdout}`);
  }
  const line = child.stdout.trim().split("\n").at(-1);
  if (!line) throw new Error(`lifecycle child returned no result:\n${child.stderr}`);
  return { result: JSON.parse(line) as LifecycleResult, stderr: child.stderr.trim() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccx-project-continuity-"));
  codexHome = join(root, "codex");
  codexCommanderHome = join(root, "codexcommander");
  mkdirSync(codexHome);
  mkdirSync(codexCommanderHome);

  rolloutPaths = [
    join(codexHome, "sessions", "2026", "08", "09", "rollout-sherpa.jsonl"),
    join(codexHome, "sessions", "2026", "08", "09", "rollout-website.jsonl"),
  ];
  mkdirSync(dirname(rolloutPaths[0]), { recursive: true });
  const rolloutBytes = [
    Buffer.from('{"type":"session_meta","payload":{"id":"thread-sherpa","cwd":"/work/Sherpa","model_provider":"openai"}}\n{"type":"event_msg","payload":{"type":"user_message","message":"keep sherpa"}}\n'),
    Buffer.from('{"type":"session_meta","payload":{"id":"thread-website","cwd":"/work/pavelhov_website","model_provider":"openai"}}\n{"type":"event_msg","payload":{"type":"user_message","message":"keep website"}}\n'),
  ];
  rolloutPaths.forEach((path, index) => writeFileSync(path, rolloutBytes[index]!));

  statePath = join(codexHome, "state_5.sqlite");
  const state = new Database(statePath);
  state.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    cwd TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    model_provider TEXT NOT NULL
  )`);
  const insert = state.prepare("INSERT INTO threads VALUES (?, ?, ?, 'app', ?, 'openai')");
  insert.run("thread-sherpa", rolloutPaths[0]!, "/work/Sherpa", "Sherpa project");
  insert.run("thread-website", rolloutPaths[1]!, "/work/pavelhov_website", "Website project");
  state.close();

  stateBefore = readFileSync(statePath);
  rolloutsBefore = rolloutPaths.map(path => readFileSync(path));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("catalog apply and native restore preserve Codex projects, threads, and rollouts", () => {
  const nativeConfig = [
    'model = "gpt-5.6-sol"',
    'model_provider = "openai"',
    "",
    '[projects."/work/Sherpa"]',
    'trust_level = "trusted"',
    "",
    '[projects."/work/pavelhov_website"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");
  writeFileSync(join(codexHome, "config.toml"), nativeConfig);

  const { result, stderr } = runLifecycle(nativeConfig);

  expect(stderr).toBe("");
  expect(result).toMatchObject({
    coordinatorKind: "ready",
    gatherKind: "candidate",
    commitKind: "committed",
    commitChanged: true,
    injected: {
      success: true,
      keepsNativeProviderIdentity: true,
      pointsAtProxy: true,
      advertisesPublishedCatalog: true,
    },
    restored: {
      success: true,
      exactNativeConfig: true,
    },
    projectDataUnchanged: {
      afterCatalogCommit: true,
      afterInjection: true,
      afterRestore: true,
    },
  });
  expect(result.publishedCatalogSlugs).toEqual(expect.arrayContaining(["gpt-5.6-sol", "xai/grok-4.5"]));
  expect(result.publishedCacheSlugs).toEqual(expect.arrayContaining(["gpt-5.6-sol", "xai/grok-4.5"]));
  expect(result.restored.catalogSlugs).toContain("gpt-5.6-sol");
  expect(result.restored.catalogSlugs).not.toContain("xai/grok-4.5");

  expect(readFileSync(statePath).equals(stateBefore)).toBe(true);
  rolloutPaths.forEach((path, index) => {
    expect(readFileSync(path).equals(rolloutsBefore[index]!)).toBe(true);
  });
  expect(digest(statePath)).toBe(createHash("sha256").update(stateBefore).digest("hex"));

  const state = new Database(statePath, { readonly: true });
  expect(state.query("SELECT id, cwd, title, model_provider FROM threads ORDER BY id").all()).toEqual([
    { id: "thread-sherpa", cwd: "/work/Sherpa", title: "Sherpa project", model_provider: "openai" },
    { id: "thread-website", cwd: "/work/pavelhov_website", title: "Website project", model_provider: "openai" },
  ]);
  state.close();
  expect(existsSync(join(codexHome, "codexcommander-journal.json"))).toBe(false);
});

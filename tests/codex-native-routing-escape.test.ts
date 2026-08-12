import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { restoreNativeCodexRoutingForStop } from "../src/codex/inject";

const repoRoot = join(import.meta.dir, "..");
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function incidentFixture() {
  const createdCodexHome = mkdtempSync(join(tmpdir(), "ccx-native-escape-codex-"));
  const codexHome = realpathSync.native(createdCodexHome);
  const ccxHome = mkdtempSync(join(tmpdir(), "ccx-native-escape-state-"));
  cleanup.push(createdCodexHome, ccxHome);
  chmodSync(codexHome, 0o755);
  const configPath = join(codexHome, "config.toml");
  const routed = [
    '# user setting stays = "byte-for-byte"',
    'model = "provider/slug"',
    `model_catalog_json = "${join(codexHome, "codexcommander-catalog.json")}"`,
    "# Auto-injected by CodexCommander",
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    "",
    "[features]",
    "fast_mode = true",
    "",
  ].join("\n");
  writeFileSync(configPath, routed);
  chmodSync(configPath, 0o640);

  const sentinels = [
    [join(codexHome, "auth.json"), '{"sentinel":"untouched"}\n'],
    [join(codexHome, "codexcommander-catalog.json"), '{"models":[]}\n'],
    [join(codexHome, "models_cache.json"), '{"models":[]}\n'],
    [join(codexHome, "sessions", "task.jsonl"), '{"task":"untouched"}\n'],
  ] as const;
  for (const [path, bytes] of sentinels) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  const journalPath = join(codexHome, "codexcommander-journal.json");
  writeFileSync(journalPath, JSON.stringify({
    version: 1,
    originalConfig: Buffer.from('model = "gpt-5"\n').toString("base64"),
    originalProfile: null,
    injectedConfigHash: createHash("sha256").update(routed).digest("hex"),
    // The incident journal recorded a generated profile postimage even though
    // the profile path is now absent; strict recovery must accept the exact
    // originalProfile=null state rather than requiring this stale hash to match.
    injectedProfileHash: createHash("sha256").update("stale generated profile").digest("hex"),
    pid: 999_999,
    timestamp: new Date(0).toISOString(),
  }) + "\n");

  const coordinatorPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
  writeFileSync(coordinatorPath, "");
  cleanup.push(coordinatorPath);
  return { codexHome, ccxHome, configPath, routed, sentinels, journalPath, coordinatorPath };
}

function run(source: string, fixture: ReturnType<typeof incidentFixture>) {
  return spawnSync(process.execPath, ["-e", source], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: fixture.codexHome,
      CODEXCOMMANDER_HOME: fixture.ccxHome,
      CI: "1",
    },
    encoding: "utf8",
  });
}

describe("config-only native routing escape", () => {
  test("stop refuses foreign ownership before desired-state or native-config mutation", () => {
    const calls: string[] = [];
    const result = restoreNativeCodexRoutingForStop({
      inspectOwnership: () => ({ ownership: "foreign", reason: "another fixture owns these homes" }),
      setEnabled: () => {
        calls.push("desired");
        return { ok: true, status: "committed", enabled: false };
      },
      escapeNative: () => {
        calls.push("escape");
        return { success: true, changed: true, message: "escaped" };
      },
    });

    expect(result).toEqual({
      success: false,
      changed: false,
      desiredChanged: false,
      configChanged: false,
      message: "Codex native restore refused: another fixture owns these homes",
    });
    expect(calls).toEqual([]);
  });

  test("incident escape accepts a 0755 home and changes only marker-owned config bytes", () => {
    const fixture = incidentFixture();
    const untouched = new Map<string, Buffer>();
    for (const [path] of fixture.sentinels) untouched.set(path, readFileSync(path));
    untouched.set(fixture.journalPath, readFileSync(fixture.journalPath));
    untouched.set(fixture.coordinatorPath, readFileSync(fixture.coordinatorPath));

    const child = run(`
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape()));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: true, changed: true });
    expect(readFileSync(fixture.configPath, "utf8")).toBe([
      '# user setting stays = "byte-for-byte"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n"));
    expect(statSync(fixture.configPath).mode & 0o777).toBe(0o640);
    expect(statSync(fixture.codexHome).mode & 0o777).toBe(0o755);
    for (const [path, bytes] of untouched) expect(readFileSync(path)).toEqual(bytes);
  });

  test("native escape refuses a group-writable CODEX_HOME before mutation", () => {
    if (process.platform === "win32") return;
    const fixture = incidentFixture();
    chmodSync(fixture.codexHome, 0o775);
    const before = readFileSync(fixture.configPath);
    const child = run(`
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape()));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: false, changed: false });
    expect(readFileSync(fixture.configPath)).toEqual(before);
    expect(statSync(fixture.coordinatorPath).size).toBe(0);
  });

  test("an EEXIST temp symlink is never truncated or unlinked", () => {
    if (process.platform === "win32") return;
    const fixture = incidentFixture();
    const sentinelPath = join(fixture.codexHome, "temp-target-sentinel.txt");
    const sentinel = Buffer.from("must stay untouched\n");
    writeFileSync(sentinelPath, sentinel);
    const child = run(`
      const { symlinkSync } = await import("node:fs");
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      const temp = ${JSON.stringify(fixture.configPath)} + ".ccx-native." + process.pid + ".1.tmp";
      symlinkSync(${JSON.stringify(sentinelPath)}, temp);
      console.log(JSON.stringify({ result: restoreNativeCodexRoutingEscape(), temp }));
    `, fixture);
    expect(child.status).toBe(0);
    const output = JSON.parse(child.stdout.trim());
    expect(output.result).toMatchObject({ success: false, changed: false });
    expect(readFileSync(sentinelPath)).toEqual(sentinel);
    expect(lstatSync(output.temp).isSymbolicLink()).toBe(true);
  });

  test("post-rename verification failure reports an indeterminate changed result", () => {
    const fixture = incidentFixture();
    const child = run(`
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape({
        afterRenameForTests: () => { throw new Error("verification seam"); },
      })));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({
      success: false,
      changed: true,
    });
    expect(readFileSync(fixture.configPath, "utf8")).not.toContain("openai_base_url");
  });

  test("equal-byte config replacement before publication is stale authority", () => {
    const fixture = incidentFixture();
    const child = run(`
      const fs = await import("node:fs");
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      const replacement = ${JSON.stringify(fixture.configPath)} + ".replacement";
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape({
        beforeRenameForTests: () => {
          fs.writeFileSync(replacement, fs.readFileSync(${JSON.stringify(fixture.configPath)}));
          fs.renameSync(replacement, ${JSON.stringify(fixture.configPath)});
        },
      })));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: false, changed: false });
    expect(readFileSync(fixture.configPath, "utf8")).toBe(fixture.routed);
  });

  test("equal-byte symlink retarget before publication never overwrites either target", () => {
    if (process.platform === "win32") return;
    const fixture = incidentFixture();
    const first = join(fixture.codexHome, "first-config.toml");
    const second = join(fixture.codexHome, "second-config.toml");
    renameSync(fixture.configPath, first);
    writeFileSync(second, fixture.routed);
    symlinkSync(first, fixture.configPath, "file");
    const child = run(`
      const fs = await import("node:fs");
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape({
        beforeRenameForTests: () => {
          fs.unlinkSync(${JSON.stringify(fixture.configPath)});
          fs.symlinkSync(${JSON.stringify(second)}, ${JSON.stringify(fixture.configPath)}, "file");
        },
      })));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: false, changed: false });
    expect(readFileSync(first, "utf8")).toBe(fixture.routed);
    expect(readFileSync(second, "utf8")).toBe(fixture.routed);
  });

  test("equal-byte replacement after publication is reported indeterminate", () => {
    const fixture = incidentFixture();
    const child = run(`
      const fs = await import("node:fs");
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      const replacement = ${JSON.stringify(fixture.configPath)} + ".replacement";
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape({
        afterRenameForTests: candidate => {
          fs.writeFileSync(replacement, candidate);
          fs.renameSync(replacement, ${JSON.stringify(fixture.configPath)});
        },
      })));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: false, changed: true });
    expect(readFileSync(fixture.configPath, "utf8")).not.toContain("openai_base_url");
  });

  test("equal-byte symlink retarget after publication is reported indeterminate", () => {
    if (process.platform === "win32") return;
    const fixture = incidentFixture();
    const first = join(fixture.codexHome, "first-config.toml");
    const second = join(fixture.codexHome, "second-config.toml");
    renameSync(fixture.configPath, first);
    symlinkSync(first, fixture.configPath, "file");
    const child = run(`
      const fs = await import("node:fs");
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape({
        afterRenameForTests: candidate => {
          fs.writeFileSync(${JSON.stringify(second)}, candidate);
          fs.unlinkSync(${JSON.stringify(fixture.configPath)});
          fs.symlinkSync(${JSON.stringify(second)}, ${JSON.stringify(fixture.configPath)}, "file");
        },
      })));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: false, changed: true });
    expect(readFileSync(first, "utf8")).not.toContain("openai_base_url");
    expect(readFileSync(second, "utf8")).not.toContain("openai_base_url");
  });

  test("formatter-owned provider residue refuses without changing config", () => {
    const fixture = incidentFixture();
    const formatted = [
      'model_provider = "codexcommander"',
      "# Auto-injected by CodexCommander",
      '["model_providers"."codexcommander"] # formatted',
      'base_url = "http://192.0.2.10:10100/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    writeFileSync(fixture.configPath, formatted);
    const child = run(`
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape()));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: false, changed: false });
    expect(readFileSync(fixture.configPath, "utf8")).toBe(formatted);
  });

  test("an edited marker-owned provider table refuses without changing config", () => {
    const fixture = incidentFixture();
    const edited = [
      'model_provider = "codexcommander"',
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'name = "CodexCommander Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      'organization = "user-owned"',
      "",
    ].join("\n");
    writeFileSync(fixture.configPath, edited);
    const child = run(`
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape()));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: false, changed: false });
    expect(readFileSync(fixture.configPath, "utf8")).toBe(edited);
  });

  test("slash-model syntax not handled by the byte transform refuses before publication", () => {
    for (const modelLine of [
      'model = "provider/slug" # user comment',
      '"model" = "provider/slug"',
    ]) {
      const fixture = incidentFixture();
      const routed = [
        modelLine,
        "# Auto-injected by CodexCommander",
        'openai_base_url = "http://127.0.0.1:10100/v1"',
        "",
      ].join("\n");
      writeFileSync(fixture.configPath, routed);
      const child = run(`
        const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
        console.log(JSON.stringify(restoreNativeCodexRoutingEscape()));
      `, fixture);
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: false, changed: false });
      expect(readFileSync(fixture.configPath, "utf8")).toBe(routed);
    }
  });

  test("an active external profile preserves an inactive marker-owned CCX table", () => {
    const fixture = incidentFixture();
    const external = [
      'profile = "work"',
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.custom]",
      'base_url = "https://external.example/v1"',
      'wire_api = "responses"',
      "",
      "[profiles.work]",
      'model_provider = "custom"',
      "",
    ].join("\n");
    writeFileSync(fixture.configPath, external);
    const child = run(`
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape()));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({
      success: true,
      changed: false,
      message: "External Codex provider routing was preserved.",
    });
    expect(readFileSync(fixture.configPath, "utf8")).toBe(external);
  });

  test("an active profile that still selects CodexCommander refuses before publication", () => {
    const fixture = incidentFixture();
    const routed = [
      'profile = "work"',
      `model_catalog_json = "${join(fixture.codexHome, "codexcommander-catalog.json")}"`,
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
      "[profiles.work]",
      'model_provider = "codexcommander"',
      "",
    ].join("\n");
    writeFileSync(fixture.configPath, routed);
    const child = run(`
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape()));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: false, changed: false });
    expect(readFileSync(fixture.configPath, "utf8")).toBe(routed);
  });

  test("marker-looking multiline string content refuses without rewriting user data", () => {
    const fixture = incidentFixture();
    const multiline = [
      'note = """',
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      '"""',
      "",
    ].join("\n");
    writeFileSync(fixture.configPath, multiline);
    const child = run(`
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodexRoutingEscape()));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: false, changed: false });
    expect(readFileSync(fixture.configPath, "utf8")).toBe(multiline);
  });

  test("real journal recovery initializes the same zero-byte coordinator at generation one", () => {
    const fixture = incidentFixture();
    const coordinatorBefore = lstatSync(fixture.coordinatorPath);
    const untouched = new Map(fixture.sentinels.map(([path]) => [path, readFileSync(path)]));
    const profilePath = join(fixture.codexHome, "codexcommander.config.toml");
    expect(existsSync(profilePath)).toBe(false);

    const child = run(`
      const { readFileSync } = await import("node:fs");
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      const { reconcileJournal } = await import("./src/codex/journal.ts");
      const escaped = restoreNativeCodexRoutingEscape();
      const afterEscape = readFileSync(${JSON.stringify(fixture.configPath)});
      const reconciled = reconcileJournal();
      const afterRecovery = readFileSync(${JSON.stringify(fixture.configPath)});
      console.log(JSON.stringify({ escaped, reconciled, configUnchanged: afterEscape.equals(afterRecovery) }));
    `, fixture);
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({
      escaped: { success: true, changed: true },
      reconciled: true,
      configUnchanged: true,
    });
    expect(existsSync(fixture.journalPath)).toBe(false);
    expect(existsSync(profilePath)).toBe(false);
    const coordinatorAfter = lstatSync(fixture.coordinatorPath);
    expect(coordinatorAfter.ino).toBe(coordinatorBefore.ino);
    expect(coordinatorAfter.size).toBeGreaterThan(0);
    const database = new Database(fixture.coordinatorPath, { readonly: true });
    try {
      expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
      const row = database.query<{ native_generation: number; current_tx_id: string | null }, []>(
        "SELECT native_generation, current_tx_id FROM codex_transition_state WHERE singleton = 1",
      ).get();
      expect(row?.native_generation).toBe(1);
      expect(row?.current_tx_id).toBeString();
    } finally {
      database.close();
    }
    for (const [path, bytes] of untouched) expect(readFileSync(path)).toEqual(bytes);
  });

  test("tray Start after Stop retires only the dead journal and reuses generated artifacts", () => {
    const fixture = incidentFixture();
    const generatedProfile = [
      "# CodexCommander proxy fallback config (Design B)",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const routedCatalog = JSON.stringify({
      models: [{ slug: "fixture/model", description: "Routed via CodexCommander → fixture." }],
    }) + "\n";
    const profilePath = join(fixture.codexHome, "codexcommander.config.toml");
    const catalogPath = join(fixture.codexHome, "codexcommander-catalog.json");
    const cachePath = join(fixture.codexHome, "models_cache.json");
    writeFileSync(profilePath, generatedProfile);
    writeFileSync(catalogPath, routedCatalog);
    writeFileSync(cachePath, routedCatalog);
    const coordinatorBefore = lstatSync(fixture.coordinatorPath);
    const child = run(`
      const { existsSync, readFileSync } = await import("node:fs");
      const { getDefaultConfig, loadConfig, saveConfig } = await import("./src/config.ts");
      const { injectCodexConfig, restoreNativeCodexRoutingForStop } = await import("./src/codex/inject.ts");
      const { ensureProxyLifecycle } = await import("./src/cli/proxy-lifecycle.ts");
      const calls = [];
      saveConfig(getDefaultConfig());
      const escaped = restoreNativeCodexRoutingForStop({
        inspectOwnership: () => ({ ownership: "owned", reason: "test fixture owns these homes" }),
      });
      const started = await ensureProxyLifecycle({
        action: "start",
        ensureCompanion: false,
        io: {
          findLive: async () => { calls.push("find"); return null; },
          acquireEnsureLock: async () => ({ release: () => calls.push("release") }),
          diagnoseService: () => ({ installed: false }),
          spawnStart: async () => { calls.push("spawn"); },
          waitForProxy: async () => ({ pid: process.pid, port: 10100, source: "runtime" }),
          waitForReady: async () => "ready",
          syncLive: async live => {
            calls.push("sync");
            await injectCodexConfig(live.port, loadConfig(), { catalogPath: ${JSON.stringify(catalogPath)} });
            return {
              status: "applied", ok: true, catalogQuality: "live",
              catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
            };
          },
        },
      });
      const journal = JSON.parse(readFileSync(${JSON.stringify(fixture.journalPath)}, "utf8"));
      console.log(JSON.stringify({ escaped, started, calls, journalPid: journal.pid,
        artifacts: [${JSON.stringify(profilePath)}, ${JSON.stringify(catalogPath)}, ${JSON.stringify(cachePath)}]
          .map(path => existsSync(path)),
      }));
    `, fixture);
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.escaped).toMatchObject({ success: true, changed: true });
    expect(result.started).toMatchObject({ action: "start", ok: true, state: "running" });
    expect(result.calls).toContain("spawn");
    expect(result.calls).toContain("sync");
    expect(result.journalPid).toBe(result.started.pid);
    expect(result.artifacts).toEqual([true, true, true]);
    expect(statSync(fixture.configPath).isFile()).toBe(true);
    expect(existsSync(fixture.journalPath)).toBe(true);
    expect(readFileSync(fixture.configPath, "utf8")).toContain("# Auto-injected by CodexCommander");
    const coordinatorAfter = lstatSync(fixture.coordinatorPath);
    expect(coordinatorAfter.ino).toBe(coordinatorBefore.ino);
    expect(coordinatorAfter.size).toBeGreaterThan(0);
    const database = new Database(fixture.coordinatorPath, { readonly: true });
    try {
      expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    } finally {
      database.close();
    }
  });

  test("Restore Back uses the same narrow incident cleanup before sync", () => {
    const fixture = incidentFixture();
    const coordinatorBefore = lstatSync(fixture.coordinatorPath);
    const child = run(`
      const { restoreNativeCodexRoutingEscape } = await import("./src/codex/inject.ts");
      const { restoreBackRoutingLifecycle } = await import("./src/cli/proxy-lifecycle.ts");
      const escaped = restoreNativeCodexRoutingEscape();
      const restored = await restoreBackRoutingLifecycle({
        findLive: async () => ({ pid: 42, port: 10100, source: "runtime" }),
        setEnabled: () => ({ ok: true, status: "committed", enabled: true }),
        syncModels: async () => ({ status: "applied", ok: true, message: "synced" }),
      });
      console.log(JSON.stringify({ escaped, restored }));
    `, fixture);
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.restored).toMatchObject({ action: "restore-back", ok: true, state: "running" });
    expect(existsSync(fixture.journalPath)).toBe(false);
    expect(lstatSync(fixture.coordinatorPath).ino).toBe(coordinatorBefore.ino);
  });
});

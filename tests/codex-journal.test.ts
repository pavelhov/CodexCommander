import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import {
  MANAGED_AGENTS_TABLE_MARKER,
  MANAGED_SUBAGENT_DEFAULT_MARKER,
} from "../src/codex/subagent-defaults";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function runScript(
  codexHome: string,
  script: string,
  codexCommanderHome = join(codexHome, "ccx-state"),
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEXCOMMANDER_HOME: codexCommanderHome,
    },
    encoding: "utf8",
  });
  return { stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "", status: result.status ?? 1 };
}

function contentHash(content: string | null): string | null {
  return content === null
    ? null
    : createHash("sha256").update(content).digest("hex");
}

function coordinatorPath(codexHome: string): string {
  return resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
}

function removeCoordinator(codexHome: string): void {
  const path = coordinatorPath(codexHome);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

function writeRecoveryJournal(
  codexHome: string,
  options: {
    originalConfig: string;
    originalProfile?: string | null;
    injectedConfig: string;
    injectedProfile: string | null;
    pid?: number;
    timestamp?: string;
  },
): string {
  const journalPath = join(codexHome, "codexcommander-journal.json");
  writeFileSync(journalPath, JSON.stringify({
    version: 1,
    originalConfig: Buffer.from(options.originalConfig).toString("base64"),
    originalProfile: options.originalProfile === undefined || options.originalProfile === null
      ? null
      : Buffer.from(options.originalProfile).toString("base64"),
    injectedConfigHash: contentHash(options.injectedConfig),
    injectedProfileHash: contentHash(options.injectedProfile),
    pid: options.pid ?? 999999,
    timestamp: options.timestamp ?? "2026-08-10T00:00:00.000Z",
  }), "utf8");
  return journalPath;
}

describe("codex-journal", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ccx-journal-"));
    writeFileSync(join(testDir, "config.toml"), "# original config\nmodel_provider = \"openai\"\n", "utf8");
  });

  afterEach(() => {
    removeCoordinator(testDir);
    rmSync(testDir, { recursive: true, force: true });
  });

  test("writeJournal creates journal file", () => {
    const r = runScript(testDir, `
      const { writeJournal } = require("./src/codex/journal");
      writeJournal();
      const fs = require("fs");
      const path = require("path");
      const journalPath = path.join(process.env.CODEX_HOME, "codexcommander-journal.json");
      const exists = fs.existsSync(journalPath);
      const data = exists ? JSON.parse(fs.readFileSync(journalPath, "utf-8")) : null;
      console.log(JSON.stringify({ exists, version: data?.version, hasPid: typeof data?.pid === "number" }));
    `);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.exists).toBe(true);
    expect(out.version).toBe(1);
    expect(out.hasPid).toBe(true);
  });

  test("reconcileJournal restores config when journaled PID is dead", () => {
    const original = "# original config\nmodel_provider = \"openai\"\n";
    const modified = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), modified, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: original,
      injectedConfig: modified,
      injectedProfile: null,
    });

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      const result = reconcileJournal();
      console.log(JSON.stringify({ restored: result }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).restored).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("writeJournal persists intended postimage hashes before any native write", () => {
    const original = readFileSync(join(testDir, "config.toml"), "utf8");
    const intendedConfig = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const written = runScript(testDir, `
      const { writeJournal } = require("./src/codex/journal");
      writeJournal({ intendedPostimage: {
        config: ${JSON.stringify(intendedConfig)},
        profile: null,
      } });
      console.log("written");
    `);
    expect(written.status).toBe(0);

    const journalPath = join(testDir, "codexcommander-journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    expect(journal.injectedConfigHash).toBe(contentHash(intendedConfig));
    expect(journal.injectedProfileHash).toBeNull();

    // Crash after journal publication but before either native write, followed
    // by a human edit: recovery preserves the edit and retires only the stale
    // authority record.
    const userEdit = 'model = "gpt-5.6-sol"\n';
    writeFileSync(join(testDir, "config.toml"), userEdit, "utf8");
    const reconciled = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(reconcileJournal()));
    `);
    expect(reconciled.status).toBe(0);
    expect(JSON.parse(reconciled.stdout)).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(userEdit);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).not.toBe(original);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("a legacy hashless journal never replays over divergent user bytes", () => {
    const journalPath = join(testDir, "codexcommander-journal.json");
    const userEdit = 'model = "gpt-5.6-terra"\n';
    writeFileSync(join(testDir, "config.toml"), userEdit, "utf8");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model = "gpt-5.4"\n').toString("base64"),
      originalProfile: null,
      pid: 999999,
      timestamp: "2026-08-10T00:00:00.000Z",
    }), "utf8");

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(reconcileJournal()));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(userEdit);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("a legacy hashless routed config with a user edit is preserved and retains authority", () => {
    const journalPath = join(testDir, "codexcommander-journal.json");
    const routedWithUserEdit = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
      "[tools]",
      "web_search = true",
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), routedWithUserEdit, "utf8");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model = "gpt-5.4"\n').toString("base64"),
      originalProfile: null,
      pid: 999999,
      timestamp: "2026-08-10T00:00:00.000Z",
    }), "utf8");

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(reconcileJournal()));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(false);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(routedWithUserEdit);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("a legacy hashless generated profile restores because the whole surface is CCX-owned", () => {
    const originalConfig = readFileSync(join(testDir, "config.toml"), "utf8");
    const originalProfile = 'model_provider = "openai"\n';
    const injectedProfile = [
      "# CodexCommander proxy fallback config (Design B)",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const journalPath = join(testDir, "codexcommander-journal.json");
    writeFileSync(join(testDir, "codexcommander.config.toml"), injectedProfile, "utf8");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from(originalConfig).toString("base64"),
      originalProfile: Buffer.from(originalProfile).toString("base64"),
      pid: 999999,
      timestamp: "2026-08-10T00:00:00.000Z",
    }), "utf8");

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(reconcileJournal()));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(originalConfig);
    expect(readFileSync(join(testDir, "codexcommander.config.toml"), "utf8")).toBe(originalProfile);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("a config change after recovery authorization is preserved and retains the journal", () => {
    const original = 'model = "gpt-5.5"\n';
    const injected = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), injected, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: original,
      injectedConfig: injected,
      injectedProfile: null,
    });
    const userEdit = 'model = "gpt-5.6-luna"\n';

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { reconcileJournal } = require("./src/codex/journal");
      const reconciled = reconcileJournal({
        beforeConfigMutationRevalidation: () => fs.writeFileSync(
          path.join(process.env.CODEX_HOME, "config.toml"),
          ${JSON.stringify(userEdit)},
          "utf8",
        ),
      });
      console.log(JSON.stringify(reconciled));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(false);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(userEdit);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("an equal-byte config replacement after recovery authorization is never restored", () => {
    const original = 'model = "gpt-5.5"\n';
    const injected = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const configPath = join(testDir, "config.toml");
    writeFileSync(configPath, injected, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: original,
      injectedConfig: injected,
      injectedProfile: null,
    });

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { reconcileJournal } = require("./src/codex/journal");
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      const replacement = path.join(process.env.CODEX_HOME, "replacement-config.toml");
      const reconciled = reconcileJournal({
        beforeConfigMutationRevalidation: () => {
          fs.writeFileSync(replacement, fs.readFileSync(configPath));
          fs.renameSync(replacement, configPath);
        },
      });
      console.log(JSON.stringify(reconciled));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(injected);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("a profile change after recovery authorization is preserved and retains the journal", () => {
    const originalConfig = readFileSync(join(testDir, "config.toml"), "utf8");
    const originalProfile = 'model_provider = "openai"\n';
    const injectedProfile = [
      "# CodexCommander proxy fallback config (Design B)",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "codexcommander.config.toml"), injectedProfile, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig,
      originalProfile,
      injectedConfig: "different injected config",
      injectedProfile,
    });
    const userEdit = 'model_provider = "custom"\n';

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { reconcileJournal } = require("./src/codex/journal");
      const reconciled = reconcileJournal({
        beforeProfileMutationRevalidation: () => fs.writeFileSync(
          path.join(process.env.CODEX_HOME, "codexcommander.config.toml"),
          ${JSON.stringify(userEdit)},
          "utf8",
        ),
      });
      console.log(JSON.stringify(reconciled));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(false);
    expect(readFileSync(join(testDir, "codexcommander.config.toml"), "utf8")).toBe(userEdit);
    expect(existsSync(journalPath)).toBe(true);
  });

  const symlinkTest = process.platform === "win32" ? test.skip : test;

  symlinkTest("recovery preserves a config leaf symlink and restores its captured target", () => {
    const original = 'model = "gpt-5.5"\n';
    const injected = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const target = join(testDir, "linked-config.toml");
    writeFileSync(target, injected, "utf8");
    rmSync(join(testDir, "config.toml"));
    symlinkSync(target, join(testDir, "config.toml"));
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: original,
      injectedConfig: injected,
      injectedProfile: null,
    });

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(reconcileJournal()));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(true);
    expect(lstatSync(join(testDir, "config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(existsSync(journalPath)).toBe(false);
  });

  symlinkTest("recovery preserves a profile leaf symlink and restores its captured target", () => {
    const originalConfig = readFileSync(join(testDir, "config.toml"), "utf8");
    const originalProfile = 'model_provider = "openai"\n';
    const injectedProfile = [
      "# CodexCommander proxy fallback config (Design B)",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const target = join(testDir, "linked-profile.toml");
    writeFileSync(target, injectedProfile, "utf8");
    symlinkSync(target, join(testDir, "codexcommander.config.toml"));
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig,
      originalProfile,
      injectedConfig: "different injected config",
      injectedProfile,
    });

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(reconcileJournal()));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(true);
    expect(lstatSync(join(testDir, "codexcommander.config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(originalProfile);
    expect(existsSync(journalPath)).toBe(false);
  });

  symlinkTest("a config link retarget after authorization never overwrites either target", () => {
    const original = 'model = "gpt-5.5"\n';
    const injected = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const firstTarget = join(testDir, "config-first.toml");
    const replacementTarget = join(testDir, "config-replacement.toml");
    const logical = join(testDir, "config.toml");
    writeFileSync(firstTarget, injected, "utf8");
    writeFileSync(replacementTarget, 'model = "user-edit"\n', "utf8");
    rmSync(logical);
    symlinkSync(firstTarget, logical);
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: original,
      injectedConfig: injected,
      injectedProfile: null,
    });

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { reconcileJournal } = require("./src/codex/journal");
      const logical = path.join(process.env.CODEX_HOME, "config.toml");
      const reconciled = reconcileJournal({ beforeConfigMutationRevalidation: () => {
        fs.unlinkSync(logical);
        fs.symlinkSync(path.join(process.env.CODEX_HOME, "config-replacement.toml"), logical);
      } });
      console.log(JSON.stringify(reconciled));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(false);
    expect(readFileSync(firstTarget, "utf8")).toBe(injected);
    expect(readFileSync(replacementTarget, "utf8")).toBe('model = "user-edit"\n');
    expect(existsSync(journalPath)).toBe(true);
  });

  symlinkTest("a profile link retarget after authorization never overwrites either target", () => {
    const originalConfig = readFileSync(join(testDir, "config.toml"), "utf8");
    const originalProfile = 'model_provider = "openai"\n';
    const injectedProfile = [
      "# CodexCommander proxy fallback config (Design B)",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const firstTarget = join(testDir, "profile-first.toml");
    const replacementTarget = join(testDir, "profile-replacement.toml");
    const logical = join(testDir, "codexcommander.config.toml");
    writeFileSync(firstTarget, injectedProfile, "utf8");
    writeFileSync(replacementTarget, 'model_provider = "custom"\n', "utf8");
    symlinkSync(firstTarget, logical);
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig,
      originalProfile,
      injectedConfig: "different injected config",
      injectedProfile,
    });

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { reconcileJournal } = require("./src/codex/journal");
      const logical = path.join(process.env.CODEX_HOME, "codexcommander.config.toml");
      const reconciled = reconcileJournal({ beforeProfileMutationRevalidation: () => {
        fs.unlinkSync(logical);
        fs.symlinkSync(path.join(process.env.CODEX_HOME, "profile-replacement.toml"), logical);
      } });
      console.log(JSON.stringify(reconciled));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(false);
    expect(readFileSync(firstTarget, "utf8")).toBe(injectedProfile);
    expect(readFileSync(replacementTarget, "utf8")).toBe('model_provider = "custom"\n');
    expect(existsSync(journalPath)).toBe(true);
  });

  symlinkTest("an injected profile replaced by a symlink is never unlinked", () => {
    const originalConfig = readFileSync(join(testDir, "config.toml"), "utf8");
    const injectedProfile = [
      "# CodexCommander proxy fallback config (Design B)",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const logical = join(testDir, "codexcommander.config.toml");
    const userTarget = join(testDir, "user-profile.toml");
    writeFileSync(logical, injectedProfile, "utf8");
    writeFileSync(userTarget, injectedProfile, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig,
      originalProfile: null,
      injectedConfig: "different injected config",
      injectedProfile,
    });

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { reconcileJournal } = require("./src/codex/journal");
      const logical = path.join(process.env.CODEX_HOME, "codexcommander.config.toml");
      const reconciled = reconcileJournal({ beforeProfileMutationRevalidation: () => {
        fs.unlinkSync(logical);
        fs.symlinkSync(path.join(process.env.CODEX_HOME, "user-profile.toml"), logical);
      } });
      console.log(JSON.stringify(reconciled));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toBe(false);
    expect(lstatSync(logical).isSymbolicLink()).toBe(true);
    expect(readFileSync(userTarget, "utf8")).toBe(injectedProfile);
    expect(existsSync(journalPath)).toBe(true);
  });

  symlinkTest("a parent-directory symlink swap after authorization cannot redirect recovery", () => {
    const aliasRoot = mkdtempSync(join(tmpdir(), "ccx-journal-alias-"));
    const replacementHome = mkdtempSync(join(tmpdir(), "ccx-journal-replacement-"));
    const alias = join(aliasRoot, "codex-home");
    const original = 'model = "gpt-5.5"\n';
    const injected = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), injected, "utf8");
    const replacementConfig = 'model = "replacement-user"\n';
    writeFileSync(join(replacementHome, "config.toml"), replacementConfig, "utf8");
    symlinkSync(testDir, alias);
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: original,
      injectedConfig: injected,
      injectedProfile: null,
    });
    try {
      const result = spawnSync(process.execPath, ["--eval", `
        const fs = require("node:fs");
        const path = require("node:path");
        const { reconcileJournal } = require("./src/codex/journal");
        const alias = process.env.CODEX_HOME;
        const reconciled = reconcileJournal({ beforeConfigMutationRevalidation: () => {
          fs.unlinkSync(alias);
          fs.symlinkSync(process.env.TEST_REPLACEMENT_HOME, alias);
        } });
        console.log(JSON.stringify(reconciled));
      `], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CODEX_HOME: alias,
          CODEXCOMMANDER_HOME: join(aliasRoot, "ccx-state"),
          TEST_REPLACEMENT_HOME: replacementHome,
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toBe(true);
      expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
      expect(readFileSync(join(replacementHome, "config.toml"), "utf8")).toBe(replacementConfig);
      expect(existsSync(journalPath)).toBe(false);
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
      rmSync(replacementHome, { recursive: true, force: true });
    }
  });

  test("reconcileJournal handles corrupt JSON gracefully", () => {
    const journalPath = join(testDir, "codexcommander-journal.json");
    writeFileSync(journalPath, "NOT VALID JSON{{{", "utf8");

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      const result = reconcileJournal();
      console.log(JSON.stringify({ restored: result }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).restored).toBe(false);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("reconcileJournal no-ops when no journal exists", () => {
    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      const result = reconcileJournal();
      console.log(JSON.stringify({ restored: result }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).restored).toBe(false);
  });

  test("ordinary coordinator initialization safely adopts only an exact empty v0 shell", () => {
    const path = coordinatorPath(testDir);
    new Database(path).close();

    const r = runScript(testDir, `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      kind: "ready",
      state: { nativeGeneration: 0, currentTxId: null },
    });
    const db = new Database(path, { readonly: true });
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    db.close();
  });

  test("an unversioned coordinator with any schema is never adopted by ordinary or recovery paths", () => {
    const path = coordinatorPath(testDir);
    const db = new Database(path);
    db.exec("CREATE TABLE foreign_state (value TEXT)");
    db.close();

    const ordinary = runScript(testDir, `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `);
    expect(ordinary.status).toBe(0);
    expect(JSON.parse(ordinary.stdout)).toMatchObject({ kind: "state-ambiguous" });

    const original = readFileSync(join(testDir, "config.toml"), "utf8");
    const injected = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), injected, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: original,
      injectedConfig: injected,
      injectedProfile: null,
    });
    const recovery = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(reconcileJournal()));
    `);
    expect(recovery.status).toBe(0);
    expect(JSON.parse(recovery.stdout)).toBe(false);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(injected);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("a crash after journal unlink but before coordinator commit leaves a recoverable empty shell", () => {
    const path = coordinatorPath(testDir);
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: readFileSync(join(testDir, "config.toml"), "utf8"),
      injectedConfig: "different injected config",
      injectedProfile: null,
    });
    const crashed = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { canonicalizeCodexHome } = require("./src/codex/codex-write-lock");
      const { beginCodexCoordinatorRecoveryTransaction } = require("./src/codex/transition-state");
      const { resolveCodexCoordinatorDatabasePath, resolveEffectiveUserIdentity } = require("./src/codex/user-identity");
      const canonical = canonicalizeCodexHome(process.env.CODEX_HOME);
      if (!canonical.ok) process.exit(2);
      const dbPath = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), canonical.home.path);
      const tx = beginCodexCoordinatorRecoveryTransaction(dbPath, () => true);
      const expectation = tx.expectation();
      const version = tx.version();
      tx.capability.beginTransition(
        { nativeGeneration: expectation.nativeBefore, currentTxId: version.currentTxId },
        { txId: expectation.txId },
      );
      fs.unlinkSync(path.join(process.env.CODEX_HOME, "codexcommander-journal.json"));
      process.exit(0);
    `);
    expect(crashed.status).toBe(0);
    expect(existsSync(journalPath)).toBe(false);

    const recovered = runScript(testDir, `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `);
    expect(recovered.status).toBe(0);
    expect(JSON.parse(recovered.stdout)).toEqual({
      kind: "ready",
      state: { nativeGeneration: 0, currentTxId: null },
    });
    const db = new Database(path, { readonly: true });
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    db.close();
  });

  test("global recovery N excludes different CodexCommander homes sharing one CODEX_HOME", () => {
    const original = readFileSync(join(testDir, "config.toml"), "utf8");
    const injected = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), injected, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: original,
      injectedConfig: injected,
      injectedProfile: null,
    });
    const path = coordinatorPath(testDir);
    const holder = new Database(path);
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    try {
      const blocked = runScript(testDir, `
        const { reconcileJournal } = require("./src/codex/journal");
        console.log(JSON.stringify(reconcileJournal()));
      `, join(testDir, "ccx-state-b"));
      expect(blocked.status).toBe(0);
      expect(JSON.parse(blocked.stdout)).toBe(false);
      expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(injected);
      expect(existsSync(journalPath)).toBe(true);

      const initializer = runScript(testDir, `
        const { readCodexTransitionState } = require("./src/codex/transition-state");
        console.log(JSON.stringify(readCodexTransitionState()));
      `, join(testDir, "ccx-state-c"));
      expect(initializer.status).toBe(0);
      expect(JSON.parse(initializer.stdout).kind).not.toBe("ready");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }

    const recovered = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(reconcileJournal()));
    `, join(testDir, "ccx-state-d"));
    expect(recovered.status).toBe(0);
    expect(JSON.parse(recovered.stdout)).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(journalPath)).toBe(false);

    const state = runScript(testDir, `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `, join(testDir, "ccx-state-e"));
    expect(JSON.parse(state.stdout)).toMatchObject({
      kind: "ready",
      state: { nativeGeneration: 1 },
    });
  });

  test("a paused authorized recovery keeps concurrent recovery and normal initialization excluded", () => {
    const original = readFileSync(join(testDir, "config.toml"), "utf8");
    const injected = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), injected, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: original,
      injectedConfig: injected,
      injectedProfile: null,
    });
    const recoveryProbe = `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(reconcileJournal()));
    `;
    const initializerProbe = `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `;

    const outer = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      let concurrentRecovery;
      let concurrentInitializer;
      const reconciled = reconcileJournal({ beforeConfigMutationRevalidation: () => {
        const recovery = Bun.spawnSync(
          [process.execPath, "--eval", ${JSON.stringify(recoveryProbe)}],
          { cwd: ${JSON.stringify(repoRoot)}, env: {
            ...process.env,
            CODEXCOMMANDER_HOME: process.env.CODEX_HOME + "/ccx-concurrent-recovery",
          } },
        );
        concurrentRecovery = JSON.parse(new TextDecoder().decode(recovery.stdout).trim());
        const initializer = Bun.spawnSync(
          [process.execPath, "--eval", ${JSON.stringify(initializerProbe)}],
          { cwd: ${JSON.stringify(repoRoot)}, env: {
            ...process.env,
            CODEXCOMMANDER_HOME: process.env.CODEX_HOME + "/ccx-concurrent-initializer",
          } },
        );
        concurrentInitializer = JSON.parse(new TextDecoder().decode(initializer.stdout).trim());
      } });
      console.log(JSON.stringify({ reconciled, concurrentRecovery, concurrentInitializer }));
    `, join(testDir, "ccx-authorized-recovery"));

    expect(outer.status).toBe(0);
    const result = JSON.parse(outer.stdout);
    expect(result.reconciled).toBe(true);
    expect(result.concurrentRecovery).toBe(false);
    expect(result.concurrentInitializer.kind).not.toBe("ready");
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("reconcileJournal skips when journaled PID is alive", () => {
    const journalPath = join(testDir, "codexcommander-journal.json");
    const modified = "# modified by codexcommander\n";
    writeFileSync(join(testDir, "config.toml"), modified, "utf8");
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      originalConfig: Buffer.from("# original\n").toString("base64"),
      originalProfile: null,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    }), "utf8");

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      const result = reconcileJournal();
      console.log(JSON.stringify({ restored: result }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).restored).toBe(false);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(modified);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("active journal classification accepts only a proven live-owner routed descendant", () => {
    const routedConfig = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'name = "CodexCommander Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
    ].join("\n");
    const routedProfile = [
      "# CodexCommander proxy fallback config (Design B)",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), routedConfig, "utf8");
    writeFileSync(join(testDir, "codexcommander.config.toml"), routedProfile, "utf8");
    writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.6-sol"\n',
      injectedConfig: routedConfig,
      injectedProfile: routedProfile,
      pid: process.pid,
    });

    const r = runScript(testDir, `
      const { classifyActiveCodexRoutingJournal } = require("./src/codex/journal");
      console.log(JSON.stringify({
        exact: classifyActiveCodexRoutingJournal(${process.pid}),
        wrongOwner: classifyActiveCodexRoutingJournal(${process.pid + 1}),
      }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      exact: { kind: "active-managed-postimage" },
      wrongOwner: {
        kind: "not-active-managed-postimage",
        reason: "owner-mismatch",
      },
    });

    const preferenceUpdatedConfig = [
      'model_reasoning_effort = "ultra"',
      'service_tier = "priority"',
      routedConfig,
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), preferenceUpdatedConfig, "utf8");
    const changed = runScript(testDir, `
      const { classifyActiveCodexRoutingJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(classifyActiveCodexRoutingJournal(${process.pid})));
    `);
    expect(changed.status).toBe(0);
    expect(JSON.parse(changed.stdout)).toEqual({
      kind: "active-managed-descendant",
    });

    const prepared = runScript(testDir, `
      const { prepareExplicitCodexRoutingStart } = require("./src/codex/routing-transition");
      const { existsSync } = require("node:fs");
      const { JOURNAL_PATH } = require("./src/codex/journal");
      const result = prepareExplicitCodexRoutingStart({
        protectedLiveOwnerPid: ${process.pid},
        desiredEnabled: () => true,
        setEnabled: () => ({ ok: true, status: "unchanged", enabled: true }),
      });
      console.log(JSON.stringify({ result, journalPreserved: existsSync(JOURNAL_PATH) }));
    `);
    expect(prepared.status).toBe(0);
    expect(JSON.parse(prepared.stdout)).toEqual({
      result: {
        success: true,
        changed: false,
        message: "Codex is already routing through this live proxy.",
      },
      journalPreserved: true,
    });

    writeFileSync(
      join(testDir, "config.toml"),
      preferenceUpdatedConfig.replace(
        "http://127.0.0.1:10100/v1",
        "http://127.0.0.1:10199/v1",
      ),
      "utf8",
    );
    const repointed = runScript(testDir, `
      const { classifyActiveCodexRoutingJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(classifyActiveCodexRoutingJournal(${process.pid})));
    `);
    expect(repointed.status).toBe(0);
    expect(JSON.parse(repointed.stdout)).toEqual({
      kind: "not-active-managed-postimage",
      reason: "routing-mismatch",
    });

    writeFileSync(
      join(testDir, "config.toml"),
      preferenceUpdatedConfig.replace(
        'name = "CodexCommander Proxy"',
        'name = "Unverified Proxy"',
      ),
      "utf8",
    );
    const unsafe = runScript(testDir, `
      const { classifyActiveCodexRoutingJournal } = require("./src/codex/journal");
      console.log(JSON.stringify(classifyActiveCodexRoutingJournal(${process.pid})));
    `);
    expect(unsafe.status).toBe(0);
    expect(JSON.parse(unsafe.stdout)).toEqual({
      kind: "not-active-managed-postimage",
      reason: "routing-mismatch",
    });
  });

  test("explicit native escape retires a matching live journal and preserves inert generated artifacts", () => {
    const nativeConfig = 'model = "gpt-5.5"\n';
    const generatedProfile = [
      "# CodexCommander proxy fallback config (Design B)",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const routedCatalog = JSON.stringify({
      models: [{ slug: "fixture/model", description: "Routed via CodexCommander → fixture." }],
    }) + "\n";
    writeFileSync(join(testDir, "config.toml"), nativeConfig, "utf8");
    writeFileSync(join(testDir, "codexcommander.config.toml"), generatedProfile, "utf8");
    writeFileSync(join(testDir, "codexcommander-catalog.json"), routedCatalog, "utf8");
    writeFileSync(join(testDir, "models_cache.json"), routedCatalog, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.4"\n',
      injectedConfig: "old routed config",
      injectedProfile: generatedProfile,
      pid: process.pid,
    });

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
      saveConfig({ ...getDefaultConfig(), clientIntegrations: { codex: false } });
      const journalPath = path.join(process.env.CODEX_HOME, "codexcommander-journal.json");
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      journal.pid = process.pid;
      fs.writeFileSync(journalPath, JSON.stringify(journal), "utf8");
      console.log(JSON.stringify({
        retired: retireJournalAfterExplicitNativeEscape({ kind: "protected-live", pid: process.pid }),
      }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: true });
    expect(existsSync(journalPath)).toBe(false);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(nativeConfig);
    expect(readFileSync(join(testDir, "codexcommander.config.toml"), "utf8")).toBe(generatedProfile);
    expect(readFileSync(join(testDir, "codexcommander-catalog.json"), "utf8")).toBe(routedCatalog);
    expect(readFileSync(join(testDir, "models_cache.json"), "utf8")).toBe(routedCatalog);
  });

  test("explicit native escape bootstraps missing coordinator authority", () => {
    const nativeConfig = 'model = "gpt-5.6-sol"\n';
    writeFileSync(join(testDir, "config.toml"), nativeConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.5"\n',
      injectedConfig: "old routed config",
      injectedProfile: null,
      pid: process.pid,
    });
    removeCoordinator(testDir);
    expect(existsSync(coordinatorPath(testDir))).toBe(false);

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
      saveConfig({ ...getDefaultConfig(), clientIntegrations: { codex: false } });
      const journalPath = path.join(process.env.CODEX_HOME, "codexcommander-journal.json");
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      journal.pid = process.pid;
      fs.writeFileSync(journalPath, JSON.stringify(journal), "utf8");
      console.log(JSON.stringify({
        retired: retireJournalAfterExplicitNativeEscape({ kind: "protected-live", pid: process.pid }),
      }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: true });
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(coordinatorPath(testDir))).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(nativeConfig);
  });

  test("explicit native escape accepts a proven-dead journal despite inert generated artifacts", () => {
    const nativeConfig = 'model = "gpt-5.5"\n';
    const generatedProfile = "# CodexCommander proxy fallback config (Design B)\nopenai_base_url = \"http://127.0.0.1:10100/v1\"\n";
    const routedCatalog = '{"models":[{"slug":"fixture/model","description":"Routed via CodexCommander → fixture."}]}\n';
    writeFileSync(join(testDir, "config.toml"), nativeConfig, "utf8");
    writeFileSync(join(testDir, "codexcommander.config.toml"), generatedProfile, "utf8");
    writeFileSync(join(testDir, "codexcommander-catalog.json"), routedCatalog, "utf8");
    writeFileSync(join(testDir, "models_cache.json"), routedCatalog, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.4"\n',
      injectedConfig: "old routed config",
      injectedProfile: generatedProfile,
    });

    const r = runScript(testDir, `
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
      saveConfig({ ...getDefaultConfig(), clientIntegrations: { codex: false } });
      console.log(JSON.stringify({
        retired: retireJournalAfterExplicitNativeEscape({ kind: "dead" }),
      }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: true });
    expect(existsSync(journalPath)).toBe(false);
    expect(readFileSync(join(testDir, "codexcommander.config.toml"), "utf8")).toBe(generatedProfile);
    expect(readFileSync(join(testDir, "codexcommander-catalog.json"), "utf8")).toBe(routedCatalog);
    expect(readFileSync(join(testDir, "models_cache.json"), "utf8")).toBe(routedCatalog);
  });

  test("explicit native escape retirement retains authority on wrong live PID or missing OFF intent", () => {
    for (const refusal of ["wrong-pid", "intent-on"] as const) {
      writeFileSync(join(testDir, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
      const journalPath = writeRecoveryJournal(testDir, {
        originalConfig: 'model = "gpt-5.4"\n',
        injectedConfig: "old routed config",
        injectedProfile: null,
        pid: process.pid,
        timestamp: `2026-08-10T18:00:0${refusal === "wrong-pid" ? "0" : "1"}.000Z`,
      });
      const r = runScript(testDir, `
        const fs = require("node:fs");
        const path = require("node:path");
        const { getDefaultConfig, saveConfig } = require("./src/config");
        const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
        saveConfig(${refusal === "wrong-pid"
          ? '{ ...getDefaultConfig(), clientIntegrations: { codex: false } }'
          : "getDefaultConfig()"});
        const journalPath = path.join(process.env.CODEX_HOME, "codexcommander-journal.json");
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
        journal.pid = process.pid;
        fs.writeFileSync(journalPath, JSON.stringify(journal), "utf8");
        console.log(JSON.stringify({ retired: retireJournalAfterExplicitNativeEscape({
          kind: "protected-live",
          pid: process.pid${refusal === "wrong-pid" ? " + 1" : ""},
        }) }));
      `);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ retired: false });
      expect(existsSync(journalPath)).toBe(true);
      rmSync(journalPath, { force: true });
      removeCoordinator(testDir);
    }
  });

  test("explicit native escape retirement retains the journal when config changes at the CAS seam", () => {
    const nativeConfig = 'model = "gpt-5.5"\n';
    const changedConfig = 'model = "gpt-5.6-sol"\n';
    writeFileSync(join(testDir, "config.toml"), nativeConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.4"\n',
      injectedConfig: "old routed config",
      injectedProfile: null,
    });
    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
      saveConfig({ ...getDefaultConfig(), clientIntegrations: { codex: false } });
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      console.log(JSON.stringify({ retired: retireJournalAfterExplicitNativeEscape(
        { kind: "dead" },
        { beforeRetireRevalidation: () => fs.writeFileSync(configPath, ${JSON.stringify(changedConfig)}, "utf8") },
      ) }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: false });
    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(changedConfig);
  });

  test("explicit native escape retirement rejects an equal-byte config replacement", () => {
    const nativeConfig = 'model = "gpt-5.5"\n';
    const configPath = join(testDir, "config.toml");
    writeFileSync(configPath, nativeConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.4"\n',
      injectedConfig: "old routed config",
      injectedProfile: null,
    });
    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
      saveConfig({ ...getDefaultConfig(), clientIntegrations: { codex: false } });
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      const replacement = path.join(process.env.CODEX_HOME, "replacement-config.toml");
      const retired = retireJournalAfterExplicitNativeEscape({ kind: "dead" }, {
        beforeRetireRevalidation: () => {
          fs.writeFileSync(replacement, fs.readFileSync(configPath));
          fs.renameSync(replacement, configPath);
        },
      });
      console.log(JSON.stringify({ retired }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: false });
    expect(readFileSync(configPath, "utf8")).toBe(nativeConfig);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("explicit native escape retirement rejects an equal-byte config symlink retarget", () => {
    if (process.platform === "win32") return;
    const nativeConfig = 'model = "gpt-5.5"\n';
    const configPath = join(testDir, "config.toml");
    const first = join(testDir, "native-first.toml");
    const second = join(testDir, "native-second.toml");
    renameSync(configPath, first);
    writeFileSync(first, nativeConfig, "utf8");
    writeFileSync(second, nativeConfig, "utf8");
    symlinkSync(first, configPath, "file");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.4"\n',
      injectedConfig: "old routed config",
      injectedProfile: null,
    });
    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
      saveConfig({ ...getDefaultConfig(), clientIntegrations: { codex: false } });
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      const retired = retireJournalAfterExplicitNativeEscape({ kind: "dead" }, {
        beforeRetireRevalidation: () => {
          fs.unlinkSync(configPath);
          fs.symlinkSync(${JSON.stringify(second)}, configPath, "file");
        },
      });
      console.log(JSON.stringify({ retired }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: false });
    expect(readFileSync(first, "utf8")).toBe(nativeConfig);
    expect(readFileSync(second, "utf8")).toBe(nativeConfig);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("explicit native escape retirement rejects routed config without restoring preimages", () => {
    const routed = '# Auto-injected by CodexCommander\nopenai_base_url = "http://127.0.0.1:10100/v1"\n';
    writeFileSync(join(testDir, "config.toml"), routed, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.4"\n',
      injectedConfig: routed,
      injectedProfile: null,
    });
    const r = runScript(testDir, `
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
      saveConfig({ ...getDefaultConfig(), clientIntegrations: { codex: false } });
      console.log(JSON.stringify({ retired: retireJournalAfterExplicitNativeEscape({ kind: "dead" }) }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: false });
    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(routed);
  });

  test("explicit native escape retirement preserves an active external config and inert CCX artifacts", () => {
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
    writeFileSync(join(testDir, "config.toml"), external, "utf8");
    writeFileSync(join(testDir, "codexcommander.config.toml"), "# CodexCommander proxy fallback config (Design B)\nopenai_base_url = \"http://127.0.0.1:10100/v1\"\n", "utf8");
    writeFileSync(join(testDir, "codexcommander-catalog.json"), '{"models":[{"slug":"fixture/model","description":"Routed via CodexCommander → fixture."}]}\n', "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model_provider = "openai"\n',
      injectedConfig: "old routed config",
      injectedProfile: null,
    });
    const r = runScript(testDir, `
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
      saveConfig({ ...getDefaultConfig(), clientIntegrations: { codex: false } });
      console.log(JSON.stringify({ retired: retireJournalAfterExplicitNativeEscape({ kind: "dead" }) }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: true });
    expect(existsSync(journalPath)).toBe(false);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(external);
  });

  test("explicit native escape retirement retains a concurrently replaced journal", () => {
    writeFileSync(join(testDir, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.4"\n',
      injectedConfig: "old routed config",
      injectedProfile: null,
    });
    const replacementTimestamp = "2026-08-10T19:00:00.000Z";
    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
      saveConfig({ ...getDefaultConfig(), clientIntegrations: { codex: false } });
      const journalPath = path.join(process.env.CODEX_HOME, "codexcommander-journal.json");
      const replacementPath = path.join(process.env.CODEX_HOME, "replacement-journal.json");
      const replacement = {
        version: 1,
        originalConfig: Buffer.from('model = "replacement"\\n').toString("base64"),
        originalProfile: null,
        injectedConfigHash: "replacement-config",
        injectedProfileHash: null,
        pid: 999998,
        timestamp: ${JSON.stringify(replacementTimestamp)},
      };
      const retired = retireJournalAfterExplicitNativeEscape({ kind: "dead" }, {
        beforeRetireRevalidation: () => {
          fs.writeFileSync(replacementPath, JSON.stringify(replacement), "utf8");
          fs.renameSync(replacementPath, journalPath);
        },
      });
      console.log(JSON.stringify({ retired, journal: JSON.parse(fs.readFileSync(journalPath, "utf8")) }));
    `);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.retired).toBe(false);
    expect(result.journal.timestamp).toBe(replacementTimestamp);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("explicit native escape retirement refuses unresolved config atomic-write residue", () => {
    writeFileSync(join(testDir, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.4"\n',
      injectedConfig: "old routed config",
      injectedProfile: null,
    });
    writeFileSync(join(testDir, "config.toml.ccx.42.1.tmp"), "replacement in flight", "utf8");
    const r = runScript(testDir, `
      const { getDefaultConfig, saveConfig } = require("./src/config");
      const { retireJournalAfterExplicitNativeEscape } = require("./src/codex/journal");
      saveConfig({ ...getDefaultConfig(), clientIntegrations: { codex: false } });
      console.log(JSON.stringify({ retired: retireJournalAfterExplicitNativeEscape({ kind: "dead" }) }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: false });
    expect(existsSync(journalPath)).toBe(true);
  });

  test("external-provider retirement commits on a clean config-only surface", () => {
    const externalConfig = 'model_provider = "custom"\nmodel = "third-party"\n';
    writeFileSync(join(testDir, "config.toml"), externalConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model_provider = "openai"\n',
      injectedConfig: "old injected config",
      injectedProfile: null,
      pid: process.pid,
    });
    for (const absentPath of [
      "codexcommander.config.toml",
      "codexcommander-catalog.json",
      "models_cache.json",
      "config.toml.ccx.42.1.tmp",
    ]) {
      expect(existsSync(join(testDir, absentPath))).toBe(false);
    }

    const r = runScript(testDir, `
      const { retireJournalForExternalProvider } = require("./src/codex/journal");
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      const retired = retireJournalForExternalProvider("custom");
      console.log(JSON.stringify({ retired, coordinator: readCodexTransitionState() }));
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result).toMatchObject({
      retired: true,
      coordinator: { kind: "ready", state: { nativeGeneration: 1 } },
    });
    expect(typeof result.coordinator.state.currentTxId).toBe("string");
    expect(result.coordinator.state.currentTxId.length).toBeGreaterThan(0);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(externalConfig);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("external-provider retirement never unlinks a concurrently replaced journal", () => {
    const externalConfig = 'model_provider = "custom"\nmodel = "third-party"\n';
    writeFileSync(join(testDir, "config.toml"), externalConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model_provider = "openai"\n',
      injectedConfig: "old injected config",
      injectedProfile: null,
      pid: process.pid,
    });
    const replacementTimestamp = "2026-08-10T17:00:00.000Z";
    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { retireJournalForExternalProvider } = require("./src/codex/journal");
      const journalPath = path.join(process.env.CODEX_HOME, "codexcommander-journal.json");
      const replacementPath = path.join(process.env.CODEX_HOME, "replacement-journal.json");
      const replacement = {
        version: 1,
        originalConfig: Buffer.from('model_provider = "replacement"\\n').toString("base64"),
        originalProfile: null,
        injectedConfigHash: "replacement-config",
        injectedProfileHash: null,
        pid: process.pid,
        timestamp: ${JSON.stringify(replacementTimestamp)},
      };
      const retired = retireJournalForExternalProvider("custom", {
        beforeRetireRevalidation: () => {
          fs.writeFileSync(replacementPath, JSON.stringify(replacement), "utf8");
          fs.renameSync(replacementPath, journalPath);
        },
      });
      console.log(JSON.stringify({ retired, journal: JSON.parse(fs.readFileSync(journalPath, "utf8")) }));
    `);
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.retired).toBe(false);
    expect(result.journal.timestamp).toBe(replacementTimestamp);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(externalConfig);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("external-provider retirement rejects an equal-byte config replacement", () => {
    const externalConfig = 'model_provider = "custom"\nmodel = "third-party"\n';
    const configPath = join(testDir, "config.toml");
    writeFileSync(configPath, externalConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model_provider = "openai"\n',
      injectedConfig: "old injected config",
      injectedProfile: null,
      pid: process.pid,
    });
    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { retireJournalForExternalProvider } = require("./src/codex/journal");
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      const replacement = path.join(process.env.CODEX_HOME, "replacement-config.toml");
      const retired = retireJournalForExternalProvider("custom", {
        beforeRetireRevalidation: () => {
          fs.writeFileSync(replacement, fs.readFileSync(configPath));
          fs.renameSync(replacement, configPath);
        },
      });
      console.log(JSON.stringify({ retired }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: false });
    expect(readFileSync(configPath, "utf8")).toBe(externalConfig);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("external-provider retirement rejects a multiline-string decoy on revalidation", () => {
    const externalConfig = 'model_provider = "custom"\nmodel = "third-party"\n';
    const decoyConfig = 'note = """\nmodel_provider = "custom"\n"""\n';
    writeFileSync(join(testDir, "config.toml"), externalConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model_provider = "openai"\n',
      injectedConfig: "old injected config",
      injectedProfile: null,
      pid: process.pid,
    });
    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { retireJournalForExternalProvider } = require("./src/codex/journal");
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      const retired = retireJournalForExternalProvider("custom", {
        beforeRetireRevalidation: () => fs.writeFileSync(configPath, ${JSON.stringify(decoyConfig)}, "utf8"),
      });
      console.log(JSON.stringify({ retired }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: false });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(decoyConfig);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("external-provider retirement refuses inactive CCX residue before unlinking journal", () => {
    const externalConfig = [
      'profile = "work"',
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'name = "CodexCommander Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
      "[model_providers.custom]",
      'base_url = "https://external.example/v1"',
      'wire_api = "responses"',
      "",
      "[profiles.work]",
      'model_provider = "custom"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), externalConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model_provider = "openai"\n',
      injectedConfig: "old injected config",
      injectedProfile: null,
      pid: process.pid,
    });
    const r = runScript(testDir, `
      const { retireJournalForExternalProvider } = require("./src/codex/journal");
      console.log(JSON.stringify({ retired: retireJournalForExternalProvider("custom") }));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ retired: false });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(externalConfig);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("reconcileJournal retires a detached dead-owner journal after preserving clean current native state", () => {
    const currentConfig = 'model = "gpt-5.5"\n';
    writeFileSync(join(testDir, "config.toml"), currentConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.4"\n',
      originalProfile: null,
      injectedConfig: '# Auto-injected by CodexCommander\nopenai_base_url = "http://127.0.0.1:10100/v1"\n',
      injectedProfile: '# CodexCommander proxy fallback config (Design B)\nopenai_base_url = "http://127.0.0.1:10100/v1"\n',
    });

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify({ reconciled: reconcileJournal() }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ reconciled: true });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(currentConfig);
    expect(existsSync(join(testDir, "codexcommander.config.toml"))).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("reconcileJournal retires the journal after restoring one unchanged postimage and preserving one clean divergent surface", () => {
    const originalConfig = 'model = "gpt-5.5"\n';
    const injectedConfig = '# Auto-injected by CodexCommander\nopenai_base_url = "http://127.0.0.1:10100/v1"\n';
    writeFileSync(join(testDir, "config.toml"), injectedConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig,
      originalProfile: null,
      injectedConfig,
      injectedProfile: '# CodexCommander proxy fallback config (Design B)\nopenai_base_url = "http://127.0.0.1:10100/v1"\n',
    });

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify({ reconciled: reconcileJournal() }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ reconciled: true });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(originalConfig);
    expect(existsSync(join(testDir, "codexcommander.config.toml"))).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("reconcileJournal never restores or retires a valid journal whose owner is alive", () => {
    const injectedConfig = '# Auto-injected by CodexCommander\nopenai_base_url = "http://127.0.0.1:10100/v1"\n';
    writeFileSync(join(testDir, "config.toml"), injectedConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.5"\n',
      injectedConfig,
      injectedProfile: null,
      pid: process.pid,
    });

    const r = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify({ reconciled: reconcileJournal() }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ reconciled: false });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(injectedConfig);
    expect(existsSync(journalPath)).toBe(true);
  });

  const detachedRetirementBlockers: Array<{
    name: string;
    arrange: (codexHome: string) => void;
  }> = [
    {
      name: "routed config",
      arrange: codexHome => writeFileSync(join(codexHome, "config.toml"), [
        "# Auto-injected by CodexCommander",
        'openai_base_url = "http://127.0.0.1:10100/v1"',
        "",
      ].join("\n"), "utf8"),
    },
    {
      name: "generated profile",
      arrange: codexHome => writeFileSync(join(codexHome, "codexcommander.config.toml"), [
        "# CodexCommander proxy fallback config (Design B)",
        'openai_base_url = "http://127.0.0.1:10100/v1"',
        "",
      ].join("\n"), "utf8"),
    },
    {
      name: "routed catalog",
      arrange: codexHome => writeFileSync(join(codexHome, "codexcommander-catalog.json"), JSON.stringify({
        models: [{ slug: "fixture/model", description: "Routed via CodexCommander → fixture." }],
      }), "utf8"),
    },
    {
      name: "routed models cache",
      arrange: codexHome => writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
        models: [{ slug: "fixture/model", description: "Routed via CodexCommander → fixture." }],
      }), "utf8"),
    },
    {
      name: "journal atomic-write temp",
      arrange: codexHome => writeFileSync(
        join(codexHome, "codexcommander-journal.json.ccx.42.7.tmp"),
        "replacement in flight",
        "utf8",
      ),
    },
  ];

  for (const fixture of detachedRetirementBlockers) {
    test(`reconcileJournal retains a detached journal when ${fixture.name} remains`, () => {
      const currentConfig = 'model = "gpt-5.5"\n';
      writeFileSync(join(testDir, "config.toml"), currentConfig, "utf8");
      fixture.arrange(testDir);
      const arrangedConfig = readFileSync(join(testDir, "config.toml"), "utf8");
      const journalPath = writeRecoveryJournal(testDir, {
        originalConfig: 'model = "gpt-5.4"\n',
        injectedConfig: "different injected config",
        injectedProfile: "different injected profile",
      });

      const r = runScript(testDir, `
        const { reconcileJournal } = require("./src/codex/journal");
        console.log(JSON.stringify({ reconciled: reconcileJournal() }));
      `);

      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ reconciled: false });
      expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(arrangedConfig);
      expect(existsSync(journalPath)).toBe(true);
    });
  }

  test("reconcileJournal retains a replacement installed after the clean-surface observation", () => {
    const currentConfig = 'model = "gpt-5.5"\n';
    writeFileSync(join(testDir, "config.toml"), currentConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: 'model = "gpt-5.4"\n',
      injectedConfig: "different injected config",
      injectedProfile: "different injected profile",
    });

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { reconcileJournal } = require("./src/codex/journal");
      const journalPath = path.join(process.env.CODEX_HOME, "codexcommander-journal.json");
      const replacementPath = path.join(process.env.CODEX_HOME, "replacement-journal.json");
      const replacement = {
        version: 1,
        originalConfig: Buffer.from('model = "replacement"\\n').toString("base64"),
        originalProfile: null,
        injectedConfigHash: "replacement-config-hash",
        injectedProfileHash: "replacement-profile-hash",
        pid: process.pid,
        timestamp: "2026-08-10T12:00:00.000Z",
      };
      const reconciled = reconcileJournal({
        beforeRetireRevalidation: () => {
          fs.writeFileSync(replacementPath, JSON.stringify(replacement), "utf8");
          fs.renameSync(replacementPath, journalPath);
        },
      });
      const current = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      console.log(JSON.stringify({ reconciled, pid: current.pid, timestamp: current.timestamp }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      reconciled: false,
      pid: expect.any(Number),
      timestamp: "2026-08-10T12:00:00.000Z",
    });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(currentConfig);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("reconcileJournal never restores or removes a replacement installed before recovery", () => {
    const originalConfig = 'model = "gpt-5.5"\n';
    const injectedConfig = '# Auto-injected by CodexCommander\nopenai_base_url = "http://127.0.0.1:10100/v1"\n';
    writeFileSync(join(testDir, "config.toml"), injectedConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig,
      injectedConfig,
      injectedProfile: null,
    });

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { reconcileJournal } = require("./src/codex/journal");
      const journalPath = path.join(process.env.CODEX_HOME, "codexcommander-journal.json");
      const replacementPath = path.join(process.env.CODEX_HOME, "replacement-journal.json");
      const replacement = {
        version: 1,
        originalConfig: Buffer.from('model = "replacement"\\n').toString("base64"),
        originalProfile: null,
        injectedConfigHash: "replacement-config-hash",
        injectedProfileHash: null,
        pid: process.pid,
        timestamp: "2026-08-10T13:00:00.000Z",
      };
      const reconciled = reconcileJournal({
        beforeRecoveryRevalidation: () => {
          fs.writeFileSync(replacementPath, JSON.stringify(replacement), "utf8");
          fs.renameSync(replacementPath, journalPath);
        },
      });
      const current = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      console.log(JSON.stringify({ reconciled, pid: current.pid, timestamp: current.timestamp }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      reconciled: false,
      pid: expect.any(Number),
      timestamp: "2026-08-10T13:00:00.000Z",
    });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(injectedConfig);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).not.toBe(originalConfig);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("reconcileJournal retains a replacement installed after complete normal recovery", () => {
    const originalConfig = 'model = "gpt-5.5"\n';
    const injectedConfig = '# Auto-injected by CodexCommander\nopenai_base_url = "http://127.0.0.1:10100/v1"\n';
    writeFileSync(join(testDir, "config.toml"), injectedConfig, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig,
      injectedConfig,
      injectedProfile: null,
    });

    const r = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { reconcileJournal } = require("./src/codex/journal");
      const journalPath = path.join(process.env.CODEX_HOME, "codexcommander-journal.json");
      const replacementPath = path.join(process.env.CODEX_HOME, "replacement-journal.json");
      const replacement = {
        version: 1,
        originalConfig: Buffer.from('model = "replacement"\\n').toString("base64"),
        originalProfile: null,
        injectedConfigHash: "replacement-config-hash",
        injectedProfileHash: null,
        pid: process.pid,
        timestamp: "2026-08-10T14:00:00.000Z",
      };
      const reconciled = reconcileJournal({
        beforeRetireRevalidation: () => {
          fs.writeFileSync(replacementPath, JSON.stringify(replacement), "utf8");
          fs.renameSync(replacementPath, journalPath);
        },
      });
      const current = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      console.log(JSON.stringify({ reconciled, pid: current.pid, timestamp: current.timestamp }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      reconciled: false,
      pid: expect.any(Number),
      timestamp: "2026-08-10T14:00:00.000Z",
    });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(originalConfig);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("removeCodexConfig is a successful no-op when Codex is not installed", () => {
    writeFileSync(join(testDir, "codexcommander.config.toml"), 'openai_base_url = "http://127.0.0.1:10100/v1"\n', "utf8");
    rmSync(join(testDir, "config.toml"));
    const r = runScript(testDir, `
      const { removeCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      console.log(JSON.stringify({ remove: removeCodexConfig(), restore: restoreNativeCodex() }));
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.remove.success).toBe(true);
    expect(result.remove.message).toContain("no native restore was needed");
    expect(result.restore.success).toBe(true);
    expect(existsSync(join(testDir, "codexcommander.config.toml"))).toBe(false);
  });

  test("removeCodexConfig reports damaged managed-default cleanup and preserves the ambiguous value", () => {
    writeFileSync(join(testDir, "config.toml"), [
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      "",
      'default_subagent_model = "gpt-5.6-sol"',
      "",
    ].join("\n"), "utf8");

    const r = runScript(testDir, `
      const { removeCodexConfig } = require("./src/codex/inject");
      console.log(JSON.stringify(removeCodexConfig()));
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(false);
    expect(result.message).toContain("could not be safely removed");
    expect(result.message).toContain("orphaned managed subagent default marker");
    const after = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(after).not.toContain("openai_base_url");
    expect(after).toContain("# Managed by CodexCommander: native subagent default");
    expect(after).toContain('default_subagent_model = "gpt-5.6-sol"');
  });

  test("removeCodexConfig ignores unsupported user-owned agents syntax when no managed marker exists", () => {
    const userAgents = 'agents = { default_subagent_model = "user/model" }';
    writeFileSync(join(testDir, "config.toml"), [
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      userAgents,
      "",
    ].join("\n"), "utf8");

    const r = runScript(testDir, `
      const { removeCodexConfig } = require("./src/codex/inject");
      console.log(JSON.stringify(removeCodexConfig()));
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    const after = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(after).not.toContain("openai_base_url");
    expect(after).toContain(userAgents);
  });

  test("restoreNativeCodex restores an exact unchanged journal snapshot with managed defaults", () => {
    const original = '# original config\nmodel_provider = "openai"\n';
    writeFileSync(join(testDir, "config.toml"), original, "utf8");

    const r = runScript(testDir, `
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, {
          port: 10100,
          providers: {},
          defaultProvider: "openai",
          injectionModel: "gpt-5.6-sol",
          injectionEffort: "high",
          syncCodexSubagentDefaults: true,
        }, { catalogPath: null });
        console.log(JSON.stringify(restoreNativeCodex()));
      })();
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("restored from the CodexCommander journal");
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(testDir, "codexcommander-journal.json"))).toBe(false);
  });

  test("restoreNativeCodex reports damaged managed-default cleanup during fallback restore", () => {
    const original = '# original config\nmodel_provider = "openai"\n';
    writeFileSync(join(testDir, "config.toml"), original, "utf8");

    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        const configPath = path.join(process.env.CODEX_HOME, "config.toml");
        await injectCodexConfig(10100, {
          port: 10100,
          providers: {},
          defaultProvider: "openai",
          injectionModel: "gpt-5.6-sol",
          injectionEffort: "high",
          syncCodexSubagentDefaults: true,
        }, { catalogPath: null });
        const marker = ${JSON.stringify(MANAGED_SUBAGENT_DEFAULT_MARKER)};
        const injected = fs.readFileSync(configPath, "utf8");
        fs.writeFileSync(configPath, injected.replace(
          marker + '\\ndefault_subagent_model',
          marker + '\\n\\ndefault_subagent_model',
        ), "utf8");
        console.log(JSON.stringify(restoreNativeCodex()));
      })();
    `);

    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(false);
    expect(result.message).toContain("could not be safely removed");
    expect(result.message).toContain("orphaned managed subagent default marker");
    const after = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(after).not.toContain("openai_base_url");
    expect(after).toContain("# Managed by CodexCommander: native subagent default");
    expect(after).toContain('default_subagent_model = "gpt-5.6-sol"');
    expect(existsSync(join(testDir, "codexcommander-journal.json"))).toBe(true);
  });

  test("restoreNativeCodex uses journal snapshot for normal stop without losing custom defaults", () => {
    const originalConfig = [
      'model = "openrouter/foo"',
      'model_provider = "proxy"',
      "",
      "[model_providers.proxy]",
      'name = "Existing Proxy"',
      'base_url = "https://proxy.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    const originalProfile = [
      'model = "gpt-5.5"',
      'model_provider = "openai"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), originalConfig, "utf8");
    const initialized = runScript(testDir, `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `);
    expect(initialized.status).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({ kind: "ready" });
    writeFileSync(join(testDir, "codexcommander.config.toml"), originalProfile, "utf8");

    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const { writeJournal } = require("./src/codex/journal");
      const { restoreNativeCodex } = require("./src/codex/inject");
      const injectedConfig = [
        'model_provider = "codexcommander"',
        'model = "opencode-go/glm-5.2"',
        '',
        '[model_providers.codexcommander]',
        'name = "CodexCommander Proxy"',
        'base_url = "http://localhost:10100/v1"',
        ''
      ].join("\\n");
      const injectedProfile = 'model_provider = "codexcommander"\\n';
      writeJournal({ intendedPostimage: { config: injectedConfig, profile: injectedProfile } });
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), injectedConfig, "utf8");
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "codexcommander.config.toml"), injectedProfile, "utf8");
      const result = restoreNativeCodex();
      console.log(JSON.stringify({ success: result.success, message: result.message }));
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(originalConfig);
    expect(readFileSync(join(testDir, "codexcommander.config.toml"), "utf8")).toBe(originalProfile);
    expect(existsSync(join(testDir, "codexcommander-journal.json"))).toBe(false);
  });

  test("synchronous restore participates in global N across different CodexCommander homes", () => {
    const original = readFileSync(join(testDir, "config.toml"), "utf8");
    const initialized = runScript(testDir, `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `, join(testDir, "ccx-restore-init"));
    expect(JSON.parse(initialized.stdout)).toMatchObject({ kind: "ready" });

    const injected = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), injected, "utf8");
    const journalPath = writeRecoveryJournal(testDir, {
      originalConfig: original,
      injectedConfig: injected,
      injectedProfile: null,
      pid: process.pid,
    });
    const holder = new Database(coordinatorPath(testDir));
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    try {
      const blocked = runScript(testDir, `
        const { restoreNativeCodex } = require("./src/codex/inject");
        console.log(JSON.stringify(restoreNativeCodex()));
      `, join(testDir, "ccx-restore-contender"));
      expect(blocked.status).toBe(0);
      expect(JSON.parse(blocked.stdout).success).toBe(false);
      expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(injected);
      expect(existsSync(journalPath)).toBe(true);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }

    const restored = runScript(testDir, `
      const { restoreNativeCodex } = require("./src/codex/inject");
      console.log(JSON.stringify(restoreNativeCodex()));
    `, join(testDir, "ccx-restore-winner"));
    expect(restored.status).toBe(0);
    expect(JSON.parse(restored.stdout).success).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("injectCodexConfig creates a restorable journal for direct sync/init paths", () => {
    const originalConfig = [
      'model = "openrouter/foo"',
      'model_provider = "proxy"',
      "",
      "[model_providers.proxy]",
      'name = "Existing Proxy"',
      'base_url = "https://proxy.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    writeFileSync(join(testDir, "config.toml"), originalConfig, "utf8");

    const r = runScript(testDir, `
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        const result = restoreNativeCodex();
        console.log(JSON.stringify({ success: result.success }));
      })();
    `);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(originalConfig);
  });

  test("restoreNativeCodex does not clobber user config edits made after injection", () => {
    const originalConfig = "# original config\nmodel_provider = \"openai\"\n";
    writeFileSync(join(testDir, "config.toml"), originalConfig, "utf8");

    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, {
          port: 10100,
          providers: {},
          defaultProvider: "openai",
          injectionModel: "gpt-5.6-sol",
          injectionEffort: "high",
          syncCodexSubagentDefaults: true,
        }, { catalogPath: null });
        fs.appendFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "\\n[tools]\\nweb_search = true\\n", "utf8");
        const result = restoreNativeCodex();
        console.log(JSON.stringify({ success: result.success, message: result.message }));
      })();
    `);

    expect(r.status).toBe(0);
    const restored = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(restored).toContain("[tools]");
    expect(restored).toContain("web_search = true");
    expect(restored).not.toContain("[model_providers.codexcommander]");
    expect(restored).not.toContain("Managed by codexcommander: native subagent");
    expect(restored).not.toContain("default_subagent_model");
    expect(restored).not.toContain("default_subagent_reasoning_effort");
    expect(existsSync(join(testDir, "codexcommander-journal.json"))).toBe(true);
  });

  test("full lifecycle: write → crash → reconcile restores", () => {
    const r = runScript(testDir, `
      const { writeJournal } = require("./src/codex/journal");
      writeJournal({
        intendedPostimage: {
          config: "# injected codexcommander config\\n",
          profile: null,
        },
      });
      console.log("written");
    `);
    expect(r.status).toBe(0);

    const journalPath = join(testDir, "codexcommander-journal.json");
    expect(existsSync(journalPath)).toBe(true);
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));

    writeFileSync(join(testDir, "config.toml"), "# injected codexcommander config\n", "utf8");

    const r2 = runScript(testDir, `
      const { reconcileJournal } = require("./src/codex/journal");
      const result = reconcileJournal();
      console.log(JSON.stringify({ restored: result }));
    `);
    expect(r2.status).toBe(0);
    expect(JSON.parse(r2.stdout).restored).toBe(true);
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toContain("original config");
    expect(existsSync(journalPath)).toBe(false);
  });

  /**
   * Issue #477. `writeJournal` used to return early whenever a valid journal
   * existed, so the first snapshot a machine ever took was the only one it ever
   * had. A partial restore leaves the journal behind (see the two tests above),
   * so that state is ordinary — and days later an unclean shutdown would replay
   * the day-one config over plugins, model choice and trusted projects.
   */
  test("a stale journal is superseded once the config is native again (#477)", () => {
    const r = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      (async () => {
        // Day one: inject, then edit while routing is live so the stop leaves the journal.
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        fs.appendFileSync(configPath, '\\n[projects."/tmp/day-one"]\\ntrust_level = "trusted"\\n', "utf8");
        restoreNativeCodex();
        // Day four: the user installs a plugin while codexcommander is not running.
        fs.appendFileSync(configPath, '\\n[plugins."browser@openai-bundled"]\\nenabled = true\\n', "utf8");
        const nativeBaseline = fs.readFileSync(configPath, "utf8");
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        console.log(JSON.stringify({ nativeBaseline }));
      })();
    `);
    expect(r.status).toBe(0);
    const { nativeBaseline } = JSON.parse(r.stdout) as { nativeBaseline: string };

    const journalPath = join(testDir, "codexcommander-journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toBe(nativeBaseline);
    // A refreshed record is a new transaction: the day-one fingerprint is gone,
    // replaced by one for the injection that just ran.
    expect(typeof journal.injectedConfigHash).toBe("string");

    // And recovery works end to end: an unclean shutdown restores day four.
    const r2 = runScript(testDir, `
      const fs = require("fs");
      const path = require("path");
      const journalPath = path.join(process.env.CODEX_HOME, "codexcommander-journal.json");
      const j = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      fs.writeFileSync(journalPath, JSON.stringify({ ...j, pid: 999999 }));
      const { reconcileJournal } = require("./src/codex/journal");
      console.log(JSON.stringify({ restored: reconcileJournal() }));
    `);
    expect(r2.status).toBe(0);
    expect(JSON.parse(r2.stdout).restored).toBe(true);
    const recovered = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(recovered).toContain("browser@openai-bundled");
    expect(recovered).not.toContain("[model_providers.codexcommander]");
    expect(recovered).not.toContain("Auto-injected by CodexCommander");
  });

  /**
   * The guard the #477 fix must not break. Deleting the early return outright —
   * the fix the issue suggests — would let the second injection of a start
   * capture the ALREADY-INJECTED config as the user's original, and a later
   * restore would then replay codexcommander routing as if the user had written it.
   */
  test("re-injecting over an injected config never captures it as the original (#477)", () => {
    const original = '# original config\nmodel_provider = "openai"\n';
    writeFileSync(join(testDir, "config.toml"), original, "utf8");

    const r = runScript(testDir, `
      const { injectCodexConfig } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        console.log("done");
      })();
    `);
    expect(r.status).toBe(0);
    const journal = JSON.parse(readFileSync(join(testDir, "codexcommander-journal.json"), "utf8"));
    expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toBe(original);
  });

  /**
   * The reachable case a "replace only when a journal exists" gate would miss:
   * an injected config with NO journal.
   */
  test("an injected config with no journal is never captured as the original (#477)", () => {
    const injected = [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'name = "CodexCommander Proxy"',
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n");
    const initialized = runScript(testDir, `
      const { readCodexTransitionState } = require("./src/codex/transition-state");
      console.log(JSON.stringify(readCodexTransitionState()));
    `);
    expect(initialized.status).toBe(0);
    writeFileSync(join(testDir, "config.toml"), injected, "utf8");

    const r = runScript(testDir, `
      const { injectCodexConfig, restoreNativeCodex } = require("./src/codex/inject");
      (async () => {
        await injectCodexConfig(10100, { port: 10100, providers: {}, defaultProvider: "openai" }, { catalogPath: null });
        restoreNativeCodex();
        console.log("done");
      })();
    `);
    expect(r.status).toBe(0);

    const after = readFileSync(join(testDir, "config.toml"), "utf8");
    expect(after).not.toContain("[model_providers.codexcommander]");
    expect(after).not.toContain("Auto-injected by CodexCommander");
  });

  test("writeJournal() with no options still snapshots a native config", () => {
    const r = runScript(testDir, `require("./src/codex/journal").writeJournal(); console.log("written");`);
    expect(r.status).toBe(0);
    const journal = JSON.parse(readFileSync(join(testDir, "codexcommander-journal.json"), "utf8"));
    expect(Buffer.from(journal.originalConfig, "base64").toString("utf8")).toContain("original config");
  });

  test("writeJournal() with no options refuses an injected config", () => {
    writeFileSync(join(testDir, "config.toml"), [
      'model_provider = "codexcommander"',
      "",
      "# Auto-injected by CodexCommander",
      "[model_providers.codexcommander]",
      'base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n"), "utf8");
    runScript(testDir, `require("./src/codex/journal").writeJournal(); console.log("done");`);
    expect(existsSync(join(testDir, "codexcommander-journal.json"))).toBe(false);
  });
});

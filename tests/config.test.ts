import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CODEX_SHIM_AUTO_RESTORE_ENV,
  codexAutoStartEnabled,
  codexShimAutoRestoreEnabled,
  getConfigPath,
  getDefaultConfig,
  getPidPath,
  getRuntimePortPath,
  isValidProviderName,
  isCodexCommanderStartCommandLine,
  initializeConfigIfMissing,
  loadConfig,
  multiAgentGuidanceEnabled,
  parsePidFile,
  positiveIntegerConfigError,
  positiveIntegerRecordConfigError,
  readConfigDiagnostics,
  readRuntimePort,
  removePid,
  removeRuntimePort,
  validateConfigCandidate,
  writeRuntimePort,
  writePid,
} from "../src/config";

import * as windowsAcl from "../src/lib/windows-secret-acl";
import { AtomicWriteResidualTempError, atomicWriteFile, atomicWriteFileAsync, hardenConfigDir, hardenExistingSecret, renameAtomicFile, saveConfig } from "../src/config";
import { sameConfigRootFileIdentity } from "../src/lib/config-ownership";
let testDir = "";
let previousCodexCommanderHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ccx-config-"));
  previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
  process.env.CODEXCOMMANDER_HOME = testDir;
});

afterEach(() => {
  if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
  previousCodexCommanderHome = undefined;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

function backupNames(): string[] {
  return readdirSync(testDir).filter(name => name.startsWith("config.json.invalid-"));
}

function writeConfig(content: unknown): void {
  const current = content && typeof content === "object" && !Array.isArray(content)
    ? { multiAgentGuidanceEnabled: true, ...content as Record<string, unknown> }
    : content;
  writeFileSync(
    getConfigPath(),
    typeof current === "string" ? current : JSON.stringify(current),
    "utf-8",
  );
}

function expectCurrentConfigRejected(errorFragment: string): void {
  expect(() => loadConfig()).toThrow(errorFragment);
  expect(readConfigDiagnostics()).toMatchObject({
    source: "fallback",
    error: expect.stringContaining(errorFragment),
  });
  expect(backupNames()).toHaveLength(0);
}

function writeResponsesPathConfig(responsesPath: string): void {
  writeConfig({
    port: 12345,
    providers: {
      custom: {
        adapter: "openai-responses",
        baseUrl: "https://example.test/api/v3",
        responsesPath,
      },
    },
    defaultProvider: "custom",
  });
}

function writeAccountNamespaceConfig(
  codexAccountNamespaces: unknown,
  overrides: Record<string, unknown> = {},
): void {
  writeConfig({
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
    codexAccountNamespaces,
    ...overrides,
  });
}

describe("create-only config initialization", () => {
  test("creates the canonical candidate only when config.json is absent", () => {
    const previousCwd = process.cwd();
    const candidate = getDefaultConfig();
    expect(initializeConfigIfMissing(candidate)).toEqual({ status: "created" });
    expect(process.cwd()).toBe(previousCwd);
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8"))).toEqual(candidate);
    expect(lstatSync(getConfigPath()).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(lstatSync(getConfigPath()).mode & 0o077).toBe(0);
    }
  });

  test("keeps an existing valid config byte-for-byte", () => {
    const bytes = `${JSON.stringify({ ...getDefaultConfig(), port: 12001 })}\n`;
    writeFileSync(getConfigPath(), bytes, { mode: 0o600 });
    expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({ status: "existing" });
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });

  test("refuses malformed and schema-invalid config without rewriting", () => {
    for (const bytes of ["{", '{"port":10100,"providers":{},"defaultProvider":"missing"}']) {
      writeFileSync(getConfigPath(), bytes, "utf8");
      expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
        status: "refused",
        reason: "existing-invalid",
      });
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
      unlinkSync(getConfigPath());
    }
  });

  test("rechecks a transient incomplete preflight under coordination", () => {
    expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({ status: "created" });
    unlinkSync(getConfigPath());
    const bytes = `${JSON.stringify({ ...getDefaultConfig(), port: 12003 })}\n`;
    writeFileSync(getConfigPath(), bytes, { mode: 0o600 });
    const originalRead = nodeFs.readFileSync;
    let injected = false;
    const readSpy = spyOn(nodeFs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      if (!injected && args[0] === getConfigPath()) {
        injected = true;
        return "{";
      }
      return (originalRead as (...values: unknown[]) => unknown)(...args);
    }) as typeof nodeFs.readFileSync);

    try {
      expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({ status: "existing" });
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("rejects an invalid candidate without creating config state", () => {
    const invalid = { ...getDefaultConfig(), defaultProvider: "missing" };
    expect(initializeConfigIfMissing(invalid)).toEqual({
      status: "refused",
      reason: "candidate-invalid",
    });
    expect(existsSync(getConfigPath())).toBe(false);
  });

  test("refuses when exclusive creation of the final config entry fails", () => {
    const originalOpen = nodeFs.openSync;
    const openSpy = spyOn(nodeFs, "openSync").mockImplementation(((...args: unknown[]) => {
      if (args[0] === getConfigPath() && args[1] === "wx") {
        throw Object.assign(new Error("exclusive final create failed"), { code: "EACCES" });
      }
      return (originalOpen as (...values: unknown[]) => number)(...args);
    }) as typeof nodeFs.openSync);

    try {
      expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
        status: "refused",
        reason: "coordination-unavailable",
      });
      expect(existsSync(getConfigPath())).toBe(false);
    } finally {
      openSpy.mockRestore();
    }
  });

  test("refuses and removes its incomplete file when descriptor write fails", () => {
    const originalWrite = nodeFs.writeFileSync;
    const writeSpy = spyOn(nodeFs, "writeFileSync").mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "number") {
        throw Object.assign(new Error("descriptor write failed"), { code: "EIO" });
      }
      return (originalWrite as (...values: unknown[]) => unknown)(...args);
    }) as typeof nodeFs.writeFileSync);

    try {
      expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
        status: "refused",
        reason: "coordination-unavailable",
      });
      expect(existsSync(getConfigPath())).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("refuses and removes its incomplete file when descriptor flush fails", () => {
    const fsyncSpy = spyOn(nodeFs, "fsyncSync").mockImplementation(() => {
      throw Object.assign(new Error("flush failed"), { code: "EIO" });
    });

    try {
      expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
        status: "refused",
        reason: "coordination-unavailable",
      });
      expect(existsSync(getConfigPath())).toBe(false);
    } finally {
      fsyncSpy.mockRestore();
    }
  });

  test("refuses linked and non-regular destinations", () => {
    const real = join(testDir, "real-config.json");
    writeFileSync(real, `${JSON.stringify(getDefaultConfig())}\n`, "utf8");
    symlinkSync(real, getConfigPath());
    expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
      status: "refused",
      reason: "existing-unsafe",
    });
    unlinkSync(getConfigPath());
    mkdirSync(getConfigPath());
    expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
      status: "refused",
      reason: "existing-unsafe",
    });
  });

  test("refuses a hard-linked destination without changing either link", () => {
    const real = join(testDir, "hard-linked-config.json");
    const bytes = `${JSON.stringify(getDefaultConfig())}\n`;
    writeFileSync(real, bytes, { mode: 0o600 });
    nodeFs.linkSync(real, getConfigPath());

    expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
      status: "refused",
      reason: "existing-unsafe",
    });
    expect(readFileSync(real, "utf8")).toBe(bytes);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });

  test("refuses an inaccessible existing file without replacing it", () => {
    if (process.platform === "win32") return;
    writeFileSync(getConfigPath(), `${JSON.stringify(getDefaultConfig())}\n`, { mode: 0o600 });
    chmodSync(getConfigPath(), 0o000);
    try {
      expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
        status: "refused",
        reason: "existing-inaccessible",
      });
    } finally {
      chmodSync(getConfigPath(), 0o600);
    }
  });

  test("refuses to claim a nonempty unowned configuration root", () => {
    const foreign = join(testDir, "foreign.txt");
    writeFileSync(foreign, "keep", "utf8");
    expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
      status: "refused",
      reason: "existing-unsafe",
    });
    expect(readFileSync(foreign, "utf8")).toBe("keep");
    expect(existsSync(getConfigPath())).toBe(false);
  });

  test("adopts a valid file that wins exclusive final creation", () => {
    const winner = { ...getDefaultConfig(), port: 12002 };
    const winnerBytes = `${JSON.stringify(winner)}\n`;
    const originalOpen = nodeFs.openSync;
    const openSpy = spyOn(nodeFs, "openSync").mockImplementation(((...args: unknown[]) => {
      if (args[0] === getConfigPath() && args[1] === "wx") {
        writeFileSync(getConfigPath(), winnerBytes, { mode: 0o600 });
        throw Object.assign(new Error("winner created config"), { code: "EEXIST" });
      }
      return (originalOpen as (...values: unknown[]) => number)(...args);
    }) as typeof nodeFs.openSync);

    try {
      expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({ status: "existing" });
      expect(readFileSync(getConfigPath(), "utf8")).toBe(winnerBytes);
    } finally {
      openSpy.mockRestore();
    }
  });

  test("refuses an invalid file that wins exclusive final creation", () => {
    const originalOpen = nodeFs.openSync;
    const openSpy = spyOn(nodeFs, "openSync").mockImplementation(((...args: unknown[]) => {
      if (args[0] === getConfigPath() && args[1] === "wx") {
        writeFileSync(getConfigPath(), "{", { mode: 0o600 });
        throw Object.assign(new Error("invalid winner created config"), { code: "EEXIST" });
      }
      return (originalOpen as (...values: unknown[]) => number)(...args);
    }) as typeof nodeFs.openSync);

    try {
      expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
        status: "refused",
        reason: "existing-invalid",
      });
      expect(readFileSync(getConfigPath(), "utf8")).toBe("{");
    } finally {
      openSpy.mockRestore();
    }
  });

  test("two processes racing initialization publish once and adopt the winner", async () => {
    const raceRoot = join(testDir, "raced-home");
    const releasePath = join(testDir, "race-release");
    const configModuleUrl = pathToFileURL(join(import.meta.dir, "../src/config.ts")).href;
    const children = ["a", "b"].map(id => {
      const readyPath = join(testDir, `race-${id}-ready`);
      const childSource = `
        import { existsSync, writeFileSync } from "node:fs";
        import {
          getDefaultConfig,
          initializeConfigIfMissing,
        } from ${JSON.stringify(configModuleUrl)};
        writeFileSync(${JSON.stringify(readyPath)}, "ready");
        while (!existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(5);
        console.log(JSON.stringify(initializeConfigIfMissing(getDefaultConfig())));
      `;
      return {
        child: Bun.spawn([process.execPath, "-e", childSource], {
          cwd: join(import.meta.dir, ".."),
          env: { ...process.env, CODEXCOMMANDER_HOME: raceRoot },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
        readyPath,
      };
    });

    try {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (children.every(({ readyPath }) => existsSync(readyPath))) break;
        await Bun.sleep(5);
      }
      expect(children.every(({ readyPath }) => existsSync(readyPath))).toBe(true);
      writeFileSync(releasePath, "go");
      const results = await Promise.all(children.map(async ({ child }) => {
        const exitCode = await Promise.race([
          child.exited,
          Bun.sleep(10_000).then(() => null),
        ]);
        if (exitCode === null) {
          child.kill();
          await child.exited;
          throw new Error("Timed out waiting for config initializer child");
        }
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();
        if (exitCode !== 0) {
          throw new Error(`Config initializer child exited ${exitCode}: ${stderr}`);
        }
        return JSON.parse(stdout.trim()) as ReturnType<typeof initializeConfigIfMissing>;
      }));

      expect(results.sort((left, right) => left.status.localeCompare(right.status))).toEqual([
        { status: "created" },
        { status: "existing" },
      ]);
      const finalPath = join(raceRoot, "config.json");
      expect(JSON.parse(readFileSync(finalPath, "utf8"))).toEqual(getDefaultConfig());
      expect(lstatSync(finalPath).nlink).toBe(1);
    } finally {
      writeFileSync(releasePath, "go");
      for (const { child } of children) {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    }
  }, { timeout: 20_000 });

  test("refuses a linked configuration root even when its target has valid ownership", () => {
    const realRoot = join(testDir, "owned-real-root");
    const linkedRoot = join(testDir, "linked-root");
    mkdirSync(realRoot);
    process.env.CODEXCOMMANDER_HOME = realRoot;
    expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({ status: "created" });
    unlinkSync(getConfigPath());
    symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    process.env.CODEXCOMMANDER_HOME = linkedRoot;

    expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
      status: "refused",
      reason: "existing-unsafe",
    });
    expect(existsSync(join(realRoot, "config.json"))).toBe(false);
  });

  test("does not reuse cached ownership after the configuration root was replaced", () => {
    const displacedRoot = `${testDir}.cached-root`;
    expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({ status: "created" });
    unlinkSync(getConfigPath());
    renameSync(testDir, displacedRoot);
    mkdirSync(testDir, { mode: 0o700 });
    try {
      expect(initializeConfigIfMissing(getDefaultConfig())).toEqual({
        status: "refused",
        reason: "existing-unsafe",
      });
      expect(existsSync(getConfigPath())).toBe(false);
    } finally {
      rmSync(displacedRoot, { recursive: true, force: true });
    }
  });

  test("distinguishes bigint root identities whose inode numbers collide after numeric conversion", () => {
    const firstIno = 2n ** 53n;
    const replacementIno = firstIno + 1n;
    expect(Number(firstIno)).toBe(Number(replacementIno));
    expect(sameConfigRootFileIdentity(
      { dev: 1n, ino: firstIno },
      { dev: 1n, ino: replacementIno },
    )).toBe(false);
  });
});

describe("CodexCommander config defaults", () => {
  test("usage and MCP config overrides change the effective bound while defaults remain compatible", () => {
    const defaults = getDefaultConfig();
    expect(defaults.managementUsageMaxReadBytes).toBe(64 * 1024 * 1024);
    const valid = validateConfigCandidate({
      ...defaults,
      managementUsageMaxReadBytes: 1024,
      providers: { ...defaults.providers, openai: { ...defaults.providers.openai!, mcpMaxTools: 1, mcpMaxSchemaBytes: 2, mcpMaxResultBytes: 3 } },
    });
    expect(valid).toMatchObject({ ok: true, config: { managementUsageMaxReadBytes: 1024, providers: { openai: { mcpMaxTools: 1, mcpMaxSchemaBytes: 2, mcpMaxResultBytes: 3 } } } });
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(validateConfigCandidate({ ...defaults, managementUsageMaxReadBytes: value }).ok).toBe(false);
      expect(validateConfigCandidate({ ...defaults, providers: { ...defaults.providers, openai: { ...defaults.providers.openai!, mcpMaxTools: value } } }).ok).toBe(false);
    }
  });
  test("atomic rename retries transient Windows sharing violations", () => {
    const sleeps: number[] = [];
    let attempts = 0;
    renameAtomicFile("source.tmp", "config.json", {
      platform: "win32",
      rename: () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
      },
      sleep: ms => sleeps.push(ms),
    });

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([25, 50]);
  });

  test("atomic rename does not retry non-transient errors", () => {
    let attempts = 0;
    expect(() => renameAtomicFile("source.tmp", "config.json", {
      platform: "win32",
      rename: () => {
        attempts += 1;
        throw Object.assign(new Error("invalid"), { code: "EINVAL" });
      },
      sleep: () => {},
    })).toThrow("invalid");
    expect(attempts).toBe(1);
  });
  test("Codex autostart is enabled by default", () => {
    expect(getDefaultConfig().codexAutoStart).toBe(true);
    expect(codexAutoStartEnabled({})).toBe(true);
  });

  test("appOwnedMemoryBudgetMb defaults to 256 MiB", () => {
    expect(getDefaultConfig().appOwnedMemoryBudgetMb).toBe(256);
    expect(validateConfigCandidate({ ...getDefaultConfig(), appOwnedMemoryBudgetMb: undefined })).toMatchObject({
      ok: true,
      config: { appOwnedMemoryBudgetMb: 256 },
    });
  });

  test("appOwnedMemoryBudgetMb accepts integer bounds and rejects raw invalid candidates before normalization", () => {
    expect(validateConfigCandidate({ ...getDefaultConfig(), appOwnedMemoryBudgetMb: 64 }).ok).toBe(true);
    expect(validateConfigCandidate({ ...getDefaultConfig(), appOwnedMemoryBudgetMb: 4096 }).ok).toBe(true);
    for (const value of [63, 4097, 64.5, "64", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateConfigCandidate({ ...getDefaultConfig(), appOwnedMemoryBudgetMb: value }).ok).toBe(false);
    }
  });

  test("Codex autostart can be disabled explicitly", () => {
    expect(codexAutoStartEnabled({ codexAutoStart: false })).toBe(false);
    expect(codexAutoStartEnabled({ codexAutoStart: true })).toBe(true);
  });

  test("config candidates reject blank server hostnames", () => {
    const base = getDefaultConfig();

    expect(validateConfigCandidate({ ...base, hostname: "" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("hostname"),
    });
    expect(validateConfigCandidate({ ...base, hostname: "   " })).toMatchObject({
      ok: false,
      error: expect.stringContaining("hostname"),
    });
    expect(validateConfigCandidate({ ...base, hostname: " 127.0.0.1 " })).toMatchObject({
      ok: false,
      error: expect.stringContaining("hostname"),
    });
    expect(validateConfigCandidate({ ...base, hostname: "127.0.0.1" })).toMatchObject({
      ok: true,
      config: expect.objectContaining({ hostname: "127.0.0.1" }),
    });
  });

  test("config candidates reject a malformed selection-order map", () => {
    const base = getDefaultConfig();

    expect(validateConfigCandidate({ ...base, codexAccountPriorities: { work: 2, side: 200 } })).toMatchObject({
      ok: false,
      error: expect.stringContaining("codexAccountPriorities"),
    });
    expect(validateConfigCandidate({ ...base, codexAccountPriorities: { "bad id!": 1 } })).toMatchObject({
      ok: false,
      error: expect.stringContaining("codexAccountPriorities"),
    });
    expect(validateConfigCandidate({ ...base, activeCodexAccountPinned: "not a valid id" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("activeCodexAccountPinned"),
    });
    for (const pin of [123, true, ["work"]]) {
      expect(validateConfigCandidate({ ...base, activeCodexAccountPinned: pin })).toMatchObject({
        ok: false,
        error: expect.stringContaining("activeCodexAccountPinned"),
      });
    }
    expect(validateConfigCandidate({
      ...base,
      codexAccountPriorities: { work: 2, __main__: -2 },
      activeCodexAccountPinned: "work",
    })).toMatchObject({
      ok: true,
      config: expect.objectContaining({
        codexAccountPriorities: { work: 2, __main__: -2 },
        activeCodexAccountPinned: "work",
      }),
    });
  });

  test("config candidates validate Claude Code subagent effort levels", () => {
    const base = getDefaultConfig();
    for (const subagentEffort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(validateConfigCandidate({
        ...base,
        claudeCode: { ...base.claudeCode, subagentEffort },
      })).toMatchObject({
        ok: true,
        config: { claudeCode: { subagentEffort } },
      });
    }
    expect(validateConfigCandidate({
      ...base,
      claudeCode: { ...base.claudeCode, subagentEffort: "ultra" },
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining("claudeCode.subagentEffort"),
    });
  });

  test("an invalid persisted Claude Code subagent effort rejects the config without logging its value", () => {
    const invalidEffort = "credential-like-value";
    writeConfig({
      port: 12345,
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "upstream-secret" } },
      apiKeys: [{ id: "key-1", name: "default", key: "ccx_persisted", createdAt: "2026-07-28T00:00:00.000Z" }],
      claudeCode: { subagentEffort: invalidEffort },
    });

    const diagnostics = readConfigDiagnostics();
    const diagnosticsError = diagnostics.error;

    expect(() => loadConfig()).toThrow("claudeCode.subagentEffort");
    expect(diagnostics).toMatchObject({
      source: "fallback",
      error: expect.stringContaining("claudeCode.subagentEffort"),
    });
    expect(diagnosticsError?.includes(invalidEffort)).toBe(false);
    expect(backupNames()).toHaveLength(0);
  });

  test("a blank hostname rejects the persisted config", () => {
    writeConfig({
      port: 12345,
      hostname: "",
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "upstream-secret" } },
      apiKeys: [{ id: "key-1", name: "default", key: "ccx_persisted", createdAt: "2026-07-28T00:00:00.000Z" }],
    });

    expectCurrentConfigRejected("hostname");
  });

  test("a non-string experimentalRealtimeWsBaseUrl rejects the persisted config", () => {
    writeConfig({
      port: 12345,
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "upstream-secret" } },
      experimentalRealtimeWsBaseUrl: true,
    });

    expectCurrentConfigRejected("experimentalRealtimeWsBaseUrl");
  });

  test("a string experimentalRealtimeWsBaseUrl round-trips through loadConfig", () => {
    writeConfig({
      port: 12345,
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
      experimentalRealtimeWsBaseUrl: "https://realtime.example.test/v1",
    });

    expect(loadConfig().experimentalRealtimeWsBaseUrl).toBe("https://realtime.example.test/v1");
  });

  test("a whitespace hostname rejects the persisted config", () => {
    writeConfig({
      port: 12345,
      hostname: "   ",
      defaultProvider: "custom",
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
    });

    expectCurrentConfigRejected("hostname");
  });

  test("Codex shim auto-restore defaults on with config and environment opt-out precedence", () => {
    expect(getDefaultConfig().codexShimAutoRestore).toBe(true);
    expect(codexShimAutoRestoreEnabled({}, {})).toBe(true);
    expect(codexShimAutoRestoreEnabled({ codexShimAutoRestore: true }, {})).toBe(true);
    expect(codexShimAutoRestoreEnabled({ codexShimAutoRestore: false }, {})).toBe(false);
    expect(codexShimAutoRestoreEnabled(
      { codexShimAutoRestore: false },
      { [CODEX_SHIM_AUTO_RESTORE_ENV]: "1" },
    )).toBe(false);
    expect(codexShimAutoRestoreEnabled({}, { [CODEX_SHIM_AUTO_RESTORE_ENV]: "0" })).toBe(false);
    expect(codexShimAutoRestoreEnabled(
      { codexShimAutoRestore: true },
      { [CODEX_SHIM_AUTO_RESTORE_ENV]: "0" },
    )).toBe(false);
  });

  test("codexShimAutoRestore loads false and rejects non-booleans", () => {
    const base = {
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
    };
    writeConfig({ ...base, codexShimAutoRestore: false });
    expect(readConfigDiagnostics().config.codexShimAutoRestore).toBe(false);

    for (const invalid of [null, "false", 0]) {
      writeConfig({ ...base, codexShimAutoRestore: invalid });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("codexShimAutoRestore");
    }
  });

  test("fresh config explicitly enables multi-agent guidance", () => {
    expect(getDefaultConfig().multiAgentGuidanceEnabled).toBe(true);
    expect(multiAgentGuidanceEnabled({ multiAgentGuidanceEnabled: true })).toBe(true);
    expect(multiAgentGuidanceEnabled({ multiAgentGuidanceEnabled: false })).toBe(false);
  });

  test("multiAgentGuidanceEnabled is required and rejects non-booleans", () => {
    const base = {
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
    };
    writeConfig({ ...base, multiAgentGuidanceEnabled: false });
    expect(loadConfig().multiAgentGuidanceEnabled).toBe(false);

    for (const invalid of [undefined, null, "false"]) {
      writeConfig({ ...base, multiAgentGuidanceEnabled: invalid });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("multiAgentGuidanceEnabled");
    }
  });

  test("the current top-level, Claude, and provider schemas reject unknown or malformed known fields", () => {
    const base = getDefaultConfig();
    const provider = base.providers.openai!;
    const rejected: Array<[string, unknown]> = [
      ["unknown top-level field", { ...base, removedState: true }],
      ["Claude boolean encoded as a string", {
        ...base,
        claudeCode: { enabled: "false", nativePassthrough: "false" },
      }],
      ["malformed provider API-key pool row", {
        ...base,
        providers: { openai: { ...provider, apiKeyPool: [{ key: "secret" }] } },
      }],
      ["removed provider field", {
        ...base,
        providers: { openai: { ...provider, unsafeAllowNativeLocalExec: true } },
      }],
      ["removed native-exec value", {
        ...base,
        providers: { openai: { ...provider, nativeLocalExec: "codex-sandbox" } },
      }],
      ["unknown guidance effort", { ...base, injectionEffort: "banana" }],
    ];

    for (const [_label, candidate] of rejected) {
      expect(validateConfigCandidate(candidate).ok).toBe(false);
    }
  });

  test("Claude Desktop schema errors do not expose attacker-controlled paths or inject log lines", () => {
    const unsafeField = "unsafe-desktop-route\nforged-line";
    const base = getDefaultConfig();
    writeConfig({
      ...base,
      claudeCode: {
        desktopProfile: {
          version: 1,
          assignments: {},
          defaults: { opus: null, fable: null, sonnet: null, haiku: null },
          [unsafeField]: true,
        },
      },
    });

    const diagnostics = readConfigDiagnostics();
    const diagnosticsError = diagnostics.error;
    expect(diagnostics).toMatchObject({
      source: "fallback",
      error: expect.stringContaining("claudeCode.desktopProfile"),
    });
    expect(String(diagnosticsError).includes(unsafeField)).toBe(false);
    expect(String(diagnosticsError)).toContain("current Claude Desktop profile schema");
  });

  test("native subagent-default sync is opt-in and rejects malformed field types", () => {
    const base = {
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
        },
      },
      defaultProvider: "custom",
      codexAccounts: [{ id: "account-1", email: "owner@example.test", isMain: true, logLabel: "pa11ce1" }],
      injectionModel: "gpt-5.6-terra",
    };
    expect(getDefaultConfig().syncCodexSubagentDefaults).toBeUndefined();

    for (const enabled of [true, false]) {
      writeConfig({ ...base, syncCodexSubagentDefaults: enabled });
      expect(loadConfig().syncCodexSubagentDefaults).toBe(enabled);
    }

    for (const invalid of [null, "true", 1]) {
      writeConfig({ ...base, syncCodexSubagentDefaults: invalid });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics).toMatchObject({
        source: "fallback",
        error: expect.stringContaining("syncCodexSubagentDefaults"),
      });
      expect(() => loadConfig()).toThrow("syncCodexSubagentDefaults");
    }
  });

  test("validates disk injection selections without disabling malformed opt-ins", () => {
    const base = {
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
    };
    writeConfig({
      ...base,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "ultra",
      syncCodexSubagentDefaults: true,
    });
    expect(loadConfig()).toMatchObject({
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "ultra",
      syncCodexSubagentDefaults: true,
    });

    for (const invalid of ["", "   "]) {
      writeConfig({ ...base, injectionModel: invalid, syncCodexSubagentDefaults: true });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("syncCodexSubagentDefaults");
    }

    for (const invalid of ["", "turbo"]) {
      writeConfig({
        ...base,
        injectionModel: "gpt-5.6-terra",
        injectionEffort: invalid,
        syncCodexSubagentDefaults: true,
      });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("injectionEffort");
    }

    for (const [field, invalid] of [["injectionModel", 1], ["injectionEffort", 1]] as const) {
      writeConfig({
        ...base,
        injectionModel: "gpt-5.6-terra",
        syncCodexSubagentDefaults: true,
        [field]: invalid,
      });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain(field);
      expect(() => loadConfig()).toThrow(field);
    }

    // Persisted guidance uses the same current Codex effort ladder even when
    // native Codex config mutation is not enabled.
    writeConfig({ ...base, injectionModel: "provider/model", injectionEffort: "provider-specific" });
    expectCurrentConfigRejected("injectionEffort");

    writeConfig({ ...base, syncCodexSubagentDefaults: true });
    const rejected = readConfigDiagnostics();
    expect(rejected.source).toBe("fallback");
    expect(rejected.error).toContain("syncCodexSubagentDefaults");
  });

  test("paused Codex account ids persist and reject malformed values", () => {
    const base = {
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
    };
    writeConfig({ ...base, pausedCodexAccountIds: ["__main__", "pool-a"] });
    expect(loadConfig().pausedCodexAccountIds).toEqual(["__main__", "pool-a"]);

    for (const invalid of ["pool-a", ["bad/account"], [1]]) {
      writeConfig({ ...base, pausedCodexAccountIds: invalid });
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("pausedCodexAccountIds");
    }
  });

  test("loads valid config from CODEXCOMMANDER_HOME", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      codexAutoStart: false,
    });

    expect(loadConfig()).toMatchObject({
      port: 12345,
      defaultProvider: "custom",
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      codexAutoStart: false,
    });
  });

  test("accepts OpenAI account mode only on the canonical forward provider", () => {
    for (const codexAccountMode of ["pool", "direct"] as const) {
      writeConfig({
        port: 12345,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
            codexAccountMode,
          },
        },
        defaultProvider: "openai",
      });
      expect(readConfigDiagnostics().config.providers.openai.codexAccountMode).toBe(codexAccountMode);
      expect(readConfigDiagnostics().error).toBeNull();
    }
  });

  test("rejects invalid or noncanonical codexAccountMode placements", () => {
    for (const [name, provider] of [
      ["custom", { adapter: "openai-chat", baseUrl: "https://example.test/v1", codexAccountMode: "pool" }],
      ["openai", { adapter: "openai-chat", baseUrl: "https://example.test/v1", codexAccountMode: "direct" }],
      ["openai", { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "random" }],
    ] as const) {
      writeConfig({ port: 12345, providers: { [name]: provider }, defaultProvider: name });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("codexAccountMode");
    }
  });

  test("accepts the exact responsesItemIdRepair shape and rejects the old nested placeholderIds proposal", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          responsesItemIdRepair: {
            reasoning: ["rs_0"],
            message: ["msg_0"],
            repairMissingTerminalIds: true,
          },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();
    expect(readConfigDiagnostics().config.providers.custom.responsesItemIdRepair).toEqual({
      reasoning: ["rs_0"],
      message: ["msg_0"],
      repairMissingTerminalIds: true,
    });

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          responsesItemIdRepair: {
            placeholderIds: { reasoning: ["rs_0"] },
          },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("responsesItemIdRepair");
  });

  test("accepts only a boolean responsesSnapshotRepair opt-in", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          responsesSnapshotRepair: true,
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();
    expect(readConfigDiagnostics().config.providers.custom.responsesSnapshotRepair).toBe(true);

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          responsesSnapshotRepair: { enabled: true },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("responsesSnapshotRepair");
  });

  test("accepts a relative responsesPath", () => {
    writeResponsesPathConfig("/responses");

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.providers.custom.responsesPath).toBe("/responses");
  });

  test("rejects responsesPath without a leading slash", () => {
    writeResponsesPathConfig("responses");

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("responsesPath must start with /");
  });

  test("rejects responsesPath containing a URL scheme, query, or fragment", () => {
    for (const [responsesPath, expectedError] of [
      ["https://other-origin.example/responses", "responsesPath must be a relative path without a URL scheme"],
      ["/https://other-origin.example/responses", "responsesPath must be a relative path without a URL scheme"],
      ["/responses?api-version=v1", "responsesPath must not include query strings or fragments"],
      ["/responses#section", "responsesPath must not include query strings or fragments"],
    ] as const) {
      writeResponsesPathConfig(responsesPath);

      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain(expectedError);
    }
  });

  test("reads valid config diagnostics without mutation", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      codexAutoStart: false,
    });

    const diagnostics = readConfigDiagnostics();

    expect(diagnostics.source).toBe("file");
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config).toMatchObject({
      port: 12345,
      defaultProvider: "custom",
      codexAutoStart: false,
    });
    expect(backupNames()).toHaveLength(0);
  });

  test("missing config diagnostics use defaults without creating files", () => {
    const beforeFiles = readdirSync(testDir).sort();
    const diagnostics = readConfigDiagnostics();
    const afterFiles = readdirSync(testDir).sort();

    expect(diagnostics).toEqual({
      config: getDefaultConfig(),
      source: "default",
      error: null,
    });
    expect(afterFiles).toEqual(beforeFiles);
  });

  test("malformed config diagnostics fall back without backup or raw content", () => {
    writeConfig('{ "apiKey": "sk-secret-leak", invalid json');
    const beforeFiles = readdirSync(testDir).sort();

    const diagnostics = readConfigDiagnostics();
    const afterFiles = readdirSync(testDir).sort();

    expect(diagnostics.config).toEqual(getDefaultConfig());
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toBe("invalid_json");
    expect(JSON.stringify(diagnostics)).not.toContain("sk-secret-leak");
    expect(afterFiles).toEqual(beforeFiles);
    expect(backupNames()).toHaveLength(0);
  });

  test("resolves relative CODEXCOMMANDER_HOME once to an absolute config directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ccx-config-parent-"));
    const oldCwd = process.cwd();
    try {
      process.env.CODEXCOMMANDER_HOME = "relative-home";
      process.chdir(parent);
      const firstPath = getConfigPath();
      const expectedConfigDir = resolve("relative-home");

      process.chdir(tmpdir());

      expect(firstPath).toBe(join(expectedConfigDir, "config.json"));
      expect(getConfigPath()).toBe(firstPath);
      expect(getPidPath()).toBe(join(expectedConfigDir, "codexcommander.pid"));
    } finally {
      process.chdir(oldCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("uses the canonical default home when no explicit home is set", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "ccx-default-home-"));
    const script = [
      'import { getConfigPath, getPidPath } from "./src/config.ts";',
      "console.log(JSON.stringify({ config: getConfigPath(), pid: getPidPath() }));",
    ].join("\n");
    try {
      const child = Bun.spawnSync({
        cmd: [process.execPath, "-e", script],
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          CODEXCOMMANDER_HOME: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(0);
      const paths = JSON.parse(new TextDecoder().decode(child.stdout)) as { config: string; pid: string };
      expect(paths.config).toBe(join(isolatedHome, ".codexcommander", "config.json"));
      expect(paths.pid).toBe(join(isolatedHome, ".codexcommander", "codexcommander.pid"));
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  test("the implicit home always selects the canonical root", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "ccx-implicit-home-"));
    const canonical = join(isolatedHome, ".codexcommander");
    mkdirSync(canonical);
    writeFileSync(join(canonical, "config.json"), "{}\n");
    const script = 'import { getConfigPath } from "./src/config.ts"; console.log(getConfigPath());';
    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      CODEXCOMMANDER_HOME: "",
    };

    try {
      const implicit = Bun.spawnSync({
        cmd: [process.execPath, "-e", script],
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(implicit.exitCode).toBe(0);
      expect(new TextDecoder().decode(implicit.stdout).trim()).toBe(join(canonical, "config.json"));
      expect(new TextDecoder().decode(implicit.stderr)).toBe("");
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  test("loads UTF-8 BOM config files written by Windows tools", () => {
    writeFileSync(
      getConfigPath(),
      `\uFEFF${JSON.stringify({
        port: 23456,
        providers: {
          custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
        },
        defaultProvider: "custom",
        multiAgentGuidanceEnabled: true,
      })}`,
      "utf-8",
    );

    expect(loadConfig()).toMatchObject({
      port: 23456,
      defaultProvider: "custom",
    });
  });

  test("rejects invalid JSON without backing up or replacing it", () => {
    writeConfig("{ invalid json");
    expect(() => loadConfig()).toThrow("invalid_json");
    expect(readConfigDiagnostics()).toMatchObject({ source: "fallback", error: "invalid_json" });
    expect(backupNames()).toHaveLength(0);
    expect(readFileSync(getConfigPath(), "utf-8")).toBe("{ invalid json");
  });

  test("rejects structurally incomplete config without merging defaults", () => {
    writeConfig({ port: 10100 });
    expectCurrentConfigRejected("providers");
  });

  test("rejects config when defaultProvider is absent from providers", () => {
    writeConfig({
      port: 10100,
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
      defaultProvider: "missing",
    });
    expectCurrentConfigRejected("defaultProvider must exist in providers");
  });

  test("diagnoses config with unsafe provider URLs or sensitive headers", () => {
    for (const provider of [
      { adapter: "openai-chat", baseUrl: "file:///tmp/provider" },
      { adapter: "openai-chat", baseUrl: " https://example.test/v1 " },
      { adapter: "openai-chat", baseUrl: "https://user:pass@example.test/v1" },
      { adapter: "openai-chat", baseUrl: "https://example.test/v1?token=secret" },
      { adapter: "openai-chat", baseUrl: "https://example.test/v1", headers: { Authorization: "Bearer secret" } },
      { adapter: "openai-chat", baseUrl: "https://example.test/v1", headers: { "X-Custom": "ok\r\nInjected: yes" } },
    ]) {
      rmSync(testDir, { recursive: true, force: true });
      mkdirSync(testDir, { recursive: true });
      writeConfig({
        port: 10100,
        providers: { custom: provider },
        defaultProvider: "custom",
      });

      const diagnostics = readConfigDiagnostics();

      expect(diagnostics.config).toEqual(getDefaultConfig());
      expect(diagnostics.source).toBe("fallback");
      expect(diagnostics.error).toContain("providers.custom");
      expect(JSON.stringify(diagnostics)).not.toContain("Bearer secret");
    }
  });

  test("accepts bearer transport only for Anthropic API-key providers", () => {
    const base = { port: 10100, defaultProvider: "gateway" };
    writeConfig({
      ...base,
      providers: {
        gateway: { adapter: "anthropic", baseUrl: "https://gateway.example/v1", authMode: "key", apiKeyTransport: "bearer" },
      },
    });
    expect(readConfigDiagnostics().error).toBeNull();

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          modelAdapters: { "provider-image-model": "openai-responses" },
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    for (const provider of [
      { adapter: "openai-chat", baseUrl: "https://gateway.example/v1", authMode: "key", apiKeyTransport: "bearer" },
      { adapter: "anthropic", baseUrl: "https://gateway.example/v1", authMode: "oauth", apiKeyTransport: "bearer" },
    ]) {
      writeConfig({ ...base, providers: { gateway: provider } });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("apiKeyTransport");
    }
  });

  test("validates provider context cap maps explicitly", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      providerContextCaps: { custom: 350_000 },
    });

    expect(loadConfig().providerContextCaps).toEqual({ custom: 350_000 });

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      providerContextCaps: { custom: -1 },
    });

    const diagnostics = readConfigDiagnostics();

    expect(diagnostics.config).toEqual(getDefaultConfig());
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("providerContextCaps");
  });

  test("modelMaxInputTokens accepts only plain positive finite integer records", () => {
    expect(positiveIntegerRecordConfigError({ "gpt-5.6-sol": 922_000 }, "modelMaxInputTokens")).toBeNull();
    expect(positiveIntegerRecordConfigError(Object.create({ inherited: 1 }), "modelMaxInputTokens")).toContain("own properties");
    for (const invalid of [null, [], { model: 0 }, { model: -1 }, { model: 1.5 }, { model: "1" }, { model: Number.POSITIVE_INFINITY }]) {
      expect(positiveIntegerRecordConfigError(invalid, "modelMaxInputTokens")).not.toBeNull();
    }
  });

  test("modelSupportsReasoningSummaries accepts only plain boolean records", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelSupportsReasoningSummaries: { strict: false, normal: true },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    for (const invalid of [[], { strict: "false" }, { "": false }]) {
      writeConfig({
        port: 12345,
        providers: {
          custom: {
            adapter: "openai-responses",
            baseUrl: "https://example.test/v1",
            modelSupportsReasoningSummaries: invalid,
          },
        },
        defaultProvider: "custom",
      });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("modelSupportsReasoningSummaries");
    }
  });

  test("modelReasoningSummaryDelivery validates known values and rejects summary opt-out conflicts (#538)", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelSupportsReasoningSummaries: { strict: true },
          modelReasoningSummaryDelivery: {
            strict: "sequential",
            concurrent: "concurrent_cutoff",
          },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    for (const modelReasoningSummaryDelivery of [
      [],
      { strict: "serial" },
      { "": "sequential" },
    ]) {
      writeConfig({
        port: 12345,
        providers: {
          custom: {
            adapter: "openai-responses",
            baseUrl: "https://example.test/v1",
            modelReasoningSummaryDelivery,
          },
        },
        defaultProvider: "custom",
      });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("modelReasoningSummaryDelivery");
    }

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelSupportsReasoningSummaries: { STRICT: false },
          modelReasoningSummaryDelivery: { strict: "sequential" },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("conflicts with modelSupportsReasoningSummaries=false");
  });

  test("modelPreferHostedTools accepts only supported hosted-tool arrays", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    // A registry `modelWireDefaults` entry that selects openai-responses for a
    // Responses inbound must be honored by validation, exactly as the runtime
    // honors it. DeepSeek's preset routes `deepseek-v4-flash` over native
    // Responses for a Responses inbound while the provider-wide wire stays
    // openai-chat; validating from `registry.adapter` alone rejected a
    // preference the runtime would have accepted.
    writeConfig({
      port: 12345,
      providers: {
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com/v1",
          modelPreferHostedTools: { "deepseek-v4-flash": ["image_generation"] },
        },
      },
      defaultProvider: "deepseek",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    // The mirror of the case above. `volcengine-agent-plan` is a Responses registry row
    // with `preserveCustomDestination`, so a config reusing that id while pointing at a
    // different endpoint keeps its own transport at runtime —
    // `providerMatchesRegistryTransport()` returns false and `routedProviderConfig()`
    // preserves the configured `openai-chat` adapter. Validating from `registry.adapter`
    // unconditionally would accept a preference that the Responses adapter never sees.
    writeConfig({
      port: 12345,
      providers: {
        "volcengine-agent-plan": {
          adapter: "openai-chat",
          baseUrl: "https://custom.example.test/v1",
          modelPreferHostedTools: { "some-model": ["image_generation"] },
        },
      },
      defaultProvider: "volcengine-agent-plan",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("requires the openai-responses wire");

    // The forward-auth half of the same effective-transport question. A
    // `preserveCustomDestination` registry row reused under a different endpoint keeps
    // its OWN auth at runtime, not the registry's, because `routedProviderConfig()`
    // honors `providerMatchesRegistryTransport()`. Deciding forward-auth from
    // `registry.authKind` alone accepted a preference the adapter never applies:
    // `preferConfiguredHostedTools()` runs only on the non-forward branch.
    writeConfig({
      port: 12345,
      providers: {
        "volcengine-agent-plan": {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://custom.example.test/v1",
          modelPreferHostedTools: { "some-model": ["image_generation"] },
        },
      },
      defaultProvider: "volcengine-agent-plan",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("not supported on forward-auth");

    // Registry providers route through their registry wire, not this persisted adapter.
    writeConfig({
      port: 12345,
      providers: {
        "openai-apikey": {
          adapter: "openai-chat",
          baseUrl: "https://api.openai.com/v1",
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "openai-apikey",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    writeConfig({
      port: 12345,
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          modelAdapters: { "gpt-5.6-sol": "openai-chat" },
          modelPreferHostedTools: { "gpt-5.6-sol-pro": ["image_generation"] },
        },
      },
      defaultProvider: "openai-apikey",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("requires the openai-responses wire");

    for (const modelPreferHostedTools of [
      [],
      { "": ["image_generation"] },
      { model: [] },
      { model: "image_generation" },
      { model: ["web_search"] },
    ]) {
      writeConfig({
        port: 12345,
        providers: {
          custom: {
            adapter: "openai-responses",
            baseUrl: "https://example.test/v1",
            modelPreferHostedTools,
          },
        },
        defaultProvider: "custom",
      });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("modelPreferHostedTools");
    }

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("requires the openai-responses wire");

    writeConfig({
      port: 12345,
      providers: {
        openrouter: {
          adapter: "openai-responses",
          baseUrl: "https://openrouter.ai/api/v1",
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "openrouter",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("requires the openai-responses wire");

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelAdapters: { "provider-image-model": "openai-chat" },
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("requires the openai-responses wire");

    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          modelPreferHostedTools: { "gpt-5.3-codex-spark": ["image_generation"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("does not support");

    writeConfig({
      port: 12345,
      providers: {
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
        },
      },
      defaultProvider: "openai",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("not supported on forward-auth");
  });

  test("modelAdapters accepts only allowed wires on eligible providers (#404)", () => {
    writeConfig({
      port: 12345,
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          modelAdapters: { "grok-4.5": "openai-responses" },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().error).toBeNull();

    for (const invalid of [
      [],
      { "grok-4.5": true },
      { "": "openai-chat" },
      // Provider-specific adapters carry their own credential semantics.
      { "grok-4.5": "cursor" },
      { "grok-4.5": "anthropic" },
    ]) {
      writeConfig({
        port: 12345,
        providers: {
          custom: {
            adapter: "openai-chat",
            baseUrl: "https://example.test/v1",
            modelAdapters: invalid,
          },
        },
        defaultProvider: "custom",
      });
      expect(readConfigDiagnostics().source).toBe("fallback");
      expect(readConfigDiagnostics().error).toContain("modelAdapters");
    }
  });

  test("modelAdapters rejects wire-pinned models rather than ignoring them (#404)", () => {
    writeConfig({
      port: 12345,
      providers: {
        "opencode-go": {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          modelAdapters: { "minimax-m3": "openai-chat" },
        },
      },
      defaultProvider: "opencode-go",
    });

    // The resolver would silently ignore this; failing load tells the user why.
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("modelAdapters");
  });

  test("modelAdapters is rejected on the canonical forward provider (#404)", () => {
    writeConfig({
      port: 12345,
      providers: {
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          modelAdapters: { "gpt-5.5": "openai-chat" },
        },
      },
      defaultProvider: "openai",
    });

    // Switching that provider to the chat wire would drop the forwarded credential.
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("modelAdapters");
  });

  test("output token defaults accept only positive finite integers", () => {
    expect(positiveIntegerConfigError(128_000, "defaultMaxOutputTokens")).toBeNull();
    for (const invalid of [null, [], {}, 0, -1, 1.5, "128000", Number.POSITIVE_INFINITY]) {
      expect(positiveIntegerConfigError(invalid, "defaultMaxOutputTokens")).not.toBeNull();
    }

    expect(positiveIntegerRecordConfigError({ "glm-5.2": 128_000 }, "modelMaxOutputTokens")).toBeNull();
    expect(positiveIntegerRecordConfigError({ "glm-5.2": 0 }, "modelMaxOutputTokens")).not.toBeNull();
  });

  test("disk config rejects malformed output token defaults", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", defaultMaxOutputTokens: 1.5 },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("providers.custom.defaultMaxOutputTokens");

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", modelMaxOutputTokens: { model: 0 } },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("providers.custom.modelMaxOutputTokens");
  });

  test("disk config rejects malformed modelMaxInputTokens", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", modelMaxInputTokens: { model: 1.5 } },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(readConfigDiagnostics().error).toContain("providers.custom.modelMaxInputTokens");
  });

  test("disk config preserves valid OpenRouter routing and rejects invalid destinations", () => {
    writeConfig({
      port: 10100,
      providers: {
        openrouter: {
          adapter: "openai-chat",
          baseUrl: "https://openrouter.ai/api/v1",
          openRouterRouting: { order: ["deepseek"], allowFallbacks: false },
          modelOpenRouterRouting: { "anthropic/claude-sonnet-5": { only: ["anthropic"] } },
        },
      },
      defaultProvider: "openrouter",
    });
    expect(loadConfig().providers.openrouter).toMatchObject({
      openRouterRouting: { order: ["deepseek"], allowFallbacks: false },
      modelOpenRouterRouting: { "anthropic/claude-sonnet-5": { only: ["anthropic"] } },
    });

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          openRouterRouting: { only: ["deepseek"] },
        },
      },
      defaultProvider: "custom",
    });
    expect(readConfigDiagnostics()).toMatchObject({
      source: "fallback",
      error: expect.stringContaining("canonical https://openrouter.ai/api/v1"),
    });
  });

  test("disk config rejects forged registry-only virtual model maps", () => {
    writeConfig({
      port: 10100,
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          virtualModels: { "gpt-evil-pro": { wireModelId: "gpt-evil", reasoningMode: "pro" } },
        },
      },
      defaultProvider: "openai-apikey",
    });
    expect(readConfigDiagnostics()).toMatchObject({ source: "fallback", error: expect.stringContaining("unrecognized field") });
  });

  test("validates the global context cap value", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      contextCapValue: 500_000,
    });

    expect(loadConfig().contextCapValue).toBe(500_000);

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      defaultProvider: "custom",
      contextCapValue: -5,
    });

    const diagnostics = readConfigDiagnostics();

    expect(diagnostics.config).toEqual(getDefaultConfig());
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("contextCapValue");
  });

  test("rejects config when provider validation fails during load", () => {
    writeConfig({
      port: 10100,
      providers: {
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", headers: { Authorization: "Bearer secret" } },
      },
      defaultProvider: "custom",
    });
    expectCurrentConfigRejected("providers.custom.headers");
  });

  test("provider names reject namespace-breaking and reserved object keys", () => {
    expect(isValidProviderName("openrouter")).toBe(true);
    expect(isValidProviderName("ollama-cloud")).toBe(true);
    expect(isValidProviderName("openrouter/custom")).toBe(false);
    expect(isValidProviderName("__proto__")).toBe(false);
    expect(isValidProviderName("constructor")).toBe(false);
  });

  test("persists an explicit Codex account selector map without enabling it by default", () => {
    const selectors = {
      desktop: "@main",
      work: "work-account",
      legacy: "work-account",
      poolNamedMain: "main",
    };
    writeAccountNamespaceConfig(selectors);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.config.codexAccountNamespaces).toEqual(selectors);
    expect(Object.hasOwn(getDefaultConfig(), "codexAccountNamespaces")).toBe(false);
  });

  test("validates Claude Desktop profiles and Codex account selectors independently", () => {
    const desktopProfile = {
      version: 1,
      assignments: {},
      defaults: { opus: null, fable: null, sonnet: null, haiku: null },
    };
    writeAccountNamespaceConfig({ main: "@main" }, { claudeCode: { desktopProfile } });
    expect(readConfigDiagnostics()).toMatchObject({
      error: null,
      config: { claudeCode: { desktopProfile }, codexAccountNamespaces: { main: "@main" } },
    });

    writeAccountNamespaceConfig({ main: "@main" }, {
      claudeCode: { desktopProfile: { ...desktopProfile, version: 2 } },
    });
    expect(readConfigDiagnostics().error).toContain("claudeCode.desktopProfile");

    writeAccountNamespaceConfig({ "bad/selector": "account-id" }, { claudeCode: { desktopProfile } });
    expect(readConfigDiagnostics().error).toContain('codexAccountNamespaces."bad/selector"');
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "main"],
  ] as const)("rejects Codex account selectors stored as %s", (_label, selectors) => {
    writeAccountNamespaceConfig(selectors);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("codexAccountNamespaces must be a plain object");
  });

  test.each([
    ["blank", "", "side-account"],
    ["surrounding whitespace", " side", "side-account"],
    ["a slash", "side/account", "side-account"],
    ["a reserved prototype key", "__proto__", "side-account"],
    ["a reserved constructor key", "constructor", "side-account"],
    ["an empty target", "side", ""],
    ["the internal main account id", "side", "__main__"],
    ["a reserved prototype target", "side", "__proto__"],
    ["a reserved prototype-name target", "side", "prototype"],
    ["a reserved constructor target", "side", "Constructor"],
    ["a target with whitespace", "side", "side account"],
    ["a target with a slash", "side", "account/id"],
    ["an overlong target", "side", "a".repeat(65)],
    ["a non-string target", "side", 42],
  ] as const)("rejects %s in the Codex account selector map", (_label, selector, target) => {
    writeAccountNamespaceConfig(Object.fromEntries([[selector, target]]));

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("codexAccountNamespaces");
  });

  test.each([
    [
      "a configured provider",
      { side: "side-account" },
      {
        providers: {
          side: { adapter: "openai-chat", baseUrl: "https://side.example.test/v1" },
        },
        defaultProvider: "side",
      },
      "must not collide",
    ],
    [
      "a configured provider with different casing",
      { SIDE: "side-account" },
      {
        providers: {
          side: { adapter: "openai-chat", baseUrl: "https://side.example.test/v1" },
        },
        defaultProvider: "side",
      },
      "must not collide",
    ],
    ["the combo namespace", { combo: "side-account" }, {}, "must not collide"],
    ["the combo namespace with different casing", { Combo: "side-account" }, {}, "must not collide"],
    ["the canonical OpenAI namespace with different casing", { OpenAI: "side-account" }, {}, "must not collide"],
    [
      "a combo alias prefix",
      { side: "side-account" },
      {
        combos: {
          intentional: {
            alias: "side/gpt-5.5",
            targets: [{ provider: "openai", model: "gpt-5.5" }],
          },
        },
      },
      "combo alias must not use a configured Codex account namespace",
    ],
    [
      "a whitespace-padded combo alias prefix",
      { side: "side-account" },
      {
        combos: {
          intentional: {
            alias: " side/gpt-5.5 ",
            targets: [{ provider: "openai", model: "gpt-5.5" }],
          },
        },
      },
      "combo alias must not use a configured Codex account namespace",
    ],
    [
      "a configured pool account id",
      { work: "pool-a" },
      {
        codexAccounts: [{
          id: "work",
          email: "work@example.test",
          isMain: false,
          logLabel: "pa11ce2",
        }],
      },
      "must not collide with configured Codex pool-account ids or account selector targets",
    ],
    [
      "another selector target",
      { primary: "side", side: "pool-a" },
      {},
      "must not collide with configured Codex pool-account ids or account selector targets",
    ],
  ] as const)("rejects a Codex account selector colliding with %s", (_label, selectors, overrides, error) => {
    writeAccountNamespaceConfig(selectors, overrides);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain(error);
  });

  test("rejects config when defaultProvider only exists on Object prototype", () => {
    writeConfig({
      port: 10100,
      providers: {},
      defaultProvider: "constructor",
    });
    expectCurrentConfigRejected("defaultProvider must exist in providers");
  });

  test("repeated invalid loads reject without mutation or warning memo state", () => {
    writeConfig("{ invalid json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => loadConfig()).toThrow("invalid_json");
      expect(() => loadConfig()).toThrow("invalid_json");

      expect(backupNames()).toHaveLength(0);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("parses pid files", () => {
    expect(parsePidFile("12345")).toBe(12345);
    expect(parsePidFile("0")).toBeNull();
    expect(parsePidFile("12x")).toBeNull();
    expect(parsePidFile("not-json")).toBeNull();
  });

  test("recognizes CodexCommander start command lines", () => {
    expect(isCodexCommanderStartCommandLine('"C:/tools/bun/bin/bun.exe" "run" "src/cli/index.ts" "start"')).toBe(true);
    expect(isCodexCommanderStartCommandLine('bun C:/tools/codexcommander/src/cli/index.ts start')).toBe(true);
    expect(isCodexCommanderStartCommandLine("ccx start")).toBe(true);
    expect(isCodexCommanderStartCommandLine("codexcommander start")).toBe(true);

    expect(isCodexCommanderStartCommandLine("bun run src/cli/index.ts status")).toBe(false);
    expect(isCodexCommanderStartCommandLine("bun C:/nvm/node_modules/.codexcommander-temp/bin/run start")).toBe(false);
    expect(isCodexCommanderStartCommandLine("bun C:/work/codexcommander/tests/start.ts start")).toBe(false);
    expect(isCodexCommanderStartCommandLine("bun test C:/work/codexcommander/tests/config.test.ts")).toBe(false);
    expect(isCodexCommanderStartCommandLine("notepad.exe")).toBe(false);
  });

  test("writes pid file as a numeric pid", () => {
    writePid(process.pid);

    expect(readFileSync(getPidPath(), "utf-8")).toBe(String(process.pid));
  });

  test("removes pid file only when the expected pid still matches", () => {
    writeFileSync(getPidPath(), "111", "utf-8");
    removePid(222);
    expect(existsSync(getPidPath())).toBe(true);

    removePid(111);
    expect(existsSync(getPidPath())).toBe(false);
  });

  test("runtime port metadata round-trips and validates expected pid", () => {
    const attestationSecret = "A".repeat(43);
    writeRuntimePort({ pid: 1234, port: 58195, hostname: "0.0.0.0", attestationSecret });

    const expected = { schemaVersion: 1, pid: 1234, port: 58195, hostname: "0.0.0.0", attestationSecret };
    expect(JSON.parse(readFileSync(getRuntimePortPath(), "utf-8"))).toEqual(expected);
    expect(readRuntimePort()).toEqual(expected);
    expect(readRuntimePort(1234)).toEqual(expected);
    expect(readRuntimePort(9999)).toBeNull();
  });

  test("runtime port metadata removal preserves newer pid state", () => {
    writeRuntimePort({ pid: 1234, port: 58195 });

    removeRuntimePort(9999);
    expect(existsSync(getRuntimePortPath())).toBe(true);

    removeRuntimePort(1234);
    expect(existsSync(getRuntimePortPath())).toBe(false);
  });

  test("invalid runtime port metadata returns null", () => {
    writeFileSync(getRuntimePortPath(), JSON.stringify({ schemaVersion: 1, pid: 1234, port: 99999 }), "utf-8");

    expect(readRuntimePort()).toBeNull();

    writeFileSync(getRuntimePortPath(), JSON.stringify({ schemaVersion: 1, pid: 1234, port: 58195, attestationSecret: "too-short" }), "utf-8");
    expect(readRuntimePort()).toBeNull();

    writeFileSync(getRuntimePortPath(), JSON.stringify({ pid: 1234, port: 58195 }), "utf-8");
    expect(readRuntimePort()).toBeNull();

    writeFileSync(getRuntimePortPath(), JSON.stringify({ schemaVersion: 1, pid: 1234, port: 58195, legacyPort: 58195 }), "utf-8");
    expect(readRuntimePort()).toBeNull();
  });
});

describe("config.ts – Windows ACL hardening integration", () => {
  test("successive atomic temps for one destination are each hardened and then forgotten", () => {
    const destination = join(testDir, "atomic-secret.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ccx-test-user";
    windowsAcl.resetHardenedStateForTests();
    windowsAcl.setPlatformForTests("win32");
    let grants = 0;
    windowsAcl.setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) grants += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    const io = {
      write: (path: string, content: string) => writeFileSync(path, content, { mode: 0o600 }),
      harden: (path: string) => {
        chmodSync(path, 0o600);
        windowsAcl.hardenSecretPath(path, { required: true });
      },
      rename: renameSync,
      truncate: (path: string) => truncateSync(path, 0),
      unlink: unlinkSync,
    };
    try {
      atomicWriteFile(destination, "first", io);
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(0);
      atomicWriteFile(destination, "second", io);
      expect(readFileSync(destination, "utf8")).toBe("second");
      expect(grants).toBe(2);
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      windowsAcl.setIcaclsRunnerForTests(null);
      windowsAcl.setPlatformForTests(null);
      windowsAcl.resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("failed residual unlink retains the exact temp memo until later cleanup", () => {
    const destination = join(testDir, "residual-secret.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ccx-test-user";
    windowsAcl.resetHardenedStateForTests();
    windowsAcl.setPlatformForTests("win32");
    windowsAcl.setIcaclsRunnerForTests(() => ({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: "",
    }));
    let residual: string | null = null;
    try {
      atomicWriteFile(destination, "secret", {
        write: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
        harden: path => { windowsAcl.hardenSecretPath(path, { required: true }); },
        rename: () => {
          const error = new Error("rename failed") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        },
        truncate: path => truncateSync(path, 0),
        unlink: path => {
          residual = path;
          const error = new Error("unlink failed") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      });
      throw new Error("expected residual error");
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicWriteResidualTempError);
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(1);
      expect(residual).not.toBeNull();
      expect(residual).toContain(".ccx.");
      unlinkSync(residual!);
      windowsAcl.forgetHardenedSecretPath(residual!);
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      windowsAcl.setIcaclsRunnerForTests(null);
      windowsAcl.setPlatformForTests(null);
      windowsAcl.resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("hardenConfigDir delegates to hardenSecretDir with required:false on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretDir").mockReturnValue({ ok: true });
      mkdirSync(testDir, { recursive: true });
      hardenConfigDir();
      expect(spy).toHaveBeenCalledWith(testDir, { required: false });
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("hardenConfigDir does not call hardenSecretDir on non-Windows", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretDir");
      mkdirSync(testDir, { recursive: true });
      hardenConfigDir();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("hardenExistingSecret delegates to hardenSecretPath with required:false on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretPath").mockReturnValue({ ok: true });
      const filePath = join(testDir, "auth.json");
      writeFileSync(filePath, "{}", "utf-8");
      hardenExistingSecret(filePath);
      expect(spy).toHaveBeenCalledWith(filePath, { required: false });
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("hardenExistingSecret does not throw when ACL helper returns ok:false on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretPath").mockReturnValue({
        ok: false,
        diagnostics: "ACL hardening not supported on this filesystem",
      });
      const filePath = join(testDir, "auth.json");
      writeFileSync(filePath, "{}", "utf-8");
      expect(() => hardenExistingSecret(filePath)).not.toThrow();
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("saveConfig applies hardenSecretDir with required:true on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretDir").mockReturnValue({ ok: true });
      saveConfig(getDefaultConfig());
      expect(spy).toHaveBeenCalledWith(testDir, {
        required: true,
        timeoutMemoKey: `${testDir}::config-mutation`,
      });
      expect(existsSync(getConfigPath())).toBe(true);
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("saveConfig degrades when config-mutation directory hardening fails on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spy = spyOn(windowsAcl, "hardenSecretDir").mockImplementation((_path, opts) => {
        if (opts?.required) throw new Error("ACL hardening failed: access denied");
        return { ok: true };
      });
      expect(() => saveConfig(getDefaultConfig())).not.toThrow();
      expect(existsSync(getConfigPath())).toBe(true);
      spy.mockRestore();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("loadConfig does not throw when ACL helper fails non-fatally on win32", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const spy1 = spyOn(windowsAcl, "hardenSecretDir").mockReturnValue({
      ok: false,
      diagnostics: "ACL hardening failed — filesystem may not support per-user ACLs",
    });
    const spy2 = spyOn(windowsAcl, "hardenSecretPath").mockReturnValue({ ok: false, diagnostics: "ACL unavailable" });
    try {
      const config = loadConfig();
      expect(config).toEqual(getDefaultConfig());
    } finally {
      spy1.mockRestore();
      spy2.mockRestore();
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  test("saveConfig does not call hardenSecretDir on non-Windows", () => {
    if (process.platform === "win32") return;
    const spy = spyOn(windowsAcl, "hardenSecretDir");
    saveConfig(getDefaultConfig());
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(getConfigPath())).toBe(true);
    spy.mockRestore();
  });
});

describe("config.ts – sync writer timeout keying (#840 refinement)", () => {
  test("the production sync harden keys timeouts by destination", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "config.ts"), "utf-8");
    expect(source).toContain("hardenSecretPath(target, { required: true, timeoutMemoKey: path })");
  });

  test("timed-out write with a RESIDUAL temp retains both memos (fail-closed)", () => {
    const destination = join(testDir, "residual-timeout.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ccx-test-user";
    windowsAcl.resetHardenedStateForTests();
    windowsAcl.setPlatformForTests("win32");
    windowsAcl.setIcaclsRunnerForTests(() => ({ success: false, exitCode: null, timedOut: true, stdout: "" }));
    const io = {
      write: (path: string, content: string) => writeFileSync(path, content, { mode: 0o600 }),
      harden: (path: string) => {
        chmodSync(path, 0o600);
        windowsAcl.hardenSecretPath(path, { required: true, timeoutMemoKey: destination });
      },
      rename: renameSync,
      truncate: (path: string) => truncateSync(path, 0),
      unlink: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    };
    try {
      expect(() => atomicWriteFile(destination, "secret", io)).toThrow();
      // Destination timeout memo retained (anti-restall) while the residual
      // temp remains on disk.
      expect(windowsAcl.timedOutSecretPathCountForTests()).toBe(1);
    } finally {
      windowsAcl.setIcaclsRunnerForTests(null);
      windowsAcl.setPlatformForTests(null);
      windowsAcl.resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });
});

describe("config.ts – atomic writes preserve symlinked destinations", () => {
  test("a symlinked destination survives the write and the real file receives it", () => {
    // Dotfiles shape: ~/.codex/config.toml -> ~/dotfiles/.codex/config.toml
    const repoDir = join(testDir, "dotfiles");
    mkdirSync(repoDir, { recursive: true });
    const realFile = join(repoDir, "config.toml");
    writeFileSync(realFile, "original", "utf-8");
    const link = join(testDir, "config.toml");
    symlinkSync(realFile, link);

    atomicWriteFile(link, "rewritten");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(realFile);
    expect(readFileSync(realFile, "utf8")).toBe("rewritten");
    expect(readFileSync(link, "utf8")).toBe("rewritten");
  });

  test("no temp file is left beside the link or its target", () => {
    const repoDir = join(testDir, "dotfiles-clean");
    mkdirSync(repoDir, { recursive: true });
    const realFile = join(repoDir, "config.toml");
    writeFileSync(realFile, "original", "utf-8");
    const link = join(testDir, "config-clean.toml");
    symlinkSync(realFile, link);

    atomicWriteFile(link, "rewritten");

    expect(readdirSync(repoDir).filter(name => name.includes(".ccx."))).toEqual([]);
    expect(readdirSync(testDir).filter(name => name.includes(".ccx."))).toEqual([]);
  });

  test("a plain destination is unaffected", () => {
    const destination = join(testDir, "plain.toml");
    atomicWriteFile(destination, "first");
    atomicWriteFile(destination, "second");

    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(readFileSync(destination, "utf8")).toBe("second");
  });

  test("a destination that does not exist yet is created at the literal path", () => {
    const destination = join(testDir, "created.toml");
    expect(existsSync(destination)).toBe(false);

    atomicWriteFile(destination, "fresh");

    expect(readFileSync(destination, "utf8")).toBe("fresh");
  });

  test("a dangling symlink is preserved and the write is refused", () => {
    const link = join(testDir, "dangling.toml");
    symlinkSync(join(testDir, "gone", "config.toml"), link);

    // The target volume may only be temporarily unavailable; replacing the link
    // would recreate the dotfiles divergence this fix exists to prevent.
    expect(() => atomicWriteFile(link, "recovered")).toThrow(/unresolvable symlinked write target/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(testDir, "gone"))).toBe(false);
  });
});

describe("config.ts – async atomic writes preserve symlinked destinations", () => {
  test("a symlinked destination survives the write and the real file receives it", async () => {
    const repoDir = join(testDir, "dotfiles-async");
    mkdirSync(repoDir, { recursive: true });
    const realFile = join(repoDir, "config.toml");
    writeFileSync(realFile, "original", "utf-8");
    const link = join(testDir, "config-async.toml");
    symlinkSync(realFile, link);

    await atomicWriteFileAsync(link, "rewritten");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(realFile);
    expect(readFileSync(realFile, "utf8")).toBe("rewritten");
    expect(readFileSync(link, "utf8")).toBe("rewritten");
  });

  test("no temp file is left beside the link or its target", async () => {
    const repoDir = join(testDir, "dotfiles-async-clean");
    mkdirSync(repoDir, { recursive: true });
    const realFile = join(repoDir, "config.toml");
    writeFileSync(realFile, "original", "utf-8");
    const link = join(testDir, "config-async-clean.toml");
    symlinkSync(realFile, link);

    await atomicWriteFileAsync(link, "rewritten");

    expect(readdirSync(repoDir).filter(name => name.includes(".ccx."))).toEqual([]);
    expect(readdirSync(testDir).filter(name => name.includes(".ccx."))).toEqual([]);
  });

  test("a plain destination is unaffected", async () => {
    const destination = join(testDir, "plain-async.toml");
    await atomicWriteFileAsync(destination, "first");
    await atomicWriteFileAsync(destination, "second");

    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(readFileSync(destination, "utf8")).toBe("second");
  });

  test("a dangling symlink is preserved and the write is refused", async () => {
    const link = join(testDir, "dangling-async.toml");
    symlinkSync(join(testDir, "gone-async", "config.toml"), link);

    await expect(atomicWriteFileAsync(link, "recovered")).rejects.toThrow(/unresolvable symlinked write target/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(testDir, "gone-async"))).toBe(false);
  });
});

describe("codex account selection order", () => {
  function writePriorityConfig(
    codexAccountPriorities: unknown,
    overrides: Record<string, unknown> = {},
  ): void {
    writeConfig({
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
      codexAccountPriorities,
      ...overrides,
    });
  }

  test("round-trips pool ids, the main account, and negative order", () => {
    const priorities = { work: 2, side: 1, __main__: -2 };
    writePriorityConfig(priorities);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.source).toBe("file");
    expect(diagnostics.config.codexAccountPriorities).toEqual(priorities);
    expect(Object.hasOwn(getDefaultConfig(), "codexAccountPriorities")).toBe(false);
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "work"],
    ["a fractional value", { work: 1.5 }],
    ["a stringified number", { work: "2" }],
    ["a boolean", { work: true }],
    ["an above-range value", { work: 101 }],
    ["a below-range value", { work: -101 }],
    ["a reserved constructor key", { constructor: 1 }],
    ["a slash in the key", { "work/account": 1 }],
  ] as const)("rejects %s instead of deleting the malformed ordering field", (_label, priorities) => {
    writePriorityConfig(priorities);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("codexAccountPriorities");
    expect(diagnostics.config.codexAccountPriorities).toBeUndefined();
    expect(backupNames()).toHaveLength(0);
  });

  test("rejects a literal __proto__ entry materialized as an own key", () => {
    writeConfig(
      '{"port":10100,"providers":{"openai":{"adapter":"openai-responses",'
      + '"baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward"}},'
      + '"defaultProvider":"openai","codexAccountPriorities":{"__proto__":1,"work":2}}',
    );

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.error).toContain("codexAccountPriorities");
    expect(diagnostics.config.codexAccountPriorities).toBeUndefined();
  });

  test("load rejects a malformed selection-order map without mutation", () => {
    writePriorityConfig({ work: 101 });
    expectCurrentConfigRejected("codexAccountPriorities");
  });

  test("keeps a valid pin and rejects a malformed one", () => {
    writePriorityConfig({ work: 1 }, { activeCodexAccountPinned: "work" });
    expect(readConfigDiagnostics().config.activeCodexAccountPinned).toBe("work");

    writePriorityConfig({ work: 1 }, { activeCodexAccountPinned: "work/account" });
    const rejected = readConfigDiagnostics();
    expect(rejected.source).toBe("fallback");
    expect(rejected.error).toContain("activeCodexAccountPinned");
    expect(rejected.config.activeCodexAccountPinned).toBeUndefined();
  });
});

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimOwnedServiceHome } from "./helpers/owned-service-home";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";
import { CCX_SECTION_MARKER } from "../src/codex/injected-marker";
import { MANAGED_AGENTS_TABLE_MARKER, MANAGED_SUBAGENT_DEFAULT_MARKER } from "../src/codex/subagent-defaults";
import { buildGrokManagedBlock } from "../src/grok/inject";

setDefaultTimeout(30_000);

const repoRoot = join(import.meta.dir, "..");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("no free port")));
    });
  });
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function runtimeProxyPid(ccxHome: string, port: number): Promise<number | null> {
  try {
    const runtime = JSON.parse(readFileSync(join(ccxHome, "runtime-port.json"), "utf8")) as {
      pid?: number;
      port?: number;
    };
    if (!Number.isSafeInteger(runtime.pid) || runtime.port !== port) return null;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return null;
    const health = await response.json() as { service?: string; pid?: number; port?: number };
    return health.service === "codexcommander" && health.pid === runtime.pid && health.port === port
      ? runtime.pid ?? null
      : null;
  } catch {
    return null;
  }
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitUntil(async () => child.exitCode !== null || child.signalCode !== null, 5_000)) return;
  child.kill("SIGKILL");
  await waitUntil(async () => child.exitCode !== null || child.signalCode !== null, 2_000);
}

async function runCliAsync(
  cliArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["run", "src/cli/index.ts", ...cliArgs], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${cliArgs.join(" ")}`));
    }, 25_000);
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", status => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function ownedEnvironment(codexHome: string, ccxHome: string): Record<string, string> {
  const home = join(ccxHome, "home");
  mkdirSync(home, { recursive: true });
  return { HOME: home, USERPROFILE: home, ...claimOwnedServiceHome(codexHome, ccxHome, home).env };
}

function currentConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
    ...overrides,
  };
}

describe("ccx restore back", () => {
  test("Restore Native leaves this home's live proxy running and direct Start routes Codex back without rebinding", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-live-start-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-live-start-home-"));
    const port = await freePort();
    let proxy: ChildProcess | null = null;
    try {
      const configPath = join(codexHome, "config.toml");
      writeFileSync(configPath, 'model = "gpt-5.5"\n', { mode: 0o600 });
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig({
        port,
        hostname: "127.0.0.1",
        codexAutoStart: false,
        clientIntegrations: { grok: false },
        multiAgentGuidanceEnabled: false,
        providers: {
          fixture: {
            adapter: "openai-chat",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "fixture-key",
            allowPrivateNetwork: true,
            liveModels: false,
            models: ["fixture-model"],
            defaultModel: "fixture-model",
          },
        },
        defaultProvider: "fixture",
      })), { mode: 0o600 });
      const codexCliPath = createCodexRuntimeFixture(ccxHome);
      const env = {
        ...process.env,
        ...ownedEnvironment(codexHome, ccxHome),
        CODEX_HOME: codexHome,
        CODEXCOMMANDER_HOME: ccxHome,
        CODEX_CLI_PATH: codexCliPath,
        CCX_DISABLE_COMPANION: "1",
        CI: "1",
      };

      proxy = spawn(process.execPath, ["run", "src/cli/index.ts", "start", "--port", String(port)], {
        cwd: repoRoot,
        env: { ...env, CCX_SERVICE: "1" },
        stdio: "ignore",
      });
      const originalPidReady = await waitUntil(async () => (await runtimeProxyPid(ccxHome, port)) !== null);
      expect(originalPidReady).toBe(true);
      const originalPid = await runtimeProxyPid(ccxHome, port);
      expect(originalPid).not.toBeNull();
      const journalPath = join(codexHome, "codexcommander-journal.json");
      const profilePath = join(codexHome, "codexcommander.config.toml");
      const catalogPath = join(codexHome, "codexcommander-catalog.json");
      const cachePath = join(codexHome, "models_cache.json");
      const injected = await waitUntil(async () => (
        existsSync(journalPath)
        && existsSync(profilePath)
        && existsSync(catalogPath)
        && existsSync(cachePath)
        && readFileSync(configPath, "utf8").includes(CCX_SECTION_MARKER)
      ));
      expect(injected).toBe(true);
      expect(JSON.parse(readFileSync(journalPath, "utf8")).pid).toBe(originalPid);

      const restored = await runCliAsync(["restore"], env);
      expect(restored.status).toBe(0);
      expect(JSON.parse(readFileSync(join(ccxHome, "config.json"), "utf8")).clientIntegrations.codex).toBe(false);
      expect(await runtimeProxyPid(ccxHome, port)).toBe(originalPid);
      expect(existsSync(journalPath)).toBe(true);
      const nativeBaseline = readFileSync(configPath, "utf8");
      expect(nativeBaseline).not.toContain(CCX_SECTION_MARKER);
      const inertArtifacts = new Map([
        [profilePath, readFileSync(profilePath)],
        [catalogPath, readFileSync(catalogPath)],
        [cachePath, readFileSync(cachePath)],
      ]);

      const started = await runCliAsync(["start", "--port", String(port)], env);
      expect(started.status, `stdout=${started.stdout}\nstderr=${started.stderr}`).toBe(0);
      expect(started.stdout).toContain("Codex now routes through it");
      expect(JSON.parse(readFileSync(join(ccxHome, "config.json"), "utf8")).clientIntegrations?.codex).not.toBe(false);
      expect(readFileSync(configPath, "utf8")).toContain(CCX_SECTION_MARKER);
      expect(readFileSync(configPath, "utf8")).toContain(`openai_base_url = "http://127.0.0.1:${port}/v1"`);
      expect(await runtimeProxyPid(ccxHome, port)).toBe(originalPid);
      expect(existsSync(journalPath)).toBe(true);
      const freshJournal = JSON.parse(readFileSync(journalPath, "utf8"));
      expect(freshJournal.pid).toBe(originalPid);
      expect(Buffer.from(freshJournal.originalConfig, "base64").toString("utf8")).toBe(nativeBaseline);
      for (const path of inertArtifacts.keys()) expect(existsSync(path) && readFileSync(path).length > 0).toBe(true);
    } finally {
      await stopChild(proxy);
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("direct Start refuses a recordless fallback listener without changing routing or binding", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-fallback-start-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-fallback-start-home-"));
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        return new URL(req.url).pathname === "/healthz"
          ? Response.json({ status: "ok", service: "codexcommander", pid: process.pid, port: proxy.port })
          : new Response("not found", { status: 404 });
      },
    });
    try {
      const configPath = join(codexHome, "config.toml");
      const nativeConfig = 'model = "gpt-5.5"\n';
      writeFileSync(configPath, nativeConfig, { mode: 0o600 });
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig({
        port: proxy.port,
        hostname: "127.0.0.1",
        clientIntegrations: { codex: false },
      })), { mode: 0o600 });
      const env = {
        ...process.env,
        ...ownedEnvironment(codexHome, ccxHome),
        CODEX_HOME: codexHome,
        CODEXCOMMANDER_HOME: ccxHome,
        CCX_DISABLE_COMPANION: "1",
        CI: "1",
      };

      const started = await runCliAsync(["start", "--port", String(proxy.port)], env);
      expect(started.status).toBe(1);
      expect(started.stderr).toContain("recordless or different-home proxy");
      expect(JSON.parse(readFileSync(join(ccxHome, "config.json"), "utf8")).clientIntegrations.codex).toBe(false);
      expect(readFileSync(configPath, "utf8")).toBe(nativeConfig);
      expect(existsSync(join(ccxHome, "codexcommander.pid"))).toBe(false);
      expect(existsSync(join(ccxHome, "runtime-port.json"))).toBe(false);
      expect(await fetch(`http://127.0.0.1:${proxy.port}/healthz`).then(response => response.ok)).toBe(true);
    } finally {
      proxy.stop(true);
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("restore durably disables Codex in an isolated home", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-restore-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-restore-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig()), "utf8");
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ccxHome), CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome, CI: "1" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(ccxHome, "config.json"), "utf8")).clientIntegrations.codex).toBe(false);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Codex integration is OFF and plain `codex` now runs natively.");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("Restore Native is Codex-only and preserves an enabled Grok fence", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-restore-codex-only-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-restore-codex-only-home-"));
    const grokHome = join(ccxHome, "grok");
    try {
      mkdirSync(grokHome);
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig({
        clientIntegrations: { grok: true },
      })), "utf8");
      const grokPath = join(grokHome, "config.toml");
      const grokBefore = `theme = "dark"\n\n${buildGrokManagedBlock(10100, [{ id: "xai/grok-4.5" }])}\n`;
      writeFileSync(grokPath, grokBefore, "utf8");

      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...ownedEnvironment(codexHome, ccxHome),
          CODEX_HOME: codexHome,
          CODEXCOMMANDER_HOME: ccxHome,
          GROK_HOME: grokHome,
          CI: "1",
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(readFileSync(grokPath, "utf8")).toBe(grokBefore);
      expect(JSON.parse(readFileSync(join(ccxHome, "config.json"), "utf8")).clientIntegrations)
        .toEqual({ grok: true, codex: false });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("Grok");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("a refused Restore Native neither strips nor claims the enabled Grok fence", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-refused-restore-codex-only-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-refused-restore-codex-only-home-"));
    const grokHome = join(ccxHome, "grok");
    try {
      mkdirSync(join(codexHome, "config.toml"));
      mkdirSync(grokHome);
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig({
        clientIntegrations: { grok: true },
      })), "utf8");
      const grokPath = join(grokHome, "config.toml");
      const grokBefore = `theme = "dark"\n\n${buildGrokManagedBlock(10100, [{ id: "xai/grok-4.5" }])}\n`;
      writeFileSync(grokPath, grokBefore, "utf8");

      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...ownedEnvironment(codexHome, ccxHome),
          CODEX_HOME: codexHome,
          CODEXCOMMANDER_HOME: ccxHome,
          GROK_HOME: grokHome,
          CI: "1",
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(readFileSync(grokPath, "utf8")).toBe(grokBefore);
      expect(JSON.parse(readFileSync(join(ccxHome, "config.json"), "utf8")).clientIntegrations)
        .toEqual({ grok: true, codex: false });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("Grok");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("restore --json emits a schema-complete envelope on the already-OFF no-op path", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-json-noop-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-json-noop-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig({
        clientIntegrations: { codex: false },
      })), "utf8");
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore", "--json"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ccxHome), CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        success: boolean;
        artifacts: Record<"config" | "catalog", { state: string; changed: boolean; message: string }>;
      };
      // Early exits must stay shape-stable with CodexNativeRestoreResult:
      // consumers never special-case a valid outcome.
      expect(envelope.success).toBe(true);
      for (const key of ["config", "catalog"] as const) {
        expect(envelope.artifacts[key].state).toBe("skipped");
        expect(envelope.artifacts[key].changed).toBe(false);
        expect(typeof envelope.artifacts[key].message).toBe("string");
      }
      expect(envelope.artifacts.catalog).toHaveProperty("removed", 0);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("restore --json separates a desired-state change from config.toml artifacts", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-json-switch-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-json-switch-home-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const native = 'model = "gpt-5"\n';
      writeFileSync(configPath, native, "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig()), "utf8");
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore", "--json"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ccxHome), CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.artifacts.config).toMatchObject({
        state: "skipped",
        changed: false,
        action: "unchanged",
      });
      expect(readFileSync(configPath, "utf8")).toBe(native);
      expect(JSON.parse(readFileSync(join(ccxHome, "config.json"), "utf8")).clientIntegrations.codex).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("restore --json reports an external provider as preserved", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-json-external-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-json-external-home-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const external = [
        'model_provider = "custom"',
        "[model_providers.custom]",
        'base_url = "https://gateway.example/v1"',
        "",
      ].join("\n");
      writeFileSync(configPath, external, "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig()), "utf8");
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore", "--json"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ccxHome), CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.artifacts.config).toMatchObject({
        state: "skipped",
        changed: false,
        action: "external-provider-preserved",
      });
      expect(readFileSync(configPath, "utf8")).toBe(external);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("restore --json keeps its schema when config.toml is unreadable as a file", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-json-bad-config-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-json-bad-config-home-"));
    try {
      mkdirSync(join(codexHome, "config.toml"));
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig()), "utf8");
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "restore", "--json"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ccxHome), CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome },
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        success: false,
        artifacts: {
          config: { state: "failed", changed: false, action: "failed" },
          catalog: { state: "skipped", changed: false },
        },
      });
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("sync treats durable OFF as a successful no-write policy result", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-sync-off-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-sync-off-home-"));
    try {
      const configPath = join(codexHome, "config.toml");
      writeFileSync(configPath, 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig({
        clientIntegrations: { codex: false },
      })), "utf8");
      const before = statSync(configPath).mtimeMs;
      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "sync"], {
        cwd: repoRoot,
        env: { ...process.env, ...ownedEnvironment(codexHome, ccxHome), CODEX_HOME: codexHome, CODEXCOMMANDER_HOME: ccxHome, CI: "1" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Codex integration is OFF; sync skipped and no Codex files changed.");
      expect(statSync(configPath).mtimeMs).toBe(before);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("sync exits nonzero when managed-default cleanup is ambiguous", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-cli-sync-codex-"));
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-sync-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), [
        MANAGED_AGENTS_TABLE_MARKER,
        "[agents]",
        MANAGED_SUBAGENT_DEFAULT_MARKER,
        "[notice]",
        'default_subagent_model = "gpt-5.6-sol"',
        "",
      ].join("\n"), "utf8");
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig({
        providers: {
          fixture: {
            adapter: "openai-chat",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "fixture-key",
            allowPrivateNetwork: true,
            models: ["fixture-model"],
          },
        },
        defaultProvider: "fixture",
      })), "utf8");
      const codexCliPath = createCodexRuntimeFixture(ccxHome);

      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "sync"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...ownedEnvironment(codexHome, ccxHome),
          CODEX_HOME: codexHome,
          CODEXCOMMANDER_HOME: ccxHome,
          CODEX_CLI_PATH: codexCliPath,
          CI: "1",
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Codex sync did not complete");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });

  test("help documents both directions of the switch", () => {
    const ccxHome = mkdtempSync(join(tmpdir(), "ccx-cli-help-home-"));
    try {
      writeFileSync(join(ccxHome, "config.json"), JSON.stringify(currentConfig()), "utf8");
      const run = (...cliArgs: string[]) => spawnSync(process.execPath, ["run", "src/cli/index.ts", ...cliArgs], {
        cwd: repoRoot,
        env: { ...process.env, CODEXCOMMANDER_HOME: ccxHome, CI: "1" },
        encoding: "utf8",
      });
      const usage = run("help");
      expect(usage.status).toBe(0);
      expect(`${usage.stdout}\n${usage.stderr}`).toContain("ccx restore back");
      const restoreHelp = run("help", "restore");
      expect(restoreHelp.status).toBe(0);
      expect(`${restoreHelp.stdout}\n${restoreHelp.stderr}`).toContain("ccx restore [back]");
    } finally {
      rmSync(ccxHome, { recursive: true, force: true });
    }
  });
});

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStatusPid, selectListenTarget } from "../src/cli/status";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";
import { SPAWN_BUDGET_MS } from "./helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

function runStatusJson(codexCommanderHome: string, extraEnv: Record<string, string> = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ccx-status-runtime-"));
  try {
    const codexCliPath = createCodexRuntimeFixture(runtimeDir);
    return spawnSync(process.execPath, [cliPath, "status", "--json"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEXCOMMANDER_HOME: codexCommanderHome,
        CODEX_CLI_PATH: codexCliPath,
        ...extraEnv,
      },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

describe("CLI status JSON", () => {
  test("status --json prints valid read-only diagnostics without secrets", () => {
    const codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-status-json-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ccx-status-codex-home-"));
    writeFileSync(join(codexHome, "config.toml"), `model = "gpt-5"\n`, "utf8");
    try {
      const configPath = join(codexCommanderHome, "config.json");
      writeFileSync(configPath, JSON.stringify({
        port: 9,
        multiAgentGuidanceEnabled: true,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
            apiKey: "sk-test-secret",
          },
        },
        defaultProvider: "openai",
        codexAutoStart: false,
      }), "utf8");

      const beforeFiles = readdirSync(codexCommanderHome).sort();
      const beforeCodexHome = readdirSync(codexHome).sort();
      const result = runStatusJson(codexCommanderHome, { CODEX_HOME: codexHome });
      const afterFiles = readdirSync(codexCommanderHome).sort();
      const afterCodexHome = readdirSync(codexHome).sort();

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(afterFiles).toEqual(beforeFiles);
      expect(afterCodexHome).toEqual(beforeCodexHome);
      expect(existsSync(join(codexCommanderHome, "codexcommander.pid"))).toBe(false);

      const parsed = JSON.parse(result.stdout) as {
        schemaVersion?: unknown;
        proxy?: { running?: unknown; pid?: unknown; health?: { ok?: unknown; url?: unknown; message?: unknown } };
        dashboard?: { url?: unknown };
        listen?: { port?: unknown; source?: unknown };
        paths?: { config?: unknown; pid?: unknown; runtime?: unknown };
        runtime?: { source?: unknown };
        codexAutostart?: unknown;
        startup?: {
          status?: unknown;
          rebootSafe?: unknown;
          routingInjected?: unknown;
          serviceInstalled?: unknown;
          shimInstalled?: unknown;
          shimHealthy?: unknown;
          shimCoverage?: unknown;
          serviceSupported?: unknown;
          commands?: unknown;
        };
        defaultProvider?: unknown;
        config?: { source?: unknown; error?: unknown };
        service?: { summary?: unknown };
        codexShim?: { summary?: unknown };
        codexPlugins?: { applicable?: unknown };
        codexRuntime?: {
          path?: unknown;
          version?: unknown;
          source?: unknown;
          warning?: unknown;
          newerAvailable?: unknown;
          catalogClamp?: { active?: unknown; removedEfforts?: unknown; runtimeVersion?: unknown };
        };
        codexHome?: {
          effectiveCodexHome?: unknown;
          appCodexHome?: unknown;
          mismatch?: unknown;
          warning?: unknown;
          action?: unknown;
        };
      };

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.proxy?.running).toBe(false);
      expect(parsed.proxy?.pid).toBeNull();
      expect(parsed.proxy?.health?.ok).toBe(false);
      expect(parsed.proxy?.health?.url).toBe("http://127.0.0.1:9/healthz");
      expect(typeof parsed.proxy?.health?.message).toBe("string");
      expect(parsed.dashboard?.url).toBe("http://localhost:9/");
      expect(parsed.listen?.port).toBe(9);
      expect(parsed.listen?.source).toBe("config");
      expect(parsed.paths?.config).toBe(configPath);
      expect(parsed.paths?.pid).toBe(join(codexCommanderHome, "codexcommander.pid"));
      expect(typeof parsed.paths?.runtime).toBe("string");
      expect(typeof parsed.runtime?.source).toBe("string");
      expect(parsed.codexAutostart).toBe(false);
      expect(["native", "protected", "at-risk"]).toContain(parsed.startup?.status);
      expect(typeof parsed.startup?.rebootSafe).toBe("boolean");
      expect(typeof parsed.startup?.routingInjected).toBe("boolean");
      expect(typeof parsed.startup?.serviceInstalled).toBe("boolean");
      expect(typeof parsed.startup?.shimInstalled).toBe("boolean");
      expect(typeof parsed.startup?.shimHealthy).toBe("boolean");
      expect(["full", "cli-only", "none"]).toContain(parsed.startup?.shimCoverage);
      expect(typeof parsed.startup?.serviceSupported).toBe("boolean");
      expect(typeof parsed.startup?.commands).toBe("object");
      expect(parsed.defaultProvider).toBe("openai");
      expect(parsed.config?.source).toBe("file");
      expect(parsed.config?.error).toBeNull();
      expect(typeof parsed.service?.summary).toBe("string");
      expect(typeof parsed.codexShim?.summary).toBe("string");
      expect(parsed.codexPlugins).toBeDefined();
      expect(typeof parsed.codexPlugins?.applicable).toBe("boolean");
      expect(typeof parsed.codexRuntime?.path).toBe("string");
      expect(typeof parsed.codexRuntime?.source).toBe("string");
      expect(parsed.codexRuntime?.version === null || typeof parsed.codexRuntime?.version === "string").toBe(true);
      expect(parsed.codexRuntime?.warning === null || typeof parsed.codexRuntime?.warning === "string").toBe(true);
      expect(
        parsed.codexRuntime?.newerAvailable === null
        || (typeof parsed.codexRuntime?.newerAvailable === "object" && parsed.codexRuntime?.newerAvailable !== null),
      ).toBe(true);
      expect(parsed.codexRuntime?.catalogClamp?.active).toBe(false);
      expect(Array.isArray(parsed.codexRuntime?.catalogClamp?.removedEfforts)).toBe(true);
      expect(parsed.codexRuntime?.catalogClamp?.runtimeVersion).toBeNull();
      expect(typeof parsed.codexHome?.effectiveCodexHome).toBe("string");
      expect(typeof parsed.codexHome?.appCodexHome).toBe("string");
      expect(typeof parsed.codexHome?.mismatch).toBe("boolean");
      expect(parsed.codexHome?.warning === null || typeof parsed.codexHome?.warning === "string").toBe(true);

      const serialized = JSON.stringify(parsed).toLowerCase();
      for (const forbidden of ["apikey", "sk-test-secret", "token", "refreshtoken", "authorization", "email"]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      rmSync(codexCommanderHome, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("status --json reports catalogClamp.runtimeVersion when clamp is active", async () => {
    const { chmodSync } = await import("node:fs");
    const { persistEffortClamp, resetCodexRuntimeResolveCacheForTests } = await import("../src/codex/runtime");
    const codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-status-clamp-"));
    try {
      writeFileSync(join(codexCommanderHome, "config.json"), JSON.stringify({
        port: 9,
        providers: {},
        defaultProvider: "openai",
      }), "utf8");
      const fakeCodex = process.platform === "win32"
        ? join(codexCommanderHome, "bin", "codex.cmd")
        : join(codexCommanderHome, "bin", "codex");
      mkdirSync(join(codexCommanderHome, "bin"), { recursive: true });
      if (process.platform === "win32") {
        writeFileSync(fakeCodex, "@echo off\r\necho codex-cli 0.133.0\r\n", "utf8");
      } else {
        writeFileSync(fakeCodex, "#!/bin/sh\necho 'codex-cli 0.133.0'\n", "utf8");
        chmodSync(fakeCodex, 0o755);
      }
      persistEffortClamp({
        runtimePath: fakeCodex,
        runtimeVersion: "0.133.0",
        removedEfforts: ["max", "ultra"],
        affectedModels: ["gpt-5.6-sol"],
      }, { configDir: codexCommanderHome });
      resetCodexRuntimeResolveCacheForTests();

      const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CODEXCOMMANDER_HOME: codexCommanderHome,
          CODEX_CLI_PATH: fakeCodex,
          PATH: "",
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        codexRuntime?: {
          version?: string | null;
          catalogClamp?: { active?: boolean; removedEfforts?: string[]; runtimeVersion?: string | null };
        };
      };
      expect(parsed.codexRuntime?.version).toBe("0.133.0");
      expect(parsed.codexRuntime?.catalogClamp).toEqual({
        active: true,
        removedEfforts: ["max", "ultra"],
        runtimeVersion: "0.133.0",
      });
    } finally {
      resetCodexRuntimeResolveCacheForTests();
      rmSync(codexCommanderHome, { recursive: true, force: true });
    }
  });

  test("status rejects unknown flags instead of silently printing human text", () => {
    const codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-status-json-"));
    try {
      writeFileSync(join(codexCommanderHome, "config.json"), JSON.stringify({
        port: 9,
        providers: {},
        defaultProvider: "openai",
      }), "utf8");

      const result = spawnSync(process.execPath, [cliPath, "status", "--yaml"], {
        cwd: repoRoot,
        env: { ...process.env, CODEXCOMMANDER_HOME: codexCommanderHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: ccx status [--json]");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(codexCommanderHome, { recursive: true, force: true });
    }
  });

  test("status --json rejects additional flags", () => {
    const codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-status-json-"));
    try {
      writeFileSync(join(codexCommanderHome, "config.json"), JSON.stringify({
        port: 9,
        providers: {},
        defaultProvider: "openai",
      }), "utf8");

      const result = spawnSync(process.execPath, [cliPath, "status", "--json", "--yaml"], {
        cwd: repoRoot,
        env: { ...process.env, CODEXCOMMANDER_HOME: codexCommanderHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: ccx status [--json]");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(codexCommanderHome, { recursive: true, force: true });
    }
  });

  test("status --json on malformed config remains read-only and secret-safe", () => {
    const codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-status-json-"));
    try {
      const configPath = join(codexCommanderHome, "config.json");
      writeFileSync(configPath, '{ "apiKey": "sk-status-secret", invalid json', "utf8");
      const beforeFiles = readdirSync(codexCommanderHome).sort();

      const result = runStatusJson(codexCommanderHome);
      const afterFiles = readdirSync(codexCommanderHome).sort();

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(afterFiles).toEqual(beforeFiles);
      expect(afterFiles.some(name => name.startsWith("config.json.invalid-"))).toBe(false);

      const parsed = JSON.parse(result.stdout) as {
        config?: { source?: unknown; error?: unknown };
        paths?: { config?: unknown };
      };
      expect(parsed.paths?.config).toBe(configPath);
      expect(parsed.config?.source).toBe("fallback");
      expect(parsed.config?.error).toBe("invalid_json");

      const serialized = JSON.stringify(parsed);
      expect(serialized).not.toContain("sk-status-secret");
      expect(serialized).not.toContain("apiKey");
    } finally {
      rmSync(codexCommanderHome, { recursive: true, force: true });
    }
  });

  test("listen target prefers current runtime port metadata", () => {
    const target = selectListenTarget(
      { port: 10100, hostname: "0.0.0.0" },
      123,
      { pid: 123, port: 58195, hostname: "0.0.0.0" },
    );

    expect(target.source).toBe("runtime");
    expect(target.port).toBe(58195);
    expect(target.healthUrl).toBe("http://127.0.0.1:58195/healthz");
    expect(target.dashboardUrl).toBe("http://localhost:58195/");
  });

  test("resolveStatusPid preserves an authoritative null from live orphan checks", () => {
    expect(resolveStatusPid({ pid: null }, 4242)).toBeNull();
    expect(resolveStatusPid({ pid: 1111 }, 4242)).toBe(1111);
    expect(resolveStatusPid(null, 4242)).toBe(4242);
    expect(resolveStatusPid(null, null)).toBeNull();
  });

  test("listen target brackets raw IPv6 hostnames in the health URL", () => {
    const target = selectListenTarget(
      { port: 10100, hostname: "::1" },
      123,
      { pid: 123, port: 58195, hostname: "::1" },
    );

    expect(target.healthUrl).toBe("http://[::1]:58195/healthz");
    expect(target.dashboardUrl).toBe("http://localhost:58195/");
  });

  test("listen target ignores stale runtime port metadata", () => {
    const target = selectListenTarget(
      { port: 10100, hostname: "127.0.0.1" },
      123,
      { pid: 999, port: 58195 },
    );

    expect(target.source).toBe("config");
    expect(target.port).toBe(10100);
    expect(target.healthUrl).toBe("http://127.0.0.1:10100/healthz");
    expect(target.dashboardUrl).toBe("http://localhost:10100/");
  });
});

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

/**
 * Every subprocess in this file runs against a private temp CODEXCOMMANDER_HOME so no
 * check can ever discover/inspect/mutate the operator's real proxy state. The
 * ready describe keeps ONLY the help-routing subprocess checks: the
 * network/no-proxy/argument-validation ready tests live as injected tests in
 * tests/cli-ready.test.ts (no real loopback/home).
 */
function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10000,
  });
}

function isolatedHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeIsolatedConfig(dir: string): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    port: 19999,
    multiAgentGuidanceEnabled: true,
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    defaultProvider: "openai",
    codexAutoStart: false,
  }), "utf8");
}

describe("ccx restart", () => {
  test("detached restart accepts only exact schema-v1 runtime metadata", () => {
    const script = readFileSync(join(repoRoot, "scripts", "ccx-restart.sh"), "utf8");
    const validator = /node - "\$1" <<'NODE'\n([\s\S]*?)\nNODE/.exec(script)?.[1];
    expect(validator).toBeDefined();
    const dir = isolatedHome("ccx-restart-runtime-schema-");
    const record = join(dir, "runtime-port.json");
    const validate = (value: unknown) => {
      writeFileSync(record, JSON.stringify(value), "utf8");
      return spawnSync("node", ["-", record], { input: validator!, encoding: "utf8" });
    };
    try {
      const valid = validate({
        schemaVersion: 1,
        pid: 4242,
        port: 18181,
        hostname: "127.0.0.1",
        attestationSecret: "A".repeat(43),
      });
      expect(valid.status).toBe(0);
      expect(valid.stdout).toBe("18181");
      for (const invalid of [
        { pid: 4242, port: 18181 },
        { schemaVersion: 2, pid: 4242, port: 18181 },
        { schemaVersion: 1, pid: 4242, port: 18181, legacyPort: 18181 },
        { schemaVersion: 1, pid: "4242", port: 18181 },
        { schemaVersion: 1, pid: 4242, port: 18181, attestationSecret: "short" },
      ]) {
        const rejected = validate(invalid);
        expect(rejected.status).toBe(1);
        expect(rejected.stdout).toBe("");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restart --help prints usage", () => {
    const dir = isolatedHome("ccx-restart-help-");
    try {
      const result = runCli(["restart", "--help"], { CODEXCOMMANDER_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ccx restart");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("help restart shows restart help entry", () => {
    const dir = isolatedHome("ccx-restart-help-entry-");
    try {
      const result = runCli(["help", "restart"], { CODEXCOMMANDER_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Stop the proxy and restart");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ccx health", () => {
  test("health --help prints usage", () => {
    const dir = isolatedHome("ccx-health-help-");
    try {
      const result = runCli(["health", "--help"], { CODEXCOMMANDER_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ccx health");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("help health shows health help entry", () => {
    const dir = isolatedHome("ccx-health-help-entry-");
    try {
      const result = runCli(["help", "health"], { CODEXCOMMANDER_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Check proxy health");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("health exits 1 with no proxy running (isolated home)", () => {
    const dir = isolatedHome("ccx-health-");
    writeIsolatedConfig(dir);
    try {
      const result = runCli(["health"], { CODEXCOMMANDER_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("not healthy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("health --json exits 1 with valid JSON when no proxy", () => {
    const dir = isolatedHome("ccx-health-json-");
    writeIsolatedConfig(dir);
    try {
      const result = runCli(["health", "--json"], { CODEXCOMMANDER_HOME: dir });
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.pid).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ccx ready", () => {
  // Only the help-routing subprocess checks live here. The default-probe,
  // --json, --wait, --timeout, and argument-validation cases are injected tests
  // in tests/cli-ready.test.ts (no real loopback/home).
  test("ready --help prints usage (exit 0)", () => {
    const dir = isolatedHome("ccx-ready-help-");
    try {
      const result = runCli(["ready", "--help"], { CODEXCOMMANDER_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ccx ready");
      expect(result.stdout).toContain("--wait");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("help ready shows the ready help entry", () => {
    const dir = isolatedHome("ccx-ready-help-entry-");
    try {
      const result = runCli(["help", "ready"], { CODEXCOMMANDER_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("post-sync readiness");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimOwnedServiceHome } from "./helpers/owned-service-home";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";

/**
 * Regression: `ccx start` + Ctrl-C must NOT orphan the Bun proxy.
 *
 * The bin/ccx.mjs launcher used a blocking spawnSync that did not forward signals,
 * so a signal delivered only to the launcher killed it and left the Bun child
 * serving forever (port bound, codexcommander.pid/runtime-port.json left behind, Codex config
 * not restored). The launcher now forwards SIGINT/SIGTERM/SIGHUP to the child and
 * waits for its graceful shutdown.
 *
 * POSIX-only (Windows has no real signal forwarding semantics) and requires `node`
 * on PATH to exercise the real launcher.
 */

const BIN_CCX = join(import.meta.dir, "..", "bin", "ccx.mjs");
const nodeAvailable = !spawnSync("node", ["--version"], { stdio: "ignore" }).error;
const runnable = process.platform !== "win32" && nodeAvailable;

const spawned: ChildProcess[] = [];
const tmpRuns: Array<{ home: string; port: number }> = [];
const CHILD_OUTPUT_LIMIT = 16 * 1024;

function appendBounded(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  return next.length <= CHILD_OUTPUT_LIMIT ? next : next.slice(-CHILD_OUTPUT_LIMIT);
}

function claimTempHome(home: string): { homeDir: string; userProfile: string; serviceManagerEnv: Record<string, string> } {
  const homeDir = join(home, "user-home");
  const userProfile = join(home, "user-profile");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(userProfile, { recursive: true });
  return { homeDir, userProfile, serviceManagerEnv: claimOwnedServiceHome(home, home, homeDir).env };
}

afterAll(async () => {
  for (const c of spawned) {
    try { c.kill("SIGTERM"); } catch { /* already gone */ }
  }
  for (const run of tmpRuns) {
    await stopOwnedRuntime(run.home, run.port);
  }
  for (const c of spawned) {
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const run of tmpRuns) {
    try { rmSync(run.home, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function healthIdentity(port: number, expectedPid: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return false;
    const body = await res.json() as Record<string, unknown>;
    return body.service === "codexcommander"
      && body.pid === expectedPid
      && body.port === port;
  } catch {
    return false;
  }
}

async function ownedRuntimePid(home: string, expectedPort: number): Promise<number | null> {
  try {
    const runtime = JSON.parse(readFileSync(join(home, "runtime-port.json"), "utf8")) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(runtime.pid)
      || Number(runtime.pid) <= 0
      || runtime.port !== expectedPort
    ) return null;
    const pid = Number(runtime.pid);
    return await healthIdentity(expectedPort, pid) ? pid : null;
  } catch {
    return null;
  }
}

async function stopOwnedRuntime(home: string, expectedPort: number): Promise<void> {
  const pid = await ownedRuntimePid(home, expectedPort);
  if (pid === null) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const stopped = await waitUntil(async () => !(await healthIdentity(expectedPort, pid)), 5_000);
  if (stopped) return;
  // Revalidate the same service, pid, and port immediately before the destructive
  // last resort. A stale runtime file can never authorize killing a replacement.
  if (await healthIdentity(expectedPort, pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    await waitUntil(async () => !(await healthIdentity(expectedPort, pid)), 2_000);
  }
}

async function waitUntil(fn: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(250);
  }
  return false;
}

describe.skipIf(!runnable)("ccx launcher graceful shutdown", () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(
      `${signal} to the launcher tears down the Bun proxy and restores Codex config (no orphan)`,
      async () => {
        const home = mkdtempSync(join(tmpdir(), "ccx-shutdown-"));
        const port = await freePort();
        tmpRuns.push({ home, port });
        const identity = claimTempHome(home);

        // Keep this a launcher/signal test. Relying on loadConfig() defaults made
        // startup convergence scan the full provider catalog before the assertion,
        // so unrelated provider timing could consume the fixed 30s injection budget.
        writeFileSync(join(home, "config.json"), `${JSON.stringify({
          port,
          multiAgentGuidanceEnabled: true,
          hostname: "127.0.0.1",
          codexAutoStart: true,
          defaultProvider: "mock",
          providers: {
            mock: {
              adapter: "openai-chat",
              baseUrl: "http://127.0.0.1:9/v1",
              allowPrivateNetwork: true,
              liveModels: false,
              models: ["test-model"],
              defaultModel: "test-model",
            },
          },
        }, null, 2)}\n`, { mode: 0o600 });

        // Seed a native Codex config so the proxy actually injects on start (injectCodexConfig
        // no-ops when no config.toml exists) — this lets us prove the config is RESTORED.
        const codexConfig = join(home, "config.toml");
        writeFileSync(codexConfig, 'model = "gpt-5.1"\n');
        const codexRuntime = createCodexRuntimeFixture(home);

        const child = spawn("node", [BIN_CCX, "start", "--port", String(port)], {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: identity.homeDir,
            USERPROFILE: identity.userProfile,
            CODEXCOMMANDER_HOME: home,
            CODEX_HOME: home,
            ...identity.serviceManagerEnv,
            CODEX_CLI_PATH: codexRuntime,
            CCX_DISABLE_COMPANION: "1",
          },
        });
        spawned.push(child);

        let childStdout = "";
        let childStderr = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", chunk => { childStdout = appendBounded(childStdout, chunk); });
        child.stderr?.on("data", chunk => { childStderr = appendBounded(childStderr, chunk); });

        let exited = false;
        child.on("exit", () => { exited = true; });

        try {
          // 1. Proxy comes up + injected the Codex config (Design B root override on loopback).
          // Cold launcher/runtime imports can exceed 20s under endpoint scanning even
          // though the listener and managed-config publication still converge normally.
          const up = await waitUntil(() => healthy(port), 45_000);
          expect(up).toBe(true);
          expect(existsSync(join(home, "codexcommander.pid"))).toBe(true);
          const injectedReady = await waitUntil(async () => {
            try { return readFileSync(codexConfig, "utf8").includes("# Auto-injected by CodexCommander"); }
            catch { return false; }
          }, 30_000);
          expect(
            injectedReady,
            `launcher stdout tail=${childStdout}\nlauncher stderr tail=${childStderr}`,
          ).toBe(true);
          const injected = readFileSync(codexConfig, "utf8");
          expect(injected).toContain("# Auto-injected by CodexCommander");
          expect(injected).toContain(`openai_base_url = "http://127.0.0.1:${port}/v1"`);
          expect(injected).not.toContain("model_providers.codexcommander");

          // 2. Signal ONLY the launcher PID (the exact orphan trigger).
          child.kill(signal);

          // 3. Launcher exits...
          const launcherGone = await waitUntil(async () => exited, 15_000);
          expect(launcherGone).toBe(true);

          // 4. ...and the Bun proxy is gone (port freed) — the regression guard.
          const portFreed = await waitUntil(async () => !(await healthy(port)), 10_000);
          expect(portFreed).toBe(true);

          // 5. Graceful cleanup ran: pid + runtime-port removed, Codex config restored.
          expect(existsSync(join(home, "codexcommander.pid"))).toBe(false);
          expect(existsSync(join(home, "runtime-port.json"))).toBe(false);
          expect(readFileSync(codexConfig, "utf8")).not.toContain("CodexCommander");
        } finally {
          // A failed precondition used to SIGKILL only the Node launcher in afterAll,
          // orphaning its Bun proxy. Ask the launcher to forward a graceful signal
          // while it is still alive; retain SIGKILL only as the bounded last resort.
          if (!exited) {
            child.kill("SIGTERM");
            await waitUntil(async () => exited, 5_000);
          }
          await stopOwnedRuntime(home, port);
          if (!exited) child.kill("SIGKILL");
        }
      },
      90_000,
    );
  }
});

import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimAbsentLinuxServiceBus } from "./helpers/owned-service-home";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

async function unusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function helper(
  action: "status" | "ensure" | "stop",
  env: NodeJS.ProcessEnv,
  timeoutMs = 45_000,
) {
  const child = Bun.spawn([process.execPath, cliPath, "__macos-lifecycle", action], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

describe("proxy lifecycle concurrency", () => {
  test("concurrent ensure helpers converge on one live PID and port", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccx-lifecycle-concurrency-"));
    const home = join(root, "home");
    const configHome = join(root, "codexcommander");
    const codexHome = join(root, "codex");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(configHome, { recursive: true, mode: 0o700 });
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    // Keep this a lifecycle test, not a full native-catalog generation benchmark.
    // An explicitly external provider makes sync a fast ownership-preserving no-op.
    writeFileSync(join(codexHome, "config.toml"), `model_provider = "external"

[model_providers.external]
name = "External"
base_url = "https://example.test/v1"
wire_api = "responses"
`, { mode: 0o600 });
    const port = await unusedPort();
    writeFileSync(join(configHome, "config.json"), `${JSON.stringify({
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
          models: ["test-model"],
          defaultModel: "test-model",
        },
      },
    }, null, 2)}\n`, { mode: 0o600 });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEXCOMMANDER_HOME: configHome,
      CODEX_HOME: codexHome,
      CCX_DISABLE_COMPANION: "1",
      NO_COLOR: "1",
      ...claimAbsentLinuxServiceBus(home).env,
    };
    let livePid: number | null = null;
    try {
      const results = await Promise.all(
        // Full CLI processes intentionally exercise Bun module startup as well as both
        // lock layers. Eight is enough to force overlap without turning slower macOS CI
        // runners into a compiler/memory-pressure benchmark.
        Array.from({ length: 8 }, () => helper("ensure", env, 60_000)),
      );
      for (const result of results) {
        expect(result.exitCode, `stderr=${result.stderr} stdout=${result.stdout}`).toBe(0);
      }
      const payloads = results.map(result => JSON.parse(result.stdout) as {
        ok: boolean;
        state: string;
        pid: number | null;
        port: number | null;
      });
      expect(payloads.every(payload => payload.ok && payload.state === "running")).toBe(true);
      const pids = new Set(payloads.map(payload => payload.pid));
      const ports = new Set(payloads.map(payload => payload.port));
      expect(pids.size).toBe(1);
      expect(ports).toEqual(new Set([port]));
      livePid = payloads[0].pid;
      expect(livePid).toBeGreaterThan(0);

      const pidFile = Number(readFileSync(join(configHome, "codexcommander.pid"), "utf8").trim());
      const runtime = JSON.parse(readFileSync(join(configHome, "runtime-port.json"), "utf8")) as {
        pid: number;
        port: number;
      };
      expect(pidFile).toBe(livePid);
      expect(runtime).toEqual(expect.objectContaining({ pid: livePid, port }));

      const statuses = await Promise.all(Array.from({ length: 5 }, () => helper("status", env)));
      expect(statuses.every(result => result.exitCode === 0)).toBe(true);
      expect(new Set(statuses.map(result => JSON.parse(result.stdout).pid))).toEqual(new Set([livePid]));
    } finally {
      const stopped = await helper("stop", env).catch(() => null);
      if ((!stopped || stopped.exitCode !== 0) && livePid && livePid > 0) {
        try { process.kill(livePid, "SIGTERM"); } catch { /* test-owned process already exited */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * Workstation-safe composed acceptance for the native-integration toggles.
 *
 * These tests deliberately execute `src/cli/index.ts` in child Bun processes
 * and use a real server.  Calling a route handler or an injector in this
 * process would miss exactly the configuration, runtime-record, and lock
 * boundaries this suite is intended to cover.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  canonicalizeCodexHome,
} from "../src/codex/codex-write-lock";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { claimOwnedServiceHome } from "./helpers/owned-service-home";

const repoRoot = resolve(import.meta.dir, "..");
const cliPath = resolve(repoRoot, "src/cli/index.ts");
const lockChildPath = resolve(repoRoot, "tests/helpers/codex-write-lock-child.ts");
const roots: Fixture[] = [];

type CliResult = { exitCode: number; stdout: string; stderr: string };
type RuntimeRecord = { pid: number; port: number; hostname?: string };
type StartedServer = { process: ReturnType<typeof Bun.spawn>; runtime: RuntimeRecord };

/** A byte manifest: paths plus bytes, not mtimes or parsed JSON. */
function manifest(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const key = relative(root, path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) entries[key] = readFileSync(path).toString("base64");
      else entries[key] = `non-file:${stat.mode}`;
    }
  };
  walk(root);
  return entries;
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    // The record/marker above, rather than elapsed time, is the readiness
    // condition. This only yields while watching that explicit sentinel.
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

class Fixture {
  readonly root = mkdtempSync(join(tmpdir(), "ccx-composed-"));
  readonly codex = join(this.root, "codex");
  readonly ccx = join(this.root, "ccx");
  readonly homeA = join(this.root, "home-a");
  readonly homeB = join(this.root, "home-b");
  readonly userprofileA = join(this.root, "userprofile-a");
  readonly userprofileB = join(this.root, "userprofile-b");
  readonly runtime = join(this.root, "runtime");
  readonly provider = join(this.root, "fixture");
  readonly dataToken = "composed-data-token";
  readonly managementToken = "composed-admin-token";
  readonly lockPath: string;
  readonly lockAllowlist: string[];
  readonly serviceManagerEnv: Record<string, string>;
  readonly children: Array<ReturnType<typeof Bun.spawn>> = [];

  constructor() {
    for (const path of [this.codex, this.ccx, this.homeA, this.homeB, this.userprofileA, this.userprofileB, this.runtime, this.provider]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    this.lockPath = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), realpathSync.native(this.codex));
    this.lockAllowlist = [this.lockPath, `${this.lockPath}-journal`, `${this.lockPath}-wal`, `${this.lockPath}-shm`];
    for (const path of this.lockAllowlist) {
      if (existsSync(path)) throw new Error(`lock preflight found pre-existing case path: ${path}`);
    }
    writeFileSync(join(this.codex, "config.toml"), 'model = "gpt-5"\n');
    this.serviceManagerEnv = claimOwnedServiceHome(this.codex, this.ccx, this.homeA).env;
  }

  env(home = this.homeA, userprofile = this.userprofileA): Record<string, string> {
    // Do not inherit ambient homes or proxy configuration.  `process.execPath`
    // is absolute, so a PATH is intentionally unnecessary for CLI children.
    return {
      HOME: home,
      USERPROFILE: userprofile,
      CODEX_HOME: this.codex,
      CODEXCOMMANDER_HOME: this.ccx,
      XDG_RUNTIME_DIR: this.runtime,
      CODEXCOMMANDER_API_AUTH_TOKEN: this.dataToken,
      // `/api/*` is the management plane, distinct from the data-plane token.
      // A fixed fixture value avoids reading the generated credential file.
      CODEXCOMMANDER_ADMIN_AUTH_TOKEN: this.managementToken,
      NO_PROXY: "127.0.0.1,localhost",
      ...this.serviceManagerEnv,
    };
  }

  writeConfig(overrides: Record<string, unknown> = {}): void {
    writeFileSync(join(this.ccx, "config.json"), JSON.stringify({
      port: 0,
      multiAgentGuidanceEnabled: true,
      hostname: "127.0.0.1",
      claudeCode: { systemEnv: false },
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "fixture-key",
          allowPrivateNetwork: true,
          liveModels: false,
          models: ["fixture-model"],
        },
      },
      defaultProvider: "fixture",
      ...overrides,
    }, null, 2));
  }

  spawnCli(
    argv: string[],
    home = this.homeA,
    userprofile = this.userprofileA,
    envOverrides: Record<string, string> = {},
  ) {
    const child = Bun.spawn([process.execPath, cliPath, ...argv], {
      cwd: this.root,
      env: { ...this.env(home, userprofile), ...envOverrides },
      stdout: "pipe",
      stderr: "pipe",
    });
    this.children.push(child);
    return child;
  }

  async runCli(argv: string[], home = this.homeA, userprofile = this.userprofileA, timeoutMs = 15_000): Promise<CliResult> {
    const child = this.spawnCli(argv, home, userprofile);
    const completed = await Promise.race([
      Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`CLI watchdog: ccx ${argv.join(" ")}`)), timeoutMs)),
    ]);
    const [stdout, stderr, exitCode] = completed;
    return { exitCode, stdout, stderr };
  }

  async initializeCoordinator(): Promise<void> {
    const child = Bun.spawn([process.execPath, "--eval", [
      'const { readCodexTransitionState } = await import("./src/codex/transition-state.ts");',
      'console.log(JSON.stringify(readCodexTransitionState()));',
    ].join("\n")], {
      cwd: repoRoot,
      env: this.env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    this.children.push(child);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(stdout.trim())).toMatchObject({
      kind: "ready",
      state: { nativeGeneration: 0, currentTxId: null },
    });
  }

  async start(envOverrides: Record<string, string> = {}): Promise<StartedServer> {
    const child = this.spawnCli(["start"], this.homeA, this.userprofileA, envOverrides);
    const runtimePath = join(this.ccx, "runtime-port.json");
    const runtime = await waitFor(() => {
      if (!existsSync(runtimePath)) return null;
      try {
        const record = JSON.parse(readFileSync(runtimePath, "utf8")) as RuntimeRecord;
        return Number.isInteger(record.pid) && record.pid === child.pid && Number.isInteger(record.port) && record.port > 0
          ? record
          : null;
      } catch {
        return null;
      }
    }, "runtime-port record");
    const health = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/healthz`, { signal: AbortSignal.timeout(500) });
        const body = await response.json() as { pid?: unknown; port?: unknown };
        return response.ok && body.pid === child.pid && body.port === runtime.port ? body : null;
      } catch {
        return null;
      }
    }, "child /healthz");
    expect(health).toMatchObject({ pid: child.pid, port: runtime.port });
    return { process: child, runtime };
  }

  async stop(server: StartedServer): Promise<void> {
    if (server.process.exitCode === null) server.process.kill("SIGTERM");
    const exitCode = await Promise.race([
      server.process.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("server shutdown watchdog")), 10_000)),
    ]);
    expect(exitCode).toBe(0);
  }

  async request(runtime: RuntimeRecord, path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
      ...init,
      headers: {
        "x-codexcommander-api-key": this.managementToken,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  async cleanup(): Promise<void> {
    for (const child of this.children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    for (const child of this.children) {
      if (child.exitCode === null) await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`child ${child.pid} did not exit`)), 10_000)),
      ]);
    }
    // Re-resolve before the limited four-name removal: never glob or inspect a
    // shared runtime namespace beyond the exact identities this case created.
    const checked = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), realpathSync.native(this.codex));
    if (checked !== this.lockPath) throw new Error("lock teardown identity changed");
    for (const path of this.lockAllowlist) {
      if (existsSync(path)) unlinkSync(path);
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}

function fixture(): Fixture {
  const value = new Fixture();
  roots.push(value);
  return value;
}

afterEach(async () => {
  while (roots.length) await roots.pop()!.cleanup();
});

describe("WP13 composed toggle acceptance", () => {
  /** RED: remove `shouldSyncCodexOnStart` or the under-lock desired-state read; an OFF row writes native bytes. */
  test("A-reduced: real CLI and HTTP entry points preserve an OFF Codex home", async () => {
    const fx = fixture();
    fx.writeConfig({ clientIntegrations: { codex: false, grok: false, "claude-desktop": false } });
    mkdirSync(join(fx.homeA, ".grok"));
    writeFileSync(join(fx.homeA, ".grok", "config.toml"), "# user config\n");
    const before = manifest(fx.codex);
    const server = await fx.start({ CCX_SERVICE: "1" });
    try {
      expect(manifest(fx.codex)).toEqual(before);
      for (const argv of [["ensure"], ["sync"], ["restore"], ["sync-cache"]]) {
        const result = await fx.runCli(argv);
        expect(result.exitCode).toBe(0);
        expect(manifest(fx.codex)).toEqual(before);
      }
      const sync = await fx.request(server.runtime, "/api/sync", { method: "POST" });
      expect(sync.status).toBe(200);
      expect(sync.body).toMatchObject({ status: "skipped", skippedReason: "desired_disabled", ok: true });
      for (const clientId of ["codex", "grok", "claude-desktop"] as const) {
        const toggle = await fx.request(server.runtime, `/api/native-integrations/${clientId}`, {
          method: "PUT", body: JSON.stringify({ enabled: false }),
        });
        expect([200, 404]).toContain(toggle.status);
        expect(toggle.body).toHaveProperty("desiredEnabled", false);
      }
      expect(manifest(fx.codex)).toEqual(before);
      // P08 is intentionally the ON control: it must reach the same running
      // server through the real CLI without passing a port flag.
      const back = await fx.runCli(["restore", "back"]);
      // The fixture records itself as the active service install, so the
      // production ownership preflight admits this home and P08 completes the
      // enable transition through the real CLI.
      expect(back.exitCode).toBe(0);
      expect((await fx.request(server.runtime, "/api/native-integrations/codex", {
        method: "PUT", body: JSON.stringify({ enabled: false }),
      })).body).toMatchObject({ desiredEnabled: false });
    } finally {
      await fx.stop(server);
    }
  }, 45_000);

  /** RED: release E/S around provider gather; a later OFF can interleave with the in-flight sync. */
  test("B-reduced: a held sync linearizes before a later OFF, which restores native last", async () => {
    const fx = fixture();
    let hold = false;
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>(resolveRelease => { release = resolveRelease; });
    const enteredGather = new Promise<void>(resolveEntered => { entered = resolveEntered; });
    const provider = Bun.serve({
      port: 0,
      fetch: async request => {
        if (new URL(request.url).pathname.endsWith("/models")) {
          if (hold) {
            entered();
            await released;
          }
          return Response.json({ data: [{ id: "held-model" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      // Startup uses the fixture's static model list and therefore cannot become
      // the held live-provider flight. Keep desired state ON throughout; the raw
      // route swaps in live discovery only after startup is healthy.
      fx.writeConfig({ clientIntegrations: { codex: true } });
      const server = await fx.start();
      try {
        // /healthz proves only that the listener bound. Wait until startup has
        // settled and released its lifecycle authority before arming the held
        // provider, or this test can mistake startup discovery for /api/sync.
        await waitFor(async () => {
          const ready = await fx.request(server.runtime, "/readyz");
          return ready.body.status === "ready" || ready.body.status === "failed"
            ? ready.body
            : null;
        }, "terminal startup readiness");
        writeFileSync(join(fx.codex, "codexcommander-catalog.json"), JSON.stringify({ models: [] }));
        fx.writeConfig({ providers: { fixture: {
          adapter: "openai-chat", baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-key",
          allowPrivateNetwork: true, liveModels: true,
        } }, defaultProvider: "fixture", clientIntegrations: { codex: true } });
        hold = true;
        const stale = fx.request(server.runtime, "/api/sync", { method: "POST" });
        await Promise.race([
          enteredGather,
          stale.then(result => Promise.reject(new Error(
            `held /api/sync completed before provider discovery: ${result.status} ${JSON.stringify(result.body)}`,
          ))),
        ]);
        let offSettled = false;
        const off = fx.request(server.runtime, "/api/native-integrations/codex", {
          method: "PUT", body: JSON.stringify({ enabled: false }),
        }).then(result => {
          offSettled = true;
          return result;
        });
        // Sync already owns E -> S, so OFF must not persist or restore anything
        // until the gather + commit transaction releases both leases.
        await Bun.sleep(100);
        expect(offSettled).toBe(false);
        expect(JSON.parse(readFileSync(join(fx.ccx, "config.json"), "utf8")))
          .toMatchObject({ clientIntegrations: { codex: true } });
        release();
        const syncResult = await stale;
        expect(syncResult.status).toBe(200);
        expect(syncResult.body).toMatchObject({ status: "applied", ok: true });
        const offResult = await off;
        expect(offResult.status).toBe(200);
        expect(offResult.body).toMatchObject({ desiredEnabled: false, state: "absent" });
        const finalNative = manifest(fx.codex);
        expect(JSON.parse(readFileSync(join(fx.ccx, "config.json"), "utf8")))
          .toMatchObject({ clientIntegrations: { codex: false } });
        await Bun.sleep(100);
        expect(manifest(fx.codex)).toEqual(finalNative);
      } finally {
        release();
        await fx.stop(server);
      }
    } finally {
      provider.stop(true);
    }
  }, 45_000);

  /** RED: omit `admitCodexWrite` ownership refusal; start/ensure/P19 create a coordinator or native artifact. */
  test("D-reduced: foreign service-home evidence refuses real CLI and HTTP writers before artifacts", async () => {
    const fx = fixture();
    fx.writeConfig();
    writeFileSync(join(fx.ccx, "service-state.json"), JSON.stringify({
      version: 3,
      codexHome: join(fx.root, "foreign-codex"),
      codexCommanderHome: join(fx.root, "foreign-ccx"),
      bunPath: process.execPath,
      cliPath,
      backend: "scheduler",
    }));
    const before = manifest(fx.codex);
    const server = await fx.start();
    try {
      const ensure = await fx.runCli(["ensure"]);
      expect(ensure.exitCode).toBe(1);
      expect(`${ensure.stdout}\n${ensure.stderr}`).toMatch(/catalog|service|ownership|synchron/i);
      const sync = await fx.request(server.runtime, "/api/sync", { method: "POST" });
      expect(sync.status).toBe(409);
      expect(String(sync.body.message ?? sync.body.error)).toMatch(/Refusing|service|ownership/i);
      const restore = await fx.runCli(["restore"]);
      expect(restore.exitCode).toBe(1);
      expect(manifest(fx.codex)).toEqual(before);
      expect(fx.lockAllowlist.some(existsSync)).toBe(false);
    } finally {
      // The foreground signal path deliberately refuses to tear down while
      // foreign service-home evidence blocks its durable native restore. Drop
      // this test's synthetic evidence before asking the fixture to stop.
      unlinkSync(join(fx.ccx, "service-state.json"));
      await fx.stop(server);
    }
  }, 45_000);

  /** RED: key N by HOME/USERPROFILE instead of effective uid plus canonical CODEX_HOME; both children acquire. */
  test("E: separate fake homes share the effective-user Codex lock", async () => {
    const fx = fixture();
    fx.writeConfig();
    // The current lock result exposes `busy` but not the lock id.  The parent
    // derives the one production id and checks both children use its database;
    // a typed busy result is still required from the contender.
    const held = join(fx.root, "held");
    const release = join(fx.root, "release");
    const holder = Bun.spawn([process.execPath, lockChildPath], {
      cwd: repoRoot,
      env: { ...fx.env(fx.homeA, fx.userprofileA), CCX_LOCK_CHILD_PAYLOAD: JSON.stringify({ timeoutMs: 5_000, holdMarker: held, releaseMarker: release }) },
      stdout: "pipe", stderr: "pipe",
    });
    fx.children.push(holder);
    await waitFor(() => existsSync(held) ? true : null, "held coordinator lock");
    const contender = Bun.spawn([process.execPath, lockChildPath], {
      cwd: repoRoot,
      env: { ...fx.env(fx.homeB, fx.userprofileB), CCX_LOCK_CHILD_PAYLOAD: JSON.stringify({ timeoutMs: 0 }) },
      stdout: "pipe", stderr: "pipe",
    });
    fx.children.push(contender);
    const [out, code] = await Promise.all([new Response(contender.stdout).text(), contender.exited]);
    expect(code).toBe(0);
    const identity = canonicalizeCodexHome(fx.codex);
    expect(identity.ok).toBe(true);
    expect(JSON.parse(out)).toMatchObject({
      status: "busy", reason: "deadline", lockId: identity.ok ? identity.home.lockId : "unreachable",
    });
    expect(existsSync(fx.lockPath)).toBe(true);
    expect(existsSync(join(fx.homeA, "native-write-locks"))).toBe(false);
    expect(existsSync(join(fx.homeB, "native-write-locks"))).toBe(false);
    writeFileSync(release, "release");
    expect(await holder.exited).toBe(0);
  }, 30_000);

  /** RED: delete the durable Grok intent or bypass `shouldSyncGrokOnStart`; startup recreates the fence. */
  test("Grok E2E: route-disabled Grok stays absent across a real startup", async () => {
    const fx = fixture();
    fx.writeConfig();
    const grokHome = join(fx.homeA, ".grok");
    mkdirSync(grokHome);
    writeFileSync(join(grokHome, "config.toml"), "# user grok config\n");
    const first = await fx.start();
    try {
      const disabled = await fx.request(first.runtime, "/api/native-integrations/grok", {
        method: "PUT", body: JSON.stringify({ enabled: false }),
      });
      expect(disabled.status).toBe(200);
      expect(disabled.body).toMatchObject({ desiredEnabled: false, state: "absent" });
    } finally {
      await fx.stop(first);
    }
    const second = await fx.start();
    const secondOutput = new Response(second.process.stdout).text();
    try {
      expect(readFileSync(join(grokHome, "config.toml"), "utf8")).not.toContain("codexcommander managed block");
    } finally {
      await fx.stop(second);
    }
    expect(await secondOutput).not.toContain("Grok Build config updated");
  }, 45_000);

});

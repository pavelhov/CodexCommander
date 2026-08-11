import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveCodexCatalogSerializationDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { catalogBackupPathFor } from "../src/codex/catalog/parsing";
import { createCodexRuntimeFixture } from "./helpers/codex-runtime-fixture";
import { claimOwnedServiceHome } from "./helpers/owned-service-home";

const repoRoot = resolve(import.meta.dir, "..");
const sandboxes: Sandbox[] = [];
const spawnedChildren = new Set<Bun.Subprocess>();
const CHILD_TERMINATION_GRACE_MS = 500;

function trackChild<T extends Bun.Subprocess>(child: T): T {
  spawnedChildren.add(child);
  void child.exited.then(
    () => { spawnedChildren.delete(child); },
    () => { spawnedChildren.delete(child); },
  );
  return child;
}

async function terminateRemainingChildren(): Promise<void> {
  const remaining = [...spawnedChildren];
  await Promise.all(remaining.map(async child => {
    if (child.exitCode === null) {
      try { child.kill("SIGTERM"); } catch { /* child exited between checks */ }
      const exitedAfterTerm = await Promise.race([
        child.exited.then(() => true, () => true),
        Bun.sleep(CHILD_TERMINATION_GRACE_MS).then(() => false),
      ]);
      if (!exitedAfterTerm && child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* child exited between checks */ }
      }
    }
    try { await child.exited; } catch { /* cleanup must still remove the sandbox */ }
    spawnedChildren.delete(child);
  }));
}

interface Sandbox {
  readonly root: string;
  readonly codexHome: string;
  readonly codexCommanderHome: string;
  readonly env: Record<string, string>;
}

function nativeEntry(slug: string, visibility = "list"): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "native",
    priority: 9,
    visibility,
    supported_in_api: true,
    shell_type: "shell_command",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
  };
}

function catalogBytes(visibility = "list", routed = false): string {
  return `${JSON.stringify({
    retained_marker: visibility,
    models: [
      nativeEntry("gpt-5.5", visibility),
      ...(routed ? [{
        ...nativeEntry("vendor/old-model"),
        description: "Routed via codexcommander → vendor.",
      }] : []),
    ],
  }, null, 2)}\n`;
}

function makeSandbox(prefix: string): Sandbox {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const codexHome = join(root, "codex-home");
  const codexCommanderHome = join(root, "codexcommander-home");
  const home = join(root, "user-home");
  const runtime = join(root, "runtime");
  for (const path of [codexHome, codexCommanderHome, home, runtime]) {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o700);
  }
  const serviceManagerEnv = claimOwnedServiceHome(codexHome, codexCommanderHome, home).env;
  const sandbox = {
    root,
    codexHome,
    codexCommanderHome,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      CODEX_HOME: codexHome,
      CODEX_CLI_PATH: createCodexRuntimeFixture(runtime),
      CODEXCOMMANDER_HOME: codexCommanderHome,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: runtime,
      TEMP: runtime,
      TMP: runtime,
      XDG_RUNTIME_DIR: runtime,
      LOCALAPPDATA: join(home, "LocalAppData"),
      ...serviceManagerEnv,
    },
  };
  sandboxes.push(sandbox);
  return sandbox;
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

async function runChild(
  sandbox: Sandbox,
  script: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = trackChild(Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot,
    env: sandbox.env,
    stdout: "pipe",
    stderr: "pipe",
  }));
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function holdCatalogLock(sandbox: Sandbox): Promise<{
  release(): void;
  child: ReturnType<typeof Bun.spawn>;
}> {
  const ready = join(sandbox.root, "lock-ready");
  const release = join(sandbox.root, "lock-release");
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withCatalogWriteSerialization } from "./src/codex/catalog-write-serialization.ts";
    const home = process.env.CODEX_HOME;
    const outcome = withCatalogWriteSerialization(home, () => {
      writeFileSync(${JSON.stringify(ready)}, "ready");
      const waiter = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(${JSON.stringify(release)})) Atomics.wait(waiter, 0, 0, 10);
    });
    if (outcome.kind !== "completed") throw new Error(JSON.stringify(outcome));
  `;
  const child = trackChild(Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot,
    env: sandbox.env,
    stdout: "pipe",
    stderr: "pipe",
  }));
  await waitForPath(ready);
  return { release: () => writeFileSync(release, "release"), child };
}

function seedCatalog(sandbox: Sandbox, bytes = catalogBytes()): string {
  const path = join(sandbox.codexHome, "catalog.json");
  writeFileSync(join(sandbox.codexHome, "config.toml"), [
    "# Auto-injected by CodexCommander",
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    'model_catalog_json = "catalog.json"',
    "",
  ].join("\n"));
  writeFileSync(path, bytes);
  return path;
}

afterEach(async () => {
  await terminateRemainingChildren();
  const identity = resolveEffectiveUserIdentity();
  for (const sandbox of sandboxes.splice(0)) {
    const database = resolveCodexCatalogSerializationDatabasePath(identity, sandbox.codexHome);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("server listen preserves a foreign/native-owned models cache before canonical startup sync", async () => {
  const sandbox = makeSandbox("ccx-retained-cache-");
  seedCatalog(sandbox);
  const cachePath = join(sandbox.codexHome, "models_cache.json");
  // This is a valid external Codex configuration, not a CodexCommander-owned
  // routing surface. The old startServer-side invalidator ignored that
  // ownership and rebuilt models_cache from catalog.json before the canonical
  // startup sync had a chance to preserve the external route.
  writeFileSync(join(sandbox.codexHome, "config.toml"), [
    'model_provider = "external"',
    'model_catalog_json = "catalog.json"',
    "",
    "[model_providers.external]",
    'base_url = "https://external.example.test/v1"',
    "",
  ].join("\n"));
  const nativeCache = '{"native_owned":true,"models":[{"slug":"native-only"}]}\n';
  writeFileSync(cachePath, nativeCache);
  const sentinel = new Date("2001-02-03T04:05:06.000Z");
  utimesSync(cachePath, sentinel, sentinel);
  const beforeMtime = lstatSync(cachePath, { bigint: true }).mtimeNs;

  const startupProbe = await runChild(sandbox, `
    const sentinel = new Error("TEST_LISTENER_INTERCEPTED");
    Bun.serve = () => { throw sentinel; };
    const { startServer } = await import("./src/server/index.ts");
    try {
      startServer(0);
      throw new Error("startServer unexpectedly reached a listener");
    } catch (error) {
      if (error !== sentinel) throw error;
    }
  `);
  expect(startupProbe.exitCode).toBe(0);
  expect(readFileSync(cachePath, "utf8")).toBe(nativeCache);
  expect(lstatSync(cachePath, { bigint: true }).mtimeNs).toBe(beforeMtime);
});

test("server listen preserves an unchanged managed cache mtime and only explicit sync-cache takes K", async () => {
  const sandbox = makeSandbox("ccx-retained-cache-noop-");
  const catalogPath = seedCatalog(sandbox);
  const models = (JSON.parse(readFileSync(catalogPath, "utf8")) as { models: unknown[] }).models;
  const cachePath = join(sandbox.codexHome, "models_cache.json");
  const cacheBytes = `${JSON.stringify({
    fetched_at: "2000-01-01T00:00:00Z",
    client_version: "0.0.0",
    models,
  }, null, 2)}\n`;
  writeFileSync(cachePath, cacheBytes);
  const sentinel = new Date("2001-02-03T04:05:06.000Z");
  utimesSync(cachePath, sentinel, sentinel);
  const beforeMtime = lstatSync(cachePath, { bigint: true }).mtimeNs;

  const startupProbe = await runChild(sandbox, `
    const sentinel = new Error("TEST_LISTENER_INTERCEPTED");
    Bun.serve = () => { throw sentinel; };
    const { startServer } = await import("./src/server/index.ts");
    try {
      startServer(0);
      throw new Error("startServer unexpectedly reached a listener");
    } catch (error) {
      if (error !== sentinel) throw error;
    }
  `);
  expect(startupProbe.exitCode).toBe(0);
  expect(readFileSync(cachePath, "utf8")).toBe(cacheBytes);
  // Worker freshness uses artifact mtimes as its evidence boundary. Preserving
  // this mtime proves a listener-only start cannot manufacture worker staleness.
  expect(lstatSync(cachePath, { bigint: true }).mtimeNs).toBe(beforeMtime);

  const holder = await holdCatalogLock(sandbox);
  try {
    const cli = Bun.spawnSync([process.execPath, "run", "src/cli/index.ts", "sync-cache"], {
      cwd: repoRoot,
      env: sandbox.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(cli.exitCode).toBe(0);
    expect(readFileSync(cachePath, "utf8")).toBe(cacheBytes);
    expect(lstatSync(cachePath, { bigint: true }).mtimeNs).toBe(beforeMtime);
    const cliSource = readFileSync(join(repoRoot, "src/cli/index.ts"), "utf8");
    const cliStart = cliSource.indexOf('case "sync-cache"');
    const cliRoot = cliSource.slice(cliStart, cliSource.indexOf('case "gui"', cliStart));
    expect(cliRoot).toContain("withCatalogWriteSerialization(owningCodexHome");
    expect(cliRoot).toContain("invalidateCodexModelsCacheWithPermit");

    const startup = readFileSync(join(repoRoot, "src/server/index.ts"), "utf8");
    expect(startup).not.toContain("invalidateCodexModelsCacheWithPermit");
    expect(startup).not.toContain("consumeStartupCacheInvalidationWrite");
    const startupSync = cliSource.slice(
      cliSource.indexOf("const startupSync = await syncCodexOnStartIfEnabled"),
      cliSource.indexOf("// Build Desktop 3P alias registry"),
    );
    expect(startupSync).toContain("if (startupSync.catalogWritten || startupSync.cacheSynced)");
    expect(startupSync).not.toContain("consumeStartupCacheInvalidationWrite");
  } finally {
    holder.release();
    expect(await holder.child.exited).toBe(0);
  }
});

test("native restore cannot read-transform-write the catalog while another process owns K", async () => {
  const sandbox = makeSandbox("ccx-retained-restore-");
  const catalogPath = seedCatalog(sandbox, catalogBytes("list", true));
  writeFileSync(catalogBackupPathFor(catalogPath), catalogBytes("list", false));
  const before = readFileSync(catalogPath, "utf8");
  const holder = await holdCatalogLock(sandbox);
  try {
    const restored = await runChild(sandbox, `
      const { restoreNativeCodex } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodex()));
    `);
    expect(restored.exitCode).toBe(0);
    expect(readFileSync(catalogPath, "utf8")).toBe(before);
    const source = readFileSync(join(repoRoot, "src/codex/inject.ts"), "utf8");
    const restoreRoot = source.slice(source.indexOf("const owningCodexHome"), source.indexOf("// Design B", source.indexOf("const owningCodexHome")));
    expect(restoreRoot).toContain("withCatalogWriteSerialization(owningCodexHome");
    expect(restoreRoot).toContain("restoreCodexCatalogWithPermit");
  } finally {
    holder.release();
    expect(await holder.child.exited).toBe(0);
  }
});

async function runPublisher(
  sandbox: Sandbox,
  config: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runChild(sandbox, `
    const { withConfigMutationLockSync } = await import("./src/config.ts");
    const { captureCatalogAdmissionSnapshot } = await import("./src/codex/catalog-admission.ts");
    const { convergeCodexCatalog } = await import("./src/codex/convergence.ts");
    const config = ${JSON.stringify(config)};
    withConfigMutationLockSync(() => undefined);
    const snapshot = captureCatalogAdmissionSnapshot(config);
    const result = await convergeCodexCatalog(snapshot, {
      action: "converge", scope: "catalog", reason: "api-sync", mode: "explicit", deadlineMs: 2000,
    });
    console.log(JSON.stringify(result));
  `);
}

test("catalog convergence gathered first and acquired K second does not clobber a newer converged catalog", async () => {
    const sandbox = makeSandbox("ccx-retained-race-convergence-");
    const catalogPath = seedCatalog(sandbox);
    const initial = readFileSync(catalogPath, "utf8");
    const requested = join(sandbox.root, "provider-requested");
    const release = join(sandbox.root, "provider-release");
    let requests = 0;
    const provider = Bun.serve({
      port: 0,
      fetch: async request => {
        if (!new URL(request.url).pathname.endsWith("/models")) return new Response("not found", { status: 404 });
        if (requests++ === 0) {
          writeFileSync(requested, "requested");
          while (!existsSync(release)) await Bun.sleep(5);
        }
        return Response.json({ data: [{ id: "race-model" }] });
      },
    });
    const config = {
      port: 0,
      multiAgentGuidanceEnabled: true,
      hostname: "127.0.0.1",
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          apiKey: "fixture-key",
          allowPrivateNetwork: true,
          liveModels: true,
        },
      },
      disabledModels: ["gpt-5.5"],
    };
    writeFileSync(join(sandbox.codexCommanderHome, "config.json"), JSON.stringify(config));
    try {
      const sync = trackChild(Bun.spawn([process.execPath, "--eval", `
        const config = ${JSON.stringify(config)};
        const { withConfigMutationLockSync } = await import("./src/config.ts");
        const { captureCatalogAdmissionSnapshot } = await import("./src/codex/catalog-admission.ts");
        const { convergeCodexCatalog } = await import("./src/codex/convergence.ts");
        withConfigMutationLockSync(() => undefined);
        const result = await convergeCodexCatalog(captureCatalogAdmissionSnapshot(config), {
          action: "converge", scope: "catalog", reason: "api-sync", mode: "explicit", deadlineMs: 2000,
        });
        console.log(JSON.stringify(result));
      `], { cwd: repoRoot, env: sandbox.env, stdout: "pipe", stderr: "pipe" }));
      const stdoutText = new Response(sync.stdout).text();
      const stderrText = new Response(sync.stderr).text();

      await Promise.race([
        waitForPath(requested),
        sync.exited.then(async exitCode => {
          const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);
          throw new Error(`sync exited before provider barrier (${exitCode})\nstdout=${stdout}\nstderr=${stderr}`);
        }),
      ]);
      const published = await runPublisher(sandbox, config);
      if (published.exitCode !== 0) {
        throw new Error(`convergence publisher failed\nstdout=${published.stdout}\nstderr=${published.stderr}`);
      }
      const newer = readFileSync(catalogPath, "utf8");
      expect(newer).not.toBe(initial);

      writeFileSync(release, "release");
      const [exitCode, stdout, stderr] = await Promise.all([
        sync.exited,
        stdoutText,
        stderrText,
      ]);
      expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
      expect(readFileSync(catalogPath, "utf8")).toBe(newer);
    } finally {
      provider.stop(true);
    }
}, 20_000);

/**
 * The post-approval seam, raced by two real processes through a real route.
 *
 * Every case above drives `/api/sync`, which is a retained root. This one drives
 * `PATCH /api/providers` — one of the sixteen management mutations that used to
 * reach a catalog write through `refreshCodexCatalogBestEffort`, whose entire
 * error policy was `catch {}`. The interesting window is AFTER the route has
 * already persisted its own mutation and approved the refresh: two processes
 * arriving there together must serialize, and neither may report `committed`
 * for bytes the other replaced.
 *
 * Both processes go through `handleManagementAPI`, so this exercises the bound
 * factory, the total adapter, and K in the shape production actually uses.
 *
 * The edit itself is a `note` update: a recognized field that persists a real
 * config mutation without changing routing, so what is under test is the refresh
 * that follows approval rather than the edit.
 */
test("two processes at the post-approval management seam serialize instead of interleaving", async () => {
  const sandbox = makeSandbox("ccx-post-approval-race-");
  const catalogPath = seedCatalog(sandbox);
  const seeded = readFileSync(catalogPath, "utf8");
  const barrier = join(sandbox.root, "seam-barrier");

  // Warm the config ownership + mutation database in a single process first.
  // Two cold processes otherwise race to create `.codexcommander-owner.json` and both
  // die with EEXIST before approval, which would make this test vacuous.
  const warm = trackChild(Bun.spawn([process.execPath, "--eval", `
    const { withConfigMutationLockSync } = await import("./src/config.ts");
    withConfigMutationLockSync(() => undefined);
  `], { cwd: repoRoot, env: sandbox.env, stdout: "pipe", stderr: "pipe" }));
  expect(await warm.exited).toBe(0);

  const routeScript = (marker: string) => `
    import { existsSync, writeFileSync } from "node:fs";
    // The stub lives on globalThis, NOT on the provider row. Catalog admission
    // encodes the config to derive its identity and refuses a function member, so
    // a per-provider \`fetch\` makes the seam throw before it can converge — which
    // looked exactly like a production defect until the encoder said so.
    globalThis.fetch = async () => {
      writeFileSync(${JSON.stringify(barrier)} + "-" + ${JSON.stringify(marker)}, "here");
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (existsSync(${JSON.stringify(barrier)} + "-a") && existsSync(${JSON.stringify(barrier)} + "-b")) break;
        await Bun.sleep(5);
      }
      return Response.json({ data: [{ id: "seam-model-" + ${JSON.stringify(marker)} }] });
    };
    const config = {
      port: 10100,
      multiAgentGuidanceEnabled: true,
      defaultProvider: "together",
      providers: {
        together: {
          adapter: "openai-chat",
          baseUrl: "https://api.together.xyz/v1",
          apiKey: "seam-key",
          models: ["fallback-model"],
        },
      },
    };
    const { handleManagementAPI } = await import("./src/server/management-api.ts");
    const url = new URL("http://localhost/api/providers?name=together");
    const req = new Request(url, {
      method: "PATCH",
      headers: { Host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ note: "seam-" + ${JSON.stringify(marker)} }),
    });
    const response = await handleManagementAPI(req, url, config);
    const body = await response.json();
    console.log(JSON.stringify({ status: response.status, catalogRefresh: body.catalogRefresh }));
  `;

  const children = (["a", "b"] as const).map(marker => trackChild(Bun.spawn(
    [process.execPath, "--eval", routeScript(marker)],
    { cwd: repoRoot, env: sandbox.env, stdout: "pipe", stderr: "pipe" },
  )));

  const results = await Promise.all(children.map(async child => {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }));

  for (const result of results) {
    // A process can lose a race BEFORE approval and never reach the seam at all.
    // Both known cases come from `saveConfigPreservingClaudeCode`: the config
    // mutation lock is already held, or two cold processes create the ownership
    // file at once. Neither says anything about catalog convergence, so they are
    // excluded here — but only these two, so a genuine seam failure still fails.
    if (result.exitCode !== 0) {
      const preApproval = result.stderr.includes("CONFIG_MUTATION_LOCK_UNAVAILABLE")
        || (result.stderr.includes("EEXIST") && result.stderr.includes("createOwnership"));
      expect({ preApproval, stderr: result.stderr }).toMatchObject({ preApproval: true });
      continue;
    }
    const parsed = JSON.parse(result.stdout.trim()) as {
      status: number;
      catalogRefresh: { status: string };
    };
    // The route persisted its mutation, so it must answer 2xx no matter what the
    // catalog attempt decided. A throw here would be the old `catch {}` failure
    // inverted: a persisted change reported as a 500.
    expect(parsed.status).toBeGreaterThanOrEqual(200);
    expect(parsed.status).toBeLessThan(300);
    // Whatever happened, it is REPORTED — never swallowed into silence.
    expect(["committed", "skipped", "failed"]).toContain(parsed.catalogRefresh.status);
  }

  // At least one process must have gotten through to the seam, or this test would
  // be vacuous — two config-lock losers prove nothing about catalog serialization.
  expect(results.some(r => r.exitCode === 0)).toBe(true);

  // At least one process must reach a real commit, or the race proves nothing:
  // the adapter is total, so a seam that only ever failed would still answer 2xx
  // with a typed disposition and satisfy every assertion above.
  const dispositions = results
    .filter(r => r.exitCode === 0)
    .map(r => (JSON.parse(r.stdout.trim()) as { catalogRefresh: { status: string } }).catalogRefresh.status);
  expect(dispositions).toContain("committed");

  // A commit means the catalog really moved.
  expect(readFileSync(catalogPath, "utf8")).not.toBe(seeded);

  // The surviving catalog is one process's complete output, never a blend of both.
  const finalBytes = readFileSync(catalogPath, "utf8");
  const parsedCatalog = JSON.parse(finalBytes) as { models: Array<{ slug?: unknown }> };
  const slugs = parsedCatalog.models.flatMap(m => typeof m.slug === "string" ? [m.slug] : []);
  const fromA = slugs.some(s => s.includes("seam-model-a"));
  const fromB = slugs.some(s => s.includes("seam-model-b"));
  expect(fromA && fromB).toBe(false);
}, 30_000);

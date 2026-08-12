import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import { syncGrokConfig } from "../src/grok/sync";
import { injectGrokConfig, type GrokInjectModel } from "../src/grok/inject";
import type { ProxyLifecycleAuthority } from "../src/server/proxy-lifecycle-authority";
import type { CodexCommanderConfig } from "../src/types";

/**
 * Route contract for implementation contract (Rev 3).
 *
 * The toggle owns a fenced region of ~/.grok/config.toml and carries no
 * snapshot and no journal — re-enabling regenerates the fence from the current
 * catalog, which IS the undo. What these tests prove is that every reported
 * state is honest: pref light + recheck + post-inspection, never the state the
 * operation intended.
 */

const BEGIN = "# >>> CodexCommander managed block — do not edit (removed by `ccx stop`) >>>";
const END = "# <<< CodexCommander managed block <<<";

let grokHome: string;
let fixtureRoot: string;
let previousGrokHome: string | undefined;
let previousCodexCommanderHome: string | undefined;
const cleanup: string[] = [];

beforeEach(() => {
  previousGrokHome = process.env.GROK_HOME;
  grokHome = mkdtempSync(join(tmpdir(), "ccx-grok-toggle-"));
  cleanup.push(grokHome);
  process.env.GROK_HOME = grokHome;
  /*
   * `bun test` isolates CODEX_HOME to a temp dir, so the REAL service-state.json
   * (recorded under ~/.codexcommander) mismatches it and every disable would refuse
   * home_mismatch — the preflight working as designed, against the wrong
   * fixture. Give each test an OWNED environment: CODEXCOMMANDER_HOME under the
   * fixture root plus an install-state recording the current homes.
   */
  previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
  fixtureRoot = mkdtempSync(join(tmpdir(), "ccx-owned-home-"));
  cleanup.push(fixtureRoot);
  process.env.CODEXCOMMANDER_HOME = fixtureRoot;
  writeFileSync(join(fixtureRoot, "service-state.json"), JSON.stringify({
    version: 3,
    codexHome: process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    codexCommanderHome: fixtureRoot,
    bunPath: process.execPath,
    cliPath: join(import.meta.dir, "../src/cli/index.ts"),
    backend: "scheduler",
  }), { mode: 0o600 });
});

afterEach(() => {
  if (previousGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousGrokHome;
  if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

/** Overwrite the owned install-state with a FOREIGN one (home_mismatch tests). */
function writeForeignInstallState(): void {
  writeFileSync(join(fixtureRoot, "service-state.json"), JSON.stringify({
    version: 3,
    codexHome: "/foreign/codex-home",
    codexCommanderHome: "/foreign/codexcommander-home",
    bunPath: process.execPath,
    cliPath: join(import.meta.dir, "../src/cli/index.ts"),
    backend: "scheduler",
  }), { mode: 0o600 });
}

function baseConfig(overrides: Partial<CodexCommanderConfig> = {}): CodexCommanderConfig {
  return { port: 10100, hostname: "127.0.0.1", providers: [], ...overrides } as CodexCommanderConfig;
}

/** A schema-valid config for tests that must observe the real durable-intent write. */
function durableConfig(overrides: Partial<CodexCommanderConfig> = {}): CodexCommanderConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    multiAgentGuidanceEnabled: true,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    } as CodexCommanderConfig["providers"],
    defaultProvider: "openai",
    ...overrides,
  };
}

function configPath(): string {
  return join(grokHome, "config.toml");
}

function writeConfig(content: string): void {
  writeFileSync(configPath(), content);
}

function readConfig(): string {
  return readFileSync(configPath(), "utf8");
}

function fencedConfig(userPrefix = "# user's own settings\n"): string {
  return `${userPrefix}${BEGIN}\n[model.ccx-a]\nmodel = "p/m"\n${END}\n`;
}

function persistedGrokIntent(): unknown {
  const raw = JSON.parse(readFileSync(join(fixtureRoot, "config.json"), "utf8")) as Record<string, unknown>;
  return (raw.clientIntegrations as Record<string, unknown> | undefined)?.grok;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeLifecycleAuthority(onRelease: (lock: "S" | "E") => void): ProxyLifecycleAuthority {
  let ensureHeld = true;
  let startHeld = true;
  return {
    deadlineAt: Date.now() + 1_000,
    ensure: { token: "ensure", release: () => {} },
    get start() {
      return startHeld ? { token: "start", release: () => this.releaseStart() } : undefined;
    },
    async acquireStart() {
      throw new Error("toggle acquires E and S together");
    },
    delegatedLease: () => !ensureHeld || !startHeld
      ? undefined
      : { ensureToken: "ensure", startToken: "start" },
    releaseStart() {
      if (!startHeld) return;
      startHeld = false;
      onRelease("S");
    },
    releaseAll() {
      this.releaseStart();
      if (!ensureHeld) return;
      ensureHeld = false;
      onRelease("E");
    },
  };
}

/**
 * Deps every test gets unless it overrides them: the runtime seam reads null so
 * no test depends on the developer's real runtime state file, and the catalog
 * seam returns a fixed list so no test touches provider discovery.
 */
function testDeps(overrides: ManagementApiDeps = {}): ManagementApiDeps {
  return {
    proxyStopLifecycle: {
      acquireAuthority: async () => fakeLifecycleAuthority(() => {}),
    },
    readRuntimePort: () => null,
    fetchAllModels: async () => [
      { provider: "stub", id: "m1", alias: "fast", contextWindow: 64000 },
      { provider: "stub", id: "m2" },
    ] as never,
    visibleNativeSlugs: () => [],
    ...overrides,
  };
}

function dispatch(config: CodexCommanderConfig, path: string, init?: RequestInit, deps: ManagementApiDeps = testDeps()) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return handleManagementAPI(
    new Request(url, { ...init, headers: { Host: url.host, ...(init?.headers ?? {}) } }),
    url,
    config,
    deps,
  );
}

async function put(config: CodexCommanderConfig, enabled: boolean, deps?: ManagementApiDeps) {
  const res = await dispatch(config, "/api/native-integrations/grok", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  }, deps);
  return { status: res!.status, body: await res!.json() as Record<string, unknown> };
}

async function get(config: CodexCommanderConfig, deps?: ManagementApiDeps) {
  const res = await dispatch(config, "/api/native-integrations", undefined, deps);
  const body = await res!.json() as { clients: Record<string, unknown>[] };
  return body.clients.find(c => c.clientId === "grok")!;
}

test("GET reports absent when no fence exists", async () => {
  writeConfig("# user only\n");
  const row = await get(baseConfig());
  expect(row.state).toBe("absent");
  expect(row.installed).toBe(true);
  expect(row.disableBlocked).toBeNull();
  expect(String(row.configPath)).toEndWith("config.toml");
});

test("GET reports not-installed when GROK_HOME is missing", async () => {
  process.env.GROK_HOME = join(grokHome, "does-not-exist");
  const row = await get(baseConfig());
  expect(row.installed).toBe(false);
  expect(row.state).toBe("absent");
});

test("GET reports unsafe and blocks the switch on an orphaned marker", async () => {
  writeConfig(`# user\n${BEGIN}\n[model.ccx-a]\n`);
  const row = await get(baseConfig());
  expect(row.state).toBe("unsafe");
  expect((row.disableBlocked as { reason: string }).reason).toBe("orphaned_marker");
});

test("enable regenerates the fence with the catalog's aliases", async () => {
  writeConfig("# user only\n");
  const { status, body } = await put(baseConfig(), true);
  expect(status).toBe(200);
  expect(body.state).toBe("current");
  expect(body.changed).toBe(true);
  const content = readConfig();
  expect(content).toContain(BEGIN);
  // The writer allocates its own `ccx-`-prefixed alias and carries the aliased
  // model's id verbatim; the context window must survive the trip.
  expect(content).toContain('model = "fast"');
  expect(content).toContain("context_window = 64000");
  expect(content.startsWith("# user only\n")).toBe(true);
});

test("disable removes only the fence; user bytes and CRLF survive", async () => {
  const original = "# user header\r\n[model.mine]\r\nmodel = \"x/y\"\r\n";
  writeConfig(original);
  // A real enable writes the fence, so the strip has something genuine to remove.
  const enable = await put(baseConfig(), true);
  expect(enable.status).toBe(200);
  expect(readConfig()).toContain("\r\n");
  const disable = await put(baseConfig(), false);
  expect(disable.status).toBe(200);
  expect(disable.body.state).toBe("absent");
  expect(disable.body.changed).toBe(true);
  expect(readConfig()).toBe(original);
});

test("disable → enable → disable returns to the same non-fenced content", async () => {
  const original = "# stable\n";
  writeConfig(original);
  await put(baseConfig(), true);
  await put(baseConfig(), false);
  expect(readConfig()).toBe(original);
  await put(baseConfig(), true);
  await put(baseConfig(), false);
  expect(readConfig()).toBe(original);
});

test("toggling to the current state changes nothing", async () => {
  writeConfig("# user only\n");
  const off = await put(baseConfig(), false);
  expect(off.status).toBe(200);
  expect(off.body.changed).toBe(false);
  await put(baseConfig(), true);
  const bytes = readConfig();
  const onAgain = await put(baseConfig(), true);
  expect(onAgain.body.changed).toBe(false);
  expect(readConfig()).toBe(bytes);
});

test("an orphaned marker refuses BOTH directions and no writer runs", async () => {
  const orphaned = `# user\n${BEGIN}\n[model.ccx-a]\n`;
  writeConfig(orphaned);
  let injectCalled = false;
  const deps = testDeps({
    injectGrokConfig: ((...args: Parameters<typeof injectGrokConfig>) => {
      injectCalled = true;
      return injectGrokConfig(...args);
    }) as typeof injectGrokConfig,
  });
  const disable = await put(baseConfig(), false, deps);
  expect(disable.status).toBe(409);
  expect(disable.body.reason).toBe("orphaned_marker");
  expect(disable.body.code).toBe("native_integration_refused");
  const enable = await put(baseConfig(), true, deps);
  expect(enable.status).toBe(409);
  expect(enable.body.reason).toBe("orphaned_marker");
  expect(injectCalled).toBe(false);
  expect(readConfig()).toBe(orphaned);
});

test("a missing GROK_HOME refuses not_installed", async () => {
  process.env.GROK_HOME = join(grokHome, "nope");
  const enable = await put(baseConfig(), true);
  expect(enable.status).toBe(404);
  expect(enable.body.reason).toBe("not_installed");
  expect(enable.body.code).toBe("native_integration_refused");
  const disable = await put(baseConfig(), false);
  expect(disable.status).toBe(404);
  expect(disable.body.reason).toBe("not_installed");
});

/*
 * Non-loopback binds. The runtime seam names the non-loopback host so the
 * config (and the origin gate) can stay loopback — the seam exists precisely
 * so the fence policy follows what the process BOUND, not what config recorded.
 */
const nonLoopbackDeps = (overrides: ManagementApiDeps = {}): ManagementApiDeps =>
  testDeps({ readRuntimePort: () => ({ pid: process.pid, port: 10100, hostname: "0.0.0.0" }), ...overrides });

test("non-loopback enable REMOVES an existing fence: 200, not a refusal", async () => {
  writeConfig(fencedConfig());
  const { status, body } = await put(baseConfig(), true, nonLoopbackDeps());
  expect(status).toBe(200);
  expect(body.changed).toBe(true);
  expect(body.state).toBe("absent");
  expect(body.reason).toBe("non_loopback_removed");
  expect(readConfig()).not.toContain(BEGIN);
});

test("non-loopback enable with no fence reports changed:false", async () => {
  writeConfig("# user only\n");
  const { status, body } = await put(baseConfig(), true, nonLoopbackDeps());
  expect(status).toBe(200);
  expect(body.changed).toBe(false);
  expect(body.state).toBe("absent");
  expect(body.reason).toBe("non_loopback_removed");
});

test("non-loopback enable over an orphaned marker refuses, never absent", async () => {
  const orphaned = `# user\n${BEGIN}\n[model.ccx-a]\n`;
  writeConfig(orphaned);
  const { status, body } = await put(baseConfig(), true, nonLoopbackDeps());
  expect(status).toBe(409);
  expect(body.reason).toBe("orphaned_marker");
  expect(readConfig()).toBe(orphaned);
});

test("enable re-inspects AFTER the catalog fetch (audit r7)", async () => {
  writeConfig("# user only\n");
  const deps = testDeps({
    fetchAllModels: (async () => {
      // The file becomes orphaned INSIDE the awaiting window — by `ccx
      // ensure`, another proxy, a hand edit. The preflight already passed.
      writeConfig(`${BEGIN}\n[model.ccx-a]\n`);
      return [];
    }) as never,
  });
  const { status, body } = await put(baseConfig(), true, deps);
  expect(status).toBe(409);
  expect(body.reason).toBe("orphaned_marker");
});

test("the non-loopback outcome inspects AFTER the write (audit r8)", async () => {
  writeConfig("# user only\n");
  const deps = nonLoopbackDeps({
    // A fence that becomes orphaned between the recheck and the write: the
    // writer's own result cannot say so, and only the post-inspection can.
    injectGrokConfig: (() => {
      writeConfig(`${BEGIN}\n[model.ccx-a]\n`);
      return { ok: true, changed: true, message: "policy skip", skippedReason: "non-loopback" } as const;
    }) as never,
  });
  const { status, body } = await put(baseConfig(), true, deps);
  expect(status).toBe(409);
  expect(body.reason).toBe("orphaned_marker");
  expect(body.state).toBeUndefined();
});

test("a foreign fence between strip and read is superseded, never absent (audit r9)", async () => {
  writeConfig("# user only\n");
  const deps = nonLoopbackDeps({
    injectGrokConfig: (() => {
      // `ccx ensure` regenerated a well-formed fence in the window.
      writeConfig(fencedConfig());
      return { ok: true, changed: true, message: "policy skip", skippedReason: "non-loopback" } as const;
    }) as never,
  });
  const { status, body } = await put(baseConfig(), true, deps);
  expect(status).toBe(200);
  expect(body.state).toBe("current");
  expect(body.reason).toBe("non_loopback_superseded");
});

test("a catalog failure refuses and writes nothing", async () => {
  const original = "# user only\n";
  writeConfig(original);
  const deps = testDeps({
    fetchAllModels: (async () => { throw new Error("provider discovery down"); }) as never,
  });
  const { status, body } = await put(baseConfig(), true, deps);
  expect(status).toBe(500);
  expect(body.reason).toBe("write_failed");
  expect(body.code).toBe("native_integration_failed");
  expect(readConfig()).toBe(original);
});

test("the route never calls syncGrokConfig, and the inspector never re-implements the parser", () => {
  const routeSource = readFileSync(join(import.meta.dir, "../src/server/management/native-integration-routes.ts"), "utf8");
  // Comments may NAME the wrapper (they explain why it is bypassed); what must
  // not exist is an import of it or a call to it.
  expect(routeSource).not.toMatch(/import\s*\{[^}]*syncGrokConfig/);
  expect(routeSource).not.toMatch(/[^A-Za-z]syncGrokConfig\s*\(/);
  const inspectSource = readFileSync(join(import.meta.dir, "../src/grok/inspect.ts"), "utf8");
  expect(inspectSource).not.toContain("function findManagedRegion");
  const injectSource = readFileSync(join(import.meta.dir, "../src/grok/inject.ts"), "utf8");
  expect(injectSource.match(/function findManagedRegion/g)).toHaveLength(1);
});

test("the route's model list is byte-identical to syncGrokConfig's", async () => {
  writeConfig("# user only\n");
  const config = baseConfig({ grokExcludedModels: ["stub/m2"] });
  const catalog = [
    { provider: "stub", id: "m1", alias: "fast", contextWindow: 64000 },
    { provider: "stub", id: "m2" },
  ];
  let routeModels: GrokInjectModel[] | null = null;
  let routeExcluded: ReadonlySet<string> | null = null;
  const routeDeps = testDeps({
    fetchAllModels: (async () => catalog) as never,
    injectGrokConfig: ((port: number, models: GrokInjectModel[], opts: Parameters<typeof injectGrokConfig>[2]) => {
      routeModels = models;
      routeExcluded = opts?.excluded ?? null;
      return injectGrokConfig(port, models, opts);
    }) as typeof injectGrokConfig,
  });
  const { status } = await put(config, true, routeDeps);
  expect(status).toBe(200);

  let syncModels: GrokInjectModel[] | null = null;
  let syncExcluded: ReadonlySet<string> | null = null;
  await syncGrokConfig(10100, config, { hostname: "127.0.0.1" }, {
    fetchAllModels: (async () => catalog) as never,
    visibleNativeSlugs: () => [],
    injectGrokConfig: ((port: number, models: GrokInjectModel[], opts: Parameters<typeof injectGrokConfig>[2]) => {
      syncModels = models;
      syncExcluded = opts?.excluded ?? null;
      return injectGrokConfig(port, models, opts);
    }) as typeof injectGrokConfig,
  });
  expect(JSON.stringify(routeModels)).toBe(JSON.stringify(syncModels));
  /*
   * The exclusion half of the clause (C-gate blocker): the FULL list goes to
   * the writer together with the exclusion SET, never a pre-filtered list —
   * dropping `excluded` here would leave the models arrays identical while
   * excluded models silently leaked into the fence.
   */
  expect(routeExcluded && [...routeExcluded].sort()).toEqual(["stub/m2"]);
  expect(syncExcluded && [...syncExcluded].sort()).toEqual(["stub/m2"]);
  // And the exclusion actually reached the fence both times: each write went
  // through the real writer into the fixture file, and m2 appears in neither.
  const fence = readConfig();
  expect(fence).toContain('model = "fast"');
  expect(fence).not.toContain("stub/m2");
  expect(fence).not.toContain("ccx-stub-m2");
});

test("a late orphan surfaced by the WRITER still maps to 409, never to absent", () => {
  /*
   * The inject-side mapping (C-gate nit): an orphan arriving between the
   * recheck and the write is refused by the writer's own main-path check
   * (inject.ts:393) and the route must report the refusal, not a success.
   */
  return (async () => {
    writeConfig("# user only\n");
    const deps = testDeps({
      injectGrokConfig: (() => ({
        ok: false, changed: false,
        message: "Grok config contains a CodexCommander begin marker without its end marker; refusing to guess where the managed block ends.",
        skippedReason: "orphaned-marker",
      }) as const) as never,
    });
    const { status, body } = await put(baseConfig(), true, deps);
    expect(status).toBe(409);
    expect(body.reason).toBe("orphaned_marker");
    expect(body.state).toBeUndefined();
  })();
});

test("a foreign-home install state refuses disable and writes nothing (audit r1 #5)", async () => {
  writeConfig(fencedConfig());
  writeForeignInstallState();
  const { status, body } = await put(baseConfig(), false);
  expect(status).toBe(409);
  expect(body.reason).toBe("home_mismatch");
  expect(body.desiredEnabled).toBe(false);
  expect(String(body.message)).toContain("/foreign/codex-home");
  // Nothing was written: the fence is still there.
  expect(readConfig()).toContain(BEGIN);
});

test("enable is NOT gated by the ownership preflight", async () => {
  writeConfig("# user only\n");
  writeForeignInstallState();
  const { status, body } = await put(baseConfig(), true);
  expect(status).toBe(200);
  expect(body.state).toBe("current");
  expect(readConfig()).toContain(BEGIN);
});

test("a second concurrent PUT gets 409 config_busy and writes nothing", async () => {
  writeConfig("# user only\n");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deps = testDeps({ fetchAllModels: (async () => { await gate; return []; }) as never });
  const config = baseConfig();
  const first = put(config, true, deps);
  // The first toggle is now in flight, parked inside the catalog fetch.
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = await put(config, false, deps);
  expect(second.status).toBe(409);
  expect(second.body.reason).toBe("config_busy");
  release();
  const firstResult = await first;
  expect(firstResult.status).toBe(200);
  // And the flight cleared: a later toggle is served normally.
  const third = await put(config, false, deps);
  expect(third.status).toBe(200);
});

test("PUT ON queues behind Stop and holds E plus S through intent and fence injection", async () => {
  const disabled = durableConfig({ clientIntegrations: { grok: false } });
  writeFileSync(join(fixtureRoot, "config.json"), JSON.stringify(disabled, null, 2));
  writeConfig("# user only\n");
  const authorityEntered = deferred<void>();
  const releaseHeldStop = deferred<void>();
  const calls: string[] = [];

  const pending = put(disabled, true, testDeps({
    proxyStopLifecycle: {
      acquireAuthority: async options => {
        calls.push("wait-for-stop");
        expect(options).toEqual({ includeStart: true });
        authorityEntered.resolve();
        await releaseHeldStop.promise;
        calls.push("acquire-E-then-S");
        return fakeLifecycleAuthority(lock => {
          calls.push(`release-${lock}`);
          expect(persistedGrokIntent()).toBeUndefined();
          expect(readConfig()).toContain(BEGIN);
        });
      },
    },
    injectGrokConfig: ((...args: Parameters<typeof injectGrokConfig>) => {
      calls.push("inject-fence");
      expect(persistedGrokIntent()).toBeUndefined();
      return injectGrokConfig(...args);
    }) as typeof injectGrokConfig,
  }));

  await authorityEntered.promise;
  expect(persistedGrokIntent()).toBe(false);
  expect(readConfig()).toBe("# user only\n");
  expect(calls).toEqual(["wait-for-stop"]);

  releaseHeldStop.resolve();
  const result = await pending;
  expect(result.status).toBe(200);
  expect(calls).toEqual([
    "wait-for-stop",
    "acquire-E-then-S",
    "inject-fence",
    "release-S",
    "release-E",
  ]);
});

test("PUT OFF queues behind Start and holds E plus S through intent and fence strip", async () => {
  const enabled = durableConfig();
  writeFileSync(join(fixtureRoot, "config.json"), JSON.stringify(enabled, null, 2));
  writeConfig(fencedConfig());
  const authorityEntered = deferred<void>();
  const releaseHeldStart = deferred<void>();
  const calls: string[] = [];

  const pending = put(enabled, false, testDeps({
    proxyStopLifecycle: {
      acquireAuthority: async options => {
        calls.push("wait-for-start");
        expect(options).toEqual({ includeStart: true });
        authorityEntered.resolve();
        await releaseHeldStart.promise;
        calls.push("acquire-E-then-S");
        return fakeLifecycleAuthority(lock => {
          calls.push(`release-${lock}`);
          expect(persistedGrokIntent()).toBe(false);
          expect(readConfig()).not.toContain(BEGIN);
        });
      },
    },
  }));

  await authorityEntered.promise;
  expect(persistedGrokIntent()).toBeUndefined();
  expect(readConfig()).toContain(BEGIN);
  expect(calls).toEqual(["wait-for-start"]);

  releaseHeldStart.resolve();
  const result = await pending;
  expect(result.status).toBe(200);
  expect(calls).toEqual([
    "wait-for-start",
    "acquire-E-then-S",
    "release-S",
    "release-E",
  ]);
});

test("lifecycle-authority refusal returns sanitized config_busy and mutates nothing", async () => {
  const enabled = durableConfig();
  writeFileSync(join(fixtureRoot, "config.json"), JSON.stringify(enabled, null, 2));
  const orphaned = `${BEGIN}\n[model.ccx-a]\n`;
  writeConfig(orphaned);
  const calls: string[] = [];
  const result = await put(enabled, false, testDeps({
    proxyStopLifecycle: {
      acquireAuthority: async options => {
        calls.push(`acquire:${String(options?.includeStart)}`);
        throw new Error("secret lifecycle path and token");
      },
    },
    fetchAllModels: (async () => {
      calls.push("fetch-models");
      return [];
    }) as never,
    injectGrokConfig: (() => {
      calls.push("inject-fence");
      throw new Error("must not write");
    }) as never,
  }));

  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({
    error: "native integration change refused",
    code: "native_integration_refused",
    clientId: "grok",
    reason: "config_busy",
  });
  expect(JSON.stringify(result.body)).not.toContain("secret lifecycle path and token");
  expect(persistedGrokIntent()).toBeUndefined();
  expect(readConfig()).toBe(orphaned);
  expect(calls).toEqual(["acquire:true"]);
});

test("no journal row and no snapshot exist for this toggle", () => {
  // The module must not touch the file-client bookkeeping at all — a static
  // check that the imports were never widened (012 §OUT).
  const routeSource = readFileSync(join(import.meta.dir, "../src/server/management/native-integration-routes.ts"), "utf8");
  expect(routeSource).not.toMatch(/import[^;]*integrations\/(journal|store|writer)/);
});

test("the ownership preflight itself is reachable, not declared", async () => {
  const { assertNativeTeardownOwned } = await import("../src/integrations/native/ownership-preflight");
  // The beforeEach fixture already records the CURRENT homes under
  // CODEXCOMMANDER_HOME: owned.
  expect(assertNativeTeardownOwned().ok).toBe(true);
  writeForeignInstallState();
  const owned = assertNativeTeardownOwned();
  expect(owned.ok).toBe(false);
  if (!owned.ok) expect(owned.message).toContain("/foreign/codex-home");
});

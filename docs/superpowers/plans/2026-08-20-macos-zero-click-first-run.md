# macOS Zero-Click First-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a direct packaged macOS app launch safely create CodexCommander's secret-free default configuration, start the proxy, and route initialized Codex without terminal setup.

**Architecture:** A no-clobber initializer in the TypeScript configuration layer remains the only app-bootstrap code that can create `config.json`; under config mutation coordination it directly opens the final entry with `wx`, writes and flushes through the owned descriptor, and never overwrites. A macOS-only policy supplies trusted `getDefaultConfig()` data and a typed start preparation that runs under existing lifecycle authority; the bounded JSON bridge carries setup state to Swift, where the menu presents nonfatal guidance. App-location classification remains native and blocks only ephemeral App Translocation startup.

**Tech Stack:** Bun-native strict TypeScript, Bun test, Swift 5.9/AppKit/ServiceManagement, the existing bounded lifecycle JSON bridge, Astro/Starlight Markdown documentation.

**Spec:** `docs/superpowers/specs/2026-08-20-macos-zero-click-first-run-design.md`

## Global Constraints

- macOS remains version 13.0 or later; do not add a newer framework requirement.
- `getDefaultConfig()` remains the single source of truth for the fresh provider and settings.
- Bootstrap may create only a genuinely absent `$CODEXCOMMANDER_HOME/config.json`; it must never overwrite a valid, invalid, unreadable, linked, or non-regular entry.
- The bootstrap candidate is trusted in-process policy data and is validated for correctness. Active same-user filesystem mutation after the coordinated probe is out of scope; do not add descriptor-relative root anchoring, pathname-swap barriers, or hostile-object test seams.
- Bootstrap must not create or repair `$CODEX_HOME/config.toml`.
- The generated configuration contains no API key, OAuth credential, account identity, or copied machine state.
- Ordinary CLI Start/Ensure, passive companion launches, Stop/Restore, and `setIntegrationEnabled()` retain their current missing-config behavior.
- Existing external Codex routes, recovery journals, and explicit Start ownership checks remain authoritative.
- A physical Desktop/Downloads app may run for the current session but cannot register at login; an `/AppTranslocation/` app must not start a detached proxy.
- Swift must not parse `config.json`, select a provider, or infer setup state from human-readable error strings.
- Lifecycle JSON remains at most 2,048 bytes and secret-free.
- Tests use temporary CodexCommander and Codex homes and never mutate the developer's real home.
- No live provider endpoint is contacted by tests.

## File Map

- `src/config.ts` — create-only, no-clobber configuration initialization and typed refusal reasons.
- `src/cli/macos-first-run.ts` — macOS direct-launch policy that selects the canonical candidate and classifies missing Codex state.
- `src/cli/proxy-lifecycle.ts` — run the preparation under lifecycle authority and carry setup state through Start.
- `src/cli/macos-lifecycle.ts` — install the preparation hook only for the native helper's direct `start` action.
- `tests/config.test.ts` — configuration creation, refusal, race, and permissions coverage.
- `tests/macos-first-run.test.ts` — pure policy matrix.
- `tests/proxy-lifecycle.test.ts` — authority ordering, proxy-only Start, setup result, and CLI regressions.
- `tests/macos-lifecycle.test.ts` — app-only wiring and bounded result encoding.
- `app/Sources/MenuBarCore/LifecycleHelper.swift` — additive JSON decoding with unknown-value tolerance.
- `app/Sources/MenuBarCore/ActionCoordinator.swift` — map structured setup requirements into native outcomes.
- `app/Sources/MenuBarCore/LaunchAtLogin.swift` — classify stable, relocatable, and translocated app bundles and expose neutral remediation.
- `app/Sources/MenuBarUI/LifecyclePresentation.swift` — user-facing first-run and relocation copy.
- `app/Sources/MenuBarUI/OperationStatusView.swift` — existing warning-tone rendering; no new persistence store.
- `app/Sources/MenuBarUI/StartupModeView.swift` — render Login Item remediation as Open Settings or Open Applications.
- `app/Sources/MenuBarUI/PopoverViewController.swift` — expose setup warnings and startup remediation callbacks.
- `app/Sources/MenuBarUI/AppDelegate.swift` — handle setup outcomes, open Applications, and block translocated Start.
- `app/Sources/MenuBarCoreTests/*.swift` and `app/Sources/MenuBarUITests/main.swift` — bridge, state mapping, location, copy, accessibility, and action coverage.
- `README.md`, `docs-site/src/content/docs/getting-started/installation.md`, `docs-site/src/content/docs/getting-started/quickstart.md`, `docs-site/src/content/docs/guides/macos-menu-bar.md`, `structure/01_runtime.md`, and `structure/02_config-and-codex-home.md` — user guidance and maintainer invariants.

---

### Task 1: Add a no-clobber configuration initializer

**Files:**
- Modify: `src/config.ts:1645-1855,1950-2025`
- Test: `tests/config.test.ts:1-35,110-410`

**Interfaces:**
- Consumes: `validateConfigCandidate(value)`, the existing config mutation transaction (with a private initializer-only bounded timeout), `bumpGenerationForCooperatingConfigWrite()`, `recordOwnedConfigPath(configDir, path)`, and the existing secret-path hardening functions.
- Produces:

```ts
export type ConfigInitializationRefusal =
  | "candidate-invalid"
  | "existing-invalid"
  | "existing-inaccessible"
  | "existing-unsafe"
  | "coordination-unavailable";

export type ConfigInitializationResult =
  | { status: "created" }
  | { status: "existing" }
  | { status: "refused"; reason: ConfigInitializationRefusal };

export function initializeConfigIfMissing(
  candidate: CodexCommanderConfig,
): ConfigInitializationResult;
```

- [ ] **Step 1: Write failing tests for missing, existing, and invalid entries**

Add an import for `initializeConfigIfMissing`, then add a focused describe block:

```ts
describe("create-only config initialization", () => {
  test("creates the canonical candidate only when config.json is absent", () => {
    const candidate = getDefaultConfig();
    expect(initializeConfigIfMissing(candidate)).toEqual({ status: "created" });
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

  test("rejects an invalid candidate without creating config state", () => {
    const invalid = { ...getDefaultConfig(), defaultProvider: "missing" };
    expect(initializeConfigIfMissing(invalid)).toEqual({
      status: "refused",
      reason: "candidate-invalid",
    });
    expect(existsSync(getConfigPath())).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm the API is missing**

Run: `bun test tests/config.test.ts --test-name-pattern "create-only config initialization"`

Expected: FAIL because `initializeConfigIfMissing` is not exported.

- [ ] **Step 3: Add unsafe-entry and no-clobber race tests**

Extend the same describe block:

```ts
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
```

- [ ] **Step 4: Implement typed probing and exclusive publication**

Use `lstatSync` before every read, treat only `ENOENT` as missing, and keep raw bytes private. Under the existing config mutation coordination, open the final `config.json` directly with `openSync(path, "wx", 0o600)`, write and flush through that descriptor, and never overwrite. Keep the public runtime mutation lock at `busy_timeout=0`; initializer-only acquisition may use the bounded 2-second timeout required for the two-process `created`/`existing` result. The implementation shape is:

```ts
type ConfigEntryProbe =
  | { kind: "missing" }
  | { kind: "valid" }
  | { kind: "refused"; reason: Exclude<ConfigInitializationRefusal, "candidate-invalid" | "coordination-unavailable"> };

function probeConfigEntry(): ConfigEntryProbe {
  let entry;
  try {
    entry = lstatSync(getConfigPath());
  } catch (error) {
    return isMissingPathError(error)
      ? { kind: "missing" }
      : { kind: "refused", reason: "existing-inaccessible" };
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    return { kind: "refused", reason: "existing-unsafe" };
  }
  try {
    return configDiagnosticsFromRaw(readFileSync(getConfigPath(), "utf8")).source === "file"
      ? { kind: "valid" }
      : { kind: "refused", reason: "existing-invalid" };
  } catch {
    return { kind: "refused", reason: "existing-inaccessible" };
  }
}

export function initializeConfigIfMissing(
  candidate: CodexCommanderConfig,
): ConfigInitializationResult {
  const validated = validateConfigCandidate(candidate);
  if (!validated.ok) return { status: "refused", reason: "candidate-invalid" };
  const observed = probeConfigEntry();
  if (observed.kind === "valid") return { status: "existing" };
  if (observed.kind === "refused") return { status: "refused", reason: observed.reason };
  try {
    if (!recordOwnedConfigPath(getConfigDir(), getConfigPath())) {
      return { status: "refused", reason: "existing-unsafe" };
    }
  } catch {
    return { status: "refused", reason: "existing-inaccessible" };
  }

  try {
    return withConfigMutationLockTimeoutSync(() => {
      const current = probeConfigEntry();
      if (current.kind === "valid") return { status: "existing" } as const;
      if (current.kind === "refused") {
        return { status: "refused", reason: current.reason } as const;
      }
      const bytes = `${JSON.stringify(validated.config, null, 2)}\n`;
      const published = createConfigExclusive(getConfigPath(), bytes);
      if (!published) {
        const winner = probeConfigEntry();
        if (winner.kind === "valid") return { status: "existing" } as const;
        return {
          status: "refused",
          reason: winner.kind === "refused" ? winner.reason : "coordination-unavailable",
        } as const;
      }
      bumpGenerationForCooperatingConfigWrite();
      return { status: "created" } as const;
    }, CONFIG_INITIALIZATION_WAIT_MS);
  } catch {
    return { status: "refused", reason: "coordination-unavailable" };
  }
}
```

Implement the private publisher explicitly:

```ts
function createConfigExclusive(path: string, bytes: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  let complete = false;
  let descriptorOpen = true;
  try {
    writeFileSync(descriptor, bytes, { encoding: "utf8" });
    try { fchmodSync(descriptor, 0o600); } catch { /* filesystem may ignore chmod */ }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptorOpen = false;
    if (process.platform === "win32") {
      hardenSecretPath(path, { required: true, timeoutMemoKey: path });
    }
    complete = true;
    return true;
  } finally {
    if (descriptorOpen) try { closeSync(descriptor); } catch { /* original error wins */ }
    if (!complete) try { unlinkSync(path); } catch { /* later probes refuse residue */ }
  }
}
```

Do not add a production test callback or CWD/root-anchoring seam. The trust boundary is the
coordinated CodexCommander process and its trusted policy candidate; active same-user pathname swaps
after admission are explicitly out of scope. On `EEXIST`, re-probe exactly once and adopt only a
complete valid ordinary single-link file.

- [ ] **Step 5: Run focused and regression tests**

Run:

```bash
bun test tests/config.test.ts --test-name-pattern "create-only config initialization"
bun test tests/codex-desired-state.test.ts --test-name-pattern "missing config refuses"
bun test tests/config.test.ts --test-name-pattern "two processes racing initialization" --rerun-each 300 --only-failures
bun run typecheck
```

Expected: all commands PASS; the desired-state regression still returns `reason: "missing"`.

- [ ] **Step 6: Commit the initializer**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add create-only first-run initialization"
```

---

### Task 2: Add the pure macOS first-run policy

**Files:**
- Create: `src/cli/macos-first-run.ts`
- Create: `tests/macos-first-run.test.ts`

**Interfaces:**
- Consumes: `getDefaultConfig()`, `initializeConfigIfMissing(candidate)`, and `CODEX_CONFIG_PATH` from `src/codex/paths.ts`.
- Produces:

```ts
export type ProxySetupRequirement = "codex-first-run";

export type ProxyStartPreparation =
  | {
      ok: true;
      changed: boolean;
      enableCodexRouting: boolean;
      setupRequired?: ProxySetupRequirement;
    }
  | {
      ok: false;
      changed: false;
      message: string;
      errorCode: "CONFIGURATION_REQUIRED";
    };

export interface MacOSFirstRunIo {
  initializeConfig?: typeof initializeConfigIfMissing;
  codexConfigState?: () => "present-or-unreadable" | "missing";
}

export function prepareMacOSAppStart(io?: MacOSFirstRunIo): ProxyStartPreparation;
```

- [ ] **Step 1: Write the policy matrix as failing tests**

Create `tests/macos-first-run.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../src/config";
import { prepareMacOSAppStart } from "../src/cli/macos-first-run";

describe("macOS first-run preparation", () => {
  test("fresh app plus initialized Codex enables normal explicit routing", () => {
    let candidate = getDefaultConfig();
    const result = prepareMacOSAppStart({
      codexConfigState: () => "present-or-unreadable",
      initializeConfig: value => { candidate = value; return { status: "created" }; },
    });
    expect(candidate).toEqual(getDefaultConfig());
    expect(result).toEqual({ ok: true, changed: true, enableCodexRouting: true });
  });

  test("fresh app plus missing Codex persists integration off and requests setup", () => {
    let candidate = getDefaultConfig();
    const result = prepareMacOSAppStart({
      codexConfigState: () => "missing",
      initializeConfig: value => { candidate = value; return { status: "created" }; },
    });
    expect(candidate.clientIntegrations).toEqual({ codex: false });
    expect(result).toEqual({
      ok: true,
      changed: true,
      enableCodexRouting: false,
      setupRequired: "codex-first-run",
    });
  });

  test("existing config is never replaced even when Codex is missing", () => {
    const result = prepareMacOSAppStart({
      codexConfigState: () => "missing",
      initializeConfig: () => ({ status: "existing" }),
    });
    expect(result).toEqual({
      ok: true,
      changed: false,
      enableCodexRouting: true,
      setupRequired: "codex-first-run",
    });
  });

  test("typed initialization refusals become a secret-free app error", () => {
    const result = prepareMacOSAppStart({
      codexConfigState: () => "present-or-unreadable",
      initializeConfig: () => ({ status: "refused", reason: "existing-invalid" }),
    });
    expect(result).toEqual({
      ok: false,
      changed: false,
      message: "CodexCommander configuration needs repair; no files were changed.",
      errorCode: "CONFIGURATION_REQUIRED",
    });
  });
});
```

- [ ] **Step 2: Run the new test and confirm the module is missing**

Run: `bun test tests/macos-first-run.test.ts`

Expected: FAIL because `src/cli/macos-first-run.ts` does not exist.

- [ ] **Step 3: Implement the policy without reading credentials**

Create the module with an `lstatSync(CODEX_CONFIG_PATH)` classifier that returns `missing` only for `ENOENT`; every other result is `present-or-unreadable` so existing Codex admission performs the authoritative validation.

```ts
export function prepareMacOSAppStart(
  io: MacOSFirstRunIo = {},
): ProxyStartPreparation {
  const codexState = (io.codexConfigState ?? defaultCodexConfigState)();
  const candidate = structuredClone(getDefaultConfig());
  if (codexState === "missing") {
    candidate.clientIntegrations = {
      ...(candidate.clientIntegrations ?? {}),
      codex: false,
    };
  }
  const initialized = (io.initializeConfig ?? initializeConfigIfMissing)(candidate);
  if (initialized.status === "refused") {
    return {
      ok: false,
      changed: false,
      message: initialized.reason === "existing-invalid"
        ? "CodexCommander configuration needs repair; no files were changed."
        : "CodexCommander configuration is inaccessible or unsafe; no files were changed.",
      errorCode: "CONFIGURATION_REQUIRED",
    };
  }
  return {
    ok: true,
    changed: initialized.status === "created",
    enableCodexRouting: !(initialized.status === "created" && codexState === "missing"),
    ...(codexState === "missing" ? { setupRequired: "codex-first-run" as const } : {}),
  };
}
```

- [ ] **Step 4: Run policy tests and typecheck**

Run:

```bash
bun test tests/macos-first-run.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the policy**

```bash
git add src/cli/macos-first-run.ts tests/macos-first-run.test.ts
git commit -m "feat(macos): define first-run bootstrap policy"
```

---

### Task 3: Run app preparation inside lifecycle authority

**Files:**
- Modify: `src/cli/proxy-lifecycle.ts:73-183,647-930`
- Test: `tests/proxy-lifecycle.test.ts:1-95,100-760`

**Interfaces:**
- Consumes: `ProxyStartPreparation` and `ProxySetupRequirement` from Task 2 through an injected `EnsureProxyLifecycleIo.prepareStart` hook.
- Produces: `ProxyLifecycleResult.setupRequired?: ProxySetupRequirement` and `ProxyLifecycleResult.errorCode` value `CONFIGURATION_REQUIRED`.

- [ ] **Step 1: Write failing tests for authority ordering and refusal**

Add `prepareStart?: () => ProxyStartPreparation` to the test IO only after the production type exists. First add tests that describe the required call order:

```ts
test("app preparation runs under E before config load and routing preparation", async () => {
  const calls: string[] = [];
  const result = await ensureProxyLifecycle({
    action: "start",
    ensureCompanion: false,
    io: baseIo({
      acquireAuthority: async () => { calls.push("acquire-E"); return authority(calls); },
      prepareStart: () => {
        calls.push("prepare-app");
        return { ok: true, changed: true, enableCodexRouting: true };
      },
      loadConfig: () => { calls.push("load-config"); return config(); },
      findLive: async () => ({ pid: 42, port: 10100, source: "runtime" }),
      setEnabled: (_client, enabled) => {
        calls.push(`enable:${enabled}`);
        return { ok: true, status: "unchanged", enabled };
      },
    }),
  });
  expect(result.ok).toBe(true);
  expect(calls.indexOf("acquire-E")).toBeLessThan(calls.indexOf("prepare-app"));
  expect(calls.indexOf("prepare-app")).toBeLessThan(calls.indexOf("load-config"));
  expect(calls.indexOf("load-config")).toBeLessThan(calls.indexOf("enable:true"));
});

test("refused app preparation exits before load, probe, or spawn", async () => {
  const calls: string[] = [];
  const result = await ensureProxyLifecycle({
    action: "start",
    io: baseIo({
      prepareStart: () => ({
        ok: false,
        changed: false,
        message: "CodexCommander configuration needs repair; no files were changed.",
        errorCode: "CONFIGURATION_REQUIRED",
      }),
      loadConfig: () => { calls.push("load"); return config(); },
      findLive: async () => { calls.push("find"); return null; },
      spawnStart: async () => { calls.push("spawn"); },
    }),
  });
  expect(result).toMatchObject({
    action: "start",
    ok: false,
    state: "blocked",
    errorCode: "CONFIGURATION_REQUIRED",
  });
  expect(calls).toEqual([]);
});
```

- [ ] **Step 2: Run the focused tests and verify the missing hook/type failures**

Run: `bun test tests/proxy-lifecycle.test.ts --test-name-pattern "app preparation"`

Expected: FAIL because `prepareStart`, `setupRequired`, and `CONFIGURATION_REQUIRED` are not part of the lifecycle contract.

- [ ] **Step 3: Write failing tests for proxy-only setup and running setup recovery**

```ts
test("fresh missing-Codex preparation starts without enabling routing", async () => {
  const calls: string[] = [];
  const result = await ensureProxyLifecycle({
    action: "start",
    ensureCompanion: false,
    io: baseIo({
      prepareStart: () => ({
        ok: true,
        changed: true,
        enableCodexRouting: false,
        setupRequired: "codex-first-run",
      }),
      loadConfig: () => ({ ...config(), clientIntegrations: { codex: false } }),
      setEnabled: () => { calls.push("enable"); return { ok: true, status: "committed", enabled: true }; },
      findLive: async () => ({ pid: 42, port: 10100, source: "runtime" }),
      syncLive: async () => ({
        status: "skipped",
        skippedReason: "desired_disabled",
        ok: true,
        catalogQuality: "native-only",
        catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
      }),
    }),
  });
  expect(calls).toEqual([]);
  expect(result).toMatchObject({
    action: "start",
    ok: true,
    state: "running",
    changed: true,
    setupRequired: "codex-first-run",
  });
});

test("a proven running proxy reports missing Codex as setup instead of generic sync failure", async () => {
  const result = await ensureProxyLifecycle({
    action: "start",
    io: baseIo({
      prepareStart: () => ({
        ok: true,
        changed: false,
        enableCodexRouting: true,
        setupRequired: "codex-first-run",
      }),
      findLive: async () => ({ pid: 42, port: 10100, source: "runtime" }),
      syncLive: async () => ({
        status: "refused",
        ok: false,
        message: "Codex configuration is unavailable.",
        lifecycleErrorCode: "SYNC_FAILED",
      }),
    }),
  });
  expect(result).toMatchObject({
    ok: true,
    state: "running",
    pid: 42,
    setupRequired: "codex-first-run",
  });
  expect(result.errorCode).toBeUndefined();
});

test("app preparation still preserves an external Codex provider", async () => {
  const calls: string[] = [];
  const result = await ensureProxyLifecycle({
    action: "start",
    io: baseIo({
      prepareStart: () => ({ ok: true, changed: true, enableCodexRouting: true }),
      externalProvider: () => "external-owner",
      findLive: async () => ({ pid: 42, port: 10100, source: "runtime" }),
      setEnabled: (_client, enabled) => {
        calls.push(`enabled:${enabled}`);
        return { ok: true, status: "unchanged", enabled };
      },
      syncLive: async () => ({
        status: "skipped",
        skippedReason: "external_provider",
        ok: true,
        catalogQuality: "native-only",
        catalogState: { state: "not_running", processes: [], catalogMtimeMs: null },
      }),
    }),
  });
  expect(result).toMatchObject({ ok: true, state: "running" });
  expect(calls).toEqual(["enabled:true"]);
});
```

- [ ] **Step 4: Implement preparation plumbing and result propagation**

In `EnsureProxyLifecycleIo`, add the hook. At the start of `ensureProxyLifecycleUnderLock`, before `loadConfig()`, evaluate it only for `action === "start"`:

```ts
const startPreparation: ProxyStartPreparation = action === "start"
  ? io.prepareStart?.() ?? { ok: true, changed: false, enableCodexRouting: true }
  : { ok: true, changed: false, enableCodexRouting: action === "restart" };
if (!startPreparation.ok) {
  return lifecycleResult(action, "blocked", {
    ok: false,
    changed: startPreparation.changed,
    message: startPreparation.message,
    errorCode: startPreparation.errorCode,
  });
}
let config = (io.loadConfig ?? loadConfig)();
let preparedChanged = startPreparation.changed;
```

Keep recordless-proxy checks for every explicit `start`. Gate only the durable OFF-to-ON transition:

```ts
if (action === "start" && startPreparation.enableCodexRouting) {
  const prepared = prepareExplicitProxyStartWithIo(io, live?.pid ?? undefined);
  // existing refusal and reload behavior
  preparedChanged ||= prepared.changed;
}
```

Add `setupRequired` to `lifecycleResult` options and returned JSON. After `syncResult` is known and a live proxy is proven, give setup priority over `syncProblem` and `syncNotice`:

```ts
if (action === "start" && startPreparation.setupRequired) {
  return lifecycleResult(action, "running", {
    ok: true,
    changed: preparedChanged || startedHere,
    live,
    message: "CodexCommander is running. Open Codex once, then route Codex through the proxy.",
    setupRequired: startPreparation.setupRequired,
  });
}
```

Do not add the hook to Stop, Restore, Restart, service, or ordinary CLI callers.

- [ ] **Step 5: Run lifecycle and desired-state regressions**

Run:

```bash
bun test tests/proxy-lifecycle.test.ts
bun test tests/codex-desired-state.test.ts
bun run typecheck
```

Expected: PASS, including existing lifecycle authority and missing-config refusal tests.

- [ ] **Step 6: Commit lifecycle support**

```bash
git add src/cli/proxy-lifecycle.ts tests/proxy-lifecycle.test.ts
git commit -m "feat(lifecycle): carry macOS first-run setup state"
```

---

### Task 4: Wire bootstrap only into the native Start bridge

**Files:**
- Modify: `src/cli/macos-lifecycle.ts:1-105`
- Modify: `tests/macos-lifecycle.test.ts:1-115`

**Interfaces:**
- Consumes: `prepareMacOSAppStart()` from Task 2 and `EnsureProxyLifecycleIo.prepareStart` from Task 3.
- Produces: `performMacOSLifecycleAction(action, deps?)` as a testable fixed-action dispatcher; production still exposes only `runMacOSLifecycleHelper(args)`.

- [ ] **Step 1: Write a failing app-only wiring test**

Add an injected dispatcher test:

```ts
test("only direct native start installs first-run preparation", async () => {
  const calls: string[] = [];
  const ensure = async (options: Parameters<typeof ensureProxyLifecycle>[0]) => {
    calls.push(`${options.action}:${options.io?.prepareStart ? "prepared" : "plain"}`);
    return { ...success(), action: options.action ?? "ensure" };
  };
  await performMacOSLifecycleAction("ensure", { ensureProxyLifecycle: ensure });
  await performMacOSLifecycleAction("start", {
    ensureProxyLifecycle: ensure,
    prepareMacOSAppStart: () => ({ ok: true, changed: false, enableCodexRouting: true }),
  });
  expect(calls).toEqual(["ensure:plain", "start:prepared"]);
});
```

- [ ] **Step 2: Run the test and confirm the dispatcher is not exported**

Run: `bun test tests/macos-lifecycle.test.ts --test-name-pattern "direct native start"`

Expected: FAIL because `performMacOSLifecycleAction` and dependency injection do not exist.

- [ ] **Step 3: Split the dispatcher and wire the preparation hook**

Define a narrow dependency interface with production defaults, then split `ensure` and `start` cases:

```ts
export interface MacOSLifecycleDeps {
  ensureProxyLifecycle?: typeof ensureProxyLifecycle;
  prepareMacOSAppStart?: typeof prepareMacOSAppStart;
}

export async function performMacOSLifecycleAction(
  action: MacOSLifecycleAction,
  deps: MacOSLifecycleDeps = {},
): Promise<MacOSLifecycleResult> {
  const ensure = deps.ensureProxyLifecycle ?? ensureProxyLifecycle;
  switch (action) {
    case "ensure":
      return ensure({ action, honorAutoStart: false, ensureCompanion: false });
    case "start":
      return ensure({
        action,
        honorAutoStart: false,
        ensureCompanion: false,
        io: { prepareStart: deps.prepareMacOSAppStart ?? prepareMacOSAppStart },
      });
    // retain each existing fixed action branch unchanged
  }
}
```

`runMacOSLifecycleHelper` calls this dispatcher after allowlist validation. It still suppresses diagnostics and emits exactly one frame.

- [ ] **Step 4: Add bounded setup-result encoding coverage**

```ts
test("Codex first-run setup remains a bounded zero-exit running result", () => {
  const result: ProxyLifecycleResult = {
    ...success("CodexCommander is running. Open Codex once, then route Codex through the proxy."),
    action: "start",
    setupRequired: "codex-first-run",
  };
  const encoded = encodeMacOSLifecycleResult("start", result);
  expect(encoded.exitCode).toBe(0);
  expect(Buffer.byteLength(encoded.frame, "utf8")).toBeLessThanOrEqual(MACOS_LIFECYCLE_JSON_MAX_BYTES);
  expect(JSON.parse(encoded.frame)).toMatchObject({
    action: "start",
    ok: true,
    state: "running",
    setupRequired: "codex-first-run",
  });
});
```

- [ ] **Step 5: Run bridge tests, concurrency smoke, and typecheck**

Run:

```bash
bun test tests/macos-lifecycle.test.ts
bun test tests/proxy-lifecycle-concurrency.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit bridge wiring**

```bash
git add src/cli/macos-lifecycle.ts tests/macos-lifecycle.test.ts
git commit -m "feat(macos): bootstrap direct app start"
```

---

### Task 5: Decode setup state and map it into native outcomes

**Files:**
- Modify: `app/Sources/MenuBarCore/LifecycleHelper.swift:17-108`
- Modify: `app/Sources/MenuBarCore/ActionCoordinator.swift:1-105`
- Test: `app/Sources/MenuBarCoreTests/LifecycleHelperSuite.swift`
- Test: `app/Sources/MenuBarCoreTests/ActionSuite.swift`

**Interfaces:**
- Consumes: optional JSON string `setupRequired` from Task 3.
- Produces:

```swift
public enum ProxySetupRequirement: Equatable, Sendable {
    case codexFirstRun
    case unknown(String)
}

public enum ProxyControlOutcome: Equatable, Sendable {
    case running
    case stopped
    case setupRequired(ProxySetupRequirement)
    case catalogUpdateReady(staleWorkerCount: Int?)
    case failed(String)
}
```

- [ ] **Step 1: Write failing decoder tests for absent, known, and unknown values**

In `LifecycleHelperSuite.swift`, decode three bounded JSON frames and assert:

```swift
let absent = try JSONDecoder().decode(
    LifecycleCommandResult.self,
    from: Data(#"{"schemaVersion":1,"action":"start","ok":true,"state":"running","changed":false,"pid":42,"port":10100,"message":"running"}"#.utf8)
)
t.isNil(absent.setupRequired)

let known = try JSONDecoder().decode(
    LifecycleCommandResult.self,
    from: Data(#"{"schemaVersion":1,"action":"start","ok":true,"state":"running","changed":true,"pid":42,"port":10100,"message":"setup","setupRequired":"codex-first-run"}"#.utf8)
)
t.equal(known.setupRequired, "codex-first-run")

let unknown = try JSONDecoder().decode(
    LifecycleCommandResult.self,
    from: Data(#"{"schemaVersion":1,"action":"start","ok":true,"state":"running","changed":false,"pid":42,"port":10100,"message":"setup","setupRequired":"future-setup"}"#.utf8)
)
t.equal(unknown.setupRequired, "future-setup")
```

- [ ] **Step 2: Run the Swift core suite and confirm the property is absent**

Run: `swift run --package-path app MenuBarCoreTests`

Expected: FAIL because `LifecycleCommandResult.setupRequired` does not exist.

- [ ] **Step 3: Add tolerant string decoding**

Add `public let setupRequired: String?`, its initializer argument, coding key, and `decodeIfPresent(String.self, forKey:)`. Do not decode it directly into a raw-value enum; retaining the string is what keeps unknown future values compatible.

- [ ] **Step 4: Write failing ActionCoordinator mapping tests**

Extend `ActionSuite.swift` with a runner result containing `setupRequired: "codex-first-run"`, then assert:

```swift
t.equal(
    sync { await coordinator.start() },
    .setupRequired(.codexFirstRun)
)
```

Add an unknown value case:

```swift
t.equal(
    sync { await coordinator.start() },
    .setupRequired(.unknown("future-setup"))
)
```

- [ ] **Step 5: Implement typed setup mapping before generic success**

```swift
public enum ProxySetupRequirement: Equatable, Sendable {
    case codexFirstRun
    case unknown(String)

    init(rawValue: String) {
        self = rawValue == "codex-first-run" ? .codexFirstRun : .unknown(rawValue)
    }
}
```

In `runLifecycle`, after confirming `result.ok && result.state == .running` but before returning `.running`, map any nonempty setup string. Preserve catalog-update priority only when `codexRestartRequired == true`; setup priority otherwise prevents a running prerequisite from becoming a failure.

- [ ] **Step 6: Update exhaustive policy switches and run core tests**

Update `StopAndQuitPolicy.shouldTerminate` and existing test fixtures to treat `.setupRequired` as non-stopped. Run:

```bash
swift run --package-path app MenuBarCoreTests
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit native bridge support**

```bash
git add app/Sources/MenuBarCore/LifecycleHelper.swift app/Sources/MenuBarCore/ActionCoordinator.swift app/Sources/MenuBarCoreTests/LifecycleHelperSuite.swift app/Sources/MenuBarCoreTests/ActionSuite.swift
git commit -m "feat(macos): decode first-run setup outcomes"
```

---

### Task 6: Present Codex first-run guidance without disabling the proxy UI

**Files:**
- Modify: `app/Sources/MenuBarUI/LifecyclePresentation.swift:57-93`
- Modify: `app/Sources/MenuBarUI/OperationStatusView.swift:35-220`
- Modify: `app/Sources/MenuBarUI/PopoverViewController.swift:290-350`
- Modify: `app/Sources/MenuBarUI/AppDelegate.swift:383-460`
- Test: `app/Sources/MenuBarUITests/main.swift`

**Interfaces:**
- Consumes: `ProxyControlOutcome.setupRequired` from Task 5.
- Produces: `LifecycleResultMessage.setupRequired(_:)` and `PopoverViewController.showSetupRequired(_:)`.

- [ ] **Step 1: Write failing presentation-copy tests**

Add UI test assertions:

```swift
let firstRun = LifecycleResultMessage.setupRequired(.codexFirstRun)
runner.equal(firstRun.title, "Open Codex to finish setup")
runner.equal(
    firstRun.detail,
    "CodexCommander is running. Open Codex once, then choose Route Codex Through Proxy."
)

let future = LifecycleResultMessage.setupRequired(.unknown("future-setup"))
runner.equal(future.title, "CodexCommander setup is required")
runner.equal(future.detail, "The proxy is running. Update CodexCommander for setup instructions.")
```

- [ ] **Step 2: Run UI tests and confirm the message factory is missing**

Run: `swift run --package-path app MenuBarUITests`

Expected: FAIL because `LifecycleResultMessage.setupRequired` does not exist.

- [ ] **Step 3: Add warning-tone rendering through the existing status view**

Add the message factory and controller method:

```swift
public func showSetupRequired(_ requirement: ProxySetupRequirement) {
    let result = LifecycleResultMessage.setupRequired(requirement)
    operationStatus.showResult(
        title: result.title,
        detail: result.detail,
        tone: .warning
    )
    refreshSize()
}
```

This reuses the existing persistent-until-dismissed status surface. Do not add a timer, modal alert, automatic Codex launch, dashboard launch, or background retry.

- [ ] **Step 4: Handle setup outcomes from both launch Start and manual Start**

In both AppDelegate switches, add:

```swift
case .setupRequired(let requirement):
    self.clearCatalogUpdate()
    self.companionHeartbeat?.reportNow()
    self.controller.showSetupRequired(requirement)
```

Keep lifecycle controls enabled after the result. The subsequent fresh snapshot enables the existing **Route Codex Through Proxy** button when the proxy is running and Codex is native or unconfirmed.

- [ ] **Step 5: Add controller behavior and accessibility assertions**

In the UI harness, call `showSetupRequired(.codexFirstRun)` and verify:

```swift
runner.equal(controller.operationStatusTitle, "Open Codex to finish setup")
runner.equal(
    controller.operationStatusDetail,
    "CodexCommander is running. Open Codex once, then choose Route Codex Through Proxy."
)
runner.equal(controller.operationStatusTone, .warning)
runner.expect(controller.routeThroughProxyEnabled, "route retry remains available")
```

Store the last rendered `OperationStatusTone` in a package-private property and expose only package-level read-only hooks for the title, detail, tone, and route-button enabled state. Apply a running/native `ProxySnapshot` before asserting route availability.

- [ ] **Step 6: Run Swift core and UI suites**

Run:

```bash
swift run --package-path app MenuBarCoreTests
swift run --package-path app MenuBarUITests
```

Expected: PASS.

- [ ] **Step 7: Commit setup UI**

```bash
git add app/Sources/MenuBarUI/LifecyclePresentation.swift app/Sources/MenuBarUI/OperationStatusView.swift app/Sources/MenuBarUI/PopoverViewController.swift app/Sources/MenuBarUI/AppDelegate.swift app/Sources/MenuBarUITests/main.swift
git commit -m "feat(macos): show nonfatal Codex setup guidance"
```

---

### Task 7: Make app-location handling neutral and translocation-safe

**Files:**
- Modify: `app/Sources/MenuBarCore/LaunchAtLogin.swift:1-330`
- Modify: `app/Sources/MenuBarUI/StartupModeView.swift:1-120`
- Modify: `app/Sources/MenuBarUI/PopoverViewController.swift:1-120`
- Modify: `app/Sources/MenuBarUI/AppDelegate.swift:20-180,383-455`
- Modify: `app/Sources/MenuBarUI/LifecyclePresentation.swift:57-100`
- Test: `app/Sources/MenuBarCoreTests/LaunchAtLoginSuite.swift:200-400`
- Test: `app/Sources/MenuBarUITests/main.swift`

**Interfaces:**
- Produces:

```swift
public enum AppBundleLocation: Equatable, Sendable {
    case stable
    case relocatable
    case translocated
}

public enum LaunchAtLoginRemediation: Equatable, Sendable {
    case openSystemSettings
    case openApplications
}
```

- `LaunchAtLoginPresentation` gains `relocationRequired: Bool` and computed `remediation` while retaining its existing `LaunchAtLoginStatus` raw values for management-heartbeat compatibility.

- [ ] **Step 1: Replace boolean path tests with a failing three-state matrix**

Update `LaunchAtLoginSuite.swift`:

```swift
t.equal(
    LaunchAtLoginEligibility.classify(
        URL(fileURLWithPath: "/Applications/CodexCommander.app"),
        home: home
    ),
    .stable
)
t.equal(
    LaunchAtLoginEligibility.classify(
        URL(fileURLWithPath: "/tmp/codexcommander-fixture-home/Downloads/CodexCommander.app"),
        home: home
    ),
    .relocatable
)
t.equal(
    LaunchAtLoginEligibility.classify(
        URL(fileURLWithPath: "/private/var/folders/xx/AppTranslocation/CodexCommander.app"),
        home: home
    ),
    .translocated
)
```

Keep stable source-build, `/Applications`, `~/Applications`, wrong bundle name, and wrong source-path cases in the matrix.

- [ ] **Step 2: Run core tests and confirm the classifier is missing**

Run: `swift run --package-path app MenuBarCoreTests`

Expected: FAIL because `classify` and `AppBundleLocation` do not exist.

- [ ] **Step 3: Implement classification without changing heartbeat status values**

Implement `classify` before the compatibility wrapper:

```swift
public static func classify(
    _ bundleURL: URL,
    home: URL = FileManager.default.homeDirectoryForCurrentUser
) -> AppBundleLocation {
    let bundle = bundleURL.resolvingSymlinksInPath()
    let path = bundle.path
    if path.contains("/AppTranslocation/") { return .translocated }
    guard bundle.pathExtension == "app",
          bundle.lastPathComponent == "CodexCommander.app"
    else { return .relocatable }
    if path.hasPrefix("/Applications/") { return .stable }
    let userApplications = home.appendingPathComponent("Applications", isDirectory: true).path
    if path.hasPrefix("\(userApplications)/") { return .stable }
    let sourceBuild = bundle.deletingLastPathComponent().lastPathComponent == "macos"
        && bundle.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "dist"
    return sourceBuild ? .stable : .relocatable
}
```

Retain `isStableBundle` as `classify(...) == .stable` for existing callers/tests until AppDelegate migrates.

- [ ] **Step 4: Write failing neutral-remediation tests**

Assert that `registrationAllowed: false` produces:

```swift
t.equal(presentation.status, .unavailable)
t.equal(presentation.relocationRequired, true)
t.equal(presentation.remediation, .openApplications)
t.isNil(presentation.errorMessage)
t.equal(presentation.isToggleEnabled, false)
```

Assert that `.requiresApproval` produces `.openSystemSettings` and no relocation flag.

- [ ] **Step 5: Implement remediation rendering and callbacks**

Replace `StartupModeView`'s settings-only button plumbing with one remediation button. Render:

- `.openSystemSettings` as **Open Settings**, gear icon, existing accessibility label.
- `.openApplications` as **Open Applications**, folder icon, accessibility label “Open Applications folder”.

For relocation, set detail to `Move CodexCommander to Applications to launch at login.` using `Theme.faint`, not `Theme.red`. Route the typed remediation through `PopoverViewController` to AppDelegate. AppDelegate opens `URL(fileURLWithPath: "/Applications", isDirectory: true)` with `NSWorkspace.shared.open` only after the user presses the button.

- [ ] **Step 6: Block automatic and manual Start from App Translocation**

Cache `AppBundleLocation` in AppDelegate. At the start of `startProxyOnLaunch()` and `startProxy()`, refuse only `.translocated` and show:

```swift
package static let appTranslocated = (
    title: "Move CodexCommander to Applications",
    detail: "This temporary macOS launch location cannot safely run the background proxy. Move the app, then reopen it."
)
```

Do not call `ActionCoordinator.start()` in this branch. `.relocatable` continues through Start for the current session. Documentation and UI copy must tell users to stop CodexCommander before moving a running app so the embedded runtime path is not changed underneath the proxy.

- [ ] **Step 7: Add UI tests for neutral color, action, and blocked Start**

Verify:

- relocation detail is not red;
- the button title and accessibility label are correct;
- activating it invokes the Applications remediation callback;
- approval-required still invokes the System Settings callback;
- a translocated launch shows move-and-reopen guidance and records zero lifecycle Start calls;
- a relocatable launch still records one Start call.

- [ ] **Step 8: Run all macOS tests**

Run:

```bash
swift run --package-path app MenuBarCoreTests
swift run --package-path app MenuBarUITests
bun run test:macos
```

Expected: PASS.

- [ ] **Step 9: Commit location behavior**

```bash
git add app/Sources/MenuBarCore/LaunchAtLogin.swift app/Sources/MenuBarCoreTests/LaunchAtLoginSuite.swift app/Sources/MenuBarUI/StartupModeView.swift app/Sources/MenuBarUI/PopoverViewController.swift app/Sources/MenuBarUI/AppDelegate.swift app/Sources/MenuBarUI/LifecyclePresentation.swift app/Sources/MenuBarUITests/main.swift
git commit -m "feat(macos): make first-run location guidance actionable"
```

---

### Task 8: Document the zero-click flow and maintainer invariants

**Files:**
- Modify: `README.md:58-140`
- Modify: `docs-site/src/content/docs/getting-started/installation.md:1-75`
- Modify: `docs-site/src/content/docs/getting-started/quickstart.md:1-55`
- Modify: `docs-site/src/content/docs/guides/macos-menu-bar.md:1-75,218-275`
- Modify: `structure/01_runtime.md:45-115`
- Modify: `structure/02_config-and-codex-home.md:1-45,160-215`

**Interfaces:**
- Consumes: final user-visible behavior and exact UI copy from Tasks 1-7.
- Produces: one consistent installation path for app users and unchanged CLI instructions for source/headless users.

- [ ] **Step 1: Update the README macOS install flow**

State explicitly:

```md
On a fresh Mac, a direct app launch creates CodexCommander's secret-free ChatGPT passthrough default automatically. If Codex has not created `~/.codex/config.toml` yet, the proxy and dashboard still start while Codex remains native; open Codex once, then choose **Route Codex Through Proxy** from the menu.
```

Also state that providers, API keys, and OAuth accounts are not copied from another Mac and that public distribution uses the universal release archive rather than a thin development `.app`.

- [ ] **Step 2: Split app and CLI quickstarts clearly**

In installation and quickstart docs:

- keep `ccx init` as the required source/headless CLI setup;
- document that direct packaged macOS app Start alone owns automatic default creation;
- explain missing Codex setup without suggesting manual JSON creation;
- explain that existing invalid config is preserved and must be repaired;
- state that external Codex providers remain untouched.

- [ ] **Step 3: Update app-location and uninstall guidance**

Document:

- Applications and `~/Applications` support Launch at Login;
- Desktop/Downloads works only for the current session and shows neutral relocation guidance;
- stop CodexCommander before moving a running app;
- App Translocation requires move-and-reopen before Start;
- the app never moves itself;
- ad-hoc Gatekeeper instructions remain unchanged.

- [ ] **Step 4: Record the new SOT invariants**

Update `structure/01_runtime.md` and `structure/02_config-and-codex-home.md` with:

- direct native Start's app-only bootstrap hook;
- E-lock then config-mutation-lock ordering;
- no-clobber initialization and race-winner preservation;
- ordinary CLI missing-config refusal;
- missing Codex setup result and proxy-running semantics;
- translocation prohibition and neutral relocation presentation.

- [ ] **Step 5: Validate documentation links and privacy language**

Run:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
cd ..
bun run privacy:scan
```

Expected: PASS with no contradictory CLI/app setup instructions and no private path introduced.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs-site/src/content/docs/getting-started/installation.md docs-site/src/content/docs/getting-started/quickstart.md docs-site/src/content/docs/guides/macos-menu-bar.md structure/01_runtime.md structure/02_config-and-codex-home.md
git commit -m "docs: explain zero-click macOS first run"
```

---

### Task 9: Run full verification and review the branch

**Files:**
- Verify all files changed in Tasks 1-8.
- Do not edit generated `dist/`, `gui/dist`, or Swift `.build/` output.

**Interfaces:**
- Consumes: the complete feature branch.
- Produces: evidence that the app bootstrap, CLI regressions, privacy boundary, and packaged runtime all pass.

- [ ] **Step 1: Inspect the branch for unintended changes**

Run:

```bash
git status --short
git diff --check main...HEAD
git diff --stat main...HEAD
```

Expected: only the approved implementation, tests, structure notes, and user documentation are present; no build output or credential-bearing fixture appears.

- [ ] **Step 2: Run focused TypeScript tests together**

Run:

```bash
bun test tests/config.test.ts tests/macos-first-run.test.ts tests/proxy-lifecycle.test.ts tests/macos-lifecycle.test.ts tests/codex-desired-state.test.ts tests/proxy-lifecycle-concurrency.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository TypeScript verification**

Run:

```bash
bun run typecheck
bun run test:parallel
```

Expected: PASS. If the parallel runner itself misbehaves, run `bun run test` and record why the fallback was used.

- [ ] **Step 4: Run privacy and native app verification**

Run:

```bash
bun run privacy:scan
bun run test:macos
bun run build:macos
```

Expected: PASS. Confirm the built app still reports its source revision and `lipo -archs` reports the host build architecture.

- [ ] **Step 5: Perform two temporary-home packaged smoke tests**

Use `mktemp -d` roots and the embedded Bun runtime. Do not point either selector at the real home. Run this from the repository root:

```bash
set -euo pipefail
ccx_smoke_bundle="$PWD/dist/macos/CodexCommander.app"
ccx_smoke_runtime="$ccx_smoke_bundle/Contents/Resources/runtime"
ccx_smoke_bun="$ccx_smoke_runtime/node_modules/bun/bin/bun.exe"
ccx_smoke_entry="$ccx_smoke_runtime/src/cli/index.ts"
ccx_smoke_dead_proxy="http://127.0.0.1:9"
ccx_smoke_tmp="${TMPDIR:-/tmp}"
ccx_smoke_tmp="${ccx_smoke_tmp%/}"
ccx_smoke_root="$(mktemp -d "$ccx_smoke_tmp/ccx-first-run.XXXXXX")"
ccx_smoke_state_a="$ccx_smoke_root/state-a"
ccx_smoke_codex_a="$ccx_smoke_root/codex-a"
ccx_smoke_state_b="$ccx_smoke_root/state-b"
ccx_smoke_codex_b="$ccx_smoke_root/codex-b"
mkdir -p "$ccx_smoke_state_a" "$ccx_smoke_codex_a" "$ccx_smoke_state_b" "$ccx_smoke_codex_b"
install -m 600 /dev/null "$ccx_smoke_codex_a/config.toml"

ccx_smoke_json_a="$(
  CODEXCOMMANDER_HOME="$ccx_smoke_state_a" CODEX_HOME="$ccx_smoke_codex_a" \
  HTTP_PROXY="$ccx_smoke_dead_proxy" HTTPS_PROXY="$ccx_smoke_dead_proxy" \
  "$ccx_smoke_bun" --no-install --no-env-file --config=/dev/null \
  "$ccx_smoke_entry" __macos-lifecycle start
)"
CCX_SMOKE_JSON="$ccx_smoke_json_a" "$ccx_smoke_bun" -e '
  const value = JSON.parse(process.env.CCX_SMOKE_JSON ?? "null");
  if (value?.ok !== true || value?.state !== "running" || value?.setupRequired !== undefined) process.exit(1);
'
CODEXCOMMANDER_HOME="$ccx_smoke_state_a" CODEX_HOME="$ccx_smoke_codex_a" \
  "$ccx_smoke_bun" --no-install --no-env-file --config=/dev/null \
  "$ccx_smoke_entry" __macos-lifecycle stop >/dev/null

ccx_smoke_json_b="$(
  CODEXCOMMANDER_HOME="$ccx_smoke_state_b" CODEX_HOME="$ccx_smoke_codex_b" \
  HTTP_PROXY="$ccx_smoke_dead_proxy" HTTPS_PROXY="$ccx_smoke_dead_proxy" \
  "$ccx_smoke_bun" --no-install --no-env-file --config=/dev/null \
  "$ccx_smoke_entry" __macos-lifecycle start
)"
CCX_SMOKE_JSON="$ccx_smoke_json_b" "$ccx_smoke_bun" -e '
  const value = JSON.parse(process.env.CCX_SMOKE_JSON ?? "null");
  if (value?.ok !== true || value?.state !== "running" || value?.setupRequired !== "codex-first-run") process.exit(1);
'
CCX_SMOKE_CONFIG_MODULE="$ccx_smoke_runtime/src/config.ts" \
CODEXCOMMANDER_HOME="$ccx_smoke_state_b" "$ccx_smoke_bun" -e '
  const configModule = await import(process.env.CCX_SMOKE_CONFIG_MODULE ?? "");
  const expected = structuredClone(configModule.getDefaultConfig());
  expected.clientIntegrations = { ...(expected.clientIntegrations ?? {}), codex: false };
  const actual = JSON.parse(await Bun.file(configModule.getConfigPath()).text());
  if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(1);
'
test ! -e "$ccx_smoke_codex_b/config.toml"
CODEXCOMMANDER_HOME="$ccx_smoke_state_b" CODEX_HOME="$ccx_smoke_codex_b" \
  "$ccx_smoke_bun" --no-install --no-env-file --config=/dev/null \
  "$ccx_smoke_entry" __macos-lifecycle stop >/dev/null

case "$ccx_smoke_root" in
  "$ccx_smoke_tmp"/ccx-first-run.*) rm -rf -- "$ccx_smoke_root" ;;
  *) echo "Refusing unexpected smoke root: $ccx_smoke_root" >&2; exit 1 ;;
esac
```

Expected: both smokes pass without provider network calls and leave only files inside their temporary roots.

- [ ] **Step 6: Review security-sensitive boundaries**

Confirm from the diff and tests:

- the initializer creates the final entry directly with `wx`, writes and flushes through the
  owned descriptor, and re-probes once after `EEXIST` without overwriting;
- linked/non-regular/invalid config is refused;
- lifecycle preparation runs while E is held;
- the bridge contains no path, credentials, or raw config;
- App Translocation cannot invoke Start;
- ordinary CLI and passive actions do not install the bootstrap hook.

- [ ] **Step 7: Confirm the verified branch is clean**

Run: `git status --short`

Expected: no output. If a verification failure requires a tracked correction, return to the task that owns that file, repeat its failing-test/implementation/pass cycle, use that task's explicit `git add` list and commit message, then rerun Task 9 from Step 1.

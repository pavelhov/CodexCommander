#!/usr/bin/env node
/**
 * CodexCommander Node launcher.
 *
 * The application source is TypeScript that runs on Bun. Source and application
 * bundles can route through this Node shim, which resolves their bundled Bun
 * runtime and executes the canonical CLI entrypoint.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "cli", "index.ts");
const NODE_LAUNCH_CONTEXT_ENV = "CCX_NODE_LAUNCH_CONTEXT";
const NODE_LAUNCH_PROOF_PREFIX = "--ccx-internal-launch-proof=";

function bunBinDir() {
  // Resolve the bundled `bun` dependency without hardcoding its platform package.
  return dirname(require.resolve("bun/package.json"));
}

// Mirrors src/lib/bun-runtime.ts. This launcher is plain Node and runs before any
// TypeScript is loaded, so the names are repeated rather than imported;
// tests/ccx-launcher-source.test.ts pins the two together.
const BUN_OVERRIDE_ENV = "CCX_BUN_PATH";
const BUN_RUNTIME_SOURCE_ENV = "CCX_BUN_RUNTIME_SOURCE";
const BUN_RUNTIME_PATH_ENV = "CCX_BUN_RUNTIME_PATH";

function findBunBinary(bunDir) {
  // The bundled `bun` package ships bin/bun.exe on every platform; probe
  // bin/bun too for forward compatibility.
  for (const name of ["bun.exe", "bun"]) {
    const p = join(bunDir, "bin", name);
    if (isRealBunBinary(p)) return p;
  }
  return null;
}

function fail(msg) {
  console.error(
    `codexcommander: ${msg}\n` +
      "The bundled Bun runtime could not be prepared. This usually means the\n" +
      "application or source bundle is incomplete. Reinstall it from a supported\n" +
      "distribution, or set CCX_BUN_PATH to a complete Bun executable."
  );
  process.exit(1);
}

function resolveBun() {
  // Keep direct npm-launcher starts aligned with durable service/shim installs:
  // a valid explicit runtime must win even when the bundled dependency exists.
  const override = process.env[BUN_OVERRIDE_ENV]?.trim();
  if (override) {
    const overridePath = resolve(override);
    if (isRealBunBinary(overridePath)) return { path: overridePath, source: "override" };
    console.error(
      `codexcommander: ${BUN_OVERRIDE_ENV} is missing, unreadable, or not a complete Bun binary; falling back to the bundled runtime.`,
    );
  }

  let bunDir;
  try {
    bunDir = bunBinDir();
  } catch {
    fail("the `bun` dependency is not installed.");
  }

  let bin = findBunBinary(bunDir);
  if (bin) return { path: bin, source: "bundled" };

  // Lazy fallback: --ignore-scripts (or a failed postinstall) leaves the
  // ~450-byte placeholder stub. Run the bun package's own installer once.
  const installJs = join(bunDir, "install.js");
  if (existsSync(installJs)) {
    const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });
    if (r.status === 0) bin = findBunBinary(bunDir);
  }
  if (!bin) fail("Bun binary missing after install attempt.");
  return { path: bin, source: "bundled" };
}

const bunRuntime = resolveBun();
const bun = bunRuntime.path;

// Run the Bun child asynchronously and FORWARD termination signals to it, then wait
// for its graceful shutdown before this launcher exits. The previous blocking
// spawnSync() could not run JS signal handlers and did not forward signals, so a
// signal delivered only to this launcher (Codex app, IDE terminal, service wrapper,
// or `kill -INT <launcherPid>`) killed the launcher and ORPHANED the Bun proxy —
// port left bound, pid/runtime-port files left behind, Codex config not restored.
//
// Provenance seam for issue #701: THIS launcher runs under Node, which does not
// auto-load a project `.env`/`.env.local`; the Bun child does, before any CodexCommander
// code evaluates. So this is the last point that can still tell a real shell export
// from a working-directory dotenv value, and we record which Anthropic credential or
// destination slots already existed. The context is paired with a random proof carried
// in argv, which project dotenv cannot modify during an ordinary `ccx` invocation.
// `src/cli/claude.ts` treats anything present in the Bun child but missing from this
// list as ambient project pollution rather than user auth or destination,
// which stopped a project dotenv from silently moving a claude.ai subscriber onto API
// billing and prevents it from redirecting the subscriber's OAuth bearer.
// Disabling Bun's dotenv wholesale with --no-env-file is NOT an option: config
// interpolation and provider settings legitimately read the project environment.
const preBunAnthropicSlots = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
  .filter(name => typeof process.env[name] === "string" && process.env[name] !== "");
const launchProof = randomBytes(32).toString("base64url");
const launchContext = JSON.stringify({
  version: 1,
  proof: launchProof,
  anthropicEnvSlots: preBunAnthropicSlots,
});
const child = spawn(bun, [cliPath, `${NODE_LAUNCH_PROOF_PREFIX}${launchProof}`, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    [NODE_LAUNCH_CONTEXT_ENV]: launchContext,
    [BUN_RUNTIME_SOURCE_ENV]: bunRuntime.source,
    [BUN_RUNTIME_PATH_ENV]: bunRuntime.path,
  },
});

// Windows has no real POSIX signals (no SIGHUP); forwarding is best-effort there.
const FORWARDED = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
const handlers = FORWARDED.map(sig => {
  const handler = () => {
    try {
      child.kill(sig);
    } catch {
      /* child already exited */
    }
  };
  process.on(sig, handler);
  return [sig, handler];
});
const clearHandlers = () => {
  for (const [sig, handler] of handlers) process.removeListener(sig, handler);
};

child.on("error", err => {
  clearHandlers();
  console.error(`codexcommander: failed to launch Bun runtime: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearHandlers();
  // Mirror the child's terminating signal/exit code so this launcher's status matches.
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

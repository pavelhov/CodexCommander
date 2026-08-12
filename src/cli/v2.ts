/**
 * `ccx v2 status|on|off` — toggle/report the codex `multi_agent_v2` feature that
 * controls the multi-agent surface (v1 vs v2 collab mode).
 *
 * Contract:
 *  - config.toml writes go through the official `codex features enable|disable`
 *    CLI only (format-preserving TOML edit stays upstream-owned).
 *  - after a successful flip the catalog is RESYNCED so model metadata stays fresh.
 *  - flips preserve the active thread limit while moving it between the v1/v2
 *    config keys, with byte-for-byte rollback when the feature command fails.
 *  - nothing in the catalog build path calls this module; no auto-flip exists.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { activeCodexConfigPath, getAgentsEnabled, getAgentsMaxDepth, getLogicalMaxThreads, getSubagentDeveloperInstructions, hasAgentsMaxThreads, isMultiAgentV2Enabled, transitionMultiAgentV2 } from "../codex/features";

import { commandInvocation, type SpawnInvocation } from "../lib/win-exec";
import {
  loadConfig,
  mutatePersistedConfig,
  readConfigDiagnostics,
  saveConfig,
  withConfigMutationLockSync,
} from "../config";
import { resolveAndPersistCodexRuntime, type ResolveCodexRuntimeDeps } from "../codex/runtime";
import type { CodexCommanderConfig } from "../types";
import { acquireProxyLifecycleAuthority, type ProxyLifecycleAuthority } from "../server/proxy-lifecycle-authority";
import { findLiveProxy } from "../server/proxy-liveness";
import { runLocalCliCodexSync, syncCodexCatalogForCli } from "./catalog-activation";

export interface V2CliDeps {
  execFile?: (file: string, args: string[], options?: SpawnInvocation["options"]) => void;
  featuresInvocation?: (action: "enable" | "disable") => SpawnInvocation;
  isEnabled?: typeof isMultiAgentV2Enabled;
  hasMaxThreads?: typeof hasAgentsMaxThreads;
  sync?: (port?: number) => Promise<unknown>;
  acquireAuthority?: (options: { includeStart: true }) => Promise<ProxyLifecycleAuthority>;
  log?: Pick<Console, "log" | "error">;
}

export type CodexFeaturesInvocationDeps =
  & Parameters<typeof commandInvocation>[3]
  & Pick<ResolveCodexRuntimeDeps, "existsSync" | "execFileSync" | "configDir" | "readFileSync">;

/**
 * Shared invocation for `codex features enable|disable <feature>` — the single
 * source of truth for the CLI and the management API fallback. Windows npm installs
 * expose `codex` as a `.cmd` shim, which needs the win-exec launcher
 * (implementation contract). Upstream `codex features` validates
 * the key against the installed build's feature registry, so an old Codex will
 * fail loudly instead of silently writing an unknown flag.
 */
export function codexFeaturesInvocation(
  action: "enable" | "disable",
  feature: string = "multi_agent_v2",
  platform: NodeJS.Platform = process.platform,
  deps: CodexFeaturesInvocationDeps = {},
): SpawnInvocation {
  const command = resolveAndPersistCodexRuntime({
    env: deps.env ?? process.env,
    platform,
    existsSync: deps.existsSync,
    execFileSync: deps.execFileSync,
    configDir: deps.configDir,
    readFileSync: deps.readFileSync,
  }).runtime.command || "codex";
  return commandInvocation(command, ["features", action, feature], platform, deps);
}

/**
 * Run `codex features <action> <feature>` synchronously - the management API
 * fallback when no deps toggle is injected. Shares the invocation builder and
 * the bounded timeout/stdio options so every production toggle path behaves
 * identically.
 */
export function runCodexFeaturesCommand(
  action: "enable" | "disable",
  feature: string = "multi_agent_v2",
): void {
  const inv = codexFeaturesInvocation(action, feature);
  execFileSync(inv.file, inv.args,
    {
      stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, windowsHide: true, encoding: "utf8",
      // The reader resolves $CODEX_HOME at call time (including the WSL Windows-home
      // detection); force the same home on the child so it never toggles a different
      // config than the one the postcondition re-reads.
      env: { ...process.env, CODEX_HOME: dirname(activeCodexConfigPath()) },
      ...inv.options,
    });
}

function runCodexFeatures(action: "enable" | "disable", deps: V2CliDeps): void {
  if (!deps.execFile && !deps.featuresInvocation) {
    runCodexFeaturesCommand(action);
    return;
  }
  const exec = deps.execFile ?? ((file: string, args: string[], options?: SpawnInvocation["options"]) => {
    execFileSync(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: dirname(activeCodexConfigPath()) },
      ...options,
    });
  });
  const inv = (deps.featuresInvocation ?? codexFeaturesInvocation)(action);
  exec(inv.file, inv.args, inv.options);
}

export function v2StatusLine(enabled: boolean): string {
  return enabled
    ? "multi_agent_v2: ON — v2 multi-agent surface active"
    : "multi_agent_v2: OFF — v1 multi-agent surface (default install)";
}

export function multiAgentModeLine(mode: string): string {
  switch (mode) {
    case "v1": return "multi_agent_mode: v1 — ALL models forced to v1 surface (upstream pins overridden)";
    case "v2": return "multi_agent_mode: v2 — ALL models forced to v2 surface (upstream pins overridden)";
    default: return "multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)";
  }
}

function applyMultiAgentModeField(
  config: CodexCommanderConfig,
  mode: "v1" | "default" | "v2",
): boolean {
  const next = mode === "default" ? undefined : mode;
  if (config.multiAgentMode === next) return false;
  if (next === undefined) delete config.multiAgentMode;
  else config.multiAgentMode = next;
  return true;
}

/**
 * Persist only the collaboration policy against the newest on-disk config.
 *
 * `mutatePersistedConfig` deliberately refuses a missing config. The CLI has a
 * longstanding first-run contract, though: `ccx v2 mode ...` creates the
 * default config after a successful Codex feature transition. The narrow
 * fallback below preserves that behavior without turning a config that
 * vanished during the (potentially slow) transition into permission to
 * recreate a stale snapshot. The second attempt and first-run initialization
 * share the same cross-process mutation transaction, so a config created by a
 * cooperating writer in between is rebased rather than replaced.
 */
function persistMultiAgentMode(
  mode: "v1" | "default" | "v2",
  firstRunConfig?: CodexCommanderConfig,
) {
  const mutateCurrent = () => mutatePersistedConfig(current => ({
    changed: applyMultiAgentModeField(current, mode),
    value: current.multiAgentMode,
  }));

  let outcome = mutateCurrent();
  if (outcome.status !== "unavailable" || outcome.reason !== "missing" || !firstRunConfig) {
    return outcome;
  }

  outcome = withConfigMutationLockSync(() => {
    // A writer may have created the file after the first missing observation.
    // If so, the ordinary field-scoped mutator now rebases onto those bytes.
    const retry = mutateCurrent();
    if (retry.status !== "unavailable" || retry.reason !== "missing") return retry;

    const initialized = structuredClone(firstRunConfig);
    applyMultiAgentModeField(initialized, mode);
    saveConfig(initialized);
    return { status: "committed" as const, value: initialized.multiAgentMode };
  });
  return outcome;
}

export async function cmdV2(args: string[], deps: V2CliDeps = {}, findPort?: () => Promise<number | undefined>): Promise<number> {
  const log = deps.log ?? console;
  const isEnabled = deps.isEnabled ?? isMultiAgentV2Enabled;
  const hasMaxThreads = deps.hasMaxThreads ?? hasAgentsMaxThreads;
  const verb = (args[0] ?? "status").trim().toLowerCase();

  if (verb === "status") {
    log.log(v2StatusLine(isEnabled()));
    const cfg = loadConfig();
    log.log(multiAgentModeLine(cfg.multiAgentMode ?? "default"));
    const threads = getLogicalMaxThreads();
    log.log(`max_threads: ${threads ?? "(unset — codex default)"}`);
    const v2Active = isEnabled();
    const agentsEnabled = getAgentsEnabled();
    log.log(`agents.enabled: ${agentsEnabled === null ? "(unset — upstream default true)" : agentsEnabled}`);
    const maxDepth = getAgentsMaxDepth();
    // max_depth is V1-only upstream; say so whenever V2 is active so the number
    // cannot be misread as an effective V2 limit.
    log.log(`agents.max_depth: ${maxDepth ?? "(unset — upstream default 1)"}${v2Active ? " (V1-only — ignored while multi_agent_v2 is enabled)" : ""}`);
    const instructions = getSubagentDeveloperInstructions();
    log.log(`subagent_developer_instructions: ${instructions === null ? "(unset — children inherit)" : instructions === "" ? '"" (clears inherited instructions)' : JSON.stringify(instructions)}`);
    if (isEnabled() && hasMaxThreads()) {
      log.log("WARNING: [agents] max_threads is set — codex refuses to start while multi_agent_v2 is enabled. Remove it from config.toml (concurrency lives in features.multi_agent_v2.max_concurrent_threads_per_session).");
    }
    return 0;
  }
  if (verb === "threads") {
    const value = Number((args[1] ?? "").trim());
    if (!Number.isInteger(value) || value < 1) {
      log.error("v2 threads: pass an integer >= 1 (features.multi_agent_v2.max_concurrent_threads_per_session)");
      return 1;
    }
    const enabled = isEnabled();
    const result = transitionMultiAgentV2(enabled, next => runCodexFeatures(next ? "enable" : "disable", deps), { threadLimit: value });
    if (!result.ok) { log.error(`v2 threads: ${result.error}`); return 1; }
    log.log(result.changed
      ? `max_threads = ${value} (${enabled ? "v2" : "v1"}) — applies to new sessions.`
      : `max_threads already ${value} — nothing to do.`);
    return 0;
  }
  if (verb === "mode") {
    const modeArg = (args[1] ?? "").trim().toLowerCase();
    if (modeArg !== "v1" && modeArg !== "default" && modeArg !== "v2") {
      log.error("v2 mode: expected v1|default|v2");
      return 1;
    }
    // Capture whether this invocation is a genuine first run before the Codex
    // feature command gets a chance to block while another writer changes disk.
    const initialDiagnostics = readConfigDiagnostics();
    const initialConfig = loadConfig();
    if (modeArg !== "default") {
      const target = modeArg === "v2";
      const transition = transitionMultiAgentV2(target, enabled => runCodexFeatures(enabled ? "enable" : "disable", deps));
      if (!transition.ok) {
        log.error(`multi-agent mode transition failed: ${transition.error}`);
        return 1;
      }
    }
    const persisted = persistMultiAgentMode(
      modeArg,
      initialDiagnostics.source === "default" ? initialConfig : undefined,
    );
    if (persisted.status === "unavailable") {
      log.error(`multi-agent mode could not be saved (${persisted.reason})`);
      return 1;
    }
    try {
      if (deps.sync) {
        const port = findPort ? await findPort() : undefined;
        await runLocalCliCodexSync(
          () => deps.sync!(port),
          deps.acquireAuthority ?? acquireProxyLifecycleAuthority,
        );
      } else {
        await syncCodexCatalogForCli(await findLiveProxy());
      }
    } catch (err) {
      log.error(`catalog resync failed: ${err instanceof Error ? err.message : String(err)} — run 'ccx sync' manually.`);
      return 1;
    }
    log.log(multiAgentModeLine(modeArg));
    log.log("Applies to NEW sessions; running sessions keep their pinned multi-agent version.");
    return 0;
  }
  if (verb !== "on" && verb !== "off") {
    log.error(`v2: unknown verb '${verb}' (expected status|on|off|mode <v1|default|v2>|threads <n>)`);
    return 1;
  }

  const want = verb === "on";
  const transition = transitionMultiAgentV2(want, enabled => runCodexFeatures(enabled ? "enable" : "disable", deps));
  if (!transition.ok) {
    log.error(`codex features ${want ? "enable" : "disable"} multi_agent_v2 failed: ${transition.error}`);
    return 1;
  }
  if (!transition.changed) {
    log.log(`multi_agent_v2 already ${want ? "ON" : "OFF"} — nothing to do.`);
    return 0;
  }

  // Resync catalog so multi-agent surface metadata stays fresh in both the
  // on-disk catalog and models_cache.json after the toggle flip.
  try {
    if (deps.sync) {
      const port = findPort ? await findPort() : undefined;
      await runLocalCliCodexSync(
        () => deps.sync!(port),
        deps.acquireAuthority ?? acquireProxyLifecycleAuthority,
      );
    } else {
      await syncCodexCatalogForCli(await findLiveProxy());
    }
  } catch (err) {
    log.error(`catalog resync failed (flag IS flipped): ${err instanceof Error ? err.message : String(err)} — run 'ccx sync' manually.`);
    return 1;
  }
  log.log(v2StatusLine(want));
  log.log("Applies to NEW sessions; running sessions keep their pinned multi-agent version. Restart the Codex app (or wait out its picker cache) to see the ladder change.");
  return 0;
}

/**
 * Runtime-controllable debug flags.
 * Provider debug: `ccx debug provider on|off|status|reset|logs [-f]` (or CCX_DEBUG=1 on start).
 * Usage capture: `ccx debug usage on|off|status|reset|logs [-f]` (or CCX_USAGE_DEBUG=1).
 * Injection log: `ccx debug injection on|off|status|reset` (or CCX_INJECTION_DEBUG=1) —
 * multi-agent guidance-injection console lines, default OFF.
 * Claude inbound capture: `ccx debug claude on|off|status|reset` (or CCX_CLAUDE_DEBUG=1) —
 * allowlist-scalar ring of inbound Anthropic request metadata, default OFF.
 * `/api/debug` and `ccx debug` override env defaults without restart.
 */

export const DEBUG_ENV = {
  debug: "CCX_DEBUG",
  usage: "CCX_USAGE_DEBUG",
  injection: "CCX_INJECTION_DEBUG",
  claude: "CCX_CLAUDE_DEBUG",
} as const;

export type DebugFlag = keyof typeof DEBUG_ENV;

export interface DebugSettingsView {
  enabled: boolean;
  usage: boolean;
  injection: boolean;
  claude: boolean;
  runtimeOverride: Partial<Record<DebugFlag, boolean>>;
  env: Record<DebugFlag, boolean>;
}

const runtimeOverride: Partial<Record<DebugFlag, boolean>> = {};

function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

export function isDebugEnabled(): boolean {
  if (runtimeOverride.debug !== undefined) return runtimeOverride.debug;
  return envFlag(DEBUG_ENV.debug);
}

export function isUsageDebugEnabled(): boolean {
  if (runtimeOverride.usage !== undefined) return runtimeOverride.usage;
  return envFlag(DEBUG_ENV.usage);
}

/** Multi-agent guidance-injection log lines (default OFF; GUI checkbox / API / CLI). */
export function isInjectionDebugEnabled(): boolean {
  if (runtimeOverride.injection !== undefined) return runtimeOverride.injection;
  return envFlag(DEBUG_ENV.injection);
}

/** Claude inbound request capture (default OFF; GUI toggle / API / CLI). */
export function isClaudeDebugEnabled(): boolean {
  if (runtimeOverride.claude !== undefined) return runtimeOverride.claude;
  return envFlag(DEBUG_ENV.claude);
}

export function getDebugSettings(): DebugSettingsView {
  return {
    enabled: isDebugEnabled(),
    usage: isUsageDebugEnabled(),
    injection: isInjectionDebugEnabled(),
    claude: isClaudeDebugEnabled(),
    runtimeOverride: { ...runtimeOverride },
    env: {
      debug: envFlag(DEBUG_ENV.debug),
      usage: envFlag(DEBUG_ENV.usage),
      injection: envFlag(DEBUG_ENV.injection),
      claude: envFlag(DEBUG_ENV.claude),
    },
  };
}

export function setDebugSettings(partial: Partial<Record<DebugFlag, boolean>>): DebugSettingsView {
  for (const key of ["debug", "usage", "injection", "claude"] as const) {
    if (partial[key] !== undefined) runtimeOverride[key] = partial[key];
  }
  return getDebugSettings();
}

export function clearDebugSetting(flag: DebugFlag): DebugSettingsView {
  delete runtimeOverride[flag];
  return getDebugSettings();
}

export function clearDebugSettings(): DebugSettingsView {
  for (const key of ["debug", "usage", "injection", "claude"] as const) {
    delete runtimeOverride[key];
  }
  return getDebugSettings();
}

/** Test isolation: drop runtime overrides only (env vars untouched). */
export function resetDebugSettingsForTests(): void {
  clearDebugSettings();
}

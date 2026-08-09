/**
 * Pure manual-env builder for the Claude Code page (implementation contract): extracted from ClaudeCode.tsx so the
 * copy-paste shell block is directly unit-testable (tests/claude-manual-env.test.ts).
 */

export type SidecarBackend = "openai" | "anthropic";
export interface SidecarOverride { backend?: SidecarBackend; model?: string }

export interface ClaudeManualEnvState {
  /**
   * The intent as stored. Under "auto" the snippet follows `markerMode`, the
   * daemon-side resolution — which cannot see a key exported only in the user's own
   * terminal, so this block is guidance, not a universal prediction.
   */
  authMode: "auto" | "subscription" | "proxy";
  /** Resolved marker decision from the backend. */
  markerMode: "proxy" | "subscription";
  autoContext: boolean;
  autoCompactWindow: number | null;
  effectiveModelEnv: Record<string, string>;
  port: number;
}

export const MODEL_ENV_NAMES = [
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

export function buildManualEnv(state: ClaudeManualEnvState): string {
  if (state.markerMode !== "proxy" && state.markerMode !== "subscription") {
    throw new Error("markerMode is required");
  }
  const baseUrl = `http://127.0.0.1:${state.port}`;
  const marker = state.authMode === "auto" ? state.markerMode : state.authMode;
  const autoCompactActive = state.autoContext;
  const modelEnvExports = MODEL_ENV_NAMES
    .filter(name => state.effectiveModelEnv[name])
    .map(name => `export ${name}=${state.effectiveModelEnv[name]}`);

  return [
    `export ANTHROPIC_BASE_URL=${baseUrl}`,
    ...(marker === "proxy"
      ? ["export ANTHROPIC_AUTH_TOKEN=codexcommander-proxy"]
      : ["# no ANTHROPIC_AUTH_TOKEN: your claude.ai login (and connectors) stay active"]),
    "export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
    // The flag is an auth assertion in current Claude Code. It belongs only to
    // proxy mode, where the same block supplies a host-managed token. The
    // conditional form still preserves an explicit user opt-out (=0).
    ...(marker === "proxy"
      ? ['[ -z "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST+x}" ] && export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1']
      : []),
    ...(autoCompactActive ? [`export CLAUDE_CODE_AUTO_COMPACT_WINDOW=${state.autoCompactWindow ?? 350000}`] : []),
    ...modelEnvExports,
    "claude",
  ].join("\n");
}

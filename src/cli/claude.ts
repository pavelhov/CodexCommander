/**
 * `ccx claude [claude args...]` — launch Claude Code wired to the local proxy.
 *
 * Mirrors `ccr code` UX (implementation contract, 003 E1/E2/E5/G1):
 * ensures the proxy is running, injects the Anthropic env slots, then execs the
 * `claude` CLI with stdio inherited. User-exported env wins except when a stale
 * loopback codexcommander base URL points at a different proxy port.
 */
import { spawn } from "node:child_process";
import { loadConfig } from "../config";
import { injectClaudeAgentDefs } from "../claude/agents-inject";
import { effectiveModelEnv, resolveAutoContext } from "../claude/context-windows";
import { refreshGatewayModelCacheFromProxy } from "../claude/gateway-cache";
import { commandInvocation } from "../lib/win-exec";
import {
  attestLiveManagementProxy,
  type AttestedLiveManagementProxy,
  type ManagementAttestationIo,
} from "../server/proxy-liveness";
import type { CodexCommanderConfig } from "../types";
import { configuredAdminToken } from "../lib/admin-secrets";
import { API_KEY_HEADER } from "../identity";
import { PROXY_MARKER, isProxyMarker, ownAdmissionTokens, defaultAuthDetectDeps, detectClaudeAuth, type AuthDetectDeps } from "../claude/auth-detect";
import { resolveClaudeAuthMode } from "../claude/auth-mode";
import { ANTHROPIC_PARENT_ENV_SLOTS, NODE_LAUNCH_CONTEXT_ENV, trustedNodeLauncherContext, type AnthropicParentEnvSlot } from "./launcher-context";
import { ensureProxyLifecycle } from "./proxy-lifecycle";

export interface ClaudeLaunchEnv {
  [key: string]: string | undefined;
}

/**
 * Injectable IO for tests. `env` is deliberately NOT injectable: it is bound to the
 * launch base so detection and the spawned process can never disagree (audit R3-3).
 */
export type ClaudeEnvDeps = {
  authDetect?: Omit<Partial<AuthDetectDeps>, "env" | "ownTokens">;
  /** Test seam; production uses the authenticated Node-launcher context. */
  preBunAnthropicSlots?: readonly AnthropicParentEnvSlot[] | null;
};

/**
 * Pure env assembly (unit-tested): never sets ANTHROPIC_API_KEY (setting both
 * token vars triggers Claude Code's auth-conflict warning, 003 E1), and never
 * preserves Anthropic variables proven to exist in the parent Node launcher,
 * apart from stale loopback ANTHROPIC_BASE_URL values owned by a previous
 * codexcommander launch. Unproven ambient values fail closed as project dotenv.
 */
export function buildClaudeEnv(
  config: CodexCommanderConfig,
  port: number,
  base: ClaudeLaunchEnv,
  contextWindows: Record<string, number> = {},
  deps: ClaudeEnvDeps = {},
): ClaudeLaunchEnv {
  const env: ClaudeLaunchEnv = { ...base };
  // Step 1 — strip OUR OWN dummy from the inherited environment before anything reads
  // or writes the token slot. setDefault below preserves any non-empty value, so a
  // stale marker left in place would suppress the admission key and then be removed,
  // leaving the child with no token at all (audit R2-1). It is codexcommander state, never
  // user auth, so dropping it unconditionally is safe.
  if (isProxyMarker(env.ANTHROPIC_AUTH_TOKEN)) delete env.ANTHROPIC_AUTH_TOKEN;
  // Step 1b — drop Anthropic credentials AND destinations that Bun may have synthesized
  // from a project `.env`/`.env.local`. The plain-Node launcher records genuine parent
  // exports before Bun starts and pairs that context with an argv proof, so with a
  // trusted context we know exactly which slots the user really exported.
  //
  // Without a trusted context all three slots are treated as project-controlled. An
  // earlier revision of this branch preserved credentials here, reasoning that the
  // destination is pinned below so a dotenv key would only ever reach the local proxy.
  // That reasoning is wrong, and review caught it: `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`
  // is only set when we own an auth token (see below, and #253 for why asserting it
  // otherwise logs a subscriber out), so on a subscription launch Claude Code's
  // settings.env merge can still replace `ANTHROPIC_BASE_URL` after we return. A
  // preserved key then travels to that host. The repository documents that residual for
  // subscription mode; it must not be widened into a credential leak.
  //
  // Direct `bun src/cli/index.ts` therefore loses ambient Anthropic values. That is a
  // real cost to a documented entry point, and the escape hatch is the launcher: run
  // through `ccx` (the published bin) and genuine shell exports are preserved by proof.
  const explicitSlots = deps.preBunAnthropicSlots;
  const trustedSlots = explicitSlots === undefined
    ? trustedNodeLauncherContext()?.anthropicEnvSlots ?? []
    : explicitSlots ?? [];
  const exported = new Set<AnthropicParentEnvSlot>(trustedSlots);
  for (const name of ANTHROPIC_PARENT_ENV_SLOTS) {
    const value = env[name];
    if (value !== undefined && value !== "" && !exported.has(name)) delete env[name];
  }
  // Never forward the launcher provenance seam to Claude Code.
  delete env[NODE_LAUNCH_CONTEXT_ENV];
  const setDefault = (name: string, value: string | undefined) => {
    if (value === undefined || value.length === 0) return;
    if (env[name] !== undefined && env[name] !== "") return; // user wins
    env[name] = value;
  };
  setDefault("ANTHROPIC_BASE_URL", `http://127.0.0.1:${port}`);
  const existingBaseUrl = env.ANTHROPIC_BASE_URL;
  if (existingBaseUrl) {
    try {
      const parsed = new URL(existingBaseUrl);
      const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (isLoopback && parsed.port !== "" && Number(parsed.port) !== port) {
        const replacement = `http://127.0.0.1:${port}`;
        console.error(`⚠ Replacing stale codexcommander ANTHROPIC_BASE_URL ${existingBaseUrl} with ${replacement}.`);
        env.ANTHROPIC_BASE_URL = replacement;
      }
    } catch {
      // Preserve user-provided values that are not parseable URLs.
    }
  }
  // Subscription-preserving default (teamclaude --no-mitm / Vercel gateway pattern):
  // setting ANTHROPIC_AUTH_TOKEN/API_KEY disables claude.ai connectors and overrides
  // the user's Claude login. Only inject a token when the proxy actually requires an
  // admission key; otherwise Claude Code keeps its own OAuth and sends it to us —
  // native claude models then pass through verbatim (see server/claude-messages.ts).
  if ((config.apiKeys?.length ?? 0) > 0) {
    setDefault("ANTHROPIC_AUTH_TOKEN", config.apiKeys![0].key);
  }
  // Detection reads the SANITIZED launch env — the exact object spawned below — so the
  // resolver and the spawned process cannot disagree. It deliberately does NOT read the
  // raw base: the provenance strip above already removed dotenv-only credentials, and
  // letting a value the child never receives decide the marker left an auto-mode user
  // with neither the credential NOR the proxy marker (#701 audit round 2). Injected deps
  // are spread FIRST and `env` bound LAST, and the injection type excludes `env`, so a
  // test fake cannot break that. `ownTokens` is bound last for the same reason: it is
  // config-derived, and a fake that replaced it could make our own admission key look
  // like user auth.
  const resolved = resolveClaudeAuthMode(config, detectClaudeAuth({
    ...defaultAuthDetectDeps(env as NodeJS.ProcessEnv),
    ...(deps.authDetect ?? {}),
    env: () => env as NodeJS.ProcessEnv,
    ownTokens: ownAdmissionTokens(config),
  }));
  if (!env.ANTHROPIC_AUTH_TOKEN && resolved.markerMode === "proxy") {
    env.ANTHROPIC_AUTH_TOKEN = PROXY_MARKER;
  }
  if (resolved.origin === "auto-unknown") {
    console.error("⚠ Claude 인증을 확인하지 못했습니다 — 구독 방식으로 진행합니다. GUI에서 인증 모드를 직접 지정하면 이 판단을 덮어쓸 수 있습니다.");
  }
  // NOTE: do NOT set _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL here. While it enables
  // Design/Remote Control, it DISABLES gateway model discovery (Claude Code's eligibility
  // check returns false when isFirstPartyBaseUrl() is true). Model routing through the
  // proxy is essential; Design/Remote Control are secondary features.
  // Connectors still work because they check OAuth state ($o()), not base URL (Gd()).
  // Native /model picker discovery ("From gateway", Claude Code >= 2.1.129).
  setDefault("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1");
  // Host-managed routing guard (implementation contract): with
  // this flag in the spawn env, Claude Code strips provider-managed vars
  // (ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY, model slots) from settings-sourced
  // env (managedEnv.ts), so a leftover cc-switch/CCR ~/.claude/settings.json
  // env block cannot silently hijack proxy routing away from codexcommander.
  // setDefault: an explicit user export (e.g. =0, isEnvTruthy-false) still wins.
  // Intentional contract change: settings.env model slots are also stripped in
  // ccx claude runs — use the top-level settings "model" field or opt out.
  // Claude Code 2.1.206+ also treats this as a host-auth assertion. Injecting it
  // without a host token makes a valid claude.ai subscription look logged out,
  // so the guard is only safe when codexcommander actually owns authentication.
  if (env.ANTHROPIC_AUTH_TOKEN) {
    setDefault("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1");
  }
  // Auto-context (implementation contract 020): min(believed window, env) inside the CLI means
  // one global env acts as a per-model floor — [1m]-marked models compact here while
  // unmarked (200k-accounted) models keep their default behavior.
  // A user-exported value drives the marking predicate too (audit 021 #2) so the
  // [1m] marker and the compaction threshold can never separate.
  const userAutoCompact = typeof base.CLAUDE_CODE_AUTO_COMPACT_WINDOW === "string" && base.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== ""
    ? base.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    : undefined;
  const auto = resolveAutoContext(config.claudeCode, userAutoCompact);
  if (auto.enabled) {
    setDefault("CLAUDE_CODE_AUTO_COMPACT_WINDOW", String(auto.compactWindow));
  }
  // Helper-model slots, with automatic [1m] context-variant marking when the
  // configured model has an authoritative >=1M window.
  for (const [name, value] of Object.entries(effectiveModelEnv(config.claudeCode, contextWindows, auto))) {
    setDefault(name, value);
  }
  return env;
}

/**
 * Context-window map from the RUNNING proxy's management API (warm TTL cache; the
 * daemon registers every selector form — audit R3#1). 3s bound + management auth header.
 * (no [1m] marking, conservative).
 */
export async function fetchClaudeContextWindows(
  _config: CodexCommanderConfig,
  port: number,
  timeoutMs = 3_000,
  io: ManagementAttestationIo = {},
): Promise<Record<string, number>> {
  try {
    const target = await attestLiveManagementProxy({ ...io, timeoutMs });
    if (!target || target.port !== port) return {};
    const headers = new Headers();
    const token = configuredAdminToken();
    if (token) headers.set(API_KEY_HEADER, token);
    const res = await (io.fetchFn ?? fetch)(`${target.baseUrl}/api/claude-code`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return {};
    const body = await res.json() as { contextWindows?: Record<string, number> };
    return body.contextWindows && typeof body.contextWindows === "object" ? body.contextWindows : {};
  } catch {
    console.error("⚠ 모델 컨텍스트 정보를 불러오지 못했습니다 — 1M 자동 표시는 이번 실행에서 생략됩니다.");
    return {};
  }
}

export interface ClaudeProxyEnsureDeps {
  ensureLifecycle?: typeof ensureProxyLifecycle;
  attestLive?: typeof attestLiveManagementProxy;
}

export async function ensureProxyForClaude(
  deps: ClaudeProxyEnsureDeps = {},
): Promise<AttestedLiveManagementProxy | null> {
  // Claude needs the proxy even when Codex autostart is disabled, but it must not
  // turn Codex routing back on. The canonical Ensure path owns lifecycle authority
  // across discovery, service/direct start, readiness, and convergence, so Stop
  // cannot finish while this command still has a detached start in flight.
  const ensured = await (deps.ensureLifecycle ?? ensureProxyLifecycle)({
    honorAutoStart: false,
    ensureCompanion: false,
  });
  if (!ensured.ok || ensured.state !== "running" || ensured.port === null) return null;

  // A lookalike listener must not receive Claude credentials. Bind attestation to
  // the lifecycle result's PID when one was available, and always to its live port.
  const target = await (deps.attestLive ?? attestLiveManagementProxy)({
    ...(ensured.pid === null ? {} : { expectedPid: ensured.pid }),
  });
  if (!target
    || target.port !== ensured.port
    || (ensured.pid !== null && target.pid !== ensured.pid)) return null;
  return target;
}

const CLAUDE_INSTALL_HINT = "❌ `claude` CLI not found. Install it first: npm install -g @anthropic-ai/claude-code";

/**
 * cmd.exe reports command-not-found as exit 9009 (the win32 launcher routes `.cmd`
 * shims through cmd.exe, so ENOENT never fires there). Signal exits are not hints.
 * implementation contract
 */
export function claudeNotFoundHint(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === "win32" && code === 9009 && !signal ? CLAUDE_INSTALL_HINT : null;
}

export async function cmdClaude(args: string[]): Promise<number> {
  const config = loadConfig();
  if (config.claudeCode?.enabled === false) {
    console.error("Claude inbound is disabled (config.claudeCode.enabled=false — flip the Claude ON toggle in the GUI or edit config).");
    return 1;
  }
  const target = await ensureProxyForClaude();
  if (!target) {
    console.error("❌ Proxy did not become healthy with a protected runtime identity after starting.");
    return 1;
  }
  const port = target.port;
  const contextWindows = await fetchClaudeContextWindows(config, port);
  const env = buildClaudeEnv(config, port, process.env, contextWindows);
  // Pre-write the CLI's gateway-model cache (implementation contract): without a token the CLI
  // never refreshes it, so the picker would keep showing yesterday's aliases.
  try {
    const cachePath = await refreshGatewayModelCacheFromProxy(port);
    if (cachePath === null) {
      console.error("⚠ Gateway model cache could not be refreshed; the model picker may be stale.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠ Gateway model cache could not be refreshed: ${message}`);
  }
  // Sync roster agents (implementation contract): subagentModels + self -> ~/.claude/agents/ccx-*.md.
  try {
    const written = injectClaudeAgentDefs(config, contextWindows);
    if (written === null) {
      console.error("⚠ Claude agent definitions could not be synced; check ~/.claude/agents permissions.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠ Claude agent definitions could not be synced: ${message}`);
  }
  // Re-prove the exact listener immediately before releasing Claude's admission
  // token and routed request bodies to the child process.
  const launchTarget = await attestLiveManagementProxy({ expectedPid: target.pid });
  if (!launchTarget
    || launchTarget.port !== target.port
    || launchTarget.hostname !== target.hostname) {
    console.error("❌ Proxy identity changed before Claude could launch; retry the command.");
    return 1;
  }
  return await new Promise<number>(resolve => {
    const inv = commandInvocation("claude", args);
    const child = spawn(inv.file, inv.args, { stdio: "inherit", env: env as NodeJS.ProcessEnv, ...inv.options });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error(CLAUDE_INSTALL_HINT);
      } else {
        console.error(`❌ Failed to launch claude: ${err.message}`);
      }
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      const hint = claudeNotFoundHint(code, signal);
      if (hint) console.error(hint);
      resolve(signal ? 1 : code ?? 0);
    });
  });
}

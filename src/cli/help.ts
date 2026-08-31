import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

type HelpEntry = {
  usage: string;
  summary: string;
  details?: string[];
};

const helpEntries: Record<string, HelpEntry> = {
  init: { usage: "ccx init", summary: "Interactive provider setup; optionally route through a proven live proxy." },
  setup: { usage: "ccx setup", summary: "Interactive provider setup; optionally route through a proven live proxy (alias of init)." },
  start: { usage: "ccx start [--port <port>]", summary: "Start the proxy server and sync models to Codex." },
  stop: { usage: "ccx stop", summary: "Stop the proxy and restore native Codex config." },
  restore: {
    usage: "ccx restore [back]",
    summary: "Restore native Codex routing without stopping the proxy; `restore back` re-points codex at the running proxy.",
    details: ["Codex-only: this command does not change Grok or any other client integration."],
  },
  eject: {
    usage: "ccx eject [back]",
    summary: "Restore native Codex routing without stopping the proxy; `eject back` re-points codex at the running proxy.",
    details: ["Codex-only: this command does not change Grok or any other client integration."],
  },
  uninstall: {
    usage: "ccx uninstall",
    summary: "Remove service/shim/local artifacts and restore native Codex.",
    details: [
      "Alias: ccx remove",
      "Config cleanup requires current ownership metadata; unowned or shared directories are left in place.",
      "The small owner/manifest metadata pair remains to preserve one lifecycle-lock namespace.",
    ],
  },
  remove: {
    usage: "ccx remove",
    summary: "Remove service/shim/local artifacts and restore native Codex.",
    details: [
      "Alias of: ccx uninstall",
      "Config cleanup requires current ownership metadata; unowned or shared directories are left in place.",
      "The small owner/manifest metadata pair remains to preserve one lifecycle-lock namespace.",
    ],
  },
  service: {
    usage: "ccx service [install|start|stop|status|uninstall|remove]",
    summary: "Run as a background service.",
    details: [
      "With no subcommand, installs or refreshes and starts the background service.",
      "Use `ccx service status` to see diagnostics and log paths.",
    ],
  },
  "codex-shim": {
    usage: "ccx codex-shim <install|status|uninstall|remove>",
    summary: "Auto-start the proxy when `codex` launches.",
    details: ["Use `remove` as an alias for `uninstall`."],
  },
  tray: {
    usage: "ccx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]",
    summary: "Install and control the Windows status tray icon.",
    details: [
      "The tray starts at Windows login and provides one-click proxy controls.",
      "Tray start/stop controls the icon only; use its menu to start or stop the proxy.",
      "--no-start (install only) installs the tray without launching it immediately.",
    ],
  },
  ensure: { usage: "ccx ensure", summary: "Ensure the proxy is running and Codex config/cache are current." },
  sync: {
    usage: "ccx sync [--restart-codex]",
    summary: "Fetch provider models and inject them into Codex config.",
    details: [
      "After writing the catalog, warns if long-lived Codex app-server processes are still running.",
      "--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).",
    ],
  },
  "sync-cache": {
    usage: "ccx sync-cache [--restart-codex]",
    summary: "Refresh Codex's model cache from the active catalog.",
    details: [
      "Warns when Codex app-server processes still hold an in-memory model list.",
      "--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).",
    ],
  },
  status: { usage: "ccx status", summary: "Check proxy server status." },
  doctor: { usage: "ccx doctor", summary: "Diagnose environment/network issues (paths, WSL /mnt, proxy env, ChatGPT reachability)." },
  debug: {
    usage: "ccx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>",
    summary: "Show or toggle runtime provider, usage, injection, and Claude debug capture.",
    details: [
      "Provider: ccx debug provider on | off | status | reset | logs [-f]",
      "Usage JSONL: ccx debug usage on | off | status | reset | logs [-f]",
      "Env default: CCX_DEBUG=1",
    ],
  },
  login: { usage: "ccx login <provider>", summary: "OAuth or API-key login for a provider." },
  logout: { usage: "ccx logout <provider>", summary: "Remove a stored provider login." },
  gui: { usage: "ccx gui", summary: "Open the CodexCommander dashboard." },
  provider: {
    usage: "ccx provider <list|add|edit|test|remove|show|set-default|selected|quota|presets|account-mode>",
    summary: "Non-interactive provider management.",
    details: [
      "Subcommands: list, add/edit/test/remove/show, set-default, selected, quota, presets, account-mode",
      "Registry providers are auto-configured by name. Custom providers need --adapter and --base-url.",
      "Run `ccx provider --help` for full usage and examples.",
    ],
  },
  account: {
    usage: "ccx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits|main> ...",
    summary: "List and switch provider accounts and API-key pools (GUI parity).",
    details: [
      "list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).",
      "current <provider>  Show the active account or key.",
      "use <provider> <id> Switch the active credential; 'main' selects the Codex App login.",
      "refresh <provider>  Force-refresh Codex or provider quota reports.",
      "auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.",
      "priority <provider> <id|main> [first|earlier|normal|later|last|-100..100|reset]  Selection order; omit the value to read it.",
      "remove <provider> <id> --yes  Remove a stored account or key after an existence check.",
      "add-key <provider> [--label <label>]  Add a key read only from piped stdin.",
      "login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.",
      "reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.",
      "main <subcommand>     Manage the physical native Codex login separately from Pool routing.",
      "Switching the active account takes effect immediately; running threads move on their next request, and in-flight requests keep the account they captured.",
      "A selection-order change applies from the next unbound request and never moves a bound thread.",
    ],
  },
  models: {
    usage: "ccx models <list|live|add|edit|remove|enable|disable|provider|selected|context|shadow> ...",
    summary: "List models and manage custom (manually registered) models.",
    details: [
      "List available models from static config with no subcommand (liveModels may add more at runtime).",
      "add: register a model the provider catalog does not advertise yet.",
      "  --display-name <name>     Human label (no slashes).",
      "  --context-window <tokens> e.g. 200000.",
      "  --modalities text,image   Comma-separated (text|image|audio).",
      "remove: delete a custom model by UUID or <provider>/<modelId>.",
      "list-custom: show all custom models.",
      "Changes apply immediately to a running proxy (catalog sync).",
    ],
  },
  model: {
    usage: "ccx model <subcommand>",
    summary: "Alias of ccx models.",
  },
  combo: {
    usage: "ccx combo <list|show|set|remove> ...",
    summary: "Manage combo failover and round-robin virtual models.",
    details: ["Alias hierarchy: ccx route combo ...", "Use --targets provider/model[:weight],provider/model[:weight]."],
  },
  route: {
    usage: "ccx route combo <list|show|set|remove> ...",
    summary: "Manage routing features; combo is currently the supported routing resource.",
  },
  agent: {
    usage: "ccx agent <status|injection|effort|subagents|fallback|sidecar> ...",
    summary: "Manage headless multi-agent, roster, effort, injection, and sidecar settings.",
  },
  observe: {
    usage: "ccx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...",
    summary: "Inspect proxy requests, usage, storage, memory, and debug data.",
  },
  logs: { usage: "ccx logs [filters] [--follow] [--json|--jsonl]", summary: "Alias of ccx observe logs." },
  usage: { usage: "ccx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]", summary: "Alias of ccx observe usage." },
  storage: { usage: "ccx storage [--json]", summary: "Alias of ccx observe storage." },
  memory: { usage: "ccx memory [--json]", summary: "Alias of ccx observe memory." },
  access: {
    usage: "ccx access <key|endpoints|models|test> ...",
    summary: "Manage CodexCommander admission API keys and inspect external endpoints.",
  },
  "api-key": { usage: "ccx api-key <list|create|remove> ...", summary: "Alias of ccx access key." },
  export: {
    usage: "ccx export --client <opencode|pi|hermes|openclaw|kimi|gajae> [--json] [--out <path>] [--force]",
    summary: "Print a client config (opencode, Pi, Hermes, OpenClaw, Kimi Code, Gajae Code) wired to the running proxy.",
    details: [
      "--json prints only the config JSON on stdout, so it is safe to redirect to a file.",
      "--out <path> writes the config there and refuses to replace an existing file without --force.",
      "The config never contains a key; it references the client's env var, which you export before launching. Kimi cannot hold an env reference, so it carries a loopback placeholder instead.",
      "The destination path is printed for merging by hand — ccx never writes your real client config.",
    ],
  },
  grok: { usage: "ccx grok <status|exclude|include|set|clear|apply> ...", summary: "Manage and apply the Grok Build model fence." },
  integration: { usage: "ccx integration <claude|grok|client> ...", summary: "Manage supported client integrations." },
  system: {
    usage: "ccx system <status|settings|startup|diagnostics|sync> ...",
    summary: "Manage headless runtime settings, startup, sync, and diagnostics.",
  },
  config: {
    usage: "ccx config <show|get|set|unset|validate|export|import> ...",
    summary: "Inspect and safely modify validated CodexCommander configuration.",
    details: ["Secrets are masked by show/get. Import requires --yes and validates before writing."],
  },
  media: {
    usage: "ccx media <status|settings|jobs|probe|acknowledge|open|reveal|recovery> ...",
    summary: "Inspect the attested experimental media runtime or request a human-confirmed capability/recovery action.",
    details: [
      "The capability probe is fixed to one image and one one-second 1080p video.",
      "API-key fallback is disabled; billing attribution remains unknown.",
      "Probe and acknowledgement require an interactive terminal and fresh runtime attestation.",
      "Settings independently control --images, --videos, and --source. jobs wait exits 0 completed, 6 human action, 7 terminal failure, or 8 timeout/progress.",
      "Recovery reset/acknowledge preserves artifacts, keeps the current process blocked, and requires a restart.",
      "This feasibility probe is not packaged release verification.",
    ],
  },
  claude: {
    usage: "ccx claude [claude args...]",
    summary: "Launch Claude Code wired to the proxy (env injection + gateway model discovery).",
    details: [
      "Ensures the proxy is running, then execs `claude` with ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN,",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 and the configured helper-model slot.",
      "Routed models appear in the native /model picker with stable claude-opus-4-8-2026MMDD slot aliases (Claude Code >= 2.1.129).",
      "Older versions: pick models via ANTHROPIC_MODEL or /model <id> directly (any string passes through).",
      "User-exported ANTHROPIC_* variables always take precedence.",
      "",
      "Claude Desktop profile:",
      "  ccx claude desktop apply                           Save and apply the four-family profile",
      "  ccx claude desktop show [--json]                   Show routes, families, and defaults",
      "  ccx claude desktop move <route> <family> [--default]",
      "  ccx claude desktop default <family> <route|none>",
      "  ccx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)",
      "  ccx claude desktop import <path> [--apply]         Validate and import JSON",
      "Families: opus, fable, sonnet, haiku. New routes start in opus.",
      "`none` is valid only when that family is empty.",
      "",
      "Claude Code settings: ccx claude config <status|set> ...",
    ],
  },
  opencode: {
    usage: "ccx opencode [opencode args...]",
    summary: "Launch opencode wired to the proxy (runtime provider config).",
    details: [
      "Ensures the proxy is running, then execs `opencode` with the generated `provider.codexcommander`",
      "block injected through OpenCode's inline runtime layer (`OPENCODE_CONFIG_CONTENT`). Any",
      "existing inline config in the environment is preserved and only `provider.codexcommander` is",
      "overwritten for this launch.",
      "Global/project opencode.json may be read to warn about an existing provider.codexcommander",
      "override; on-disk files are never modified.",
      "Routed models appear in the model picker as codexcommander/<provider>/<model>.",
      "Stop using `ccx opencode` and plain `opencode` behaves exactly as before.",
    ],
  },
  restart: {
    usage: "ccx restart",
    summary: "Stop the proxy and restart it (background). Equivalent to stop + ensure.",
  },
  v2: {
    usage: "ccx v2 <status|on|off|mode <v1|default|v2>|threads <n>>",
    summary: "Toggle the Codex multi_agent_v2 feature (multi-agent surface).",
    details: [
      "status                Show flag, multi-agent mode, and thread limit.",
      "on | off              Enable/disable multi_agent_v2 (catalog resyncs).",
      "mode <v1|default|v2>  Force all models to one surface, or respect upstream pins.",
      "threads <n>           Set max_concurrent_threads_per_session (integer >= 1).",
      "Flips preserve the active thread limit while moving between v1/v2 modes.",
    ],
  },
  health: {
    usage: "ccx health [--json]",
    summary: "Check proxy health. Exits 0 if healthy, 1 otherwise.",
    details: ["Use --json for structured output: {ok, pid, port}."],
  },
  ready: {
    usage: "ccx ready [--json] [--wait [--timeout <seconds>]]",
    summary: "Check post-sync readiness. Exits 0 only when ready.",
    details: [
      "Exact unauthenticated GET /readyz returns HTTP 200 when ready, or 503 with Retry-After: 1 for pending or failed.",
      "Its sanitized HTTP identity is {service, version, uptime, pid, port, status}; /healthz is separate liveness, not readiness.",
      "Default is a single identity-checked /readyz probe; old proxies without /readyz fail closed as unreachable.",
      "--wait polls until ready or timeout, but exits immediately on terminal failed (default 45s, max 300s).",
      "--timeout requires --wait and accepts a positive integer (1..300).",
      "--json emits {ready, status, pid, port}; status is one of ready|pending|failed|unreachable.",
      "Invalid or unknown arguments exit 64. Not-ready, pending, failed, timeout, and unreachable exit 1.",
    ],
  },
};

function packageVersion(): string {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

export function printVersion(): void {
  console.log(`CodexCommander ${packageVersion()}`);
}

export function printUsage(): void {
  console.log(`CodexCommander (ccx) — Universal provider proxy for Codex

Usage:
  ccx setup                   Interactive setup (alias: init)
  ccx start [--port <port>]   Start the proxy server (auto-syncs models to Codex)
  ccx stop                    Stop the proxy AND restore native Codex (plain codex works again)
  ccx restore                 Restore native Codex routing without stopping (alias: eject)
  ccx restore back            Re-point codex at the running proxy (undo restore)
  ccx uninstall               Remove service/shim/local artifacts; restore native Codex (alias: remove)
  ccx service [sub]           Run as a background service (default: install or refresh, then start)
  ccx codex-shim <sub>        Auto-start proxy when \`codex\` launches (install|status|uninstall|remove)
  ccx tray <sub>              Windows status tray (install|start|stop|status|uninstall)
  ccx ensure                  Ensure the proxy is running and Codex config/cache are current
  ccx sync [--restart-codex]  Fetch models from providers and inject into Codex config
  ccx sync-cache [--restart-codex]
                              Refresh Codex's model cache from the active catalog
  ccx status                  Check proxy server status
  ccx doctor                  Diagnose environment/network issues (WSL, proxy, ChatGPT reachability)
  ccx debug <scope>           provider/usage/injection/claude on|off|status|reset
  ccx login <provider>        OAuth or API-key provider login
  ccx logout <provider>       Remove a stored OAuth login
  ccx gui                     Open the CodexCommander dashboard
  ccx restart                  Stop and restart the proxy
  ccx v2 <sub>                multi_agent_v2 surface (status|on|off|mode|threads)
  ccx health [--json]          Check proxy health (exit 0=healthy, 1=not)
  ccx ready [--json] [--wait [--timeout <s>]]  Check post-sync readiness (exit 0 only when ready)
  ccx provider <sub>          Providers, connectivity, quota, and selected models
  ccx account <sub>           Accounts, login/reauth, key pools, and quota controls
  ccx models <sub>            Live/custom models, visibility, context, and shadow calls
  ccx combo <sub>             Combo failover/round-robin routing
  ccx agent <sub>             Subagents, injection, effort caps, and sidecars
  ccx observe <sub>           Logs, usage, storage, memory, and debug data
  ccx access <sub>            External API keys and endpoint information
  ccx export --client <id>    Print a client config wired to the running proxy (6 clients)
  ccx integration client <sub> Enable, disable, inspect or roll back a client integration
  ccx grok <sub>              Grok Build model selection and apply
  ccx system <sub>            Runtime settings, startup, sync, and diagnostics
  ccx config <sub>            Validated configuration show/get/set/import/export
  ccx media <sub>             Attested experimental media status/probe/recovery boundary
  ccx claude [args...]        Launch Claude Code wired to the proxy (model discovery on)
  ccx claude desktop [sub]    Manage and apply Claude Desktop's four-family profile
  ccx opencode [args...]      Launch opencode wired to the proxy (runtime provider config)
  ccx help [command]          Show help
  ccx --version | -v          Print version

Examples:
  ccx init                    Set up provider; optionally route through a proven live proxy
  ccx start                   Start on default port (10100)
  ccx start --port 8080       Start on custom port
  ccx help service            Show service command help
  ccx sync                    Sync available models to Codex`);
}

export function hasHelpFlag(values: string[]): boolean {
  return values.some(value => value === "--help" || value === "-h" || value === "help");
}

export function printSubcommandUsage(name: string | undefined): void {
  const entry = name ? helpEntries[name] : undefined;
  if (!entry) {
    console.error(`Unknown command: ${name ?? ""}`.trim());
    printUsage();
    process.exit(1);
  }
  console.log(`Usage: ${entry.usage}\n\n${entry.summary}`);
  if (entry.details?.length) console.log(`\n${entry.details.join("\n")}`);
}

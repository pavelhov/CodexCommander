---
title: CLI Agents, Routing, and Integrations
description: Multi-agent, combo, observability, access, integration, system, and config commands.
---

These commands control agent policy and routing, inspect the live proxy, and connect supported clients to CodexCommander.

## Agent policy

### `ccx agent <status|injection|effort|subagents|fallback|sidecar> ...`

Manage the headless multi-agent roster, effort caps, prompt injection, fallback, and sidecar settings.
Use `status` for the current policy. See [Sub-agent surfaces](/guides/sub-agent-surface/) for how
the collaboration protocol, delegation, effort, and fallback behavior fit together.

```bash
ccx agent subagents set ark/model-a,openai/gpt-5.5
```

### `ccx v2 <status|on|off|mode <v1|default|v2>|threads <n>>`

Manage the Codex `multi_agent_v2` feature flag and the three-state collaboration protocol.

| Subcommand | Action |
| --- | --- |
| `status` (default) | Report the current V2 flag, multi-agent mode, and thread concurrency. |
| `on` | Enable the `multi_agent_v2` feature and resync the catalog. |
| `off` | Disable the `multi_agent_v2` feature and resync the catalog. |
| `mode v1` | Force all models to V1, disable native V2, and preserve the active thread limit. |
| `mode default` | Respect upstream model surface pins. |
| `mode v2` | Force all models to V2, enable native V2, and preserve the active thread limit. |
| `threads <n>` | Set the active V1/V2 thread limit to an integer of at least 1. |

```bash
ccx v2 status
ccx v2 mode v1
ccx v2 mode default
ccx v2 on
ccx v2 threads 16
```

The `mode` subcommand writes `multiAgentMode` to the CodexCommander config and resyncs the Codex catalog.
Mode and flag transitions move the current numeric thread limit between the valid v1/v2 Codex keys;
a failed transition restores the original `config.toml`. Mode, flag, and thread changes update managed
boot configuration. To affect a running worker, use `ccx sync --restart-codex` (or dashboard **Apply
agent catalog**) and then start a new task for its session-bound tool shape.

## Combo routing

### `ccx combo <list|show|set|remove> ...` · `ccx route combo ...`

Manage combo failover and round-robin virtual models. `ccx route combo` is the hierarchical alias;
combo is currently the supported routing resource. Targets use
`provider/model[:weight],provider/model[:weight]`.

```bash
ccx combo list
ccx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

`set` accepts `--strategy`, `--sticky`, `--effort`, `--alias`, `--rename-from`, `--native-alias`, and
`--display-name <label|->` (`-` clears the label). A native alias captures only one currently
supported, unqualified bare OpenAI model id. Account-qualified OpenAI routes remain distinct, while
provider-qualified routes such as `openai-apikey/gpt-5.6-*` use their configured API key and never
fall through to the native alias. Read the safety and visibility contract in the guide before
enabling the compatibility pair.

See [Combos](/guides/combos/) for routing behavior and configuration guidance.

## Observability and debug

### `ccx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

Inspect proxy requests, usage, storage, memory, and debug data. The direct aliases are:

| Alias | Equivalent resource |
| --- | --- |
| `ccx logs [filters] [--follow] [--json|--jsonl]` | `ccx observe logs` |
| `ccx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]` | `ccx observe usage` |
| `ccx storage [--json]` | `ccx observe storage` |
| `ccx memory [--json]` | `ccx observe memory` |

```bash
ccx observe usage --range 30d --json
```

If the proxy cannot read its usage log (a genuine read, stat, or schema
failure), the underlying `GET /api/usage` responds `503` with
`{ "error": "read_failed", "range", "surface" }` and `ccx usage` reports the
error instead of printing a zeroed report. A missing usage log is not an
error — it still prints an empty (zeroed) report.

### `ccx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

Read or change runtime debug overrides through the running proxy's management API.

```bash
ccx debug provider on|off|status|reset
ccx debug provider logs [-f|--follow]
ccx debug usage on|off|status|reset
ccx debug usage logs [-f|--follow]
```

With no scope, `ccx debug` prints usage and, when the proxy is stopped, the next-start environment
defaults. Provider debug defaults from `CCX_DEBUG=1`; usage
debug defaults from `CODEXCOMMANDER_USAGE_DEBUG=1`.

## API access

### `ccx access <key|endpoints|models|test> ...`

Manage CodexCommander admission API keys and inspect external endpoints and models. `ccx api-key
<list|create|remove> ...` is an alias of `ccx access key`.

```bash
ccx access key create deployment
```

## Client integrations

### `ccx integration <claude|grok> ...`

Manage supported Claude and Grok integrations. The direct command families below expose their
client-specific controls.

### `ccx claude [claude args...]`

Ensure the proxy is running, then launch Claude Code with `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, and the current auth/helper
settings from `config.claudeCode`. Routed models appear in the native `/model` picker through stable aliases
with Claude Code 2.1.129 or newer. On older versions, select with `ANTHROPIC_MODEL` or `/model <id>`.
User-exported `ANTHROPIC_*` variables always take precedence.

Claude Desktop profile commands are:

```text
ccx claude desktop apply                           Save and apply the four-family profile
ccx claude desktop show [--json]                   Show routes, families, and defaults
ccx claude desktop move <route> <family> [--default]
ccx claude desktop default <family> <route|none>
ccx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
ccx claude desktop import <path> [--apply]         Validate and import JSON
```

The families are `opus`, `fable`, `sonnet`, and `haiku`; new routes start in `opus`. `none` is valid
only when that family is empty. Use `ccx claude config <status|set> ...` for Claude Code settings.

### `ccx opencode [opencode args...]`

Ensure the proxy is running, then launch opencode with a generated `provider.codexcommander` block in
OpenCode's inline runtime layer (`OPENCODE_CONFIG_CONTENT`). Existing inline config is preserved and
only `provider.codexcommander` is replaced for this launch. Global or project `opencode.json` files may be
read to warn about an existing override, but on-disk files are never modified. Routed models appear
as `codexcommander/<provider>/<model>`. This launcher leaves later plain `opencode` launches unchanged;
the separate opt-in dashboard integration is the only path that persists `provider.codexcommander`.

### `ccx grok <status|exclude|include|set|clear|apply> ...`

Manage and apply the Grok Build model fence.

## Client config export

### `ccx export --client <opencode|pi>`

Print a client config wired to the running proxy. opencode and [Pi](/guides/pi/) read providers
from their own JSON config rather than environment variables, so this command serializes the
`codexcommander` provider block — base URL, model list, and the client's env reference — for you to
merge into that file.

The proxy must be running; the command resolves its live port, reads `/api/models`, and emits only
models Codex can currently see.

| Flag | Action |
| --- | --- |
| `--client <opencode\|pi>` | Required. Selects the client dialect: opencode's keyed `provider` object or Pi's `providers` array. |
| `--json` | Print only the config JSON on stdout, so a redirect captures byte-exact output. Every diagnostic, including the `--out` write note, goes to stderr. |
| `--out <path>` | Write the config to `<path>`. Refuses to replace an existing file. |
| `--force` | Allow `--out` to replace an existing file. |

```bash
ccx export --client opencode                     # config plus destination, merge warning, and counts
ccx export --client pi --json > pi-models.json   # byte-exact JSON for a pipe or a diff
ccx export --client opencode --out ~/codexcommander-opencode.json
```

Without `--json` the JSON leads, then the canonical destination path, the merge warning, the env
export line, and a model count with how many rows omit context limits (the client applies its own
defaults for those).

| Client | Canonical destination | Download filename | Env var |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME` wins when set) | `opencode.json` | `CODEXCOMMANDER_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` | `pi-models.json` | `CODEXCOMMANDER_API_KEY` |

The two env var names are different, and each client only interpolates its own. opencode reads
`{env:CODEXCOMMANDER_OPENCODE_API_KEY}`; Pi reads `$CODEXCOMMANDER_API_KEY`.

:::caution[Merge, never replace]
`ccx export` never writes your real client config. The destination is printed for you to merge by
hand, and `--out` refuses to overwrite an existing file without `--force`, because replacing a
config destroys the other providers, agents, and MCP entries already in it.
:::

No key is ever serialized. The config carries only the client's env reference, so the secret stays
in your environment. A loopback proxy (`127.0.0.1`, the default) requires no admission key at all —
the reference is simply unused. Set the variable only when the proxy binds beyond loopback; see
[Remote access](/reference/configuration/#remote-access) for how admission keys are issued. Keys for
the upstream providers themselves are a separate thing entirely, configured per
[Providers](/guides/providers/).

The same payload is served by `GET /api/client-config` and rendered on the dashboard's API tab, so
the CLI, the API, and the GUI use the same bytes.

## Runtime and configuration

### `ccx system <status|settings|startup|diagnostics|sync> ...`

Manage headless runtime settings, startup, sync, and diagnostics.

```bash
ccx system settings --stream-mode eager-relay
```

### `ccx config <show|get|set|unset|validate|export|import> ...`

Inspect and safely modify validated CodexCommander configuration. `show` and `get` mask secrets. Import
validates before writing and requires `--yes`.

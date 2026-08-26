---
title: Agent Configuration
description: Multi-agent surfaces, delegation guidance, preferred models, fallback chains, native-default sync, and effort caps.
---

Agent settings control which Codex collaboration surface is advertised and how CodexCommander guides,
routes, and limits delegated work.

## Agent fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` stamps every catalog model as V1; `v2` stamps every model as V2. `default` restores upstream pins (Sol/Terra V2, Luna V1) and otherwise follows the native `multi_agent_v2` flag. After changing it, Apply replaces a running worker; then start a new task for the session-bound tool shape. |
| `multiAgentV2MessageDelivery?` | `"encrypted" \| "plaintext"` | `"encrypted"` | V2 task-message delivery only, not credential encryption. `encrypted` preserves ChatGPT's reserved backend contract and native-only ciphertext guard. `plaintext` opts subsequent V2 parent requests into experimental mixed-provider compatibility; all delegated messages from that parent become plaintext, and routed parents receive the stock Codex plaintext marker on message-bearing collaboration calls. Start a new task after changing it; it does not dirty the catalog or need Apply. |
| `subagentModels?` | `{ model: string, guidance?: string }[] \| string[]` (on disk) | `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini` | Up to five ordered bare native, account-qualified `<selector>/<native-openai-model>`, or routed `provider/model` entries advertised first in the sub-agent picker. Reads accept either legacy strings or objects, but CodexCommander canonicalizes in memory and writes objects. The first object write is a migration point: older binaries that only understand `string[]` fail when they read the config. Optional `guidance` is sanitized operator text, capped at 160 Unicode code points; empty guidance is omitted. The dashboard preserves configured exact selectors and reports which saved entries are advertised or excluded. Use `ccx agent subagents set` or edit the configuration for choices that are not in the current catalog. An explicit empty list is preserved. |
| `injectionModel?` | `string` | — | Preferred native or routed sub-agent model used in proxy-authored V2 delegation guidance. |
| `injectionEffort?` | `string` | — | Preferred effort (`low` through `ultra`), meaningful only with `injectionModel`. |
| `injectionPrompt?` | `string` | — | Replaces the built-in V2 guidance body. Supports `{{model}}`, `{{effort}}`, `{{roster}}`, and `{{fallback}}`. A configured `injectionModel` is sufficient to render the custom prompt. |
| `multiAgentGuidanceEnabled` | `boolean` | `true` | Controls only CodexCommander-authored V1/V2 developer guidance; it does not change native agent defaults, tools, routing, rosters, or effort caps. |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | Opt into writing `injectionModel` and optional `injectionEffort` as Codex's native defaults during sync/restart. Requires `injectionModel`. |
| `subagentModelFallback?` | `string[]` | `[]` | Priority-ordered global fallback models for spawned child turns. |
| `subagentModelFallbackPollMs?` | `number` | `60000` | Availability-probe cache interval. Values below 1000 ms fall back to the default. |
| `effortCap?` | `string` | — | Hard ceiling for qualifying V2 main turns and marked spawned-child turns. Accepts `low` through `ultra`. |
| `subagentEffortCap?` | `string` | — | Additional ceiling for spawned-child turns only. When both caps apply, the lower wins. |

Manage the surface with the dashboard or `ccx v2 status|on|off|mode <v1|default|v2>|threads <n>`.
Mode, protocol, and thread changes update managed Codex boot configuration. If a Codex worker is
already running, choose **Apply agent catalog** to replace it, then start a new task. `maxConcurrentThreadsPerSession` is a `PUT /api/v2` field, not a
`config.json` key; `ccx v2 threads <n>` writes `max_concurrent_threads_per_session` under
`[features.multi_agent_v2]` in Codex's `$CODEX_HOME/config.toml` after V2 is enabled.

The management API exposes `GET`/`PUT /api/v2`, `/api/injection-model`, `/api/effort-caps`,
`/api/subagent-models`, and `/api/subagent-model-fallback`. Injection-model updates are partial;
the custom prompt is the `prompt` field on that API.

The Codex Auth page can also toggle Codex's own `default_mode_request_user_input`
feature flag (`GET`/`PUT /api/codex-auth/features/default-mode-request-user-input`). Enabling it
adds `[features] default_mode_request_user_input = true` to Codex's
`$CODEX_HOME/config.toml` through the official `codex features enable|disable` CLI
(format-preserving edit, removed again when disabled), which lets Codex pause a
Default-mode session and ask you questions with the `request_user_input` tool. The
flag is under development upstream and only applies to new sessions; the toggle fails
loudly when the installed Codex build does not know the flag yet.

## Roster and guidance

The effective V2 roster is the configured, picker-visible, priority-sorted first five models that
are compatible with V2 and present in the injected catalog. Those five are featured suggestions, not
an exhaustive `spawn_agent` allowlist. A parent that already knows an exact catalog ID may pass it
to native `spawn_agent` when the ID is in the worker-loaded catalog and compatible with this surface
and task delivery. Native validation remains authoritative. V2 eligibility treats an explicit `"v2"`,
`null`, or absent upstream pin as eligible; a real `"v1"` pin is excluded. Excluded roster entries
remain in configuration so they can become featured later.

Surface detection uses tool shape. A namespaced `spawn_agent` with `send_input`, `resume_agent`, or
`close_agent` is V1. A flat `spawn_agent` with `send_message`, `followup_task`, `interrupt_agent`, or
`list_agents` is V2.

V1 guidance is proactive text only at `max` or `ultra`. V2 receives a proxy-authored developer
message only when a preferred model, eligible roster, or fallback chain exists. Built-in V2 guidance
includes every accepted eligible roster annotation; it has no aggregate character budget. Guidance
is deduplicated across replay prefixes and inserted before a trailing `compaction_trigger`.

`injectionModel` and `injectionEffort` are advisory unless native-default sync is enabled. The built-in
V2 text treats the featured roster as suggestions, allows a known exact compatible catalog ID to be
passed to native `spawn_agent`, and asks Codex to pass supported model/effort overrides with
`fork_turns: "none"`. A custom `injectionPrompt` substitutes missing values with an empty string and
replaces that built-in exact-ID wording.

Each roster row may also carry optional `guidance`. This is untrusted operator text for the live
delegation message, not a policy control: it cannot set effort, quotas, roles, or fallback behavior.
After normalization (NFC plus trim), empty text is omitted; nonempty text is limited to 160 Unicode
code points and sanitized before persistence. Row guidance is considered only on eligible V2 turns,
after live picker, route, surface, and encrypted-task compatibility filters. Every accepted annotation
that survives those filters is included in built-in V2 guidance. It is not injected on V1 and is
never copied into the managed skill or global `AGENTS.md` block.

## Managed advisory setup

**Codex delegation setup** in the Agent Command Center is not a `config.json` field. It manages only:

```text
$HOME/.agents/skills/codexcommander-delegation/SKILL.md
$CODEX_HOME/AGENTS.md
```

The user skill proves CodexCommander ownership through `name: codexcommander-delegation` plus
`metadata.managed-by: codexcommander` and `metadata.managed-version: "1"`. The global policy owns only
the whole-line region from `<!-- BEGIN CODEXCOMMANDER DELEGATION -->` through
`<!-- END CODEXCOMMANDER DELEGATION -->`. There is no hash, manifest, or hidden ownership file for
this setup.

The skill and global block are advisory and contain no roster or model ids. They consult the current
collaboration tool contract and live CodexCommander guidance. Featured models are suggestions, not an
exhaustive allowlist; a known exact compatible catalog ID may be passed to native `spawn_agent`.
The global block records the
selected `balanced` or `orchestrator` mode and is loaded once per Codex run. Start a new task after
install, update, mode change, repair, or removal; current tasks are not reloaded. User and repository
instructions can prohibit delegation. A nonempty `$CODEX_HOME/AGENTS.override.md` shadows the managed
global block, while an empty override does not.

The managed wait lifecycle treats `wait_agent` timeout as a neutral subscription result, not child
failure evidence. After one `list_agents` reconciliation, a coordinator should do useful local work or
wait another 5–10 minutes while the child remains running. Timeout alone—including silence after a
checkpoint or conclude request—never authorizes `interrupt_agent`. Interruption requires explicit
user cancellation, a confirmed error or blocked state, a hard deadline communicated to the child in
advance, or deliberate replacement after available work is preserved. A bounded high-stakes gate can
prospectively request one checkpoint or durable partial artifact; conclude delivery remains advisory
and occurs at a model or tool boundary.

Uninstall removes only the owned `SKILL.md`, removes its directory only when empty, and removes only
the bounded global block while preserving every other `AGENTS.md` byte. This setup never mutates
`config.toml`, `subagentDeveloperInstructions`, native `[agents]` defaults, roster injection, or the
catalog, and it does not restart workers or replace the proxy. Those remain separate from the
`/api/codex-delegation` resource.

The canonical skill source flows through the renderer into API previews and the atomic installer and
packaging outputs. Use those managed paths rather than manually editing `~/.agents` or generated
`dist` files.

## Native Codex default sync

When enabled, `syncCodexSubagentDefaults` writes marker-owned
`[agents] default_subagent_model` and `default_subagent_reasoning_effort` fields from
`injectionModel` and `injectionEffort` only. Existing unmarked
user-owned target fields are treated as conflicts and remain authoritative; partial or ambiguous TOML
writes fail closed. Clearing `injectionModel` also clears the opt-in. These defaults affect newly
created Codex tasks and do not cause delegation by themselves.

## Fallback chain

Spawned-child fallback order is:

1. the requested primary model;
2. role-level `model_fallback` from `$CODEX_HOME/agents/*.toml`; then
3. global `subagentModelFallback` entries.

CodexCommander skips disabled, unroutable, unhealthy, cooling-down, or quota-threshold candidates. The
availability snapshot is cached for `subagentModelFallbackPollMs`. Under encrypted delivery, child tasks can restrict
the chain to canonical native ChatGPT targets; if none can read the encrypted payload, the request
fails instead of routing unreadable ciphertext elsewhere. A recognized plaintext-compatibility
session uses the ordinary heterogeneous chain while preserving V2 lifecycle semantics.

```json
{
  "multiAgentMode": "v2",
  "multiAgentV2MessageDelivery": "plaintext",
  "subagentModels": [
    { "model": "gpt-5.5" },
    { "model": "anthropic/claude-sonnet-5", "guidance": "Use for short research tasks." }
  ],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## Effort caps

Caps apply only to the V2 collaboration feature: a main turn qualifies when its tools expose V2,
while a child qualifies when it carries exact codex-rs `x-openai-subagent: collab_spawn` or
`"subagent_kind": "thread_spawn"` markers in `x-codex-turn-metadata`, even
if leaf tools no longer expose collaboration. V1 main turns, `multiAgentMode: "v1"`, compaction,
review, and memory-consolidation turns bypass caps.

Caps only lower effort. They snap to the highest advertised rung at or below the cap. If a model has
no effort control or no supported rung fits, CodexCommander removes the effort and lets the provider default
apply. `max` and `ultra` are accepted, while the dashboard offers `low` through `xhigh`.

For a beginner-oriented explanation of V1, default, and V2 behavior, see
[Sub-agent surfaces](/guides/sub-agent-surface/).

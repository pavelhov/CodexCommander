---
title: Sub-agent Surface (v1 / base / v2)
description: Control how Codex spawns and manages sub-agents across all models.
---

## What sub-agents are

A sub-agent is a separate Codex worker that the main agent can create for a focused task. It has its
own context and tools, so several independent tasks can run in parallel. opencodex controls which
Codex collaboration surface exposes those workers, which models Codex offers for them, and how a
failed model can fall back. It does not decide when your main agent must delegate.

## Modes

Choose the mode for **new sessions**. Existing sessions keep the surface they started with.

| Mode | What Codex gets | Who should pick it |
| --- | --- | --- |
| **v1** | Classic namespaced `spawn_agent`, `send_input`, `resume_agent`, and `close_agent` tools. A spawn can select another model directly. | Beginners who need reliable delegation across different providers, especially native-to-routed children. |
| **base** (default; **Follow Codex defaults** in the GUI) | Upstream model pins: GPT-5.6 Sol/Terra use v2, Luna uses v1, and unpinned models follow Codex's `multi_agent_v2` feature flag. | Most users. It follows Codex's intended surface for each model without forcing one globally. |
| **v2** | Flat `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`, and agent-list tools, with concurrent sessions. | Users who want the newer concurrent workflow. Mixed-provider parents must also choose the plaintext compatibility delivery policy described below. |

:::tip[Not sure?]
Start with **base**. Choose **v1** for the established cross-provider path. Force **v2** only when
you specifically want its newer session model; enable plaintext compatibility when that V2 parent
must delegate to Kimi, Grok, DeepSeek, or another external provider.
:::

## How it works

The selected mode controls the `multi_agent_version` field in every catalog entry Codex reads:

- **v1** stamps `multi_agent_version = "v1"` on every model.
- **base** restores upstream pins. Unpinned entries follow the native `multi_agent_v2` feature flag.
- **v2** stamps `multi_agent_version = "v2"` on every model.

opencodex applies this as the final pass to both the live `/v1/models` catalog and the catalog synced
to disk. That is why a mode change affects newly created App, CLI, and TUI sessions consistently.

For a v2 roster, eligibility has three states: an entry stamped `"v2"`, explicitly set to `null`, or
with no `multi_agent_version` field is eligible. A genuine `"v1"` pin is excluded because it states
that the model belongs to the other collaboration surface.

## Delegation model and effort

The dashboard's **Sub-agent delegation** controls three related settings:

- `injectionModel` is the preferred worker model named in opencodex guidance.
- `injectionEffort` is the optional `reasoning_effort` to request for that model.
- `injectionPrompt` replaces the built-in v2 guidance text.

`multiAgentGuidanceEnabled` defaults to on and is the master switch for opencodex-authored guidance
on both surfaces. Turning it off suppresses both the v2 designation block and v1 proactive text.

These are instructions to the main agent, not a proxy-side spawn router. On v2, a full-history fork
inherits the parent model and rejects model or effort overrides. Guidance therefore tells Codex to
use `fork_turns: "none"` (or a positive partial turn count such as `"3"`) when passing `model` or
`reasoning_effort`, and to make the task message self-contained.

Custom `injectionPrompt` text can use all four placeholders:

| Placeholder | Replaced with |
| --- | --- |
| `{{model}}` | The effective preferred model for this request. A bare native `injectionModel` is account-qualified only when the request itself targets an explicit account selector. An unresolved or ambiguous bare value becomes an empty string; an unresolved explicit account-qualified or routed id remains unchanged |
| `{{effort}}` | The configured `injectionEffort`, or an empty string |
| `{{roster}}` | The resolved picker-visible, surface-compatible roster |
| `{{fallback}}` | The configured global fallback guidance |

The built-in v2 guidance has a 700-character budget. If it would exceed the budget, opencodex drops
the roster first rather than truncating the core spawn instructions. Built-in guidance fires only
when a preferred model, eligible roster, or fallback chain resolves. A configured `injectionModel`
is sufficient to render a custom prompt; if a bare value cannot resolve uniquely, `{{model}}`
expands to an empty string.

On v1, opencodex injects only the upstream-style proactive delegation guidance at `max` or `ultra`
effort. It does not add a preferred model, roster, fallback list, or custom prompt on v1.

The default-off `syncCodexSubagentDefaults` option is separate from guidance. When opencodex owns
active Codex routing, sync or restart can write the selected values as marker-owned
`[agents] default_subagent_model` and `default_subagent_reasoning_effort` entries in Codex TOML.
opencodex updates or removes only fields bearing its markers. If either target field is user-owned,
the pair is left unchanged rather than partially written; ambiguous TOML is rejected without a
write. External provider managers and user-owned root routing also remain authoritative.

## Fallback chains

For a spawned worker, opencodex builds this priority order:

1. The requested primary model.
2. The role's `model_fallback` list from its `$CODEX_HOME/agents/*.toml` definition.
3. The global `subagentModelFallback` list in opencodex config.

Duplicate model ids are removed while preserving the first occurrence. During selection, opencodex
skips candidates that are disabled, unroutable, backed by a disabled provider, marked unhealthy,
inside a cooldown, missing a usable pooled Codex account, or beyond the configured quota threshold.
Availability probes are cached for `subagentModelFallbackPollMs` (60 seconds by default).

Fallback does not make incompatible encrypted tasks readable. Under the default encrypted policy,
selection is restricted to canonical native ChatGPT targets even if an external model appears
earlier in the chain. A successfully negotiated plaintext-compatibility V2 session can use the
normal heterogeneous fallback chain.

## V2 task delivery

Codex may send a v2 native-to-routed child task only as backend-encrypted `encrypted_content`. That
payload can be read by the native ChatGPT backend, but not by an external provider. This is the
known [#92 limitation](https://github.com/lidge-jun/opencodex/issues/92).

opencodex fails safely instead of forwarding an empty or unreadable task:

- A direct non-native route returns HTTP 400 with
  `error.code = "unreadable_encrypted_agent_task"` and does not echo the ciphertext.
- A combo considers only canonical native ChatGPT targets for that task, including retries. If none
  is available, it returns the same 400 error.
- A readable plaintext task keeps the normal route and fallback behavior.

`multiAgentV2MessageDelivery` controls the V2 parent wire policy:

| Policy | Behavior |
| --- | --- |
| `"encrypted"` (default) | Preserves ChatGPT's reserved encrypted collaboration schema and the fail-closed behavior above. Use native ChatGPT workers or v1 for external workers. |
| `"plaintext"` | Experimental mixed-provider V2 compatibility. For ChatGPT parents, OpenCodex presents a non-reserved plaintext collaboration namespace and restores the canonical namespace on the client-facing response. For routed parents, it marks only completed V2 message calls as plaintext. Both paths activate Codex's plaintext V2 handler, while its graph, mailbox, wait, follow-up, and completion lifecycle remain native. |

The plaintext decision is made when the parent tool schema is created, before the worker model is
known. Consequently **every** V2 `spawn_agent`, `send_message`, and `followup_task` message from that
parent is plaintext, including messages to native ChatGPT workers. OpenCodex suppresses those
arguments from usage-debug body samples, but the trusted local Codex runtime and proxy necessarily
handle the plaintext to deliver it.

For a canonical ChatGPT parent, plaintext compatibility activates only with the complete recognized
V2 schema. For a routed parent, OpenCodex marks only the exact `collaboration` message calls listed
above; lifecycle and unrelated tools remain untouched. A partial, changed, malformed, or colliding
native schema is not guessed: OpenCodex leaves it untouched and retains the encrypted fail-closed
guard. Delivery changes affect subsequent requests, so start a new session after saving instead of
switching an active conversation in place.

## Changing the mode

### GUI

- **Dashboard** → first stat cell: choose **v1**, **base**, or **v2**.
- **Models** → **Current behavior** → **Collaboration**: choose **Classic v1**, **Follow Codex defaults** (base), or **Concurrent v2**.
- **Subagents** → **Agent Command Center**:
  - **Active Roster** chooses and orders the five model overrides advertised first to `spawn_agent`.
    Drag rows, use the arrow buttons, or press <kbd>Alt</kbd> + <kbd>↑</kbd>/<kbd>↓</kbd>.
  - **Agent Library** searches the current model catalog and filters factual capabilities such as
    reasoning, long context, vision, and tool support. Entries remain addressable by exact id when
    their route is available, including models outside the five-slot roster.
  - **Run Policy** stages the agent protocol, V2 message-delivery policy, preferred guidance model and effort, ordered global
    child fallback chain, health recheck interval, thread limit, sub-agent effort ceiling, roster
    guidance, and native Codex-default sync. Save policy changes separately from roster changes.

Leaving **Thread limit** blank restores the Codex default. V2 counts total threads including the root;
V1 counts child threads. Protocol and thread-limit changes apply to new sessions; guidance and
fallback apply to future spawned child turns. The page reports when a running Codex app-server still
has a stale catalog.

### CLI

Use `ocx v2` for the collaboration surface and native feature settings:

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 mode v2
ocx v2 threads 8
```

Use `ocx agent` for delegation, roster, effort-cap, and fallback settings:

```bash
ocx agent status
ocx agent injection set --model anthropic/claude-sonnet-5 --effort xhigh
ocx agent subagents set gpt-5.6-sol,anthropic/claude-sonnet-5
ocx agent fallback set gpt-5.4-mini,xai/grok-4.5 --poll-ms 60000
ocx agent effort set --subagent max
```

Pass `-` to clear a nullable `ocx agent injection` value, or use the relevant `clear` action for a
roster or fallback list. See the [CLI reference](/reference/cli/) for all command families.

### API

The management API exposes matching `GET` and `PUT` endpoints:

| Endpoint | Manages |
| --- | --- |
| `/api/v2` | Surface mode, V2 message delivery, native feature flag, and thread settings |
| `/api/injection-model` | Preferred model, effort, custom prompt, guidance, and native-default sync |
| `/api/effort-caps` | Main-agent and sub-agent effort ceilings |
| `/api/subagent-models` | Ordered roster of up to five models |
| `/api/subagent-model-fallback` | Global fallback order and poll interval |

Sending `multiAgentV2MessageDelivery: "encrypted"` or `null` to `PUT /api/v2` removes the explicit
override and restores the encrypted default.

For example:

```bash
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode":"v2","multiAgentV2MessageDelivery":"plaintext"}'

curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-5","effort":"xhigh"}'
```

## FAQ

### Does choosing a delegation model force Codex to spawn it?

No. Guidance can recommend a model, and native-default sync can provide a Codex default, but the
main agent still decides whether to delegate.

### Why did my v2 child use the parent model?

A full-history v2 fork inherits the parent model. Use a spawn that sets `fork_turns` to `"none"` or
a positive partial count before passing a model or effort override.

### Why is a configured model missing from the v2 roster?

It may be picker-hidden, outside the five-model display limit, missing from the catalog, or pinned
to v1. A `"v2"`, `null`, or absent surface value is eligible; a real `"v1"` pin is not.

### Do mode changes affect running sessions?

No. Start a new Codex session after changing the mode. If a long-running App host still shows stale
catalog state, run `ocx sync` and restart that Codex surface.

### Can Sol V2 delegate to Kimi, Grok, or DeepSeek?

Yes, with **V2 message delivery → Plaintext compatibility** and a fresh session. The policy keeps
the V2 lifecycle but makes that parent's delegated messages plaintext. Leave delivery encrypted for
the native-only confidentiality contract, or use Classic v1 for the older cross-provider surface.

### Reasoning effort

`injectionEffort` affects only delegated-worker guidance and, when explicitly enabled, native Codex
sub-agent defaults. It does not change the parent session's effort. `ultra` is a client-facing top
tier that Codex converts to `max`; opencodex then maps or clamps the value for the selected provider.

### Context cap

The model context cap is independent of sub-agent mode. Configure it under **Models** → **Current
behavior** → **Context**. **Uncapped** means no routed provider has an artificial cap; **Limited**
means all routed providers use the shared value; **Mixed limits** reports per-provider differences.
Native OpenAI models retain their real context windows.

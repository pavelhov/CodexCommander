---
title: Sub-agent Surface (V1 / base / V2)
description: Control how Codex spawns and manages sub-agents across all models.
---

## What sub-agents are

A sub-agent is a separate Codex worker that the main agent can create for a focused task. It has its
own context and tools, so several independent tasks can run in parallel. CodexCommander controls which
Codex collaboration surface exposes those workers, which models Codex offers for them, and how a
failed model can fall back. It does not decide when your main agent must delegate.

## Modes

Choose the mode for **new sessions**. Existing sessions keep the surface they started with.

| Mode | What Codex gets | Who should pick it |
| --- | --- | --- |
| **V1** | Classic namespaced `spawn_agent`, `send_input`, `resume_agent`, and `close_agent` tools. A spawn can select another model directly. | Beginners who need reliable delegation across different providers, especially native-to-routed children. |
| **base** (default; **Codex native** in the GUI) | Upstream model pins: GPT-5.6 Sol/Terra use V2, Luna uses V1, and unpinned models follow Codex's `multi_agent_v2` feature flag. | Most users. It follows Codex's intended surface for each model without forcing one globally. |
| **V2** | Flat `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`, and agent-list tools, with concurrent sessions. | Users who want the newer concurrent workflow. Mixed-provider parents must also choose the plaintext compatibility delivery policy described below. |

:::tip[Not sure?]
Start with **base**. Choose **V1** for the established cross-provider path. Force **V2** only when
you specifically want its newer session model; enable plaintext compatibility when that V2 parent
must delegate to Kimi, Grok, DeepSeek, or another external provider.
:::

## How it works

The selected mode controls the `multi_agent_version` field in every catalog entry Codex reads:

- **v1** stamps `multi_agent_version = "v1"` on every model.
- **base** restores upstream pins. Unpinned entries follow the native `multi_agent_v2` feature flag.
- **v2** stamps `multi_agent_version = "v2"` on every model.

CodexCommander applies this as the final pass to both the live `/v1/models` catalog and the catalog synced
to disk. That is why a mode change affects newly created App, CLI, and TUI sessions consistently.

### A mode is not a worker reload

Changing to **V2** makes Luna *eligible for the V2 collaboration surface* because the generated
catalog stamps it as V2. It does not, by itself, make Luna (or any other model) available to a
currently running Codex worker. For a model to be usable by `spawn_agent`, all of these must hold:

1. It is selected, surface-compatible, picker-visible, and inside the five-model advertised window.
2. The deterministic CodexCommander catalog containing it has been written to disk.
3. The current Codex app-server has loaded that catalog (not an older in-memory copy).
4. Its proxy route is enabled and can actually serve the request.

This separation is deliberate: protocol selection controls catalog semantics; catalog activation
controls what an already-running Codex worker has loaded. In particular, opening a **new task** or
forking a task does **not** reload an existing app-server's model catalog.

For a V2 roster, eligibility has three states: an entry stamped `"v2"`, explicitly set to `null`, or
with no `multi_agent_version` field is eligible. A genuine `"v1"` pin is excluded because it states
that the model belongs to the other collaboration surface.

## Delegation model and effort

The dashboard's **Sub-agent delegation** controls three related settings:

- `injectionModel` is the preferred worker model named in CodexCommander guidance.
- `injectionEffort` is the optional `reasoning_effort` to request for that model.
- `injectionPrompt` replaces the built-in V2 guidance text.

`multiAgentGuidanceEnabled` defaults to on and is the master switch for CodexCommander-authored guidance
on both surfaces. Turning it off suppresses both the V2 designation block and V1 proactive text.

These are instructions to the main agent, not a proxy-side spawn router. On V2, a full-history fork
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

The built-in V2 guidance has a 700-character budget. If it would exceed the budget, CodexCommander drops
the roster first rather than truncating the core spawn instructions. Built-in guidance fires only
when a preferred model, eligible roster, or fallback chain resolves. A configured `injectionModel`
is sufficient to render a custom prompt; if a bare value cannot resolve uniquely, `{{model}}`
expands to an empty string.

On V1, CodexCommander injects only the upstream-style proactive delegation guidance at `max` or `ultra`
effort. It does not add a preferred model, roster, fallback list, or custom prompt on V1.

The default-off `syncCodexSubagentDefaults` option is separate from guidance. When CodexCommander owns
active Codex routing, sync or restart can write the selected values as marker-owned
`[agents] default_subagent_model` and `default_subagent_reasoning_effort` entries in Codex TOML.
CodexCommander updates or removes only fields bearing its markers. If either target field is user-owned,
the pair is left unchanged rather than partially written; ambiguous TOML is rejected without a
write. External provider managers and user-owned root routing also remain authoritative.

## Fallback chains

For a spawned worker, CodexCommander builds this priority order:

1. The requested primary model.
2. The role's `model_fallback` list from its `$CODEX_HOME/agents/*.toml` definition.
3. The global `subagentModelFallback` list in CodexCommander config.

Duplicate model ids are removed while preserving the first occurrence. During selection, CodexCommander
skips candidates that are disabled, unroutable, backed by a disabled provider, marked unhealthy,
inside a cooldown, missing a usable pooled Codex account, or beyond the configured quota threshold.
Availability probes are cached for `subagentModelFallbackPollMs` (60 seconds by default).

Fallback does not make incompatible encrypted tasks readable. Under the default encrypted policy,
selection is restricted to canonical native ChatGPT targets even if an external model appears
earlier in the chain. A successfully negotiated plaintext-compatibility V2 session can use the
normal heterogeneous fallback chain.

## V2 task delivery

Codex may send a V2 native-to-routed child task only as backend-encrypted `encrypted_content`. That
payload can be read by the native ChatGPT backend, but not by an external provider. This is the
known [#92 limitation](https://github.com/pavelhov/CodexCommander/issues/92).

CodexCommander fails safely instead of forwarding an empty or unreadable task:

- A direct non-native route returns HTTP 400 with
  `error.code = "unreadable_encrypted_agent_task"` and does not echo the ciphertext.
- A combo considers only canonical native ChatGPT targets for that task, including retries. If none
  is available, it returns the same 400 error.
- A readable plaintext task keeps the normal route and fallback behavior.

`multiAgentV2MessageDelivery` controls the V2 parent wire policy:

| Policy | Behavior |
| --- | --- |
| `"encrypted"` (default) | Preserves ChatGPT's reserved encrypted collaboration schema and the fail-closed behavior above. Use native ChatGPT workers or V1 for external workers. |
| `"plaintext"` | Experimental mixed-provider V2 compatibility. It changes only V2 **task-message delivery** so a routed provider can read the delegated task; it is not a general key or credential setting. For ChatGPT parents, CodexCommander presents a non-reserved plaintext collaboration namespace and restores the canonical namespace on the client-facing response. For routed parents, it marks only completed V2 message calls as plaintext. Both paths activate Codex's plaintext V2 handler, while its graph, mailbox, wait, follow-up, and completion lifecycle remain native. |

The plaintext decision is made when the parent tool schema is created, before the worker model is
known. Consequently **every** V2 `spawn_agent`, `send_message`, and `followup_task` message from that
parent is plaintext, including messages to native ChatGPT workers. CodexCommander suppresses those
arguments from usage-debug body samples, but the trusted local Codex runtime and proxy necessarily
handle the plaintext to deliver it.

For a canonical ChatGPT parent, plaintext compatibility activates only with the complete recognized
V2 schema. For a routed parent, CodexCommander marks only the exact `collaboration` message calls listed
above; lifecycle and unrelated tools remain untouched. A partial, changed, malformed, or colliding
native schema is not guessed: CodexCommander leaves it untouched and retains the encrypted fail-closed
guard. Delivery changes affect subsequent requests, so start a new session after saving instead of
switching an active conversation in place.

## Changing the mode

### GUI

- **Dashboard** → first stat cell: choose **V1**, **base**, or **V2**.
- **Models** → **Current behavior** → **Collaboration**: choose **Reliable V1**, **Codex native** (base/default semantics), or **Concurrent V2**.
- **Subagents** → **Agent Command Center**:
  - **Configured Roster** chooses and orders the five model overrides advertised first to `spawn_agent`.
    Drag rows, use the arrow buttons, or press <kbd>Alt</kbd> + <kbd>↑</kbd>/<kbd>↓</kbd>. The card
    shows your configured quick picks: a row's status line (for example **V1 under Codex defaults** or
    **Routed · V2 compatible**) indicates which collaboration surfaces can select it, while rows
    without a status line are available on both.
  - **Agent Library** searches the current model catalog and filters factual capabilities such as
    reasoning, long context, vision, and tool support. Entries remain addressable by exact id when
    their route is available, including models outside the five-slot roster.
  - **Run Policy** stages the agent protocol, V2 message-delivery policy, preferred guidance model and effort, ordered global
    child fallback chain, health recheck interval, thread limit, sub-agent effort ceiling, roster
    guidance, and native Codex-default sync. Save policy changes separately from roster changes.

Leaving **Thread limit** blank restores the Codex default. V2 counts total threads including the root;
V1 counts child threads. A protocol or thread-limit change updates managed boot configuration: use
the catalog status to choose the reload path. When the catalog and managed routing are current but the
worker is stale, quit ChatGPT completely, reopen it, and start a new task for the session-bound tool
shape. If the catalog is pending/unknown or routing is not injected, use **Apply to Codex** to reconcile
them first; restarting ChatGPT alone is not that repair. Guidance and fallback apply to future spawned
child turns. A V2 delivery-only change needs a new task but does not dirty the catalog or require Apply.

### CLI

Use `ccx v2` for the collaboration surface and native feature settings:

```bash
ccx v2 status
ccx v2 mode v1
ccx v2 mode default
ccx v2 mode v2
ccx v2 threads 8
```

Use `ccx agent` for delegation, roster, effort-cap, and fallback settings:

```bash
ccx agent status
ccx agent injection set --model anthropic/claude-sonnet-5 --effort xhigh
ccx agent subagents set gpt-5.6-sol,anthropic/claude-sonnet-5
ccx agent fallback set gpt-5.4-mini,xai/grok-4.5 --poll-ms 60000
ccx agent effort set --subagent max
```

Pass `-` to clear a nullable `ccx agent injection` value, or use the relevant `clear` action for a
roster or fallback list. See the [CLI reference](/reference/cli/) for all command families.

### API

The management API exposes matching `GET` and `PUT` endpoints:

| Endpoint | Manages |
| --- | --- |
| `/api/v2` | Surface mode, V2 message delivery, native feature flag, and thread settings |
| `/api/injection-model` | Preferred model, effort, custom prompt, guidance, and native-default sync |
| `/api/effort-caps` | Main-agent and sub-agent effort ceilings |
| `/api/subagent-models` | Ordered roster of up to five models; saving it is non-disruptive and also reports catalog activation state |
| `/api/subagent-model-fallback` | Global fallback order and poll interval |
| `/api/codex-catalog/status` | Read desired configuration, deterministic on-disk catalog evidence, and current-worker activation evidence |
| `/api/codex-catalog/apply` | Guarded reconciliation for a pending catalog or uninjected managed route, followed when necessary by a confirmed force-restart of verified stale workers. For an already-converged stale worker this is an advanced fallback that may make ChatGPT show **stopped unexpectedly**; browser use requires a confirmed `ccx gui` or menu-app launch |

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

### Why did my V2 child use the parent model?

A full-history V2 fork inherits the parent model. Use a spawn that sets `fork_turns` to `"none"` or
a positive partial count before passing a model or effort override.

### Why is a configured model missing from the V2 roster?

It may be picker-hidden, outside the five-model display limit, missing from the catalog, or pinned
to V1. A `"v2"`, `null`, or absent surface value is eligible; a real `"v1"` pin is not.

### Does V2 make Luna available immediately?

No. Forced V2 removes Luna's upstream V1 surface pin, so it can be eligible for the V2 roster. It
still needs to be selected and advertised, written into the catalog, loaded by the current Codex
worker, and routable through the proxy. Use the dashboard's catalog status to see which condition
is pending. If the catalog and routing are current and only the worker is stale, quit ChatGPT
completely, reopen it, and start a new task. If the catalog is pending or routing is not injected,
use **Apply to Codex** for reconciliation first.

### Do mode changes affect running sessions?

No. Start a new Codex session after changing the mode. That controls the collaboration protocol but
does not reload an already-running App host's model catalog. Save writes desired configuration and
converges the on-disk catalog without interrupting work. When the catalog and managed routing are
current but the worker is stale, quit ChatGPT completely, reopen it, and then start the new task. The
guarded **Force-restart workers** action and `ccx sync --restart-codex` remain advanced fallbacks and may
make ChatGPT show **stopped unexpectedly**. A pending catalog or uninjected managed route still needs
**Apply to Codex** reconciliation first. There is intentionally no auto-apply, idle queue, or persisted
“pending” snapshot to manage.

### Can Sol V2 delegate to Kimi, Grok, or DeepSeek?

Yes, with **V2 message delivery → Plaintext compatibility** and a fresh session. The policy keeps
the V2 lifecycle but makes that parent's delegated messages plaintext. Leave delivery encrypted for
the native-only confidentiality contract, or use Reliable V1 for the established cross-provider surface.

### Reasoning effort

`injectionEffort` affects only delegated-worker guidance and, when explicitly enabled, native Codex
sub-agent defaults. It does not change the parent session's effort. `ultra` is a client-facing top
tier that Codex converts to `max`; CodexCommander then maps or clamps the value for the selected provider.

### Context cap

The model context cap is independent of sub-agent mode. Configure it under **Models** → **Current
behavior** → **Context**. **Uncapped** means no routed provider has an artificial cap; **Limited**
means all routed providers use the shared value; **Mixed limits** reports per-provider differences.
Native OpenAI models retain their real context windows.

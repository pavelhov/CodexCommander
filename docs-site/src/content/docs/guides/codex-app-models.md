---
title: Codex App model picker
description: How CodexCommander models appear in Codex App, Codex CLI, and Codex TUI through the shared Codex catalog.
---

CodexCommander does not patch Codex App. It writes the same Codex configuration and model catalog that
Codex CLI/TUI use. The app-server reads that shared state, but some Codex Desktop releases apply a
second remote model allowlist in the renderer and can still remove routed rows from the picker.

OpenAI entries use two credential routes: native Codex login and the namespaced
`openai-apikey/<model>` API-key transport. Changing `codexAccountMode` between Pool and Direct by
itself does not change picker ids. When `codexAccountNamespaces` has eligible selectors whose
mapped accounts still exist, however,
CodexCommander adds separate `<selector>/<native-openai-model>` rows for the mapped accounts and hides
the bare native rows from the Codex picker. Selector labels are user-chosen public names with no
built-in account-role meaning. Selecting a qualified row uses only its mapped account, does not
change the active Pool account, and fails closed instead of switching accounts when the target is
unavailable. See [Exact Codex account selectors](/reference/configuration/routing/#exact-codex-account-selectors).
API GPT-5.6 entries use
1,050,000 context / 922,000 max input, and `*-pro` picker ids resolve to the base wire model with
`reasoning.mode: "pro"` while logs, usage, and picker state keep the virtual id.
The API catalog is fixed to exactly eight ids: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, and their
three Pro virtual ids; there is no generic `gpt-5.6-pro` alias.
Compact requests keep the selected tier but send the base model without a reasoning object.

Select the credential route represented by the picker id. Change Pool/Direct on the Providers page;
`<selector>` below is a user-chosen public label mapped through `codexAccountNamespaces`:

```text
gpt-5.6-sol                         # bare Codex-login route via Pool or Direct
<selector>/gpt-5.6-sol              # stored Codex account mapped by that selector
openai-apikey/gpt-5.6-sol           # API key
```

Fresh installs and configs with no saved mode default to Pool.

## Continuing after a model change

When you switch from a routed model back to OpenAI, the next request uses the newly selected
model and reasoning effort. For requests with `store: false`, Commander removes lookup IDs
from unencrypted reasoning summaries carried over in the conversation. This prevents OpenAI
from trying to retrieve a reasoning item that it never stored. The summaries, messages, and
tool-call results remain in the replayed history. Proxy-created reasoning envelopes receive
the same ID repair after their provider-specific payload is removed.

Native OpenAI encrypted history stays unchanged, including across account switches. This repair
does not guarantee that every backend accepts every prior model's encrypted history, and it does
not turn storage on or retry a rejected request. It applies to normal Responses requests,
the WebSocket-to-HTTP bridge, and native compaction.

## Desktop remote-allowlist limitation

If `codex debug models` and app-server `model/list` contain a routed model but Desktop does not show
it, see [OpenAI Codex issue #19694](https://github.com/openai/codex/issues/19694). With the remote
`use_hidden_models` policy active, Desktop can keep only ids in its native `available_models` list
and can even display native rows whose catalog visibility is `hide`. Catalog refreshes and proxy
restarts alone cannot change that renderer policy.

For an operationally equivalent routed model, CodexCommander provides an explicit, default-off
native-alias combo mode. It publishes an allowlisted bare slug with an honest custom display label
and routes that exact slug through the configured combo before canonical OpenAI routing. It also
omits disabled bare native rows from the effective catalog while compatibility aliases exist, so
Desktop cannot resurrect them by ignoring `visibility`. See
[Codex Desktop native-allowlist compatibility](/guides/combos/#codex-desktop-native-allowlist-compatibility)
for the command, disable-key semantics, and safety constraints.

## Integration path

In the Mac app, use the dashboard's account setup and **Subagents → Apply to Codex** controls.
The app bundles its runtime; normal Commander setup does not require a separate Bun or Commander CLI installation.
Provider-specific dependencies still apply, such as Kiro's CLI and a running service for local models.

For terminal users, `ccx start` and `ccx sync` wire the shared Codex config and catalog into the proxy. `ccx init` can do
so only through an already-running, protected-runtime-proven proxy; otherwise Codex stays native until
explicit Start. See [Codex Integration](/guides/codex-integration/) for config injection, catalog
sync, shims, WebSocket fallback, and restore mechanics.

## Comparing usage with native Codex

Compare the same client version, account, model, reasoning effort, service tier, prompts, and
tool availability. Use fresh conversations and keep other work off the measured account during
the comparison. Orchestration guidance, different tools, and delegated agents can change the
work performed and its token use; matching the model name alone does not make runs comparable.

The repository's offline inference fixtures count physical upstream sends and inspect protocol
changes against local mock servers. Their token values are synthetic. A passing fixture does
not establish OpenAI billing parity or encrypted-history portability between accounts.
The HTTP comparison uses an isolated custom-provider client profile; Desktop's native default
transport and upstream authentication require separate verification.

`bun scripts/inference-pilot-dry-run.ts --manifest <local-manifest.json>` exercises a six-start,
single-concurrency reservation against loopback mock servers. It refuses invalid qualification,
missing rate evidence, unexpected retries, and unknown usage. This command never launches a live
pilot and reports live admission as unavailable: its manifest identity is supplied fixture data,
not an attestation of the running client. A real pilot needs verified current subscription-credit
rates, a fixed account and build, and enforcement around every physical send in both arms.
Credit reservations are estimates; an in-flight request can exceed its estimated token allowance.

The separate developer command `bun scripts/inference-pilot-launcher.ts --offline` runs the
installed macOS Codex client six times against local fixtures: three direct runs and three through
the full Commander HTTP ingress. Both arms use GPT-5.6 Luna with low reasoning effort, the same
forwarding relay and bundled model catalog. The backend must still accept that model for the account;
a rejected response stops the pilot and reports its HTTP status without retrying.
The launcher uses disposable profiles and an operating-system network restriction; it does not
activate the Mac app or modify an existing Codex profile. Unsupported hosts report `UNAVAILABLE`.

The relay allows at most six physical requests, one at a time. It rejects redirects, retries,
hosted tools, returned tool calls, incomplete responses, and missing token usage. It buffers a
bounded SSE response until completion, so this is a text-only HTTP instrumentation test, not a
streaming-latency or Desktop-default-transport comparison. The paired test order is direct/Commander,
Commander/direct, then direct/Commander;
six requests are too few to establish general spending parity.

Live execution is a separate, explicit `--execute-live` invocation with `--manifest`,
`--qualification`, `--credentials`, and `--rate-source` files. It checks the current client,
runtime, configuration and catalog against the offline receipt, and rechecks credential generation
and source identity before sending. Credentials must be in a private file owned by the current user;
the launcher never discovers credentials from an active account profile. Rate evidence is supplied
by the operator and is not independently authenticated as OpenAI billing data. No live execution
is performed by the offline command or normal Mac app startup.

## Why routed models show up

Codex's model picker expects Codex-shaped catalog entries. CodexCommander builds routed entries by cloning
a native Codex model template, then replacing the routed model identity:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

The clone keeps strict-parser fields such as reasoning levels, shell type, API support flags, and
base instructions. CodexCommander then removes native-only capabilities that the route cannot honor,
including OpenAI service-tier metadata.

## Current stable model coverage

The native fallback set includes `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.3-codex-spark`, and GPT-5.6 Sol/Terra/Luna. Matching installed Codex catalog entries are
authoritative for every native model. The pinned upstream snapshot supplies fallback metadata
when an installed entry is unavailable; template synthesis is the final fallback.

| Route | Picker ids and catalog metadata |
| --- | --- |
| Codex login (no eligible account selectors) | Bare native ids such as `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; Pool or Direct is selected through `codexAccountMode`. Native context, maximum context, and compaction fields follow the installed client catalog. |
| Codex login (eligible account selectors) | One `<selector>/<native-openai-model>` row per eligible selector and supported native model; each row uses only its mapped account, and bare native rows are hidden from the picker. Native metadata and context windows are preserved. |
| OpenAI (API key) | Exactly eight namespaced rows: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, and the three `*-pro` virtual ids (1,050,000 context; 922,000 max input for all eight) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` (1,050,000) |
| Cursor | Static fallback includes `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, and `cursor/gpt-5.6-luna` (1,000,000), plus `cursor/grok-4.5` and `cursor/grok-4.5-fast` (500,000); live account discovery decides which remain visible. |
| xAI | Live discovery is authoritative; the fallback catalog defaults to `xai/grok-4.5` with a 500,000-token window and `low` / `medium` / `high` reasoning controls. |

The pinned GPT-5.6 entries preserve the exact upstream ladder. Sol and Terra expose `low` through
`ultra`; Luna stops at `max`. Sol defaults to `low`, while Terra and Luna default to `medium`.
`ultra` is a client-facing choice for maximum reasoning plus proactive delegation and reaches the
backend as `max`. A picker entry only means the catalog is ready: the connected account or API key
must still be entitled to use that model.

## Native and routed model toggles

The dashboard Models page exposes `disabledModels` toggles for bare native ids and routed
`provider/model` ids. Account-qualified `<selector>/<native-openai-model>` ids are also supported by
`disabledModels`, but the dashboard does not list or toggle those exact selector rows; add them to
the configuration manually:

- Routed ids are namespaced (`provider/model`). Disabling one excludes it from the synced catalog
  and `/v1/models`.
- Account-qualified native ids use `<selector>/<native-openai-model>`. Adding one to
  `disabledModels` hides only that selector row.
- Native GPT ids are bare slugs. Disabling one keeps its catalog entry but changes `visibility` to
  `hide`, preserving the exact entry for a later re-enable; it hides the bare row and every
  selector-qualified clone for that model from discovery.
- With at least one native-alias combo configured, disabled bare native rows are omitted rather than
  retained hidden because affected Desktop releases ignore the hidden flag. A bare native slug
  shadowed by a native alias is also omitted from the Models page, so it has no native switch there;
  only unshadowed native rows remain switchable. Sync restores pristine native metadata when an
  unshadowed disabled row is re-enabled.
- Unshadowed native rows come from the supported static set, so a disabled unshadowed model stays
  visible in the dashboard and can be turned back on.

The visibility pass runs after snapshot upgrades, and the management API refreshes the catalog and
forces Codex's model cache stale after a toggle.

## Multi-agent surface mode

The Models page labels the three collaboration choices **Reliable V1**, **Codex native** (the
base/upstream behavior), and **Concurrent V2**. This control changes which Codex collaboration surface each picker
entry uses; see [Sub-agent Surface](/guides/sub-agent-surface/) for the canonical mode, delegation,
inheritance, fallback, and encrypted-task behavior.

## Reasoning top tiers

Native reasoning tiers follow the authoritative client catalog without invented `max` or `ultra` rungs. Routed compatibility entries retain their supported synthetic effort choices. Explicit V1/V2 surface selection remains separate.

Native fields that the source omits, including a compaction limit, stay absent. Account-qualified native rows inherit the same behavioral metadata. If installed source metadata is unavailable, fallback rows are identified as such. Native WebSocket capability is not advertised by the HTTP forwarding path; the translated WebSocket bridge remains available for external routes.

On the wire, routed adapters map or clamp unsupported tiers. For older native models whose real
ladder stops at `xhigh`, `nativeEffortClamp` maps a direct `max` or an `ultra` selection to `xhigh`
(for example, GPT-5.5). Sol, Terra, and Luna have a real `max` rung.

## Fast tier rules

Codex stores fast mode as:

```toml
service_tier = "fast"

[features]
fast_mode = true
```

But the model catalog and runtime request tier id use `priority`. CodexCommander preserves that split.
Native OpenAI passthrough models keep fast support; routed providers are capability-gated —
`service_tier` is stripped only when the provider declares `supportsServiceTier: false` (the registry
classifies canonical OpenAI as `true`, DeepSeek and Volcengine Ark as `false`), while unclassified
custom gateways keep caller-supplied values untouched and never get an injection. The fast option is
never advertised where it cannot be honored, and custom gateways can opt in explicitly with `true`.

## Subagent selection

Codex sorts picker-visible catalog entries by ascending `priority` and advertises the first five as
featured `spawn_agent` suggestions, not as an exhaustive allowlist. The dashboard's **Agent Command
Center** can select and save up to five bare native ids or routed `provider/model` ids. It also
preserves already-configured account-qualified `<selector>/<native-openai-model>` ids, reports
whether each saved choice is actually advertised, and assigns low catalog priorities in the selected
order. When account selectors are active, bare native selections expand into selector-qualified
groups. Other models remain callable by exact id when they are in the worker-loaded catalog and
compatible with the surface and task delivery.

The configured roster is separate from the Dashboard's **Sub-agent delegation** selection. It
controls which overrides Codex offers first; it does not select a model, trigger delegation, or
limit native `spawn_agent` to those five IDs.

## Refreshing model state

If the picker still shows stale entries, refresh the catalog and restart the target Codex surface:

```bash
ccx sync
```

CodexCommander rewrites `models_cache.json` with a deliberately stale cache wrapper whenever catalog
visibility, priority, or metadata changes, so the next Codex model refresh reads the new catalog.

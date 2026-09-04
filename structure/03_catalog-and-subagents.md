# Catalog And Subagents SOT

## Shared catalog

`src/codex/catalog.ts` builds a shared Codex-shaped catalog for CLI, TUI, App, and SDK. It:

- preserves native OpenAI entries from the installed Codex bundled catalog
  (`codex debug models --bundled`), including hidden rows when
  `nativeCatalogMode` is `bundled-all` (default), and still upgrades fallback-quality
  rows from the pinned upstream models.json snapshot
  (`src/codex/data/upstream-models.json` — exact per-slug ladders: luna has no ultra);
- clones a native template for routed `provider/model` entries;
- forces strict Codex catalog fields required by the current parser;
- hides `disabledModels` without blocking direct routing (routed provider ids are excluded;
  account-qualified native ids hide only that selector row; BARE native slugs hide the bare row
  and all account-selector clones and drop that model family from raw `/v1/models`);
- applies exact provider/model compatibility exclusions after live discovery and metadata
  augmentation, so upstream-advertised but uncallable rows never enter dashboard or Codex pickers;
- strips native-only service tier and WebSocket metadata unless explicitly enabled;
- backs up the pristine catalog once per catalog: the copy is keyed by a hash of the catalog path
  (`catalog-backup-<id>.json`), so a restore resolves the backup for the catalog it is restoring
  rather than assuming a single file;
- invalidates `$CODEX_HOME/models_cache.json` when model visibility changes.

Every successful live routed sync also writes a CodexCommander-owned, mode-600 last-known-good snapshot
at `$CODEXCOMMANDER_HOME/codex-routed-retained.json`. Stop/restore still removes routed rows from the
active Codex catalog so plain Codex works normally; it does not delete this CodexCommander snapshot. On
the next start, an empty provider gather rehydrates still-configured routed rows from the snapshot,
and a partial gather combines fresh providers with retained rows only for providers that returned no
models. Removed, disabled, forward-only, intentionally empty, model-filtered, and compatibility-
excluded rows are never resurrected. The snapshot participates in the retained-sync filesystem
evidence and is updated only when the current gather produced live routed rows.

On the default `codexcommander-catalog.json` path, sync deliberately uses two catalog sources: Codex's
bundled catalog supplies a current native entry template, while the actual on-disk catalog supplies
the rows being merged. This split is required because empty or partial provider discovery must
preserve routed entries and genuine user-native rows from the file that will be overwritten; a
bundled catalog never contains those rows.

Codex App model picker visibility comes from this shared catalog, not from patching the App.

Provider live-model lists are cached with a configured TTL (`src/codex/model-cache.ts`). Adding,
deleting, or editing a provider's shape clears that per-provider cache; a disabled-only change
deliberately does not, because a disabled provider is already excluded from the catalog gather
instead. Codex's own `models_cache.json` is a different cache, invalidated by catalog refresh.

## Startup readiness

Each `startServer` invocation owns a private, one-shot readiness gate created before the listener
binds. `handleStart` supplies its gate and transitions it after the shared catalog sync settles.
Calls without a supplied gate receive a fresh private gate that intentionally remains pending. Only
`ok: true` with no nonempty warning becomes ready; `null`, a throw, `ok !== true`, or a nonempty
warning becomes failed. State is isolated per server instance.

Exact unauthenticated `GET /readyz` returns sanitized identity fields plus pending, ready, or failed:
`200` for ready, or `503` with `Retry-After: 1` for pending and terminal failed. The full CLI syntax
is `ccx ready [--json] [--wait [--timeout <seconds>]]`. The probe validates the service, version,
uptime, PID, port, status, and HTTP/status pairing. The default is one probe. With `--wait`, it
applies one absolute deadline (45 seconds by default) across discovery, readiness probes, polling,
and sleeps, but exits immediately on terminal failed. `--timeout <seconds>` requires `--wait` and
accepts positive integer seconds from 1–300. CLI `--json` emits
`{ready, status, pid, port}`, with status in `ready|pending|failed|unreachable`. Exit 0 means ready;
exit 1 covers not-ready, pending, failed, timeout, and unreachable; exit 64 means invalid arguments.
`/healthz` remains the separate liveness contract.

Catalog convergence also reports `catalogQuality`: `live` means the active routed rows came from
the current provider gather, `retained` means at least one provider was recovered from durable or
already-active last-known-good rows, and `native-only` means no CodexCommander-authored routed rows are
active. `native-only` with an enabled routed-capable provider is an actionable sync warning, not a
fully-ready result. The macOS lifecycle waits for startup readiness, retries convergence through the
live management API, and automatically synchronizes the catalog on app launch. A worker roster that
predates the committed catalog is a nonfatal, persistent **Restart ChatGPT to load models** state; it
does not make CodexCommander appear stopped or unhealthy. **Show restart steps…** explains the default
reload boundary: quit ChatGPT completely, reopen it, and then start a new task. The companion does not
signal ChatGPT's background workers from this card.

Guarded Apply remains an advanced dashboard/API fallback. It performs another sync, reconciles managed
routing when needed, sends `SIGTERM` only to exact current-user `codex … app-server` and
`codex-code-mode-host` matches, verifies the old workers' exits, and leaves the CodexCommander proxy
running. Activity is warning context rather than an idle guarantee. Because this bypasses ChatGPT's
normal app lifecycle, ChatGPT may report that it **stopped unexpectedly**.

The CLI remains the advanced fallback:

```bash
ccx sync --restart-codex
```

## Catalog activation contract

There are three independently observable truths, in order: (1) the saved desired configuration,
(2) the authoritative CodexCommander catalog and managed Codex boot settings on disk, and (3) the
catalog that a running Codex app-server has loaded. Catalog publication also invalidates Codex's
separate `models_cache.json`, but that file is Codex-owned and may be refreshed immediately; its
post-publication bytes are therefore not durable activation truth. A successful Save or ordinary
sync converges only the first two truths and is deliberately non-disruptive. It must not claim that
an existing worker has reloaded merely because a new task or fork was created: those are not
catalog-reload boundaries for an already-running app-server.

`GET /api/codex-catalog/status` projects these three truths as additive management state; the
subagent-roster GET/PUT and ordinary sync response carry the same additive activation observation
for dashboard convenience. The activation DTO is an observation, not a durable receipt: there is no
persisted pending-update snapshot, auto-apply daemon, or idle queue. The retained routed-catalog
snapshot above serves provider-discovery recovery and is unrelated to worker activation.

`POST /api/codex-catalog/apply` is the sole browser Apply action and an advanced force-restart fallback.
It accepts only
`{ expectedDesiredRevision, confirmInterrupt: true }`, re-converges and proves the disk state, then
may signal only revalidated exact current-user Codex worker identities. It never accepts a PID,
command, or path from the caller. The expected desired revision fences configuration races;
unknown worker identity blocks signaling. In-flight proxy request activity is advisory context: it
warns about possible interruption but does not represent persistent Codex agent lifecycle, and zero
activity does not prove idleness. Apply reports already-current,
no-worker, applied, partial, superseded, or blocked evidence and never escalates to `SIGKILL`.

A manually opened loopback dashboard receives no API credential. On every loopback hostname or
address, the browser never prompts for or transmits the raw admin token; it requires a confirmed GUI
session instead. `ccx gui` and the macOS companion can use the raw admin credential outside the
browser to mint a short-lived, single-use launch ticket carried only in the URL fragment. Its one-time
exact-origin, exact-route exchange creates a confirmed GUI session with an eight-hour absolute
lifetime. The server keeps the session in process memory; the browser mirrors only its session token,
CSRF token, origin, and absolute expiry in `sessionStorage`, so a reload can rehydrate it while
the server session remains valid. It is never renewed: expiry, proxy restart, or a rejecting `401`
invalidates the client copy, which is then cleared before the dashboard directs the user back to the
launcher. Neither the durable admin token nor the launch ticket enters browser storage, and the
dashboard never uses `localStorage` for authentication. Because same-origin script can read
`sessionStorage`, this reload convenience is not OS-user isolation. Browsers may copy the record into
duplicated or opener-created tabs, or restore it with a restored tab; every copy remains bound to the
exact origin and CSRF token and is usable only until the fixed server expiry, a proxy restart, or a
rejecting `401`. The raw admin principal remains capable of ordinary headless API
mutations but is deliberately not accepted by the browser Apply endpoint; the companion and CLI keep
their existing narrow non-browser flows.

The desired revision is semantic rather than a filesystem timestamp. Catalog commits are idempotent:
JSON-semantic equality ignores insignificant whitespace and object-key order while preserving array
order, so equivalent catalog/cache artifacts are not rewritten merely to manufacture a newer mtime.
Worker freshness uses the newer of the catalog mtime and a content-scoped Codex boot fence. The boot
fence hashes only parsed worker boot inputs and persists the time that hash last changed, so desktop-
owned `config.toml` churn does not manufacture a reload requirement while real boot-setting edits do.
The fence marker is seeded only for CodexCommander-managed homes (injected routing/catalog keys);
a never-managed home is observed via raw mtime and never written.

When the catalog and managed routing are already current and only the running worker is stale, the
recommended end-user boundary is to quit ChatGPT completely, reopen it, and start a new task. A new
task or fork without that full app restart still reuses the old worker. A pending or unknown catalog,
or managed routing that is not yet injected, is different: **Apply to Codex** must first reconcile and
prove the disk/routing state; manual restart guidance must not replace that repair step. The guarded
dashboard/API action and `ccx sync --restart-codex` remain advanced callers of the same narrow
process-safety policy and may make ChatGPT show **stopped unexpectedly**.

## Entry shape

Routed entries keep Codex-required metadata such as reasoning levels, shell type, API support flags,
base instructions, modalities, auto-compact fields, and strict parser booleans. The public slug and
display name use `provider/model`.

## Native passthrough

Native bare OpenAI entries form one `openai` group. The provider's Pool(default)/Direct option
changes account selection without changing those ids; `openai-apikey/<model>` creates the separate
API-key identity. The API GPT-5.6 rows use 1,050,000 context / 922,000 max input; their `*-pro` virtual rows
rewrite to the base upstream model with `reasoning.mode: "pro"` while public state keeps the virtual
slug. Routed non-OpenAI models must not
inherit native-only service tier or WebSocket metadata unless the user explicitly enables that
capability. Detailed invariants live in [`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).

Native passthrough entries depend on the enabled provider set. With at least one enabled provider,
they appear only while an enabled canonical OpenAI forward provider exists — disabling every such
provider removes the native rows rather than leaving entries that resolve to no credential. With no
enabled provider at all, the native rows remain as bootstrap so a fresh install still has something
to route.

## Accounts, namespaces, and pool rotation

Pool mode routes across main plus added Codex credentials. Key rules:

- **A namespace is a public selector mapped to an internal target.** Generated selectors are how a
  caller names an account — the main login's selector is `main` (collision-suffixed if taken),
  which maps to the config-only sentinel `@main`; the sentinel deliberately sits outside the
  pool-account id grammar. Selectors must not collide with provider or combo ids
  (`src/codex/account-namespaces.ts`, `src/codex/account-namespace-match.ts`).
- **Selector labels carry no account-role semantics.** When at least one selector is advertisable,
  the Codex catalog clones each supported native row per selector and hides the bare picker rows;
  bare ids remain routable and stay in raw `/v1/models` unless explicitly disabled. Missing stored
  account targets are not advertised, and private account ids never become catalog labels.
- **Rotation is sticky.** A conversation stays on its selected account while that account is
  usable; failure moves it, success does not (`src/codex/pool-rotation.ts`).
- **The credential store is generation-guarded.** A refresh takes a lock and persists only if the
  generation it started from still holds; a lost race raises a generation-conflict error rather
  than overwriting the newer credential (`src/codex/account-store.ts`). Callers handle that error;
  they do not assume a silent retry.

Warmup issues a bounded request with a fallback model so a cold account reports usability before a
real turn depends on it (`src/codex/warmup.ts`).

## Multi-agent surface mode (3-state)

`CodexCommanderConfig.multiAgentMode` controls the `multi_agent_version` field stamped on catalog entries:

| Mode | Behavior |
| --- | --- |
| `"v1"` | Force ALL entries to `multi_agent_version = "v1"` — overrides upstream pins (sol/terra included). |
| `"default"` (install default) | Respect upstream model pins (sol/terra=v2, luna=v1). When the native `multi_agent_v2` flag is enabled, otherwise-unpinned entries are stamped v2; when it is disabled, they remain unpinned. On sync, stale forced values are cleared and upstream pins restored. |
| `"v2"` | Force ALL entries to `multi_agent_version = "v2"` — overrides upstream pins (luna included). |

The override is applied as a final pass in both `buildCatalogEntries` (live `/v1/models` path) and
`mergeCatalogEntriesForSync` (on-disk sync), AFTER all normalization and visibility processing. This
ensures `normalizeRoutedCatalogEntry` (which deletes `multi_agent_version` from routed entries) does
not clobber the forced value.

CLI: `ccx v2 mode v1|default|v2`. GUI: **Models → Current behavior → Collaboration**, labeled
**Reliable v1**, **Codex native**, and **Concurrent v2**. API: `GET/PUT /api/v2` with
`multiAgentMode` field.

The `multi_agent_v2` feature flag and the logical maximum thread count are separate from
`multiAgentMode` (`src/codex/features.ts`): the mode decides which surface Codex advertises, while
the flag and thread count decide what the native runtime allows.

Forcing V2 means Luna becomes V2-surface eligible in the generated catalog; it does **not** itself
make Luna live for a current worker. A usable subagent target must be selected, surface-compatible,
picker-visible and within the advertised five-row window, present in the converged on-disk catalog,
loaded by the current worker, and successfully routable by the proxy.

`CodexCommanderConfig.multiAgentV2MessageDelivery` is a separate request-time policy. `encrypted` is the
default and preserves ChatGPT's reserved collaboration schema plus the unreadable-ciphertext
fail-closed guard. `plaintext` opts the whole V2 parent session into mixed-provider compatibility for
task-message delivery; it is not a credential or general key-encryption setting:
canonical ChatGPT requests atomically alias the complete known collaboration namespace, strip only
the three message encryption markers, then restore the namespace and add Codex's
`encrypted_function_args: []` plaintext sentinel on the response. Routed adapters add that sentinel
only to completed `spawn_agent`, `send_message`, and `followup_task` calls at the bridge boundary.
Lifecycle and unrelated tools remain unchanged. Because the parent schema is fixed before worker
selection, all V2 delegation messages in that parent session become plaintext, including native
children; usage-debug body sampling is suppressed for those turns. Changes affect subsequent
requests, so the operator must start a new session rather than switch an active conversation.
Partial, future, malformed, or colliding native schemas stay encrypted and retain the existing
fail-closed guard.

## Ultra reasoning level

Ultra is always advertised in the catalog regardless of the `multi_agent_v2` toggle. The v2 toggle
controls only the multi-agent collab surface, not ultra visibility. The `nativeEffortClamp` function
wire-clamps ultra/max to each model's real top rung (e.g. gpt-5.5 ultra → xhigh on the wire).

`effortCap` and `subagentEffortCap` are hard ceilings applied on the V2 path
(`src/server/effort-policy.ts`): they lower or preserve the requested effort rather than rejecting
the request, and they never raise it.

[Decision Log]
- 목적과 의도: bare `defaultModel` selectors that route into third-party providers must keep their
  adapter-owned effort ladder; only true ChatGPT-native requests should receive the mock-max repair.
- 기존 구현 및 제약 조건: `nativeEffortClamp` already needed the original request id because
  routing strips `provider/`, but bare third-party selectors like `glm-5.2-fast-preview` still look
  native after that strip.
- 검토한 주요 대안: (1) infer nativeness from the bare slug prefix alone, (2) gate clamping by the
  resolved provider identity, (3) disable the clamp for all off-snapshot slugs.
- 선택한 방식: request-time clamp entry is allowed only when the resolved route is the canonical
  built-in OpenAI/Codex forward provider and the original request id is still bare.
- 다른 대안 대신 이 방식을 선택한 이유: provider identity is the only durable signal that
  distinguishes true native ChatGPT traffic from third-party `defaultModel` routes when both share a
  bare model id shape.
- 장점, 단점 및 영향: preserves `gpt-5.5 max -> xhigh` repair for native traffic, removes false
  clamps for bare routed models, and keeps adapter-specific effort mapping as the single source of
  truth for third-party providers.

## Subagents

Codex `spawn_agent` advertises the highest-priority first five picker-visible catalog rows as
featured suggestions, not as an exhaustive runtime allowlist. Native spawn still validates a
requested `model` against the worker-loaded catalog: a known exact, fresh, routable, surface- and
task-delivery-compatible catalog ID may be passed directly to stock native `spawn_agent`. Vague
family-name discovery is not provided. Native validation remains authoritative and fail-closed for
stale or unknown workers, unknown slugs, unsupported efforts, encrypted-task incompatibility, and
native rejection.
On disk, `subagentModels` has a compatibility dual-read: older `string[]` values and the ordered
object form `{ model: string, guidance?: string }[]` are accepted. CodexCommander canonicalizes both
forms in memory to ordered objects and writes the object form. The first canonical object write is a
schema migration point: older binaries that only understand `string[]` fail when they next read the
configuration. Keep that rollout boundary in mind when sharing a config between versions.

All current-home Ensure, Start, Restart, and Route Back entry points recognize that this schema
migration can leave an older proxy alive that cannot read the current configuration. They may make
one bounded replacement attempt only for an exact HMAC-attested runtime record whose authenticated
`/healthz` version or lifecycle generation is older, and only after stable process birth identity is
proven for the signals. An exact compatible runtime is reused without a signal. A newer, foreign,
recordless, ambiguously attested, or metadata-unknown listener is never signaled or accepted as a new
route, and Codex stays native if a safe explicit transition cannot finish.

Use at most five configured roster entries; each `model` may be a bare catalog id, routed
`provider/model` id, or exact account-qualified `<selector>/<native-openai-model>` id. An optional
per-row `guidance` value is sanitized operator text: empty text is omitted, and nonempty text is
limited to 160 Unicode code points. Guidance is advisory and untrusted; it is not an effort, quota,
role, or fallback control. The dashboard offers bare native and routed choices; exact
account-qualified choices are configured through `ccx agent subagents set` or CodexCommander
configuration.

When account selectors are active, one featured bare native id expands into a complete selector row
group. Catalog priorities use the selector count as a stride so each group stays together without
widening Codex's five-row advertisement window. Startup seeds bare native GPT defaults only when
`subagentModels` is unset; an explicit empty list persists.

Quota-aware fallback walks a configured chain when the featured model is exhausted, probing
availability on a bounded interval (default 60 s, `src/codex/subagent-model-fallback.ts`). It rewrites
the requested model id only; effort remains owned by the caps described under
[Ultra reasoning level](#ultra-reasoning-level).

On eligible V2 turns, a surviving row's guidance is included in the live developer message only
after the current catalog's surface, visibility, route, and encrypted-task compatibility filters
have run. Every accepted annotation that survives those filters is included in the built-in V2
message, which has no aggregate character budget. It is never copied into the managed delegation
skill or global `AGENTS.md` block, and it does not change native Codex behavior on V1.

`injectionModel` and `injectionEffort` are shared selections with two independent consumers.
`multiAgentGuidanceEnabled` controls only CodexCommander-authored delegation guidance.
`syncCodexSubagentDefaults` is a separate, default-off opt-in that applies the selected values to
Codex's native `[agents]` defaults on sync/restart for newly created Codex tasks when CodexCommander owns
the active Codex routing; external user-managed provider configs remain untouched. It does not itself
cause delegation. The TOML edit owns only marker-tagged values, preserves existing unmarked
user-owned `[agents]` defaults rather than overwriting them, and rejects ambiguous table shapes
without changing the file.

Native `[agents]` defaults remain limited to `injectionModel` and `injectionEffort`; roster entries and
per-row guidance are not persisted there. The managed skill and bounded global `AGENTS.md` policy are
also deliberately roster-free and consult the live collaboration contract instead.

Claude Code `ccx-*` agent definitions consume the same effective `claudeCode.blockedSkills` policy
as inbound bundle elision. When the list is non-empty (default: `claude-api`), generated definitions
whose marker-stripped model resolves to a routed id receive a preventive instruction not to invoke
those skills. Direct `provider/model` selectors are routed even when their inbound resolution is
identity. The only unguarded `ccx-self` case is an identity-resolved `claude|anthropic` model while
native passthrough is enabled; `modelMap` claims and `nativePassthrough:false` restore the guard. The
guard avoids creating oversized skill messages before the proxy can intervene; inbound elision remains
the fallback if a client still sends a blocked bundle. An explicit empty list disables both routed-model
behaviors.

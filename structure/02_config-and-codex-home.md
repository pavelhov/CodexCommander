# Config And Codex Home SOT

## Codex home

`src/codex/paths.ts` resolves Codex state from `CODEX_HOME` when set and valid, otherwise from
`~/.codex`. An unset `CODEX_HOME` falls back to `~/.codex`, including WSL discovery. An explicitly
set path that is unreadable or not a directory is an error, not a fallback: silently using a
different home than the operator named would write provider state where nobody is looking for it.
The managed files are:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/codexcommander.config.toml
$CODEX_HOME/codexcommander-catalog.json
$CODEX_HOME/codexcommander-journal.json
$CODEX_HOME/models_cache.json
$CODEX_HOME/.codexcommander-native-main-profiles/
```

Never assume macOS-only paths. Windows, service installs, and app-launched Codex can all depend on
the resolved `CODEX_HOME`.

## Managed Codex delegation setup

The optional dashboard delegation setup owns exactly two artifacts at fixed symbolic paths:

```text
$HOME/.agents/skills/codexcommander-delegation/SKILL.md
$CODEX_HOME/AGENTS.md
```

The first is the canonical user-skill path; `$CODEX_HOME/skills/codexcommander-delegation/SKILL.md`
is only a compatibility-collision check and is never another managed target. The second remains a
user file: CodexCommander owns only the block bounded by these stable, whole-line markers:

```text
<!-- BEGIN CODEXCOMMANDER DELEGATION -->
<!-- END CODEXCOMMANDER DELEGATION -->
```

The skill proves ownership in its own YAML frontmatter with exactly one
`name: codexcommander-delegation` and the metadata entries
`managed-by: codexcommander` and `managed-version: "1"`. Older version `"0"` is recognized only so
it can be safely updated or removed. This feature creates no persistent hash, manifest, lock, or
hidden ownership file. Do not apply the ownership-manifest rules used by full `ccx uninstall` to
these two artifacts.

The installer accepts no caller-selected path. It resolves the physical user home and Codex home,
keeps each target inside its fixed root, and refuses linked or reparse-substituted roots,
directories, and leaves. An existing leaf must be a regular single-link file; symlinks, hard links,
directories, nonregular files, oversized files, invalid UTF-8, and identities that change between
inspection and publication fail closed. Reads and temporary writes use no-follow behavior where the
platform exposes it, with identity and real-path checks providing the cross-platform invariant.
Writes publish by prepared temporary file plus atomic rename and verify the postimage.

Mutation of `$CODEX_HOME/AGENTS.md` is byte-preserving outside the bounded block. Existing CRLF or LF
style, every prefix and suffix byte, and the file mode are preserved; update replaces only the
managed region and uninstall removes only that region plus its immediately introduced separator.
Ambiguous, duplicate, reversed, orphaned, or non-whole-line markers refuse every mutation.

Install and update publish `SKILL.md` first and the `AGENTS.md` block second. Uninstall removes the
`AGENTS.md` block first, then removes only the managed `SKILL.md`; it removes the skill directory
only when that exact directory is still safe and empty, so unknown siblings survive. If the second
artifact fails before publication, the installer compensates the first artifact back to its exact
preimage. A successful compensation reports no remaining change and the underlying refusal reason.
A failure after publication, failed compensation, or unverifiable cleanup reports
`reason: "partial_write"` with `changed: true` so the dashboard never claims an atomic result.
Concurrent in-process mutation is rejected as `mutation_busy`.

Codex loads global policy from `$CODEX_HOME/AGENTS.md` once for a run. A nonempty
`$CODEX_HOME/AGENTS.override.md` shadows the managed global block; an empty override does not, and an
unsafe override makes activation unknown. Inspection never edits the override. Installing,
updating, changing mode, or removing the setup does not reload a current task, so the user must
start a new Codex task to consume the new policy.

This setup is advisory only. The skill tells Codex to inspect the live collaboration roster and tool
contract and contains no roster or model ids. Live tool guidance plus user and repository
instructions remain authoritative, including instructions that prohibit delegation. The setup does
not mutate `config.toml`, `subagentDeveloperInstructions`, native `[agents]` defaults, roster
injection, or catalog state, and it does not restart a worker or replace the proxy. Those existing
subsystems keep their independent ownership and activation rules.

### Managed wait lifecycle

A managed `wait_agent` timeout is a neutral subscription result: it proves only that no qualifying
mailbox or final event arrived during that window. The coordinator reconciles once with `list_agents`
and, for a still-running child, continues useful local work or starts another 5–10 minute wait. One or
more timeouts, including silence after a checkpoint or conclude message, do not authorize
`interrupt_agent`. Interruption requires explicit user cancellation, a confirmed error or blocked
state, a hard deadline communicated prospectively to the child, or deliberate replacement after
available work is preserved. Release pressure cannot create a deadline retroactively.

When a bounded high-stakes gate needs evidence, the coordinator may prospectively request one
explicit checkpoint or durable partial artifact with `send_message`; private child commentary does
not wake the parent mailbox. A conclude message is advisory, delivered at a model or tool boundary,
and is not proof that the child stopped.

The source of truth is `src/skills/codexcommander-delegation/SKILL.md`. The delegation renderer reads
those exact bytes, adds the concise marker-owned `AGENTS.md` block, and supplies both artifacts to the
preview, atomic installer, manual-copy payload, and packaging flows. Update the canonical source and
renderer; never hand-edit installed `~/.agents` artifacts or packaged `dist` output.

## macOS app first-run bootstrap

The direct packaged macOS companion **Start** path is the only app-only configuration bootstrap. It
uses `getDefaultConfig()`'s canonical secret-free ChatGPT passthrough provider and calls
`initializeConfigIfMissing` with create-only/no-clobber semantics. The initializer validates the
candidate before touching disk, refuses existing invalid, unreadable, inaccessible, or unsafe state,
and never overwrites an existing valid file. At the coordinated missing-entry probe it opens the final
`config.json` directly with `wx` and mode `0600`, writes and flushes through the owned descriptor, and
re-probes once after `EEXIST`; only a complete valid ordinary single-link winner is adopted. Providers,
API keys, OAuth accounts, and Codex configuration are not copied or created by this bootstrap.
An incomplete first read in an already owned root is rechecked only after acquiring mutation
coordination, so one CodexCommander process never adopts or rejects another's partial descriptor write.

The bootstrap candidate is trusted in-process policy data and is validated for schema correctness.
Static unsafe state remains fail-closed: linked roots, symlinked/nonregular/hard-linked entries,
inaccessible state, and unowned roots are refused. Active same-user filesystem mutation after the
coordinated probe is outside this narrow bootstrap boundary; the initializer does not anchor process
CWD or promise descriptor-relative defense against a same-user pathname swap.

Lifecycle authority acquires the Ensure lock (`E`) before the app preparation hook; the hook acquires
the shared `config-mutation.sqlite` lock only after E is held. This E → config-mutation-lock ordering
is an invariant: it keeps direct app bootstrap serialized with lifecycle start while preserving the
config writer's cross-process race protections. Ordinary CLI and service startup do not call the app
hook and require `ccx init` to create a valid CodexCommander config; a missing config is refused rather
than synthesized.

When the app observes that `$CODEX_HOME/config.toml` is missing on a fresh app bootstrap, it writes
only the app-owned default with `clientIntegrations.codex=false`. The proxy and dashboard still start,
but Codex remains native and the result reports `setupRequired: "codex-first-run"`; the companion tells
the user to open Codex once and then choose **Route Codex Through Proxy**. No Codex file is created
automatically. Existing Codex config, including an external provider route, remains untouched.

The companion's physical bundle classifier is part of this contract. `/Applications`, `~/Applications`,
and the source-build path are stable for Launch at Login; Desktop or Downloads copies are relocatable,
allowed for the current session, and presented with neutral guidance to move to Applications. The user
must quit CodexCommander before moving a running app, and the app never moves it. True App
Translocation is a hard pre-dispatch prohibition: Start stops before proxy launch and requires move and
reopen.

Native-main profile ownership is bound to the real `CODEX_HOME`, not to a CodexCommander instance.
Its encrypted vault, transaction journal, recovery marker, and referenced quarantine files live in
the owner-only `.codexcommander-native-main-profiles` directory. The unchanged
`.codexcommander-native-profile.lock.sqlite` beside that directory serializes every process sharing the
home. Only plaintext login staging is instance-local under
`$CODEXCOMMANDER_HOME/native-main-profile-staging`; a stage from one instance is invalid in another.
These paths and the OS keyring are owner-only: the operating-system account that owns them is the
trust boundary and already has direct access to active native credentials. CodexCommander detects and
fails closed on file identities that change during an operation, but it does not claim isolation
from a malicious process already running as that same trusted OS account.

CodexCommander never overrides an explicit `CODEX_HOME`. On Windows, `ccx doctor` and `ccx status`
nevertheless diagnose the high-confidence Orca dual-home case: both `CODEX_HOME` and
`ORCA_CODEX_HOME` select Orca's `orca/codex-runtime-home/home`, while the ChatGPT/Codex app uses the
default `%USERPROFILE%\\.codex`. Sync and restore output always prints the exact target Codex home;
display and JSON paths redact the OS username. The diagnostic tells users to invoke CodexCommander with
the app home explicitly rather than silently claiming that an unrelated app was configured. If a
service was installed under the Orca home, it must first be uninstalled from that original Orca
environment and then reinstalled under the app home; changing only the current shell does not change
the recorded service ownership.

[Decision Log]
- 목적과 의도: Make multi-home injection truthful without taking ownership of user environment variables.
- 기존 구현 및 제약 조건: CODEX_HOME is an intentional override, but Orca exports it for its own bundled runtime and the Windows app reads a different home.
- 검토한 주요 대안: Rewrite CODEX_HOME automatically, warn for every custom home, or detect only the Orca-owned signature and report the target path.
- 선택한 방식: Preserve the override, add a narrow Windows/Orca diagnostic, and qualify sync/restore success output with the effective home.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the silent failure while avoiding destructive or noisy behavior for intentional custom homes.
- 장점, 단점 및 영향: Orca users get an actionable warning; other multi-home products remain unchanged until they have an equally reliable signature.

`atomicWriteFile` uses a temp file named `{path}.ccx.{pid}.{seq}.tmp` (process ID + incrementing
sequence number) to avoid collisions when concurrent writers (e.g. `ccx stop` and the proxy's own
shutdown handler) both restore Codex config simultaneously. The temp is renamed atomically into place.

Response-state loading performs a bounded recovery pass for interrupted snapshot writes. It only
matches regular files named `responses-state.json.ccx.<pid>.<sequence>.tmp`, waits at least 15
minutes, and skips the current or any live PID. Eligible files are truncated before unlinking so a
matching stale path is unlinked without following it. Path-based truncation is intentionally avoided:
a same-user replacement could otherwise turn cleanup into a write through a symlink. Unrelated
temporary files, symlinks, directories, and young/active writes are never touched; directory entries
are consumed incrementally and at most 512 stale files are attempted per process start.

[Decision Log]
- 목적과 의도: Bound disk and conversation-state retention after abrupt process termination.
- 기존 구현 및 제약 조건: Ordinary write failures clean up immediately, but a killed process cannot run that path and Windows may temporarily lock files.
- 검토한 주요 대안: Delete every `.tmp`, rely on manual cleanup, or recover only exact response-state remnants with age and PID guards.
- 선택한 방식: Run a capped, best-effort, unlink-only sweep on lazy response-state startup.
- 다른 대안 대신 이 방식을 선택한 이유: It repairs known remnants without broad authority over unrelated temp files or active writers.
- 장점, 단점 및 영향: Old dead-PID files are reclaimed automatically; locked or conservatively classified files remain for a later retry.

## Config surface

`src/types.ts` is the shape and `src/config.ts` is the loader; neither is reproduced here. What
matters for maintainers is which groups exist and who resolves them:

| Group | Keys | Resolution rule |
| --- | --- | --- |
| Listener | `port`, `hostname` | The listener owns the port; `runtime-port.json` reports where it actually landed. |
| Routing | `defaultProvider`, `providers`, per-provider `selectedModels` | Explicit `provider/model` wins over `defaultProvider`. |
| Catalog | `disabledModels`, `customModels`, `modelCacheTtlMs`, `providerContextCaps`, `contextCapValue` | Catalog state is derived; config only records intent. |
| Retained state | `appOwnedMemoryBudgetMb` | Process-wide eviction target for app-owned logs, caches, blobs, and continuation payloads. Default 256 MiB, valid 64..4096; pinned state may temporarily exceed the target, but every pin-capable store has a finite local cap and their documented aggregate stays below `APP_OWNED_WORST_CASE_PINNED_BYTES` (512 MiB). Neither value caps RSS or native runtime memory. |
| Transport | stream mode, timeouts, proxy settings, `websockets` | `streamMode` persists in config.json; Windows services need a persisted input. On macOS, `auto` selects the validated single-reader relay only for an activated plaintext-V2 collaboration rewrite, `eager-relay` explicitly selects it for other eligible SSE turns, and `safe-tee` is the rollback pin. |
| Credentials | `apiKeys` | Data-plane only; never admitted to `/api/*`. |
| Lifecycle | `codexAutoStart`, shim/start behavior, storage cleanup | Startup safety reads these; see [`05_gui-and-management-api.md`](05_gui-and-management-api.md). |

Env values are resolved through `src/config.ts`, so a config value naming an env var never persists
the secret itself.

## Config injection

`src/codex/inject.ts` writes one of two forms. The choice is not cosmetic: it decides whether Codex
keeps its native provider id, which decides whether existing thread history still resolves.

**Loopback (default).** A single marker-owned root override, no provider table:

```toml
model_catalog_json = "/absolute/path/to/codexcommander-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
```

Codex keeps the native `openai` provider id, so new threads stay under that identity instead of
being re-tagged and loopback history needs no remapping. A user-owned root `openai_base_url` is
preserved instead of overwritten, and that case also blocks managed sub-agent defaults rather than
fighting the user for ownership.

**API auth header (non-loopback).** The built-in `openai` provider cannot carry the
`x-codexcommander-api-key` env header, so this form re-tags the root provider and appends the table:

```toml
model_provider = "codexcommander"
model_catalog_json = "/absolute/path/to/codexcommander-catalog.json"

[model_providers.codexcommander]
name = "CodexCommander Proxy"
base_url = "http://<host>:<port>/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-codexcommander-api-key" = "CODEXCOMMANDER_API_AUTH_TOKEN" }
```

Root TOML keys must be written before the first `[table]`. Re-injection strips the stale form of
both shapes — CodexCommander blocks, injected root base-url overrides, stale root context-window
overrides, and stale catalog paths — before rewriting, so switching between forms leaves no residue.

Native Codex sub-agent defaults are a separate, explicit opt-in. When
`syncCodexSubagentDefaults` is true and `injectionModel` is set, injection writes marker-owned
`agents.default_subagent_model` and, when configured,
`agents.default_subagent_reasoning_effort`. Unmarked values are user-owned and must never be
overwritten. Disabling the option and fallback restore remove only marker-owned values; journal
restore must preserve later user edits while stripping those managed values.

If the root config selects a provider other than `openai` or `codexcommander`, injection must leave the
config byte-for-byte unchanged and skip profile creation/updates and history synchronization.
External provider managers own that routing configuration, and replacing their provider id can hide
otherwise intact Codex sessions. This ownership check must run before catalog/cache refresh, journal
creation, or history work.

`supports_websockets = true` is appended to the provider table only when `websocketsEnabled(config)`
returns true.

## Codex-home diagnostics

Some Codex-home conditions are reported rather than repaired, because repairing them would overwrite
a deliberate user choice:

- Bundled-plugin marketplace state on Windows (`src/codex/plugins-doctor.ts`), surfaced by
  `ccx status`.
- Project-level Codex config that bypasses managed routing
  (`src/codex/project-config-warnings.ts`), surfaced by `ccx doctor` as a warning rather than an
  override.

## Profile and fast tier

When CodexCommander owns routing, it also writes `$CODEX_HOME/codexcommander.config.toml` as an explicit profile
target. Codex config uses `service_tier = "fast"` and `[features].fast_mode = true`;
catalog/request tier metadata may use `priority`. Do not collapse these spellings into one value.

## Provider output defaults

`CodexCommanderProviderConfig.defaultMaxOutputTokens` and `modelMaxOutputTokens` are OpenAI Chat wire defaults,
not context-window metadata. They are applied only when a Responses request omits
`max_output_tokens`; an explicit request value wins, then a model-specific configured value, then
the provider default, then the adapter omits the output-budget field. `chatCompletionTokenField`
selects that field (`max_tokens` by default or `max_completion_tokens` for providers such as Kimi).

Both numeric fields must stay positive finite integers at disk-config and management validation boundaries.
Registry entries may seed them through `providerConfigSeed`, key-login derivation, OAuth reconcile,
and `routeModel`, but user config overrides registry defaults per field/key.

## Restore

`ccx stop`, `ccx restore` / `ccx eject`, `ccx service stop`, and `ccx service uninstall` persist Codex
integration OFF and use the narrow native-routing escape. The escape atomically removes only the exact
marker-owned root route and its owned `model_catalog_json` pointer from `$CODEX_HOME/config.toml`; every
unrelated byte is preserved. It does not run a repair workflow or require the Codex transition
coordinator database.

Stop and service-removal paths must restore and verify that native config before terminating the proxy
or service; failure leaves those processes running. Plain `ccx restore` changes routing without changing
proxy lifecycle. Existing `codexcommander-catalog.json` and `models_cache.json` files may remain on disk
but are inert once `config.toml` no longer references them. Codex tasks, thread/history/rollout state,
and authentication are outside lifecycle ownership and are never modified by the native escape.

Explicit Start and Route Back are the inverse OFF→ON transition once Codex configuration exists. The
fresh direct app-start bootstrap is the exception: if Codex has not created `$CODEX_HOME/config.toml`,
the app starts the proxy and dashboard with Codex native, returns `setupRequired: "codex-first-run"`,
and waits for the user to open Codex once before choosing **Route Codex Through Proxy**. Passive
companion `ensure` does not install or invoke the bootstrap hook. If a recovery journal exists, Start
and Route Back first classify what it represents. The journal is a protected crash-recovery checkpoint: it records
the exact config/profile images needed to distinguish CodexCommander's write from unrelated user
edits. It is not a second routing preference or user-maintained database, and users must not delete
it manually.

Route Back is idempotent when integration is already ON and the exact attested current-home live
proxy owns a stable valid journal whose recorded profile postimage still matches the current profile.
The config must either match its recorded postimage exactly or be a stable exact marker-owned managed
descendant whose managed route strips to an independently native-safe config. This admits unrelated
Codex preference edits made after sync without weakening route ownership. The accepted case preserves
the active journal and succeeds without rewriting the route. From native/OFF, the existing
coordination path may retire only a journal it proves stale before creating the new routed state. A
wrong owner or profile, missing proof, tampered/custom/ambiguous routing, temporary write surface, or
observation race remains fail-closed and leaves integration OFF. Generated catalog/cache artifacts
can be reused; no broad CODEX_HOME cleanup is part of either transition.

After either Restore Native or Route Back succeeds, the user must quit ChatGPT completely, reopen
it, and start a new task so the running Codex host consumes the saved route.

Full `ccx uninstall` config cleanup is ownership-manifest based. A fresh config directory receives a
root-bound owner marker and an uninstall manifest before its first atomic config write. Uninstall
validates both bounded metadata files, rejects path traversal and a symlink/junction config root,
and removes only normalized manifest entries while holding the lifecycle E lock. It retains that lock
path plus the root-bound owner/manifest pair until E is released, preventing a concurrent Start from
creating a second lock namespace; the metadata-only root remains afterward. Manifest-owned directory
links are unlinked without traversing their targets. Unknown files remain in place and make the
command report a partial uninstall with their exact paths.

Nonempty config directories without canonical ownership metadata are deliberately not claimed. If
either ownership file is missing, malformed, or bound to another root, uninstall refuses config
deletion and reports the residual directory for manual review; there is no recursive-delete fallback.

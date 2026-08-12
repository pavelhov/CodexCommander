# GUI And Management API SOT

## Dashboard serving

The bundled React dashboard is built into `gui/dist` and served by the same Bun proxy. `ccx gui`
starts the proxy when needed and opens `http://localhost:<port>`.

All ordinary HTTP responses (excluding successful WebSocket upgrades) include `X-Frame-Options: DENY` and
`Content-Security-Policy: frame-ancestors 'none'`. This prevents another page from framing the local
dashboard or management responses. Embedding the dashboard in an iframe is intentionally
unsupported; deployments that previously relied on such embedding must open it as a top-level page.

## Authentication boundaries

CodexCommander uses three mutually exclusive admission credential classes:

| Credential class | Sources | Allowed surface |
| --- | --- | --- |
| Data plane | `CODEXCOMMANDER_API_AUTH_TOKEN`, the `service-api-token` file loaded through `CCX_API_TOKEN_FILE`, and `config.apiKeys` | `/v1/*` HTTP endpoints and new data-plane WebSocket handshakes only |
| Management plane | `CODEXCOMMANDER_ADMIN_AUTH_TOKEN` or the independent protected `admin-api-token` file | `/api/*` only |
| GUI session | A confirmed local-app launch, process-memory-only and origin-bound | Full dashboard methods for up to eight hours; catalog Apply remains confirmed-session-only |

The service token file remains a delivery mechanism for the data-plane environment token; it is not
a fourth credential class. A management credential that equals any configured data-plane credential
does not enable management access. The data plane may continue to start, but `/api/*` remains closed.
Before any TypeScript CLI management request can release a bearer or caller body, the client
authenticates the exact protected runtime record. The same fence applies at the credential-bearing
Claude and OpenCode launch boundaries. `ccx status` and `ccx doctor` account-health collection are examples:
they use the configured management credential for `/api/codex-auth/accounts`, never the
service/data-plane token, and distinguish a missing proxy, rejected authentication, and an
unexpected response so a reachable `401` cannot be reported as "proxy not running."

The client challenges the listener and verifies an HMAC proof bound to the proxy PID and port. The
per-process proof key lives only in the protected `runtime-port.json`; neither the public `/healthz`
identity marker nor configured-port discovery can authorize release of a management credential or
sensitive request body. Account-health detail and client credentials reach only a listener with an
attested exact runtime record.

[Decision Log]
- 목적과 의도: Keep a lower-privileged local process from collecting the management bearer by impersonating `/healthz` on an unused port.
- 기존 구현 및 제약 조건: Liveness remains public, but its service string and reported PID are assertions made by the listener itself.
- 검토한 주요 대안: Require only a runtime source and non-null PID; stop showing account health; authenticate the listener with a protected per-process challenge secret.
- 선택한 방식: Store a random secret in the mode-protected runtime record and require a challenge/PID/port HMAC before the CLI sends Authorization.
- 다른 대안 대신 이 방식을 선택한 이유: PID and command-line checks are not cryptographic listener identity, while removing live account health would regress diagnostics unnecessarily.
- 장점, 단점 및 영향: The long-lived token never reaches a listener without the runtime secret; an unattested listener cannot provide detailed CLI account health.

Management authentication never has a loopback bypass. If no management credential is available, or
management token creation, validation, or permission hardening fails, every `/api/*` request returns
503 while `/v1/*` and unauthenticated `/healthz` continue to operate. Windows ACL hardening results
must be checked explicitly because an `icacls` timeout is a soft failure in the shared secret helper.

Opening a local dashboard page directly does not mint an API credential. The static shell may load,
but every `/api/*` request remains behind management authentication; a fresh `ccx gui`/macOS
companion launch is required. A loopback page never prompts for or transmits the durable admin token,
because the browser origin does not prove which local OS user owns the listener. There is no
lower-privilege loopback session, implicit renewal, or loopback authentication bypass. The dashboard
never attaches a management session to `/v1/*`.

A non-loopback browser may prompt for raw admin only on a trusted HTTPS origin. Plaintext remote pages
never request or transmit that bearer; operators without trusted HTTPS use a local or SSH tunnel that
presents loopback and launch through `ccx gui`. This browser rule does not remove raw-admin support for
headless management API clients using a trusted transport.

`ccx gui` or the macOS companion may use the durable admin credential to mint a short-lived,
single-use launch ticket bound to the exact route and origin. Only the ticket enters the URL fragment,
which the dashboard removes immediately during its one-time exchange. The exchange creates a
confirmed, CSRF-protected GUI session with an eight-hour absolute lifetime. It is process-memory-only
and never renewed. Expiry or proxy restart makes the next API request return `401`; the browser then
directs the user to relaunch. The durable admin token never enters the URL, `localStorage`, or
`sessionStorage`. The
ticket is a transient capability, not a fourth durable credential class or a general management
bypass. Its exchange endpoint is the narrow pre-authenticated exception to the `/api/*` gate: the
single-use ticket itself is the bearer and is bound to the exact origin and route.

Confirmed launch mitigates cross-OS-user loopback listener spoofing, remote drive-by CSRF, and
accidental clients; it is not proof of user presence and is not stronger than raw admin against a
malicious process already running as the same trusted OS account described in
[`02_config-and-codex-home.md`](02_config-and-codex-home.md). In particular, it must not be described
as blocking a coding agent that already holds the raw admin token.

The raw admin principal remains capable of ordinary management API mutations. Catalog Apply is the
narrow exception: its browser endpoint accepts only a confirmed GUI session, while the native
companion and `ccx sync --restart-codex` keep their fixed non-browser flows.

Proxy admission credentials must never reach an upstream provider. The forwarding guard rejects the
`ccx_data_`, `ccx_admin_`, and `ccx_session_` prefixes, both environment tokens by constant-time
comparison, and manually configured data keys by constant-time comparison.

Audit item #16 remains partially deferred. This credential split protects new WebSocket handshakes,
but the following established-connection controls are intentionally outside this batch and must not
be treated as implemented:

- revoke an already established connection when its data key is deleted;
- enforce an idle timeout;
- reauthenticate subsequent frames after the handshake.

## API ownership

`src/server/index.ts` authenticates and routes `/api/*`, then delegates to
`src/server/management-api.ts`, which composes the route modules under `src/server/management/`.
Codex account routes live in `src/codex/auth-api.ts` because they own the credential store, not
because they are a different plane.

The registered route set is larger than the areas described below; the code is the route SOT. What
this document owns is which module holds which area and what invariant that area must not break.

| Endpoint area | Responsibility |
| --- | --- |
| Config/settings | Read safe config/settings views; mutate supported settings only. Full `PUT /api/config` is disabled so masked secrets are not round-tripped. `PUT /api/settings` accepts `codexAutoStart`, `streamMode`, and/or integer `appOwnedMemoryBudgetMb` (64..4096; each optional, at least one required). Budget changes synchronously enforce the process-wide evictable retained-state cap; this is separate from RSS/native memory. `streamMode` persists the #314 stream-shape selection in config.json (Windows services need persisted input; on macOS `auto` admits only the validated plaintext-V2 rewrite, `eager-relay` opts other eligible SSE turns in, and `safe-tee` is the rollback pin). |
| Startup safety | `GET /api/startup-health` reports whether injected Codex routing is restart-safe, with secret-free service/shim diagnostics. Its cached service/shim observation is composed with a fresh routing-document classification on every response. Authenticated `GET /api/codex-routing` is the smaller uncached route-confirmation DTO used by the native companion after an explicit switch. `POST /api/startup-action` provides allowlisted one-click installation for the background service or launcher shim. On Windows a healthy script shim is CLI-only; Codex Desktop requires the background service for full protection. |
| Windows tray | `GET/POST /api/windows-tray` controls an owned, per-user HKCU login tray. The tray delegates fixed actions to the CLI and is never a proxy supervisor or restart-protection signal. |
| Providers | Create/update/delete ordinary provider configs and enrich registry metadata. The reserved `openai` card exposes Pool(default)/Direct account mode; `openai-apikey` remains the separate API route. |
| Models | Fetch routed model lists, disabled model visibility, and catalog-facing ids. |
| OAuth | Login/status/logout for OAuth-backed providers, plus multiauth account management: `GET /api/oauth/accounts`, `PUT /api/oauth/accounts/active`, `PUT /api/oauth/accounts/alias`, `DELETE /api/oauth/accounts` list masked accounts per provider, switch the active one, edit its display-only alias, and remove one. The login flow itself is `GET /api/oauth/providers`, `POST /api/oauth/login`, `POST /api/oauth/login/code`, `POST /api/oauth/login/cancel`, `POST /api/oauth/logout`, and `GET /api/oauth/status`; pool controls are `GET/PUT/PATCH /api/oauth/accounts/pool` and `POST /api/oauth/accounts/clear-cooldown`. Login accepts `addAccount: true` to force a fresh browser identity. Device flows return a structured `deviceCode`; the GUI highlights and copies it before the user opens the verification page. |
| Key providers | `GET /api/key-providers` exposes API-key provider presets for setup and dashboard flows, and `GET/POST/DELETE /api/keys` owns the proxy's own admission keys. Multi-key pool per key-auth provider: `GET /api/providers/keys`, `POST /api/providers/keys`, `PUT /api/providers/keys/active`, `PUT /api/providers/keys/alias`, `DELETE /api/providers/keys` masked list, add (upsert + activate), switch, rename, and remove keys. `provider.apiKey` always mirrors the active pool entry so routing stays single-key. |
| OpenAI account mode | Report one OpenAI Codex card with Pool/Direct controls and one API-key card. Mode PATCH persists live without restart or catalog identity changes; Pool owns account/quota controls and Direct uses caller/main login only. Main-account DTOs report real credential presence and terminal `needsReauth` state instead of treating missing/invalid native auth as an unknown quota. Selection order has its own route: `PUT /api/codex-auth/accounts/priority` takes `{ id, priority }`, where `priority` is an integer -100..100 or `null` to restore the default, accepts `__main__`, 404s an unknown id, and echoes the stored value. Re-ordering never clears thread affinity, so the response carries no `appliesImmediately`, but it does release any pin — see [`08_openai-provider-tiers.md`](08_openai-provider-tiers.md) for why. `PUT /api/codex-auth/active` with a null id releases one too, but that drops the operator's account selection along with it, so this route is the only operator-facing way to clear a pin while leaving the selected account in place. `GET /api/codex-auth/active` reports `pinned`, true only while the manually selected account is still the effective active one, plus `pinnedAccountId`, which names the pinned account whether or not it is the active one. Surfaces should render `pinnedAccountId`: under round-robin and fill-first the pin caps the tier ceiling at its own tier while the strategy cursor moves freely inside that tier, so `pinned` goes false on a sibling's turn even though the pin is still suppressing every higher tier — which is why the dashboard badges `pinnedAccountId` and the GUI controller tracks only the id. `pinned` answers the narrower question of whether routing is *currently* on the operator's choice; no surface in this repo asks it, and a new one almost certainly wants the id instead. |
| OpenCode integration | `src/server/management/opencode-integration-routes.ts` and `src/clients/opencode-persistence.ts` exclusively own `GET /api/integrations/opencode`, Apply, auto-connect, Restore, and Desktop-open actions. The Client Apps workspace reads this dedicated status, while the generic `/api/client-integrations*` collection, mutation, journal, and restore routes exclude OpenCode so only one production writer can touch `provider.codexcommander`. Persistent mode resolves the active global JSONC/JSON target, protects the admission token in CodexCommander state, and emits an OpenCode `{file:…}` reference. JSONC mutation must preserve comments and other keys. A journal + backup enables byte-exact restore while untouched and surgical provider-only restore after user edits; full overwrite requires an explicit current-hash confirmation. `autoConnect` is default-off and only refreshes that managed provider after startup/catalog changes. `src/clients/opencode-installation.ts` detects and launches Desktop; CLI fallback remains `ccx opencode` and never writes disk config. |
| Subagents | Read/write the featured `subagentModels` list capped at five ids. `GET/PUT /api/injection-model` manages the shared delegation model/effort selection, the independent CodexCommander guidance switch, and the default-off `syncCodexSubagentDefaults` opt-in for native Codex subagent defaults. `GET /api/codex-catalog/status` exposes desired configuration, deterministic on-disk catalog evidence, and current worker activation evidence; `POST /api/codex-catalog/apply` is an authenticated, CSRF-protected, explicit interruption action accepting only `{ expectedDesiredRevision, confirmInterrupt: true }`. It accepts only the confirmed GUI session created by the exchanged single-use launch ticket; the raw admin token is mint authority, not direct browser-Apply authority. CLI and native-companion compatibility remains on their narrow non-browser flows. No caller-supplied PID, command, or path is accepted; stale targets are exact current-user identities revalidated before `SIGTERM`, unknown identity blocks, and busy work returns `503` plus `Retry-After`. The roster GET/PUT and `POST /api/sync` include the same additive activation observation. When CodexCommander owns the active Codex routing, native `[agents]` defaults apply to newly created Codex tasks after sync/restart; external user-managed provider configs remain untouched. The defaults do not cause delegation and preserve existing user-owned defaults rather than overwriting them. PUT is partial-update: absent keys are unchanged, `null` clears, and non-object bodies are rejected with 400 before field validation. `syncCodexSubagentDefaults: true` requires a nonblank `model` and a supported Codex reasoning effort when effort is set; clearing `model` (null/empty) always clears effort and disables native-default sync even when the stored effort was invalid. |
| Live proxy requests | `src/server/management/activity-routes.ts` — `GET /api/agent-activity` exposes a bounded snapshot of currently admitted proxy request turns, not persistent Codex agent lifecycle. Records contain opaque process-ephemeral ids, privacy-safe model/provider labels, `primary`/`subagent` request classification, and truthful `starting`/`running` phases; a row is removed when its request lease settles even if Codex keeps a child thread alive. No prompt, path, tool, account, raw request/thread id, error, or historical transcript is retained or serialized. Parent ids are emitted only when the parent appears in the same payload. Counts describe the pre-truncation snapshot, while at most 64 deterministically ordered records are returned. The response is management-authenticated and `Cache-Control: no-store`. The macOS catalog confirmation may use a fresh count to explain interruption risk, but a zero-count observation is not an idle guarantee and release one does not defer catalog application on it. |
| V2 / Multi-agent mode | `GET/PUT /api/v2` — reports/sets the codex `multi_agent_v2` feature flag, the 3-state `multiAgentMode` override (`v1`/`default`/`v2`), the `multiAgentV2MessageDelivery` policy (`encrypted` default or opt-in `plaintext`), and the logical maximum thread count. Selecting `v2` enables the native flag and moves `[agents] max_threads` to the v2 key; selecting `v1` disables it and moves the same value back. `default` leaves the native flag unchanged. PUT accepts any owned field independently; contradictory mode/flag pairs are rejected before writes. A mode/protocol/thread boot-config change requires **Apply agent catalog** to replace a running worker, then a new task for its session-bound tool shape. Delivery changes affect only subsequent V2 task messages: start a new task, but no catalog convergence or Apply is needed. Plaintext concerns task-message delivery only, not stored provider credentials or generic key encryption. Every feature transition is rollback-safe and resyncs the catalog only when it changes catalog/boot configuration. |
| Logs & Debug | One sidebar entry (`/#logs`) with two tabs. Logs tab: request/runtime logs for local diagnosis. Debug tab (`/#logs/debug`): provider + usage toggles, refresh/follow log viewer. `GET/PUT /api/debug`; `GET /api/debug/logs` and `GET /api/debug/usage-logs` use the monotonic `after` cursor. CLI: `ccx debug provider|usage …` (both streams via running proxy API). |
| Usage | `GET /api/usage` aggregate read-only summary derived from `~/.codexcommander/usage.jsonl`; measured / reported / unreported / unsupported / estimated counts, daily zero-filled grid, model and provider breakdowns. Never exposes prompts. |
| System | `POST /api/system/restart` proves spawn of one detached internal `__tray-restart` helper and leaves lifecycle work to the canonical tray path: safe Stop restores native Codex and persists routing OFF before proxy termination, then explicit Start restores routing ON. The serving handler never drains its listener or exits. It returns `202` for a newly accepted or already accepted helper, and `409` only when helper spawn is refused; refusal leaves the current endpoint live and retryable, while an early helper exit re-arms the latch. `GET /api/system/memory` — service-process runtime/memory identity (pid, Bun version/revision, optional `bunRuntimeSource` provenance, platform, RSS/heap/external/ArrayBuffers scalars, observed memory = max(RSS, external, ArrayBuffers), `bun:jsc` heap context, streamMode + ordinary and plaintext-V2 eager-relay gate decisions, scalar eager-relay in-flight/cancel/abort/error/queue counters, watchdog snapshot sliced to the last 60 samples) plus privacy-safe `appOwnedBytes` retained-store totals/counters under static store ids. Scalar-only payload; rides the standard management auth gate and must never move to unauthenticated `/healthz`. Consumed by `ccx doctor`'s Memory/runtime section and the dashboard Memory observability card. |
| Stop | Raw `POST /api/stop` persists OFF, restores and proves native Codex, and exits an unsupervised proxy. It refuses an installed supervisor; CLI/tray Stop owns the service-manager step and delegates the process shutdown under its exact lifecycle lease. |
| Diagnostics/sync | `src/server/management/config-routes.ts` — `GET /api/diagnostics/project-config` reports project-level Codex config that bypasses managed routing; `POST /api/sync` re-runs catalog/config sync and returns activation evidence without interrupting workers. The diagnostic reports the bypass; it does not rewrite the project file. A stale worker roster is nonfatal lifecycle state, not proxy failure; starting a task or fork is not treated as a catalog reload. |
| Sidecar/shadow-call settings | `src/server/management/config-routes.ts` — `GET/PUT /api/sidecar-settings` and `GET/PUT /api/shadow-call-settings`. PUT accepts model and backend plus optional `webSearch.reasoning` and `vision.maxDescriptionsPerTurn`; the read and PUT-response payload reports model, backend, and the vision per-turn limit. Credentials live in the provider and OAuth stores instead. Both shadow-call responses also report the resolved `sourceModels` — the prefixes the runtime actually intercepts (`src/lib/shadow-call.ts`, default `gpt-5.6-luna`; an explicit override names current custom helper ids), so no client hard-codes a helper slug that a Codex release can invalidate. |
| Storage | `src/server/management/logs-usage-routes.ts` — `GET /api/storage`, `POST /api/storage/cleanup/preview` and `/api/storage/cleanup`, `GET /api/storage/trash`, `POST /api/storage/trash/restore`, and `GET/PUT /api/storage/cleanup-policy` plus `POST /api/storage/cleanup-policy/run`. `GET /api/storage/cleanup-policy/test-stream` and `GET /api/storage/trash/restore/test-stream` exist for progress-stream testing. Cleanup takes an explicit `mode`: `quarantine` moves to trash and is restorable, `permanent` is not. The caller must name the mode — there is no default that silently deletes. |
| Provider quotas and tests | `src/server/management/provider-routes.ts` — `GET /api/provider-quotas`, `POST /api/providers/test`, `GET/PUT /api/provider-context-caps`, `GET /api/provider-presets`. A context-cap PUT may combine a positive integer `value` with boolean `setAll` so a staged shared policy is persisted atomically; per-provider writes keep the existing `{ provider, enabled }` shape. A quota read may be served from cache or force-refreshed; absent quota data is reported as unknown rather than as a measured zero. Its additive `availability` list has one entry per enabled quota-capable provider, with `available / stale / unavailable` and only fixed privacy-safe reasons (`reauth_required`, `local_cli_refresh_required`, or `upstream_unavailable`); raw upstream or OAuth errors never cross the management boundary. |
| Models and visibility | `src/server/management/model-routes.ts` — `GET /api/models`, `PUT /api/disabled-models`, `PUT /api/model-visibility`, `PUT /api/selected-models`, `GET/POST /api/custom-models`. Visibility writes trigger catalog sync through the owning server path. |
| Effort and fallback | `src/server/management/agent-settings-routes.ts` — `GET/PUT /api/effort-caps`, `/api/subagent-models`, `/api/subagent-model-fallback`. Caps clamp; they do not reject. |
| Grok and Claude integrations | `src/server/management/agent-settings-routes.ts` — `GET /api/grok`, `PUT /api/grok/selection`, `POST /api/grok/apply`, `GET/PUT /api/claude-desktop`, `POST /api/claude-desktop/apply`, `GET /api/claude-desktop/status`, `GET/PUT /api/claude-code`. Apply writes an external app's profile, so its status probe must read the same resolved path it writes (see [`04_transports-and-sidecars.md`](04_transports-and-sidecars.md)). |
| Combos | `src/server/management/combo-routes.ts` — `GET/PUT/DELETE /api/combos` own provider combination and failover definitions. |
| Codex accounts | `src/codex/auth-api.ts` — `GET/POST/DELETE /api/codex-auth/accounts`, `PUT /api/codex-auth/accounts/alias`, `PUT /api/codex-auth/accounts/pause`, `PUT /api/codex-auth/accounts/pause-exhausted`, `POST /api/codex-auth/accounts/clear-cooldown`, `GET/PUT /api/codex-auth/active`, `PUT /api/codex-auth/auto-switch`, `PUT /api/codex-auth/pool-strategy`, `PUT /api/codex-auth/failover`, `GET /api/codex-auth/quota`, `GET /api/codex-auth/reset-credits` with `POST /api/codex-auth/reset-credits/consume`, and the login flow `POST /api/codex-auth/login`, `POST /api/codex-auth/login/code`, `POST /api/codex-auth/login/cancel`, `GET /api/codex-auth/login-status`. Account ids are opaque handles and are serialized so the GUI can address an account; emails are masked and tokens are never serialized. |
| Logs | `src/server/management/logs-usage-routes.ts` — `GET /api/logs`, `GET /api/claude/inbound-debug`, and `GET /api/debug/injection-logs` join the debug streams described above. |

Provider writes must not round-trip masked API keys as real secrets. Dashboard actions that change
model visibility or subagent selection should trigger catalog/cache sync behavior through the server
path that owns it.

The UI must show one provider card and one Models group for Codex-login OpenAI, describe Pool and
Direct accurately, and keep the main account inside Pool. Public model state keeps virtual Pro ids
even though transport logs may additionally report the resolved base model. Detailed rules live in
[`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).

User aliases are display metadata only. Codex pool aliases live on `CodexAccount`, OAuth aliases on
`ProviderAccount`, and API-key aliases reuse the existing key `label`; account ids, credential
identity, active selection, and routing never consult these fields. The matching CLI is
`ccx account alias <provider> <id> <display-name|->` (`rename` is accepted as a synonym).

Selection order is the opposite case and must not be folded into the alias route. `codexAccountPriorities`
is routing metadata that Pool selection consults, it lives in config rather than on `CodexAccount` so the
`__main__` Desktop login can carry one, and the alias route's rejection of `__main__` would be wrong for
it. The matching CLI is `ccx account priority <provider> <id|main> [<value>]`, reading the current order
when the value is omitted. Ordering invariants live in
[`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).

## Sidebar stop button

The dashboard sidebar includes a stop button that calls `POST /api/stop`. The button shows a
confirmation prompt, then fires the request and accepts the connection drop (the proxy exits). The
endpoint restores and verifies native Codex config before an unsupervised proxy exits. If an installed
service owns the proxy, raw API Stop returns `409` and leaves it running; the tray or CLI Stop action
must stop that manager first and then delegate shutdown under the same lifecycle authority.

## Bun runtime provenance

`GET /api/system/memory` may report `bunRuntimeSource` — one of `override`, `bundled`, or
`process` — describing how the **running service** obtained its Bun binary.

The value is stamped into the launched process's environment as a pair —
`CCX_BUN_RUNTIME_SOURCE` plus `CCX_BUN_RUNTIME_PATH`, the binary it was minted for — by whichever
launcher selected that binary: the Node launcher, the Windows Task Scheduler wrapper, the
native WinSW service, launchd, systemd, the Codex autostart shim, and the Windows tray host. Both
halves come from a single `durableBunRuntime()` resolution at each site, so the marker can never
describe a different binary than the one actually baked.

Launchers that re-exec `process.execPath` instead of resolving a binary — `ccx ensure`, GUI/Claude/
OpenCode start, and the detached helper spawned by `POST /api/system/restart` — go through
`withProcessRuntimeProvenance()`. An inherited marker is carried forward only when its recorded
path is the executable about to run, compared through `realpath` so symlinks, junctions, and
Windows case differences do not break a valid match. The recorded path is what settles this rather
than re-deriving the original selection: a service installed with a shell-local override keeps
neither that shell nor its `CCX_BUN_PATH`, so re-deriving would demote a correct `override`
to `process` on the first relaunch. A marker that describes some other binary — inheritance
travels down a process tree and can outlive the binary it was minted for — is dropped in favor of
what is actually executing.

The Codex shims scope the pair to their `ensure` invocation (an assignment prefix in `sh`,
`setlocal`/`endlocal` in `cmd`, save-and-restore in PowerShell) rather than exporting it. A shim
wraps the real `codex`, so an exported marker would be inherited by Codex and everything it
spawns.

**Trust rule: a reporting surface must never resolve provenance for itself.** Calling
`durableBunRuntime()` at report time answers "what would this process pick right now", which is
a different question from "what was the service started with" — and the two diverge exactly when
the answer matters, such as a `doctor` run in a shell whose `CCX_BUN_PATH` differs from the
installed service's. Read-back goes through `reportedBunRuntimeSource()`, which allowlists the
three values and returns `undefined` for anything else.

`bunRevision` remains informational and carries no capability meaning. Provenance does not feed
the eager-relay decision. Generic `auto` remains conservative (`auto-known-bad`) for canary and
otherwise unvalidated Bun builds. The separate macOS plaintext-V2 exception compares the actual
runtime version with the exact bundled version whose synchronous-pull relay was abort-tested; a
mismatch stays on tee and emits a startup warning (`src/lib/bun-stream-caps.ts`).

## Startup safety

**Startup safety** is reachable by route (`/#startup`) and is a permanent entry in the dashboard's
System navigation. The dashboard's startup-state row also links there whether the current state
needs remediation or merely reports how routing is started. Its state is derived from active Codex
routing plus the actual service and launcher-shim installation state. On macOS, the companion can
also report its current Launch at Login presentation through an admin-token-only, memory-only lease.
A fresh enabled lease identifies the normal desktop setup as `caution` + `companion`: it is restart
safe at sign-in, but it does not provide crash supervision. A viable background service wins over
the companion and reports `protected` + `service`; it is presented as the optional crash-recovery
upgrade. Stale diagnostics, custom-local routing, and unknown routing remain fail-closed and cannot
be upgraded by companion evidence. The `codexAutoStart` preference alone is never presented as proof
of restart protection.

The base service/shim diagnosis is cached, but companion state is merged into every response from a
server-timestamped lease and is never persisted. `PUT /api/startup-health/companion` accepts only the
raw admin-token principal, not GUI sessions; reports are advisory and cannot authorize requests,
change routing, or suppress repair for routes the proxy does not own. The page keeps direct service
actions available and moves copyable advanced repair commands (`ccx service repair`,
`ccx service install`, `ccx codex-shim install`, and `ccx restore`) behind an accessible disclosure.
True at-risk repair guidance stays visible. On
Windows it can also install an owned, per-user system tray. The resident tray owns only its icon,
home-scoped singleton, and HKCU Run registration; fixed proxy actions delegate to the CLI so drain,
service conflict handling, native restore, and PID identity remain centralized. Tray presence never
makes `startup.status` protected.

Windows Task Scheduler create failures must not depend solely on localized `schtasks.exe` text.
When the owned fixed-shape `/create /tn codexcommander-proxy /xml ... /f` command exits with status 1,
the effective-token elevation probe may classify it as access denied only when the token is known
to be non-elevated. An unavailable probe remains `other` and cannot trigger UAC. Query, run, delete,
native-service, file-write, and foreign task failures never use this fallback.

```text
[Decision Log]
- 목적과 의도: Make Windows scheduler installation recovery work on non-English systems without broadening the commands that may request UAC.
- 기존 구현 및 제약 조건: Access-denied classification parsed English and German stderr. Chinese OEM output decoded as UTF-8 became mojibake, so the fixed scheduler-create failure lost its machine marker and the dashboard could not select its existing elevation transaction.
- 검토한 주요 대안: Add translations and code-page decoders; elevate every scheduler failure; always launch installation elevated; or combine a native effective-token probe with the already fixed command shape and exit status.
- 선택한 방식: Preserve text detection, then use the native token probe only for status-1 creation of the owned `codexcommander-proxy` XML task. Unknown probe results fail closed.
- 다른 대안 대신 이 방식을 선택한 이유: Windows localization and OEM code pages are open-ended, while the token state and owned command shape are stable security signals already bounded by the elevated transaction protocol.
- 장점, 단점 및 영향: Non-English users receive stable guidance and dashboard UAC recovery. A non-permission status-1 failure from the exact owned command may be retried once elevated, but foreign operations cannot cross the elevation boundary and the elevated transaction still fails closed.
```

## UX boundary

The dashboard is a local control surface, not a separate service. It should reflect the same config
and catalog invariants documented in this folder rather than inventing parallel state.

## Dashboard surfaces

The sidebar exposes eleven pages (`gui/src/App.tsx` `NAV`). Several are workspace shells rather than
single forms, and the shell pattern is the part worth keeping stable:

| Surface | Shape |
| --- | --- |
| Providers | Rail of configured providers plus a detail pane whose tabs are Overview, Models, Usage, then Accounts or API Keys when the provider has an auth surface, then Settings (`gui/src/components/provider-workspace/ProviderDetails.tsx`). The canonical `#providers/<provider>/<tab>` route preserves provider and tab selection across reload, Back, and Forward; malformed or unavailable destinations fall back without activating an invalid control. |
| API keys | Rail plus per-key detail; masked values only (`gui/src/components/apikeys-workspace/`). |
| Storage | Rail plus cleanup and trash detail (`gui/src/components/storage-workspace/`). |
| Subagents | Featured-roster selection workspace (`gui/src/components/subagents-workspace/`). |
| Combos | Rail, detail panel, and an add flow (`gui/src/components/ComboWorkspace.tsx`). |
| Add provider | Catalog browser plus form and OAuth panes (`gui/src/components/provider-catalog/`, `gui/src/components/AddProviderModal.tsx`). |
| Codex accounts | Account pool cards, add-account flow, switch and reset modals (`gui/src/components/CodexAccountPool.tsx`, `gui/src/components/AddCodexAccountModal.tsx`). |
| Dashboard overview | Overview, Providers, and Models tabs at the page level (`gui/src/pages/Dashboard.tsx`), the 30-day token and coverage stats in the overview head (`gui/src/pages/dashboard-overview-head.tsx`), and the effort-cap, injection, maintenance, sidecar, and memory panels below it (`gui/src/pages/dashboard-overview-panels.tsx`). |

Provider rail and detail-tab selection are URL-backed. Other rail workspaces keep component-local
selection and return to their default row after a reload. An OAuth ToS warning is shown before a
login that requires acceptance (`gui/src/components/OAuthTosWarningModal.tsx`).

## macOS menu bar companion

`app/` is a native AppKit menu bar client for the existing local proxy; it is not a second proxy,
credential store, provider registry, or quota engine. It reads the same protected local management
credential used by the dashboard/CLI, talks only to a validated literal loopback address, and never
copies that credential into Keychain. A Finder-launched app cannot inherit an environment-only admin
token, so that configuration is reported as unsupported instead of prompting for or persisting a
duplicate secret.

The active development build is `<repo>/dist/macos/CodexCommander.app`. Every built app runs the Bun
runtime and server resources embedded in its own `Contents/Resources/runtime`; it never discovers or
executes checkout `src/`, so developers rebuild the app to pick up source changes. The development app
is not copied into Application Support, and no bundle shells through an ambient `ccx`. Every new
manual or Login Item launch runs the explicit Start lifecycle action: it starts or attaches to the
owned proxy, routes managed Codex through it while preserving an external user-managed provider, and
synchronizes the Codex model catalog. The companion remains
open and actionable after an offline or startup failure. Passive `ensure` remains a separate bridge
operation for catalog rechecks that must not override a Native route selected during the current app
session. **Quit** terminates only the AppKit UI. **Stop** and
**Restart** are separate confirmation-gated operations: Stop uses the fixed lifecycle helper to
persist OFF, restore and verify native Codex, stop any manager, and leave the menu app open; Restart
uses the canonical stop→start transaction and reports success only after replacement identity
verification. **Restore Native Codex** changes only routing and deliberately leaves the proxy running.
Here and below, restoring native means removing CodexCommander-owned routing; an external
user-managed Codex provider is preserved.
Both explicit route directions confirm the saved routing document through the fresh route endpoint
before reporting success. A confirmed route change tells the user to quit ChatGPT completely, reopen
it, and start a new task; the companion never presents the existing host as already switched.

An explicit route action owns one visible operation card immediately below the header. Its truthful
orchestration phases are **Changing route** and **Confirming route**, with an indeterminate spinner
and elapsed time rather than a fabricated percentage. Lifecycle and route controls are disabled
while an action is in flight. When idle, the action for the already-active route is disabled; an
unknown or custom route leaves both explicit directions available. Progress remains visible until a
terminal result replaces it, and success or failure remains until the user dismisses it or starts
another operation. A typed recovery refusal leads with the unchanged user state; a generic failure
or unavailable confirmation avoids claiming what changed. Raw recovery detail remains secondary.

If running Codex workers still hold the previous roster, the healthy proxy is shown with a
persistent, nonfatal **Agent catalog update ready** card. **Apply agent catalog** is a third, separate
fixed lifecycle action: it sends only the current desired revision and an explicit interruption
confirmation to the protected management API, which re-converges the catalog and signals `SIGTERM`
only to exact current-user `codex … app-server` and `codex-code-mode-host` identities. It waits briefly
to verify which old workers exited and reports incomplete survivors without escalating to `SIGKILL`.
It never restarts the CodexCommander proxy or closes the menu app. The confirmation reports fresh active
request evidence when available and still warns that an answer may be interrupted; zero activity is not
proof of idleness, and unknown worker identity blocks the action. The current companion offers **Apply
Now** and **Later**, not an Apply-when-idle automation or persisted pending receipt. A new task or fork
does not reload the catalog of an existing worker. The advanced CLI fallback is exactly:

```bash
ccx sync --restart-codex
```

The desktop default is app-first: the first launch from Applications, `~/Applications`, or the exact
source `dist/macos` location registers the main app through `SMAppService.mainApp`. The preference is
explicitly reversible in the panel. A source rebuild refreshes that registration only while the
preference remains enabled; translocated and unstable paths never register. One atomic per-user
process lock plus LaunchServices reuse prevents simultaneous login/manual launches from running two
menu controllers. This does not replace or auto-install `com.codexcommander.proxy`: the launchd service
remains the optional headless/crash-supervised server path, and service children still never open the
companion.

The popover is a compact status surface: proxy liveness, public startup readiness, and Codex route are
three separate signals, in-flight primary/subagent request turns come from `/api/agent-activity`, one
provider-quota accordion with ChatGPT first and expanded by default, and fixed links into the full
dashboard. Provider management opens `#providers/<provider>/<tab>` so login, account, model, usage,
and settings work remain in the existing authenticated browser UI. Restart is an explicit confirmed
`POST /api/system/restart`; successful rediscovery and each menu open re-arm one authentication retry,
and all post-restart config reads use fresh file descriptors. Activity and quota polling runs only
while the menu is open; a slower identity/health tick keeps the status-bar state useful while closed.
Unavailable or unknown data is rendered honestly rather than invented.
The provider inventory is the left side of the quota join, so a configured quota-capable provider
never disappears merely because its report is absent. The availability contract gives the companion
and Providers workspace the same auth/readiness result in the same refresh: linked Grok or Kimi CLI
credentials can say that the local CLI login needs refresh, rejected credentials can ask for sign-in,
and transport failures stay distinct.

The `/#codex-auth` add-account modal has a three-step manual-code UX contract on top of the existing
OAuth polling API: submit request, waiting-for-login completion, and terminal success/failure. Once
`POST /api/codex-auth/login/code` succeeds, the GUI must keep the input disabled, expose an
`aria-live` status message that the code was accepted, and surface repeated `login-status` polling
network failures as a visible warning instead of silently looking idle again.

## Usage accounting

`src/usage/log.ts` writes append-only JSONL to `~/.codexcommander/usage.jsonl` with file mode `0o600`.
`src/usage/summary.ts` turns that file into the `/api/usage` shape — totals, daily zero-filled
grid, model and provider breakdowns, and `measured / reported / unreported / unsupported / estimated` counts.
A missing `usage.jsonl` returns a zeroed summary with 200, not an error: a fresh install has no
usage and must not render as a failure. What the shape must never do is present an unmeasured
request as a measured zero — that is what the `measured / reported / unreported / unsupported /
estimated` split exists for, and why coverage is reported alongside totals. The dashboard Usage tab renders the same shape, and the
main Dashboard surfaces a 30d token / coverage summary. The in-memory `requestLog` is capped at
200 entries and is **not** the source of truth for aggregation — the JSONL on disk is.

The management API caches only the compact summary for an exact file revision and query; it never
retains normalized per-request rows after a response. The cache invalidates on any identity, size, or
timestamp change and at the next range expiry or local-day boundary. Rebuilds parse in bounded
batches and yield between them, so unrelated management requests remain serviceable even for a large
existing log. The Dashboard polls its 30-day usage summary independently once per minute, so usage
work cannot delay health/provider/settings state or run every five seconds.

[Decision Log]
- 목적과 의도: Keep dashboard and management requests responsive as `usage.jsonl` grows.
- 기존 구현 및 제약 조건: The JSONL file remains the durable source of truth and may be truncated, replaced, or hand-edited.
- 검토한 주요 대안: Retain normalized rows, maintain a second database, or cache only revision-keyed summaries and cooperatively rebuild them.
- 선택한 방식: Keep only bounded summary results, share full reads by exact file identity, yield during parsing, and poll usage separately at a slower cadence.
- 다른 대안 대신 이 방식을 선택한 이유: It bounds resident heap and avoids a second persistence format while keeping unrelated endpoints responsive.
- 장점, 단점 및 영향: Unchanged queries are cheap and memory stays bounded; a changed large log still consumes rebuild CPU, but cooperatively and at most once per observed revision/query.

For diagnosing upstream-shape / usage-extraction issues run `ccx debug usage on` (or set
`CODEXCOMMANDER_USAGE_DEBUG=1` before start). The proxy then writes a rolling debug record per finalized
request to `~/.codexcommander/usage-debug.jsonl` (mode `0o600`, auto-trimmed to the most-recent 100 lines
once it exceeds 200) with the upstream content-type, body kind (`sse / json / other / none`), a 2KB
body sample, and the extracted usage. Off by default; the hot path is guarded so production stays
untouched.

## Provider debug logging

Provider transport diagnostics (dropped SSE frames, adapter dial/stream events, etc.) are opt-in:
`ccx debug provider on` / `ccx debug provider off` on the running proxy, the Debug-page toggle, or
`CCX_DEBUG=1` on the next start. Lines
use the `[ccx:<adapter>:<event>]` prefix, go to the proxy terminal, and are buffered for
`ccx debug provider logs` / `ccx debug provider logs -f`. Usage JSONL tails with
`ccx debug usage logs [-f]`. Separate from provider buffered logs above.

# Runtime SOT

## Entrypoints

| Path | Responsibility |
| --- | --- |
| `bin/ccx.mjs` (launcher filename; reserved package bins are `codexcommander` / `ccx`) | Node launcher used by locally linked or packaged builds. Resolves the bundled or explicit Bun binary before project dotenv can load, stamps its runtime provenance plus a proof-bound Anthropic parent-env snapshot, then execs `src/cli/index.ts` under Bun. No registry package is currently published. |
| `src/lib/bun-runtime.ts` | Bundled-Bun resolution: `isRealBunBinary()` (size gate vs the ~450-byte placeholder stub), `bundledBunPath()`, and `durableBunPath()` (path baked into service/shim artifacts). Durable selection accepts only the source/path pair already stamped for the running executable; it never re-reads a project-dotenv `CCX_BUN_PATH`. |
| `src/cli/index.ts` | `ccx` / `codexcommander` CLI. Lifecycle: init, start, stop, restart, status, sync, restore/eject, gui, and service. Configuration: provider, account, models, combo/route, access, integrations, v2. Diagnostics: doctor, debug, observe, health. Windows adds tray. The full command surface is `src/cli/help.ts`; this table names the groups, not every verb. After help/version early exits, ordinary commands run the bounded best-effort Codex-shim auto-restore policy before dispatch. Keeps the `#!/usr/bin/env bun` shebang for from-source dev (`bun run src/cli/index.ts`). |
| `src/cli/foreground-proxy.ts` | Foreground proxy startup: parse/bind the requested port, initialize provider/catalog state, serve the proxy, and handle bounded shutdown signals. Ordinary starts enter through shared lifecycle authority; a managed service child uses its explicitly delegated parent boundary. |
| `src/cli/service-command.ts` | Thin service lifecycle controller for install/create, repair, start, stop, status, and uninstall. It holds shared lifecycle authority across native restore, manager operations, delegated proxy shutdown, and final verification; `src/service.ts` remains the OS backend. |
| `src/cli/macos-lifecycle.ts`, `src/cli/proxy-lifecycle.ts` | Fixed, bounded macOS companion lifecycle bridge and shared proxy ownership. Every built app invokes only its embedded `Contents/Resources/runtime`; it never executes checkout `src/` or a global-install fallback. The allowlist includes the separate `applyCodexCatalog` action; it is not an arbitrary shell-command bridge. |
| `src/server/proxy-lifecycle-authority.ts`, `src/server/proxy-lifecycle-protocol.ts` | Canonical lifecycle serialization and its narrow delegated HTTP proof. Authority always acquires Ensure (`E`) before Start (`S`), releases `S` before `E`, and retains `E` while Stop checks for an uncontrolled respawn. The protocol forwards only the exact current lease to the proxy being stopped. |
| `src/codex/routing-document.ts`, `src/codex/native-routing-escape.ts`, `src/codex/routing-transition.ts` | Parse/classify Codex routing once, perform the config-only marker-owned native escape, and own explicit OFF→ON routing transitions. Native escape never consults the recovery journal or transition database; explicit Start/Route Back retires an existing journal only when coordinated stale-owner/surface proof succeeds. |
| `src/server/index.ts` | Bun server entrypoint: `startServer`, `/v1/responses` HTTP + WebSocket routing (compact handled before generic Responses), exact `POST /v1/images/generations` and `POST /v1/images/edits` routing, `/v1/models`, the Anthropic-shaped `/v1/messages` and OpenAI-shaped `/v1/chat/completions` compatibility surfaces, the Live/Realtime surface, the hosted-search relay, artifact serving, `/healthz`, the `/api/*` auth gate, the `/v1/*` JSON 404 guard, GUI fallback, and facade re-exports for split server modules. |
| `src/server/images.ts` | Standalone Images data plane: default OpenAI or explicit custom-provider selection, Codex account affinity, bounded opaque request relay, single-attempt upstream fetch, pool health recording, and safe response/cancellation relay. |
| `src/config.ts` | `~/.codexcommander/config.json`, defaults, PID path, env-value resolution, `websocketsEnabled()`. |
| `src/router.ts` | Provider/model selection before adapter dispatch. |
| `src/types.ts` | Shared config, parsed request, adapter, and event types. |
| `src/reasoning-effort.ts` | Codex reasoning-level definitions (`low`/`medium`/`high`/`xhigh`), per-model effort mapping, and catalog effort sanitization. |
| `src/codex/shim.ts` | Codex autostart shim: replaces the `codex` binary with a wrapper that auto-starts the proxy on demand. It skips startup for management subcommands even when value-taking global flags precede the subcommand, and transactionally restores complete, stable external launcher replacements without a watcher or PATH rediscovery. |
| `src/service.ts` | OS service manager (macOS launchd, Linux systemd, Windows schtasks): always-on proxy with crash restart. |
| `app/`, `scripts/build-macos-app.sh` | Swift/AppKit menu-bar companion and source bundle assembly. The source output is `<repo>/dist/macos/CodexCommander.app`; it is not a second service or an Application Support installation. |

The `src/` root stays thin: public exports (`src/index.ts`), shared config/types,
router, bridge, service manager, reasoning-effort definitions, and the stall-timeout budget live
there. Feature code is grouped by responsibility:

| Group | Directories |
| --- | --- |
| Data plane | `src/adapters/`, `src/responses/`, `src/chat/`, `src/claude/`, `src/grok/`, `src/images/`, `src/vision/`, `src/web-search/` |
| Codex integration | `src/codex/`, `src/combos/`, `src/providers/`, `src/oauth/` |
| Surfaces | `src/server/`, `src/cli/`, `src/tray/` |
| Support | `src/lib/`, `src/storage/`, `src/usage/`, `src/generated/` |

`src/generated/` is build output committed for the runtime; it is not edited by hand.

`src/server/` is split by responsibility: `index.ts` owns the listener and route ordering;
`responses.ts` owns Responses handling and compaction; `images.ts` owns the standalone Images relay;
`management-api.ts` owns `/api/*`;
`lifecycle.ts`, `request-log.ts`, `relay.ts` (incl. the shared `createSseInspector` SSE inspection
factory), `relay-eager.ts` (#314 gated eager bounded passthrough relay), `memory-watchdog.ts`
(warn-only RSS sampler), `management/system-routes.ts` (`/api/system/*`), and `auth-cors.ts` own
server infrastructure (`src/lib/bun-stream-caps.ts` owns the Bun stream-capability gate); and
static GUI, WebSocket bridge, port/liveness, decompression, and adapter-resolution helpers live in
their own files.

## Lifecycle

Explicit starts (`ccx start`, every new companion launch, companion Start, and service
create/`install`/`repair`/`start`) normally enable managed Codex integration, preserve an external
user-managed provider, refuse a duplicate PID, start the proxy, write
`~/.codexcommander/codexcommander.pid`, and sync Codex config/catalog. Automatic `ensure` preserves an
intentional OFF state. Normal standalone shutdown restores native routing. Service mode sets
`CCX_SERVICE=1`, so manager restarts preserve the current route; explicit service stop and uninstall
restore and verify native routing before terminating anything.
In this document, restoring native means removing CodexCommander-owned routing; an external
user-managed Codex provider is preserved.

The fresh direct app-start exception is deliberate: when the app-only bootstrap creates the
CodexCommander config before Codex has created `$CODEX_HOME/config.toml`, it starts the proxy and
dashboard but leaves Codex native and returns `setupRequired: "codex-first-run"`. The companion then
asks the user to open Codex once and choose **Route Codex Through Proxy**. Passive companion `ensure`
does not install or invoke this bootstrap hook; it preserves the existing OFF/native intent.

Direct packaged macOS **Start** is the only lifecycle entrypoint with an app-only configuration
bootstrap. `src/cli/macos-lifecycle.ts` passes `prepareMacOSAppStart` through the canonical lifecycle
authority before config load, liveness probing, routing mutation, proxy launch, or catalog sync. The
authority acquires Ensure (`E`) first; the preparation hook may then acquire the shared config-mutation
lock, preserving the required E-lock → config-mutation-lock ordering. Ordinary CLI `ccx start` and
service paths do not call this hook: they require `ccx init` to have created a configuration and refuse
a missing one.

The app hook validates the canonical secret-free ChatGPT passthrough default and initializes only a
missing CodexCommander config. Publication is create-only/no-clobber: an existing valid, invalid,
unreadable, or unsafe config is never overwritten, and a concurrent race loser adopts the winner's
valid bytes rather than replacing them. If Codex has not created its config yet on this fresh app
start, the proxy and dashboard still run while Codex routing stays native; the result carries
`setupRequired: "codex-first-run"` so the companion tells the user to open Codex once and then choose
**Route Codex Through Proxy**. The hook never creates Codex configuration and never copies provider
secrets, API keys, or OAuth accounts. Existing external Codex providers remain outside its ownership.

The native companion classifies its physical bundle location before dispatching either automatic or
manual Start. `/Applications`, `~/Applications`, and the source-build bundle are stable; ordinary
physical copies such as Desktop or Downloads are relocatable and may run for the current session while
showing neutral move-to-Applications guidance. Users must quit before moving a running app, and the app
never moves itself. True macOS App Translocation blocks Start before proxy launch and requires the user
to move the app and reopen it.

An installed Codex shim is checked on ordinary CLI startup with a regular-file/1 MiB state bound plus
bounded metadata and prefix reads. A complete replacement must produce identical fingerprints and
prefixes across a 100 ms observation interval; changing launchers are silently deferred, while mixed
sibling sets warn and defer as a unit. Guarded repair holds a self-identifying atomic-mkdir
interprocess lock across its final revalidation, rename, shim write, and state commit. Its owner record
uses the unique token as the filename, so stale-owner deletion cannot name a successor's record. An
aged lock is reclaimed only when its owner PID is no longer alive and the same token, lock-directory
identity, and owner fingerprint are still present immediately before deletion. Repair preflights every
tracked sibling before mutation and rolls back earlier siblings in reverse order on a later race.
Failures warn without changing the requested command's exit behavior. The probe uses read-only config
diagnostics only for a confirmed candidate and never reads adjacent auth state.

The bridge enforces a heartbeat stall deadline. It defaults to 300 seconds sampled on a 2 s tick
(`src/stall-timeout.ts`) and is configurable, so treat the number as a default rather than an
invariant; sidecars keep their own clocks. On expiry the stream is closed and the upstream request
cancelled. If the adapter generator ends without an explicit done/error event, the response is marked
`incomplete` rather than `completed` so Codex can distinguish a clean finish from a truncated stream.
On `error` / incomplete / stall / EOF — and when assembled non-freeform tool arguments fail to parse —
an open tool call is cancelled as `status: "incomplete"` without `function_call_arguments.done`, so
the client never sees a completed call ahead of `response.failed` / `response.incomplete`.

The server exposes `POST /api/stop`, which first takes shared lifecycle authority, persists Codex
integration OFF, and applies and verifies the config-only native-routing escape before exiting an
unsupervised proxy. A raw request refuses with `409` when an installed supervisor owns the proxy; the
CLI and tray Stop paths hold the same authority, restore native routing, stop the manager first, and
then delegate the live process shutdown. A failed restore or verification returns `409` and leaves
the service and proxy running.
The escape removes only the proven marker-owned route, its owned catalog pointer, and the resulting
proxy-only root `provider/model` selector; unrelated settings, tasks, history, and authentication stay
untouched. The GUI sidebar stop button calls this endpoint.

[Decision Log]
- 목적과 의도: Prevent repository dotenv data from becoming a durable executable or an OAuth-bearing Claude destination.
- 기존 구현 및 제약 조건: Bun auto-loads project dotenv before CodexCommander TypeScript evaluates, while provider interpolation still depends on that behavior and cannot be disabled globally.
- 검토한 주요 대안: Reject only relative Bun paths; disable Bun dotenv; trust a plain environment marker; capture provenance in the Node launcher and bind it to an argv proof.
- 선택한 방식: The Node launcher selects Bun and snapshots Anthropic credential/destination slots before Bun starts. Durable runtime selection uses only the stamped current executable, while Claude accepts the snapshot only when its random argv proof matches.
- 다른 대안 대신 이 방식을 선택한 이유: Absolute dotenv expansion bypasses a relative-path check, global dotenv removal breaks supported configuration, and an environment-only marker can itself come from dotenv.
- 장점, 단점 및 영향: Node-launcher starts preserve genuine shell overrides. Direct Bun launches without a provenance signal fail closed for all three ambient Anthropic slots — credentials included, because subscription mode leaves `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` unset by design (#253) and a `settings.env` merge can still replace the destination after launch, so a preserved key would travel with it. The cost is that `bun src/cli/index.ts` loses ambient Anthropic values; locally linked or packaged starts through `bin/ccx.mjs` preserve genuine shell exports by proof. Durable artifacts use the running or bundled Bun.

Every new manual or Login Item launch of the macOS companion performs an explicit Start. A failed or
offline start must leave the menu app alive with its status/Start controls available; it cannot
self-terminate just because the proxy is unavailable. Its **Quit** action terminates only the AppKit process. Explicit
**Start** enables Codex routing through the proxy when usable Codex configuration exists. On the
fresh app-first-run path where Codex has not created its config, Start still starts the proxy and
dashboard but leaves Codex native and returns `setupRequired: "codex-first-run"`; it does not enable
routing until the user opens Codex once and chooses **Route Codex Through Proxy**. **Stop** restores and
verifies native routing before termination and keeps the menu app open. **Restart** runs the canonical
stop→start transaction: it restores native routing before terminating the old proxy, then its explicit
Start phase launches the replacement and routes Codex back through it when configuration is usable. A
failed restart leaves Codex native.
**Restore Native Codex** and **Route Codex Through Proxy** change routing without changing proxy
lifecycle.
The main app is the default desktop Login Item; launchd remains an independent optional headless
server supervisor. Login registration never changes provider, proxy, or service configuration.

The launch Start also synchronizes the Codex model catalog. Long-lived Codex workers that loaded
an older roster do not make the proxy unhealthy: the companion keeps a persistent **Agent catalog
update ready** state and offers the separate, confirmation-gated **Apply agent catalog** action.
Applying re-synchronizes the catalog, sends `SIGTERM` only to exact current-user `codex … app-server`
and `codex-code-mode-host` matches, and verifies which old workers exited. The CodexCommander proxy and
menu app remain running. The current companion does not defer this operation until idle; the confirmation uses
fresh request activity only to explain interruption risk, and **Later** leaves the update pending.

## Providers and adapters

| Path | Responsibility |
| --- | --- |
| `src/providers/registry.ts` | Canonical provider presets for CLI, dashboard, OAuth, key providers, and metadata. |
| `src/providers/derive.ts` | Enrichment from provider presets into user config. |
| `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution. |
| `src/adapters/openai-responses.ts` | Native OpenAI/ChatGPT Responses passthrough. |
| `src/adapters/openai-chat.ts` | OpenAI-compatible Chat Completions bridge. |
| `src/adapters/anthropic.ts` | Anthropic Messages bridge. |
| `src/adapters/google.ts` | Gemini bridge. |
| `src/adapters/azure.ts` | Azure OpenAI bridge. |
| `src/adapters/cursor.ts`, `src/adapters/cursor/` | Cursor protobuf transport: discovery, request builder, event decoding, MCP, thread continuity, native-exec policy. |
| `src/adapters/kiro.ts` and its `src/adapters/kiro-*.ts` helpers | Kiro event/tool/thinking/truncation/retry handling. |
| `src/adapters/mimo-free.ts` | Mimo Free transport (client identity + JWT). |
| `src/adapters/image.ts`, `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts` | Image conversion for adapter ingress and Anthropic-specific normalization/limits. |
| `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/upstream-http-error.ts` | Shared adapter execution support: turn queueing, tool-catalog nudging, client identity, upstream error normalization. |

Adapter output must stay in internal `AdapterEvent` form until `bridge.ts` converts it back to
Responses SSE or WebSocket frames.

Live model discovery is bounded and registry-driven through `src/providers/model-discovery.ts`.
Custom providers keep the conventional `${baseUrl}/models` request; canonical presets may select a
trusted URL/path/query and declarative eligibility filter without persisting that policy into user
config. A response is rejected before caching when it exceeds 4 MiB, contains more than 2,000 raw
rows, has a malformed OpenAI list envelope, or includes an invalid model id. Tests use fixtures and
must never depend on live provider endpoints. Newly promoted fixed key presets opt into
`preserveCustomDestination`, so an older same-named custom provider keeps its configured adapter,
destination, and key boundary instead of being silently canonicalized onto the new host. Fixed
OAuth presets resolve discovery against the same canonical registry transport as normal routing
before any adapter-specific transport override, so a stale configured `baseUrl` cannot receive an
OAuth bearer token.

---
title: Management API
description: Authentication, errors, and endpoint reference for the CodexCommander control plane.
---

The Management API is CodexCommander's control plane. The dashboard at
`http://localhost:10100` is one client of it; headless `ccx` provider, model, combo, account,
settings, diagnostics, and lifecycle commands are clients too. The API is available only while the
proxy is running.

Use the [Web Dashboard](/guides/web-dashboard/) for an interactive client, or this reference when
building automation. Persistent values ultimately follow [Configuration](/reference/configuration/).

## Authentication model

The Management API has its own admin credential, independent of data-plane API keys. At startup,
CodexCommander resolves it in this order:

1. `CODEXCOMMANDER_ADMIN_AUTH_TOKEN`, when set.
2. A generated `ccx_admin_*` token in a hardened secret file.

The file-backed token is accepted only after its directory and file permissions or ACLs have been
hardened. If that cannot be guaranteed, management authentication fails closed and the API returns
503 until an environment token is supplied or the file state is repaired.

Headless API clients send the admin token over a trusted transport in either form:

```http
X-CodexCommander-API-Key: <admin-token>
```

```http
Authorization: Bearer <admin-token>
```

:::caution
The admin token must differ from every data-plane credential. Startup rejects a management
credential that conflicts with a proxy admission key. Do not put the admin token in Codex,
Claude Code, or another model client; it authorizes control-plane mutations. A browser may request
it only on a trusted non-loopback HTTPS origin. Never paste or send it from a plaintext remote page.
:::

### Dashboard launch sessions

A manually opened loopback dashboard receives no API credential. The static page shell can load, but
every `/api/*` request is authenticated and therefore returns `401` until the user reopens the page
through `ccx gui` or the macOS menu app. A loopback page never prompts for or sends the durable admin
token; loopback is not an authenticated listener identity or an authentication bypass.

Those launchers use the raw admin credential to mint a short-lived, single-use ticket bound to the
requested route and origin. The ticket travels only in the URL fragment and is removed immediately
during its one-time exchange. The resulting confirmed GUI session is full-featured, kept in server
process memory, and valid for at most eight hours. The browser mirrors only its session token, CSRF
token, exact origin, and absolute expiry in `sessionStorage`, so a refresh can rehydrate it
while the server session remains valid. It is never renewed: expiry, proxy restart, or a rejecting
`401` clears that browser record, after which the local launcher flow is required again. Neither the
durable admin token nor the launch ticket enters browser storage, and authentication never uses
`localStorage`. Same-origin script can read `sessionStorage`, so this convenience is not OS-user
isolation. Browsers may copy the record into duplicated or opener-created tabs, or restore it with a
restored tab; every copy remains bound to the exact origin and CSRF token and is usable only until the
fixed server expiry, a proxy restart, or a rejecting `401`.

The raw admin bearer remains valid for ordinary API mutations. Catalog Apply and managed delegation
writes are deliberately stricter: `POST /api/codex-catalog/apply` and
`PUT, DELETE /api/codex-delegation` accept only a confirmed GUI session. Scripts use
`ccx sync --restart-codex` for catalog activation; delegation status remains readable and the
dashboard provides a manual copy fallback when its local installer is unavailable.

A remote operator browser may authenticate with the raw admin token only over trusted HTTPS; a
plaintext remote page never prompts for or sends it. Without trusted HTTPS, use a local or SSH tunnel
that presents loopback and open the dashboard through `ccx gui`. Headless API clients retain raw-admin
authentication over a trusted transport. Confirmed browser sessions are minted only by the
exact-origin, exact-route local launch-ticket exchange.

## Common errors

All endpoint rows below inherit these boundary errors. The “Notable errors” column lists additional
route-specific results rather than repeating this table.

| Status | Type or code | Meaning |
| --- | --- | --- |
| 401 | `codexcommander admin token required` | The admin token or GUI session is missing, invalid, expired, origin-mismatched, or missing CSRF evidence |
| 403 | `cross-origin request blocked` | The request origin is outside the management allowlist |
| 404 | `not_found` | No management route matched the method and path |
| 413 | `request body too large` | A POST, PUT, or PATCH body exceeds the 2 MiB management limit |
| 503 | `management API unavailable` | Admin credential initialization or hardening is unavailable |
| 503 | `oauth_mutation_busy` | Another OAuth credential mutation holds the writer; response includes `Retry-After: 1` |
| 503 | `catalog_busy` | Catalog gathering is already at capacity; response includes `Retry-After: 1` |

## Endpoint matrix

### Agent and client settings

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET, PUT /api/v2` | Read or change the agent protocol, V2 task-message delivery, and thread settings. A protocol/thread boot-config change needs **Apply agent catalog** to replace a running worker, then a new task for its session-bound tool shape. `multiAgentV2MessageDelivery` accepts `plaintext` or the `encrypted` default; sending `encrypted` or `null` removes the explicit plaintext override. Delivery changes need only a new task and do not dirty the catalog. `maxConcurrentThreadsPerSession: null` restores the Codex default | 400 invalid settings; 502 transition or persistence failure |
| `GET, PUT /api/injection-model` | Read or set the preferred guidance model, effort, prompt, and guidance settings; this is advisory unless native-default sync is enabled | 400 invalid model, effort, or body |
| `GET, PUT /api/effort-caps` | Read or set global and sub-agent reasoning-effort ceilings | 400 invalid ladder value |
| `GET, PUT, PATCH /api/subagent-models` | Read or order up to five requested `spawn_agent` quick picks; this does not force routing. `GET` keeps the legacy `chosen: string[]` and adds ordered `roster` objects. `PUT` accepts exactly one of `roster` (objects with optional guidance) or legacy `models` (strings); a `models` write preserves guidance for models that remain. `PATCH` atomically changes one existing row's guidance without replacing the rest of the roster. Responses report the effective `advertised` list, any `excluded` choices, and additive `activation` evidence for the desired config, on-disk catalog, and running Codex worker | 400 invalid list, object, guidance, or more than five models; 404 unknown PATCH model |
| `GET, PUT /api/subagent-model-fallback` | Read or set the ordered global fallback chain for spawned child turns and its poll interval | 400 invalid list or poll interval |
| `GET, PUT, DELETE /api/codex-delegation` | Read managed advisory-delegation status, install/update one exact mode, or remove the two managed artifacts. GET accepts normal authenticated principals; PUT/DELETE require a confirmed GUI session with same-origin CSRF and reject a raw admin principal with 403 | 400 invalid PUT body or nonempty DELETE body; 403 confirmed dashboard launch required; 409 conflict/unsafe/concurrent-change refusal; 500 write or partial-write failure; 503 `mutation_busy` (`Retry-After: 1`) |
| `GET /api/grok` | Read Grok managed-config status and candidate models | 400 status read failure |
| `PUT /api/grok/selection` | Persist the excluded Grok models | 400 invalid or oversized selection |
| `POST /api/grok/apply` | Apply persisted Grok configuration through the managed sync | 409 `grok_apply_busy`; 400/500 apply failure |
| `GET, PUT /api/claude-desktop` | Read or persist the Claude Desktop routed/native profile | 400 invalid or unavailable assignment |
| `POST /api/claude-desktop/apply` | Write the saved profile to Claude Desktop's managed config. Requires a JSON object with an explicit `mode`: `static`, `hybrid`, or `discovery` | 400 missing/invalid body or mode; 500 write failure |
| `GET /api/claude-desktop/status` | Inspect saved-versus-applied profile and Desktop health | 400 status read failure |
| `GET, PUT /api/claude-code` | Read or update Claude Code gateway, auth-mode, model-map, context, agent, and sidecar settings | 400 invalid field or shape |

For the concepts behind the model roster and encrypted worker-task behavior, see
[Sub-agent Surface](/guides/sub-agent-surface/).

#### Roster object shape and compatibility writes

`GET /api/subagent-models` returns both a compatibility projection and the canonical roster:

```json
{
  "chosen": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "roster": [
    { "model": "gpt-5.5" },
    { "model": "anthropic/claude-sonnet-5", "guidance": "Use for short research tasks." }
  ],
  "available": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "advertised": ["gpt-5.5", "anthropic/claude-sonnet-5"]
}
```

The roster is ordered and capped at five entries. Each object has a canonical `model` selector and
an optional sanitized `guidance` string. Empty guidance is omitted; nonempty guidance is limited to
160 Unicode code points. Guidance is advisory, untrusted operator text. It is included only in live
V2 developer guidance after the current surface, visibility, route, and encrypted-task compatibility
filters. Built-in V2 guidance includes every accepted annotation that survives those filters. It
cannot control effort, quotas, roles, or fallback behavior.

`PUT /api/subagent-models` accepts exactly one top-level field: either the canonical object form or
the legacy string form. A guidance-bearing write uses:

```json
{
  "roster": [
    { "model": "gpt-5.5" },
    { "model": "anthropic/claude-sonnet-5", "guidance": "Use for short research tasks." }
  ]
}
```

For compatibility clients, `{ "models": ["gpt-5.5", "anthropic/claude-sonnet-5"] }` remains
valid as a request shape and preserves existing guidance for matching models. Every successful roster
write—including a compatibility `models` write—persists the canonical object array. Therefore any
successful write can be the durable migration point after which older CodexCommander binaries that
only read `string[]` fail when they next read the configuration. The dashboard's Save action always
sends `{ "roster": [...] }` so guidance is not lost.

For a guidance-only edit, use `PATCH /api/subagent-models` with exactly one model selector and
guidance value. Send a string to set or replace the note, or `null` to clear it:

```json
{ "model": "anthropic/claude-sonnet-5", "guidance": "Use for short research tasks." }
```

This mutation is field-scoped and rebases against the newest persisted roster, so concurrent
reorders, model changes, and notes on other rows are preserved. The selected model must already
exist in the roster.

#### Catalog activation

The sub-agent roster has three separate facts: the **desired** saved configuration, the
deterministically generated **on-disk** catalog, and the model catalog loaded by a **running Codex
worker**. Saving a roster or calling `/api/sync` updates the first two without interrupting active
work. A task or fork created through an already-running Codex Desktop app-server does not cause it
to reload the catalog.

Use `GET /api/codex-catalog/status` to decide whether anything is pending. If the endpoint can
identify verified stale workers, an operator using a confirmed dashboard launch may call
`POST /api/codex-catalog/apply` with the status response's `expectedDesiredRevision` and explicit
`confirmInterrupt: true`. Activity count is
advisory only: an unknown worker identity blocks signaling, while a nonzero count warns about an
interruption but does not prohibit an informed Apply. Results distinguish already-current, no-worker,
applied, partial, superseded, and blocked outcomes. The endpoint never accepts a PID, command, or
path from the caller, never queues an idle apply, and does not persist a separate activation
snapshot.

For scripts or the native companion, `ccx sync --restart-codex` remains the compatible advanced
fallback. Quitting and reopening Codex Desktop is the reliable manual worker-replacement boundary.

#### Managed Codex delegation setup

`/api/codex-delegation` is a focused management resource for the advisory user skill and bounded
global `AGENTS.md` block. It is separate from `/api/v2`, `subagentDeveloperInstructions`, native
`[agents]` defaults, roster injection, and the catalog lifecycle. It changes no Codex config, never
restarts a worker, and never replaces the CodexCommander proxy. Current Codex tasks do not reload the
managed block; start a new task after a successful install, update, mode change, repair, or removal.

`GET` is authenticated and read-only. A raw admin client or a confirmed GUI session can read it:

```http
GET /api/codex-delegation HTTP/1.1
Host: localhost:10100
X-CodexCommander-API-Key: <admin-token>
```

The response uses only symbolic paths and fixed public states. This abridged example omits the
canonical packaged preview and manual-copy text; the live `previews` and `copyPrompts` fields contain
generated setup content, never the existing user `AGENTS.md`, an override file, or an inspected
absolute path.

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json

{
  "schemaVersion": 1,
  "state": "current",
  "installedMode": "balanced",
  "artifacts": {
    "skill": {
      "state": "current",
      "displayPath": "$HOME/.agents/skills/codexcommander-delegation/SKILL.md"
    },
    "agentsPolicy": {
      "state": "current",
      "displayPath": "$CODEX_HOME/AGENTS.md"
    }
  },
  "override": { "state": "absent" },
  "activation": "effective"
}
```

`PUT` accepts exactly one safe public field, `mode`, with the stable value `balanced` or
`orchestrator`. A confirmed GUI session must supply its exact origin claim, browser `Origin`, and
CSRF token. These placeholders illustrate the launch-session exchange; do not substitute a raw
admin token because that principal receives 403 before the body is consumed.

```http
PUT /api/codex-delegation HTTP/1.1
Host: localhost:10100
Origin: http://localhost:10100
X-CodexCommander-API-Key: <confirmed-gui-session-token>
X-CodexCommander-GUI-Origin: http://localhost:10100
X-CodexCommander-CSRF-Token: <confirmed-gui-csrf-token>
Content-Type: application/json

{ "mode": "orchestrator" }
```

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json

{
  "ok": true,
  "changed": true,
  "status": {
    "schemaVersion": 1,
    "state": "current",
    "installedMode": "orchestrator",
    "artifacts": {
      "skill": {
        "state": "current",
        "displayPath": "$HOME/.agents/skills/codexcommander-delegation/SKILL.md"
      },
      "agentsPolicy": {
        "state": "current",
        "displayPath": "$CODEX_HOME/AGENTS.md"
      }
    },
    "override": { "state": "absent" },
    "activation": "effective"
  }
}
```

`DELETE` accepts no request body and uses the same confirmed-session origin and CSRF headers:

```http
DELETE /api/codex-delegation HTTP/1.1
Host: localhost:10100
Origin: http://localhost:10100
X-CodexCommander-API-Key: <confirmed-gui-session-token>
X-CodexCommander-GUI-Origin: http://localhost:10100
X-CodexCommander-CSRF-Token: <confirmed-gui-csrf-token>
```

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json

{
  "ok": true,
  "changed": true,
  "status": {
    "schemaVersion": 1,
    "state": "not-installed",
    "installedMode": null,
    "artifacts": {
      "skill": {
        "state": "absent",
        "displayPath": "$HOME/.agents/skills/codexcommander-delegation/SKILL.md"
      },
      "agentsPolicy": {
        "state": "absent",
        "displayPath": "$CODEX_HOME/AGENTS.md"
      }
    },
    "override": { "state": "absent" },
    "activation": "effective"
  }
}
```

The stable status enums are:

| Field | Values |
| --- | --- |
| `state` | `not-installed`, `current`, `update-available`, `partial`, `conflict`, `unsafe` |
| `artifacts.*.state` | `absent`, `current`, `outdated`, `foreign`, `unsafe` |
| `artifacts.*.reason` | `ownership_conflict`, `unsafe_path` when present |
| `override.state` | `absent`, `empty`, `active`, `unsafe` |
| `activation` | `effective`, `shadowed`, `unknown` |
| `installedMode` | `balanced`, `orchestrator`, or `null` |

A refused mutation returns `{ "ok": false, "changed": boolean, "reason": enum, "status": ... }`.
Its stable `reason` values are `foreign_skill`, `ambiguous_agents_markers`, `unsafe_path`,
`unreadable`, `invalid_utf8`, `too_large`, `changed_during_mutation`, `mutation_busy`,
`write_failed`, and `partial_write`. `mutation_busy` returns 503 with `Retry-After: 1`;
`write_failed` and `partial_write` return 500; the other mutation refusals return 409. A
`partial_write` response reports `changed: true`, while successful compensation reports
`changed: false` with the original refusal reason. Every response remains `Cache-Control: no-store`.

The setup uses fixed filesystem targets and exposes no caller-selected path. Installation writes the
skill before the policy block; removal deletes the policy block before the skill. It recognizes the
skill only through its embedded ownership metadata and the policy only through its stable bounded
marker pair. No hash, manifest, or hidden ownership file is created. Linked, nonregular, multi-link,
ambiguous, or concurrently changed targets fail closed; bytes outside the bounded policy block are
preserved. If the second artifact fails, the installer compensates the first when safe and otherwise
reports a partial write.

A nonempty `$CODEX_HOME/AGENTS.override.md` makes `activation: "shadowed"`; it is reported, never
modified. The skill carries no roster ids and consults the live collaboration contract. It is
advisory, and live tool guidance plus user or repository instructions remain authoritative about
whether delegation is allowed.

### Combos

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/combos` | List normalized combos and their public model ids | Catalog work can return `catalog_busy` |
| `PUT /api/combos` | Create, replace, or rename one combo | 400 invalid id, target, config, rename, or ordinary collision; 409 Codex-account namespace collision |
| `DELETE /api/combos?id=...` | Delete one combo and clear its selection/cooldown state | 400 missing id; 404 unknown combo |

See [Combos](/guides/combos/) for target strategies, cooldowns, aliases, and routing failures.

### Configuration, startup, and sync

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/config` | Return the redacted, management-safe configuration DTO | — |
| `PUT /api/config` | Disabled full-config replacement guard | 405; use focused endpoints instead |
| `GET, PUT /api/settings` | Read runtime/startup settings or update auto-start, stream mode, and app-owned memory budget | 400 invalid or empty update |
| `GET /api/startup-health` | Read cached base startup health decorated with current companion evidence | — |
| `PUT /api/startup-health/companion` | Refresh the native companion's memory-only Launch at Login lease; raw admin-token principal only | 400 invalid report; 403 GUI session or non-admin principal |
| `POST /api/startup-action` | Install or repair the service or Codex shim | 400 invalid action; 500 action failure |
| `GET, POST /api/windows-tray` | Read Windows tray state or install/start/stop/uninstall it | 400 unsupported platform/action; 500 operation failure |
| `GET /api/diagnostics/project-config` | Read cached project configuration warnings | — |
| `POST /api/sync` | Sync the current model catalog into Codex without interrupting workers; returns `catalogQuality` (`live`, `retained`, or `native-only`), `rehydrated`, current Codex app-server `catalogState`, and additive `activation` evidence | 409 refused write authority; 500 failed sync |
| `GET /api/codex-catalog/status` | Read the catalog activation state: desired configuration revision, deterministic on-disk catalog evidence, and whether verified current-user Codex workers have loaded it | — |
| `POST /api/codex-catalog/apply` | Explicitly converge then apply the current catalog to verified stale Codex workers. The body must be `{ "expectedDesiredRevision": "…", "confirmInterrupt": true }`; the revision fence prevents applying a superseded choice. This browser endpoint accepts only the confirmed GUI session created by the single-use launch handoff | 400 invalid confirmation/body; 403 confirmed dashboard launch required; 409 superseded or unsafe worker identity; 503 apply busy (`Retry-After: 1`) |
| `GET, PUT /api/sidecar-settings` | Read or update web-search and vision sidecar model/backend settings | 400 invalid shape, backend, or limit |
| `GET, PUT /api/shadow-call-settings` | Read or update shadow-call interception settings | 400 invalid shape or value |

### Logs, usage, and storage

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/logs` | Query filtered in-memory request logs | — |
| `GET, PUT /api/debug` | Read debug flags; set, clear, or reset capture categories | 400 invalid or empty update |
| `GET /api/debug/logs` | Read bounded provider/debug log entries | — |
| `GET /api/debug/usage-logs` | Read bounded usage-debug entries | — |
| `GET /api/debug/injection-logs` | Read bounded guidance-injection debug entries | — |
| `GET /api/claude/inbound-debug` | Read Claude inbound debug state and entries | — |
| `GET /api/usage` | Summarize usage by range and client surface | 503 `{ error: "read_failed", range, surface }` if the usage log cannot be read; a missing log file still returns 200 with a zeroed summary |
| `GET /api/storage` | Scan Codex storage usage by bucket | Returns an `error: "scan_failed"` payload on scan failure |
| `POST /api/storage/cleanup/preview` | Preview archived-session cleanup and return a binding digest | 400 `invalid_json` or `invalid_percent` |
| `POST /api/storage/cleanup` | Quarantine or permanently remove the previewed archived set | 400 invalid input; 409 stale/busy/referenced state; 500 filesystem/database failure |
| `GET /api/storage/trash` | List quarantined cleanup entries | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | Restore one quarantined entry | 400 invalid id; 404 missing trash; 409 busy/destination conflict; 500 restore failure |
| `GET /api/storage/trash/restore/test-stream` | Test-only restore stream hook | 404 `not_available` when test hooks are off |
| `GET, PUT /api/storage/cleanup-policy` | Read or update scheduled cleanup policy and job state | 400 invalid policy |
| `POST /api/storage/cleanup-policy/run` | Start a manual cleanup-policy run | 409 `already_running`; 500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | Test-only policy stream hook | 404 `not_found` when unavailable |

:::caution
Storage cleanup endpoints can move or permanently remove archived session data. Always preview
first and submit the returned digest. Prefer quarantine when recovery may be needed.
:::

### Models and catalog

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/catalog` | Return the installed Codex catalog document | 404 catalog not found |
| `GET /api/models` | Return the dashboard/CLI model rows | `catalog_busy` when gathering is saturated |
| `GET /api/client-config?client=...` | Build a read-only OpenCode or Pi client-config document | 400 unsupported client; 503 catalog unavailable |
| `PUT /api/disabled-models` | Replace the shared disabled-model list | 400 invalid JSON |
| `PUT /api/model-visibility` | Atomically change provider- or model-level visibility | 400 invalid provider, scope, target, or body |
| `GET, POST /api/custom-models` | List custom models or add one | 400 invalid fields; 404 provider missing; 409 duplicate model |
| `PUT, DELETE /api/custom-models/{id}` | Edit or delete one custom model | 400 invalid id/fields; 404 not found; 409 duplicate model |
| `GET, PUT /api/selected-models` | Read provider allowlists and availability, or replace one allowlist | 400 missing provider/body; 404 unknown provider |

### OpenCode integration

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/integrations/opencode` | Read OpenCode installation detection, managed-connection state, target config path, auto-refresh setting, and OpenCode Go key-verification state | — |
| `POST /api/integrations/opencode/apply` | Generate and surgically apply only `provider.codexcommander` to the active OpenCode global JSONC/JSON config; accepts optional `{ "autoConnect": boolean }` | 400 invalid body; 409 malformed, changed, or unsafe external config |
| `PUT /api/integrations/opencode` | Enable or disable opt-in catalog/startup refresh after a connection has been applied | 400 invalid body; 409 no applied connection |
| `POST /api/integrations/opencode/restore` | Restore the exact pre-Apply bytes when safe, or surgically restore/remove only the managed provider; optional full mode requires current-hash confirmation | 400 invalid mode/body; 409 changed or unsafe external config |
| `POST /api/integrations/opencode/open` | Apply when needed, then one-click launch detected OpenCode Desktop | 409 missing Desktop or integration needs attention |

The persistent integration owns a protected token file under CodexCommander state and a journal/backup;
the OpenCode config receives a `{file:…}` reference, never a serialized proxy key. The API never
rewrites OpenCode's other config paths or reads its auth store. See [OpenCode](/guides/opencode/) for
the user workflow.

### OAuth accounts, provider keys, and data-plane keys

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/oauth/providers` | List providers with public OAuth login flows | — |
| `GET /api/key-providers` | List providers configured through API-key login | — |
| `POST /api/oauth/login` | Start an OAuth login or account-add flow | 400 unknown/invalid provider; `oauth_mutation_busy` |
| `POST /api/oauth/login/code` | Submit a manual callback URL or authorization code | 400 invalid provider/code; `oauth_mutation_busy` |
| `POST /api/oauth/login/cancel` | Cancel a public in-progress OAuth flow | 400 unknown provider |
| `GET /api/oauth/status` | Poll one provider's OAuth flow | 400 unknown provider |
| `POST /api/oauth/logout` | Remove the selected provider credential. | 400 unknown provider; `oauth_mutation_busy` |
| `GET, DELETE /api/oauth/accounts` | List masked accounts or remove one account. | 400 invalid provider/id; 404 account missing; `oauth_mutation_busy` |
| `PUT /api/oauth/accounts/active` | Select the active OAuth account. | 400 invalid provider/account; `oauth_mutation_busy` |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | Read or update Anthropic OAuth pool policy | 400 non-Anthropic provider or invalid policy |
| `POST /api/oauth/accounts/clear-cooldown` | Clear one OAuth account's runtime cooldown | 400 invalid provider/account |
| `PUT /api/oauth/accounts/alias` | Set or clear an OAuth account alias | 400 invalid provider/account/alias |
| `GET, POST, DELETE /api/providers/keys` | List masked provider keys, add/activate one, or remove one. | 400 invalid input; 404 provider/key missing |
| `PUT /api/providers/keys/active` | Select a provider's active key. | 400 invalid input; 404 provider/key missing |
| `PUT /api/providers/keys/alias` | Set or clear a provider-key alias. | 400 invalid input; 404 provider/key missing |
| `GET, POST, PATCH, DELETE /api/keys` | List, create, edit, or delete data-plane admission keys | 400 invalid body/id; 404 key missing |

Credential list responses are deliberately masked. OAuth access tokens and complete provider API
keys are not returned to dashboard clients.

### Providers

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/providers` | List redacted provider configuration and discovery state | — |
| `POST /api/providers` | Add or replace one validated provider and optionally make it default | 400 invalid/dangerous destination or config; 409 namespace collision |
| `PATCH /api/providers?name=...` | Update allowed provider fields (including a merged `headers` block), enabled/default state, or OpenAI account mode. | 400 invalid field or transition; 404 unknown provider |
| `DELETE /api/providers?name=...` | Delete a provider, reassigning the default when possible | 404 unknown provider; 409 `last_provider`; 409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` | Perform a bounded live provider connectivity/model-discovery probe | 404 unknown provider; failures are normally returned as `ok: false` evidence |
| `GET /api/provider-quotas` | Read provider quota reports; `refresh=1` forces refresh | — |
| `GET, PUT /api/provider-context-caps` | Read or update global, all-provider, or one-provider context caps | 400 invalid request; 404 unknown provider |
| `GET /api/provider-presets` | Return GUI provider presets derived from the runtime registry | — |

`PUT /api/provider-context-caps` accepts a positive integer `value`, boolean `setAll`, or the
per-provider `{ provider, enabled }` shape. `value` and `setAll` may be sent together to apply a
shared value atomically.

`provider_has_dependent_combos` is a safety barrier: remove or edit the dependent combos before
deleting their provider.

### System lifecycle

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/system/memory` | Return scalar process, heap, stream, response-state, watchdog, and active-turn metrics | — |
| `POST /api/system/restart` | Spawn the detached canonical restart helper. It safely stops the proxy (restoring native Codex and persisting routing OFF), then explicitly starts it again (routing ON) | 202 helper spawn accepted/already accepted; 409 helper spawn refused (the current endpoint stays live and retryable) |
| `POST /api/stop` | Persist integration OFF, prove native Codex routing, remove managed Grok injection, and drain an unsupervised proxy. An installed supervisor must be stopped first by the delegated CLI/tray flow | 409 lifecycle busy, unsafe native restore, or installed supervisor ownership |

### Codex authentication delegation

The root management dispatcher delegates every `/api/codex-auth/*` request to the Codex account
manager. Its routes are:

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | List/refresh, optionally import, or delete Codex accounts | 400 invalid input; manual import can be disabled |
| `PUT /api/codex-auth/accounts/alias` | Set or clear an account alias | 400 invalid account/alias |
| `PUT /api/codex-auth/accounts/pause` | Pause or resume one account | 400 invalid account/state; 404 missing account |
| `PUT /api/codex-auth/accounts/pause-exhausted` | Pause accounts whose quota is exhausted | Mutation-lock failures become 503 |
| `POST /api/codex-auth/accounts/clear-cooldown` | Clear runtime cooldown for one account or all accounts | 400 invalid id |
| `GET, PUT /api/codex-auth/active` | Read or select the active account | 400 invalid or missing account; 409 paused account |
| `PUT /api/codex-auth/auto-switch` | Set the quota threshold for automatic account switching | 400 invalid threshold |
| `PUT, PATCH /api/codex-auth/pool-strategy` | Update Codex account-pool selection strategy | 400 invalid strategy/config |
| `PUT /api/codex-auth/failover` | Set the account failover threshold | 400 invalid threshold |
| `GET /api/codex-auth/quota` | Read cached quota state by account | — |
| `GET /api/codex-auth/reset-credits` | Inspect reset-credit eligibility for an account | 400 missing account id; upstream status passthrough; 500 lookup failure |
| `POST /api/codex-auth/reset-credits/consume` | Consume an eligible reset credit | 400 missing account id; upstream status passthrough; 503 `server_busy`; 500 consume failure |
| `POST /api/codex-auth/login` | Start Codex login or reauthentication | 400 invalid request; conflict/busy login states |
| `POST /api/codex-auth/login/code` | Submit a manual code for a Codex login flow | 400 invalid flow/code |
| `POST /api/codex-auth/login/cancel` | Cancel a Codex login flow | — |
| `GET /api/codex-auth/login-status` | Poll a flow or account login state | Unknown flows report `expired`; no active flow reports `idle` |

Configuration-writer or credential-refresh lock timeouts under this delegated family return HTTP
503 with code `CONFIG_MUTATION_LOCK_UNAVAILABLE`. Clients should retry shortly rather than treating
that response as a permanent account failure.

## Choosing a client

For ordinary administration, the [Web Dashboard](/guides/web-dashboard/) gives the safest guided
workflow. For headless hosts and automation, use the corresponding `ccx` commands: they call this
same live API and return a nonzero result when the proxy is unreachable or the operation fails.
Direct HTTP is most useful for integrations that need the exact endpoint contracts above.

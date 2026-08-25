---
title: Web Dashboard
description: The CodexCommander GUI for proxy health, providers, models, delegation guidance, auth pools, usage, and logs.
---

CodexCommander ships a local web dashboard (a Vite/React app under `gui/`) served from the proxy. It is the
shortest path to managing providers, Codex/ChatGPT accounts, catalog models, sidecars, sub-agent
settings, and request traffic.

## Opening it

```bash
ccx gui
```

This opens `http://localhost:<port>` in your browser, auto-starting the proxy first if needed. In
development you can run the GUI dev server separately against a running proxy:

```bash
ccx start
bun run dev:gui
```

## Sign-in

A dashboard opened directly through any loopback form—`localhost`, `*.localhost`, any address in
`127.0.0.0/8`, `::1`, or an IPv4-mapped `127/8` address—receives no API credential. The page shell
can load, but its API requests remain unauthorized. Reopen it with `ccx gui` or the macOS menu app.
A loopback page never asks for or transmits the durable admin token because another local OS user
could impersonate an inactive listener. Loopback browser access requires a confirmed launcher
session; loopback is not an authentication bypass.

For the full dashboard, open it with `ccx gui` or the macOS menu app. The launcher uses admin authority
to mint a short-lived, single-use ticket, puts only that ticket in the URL fragment, and the dashboard
removes it immediately as it exchanges it for a confirmed session. The server keeps that session in
process memory for up to eight hours. The browser mirrors only its session token, CSRF token, origin,
and absolute expiry in `sessionStorage`, so refreshing keeps working while
the server session remains valid. The session is never renewed. Expiry, a proxy restart, or a rejecting
`401` clears the browser record and requires a new launcher handoff. Neither the durable admin token
nor the launch ticket enters browser storage, and authentication never uses `localStorage`.

Same-origin script can read `sessionStorage`. This small reload convenience is therefore not OS-user
isolation; it does not replace the launcher's listener check or the server's origin and CSRF checks.
Browsers may copy the record into duplicated or opener-created tabs, or restore it with a restored
tab; every copy remains bound to the exact origin and CSRF token and is usable only until the fixed
server expiry, a proxy restart, or a rejecting `401`.

A dashboard bound to a non-loopback hostname may use the admin token
(`CODEXCOMMANDER_ADMIN_AUTH_TOKEN`, or the auto-generated `~/.codexcommander/admin-api-token` file),
but the browser prompt is enabled only on a trusted HTTPS origin. A plaintext remote page never asks
for or sends the bearer. Without trusted HTTPS, use a local or SSH tunnel that presents the dashboard
as loopback, then open it through `ccx gui`. Raw admin remains available to headless management API
clients, but catalog Apply and managed delegation install/remove are deliberately restricted to a
confirmed local dashboard launch.

On trusted HTTPS, a remote dashboard presents a standard password form so a browser password manager
can offer to save and autofill the credential. The dashboard itself still keeps that raw admin token
only in memory and does not write it to `localStorage` or `sessionStorage`; whether it is saved is entirely
the browser or password manager's decision.

## What you can do

| Area | What it does |
| --- | --- |
| **Dashboard summary** | Multi-agent mode, online state, version, uptime, provider count, 30-day token total and estimated list-price cost, active providers, and available native/routed models. |
| **Sub-agent delegation** | Choose a native or routed model and optional reasoning effort shared by CodexCommander delegation guidance and the separate native-default opt-in. This is not a proxy-side per-spawn router; see below. |
| **Sidecars** | Choose the web-search model and effort plus the vision-description model. Changes apply on the next request. |
| **Maintenance** | Resync the Codex model catalog and inspect project-local config bypass warnings. |
| **Startup** | Show whether routing is started by the CodexCommander app, a background service, or a launcher shim. The normal macOS app setup is **App-managed**; the service is offered separately as optional crash recovery. Advanced repair commands stay available without dominating the page. |
| **Windows tray** | Install a per-user login tray for one-click proxy start, stop, restart, dashboard access, and status. The tray is a controller, not a proxy restart service. |
| **Codex autostart** | Allow an already-installed Codex launcher shim to run `ccx ensure`. This toggle does not install a shim or background service. |
| **Providers** | Add, edit, set the default (enabled providers only), enable/disable, and remove providers; manage OAuth account pools and API-key pools where supported. Removing the current default switches to the first remaining enabled provider when one exists; otherwise deletion is refused and the current default is kept. Provider Settings can disable live model discovery for endpoints with missing, slow, or oversized `/models` catalogs. For Claude (Anthropic) OAuth pools, each logged-in account shows its own 5-hour and weekly rate-limit bars (usage is per credential); a failed probe keeps the last-known bars and marks them unavailable until the next successful refresh. |
| **Add provider** | Search registry-backed presets for account login, API-key services, local servers, or a custom endpoint. A query searches Accounts, Free and Paid together while the tabs remain useful for browsing. |
| **Codex Auth** | Add ChatGPT/Codex pool accounts, select the next-session account, refresh 5h / weekly / 30d quotas, enable or disable quota auto-switch, set its 1–100% threshold, and configure transient-failure failover. |
| **Subagents** | Open the **Agent Command Center** to choose and order up to five models advertised to `spawn_agent`, add optional per-model advisory guidance, search the current catalog, configure Run Policy, and install the optional advisory Codex delegation setup. Save sends the ordered `{ roster: [{ model, guidance? }] }` form. Saved entries that are not advertised are reported explicitly. Its status distinguishes saved configuration, the generated on-disk catalog, and the roster loaded by current Codex workers. |
| **Models** | Toggle native GPT and routed models, set provider allowlists and context caps, choose **Reliable V1**, **Codex native**, or **Concurrent V2**, and configure the V2 thread limit. The Current behavior card reports context as **Uncapped**, **Limited**, or **Mixed limits**. Configured providers stay visible as zero-model groups when discovery is off or returns no rows. Each routed-provider row reports **Auto-discovery on** or **Static catalog only** and links to the owning Provider setting. |
| **Client Apps** | Inspect configured and available local clients, apply or remove managed config where supported, review backups, and reach Codex, Claude Code/Desktop, Grok Build, OpenCode and the file-managed clients without treating providers as clients. |
| **API Access** | Issue and manage keys that authenticate other apps to the CodexCommander proxy. Provider credentials remain under Providers. |
| **Logs** | Auto-refresh recent requests with tokens, requested → sent outbound effort, resolved model, provider, status, request id, duration, and error details. The detail view includes the exact sent reasoning wire field when the adapter emits one. “Sent” is what CodexCommander serialized; it does not prove that the provider accepted, honored, or applied that effort. Filter by opaque conversation/session id (when the client sends one) to total tokens and estimated list-price cost for the currently loaded Logs ring. |
| **Usage / Debug** | Inspect token-usage coverage and trends, or enable opt-in provider transport and usage-extraction diagnostics. |
| **Storage** | Read-only CODEX_HOME disk breakdown (sessions, archives, DBs, attachments). Optional archived cleanup: preview the oldest N%, then quarantine to `CODEX_HOME/.trash` (default) or permanently delete behind an explicit checkbox. **Auto-cleanup policy** is opt-in and **default OFF** (`storageCleanupPolicy.enabled`); configure threshold/target/schedule/mode on the Storage page, or trigger **Run now**. Quarantined entries can be restored from the Storage page (JSONL + threads). Active sessions stay read-only. Cleanup and restore are refused while Codex holds the newest/active `state_*.sqlite` locked. |
| **Stop** | Persist integration OFF, restore and verify native Codex, then stop an unsupervised proxy (`POST /api/stop`). If an installed supervisor owns it, the raw API refuses; use tray or CLI Stop so that flow stops the manager first. |

### Linking to a section

There is a single layout, so there is no layout switch to configure. Dashboard sections are
addressable instead: `#dashboard` opens Overview, and `#dashboard/providers` and
`#dashboard/models` open the other two. Reload, bookmark, and Back all keep the section you were
on. **Logs** works the same way with `#logs` and `#logs/debug`.

Cost values in **Dashboard**, **Logs**, and **Usage** are API list-price equivalents calculated from
reported tokens. They are not billing receipts or evidence of an actual charge; subscription usage
or provider credits may apply instead. The Dashboard's **Plan & quota** section shows
provider-reported limits (5-hour / weekly / monthly windows), the provider plan, and observed
reference spend versus published caps — always labeled as provider-reported estimates, never billed
spend.

## Model visibility

The **Models** switches show final Codex visibility: a routed model is on only when its provider allowlist includes it (or no allowlist is set) and it is not disabled. Turning a model on reconciles both filters atomically; **All on** clears the provider allowlist so newly discovered models are also on.

The Current behavior card separates collaboration from context policy. **Uncapped** means no routed
provider has an artificial context cap; it does not mean the models have infinite context. **Limited**
means every routed provider uses the displayed shared cap, while **Mixed limits** means only some
providers are capped or their saved values differ. Native OpenAI models always keep their native window.

Automatic upstream catalog refresh is configured per provider under **Providers → Settings**. The
Models page shows that state and links directly to it; it does not keep a second discovery setting.

## Catalog activation

Saving model visibility, the featured roster, or collaboration mode is deliberately non-disruptive:
CodexCommander saves the desired configuration and converges its deterministic catalog on disk. It
does not terminate Codex while you are working. The **Agent Command Center** then shows whether the
current Codex app-server has actually loaded that catalog.

When the catalog and managed routing are already current and only the running worker is stale, the
recommended action is to quit ChatGPT completely, reopen it, and then start a new task. The dashboard
keeps the saved state visible and offers **Check status** after you return.

Do not use restart guidance as a substitute for reconciliation. If the status says the catalog is
pending or unknown, or CodexCommander routing is not injected, choose **Apply to Codex** first. That
guarded action synchronizes and proves the catalog and managed routing before it considers interrupting
a verified stale worker. External or unknown routing stays blocked so CodexCommander does not overwrite
configuration it does not own.

For an already-converged stale worker, **Force-restart workers** remains an advanced fallback in a
dashboard opened through `ccx gui` or the macOS menu app. It checks recent activity, asks for explicit
confirmation, and signals only verified Codex workers. Active-work count is warning context, not an idle
guarantee; an unknown worker identity blocks the action rather than guessing. It does not restart the
proxy, kill unrelated processes, queue itself for idle time, or save a separate pending-update record.
Because this bypasses ChatGPT's normal app lifecycle, ChatGPT may show **stopped unexpectedly**.

If a manually opened loopback dashboard lacks a confirmed session, or its session expired, reopen it
with `ccx gui` or from the macOS menu app. Never paste the raw admin token into a loopback page; their
one-time browser launch restores API access without exposing it.

A new task or fork within the same ChatGPT worker does not reload its model catalog. Quit and reopen
ChatGPT first, then start the new task. For advanced automation, `ccx sync --restart-codex` remains
available with the same worker-interruption caveat as the dashboard fallback.

## Install the advisory delegation setup

The **Subagents → Agent Command Center** includes **Codex delegation setup**, an optional way to give
new Codex tasks a durable delegation mode without freezing today's model roster into instructions.
Use it in this order:

1. Choose **Balanced** or **Orchestrator**. Balanced delegates substantial, bounded parallel work
   when it clearly helps while allowing the root to implement. Orchestrator normally delegates
   research and implementation and keeps the root focused on coordination and synthesis; it may
   still work directly when delegation is unavailable or clearly wasteful.
2. Choose **Preview** and review the exact two managed artifacts:
   `$HOME/.agents/skills/codexcommander-delegation/SKILL.md` and the bounded CodexCommander block in
   `$CODEX_HOME/AGENTS.md`.
3. Confirm **Install**, **Update**, or **Repair**. An installed setup instead offers **Change mode**.
   The dashboard refuses automatic changes when either path is unsafe, a skill at the target is not
   CodexCommander-managed, or the `AGENTS.md` marker pair is ambiguous.
4. Start a new Codex task. Codex reads the global block once per run; installing, repairing,
   changing mode, or removing it does not reload a current task.
5. To uninstall, choose **Remove**, then confirm the **Remove delegation setup** dialog. This removes
   only the managed `SKILL.md` and bounded `AGENTS.md` block. The skill directory is removed only
   when empty, so unrelated siblings are preserved.
6. Expand **Manual setup** and copy its server-provided setup only when the local installer is
   unavailable. It is a fallback, not an extra automatic installation method.

The installed skill is advisory. It carries no roster or model ids and tells Codex to inspect the
current collaboration tool contract and live CodexCommander roster before delegating. Those live
contracts remain authoritative, and user or repository instructions can prohibit delegation. A
nonempty `$CODEX_HOME/AGENTS.override.md` shadows the managed global block; the card reports that
state rather than claiming the setup is Ready.

This setup does not edit `config.toml`, `subagentDeveloperInstructions`, native `[agents]` defaults,
the featured roster, or the model catalog. It neither restarts a Codex worker nor replaces the
CodexCommander proxy. Configure and activate those separate surfaces through their existing controls.

## Delegation picker vs spawn routing

The Dashboard's **Sub-agent delegation** picker stores `injectionModel` and, optionally,
`injectionEffort`. **CodexCommander multi-agent guidance** independently controls the delegation
instructions that use those values. On eligible V2 turns, that guidance tells the parent
agent which exact model and reasoning effort to pass to `spawn_agent`; clearing the model also clears
the stored effort.

The default-off **Use as native Codex subagent defaults** switch applies only the selected
`injectionModel` and `injectionEffort` to Codex's native `[agents]` defaults on the next sync/restart
when CodexCommander manages the active Codex routing.
External user-managed provider configs remain untouched. Those defaults affect newly created Codex tasks
and do not themselves cause delegation. Existing user-owned `[agents]` defaults are preserved rather
than overwritten, so they may continue to override the requested defaults.

Per-row roster guidance is separate live V2 developer text. It is optional sanitized operator text
(empty omitted, at most 160 Unicode code points), advisory and untrusted rather than an effort, quota,
role, or fallback control. The built-in developer message includes every accepted annotation that
survives the live V2 compatibility filters; it is not copied into the managed skill or `AGENTS.md`.

:::caution
Neither control is a proxy-side cross-model spawn router. CodexCommander guidance asks Codex to pass
overrides to `spawn_agent`; native `[agents]` defaults apply only when Codex creates a new task after
they have been synchronized. See
[Sub-agent Surface](/guides/sub-agent-surface/) for the canonical V1/base/V2 behavior.
:::

The spawn override guarantee applies to the **built-in** V2 guidance text. A custom
`injectionPrompt` replaces that text entirely and must include `{{model}}` and `{{effort}}`
placeholders (and optionally `{{roster}}`) or those values will not appear in the injected
guidance.

The picker offers enabled native and routed models plus the global Codex effort ladder. The API
validates the selected effort globally; Codex still validates a spawn effort against the target
catalog entry.

## Codex Auth and account pools

The **Codex Auth** page manages the native ChatGPT/Codex route:

Pool mode selects across the main and added Codex accounts; Direct uses only the caller/main login.
In-flight requests keep their captured credentials, and a 401/403 reauthentication or 429 cooldown
may clear affinity and rotate to another eligible Pool account. This is separate from `openai-apikey`
and other providers.

- Manually choosing an account applies immediately: an already-bound thread moves to it on its next
  request, and only requests already in flight keep the account they captured. A manual choice is also
  pinned: the card shows a **PINNED** badge, and a higher selection order cannot preempt that account
  until it is drained, you select another account, or you change any account's selection order.
- Each account card carries a **Selection order** control (First, Earlier, Normal, Later, Last).
  Higher order is used first, and the pool drops to a lower order only once every account above it is
  drained or unavailable. A changed order applies from the next unbound request and never moves a
  thread that is already bound. The Codex Desktop (main) account is ordered like any other, so it can
  be set to **Last** and kept as the reserve. An order set from `ccx account priority` outside those
  five presets stays visible and selectable on the card.
- Thread affinity prevents per-request flapping. With quota auto-switch enabled, a long-running
  thread is periodically re-evaluated and may rebind after its relevant usage reaches the threshold
  and a strictly lower-usage eligible account exists.
- New sessions can choose the lowest-usage eligible account. Paid plans score the hottest known 5h,
  weekly, or 30d window; Go/Free plans use the 30d window only.
- When WHAM supplies `limit_window_seconds`, Codex Auth classifies a primary window of at least 28
  days as 30d instead of assuming every primary window is weekly. Responses without a duration are
  interpreted as weekly.
- **Refresh quotas** re-reads account usage immediately so routing and the account cards use the same
  values.
- Pool request logs use opaque labels such as `p3fa91c`, never account emails.

The Providers overview separately summarizes Pool-mode usage as a display-only weighted capacity
estimate, alongside the effective account's raw quota and the next capacity recovery. See
[Providers overview pool capacity](/guides/providers/#providers-overview-pool-capacity) for the
visible fields, incomplete-coverage meaning, and routing boundary.

## Integrations

The **Integrations** page connects OpenCode without treating it as another provider login. Its
**Apply connection** action changes only `provider.codexcommander` in OpenCode's active global JSONC/JSON
file, preserves comments and unrelated keys, and delivers the proxy credential through a protected
file reference rather than copying a key into OpenCode config. **Always keep OpenCode connected** is
an opt-in refresh after proxy startup or model-catalog changes.

If OpenCode config changed after Apply, the page reports that user edits are preserved and **Restore**
removes or restores only the managed provider. When the journal permits an exact restore, the original
file is restored byte-for-byte. The
**Open OpenCode** action launches OpenCode Desktop in one click; when only the CLI is installed, use
`ccx opencode` for its non-mutating, transient connection instead. See
[OpenCode](/guides/opencode/) for the file-selection and restore details.

## How the dashboard talks to the proxy

The GUI is a thin client over the proxy's JSON management API. Useful endpoints include:

| Endpoint | Purpose |
| --- | --- |
| `GET` / `PUT /api/settings` | Read settings or toggle Codex autostart. |
| `GET /api/integrations/opencode` · `POST /api/integrations/opencode/apply` · `POST /api/integrations/opencode/restore` | Inspect, safely apply, or restore the managed OpenCode connection. |
| `GET /api/startup-health` | Read secret-free routing, startup-method, crash-recovery, service, shim, and restart-safety diagnostics. |
| `PUT /api/startup-health/companion` | Let the authenticated native companion refresh its short-lived, memory-only Launch at Login observation. This endpoint requires the raw admin token; a browser GUI session is rejected. |
| `POST /api/startup-action` | Install the background service or Codex launcher shim through fixed, allowlisted actions. |
| `GET` / `POST /api/windows-tray` | Read or change the Windows tray installation and visible-process state. POST accepts `install`, `start`, `stop`, or `uninstall`. |
| `POST /api/sync` | Rebuild the shared model catalog and stale the Codex model cache without interrupting workers. |
| `GET /api/codex-catalog/status` · `POST /api/codex-catalog/apply` | Read catalog, routing, and worker activation evidence. The guarded Apply endpoint reconciles pending catalog or managed-routing state, then may force-restart only verified stale workers behind a desired-revision fence and explicit interruption confirmation. For an already-converged stale worker it is an advanced fallback that may make ChatGPT show **stopped unexpectedly**. A browser GUI session also needs the one-time launch authorization described above. |
| `GET` / `PUT /api/sidecar-settings` | Read or set search/vision sidecar model settings. |
| `GET` / `PUT /api/injection-model` | Read or set the shared sub-agent model/effort selection and the independent guidance/native-default switches. |
| `GET` / `PUT /api/v2` | Read or set the collaboration protocol, Codex feature flag, and V2 thread limit. |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | List, add/replace, enable/disable, set the default, or remove providers. `PATCH` uses standalone `{ "setDefault": true }` on an enabled provider; `POST` may include `setDefault` when creating/replacing (also enabled-only). Deleting the current default reassigns to the first remaining enabled provider when one exists; otherwise the API returns `409` with `code: "last_provider"` and keeps the current default. |
| `GET /api/models` · `PUT /api/disabled-models` | List native/routed model rows and update the shared disabled-model set. |
| `GET /api/selected-models` · `PUT /api/model-visibility` | Read provider allowlists and atomically change the final visibility of one model or provider group. |
| `GET /api/key-providers` · `GET /api/oauth/providers` | Read the API-key and OAuth provider catalogs. |
| `POST /api/oauth/login` · `GET /api/oauth/status` | Start a provider OAuth flow and poll for completion. |
| `GET /api/codex-auth/accounts?refresh=1` | List main and pool accounts, force quota refresh, and report main-account `hasCredential` / terminal `needsReauth` state. |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | Select the account for the next request and configure pool routing. |
| `GET /api/codex-auth/active` · `PUT /api/codex-auth/accounts/priority` | Read the effective account (including `pinned` and which account is `pinnedAccountId`) and set one account's selection order. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | Add a pool account through browser login. |
| `GET /api/logs?tail=50&limit=20&offset=0&provider=...&status=5xx` | Read recent request metadata with optional tail, provider, and exact/class status filters. With `limit`/`offset`, paging walks backward from the newest row (`offset=0` returns the latest page). Response shape: `{ timeZone, total, logs }` where `total` is the filtered row count before pagination. |
| `GET` / `PUT /api/subagent-models` | Read or set up to five ordered roster objects. GET keeps `chosen: string[]` and adds `roster`; Save sends `{ roster }`. Legacy `{ models }` writes preserve matching guidance. |
| `GET` / `PUT` / `DELETE /api/codex-delegation` | Read the managed delegation status and canonical previews, or install/change/remove the two advisory artifacts. PUT/DELETE require a confirmed dashboard launch with same-origin CSRF; a raw admin client receives 403. |
| `POST /api/stop` | Persist OFF, restore and prove native Codex, and stop an unsupervised proxy. Returns 409 for an installed supervisor, lifecycle contention, or an unsafe native restore; tray/CLI Stop owns the manager-first delegated path. |

:::tip
Adding **Ollama Cloud** or another catalog provider from the dashboard copies its text-versus-vision
classification into the saved provider config, so the [vision sidecar](/guides/sidecars/)
is gated correctly without manual classification.
:::

---
title: macOS Menu Bar Companion
description: Install and use the native CodexCommander proxy, startup-readiness, Codex-route, live-request, and provider-quota companion.
---

The macOS companion puts the most useful CodexCommander state in the menu bar without replacing the
proxy or duplicating the web dashboard. It is a native Swift/AppKit application and talks only to
the CodexCommander instance running on the same Mac.

## Install

Open [GitHub Releases](https://github.com/pavelhov/CodexCommander/releases) and download the current
universal macOS preview for Intel and Apple silicon. Choose the
`CodexCommander-<version>-macos-universal.zip` file and its matching `.sha256` checksum file.

This preview is ad-hoc signed and not notarized. Unzip it, move `CodexCommander.app` to Applications,
then Control-click the app and choose **Open** on first launch. If macOS still blocks it, choose
**System Settings → Privacy & Security → Open Anyway**. Do not disable Gatekeeper.

To build from source instead, follow [Build from source](#build-from-source) below.

## First run and app location

Direct **Start** in the packaged app owns the macOS first-run bootstrap. On a fresh Mac it creates
CodexCommander's canonical secret-free ChatGPT passthrough default without copying providers, API keys,
or OAuth accounts from another Mac. The initializer is create-only/no-clobber: an existing valid,
invalid, unreadable, or unsafe CodexCommander config is never overwritten, so repair an invalid or
inaccessible config before trying again. The app never creates `~/.codex/config.toml` (or any other
Codex config) automatically, and an external user-managed Codex provider remains untouched.

If Codex has not created `~/.codex/config.toml` yet, the proxy and dashboard still start while Codex
remains native. Open Codex once, then return to the companion and choose **Route Codex Through Proxy**.
The warning is nonfatal: the proxy stays running and the route button remains available.

An app in `/Applications` or `~/Applications` is eligible for **Launch at Login**. A physical copy in
Desktop or Downloads is allowed to run for the current session, but the startup row presents neutral
guidance to move it to Applications for login startup. Quit CodexCommander before moving a running app,
then reopen it from the new location; CodexCommander never moves the app itself. True macOS App
Translocation is different: **Start** is blocked before proxy launch and the companion tells you to move
the app and reopen it. The ad-hoc Gatekeeper steps above remain unchanged.

## Startup modes

The panel has one **Launch at Login** switch and reports the resulting mode:

- **Desktop** — the CodexCommander menu app launches when you sign in, performs an explicit Start,
  starts or attaches to exactly one proxy, and routes managed Codex through it when Codex
  configuration exists. On a fresh missing-Codex start, it leaves Codex native while the proxy runs
  and setup guidance is shown. An external user-managed Codex provider is preserved. This is the
  default desktop experience and is reported as **App-managed** in Startup.
- **Headless** — the menu app is not a login item, but an independently installed
  `ccx service` continues starting and supervising the server.
- **Off** — neither the menu app nor a background service starts automatically. A new manual app
  launch uses the app-owned Start path, including its first-run preparation; it routes Codex when Codex
  configuration exists, or leaves Codex native with setup guidance when Codex has not run yet. The
  ordinary CLI path is separate: run `ccx init` before `ccx start` or `ccx service`.

Throughout this guide, **restore native** means removing CodexCommander-owned routing. An external
user-managed Codex provider is left unchanged.

The visible app and background server remain separate internally. With the CodexCommander panel active,
**Quit Menu Bar** (`⌘Q`) closes only the companion UI and deliberately leaves routing active.
**Stop CodexCommander and Quit…** (`⌥⌘Q`) is the explicit destructive exit: after confirmation, it
restores native Codex routing, stops the proxy and service, and closes the companion only after the
stop is verified. macOS may
therefore list CodexCommander under both **Open at Login** and **Allow in the Background**; those are two
responsibilities of one installation, not duplicate app copies. Turning off Launch at Login never
installs, removes, starts, or stops the background service.

App-managed startup and the background service solve different problems. The app starts or attaches
to the proxy at sign-in and routes managed Codex through it when Codex configuration exists, which is
enough for normal desktop use. On a fresh missing-Codex start, the proxy remains running while Codex
stays native until the user opens Codex once and chooses **Route Codex Through Proxy**. The optional
background service additionally
supervises the proxy and restarts it after a crash, so the dashboard labels it **Background
recovery** instead of presenting it as a requirement. The companion periodically reports its current
Launch at Login state to the local proxy; that short-lived report is kept only in memory and is used
only for startup diagnostics.

If macOS requires approval, the startup row links directly to **System Settings → General → Login
Items & Extensions**. CodexCommander reflects a revocation made there instead of repeatedly trying to
override it.

## What the panel shows

- **Proxy status** — reports process liveness without treating a running server as proof that startup
  synchronization finished or that Codex uses the proxy.
- **Readiness** — reports startup and catalog synchronization as **Checking**, **Starting**, **Ready**,
  **Startup failed**, or **Unavailable**. This signal is independent of proxy liveness.
- **Codex route** — reports whether Codex currently routes through CodexCommander, native OpenAI, or
  another custom route. A running proxy does not by itself mean that Codex is using it. After an
  explicit switch, the companion confirms this value from a fresh uncached read of the route Codex
  will consume instead of waiting for cached startup diagnostics.
- **Live proxy requests** — the current in-flight request count and live model/provider turn rows. A
  spawned-child request is nested only when CodexCommander can prove its in-flight parent from request
  metadata; otherwise it is shown as a standalone subagent turn. A row disappears when that model
  request settles, even if Codex keeps the child thread alive and idle for later work. This is not a
  persistent Codex agent-lifecycle view, and the companion never invents queued, reviewing,
  rate-limited, or completed history.
- **Provider quotas** — provider-reported 5-hour, weekly, monthly, or provider-specific credit
  windows and reset times when available. OpenCode Go instead shows its published caps and local
  observations, never an invented live balance. Missing data is shown as unavailable, never as zero
  usage or unlimited capacity.
- **Dashboard and Logs** — open the corresponding local dashboard view in your default browser with
  a one-time launch authorization for full dashboard changes, including catalog Apply.
- **Startup options…** — opens the dashboard's Startup page when an optional startup upgrade or
  repair is available; the panel does not make a raw CLI command the primary action.
- **Manage** — opens the selected provider's Accounts or API Keys tab. OAuth, API-key entry,
  reauthentication, account switching, and provider configuration stay in the dashboard.
- **Restart ChatGPT to load models** — a persistent, nonfatal card shown when running Codex background
  workers still hold an older model roster. The CodexCommander proxy remains healthy and running.
- **Show restart steps…** — explains the recommended reload boundary: quit ChatGPT completely, reopen
  it, and then start a new task. The menu app does not force-restart background workers from this card.
- **Start Proxy** — starts or attaches to the proxy, then routes Codex through the live endpoint when
  Codex configuration exists. If Codex has not run yet, the proxy stays running, Codex remains native,
  and the setup-required card explains how to finish setup.
- **Stop Proxy…** — always asks for confirmation and restores native Codex routing before it stops the
  proxy. If the native route cannot be verified, the proxy and service stay running. The menu app stays open.
- **Restart Proxy…** — always asks for confirmation and runs the same safe stop→start transaction as
  the CLI. It restores native routing before terminating the old proxy, then its explicit Start phase
  launches the replacement and routes Codex back through it. If restart fails, Codex remains native.
- **Restore Native Codex** — switches Codex back to native OpenAI routing without stopping the proxy.
- **Route Codex Through Proxy** — points Codex at an already-running CodexCommander proxy without
  restarting it.
- **Quit Menu Bar** — closes the companion UI only. It does not stop the proxy, service, or client
  routing. With the panel active, this is the safe `⌘Q` action.
- **Stop CodexCommander and Quit…** — confirms the interruption, first restores native Codex routing,
  then stops the background proxy and service and quits only after the stopped state is confirmed. If
  stopping fails, the companion stays open and reports the error. With the panel active, its shortcut
  is `⌥⌘Q`.

Choosing either route action immediately opens a status card below the header. It shows a spinner,
elapsed time, and the real orchestration phases: **Changing route** and **Confirming route**. Route
and lifecycle buttons are disabled while the operation is running, and the button for the already
active route is disabled while idle. Progress stays visible until the operation finishes. The final
success or error remains visible until you choose **Dismiss** or start another operation; errors do
not disappear on a timer.

After **Restore Native Codex** or **Route Codex Through Proxy** reports success, quit ChatGPT
completely, reopen it, and then start a new task. The route is saved and confirmed at that point, but
an already-running ChatGPT/Codex host may still hold its previous route.

The native escape is deliberately narrow: it removes only CodexCommander's marker-owned routing and
owned catalog pointer from <code>$CODEX_HOME/config.toml</code>. After proving that exact route, it also
clears the proxy-only root <code>provider/model</code> selector. Every unrelated setting remains
byte-for-byte unchanged. It does not change Codex tasks, history, authentication, or the proxy process,
and needs neither a repair command nor a coordinator database. Generated catalogs and caches may remain
on disk, but native Codex no longer references them.

The `codexcommander-journal.json` file is a protected recovery checkpoint, not another routing
setting. It lets CodexCommander distinguish its exact config/profile write from later user edits
after an interruption. Repeating **Route Codex Through Proxy** is a safe no-op when that checkpoint
still belongs to the attested live proxy, its profile evidence still matches, and the managed route
remains intact. Unrelated Codex preference edits made after sync are allowed. If route ownership is
changed, custom, ambiguous, or cannot be proved safely, CodexCommander leaves the existing route
unchanged rather than guessing. Do not delete or edit the journal manually.

ChatGPT appears first and expanded when its quota report is available. Kimi and Grok appear as
collapsed summaries. A configured quota-capable provider that returns no report stays visible as
**Quota unavailable**; expand it to open Provider settings. When a linked Grok or Kimi CLI login is
stale, the row instead says **Login needs refresh** and tells you to run `grok` or `kimi`, then use
**Refresh**. A rejected account login says **Sign-in required**; a network or upstream failure says
**Temporarily unavailable**. These states are fixed, privacy-safe reason codes from the local proxy,
not raw provider errors. **View all providers** opens the complete Providers workspace.

While the proxy is running, the menu-bar item uses the normal terminal icon whether startup is
app-managed or service-managed. The warning triangle is reserved for a genuinely degraded proxy;
missing optional crash recovery does not turn a healthy running app into an alarm state.

## Agent catalog updates

Opening the app automatically synchronizes the Codex model catalog with the providers currently
configured in CodexCommander. If no Codex worker is running, the new roster is ready for the next Codex
task. If a long-lived worker loaded an older roster, CodexCommander stays running and the panel keeps the
nonfatal **Restart ChatGPT to load models** card visible.

Choose **Show restart steps…**, quit ChatGPT completely, reopen it, and then start a new task. This is
the recommended and most predictable way to replace the old worker. CodexCommander and the menu app
remain running throughout.

A new task or fork inside the same old background host is not a catalog-reload boundary. The menu card
therefore stays available until status observes a current worker. If the dashboard instead reports a
pending or unknown catalog, or says managed routing is not injected, choose **Apply to Codex** there so
it can reconcile and prove those files first; quitting ChatGPT alone is not that repair.

For an already-converged stale worker, the dashboard/API **Force-restart workers** action and the CLI
remain advanced fallbacks. They re-synchronize, use a desired-revision fence, signal only exact
current-user `codex … app-server` and `codex-code-mode-host` matches, and never escalate to a broad
`pkill`. Because they bypass ChatGPT's normal app lifecycle, ChatGPT may show **stopped unexpectedly**.
The CLI form is:

```bash
ccx sync --restart-codex
```

## Authentication and privacy

The companion does not create another login system or use macOS Keychain for provider credentials.

Current CodexCommander versions generate an independent management credential at
<code>~/.codexcommander/admin-api-token</code> (or
<code>$CODEXCOMMANDER_HOME/admin-api-token</code>). The companion reads that existing file through a
validated, no-follow file descriptor, keeps the value only in process memory, and sends it only to
an identity-verified loopback CodexCommander process. It never displays, logs, copies, stores, or places
the token in a browser URL.

When the companion opens the dashboard, it asks that verified local proxy for a short-lived,
single-use launch ticket. The ticket appears only in the URL fragment and is removed during its
one-time exchange. The server keeps the resulting full-featured session in process memory for up to
eight hours. The browser mirrors only its session token, CSRF token, origin, and absolute expiry in
`sessionStorage`, so a refresh works while that server session remains valid. It is never
renewed. Expiry, proxy restart, or a rejecting `401` clears the browser record and tells the user to
reopen through the companion or `ccx gui`. Neither the durable admin token nor the launch ticket enters
browser storage, and authentication never uses `localStorage`. Same-origin script can read
`sessionStorage`, so this reload convenience is not OS-user isolation. Browsers may copy the record
into duplicated or opener-created tabs, or restore it with a restored tab; every copy remains bound
to the exact origin and CSRF token and is usable only until the fixed server expiry, a proxy restart,
or a rejecting `401`. A manually opened loopback
dashboard receives no API session and never prompts for or sends the durable admin token.

Provider credentials remain owned by CodexCommander. The companion never reads ChatGPT, Kimi, Grok,
Anthropic, or other provider tokens and never calls provider login endpoints directly.

An installation configured only with <code>CODEXCOMMANDER_ADMIN_AUTH_TOKEN</code> works when that
variable is inherited by the app process. Apps launched from Finder usually do not inherit shell
variables; if there is no protected token file, the companion reports that management
authentication is unavailable instead of presenting a token-entry form.

Live request records are memory-only. The management response contains process-ephemeral row ids,
provider/model identifiers, timestamps, and aggregate counts. It contains no prompts, titles,
working directories, tool arguments, account identifiers, credentials, request bodies, raw
thread/session ids, or historical activity.

## Polling

The app refreshes lightweight in-flight request activity frequently while the panel is open and slows down when it
is closed. Provider quotas refresh at a separate, slower cadence and use the upstream timestamps
reported by CodexCommander. Repeated failures back off automatically, and overlapping refreshes are
coalesced.

Use **Refresh** for an immediate live-request refresh and a forced quota refresh.

## Build from source

Requires macOS 13 or later and the Xcode Command Line Tools. A universal Intel + Apple silicon
build requires full Xcode.

```bash
cd /path/to/CodexCommander
bun install
bun run test:macos
bun run build:macos
open dist/macos/CodexCommander.app
```

The development app is exactly `dist/macos/CodexCommander.app`. Every build embeds the Bun runtime and
CodexCommander server resources inside the app bundle; the running app never executes `src/` from the
checkout. Rebuild the app to pick up source changes. Double-clicking it to launch a new app process
performs an explicit Start: it starts or attaches to the proxy and routes managed Codex through it when
Codex configuration exists. If Codex has not run yet, it leaves Codex native while the proxy runs and
shows setup guidance. An external user-managed provider is preserved. An offline failure or failed start
does not close the app: its status panel remains available and **Start** can be retried. This source
workflow does not install or copy the app into Application
Support. A rebuild at the same path is detected on the
next launch and refreshes the existing Login Item registration only when Launch at Login remains on.
Each build stamps its exact Git revision into `CodexCommanderSourceRevision` in the bundle's `Info.plist`
and prints it at the end of the build. Uncommitted source is marked with `-dirty`, so commit before
making a final distributable bundle.

The source-build `.app` is a thin development artifact for the current checkout, not the public
distribution format. Use the universal release archive for public installation. A source app in the
supported `dist/macos` location may run the same session-start behavior; copies elsewhere remain
relocatable and are not moved automatically.

## Troubleshooting

- **Proxy unavailable** — use **Start Proxy** in the bundled app. Source builds can also use
  <code>ccx start</code> or install the background service with <code>ccx service install</code>.
- **Open Codex to finish setup** — the proxy is running while Codex remains native because Codex had
  not created its config yet. Open Codex once, return to the companion, and choose **Route Codex Through
  Proxy**.
- **Move CodexCommander to Applications** — a Desktop/Downloads copy can run for this session but is
  not eligible for login startup. Quit CodexCommander before moving it, move it yourself, and reopen it.
- **Start is blocked after a temporary macOS launch** — App Translocation is active. Move the app out of
  the translocated location and reopen it; CodexCommander never moves it automatically.
- **Menu icon missing after login** — open the app, check its **Launch at Login** row, and follow the
  **Open Settings** action if macOS reports that approval is required.
- **Authentication unavailable** — run <code>ccx doctor</code>; verify that the CodexCommander state
  directory and <code>admin-api-token</code> are owned by your user and are not group/world
  accessible.
- **Quota unavailable** — open **Provider settings** and connect or reauthenticate
  the account. If Grok says **Login needs refresh**, run <code>grok</code>, complete its login, then
  use **Refresh** in CodexCommander; use <code>kimi</code> for the equivalent Kimi state. Some providers do
  not expose a quota API.
- **Restart did not recover** — open **Logs** and use the app's status panel. The companion never
  kills a process or rewrites service state as a fallback.
- **Codex route was not changed / recovery checkpoint could not be verified** — your existing route
  was deliberately left unchanged because CodexCommander could not prove that the saved recovery
  checkpoint and current routing files still belong together. Do not delete the journal. Use
  **Refresh**, retry the intended route once, and if it still fails open **Logs** and run
  <code>ccx status</code> before changing anything manually.
- **Only native models appear after a stop, a Codex update, or a cold start** — reopen CodexCommander. Launch
  automatically synchronizes the catalog and restores still-configured routed models from its
  protected last-known-good catalog when live provider discovery is temporarily empty. If **Restart
  ChatGPT to load models** remains visible, quit and reopen ChatGPT, then start a new task. Use the
  advanced dashboard/API or CLI fallback in [Agent catalog updates](#agent-catalog-updates) only if
  manual restart is unsuitable.

## Uninstall

Turn off **Launch at Login**, quit the companion, and move <code>CodexCommander.app</code> to the Trash.
It stores no provider credentials and creates no Keychain entries. Uninstalling the companion does
not stop or uninstall the CodexCommander proxy; run <code>ccx service uninstall</code> separately only if
you also want to remove the headless service.

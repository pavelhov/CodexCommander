---
title: macOS Menu Bar Companion
description: Install and use the native CodexCommander status, agent-activity, and provider-quota companion.
---

The macOS companion puts the most useful CodexCommander state in the menu bar without replacing the
proxy or duplicating the web dashboard. It is a native Swift/AppKit application and talks only to
the CodexCommander instance running on the same Mac.

## Install

No packaged macOS app is currently published. Build and run the companion from the existing source
checkout using [Build from source](#build-from-source). Keep the development app at
`dist/macos/CodexCommander.app`; do not copy it into Application Support.

## Startup modes

The panel has one **Launch at Login** switch and reports the resulting mode:

- **Desktop** — the CodexCommander menu app launches when you sign in and ensures or attaches to exactly
  one server. This is the default desktop experience and is reported as **App-managed** in Startup.
- **Headless** — the menu app is not a login item, but an independently installed
  `ccx service` continues starting and supervising the server.
- **Off** — neither the menu app nor a background service starts automatically; open the app or run
  `ccx start` manually.

The visible app and background server remain separate internally. With the CodexCommander panel active,
**Quit Menu Bar** (`⌘Q`) closes only the companion UI and deliberately leaves routing active.
**Stop CodexCommander and Quit…** (`⌥⌘Q`) is the explicit destructive exit: after confirmation, it stops
the proxy and service, restores native Codex routing, and closes the companion only after the stop is verified. macOS may
therefore list CodexCommander under both **Open at Login** and **Allow in the Background**; those are two
responsibilities of one installation, not duplicate app copies. Turning off Launch at Login never
installs, removes, starts, or stops the background service.

App-managed startup and the background service solve different problems. The app starts the proxy at
sign-in, which is enough for normal desktop use. The optional background service additionally
supervises the proxy and restarts it after a crash, so the dashboard labels it **Background
recovery** instead of presenting it as a requirement. The companion periodically reports its current
Launch at Login state to the local proxy; that short-lived report is kept only in memory and is used
only for startup diagnostics.

If macOS requires approval, the startup row links directly to **System Settings → General → Login
Items & Extensions**. CodexCommander reflects a revocation made there instead of repeatedly trying to
override it.

## What the panel shows

- **Agent activity** — the current active count and live model/provider rows. A spawned child is
  nested only when CodexCommander can prove its active parent from request metadata; otherwise it is
  shown as a standalone subagent. The companion never invents queued, reviewing, rate-limited, or
  completed history.
- **Provider quotas** — provider-reported 5-hour, weekly, monthly, or provider-specific credit
  windows and reset times when available. OpenCode Go instead shows its published caps and local
  observations, never an invented live balance. Missing data is shown as unavailable, never as zero
  usage or unlimited capacity.
- **Dashboard and Logs** — open the corresponding local dashboard view in your default browser.
- **Startup options…** — opens the dashboard's Startup page when an optional startup upgrade or
  repair is available; the panel does not make a raw CLI command the primary action.
- **Manage** — opens the selected provider's Accounts or API Keys tab. OAuth, API-key entry,
  reauthentication, account switching, and provider configuration stay in the dashboard.
- **Agent catalog update ready** — a persistent, nonfatal card shown when running Codex background
  workers still hold an older model roster. The CodexCommander proxy remains healthy and running.
- **Apply agent catalog…** — opens a confirmation that reports fresh request activity when
  available, warns that applying may interrupt an answer, and offers **Apply Now** or **Later**.
- **Stop Proxy…** — always asks for confirmation, interrupts active client and sub-agent requests,
  restores native Codex, and leaves the menu app open.
- **Restart Proxy…** — always asks for confirmation, lets the proxy drain active requests for up to 60
  seconds, then reconnects to the replacement process. Accepting the restart request is not
  presented as completion; the app waits until the new process passes identity checks.
- **Quit Menu Bar** — closes the companion UI only. It does not stop the proxy, service, or client
  routing. With the panel active, this is the safe `⌘Q` action.
- **Stop CodexCommander and Quit…** — confirms the interruption, stops the background proxy and service,
  restores native Codex routing, and quits only after the stopped state is confirmed. If stopping
  fails, the companion stays open and reports the error. With the panel active, its shortcut is
  `⌥⌘Q`.

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
nonfatal **Agent catalog update ready** card visible.

Choose **Apply agent catalog…** to review the interruption risk. The confirmation requests a fresh
active-request count when possible, but zero active requests is not presented as proof that Codex is
idle: another request can begin before the action runs. **Apply Now** synchronizes once more, sends
`SIGTERM` only to exact current-user `codex … app-server` and `codex-code-mode-host` process matches,
and briefly verifies that the old process IDs exited. It never uses a broad `pkill`, restarts the
CodexCommander proxy, or closes the menu app. Codex creates a fresh background host on the next task and
loads the current roster.

The current companion does not include **Apply when idle**. If an answer is active, choose **Later** and apply
the update when you are ready; the card remains available. The advanced CLI fallback is:

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

Provider credentials remain owned by CodexCommander. The companion never reads ChatGPT, Kimi, Grok,
Anthropic, or other provider tokens and never calls provider login endpoints directly.

An installation configured only with <code>CODEXCOMMANDER_ADMIN_AUTH_TOKEN</code> works when that
variable is inherited by the app process. Apps launched from Finder usually do not inherit shell
variables; if there is no protected token file, the companion reports that management
authentication is unavailable instead of presenting a token-entry form.

Live agent records are memory-only. The management response contains process-ephemeral row ids,
provider/model identifiers, timestamps, and aggregate counts. It contains no prompts, titles,
working directories, tool arguments, account identifiers, credentials, request bodies, raw
thread/session ids, or historical activity.

## Polling

The app refreshes lightweight activity frequently while the panel is open and slows down when it
is closed. Provider quotas refresh at a separate, slower cadence and use the upstream timestamps
reported by CodexCommander. Repeated failures back off automatically, and overlapping refreshes are
coalesced.

Use **Refresh** for an immediate activity refresh and a forced quota refresh.

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

The source app is exactly `dist/macos/CodexCommander.app`. It discovers the checkout's `src/cli/index.ts`
and bundled Bun, so it should stay in that location while you work on this repository. Double-clicking
it attempts to ensure the proxy, but a missing CLI, offline failure, or failed start does not close
the app: its status panel remains available and **Start** can be retried. This source workflow does
not install or copy the app into Application Support. A rebuild at the same path is detected on the
next launch and refreshes the existing Login Item registration only when Launch at Login remains on.
Each build stamps its exact Git revision into `CodexCommanderSourceRevision` in the bundle's `Info.plist`
and prints it at the end of the build. Uncommitted source is marked with `-dirty`, so commit before
making a final distributable bundle.

## Troubleshooting

- **Proxy unavailable** — use **Start Proxy** in the bundled app. Source builds can also use
  <code>ccx start</code> or install the background service with <code>ccx service install</code>.
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
- **Only native models appear after a stop, a Codex update, or a cold start** — reopen CodexCommander. Launch
  automatically synchronizes the catalog and restores still-configured routed models from its
  protected last-known-good catalog when live provider discovery is temporarily empty. If **Agent
  catalog update ready** remains visible, choose **Apply agent catalog…**, or use the CLI fallback in
  [Agent catalog updates](#agent-catalog-updates).

## Uninstall

Turn off **Launch at Login**, quit the companion, and move <code>CodexCommander.app</code> to the Trash.
It stores no provider credentials and creates no Keychain entries. Uninstalling the companion does
not stop or uninstall the CodexCommander proxy; run <code>ccx service uninstall</code> separately only if
you also want to remove the headless service.

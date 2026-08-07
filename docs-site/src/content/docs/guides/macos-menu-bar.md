---
title: macOS Menu Bar Companion
description: Install and use the native OpenCodex status, agent-activity, and provider-quota companion.
---

The macOS companion puts the most useful OpenCodex state in the menu bar without replacing the
proxy or duplicating the web dashboard. It is a native Swift/AppKit application and talks only to
the OpenCodex instance running on the same Mac.

## Install

1. Install and start OpenCodex normally.
2. Download <code>OpenCodex-&lt;version&gt;-macos-universal.zip</code> and its
   <code>.sha256</code> file from the matching GitHub release.
3. Verify the archive:

       shasum -a 256 -c OpenCodex-<version>-macos-universal.zip.sha256

4. Unzip it and move <code>OpenCodex.app</code> to **Applications**.
5. Open the app. Its icon appears in the menu bar; it does not add a Dock icon. The first stable
   launch enables **Launch at Login** so the icon returns after the next sign-in.

The current release package is a ZIP. Unless its release owner supplies a Developer ID signing
identity, the bundle is ad-hoc signed; it is not a signed and notarized DMG. macOS may block the
first downloaded launch, so Control-click the app, choose **Open**, then confirm **Open**. A signed,
notarized DMG is a later commercial-distribution step that needs the distributor's own certificate,
notarization credentials, package metadata, and update channel. A build made locally does not carry
the downloaded-file quarantine attribute.

An installed release may live in **Applications**. Do not use Application Support as an app-install
directory. During active source development, use the repository build in the next section as the one
active companion instead of keeping a copied app alongside it.

The app registers only a stable bundle path: Applications, `~/Applications`, or the repository's
`dist/macos/OpenCodex.app`. It does not register a quarantined App Translocation path or an app
opened directly from Downloads. Move a release first, then open it.

## Startup modes

The panel has one **Launch at Login** switch and reports the resulting mode:

- **Desktop** — the OpenCodex menu app launches when you sign in and ensures or attaches to exactly
  one server. This is the default desktop experience.
- **Headless** — the menu app is not a login item, but an independently installed
  `ocx service` continues starting and supervising the server.
- **Off** — neither the menu app nor a background service starts automatically; open the app or run
  `ocx start` manually.

The visible app and background server remain separate internally. With the OpenCodex panel active,
**Quit Menu Bar** (`⌘Q`) closes only the companion UI and deliberately leaves routing active.
**Stop OpenCodex and Quit…** (`⌥⌘Q`) is the explicit destructive exit: after confirmation, it stops
the proxy and service, restores native Codex routing, and closes the companion only after the stop is verified. macOS may
therefore list OpenCodex under both **Open at Login** and **Allow in the Background**; those are two
responsibilities of one installation, not duplicate app copies. Turning off Launch at Login never
installs, removes, starts, or stops the background service.

If macOS requires approval, the startup row links directly to **System Settings → General → Login
Items & Extensions**. OpenCodex reflects a revocation made there instead of repeatedly trying to
override it.

## What the panel shows

- **Agent activity** — the current active count and live model/provider rows. A spawned child is
  nested only when OpenCodex can prove its active parent from request metadata; otherwise it is
  shown as a standalone subagent. The companion never invents queued, reviewing, rate-limited, or
  completed history.
- **Provider quotas** — provider-reported 5-hour, weekly, monthly, or provider-specific credit
  windows and reset times when available. OpenCode Go instead shows its published caps and local
  observations, never an invented live balance. Missing data is shown as unavailable, never as zero
  usage or unlimited capacity.
- **Dashboard and Logs** — open the corresponding local dashboard view in your default browser.
- **Manage** — opens the selected provider's Accounts or API Keys tab. OAuth, API-key entry,
  reauthentication, account switching, and provider configuration stay in the dashboard.
- **Stop Proxy…** — always asks for confirmation, interrupts active client and sub-agent requests,
  restores native Codex, and leaves the menu app open.
- **Restart Proxy…** — always asks for confirmation, lets the proxy drain active requests for up to 60
  seconds, then reconnects to the replacement process. Accepting the restart request is not
  presented as completion; the app waits until the new process passes identity checks.
- **Quit Menu Bar** — closes the companion UI only. It does not stop the proxy, service, or client
  routing. With the panel active, this is the safe `⌘Q` action.
- **Stop OpenCodex and Quit…** — confirms the interruption, stops the background proxy and service,
  restores native Codex routing, and quits only after the stopped state is confirmed. If stopping
  fails, the companion stays open and reports the error. With the panel active, its shortcut is
  `⌥⌘Q`.

ChatGPT appears first and expanded when its quota report is available. Kimi and Grok appear as
collapsed summaries. A configured quota-capable provider that returns no report stays visible as
**Quota unavailable**; expand it to open Provider settings. **View all providers** opens the
complete Providers workspace.

## Authentication and privacy

The companion does not create another login system, does not migrate anything to macOS Keychain, and
does not read provider credentials from it.

Current OpenCodex versions generate an independent management credential at
<code>~/.opencodex/admin-api-token</code> (or
<code>$OPENCODEX_HOME/admin-api-token</code>). The companion reads that existing file through a
validated, no-follow file descriptor, keeps the value only in process memory, and sends it only to
an identity-verified loopback OpenCodex process. It never displays, logs, copies, stores, or places
the token in a browser URL.

Provider credentials remain owned by OpenCodex. The companion never reads ChatGPT, Kimi, Grok,
Anthropic, or other provider tokens and never calls provider login endpoints directly.

An installation configured only with <code>OPENCODEX_ADMIN_AUTH_TOKEN</code> works when that
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
reported by OpenCodex. Repeated failures back off automatically, and overlapping refreshes are
coalesced.

Use **Refresh** for an immediate activity refresh and a forced quota refresh.

## Build from source

Requires macOS 13 or later and the Xcode Command Line Tools. A universal Intel + Apple silicon
release build requires full Xcode.

```bash
git clone https://github.com/pavelhov/opencodex.git
cd opencodex
bun install
bun run test:macos
bun run build:macos
open dist/macos/OpenCodex.app
```

The source app is exactly `dist/macos/OpenCodex.app`. It discovers the checkout's `src/cli/index.ts`
and bundled Bun, so it should stay in that location while you work on this repository. Double-clicking
it attempts to ensure the proxy, but a missing CLI, offline failure, or failed start does not close
the app: its status panel remains available and **Start** can be retried. This source workflow does
not install or copy the app into Application Support. A rebuild at the same path is detected on the
next launch and refreshes the existing Login Item registration only when Launch at Login remains on.

## Troubleshooting

- **Proxy unavailable** — start it with <code>ocx start</code> or install the background service
  with <code>ocx service install</code>.
- **Menu icon missing after login** — open the app, check its **Launch at Login** row, and follow the
  **Open Settings** action if macOS reports that approval is required.
- **Authentication unavailable** — run <code>ocx doctor</code>; verify that the OpenCodex state
  directory and <code>admin-api-token</code> are owned by your user and are not group/world
  accessible.
- **Quota unavailable** — open **Provider settings** and connect or reauthenticate
  the account. Some providers do not expose a quota API.
- **Restart did not recover** — open **Logs** and run <code>ocx status</code>. The companion never
  kills a process or rewrites service state as a fallback.

## Uninstall

Turn off **Launch at Login**, quit the companion, and move <code>OpenCodex.app</code> to the Trash.
It stores no provider credentials and creates no Keychain entries. Uninstalling the companion does
not stop or uninstall the OpenCodex proxy; run <code>ocx service uninstall</code> separately only if
you also want to remove the headless service.

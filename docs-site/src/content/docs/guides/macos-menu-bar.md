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
5. Open the app. Its icon appears in the menu bar; it does not add a Dock icon.

Until the release is Developer ID signed and notarized, macOS may block the first downloaded
launch. Control-click the app, choose **Open**, then confirm **Open**. A build made locally does
not carry the downloaded-file quarantine attribute.

## What the panel shows

- **Agent activity** — the current active count and live model/provider rows. A spawned child is
  nested only when OpenCodex can prove its active parent from request metadata; otherwise it is
  shown as a standalone subagent. The companion never invents queued, reviewing, rate-limited, or
  completed history.
- **Provider quotas** — every real 5-hour, weekly, monthly, or provider-specific credit window
  returned by OpenCodex, including reset times. Missing data is shown as unavailable, never as
  zero usage or unlimited capacity.
- **Dashboard and Logs** — open the corresponding local dashboard view in your default browser.
- **Manage** — opens the selected provider's Accounts or API Keys tab. OAuth, API-key entry,
  reauthentication, account switching, and provider configuration stay in the dashboard.
- **Restart** — asks for confirmation, lets the proxy drain active requests for up to 60 seconds,
  then reconnects to the replacement process. Accepting the restart request is not presented as
  completion; the app waits until the new process passes identity checks.

ChatGPT appears first and expanded when its quota report is available. Kimi and Grok appear as
collapsed summaries. **View all providers** opens the complete Providers workspace.

## Authentication and privacy

The companion does not create another login system and does not use macOS Keychain.

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

    git clone https://github.com/pavelhov/opencodex.git
    cd opencodex
    npm run test:macos
    npm run build:macos
    open dist/macos/OpenCodex.app

These two scripts invoke Swift directly; no npm dependency install is required.

## Troubleshooting

- **Proxy unavailable** — start it with <code>ocx start</code> or install the background service
  with <code>ocx service install</code>.
- **Authentication unavailable** — run <code>ocx doctor</code>; verify that the OpenCodex state
  directory and <code>admin-api-token</code> are owned by your user and are not group/world
  accessible.
- **Quota unavailable** — open the provider's **Manage** destination and connect or reauthenticate
  the account. Some providers do not expose a quota API.
- **Restart did not recover** — open **Logs** and run <code>ocx status</code>. The companion never
  kills a process or rewrites service state as a fallback.

## Uninstall

Quit the companion and move <code>OpenCodex.app</code> to the Trash. It stores no provider
credentials and creates no Keychain entries. Uninstalling the companion does not stop or uninstall
the OpenCodex proxy.

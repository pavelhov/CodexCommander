---
title: CLI Lifecycle
description: Setup, start, stop, service, diagnostics, and sync commands.
---

These commands install, run, inspect, and repair the local CodexCommander proxy and its Codex integration.

## Setup

### `ccx init` · `ccx setup`

Interactive setup wizard (`setup` is an alias of `init`). Prompts for a provider (preset or custom),
API key (literal or `${ENV}`), default model, and proxy port; saves `~/.codexcommander/config.json`;
optionally routes Codex through an already-running proxy; and optionally installs the Codex
autostart shim. Routing uses the same lifecycle authority and protected runtime proof as Route Back.
If no current-home proxy is proven, Codex stays native and `ccx start` performs the later explicit
start-and-route transition. `init` never starts a proxy or writes a route to an unproven listener.

## Proxy lifecycle

### `ccx start [--port <port>]`

Start the proxy server (preferred port `10100`). If that port is occupied, CodexCommander selects and
records another available port. It writes PID/runtime-port state and refuses to start a second live
instance. An explicit start enables Codex integration, syncs each provider's models into Codex's
catalog, and routes Codex through the live proxy. This includes `ccx start`, tray Start, and explicit
`ccx service start`, `install`, or `repair`; `ccx ensure` preserves an intentionally disabled
integration. On normal standalone shutdown it restores native Codex — unless it was launched as a
managed service (`CCX_SERVICE=1`).

```bash
ccx start
ccx start --port 8080
```

### `ccx stop`

Restore native Codex routing first, then stop the running proxy (by PID) and remove the PID file. If
the native route cannot be verified, the proxy and service stay running. If a managed background service is
installed, `ccx stop` stops it after the native restore so it cannot respawn the proxy.
The web dashboard's **Stop** button calls raw `POST /api/stop`, which stops an unsupervised proxy but
refuses when an installed supervisor owns it. In that case, use CLI or tray Stop so the manager is
stopped first under the same lifecycle authority.

### `ccx restart`

Run the same safe stop→start transaction as the macOS tray's **Restart Proxy…**: restore and verify
native Codex before terminating the old proxy/service, then run an explicit Start phase that launches
the replacement and routes Codex back through it. If restart fails, Codex remains native.

### `ccx ensure`

Idempotently ensure a background proxy is running, then sync its live model catalog. If
`codexAutoStart` is `false`, it prints that autostart is disabled and does nothing.

### `ccx restore [back]` · `ccx eject [back]`

Restore native Codex **without** stopping the proxy. The native escape removes only the exact
CodexCommander marker-owned route and its owned catalog pointer from `$CODEX_HOME/config.toml`.
After proving that exact route, it also clears the proxy-only root `provider/model` selector. Every
unrelated setting remains byte-for-byte unchanged. It does not read or rewrite the catalog, tasks,
history, or authentication. No repair command or coordinator database is required. `eject` is an
alias of `restore`. Generated catalogs and caches may remain on disk, but native Codex no longer
references them. This command is Codex-only: it does not change Grok or any other client integration.
Use `ccx stop` or `ccx uninstall` when you intend to tear down every managed native-client route.

Pass `back` to either spelling to re-point plain `codex` at an already-running proxy without changing
the proxy lifecycle. Route Back is an explicit ON transition. A recovery journal is a protected
checkpoint of CodexCommander's exact config/profile write, not a second route setting. When desired
integration is already ON, the exact attested current-home live proxy owns that stable journal, and
its recorded profile postimage exactly matches the current profile, Route Back accepts either the
exact recorded config postimage or a stable exact marker-owned managed descendant whose route strips
to an independently native-safe config. This allows unrelated Codex preference edits made after sync.
It preserves the active journal and succeeds as an idempotent no-op. From native/OFF, the existing
coordination path retires only a journal it proves stale. A wrong owner or profile, missing proof,
tampered/custom/ambiguous routing, temporary write surface, or observation race leaves Codex
native/OFF. Do not delete or edit the journal manually.

```bash
ccx restore back
ccx eject back
```

After either Restore Native or Route Back reports success, quit ChatGPT completely, reopen it, and
start a new task so the running Codex host loads the saved route.

### `ccx uninstall` · `ccx remove`

As one lifecycle transaction, stop the service and proxy, remove the service and Codex shim, restore
and re-verify native Codex, then remove CodexCommander local artifacts only if every step succeeded.
`remove` is an alias of `uninstall`. Config cleanup requires canonical ownership metadata; unowned or
shared directories are left in place. The small owner/manifest metadata pair remains in the config
root so a concurrent Start can never create a second lifecycle-lock namespace.

## Status and health

### `ccx status [--json]`

Print a read-only diagnostic summary: proxy PID, `/healthz` reachability, dashboard URL, config path,
default provider, Codex autostart setting, service state, shim state, and the redacted effective Codex
home. Only the explicit, high-confidence Windows Orca runtime-home signature adds an actionable App-home
mismatch warning; it never changes `CODEX_HOME` automatically.

Human output also includes an **OAuth health** block after the OAuth logins summary: `OAuth health:
ok` when every known account is healthy, or `OAuth health: warning` with one redacted line per
non-healthy account (provider, masked account id, status such as reauthentication required, rate or
quota limited, or refresh conflict) plus an optional `Action:` hint. Account ids are redacted; tokens
and emails are never printed. The `--json` contract does not currently include this health block.

```bash
ccx status
ccx status --json
```

Abbreviated example shape:

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.codexcommander/config.json",
    "pid": "/Users/example/.codexcommander/codexcommander.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.codexcommander/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

The real object also includes `listen` (port, hostname, runtime/config source), config load
diagnostics, and bundled Codex plugin diagnostics. The JSON schema is additive-only: future versions
may add fields, but existing fields should stay stable. It intentionally excludes API keys, OAuth
tokens, authorization headers, request content, emails, and account identities.

### `ccx health [--json]`

Identity-check the live proxy. Human output reports PID/port; `--json` emits `{ok, pid, port}`. The
command exits 0 only when healthy and 1 otherwise, making it suitable for service probes.

### `ccx ready [--json] [--wait [--timeout <seconds>]]`

Check post-sync readiness through the unauthenticated `GET /readyz` endpoint. It returns `200` when
ready, or `503` with `Retry-After: 1` for `pending` and terminal `failed`. Its sanitized HTTP identity
is `{service, version, uptime, pid, port, status}`. `/healthz` is separate liveness, not readiness.
The command performs one probe by
default; `--wait` polls until ready or timeout, but exits immediately when it observes the terminal `failed` state. The
default timeout is 45 seconds; `--timeout <seconds>` requires `--wait` and accepts positive integer seconds from 1–300.
CLI JSON emits `{ready, status, pid, port}`, where `status` is `ready`, `pending`, `failed`, or
`unreachable`. Exit codes are 0 for ready; 1 for not-ready, pending, failed, timeout, or
unreachable; and 64 for invalid arguments.

### `ccx doctor`

Run read-only environment and connectivity diagnostics: state paths and filesystem type, WSL dual
installs, proxy environment/config, ChatGPT reachability, and Codex plugin and project-config
warnings. The Codex app-home targeting section also detects the narrow Windows Orca runtime-home
mismatch and prints manual uninstall, environment, and reinstall steps when applicable. Paths shown
by this diagnostic redact the OS username. Doctor prints repair hints but does not apply them.

The **OAuth reliability** section reports whether credential storage is writable, whether refresh
single-flight/lock files can be created under `CODEXCOMMANDER_HOME`, non-healthy OAuth or Codex pool
accounts (redacted ids) with a recovery `Action:`, and a static OK that the Codex forward path does
not fabricate official-client metadata. Doctor never mutates credentials or applies repairs.

:::note[One-time upgrade restart]
An already-running proxy from an older build may have a protected runtime record without an
`attestationSecret`. Restart that proxy once before using CLI management commands or launching
credential-bearing Claude/OpenCode clients. Until then, sensitive requests fail closed: no token or
request body falls back to a listener found only through public health or a configured port.
:::

## Catalog sync

### `ccx sync [--restart-codex]`

Fetch the live model list from every configured provider and re-inject the merged catalog into Codex.
Run it after adding a provider or to refresh available models.

If long-lived Codex `app-server` processes are still running, `ccx sync` warns that they may keep
serving the previous in-memory model list even though `codexcommander-catalog.json` / `models_cache.json`
were updated. Pass `--restart-codex` to send `SIGTERM` only to matching `codex … app-server` and
`codex-code-mode-host` processes owned by the current user (active turns may be interrupted). Broad
`pkill -f codex` matching is intentionally avoided.

`ccx sync` itself is non-disruptive. Starting a new task or forking one in the same already-running
Codex app-server does not make it reload the catalog. Use the dashboard's explicit **Apply agent
catalog**, `ccx sync --restart-codex`, or quit and reopen Codex Desktop; reopening Desktop is the
reliable manual worker-replacement boundary.

### `ccx sync-cache [--restart-codex]`

Invalidate Codex's local model picker cache so it is rebuilt from the active CodexCommander catalog. The
same stale-`app-server` warning and optional `--restart-codex` behavior as `ccx sync` apply.

## Background service

### `ccx service [install|repair|start|stop|status|uninstall|remove]`

Run CodexCommander as a login-managed background service (macOS **launchd**, Linux **systemd user unit**,
Windows **Task Scheduler**) that auto-starts on login and auto-restarts on crash. Service runs set
`CCX_SERVICE=1` so an automatic manager restart does not churn the Codex config. Explicit service
creation, `install`, `repair`, and `start` enable Codex integration and route Codex through the proxy.

| Subcommand | Action |
| --- | --- |
| none | Create/update and start the service. |
| `install` | Create and start the service. Registers it, which on Windows needs elevation. |
| `repair` | Refresh an installed service in place and restart it, without re-registering it. |
| `start` | Start an installed service. |
| `stop` | Restore and verify native Codex, then stop the service. If verification fails, the service and proxy stay running. |
| `status` | Report service and proxy diagnostics plus log paths. |
| `uninstall` | Restore and verify native Codex, then stop and remove the service. |
| `remove` | Alias of `uninstall`. |

```bash
ccx service
ccx service install
ccx service repair
ccx service status
ccx service uninstall
```

`install`, `start`, and `repair` confirm that a proxy actually answers on the port
baked into the installed service before reporting success — on all three platforms.
They wait up to 20 seconds and then print the serving port:

```
✅ CodexCommander service installed and serving on port 10100.
```

If nothing answers, they warn and **exit non-zero**:

```
⚠️  Service installed, but no proxy answered on port 10100 within 20s.
   The manager registered the job; that is not the same as serving.
   Log:       ~/.codexcommander/service.log
   Meanwhile: ccx start   (serves in the foreground)
```

A non-zero exit here means *registered but not serving* — not *not installed*. The
service manager accepted the job; the proxy behind it never bound the port. Read the
log named in the message, and use `ccx start` to serve in the foreground meanwhile.

`ccx service status` reports the same three states rather than raw manager output:

```
✅ installed and loaded (launchd; logs: …)
   Serving on port 10100.
```

```
⚠️  installed and loaded (launchd; logs: …)
   Registered, but no proxy is answering on port 10100.
   launchd is running an OLDER plist than the one on disk.
   Fix:    launchctl bootout gui/$(id -u)/com.codexcommander.proxy && ccx service repair
   Log:    ~/.codexcommander/service.log
   Repair: ccx service repair
   Meanwhile: ccx start           (serves in the foreground)
```

It no longer prints the raw `launchctl list` / `systemctl status` line, which
reported a registered job identically whether it was serving, bound to nothing, or
running a previous definition. The `Diagnostics:` line still carries the log path and
any stale-baked-path finding.

On Windows the scheduler backend keeps its own richer status output, which already
reported Task Scheduler registration separately from proxy reachability.

On macOS this also covers a subtler failure: `launchctl load` reports failure on
stderr while exiting 0, so a load that did not take used to leave launchd running a
**previous** version of the service definition while the command printed a checkmark.
`install` now fails loudly in that case and names the `launchctl bootout` command that
clears the stale job.

On Windows, `ccx service status` reports Task Scheduler registration separately from
identity-verified CodexCommander proxy reachability. It does not print the localized `schtasks` table,
so the summary remains readable across Windows code pages.

On Windows, creating the Task Scheduler entry requires elevation. Recognized localized
access-denied text keeps the existing guidance path. If that text is unreadable, the fallback
requires the owned command shape `/create /tn codexcommander-proxy /xml <non-empty-path> /f`, status 1,
and a confirmed non-elevated token; the dashboard's Startup Safety action can then request UAC
automatically. If that fallback cannot determine the token state, it retains the original scheduler
error. Foreign tasks and operations can never emit the automatic-elevation marker. Approve the
dashboard UAC prompt or rerun `ccx service install` in an elevated PowerShell window.

### `ccx codex-shim <install|status|uninstall|remove>`

Wrap a script-based `codex` launcher on PATH with a lightweight autostart script. Real `codex.exe`
targets are left untouched to avoid breaking exact executable invocations.

If a completed external Codex update overwrites an installed shim, the next ordinary `ccx` command
backs up the stable new launcher and restores the shim before dispatch. A launcher that is still
changing is left untouched and retried later. Repair failures warn without failing the requested
command; manual fallback: `ccx codex-shim install`. Set `codexShimAutoRestore` to `false`, or set
`CODEXCOMMANDER_CODEX_SHIM_AUTO_RESTORE=0` for a process-level opt-out.

| Subcommand | Action |
| --- | --- |
| `install` | Install the shim (or repair if stale). |
| `uninstall` | Remove the shim and restore the original Codex binary. |
| `remove` | Alias of `uninstall`. |
| `status` | Report shim state (installed, stale, or missing). |

```bash
ccx codex-shim install
ccx codex-shim status
ccx codex-shim uninstall
```

:::tip[Service vs Shim]
Use `ccx service` for an always-on background proxy (recommended). Use `ccx codex-shim` for
lightweight, on-demand startup without a daemon — the proxy starts only when `codex` is launched.
:::

### `ccx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Install and control the Windows status tray icon. It starts at Windows login and provides one-click
proxy controls. `start` and `stop` control the icon only; use its menu to control the proxy.
`--no-start` applies to `install` and installs the tray without launching it immediately.

## Dashboard

### `ccx gui`

Open the [web dashboard](/guides/web-dashboard/) at `http://localhost:<port>`, auto-starting the proxy
if it is not running. The command mints a short-lived, single-use browser launch ticket so the
dashboard can make changes, including confirmed **Apply agent catalog**. The ticket travels only in
the URL fragment and is removed during exchange; the durable admin token never enters the URL or web
storage. The resulting confirmed session is process-memory-only, lasts up to eight hours, and is not
renewed. Expiry or proxy restart makes the next API request return `401`; open the page through
`ccx gui` or the macOS menu app again. Opening `localhost` manually supplies no API session and never
prompts for or sends the durable admin token.

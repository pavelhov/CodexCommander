---
title: Agent Quickstart
description: Install and operate CodexCommander from an agent-driven or scripted terminal.
---

This page is for an AI agent or a scripting user working from a terminal. It focuses on commands,
exit status, and safe headless operation. For a human-led walkthrough, use the
[Quickstart](/getting-started/quickstart/). The dashboard remains available for interactive
configuration; see [Web Dashboard](/guides/web-dashboard/).

## Set up CodexCommander

Use the existing source checkout. The registry package is not currently published:

```bash
bun install
bun run build:gui
bun run src/cli/index.ts --version
```

Choose one way to run the proxy:

```bash
# Foreground: blocks this terminal until stopped.
bun run src/cli/index.ts start

# Background: installs or updates the service, then starts it.
bun run src/cli/index.ts service
```

Run `ccx init` in an interactive terminal. If `ccx start` is occupying the foreground, use a
second terminal:

```bash
bun run src/cli/index.ts init
```

The wizard writes `$CODEXCOMMANDER_HOME/config.json` (normally
`~/.codexcommander/config.json`). It can also inject the proxy address into Codex's `config.toml` and
install the optional Codex autostart shim. `ccx init` never starts the proxy. For a fully
non-interactive setup, configure providers with `ccx provider add` as shown below instead of driving
the wizard.

The source command form is `bun run src/cli/index.ts <command>`. On macOS, the companion built from this checkout stays at
`dist/macos/CodexCommander.app`; see [macOS Menu Bar Companion](/guides/macos-menu-bar/) instead of
installing a development copy elsewhere.

## Check a headless installation

Use these read-only checks in scripts and agent runs:

```bash
ccx status
ccx doctor
ccx health --json
```

`ccx status` reports the proxy and service state. `ccx doctor` diagnoses local environment,
network, Codex runtime, and account-health problems. `ccx health` exits `0` when the proxy is
healthy and `1` otherwise; `--json` returns structured output.

Commands backed by the management API, such as `ccx combo set`, contact the live proxy. If no live
proxy can be found or the API is unreachable, the CLI treats that as a `503` failure and exits
nonzero. Start the foreground proxy or background service before retrying. See the
[CLI reference](/reference/cli/) and [Management API](/reference/management-api/) for the complete
command and endpoint surfaces.

## Add providers and combos without the dashboard

Registry providers can be added by name. For example, this adds the Anthropic API-key preset and
makes it the default provider:

```bash
ccx provider add anthropic-apikey \
  --api-key "$ANTHROPIC_API_KEY" \
  --set-default
```

`ccx provider add` writes local configuration. Add `--sync` if a live proxy is already running and
you want to sync models to Codex immediately; otherwise run `ccx sync` later. Custom providers that
are not in the registry require both `--adapter` and `--base-url`.

Once all target providers are configured and the proxy is running, create a failover combo:

```bash
ccx combo set main \
  --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol \
  --strategy failover
```

Targets use `provider/model` syntax and are comma-separated. The resulting virtual model is
`combo/main`. See [Combos](/guides/combos/) for strategies, weights, sticky routing, and failure
behavior.

## Remote and LAN binds

The default loopback bind does not require an API token. A non-loopback bind, such as `0.0.0.0`,
requires `CODEXCOMMANDER_API_AUTH_TOKEN`; the proxy refuses to start without it. Set the variable before
`ccx start`, or before `ccx service install` so the service receives it:

```bash
export CODEXCOMMANDER_API_AUTH_TOKEN="your-secret-token"
ccx service install
```

Clients must then authenticate their management and model requests. Read the remote-access rules in
[Configuration](/reference/configuration/) before exposing CodexCommander beyond the local machine.

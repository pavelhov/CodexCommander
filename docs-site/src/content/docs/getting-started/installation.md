---
title: Installation
description: Install CodexCommander (`ccx` / `codexcommander`), its prerequisites, and verify it runs.
---

CodexCommander exposes two equivalent command names in packaged or locally linked builds, `ccx` and
`codexcommander`. Both launch the same small local HTTP server (built on Bun). Model requests go to the provider selected by routing; optional
vision and web-search sidecars can also use your ChatGPT login when a routed model needs them.

## Prerequisites

| Requirement | Why |
| --- | --- |
| **[Bun](https://bun.sh)** | The source runtime and repository scripts run directly on Bun. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App, or SDK) | The client CodexCommander sits in front of. CodexCommander writes to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). |
| A provider account or API key | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, an OpenAI-compatible endpoint, or your ChatGPT login. |

## Run the source checkout

```bash
bun install
bun run build:gui
bun run src/cli/index.ts start
```

The registry package is not currently published. Run other commands from this checkout by replacing
`ccx <args>` with `bun run src/cli/index.ts <args>`. For example, verify the runtime in another
terminal:

```bash
bun run src/cli/index.ts --version
```

This is the source/headless installation path. Run `ccx init` (or
`bun run src/cli/index.ts init`) before an ordinary CLI start so CodexCommander has a valid
`$CODEXCOMMANDER_HOME/config.json`:

```bash
ccx init
ccx start
```

The CLI does not create a missing configuration implicitly and does not create a Codex config by
writing JSON or TOML for you. If its configuration is missing, invalid, unreadable, or unsafe, repair
that state and retry; existing bytes are preserved. Codex's own configuration and any external Codex
provider remain untouched unless you explicitly choose a CodexCommander route.

## Packaged macOS app

The direct **Start** action in the packaged macOS companion is the one app-only exception: on a fresh
Mac it creates the canonical secret-free ChatGPT passthrough default without a setup wizard. It never
copies providers, API keys, or OAuth accounts from another Mac. If Codex has not created
`~/.codex/config.toml` yet, the proxy and dashboard still start while Codex stays native. Open Codex
once, then choose **Route Codex Through Proxy** from the menu. The app never creates Codex's config
automatically.

The app initializer is create-only/no-clobber. An existing valid, invalid, unreadable, or unsafe
CodexCommander config is never overwritten; invalid or inaccessible state must be repaired before the
app can start. A user-managed external Codex provider is also preserved. For release installation,
use the universal Intel + Apple silicon archive from [GitHub Releases](https://github.com/pavelhov/CodexCommander/releases),
not a thin development `.app` from a source checkout.

## Development mode

Use separate proxy and dashboard processes while editing the UI:

```bash
bun run dev:proxy
bun run dev:gui   # another terminal
```

`bun run dev` remains an alias for `bun run dev:proxy`; the proxy API exposes `/healthz`,
`/v1/responses`, and `/api/*`. While hacking on the dashboard, run `bun run dev:proxy` and
`bun run dev:gui` in separate terminals instead of the packaged-dashboard commands above.

On macOS, build the companion from this same checkout with `bun run test:macos && bun run
build:macos`. Its source-build location is `dist/macos/CodexCommander.app`; do not copy that development
build into Application Support. See [macOS Menu Bar Companion](/guides/macos-menu-bar/) for lifecycle
behavior, Launch at Login, Desktop/Headless/Off modes, app-location rules, and source-build operation.

## What gets created

CodexCommander state lives under `$CODEXCOMMANDER_HOME` (default `~/.codexcommander`). Codex integration files live
under `$CODEX_HOME` (default `~/.codex`).

| Path | Purpose |
| --- | --- |
| `$CODEXCOMMANDER_HOME/config.json` | Your providers, default provider, port, and options. |
| `$CODEXCOMMANDER_HOME/codexcommander.pid` | PID of the running proxy (single-instance guard). |
| `$CODEXCOMMANDER_HOME/runtime-port.json` | The live PID, hostname, and port, including an automatically selected fallback port. |
| `$CODEXCOMMANDER_HOME/auth.json` | Stored OAuth credentials (when you `ccx login`). |
| `$CODEXCOMMANDER_HOME/catalog-backup-<catalog-id>.json` | Codex model catalog backup made before CodexCommander edits it. |
| `$CODEX_HOME/config.toml` | On loopback, CodexCommander adds a marker-owned root `openai_base_url`; non-loopback binds use `model_provider = "codexcommander"` plus `[model_providers.codexcommander]` so Codex can send the API-auth header. |
| `$CODEX_HOME/codexcommander.config.toml` | Fallback/reference profile written alongside the main Codex config. |
| `$CODEX_HOME/codexcommander-catalog.json` | Synced native and routed model catalog used by Codex. |

:::note
CodexCommander never deletes your Codex config. `ccx stop`, `ccx restore`, and `ccx eject` remove only
the exact marker-owned route from `config.toml` and restore native Codex. Generated catalogs and caches
may remain, but native Codex no longer references them; tasks, history, and authentication are untouched.
:::

## Next

Continue to the [Quickstart](/getting-started/quickstart/) to configure your first provider,
or read [How It Works](/getting-started/how-it-works/) for the architecture.

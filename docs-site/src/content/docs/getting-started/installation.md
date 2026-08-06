---
title: Installation
description: Install the opencodex (ocx) proxy, its prerequisites, and verify it runs.
---

opencodex installs two equivalent command names, `ocx` and `opencodex`. Both launch the same small
local HTTP server (built on Bun). Model requests go to the provider selected by routing; optional
vision and web-search sidecars can also use your ChatGPT login when a routed model needs them.

## Prerequisites

| Requirement | Why |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` runs on the Bun runtime, but the runtime is bundled automatically on `npm install` — you do **not** need to install Bun yourself. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App, or SDK) | The client opencodex sits in front of. opencodex writes to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). |
| A provider account or API key | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, an OpenAI-compatible endpoint, or your ChatGPT login. |

## Install

```bash
npm install -g @bitkyc08/opencodex
```

:::note[npm blocked the bun postinstall?]
Recent npm versions may block bun's postinstall script (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`),
which leaves the bundled Bun runtime unprepared. Reinstall allowing bun's
script — and always include the package name (npm's abbreviated suggestion
omits it, which would reinstall the current directory instead):

```bash
npm install -g --allow-scripts=bun @bitkyc08/opencodex

# if the original install used sudo, keep using sudo:
sudo npm install -g --allow-scripts=bun @bitkyc08/opencodex
```
:::

Verify both command aliases are on your `PATH`:

```bash
ocx --version
opencodex --version
```

### Release channels

The stable `latest` channel already includes GPT-5.6 Sol/Terra/Luna catalog support for ChatGPT,
OpenAI API-key, OpenRouter, and experimental Cursor routes. Upstream access is still account-gated;
the catalog entries do not grant access by themselves. Use the preview channel only to test
unreleased opencodex builds:

```bash
npm install -g @bitkyc08/opencodex@preview
ocx update --tag preview
```

## Run from source

To hack on opencodex itself:

```bash
git clone https://github.com/pavelhov/opencodex.git
cd opencodex
bun install
bun run build:gui   # build the dashboard that the proxy serves at /
bun run start       # starts the proxy from src/cli/index.ts
```

The checkout URL above is this fork's source of truth for the approved companion and OpenCode
integration. Upstream attribution and Git history remain intact. `bun run dev` remains an alias for
`bun run dev:proxy`; the proxy API exposes `/healthz`, `/v1/responses`, and `/api/*`. While hacking
on the dashboard, run `bun run dev:proxy` and `bun run dev:gui` in separate terminals instead of the
packaged-dashboard commands above.

On macOS, build the companion from this same checkout with `bun run test:macos && bun run
build:macos`. Its source-build location is `dist/macos/OpenCodex.app`; do not copy that development
build into Application Support. See [macOS Menu Bar Companion](/guides/macos-menu-bar/) for lifecycle
behavior, Launch at Login, Desktop/Headless/Off modes, and release installation.

## What gets created

opencodex state lives under `$OPENCODEX_HOME` (default `~/.opencodex`). Codex integration files live
under `$CODEX_HOME` (default `~/.codex`).

| Path | Purpose |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Your providers, default provider, port, and options. |
| `$OPENCODEX_HOME/ocx.pid` | PID of the running proxy (single-instance guard). |
| `$OPENCODEX_HOME/runtime-port.json` | The live PID, hostname, and port, including an automatically selected fallback port. |
| `$OPENCODEX_HOME/auth.json` | Stored OAuth credentials (when you `ocx login`). |
| `$OPENCODEX_HOME/catalog-backup*.json` | Codex model catalog backups made before opencodex edits it. |
| `$CODEX_HOME/config.toml` | On loopback, opencodex adds a marker-owned root `openai_base_url`; non-loopback binds use `model_provider = "opencodex"` plus `[model_providers.opencodex]` so Codex can send the API-auth header. |
| `$CODEX_HOME/opencodex.config.toml` | Fallback/reference profile written alongside the main Codex config. |
| `$CODEX_HOME/opencodex-catalog.json` | Synced native and routed model catalog used by Codex. |

:::note
opencodex never deletes your Codex config. Every injection is reversible — `ocx stop`, `ocx restore`,
or `ocx eject` strip exactly the lines opencodex added and restore native Codex.
:::

## Next

Continue to the [Quickstart](/getting-started/quickstart/) to configure your first provider,
or read [How It Works](/getting-started/how-it-works/) for the architecture.

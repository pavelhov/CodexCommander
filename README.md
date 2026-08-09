<h3 align="center">make codex open!</h3>
<p align="center"><b>Universal provider proxy for OpenAI Codex, Claude Code, Claude Desktop &amp; Grok Build</b><br>
Two commands, and every one of them runs any LLM you point it at.</p>

```bash
bun install
bun run build:gui
bun run src/cli/index.ts start
```

<p align="center">
  <img src="docs-site/public/og.png" alt="CodexCommander — universal provider proxy for OpenAI Codex and Claude Code" width="920">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="readme/README.ko.md">한국어</a> · <a href="readme/README.zh-CN.md">简体中文</a> · <a href="readme/README.ru.md">Русский</a> · <a href="readme/README.ja.md">日本語</a> · 📖 <a href="docs-site/src/content/docs/getting-started/installation.md"><b>Full documentation →</b></a>
</p>

CodexCommander is a lightweight local proxy that translates Codex's Responses API into whatever your
provider speaks — streaming, tool calls, reasoning tokens, images, in both directions. Use Claude,
Gemini, Grok, GLM, DeepSeek, Kimi, Qwen, Ollama, or any other LLM with Codex, Claude Code, Claude
Desktop, and Grok Build. It can also manage a **ChatGPT account pool** for Codex auth: add accounts,
refresh their quotas in the dashboard, and let new sessions auto-route to the lowest-usage healthy
account while existing threads stay pinned to the account that started them.

## Quick start

### For humans

```bash
bun install
bun run build:gui
bun run src/cli/index.ts start   # or use `service` instead of `start`
```

The registry package is not currently published. These instructions run the checked-out source
with a locally installed [Bun](https://bun.sh). In this checkout, any documented `ccx <args>`
command can be run as `bun run src/cli/index.ts <args>`.

Open **http://localhost:10100** and configure everything in the web dashboard — add providers
(40+ built-ins, or any OpenAI-compatible endpoint), pick models, manage accounts. `ccx gui`
re-opens the dashboard at any time.
It can also manage a **ChatGPT account pool** for Codex auth. Add multiple ChatGPT / Codex accounts,
refresh their 5h / weekly / 30d quota in the dashboard. Under quota routing, new sessions can use
the lowest-usage healthy account; round-robin and fill-first use their own policies. Existing Codex
threads normally retain affinity to the account that started them, so long SSH, tmux, or
mobile-connected sessions do not jump accounts mid-conversation — but quota re-evaluation, failover,
account exclusion, affinity expiry, or 401/403 and 429 recovery can rebind them. Give the accounts a
selection order when one of them — usually your Codex Desktop login — should only be reached for
once the others are drained.

### macOS menu bar companion

The native companion shows live agent activity and provider quota windows, then opens the existing
dashboard for OAuth, API keys, account management, and logs. It is a UI layer over the running
proxy: it does not use Keychain, create a second provider-login system, or store provider credentials
in the app.

No packaged macOS app is currently published. Build the companion from this checkout and keep that
one development app at `dist/macos/CodexCommander.app` instead of copying it to Application Support:

```bash
bun install
bun run test:macos
bun run build:macos
open dist/macos/CodexCommander.app
```

Double-clicking that source build ensures the proxy through the same checkout; if startup fails, the
menu app stays open so its diagnostics and **Start** control remain available. **Quit** closes only
the companion UI. **Stop** and **Restart** are separate, confirmation-gated proxy actions.

On its first launch from `dist/macos` or Applications, the app enables **Launch at Login** so the
menu icon returns after sign-in. The startup row exposes the actual mode: **Desktop** launches the
menu app, **Headless** leaves only an installed background service at login, and **Off** starts
neither automatically. Rebuilt source apps refresh their login registration in place; they are
never copied into Application Support. Full
setup, Gatekeeper, release packaging, and troubleshooting details are in the
[macOS menu bar guide](docs-site/src/content/docs/guides/macos-menu-bar.md).

### OpenCode client

`ccx opencode` starts OpenCode with a transient, in-memory `provider.codexcommander` block and never
rewrites OpenCode config files. For plain OpenCode or the Desktop app, use the dashboard's
**Integrations** page to apply the opt-in, reversible connection that owns only
`provider.codexcommander`; see the [OpenCode guide](docs-site/src/content/docs/guides/opencode.md).

### For agents

```bash
bun run src/cli/index.ts start     # or use `service`
bun run src/cli/index.ts init      # interactive setup: writes ~/.codexcommander/config.json and wires Codex
```

`ccx init` never starts the proxy; start it first (or after — either order works, but headless
commands like `ccx provider add` and `ccx combo set` talk to the **live** proxy and exit nonzero
when it is unreachable). `ccx status` / `ccx doctor` / `ccx health` report the running state.

## Supported platforms

| OS | Status | Service manager |
|---|---|---|
| macOS (arm64 / x64) | Fully supported | launchd |
| Linux (x64 / arm64) | Fully supported | systemd (user unit) |
| Windows (x64) | Fully supported | Task Scheduler (hidden) / opt-in native service (`--native`, WinSW) |

Running from source requires [Bun](https://bun.sh). Windows runs natively without WSL. See the
[installation docs](docs-site/src/content/docs/getting-started/installation.md).

## Highlights

- **Use any LLM with Codex, Claude Code, Claude Desktop, and Grok Build** — 40+ providers out of
  the box, each keeping its own native UI.
- **Pool ChatGPT accounts safely** — thread affinity, quota-aware auto-switching, cooldown and
  fail-closed auth handling.
- **Combos** — one virtual model id with failover or weighted round-robin across providers. See
  the [combo guide](docs-site/src/content/docs/guides/combos.md).
- **Sub-agents on any model** — feature routed models in Codex's sub-agent picker, with v1/v2
  surface control and fallback chains. See the
  [sub-agent guide](docs-site/src/content/docs/guides/sub-agent-surface.md).
- **Log in once, skip the API key** — OAuth for xAI, Anthropic, and Kimi; or forward
  `codex login`, paste a key, or use `${ENV_VAR}` references.
- **Web search & vision sidecars** — non-OpenAI models get real web search and image understanding
  through a sidecar over your ChatGPT login.
- **See what's happening** — the dashboard shows providers, OAuth status, model selection, and a
  live request log with cache token counts.
- **Native macOS glance view** — see active parent/subagent rows and every available session,
  weekly, monthly, or credit quota window without duplicating provider setup outside the dashboard.
- **Clean exit, zero residue** — `ccx stop` restores Codex to its original configuration.

## Model routing

Target any configured provider and model with the `provider/model` syntax:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "google/gemini-3-pro" "Write unit tests for auth.ts"
codex -m "ollama/llama3" "Refactor this function"
```

Omit the `provider/` prefix to use the default provider or auto-match by model name pattern.
Provider model ids containing `/` are exposed with inner slashes aliased to `-`; the raw
full-slash form keeps working too. Details: [model routing docs](docs-site/src/content/docs/guides/model-routing.md).

## Providers & adapters

OpenAI (ChatGPT login or API key), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama
(local + Cloud), Cursor (experimental), and every OpenAI-compatible endpoint — plus DeepSeek,
Groq, OpenRouter, Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax,
Qwen Cloud, SiliconFlow, and more. Full list: `ccx init` or the
[provider docs](docs-site/src/content/docs/guides/providers.md).

## CLI

```bash
ccx init                       # interactive setup (writes config, wires Codex, offers the shim)
ccx start [--port 10100]       # start the proxy in the foreground
ccx stop                       # stop + restore native Codex
ccx service [install|start|stop|status|uninstall|remove]  # background service
ccx codex-shim install         # start the proxy on demand whenever `codex` launches
ccx health [--json]            # check immediate proxy liveness
ccx ready [--json] [--wait [--timeout <seconds>]]  # check post-sync readiness
ccx status                     # is the proxy running?
ccx gui                        # open the web dashboard
ccx provider <...>             # manage providers (list/add/edit/test/remove)
ccx account <...>              # manage ChatGPT accounts & API-key pools
ccx combo <...>                # manage failover / round-robin combos
ccx v2 <...>                   # multi-agent v1/v2 surface controls
```

Unpinned starts may pick another free port if the preferred one is busy; an explicit `--port`
never hops. Full reference: [CLI docs](docs-site/src/content/docs/reference/cli/lifecycle.md).

### Health and readiness

`GET /healthz` reports immediate proxy liveness. The unauthenticated `GET /readyz` endpoint reports
post-sync readiness with the sanitized JSON identity `{service, version, uptime, pid, port, status}`.
It returns `200` when `status` is `ready`; `pending` and terminal `failed` return `503` with
`Retry-After: 1`.

`ccx ready [--json] [--wait [--timeout <seconds>]]` performs one probe by default. `--wait` polls
for up to 45 seconds by default, but exits immediately when it observes terminal `failed`;
`--timeout <seconds>` sets a 1–300 second limit, requires `--wait`, and accepts only positive integers. CLI `--json` output is
`{ready, status, pid, port}`, where `status` is `ready`, `pending`, `failed`, or `unreachable`.

| Exit | Result |
| --- | --- |
| `0` | Ready |
| `1` | Not ready: pending, failed, timeout, or unreachable |
| `64` | Invalid arguments |

### Autostart: service vs shim

Use the **service** (`ccx service`) for an always-on proxy that restarts on crash. Use the
**shim** (`ccx codex-shim install`) for lightweight, on-demand startup without a background
daemon. Remove them with `ccx service uninstall` / `ccx codex-shim uninstall`.

### Uninstall

```bash
ccx uninstall                  # stop, remove service/shim, restore native Codex, clean up state
```

## Remote access

By default CodexCommander binds to `127.0.0.1` and needs no extra authentication. Binding beyond
loopback (`"hostname": "0.0.0.0"`) **requires** a bearer token — the proxy refuses to start
without `CODEXCOMMANDER_API_AUTH_TOKEN`, and every client request must carry it as
`x-codexcommander-api-key`. Details: [configuration reference](docs-site/src/content/docs/reference/configuration/server.md).

## Documentation

The docs — install, providers, routing, combos, sub-agents, sidecars, integrations, and the
CLI/config/management-API references — live in [`docs-site/`](./docs-site). They build locally;
publishing automation is not included in this repository.

Maintainer source-of-truth notes live under [`structure/`](./structure), contributor setup in
[`CONTRIBUTING.md`](./CONTRIBUTING.md), and security reporting in [`SECURITY.md`](./SECURITY.md).
Report undisclosed vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/pavelhov/CodexCommander/security/advisories/new),
not a public issue.

## Development

Source development requires the `bun` CLI on your `PATH`.

```bash
cd /path/to/CodexCommander
bun install
bun run typecheck
bun run test
```

See **[Contributing](./CONTRIBUTING.md)**.

## Disclaimer

CodexCommander is an independent, community-maintained project and is **not affiliated with or endorsed by OpenAI, Anthropic, or any other provider**.

Some providers — notably Anthropic (Claude) — may suspend or restrict accounts that route API traffic through third-party proxies. **Use at your own risk (UAYOR).** Before connecting a provider, review its Terms of Service to confirm that proxy-based access is permitted. The CodexCommander maintainers are not responsible for any account actions taken by upstream providers.

## License

MIT

The MIT license permits forks, modification, distribution, and sale subject to its notice condition.
It does not grant third-party product names, logos, or trademark rights. A rebrander or commercial
redistributor must audit names, logos, and trademarks; preserve the MIT and applicable third-party
notices; avoid claims that it pools or resells third-party credentials or subscriptions; and use its
own bundle identifier, signing and notarization, distribution metadata, and package metadata. This is a
release-operational checklist, not legal advice.

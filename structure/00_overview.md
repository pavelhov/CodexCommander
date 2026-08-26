# CodexCommander Structure

This folder is the maintainer source of truth for the current system shape. Public user workflows
belong in `docs-site/`, while `docs/` keeps investigations and diagnostic notes worth retaining for
debugging or source research.

## Reading order

| File | Purpose |
| --- | --- |
| [`00_overview.md`](00_overview.md) | Product boundary, local state, and non-negotiable invariants. |
| [`01_runtime.md`](01_runtime.md) | Process lifecycle, CLI, server endpoints, config, providers, adapters. |
| [`02_config-and-codex-home.md`](02_config-and-codex-home.md) | `CODEX_HOME`, the config surface, both injection forms, profile files, restore rules, and Codex-home diagnostics. |
| [`03_catalog-and-subagents.md`](03_catalog-and-subagents.md) | Shared Codex catalog and per-catalog backups, account namespaces and pool rotation, model cache, effort ceilings, multi-agent surface mode, and subagent ordering. |
| [`04_transports-and-sidecars.md`](04_transports-and-sidecars.md) | Responses HTTP/SSE, WebSocket opt-in, per-provider transport hardening, the transport inventory, sidecars, and compatibility guards. |
| [`05_gui-and-management-api.md`](05_gui-and-management-api.md) | Dashboard serving and surfaces, plus the `/api/*` management surface and which module owns each route area. |
| [`06_docs-and-release.md`](06_docs-and-release.md) | Local docs build, workflow map, branch policy, README ownership, and packaging constraints. |
| [`07_design-methodology.md`](07_design-methodology.md) | Design process discipline for new GUI, CLI, and user-facing surfaces. |
| [`08_openai-provider-tiers.md`](08_openai-provider-tiers.md) | OpenAI Pool/Direct account-mode and API credential/routing invariants. |

## Product boundary

CodexCommander is a local proxy for Codex. It does not patch Codex binaries. It changes local Codex
state by writing root routing keys and a model catalog — a provider table only in the
API-auth-header form described in [`02_config-and-codex-home.md`](02_config-and-codex-home.md) —
then serves the Responses data plane:

```text
Codex CLI / TUI / App / SDK
  -> http://127.0.0.1:<port>/v1/responses
  -> CodexCommander routing + adapter bridge
  -> upstream provider
```

Responses is the primary surface. The same listener also answers Anthropic-shaped `/v1/messages`
and OpenAI-shaped `/v1/chat/completions`. On the routed path those are inbound translations onto the
same routing and adapter bridge rather than separate products; `/v1/messages` additionally has a
native Anthropic passthrough branch that forwards without translation. The Live/Realtime surface is
different in kind — it resolves an OpenAI/ChatGPT relay and forwards to it directly, without the
adapter bridge.

The default install keeps native OpenAI/ChatGPT passthrough working through one option-aware
`openai` provider. Pool is the default and selects across main plus added accounts; Direct uses only
the current caller/main login. `openai-apikey` explicitly selects API-key transport, and the two
credential routes never fall through into one another. Built-in provider presets include Anthropic,
Google, Azure, Neuralwatt Cloud, Tencent Cloud Coding Plan, SiliconFlow, and separate Volcengine Ark
pay-as-you-go, Coding Plan, and Agent Plan endpoints. Additional
providers are routed by explicit `provider/model`, provider model lists, or the configured
`defaultProvider`.

[Decision Log]
- 목적과 의도: Add two widely used API-key providers through the canonical registry so CLI, GUI, login, routing, and documentation remain in parity.
- 기존 구현 및 제약 조건: Tencent Coding Plan is OpenAI-compatible but contractually restricted to interactive coding tools and has a dynamic, text-only model set. SiliconFlow exposes a dynamic OpenAI-compatible catalog whose reasoning controls vary by model.
- 검토한 주요 대안: Treat both as custom providers only; freeze a large SiliconFlow model list and reasoning map; expose Tencent without a usage warning.
- 선택한 방식: Add registry-derived key presets, keep live discovery enabled, seed only Tencent's currently documented coding-plan models, and surface Tencent's usage restriction in both the preset note and public docs.
- 다른 대안 대신 이 방식을 선택한 이유: Registry presets remove setup friction while live discovery avoids claiming that mutable catalogs are permanent. Avoiding speculative SiliconFlow reasoning metadata prevents invalid vendor-specific parameters.
- 장점, 단점 및 영향: Both providers appear consistently across supported setup surfaces. Tencent users receive an explicit policy warning; SiliconFlow reasoning controls remain conservative until model-specific limits can be represented safely.

## Local state

`~/.codexcommander/` is the default state root and `CODEXCOMMANDER_HOME` overrides it; the GUI and the
installed service resolve it the same way (`src/config.ts`). Ownership inside that root is tracked
by the uninstall manifest in `src/lib/config-ownership.ts`, which starts from a declared path list
and grows as CodexCommander claims further paths at runtime — so the manifest, not this table, is what
bounds uninstall. This table groups the state by purpose; it is not an exhaustive file list.

`$CODEX_HOME` is a separate root with a separate owner, and CodexCommander writes there too: removing the
CodexCommander state root does not undo those writes. Putting native Codex back is the job of the
config-only `ccx restore`/`eject` escape, not of deleting a directory or replaying the injection
journal.

| Path | Owner | Notes |
| --- | --- | --- |
| `~/.codexcommander/config.json` | CodexCommander | Main config written by `ccx init` and the dashboard. Atomic temp-then-rename. |
| `~/.codexcommander/auth.json` | CodexCommander | OAuth tokens; not committed. Shape: `provider -> { activeAccountId, accounts[] }`. ChatGPT scratch OAuth stays separate from the Codex account store; identity-less providers (kimi/kiro/cursor) replace their active slot. |
| `~/.codexcommander/codex-accounts.json` | CodexCommander | Hardened main-plus-added credential store used by `openai` in Pool mode. |
| `~/.codexcommander/catalog-backup-<id>.json` | CodexCommander | Pristine Codex catalog backup for restore, keyed by a hash of the catalog path (see [`03_catalog-and-subagents.md`](03_catalog-and-subagents.md)). |
| `~/.codexcommander/usage.jsonl` | CodexCommander | Append-only request usage log (0o600); request metadata + token counts only, never prompts or auth. |
| `~/.codexcommander/codexcommander.pid`, `runtime-port.json`, `system-env-port` | CodexCommander runtime | Live process identity and the port a client should reach; rewritten on start. `runtime-port.json` also carries the protected per-process listener-attestation key used before CLI diagnostics attach a management bearer. |
| `~/.codexcommander/codex-runtime.json`, `codex-runtime-clamp.json` | CodexCommander Codex runtime | Selected Codex executable/version state and effort-clamp diagnostics. Not process identity: these persist a resolved choice and a diagnostic, so losing them changes behavior until re-resolved. |
| `~/.codexcommander/service-state.json`, `service.log`, `service-api-token`, `codexcommander-service-launcher.vbs`, `codexcommander-service-task.xml`, `codexcommander-service.cmd`, `winsw`, `tray-state.json`, `tray-heartbeat.json`, `codexcommander-tray.ps1`, `codexcommander-tray-*.ico` | CodexCommander operators | Installed-service and Windows tray artifacts and bookkeeping. |
| `~/.codexcommander/responses-state.json`, `usage-debug.jsonl`, `crash.log`, `artifacts/` | CodexCommander diagnostics and artifacts | Bounded caches, diagnostics, and generated image/video artifacts served locally. |
| `~/.codexcommander/integrations/opencode/{proxy-api-key,journal.json,backups/}` | CodexCommander OpenCode integration | Hardened proxy-admission token delivery, before-image backup, and journal for the optional persistent OpenCode connection. The journal may only target OpenCode's resolved global JSON/JSONC config and bounds exact or surgical restore. |
| `~/.codexcommander/codex-shim.json`, `*.lock`, `kimi-device-id`, `mimo-client-id` | CodexCommander bookkeeping | Shim restore obligations, cross-process locks, and per-install client identifiers. |
| `~/.codexcommander/.codexcommander-owner.json`, `.codexcommander-uninstall.json` | CodexCommander | Ownership marker and the manifest that bounds what uninstall may remove. Both live in the CodexCommander state root, not in `$CODEX_HOME`. |
| `$CODEX_HOME/config.toml` | Codex, edited by CodexCommander | Active provider and provider table. |
| `$CODEX_HOME/codexcommander.config.toml` | CodexCommander | Optional profile for explicit Codex opt-in. |
| `$CODEX_HOME/codexcommander-catalog.json` | CodexCommander | Shared native+routed model catalog. |
| `$CODEX_HOME/codexcommander-journal.json` | CodexCommander | Recovery authority for coordinated injection/crash recovery. The config-only native escape does not replay it; a later explicit Start/Route Back retires it only when the existing coordination and surface evidence prove it stale. |
| `$CODEX_HOME/models_cache.json` | Codex, invalidated by CodexCommander | Cache invalidated after model/catalog changes. |
| `$XDG_CONFIG_HOME/opencode/opencode.json[c]` | OpenCode user config, minimally edited by CodexCommander only after explicit integration Apply | OpenCode owns the file. CodexCommander edits only `provider.codexcommander`, preserves unrelated JSONC/JSON content, and never reads an OpenCode auth store. |
| `dist/`, `gui/dist/`, `node_modules/` | generated | Build output/dependencies. |

## Non-negotiable invariants

- `websockets` defaults to `false`; only `true` advertises `supports_websockets`.
- `CODEX_HOME` wins over `~/.codex` when present and valid.
- Root TOML keys such as `model_provider` and `model_catalog_json` must stay before any table.
- Routed model slugs use `provider/model`.
- OpenAI has one `openai` Codex-login provider with Pool(default)/Direct modes and a separate `openai-apikey`; see [`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).
- Codex `spawn_agent` advertises the first five featured catalog entries as suggestions; a known exact compatible catalog ID may still be passed to native spawn_agent.
- The management plane (`/api/*`) and the data plane (`/v1/*`) never share an admission credential.
- `ccx stop`, `ccx restore`, and service stop/uninstall must leave native Codex usable without modifying tasks, history, rollouts, or authentication.

## Writing rule

Keep this directory flat. Add or extend lexicographically ordered `NN_topic.md` files; do not add
subdirectories. If one file grows too broad, split the next stable topic into the next unused number
instead of creating nested folders.

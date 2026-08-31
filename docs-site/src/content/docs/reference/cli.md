---
title: CLI Reference
description: Command dispatch, exit codes, and links to every ccx command family.
---

The CodexCommander CLI is `ccx`. It dispatches on the first command name, with documented aliases such
as `setup`/`init`, `restore`/`eject`, and `models`/`model` reaching the same operation. Unknown
commands and invalid command shapes are errors.

Run `ccx help` (or `ccx --help` / `ccx -h`) for top-level usage. Run `ccx help <command>`,
`ccx <command> --help`, or `ccx <command> -h` for a command registered in the help table. Help and
version commands are read-only: they do not start, stop, install, uninstall, or rewrite Codex or
CodexCommander state.

## Command families

- [Lifecycle](/reference/cli/lifecycle/) — setup, proxy and service lifecycle, health, diagnostics,
  catalog sync, and the dashboard.
- [Providers, accounts, and models](/reference/cli/providers-accounts/) — provider configuration,
  authentication, credential pools, quota, custom models, visibility, selected models, and context
  caps.
- [Agents, routing, and integrations](/reference/cli/agents/) — multi-agent controls, combos,
  observability, admission keys, client integrations, runtime settings, and validated configuration.
- `ccx media` — attested media settings, safe status, durable-job recovery, and human-confirmed
  experimental capability actions.

## Media commands

`ccx media status` and `ccx media jobs [list]` read the authenticated `/api/media` resource and
return safe, redacted state. `ccx media settings --images on|off --videos on|off --source
subscription_oauth|api_key` changes the two independent switches or selected source without changing
xAI chat authentication. The saved source applies to new work only; accepted jobs retain their
original credential binding. Settings are human-only: the command requires fresh confirmation, both
stdin and stdout to be TTYs, and a second attestation of the exact same runtime after the prompt.
It cannot be performed by a bare admin-token request.

`ccx media jobs wait <opaque-job-id> --revision <n>` follows one job. `open`, `reveal`, and
`ack-job` require an opaque job ID and its revision; the server derives and revalidates any artifact
path, then uses a fixed platform opener with a scrubbed environment. `ccx media recovery status`,
`reset`, and `acknowledge` expose read-only/future-journal recovery without replaying uncertain work.
Active or locked journals cannot be quarantined. The runtime reconciles a proven hard-link publication
crash alias safely and owns video retention during completion and startup recovery.

`ccx media probe` is a paid, human-only action, not a normal health check. It rejects `--yes`,
requires both stdin and stdout to be TTYs, and re-attests the same live management target before the
request. The fixed OAuth-only operation is one image and one-second 1080p video; API-key fallback is
disabled, billing attribution is unknown, and ambiguous submission may consume quota without a
result. The image step must settle before video submission; accepted video is reconciled in the
background and at startup without a new POST. The probe remains preflight-disabled until explicit U8
safety approval.

## Headless behavior

Management commands round-trip the live proxy's management API, using the recorded runtime port and
identity checks rather than maintaining a second configuration path. A stopped or unreachable proxy
is represented as HTTP 503 and produces a nonzero CLI exit. Commands explicitly documented as
offline configuration operations can instead validate and edit the config file without a live
proxy.

List or status is the default where unambiguous. Use `--json` for structured snapshots and
`ccx observe logs --follow --jsonl` for a streaming request-log feed. Theme, language, navigation,
and other purely visual browser state have no CLI equivalent; Cloudflare Tunnel setup is outside
this command set.

## Exit codes and confirmation

Successful commands exit 0. Invalid usage, unknown commands or resources, failed API operations,
and unavailable required services exit nonzero. `ccx health` specifically exits 0 only when the
proxy is healthy and 1 otherwise, so it can be used as a service probe. Scripts should test the exit
code instead of scraping human-readable output.

Destructive removal, import, and credit-consumption operations that advertise confirmation
require `--yes` in non-interactive use. The flag is an explicit opt-in; omitting it must not silently
confirm the action.

## Version

`ccx --version`, `ccx -v`, and `ccx version` print one script-friendly version line and exit.

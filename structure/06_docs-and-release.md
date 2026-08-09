# Docs And Release SOT

## Public docs

The public documentation site lives in `docs-site/` and is built with Astro + Starlight. English is
served at the site root, with Korean under `/ko`, Simplified Chinese under `/zh-cn`, Russian under
`/ru`, and Japanese under `/ja`. `docs-site/astro.config.mjs` is the locale source of truth.

Manual navigation is defined in `docs-site/astro.config.mjs`. When adding a public page, update the
sidebar and either add localized copies or intentionally accept Starlight fallback behavior.

## Docs build

There is no currently published docs host. Build and validate the Astro site locally:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

Publishing automation is not included in this repository.

## GitHub workflow map

Only these workflows are present under `.github/workflows/`:

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | every `pull_request`, and `push` to `main` | Single automatic quality gate. One Ubuntu job named `ci` runs install, typecheck, privacy scan, GUI lint/i18n/tests/build, the Bun test suite, and a CLI help smoke. |
| `.github/workflows/cross-platform.yml` | `push` to `main`, or manual dispatch | Post-integration verification on macOS and Windows, including the test suite and macOS companion checks. It is not a pull-request gate. |
| `.github/workflows/service-lifecycle.yml` | **manual dispatch only** | Optional three-platform service smoke (Linux systemd, macOS launchd, Windows Scheduled Tasks). Installs, verifies, stops, and uninstalls the background service. It is not part of the automatic PR gate. |

Repository administrators may use the GitHub ruleset **Always-allow** bypass when a branch or path
rule would otherwise block an intentional admin action. That bypass is for owner/admin recovery and
exceptional maintenance, not a substitute for review on ordinary pull requests.

## Root README

The root READMEs are the concise product entrypoint. They should explain what CodexCommander does,
how to run it from source, where Codex state is touched, and where the full docs live. Deep
implementation invariants belong in `structure/`, not the README.

The English README is canonical. Localized READMEs and docs-site mirrors must not contradict current
source companion, OpenCode, or lifecycle behavior.

## Engineering notes

`docs/` contains maintained architecture decisions, design-system references, and focused
implementation notes. Cross-system invariants belong in `structure/`; public workflows belong in
`docs-site/`.

## Branch policy

- **`main` is the sole default, integration, and pull-request target.** Open ordinary feature and
  fix pull requests against `main`. There are no `dev`, `development`, or `preview` branches.
- Bun-native TypeScript on `main` is the only runtime line; no `go/` tree is tracked here. If native
  code returns, the expectation is an incremental module landing on `main`, not a second full-runtime
  branch.
- Security work in progress does not go in any tracked directory. Scratch space only; only the
  published outcome — the fix, its regression test, the release note, the advisory once public —
  reaches the repository.

## Maintenance governance

`MAINTAINERS.md` remains the human roster/review policy document when present. GitHub repository
settings and rulesets are authoritative for actual permissions, required checks, and admin bypass.
Owner/admin **Always-allow** bypass is the documented exception path for protected rules; it does not
replace review for ordinary contributions.

## Source runtime and command names

The source runs directly on a user-installed Bun runtime. `package.json` reserves two equivalent
command names for local linking and packaged bundles:

```text
codexcommander
ccx
```

Both bins point at the on-disk launcher `bin/ccx.mjs`. No registry package is currently published.

Invariants:

- The only user-facing command names are `codexcommander` and `ccx`.
- The plain-Node launcher owns `CCX_BUN_PATH` selection before Bun can load project dotenv, and stamps
  the chosen source/path pair. Durable service/shim paths bake that already-selected executable.
- Current installation docs require Bun and describe source-checkout execution only.

## Publishing

Publishing automation is not included in this repository.

## Continuous integration

`.github/workflows/ci.yml` is the ordinary automatic quality gate. It runs on every pull request and
on pushes to `main`. The single job is:

```text
runs-on: ubuntu-latest
name: ci
```

Current steps, in order:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun run privacy:scan
cd gui && bun run lint
cd gui && bun run lint:i18n
cd gui && bun test tests
cd gui && bun run build
bun test --isolate tests
bun run src/cli/index.ts help
```

The CI quality gate does not build docs, run multi-OS matrices, or package the macOS app.

Service-lifecycle verification is separate and **manual-only** via
`.github/workflows/service-lifecycle.yml`. Use it when a service-touching change needs real
systemd/launchd/Task Scheduler proof; it is not required for ordinary PR greenness.

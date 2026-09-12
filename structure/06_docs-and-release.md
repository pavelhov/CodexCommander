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

- **`development` is the latest integration branch.** Branch ordinary feature/fix work from it
  and target those pull requests to it. **`main` remains the stable default branch.** Promote
  `development` through a separate PR after the combined fixes and qualification checks pass.
- Both branches share the Bun-native TypeScript runtime; no `go/` tree is tracked here.
  `development` stages changes rather than maintaining a separate runtime port.
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
cd gui && bun run test
cd gui && bun run build
bun run test:parallel
bun run src/cli/index.ts help
```

The CI quality gate does not build docs, run multi-OS matrices, or package the macOS app.

Service-lifecycle verification is separate and **manual-only** via
`.github/workflows/service-lifecycle.yml`. Use it when a service-touching change needs real
systemd/launchd/Task Scheduler proof; it is not required for ordinary PR greenness.

## Authenticated macOS preview updates

The macOS updater uses Sparkle 2.9.6 at revision
`ac2def288cbff5cfc7df3ffef6abdf45b72bcb0a`. SwiftPM verifies its binary archive
checksum from the pinned manifest. The complete universal framework, versioned
links, executable helpers and XPC services are staged separately from the
symlink-free application sources. Nested helpers, framework, runtime code and
outer bundle are signed in that order; `codesign --deep` is verification only.
Apple Developer ID signing and notarization remain deferred. Ad-hoc packages
remain explicitly **unnotarized previews**, even though update authenticity is
mandatory. `distribution_ready=false` describes Apple distribution assessment,
not Ed25519 verification.

Maintainer configuration (no production update key is supplied by this repository):

- `MACOS_UPDATE_PUBLIC_KEY_FILE`: physical, single-link file containing the
  canonical Base64 32-byte Ed25519 public key. Store the private counterpart in
  maintainer secret storage with a recovery backup; only this public value is
  embedded as `SUPublicEDKey`. Keep the key across later Apple signing changes.
- `MACOS_BUILD_NUMBER`: explicit positive integer, at most 15 digits. It is
  independent of the display version and cannot have leading zeroes.
- `MACOS_PREVIOUS_BUILD_NUMBER`: the highest build identifier from the complete
  published inventory, including supported older feeds. For the one-time
  pre-updater bootstrap the baseline is `0.1.6`. Allocate above it; reuse or
  decrease fails. Packaging checks both numeric order and the pinned Sparkle
  comparator. Archive names include the build and cannot be overwritten.
- `SPARKLE_TOOLS_DIR`: `bin` from the official Sparkle **2.9.6** release archive.
  `macos-appcast.ts` pins SHA-256 hashes of `generate_appcast` and `sign_update`.
  A tool upgrade needs reviewed hash/dependency updates together.
- `SPARKLE_PRIVATE_KEY_FILE`: mode 0600 (or stricter), physical, single-link
  private key outside the repository. The generator reads it through stdin,
  never argv or logs; it does not import keys into Keychain. Ignored `.tmp`
  permits disposable qualification fixtures only, never a production anchor.

Local builds without a public key explicitly set
`CodexCommanderUpdaterEnabled=false`; the UI must not initialize Sparkle for
these builds. Configured builds require an explicit integer build. Release
packaging requires the public key, build inventory baseline, a universal build,
and the existing clean working tree gate. The embedded policy is
`SURequireSignedFeed=true`, `SUVerifyUpdateBeforeExtraction=true`,
`SUSignedFeedFailureExpirationInterval=0`, and `SUAllowsAutomaticUpdates=false`.
There is no expiry-based unsigned-feed fallback or unattended installation.

Prepare a release locally with these variables set, then run
`bun run package:macos`. Keep a dedicated physical asset directory containing
all still-supported immutable ZIPs and the authenticated previous `appcast.xml`.
Add the final new ZIP and optional same-stem Markdown release notes. Set
`RELEASE_VERSION` to the stable display version and run:

```bash
bash scripts/generate-macos-appcast.sh --generate /path/to/release-assets
bash scripts/generate-macos-appcast.sh --verify /path/to/release-assets
```

Generation requires macOS, Bun, and Python 3 (for XML parsing). It works in a
private staging directory, preserves previous feed items, disables delta
creation, embeds release notes, verifies Ed25519 feed/archive signatures against
the external public key, verifies lengths and immutable GitHub archive URLs,
then atomically replaces the feed. After bootstrap, an authenticated previous
feed is required. `--verify` is the read-only dry run for complete asset checks;
neither command publishes or contacts GitHub. Do not change an archive after
signing. External release notes are not part of this workflow; embed them.

The fixed stable discovery URL is
`https://github.com/pavelhov/CodexCommander/releases/latest/download/appcast.xml`.
Create a **draft** release first, upload the complete signed feed, final ZIPs and
checksums, and retain prior referenced archives at their original immutable
release URLs. Download the draft assets into a fresh directory and run the same
`--verify` check, including all referenced older ZIPs. Verify the intended tag,
clean source commit and release qualifications before publishing and marking it
latest in one final maintainer action. Then fetch the fixed URL through its
GitHub redirect and verify the served bytes and archives again. Never mark an
incomplete release latest; no publishing automation is supplied. Checksums are
inventory aids, not substitutes for Ed25519 signatures. End-to-end current/new
installed-app tests and explicit distribution/key-handling security review in
the PR remain release gates; local asset generation is not a claim of those
qualifications.

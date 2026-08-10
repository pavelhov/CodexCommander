# AGENTS.md

Guidance for AI agents (and humans) working on or reviewing this repository.

## What this project is

CodexCommander (`ccx`) is a universal provider proxy for OpenAI Codex and Claude Code:
one local proxy that lets Codex CLI/App/SDK and Claude Code use many LLM
providers (Claude, Gemini, Grok, DeepSeek, Ollama, and more). The runtime is
Bun-native TypeScript with no separate server compile step.

## Repository layout

- `src/` — proxy runtime: routing, provider adapters, config, management API.
- `tests/` — flat Bun tests (`tests/*.test.ts`); shared fixtures in
  `tests/helpers/`, broader scenarios in `tests/e2e-style/`.
- `gui/` — React + Vite dashboard; packaged output is served from `gui/dist`.
- `docs-site/` — public-docs source (Astro + Starlight), built and validated locally.
- `structure/` — maintainer invariants and architecture notes; read before
  changing shared subsystems.
- `scripts/` — packaging and maintenance tooling.

Read the nearest nested `AGENTS.md` before changing files in a scoped
directory (`src/`, `gui/`, `docs-site/`, `scripts/`, `.github/`).

## Security working notes

**Security work is done in scratch space, never in a tracked directory.** That
includes unreleased findings, severity assessments, draft advisories, exploit
or bypass reasoning, reproduction steps for an unfixed defect, and
pre-disclosure patch plans.

Use `.tmp/` in the working tree (already gitignored) or a `mktemp -d` path.
A tracked directory or a second repository is not acceptable: both are durable,
replicated publication surfaces and can outlive the embargo.

**This binds maintainers exactly as it binds contributors and agents.**
Seniority is not an exemption.

Only the published outcome reaches a repository — the fix itself, its
regression test, the release note, the advisory once it is public. Draft the
advisory in scratch space and delete the scratch directory once the advisory is
live.

This applies to `AGENTS.md`-following agents as much as to humans. If a task
asks you to write up a security finding, put the write-up in scratch space and
say where it is; do not add it to `structure/`, `docs-site/`, or any other
tracked directory.

## Commands

```bash
bun install
bun run typecheck      # bun x tsc --noEmit (strict)
bun run test           # full tests/ suite
bun run lint:gui       # GUI eslint
bun run privacy:scan   # credential/privacy scan used by CI
bun run build:gui      # Vite GUI build
```

Run `bun run typecheck` and `bun run test` before proposing or approving any
non-trivial change. CI runs these on Linux, Windows, and macOS.

## Issues and pull requests (agents)

Agent-created issues and PRs must use the repository templates.

- **Creating an issue:** open it through the template chooser and use the
  matching form in `.github/ISSUE_TEMPLATE/` — `bug_report.yml` (Bug report),
  `feature_request.yml` (Feature proposal), `documentation.yml`
  (Documentation), or `provider_compatibility.yml` (Provider or API
  compatibility). Keep the form's section headings exactly as generated.
  `.github/ISSUE_TEMPLATE/config.yml` disables blank issues, so there is no
  freeform fallback.
- **Opening a pull request:** fill every section of
  `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist).
  A PR that changes the GUI should include a screenshot of the UI change in
  the description. When the PR resolves an issue, add `Closes #<number>` to
  link it; GitHub auto-closes the linked issue when the PR merges into the
  default branch (`main`).

## Branch policy

- `main` — the sole integration branch, the default branch, and the target
  for every pull request. There is no `dev`, `development`, or `preview`
  line.

Bun-native TypeScript on `main` is the only runtime line. If native code
returns, the expectation is an incremental module (for example Rust via N-API)
landing on `main`, not a second full-runtime branch.

Merge requirements are enforced by a GitHub **ruleset** on `main`, configured
in repository settings (not in this repository's files). Two invariants:

- **Owner/admin bypass is guaranteed.** The ruleset must list the
  *Repository admin* role as a bypass actor with "Always allow" bypass mode,
  so the owner can merge or push despite failing or pending checks. Classic
  branch protection with "Include administrators" must **not** be used — it
  removes exactly that escape hatch.
- Ordinary contributors get no bypass: the ruleset requires the `ci` check
  (the single aggregate job in `.github/workflows/ci.yml`) and a pull request
  for everyone not on the bypass list.

Rebase pull requests are welcome. Bringing a stale branch onto the current head
is ordinary maintenance — open it as a normal pull request and name the source
commits in the description.

[`MAINTAINERS.md`](./MAINTAINERS.md) is authoritative for review and merge
policy (approvals, CI requirements, security review, promotion). This file
summarizes; it never overrides it.

## Review guidelines

These rules apply to all code reviews on this repository, including automated
reviewers (Codex and similar bots).

- **Language:** always review in English, regardless of the PR or issue
  language. Be detailed and specific: name the file and line, describe the
  concrete failure mode, and suggest a fix. Avoid vague or purely stylistic
  commentary.
- **Branch targeting:** flag any pull request that does not target `main`.
- **Security boundary (highest priority):** changes touching authentication,
  credential/token handling, OAuth flows, GitHub Actions workflows, publishing
  or release distribution, or
  dependency installation require explicit security review per
  `MAINTAINERS.md`. Treat token logging/serialization, secret exposure,
  workflow permission escalation, and mutable third-party action refs as
  release blockers.
- **Runtime constraints:** the proxy is Bun-native. Flag Node-only APIs,
  assumptions about a compile step, or code paths that break `bun run
  typecheck` / `bun run test`.
- **Tests:** behavior changes in `src/` need a focused regression test near
  the existing tests for that subsystem. Shared routing, adapter, config, or
  server changes need the full suite green.
- **Docs sync:** user-facing behavior changes should update `docs-site/` (and
  keep translated locales from contradicting the English source).
- **Privacy:** `bun run privacy:scan` must stay green; never introduce logging
  of request bodies, API keys, or account identifiers.

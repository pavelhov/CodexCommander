# Contributing

Thanks for helping with this project.

- Public user docs live in [`docs-site/`](./docs-site)
- Current maintainer invariants live in [`structure/`](./structure)
- Maintainer roles and merge policy live in [`MAINTAINERS.md`](./MAINTAINERS.md)
- Agent-facing repository and review rules live in [`AGENTS.md`](./AGENTS.md)

## Branches

- `main` — the sole integration branch, the default branch, and the target of
  every pull request. There is no `dev` or `preview` line.

Rebase pull requests are welcome: bringing a stale branch onto the current head
is normal contribution. Note the source commits in the description.

Source development requires the `bun` CLI on your `PATH`. Contributor commands
such as `bun install`, `bun run test`, and `bun run prepush` run from that local
Bun installation. No registry package or publishing automation is currently provided.

## Pull request contract

A ready-for-review PR is the author's claim that the change is complete,
understood, tested, and suitable for merging. Opening a PR does not transfer
responsibility for the branch to maintainers.

- **You do not need permission to fix something.** An unplanned PR for a bug
  you hit is welcome. Opening an issue first helps for larger or
  design-shaped work, but it is not an admission requirement.
- Authors own CI failures, missing tests, merge conflicts, and review fixes.
  Maintainers identify problems; they are not required to implement or debug
  the fixes for contributors.
- Behavior changes include focused regression tests. Claims such as "tested"
  or "CI" without named commands and results are not evidence — name the
  commands you ran and what they printed.
- Authentication, workflow, release automation, and dependency-installation
  changes require explicit security review before merge (see
  [`MAINTAINERS.md`](./MAINTAINERS.md)). Those are the places where a bad
  merge is expensive and hard to unwind.
- A PR that stalls with unresolved review feedback may be closed, with the
  reason stated. A closed PR can be reopened once the stated reason is
  resolved, or replaced with a clean one.

## Pre-push hook

After cloning, run once to install a local pre-push hook that runs the
typecheck, unit-test, privacy-scan, and (when `gui/` changed) GUI eslint and
React Doctor portions of the CI gate:

```sh
bun run setup:hooks
```

This installs a `pre-push` hook (into the hooks dir git reports, so worktrees
and `core.hooksPath` work) that runs `bun run prepush` — `typecheck`,
`lint:gui:if-changed`, `test`, `privacy:scan`, and `doctor:gui:if-changed` —
before every `git push`. Both `lint:gui:if-changed` and
`doctor:gui:if-changed` run their check only when the push touches `gui/`.
The same checks run in CI as a single Ubuntu job (CI additionally builds the
GUI and smoke-tests the CLI). Skip in an emergency with
`git push --no-verify`.

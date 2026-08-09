# Maintainers

This document lists the people responsible for maintaining this repository and
defines the project's review and merge policy.

## Current maintainers

| GitHub account | Project role | Responsibilities |
| --- | --- | --- |
| [@pavelhov](https://github.com/pavelhov) | Owner | Project direction, releases, repository administration, security review, and final governance decisions |

The table describes project responsibilities. Actual repository permissions
remain controlled through GitHub repository settings.

## Branch and merge policy

- `main` is the sole integration branch, the default branch, and the target
  of every pull request. There are no `dev`/`development`/`preview` lines.
- The owner may push to `main` directly for maintainer-owned integration
  work, urgent repairs, or incident recovery. The same CI and documentation
  expectations still apply.

### Merge enforcement invariant (external GitHub settings)

Merge requirements live in a GitHub **ruleset** on `main` (Settings → Rules →
Rulesets), not in repository files. Two invariants MUST hold:

1. **Owner/admin bypass is guaranteed.** The ruleset lists the *Repository
   admin* role under "Bypass actors" with bypass mode **Always allow**, so
   the owner can merge with failing or pending checks and push directly when
   needed. Classic branch protection with "Include administrators" MUST NOT
   be used — it removes exactly that escape hatch. If both systems ever
   coexist, the classic rule must not bind admins either.
2. **Ordinary contributors get no bypass.** For everyone not on the bypass
   list, the ruleset requires a pull request and the aggregate **`ci`** check
   from `.github/workflows/ci.yml`. That workflow has no `paths:` filter, so
   the required check is created on every pull request and cannot sit Pending
   forever on an out-of-scope change.

In-repository automation must never add a merge gate that the owner cannot
bypass through the ruleset's documented Repository-admin exception.

## Review policy

- Reviews are in English, specific, and evidence-backed (see `AGENTS.md`).
- Authentication, credential handling, GitHub Actions workflows, publishing or
  release-distribution automation, and dependency-installation changes require explicit security
  review before merge. On a single-maintainer change this means the security
  considerations are written down in the PR description, not merely thought
  about.
- A new or promoted provider preset is a credential-destination change and
  needs primary-source evidence (documented OpenAI-compatible endpoints,
  terms of service, operating entity, a named maintenance owner, and a
  citable verification date) before merge.
- Treat token logging/serialization, secret exposure, workflow permission
  escalation, and unpinned third-party action refs as release blockers.

## Releases

Publishing automation is not included in this repository.

## Maintainer changes

Adding or removing a maintainer requires the owner's agreement and updates to
this file and [`.github/CODEOWNERS`](./.github/CODEOWNERS) in a reviewed pull
request.

## Security reports

Private vulnerability reports are handled according to
[`SECURITY.md`](./SECURITY.md). Do not disclose secrets or exploit details in
a public issue.

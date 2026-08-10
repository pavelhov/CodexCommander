---
title: Pull request quality contract
description: Review readiness, contributor responsibility, and closure policy for CodexCommander pull requests.
---

## You do not need permission to fix something

An unplanned pull request for a bug you actually hit is welcome. Several of this
project's better fixes arrived exactly that way — a routed model stalling after
tool calls, a provider sending the wrong model parameters, images being flattened
out of tool results. None of those started from a planning discussion, and a
gate that required one would have lost all of them.

Opening an issue first genuinely helps for larger or design-shaped work, where
agreeing on the approach saves you from building the wrong thing. That is advice,
not an admission requirement.

## What a ready pull request claims

Opening a PR for review is a claim that the change is complete, understood, and
tested. Opening it does not transfer responsibility for the branch to the
maintainers.

Authors are expected to understand every changed line, name the exact commands
and results behind any validation claim, add focused regression coverage for
behavior changes, and stay available to resolve CI and review feedback.
Maintainers identify problems; they are not expected to repair contributor
branches, write the missing tests, or translate automated findings into patches
on your behalf.

"Tested" or "CI passes" without named commands and results is not evidence.

## Target and description

- Target **`main`**. It is the sole default, integration, and pull-request branch.
- Branch from the current **`main`** tip.
- Write a real description: a **Summary** of what changed and why, plus how you
  verified it. Empty bodies and placeholder-only text are not review-ready.
- If the title or description mentions the dashboard UI (`gui`), include a
  screenshot of the UI change.

## Automated checks

Ordinary contributions have **one automatic check**: **`ci`**. It is the
stable aggregate quality gate for every pull request. No repository workflow
adds another automatic contributor merge gate.

Repository administrators may use the GitHub ruleset **Always-allow** bypass when
a branch or path rule would otherwise block an intentional admin action. That
bypass is for admin recovery and exceptional maintenance; contributor pull
requests still go through review on `main`.

Publishing automation is not included in this repository.

Code review bots, when enabled, are advisory. Address what they get right; say
why when they are wrong. They do not replace the author's verification claim.

## Sensitive surfaces

Authentication, credential handling, GitHub Actions workflows, release
automation, and dependency installation need explicit maintainer attention
before merge. A bad merge on those surfaces is expensive and hard to unwind.
Everything else remains open to ordinary contribution on `main`.

## When a pull request is closed

A PR that stalls with unresolved review feedback may be closed, with the reason
stated plainly. Closure is not a verdict on the contributor: reopen it once the
stated reason is resolved, or replace it with a clean one. Ask if the reason is
not clear.

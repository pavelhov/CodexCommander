# 011 — Agent Command Center design QA

Status: COMPLETE

## Implementation reviewed

- Workspace: `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx`
- Run Policy: `gui/src/components/subagents-workspace/SubagentRunPolicySection.tsx`
- Page/data integration: `gui/src/pages/Subagents.tsx`,
  `gui/src/pages/use-subagent-run-policy.ts`
- Styling: `gui/src/styles-subagents-workspace.css`

No raster concept asset is part of the product or required for future review;
the production interface is React/CSS and uses the existing dashboard tokens.

## Truthfulness decisions

- Active Roster controls the five picker-visible models advertised to
  `spawn_agent`; it is not an execution scheduler.
- Agent Library represents the current catalog, not a health-checked promise
  that every provider request will succeed.
- Preferred guidance is advisory. It does not silently become the fallback
  primary or force delegation.
- V2 concurrency counts total threads including the root; V1 counts children.
- Plaintext compatibility warns that every V2 worker message from the parent,
  including native-worker messages, is plaintext.
- Saved roster entries that fail to enter the effective V2 window are reported
  explicitly instead of hiding behind a green catalog badge.

## Live review

The current page was inspected at 1440 × 1000 after a cold app/proxy restart.
It showed:

- five of five quick picks in the requested order;
- DeepSeek, Kimi, GLM, Grok, and Sol marked at positions 1–5;
- **Codex workers current** with no roster exclusions;
- **Concurrent v2** and **Plaintext compatibility**;
- a six-thread limit and roster guidance enabled;
- no dirty state and no enabled save button before a change.

A separate manual acceptance task spawned all four external roster workers in
parallel, awaited completion, and completed a Kimi follow-up without a model
substitution or timeout.

## Automated verification

- Full GUI suite: 715 tests passed.
- Localization lint, ESLint, React Doctor, and production build passed.
- Component coverage includes add/remove/reorder, keyboard access, dirty/save,
  catalog freshness/exclusions, protocol and delivery persistence, fallback,
  concurrency, and default-mode plaintext disclosure.

# 011 — Agent Command Center design QA

Status: prior visual audit retained; integration gates rerun on branch

## Visual references

- An earlier local full-screen concept informed the workspace implementation but is not
  tracked; the branch-owned reference below is the durable review artifact.
- Branch-owned Run Policy reference for this workstream:
  `assets/run-policy-reference.png`
- Primary implementation: `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx`
- Run-policy implementation:
  `gui/src/components/subagents-workspace/SubagentRunPolicySection.tsx`
- Page/data integration: `gui/src/pages/Subagents.tsx` and
  `gui/src/pages/use-subagent-run-policy.ts`
- Styling: `gui/src/styles-subagents-workspace.css`

The image reference informed hierarchy only. Production UI remains React and CSS, uses
the existing dashboard tokens, and introduces no raster UI assets.

## Prior live visual audit

The earlier implementation was compared at 1536 × 1024 in light theme and at an
approximately 390 × 844 mobile viewport. The live state contained a five-model,
Kimi-first roster, a large model catalog, Classic v1 routing, a five-thread limit, and
collapsed advanced fallback controls.

The audit verified:

- desktop roster/library layout and stacked mobile layout;
- readable long model IDs and non-overlapping controls;
- 44-pixel mobile targets, keyboard reorder support, and assistive labels;
- catalog search and factual capability filters;
- roster add/remove/reorder and dirty/save behavior;
- policy protocol, guidance, preferred model, fallback, thread, effort, and sync
  controls;
- advanced fallback-chain add/reorder/remove interactions;
- stale-catalog preservation and warm-cache revalidation; and
- zero error-level browser console messages during the tested flow.

Issues found in the first comparison—mobile control overlap, clipped capability chips,
lost warm-cache status, a weak advanced-section affordance, singular-minute copy, and
ambiguous empty fallback—were corrected before this branch checkpoint.

## Truthfulness decisions

- The roster is five advertised `spawn_agent` choices, not an execution scheduler.
- The library is the current catalog, not a health-checked availability claim.
- Compatibility is evaluated at the task's resolved parent route; the settings page
  does not invent a numeric incompatible-model count without parent context.
- Subjective quality labels and the concept's fictional `Fast` tag were not shipped.
- Branding and whole-product rename work remain deferred.

## Current branch verification

- Focused Agent Command Center and policy tests: 33 passed, 0 failed.
- Nullable protocol/thread backend gate: 90 passed, 0 failed.
- TypeScript typecheck, GUI localization lint, GUI lint, and production build passed.
- Docs build passed with `bun --bun run build`. The default Node 22.8 executable is
  below Astro's required Node 22.12 version and exits before building.
- In-app live-page recheck was unavailable because the browser's localhost URL policy
  retained a failed pre-server navigation. Component-level interaction tests remain
  authoritative for this checkpoint; the prior live visual audit above is retained as
  historical evidence rather than silently restated as a new run.

The repository-wide suite, privacy scan, macOS harness, and packaged-app smoke have
passed and remain retained full-branch gates. The genuinely remaining checks are the
fresh-task live mixed-roster matrix, a clean-VM distribution check, and the separately
credentialed WS-05 signing/notarization work.

# 000 — Multi-agent workstation and self-contained macOS app

Status: IMPLEMENTED — LIVE MIXED-PROVIDER V2 ACCEPTANCE GREEN; SIGNED DISTRIBUTION OPEN

Created: 2026-08-08
Updated: 2026-08-08
Branch: `codex/multi-agent-workstation`
Base: fork `main` at `6f88fc3f101d32947ebf11a25c33640ff50a313e`

## Objective

Make OpenCodex a dependable multi-model workstation without adding a second
orchestration engine:

1. explain the five-model roster and Run Policy truthfully;
2. keep automatic guidance compatible with the resolved parent route;
3. support explicit, fail-closed plaintext V2 delivery for mixed providers;
4. keep routed catalogs durable and make stale Codex workers easy to refresh;
5. ship a macOS app containing the Bun runtime, OpenCodex source, production
   dependencies, and dashboard.

The unit deliberately excludes role graphs, team profiles, prompt templates,
file inboxes, guessed decryption, proxy re-encryption, blanket
`agent_message` rewriting, silent worker restarts, and silent plaintext
activation.

## Delivered workstreams

| ID | Result |
| --- | --- |
| WS-01 Agent Command Center | The Subagents page now exposes Active Roster, Agent Library, and Run Policy with truthful copy and six synchronized GUI locales. |
| WS-02 Compatibility-aware guidance | Encrypted native V2 guidance excludes unreadable external routes while exact overrides retain the existing fail-closed behavior. |
| WS-03 Plaintext V2 compatibility | Explicit `multiAgentV2MessageDelivery: "plaintext"` enables the recognized mixed-provider V2 contract; encrypted delivery remains the default. |
| WS-04 Self-contained macOS app | The application bundles its runtime and dashboard, auto-syncs the catalog, and offers a confirmed **Apply agent catalog** action for stale Codex workers. |
| WS-05 Signed distribution | Developer ID signing, notarization, stapling, quarantine testing, and the public updater remain a separately credentialed release phase. |

## Verification retained for the functional branch

- All 604 one-file runtime shards were exercised on the same functional
  revision and worktree. A contention-only serialization shard was rerun with
  the repository fixture and the continuation completed green; no assertion,
  production timeout, or safety guard was weakened.
- The full GUI suite passed 715 tests, localization lint, ESLint, React Doctor,
  and the production build.
- The documentation site built all 226 pages. Typecheck, privacy scan, and
  `git diff --check` passed.
- The native macOS suites passed 95 core and 31 UI tests. The bundled app
  started the proxy without a global `bun`, `npm`, or `ocx`, and the dashboard
  returned HTTP 200.
- A fresh Sol V2 parent dispatched the exact models
  `opencode-go/deepseek-v4-flash`, `kimi/k3[1m]`,
  `opencode-go/glm-5.2`, and `xai/grok-4.5`. All four completed with their
  required markers, and a Kimi follow-up completed without substitution,
  timeout, or catalog exclusion.

## Remaining release work

- Run the signed/notarized build and clean-machine quarantine matrix when the
  required Apple credentials are available.
- Add a signed app update and rollback channel before calling the macOS bundle
  a public auto-updating release.
- Keep plaintext V2 explicit and experimental until additional client-schema
  versions are feature-detected in production.

Repository policy targets feature review at `dev` followed by maintainer
promotion to `main`. A fork owner may still use a direct fork-main comparison
for private integration review.

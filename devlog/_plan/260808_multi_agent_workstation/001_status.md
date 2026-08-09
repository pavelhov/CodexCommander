# 001 — Delivery status

Last updated: 2026-08-08

## Branch

- Branch: `codex/multi-agent-workstation`
- Base: fork `main` at `6f88fc3f101d32947ebf11a25c33640ff50a313e`
- State: functional implementation and live mixed-provider acceptance complete;
  signed public distribution remains a separate credentialed phase.

## Workstreams

| Workstream | State | Notes |
| --- | --- | --- |
| Truthful Agent Command Center | COMPLETE | Active Roster, Agent Library, Run Policy, catalog truth, keyboard reordering, six GUI locales, and public docs are aligned. |
| Compatibility-aware guidance | COMPLETE | Automatic encrypted-V2 guidance filters incompatible external recipients; exact ids and native-only fail-closed fallback remain available. |
| Product-owned plaintext V2 | COMPLETE, EXPERIMENTAL | Explicit plaintext delivery passed spawn, wait, completion, and follow-up across Kimi, GLM, Grok, and DeepSeek. Encrypted remains the default. |
| Durable catalog and catalog apply | COMPLETE | Routed rows survive cold discovery failures; stale workers are surfaced without making OpenCodex look unhealthy; apply is confirmed and exact-process only. |
| Bundled macOS runtime | COMPLETE FOR TEST DISTRIBUTION | Bun, source, production dependencies, and `gui/dist` are bundled; app-owned update behavior does not invoke npm. |
| Signed distribution | OPEN | Developer ID, hardened-runtime review, notarization, stapling, quarantine testing, and signed updater/rollback remain. |

## Current evidence

- Runtime: all 604 one-file shards passed on the current cleanup worktree. The
  repository's deterministic Codex fixture was used for cold-runtime probes.
- GUI: 715 tests, localization lint, ESLint, React Doctor, and production build
  passed.
- Docs: 226 pages built.
- Native macOS: 95 core and 31 UI tests passed; packaged runtime smoke passed
  without global Bun/npm/OpenCodex.
- Repository: typecheck, privacy scan, and diff check passed.
- Live V2 acceptance:
  - `opencode-go/deepseek-v4-flash` → `DEEPSEEK_V2_OK`
  - `kimi/k3[1m]` → `KIMI_V2_OK`
  - `opencode-go/glm-5.2` → `GLM_V2_OK`
  - `xai/grok-4.5` → `GROK_V2_OK`
  - Kimi follow-up → `KIMI_FOLLOWUP_OK`
- The saved and advertised five-model rosters matched exactly, exclusions were
  empty, the catalog was fresh, proxy health was green, and the dashboard
  returned HTTP 200.

## Safety and product boundaries

- Plaintext mode is explicit, reversible, parent-wide, and applies only to a
  fully recognized V2 collaboration schema. Unknown or malformed schemas stay
  on the encrypted fail-closed path.
- OpenCodex does not decrypt, guess, replace, re-encrypt, or log delegated task
  bodies. Usage-debug body sampling is suppressed for plaintext-V2 turns.
- The app never silently restarts active Codex workers. Release one offers
  **Apply Now** or **Later**; activity-aware deferred apply remains future work.
- The self-contained app is not yet a signed/notarized public App Store build.

## Review result

The branch now tells one coherent product story: configure the advertised
worker roster, choose the collaboration policy, run mixed-provider V2 when
explicitly enabled, retain the catalog across cold starts, and operate the
stack from one self-contained macOS app. Remaining work is distribution, not
core multi-agent functionality.

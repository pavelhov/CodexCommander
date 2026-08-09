# 010 — Truthful Agent Command Center

Status: COMPLETE
Updated: 2026-08-08

## Decisions

- The existing roster/library layout remains unchanged. The roster is described as
  the five models advertised to `spawn_agent`, not as an execution router.
- The policy card now calls the selector **Agent protocol**. The default option is
  **Follow Codex defaults**; Classic v1 and Concurrent v2 remain unchanged.
- Preferred-model copy says **Preferred guidance model**. An empty value is
  **No preferred model — Codex chooses from roster**; the setting remains advisory
  unless native Codex-default sync is enabled.
- The global fallback copy names its actual scope: spawned child turns after the
  requested model and role fallback. It does not imply that the preferred guidance
  model is automatically the fallback primary.
- Thread-limit copy distinguishes V2 total threads (root included) from V1 child
  threads and explains that an empty value restores the Codex default.
- The existing guidance switch is surfaced in the primary policy grid as
  **Use roster as worker guidance**. It controls OpenCodex-authored guidance; it
  does not force delegation or route every child.
- The encrypted issue-92 warning appears while V2 is selected. The plaintext
  privacy warning appears whenever forced V2 or Follow Codex defaults may use
  the explicit plaintext policy. It explains that every V2 worker message from
  that parent, including messages to native workers, becomes plaintext and that
  the operator must start a new session. Exact overrides still fail closed when
  unreadable, and Classic v1 remains the established cross-provider path.
- All visible strings are localized in `en`, `de`, `ja`, `ko`, `ru`, and `zh`.

## Verification

- `cd gui && bun run lint:i18n` — passed.
- `bun run typecheck` — passed.
- `cd gui && bun run lint && bun run build` — passed; Vite emitted only the
  existing Node-version and chunk-size warnings.
- `bun scripts/doctor-gui-if-changed.ts` — passed; React Doctor reported no
  issues.
- Focused GUI tests — passed (31 tests across Subagents, Run Policy, Models,
  and guidance surfaces; the final semantic subset is 18 tests).
- Runtime mode/thread migration coverage remains in
  `tests/codex-v2-gate.test.ts`; no runtime response/collaboration files were
  changed by WS-01.

## Integration result

The full GUI suite, localization lint, GUI lint, production build, Bun-hosted
docs build, and privacy scan passed on the combined branch. Repository-wide and
pre-push results are recorded in the branch status ledger rather than repeated
inside this completed workstream.

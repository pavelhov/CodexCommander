# 010 — Truthful Agent Command Center

Status: IN PROGRESS
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
- A warning appears only while V2 is selected, explaining the existing issue #92
  encryption boundary and the v1/native fallback recovery options. No upstream
  response transport or fail-closed guard was changed in this workstream.
- All visible strings are localized in `en`, `de`, `ja`, `ko`, `ru`, and `zh`.

## Verification

- `cd gui && bun run lint:i18n` — passed.
- `bun run typecheck` — passed.
- `cd gui && bun run lint && bun run build` — passed; Vite emitted only the
  existing Node-version and chunk-size warnings.
- Focused GUI tests — passed (31 tests across Subagents, Run Policy, Models,
  and guidance surfaces; the final semantic subset is 18 tests).
- Runtime mode/thread migration coverage remains in
  `tests/codex-v2-gate.test.ts`; no runtime response/collaboration files were
  changed by WS-01.

## Remaining branch gates

Run the full GUI suite and the repository test/privacy/docs gates after the
other workstation workstreams settle. Do not commit from this workstream.

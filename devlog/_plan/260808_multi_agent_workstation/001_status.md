# 001 — Delivery status

Last updated: 2026-08-08

## Branch

- Active branch: `codex/multi-agent-workstation`
- Base commit: `6f88fc3f101d32947ebf11a25c33640ff50a313e`
- Existing relevant uncommitted Agent Command Center work was preserved when
  the branch was created; it will be reviewed and absorbed rather than reset.
- No upstream commits have been merged or cherry-picked.

## Workstreams

| Workstream | State | Owner | Notes |
|---|---|---|---|
| WS-01 Truthful Agent Command Center | IN PROGRESS | UI worker | Preserve current visual language; all six GUI locales and affected public docs |
| WS-02 Compatibility-aware guidance | PLANNED | runtime worker | Automatic guidance only; never restrict exact-id callability |
| WS-03 Upstream plaintext contract | PLANNED | protocol worker | Proposal only unless separately approved for upstream submission |
| WS-04 Bundled macOS runtime | PLANNED | macOS worker | Bun-plus-source first release; compiled helper deferred |
| WS-05 Signed distribution | BLOCKED BY CREDENTIALLED RELEASE PHASE | maintainer | Design and tests may land; signing/notarization execution requires explicit credentials and approval |

## Design reference

- ImageGen reference: [`assets/run-policy-reference.png`](assets/run-policy-reference.png)
- Purpose: hierarchy and copy reference only; production UI stays in the
  existing React/CSS component system.
- Required invariants: preserve the existing dark dashboard, roster/library
  layout, density, controls, and visual tokens; no new UI framework or
  generated bitmap ships in the application.

## Evidence already collected

- Runtime issue/fallback tests: 179 passed.
- Agent Command Center focused GUI tests: 14 passed.
- Native macOS harnesses: 113 passed.
- Live native-V2 to Kimi delegation reproduced
  `unreadable_encrypted_agent_task` before the provider received a usable task.
- MoA council completed with Kimi K3, Grok 4.5, and Fable; Codex was excluded
  to preserve parent ChatGPT allowance.
- Current task cannot run the requested V1 external-model matrix because its
  root protocol and catalog snapshot predate the setting change. The matrix is
  queued for a fresh task after implementation and sync.

## Decision log

### 2026-08-08 — One delivery branch, scoped commits

Use one branch so GUI, runtime compatibility, upstream contract, and macOS
packaging can be tested together, while retaining small commits that can be
reviewed or reverted independently.

### 2026-08-08 — ImageGen is a reference, not a redesign

Create one preview-only Run Policy mockup that preserves the current dark
dashboard, density, components, spacing rhythm, and roster layout. Production
UI remains code-native and uses the existing component system.

### 2026-08-08 — V1 switch requires a fresh task

The current Codex task keeps the protocol selected by its root and reports a
stale catalog. Do not set model overrides from this task. Reuse already-open
native research workers and MoA now; run the full roster from a newly started
V1 task after sync.

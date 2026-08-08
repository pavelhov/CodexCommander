# 001 — Delivery status

Last updated: 2026-08-08

## Branch

- Active branch: `codex/multi-agent-workstation`
- Base commit: `6f88fc3f101d32947ebf11a25c33640ff50a313e`
- Agent Command Center, compatibility guidance, protocol proposal, and bundled
  macOS runtime checkpoints are committed independently on this branch.
- No upstream commits have been merged or cherry-picked.

## Workstreams

| Workstream | State | Owner | Notes |
|---|---|---|---|
| WS-01 Truthful Agent Command Center | COMPLETE | UI worker | Existing layout retained; all six GUI locales and affected public docs updated |
| WS-02 Compatibility-aware guidance | COMPLETE | runtime worker | Automatic guidance only; exact-id callability and fail-closed dispatch preserved |
| WS-03 Upstream plaintext contract | COMPLETE | protocol worker | Contribution-ready proposal; no unsafe proxy decryption workaround |
| WS-04 Bundled macOS runtime | COMPLETE FOR TEST DISTRIBUTION | macOS worker | Bun-plus-source universal ZIP; self-contained lifecycle smoke passed |
| WS-05 Signed distribution | BLOCKED BY CREDENTIALLED RELEASE PHASE | maintainer | Design and tests may land; signing/notarization execution requires explicit credentials and approval |

## Design reference

- ImageGen reference: [`assets/run-policy-reference.png`](assets/run-policy-reference.png)
- Purpose: hierarchy and copy reference only; production UI stays in the
  existing React/CSS component system.
- Required invariants: preserve the existing dark dashboard, roster/library
  layout, density, controls, and visual tokens; no new UI framework or
  generated bitmap ships in the application.

## Evidence already collected

- Compatibility guidance: 45 focused tests passed; encrypted fallback: 27 passed.
- Exact roster protocol matrix: 91 tests passed across Sol, Luna, Kimi, Grok,
  and DeepSeek under v1/default/v2.
- Agent Command Center focused GUI tests: 33 passed; full GUI suite, i18n lint,
  lint, and production build passed.
- Post-review full GUI suite: 712 tests across 124 files passed. React Doctor
  reported no issues after the small Set/ref/semantic-list cleanup.
- Native macOS harnesses: 87 core + 28 UI passed.
- Universal archive ran version/keyring smokes under arm64 and x86_64/Rosetta;
  an isolated bundled lifecycle start/health/status/stop smoke passed.
- Docs built 226 pages with Bun; privacy scan passed after removing a local-only
  ImageGen path from the public design record.
- The deterministic repository suite passed all 601 one-file shards. The final
  `prepush` gate passed typecheck, changed-GUI lint, all 601 shards, privacy
  scan, and React Doctor.
- Two pre-existing test expectations were aligned with current production
  behavior and the deterministic runner: stale Kimi local-CLI credentials now
  assert the established `needsReauth` marker, and the runner's default-size
  assertion explicitly isolates itself from a caller override.
- Live native-V2 to Kimi delegation reproduced
  `unreadable_encrypted_agent_task` before the provider received a usable task.
- Final MoA review completed with Kimi K3 and Grok 4.5; both returned a
  conditional pass with no redesign request. Codex was excluded to preserve
  parent ChatGPT allowance. Fable failed because organization subscription
  access is disabled, and was not silently replaced with Codex.
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

### 2026-08-08 — Plaintext V2 experiment remains isolated

Task `019fdf94-add7-7552-99f7-485787e0d2a1` is probing whether removing the
encrypted collaboration schema marker yields a genuine plaintext V2 handoff.
Its first run reached a real Kimi dispatch, but the exact schema and successful
provider return are not yet proven. It must remain in a separate worktree and
branch; integration requires a feature signal and retains this branch's
fail-closed behavior for older clients.

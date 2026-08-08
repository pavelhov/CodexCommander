# 001 — Delivery status

Last updated: 2026-08-08

## Branch

- Active branch: `codex/multi-agent-workstation`
- Base commit: `6f88fc3f101d32947ebf11a25c33640ff50a313e`
- Agent Command Center, compatibility guidance, protocol proposal, and bundled
  macOS runtime checkpoints are committed independently on this branch.
- The verified local plaintext feature and independent race fix were surgically
  cherry-picked as `bef7c19a` and `796a7b02`, followed by integration hardening
  `f0962e42`. The focused upstream Darwin rewrite fix `b6d32507` was later
  cherry-picked as `1b92dd23`; the product-specific terminal relay hardening is
  committed as `783dfd2f`.

## Workstreams

| Workstream | State | Owner | Notes |
|---|---|---|---|
| WS-01 Truthful Agent Command Center | COMPLETE | UI worker | Existing layout retained; all six GUI locales and affected public docs updated |
| WS-02 Compatibility-aware guidance | COMPLETE | runtime worker | Automatic guidance only; exact-id callability and fail-closed dispatch preserved |
| WS-03 Product-owned plaintext V2 | INTEGRATED; MACOS STALL FIX VERIFIED; FULL TARGET RUNTIME GATE GREEN | protocol worker | Live Sol→Kimi proof, focused transport gates, and all 603 one-file runtime shards passed; the authorized deterministic Codex fixture was used after three cold-runtime setup timeouts |
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
- Product-owned plaintext V2 live proof completed with a stock Codex 0.147 Sol
  parent and Kimi K3 child; spawn, wait, child completion, and parent receipt
  succeeded without decrypting or rewriting task text.
- The later macOS stall was isolated below the model/protocol layer: the proxy
  received and persisted `response.completed` immediately, while Codex did not
  execute the returned collaboration call until exactly 300.001 seconds later.
  Bun 1.3.14 reproduces the upstream async-`pull()` cancellation defect from
  Bun #32111. The upstream eager Darwin rewrite commit was integrated, then the
  remaining post-relay async-`pull()` budget wrapper was removed for the exact
  validated plaintext-V2 shape. Owned budgets now settle exactly once from the
  producer; caller-owned budgets remain untouched; `legacy-tee` remains the
  immediate rollback switch.
- A second MoA review with Kimi K3 and Grok 4.5 independently approved the
  narrow single-reader design subject to exact Bun-version gating, fail-closed
  schema handling, deterministic lifecycle tests, and payload-free counters.
- Isolated-source verification completed: 107 focused runtime tests, all 602
  repository test files, 713 GUI tests, 226 built docs pages, typecheck, GUI
  lint/i18n/build, privacy scan, and diff check passed. Target-branch gates are
  rerun after integration rather than inferred from those results.
- Target integration verification passed 128 focused runtime tests, 714 GUI
  tests across 124 files, locale lint, ESLint, GUI production build, 226-page
  docs build, typecheck, privacy scan, React Doctor, and diff check.
- The exact one-file-sharded target runtime command stopped at shard 154 on
  fixed-timeout cold Codex probes. Continued coverage exercised all 602 files;
  only `codex-native-residue`, `codex-retained-root-serialization`,
  `native-claude-desktop-toggle`, and `native-grok-toggle` remained red. Their
  subprocesses took roughly 8-27 seconds against fixed 5-10 second deadlines;
  targeted retries reproduced the delays. No assertion or timeout was changed,
  so the full target runtime gate is explicitly not green.
- The idle-host rerun after the Darwin relay fix again passed shards 1-153 and
  stopped at `codex-native-residue`: 53 tests passed and seven subprocess cases
  exceeded their fixed 5-second timeout (9.17-25.36 seconds with the real Codex
  runtime). The authorized existing deterministic fixture produced the same
  53-pass/seven-timeout result (5.01-15.60 seconds), and one final isolated
  retry reproduced it. This is not an assertion failure and is outside the
  relay diff; no timeout, assertion, fixture, or production guard was changed.
- Cold-start catalog convergence is now durable: successful routed discovery
  writes an owner-only last-known-good snapshot, a later offline/partial start
  rehydrates eligible routed rows without resurrecting removed or disabled
  providers, and lifecycle success distinguishes live process health from
  catalog convergence. External Codex providers take an explicit preserve-only
  path and an unclassified native-only result fails closed.
- The final target runtime gate covered all 603 one-file shards on one revision
  and worktree. Shards 1-166 passed against the real Codex runtime. Shard 167
  then hit three setup-marker timeouts before provider dispatch; its focused
  rerun passed 6/6 with the existing ignored deterministic Codex fixture, and
  the fixture-backed continuation passed shards 167-603. No assertion,
  production timeout, or safety guard was weakened.
- Test infrastructure now supports an explicit bounded start shard, prints
  cross-platform resume instructions, removes irrelevant external Codex probes
  from native-residue unit cases, and identity-checks any test-owned proxy
  before launcher cleanup. The three real launcher signal cases passed and no
  child proxy was left behind.
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

### 2026-08-08 — Own plaintext V2 compatibility in OpenCodex

Task `019fdf94-add7-7552-99f7-485787e0d2a1` proved the complete product-owned
contract on the isolated `codex/v2-plaintext-shim` branch. The default remains
encrypted; plaintext mode uses a bidirectional non-reserved namespace shim and
activates only for the exact known schema. All unreadable-ciphertext guards
remain authoritative for disabled, old, malformed, or changed contracts. The
verified feature is now integrated on this branch; see
`031_product_owned_plaintext_v2.md`.

### 2026-08-08 — Use a narrow Darwin relay exception, not a product-wide default

The bundled Bun still lacks a released generic async-`pull()` cancellation fix.
Keep generic Darwin traffic on the established tee path, but automatically use
the tested synchronous-`pull()` eager relay for an explicitly enabled, fully
recognized plaintext-V2 collaboration rewrite on the exact validated Bun
version. Other rewrites remain explicit-only, and `streamMode: "legacy-tee"`
remains the kill switch. Do not make plaintext V2 the product default until the
post-integration Sol/Luna × Kimi/Grok/DeepSeek matrix is green.

### 2026-08-08 — Retain routed catalog state without weakening native restore

Stopping OpenCodex still restores a native-only Codex catalog. OpenCodex now
keeps a separate owner-only routed snapshot and uses it as a last-known-good
source when the next cold start has empty or partial provider discovery. Process
liveness remains `/healthz`; lifecycle completion requires a converged catalog
or an explicit policy/external-provider skip. ChatGPT app-server restart remains
user-controlled when an already-running picker is stale.

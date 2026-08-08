# 000 — Multi-agent workstation and self-contained macOS app

Status: IMPLEMENTED — FRESH-SESSION LIVE MATRIX PENDING
Created: 2026-08-08
Branch: `codex/multi-agent-workstation`
Base: `main` at `6f88fc3f101d32947ebf11a25c33640ff50a313e`
Integration target: `dev` for review, then maintainer promotion to `main`

## Objective

Turn the existing OpenCodex provider proxy into a dependable multi-model
workstation without inventing a second orchestration engine:

1. make the Agent Command Center explain the behavior it already owns;
2. keep the five-model roster as advertised worker guidance, while every
   catalog model remains callable by exact id;
3. prevent automatic V2 guidance from recommending child routes whose native
   encrypted task payload cannot cross the provider boundary;
4. retain the current fail-closed guard for explicit incompatible overrides;
5. prepare the upstream plaintext-boundary contract required for true
   heterogeneous V2 trees; and
6. ship a macOS app that contains the runtime and dashboard instead of
   requiring a separate npm/Bun/OpenCodex installation.

This unit does **not** add role graphs, team profiles, game-development
workflows, prompt templates, file inboxes, guessed decryption, proxy
re-encryption, or a blanket `agent_message` rewrite.

## Verified starting state

- The active roster is capped at five because Codex advertises the first five
  featured picker-visible rows to `spawn_agent`; catalog models outside the
  roster remain callable by exact id.
- V2 guidance already includes the effective roster when
  `multiAgentGuidanceEnabled` is on. The UI hides that fact under an advanced
  toggle and overstates the preferred/fallback relationship.
- `multiAgentMode = default` restores upstream model pins and the current
  Codex feature setting. It does not select a worker.
- V2 is selected by the root task and inherited by its tree. Changing the
  setting does not retrofit an already-running task.
- Issue #92 is reproducible: a native Sol parent can select a routed child,
  but the child assignment arrives only as backend ciphertext. OpenCodex
  correctly refuses to dispatch an empty task or leak the ciphertext.
- The Swift menu-bar bundle is a companion only. It finds an external `ocx`
  and Bun runtime; it does not contain the proxy, CLI, dependencies, or
  `gui/dist`.
- A temporary `bun build --compile` probe bundled 769 modules, but
  `--version` failed because runtime metadata resolved `/package.json` from
  the compiled `$bunfs` layout. Dynamic workers, subprocesses, GUI assets,
  services, and npm updater assumptions make a compiled helper a later
  refactor rather than the first reliable app release.

## Workstream map

| ID | Workstream | Primary scope | Terminal gate |
|---|---|---|---|
| WS-01 | Truthful Agent Command Center | `gui/`, docs locales | COMPLETE — GUI tests, lint, i18n lint, build, and retained visual QA |
| WS-02 | Compatibility-aware roster guidance | `src/server/responses/`, catalog helpers, runtime tests | COMPLETE — native V2 guidance excludes unreadable routed children; exact overrides still fail closed |
| WS-03 | Upstream plaintext-boundary proposal | this devlog unit; upstream source references | COMPLETE — provider-aware spawn/send/follow-up/return contract with no unsafe workaround |
| WS-04 | Self-contained macOS runtime | `app/`, `scripts/`, runtime resource resolution, docs | COMPLETE FOR TEST DISTRIBUTION — bundled-runtime lifecycle smoke passed without global Bun/npm/ocx |
| WS-05 | Distribution hardening | packaging/release follow-up | Developer ID signing, notarization, stapling, DMG, updater, clean-VM gate |

WS-05 is a separately credentialed release phase. No publish, deployment,
version bump, signing credential use, notarization submission, or App Store
submission is authorized by this unit.

## Commit and review strategy

Work stays on one delivery branch but lands as scoped checkpoint commits:

1. `13eccd9b` — `docs(plan): track multi-agent workstation delivery`
2. `aebd7278` — `fix(agents): filter encrypted v2 worker guidance`
3. `0cfe71f4` — `docs(agents): propose provider-aware v2 delivery`
4. `f9ac7819` — `feat(gui): make agent command center truthful`
5. `108752a9` — `docs(plan): retain agent command center qa`
6. `1b8e2f6e` — `test(agents): cover mixed roster protocol modes`
7. `0ca85586` — `feat(macos): bundle self-contained universal runtime`
8. `0df6a52f` — `test: keep prepush expectations deterministic`
9. `33425358` — `fix(gui): clear command center review findings`

Commits may be split further when review boundaries demand it. A checkpoint is
created only after its focused tests pass. The branch is not merged directly
to `main`: repository policy requires review against `dev`, followed by the
maintainer-controlled `dev` to `main` promotion.

## Global acceptance gates

Completed branch gates:

1. `bun run typecheck`
2. `bun run test`
3. `bun run privacy:scan`
4. `cd gui && bun test tests && bun run lint:i18n && bun run lint && bun run build`
5. `cd docs-site && bun --bun run build`
6. `bun run test:macos`
7. `bun run build:macos`
8. packaged-app smoke from a sanitized environment with no usable global
   `bun`, `node`, `npm`, or `ocx`

The remaining review-readiness gate is a fresh Codex task after catalog sync
for the V1 live model matrix: Sol, Luna, Kimi, Grok, and DeepSeek.

The fresh-session matrix is intentionally last: the protocol and catalog are
sticky for an existing task, so running it inside the task that changed the
setting would produce false evidence.

## Branch completion

The repository-wide pre-push gate is green. Keep this unit open until a
fresh-task mixed-roster run is recorded. The separate plaintext-V2 experiment must use a
different worktree/branch and may be integrated only after its exact schema,
feature signal, provider result, regression tests, and commit are reported.
Then move this unit to `devlog/_fin/260808_multi_agent_workstation/` and record
the remaining upstream/distribution dependencies and review/promotion path.

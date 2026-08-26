# Full-Catalog Exact-ID Contract Restoration Plan

> **For agentic workers:** This plan supersedes the request-scoped schema-overlay /
> resolver plan previously tracked under this filename through `4f02ba2ae`. Do **not**
> create `src/codex/request-scoped-spawn.ts`, scan user text, overlay `spawn_agent`
> schemas, or add a model-search command/API/MCP tool.

**Goal:** Restore the historical exact-ID contract: featured five are suggestions; a parent that already knows a compatible exact catalog ID may pass it to stock native `spawn_agent`.

**Architecture:** Guidance, managed skill, and documentation only. Native spawn, catalog sync, roster APIs, Apply, auth, routing, graph, mailbox, wait, follow-up, cancellation, and completion remain unchanged.

**Tech Stack:** Existing Bun-native TypeScript, Bun test, Astro/Starlight docs.

**Spec:** `docs/superpowers/specs/2026-08-25-full-catalog-subagent-discovery-design.md`

## Global Constraints

- Do not add a resolver, request scanner, schema overlay, MCP tool, or second spawn path.
- Preserve `MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5`, catalog priority, `subagentModels`, Apply, auth, and routing.
- Fail closed on stale/unknown workers, unknown slugs, unsupported efforts, encrypted incompatibility, and native rejection.
- Never silently substitute another family.
- V2 overrides still require `fork_turns: "none"` or a positive partial count.
- Unnamed V1 remains Proactive-only at max/ultra.
- Do not push, deploy, restart, or mutate live user configuration.

## File Map

- Modify: `src/server/responses/collaboration.ts` — V2 built-in exact-ID wording.
- Modify: `src/skills/codexcommander-delegation/SKILL.md` — featured suggestions, known exact native spawn.
- Modify: `tests/multi-agent-compat.test.ts` and `tests/codex-delegation-templates.test.ts`.
- Modify: `structure/00_overview.md`, `structure/03_catalog-and-subagents.md`.
- Modify: public docs under `docs-site/src/content/docs/` and translations that would otherwise treat the five as an allowlist.
- Rewrite: this plan and the matching spec so overlay/resolver work is not executable.

## Tasks

### Task 1: Guidance and skill

Replace "use only models listed for this collaboration surface" and "Use only model IDs and effort levels advertised live" with the invariant above. Keep fork_turns, self-contained task, stale-catalog, encrypted-filter, and V1 Proactive behavior.

### Task 2: Docs and spec

Reconcile structure, sub-agent, model-ordering, agents configuration, and related public copy. Mark the previous overlay/resolver architecture superseded.

### Task 3: Verify

Run focused tests, typecheck, privacy scan, docs build, and `bun run test:parallel`.

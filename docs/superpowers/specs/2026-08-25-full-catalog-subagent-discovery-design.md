# Full-Catalog Exact-ID Subagent Contract

> **Status:** This document supersedes the request-scoped schema-overlay / resolver design
> previously tracked under the same filename through `4f02ba2ae`. Do not implement catalog
> search, request scanning, MCP lookup, a `ccx agent model search` command, or
> `spawn_agent` schema overlay.

## Summary

CodexCommander keeps the configured five-model subagent roster as featured suggestions shown
first to native `spawn_agent`. The worker-loaded catalog remains the runtime authority. A parent
that already knows an exact compatible catalog ID may pass that ID directly to stock native
`spawn_agent`. Native validation stays authoritative and fail-closed.

Vague family-name discovery (`use Grok`, `consult Kimi`) is **not** provided. There is no
on-demand resolver, request-text matcher, or tool-schema mutation.

## Invariant

The five displayed models are featured / model-visible suggestions, not an exhaustive runtime
allowlist. A known exact, fresh, routable, surface- and task-delivery-compatible catalog ID may
be passed directly to stock native `spawn_agent` with a supported effort and, on V2,
`fork_turns: "none"` (or a positive partial count). Native validation remains authoritative.
Vague discovery is best-effort and no lookup command or resolver is being added.

## Native membership (current Codex)

`find_spawn_agent_model_name()` accepts an exact slug that exists in the worker-loaded catalog
and is compatible with the parent surface:

- V1: catalog membership is sufficient.
- V2: reject only models pinned `Disabled`.
- Picker visibility and the five-row cap are used for tool descriptions and unknown-model
  error text, not as the success allowlist.
- Unsupported efforts, stale/unknown workers, encrypted-task incompatibility, and native
  rejection remain fail-closed.
- Encrypted reserved V2 schemas must not be mutated. Exact-ID acceptance is not delivery
  success for unreadable routed ciphertext.

## Product decisions

1. **No resolver.** Do not add CLI, API, MCP, or proxy-owned lookup.
2. **No schema overlay.** Do not rewrite native V1/V2 `spawn_agent`.
3. **No request scanning.** Do not extract model names from the current user turn.
4. **No family substitution.** Do not silently spawn another family when the requested exact
   ID is unavailable.
5. **Keep the five.** Featured roster, catalog priority, Apply, auth, routing, graph, mailbox,
   wait, follow-up, cancellation, and completion stay unchanged.
6. **Guidance and skill restore exact-ID permission.** Built-in V2 guidance and the managed
   delegation skill must not tell the parent that live advertisement is the allowlist.
7. **V1 stays lean.** Unnamed V1 keeps Proactive-only text at max/ultra. Exact-ID permission
   on V1 comes from native spawn plus the managed skill, not a new V1 roster payload.

## Implementation

- Update built-in V2 guidance in `src/server/responses/collaboration.ts`.
- Update `src/skills/codexcommander-delegation/SKILL.md` and its template tests.
- Reconcile structure and public docs so they do not treat the five as an allowlist.
- Leave spawn handlers, catalog sync, roster APIs, and native Codex machinery unchanged.

## Non-goals

- Request-scoped candidate injection.
- Closed-enum or description overlay on `spawn_agent.model`.
- Semantic catalog search from vague names.
- Replacing native spawn, graph, or mailbox.
- Mutating live user configuration, restarting workers, or deploying.

## Verification

- `bun test tests/multi-agent-compat.test.ts tests/codex-delegation-templates.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`
- `cd docs-site && bun run build`
- `bun run test:parallel`

# Full-Catalog Request-Scoped Subagent Discovery

## Summary

CodexCommander keeps the configured five-model subagent roster as the default quick menu. On a V2
parent turn whose current user request names a model or provider, CodexCommander additionally searches
the complete catalog loaded for that Codex worker, exposes the relevant compatible matches for that
request, and tells the parent agent to choose the best task-fit exact id and spawn it without asking the
user to clarify.

Examples:

- `use Grok` exposes the best live Grok-family spawn targets, with the first-party xAI route ahead of
  aggregator copies. The parent chooses the best one for the task and spawns it.
- `use Grok 4.6` strongly narrows the request-scoped choices to compatible Grok 4.6 routes and normally
  leads to `xai/grok-4.6`.
- `consult Kimi K3` exposes compatible K3 routes and lets the parent select the best exact route.
- A request with no model intent continues to see only the configured five quick picks.

This feature requires no command, roster edit, catalog reprioritization, Apply action, or persistent
model selection.

## Goals

- Let a natural-language user request select any spawnable model already present in the full active
  Codex catalog, including models outside the five-model roster.
- Preserve the five-model roster as the fast default for ordinary model-unspecified delegation.
- Let the parent agent make the final task-aware model choice from a bounded, ordered, factual candidate
  set rather than encoding subjective model quality in the proxy.
- Never ask the user to clarify a model-family request when at least one compatible match exists.
- Keep exact model ids, effort ladders, task-delivery compatibility, and worker freshness fail-closed.
- Avoid logging or persisting user request text or request-scoped model choices.

## Non-goals

- Expanding or removing Codex's five-row featured-roster limit.
- Mutating `subagentModels`, catalog priorities, provider selections, or native `[agents]` defaults per
  request.
- Adding a model-search command, MCP tool, or second spawn implementation.
- A generic natural-language router for the parent's own model.
- V1 behavior changes.
- Silently substituting another model family when the requested family is unavailable.
- Persisting aliases learned from user prompts.

## Product decisions

1. **No clarification.** A vague request such as `use Grok` is resolved automatically. The parent agent
   chooses the best exact id from the request-scoped candidates and spawns it.
2. **The agent decides task fit.** The proxy performs factual intent matching, compatibility filtering,
   and deterministic ordering. It does not claim that one model is universally better than another.
3. **The five quick picks remain.** They are still the complete default advertisement for turns without
   a named model intent.
4. **V2 only.** V1 keeps its current Proactive-at-top-effort behavior and receives no full-catalog
   overlay.
5. **No persistent mutation.** Request-scoped discovery never changes config, catalog bytes, activation
   state, or worker priority.
6. **No family substitution.** If a requested family has no spawnable match, the parent is told that the
   requested target is unavailable for this session. It may use a different family only when the user
   explicitly allowed fallback.
7. **Schema compatibility is required.** The request-scoped candidates must be visible both in developer
   guidance and in the current `spawn_agent.model` schema/description so closed-enum and descriptive
   Codex tool variants can emit the exact id.

## Current contracts

- The generated catalog can contain far more than five picker-visible rows. Native Codex validates an
  exact spawn target against the catalog loaded by the worker.
- `spawn_agent` advertises only the priority-sorted first five rows by default.
- `multiAgentGuidanceText()` already uses a request-scoped on-disk catalog snapshot and suppresses
  positive model claims while app-server worker state is stale or unknown.
- `parsed._rawBody` contains the expanded Responses input. `parsed._replayPrefixLen` identifies leading
  raw input restored from `previous_response_id` state.
- V2 plaintext delivery is required for external routed children. Encrypted native parents may name
  only targets proven able to consume native ChatGPT ciphertext.
- The proxy already routes exact `provider/model` ids and applies subagent effort caps after selection.

## Architecture

### 1. Current-turn intent extraction

Add a pure extractor that reads only the current raw request suffix:

```ts
export function extractCurrentTurnModelIntentText(
  parsed: CodexCommanderParsedRequest,
): string;
```

Rules:

- Read `parsed._rawBody.input` starting at `parsed._replayPrefixLen ?? 0`.
- A string input is one current user message.
- From array input, accept only `message` items with `role: "user"`.
- Flatten only textual `input_text` and `text` parts in wire order.
- Ignore developer, system, assistant, tool-result, `agent_message`, `additional_tools`, compaction,
  image, file, and `encrypted_content` items.
- Use the last direct user message in the suffix. Historical model mentions restored in the replay
  prefix must never retrigger discovery.
- Normalize to Unicode NFC and cap the retained text at 8,192 Unicode code points, keeping the newest
  suffix when truncation is required.
- Never log or persist the extracted text.

`agent_message` is deliberately excluded: it is child-to-parent collaboration input, not a new human
model request.

### 2. Full spawnable catalog projection

Add `src/codex/request-scoped-spawn.ts` as the owning module for extraction, matching, ranking, and
tool advertisement.

```ts
export interface RequestScopedSpawnCandidate {
  model: string;
  provider: string | null;
  displayName: string | null;
  efforts: string[];
  contextWindow: number | null;
  inputModalities: string[];
  featured: boolean;
  matchKind: "exact_slug" | "exact_name" | "provider_model" | "family" | "provider";
  matchScore: number;
}

export interface RequestScopedSpawnResolution {
  status: "none" | "matched" | "unavailable";
  candidates: RequestScopedSpawnCandidate[];
  reason?:
    | "no_spawn_override"
    | "no_catalog_match"
    | "stale_catalog"
    | "encrypted_incompatible"
    | "unroutable";
}

export interface RequestScopedSpawnFilters {
  surface: "v1" | "v2";
  featuredModels: ReadonlySet<string>;
  activeAccountNamespace?: string;
  canRoute(model: string): boolean;
  canConsumeTask(model: string): boolean | Promise<boolean>;
}

export async function resolveRequestScopedSpawnCandidates(
  parsed: CodexCommanderParsedRequest,
  catalogEntries: readonly RawEntry[],
  filters: RequestScopedSpawnFilters,
): Promise<RequestScopedSpawnResolution>;
```

The candidate universe uses the same catalog snapshot as the existing roster projection but does
not slice it to `MAX_SPAWN_AGENT_MODEL_OVERRIDES`.

A catalog row is eligible only when all applicable checks pass:

- `slug` is a nonblank canonical string.
- `visibility === "list"`.
- `isEligibleV2SubagentEntry(entry)` is true.
- The model and provider are enabled and `routeModel` can resolve the exact slug.
- Bare native account clones resolve only to the active account namespace unless the user wrote an
  exact account-qualified slug.
- Explicit routed provider matches such as xAI, Anthropic, or Kimi remain eligible even when they are
  outside the parent native account namespace.
- An encrypted parent keeps only targets for which `isEncryptedTaskCompatibleModel(model) === true`.
  Missing compatibility evidence fails closed.
- The worker catalog state is `fresh` or `not_running`. `stale` or `unknown` returns the existing
  restart guidance and names no request-scoped ids.

Featured-five membership is a ranking fact, never an admission requirement.

### 3. Intent matching

Matching is token-based and exact enough to keep `Grok` distinct from `Groq`. Do not use edit distance
or a general fuzzy-search library.

For every eligible row, build trusted searchable names from:

- Exact catalog slug.
- Model portion of the slug.
- `display_name`.
- Provider id.
- Registry provider label and `extraMetadataAliases` when the provider is registry-owned.

Normalize searchable text with Unicode NFKC, case folding, punctuation-to-space conversion, and
whitespace collapse. Preserve numeric/version tokens such as `4.6`, `k3`, and `5.6`.

The most recent recognized model/provider mention in the current user text wins when several are
present. The first nonempty match tier applies:

1. Exact case-sensitive catalog slug.
2. Exact case-insensitive catalog slug.
3. Exact model id or display name.
4. Provider plus model/family/version tokens.
5. Model family plus all explicit version/variant tokens.
6. Provider id, provider label, or provider alias alone.

Examples:

- `Grok 4.6` requires both `grok` and `4.6` and does not admit Grok 4.5.
- `Kimi K3` requires both family tokens and does not collapse to `kimi-for-coding` when K3 exists.
- `Claude Opus` prefers Opus rows and does not admit Sonnet or Haiku merely because the provider is
  Anthropic.
- `Grok` may admit multiple Grok-family models and routes so the parent can make the task-aware choice.

### 4. Deterministic candidate ordering

The proxy orders facts; the parent makes the final model decision. Sort by:

1. Higher match tier and token coverage.
2. Exact provider-label/provider-id match over an aggregator model-name-only match. This places
   `xai/grok-*` ahead of OpenRouter copies for `Grok`, and direct Anthropic ahead of aggregator Claude
   copies for `Claude`.
3. Exact user-specified family/version/variant match.
4. Featured-roster membership as the operator's explicit preference.
5. Active account namespace for account-qualified native clones.
6. Registry-owned provider model order when it is available and the row is one of that provider's
   trusted configured models.
7. Lower finite catalog priority.
8. Original catalog order.
9. Lexicographic exact slug.

Do not generically parse a larger version number as universally better. Provider names such as
`grok-4.20-0309` and product tiers such as `opus`, `sonnet`, `flash`, or `pro` do not form one safe
cross-provider semantic-version order.

Return at most eight candidates. If more match, keep the top eight after the deterministic sort. The
cap bounds developer text and tool schema size; it does not change which catalog rows are spawnable
for a more specific future request.

### 5. Parent-agent choice contract

Built-in V2 guidance gains a request-scoped block when candidates exist:

```text
The current user request names a model/provider. Matching live spawn targets from the full catalog,
ordered by request match: "xai/grok-4.6" (low/medium/high/xhigh), ... . Choose the best target for
the task yourself and spawn it without asking the user to clarify. Pass its exact model id. When the
request names a version or variant, honor it. Do not substitute another family.
```

The user text itself is never echoed. Only bounded trusted catalog fields are injected.

The parent should use task context and the candidate facts to choose. If task fit does not distinguish
two otherwise equivalent rows, it chooses the first ordered candidate. This gives `use Grok` a
deterministic completion without encoding a universal quality table in the proxy.

The block is additive to the five quick picks. Request-scoped candidates may repeat a featured row;
dedupe by exact slug before rendering.

If no eligible candidate remains, inject a fixed unavailable statement with no model id. The parent
must not ask for clarification and must not silently substitute another family. It reports the
requested family as unavailable for the current session unless the user explicitly permitted a
fallback.

Custom `injectionPrompt` does not suppress this safety/selection block. The custom prompt still owns
its existing placeholders; request-scoped discovery is appended as separate fixed developer text and
adds no placeholder containing user input.

### 6. Request-scoped spawn tool advertisement

Developer guidance alone is insufficient for Codex builds whose `spawn_agent.model` property exposes
the five quick picks through a closed enum or a bounded description. Add:

```ts
export function advertiseRequestScopedSpawnCandidates(
  parsed: CodexCommanderParsedRequest,
  candidates: readonly RequestScopedSpawnCandidate[],
): { changedParsed: boolean; changedRaw: boolean };
```

The function updates only the active flat V2 `spawn_agent` tool for this request:

- Update `parsed.context.tools` for routed adapters.
- Update matching tools in `parsed._rawBody.tools` and current-suffix `additional_tools` items for
  native Responses passthrough.
- Locate `parameters.properties.model` only when it is an optional string-valued property.
- If the property has a string `enum`, append the request-scoped exact ids, preserving existing order
  and deduping.
- Append a bounded sentence listing the request-scoped exact ids to the model property's description.
- Do not create a model override on a tool schema that does not support one.
- Do not alter tool names, required fields, strictness, namespaces, companion tools, lifecycle tools,
  or the five persistent roster choices.
- Refuse malformed, contradictory, mixed V1/V2, or future unknown collaboration shapes.

The native client remains the final executor and validates the chosen exact id against the catalog
already loaded by that worker. No proxy-created tool or custom spawn path is introduced.

### 7. Guidance preparation interface

Avoid hiding schema mutation inside the existing text-only helper. Add a planning result while
preserving the current public test surface:

```ts
export interface MultiAgentGuidancePlan {
  text: string | null;
  requestScopedCandidates: RequestScopedSpawnCandidate[];
}

export async function prepareMultiAgentGuidance(
  parsed: CodexCommanderParsedRequest,
  options: MultiAgentGuidanceOptions,
  deps?: MultiAgentGuidanceDeps,
): Promise<MultiAgentGuidancePlan>;

export async function multiAgentGuidanceText(
  parsed: CodexCommanderParsedRequest,
  options: MultiAgentGuidanceOptions,
  deps?: MultiAgentGuidanceDeps,
): Promise<string | null>;
```

`multiAgentGuidanceText()` remains a compatibility wrapper returning `plan.text`. The production
`core.ts` path calls `prepareMultiAgentGuidance()`, advertises the returned candidates into the parsed
and raw tool schemas, then injects `plan.text` as it does today.

Extend the request-scoped catalog context so roster projection and named discovery share one parsed
catalog snapshot and do no new network I/O.

### 8. Effort selection

- Render only `catalogEntryEfforts(entry)` values for each request-scoped candidate.
- The parent may select an effort from the chosen row's ladder when the user or task warrants it.
- A configured `injectionEffort` may be suggested only when it exists on the chosen candidate's
  ladder; otherwise omit it.
- Existing `subagentEffortCap` remains the enforcement boundary and may lower the requested effort.
- `fork_turns` rules stay unchanged.

### 9. Managed delegation guidance

Update `src/skills/codexcommander-delegation/SKILL.md` so it states:

- The live contract consists of the five quick picks plus any request-scoped full-catalog candidates
  explicitly added for the current turn.
- The parent may choose among those current-turn candidates and must pass the exact id.
- It must never remember an id for later turns or use an id absent from the current live contract.

The installed skill and global `AGENTS.md` remain roster-free and model-id-free. The canonical bundle
continues reading the skill file at render time; no hardcoded ids are added to
`delegation-templates.ts`.

## Data flow

1. Expand `previous_response_id` state and parse the request as today.
2. Detect the V2 collaboration surface.
3. Extract the last direct current-suffix user text.
4. Read one request-scoped catalog snapshot.
5. Match the named provider/model against the complete snapshot.
6. Apply visibility, V2, routing, account, worker-freshness, and task-delivery filters.
7. Return the top bounded candidate facts.
8. Add those exact ids to the current `spawn_agent.model` schema/description.
9. Inject the fixed request-scoped developer guidance.
10. The parent chooses the best task-fit candidate and calls native `spawn_agent` with its exact id.
11. The native worker validates the id against its loaded catalog; CodexCommander routes the child
    request normally.

## Error handling

- **No named intent:** no overlay; ordinary five-model behavior is byte-identical.
- **No matching catalog row:** fixed unavailable guidance, no invented id, no substitution.
- **Stale or unknown worker catalog:** keep the existing restart message and suppress every positive
  request-scoped model claim.
- **Encrypted incompatibility:** suppress external candidates. If none remain, use the unavailable
  path.
- **Malformed tool schema:** do not mutate it. The plan reports `no_spawn_override` and does not claim
  the off-roster id is usable.
- **Catalog parse/read failure:** fail closed to ordinary guidance without throwing the parent request.
- **Candidate later rejected by the native worker:** surface the native failure. Do not mutate the
  roster or retry a different model family automatically.

## Privacy and security

- Never write user request text, normalized match text, candidate scores, or the full catalog to
  request logs, usage logs, debug files, console output, or config.
- Debug output may contain only fixed reason codes and counts, never user text or candidate ids derived
  from the user request.
- Do not inject raw catalog descriptions, provider notes, upstream prose, or user text. Only bounded
  canonical slugs, sanitized display names, effort ladders, context windows, modalities, and fixed
  proxy-authored copy are eligible.
- Bound current text at 8,192 code points, candidates at eight, every rendered display name at 96 code
  points, and the added schema description at 1,024 UTF-8 bytes.
- Matching never changes authentication, credentials, provider configuration, or network targets.
- `bun run privacy:scan` is a release gate.

## Files

### New

- `src/codex/request-scoped-spawn.ts` — current-turn extraction, trusted alias projection, matching,
  ranking, candidate rendering inputs, and parsed/raw spawn-schema advertisement.
- `tests/request-scoped-spawn.test.ts` — pure extraction, matching, ranking, filtering, bounds, and
  schema mutation.

### Modified

- `src/server/responses/collaboration.ts` — shared catalog snapshot, guidance-plan result, V2
  request-scoped candidate block, and compatibility wrapper.
- `src/server/responses/core.ts` — apply the guidance plan's tool advertisement before injecting its
  developer message.
- `src/skills/codexcommander-delegation/SKILL.md` — current-turn candidate contract without model ids.
- `tests/multi-agent-compat.test.ts` — request-level V2/V1, freshness, encryption, custom prompt, and
  five-roster regression coverage.
- `tests/codex-delegation-templates.test.ts` — canonical installed-skill wording and model-id-free
  invariant.
- `structure/03_catalog-and-subagents.md` — full-catalog request-scoped selection invariant.
- `docs-site/src/content/docs/guides/sub-agent-surface.md` — natural-language full-restaurant behavior.
- `docs-site/src/content/docs/guides/model-ordering.md` — five quick picks versus request-scoped exact
  candidates.
- `docs-site/src/content/docs/reference/configuration/agents.md` — clarify that no new setting is
  required.

### Unchanged

- `MAX_SPAWN_AGENT_MODEL_OVERRIDES` and catalog priority policy.
- `src/codex/subagent-roster.ts` and `/api/subagent-models`.
- Catalog activation, Apply, and worker interruption flows.
- V1 collaboration guidance.
- Provider authentication and routing configuration.

## Testing

### Extraction

- String input and direct current-suffix user messages are recognized.
- Model mentions in `_replayPrefixLen` history never retrigger.
- Developer/system/tool/assistant, `agent_message`, compaction, image, file, and ciphertext content is
  ignored.
- The last direct current user message wins and Unicode text remains matchable.
- Input bounds preserve the newest suffix without splitting surrogate pairs.

### Matching and ordering

- Exact `provider/model` id wins.
- `Grok 4.6` admits 4.6 and excludes 4.5.
- `use Grok` orders direct xAI matches ahead of aggregator copies and exposes the best bounded set.
- `Kimi K3`, `Claude Opus`, account-qualified natives, and provider aliases resolve correctly.
- `Grok` never matches `Groq`.
- Featured preference, active account, provider label, catalog order, and lexicographic fallbacks are
  deterministic.
- More than eight matches are bounded after sorting.

### Eligibility

- Hidden, disabled, unroutable, V1-pinned, wrong-account native clone, and encrypted-incompatible rows
  are excluded.
- Explicit routed provider matches remain eligible outside the active native account namespace when
  V2 task delivery is plaintext.
- Stale and unknown workers yield no positive ids.

### Tool advertisement

- Parsed and raw flat V2 schemas receive the same candidate ids.
- Closed string enums are unioned without replacing the five choices.
- Open string schemas receive bounded description augmentation.
- Top-level tools and current-suffix `additional_tools` are covered.
- V1 namespaces, mixed surfaces, missing model properties, malformed schemas, and replay-prefix tool
  definitions are unchanged.

### Integration

- Unnamed V2 requests remain byte-identical to five-only guidance.
- Named V2 requests include request-scoped candidate facts and no user text.
- The parent contract says choose without clarification and pass an exact id.
- V1 remains byte-identical.
- Custom injection prompts retain their current substitution while the fixed selection block remains.
- Encrypted native parents never receive external candidate ids.
- The ordinary fallback chain and subagent effort cap are unchanged.

### Verification gates

- `bun test tests/request-scoped-spawn.test.ts tests/multi-agent-compat.test.ts tests/codex-delegation-templates.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`
- `bun run test:parallel`, with serial `bun run test` only when the parallel runner itself misbehaves
- `cd docs-site && bun run build`

## Rollout

- Ship behind the existing `multiAgentGuidanceEnabled` switch; do not add a second user setting.
- The first implementation commit lands the pure extractor/matcher and tests without production
  wiring.
- The second commit wires the V2 guidance plan and tool schema overlay.
- The third commit updates the managed skill and documentation.
- Existing fresh workers already contain the full catalog, so the feature itself does not require
  Apply or a catalog rewrite. A stale worker still requires the existing restart path.
- If a supported Codex build rejects an exact off-roster id after the current request advertised it,
  treat that as a schema/worker-catalog compatibility defect and fail closed. Do not rotate the five
  roster as a fallback.

## Risks

- **False intent match:** mitigated by exact token matching, last-current-user-only extraction, and the
  parent retaining the decision whether delegation is appropriate.
- **Wrong task-fit model:** mitigated by exposing bounded candidate facts and making the parent choose
  from task context instead of hardcoding a universal proxy quality score.
- **Schema says yes, worker says no:** mitigated by worker freshness gating, exact catalog membership,
  raw/parsed schema parity, and native validation remaining authoritative.
- **Prompt or catalog injection:** mitigated by fixed copy and strict trusted-field bounds; raw user and
  upstream descriptions are never injected.
- **Token/schema growth:** mitigated by an eight-candidate cap and byte-bounded descriptions.
- **Encrypted child task unreadable:** mitigated by the existing fail-closed compatibility predicate.

## Acceptance criteria

- In a fresh plaintext V2 session with `xai/grok-4.6` present outside the configured five, `use Grok
  4.6 for this review` causes the parent to see and select the exact live Grok 4.6 id without a command,
  roster mutation, or clarification.
- `use Grok` gives the parent the best ordered live Grok candidates, and the parent selects one and
  spawns it without asking the user.
- The same catalog with an encrypted parent exposes no external Grok id and never sends unreadable
  ciphertext to it.
- A model mention present only in replayed history does not affect the current turn.
- A request with no named model produces the same five-only tool/guidance behavior as before.
- No request-scoped choice or user text reaches logs, config, catalog bytes, or managed artifacts.

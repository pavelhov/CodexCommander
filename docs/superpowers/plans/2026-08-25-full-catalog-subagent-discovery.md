# Full-Catalog Request-Scoped Subagent Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a V1 or V2 parent honor a natural-language request for any compatible model in the worker-loaded catalog, including models outside the five featured quick picks, and spawn the best task-fit exact id without asking the user to clarify.

**Architecture:** Add one pure request-scoped module that extracts only the current human turn, projects the unsliced live catalog, matches and deterministically orders at most eight compatible candidates, and augments only the active `spawn_agent.model` schema. Keep the existing five-row roster unchanged; `collaboration.ts` prepares additive surface-specific guidance, while `core.ts` applies the schema overlay before injecting the developer message. V2 supports both routed flat tools and native `collaboration` namespaces (including the plaintext raw alias) while retaining `fork_turns`, delivery policy, and existing stale behavior; V1 uses a separate `agents`/`multi_agent_v1` adapter, no `fork_turns`, and relaxes its max/ultra guidance gate only when the current turn names a model.

**Tech Stack:** Bun-native strict TypeScript, Bun test, OpenAI Responses request/tool schemas, Codex catalog metadata, Astro/Starlight documentation.

**Spec:** `docs/superpowers/specs/2026-08-25-full-catalog-subagent-discovery-design.md`

## Global Constraints

- Preserve `MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5`, catalog priority policy, `subagentModels`, `/api/subagent-models`, Apply/catalog activation behavior, and provider authentication/routing configuration.
- Ship behind the existing `multiAgentGuidanceEnabled` switch. Do not add a setting, command, MCP tool, second spawn implementation, catalog rewrite, or persistent alias store.
- Extract intent only from the last direct `role: "user"` message in `_rawBody.input` after `_replayPrefixLen`; exclude replay history, `agent_message`, compaction, developer/system/assistant/tool content, images, files, and ciphertext.
- Never log or persist user request text, normalized text, candidate scores, the matching catalog slice, or request-scoped selected ids. Debugging may emit only fixed reason codes and counts.
- Match by exact normalized tokens. Do not use edit distance or fuzzy search; `Grok` must never match `Groq`.
- Exact versions and variants are binding: `Grok 4.6` excludes 4.5, `Kimi K3` does not collapse to `kimi-for-coding`, and `Claude Opus` does not admit Sonnet or Haiku.
- The proxy performs factual matching, compatibility filtering, and deterministic ordering. The parent chooses the best task fit, uses the first ordered candidate when task fit does not distinguish candidates, and spawns without asking for clarification.
- Return at most eight candidates after ordering. Bound extracted text to the newest 8,192 Unicode code points, display names to 96 code points, and added schema descriptions to 1,024 UTF-8 bytes.
- V2 requires `isEligibleV2SubagentEntry`; encrypted V2 keeps only targets proven compatible with native task ciphertext. V1 follows existing V1 roster eligibility semantics and never applies the V2 encryption/plaintext filter.
- Catalog state `stale` or `unknown` names no request-scoped model ids. `fresh` and `not_running` may use the on-disk worker catalog.
- Mixed, contradictory, malformed, or future-unknown collaboration schemas fail closed without mutation or positive off-roster guidance.
- Unnamed V1 and V2 behavior must remain byte-identical. Named V1 may render request-scoped guidance at any parent effort, but must not change V1 effort-cap behavior.
- Preserve unrelated user work and untracked `.lavish/` and `output/`. Do not push, deploy, restart Codex/ChatGPT, change live configuration, publish, or release until the user separately authorizes that action.

## File Map

### New files

- `src/codex/request-scoped-spawn.ts` — current-turn extraction, trusted alias projection, exact token matching, compatibility filtering, deterministic ranking, bounded candidate facts, and parsed/raw `spawn_agent` schema advertisement.
- `tests/request-scoped-spawn.test.ts` — pure extraction, matching, filtering, ordering, bounds, and V1/V2 schema visitor coverage.

### Modified files

- `src/server/responses/collaboration.ts:190-428` — request-scoped catalog context, guidance-plan interface, compatibility wrapper, and separate V1/V2 selection renderers.
- `src/server/responses/core.ts:184,941-989` — prepare guidance once, advertise candidates on the current tools, then inject text.
- `src/server/responses.ts:3-4` — re-export `prepareMultiAgentGuidance`, `finalizeMultiAgentGuidanceText`, and public plan types used by tests.
- `src/skills/codexcommander-delegation/SKILL.md:9-31` — live contract is five quick picks plus current-turn full-catalog candidates; never remember ids.
- `tests/multi-agent-compat.test.ts:44-110,650-1030` — request-level V2/V1, stale, encryption, custom-prompt, and byte-identical no-op regressions.
- `tests/codex-delegation-templates.test.ts` — canonical installed skill wording and model-id-free invariant.
- `structure/03_catalog-and-subagents.md` — five featured rows versus request-scoped exact candidates.
- `docs-site/src/content/docs/guides/sub-agent-surface.md` — user-facing natural-language full-catalog behavior on V1 and V2.
- `docs-site/src/content/docs/guides/model-ordering.md` — persistent five-row ordering versus ephemeral candidate ordering.
- `docs-site/src/content/docs/reference/configuration/agents.md` — clarify that discovery uses the existing switch and needs no new setting.

### Read but do not modify

- `src/codex/catalog/sync.ts` — reuse `isEligibleV2SubagentEntry`; do not remove the five-row slice from `effectiveSubagentRoster`.
- `src/codex/catalog/effort.ts` — reuse `catalogEntryEfforts` exactly.
- `src/codex/catalog/account-models.ts` — reuse `trustedAccountBoundNativeCatalogSlug` for generated native account rows.
- `src/providers/registry.ts` — reuse trusted provider id, label, model order, and `extraMetadataAliases`.
- `src/responses/v2-plaintext-collaboration.ts` — reuse `V2_PLAINTEXT_COLLABORATION_NAMESPACE`; the earlier plaintext rewrite leaves parsed tools under `collaboration` while raw tools use the alias.
- `src/responses/parser.ts` and `src/types.ts` — preserve parsed request/tool shapes and `_replayPrefixLen` semantics.
- `src/codex/subagent-roster.ts`, catalog activation/Apply code, provider config, and authentication code.

## Execution Choreography For The New Session

The execution coordinator must reread the live collaboration contract at the start of the new session and resolve workers from that contract; it must not copy a remembered worker id into code, docs, or this plan.

| Work | Implementation worker | Review worker | Reason |
| --- | --- | --- | --- |
| Task 1 shared extractor/matcher | Current live Grok-family preferred worker at high or xhigh | Sol-class architecture reviewer | Highest algorithmic and false-positive risk |
| Task 2 V2 schema/guidance wiring | Fresh current live Grok-family preferred worker at xhigh | Sol-class spec reviewer, then a separate code-quality reviewer | Highest request-path and schema blast radius |
| Task 3 V1 adapter | Fresh current live Grok-family preferred worker at high or xhigh | Sol-class spec reviewer | Surface differences are subtle and must stay isolated |
| Task 4 skill/docs | Luna- or Terra-class worker at medium/high | Root coordinator | Narrow, well-scoped synchronization work |
| Task 5 verification and live canaries | Root coordinator; use Grok to diagnose only if a gate fails | Sol-class final reviewer | Keeps success claims evidence-based and prevents speculative rewrites |

For every worker override, follow the live `spawn_agent` contract, use `fork_turns: "none"` (or a positive bounded history count), and send a self-contained brief naming owned files and checks. Use a fresh implementation worker per task and perform the two-stage spec/compliance then code-quality review required by `superpowers:subagent-driven-development`. Workers share the checkout: they must not revert another worker's edits or touch files outside their assignment.

---

### Task 1: Pure Current-Turn Extraction, Matching, Filtering, And Ranking

**Files:**

- Create: `src/codex/request-scoped-spawn.ts`
- Create: `tests/request-scoped-spawn.test.ts`

**Interfaces:**

- Consumes: `CodexCommanderParsedRequest`, `RawEntry`, `catalogEntryEfforts`, `isEligibleV2SubagentEntry`, `trustedAccountBoundNativeCatalogSlug`, and trusted provider registry metadata.
- Produces:

```ts
export const REQUEST_SCOPED_SPAWN_TEXT_MAX_CODE_POINTS = 8192;
export const REQUEST_SCOPED_SPAWN_CANDIDATE_LIMIT = 8;
export const REQUEST_SCOPED_SPAWN_DISPLAY_NAME_MAX_CODE_POINTS = 96;
export const REQUEST_SCOPED_SPAWN_SCHEMA_DESCRIPTION_MAX_BYTES = 1024;

export type RequestScopedMatchKind =
  | "exact_slug"
  | "exact_name"
  | "provider_model"
  | "family"
  | "provider";

export interface RequestScopedSpawnCandidate {
  model: string;
  provider: string | null;
  displayName: string | null;
  efforts: string[];
  contextWindow: number | null;
  inputModalities: string[];
  featured: boolean;
  matchKind: RequestScopedMatchKind;
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
  catalogState: "fresh" | "stale" | "not_running" | "unknown";
  canRoute(model: string): boolean;
  canConsumeTask(model: string): boolean | Promise<boolean>;
}

export function extractCurrentTurnModelIntentText(
  parsed: CodexCommanderParsedRequest,
): string;

export async function resolveRequestScopedSpawnCandidates(
  parsed: CodexCommanderParsedRequest,
  catalogEntries: readonly RawEntry[],
  filters: RequestScopedSpawnFilters,
): Promise<RequestScopedSpawnResolution>;
```

- Private implementation units use these stable shapes so the ranking code is reviewable without exporting internals:

```ts
interface TrustedCatalogName {
  phrase: string;
  tokens: string[];
  source: "slug" | "model" | "display" | "provider_id" | "provider_label" | "provider_alias";
}

interface RankedRequestScopedCandidate {
  candidate: RequestScopedSpawnCandidate;
  matchTier: number;
  tokenCoverage: number;
  directProvider: boolean;
  exactVariant: boolean;
  activeAccount: boolean;
  registryModelIndex: number;
  catalogPriority: number;
  catalogIndex: number;
}
```

- Normalization contract: NFC only for retained current-turn text; NFKC + lowercase + punctuation-to-space + whitespace collapse for matching. Numeric/version tokens such as `4.6`, `k3`, and `5.6` remain whole. A recognized mention must include at least one nonnumeric trusted model/provider token.
- Ranking comparator, in order: match tier/token coverage; direct provider match over aggregator copy; exact version/variant; featured membership; active account namespace; registry model order; lower finite catalog priority; original catalog index; exact slug lexical order. Never compare models by generic semantic-version magnitude.

- [ ] **Step 1: Write extraction tests that fail because the new module is absent**

Create the test file with a raw-request helper and direct assertions:

```ts
import { describe, expect, test } from "bun:test";
import type { CodexCommanderParsedRequest } from "../src/types";
import {
  extractCurrentTurnModelIntentText,
  resolveRequestScopedSpawnCandidates,
} from "../src/codex/request-scoped-spawn";

function parsedInput(input: unknown, replayPrefixLen = 0): CodexCommanderParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    context: { messages: [], tools: [{ name: "spawn_agent", description: "", parameters: {} }] },
    stream: true,
    options: { reasoning: "medium" },
    _rawBody: { model: "gpt-5.6-sol", input },
    _replayPrefixLen: replayPrefixLen,
  };
}

test("extracts only the last direct current-suffix user message", () => {
  const parsed = parsedInput([
    { type: "message", role: "user", content: [{ type: "input_text", text: "use Claude" }] },
    { type: "agent_message", text: "use Kimi" },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "use Groq" }] },
    { type: "message", role: "user", content: [
      { type: "input_image", image_url: "data:image/png;base64,AA==" },
      { type: "input_text", text: "use Grok 4.6" },
    ] },
  ], 1);
  expect(extractCurrentTurnModelIntentText(parsed)).toBe("use Grok 4.6");
});

test("treats string input as the current user turn", () => {
  expect(extractCurrentTurnModelIntentText(parsedInput("consult Kimi K3")))
    .toBe("consult Kimi K3");
});
```

Add table cases proving assistant/system/tool results, `additional_tools`, `compaction`, `compaction_trigger`, `agent_message`, image/file-only content, and `encrypted_content` produce no text. Add a replay case where the only model mention is before `_replayPrefixLen` and a bounds case using `"x".repeat(8_200) + " Grok"` that retains the newest 8,192 code points without splitting a surrogate pair.

- [ ] **Step 2: Run the extraction tests and confirm RED**

Run: `bun test tests/request-scoped-spawn.test.ts`

Expected: FAIL with a missing `../src/codex/request-scoped-spawn` module.

- [ ] **Step 3: Implement the bounded extractor only**

Use `Array.from(value.normalize("NFC"))` to count code points and `slice(-REQUEST_SCOPED_SPAWN_TEXT_MAX_CODE_POINTS).join("")` to retain the newest suffix. For array input, start at `Math.min(parsed._replayPrefixLen ?? 0, input.length)`, keep only `type: "message"` and `role: "user"`, flatten only string `text` fields on `input_text` and `text` content parts in wire order, and return the last nonempty direct-user message.

- [ ] **Step 4: Run the extraction subset and confirm GREEN**

Run: `bun test tests/request-scoped-spawn.test.ts --test-name-pattern "extract|current-suffix|string input|8,192"`

Expected: all extractor cases pass.

- [ ] **Step 5: Add failing matching and filtering fixtures**

Use catalog rows shaped like the real catalog, not config models:

```ts
const row = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  display_name: slug,
  visibility: "list",
  priority: 5,
  supported_reasoning_levels: [
    { effort: "low", description: "low" },
    { effort: "high", description: "high" },
  ],
  input_modalities: ["text"],
  context_window: 128000,
  ...over,
});

const filters = (over: Partial<Parameters<typeof resolveRequestScopedSpawnCandidates>[2]> = {}) => ({
  surface: "v2" as const,
  featuredModels: new Set<string>(),
  catalogState: "fresh" as const,
  canRoute: () => true,
  canConsumeTask: () => true,
  ...over,
});
```

Add exact assertions for:

```ts
test("binds an explicit Grok version and excludes Groq", async () => {
  const parsed = parsedInput([{ type: "message", role: "user", content: [
    { type: "input_text", text: "Use Grok 4.6 for this review" },
  ] }]);
  const result = await resolveRequestScopedSpawnCandidates(parsed, [
    row("xai/grok-4.6"),
    row("xai/grok-4.5"),
    row("groq/llama-3.3-70b"),
  ], filters());
  expect(result.status).toBe("matched");
  expect(result.candidates.map(candidate => candidate.model)).toEqual(["xai/grok-4.6"]);
});

test("orders direct Grok routes before aggregator copies without proxy-picking one", async () => {
  const parsed = parsedInput([{ type: "message", role: "user", content: [
    { type: "input_text", text: "Use Grok" },
  ] }]);
  const result = await resolveRequestScopedSpawnCandidates(parsed, [
    row("openrouter/x-ai-grok-4.6", { priority: 0 }),
    row("xai/grok-4.6", { priority: 5 }),
    row("xai/grok-4.5", { priority: 4 }),
  ], filters());
  expect(result.candidates[0]?.model).toBe("xai/grok-4.6");
  expect(result.candidates).toHaveLength(3);
});
```

Add cases for exact case-sensitive and case-insensitive slugs, `Kimi K3`, `Claude Opus`, provider-only aliases, most-recent mention wins, featured/account/provider/priority/catalog-order/lexical tie-breaks, and more than eight matches capped after sorting. Assert the matcher never exposes raw user text, catalog descriptions, or upstream notes in a candidate.

Add eligibility cases for blank slugs, `visibility: "hide"`, `canRoute: false`, wrong-account generated native rows, an exact account-qualified request, V1-pinned Luna allowed on V1 and excluded on V2, V2-pinned/unpinned rows retained on V1, encrypted V2 `canConsumeTask: false`, V1 ignoring `canConsumeTask`, and `stale`/`unknown` returning no candidates.

- [ ] **Step 6: Run matching tests and confirm RED**

Run: `bun test tests/request-scoped-spawn.test.ts`

Expected: extractor cases pass and matching/ranking assertions fail because resolution is not implemented.

- [ ] **Step 7: Implement trusted names, matching tiers, eligibility, and deterministic sorting**

Implement the first nonempty match tier only. Build provider metadata only when the first slug segment resolves through `getProviderRegistryEntry`; account-selector rows are recognized with `trustedAccountBoundNativeCatalogSlug` and are not mislabeled as registry providers. A plain family mention may admit several rows; a mention with explicit version/variant tokens admits only rows containing every explicit token. Preserve original catalog index before sorting and call `.slice(0, REQUEST_SCOPED_SPAWN_CANDIDATE_LIMIT)` only after the full comparator.

When no current-turn recognized model/provider phrase exists, return `{ status: "none", candidates: [] }`. When a phrase exists but no eligible row remains, return `unavailable` with the most specific fixed reason available. `stale` and `unknown` always return `reason: "stale_catalog"` without positive ids.

- [ ] **Step 8: Run pure tests and typecheck**

Run:

```bash
bun test tests/request-scoped-spawn.test.ts
bun run typecheck
```

Expected: the new pure suite passes and TypeScript reports no errors.

- [ ] **Step 9: Commit the pure matcher slice**

```bash
git add src/codex/request-scoped-spawn.ts tests/request-scoped-spawn.test.ts
git commit -m "feat: match request-scoped full-catalog spawn targets"
```

### Task 2: V2 Tool Advertisement And Guidance-Plan Wiring

**Files:**

- Modify: `src/codex/request-scoped-spawn.ts`
- Modify: `tests/request-scoped-spawn.test.ts`
- Modify: `src/server/responses/collaboration.ts:190-420`
- Modify: `src/server/responses/core.ts:184,941-989`
- Modify: `src/server/responses.ts:3-4`
- Modify: `tests/multi-agent-compat.test.ts`

**Interfaces:**

- Consumes: Task 1 resolution types/functions, current `collabSurface`, one on-disk catalog snapshot, current five-row roster projection, `routeModel(config, model)`, and the existing encrypted-task compatibility predicate.
- Produces:

```ts
export interface RequestScopedSpawnAdvertisement {
  advertised: boolean;
  changedParsed: boolean;
  changedRaw: boolean;
}

export function advertiseRequestScopedSpawnCandidates(
  parsed: CodexCommanderParsedRequest,
  surface: "v1" | "v2",
  candidates: readonly RequestScopedSpawnCandidate[],
): RequestScopedSpawnAdvertisement;

export interface MultiAgentGuidancePlan {
  surface: "v1" | "v2";
  text: string | null;
  requestScopedResolution: RequestScopedSpawnResolution;
  requestScopedCandidates: RequestScopedSpawnCandidate[];
}

export function finalizeMultiAgentGuidanceText(
  plan: MultiAgentGuidancePlan,
  advertisement: RequestScopedSpawnAdvertisement,
): string | null;

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

- Extend `MultiAgentGuidanceDeps` with injectable request-scoped boundaries while preserving every existing field:

```ts
loadRequestCatalog?: () => readonly RawEntry[];
canRouteSpawnModel?: (model: string) => boolean;
```

- `plan.text` contains the existing surface guidance only and never contains request-scoped candidate ids. `finalizeMultiAgentGuidanceText` switches on `plan.requestScopedResolution.status` first: `none` returns `plan.text` byte-for-byte; `unavailable` with `stale_catalog` returns restart-only `plan.text`; other `unavailable` reasons append fixed unavailable copy with no id; only `matched` consults `advertisement.advertised`, appending positive exact-id copy on success or fixed `no_spawn_override` copy on failure.
- `multiAgentGuidanceText` remains a compatibility-only text projection for existing tests/callers; production `core.ts` must use prepare → advertise → finalize → inject. Its implementation is:

```ts
const plan = await prepareMultiAgentGuidance(parsed, options, deps);
return finalizeMultiAgentGuidanceText(plan, {
  advertised: plan.requestScopedResolution.status === "matched",
  changedParsed: false,
  changedRaw: false,
});
```

- [ ] **Step 1: Add failing flat V2 schema advertisement tests**

Test both parsed and raw representations with a closed model enum:

```ts
test("advertises candidates on parsed and raw flat V2 spawn_agent schemas", () => {
  const parameters = {
    type: "object",
    properties: {
      task_name: { type: "string" },
      message: { type: "string" },
      model: { type: "string", enum: ["gpt-5.6-sol"], description: "Featured model." },
    },
    required: ["task_name", "message"],
  };
  const parsed = parsedInput([]);
  parsed.context.tools = [{ name: "spawn_agent", description: "", parameters: structuredClone(parameters) }];
  parsed._rawBody = {
    input: [],
    tools: [{ type: "function", name: "spawn_agent", parameters: structuredClone(parameters) }],
  };
  const changed = advertiseRequestScopedSpawnCandidates(parsed, "v2", [{
    model: "xai/grok-4.6",
    provider: "xai",
    displayName: "Grok 4.6",
    efforts: ["low", "high"],
    contextWindow: 128000,
    inputModalities: ["text"],
    featured: false,
    matchKind: "exact_name",
    matchScore: 500,
  }]);
  expect(changed).toEqual({ advertised: true, changedParsed: true, changedRaw: true });
  expect(((parsed.context.tools![0]!.parameters.properties as Record<string, any>).model.enum))
    .toEqual(["gpt-5.6-sol", "xai/grok-4.6"]);
});
```

Add open-string description augmentation, enum dedupe, 1,024-byte UTF-8 truncation, candidate cap defense, and no mutation of required fields, strictness, tool names, companion tools, or persistent five choices. Add raw `additional_tools` and `tool_search_output` coverage with one tool item before `_replayPrefixLen` and one in the current suffix; only current-suffix declarations may change.

Add native V2 coverage by adapting the existing Desktop fixture: parsed `collaboration.spawn_agent` plus V2 companions and raw `type: "namespace", name: "collaboration"` under `additional_tools`. Add plaintext V2 parity where parsed stays `collaboration`, `_v2PlaintextCollaborationAlias === true`, and raw uses `V2_PLAINTEXT_COLLABORATION_NAMESPACE` because `rewriteV2PlaintextCollaborationRequest` already ran.

Add atomic no-op cases for missing/non-string/required `model`, malformed parameters, a namespace/parsed mismatch, mixed flat+namespaced shape, contradictory companions, and empty candidates. If any active parsed/raw declaration cannot advertise the candidates, assert `{ advertised: false, changedParsed: false, changedRaw: false }` and byte-identical input—never a partial patch.

- [ ] **Step 2: Run schema tests and confirm RED**

Run: `bun test tests/request-scoped-spawn.test.ts --test-name-pattern "advertis|schema|enum|description|additional_tools"`

Expected: FAIL because `advertiseRequestScopedSpawnCandidates` is not exported.

- [ ] **Step 3: Implement atomic V2 parsed/raw visitors**

Use private guards that accept only an optional string `parameters.properties.model`. First discover and validate every active representation without mutation; build copy-on-write patches; apply them only when all required representations accept the candidates. An already-present id counts as successfully advertised even when it requires no byte change. Append exact ids to an existing string enum in original order and append one fixed sentence to an open string description. Traverse:

- flat parsed `{ name: "spawn_agent", namespace: undefined }` tools;
- native V2 parsed `{ name: "spawn_agent", namespace: "collaboration" }` tools when V2 companions confirm the surface;
- flat raw `type: "function", name: "spawn_agent"` in `_rawBody.tools`;
- native V2 raw `type: "namespace", name: "collaboration"` groups;
- native plaintext V2 raw `type: "namespace", name: V2_PLAINTEXT_COLLABORATION_NAMESPACE` groups only when `_v2PlaintextCollaborationAlias === true`;
- current-suffix `type: "additional_tools"` and `type: "tool_search_output"` tool arrays after `_replayPrefixLen`.

Do not create `model`, change `required`, or use candidate display names/scores in schema prose. Use the explicit `surface` argument from `prepareMultiAgentGuidance`; still verify the complete parsed collaboration shape and refuse mixed/contradictory tools. Parsed and raw V2 namespace names intentionally differ after plaintext aliasing; that exact proven pair is parity, not a mismatch.

- [ ] **Step 4: Add failing V2 guidance-plan integration tests**

Extend `parsedFixture` so named tests pass real raw input after `_replayPrefixLen`; `context.messages` alone must never trigger discovery. Inject catalog and routing dependencies hermetically:

```ts
const namedGrok = parsedFixture({
  tools: [{ name: "spawn_agent" }],
  rawInput: [{ type: "message", role: "user", content: [
    { type: "input_text", text: "Use Grok 4.6 for this review" },
  ] }],
});
const spawnParameters = {
  type: "object",
  properties: {
    message: { type: "string" },
    model: { type: "string", enum: ["gpt-5.6-sol"] },
  },
  required: ["message"],
};
namedGrok.context.tools = [{
  name: "spawn_agent",
  description: "",
  parameters: structuredClone(spawnParameters),
}];
(namedGrok._rawBody as Record<string, unknown>).tools = [{
  type: "function",
  name: "spawn_agent",
  parameters: structuredClone(spawnParameters),
}];

const plan = await prepareMultiAgentGuidance(namedGrok, {
  multiAgentGuidanceEnabled: true,
  subagentModels: ["gpt-5.6-sol"],
}, {
  loadRequestCatalog: () => [
    catalogRow("gpt-5.6-sol", { priority: 0 }),
    catalogRow("xai/grok-4.6", { priority: 5 }),
  ],
  collectCatalogState: () => ({ state: "fresh" }),
  canRouteSpawnModel: () => true,
});

expect(plan.requestScopedCandidates.map(candidate => candidate.model))
  .toEqual(["xai/grok-4.6"]);
const advertised = advertiseRequestScopedSpawnCandidates(
  namedGrok,
  plan.surface,
  plan.requestScopedCandidates,
);
const text = finalizeMultiAgentGuidanceText(plan, advertised);
expect(text).toContain("choose the best target for the task");
expect(text).toContain("without asking the user to clarify");
expect(text).toContain('"xai/grok-4.6"');
expect(text).not.toContain("Use Grok 4.6 for this review");
```

Add named V2 custom-prompt coverage proving the existing substituted custom body remains and the fixed selection/unavailable block is appended inside the same `<multi_agent_mode>` only after successful advertisement. Add encrypted V2 coverage proving an external candidate rejected by `isEncryptedTaskCompatibleModel` appears in neither final text nor `plan.requestScopedCandidates`.

Add a malformed/unsupported spawn-schema case where resolution finds `xai/grok-4.6` but advertisement returns false; final text must contain fixed `no_spawn_override`/unavailable guidance and must not contain `xai/grok-4.6`. Add named stale/unknown V2 cases asserting the existing restart sentence, zero candidates, no enum union, and no appended selection block.

Snapshot or exact-equality test the unnamed V2 result before and after `prepareMultiAgentGuidance` to prove the text and raw/parsed tools are byte-identical. Assert `multiAgentGuidanceEnabled: false` performs no catalog/routing calls.

- [ ] **Step 5: Run V2 integration tests and confirm RED**

Run:

```bash
bun test tests/request-scoped-spawn.test.ts tests/multi-agent-compat.test.ts
```

Expected: pure matcher tests pass; new V2 plan tests fail because `prepareMultiAgentGuidance` is absent.

- [ ] **Step 6: Share one unsliced catalog snapshot with roster projection**

Change `createRequestScopedSubagentRosterContext` into a context that retains `catalogEntries` plus the two existing roster callbacks. Read `readCatalog(readCodexCatalogPath())?.models ?? []` once per prepared request. The existing roster callback must still call `effectiveSubagentRoster(..., catalogEntries)` and therefore keep the five-row slice; only `resolveRequestScopedSpawnCandidates` receives the full unsliced array.

When tests inject `loadRequestCatalog`, construct the same shared context from that returned array. Do not add network I/O.

- [ ] **Step 7: Implement `prepareMultiAgentGuidance` and keep the wrapper compatible**

Preserve the current V2 guidance body as `plan.text`, with no request-scoped ids. Store the resolution separately and implement the finalizer as this explicit state machine:

```ts
switch (plan.requestScopedResolution.status) {
  case "none":
    return plan.text;
  case "unavailable":
    return plan.requestScopedResolution.reason === "stale_catalog"
      ? plan.text
      : appendUnavailableWithoutIds(plan.text);
  case "matched":
    return advertisement.advertised
      ? appendMatchedCandidates(plan.text, plan.requestScopedCandidates)
      : appendNoSpawnOverrideWithoutIds(plan.text);
}
```

The matched block lists trusted exact ids and each row's `catalogEntryEfforts` ladder, tells the parent to choose by task fit, honor versions/variants, pass the exact id, and not ask for clarification or substitute another family. The unavailable or `no_spawn_override` block names no model id and tells the parent to report unavailability unless the user allowed fallback.

`injectionPrompt` still owns its existing placeholders; append the fixed block after the substituted prompt body but inside the same `<multi_agent_mode>` wrapper. An `injectionEffort` appears for a request-scoped candidate only when that exact ladder contains it. For `stale_catalog`, preserve the existing V2 restart sentence and append no candidate or generic unavailable block.

- [ ] **Step 8: Wire production core in plan → advertise → inject order**

Replace the text-only call at `core.ts:944` with the explicit four-stage flow:

```ts
const guidancePlan = await prepareMultiAgentGuidance(parsed, options, {
  canRouteSpawnModel: (model: string): boolean => {
    try {
      routeModel(config, model);
      return true;
    } catch {
      return false;
    }
  },
  ...(encryptedCodexTasks ? { isEncryptedTaskCompatibleModel } : {}),
});

const advertisement = guidancePlan.requestScopedCandidates.length > 0
  ? advertiseRequestScopedSpawnCandidates(
    parsed,
    guidancePlan.surface,
    guidancePlan.requestScopedCandidates,
  )
  : { advertised: false, changedParsed: false, changedRaw: false };
const guidance = finalizeMultiAgentGuidanceText(guidancePlan, advertisement);
if (guidance) injectDeveloperMessage(parsed, guidance);
```

Keep the existing combo-aware encrypted compatibility implementation as the actual `isEncryptedTaskCompatibleModel` callback; factor it into a local named function rather than duplicating its logic. Update debug output with fixed surface, guidance length, and candidate count only. Do not log candidate ids or prompt text.

- [ ] **Step 9: Run V2 focused tests, privacy scan, and typecheck**

Run:

```bash
bun test tests/request-scoped-spawn.test.ts tests/multi-agent-compat.test.ts
bun run typecheck
bun run privacy:scan
```

Expected: all focused V2 tests pass; typecheck and privacy scan pass.

- [ ] **Step 10: Commit the V2 adapter and schema overlay together**

```bash
git add src/codex/request-scoped-spawn.ts src/server/responses/collaboration.ts src/server/responses/core.ts src/server/responses.ts tests/request-scoped-spawn.test.ts tests/multi-agent-compat.test.ts
git commit -m "feat: expose request-scoped spawn targets on V2"
```

### Task 3: Isolated V1 Namespaced Adapter

**Files:**

- Modify: `src/codex/request-scoped-spawn.ts`
- Modify: `src/server/responses/collaboration.ts:423-428`
- Modify: `tests/request-scoped-spawn.test.ts`
- Modify: `tests/multi-agent-compat.test.ts`

**Interfaces:**

- Consumes: Task 1 matcher, Task 2 guidance plan and advertisement entry point.
- Produces: V1-only namespaced schema visitors and selection copy; no new exported function is required.
- Invariants: no `fork_turns`, `send_message`, V2 encrypted-task filter, V2 plaintext requirement, configured roster, preferred worker, fallback list, or custom `injectionPrompt` payload enters V1.

- [ ] **Step 1: Add failing nested V1 schema tests**

Use both supported namespaces and both raw locations:

```ts
const namespaceTool = (name: "agents" | "multi_agent_v1") => ({
  type: "namespace",
  name,
  tools: [{
    type: "function",
    name: "spawn_agent",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
        model: { type: "string", enum: ["gpt-5.6-luna"] },
      },
      required: ["message"],
    },
  }],
});
```

Assert flattened parsed `{ namespace: "agents", name: "spawn_agent" }` and raw nested namespace schemas receive the same exact candidate id. Cover `_rawBody.tools` and current-suffix `additional_tools`. Assert namespace names, nesting, companion tools, required fields, and strictness remain byte-identical. A namespace in the replay prefix and any `collaboration`/unknown namespace remain untouched.

- [ ] **Step 2: Add failing V1 behavior tests**

Add these exact request-level assertions:

- Named V1 at `medium` returns the exact-id selection block and candidates.
- Named V1 at `max` contains the unchanged Proactive text plus the additive selection block.
- Unnamed V1 at `medium` remains `null` and byte-identical.
- Unnamed V1 at `max` remains exactly the tagged `PROACTIVE_MULTI_AGENT_MODE_TEXT`, with no roster/candidate ids.
- V1-pinned Luna is eligible; V2-pinned and unpinned list-visible rows retain existing V1 semantics.
- Named V1 Grok remains eligible even when `encryptedCodexTasks: true` and `canConsumeTask` returns false.
- V1 selection copy contains neither `fork_turns` nor `send_message`.
- Named V1 with stale/unknown catalog returns fixed restart/unavailable guidance and zero candidates; unnamed V1 does not start emitting a stale message.
- Mixed flat/namespaced or mixed V1/V2 companions stay silent and receive no schema mutation.

- [ ] **Step 3: Run V1 tests and confirm RED**

Run:

```bash
bun test tests/request-scoped-spawn.test.ts tests/multi-agent-compat.test.ts --test-name-pattern "V1|v1|namespaced|agents|multi_agent_v1"
```

Expected: existing unnamed V1 tests pass; named V1 and namespace-advertisement tests fail.

- [ ] **Step 4: Implement the V1 raw/parsed visitor without flattening**

For parsed tools, accept only `name: "spawn_agent"` with namespace `agents` or `multi_agent_v1`. For raw tools, descend one level only into matching `type: "namespace"` groups and patch only their child `type: "function", name: "spawn_agent"`. Reuse the Task 2 model-property patcher so enum/description behavior and bounds remain identical.

- [ ] **Step 5: Add named V1 planning without changing unnamed gates**

Extract intent before applying the current effort gate. If no intent is recognized, set resolution status `none` and execute the existing V1 branch byte-for-byte: `null` below max/ultra and tagged Proactive text at max/ultra. If intent is recognized, resolve with `surface: "v1"`, use `canRouteSpawnModel`, skip encrypted compatibility filtering, and keep candidate ids only in `requestScopedCandidates` until the shared finalizer runs. At max/ultra `plan.text` is the existing Proactive text; below it `plan.text` is null. Named stale/unknown V1 sets restart-only `plan.text` plus `unavailable/stale_catalog`; it never enters the generic unavailable or positive-id branch.

Do not apply `effortCap` to V1 parent turns and do not change `effortCapAppliesTo`.

- [ ] **Step 6: Run focused V1/V2 regression tests and typecheck**

Run:

```bash
bun test tests/request-scoped-spawn.test.ts tests/multi-agent-compat.test.ts
bun run typecheck
```

Expected: all named and unnamed V1/V2 cases pass; TypeScript reports no errors.

- [ ] **Step 7: Commit the V1 adapter separately**

```bash
git add src/codex/request-scoped-spawn.ts src/server/responses/collaboration.ts tests/request-scoped-spawn.test.ts tests/multi-agent-compat.test.ts
git commit -m "feat: expose request-scoped spawn targets on V1"
```

### Task 4: Managed Skill, Architecture Invariant, And User Documentation

**Files:**

- Modify: `src/skills/codexcommander-delegation/SKILL.md`
- Modify: `tests/codex-delegation-templates.test.ts`
- Modify: `structure/03_catalog-and-subagents.md`
- Modify: `docs-site/src/content/docs/guides/sub-agent-surface.md`
- Modify: `docs-site/src/content/docs/guides/model-ordering.md`
- Modify: `docs-site/src/content/docs/reference/configuration/agents.md`

**Interfaces:**

- Consumes: canonical managed skill rendering and the implemented V1/V2 behavior.
- Produces: installed skill/API preview/package bytes from the existing canonical renderer; no model id or roster is persisted in managed artifacts.

- [ ] **Step 1: Add a failing managed-skill contract test**

Keep the canonical-byte assertion and add semantic invariants:

```ts
expect(bundle.skillText).toContain("five quick picks");
expect(bundle.skillText).toMatch(/request-scoped|current turn/i);
expect(bundle.skillText).toMatch(/exact id/i);
expect(bundle.skillText).toMatch(/never remember|absent from the current live contract/i);
expect(bundle.skillText).not.toMatch(/xai\/grok|anthropic\/claude|kimi\/k3|gpt-5\.6-sol/);
```

Use the existing `renderCodexDelegationBundle` and canonical source fixture in the file; do not duplicate the rendered skill string.

- [ ] **Step 2: Run the skill test and confirm RED**

Run: `bun test tests/codex-delegation-templates.test.ts`

Expected: FAIL because the canonical skill does not yet describe current-turn full-catalog candidates.

- [ ] **Step 3: Update the canonical skill without model ids**

Add this contract in repository voice:

```text
The live spawn contract consists of the five quick picks plus any request-scoped full-catalog candidates explicitly added for the current turn. Choose among only those live candidates, pass the exact id, and never remember an id for a later turn or use one absent from the current contract.
```

Keep every existing roster-free, live-contract, mode, self-contained-brief, and wait/interruption rule intact. Do not edit generated install/package outputs.

- [ ] **Step 4: Synchronize structure and user documentation**

Document these exact distinctions:

- five featured choices are persistent quick picks and still control default advertisement;
- a current natural-language model/provider request searches the compatible full active catalog without changing configuration;
- exact versions bind; vague family requests are automatically resolved by the parent from a bounded ordered set without clarification;
- V2 encrypted parents expose only ciphertext-compatible targets, while V1 uses its established plaintext cross-provider path;
- stale workers name no exact off-roster ids and require the existing restart boundary;
- no new config field, command, Apply action, roster edit, or catalog priority change is required.

Keep examples user-facing and consistent with the spec. Do not claim that any model outside the worker-loaded catalog is spawnable.

- [ ] **Step 5: Run skill, docs, privacy, and type checks**

Run:

```bash
bun test tests/codex-delegation-templates.test.ts
bun run typecheck
bun run privacy:scan
cd docs-site && bun run build
```

Expected: skill test, typecheck, privacy scan, and Starlight build pass.

- [ ] **Step 6: Commit the skill and docs slice**

```bash
git add src/skills/codexcommander-delegation/SKILL.md tests/codex-delegation-templates.test.ts structure/03_catalog-and-subagents.md docs-site/src/content/docs/guides/sub-agent-surface.md docs-site/src/content/docs/guides/model-ordering.md docs-site/src/content/docs/reference/configuration/agents.md
git commit -m "docs: describe request-scoped full-catalog delegation"
```

### Task 5: Full Verification, Grok Canaries, And Release Handoff

**Files:**

- Verify only; do not add a verification artifact to tracked source unless a failure requires a regression test in the owning earlier task.

**Interfaces:**

- Consumes: the four reviewed implementation commits.
- Produces: evidence that focused, full, privacy, docs, and live V1/V2 acceptance gates pass without roster/catalog mutation.

- [ ] **Step 1: Inspect the final diff for scope and persistent-mutation regressions**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- src/codex/catalog/sync.ts src/codex/subagent-roster.ts src/server/management
```

Expected: `git diff --check` is silent; production changes are confined to the file map; catalog sync, roster persistence, and management APIs have no runtime diff.

- [ ] **Step 2: Run all focused feature tests together**

Run:

```bash
bun test tests/request-scoped-spawn.test.ts tests/multi-agent-compat.test.ts tests/codex-delegation-templates.test.ts
```

Expected: every focused test passes in one process.

- [ ] **Step 3: Run repository release gates serially**

Run:

```bash
bun run typecheck
bun run privacy:scan
bun run test:parallel
cd docs-site && bun run build
```

Expected: every command exits zero. If the parallel runner itself misbehaves or shows cross-shard interference, preserve its output and run `bun run test` once as the serial fallback; do not label a product failure as infrastructure without isolating the failing test first.

- [ ] **Step 4: Request final two-stage review**

Give the spec, this plan, `origin/main...HEAD`, and gate outputs to a Sol-class reviewer. First ask for requirement-by-requirement compliance, then use a separate reviewer for code quality, privacy, and request-schema safety. Fix only confirmed findings through the owning task's tests and rerun affected gates.

- [ ] **Step 5: Run a fresh plaintext V2 Grok canary after deployment is separately authorized**

Preconditions: the exact Grok target exists in the worker-loaded full catalog but is outside the configured five; the V2 parent uses plaintext delivery; the running proxy contains the implementation; the worker state is fresh.

In a new Codex task, request: `Use Grok 4.6 for this review.` Confirm from the live spawn contract and child identity that:

- the request-scoped exact Grok id is present even though it is not one of the five quick picks;
- the parent does not ask for clarification;
- the parent calls native `spawn_agent` with the exact id and a supported effort;
- no roster, priority, config, or catalog bytes change.

- [ ] **Step 6: Run a fresh V1 Grok canary after deployment is separately authorized**

In a new V1 task with the same off-roster catalog target, request: `Use Grok 4.6 for this review.` Confirm the namespaced V1 `spawn_agent` accepts the exact id, task delivery works without V2 plaintext mode, the guidance/tool call contains no `fork_turns`, and the five configured quick picks remain unchanged.

- [ ] **Step 7: Run negative live canaries**

In fresh tasks, confirm:

- `Use Grok` automatically selects one live Grok candidate without clarification;
- `Use Grok 4.6` never selects Grok 4.5;
- a normal request with no model name exposes only the ordinary five-choice behavior;
- an encrypted V2 native parent names no external Grok id;
- a stale/unknown worker receives restart guidance and no request-scoped id.

- [ ] **Step 8: Report evidence and stop before merge/push/restart actions not already authorized**

Summarize the four commits, focused/full gate results, reviewer findings, live canaries, and any deferred environment-dependent check. Do not claim deployment merely because source tests pass.

## Acceptance Checklist

- [ ] Fresh plaintext V2 can spawn an exact compatible off-roster model named naturally by the current user.
- [ ] Fresh V1 can do the same through its namespaced plaintext path.
- [ ] Plain family requests complete without clarification; exact version/variant requests bind.
- [ ] The parent, not a proxy quality table, selects among at most eight deterministically ordered factual matches.
- [ ] Parsed/raw routed V2, native `collaboration`, plaintext-aliased V2, and V1 namespaced schemas advertise the same request-scoped ids atomically.
- [ ] Unnamed V1/V2, mixed surfaces, disabled guidance, malformed schemas, replay-only mentions, encrypted incompatibility, and stale workers all fail closed as specified.
- [ ] No user text, matching text, scores, candidate dumps, or request-scoped choice reaches logs or persistence.
- [ ] The five-row roster, priorities, activation, Apply, auth, routing configuration, and effort-cap boundaries remain unchanged.
- [ ] Focused tests, typecheck, privacy scan, full suite, docs build, two-stage review, and authorized live canaries pass before deployment is called complete.

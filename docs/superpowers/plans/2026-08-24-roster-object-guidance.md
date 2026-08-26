# Roster Object Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators edit optional per-model guidance on the Configured Roster screen by persisting an ordered `{ model, guidance? }[]` roster, while Codex still chooses among live advertised models.

**Architecture:** One owning helper normalizes legacy strings and new objects into canonical roster entries. Catalog, activation, Claude, fallback, and provider rewrites consume projected model ids. The management API and GUI save full objects. Eligible V2 turns append sanitized notes after the existing spawn-contract text, inside the 700-character budget.

**Tech Stack:** Bun-native TypeScript, React + Vite dashboard, Bun test, existing CodexCommander management auth and i18n.

**Spec:** `docs/superpowers/specs/2026-08-24-roster-object-guidance-design.md`

## Global Constraints

- Do not alter `/api/v2`, `subagentDeveloperInstructions`, `config.toml`, or existing roster-injection catalog rows.
- Do not hardcode roster model IDs into the installed skill or `AGENTS.md` block.
- Do not add hashes, manifests, or hidden ownership files.
- Do not push, merge to main, publish, or release.
- Do not restart the user's running proxy or mutate live Codex configuration without explicit permission.
- Work directly in the CodexCommander checkout on `codex/managed-delegation-setup`. Do not create a Git worktree.
- Maximum five roster entries. Guidance is optional, advisory, and untrusted operator text.
- Guidance-only writes must not dirty catalog identity or force Apply.
- Every visible GUI string must exist in `en`, `de`, `ko`, `zh`, `ru`, and `ja`.
- Tests must use temporary CodexCommander and Codex homes and never mutate the developer's real home.

## File Map

### New files

- `src/codex/subagent-roster.ts` — parse, canonicalize, project, rewrite, and validate roster objects.
- `tests/subagent-roster.test.ts` — helper, schema, load-without-rewrite, and persist-on-write coverage.
- `gui/tests/subagents-roster-guidance.test.tsx` — disclosure, dirty/poll, busy, and save-body coverage.

### Modified files

- `src/types.ts` — `SubagentRosterEntry` and `CodexCommanderConfig.subagentModels`.
- `src/config.ts` — dual-read schema, default objects, no load rewrite.
- `src/server/index.ts` — seed and catalog featured lists use projected ids.
- `src/codex/convergence.ts` — hash projected ids, not objects.
- `src/codex/catalog-activation.ts` — `desired.chosen` remains `string[]`.
- `src/codex/catalog/sync.ts` — keep `effectiveSubagentRoster(configuredModels: string[])`.
- `src/claude/agents-inject.ts` — iterate projected ids; do not copy guidance.
- `src/providers/provider-id-rewrite.ts` — rewrite `.model`, preserve guidance, dedupe by model.
- `src/server/management/combo-routes.ts` and `routing-profile-routes.ts` — same rewrite contract.
- `src/server/management/agent-settings-routes.ts` — GET `roster`, PUT `{ roster }` or `{ models }`, skip converge on guidance-only writes.
- `src/server/responses/collaboration.ts` and `core.ts` — pass entries, append notes after filters, drop notes before contract text.
- `src/cli/agent.ts` — keep `{ models }` set/clear; add guidance set/clear.
- `gui/src/pages/Subagents.tsx` and `SubagentsWorkspace.tsx` — object draft, disclosure editor, `{ roster }` save.
- `gui/src/styles-subagents-workspace.css` — collapsed preview and expanded field.
- `gui/src/i18n/{en,de,ko,zh,ru,ja}.ts` — all new copy.
- `gui/tests/subagents-classic.test.ts`, `subagents-classic.test.tsx`, `subagents-busy-race.test.tsx` — roster object contracts.
- `tests/multi-agent-compat.test.ts`, `injection-model-api.test.ts`, `provider-id-rewrite.test.ts`, `combo-management-api.test.ts`, `routing-profile-management-editor.test.ts`, `claude-agents-inject.test.ts`, `codex-catalog-activation.test.ts`, `cli-headless-parity.test.ts` — compatibility and injection.
- `structure/03_catalog-and-subagents.md`, `structure/05_gui-and-management-api.md`
- `docs-site/src/content/docs/reference/configuration/agents.md`, `reference/management-api.md`, `guides/sub-agent-surface.md`, `guides/model-ordering.md`, `guides/web-dashboard.md`

### Do not edit

- `src/skills/codexcommander-delegation/SKILL.md` content except docs that say it stays roster-free.
- `gui/dist/`, `docs-site/dist/`, generated catalogs, the running proxy, user `config.json`, `$CODEX_HOME`.

---

### Task 1: Roster helper and dual-read schema

**Files:**
- Create: `src/codex/subagent-roster.ts`
- Create: `tests/subagent-roster.test.ts`
- Modify: `src/types.ts:542-546`
- Modify: `src/config.ts:1107`, `src/config.ts:1452-1460`, `src/config.ts:2521`

**Interfaces:**
- Consumes: existing canonical selector grammar, `redactSecretString`, `MAX_SPAWN_AGENT_MODEL_OVERRIDES`.
- Produces:

```ts
export const SUBAGENT_GUIDANCE_MAX_CODE_POINTS = 160;

export interface SubagentRosterEntry {
  model: string;
  guidance?: string;
}

export function normalizeSubagentRoster(raw: unknown): SubagentRosterEntry[];
export function canonicalSubagentRoster(entries: readonly SubagentRosterEntry[]): SubagentRosterEntry[];
export function subagentRosterModels(entries: readonly SubagentRosterEntry[] | undefined): string[];
export function mergeLegacyRosterWrite(
  current: readonly SubagentRosterEntry[] | undefined,
  models: readonly string[],
): SubagentRosterEntry[];
export function rewriteSubagentRosterModels(
  entries: readonly SubagentRosterEntry[],
  rewrite: (model: string) => string,
): SubagentRosterEntry[];
export function isSubagentGuidanceSafe(text: string): boolean;
```

- [ ] **Step 1: Write failing helper tests**

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  canonicalSubagentRoster,
  mergeLegacyRosterWrite,
  normalizeSubagentRoster,
  rewriteSubagentRosterModels,
  subagentRosterModels,
} from "../src/codex/subagent-roster";

test("normalizes strings, objects, and mixed arrays", () => {
  expect(normalizeSubagentRoster(["gpt-5.6-sol", { model: "xai/grok-4.6", guidance: "  Review  " }])).toEqual([
    { model: "gpt-5.6-sol" },
    { model: "xai/grok-4.6", guidance: "Review" },
  ]);
});

test("rejects extra keys, blank models, duplicate models, and unsafe guidance", () => {
  expect(() => normalizeSubagentRoster([{ model: "gpt-5.6-sol", effort: "high" }])).toThrow();
  expect(() => normalizeSubagentRoster([{ model: "gpt-5.6-sol" }, { model: "gpt-5.6-sol" }])).toThrow();
  expect(() => normalizeSubagentRoster([{ model: "xai/grok-4.6", guidance: "Use <secret>" }])).toThrow();
});

test("legacy model writes preserve remaining guidance", () => {
  const current = [
    { model: "xai/grok-4.6", guidance: "Review" },
    { model: "gpt-5.6-luna" },
  ];
  expect(mergeLegacyRosterWrite(current, ["gpt-5.6-luna", "xai/grok-4.6"])).toEqual([
    { model: "gpt-5.6-luna" },
    { model: "xai/grok-4.6", guidance: "Review" },
  ]);
});
```

- [ ] **Step 2: Run the helper tests and confirm they fail**

Run: `bun test tests/subagent-roster.test.ts`
Expected: FAIL because `src/codex/subagent-roster.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Canonical rules:
- `string` becomes `{ model }`
- object must have only `model` and optional `guidance`
- trim model; reject blank, non-canonical, or duplicate models
- NFC, trim, omit empty guidance
- reject guidance with controls, `<>{}`, more than 160 code points, or token-shaped secrets
- `rewriteSubagentRosterModels` rewrites `.model`, then dedupes by rewritten model while keeping the first guidance

```ts
export function subagentRosterModels(entries: readonly SubagentRosterEntry[] | undefined): string[] {
  return (entries ?? []).map(entry => entry.model);
}
```

- [ ] **Step 4: Add schema dual-read without load rewrite**

In `src/types.ts`, change `subagentModels?: string[]` to `subagentModels?: SubagentRosterEntry[]`.

In `src/config.ts`, replace `subagentModels: stringArraySchema.optional()` with a union that accepts strings or `{ model, guidance? }` objects, then normalize through `canonicalSubagentRoster`. Keep `getDefaultConfig()` returning five `{ model }` objects from `DEFAULT_SUBAGENT_MODELS`. Loading an on-disk `string[]` must succeed and leave the file bytes unchanged until the next cooperating write.

Add tests:

```ts
test("loads a legacy string roster without rewriting the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccx-roster-"));
  process.env.CODEXCOMMANDER_HOME = dir;
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    port: 10100,
    defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    subagentModels: ["gpt-5.6-sol", "gpt-5.6-luna"],
    multiAgentGuidanceEnabled: true,
  }));
  const before = readFileSync(configPath, "utf8");
  const { loadConfig } = require("../src/config");
  const config = loadConfig();
  expect(subagentRosterModels(config.subagentModels)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
  expect(readFileSync(configPath, "utf8")).toBe(before);
});
```

Use the repository's existing isolated-home helpers if this raw fixture is too incomplete; the invariant is "load succeeds, file bytes unchanged".

- [ ] **Step 5: Run helper and config tests**

Run: `bun test tests/subagent-roster.test.ts tests/config.test.ts`
Expected: PASS for the new cases; existing config tests that round-trip `subagentModels` as strings must be updated to accept objects after a save, but load fixtures may remain strings.

- [ ] **Step 6: Commit**

```bash
git add src/codex/subagent-roster.ts src/types.ts src/config.ts tests/subagent-roster.test.ts tests/config.test.ts
git commit -m "$(cat <<'EOF'
feat: persist subagent roster objects with optional guidance

Accept legacy string arrays on load and canonicalize to { model, guidance? }
without rewriting config.json until the next roster write.
EOF
)"
```

---

### Task 2: Project model ids at every consumer

**Files:**
- Modify: `src/server/index.ts:495-496,853,901`
- Modify: `src/codex/convergence.ts:245,400`
- Modify: `src/codex/catalog-activation.ts:375`
- Modify: `src/claude/agents-inject.ts:138-146`
- Modify: `src/providers/provider-id-rewrite.ts:53-75`
- Modify: `src/server/management/combo-routes.ts:128-129`
- Modify: `src/server/management/routing-profile-routes.ts:213-214`
- Test: `tests/codex-catalog-activation.test.ts`, `tests/provider-id-rewrite.test.ts`, `tests/combo-management-api.test.ts`, `tests/routing-profile-management-editor.test.ts`, `tests/claude-agents-inject.test.ts`

**Interfaces:**
- Consumes: `subagentRosterModels()`, `rewriteSubagentRosterModels()`, `canonicalSubagentRoster()`.
- Produces: catalog featured lists and Claude defs still receive `string[]`. Guidance never enters catalog JSON or `ccx-*.md`.

- [ ] **Step 1: Write failing projection tests**

Add to `tests/codex-catalog-activation.test.ts`:

```ts
test("guidance-only roster changes do not change catalog desired revision", () => {
  const ids = config({ subagentModels: [{ model: "gpt-5.6-luna" }] });
  const notes = config({ subagentModels: [{ model: "gpt-5.6-luna", guidance: "Fast mechanical work" }] });
  expect(codexCatalogDesiredRevision(ids)).toBe(codexCatalogDesiredRevision(notes));
});
```

Add to `tests/provider-id-rewrite.test.ts`:

```ts
test("provider rewrite keeps roster guidance and dedupes by rewritten model", () => {
  const config = makeConfig({
    subagentModels: [
      { model: `${FROM}/qwen3.7-max`, guidance: "Use for coding" },
      { model: `${FROM}/other` },
    ],
  });
  rewriteProviderReferences(config, FROM, TO);
  expect(config.subagentModels).toEqual([
    { model: `${TO}/qwen3.7-max`, guidance: "Use for coding" },
    { model: `${TO}/other` },
  ]);
});
```

Add to `tests/claude-agents-inject.test.ts`:

```ts
test("Claude agent defs ignore roster guidance text", () => {
  const defs = buildClaudeAgentDefs(cfg({
    subagentModels: [{ model: "gpt-5.6-sol", guidance: "Do not copy this into Claude" }],
  }), {}, dir);
  const rendered = defs.map(def => renderOrRead(def)).join("\n");
  expect(rendered).not.toContain("Do not copy this into Claude");
});
```

Use the existing Claude render helper in that file rather than inventing `renderOrRead`.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `bun test tests/codex-catalog-activation.test.ts tests/provider-id-rewrite.test.ts tests/claude-agents-inject.test.ts`
Expected: FAIL on object-shaped `subagentModels` and/or guidance leaking.

- [ ] **Step 3: Project ids at every consumer**

Replace direct `config.subagentModels` id use with:

```ts
const featured = subagentRosterModels(config.subagentModels);
```

In `catalogInputIdentity`, hash `subagentRosterModels(value.subagentModels)` rather than the object array.

In `src/server/index.ts`, seed unset rosters as canonical objects:

```ts
if (config.subagentModels === undefined) {
  config.subagentModels = canonicalSubagentRoster(DEFAULT_SUBAGENT_MODELS.map(model => ({ model })));
}
```

Provider/combo/profile rewrites must not do `[...new Set(config.subagentModels.map(...))]` on objects. Use `rewriteSubagentRosterModels`.

Claude `typeof entry !== "string"` continues to work if it iterates `subagentRosterModels(...)`.

- [ ] **Step 4: Run the consumer tests**

Run: `bun test tests/codex-catalog-activation.test.ts tests/codex-catalog-sync-hardening.test.ts tests/provider-id-rewrite.test.ts tests/combo-management-api.test.ts tests/routing-profile-management-editor.test.ts tests/claude-agents-inject.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/codex/convergence.ts src/codex/catalog-activation.ts src/claude/agents-inject.ts src/providers/provider-id-rewrite.ts src/server/management/combo-routes.ts src/server/management/routing-profile-routes.ts tests
git commit -m "$(cat <<'EOF'
fix: keep catalog and Claude consumers on projected roster ids

Guidance stays attached through provider and combo rewrites without
changing catalog identity or generated Claude agent files.
EOF
)"
```

---

### Task 3: Management API roster objects

**Files:**
- Modify: `src/server/management/agent-settings-routes.ts:768-872`
- Test: `tests/agent-settings-lifecycle.test.ts` plus a focused roster API case in that file or `tests/injection-model-api.test.ts` style helper

**Interfaces:**
- Consumes: `canonicalSubagentRoster()`, `mergeLegacyRosterWrite()`, `subagentRosterModels()`.
- Produces:

GET:

```json
{
  "chosen": ["xai/grok-4.6", "gpt-5.6-luna"],
  "roster": [
    { "model": "xai/grok-4.6", "guidance": "Use for independent review" },
    { "model": "gpt-5.6-luna" }
  ]
}
```

PUT body is exactly one of `{ roster }` or `{ models }`. Response keeps `applied: string[]` and adds `roster`.

- [ ] **Step 1: Write failing API tests**

```ts
test("PUT roster round-trips guidance and GET still returns chosen ids", async () => {
  const res = await putSubagentModels({
    roster: [
      { model: "xai/grok-4.6", guidance: "Use for independent review" },
      { model: "gpt-5.6-luna" },
    ],
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.applied).toEqual(["xai/grok-4.6", "gpt-5.6-luna"]);
  expect(body.roster[0]).toEqual({ model: "xai/grok-4.6", guidance: "Use for independent review" });
  const got = await getSubagentModels();
  expect(got.chosen).toEqual(["xai/grok-4.6", "gpt-5.6-luna"]);
  expect(got.roster[0].guidance).toBe("Use for independent review");
});

test("PUT models preserves remaining guidance", async () => {
  await putSubagentModels({ roster: [{ model: "xai/grok-4.6", guidance: "Review" }, { model: "gpt-5.6-luna" }] });
  const res = await putSubagentModels({ models: ["gpt-5.6-luna", "xai/grok-4.6"] });
  expect((await res.json()).roster).toEqual([
    { model: "gpt-5.6-luna" },
    { model: "xai/grok-4.6", guidance: "Review" },
  ]);
});

test("guidance-only PUT skips catalog converge", async () => {
  await putSubagentModels({ models: ["gpt-5.6-luna"] });
  const res = await putSubagentModels({ roster: [{ model: "gpt-5.6-luna", guidance: "Fast mechanical work" }] });
  const body = await res.json();
  expect(body.catalogRefresh?.status === "skipped" || body.catalogRefresh == null || body.catalogRefresh.ok === true).toBe(true);
  // The exact skipped/unchanged assertion should use the existing converge spy in agent-settings-lifecycle tests.
});

test("PUT both models and roster is 400", async () => {
  const res = await putSubagentModels({ models: ["gpt-5.6-luna"], roster: [{ model: "gpt-5.6-luna" }] });
  expect(res.status).toBe(400);
});
```

Also reject more than five entries, duplicate models, tags in guidance, and token-shaped guidance.

- [ ] **Step 2: Run the API tests and confirm they fail**

Run: `bun test tests/agent-settings-lifecycle.test.ts`
Expected: FAIL because GET/PUT still understand only `models: string[]`.

- [ ] **Step 3: Implement GET/PUT**

GET:

```ts
const roster = canonicalSubagentRoster(rosterConfig.subagentModels ?? []);
return jsonResponse({
  chosen: subagentRosterModels(roster),
  roster,
  available,
  catalogState,
  advertised: activation.catalog.advertised,
  excluded: activation.catalog.excluded,
  activation: projectCatalogActivationForPrincipal(activation, ctx.principal),
});
```

PUT:
- If both or neither of `models`/`roster` are present, 400.
- `{ roster }` canonicalizes and replaces.
- `{ models }` uses `mergeLegacyRosterWrite(current, models)`.
- Persist canonical objects.
- If `subagentRosterModels(previous)` equals `subagentRosterModels(next)`, skip `convergeCodexCatalog`. Still persist and return activation evidence from current disk.
- `superseded` compares canonical objects.

Do not put guidance on `activation.desired.chosen`.

- [ ] **Step 4: Run API and activation tests**

Run: `bun test tests/agent-settings-lifecycle.test.ts tests/codex-catalog-activation.test.ts tests/openai-provider-option-e2e.test.ts tests/native-model-toggle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/management/agent-settings-routes.ts tests
git commit -m "$(cat <<'EOF'
feat: accept roster objects on the subagent models API

Keep chosen as projected ids, round-trip optional guidance, and skip
catalog convergence when only notes change.
EOF
)"
```

---

### Task 4: V2 guidance injection

**Files:**
- Modify: `src/server/responses/collaboration.ts:166-394`
- Modify: `src/server/responses/core.ts:944-951`
- Test: `tests/multi-agent-compat.test.ts`

**Interfaces:**
- Consumes: roster entries plus existing `effectiveSubagentRoster(configuredIds, surface)`.
- Produces: V2 built-in text may append ` — {guidance}` after a filtered advertised model. Custom `{{roster}}` stays ids and ladders only.

- [ ] **Step 1: Write failing injection tests**

```ts
test("v2 roster notes appear only for advertised compatible models", async () => {
  catalogFixture(dir, [
    { slug: "xai/grok-4.6", efforts: ["low", "medium", "high", "xhigh"] },
    { slug: "gpt-5.6-luna", efforts: ["low", "medium", "high", "max"] },
  ]);
  const v2 = await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    {
      multiAgentGuidanceEnabled: true,
      subagentRoster: [
        { model: "xai/grok-4.6", guidance: "Use for independent review" },
        { model: "missing/model", guidance: "Must not appear" },
      ],
    },
  );
  expect(v2).toContain('"xai/grok-4.6" (low/medium/high/xhigh) — Use for independent review');
  expect(v2).not.toContain("Must not appear");
});

test("v1 and stale catalogs omit roster notes", async () => {
  const v1 = await multiAgentGuidanceText(
    parsedFixture({
      reasoning: "max",
      tools: [
        { name: "spawn_agent", namespace: "multi_agent_v1" },
        { name: "send_input", namespace: "multi_agent_v1" },
      ],
    }),
    { multiAgentGuidanceEnabled: true, subagentRoster: [{ model: "gpt-5.6-sol", guidance: "Hidden on v1" }] },
  );
  expect(v1).not.toContain("Hidden on v1");
});

test("700-character budget drops notes before dropping spawn-contract text", async () => {
  const note = "N".repeat(160);
  const text = await multiAgentGuidanceText(
    parsedFixture({ tools: [{ name: "spawn_agent" }] }),
    {
      multiAgentGuidanceEnabled: true,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "xhigh",
      subagentRoster: [
        { model: "gpt-5.5", guidance: note },
        { model: "gpt-5.6-sol", guidance: note },
        { model: "gpt-5.6-terra", guidance: note },
        { model: "gpt-5.6-luna", guidance: note },
        { model: "gpt-5.4-mini", guidance: note },
      ],
    },
  );
  expect(text).toContain("fork_turns");
  expect(String(text).length).toBeLessThanOrEqual(700 + "<multi_agent_mode></multi_agent_mode>".length);
});
```

Wire `subagentRoster` through `MultiAgentGuidanceOptions` or derive it from config in the test helper; do not leave a dangling untyped field.

Also assert encrypted-task filtering omits incompatible notes, and `{{roster}}` does not include notes.

- [ ] **Step 2: Run the injection tests and confirm they fail**

Run: `bun test tests/multi-agent-compat.test.ts`
Expected: FAIL because `subagentRosterText` has no guidance argument.

- [ ] **Step 3: Implement note attachment after existing filters**

Keep `effectiveSubagentRoster` on ids. After `compatibleRosterModels` is computed, map configured guidance by exact configured selector:

```ts
function guidanceForAdvertisedModel(
  advertised: string,
  roster: readonly SubagentRosterEntry[],
): string | undefined {
  const exact = roster.find(entry => entry.model === advertised)?.guidance;
  if (exact) return exact;
  const bare = roster.find(entry => !entry.model.includes("/") && advertised.endsWith(`/${entry.model}`));
  return bare?.model && advertised.startsWith(bare.model) ? undefined : undefined;
}
```

Do **not** clone a bare-native note onto unrelated `vendor/gpt-*` rows. Only attach when `configuredSubagentModelMatchesEntry(entry.model, catalogEntry)` is true for that advertised row.

Change `subagentRosterText` to accept optional notes and two renderings:
- `includeNotes: false` for `{{roster}}` and the budget-safe id/ladder suffix
- `includeNotes: true` for the built-in block, dropped first if over budget

Budget order:
1. spawn-contract preamble
2. preferred + fallback
3. roster ids/ladders
4. notes
5. drop all roster last, as today

Never inject notes on V1 or stale/unknown catalogs.

- [ ] **Step 4: Run injection tests**

Run: `bun test tests/multi-agent-compat.test.ts tests/v2-plaintext-collaboration.test.ts tests/subagent-fallback-handle-responses.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/responses/collaboration.ts src/server/responses/core.ts tests/multi-agent-compat.test.ts
git commit -m "$(cat <<'EOF'
feat: include sanitized roster notes in eligible V2 guidance

Attach operator notes only after live advertisement and compatibility
filters, and drop them before spawn-contract text if the budget breaks.
EOF
)"
```

---

### Task 5: CLI guidance commands

**Files:**
- Modify: `src/cli/agent.ts:16-23,94-115`
- Test: `tests/cli-headless-parity.test.ts`

**Interfaces:**
- Consumes: GET `roster`, PUT `{ roster }` or `{ models }`.
- Produces:

```text
ccx agent subagents status
ccx agent subagents set a,b
ccx agent subagents clear
ccx agent subagents guidance set <model> --text "..."
ccx agent subagents guidance clear <model>
```

- [ ] **Step 1: Write failing CLI tests**

Existing `subagents set` must still PUT `{ models: [...] }`.

New tests:
- `guidance set xai/grok-4.6 --text "Use for independent review"` GETs current roster, replaces that entry's guidance, PUTs `{ roster }`
- unknown model is a usage or 400-style CLI error
- `set a,b` still uses `{ models }` so remaining guidance is preserved server-side

- [ ] **Step 2: Run CLI tests and confirm they fail**

Run: `bun test tests/cli-headless-parity.test.ts`
Expected: FAIL on unknown `guidance` action.

- [ ] **Step 3: Implement CLI actions**

Keep `set`/`clear` on `{ models }`. Add `guidance` as a nested action that requires an existing roster selector. Do not invent a second HTTP resource.

- [ ] **Step 4: Run CLI tests**

Run: `bun test tests/cli-headless-parity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/agent.ts tests/cli-headless-parity.test.ts
git commit -m "$(cat <<'EOF'
feat: add CLI commands for roster guidance notes

Keep id-only set/clear as models writes and send canonical roster
objects only when setting or clearing a note.
EOF
)"
```

---

### Task 6: Configured Roster disclosure editor

**Files:**
- Modify: `gui/src/pages/Subagents.tsx`
- Modify: `gui/src/components/subagents-workspace/SubagentsWorkspace.tsx`
- Modify: `gui/src/styles-subagents-workspace.css`
- Modify: `gui/src/i18n/en.ts`, `de.ts`, `ja.ts`, `ko.ts`, `ru.ts`, `zh.ts`
- Modify: `gui/tests/subagents-classic.test.ts`, `subagents-classic.test.tsx`, `subagents-busy-race.test.tsx`
- Create: `gui/tests/subagents-roster-guidance.test.tsx`

**Interfaces:**
- Consumes: GET `chosen` + `roster`; PUT `{ roster }`.
- Produces: one expanded guidance field per model id, dirty including trimmed guidance, poll that cannot clobber unsaved notes.

English copy:

- `sub.guidance.add`: `Add guidance`
- `sub.guidance.edit`: `Edit guidance`
- `sub.guidance.label`: `Guidance`
- `sub.guidance.placeholder`: `When to pick this model`
- `sub.guidance.hint`: `Optional parent-facing hint. Saved with the roster. Codex still chooses. Effort stays in Run Policy.`
- `sub.guidance.clear`: `Clear guidance`
- `sub.guidance.tooLong`: `Guidance is too long`
- `sub.guidance.addAria`: `Add guidance for {m}`
- `sub.guidance.editAria`: `Edit guidance for {m}`

Do not call the field prompt, note, injection, or role.

- [ ] **Step 1: Write failing GUI tests**

Resting five-row roster still shows grip, rank, id, up/down/remove, and disabled Save.

New cases:
- empty row shows Add guidance
- filled row shows one muted preview, not a chip
- typing guidance enables Save roster and PUTs `{ roster: [{ model, guidance }] }`
- whitespace-only is not dirty versus omitted guidance
- 5s poll does not clobber unsaved guidance
- busy disables disclosure and textarea
- over-limit marks the textarea invalid and blocks save
- Arrow keys in the textarea do not reorder
- Escape collapses without reverting the draft
- 620px CSS still hides up/down and does not hide Add/Edit guidance

Update classic save mocks to accept `{ roster }` while remaining compatible with GET `chosen`.

- [ ] **Step 2: Run GUI tests and confirm they fail**

Run: `cd gui && bun test tests/subagents-roster-guidance.test.tsx tests/subagents-classic.test.tsx tests/subagents-busy-race.test.tsx`
Expected: FAIL because rows have no guidance controls and save still sends `{ models }`.

- [ ] **Step 3: Implement the disclosure editor**

Keep collapsed rows visually close to the current screenshot. Put Add/Edit guidance in the identity column, not as a sixth chrome button in the actions cluster if that would wrap the 64px row. Recommended layout:

- collapsed: existing 5-column grid, Add/Edit is a quiet text button under the id or immediately before actions
- expanded: `grid-template-rows: auto auto` with the textarea spanning `grid-column: 1 / -1`

State:
- `chosen: SubagentRosterEntry[]` in the page
- `committedRoster` for dirty/poll
- `expandedModel: string | null`
- dirty compares canonical models + trimmed guidance
- save body is `{ roster: canonicalSubagentRoster(chosen) }`

Reuse the existing page `Notice`. Do not autosave.

- [ ] **Step 4: Add i18n keys and CSS**

Run `cd gui && bun run lint:i18n` after adding keys to every locale module.

Collapsed preview is one muted line with `title` for the full text. Counter appears only after 80% of 160 code points or on error.

- [ ] **Step 5: Run GUI validation**

Run:

```bash
cd gui
bun test tests
bun run lint
bun run lint:i18n
bun run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gui/src/pages/Subagents.tsx gui/src/components/subagents-workspace/SubagentsWorkspace.tsx gui/src/styles-subagents-workspace.css gui/src/i18n gui/tests
git commit -m "$(cat <<'EOF'
feat: edit optional roster guidance on the configured roster card

Keep the compact five-slot rows at rest and save canonical roster
objects from the existing Save roster action.
EOF
)"
```

---

### Task 7: Docs and structure

**Files:**
- Modify: `structure/03_catalog-and-subagents.md`
- Modify: `structure/05_gui-and-management-api.md`
- Modify: `docs-site/src/content/docs/reference/configuration/agents.md`
- Modify: `docs-site/src/content/docs/reference/management-api.md`
- Modify: `docs-site/src/content/docs/guides/sub-agent-surface.md`
- Modify: `docs-site/src/content/docs/guides/model-ordering.md`
- Modify: `docs-site/src/content/docs/guides/web-dashboard.md`

**Interfaces:**
- Consumes: the shipped object schema and advisory-only injection behavior.
- Produces: user-facing docs that say guidance is optional, V2-only, not AGENTS/skill, not quota/effort enforcement, and that older binaries fail after the first object write.

- [ ] **Step 1: Update the configuration table**

`subagentModels?` type becomes `{ model: string, guidance?: string }[] | string[]` on disk, canonicalized in memory to objects. Document the 160-code-point cap and that empty guidance is omitted.

- [ ] **Step 2: Update management-api and dashboard copy**

`GET/PUT /api/subagent-models` reads/writes up to five ordered objects. `{ models }` remains as a guidance-preserving compatibility write. GUI Save roster sends `{ roster }`.

- [ ] **Step 3: State the live-vs-durable split**

Docs must keep the managed skill roster-free. Per-row guidance is live V2 developer text. Native `[agents]` defaults still use `injectionModel` / `injectionEffort` only.

- [ ] **Step 4: Build docs**

Run: `cd docs-site && bun install --frozen-lockfile && bun run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add structure docs-site/src/content/docs
git commit -m "$(cat <<'EOF'
docs: describe optional per-model roster guidance

Document the dual-read object roster, advisory V2 injection, and the
unchanged managed skill plus catalog five-slot window.
EOF
)"
```

---

### Task 8: Whole-branch verification and packaged app rebuild

**Files:**
- No product files unless verification finds a small integration bug.

- [ ] **Step 1: Typecheck and full runtime suite**

```bash
bun run typecheck
bun run test:parallel
bun run privacy:scan
```

If the parallel runner misbehaves, use `bun run test`.

- [ ] **Step 2: GUI and docs suites if those trees changed**

```bash
cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build
cd docs-site && bun run build
```

- [ ] **Step 3: Rebuild the packaged development app**

Rebuild from this checkout so testing targets `dist/macos/CodexCommander.app`. Do not stop or reroute the currently running proxy.

- [ ] **Step 4: Handoff**

Report:
- branch `codex/managed-delegation-setup`
- commits
- verification commands and results
- app bundle path
- that a running process still needs an intentional reopen to load rebuilt resources
- that guidance is advisory and V2-only

Do not merge, push, publish, release, or restart the user's app.

---

## Execution notes

Use `$superpowers:subagent-driven-development`. Keep implementation sequential wherever `subagentModels`, catalog identity, or GUI save contracts overlap. Parallelize only independent review after each task.

Roster selection for implementers:
- Luna for helper/schema and mechanical projection
- Terra for API + GUI integration
- Sol for V2 injection budget/filtering and final synthesis
- Grok for independent adversarial review of prompt-injection, catalog-identity, and encrypted-task filtering

Root orchestrator should not implement unless a small integration fix is safer than another handoff.

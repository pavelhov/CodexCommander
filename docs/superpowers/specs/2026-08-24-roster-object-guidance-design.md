# Roster Object Guidance

## Summary

The Configured Roster remains a five-slot featured picker, but each pick becomes an ordered object `{ model, guidance? }` instead of a bare model id. Users edit that optional guidance on the existing Configured Roster card. Codex still chooses when to spawn and which advertised model to use. CodexCommander only persists the note and, on eligible V2 turns, names it in the live developer-guidance block.

This is an additive product change on the current managed-delegation branch. It does not replace the managed skill, the global `AGENTS.md` block, quota fallback, effort caps, or native `[agents]` defaults.

## Goals

- Let an operator attach a short, optional "when to pick this model" note to each featured roster slot on the Configured Roster screen.
- Persist one ordered array of roster objects so reorder, add, and remove keep guidance attached to the model.
- Keep Codex as the chooser. Guidance is advisory context for the parent, not a proxy-side router.
- Preserve the current five-slot spawn window, catalog identity, encrypted-task filtering, and fail-closed stale-catalog behavior.
- Keep the managed skill and `AGENTS.md` block roster-free.

## Non-goals

- Per-row effort, fallback, concurrency, or `agent_type` / role fields.
- A proxy classifier that picks the child model.
- Putting roster ids or notes into `$HOME/.agents/skills/codexcommander-delegation/SKILL.md` or `$CODEX_HOME/AGENTS.md`.
- Changing `/api/v2`, `subagentDeveloperInstructions`, `config.toml`, or the existing roster-injection catalog rows.
- Raising the five-slot cap.
- Rewriting `config.json` merely because it was loaded.
- Live-enriching stored notes with catalog ladders or capabilities.

## Product decisions

1. **Edit on this screen.** Guidance is authored on the Configured Roster card, not in Run Policy and not in a modal.
2. **One ordered object array.** `subagentModels` becomes `{ model, guidance? }[]`. There is no parallel `subagentGuidance` map.
3. **Guidance is advisory.** It is a parent-facing note, not a worker instruction file and not a spawn-tool override.
4. **Effort stays global.** Adaptive effort continues to come from the live catalog ladder. The existing preferred-effort and cap controls remain in Run Policy.
5. **Roles stay out of the roster.** Codex `spawn_agent` `agent_type` values such as `explorer` and `worker` are harness roles. They are not persisted on roster objects in this change.
6. **Live filtering stays request-time.** Notes are stored as operator text. Compatibility, advertisement, and account projection are recomputed per request.
7. **Legacy id writes preserve notes.** `{ models: string[] }` and `ccx agent subagents set` keep guidance for surviving selectors.

## Current contracts that remain binding

- Codex advertises at most five picker-visible catalog rows (`MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5`).
- Featured order is catalog priority `0..N-1`. Catalog JSON never stores guidance.
- V2 developer guidance is advisory. Quota fallback and effort caps are the enforcement paths.
- Built-in V2 guidance has a 700-character budget and currently drops the roster suffix first.
- Stale or unknown catalogs suppress positive model claims.
- Encrypted native parents advertise only encrypted-task-compatible routes and fail closed when evidence is missing.
- Managed skill + `AGENTS.md` remain roster-free and subordinate to user/repository instructions.
- `subagentModels: undefined` still seeds the default five; an explicit empty list persists.

## Architecture

### Persistence

```ts
export interface SubagentRosterEntry {
  model: string;
  guidance?: string;
}
```

- `model` uses the existing canonical selector grammar: bare native, one-slash routed `provider/model`, or exact account-qualified `<selector>/<native-openai-model>`.
- `guidance` is optional. Blank or whitespace-only values are omitted.
- Unknown object keys are rejected.
- Maximum five entries. Model selectors are unique and ordered.
- Fresh defaults are five `{ model }` objects with no `guidance`, using the current `DEFAULT_SUBAGENT_MODELS` ids.

Load compatibility:

1. Accept on-disk `string[]`, object arrays, and mixed arrays for one release.
2. Normalize in memory to `SubagentRosterEntry[]`.
3. Do not rewrite the file on load.
4. The next cooperating roster write persists canonical objects.

An older binary that still requires `string[]` will fail validation after the first object write. That downgrade break is accepted and documented. Forward compatibility with current files is required.

### Owning helper

Add `src/codex/subagent-roster.ts` as the only parser/canonicalizer:

- `normalizeSubagentRoster(raw)`
- `subagentRosterModels(entries)` -> `string[]`
- `canonicalSubagentRoster(entries)` omits empty guidance
- `mergeLegacyRosterWrite(current, models)` preserves notes for remaining ids
- `rewriteSubagentRosterModels(entries, rewrite)` rewrites `.model` only and dedupes by model
- `isSubagentGuidanceSafe(text)`

Every catalog, activation, Claude, combo, provider-rewrite, and fallback consumer continues to see model ids through `subagentRosterModels()`.

### Guidance validation

Persist and reject at schema and PUT time, not after injection:

- Unicode NFC
- Trim outer whitespace
- Maximum 160 Unicode code points
- No CR, LF, or other control characters
- Reject `<`, `>`, `{`, and `}` so notes cannot smuggle tags or `{{placeholders}}`
- Reject if `redactSecretString(text) !== text`
- Case-sensitive exact model uniqueness

These notes are untrusted operator text. The GUI copy must say they are optional parent-facing hints, never "this worker will" or "instructions".

### Management API

`GET /api/subagent-models` keeps `chosen: string[]` and adds canonical `roster: SubagentRosterEntry[]`. Activation, advertised, and excluded lists remain model ids.

`PUT /api/subagent-models` accepts exactly one of:

- `{ roster: SubagentRosterEntry[] }` — full replace
- `{ models: string[] }` — id replace/reorder that preserves guidance for surviving selectors

Reject both keys, neither key, more than five entries, duplicate models, unsafe guidance, and non-canonical selectors.

Guidance-only writes persist and skip catalog convergence. Id membership or order changes keep the current converge + Claude/Desktop resync path. Claude agent files remain id-derived and must not copy guidance.

`superseded` compares canonical roster objects, not only ids. Responses keep `applied: string[]` and add `roster`.

### GUI

Keep the current Configured Roster grammar. Do not add a second save, a modal, or per-row effort.

Collapsed row with no guidance: grip, rank, icon, model id, `Add guidance`, up/down/remove.

Collapsed row with guidance: the same, plus one muted preview line under the id.

Expanded row: current header stays; a labelled textarea opens under identity. Only one row is expanded, keyed by model id. Escape collapses without reverting the draft.

Dirty includes membership, order, and trimmed guidance. The 5s poll must not clobber unsaved guidance. Save sends `{ roster }`. Library add creates `{ model }` with no guidance. Remove drops the object.

Run Policy's "Use roster as worker guidance" switch remains the global inject-roster-names flag. It is not this per-row field.

### V2 injection

Pass the full roster entries into `multiAgentGuidanceText`. Attach a note only after the existing advertised, account-route, and encrypted-task filters, matching the configured selector rather than cloning a bare-native note onto unrelated `vendor/gpt-*` rows.

Built-in V2 text may append an em-dash note after a model's ladder:

```text
Available models (valid reasoning_effort): "xai/grok-4.6" (low/medium/high/xhigh) — Use for independent review, "gpt-5.6-luna" (low/medium/high/max).
```

Budget composition, never the reverse:

1. Keep the fork_turns / spawn-contract preamble.
2. Keep preferred-model and fallback sentences.
3. Keep compact roster ids and ladders.
4. Drop per-model notes if the 700-character budget would break.
5. Drop the entire roster block last, as today.

Do not inject notes on V1, stale/unknown catalogs, mixed/contradictory collab surfaces, or encrypted-incompatible routes. Do not persist live enrichment.

Custom `injectionPrompt` `{{roster}}` continues to receive ids and ladders only. Notes are not substituted into custom prompts in this change.

### CLI

Keep `ccx agent subagents set a,b` and `clear` as `{ models }` writes.

Add:

```text
ccx agent subagents guidance set <model> --text "..."
ccx agent subagents guidance clear <model>
```

Those send `{ roster }`. Status JSON shows the new `roster` field.

### What "roles" are

The live `spawn_agent` tool may advertise `agent_type` values such as `explorer` or `worker`. Those are Codex harness roles. They are not roster fields, not model ids, and not this feature. Operators who want a model used as a reviewer still write that as guidance text, for example "Use for independent review". Codex may still choose another advertised model.

## Testing

Focused coverage must lock:

- Dual-read of strings, objects, and mixed arrays without rewriting the file on load
- Object persist on the next roster write
- Catalog identity unchanged for guidance-only edits
- Legacy `{ models }` PUT preserves notes
- Provider/combo/profile rewrites keep notes and dedupe by model
- V2 notes appear only for advertised compatible models
- V1, stale catalog, and encrypted-incompatible routes omit notes
- 700-character budget drops notes before contract text
- GUI disclosure, dirty/poll, busy, i18n, and 620px layout

## Risks

- Treating notes as policy. Copy, sanitization, and fail-closed injection are mandatory.
- Hashing full objects in `catalogInputIdentity`. Hash projected ids only.
- `Set` on objects in combo/profile migrators. Dedupe by `.model`.
- First dashboard `{ models }` save wiping CLI-set notes. Server must preserve them until the GUI sends `{ roster }`.
- 160-character notes still overflowing the 700-character budget. Tests must prove notes drop first.

## Open execution choice

Implement in a fresh GPT-5.6 Sol high session from this spec and plan, stacked on `codex/managed-delegation-setup` unless the user asks to isolate from that branch. Do not start implementation in the planning session.

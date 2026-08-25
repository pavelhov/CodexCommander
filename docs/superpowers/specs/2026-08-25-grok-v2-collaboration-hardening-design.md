# Grok and V2 Collaboration Hardening Design

**Date:** 2026-08-25

**Status:** Proposed for final user review

## Problem

Two independent failures were previously treated as one:

1. Some Grok tool calls serialize an integer-valued timeout as a JSON float, such as
   `{"timeout_ms":300000.0}`. Codex deserializes that field as an integer and rejects the
   call before `wait_agent` runs.
2. A successful `wait_agent` call can time out while a child is still working because the
   wait subscribes to child-to-parent mailbox events, not the child's private reasoning,
   commentary, or tool activity. In the investigated incident, the coordinator interpreted
   neutral wait timeouts as liveness failures and explicitly interrupted two healthy Grok
   workers before either produced a final answer.

The incident logs show exact task/control-message delivery, 79 matched tool calls and
outputs across the two Grok workers, no translation or terminal error, and explicit
`turn_aborted` records after the parent called `interrupt_agent`. Historical traces show
the same wait semantics while Grok completed long jobs when the coordinator kept waiting.

## Goals

- Repair integer-valued float tool arguments at the shared translated-provider boundary.
- Make managed delegation guidance state the real `wait_agent` contract and prohibit
  timeout-only interruption.
- Fail closed when a translated provider ends without a terminal event.
- Add deterministic V2 coverage for the route classes used by Grok, Kimi, DeepSeek, and
  native OpenAI, plus an opt-in live conformance matrix.
- Preserve provider-specific behavior, stream integrity, unrelated numeric values, dirty
  worktree changes, and the currently working native Responses path.

## Non-goals

- Do not make `wait_agent` wake on child commentary. That would change native mailbox
  semantics and create wake storms.
- Do not route Grok OAuth through Responses. Upstream reverted that experiment because
  opaque reasoning continuation and compaction state could not be replayed safely.
- Do not enable graceful tool-call EOF recovery for xAI without a captured xAI EOF
  reproduction. The existing upstream tolerance was intentionally scoped to OpenCode Go.
- Do not rewrite native Responses payloads speculatively. There is no captured native
  Responses integer-float failure.
- Do not claim CCX can repair Codex-native reasoning-effort drift until its ownership is
  reproduced outside the child `turn_context`.

## Design

### 1. Schema-aware tool-argument canonicalization

The Responses bridge will receive a request-scoped map from each request-visible tool name
to its declared parameter schema. At both translated-provider output boundaries—streaming
tool-call finalization and buffered response construction—it will parse completed argument
objects and canonicalize only values whose integer intent is unambiguous.

Rules:

- A value such as `120000.0` or `1.2e5` may become `120000` only when it is finite, exactly
  integral, and within JavaScript's safe-integer range.
- A schema-declared `integer` authorizes the repair.
- The known Codex-native `timeout_ms` mismatch also authorizes the repair when its schema
  declares a numeric type, because Codex advertises a number but deserializes a `u64`.
- Fractional values, malformed/incomplete JSON, string-typed fields, unrelated numeric
  fields, and values outside the safe-integer range remain byte-for-byte unchanged.
- `$ref`, composition keywords, nested objects, arrays, and `additionalProperties` are
  handled conservatively with bounded recursion.
- Unchanged argument strings retain their original bytes. Re-serialization occurs only
  after an authorized repair.

The current adapter-local `canonicalizeWaitAgentTimeout` patch is retained until bridge
tests are red and the shared implementation is green. It is then removed so there is one
normalization boundary for every translated provider and for both streaming and buffered
responses.

### 2. Wait and interruption semantics

The managed CodexCommander delegation skill will distinguish a bounded wait call from a
hard task deadline:

- `wait_agent` timeout means only that no qualifying parent-mailbox event arrived during
  that subscription window.
- After timeout, the coordinator reconciles with `list_agents` and continues useful local
  work or another 5–10 minute wait.
- A running child must never be interrupted solely because one or more waits timed out.
- Interruption requires an explicit user cancellation, an explicit task deadline that was
  communicated to the child, a confirmed error/blocked state, or a deliberate replacement
  after preserving available work.
- A bounded high-stakes gate should request one explicit `send_message` checkpoint or a
  durable partial artifact. Internal commentary is not a progress mailbox event.
- A conclude message is advisory and may be delivered only at the next model boundary; it
  is not proof that a child has stopped.

Source skill, packaged skill, installed managed skill, AGENTS template, and user-facing docs
must remain synchronized through the existing generation/install flow rather than manual
post-build edits.

### 3. Terminal fail-closed safeguards

The branch will port the upstream invariant that a buffered translated-provider turn with
no `done`, `error`, or `incomplete` adapter event is `incomplete` with
`reason: "adapter_eof"`. An open tool call on such a turn is incomplete, never completed.

The streaming path already fails closed on adapter EOF and will receive regression coverage
to keep streaming and buffered results aligned. Provider-specific graceful EOF recovery will
remain opt-in and will not be enabled for xAI without a live reproduction proving a complete
tool call followed by terminal-less EOF.

### 4. V2 provider conformance

Deterministic tests will cover four route classes, not merely model labels:

1. xAI/Grok translated Chat Completions.
2. Kimi translated Chat Completions through the same shared bridge.
3. DeepSeek V4 bounded Responses JSON with synthesized terminal events.
4. Native OpenAI Responses passthrough.

Each applicable route must prove namespace preservation, a completed collaboration tool
call, valid integer arguments, terminal classification, final-answer delivery, and no
mutation of unrelated numeric fields. Synthetic fixtures remain the required CI gate.

An opt-in live matrix will use configured credentials and hard per-model budgets. It will
exercise a minimal tool round followed by a final answer and record only sanitized route,
status, timing, and terminal evidence. It will not run in ordinary CI, mutate product data,
or treat model response wording as an assertion.

### 5. Reasoning-effort drift

The observed `xhigh` to `high` change appeared in Codex's resumed child `turn_context`,
upstream of CCX response translation. The implementation phase will add a narrow
characterization probe. CCX code changes are allowed only if the drift can be reproduced at
a CCX-owned boundary; otherwise the result is documented as an upstream Codex issue with the
sanitized reproduction.

## Sequencing and ownership

The existing task `01a03933-e79f-7b80-8369-afb27ac3a64c` owns only its already-completed
guidance/lifecycle bundle (`7a2974904`) and live app replacement. This focused task owns all
work described by this design. No third task is needed.

The existing uncommitted OpenAI Chat timeout normalization and its focused tests are
preserved as the starting reproduction. Unrelated dirty and untracked files are never
staged, reverted, or incorporated.

Implementation order:

1. Shared schema-aware integer normalization, test-first.
2. Managed delegation wait semantics, using the writing-skills workflow.
3. Buffered terminal fail-closed invariant.
4. Deterministic route-class conformance tests.
5. Opt-in live matrix and reasoning-effort characterization.
6. Full verification and packaged-runtime rebuild.

## Acceptance criteria

- Grok/Kimi Chat output containing integral-float `timeout_ms` reaches Codex as an integer.
- Fractional and unrelated numeric arguments remain unchanged.
- Streaming and buffered translated responses have identical repair and EOF semantics.
- A terminal-less buffered turn cannot be reported completed.
- Managed guidance explicitly forbids interpreting wait timeout as child failure.
- Deterministic V2 route-class tests pass for Chat, bounded Responses, and native Responses.
- The opt-in live matrix completes one tool/final cycle for every configured target or
  reports a sanitized provider-specific failure without hanging.
- `bun run typecheck`, focused suites, `bun run test:parallel`, GUI/docs checks when touched,
  and `bun run privacy:scan` pass.
- The packaged macOS runtime contains the verified source and the existing task's live
  replacement remains recoverable.


# Grok and V2 Collaboration Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Grok and every V2 route class deliver valid collaboration tool calls and truthful terminal states without changing native mailbox semantics or provider routing.

**Architecture:** Move integral-float repair out of the xAI/OpenAI-Chat adapter and into the shared AdapterEvent-to-Responses bridge, authorized by each request's tool schemas at streaming and buffered finalization. Make terminal-less buffered turns fail closed, then synchronize the managed delegation skill with the actual mailbox/interruption lifecycle and cover Chat, bounded Responses, and native Responses routes with deterministic fixtures.

**Tech Stack:** Bun-native TypeScript, Bun test, JSON Schema subsets, OpenAI Responses SSE/JSON, CodexCommander managed skill/template installer, Astro documentation.

**Spec:** `docs/superpowers/specs/2026-08-25-grok-v2-collaboration-hardening-design.md`

## Global Constraints

- Preserve the unrelated untracked `.lavish/`, `output/`, and 2026-08-24 plan/spec files.
- Preserve the existing OpenAI Chat timeout patch until shared bridge tests fail for the missing boundary; remove it only after the shared implementation passes.
- Canonicalize only finite, exactly integral, safe-integer JSON numbers authorized by a schema-declared `integer`, or `timeout_ms` under a numeric schema.
- Leave fractional, malformed, incomplete, string-typed, unrelated numeric, unsafe-integer, and schema-less arguments byte-for-byte unchanged.
- Do not wake `wait_agent` on child commentary, route xAI OAuth through Responses, enable xAI graceful EOF recovery, or rewrite native Responses payloads.
- Do not patch CCX for `xhigh` to `high` drift unless a CCX-owned request or response boundary reproduces it.
- Use focused tests and `bun run typecheck` during implementation. Per the user's explicit request, do not run the long full `bun run test:parallel` gate in this session; record it as deferred before merge.
- Do not restart the packaged live proxy until focused verification and the macOS package build both succeed.

---

### Task 1: Shared schema-aware integer argument canonicalizer

**Files:**
- Create: `src/lib/tool-argument-integers.ts`
- Create: `tests/tool-argument-integers.test.ts`

**Interfaces:**
- Consumes: completed JSON tool argument text and a request-supplied JSON Schema parameter object.
- Produces: `coerceIntegerToolArguments(args: string, parameters: Record<string, unknown> | undefined): string`.
- Invariant: the returned text is byte-for-byte identical unless at least one authorized representation repair occurs.

- [ ] **Step 1: Write the direct failing unit tests**

Create table-driven tests with these exact cases:

```ts
import { describe, expect, test } from "bun:test";
import { coerceIntegerToolArguments } from "../src/lib/tool-argument-integers";

const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
});

describe("coerceIntegerToolArguments", () => {
  test("repairs integral floats only when integer intent is declared", () => {
    expect(coerceIntegerToolArguments(
      '{"count":50.0}',
      objectSchema({ count: { type: "integer" } }),
    )).toBe('{"count":50}');
    expect(coerceIntegerToolArguments(
      '{"count":1.2e5}',
      objectSchema({ count: { type: "integer" } }),
    )).toBe('{"count":120000}');
  });

  test("repairs Codex timeout_ms under its advertised numeric schema", () => {
    expect(coerceIntegerToolArguments(
      '{"timeout_ms":300000.0}',
      objectSchema({ timeout_ms: { type: "number" } }),
    )).toBe('{"timeout_ms":300000}');
  });

  test.each([
    ['{"timeout_ms":300000.5}', objectSchema({ timeout_ms: { type: "number" } })],
    ['{"temperature":1.0}', objectSchema({ temperature: { type: "number" } })],
    ['{"count":1.0}', undefined],
    ['{"count":9007199254740993.0}', objectSchema({ count: { type: "integer" } })],
    ['{"count":1.0', objectSchema({ count: { type: "integer" } })],
  ])("leaves unauthorized or unsafe input unchanged", (args, schema) => {
    expect(coerceIntegerToolArguments(args, schema)).toBe(args);
  });
});
```

Add separate assertions for nested objects, arrays, `additionalProperties`, `#/$defs` JSON Pointer unescaping, `anyOf`/`oneOf`/`allOf`, cyclic refs, and depth greater than 64. A composition branch authorizes repair only when the branch itself declares the applicable numeric intent.

- [ ] **Step 2: Run the unit test to verify RED**

Run: `bun test tests/tool-argument-integers.test.ts`

Expected: FAIL because `src/lib/tool-argument-integers.ts` does not exist.

- [ ] **Step 3: Implement the bounded schema walker**

Implement these private units in `src/lib/tool-argument-integers.ts`:

```ts
type SchemaNode = Record<string, unknown>;
interface CoerceResult { value: unknown; changed: boolean }

function asSchema(value: unknown): SchemaNode | undefined;
function declaresInteger(schema: SchemaNode): boolean;
function declaresNumeric(schema: SchemaNode): boolean;
function resolveRef(schema: SchemaNode, root: SchemaNode, seen: Set<string>): SchemaNode | undefined;
function compositionBranches(schema: SchemaNode): SchemaNode[];
function safelyIntegral(value: number): boolean;
function coerceValue(
  value: unknown,
  schema: SchemaNode | undefined,
  root: SchemaNode,
  depth: number,
  propertyName?: string,
): CoerceResult;
```

Use `depth > 64` as the recursion stop, same-document `#/...` refs only, `Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER`, and `const U64_NUMBER_FIELDS = new Set(["timeout_ms"])`. Pass a property name only for object properties, never inherited into array items. The cheap rejection path must still admit exponent forms such as `120000e0`; parse when the argument string contains `.` or `e`/`E`. Parse once, return original bytes on parse failure or `changed === false`, and call `JSON.stringify` only for `changed === true`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun test tests/tool-argument-integers.test.ts && bun run typecheck`

Expected: all canonicalizer tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the isolated canonicalizer**

```bash
git add src/lib/tool-argument-integers.ts tests/tool-argument-integers.test.ts
git commit -m "fix: canonicalize schema-declared integer arguments"
```

### Task 2: Propagate schemas through every translated Responses bridge

**Files:**
- Modify: `src/server/responses/collaboration.ts`
- Modify: `src/bridge.ts`
- Modify: `src/server/responses/core.ts`
- Modify: `src/web-search/loop.ts`
- Modify: `src/images/loop.ts`
- Modify: `src/adapters/openai-chat.ts`
- Modify: `tests/openai-chat-hardening.test.ts`
- Modify: `tests/openai-chat-parallel-stream.test.ts`
- Create: `tests/bridge-tool-argument-integers.test.ts`

**Interfaces:**
- Consumes: `coerceIntegerToolArguments` from Task 1 and request tools in `buildToolBridgeMaps(tools)`.
- Produces: `toolParameterSchemas: ReadonlyMap<string, Record<string, unknown>>` alongside the existing namespace/freeform maps.
- Produces: optional `toolParameterSchemas` in bridge, image-loop, and web-search-loop option/dependency types.

- [ ] **Step 1: Write bridge-level RED tests that bypass the adapter patch**

Create an async event source and feed these events directly to both bridge surfaces:

```ts
const events: AdapterEvent[] = [
  { type: "tool_call_start", id: "call_1", name: "collaboration__wait_agent" },
  { type: "tool_call_delta", arguments: '{"timeout_ms":300000.0}' },
  { type: "tool_call_end", id: "call_1" },
  { type: "done" },
];
const schemas = new Map([
  ["collaboration__wait_agent", {
    type: "object",
    properties: { timeout_ms: { type: "number" } },
  }],
]);
```

Assert `buildResponseJSON(events, model, { toolParameterSchemas: schemas })` returns the function-call argument string `{"timeout_ms":300000}`. Assert `bridgeToResponsesSSE(source(events), model, { toolParameterSchemas: schemas })` emits that same string in `response.function_call_arguments.done` and the completed function-call item. Also assert no schema, `300000.5`, and unrelated `temperature:1.0` preserve the original argument bytes.

- [ ] **Step 2: Run bridge tests to verify RED**

Run: `bun test tests/bridge-tool-argument-integers.test.ts`

Expected: FAIL because the bridge options do not accept or apply `toolParameterSchemas`.

- [ ] **Step 3: Add request-visible schema mapping**

Extend `buildToolBridgeMaps` to return:

```ts
toolParameterSchemas: ReadonlyMap<string, Record<string, unknown>>;
```

For every request tool with object `parameters`, store the same schema under its request-visible wire name (`namespacedToolName(namespace, name)`) and the compatible bare name already recognized by the namespace map. Do not clone or mutate schemas.

- [ ] **Step 4: Apply canonicalization at the two shared finalization points**

Add this option to both `bridgeToResponsesSSE` and `buildResponseJSON`/`buildResponseJSONWithBudget`:

```ts
toolParameterSchemas?: ReadonlyMap<string, Record<string, unknown>>;
```

Immediately before emitting a completed argument string in streaming `closeCurrentToolCall` and buffered `flushToolCall`, run:

```ts
currentToolArgs = coerceIntegerToolArguments(
  currentToolArgs,
  options?.toolParameterSchemas?.get(currentToolName),
);
```

Perform this only after all deltas are assembled. Namespace restoration and freeform-tool handling must keep their current order and behavior.

- [ ] **Step 5: Pass schemas through all bridge call sites**

Destructure `toolParameterSchemas` with the existing maps in `src/server/responses/core.ts` and pass it to every streaming and buffered bridge call. Add optional dependency fields to the image and web-search loops and pass the same request-scoped map from core into those sidecar bridge calls. Keep the new fields optional so existing loop fixtures remain source-compatible.

- [ ] **Step 6: Remove the adapter-local workaround after GREEN**

Delete `canonicalizeWaitAgentTimeout` and its two calls from `src/adapters/openai-chat.ts`. Remove only the adapter-local integral-float assertions from `tests/openai-chat-hardening.test.ts` and `tests/openai-chat-parallel-stream.test.ts`; retain the malformed-EOF regression and all unrelated existing tests. The new bridge suite becomes the single ownership point.

- [ ] **Step 7: Run focused bridge and adapter tests**

Run:

```bash
bun test tests/tool-argument-integers.test.ts tests/bridge-tool-argument-integers.test.ts tests/bridge.test.ts tests/openai-chat-hardening.test.ts tests/openai-chat-parallel-stream.test.ts tests/web-search-loop.test.ts tests/images-loop.test.ts
bun run typecheck
```

Expected: all listed suites pass; the tracked OpenAI Chat diff no longer contains `canonicalizeWaitAgentTimeout`.

- [ ] **Step 8: Commit the shared boundary migration**

```bash
git add src/server/responses/collaboration.ts src/bridge.ts src/server/responses/core.ts src/web-search/loop.ts src/images/loop.ts src/adapters/openai-chat.ts tests/bridge-tool-argument-integers.test.ts tests/openai-chat-hardening.test.ts tests/openai-chat-parallel-stream.test.ts
git commit -m "fix: normalize integer arguments at the Responses bridge"
```

### Task 3: Fail closed on buffered adapter EOF

**Files:**
- Modify: `src/bridge.ts`
- Create: `tests/bridge-nonstreaming-terminal.test.ts`

**Interfaces:**
- Consumes: buffered `AdapterEvent[]` and existing `buildResponseJSON` options.
- Produces: `status: "incomplete"` plus `incomplete_details.reason: "adapter_eof"` when no `done`, `error`, or `incomplete` event exists.
- Invariant: terminal-less compaction text is never emitted as a replacement-history `compaction` item.

- [ ] **Step 1: Write buffered/streaming parity RED tests**

Cover exactly these event sequences:

```ts
[{ type: "text", text: "partial answer" }]
[
  { type: "tool_call_start", id: "call_1", name: "js" },
  { type: "tool_call_delta", arguments: '{"code":"tru' },
]
[{ type: "text", text: "answer" }, { type: "done" }]
[{ type: "text", text: "partial" }, { type: "error", message: "upstream failed" }]
[{ type: "text", text: "partial" }, { type: "incomplete", reason: "max_output_tokens" }]
```

Assert the first two are buffered `incomplete/adapter_eof`, the open function call is `incomplete`, and streaming emits only `response.incomplete`. Assert the explicit terminal outcomes remain completed/failed/incomplete. With `{ compaction: true }`, assert terminal-less output has no compaction item, explicit `done` does, and explicit error/incomplete do not.

- [ ] **Step 2: Run terminal tests to verify RED**

Run: `bun test tests/bridge-nonstreaming-terminal.test.ts`

Expected: FAIL because buffered no-terminal events currently default to completed and can emit compaction.

- [ ] **Step 3: Add one terminal-state invariant**

Inside `buildResponseJSONWithBudget`, initialize `let sawTerminal = false`; set it for `done`, `error`, and `incomplete`. Flush an open tool call as incomplete when `!sawTerminal`. Return response status incomplete and reason `adapter_eof` when no terminal exists. Require `sawTerminal` in the compaction-emission guard. Do not broaden any provider-specific EOF recovery.

- [ ] **Step 4: Run terminal and existing bridge tests**

Run: `bun test tests/bridge-nonstreaming-terminal.test.ts tests/bridge.test.ts && bun run typecheck`

Expected: all tests pass; explicit terminal reasons are unchanged.

- [ ] **Step 5: Commit EOF handling**

```bash
git add src/bridge.ts tests/bridge-nonstreaming-terminal.test.ts
git commit -m "fix: fail closed on buffered adapter EOF"
```

### Task 4: Correct managed wait and interruption semantics

**Files:**
- Modify: `src/skills/codexcommander-delegation/SKILL.md`
- Modify: `src/codex/delegation-templates.ts`
- Modify: `tests/codex-delegation-templates.test.ts`
- Modify: `tests/codex-delegation-installer.test.ts`
- Modify: `tests/codex-delegation-api.test.ts`
- Modify: `structure/02_config-and-codex-home.md`
- Modify: `docs-site/src/content/docs/guides/sub-agent-surface.md`
- Modify: `docs-site/src/content/docs/configuration/agents.md`

**Interfaces:**
- Consumes: the canonical managed skill and marker-owned AGENTS block.
- Produces: byte-identical canonical, previewed, installed, and packaged skill content through `renderCodexDelegationBundle` and the existing atomic installer.
- Behavioral contract: a wait timeout is a neutral subscription result; timeout alone never authorizes interruption.

- [ ] **Step 1: Use the writing-skills RED pressure test**

Read `superpowers:writing-skills` and its referenced `testing-skills-with-subagents.md` in full. In gitignored `.tmp/`, create a pressure scenario that gives a coordinator a running child, a short `wait_agent` timeout, a long task estimate, and the temptation to call `interrupt_agent`. Run the scenario against the pre-change skill text and record whether it interrupts or declares the child unresponsive solely from timeout. Do not put incident details or model outputs in tracked files.

- [ ] **Step 2: Update the canonical skill and generated AGENTS guidance**

Teach these operational rules in the canonical skill:

```text
- A `wait_agent` timeout means only that no qualifying mailbox/final event arrived during that subscription window; it is not child failure evidence.
- After timeout, reconcile once with `list_agents`, continue useful local work, or wait again for 5–10 minutes.
- Never interrupt a running child solely because one or more waits timed out.
- Interrupt only for explicit user cancellation, a communicated hard deadline, confirmed error/blocked state, or deliberate replacement after preserving work.
- For a bounded high-stakes gate, request one explicit `send_message` checkpoint or durable partial artifact; private commentary does not wake the parent mailbox.
- A conclude message is advisory and is delivered at a model/tool boundary; it is not proof that the child stopped.
```

Keep the AGENTS marker block concise: point to the managed skill and state the neutral-timeout/no-timeout-only-interrupt invariant. Do not duplicate the whole skill.

- [ ] **Step 3: Replace brittle wording assertions with lifecycle invariants**

Update template tests to prove:

```ts
expect(bundle.skill).toBe(canonicalSkillSource);
expect(bundle.agentsBlock).toContain("wait_agent");
expect(bundle.agentsBlock).toMatch(/timeout/i);
expect(bundle.agentsBlock).toMatch(/interrupt/i);
```

Keep existing ownership-marker and copy-prompt checks. Installer/API tests must prove preview and installed bytes equal `renderCodexDelegationBundle`, not merely duplicate selected prose.

- [ ] **Step 4: Run the GREEN pressure test and validate the skill**

Repeat the same pressure scenario with the changed skill and confirm the coordinator reconciles/waits rather than interrupting on timeout. Run the skill validator from the available skill-creator package against `src/skills/codexcommander-delegation`, then run:

```bash
bun test tests/codex-delegation-templates.test.ts tests/codex-delegation-installer.test.ts tests/codex-delegation-api.test.ts
bun run typecheck
```

Expected: pressure behavior follows the lifecycle contract; validator and focused tests pass.

- [ ] **Step 5: Synchronize source-of-truth and user docs**

Add a concise wait lifecycle section to `structure/02_config-and-codex-home.md` and user-facing explanations to the two docs-site pages. State that updates flow canonical source → render → atomic install/package; never instruct users to edit `~/.agents` or `dist` manually.

- [ ] **Step 6: Commit managed guidance**

```bash
git add src/skills/codexcommander-delegation/SKILL.md src/codex/delegation-templates.ts tests/codex-delegation-templates.test.ts tests/codex-delegation-installer.test.ts tests/codex-delegation-api.test.ts structure/02_config-and-codex-home.md docs-site/src/content/docs/guides/sub-agent-surface.md docs-site/src/content/docs/configuration/agents.md
git commit -m "fix: make delegation waits lifecycle-safe"
```

### Task 5: Deterministic V2 route-class conformance

**Files:**
- Create: `tests/v2-provider-conformance.test.ts`

**Interfaces:**
- Consumes: mocked `fetch`, provider registry/configuration, the V2 `/responses` handler, and one collaboration tool schema with numeric `timeout_ms`.
- Produces: a deterministic route-class matrix with no external credentials and no response-wording assertions.

- [ ] **Step 1: Write the mocked route matrix**

Use the existing helpers from `tests/v2-plaintext-collaboration.test.ts`, `tests/deepseek-inbound-wire.test.ts`, and `tests/openai-responses-passthrough.test.ts` to exercise:

```ts
const routeCases = [
  { label: "xAI Chat", adapter: "openai-chat", terminal: "stream-done" },
  { label: "Kimi Chat", adapter: "openai-chat", terminal: "stream-done" },
  { label: "DeepSeek V4 bounded Responses", adapter: "openai-responses", terminal: "synthesized-done" },
  { label: "native OpenAI Responses", adapter: "openai-responses", terminal: "passthrough" },
] as const;
```

For the translated classes, mock one `collaboration__wait_agent` call followed by a final answer and assert namespace preservation, integer `timeout_ms`, completed function-call item, truthful response terminal, and preserved unrelated numeric fields. For native OpenAI, assert the request/response bodies remain passthrough-equivalent; do not invent a native float rewrite.

- [ ] **Step 2: Run the route matrix to establish RED or coverage GREEN**

Run: `bun test tests/v2-provider-conformance.test.ts`

Expected before Tasks 1–3: Chat integral-float or buffered-terminal assertions fail. Expected after Tasks 1–3: all matrix rows pass.

- [ ] **Step 3: Diagnose any route-matrix regression at its owning task**

If a row fails, classify it as registry selection, adapter event synthesis, bridge translation, or passthrough mutation. Return bridge failures to Task 2 or terminal failures to Task 3 and add the exact failing fixture there. Keep Task 5 test-only and do not alter provider routing to make a fixture pass.

- [ ] **Step 4: Run focused route and boundary suites**

Run:

```bash
bun test tests/v2-provider-conformance.test.ts tests/v2-plaintext-collaboration.test.ts tests/deepseek-inbound-wire.test.ts tests/openai-responses-passthrough.test.ts
bun run typecheck
```

Expected: all route classes pass without network access.

- [ ] **Step 5: Commit deterministic conformance**

```bash
git add tests/v2-provider-conformance.test.ts
git commit -m "test: cover V2 provider collaboration routes"
```

### Task 6: Opt-in live probe, ownership characterization, and bounded verification

**Files:**
- Create: `tests/e2e-style/live-v2-provider-conformance.test.ts`
- Modify: `docs/superpowers/specs/2026-08-25-grok-v2-collaboration-hardening-design.md`
- Inspect/package only: `scripts/build-macos-app.sh`, `scripts/package-macos-release.sh`

**Interfaces:**
- Consumes: explicit `CCX_LIVE_V2_CONFORMANCE=1`, existing configured provider credentials, and a hard per-model timeout.
- Produces: sanitized `{ route, status, elapsedMs, toolTerminal, responseTerminal }` evidence only; skipped by default.

- [ ] **Step 1: Add a default-skipped live matrix**

Gate the suite as follows:

```ts
const liveEnabled = process.env.CCX_LIVE_V2_CONFORMANCE === "1";
const liveTest = liveEnabled ? test : test.skip;
```

For each configured Grok, Kimi, DeepSeek, and native OpenAI target, use an abort deadline no greater than 120 seconds, request one collaboration tool call and a final answer, and log only route class, terminal status, elapsed milliseconds, and whether the expected tool/response terminal appeared. Never log prompts, bodies, tokens, API keys, account identifiers, or model prose.

- [ ] **Step 2: Characterize reasoning-effort ownership without a CCX mutation**

Inspect ingress request reasoning effort, `src/server/effort-policy.ts`, provider-wire mapping in `src/reasoning-effort.ts`, and egress metadata for one child continuation. Record in the approved design's “Reasoning-effort drift” section whether CCX changed the value. If ingress already contains `high` after a prior `xhigh`, document that the drift is upstream Codex-native and make no runtime change. Add a CCX regression test only if CCX transforms the value unexpectedly.

- [ ] **Step 3: Run the bounded implementation gate**

Run:

```bash
bun test tests/tool-argument-integers.test.ts tests/bridge-tool-argument-integers.test.ts tests/bridge-nonstreaming-terminal.test.ts tests/v2-provider-conformance.test.ts tests/codex-delegation-templates.test.ts tests/codex-delegation-installer.test.ts tests/codex-delegation-api.test.ts
bun run typecheck
bun run privacy:scan
```

Expected: all focused tests, typecheck, and privacy scan pass. Do not run `bun run test:parallel` in this session; list it explicitly as the deferred merge gate.

- [ ] **Step 4: Build and inspect the packaged macOS runtime**

Run the repository's existing macOS build/package command from `scripts/build-macos-app.sh` or the documented package entry point. Verify the packaged source includes `src/lib/tool-argument-integers.ts`, the canonical managed skill, and the bridge changes. Do not edit generated package output by hand.

- [ ] **Step 5: Restart only after package verification**

Record the current healthy proxy PID/port before replacement. Use the existing managed app lifecycle to replace it, verify `/healthz`, and confirm exactly one managed listener owns port 10100. If build or health verification fails, keep or restore the previously healthy runtime.

- [ ] **Step 6: Commit probe and characterization**

```bash
git add tests/e2e-style/live-v2-provider-conformance.test.ts docs/superpowers/specs/2026-08-25-grok-v2-collaboration-hardening-design.md
git commit -m "test: add opt-in V2 provider conformance probe"
```

- [ ] **Step 7: Handoff the deferred long gate**

Report the exact focused commands and results, package/health evidence, and this required pre-merge command:

```bash
bun run test:parallel
```

Do not claim the branch is merge-ready until that deferred full suite passes.

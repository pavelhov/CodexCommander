# 030 — Provider-aware plaintext delivery for Multi-Agent V2

Status: SUPERSEDED FOR PRODUCT DELIVERY BY `031_product_owned_plaintext_v2.md`

Owner: WS-03
Scope: retained upstream design reference; no upstream submission planned

> OpenCodex now owns an opt-in compatibility shim using Codex 0.147's
> `DirectPlaintextMessage` receiving path. The broader provider-edge contract
> below remains the cleaner upstream architecture, but it is no longer a
> dependency for this product branch.

## Summary

Multi-Agent V2 currently uses an OpenAI-specific `agent_message` representation
for inter-agent communication. On a route from an OpenAI parent to a child
whose resolved provider is non-OpenAI, the child can receive only
`encrypted_content`, or a plaintext `agent_message` item that the external
Responses provider does not understand. The result is either an unreadable
assignment or a provider rejection before the child can run.

The fix should be provider-aware at each inter-agent edge:

- preserve the current encrypted delivery for providers that explicitly
  support it (initially the OpenAI provider);
- deliver a bounded, ordinary Responses `message` item with plaintext
  `input_text` at a provider boundary that does not support encrypted
  `agent_message`; and
- keep the V2 tree, identity, mailbox, wait, follow-up, and completion
  semantics unchanged.

This requires a contract between the ChatGPT/backend/schema layer and
`codex-rs`. A client-only patch cannot safely recover plaintext from an opaque
encrypted tool argument, and OpenCodex must not attempt to become a decryption
or re-encryption service.

## Evidence and current implementation

Issue [openai/codex#34833](https://github.com/openai/codex/issues/34833)
reproduces an OpenAI parent spawning a correctly configured non-OpenAI child:
the child role, provider, model, and V2 metadata are correct, but the handoff
contains only encrypted content. The same-provider OpenAI control succeeds.

Issue [openai/codex#33551](https://github.com/openai/codex/issues/33551) shows a
second, independent boundary: external Responses providers reject the
OpenAI-specific `agent_message` item even when its text is plaintext. A
standard Responses item is required:

```json
{
  "type": "message",
  "role": "user",
  "content": [{ "type": "input_text", "text": "..." }]
}
```

Issue [openai/codex#28058](https://github.com/openai/codex/issues/28058) is a
related but separate auditability requirement. Encrypted delivery must not
erase the readable task/message from local structured audit surfaces. It does
not justify putting an audit copy into the model-facing encrypted payload.

The current `codex-rs` main implementation has the relevant seams:

- [`multi_agents_spec.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
  marks V2 `spawn_agent`, `send_message`, and `followup_task` message arguments
  as encrypted;
- [`multi_agents_v2.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2.rs)
  builds `InterAgentCommunication` and routes the V2 handlers;
- [`protocol.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
  stores either `content` or `encrypted_content`, then currently emits an
  `ResponseItem::AgentMessage` from `to_model_input_item()`; and
- [`client.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)
  already knows the resolved provider at the final Responses request boundary,
  but its non-OpenAI cleanup only removes encrypted function arguments. It does
  not translate `agent_message` into a standard `message` item.

## Proposed contract

### 1. Make delivery mode explicit and edge-scoped

Introduce a protocol-level delivery decision for each communication edge, not
one mode for the whole root task:

```text
encrypted_agent_message   // existing OpenAI-compatible path
plaintext_message         // standard Responses message/input_text
unsupported               // fail before provider dispatch
```

The decision must use the actual resolved caller and recipient provider
identities and wire capabilities. Do not infer it from a model slug, a model
family prefix, or the root task's provider alone.

At minimum, the capability model needs to distinguish:

- support for encrypted `agent_message` content;
- support for the standard Responses `message`/`input_text` shape; and
- whether the provider is using Responses or another wire API.

Unknown external capabilities should fail closed with an actionable
unsupported-delivery error. They must not silently receive ciphertext or an
OpenAI-only item type.

The first implementation can conservatively define OpenAI as supporting the
encrypted path and generic external Responses providers as requiring
`plaintext_message`. A provider registry or explicit negotiated capability is
preferable to endpoint-name heuristics. Chat Completions providers need a
separate, explicit adapter mapping; this proposal does not assume that a
Responses `message` item can be sent directly to a Chat Completions endpoint.

### 2. Keep plaintext authority outside a client-only workaround

The current encrypted tool schema can leave `codex-rs` with an opaque payload
and no decryption key. Therefore one of these upstream contracts is required
before `codex-rs` can safely deliver plaintext to an external provider:

1. The ChatGPT/backend layer exposes the canonical plaintext tool argument to
   the trusted Codex runtime through a new internal, authenticated field while
   retaining the encrypted model-facing field; or
2. The backend performs the provider-boundary conversion itself and gives
   `codex-rs` a typed result that records the selected delivery mode and the
   canonical communication metadata.

The contract must make clear that plaintext is available only to the trusted
runtime for an explicitly selected non-OpenAI boundary. It must not make the
encrypted blob decryptable by arbitrary providers, clients, hooks, or local
files. A missing plaintext value on a boundary that requires it is a
deterministic unsupported-delivery error, not an invitation to guess or
recover it.

### 3. Translate only at the final provider boundary

Keep `InterAgentCommunication` as the canonical lifecycle record. Add a typed
delivery representation or an equivalent conversion helper so that the final
request builder can do the following:

- OpenAI-compatible recipient: preserve `ResponseItem::AgentMessage` with its
  existing encrypted content and metadata;
- non-OpenAI Responses recipient: emit one ordinary user `message` item with
  the canonical plaintext as `input_text`; and
- unsupported recipient: return a clear error before an upstream request is
  sent.

The conversion must not mutate the parent history into a different protocol,
remove the agent path, or duplicate the communication in both an
`agent_message` and a `message` item. Audit metadata is separate from
model-facing input.

## Coverage of every V2 communication direction

The provider-aware decision and plaintext contract must cover all four
communication classes:

1. **`spawn_agent` initial task** — `trigger_turn = true`, `NEW_TASK` semantics,
   child path allocation, fork/call correlation, and child startup must remain
   unchanged.
2. **`send_message`** — queued `MESSAGE` delivery must retain ordering,
   recipient identity, and no-turn-trigger behavior.
3. **`followup_task`** — `MESSAGE` delivery with a triggered child turn must
   preserve idle/running behavior, pending-boundary delivery, and the existing
   follow-up result.
4. **Child return messages** — return content sent from a child to its parent
   must use the same edge-scoped capability decision. A non-OpenAI child must
   be able to return a standard plaintext message to an OpenAI parent without
   changing the parent/child V2 protocol or fabricating encrypted content.

`wait_agent`, interruption, close, and list/status operations do not carry the
delegated text themselves, but their task IDs and state transitions must remain
correlated with the translated communication.

## V2 invariants that must not change

Provider-aware plaintext delivery is a wire representation change, not a new
orchestration engine. The implementation must preserve:

- the root-selected V2 version for the entire agent tree;
- canonical `AgentPath`, author, recipient, and other-recipient metadata;
- stable communication IDs and parent/child correlation;
- graph state, mailbox ordering, and serialized delivery;
- `trigger_turn`, `wait`, `followup_task`, interruption, and completion
  semantics;
- fork history and resume behavior; and
- existing OpenAI encrypted behavior.

An external child is not a V1 child. It remains a V2 participant whose
provider-facing task representation happens to be plaintext. No per-child
protocol downgrade is allowed.

## Auditability contract for #28058

The delivery representation and the audit representation should be separate
fields with explicit retention rules. For an encrypted OpenAI edge, preserve
encrypted delivery while retaining a bounded, structured audit copy only where
the backend/runtime contract authorizes it. For a plaintext external edge,
the canonical plaintext may serve as the delivery and audit value without
duplicating it into a synthetic `agent_message`.

Audit data must:

- never substitute ciphertext into a field named or presented as readable
  content;
- be bounded and validated before persistence;
- carry author, recipient, communication ID, and trigger kind separately from
  the text; and
- remain available across rollout/history, resume, and parent-side activity
  surfaces without changing model-facing input.

This proposal does not prescribe a particular storage schema. That schema
belongs in the upstream protocol/history review alongside #28058.

## Feature detection and rollout compatibility

The rollout must be capability-driven, not version-string-driven:

1. Land the backend/schema contract that can provide canonical plaintext or a
   typed provider-boundary conversion result.
2. Land `codex-rs` parsing and protocol types with an explicit delivery mode,
   while preserving the old encrypted default for OpenAI.
3. Add provider capability declarations and final-boundary translation for
   standard Responses providers.
4. Enable the external plaintext path behind an opt-in or server-advertised
   capability, then expand it after the integration matrix is green.
5. Keep old-client behavior safe: if a backend does not advertise the
   plaintext contract, retain encrypted OpenAI delivery and fail closed for an
   external route with a remediation message.

Feature detection should test the actual schema/capability support exposed by
the running backend. A newer `codex-rs` binary must not assume that an older
ChatGPT backend can supply plaintext, and an older binary must continue to
reject or preserve its existing behavior rather than receiving a new field it
cannot interpret.

## Upstream test plan

### Protocol and handler unit tests

- `InterAgentCommunication` conversion keeps encrypted `agent_message` for an
  OpenAI recipient and emits exactly one standard `message` item for a
  non-OpenAI Responses recipient.
- Missing plaintext on a required external edge returns a typed,
  non-dispatching error.
- `spawn_agent`, `send_message`, and `followup_task` all select the same
  delivery policy and preserve their distinct trigger/queue semantics.
- Child return messages use the reciprocal edge policy.
- Provider identity is taken from resolved provider metadata, not a model-name
  string or root-task default.

### Integration matrix

Run fresh V2 trees for:

| Parent | Child | Expected delivery |
| --- | --- | --- |
| OpenAI | OpenAI | encrypted `agent_message` (unchanged) |
| OpenAI | external Responses | plaintext standard `message` |
| external Responses | OpenAI | capability-selected reciprocal edge; no guessed decryption |
| external Responses | external Responses | plaintext standard `message` when both declare support |
| unknown/unsupported | any requiring plaintext | deterministic refusal before dispatch |

For each row, exercise initial spawn, queued send, follow-up, child return,
wait, completion, resume, and a provider error. Assert that task IDs, paths,
ordering, and V2 metadata are identical apart from the wire item shape.

### Compatibility and audit tests

- Old backend/no plaintext capability retains the current OpenAI encrypted path
  and gives a clear external-route error.
- New backend/old client does not cause ciphertext to be sent to a provider
  that requires plaintext.
- #28058 audit checks confirm readable metadata is persisted separately and
  ciphertext is never shown as readable task text.
- External Responses fixtures reject `agent_message` and encrypted content,
  proving that the test would fail if the final-boundary conversion regressed.

## Explicit non-solutions

The following are out of scope and must not be merged as compatibility fixes:

- **Fixed file inboxes:** unsafe under concurrency and stale-task reuse; they
  also create cleanup, attribution, and local instruction-injection hazards.
- **Guessed decryption:** `codex-rs` does not own the relevant key or trust
  boundary, so parsing or guessing ciphertext is neither reliable nor safe.
- **Proxy re-encryption:** OpenCodex cannot safely take custody of backend
  keys, and re-encrypting on behalf of another provider changes the security
  model and audit chain.
- **Per-child V1 downgrade:** V2 is selected by the root and inherited by the
  tree; silently changing one child loses V2 graph/wait/follow-up semantics and
  does not solve the provider contract.
- **Blanket `agent_message` rewriting:** it breaks the working OpenAI encrypted
  path, still fails providers that reject the item type, and can discard
  metadata required for correlation and lifecycle handling.

## Ownership split and acceptance criteria

### ChatGPT/backend/schema work (required before claiming support)

- define and authenticate the plaintext/capability contract;
- expose canonical task/message text to trusted Codex runtime or perform the
  provider-boundary conversion server-side;
- preserve encrypted OpenAI delivery and model-facing confidentiality;
- provide backend fixtures for encrypted and plaintext tool calls; and
- document rollout behavior for old/new backend and client combinations.

### `codex-rs` work

- add typed delivery mode/capability data to protocol and provider metadata;
- carry the canonical communication record through all four directions;
- translate only at the final Responses provider boundary;
- preserve V2 lifecycle and audit correlation; and
- fail closed with actionable errors when the contract is absent.

### Acceptance gate

Do not claim cross-provider V2 support until the fresh integration matrix passes
for OpenAI, at least one external Responses provider, and the relevant
parent/child direction combinations. Until then, OpenCodex should keep its
current fail-closed behavior and guide users to a fresh V1 task for external
providers.

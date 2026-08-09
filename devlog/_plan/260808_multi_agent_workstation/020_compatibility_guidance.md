# 020 — Compatibility-aware V2 guidance

Status: implemented on `codex/multi-agent-workstation` (runtime guidance only)

## Decision

Native ChatGPT/OpenAI forward parents can receive a V2 delegated task as
backend-encrypted `encrypted_content`. A routed child cannot consume that
ciphertext. The guidance path now receives the resolved parent capability and
filters only its automatic preferred model, roster, and fallback text to
candidate routes that resolve to canonical OpenAI forward providers. Candidate
resolution uses `routeModel(config, model)` and
`isCanonicalOpenAiForwardProvider`; it does not infer compatibility from model
names or maintain a second provider list.

The filter is guidance-only. It does not remove catalog entries, alter exact
model routing, rewrite requests, change native-only fallback selection, or
replace the existing `unreadable_encrypted_agent_task` guard. Explicit callers
can still request any exact model id and will receive the existing fail-closed
response if the resulting task is unreadable.

Mixed combos are not advertised to encrypted parents unless every concrete
combo target resolves to a canonical OpenAI forward route; otherwise a later
external failover could still receive the ciphertext.

Routed/plaintext-compatible parents continue to receive the configured roster
and fallback guidance. Stale/unknown catalog suppression remains before any
compatibility projection. V1 guidance remains the upstream Proactive text and
does not use the V2 filter.

## API/count seam

No new management/API compatibility summary was added in this workstream. The
five-model catalog roster and exact-id callability remain unchanged. If the
Agent Command Center needs a filtered count, it should derive that display from
the same resolved parent/candidate capability projection in a follow-up seam;
the runtime guidance API currently returns text, not a structured summary.

## Rejected unsafe alternatives

- Do not guess native compatibility from `gpt-*`, provider prefixes, or model
  names; aliases, account-qualified routes, combos, and custom providers make
  that unsound.
- Do not decrypt, strip, or proxy-re-encrypt Fernet payloads. OpenCodex does not
  hold the backend key and must preserve ciphertext byte-for-byte for native
  forwarding.
- Do not blanket-rewrite `agent_message` to `message`; native OpenAI delivery
  and encrypted same-provider behavior depend on the original wire type.
- Do not remove exact model ids from catalogs or routing. Filtering automatic
  guidance is a compatibility hint, not an authorization boundary.

## Verification

- `bun test tests/multi-agent-compat.test.ts` — 45 passed, 0 failed.
- `bun test tests/subagent-fallback-handle-responses.test.ts` — 27 passed, 0 failed.
- `bun run typecheck` — passed.
- Added coverage for native encrypted-parent filtering, incompatible custom
  preferred-model silence, routed/plaintext parent preservation, and V1
  guidance behavior.
- Full `bun run typecheck` is required before integration; no GUI, management,
  docs-site, app, or packaging files were changed by this workstream.

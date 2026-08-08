# 031 — Product-owned plaintext V2 compatibility

Status: INTEGRATED ON TARGET; REQUIRED TARGET RUNTIME GATE INCOMPLETE ON HOST TIMING

Branch: `codex/v2-plaintext-shim`
Base: `codex/multi-agent-workstation` at `0ca85586`
Scope: opt-in mixed-provider V2 parent compatibility; existing encrypted guard retained

## Decision

OpenCodex will own an experimental plaintext V2 compatibility mode instead of
waiting for, or submitting, an upstream change. It does not decrypt or
re-encrypt backend payloads.

The ChatGPT backend rejects a plaintext modification of its reserved
`collaboration` schema. The working contract is therefore bidirectional:

1. For a canonical native ChatGPT parent with the complete recognized V2
   schema, rename the entire namespace to `ocx_collaboration_plaintext` on the
   upstream wire.
2. Remove `encrypted: true` only from the `message` properties of
   `spawn_agent`, `send_message`, and `followup_task`.
3. Rewrite replayed collaboration function-call namespaces and tool selectors
   to the same wire alias.
4. Restore every returned alias namespace to `collaboration` across SSE and
   JSON responses.
5. Add `encrypted_function_args: []` only to the three plaintext message calls.
   Codex 0.147 classifies that exact shape as `DirectPlaintextMessage` and keeps
   its native V2 graph, mailbox, wait, follow-up, and completion lifecycle.
6. For routed parents (Kimi, Grok, DeepSeek, and other adapters), add the same
   marker at the bridge boundary to completed message calls only. This supports
   nested delegation without changing lifecycle or unrelated tool calls.

The transform is opt-in through:

```json
{
  "multiAgentV2MessageDelivery": "plaintext"
}
```

`"encrypted"` remains the default. A partial, future, malformed, or colliding
schema is not guessed: the rewrite does not activate, and the existing
`unreadable_encrypted_agent_task` guard remains authoritative.

Activation is capability-shaped rather than version-shaped. OpenCodex requires
the explicit plaintext policy, a canonical ChatGPT route, and the complete
recognized V2 collaboration schema before it aliases the native request. A
missing or changed contract leaves the encrypted path and fail-closed guard in
place, regardless of the reported Codex version.

## Privacy boundary

The parent chooses its tool schema before it chooses a worker. Plaintext mode
therefore applies to every V2 delegation message from that parent, including
native-to-native messages. The trusted local Codex runtime and OpenCodex proxy
necessarily handle that plaintext. OpenCodex suppresses upstream body samples
for these turns from its opt-in usage-debug persistence surface.

## Live proof

An ignored scratch proxy was placed in front of the running OpenCodex service.
No prompts, credentials, or bodies were logged.

- Bare marker removal under `collaboration` produced the expected ChatGPT 400:
  the reserved `collaboration.followup_task` schema no longer matched.
- Namespace alias + marker removal let a fresh Sol V2 parent create a Kimi K3
  child whose exact task was `V2_PLAINTEXT_OK`.
- Restoring only the three message tools proved why the full namespace must be
  restored: `wait_agent` arrived under the alias and Codex rejected it.
- Restoring the whole namespace produced a clean end-to-end run: Sol spawned
  Kimi, Kimi returned `WAIT_OK`, `wait_agent` completed with the child in the
  completed state, and the parent returned `WAIT_OK_RECEIVED`.

## Review findings

MoA excluded Codex to preserve ChatGPT allowance:

- Grok 4.5: success; endorsed proxy aliasing as an explicit experimental
  bridge, with whole-namespace restore, exact-value matching, replay coverage,
  stream/JSON composition, and fail-closed behavior.
- Kimi K3: success; independently concluded a patched binary would still need
  the same non-reserved namespace because the backend constraint is server-side.
  It emphasized idempotence, session stickiness, privacy disclosure, and no
  substring rewriting inside arguments.
- Fable/Claude: unavailable because the organization disabled Claude Code
  subscription access; no Sol replacement was used.

## Acceptance gates

- Pure request/response transform tests: complete/partial schemas, collision,
  copy-on-write, replay, tool choice, all lifecycle calls, sentinel allowlist,
  unexpected ciphertext, malformed JSON.
- `handleResponses` fake-upstream SSE test: aliased outbound body and restored
  added/done/completed items.
- Native bounded-JSON restore plus routed streaming/batch marker allowlist.
- Usage-debug metadata inspection stays active while body samples remain empty.
- Encrypted-mode negative control remains byte-semantic compatible.
- Management API and GUI persist the explicit delivery policy.
- Six GUI locales and all translated sub-agent/configuration docs stay aligned.
- Focused tests, typecheck, full runtime suite, GUI lint/i18n/build, docs build,
  and privacy scan pass before integration.
- Manual matrix after integration: Sol/Luna parents and Kimi/Grok/DeepSeek
  children, including spawn, wait, send, follow-up, and native encrypted control.

## Isolated source verification

- Focused runtime coverage: 107 tests passed across the plaintext transform and
  V2 management-policy suites.
- Full runtime coverage: all 602 repository test files passed in isolated
  one-file shards. Sustained host antivirus/system-policy load required a
  60-second timing allowance for the cold native-integration files; no
  assertion, fixture boundary, or test case was disabled.
- GUI: 713 tests passed; locale lint, ESLint, and the production build passed.
- Docs: all 226 static pages built successfully.
- Repository gates: TypeScript typecheck, privacy scan, and `git diff --check`
  passed.
- A pre-existing subprocess-test race discovered during the full run was fixed
  separately by sharing each stdout/stderr read promise instead of consuming a
  losing `Promise.race` branch twice.

The broader Sol/Luna × Kimi/Grok/DeepSeek manual matrix remains a
post-integration gate because model catalogs and protocol selection are sticky
for the task that performs the integration.

## Target integration verification

- Focused runtime coverage passed: 128 tests across plaintext collaboration,
  V2 policy, and encrypted-task fail-closed suites.
- GUI passed 714 tests across 124 files, locale lint, ESLint, React Doctor, and
  production build. Docs built all 226 pages. Typecheck, privacy scan, and
  `git diff --check` passed.
- `OCX_TEST_SHARD_SIZE=1 bun run test` passed shards 1-153, then stopped at
  `codex-native-residue`. Continued one-file coverage exercised shards 155-602.
  Every file passed except `codex-native-residue` (7 timeouts),
  `codex-retained-root-serialization` (3), `native-claude-desktop-toggle` (2),
  and `native-grok-toggle` (13 plus one cascaded post-timeout error).
- Each affected subprocess exceeded a fixed 5-10 second deadline while taking
  roughly 8-27 seconds. Targeted retries reproduced the same timing boundary;
  the repository's allowed deterministic Codex fixture was absent. No fixture
  was created and no timeout, assertion, or safety guard was weakened.
- Therefore integration is complete, but the required full target runtime gate
  is not green. Rerun it on an idle host before review readiness, then perform
  the separately authorized live Sol/Luna × Kimi/Grok/DeepSeek matrix.

# 031 — Product-owned plaintext V2 compatibility

Status: INTEGRATED, TRANSPORT-HARDENED, AND LIVE-VERIFIED

Branch: `codex/multi-agent-workstation`
Scope: explicit mixed-provider V2 compatibility with encrypted fail-closed behavior retained

## Decision

OpenCodex owns an experimental plaintext V2 compatibility mode. It does not
decrypt or re-encrypt backend payloads.

For a canonical ChatGPT parent with the complete recognized V2 collaboration
schema, the proxy:

1. aliases the complete `collaboration` namespace to
   `ocx_collaboration_plaintext` on the upstream wire;
2. removes `encrypted: true` only from the `message` properties of
   `spawn_agent`, `send_message`, and `followup_task`;
3. rewrites replayed collaboration calls and tool selectors to the same alias;
4. restores the complete namespace across SSE and JSON responses; and
5. adds `encrypted_function_args: []` only to completed message-bearing calls.

Stock Codex 0.147 recognizes that marker as `DirectPlaintextMessage` while
retaining the V2 graph, mailbox, wait, follow-up, interrupt, and completion
lifecycle. Routed parents receive equivalent marker handling at the OpenCodex
bridge.

The operator enables the contract explicitly:

```json
{
  "multiAgentV2MessageDelivery": "plaintext"
}
```

`"encrypted"` remains the default. Sending `null` or `"encrypted"` through
the management API removes the explicit plaintext override.

## Activation and fail-closed boundary

Native aliasing activates only when all of these are true:

- plaintext delivery is explicitly enabled;
- the resolved parent route is canonical ChatGPT;
- the complete recognized collaboration schema is present; and
- the plaintext alias does not already exist anywhere in the request.

Unknown, duplicate, partial, malformed, colliding, or future schemas remain on
the encrypted path. Existing `unreadable_encrypted_agent_task` detection and
native-only fallback remain authoritative. Lifecycle calls such as list, wait,
and interrupt keep their namespace but never receive the plaintext sentinel.
Incomplete or failed function calls are never promoted into executable
plaintext messages.

Rejected approaches remain rejected:

- guessed decryption or proxy re-encryption;
- stripping ciphertext and dispatching an empty or replacement task;
- a patched Codex binary or file inbox;
- blanket `agent_message` rewriting; and
- automatic plaintext activation.

## Privacy boundary

The parent chooses its collaboration schema before choosing a worker, so
plaintext mode applies to every V2 delegation message from that parent,
including native-to-native messages. The trusted local Codex runtime and
OpenCodex proxy necessarily handle that plaintext. Usage-debug metadata and
usage extraction remain available, but request and response body samples are
suppressed for activated plaintext-V2 turns.

## macOS transport hardening

The original post-integration macOS stall was below the model/protocol layer:
the proxy had already received `response.completed`, but an async-`pull()`
stream shape delayed Codex tool execution. The branch therefore uses the eager
single-reader Darwin relay only for the exact recognized plaintext-V2 rewrite
on the validated bundled Bun version. Owned translator budgets settle exactly
once from the producer; caller-owned budgets remain untouched;
`streamMode: "legacy-tee"` remains the rollback switch.

## Verification

- Transform tests cover complete and malformed schemas, collisions, replay,
  tool choice, all lifecycle calls, sentinel allowlisting, unexpected
  ciphertext, JSON/SSE restoration, and encrypted-mode negative controls.
- Usage-debug tests confirm metadata remains while body samples are absent.
- The full runtime suite covered all 604 one-file shards on the functional
  revision; GUI, docs, typecheck, privacy, and diff gates passed.
- A fresh Sol parent spawned the exact external workers below with isolated
  prompts and awaited each completion:
  - `opencode-go/deepseek-v4-flash` → `DEEPSEEK_V2_OK`
  - `kimi/k3[1m]` → `KIMI_V2_OK`
  - `opencode-go/glm-5.2` → `GLM_V2_OK`
  - `xai/grok-4.5` → `GROK_V2_OK`
- A follow-up sent to the completed Kimi worker returned
  `KIMI_FOLLOWUP_OK`. No substitution, timeout, catalog exclusion, or
  unawaited task occurred.

The feature is ready for fork integration while remaining explicitly labeled
experimental. Broader client-version telemetry—not a hard-coded version
number—should decide when it is safe to reconsider the default.

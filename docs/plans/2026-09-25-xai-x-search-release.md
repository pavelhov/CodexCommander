---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
created: 2026-09-25
---
# Grok X Search and macOS update

## Goal Capsule
Enable a Grok 4.7 Codex task to search live X posts through xAI's Responses API, retain direct source links, and ship the change through development, main, and the next authenticated macOS update.

## Requirements
- R1: Requests routed to xAI Grok 4.7 can opt into server-side `x_search` when the task asks for X research.
- R2: Normal function tools, streaming, cancellation, errors, and citations remain usable.
- R3: General web search for other providers remains unchanged.
- R4: User-facing documentation explains when X search is available and its xAI billing.
- R5: Release assets use the existing signed appcast, an incremented immutable build, and verified prior inventory.

## Key Technical Decisions
- KTD-1: Use xAI's `/v1/responses` endpoint for X research. Its documented `x_search` tool is not available on `/chat/completions`; avoid implying model selection alone enables it. Governs R1-R2.
- KTD-2: Preserve Codex's client tool calls and existing provider routes while adding the hosted xAI tool only for eligible xAI requests. Governs R1-R3.
- KTD-3: Complete feature PR to `development`, then promote via PR to `main` before the release. Governs R5.

## Implementation Units
### U1: xAI hosted search path
Inspect `src/providers/registry.ts`, `src/adapters/openai-chat.ts`, `src/adapters/openai-responses.ts`, `src/responses/parser.ts`, `src/bridge.ts`, and `src/web-search/`. Add the smallest sound xAI Responses routing and `x_search` handling. Add focused regression tests in `tests/` for tool injection, X source links, non-X routes, errors, and streaming/cancellation. Depends on no other unit. Covers R1-R3.

### U2: User documentation
Update the relevant `docs-site/` provider/search documentation and translations so they accurately describe availability, cost, and setup. Depends on U1. Covers R4.

### U3: Integration and update
Run `bun run typecheck`, focused tests, `bun run test:parallel`, `bun run privacy:scan`, docs build, and applicable app checks. Review security implications of sending task content to xAI and preserving citations. Merge the feature to `development`, promote to `main` after CI, package the signed macOS update, generate and verify its appcast, then publish and verify release assets. Depends on U1-U2. Covers R5.

## Verification Contract
The existing non-xAI adapter behavior is preserved. Focused tests prove that a Grok X research request carries `x_search` to xAI Responses and returns verifiable post URLs. Full repository checks and PR CI pass. The release asset is signed, feed verification passes, and the published fixed appcast URL serves the new version.

## Definition of Done
The feature is on both `development` and `main`; a new macOS release is published with an authenticated update; the user can update and test X search from the app.

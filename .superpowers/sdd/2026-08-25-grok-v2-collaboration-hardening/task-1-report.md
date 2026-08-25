# Task 1 report: schema-aware integer argument canonicalizer

## Implementation

Added `coerceIntegerToolArguments` in `src/lib/tool-argument-integers.ts`. The implementation parses a completed JSON argument string once, records raw numeric token spellings, and walks the request schema with a bounded (depth 64) recursive walker. It supports nested objects and arrays, `additionalProperties`, same-document JSON Pointer references (including `~0`/`~1` unescaping), `anyOf`/`oneOf`/`allOf`, cyclic-reference termination, and safe-integer checks. Integral float/exponent spellings are repaired only for declared integer schemas or the advertised `timeout_ms` number field; otherwise the original bytes are returned.

Added table-driven and edge-case coverage in `tests/tool-argument-integers.test.ts`.

## TDD verification

RED command (before creating the implementation):

```text
$ bun test tests/tool-argument-integers.test.ts
error: Cannot find module '../src/lib/tool-argument-integers' ...
0 pass 1 fail 1 error
```

GREEN command:

```text
$ bun test tests/tool-argument-integers.test.ts
12 pass
0 fail
18 expect() calls
```

Typecheck command:

```text
$ bun run typecheck
$ bun x tsc --noEmit
```

Exit status was 0.

## Files changed

- `src/lib/tool-argument-integers.ts`
- `tests/tool-argument-integers.test.ts`
- `.superpowers/sdd/2026-08-25-grok-v2-collaboration-hardening/task-1-report.md`

## Self-review

- Confirmed invalid JSON and schemas without authorized intent return the original argument text.
- Confirmed unsafe integers above `Number.MAX_SAFE_INTEGER` are not rewritten.
- Confirmed array items do not inherit an enclosing object property name (`timeout_ms` remains special only as an object property).
- Confirmed unrelated pre-existing whitespace is preserved when no authorized number representation is repaired.
- Confirmed cyclic refs and nesting beyond depth 64 terminate without throwing.

## Concerns

Once an authorized repair occurs, `JSON.stringify` intentionally emits normalized JSON (including unrelated numeric spellings/whitespace), as allowed by the byte-preservation invariant's repair exception. No full test suite was run per task instructions.

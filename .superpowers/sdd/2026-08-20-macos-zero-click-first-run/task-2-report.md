# Task 2: macOS first-run policy

Status: complete

Commit: `4f1bc4c6b0b04e2f7cc542440c15de924a5287f1`

## Result

Added the pure `prepareMacOSAppStart` policy layer. It consumes the canonical
default config and Task 1's lossless `initializeConfigIfMissing` result,
classifies Codex config presence using `lstatSync` (only `ENOENT` is missing),
persists `clientIntegrations.codex=false` only on a newly created app config
when Codex is missing, and returns the explicit first-run setup requirement.
Existing app config and all Codex config files remain untouched. Typed
initialization refusals map to secret-free `CONFIGURATION_REQUIRED` errors.

## Validation

- `bun test tests/macos-first-run.test.ts` — 4 pass, 0 fail.
- `bun run typecheck` — pass.
- `bun run test:parallel` — reached all 596 test-file completions with no
  failures observed, but was interrupted after the runner continued draining
  unusually slow unrelated macOS/build and discovery tests; it did not produce
  a final aggregate exit result.

## Files changed

- `src/cli/macos-first-run.ts`
- `tests/macos-first-run.test.ts`

## Concerns

No known policy concerns. Full-suite aggregate completion remains unconfirmed
because unrelated long-running tests prevented the parallel runner from
exiting in a reasonable time; focused policy tests and strict typecheck are
clean.

## Fix round 1

Addressed review feedback by replacing injected-only branch coverage with four
isolated subprocess probes. Each probe sets temporary `CODEXCOMMANDER_HOME` and
`CODEX_HOME` before importing the production policy, blocks `fetch`, runs the
real initializer/classifier, and asserts exact app config bytes, app metadata
entries, Codex config bytes, and Codex directory entries for its branch.

Validation:

- `bun test tests/macos-first-run.test.ts` — 4 pass, 0 fail (22 assertions).
- `bun run typecheck` — pass.
- `git diff --check` — pass.

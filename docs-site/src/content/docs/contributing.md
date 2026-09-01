---
title: Contributing
description: Develop CodexCommander — setup, layout, conventions, and how to add a provider or adapter.
---

## Setup

Source development requires the `bun` CLI on your `PATH`. No registry package is currently
published; this checkout's scripts run through your local Bun installation.

```bash
cd /path/to/CodexCommander
bun install
bun run dev:proxy    # proxy API in dev mode
bun run dev:gui      # dashboard dev server (another terminal)
bun run typecheck    # bun x tsc --noEmit
bun run test         # bun test ./tests/
```

`bun run dev` remains an alias for `bun run dev:proxy`. The dashboard dev server is `bun run dev:gui`;
the packaged dashboard at `GET /` is produced by `bun run build:gui` (`gui/dist`).

## Build and test commands

The root package is Bun-native TypeScript; there is no separate server compile step. Use the checked-in
scripts so local commands match CI:

```bash
bun run typecheck                 # strict TypeScript check
bun run test                      # complete tests/ suite
bun test tests/router.test.ts     # focused test file
cd gui && bun run test            # dashboard tests (isolated workers)
bun run build:gui                 # Vite GUI build + package preparation
bun run privacy:scan              # credential/privacy scan used by CI
bun run prepare:package           # refresh package launchers/assets
```

Most tests are flat `tests/*.test.ts` Bun tests. `tests/helpers/` contains shared fixtures and
`tests/e2e-style/` contains broader native-parity scenarios. Keep a focused regression near the
existing tests for the subsystem you change; run `bun run test:parallel` for shared routing,
adapters, config, or server behavior. If that reports failed files, rerun only those files — not
the entire suite. The parallel runner retries failed items once in the same
isolation mode; an isolated rerun of a failed shared-process batch cannot mark
the suite green.

The docs site you're reading lives in `docs-site/` (Astro + Starlight):

```bash
cd docs-site && bun install && bun dev
```

## Docs site

The docs live in `docs-site/` and have no currently published host. Before opening a docs pull
request, build locally:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

Publishing automation is not included in this repository.

## Continuous integration

Every pull request and every push to `main` runs one automatic GitHub check: **`ci`**
(`.github/workflows/ci.yml`). That is the only required automation for ordinary
contributions.

Repository administrators can use the GitHub ruleset **Always-allow** bypass when a
protected-path or branch rule would otherwise block an intentional admin action. Bypass
is for admin recovery and exceptional maintenance, not a substitute for review on
contributor work.

## Branches and pull requests

- **`main` is the sole default, integration, and pull-request target.** Open feature and
  fix pull requests against `main`.
- Branch from the current **`main`** tip.
- Write a real description: what changed, why, and how you verified it (named commands
  and results). Empty or placeholder-only descriptions are not enough for review.
- If the change touches the dashboard UI, include a screenshot in the description.
- Behavior changes need a focused regression near the existing tests for that subsystem.
  Shared routing, adapter, config, or server changes need `bun run test:parallel` green.
  On a flake, rerun only the failed files; do not rerun the entire suite.

The retired dual-track Go native port is not part of this repository. Bun-native TypeScript on
`main` is the single runtime line.

Rebase pull requests are welcome. Bringing a stale branch onto the current head is
ordinary maintenance — name the source commits in the description.

## Project maintainers

The current maintainers, their responsibilities, and the review and merge policy are documented in
[`MAINTAINERS.md`](https://github.com/pavelhov/CodexCommander/blob/main/MAINTAINERS.md). GitHub review
ownership for the repository and security-sensitive paths is declared in `.github/CODEOWNERS`.

## Conventions

- **ES Modules only** (`import`/`export`), TypeScript, `strict` mode. Keep `bun x tsc --noEmit` clean.
- **~500 lines per file max** — split by responsibility (the `web-search/` and `vision/` sidecars are
  good examples of small, focused modules behind a single `index.ts`).
- **Handle async errors at boundaries** — sidecars never throw into the request path; they degrade to
  a graceful marker.
- **Structure SOT** — current maintainer invariants live in `structure/`. Keep public user workflows
  in `docs-site/` and maintained engineering notes in `docs/`.
- **Preserve exports** — other modules may depend on them.

## Adding a provider to the catalog

All provider pickers and seeds derive from the canonical registry (`src/providers/registry.ts`):

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
},
```

`src/providers/derive.ts` feeds that entry into `ccx init`, `ccx provider`, dashboard presets,
API-key login, and OAuth config seeds. `enrichProviderFromCatalog()` copies model metadata and
capability classifications onto the saved provider config. OAuth protocol implementations still
live in `src/oauth/`; registry metadata alone is not an OAuth flow.

### Evidence required for a canonical preset

A registry entry is a maintained promise: CodexCommander ships the destination that a user's API key is
sent to. A preset therefore needs primary-source evidence, not a working code path. Pull requests
that add or promote a provider must supply all of the following in the description:

- **The documented OpenAI-compatible endpoints.** Link the vendor's own API reference for the chat
  endpoint and, when the entry sets `liveModels: true`, for authenticated `GET /v1/models`. A
  passing fixture test is not a substitute: it proves our code shape, not the upstream contract.
- **Terms of service and the operating legal entity.** An empty or placeholder legal page does not
  establish who runs the endpoint or under what terms user traffic is handled.
- **Resale or routing authorization for aggregators.** A gateway that sells access to Claude, GPT,
  Gemini, or other third-party models should show its authorization to route to them. Users read a
  built-in preset as a maintained route, not as an unverified reseller.
- **A named maintenance owner.** State who updates the preset when the base URL, authentication, or
  catalog contract changes, and how a break will be reported.
- **A citable verification date.** Record the primary source and the date it was checked, the same
  way `lastVerified` works in `src/providers/free-directory.ts`. A date on an unverified row asserts
  provenance nobody produced.

Contributors adding their own service are welcome, and several current presets arrived that way.
Disclose the affiliation in the pull-request description so reviewers can weigh it; affiliation is
not a reason for rejection, and it does not lower the evidence bar either.

When the evidence is incomplete, the honest home is a reference row in
`src/providers/free-directory.ts` rather than the canonical registry. Directory rows carry an
explicit `verification` grade (`official`, `primary`, `unverified`) and are inert: users can still
reach the service through the custom OpenAI-compatible flow, while CodexCommander avoids advertising a
preset it cannot stand behind. Promote the row to the registry once the evidence above exists.

## Adding an adapter

Implement `ProviderAdapter` (see [Adapters](/reference/adapters/)) in `src/adapters/`,
register its name in `src/server/adapter-resolve.ts`, and bridge its output to internal
`AdapterEvent`s. Reuse `image.ts` for image handling and follow `openai-chat.ts` for ordinary
streaming/tool calls; use `fetchResponse` only when the adapter owns transport retries, or `runTurn`
for a genuinely bidirectional transport such as Cursor. Add focused tests under `tests/` and export
the factory from `src/index.ts` when it belongs to the public package API.

## Verify before you claim done

Run the narrowest command that proves your change — `bun run typecheck` for types, a focused
`bun test tests/<name>.test.ts` or runtime probe for behavior, then the broader gates appropriate to
the affected surface. CodexCommander favors small, verifiable commits over large batches.

---
title: opencode
description: Use any routed model from opencode — opencodex injects a runtime provider block and leaves your own opencode config untouched.
---

opencode reads its providers from merged JSON config layers rather than environment
variables, so there is no `ANTHROPIC_BASE_URL`-style slot to inject. `ocx opencode`
bridges that gap: it ensures the proxy is running, builds a provider block from the
visible catalog, and injects it through OpenCode's inline runtime layer
(`OPENCODE_CONFIG_CONTENT`).

## Quickstart

```bash
ocx opencode
```

This ensures the proxy is running and launches opencode with only the generated
`provider.opencodex` block injected for that process. Extra arguments pass through:
`ocx opencode run "hello"`.

Routed models appear in the picker under the `opencodex` provider:

```text
opencodex/kiro/glm-5
opencodex/gpt-5.6-sol      # native slugs stay unprefixed
```

## Your own config is never modified

The launcher does not copy or rewrite `~/.config/opencode/opencode.json`,
project `opencode.json` / `opencode.jsonc`, or any other on-disk config layer. It may
read global or project config to detect a `provider.opencodex` override, while your
existing providers, agents, keybinds, MCP entries, and relative `{file:…}` references
keep resolving from their original files.

For this launch only, opencodex adds the generated `provider.opencodex` block through
OpenCode's inline runtime layer. That layer merges after global/custom/project config
and overrides only conflicting keys for the child process.

| Layer | Behavior with `ocx opencode` |
| --- | --- |
| Global / custom / project config | Left on disk exactly as you wrote it |
| Inline runtime (`OPENCODE_CONFIG_CONTENT`) | Receives only the generated `provider.opencodex` block |
| Relative `{file:…}` paths | Still resolve against the config file that originally defined them |

If a global or project config also defines `provider.opencodex`, the launcher prints an
informational note: the runtime layer from `ocx opencode` overrides it for that launch.

## Persistent dashboard connection (optional)

For plain OpenCode, editor integrations, or one-click Desktop launch, open **Integrations** in the
OpenCodex dashboard and choose **Apply connection**. This is intentionally different from
`ocx opencode`:

- The dashboard selects OpenCode's active global config under `XDG_CONFIG_HOME` (normally
  `~/.config/opencode/`): `opencode.jsonc` when it exists, otherwise `opencode.json`.
- It makes a JSONC-aware, surgical edit of **only** `provider.opencodex`. Comments, formatting,
  other providers, agents, keybinds, MCP entries, and unrelated keys remain owned by OpenCode and
  are preserved.
- The proxy admission token is written to OpenCodex's hardened integration state and the OpenCode
  config receives only a protected `{file:/absolute/path}` reference. The token is not copied into
  OpenCode's config or auth store.
- **Always keep OpenCode connected** is off by default. After you opt in, OpenCodex refreshes its
  managed provider block after proxy startup or a visible-catalog change; it still owns no other
  OpenCode setting.

**Restore** is reversible by design. When the journal confirms an exact restore is safe, OpenCodex
restores the original bytes exactly (or removes a config file it created). Otherwise, Dashboard
Restore defaults to a surgical restore of only `provider.opencodex`, preserving later user edits. A
full external-config overwrite is available only to an API caller that explicitly confirms the
current file hash.

The **Open OpenCode** button is a one-click launcher for OpenCode Desktop. If only the CLI is
installed, use `ocx opencode` from a terminal instead; it remains the transient, disk-nonmutating
path described above.

## Putting the block into your own config

`ocx opencode` injects the provider block for one launch only. If you have not applied the optional
dashboard connection above, plain `opencode` still knows nothing about the proxy. When you want to
merge the block yourself instead, `ocx export` prints the same provider block for you to merge into
your own config:

```bash
ocx export --client opencode
```

The proxy must be running. The command prints the config, the canonical destination
(`~/.config/opencode/opencode.json`, or under `XDG_CONFIG_HOME` when that is set), the merge
warning, and the env export line. It never touches that file — the section above stays true, and
moving the block into your config is your explicit act.

:::caution[Merge, never replace]
Merge the `provider.opencodex` block into your existing config. Replacing the whole file with the
exported one destroys your other providers, agents, keybinds, and MCP entries. `ocx export --out`
refuses to overwrite an existing file for exactly this reason, so point `--out` at a scratch path
and copy the block across:

```bash
ocx export --client opencode --out ~/opencodex-opencode.json
```
:::

Unlike the launcher's runtime block, a merged block is a static snapshot: it does not follow your
catalog. Re-run `ocx export` after you add a provider or change model visibility.

Once merged, export the admission key before launching opencode — unless the proxy is on loopback,
where none is needed:

```bash
export OPENCODEX_OPENCODE_API_KEY=<your key>
```

## The admission key is not written to disk

When the proxy requires an API key, the inline runtime config carries opencode's
`{env:…}` reference rather than the secret. Loopback binds use that reference as
`apiKey`; non-loopback binds send it only through `x-opencodex-api-key` so proxy
admission stays separate from any upstream `Authorization` header.

Loopback example:

```json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}"
}
```

Non-loopback example:

```json
"options": {
  "baseURL": "http://192.168.1.10:10100/v1",
  "headers": {
    "x-opencodex-api-key": "{env:OPENCODEX_OPENCODE_API_KEY}"
  }
}
```

The real value is passed only through the child process environment.
`OPENCODEX_API_AUTH_TOKEN` takes precedence, then the hardened service token file, then
a configured API key — which is what a non-loopback bind requires.

A loopback bind (`127.0.0.1`, the default) authenticates nothing, so the `{env:…}` reference is
inert and you can leave the variable unset. It matters only when `hostname` is set beyond loopback;
see [Remote access](/reference/configuration/#remote-access). This admission key is opencodex's
own, and is unrelated to the upstream provider keys configured under
[Providers](/guides/providers/).

## Reverting

For the transient `ocx opencode` launcher, there is nothing to undo: no OpenCode config file was
changed. For a dashboard connection, choose **Restore** on **Integrations**; see the exact versus
surgical behavior above. Plain `opencode` reads your own config as before once the managed provider
is restored.

## Model limits

`limit.context` is written only when the catalog reports an authoritative context window; when it
does not, the whole `limit` block is omitted and opencode keeps its own defaults.

opencode's schema rejects a `limit` block carrying `context` without `output`, and the catalog has
no authoritative per-model output field, so an `output` budget of `32000` is emitted alongside it,
clamped down to the context window so a small-context model is never given `output > context`.
That figure exists to satisfy the schema — it is not a claim about any specific model's true
maximum.

The `opencodex` provider block is regenerated on every launch, so per-model tweaks made inside it
will not survive. Keep custom entries under a provider key of your own instead.

## Requirements

opencode must be installed and on `PATH`:

```bash
npm install -g opencode-ai
```

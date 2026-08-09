---
title: Pi
description: Use any routed model from Pi — ccx export writes a custom provider block for Pi's models.json, wired to the running proxy.
---

Pi reads its providers from a single global JSON file rather than environment variables, so
CodexCommander does not launch it. Instead, `ccx export` serializes the `codexcommander` provider block —
base URL, model list, and the env reference Pi interpolates — and you merge it into your own
config.

## Quickstart

Start the proxy, then print the config:

```bash
ccx start
ccx export --client pi
```

The output leads with the JSON, then prints the destination path, the merge warning, the env
export line, and how many models carry authoritative context limits.

```json
{
  "providers": {
    "codexcommander": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "$CODEXCOMMANDER_API_KEY",
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

Model ids are the proxy's canonical selectors, so routed models appear as `provider/model`
(`anthropic/claude-opus-5`) and native OpenAI slugs stay unprefixed (`gpt-5.6-sol`). The `name`
suffix — `(anthropic)`, `(native)`, `(routed)` — is what makes two same-named models from
different upstreams distinguishable in Pi's picker.

## Where it goes

Pi's global model config is:

```text
~/.pi/agent/models.json
```

:::caution[Merge, never replace]
`ccx export` never writes that file. Merge the `providers.codexcommander` block into it — replacing the
file destroys every other provider you have configured there. `--out` exists for a scratch path
and refuses to overwrite an existing file without `--force`:

```bash
ccx export --client pi --out ~/codexcommander-pi-models.json
ccx export --client pi --json > ~/codexcommander-pi-models.json   # or redirect the byte-exact JSON
```
:::

The exported block is a static snapshot, not a live view. Re-run `ccx export` after adding a
provider or changing model visibility, and merge the new block over the old one.

## The admission key

Two different keys are easy to confuse here, and only the first one appears in this file:

| Key | What it is | Where it lives |
| --- | --- | --- |
| Proxy admission key | CodexCommander's own credential, generated on the dashboard's **API** tab | referenced by `apiKey` as `$CODEXCOMMANDER_API_KEY`; the value stays in your environment |
| Provider key | your Anthropic / OpenAI / OpenRouter key | CodexCommander's own config, per [Providers](/guides/providers/) |

The exported config carries only the reference, never a secret. Pi interpolates a bare `$NAME`, so
the variable is:

```bash
export CODEXCOMMANDER_API_KEY=<your key>
```

That name is Pi's alone. opencode uses a different variable
(`CODEXCOMMANDER_OPENCODE_API_KEY`, in `{env:…}` form) — see the [opencode guide](/guides/opencode/).

**A loopback proxy needs no key at all.** CodexCommander binds `127.0.0.1` by default and authenticates
nothing there, so the `$CODEXCOMMANDER_API_KEY` reference is inert and you can leave the variable unset.
It matters only when `hostname` is set beyond loopback, which is also the case where the proxy
refuses to start without a token — see [Remote access](/reference/configuration/#remote-access).

## Model metadata

`contextWindow` and `maxTokens` are emitted only when the catalog reports an authoritative context
window. When it does not, both fields are omitted for that model and Pi applies its own defaults;
`ccx export` prints how many rows fell into that case.

`maxTokens` is a schema-satisfying budget of `32000`, clamped down to the context window so a
small-context model is never given more output than context. It is not a claim about any specific
model's true maximum.

Two fields are deliberately absent. `cost` requires all four price fields and CodexCommander has no
price data for routed models — emitting zeros would assert that every model is free. `reasoning` is
a boolean in Pi while the catalog carries an effort ladder, and mapping one onto the other would be
a guess.

## Schema status

:::note[Unverified against a real install]
The shape above follows Pi's published custom-provider documentation. It has **not** been verified
against a real `~/.pi/agent/models.json` on a machine with Pi installed. If Pi rejects the exported
block, the mismatch is on our side — please
[open an issue](https://github.com/pavelhov/CodexCommander/issues) with what Pi reported.
:::

## Requirements

A running CodexCommander proxy (`ccx start`) and Pi installed. `ccx export` reads the live catalog
through the proxy's management API, so a config can never be emitted with an empty model list.

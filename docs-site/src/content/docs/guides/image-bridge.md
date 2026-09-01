---
title: Image Bridge
description: Opt into Grok Imagine image generation without changing native Codex images by default.
---

## Overview

Grok media has two independent switches: **Grok Images** and **Grok Video**. With Grok Images
off, CodexCommander preserves its normal native/OpenAI image behavior. In particular, enabling
Grok Video alone does not route image generation to xAI.

When Grok Images is on, CodexCommander uses the selected xAI media source for both supported
image entry points:

- Hosted Responses `image_generation` requests, including native and routed text-model paths.
- Direct `POST /v1/images/generations` requests, including Codex's built-in image surface.

`POST /v1/images/edits` is deliberately unsupported by the Grok bridge in v1. With Grok Images
on it returns a typed unsupported result instead of silently selecting another paid image provider.

## Configure the four states

The switches are independent. Choose one explicit `authSource` whenever either switch is enabled:

| Images | Video | Result |
| --- | --- | --- |
| off | off | Existing native/OpenAI image behavior; no Grok video tool. |
| on | off | Eligible image generation uses Grok; no video generation. |
| off | on | Native/OpenAI images remain the default; eligible text-to-video is available. |
| on | on | Eligible image and text-to-video generation use Grok. |

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": false,
    "authSource": "api_key"
  }
}
```

The standard image model is `grok-imagine-image-2.0`. See xAI's current
[image-model page](https://docs.x.ai/developers/models/grok-imagine-image-2.0),
[Imagine API overview](https://x.ai/api/imagine), and [pricing page](https://docs.x.ai/developers/pricing)
for current availability, limits, and charges. Those values are controlled by xAI and are not
promised by CodexCommander.

## Choose the billing source deliberately

`authSource` is either `subscription_oauth` or `api_key`. It applies only to Grok media; it does
not change xAI/Grok chat authentication or routing. CodexCommander binds each operation to the
selected credential before a submit or poll and has **no fallback** to the other source. Missing
credentials, reauthentication, entitlement errors, rate limits, and network failures remain errors
for that selected source; they never trigger API-key spend because OAuth failed, or OAuth use because
a key failed.

Paid media authority always comes from the enabled canonical `providers.xai` row. A custom provider
whose URL happens to use an xAI hostname remains an ordinary chat provider and cannot arm new image
or video spend. This keeps media-key mutations behind the canonical human-attested management path.
Already accepted jobs from an older legacy-alias configuration may resolve only their exact bound
slot for recovery; they cannot use that compatibility path to submit new work.

`subscription_oauth` is experimental and is not assumed to be usable for media. Its capability
probe is production-preflight-disabled until an explicit U8 safety approval. A successful future
probe would observe capability only: it would not prove which xAI subscription, quota, or billing
balance was charged. An ambiguous submit can consume quota without producing a result.

## Streaming, tools, and artifacts

Hosted Responses media requires `stream: true`; the direct Images API remains its own request path.
Web search, image generation, and video generation have independent auxiliary budgets. One mixed
turn may still hit the global model-iteration cap, but web search does not skip or consume an image
or video allowance.

Completed **hosted Responses bridge** outputs are materialized in private local artifact storage and
surfaced through an authenticated opaque artifact URL, not a `file:` URL or a provider-signed URL.
The artifact service validates media, enforces retention, and may later report `artifact_pruned` when
a retained item has expired or been pruned. Completed hosted image and video results replay only
authenticated proxy-relative artifact references and renderer hints. Direct
`POST /v1/images/generations` is separate: it returns a self-contained `b64_json` image result and
does not return an artifact URL. Its paid xAI POST is protected by a private local replay journal:
an exact retry with the same `Idempotency-Key` or `X-Client-Request-Id` receives the original
completed JSON result for up to 24 hours, while an uncertain post-dispatch outcome is never submitted
again. Identifiers are limited to 1–256 bounded safe ASCII characters and are privately keyed with the
authenticated data-plane principal; neither the identifier, principal, prompt, request body, nor
credential is persisted. When neither header is present, exact request bodies from the same
principal share a conservative 10-minute replay window. Supply a fresh explicit identifier when
you intentionally want another variation of an otherwise identical request.
Replay storage is bounded. Under unusually heavy large-result pressure, older completed bytes may
be replaced early by a non-retryable `artifact_unavailable` tombstone; the paid request is still not
repeated. Uncertain tombstones do not expire automatically, are isolated by private principal scope,
and eventually make only that principal fail closed if its bounded allocation is exhausted.
The private journal authenticates every retained row and the complete sorted row set, so partial
deletion or rewriting fails closed. Like any local snapshot scheme, restoring an older internally
consistent copy of the journal together with its matching replay authority cannot reveal that a
newer whole snapshot once existed; backups must therefore be restored deliberately as one unit.

An eligible non-artifact video result may instead include a
bounded opaque local `jobId` when its durable job is busy, detached, failed, or has
`submission_outcome_unknown`; it is not a provider identifier. Capability-probe contention does not
expose a job ID. No provider IDs, credentials, paths, prompts, private artifact fields, model IDs,
provider URLs, or signed URLs are replayed to a routed provider.

## Troubleshooting

- `needs_auth` means the selected source is not ready. Establish or reauthenticate that same source;
  switching sources is a separate explicit action.
- An entitlement, quota, policy, or rate-limit result is an xAI result for the selected source; no
  alternate source is tried.
- `submission_outcome_unknown` means a request may have reached xAI but its outcome was not safely
  known. CodexCommander does not replay that POST automatically. Use its opaque `jobId` in the
  dashboard or `ccx media jobs` / `ccx media jobs wait <opaque-job-id> --revision <n>` to inspect or
  follow the safe job state. A human can acknowledge it with the dashboard action or `ccx media
  ack-job <opaque-job-id> --revision <n>` before any deliberate retry.
- For an accepted or detached video job, use the dashboard or `ccx media jobs` to follow recovery
  instead of submitting another request.

See [Video Bridge](/guides/video-bridge/) for text-to-video limits and durable-job behavior, and
[Media configuration](/reference/configuration/server/#images-codexcommanderimagesconfig) for all
configuration fields.

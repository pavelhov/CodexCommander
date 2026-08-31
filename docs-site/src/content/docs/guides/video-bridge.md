---
title: Video Bridge
description: Opt into durable Grok Imagine text-to-video generation independently of image generation.
---

## Overview

The Video Bridge exposes one synthetic `video_gen` tool for an eligible streaming Responses turn
when `images.videoBridgeEnabled` is on and the current user input explicitly asks for video
generation. Turning video on does not turn on Grok Images: native Codex/OpenAI image generation
remains unchanged in the video-only state.

Video v1 is **text-to-video only**. It uses `grok-imagine-video-1.5`; image-to-video, reference
video, editing, and multiple video outputs are outside this release.

## Configuration examples

Image-only:

```json
{ "images": { "bridgeEnabled": true, "videoBridgeEnabled": false, "authSource": "api_key" } }
```

Video-only, retaining native images:

```json
{ "images": { "bridgeEnabled": false, "videoBridgeEnabled": true, "authSource": "subscription_oauth" } }
```

Both capabilities:

```json
{ "images": { "bridgeEnabled": true, "videoBridgeEnabled": true, "authSource": "api_key" } }
```

Both sources are explicit choices, not a failover chain. `subscription_oauth | api_key` selects the
one credential used by media and does not alter xAI/Grok chat authentication. If the selected source
is missing, rejected, rate-limited, or unavailable, media fails safely without consulting the other.

## Text-to-video limits

The request requires a nonempty prompt. It accepts an integer duration of **1–15 seconds**,
`480p`, `720p`, or `1080p` resolution, one of `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, or `2:3`
aspect ratio, and an optional boolean audio flag. Invalid values are rejected rather than clamped.
Defaults are **6 seconds**, **720p**, and **16:9**. One human-intent turn can accept only one video
operation; this spend fence is derived from the original current-user input, not prior assistant,
tool, or web-search text.

Current xAI model/API and pricing details live on xAI's
[video model page](https://docs.x.ai/developers/models/grok-imagine-video-1.5),
[Imagine API page](https://x.ai/api/imagine), and [pricing page](https://docs.x.ai/developers/pricing).
CodexCommander does not hardcode pricing, quotas, availability, or subscription entitlement claims.

## Durable jobs and artifacts

Before submitting a video, CodexCommander persists a prompt-free submission fence. Once xAI accepts
a job, its original selected credential binding and absolute deadline are retained across disconnects,
setting changes, and restarts. Poll and download retries can resume the accepted job; the POST itself
is never replayed when its outcome is ambiguous. Such work becomes `outcome_unknown` and retains its
admission until a privileged human acknowledgement.

Finished MP4 or WebM artifacts are private, opaque, and authenticated. Their route supports `GET`,
`HEAD`, and a single byte range for seeking. Retention may produce a terminal `artifact_pruned`
state. Use the dashboard or `ccx media jobs` to see safe job state and to open/reveal a completed
artifact; those actions accept opaque job IDs rather than paths or signed URLs. The server
revalidates the artifact and launches it only through a fixed platform opener with a scrubbed child
environment. The provider-visible tool result contains proxy-relative artifact references only,
never an absolute local path.

`needs_auth` asks for recovery of the job's original source. A future or otherwise unsafe recovery
journal remains read-only until the documented acknowledgement/upgrade path is completed; no new
video is admitted through that state. Active or locked journals cannot be quarantined, and a proven
hard-link publication crash alias is reconciled before retention. Video completion and startup
recovery own durable artifact retention, so image pruning cannot delete a pinned video artifact.
On Windows, journal recovery is inspection-only: SQLite cannot keep the required exclusive proof
handle while atomically renaming the database, so quarantine/reset fails closed without moving or
fencing bytes. Upgrade or recover the journal on a supported host instead of releasing that lock.

## Experimental OAuth probe

Subscription OAuth media is experimental and fail-closed. Its fixed capability probe is one image
plus one one-second 1080p video using the selected OAuth binding, with API-key fallback disabled.
It has unknown billing attribution and an ambiguous submission can consume quota without a result.
The image must settle before the video POST can begin; accepted video is reconciled in the background
and after restart without a new POST. Feasibility evidence, including the early spike, is not
packaged verification. Production probing remains preflight-disabled until explicit U8 safety
approval, and these docs do not claim that any subscription account has been verified.

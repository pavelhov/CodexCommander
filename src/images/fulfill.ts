import { existsSync, readdirSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageBridgePlan, ImageCallResult, VideoCallResult } from "./types";
import { callXaiImages } from "./xai-client";
import {
  artifactHttpUrl,
  materializeInlineImage,
  downloadImageToArtifact,
  getArtifactsDir,
  pruneArtifacts,
  resolveArtifactPath,
  type ImageBudget,
} from "./artifacts";
import { MAX_PENDING_IMAGE_FULFILLMENTS } from "../lib/translator-budget";
import {
  isMediaTransportError,
  type MediaDispatchCertainty,
} from "./media-errors";
import {
  registerArtifactPinAuthority,
  type ArtifactPinAuthority,
} from "./artifact-retention";

/** Result metadata needed by the request-scoped loop to enforce paid-POST no-replay. */
export interface ImageFulfillmentResult extends ImageCallResult {
  /** Provider transport certainty; ambiguous submissions disable image dispatch for the rest of the turn. */
  dispatchCertainty?: MediaDispatchCertainty;
  /** A known-success paid POST must never be replayed merely because local artifact work failed. */
  paidSubmissionConsumed?: boolean;
}

export type SafeMediaToolStatus =
  | "completed"
  | "failed"
  | "invalid_request"
  | "busy"
  | "detached"
  | "artifact_unavailable"
  | "submission_outcome_unknown";

/** Provider-visible media result. Private paths, prompts, model ids, and raw errors never enter it. */
export interface SafeMediaToolResult {
  ok: boolean;
  status: SafeMediaToolStatus;
  /** Bounded opaque local id for recovering a non-artifact video result. */
  jobId?: string;
  /** Authenticated proxy-relative artifact references; never provider or filesystem URLs. */
  artifacts?: string[];
  /** Renderer hint built exclusively from the authenticated relative artifact reference. */
  markdown?: string;
}

function safeMediaStatus(result: ImageFulfillmentResult): SafeMediaToolStatus {
  if (result.ok) return "completed";
  if (result.dispatchCertainty === "ambiguous" || result.error?.startsWith("submission_outcome_unknown")) {
    return "submission_outcome_unknown";
  }
  const error = result.error ?? "";
  if (error.startsWith("image_fulfillment_busy") || error.startsWith("video_busy")) return "busy";
  if (error.startsWith("video_detached")) return "detached";
  if (
    error === "invalid arguments JSON"
    || error === "missing prompt"
    || error.startsWith("unsupported ")
    || error.startsWith("duration must")
    || error.startsWith("audio must")
    || error === "grok_image_edits_unsupported"
  ) return "invalid_request";
  if (error.includes("artifact") || error.includes("pruned")) return "artifact_unavailable";
  return "failed";
}

function safeLocalVideoJobId(value: unknown): value is string {
  // Durable media ids are locally generated and journal-bounded to 64 characters. Keep the
  // provider-visible contract narrower still by rejecting whitespace, controls, URLs, and paths.
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

/** Serialize only the narrow result contract safe to replay into another provider request. */
export function safeMediaToolResult(
  result: ImageFulfillmentResult | VideoCallResult,
  kind: "image" | "video",
): SafeMediaToolResult {
  const artifacts: string[] = [];
  if (result.ok) {
    for (const path of result.files) {
      try {
        const localPath = resolveArtifactPath(path.split(/[\\/]/).at(-1) ?? "");
        if (!localPath || resolvePath(localPath) !== resolvePath(path)) continue;
        artifacts.push(artifactHttpUrl(localPath));
      } catch { /* invalid internal metadata is omitted */ }
    }
  }
  const primary = artifacts[0];
  const status = safeMediaStatus(result);
  const jobId = kind === "video"
    && !result.ok
    && (status === "busy"
      || status === "detached"
      || status === "failed"
      || status === "submission_outcome_unknown")
    && "jobId" in result
    && safeLocalVideoJobId(result.jobId)
    ? result.jobId
    : undefined;
  return {
    ok: result.ok,
    status,
    ...(jobId ? { jobId } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(primary
      ? { markdown: kind === "image" ? `![image](${primary})` : `[Open video](${primary})` }
      : {}),
  };
}

const fulfillmentEncoder = new TextEncoder();
let pendingFulfillments = 0;
let fulfillmentCurrentBytes = 0;
let fulfillmentHighWaterBytes = 0;

/**
 * One request-owned image lease. Registering it as a normal pin authority makes every retention
 * caller (including video completion and direct-image retention) preserve the response artifacts
 * until the auxiliary request has replayed them and finalized.
 */
export interface ImageArtifactProtectionScope {
  protect(paths: Iterable<string>): void;
  close(): void;
}

function artifactIdForPath(path: string): string | null {
  const id = basename(path);
  try {
    const localPath = resolveArtifactPath(id);
    return localPath && resolvePath(localPath) === resolvePath(path) ? id : null;
  } catch {
    return null;
  }
}

export function createImageArtifactProtectionScope(): ImageArtifactProtectionScope {
  const artifactIds = new Set<string>();
  const authority: ArtifactPinAuthority = {
    protectedArtifactIds: () => artifactIds,
    releaseArtifactForPrune: artifactId => artifactIds.has(artifactId) ? "protected" : "not_owned",
  };
  const unregister = registerArtifactPinAuthority(authority);
  let open = true;
  return {
    protect(paths) {
      if (!open) return;
      for (const path of paths) {
        const artifactId = artifactIdForPath(path);
        if (artifactId) artifactIds.add(artifactId);
      }
    },
    close() {
      if (!open) return;
      open = false;
      unregister();
      artifactIds.clear();
    },
  };
}

function addFulfillmentBytes(bytes: number): void {
  fulfillmentCurrentBytes += bytes;
  fulfillmentHighWaterBytes = Math.max(fulfillmentHighWaterBytes, fulfillmentCurrentBytes);
}

function releaseFulfillmentBytes(bytes: number): void {
  fulfillmentCurrentBytes = Math.max(0, fulfillmentCurrentBytes - bytes);
}

export function imageFulfillmentTailSnapshot(): { currentBytes: number; highWaterBytes: number; active: number } {
  return { currentBytes: fulfillmentCurrentBytes, highWaterBytes: fulfillmentHighWaterBytes, active: pendingFulfillments };
}

/** Serialize write→prune→retain across concurrent fulfillments sharing artifacts/. */
let retentionTail: Promise<void> = Promise.resolve();
let materializingFulfillments = 0;
const materializationWaiters = new Set<() => void>();
let unregisterMaterializationGuard: (() => void) | undefined;

const materializationGuard: ArtifactPinAuthority = {
  protectedArtifactIds() {
    if (materializingFulfillments === 0) return new Set<string>();
    // A materializer may have committed a file and yielded immediately before its caller records
    // the returned path. Protect the whole directory for that narrow window so any retention
    // caller—not only another image fulfillment—fails safe against deleting paid bytes.
    const artifactIds = new Set<string>();
    for (const name of readdirSync(getArtifactsDir())) {
      try {
        if (resolveArtifactPath(name)) artifactIds.add(name);
      } catch { /* unsafe/non-artifact entries are never retention candidates */ }
    }
    return artifactIds;
  },
  releaseArtifactForPrune: () => "protected",
};

/**
 * Fail-closed guard for the commit→path-registration window shared by every image entrypoint.
 * Callers must release only after registering every materialized path in an artifact scope.
 */
export function beginImageArtifactMaterialization(): () => void {
  if (materializingFulfillments === 0) {
    unregisterMaterializationGuard = registerArtifactPinAuthority(materializationGuard);
  }
  materializingFulfillments += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    materializingFulfillments -= 1;
    if (materializingFulfillments !== 0) return;
    unregisterMaterializationGuard?.();
    unregisterMaterializationGuard = undefined;
    for (const resolve of materializationWaiters) resolve();
    materializationWaiters.clear();
  };
}

async function waitForMaterializationBarrier(): Promise<void> {
  while (materializingFulfillments > 0) {
    await new Promise<void>(resolve => materializationWaiters.add(resolve));
  }
}

async function retainAfterBatch(
  paths: string[],
  keepCount: number | undefined,
  requestProtection: ImageArtifactProtectionScope | undefined,
  finishMaterialization: () => void,
): Promise<string[]> {
  const retainedBytes = paths.reduce((total, path) => total + fulfillmentEncoder.encode(path).byteLength, 0);
  addFulfillmentBytes(retainedBytes);
  const batchProtection = createImageArtifactProtectionScope();
  batchProtection.protect(paths);
  requestProtection?.protect(paths);
  finishMaterialization();
  const run = retentionTail.then(async () => {
    // Do not prune while another paid call may have written bytes but has not yet had a chance to
    // register its batch. Once the barrier opens, every concurrent batch has an active authority.
    await waitForMaterializationBarrier();
    pruneArtifacts(keepCount);
    return paths.filter((p) => existsSync(p));
  });
  retentionTail = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } finally {
    releaseFulfillmentBytes(retainedBytes);
    // Preserve direct-call handoff through the current event-loop turn. Production auxiliary
    // callers also hold requestProtection until replay/finalization.
    const timer = setTimeout(() => batchProtection.close(), 0);
    timer.unref?.();
  }
}

/**
 * Fulfill ONE image-generation tool call end-to-end: parse args, call xAI, materialize the returned
 * images to disk, and return a structured result. NEVER throws — all errors become `{ ok: false }`
 * so the caller can inject the error as a tool result and let the model respond gracefully.
 */
export async function fulfillImageCall(
  call: { id: string; name: string; arguments: string },
  plan: ImageBridgePlan,
  budget: ImageBudget,
  signal?: AbortSignal,
  artifactProtection?: ImageArtifactProtectionScope,
): Promise<ImageFulfillmentResult> {
  if (pendingFulfillments >= MAX_PENDING_IMAGE_FULFILLMENTS) {
    return { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "image_fulfillment_busy" };
  }
  pendingFulfillments += 1;
  let finishMaterialization = (): void => {};
  const callBytes = fulfillmentEncoder.encode(call.id).byteLength
    + fulfillmentEncoder.encode(call.name).byteLength
    + fulfillmentEncoder.encode(call.arguments).byteLength;
  addFulfillmentBytes(callBytes);
  try {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "invalid arguments JSON" };
  }
  if (typeof args !== "object" || args === null) {
    return { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "invalid arguments JSON" };
  }
  const obj = args as Record<string, unknown>;

  const prompt =
    typeof obj.prompt === "string" ? obj.prompt : typeof obj.input === "string" ? obj.input : "";
  if (!prompt) {
    return { ok: false, model: plan.model, prompt: "", files: [], count: 0, error: "missing prompt" };
  }

  const n = obj.n === undefined ? 1 : obj.n;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 4) {
    return { ok: false, model: plan.model, prompt, files: [], count: 0, error: "image count must be an integer from 1 through 4" };
  }
  const imageUrl =
    typeof obj.image_url === "string" ? obj.image_url : typeof obj.image === "string" ? obj.image : undefined;
  if (imageUrl) {
    return {
      ok: false,
      model: plan.model,
      prompt,
      files: [],
      count: 0,
      error: "grok_image_edits_unsupported",
    };
  }
  const size = typeof obj.size === "string" ? obj.size : plan.defaultSize;
  const quality = typeof obj.quality === "string" ? obj.quality : plan.defaultQuality;

  let result;
  try {
    result = await callXaiImages(
      { prompt, model: plan.model, n: n as number, imageUrl, size, quality },
      plan.auth!,
      signal,
      plan.timeoutMs,
    );
  } catch (e) {
    if (isMediaTransportError(e)) {
      return {
        ok: false,
        model: plan.model,
        prompt,
        files: [],
        count: 0,
        error: e.code === "ambiguous_submission" ? "submission_outcome_unknown" : e.message,
        dispatchCertainty: e.certainty,
      };
    }
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, model: plan.model, prompt, files: [], count: 0, error };
  }

  finishMaterialization = beginImageArtifactMaterialization();
  const files: string[] = [];
  for (const img of result.images ?? []) {
    try {
      if (img.b64_json) {
        files.push(await materializeInlineImage(img.b64_json, budget));
      } else if (img.url) {
        files.push(await downloadImageToArtifact(img.url, budget, signal));
      }
    } catch {
      // Keep warnings URL-free — error messages may embed provider CDN URLs.
      // Partial success is OK — silently skip this image and continue.
      console.warn("[images] failed to materialize image");
    }
  }

  // Prune only after the full batch is on disk so a tight keepCount cannot delete
  // an earlier image from this same call before we return its path. Concurrent
  // fulfillments share one retention chain so they cannot prune each other's
  // just-written paths mid-filter.
  const retained = await retainAfterBatch(
    files,
    plan.artifactsKeepCount,
    artifactProtection,
    finishMaterialization,
  );

  if (retained.length === 0) {
    return {
      ok: false,
      model: plan.model,
      prompt,
      files: [],
      count: 0,
      error: "image artifact unavailable after provider completion",
      paidSubmissionConsumed: true,
    };
  }

  const primary = retained[0]!;
  return {
    ok: true,
    model: plan.model,
    prompt,
    path: primary,
    files: retained,
    count: retained.length,
    paidSubmissionConsumed: true,
    // Keep path/files as native FS paths; Markdown needs a file: URI so Windows
    // backslashes are not treated as escapes by renderers.
    markdown: `![image](${pathToFileURL(primary).href})`,
  };
  } finally {
    finishMaterialization();
    releaseFulfillmentBytes(callBytes);
    pendingFulfillments -= 1;
  }
}

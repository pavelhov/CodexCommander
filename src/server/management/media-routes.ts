import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname, join } from "node:path";

import { loadConfig, mutatePersistedConfig } from "../../config";
import { createArtifactResponse, getArtifactsDir } from "../../images/artifacts";
import { buildMediaReadinessSnapshot } from "../../images/capabilities";
import {
  CapabilityProbeGateError,
  IMAGE_PROBE_MODEL,
  VIDEO_PROBE_MODEL,
  type CapabilityProbeService,
  type CapabilityProbeStatus,
} from "../../images/capability-probe";
import { bindMediaCredential } from "../../images/media-credentials";
import type { MediaRuntime } from "../../images/media-runtime";
import type {
  CapabilityProbeDispatchCertainty,
  CapabilityProbeStepKind,
  CapabilityProbeStepState,
  PublicCapabilityProbe,
  PublicVideoJob,
  SafeMediaFailure,
  VideoJobStore,
  VideoJobState,
} from "../../images/video-job-store";
import type { MediaAuthSource, CodexCommanderConfig } from "../../types";
import {
  MEDIA_ACTION_ATTESTATION_HEADER,
  MEDIA_ACTION_NONCE,
  type MediaActionAttestationInput,
} from "../../lib/media-action-attestation";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { isPlainRecord } from "./shared";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MEDIA_ACTIONS = new Set(["acknowledge", "open", "reveal", "quarantine_reset"]);

export type PublicMediaJobAction =
  | "wait"
  | "recover_auth"
  | "acknowledge"
  | "open"
  | "none";

export interface PublicMediaJobStatus {
  id: string;
  revision: number;
  state: VideoJobState;
  phase: "progress" | "human_action_required" | "completed" | "terminal";
  action: PublicMediaJobAction;
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export interface MediaManagementRuntime {
  state: "ready" | "recovery_blocked";
  listJobs?(): PublicVideoJob[];
  getJob?(id: string): PublicVideoJob | null;
  acknowledgeJob?(id: string, expectedRevision: number): PublicVideoJob | null;
  probe?: CapabilityProbeService;
  /** Exact safe durable lookup; it never binds credentials or starts work. */
  getProbeStatus?(id: string): CapabilityProbeStatus | null;
  /** Test seam. Production launches the contained server-derived artifact without a shell. */
  launchArtifact?: (artifactId: string, reveal: boolean) => Promise<boolean>;
  settingsApplied?: (config: CodexCommanderConfig) => void;
  /** Single-use server verification for an exact locally attested CLI envelope. */
  authorizeInteractiveCliAction?: (input: MediaActionAttestationInput, proof: string | null) => boolean;
  recovery?: {
    id: string;
    revision: number;
    cause: "old_schema" | "future_schema" | "corrupt" | "unsafe" | "unavailable";
    readOnly: boolean;
    quarantineReset?: (expectedRevision: number) => Promise<"applied" | "conflict" | "unsupported">;
    acknowledge?: (id: string, expectedRevision: number) => Promise<"applied" | "conflict" | "unsupported">;
    acknowledgementRequired?: boolean;
    restartRequired?: boolean;
  };
}

export interface PublicMediaResource {
  revision: number;
  settings: {
    imagesEnabled: boolean;
    videosEnabled: boolean;
    authSource: MediaAuthSource | null;
  };
  readiness: ReturnType<typeof buildMediaReadinessSnapshot>;
  experimental: true;
  sourceFallback: "disabled";
  acceptedJobsKeepOriginalBinding: true;
  jobs: PublicMediaJobStatus[];
  page: { limit: number; nextCursor: string | null };
  probe: PublicMediaProbeStatus | null;
  recovery: null | {
    id: string;
    revision: number;
    cause: "old_schema" | "future_schema" | "corrupt" | "unsafe" | "unavailable";
    readOnly: boolean;
    action: "upgrade" | "manual_recovery" | "quarantine_reset" | "acknowledge";
    acknowledgementRequired: boolean;
    restartRequired: boolean;
  };
}

export interface PublicMediaProbeStep {
  state: CapabilityProbeStepState;
  dispatchCertainty: CapabilityProbeDispatchCertainty;
  reason: SafeMediaFailure | null;
  updatedAt: number;
  verifiedAt?: number;
  inspectedAt?: number;
}

export interface PublicMediaProbeStatus {
  id: string;
  revision: number;
  source: "subscription_oauth";
  imageModel: string;
  videoModel: string;
  videoDurationSeconds: 1;
  videoResolution: "1080p";
  apiKeyFallbackDisabled: true;
  billingAttribution: "unknown";
  releaseStatus: "feasibility_only";
  createdAt: number;
  updatedAt: number;
  steps: Record<CapabilityProbeStepKind, PublicMediaProbeStep>;
}

function mediaRevision(config: CodexCommanderConfig): number {
  const semantic = JSON.stringify({
    imagesEnabled: config.images?.bridgeEnabled === true,
    videosEnabled: config.images?.videoBridgeEnabled === true,
    authSource: config.images?.authSource ?? null,
  });
  // A safe 48-bit semantic revision is stable across processes and JSON clients.
  return Number.parseInt(createHash("sha256").update(semantic).digest("hex").slice(0, 12), 16);
}

function observations(config: CodexCommanderConfig): { observations: ReturnType<typeof credentialObservations>; observedAt?: number } {
  const source = config.images?.authSource;
  if (source !== "subscription_oauth" && source !== "api_key") return { observations: {} };
  try {
    bindMediaCredential(config);
    return { observations: { [source]: "ready" as const }, observedAt: Date.now() };
  } catch {
    return {
      observations: credentialObservations(source, false),
    };
  }
}

function credentialObservations(source: MediaAuthSource, available: boolean) {
  return available
    ? { [source]: "ready" as const }
    : { [source]: source === "subscription_oauth"
      ? "reauthentication_required" as const
      : "missing" as const };
}

export function publicMediaJobStatus(job: PublicVideoJob): PublicMediaJobStatus {
  let phase: PublicMediaJobStatus["phase"] = "terminal";
  let action: PublicMediaJobAction = "none";
  let reason: string = job.safeError ?? job.state;
  if (["queued", "submitting", "accepted", "polling", "downloading"].includes(job.state)) {
    phase = "progress";
    action = "wait";
    reason = "in_progress";
  } else if (job.state === "needs_auth") {
    phase = "human_action_required";
    action = "recover_auth";
    reason = "original_source_needs_auth";
  } else if (job.state === "download_failed") {
    // Recovery owns this credentialless GET retry; no human action endpoint is
    // advertised because the existing accepted job is never submitted again.
    phase = "progress";
    action = "wait";
    reason = "credentialless_download_retry";
  } else if (job.state === "outcome_unknown") {
    phase = "human_action_required";
    action = "acknowledge";
    reason = "submission_outcome_unknown";
  } else if (job.state === "completed") {
    phase = "completed";
    action = "open";
    reason = "artifact_ready";
  } else if (job.state === "artifact_pruned") {
    reason = "artifact_pruned";
  }
  return {
    id: job.id,
    revision: job.revision,
    state: job.state,
    phase,
    action,
    reason,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function publicMediaProbeStatus(status: CapabilityProbeStatus): PublicMediaProbeStatus {
  const step = (kind: CapabilityProbeStepKind): PublicMediaProbeStep => {
    const value = status.steps[kind];
    return {
      state: value.state,
      dispatchCertainty: value.dispatchCertainty,
      reason: value.safeError ?? null,
      updatedAt: value.updatedAt,
      ...(value.verifiedAt !== undefined ? { verifiedAt: value.verifiedAt } : {}),
      ...(value.inspectedAt !== undefined ? { inspectedAt: value.inspectedAt } : {}),
    };
  };
  return {
    id: status.id,
    revision: status.revision,
    source: "subscription_oauth",
    imageModel: IMAGE_PROBE_MODEL,
    videoModel: VIDEO_PROBE_MODEL,
    videoDurationSeconds: 1,
    videoResolution: "1080p",
    apiKeyFallbackDisabled: true,
    billingAttribution: "unknown",
    releaseStatus: "feasibility_only",
    createdAt: status.createdAt,
    updatedAt: status.updatedAt,
    steps: { image: step("image"), video: step("video") },
  };
}

function capabilityProbeStatus(probe: PublicCapabilityProbe): CapabilityProbeStatus {
  return {
    ...probe,
    source: "subscription_oauth",
    videoDurationSeconds: 1,
    videoResolution: "1080p",
    apiKeyFallbackDisabled: true,
    billingAttribution: "unknown",
    releaseStatus: "feasibility_only",
  };
}

function parsePage(url: URL): { limit: number; offset: number } | null {
  const rawLimit = url.searchParams.get("limit");
  const rawCursor = url.searchParams.get("cursor");
  if ([...url.searchParams.keys()].some(key => key !== "limit" && key !== "cursor")) return null;
  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  const offset = rawCursor === null ? 0 : Number(rawCursor);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return null;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_024) return null;
  return { limit, offset };
}

function publicResource(
  config: CodexCommanderConfig,
  runtime: MediaManagementRuntime | undefined,
  page: { limit: number; offset: number },
): PublicMediaResource {
  const all = runtime?.listJobs?.() ?? [];
  const jobs = all
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(page.offset, page.offset + page.limit)
    .map(publicMediaJobStatus);
  const next = page.offset + jobs.length < all.length ? String(page.offset + jobs.length) : null;
  const recovery = runtime?.state === "recovery_blocked" && runtime.recovery
    ? {
        id: runtime.recovery.id,
        revision: runtime.recovery.revision,
        cause: runtime.recovery.cause,
        readOnly: runtime.recovery.readOnly,
        action: runtime.recovery.acknowledgementRequired === true
          ? "acknowledge" as const
          : runtime.recovery.cause === "future_schema"
          ? "upgrade" as const
          : runtime.recovery.readOnly
            ? "manual_recovery" as const
            : "quarantine_reset" as const,
        acknowledgementRequired: runtime.recovery.acknowledgementRequired === true,
        restartRequired: runtime.recovery.restartRequired === true,
      }
    : null;
  return {
    revision: mediaRevision(config),
    settings: {
      imagesEnabled: config.images?.bridgeEnabled === true,
      videosEnabled: config.images?.videoBridgeEnabled === true,
      authSource: config.images?.authSource ?? null,
    },
    readiness: (() => {
      const observed = observations(config);
      return buildMediaReadinessSnapshot(config, observed.observations, {
        credentialObservedAt: observed.observedAt,
        recoveryBlocked: runtime?.state === "recovery_blocked",
      });
    })(),
    experimental: true,
    sourceFallback: "disabled",
    acceptedJobsKeepOriginalBinding: true,
    jobs,
    page: { limit: page.limit, nextCursor: next },
    // Compatibility-only field: ordinary readiness reads must never create or
    // dispatch a durable probe. Existing records remain available by exact GET.
    probe: null,
    recovery,
  };
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function error(ctx: ManagementContext, status: number, code: string): Response {
  return noStore(jsonResponse({ error: { code } }, status, ctx.req, ctx.config));
}

function freshConfig(ctx: ManagementContext): CodexCommanderConfig {
  // Pure direct-dispatch tests use the injected persistence seam and intentionally
  // do not own the process config directory.
  if (ctx.deps.saveConfigPreservingClaudeCode) return ctx.config;
  return loadConfig();
}

type SettingsPatchBody = {
  expectedRevision: number;
  imagesEnabled?: boolean;
  videosEnabled?: boolean;
  authSource?: MediaAuthSource;
  action?: "settings";
  target?: "settings";
  id?: "media-settings";
  confirmation?: true;
  caller?: "interactive_cli";
  nonce?: string;
  issuedAt?: number;
};

function strictPatch(value: unknown): SettingsPatchBody | null {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set([
    "expectedRevision", "imagesEnabled", "videosEnabled", "authSource",
    "action", "target", "id", "confirmation", "caller", "nonce", "issuedAt",
  ]);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.has(key)) || keys.length < 2) return null;
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) return null;
  if (value.imagesEnabled !== undefined && typeof value.imagesEnabled !== "boolean") return null;
  if (value.videosEnabled !== undefined && typeof value.videosEnabled !== "boolean") return null;
  if (value.authSource !== undefined && value.authSource !== "subscription_oauth" && value.authSource !== "api_key") return null;
  if (value.imagesEnabled === undefined && value.videosEnabled === undefined && value.authSource === undefined) return null;
  const attestationFields = ["action", "target", "id", "confirmation", "caller", "nonce", "issuedAt"];
  const hasAttestation = attestationFields.some(key => value[key] !== undefined);
  if (hasAttestation && (
    value.action !== "settings"
    || value.target !== "settings"
    || value.id !== "media-settings"
    || value.confirmation !== true
    || value.caller !== "interactive_cli"
    || typeof value.nonce !== "string"
    || !MEDIA_ACTION_NONCE.test(value.nonce)
    || !Number.isSafeInteger(value.issuedAt)
    || (value.issuedAt as number) <= 0
  )) return null;
  return value as SettingsPatchBody;
}

function mirrorMediaSettings(target: CodexCommanderConfig, source: CodexCommanderConfig): void {
  target.images = source.images ? structuredClone(source.images) : undefined;
}

async function patchSettings(ctx: ManagementContext, body: unknown): Promise<Response> {
  const patch = strictPatch(body);
  if (!patch) return error(ctx, 400, "invalid_media_patch");
  const runtime = ctx.deps.mediaManagement;
  if (ctx.principal !== "confirmed-gui-session") {
    const attested = patch.action === "settings"
      && patch.target === "settings"
      && patch.id === "media-settings"
      && patch.confirmation === true
      && patch.caller === "interactive_cli"
      && typeof patch.nonce === "string"
      && ctx.principal === "admin-token"
      && runtime?.authorizeInteractiveCliAction?.(
        patch as MediaActionAttestationInput,
        ctx.req.headers.get(MEDIA_ACTION_ATTESTATION_HEADER),
      ) === true;
    if (!attested) return error(ctx, 403, "media_settings_attestation_required");
  }
  type MutationValue = { kind: "stale" | "applied" | "source_required"; config: CodexCommanderConfig };
  const apply = (current: CodexCommanderConfig): { changed: boolean; value: MutationValue } => {
    if (mediaRevision(current) !== patch.expectedRevision) {
      return { changed: false, value: { kind: "stale" as const, config: current } };
    }
    const nextImages = { ...(current.images ?? {}) };
    if (patch.imagesEnabled !== undefined) nextImages.bridgeEnabled = patch.imagesEnabled;
    if (patch.videosEnabled !== undefined) nextImages.videoBridgeEnabled = patch.videosEnabled;
    if (patch.authSource !== undefined) nextImages.authSource = patch.authSource;
    if ((nextImages.bridgeEnabled === true || nextImages.videoBridgeEnabled === true) && nextImages.authSource === undefined) {
      return { changed: false, value: { kind: "source_required", config: current } };
    }
    current.images = nextImages;
    // Re-evaluate the exact selected source at the final mutation callback. An
    // unready source is allowed to persist, but it never falls back or arms work.
    const observed = observations(current);
    void buildMediaReadinessSnapshot(current, observed.observations, { credentialObservedAt: observed.observedAt });
    return { changed: true, value: { kind: "applied" as const, config: current } };
  };

  if (ctx.deps.saveConfigPreservingClaudeCode) {
    const candidate = structuredClone(ctx.config);
    const result = apply(candidate);
    if (result.value.kind === "stale") return error(ctx, 409, "stale_media_revision");
    if (result.value.kind === "source_required") return error(ctx, 400, "media_auth_source_required");
    ctx.deps.saveConfigPreservingClaudeCode(candidate);
    mirrorMediaSettings(ctx.config, candidate);
  } else {
    const outcome = mutatePersistedConfig(apply);
    if (outcome.status === "unavailable") return error(ctx, 409, `media_config_${outcome.reason}`);
    if (outcome.value.kind === "stale") return error(ctx, 409, "stale_media_revision");
    if (outcome.value.kind === "source_required") return error(ctx, 400, "media_auth_source_required");
    mirrorMediaSettings(ctx.config, outcome.value.config);
  }
  ctx.deps.mediaManagement?.settingsApplied?.(ctx.config);
  return noStore(jsonResponse(publicResource(ctx.config, ctx.deps.mediaManagement, { limit: DEFAULT_PAGE_SIZE, offset: 0 }), 200, ctx.req, ctx.config));
}

type ActionBody = {
  action: "acknowledge" | "open" | "reveal" | "quarantine_reset";
  id: string;
  expectedRevision: number;
  confirmation: true;
  caller: "interactive_cli" | "confirmed_gui";
  target?: "job" | "probe" | "recovery";
  step?: CapabilityProbeStepKind;
  nonce?: string;
  issuedAt?: number;
};

function strictAction(value: unknown): ActionBody | null {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set(["action", "id", "expectedRevision", "confirmation", "caller", "target", "step", "nonce", "issuedAt"]);
  if (Object.keys(value).some(key => !allowed.has(key))) return null;
  if (typeof value.action !== "string" || !MEDIA_ACTIONS.has(value.action)) return null;
  if (typeof value.id !== "string" || !OPAQUE_ID.test(value.id)) return null;
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) return null;
  if (value.confirmation !== true) return null;
  if (value.caller !== "interactive_cli" && value.caller !== "confirmed_gui") return null;
  if (value.target !== undefined && value.target !== "job" && value.target !== "probe" && value.target !== "recovery") return null;
  if (value.step !== undefined && value.step !== "image" && value.step !== "video") return null;
  if (value.caller === "interactive_cli") {
    if (typeof value.nonce !== "string" || !MEDIA_ACTION_NONCE.test(value.nonce)) return null;
    if (!Number.isSafeInteger(value.issuedAt) || (value.issuedAt as number) <= 0) return null;
  } else if (value.nonce !== undefined || value.issuedAt !== undefined) return null;
  if ((value.action === "open" || value.action === "reveal") && (value.target !== "job" || value.step !== undefined)) return null;
  if (value.action === "quarantine_reset" && (value.target !== "recovery" || value.step !== undefined)) return null;
  if (value.action === "acknowledge") {
    if (value.target === "probe") {
      if (value.step === undefined) return null;
    } else if ((value.target !== "job" && value.target !== "recovery") || value.step !== undefined) return null;
  }
  return value as ActionBody;
}

function callerAuthorized(ctx: ManagementContext, body: ActionBody, runtime: MediaManagementRuntime | undefined): boolean {
  if (body.caller === "confirmed_gui") return ctx.principal === "confirmed-gui-session";
  if (ctx.principal !== "admin-token" || !body.nonce) return false;
  return runtime?.authorizeInteractiveCliAction?.(
    body as MediaActionAttestationInput,
    ctx.req.headers.get(MEDIA_ACTION_ATTESTATION_HEADER),
  ) === true;
}

async function defaultLaunchArtifact(artifactId: string, reveal: boolean): Promise<boolean> {
  if (basename(artifactId) !== artifactId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:png|jpe?g|webp|gif|mp4|webm)$/i.test(artifactId)) return false;
  // Reuse the no-follow/private-owner/magic-byte validation from authenticated
  // serving before deriving the path. HEAD closes its descriptor without reading.
  const validated = await createArtifactResponse(artifactId, "HEAD", null);
  if (!validated || validated.status !== 200) return false;
  const path = join(getArtifactsDir(), artifactId);
  return spawnMediaArtifactOpener(path, reveal);
}

interface MediaArtifactOpenerChild {
  once: ChildProcess["once"];
  kill(): unknown;
  unref(): unknown;
}

const LINUX_ARTIFACT_OPENER_PATH = "/usr/bin:/bin";
const LINUX_ARTIFACT_OPENER_ENV = [
  "DBUS_SESSION_BUS_ADDRESS",
  "DESKTOP_SESSION",
  "DISPLAY",
  "GNOME_DESKTOP_SESSION_ID",
  "HOME",
  "KDE_FULL_SESSION",
  "KDE_SESSION_VERSION",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CONFIG_HOME",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
] as const;

function linuxArtifactOpenerEnv(source: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
  const env: Record<string, string> = { PATH: LINUX_ARTIFACT_OPENER_PATH };
  for (const key of LINUX_ARTIFACT_OPENER_ENV) {
    const value = source[key];
    // Environment variables cannot contain NUL. Bound inherited values as an
    // additional fail-closed guard before handing them to the fixed helper.
    if (typeof value === "string" && value.length <= 4_096 && !value.includes("\0")) env[key] = value;
  }
  return env;
}

export interface MediaArtifactOpenerDeps {
  platform?: NodeJS.Platform;
  sourceEnv?: Readonly<NodeJS.ProcessEnv>;
  spawnImpl?: (
    command: string,
    args: string[],
    options: { shell: false; detached: true; stdio: "ignore"; env: Record<string, string> },
  ) => MediaArtifactOpenerChild;
  timeoutMs?: number;
}

/** Launch only a server-derived path through a fixed OS executable with no inherited secrets. */
export async function spawnMediaArtifactOpener(
  path: string,
  reveal: boolean,
  deps: MediaArtifactOpenerDeps = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const command = platform === "darwin"
    ? "/usr/bin/open"
    : platform === "win32"
      ? "C:\\Windows\\explorer.exe"
      : "/usr/bin/xdg-open";
  const args = !reveal
    ? [path]
    : platform === "darwin"
      ? ["-R", path]
      : platform === "win32"
        ? ["/select,", path]
        : [dirname(path)];
  const env: Record<string, string> = platform === "linux"
    ? linuxArtifactOpenerEnv(deps.sourceEnv ?? process.env)
    : platform === "win32"
      ? { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" }
      : {};
  const spawnImpl = deps.spawnImpl ?? ((executable, commandArgs, options) =>
    spawn(executable, commandArgs, options));
  const timeoutMs = Math.max(1, Math.min(deps.timeoutMs ?? 10_000, 60_000));
  return await new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(success);
    };
    let child: MediaArtifactOpenerChild;
    try {
      child = spawnImpl(command, args, { shell: false, detached: true, stdio: "ignore", env });
    } catch {
      finish(false);
      return;
    }
    child.once("error", () => finish(false));
    child.once("exit", code => finish(code === 0));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* best-effort termination of a stuck fixed helper */ }
      try { child.unref(); } catch { /* do not let an uncooperative helper hold shutdown open */ }
      finish(false);
    }, timeoutMs);
  });
}

async function runAction(ctx: ManagementContext, value: unknown): Promise<Response> {
  const body = strictAction(value);
  if (!body) return error(ctx, 400, "invalid_media_action");
  const runtime = ctx.deps.mediaManagement;
  if (!callerAuthorized(ctx, body, runtime)) return error(ctx, 403, "media_action_attestation_required");
  if (!runtime) return error(ctx, 503, "media_runtime_unavailable");
  if (body.action === "acknowledge" && body.target === "job") {
    const applied = runtime.acknowledgeJob?.(body.id, body.expectedRevision);
    if (!applied) return error(ctx, 409, "stale_media_revision");
    return noStore(jsonResponse({ applied: true, job: publicMediaJobStatus(applied) }, 200, ctx.req, ctx.config));
  }
  if (body.action === "acknowledge" && body.target === "probe" && body.step && runtime.probe) {
    try {
      const status = runtime.probe.acknowledge({
        caller: body.caller,
        operationId: body.id,
        step: body.step,
        expectedRevision: body.expectedRevision,
        runtimeAttested: true,
        humanConfirmed: true,
      });
      return noStore(jsonResponse({ applied: true, probe: publicMediaProbeStatus(status) }, 200, ctx.req, ctx.config));
    } catch (cause) {
      if (cause instanceof CapabilityProbeGateError) return error(ctx, 409, cause.code);
      throw cause;
    }
  }
  if (body.action === "acknowledge" && body.target === "recovery" && runtime.recovery) {
    const result = await runtime.recovery.acknowledge?.(body.id, body.expectedRevision);
    if (result !== "applied") return error(ctx, 409, result === "conflict" ? "stale_media_revision" : "media_recovery_unavailable");
    return noStore(jsonResponse({ applied: true, restartRequired: true }, 200, ctx.req, ctx.config));
  }
  if ((body.action === "open" || body.action === "reveal")) {
    const job = runtime.getJob?.(body.id);
    if (!job || job.revision !== body.expectedRevision || job.state !== "completed" || !job.artifactId) {
      return error(ctx, 409, "artifact_not_available");
    }
    const launched = await (runtime.launchArtifact ?? defaultLaunchArtifact)(job.artifactId, body.action === "reveal");
    if (!launched) return error(ctx, 409, "artifact_open_failed");
    return noStore(jsonResponse({ applied: true, jobId: job.id, revision: job.revision }, 200, ctx.req, ctx.config));
  }
  if (body.action === "quarantine_reset" && runtime.recovery) {
    if (runtime.recovery.cause === "future_schema" || runtime.recovery.readOnly) return error(ctx, 409, "media_upgrade_required");
    if (runtime.recovery.acknowledgementRequired) return error(ctx, 409, "media_recovery_acknowledgement_required");
    if (runtime.recovery.id !== body.id) return error(ctx, 409, "stale_media_revision");
    const result = await runtime.recovery.quarantineReset?.(body.expectedRevision);
    if (result !== "applied") return error(ctx, 409, result === "conflict" ? "stale_media_revision" : "media_recovery_unavailable");
    return noStore(jsonResponse({ applied: true, acknowledgementRequired: true }, 200, ctx.req, ctx.config));
  }
  return error(ctx, 400, "invalid_media_action");
}

export async function handleMediaRoutes(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname.startsWith("/api/media/probes/")) {
    if (ctx.req.method !== "GET") return error(ctx, 405, "method_not_allowed");
    if ([...ctx.url.searchParams.keys()].length > 0) return error(ctx, 400, "invalid_media_probe_query");
    const id = ctx.url.pathname.slice("/api/media/probes/".length);
    if (!OPAQUE_ID.test(id)) return error(ctx, 400, "invalid_media_probe_id");
    const probe = ctx.deps.mediaManagement?.getProbeStatus?.(id);
    if (!probe) return error(ctx, 404, "media_probe_not_found");
    return noStore(jsonResponse({ probe: publicMediaProbeStatus(probe) }, 200, ctx.req, ctx.config));
  }
  if (ctx.url.pathname.startsWith("/api/media/jobs/")) {
    if (ctx.req.method !== "GET") return error(ctx, 405, "method_not_allowed");
    if ([...ctx.url.searchParams.keys()].length > 0) return error(ctx, 400, "invalid_media_job_query");
    const id = ctx.url.pathname.slice("/api/media/jobs/".length);
    if (!OPAQUE_ID.test(id)) return error(ctx, 400, "invalid_media_job_id");
    const job = ctx.deps.mediaManagement?.getJob?.(id);
    if (!job) return error(ctx, 404, "media_job_not_found");
    return noStore(jsonResponse({ job: publicMediaJobStatus(job) }, 200, ctx.req, ctx.config));
  }
  if (ctx.url.pathname === "/api/media") {
    if (ctx.req.method === "GET") {
      const page = parsePage(ctx.url);
      if (!page) return error(ctx, 400, "invalid_media_page");
      return noStore(jsonResponse(publicResource(freshConfig(ctx), ctx.deps.mediaManagement, page), 200, ctx.req, ctx.config));
    }
    if (ctx.req.method === "PATCH") {
      let body: unknown;
      try { body = await readManagementJsonBody(ctx.req); } catch (cause) { rethrowManagementBodyTooLarge(cause); return error(ctx, 400, "invalid_json"); }
      return patchSettings(ctx, body);
    }
    return error(ctx, 405, "method_not_allowed");
  }
  if (ctx.url.pathname === "/api/media/actions") {
    if (ctx.req.method !== "POST") return error(ctx, 405, "method_not_allowed");
    let body: unknown;
    try { body = await readManagementJsonBody(ctx.req); } catch (cause) { rethrowManagementBodyTooLarge(cause); return error(ctx, 400, "invalid_json"); }
    return runAction(ctx, body);
  }
  return null;
}

/** Production adapter kept here so the route never receives a raw store or binding record. */
export function createMediaManagementRuntime(
  store: VideoJobStore,
  runtime: MediaRuntime,
  probe: CapabilityProbeService,
): MediaManagementRuntime {
  return {
    state: "ready",
    listJobs: () => store.listPublicVideoJobs(),
    getJob: id => store.publicVideoJob(id),
    acknowledgeJob: (id, expectedRevision) => runtime.acknowledgeOutcomeUnknown(id, expectedRevision),
    probe,
    getProbeStatus: id => {
      const existing = store.publicCapabilityProbe(id);
      return existing ? capabilityProbeStatus(existing) : null;
    },
  };
}

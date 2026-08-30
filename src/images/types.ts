import type { CodexCommanderProviderConfig, MediaAuthSource } from "../types";

export type MediaCredentialObservationState = "ready" | "missing" | "reauthentication_required";

/** Safe input facts produced by credential observers; never contains credential material. */
export type MediaCredentialObservations = Partial<Record<MediaAuthSource, MediaCredentialObservationState>>;

export type MediaReadinessState = "disabled" | "ready" | "blocked";

export type MediaReadinessReason =
  | "disabled"
  | "auth_source_missing"
  | "canonical_xai_provider_missing"
  | "xai_provider_missing"
  | "xai_provider_disabled"
  | "ambiguous_xai_provider"
  | "credential_unavailable"
  | "reauthentication_required";

export type MediaProviderKind = "canonical" | "legacy_alias";

export interface MediaCredentialReadiness {
  state: MediaReadinessState;
  reason: MediaReadinessReason | null;
  /** Safe provider classification. Custom provider names are deliberately omitted. */
  provider: MediaProviderKind | null;
  /** Safe operator guidance. Present only when config migration is needed. */
  recovery?: string;
}

export interface MediaCapabilityReadiness {
  enabled: boolean;
  state: MediaReadinessState;
  reason: MediaReadinessReason | null;
}

/**
 * Public, redacted, observe-only media state. This shape is safe for settings,
 * management, CLI, dashboard, and request-policy projections.
 */
export interface MediaReadinessSnapshot {
  authSource: MediaAuthSource | null;
  credential: MediaCredentialReadiness;
  image: MediaCapabilityReadiness;
  video: MediaCapabilityReadiness;
}

export type MediaRequestSurface = "responses" | "images_api";

export type MediaExecutionBlockReason =
  | MediaReadinessReason
  | "surface_ineligible"
  | "route_ineligible"
  | "tool_not_requested";

export interface MediaCapabilityExecutionPlan {
  enabled: boolean;
  ready: boolean;
  surfaceEligible: boolean;
  routeEligible: boolean;
  toolRequested: boolean;
  /** Whether the tool may be exposed for this request. */
  toolEligible: boolean;
  /** Whether this request is eligible to execute it. */
  executionEligible: boolean;
  reason: MediaExecutionBlockReason | null;
}

export interface MediaExecutionRequest {
  surface: MediaRequestSurface;
  routeEligible: boolean;
  imageToolRequested: boolean;
  videoToolRequested: boolean;
}

/** Request-scoped policy only. It never contains a token or credential binding. */
export interface MediaExecutionPlan {
  authSource: MediaAuthSource | null;
  surface: MediaRequestSurface;
  image: MediaCapabilityExecutionPlan;
  video: MediaCapabilityExecutionPlan;
}

/**
 * Execution-only private data. Never embed this shape in MediaReadinessSnapshot,
 * MediaExecutionPlan, logs, status responses, or persisted job metadata.
 *
 * @internal
 */
export interface MediaCredentialBinding {
  readonly authSource: MediaAuthSource;
  /** Safe classification only; never a provider config or user-controlled provider name. */
  readonly providerKind: MediaProviderKind;
  /** Opaque local reference resolved by the execution-time credential lease. */
  readonly slotRef: string;
  /** Stable non-secret digest used to invalidate binding-specific observations. */
  readonly identityDigest: string;
}

export interface ImageBridgePlan {
  /** Private request-bound credential selector; the bearer is resolved only at dispatch. */
  auth: MediaCredentialBinding;
  model: string;
  toolNames: Set<string>;
  /** Per-call xAI deadline (ms). Defaults inside callXaiImages when omitted. */
  timeoutMs?: number;
  /** Defaults from the hosted image_generation tool when the model omits size/quality. */
  defaultSize?: string;
  defaultQuality?: string;
  /** Max artifact files to retain (from config.images.artifactsKeepCount). Default 200. ≤0 disables prune. */
  artifactsKeepCount?: number;
}

export interface ImageCallResult {
  ok: boolean;
  model: string;
  prompt: string;
  path?: string;
  files: string[];
  count: number;
  markdown?: string;
  error?: string;
}

/** Plan for the video bridge. Same auth/provider shape as image, without image-specific defaults. */
export interface VideoBridgePlan {
  provider: CodexCommanderProviderConfig;
  auth: { baseUrl: string; token: string };
  model: string;
  toolNames: Set<string>;
  /** Per-call xAI deadline (ms) for submit + poll. */
  timeoutMs?: number;
  /** Max artifact files to retain (from config.images.artifactsKeepCount). Default 200. ≤0 disables prune. */
  artifactsKeepCount?: number;
}

/** Result shape for video fulfillment — same as image. */
export type VideoCallResult = ImageCallResult;

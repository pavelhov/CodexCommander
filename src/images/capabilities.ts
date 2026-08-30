import type { CodexCommanderConfig, MediaAuthSource } from "../types";
import type {
  MediaCapabilityExecutionPlan,
  MediaCapabilityReadiness,
  MediaCredentialObservations,
  MediaCredentialReadiness,
  MediaExecutionBlockReason,
  MediaExecutionPlan,
  MediaExecutionRequest,
  MediaProviderKind,
  MediaReadinessReason,
  MediaReadinessSnapshot,
} from "./types";

const XAI_MEDIA_HOSTS = new Set(["api.x.ai", "cli-chat-proxy.grok.com"]);

const API_KEY_PROVIDER_RECOVERY =
  "Configure canonical providers.xai, or leave exactly one enabled custom provider whose baseUrl uses an xAI hostname.";
const OAUTH_PROVIDER_RECOVERY =
  "Configure and enable canonical providers.xai for subscription_oauth media authentication.";

type ProviderResolution =
  | { ok: true; provider: MediaProviderKind }
  | { ok: false; reason: MediaReadinessReason; recovery?: string };

function isXaiMediaHostname(baseUrl: string): boolean {
  try {
    return XAI_MEDIA_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function resolveProvider(config: CodexCommanderConfig, source: MediaAuthSource): ProviderResolution {
  const canonical = Object.hasOwn(config.providers, "xai") ? config.providers.xai : undefined;
  if (canonical) {
    if (canonical.disabled === true) {
      return {
        ok: false,
        reason: "xai_provider_disabled",
        recovery: source === "subscription_oauth" ? OAUTH_PROVIDER_RECOVERY : API_KEY_PROVIDER_RECOVERY,
      };
    }
    return { ok: true, provider: "canonical" };
  }

  if (source === "subscription_oauth") {
    return {
      ok: false,
      reason: "canonical_xai_provider_missing",
      recovery: OAUTH_PROVIDER_RECOVERY,
    };
  }

  let aliases = 0;
  for (const provider of Object.values(config.providers)) {
    if (provider.disabled === true) continue;
    if (isXaiMediaHostname(provider.baseUrl)) aliases += 1;
  }
  if (aliases === 1) return { ok: true, provider: "legacy_alias" };
  if (aliases > 1) {
    return {
      ok: false,
      reason: "ambiguous_xai_provider",
      recovery: API_KEY_PROVIDER_RECOVERY,
    };
  }
  return {
    ok: false,
    reason: "xai_provider_missing",
    recovery: API_KEY_PROVIDER_RECOVERY,
  };
}

function capabilityReadiness(
  enabled: boolean,
  credential: MediaCredentialReadiness,
): MediaCapabilityReadiness {
  if (!enabled) return { enabled: false, state: "disabled", reason: "disabled" };
  if (credential.state === "ready") return { enabled: true, state: "ready", reason: null };
  return {
    enabled: true,
    state: "blocked",
    reason: credential.reason ?? "credential_unavailable",
  };
}

/**
 * Build deterministic, network-free, redacted readiness from config plus safe
 * credential observations. Only the selected source is consulted; the other
 * source can never serve as a fallback.
 */
export function buildMediaReadinessSnapshot(
  config: CodexCommanderConfig,
  observations: MediaCredentialObservations = {},
): MediaReadinessSnapshot {
  const imageEnabled = config.images?.bridgeEnabled === true;
  const videoEnabled = config.images?.videoBridgeEnabled === true;
  const anyEnabled = imageEnabled || videoEnabled;
  const authSource = config.images?.authSource ?? null;

  let credential: MediaCredentialReadiness;
  if (!anyEnabled) {
    credential = { state: "disabled", reason: "disabled", provider: null };
  } else if (!authSource) {
    credential = { state: "blocked", reason: "auth_source_missing", provider: null };
  } else {
    const provider = resolveProvider(config, authSource);
    if (!provider.ok) {
      credential = {
        state: "blocked",
        reason: provider.reason,
        provider: null,
        ...(provider.recovery ? { recovery: provider.recovery } : {}),
      };
    } else {
      const observed = observations[authSource] ?? "missing";
      if (observed === "ready") {
        credential = { state: "ready", reason: null, provider: provider.provider };
      } else {
        credential = {
          state: "blocked",
          reason: observed === "reauthentication_required"
            ? "reauthentication_required"
            : "credential_unavailable",
          provider: provider.provider,
        };
      }
    }
  }

  return {
    authSource,
    credential,
    image: capabilityReadiness(imageEnabled, credential),
    video: capabilityReadiness(videoEnabled, credential),
  };
}

function capabilityExecution(
  readiness: MediaCapabilityReadiness,
  surfaceEligible: boolean,
  routeEligible: boolean,
  toolRequested: boolean,
): MediaCapabilityExecutionPlan {
  const ready = readiness.state === "ready";
  const toolEligible = readiness.enabled && ready && surfaceEligible && routeEligible;
  const executionEligible = toolEligible && toolRequested;
  let reason: MediaExecutionBlockReason | null = null;
  if (!readiness.enabled) reason = "disabled";
  else if (!ready) reason = readiness.reason ?? "credential_unavailable";
  else if (!surfaceEligible) reason = "surface_ineligible";
  else if (!routeEligible) reason = "route_ineligible";
  else if (!toolRequested) reason = "tool_not_requested";

  return {
    enabled: readiness.enabled,
    ready,
    surfaceEligible,
    routeEligible,
    toolRequested,
    toolEligible,
    executionEligible,
    reason,
  };
}

/** Add request-local surface, route, and tool gates without attaching credentials. */
export function buildMediaExecutionPlan(
  snapshot: MediaReadinessSnapshot,
  request: MediaExecutionRequest,
): MediaExecutionPlan {
  return {
    authSource: snapshot.authSource,
    surface: request.surface,
    image: capabilityExecution(
      snapshot.image,
      request.surface === "responses" || request.surface === "images_api",
      request.routeEligible,
      request.imageToolRequested,
    ),
    video: capabilityExecution(
      snapshot.video,
      request.surface === "responses",
      request.routeEligible,
      request.videoToolRequested,
    ),
  };
}

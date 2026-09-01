import type { CodexCommanderConfig, MediaAuthSource } from "../types";
import { PROVIDER_REGISTRY } from "../providers/registry";
import type {
  MediaCapabilityExecutionPlan,
  MediaCapabilityReadiness,
  MediaCredentialObservations,
  MediaCredentialReadiness,
  MediaExecutionBlockReason,
  MediaExecutionPlan,
  MediaExecutionRequest,
  MediaProviderKind,
  MediaReadinessSnapshot,
  MediaRouteKind,
  MediaRouteResolution,
} from "./types";

const API_KEY_PROVIDER_RECOVERY =
  "Configure and enable canonical providers.xai for api_key media authentication.";
const OAUTH_PROVIDER_RECOVERY =
  "Configure and enable canonical providers.xai for subscription_oauth media authentication.";

function routeConfigValue(
  config: CodexCommanderConfig,
  kind: MediaRouteKind,
): Pick<MediaRouteResolution, "configured" | "source"> {
  const mediaKey = kind === "image" ? "imageGenerator" : "videoGenerator";
  if (config.media && Object.hasOwn(config.media, mediaKey)) {
    return { configured: config.media[mediaKey], source: "explicit" };
  }
  // Preserve the established standalone Images selector as initial route intent,
  // even when it names no capable provider. It must never silently become xAI.
  if (kind === "image" && config.images?.provider !== undefined) {
    return { configured: config.images.provider, source: "legacy_images_provider" };
  }
  const bridgeEnabled = kind === "image"
    ? config.images?.bridgeEnabled === true
    : config.images?.videoBridgeEnabled === true;
  return bridgeEnabled
    ? { configured: "xai", source: "legacy_bridge" }
    : { configured: undefined, source: "none" };
}

/**
 * Resolve an explicit new-work route using registry facts only. The configured
 * value survives descriptor/config drift, blocking new work without fallback.
 * This resolver is network-free and cannot trigger a paid provider call.
 */
export function resolveMediaRoute(
  config: CodexCommanderConfig,
  kind: MediaRouteKind,
): MediaRouteResolution {
  const { configured, source } = routeConfigValue(config, kind);
  if (configured === null) return { kind, configured, source, state: "none", providerId: null };
  if (configured === undefined) return { kind, configured, source, state: "unconfigured", providerId: null };

  const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === configured);
  if (!entry) return { kind, configured, source, state: "provider_missing", providerId: configured };
  const descriptor = entry.media;
  if (!descriptor || !descriptor.operations[kind]) {
    return { kind, configured, source, state: "capability_absent", providerId: configured };
  }
  const provider = config.providers[configured];
  if (!provider) return { kind, configured, source, state: "provider_missing", providerId: configured };
  if (provider.disabled === true) return { kind, configured, source, state: "provider_disabled", providerId: configured };
  const authSource = config.images?.authSource;
  if (!authSource) return { kind, configured, source, state: "auth_source_missing", providerId: configured };
  if (!descriptor.credentialSources.includes(authSource)) {
    return { kind, configured, source, state: "auth_source_unsupported", providerId: configured };
  }
  return { kind, configured, source, state: "selected", providerId: configured, descriptor };
}

function providerKind(route: MediaRouteResolution): MediaProviderKind | null {
  if (route.providerId === "xai") return "canonical";
  return route.state === "selected" ? "registry" : null;
}

function recoveryForRoute(route: MediaRouteResolution, source: MediaAuthSource | null): string | undefined {
  if (route.providerId !== "xai") return undefined;
  if (route.state === "provider_missing" || route.state === "provider_disabled") {
    return source === "subscription_oauth" ? OAUTH_PROVIDER_RECOVERY : API_KEY_PROVIDER_RECOVERY;
  }
  return undefined;
}

function readinessReasonForRoute(route: MediaRouteResolution): MediaCredentialReadiness["reason"] {
  // Preserve the established canonical-xAI migration diagnostics for legacy
  // bridge settings while route.state retains the generic selector truth.
  if (route.providerId === "xai" && route.state === "provider_missing") return "canonical_xai_provider_missing";
  if (route.providerId === "xai" && route.state === "provider_disabled") return "xai_provider_disabled";
  switch (route.state) {
    case "provider_missing":
    case "provider_disabled":
    case "capability_absent":
    case "auth_source_missing":
    case "auth_source_unsupported":
      return route.state;
    case "none":
    case "unconfigured":
      return "disabled";
    case "selected":
      // The caller only asks for a route error when this cannot happen, but
      // remain fail-closed if a future route state reaches this boundary.
      return "credential_unavailable";
  }
}

function credentialForRoute(
  config: CodexCommanderConfig,
  route: MediaRouteResolution,
  observations: MediaCredentialObservations,
): MediaCredentialReadiness {
  const source = config.images?.authSource ?? null;
  if (route.state === "none" || route.state === "unconfigured") {
    return { state: "disabled", reason: "disabled", provider: null };
  }
  if (route.state !== "selected") {
    const recovery = recoveryForRoute(route, source);
    return {
      state: "blocked",
      reason: readinessReasonForRoute(route),
      provider: null,
      ...(recovery ? { recovery } : {}),
    };
  }
  const observed = observations[source!] ?? "missing";
  if (observed === "ready") return { state: "ready", reason: null, provider: providerKind(route) };
  return {
    state: "blocked",
    reason: observed === "reauthentication_required" ? "reauthentication_required" : "credential_unavailable",
    provider: providerKind(route),
  };
}

function capabilityReadiness(
  route: MediaRouteResolution,
  credential: MediaCredentialReadiness,
): MediaCapabilityReadiness {
  if (route.state === "none" || route.state === "unconfigured") {
    return { enabled: false, state: "disabled", reason: "disabled", route };
  }
  if (credential.state === "ready") return { enabled: true, state: "ready", reason: null, route };
  return { enabled: true, state: "blocked", reason: credential.reason ?? "credential_unavailable", route };
}

/**
 * Build deterministic, redacted readiness from routing plus credential
 * observations. It never probes a provider or changes the selected route.
 */
export function buildMediaReadinessSnapshot(
  config: CodexCommanderConfig,
  observations: MediaCredentialObservations = {},
): MediaReadinessSnapshot {
  const imageRoute = resolveMediaRoute(config, "image");
  const videoRoute = resolveMediaRoute(config, "video");
  const imageCredential = credentialForRoute(config, imageRoute, observations);
  const videoCredential = credentialForRoute(config, videoRoute, observations);
  // Compatibility projection for clients that predate independent selection.
  const credential = imageRoute.state !== "none" && imageRoute.state !== "unconfigured"
    ? imageCredential
    : videoCredential;

  return {
    authSource: config.images?.authSource ?? null,
    credential,
    image: capabilityReadiness(imageRoute, imageCredential),
    video: capabilityReadiness(videoRoute, videoCredential),
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

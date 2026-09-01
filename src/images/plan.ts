import type { CodexCommanderConfig, CodexCommanderParsedRequest, CodexCommanderProviderConfig } from "../types";
import type { ImageBridgePlan, VideoBridgePlan } from "./types";
import { resolveEnvValue } from "../config";
import { IMAGE_GEN_TOOL_NAME, VIDEO_GEN_TOOL_NAME, isVideoGenName } from "./synthetic-tool";
import { bindMediaCredential, type BindMediaCredentialDeps } from "./media-credentials";
import { resolveMediaRoute } from "./capabilities";
import { PROVIDER_REGISTRY } from "../providers/registry";

const XAI_MEDIA_DESCRIPTOR = PROVIDER_REGISTRY.find(entry => entry.id === "xai")!.media!;
export const XAI_IMAGE_MODEL = XAI_MEDIA_DESCRIPTOR.operations.image!.model;
/** Absolute ceiling for `images.timeoutMs` (matches /v1/images relay budget). */
export const MAX_IMAGE_TIMEOUT_MS = 300_000;

function clampImageTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.min(MAX_IMAGE_TIMEOUT_MS, Math.floor(value)));
}

export function findXaiProvider(config: CodexCommanderConfig): { name: string; provider: CodexCommanderProviderConfig } | undefined {
  // Primary: well-known name "xai"
  const xai = config.providers["xai"];
  if (xai && xai.disabled !== true) return { name: "xai", provider: xai };
  // Fallback: hostname match for custom-named xAI configs
  for (const [name, p] of Object.entries(config.providers)) {
    if (p.disabled) continue;
    try {
      const host = new URL(p.baseUrl).hostname;
      if (host === "api.x.ai" || host === "cli-chat-proxy.grok.com") return { name, provider: p };
    } catch { /* invalid baseUrl */ }
  }
  return undefined;
}

/** Compatibility helper for callers that still inspect image API-key readiness directly. */
export function resolveXaiImageApiKey(provider: CodexCommanderProviderConfig): string | undefined {
  if (provider.authMode === "oauth") return undefined;
  const apiKey = resolveEnvValue(provider.apiKey)?.trim();
  return apiKey || undefined;
}

export async function planImageBridge(
  config: CodexCommanderConfig,
  parsed: CodexCommanderParsedRequest,
  _routedProvider: CodexCommanderProviderConfig,
  credentialDeps: BindMediaCredentialDeps = {},
): Promise<ImageBridgePlan | undefined> {
  const route = resolveMediaRoute(config, "image");
  if (route.state !== "selected" || route.descriptor?.executor !== "xai-media-v1") return undefined;
  if (!parsed._imageGeneration) return undefined;
  let auth: ImageBridgePlan["auth"];
  try {
    auth = bindMediaCredential(config, credentialDeps);
  } catch {
    // An enabled-but-unready bridge is fail-closed. The existing/native tool remains
    // unavailable for this opted-in request rather than consulting another source.
    return undefined;
  }
  // The synthetic tool injected into the conversation is named IMAGE_GEN_TOOL_NAME,
  // which is what the model will actually call. Merge it with any original hosted tool names.
  const toolNames = new Set(parsed._imageGeneration.toolNames);
  toolNames.add(IMAGE_GEN_TOOL_NAME);
  const original = parsed._imageGeneration.originalTool;
  const hostedSize = typeof original?.size === "string" ? original.size : undefined;
  const hostedQuality = typeof original?.quality === "string" ? original.quality : undefined;
  const timeoutMs = clampImageTimeoutMs(config.images?.timeoutMs);
  const keepRaw = config.images?.artifactsKeepCount;
  const artifactsKeepCount =
    typeof keepRaw === "number" && Number.isFinite(keepRaw) ? Math.floor(keepRaw) : undefined;
  return {
    auth,
    model: config.images?.bridgeModel ?? route.descriptor.operations.image!.model,
    toolNames,
    ...(hostedSize ? { defaultSize: hostedSize } : {}),
    ...(hostedQuality ? { defaultQuality: hostedQuality } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(artifactsKeepCount !== undefined ? { artifactsKeepCount } : {}),
  };
}

export const XAI_VIDEO_MODEL = XAI_MEDIA_DESCRIPTOR.operations.video!.model;

/**
 * Decide whether the video bridge should activate for this request. Unlike images, video
 * generation has no hosted OpenAI tool type — the synthetic `video_gen` tool is unconditionally
 * injected when `videoBridgeEnabled` is true. The bridge activates only when:
 *   1. videoBridgeEnabled is explicitly true (opt-in)
 *   2. the exact configured credential source can be bound
 */
export async function planVideoBridge(
  config: CodexCommanderConfig,
  parsed: CodexCommanderParsedRequest,
  _routedProvider: CodexCommanderProviderConfig,
  credentialDeps: BindMediaCredentialDeps = {},
): Promise<VideoBridgePlan | undefined> {
  const route = resolveMediaRoute(config, "video");
  if (route.state !== "selected" || route.descriptor?.executor !== "xai-media-v1") return undefined;
  let auth: VideoBridgePlan["auth"];
  try {
    auth = bindMediaCredential(config, credentialDeps);
  } catch {
    return undefined;
  }
  const toolNames = new Set<string>();
  toolNames.add(VIDEO_GEN_TOOL_NAME);
  // Collect any existing function tools whose name matches a video_gen alias
  // so the loop can intercept and replace them (image-bridge parity).
  for (const t of parsed.context?.tools ?? []) {
    // Skip namespaced tools — a namespaced MCP video_gen must not be intercepted.
    if (t.namespace) continue;
    const fnName = typeof t.name === "string" ? t.name
      : (t as unknown as { function?: { name?: string } }).function?.name;
    if (typeof fnName === "string" && isVideoGenName(fnName)) {
      toolNames.add(fnName);
    }
  }
  const timeoutMs = clampImageTimeoutMs(config.images?.videoTimeoutMs);
  const keepRaw = config.images?.artifactsKeepCount;
  const artifactsKeepCount =
    typeof keepRaw === "number" && Number.isFinite(keepRaw) ? Math.floor(keepRaw) : undefined;
  return {
    auth,
    // V1 is one audited wire contract. A legacy configurable slug cannot retarget paid work.
    model: route.descriptor.operations.video!.model,
    toolNames,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(artifactsKeepCount !== undefined ? { artifactsKeepCount } : {}),
  };
}

import { resolveEnvValue } from "../config";
import { resolveCodexTaskIdentity } from "../codex/task-identity";
import { expandPreviousResponseInput, previousResponseProviderState, previousResponseReplayFailure } from "./state";
import { ownershipFingerprint } from "../codex/native-ownership";
import type { CodexCommanderProviderConfig } from "../types";
import type { CodexAuthContext } from "../codex/auth-context";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { classifyNativeArtifactProvenance, nativeOwner, type NativeOwner } from "../codex/native-ownership";

/** These headers are native protocol metadata, never a universal gateway allowlist. */
export const NATIVE_RESPONSES_HEADERS = [
  "x-codex-routing-hint", "x-codex-thread-id", "x-codex-turn-state", "x-codex-turn-metadata",
  "x-openai-internal-codex-responses-lite", "x-openai-memgen-request", "user-agent",
] as const;
export function isNativeResponsesProvider(provider: CodexCommanderProviderConfig): boolean {
  if (isCanonicalOpenAiForwardProvider(provider)) return true;
  try {
    const url = new URL(provider.baseUrl);
    return provider.adapter === "openai-responses" && provider.authMode !== "forward"
      && url.origin === "https://api.openai.com" && /^\/v1\/?$/.test(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password
      && (provider.responsesPath === undefined || provider.responsesPath === "/responses");
  } catch { return false; }
}
export function nativeClientMetadata(body: unknown): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>).client_metadata : undefined;
}
export function nativeTurnId(headers: Headers, body: unknown): string | undefined {
  const values: unknown[] = [];
  const add = (value: unknown) => { if (value && typeof value === "object" && Object.hasOwn(value, "turn_id")) values.push((value as Record<string, unknown>).turn_id); };
  add(nativeClientMetadata(body));
  const encoded = headers.get("x-codex-turn-metadata");
  if (encoded) { try { add(JSON.parse(encoded)); } catch { return undefined; } }
  const first = values[0];
  return typeof first === "string" && first.length > 0 && first.length <= 512 && !/[\x00-\x20\x7f,]/.test(first)
    && values.every(value => value === first) ? first : undefined;
}
export function nativeRequestOwner(provider: CodexCommanderProviderConfig, headers: Headers, auth?: CodexAuthContext): NativeOwner | undefined {
  if (!isNativeResponsesProvider(provider)) return undefined;
  if (auth && auth.kind !== "main") return nativeOwner(auth.accountId, auth.kind === "pool" ? auth.generation : auth.accessToken);
  const credential = provider.authMode === "forward" ? headers.get("authorization") : provider.apiKey ? resolveEnvValue(provider.apiKey) : undefined;
  if (!credential) return undefined;
  // Direct/API credentials have no trusted logical account record. A credential fingerprint
  // identifies this exact context; it makes no claim about identity across token refreshes.
  return nativeOwner(provider.authMode === "forward" ? headers.get("chatgpt-account-id") ?? credential : credential, credential);
}
/** Local readable replay belongs to its task, or exact credential context if no task exists. */
export function nativeReplayScope(headers: Headers, body: unknown, owner?: NativeOwner): string | undefined {
  const identity = resolveCodexTaskIdentity(headers, nativeClientMetadata(body));
  if (identity.source === "conflict") return undefined;
  if (identity.taskId) return ownershipFingerprint("native-replay-task", identity.taskId);
  return owner ? ownershipFingerprint("native-replay-owner", `${owner.account}:${owner.generation}`) : undefined;
}
export function nativeCompatibilityPolicy(args: {
  provider: CodexCommanderProviderConfig; body: unknown; headers: Headers; owner?: NativeOwner;
  completeLocalReplay?: boolean; effectiveModel?: string; replayScope?: string; materializeReference?: boolean;
}): { native: boolean; headers: Headers; unavailable: boolean; body: unknown; replayed: boolean } {
  const native = isNativeResponsesProvider(args.provider);
  const headers = new Headers(args.headers);
  if (!native) { for (const name of NATIVE_RESPONSES_HEADERS) headers.delete(name); return { native, headers, unavailable: false, body: args.body, replayed: false }; }
  const record = args.body && typeof args.body === "object" ? args.body as Record<string, unknown> : undefined;
  const hint = headers.get("x-codex-routing-hint");
  if (hint) {
    const match = /^model=([^;]+)(?:;tier=([^;]+))?$/.exec(hint);
    const model = args.effectiveModel ?? record?.model;
    const tier = typeof record?.service_tier === "string" ? record.service_tier : undefined;
    if (!match || match[1] !== model || match[2] !== tier) headers.delete("x-codex-routing-hint");
  }
  const provenance = classifyNativeArtifactProvenance(args.body, headers, args.owner, nativeTurnId(headers, args.body));
  // Ciphertext is stateless history. Origin evidence is not proof of portability or
  // incompatibility: keep it byte-for-byte, including unknown and switched accounts.
  // Turn state is a server-issued routing token, not history; it cannot cross turns.
  if (provenance.turnState !== "same") headers.delete("x-codex-turn-state");
  // Preserve historical ChatGPT HTTP unsupported-parameter handling (38d1fea11),
  // not a newly verified rejection; see stripPreviousResponseId. Full-input turns
  // never consult or append cached history. API Responses can keep a known reference.
  const referenceNeedsReplay = record?.previous_response_id != null
    && (args.materializeReference === true || isCanonicalOpenAiForwardProvider(args.provider) || provenance.reference !== "same");
  let body = args.body;
  let replayed = args.completeLocalReplay === true;
  if (referenceNeedsReplay && !replayed && typeof record?.previous_response_id === "string" && args.replayScope) {
    const local = previousResponseProviderState(record.previous_response_id)?.native;
    if (local?.scope === args.replayScope) {
      const expanded = expandPreviousResponseInput(body);
      if (expanded !== body && !previousResponseReplayFailure(expanded)) { body = expanded; replayed = true; }
    }
  }
  return { native, headers, unavailable: referenceNeedsReplay && !replayed, body, replayed };
}

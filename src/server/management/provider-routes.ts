import { createHash } from "node:crypto";

import { hasOwnProvider, isValidProviderName, mutatePersistedConfig, providerHeadersConfigError, saveConfigPreservingClaudeCode, withConfigMutationLockSync } from "../../config";

import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { ProviderOutboundPolicyError, providerOutboundGet, providerRedirectError } from "../../lib/provider-outbound";
import { enrichProviderFromCatalog, isPublicCatalogOnlyKeyValidation } from "../../oauth/key-providers";
import { providerCredentialVerification } from "../../providers/credential-verification";
import { deriveProviderPresets, providerConfigSeed } from "../../providers/derive";
import { providerCodexAccountMode, providerMatchesRegistryTransport } from "../../providers/registry";
import {
  extractModelEnvelopeRows,
  extractProviderModelItems,
  readBoundedDiscoveryJson,
  resolveProviderModelDiscovery,
} from "../../providers/model-discovery";

import {
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  supportsProviderQuotaReporting,
} from "../../providers/quota";
import { CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { codexAccountNamespaceProviderCollisionError } from "../../codex/account-namespace-match";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { getProviderDiscoveryStatus } from "../../codex/model-cache";
import { globalContextCapValue, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";

import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { listProviderApiKeys } from "../../providers/api-keys";
import {
  MEDIA_ACTION_ATTESTATION_HEADER,
  MEDIA_ACTION_NONCE,
  type MediaActionAttestationInput,
} from "../../lib/media-action-attestation";

import type { CodexCommanderConfig, CodexCommanderProviderConfig } from "../../types";

import { jsonResponse, providerManagementConfigError, publicProviderBaseUrl } from "../auth-cors";

import { isPlainRecord, stripRegistryOnlyStaticHeaders } from "./shared";

import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";

function xaiProviderSensitiveState(provider: CodexCommanderProviderConfig): Record<string, unknown> {
  const sortedRecord = <T>(value: Record<string, T> | undefined): Record<string, T> => Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
  return {
    disabled: provider.disabled === true,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    responsesPath: provider.responsesPath ?? null,
    authMode: provider.authMode ?? null,
    apiKeyTransport: provider.apiKeyTransport ?? null,
    keyOptional: provider.keyOptional === true,
    allowPrivateNetwork: provider.allowPrivateNetwork === true,
    headers: sortedRecord(provider.headers),
    modelAdapters: sortedRecord(provider.modelAdapters),
    googleMode: provider.googleMode ?? null,
    project: provider.project ?? null,
    location: provider.location ?? null,
  };
}

/** Exact non-secret target bound into a single-use CLI media-action attestation. */
export function xaiProviderMutationAttestationId(
  method: "POST" | "PATCH",
  provider: CodexCommanderProviderConfig,
): string {
  const digest = createHash("sha256")
    .update("codexcommander-xai-provider-mutation-v1\0")
    .update(method)
    .update("\0")
    .update(JSON.stringify(xaiProviderSensitiveState(provider)))
    .digest("hex")
    .slice(0, 32);
  return `xai-provider-${method.toLowerCase()}-${digest}`;
}

const XAI_PROVIDER_ATTESTATION_FIELDS = new Set([
  "action",
  "target",
  "name",
  "id",
  "expectedRevision",
  "confirmation",
  "caller",
  "nonce",
  "issuedAt",
]);

type XaiProviderMutationAuthorization =
  | { kind: "confirmed-gui" }
  | { kind: "interactive-cli"; expectedRevision: number; targetId: string }
  | null;

function changesXaiProviderSensitiveState(
  current: CodexCommanderProviderConfig,
  next: CodexCommanderProviderConfig,
): boolean {
  return JSON.stringify(xaiProviderSensitiveState(current)) !== JSON.stringify(xaiProviderSensitiveState(next));
}

function xaiProviderSensitiveMutationRequiresAttestation(
  current: CodexCommanderProviderConfig | undefined,
  next: CodexCommanderProviderConfig,
): boolean {
  if (current) {
    if (!changesXaiProviderSensitiveState(current, next)) return false;
    // Turning the bridge's provider off only removes paid authority. Keep that
    // fail-safe operation available to ordinary management clients, while an
    // off -> on transition remains part of the exact attested target.
    if (current.disabled !== true && next.disabled === true) {
      const currentDisabled = { ...current, disabled: true };
      return changesXaiProviderSensitiveState(currentDisabled, next);
    }
    return true;
  }

  // Preserve the ordinary first-login/bootstrap path: materializing the exact
  // registry-owned OAuth destination does not arm an API key for chat. Every
  // other destination/auth shape is human-authorized even before a key exists,
  // so it cannot be staged ahead of a separately confirmed first media-key add.
  const registry = getProviderRegistryEntry("xai");
  if (!registry) return true;
  return JSON.stringify(xaiProviderSensitiveState(next))
    !== JSON.stringify(xaiProviderSensitiveState(providerConfigSeed(registry)));
}

function xaiProviderAttestationRequired(ctx: ManagementContext): Response {
  return jsonResponse({
    error: "changing the canonical xAI provider destination or chat authentication requires a confirmed GUI or fresh CLI attestation",
    code: "xai_media_key_attestation_required",
  }, 403, ctx.req, ctx.config);
}

function authorizeXaiProviderSensitiveMutation(
  ctx: ManagementContext,
  body: Record<string, unknown>,
  method: "POST" | "PATCH",
  current: CodexCommanderProviderConfig | undefined,
  next: CodexCommanderProviderConfig,
): { authorization: XaiProviderMutationAuthorization } | { response: Response } {
  if (!xaiProviderSensitiveMutationRequiresAttestation(current, next)) {
    return { authorization: null };
  }
  if (ctx.principal === "confirmed-gui-session") {
    return { authorization: { kind: "confirmed-gui" } };
  }
  const expectedRevision = body.expectedRevision;
  const targetId = xaiProviderMutationAttestationId(method, next);
  const validEnvelope = ctx.principal === "admin-token"
    && body.action === "settings"
    && body.target === "settings"
    && body.name === "xai"
    && body.id === targetId
    && Number.isSafeInteger(expectedRevision)
    && (expectedRevision as number) >= 0
    && body.confirmation === true
    && body.caller === "interactive_cli"
    && typeof body.nonce === "string"
    && MEDIA_ACTION_NONCE.test(body.nonce)
    && Number.isSafeInteger(body.issuedAt)
    && (body.issuedAt as number) > 0;
  if (
    !validEnvelope
    || ctx.deps.mediaManagement?.authorizeInteractiveCliAction?.(
      body as unknown as MediaActionAttestationInput,
      ctx.req.headers.get(MEDIA_ACTION_ATTESTATION_HEADER),
    ) !== true
  ) {
    return { response: xaiProviderAttestationRequired(ctx) };
  }
  return {
    authorization: {
      kind: "interactive-cli",
      expectedRevision: expectedRevision as number,
      targetId,
    },
  };
}

function finalXaiProviderAuthorizationError(
  authorization: XaiProviderMutationAuthorization,
  method: "POST" | "PATCH",
  persisted: CodexCommanderConfig,
  current: CodexCommanderProviderConfig | undefined,
  next: CodexCommanderProviderConfig,
): "attestation_required" | "stale" | null {
  if (authorization?.kind === "interactive-cli" && (
    listProviderApiKeys(persisted, "xai").revision !== authorization.expectedRevision
    || xaiProviderMutationAttestationId(method, next) !== authorization.targetId
  )) return "stale";
  if (!xaiProviderSensitiveMutationRequiresAttestation(current, next)) return null;
  if (authorization?.kind === "confirmed-gui") return null;
  if (!authorization) return "attestation_required";
  return null;
}

function stripXaiProviderPatchAttestation(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !XAI_PROVIDER_ATTESTATION_FIELDS.has(key)));
}

type ProviderPatchApplication =
  | { error: string }
  | {
      next: CodexCommanderProviderConfig;
      touched: boolean;
      editorTouched: boolean;
      enablingOpenAi: boolean;
      headersTouched: boolean;
    };

/**
 * Apply the recognized PATCH field mask onto a provider copy. The caller runs this once
 * for validation and again inside the config mutation lock against the newest provider,
 * so a concurrent PATCH cannot be erased by a save of a stale snapshot. Only synchronous
 * checks live here; the async destination probe stays in the route.
 */
function applyProviderPatchFields(
  name: string,
  provider: CodexCommanderProviderConfig,
  rawBody: Record<string, unknown>,
  keys: string[],
  config: CodexCommanderConfig,
): ProviderPatchApplication {
  const next: CodexCommanderProviderConfig = { ...provider };
  let touched = false;
  let headersTouched = false;

  if (Object.hasOwn(rawBody, "disabled")) {
    if (typeof rawBody.disabled !== "boolean") return { error: "disabled must be a boolean" };
    if (rawBody.disabled && name === config.defaultProvider) {
      return { error: "cannot disable the default provider; set another default first" };
    }
    next.disabled = rawBody.disabled;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "adapter")) {
    if (typeof rawBody.adapter !== "string" || !rawBody.adapter.trim()) return { error: "adapter must be a non-empty string" };
    next.adapter = rawBody.adapter.trim();
    touched = true;
  }
  if (Object.hasOwn(rawBody, "baseUrl")) {
    if (typeof rawBody.baseUrl !== "string" || !rawBody.baseUrl.trim()) return { error: "baseUrl must be a non-empty string" };
    next.baseUrl = rawBody.baseUrl.trim();
    touched = true;
  }
  if (Object.hasOwn(rawBody, "defaultModel")) {
    if (typeof rawBody.defaultModel !== "string") return { error: "defaultModel must be a string" };
    const dm = rawBody.defaultModel.trim();
    if (dm) next.defaultModel = dm;
    else delete next.defaultModel;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "authMode")) {
    if (typeof rawBody.authMode !== "string") return { error: "authMode must be a string" };
    const mode = rawBody.authMode.trim();
    if (mode === "key" || mode === "forward" || mode === "oauth" || mode === "local") {
      next.authMode = mode;
      touched = true;
    } else if (mode === "") {
      delete next.authMode;
      touched = true;
    } else {
      return { error: "authMode must be key, forward, oauth, or local" };
    }
  }
  if (Object.hasOwn(rawBody, "apiKeyTransport")) {
    const transport = rawBody.apiKeyTransport;
    if (transport === "x-api-key" || transport === "bearer") {
      next.apiKeyTransport = transport;
      touched = true;
    } else if (transport === "") {
      delete next.apiKeyTransport;
      touched = true;
    } else {
      return { error: "apiKeyTransport must be x-api-key, bearer, or empty to clear" };
    }
  }
  if (Object.hasOwn(rawBody, "note")) {
    if (typeof rawBody.note !== "string") return { error: "note must be a string" };
    const note = rawBody.note.trim();
    if (note) next.note = note;
    else delete next.note;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "allowPrivateNetwork")) {
    if (typeof rawBody.allowPrivateNetwork !== "boolean") return { error: "allowPrivateNetwork must be a boolean" };
    next.allowPrivateNetwork = rawBody.allowPrivateNetwork;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "liveModels")) {
    if (typeof rawBody.liveModels !== "boolean") return { error: "liveModels must be a boolean" };
    next.liveModels = rawBody.liveModels;
    touched = true;
  }

  // headers is the one object-valued field in the mask. PATCH semantics merge it
  // shallowly into the existing block so a single fingerprint header can be added
  // without wiping the rest; null or an empty object clears user-managed headers.
  if (Object.hasOwn(rawBody, "headers")) {
    const headersValue = rawBody.headers;
    if (headersValue === null || (isPlainRecord(headersValue) && Object.keys(headersValue).length === 0)) {
      // Registry-owned static metadata (e.g. opencode-free's x-opencode-client marker)
      // is not user-managed: restoring it keeps the upstream transport intact after a
      // clear instead of deleting the whole block.
      const entry = getProviderRegistryEntry(name);
      if (entry?.staticHeaders && providerMatchesRegistryTransport(name, next)) {
        next.headers = { ...entry.staticHeaders };
      } else {
        delete next.headers;
      }
    } else {
      if (!isPlainRecord(headersValue)) return { error: "headers must be an object" };
      const headersError = providerHeadersConfigError(headersValue);
      if (headersError) return { error: headersError };
      // Header names are case-insensitive on the wire. Drop any existing key whose
      // lowercase name collides with an incoming one, or Headers normalization would
      // send a combined "x-custom: v1, v2" value upstream.
      const incoming = new Map(
        Object.entries(headersValue as Record<string, string>).map(([key, value]) => [key.toLowerCase(), [key, value] as const]),
      );
      const merged: Record<string, string> = {};
      for (const [key, value] of Object.entries(next.headers ?? {})) {
        if (!incoming.has(key.toLowerCase())) merged[key] = value;
      }
      for (const [key, value] of incoming.values()) merged[key] = value;
      next.headers = merged;
    }
    touched = true;
    headersTouched = true;
  }

  if (!touched) return { error: "no recognized fields to update" };

  // A disabled-only toggle preserves the v2 fast lane for non-openai providers: it changes
  // routing eligibility, not the provider shape. Re-enabling `openai` is different — a
  // malformed disabled row must not come back online unchanged, so canonicalize/reject
  // against the same built-in gate used by mode PATCH and POST.
  const editorTouched = keys.some(key => key !== "disabled");
  const enablingOpenAi = name === "openai"
    && Object.hasOwn(rawBody, "disabled")
    && rawBody.disabled === false
    && provider.disabled === true;
  if (!editorTouched && enablingOpenAi) {
    if (!isCanonicalOpenAiForwardProvider(next)) {
      return { error: "provider openai must be the canonical built-in provider" };
    }
    // Persist the byte-identical canonical URL so config.ts startup checks (case-sensitive)
    // accept the row after we fill mode. Equivalent hosts like CHATGPT.com/:443 normalize here.
    next.baseUrl = CODEX_FORWARD_BASE_URL;
    // Fill missing mode so a disabled canonical row becomes a complete live openai entry.
    if (next.codexAccountMode !== "pool" && next.codexAccountMode !== "direct") {
      next.codexAccountMode = "pool";
    }
    if (next.disabled === false) delete next.disabled;
    // Canonical openai never uses private-network opt-in; drop a stale flag that
    // was ignored for the DNS probe so it cannot linger on the live row.
    delete next.allowPrivateNetwork;
  }
  return { next, touched, editorTouched, enablingOpenAi, headersTouched };
}

export async function handleProviderRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, convergeCodexCatalog } = ctx;

  if (url.pathname === "/api/provider-quotas" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    return jsonResponse(await fetchProviderQuotaReports(config, forceRefresh));
  }

  if (url.pathname === "/api/providers" && req.method === "GET") {
    return jsonResponse(Object.entries(config.providers).map(([name, p]) => ({
      name, adapter: p.adapter, baseUrl: publicProviderBaseUrl(p.baseUrl), defaultModel: p.defaultModel,
      hasApiKey: !!p.apiKey,
      // Presence only (#959 review): header names and values never leave the process.
      hasHeaders: !!p.headers && Object.keys(p.headers).length > 0,
      allowPrivateNetwork: p.allowPrivateNetwork === true,
      liveModels: p.liveModels !== false,
      models: p.models ?? [],
      authMode: p.authMode,
      apiKeyTransport: p.apiKeyTransport,
      disabled: p.disabled === true,
      quotaCapable: supportsProviderQuotaReporting(name, p),
      codexAccountMode: providerCodexAccountMode(name, p),
      discovery: p.liveModels === false ? undefined : getProviderDiscoveryStatus(name),
    })));
  }

  // Add (or overwrite) a single provider. Merges into the live in-memory config and
  // persists — existing providers' real keys are never round-tripped (unlike PUT /api/config,
  // which would re-save the masked keys from GET). Live routing picks it up immediately.
  if (url.pathname === "/api/providers" && req.method === "POST") {
    let body: { name?: unknown; provider?: unknown; setDefault?: boolean };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const providerError = providerManagementConfigError(name, body.provider);
    if (providerError) return jsonResponse({ error: providerError }, 400);
    if (
      name === "xai"
      && isPlainRecord(body.provider)
      && (Object.hasOwn(body.provider, "apiKey") || Object.hasOwn(body.provider, "apiKeyPool"))
    ) {
      return jsonResponse({
        error: "canonical xAI credentials cannot be written through provider replacement; use the attested provider API-key endpoints",
        code: "xai_media_key_attestation_required",
      }, 403);
    }
    const prov = body.provider ? stripCodexRuntimeProviderFields(body.provider as CodexCommanderProviderConfig) : undefined;
    if (!name || !prov?.adapter || !prov?.baseUrl) {
      return jsonResponse({ error: "name, provider.adapter and provider.baseUrl are required" }, 400);
    }
    if (!isValidProviderName(name)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    const namespaceCollision = codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, name);
    if (namespaceCollision) {
      return jsonResponse({ error: namespaceCollision }, 409);
    }
    // Hostname destinations additionally get a DNS-resolved SSRF check at write time —
    // the sync check above only classifies literal IPs (review finding, PR #96).
    // Canonical openai still runs the resolver: only Clash fake-IP (198.18.0.0/15)
    // answers are ignored; loopback/RFC1918/metadata/mixed sets still fail.
    const allowBenchmarkAddresses = name === "openai" && isCanonicalOpenAiForwardProvider(prov);
    const resolvedError = await providerDestinationResolvedError(name, prov, { allowBenchmarkAddresses });
    if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    if (body.setDefault !== undefined && typeof body.setDefault !== "boolean") {
      return jsonResponse({ error: "setDefault must be a boolean" }, 400);
    }
    if (body.setDefault === true && prov.disabled) {
      return jsonResponse({ error: "cannot set a disabled provider as default", code: "default_provider_disabled" }, 400);
    }
    // Catalog providers (e.g. ollama-cloud) carry a models + vision/reasoning classification the GUI
    // doesn't send — merge it in so the sidecars are gated correctly.
    enrichProviderFromCatalog(name, prov);
    if (name === "xai") {
      const authorized = authorizeXaiProviderSensitiveMutation(
        ctx,
        body as Record<string, unknown>,
        "POST",
        config.providers.xai,
        prov,
      );
      if ("response" in authorized) return authorized.response;
      // Provider replacement owns chat/routing fields, never the canonical xAI
      // media-key pool. Preserve credentials from the final persisted snapshot
      // under the same lock used by attested xAI key mutations. In particular,
      // never carry a pre-await credential snapshot across destination probing.
      const replacement = structuredClone(prov);
      type XaiPostValue =
        | { kind: "applied"; config: CodexCommanderConfig }
        | { kind: "attestation_required" | "stale"; config: CodexCommanderConfig };
      const outcome = mutatePersistedConfig<XaiPostValue>(persisted => {
        const next = structuredClone(replacement);
        const existing = persisted.providers.xai;
        if (existing?.apiKey !== undefined) next.apiKey = existing.apiKey;
        if (existing?.apiKeyPool !== undefined) next.apiKeyPool = structuredClone(existing.apiKeyPool);
        const authorizationError = finalXaiProviderAuthorizationError(
          authorized.authorization,
          "POST",
          persisted,
          existing,
          next,
        );
        if (authorizationError) {
          return { changed: false, value: { kind: authorizationError, config: persisted } };
        }
        persisted.providers.xai = stripRegistryOnlyStaticHeaders(name, next);
        if (body.setDefault === true) persisted.defaultProvider = name;
        return { changed: true, value: { kind: "applied", config: persisted } };
      });
      if (outcome.status === "unavailable") {
        return jsonResponse({ error: `xAI provider config ${outcome.reason}` }, 409);
      }
      if (outcome.value.config.providers.xai) {
        config.providers.xai = structuredClone(outcome.value.config.providers.xai);
      } else {
        delete config.providers.xai;
      }
      if (outcome.value.kind === "attestation_required") return xaiProviderAttestationRequired(ctx);
      if (outcome.value.kind === "stale") {
        return jsonResponse({
          error: "xAI provider or protected key-pool state changed after confirmation",
          code: "stale_xai_provider_mutation",
        }, 409, ctx.req, ctx.config);
      }
      if (body.setDefault === true) config.defaultProvider = outcome.value.config.defaultProvider;
    } else {
      const { saveConfigPreservingClaudeCode: save } = await import("../../config");
      config.providers[name] = stripRegistryOnlyStaticHeaders(name, prov);
      if (body.setDefault === true) config.defaultProvider = name;
      save(config);
    }
    reconcileLiveStateStores();
    const { clearModelCache } = await import("../../codex/model-cache");
    clearModelCache(name);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ success: true, name, catalogRefresh });
  }

  if (url.pathname === "/api/providers" && req.method === "PATCH") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    let rawBody: unknown;
    try { rawBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(rawBody)) return jsonResponse({ error: "provider patch body must be a plain object" }, 400);
    const requestBody = rawBody as Record<string, unknown>;
    const patchBody = name === "xai" ? stripXaiProviderPatchAttestation(requestBody) : requestBody;
    const keys = Object.keys(patchBody);
    const hasMode = Object.hasOwn(patchBody, "codexAccountMode");
    const hasSetDefault = Object.hasOwn(patchBody, "setDefault");

    // codexAccountMode keeps its dedicated side-effect path (quota cache clear, thread map
    // clear, pool prime) and is mutually exclusive with every other patch field.
    if (hasMode) {
      if (keys.length !== 1) {
        return jsonResponse({ error: "codexAccountMode cannot be combined with other patch fields" }, 400);
      }
      if (name !== "openai") return jsonResponse({ error: "codexAccountMode is valid only for provider openai" }, 400);
      const mode = patchBody.codexAccountMode;
      if (mode !== "pool" && mode !== "direct") {
        return jsonResponse({ error: "codexAccountMode must be pool or direct" }, 400);
      }
      const provider = config.providers.openai;
      if (!provider || !isCanonicalOpenAiForwardProvider(provider)) {
        return jsonResponse({ error: "provider openai must be the canonical built-in provider" }, 400);
      }
      const { saveConfigPreservingClaudeCode: save } = await import("../../config");
      config.providers.openai = { ...provider, codexAccountMode: mode };
      save(config);
      reconcileLiveStateStores();
      (deps.clearProviderQuotaCache ?? clearProviderQuotaCache)();
      (deps.clearThreadAccountMap ?? clearThreadAccountMap)();
      if (mode === "pool") {
        try {
          const prime = deps.primeCodexPoolQuotas ?? primeCodexPoolQuotas;
          void Promise.resolve(prime(config, "mode-change")).catch(() => undefined);
        } catch {
          // Quota priming is best-effort; the persisted live mode is already authoritative.
        }
      }
      return jsonResponse({ success: true, name: "openai", codexAccountMode: mode });
    }

    // Default-provider changes must be a deliberate, standalone action. This keeps
    // routing changes out of ordinary provider edits and lets the dashboard expose a
    // simple "Set as default" control without round-tripping the full config.
    if (hasSetDefault) {
      if (keys.length !== 1 || patchBody.setDefault !== true) {
        return jsonResponse({ error: "setDefault must be true and cannot be combined with other patch fields" }, 400);
      }
      if (config.providers[name]!.disabled) {
        return jsonResponse({ error: "cannot set a disabled provider as default", code: "default_provider_disabled" }, 400);
      }
      const { saveConfigPreservingClaudeCode: save } = await import("../../config");
      config.defaultProvider = name;
      save(config);
      reconcileLiveStateStores();
      return jsonResponse({ success: true, name, defaultProvider: name });
    }

    // Field-mask editor: apply recognized fields onto a copy, then validate the MERGED
    // provider (canonical-seed guard covers openai; local-guard covers registry key providers).
    // API keys are never writable here — the api-keys endpoints own pool-integrated key writes.
    if (Object.hasOwn(patchBody, "apiKey")) {
      return jsonResponse({ error: "apiKey cannot be patched here; use the provider API-key endpoints" }, 400);
    }
    const applied = applyProviderPatchFields(name, config.providers[name]!, patchBody, keys, config);
    if ("error" in applied) return jsonResponse({ error: applied.error }, 400);
    const next = applied.next;
    const xaiAuthorization = name === "xai"
      ? authorizeXaiProviderSensitiveMutation(ctx, requestBody, "PATCH", config.providers.xai, next)
      : { authorization: null as XaiProviderMutationAuthorization };
    if ("response" in xaiAuthorization) return xaiAuthorization.response;

    if (applied.editorTouched) {
      const providerError = providerManagementConfigError(name, next);
      if (providerError) return jsonResponse({ error: providerError }, 400);
      const resolvedError = await providerDestinationResolvedError(name, next);
      if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    } else if (applied.enablingOpenAi) {
      // Same DNS gate as POST: Clash fake-IP only. Never honor a persisted
      // allowPrivateNetwork on this path — it must not bypass the built-in guard.
      const resolvedError = await providerDestinationResolvedError(
        "openai",
        { baseUrl: CODEX_FORWARD_BASE_URL },
        { allowBenchmarkAddresses: true },
      );
      if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    }

    // The live config is shared and the destination probe above is awaited. Re-apply the
    // mask onto the newest provider under the mutation lock right before saving, so two
    // concurrent PATCHes updating different fields/headers both survive instead of the
    // later save clobbering the earlier snapshot.
    let replayError: string | undefined;
    if (name === "xai") {
      type XaiPatchValue =
        | { kind: "applied"; config: CodexCommanderConfig }
        | { kind: "attestation_required" | "stale" | "invalid" | "missing"; config: CodexCommanderConfig; error?: string };
      const outcome = mutatePersistedConfig<XaiPatchValue>(persisted => {
        const current = persisted.providers.xai;
        if (!current) return { changed: false, value: { kind: "missing", config: persisted } };
        const replay = applyProviderPatchFields(name, current, patchBody, keys, persisted);
        if ("error" in replay) {
          return { changed: false, value: { kind: "invalid", config: persisted, error: replay.error } };
        }
        if (replay.editorTouched) {
          const syncError = providerManagementConfigError(name, replay.next);
          if (syncError) {
            return { changed: false, value: { kind: "invalid", config: persisted, error: syncError } };
          }
        }
        const authorizationError = finalXaiProviderAuthorizationError(
          xaiAuthorization.authorization,
          "PATCH",
          persisted,
          current,
          replay.next,
        );
        if (authorizationError) {
          return { changed: false, value: { kind: authorizationError, config: persisted } };
        }
        persisted.providers.xai = replay.headersTouched
          ? replay.next
          : stripRegistryOnlyStaticHeaders(name, replay.next);
        return { changed: true, value: { kind: "applied", config: persisted } };
      });
      if (outcome.status === "unavailable") {
        return jsonResponse({ error: `xAI provider config ${outcome.reason}` }, 409);
      }
      if (outcome.value.config.providers.xai) {
        config.providers.xai = structuredClone(outcome.value.config.providers.xai);
      } else {
        delete config.providers.xai;
      }
      if (outcome.value.kind === "attestation_required") return xaiProviderAttestationRequired(ctx);
      if (outcome.value.kind === "stale") {
        return jsonResponse({
          error: "xAI provider or protected key-pool state changed after confirmation",
          code: "stale_xai_provider_mutation",
        }, 409, ctx.req, ctx.config);
      }
      if (outcome.value.kind === "missing") return jsonResponse({ error: "unknown provider" }, 404);
      if (outcome.value.kind === "invalid") {
        return jsonResponse({ error: outcome.value.error ?? "invalid xAI provider mutation" }, 409);
      }
    } else withConfigMutationLockSync(() => {
      const replay = applyProviderPatchFields(name, config.providers[name]!, patchBody, keys, config);
      if ("error" in replay) {
        replayError = replay.error;
        return;
      }
      if (replay.editorTouched) {
        const syncError = providerManagementConfigError(name, replay.next);
        if (syncError) {
          replayError = syncError;
          return;
        }
      } else if (replay.enablingOpenAi && !isCanonicalOpenAiForwardProvider(replay.next)) {
        replayError = "provider openai must be the canonical built-in provider";
        return;
      }
      // A PATCH that managed headers owns the resulting block: the clear path restores
      // registry static headers, so exact-match stripping must not erase them again.
      config.providers[name] = replay.headersTouched ? replay.next : stripRegistryOnlyStaticHeaders(name, replay.next);
      saveConfigPreservingClaudeCode(config);
    });
    if (replayError !== undefined) return jsonResponse({ error: replayError }, 409);
    reconcileLiveStateStores();
    if (applied.editorTouched || keys.includes("disabled")) {
      const { clearModelCache } = await import("../../codex/model-cache");
      clearModelCache(name);
    }
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({
      success: true,
      name,
      disabled: config.providers[name]!.disabled === true,
      hasApiKey: !!config.providers[name]!.apiKey,
      catalogRefresh,
    });
  }

  // Lightweight connectivity probe: perform the provider's live /models fetch DIRECTLY and
  // report only real upstream evidence. The catalog aggregate (fetchAllModels) deliberately
  // hides fetch failures behind stale/static fallbacks, so a catalog-presence check would
  // let a static-catalog provider with a fake key "pass" — this endpoint never uses it.
  if (url.pathname === "/api/providers/test" && req.method === "POST") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) {
      return jsonResponse({ error: "unknown provider" }, 404);
    }
    const prov = config.providers[name]!;
    if (prov.disabled) {
      return jsonResponse({ ok: false, error: "Provider is disabled", latencyMs: 0 });
    }
    if (prov.authMode === "forward") {
      return jsonResponse({
        ok: true,
        latencyMs: 0,
        message: "Passthrough provider is configured (forwards your Codex login; no upstream /models).",
      });
    }
    if (prov.liveModels === false) {
      // A static catalog has no live discovery endpoint to test. This is neither
      // positive connectivity evidence nor an outage, and it must stay before
      // credential resolution/network access for providers such as Antigravity.
      return jsonResponse({ applicable: false, reason: "static_catalog", latencyMs: 0 });
    }
    if (isPublicCatalogOnlyKeyValidation(name, prov.baseUrl)) {
      const credentialVerification = providerCredentialVerification(config, name);
      return jsonResponse({
        applicable: false,
        reason: "public_catalog",
        latencyMs: 0,
        credentialVerification,
        message: credentialVerification === "verified"
          ? "Credential verified by a successful inference. The public model catalog is not used as authentication evidence."
          : "The model catalog is public, so it cannot verify this key. CodexCommander will mark it verified after the first successful inference.",
      });
    }
    const { resolveModelsAuthToken, buildModelsRequest } = await import("../../oauth");
    const apiKey = await resolveModelsAuthToken(name, prov);
    if (prov.authMode === "oauth" && !apiKey) {
      return jsonResponse({ ok: false, latencyMs: 0, error: "static catalog only — upstream not verified (not logged in)" });
    }
    const { url: modelsUrl, headers } = buildModelsRequest(prov, apiKey, name);
    const discovery = resolveProviderModelDiscovery(name, prov);
    const started = Date.now();
    try {
      const res = await providerOutboundGet(name, prov, modelsUrl, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - started;
      const redirectError = await providerRedirectError(res, modelsUrl);
      if (redirectError) {
        return jsonResponse({
          ok: false,
          latencyMs,
          error: redirectError,
        });
      }
      if (!res.ok) {
        try {
          void res.body?.cancel().catch(() => undefined);
        } catch {
          // Best-effort release for non-conforming response streams.
        }
        return jsonResponse({ ok: false, latencyMs, error: `upstream /models returned ${res.status}` });
      }
      const bounded = await readBoundedDiscoveryJson(res, discovery.maxResponseBytes);
      if (!bounded.ok) {
        return jsonResponse({
          ok: false,
          latencyMs,
          error: bounded.reason === "response_too_large"
            ? `upstream /models exceeded the ${discovery.maxResponseBytes}-byte response limit`
            : "upstream /models returned invalid JSON",
        });
      }
      // OpenAI-style lists (and Together top-level arrays) use the same validation/dedupe/filter
      // as catalog discovery. Google's /v1beta/models uses `models[].name` and remains a
      // connectivity-only count because it is not an authoritative catalog source.
      const record = bounded.value !== null && typeof bounded.value === "object" && !Array.isArray(bounded.value)
        ? bounded.value as Record<string, unknown>
        : undefined;
      const extracted = Array.isArray(bounded.value) || Array.isArray(record?.data)
        ? extractProviderModelItems(bounded.value, discovery)
        : extractModelEnvelopeRows(bounded.value, discovery.maxModels, ["models"]);
      if (!extracted.ok) {
        return jsonResponse({
          ok: false,
          latencyMs,
          error: extracted.reason === "too_many_models"
            ? `upstream /models exceeded the ${discovery.maxModels}-row model limit`
            : "upstream /models returned an unexpected shape",
        });
      }
      const models = "items" in extracted ? extracted.items.length : extracted.rows.length;
      return jsonResponse({
        ok: true,
        latencyMs,
        models,
        message: `Connected — ${models} model${models === 1 ? "" : "s"} available.`,
      });
    } catch (err) {
      return jsonResponse({
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof ProviderOutboundPolicyError
          ? `upstream /models blocked by destination policy: ${err.message}`
          : err instanceof Error ? err.message : "Connection test failed",
      });
    }
  }

  if (url.pathname === "/api/providers" && req.method === "DELETE") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    type DeleteValue =
      | { kind: "deleted"; config: CodexCommanderConfig; fallbackDefault?: string }
      | { kind: "unknown"; config: CodexCommanderConfig }
      | { kind: "xai_key_attestation_required"; config: CodexCommanderConfig }
      | { kind: "last_provider"; config: CodexCommanderConfig }
      | { kind: "dependent_combos"; config: CodexCommanderConfig; combos: string[] };
    const outcome = mutatePersistedConfig<DeleteValue>(persisted => {
      if (!hasOwnProvider(persisted.providers, name)) {
        return { changed: false, value: { kind: "unknown", config: persisted } };
      }
      if (
        name === "xai"
        && (persisted.providers.xai?.apiKey !== undefined || persisted.providers.xai?.apiKeyPool !== undefined)
      ) {
        return { changed: false, value: { kind: "xai_key_attestation_required", config: persisted } };
      }
      // Config validation requires a default provider. Reassigning before deletion keeps
      // the persisted config valid and makes removal of the current default a one-step UI
      // operation. Object-key order is stable through JSON persistence.
      const fallbackDefault = name === persisted.defaultProvider
        ? Object.entries(persisted.providers)
          .find(([provider, providerConfig]) => provider !== name && providerConfig.disabled !== true)
          ?.[0]
        : undefined;
      if (name === persisted.defaultProvider && !fallbackDefault) {
        return { changed: false, value: { kind: "last_provider", config: persisted } };
      }
      const dependentCombos = Object.entries(persisted.combos ?? {})
        .filter(([, combo]) => combo.targets.some(target => target.provider === name))
        .map(([id]) => id)
        .sort((a, b) => a.localeCompare(b));
      if (dependentCombos.length > 0) {
        return { changed: false, value: { kind: "dependent_combos", config: persisted, combos: dependentCombos } };
      }
      if (fallbackDefault) persisted.defaultProvider = fallbackDefault;
      delete persisted.providers[name];
      setProviderContextCap(persisted, name, false);
      return { changed: true, value: { kind: "deleted", config: persisted, ...(fallbackDefault ? { fallbackDefault } : {}) } };
    });
    if (outcome.status === "unavailable") {
      return jsonResponse({ error: `provider config ${outcome.reason}` }, 409);
    }
    const result = outcome.value;
    if (result.kind === "unknown") return jsonResponse({ error: "unknown provider" }, 404);
    if (result.kind === "xai_key_attestation_required") {
      return jsonResponse({
        error: "remove canonical xAI credentials through the attested provider API-key endpoints before deleting the provider",
        code: "xai_media_key_attestation_required",
      }, 403);
    }
    if (result.kind === "last_provider") {
      return jsonResponse({
        error: "cannot delete the default provider when no enabled replacement remains",
        code: "last_provider",
      }, 409);
    }
    if (result.kind === "dependent_combos") {
      return jsonResponse({
        error: `cannot delete provider "${name}" while combos depend on it`,
        code: "provider_has_dependent_combos",
        combos: result.combos,
      }, 409);
    }
    config.providers = structuredClone(result.config.providers);
    config.defaultProvider = result.config.defaultProvider;
    config.providerContextCaps = result.config.providerContextCaps
      ? structuredClone(result.config.providerContextCaps)
      : undefined;
    reconcileLiveStateStores();
    const { clearModelCache: clearCache } = await import("../../codex/model-cache");
    clearCache(name);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ success: true, ...(result.fallbackDefault ? { defaultProvider: result.fallbackDefault } : {}), catalogRefresh });
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "GET") {
    return jsonResponse({ value: globalContextCapValue(config), caps: providerContextCaps(config) });
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "PUT") {
    let body: { provider?: unknown; enabled?: unknown; value?: unknown; setAll?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
    const { clearModelCache } = await import("../../codex/model-cache");
    const respond = (catalogRefresh: Awaited<ReturnType<typeof convergeCodexCatalog>>) => jsonResponse({
      ok: true,
      value: globalContextCapValue(config),
      caps: providerContextCaps(config),
      catalogRefresh,
    });

    // Branch 1: set the global cap value and re-point every enabled provider to it.
    // The GUI may include setAll so selecting a value and applying it is one atomic
    // policy change instead of briefly writing an unintended intermediate cap.
    if (body.value !== undefined) {
      if (typeof body.value !== "number" || !Number.isFinite(body.value) || !Number.isInteger(body.value) || body.value <= 0) {
        return jsonResponse({ error: "value must be a positive integer" }, 400);
      }
      if (body.setAll !== undefined && typeof body.setAll !== "boolean") {
        return jsonResponse({ error: "setAll must be a boolean" }, 400);
      }
      const before = Object.keys(providerContextCaps(config));
      const names = Object.keys(config.providers);
      setGlobalContextCapValue(config, body.value);
      if (typeof body.setAll === "boolean") {
        setAllProviderContextCaps(config, names, body.setAll);
      }
      save(config);
      reconcileLiveStateStores();
      for (const provider of new Set([...before, ...names])) clearModelCache(provider);
      const catalogRefresh = await convergeCodexCatalog();
      return respond(catalogRefresh);
    }

    // Branch 2: enable/clear the cap for every provider at once.
    if (body.setAll !== undefined) {
      if (typeof body.setAll !== "boolean") {
        return jsonResponse({ error: "setAll must be a boolean" }, 400);
      }
      const before = Object.keys(providerContextCaps(config));
      const names = Object.keys(config.providers);
      setAllProviderContextCaps(config, names, body.setAll);
      save(config);
      reconcileLiveStateStores();
      for (const provider of new Set([...before, ...names])) clearModelCache(provider);
      const catalogRefresh = await convergeCodexCatalog();
      return respond(catalogRefresh);
    }

    // Branch 3: existing per-provider toggle (enable writes the current global value).
    if (typeof body.provider !== "string" || typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "provider string and enabled boolean are required" }, 400);
    }
    const provider = body.provider.trim();
    if (!isValidProviderName(provider)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    if (!hasOwnProvider(config.providers, provider)) {
      return jsonResponse({ error: "unknown provider" }, 404);
    }
    setProviderContextCap(config, provider, body.enabled);
    save(config);
    reconcileLiveStateStores();
    clearModelCache(provider);
    const catalogRefresh = await convergeCodexCatalog();
    return respond(catalogRefresh);
  }

  // Complete GUI picker presets, derived from the canonical provider registry. The GUI is a
  // standalone Vite package, so it consumes this runtime view instead of importing repo-root src.
  if (url.pathname === "/api/provider-presets" && req.method === "GET") {
    return jsonResponse({ providers: deriveProviderPresets() });
  }
  return null;
}

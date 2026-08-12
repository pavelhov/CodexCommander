import { isOwnedProviderId, PROVIDER_ID } from "../identity";
import {
  hasInjectedOpenaiBaseUrl,
  hasInjectedCodexRouting,
} from "./injected-marker";

export type CodexRoutingKind =
  | "native"
  | "codexcommander-local"
  | "custom-local"
  | "custom-remote"
  | "unknown";

export type CodexRoutingDocument =
  | {
      readonly kind: "invalid";
      readonly content: string;
      readonly routingKind: "unknown";
      readonly effectiveProvider: null;
      readonly externalProvider: null;
    }
  | {
      readonly kind: "parsed";
      readonly content: string;
      readonly document: Record<string, unknown>;
      readonly routingKind: CodexRoutingKind;
      readonly effectiveProvider: string | null;
      readonly externalProvider: string | null;
    };

type RoutingEndpointKind = "local" | "remote" | "unknown";

export function routingDocumentTable(
  value: unknown,
): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function ipv4Octets(hostname: string): number[] | null {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    return octets.some((octet) => octet > 255) ? null : octets;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (!mapped) return null;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

function classifyRoutingEndpoint(value: string): RoutingEndpointKind {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    if (!hostname) return "unknown";
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return "local";
    if (hostname === "::" || hostname === "::1" || hostname === "0.0.0.0") return "local";
    const octets = ipv4Octets(hostname);
    if (octets) {
      if (octets.every((octet) => octet === 0)) return "local";
      if (octets[0] === 127) return "local";
      return "remote";
    }
    if (/^::ffff:/i.test(hostname)) return "unknown";
    return "remote";
  } catch {
    return "unknown";
  }
}

export function effectiveCodexProvider(
  document: Record<string, unknown>,
): string | null {
  let provider = typeof document.model_provider === "string"
    ? document.model_provider
    : null;
  const profile = typeof document.profile === "string" ? document.profile : null;
  const profiles = routingDocumentTable(document.profiles);
  const selected = profile && profiles
    ? routingDocumentTable(profiles[profile])
    : null;
  if (typeof selected?.model_provider === "string") {
    provider = selected.model_provider;
  }
  return provider;
}

function providerBaseUrl(
  document: Record<string, unknown>,
  provider: string,
): { readonly tableExists: boolean; readonly baseUrl: string | null } {
  const providers = routingDocumentTable(document.model_providers);
  if (!providers || !Object.hasOwn(providers, provider)) {
    return { tableExists: false, baseUrl: null };
  }
  const table = routingDocumentTable(providers[provider]);
  return {
    tableExists: true,
    baseUrl: typeof table?.base_url === "string" ? table.base_url : null,
  };
}

function classifyParsedRouting(
  content: string,
  document: Record<string, unknown>,
): CodexRoutingKind {
  if (typeof document.openai_base_url === "string") {
    const endpoint = classifyRoutingEndpoint(document.openai_base_url);
    if (endpoint === "unknown") return "unknown";
    if (hasInjectedOpenaiBaseUrl(content)) return "codexcommander-local";
    return endpoint === "local" ? "custom-local" : "custom-remote";
  }

  // Routing health historically observes the root provider rather than a
  // selected profile. Preserve that contract while sharing the same parse.
  const rootProvider = typeof document.model_provider === "string"
    ? document.model_provider
    : null;
  if (rootProvider) {
    const provider = providerBaseUrl(document, rootProvider);
    if (provider.baseUrl) {
      const endpoint = classifyRoutingEndpoint(provider.baseUrl);
      if (endpoint === "unknown") return "unknown";
      if (isOwnedProviderId(rootProvider)) return "codexcommander-local";
      return endpoint === "local" ? "custom-local" : "custom-remote";
    }
    if (isOwnedProviderId(rootProvider) || provider.tableExists || rootProvider !== "openai") {
      return "unknown";
    }
  }
  return "native";
}

/** Parse exactly once and derive every routing verdict from that document. */
export function observeCodexRoutingDocument(content: string): CodexRoutingDocument {
  let document: Record<string, unknown>;
  try {
    const parsed = Bun.TOML.parse(content.replace(/^\uFEFF/, ""));
    const table = routingDocumentTable(parsed);
    if (!table) throw new Error("Codex config is not a TOML document");
    document = table;
  } catch {
    return {
      kind: "invalid",
      content,
      routingKind: "unknown",
      effectiveProvider: null,
      externalProvider: null,
    };
  }
  const effectiveProvider = effectiveCodexProvider(document);
  const externalProvider = effectiveProvider
    && effectiveProvider !== "openai"
    && !isOwnedProviderId(effectiveProvider)
    ? effectiveProvider
    : null;
  return {
    kind: "parsed",
    content,
    document,
    routingKind: classifyParsedRouting(content, document),
    effectiveProvider,
    externalProvider,
  };
}

export function codexRoutingHasOwnedResidue(
  observation: CodexRoutingDocument,
  ownsCatalogPath: (path: string) => boolean,
): boolean {
  if (observation.kind === "invalid") return true;
  if (hasInjectedCodexRouting(observation.content)) return true;
  if (observation.effectiveProvider && isOwnedProviderId(observation.effectiveProvider)) return true;
  if (observation.document.model_provider === PROVIDER_ID) return true;
  const providers = routingDocumentTable(observation.document.model_providers);
  if (providers && Object.keys(providers).some(isOwnedProviderId)) return true;
  const catalog = observation.document.model_catalog_json;
  return typeof catalog === "string" && ownsCatalogPath(catalog);
}

/**
 * Config-only postcondition after the narrow native escape. Generated profile,
 * catalog, and cache files are deliberately outside this verdict once no
 * active config points at them.
 */
export function codexRoutingIsIndependentAfterNativeEscape(
  observation: CodexRoutingDocument,
  ownsCatalogPath: (path: string) => boolean,
): boolean {
  if (observation.kind === "invalid") return false;
  if (observation.externalProvider) return true;
  if (observation.effectiveProvider && isOwnedProviderId(observation.effectiveProvider)) {
    return false;
  }
  if (observation.content.includes("# Auto-injected by CodexCommander")) return false;
  if (codexRoutingHasOwnedResidue(observation, ownsCatalogPath)) return false;
  if (typeof observation.document.model === "string"
    && observation.document.model.includes("/")) return false;
  return true;
}

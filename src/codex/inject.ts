import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFile,
  loadConfig,
  observeConfigGeneration,
  readConfigAdmissionSnapshot,
  readConfigGenerationInCurrentMutationTransaction,
  subagentDefaultSyncEffective,
  withConfigMutationLockSync,
  websocketsEnabled,
} from "../config";
import {
  canonicalizeCodexHome,
  CodexWriteLockSkipped,
  withCodexWriteLock,
} from "./codex-write-lock";
import { shouldSyncCodexOnStart } from "./desired-state";
import {
  buildInjectWitness,
  captureCodexPreImages,
  codexInjectLockOutcome,
  codexWriteCoordinationEligibility,
  CodexPartialWriteError,
  CodexWriteConflictError,
  DEFAULT_INJECT_LOCK_TIMEOUT_MS,
  recomputeInjectWitness,
  restoreCodexPreImages,
} from "./inject-coordination";
import { readIntegrationRecord } from "./integration-record";
import { classifyNativeRoutedResidue } from "./native-residue";
import { inspectNativeCodexOwnership } from "../integrations/native/ownership-preflight";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "./user-identity";
import {
  retireJournalForExternalProvider,
  restoreJournalStateUnderCoordinatedWrite,
  writeJournal,
} from "./journal";
import { withCatalogWriteSerialization } from "./catalog-write-serialization";
import { restoreCodexCatalogWithPermit } from "./catalog/sync";
import { beginCodexCoordinatorTransaction } from "./transition-state";
import {
  isSectionMarkerLine,
  CCX_SECTION_MARKER,
  hasInjectedCodexRouting,
  hasInjectedOpenaiBaseUrl,
  isRootOpenaiBaseUrlLine,
  providerTableStart,
  providerTableString,
  rootTomlString,
  tomlStringPattern,
} from "./injected-marker";
import {
  API_KEY_HEADER,
  isOwnedProviderId,
  PROVIDER_ID,
} from "../identity";
import {
  CODEX_CONFIG_PATH,
  CODEX_PROFILE_PATH,
  DEFAULT_CATALOG_PATH,
  getCodexHome,
  parseTomlString,
  readRootTomlString,
  resolveCodexConfigPath,
  tomlString,
} from "./paths";
import { resolveEffectiveProjectModelProvider } from "./project-config-warnings";
import {
  transformManagedSubagentDefaults,
  type ManagedSubagentDefaults,
} from "./subagent-defaults";
import type { CodexCommanderConfig } from "../types";
import type { ConfigGeneration } from "./convergence-types";
import {
  captureCatalogConfigAuthority,
  type CatalogConfigAuthoritySnapshot,
} from "./catalog-admission";

// Ownership predicates live in `./injected-marker` so `journal.ts` can reach them
// without importing this module back. Re-exported for existing external callers.
export { hasInjectedCodexRouting, hasInjectedOpenaiBaseUrl };

export function externalCodexModelProvider(content: string): string | null {
  const provider = resolveEffectiveProjectModelProvider(content).provider;
  return provider && provider !== "openai" && !isOwnedProviderId(provider)
    ? provider
    : null;
}

export function currentExternalCodexModelProvider(): string | null {
  if (!existsSync(CODEX_CONFIG_PATH)) return null;
  return externalCodexModelProvider(readFileSync(CODEX_CONFIG_PATH, "utf8"));
}

/**
 * Detect the file's dominant line ending. Every transform in this module is LF-pure
 * (split("\n") + hard "\n" joins), so CRLF configs (Windows-edited config.toml) are
 * normalized to LF at the pipeline boundary and converted back on write — otherwise a
 * single inject would leave a mixed-EOL file.
 */
export function dominantEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const bareLf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf >= bareLf ? "\r\n" : "\n";
}

/** Normalize all line endings to `eol` (CRLF first collapsed to LF, then expanded). */
export function applyEol(content: string, eol: "\r\n" | "\n"): string {
  const lf = content.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

/**
 * Design B (2026-07-06): loopback installs no longer re-tag the provider. Instead of
 * `model_provider = "codexcommander"` + a `[model_providers.codexcommander]` table, we set the official
 * built-in override `openai_base_url` (codex-rs config_toml.rs) so codex's own `openai`
 * provider points at the proxy. Threads keep `model_provider = "openai"`, so history never
 * needs remapping or restore. Non-loopback binds use a provider table because the
 * built-in provider cannot carry the `x-codexcommander-api-key` env header.
 */

export interface InjectCodexOptions {
  /**
   * Absolute or CODEX_HOME-relative catalog path to advertise to Codex. Pass `null` only when the
   * codexcommander catalog could not be materialized; Codex will then keep its native catalog instead of
   * failing on a missing model_catalog_json file.
   */
  catalogPath?: string | null;
  /**
   * How long to wait for the Codex write lock before reporting contention.
   *
   * Bounded by default so a stuck holder cannot wedge `ccx start`; an explicit
   * caller that is willing to wait can raise it.
   */
  lockTimeoutMs?: number;
  /**
   * Preserve-only guard for a caller that already observed an external
   * model_provider. If that exact provider is no longer active when the config
   * is re-read, refuse before any native injection or journal mutation.
   */
  expectedExternalProvider?: string;
  /** Catalog admission generation that must still hold at native config publication. */
  expectedConfigGeneration?: ConfigGeneration;
  /** Exact catalog-admitted config authority, including non-cooperating byte drift. */
  expectedConfigAuthority?: CatalogConfigAuthoritySnapshot;
  /** Preserve-only fence for non-disruptive management reconciliation. */
  expectedRoutingKind?: CodexRoutingKind;
}

function configuredManagedSubagentDefaults(
  config:
    | Pick<
        CodexCommanderConfig,
        "injectionModel" | "injectionEffort" | "syncCodexSubagentDefaults"
      >
    | undefined,
): ManagedSubagentDefaults | null {
  if (!subagentDefaultSyncEffective(config ?? {})) return null;
  return {
    model: config!.injectionModel!.trim(),
    ...(config!.injectionEffort?.trim()
      ? { reasoningEffort: config!.injectionEffort.trim() }
      : {}),
  };
}

/**
 * The `[model_providers.codexcommander]` TABLE only. A table is position-independent in TOML, so it is
 * safe to append at EOF. The bare root key `model_provider = "codexcommander"` is NOT included here —
 * it must live at the document root (before any table header) and is set separately by
 * setRootModelProvider(). Appending the bare key at EOF was the original bug: it nested under
 * whatever `[table]` happened to be open last (e.g. `[plugins."chrome@openai-bundled"]`), so Codex
 * never saw a global model_provider and silently fell back to the `openai` (ChatGPT) provider.
 */
/**
 * True only for hostnames that bind loopback ONLY. Wildcard binds ("0.0.0.0", "::") are NOT
 * loopback: they expose the proxy on every interface and therefore require the admission token.
 * Do not use `providerBaseHost` for this decision — it folds wildcards to 127.0.0.1 because it
 * answers "what address do I dial", which is a different question from "is this exposed".
 */
export function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function providerBaseHost(hostname: string | undefined): string {
  const trimmed = (hostname ?? "127.0.0.1").trim();
  const lower = trimmed.toLowerCase();
  // Match what the server actually binds. Writing "localhost" while binding IPv4-only
  // 127.0.0.1 breaks on Windows, where localhost commonly resolves to ::1 first.
  if (lower === "::1" || lower === "[::1]") return "[::1]";
  if (
    isLoopbackHostname(trimmed) ||
    trimmed === "0.0.0.0" ||
    trimmed === "::" ||
    trimmed === "[::]"
  )
    return "127.0.0.1";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

export function shouldInjectApiAuthHeader(
  config: Pick<CodexCommanderConfig, "hostname"> | undefined,
): boolean {
  return !isLoopbackHostname(config?.hostname);
}

export function buildProviderTableBlock(
  port: number,
  supportsWebsockets = false,
  includeApiAuthHeader = false,
  hostname?: string,
): string {
  const host = providerBaseHost(hostname);
  const lines = [
    "",
    CCX_SECTION_MARKER,
    `[model_providers.${PROVIDER_ID}]`,
    'name = "CodexCommander Proxy"',
    `base_url = "http://${host}:${port}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
  ];
  if (includeApiAuthHeader) {
    lines.push(
      `env_http_headers = { "${API_KEY_HEADER}" = "CODEXCOMMANDER_API_AUTH_TOKEN" }`,
    );
  }
  if (supportsWebsockets) lines.push("supports_websockets = true");
  return lines.join("\n") + "\n";
}

export function buildOpenaiBaseUrlLine(
  port: number,
  hostname?: string,
): string {
  return `openai_base_url = "http://${providerBaseHost(hostname)}:${port}/v1"`;
}

/**
 * Design B root-key injection: place `CCX_SECTION_MARKER` + `openai_base_url` at the document
 * ROOT (before the first table header). Idempotent: an existing marker-owned line is rewritten
 * in place. A user's OWN root `openai_base_url` (no marker above it) is respected — we keep it
 * and inject nothing, reporting `keptUserBaseUrl` so the caller can surface it.
 */
export function setRootOpenaiBaseUrl(
  content: string,
  port: number,
  hostname?: string,
): { content: string; keptUserBaseUrl: boolean } {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const key = buildOpenaiBaseUrlLine(port, hostname);

  for (let i = 0; i < rootEnd; i++) {
    if (!isRootOpenaiBaseUrlLine(lines[i])) continue;
    const markerOwned = i > 0 && isSectionMarkerLine(lines[i - 1]!);
    if (!markerOwned) return { content, keptUserBaseUrl: true };
    lines[i] = key;
    return { content: lines.join("\n"), keptUserBaseUrl: false };
  }

  if (firstTable === -1) {
    return {
      content:
        content.replace(/\n+$/, "") +
        "\n" +
        CCX_SECTION_MARKER +
        "\n" +
        key +
        "\n",
      keptUserBaseUrl: false,
    };
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, CCX_SECTION_MARKER, key);
  return { content: lines.join("\n"), keptUserBaseUrl: false };
}

/**
 * Remove the marker-owned root `openai_base_url` (marker line + the key line right after it).
 * A user's own root override (no marker) survives; an orphaned marker with no key line after
 * it is dropped too so repeated strip/inject cycles cannot accumulate marker comments.
 */
export function stripInjectedOpenaiBaseUrl(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const drop = new Set<number>();
  for (let i = 0; i < rootEnd; i++) {
    if (!isSectionMarkerLine(lines[i])) continue;
    if (i + 1 < rootEnd && isRootOpenaiBaseUrlLine(lines[i + 1])) {
      drop.add(i);
      drop.add(i + 1);
    } else if (i + 1 >= rootEnd || lines[i + 1].trim() === "") {
      drop.add(i); // orphaned marker at root
    }
  }
  if (drop.size === 0) return content;
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

export type CodexRoutingKind =
  "native" | "codexcommander-local" | "custom-local" | "custom-remote" | "unknown";

type RoutingEndpointKind = "local" | "remote" | "unknown";

function ipv4Octets(hostname: string): number[] | null {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    return octets.some((octet) => octet > 255) ? null : octets;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (!mapped) return null;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
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
    if (hostname === "localhost" || hostname.endsWith(".localhost"))
      return "local";
    if (hostname === "::" || hostname === "::1" || hostname === "0.0.0.0")
      return "local";
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

/** Classify actual routing dependency separately from codexcommander ownership. */
export function classifyCodexRouting(content: string): CodexRoutingKind {
  const rootBaseUrl = rootTomlString(content, "openai_base_url");
  if (rootBaseUrl) {
    const endpoint = classifyRoutingEndpoint(rootBaseUrl);
    if (endpoint === "unknown") return "unknown";
    if (hasInjectedOpenaiBaseUrl(content)) return "codexcommander-local";
    return endpoint === "local" ? "custom-local" : "custom-remote";
  }
  const rootProvider = rootTomlString(content, "model_provider");
  if (rootProvider) {
    const providerTableExists =
      providerTableStart(content.split("\n"), rootProvider) !== -1;
    const providerBaseUrl = providerTableString(
      content,
      rootProvider,
      "base_url",
    );
    if (providerBaseUrl) {
      const endpoint = classifyRoutingEndpoint(providerBaseUrl);
      if (endpoint === "unknown") return "unknown";
      if (isOwnedProviderId(rootProvider)) return "codexcommander-local";
      return endpoint === "local" ? "custom-local" : "custom-remote";
    }
    if (
      isOwnedProviderId(rootProvider) ||
      providerTableExists ||
      rootProvider !== "openai"
    )
      return "unknown";
  }
  return "native";
}

/** Read-only probe used by status, doctor, and the dashboard. */
export function isCodexRoutingInjected(): boolean {
  const path = CODEX_CONFIG_PATH;
  if (!existsSync(path)) return false;
  try {
    return hasInjectedCodexRouting(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

export function getCodexRoutingKind(): CodexRoutingKind {
  // Status/policy probes run after environment selection in embedded servers
  // and isolated tests, so resolve the active home at call time.
  const path = join(getCodexHome(), "config.toml");
  if (!existsSync(path)) return "native";
  try {
    return classifyCodexRouting(readFileSync(path, "utf8"));
  } catch {
    return "unknown";
  }
}

/**
 * Strip every existing `model_provider` line that we must not duplicate: any line set to
 * "codexcommander" (wherever it sits — including a previously mis-nested one under a table), plus any
 * ROOT-level model_provider (before the first table) of any value, since we override the global.
 * A `model_provider` legitimately inside a user table/profile with a non-codexcommander value is left
 * untouched.
 */
function stripExistingModelProvider(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*model_provider\s*=/.test(line)) {
      const isOurs = /^\s*model_provider\s*=\s*"codexcommander"\s*$/.test(line);
      const isRoot = firstTable === -1 || i < firstTable;
      if (isOurs || isRoot) return; // drop it
    }
    out.push(line);
  });
  return out.join("\n");
}

/**
 * Drop ROOT-level `model_context_window` overrides (keys before the first table header). Codex
 * treats this root key as a global override that wins over the per-model catalog values, so a stale
 * `model_context_window = 1000000` makes every model (e.g. gpt-5.5) report a 1M window. User-owned
 * compaction limits do not alter the advertised context window and must survive reinjection.
 */
export function stripRootContextWindowOverrides(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  return lines
    .filter((line, i) => {
      const isRoot = firstTable === -1 || i < firstTable;
      return !isRoot || !/^\s*model_context_window\s*=/.test(line);
    })
    .join("\n");
}

function stripRootRoutedModel(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  return lines
    .filter((line, i) => {
      const isRoot = firstTable === -1 || i < firstTable;
      if (!isRoot) return true;
      const m = line.match(/^\s*model\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/);
      if (!m) return true;
      const model = parseTomlString(m[1]);
      return !model?.includes("/");
    })
    .join("\n");
}

/**
 * Insert `model_provider = "codexcommander"` at the document ROOT — immediately before the first table
 * header (TOML root keys must precede all tables). If there are no tables, append it to the root body.
 */
function setRootModelProvider(content: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const key = `model_provider = "${PROVIDER_ID}"`;
  if (firstTable === -1) {
    return content.replace(/\n+$/, "") + "\n" + key + "\n";
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, key);
  return lines.join("\n");
}

function readRootModelCatalogPath(content: string): string | null {
  return readRootTomlString(content, "model_catalog_json");
}

function setRootModelCatalogPath(content: string, catalogPath: string): string {
  const lines = content.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const key = `model_catalog_json = ${tomlString(catalogPath)}`;
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let i = 0; i < rootEnd; i++) {
    const m = lines[i].match(
      /^\s*model_catalog_json\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/,
    );
    if (!m) continue;
    const existing = parseTomlString(m[1]);
    if (isCodexCommanderCatalogPath(existing)) {
      lines[i] = key;
      return lines.join("\n");
    }
    return content;
  }
  if (firstTable === -1) {
    return content.replace(/\n+$/, "") + "\n" + key + "\n";
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, key);
  return lines.join("\n");
}

function removeProfileSection(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inProfile = false;
  for (const line of lines) {
    if (line.trim() === `[profiles.${PROVIDER_ID}]`) {
      inProfile = true;
      continue;
    }
    if (inProfile) {
      if (
        /^\s*\[/.test(line)
        && line.trim() !== `[profiles.${PROVIDER_ID}]`
      ) {
        inProfile = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }
  return (
    filtered
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

function normalizeServiceTier(content: string): string {
  return content.replace(
    /^(\s*service_tier\s*=\s*)["']priority["']\s*$/gm,
    '$1"fast"',
  );
}

function ensureFastModeFeature(content: string, fastMode?: boolean): string {
  // Tri-state fast mode (see CodexCommanderConfig.fastMode): true forces `fast_mode = true`,
  // false forces `fast_mode = false`, and undefined leaves the user's config
  // untouched (no [features] table is added and an existing fast_mode line is
  // preserved as-is). Table and key matching accept the valid TOML spellings
  // `[features] # comment`, `["features"]` / `['features']`, and quoted keys.
  const lines = content.split("\n");
  const featuresHeader = /^\s*\[(["']?)\s*features\s*\1\]\s*(?:#.*)?$/;
  const fastModeKey = /^\s*(?:"fast_mode"|'fast_mode'|fast_mode)\s*=/;
  const featuresStart = lines.findIndex(line => featuresHeader.test(line));
  if (featuresStart === -1) {
    if (fastMode === undefined) return content;
    return content.trimEnd() + "\n\n[features]\nfast_mode = " + (fastMode ? "true" : "false") + "\n";
  }

  const nextTable = lines.findIndex(
    (line, index) => index > featuresStart && /^\s*\[/.test(line),
  );
  const featuresEnd = nextTable === -1 ? lines.length : nextTable;
  for (let i = featuresStart + 1; i < featuresEnd; i++) {
    if (fastModeKey.test(lines[i])) {
      if (fastMode === undefined) return lines.join("\n");
      lines[i] = lines[i].replace(/^(\s*)(?:"fast_mode"|'fast_mode'|fast_mode)\s*=.*$/, `$1fast_mode = ${fastMode ? "true" : "false"}`);
      return lines.join("\n");
    }
  }

  if (fastMode === undefined) return lines.join("\n");
  let insertAt = featuresEnd;
  while (insertAt > featuresStart + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, `fast_mode = ${fastMode ? "true" : "false"}`);
  return lines.join("\n");
}

function isCodexCommanderCatalogPath(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").pop() === "codexcommander-catalog.json";
}

function stripCodexCommanderCatalogPath(content: string): string {
  return content
    .split("\n")
    .filter((line) => {
      const m = line.match(
        /^\s*model_catalog_json\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/,
      );
      return !m || !isCodexCommanderCatalogPath(parseTomlString(m[1]));
    })
    .join("\n");
}

export function buildProfileFile(port: number, catalogPath?: string | null, supportsWebsockets = false, includeApiAuthHeader = false, hostname?: string, fastMode?: boolean): string {
  const host = providerBaseHost(hostname);
  // Design B (loopback): the reference/fallback file documents the root override form.
  // Non-loopback uses the provider-table shape (the built-in provider cannot carry
  // the x-codexcommander-api-key env header).
  if (!includeApiAuthHeader) {
    const lines = [
      "# CodexCommander proxy fallback config (Design B)",
      `# Root override that points Codex's built-in openai provider at the proxy on ${host}:${port}.`,
      "# Merge these root keys into ~/.codex/config.toml manually if auto-injection was removed.",
      buildOpenaiBaseUrlLine(port, hostname),
    ];
    if (catalogPath) lines.push(`model_catalog_json = ${tomlString(catalogPath)}`);
    if (fastMode !== undefined) lines.push("", "[features]", `fast_mode = ${fastMode ? "true" : "false"}`, "");
    return lines.join("\n");
  }
  const lines = [
    `# CodexCommander proxy profile — use with: codex --profile ${PROVIDER_ID}`,
    `# Routes all model requests through the CodexCommander proxy at ${host}:${port}`,
    `model_provider = "${PROVIDER_ID}"`,
  ];
  if (catalogPath) lines.push(`model_catalog_json = ${tomlString(catalogPath)}`);
  if (fastMode !== undefined) lines.push("", "[features]", `fast_mode = ${fastMode ? "true" : "false"}`);
  lines.push(buildProviderTableBlock(port, supportsWebsockets, includeApiAuthHeader, hostname).trimEnd(), "");
  return lines.join("\n");
}

export function chooseCatalogPathForInjection(
  content: string,
  requested?: string | null,
): string | null {
  if (requested !== undefined) return requested;

  const existing = readRootModelCatalogPath(content);
  if (existing) {
    const resolved = resolveCodexConfigPath(existing);
    if (!isCodexCommanderCatalogPath(resolved) || existsSync(resolved))
      return existing;
  }

  return existsSync(DEFAULT_CATALOG_PATH) ? DEFAULT_CATALOG_PATH : null;
}

export interface CodexInjectResult {
  success: boolean;
  message: string;
  status?: "skipped" | "stale";
  skippedReason?: "desired_disabled" | "desired_enabled";
  nativeSubagentDefaultsWarning?: string;
}

class CodexInjectConfigGenerationStale extends Error {
  constructor() {
    super("CodexCommander configuration changed before native Codex config publication.");
    this.name = "CodexInjectConfigGenerationStale";
  }
}

class CodexInjectRoutingStale extends Error {
  constructor() {
    super("Codex routing ownership changed before native Codex config publication.");
    this.name = "CodexInjectRoutingStale";
  }
}

export async function injectCodexConfig(
  port: number,
  config?: CodexCommanderConfig,
  options: InjectCodexOptions = {},
): Promise<CodexInjectResult> {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    return {
      success: false,
      message: `Codex config not found at ${CODEX_CONFIG_PATH}. Is Codex installed?`,
    };
  }

  const rawContent = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  if (options.expectedRoutingKind !== undefined
    && classifyCodexRouting(rawContent) !== options.expectedRoutingKind) {
    return {
      success: false,
      status: "stale",
      message: "Codex routing ownership changed before native Codex config publication; no files were changed.",
    };
  }
  const activeProvider = externalCodexModelProvider(rawContent);
  if (
    options.expectedExternalProvider !== undefined
    && activeProvider !== options.expectedExternalProvider
  ) {
    return {
      success: false,
      message: "Codex external model_provider changed before it could be preserved; no files were changed.",
    };
  }
  if (activeProvider) {
    // A launcher may have journaled before the provider manager took ownership. Never let shutdown
    // replay that stale snapshot over externally managed config.
    retireJournalForExternalProvider(activeProvider);
    const nativeSubagentDefaultsWarning = configuredManagedSubagentDefaults(
      config,
    )
      ? `Native Codex sub-agent defaults were not injected: external model_provider ${tomlString(activeProvider)} owns config.toml.`
      : undefined;
    return {
      success: true,
      ...(nativeSubagentDefaultsWarning
        ? { nativeSubagentDefaultsWarning }
        : {}),
      message:
        `⚠️ Codex routing NOT injected: config.toml selects the external model_provider ${tomlString(activeProvider)}.\n` +
        `  CodexCommander preserves external provider configuration so existing ${tomlString(activeProvider)} session history stays visible.\n` +
        `  Configure that provider for Responses passthrough at http://${providerBaseHost(config?.hostname)}:${port}/v1` +
        `${shouldInjectApiAuthHeader(config) ? ` with ${API_KEY_HEADER} from CODEXCOMMANDER_API_AUTH_TOKEN` : ""}.\n` +
        `  For direct injection, switch to the built-in openai provider, remove any user-owned root openai_base_url, and rerun 'ccx start'.`,
    };
  }

  // Marker-owned native defaults are CodexCommander residue, never part of the
  // user's journal baseline. Clean them before either snapshotting or adding a
  // root routing key: inserting that key ahead of a marker-owned first table
  // would otherwise separate the table marker from its header. Ambiguous
  // markers fail closed without writing config, profile, or journal state.
  const nativeDefaultsBaseline = transformManagedSubagentDefaults(
    rawContent,
    null,
  );
  if (!nativeDefaultsBaseline.ok) {
    return {
      success: false,
      message:
        `Codex config injection refused: existing CodexCommander-managed native sub-agent defaults are ambiguous: ${nativeDefaultsBaseline.error}. ` +
        `No files were changed; inspect ${CODEX_CONFIG_PATH}.`,
    };
  }
  const baselineContent = nativeDefaultsBaseline.content;

  /*
   * The journal write used to happen HERE, before the transforms. It now happens
   * inside the write lock further down, and the transforms were hoisted above it
   * rather than the lock being narrowed to the three file writes.
   *
   * Why: the lock's witness hashes the CANDIDATE BYTES, and those are not final
   * until `profileContent` and the EOL-applied `content` exist. Opening the lock
   * before them would leave nothing to hash; keeping the journal outside the
   * lock would leave the first artifact-creating write unserialized, which is
   * the hole this edge exists to close.
   *
   * The move is safe because the region between here and the writes performs no
   * filesystem mutation — its only touch is `existsSync` on the catalog paths
   * (`chooseCatalogPathForInjection`) — and because `writeJournal` is called
   * with `configContent`, so it snapshots the baseline it is handed rather than
   * rereading `config.toml` underneath the transforms.
   */
  // EOL boundary: transforms below are LF-pure; preserve the file's dominant ending on write.
  const eol = dominantEol(rawContent);
  let content = applyEol(baselineContent, "\n");

  // Idempotent clean-up of any prior injection: drop the provider table (marker-based) and every
  // stray/mis-nested model_provider line, so re-injecting can't duplicate keys or leave the buggy
  // table-nested key behind.
  // Design B form FIRST: removeCodexCommanderSection also keys on the marker line, so a root-level
  // marker + openai_base_url pair must be gone before it scans or it would swallow root keys.
  content = stripInjectedOpenaiBaseUrl(content);
  if (content.includes(`[model_providers.${PROVIDER_ID}]`)) {
    content = removeCodexCommanderSection(content);
  }
  content = removeProfileSection(content);
  content = stripExistingModelProvider(content);
  content = stripRootContextWindowOverrides(content);
  content = normalizeServiceTier(content);
  content = ensureFastModeFeature(content, config?.fastMode);

  const catalogPath = chooseCatalogPathForInjection(
    content,
    options.catalogPath,
  );
  content = catalogPath
    ? setRootModelCatalogPath(content, catalogPath)
    : stripCodexCommanderCatalogPath(content);

  const providerTableMode = shouldInjectApiAuthHeader(config);
  let keptUserBaseUrl = false;
  if (providerTableMode) {
    // Non-loopback injection: the built-in openai provider cannot carry the
    // x-codexcommander-api-key env header, so use the CodexCommander provider table + root re-tag.
    // 1) Root key BEFORE the first table header (must be a global, not nested under a table).
    content = setRootModelProvider(content);
    // 2) Provider table appended at EOF (position-independent).
    content =
      content.trimEnd() +
      "\n" +
      buildProviderTableBlock(
        port,
        websocketsEnabled(config ?? {}),
        true,
        config?.hostname,
      );
  } else {
    // Design B (loopback): a single root override; codex keeps its native `openai` provider id
    // so thread history is never remapped.
    content = stripInjectedOpenaiBaseUrl(content); // normalize before idempotent re-insert
    const result = setRootOpenaiBaseUrl(content, port, config?.hostname);
    content = result.content;
    keptUserBaseUrl = result.keptUserBaseUrl;
  }

  const desiredSubagentDefaults = configuredManagedSubagentDefaults(config);
  const routingOwnershipWarning =
    keptUserBaseUrl && desiredSubagentDefaults
      ? "Native Codex sub-agent defaults were not injected: a user-owned root openai_base_url prevents CodexCommander from managing active Codex routing."
      : undefined;
  const managedDefaults = transformManagedSubagentDefaults(
    content,
    keptUserBaseUrl ? null : desiredSubagentDefaults,
  );
  let nativeSubagentDefaultsWarning = routingOwnershipWarning;
  let managedDefaultsMessage = routingOwnershipWarning
    ? `  ⚠️ ${routingOwnershipWarning}\n`
    : "";
  if (managedDefaults.ok) {
    content = managedDefaults.content;
    if (desiredSubagentDefaults && managedDefaults.conflicts.length > 0) {
      const keys = managedDefaults.conflicts
        .map((conflict) => `agents.${conflict.key}`)
        .join(", ");
      nativeSubagentDefaultsWarning = `Native Codex sub-agent defaults were not injected: user-owned ${keys} preserved.`;
      managedDefaultsMessage = `  ⚠️ ${nativeSubagentDefaultsWarning}\n`;
    }
  } else {
    const action =
      desiredSubagentDefaults && !keptUserBaseUrl
        ? "were not injected"
        : "could not be safely removed";
    nativeSubagentDefaultsWarning = `Native Codex sub-agent defaults ${action}: ${managedDefaults.error}.`;
    managedDefaultsMessage = `  ⚠️ ${nativeSubagentDefaultsWarning}\n`;
  }

  const profileContent = buildProfileFile(port, catalogPath, websocketsEnabled(config ?? {}), providerTableMode, config?.hostname, config?.fastMode);
  content = applyEol(content, eol);

  /*
   * The witness, built from the FINAL bytes. Everything it hashes is either the
   * output about to be written or evidence that can be re-read under the lock;
   * ownership rides along as recorded context because it is not re-observed
   * there — see `write-coordination.ts`.
   */
  const persisted = readConfigAdmissionSnapshot();
  const persistedIdentity =
    persisted.kind === "read" ? persisted.contentSha256 : "unreadable";
  const observedGeneration = observeConfigGeneration();
  const generation =
    observedGeneration.kind === "ready"
      ? { present: true, value: observedGeneration.generation.value }
      : { present: false, value: 0 };
  const candidate = {
    configBytes: content,
    profileBytes: profileContent,
    catalogPath,
  };
  const witness = buildInjectWitness(
    candidate,
    rawContent,
    persistedIdentity,
    generation,
    "unknown",
  );

  /*
   * THE COORDINATED SECTION.
   *
   * This is the write lock's first production caller. Everything above is
   * classification and pure transformation; everything from here to the end of
   * the callback replaces files, and two processes doing it at once is the
   * interruption hazard this substrate exists to close.
   *
   * The witness hashes the bytes about to be written rather than the inputs that
   * produced them, so two operations intending different output cannot share an
   * id no matter which input differed.
   */
  // Eligibility is decided before acquisition. A non-current or unclassifiable
  // home is refused; it is never adopted or written through an unlocked path.
  const eligibility = codexWriteCoordinationEligibility({
    coordinatorPath: () =>
      resolveCodexCoordinatorDatabasePath(
        resolveEffectiveUserIdentity(),
        getCodexHome(),
      ),
    residue: () => classifyNativeRoutedResidue(),
    integrationRecord: () => readIntegrationRecord(),
  });
  if (eligibility.kind === "refused") {
    return {
      success: false,
      message: `Codex configuration was not written: ${eligibility.reason}.`,
    };
  }

  const applyNativeArtifacts = (preImages: ReturnType<typeof captureCodexPreImages>): void => {
    writeJournal({
      currentStateIsNative: !hasInjectedCodexRouting(rawContent),
      configContent: baselineContent,
      profileContent: preImages.profile,
      intendedPostimage: {
        config: content,
        profile: profileContent,
      },
    });
    if (preImages.config !== content) atomicWriteFile(CODEX_CONFIG_PATH, content);
    if (preImages.profile !== profileContent) atomicWriteFile(CODEX_PROFILE_PATH, profileContent);
  };

  {
    let coordinated;
    try {
      coordinated = await withCodexWriteLock(
        {
          timeoutMs: options.lockTimeoutMs ?? DEFAULT_INJECT_LOCK_TIMEOUT_MS,
          admitted: { authoritySnapshotId: witness.comparisonId },
          readAdmissionUnderLock: () => ({
            authoritySnapshotId: recomputeInjectWitness({
              candidate: witness.candidate,
              canonicalTargets: witness.evidence.canonicalTargets,
              persistedIdentity,
              generation,
              observedOwnership: witness.observedOwnership,
            }).comparisonId,
          }),
        },
        (ctx) => {
          if (!shouldSyncCodexOnStart(loadConfig())) {
            throw new CodexWriteLockSkipped("desired_disabled");
          }
          if (options.expectedRoutingKind !== undefined
            && classifyCodexRouting(readFileSync(CODEX_CONFIG_PATH, "utf8"))
              !== options.expectedRoutingKind) {
            throw new CodexInjectRoutingStale();
          }
          if (options.expectedConfigAuthority) {
            try {
              const current = captureCatalogConfigAuthority(config ?? loadConfig());
              if (
                current.generation.value !== options.expectedConfigAuthority.generation.value
                || current.semanticIdentity !== options.expectedConfigAuthority.semanticIdentity
                || current.contentIdentity !== options.expectedConfigAuthority.contentIdentity
              ) {
                throw new CodexInjectConfigGenerationStale();
              }
            } catch (error) {
              if (error instanceof CodexInjectConfigGenerationStale) throw error;
              throw new CodexInjectConfigGenerationStale();
            }
          } else if (
            options.expectedConfigGeneration
            && readConfigGenerationInCurrentMutationTransaction().value
              !== options.expectedConfigGeneration.value
          ) {
            throw new CodexInjectConfigGenerationStale();
          }
          /*
           * Publish BEFORE touching the filesystem. `assertPublished` runs after this
           * callback returns and throws unless a transition was recorded, so writing
           * first would replace every file and only then fail — with SQLite rolling
           * back and the filesystem staying changed.
           *
           * `beginTransition` returns a conflict rather than throwing, so its result
           * is checked here; ignoring it would reach the same failure by a slower
           * route.
           */
          const published = ctx.coordinator.beginTransition(
            {
              nativeGeneration: ctx.expectation.nativeBefore,
              currentTxId: ctx.currentTxId,
            },
            {
              txId: ctx.expectation.txId,
            },
          );
          if (published.kind !== "updated") {
            throw new CodexWriteConflictError(
              `The Codex transition could not be published: ${published.kind}.`,
            );
          }

          /*
           * Exact pre-images, captured under the lock and used for compensation.
           *
           * A rolled-back coordinator row is not a rolled-back filesystem: each
           * `atomicWriteFile` is atomic alone, never across the three together, so a
           * failure partway leaves earlier replacements in place. Journal restoration
           * cannot be the undo — it restores whichever journal occupies the path,
           * which need not be the one this operation wrote.
           */
          const preImages = captureCodexPreImages();
          try {
            applyNativeArtifacts(preImages);
          } catch (error) {
            // Compensate, then ALWAYS throw. Returning a partial result would let the
            // lock commit a row describing an apply that did not finish.
            const restored = restoreCodexPreImages(preImages);
            if (!restored.complete) {
              throw new CodexPartialWriteError(restored.unrestored);
            }
            throw error;
          }
          return { kind: "applied" as const };
        },
      );
    } catch (error) {
      if (error instanceof CodexInjectConfigGenerationStale
        || error instanceof CodexInjectRoutingStale) {
        return {
          success: false,
          status: "stale",
          message: error instanceof CodexInjectRoutingStale
            ? "Codex routing ownership changed before native Codex config publication; no stale Codex config was written. Retry the sync."
            : "CodexCommander configuration changed before native Codex config publication; no stale Codex config was written. Retry the sync.",
        };
      }
      throw error;
    }

    if (coordinated.status !== "acquired") {
      return codexInjectLockOutcome(coordinated);
    }
  }

  const catalogMessage = catalogPath
    ? `  Codex model catalog: ${catalogPath}\n`
    : `  Codex model catalog not injected because no CodexCommander catalog file exists yet.\n`;
  // A user-owned root openai_base_url means we did NOT install routing — say so honestly
  // instead of claiming the proxy route is active (catalog/fast_mode were still written).
  if (keptUserBaseUrl) {
    return {
      success: true,
      ...(nativeSubagentDefaultsWarning
        ? { nativeSubagentDefaultsWarning }
        : {}),
      message:
        `⚠️ Codex routing NOT injected: your config already sets a root openai_base_url, and CodexCommander never overwrites a user-owned override.\n` +
        catalogMessage +
        managedDefaultsMessage +
        `  To route plain codex through the proxy, remove your openai_base_url line from ~/.codex/config.toml and rerun 'ccx start'.\n` +
        `  Reference config: ${CODEX_PROFILE_PATH}`,
    };
  }
  const headline = providerTableMode
    ? `Injected codexcommander as default provider into Codex config.\n`
    : `Pointed Codex's built-in openai provider at the CodexCommander proxy (openai_base_url).\n`;
  return {
    success: true,
    ...(nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning } : {}),
    message:
      headline +
      catalogMessage +
      managedDefaultsMessage +
      `  All models now route through the CodexCommander proxy (like OpenRouter).\n` +
      `  OpenAI models (gpt-5.5, etc.) are passed through to OpenAI.\n` +
      `  Custom models route to their configured providers.\n` +
      (providerTableMode
        ? `  Fallback: codex --profile codexcommander (same behavior)`
        : `  Fallback reference: ${CODEX_PROFILE_PATH}`),
  };
}

function removeCodexCommanderSection(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inCodexCommanderSection = false;
  for (const line of lines) {
    if (
      isSectionMarkerLine(line) ||
      line.trim() === `[model_providers.${PROVIDER_ID}]`
    ) {
      inCodexCommanderSection = true;
      continue;
    }
    if (inCodexCommanderSection) {
      // End the injected section at the next table header that ISN'T our own — exact match so a
      // user's "[model_providers.codexcommander_backup]" (or similar) is preserved, not swallowed.
      if (
        /^\s*\[/.test(line) &&
        line.trim() !== `[model_providers.${PROVIDER_ID}]`
      ) {
        inCodexCommanderSection = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }
  return (
    filtered
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

interface StripCodexCommanderConfigResult {
  content: string;
  managedDefaultsError: string | null;
}

/**
 * Detailed form used by the on-disk restore path. A damaged ownership marker is
 * ambiguous: keep the associated value, but return the transform error so the
 * caller cannot report a complete restore.
 */
function stripCodexCommanderConfigResult(
  content: string,
): StripCodexCommanderConfigResult {
  let out = content;
  const rootProvider = readRootTomlString(out, "model_provider");
  const hadRootCodexCommanderProvider = rootProvider === PROVIDER_ID;
  const hadInjectedBaseUrl = hasInjectedOpenaiBaseUrl(out);
  out = stripInjectedOpenaiBaseUrl(out); // before removeCodexCommanderSection — it keys on the marker line too
  if (out.includes(`[model_providers.${PROVIDER_ID}]`)) {
    out = removeCodexCommanderSection(out);
  }
  out = removeProfileSection(out);
  // Regex (not exact-string) removal so compact `model_provider="codexcommander"` is stripped
  // too — must match the detection regex above, or a detected line could survive un-removed.
  const ownedProviderLine = new RegExp(
    `^\\s*model_provider\\s*=\\s*"${PROVIDER_ID}"\\s*$`,
  );
  out = out
    .split("\n")
    .filter((l) => !ownedProviderLine.test(l))
    .join("\n");
  // Routed root model ids (`model = "provider/slug"`) only make sense while the proxy serves
  // them — strip on both the provider-table and injected-base-url forms.
  if (hadRootCodexCommanderProvider || hadInjectedBaseUrl) out = stripRootRoutedModel(out);
  const managedDefaults = transformManagedSubagentDefaults(out, null);
  if (managedDefaults.ok) out = managedDefaults.content;
  out = stripCodexCommanderCatalogPath(out);
  return {
    content: out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    managedDefaultsError: !managedDefaults.ok ? managedDefaults.error : null,
  };
}

/** Pure transform: strip the codexcommander provider block + `model_provider = "codexcommander"` lines. */
export function stripCodexCommanderConfig(content: string): string {
  return stripCodexCommanderConfigResult(content).content;
}

function hasCodexCommanderRouting(content: string): boolean {
  return (
    content.includes(`[model_providers.${PROVIDER_ID}]`) ||
    new RegExp(`^\\s*model_provider\\s*=\\s*"${PROVIDER_ID}"`, "m").test(content) ||
    hasInjectedOpenaiBaseUrl(content)
  );
}

export function removeCodexConfig(
  options: { preserveProfile?: boolean } = {},
): { success: boolean; message: string } {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    if (!options.preserveProfile && existsSync(CODEX_PROFILE_PATH)) unlinkSync(CODEX_PROFILE_PATH);
    return {
      success: true,
      message: `Codex config not found; no native restore was needed${options.preserveProfile ? "." : ", and the CodexCommander profile was removed if present."}`,
    };
  }
  const rawContent = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  // Same EOL boundary as inject: strip in LF space, write back in the file's own ending.
  // The unchanged fast path compares in LF space so an untouched file is never rewritten.
  const eol = dominantEol(rawContent);
  const content = applyEol(rawContent, "\n");
  const had = hasCodexCommanderRouting(content);
  const stripped = stripCodexCommanderConfigResult(content);
  if (had || stripped.content !== content) {
    atomicWriteFile(CODEX_CONFIG_PATH, applyEol(stripped.content, eol));
  }
  if (!options.preserveProfile && existsSync(CODEX_PROFILE_PATH))
    unlinkSync(CODEX_PROFILE_PATH);
  const removedMessage = had
    ? `Removed CodexCommander routing from Codex config${options.preserveProfile ? "." : " + profile."}`
    : "CodexCommander routing not present in Codex config.";
  if (stripped.managedDefaultsError) {
    const routingMessage = had
      ? removedMessage
      : "No CodexCommander routing was present in Codex config.";
    return {
      success: false,
      message:
        `${routingMessage} Native Codex sub-agent defaults could not be safely removed: ${stripped.managedDefaultsError}. ` +
        "The ambiguous marker and adjacent value were preserved; inspect $CODEX_HOME/config.toml before using native Codex.",
    };
  }
  return {
    success: true,
    message: removedMessage,
  };
}

export type CodexRestoreArtifactState = "ok" | "skipped" | "failed";

export interface CodexRestoreConfigResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  action: "journal-restored" | "owned-fields-stripped" | "external-provider-preserved" | "failed";
  message: string;
}

export interface CodexRestoreCatalogResult {
  state: CodexRestoreArtifactState;
  changed: boolean;
  removed: number;
  kept: number;
  path: string | null;
  message: string;
}

export interface CodexNativeRestoreResult {
  success: boolean;
  message: string;
  externalProvider?: string;
  artifacts: {
    config: CodexRestoreConfigResult;
    catalog: CodexRestoreCatalogResult;
  };
}

function externalProviderRestoreResult(activeProvider: string): CodexNativeRestoreResult {
  const message = `External Codex provider ${tomlString(activeProvider)} preserved; no native restore was needed.`;
  return {
    success: true,
    message,
    externalProvider: activeProvider,
    artifacts: {
      config: { state: "skipped", changed: false, action: "external-provider-preserved", message },
      catalog: { state: "skipped", changed: false, removed: 0, kept: 0, path: null, message },
    },
  };
}

/** A foreign service claim is an authority boundary, including explicit CLI restore. */
function nativeRestoreRefusal(message: string): CodexNativeRestoreResult {
  return {
    success: false,
    message: `Codex native restore refused: ${message}`,
    artifacts: {
      config: { state: "skipped", changed: false, action: "failed", message },
      catalog: { state: "skipped", changed: false, removed: 0, kept: 0, path: null, message },
    },
  };
}

function desiredEnabledRestoreSkip(): CodexNativeRestoreResult {
  const message = "Codex integration was re-enabled; native restore was skipped.";
  return skippedRestoreEnvelope(true, message);
}

/**
 * A schema-complete all-skipped envelope for outcomes decided before any
 * restore machinery runs. Every `restore --json` path must stay shape-stable
 * with `CodexNativeRestoreResult`; consumers never special-case early exits.
 */
export function skippedRestoreEnvelope(success: boolean, message: string): CodexNativeRestoreResult {
  return {
    success,
    message,
    artifacts: {
      config: { state: "skipped", changed: false, action: "owned-fields-stripped", message },
      catalog: { state: "skipped", changed: false, removed: 0, kept: 0, path: null, message },
    },
  };
}

/** The config/profile half of a native restore, reported as one artifact. */
function restoreCodexConfigInline(): CodexRestoreConfigResult {
  try {
    const journal = restoreJournalStateUnderCoordinatedWrite();
    const restored = journal.configRestored
      ? { success: true, message: "Codex config restored from the CodexCommander journal." }
      : removeCodexConfig({ preserveProfile: journal.profileRestored || journal.profileChanged });
    return restored.success
      ? {
          state: "ok",
          changed: journal.configRestored || journal.profileRestored || journal.profileChanged || restored.message.startsWith("Removed"),
          action: journal.configRestored ? "journal-restored" : "owned-fields-stripped",
          message: restored.message,
        }
      : { state: "failed", changed: false, action: "failed", message: restored.message };
  } catch (error) {
    return { state: "failed", changed: false, action: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Synchronous shutdown callers cannot await the retrying lock helper, but they
 * still participate in the same N -> C authority as injection. A missing
 * coordinator over journal/residue is refused by the unchanged eligibility
 * gate; there is no unlocked fallback to read/modify/write config.toml.
 */
function restoreCodexConfigCoordinatedSync(
  revalidateDesiredState: boolean,
): CodexRestoreConfigResult | { skipped: true } {
  const canonical = canonicalizeCodexHome(getCodexHome());
  if (!canonical.ok) {
    return {
      state: "failed",
      changed: false,
      action: "failed",
      message: `Codex configuration was not restored: ${canonical.message}`,
    };
  }
  let coordinatorPath: string;
  try {
    coordinatorPath = resolveCodexCoordinatorDatabasePath(
      resolveEffectiveUserIdentity(),
      canonical.home.path,
    );
  } catch (error) {
    return {
      state: "failed",
      changed: false,
      action: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const eligibility = codexWriteCoordinationEligibility({
    coordinatorPath: () => coordinatorPath,
    residue: () => classifyNativeRoutedResidue(),
    integrationRecord: () => readIntegrationRecord(),
  });
  if (eligibility.kind === "refused") {
    return {
      state: "failed",
      changed: false,
      action: "failed",
      message: `Codex configuration was not restored: ${eligibility.reason}.`,
    };
  }

  let transaction: ReturnType<typeof beginCodexCoordinatorTransaction> | undefined;
  try {
    transaction = beginCodexCoordinatorTransaction(coordinatorPath);
    const expectation = transaction.expectation();
    const version = transaction.version();
    const config = withConfigMutationLockSync(() => {
      if (revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
        throw new CodexWriteLockSkipped("desired_enabled");
      }
      const published = transaction!.capability.beginTransition(
        {
          nativeGeneration: expectation.nativeBefore,
          currentTxId: version.currentTxId,
        },
        { txId: expectation.txId },
      );
      if (published.kind !== "updated") {
        throw new CodexWriteConflictError(
          `The Codex restore transition could not be published: ${published.kind}.`,
        );
      }
      const preImages = captureCodexPreImages();
      try {
        return restoreCodexConfigInline();
      } catch (error) {
        const compensated = restoreCodexPreImages(preImages);
        if (!compensated.complete) throw new CodexPartialWriteError(compensated.unrestored);
        throw error;
      }
    });
    transaction.assertPublished(expectation);
    transaction.commit();
    return config;
  } catch (error) {
    transaction?.rollback();
    if (error instanceof CodexWriteLockSkipped) return { skipped: true };
    return {
      state: "failed",
      changed: false,
      action: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    transaction?.close();
  }
}

/** The catalog half, always inside its own K acquisition. */
function restoreCodexCatalogArtifact(revalidateDesiredState: boolean): CodexRestoreCatalogResult {
  const owningCodexHome = getCodexHome();
  try {
    const restored = withCatalogWriteSerialization(owningCodexHome, permit =>
      revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())
        ? null
        : restoreCodexCatalogWithPermit(permit, owningCodexHome));
    return restored.kind === "completed" && restored.value !== null
      ? { state: "ok", changed: restored.value.removed > 0, ...restored.value, message: "Codex catalog restored." }
      : restored.kind === "completed"
        ? {
            state: "skipped", changed: false, removed: 0, kept: 0, path: null,
            message: "Codex integration was re-enabled; native catalog restoration was skipped.",
          }
        : {
            state: "failed", changed: false, removed: 0, kept: 0, path: DEFAULT_CATALOG_PATH,
            message: `Codex catalog could not be restored: ${restored.reason}.`,
          };
  } catch (error) {
    return {
      state: "failed", changed: false, removed: 0, kept: 0, path: DEFAULT_CATALOG_PATH,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * On a coordinated home the config/profile restore happens INSIDE the Codex
 * write lock, publishing a `remove` transition — the same serialization inject
 * uses. Without it, an older restore could overwrite a config a concurrent
 * enable had just written under the lock, and then honestly report success
 * while desired intent said ON. The desired-state re-read under the lock turns
 * that lost race into the discriminated `desired_enabled` skip.
 */
export async function restoreNativeCodexAsync(
  options: { revalidateDesiredState?: boolean } = {},
): Promise<CodexNativeRestoreResult> {
  const activeProvider = currentExternalCodexModelProvider();
  if (activeProvider) {
    // External-provider courtesy: only the stale journal is removed.
    retireJournalForExternalProvider(activeProvider);
    return externalProviderRestoreResult(activeProvider);
  }

  // `restore` normally honours a human request even when an unrelated
  // service-manager probe is unavailable. A recorded FOREIGN home is not an
  // unrelated probe: it is positive evidence another installation owns these
  // native artifacts, so do not create profile/claim locks before refusing.
  if (options.revalidateDesiredState) {
    const ownership = inspectNativeCodexOwnership();
    if (ownership.ownership === "foreign") return nativeRestoreRefusal(ownership.reason);
  }

  const eligibility = codexWriteCoordinationEligibility({
    coordinatorPath: () =>
      resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), getCodexHome()),
    residue: () => classifyNativeRoutedResidue(),
    integrationRecord: () => readIntegrationRecord(),
  });
  if (eligibility.kind === "refused") {
    return nativeRestoreRefusal(eligibility.reason);
  }

  let config: CodexRestoreConfigResult;

  {
    // The restore has no candidate bytes to witness; freshness comes from the
    // filesystem reads and the desired-state re-read performed under the lock.
    const witness = { authoritySnapshotId: "codex-native-restore" };
    const coordinated = await withCodexWriteLock(
      {
        timeoutMs: DEFAULT_INJECT_LOCK_TIMEOUT_MS,
        admitted: witness,
        readAdmissionUnderLock: () => witness,
      },
      (ctx) => {
        if (options.revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
          throw new CodexWriteLockSkipped("desired_enabled");
        }
        const published = ctx.coordinator.beginTransition(
          {
            nativeGeneration: ctx.expectation.nativeBefore,
            currentTxId: ctx.currentTxId,
          },
          {
            txId: ctx.expectation.txId,
          },
        );
        if (published.kind !== "updated") {
          throw new CodexWriteConflictError(
            `The Codex transition could not be published: ${published.kind}.`,
          );
        }
        const preImages = captureCodexPreImages();
        let restored: CodexRestoreConfigResult;
        try {
          restored = restoreCodexConfigInline();
        } catch (error) {
          const compensated = restoreCodexPreImages(preImages);
          if (!compensated.complete) throw new CodexPartialWriteError(compensated.unrestored);
          throw error;
        }
        return { config: restored };
      },
    );
    if (coordinated.status === "skipped") return desiredEnabledRestoreSkip();
    if (coordinated.status !== "acquired") {
      config = {
        state: "failed",
        changed: false,
        action: "failed",
        message: coordinated.status === "busy"
          ? `Another process is writing Codex configuration right now (waited ${coordinated.waitedMs}ms). Retry shortly.`
          : `Codex configuration was not restored: ${coordinated.message}`,
      };
    } else {
      config = coordinated.value.config;
    }
  }

  const catalog = restoreCodexCatalogArtifact(options.revalidateDesiredState === true);
  const base = catalog.removed > 0
    ? `${config.message} Catalog restored to ${catalog.kept} native model(s) (dropped ${catalog.removed} proxy-routed).`
    : config.message;
  return {
    success: config.state !== "failed" && catalog.state !== "failed",
    message: base,
    artifacts: { config, catalog },
  };
}

export function restoreNativeCodex(options: { revalidateDesiredState?: boolean } = {}): CodexNativeRestoreResult {
  const activeProvider = currentExternalCodexModelProvider();
  if (activeProvider) {
    retireJournalForExternalProvider(activeProvider);
    return externalProviderRestoreResult(activeProvider);
  }
  if (options.revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
    return desiredEnabledRestoreSkip();
  }
  const coordinatedConfig = restoreCodexConfigCoordinatedSync(
    options.revalidateDesiredState === true,
  );
  if ("skipped" in coordinatedConfig) return desiredEnabledRestoreSkip();
  const config = coordinatedConfig;
  const catalog = restoreCodexCatalogArtifact(options.revalidateDesiredState === true);
  const message = catalog.removed > 0
    ? `${config.message} Catalog restored to ${catalog.kept} native model(s) (dropped ${catalog.removed} proxy-routed).`
    : config.message;
  return {
    success: config.state !== "failed" && catalog.state !== "failed",
    message,
    artifacts: { config, catalog },
  };
}

export function getCodexConfigPath(): string {
  return CODEX_CONFIG_PATH;
}

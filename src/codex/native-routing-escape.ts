import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  renameAtomicFile,
  withConfigMutationLockSync,
} from "../config";
import { API_KEY_HEADER, PROVIDER_ID } from "../identity";
import { CCX_SECTION_MARKER } from "./injected-marker";
import { getCodexHome, parseTomlString } from "./paths";
import { isProxyProviderBaseUrl } from "./proxy-endpoint";
import {
  codexRoutingHasOwnedResidue,
  observeCodexRoutingDocument,
  routingDocumentTable,
  type CodexRoutingDocument,
} from "./routing-document";
import {
  readCodexSurfaceSnapshot,
  sameCodexSurfaceSnapshot,
  type CodexSurfaceSnapshot,
} from "./codex-surface-snapshot";

export interface NativeCodexRoutingEscapeResult {
  success: boolean;
  changed: boolean;
  message: string;
}

export interface NativeCodexRoutingEscapeOptions {
  /** Test-only seam before compare-and-publish. Receives the candidate bytes. */
  beforeRenameForTests?: (content: Buffer) => void;
  /** Test-only post-publication verification seam. */
  afterRenameForTests?: (content: Buffer) => void;
}

function verbatimLines(content: string): string[] {
  return content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}

function lineBody(line: string): string {
  return line.replace(/(?:\r\n|\n|\r)$/, "");
}

function emittedLoopbackEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/v1$/.exec(value);
  return match !== null && Number(match[1]) <= 65_535;
}

function exactEmittedProviderTable(provider: Record<string, unknown> | null): boolean {
  if (!provider) return false;
  const allowed = new Set([
    "name",
    "base_url",
    "wire_api",
    "requires_openai_auth",
    "env_http_headers",
    "supports_websockets",
  ]);
  if (Object.keys(provider).some(key => !allowed.has(key))) return false;
  if (!isProxyProviderBaseUrl(provider.base_url) || provider.wire_api !== "responses") return false;
  if (provider.name !== "CodexCommander Proxy" || provider.requires_openai_auth !== true) return false;
  if (provider.supports_websockets !== undefined && provider.supports_websockets !== true) return false;
  if (provider.env_http_headers !== undefined) {
    const headers = routingDocumentTable(provider.env_http_headers);
    if (!headers
      || Object.keys(headers).length !== 1
      || headers[API_KEY_HEADER] !== "CODEXCOMMANDER_API_AUTH_TOKEN") return false;
  }
  return true;
}

function exactEmittedProviderAssignments(provider: Record<string, unknown>): Set<string> {
  const assignments = new Set([
    'name = "CodexCommander Proxy"',
    `base_url = "${provider.base_url as string}"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
  ]);
  if (provider.env_http_headers !== undefined) {
    assignments.add(
      `env_http_headers = { "${API_KEY_HEADER}" = "CODEXCOMMANDER_API_AUTH_TOKEN" }`,
    );
  }
  if (provider.supports_websockets === true) {
    assignments.add("supports_websockets = true");
  }
  return assignments;
}

function catalogBelongsToHome(codexHome: string, path: string): boolean {
  return resolve(codexHome, path) === resolve(codexHome, "codexcommander-catalog.json");
}

function stripRootRoutedModelVerbatim(
  content: string,
  document: Record<string, unknown>,
): string {
  if (typeof document.model !== "string" || !document.model.includes("/")) return content;
  const lines = verbatimLines(content);
  const bodies = lines.map(lineBody);
  const firstTable = bodies.findIndex(line => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let index = 0; index < rootEnd; index += 1) {
    const match = bodies[index]!.match(
      /^\s*model\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/,
    );
    if (match && parseTomlString(match[1]!) === document.model) {
      return lines.filter((_, lineIndex) => lineIndex !== index).join("");
    }
  }
  return content;
}

/**
 * Remove only the exact marker-owned root route and its dependent root values.
 * The already-parsed overload lets a caller classify and transform one
 * observation without parsing the same bytes again.
 */
export function stripMarkerOwnedRoutingForNativeEscape(content: string): {
  content: string;
  changed: boolean;
};
export function stripMarkerOwnedRoutingForNativeEscape(
  content: string,
  codexHome: string,
): { content: string; changed: boolean };
export function stripMarkerOwnedRoutingForNativeEscape(
  content: string,
  codexHome: string,
  observation: CodexRoutingDocument,
): { content: string; changed: boolean };
export function stripMarkerOwnedRoutingForNativeEscape(
  content: string,
  codexHome = getCodexHome(),
  observation = observeCodexRoutingDocument(content),
): { content: string; changed: boolean } {
  // A raw line transform cannot distinguish content inside TOML multiline
  // strings. Refuse that uncommon syntax instead of deleting user string data.
  if (content.includes('"""') || content.includes("'''")) {
    return { content, changed: false };
  }
  if (observation.kind !== "parsed" || observation.content !== content) {
    return { content, changed: false };
  }
  const document = observation.document;
  const lines = verbatimLines(content);
  const bodies = lines.map(lineBody);
  const firstTable = bodies.findIndex(line => /^\s*\[/.test(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const drop = new Set<number>();
  const ownedLines: Array<Set<number>> = [];
  const rootEndpoint = document.openai_base_url;
  for (let index = 0; index + 1 < rootEnd; index += 1) {
    if (bodies[index]!.trim() !== CCX_SECTION_MARKER) continue;
    const endpoint = /^openai_base_url = "([^"]+)"$/.exec(bodies[index + 1]!);
    if (!endpoint || endpoint[1] !== rootEndpoint || !emittedLoopbackEndpoint(rootEndpoint)) continue;
    ownedLines.push(new Set([index, index + 1]));
  }

  const providers = routingDocumentTable(document.model_providers);
  const provider = providers ? routingDocumentTable(providers[PROVIDER_ID]) : null;
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (bodies[index]!.trim() !== CCX_SECTION_MARKER
      || bodies[index + 1]!.trim() !== `[model_providers.${PROVIDER_ID}]`) continue;
    if (document.model_provider !== PROVIDER_ID || !exactEmittedProviderTable(provider)) continue;
    if (!provider) continue;
    const expected = exactEmittedProviderAssignments(provider);
    const candidate = new Set([index, index + 1]);
    let end = index + 1;
    for (let tableIndex = index + 1; tableIndex < lines.length; tableIndex += 1) {
      if (tableIndex > index + 1 && /^\s*\[/.test(bodies[tableIndex]!)) break;
      end = tableIndex;
    }
    let exact = true;
    for (let tableIndex = index + 2; tableIndex <= end; tableIndex += 1) {
      const body = bodies[tableIndex]!.trim();
      // Comments and whitespace are not emitted routing assignments. Preserve
      // them byte-for-byte even when they sit inside the owned provider table.
      if (body === "" || body.startsWith("#")) continue;
      if (!expected.delete(body)) {
        exact = false;
        break;
      }
      candidate.add(tableIndex);
    }
    if (exact && expected.size === 0) ownedLines.push(candidate);
  }
  if (ownedLines.length !== 1) return { content, changed: false };
  for (const index of ownedLines[0]!) drop.add(index);

  for (let index = 0; index < rootEnd; index += 1) {
    const catalog = bodies[index]!.match(
      /^\s*model_catalog_json\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/,
    );
    if (catalog) {
      const configured = parseTomlString(catalog[1]!);
      if (catalogBelongsToHome(codexHome, configured)) drop.add(index);
    }
    if (/^\s*model_provider\s*=\s*["']codexcommander["']\s*$/.test(bodies[index]!)) {
      drop.add(index);
    }
  }
  const withoutOwnedRoute = lines.filter((_, index) => !drop.has(index)).join("");
  return {
    content: stripRootRoutedModelVerbatim(withoutOwnedRoute, document),
    changed: true,
  };
}

function ownerControlled(stat: BigIntStats, directory: boolean): boolean {
  if (directory ? !stat.isDirectory() : !stat.isFile()) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined
    && stat.uid === BigInt(uid)
    && (stat.mode & 0o022n) === 0n;
}

function stableConfigSnapshot(path: string): Extract<CodexSurfaceSnapshot, { kind: "file" }> {
  const snapshot = readCodexSurfaceSnapshot(path);
  if (!snapshot || snapshot.kind !== "file") {
    throw new Error("config.toml is not a stable regular file or symlink");
  }
  return snapshot;
}

function samePublishedSurface(
  before: Extract<CodexSurfaceSnapshot, { kind: "file" }>,
  after: CodexSurfaceSnapshot | null,
  publishedIdentity: { readonly dev: bigint; readonly ino: bigint },
  expected: Buffer,
): boolean {
  if (!after || after.kind !== "file") return false;
  if (after.canonicalTarget !== before.canonicalTarget
    || after.symbolicLink !== before.symbolicLink
    || !after.bytes.equals(expected)
    || after.targetStat.dev !== publishedIdentity.dev
    || after.targetStat.ino !== publishedIdentity.ino) return false;
  // A symlink leaf must itself remain the exact entry that authorized the write.
  return !before.symbolicLink
    || (after.entryStat.dev === before.entryStat.dev
      && after.entryStat.ino === before.entryStat.ino
      && after.entryStat.mtimeNs === before.entryStat.mtimeNs
      && after.entryStat.ctimeNs === before.entryStat.ctimeNs);
}

let nativeEscapeSequence = 0;

function restoreNativeCodexRoutingEscapeUnderLock(
  options: NativeCodexRoutingEscapeOptions,
): NativeCodexRoutingEscapeResult {
  let tempPath: string | null = null;
  let tempIdentity: { readonly dev: bigint; readonly ino: bigint } | null = null;
  let descriptor: number | null = null;
  let published = false;
  try {
    const home = getCodexHome();
    const homeStat = statSync(home, { bigint: true });
    if (!ownerControlled(homeStat, true)) {
      throw new Error("CODEX_HOME is not an owner-controlled directory");
    }
    const configPath = join(home, "config.toml");
    const initial = readCodexSurfaceSnapshot(configPath);
    if (initial?.kind === "absent") {
      return { success: true, changed: false, message: "Codex routing is already native." };
    }
    if (!initial || initial.kind !== "file") {
      throw new Error("config.toml is not a stable regular file or symlink");
    }
    if (!ownerControlled(statSync(dirname(initial.canonicalTarget), { bigint: true }), true)
      || !ownerControlled(initial.targetStat, false)) {
      throw new Error("config.toml is not an owner-controlled regular file");
    }
    if (initial.text === null) throw new Error("config.toml is not valid UTF-8");
    const observation = observeCodexRoutingDocument(initial.text);
    if (observation.kind !== "parsed") throw new Error("config.toml is not valid TOML");
    if (observation.externalProvider) {
      return { success: true, changed: false, message: "External Codex provider routing was preserved." };
    }
    const ownsCatalog = (path: string): boolean => catalogBelongsToHome(home, path);
    const transformed = stripMarkerOwnedRoutingForNativeEscape(
      initial.text,
      home,
      observation,
    );
    if (!transformed.changed) {
      if (codexRoutingHasOwnedResidue(observation, ownsCatalog)) {
        throw new Error("CodexCommander routing residue is present but is not an exact marker-owned shape");
      }
      return { success: true, changed: false, message: "Codex routing is already native." };
    }
    const transformedObservation = observeCodexRoutingDocument(transformed.content);
    if (transformedObservation.kind !== "parsed") {
      throw new Error("the native transform produced invalid TOML");
    }
    if (typeof transformedObservation.document.model === "string"
      && transformedObservation.document.model.includes("/")) {
      throw new Error("a proxy-dependent root model remains after the native transform");
    }
    if (codexRoutingHasOwnedResidue(transformedObservation, ownsCatalog)) {
      throw new Error("marker-owned CodexCommander routing remains after the native transform");
    }

    const after = Buffer.from(transformed.content, "utf8");
    const candidate = `${initial.canonicalTarget}.ccx-native.${process.pid}.${++nativeEscapeSequence}.tmp`;
    descriptor = openSync(candidate, "wx", Number(initial.targetStat.mode & 0o777n));
    const created = fstatSync(descriptor, { bigint: true });
    if (!created.isFile() || created.nlink !== 1n) {
      throw new Error("native-routing temp is not a private regular file");
    }
    tempPath = candidate;
    tempIdentity = { dev: created.dev, ino: created.ino };
    writeFileSync(descriptor, after);
    fchmodSync(descriptor, Number(initial.targetStat.mode & 0o777n));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    options.beforeRenameForTests?.(after);
    const current = readCodexSurfaceSnapshot(configPath);
    if (!current || !sameCodexSurfaceSnapshot(initial, current)) {
      throw new Error("config.toml changed while native routing was being prepared");
    }
    const publishTemp = lstatSync(tempPath, { bigint: true });
    if (!publishTemp.isFile() || publishTemp.nlink !== 1n
      || publishTemp.dev !== tempIdentity.dev || publishTemp.ino !== tempIdentity.ino
      || !stableConfigSnapshot(tempPath).bytes.equals(after)) {
      throw new Error("native-routing temp changed before publication");
    }
    renameAtomicFile(tempPath, initial.canonicalTarget);
    tempPath = null;
    published = true;
    try {
      const parent = openSync(dirname(initial.canonicalTarget), "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } catch { /* directory fsync is not supported on every platform */ }
    options.afterRenameForTests?.(after);
    if (!samePublishedSurface(
      initial,
      readCodexSurfaceSnapshot(configPath),
      tempIdentity,
      after,
    )) {
      throw new Error("config.toml native-routing verification failed");
    }
    return {
      success: true,
      changed: true,
      message: "Restored native Codex routing in config.toml.",
    };
  } catch (error) {
    return {
      success: false,
      changed: published,
      message: published
        ? `Native Codex routing publication is indeterminate: ${error instanceof Error ? error.message : String(error)}.`
        : `Native Codex routing was not changed: ${error instanceof Error ? error.message : String(error)}.`,
    };
  } finally {
    if (descriptor !== null) try { closeSync(descriptor); } catch { /* best effort */ }
    if (tempPath && tempIdentity) {
      try {
        const current = lstatSync(tempPath, { bigint: true });
        if (current.isFile() && current.nlink === 1n
          && current.dev === tempIdentity.dev && current.ino === tempIdentity.ino) {
          unlinkSync(tempPath);
        }
      } catch { /* a changed path is not ours to clean */ }
    }
  }
}

/** Config-only escape used by Stop and explicit Restore. */
export function restoreNativeCodexRoutingEscape(
  options: NativeCodexRoutingEscapeOptions = {},
): NativeCodexRoutingEscapeResult {
  try {
    return withConfigMutationLockSync(() => restoreNativeCodexRoutingEscapeUnderLock(options));
  } catch (error) {
    return {
      success: false,
      changed: false,
      message: `Native Codex routing was not changed: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

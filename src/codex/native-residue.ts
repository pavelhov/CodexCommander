import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { catalogHasRoutedEntries, parseCatalogJson } from "./catalog/parsing";
import {
  hasInjectedCodexRouting,
  CCX_SECTION_MARKER,
  providerTableString,
  rootTomlString,
} from "./injected-marker";
import { PROVIDER_ID } from "../identity";
import {
  CODEX_CONFIG_PATH,
  CODEX_MODELS_CACHE_PATH,
  CODEX_PROFILE_PATH,
  DEFAULT_CATALOG_PATH,
  getCodexHome,
  readRootTomlString,
} from "./paths";

export type NativeResidueSurface =
  | "config"
  | "profile"
  | "catalog"
  | "models-cache"
  | "journal"
  | "partial-write";

export type NativeRoutedResidueResult =
  | { kind: "clean" }
  | { kind: "residue"; surface: NativeResidueSurface; path: string }
  | { kind: "indeterminate"; surface: NativeResidueSurface; path: string; reason: string };

type ReadResult =
  | { kind: "absent" }
  | { kind: "content"; content: string; path: string }
  | { kind: "indeterminate"; reason: string };

type PathResult =
  | { kind: "absent" }
  | { kind: "path"; path: string; stat: Stats }
  | { kind: "indeterminate"; reason: string };

type CatalogTarget = {
  path: string;
  configured: boolean;
};

type ConfigObservation = {
  classification: NativeRoutedResidueResult;
  catalogTargets: CatalogTarget[];
};

const CONFIG_FILE_NAME = basename(CODEX_CONFIG_PATH);
const PROFILE_FILE_NAME = basename(CODEX_PROFILE_PATH);
const CATALOG_FILE_NAME = basename(DEFAULT_CATALOG_PATH);
const MODELS_CACHE_FILE_NAME = basename(CODEX_MODELS_CACHE_PATH);
const JOURNAL_FILE_NAME = "codexcommander-journal.json";
const ROUTED_CATALOG_DESCRIPTION_PREFIX = "Routed via CodexCommander → ";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function sameStat(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function resolveRegularFile(path: string): PathResult {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return { kind: "indeterminate", reason: errorReason(error) };
  }

  let target = path;
  if (entry.isSymbolicLink()) {
    try {
      target = realpathSync.native(path);
    } catch (error) {
      return { kind: "indeterminate", reason: `unresolvable symlink: ${errorReason(error)}` };
    }
  }

  try {
    const before = statSync(target);
    if (!before.isFile()) {
      return { kind: "indeterminate", reason: "surface is not a regular file" };
    }
    return { kind: "path", path: target, stat: before };
  } catch (error) {
    return { kind: "indeterminate", reason: errorReason(error) };
  }
}

function readRegularFile(path: string): ReadResult {
  const resolved = resolveRegularFile(path);
  if (resolved.kind !== "path") return resolved;
  try {
    const content = readFileSync(resolved.path, "utf8");
    const after = statSync(resolved.path);
    if (!sameStat(resolved.stat, after)) {
      return { kind: "indeterminate", reason: "surface changed while it was being observed" };
    }
    return { kind: "content", content, path: resolved.path };
  } catch (error) {
    return { kind: "indeterminate", reason: errorReason(error) };
  }
}

function indeterminate(
  surface: NativeResidueSurface,
  path: string,
  reason: string,
): NativeRoutedResidueResult {
  return { kind: "indeterminate", surface, path, reason };
}

function classifyToml(
  surface: "config" | "profile",
  path: string,
  classify: (content: string) => "clean" | "residue" | "indeterminate",
): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") return { kind: "clean" };
  if (read.kind === "indeterminate") return indeterminate(surface, path, read.reason);
  try {
    Bun.TOML.parse(read.content);
  } catch (error) {
    return indeterminate(surface, path, `malformed TOML: ${errorReason(error)}`);
  }
  const result = classify(read.content);
  if (result === "residue") return { kind: "residue", surface, path: read.path };
  if (result === "indeterminate") {
    return indeterminate(surface, read.path, "CodexCommander-shaped TOML does not match a complete routed grammar");
  }
  return { kind: "clean" };
}

function catalogPathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function catalogTargets(
  codexHome: string,
  configuredPaths: readonly string[] = [],
): CatalogTarget[] {
  const targets = new Map<string, CatalogTarget>();
  const add = (path: string, configured: boolean) => {
    const key = catalogPathKey(path);
    const existing = targets.get(key);
    targets.set(key, { path: resolve(path), configured: configured || existing?.configured === true });
  };
  for (const configuredPath of configuredPaths) {
    add(resolve(codexHome, configuredPath), true);
  }
  add(join(codexHome, CATALOG_FILE_NAME), false);
  return [...targets.values()];
}

function inspectConfig(codexHome: string, path: string): ConfigObservation {
  const read = readRegularFile(path);
  if (read.kind === "absent") {
    return { classification: { kind: "clean" }, catalogTargets: catalogTargets(codexHome) };
  }
  if (read.kind === "indeterminate") {
    return {
      classification: indeterminate("config", path, read.reason),
      catalogTargets: catalogTargets(codexHome),
    };
  }

  const productionConfiguredPath = readRootTomlString(read.content, "model_catalog_json");
  const productionConfiguredPaths = productionConfiguredPath === null
    ? []
    : [productionConfiguredPath];
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(read.content.replace(/^\uFEFF/, ""));
  } catch (error) {
    return {
      classification: indeterminate("config", read.path, `malformed TOML: ${errorReason(error)}`),
      catalogTargets: catalogTargets(codexHome, productionConfiguredPaths),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      classification: indeterminate("config", read.path, "TOML root is not a table"),
      catalogTargets: catalogTargets(codexHome, productionConfiguredPaths),
    };
  }

  const document = parsed as Record<string, unknown>;
  let targets: CatalogTarget[];
  if (!Object.hasOwn(document, "model_catalog_json")) {
    targets = catalogTargets(codexHome, productionConfiguredPaths);
  } else if (typeof document.model_catalog_json !== "string" || !document.model_catalog_json.trim()) {
    return {
      classification: indeterminate("config", read.path, "model_catalog_json must be one non-empty string"),
      catalogTargets: catalogTargets(codexHome, productionConfiguredPaths),
    };
  } else {
    try {
      targets = catalogTargets(codexHome, [
        ...productionConfiguredPaths,
        document.model_catalog_json,
      ]);
    } catch (error) {
      return {
        classification: indeterminate("config", read.path, `model_catalog_json cannot be resolved: ${errorReason(error)}`),
        catalogTargets: catalogTargets(codexHome, productionConfiguredPaths),
      };
    }
  }

  let classification: NativeRoutedResidueResult = { kind: "clean" };
  if (hasInjectedCodexRouting(read.content)) {
    classification = { kind: "residue", surface: "config", path: read.path };
  } else {
    const hasMarker = read.content.includes(CCX_SECTION_MARKER);
    const provider = rootTomlString(read.content, "model_provider");
    const providerBaseUrl = providerTableString(read.content, PROVIDER_ID, "base_url");
    if (hasMarker || provider === PROVIDER_ID || providerBaseUrl !== null) {
      classification = indeterminate(
        "config",
        read.path,
        "CodexCommander-shaped TOML does not match a complete routed grammar",
      );
    }
  }
  return { classification, catalogTargets: targets };
}

function classifyProfile(path: string): NativeRoutedResidueResult {
  return classifyToml("profile", path, content => {
    const generatedFallback = content.startsWith("# CodexCommander proxy fallback config (Design B)")
      && rootTomlString(content, "openai_base_url") !== null;
    const generatedNamedProfile = content.startsWith("# CodexCommander proxy profile — use with:")
      && hasInjectedCodexRouting(content);
    if (generatedFallback || generatedNamedProfile) return "residue";
    return "indeterminate";
  });
}

function isCodexCommanderRoutedCatalogEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.description === "string"
    && entry.description.startsWith(ROUTED_CATALOG_DESCRIPTION_PREFIX);
}

function classifyCatalogLike(
  surface: "catalog" | "models-cache",
  path: string,
  configured = false,
): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") {
    return configured
      ? indeterminate(surface, path, "configured catalog target is absent")
      : { kind: "clean" };
  }
  if (read.kind === "indeterminate") return indeterminate(surface, path, read.reason);
  const catalog = parseCatalogJson(read.content);
  if (!catalog) return indeterminate(surface, path, "malformed catalog JSON");
  if ((catalog.models ?? []).some(isCodexCommanderRoutedCatalogEntry)) {
    return { kind: "residue", surface, path: read.path };
  }
  if (catalogHasRoutedEntries(catalog)) {
    return indeterminate(surface, read.path, "routed catalog rows lack the CodexCommander authorship signature");
  }
  return { kind: "clean" };
}

function isJournal(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  return journal.version === 1
    && typeof journal.originalConfig === "string"
    && (journal.originalProfile === null || typeof journal.originalProfile === "string")
    && typeof journal.pid === "number"
    && Number.isInteger(journal.pid)
    && typeof journal.timestamp === "string";
}

function classifyJournal(path: string): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") return { kind: "clean" };
  if (read.kind === "indeterminate") return indeterminate("journal", path, read.reason);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch (error) {
    return indeterminate("journal", read.path, `malformed journal JSON: ${errorReason(error)}`);
  }
  return isJournal(parsed)
    ? { kind: "residue", surface: "journal", path: read.path }
    : indeterminate("journal", read.path, "journal JSON has an unknown or partial shape");
}

function classifyPartialWrites(targetPaths: string[]): NativeRoutedResidueResult {
  const targetsByParent = new Map<string, { path: string; names: Set<string> }>();
  const addTarget = (path: string) => {
    const parent = dirname(path);
    const key = catalogPathKey(parent);
    const observed = targetsByParent.get(key) ?? { path: parent, names: new Set<string>() };
    observed.names.add(basename(path));
    targetsByParent.set(key, observed);
  };
  for (const path of targetPaths) {
    addTarget(path);
    const resolved = resolveRegularFile(path);
    if (resolved.kind === "path") addTarget(resolved.path);
  }

  for (const target of targetsByParent.values()) {
    let names: string[];
    try {
      names = readdirSync(target.path);
    } catch (error) {
      return indeterminate("partial-write", target.path, errorReason(error));
    }
    for (const name of names) {
      const match = /^(.*)\.ccx\.\d+\.\d+\.tmp$/.exec(name);
      if (match?.[1] && target.names.has(match[1])) {
        return indeterminate("partial-write", join(target.path, name), "CodexCommander atomic-write artifact is still present");
      }
    }
  }
  return { kind: "clean" };
}

/** Read-only, fail-closed observation of every CodexCommander-routed Codex surface. */
export function classifyNativeRoutedResidue(): NativeRoutedResidueResult {
  let codexHome: string;
  try {
    codexHome = getCodexHome();
  } catch (error) {
    const unresolved = process.env.CODEX_HOME?.trim() || "CODEX_HOME";
    return indeterminate("partial-write", unresolved, `CODEX_HOME cannot be resolved: ${errorReason(error)}`);
  }

  const configPath = join(codexHome, CONFIG_FILE_NAME);
  const profilePath = join(codexHome, PROFILE_FILE_NAME);
  const modelsCachePath = join(codexHome, MODELS_CACHE_FILE_NAME);
  const journalPath = join(codexHome, JOURNAL_FILE_NAME);
  const config = inspectConfig(codexHome, configPath);
  const atomicWriteTargets = [
    configPath,
    profilePath,
    modelsCachePath,
    journalPath,
    ...config.catalogTargets.map(target => target.path),
  ];
  const classifiers = [
    () => classifyPartialWrites(atomicWriteTargets),
    () => config.classification,
    () => classifyProfile(profilePath),
    ...config.catalogTargets.map(target => () => classifyCatalogLike("catalog", target.path, target.configured)),
    () => classifyCatalogLike("models-cache", modelsCachePath),
    () => classifyJournal(journalPath),
  ];
  const results = classifiers.map(classify => classify());
  return results.find(result => result.kind === "indeterminate")
    ?? results.find(result => result.kind === "residue")
    ?? { kind: "clean" };
}

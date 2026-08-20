import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  OWNER_FILE,
  UNINSTALL_MANIFEST,
} from "../identity";
import type { GenerationContext } from "./state-store-sweeper";

export const CONFIG_OWNER_FILE = OWNER_FILE;
export const CONFIG_UNINSTALL_MANIFEST = UNINSTALL_MANIFEST;
const OWNERSHIP_METADATA_FILES = [
  CONFIG_OWNER_FILE,
  CONFIG_UNINSTALL_MANIFEST,
] as const;

export type ConfigRemovalResult = {
  status: "absent" | "removed" | "retained-root" | "partial" | "refused";
  reason?: string;
  residualPaths: string[];
};

type ConfigOwner = {
  version: 1;
  ownerId: string;
  root: string;
};

type ConfigUninstallManifest = ConfigOwner & {
  paths: string[];
};

type ConfigOwnership = {
  owner: ConfigOwner;
  manifest: ConfigUninstallManifest;
  ownerFile: string;
  manifestFile: string;
  rootIdentity: ConfigOwnershipRootIdentity;
};

type ConfigOwnershipRootIdentity = {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
};

export type ConfigRootFileIdentity = {
  dev: bigint;
  ino: bigint;
};

type ConfigRootIdentityOverride = (
  path: string,
  actual: ConfigRootFileIdentity,
) => ConfigRootFileIdentity;

let configRootIdentityOverrideForTests: ConfigRootIdentityOverride | null = null;

/** Test-only seam for simulating filesystem identifiers that local fixtures cannot produce. */
export function setConfigRootIdentityOverrideForTests(
  override: ConfigRootIdentityOverride | null,
): void {
  configRootIdentityOverrideForTests = override;
}

export type PhysicalConfigRootInspection =
  | { kind: "unsafe" }
  | { kind: "valid"; identity: ConfigRootFileIdentity };

/** Inspect a root without following links and retain its filesystem identity losslessly. */
export function inspectPhysicalConfigRoot(path: string): PhysicalConfigRootInspection {
  const root = lstatSync(path, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) return { kind: "unsafe" };
  const actual = { dev: root.dev, ino: root.ino };
  const identity = configRootIdentityOverrideForTests?.(path, actual) ?? actual;
  // Some filesystems report ino=0 when no stable file identifier is available.
  if (identity.ino === 0n) return { kind: "unsafe" };
  return { kind: "valid", identity };
}

const METADATA_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_PATHS = 1024;
const INITIAL_OWNED_PATHS = [
  "artifacts",
  "auth.json",
  "auth.store.lock",
  "claude-env.sh",
  "codex-accounts.json",
  "codex-runtime-clamp.json",
  "codex-runtime.json",
  "codex-shim.autorestore.lock",
  "codex-shim.json",
  "config.json",
  "config-mutation.sqlite",
  "config-mutation.sqlite-journal",
  "config-mutation.sqlite-shm",
  "config-mutation.sqlite-wal",
  "crash.log",
  "kimi-device-id",
  "mimo-client-id",
  "codexcommander.pid",
  "codexcommander-service-launcher.vbs",
  "codexcommander-service-task.xml",
  "codexcommander-service.cmd",
  "codexcommander-tray-offline.ico",
  "codexcommander-tray-online.ico",
  "codexcommander-tray-warning.ico",
  "codexcommander-tray.ps1",
  "codexcommander-tray.vbs",
  "proxy-ensure.lock",
  "proxy-start.lock",
  "responses-state.json",
  "runtime-port.json",
  "service-api-token",
  "service-state.json",
  "service.log",
  "system-env-port",
  "tray-heartbeat.json",
  "tray-state.json",
  "usage-debug.jsonl",
  "usage.jsonl",
  "version.json",
  "winsw",
] as const;
const ownershipCache = new Map<string, ConfigOwnership | null>();
let lastReconciledGeneration = 0;

export function listLiveConfigOwnershipRoots(currentConfigDir: string): ReadonlySet<string> {
  const currentRoot = ownershipCacheKey(currentConfigDir);
  const roots = new Set<string>([currentRoot]);
  for (const [root, ownership] of ownershipCache) {
    if (root === currentRoot) continue;
    if (ownership?.manifest.paths.some(rel => existsSync(join(root, ...rel.split("/"))))) {
      roots.add(root);
    }
  }
  return roots;
}

export function reconcileConfigOwnershipRoots(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const [root, ownership] of ownershipCache) {
    if (context.configRoots.has(root)) continue;
    const hasLiveOwnedPath = ownership?.manifest.paths.some(rel =>
      existsSync(join(root, ...rel.split("/"))));
    if (hasLiveOwnedPath) continue;
    ownershipCache.delete(root);
    removed += 1;
  }
  lastReconciledGeneration = context.generation;
  return removed;
}

function ownershipCacheKey(configDir: string): string {
  const key = resolve(configDir);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function readBoundedJson(path: string): unknown {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("ownership metadata is not a regular file");
  }
  if (metadata.size > METADATA_MAX_BYTES) throw new Error("ownership metadata is too large");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isOwner(value: unknown): value is ConfigOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return owner.version === 1
    && typeof owner.ownerId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.ownerId)
    && typeof owner.root === "string";
}

function isManifest(value: unknown): value is ConfigUninstallManifest {
  if (!isOwner(value)) return false;
  const paths = (value as Record<string, unknown>).paths;
  return Array.isArray(paths)
    && paths.length <= MANIFEST_MAX_PATHS
    && paths.every(path => typeof path === "string");
}

function canonicalRoot(configDir: string): string {
  return realpathSync.native(resolve(configDir));
}

function configOwnershipRootIdentity(configDir: string): ConfigOwnershipRootIdentity {
  const root = inspectPhysicalConfigRoot(configDir);
  if (root.kind !== "valid") {
    throw new Error("config ownership root is not a physical directory");
  }
  return {
    canonicalPath: canonicalRoot(configDir),
    ...root.identity,
  };
}

function sameConfigOwnershipRoot(
  left: ConfigOwnershipRootIdentity,
  right: ConfigOwnershipRootIdentity,
): boolean {
  return samePath(left.canonicalPath, right.canonicalPath)
    && left.dev === right.dev
    && left.ino === right.ino;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (
    rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  );
}

function manifestRelativePath(configDir: string, candidatePath: string): string | null {
  const root = resolve(configDir);
  const candidate = resolve(candidatePath);
  const rel = relative(root, candidate);
  if (
    !rel
    || rel === ".."
    || rel.startsWith(`..${sep}`)
    || isAbsolute(rel)
  ) return null;
  const normalized = rel.split(sep).join("/");
  if (normalized.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\"))) {
    return null;
  }
  if (OWNERSHIP_METADATA_FILES.some(name => normalized === name)) return null;
  return normalized;
}

function loadOwnership(configDir: string): ConfigOwnership | null {
  const ownerName = CONFIG_OWNER_FILE;
  const manifestName = CONFIG_UNINSTALL_MANIFEST;
  const ownerPath = join(configDir, ownerName);
  const manifestPath = join(configDir, manifestName);
  if (!existsSync(ownerPath) || !existsSync(manifestPath)) return null;
  try {
    const owner = readBoundedJson(ownerPath);
    const manifest = readBoundedJson(manifestPath);
    const rootIdentity = configOwnershipRootIdentity(configDir);
    const root = rootIdentity.canonicalPath;
    if (
      !isOwner(owner)
      || !isManifest(manifest)
      || owner.ownerId !== manifest.ownerId
      || !samePath(owner.root, root)
      || !samePath(manifest.root, root)
    ) return null;
    return {
      owner,
      manifest,
      ownerFile: ownerName,
      manifestFile: manifestName,
      rootIdentity,
    };
  } catch {
    return null;
  }
}

function createOwnership(configDir: string): ConfigOwnership | null {
  let rootIdentity: ConfigOwnershipRootIdentity;
  try {
    rootIdentity = configOwnershipRootIdentity(configDir);
  } catch {
    return null;
  }
  if (readdirSync(configDir).length !== 0) return null;
  const owner: ConfigOwner = {
    version: 1,
    ownerId: randomUUID(),
    root: rootIdentity.canonicalPath,
  };
  const manifest: ConfigUninstallManifest = { ...owner, paths: [...INITIAL_OWNED_PATHS] };
  writeFileSync(join(configDir, CONFIG_OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    writeFileSync(join(configDir, CONFIG_UNINSTALL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    try { unlinkSync(join(configDir, CONFIG_OWNER_FILE)); } catch { /* incomplete metadata fails closed */ }
    throw error;
  }
  return {
    owner,
    manifest,
    ownerFile: CONFIG_OWNER_FILE,
    manifestFile: CONFIG_UNINSTALL_MANIFEST,
    rootIdentity,
  };
}

function writeManifest(
  configDir: string,
  manifest: ConfigUninstallManifest,
  manifestFile = CONFIG_UNINSTALL_MANIFEST,
): void {
  const path = join(configDir, manifestFile);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function removeOwnedEntry(root: string, path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (!entry.isDirectory()) {
    unlinkSync(path);
    return;
  }

  const realDirectory = realpathSync.native(path);
  if (!isWithinRoot(root, realDirectory)) {
    throw new Error(`owned directory resolves outside the config root: ${path}`);
  }
  for (const name of readdirSync(path)) {
    removeOwnedEntry(root, join(path, name));
  }
  rmdirSync(path);
}

export function recordOwnedConfigPath(configDir: string, candidatePath: string): boolean {
  const rel = manifestRelativePath(configDir, candidatePath);
  if (!rel) return false;
  const cacheKey = ownershipCacheKey(configDir);
  if (!existsSync(configDir)) {
    ownershipCache.delete(cacheKey);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  let ownership = ownershipCache.get(cacheKey);
  if (ownership) {
    try {
      if (!sameConfigOwnershipRoot(
        ownership.rootIdentity,
        configOwnershipRootIdentity(configDir),
      )) return false;
    } catch {
      return false;
    }
  }
  if (ownership === undefined) {
    ownership = loadOwnership(configDir) ?? createOwnership(configDir);
    ownershipCache.set(cacheKey, ownership);
  }
  if (!ownership) return false;
  if (ownership.manifest.paths.includes(rel)) return true;
  const manifest = {
    ...ownership.manifest,
    paths: [...ownership.manifest.paths, rel].sort(),
  };
  writeManifest(configDir, manifest, ownership.manifestFile);
  ownershipCache.set(cacheKey, { ...ownership, manifest });
  return true;
}

const LIFECYCLE_ROOT_LOCK = "proxy-ensure.lock";

function removeOwnedConfigStateInternal(
  configDir: string,
  retainLifecycleRoot: boolean,
): ConfigRemovalResult {
  ownershipCache.delete(ownershipCacheKey(configDir));
  if (!existsSync(configDir)) return { status: "absent", residualPaths: [] };
  const root = lstatSync(configDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return {
      status: "refused",
      reason: "config ownership root is not a real directory",
      residualPaths: [configDir],
    };
  }
  const ownership = loadOwnership(configDir);
  if (!ownership) {
    return {
      status: "refused",
      reason: "config ownership metadata is missing or invalid",
      residualPaths: [configDir],
    };
  }

  for (const rel of ownership.manifest.paths) {
    const path = manifestRelativePath(configDir, join(configDir, ...rel.split("/")));
    if (path !== rel) {
      return {
        status: "refused",
        reason: "config ownership manifest contains an unsafe path",
        residualPaths: [configDir],
      };
    }
  }

  let lifecycleLockIdentity: { dev: number; ino: number } | null = null;
  if (retainLifecycleRoot) {
    const lifecycleLockPath = join(configDir, LIFECYCLE_ROOT_LOCK);
    try {
      const lock = lstatSync(lifecycleLockPath);
      if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1) {
        throw new Error("held lifecycle lock is not a safe regular file");
      }
      if (typeof process.getuid === "function" && lock.uid !== process.getuid()) {
        throw new Error("held lifecycle lock is owned by another user");
      }
      lifecycleLockIdentity = { dev: lock.dev, ino: lock.ino };
    } catch (error) {
      return {
        status: "refused",
        reason: `held lifecycle lock could not be retained: ${error instanceof Error ? error.message : String(error)}`,
        residualPaths: [configDir],
      };
    }
  }

  const rootPath = canonicalRoot(configDir);
  for (const rel of ownership.manifest.paths) {
    if (retainLifecycleRoot && rel === LIFECYCLE_ROOT_LOCK) continue;
    const path = join(configDir, ...rel.split("/"));
    if (!existsSync(path)) continue;
    try {
      removeOwnedEntry(rootPath, path);
    } catch (error) {
      return {
        status: "partial",
        reason: `could not remove owned path ${rel}: ${error instanceof Error ? error.message : String(error)}`,
        residualPaths: [path],
      };
    }
  }

  if (retainLifecycleRoot && lifecycleLockIdentity) {
    const lifecycleLockPath = join(configDir, LIFECYCLE_ROOT_LOCK);
    try {
      const lock = lstatSync(lifecycleLockPath);
      if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1
        || lock.dev !== lifecycleLockIdentity.dev || lock.ino !== lifecycleLockIdentity.ino) {
        throw new Error("held lifecycle lock changed during config cleanup");
      }
    } catch (error) {
      return {
        status: "partial",
        reason: error instanceof Error ? error.message : String(error),
        residualPaths: [configDir],
      };
    }

    const expected = new Set<string>([
      ...OWNERSHIP_METADATA_FILES,
      LIFECYCLE_ROOT_LOCK,
    ]);
    const residualPaths = readdirSync(configDir)
      .filter(name => !expected.has(name))
      .map(name => join(configDir, name));
    if (residualPaths.length > 0) {
      return {
        status: "partial",
        reason: "unowned files remain in the config directory",
        residualPaths,
      };
    }
    return { status: "retained-root", residualPaths: [] };
  }

  try {
    // Remove the complete current metadata pair. The validated pair authorizes the uninstall;
    // an orphaned half must not keep an otherwise empty root alive.
    for (const name of OWNERSHIP_METADATA_FILES) {
      if (existsSync(join(configDir, name))) unlinkSync(join(configDir, name));
    }
  } catch (error) {
    return {
      status: "partial",
      reason: `could not remove ownership metadata: ${error instanceof Error ? error.message : String(error)}`,
      residualPaths: readdirSync(configDir).map(name => join(configDir, name)),
    };
  }
  const residualPaths = readdirSync(configDir).map(name => join(configDir, name));
  if (residualPaths.length > 0) {
    return {
      status: "partial",
      reason: "unowned files remain in the config directory",
      residualPaths,
    };
  }
  try {
    rmdirSync(configDir);
  } catch (error) {
    return {
      status: "partial",
      reason: `could not remove the empty config directory: ${error instanceof Error ? error.message : String(error)}`,
      residualPaths: [configDir],
    };
  }
  return { status: "removed", residualPaths: [] };
}

export function removeOwnedConfigState(configDir: string): ConfigRemovalResult {
  return removeOwnedConfigStateInternal(configDir, false);
}

/**
 * Remove every manifest-owned artifact except the currently-held lifecycle E lock.
 * The validated owner/manifest pair and root remain so unlinking E on release cannot
 * create a second lock namespace for a concurrently waiting Start.
 */
export function removeOwnedConfigArtifactsRetainingLifecycleRoot(
  configDir: string,
): ConfigRemovalResult {
  return removeOwnedConfigStateInternal(configDir, true);
}

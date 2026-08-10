/**
 * Durable OpenCode client integration.
 *
 * CodexCommander owns exactly one JSONC path (`provider.codexcommander`) in the user's
 * global OpenCode config. The original bytes are backed up outside OpenCode's
 * config directory and every mutation is serialized by the process-safe config
 * transaction. Credentials are referenced through a protected file; neither the
 * config nor the journal serializes the admission token.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import {
  getConfigDir,
  renameAtomicFile,
  withConfigMutationLockSync,
} from "../config";
import { shouldInjectApiAuthHeader } from "../codex/inject";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import {
  hardenSecretDir,
  hardenSecretPath,
  windowsSecretAclApplies,
} from "../lib/windows-secret-acl";
import { loadServiceTokenFromFile, serviceApiTokenFilePath } from "../lib/service-secrets";
import { API_KEY_HEADER, readEnv } from "../identity";
import type { OpencodeLaunchEnv, OpencodeProviderBlock } from "./config-export";
import type { CodexCommanderConfig } from "../types";

const JOURNAL_VERSION = 1 as const;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 128 * 1024;
const PROVIDER_PATH = ["provider", "codexcommander"] as const;

export interface OpencodeIntegrationPaths {
  configJsonPath: string;
  configJsoncPath: string;
  stateDir: string;
  backupsDir: string;
  journalPath: string;
  tokenPath: string;
}

export interface OpencodeIntegrationJournal {
  version: typeof JOURNAL_VERSION;
  targetPath: string;
  targetExisted: boolean;
  backupPath: string;
  beforeHash: string;
  afterHash: string;
  managedProviderHash: string;
  appliedAt: string;
  autoConnect: boolean;
  /** False once a re-apply incorporated user edits that the original backup lacks. */
  exactRestoreEligible: boolean;
}

export interface OpencodeIntegrationStatus {
  state: "not_applied" | "applied" | "modified" | "needs_attention";
  targetPath: string;
  autoConnect: boolean;
  canRestore: boolean;
  tokenReady: boolean;
  detail?: string;
}

export interface ApplyOpencodeIntegrationResult {
  status: OpencodeIntegrationStatus;
  changed: boolean;
}

export interface RestoreOpencodeIntegrationOptions {
  mode?: "surgical" | "full";
  /** Required for full restore when the target changed after apply. */
  confirmCurrentHash?: string;
}

export interface RestoreOpencodeIntegrationResult {
  restored: boolean;
  exact: boolean;
  preservedUserEdits: boolean;
  status: OpencodeIntegrationStatus;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizedPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function ensureRegularFile(path: string, maxBytes: number): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${path} is not a regular file`);
  }
  if (info.size > maxBytes) throw new Error(`${path} exceeds the ${maxBytes}-byte safety limit`);
}

function ensureProtectedStateFile(path: string, maxBytes: number): void {
  ensureRegularFile(path, maxBytes);
  const info = lstatSync(path);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${path} is owned by another user`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${path} has unsafe permissions`);
  }
}

function isProtectedStateFile(path: string, maxBytes: number): boolean {
  try {
    ensureProtectedStateFile(path, maxBytes);
    return true;
  } catch {
    return false;
  }
}

function readBoundedRegularFile(path: string, maxBytes: number): string {
  ensureRegularFile(path, maxBytes);
  return readFileSync(path, "utf8");
}

function readProtectedStateFile(path: string, maxBytes: number): string {
  ensureProtectedStateFile(path, maxBytes);
  return readFileSync(path, "utf8");
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is unavailable on some Windows/filesystem combinations.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function atomicWriteExternal(path: string, content: string, mode: number): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.ccx.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try { chmodSync(temp, mode); } catch { /* platform may ignore chmod */ }
    renameAtomicFile(temp, path, {
      platform: process.platform,
      rename: renameSync,
      sleep: Bun.sleepSync,
    });
    fsyncDirectory(parent);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temp); } catch { /* absent or locked */ }
    throw error;
  }
}

function ensureStateDirectory(paths: OpencodeIntegrationPaths): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.backupsDir, { recursive: true, mode: 0o700 });
  const stateRoot = dirname(dirname(paths.stateDir));
  const resolvedRoot = realpathSync(stateRoot);
  for (const path of [paths.stateDir, paths.backupsDir]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${path} is not a safe directory`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`${path} is owned by another user`);
    }
    const resolvedPath = realpathSync(path);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`${path} resolves outside the CodexCommander state directory`);
    }
  }
  try { chmodSync(paths.stateDir, 0o700); } catch { /* platform may ignore chmod */ }
  try { chmodSync(paths.backupsDir, 0o700); } catch { /* platform may ignore chmod */ }
  if (process.platform !== "win32") {
    for (const path of [paths.stateDir, paths.backupsDir]) {
      if ((lstatSync(path).mode & 0o077) !== 0) {
        throw new Error(`${path} could not be protected`);
      }
    }
  }
  if (windowsSecretAclApplies()) {
    hardenSecretDir(paths.stateDir, { required: true, timeoutMemoKey: `${paths.stateDir}::opencode` });
    hardenSecretDir(paths.backupsDir, { required: true, timeoutMemoKey: `${paths.backupsDir}::opencode-backups` });
  }
  const root = getConfigDir();
  for (const path of [paths.stateDir, paths.backupsDir, paths.journalPath, paths.tokenPath]) {
    recordOwnedConfigPath(root, path);
  }
}

function writeProtected(path: string, content: string): void {
  atomicWriteExternal(path, content, 0o600);
  try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
  if (windowsSecretAclApplies()) hardenSecretPath(path, { required: true });
  ensureProtectedStateFile(path, Math.max(MAX_CONFIG_BYTES, MAX_JOURNAL_BYTES));
}

function parseJsoncObject(text: string, label: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(`${label} is malformed JSONC (${printParseErrorCode(first.error)} at offset ${first.offset})`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object`);
  if (parsed.provider !== undefined && !isRecord(parsed.provider)) {
    throw new Error(`${label} provider must be a JSON object when present`);
  }
  return parsed;
}

function providerValue(parsed: Record<string, unknown>): unknown {
  const provider = isRecord(parsed.provider) ? parsed.provider : undefined;
  return provider?.codexcommander;
}

function formattingFor(text: string): FormattingOptions {
  const indented = text.match(/\n([ \t]+)\S/);
  const indentation = indented?.[1] ?? "  ";
  return {
    insertSpaces: !indentation.includes("\t"),
    tabSize: indentation.includes("\t") ? 1 : Math.max(1, indentation.length),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    insertFinalNewline: text.endsWith("\n"),
  };
}

function modifyJsoncPath(text: string, path: readonly string[], value: unknown): string {
  return applyEdits(text, modify(text, [...path], value, { formattingOptions: formattingFor(text) }));
}

function modifyProvider(text: string, value: unknown): string {
  return modifyJsoncPath(text, PROVIDER_PATH, value);
}

function journalIsValid(value: unknown): value is OpencodeIntegrationJournal {
  if (!isRecord(value)) return false;
  return value.version === JOURNAL_VERSION
    && typeof value.targetPath === "string"
    && typeof value.targetExisted === "boolean"
    && typeof value.backupPath === "string"
    && typeof value.beforeHash === "string" && /^[0-9a-f]{64}$/.test(value.beforeHash)
    && typeof value.afterHash === "string" && /^[0-9a-f]{64}$/.test(value.afterHash)
    && typeof value.managedProviderHash === "string" && /^[0-9a-f]{64}$/.test(value.managedProviderHash)
    && typeof value.appliedAt === "string"
    && typeof value.autoConnect === "boolean"
    && typeof value.exactRestoreEligible === "boolean";
}

function readJournal(paths: OpencodeIntegrationPaths): OpencodeIntegrationJournal | null {
  if (!existsSync(paths.journalPath)) return null;
  const text = readProtectedStateFile(paths.journalPath, MAX_JOURNAL_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("OpenCode integration journal is malformed"); }
  if (!journalIsValid(parsed)) throw new Error("OpenCode integration journal has an unsupported shape");
  if (!samePath(parsed.targetPath, paths.configJsonPath) && !samePath(parsed.targetPath, paths.configJsoncPath)) {
    throw new Error("OpenCode integration journal targets an unexpected path");
  }
  if (!samePath(dirname(parsed.backupPath), paths.backupsDir)) {
    throw new Error("OpenCode integration journal backup path is outside its owned directory");
  }
  return parsed;
}

function writeJournal(paths: OpencodeIntegrationPaths, journal: OpencodeIntegrationJournal): void {
  writeProtected(paths.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

function selectedConfigPath(paths: OpencodeIntegrationPaths): string {
  // OpenCode loads JSON first and JSONC second, so JSONC is the effective global
  // layer whenever it exists.
  if (existsSync(paths.configJsoncPath)) return paths.configJsoncPath;
  if (existsSync(paths.configJsonPath)) return paths.configJsonPath;
  return paths.configJsonPath;
}

function targetSnapshot(path: string): { existed: boolean; text: string; mode: number } {
  if (!existsSync(path)) return { existed: false, text: "{}\n", mode: 0o600 };
  const text = readBoundedRegularFile(path, MAX_CONFIG_BYTES);
  return { existed: true, text, mode: statSync(path).mode & 0o777 };
}

function removeRegularFile(path: string): void {
  if (!existsSync(path)) return;
  ensureRegularFile(path, MAX_CONFIG_BYTES);
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

export function opencodeIntegrationPaths(
  env: OpencodeLaunchEnv = process.env,
  home: string = homedir(),
  stateRoot: string = getConfigDir(),
): OpencodeIntegrationPaths {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const configDir = join(configHome, "opencode");
  const stateDir = join(stateRoot, "integrations", "opencode");
  return {
    configJsonPath: join(configDir, "opencode.json"),
    configJsoncPath: join(configDir, "opencode.jsonc"),
    stateDir,
    backupsDir: join(stateDir, "backups"),
    journalPath: join(stateDir, "journal.json"),
    tokenPath: join(stateDir, "proxy-api-key"),
  };
}

export function opencodeFileReference(path: string): string {
  const absolute = resolve(path);
  if (/[{}\r\n]/.test(absolute)) {
    throw new Error("OpenCode credential reference path contains unsupported characters");
  }
  return `{file:${absolute}}`;
}

/** Resolve the same data-plane admission credential used by `ccx opencode`. */
export function resolveOpencodeAdmissionToken(
  config: CodexCommanderConfig,
  env: OpencodeLaunchEnv = process.env,
): string {
  const environment = readEnv("CODEXCOMMANDER_API_AUTH_TOKEN", env as NodeJS.ProcessEnv);
  if (environment) return environment;
  const tokenFileEnv = env.CCX_API_TOKEN_FILE?.trim()
    ? env
    : { ...env, CCX_API_TOKEN_FILE: serviceApiTokenFilePath() };
  const service = loadServiceTokenFromFile(tokenFileEnv)?.trim();
  if (service) return service;
  const configured = config.apiKeys?.[0]?.key?.trim();
  if (configured) return configured;
  // The local loopback data plane accepts the launcher placeholder when no
  // explicit admission credential is configured. A remote bind never may.
  if (!shouldInjectApiAuthHeader(config)) return "ccx";
  throw new Error("A proxy API key is required before OpenCode can connect to a non-loopback bind");
}

/** Clone a generated provider block and replace its env reference with a file reference. */
export function opencodePersistentProviderBlock(
  providerBlock: OpencodeProviderBlock,
  config: CodexCommanderConfig,
  tokenPath: string,
): OpencodeProviderBlock {
  const fileReference = opencodeFileReference(tokenPath);
  const options: OpencodeProviderBlock["options"] = {
    ...providerBlock.options,
    ...(providerBlock.options.headers ? { headers: { ...providerBlock.options.headers } } : {}),
  };
  if (shouldInjectApiAuthHeader(config)) {
    delete options.apiKey;
    options.headers = { ...(options.headers ?? {}), [API_KEY_HEADER]: fileReference };
  } else {
    options.apiKey = fileReference;
    if (options.headers) {
      delete options.headers[API_KEY_HEADER];
      if (Object.keys(options.headers).length === 0) delete options.headers;
    }
  }
  return {
    ...providerBlock,
    options,
    models: Object.fromEntries(Object.entries(providerBlock.models).map(([id, model]) => [id, {
      ...model,
      ...(model.limit ? { limit: { ...model.limit } } : {}),
    }])),
  };
}

export function inspectOpencodeIntegration(
  paths: OpencodeIntegrationPaths = opencodeIntegrationPaths(),
): OpencodeIntegrationStatus {
  const targetPath = selectedConfigPath(paths);
  let journal: OpencodeIntegrationJournal | null;
  try {
    journal = readJournal(paths);
  } catch (error) {
    return {
      state: "needs_attention",
      targetPath,
      autoConnect: false,
      canRestore: false,
      tokenReady: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!journal) {
    return {
      state: "not_applied",
      targetPath,
      autoConnect: false,
      canRestore: false,
      tokenReady: false,
    };
  }
  if (!samePath(journal.targetPath, targetPath)) {
    return {
      state: "needs_attention",
      targetPath: journal.targetPath,
      autoConnect: journal.autoConnect,
      canRestore: isProtectedStateFile(journal.backupPath, MAX_CONFIG_BYTES),
      tokenReady: isProtectedStateFile(paths.tokenPath, MAX_JOURNAL_BYTES),
      detail: "OpenCode's active global config changed; restore the previous integration before applying again.",
    };
  }
  if (!isProtectedStateFile(journal.backupPath, MAX_CONFIG_BYTES)) {
    return {
      state: "needs_attention",
      targetPath,
      autoConnect: journal.autoConnect,
      canRestore: false,
      tokenReady: isProtectedStateFile(paths.tokenPath, MAX_JOURNAL_BYTES),
      detail: "The OpenCode integration backup is missing.",
    };
  }
  try {
    const backup = readProtectedStateFile(journal.backupPath, MAX_CONFIG_BYTES);
    if (sha256(backup) !== journal.beforeHash) throw new Error("The OpenCode integration backup failed its integrity check.");
    const current = targetSnapshot(targetPath);
    const parsed = parseJsoncObject(current.text, targetPath);
    const managed = providerValue(parsed);
    const managedHash = managed === undefined ? null : sha256(JSON.stringify(managed));
    const tokenReady = isProtectedStateFile(paths.tokenPath, MAX_JOURNAL_BYTES);
    const bytesAndProviderMatch = sha256(current.text) === journal.afterHash
      && managedHash === journal.managedProviderHash;
    return {
      state: !tokenReady ? "needs_attention" : bytesAndProviderMatch ? "applied" : "modified",
      targetPath,
      autoConnect: journal.autoConnect,
      canRestore: true,
      tokenReady,
      ...(!tokenReady
        ? { detail: "The protected OpenCode credential reference is missing or unsafe." }
        : managed === undefined
          ? { detail: "The managed provider entry is no longer present." }
          : {}),
    };
  } catch (error) {
    return {
      state: "needs_attention",
      targetPath,
      autoConnect: journal.autoConnect,
      canRestore: true,
      tokenReady: existsSync(paths.tokenPath),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function applyOpencodeIntegration(
  providerBlock: OpencodeProviderBlock,
  admissionToken: string,
  options: {
    paths?: OpencodeIntegrationPaths;
    autoConnect?: boolean;
    config?: CodexCommanderConfig;
  } = {},
): ApplyOpencodeIntegrationResult {
  const paths = options.paths ?? opencodeIntegrationPaths();
  const token = admissionToken.trim();
  if (!token) throw new Error("A proxy admission token is required for OpenCode integration");
  return withConfigMutationLockSync(() => {
    ensureStateDirectory(paths);
    const targetPath = selectedConfigPath(paths);
    const existingJournal = readJournal(paths);
    if (existingJournal && !samePath(existingJournal.targetPath, targetPath)) {
      throw new Error("OpenCode's active global config changed; restore the previous integration before applying again");
    }
    const target = targetSnapshot(targetPath);
    const parsedTarget = parseJsoncObject(target.text, targetPath);

    let journal = existingJournal;
    if (!journal) {
      const backupPath = join(paths.backupsDir, `${Date.now()}-${randomUUID()}.config`);
      writeProtected(backupPath, target.text);
      recordOwnedConfigPath(getConfigDir(), backupPath);
      journal = {
        version: JOURNAL_VERSION,
        targetPath,
        targetExisted: target.existed,
        backupPath,
        beforeHash: sha256(target.text),
        afterHash: "0".repeat(64),
        managedProviderHash: "0".repeat(64),
        appliedAt: new Date().toISOString(),
        autoConnect: options.autoConnect ?? false,
        exactRestoreEligible: true,
      };
    } else {
      const backup = readProtectedStateFile(journal.backupPath, MAX_CONFIG_BYTES);
      if (sha256(backup) !== journal.beforeHash) {
        throw new Error("OpenCode integration backup integrity check failed");
      }
    }

    const persistentBlock = opencodePersistentProviderBlock(
      providerBlock,
      options.config ?? ({
        port: 10100,
        hostname: providerBlock.options.headers?.[API_KEY_HEADER] ? "0.0.0.0" : "127.0.0.1",
        defaultProvider: "codexcommander",
        providers: {},
      } as CodexCommanderConfig),
      paths.tokenPath,
    );
    const next = modifyProvider(target.text, persistentBlock);
    const changed = next !== target.text || !existsSync(paths.tokenPath)
      || (() => {
        try { return readProtectedStateFile(paths.tokenPath, MAX_JOURNAL_BYTES) !== token; }
        catch { return true; }
      })();
    const currentManagedProvider = providerValue(parsedTarget);
    const currentManagedProviderHash = currentManagedProvider === undefined
      ? null
      : sha256(JSON.stringify(currentManagedProvider));
    const unchangedSinceLastApply = existingJournal === null
      || (sha256(target.text) === existingJournal.afterHash
        && currentManagedProviderHash === existingJournal.managedProviderHash);
    journal = {
      ...journal,
      afterHash: sha256(next),
      managedProviderHash: sha256(JSON.stringify(persistentBlock)),
      appliedAt: new Date().toISOString(),
      autoConnect: options.autoConnect ?? journal.autoConnect,
      exactRestoreEligible: journal.exactRestoreEligible && unchangedSinceLastApply,
    };
    // Journal the recoverable intent before touching the external config. A
    // crash or write failure therefore leaves a valid backup + restore path,
    // never an unjournaled mutation in another application's directory.
    writeJournal(paths, journal);
    writeProtected(paths.tokenPath, token);
    const preCommit = targetSnapshot(targetPath);
    if (sha256(preCommit.text) !== sha256(target.text) || preCommit.existed !== target.existed) {
      throw new Error("OpenCode config changed while the integration was being applied; retry after reviewing it");
    }
    if (next !== target.text) atomicWriteExternal(targetPath, next, target.mode || 0o600);
    return { status: inspectOpencodeIntegration(paths), changed };
  });
}

export function setOpencodeAutoConnect(
  enabled: boolean,
  paths: OpencodeIntegrationPaths = opencodeIntegrationPaths(),
): OpencodeIntegrationStatus {
  return withConfigMutationLockSync(() => {
    const journal = readJournal(paths);
    if (!journal) throw new Error("Apply the OpenCode integration before enabling automatic connection");
    writeJournal(paths, { ...journal, autoConnect: enabled });
    return inspectOpencodeIntegration(paths);
  });
}

export function restoreOpencodeIntegration(
  options: RestoreOpencodeIntegrationOptions & { paths?: OpencodeIntegrationPaths } = {},
): RestoreOpencodeIntegrationResult {
  const paths = options.paths ?? opencodeIntegrationPaths();
  return withConfigMutationLockSync(() => {
    const journal = readJournal(paths);
    if (!journal) {
      return {
        restored: false,
        exact: false,
        preservedUserEdits: true,
        status: inspectOpencodeIntegration(paths),
      };
    }
    const backup = readProtectedStateFile(journal.backupPath, MAX_CONFIG_BYTES);
    if (sha256(backup) !== journal.beforeHash) throw new Error("OpenCode integration backup integrity check failed");
    const current = targetSnapshot(journal.targetPath);
    const currentHash = sha256(current.text);
    const unchanged = currentHash === journal.afterHash;
    const alreadyAtOriginal = currentHash === journal.beforeHash
      && current.existed === journal.targetExisted;
    const exactSafe = alreadyAtOriginal || (unchanged && journal.exactRestoreEligible);
    const full = options.mode === "full";
    if (full && !exactSafe && options.confirmCurrentHash !== currentHash) {
      throw new Error(`Full restore requires confirmation of the current config hash: ${currentHash}`);
    }

    const exact = exactSafe || full;
    const preservedUserEdits = !exact;
    const preCommit = targetSnapshot(journal.targetPath);
    if (sha256(preCommit.text) !== currentHash || preCommit.existed !== current.existed) {
      throw new Error("OpenCode config changed while the integration was being restored; retry after reviewing it");
    }
    if (exact) {
      if (journal.targetExisted) atomicWriteExternal(journal.targetPath, backup, current.mode || 0o600);
      else removeRegularFile(journal.targetPath);
    } else {
      parseJsoncObject(current.text, journal.targetPath);
      const backupParsed = parseJsoncObject(backup, journal.backupPath);
      const previousProvider = providerValue(backupParsed);
      let next = modifyProvider(current.text, previousProvider);
      if (previousProvider === undefined && backupParsed.provider === undefined) {
        const afterProviderRemoval = parseJsoncObject(next, journal.targetPath);
        if (isRecord(afterProviderRemoval.provider)
          && Object.keys(afterProviderRemoval.provider).length === 0) {
          next = modifyJsoncPath(next, ["provider"], undefined);
        }
      }
      atomicWriteExternal(journal.targetPath, next, current.mode || 0o600);
    }

    removeRegularFile(paths.tokenPath);
    removeRegularFile(paths.journalPath);
    // The backup is no longer needed after a successful exact or surgical restore.
    removeRegularFile(journal.backupPath);
    return {
      restored: true,
      exact,
      preservedUserEdits,
      status: inspectOpencodeIntegration(paths),
    };
  });
}

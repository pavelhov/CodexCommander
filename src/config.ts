import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import * as z from "zod/v4";
import {
  bumpConfigGenerationAtPath,
  bumpCurrentConfigGeneration,
  initializeConfigGeneration,
  observeConfigGenerationAtPath,
  readConfigGenerationAtPath,
  readConfigGenerationInTransaction,
  type ConfigGenerationObservation,
} from "./codex/generation";
import type {
  BumpConfigGeneration,
  ConfigGeneration,
  ReadConfigGeneration,
  WithExpectedConfigGenerationSync,
} from "./codex/convergence-types";
import {
  CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
  codexAccountNamespaceForModel,
  codexProviderNamespaceKey,
  isValidCodexAccountNamespaceTarget,
  MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET,
} from "./codex/account-namespace-match";
import { isCodexAccountPriorityKey } from "./codex/account-priority";
import { CODEX_ACCOUNT_LOG_LABEL_RE } from "./codex/account-label";
import { parseAccountPriority } from "./codex/pool-rotation";
import { COMBO_NAMESPACE, comboConfigIssues } from "./combos/types";
import { HOME_ENV, STATE_DIR_NAME, readEnv } from "./identity";
import { routingProfileIssues } from "./routing/profile";
import {
  forgetEphemeralSecretPath,
  hardenSecretDir,
  hardenSecretPath,
  hardenSecretPathAsync,
  windowsSecretAclApplies,
} from "./lib/windows-secret-acl";
import {
  inspectPhysicalConfigRoot,
  recordOwnedConfigPath,
} from "./lib/config-ownership";
import { assertNotRealHomeUnderTest } from "./lib/test-home-guard";
import { isLocalAttestationSecret } from "./lib/local-management-attestation";
import { providerDestinationConfigError } from "./lib/destination-policy";
import { redactSecretString } from "./lib/redact";
import { openRouterRoutingConfigError } from "./providers/openrouter-routing";
import {
  isWirePinnedModel,
  MODEL_ADAPTER_OVERRIDE_ALLOWED,
  pinnedWireAdapter,
  REASONING_CONTENT_MODE_VALUES,
  REASONING_SUMMARY_DELIVERY_VALUES,
  type CodexCommanderConfig,
  type CodexCommanderProviderConfig,
} from "./types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "./providers/openai-tiers";
import {
  getProviderRegistryEntry,
  providerMatchesRegistryTransport,
  providerModelWireDefault,
} from "./providers/registry";
import { resolveOpenAiVirtualModel } from "./providers/openai-virtual-models";
import { parseDesktopProfile } from "./claude/desktop-profile";
import { isCodexReasoningEffort, modelRecordValue } from "./reasoning-effort";
import {
  DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES,
  MAX_APP_OWNED_MEMORY_BUDGET_MB,
  MIN_APP_OWNED_MEMORY_BUDGET_MB,
} from "./lib/app-owned-memory";
import { isHostedToolUnsupportedForModel } from "./responses/hosted-tool-policy";
import { normalizeSubagentRoster } from "./codex/subagent-roster";

let _atomicSeq = 0;

interface AtomicRenameIO {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => void;
  sleep: (milliseconds: number) => void;
}

export function renameAtomicFile(
  source: string,
  destination: string,
  io: AtomicRenameIO = {
    platform: process.platform,
    rename: renameSync,
    sleep: Bun.sleepSync,
  },
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = io.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      if (!transientWindowsError || attempt >= 2) throw error;
      io.sleep(25 * (attempt + 1));
    }
  }
}

/**
 * Write a file atomically (temp + rename) so concurrent writers — e.g. `ccx stop` and the
 * proxy's own shutdown handler both restoring Codex — can never leave a half-written file.
 */
export interface AtomicWriteIO {
  write: (path: string, content: string) => void;
  harden: (path: string) => void;
  rename: (source: string, destination: string) => void;
  truncate: (path: string) => void;
  unlink: (path: string) => void;
}

export class AtomicWriteResidualTempError extends Error {
  constructor(readonly tempPath: string, readonly hardened = true, options?: ErrorOptions) {
    super(`Atomic config write left a ${hardened ? "hardened " : ""}zero-byte temporary file`, options);
    this.name = "AtomicWriteResidualTempError";
  }
}

export class AtomicWriteSecretResidualError extends Error {
  constructor(readonly tempPath: string, options?: ErrorOptions) {
    super("Atomic config write could not scrub or remove a secret-bearing temporary file", options);
    this.name = "AtomicWriteSecretResidualError";
  }
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Resolve a write target through any symlink before the temp+rename dance.
 *
 * rename(2) replaces a directory ENTRY. When the entry is itself a symlink
 * (a dotfiles-managed `~/.codex/config.toml` -> `~/dotfiles/.codex/config.toml`,
 * say), renaming a sibling temp file over it destroys the link and leaves a plain
 * file behind — the repo silently stops receiving writes. Resolving first puts both
 * the temp file and the rename target inside the link's real directory, so the entry
 * being replaced is the real file and the symlink survives.
 *
 * Same-filesystem atomicity is preserved because the temp file stays beside its
 * resolved target. A genuinely absent destination (not yet created) falls back to
 * the literal path, which is the correct target for a first write.
 *
 * An EXISTING symlink that cannot be resolved — dangling because its target volume
 * is unmounted, an ELOOP chain, an EACCES parent — is refused instead. Falling back
 * to the literal path there would let the rename replace the link, recreating the
 * exact dotfiles-divergence failure this helper exists to prevent (audit: wt4 wp2).
 */
export function resolveWriteTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (cause) {
    let entry;
    try {
      entry = lstatSync(path);
    } catch (error) {
      if (isMissingPathError(error)) return path; // no entry at all — first write
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing to replace unresolvable symlinked write target: ${path}`, { cause });
    }
    return path;
  }
}

/**
 * Re-apply the real-home guard to a RESOLVED write target.
 *
 * Callers such as saveConfig check only their logical config dir, which passes when
 * CODEXCOMMANDER_HOME points at a temp fixture. Following a symlink out of that fixture
 * would land on the protected home the caller's own check just cleared, so the guard
 * has to run again on wherever the write actually terminates. Inert in production,
 * where the guard is disarmed.
 */
function assertResolvedTargetAllowed(path: string, target: string): void {
  // The file itself may resolve literally while its PARENT is a symlink out
  // of the fixture (a first write beneath a symlinked config dir). Guard the
  // directory the write actually lands in either way.
  if (target === path) {
    let realParent: string;
    try {
      realParent = realpathSync(dirname(target));
    } catch {
      return; // unresolvable parent: resolveWriteTarget already owns that refusal
    }
    if (realParent !== dirname(target)) assertNotRealHomeUnderTest(realParent);
    return;
  }
  assertNotRealHomeUnderTest(dirname(target));
}

export function atomicWriteFile(path: string, content: string, io: AtomicWriteIO = {
  write: (target, value) => writeFileSync(target, value, { encoding: "utf-8", mode: 0o600 }),
  harden: target => {
    try { chmodSync(target, 0o600); } catch { /* platform may ignore chmod */ }
    // Timeout memo keyed by the stable destination (matches the async writer):
    // a failed temp harden must not mint a new unique-temp key on every write.
    if (process.platform === "win32") hardenSecretPath(target, { required: true, timeoutMemoKey: path });
  },
  rename: renameAtomicFile,
  truncate: target => truncateSync(target, 0),
  unlink: unlinkSync,
}): void {
  recordOwnedConfigPath(resolveConfigDir(), path);
  const target = resolveWriteTarget(path);
  assertResolvedTargetAllowed(path, target);
  const tmp = `${target}.ccx.${process.pid}.${++_atomicSeq}.tmp`;
  let hardened = false;
  try {
    io.write(tmp, content);
    io.harden(tmp);
    hardened = true;
    io.rename(tmp, target);
    forgetEphemeralSecretPath(tmp);
  } catch (cause) {
    let scrubbed = false;
    try {
      io.truncate(tmp);
      scrubbed = true;
    } catch (error) {
      if (isMissingPathError(error)) scrubbed = true;
      else {
        try { io.write(tmp, ""); scrubbed = true; } catch { /* removal may still succeed */ }
      }
    }
    let removed = false;
    try {
      io.unlink(tmp);
      removed = true;
    } catch (error) {
      if (isMissingPathError(error)) removed = true;
      else {
        try { io.unlink(tmp); removed = true; }
        catch (retryError) { if (isMissingPathError(retryError)) removed = true; }
      }
    }
    if (!removed && !scrubbed) throw new AtomicWriteSecretResidualError(tmp, { cause });
    if (!removed && !hardened) {
      try { io.harden(tmp); hardened = true; } catch { /* zero-byte residual is reported honestly */ }
    }
    if (removed) forgetEphemeralSecretPath(tmp);
    if (!removed) throw new AtomicWriteResidualTempError(tmp, hardened, { cause });
    throw cause;
  }
}

/** Async atomic-write I/O: harden may await icacls without blocking the event loop (#612). */
export interface AtomicWriteAsyncIO {
  write: (path: string, content: string) => void | Promise<void>;
  harden: (path: string) => void | Promise<void>;
  rename: (source: string, destination: string) => void | Promise<void>;
  truncate: (path: string) => void | Promise<void>;
  unlink: (path: string) => void | Promise<void>;
}

/** Test-only crash seam. Production callers leave this undefined. */
export interface AtomicWriteAsyncTestSeam {
  afterTempWrite?: (tempPath: string) => void | Promise<void>;
}

async function renameAtomicFileAsync(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = process.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      if (!transientWindowsError || attempt >= 2) throw error;
      await Bun.sleep(25 * (attempt + 1));
    }
  }
}

/**
 * Async atomic write (#612): same temp+harden+rename and residual-temp policy as
 * atomicWriteFile, but Windows ACL harden yields the event loop. Timeout memo is keyed
 * by the final destination path (not the unique temp, not the parent directory).
 */
export async function atomicWriteFileAsync(
  path: string,
  content: string,
  io?: AtomicWriteAsyncIO,
  testSeam?: AtomicWriteAsyncTestSeam,
): Promise<void> {
  const effective: AtomicWriteAsyncIO = io ?? {
    write: (target, value) => writeFileSync(target, value, { encoding: "utf-8", mode: 0o600 }),
    harden: async target => {
      try { chmodSync(target, 0o600); } catch { /* platform may ignore chmod */ }
      if (process.platform === "win32") {
        await hardenSecretPathAsync(target, { required: true, timeoutMemoKey: path });
      }
    },
    rename: renameAtomicFileAsync,
    truncate: target => truncateSync(target, 0),
    unlink: unlinkSync,
  };
  const target = resolveWriteTarget(path);
  assertResolvedTargetAllowed(path, target);
  const tmp = `${target}.ccx.${process.pid}.${++_atomicSeq}.tmp`;
  let hardened = false;
  try {
    await effective.write(tmp, content);
    await testSeam?.afterTempWrite?.(tmp);
    await effective.harden(tmp);
    hardened = true;
    await effective.rename(tmp, target);
    forgetEphemeralSecretPath(tmp);
  } catch (cause) {
    let scrubbed = false;
    try {
      await effective.truncate(tmp);
      scrubbed = true;
    } catch (error) {
      if (isMissingPathError(error)) scrubbed = true;
      else {
        try { await effective.write(tmp, ""); scrubbed = true; } catch { /* removal may still succeed */ }
      }
    }
    let removed = false;
    try {
      await effective.unlink(tmp);
      removed = true;
    } catch (error) {
      if (isMissingPathError(error)) removed = true;
      else {
        try { await effective.unlink(tmp); removed = true; }
        catch (retryError) { if (isMissingPathError(retryError)) removed = true; }
      }
    }
    if (!removed && !scrubbed) throw new AtomicWriteSecretResidualError(tmp, { cause });
    if (!removed && !hardened) {
      try { await effective.harden(tmp); hardened = true; } catch { /* zero-byte residual is reported honestly */ }
    }
    if (removed) forgetEphemeralSecretPath(tmp);
    if (!removed) throw new AtomicWriteResidualTempError(tmp, hardened, { cause });
    throw cause;
  }
}

/**
 * Expand a leading `~` to the home directory in user-supplied paths
 * (CODEXCOMMANDER_HOME/CODEX_HOME set from GUIs/service files where
 * no shell expanded it).
 * `~user` and `%VAR%`/`$VAR` forms pass through untouched — those belong to the shell.
 */
export function expandUserPath(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

let resolvedConfigDirCache: { raw: string | undefined; path: string } | null = null;

function resolveConfigDir(): string {
  const raw = readEnv(HOME_ENV) || undefined;
  if (resolvedConfigDirCache && resolvedConfigDirCache.raw === raw) return resolvedConfigDirCache.path;
  const path = raw
    ? resolve(expandUserPath(raw))
    : join(homedir(), STATE_DIR_NAME);
  resolvedConfigDirCache = { raw, path };
  return path;
}

function resolveConfigPath(): string {
  return join(resolveConfigDir(), "config.json");
}

function resolvePidPath(): string {
  return join(resolveConfigDir(), "codexcommander.pid");
}

function resolveRuntimePortPath(): string {
  return join(resolveConfigDir(), "runtime-port.json");
}

let lastWarningReconciledGeneration = 0;

export function reconcileConfigWarningMemos(generation: number): number {
  if (generation <= lastWarningReconciledGeneration) return 0;
  lastWarningReconciledGeneration = generation;
  return 0;
}

/**
 * Bounds for the opt-in same-target 429 wait-and-retry policy. Single source of truth
 * shared by the config schema and the management write boundary. Unknown keys and
 * malformed values are rejected at every current-schema boundary.
 */
const retryOn429PolicySchema = z.object({
  enabled: z.boolean().optional(),
  attempts: z.number().int().min(1).max(20).optional(),
  intervalMs: z.number().int().min(100).max(600_000).optional(),
  // The effective cap for a single wait is MAX_COOLDOWN_MS (10 min) in key-failover.ts;
  // larger configured values would be dead config.
  maxIntervalMs: z.number().int().min(100).max(600_000).optional(),
  respectRetryAfter: z.boolean().optional(),
}).strict();

const stringArraySchema = z.array(z.string());
const subagentRosterSchema = z.array(z.unknown()).transform((value, ctx) => {
  try {
    return normalizeSubagentRoster(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid subagent roster",
    });
    return z.NEVER;
  }
});
const stringRecordSchema = z.record(z.string(), z.string());
const numberRecordSchema = z.record(z.string(), z.number());
const booleanRecordSchema = z.record(z.string(), z.boolean());
const stringArrayRecordSchema = z.record(z.string(), stringArraySchema);
const codexReasoningEffortSchema = z.string().refine(isCodexReasoningEffort, {
  error: "must be a supported Codex reasoning effort",
});

const openRouterRoutingSchema = z.object({
  order: stringArraySchema.optional(),
  only: stringArraySchema.optional(),
  allowFallbacks: z.boolean().optional(),
}).strict();

const apiKeyPoolEntrySchema = z.object({
  id: z.string().min(1),
  key: z.string().refine(isUsableApiKeySecret),
  label: z.string().optional(),
  addedAt: z.number().finite().optional(),
}).strict();

const cursorMcpServerSchema = z.object({
  command: z.string().optional(),
  args: stringArraySchema.optional(),
  env: stringRecordSchema.optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: stringRecordSchema.optional(),
  enabled: z.boolean().optional(),
  toolPrefix: z.string().optional(),
}).strict();

const desktopExecutorSchema = z.object({
  computerUseCommand: z.string().optional(),
  recordScreenCommand: z.string().optional(),
  cwd: z.string().optional(),
  env: stringRecordSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();

const responsesItemIdRepairSchema = z.object({
  message: stringArraySchema.optional(),
  reasoning: stringArraySchema.optional(),
  repairMissingTerminalIds: z.boolean().optional(),
  repairInvalidIds: z.boolean().optional(),
}).strict();

/** Every declared provider field is validated; removed and unknown fields are rejected. */
const providerConfigSchema = z.object({
  adapter: z.string().min(1),
  modelAdapters: stringRecordSchema.optional(),
  baseUrl: z.string().min(1),
  commandCodeVersion: z.string().optional(),
  mcpMaxTools: z.number().int().positive().optional(),
  mcpMaxSchemaBytes: z.number().int().positive().optional(),
  mcpMaxResultBytes: z.number().int().positive().optional(),
  apiKey: z.string().optional(),
  apiKeyPool: z.array(apiKeyPoolEntrySchema).optional(),
  apiKeyTransport: z.enum(["x-api-key", "bearer"]).optional(),
  responsesPath: z.string().min(1).optional(),
  defaultModel: z.string().optional(),
  models: stringArraySchema.optional(),
  liveModels: z.boolean().optional(),
  selectedModels: stringArraySchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  modelContextWindows: numberRecordSchema.optional(),
  modelInputModalities: stringArrayRecordSchema.optional(),
  modelMaxInputTokens: numberRecordSchema.optional(),
  defaultMaxOutputTokens: z.number().int().positive().optional(),
  modelMaxOutputTokens: numberRecordSchema.optional(),
  reasoningContentMode: z.enum(REASONING_CONTENT_MODE_VALUES).optional(),
  reasoningEfforts: stringArraySchema.optional(),
  modelReasoningEfforts: stringArrayRecordSchema.optional(),
  modelDefaultReasoningEfforts: stringRecordSchema.optional(),
  modelSupportsReasoningSummaries: booleanRecordSchema.optional(),
  modelReasoningSummaryDelivery: z.record(z.string(), z.enum(REASONING_SUMMARY_DELIVERY_VALUES)).optional(),
  modelPreferHostedTools: stringArrayRecordSchema.optional(),
  reasoningEffortMap: stringRecordSchema.optional(),
  modelReasoningEffortMap: z.record(z.string(), stringRecordSchema).optional(),
  reasoningWireFormat: z.literal("gateway-object").optional(),
  chatCompletionTokenField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  headers: stringRecordSchema.optional(),
  openRouterRouting: openRouterRoutingSchema.optional(),
  modelOpenRouterRouting: z.record(z.string(), openRouterRoutingSchema).optional(),
  authMode: z.enum(["key", "forward", "oauth", "local"]).optional(),
  keyOptional: z.boolean().optional(),
  freeTier: z.boolean().optional(),
  note: z.string().optional(),
  modelSuffixBracketStrip: z.boolean().optional(),
  refreshPolicy: z.enum(["proactive", "lazy-only", "disabled"]).optional(),
  statelessResponses: z.boolean().optional(),
  supportsServiceTier: z.boolean().optional(),
  preserveResponsesReasoningContent: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  disabled: z.boolean().optional(),
  retryOn429: retryOn429PolicySchema.optional(),
  codexAccountMode: z.enum(["pool", "direct"]).optional(),
  responsesItemIdRepair: responsesItemIdRepairSchema.optional(),
  responsesSnapshotRepair: z.boolean().optional(),
  noReasoningModels: stringArraySchema.optional(),
  noTemperatureModels: stringArraySchema.optional(),
  noTopPModels: stringArraySchema.optional(),
  noPenaltyModels: stringArraySchema.optional(),
  parallelToolCalls: z.boolean().optional(),
  promptCacheKey: z.boolean().optional(),
  autoToolChoiceOnlyModels: stringArraySchema.optional(),
  preserveReasoningContentModels: stringArraySchema.optional(),
  reasoningSplitModels: stringArraySchema.optional(),
  thinkingToggleModels: stringArraySchema.optional(),
  thinkingBudgetModels: stringArraySchema.optional(),
  escapeBuiltinToolNames: z.boolean().optional(),
  anthropicEofTolerance: z.boolean().optional(),
  noVisionModels: stringArraySchema.optional(),
  googleMode: z.enum(["ai-studio", "vertex", "cloud-code-assist"]).optional(),
  project: z.string().optional(),
  location: z.string().optional(),
  mcpServers: z.record(z.string(), cursorMcpServerSchema).optional(),
  desktopExecutor: desktopExecutorSchema.optional(),
  nativeLocalExec: z.enum(["off", "on"]).optional(),
}).strict();

const RESERVED_PROVIDER_NAMES = new Set([
  // JavaScript prototype-pollution guards.
  "__proto__",
  "prototype",
  "constructor",
  // System-reserved routing namespace (resolved before provider/account
  // namespaces in routeModelInternal). "combo" is intentionally NOT reserved:
  // a physical provider named `combo` is a supported pattern (combo aliases
  // hosted on the combo provider), and the combo selector only wins when an
  // actual combo id matches.
  "policy",
]);
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SENSITIVE_PROVIDER_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-amz-security-token",
]);

export function isValidProviderName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === name
    && PROVIDER_NAME_PATTERN.test(name)
    && !RESERVED_PROVIDER_NAMES.has(name.toLowerCase());
}

export function hasOwnProvider(providers: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(providers, name);
}

export function providerBaseUrlConfigError(baseUrl: string): string | null {
  if (baseUrl !== baseUrl.trim()) return "baseUrl must not have surrounding whitespace";
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "baseUrl must be an http(s) URL";
    if (parsed.username || parsed.password) return "baseUrl must not include embedded credentials";
    if (parsed.search || parsed.hash) return "baseUrl must not include query strings or fragments";
  } catch {
    return "baseUrl must be a valid URL";
  }
  return null;
}

function providerResponsesPathConfigError(responsesPath: string | undefined): string | null {
  if (responsesPath === undefined) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(responsesPath) || responsesPath.includes("://")) {
    return "responsesPath must be a relative path without a URL scheme";
  }
  if (!responsesPath.startsWith("/")) return "responsesPath must start with /";
  if (responsesPath.includes("?") || responsesPath.includes("#")) {
    return "responsesPath must not include query strings or fragments";
  }
  return null;
}

export function providerHeadersConfigError(headers: unknown): string | null {
  if (headers === undefined) return null;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "headers must be an object";
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || !HEADER_NAME_PATTERN.test(name)) return "headers must use valid HTTP header names";
    if (SENSITIVE_PROVIDER_HEADERS.has(normalized)) return `headers must not include sensitive header "${name}"; use apiKey/authMode instead`;
    if (typeof value !== "string") return `header "${name}" value must be a string`;
    if (/[\r\n]/.test(value)) return `header "${name}" value must not include line breaks`;
  }
  return null;
}

/** Keep the configured API-key header style scoped to Anthropic-compatible key auth. */
export function apiKeyTransportConfigError(
  provider: Pick<CodexCommanderProviderConfig, "adapter" | "authMode" | "apiKeyTransport">,
): string | null {
  if (provider.apiKeyTransport === undefined) return null;
  if (provider.apiKeyTransport !== "x-api-key" && provider.apiKeyTransport !== "bearer") {
    return 'apiKeyTransport must be "x-api-key" or "bearer"';
  }
  if (provider.adapter !== "anthropic") {
    return "apiKeyTransport is supported only by the anthropic adapter";
  }
  if (provider.authMode === "oauth" || provider.authMode === "forward" || provider.authMode === "local") {
    return "apiKeyTransport requires Anthropic API-key authentication";
  }
  return null;
}

export function positiveIntegerRecordConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "number" || !Number.isFinite(entry) || !Number.isInteger(entry) || entry <= 0) {
      return `${field}.${key} must be a positive finite integer`;
    }
  }
  return null;
}

export function positiveIntegerConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return `${field} must be a positive finite integer`;
  }
  return null;
}

export function booleanRecordConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "boolean") return `${field}.${key} must be a boolean`;
  }
  return null;
}

const REASONING_SUMMARY_DELIVERY_SET = new Set<string>(REASONING_SUMMARY_DELIVERY_VALUES);
const REASONING_CONTENT_MODE_SET = new Set<string>(REASONING_CONTENT_MODE_VALUES);

export function reasoningContentModeConfigError(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !REASONING_CONTENT_MODE_SET.has(value)) {
    return `reasoningContentMode must be one of: ${REASONING_CONTENT_MODE_VALUES.join(", ")}`;
  }
  return null;
}

export function reasoningSummaryDeliveryRecordConfigError(
  value: unknown,
  supportsReasoningSummaries: unknown,
  field = "modelReasoningSummaryDelivery",
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;

  const supports = booleanRecordConfigError(supportsReasoningSummaries, "modelSupportsReasoningSummaries") === null
    && supportsReasoningSummaries && typeof supportsReasoningSummaries === "object"
    ? supportsReasoningSummaries as Record<string, boolean>
    : undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "string" || !REASONING_SUMMARY_DELIVERY_SET.has(entry)) {
      return `${field}.${key} must be one of: ${REASONING_SUMMARY_DELIVERY_VALUES.join(", ")}`;
    }
    if (modelRecordValue(supports, key) === false) {
      return `${field}.${key} conflicts with modelSupportsReasoningSummaries=false`;
    }
  }
  return null;
}

const SUPPORTED_PREFERRED_HOSTED_TOOLS = new Set(["image_generation"]);

export function modelPreferHostedToolsConfigError(
  value: unknown,
  field: string,
  providerName: string,
  provider: { adapter?: unknown; authMode?: unknown; modelAdapters?: unknown; baseUrl?: unknown },
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  const entries = Object.entries(value);
  const registry = getProviderRegistryEntry(providerName);
  // Effective transport: a `preserveCustomDestination` registry row reused under a
  // different endpoint keeps its own adapter AND its own auth at runtime, because
  // `routedProviderConfig()` honors `providerMatchesRegistryTransport()`. Both the
  // wire check below and the forward-auth check here have to start from the same
  // decision, or validation accepts a preference the adapter never applies —
  // `preferConfiguredHostedTools()` runs only on the non-forward branch.
  const registryTransportMatches = typeof provider.baseUrl === "string"
    && providerMatchesRegistryTransport(providerName, {
      baseUrl: provider.baseUrl,
      adapter: provider.adapter as CodexCommanderProviderConfig["adapter"],
      ...(typeof provider.authMode === "string" ? { authMode: provider.authMode as CodexCommanderProviderConfig["authMode"] } : {}),
    });
  const effectiveForwardAuth = registryTransportMatches
    ? registry?.authKind === "forward"
    : provider.authMode === "forward";
  if (entries.length > 0 && effectiveForwardAuth) {
    return `${field} is not supported on forward-auth Responses providers`;
  }
  const requestedWireFor = (modelId: string): unknown => provider.modelAdapters
    && typeof provider.modelAdapters === "object"
    && !Array.isArray(provider.modelAdapters)
    ? (provider.modelAdapters as Record<string, unknown>)[modelId]
    : undefined;
  const resolveEffectiveWire = (modelId: string, currentWire: unknown): unknown => {
    const pinned = pinnedWireAdapter(providerName, modelId);
    if (pinned) return pinned;
    const requestedWire = requestedWireFor(modelId);
    if (typeof requestedWire === "string" && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(requestedWire)) {
      return requestedWire;
    }
    // No explicit override: fall back to the registry's per-model wire default before
    // the provider-wide adapter, because that is the order `resolveModelAdapter()`
    // uses at request time (src/server/adapter-resolve.ts:38-48). Skipping it rejected
    // preferences the runtime would have honored — DeepSeek routes `deepseek-v4-flash`
    // over native Responses for a Responses inbound while the provider-wide wire stays
    // openai-chat. Hosted-tool preferences only apply to Responses traffic, so the
    // inbound to ask about is "responses".
    const registryDefault = typeof currentWire === "string" && typeof provider.baseUrl === "string"
      ? providerModelWireDefault(
        providerName,
        {
          baseUrl: provider.baseUrl,
          adapter: currentWire,
          ...(typeof provider.authMode === "string" ? { authMode: provider.authMode as CodexCommanderProviderConfig["authMode"] } : {}),
        },
        modelId,
        MODEL_ADAPTER_OVERRIDE_ALLOWED,
        "responses",
      )
      : undefined;
    return registryDefault ?? currentWire;
  };
  for (const [key, entry] of entries) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (!Array.isArray(entry)) return `${field}.${key} must be an array`;
    if (entry.length === 0) return `${field}.${key} must include image_generation`;
    for (const tool of entry) {
      if (typeof tool !== "string" || !SUPPORTED_PREFERRED_HOSTED_TOOLS.has(tool)) {
        return `${field}.${key} supports only image_generation`;
      }
      if (isHostedToolUnsupportedForModel(key, tool)) {
        return `${field}.${key} cannot prefer ${tool}: the model does not support it`;
      }
    }
    // Same `registryTransportMatches` decision the forward-auth check above uses:
    // start from the registry adapter only when this config still points at the
    // registry's documented transport.
    const baseWire = registryTransportMatches ? registry?.adapter ?? provider.adapter : provider.adapter;
    let effectiveWire = resolveEffectiveWire(key, baseWire);
    const virtualWireModel = resolveOpenAiVirtualModel(providerName, key)?.wireModelId;
    if (virtualWireModel && virtualWireModel !== key) {
      effectiveWire = resolveEffectiveWire(virtualWireModel, effectiveWire);
    }
    if (effectiveWire !== "openai-responses") {
      return `${field}.${key} requires the openai-responses wire`;
    }
  }
  return null;
}

/**
 * Validate a provider's per-model wire override map (#404).
 *
 * Rejects, rather than silently ignoring, configurations the resolver would refuse:
 * a value outside the allowed wires, a model the upstream pins to one wire, and any
 * override on a canonical forward provider (where switching wires would drop the
 * caller's forwarded credential). Silently dropping them would leave the user
 * believing an override is in effect.
 */
export function modelAdapterRecordConfigError(
  value: unknown,
  field: string,
  providerName: string,
  provider: { adapter?: unknown; authMode?: unknown; baseUrl?: unknown },
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  const entries = Object.entries(value);
  if (entries.length > 0 && isCanonicalOpenAiForwardProvider(provider as CodexCommanderProviderConfig)) {
    return `${field} is not supported on the canonical ChatGPT forward provider`;
  }
  for (const [key, entry] of entries) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "string" || !MODEL_ADAPTER_OVERRIDE_ALLOWED.has(entry)) {
      return `${field}.${key} must be one of: ${[...MODEL_ADAPTER_OVERRIDE_ALLOWED].join(", ")}`;
    }
    if (isWirePinnedModel(providerName, key.trim())) {
      return `${field}.${key} cannot be overridden: the upstream only speaks one wire for this model`;
    }
  }
  return null;
}

const CODEX_ACCOUNT_NAMESPACES_RECORD_ERROR =
  "codexAccountNamespaces must be a plain object mapping account selectors to Codex account ids";
const CODEX_ACCOUNT_NAMESPACE_KEY_ERROR =
  "account selectors must use 1-64 letters, numbers, dots, underscores, or hyphens and cannot be reserved JavaScript object keys";
const CODEX_ACCOUNT_NAMESPACE_TARGET_ERROR =
  "account selector targets must be @main or valid Codex pool-account ids";
const CODEX_ACCOUNT_NAMESPACE_ACCOUNT_ID_COLLISION_ERROR =
  "account selectors must not collide with configured Codex pool-account ids or account selector targets";

function configuredCodexPoolAccountIds(value: unknown): Set<string> {
  const accountIds = new Set<string>();
  if (!Array.isArray(value)) return accountIds;
  for (const account of value) {
    if (!account || typeof account !== "object" || Array.isArray(account)) continue;
    const { id, isMain } = account as { id?: unknown; isMain?: unknown };
    if (typeof id === "string" && isMain !== true) accountIds.add(id);
  }
  return accountIds;
}

const codexAccountNamespacesSchema = z.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  { error: CODEX_ACCOUNT_NAMESPACES_RECORD_ERROR },
).superRefine((accountNamespaces, ctx) => {
  // Inspect raw own entries before z.record parses them; Zod omits __proto__ record keys.
  for (const [namespace, accountId] of Object.entries(accountNamespaces)) {
    if (!isValidProviderName(namespace)) {
      ctx.addIssue({
        code: "custom",
        path: [namespace],
        message: CODEX_ACCOUNT_NAMESPACE_KEY_ERROR,
      });
    }
    if (!isValidCodexAccountNamespaceTarget(accountId)) {
      ctx.addIssue({
        code: "custom",
        path: [namespace],
        message: CODEX_ACCOUNT_NAMESPACE_TARGET_ERROR,
      });
    }
  }
}).pipe(z.record(z.string(), z.string()));

const CODEX_ACCOUNT_PRIORITIES_RECORD_ERROR =
  "codexAccountPriorities must be a plain object mapping Codex account ids to selection-order integers";
const CODEX_ACCOUNT_PRIORITY_KEY_ERROR =
  "selection-order keys must be a Codex pool-account id or the main Codex account and cannot be reserved JavaScript object keys";
const CODEX_ACCOUNT_PRIORITY_VALUE_ERROR =
  "selection order must be an integer between -100 and 100";

const CODEX_ACCOUNT_PIN_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

const codexAccountPrioritiesSchema = z.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  { error: CODEX_ACCOUNT_PRIORITIES_RECORD_ERROR },
).superRefine((priorities, ctx) => {
  // Inspect raw own entries before z.record parses them; Zod omits __proto__ record keys.
  for (const [accountId, priority] of Object.entries(priorities)) {
    if (!isCodexAccountPriorityKey(accountId)) {
      ctx.addIssue({ code: "custom", path: [accountId], message: CODEX_ACCOUNT_PRIORITY_KEY_ERROR });
    }
    if (parseAccountPriority(priority) === null) {
      ctx.addIssue({ code: "custom", path: [accountId], message: CODEX_ACCOUNT_PRIORITY_VALUE_ERROR });
    }
  }
}).pipe(z.record(z.string(), z.number().int()));

/** Current persisted API-key row. No field or identity is synthesized. */
const apiKeyEntrySchema = z.object({
  key: z.string().refine(isUsableApiKeySecret),
  id: z.string().min(1).refine(value => value === value.trim()),
  name: z.string()
    .min(1)
    .max(64)
    .refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)),
  createdAt: z.string().datetime(),
}).strict();

const apiKeysSchema = z.array(apiKeyEntrySchema).superRefine((rows, ctx) => {
  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (ids.has(row.id)) {
      ctx.addIssue({
        code: "custom",
        path: [index, "id"],
        message: "duplicate API-key id",
      });
    }
    ids.add(row.id);
  }
});

const claudeSidecarSchema = z.object({
  backend: z.enum(["openai", "anthropic"]).optional(),
  model: z.string().optional(),
}).strict();

const claudeCodeSchema = z.object({
  enabled: z.boolean().optional(),
  nativePassthrough: z.boolean().optional(),
  anthropicBaseUrl: z.string().min(1).optional(),
  bodyStallSec: z.number().finite().nonnegative().optional(),
  bodyMaxBytes: z.number().finite().nonnegative().optional(),
  smallFastModel: z.string().optional(),
  modelMap: stringRecordSchema.optional(),
  systemEnv: z.boolean().optional(),
  authMode: z.enum(["proxy", "subscription"]).optional(),
  autoContext: z.boolean().optional(),
  autoCompactWindow: z.number().int().positive().optional(),
  blockedSkills: stringArraySchema.optional(),
  injectAgents: z.boolean().optional(),
  subagentEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  webSearchSidecar: claudeSidecarSchema.optional(),
  visionSidecar: claudeSidecarSchema.optional(),
  desktopProfile: z.unknown().optional(),
  desktopAutoApply: z.boolean().optional(),
  desktopNativeModels: z.boolean().optional(),
}).strict();

/** Durable per-client intent; only current client keys and boolean values are valid. */
const clientIntegrationsSchema = z.object({
  codex: z.boolean().optional(),
  grok: z.boolean().optional(),
  "claude-desktop": z.boolean().optional(),
}).strict();

const customModelSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  inputModalities: stringArraySchema.optional(),
  addedAt: z.string().datetime().optional(),
}).strict();

const storageCleanupPolicySchema = z.object({
  enabled: z.boolean(),
  trigger: z.object({ archivedBytesOver: z.number().finite().nonnegative() }).strict(),
  target: z.union([
    z.object({ reduceToBytes: z.number().finite().nonnegative() }).strict(),
    z.object({ removeOldestPercent: z.number().finite().min(0).max(100) }).strict(),
  ]),
  schedule: z.enum(["startup", "daily", "weekly", "manual"]),
  mode: z.enum(["quarantine", "permanent"]),
  lastRun: z.object({
    at: z.number().finite(),
    freedBytes: z.number().finite().nonnegative(),
    removed: z.number().int().nonnegative(),
  }).strict().optional(),
  nextRun: z.number().finite().optional(),
}).strict();

const webSearchSidecarSchema = z.object({
  enabled: z.boolean().optional(),
  backend: z.enum(["openai", "anthropic"]).optional(),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  maxSearchesPerTurn: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
  routedModelStallTimeoutMs: z.number().int().min(1).max(2_147_483_647).optional(),
}).strict();

const visionSidecarSchema = z.object({
  enabled: z.boolean().optional(),
  backend: z.enum(["openai", "anthropic"]).optional(),
  model: z.string().optional(),
  maxDescriptionsPerTurn: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();

const imagesSchema = z.object({
  provider: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();

const searchSchema = z.object({ timeoutMs: z.number().int().positive().optional() }).strict();

const codexAccountSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  alias: z.string().optional(),
  plan: z.string().optional(),
  chatgptAccountId: z.string().optional(),
  logLabel: z.string().regex(CODEX_ACCOUNT_LOG_LABEL_RE),
  isMain: z.boolean(),
}).strict();

const anthropicAccountPoolSchema = z.object({
  enabled: z.boolean().optional(),
  autoSwitchThreshold: z.number().int().min(0).max(100).optional(),
  strategy: z.enum(["quota", "round-robin", "fill-first"]).optional(),
  stickyLimit: z.number().int().min(1).max(100).optional(),
}).strict();

const comboSchema = z.object({
  targets: z.array(z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    weight: z.number().int().min(1).max(10_000).optional(),
  }).strict()),
  strategy: z.enum(["failover", "round-robin"]).optional(),
  stickyLimit: z.number().int().min(1).max(100).optional(),
  defaultEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).nullable().optional(),
  alias: z.string().optional(),
  nativeAlias: z.boolean().optional(),
  displayName: z.string().optional(),
}).strict();

const routingProfileSchema = z.object({
  candidates: z.array(z.object({ provider: z.string(), model: z.string() }).strict()),
  alias: z.string().optional(),
  require: z.object({
    minContextWindow: z.number().finite().optional(),
    minQuotaHeadroom: z.number().finite().optional(),
    tools: z.boolean().optional(),
    imageInput: z.boolean().optional(),
    structuredOutput: z.boolean().optional(),
    reasoningEffort: z.string().optional(),
    serviceTier: z.string().optional(),
    localOnly: z.boolean().optional(),
    remoteAllowed: z.boolean().optional(),
    encryptedCodexTasks: z.boolean().optional(),
  }).strict().optional(),
  optimize: z.object({
    latency: z.number().finite().optional(),
    health: z.number().finite().optional(),
    cost: z.number().finite().optional(),
    quota: z.number().finite().optional(),
  }).strict().optional(),
  limits: z.object({ maxEstimatedCostUsd: z.number().finite().optional() }).strict().optional(),
  unknownEvidence: z.object({
    capability: z.enum(["allow", "penalize", "exclude"]).optional(),
    health: z.enum(["allow", "penalize", "exclude"]).optional(),
    quota: z.enum(["allow", "penalize", "exclude"]).optional(),
    cost: z.enum(["allow", "penalize", "exclude"]).optional(),
  }).strict().optional(),
}).strict();

const tokenGuardianSchema = z.object({
  enabled: z.boolean().optional(),
  tickSeconds: z.number().int().positive().optional(),
  jitterSeconds: z.number().int().nonnegative().optional(),
  concurrency: z.number().int().positive().optional(),
  leadSeconds: z.number().int().nonnegative().optional(),
  failureBackoffBaseSeconds: z.number().int().nonnegative().optional(),
  failureBackoffMaxSeconds: z.number().int().nonnegative().optional(),
  codexWarmupEnabled: z.boolean().optional(),
  codexWarmupMaxAgeSeconds: z.number().int().nonnegative().optional(),
  codexWarmupModel: z.string().optional(),
}).strict();

const configSchema = z.object({
  // Required routing identity is never supplied to an existing file. Fresh
  // installs receive it only through getDefaultConfig().
  port: z.number().int().min(0).max(65535),
  // These two fields are optional in CodexCommanderConfig and have documented
  // current runtime defaults, so absence remains valid. Invalid values do not.
  managementUsageMaxReadBytes: z.number().int().positive().default(64 * 1024 * 1024),
  appOwnedMemoryBudgetMb: z.number().int()
    .min(MIN_APP_OWNED_MEMORY_BUDGET_MB)
    .max(MAX_APP_OWNED_MEMORY_BUDGET_MB)
    .default(DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES / (1024 * 1024)),
  hostname: z.string()
    .min(1)
    .refine(value => value === value.trim(), { error: "must not have surrounding whitespace" })
    .optional(),
  providers: z.record(z.string(), providerConfigSchema),
  defaultProvider: z.string().min(1),
  claudeCode: claudeCodeSchema.optional(),
  clientIntegrations: clientIntegrationsSchema.optional(),
  subagentModels: subagentRosterSchema.optional(),
  subagentModelFallback: stringArraySchema.optional(),
  subagentModelFallbackPollMs: z.number().int().nonnegative().optional(),
  providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
  contextCapValue: z.number().int().positive().optional(),
  multiAgentGuidanceEnabled: z.boolean(),
  multiAgentMode: z.enum(["v1", "default", "v2"]).optional(),
  multiAgentV2MessageDelivery: z.enum(["encrypted", "plaintext"]).optional(),
  nativeCatalogMode: z.enum(["bundled-all", "bundled-listed"]).optional(),
  injectionModel: z.string().optional(),
  injectionEffort: codexReasoningEffortSchema.optional(),
  injectionPrompt: z.string().optional(),
  syncCodexSubagentDefaults: z.boolean().optional(),
  effortCap: codexReasoningEffortSchema.optional(),
  subagentEffortCap: codexReasoningEffortSchema.optional(),
  disabledModels: stringArraySchema.optional(),
  customModels: z.array(customModelSchema).optional(),
  shadowCallIntercept: z.object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    sourceModels: stringArraySchema.optional(),
  }).strict().optional(),
  codexShimAutoRestore: z.boolean().optional(),
  codexAutoStart: z.boolean().optional(),
  pausedCodexAccountIds: z.array(z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/)).optional(),
  codexAccountNamespaces: codexAccountNamespacesSchema.optional(),
  codexAccountPriorities: codexAccountPrioritiesSchema.optional(),
  activeCodexAccountPinned: z.string().regex(CODEX_ACCOUNT_PIN_PATTERN).optional(),
  activeCodexAccountId: z.string().optional(),
  codexAccounts: z.array(codexAccountSchema).optional(),
  autoSwitchThreshold: z.number().int().min(0).max(100).optional(),
  accountPoolStrategy: z.enum(["quota", "round-robin", "fill-first"]).optional(),
  accountPoolStickyLimit: z.number().int().min(1).max(100).optional(),
  upstreamFailoverThreshold: z.number().int().nonnegative().optional(),
  anthropicAccountPool: anthropicAccountPoolSchema.optional(),
  combos: z.record(z.string(), comboSchema).optional(),
  routingProfiles: z.record(z.string(), routingProfileSchema).optional(),
  tokenGuardian: tokenGuardianSchema.optional(),
  // Model ids excluded from the Grok Build managed block (dashboard switches).
  grokExcludedModels: stringArraySchema.optional(),
  fastMode: z.boolean().optional(),
  streamMode: z.enum(["auto", "safe-tee", "eager-relay"]).optional(),
  experimentalRealtimeWsBaseUrl: z.string().optional(),
  proxy: z.string().optional(),
  stallTimeoutSec: z.number().finite().positive().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
  shutdownTimeoutMs: z.number().int().nonnegative().optional(),
  websockets: z.boolean().optional(),
  storageCleanupPolicy: storageCleanupPolicySchema.optional(),
  apiKeys: apiKeysSchema.optional(),
  modelCacheTtlMs: z.number().int().nonnegative().optional(),
  cacheRetention: z.enum(["none", "short", "long"]).optional(),
  webSearchSidecar: webSearchSidecarSchema.optional(),
  visionSidecar: visionSidecarSchema.optional(),
  images: imagesSchema.optional(),
  search: searchSchema.optional(),
  corsAllowOrigins: stringArraySchema.optional(),
}).strict().superRefine((config, ctx) => {
  if (config.claudeCode?.desktopProfile !== undefined) {
      try {
        parseDesktopProfile(config.claudeCode.desktopProfile);
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["claudeCode", "desktopProfile"],
          message: "does not match the current Claude Desktop profile schema",
        });
      }
  }

  if (config.syncCodexSubagentDefaults === true) {
    if (!config.injectionModel?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["syncCodexSubagentDefaults"],
        message: "requires a nonblank injectionModel",
      });
    }
    if (config.injectionEffort !== undefined && !isCodexReasoningEffort(config.injectionEffort)) {
      ctx.addIssue({
        code: "custom",
        path: ["injectionEffort"],
        message: "must be a supported Codex reasoning effort when native subagent defaults are enabled",
      });
    }
  }

  const accountNamespaces = config.codexAccountNamespaces;
  if (accountNamespaces) {
    const configuredAccountIds = configuredCodexPoolAccountIds(config.codexAccounts);
    const configuredProviderNamespaces = new Set([
      COMBO_NAMESPACE,
      OPENAI_CODEX_PROVIDER_ID,
      ...Object.keys(config.providers),
    ].map(codexProviderNamespaceKey));
    const namespaceTargets = new Set(
      Object.values(accountNamespaces)
        .filter(accountId => accountId !== MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET),
    );
    for (const namespace of Object.keys(accountNamespaces)) {
      if (configuredProviderNamespaces.has(codexProviderNamespaceKey(namespace))) {
        ctx.addIssue({
          code: "custom",
          path: ["codexAccountNamespaces", namespace],
          message: "account selectors must not collide with configured provider or combo namespaces",
        });
      }
      if (configuredAccountIds.has(namespace) || namespaceTargets.has(namespace)) {
        ctx.addIssue({
          code: "custom",
          path: ["codexAccountNamespaces", namespace],
          message: CODEX_ACCOUNT_NAMESPACE_ACCOUNT_ID_COLLISION_ERROR,
        });
      }
    }
  }
  for (const name of Object.keys(config.providers)) {
    if (!isValidProviderName(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name],
        message: "provider names must use letters, numbers, dot, underscore, or hyphen and cannot be reserved JavaScript object keys or routing namespaces (policy)",
      });
    }
    const provider = config.providers[name];
    const openRouterRoutingError = openRouterRoutingConfigError(provider);
    if (openRouterRoutingError) {
      ctx.addIssue({
        code: "custom",
        path: [
          "providers",
          name,
          openRouterRoutingError.startsWith("modelOpenRouterRouting")
            ? "modelOpenRouterRouting"
            : "openRouterRouting",
        ],
        message: openRouterRoutingError,
      });
    }
    if (Object.hasOwn(provider, "virtualModels")) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "virtualModels"],
        message: "virtualModels is registry-only and must not be persisted",
      });
    }
    const baseUrlError = providerBaseUrlConfigError(provider.baseUrl);
    if (baseUrlError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "baseUrl"],
        message: baseUrlError,
      });
    } else {
      const destinationError = providerDestinationConfigError(name, provider);
      if (destinationError) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", name, "baseUrl"],
          message: destinationError,
        });
      }
    }
    const responsesPathError = providerResponsesPathConfigError(provider.responsesPath);
    if (responsesPathError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "responsesPath"],
        message: responsesPathError,
      });
    }
    const headersError = providerHeadersConfigError((provider as { headers?: unknown }).headers);
    if (headersError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "headers"],
        message: headersError,
      });
    }
    const apiKeyTransportError = apiKeyTransportConfigError(provider as CodexCommanderProviderConfig);
    if (apiKeyTransportError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "apiKeyTransport"],
        message: apiKeyTransportError,
      });
    }
    const modelAdaptersError = modelAdapterRecordConfigError(
      (provider as { modelAdapters?: unknown }).modelAdapters,
      "modelAdapters",
      name,
      provider,
    );
    if (modelAdaptersError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelAdapters"],
        message: modelAdaptersError,
      });
    }
    const preferHostedToolsError = modelPreferHostedToolsConfigError(
      (provider as { modelPreferHostedTools?: unknown }).modelPreferHostedTools,
      "modelPreferHostedTools",
      name,
      provider,
    );
    if (preferHostedToolsError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelPreferHostedTools"],
        message: preferHostedToolsError,
      });
    }
    const maxInputError = positiveIntegerRecordConfigError(
      (provider as { modelMaxInputTokens?: unknown }).modelMaxInputTokens,
      "modelMaxInputTokens",
    );
    if (maxInputError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelMaxInputTokens"],
        message: maxInputError,
      });
    }
    const reasoningSummariesError = booleanRecordConfigError(
      (provider as { modelSupportsReasoningSummaries?: unknown }).modelSupportsReasoningSummaries,
      "modelSupportsReasoningSummaries",
    );
    if (reasoningSummariesError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelSupportsReasoningSummaries"],
        message: reasoningSummariesError,
      });
    }
    const reasoningSummaryDeliveryError = reasoningSummaryDeliveryRecordConfigError(
      (provider as { modelReasoningSummaryDelivery?: unknown }).modelReasoningSummaryDelivery,
      (provider as { modelSupportsReasoningSummaries?: unknown }).modelSupportsReasoningSummaries,
    );
    if (reasoningSummaryDeliveryError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelReasoningSummaryDelivery"],
        message: reasoningSummaryDeliveryError,
      });
    }
    const defaultMaxOutputError = positiveIntegerConfigError(
      (provider as { defaultMaxOutputTokens?: unknown }).defaultMaxOutputTokens,
      "defaultMaxOutputTokens",
    );
    if (defaultMaxOutputError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "defaultMaxOutputTokens"],
        message: defaultMaxOutputError,
      });
    }
    const maxOutputError = positiveIntegerRecordConfigError(
      (provider as { modelMaxOutputTokens?: unknown }).modelMaxOutputTokens,
      "modelMaxOutputTokens",
    );
    if (maxOutputError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelMaxOutputTokens"],
        message: maxOutputError,
      });
    }
    if (Object.hasOwn(provider, "codexAccountMode") && provider.codexAccountMode !== undefined) {
      // Persisted account mode is valid ONLY on the canonical built-in `openai` forward provider.
      const canonicalOpenAiShape = name === "openai"
        && provider.adapter === "openai-responses"
        && (provider as { authMode?: unknown }).authMode === "forward"
        && typeof provider.baseUrl === "string"
        && provider.baseUrl.replace(/\/+$/, "") === "https://chatgpt.com/backend-api/codex";
      if (!canonicalOpenAiShape) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", name, "codexAccountMode"],
          message: "codexAccountMode is valid only on the canonical built-in openai provider",
        });
      }
    }
  }
  if (!hasOwnProvider(config.providers, config.defaultProvider)) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultProvider"],
      message: "defaultProvider must exist in providers",
    });
  }
  const combos = (config as { combos?: unknown }).combos;
  if (combos !== undefined) {
    if (!combos || typeof combos !== "object" || Array.isArray(combos)) {
      ctx.addIssue({ code: "custom", path: ["combos"], message: "combos must be an object" });
    } else {
      for (const [id, raw] of Object.entries(combos as Record<string, unknown>)) {
        const alias = raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as { alias?: unknown }).alias
          : undefined;
        if (typeof alias === "string" && codexAccountNamespaceForModel(accountNamespaces, alias.trim())) {
          ctx.addIssue({
            code: "custom",
            path: ["combos", id, "alias"],
            message: CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
          });
        }
        // Pass the full map so cross-combo rules (alias uniqueness) apply at load time
        // too, not just via the management API; each combo is excluded from its own check.
        for (const issue of comboConfigIssues(id, raw, config.providers, {
          combos: combos as Record<string, import("./types").CodexCommanderComboConfig>,
          excludeComboId: id,
        })) {
          ctx.addIssue({
            code: "custom",
            path: ["combos", id, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  }
  const routingProfiles = (config as { routingProfiles?: unknown }).routingProfiles;
  if (routingProfiles !== undefined) {
    if (!routingProfiles || typeof routingProfiles !== "object" || Array.isArray(routingProfiles)) {
      ctx.addIssue({ code: "custom", path: ["routingProfiles"], message: "routingProfiles must be an object" });
    } else {
      for (const [id, raw] of Object.entries(routingProfiles as Record<string, unknown>)) {
        for (const issue of routingProfileIssues(id, raw, {
          providers: config.providers,
          combos: combos as Record<string, import("./types").CodexCommanderComboConfig> | undefined,
          routingProfiles: routingProfiles as Record<string, import("./types").CodexCommanderRoutingProfileConfig>,
          codexAccountNamespaces: accountNamespaces,
        }, { excludeProfileId: id })) {
          ctx.addIssue({
            code: "custom",
            path: ["routingProfiles", id, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  }
});

/**
 * Default featured subagent models (native GPT) seeded on a fresh install and when `subagentModels`
 * is unset. Codex's spawn_agent advertises the first 5 featured catalog entries as suggestions, so this seed is a
 * deliberate 5-list: frontier gpt-5.5 first, the gpt-5.6 preview trio, and gpt-5.4-mini as the cheap
 * tier. gpt-5.4 / gpt-5.3-codex-spark stay selectable in the GUI's available list. The user can
 * remove any in the GUI — once they set the list (even to []), it is respected, so removals persist
 * (start-up only seeds the UNSET case). Kept to ids ChatGPT accepts; the start-up seed prefers the
 * live catalog's native slugs.
 */
export const DEFAULT_SUBAGENT_MODELS = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"];

export function getConfigDir(): string {
  return resolveConfigDir();
}

export function getConfigPath(): string {
  return resolveConfigPath();
}

export function getPidPath(): string {
  return resolvePidPath();
}

export function getRuntimePortPath(): string {
  return resolveRuntimePortPath();
}

export function hardenConfigDir(): void {
  const dir = getConfigDir();
  // The guard runs BEFORE any mutation: refusing the write after chmod/ACL
  // would already have changed the protected directory (review round 2).
  assertNotRealHomeUnderTest(dir);
  if (existsSync(dir)) {
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
    if (process.platform === "win32") {
      hardenSecretDir(dir, { required: false });
    }
  }
}

export function hardenExistingSecret(path: string): void {
  if (existsSync(path)) {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (process.platform === "win32") {
      hardenSecretPath(path, { required: false });
    }
  }
}
/**
 * Validation for `retryOn429` at every current-schema boundary. Invalid values
 * and unknown keys are rejected outright. Never echoes values, and
 * secret-shaped unknown field names are redacted.
 */
export function retryOn429PolicyConfigError(policy: unknown): string | null {
  if (policy === undefined) return null;
  const result = retryOn429PolicySchema.safeParse(policy);
  if (result.success) return null;
  const first = result.error.issues[0];
  if (!first) return "retryOn429 is invalid";
  if (first.code === "unrecognized_keys") {
    const names = first.keys.map(key => JSON.stringify(redactSecretString(key))).join(", ");
    return `retryOn429 has unrecognized field${first.keys.length > 1 ? "s" : ""}: ${names}`;
  }
  if (first.path.length === 0) return `retryOn429 is invalid (${first.message})`;
  const field = String(first.path[first.path.length - 1]);
  return `retryOn429.${field} is invalid (${first.message})`;
}

/** One definition of "usable secret", shared by parsing and admission. */
function isUsableApiKeySecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function loadConfig(): CodexCommanderConfig {
  const dir = getConfigDir();
  const configPath = getConfigPath();
  hardenConfigDir();
  hardenExistingSecret(configPath);
  hardenExistingSecret(join(dir, "auth.json"));
  if (!existsSync(configPath)) {
    return getDefaultConfig();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Cannot load CodexCommander config at ${configPath}: invalid_json`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Cannot load CodexCommander config at ${configPath}: ${schemaDiagnosticsError(result.error)}`);
  }
  return result.data as CodexCommanderConfig;
}

export type ConfigDiagnostics = {
  config: CodexCommanderConfig;
  source: "default" | "file" | "fallback";
  error: string | null;
  /** Non-fatal config concerns; absent when there are no warnings. */
  warnings?: string[];
};

type ConfigFileSnapshot = {
  diagnostics: ConfigDiagnostics;
  /** Exact file contents, including a possible BOM, used as the optimistic revision. */
  raw?: string;
};

function configPlaceholderWarnings(config: CodexCommanderConfig): string[] {
  const warnings: string[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    const placeholder = provider.baseUrl.match(/\{[^}]*\}/)?.[0];
    if (placeholder) {
      warnings.push(`providers.${name}.baseUrl contains unresolved ${placeholder}; set the real provider URL`);
    }
  }
  return warnings;
}

function validFileConfigDiagnostics(config: CodexCommanderConfig): ConfigDiagnostics {
  const warnings = configPlaceholderWarnings(config);
  return {
    config,
    source: "file",
    error: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function subagentDefaultSyncEffective(
  config: Pick<CodexCommanderConfig, "syncCodexSubagentDefaults" | "injectionModel">,
): boolean {
  return config.syncCodexSubagentDefaults === true && Boolean(config.injectionModel?.trim());
}

function schemaDiagnosticsError(error: z.ZodError): string {
  const details = error.issues.map(issue => {
    const path = issue.path.map(segment => {
      if (typeof segment === "number") return String(segment);
      const safe = redactSecretString(String(segment));
      return /^[A-Za-z0-9_-]+$/.test(safe) ? safe : JSON.stringify(safe);
    }).join(".") || "config";
    const message = issue.code === "unrecognized_keys"
      ? `unrecognized field${issue.keys.length === 1 ? "" : "s"}`
      : issue.message;
    return `${path}: ${message}`;
  });
  return details.length > 0 ? `schema_invalid: ${details.join("; ")}` : "schema_invalid";
}

/** Validate an in-memory config candidate without touching disk. Used by headless CLI import/set. */
export function validateConfigCandidate(value: unknown): { ok: true; config: CodexCommanderConfig } | { ok: false; error: string } {
  const result = configSchema.safeParse(value);
  if (!result.success) return { ok: false, error: schemaDiagnosticsError(result.error) };
  return { ok: true, config: result.data as CodexCommanderConfig };
}

function configDiagnosticsFromRaw(raw: string): ConfigDiagnostics {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const result = configSchema.safeParse(parsed);
    if (result.success) {
      return validFileConfigDiagnostics(result.data as CodexCommanderConfig);
    }

    return { config: getDefaultConfig(), source: "fallback", error: schemaDiagnosticsError(result.error) };
  } catch {
    return { config: getDefaultConfig(), source: "fallback", error: "invalid_json" };
  }
}

function readConfigFileSnapshot(): ConfigFileSnapshot {
  try {
    const raw = readFileSync(getConfigPath(), "utf-8");
    return { diagnostics: configDiagnosticsFromRaw(raw), raw };
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        diagnostics: { config: getDefaultConfig(), source: "default", error: null },
      };
    }
    return {
      diagnostics: { config: getDefaultConfig(), source: "fallback", error: "invalid_json" },
    };
  }
}

export function readConfigDiagnostics(): ConfigDiagnostics {
  return readConfigFileSnapshot().diagnostics;
}

export type ConfigInitializationRefusal =
  | "candidate-invalid"
  | "existing-invalid"
  | "existing-inaccessible"
  | "existing-unsafe"
  | "coordination-unavailable";

export type ConfigInitializationResult =
  | { status: "created" }
  | { status: "existing" }
  | { status: "refused"; reason: ConfigInitializationRefusal };

type ConfigEntryProbe =
  | { kind: "missing" }
  | { kind: "valid" }
  | {
    kind: "refused";
    reason: Exclude<
      ConfigInitializationRefusal,
      "candidate-invalid" | "coordination-unavailable"
    >;
  };

type ConfigRootProbe =
  | { kind: "missing" }
  | { kind: "valid" }
  | { kind: "refused"; reason: "existing-inaccessible" | "existing-unsafe" };

const CONFIG_INITIALIZATION_WAIT_MS = 2_000;
const CONFIG_INITIALIZATION_POLL_MS = 10;

function probeConfigRoot(): ConfigRootProbe {
  const path = getConfigDir();
  let entry;
  try {
    entry = inspectPhysicalConfigRoot(path);
  } catch (error) {
    return isMissingPathError(error)
      ? { kind: "missing" }
      : { kind: "refused", reason: "existing-inaccessible" };
  }
  if (entry.kind !== "valid") {
    return { kind: "refused", reason: "existing-unsafe" };
  }
  return { kind: "valid" };
}

function probeConfigEntry(): ConfigEntryProbe {
  let entry;
  try {
    entry = lstatSync(getConfigPath());
  } catch (error) {
    return isMissingPathError(error)
      ? { kind: "missing" }
      : { kind: "refused", reason: "existing-inaccessible" };
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    return { kind: "refused", reason: "existing-unsafe" };
  }
  try {
    return configDiagnosticsFromRaw(readFileSync(getConfigPath(), "utf8")).source === "file"
      ? { kind: "valid" }
      : { kind: "refused", reason: "existing-invalid" };
  } catch {
    return { kind: "refused", reason: "existing-inaccessible" };
  }
}

function createConfigExclusive(path: string, bytes: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  let complete = false;
  let descriptorOpen = true;
  try {
    writeFileSync(descriptor, bytes, { encoding: "utf8" });
    try { fchmodSync(descriptor, 0o600); } catch { /* filesystem may ignore chmod */ }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptorOpen = false;
    if (process.platform === "win32") {
      hardenSecretPath(path, { required: true, timeoutMemoKey: path });
    }
    complete = true;
    return true;
  } finally {
    if (descriptorOpen) {
      try { closeSync(descriptor); } catch { /* the create/write error remains authoritative */ }
    }
    if (!complete) {
      try { unlinkSync(path); } catch { /* a later static probe will refuse any residue */ }
    }
  }
}

function configInitializationContenderObservation(): ConfigInitializationResult | ConfigEntryProbe {
  const current = probeConfigEntry();
  if (current.kind === "valid") return { status: "existing" };
  return current;
}

function waitForConfigInitializationWinner(
  deadline: number,
  fallback: ConfigInitializationRefusal,
): ConfigInitializationResult {
  let lastRefusal: ConfigInitializationRefusal | null = null;
  for (;;) {
    const observed = configInitializationContenderObservation();
    if ("status" in observed) return observed;
    if (observed.kind === "refused") lastRefusal = observed.reason;
    if (performance.now() >= deadline) {
      return { status: "refused", reason: lastRefusal ?? fallback };
    }
    Bun.sleepSync(CONFIG_INITIALIZATION_POLL_MS);
  }
}

export function initializeConfigIfMissing(
  candidate: CodexCommanderConfig,
): ConfigInitializationResult {
  const validated = validateConfigCandidate(candidate);
  if (!validated.ok) return { status: "refused", reason: "candidate-invalid" };
  const deadline = performance.now() + CONFIG_INITIALIZATION_WAIT_MS;
  const initialRoot = probeConfigRoot();
  if (initialRoot.kind === "refused") {
    return { status: "refused", reason: initialRoot.reason };
  }
  const observed = probeConfigEntry();
  if (observed.kind === "valid") return { status: "existing" };
  if (observed.kind === "refused" && observed.reason !== "existing-invalid") {
    return { status: "refused", reason: observed.reason };
  }
  let ownershipFailure: ConfigInitializationRefusal | null = null;
  try {
    if (!recordOwnedConfigPath(getConfigDir(), getConfigPath())) {
      ownershipFailure = "existing-unsafe";
    }
  } catch {
    ownershipFailure = "existing-inaccessible";
  }

  const ownedRoot = probeConfigRoot();
  if (ownedRoot.kind !== "valid") {
    return {
      status: "refused",
      reason: ownedRoot.kind === "refused" ? ownedRoot.reason : "existing-unsafe",
    };
  }
  if (!ownershipFailure) {
    try {
      if (!recordOwnedConfigPath(getConfigDir(), getConfigPath())) {
        ownershipFailure = "existing-unsafe";
      }
    } catch {
      ownershipFailure = "existing-inaccessible";
    }
  }
  if (ownershipFailure) {
    if (observed.kind === "refused" && observed.reason === "existing-invalid") {
      return { status: "refused", reason: observed.reason };
    }
    return waitForConfigInitializationWinner(deadline, ownershipFailure);
  }

  let lastContentionRefusal: ConfigInitializationRefusal | null = null;
  for (;;) {
    try {
      return withConfigMutationLockTimeoutSync(() => {
        const current = probeConfigEntry();
        if (current.kind === "valid") return { status: "existing" } as const;
        if (current.kind === "refused") {
          return { status: "refused", reason: current.reason } as const;
        }

        const bytes = `${JSON.stringify(validated.config, null, 2)}\n`;
        const published = createConfigExclusive(getConfigPath(), bytes);
        if (!published) {
          const winner = probeConfigEntry();
          if (winner.kind === "valid") return { status: "existing" } as const;
          return {
            status: "refused",
            reason: winner.kind === "refused" ? winner.reason : "coordination-unavailable",
          } as const;
        }
        bumpGenerationForCooperatingConfigWrite();
        return { status: "created" } as const;
      }, CONFIG_INITIALIZATION_WAIT_MS);
    } catch (error) {
      if (!(error instanceof ConfigMutationLockError)) {
        return { status: "refused", reason: "coordination-unavailable" };
      }
      const contender = configInitializationContenderObservation();
      if ("status" in contender) return contender;
      if (contender.kind === "refused") lastContentionRefusal = contender.reason;
      if (performance.now() >= deadline) {
        return {
          status: "refused",
          reason: lastContentionRefusal ?? "coordination-unavailable",
        };
      }
      Bun.sleepSync(CONFIG_INITIALIZATION_POLL_MS);
    }
  }
}

/**
 * The persisted config, plus a digest of the EXACT bytes it was parsed from.
 *
 * A union rather than a nullable digest, because `{ kind: "read" }` with no
 * digest is a state that cannot occur — and a state that cannot occur should
 * not be a state that can be written down. Refusing it at runtime is a check
 * somebody eventually forgets; making it unrepresentable is not.
 *
 * Why a byte digest at all: the Codex write lock compares an authority snapshot
 * taken before the lock against one taken while holding it, and its config
 * component used to hash the PARSED object. Two files that differ only in
 * whitespace or key order parse identically, so a non-cooperating writer could
 * rewrite the file between admission and commit and the comparison would see
 * nothing. Hashing what was actually read closes that.
 *
 * `readConfigFileSnapshot` stays private on purpose. Its `raw` carries provider
 * API keys and admission tokens, and `privacy:scan` reads tracked source text,
 * not runtime values — so it would not catch a caller that logged or serialized
 * that string. The digest travels; the bytes do not.
 */
export type ConfigAdmissionSnapshot =
  | Readonly<{ kind: "read"; diagnostics: ConfigDiagnostics; contentSha256: string }>
  | Readonly<{ kind: "unreadable"; diagnostics: ConfigDiagnostics; contentSha256: null }>;

export function readConfigAdmissionSnapshot(): ConfigAdmissionSnapshot {
  let bytes: Buffer;
  try {
    // ONE read. Hashing the file and then reading it again to parse would leave
    // a window for the two to disagree, which is the exact hazard this exists
    // to detect — the check would become a second chance to be wrong.
    bytes = readFileSync(getConfigPath());
  } catch (error) {
    return {
      kind: "unreadable",
      diagnostics: isMissingPathError(error)
        ? { config: getDefaultConfig(), source: "default", error: null }
        : { config: getDefaultConfig(), source: "fallback", error: "invalid_json" },
      contentSha256: null,
    };
  }
  return {
    kind: "read",
    // Decoded from the same buffer that was hashed, not re-read from disk.
    diagnostics: configDiagnosticsFromRaw(bytes.toString("utf-8")),
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const CONFIG_MUTATION_DB_FILENAME = "config-mutation.sqlite";
const CONFIG_MUTATION_DB_SIDECARS = ["-journal", "-wal", "-shm"] as const;
let warnedConfigMutationDirectoryAcl = false;

export class ConfigMutationLockError extends Error {
  readonly code = "CONFIG_MUTATION_LOCK_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigMutationLockError";
  }
}

function configMutationDatabasePath(): string {
  const dir = getConfigDir();
  // First statement on purpose: a rejected mutation must leave nothing behind, not a
  // freshly created/chmod'd directory or database. See src/lib/test-home-guard.ts.
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  if (windowsSecretAclApplies()) {
    try {
      // Distinct timeout memo from management-token directory harden: a required
      // management-dir timeout must not poison config mutation on the same home
      // (windows-latest server-management-auth cases).
      hardenSecretDir(dir, { required: true, timeoutMemoKey: `${dir}::config-mutation` });
    } catch (error) {
      if (!warnedConfigMutationDirectoryAcl) {
        warnedConfigMutationDirectoryAcl = true;
        const diagnostics = error instanceof Error ? error.message : "ACL hardening failed";
        console.warn(
          `[CodexCommander] Config mutation coordination directory ACL hardening did not complete; continuing without it. ${diagnostics}`,
        );
      }
    }
  }
  const path = join(dir, CONFIG_MUTATION_DB_FILENAME);
  recordOwnedConfigPath(dir, path);
  for (const suffix of CONFIG_MUTATION_DB_SIDECARS) {
    recordOwnedConfigPath(dir, `${path}${suffix}`);
  }
  return path;
}

let configMutationLockDepth = 0;
let configMutationDatabase: Database | null = null;

/**
 * Serialize synchronous config and Codex credential-generation commits across processes with an
 * OS-backed SQLite write transaction. `busy_timeout=0` is deliberate: runtime request paths must
 * fail immediately under contention rather than freeze the Bun event loop. Process exit releases
 * SQLite locks without stale-owner deletion or lease recovery races.
 *
 * Reentrancy is limited to the current synchronous call stack; never return a Promise from `fn`.
 */
export function withConfigMutationLockSync<T>(fn: () => T): T {
  return withConfigMutationLockTimeoutSync(fn, 0);
}

function withConfigMutationLockTimeoutSync<T>(
  fn: () => T,
  busyTimeoutMs: number,
): T {
  if (configMutationLockDepth > 0) {
    configMutationLockDepth += 1;
    try {
      return fn();
    } finally {
      configMutationLockDepth -= 1;
    }
  }
  const path = configMutationDatabasePath();
  let database: Database | undefined;
  let transactionOpen = false;
  try {
    database = new Database(path, { create: true });
    try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; BEGIN IMMEDIATE`);
    transactionOpen = true;
    initializeConfigGeneration(database);
  } catch (cause) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
    }
    try { database?.close(); } catch { /* acquisition already failed */ }
    const code = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
    throw new ConfigMutationLockError(
      code === "SQLITE_BUSY" ? "Config mutation already in progress" : "Could not acquire config mutation transaction",
      { cause },
    );
  }

  configMutationLockDepth = 1;
  configMutationDatabase = database;
  try {
    const value = fn();
    database.exec("COMMIT");
    transactionOpen = false;
    return value;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
      transactionOpen = false;
    }
    throw error;
  } finally {
    configMutationLockDepth = 0;
    configMutationDatabase = null;
    try { database.close(); } catch { /* the OS lock is released with the handle */ }
  }
}

function bumpGenerationForCooperatingConfigWrite(): void {
  if (!configMutationDatabase) {
    throw new Error("A cooperating config write requires the config mutation transaction.");
  }
  bumpCurrentConfigGeneration(configMutationDatabase);
}

export const readConfigGeneration: ReadConfigGeneration = () => {
  try {
    return readConfigGenerationAtPath(configMutationDatabasePath());
  } catch {
    return { kind: "unavailable", reason: "database" };
  }
};

export function observeConfigGeneration(): ConfigGenerationObservation {
  return observeConfigGenerationAtPath(join(getConfigDir(), CONFIG_MUTATION_DB_FILENAME));
}

/**
 * Read the generation from the transaction that is open RIGHT NOW.
 *
 * The observer cannot do this job. On the very first acquisition the
 * `BEGIN IMMEDIATE` that creates the table has not committed yet, so a separate
 * read-only connection cannot read a generation from it — measured, not
 * assumed. A caller that compared a pre-lock observation against an observer
 * re-read would therefore refuse every first write as stale.
 *
 * Throwing when no transaction is open is deliberate. Being called outside the
 * lock is broken plumbing, and returning a typed "unavailable" would let that
 * bug arrive disguised as an environmental failure — retried forever, on a
 * machine where nothing is wrong.
 */
export function readConfigGenerationInCurrentMutationTransaction(): ConfigGeneration {
  if (configMutationLockDepth < 1 || !configMutationDatabase) {
    throw new Error(
      "readConfigGenerationInCurrentMutationTransaction requires an open config mutation transaction.",
    );
  }
  return readConfigGenerationInTransaction(configMutationDatabase);
}

export const bumpConfigGeneration: BumpConfigGeneration = expected => {
  try {
    return bumpConfigGenerationAtPath(configMutationDatabasePath(), expected);
  } catch {
    return { kind: "unavailable", reason: "database" };
  }
};

function configGenerationFailureReason(error: unknown): "busy" | "database" {
  const cause = error instanceof ConfigMutationLockError ? error.cause : error;
  const code = cause && typeof cause === "object" && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : "";
  const message = cause instanceof Error ? cause.message : "";
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message)
    ? "busy"
    : "database";
}

export const withExpectedConfigGenerationSync: WithExpectedConfigGenerationSync = (
  expected,
  commit,
) => {
  let callbackThrew = false;
  let callbackError: unknown;
  try {
    return withConfigMutationLockSync(() => {
      const database = configMutationDatabase;
      if (!database) throw new Error("Config mutation transaction database is unavailable.");
      const current = readConfigGenerationInTransaction(database);
      if (current.value !== expected.value) return { kind: "conflict", current };
      try {
        return { kind: "matched", generation: current, value: commit() };
      } catch (error) {
        callbackThrew = true;
        callbackError = error;
        throw error;
      }
    });
  } catch (error) {
    if (callbackThrew && error === callbackError) throw error;
    return { kind: "unavailable", reason: configGenerationFailureReason(error) };
  }
};

function persistConfigUnlocked(config: CodexCommanderConfig): boolean {
  const validation = validateConfigCandidate(config);
  if (!validation.ok) throw new Error(`Cannot persist invalid CodexCommander config: ${validation.error}`);
  const configPath = getConfigPath();
  const bytes = JSON.stringify(config, null, 2) + "\n";
  try {
    if (readFileSync(configPath, "utf8") === bytes) return false;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  atomicWriteFile(configPath, bytes);
  return true;
}

/** Existing malformed bytes are not an implicit authorization to replace the file. */
function currentConfigForWrite(): CodexCommanderConfig | undefined {
  const snapshot = readConfigFileSnapshot();
  if (snapshot.diagnostics.source === "fallback") {
    throw new Error(`Cannot overwrite an invalid CodexCommander config: ${snapshot.diagnostics.error ?? "invalid_config"}`);
  }
  return snapshot.diagnostics.source === "file" ? snapshot.diagnostics.config : undefined;
}

export function saveConfig(config: CodexCommanderConfig): void {
  // Keep the real-home assertion ahead of even lock-directory preparation.
  assertNotRealHomeUnderTest(getConfigDir());
  withConfigMutationLockSync(() => {
    currentConfigForWrite();
    if (persistConfigUnlocked(config)) bumpGenerationForCooperatingConfigWrite();
  });
}

export type PersistedConfigMutation<T> = {
  changed: boolean;
  value: T;
};

export type PersistedConfigMutationOutcome<T> =
  | { status: "committed" | "unchanged"; value: T }
  | { status: "unavailable"; reason: "missing" | "invalid" | "conflict" };

const CONFIG_MUTATION_MAX_REBASE_ATTEMPTS = 3;
let persistedConfigMutationBeforeCommitForTests: (() => void) | null = null;

/** Test-only one-shot seam: inject a competing mutation after the first decision, before freshness revalidation. */
export function setPersistedConfigMutationBeforeCommitForTests(hook: (() => void) | null): void {
  persistedConfigMutationBeforeCommitForTests = hook;
}

function unavailableConfigMutationReason(snapshot: ConfigFileSnapshot): "missing" | "invalid" {
  return snapshot.diagnostics.source === "default" ? "missing" : "invalid";
}

/**
 * Patch a schema-valid on-disk config under the shared mutation lock. Cooperating writers are
 * serialized; the callback is rerun on the newest snapshot so observed direct byte changes rebase
 * and credential predicates are re-evaluated immediately before the atomic commit. A writer that
 * ignores the coordinator can still change bytes after the final check because the filesystem has
 * no portable conditional rename. Missing or malformed config always fails closed and is never
 * recreated from a prior snapshot.
 */
export function mutatePersistedConfig<T>(
  mutate: (config: CodexCommanderConfig) => PersistedConfigMutation<T>,
): PersistedConfigMutationOutcome<T> {
  // Avoid creating/opening the coordinator database for a read-path update that already knows
  // there is no valid config. The same check runs again under the transaction for authority.
  const observed = readConfigFileSnapshot();
  if (observed.diagnostics.source !== "file" || observed.raw === undefined) {
    return { status: "unavailable", reason: unavailableConfigMutationReason(observed) };
  }
  return withConfigMutationLockSync(() => {
    let base = readConfigFileSnapshot();
    for (let attempt = 0; attempt < CONFIG_MUTATION_MAX_REBASE_ATTEMPTS; attempt += 1) {
      if (base.diagnostics.source !== "file" || base.raw === undefined) {
        return { status: "unavailable", reason: unavailableConfigMutationReason(base) };
      }

      const tentativeConfig = structuredClone(base.diagnostics.config);
      const tentative = mutate(tentativeConfig);
      if (!tentative.changed) return { status: "unchanged", value: tentative.value };

      const hook = persistedConfigMutationBeforeCommitForTests;
      persistedConfigMutationBeforeCommitForTests = null;
      hook?.();

      const latest = readConfigFileSnapshot();
      if (latest.diagnostics.source !== "file" || latest.raw === undefined) {
        return { status: "unavailable", reason: unavailableConfigMutationReason(latest) };
      }
      if (latest.raw !== base.raw) {
        base = latest;
        continue;
      }

      // Re-run against a fresh clone even when config bytes are unchanged: a Codex credential
      // generation lives in a separate file and may have changed at the injected seam.
      const confirmedConfig = structuredClone(latest.diagnostics.config);
      const confirmed = mutate(confirmedConfig);
      if (!confirmed.changed) return { status: "unchanged", value: confirmed.value };

      const commitBase = readConfigFileSnapshot();
      if (commitBase.diagnostics.source !== "file" || commitBase.raw === undefined) {
        return { status: "unavailable", reason: unavailableConfigMutationReason(commitBase) };
      }
      if (commitBase.raw !== latest.raw) {
        base = commitBase;
        continue;
      }

      if (persistConfigUnlocked(confirmedConfig)) bumpGenerationForCooperatingConfigWrite();
      return { status: "committed", value: confirmed.value };
    }
    return { status: "unavailable", reason: "conflict" };
  });
}

export function websocketsEnabled(config: Pick<CodexCommanderConfig, "websockets">): boolean {
  return config.websockets === true;
}

// ---------------------------------------------------------------------------
// Live-save protection for independently mutated config subtrees.
//
// `saveConfig` serializes the WHOLE config object, so ANY service-time save — a model
// visibility toggle, a 429 key rotation on the request path — rewrites `claudeCode`
// from whatever the long-lived server config happens to hold. A user who hand-edits
// `config.json` while the proxy runs then watches their edit vanish for no visible
// reason (issue #488). Enumerating `claudeCode` mutators cannot fix that; the guard has
// to live in ONE save wrapper that every live-config writer goes through.
// ---------------------------------------------------------------------------

/**
 * Baseline keyed on the CONFIG INSTANCE, never a module global: a second `loadConfig()`
 * elsewhere must not refresh the baseline the long-lived server config is judged
 * against, or a later stale save would masquerade as "our own change".
 */
const claudeCodeBaseline = new WeakMap<CodexCommanderConfig, unknown>();
const clientIntegrationsBaseline = new WeakMap<CodexCommanderConfig, unknown>();

/**
 * The live config retains the address of the socket Bun actually opened, while
 * this map retains the operator's desired address for the next process start.
 * Keeping them separate prevents an unrelated live save from restoring a stale
 * externally exposed bind after OAuth adopted a newer loopback disk config.
 */
type PersistedServerBinding = Pick<CodexCommanderConfig, "port" | "hostname">;

const persistedLiveServerBinding = new WeakMap<CodexCommanderConfig, PersistedServerBinding>();

/**
 * Arm the baseline for a long-lived config. MANDATORY at `startServer`, not lazy on
 * first save — arming lazily would lose exactly the hand edit made before that first
 * save, which is the case the guard exists for.
 */
export function armClaudeCodeBaseline(config: CodexCommanderConfig): void {
  claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
  clientIntegrationsBaseline.set(config, structuredClone(config.clientIntegrations));
}

/** Test seam only: is this instance armed? */
export function claudeCodeBaselineArmed(config: CodexCommanderConfig): boolean {
  return claudeCodeBaseline.has(config);
}

/**
 * Structural compare of parsed subtrees. NOT `JSON.stringify`: key order must not
 * decide whether a user's hand edit survives.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  // `undefined` values and absent keys are the same thing after a JSON round-trip.
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] === undefined && right[key] === undefined) continue;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

const MISSING_CONFIG_VALUE = Symbol("missing-config-value");
type ConfigMergeValue = unknown | typeof MISSING_CONFIG_VALUE;

function isPlainConfigRecord(value: ConfigMergeValue): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownConfigValue(record: Record<string, unknown>, key: string): ConfigMergeValue {
  return Object.hasOwn(record, key) ? record[key] : MISSING_CONFIG_VALUE;
}

function cloneConfigValue(value: ConfigMergeValue): ConfigMergeValue {
  return value === MISSING_CONFIG_VALUE ? value : structuredClone(value);
}

function reconcileConfigRecord(
  live: Record<string, unknown>,
  baseline: Record<string, unknown>,
  persisted: Record<string, unknown>,
  skippedKeys?: ReadonlySet<string>,
): void {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(live), ...Object.keys(persisted)]);
  for (const key of keys) {
    if (skippedKeys?.has(key)) continue;
    const merged = reconcileConfigValue(
      ownConfigValue(baseline, key),
      ownConfigValue(live, key),
      ownConfigValue(persisted, key),
    );
    if (merged === MISSING_CONFIG_VALUE) delete live[key];
    else live[key] = merged;
  }
}

function reconcileConfigValue(
  baseline: ConfigMergeValue,
  live: ConfigMergeValue,
  persisted: ConfigMergeValue,
): ConfigMergeValue {
  const liveChanged = !deepEqual(live, baseline);
  const persistedChanged = !deepEqual(persisted, baseline);

  if (!liveChanged) {
    if (live !== MISSING_CONFIG_VALUE && Array.isArray(live) && Array.isArray(persisted)) {
      live.splice(0, live.length, ...structuredClone(persisted));
      return live;
    }
    if (isPlainConfigRecord(live) && isPlainConfigRecord(persisted)) {
      reconcileConfigRecord(
        live,
        isPlainConfigRecord(baseline) ? baseline : {},
        persisted,
      );
      return live;
    }
    return cloneConfigValue(persisted);
  }

  if (!persistedChanged) return live;

  if (isPlainConfigRecord(live)
    && isPlainConfigRecord(persisted)
    && (baseline === MISSING_CONFIG_VALUE || isPlainConfigRecord(baseline))) {
    reconcileConfigRecord(
      live,
      isPlainConfigRecord(baseline) ? baseline : {},
      persisted,
    );
  }
  // Same-leaf conflicts prefer the pending live management mutation.
  return live;
}

/**
 * Reconcile an async OAuth disk commit into the shared live config without erasing
 * management mutations that have not saved yet. The baseline is a normalized disk
 * snapshot from immediately before login; disjoint object edits merge recursively,
 * while same-leaf conflicts prefer live state.
 */
export function reconcileLiveConfigFromDisk(config: CodexCommanderConfig, persistedBaseline: CodexCommanderConfig): void {
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source !== "file") {
    throw new Error(`OAuth config reconciliation failed: ${diagnostics.error ?? "config file is missing"}`);
  }
  const persisted = diagnostics.config;
  const claudeGuardArmed = claudeCodeBaseline.has(config);
  const integrationsGuardArmed = clientIntegrationsBaseline.has(config);
  const pendingLiveClaudeMutation = claudeGuardArmed
    && !deepEqual(config.claudeCode, claudeCodeBaseline.get(config));
  const pendingLiveIntegrationsMutation = integrationsGuardArmed
    && !deepEqual(config.clientIntegrations, clientIntegrationsBaseline.get(config));

  persistedLiveServerBinding.set(config, {
    port: persisted.port,
    ...(persisted.hostname !== undefined ? { hostname: persisted.hostname } : {}),
  });

  reconcileConfigRecord(
    config as unknown as Record<string, unknown>,
    persistedBaseline as unknown as Record<string, unknown>,
    persisted as unknown as Record<string, unknown>,
    new Set([
      "hostname",
      "port",
      ...(claudeGuardArmed ? ["claudeCode"] : []),
      ...(integrationsGuardArmed ? ["clientIntegrations"] : []),
    ]),
  );

  if (claudeGuardArmed && !pendingLiveClaudeMutation) {
    if (persisted.claudeCode === undefined) delete config.claudeCode;
    else config.claudeCode = structuredClone(persisted.claudeCode);
    claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
  }
  if (integrationsGuardArmed && !pendingLiveIntegrationsMutation) {
    if (persisted.clientIntegrations === undefined) delete config.clientIntegrations;
    else config.clientIntegrations = structuredClone(persisted.clientIntegrations);
    clientIntegrationsBaseline.set(config, structuredClone(config.clientIntegrations));
  }
}

function readPersistedServerBinding(raw: CodexCommanderConfig): PersistedServerBinding {
  return {
    port: raw.port,
    ...(raw.hostname !== undefined ? { hostname: raw.hostname } : {}),
  };
}

/**
 * The save entry point for every writer holding a LIVE server config.
 *
 * Conflict policy, chosen deliberately:
 * - disk changed, we did not → their hand edit wins;
 * - disk changed AND we changed → our change wins and the baseline rebases, so the
 *   user's next edit starts from the new value (a three-way merge is out of scope);
 * - file missing → save what we have;
 * - malformed file → reject the save rather than normalize or overwrite it.
 *
 * Scope residual: only `claudeCode` is reconciled. A hand edit to `providers` is still
 * clobbered — recorded and asserted in tests so it cannot drift into an assumed
 * guarantee.
 */
export function saveConfigPreservingClaudeCode(config: CodexCommanderConfig): void {
  withConfigMutationLockSync(() => {
    const currentOnDisk = currentConfigForWrite();
    const bindingBaseline = persistedLiveServerBinding.get(config);
    const onDisk = claudeCodeBaseline.has(config) || bindingBaseline
      ? currentOnDisk
      : undefined;
    if (claudeCodeBaseline.has(config)) {
      if (onDisk !== undefined) {
        const baseline = claudeCodeBaseline.get(config);
        const persistedClaudeCode = structuredClone(onDisk.claudeCode);
        const diskChanged = !deepEqual(persistedClaudeCode, baseline);
        const weChanged = !deepEqual(config.claudeCode, baseline);
        if (diskChanged && !weChanged) {
          config.claudeCode = persistedClaudeCode;
        }
      }
    }
    if (clientIntegrationsBaseline.has(config) && onDisk !== undefined) {
      const baseline = clientIntegrationsBaseline.get(config);
      const persistedIntegrations = structuredClone(onDisk.clientIntegrations);
      const diskChanged = !deepEqual(persistedIntegrations, baseline);
      const weChanged = !deepEqual(config.clientIntegrations, baseline);
      if (diskChanged && !weChanged) {
        config.clientIntegrations = persistedIntegrations;
      }
    }
    const persistedBinding = bindingBaseline && onDisk
      ? readPersistedServerBinding(onDisk)
      : bindingBaseline;
    if (persistedBinding) {
      const persistedConfig: CodexCommanderConfig = { ...config, port: persistedBinding.port };
      if (persistedBinding.hostname === undefined) delete persistedConfig.hostname;
      else persistedConfig.hostname = persistedBinding.hostname;
      if (persistConfigUnlocked(persistedConfig)) bumpGenerationForCooperatingConfigWrite();
      persistedLiveServerBinding.set(config, persistedBinding);
    } else {
      if (persistConfigUnlocked(config)) bumpGenerationForCooperatingConfigWrite();
    }
    if (claudeCodeBaseline.has(config)) {
      claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
    }
    if (clientIntegrationsBaseline.has(config)) {
      clientIntegrationsBaseline.set(config, structuredClone(config.clientIntegrations));
    }
  });
}

export function codexAutoStartEnabled(config: Pick<CodexCommanderConfig, "codexAutoStart">): boolean {
  return config.codexAutoStart !== false;
}

export const CODEX_SHIM_AUTO_RESTORE_ENV = "CODEXCOMMANDER_CODEX_SHIM_AUTO_RESTORE";

export function codexShimAutoRestoreEnabled(
  config: Pick<CodexCommanderConfig, "codexShimAutoRestore">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return config.codexShimAutoRestore !== false && env[CODEX_SHIM_AUTO_RESTORE_ENV] !== "0";
}

export function multiAgentGuidanceEnabled(
  config: Pick<CodexCommanderConfig, "multiAgentGuidanceEnabled">,
): boolean {
  return config.multiAgentGuidanceEnabled;
}

export function getDefaultConfig(): CodexCommanderConfig {
  // Fresh-install default: works out of the box with Codex's ChatGPT OAuth (no API key).
  // gpt-* requests forward the caller's incoming OAuth headers to the ChatGPT backend.
  // Adding extra providers (e.g. opencode-go) and switching defaultProvider is a user/runtime choice.
  return {
    port: 10100,
    managementUsageMaxReadBytes: 64 * 1024 * 1024,
    appOwnedMemoryBudgetMb: DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES / (1024 * 1024),
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    subagentModels: DEFAULT_SUBAGENT_MODELS.map(model => ({ model })),
    multiAgentGuidanceEnabled: true,
    websockets: false,
    codexAutoStart: true,
    codexShimAutoRestore: true,
  };
}

export function resolveEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) return process.env[match[1]];
  if (value.startsWith("$")) return process.env[value.slice(1)];
  return value;
}

/**
 * Mirror `config.proxy` into HTTP(S)_PROXY env vars so Bun's native fetch routes every outbound
 * provider call through the proxy — no per-callsite changes (verified: Bun honors these plus
 * NO_PROXY). User-set env vars always win; localhost/127.0.0.1 are appended to NO_PROXY so the
 * CLI's own health checks and running-proxy API calls stay direct. Call once per process entry
 * that makes outbound provider requests (server start, catalog sync).
 */
export function applyProxyEnv(config: CodexCommanderConfig): void {
  const proxy = resolveEnvValue(config.proxy);
  if (!proxy) return;
  if (!process.env.HTTP_PROXY?.trim() && !process.env.http_proxy?.trim()) process.env.HTTP_PROXY = proxy;
  if (!process.env.HTTPS_PROXY?.trim() && !process.env.https_proxy?.trim()) process.env.HTTPS_PROXY = proxy;
  const existing = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const entries = existing.split(",").map(s => s.trim()).filter(Boolean);
  const seen = new Set(entries.map(e => e.toLowerCase()));
  for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
    if (!seen.has(host)) {
      entries.push(host);
      seen.add(host);
    }
  }
  process.env.NO_PROXY = entries.join(",");
}

export function writePid(pid: number): void {
  const dir = getConfigDir();
  // Guard before ANY directory mutation (mkdir or chmod), not just the write.
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    hardenConfigDir();
  }
  atomicWriteFile(getPidPath(), String(pid));
}

export type RuntimePortState = {
  schemaVersion: 1;
  pid: number;
  port: number;
  hostname?: string;
  /** Per-process proof key; protected by the config directory and never served. */
  attestationSecret?: string;
  /** Current runtimes require metadata-bound v2 health attestation. */
  attestationProtocol?: 2;
};

export type RuntimePortWriteState = Omit<RuntimePortState, "schemaVersion">;

function isValidRuntimePortState(value: unknown): value is RuntimePortState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const allowedKeys = new Set(["schemaVersion", "pid", "port", "hostname", "attestationSecret", "attestationProtocol"]);
  if (Object.keys(state).some(key => !allowedKeys.has(key))) return false;
  const hostnameOk = state.hostname === undefined || typeof state.hostname === "string";
  const attestationOk = state.attestationSecret === undefined || isLocalAttestationSecret(state.attestationSecret);
  const protocolOk = state.attestationProtocol === undefined || state.attestationProtocol === 2;
  return state.schemaVersion === 1
    && Number.isSafeInteger(state.pid)
    && Number(state.pid) > 0
    && Number.isInteger(state.port)
    && Number(state.port) > 0
    && Number(state.port) <= 65535
    && hostnameOk
    && attestationOk
    && protocolOk;
}

export function writeRuntimePort(state: RuntimePortWriteState): void {
  const persisted: RuntimePortState = {
    schemaVersion: 1,
    pid: state.pid,
    port: state.port,
    ...(state.hostname !== undefined ? { hostname: state.hostname } : {}),
    ...(state.attestationSecret !== undefined ? { attestationSecret: state.attestationSecret } : {}),
    ...(state.attestationProtocol !== undefined ? { attestationProtocol: state.attestationProtocol } : {}),
  };
  if (!isValidRuntimePortState(persisted)) throw new Error("Invalid runtime port state");
  const dir = getConfigDir();
  // Guard before ANY directory mutation (mkdir or chmod), not just the write.
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    hardenConfigDir();
  }
  atomicWriteFile(getRuntimePortPath(), JSON.stringify(persisted, null, 2) + "\n");
}

export function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parsePidFile(raw);
    if (pid === null) return null;
    try {
      process.kill(pid, 0);
      return isLikelyCodexCommanderStartProcess(pid) ? pid : null;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        return isLikelyCodexCommanderStartProcess(pid) ? pid : null;
      }
      return null;
    }
  } catch {
    return null;
  }
}

export function readRuntimePort(expectedPid?: number): RuntimePortState | null {
  try {
    const parsed = JSON.parse(readFileSync(getRuntimePortPath(), "utf-8"));
    if (!isValidRuntimePortState(parsed)) return null;
    if (expectedPid !== undefined && parsed.pid !== expectedPid) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function removePid(expectedPid?: number): void {
  if (expectedPid !== undefined && readPidFileValue() !== expectedPid) return;
  try { unlinkSync(getPidPath()); } catch { /* ignore */ }
}

export function readPidFileValue(): number | null {
  try {
    return parsePidFile(readFileSync(getPidPath(), "utf-8"));
  } catch {
    return null;
  }
}

export function removeRuntimePort(expectedPid?: number): void {
  if (expectedPid !== undefined && readRuntimePort(expectedPid) === null) return;
  try {
    unlinkSync(getRuntimePortPath());
  } catch { /* ignore */ }
}

/**
 * Snapshot-guarded stale-state purge: remove the pid/runtime files only when their content
 * still matches what the caller saw BEFORE its liveness probe. A concurrent `ccx start` can
 * write fresh records mid-probe; an unconditional purge would erase the new proxy's state.
 */
export function removePidIfValueIs(snapshot: number | null): void {
  const path = getPidPath();
  if (!existsSync(path)) return;
  if (readPidFileValue() !== snapshot) return;
  try {
    unlinkSync(path);
  } catch { /* ignore */ }
}

export function removeRuntimePortIfPidIs(snapshotPid: number | null): void {
  const current = readRuntimePort();
  if ((current?.pid ?? null) !== snapshotPid) return;
  try {
    unlinkSync(getRuntimePortPath());
  } catch { /* ignore */ }
}

export function parsePidFile(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isCodexCommanderStartCommandLine(commandLine: string): boolean {
  const normalized = commandLine.toLowerCase().replace(/\\/g, "/");
  const hasCodexCommanderEntrypoint = normalized.includes("src/cli/index.ts")
    || /(?:^|[\s/"'])codexcommander(?:\.cmd|\.exe)?(?:$|[\s"'])/.test(normalized)
    || /(?:^|[\s/"'])ccx(?:\.cmd)?(?:$|[\s"'])/.test(normalized);
  return hasCodexCommanderEntrypoint && /(?:^|[\s"'])start(?:$|[\s"'])/.test(normalized);
}

/** Per-process memo: waitForProxy/findLiveProxy used to spawn powershell on every 150ms poll. */
const codexCommanderStartProcessCache = new Map<number, boolean>();
let codexCommanderStartProcessSweepCursor = 0;
let codexCommanderStartProcessProbe: (pid: number) => void = pid => { process.kill(pid, 0); };

export function setCodexCommanderStartProcessProbeForTests(probe: ((pid: number) => void) | null): void {
  codexCommanderStartProcessProbe = probe ?? (pid => { process.kill(pid, 0); });
}

export function setCodexCommanderStartProcessCacheForTests(entries: Iterable<readonly [number, boolean]>): void {
  codexCommanderStartProcessCache.clear();
  for (const [pid, value] of entries) codexCommanderStartProcessCache.set(pid, value);
  codexCommanderStartProcessSweepCursor = 0;
}

export function sweepDeadCodexCommanderStartProcessCache(maxProbes = 64): number {
  const pids: number[] = [];
  let removed = 0;
  for (const pid of codexCommanderStartProcessCache.keys()) {
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
    else if (codexCommanderStartProcessCache.delete(pid)) removed += 1;
  }
  if (pids.length === 0 || maxProbes <= 0) {
    codexCommanderStartProcessSweepCursor = 0;
    return removed;
  }
  const probeCount = Math.min(Math.floor(maxProbes), pids.length);
  const start = codexCommanderStartProcessSweepCursor % pids.length;
  for (let offset = 0; offset < probeCount; offset += 1) {
    const pid = pids[(start + offset) % pids.length]!;
    try {
      codexCommanderStartProcessProbe(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      if (codexCommanderStartProcessCache.delete(pid)) removed += 1;
    }
  }
  codexCommanderStartProcessSweepCursor = (start + probeCount) % pids.length;
  return removed;
}

export function codexCommanderStartProcessCacheSizeForTests(): number {
  return codexCommanderStartProcessCache.size;
}

function isLikelyCodexCommanderStartProcess(pid: number): boolean {
  const cached = codexCommanderStartProcessCache.get(pid);
  if (cached !== undefined) return cached;
  const commandLine = readProcessCommandLine(pid);
  if (commandLine === undefined) return false;
  const ok = isCodexCommanderStartCommandLine(commandLine);
  codexCommanderStartProcessCache.set(pid, ok);
  return ok;
}

/**
 * Alive pid from the pid file without the expensive Windows command-line probe.
 * Safe for liveness polls: callers still identity-check /healthz before trusting the proxy.
 * Destructive stop/kill paths should keep using {@link readPid}, which verifies the cmdline.
 */
export function readAlivePid(): number | null {
  const pid = readPidFileValue();
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return pid;
    return null;
  }
}

/**
 * Full identity check of a KNOWN candidate pid (alive + CodexCommander start command line).
 * Companion to {@link readAlivePid}: liveness discovery may be cheap, but any pid
 * handed to a destructive caller must pass this check — and must equal the candidate
 * it was asked about, so a pidfile rewrite between discovery and verification can
 * never swap in a different process (TOCTOU guard).
 */
export function verifyPidIdentity(candidatePid: number): number | null {
  try {
    process.kill(candidatePid, 0);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  return isLikelyCodexCommanderStartProcess(candidatePid) ? candidatePid : null;
}

function readProcessCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      // Prefer WMIC over PowerShell: much faster cold start, and windowsHide avoids console flash.
      // Fall back to PowerShell when WMIC is absent (newer Windows images).
      const wmic = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\wbem\\WMIC.exe`;
      try {
        const output = execFileSync(wmic, [
          "process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/VALUE",
        ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
        const match = /^CommandLine=(.*)$/m.exec(output.replace(/\r/g, ""));
        const value = match?.[1]?.trim();
        if (value) return value;
      } catch {
        /* WMIC missing or failed — fall through */
      }
      const output = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NoLogo",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
      return output.trim() || undefined;
    }
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
      windowsHide: true,
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function backupInvalidConfig(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  const backupPath = `${configPath}.invalid-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    copyFileSync(configPath, backupPath);
    try { chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
    return backupPath;
  } catch {
    return null;
  }
}

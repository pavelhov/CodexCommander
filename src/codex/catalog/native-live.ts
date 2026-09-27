/** Account-scoped Codex native model discovery, independent of CCX's active catalog. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfigDir } from "../../config";
import { readCodexTokensResult } from "../auth-collision";
import { canonicalCodexHomeDir } from "../home";
import { resetPublishedNativeCatalogMemoForTests } from "./published-native";
import { nativeDiscoveryLogsSuppressed } from "./native-discovery-log";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { withNativeMainSharedClaim } from "../native-main-claim";
import { resolveNativeProfileContext } from "../native-profile-store";
import { isNativeMainTrafficBlocked } from "../native-profile-startup";
import { getCodexHome } from "../paths";
import { loadPersistedCodexRuntime, resolveAndPersistCodexRuntime, type ResolvedCodexRuntime } from "../runtime";
import type { RawCatalog, RawEntry } from "./parsing";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 256;
const SNAPSHOT_VERSION = 1;
const REFRESH_TTL_MS = 5 * 60_000;

export interface NativeLiveCatalogStatus {
  readonly source: "live" | "retained" | "unavailable";
  readonly catalog: Readonly<RawCatalog> | null;
  readonly fetchedAt: string | null;
  /** Opaque identity of the current account, Codex home, and selected runtime. */
  readonly identity: string | null;
  readonly reason?: "auth" | "credentials" | "runtime" | "network" | "response" | "snapshot" | "disk" | "busy";
}

export interface NativeLiveCatalogOptions {
  readonly fetch?: typeof fetch;
  readonly token?: { accessToken: string; chatgptAccountId: string } | null | (() => { accessToken: string; chatgptAccountId: string } | null);
  readonly runtime?: Pick<ResolvedCodexRuntime, "command" | "version"> | (() => Pick<ResolvedCodexRuntime, "command" | "version">);
  readonly codexHome?: string;
  readonly configDir?: string;
  readonly now?: () => number;
  /** Bypass the freshness window; an already-running request for this identity is still shared. */
  readonly force?: boolean;
}

interface RefreshMemo {
  identity: string;
  expiresAt: number;
  result?: NativeLiveCatalogStatus;
  flight?: Promise<NativeLiveCatalogStatus>;
}

let refreshMemo: RefreshMemo | null = null;
let snapshotMemo: { identity: string; stamp: string; result: NativeLiveCatalogStatus | null } | null = null;
let admittedPeek: { identity: string; configDir: string; home: string; authStamp: string; runtimeCommand: string; runtimeVersion: string; unpersisted: boolean } | null = null;
let pendingUnpersistedRuntime: Pick<ResolvedCodexRuntime, "command" | "version"> | null = null;
let ephemeralCatalog: NativeLiveCatalogStatus | null = null;
/** Credential-free projection of the most recent refresh outcome, for status surfaces. */
let lastRefreshOutcome: NativeDiscoveryStatus | null = null;
let refreshSequence = 0;
let recordedSequence = 0;
let warnedFailureReason: NativeLiveCatalogStatus["reason"] | null = null;

function warnFailure(reason: NativeLiveCatalogStatus["reason"]): void {
  if (nativeDiscoveryLogsSuppressed()) return;
  if (!reason || warnedFailureReason === reason) return;
  warnedFailureReason = reason;
  console.warn(`[codexcommander] native model discovery degraded (reason=${reason})`);
}

export interface NativeDiscoveryStatus {
  readonly source: NativeLiveCatalogStatus["source"];
  readonly reason: NativeLiveCatalogStatus["reason"] | null;
  readonly fetchedAt: string | null;
}

/** Last refresh outcome (source/reason/fetchedAt only); never identity, tokens, or paths. */
export function lastNativeDiscoveryStatus(): NativeDiscoveryStatus | null {
  return lastRefreshOutcome;
}

function rememberOutcome(result: NativeLiveCatalogStatus, sequence: number): NativeLiveCatalogStatus {
  if (sequence >= recordedSequence) {
    if (result.source === "live" && !result.reason) warnedFailureReason = null;
    recordedSequence = sequence;
    lastRefreshOutcome = Object.freeze({ source: result.source, reason: result.reason ?? null, fetchedAt: result.fetchedAt });
  }
  return result;
}

/** Test seam: forget process-local discovery memos. */
export function resetNativeLiveCatalogStateForTests(): void {
  refreshMemo = null;
  snapshotMemo = null;
  admittedPeek = null;
  pendingUnpersistedRuntime = null;
  ephemeralCatalog = null;
  lastRefreshOutcome = null;
  refreshSequence = 0;
  recordedSequence = 0;
  warnedFailureReason = null;
  resetPublishedNativeCatalogMemoForTests();
}

function authFingerprint(home: string): string | null {
  try {
    const stat = statSync(join(home, "auth.json"));
    if (!stat.isFile()) return null;
    // Auth hardening may chmod the file during an ordinary request, advancing
    // ctime without changing credentials. Inode, size, and mtime still fence
    // replacements and content writes without opening the credential file.
    return `${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}`;
  } catch { return null; }
}

function unavailable(reason: NativeLiveCatalogStatus["reason"]): NativeLiveCatalogStatus {
  return immutable({ source: "unavailable", catalog: null, fetchedAt: null, identity: null, reason });
}

interface IdentityContext {
  token: { accessToken: string; chatgptAccountId: string };
  runtime: Pick<ResolvedCodexRuntime, "command" | "version">;
  identity: string;
  configDir: string;
  unpersistedRuntime: boolean;
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

type ContextResult =
  | { readonly ok: true; readonly ctx: IdentityContext }
  | { readonly ok: false; readonly reason: "auth" | "credentials" | "runtime" };

const RUNTIME_VERSION = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;

function usableVersion(runtime: Pick<ResolvedCodexRuntime, "command" | "version"> | undefined | null): boolean {
  return Boolean(runtime?.version && RUNTIME_VERSION.test(runtime.version));
}

function context(options: NativeLiveCatalogOptions, probeRuntime: boolean): ContextResult {
  const home = canonicalCodexHomeDir(options.codexHome ?? getCodexHome());
  const tokenRead = options.token === undefined ? readCodexTokensResult(home) : null;
  const token = options.token === undefined
    ? tokenRead?.status === "ok" ? {
      accessToken: tokenRead.tokens.access_token,
      chatgptAccountId: tokenRead.tokens.account_id,
    } : null
    : typeof options.token === "function" ? options.token() : options.token;
  if (tokenRead && (tokenRead.status === "invalid" || tokenRead.status === "unreadable")) return { ok: false, reason: "credentials" };
  if (!token?.accessToken || !token.chatgptAccountId) return { ok: false, reason: "auth" };
  let runtime = typeof options.runtime === "function" ? options.runtime() : options.runtime;
  let unpersistedRuntime = false;
  if (!runtime && probeRuntime) {
    const selection = resolveAndPersistCodexRuntime({ discoverAlternatives: false });
    runtime = selection.runtime;
    unpersistedRuntime = Boolean(selection.persistError && usableVersion(runtime));
    pendingUnpersistedRuntime = unpersistedRuntime ? runtime! : null;
    if (selection.persistError) warnFailure("disk");
  }
  if (!runtime && !probeRuntime && (pendingUnpersistedRuntime || admittedPeek?.unpersisted)) {
    runtime = pendingUnpersistedRuntime ?? { command: admittedPeek!.runtimeCommand, version: admittedPeek!.runtimeVersion };
    unpersistedRuntime = true;
  }
  // A failed probe yields a truthy `{ version: null }` fallback. The fetch needs only a
  // client_version, and the persisted selection keeps the identity equal to the one used
  // by non-probing reads and by the retained snapshot.
  if (!usableVersion(runtime)) {
    const persisted = loadPersistedCodexRuntime({ configDir: options.configDir });
    // A new explicit runtime path cannot safely consume the previous selection's snapshot.
    const selectedPath = process.env.CODEX_CLI_PATH?.trim();
    if (persisted && !(selectedPath && selectedPath !== persisted.command)) {
      runtime = { command: persisted.command, version: persisted.selectedVersion };
    }
  }
  if (!runtime || !usableVersion(runtime)) return { ok: false, reason: "runtime" };
  const configDir = resolve(options.configDir ?? getConfigDir());
  const identity = createHash("sha256")
    .update(JSON.stringify([token.chatgptAccountId, home, runtime.command, runtime.version]))
    .digest("hex");
  return { ok: true, ctx: { token, runtime, identity, configDir, unpersistedRuntime } };
}

function contextIdentity(options: NativeLiveCatalogOptions): string | null {
  const result = context(options, false);
  return result.ok ? result.ctx.identity : null;
}

/** Current non-probing identity used to validate legacy retained snapshots. */
export function currentNativeLiveIdentity(options: NativeLiveCatalogOptions = {}): string | null {
  return contextIdentity(options);
}

/** Fixed snapshot path; the file itself is checked against the current identity on every read. */
export function nativeLiveCatalogSnapshotPath(configDir = getConfigDir()): string {
  return join(configDir, "codex-native-live-retained.json");
}

function writeSnapshot(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* Rename already consumed it. */ }
  }
}

function validCatalog(value: unknown): RawCatalog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.models) || data.models.length === 0 || data.models.length > MAX_MODELS) return null;
  const seen = new Set<string>();
  for (const row of data.models) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const entry = row as RawEntry;
    const slug = entry.slug;
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(slug)
      || slug.startsWith("codexcommander") || seen.has(slug)) return null;
    // A genuine Codex native row supplies a display name and reasoning ladder.
    if (typeof entry.display_name !== "string" || !entry.display_name
      || !Array.isArray(entry.supported_reasoning_levels)) return null;
    seen.add(slug);
  }
  return { models: data.models as RawEntry[] };
}

function readSnapshot(ctx: Pick<IdentityContext, "identity" | "configDir">): NativeLiveCatalogStatus | null {
  try {
    const path = nativeLiveCatalogSnapshotPath(ctx.configDir);
    const stat = statSync(path);
    if (stat.size > MAX_BODY_BYTES) return null;
    const stamp = `${path}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
    if (snapshotMemo?.identity === ctx.identity && snapshotMemo.stamp === stamp) return snapshotMemo.result;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.version !== SNAPSHOT_VERSION || raw.identity !== ctx.identity
      || typeof raw.fetchedAt !== "string" || !Number.isFinite(Date.parse(raw.fetchedAt))) return null;
    const catalog = validCatalog(raw.catalog);
    if (!catalog) return null;
    const result: NativeLiveCatalogStatus = immutable({ source: "retained", catalog, fetchedAt: raw.fetchedAt, identity: ctx.identity });
    snapshotMemo = { identity: ctx.identity, stamp, result };
    return result;
  } catch {
    return null;
  }
}

/** Read only an account/runtime/home-matching last-good native snapshot. */
export function peekNativeLiveCatalog(options: NativeLiveCatalogOptions = {}): NativeLiveCatalogStatus {
  let ctx: Pick<IdentityContext, "identity" | "configDir"> | null;
  if (options.token !== undefined) {
    const result = context(options, false);
    if (!result.ok) return unavailable(result.reason);
    ctx = result.ctx;
  } else {
    if (isNativeMainTrafficBlocked()) return unavailable("busy");
    if (!admittedPeek) return unavailable("snapshot");
    const home = canonicalCodexHomeDir(options.codexHome ?? getCodexHome());
    const configDir = resolve(options.configDir ?? getConfigDir());
    const selected = loadPersistedCodexRuntime({ configDir });
    const explicitCommand = process.env.CODEX_CLI_PATH?.trim();
    const fingerprint = authFingerprint(home);
    if (home !== admittedPeek.home || configDir !== admittedPeek.configDir
      || !fingerprint || fingerprint !== admittedPeek.authStamp
      || (!admittedPeek.unpersisted && selected?.command !== admittedPeek.runtimeCommand)
      || (!admittedPeek.unpersisted && selected?.selectedVersion !== admittedPeek.runtimeVersion)
      || (explicitCommand && explicitCommand !== admittedPeek.runtimeCommand)) return unavailable("snapshot");
    ctx = { identity: admittedPeek.identity, configDir };
  }
  return (ephemeralCatalog?.identity === ctx.identity ? ephemeralCatalog : null)
    ?? readSnapshot(ctx)
    ?? immutable({ source: "unavailable", catalog: null, fetchedAt: null, identity: ctx.identity, reason: "snapshot" });
}

async function readResponseBounded(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_BODY_BYTES) throw new Error("oversized");
  if (!response.body) throw new Error("empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("oversized");
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Fetch Codex's native account catalog directly, then atomically retain the last good result. */
export async function refreshNativeLiveCatalog(options: NativeLiveCatalogOptions = {}): Promise<NativeLiveCatalogStatus> {
  const sequence = ++refreshSequence;
  // Production credential reads and the whole network request participate in the
  // native-main profile switch drain. Injected credentials are isolated test seams.
  if (options.token === undefined) {
    const lease = tryAcquireNativeMainProfileClaim();
    if (!lease) return rememberOutcome(unavailable("busy"), sequence);
    let admitted = false;
    try {
      return rememberOutcome(await withNativeMainSharedClaim(resolveNativeProfileContext(), async () => {
        admitted = true;
        const result = await refreshNativeLiveCatalogAdmitted(options);
        if (result.identity && result.source !== "unavailable"
          && contextIdentity(options) === result.identity) {
          const home = canonicalCodexHomeDir(options.codexHome ?? getCodexHome());
          const configDir = resolve(options.configDir ?? getConfigDir());
          const resolved = context(options, false);
          const authStamp = authFingerprint(home);
          if (resolved.ok && authStamp) admittedPeek = {
            identity: result.identity,
            configDir,
            home,
            authStamp,
            runtimeCommand: resolved.ctx.runtime.command,
            runtimeVersion: resolved.ctx.runtime.version!,
            unpersisted: resolved.ctx.unpersistedRuntime,
          };
        }
        return result;
      }), sequence);
    } catch {
      // Only a denied/draining shared claim is contention. A failure after
      // admission (probe, credential read, snapshot write) is a local runtime
      // problem and must not masquerade as a transient busy state.
      if (admitted) warnFailure("runtime");
      return rememberOutcome(unavailable(admitted ? "runtime" : "busy"), sequence);
    } finally {
      lease.release();
    }
  }
  try {
    return rememberOutcome(await refreshNativeLiveCatalogAdmitted(options), sequence);
  } catch {
    warnFailure("runtime");
    return rememberOutcome(unavailable("runtime"), sequence);
  }
}

async function refreshNativeLiveCatalogAdmitted(options: NativeLiveCatalogOptions): Promise<NativeLiveCatalogStatus> {
  const resolved = context(options, true);
  if (!resolved.ok) return unavailable(resolved.reason);
  const ctx = resolved.ctx;
  const now = (options.now ?? Date.now)();
  const memo = refreshMemo?.identity === ctx.identity ? refreshMemo : null;
  if (memo?.flight) return memo.flight;
  if (!options.force && memo?.result?.source === "live" && now < memo.expiresAt) return memo.result;
  const nextMemo: RefreshMemo = { identity: ctx.identity, expiresAt: 0 };
  refreshMemo = nextMemo;
  const flight = refreshNativeLiveCatalogUncached(ctx, options);
  nextMemo.flight = flight;
  try {
    const result = await flight;
    if (refreshMemo === nextMemo) {
      nextMemo.result = result;
      nextMemo.expiresAt = result.source === "live" && result.reason !== "disk"
        ? (options.now ?? Date.now)() + REFRESH_TTL_MS : 0;
    }
    return result;
  } finally {
    if (refreshMemo === nextMemo) nextMemo.flight = undefined;
  }
}

async function refreshNativeLiveCatalogUncached(
  ctx: IdentityContext,
  options: NativeLiveCatalogOptions,
): Promise<NativeLiveCatalogStatus> {
  const retained = readSnapshot(ctx);
  let reason: NativeLiveCatalogStatus["reason"] = "network";
  try {
    const url = new URL("https://chatgpt.com/backend-api/codex/models");
    url.searchParams.set("client_version", ctx.runtime.version!);
    const response = await (options.fetch ?? fetch)(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ctx.token.accessToken}`,
        "ChatGPT-Account-Id": ctx.token.chatgptAccountId,
        originator: "Codex Desktop",
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      reason = "response";
      throw new Error("bad response");
    }
    reason = "response";
    const catalog = validCatalog(await readResponseBounded(response));
    if (!catalog) { reason = "response"; throw new Error("invalid catalog"); }
    // The network request may outlive a main-login or selected-runtime switch.
    // Never publish its rows into the new identity's durable snapshot.
    const current = context(options, false);
    if (!current.ok || current.ctx.identity !== ctx.identity
      || current.ctx.token.accessToken !== ctx.token.accessToken
      || (ctx.unpersistedRuntime && process.env.CODEX_CLI_PATH?.trim()
        && process.env.CODEX_CLI_PATH.trim() !== ctx.runtime.command)) {
      warnFailure("snapshot");
      // The old identity's retained snapshot cannot be offered to the new
      // account or runtime merely because it matched when this flight began.
      return immutable({ source: "unavailable", catalog: null, fetchedAt: null, identity: ctx.identity, reason: "snapshot" });
    }
    const fetchedAt = new Date((options.now ?? Date.now)()).toISOString();
    const path = nativeLiveCatalogSnapshotPath(ctx.configDir);
    try {
      if (!existsSync(ctx.configDir)) mkdirSync(ctx.configDir, { recursive: true, mode: 0o700 });
      writeSnapshot(path, `${JSON.stringify({ version: SNAPSHOT_VERSION, identity: ctx.identity, fetchedAt, catalog })}\n`);
      snapshotMemo = null;
      try { chmodSync(path, 0o600); } catch { /* Atomic writer hardens on supported platforms. */ }
    } catch {
      warnFailure("disk");
      ephemeralCatalog = immutable({ source: "live", catalog, fetchedAt, identity: ctx.identity, reason: "disk" });
      return ephemeralCatalog;
    }
    ephemeralCatalog = null;
    return immutable({ source: "live", catalog, fetchedAt, identity: ctx.identity });
  } catch {
    warnFailure(reason);
    return retained
      ? immutable({ ...retained, reason })
      : immutable({ source: "unavailable", catalog: null, fetchedAt: null, identity: ctx.identity, reason });
  }
}

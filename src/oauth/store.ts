/**
 * OAuth token store at ~/.codexcommander/auth.json, keyed by provider name.
 *
 * Multiauth shape (260706): each provider value is a ProviderAccountSet
 * `{ activeAccountId, accounts: [{ id, credential, needsReauth?, addedAt? }] }`.
 * Exceptions:
 * - `chatgpt` stays single-slot (always replaced): codex-auth-api uses it as a scratch slot
 *   for Codex pool logins, which have their own ledger (codex-accounts.json).
 * - Credentials without identity (no accountId/email) replace the active slot
 *   instead of appending: their refresh tokens rotate, so a derived id would duplicate the
 *   same human on every re-login. Kimi extracts JWT `user_id`/`sub` as accountId; Cursor
 *   extracts JWT `sub` — both append distinct accounts under multiauth.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, atomicWriteFile, backupInvalidConfig, hardenConfigDir, hardenExistingSecret } from "../config";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { MAX_PENDING_OAUTH_MUTATIONS } from "../lib/translator-budget";
import {
  captureConfigGeneration,
  type GenerationContext,
} from "../lib/state-store-sweeper";
import { validateCopilotApiBaseUrl } from "./github-copilot";
import type { OAuthCredentialSource, OAuthCredentials, ProviderAccount, ProviderAccountSet } from "./types";

export type AuthStore = Record<string, ProviderAccountSet>;

export const AUTH_STORE_SCHEMA_VERSION = 1 as const;

interface PersistedAuthStore {
  readonly schemaVersion: typeof AUTH_STORE_SCHEMA_VERSION;
  readonly providers: AuthStore;
}

export type AuthStoreBufferSnapshot =
  | { readonly kind: "ready"; readonly store: AuthStore }
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" };

const authStoreDecoder = new TextDecoder("utf-8", { fatal: true });
let lastReconciledGeneration = 0;
let liveOAuthAccountKeys = new Set<string>();

function oauthAccountKey(provider: string, accountId: string): string {
  return `${provider}\0${accountId}`;
}

export function reconcileOAuthReauthState(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  liveOAuthAccountKeys = new Set(context.oauthAccountKeys);
  lastReconciledGeneration = context.generation;
  return 0;
}

/** Providers whose account set is pinned to a single slot (see module doc). */
const SINGLE_SLOT_PROVIDERS = new Set(["chatgpt"]);

export function getAuthStorePath(): string {
  return join(getConfigDir(), "auth.json");
}
export function getAuthStoreLockPath(): string { return join(getConfigDir(), "auth.store.lock"); }
export function getAuthRefreshIntentLockPath(provider: string, accountId: string): string {
  const safeProvider = provider.replace(/[^a-zA-Z0-9_-]/g, "_");
  const accountHash = createHash("sha256").update(accountId).digest("hex").slice(0, 24);
  return join(getConfigDir(), `auth.refresh.${safeProvider}.${accountHash}.lock`);
}
export function getAuthRefreshIntentPath(provider: string, accountId: string): string {
  return `${getAuthRefreshIntentLockPath(provider, accountId)}.json`;
}
export interface OAuthRefreshIntent { version: 1; provider: string; accountId: string; generation: string; createdAt: number; flightId: string; staleOwner?: true; uncertain?: true }
function parseOAuthRefreshIntent(
  provider: string,
  accountId: string,
  raw: string,
): OAuthRefreshIntent {
  const value = JSON.parse(raw) as Partial<OAuthRefreshIntent>;
  if (
    value.version !== 1
    || value.provider !== provider
    || value.accountId !== accountId
    || typeof value.generation !== "string"
    || typeof value.createdAt !== "number"
    || typeof value.flightId !== "string"
    || !value.flightId
    || (value.staleOwner !== undefined && value.staleOwner !== true)
  ) {
    return { version: 1, provider, accountId, generation: "", createdAt: 0, flightId: "", uncertain: true };
  }
  return value as OAuthRefreshIntent;
}

export function readOAuthRefreshIntent(provider: string, accountId: string): OAuthRefreshIntent | undefined {
  const path = getAuthRefreshIntentPath(provider, accountId);
  try {
    hardenConfigDir();
    hardenExistingSecret(path);
    return parseOAuthRefreshIntent(provider, accountId, readFileSync(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    return { version: 1, provider, accountId, generation: "", createdAt: 0, flightId: "", uncertain: true };
  }
}

/** Observe-only intent read for diagnostics: no chmod/ACL hardening. */
export function peekOAuthRefreshIntent(provider: string, accountId: string): OAuthRefreshIntent | undefined {
  const path = getAuthRefreshIntentPath(provider, accountId);
  try {
    return parseOAuthRefreshIntent(provider, accountId, readFileSync(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    return { version: 1, provider, accountId, generation: "", createdAt: 0, flightId: "", uncertain: true };
  }
}
export function writeOAuthRefreshIntent(provider: string, accountId: string, generation: string, createdAt = Date.now(), flightId: string): void {
  if (!flightId) throw new Error("OAuth refresh intent requires a flight id");
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  hardenConfigDir();
  const intent: OAuthRefreshIntent = { version: 1, provider, accountId, generation, createdAt, flightId };
  atomicWriteFile(getAuthRefreshIntentPath(provider, accountId), `${JSON.stringify(intent)}\n`);
}
export function markOAuthRefreshIntentStaleOwner(provider: string, accountId: string, generation: string, flightId: string): boolean {
  const current = readOAuthRefreshIntent(provider, accountId);
  if (current?.uncertain || current?.generation !== generation || current.flightId !== flightId) return false;
  atomicWriteFile(getAuthRefreshIntentPath(provider, accountId), `${JSON.stringify({ ...current, staleOwner: true })}\n`);
  return true;
}
export function clearOAuthRefreshIntent(provider: string, accountId: string, generation: string): boolean {
  const current = readOAuthRefreshIntent(provider, accountId);
  if (!current || current.generation !== generation) return false;
  try { unlinkSync(getAuthRefreshIntentPath(provider, accountId)); return true; }
  catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
}
export function credentialGeneration(cred: OAuthCredentials): string {
  return createHash("sha256").update(JSON.stringify([cred.refresh, cred.access, cred.expires])).digest("hex");
}

function loadAuthStoreInternal(): AuthStore {
  const path = getAuthStorePath();
  hardenConfigDir();
  hardenExistingSecret(path);
  if (!existsSync(path)) return {};
  try {
    const store = parsePersistedAuthStore(JSON.parse(readFileSync(path, "utf-8")));
    if (!store) throw new Error("invalid auth store schema");
    return store;
  } catch {
    backupInvalidConfig(path);
    return {};
  }
}

export function loadAuthStore(): AuthStore {
  return loadAuthStoreInternal();
}

/**
 * Pure normalization for auth-store bytes already read by another owner.
 * This function performs no filesystem consultation, hardening, backup, or persistence.
 */
export function normalizeAuthStoreBuffer(buffer: Uint8Array | null): AuthStoreBufferSnapshot {
  if (buffer === null) return { kind: "absent" };
  try {
    const parsed: unknown = JSON.parse(authStoreDecoder.decode(buffer));
    const store = parsePersistedAuthStore(parsed);
    if (!store) return { kind: "malformed" };
    return { kind: "ready", store };
  } catch {
    return { kind: "malformed" };
  }
}

/**
 * Observe-only auth store read for diagnostics (`ccx doctor` / status).
 * Does not chmod paths or backup invalid JSON — corrupt files are treated as empty.
 */
export function peekAuthStore(): AuthStore {
  const path = getAuthStorePath();
  if (!existsSync(path)) return {};
  const snapshot = normalizeAuthStoreBuffer(readFileSync(path));
  return snapshot.kind === "ready" ? snapshot.store : {};
}

function persist(store: AuthStore): void {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  hardenConfigDir();
  const persisted: PersistedAuthStore = {
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    providers: store,
  };
  if (!parsePersistedAuthStore(persisted)) {
    throw new Error("Refusing to persist an invalid OAuth credential store");
  }
  atomicWriteFile(getAuthStorePath(), JSON.stringify(persisted, null, 2) + "\n");
}

export class OAuthFileLockError extends Error { readonly code = "OAUTH_FILE_LOCK_UNAVAILABLE"; constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = "OAuthFileLockError"; } }
interface LockSnapshot { bytes: string; dev: number; ino: number; mtimeMs: number; size: number }
export interface OAuthFileLockOptions { path: string; waitTimeoutMs?: number; staleAfterMs?: number; pollMinMs?: number; pollMaxMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number; beforeStaleUnlink?: () => void; beforeReleaseUnlink?: () => void; beforeFailedCreateUnlink?: () => void; writeMetadata?: (fd: number, bytes: string) => void }
export interface OAuthFileLockGuard { readonly ownerId: string; release(): void }
function errorCode(error: unknown): string | undefined { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined; }
function snapshot(path: string): LockSnapshot { const bytes = readFileSync(path, "utf8"); const s = statSync(path); return { bytes, dev:s.dev, ino:s.ino, mtimeMs:s.mtimeMs, size:s.size }; }
function sameSnapshot(a: LockSnapshot,b: LockSnapshot): boolean { return a.bytes===b.bytes&&a.dev===b.dev&&a.ino===b.ino&&a.mtimeMs===b.mtimeMs&&a.size===b.size; }
function sameFd(a: LockSnapshot,b: ReturnType<typeof fstatSync>): boolean { return a.dev===b.dev&&a.ino===b.ino&&a.mtimeMs===b.mtimeMs&&a.size===b.size; }
export function createOAuthFileLock(options: OAuthFileLockOptions): { acquire(): Promise<OAuthFileLockGuard> } {
 const wait=options.waitTimeoutMs??5000, stale=options.staleAfterMs??120000, min=options.pollMinMs??25,max=options.pollMaxMs??100,sleep=options.sleep??(ms=>Bun.sleep(ms)),now=options.now??Date.now,random=options.random??Math.random,write=options.writeMetadata??((fd,b)=>writeFileSync(fd,b,"utf8"));
 if(wait<0||stale<=0||min<0||max<min) throw new OAuthFileLockError("Invalid OAuth file-lock timing options");
 return { async acquire() { hardenConfigDir(); recordOwnedConfigPath(getConfigDir(),options.path); if(!existsSync(getConfigDir())) mkdirSync(getConfigDir(),{recursive:true,mode:0o700}); const ownerId=randomUUID(),started=now(); for(;;){ let fd:number|undefined; try { fd=openSync(options.path,"wx",0o600); const bytes=`${JSON.stringify({version:1,ownerId,pid:process.pid,createdAt:now()})}\n`; write(fd,bytes); const fs=fstatSync(fd); closeSync(fd); fd=undefined; const owned=snapshot(options.path); if(owned.bytes!==bytes||!sameFd(owned,fs)) throw new OAuthFileLockError("OAuth lock changed during creation"); let released=false; return {ownerId,release(){if(released)return;released=true;try{const a=snapshot(options.path);if(!sameSnapshot(owned,a))return;options.beforeReleaseUnlink?.();const b=snapshot(options.path);if(sameSnapshot(owned,b))unlinkSync(options.path);}catch(e){if(errorCode(e)!=="ENOENT")console.warn(`[oauth] lock release failed: ${e instanceof Error?e.message:String(e)}`);}}}; } catch(e) { if(fd!==undefined){let fs;try{fs=fstatSync(fd);}catch{}try{closeSync(fd);}catch{}if(fs)try{const a=snapshot(options.path);if(sameFd(a,fs)){options.beforeFailedCreateUnlink?.();const b=snapshot(options.path);if(sameSnapshot(a,b)&&sameFd(b,fs))unlinkSync(options.path);}}catch{}} if(errorCode(e)!=="EEXIST")throw e instanceof OAuthFileLockError?e:new OAuthFileLockError("Could not create OAuth file lock",{cause:e}); }
 try{const a=snapshot(options.path);let created=a.mtimeMs;try{const p=JSON.parse(a.bytes);if(typeof p.createdAt==="number")created=Math.max(created,p.createdAt);}catch{}if(now()-created>stale){options.beforeStaleUnlink?.();const b=snapshot(options.path);if(sameSnapshot(a,b))unlinkSync(options.path);continue;}}catch(e){if(errorCode(e)==="ENOENT")continue;throw new OAuthFileLockError("Could not inspect OAuth file lock",{cause:e});} const elapsed=now()-started;if(elapsed>=wait)throw new OAuthFileLockError(`Timed out after ${wait}ms waiting for OAuth file lock`);await sleep(Math.min(wait-elapsed,min+Math.floor(random()*(max-min+1)))); } } };
}
/** Wait long enough for slow IdP refreshes (e.g. Cursor 15s × 3 attempts) before timing out. */
export const OAUTH_REFRESH_LOCK_WAIT_MS = 60_000;

export function createOAuthRefreshIntentLock(provider:string,accountId:string,overrides:Partial<OAuthFileLockOptions>={}) {
  return createOAuthFileLock({
    path: getAuthRefreshIntentLockPath(provider, accountId),
    staleAfterMs: 120000,
    waitTimeoutMs: OAUTH_REFRESH_LOCK_WAIT_MS,
    ...overrides,
  });
}

function isCredentialSource(value: unknown): value is OAuthCredentialSource {
  return value === "oauth" || value === "local-cli" || value === "credential-file" || value === "environment" || value === "manual";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parsePersistedKiroMetadata(value: unknown): OAuthCredentials["kiro"] | null {
  if (!isPlainRecord(value)) return null;
  const keys = ["profileArn", "ssoRegion", "apiRegion", "clientId", "clientSecret"] as const;
  if (!hasOnlyKeys(value, keys)) return null;
  const limits: Record<(typeof keys)[number], number> = {
    profileArn: 1024,
    ssoRegion: 64,
    apiRegion: 64,
    clientId: 4096,
    clientSecret: 4096,
  };
  const metadata: NonNullable<OAuthCredentials["kiro"]> = {};
  for (const key of keys) {
    const field = value[key];
    if (field === undefined) continue;
    if (
      typeof field !== "string"
      || field.length === 0
      || field.length > limits[key]
      || field.trim() !== field
      || /[\x00-\x1f\x7f]/.test(field)
    ) return null;
    metadata[key] = field;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function parsePersistedCredential(value: unknown): OAuthCredentials | null {
  if (!isPlainRecord(value)) return null;
  const allowed = ["access", "refresh", "expires", "email", "accountId", "source", "projectId", "apiBaseUrl", "kiro"];
  if (!hasOnlyKeys(value, allowed)) return null;
  if (typeof value.access !== "string" || typeof value.refresh !== "string" || !isFiniteNumber(value.expires)) return null;

  const credential: OAuthCredentials = {
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
  };
  for (const key of ["email", "accountId", "projectId"] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || field.length === 0) return null;
    credential[key] = field;
  }
  if (value.source !== undefined) {
    if (!isCredentialSource(value.source)) return null;
    credential.source = value.source;
  }
  if (value.apiBaseUrl !== undefined) {
    if (typeof value.apiBaseUrl !== "string") return null;
    const validated = validateCopilotApiBaseUrl(value.apiBaseUrl);
    if (!validated || validated !== value.apiBaseUrl) return null;
    credential.apiBaseUrl = validated;
  }
  if (value.kiro !== undefined) {
    const metadata = parsePersistedKiroMetadata(value.kiro);
    if (!metadata) return null;
    credential.kiro = metadata;
  }
  return credential;
}

function normalizeCredential(cred: unknown): OAuthCredentials | null {
  if (!cred || typeof cred !== "object") return null;
  const candidate = cred as Partial<OAuthCredentials>;
  if (typeof candidate.access !== "string" || typeof candidate.refresh !== "string" || !isFiniteNumber(candidate.expires)) {
    return null;
  }
  const normalized: OAuthCredentials = {
    access: candidate.access,
    refresh: candidate.refresh,
    expires: candidate.expires,
  };
  if (typeof candidate.email === "string" && candidate.email.length > 0) normalized.email = candidate.email;
  if (typeof candidate.accountId === "string" && candidate.accountId.length > 0) normalized.accountId = candidate.accountId;
  if (isCredentialSource(candidate.source)) normalized.source = candidate.source;
  if (typeof candidate.projectId === "string" && candidate.projectId.length > 0) normalized.projectId = candidate.projectId;
  if (typeof candidate.apiBaseUrl === "string" && candidate.apiBaseUrl.length > 0) {
    // Persist only allowlisted Copilot origins; drop anything else so auth.json cannot
    // become an SSRF springboard across reloads.
    const validated = validateCopilotApiBaseUrl(candidate.apiBaseUrl);
    if (validated) normalized.apiBaseUrl = validated;
  }
  if (candidate.kiro && typeof candidate.kiro === "object") {
    const kiro = candidate.kiro;
    const clean = (value: unknown, max: number): string | undefined => {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed && trimmed.length <= max && !/[\x00-\x1f\x7f]/.test(trimmed) ? trimmed : undefined;
    };
    const profileArn = clean(kiro.profileArn, 1024);
    const ssoRegion = clean(kiro.ssoRegion, 64);
    const apiRegion = clean(kiro.apiRegion, 64);
    const clientId = clean(kiro.clientId, 4096);
    const clientSecret = clean(kiro.clientSecret, 4096);
    if (profileArn || ssoRegion || apiRegion || clientId || clientSecret) {
      normalized.kiro = {
        ...(profileArn ? { profileArn } : {}),
        ...(ssoRegion ? { ssoRegion } : {}),
        ...(apiRegion ? { apiRegion } : {}),
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      };
    }
  }
  return normalized;
}

/**
 * Stable short account id. It must remain deterministic for a credential so repeated
 * saves bind the same account and refresh persistence cannot miss a rotated token.
 */
function newAccountId(cred: OAuthCredentials): string {
  const identity = cred.accountId ?? cred.email ?? cred.refresh;
  return createHash("sha256").update(identity).digest("hex").slice(0, 8);
}

function parsePersistedAccount(value: unknown): ProviderAccount | null {
  if (!isPlainRecord(value)) return null;
  if (!hasOnlyKeys(value, ["id", "alias", "credential", "needsReauth", "addedAt"])) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  const credential = parsePersistedCredential(value.credential);
  if (!credential) return null;
  const account: ProviderAccount = { id: value.id, credential };
  if (value.alias !== undefined) {
    if (typeof value.alias !== "string" || !value.alias || value.alias.trim() !== value.alias) return null;
    account.alias = value.alias;
  }
  if (value.needsReauth !== undefined) {
    if (value.needsReauth !== true) return null;
    account.needsReauth = true;
  }
  if (value.addedAt !== undefined) {
    if (!isFiniteNumber(value.addedAt)) return null;
    account.addedAt = value.addedAt;
  }
  return account;
}

function parsePersistedAccountSet(raw: unknown): ProviderAccountSet | null {
  if (!isPlainRecord(raw) || !hasOnlyKeys(raw, ["activeAccountId", "accounts"])) return null;
  if (typeof raw.activeAccountId !== "string" || raw.activeAccountId.length === 0 || !Array.isArray(raw.accounts) || raw.accounts.length === 0) {
    return null;
  }
  const accounts: ProviderAccount[] = [];
  const ids = new Set<string>();
  for (const value of raw.accounts) {
    const account = parsePersistedAccount(value);
    if (!account || ids.has(account.id)) return null;
    ids.add(account.id);
    accounts.push(account);
  }
  if (!ids.has(raw.activeAccountId)) return null;
  return { activeAccountId: raw.activeAccountId, accounts };
}

function parsePersistedAuthStore(raw: unknown): AuthStore | null {
  if (!isPlainRecord(raw) || !hasOnlyKeys(raw, ["schemaVersion", "providers"])) return null;
  if (raw.schemaVersion !== AUTH_STORE_SCHEMA_VERSION || !isPlainRecord(raw.providers)) return null;
  const normalized: AuthStore = {};
  for (const [provider, value] of Object.entries(raw.providers)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider)) return null;
    const set = parsePersistedAccountSet(value);
    if (!set) return null;
    normalized[provider] = set;
  }
  return normalized;
}

/**
 * In-process write serialization: every mutation runs load-modify-persist under this queue so
 * a guardian refresh persisting a non-active account cannot roll back a concurrent
 * active-account switch (lost update). Cross-process races are accepted (single proxy).
 */
const OAUTH_MUTATION_WAIT_MS = 30_000;
const oauthMutationEncoder = new TextEncoder();
let mutationTail: Promise<void> = Promise.resolve();
let pendingMutations = 0;
let mutationCurrentBytes = 0;
let mutationHighWaterBytes = 0;
interface QueuedOAuthMutation {
  started: boolean;
  settled: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  run(): Promise<void>;
}
const mutationWaiters: QueuedOAuthMutation[] = [];
let mutationRunning = false;

export class OAuthMutationBusyError extends Error {
  readonly code = "oauth_mutation_busy";
  constructor(message = "OAuth mutation queue is busy") {
    super(message);
    this.name = "OAuthMutationBusyError";
  }
}

export function oauthMutationTailSnapshot(): { currentBytes: number; highWaterBytes: number; active: number } {
  return { currentBytes: mutationCurrentBytes, highWaterBytes: mutationHighWaterBytes, active: pendingMutations };
}

function retainedClosureStringBytes(values: readonly unknown[]): number {
  const visit = (value: unknown): number => {
    if (typeof value === "string") return oauthMutationEncoder.encode(value).byteLength;
    if (Array.isArray(value)) return value.reduce((sum, entry) => sum + visit(entry), 0);
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>)
        .reduce((sum, [key, entry]) => sum + oauthMutationEncoder.encode(key).byteLength + visit(entry), 0);
    }
    return 0;
  };
  return values.reduce<number>((sum, value) => sum + visit(value), 0);
}

function drainOAuthMutations(): void {
  if (mutationRunning) return;
  const next = mutationWaiters.shift();
  if (!next) return;
  if (next.settled) {
    drainOAuthMutations();
    return;
  }
  next.started = true;
  if (next.timeout) clearTimeout(next.timeout);
  mutationRunning = true;
  mutationTail = next.run().finally(() => {
    mutationRunning = false;
    drainOAuthMutations();
  });
}

function serializeMutation<T>(work: () => Promise<T>, retainedValues: readonly unknown[], waitMs = OAUTH_MUTATION_WAIT_MS): Promise<T> {
  if (pendingMutations >= MAX_PENDING_OAUTH_MUTATIONS) return Promise.reject(new OAuthMutationBusyError());
  pendingMutations += 1;
  const retainedBytes = retainedClosureStringBytes(retainedValues);
  mutationCurrentBytes += retainedBytes;
  mutationHighWaterBytes = Math.max(mutationHighWaterBytes, mutationCurrentBytes);

  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const entry: QueuedOAuthMutation = {
    started: false,
    settled: false,
    async run() {
      try {
        resolveResult(await work());
      } catch (error) {
        rejectResult(error);
      } finally {
        release();
      }
    },
  };
  const release = () => {
    if (entry.settled) return;
    entry.settled = true;
    pendingMutations -= 1;
    mutationCurrentBytes = Math.max(0, mutationCurrentBytes - retainedBytes);
  };
  entry.timeout = setTimeout(() => {
    if (entry.started || entry.settled) return;
    const index = mutationWaiters.indexOf(entry);
    if (index >= 0) mutationWaiters.splice(index, 1);
    release();
    rejectResult(new OAuthMutationBusyError("OAuth mutation queue wait timed out"));
  }, waitMs);
  // Only unref the long default wait. Short waitMs (tests) must stay ref'd:
  // on Windows Bun under `bun test --isolate`, an unref'd timer can fail to
  // fire while the head mutation holds an unresolved Promise, hanging the
  // waiter forever (#827 / full admission queue hang on windows-latest).
  if (waitMs >= OAUTH_MUTATION_WAIT_MS) entry.timeout.unref?.();
  mutationWaiters.push(entry);
  drainOAuthMutations();
  return result;
}
export function mutateStore<T>(fn:(store:AuthStore)=>T|Promise<T>, retainedValues: readonly unknown[] = [], options?: { waitMs?: number }):Promise<T>{return serializeMutation(async()=>{const guard=await createOAuthFileLock({path:getAuthStoreLockPath(),staleAfterMs:30000}).acquire();try{
    const store = loadAuthStoreInternal();
    const result = await fn(store);
    persist(store);
    return result;
  }finally{guard.release();}}, retainedValues, options?.waitMs);
}

/** The ACTIVE account's credential for a provider (what requests should use). */
export function getCredential(provider: string): OAuthCredentials | null {
  const set = loadAuthStore()[provider];
  if (!set) return null;
  return set.accounts.find(a => a.id === set.activeAccountId)?.credential ?? null;
}

/**
 * Persist a credential as the ACTIVE account. Identity-matching (accountId ?? email) upserts
 * the same human's slot; a new identity appends a new account. Credentials without identity
 * (rotating refresh tokens would fabricate duplicates) and single-slot providers replace the
 * active slot / whole set instead.
 */
export async function saveCredential(
  provider: string,
  cred: OAuthCredentials,
): Promise<void> {
  const safe = normalizeCredential(cred);
  if (!safe) throw new Error("Refusing to persist invalid OAuth credential");
  await mutateStore(store => {
    const set = store[provider];
    const identity = safe.accountId ?? safe.email;
    if (!set || SINGLE_SLOT_PROVIDERS.has(provider)) {
      const id = newAccountId(safe);
      store[provider] = { activeAccountId: id, accounts: [{ id, credential: safe, addedAt: Date.now() }] };
      return;
    }
    if (identity) {
      const existing = set.accounts.find(a => (a.credential.accountId ?? a.credential.email) === identity);
      if (existing) {
        existing.credential = safe;
        delete existing.needsReauth;
        set.activeAccountId = existing.id;
        return;
      }
      const id = newAccountId(safe);
      set.accounts.push({ id, credential: safe, addedAt: Date.now() });
      set.activeAccountId = id;
      return;
    }
    // No identity: replace the active slot in place (single-account semantics).
    const active = set.accounts.find(a => a.id === set.activeAccountId);
    if (active) {
      active.credential = safe;
      delete active.needsReauth;
    } else {
      const id = newAccountId(safe);
      set.accounts.push({ id, credential: safe, addedAt: Date.now() });
      set.activeAccountId = id;
    }
  }, [provider, safe]);
}

/** Remove the ACTIVE account; remaining accounts promote the first one. */
export async function removeCredential(provider: string): Promise<void> {
  await mutateStore(store => {
    const set = store[provider];
    if (!set) return;
    set.accounts = set.accounts.filter(a => a.id !== set.activeAccountId);
    if (set.accounts.length === 0) {
      delete store[provider];
      return;
    }
    set.activeAccountId = set.accounts[0]!.id;
  }, [provider]);
}

// ---------------------------------------------------------------------------
// Multi-account API
// ---------------------------------------------------------------------------

export function getAccountSet(provider: string): ProviderAccountSet | null {
  return loadAuthStore()[provider] ?? null;
}

export function listAccounts(provider: string): ProviderAccount[] {
  return loadAuthStore()[provider]?.accounts ?? [];
}

export function listLiveOAuthAccountKeys(
  providerNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [provider, accountSet] of Object.entries(loadAuthStore())) {
    if (!providerNames.has(provider)) continue;
    for (const account of accountSet.accounts) keys.add(`${provider}\0${account.id}`);
  }
  return keys;
}

export function getAccountCredential(provider: string, accountId: string): OAuthCredentials | null {
  return loadAuthStore()[provider]?.accounts.find(a => a.id === accountId)?.credential ?? null;
}

/** Persist a refreshed credential for a SPECIFIC account without touching activeAccountId. */
export async function saveAccountCredential(provider: string, accountId: string, cred: OAuthCredentials): Promise<void> {
  const safe = normalizeCredential(cred);
  if (!safe) throw new Error("Refusing to persist invalid OAuth credential");
  await mutateStore(store => {
    const account = store[provider]?.accounts.find(a => a.id === accountId);
    if (!account) return;
    account.credential = safe;
    delete account.needsReauth;
  }, [provider, accountId, safe]);
}

export async function setActiveAccount(provider: string, accountId: string): Promise<boolean> {
  return await mutateStore(store => {
    const set = store[provider];
    if (!set || !set.accounts.some(a => a.id === accountId)) return false;
    set.activeAccountId = accountId;
    return true;
  }, [provider, accountId]);
}

export async function setAccountAlias(provider: string, accountId: string, alias: string | undefined): Promise<boolean> {
  return await mutateStore(store => {
    const account = store[provider]?.accounts.find(a => a.id === accountId);
    if (!account) return false;
    if (alias) account.alias = alias;
    else delete account.alias;
    return true;
  }, [provider, accountId, alias]);
}

/** Remove one account by id; active removal promotes the first remaining account. */
export async function removeAccount(provider: string, accountId: string): Promise<boolean> {
  const removed = await mutateStore(store => {
    const set = store[provider];
    if (!set) return false;
    const before = set.accounts.length;
    set.accounts = set.accounts.filter(a => a.id !== accountId);
    if (set.accounts.length === before) return false;
    if (set.accounts.length === 0) {
      delete store[provider];
      return true;
    }
    if (set.activeAccountId === accountId) set.activeAccountId = set.accounts[0]!.id;
    return true;
  }, [provider, accountId]);
  return removed;
}

/** Replace or clear a provider account set (used for transactional Kiro add-account rollback). */
export async function replaceProviderAccountSet(
  provider: string,
  set: ProviderAccountSet | null,
): Promise<void> {
  await mutateStore(store => {
    if (!set || set.accounts.length === 0) {
      delete store[provider];
      return;
    }
    store[provider] = {
      activeAccountId: set.activeAccountId,
      accounts: set.accounts.map(account => ({
        id: account.id,
        credential: { ...account.credential, ...(account.credential.kiro ? { kiro: { ...account.credential.kiro } } : {}) },
        ...(account.alias ? { alias: account.alias } : {}),
        ...(account.needsReauth ? { needsReauth: true } : {}),
        ...(account.addedAt !== undefined ? { addedAt: account.addedAt } : {}),
      })),
    };
  }, [provider, set]);
}

export async function markAccountNeedsReauth(
  provider: string,
  accountId: string,
  needsReauth: boolean,
  writerGeneration = captureConfigGeneration(),
): Promise<void> {
  if (writerGeneration < lastReconciledGeneration && !liveOAuthAccountKeys.has(oauthAccountKey(provider, accountId))) return;
  await mutateStore(store => {
    const account = store[provider]?.accounts.find(a => a.id === accountId);
    if (!account) return;
    if (needsReauth) account.needsReauth = true;
    else delete account.needsReauth;
  }, [provider, accountId]);
}

export async function mergeAccountCredential(provider:string,accountId:string,credential:OAuthCredentials,opts:{expectedGeneration?:string;afterPrePersistRead?:()=>void|Promise<void>}={}):Promise<{superseded:false}|{superseded:true;stored:OAuthCredentials}>{const safe=normalizeCredential(credential);if(!safe)throw new Error("Refusing to persist invalid OAuth credential");return await mutateStore(async store=>{await opts.afterPrePersistRead?.();const account=store[provider]?.accounts.find(x=>x.id===accountId);if(!account)throw new Error(`OAuth account disappeared before persist: ${provider}`);if(opts.expectedGeneration!==undefined&&credentialGeneration(account.credential)!==opts.expectedGeneration)return{superseded:true,stored:account.credential};account.credential=safe;delete account.needsReauth;return{superseded:false};},[provider,accountId,safe,opts.expectedGeneration]);}
export async function markAccountNeedsReauthIfGeneration(provider:string,accountId:string,generation:string,writerGeneration=captureConfigGeneration()):Promise<boolean>{const key=oauthAccountKey(provider,accountId);if(writerGeneration<lastReconciledGeneration&&!liveOAuthAccountKeys.has(key))return false;return await mutateStore(store=>{const account=store[provider]?.accounts.find(x=>x.id===accountId);if(!account?.credential||credentialGeneration(account.credential)!==generation)return false;if(writerGeneration<lastReconciledGeneration&&!liveOAuthAccountKeys.has(key))return false;account.needsReauth=true;return true;},[provider,accountId,generation]);}

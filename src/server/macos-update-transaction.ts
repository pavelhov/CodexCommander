import { inspectMacosRuntimeBundleProvenance } from "./macos-update-provenance";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getConfigDir } from "../config";
import type { ProxyLifecycleAuthority } from "./proxy-lifecycle-authority";
export type MacosUpdatePhase = "preparing" | "confirmation-required" | "prepared" | "armed" | "uncertain" | "recovering";
export interface MacosUpdateBundleIdentity {
  bundlePath: string;
  build: string;
}
export interface MacosUpdateSemanticSnapshot {
  sourceFingerprint?: string;
  intentFingerprint?: string;
  running: boolean;
  routing: "native" | "owned" | "external";
  supervision: "none" | "launchd";
  /** Exact process birth/argv identity fingerprint, never argv or environment. */
  process: {
    pid: number;
    fingerprint: string;
  } | null;
  supervisorFingerprint: string | null;
}
export interface MacosUpdateRequest {
  transactionId: string;
  source: MacosUpdateBundleIdentity;
  target: MacosUpdateBundleIdentity;
  updateAnyway?: boolean;
}
export interface MacosUpdateTransaction {
  schemaVersion: 1;
  postPreparationFingerprint: string | null;
  transactionId: string;
  source: MacosUpdateBundleIdentity;
  target: MacosUpdateBundleIdentity;
  phase: MacosUpdatePhase;
  generation: number;
  installerMayBeArmed: boolean;
  interruptionAuthorized: boolean;
  original: MacosUpdateSemanticSnapshot;
  latestIntent: {
    running: false | null;
    routing: "native" | null;
    generation: number;
  } | null;
}
export class MacosUpdateBlockedError extends Error {
  readonly code = "MACOS_UPDATE_RECOVERY_REQUIRED";
  constructor() { super("A macOS update is pending or its state is uncertain. Open the app and choose Finish Update before changing runtime or routing."); }
}
const phases: MacosUpdatePhase[] = ["preparing", "confirmation-required", "prepared", "armed", "uncertain", "recovering"];
const bounded = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\x00-\x1f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function identity(value: unknown): value is MacosUpdateBundleIdentity {
  return exact(value, ["bundlePath", "build"]) && bounded(value.bundlePath) && isAbsolute(value.bundlePath) && value.bundlePath.endsWith(".app") && typeof value.build === "string" && /^[1-9][0-9]{0,19}$/.test(value.build);
}
function snapshot(value: unknown): value is MacosUpdateSemanticSnapshot {
  if (!value || typeof value !== "object" || !exact(value, ["running", "routing", "supervision", "process", "supervisorFingerprint", ...("sourceFingerprint" in value ? ["sourceFingerprint"] : []), ...("intentFingerprint" in value ? ["intentFingerprint"] : [])]))
    return false;
  return (value.sourceFingerprint === undefined || bounded(value.sourceFingerprint)) && (value.intentFingerprint === undefined || bounded(value.intentFingerprint)) && typeof value.running === "boolean" && ["native", "owned", "external"].includes(String(value.routing)) && ["none", "launchd"].includes(String(value.supervision))
    && (value.process === null || (exact(value.process, ["pid", "fingerprint"]) && integer(value.process.pid) && bounded(value.process.fingerprint)))
    && (value.supervisorFingerprint === null || bounded(value.supervisorFingerprint));
}
function parse(value: unknown): MacosUpdateTransaction {
  if (!exact(value, ["schemaVersion", "postPreparationFingerprint", "transactionId", "source", "target", "phase", "generation", "installerMayBeArmed", "interruptionAuthorized", "original", "latestIntent"])
    || !(value.postPreparationFingerprint === null || bounded(value.postPreparationFingerprint)) || value.schemaVersion !== 1 || !bounded(value.transactionId) || !identity(value.source) || !identity(value.target)
    || value.source.bundlePath !== value.target.bundlePath || BigInt(value.target.build) <= BigInt(value.source.build)
    || typeof value.interruptionAuthorized !== "boolean" || typeof value.installerMayBeArmed !== "boolean" || !phases.includes(value.phase as MacosUpdatePhase) || !integer(value.generation) || !snapshot(value.original)
    || !(value.latestIntent === null || (exact(value.latestIntent, ["running", "routing", "generation"]) && (value.latestIntent.running === false || value.latestIntent.running === null) && (value.latestIntent.routing === "native" || value.latestIntent.routing === null) && integer(value.latestIntent.generation) && value.latestIntent.generation <= value.generation)))
    throw new MacosUpdateBlockedError();
  return value as unknown as MacosUpdateTransaction;
}
function requireAuthority(authority: ProxyLifecycleAuthority): void {
  if (!authority.delegatedLease())
    throw new MacosUpdateBlockedError();
}
/** All changes occur under the existing E -> S hierarchy. Exclusion has no TTL. */
export class MacosUpdateTransactionStore {
  constructor(readonly path = join(getConfigDir(), "macos-update-transaction.json")) { }
  read(): MacosUpdateTransaction | null {
    let fd: number | undefined;
    try {
      const leaf = lstatSync(this.path);
      if (!leaf.isFile() || leaf.nlink !== 1 || leaf.size > 16384 || (leaf.mode & 0o077) !== 0 || (process.getuid && leaf.uid !== process.getuid()))
        throw new MacosUpdateBlockedError();
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      if (opened.ino !== leaf.ino || opened.dev !== leaf.dev || opened.size > 16384)
        throw new MacosUpdateBlockedError();
      const buffer = Buffer.alloc(16385);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      if (count > 16384 || count !== opened.size)
        throw new MacosUpdateBlockedError();
      return parse(JSON.parse(buffer.subarray(0, count).toString("utf8")));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && fd === undefined)
        return null;
      throw new MacosUpdateBlockedError();
    }
    finally {
      if (fd !== undefined)
        closeSync(fd);
    }
  }
  private write(authority: ProxyLifecycleAuthority, record: MacosUpdateTransaction): MacosUpdateTransaction {
    requireAuthority(authority);
    parse(record);
    this.read();
    const directory = dirname(this.path);
    mkdirSync(directory, {
      recursive: true, mode: 0o700
    });
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.getuid && parent.uid !== process.getuid()))
      throw new MacosUpdateBlockedError();
    const temporary = join(directory, `.macos-update-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      const dir = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(dir);
      }
      finally {
        closeSync(dir);
      }
      return record;
    }
    finally {
      if (fd !== undefined)
        closeSync(fd);
      try {
        unlinkSync(temporary);
      }
      catch { }
    }
  }
  begin(authority: ProxyLifecycleAuthority, request: MacosUpdateRequest, original: MacosUpdateSemanticSnapshot): MacosUpdateTransaction {
    requireAuthority(authority);
    const prior = this.read();
    if (prior) {
      if (prior.transactionId !== request.transactionId || JSON.stringify(prior.source) !== JSON.stringify(request.source) || JSON.stringify(prior.target) !== JSON.stringify(request.target))
        throw new MacosUpdateBlockedError();
      return prior;
    }
    return this.write(authority, {
      schemaVersion: 1, postPreparationFingerprint: null, transactionId: request.transactionId, source: request.source, target: request.target, phase: "preparing", generation: 1, installerMayBeArmed: false, interruptionAuthorized: false, original, latestIntent: null
    });
  }
  transition(authority: ProxyLifecycleAuthority, id: string, phase: MacosUpdatePhase, preparationFingerprint?: string): MacosUpdateTransaction {
    const prior = this.require(id);
    const allowed: Record<MacosUpdatePhase, MacosUpdatePhase[]> = {
      preparing: ["confirmation-required", "prepared", "uncertain", "recovering"],
      "confirmation-required": ["preparing", "recovering"], prepared: ["armed", "recovering", "uncertain"],
      armed: ["uncertain"], uncertain: [], recovering: [],
    };
    if ((phase === "recovering" && prior.installerMayBeArmed) || !allowed[prior.phase].includes(phase))
      throw new MacosUpdateBlockedError();
    return this.write(authority, {
      ...prior, phase, postPreparationFingerprint: phase === "prepared" && preparationFingerprint !== undefined && prior.postPreparationFingerprint === null ? preparationFingerprint : prior.postPreparationFingerprint, installerMayBeArmed: prior.installerMayBeArmed || phase === "armed", generation: prior.generation + 1
    });
  }
  require(id: string): MacosUpdateTransaction {
    const value = this.read();
    if (!value || value.transactionId !== id)
      throw new MacosUpdateBlockedError();
    return value;
  }
  authorizeInterruption(authority: ProxyLifecycleAuthority, id: string): MacosUpdateTransaction {
    const prior = this.require(id);
    if (prior.phase !== "preparing")
      throw new MacosUpdateBlockedError();
    return this.write(authority, {
      ...prior, interruptionAuthorized: true, generation: prior.generation + 1
    });
  }
  recordPreparationFingerprint(authority: ProxyLifecycleAuthority, id: string, fingerprint: string): MacosUpdateTransaction {
    const prior = this.require(id);
    if (prior.phase !== "prepared" || !bounded(fingerprint)) throw new MacosUpdateBlockedError();
    return this.write(authority, {...prior, postPreparationFingerprint: fingerprint, generation: prior.generation + 1});
  }
  recordOff(authority: ProxyLifecycleAuthority): MacosUpdateTransaction | null {
    const prior = this.read();
    if (!prior)
      return null;
    return this.write(authority, {
      ...prior, generation: prior.generation + 1, latestIntent: {
        running: false, routing: "native", generation: prior.generation + 1
      }
    });
  }
  recordNative(authority: ProxyLifecycleAuthority): MacosUpdateTransaction | null {
    const prior = this.read();
    if (!prior)
      return null;
    return this.write(authority, {
      ...prior, generation: prior.generation + 1, latestIntent: {
        running: prior.latestIntent?.running ?? null, routing: "native", generation: prior.generation + 1
      }
    });
  }
  /** Does not remove exclusion. Caller must restore semantic state before completing recovery. */
  cancelBeforeArm(authority: ProxyLifecycleAuthority, id: string): MacosUpdateTransaction {
    if (this.require(id).installerMayBeArmed)
      throw new MacosUpdateBlockedError();
    const prior = this.require(id);
    return this.write(authority, {...prior, phase: "recovering", generation: prior.generation + 1});
  }
  /** U3 supplies installer proof; absence, age, helper exit and errors are never proof. */
  beginVerifiedRecovery(authority: ProxyLifecycleAuthority, id: string, proof: "replacement-completed" | "installer-disarmed"): MacosUpdateTransaction {
    if (proof !== "replacement-completed" && proof !== "installer-disarmed")
      throw new MacosUpdateBlockedError();
    const prior = this.require(id);
    return this.write(authority, {
      ...prior, phase: "recovering", installerMayBeArmed: false, generation: prior.generation + 1
    });
  }
  /** Finish Update may retain armed exclusion and retry the same installer; it never enables starts. */
  resumeInstallationPreparation(authority: ProxyLifecycleAuthority, id: string): MacosUpdateTransaction {
    const prior = this.require(id);
    if (!["armed", "uncertain", "prepared"].includes(prior.phase))
      throw new MacosUpdateBlockedError();
    return this.write(authority, {
      ...prior, phase: "preparing", generation: prior.generation + 1
    });
  }
  completeRecovery(authority: ProxyLifecycleAuthority, id: string): void {
    requireAuthority(authority);
    if (this.require(id).phase !== "recovering")
      throw new MacosUpdateBlockedError();
    unlinkSync(this.path);
    const dir = openSync(dirname(this.path), constants.O_RDONLY);
    try {
      fsyncSync(dir);
    }
    finally {
      closeSync(dir);
    }
  }
}
/** Shared configuration/routing mutations remain excluded even for independent runtimes. */
const recoveryScope = new AsyncLocalStorage<string>();
export function assertMacosUpdateAllowsMutation(store = new MacosUpdateTransactionStore()): void {
  const record = store.read();
  if (record && !(record.phase === "recovering" && recoveryScope.getStore() === record.transactionId))
    throw new MacosUpdateBlockedError();
}
/** Physical start only. Callers receiving independent must suppress shared routing mutations. */
export function assertMacosUpdateAllowsRuntimeStart(
  store = new MacosUpdateTransactionStore(),
  paths: { modulePath?: string; executablePath?: string } = {},
): "ordinary" | "independent" {
  const record = store.read();
  if (!record || (record.phase === "recovering" && recoveryScope.getStore() === record.transactionId)) return "ordinary";
  const provenance = inspectMacosRuntimeBundleProvenance(paths.modulePath, paths.executablePath);
  if (provenance.kind === "independent" || (provenance.kind === "bundle" && provenance.bundlePath !== record.source.bundlePath)) return "independent";
  throw new MacosUpdateBlockedError();
}
/** Only after verified installer recovery, while E owns the complete resume operation. */
export function withMacosUpdateRecovery<T>(authority: ProxyLifecycleAuthority, id: string, work: () => T, store = new MacosUpdateTransactionStore()): T {
  requireAuthority(authority);
  if (store.require(id).phase !== "recovering")
    throw new MacosUpdateBlockedError();
  return recoveryScope.run(id, work);
}
/** Internal child boundary: caller has consumed the one-shot E-owned service start proof under S. */
export function withDelegatedMacosUpdateRecovery<T>(id: string, work: () => T): T {
  if (new MacosUpdateTransactionStore().require(id).phase !== "recovering")
    throw new MacosUpdateBlockedError();
  return recoveryScope.run(id, work);
}
export function currentMacosUpdateRecoveryId(): string | undefined { return recoveryScope.getStore(); }
export interface MacosUpdatePreparationIo {
  preparationFingerprint?: () => string;
  /** Must establish exact process and supervisor bundle provenance, refusing unknown ownership. */
  capture(): Promise<MacosUpdateSemanticSnapshot>;
  /** Live attested management admission boundary; immediate count with no drain wait. */
  fence(transaction: MacosUpdateTransaction): Promise<{
    active: number;
    release(): void | Promise<void>;
  }>;
  /** Use bounded stopProxyLifecycleUnderAuthority, never signal a discovered unrelated runtime. */
  stop(transaction: MacosUpdateTransaction, authority: ProxyLifecycleAuthority): Promise<void>;
  /** Re-probe all captured processes and supervisor after stop; absence of health alone is insufficient. */
  verify(transaction: MacosUpdateTransaction): Promise<boolean>;
}
export type MacosUpdatePreparationResult = {
  status: "prepared" | "confirmation-required" | "blocked";
  transaction: MacosUpdateTransaction;
  active: number;
};
export async function prepareMacosUpdate(store: MacosUpdateTransactionStore, authority: ProxyLifecycleAuthority, request: MacosUpdateRequest, io: MacosUpdatePreparationIo): Promise<MacosUpdatePreparationResult> {
  requireAuthority(authority);
  const existing = store.read();
  let transaction = store.begin(authority, request, existing?.original ?? await io.capture());
  if (transaction.phase === "prepared") {
    let verified = false;
    try {
      verified = await io.verify(transaction);
    }
    catch { /* retain exclusion */ }
    if (!verified)
      transaction = store.transition(authority, transaction.transactionId, "uncertain");
    return {
      status: verified ? "prepared" : "blocked", transaction, active: 0
    };
  }
  if (transaction.phase !== "preparing" && transaction.phase !== "confirmation-required")
    return {
      status: "blocked", transaction, active: 0
    };
  if (transaction.phase === "confirmation-required")
    transaction = store.transition(authority, transaction.transactionId, "preparing");
  let fence: Awaited<ReturnType<MacosUpdatePreparationIo["fence"]>> | undefined;
  try {
    fence = await io.fence(transaction);
    if (!Number.isSafeInteger(fence.active) || fence.active < 0)
      throw new MacosUpdateBlockedError();
    if (fence.active > 0 && request.updateAnyway !== true) {
      transaction = store.transition(authority, transaction.transactionId, "confirmation-required");
      return {
        status: "confirmation-required", transaction, active: fence.active
      };
    }
    if (request.updateAnyway === true)
      transaction = store.authorizeInterruption(authority, transaction.transactionId);
    await io.stop(transaction, authority);
    if (!await io.verify(transaction))
      throw new MacosUpdateBlockedError();
    // Canonical stop releases S while retaining E for respawn verification.
    await authority.acquireStart();
    transaction = store.transition(authority, transaction.transactionId, "prepared", io.preparationFingerprint?.());
    return {
      status: "prepared", transaction, active: 0
    };
  }
  catch {
    await authority.acquireStart();
    transaction = store.transition(authority, transaction.transactionId, "uncertain");
    return {
      status: "blocked", transaction, active: 0
    };
  }
  finally {
    await fence?.release();
  }
}

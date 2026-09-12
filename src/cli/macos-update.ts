import { createHash } from "node:crypto";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigPath, readPid } from "../config";
import { CODEX_CONFIG_PATH } from "../codex/paths";
import { currentExternalCodexModelProvider } from "../codex/routing-transition";
import { observeCodexRoutingDocument } from "../codex/routing-document";
import { acquireProxyLifecycleAuthority, type ProxyLifecycleAuthority } from "../server/proxy-lifecycle-authority";
import { proxyLifecycleLockLeaseHeaders } from "../server/proxy-lifecycle-protocol";
import { attestLiveManagementProxy, findLiveProxy } from "../server/proxy-liveness";
import { runningProxyUpdateHeaders } from "../oauth/login-cli";
import { inspectMacosRuntimeBundleProvenance, macosUpdateProcessFingerprint } from "../server/macos-update-admission";
import { inspectMacosUpdateServiceProvenance } from "../service";
import { ensureProxyLifecycleUnderLock, stopProxyLifecycleUnderAuthority } from "./proxy-lifecycle";
import { MacosUpdateBlockedError, MacosUpdateTransactionStore, prepareMacosUpdate, withMacosUpdateRecovery, type MacosUpdateTransaction, type MacosUpdatePreparationIo } from "../server/macos-update-transaction";

export type MacOSUpdateAction = "status" | "prepare" | "arm" | "cancel" | "reconcile" | "record-off";
export type MacOSUpdateStatus = "idle" | "prepared" | "confirmation-required" | "armed" | "recovered" | "finish-required" | "blocked";
export interface MacOSUpdateCommand { action: MacOSUpdateAction; transactionId?: string; targetBuild?: string; updateAnyway?: boolean }
export interface MacOSUpdateResult {
  schemaVersion: 1; action: MacOSUpdateAction; status: MacOSUpdateStatus;
  transactionId: string | null; targetBuild: string | null; active: number;
  errorCode: "UPDATE_RECOVERY_REQUIRED" | null; message: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const buildNumber = /^[1-9][0-9]{0,19}$/;
export function parseMacOSUpdateArguments(args: string[]): MacOSUpdateCommand {
  const [action, transactionId, targetBuild, confirmation] = args;
  if (["status", "reconcile", "record-off"].includes(action ?? "") && args.length === 1) return {action:action as MacOSUpdateAction};
  if (["arm", "cancel"].includes(action ?? "") && args.length === 2 && uuid.test(transactionId ?? "")) return {action:action as MacOSUpdateAction,transactionId};
  if (action === "prepare" && (args.length === 3 || (args.length === 4 && confirmation === "update-anyway")) && uuid.test(transactionId ?? "") && buildNumber.test(targetBuild ?? "")) return {action,transactionId,targetBuild,updateAnyway:confirmation === "update-anyway"};
  throw new MacosUpdateBlockedError();
}
export interface TrustedMacOSUpdateSource {bundlePath:string;build:string;fingerprint:string}
/** Physical identity includes app executable and plist metadata, not helper contents alone. */
export function trustedMacOSUpdateSource(modulePath = import.meta.path, executable = process.execPath): TrustedMacOSUpdateSource {
  const provenance = inspectMacosRuntimeBundleProvenance(modulePath, executable);
  if (provenance.kind !== "bundle" || !provenance.bundlePath) throw new MacosUpdateBlockedError();
  const bundlePath = realpathSync(provenance.bundlePath);
  const plist = join(bundlePath,"Contents/Info.plist");
  if (lstatSync(plist).size > 256 * 1024 || realpathSync(plist) !== plist) throw new MacosUpdateBlockedError();
  // Packaged Info.plist is XML; binary or ambiguous dictionaries fail closed.
  const xml = readFileSync(plist,"utf8");
  const values = [...xml.matchAll(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/g)];
  const executables = [...xml.matchAll(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/g)];
  const build = values[0]?.[1];
  const appExecutable = executables[0]?.[1];
  if (values.length !== 1 || !build || !buildNumber.test(build) || executables.length !== 1 || !appExecutable || !/^[A-Za-z0-9._-]+$/.test(appExecutable)) throw new MacosUpdateBlockedError();
  const binary = join(bundlePath,"Contents/MacOS",appExecutable);
  if (realpathSync(binary) !== binary || !lstatSync(binary).isFile()) throw new MacosUpdateBlockedError();
  return {bundlePath,build,fingerprint:metadataFingerprint([bundlePath,plist,binary])};
}
function metadataFingerprint(paths: string[], includeChangeTime = true): string {
  return createHash("sha256").update(JSON.stringify(paths.map(path => {
    try { const s = lstatSync(path,{bigint:true}); if (s.isSymbolicLink()) throw new MacosUpdateBlockedError(); return [s.dev,s.ino,s.size,s.mtimeNs,...(includeChangeTime ? [s.ctimeNs] : [])].map(String); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }))).digest("hex");
}
/** No settings or secrets are serialized, including hashed settings contents. */
export function macOSUpdateIntentFingerprint(paths = [getConfigPath(),CODEX_CONFIG_PATH]): string {
  // loadConfig hardens permissions on every read, changing ctime even when the
  // user's settings are untouched. Only content-write/replacement metadata is
  // intent evidence; bundle replacement identity still includes ctime above.
  return metadataFingerprint(paths,false);
}
function currentRouting(): "owned" | "native" | "external" {
  let content: string;
  try { content = readFileSync(CODEX_CONFIG_PATH,"utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "native"; throw error; }
  const observed = observeCodexRoutingDocument(content);
  if (observed.kind !== "parsed" || observed.routingKind === "unknown") throw new MacosUpdateBlockedError();
  if (currentExternalCodexModelProvider() || ["custom-local","custom-remote"].includes(observed.routingKind)) return "external";
  return observed.routingKind === "codexcommander-local" ? "owned" : "native";
}
export function recoveryDisposition(source: TrustedMacOSUpdateSource, targetBuild: string, current: TrustedMacOSUpdateSource): "replacement-completed" | "finish-required" {
  return source.bundlePath === current.bundlePath && current.build === targetBuild && current.fingerprint !== source.fingerprint ? "replacement-completed" : "finish-required";
}
function result(action: MacOSUpdateAction, status: MacOSUpdateStatus, transaction: MacosUpdateTransaction | null = null, active = 0): MacOSUpdateResult {
  const blocked = status === "blocked" || status === "finish-required";
  return {schemaVersion:1,action,status,transactionId:transaction?.transactionId ?? null,targetBuild:transaction?.target.build ?? null,active,errorCode:blocked ? "UPDATE_RECOVERY_REQUIRED" : null,message:blocked ? "Update recovery is required. Choose Finish Update to retry the captured update." : "Update lifecycle state verified."};
}
export function encodeMacOSUpdateResult(value: MacOSUpdateResult): string {
  const frame = JSON.stringify(value)+"\n";
  if (Buffer.byteLength(frame) > 2048) return JSON.stringify(result(value.action,"blocked"))+"\n";
  return frame;
}

/** All HTTP operations, including inspection, use a fresh protected-record attestation. */
async function admission(authority: ProxyLifecycleAuthority, method: string, pid: number, transactionId?: string): Promise<Record<string,unknown>> {
  const target = await attestLiveManagementProxy({expectedPid:pid,attempts:1});
  const lease = authority.delegatedLease();
  if (!target || !lease) throw new MacosUpdateBlockedError();
  const headers = runningProxyUpdateHeaders();
  for (const [key,value] of Object.entries(proxyLifecycleLockLeaseHeaders(lease))) headers.set(key,value);
  if (transactionId) headers.set("x-ccx-update-transaction",transactionId);
  const response = await fetch(`${target.baseUrl}/api/macos-update/admission`,{method,headers,redirect:"error",signal:AbortSignal.timeout(5000)});
  const bytes = await response.arrayBuffer();
  if (!response.ok || bytes.byteLength > 4096) throw new MacosUpdateBlockedError();
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MacosUpdateBlockedError();
  return parsed as Record<string,unknown>;
}
function processGone(transaction: MacosUpdateTransaction): boolean {
  const captured = transaction.original.process;
  if (!captured) return true;
  try { process.kill(captured.pid,0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  const fingerprint = macosUpdateProcessFingerprint(captured.pid);
  return fingerprint !== null && fingerprint !== captured.fingerprint;
}
export function productionMacOSUpdatePreparation(source: TrustedMacOSUpdateSource, authority: ProxyLifecycleAuthority): MacosUpdatePreparationIo {
  return {
    preparationFingerprint: macOSUpdateIntentFingerprint,
    async capture() {
      const service = inspectMacosUpdateServiceProvenance(source.bundlePath);
      const live = await findLiveProxy();
      let captured: {pid:number;fingerprint:string} | null = null;
      if (live) {
        if (!live.pid || live.source !== "runtime") throw new MacosUpdateBlockedError();
        const info = await admission(authority,"GET",live.pid);
        if (info.pid !== live.pid || typeof info.fingerprint !== "string") throw new MacosUpdateBlockedError();
        if (info.bundlePath === source.bundlePath) captured = {pid:live.pid,fingerprint:info.fingerprint};
        else if (info.bundlePath !== null) throw new MacosUpdateBlockedError();
      } else if (readPid()) throw new MacosUpdateBlockedError();
      // A bundle service combined with an independent runtime cannot be safely paused.
      if ((captured && service.kind === "independent") || (!captured && live && service.kind === "bundle")) throw new MacosUpdateBlockedError();
      return {sourceFingerprint:source.fingerprint,intentFingerprint:macOSUpdateIntentFingerprint(),running:captured !== null || (service.kind === "bundle" && service.active),routing:currentRouting(),supervision:service.kind === "bundle" && service.active ? "launchd" : "none",process:captured,supervisorFingerprint:service.fingerprint};
    },
    async fence(transaction) {
      const captured = transaction.original.process;
      if (!captured || processGone(transaction)) return {active:0,release(){}};
      const info = await admission(authority,"GET",captured.pid);
      if (info.bundlePath !== source.bundlePath || info.fingerprint !== captured.fingerprint) throw new MacosUpdateBlockedError();
      const fenced = await admission(authority,"POST",captured.pid,transaction.transactionId);
      if (fenced.pid !== captured.pid || !Number.isSafeInteger(fenced.active) || Number(fenced.active) < 0) throw new MacosUpdateBlockedError();
      return {active:Number(fenced.active),async release(){
        if (processGone(transaction)) return;
        // Canonical stop releases S; reacquire before removing a reversible fence.
        await authority.acquireStart();
        await admission(authority,"DELETE",captured.pid,transaction.transactionId);
      }};
    },
    async stop(transaction, held) {
      const service = inspectMacosUpdateServiceProvenance(source.bundlePath);
      if (service.fingerprint !== transaction.original.supervisorFingerprint) throw new MacosUpdateBlockedError();
      if (!transaction.original.process && service.kind !== "bundle") return;
      if (service.kind === "independent") throw new MacosUpdateBlockedError();
      const stopped = await stopProxyLifecycleUnderAuthority({io:{
        attestedTargetPolicy: target => target.pid === transaction.original.process?.pid && macosUpdateProcessFingerprint(target.pid) === transaction.original.process.fingerprint,
        beforeProcessStop: async () => {
          if (processGone(transaction)) return;
          const sealed = await admission(held,"PUT",transaction.original.process!.pid,transaction.transactionId);
          if (sealed.sealed !== true) throw new MacosUpdateBlockedError();
        },
      }},held);
      if (!stopped.ok) throw new MacosUpdateBlockedError();
    },
    async verify(transaction) {
      if (!processGone(transaction)) return false;
      const service = inspectMacosUpdateServiceProvenance(source.bundlePath);
      if (service.fingerprint !== transaction.original.supervisorFingerprint || (service.kind === "bundle" && service.active)) return false;
      const live = await findLiveProxy();
      if (!live) return !readPid();
      if (!live.pid || live.source !== "runtime") return false;
      const info = await admission(authority,"GET",live.pid);
      return info.pid === live.pid && info.bundlePath === null && transaction.original.process === null;
    },
  };
}

export function macOSUpdateResumeIntent(transaction: MacosUpdateTransaction, currentFingerprint: string): {running:boolean;restoreOwned:boolean;supervised:boolean} {
  return {
    running:transaction.original.running && transaction.latestIntent?.running !== false,
    restoreOwned:transaction.original.routing === "owned" && transaction.latestIntent?.routing !== "native" && transaction.postPreparationFingerprint !== null && transaction.postPreparationFingerprint === currentFingerprint,
    supervised:transaction.original.supervision === "launchd",
  };
}
export interface MacOSUpdateHelperIo {
  store?: MacosUpdateTransactionStore;
  source?: () => TrustedMacOSUpdateSource;
  authority?: typeof acquireProxyLifecycleAuthority;
  preparation?: (source:TrustedMacOSUpdateSource, authority:ProxyLifecycleAuthority) => MacosUpdatePreparationIo;
  intentFingerprint?: () => string;
  resume?: (transaction:MacosUpdateTransaction, authority:ProxyLifecycleAuthority, restoreOwned:boolean) => Promise<boolean>;
}
export async function resumeProduction(transaction:MacosUpdateTransaction, authority:ProxyLifecycleAuthority, restoreOwned:boolean, io: {
  service?: () => ReturnType<typeof inspectMacosUpdateServiceProvenance>;
  live?: typeof findLiveProxy;
  inspect?: (pid:number) => Promise<Record<string,unknown>>;
  stop?: typeof stopProxyLifecycleUnderAuthority;
} = {}): Promise<boolean> {
  const service = (io.service ?? (() => inspectMacosUpdateServiceProvenance(transaction.target.bundlePath)))();
  // A newer verified service choice supersedes the snapshot; never recreate or
  // take over that service merely to restore the previous update state.
  if (service.fingerprint !== transaction.original.supervisorFingerprint || service.kind === "independent") return true;
  const live = await (io.live ?? findLiveProxy)();
  if (transaction.latestIntent?.running === false || !transaction.original.running) {
    if (!live) return !service.active || (await (io.stop ?? stopProxyLifecycleUnderAuthority)({io:{attestedTargetPolicy:()=>false}},authority)).ok;
    if (!live.pid || live.source !== "runtime") return false;
    const info = await (io.inspect ?? (pid => admission(authority,"GET",pid)))(live.pid);
    if (info.bundlePath === null) return true; // Independent runtime remains untouched.
    if (info.pid !== live.pid || info.bundlePath !== transaction.target.bundlePath || typeof info.fingerprint !== "string") return false;
    // An explicit OFF after a crash following recovery spawn still wins.
    const stopped = await (io.stop ?? stopProxyLifecycleUnderAuthority)({io:{attestedTargetPolicy:target => target.pid === live.pid && macosUpdateProcessFingerprint(target.pid) === info.fingerprint}},authority);
    return stopped.ok;
  }
  if (live) {
    if (!live.pid || live.source !== "runtime") return false;
    const info = await (io.inspect ?? (pid => admission(authority,"GET",pid)))(live.pid);
    // Exclusion admits only the one-shot recovery child. A crash after spawn may
    // leave it healthy; prove its bundle and changed birth identity before adopting.
    return info.pid === live.pid && info.bundlePath === transaction.target.bundlePath
      && typeof info.fingerprint === "string" && info.fingerprint !== transaction.original.process?.fingerprint
      && (transaction.original.supervision === "launchd" ? service.kind === "bundle" && service.active : !service.active);
  }
  const resumed = await ensureProxyLifecycleUnderLock({action:restoreOwned ? "start" : "ensure",honorAutoStart:false,ensureCompanion:false,preferService:transaction.original.supervision === "launchd"},authority);
  return resumed.ok && resumed.state === "running";
}
export async function performMacOSUpdateCommand(command:MacOSUpdateCommand, io:MacOSUpdateHelperIo = {}): Promise<MacOSUpdateResult> {
  const store = io.store ?? new MacosUpdateTransactionStore();
  const authority = await (io.authority ?? acquireProxyLifecycleAuthority)({includeStart:true});
  try {
    const source = (io.source ?? trustedMacOSUpdateSource)();
    const preparation = (io.preparation ?? productionMacOSUpdatePreparation)(source,authority);
    const intentFingerprint = io.intentFingerprint ?? macOSUpdateIntentFingerprint;
    let transaction = store.read();
    if (command.action === "record-off") { transaction = store.recordOff(authority); return result(command.action,transaction ? "finish-required" : "idle",transaction); }
    if (command.action === "status") return result(command.action,transaction ? transaction.phase === "prepared" ? "prepared" : transaction.phase === "armed" ? "armed" : "finish-required" : "idle",transaction);
    if (command.action === "prepare") {
      if (transaction && (transaction.source.bundlePath !== source.bundlePath || transaction.source.build !== source.build || transaction.original.sourceFingerprint !== source.fingerprint)) return result(command.action,"finish-required",transaction);
      if (transaction && ["armed","uncertain"].includes(transaction.phase)) {
        if (transaction.transactionId !== command.transactionId || transaction.target.build !== command.targetBuild) throw new MacosUpdateBlockedError();
        transaction = store.resumeInstallationPreparation(authority,transaction.transactionId);
      }
      const prepared = await prepareMacosUpdate(store,authority,{transactionId:command.transactionId!,source:{bundlePath:source.bundlePath,build:source.build},target:{bundlePath:source.bundlePath,build:command.targetBuild!},updateAnyway:command.updateAnyway},preparation);
      if (prepared.status === "prepared" && prepared.transaction.postPreparationFingerprint === null) store.recordPreparationFingerprint(authority,prepared.transaction.transactionId,intentFingerprint());
      return result(command.action,prepared.status,prepared.transaction,prepared.active);
    }
    if (!transaction) return result(command.action,"idle");
    if (command.transactionId && command.transactionId !== transaction.transactionId) throw new MacosUpdateBlockedError();
    if (command.action === "arm") {
      if (source.bundlePath !== transaction.source.bundlePath || source.build !== transaction.source.build || source.fingerprint !== transaction.original.sourceFingerprint || transaction.phase !== "prepared" || !await preparation.verify(transaction)) return result(command.action,"blocked",transaction);
      transaction = store.transition(authority,transaction.transactionId,"armed");
      return result(command.action,"armed",transaction);
    }
    if (command.action === "cancel") {
      if (transaction.installerMayBeArmed || source.bundlePath !== transaction.source.bundlePath || source.build !== transaction.source.build || source.fingerprint !== transaction.original.sourceFingerprint) return result(command.action,"finish-required",transaction);
      // Confirmation has made no physical changes and releasing admission does not interrupt turns.
      if (transaction.phase === "confirmation-required") {
        store.cancelBeforeArm(authority,transaction.transactionId);
        store.completeRecovery(authority,transaction.transactionId);
        return result(command.action,"recovered");
      }
      if (transaction.phase !== "recovering") {
        if (!await preparation.verify(transaction)) return result(command.action,"blocked",transaction);
        transaction = store.cancelBeforeArm(authority,transaction.transactionId);
      }
    } else if (command.action === "reconcile") {
      const cancelledRecovery = transaction.phase === "recovering" && !transaction.installerMayBeArmed && source.bundlePath === transaction.source.bundlePath && source.build === transaction.source.build && source.fingerprint === transaction.original.sourceFingerprint;
      if (!cancelledRecovery && (!transaction.original.sourceFingerprint || recoveryDisposition({...transaction.source,fingerprint:transaction.original.sourceFingerprint},transaction.target.build,source) !== "replacement-completed")) return result(command.action,"finish-required",transaction);
      if (transaction.phase !== "recovering") transaction = store.beginVerifiedRecovery(authority,transaction.transactionId,"replacement-completed");
    }
    const {restoreOwned} = macOSUpdateResumeIntent(transaction,intentFingerprint());
    const resumed = await withMacosUpdateRecovery(authority,transaction.transactionId,() => (io.resume ?? resumeProduction)(transaction!,authority,restoreOwned),store);
    await authority.acquireStart();
    if (!resumed) return result(command.action,"blocked",transaction);
    store.completeRecovery(authority,transaction.transactionId);
    return result(command.action,"recovered");
  } finally { authority.releaseAll(); }
}
export async function runMacOSUpdateHelper(args:string[]): Promise<number> {
  let command:MacOSUpdateCommand;
  try { command = parseMacOSUpdateArguments(args); }
  catch { process.stdout.write(encodeMacOSUpdateResult(result("status","blocked"))); return 2; }
  const saved = {log:console.log,info:console.info,warn:console.warn,error:console.error};
  console.log = console.info = console.warn = console.error = () => {};
  let value:MacOSUpdateResult;
  try { value = await performMacOSUpdateCommand(command); }
  catch { value = result(command.action,"blocked"); }
  finally { Object.assign(console,saved); }
  process.stdout.write(encodeMacOSUpdateResult(value));
  return value.status === "blocked" ? 1 : 0;
}

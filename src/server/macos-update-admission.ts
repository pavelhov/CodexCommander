import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { captureProxySignalIdentity } from "../lib/process-control";
import type { CodexCommanderConfig } from "../types";
import { jsonResponse } from "./auth-cors";
import { abortAndReleaseAllTurns, beginShutdownDrain, acquireTemporaryDrain, getActiveTurnCount } from "./lifecycle";
import { MacosUpdateTransactionStore } from "./macos-update-transaction";
import { readProxyLifecycleLockLeaseHeaders } from "./proxy-lifecycle-protocol";
import { validateProxyLifecycleLockLease } from "./proxy-start-lock";
/** Resolves physical paths; argv/environment claims alone cannot prove bundle ownership. */
export function inspectMacosRuntimeBundleProvenance(
  modulePath = import.meta.path,
  executablePath = process.execPath,
): { kind: "bundle" | "independent" | "mixed" | "unknown"; bundlePath: string | null } {
  try {
    const containingBundle = (path: string): string | null => {
      const physical = realpathSync(path);
      const marker = ".app/Contents/";
      const offset = physical.lastIndexOf(marker);
      return offset < 0 ? null : physical.slice(0, offset + 4);
    };
    const moduleBundle = containingBundle(modulePath);
    const executableBundle = containingBundle(executablePath);
    if (!moduleBundle && !executableBundle) return { kind: "independent", bundlePath: null };
    if (!moduleBundle || !executableBundle || moduleBundle !== executableBundle) {
      return { kind: "mixed", bundlePath: moduleBundle ?? executableBundle };
    }
    return { kind: "bundle", bundlePath: moduleBundle };
  } catch { return { kind: "unknown", bundlePath: null }; }
}
export function macosRuntimeBundlePath(modulePath = import.meta.path, executablePath = process.execPath): string | null {
  const provenance = inspectMacosRuntimeBundleProvenance(modulePath, executablePath);
  return provenance.kind === "bundle" ? provenance.bundlePath : null;
}
export function macosUpdateProcessFingerprint(pid = process.pid): string | null {
  const identity = captureProxySignalIdentity(pid);
  return identity ? createHash("sha256").update(JSON.stringify(identity)).digest("hex") : null;
}
let held: {
  transactionId: string;
  release(): void;
} | undefined;
/** Authentication/CORS remain at the management dispatcher; E+S delegation is additionally required. */
export function handleMacosUpdateAdmission(req: Request, url: URL, config: CodexCommanderConfig, io: {
  store?: MacosUpdateTransactionStore;
  bundlePath?: () => string | null;
  fingerprint?: () => string | null;
  validateLease?: typeof validateProxyLifecycleLockLease;
} = {}): Response | null {
  if (url.pathname !== "/api/macos-update/admission")
    return null;
  const reply = (body: object, status = 200) => jsonResponse(body, status, req, config);
  const proof = readProxyLifecycleLockLeaseHeaders(req.headers);
  if (proof.kind !== "lease" || !(io.validateLease ?? validateProxyLifecycleLockLease)(proof.lease))
    return reply({ error: "Update lifecycle authority required." }, 409);
  if (!io.bundlePath) {
    const provenance = inspectMacosRuntimeBundleProvenance();
    if (provenance.kind === "mixed" || provenance.kind === "unknown") return reply({ error: "Runtime bundle provenance is uncertain." }, 409);
  }
  const bundlePath = (io.bundlePath ?? macosRuntimeBundlePath)();
  const fingerprint = (io.fingerprint ?? macosUpdateProcessFingerprint)();
  if (req.method === "GET")
    return reply({
      pid: process.pid, bundlePath, fingerprint, active: getActiveTurnCount()
    });
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "DELETE")
    return reply({ error: "Unsupported update admission operation." }, 405);
  try {
    const store = io.store ?? new MacosUpdateTransactionStore();
    const transaction = store.require(req.headers.get("x-ccx-update-transaction") ?? "");
    if (!bundlePath || bundlePath !== transaction.source.bundlePath || !fingerprint
      || transaction.original.process?.pid !== process.pid || transaction.original.process.fingerprint !== fingerprint)
      return reply({ error: "This runtime is not the captured bundle process." }, 409);
    if (req.method === "PUT") {
      if (!held || held.transactionId !== transaction.transactionId || transaction.phase !== "preparing")
        return reply({ error: "Update admission must be fenced before shutdown." }, 409);
      if (getActiveTurnCount() > 0 && !transaction.interruptionAuthorized)
        return reply({ error: "Explicit Update Anyway confirmation required." }, 409);
      beginShutdownDrain();
      if (transaction.interruptionAuthorized)
        abortAndReleaseAllTurns(new Error("User approved update interruption"));
      held.release();
      held = undefined;
      return reply({ sealed: true });
    }
    if (req.method === "DELETE") {
      if (held && held.transactionId !== transaction.transactionId)
        return reply({ error: "Update admission belongs to another transaction." }, 409);
      held?.release();
      held = undefined;
      return reply({ released: true });
    }
    if (!["preparing", "confirmation-required"].includes(transaction.phase))
      return reply({ error: "Update transaction is not preparing." }, 409);
    if (held && held.transactionId !== transaction.transactionId)
      return reply({ error: "Update admission is busy." }, 409);
    if (!held) {
      const lease = acquireTemporaryDrain("macos-update");
      if (!lease)
        return reply({ error: "Request admission is busy." }, 409);
      held = {
        transactionId: transaction.transactionId, release: () => lease.release()
      };
    }
    // No timer, wait, cancellation or request replay: the helper presents consent immediately.
    return reply({
      active: getActiveTurnCount(), pid: process.pid
    });
  }
  catch {
    return reply({ error: "Update transaction requires recovery." }, 409);
  }
}

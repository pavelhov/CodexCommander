/** Admission and physical-send reservations for an explicitly launched HTTP pilot.
 * This module performs no network requests, credential reads, or client launches.
 * Credit estimates are admission reserves, not guaranteed billing caps.
 */
export interface PilotIdentity {
  clientSha256: string;
  runtimeSourceSha256: string;
  configSha256: string;
  catalogSha256: string;
  qualificationSha256: string;
  accountAlias: string;
  accountGeneration: string;
  model: string;
  effort: string;
  tier: string;
  transport: "http";
}
export interface PilotManifest {
  schemaVersion: 1;
  identity: PilotIdentity;
  qualification: {
    verdict: "PASS" | "FAIL" | "UNAVAILABLE";
    actualClientFullIngress: boolean;
    requiredScenariosComplete: boolean;
    dispatchComplete: boolean;
  };
  bounds: {
    generationStarts: 6;
    dispatches: number;
    wallTimeMs: number;
    inputTokensPerSend: number;
    outputTokensPerSend: number;
    estimatedCredits: number;
  };
  rates: {
    unit: "subscription-credits";
    inputPerMillion: number;
    outputPerMillion: number;
    model: string;
    tier: string;
    sourceSha256: string;
    verifiedAt: number;
  };
}
export interface PilotUsage {
  httpStatus: number;
  outcome: "completed" | "failed" | "unknown";
  inputTokens: number;
  outputTokens: number;
  completeness: "complete" | "partial" | "unknown";
}
export type PilotArm = "direct" | "commander";
export type PilotSendKind = "initial" | "continuation" | "compaction" | "sidecar" | "retry";
interface Generation { readonly arm: PilotArm; readonly ordinal: number }
const fingerprints = ["clientSha256", "runtimeSourceSha256", "configSha256", "catalogSha256", "qualificationSha256", "accountGeneration"] as const;
const identityFields = [...fingerprints, "accountAlias", "model", "effort", "tier", "transport"] as const;
const positive = (n: number) => Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;
const count = (n: number) => positive(n) && Number.isSafeInteger(n);
const exceeds = (n: number, limit: number) => n - limit > Math.max(1, Math.abs(limit)) * 1e-12;
function identityMatches(expected: PilotIdentity, observed: PilotIdentity): boolean {
  return identityFields.every(key => expected[key] === observed[key]);
}
function validateManifest(m: PilotManifest, observed: PilotIdentity, now: number): void {
  const q = m.qualification, b = m.bounds, r = m.rates;
  if (m.schemaVersion !== 1 || !Number.isFinite(now)
    || !fingerprints.every(key => /^[a-f0-9]{64}$/.test(m.identity[key]))
    || ![m.identity.accountAlias, m.identity.model, m.identity.effort, m.identity.tier].every(value => typeof value === "string" && /^[A-Za-z0-9._/-]{1,128}$/.test(value))
    || m.identity.transport !== "http" || !identityMatches(m.identity, observed)) throw new Error("pilot_identity_unqualified");
  if (q.verdict !== "PASS" || q.actualClientFullIngress !== true || q.requiredScenariosComplete !== true || q.dispatchComplete !== true) throw new Error("pilot_offline_qualification_missing");
  if (b.generationStarts !== 6 || !count(b.dispatches) || b.dispatches > 6
    || !count(b.wallTimeMs) || b.wallTimeMs > 600000
    || !count(b.inputTokensPerSend) || !count(b.outputTokensPerSend) || !positive(b.estimatedCredits)) throw new Error("pilot_bounds_invalid");
  if (r.unit !== "subscription-credits" || !positive(r.inputPerMillion) || !positive(r.outputPerMillion)
    || r.model !== m.identity.model || r.tier !== m.identity.tier || !/^[a-f0-9]{64}$/.test(r.sourceSha256)
    || !Number.isFinite(r.verifiedAt) || r.verifiedAt > now || now - r.verifiedAt > 86400000) throw new Error("pilot_rate_basis_unqualified");
  const reserve = (b.inputTokensPerSend * r.inputPerMillion + b.outputTokensPerSend * r.outputPerMillion) / 1e6;
  if (!positive(reserve) || !positive(reserve * b.dispatches) || exceeds(reserve * b.dispatches, b.estimatedCredits)) throw new Error("pilot_credit_reserve_insufficient");
}

/** One controller owns both arms. Every physical send must enter dispatch(), including
 * direct-client retries and sidecars. An observer-only journal cannot enforce this bound.
 */
export class PilotBudget {
  readonly signal: AbortSignal;
  private readonly manifest: PilotManifest;
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private active?: Generation;
  private sendPending = false;
  private activeSends = 0;
  private starts = { direct: 0, commander: 0 };
  private sends = 0;
  private reservedCredits = 0;
  private stopReason: string | null = null;
  constructor(manifest: PilotManifest, observed: PilotIdentity, private readonly now: () => number = Date.now) {
    validateManifest(manifest, observed, now());
    this.manifest = structuredClone(manifest);
    this.signal = this.controller.signal;
    this.deadline = now() + manifest.bounds.wallTimeMs;
    this.timer = setTimeout(() => this.stop("pilot_deadline"), manifest.bounds.wallTimeMs);
    this.timer.unref?.();
  }
  private stop(reason: string): Error {
    this.stopReason ??= reason;
    this.controller.abort(new Error(this.stopReason));
    clearTimeout(this.timer);
    return new Error(this.stopReason);
  }
  private check(observed: PilotIdentity): void {
    if (this.signal.aborted) throw new Error(this.stopReason ?? "pilot_stopped");
    const now = this.now();
    if (now >= this.deadline) throw this.stop("pilot_deadline");
    if (!Number.isFinite(now) || now < this.manifest.rates.verifiedAt
      || now - this.manifest.rates.verifiedAt > 86400000) throw this.stop("pilot_rate_basis_expired");
    if (!identityMatches(this.manifest.identity, observed)) throw this.stop("pilot_identity_changed");
  }
  beginGeneration(arm: PilotArm, observed: PilotIdentity): Generation {
    this.check(observed);
    if ((arm !== "direct" && arm !== "commander") || this.active || this.starts[arm] >= 3
      || this.starts.direct + this.starts.commander >= this.manifest.bounds.generationStarts) throw this.stop("pilot_generation_bound");
    this.active = Object.freeze({ arm, ordinal: ++this.starts[arm] });
    this.activeSends = 0;
    return this.active;
  }
  async dispatch(generation: Generation, kind: PilotSendKind, observed: PilotIdentity,
    send: (signal: AbortSignal) => Promise<PilotUsage>): Promise<PilotUsage> {
    this.check(observed);
    if (generation !== this.active || this.sendPending) throw this.stop("pilot_concurrency_bound");
    if (kind === "retry" || !["initial", "continuation", "compaction", "sidecar"].includes(kind)) throw this.stop("pilot_unexpected_retry");
    const b = this.manifest.bounds, r = this.manifest.rates;
    const reserve = (b.inputTokensPerSend * r.inputPerMillion + b.outputTokensPerSend * r.outputPerMillion) / 1e6;
    if (this.sends >= b.dispatches || exceeds(this.reservedCredits + reserve, b.estimatedCredits)) throw this.stop("pilot_dispatch_reserve_exhausted");
    this.sends++; this.activeSends++; this.reservedCredits += reserve; this.sendPending = true;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error(this.stopReason ?? "pilot_stopped"));
        this.signal.addEventListener("abort", onAbort, { once: true });
      });
      const usage = await Promise.race([send(this.signal), aborted]);
      this.check(observed);
      if (!Number.isInteger(usage.httpStatus) || usage.httpStatus < 200 || usage.httpStatus >= 300 || usage.outcome !== "completed") throw this.stop("pilot_upstream_not_completed");
      if (usage.completeness !== "complete" || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
        || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) throw this.stop("pilot_usage_unknown");
      if (usage.inputTokens > b.inputTokensPerSend || usage.outputTokens > b.outputTokensPerSend) throw this.stop("pilot_usage_bound");
      return usage;
    } catch {
      throw this.stop(this.stopReason ?? "pilot_send_failed");
    } finally {
      if (onAbort) this.signal.removeEventListener("abort", onAbort);
      this.sendPending = false;
    }
  }
  endGeneration(generation: Generation): void {
    if (this.signal.aborted) throw new Error(this.stopReason ?? "pilot_stopped");
    if (generation !== this.active || this.sendPending || this.activeSends === 0) throw this.stop("pilot_generation_incomplete");
    this.active = undefined;
  }
  snapshot() {
    return { generationStarts: this.starts.direct + this.starts.commander, arms: { ...this.starts }, dispatches: this.sends,
      reservedCredits: this.reservedCredits, stopped: this.signal.aborted, reason: this.stopReason };
  }
  close(): void { this.stop("pilot_closed"); }
}

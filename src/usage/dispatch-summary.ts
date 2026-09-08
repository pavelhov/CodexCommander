import { foldDispatchEvents, type DispatchEvent, type DispatchUsage } from "./dispatch";

/** Coverage is supplied by the reader; an empty/missing journal never proves zero work. */
export interface DispatchSourceCoverage {
  sourcePresent: boolean;
  truncated?: boolean;
  invalidRows?: number;
  readFailed?: boolean;
  /** Process-local observer health, not a historical guarantee about other processes. */
  degradation?: { appendFailures?: number; invalidEvents?: number; readFailures?: number; observerFailures?: number };
}
interface TokenSubtotal { inputTokens: number; outputTokens: number; totalTokens: number; observedSends: number }
interface SeparateObservation { processRef: string; sendRef: string; usage: DispatchUsage }

/** Passive reconciliation. Only the latest associated usage revision contributes per send.
 * Never combine this subtotal with the final usage.jsonl logical/attempt ledger. */
export function summarizeDispatchEvents(events: readonly DispatchEvent[], coverage: DispatchSourceCoverage) {
  const folded = foldDispatchEvents(events);
  const counts = {
    requests: folded.requests.length, attempts: folded.attempts.length, sends: folded.sends.length,
    terminals: 0, clientCancelled: 0, upstreamCancelled: 0, missingUsage: 0, partialUsage: 0,
  };
  const blank = (): TokenSubtotal => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, observedSends: 0 });
  const providerTokens = blank(); const estimatedTokens = blank();
  const cumulativeObservations: SeparateObservation[] = [];
  const providerCreditObservations: SeparateObservation[] = [];
  let completeProviderSends = 0;
  for (const send of folded.sends) {
    if (send.terminalObserved) counts.terminals++;
    if (send.clientCancelled) counts.clientCancelled++;
    if (send.upstreamCancelled) counts.upstreamCancelled++;
    const usage = send.usage;
    if (!usage || usage.completeness === "unreported" || usage.completeness === "unsupported") { counts.missingUsage++; continue; }
    if (usage.completeness === "partial") counts.partialUsage++;
    const observation = { processRef: send.start.processRef, sendRef: send.start.sendRef!, usage };
    if (usage.provenance === "cumulative") { cumulativeObservations.push(observation); continue; }
    if (usage.provenance === "provider_credits") { providerCreditObservations.push(observation); continue; }
    // Context checkpoints and cache/reasoning subsets are never added to spend.
    if (usage.inputTokens === undefined && usage.outputTokens === undefined) { counts.missingUsage++; continue; }
    const subtotal = usage.provenance === "provider" ? providerTokens : estimatedTokens;
    subtotal.observedSends++;
    subtotal.inputTokens += usage.inputTokens ?? 0;
    subtotal.outputTokens += usage.outputTokens ?? 0;
    subtotal.totalTokens = subtotal.inputTokens + subtotal.outputTokens;
    if (usage.provenance === "provider" && usage.completeness === "complete"
      && usage.inputTokens !== undefined && usage.outputTokens !== undefined) completeProviderSends++;
  }
  const invalidRows = folded.invalidRows + (coverage.invalidRows ?? 0);
  const eventCoverageComplete = coverage.sourcePresent && events.length > 0 && counts.sends > 0
    && folded.complete && invalidRows === 0 && !coverage.truncated && !coverage.readFailed
    && Object.values(coverage.degradation ?? {}).every(value => value === 0);
  return {
    counts, providerTokens, estimatedTokens, cumulativeObservations, providerCreditObservations,
    eventCoverageComplete,
    complete: eventCoverageComplete && completeProviderSends === counts.sends,
    invalidRows, orphanEvents: folded.orphanEvents,
    limitations: [
      "Counts cover observed journal work only; empty, missing, truncated or degraded journals do not prove zero consumption.",
      "Token totals are known subtotals of associated send observations, never additions to usage.jsonl totals; missing fields are unknown.",
      "Complete token totals do not establish complete cache/reasoning breakdowns or billed cost. Cache and reasoning details are inclusive subsets.",
      "Estimates, cumulative context checkpoints and provider credits are separate units; credits are not comparable across providers or accounts.",
      "Observer degradation is current-process health; earlier process failures and uninstrumented work may be absent.",
    ],
  };
}

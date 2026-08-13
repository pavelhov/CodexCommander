/**
 * Defensive, read-only derivation of per-model collaboration-surface
 * reachability from the catalog activation projections exposed by the
 * management API (`activation.catalog.projections.v1` / `.v2`).
 *
 * The server computes each projection with `effectiveSubagentRoster(...)`
 * (src/codex/catalog/sync.ts). Every configured selector that did not enter a
 * projection's advertised window appears in that projection's `excluded` list,
 * keyed by the exact configured selector. Reachability is therefore exact per
 * selector: a row is reachable on a surface unless that surface's projection
 * excludes it.
 *
 * This module never mutates state and never falls back to guessing: when the
 * projections are absent or malformed (e.g. an older server), the derivation
 * returns an empty map and the UI simply shows no per-row exceptions.
 *
 * IMPORTANT: `chosen` must be the server-observed roster
 * (`activation.desired.chosen`), never an unsaved draft. Absence from a
 * projection's `excluded` list proves reachability only for selectors the
 * server actually computed; a draft row that is simply absent from the
 * computation would otherwise be mislabeled "both".
 */

export type RosterReachability = "both" | "v1" | "v2" | "neither";

export interface RosterProjectionExclusion {
  configured: string;
  reason?: string;
}

/** Parsed subset of `CodexCatalogRosterProjection` (src/codex/catalog-activation.ts). */
export interface RosterProjection {
  excluded: RosterProjectionExclusion[];
}

export interface RosterProjections {
  v1?: unknown;
  v2?: unknown;
}

function parseProjection(value: unknown): RosterProjection | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.excluded)) return null;
  const excluded: RosterProjectionExclusion[] = [];
  for (const entry of record.excluded) {
    if (entry === null || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.configured !== "string" || item.configured.length === 0) return null;
    excluded.push({
      configured: item.configured,
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
    });
  }
  return { excluded };
}

/**
 * Map every configured selector to its collaboration-surface state.
 *
 * Both surfaces must be observable before claiming an exception: a response
 * that omits projections cannot prove a row is limited to one surface, so no
 * exceptions are shown in that case.
 */
export function deriveRosterReachability(
  chosen: readonly string[],
  projections?: RosterProjections,
): ReadonlyMap<string, RosterReachability> {
  const result = new Map<string, RosterReachability>();
  const v1 = parseProjection(projections?.v1);
  const v2 = parseProjection(projections?.v2);
  if (!v1 || !v2) return result;
  for (const selector of chosen) {
    const onV1 = !v1.excluded.some(entry => entry.configured === selector);
    const onV2 = !v2.excluded.some(entry => entry.configured === selector);
    const state: RosterReachability = onV1 && onV2
      ? "both"
      : onV1
        ? "v1"
        : onV2
          ? "v2"
          : "neither";
    result.set(selector, state);
  }
  return result;
}

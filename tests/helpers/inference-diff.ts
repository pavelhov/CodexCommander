/** Wire normalization is deliberately independent of accounting schema additions. */
export const wireNormalizations = [
  { path: "/headers/host", reason: "ephemeral declared loopback port" },
  { path: "/headers/content-length", reason: "derived from compared body" },
] as const;
export function normalizeWire(value: unknown): unknown {
  const copy = structuredClone(value) as { headers?: Record<string, string> };
  if (copy && typeof copy === "object" && copy.headers) {
    for (const item of wireNormalizations) delete copy.headers[item.path.split("/")[2]!];
  }
  return copy;
}
export interface SemanticDiff { path: string; before: unknown; after: unknown }
export function semanticDiff(before: unknown, after: unknown, path = ""): SemanticDiff[] {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    return Array.from({ length: Math.max(before.length, after.length) }, (_, index) =>
      semanticDiff(before[index], after[index], `${path}/${index}`)).flat();
  }
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>; const b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key =>
      semanticDiff(a[key], b[key], `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  }
  return [{ path: path || "/", before: before ?? null, after: after ?? null }];
}
export function compareFixture(before: { wire: unknown[]; sends: number; outcome: string; clientAttempts: number; response?: string; faultInjection?: string }, after: typeof before) {
  const semantics = (capture: typeof before) => ({ wire: capture.wire.map(normalizeWire), sends: capture.sends, outcome: capture.outcome, clientAttempts: capture.clientAttempts, response: capture.response, faultInjection: capture.faultInjection });
  const diffs = semanticDiff(semantics(before), semantics(after));
  return { verdict: diffs.length ? "REGRESSION" as const : "PASS" as const, diffs };
}

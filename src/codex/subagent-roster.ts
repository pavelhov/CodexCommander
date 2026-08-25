import { redactSecretString } from "../lib/redact";
import type { SubagentRosterEntry } from "../types";
import { MAX_SPAWN_AGENT_MODEL_OVERRIDES } from "./catalog/sync";

export type { SubagentRosterEntry } from "../types";

export const SUBAGENT_GUIDANCE_MAX_CODE_POINTS = 160;

/** Persisted model selectors are bare native ids or exactly one-slash ids. */
function isCanonicalPersistedModelSelector(value: string): boolean {
  const slash = value.indexOf("/");
  return slash < 0 || (slash > 0 && slash === value.lastIndexOf("/") && slash < value.length - 1);
}

function normalizeModel(model: string): string {
  const normalized = model.trim();
  if (!normalized || !isCanonicalPersistedModelSelector(normalized)) {
    throw new Error("subagent roster model must be a canonical selector");
  }
  return normalized;
}

export function isSubagentGuidanceSafe(text: string): boolean {
  if (typeof text !== "string") return false;
  return !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)
    && !/[<>{}]/u.test(text)
    && [...text].length <= SUBAGENT_GUIDANCE_MAX_CODE_POINTS
    && redactSecretString(text) === text;
}

function normalizeGuidance(guidance: string | undefined): string | undefined {
  if (guidance === undefined) return undefined;
  if (typeof guidance !== "string") throw new Error("subagent roster guidance must be a string");
  const normalized = guidance.normalize("NFC").trim();
  if (!normalized) return undefined;
  if (!isSubagentGuidanceSafe(normalized)) throw new Error("subagent roster guidance is unsafe");
  return normalized;
}

function canonicalEntry(entry: SubagentRosterEntry): SubagentRosterEntry {
  const guidance = normalizeGuidance(entry.guidance);
  return {
    model: normalizeModel(entry.model),
    ...(guidance === undefined ? {} : { guidance }),
  };
}

export function canonicalSubagentRoster(entries: readonly SubagentRosterEntry[]): SubagentRosterEntry[] {
  if (entries.length > MAX_SPAWN_AGENT_MODEL_OVERRIDES) {
    throw new Error(`subagent roster may contain at most ${MAX_SPAWN_AGENT_MODEL_OVERRIDES} entries`);
  }
  const out: SubagentRosterEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const canonical = canonicalEntry(entry);
    if (seen.has(canonical.model)) throw new Error("subagent roster models must be unique");
    seen.add(canonical.model);
    out.push(canonical);
  }
  return out;
}

export function normalizeSubagentRoster(raw: unknown): SubagentRosterEntry[] {
  if (!Array.isArray(raw)) throw new Error("subagent roster must be an array");
  const entries: SubagentRosterEntry[] = raw.map((value, index) => {
    if (typeof value === "string") return { model: value };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`subagent roster entry ${index} must be a string or object`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some(key => key !== "model" && key !== "guidance")) {
      throw new Error(`subagent roster entry ${index} has unknown keys`);
    }
    if (typeof record.model !== "string") throw new Error(`subagent roster entry ${index} model must be a string`);
    if (record.guidance !== undefined && typeof record.guidance !== "string") {
      throw new Error(`subagent roster entry ${index} guidance must be a string`);
    }
    return { model: record.model, ...(record.guidance === undefined ? {} : { guidance: record.guidance }) };
  });
  return canonicalSubagentRoster(entries);
}

export function subagentRosterModels(entries: readonly SubagentRosterEntry[] | undefined): string[] {
  return (entries ?? []).map(entry => entry.model);
}

export function mergeLegacyRosterWrite(
  current: readonly SubagentRosterEntry[] | undefined,
  models: readonly string[],
): SubagentRosterEntry[] {
  const existing = canonicalSubagentRoster(current ?? []);
  const byModel = new Map(existing.map(entry => [entry.model, entry]));
  const requested = normalizeSubagentRoster(models);
  return canonicalSubagentRoster(requested.map(entry => {
    const previous = byModel.get(entry.model);
    return previous?.guidance === undefined
      ? { model: entry.model }
      : { model: entry.model, guidance: previous.guidance };
  }));
}

export function rewriteSubagentRosterModels(
  entries: readonly SubagentRosterEntry[],
  rewrite: (model: string) => string,
): SubagentRosterEntry[] {
  if (entries.length > MAX_SPAWN_AGENT_MODEL_OVERRIDES) {
    throw new Error(`subagent roster may contain at most ${MAX_SPAWN_AGENT_MODEL_OVERRIDES} entries`);
  }
  const rewritten = entries.map(entry => ({
    model: rewrite(entry.model),
    ...(entry.guidance === undefined ? {} : { guidance: entry.guidance }),
  }));
  const out: SubagentRosterEntry[] = [];
  const seen = new Set<string>();
  for (const entry of rewritten) {
    const canonical = canonicalEntry(entry);
    if (seen.has(canonical.model)) continue;
    seen.add(canonical.model);
    out.push(canonical);
  }
  if (out.length > MAX_SPAWN_AGENT_MODEL_OVERRIDES) {
    throw new Error(`subagent roster may contain at most ${MAX_SPAWN_AGENT_MODEL_OVERRIDES} entries`);
  }
  return out;
}

/**
 * Privacy-safe, process-local active agent-turn projection for the native companion.
 *
 * This module deliberately knows nothing about request bodies, logs, accounts, or
 * credentials. Production ownership lives in lifecycle.ts: a registry row is keyed
 * by the existing ActiveTurnLease and can only be removed by that lease's release.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isValidProviderName } from "../config";
import { isThreadSpawnMetadata, isThreadSpawnRequest } from "./effort-policy";

export const AGENT_ACTIVITY_SCHEMA_VERSION = 1 as const;
export const MAX_DISPLAYED_AGENT_ACTIVITIES = 64;
const MAX_CORRELATION_INPUT_LENGTH = 4096;
const MAX_MODEL_ID_LENGTH = 512;

export type AgentActivityRole = "primary" | "subagent";
export type AgentActivityPhase = "starting" | "running";

export interface AgentActivityDTO {
  id: string;
  parentId?: string;
  role: AgentActivityRole;
  provider?: string;
  model?: string;
  phase: AgentActivityPhase;
  startedAt: number;
  firstOutputAt?: number;
}

export interface AgentActivitySnapshot {
  schemaVersion: typeof AGENT_ACTIVITY_SCHEMA_VERSION;
  generatedAt: number;
  proxyState: "idle" | "active" | "draining";
  activeTurnCount: number;
  displayedActivityCount: number;
  unattributedActiveCount: number;
  truncated: boolean;
  activities: AgentActivityDTO[];
}

export interface AgentActivityStart {
  headers: Headers;
  clientMetadata?: unknown;
  startedAt?: number;
}

export interface AgentActivityRoute {
  provider?: string;
  model?: string;
}

type CorrelationField = "turn_id" | "parent_turn_id" | "thread_id" | "parent_thread_id";

interface CorrelationDigests {
  turnId?: string;
  turnIdAsParent?: string;
  parentTurnId?: string;
  threadId?: string;
  threadIdAsParent?: string;
  parentThreadId?: string;
}

interface TrackedActivity {
  id: string;
  role: AgentActivityRole;
  provider?: string;
  model?: string;
  phase: AgentActivityPhase;
  startedAt: number;
  firstOutputAt?: number;
  correlation: CorrelationDigests;
}

interface RegistryDeps {
  now: () => number;
  randomId: () => string;
  hmacKey: Uint8Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function integerTimestamp(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Math.floor(fallback);
}

function safeCorrelationInput(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CORRELATION_INPUT_LENGTH) {
    return undefined;
  }
  if (value.trim() !== value) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return value;
}

function hasCanonicalCorrelationField(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (["turn_id", "parent_turn_id", "thread_id", "parent_thread_id"] as const)
    .some(field => Object.hasOwn(value, field));
}

function parseHeaderMetadata(headers: Headers): Record<string, unknown> | undefined {
  const raw = headers.get("x-codex-turn-metadata");
  if (!raw || raw.length > MAX_CORRELATION_INPUT_LENGTH) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function safeModelId(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MODEL_ID_LENGTH) return undefined;
  if (value.trim() !== value) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return value;
}

/**
 * A bounded registry whose owner keys are the existing turn leases. The class is
 * exported for deterministic unit tests; production exposes it only through the
 * lease methods in lifecycle.ts.
 */
export class AgentActivityRegistry<Owner extends object> {
  private readonly rows = new Map<Owner, TrackedActivity>();
  private readonly deps: RegistryDeps;

  constructor(
    private readonly maxTracked: number,
    deps: Partial<RegistryDeps> = {},
  ) {
    this.deps = {
      now: deps.now ?? Date.now,
      randomId: deps.randomId ?? randomUUID,
      hmacKey: deps.hmacKey ?? randomBytes(32),
    };
  }

  begin(owner: Owner, input: AgentActivityStart): void {
    const existing = this.rows.get(owner);
    if (existing) {
      this.applyMetadata(existing, input.headers, input.clientMetadata);
      return;
    }
    if (this.rows.size >= this.maxTracked) return;
    const now = this.deps.now();
    const row: TrackedActivity = {
      id: this.deps.randomId(),
      role: "primary",
      phase: "starting",
      startedAt: integerTimestamp(input.startedAt ?? now, now),
      correlation: {},
    };
    this.applyMetadata(row, input.headers, input.clientMetadata);
    this.rows.set(owner, row);
  }

  updateMetadata(owner: Owner, clientMetadata: unknown, headers?: Headers): void {
    const row = this.rows.get(owner);
    if (!row) return;
    if (headers) {
      this.applyMetadata(row, headers, clientMetadata);
      return;
    }
    if (!isRecord(clientMetadata)) return;
    if (isThreadSpawnMetadata(clientMetadata)) row.role = "subagent";
    if (hasCanonicalCorrelationField(clientMetadata)) {
      row.correlation = this.digestStructuredMetadata(clientMetadata);
    }
  }

  markRunning(owner: Owner, route: AgentActivityRoute): void {
    const row = this.rows.get(owner);
    if (!row) return;
    row.phase = "running";
    row.provider = route.provider && isValidProviderName(route.provider) ? route.provider : undefined;
    row.model = safeModelId(route.model);
  }

  markFirstOutput(owner: Owner, at = this.deps.now()): void {
    const row = this.rows.get(owner);
    if (!row || row.firstOutputAt !== undefined) return;
    row.firstOutputAt = Math.max(row.startedAt, integerTimestamp(at, this.deps.now()));
  }

  remove(owner: Owner): void {
    this.rows.delete(owner);
  }

  resetForTests(): void {
    this.rows.clear();
  }

  snapshot(activeTurnCount: number, draining: boolean): AgentActivitySnapshot {
    const generatedAt = integerTimestamp(this.deps.now(), Date.now());
    const fullRows = [...this.rows.values()].sort((left, right) => {
      const byStartedAt = left.startedAt - right.startedAt;
      if (byStartedAt !== 0) return byStartedAt;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    const primaries = fullRows.filter(row => row.role === "primary");
    const parentByChildId = new Map<string, string>();
    let unattributedActiveCount = 0;
    for (const row of fullRows) {
      if (row.role !== "subagent") continue;
      const parent = this.resolveParent(row, primaries);
      if (parent) parentByChildId.set(row.id, parent.id);
      else unattributedActiveCount += 1;
    }

    const emitted = fullRows.slice(0, MAX_DISPLAYED_AGENT_ACTIVITIES);
    const emittedIds = new Set(emitted.map(row => row.id));
    const activities = emitted.map((row): AgentActivityDTO => {
      const parentId = parentByChildId.get(row.id);
      return {
        id: row.id,
        ...(parentId && emittedIds.has(parentId) ? { parentId } : {}),
        role: row.role,
        ...(row.provider ? { provider: row.provider } : {}),
        ...(row.model ? { model: row.model } : {}),
        phase: row.phase,
        startedAt: row.startedAt,
        ...(row.firstOutputAt !== undefined ? { firstOutputAt: row.firstOutputAt } : {}),
      };
    });
    const normalizedActiveTurnCount = Number.isFinite(activeTurnCount)
      ? Math.max(0, Math.floor(activeTurnCount))
      : 0;
    return {
      schemaVersion: AGENT_ACTIVITY_SCHEMA_VERSION,
      generatedAt,
      proxyState: draining ? "draining" : normalizedActiveTurnCount > 0 ? "active" : "idle",
      activeTurnCount: normalizedActiveTurnCount,
      displayedActivityCount: activities.length,
      unattributedActiveCount,
      truncated: fullRows.length > activities.length,
      activities,
    };
  }

  private applyMetadata(row: TrackedActivity, headers: Headers, clientMetadata: unknown): void {
    const clientRecord = isRecord(clientMetadata) ? clientMetadata : undefined;
    if (isThreadSpawnRequest(headers) || isThreadSpawnMetadata(clientRecord)) row.role = "subagent";

    const headerRecord = parseHeaderMetadata(headers);
    const structured = hasCanonicalCorrelationField(clientRecord)
      ? clientRecord
      : hasCanonicalCorrelationField(headerRecord)
        ? headerRecord
        : undefined;
    const correlation = structured ? this.digestStructuredMetadata(structured) : {};

    // Header fallback is deliberately thread-only. Session ids are useful for log
    // grouping but never prove a parent/child edge.
    if (row.role === "subagent") {
      if (!correlation.threadId && !(structured && Object.hasOwn(structured, "thread_id"))) {
        this.addSelfThreadDigests(correlation, headers.get("thread-id"));
      }
      if (!correlation.parentThreadId && !(structured && Object.hasOwn(structured, "parent_thread_id"))) {
        correlation.parentThreadId = this.digest("parent_thread_id", headers.get("x-codex-parent-thread-id"));
      }
    } else if (!correlation.threadId && !(structured && Object.hasOwn(structured, "thread_id"))) {
      this.addSelfThreadDigests(
        correlation,
        headers.get("x-codex-parent-thread-id") ?? headers.get("thread-id"),
      );
    }
    row.correlation = correlation;
  }

  private digestStructuredMetadata(metadata: Record<string, unknown>): CorrelationDigests {
    const correlation: CorrelationDigests = {};
    const turnId = safeCorrelationInput(metadata.turn_id);
    if (turnId) {
      correlation.turnId = this.digestKnownSafe("turn_id", turnId);
      correlation.turnIdAsParent = this.digestKnownSafe("parent_turn_id", turnId);
    }
    const parentTurnId = safeCorrelationInput(metadata.parent_turn_id);
    if (parentTurnId) correlation.parentTurnId = this.digestKnownSafe("parent_turn_id", parentTurnId);
    const threadId = safeCorrelationInput(metadata.thread_id);
    if (threadId) {
      correlation.threadId = this.digestKnownSafe("thread_id", threadId);
      correlation.threadIdAsParent = this.digestKnownSafe("parent_thread_id", threadId);
    }
    const parentThreadId = safeCorrelationInput(metadata.parent_thread_id);
    if (parentThreadId) correlation.parentThreadId = this.digestKnownSafe("parent_thread_id", parentThreadId);
    return correlation;
  }

  private addSelfThreadDigests(correlation: CorrelationDigests, raw: string | null): void {
    const value = safeCorrelationInput(raw);
    if (!value) return;
    correlation.threadId = this.digestKnownSafe("thread_id", value);
    correlation.threadIdAsParent = this.digestKnownSafe("parent_thread_id", value);
  }

  private digest(field: CorrelationField, value: unknown): string | undefined {
    const safe = safeCorrelationInput(value);
    return safe ? this.digestKnownSafe(field, safe) : undefined;
  }

  private digestKnownSafe(field: CorrelationField, value: string): string {
    return createHmac("sha256", this.deps.hmacKey)
      .update("opencodex-agent-activity-v1\0")
      .update(field)
      .update("\0")
      .update(value)
      .digest("base64url");
  }

  private resolveParent(child: TrackedActivity, primaries: readonly TrackedActivity[]): TrackedActivity | undefined {
    // Only role=primary rows are candidates, and primary rows never receive a
    // parentId. That one-level construction makes cycles impossible by design.
    const correlation = child.correlation;
    if (correlation.parentTurnId) {
      if (correlation.parentTurnId === correlation.turnIdAsParent) return undefined;
      const matches = primaries.filter(primary =>
        primary.id !== child.id
        && primary.correlation.turnIdAsParent === correlation.parentTurnId);
      return matches.length === 1 ? matches[0] : undefined;
    }
    if (correlation.parentThreadId) {
      if (correlation.parentThreadId === correlation.threadIdAsParent) return undefined;
      const matches = primaries.filter(primary =>
        primary.id !== child.id
        && primary.correlation.threadIdAsParent === correlation.parentThreadId);
      return matches.length === 1 ? matches[0] : undefined;
    }
    return undefined;
  }
}

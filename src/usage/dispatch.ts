import { appendDispatchEvent } from "./dispatch-log";

const enums = {
  transport: ["http", "websocket", "sidecar"],
  reason: ["initial", "retry", "recovery", "compaction", "continuation", "fallback", "warmup", "key-validation"],
  surface: ["responses", "chat", "messages", "compact", "images", "realtime", "search", "sidecar", "validation"],
  sidecarKind: ["vision", "web_search"],
  protocol: ["responses", "chat", "messages", "provider"],
} as const;
const outcomes = ["protocol_success", "protocol_failure", "transport_failure", "upstream_abort", "unknown"] as const;

export type DispatchOutcome = typeof outcomes[number];
export interface DispatchAlias { readonly ref: string }
export interface DispatchMetadata {
  transport?: typeof enums.transport[number];
  reason?: typeof enums.reason[number];
  surface?: typeof enums.surface[number];
  sidecarKind?: typeof enums.sidecarKind[number];
  protocol?: typeof enums.protocol[number];
  accountRef?: DispatchAlias;
  routeRef?: DispatchAlias;
  sessionPresent?: boolean;
  continuationPresent?: boolean;
  routingHintPresent?: boolean;
}
export interface DispatchUsage {
  provenance: "provider" | "estimated" | "cumulative" | "provider_credits";
  completeness: "complete" | "partial" | "unreported" | "unsupported";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  contextTotalTokens?: number;
  credits?: number;
}
export interface DispatchEvent {
  schemaVersion: 1;
  processRef: string;
  requestRef: string;
  parentRequestRef?: string;
  parentAttemptRef?: string;
  elapsedMs?: number;
  usageRevision?: number;
  attemptRef?: string;
  sendRef?: string;
  attemptOrdinal?: number;
  sendOrdinal?: number;
  timestamp: number;
  kind: "request" | "attempt" | "start" | "headers" | "output" | "terminal" | "cancel" | "usage";
  metadata?: Omit<DispatchMetadata, "accountRef" | "routeRef"> & { accountRef?: string; routeRef?: string };
  status?: number;
  outcome?: DispatchOutcome;
  cancellation?: "client" | "upstream";
  usage?: DispatchUsage;
}
export interface DispatchSend {
  readonly sendRef: string;
  readonly ordinal: number;
  headers(status?: number): void;
  output(): void;
  terminal(outcome: DispatchOutcome): void;
  cancel(who: "client" | "upstream"): void;
  usage(value: DispatchUsage): void;
}
export interface DispatchAttempt {
  readonly attemptRef: string;
  readonly ordinal: number;
  start(metadata?: DispatchMetadata): DispatchSend;
  child(): DispatchRequest;
}
export interface DispatchRequest {
  readonly processRef: string;
  readonly requestRef: string;
  attempt(metadata?: DispatchMetadata): DispatchAttempt;
  child(): DispatchRequest;
}
const processRef = crypto.randomUUID();
const aliases = new WeakMap<object, DispatchAlias>();
const mintedAliases = new WeakSet<object>();
/** Caller retains identity objects; this observer never retains raw account identities. */
export function dispatchAlias(identity: object): DispatchAlias {
  let alias = aliases.get(identity);
  if (!alias) { alias = Object.freeze({ ref: crypto.randomUUID() }); aliases.set(identity, alias); mintedAliases.add(alias); }
  return alias;
}
let observerFailures = 0;
export function recordDispatchObserverFailure(): void { observerFailures++; }
export function dispatchObserverHealth(): { observerFailures: number } { return { observerFailures }; }
const ref = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Explicit projection: arbitrary fields and string values never enter the journal. */
export function normalizeDispatchEvent(raw: unknown): DispatchEvent | null {
  try {
    if (!record(raw) || raw.schemaVersion !== 1 || !number(raw.timestamp)
      || ![raw.processRef, raw.requestRef].every(ref)
      || !["request", "attempt", "start", "headers", "output", "terminal", "cancel", "usage"].includes(raw.kind as string)) return null;
    const ordinal = (v: unknown) => number(v) && Number.isSafeInteger(v) && v > 0;
    if (raw.kind !== "request" && (!ref(raw.attemptRef) || !ordinal(raw.attemptOrdinal))) return null;
    if (raw.kind !== "request" && raw.kind !== "attempt" && (!ref(raw.sendRef) || !ordinal(raw.sendOrdinal))) return null;
    if ((raw.elapsedMs !== undefined && !number(raw.elapsedMs))
      || (raw.usageRevision !== undefined && (!ordinal(raw.usageRevision) || (raw.usageRevision as number) > 64))) return null;
    const result = Object.fromEntries(["schemaVersion", "processRef", "requestRef", "attemptRef", "sendRef", "attemptOrdinal", "sendOrdinal", "timestamp", "kind"].map(k => [k, raw[k]])) as unknown as DispatchEvent;
    if (number(raw.elapsedMs)) result.elapsedMs = raw.elapsedMs;
    if (raw.kind === "request") {
      if (ref(raw.parentRequestRef)) result.parentRequestRef = raw.parentRequestRef;
      if (ref(raw.parentAttemptRef)) result.parentAttemptRef = raw.parentAttemptRef;
    }
    if (raw.kind === "request") { delete result.attemptRef; delete result.attemptOrdinal; }
    if (raw.kind === "request" || raw.kind === "attempt") { delete result.sendRef; delete result.sendOrdinal; }
    if ((raw.kind === "start" || raw.kind === "attempt") && record(raw.metadata)) {
      const metadata: Record<string, unknown> = {};
      for (const [key, values] of Object.entries(enums)) if ((values as readonly unknown[]).includes(raw.metadata[key])) metadata[key] = raw.metadata[key];
      for (const key of ["accountRef", "routeRef"]) if (ref(raw.metadata[key])) metadata[key] = raw.metadata[key];
      for (const key of ["sessionPresent", "continuationPresent", "routingHintPresent"]) if (typeof raw.metadata[key] === "boolean") metadata[key] = raw.metadata[key];
      result.metadata = metadata as DispatchEvent["metadata"];
    }
    if (raw.kind === "headers" && raw.status !== undefined) {
      if (!Number.isInteger(raw.status) || (raw.status as number) < 100 || (raw.status as number) > 599) return null;
      result.status = raw.status as number;
    }
    if (raw.kind === "terminal") {
      if (!(outcomes as readonly unknown[]).includes(raw.outcome)) return null;
      result.outcome = raw.outcome as DispatchOutcome;
    }
    if (raw.kind === "cancel") {
      if (raw.cancellation !== "client" && raw.cancellation !== "upstream") return null;
      result.cancellation = raw.cancellation;
    }
    if (raw.kind === "usage") {
      if (!ordinal(raw.usageRevision) || (raw.usageRevision as number) > 64) return null;
      result.usageRevision = raw.usageRevision as number;
      const usage = raw.usage;
      if (!record(usage) || !["provider", "estimated", "cumulative", "provider_credits"].includes(usage.provenance as string)
        || !["complete", "partial", "unreported", "unsupported"].includes(usage.completeness as string)) return null;
      const clean: Record<string, unknown> = { provenance: usage.provenance, completeness: usage.completeness };
      for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens", "contextTotalTokens", "credits"]) {
        if (usage[key] !== undefined) { if (!number(usage[key])) return null; clean[key] = usage[key]; }
      }
      result.usage = clean as unknown as DispatchUsage;
    }
    return result;
  } catch { return null; }
}

function captureMetadata(raw: DispatchMetadata | undefined): DispatchEvent["metadata"] {
  if (!raw || typeof raw !== "object") return undefined;
  // Alias wrappers must have been minted in this process. String UUIDs could be raw account IDs.
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(enums)) result[key] = (raw as unknown as Record<string, unknown>)[key];
  for (const key of ["sessionPresent", "continuationPresent", "routingHintPresent"] as const) result[key] = raw[key];
  for (const key of ["accountRef", "routeRef"] as const) {
    const value = raw[key];
    if (value && typeof value === "object" && mintedAliases.has(value)) result[key] = value.ref;
  }
  return result as DispatchEvent["metadata"];
}

/** Start is written immediately before the caller invokes its final executor. No I/O beyond telemetry. */
export function createDispatchRequest(sink: (event: DispatchEvent) => void = appendDispatchEvent): DispatchRequest {
  return createRequest(sink);
}
function createRequest(sink: (event: DispatchEvent) => void, parentRequestRef?: string, parentAttemptRef?: string): DispatchRequest {
  const requestRef = crypto.randomUUID();
  let attempts = 0;
  function scopeEvent(fields: Partial<DispatchEvent>): void {
    try {
      const event = normalizeDispatchEvent({ schemaVersion: 1, processRef, requestRef, timestamp: Date.now(), ...fields });
      if (event) sink(event); else observerFailures++;
    } catch { observerFailures++; }
  }
  scopeEvent({ kind: "request", parentRequestRef, parentAttemptRef });
  return { processRef, requestRef, child: () => createRequest(sink, requestRef), attempt(metadata) {
    const attemptRef = crypto.randomUUID(); const attemptOrdinal = ++attempts;
    try { scopeEvent({ kind: "attempt", attemptRef, attemptOrdinal, metadata: captureMetadata(metadata) }); } catch { observerFailures++; }
    let sends = 0;
    return { attemptRef, ordinal: attemptOrdinal, child: () => createRequest(sink, requestRef, attemptRef), start(sendMetadata) {
      const sendRef = crypto.randomUUID(); const sendOrdinal = ++sends;
      const base = { schemaVersion: 1 as const, processRef, requestRef, attemptRef, sendRef, attemptOrdinal, sendOrdinal };
      const seen = new Set<string>();
      const startedAt = performance.now();
      let usageRevision = 0;
      function emit(kind: DispatchEvent["kind"], fields: Partial<DispatchEvent> = {}, key: string = kind): void {
        if (kind !== "usage" && seen.has(key)) return;
        try {
          const event = normalizeDispatchEvent({ ...base, timestamp: Date.now(), elapsedMs: Math.max(0, performance.now() - startedAt), kind, ...fields });
          if (!event) { observerFailures++; return; }
          if (kind !== "usage") seen.add(key);
          sink(event);
        } catch { observerFailures++; }
      }
      try { emit("start", { metadata: captureMetadata({ ...metadata, ...sendMetadata }) }); } catch { observerFailures++; }
      return { sendRef, ordinal: sendOrdinal,
        headers: status => emit("headers", { status }),
        output: () => emit("output"),
        terminal: outcome => emit("terminal", { outcome }),
        cancel: cancellation => emit("cancel", { cancellation }, `cancel:${cancellation}`),
        usage: usage => {
          if (usageRevision >= 64) { observerFailures++; return; }
          emit("usage", { usage, usageRevision: ++usageRevision });
        },
      };
    } };
  } };
}
export interface FoldedDispatch {
  start: DispatchEvent;
  outcome: DispatchOutcome;
  terminalObserved: boolean;
  headersObserved: boolean;
  outputObserved: boolean;
  clientCancelled: boolean;
  upstreamCancelled: boolean;
  usage?: DispatchUsage;
  usageRevision?: number;
}
export function foldDispatchEvents(events: readonly DispatchEvent[]) {
  const requests = new Map<string, DispatchEvent>(); const attempts = new Map<string, DispatchEvent>();
  const sends = new Map<string, FoldedDispatch>(); let invalidRows = 0; let orphanEvents = 0;
  for (const raw of events) {
    const event = normalizeDispatchEvent(raw);
    if (!event) { invalidRows++; continue; }
    if (event.kind === "request") { requests.set(`${event.processRef}:${event.requestRef}`, event); continue; }
    if (event.kind === "attempt") {
      if (!requests.has(`${event.processRef}:${event.requestRef}`)) orphanEvents++;
      attempts.set(`${event.processRef}:${event.attemptRef}`, event); continue;
    }
    const key = `${event.processRef}:${event.sendRef}`;
    if (event.kind === "start") {
      if (!requests.has(`${event.processRef}:${event.requestRef}`) || !attempts.has(`${event.processRef}:${event.attemptRef}`)) orphanEvents++;
      if (!sends.has(key)) sends.set(key, { start: event, outcome: "unknown", terminalObserved: false, headersObserved: false, outputObserved: false, clientCancelled: false, upstreamCancelled: false });
      continue;
    }
    const send = sends.get(key);
    if (!send || send.start.requestRef !== event.requestRef || send.start.attemptRef !== event.attemptRef || send.start.attemptOrdinal !== event.attemptOrdinal || send.start.sendOrdinal !== event.sendOrdinal) { orphanEvents++; continue; }
    if (event.kind === "terminal" && !send.terminalObserved) { send.outcome = event.outcome!; send.terminalObserved = true; }
    if (event.kind === "headers") send.headersObserved = true;
    if (event.kind === "output") send.outputObserved = true;
    if (event.kind === "cancel" && event.cancellation === "client") send.clientCancelled = true;
    if (event.kind === "cancel" && event.cancellation === "upstream") send.upstreamCancelled = true;
    if (event.kind === "usage" && (event.usageRevision ?? 0) > (send.usageRevision ?? 0)) { send.usage = event.usage; send.usageRevision = event.usageRevision; }
  }
  const values = [...sends.values()];
  return { requests: [...requests.values()], attempts: [...attempts.values()], sends: values, complete: invalidRows === 0 && orphanEvents === 0 && values.every(s => s.terminalObserved && s.outcome !== "unknown"), invalidRows, orphanEvents };
}

/** Bounded task identity. Parent labels describe ancestry and never own a request. */
export function resolveCodexTaskIdentity(headers: Headers, clientMetadata?: unknown): {
  taskId?: string; parentId?: string; source: "task" | "session" | "none" | "conflict";
} {
  const safe = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\x00-\x20\x7f,]/.test(value) ? value : undefined;
  const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const own: unknown[] = [headers.get("thread-id"), headers.get("x-codex-thread-id")].filter(v => v !== null);
  const parents: unknown[] = [headers.get("x-codex-parent-thread-id")].filter(v => v !== null);
  let headerMetadata: unknown;
  const raw = headers.get("x-codex-turn-metadata");
  if (raw && raw.length <= 4096) { try { headerMetadata = JSON.parse(raw); } catch { /* Optional metadata is not an owner. */ } }
  for (const metadata of [record(clientMetadata), record(headerMetadata)]) {
    if (metadata && Object.hasOwn(metadata, "thread_id")) own.push(metadata.thread_id);
    if (metadata && Object.hasOwn(metadata, "parent_thread_id")) parents.push(metadata.parent_thread_id);
  }
  const parentId = parents.length && parents.every(v => safe(v) && v === parents[0]) ? safe(parents[0]) : undefined;
  const session = [headers.get("session_id"), headers.get("session-id")].filter(v => v !== null);
  for (const [source, values] of [["task", own], ["session", session]] as const) {
    if (!values.length) continue;
    if (values.some(v => !safe(v)) || new Set(values).size !== 1) return { parentId, source: "conflict" };
    return { taskId: safe(values[0]), parentId, source };
  }
  return { parentId, source: "none" };
}

import { appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { dispatchObserverHealth, foldDispatchEvents, normalizeDispatchEvent, type DispatchEvent } from "./dispatch";

export const DISPATCH_LOG_SCHEMA_VERSION = 1;
export const DISPATCH_MAX_RECORD_BYTES = 4096;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const health = { appendFailures: 0, invalidEvents: 0, readFailures: 0 };
export function dispatchJournalHealth(): Readonly<typeof health> { return { ...health }; }
export function dispatchLogPath(): string { return join(getConfigDir(), "dispatch.jsonl"); }
/** Same ownership and file modes as usage.jsonl; no telemetry failure reaches inference. */
export function appendDispatchEvent(raw: DispatchEvent): void {
  try {
    const event = normalizeDispatchEvent(raw);
    if (!event) { health.invalidEvents++; return; }
    const row = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(row) > DISPATCH_MAX_RECORD_BYTES) { health.invalidEvents++; return; }
    const dir = getConfigDir(); const path = dispatchLogPath();
    recordOwnedConfigPath(dir, path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* parity with usage log */ }
    appendFileSync(path, row, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* parity with usage log */ }
  } catch { health.appendFailures++; }
}
/** Bounded tail reader. Truncation and malformed rows explicitly reduce coverage. */
export function readDispatchJournal() {
  const events: DispatchEvent[] = []; let invalidRows = 0; let truncated = false; let readFailed = false; let sourcePresent = false;
  let fd: number | undefined;
  try {
    fd = openSync(dispatchLogPath(), "r");
    sourcePresent = true;
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("invalid journal");
    const start = Math.max(0, stat.size - MAX_READ_BYTES); truncated = start > 0;
    const bytes = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, start + offset); if (count === 0) { readFailed = true; break; } offset += count; }
    let text = bytes.subarray(0, offset).toString("utf8");
    if (truncated) { const newline = text.indexOf("\n"); text = newline < 0 ? "" : text.slice(newline + 1); }
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line && index === lines.length - 1) continue;
      if (!line || Buffer.byteLength(line) > DISPATCH_MAX_RECORD_BYTES || index === lines.length - 1) { invalidRows++; continue; }
      try { const event = normalizeDispatchEvent(JSON.parse(line)); if (event) events.push(event); else invalidRows++; } catch { invalidRows++; }
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") { health.readFailures++; readFailed = true; }
  } finally { if (fd !== undefined) { try { closeSync(fd); } catch { health.readFailures++; readFailed = true; } } }
  const folded = foldDispatchEvents(events);
  const degradation = { ...dispatchJournalHealth(), ...dispatchObserverHealth() };
  return { ...folded, sourcePresent, degradationScope: "current_process" as const, invalidRows: folded.invalidRows + invalidRows, truncated, degradation,
    complete: sourcePresent && folded.complete && !invalidRows && !truncated && !readFailed && degradation.appendFailures === 0 && degradation.invalidEvents === 0 && degradation.observerFailures === 0,
  };
}

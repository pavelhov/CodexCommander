/**
 * What CodexCommander remembers about a client between operations.
 *
 * Two hashes, because the two questions are genuinely independent: the FILE
 * hash answers "did anyone touch this after us", and the BLOCK hash answers "is
 * our content still what we would write today". One hash cannot do both, and
 * conflating them is what lets a foreign edit read as ordinary drift — which
 * would then be silently overwritten.
 *
 * Design contract.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManagedContribution, ManagedFragment } from "../clients/config-export";
import { atomicWriteFile, getConfigDir } from "../config";
import { isIntegrationClientId, type IntegrationClientId } from "./registry";

/** 16 hex chars — the same shape as the Claude Desktop applied fingerprint. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Canonical bytes of a contribution. Fragments are sorted by path so two builds
 * of the same contribution hash identically regardless of emission order.
 */
export function canonicalContribution(contribution: ManagedContribution): string {
  const sorted = [...contribution.fragments].sort((a, b) => {
    const left = a.path.join("\u0000");
    const right = b.path.join("\u0000");
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return JSON.stringify(sorted.map(fragment => [fragment.path, fragment.value]));
}

export interface OwnershipRecord {
  clientId: IntegrationClientId;
  configPath: string;
  /** Hash of the WHOLE file as we left it — detects foreign edits after us. */
  fileFingerprint: string;
  /** Hash of our contribution — detects catalog/port drift. */
  blockFingerprint: string;
  /** The exact paths we own. Removal touches these and nothing else. */
  fragmentPaths: readonly (readonly string[])[];
  /**
   * Containers this apply had to CREATE, `\0`-joined.
   *
   * Kimi's `models` map exists only because our aliases need somewhere to
   * live. Without this, disable left it behind as an empty container in a file
   * the user never asked us to restructure — while a `providers: {}` the user
   * wrote themselves must survive. Its presence marks the current record
   * schema; older records are ignored rather than trusted with incomplete
   * removal provenance.
   */
  createdContainers: readonly string[];
  appliedAt: string;
  opId: string;
}

const OWNERSHIP_RECORD_KEYS = [
  "clientId",
  "configPath",
  "fileFingerprint",
  "blockFingerprint",
  "fragmentPaths",
  "createdContainers",
  "appliedAt",
  "opId",
] as const;

const RECORDS_SCHEMA_VERSION = 1 as const;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * The integrations directory itself. Every primitive takes THIS path, never a
 * config root, so a caller cannot accidentally produce
 * `<root>/integrations/integrations` by passing an already-resolved value.
 */
export function integrationsDir(configDir: string = getConfigDir()): string {
  return join(configDir, "integrations");
}

/** `atomicWriteFile` does not create parents. */
export function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

function recordsPath(dir: string): string {
  return join(dir, "records.json");
}

/** Only the current, complete ownership schema may authorize a mutation. */
export function isCurrentOwnershipRecord(value: unknown): value is OwnershipRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, OWNERSHIP_RECORD_KEYS)
    && typeof record.clientId === "string"
    && isIntegrationClientId(record.clientId)
    && typeof record.configPath === "string" && record.configPath.length > 0
    && typeof record.fileFingerprint === "string" && /^[0-9a-f]{16}$/.test(record.fileFingerprint)
    && typeof record.blockFingerprint === "string" && /^[0-9a-f]{16}$/.test(record.blockFingerprint)
    && Array.isArray(record.fragmentPaths)
    && record.fragmentPaths.every(path =>
      Array.isArray(path) && path.length > 0
        && path.every(part => typeof part === "string" && part.length > 0))
    && Array.isArray(record.createdContainers)
    && record.createdContainers.every(path => typeof path === "string" && path.length > 0)
    && typeof record.appliedAt === "string" && Number.isFinite(Date.parse(record.appliedAt))
    && typeof record.opId === "string" && record.opId.length > 0;
}

export function readRecords(
  dir: string = integrationsDir(),
): Partial<Record<IntegrationClientId, OwnershipRecord>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordsPath(dir), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const envelope = parsed as Record<string, unknown>;
      if (!hasExactKeys(envelope, ["schemaVersion", "records"])
        || envelope.schemaVersion !== RECORDS_SCHEMA_VERSION
        || !envelope.records || typeof envelope.records !== "object" || Array.isArray(envelope.records)) {
        return {};
      }
      const current: Partial<Record<IntegrationClientId, OwnershipRecord>> = {};
      for (const [clientId, value] of Object.entries(envelope.records)) {
        if (isIntegrationClientId(clientId)
          && isCurrentOwnershipRecord(value)
          && value.clientId === clientId) {
          current[clientId] = value;
        }
      }
      return current;
    }
  } catch {
    // Missing or corrupt records mean "we remember nothing", which the
    // classifier reads as a conflict for an existing block. Fail closed: an
    // unreadable memory is never permission to delete.
  }
  return {};
}

export function writeRecord(record: OwnershipRecord, dir: string = integrationsDir()): void {
  if (!isCurrentOwnershipRecord(record)) {
    throw new Error("refusing to write an incomplete integration ownership record");
  }
  const all = readRecords(dir);
  all[record.clientId] = record;
  ensureDir(recordsPath(dir));
  atomicWriteFile(recordsPath(dir), `${JSON.stringify({ schemaVersion: RECORDS_SCHEMA_VERSION, records: all }, null, 2)}\n`);
}

export function deleteRecord(clientId: IntegrationClientId, dir: string = integrationsDir()): void {
  const all = readRecords(dir);
  if (!(clientId in all)) return;
  delete all[clientId];
  ensureDir(recordsPath(dir));
  atomicWriteFile(recordsPath(dir), `${JSON.stringify({ schemaVersion: RECORDS_SCHEMA_VERSION, records: all }, null, 2)}\n`);
}

export function fragmentPathsOf(contribution: ManagedContribution): readonly (readonly string[])[] {
  return contribution.fragments.map((fragment: ManagedFragment) => fragment.path);
}

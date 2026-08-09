/**
 * The sole reader/writer for integrations/codex.json.
 *
 * Provenance can disappear when a corrupt record is treated as an empty one.
 * Reads therefore validate the complete
 * known shape, and updates refuse malformed bytes instead of manufacturing a new
 * baseline over evidence we can no longer trust.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir, withConfigMutationLockSync } from "../config";
import type {
  CodexArtifactId,
  CodexIntegrationRecord,
  CodexProvenanceEntry,
  CodexProvenanceLedger,
} from "./convergence-types";

const RECORD_FILENAME = "codex.json";
function recordPath(): string {
  return join(getConfigDir(), "integrations", RECORD_FILENAME);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function invalid(message: string) {
  return { kind: "invalid" as const, message };
}

function validateArtifact(value: unknown): value is CodexArtifactId {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "config":
    case "generated-profile":
    case "models-cache":
    case "injection-journal":
      return hasExactKeys(value, ["kind"]);
    case "active-catalog":
      return hasExactKeys(value, ["kind", "canonicalPath"])
        && typeof value.canonicalPath === "string";
    case "catalog-backup":
      return hasExactKeys(value, ["kind", "form", "canonicalPath"])
        && value.form === "hashed"
        && typeof value.canonicalPath === "string";
    default:
      return false;
  }
}

function validateBaseline(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "absent") return hasExactKeys(value, ["kind"]);
  return hasExactKeys(value, ["kind", "sha256", "bytesBase64"])
    && value.kind === "present"
    && typeof value.sha256 === "string"
    && typeof value.bytesBase64 === "string";
}

function validateEntry(value: unknown): value is CodexProvenanceEntry {
  return isPlainRecord(value)
    && hasExactKeys(value, ["artifact", "baseline", "postImage", "txId", "at"])
    && validateArtifact(value.artifact)
    && validateBaseline(value.baseline)
    && (typeof value.postImage === "string" || value.postImage === null)
    && typeof value.txId === "string"
    && typeof value.at === "string";
}

function validateLedger(value: unknown): value is CodexProvenanceLedger {
  return isPlainRecord(value)
    && hasExactKeys(value, ["entries"])
    && Array.isArray(value.entries)
    && value.entries.every(validateEntry);
}

function validateRecord(value: unknown): value is CodexIntegrationRecord {
  return isPlainRecord(value)
    && hasExactKeys(value, ["version", "provenance"])
    && value.version === 1
    && validateLedger(value.provenance);
}

function readIntegrationRecordUnlocked() {
  let raw: string;
  try {
    raw = readFileSync(recordPath(), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { kind: "missing" as const, record: null };
    return invalid(`Codex integration record is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return invalid("Codex integration record contains invalid JSON");
  }
  if (!validateRecord(parsed)) {
    return invalid("Codex integration record has an unsupported or malformed v1 shape");
  }
  return { kind: "ready" as const, record: parsed };
}

export const readIntegrationRecord = readIntegrationRecordUnlocked;

/**
 * Keep read, validation, and atomic replacement inside the config mutation
 * coordinator so callers cannot perform stale read/modify/write sequences.
 */
export const updateIntegrationRecord = (
  mutate: (record: CodexIntegrationRecord) => CodexIntegrationRecord,
) => {
  try {
    return withConfigMutationLockSync(() => {
      const read = readIntegrationRecordUnlocked();
      if (read.kind === "invalid") return read;
      const previous: CodexIntegrationRecord = read.kind === "ready"
        ? read.record
        : { version: 1, provenance: { entries: [] } };
      const proposed = mutate(previous);
      if (!validateRecord(proposed)) {
        return { kind: "invalid", message: "Codex integration record update produced a malformed v1 shape" };
      }
      const path = recordPath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      atomicWriteFile(path, `${JSON.stringify(proposed, null, 2)}\n`);
      return { kind: "updated", record: proposed };
    });
  } catch (error) {
    return {
      kind: "invalid",
      message: `Codex integration record update failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

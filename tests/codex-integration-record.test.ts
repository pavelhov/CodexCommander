import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readIntegrationRecord,
  updateIntegrationRecord,
} from "../src/codex/integration-record";
import type {
  CodexIntegrationRecord,
  CodexProvenanceEntry,
} from "../src/codex/convergence-types";

let codexCommanderHome = "";
let previousCodexCommanderHome: string | undefined;

function integrationRecordPath(): string {
  return join(codexCommanderHome, "integrations", "codex.json");
}

function writeRecord(value: unknown): void {
  mkdirSync(join(codexCommanderHome, "integrations"), { recursive: true });
  writeFileSync(integrationRecordPath(), JSON.stringify(value, null, 2));
}

function persistedRecord(): Record<string, unknown> {
  return JSON.parse(readFileSync(integrationRecordPath(), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
  codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-integration-record-"));
  process.env.CODEXCOMMANDER_HOME = codexCommanderHome;
});

afterEach(() => {
  if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
  rmSync(codexCommanderHome, { recursive: true, force: true });
});

describe("Codex integration record", () => {
  test("rejects a record without the current provenance ledger", () => {
    writeRecord({ version: 1 });

    expect(readIntegrationRecord()).toEqual({
      kind: "invalid",
      message: "Codex integration record has an unsupported or malformed v1 shape",
    });
  });

  test("rejects unknown keys at every persisted record level", () => {
    const entry = {
      artifact: { kind: "config" },
      baseline: { kind: "absent" },
      postImage: "post-image",
      txId: "tx-current",
      at: "2026-08-04T00:00:00.000Z",
    };
    const record = { version: 1, provenance: { entries: [entry] } };
    const artifactCases = [
      { kind: "config", unknown: true },
      { kind: "generated-profile", unknown: true },
      { kind: "active-catalog", canonicalPath: "/catalog", unknown: true },
      { kind: "catalog-backup", form: "hashed", canonicalPath: "/backup", unknown: true },
      { kind: "models-cache", unknown: true },
      { kind: "injection-journal", unknown: true },
    ];
    const malformedRecords = [
      { ...record, unknown: true },
      { ...record, provenance: { ...record.provenance, unknown: true } },
      { ...record, provenance: { entries: [{ ...entry, unknown: true }] } },
      ...artifactCases.map(artifact => ({
        ...record,
        provenance: { entries: [{ ...entry, artifact }] },
      })),
      {
        ...record,
        provenance: { entries: [{ ...entry, baseline: { kind: "absent", unknown: true } }] },
      },
      {
        ...record,
        provenance: {
          entries: [{
            ...entry,
            baseline: { kind: "present", sha256: "sha", bytesBase64: "Ynl0ZXM=", unknown: true },
          }],
        },
      },
    ];

    for (const malformed of malformedRecords) {
      writeRecord(malformed);
      expect(readIntegrationRecord()).toEqual({
        kind: "invalid",
        message: "Codex integration record has an unsupported or malformed v1 shape",
      });
    }
  });

  test("fails closed on unparseable bytes without invoking the mutator or resetting the file", () => {
    mkdirSync(join(codexCommanderHome, "integrations"), { recursive: true });
    writeFileSync(integrationRecordPath(), "{ definitely-not-json", "utf8");
    let invoked = false;

    const result = updateIntegrationRecord((record): CodexIntegrationRecord => {
      invoked = true;
      return record;
    });

    expect(result).toEqual({
      kind: "invalid",
      message: "Codex integration record contains invalid JSON",
    });
    expect(invoked).toBe(false);
    expect(readFileSync(integrationRecordPath(), "utf8")).toBe("{ definitely-not-json");
  });

  test("creates the current record on the first provenance write", () => {
    const firstEntry: CodexProvenanceEntry = {
      artifact: { kind: "config" },
      baseline: { kind: "absent" },
      postImage: "first-post-image",
      txId: "tx-first",
      at: "2026-08-04T00:00:00.000Z",
    };
    const result = updateIntegrationRecord(record => ({
      ...record,
      provenance: { entries: [firstEntry] },
    }));

    expect(result).toEqual({
      kind: "updated",
      record: { version: 1, provenance: { entries: [firstEntry] } },
    });
    expect(persistedRecord()).toEqual({
      version: 1,
      provenance: { entries: [firstEntry] },
    });
  });
});

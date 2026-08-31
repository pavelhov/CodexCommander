import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acknowledgeMediaRecoveryFence,
  inspectMediaJournalRecovery,
  mediaRecoveryBlocksStartup,
  quarantineMediaJournal,
  readMediaRecoveryFence,
} from "../src/images/media-recovery";
import { defaultMediaJournalPath } from "../src/images/video-job-store";

const previousHome = process.env.CODEXCOMMANDER_HOME;
let root: string;

beforeEach(() => {
  root = join(tmpdir(), `ccx-media-recovery-${randomUUID()}`);
  process.env.CODEXCOMMANDER_HOME = root;
  mkdirSync(join(root, "media"), { recursive: true, mode: 0o700 });
  chmodSync(join(root, "media"), 0o700);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
});

function journal(version: number): string {
  const path = defaultMediaJournalPath();
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE legacy (id TEXT); PRAGMA user_version = ${version}`);
  db.close();
  chmodSync(path, 0o600);
  return path;
}

describe("media recovery fence", () => {
  test("old journal quarantine preserves artifacts, fences admission, and CAS-acknowledges", () => {
    const path = journal(1);
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts, { mode: 0o700 });
    const artifact = join(artifacts, "keep.mp4");
    writeFileSync(artifact, "durable-artifact", { mode: 0o600 });

    expect(inspectMediaJournalRecovery()).toEqual({ cause: "old_schema", readOnly: false });
    const fence = quarantineMediaJournal(0);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(artifact)).toBe(true);
    expect(readMediaRecoveryFence()).toMatchObject({
      id: fence.id,
      revision: 0,
      acknowledged: false,
      restartRequired: true,
      cause: "old_schema",
    });
    expect(mediaRecoveryBlocksStartup()?.id).toBe(fence.id);

    expect(acknowledgeMediaRecoveryFence(fence.id, 1)).toBeNull();
    const acknowledged = acknowledgeMediaRecoveryFence(fence.id, 0);
    expect(acknowledged).toMatchObject({ revision: 1, acknowledged: true, restartRequired: true });
    expect(mediaRecoveryBlocksStartup()).toBeNull();
    expect(acknowledgeMediaRecoveryFence(fence.id, 0)).toBeNull();
    expect(existsSync(artifact)).toBe(true);

    journal(1);
    const laterFence = quarantineMediaJournal(0);
    expect(laterFence.id).not.toBe(fence.id);
    expect(readMediaRecoveryFence()).toMatchObject({ id: laterFence.id, revision: 0, acknowledged: false });
    expect(existsSync(artifact)).toBe(true);
  });

  test("future schemas remain read-only and cannot be quarantined", () => {
    const path = journal(99);
    expect(inspectMediaJournalRecovery()).toEqual({ cause: "future_schema", readOnly: true });
    expect(() => quarantineMediaJournal(0)).toThrow();
    expect(existsSync(path)).toBe(true);
    expect(readMediaRecoveryFence()).toBeNull();
  });
});

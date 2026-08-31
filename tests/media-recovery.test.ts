import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acknowledgeMediaRecoveryFence,
  inspectMediaJournalRecovery,
  mediaJournalQuarantineSupported,
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
  rmSync(root, { recursive: true, force: true });
});

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(path)) throw new Error(`Timed out waiting for child marker ${path}`);
}

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

    if (process.platform === "win32") {
      const before = readFileSync(path);
      expect(inspectMediaJournalRecovery()).toEqual({ cause: "old_schema", readOnly: true });
      expect(() => quarantineMediaJournal(0)).toThrow("media recovery is read-only");
      expect(readFileSync(path)).toEqual(before);
      expect(existsSync(artifact)).toBe(true);
      expect(readMediaRecoveryFence()).toBeNull();
      expect(readdirSync(join(root, "media")).some(name => name.startsWith("quarantine-"))).toBe(false);
      return;
    }

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

  test("Win32 quarantine policy cannot be bypassed by releasing proof handles", () => {
    const path = journal(1);
    const before = readFileSync(path);

    // The pure capability check is reachable on every CI host. The production
    // call edge is exercised below on Windows without exposing a platform
    // override that could bypass the policy.
    expect(mediaJournalQuarantineSupported("win32")).toBe(false);
    expect(mediaJournalQuarantineSupported("linux")).toBe(true);
    if (process.platform !== "win32") return;

    expect(() => quarantineMediaJournal(0)).toThrow("media recovery is read-only");

    expect(readFileSync(path)).toEqual(before);
    expect(readMediaRecoveryFence()).toBeNull();
    expect(readdirSync(join(root, "media")).some(name => name.startsWith("quarantine-"))).toBe(false);

    // The refusal releases every proof handle; it must not strand the journal
    // behind a stale SQLite lock.
    const writer = new Database(path, { strict: true });
    writer.exec("BEGIN IMMEDIATE; INSERT INTO legacy (id) VALUES ('after-refusal'); COMMIT");
    expect(writer.query<{ count: number }, []>("SELECT count(*) AS count FROM legacy").get()?.count).toBe(1);
    writer.close();
  });

  test("future schemas remain read-only and cannot be quarantined", () => {
    const path = journal(99);
    const before = readFileSync(path);
    expect(inspectMediaJournalRecovery()).toEqual({ cause: "future_schema", readOnly: true });
    expect(() => quarantineMediaJournal(0)).toThrow();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(before);
    expect(readMediaRecoveryFence()).toBeNull();
    expect(readdirSync(join(root, "media")).some(name => name.startsWith("quarantine-"))).toBe(false);
  });

  test("a locked journal remains read-only even when no recovery-owner lease exists", () => {
    const path = journal(1);
    const writer = new Database(path, { strict: true });
    writer.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    try {
      expect(inspectMediaJournalRecovery()).toEqual({ cause: "unavailable", readOnly: true });
      expect(() => quarantineMediaJournal(0)).toThrow("media recovery is read-only");
      expect(existsSync(path)).toBe(true);
      expect(readMediaRecoveryFence()).toBeNull();
    } finally {
      try { writer.exec("ROLLBACK"); } catch { /* fixture cleanup */ }
      writer.close();
    }
  });

  test("a primary BEGIN IMMEDIATE writer cannot be inspected or quarantined", () => {
    const path = journal(1);
    const writer = new Database(path, { strict: true });
    writer.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    try {
      expect(inspectMediaJournalRecovery()).toEqual({ cause: "unavailable", readOnly: true });
      expect(() => quarantineMediaJournal(0)).toThrow("media recovery is read-only");
      expect(existsSync(path)).toBe(true);
      expect(readMediaRecoveryFence()).toBeNull();
      expect(readdirSync(join(root, "media")).some(name => name.startsWith("quarantine-"))).toBe(false);
    } finally {
      try { writer.exec("ROLLBACK"); } catch { /* fixture cleanup */ }
      writer.close();
    }
  });

  test("an active owner stays read-only to a second process without changing journal bytes", async () => {
    const ready = join(root, "owner-ready");
    const continuePath = join(root, "owner-continue");
    const result = join(root, "owner-result");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "media-journal-owner-child.ts")], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        MEDIA_JOURNAL_TEST_HOME: root,
        MEDIA_JOURNAL_TEST_READY: ready,
        MEDIA_JOURNAL_TEST_CONTINUE: continuePath,
        MEDIA_JOURNAL_TEST_RESULT: result,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitForPath(ready);
      const path = defaultMediaJournalPath();
      const before = readFileSync(path);

      expect(inspectMediaJournalRecovery()).toEqual({ cause: "unavailable", readOnly: true });
      expect(() => quarantineMediaJournal(0)).toThrow("media recovery is read-only");
      expect(readFileSync(path)).toEqual(before);
      expect(readMediaRecoveryFence()).toBeNull();
      expect(readdirSync(join(root, "media")).some(name => name.startsWith("quarantine-"))).toBe(false);

      writeFileSync(continuePath, "continue", { mode: 0o600 });
      await waitForPath(result);
      expect(readFileSync(result, "utf8")).toBe("created");
      expect(await child.exited).toBe(0);
    } finally {
      try { writeFileSync(continuePath, "continue", { mode: 0o600 }); } catch { /* fixture cleanup */ }
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }, 15_000);
});

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  acknowledgeMediaRecoveryFence,
  inspectMediaJournalRecovery,
  mediaJournalQuarantineSupported,
  mediaRecoveryBlocksStartup,
  quarantineMediaJournal,
  readMediaRecoveryFence,
} from "../src/images/media-recovery";
import { MediaRuntime, RecoveryBlockedMediaRuntime } from "../src/images/media-runtime";
import {
  defaultMediaJournalPath,
  mediaJournalRecoveryOwnerPathForJournal,
  openVideoJobStore,
} from "../src/images/video-job-store";
import { videoOperationReplaySecretPathForJournal } from "../src/images/video-operation-secret";
import type { MediaCredentialBinding } from "../src/images/types";

const previousHome = process.env.CODEXCOMMANDER_HOME;
let root: string;
const binding: MediaCredentialBinding = {
  authSource: "subscription_oauth",
  providerKind: "canonical",
  slotRef: "media-slot:recovery-reset",
  identityDigest: `sha256:${"a".repeat(64)}`,
};
const request = {
  prompt: "ephemeral recovery test prompt",
  model: "grok-imagine-video-1.5",
  duration: 1,
  resolution: "1080p",
};

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

function currentJournalWithCompanions(): {
  path: string;
  ownerPath: string;
  secretPath: string;
  reservationId: string;
} {
  return currentJournalFixture(true);
}

function currentJournalFixture(corrupt: boolean): {
  path: string;
  ownerPath: string;
  secretPath: string;
  reservationId: string;
} {
  const path = defaultMediaJournalPath();
  const store = openVideoJobStore({ now: () => 1_000 });
  const reservation = store.reserveVideoJob({ binding, deadlineAt: 61_000 });
  expect(reservation.kind).toBe("created");
  if (reservation.kind !== "created") throw new Error("expected video reservation");
  store.close();
  if (corrupt) {
    const database = new Database(path, { strict: true });
    database.exec("DROP INDEX video_jobs_one_active_binding");
    database.close();
  }
  return {
    path,
    ownerPath: mediaJournalRecoveryOwnerPathForJournal(path),
    secretPath: videoOperationReplaySecretPathForJournal(path),
    reservationId: reservation.job.id,
  };
}

function writeRawFence(value: Record<string, unknown>): string {
  const path = join(root, "media", "media-recovery-fence.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function writeLegacyFence(
  acknowledged = false,
  options: { createdAt?: number; acknowledgedAt?: number } = {},
) {
  const createdAt = options.createdAt ?? 1_000;
  const value = {
    version: 1,
    id: randomUUID(),
    revision: acknowledged ? 1 : 0,
    acknowledged,
    restartRequired: true,
    createdAt,
    cause: "corrupt",
    ...(acknowledged ? { acknowledgedAt: options.acknowledgedAt ?? Math.max(2_000, createdAt) } : {}),
  };
  writeRawFence(value);
  const fence = readMediaRecoveryFence();
  if (!fence) throw new Error("expected legacy recovery fence");
  return fence;
}

function leaveRealWalBundle(path: string): void {
  const script = `
    import { Database } from "bun:sqlite";
    const database = new Database(${JSON.stringify(path)}, { strict: true });
    const mode = database.query("PRAGMA journal_mode = WAL").get()?.journal_mode;
    if (String(mode).toLowerCase() !== "wal") throw new Error("WAL unavailable");
    database.exec("PRAGMA wal_autocheckpoint = 0; CREATE TABLE legacy_wal_probe (value TEXT NOT NULL); INSERT INTO legacy_wal_probe VALUES ('committed-in-wal')");
    process.exit(0);
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`WAL fixture failed: ${result.stderr.toString()}`);
  }
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    expect(existsSync(sidecar)).toBe(true);
    chmodSync(sidecar, 0o600);
  }
}

function leaveHotRollbackJournal(path: string): void {
  const seed = new Database(path, { strict: true });
  seed.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE hot_rollback_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    BEGIN IMMEDIATE;
  `);
  const insert = seed.prepare("INSERT INTO hot_rollback_probe(payload) VALUES (?)");
  for (let index = 0; index < 200; index += 1) insert.run(`${"b".repeat(3_000)}-${index}`);
  seed.exec("COMMIT");
  seed.close();

  const script = `
    import { Database } from "bun:sqlite";
    import { readFileSync } from "node:fs";
    process.umask(0o077);
    const path = ${JSON.stringify(path)};
    const database = new Database(path, { strict: true });
    database.exec(\`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA cache_size = 10;
      PRAGMA cache_spill = ON;
      BEGIN IMMEDIATE;
      UPDATE hot_rollback_probe
         SET payload = 'changed-' || id || substr(payload, 1);
    \`);
    const magic = readFileSync(path + "-journal").subarray(0, 8).toString("hex");
    if (magic !== "d9d505f920a163d7") process.exit(3);
    process.kill(process.pid, "SIGKILL");
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CODEXCOMMANDER_HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(0);
  const rollbackJournal = `${path}-journal`;
  expect(existsSync(rollbackJournal)).toBe(true);
  chmodSync(rollbackJournal, 0o600);
  expect(readFileSync(rollbackJournal).subarray(0, 8).toString("hex")).toBe("d9d505f920a163d7");
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

  test("current journal quarantine durably bundles replay authority and admits fresh work only after acknowledgement", async () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const artifactDir = join(root, "artifacts");
    const artifact = join(artifactDir, "keep-current.mp4");
    mkdirSync(artifactDir, { mode: 0o700 });
    writeFileSync(artifact, "durable-artifact", { mode: 0o600 });
    const originalJournal = readFileSync(files.path);
    const originalOwner = readFileSync(files.ownerPath);
    const originalSecret = readFileSync(files.secretPath);

    expect(inspectMediaJournalRecovery()).toEqual({ cause: "corrupt", readOnly: false });
    const fence = quarantineMediaJournal(0);
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    expect(readdirSync(quarantine).sort()).toEqual([
      "media-recovery-manifest.json",
      basename(files.path),
      basename(files.secretPath),
    ].sort());
    expect(readFileSync(join(quarantine, basename(files.path)))).toEqual(originalJournal);
    expect(readFileSync(join(quarantine, basename(files.secretPath)))).toEqual(originalSecret);
    for (const path of [
      files.path,
      `${files.path}-journal`,
      `${files.path}-wal`,
      `${files.path}-shm`,
      files.secretPath,
      `${files.ownerPath}-journal`,
      `${files.ownerPath}-wal`,
      `${files.ownerPath}-shm`,
    ]) expect(existsSync(path)).toBe(false);
    expect(readFileSync(files.ownerPath)).toEqual(originalOwner);
    expect(existsSync(artifact)).toBe(true);

    const paidSubmit = mock(async () => ({ requestId: "must-not-dispatch" }));
    let blockedRuntime: MediaRuntime | RecoveryBlockedMediaRuntime;
    try {
      blockedRuntime = new MediaRuntime(openVideoJobStore(), { now: () => 2_000, submitVideoJob: paidSubmit });
    } catch {
      blockedRuntime = new RecoveryBlockedMediaRuntime();
    }
    await expect(blockedRuntime.submitVideo({ binding, deadlineAt: 62_000, request }))
      .rejects.toMatchObject({ name: "MediaRecoveryBlockedError" });
    expect(paidSubmit).toHaveBeenCalledTimes(0);
    await blockedRuntime.shutdown();
    expect(mediaRecoveryBlocksStartup()?.id).toBe(fence.id);

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toMatchObject({
      id: fence.id,
      revision: 1,
      acknowledged: true,
    });
    expect(readFileSync(join(quarantine, basename(files.ownerPath)))).toEqual(originalOwner);
    expect(existsSync(files.ownerPath)).toBe(false);
    expect(mediaRecoveryBlocksStartup()).toBeNull();
    const fresh = openVideoJobStore({ now: () => 2_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 62_000 }).kind).toBe("created");
    fresh.close();
    expect(readFileSync(files.secretPath)).not.toEqual(originalSecret);
    expect(existsSync(artifact)).toBe(true);
  });

  test("the process-global recovery fence blocks an exact custom journal with zero paid admission", async () => {
    if (process.platform === "win32") return;
    currentJournalWithCompanions();
    const fence = quarantineMediaJournal(0);
    const customPath = join(root, "custom-domain", "custom-video-journal.sqlite");
    const customOwnerPath = mediaJournalRecoveryOwnerPathForJournal(customPath);
    const customSecretPath = videoOperationReplaySecretPathForJournal(customPath);

    expect(() => openVideoJobStore({ path: customPath, now: () => 2_000 }))
      .toThrow("pending recovery acknowledgement");
    const paidSubmit = mock(async () => ({ requestId: "must-not-dispatch-custom" }));
    let blockedRuntime: MediaRuntime | RecoveryBlockedMediaRuntime;
    try {
      blockedRuntime = new MediaRuntime(openVideoJobStore({ path: customPath, now: () => 2_000 }), {
        now: () => 2_000,
        submitVideoJob: paidSubmit,
      });
    } catch {
      blockedRuntime = new RecoveryBlockedMediaRuntime();
    }
    await expect(blockedRuntime.submitVideo({ binding, deadlineAt: 62_000, request }))
      .rejects.toMatchObject({ name: "MediaRecoveryBlockedError" });
    expect(paidSubmit).toHaveBeenCalledTimes(0);
    await blockedRuntime.shutdown();
    for (const path of [customPath, customOwnerPath, customSecretPath]) {
      expect(existsSync(path)).toBe(false);
    }

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toMatchObject({ acknowledged: true });
    const fresh = openVideoJobStore({ path: customPath, now: () => 3_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 63_000 }).kind).toBe("created");
    fresh.close();

    const customFencePath = join(root, "custom-domain", "media-recovery-fence.json");
    writeFileSync(customFencePath, `${JSON.stringify({
      version: 2,
      id: randomUUID(),
      revision: 0,
      acknowledged: false,
      restartRequired: true,
      createdAt: 4_000,
      cause: "corrupt",
    })}\n`, { mode: 0o600 });
    chmodSync(customFencePath, 0o600);
    expect(() => openVideoJobStore({ path: customPath, now: () => 4_000 }))
      .toThrow("pending recovery acknowledgement");
  });

  test("migrates a coherent fence-only v1 recovery before acknowledgement", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = writeLegacyFence();
    expect(fence).toMatchObject({ version: 1, revision: 0, acknowledged: false });
    expect(mediaRecoveryBlocksStartup()?.id).toBe(fence.id);
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    const acknowledged = acknowledgeMediaRecoveryFence(fence.id, fence.revision);
    expect(acknowledged).toMatchObject({ version: 2, revision: 1, acknowledged: true });
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    expect(JSON.parse(readFileSync(join(quarantine, "media-recovery-manifest.json"), "utf8")))
      .toMatchObject({ version: 2, fenceId: fence.id });
    for (const path of [files.path, files.secretPath, files.ownerPath]) {
      expect(existsSync(path)).toBe(false);
      expect(existsSync(join(quarantine, basename(path)))).toBe(true);
    }
    const fresh = openVideoJobStore({ now: () => 3_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 63_000 }).kind).toBe("created");
    fresh.close();
  });

  test.each([
    { label: "temp write", phase: "write" as const },
    { label: "temp fsync", phase: "fsync" as const },
    { label: "manifest rename", phase: "rename" as const },
  ])("resumes coherent v1 migration after a crash at the $label seam", ({ phase }) => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = writeLegacyFence();
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    const manifest = join(quarantine, "media-recovery-manifest.json");
    const temp = join(quarantine, ".media-recovery-manifest.tmp");
    const crash = () => { throw new Error(`simulated manifest ${phase} crash`); };
    const options = phase === "write"
      ? { afterManifestTempWrite: crash }
      : phase === "fsync"
        ? { afterManifestTempSync: crash }
        : { afterManifestRename: crash };

    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision, options))
      .toThrow("legacy media recovery cannot be migrated safely");
    expect(readMediaRecoveryFence()).toMatchObject({ version: 1, revision: 0, acknowledged: false });
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");
    expect(existsSync(manifest)).toBe(phase === "rename");
    expect(existsSync(temp)).toBe(phase !== "rename");
    expect(existsSync(files.path)).toBe(false);
    expect(existsSync(join(quarantine, basename(files.path)))).toBe(true);
    for (const path of [files.secretPath, files.ownerPath]) expect(existsSync(path)).toBe(true);

    if (phase === "write") {
      // A private but truncated staging file is never authoritative and can be
      // replaced from the still-locked coherent source bundle on retry.
      writeFileSync(temp, "{\"version\":2", { mode: 0o600 });
      chmodSync(temp, 0o600);
    }
    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toMatchObject({ version: 2, revision: 1, acknowledged: true });
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(manifest)).toBe(true);
    const fresh = openVideoJobStore({ now: () => 3_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 63_000 }).kind).toBe("created");
    fresh.close();
  });

  test("rebinds and synchronizes a rename-visible manifest before resuming any move", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = writeLegacyFence();
    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision, {
      afterManifestRename() { throw new Error("simulated power loss before manifest directory fsync"); },
    })).toThrow("legacy media recovery cannot be migrated safely");
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    expect(existsSync(join(quarantine, "media-recovery-manifest.json"))).toBe(true);

    const ordering: string[] = [];
    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision, {
      afterManifestDurable() { ordering.push("manifest-durable"); },
      afterMove(name) {
        ordering.push(`move:${name}`);
        if (name === basename(files.secretPath)) throw new Error("simulated loss after durable manifest proof");
      },
    })).toThrow("simulated loss after durable manifest proof");
    expect(ordering[0]).toBe("manifest-durable");
    expect(ordering.some(value => value.startsWith("move:"))).toBe(true);
    expect(readMediaRecoveryFence()).toMatchObject({ version: 1, revision: 0, acknowledged: false });
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toMatchObject({ version: 2, revision: 1, acknowledged: true });
  });

  test.each([
    { label: "v1 pending revision 1", version: 1, revision: 1, acknowledged: false },
    { label: "v1 acknowledged revision 0", version: 1, revision: 0, acknowledged: true },
    { label: "v1 acknowledged revision 2", version: 1, revision: 2, acknowledged: true },
    { label: "v2 pending revision 1", version: 2, revision: 1, acknowledged: false },
    { label: "v2 acknowledged revision 0", version: 2, revision: 0, acknowledged: true },
    { label: "v2 acknowledged revision 3", version: 2, revision: 3, acknowledged: true },
  ])("rejects impossible $label before any recovery mutation", ({ version, revision, acknowledged }) => {
    const files = currentJournalWithCompanions();
    const before = [files.path, files.secretPath, files.ownerPath].map(path => readFileSync(path));
    const id = randomUUID();
    writeRawFence({
      version,
      id,
      revision,
      acknowledged,
      restartRequired: true,
      createdAt: 1_000,
      cause: "corrupt",
      ...(acknowledged ? { acknowledgedAt: 2_000 } : {}),
    });

    expect(() => readMediaRecoveryFence()).toThrow("media recovery fence is malformed");
    expect(() => acknowledgeMediaRecoveryFence(id, revision)).toThrow("media recovery fence is malformed");
    expect(readdirSync(join(root, "media")).some(name => name.startsWith(`quarantine-${id}`))).toBe(false);
    [files.path, files.secretPath, files.ownerPath].forEach((path, index) => {
      expect(readFileSync(path)).toEqual(before[index]!);
    });
  });

  test("clamps a migrated acknowledgement timestamp against a future legacy creation time", () => {
    if (process.platform === "win32") return;
    currentJournalWithCompanions();
    const createdAt = Date.now() + 60_000;
    const fence = writeLegacyFence(false, { createdAt });

    const acknowledged = acknowledgeMediaRecoveryFence(fence.id, fence.revision);
    expect(acknowledged).toMatchObject({ version: 2, revision: 1, acknowledged: true, acknowledgedAt: createdAt });
    expect(readMediaRecoveryFence()).toMatchObject({ id: fence.id, acknowledgedAt: createdAt });
    const fresh = openVideoJobStore({ now: () => createdAt + 1 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: createdAt + 60_001 }).kind).toBe("created");
    fresh.close();
  });

  test.each([
    { label: "reordered entries", mutate: "reorder" as const },
    { label: "a missing owner-sidecar placeholder", mutate: "missing" as const },
    { label: "a missing main-shm placeholder", mutate: "missing-main-shm" as const },
  ])("rejects a manifest with $label before moving the recovery owner", ({ mutate }) => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = quarantineMediaJournal(0);
    const manifestPath = join(root, "media", `quarantine-${fence.id}`, "media-recovery-manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(original) as { files: Array<{ name: string }> };
    if (mutate === "reorder") {
      const ownerIndex = parsed.files.findIndex(entry => entry.name === basename(files.ownerPath));
      if (ownerIndex < 0) throw new Error("expected owner manifest entry");
      const [owner] = parsed.files.splice(ownerIndex, 1);
      parsed.files.unshift(owner!);
    } else {
      const sidecar = mutate === "missing"
        ? `${basename(files.ownerPath)}-wal`
        : `${basename(files.path)}-shm`;
      parsed.files = parsed.files.filter(entry => entry.name !== sidecar);
    }
    writeFileSync(manifestPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);

    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toThrow("media recovery manifest is malformed");
    expect(readMediaRecoveryFence()).toMatchObject({ revision: 0, acknowledged: false });
    expect(existsSync(files.ownerPath)).toBe(true);
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    writeFileSync(manifestPath, original, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toMatchObject({ acknowledged: true });
  });

  test("resumes a v1 migration crash after the durable manifest and replay-secret move", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = writeLegacyFence();
    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision, {
      afterMove(name) {
        if (name === basename(files.secretPath)) throw new Error("simulated legacy migration crash");
      },
    })).toThrow();
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    expect(existsSync(join(quarantine, "media-recovery-manifest.json"))).toBe(true);
    expect(existsSync(files.secretPath)).toBe(false);
    expect(existsSync(join(quarantine, basename(files.secretPath)))).toBe(true);
    expect(readMediaRecoveryFence()).toMatchObject({ version: 1, revision: 0, acknowledged: false });
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toMatchObject({ version: 2, revision: 1, acknowledged: true });
    const fresh = openVideoJobStore({ now: () => 3_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 63_000 }).kind).toBe("created");
    fresh.close();
  });

  test("resumes a real WAL v1 migration after process loss at durable manifest staging", () => {
    if (process.platform === "win32") return;
    const files = currentJournalFixture(false);
    leaveRealWalBundle(files.path);
    const originalWal = readFileSync(`${files.path}-wal`);
    expect(originalWal.byteLength).toBeGreaterThan(32);
    const fence = writeLegacyFence();
    const script = `
      import { acknowledgeMediaRecoveryFence } from "./src/images/media-recovery.ts";
      acknowledgeMediaRecoveryFence(${JSON.stringify(fence.id)}, ${fence.revision}, {
        afterManifestTempSync() { process.exit(87); },
      });
      process.exit(2);
    `;
    const crashed = Bun.spawnSync([process.execPath, "--eval", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CODEXCOMMANDER_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(crashed.exitCode).toBe(87);
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    expect(existsSync(join(quarantine, ".media-recovery-manifest.tmp"))).toBe(true);
    expect(existsSync(join(quarantine, "media-recovery-manifest.json"))).toBe(false);
    expect(readMediaRecoveryFence()).toMatchObject({ version: 1, revision: 0, acknowledged: false });
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toMatchObject({ version: 2, revision: 1, acknowledged: true });
    expect(readFileSync(join(quarantine, `${basename(files.path)}-wal`))).toHaveLength(0);
    expect(existsSync(join(quarantine, `${basename(files.path)}-shm`))).toBe(true);
    const recovered = new Database(join(quarantine, basename(files.path)), { readonly: true, strict: true });
    expect(recovered.query<{ value: string }, []>("SELECT value FROM legacy_wal_probe").get()?.value)
      .toBe("committed-in-wal");
    recovered.close();
    const fresh = openVideoJobStore({ now: () => 3_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 63_000 }).kind).toBe("created");
    fresh.close();
  });

  test("reassembles and migrates a partially moved v1 bundle with real WAL and shm companions", () => {
    if (process.platform === "win32") return;
    const files = currentJournalFixture(false);
    leaveRealWalBundle(files.path);
    const originalWal = readFileSync(`${files.path}-wal`);
    expect(originalWal.byteLength).toBeGreaterThan(32);
    expect(readFileSync(`${files.path}-shm`).byteLength).toBeGreaterThan(0);
    const fence = writeLegacyFence();
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    mkdirSync(quarantine, { mode: 0o700 });
    chmodSync(quarantine, 0o700);
    renameSync(`${files.path}-wal`, join(quarantine, `${basename(files.path)}-wal`));
    expect(existsSync(`${files.path}-wal`)).toBe(false);
    expect(existsSync(`${files.path}-shm`)).toBe(true);

    let normalizationCrashed = false;
    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision, {
      afterMove(name) {
        if (!normalizationCrashed && name === `${basename(files.path)}-shm`) {
          normalizationCrashed = true;
          throw new Error("simulated legacy sidecar-normalization crash");
        }
      },
    })).toThrow();
    expect(normalizationCrashed).toBe(true);
    expect(existsSync(`${files.path}-wal`)).toBe(false);
    expect(existsSync(`${files.path}-shm`)).toBe(false);
    expect(existsSync(join(quarantine, `${basename(files.path)}-shm`))).toBe(true);
    expect(existsSync(files.path)).toBe(true);
    expect(existsSync(join(quarantine, "media-recovery-manifest.json"))).toBe(false);
    expect(readMediaRecoveryFence()).toMatchObject({ version: 1, revision: 0, acknowledged: false });

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toMatchObject({ version: 2, revision: 1, acknowledged: true });
    expect(readFileSync(join(quarantine, `${basename(files.path)}-wal`))).toHaveLength(0);
    for (const source of [
      files.path,
      `${files.path}-wal`,
      `${files.path}-shm`,
      files.secretPath,
      files.ownerPath,
    ]) {
      const quarantined = join(quarantine, basename(source));
      if (existsSync(quarantined)) renameSync(quarantined, source);
    }
    const restored = new Database(files.path, { readonly: true, strict: true });
    expect(restored.query<{ value: string }, []>("SELECT value FROM legacy_wal_probe").get()?.value)
      .toBe("committed-in-wal");
    restored.close();
    const reopened = openVideoJobStore({ now: () => 3_000 });
    expect(reopened.getVideoJob(files.reservationId)?.id).toBe(files.reservationId);
    reopened.close();
  });

  test("re-acknowledges a coherent acknowledged v1 layout with replay secret and owner at source", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const id = randomUUID();
    const quarantine = join(root, "media", `quarantine-${id}`);
    mkdirSync(quarantine, { mode: 0o700 });
    chmodSync(quarantine, 0o700);
    for (const source of [`${files.path}-journal`, `${files.path}-wal`, `${files.path}-shm`, files.path]) {
      if (existsSync(source)) renameSync(source, join(quarantine, basename(source)));
    }
    const legacyAcknowledgedAt = Date.now() + 60_000;
    const value = {
      version: 1,
      id,
      revision: 1,
      acknowledged: true,
      restartRequired: true,
      createdAt: 1_000,
      acknowledgedAt: legacyAcknowledgedAt,
      cause: "corrupt",
    };
    const fencePath = join(root, "media", "media-recovery-fence.json");
    writeFileSync(fencePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(fencePath, 0o600);
    const fence = readMediaRecoveryFence();
    if (!fence) throw new Error("expected acknowledged legacy fence");

    expect(mediaRecoveryBlocksStartup()).toMatchObject({ id, version: 1, acknowledged: true });
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");
    expect(existsSync(files.secretPath)).toBe(true);
    expect(existsSync(files.ownerPath)).toBe(true);
    expect(acknowledgeMediaRecoveryFence(id, fence.revision))
      .toMatchObject({ id, version: 2, revision: 2, acknowledged: true, acknowledgedAt: legacyAcknowledgedAt });
    expect(existsSync(files.secretPath)).toBe(false);
    expect(existsSync(files.ownerPath)).toBe(false);
    expect(existsSync(join(quarantine, basename(files.secretPath)))).toBe(true);
    expect(existsSync(join(quarantine, basename(files.ownerPath)))).toBe(true);
    const fresh = openVideoJobStore({ now: () => 3_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 63_000 }).kind).toBe("created");
    fresh.close();
  });

  test("keeps an incoherent v1 bundle fenced and leaves every remnant untouched for manual restoration", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const journalBefore = readFileSync(files.path);
    const secretBefore = readFileSync(files.secretPath);
    const ownerBefore = readFileSync(files.ownerPath);
    const fence = writeLegacyFence();
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    const remnant = join(quarantine, "unrecognized-recovery-remnant");
    mkdirSync(quarantine, { mode: 0o700 });
    chmodSync(quarantine, 0o700);
    writeFileSync(remnant, "do-not-delete", { mode: 0o600 });

    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toThrow("restore the exact media journal, replay secret, and recovery owner bundle");
    expect(readMediaRecoveryFence()).toMatchObject({ id: fence.id, version: 1, revision: 0, acknowledged: false });
    expect(readFileSync(files.path)).toEqual(journalBefore);
    expect(readFileSync(files.secretPath)).toEqual(secretBefore);
    expect(readFileSync(files.ownerPath)).toEqual(ownerBefore);
    expect(readFileSync(remnant, "utf8")).toBe("do-not-delete");
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");
  });

  test("keeps a legacy bundle with a missing replay secret fenced and untouched", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const journalBefore = readFileSync(files.path);
    const ownerBefore = readFileSync(files.ownerPath);
    unlinkSync(files.secretPath);
    const fence = writeLegacyFence();

    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toThrow("legacy replay secret is not intact at its source path");
    expect(readMediaRecoveryFence()).toMatchObject({ id: fence.id, version: 1, revision: 0, acknowledged: false });
    expect(readFileSync(files.path)).toEqual(journalBefore);
    expect(readFileSync(files.ownerPath)).toEqual(ownerBefore);
    expect(existsSync(files.secretPath)).toBe(false);
    expect(existsSync(join(root, "media", `quarantine-${fence.id}`))).toBe(false);
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");
  });

  test("a busy legacy primary refuses acknowledgement before creating or moving recovery state", async () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = writeLegacyFence();
    const ready = join(root, "legacy-writer-ready");
    const release = join(root, "legacy-writer-release");
    const script = `
      import { Database } from "bun:sqlite";
      import { existsSync, writeFileSync } from "node:fs";
      const db = new Database(${JSON.stringify(files.path)}, { strict: true });
      db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      writeFileSync(${JSON.stringify(ready)}, "ready", { mode: 0o600 });
      while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(10);
      db.exec("ROLLBACK");
      db.close();
    `;
    const writer = Bun.spawn([process.execPath, "--eval", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CODEXCOMMANDER_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitForPath(ready);
      const fencePath = join(root, "media", "media-recovery-fence.json");
      const before = new Map([
        [files.path, readFileSync(files.path)],
        [files.secretPath, readFileSync(files.secretPath)],
        [files.ownerPath, readFileSync(files.ownerPath)],
        [fencePath, readFileSync(fencePath)],
      ]);
      const quarantine = join(root, "media", `quarantine-${fence.id}`);

      expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision))
        .toThrow("legacy journal is busy");
      expect(existsSync(quarantine)).toBe(false);
      for (const [path, bytes] of before) expect(readFileSync(path)).toEqual(bytes);
      expect(readMediaRecoveryFence()).toMatchObject({ id: fence.id, version: 1, revision: 0, acknowledged: false });
      expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");
    } finally {
      writeFileSync(release, "release", { mode: 0o600 });
      await writer.exited;
    }
    expect(writer.exitCode).toBe(0);
    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toMatchObject({ id: fence.id, version: 2, revision: 1, acknowledged: true });
  });

  test("normalizes a genuine hot rollback journal across SIGKILL and preserves rollback integrity", () => {
    if (process.platform === "win32") return;
    const files = currentJournalFixture(false);
    leaveHotRollbackJournal(files.path);
    const fence = writeLegacyFence();
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    mkdirSync(quarantine, { mode: 0o700 });
    chmodSync(quarantine, 0o700);
    const rollbackName = `${basename(files.path)}-journal`;

    const script = `
      import { acknowledgeMediaRecoveryFence } from "./src/images/media-recovery.ts";
      acknowledgeMediaRecoveryFence(${JSON.stringify(fence.id)}, ${fence.revision}, {
        afterMove(name) {
          if (name === ${JSON.stringify(rollbackName)}) process.exit(88);
        },
      });
      process.exit(2);
    `;
    const crashed = Bun.spawnSync([process.execPath, "--eval", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CODEXCOMMANDER_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(crashed.exitCode).toBe(88);
    expect(existsSync(`${files.path}-journal`)).toBe(false);
    expect(existsSync(files.path)).toBe(true);
    expect(readFileSync(join(quarantine, rollbackName)).subarray(0, 8).toString("hex"))
      .toBe("d9d505f920a163d7");
    expect(readMediaRecoveryFence()).toMatchObject({ id: fence.id, version: 1, revision: 0, acknowledged: false });
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toMatchObject({ id: fence.id, version: 2, revision: 1, acknowledged: true });
    const quarantinedJournal = join(quarantine, basename(files.path));
    const recovered = new Database(quarantinedJournal, { readonly: true, strict: true });
    expect(recovered.query<{ count: number }, []>("SELECT count(*) AS count FROM hot_rollback_probe").get()?.count)
      .toBe(200);
    expect(recovered.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM hot_rollback_probe WHERE payload LIKE 'changed-%'",
    ).get()?.count).toBe(0);
    recovered.close();
    expect(existsSync(join(quarantine, rollbackName))).toBe(false);
    const fresh = openVideoJobStore({ now: () => 3_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 63_000 }).kind).toBe("created");
    fresh.close();
  });

  test.each([
    { label: "after the fence", role: "fence" as const },
    { label: "after the replay secret", role: "secret" as const },
    { label: "after the primary journal", role: "journal" as const },
  ])("resumes a partial current-schema quarantine $label without pre-ack admission", ({ role }) => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const target = role === "secret"
      ? basename(files.secretPath)
      : role === "journal"
        ? basename(files.path)
        : undefined;
    expect(() => quarantineMediaJournal(0, {
      ...(role === "fence" ? { afterFence: () => { throw new Error("simulated process loss"); } } : {}),
      ...(target ? {
        afterMove(name) {
          if (name === target) throw new Error("simulated process loss");
        },
      } : {}),
    })).toThrow("simulated process loss");

    const fence = readMediaRecoveryFence();
    expect(fence).toMatchObject({ revision: 0, acknowledged: false });
    if (!fence) throw new Error("expected recovery fence");
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");
    expect(mediaRecoveryBlocksStartup()?.id).toBe(fence.id);

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toMatchObject({
      revision: 1,
      acknowledged: true,
    });
    const fresh = openVideoJobStore({ now: () => 2_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 62_000 }).kind).toBe("created");
    fresh.close();
  });

  test("resumes a real WAL quarantine after process loss at the durable v2 fence", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    leaveRealWalBundle(files.path);
    const originalWal = readFileSync(`${files.path}-wal`);
    expect(originalWal.byteLength).toBeGreaterThan(32);
    const script = `
      import { quarantineMediaJournal } from "./src/images/media-recovery.ts";
      quarantineMediaJournal(0, { afterFence() { process.exit(86); } });
      process.exit(2);
    `;
    const crashed = Bun.spawnSync([process.execPath, "--eval", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CODEXCOMMANDER_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(crashed.exitCode).toBe(86);
    const fence = readMediaRecoveryFence();
    expect(fence).toMatchObject({ version: 2, revision: 0, acknowledged: false });
    if (!fence) throw new Error("expected recovery fence");
    expect(existsSync(`${files.path}-wal`)).toBe(true);
    expect(existsSync(`${files.path}-shm`)).toBe(true);
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toMatchObject({ version: 2, revision: 1, acknowledged: true });
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    expect(readFileSync(join(quarantine, `${basename(files.path)}-wal`))).toHaveLength(0);
    expect(existsSync(join(quarantine, `${basename(files.path)}-shm`))).toBe(true);
    const recovered = new Database(join(quarantine, basename(files.path)), { readonly: true, strict: true });
    expect(recovered.query<{ value: string }, []>("SELECT value FROM legacy_wal_probe").get()?.value)
      .toBe("committed-in-wal");
    recovered.close();
    const fresh = openVideoJobStore({ now: () => 3_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 63_000 }).kind).toBe("created");
    fresh.close();
  });

  test("an ordinary current-schema WAL quarantine stays manifest-exact after SQLite closes", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    leaveRealWalBundle(files.path);
    expect(readFileSync(`${files.path}-wal`).byteLength).toBeGreaterThan(32);

    const fence = quarantineMediaJournal(0);
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    expect(readFileSync(join(quarantine, `${basename(files.path)}-wal`))).toHaveLength(0);
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");
    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision))
      .toMatchObject({ version: 2, revision: 1, acknowledged: true });

    const recovered = new Database(join(quarantine, basename(files.path)), { readonly: true, strict: true });
    expect(recovered.query<{ value: string }, []>("SELECT value FROM legacy_wal_probe").get()?.value)
      .toBe("committed-in-wal");
    recovered.close();
  });

  test("resumes acknowledgement after the recovery owner moved but before the fence CAS", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = quarantineMediaJournal(0);
    expect(existsSync(files.ownerPath)).toBe(true);
    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision, {
      afterMove(name) {
        if (name === basename(files.ownerPath)) throw new Error("simulated process loss");
      },
    })).toThrow("simulated process loss");
    expect(readMediaRecoveryFence()).toMatchObject({ revision: 0, acknowledged: false });
    expect(existsSync(files.ownerPath)).toBe(false);
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toMatchObject({
      revision: 1,
      acknowledged: true,
    });
    const fresh = openVideoJobStore({ now: () => 2_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 62_000 }).kind).toBe("created");
    fresh.close();
  });

  test("a losing concurrent acknowledgement cannot recreate the moved recovery owner", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = quarantineMediaJournal(0);
    let loserError: unknown;
    const winner = acknowledgeMediaRecoveryFence(fence.id, fence.revision, {
      afterRecoveryLease() {
        try {
          acknowledgeMediaRecoveryFence(fence.id, fence.revision);
        } catch (error) {
          loserError = error;
        }
      },
    });
    expect(loserError).toBeInstanceOf(Error);
    expect((loserError as Error).message).toContain("acknowledgement is busy");
    expect(winner).toMatchObject({ revision: 1, acknowledged: true });
    expect(existsSync(files.ownerPath)).toBe(false);
    expect(readMediaRecoveryFence()).toMatchObject({ revision: 1, acknowledged: true });

    const fresh = openVideoJobStore({ now: () => 2_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 62_000 }).kind).toBe("created");
    fresh.close();
  });

  test("a cross-process acknowledgement loser is rejected by the recovery coordinator", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = quarantineMediaJournal(0);
    let loser: ReturnType<typeof Bun.spawnSync> | undefined;
    const winner = acknowledgeMediaRecoveryFence(fence.id, fence.revision, {
      afterRecoveryLease() {
        const script = `
          import { acknowledgeMediaRecoveryFence } from "./src/images/media-recovery.ts";
          try {
            const result = acknowledgeMediaRecoveryFence(${JSON.stringify(fence.id)}, ${fence.revision});
            process.stderr.write(result === null ? "unexpected null" : "unexpected acknowledgement");
            process.exit(2);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes("acknowledgement is busy")) {
              process.stderr.write(message);
              process.exit(3);
            }
          }
        `;
        loser = Bun.spawnSync([process.execPath, "--eval", script], {
          cwd: join(import.meta.dir, ".."),
          env: { ...process.env, CODEXCOMMANDER_HOME: root },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(loser.exitCode).toBe(0);
        expect(existsSync(files.ownerPath)).toBe(true);
      },
    });
    expect(loser?.exitCode).toBe(0);
    expect(winner).toMatchObject({ revision: 1, acknowledged: true });
    expect(existsSync(files.ownerPath)).toBe(false);
    expect(readMediaRecoveryFence()).toMatchObject({ revision: 1, acknowledged: true });

    const fresh = openVideoJobStore({ now: () => 2_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 62_000 }).kind).toBe("created");
    fresh.close();
  });

  test("a completion-fsync failure keeps the moved owner fenced and acknowledgement resumable", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = quarantineMediaJournal(0);
    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision, {
      fsyncDirectory() { throw new Error("simulated directory fsync failure"); },
    })).toThrow("simulated directory fsync failure");
    expect(readMediaRecoveryFence()).toMatchObject({ revision: 0, acknowledged: false });
    expect(existsSync(files.ownerPath)).toBe(false);
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toMatchObject({
      revision: 1,
      acknowledged: true,
    });
    const fresh = openVideoJobStore({ now: () => 2_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 62_000 }).kind).toBe("created");
    fresh.close();
  });

  test("store admission repairs and proves an acknowledged fence whose rename sync reported failure", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    const fence = quarantineMediaJournal(0);
    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision, {
      fenceFsyncDirectory() { throw new Error("simulated fence directory fsync failure"); },
    })).toThrow("simulated fence directory fsync failure");
    expect(readMediaRecoveryFence()).toMatchObject({ revision: 1, acknowledged: true });
    expect(existsSync(files.ownerPath)).toBe(false);

    const fresh = openVideoJobStore({ now: () => 2_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 62_000 }).kind).toBe("created");
    fresh.close();
  });

  test("a store locked preflight rejects a concurrently quarantined partial acknowledgement", () => {
    if (process.platform === "win32") return;
    let store = openVideoJobStore({ now: () => 1_000 });
    expect(store.reserveVideoJob({ binding, deadlineAt: 61_000 }).kind).toBe("created");
    store.close();
    let fence: ReturnType<typeof quarantineMediaJournal> | undefined;
    let acknowledgementError: unknown;

    expect(() => openVideoJobStore({
      recoveryFencePreflightSeam() {
        fence = quarantineMediaJournal(0);
        try {
          acknowledgeMediaRecoveryFence(fence.id, fence.revision, {
            afterMove(name) {
              if (name.endsWith(".recovery-owner.sqlite")) throw new Error("must stay serialized");
            },
          });
        } catch (error) {
          acknowledgementError = error;
        }
      },
    })).toThrow();
    expect(acknowledgementError).toBeInstanceOf(Error);
    expect((acknowledgementError as Error).message).toContain("must stay serialized");
    expect(fence).toMatchObject({ revision: 0, acknowledged: false });
    if (!fence) throw new Error("expected recovery fence");
    expect(mediaRecoveryBlocksStartup()?.id).toBe(fence.id);
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toMatchObject({ acknowledged: true });
    store = openVideoJobStore({ now: () => 2_000 });
    expect(store.reserveVideoJob({ binding, deadlineAt: 62_000 }).kind).toBe("created");
    store.close();
  });

  test("acknowledgement rejects exact unrecorded SQLite remnants and keeps admission fenced", () => {
    if (process.platform === "win32") return;
    const files = currentJournalWithCompanions();
    expect(() => quarantineMediaJournal(0, {
      afterFence() { throw new Error("simulated process loss"); },
    })).toThrow("simulated process loss");
    const fence = readMediaRecoveryFence();
    if (!fence) throw new Error("expected recovery fence");
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    const unexpectedSource = `${files.path}-wal`;
    const unexpectedDestination = join(quarantine, `${basename(files.ownerPath)}-shm`);
    writeFileSync(unexpectedSource, "unexpected-source", { mode: 0o600 });
    writeFileSync(unexpectedDestination, "unexpected-destination", { mode: 0o600 });

    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toThrow("unrecorded companion");
    expect(readMediaRecoveryFence()).toMatchObject({ revision: 0, acknowledged: false });
    expect(() => openVideoJobStore()).toThrow("pending recovery acknowledgement");

    unlinkSync(unexpectedSource);
    unlinkSync(unexpectedDestination);
    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toMatchObject({
      revision: 1,
      acknowledged: true,
    });
    const fresh = openVideoJobStore({ now: () => 2_000 });
    expect(fresh.reserveVideoJob({ binding, deadlineAt: 62_000 }).kind).toBe("created");
    fresh.close();
  });

  test("a coherently restored quarantine bundle retains the replay secret and retry fence", () => {
    if (process.platform === "win32") return;
    const path = defaultMediaJournalPath();
    const ownerPath = mediaJournalRecoveryOwnerPathForJournal(path);
    const secretPath = videoOperationReplaySecretPathForJournal(path);
    const operationKey = `hmac-sha256:${"3".repeat(64)}`;
    const requestSemanticsDigest = `hmac-sha256:${"4".repeat(64)}`;
    let store = openVideoJobStore({ now: () => 1_000 });
    const original = store.reserveVideoJob({
      binding,
      deadlineAt: 61_000,
      operationKey,
      requestSemanticsDigest,
    });
    expect(original.kind).toBe("created");
    store.close();

    const fence = quarantineMediaJournal(0);
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    expect(acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toMatchObject({ acknowledged: true });
    for (const restorePath of [path, secretPath, ownerPath]) {
      renameSync(join(quarantine, basename(restorePath)), restorePath);
    }

    store = openVideoJobStore({ now: () => 2_000 });
    const replay = store.reserveVideoJob({
      binding,
      deadlineAt: 62_000,
      operationKey,
      requestSemanticsDigest,
    });
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay" && original.kind === "created") {
      expect(replay.job.id).toBe(original.job.id);
    }
    store.close();
  });

  test("Win32 acknowledgement rejects a pending legacy bundle before any recovery mutation", () => {
    if (process.platform !== "win32") return;
    const files = currentJournalWithCompanions();
    const fence = writeLegacyFence();
    const quarantine = join(root, "media", `quarantine-${fence.id}`);
    mkdirSync(quarantine, { mode: 0o700 });
    const quarantinedJournal = join(quarantine, basename(files.path));
    renameSync(files.path, quarantinedJournal);
    const coordinator = join(root, "media", "media-recovery-coordinator.sqlite");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      rmSync(`${coordinator}${suffix}`, { force: true });
    }
    const before = new Map([
      [quarantinedJournal, readFileSync(quarantinedJournal)],
      [files.secretPath, readFileSync(files.secretPath)],
      [files.ownerPath, readFileSync(files.ownerPath)],
      [join(root, "media", "media-recovery-fence.json"), readFileSync(join(root, "media", "media-recovery-fence.json"))],
    ]);

    expect(() => acknowledgeMediaRecoveryFence(fence.id, fence.revision)).toThrow("media recovery is read-only");
    for (const [path, bytes] of before) expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(coordinator)).toBe(false);
    expect(existsSync(join(quarantine, "media-recovery-manifest.json"))).toBe(false);
    expect(existsSync(files.path)).toBe(false);
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

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveVideoOperationKey,
  deriveVideoRequestBodyDigest,
  deriveVideoRequestSemanticsDigest,
} from "../../src/images/video-operation-key";
import { MediaRuntime } from "../../src/images/media-runtime";
import { openVideoJobStore } from "../../src/images/video-job-store";
import { videoOperationReplaySecretPathForJournal } from "../../src/images/video-operation-secret";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ccx-video-replay-secret-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

describe("video retry operation identity", () => {
  const firstAdmission = {
    digestSecret: "first-admission-secret",
    admission: { kind: "configured", keyId: "private-account-a" } as const,
  };

  test("accepts only bounded opaque client request ids and persists an admission-scoped HMAC", () => {
    const raw = "req_1234-ABCD:turn.9";
    const key = deriveVideoOperationKey(raw, firstAdmission);
    expect(key).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(key).not.toContain(raw);
    expect(key).not.toContain("private-account-a");
    expect(deriveVideoOperationKey(raw, firstAdmission)).toBe(key);
    expect(deriveVideoOperationKey(raw, {
      ...firstAdmission,
      admission: { kind: "configured", keyId: "private-account-b" },
    })).not.toBe(key);
    expect(deriveVideoOperationKey(raw, {
      digestSecret: "second-admission-secret",
      admission: { kind: "environment" },
    })).not.toBe(key);
    expect(deriveVideoOperationKey(undefined, firstAdmission)).toBeUndefined();
    expect(deriveVideoOperationKey("", firstAdmission)).toBeUndefined();
    expect(deriveVideoOperationKey(" leading-space", firstAdmission)).toBeUndefined();
    expect(deriveVideoOperationKey("line\nbreak", firstAdmission)).toBeUndefined();
    expect(deriveVideoOperationKey("x".repeat(257), firstAdmission)).toBeUndefined();
  });

  test("full request-body collision guard is canonical, prompt-sensitive, and private", () => {
    const body = {
      model: "fixture/video-model",
      input: [{ role: "user", content: [{ type: "input_text", text: "private prompt one" }] }],
      stream: true,
      metadata: { private_account_hint: "account@example.test" },
    };
    const digest = deriveVideoRequestBodyDigest(body, firstAdmission);
    expect(digest).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(deriveVideoRequestBodyDigest({
      metadata: { private_account_hint: "account@example.test" },
      stream: true,
      input: body.input,
      model: body.model,
    }, firstAdmission)).toBe(digest);
    expect(deriveVideoRequestBodyDigest({
      ...body,
      input: [{ role: "user", content: [{ type: "input_text", text: "private prompt two" }] }],
    }, firstAdmission)).not.toBe(digest);
    expect(deriveVideoRequestBodyDigest(body, {
      ...firstAdmission,
      admission: { kind: "configured", keyId: "private-account-b" },
    })).not.toBe(digest);
    expect(deriveVideoRequestBodyDigest(body, {
      digestSecret: "second-admission-secret",
      admission: { kind: "configured", keyId: "private-account-b" },
    })).not.toBe(digest);
    expect(digest).not.toContain("private prompt");
    expect(digest).not.toContain("account@example.test");
    expect(digest).not.toContain("private-account-a");
  });

  test("direct-runtime fallback collision guard includes the complete video submit request", () => {
    const base = {
      prompt: "private prompt one",
      model: "grok-imagine-video-1.5",
      duration: 6,
      resolution: "720p",
      aspectRatio: "16:9",
    };
    const digest = deriveVideoRequestSemanticsDigest(base);
    expect(digest).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(deriveVideoRequestSemanticsDigest(base)).toBe(digest);
    expect(deriveVideoRequestSemanticsDigest({ ...base, prompt: "private prompt two" })).not.toBe(digest);
    expect(deriveVideoRequestSemanticsDigest({ ...base, duration: 7 })).not.toBe(digest);
    expect(deriveVideoRequestSemanticsDigest({ ...base, audio: false })).not.toBe(digest);
    expect(digest).not.toContain(base.prompt);
  });

  test("full-body digest uses an explicit stack for deeply nested bounded JSON", () => {
    let body: unknown = "leaf";
    for (let depth = 0; depth < 20_000; depth += 1) body = [body];
    expect(deriveVideoRequestBodyDigest(body, firstAdmission))
      .toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
  });
});

describe("journal-witnessed video replay authority", () => {
  const runtimeBinding = {
    authSource: "api_key",
    providerKind: "canonical",
    slotRef: "live-secret-fixture-slot",
    identityDigest: `hmac-sha256:${"7".repeat(64)}`,
  } as const;
  const runtimeRequest = {
    prompt: "private live-secret prompt",
    model: "grok-imagine-video-1.5",
    duration: 1,
    resolution: "1080p",
  };

  test("derives private scoped identities and remains stable across restart", () => {
    const root = privateRoot();
    const path = join(root, "media-journal.sqlite");
    const body = {
      model: "fixture/video-model",
      input: "private journal prompt",
      stream: true,
    };
    const admission = { kind: "configured", keyId: "private-account-a" } as const;
    const firstStore = openVideoJobStore({ path });
    const first = firstStore.deriveVideoOperationIdentity("journal-retry-id", admission, body);
    const exact = firstStore.deriveVideoOperationIdentity("journal-retry-id", admission, body);
    const differentPrompt = firstStore.deriveVideoOperationIdentity(
      "journal-retry-id",
      admission,
      { ...body, input: "different private journal prompt" },
    );
    const differentPrincipal = firstStore.deriveVideoOperationIdentity(
      "journal-retry-id",
      { kind: "configured", keyId: "private-account-b" },
      body,
    );
    firstStore.close();

    expect(first).toEqual(exact);
    expect(differentPrompt?.operationKey).toBe(first?.operationKey);
    expect(differentPrompt?.requestSemanticsDigest).not.toBe(first?.requestSemanticsDigest);
    expect(differentPrincipal?.operationKey).not.toBe(first?.operationKey);
    expect(differentPrincipal?.requestSemanticsDigest).not.toBe(first?.requestSemanticsDigest);
    expect(JSON.stringify([first, exact, differentPrompt, differentPrincipal])).not.toContain("private journal");
    expect(JSON.stringify([first, exact, differentPrompt, differentPrincipal])).not.toContain("private-account");

    const restarted = openVideoJobStore({ path });
    expect(restarted.deriveVideoOperationIdentity("journal-retry-id", admission, body)).toEqual(first);
    restarted.close();

    const database = new Database(path, { readonly: true, strict: true });
    const authority = database.query<{
      storage: string;
      bytes: number;
      secret_fingerprint: Uint8Array;
    }, []>(
      `SELECT typeof(secret_fingerprint) AS storage,
              length(secret_fingerprint) AS bytes,
              secret_fingerprint
         FROM video_replay_authority_witness`,
    ).get();
    database.close();
    expect(authority?.storage).toBe("blob");
    expect(authority?.bytes).toBe(32);
    const secretPath = videoOperationReplaySecretPathForJournal(path);
    const secret = readFileSync(secretPath);
    expect(secret.byteLength).toBe(32);
    const secretStats = lstatSync(secretPath);
    expect(secretStats.isFile()).toBe(true);
    expect(secretStats.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") expect(secretStats.mode & 0o777).toBe(0o600);
    const journalBytes = readFileSync(path);
    expect(journalBytes.includes(secret)).toBe(false);
    const journalOnlyContext = {
      digestSecret: authority!.secret_fingerprint,
      admission,
    };
    expect(deriveVideoOperationKey("journal-retry-id", journalOnlyContext))
      .not.toBe(first?.operationKey);
    expect(deriveVideoRequestBodyDigest(body, journalOnlyContext))
      .not.toBe(first?.requestSemanticsDigest);
  });

  test("fsync failure and a crash before the witness both adopt only the proven original file", () => {
    const root = privateRoot();
    const path = join(root, "media-journal.sqlite");
    const secretPath = videoOperationReplaySecretPathForJournal(path);
    let syncCalls = 0;
    expect(() => openVideoJobStore({
      path,
      replayAuthorityFsyncDirectory() {
        syncCalls += 1;
        throw new Error("fault-injected directory sync failure");
      },
    })).toThrow(/directory could not be synchronized/i);
    expect(syncCalls).toBe(1);
    const secretAfterFsyncFailure = readFileSync(secretPath);

    let seamCalls = 0;
    expect(() => openVideoJobStore({
      path,
      replayAuthorityCrashSeam() {
        seamCalls += 1;
        throw new Error("fault-injected authority transaction crash");
      },
    })).toThrow(/media journal/i);
    expect(seamCalls).toBe(1);
    expect(readFileSync(secretPath)).toEqual(secretAfterFsyncFailure);

    const afterCrash = new Database(path, { readonly: true, strict: true });
    expect(afterCrash.query<{ present: number }, []>(
      "SELECT 1 AS present FROM sqlite_schema WHERE name = 'video_replay_authority_witness'",
    ).get()).toBeNull();
    afterCrash.close();

    const restarted = openVideoJobStore({ path });
    expect(restarted.deriveVideoOperationIdentity(
      "post-crash-retry-id",
      { kind: "loopback" },
      { input: "private post-crash prompt" },
    )?.operationKey).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    restarted.close();
    expect(readFileSync(secretPath)).toEqual(secretAfterFsyncFailure);
  });

  test("missing secret or witness fails closed over durable rows, but no-obligation loss can regenerate", () => {
    const root = privateRoot();
    const path = join(root, "media-journal.sqlite");
    const secretPath = videoOperationReplaySecretPathForJournal(path);
    const store = openVideoJobStore({ path });
    const identity = store.deriveVideoOperationIdentity(
      "durable-witness-retry-id",
      { kind: "loopback" },
      { input: "private durable witness prompt" },
    )!;
    expect(store.reserveVideoJob({
      binding: {
        authSource: "api_key",
        providerKind: "canonical",
        slotRef: "fixture-slot",
        identityDigest: `hmac-sha256:${"1".repeat(64)}`,
      },
      deadlineAt: Date.now() + 60_000,
      ...identity,
    }).kind).toBe("created");
    store.close();

    unlinkSync(secretPath);
    expect(() => openVideoJobStore({ path })).toThrow(/unavailable while retry records remain/i);
    expect(existsSync(secretPath)).toBe(false);

    const missingWitnessRoot = privateRoot();
    const missingWitnessPath = join(missingWitnessRoot, "media-journal.sqlite");
    const missingWitnessStore = openVideoJobStore({ path: missingWitnessPath });
    const missingWitnessIdentity = missingWitnessStore.deriveVideoOperationIdentity(
      "missing-witness-retry-id",
      { kind: "loopback" },
      { input: "private missing witness prompt" },
    )!;
    expect(missingWitnessStore.reserveVideoJob({
      binding: {
        authSource: "api_key",
        providerKind: "canonical",
        slotRef: "missing-witness-slot",
        identityDigest: `hmac-sha256:${"4".repeat(64)}`,
      },
      deadlineAt: Date.now() + 60_000,
      ...missingWitnessIdentity,
    }).kind).toBe("created");
    missingWitnessStore.close();
    const missingWitness = new Database(missingWitnessPath, { strict: true });
    missingWitness.exec("DELETE FROM video_replay_authority_witness");
    missingWitness.close();
    expect(() => openVideoJobStore({ path: missingWitnessPath }))
      .toThrow(/witness is missing while retry records remain/i);

    const corruptRoot = privateRoot();
    const corruptPath = join(corruptRoot, "media-journal.sqlite");
    const corruptSecretPath = videoOperationReplaySecretPathForJournal(corruptPath);
    const corruptStore = openVideoJobStore({ path: corruptPath });
    const corruptIdentity = corruptStore.deriveVideoOperationIdentity(
      "corrupt-secret-retry-id",
      { kind: "loopback" },
      { input: "private corrupt secret prompt" },
    )!;
    expect(corruptStore.reserveVideoJob({
      binding: {
        authSource: "api_key",
        providerKind: "canonical",
        slotRef: "corrupt-secret-slot",
        identityDigest: `hmac-sha256:${"5".repeat(64)}`,
      },
      deadlineAt: Date.now() + 60_000,
      ...corruptIdentity,
    }).kind).toBe("created");
    corruptStore.close();
    writeFileSync(corruptSecretPath, Buffer.alloc(31), { mode: 0o600 });
    expect(() => openVideoJobStore({ path: corruptPath }))
      .toThrow(/unavailable while retry records remain/i);
    expect(readFileSync(corruptSecretPath).byteLength).toBe(31);

    const bindingOnlyRoot = privateRoot();
    const bindingOnlyPath = join(bindingOnlyRoot, "media-journal.sqlite");
    const bindingOnlySecretPath = videoOperationReplaySecretPathForJournal(bindingOnlyPath);
    const bindingOnlyStore = openVideoJobStore({ path: bindingOnlyPath });
    expect(bindingOnlyStore.reserveVideoJob({
      binding: {
        authSource: "api_key",
        providerKind: "canonical",
        slotRef: "binding-witness-only-slot",
        identityDigest: `hmac-sha256:${"6".repeat(64)}`,
      },
      deadlineAt: Date.now() + 60_000,
    }).kind).toBe("created");
    bindingOnlyStore.close();
    unlinkSync(bindingOnlySecretPath);
    expect(() => openVideoJobStore({ path: bindingOnlyPath }))
      .toThrow(/unavailable while retry records remain/i);
    expect(existsSync(bindingOnlySecretPath)).toBe(false);

    const emptyRoot = privateRoot();
    const emptyPath = join(emptyRoot, "media-journal.sqlite");
    const emptySecretPath = videoOperationReplaySecretPathForJournal(emptyPath);
    const emptyStore = openVideoJobStore({ path: emptyPath });
    const beforeLoss = emptyStore.deriveVideoOperationIdentity(
      "no-obligation-retry-id",
      { kind: "loopback" },
      { input: "private no-obligation prompt" },
    );
    emptyStore.close();
    unlinkSync(emptySecretPath);
    const regenerated = openVideoJobStore({ path: emptyPath });
    expect(regenerated.deriveVideoOperationIdentity(
      "no-obligation-retry-id",
      { kind: "loopback" },
      { input: "private no-obligation prompt" },
    )).not.toEqual(beforeLoss);
    regenerated.close();
  });

  test("a surviving replay companion prevents a missing journal from becoming a fresh authority", () => {
    const root = privateRoot();
    const path = join(root, "media-journal.sqlite");
    const secretPath = videoOperationReplaySecretPathForJournal(path);
    const store = openVideoJobStore({ path });
    const identity = store.deriveVideoOperationIdentity(
      "missing-journal-retry-id",
      { kind: "loopback" },
      { input: "private missing-journal prompt" },
    )!;
    const reserved = store.reserveVideoJob({
      binding: runtimeBinding,
      deadlineAt: Date.now() + 60_000,
      ...identity,
    });
    if (reserved.kind !== "created") throw new Error("expected durable retry reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected durable submission fence");
    store.close();

    expect(existsSync(secretPath)).toBe(true);
    unlinkSync(path);
    expect(() => openVideoJobStore({ path }))
      .toThrow(/journal is missing while replay authority state remains/i);
    expect(existsSync(secretPath)).toBe(true);
  });

  test("deleting one fenced row cannot erase the aggregate replay obligation", () => {
    const root = privateRoot();
    const path = join(root, "media-journal.sqlite");
    const store = openVideoJobStore({ path });
    const identity = store.deriveVideoOperationIdentity(
      "deleted-row-retry-id",
      { kind: "loopback" },
      { input: "private deleted-row prompt" },
    )!;
    const reserved = store.reserveVideoJob({
      binding: runtimeBinding,
      deadlineAt: Date.now() + 60_000,
      ...identity,
    });
    if (reserved.kind !== "created") throw new Error("expected durable retry reservation");
    const fenced = store.fenceVideoSubmission(reserved.job.id, reserved.job.revision);
    if (fenced.kind !== "updated") throw new Error("expected durable submission fence");
    store.close();

    const corrupt = new Database(path, { strict: true });
    corrupt.query("DELETE FROM video_jobs WHERE id = ?").run(fenced.job.id);
    corrupt.close();
    expect(() => openVideoJobStore({ path })).toThrow(/job-set witness does not match retained jobs/i);
  });

  test("in-place replay-secret replacement blocks paid admission while the store is open", async () => {
    const root = privateRoot();
    const path = join(root, "media-journal.sqlite");
    const secretPath = videoOperationReplaySecretPathForJournal(path);
    const submit = mock(async () => ({ requestId: "must-not-dispatch" }));
    const store = openVideoJobStore({ path, now: () => 1_000 });
    const runtime = new MediaRuntime(store, { now: () => 1_000, submitVideoJob: submit });
    writeFileSync(secretPath, Buffer.alloc(32, 0x5a), { mode: 0o600 });

    await expect(runtime.submitVideo({
      binding: runtimeBinding,
      deadlineAt: 61_000,
      request: runtimeRequest,
    })).rejects.toThrow(/replay secret changed/i);
    expect(submit).toHaveBeenCalledTimes(0);
    await runtime.shutdown();
  });

  test.skipIf(process.platform === "win32")(
    "replay-secret deletion blocks paid admission while the store is open",
    async () => {
      const root = privateRoot();
      const path = join(root, "media-journal.sqlite");
      const secretPath = videoOperationReplaySecretPathForJournal(path);
      const submit = mock(async () => ({ requestId: "must-not-dispatch" }));
      const store = openVideoJobStore({ path, now: () => 1_000 });
      const runtime = new MediaRuntime(store, { now: () => 1_000, submitVideoJob: submit });
      unlinkSync(secretPath);

      await expect(runtime.submitVideo({
        binding: runtimeBinding,
        deadlineAt: 61_000,
        request: runtimeRequest,
      })).rejects.toThrow(/replay secret is unavailable/i);
      expect(submit).toHaveBeenCalledTimes(0);
      await runtime.shutdown();
    },
  );

  test("an asymmetrically corrupted terminal retry row blocks restart before replacement admission", () => {
    const root = privateRoot();
    const path = join(root, "media-journal.sqlite");
    const store = openVideoJobStore({ path });
    const identity = store.deriveVideoOperationIdentity(
      "corrupt-pair-retry-id",
      { kind: "loopback" },
      { input: "private corrupt pair prompt" },
    )!;
    expect(store.reserveVideoJob({
      binding: {
        authSource: "api_key",
        providerKind: "canonical",
        slotRef: "corrupt-pair-slot",
        identityDigest: `hmac-sha256:${"6".repeat(64)}`,
      },
      deadlineAt: Date.now() + 60_000,
      ...identity,
    }).kind).toBe("created");
    store.close();

    const corrupt = new Database(path, { strict: true });
    corrupt.exec(`
      PRAGMA ignore_check_constraints = ON;
      UPDATE video_jobs
         SET state = 'failed', operation_key = NULL
       WHERE operation_key IS NOT NULL
    `);
    corrupt.close();

    expect(() => openVideoJobStore({ path })).toThrow(/malformed retry identity state/i);
    const check = new Database(path, { readonly: true, strict: true });
    expect(check.query<{ count: number }, []>("SELECT count(*) AS count FROM video_jobs").get()?.count).toBe(1);
    check.close();
  });
});

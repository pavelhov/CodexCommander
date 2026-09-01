import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMAGE_BODY_FALLBACK_WINDOW_MS,
  openImageReplayStore,
} from "../../src/images/image-replay-store";
import { videoOperationReplaySecretPathForJournal } from "../../src/images/video-operation-secret";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixturePath(name = "image-replay.sqlite"): string {
  const root = mkdtempSync(join(tmpdir(), "ccx-image-replay-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const directory = join(root, "private");
  mkdirSync(directory, { mode: 0o700 });
  return join(directory, name);
}

const RESPONSE = JSON.stringify({
  created: 1_767_000_000,
  data: [{ b64_json: "iVBORw0KGgo=" }],
});

describe("direct image replay store", () => {
  test("exact explicit retries replay across restart without persisting request or principal material", () => {
    const path = fixturePath();
    const body = { prompt: "private sapphire lighthouse", n: 1, size: "1024x1024" };
    const admission = { kind: "configured", keyId: "private-principal-alpha" } as const;
    const first = openImageReplayStore({ path });
    const identity = first.deriveIdentity("private-client-operation", admission, body);
    expect(identity.operationKey).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(identity.requestSemanticsDigest).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toContain("sapphire");
    expect(JSON.stringify(identity)).not.toContain("principal-alpha");
    expect(JSON.stringify(identity)).not.toContain("client-operation");
    expect(first.reserve(identity)).toEqual({ kind: "created" });
    first.markSubmitting(identity.operationKey);
    first.complete(identity.operationKey, { status: 200, body: RESPONSE, noRetry: false });
    first.close();

    const restarted = openImageReplayStore({ path });
    const restartedIdentity = restarted.deriveIdentity("private-client-operation", admission, body);
    expect(restartedIdentity).toEqual(identity);
    expect(restarted.reserve(restartedIdentity)).toEqual({
      kind: "replay",
      response: { status: 200, body: RESPONSE, noRetry: false },
    });
    const otherPrincipal = restarted.deriveIdentity(
      "private-client-operation",
      { kind: "configured", keyId: "private-principal-beta" },
      body,
    );
    expect(otherPrincipal.operationKey).not.toBe(identity.operationKey);
    expect(restarted.reserve(otherPrincipal)).toEqual({ kind: "created" });
    restarted.close();

    const journal = readFileSync(path);
    for (const forbidden of ["sapphire lighthouse", "principal-alpha", "principal-beta", "client-operation"]) {
      expect(journal.includes(Buffer.from(forbidden))).toBe(false);
    }
    const secret = readFileSync(videoOperationReplaySecretPathForJournal(path));
    expect(secret.byteLength).toBe(32);
    expect(journal.includes(secret)).toBe(false);
  });

  test("a crash after the dispatch fence recovers as outcome unknown and never admits a duplicate", () => {
    const path = fixturePath();
    let now = 20_000_000;
    const body = { prompt: "private uncertain aurora" };
    const admission = { kind: "loopback" } as const;
    const first = openImageReplayStore({ path, now: () => now });
    const identity = first.deriveIdentity("uncertain-operation", admission, body);
    expect(first.reserve(identity)).toEqual({ kind: "created" });
    first.markSubmitting(identity.operationKey);
    first.close();

    now += 30 * 24 * 60 * 60_000;
    const restarted = openImageReplayStore({ path, now: () => now });
    expect(restarted.reserve(restarted.deriveIdentity("uncertain-operation", admission, body)))
      .toEqual({ kind: "outcome_unknown" });
    restarted.close();
  });

  test("definite pre-dispatch release is retryable and the body fallback expires", () => {
    const path = fixturePath();
    let now = 10_000_000;
    const store = openImageReplayStore({ path, now: () => now });
    const identity = store.deriveIdentity(undefined, { kind: "environment" }, { prompt: "repeatable" });
    expect(store.reserve(identity)).toEqual({ kind: "created" });
    store.markSubmitting(identity.operationKey);
    store.releasePreDispatch(identity.operationKey);
    expect(store.reserve(identity)).toEqual({ kind: "created" });
    store.markSubmitting(identity.operationKey);
    store.complete(identity.operationKey, { status: 200, body: RESPONSE, noRetry: false });
    expect(store.reserve(identity).kind).toBe("replay");
    now += IMAGE_BODY_FALLBACK_WINDOW_MS + 1;
    expect(store.reserve(identity)).toEqual({ kind: "created" });
    store.close();
  });

  test("retained rows fail closed when the private authority is missing or row metadata is corrupt", () => {
    const missingSecretPath = fixturePath("missing-secret.sqlite");
    const store = openImageReplayStore({ path: missingSecretPath });
    const identity = store.deriveIdentity("held-operation", { kind: "loopback" }, { prompt: "held" });
    expect(store.reserve(identity)).toEqual({ kind: "created" });
    store.markSubmitting(identity.operationKey);
    store.markOutcomeUnknown(identity.operationKey);
    store.close();
    unlinkSync(videoOperationReplaySecretPathForJournal(missingSecretPath));
    expect(() => openImageReplayStore({ path: missingSecretPath })).toThrow(/secret.*unavailable|retry records/i);

    const corruptPath = fixturePath("corrupt.sqlite");
    const healthy = openImageReplayStore({ path: corruptPath });
    const healthyIdentity = healthy.deriveIdentity("corrupt-operation", { kind: "loopback" }, { prompt: "private" });
    expect(healthy.reserve(healthyIdentity)).toEqual({ kind: "created" });
    healthy.close();
    const database = new Database(corruptPath, { strict: true });
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.query("UPDATE image_requests SET request_semantics_digest = 'raw-corrupt-value'").run();
    database.close();
    expect(() => openImageReplayStore({ path: corruptPath })).toThrow(/malformed/i);

    const missingJournalPath = fixturePath("missing-journal.sqlite");
    const journalStore = openImageReplayStore({ path: missingJournalPath });
    const journalIdentity = journalStore.deriveIdentity(
      "missing-journal-operation",
      { kind: "loopback" },
      { prompt: "must remain fenced" },
    );
    expect(journalStore.reserve(journalIdentity)).toEqual({ kind: "created" });
    journalStore.markSubmitting(journalIdentity.operationKey);
    journalStore.close();
    unlinkSync(missingJournalPath);
    expect(() => openImageReplayStore({ path: missingJournalPath })).toThrow(/journal is missing/i);

    const truncatedJournalPath = fixturePath("truncated-journal.sqlite");
    const truncatedStore = openImageReplayStore({ path: truncatedJournalPath });
    const truncatedIdentity = truncatedStore.deriveIdentity(
      "truncated-journal-operation",
      { kind: "loopback" },
      { prompt: "must not be resubmitted" },
    );
    expect(truncatedStore.reserve(truncatedIdentity)).toEqual({ kind: "created" });
    truncatedStore.markSubmitting(truncatedIdentity.operationKey);
    truncatedStore.close();
    truncateSync(truncatedJournalPath, 0);
    expect(() => openImageReplayStore({ path: truncatedJournalPath })).toThrow(/schema version|authority witness/i);
  });

  test("authenticated row set rejects deleted outcome-unknown and completed obligations", () => {
    for (const state of ["outcome_unknown", "completed"] as const) {
      const path = fixturePath(`deleted-${state}.sqlite`);
      const store = openImageReplayStore({ path });
      const identity = store.deriveIdentity(`deleted-${state}`, { kind: "loopback" }, { prompt: `private ${state}` });
      expect(store.reserve(identity)).toEqual({ kind: "created" });
      store.markSubmitting(identity.operationKey);
      if (state === "outcome_unknown") store.markOutcomeUnknown(identity.operationKey);
      else store.complete(identity.operationKey, { status: 200, body: RESPONSE, noRetry: false });
      store.close();
      const database = new Database(path, { strict: true });
      database.query("DELETE FROM image_requests WHERE operation_key = ?").run(identity.operationKey);
      database.close();
      expect(() => openImageReplayStore({ path })).toThrow(/set witness does not match retained rows/i);
    }
  });

  test("authenticated row witness rejects a constraint-valid rewrite and missing set witness", () => {
    const path = fixturePath("rewritten.sqlite");
    const store = openImageReplayStore({ path });
    const identity = store.deriveIdentity("rewritten-result", { kind: "loopback" }, { prompt: "private rewrite" });
    expect(store.reserve(identity)).toEqual({ kind: "created" });
    store.markSubmitting(identity.operationKey);
    store.complete(identity.operationKey, { status: 200, body: RESPONSE, noRetry: false });
    store.close();
    const rewritten = new Database(path, { strict: true });
    rewritten.query("UPDATE image_requests SET response_json = ? WHERE operation_key = ?")
      .run(new TextEncoder().encode(JSON.stringify({ created: 9, data: [{ b64_json: "iVBORw0KGgo=" }] })), identity.operationKey);
    rewritten.close();
    expect(() => openImageReplayStore({ path })).toThrow(/row witness does not match/i);

    const missingSetPath = fixturePath("missing-set.sqlite");
    const healthy = openImageReplayStore({ path: missingSetPath });
    healthy.close();
    const missing = new Database(missingSetPath, { strict: true });
    missing.exec("DELETE FROM image_replay_set_witness");
    missing.close();
    expect(() => openImageReplayStore({ path: missingSetPath })).toThrow(/set witness is malformed/i);
  });

  test("a coherent whole-journal snapshot restore remains readable", () => {
    const path = fixturePath("snapshot.sqlite");
    const backup = `${path}.coherent-backup`;
    const first = openImageReplayStore({ path });
    const identity = first.deriveIdentity("snapshot-first", { kind: "loopback" }, { prompt: "first snapshot" });
    expect(first.reserve(identity)).toEqual({ kind: "created" });
    first.markSubmitting(identity.operationKey);
    first.complete(identity.operationKey, { status: 200, body: RESPONSE, noRetry: false });
    first.close();
    copyFileSync(path, backup);
    const second = openImageReplayStore({ path });
    const secondIdentity = second.deriveIdentity("snapshot-second", { kind: "loopback" }, { prompt: "second snapshot" });
    expect(second.reserve(secondIdentity)).toEqual({ kind: "created" });
    second.markSubmitting(secondIdentity.operationKey);
    second.complete(secondIdentity.operationKey, { status: 200, body: RESPONSE, noRetry: false });
    second.close();
    copyFileSync(backup, path);
    const restored = openImageReplayStore({ path });
    expect(restored.reserve(restored.deriveIdentity(
      "snapshot-first",
      { kind: "loopback" },
      { prompt: "first snapshot" },
    )).kind).toBe("replay");
    restored.close();
  });

  test("legacy versions and index drift fail closed", () => {
    const legacyPath = fixturePath("legacy.sqlite");
    const legacy = new Database(legacyPath, { create: true, strict: true });
    legacy.exec("CREATE TABLE legacy_rows(id TEXT); PRAGMA user_version = 1");
    legacy.close();
    chmodSync(legacyPath, 0o600);
    expect(() => openImageReplayStore({ path: legacyPath })).toThrow(/predates authenticated row-set recovery/i);

    const indexPath = fixturePath("index-drift.sqlite");
    const healthy = openImageReplayStore({ path: indexPath });
    healthy.close();
    const drifted = new Database(indexPath, { strict: true });
    drifted.exec("DROP INDEX image_requests_principal_state");
    drifted.close();
    expect(() => openImageReplayStore({ path: indexPath })).toThrow(/index schema is malformed/i);

    const triggerPath = fixturePath("trigger-drift.sqlite");
    const triggerStore = openImageReplayStore({ path: triggerPath });
    const triggerIdentity = triggerStore.deriveIdentity(
      "trigger-operation",
      { kind: "loopback" },
      { prompt: "trigger fenced" },
    );
    expect(triggerStore.reserve(triggerIdentity)).toEqual({ kind: "created" });
    triggerStore.markSubmitting(triggerIdentity.operationKey);
    triggerStore.close();
    const triggered = new Database(triggerPath, { strict: true });
    triggered.exec(`
      CREATE TRIGGER erase_image_replay_rows
      AFTER UPDATE ON image_requests
      BEGIN
        DELETE FROM image_requests;
      END
    `);
    triggered.close();
    expect(() => openImageReplayStore({ path: triggerPath })).toThrow(/unexpected executable schema objects/i);
  });

  test("live trigger drift is rejected before an ordinary transaction can activate it", () => {
    const path = fixturePath("live-trigger.sqlite");
    let now = 30_000_000;
    const store = openImageReplayStore({ path, now: () => now });
    const unknown = store.deriveIdentity("live-unknown", { kind: "loopback" }, { prompt: "held unknown" });
    expect(store.reserve(unknown)).toEqual({ kind: "created" });
    store.markSubmitting(unknown.operationKey);
    store.markOutcomeUnknown(unknown.operationKey);
    const completed = store.deriveIdentity("live-completed", { kind: "loopback" }, { prompt: "expires" });
    expect(store.reserve(completed)).toEqual({ kind: "created" });
    store.markSubmitting(completed.operationKey);
    store.complete(completed.operationKey, { status: 200, body: RESPONSE, noRetry: false });
    const next = store.deriveIdentity(undefined, { kind: "loopback" }, { prompt: "new request" });

    const external = new Database(path, { strict: true });
    external.exec(`
      CREATE TRIGGER erase_unknown_after_expiry
      AFTER DELETE ON image_requests
      BEGIN
        DELETE FROM image_requests WHERE state = 'outcome_unknown';
      END
    `);
    external.close();
    now += IMAGE_BODY_FALLBACK_WINDOW_MS + 1;
    expect(() => store.reserve(next)).toThrow(/unexpected executable schema objects/i);
    store.close();
  });
});

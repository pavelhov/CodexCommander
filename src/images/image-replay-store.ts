import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual, type Hmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { getConfigDir } from "../config";
import {
  assertStableLockFile,
  openStableLockFile,
  type StableLockFile,
} from "../codex/native-main-lock-file";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import {
  acquireMediaJournalOwnerLease,
  type MediaJournalOwnerLease,
} from "./video-job-store";
import {
  reconcileVideoOperationReplaySecret,
  videoOperationReplaySecretPathForJournal,
} from "./video-operation-secret";
import {
  deriveImageOperationIdentity,
  type ImageOperationAdmissionScope,
  type ImageOperationIdentity,
} from "./image-operation-key";

export const IMAGE_REPLAY_FILENAME = "image-replay.sqlite";
export const IMAGE_EXPLICIT_REPLAY_WINDOW_MS = 24 * 60 * 60_000;
export const IMAGE_BODY_FALLBACK_WINDOW_MS = 10 * 60_000;
const MAX_ROWS = 4_096;
const MAX_ACTIVE_RESULT_ROWS = 256;
const MAX_ROWS_PER_PRINCIPAL = 256;
const MAX_RESULT_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_RESULT_BYTES = 256 * 1024 * 1024;
const OWNER_SUFFIX = ".recovery-owner.sqlite";
const DIGEST_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const ROW_WITNESS_DOMAIN = "codexcommander/image-replay-row/v1";
const SET_WITNESS_DOMAIN = "codexcommander/image-replay-set/v1";
const UNAVAILABLE_RESULT = JSON.stringify({
  error: {
    message: "Grok image result is no longer available, and the paid request was not repeated.",
    type: "invalid_request_error",
    code: "artifact_unavailable",
  },
});

export interface StoredImageResponse {
  status: number;
  body: string;
  noRetry: boolean;
}

export type ImageReplayReservation =
  | { kind: "created" }
  | { kind: "replay"; response: StoredImageResponse }
  | { kind: "outcome_unknown" }
  | { kind: "busy" }
  | { kind: "conflict" }
  | { kind: "saturated" };

export type ImageReplayLookup = Exclude<ImageReplayReservation, { kind: "created" } | { kind: "saturated" }>
  | { kind: "none" };

export interface ImageReplayStoreOptions {
  path?: string;
  now?: () => number;
  replayAuthorityCrashSeam?: () => void;
  replayAuthorityFsyncDirectory?: (directory: string) => void;
}

interface ImageReplayRow {
  operation_key: unknown;
  request_semantics_digest: unknown;
  principal_digest: unknown;
  identity_kind: unknown;
  state: unknown;
  response_status: unknown;
  response_no_retry: unknown;
  response_json: unknown;
  created_at: unknown;
  updated_at: unknown;
  row_witness: unknown;
}

function replayError(message: string): Error {
  const error = new Error(message);
  error.name = "ImageReplayStoreError";
  return error;
}

function privateFile(stats: Stats): boolean {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o777) === 0o600;
}

function ensurePrivateDirectory(directory: string): void {
  assertNotRealHomeUnderTest(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    if (!hardenSecretDir(directory, { required: true }).ok) throw replayError("The image replay directory is unsafe.");
  } else {
    chmodSync(directory, 0o700);
    const stats = lstatSync(directory);
    const uid = process.getuid?.();
    if (!stats.isDirectory() || stats.isSymbolicLink() || uid === undefined || stats.uid !== uid || (stats.mode & 0o777) !== 0o700) {
      throw replayError("The image replay directory is unsafe.");
    }
  }
}

function hardenFile(path: string): void {
  if (process.platform === "win32") {
    if (!hardenSecretPath(path, { required: true, timeoutMemoKey: `${path}::image-replay` }).ok) {
      throw replayError("The image replay journal is unsafe.");
    }
  } else {
    chmodSync(path, 0o600);
  }
  if (!privateFile(lstatSync(path))) throw replayError("The image replay journal is unsafe.");
}

function defaultPath(): string {
  return join(getConfigDir(), "images", IMAGE_REPLAY_FILENAME);
}

function canonicalPath(selected: string): string {
  const path = resolve(selected);
  if (!isAbsolute(path)) throw replayError("The image replay journal path must be absolute.");
  ensurePrivateDirectory(dirname(path));
  return join(resolve(dirname(path)), basename(path));
}

const CREATE_AUTHORITY = `CREATE TABLE image_replay_authority_witness (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
  secret_fingerprint BLOB NOT NULL CHECK(typeof(secret_fingerprint) = 'blob' AND length(secret_fingerprint) = 32)
) STRICT`;
const CREATE_REQUESTS = `CREATE TABLE image_requests (
  operation_key TEXT PRIMARY KEY NOT NULL CHECK(length(operation_key) BETWEEN 1 AND 128),
  request_semantics_digest TEXT NOT NULL CHECK(length(request_semantics_digest) BETWEEN 1 AND 128),
  principal_digest TEXT NOT NULL CHECK(length(principal_digest) BETWEEN 1 AND 128),
  identity_kind TEXT NOT NULL CHECK(identity_kind IN ('explicit','body_fallback')),
  state TEXT NOT NULL CHECK(state IN ('reserved','submitting','outcome_unknown','completed')),
  response_status INTEGER,
  response_no_retry INTEGER,
  response_json BLOB,
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  row_witness BLOB NOT NULL CHECK(typeof(row_witness) = 'blob' AND length(row_witness) = 32),
  CHECK(
    (state = 'completed' AND response_status BETWEEN 100 AND 599 AND response_no_retry IN (0,1) AND response_json IS NOT NULL)
    OR (state != 'completed' AND response_status IS NULL AND response_no_retry IS NULL AND response_json IS NULL)
  )
) STRICT`;
const CREATE_PRINCIPAL_INDEX = `CREATE INDEX image_requests_principal_state
  ON image_requests(principal_digest, state, updated_at)`;
const CREATE_SET_WITNESS = `CREATE TABLE image_replay_set_witness (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  set_fingerprint BLOB NOT NULL CHECK(typeof(set_fingerprint) = 'blob' AND length(set_fingerprint) = 32)
) STRICT`;

function normalizedSql(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function schemaEmpty(database: Database): boolean {
  return database.query("SELECT 1 FROM sqlite_schema LIMIT 1").get() === null;
}

function createFreshSchema(database: Database): void {
  database.exec(`${CREATE_AUTHORITY}; ${CREATE_REQUESTS}; ${CREATE_PRINCIPAL_INDEX}; ${CREATE_SET_WITNESS}; PRAGMA user_version = 2;`);
}

function assertExactSchema(database: Database): void {
  const expected = new Map([
    ["image_replay_authority_witness", normalizedSql(CREATE_AUTHORITY)],
    ["image_requests", normalizedSql(CREATE_REQUESTS)],
    ["image_replay_set_witness", normalizedSql(CREATE_SET_WITNESS)],
  ]);
  const tables = database.query<{ name: string; sql: string | null }, []>(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  if (tables.length !== expected.size || tables.some(row => !row.sql || expected.get(row.name) !== normalizedSql(row.sql))) {
    throw replayError("The image replay journal schema is malformed.");
  }
  const indexes = database.query<{ name: string; sql: string | null }, []>(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
  ).all();
  if (indexes.length !== 1
    || indexes[0]?.name !== "image_requests_principal_state"
    || normalizedSql(indexes[0].sql ?? "") !== normalizedSql(CREATE_PRINCIPAL_INDEX)) {
    throw replayError("The image replay journal index schema is malformed.");
  }
  const executableExtras = database.query<{ type: string; name: string }, []>(
    "SELECT type, name FROM sqlite_schema WHERE type IN ('trigger','view') ORDER BY type, name",
  ).all();
  if (executableExtras.length !== 0) {
    throw replayError("The image replay journal contains unexpected executable schema objects.");
  }
}

function updateText(hmac: Hmac, marker: string, value: string): void {
  hmac.update(marker);
  hmac.update(String(Buffer.byteLength(value)));
  hmac.update(":");
  hmac.update(value);
}

function updateInteger(hmac: Hmac, marker: string, value: number): void {
  updateText(hmac, marker, String(value));
}

function updateNullableBytes(hmac: Hmac, marker: string, value: unknown): void {
  const bytes = responseBytes(value);
  if (!bytes) {
    hmac.update(`${marker}N`);
    return;
  }
  hmac.update(`${marker}B${bytes.byteLength}:`);
  hmac.update(bytes);
}

function deriveRowWitness(secret: Uint8Array, row: ImageReplayRow): Uint8Array {
  assertRowShape(row, false);
  const hmac = createHmac("sha256", secret);
  hmac.update(ROW_WITNESS_DOMAIN);
  hmac.update("\0");
  updateText(hmac, "O", row.operation_key as string);
  updateText(hmac, "D", row.request_semantics_digest as string);
  updateText(hmac, "P", row.principal_digest as string);
  updateText(hmac, "I", row.identity_kind as string);
  updateText(hmac, "S", row.state as string);
  updateText(hmac, "T", row.response_status === null ? "null" : String(row.response_status));
  updateText(hmac, "N", row.response_no_retry === null ? "null" : String(row.response_no_retry));
  updateNullableBytes(hmac, "J", row.response_json);
  updateInteger(hmac, "C", row.created_at as number);
  updateInteger(hmac, "U", row.updated_at as number);
  return new Uint8Array(hmac.digest());
}

function equalWitness(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function responseBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function decodeStoredResponse(row: ImageReplayRow): StoredImageResponse {
  const bytes = responseBytes(row.response_json);
  if (!bytes || bytes.byteLength < 2 || bytes.byteLength > MAX_RESULT_BYTES) throw replayError("The image replay journal is malformed.");
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw replayError("The image replay journal is malformed.");
  if (!Number.isInteger(row.response_status) || Number(row.response_status) < 100 || Number(row.response_status) > 599) {
    throw replayError("The image replay journal is malformed.");
  }
  if (row.response_no_retry !== 0 && row.response_no_retry !== 1) throw replayError("The image replay journal is malformed.");
  return { status: Number(row.response_status), body, noRetry: row.response_no_retry === 1 };
}

function assertRowShape(row: ImageReplayRow, requireWitness = true): void {
  if (typeof row.operation_key !== "string" || !DIGEST_RE.test(row.operation_key)
    || typeof row.request_semantics_digest !== "string" || !DIGEST_RE.test(row.request_semantics_digest)
    || typeof row.principal_digest !== "string" || !DIGEST_RE.test(row.principal_digest)
    || (row.identity_kind !== "explicit" && row.identity_kind !== "body_fallback")
    || !["reserved", "submitting", "outcome_unknown", "completed"].includes(String(row.state))
    || !Number.isInteger(row.created_at) || Number(row.created_at) < 1
    || !Number.isInteger(row.updated_at) || Number(row.updated_at) < Number(row.created_at)) {
    throw replayError("The image replay journal is malformed.");
  }
  if (requireWitness && (!(row.row_witness instanceof Uint8Array) || row.row_witness.byteLength !== 32)) {
    throw replayError("The image replay journal row witness is malformed.");
  }
  if (row.state === "completed") decodeStoredResponse(row);
  else if (row.response_status !== null || row.response_no_retry !== null || row.response_json !== null) {
    throw replayError("The image replay journal is malformed.");
  }
}

function readAllRows(database: Database): ImageReplayRow[] {
  const rows = database.query<ImageReplayRow, []>(
    `SELECT * FROM image_requests ORDER BY operation_key LIMIT ${MAX_ROWS + 1}`,
  ).all();
  if (rows.length > MAX_ROWS) throw replayError("The image replay journal row limit was exceeded.");
  return rows;
}

function expectedSetState(database: Database, secret: Uint8Array): { rowCount: number; fingerprint: Uint8Array } {
  const rows = readAllRows(database);
  const hmac = createHmac("sha256", secret);
  hmac.update(SET_WITNESS_DOMAIN);
  hmac.update("\0");
  updateInteger(hmac, "C", rows.length);
  for (const row of rows) {
    assertRowShape(row);
    const witness = row.row_witness as Uint8Array;
    const expected = deriveRowWitness(secret, row);
    if (!equalWitness(witness, expected)) throw replayError("The image replay journal row witness does not match.");
    updateText(hmac, "O", row.operation_key as string);
    hmac.update("W32:");
    hmac.update(witness);
  }
  return { rowCount: rows.length, fingerprint: new Uint8Array(hmac.digest()) };
}

function readSetWitness(database: Database): { rowCount: number; fingerprint: Uint8Array } {
  const rows = database.query<{ singleton: unknown; row_count: unknown; set_fingerprint: unknown }, []>(
    "SELECT singleton, row_count, set_fingerprint FROM image_replay_set_witness LIMIT 2",
  ).all();
  const row = rows[0];
  if (rows.length !== 1 || row?.singleton !== 1 || !Number.isSafeInteger(row.row_count)
    || Number(row.row_count) < 0 || !(row.set_fingerprint instanceof Uint8Array)
    || row.set_fingerprint.byteLength !== 32) {
    throw replayError("The image replay journal set witness is malformed.");
  }
  return { rowCount: Number(row.row_count), fingerprint: new Uint8Array(row.set_fingerprint) };
}

function assertSetWitness(database: Database, secret: Uint8Array): void {
  const expected = expectedSetState(database, secret);
  const observed = readSetWitness(database);
  if (expected.rowCount !== observed.rowCount || !equalWitness(expected.fingerprint, observed.fingerprint)) {
    throw replayError("The image replay journal set witness does not match retained rows.");
  }
}

function resealRowsAndSet(database: Database, secret: Uint8Array): void {
  const rows = readAllRows(database);
  for (const row of rows) {
    assertRowShape(row, false);
    database.query("UPDATE image_requests SET row_witness = ? WHERE operation_key = ?")
      .run(deriveRowWitness(secret, row), row.operation_key as string);
  }
  const expected = expectedSetState(database, secret);
  const updated = database.query(
    "UPDATE image_replay_set_witness SET row_count = ?, set_fingerprint = ? WHERE singleton = 1",
  ).run(expected.rowCount, expected.fingerprint);
  if (updated.changes !== 1) throw replayError("The image replay journal set witness could not be sealed.");
}

export class ImageReplayStore {
  readonly #database: Database;
  readonly #file: StableLockFile;
  readonly #owner: MediaJournalOwnerLease;
  readonly #path: string;
  readonly #secret: Uint8Array;
  readonly #now: () => number;
  #closed = false;

  constructor(options: ImageReplayStoreOptions = {}) {
    this.#path = canonicalPath(options.path ?? defaultPath());
    const existedBeforeOpen = existsSync(this.#path);
    const secretPath = videoOperationReplaySecretPathForJournal(this.#path);
    const ownerPath = `${this.#path}${OWNER_SUFFIX}`;
    const companionExistedBeforeOpen = existsSync(secretPath) || existsSync(ownerPath);
    // A replay authority or owner file without its journal proves state was lost.
    // Never bless that partial deletion as a fresh installation: it may have erased
    // a post-dispatch tombstone whose only purpose was to prevent another paid POST.
    if (!existedBeforeOpen && companionExistedBeforeOpen) {
      throw replayError("The image replay journal is missing while replay authority state remains.");
    }
    const production = options.path === undefined;
    if (production) {
      const root = getConfigDir();
      recordOwnedConfigPath(root, dirname(this.#path));
      for (const suffix of ["", "-journal", "-wal", "-shm", ".recovery-owner.sqlite"]) {
        recordOwnedConfigPath(root, `${this.#path}${suffix}`);
      }
      recordOwnedConfigPath(root, secretPath);
    }
    let owner: MediaJournalOwnerLease | undefined;
    let file: StableLockFile | undefined;
    let database: Database | undefined;
    try {
      owner = acquireMediaJournalOwnerLease(this.#path);
      if (existedBeforeOpen && !privateFile(lstatSync(this.#path))) throw replayError("The image replay journal is unsafe.");
      file = openStableLockFile(this.#path);
      if (!existedBeforeOpen || process.platform === "win32") hardenFile(this.#path);
      assertStableLockFile(this.#path, file);
      database = new Database(this.#path, { create: true, strict: true });
      database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = NORMAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
      const mode = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get()?.journal_mode;
      if (mode?.toLowerCase() !== "delete") throw replayError("The image replay journal durability mode is unavailable.");
      database.exec("BEGIN IMMEDIATE");
      const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
      const fresh = version === 0 && schemaEmpty(database) && !companionExistedBeforeOpen;
      if (fresh) createFreshSchema(database);
      else {
        if (version !== 2) {
          throw replayError(version === 1
            ? "The image replay journal predates authenticated row-set recovery and must fail closed."
            : "The image replay journal schema version is unsupported.");
        }
        assertExactSchema(database);
      }
      const preexistingWitness = fresh ? undefined : database.query<{ secret_fingerprint: Uint8Array }, []>(
        "SELECT secret_fingerprint FROM image_replay_authority_witness WHERE singleton = 1",
      ).get()?.secret_fingerprint;
      if (!fresh && !preexistingWitness) throw replayError("The image replay journal lost its replay authority witness.");
      const count = database.query<{ count: number }, []>("SELECT count(*) AS count FROM image_requests").get()?.count;
      if (!Number.isInteger(count) || Number(count) > MAX_ROWS) throw replayError("The image replay journal row limit was exceeded.");
      const witness = preexistingWitness ?? database.query<{ secret_fingerprint: Uint8Array }, []>(
        "SELECT secret_fingerprint FROM image_replay_authority_witness WHERE singleton = 1",
      ).get()?.secret_fingerprint;
      const authority = reconcileVideoOperationReplaySecret({
        journalPath: this.#path,
        ...(witness ? { witnessFingerprint: witness } : {}),
        hasRetryRecords: Number(count) > 0,
        ...(options.replayAuthorityFsyncDirectory ? { fsyncDirectory: options.replayAuthorityFsyncDirectory } : {}),
      });
      if (authority.witnessChanged) {
        options.replayAuthorityCrashSeam?.();
        database.query(
          "INSERT OR REPLACE INTO image_replay_authority_witness(singleton, secret_fingerprint) VALUES (1, ?)",
        ).run(authority.fingerprint);
      }
      if (fresh) {
        database.query(
          "INSERT INTO image_replay_set_witness(singleton, row_count, set_fingerprint) VALUES (1, 0, ?)",
        ).run(new Uint8Array(32));
        resealRowsAndSet(database, authority.secret);
      } else if (authority.witnessChanged) {
        const observed = readSetWitness(database);
        if (Number(count) !== 0 || observed.rowCount !== 0) {
          throw replayError("The image replay authority changed while retained rows remain.");
        }
        resealRowsAndSet(database, authority.secret);
      } else {
        assertSetWitness(database, authority.secret);
      }
      const now = options.now?.() ?? Date.now();
      database.query("DELETE FROM image_requests WHERE state = 'reserved'").run();
      database.query("UPDATE image_requests SET state = 'outcome_unknown', updated_at = ? WHERE state = 'submitting'").run(now);
      resealRowsAndSet(database, authority.secret);
      database.exec("COMMIT");
      this.#database = database;
      this.#file = file;
      this.#owner = owner;
      this.#secret = authority.secret;
      this.#now = options.now ?? Date.now;
    } catch (error) {
      try { database?.exec("ROLLBACK"); } catch { /* close below */ }
      try { database?.close(); } catch { /* close below */ }
      try { file?.close(); } catch { /* close below */ }
      try { owner?.close(); } catch { /* close below */ }
      if (error instanceof Error && (error.name === "ImageReplayStoreError" || error.name === "MediaJournalError")) throw error;
      throw replayError("The image replay journal is unavailable.");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw replayError("The image replay journal is closed.");
    this.#owner.assertOwned();
    assertStableLockFile(this.#path, this.#file);
    if (!privateFile(lstatSync(this.#path))) throw replayError("The image replay journal is unsafe.");
  }

  #transaction<T>(operation: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      assertExactSchema(this.#database);
      assertSetWitness(this.#database, this.#secret);
      const value = operation();
      resealRowsAndSet(this.#database, this.#secret);
      assertSetWitness(this.#database, this.#secret);
      this.#assertOpen();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* close remains possible */ }
      throw error;
    }
  }

  deriveIdentity(
    clientRequestId: string | undefined,
    admission: ImageOperationAdmissionScope,
    body: unknown,
  ): ImageOperationIdentity {
    this.#transaction(() => undefined);
    return deriveImageOperationIdentity(clientRequestId, this.#secret, admission, body);
  }

  reserve(identity: ImageOperationIdentity): ImageReplayReservation {
    return this.#transaction(() => {
      const now = this.#now();
      this.#database.query(`
        DELETE FROM image_requests
         WHERE state = 'completed'
           AND updated_at <= ? - CASE identity_kind
             WHEN 'explicit' THEN ? ELSE ? END
      `).run(now, IMAGE_EXPLICIT_REPLAY_WINDOW_MS, IMAGE_BODY_FALLBACK_WINDOW_MS);
      const row = this.#database.query<ImageReplayRow, [string]>(
        "SELECT * FROM image_requests WHERE operation_key = ?",
      ).get(identity.operationKey);
      if (row) {
        assertRowShape(row);
        if (row.request_semantics_digest !== identity.requestSemanticsDigest
          || row.principal_digest !== identity.principalDigest
          || row.identity_kind !== identity.identityKind) {
          return { kind: "conflict" };
        }
        if (row.state === "completed") return { kind: "replay", response: decodeStoredResponse(row) };
        if (row.state === "outcome_unknown") return { kind: "outcome_unknown" };
        return { kind: "busy" };
      }
      const count = this.#database.query<{ count: number }, []>("SELECT count(*) AS count FROM image_requests").get()?.count;
      if (!Number.isInteger(count) || Number(count) >= MAX_ROWS) return { kind: "saturated" };
      const principalCount = this.#database.query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM image_requests WHERE principal_digest = ?",
      ).get(identity.principalDigest)?.count;
      const activeResultCount = this.#database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM image_requests WHERE state != 'outcome_unknown'",
      ).get()?.count;
      if (!Number.isInteger(principalCount) || Number(principalCount) >= MAX_ROWS_PER_PRINCIPAL
        || !Number.isInteger(activeResultCount) || Number(activeResultCount) >= MAX_ACTIVE_RESULT_ROWS) {
        return { kind: "saturated" };
      }
      this.#database.query(`
        INSERT INTO image_requests(
          operation_key, request_semantics_digest, principal_digest, identity_kind, state,
          response_status, response_no_retry, response_json, created_at, updated_at, row_witness
        ) VALUES (?, ?, ?, ?, 'reserved', NULL, NULL, NULL, ?, ?, ?)
      `).run(
        identity.operationKey,
        identity.requestSemanticsDigest,
        identity.principalDigest,
        identity.identityKind,
        now,
        now,
        new Uint8Array(32),
      );
      return { kind: "created" };
    });
  }

  lookup(identity: ImageOperationIdentity): ImageReplayLookup {
    return this.#transaction(() => {
      const now = this.#now();
      this.#database.query(`
        DELETE FROM image_requests
         WHERE state = 'completed'
           AND updated_at <= ? - CASE identity_kind
             WHEN 'explicit' THEN ? ELSE ? END
      `).run(now, IMAGE_EXPLICIT_REPLAY_WINDOW_MS, IMAGE_BODY_FALLBACK_WINDOW_MS);
      const row = this.#database.query<ImageReplayRow, [string]>(
        "SELECT * FROM image_requests WHERE operation_key = ?",
      ).get(identity.operationKey);
      if (!row) return { kind: "none" };
      assertRowShape(row);
      if (row.request_semantics_digest !== identity.requestSemanticsDigest
        || row.principal_digest !== identity.principalDigest
        || row.identity_kind !== identity.identityKind) return { kind: "conflict" };
      if (row.state === "completed") return { kind: "replay", response: decodeStoredResponse(row) };
      if (row.state === "outcome_unknown") return { kind: "outcome_unknown" };
      return { kind: "busy" };
    });
  }

  releaseReserved(operationKey: string): void {
    this.#transaction(() => {
      this.#database.query("DELETE FROM image_requests WHERE operation_key = ? AND state = 'reserved'").run(operationKey);
    });
  }

  markSubmitting(operationKey: string): void {
    const changed = this.#transaction(() => this.#database.query(`
      UPDATE image_requests SET state = 'submitting', updated_at = ?
       WHERE operation_key = ? AND state = 'reserved'
    `).run(this.#now(), operationKey).changes);
    if (changed !== 1) throw replayError("The image replay submission fence was lost.");
  }

  releasePreDispatch(operationKey: string): void {
    this.#transaction(() => {
      this.#database.query("DELETE FROM image_requests WHERE operation_key = ? AND state = 'submitting'").run(operationKey);
    });
  }

  markOutcomeUnknown(operationKey: string): void {
    const changed = this.#transaction(() => this.#database.query(`
      UPDATE image_requests SET state = 'outcome_unknown', updated_at = ?
       WHERE operation_key = ? AND state = 'submitting'
    `).run(this.#now(), operationKey).changes);
    if (changed !== 1) throw replayError("The image replay uncertainty fence was lost.");
  }

  complete(operationKey: string, response: StoredImageResponse): void {
    const encoded = new TextEncoder().encode(response.body);
    if (encoded.byteLength < 2 || encoded.byteLength > MAX_RESULT_BYTES) {
      throw replayError("The image replay response is too large.");
    }
    const parsed = JSON.parse(response.body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      throw replayError("The image replay response is invalid.");
    }
    const changed = this.#transaction(() => {
      let total = Number(this.#database.query<{ total: number }, []>(
        "SELECT coalesce(sum(length(response_json)), 0) AS total FROM image_requests WHERE state = 'completed'",
      ).get()?.total ?? 0);
      const unavailable = new TextEncoder().encode(UNAVAILABLE_RESULT);
      if (total + encoded.byteLength > MAX_TOTAL_RESULT_BYTES) {
        const candidates = this.#database.query<{ operation_key: string; bytes: number }, [string]>(`
          SELECT operation_key, length(response_json) AS bytes
            FROM image_requests
           WHERE state = 'completed' AND operation_key != ?
           ORDER BY updated_at ASC, operation_key ASC
        `).all(operationKey);
        for (const candidate of candidates) {
          if (total + encoded.byteLength <= MAX_TOTAL_RESULT_BYTES) break;
          this.#database.query(`
            UPDATE image_requests
               SET response_status = 409, response_no_retry = 1, response_json = ?, updated_at = updated_at
             WHERE operation_key = ? AND state = 'completed'
          `).run(unavailable, candidate.operation_key);
          total -= Math.max(0, candidate.bytes - unavailable.byteLength);
        }
      }
      if (total + encoded.byteLength > MAX_TOTAL_RESULT_BYTES) throw replayError("The image replay result capacity was exceeded.");
      return this.#database.query(`
        UPDATE image_requests
           SET state = 'completed', response_status = ?, response_no_retry = ?, response_json = ?, updated_at = ?
         WHERE operation_key = ? AND state = 'submitting'
      `).run(response.status, response.noRetry ? 1 : 0, encoded, this.#now(), operationKey).changes;
    });
    if (changed !== 1) throw replayError("The image replay completion fence was lost.");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#database.close(); } finally {
      try { this.#file.close(); } finally { this.#owner.close(); }
    }
  }
}

export function openImageReplayStore(options: ImageReplayStoreOptions = {}): ImageReplayStore {
  return new ImageReplayStore(options);
}

export function defaultImageReplayStorePath(): string {
  return defaultPath();
}

/** Any durable remnant means prior paid-operation state may exist and must be reconciled. */
export function imageReplayAuthorityExists(path = defaultPath()): boolean {
  return existsSync(path)
    || existsSync(videoOperationReplaySecretPathForJournal(path))
    || existsSync(`${path}${OWNER_SUFFIX}`);
}

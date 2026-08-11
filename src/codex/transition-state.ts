/**
 * CODEX_HOME-keyed transition state and coordinator transaction ownership.
 *
 * This module owns the SQLite row, the conditional UPDATE, and the opaque
 * one-shot capability backed by an already-open `BEGIN IMMEDIATE` transaction.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, realpathSync } from "node:fs";

import { Database } from "bun:sqlite";

import type {
  BeginCodexTransition,
  CodexCoordinatorTransaction,
  CodexCoordinatorTransactionController,
  CodexTransitionState,
  CommitExpectation,
  ReadCodexTransitionState,
  TransitionStateRead,
  TransitionStateUpdate,
} from "./convergence-types";
import { resolveCodexHomeDir } from "./home";
import { readIntegrationRecord } from "./integration-record";
import { classifyNativeRoutedResidue } from "./native-residue";
import {
  CodexUserIdentityRefusal,
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "./user-identity";

const COORDINATOR_SCHEMA_VERSION = 2;

const CREATE_TRANSITION_TABLE = `
  CREATE TABLE IF NOT EXISTS codex_transition_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    native_generation INTEGER NOT NULL CHECK (native_generation >= 0),
    current_tx_id TEXT,
    updated_at TEXT NOT NULL,
    CHECK ((native_generation = 0 AND current_tx_id IS NULL)
        OR (native_generation > 0 AND length(trim(current_tx_id)) > 0))
  )`;

const INITIALIZE_TRANSITION_ROW = `
  INSERT OR IGNORE INTO codex_transition_state (
    singleton, native_generation, current_tx_id, updated_at
  ) VALUES (1, 0, NULL, ?)`;

const SELECT_TRANSITION_ROW = `
  SELECT native_generation, current_tx_id
    FROM codex_transition_state
   WHERE singleton = 1`;

const BEGIN_TRANSITION = `
  UPDATE codex_transition_state
     SET native_generation = ?, current_tx_id = ?, updated_at = ?
   WHERE singleton = 1
     AND native_generation = ?
     AND current_tx_id IS ?`;

interface TransitionRow {
  native_generation: unknown;
  current_tx_id: unknown;
}

const codexCoordinatorTransactionBrand: unique symbol = Symbol("CodexCoordinatorTransaction");

interface BrandedCodexCoordinatorTransaction extends CodexCoordinatorTransaction {
  readonly [codexCoordinatorTransactionBrand]: true;
}

export class CodexCoordinatorTransactionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexCoordinatorTransactionError";
  }
}

class CodexCoordinatorStateAmbiguousError extends CodexCoordinatorTransactionError {
  constructor(message: string) {
    super(message);
    this.name = "CodexCoordinatorStateAmbiguousError";
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database (?:is|table is) locked/i.test(message);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function rowToState(row: TransitionRow | null): CodexTransitionState {
  if (!row) throw new CodexCoordinatorTransactionError("The coordinator transition row is missing.");
  if (!isNonNegativeInteger(row.native_generation)
    || !nullableString(row.current_tx_id)) {
    throw new CodexCoordinatorTransactionError("The coordinator transition row is malformed.");
  }

  const generation = row.native_generation;
  if (generation === 0 && row.current_tx_id !== null) {
    throw new CodexCoordinatorTransactionError("The initial coordinator row contains transition metadata.");
  }
  if (generation > 0 && !row.current_tx_id?.trim()) {
    throw new CodexCoordinatorTransactionError("The positive coordinator row lacks its transaction id.");
  }

  return {
    nativeGeneration: generation,
    currentTxId: row.current_tx_id,
  };
}

function readState(database: Database): CodexTransitionState {
  const row = database.query<TransitionRow, []>(SELECT_TRANSITION_ROW).get();
  return rowToState(row);
}

/**
 * The missing-row incident proved that absence is not authority: installing
 * `{0,null}` over routed native bytes loses the only evidence that an
 * interrupted current transition still needs recovery.
 */
function assertInitialStateCanBeCreated(): void {
  const integration = readIntegrationRecord();
  if (integration.kind === "invalid") {
    throw new CodexCoordinatorStateAmbiguousError(
      "A missing coordinator row cannot be initialized over invalid Codex integration state.",
    );
  }
  if (classifyNativeRoutedResidue().kind !== "clean") {
    throw new CodexCoordinatorStateAmbiguousError(
      "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
    );
  }
}

function databaseSchemaIsEmpty(database: Database): boolean {
  return database.query<Record<string, unknown>, []>(
    "SELECT 1 FROM sqlite_schema LIMIT 1",
  ).get() === null;
}

function initialize(database: Database, _databaseWasAbsent: boolean): void {
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
  if (version === 0) {
    // First use and a rolled-back recovery bootstrap are intentionally
    // indistinguishable only when SQLite contains literally no schema object.
    // Any unversioned table/index/trigger remains ambiguous and is never
    // adopted. The unchanged native-residue check still runs under BEGIN.
    if (!databaseSchemaIsEmpty(database)) {
      throw new CodexCoordinatorStateAmbiguousError(
        "An existing unversioned coordinator database is unsupported.",
      );
    }
    assertInitialStateCanBeCreated();
    database.exec(CREATE_TRANSITION_TABLE);
    database.query(INITIALIZE_TRANSITION_ROW).run(new Date().toISOString());
    database.exec(`PRAGMA user_version = ${COORDINATOR_SCHEMA_VERSION}`);
    readState(database);
    return;
  }
  if (version !== COORDINATOR_SCHEMA_VERSION) {
    throw new CodexCoordinatorTransactionError("The coordinator database schema version is unsupported.");
  }
  database.exec(CREATE_TRANSITION_TABLE);
  const existing = database.query<TransitionRow, []>(SELECT_TRANSITION_ROW).get();
  if (!existing) {
    throw new CodexCoordinatorStateAmbiguousError(
      "The existing coordinator database has no authoritative transition row.",
    );
  }
  readState(database);
}

/**
 * Recovery N may encounter either the authoritative v2 coordinator or the
 * exact empty SQLite shell left when an earlier bootstrap rolled back/crashed.
 * It never adopts an unversioned database containing any user schema.
 */
function prepareRecoveryCoordinator(
  database: Database,
  databaseWasAbsent: boolean,
): { deferredInitialization: boolean } {
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
  if (version === COORDINATOR_SCHEMA_VERSION) {
    initialize(database, databaseWasAbsent);
    return { deferredInitialization: false };
  }
  if (version !== 0) {
    throw new CodexCoordinatorTransactionError("The coordinator database schema version is unsupported.");
  }
  if (!databaseSchemaIsEmpty(database)) {
    throw new CodexCoordinatorStateAmbiguousError(
      "An unversioned coordinator database with schema cannot be adopted for recovery.",
    );
  }
  return { deferredInitialization: true };
}

function createCapability(
  database: Database,
  onResult: (result: TransitionStateUpdate) => void,
): BrandedCodexCoordinatorTransaction {
  let consumed = false;
  return {
    [codexCoordinatorTransactionBrand]: true,
    beginTransition(expected, next) {
      if (consumed) {
        throw new CodexCoordinatorTransactionError("The coordinator capability has already been consumed.");
      }
      consumed = true;
      if (!isNonNegativeInteger(expected.nativeGeneration)
        || (expected.currentTxId !== null && !expected.currentTxId.trim())
        || !next.txId.trim()) {
        throw new CodexCoordinatorTransactionError("The transition update is malformed.");
      }

      const result = database.query(BEGIN_TRANSITION).run(
        expected.nativeGeneration + 1,
        next.txId,
        new Date().toISOString(),
        expected.nativeGeneration,
        expected.currentTxId,
      );
      const state = readState(database);
      const update: TransitionStateUpdate = result.changes === 1
        ? { kind: "updated", state }
        : { kind: "conflict", current: state };
      onResult(update);
      return update;
    },
  };
}

function createDeferredRecoveryCapability(
  database: Database,
  onResult: (result: TransitionStateUpdate) => void,
): BrandedCodexCoordinatorTransaction {
  let consumed = false;
  return {
    [codexCoordinatorTransactionBrand]: true,
    beginTransition(expected, next) {
      if (consumed) {
        throw new CodexCoordinatorTransactionError("The coordinator capability has already been consumed.");
      }
      consumed = true;
      if (expected.nativeGeneration !== 0
        || expected.currentTxId !== null
        || !next.txId.trim()) {
        throw new CodexCoordinatorTransactionError("The recovery bootstrap transition is malformed.");
      }
      database.exec(CREATE_TRANSITION_TABLE);
      database.query(INITIALIZE_TRANSITION_ROW).run(new Date().toISOString());
      database.exec(`PRAGMA user_version = ${COORDINATOR_SCHEMA_VERSION}`);
      const result = database.query(BEGIN_TRANSITION).run(
        1,
        next.txId,
        new Date().toISOString(),
        0,
        null,
      );
      const state = readState(database);
      const update: TransitionStateUpdate = result.changes === 1
        ? { kind: "updated", state }
        : { kind: "conflict", current: state };
      onResult(update);
      return update;
    },
  };
}

function beginCodexCoordinatorTransactionInternal(
  finalDatabasePath: string,
  recovery: boolean,
  revalidateRecoveryAdmission?: () => boolean,
  validateSettledRecovery?: () => boolean,
): CodexCoordinatorTransactionController {
  let database: Database | undefined;
  let transactionOpen = false;
  let closed = false;
  let lastResult: TransitionStateUpdate | undefined;
  let initialIdentity: string | undefined;
  let databaseWasAbsent = false;
  let deferredRecoveryInitialization = false;

  try {
    try {
      const before = lstatSync(finalDatabasePath);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new CodexUserIdentityRefusal("The coordinator database path is not a real file.");
      }
      if (process.platform !== "win32") {
        const uid = process.getuid?.();
        // Ownership is decided here; MODE is not.
        //
        // Two processes reaching first use together both observe ENOENT, and the
        // loser can lstat the winner's file in the window between its creation
        // and its chmod. Refusing on mode here read as a permission problem when
        // it was a schedule — a real 1-in-12 flake on a 16-core box. Our own file
        // is ours to narrow, so the mode decision moves below the open, where it
        // can tighten once and then judge the settled state. A file owned by
        // somebody else is still refused immediately: that is not a race, and no
        // amount of waiting makes it ours.
        if (uid === undefined || before.uid !== uid) {
          throw new CodexUserIdentityRefusal(
            "The coordinator database has unsafe ownership or permissions.",
          );
        }
      }
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") throw cause;
      databaseWasAbsent = true;
    }
    database = new Database(finalDatabasePath, { create: true });
    if (databaseWasAbsent) {
      try { chmodSync(finalDatabasePath, 0o600); } catch { /* Windows applies ACLs in WP11. */ }
    }
    // Re-check ownership and mode AFTER the open, not only before it.
    //
    // Two processes reaching first use together both see ENOENT, and the loser
    // opens the winner's file in the window before the winner's chmod lands. Its
    // pre-open check had already passed (the file did not exist), so without this
    // the loser refused with `unsafe-path` — a real flake, reproduced 1-in-12 on
    // a 16-core box, that read as a permission problem when it was a schedule.
    //
    // Narrowing our own descriptor's mode is safe and idempotent; a file that is
    // still wrong afterwards is genuinely wrong, not merely early.
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      let current = lstatSync(finalDatabasePath);
      if ((current.mode & 0o777) !== 0o600) {
        try { chmodSync(finalDatabasePath, 0o600); } catch { /* refused below */ }
        current = lstatSync(finalDatabasePath);
      }
      if (uid === undefined || current.uid !== uid || (current.mode & 0o777) !== 0o600) {
        throw new CodexUserIdentityRefusal(
          "The coordinator database has unsafe ownership or permissions.",
        );
      }
    }
    const opened = lstatSync(finalDatabasePath);
    if (opened.isSymbolicLink() || !opened.isFile()) {
      throw new CodexUserIdentityRefusal("The coordinator database path changed during open.");
    }
    initialIdentity = `${opened.dev}:${opened.ino}`;
    database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = NORMAL; BEGIN IMMEDIATE");
    transactionOpen = true;
    if (recovery) {
      if (!revalidateRecoveryAdmission?.()) {
        throw new CodexCoordinatorStateAmbiguousError(
          "The recovery admission changed before the coordinator lock was acquired.",
        );
      }
      deferredRecoveryInitialization = prepareRecoveryCoordinator(database, databaseWasAbsent)
        .deferredInitialization;
    } else {
      initialize(database, databaseWasAbsent);
    }
  } catch (cause) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close releases the transaction */ }
    }
    try { database?.close(); } catch { /* acquisition already failed */ }
    throw cause;
  }

  const db = database;
  const requireOpen = (): void => {
    if (closed || !transactionOpen) throw new CodexCoordinatorTransactionError("The coordinator transaction is closed.");
  };
  const assertStablePath = (): void => {
    requireOpen();
    const entry = lstatSync(finalDatabasePath);
    if (entry.isSymbolicLink() || !entry.isFile()
      || `${entry.dev}:${entry.ino}` !== initialIdentity
      || realpathSync.native(finalDatabasePath) !== finalDatabasePath) {
      throw new CodexUserIdentityRefusal("The coordinator database path was substituted.");
    }
  };

  const capability = deferredRecoveryInitialization
    ? createDeferredRecoveryCapability(db, result => { lastResult = result; })
    : createCapability(db, result => { lastResult = result; });
  return {
    capability,
    expectation() {
      requireOpen();
      if (deferredRecoveryInitialization && lastResult === undefined) {
        return { nativeBefore: 0, nativeAfter: 1, txId: randomUUID() };
      }
      const state = readState(db);
      return {
        nativeBefore: state.nativeGeneration,
        nativeAfter: state.nativeGeneration + 1,
        txId: randomUUID(),
      };
    },
    version() {
      requireOpen();
      if (deferredRecoveryInitialization && lastResult === undefined) {
        return { nativeGeneration: 0, currentTxId: null };
      }
      const state = readState(db);
      return { nativeGeneration: state.nativeGeneration, currentTxId: state.currentTxId };
    },
    assertPublished(expectation) {
      requireOpen();
      if (lastResult?.kind !== "updated") {
        throw new CodexCoordinatorTransactionError("The coordinator transition was not published.");
      }
      const state = readState(db);
      if (state.nativeGeneration !== expectation.nativeAfter || state.currentTxId !== expectation.txId) {
        throw new CodexCoordinatorTransactionError("The coordinator published a different transition.");
      }
    },
    assertStablePath,
    commit() {
      requireOpen();
      // The recovery-only initializer may publish into an absent/empty shell,
      // but it cannot COMMIT authority until the ordinary, unchanged clean-home
      // predicate succeeds after journal recovery and retirement.
      if (deferredRecoveryInitialization) {
        if (validateSettledRecovery) {
          if (!validateSettledRecovery()) {
            throw new CodexCoordinatorStateAmbiguousError(
              "The recovered native Codex state did not satisfy its final admission.",
            );
          }
        } else {
          assertInitialStateCanBeCreated();
        }
      }
      assertStablePath();
      db.exec("COMMIT");
      transactionOpen = false;
    },
    rollback() {
      if (!closed && transactionOpen) {
        try { db.exec("ROLLBACK"); } finally { transactionOpen = false; }
      }
    },
    close() {
      if (closed) return;
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* close still releases the lock */ }
        transactionOpen = false;
      }
      db.close();
      closed = true;
    },
  };
}

export function beginCodexCoordinatorTransaction(
  finalDatabasePath: string,
): CodexCoordinatorTransactionController {
  return beginCodexCoordinatorTransactionInternal(finalDatabasePath, false);
}

/**
 * Recovery-only N acquisition. It shares the exact database/OS lock with every
 * ordinary writer but may defer initialization over one valid dead journal.
 * The controller still refuses to commit until ordinary residue admission is
 * clean; callers cannot use this as a generic adoption escape hatch.
 */
export function beginCodexCoordinatorRecoveryTransaction(
  finalDatabasePath: string,
  revalidateRecoveryAdmission: () => boolean,
  validateSettledRecovery?: () => boolean,
): CodexCoordinatorTransactionController {
  return beginCodexCoordinatorTransactionInternal(
    finalDatabasePath,
    true,
    revalidateRecoveryAdmission,
    validateSettledRecovery,
  );
}

function currentCoordinatorDatabasePath(): string {
  const canonicalCodexHome = realpathSync.native(resolveCodexHomeDir());
  return resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), canonicalCodexHome);
}

function mapUnavailable(
  error: unknown,
): Extract<TransitionStateRead, { kind: "unavailable" }> {
  if (error instanceof CodexUserIdentityRefusal) return { kind: "unavailable", reason: "unsafe-path" };
  return { kind: "unavailable", reason: isBusy(error) ? "busy" : "database" };
}

function mapReadError(error: unknown): TransitionStateRead {
  if (error instanceof CodexCoordinatorStateAmbiguousError) {
    return { kind: "state-ambiguous", message: error.message };
  }
  return mapUnavailable(error);
}

function preflightMissingCoordinator(finalDatabasePath: string): void {
  try {
    lstatSync(finalDatabasePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    // Refuse before SQLite creates an empty file. `initialize()` repeats this
    // check under BEGIN IMMEDIATE so a concurrent native write cannot be
    // adopted between this side-effect-free preflight and acquisition.
    assertInitialStateCanBeCreated();
  }
}

export const readCodexTransitionState: ReadCodexTransitionState = () => {
  let transaction: CodexCoordinatorTransactionController | undefined;
  try {
    const path = currentCoordinatorDatabasePath();
    preflightMissingCoordinator(path);
    transaction = beginCodexCoordinatorTransaction(path);
    // Initialization and validation happen while N is held. Commit that setup
    // before reopening read-only; the controller never leaks its Database.
    transaction.commit();
    transaction.close();
    transaction = undefined;
    return readCommittedState();
  } catch (error) {
    transaction?.rollback();
    return mapReadError(error);
  } finally {
    transaction?.close();
  }
};

function readCommittedState(): TransitionStateRead {
  const path = currentCoordinatorDatabasePath();
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true });
    database.exec("PRAGMA busy_timeout = 0");
    return { kind: "ready", state: readState(database) };
  } catch (error) {
    return mapUnavailable(error);
  } finally {
    try { database?.close(); } catch { /* read already completed */ }
  }
}

export const beginCodexTransition: BeginCodexTransition = (expected, next) => {
  let transaction: CodexCoordinatorTransactionController | undefined;
  try {
    transaction = beginCodexCoordinatorTransaction(currentCoordinatorDatabasePath());
    const result = transaction.capability.beginTransition(expected, next);
    transaction.commit();
    return result;
  } catch (error) {
    transaction?.rollback();
    const unavailable = mapUnavailable(error);
    return { kind: "unavailable", reason: unavailable.reason };
  } finally {
    transaction?.close();
  }
};

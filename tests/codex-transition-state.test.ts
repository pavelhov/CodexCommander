import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "bun:sqlite";

import {
  beginCodexTransition,
  beginCodexCoordinatorTransaction,
  readCodexTransitionState,
} from "../src/codex/transition-state";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";

let codexHome = "";
let codexCommanderHome = "";
let coordinatorPath = "";
let previousCodexHome: string | undefined;
let previousCodexCommanderHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ccx-transition-state-codex-home-"));
  codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-transition-state-codexcommander-home-"));
  process.env.CODEX_HOME = codexHome;
  process.env.CODEXCOMMANDER_HOME = codexCommanderHome;
  coordinatorPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${coordinatorPath}${suffix}`, { force: true });
  }
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(codexCommanderHome, { recursive: true, force: true });
});

function transition(txId: string) {
  return { txId };
}

test("a missing database initializes only from clean integration and native state", () => {
  expect(readCodexTransitionState()).toEqual({
    kind: "ready",
    state: {
      nativeGeneration: 0,
      currentTxId: null,
    },
  });

  const result = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-winner"),
  );
  expect(result.kind).toBe("updated");
  if (result.kind === "updated") {
    expect(result.state.nativeGeneration).toBe(1);
    expect(result.state.currentTxId).toBe("tx-winner");
  }
});

/**
 * Absence of the coordinator file also said nothing about native bytes. The
 * exact marker-owned routing grammar is authoritative residue and must prevent
 * a fresh zero row from claiming no transition ever happened.
 */
test("a missing database with native routed residue is state-ambiguous", () => {
  writeFileSync(join(codexHome, "config.toml"), [
    "# Auto-injected by CodexCommander",
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    "",
  ].join("\n"));

  expect(readCodexTransitionState()).toEqual({
    kind: "state-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
  expect(existsSync(coordinatorPath)).toBe(false);
});

test("an existing database without the singleton row is state-ambiguous", () => {
  const database = new Database(coordinatorPath, { create: true });
  database.exec("PRAGMA user_version = 2");
  database.close();
  if (process.platform !== "win32") chmodSync(coordinatorPath, 0o600);

  expect(readCodexTransitionState()).toEqual({
    kind: "state-ambiguous",
    message: "The existing coordinator database has no authoritative transition row.",
  });
});

test("a zero-row conditional update reports conflict and preserves the winner", () => {
  const winner = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-newer"),
  );
  expect(winner.kind).toBe("updated");

  const stale = beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-stale"),
  );
  expect(stale.kind).toBe("conflict");
  if (stale.kind === "conflict") {
    expect(stale.current.currentTxId).toBe("tx-newer");
  }
  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 1, currentTxId: "tx-newer" },
  });
});

/**
 * The C-phase review found the conflict tests PARTIAL: every stale caller they
 * exercised disagreed on BOTH halves of the expected pair, so dropping either
 * `native_generation = ?` or `current_tx_id IS ?` from the CAS predicate left
 * them green. A CAS on a two-part version has to be proven one part at a time.
 */
test("a native CAS with a matching generation but the wrong txId still conflicts", () => {
  expect(beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-a"),
  ).kind).toBe("updated");
  expect(beginCodexTransition(
    { nativeGeneration: 1, currentTxId: "tx-a" },
    transition("tx-b"),
  ).kind).toBe("updated");

  // Generation 2 is current, so only the txId half disagrees. Removing the
  // `current_tx_id IS ?` predicate makes this succeed.
  const wrongTxId = beginCodexTransition(
    { nativeGeneration: 2, currentTxId: "tx-a" },
    transition("tx-forged"),
  );
  expect(wrongTxId.kind).toBe("conflict");

  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 2, currentTxId: "tx-b" },
  });
});

for (const generation of [1, 2, 4]) {
  test(`a native CAS at generation ${generation} never treats a null txId as a wildcard`, () => {
    let currentTxId: string | null = null;
    for (let nextGeneration = 1; nextGeneration <= generation; nextGeneration++) {
      const nextTxId = `tx-current-${nextGeneration}`;
      expect(beginCodexTransition(
        { nativeGeneration: nextGeneration - 1, currentTxId },
        transition(nextTxId),
      ).kind).toBe("updated");
      currentTxId = nextTxId;
    }

    const nullTxId = beginCodexTransition(
      { nativeGeneration: generation, currentTxId: null },
      transition("tx-forged"),
    );
    expect(nullTxId.kind).toBe("conflict");

    expect(readCodexTransitionState()).toMatchObject({
      kind: "ready",
      state: { nativeGeneration: generation, currentTxId },
    });
  });
}

test("a native CAS with a matching txId but the wrong generation still conflicts", () => {
  expect(beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-a"),
  ).kind).toBe("updated");
  expect(beginCodexTransition(
    { nativeGeneration: 1, currentTxId: "tx-a" },
    transition("tx-b"),
  ).kind).toBe("updated");

  // `tx-b` really is the current txId, so only the generation half disagrees.
  // Removing the `native_generation = ?` predicate makes this succeed.
  const wrongGeneration = beginCodexTransition(
    { nativeGeneration: 1, currentTxId: "tx-b" },
    transition("tx-forged"),
  );
  expect(wrongGeneration.kind).toBe("conflict");

  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 2, currentTxId: "tx-b" },
  });
});

test("the row validator refuses every whitespace-only txId", () => {
  expect(beginCodexTransition(
    { nativeGeneration: 0, currentTxId: null },
    transition("tx-blank"),
  ).kind).toBe("updated");

  const trimRemovedCodePoints: Array<[string, string]> = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
    const character = String.fromCodePoint(codePoint);
    if (character.trim() === "") {
      trimRemovedCodePoints.push([
        `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
        character,
      ]);
    }
  }
  expect(trimRemovedCodePoints.some(([, value]) => value === "\r")).toBe(true);

  for (const [label, txId] of trimRemovedCodePoints) {
    const database = new Database(coordinatorPath);
    try {
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.query(
        "UPDATE codex_transition_state SET current_tx_id = ? WHERE singleton = 1",
      ).run(txId);
    } finally {
      database.close();
    }

    expect(readCodexTransitionState(), label).toEqual({ kind: "unavailable", reason: "database" });
  }
});

/**
 * A capability backed by a nominal transaction is not opaque if its caller can
 * simply open another connection. The C-phase review found the old test only
 * checked a boolean in one object and never exercised SQLite exclusion.
 */
test("the opaque coordinator capability cannot reach a second connection", () => {
  expect(readCodexTransitionState().kind).toBe("ready");
  const controller = beginCodexCoordinatorTransaction(coordinatorPath);
  try {
    expect(() => {
      const second = beginCodexCoordinatorTransaction(coordinatorPath);
      second.close();
    }).toThrow();
  } finally {
    controller.close();
  }
});

/**
 * SQLite exclusion is only half of "opaque". The other half is that the
 * capability object itself must not hand its caller a usable handle on the open
 * connection: a caller who can reach the `Database` can write the native pair
 * behind the CAS, on the very transaction that is supposed to serialize it.
 * The previous test passed while the connection was reachable.
 */
test("the opaque capability never exposes a reachable database handle", () => {
  expect(readCodexTransitionState().kind).toBe("ready");
  const controller = beginCodexCoordinatorTransaction(coordinatorPath);
  try {
    const ownKeys = Reflect.ownKeys(controller.capability);
    const stringKeys = ownKeys.filter((key): key is string => typeof key === "string");
    const symbolKeys = ownKeys.filter((key): key is symbol => typeof key === "symbol");

    expect(stringKeys).toEqual(["beginTransition"]);
    expect(symbolKeys).toHaveLength(1);
    expect(symbolKeys[0]?.description).toBe("CodexCoordinatorTransaction");

    for (const key of ownKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(controller.capability, key);
      expect(descriptor).toBeDefined();
      expect("get" in descriptor!).toBe(false);
      expect("set" in descriptor!).toBe(false);
    }
    expect(Reflect.getOwnPropertyDescriptor(controller.capability, "beginTransition")).toEqual({
      value: expect.any(Function),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Reflect.getOwnPropertyDescriptor(controller.capability, symbolKeys[0]!)).toEqual({
      value: true,
      writable: true,
      enumerable: true,
      configurable: true,
    });

    let prototype: object | null = controller.capability;
    while (prototype !== null) {
      for (const key of Reflect.ownKeys(prototype)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key)!;
        const intrinsicProtoAccessor = prototype === Object.prototype && key === "__proto__";
        if (!intrinsicProtoAccessor) {
          expect(descriptor.get, `getter ${String(key)} on capability prototype chain`).toBeUndefined();
          expect(descriptor.set, `setter ${String(key)} on capability prototype chain`).toBeUndefined();
        }
      }
      prototype = Reflect.getPrototypeOf(prototype);
    }

    const reachable = new Set<unknown>();
    const walk = (value: unknown, depth: number): void => {
      if (depth > 4 || value === null || reachable.has(value)) return;
      const kind = typeof value;
      if (kind !== "object" && kind !== "function") return;
      reachable.add(value);
      for (const key of Reflect.ownKeys(value as object)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value as object, key);
        if (descriptor && "value" in descriptor) walk(descriptor.value, depth + 1);
      }
      walk(Reflect.getPrototypeOf(value as object), depth + 1);
    };
    walk(controller.capability, 0);

    for (const value of reachable) {
      expect(value).not.toBeInstanceOf(Database);
    }
  } finally {
    controller.close();
  }
});

test("the opaque coordinator capability is one-shot", () => {
  const controller = beginCodexCoordinatorTransaction(coordinatorPath);
  try {
    const expectation = controller.expectation();
    const expected = { nativeGeneration: expectation.nativeBefore, currentTxId: null };
    const next = transition(expectation.txId);
    expect(controller.capability.beginTransition(expected, next).kind).toBe("updated");
    expect(() => controller.capability.beginTransition(expected, next))
      .toThrow("already been consumed");
    controller.assertPublished(expectation);
    controller.commit();
  } finally {
    controller.close();
  }
});

/**
 * Reviewer finding: the happy-path update test still passed with the
 * conditional WHERE removed, so it did not prove the update is conditional.
 * This one fails the moment the guard stops matching on BOTH columns.
 */
test("a begin whose txId matches but whose generation does not is rejected", () => {
  beginCodexTransition({ nativeGeneration: 0, currentTxId: null }, transition("tx-one"));

  const wrongGeneration = beginCodexTransition(
    { nativeGeneration: 7, currentTxId: "tx-one" },
    transition("tx-two"),
  );
  expect(wrongGeneration.kind).toBe("conflict");

  const after = readCodexTransitionState();
  expect(after.kind).toBe("ready");
  if (after.kind === "ready") expect(after.state.currentTxId).toBe("tx-one");
});

/**
 * A permissive coordinator is never LEFT permissive.
 *
 * The flake fix relaxed WHEN mode is judged, not whether. Two processes reaching
 * first use together both see ENOENT, and the loser can lstat the winner's file
 * before its chmod lands; refusing there reported `unsafe-path` for what was only
 * a schedule (1-in-12 on a 16-core box). Ownership is still decided before the
 * open — a file owned by somebody else is not a race and waiting cannot make it
 * ours — while mode is narrowed once below the open and judged on the settled
 * state.
 *
 * This asserts the outcome that matters and can actually be observed: after a
 * read, the file is owner-only again. Removing the narrowing leaves it 0644 and
 * turns this red.
 */
test("a coordinator found group-readable is narrowed back to owner-only", () => {
  expect(readCodexTransitionState().kind).toBe("ready");

  chmodSync(coordinatorPath, 0o644);
  expect(statSync(coordinatorPath).mode & 0o777).toBe(0o644);

  const read = readCodexTransitionState();
  expect(read.kind).toBe("ready");
  expect(statSync(coordinatorPath).mode & 0o777).toBe(0o600);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchRequest, type DispatchEvent } from "../src/usage/dispatch";
import { appendDispatchEvent, dispatchLogPath, readDispatchJournal, dispatchJournalHealth } from "../src/usage/dispatch-log";
let dir: string; let previous: string | undefined;
beforeEach(() => { previous = process.env.CODEXCOMMANDER_HOME; dir = mkdtempSync(join(tmpdir(), "ccx-dispatch-")); process.env.CODEXCOMMANDER_HOME = dir; });
afterEach(() => { if (previous === undefined) delete process.env.CODEXCOMMANDER_HOME; else process.env.CODEXCOMMANDER_HOME = previous; rmSync(dir, { recursive: true, force: true }); });
test("journal separates usage and persists bounded allowlisted observations with permissions", () => {
  const send = createDispatchRequest().attempt().start({ transport: "http", reason: "initial", accountRef: "raw@example.test", model: "secret-model", headers: { authorization: "secret" } } as never);
  send.usage({ provenance: "provider", completeness: "partial", inputTokens: Infinity } as never);
  send.terminal("protocol_success");
  const raw = readFileSync(dispatchLogPath(), "utf8");
  expect(raw).not.toContain("secret"); expect(raw).not.toContain("raw@"); expect(raw).not.toContain("null");
  expect(dispatchLogPath()).toBe(join(dir, "dispatch.jsonl"));
  if (process.platform !== "win32") expect(statSync(dispatchLogPath()).mode & 0o777).toBe(0o600);
  expect(readDispatchJournal().sends[0]?.outcome).toBe("protocol_success");
});
test("truncated rows, unknown versions and missing terminals reduce coverage", () => {
  createDispatchRequest().attempt().start();
  appendFileSync(dispatchLogPath(), '{"schemaVersion":99}\n{"schemaVersion":');
  const journal = readDispatchJournal();
  expect(journal.sends[0]?.outcome).toBe("unknown"); expect(journal.complete).toBe(false); expect(journal.invalidRows).toBe(2);
});
test("append failures are swallowed and visible", () => {
  mkdirSync(dispatchLogPath());
  const before = dispatchJournalHealth().appendFailures;
  expect(() => createDispatchRequest().attempt().start()).not.toThrow();
  expect(dispatchJournalHealth().appendFailures).toBe(before + 3);
  expect(readDispatchJournal().complete).toBe(false);
});
test("invalid events and oversized arbitrary strings cannot be serialized", () => {
  const events: DispatchEvent[] = [];
  createDispatchRequest(e => { events.push(e); }).attempt().start();
  const before = dispatchJournalHealth().invalidEvents;
  appendDispatchEvent({ ...events[0], timestamp: NaN } as DispatchEvent);
  appendDispatchEvent({ ...events[0], requestRef: "s".repeat(10000) } as DispatchEvent);
  expect(dispatchJournalHealth().invalidEvents).toBe(before + 2);
});

test("journal follows usage ownership registration and uninstall clearing", async () => {
  const { CONFIG_UNINSTALL_MANIFEST, removeOwnedConfigState } = await import("../src/lib/config-ownership");
  createDispatchRequest().attempt().start();
  const manifest = JSON.parse(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"));
  expect(manifest.paths).toContain("dispatch.jsonl"); expect(manifest.paths).toContain("usage.jsonl");
  const removed = removeOwnedConfigState(dir);
  expect(removed.status).toBe("removed");
});

test("bounded tail truncation cannot imply complete accounting", () => {
  appendFileSync(dispatchLogPath(), " ".repeat(16 * 1024 * 1024) + "\n");
  const send = createDispatchRequest().attempt().start(); send.terminal("protocol_success");
  const journal = readDispatchJournal();
  expect(journal.truncated).toBe(true); expect(journal.complete).toBe(false);
  expect(journal.sends).toHaveLength(1);
});

test("different process epochs cannot collide with local request refs", () => {
  const child = Bun.spawnSync([process.execPath, "-e", 'import { createDispatchRequest } from "./src/usage/dispatch"; const r = createDispatchRequest(() => {}); console.log(JSON.stringify({ processRef: r.processRef, requestRef: r.requestRef }));'], { cwd: process.cwd(), env: { ...process.env, CODEXCOMMANDER_HOME: dir } });
  expect(child.exitCode).toBe(0);
  const other = JSON.parse(child.stdout.toString());
  const local = createDispatchRequest(() => {});
  expect(other.processRef).not.toBe(local.processRef); expect(other.requestRef).not.toBe(local.requestRef);
});

test("missing journal is unavailable evidence, distinct from persisted zero-send request", () => {
  const missing = readDispatchJournal();
  expect(missing.sourcePresent).toBe(false); expect(missing.complete).toBe(false);
  createDispatchRequest();
  const present = readDispatchJournal();
  expect(present.sourcePresent).toBe(true); expect(present.requests).toHaveLength(1); expect(present.sends).toHaveLength(0);
  expect(present.degradationScope).toBe("current_process");
});

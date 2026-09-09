import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tokens from "../src/codex/auth-collision";
import * as startup from "../src/codex/native-profile-startup";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import { clearNativeOwnershipMemoryForTests } from "../src/codex/native-ownership";
import { clearCodexUpstreamHealth, clearThreadAccountMap, clearThreadAccountMapMemoryForTests, previewCodexAccountForRequest, resolveCodexAccountForThreadDetailed, CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS } from "../src/codex/routing";
import type { CodexCommanderConfig } from "../src/types";

let home: string;
let previousHome: string | undefined;
let previousCommanderHome: string | undefined;
let reader: ReturnType<typeof spyOn>;
let gate: ReturnType<typeof spyOn>;
let config: CodexCommanderConfig;
const selectionOnly = { nativeMainSelectionOnly: true };

beforeEach(() => {
  previousHome = process.env.CODEX_HOME;
  previousCommanderHome = process.env.CODEXCOMMANDER_HOME;
  home = mkdtempSync(join(tmpdir(), "ccx-affinity-fence-"));
  process.env.CODEX_HOME = home;
  process.env.CODEXCOMMANDER_HOME = home;
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-access", account_id: "fixture-main" } }));
  clearNativeOwnershipMemoryForTests();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  gate = spyOn(startup, "isNativeMainTrafficBlocked").mockReturnValue(false);
  // Observe the production reader used by both liveness and identity checks.
  reader = spyOn(tokens, "readCodexTokens");
  config = {
    port: 10100, defaultProvider: "openai", codexAccounts: [],
    activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
    activeCodexAccountPinned: MAIN_CODEX_ACCOUNT_ID,
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" } },
  } as CodexCommanderConfig;
});
afterEach(() => {
  reader.mockRestore(); gate.mockRestore();
  clearThreadAccountMapMemoryForTests(); clearNativeOwnershipMemoryForTests(); clearCodexUpstreamHealth();
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  if (previousCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME; else process.env.CODEXCOMMANDER_HOME = previousCommanderHome;
  rmSync(home, { recursive: true, force: true });
});

function bind(now = Date.now()) {
  expect(resolveCodexAccountForThreadDetailed("task", config, now)).toEqual({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
  expect(reader.mock.calls.length).toBeGreaterThan(0);
  reader.mockClear();
  return now;
}

test("resident main affinity and periodic touch stay read-free during selection-only drain", () => {
  const now = bind();
  writeFileSync(join(home, "auth.json"), "replacement-in-progress");
  expect(previewCodexAccountForRequest("task", config, now + 1, undefined, selectionOnly)).toBe(MAIN_CODEX_ACCOUNT_ID);
  expect(resolveCodexAccountForThreadDetailed("task", config, now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1, undefined, selectionOnly)).toEqual({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
  expect(reader).not.toHaveBeenCalled();
  expect(config.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
});

test("restoration and new binding do not read main during selection-only drain", () => {
  const now = bind();
  clearThreadAccountMapMemoryForTests();
  for (const task of ["task", "new-task"]) {
    expect(resolveCodexAccountForThreadDetailed(task, config, now + 1, undefined, selectionOnly)).toEqual({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
  }
  expect(reader).not.toHaveBeenCalled();
  expect(config.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
});

test("retained startup recovery excludes resident and restored main before reading identity", () => {
  const now = bind();
  gate.mockReturnValue(true);
  expect(resolveCodexAccountForThreadDetailed("task", config, now + 1)).toEqual({ status: "none" });
  expect(reader).not.toHaveBeenCalled();
  expect(config.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  gate.mockReturnValue(false);
  bind(now + 2);
  clearThreadAccountMapMemoryForTests();
  gate.mockReturnValue(true);
  expect(resolveCodexAccountForThreadDetailed("task", config, now + 3)).toEqual({ status: "none" });
  expect(reader).not.toHaveBeenCalled();
  expect(config.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
});

test("normal main continuation survives memory loss and validates the actual credential", () => {
  const now = bind();
  clearThreadAccountMapMemoryForTests();
  expect(resolveCodexAccountForThreadDetailed("task", config, now + 1)).toEqual({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
  expect(reader.mock.calls.length).toBeGreaterThan(0);
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { STORE_BUDGET_MS } from "./helpers/test-budget";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEntry,
  currentUsageLogRevision,
  normalizeUsageEntryForTest,
  readRecentUsageEntries,
  readUsageEntries,
  readUsageEntriesForManagement,
  readUsageSnapshotForManagement,
  resetUsageReadCacheForTests,
  usageForFinalLog,
  usageLogPath,
  usageStatusForFinalLog,
  usageTotalTokens,
  usageReadCacheStatsForTests,
  usageLogRevisionKey,
  USAGE_LOG_SCHEMA_VERSION,
  type PersistedUsageEntry,
} from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.CODEXCOMMANDER_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ccx-usage-"));
  process.env.CODEXCOMMANDER_HOME = testDir;
  resetUsageReadCacheForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("usage log", () => {
  test("persists the rate-limit-429 recovery kind on attempts", () => {
    const entry: PersistedUsageEntry = {
      requestId: "ccx-ratelimit-kind",
      timestamp: 1,
      provider: "blsc",
      model: "blsc/DeepSeek-V4-Flash",
      status: 429,
      durationMs: 4,
      usageStatus: "reported",
      attempts: [{
        ordinal: 1,
        provider: "blsc",
        model: "blsc/DeepSeek-V4-Flash",
        adapter: "openai-chat",
        status: 429,
        durationMs: 4,
        sendCount: 2,
        recoveryKinds: ["rate-limit-429", "rate-limit-429"],
        usageStatus: "reported",
      }],
    };
    appendUsageEntry(entry);
    expect(readUsageEntries()[0]?.attempts?.[0]?.recoveryKinds).toEqual(["rate-limit-429"]);
  });

  /** Build one minimal persisted-usage JSONL line for the given request id. */
  const persistedLine = (requestId: string) => JSON.stringify({
    schemaVersion: USAGE_LOG_SCHEMA_VERSION,
    requestId,
    timestamp: 1,
    provider: "openai",
    model: "gpt-5.5",
    surface: "codex",
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    usage: { inputTokens: 1, outputTokens: 1 },
    totalTokens: 2,
  });

  test("file revisions change after append and in-place rewrite", () => {
    writeFileSync(usageLogPath(), `${persistedLine("a")}\n${persistedLine("b")}\n`);
    const first = usageLogRevisionKey(currentUsageLogRevision());
    writeFileSync(usageLogPath(), `${persistedLine("new")}\n`);
    expect(usageLogRevisionKey(currentUsageLogRevision())).not.toBe(first);
    expect(readUsageEntries().map(entry => entry.requestId)).toEqual(["new"]);
  });

  test("management full reads yield while parsing a large existing log", async () => {
    writeFileSync(
      usageLogPath(),
      `${Array.from({ length: 2_100 }, (_, index) => persistedLine(`row-${index}`)).join("\n")}\n`,
    );
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 0);
    const entries = await readUsageEntriesForManagement();
    expect(entries).toHaveLength(2_100);
    expect(timerRan).toBe(true);
    expect(usageReadCacheStatsForTests()).toEqual({ fullReads: 1, tailReads: 0, parsedLines: 2_100 });
  });

  test("usage reader never requests more than 64 MiB from an oversized log", async () => {
    const path = usageLogPath();
    const fd = openSync(path, "w");
    try {
      truncateSync(fd, 64 * 1024 * 1024 + 1024);
      const tail = Buffer.from(`${persistedLine("tail")}\n`);
      const tailPosition = 64 * 1024 * 1024 + 1024 - tail.byteLength;
      writeSync(fd, Buffer.from("\n"), 0, 1, tailPosition - 1);
      writeSync(fd, tail, 0, tail.byteLength, tailPosition);
    } finally {
      closeSync(fd);
    }
    const snapshot = await readUsageSnapshotForManagement();
    expect(snapshot.truncatedPrefixBytes).toBeGreaterThan(0);
    expect(snapshot.entries.map(entry => entry.requestId)).toEqual(["tail"]);
  }, STORE_BUDGET_MS); // sparse >64 MiB fixture IO is intrinsic; Windows self-hosted measured 7.193s against Bun's 5s default.

  test("usage tail exact row boundary keeps the complete newest row", async () => {
    const newest = Buffer.from(`${persistedLine("newest")}\n`);
    writeFileSync(usageLogPath(), `${persistedLine("older")}\n${newest.toString("utf-8")}`);

    const snapshot = await readUsageSnapshotForManagement(newest.byteLength);

    expect(snapshot.entries.map(entry => entry.requestId)).toEqual(["newest"]);
  });

  test("usage byte-prefix truncation and entry-count truncation report independent metadata", async () => {
    writeFileSync(
      usageLogPath(),
      `${Array.from({ length: 500_001 }, (_, index) => persistedLine(String(index))).join("\n")}\n`,
    );
    const snapshot = await readUsageSnapshotForManagement(128 * 1024 * 1024);
    expect(snapshot.entries).toHaveLength(500_000);
    expect(snapshot.entries[0]?.requestId).toBe("1");
    expect(snapshot.entries.at(-1)?.requestId).toBe("500000");
    expect(snapshot.truncatedPrefixBytes).toBe(0);
    expect(snapshot.entriesTruncated).toBe(true);
    expect(snapshot.entriesDropped).toBe(1);
  }, STORE_BUDGET_MS); // parsing 500,001 rows IS the entry-cap assertion; the 200k-row variant measured ~5.05s on windows-latest against Bun's 5s default.

  test("stale usage-read flight is replaced and old completion cannot clear new owner", async () => {
    writeFileSync(
      usageLogPath(),
      `${Array.from({ length: 5_000 }, (_, index) => persistedLine(`stale-${index}`)).join("\n")}\n`,
    );
    const first = readUsageSnapshotForManagement();
    await Promise.resolve();
    const originalNow = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(originalNow + 30_001);
    try {
      const replacement = readUsageSnapshotForManagement();
      const joiner = readUsageSnapshotForManagement();
      await expect(first).rejects.toThrow("management usage read superseded");
      const [second, third] = await Promise.all([replacement, joiner]);
      expect(third.entries).toEqual(second.entries);
      expect(usageReadCacheStatsForTests().fullReads).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("a replacement does not join an in-flight read for the previous file revision", async () => {
    writeFileSync(
      usageLogPath(),
      `${Array.from({ length: 2_100 }, (_, index) => persistedLine(`old-${index}`)).join("\n")}\n`,
    );
    const oldRead = readUsageSnapshotForManagement();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    writeFileSync(usageLogPath(), `${persistedLine("replacement")}\n`);
    const newRead = readUsageSnapshotForManagement();
    await expect(oldRead).rejects.toThrow("management usage read superseded");
    const newSnapshot = await newRead;
    expect(newSnapshot.entries.map(entry => entry.requestId)).toEqual(["replacement"]);
  });

  test("persists conversationId for Logs session correlation", () => {
    appendUsageEntry({
      requestId: "ccx-conversation",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      conversationId: "thread-abc",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    });
    expect(readUsageEntries()).toEqual([expect.objectContaining({
      requestId: "ccx-conversation",
      conversationId: "thread-abc",
    })]);
  });

  test("persists an absolute context checkpoint for stateful providers", () => {
    // Kiro reports per-attempt usage only, so contextTotalTokens is the sole carrier of the
    // cumulative context figure once the log stores raw adapter usage (usageFromBridge).
    // Dropping it here erased Kiro context growth from every persisted row.
    appendUsageEntry({
      requestId: "ccx-context-checkpoint",
      timestamp: 1,
      provider: "kiro",
      model: "claude-opus-5",
      status: 200,
      durationMs: 10,
      usageStatus: "estimated",
      usage: { inputTokens: 220, outputTokens: 252, contextTotalTokens: 127_000, estimated: true },
      totalTokens: 472,
    });
    expect(readUsageEntries()).toEqual([expect.objectContaining({
      requestId: "ccx-context-checkpoint",
      usage: expect.objectContaining({
        inputTokens: 220,
        outputTokens: 252,
        contextTotalTokens: 127_000,
        estimated: true,
      }),
      // The checkpoint must NOT be folded into the per-request total.
      totalTokens: 472,
    })]);
  });

  test("never invents a context checkpoint when the adapter reported none", () => {
    appendUsageEntry({
      requestId: "ccx-no-checkpoint",
      timestamp: 1,
      provider: "kiro",
      model: "claude-opus-5",
      status: 200,
      durationMs: 10,
      usageStatus: "estimated",
      usage: { inputTokens: 61, outputTokens: 48, estimated: true },
      totalTokens: 109,
    });
    const [entry] = readUsageEntries();
    expect(entry?.usage).toBeDefined();
    expect(entry?.usage && "contextTotalTokens" in entry.usage).toBe(false);
  });

  test("persists only canonical ordered attempt fields", () => {
    appendUsageEntry({
      requestId: "ccx-attempts",
      timestamp: 1,
      provider: "combo",
      model: "combo/free",
      requestedModel: "combo/free",
      resolvedModel: "m2",
      status: 200,
      durationMs: 20,
      usageStatus: "estimated",
      usage: { inputTokens: 15, outputTokens: 2, estimated: true },
      totalTokens: 17,
      attempts: [{
        ordinal: 1,
        provider: "a",
        model: "m1",
        adapter: "openai-chat",
        status: 503,
        durationMs: 4,
        sendCount: 2,
        recoveryKinds: ["transient-5xx", "transient-5xx", "oauth-401"],
        usageStatus: "estimated",
        inputTokenEstimate: 5,
        usage: { inputTokens: 5, outputTokens: 0, estimated: true },
        totalTokens: 5,
        requestedEffort: "max",
        effectiveEffort: "high",
        reasoningWireField: "reasoning_effort",
        reasoningWireValue: "high",
        headers: { authorization: "Bearer attempt-token" },
        body: "attempt body secret",
        messages: ["attempt message secret"],
        accessToken: "attempt-access",
        refreshToken: "attempt-refresh",
        error: "raw attempt error",
      } as never],
      headers: { authorization: "Bearer parent-token" },
      body: "parent body secret",
      messages: ["parent message secret"],
    } as unknown as Parameters<typeof appendUsageEntry>[0]);

    const raw = readFileSync(usageLogPath(), "utf-8");
    for (const forbidden of [
      "attempt-token", "attempt body secret", "attempt message secret",
      "attempt-access", "attempt-refresh", "raw attempt error",
      "parent-token", "parent body secret", "parent message secret",
      "authorization", "headers", "messages", "refreshToken",
    ]) expect(raw).not.toContain(forbidden);
    expect(readUsageEntries()[0]?.attempts).toEqual([{
      ordinal: 1,
      provider: "a",
      model: "m1",
      adapter: "openai-chat",
      status: 503,
      durationMs: 4,
      sendCount: 2,
      recoveryKinds: ["transient-5xx", "oauth-401"],
      usageStatus: "estimated",
      inputTokenEstimate: 5,
      usage: { inputTokens: 5, outputTokens: 0, estimated: true },
      totalTokens: 5,
      requestedEffort: "max",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
    }]);
  });

  test("omits malformed optional attempt reasoning metadata without dropping the attempt", () => {
    appendUsageEntry({
      requestId: "ccx-attempt-reasoning",
      timestamp: 1,
      provider: "combo",
      model: "combo/free",
      status: 200,
      durationMs: 4,
      usageStatus: "unreported",
      attempts: [{
        ordinal: 1,
        provider: "a",
        model: "m1",
        adapter: "openai-chat",
        status: 200,
        durationMs: 3,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
        requestedEffort: 123,
        effectiveEffort: null,
        reasoningWireField: {},
        reasoningWireValue: -1,
      } as never],
    });

    const attempt = readUsageEntries()[0]?.attempts?.[0];
    expect(attempt?.ordinal).toBe(1);
    expect(attempt).not.toHaveProperty("requestedEffort");
    expect(attempt).not.toHaveProperty("effectiveEffort");
    expect(attempt).not.toHaveProperty("reasoningWireField");
    expect(attempt).not.toHaveProperty("reasoningWireValue");
  });

  test("keeps boolean reasoning values only for reasoning.enabled", () => {
    const base = {
      requestId: "ccx-boolean-reasoning",
      timestamp: 1,
      provider: "combo",
      model: "combo/free",
      status: 200,
      durationMs: 4,
      usageStatus: "unreported",
      attempts: [{
        ordinal: 1,
        provider: "a",
        model: "m1",
        adapter: "openai-chat",
        status: 200,
        durationMs: 3,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
      }],
    } as const;
    const mismatched = normalizeUsageEntryForTest({
      ...base,
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: true,
      attempts: [{
        ...base.attempts[0],
        reasoningWireField: "reasoning_effort",
        reasoningWireValue: true,
      }],
    });
    const valid = normalizeUsageEntryForTest({
      ...base,
      reasoningWireField: "reasoning.enabled",
      reasoningWireValue: false,
      attempts: [{
        ...base.attempts[0],
        reasoningWireField: "reasoning.enabled",
        reasoningWireValue: false,
      }],
    });

    expect(mismatched).not.toHaveProperty("reasoningWireValue");
    expect(mismatched.attempts?.[0]).not.toHaveProperty("reasoningWireValue");
    expect(valid.reasoningWireValue).toBe(false);
    expect(valid.attempts?.[0]?.reasoningWireValue).toBe(false);
  });

  test("drops a persisted row with any malformed attempt", () => {
    const valid = (ordinal: number) => ({
      ordinal,
      provider: ordinal === 1 ? "a" : "c",
      model: `m${ordinal}`,
      adapter: "openai-chat",
      status: 200,
      durationMs: 1,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "reported",
      usage: { inputTokens: ordinal, outputTokens: 1 },
      totalTokens: ordinal + 1,
    });
    const malformed: Array<Record<string, unknown>> = [
      { ...valid(2), status: 99 },
      { ...valid(2), status: 600 },
      { ...valid(2), status: 200.5 },
      { ...valid(2), inputTokenEstimate: -1 },
      { ...valid(2), totalTokens: -1 },
      { ...valid(2), firstOutputMs: -1 },
      { ...valid(2), firstOutputMs: null },
      { ...valid(2), firstOutputMs: "3" },
      { ...valid(2), usage: { inputTokens: "2", outputTokens: 1 } },
      { ...valid(2), usage: { inputTokens: 2, outputTokens: "1" } },
    ];
    for (const middle of malformed) {
      writeFileSync(usageLogPath(), `${JSON.stringify({
        schemaVersion: USAGE_LOG_SCHEMA_VERSION,
        requestId: "parent",
        timestamp: 1,
        provider: "combo",
        model: "combo/free",
        surface: "codex",
        status: 200,
        durationMs: 3,
        usageStatus: "reported",
        usage: { inputTokens: 4, outputTokens: 2 },
        totalTokens: 6,
        attempts: [valid(1), middle, valid(3)],
      })}\n`);
      expect(readUsageEntries()).toEqual([]);
    }
  });

  test("persists parent and attempt firstOutputMs roundtrip (WP4 TTFT)", () => {
    appendUsageEntry({
      requestId: "ccx-ttft",
      timestamp: 1,
      provider: "a",
      model: "m1",
      status: 200,
      durationMs: 20,
      firstOutputMs: 7,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 5 },
      totalTokens: 15,
      attempts: [{
        ordinal: 1,
        provider: "a",
        model: "m1",
        adapter: "openai-chat",
        status: 200,
        durationMs: 18,
        firstOutputMs: 3,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "reported",
        usage: { inputTokens: 10, outputTokens: 5 },
        totalTokens: 15,
      }],
    });
    const [entry] = readUsageEntries();
    expect(entry?.firstOutputMs).toBe(7);
    expect(entry?.attempts?.[0]?.firstOutputMs).toBe(3);
  });

  test("omits malformed parent firstOutputMs without dropping the entry (direct input)", () => {
    // JSON.stringify turns Infinity/NaN into null, so exercise appendUsageEntry directly
    // (audit blocker #3): the normalizer must omit non-finite values at write time.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      rmSync(usageLogPath(), { force: true });
      appendUsageEntry({
        requestId: "ccx-ttft-bad",
        timestamp: 1,
        provider: "a",
        model: "m1",
        status: 200,
        durationMs: 20,
        firstOutputMs: bad,
        usageStatus: "reported",
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      const [entry] = readUsageEntries();
      expect(entry?.requestId).toBe("ccx-ttft-bad");
      expect(entry).not.toHaveProperty("firstOutputMs");
    }
  });

  test("drops rows from an unversioned usage schema", () => {
    writeFileSync(usageLogPath(), `${JSON.stringify({
      requestId: "unversioned",
      timestamp: 1,
      provider: "a",
      model: "m1",
      status: 200,
      durationMs: 5,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
    })}\n`);
    expect(readUsageEntries()).toEqual([]);
  });

  test("drops malformed or unversioned persisted rows", () => {
    writeFileSync(usageLogPath(), [
      JSON.stringify({
        schemaVersion: USAGE_LOG_SCHEMA_VERSION,
        requestId: "bad-attempt-array",
        timestamp: 1,
        provider: "combo",
        model: "combo/free",
        surface: "codex",
        status: 200,
        durationMs: 1,
        usageStatus: "unreported",
        attempts: { ordinal: 1 },
      }),
      JSON.stringify({
        requestId: "unversioned",
        timestamp: 2,
        provider: "openai",
        model: "gpt-5.5",
        status: 200,
        durationMs: 1,
        usageStatus: "reported",
        usage: { inputTokens: 1, outputTokens: 2 },
        totalTokens: 3,
      }),
    ].join("\n"));
    expect(readUsageEntries()).toEqual([]);
  });

  test("uses CODEXCOMMANDER_HOME for the append-only JSONL path", () => {
    expect(usageLogPath()).toBe(join(testDir, "usage.jsonl"));
  });

  test("appends secret-safe usage entries and reads them back", () => {
    appendUsageEntry({
      requestId: "ccx-1",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.5",
      surface: "claude",
      requestedModel: "openai-apikey/gpt-5.5",
      resolvedModel: "gpt-5.5",
      status: 200,
      durationMs: 42,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 2 },
      totalTokens: 13,
    });

    expect(existsSync(usageLogPath())).toBe(true);
    const raw = readFileSync(usageLogPath(), "utf-8");
    expect(raw).toContain("\"requestId\":\"ccx-1\"");
    expect(raw).not.toContain("prompt");
    expect(raw).not.toContain("authorization");
    expect(readUsageEntries()).toEqual([{
      requestId: "ccx-1",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.5",
      surface: "claude",
      requestedModel: "openai-apikey/gpt-5.5",
      resolvedModel: "gpt-5.5",
      status: 200,
      durationMs: 42,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 2 },
      totalTokens: 13,
    }]);
    if (process.platform !== "win32") {
      expect((statSync(usageLogPath()).mode & 0o777).toString(8)).toBe("600");
    }
  });

  test("drops runtime extra fields before persisting usage JSONL", () => {
    appendUsageEntry({
      requestId: "ccx-extra",
      timestamp: 2,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 12,
      usageStatus: "reported",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        estimated: true,
        prompt: "secret prompt text",
      },
      totalTokens: 3,
      prompt: "secret prompt text",
      messages: [{ role: "user", content: "secret message" }],
      headers: { authorization: "Bearer usage-log-token" },
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
      surface: "codex",
    } as unknown as Parameters<typeof appendUsageEntry>[0]);

    const raw = readFileSync(usageLogPath(), "utf-8");
    for (const leaked of [
      "secret prompt text",
      "secret message",
      "usage-log-token",
      "access-secret",
      "refresh-secret",
      "arn:aws:codewhisperer",
      "headers",
      "messages",
      "profileArn",
    ]) {
      expect(raw).not.toContain(leaked);
    }
    expect(readUsageEntries()).toEqual([{
      requestId: "ccx-extra",
      timestamp: 2,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 12,
      usageStatus: "reported",
      surface: "codex",
      usage: { inputTokens: 1, outputTokens: 2, estimated: true },
      totalTokens: 3,
    }]);
  });

  test("skips malformed JSONL lines while keeping valid entries", () => {
    writeFileSync(usageLogPath(), [
      "{\"schemaVersion\":1,\"requestId\":\"a\",\"timestamp\":1,\"provider\":\"p\",\"model\":\"m\",\"surface\":\"codex\",\"status\":200,\"durationMs\":1,\"usageStatus\":\"unreported\"}",
      "{not-json",
      "{\"schemaVersion\":1,\"requestId\":\"b\",\"timestamp\":2,\"provider\":\"p\",\"model\":\"m\",\"surface\":\"codex\",\"status\":200,\"durationMs\":1,\"usageStatus\":\"reported\",\"usage\":{\"inputTokens\":1,\"outputTokens\":2},\"totalTokens\":3}",
    ].join("\n"));

    expect(readUsageEntries().map(entry => entry.requestId)).toEqual(["a", "b"]);
  });

  test("keeps missing usage distinct from zero usage", () => {
    expect(usageStatusForFinalLog(undefined)).toBe("unreported");
    expect(usageStatusForFinalLog({ inputTokens: 0, outputTokens: 0 })).toBe("reported");
    expect(usageStatusForFinalLog({ inputTokens: 0, outputTokens: 0, estimated: true })).toBe("estimated");
    expect(usageTotalTokens(undefined)).toBeUndefined();
    expect(usageTotalTokens({ inputTokens: 4, outputTokens: 6, cachedInputTokens: 2 })).toBe(10);
    // inputTokens is inclusive of cache detail — the total never re-adds it
    expect(usageTotalTokens({ inputTokens: 4, outputTokens: 6, cachedInputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 })).toBe(10);
    expect(usageTotalTokens({ inputTokens: 4, outputTokens: 6, totalTokens: 50_000 })).toBe(10);
  });

  test("marks Kiro final log usage as estimated without changing other providers", () => {
    const usage = { inputTokens: 4, outputTokens: 6 };
    expect(usageForFinalLog("kiro", usage)).toEqual({ ...usage, estimated: true });
    expect(usageForFinalLog("kiro-p9d8524", usage)).toEqual({ ...usage, estimated: true });
    // cursor: adapter name AND configured-provider-name prefixes both count (implementation contract B2 —
    // "cursor-pb51d9b" rows previously logged as accurately "reported").
    expect(usageForFinalLog("cursor", usage)).toEqual({ ...usage, estimated: true });
    expect(usageForFinalLog("cursor-pb51d9b", usage)).toEqual({ ...usage, estimated: true });
    expect(usageForFinalLog("openai", usage)).toEqual(usage);
    expect(usageForFinalLog("openai", { ...usage, estimated: true })).toEqual({ ...usage, estimated: true });
    expect(usageForFinalLog("openai", { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 4,
    });
  });

  test("preserves cached token counts alongside estimated status", () => {
    appendUsageEntry({
      requestId: "ccx-cache",
      timestamp: 3,
      provider: "kiro",
      model: "claude-opus-4.8",
      status: 200,
      durationMs: 21,
      usageStatus: "estimated",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 60,
        cacheCreationInputTokens: 20,
        estimated: true,
      },
      totalTokens: 110,
    });

    expect(readUsageEntries()[0]).toEqual({
      requestId: "ccx-cache",
      timestamp: 3,
      provider: "kiro",
      model: "claude-opus-4.8",
      surface: "codex",
      status: 200,
      durationMs: 21,
      usageStatus: "estimated",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 60,
        cacheCreationInputTokens: 20,
        estimated: true,
      },
      totalTokens: 110,
    });
  });

  test("persists and reads back effort / service-tier GUI metadata", () => {
    appendUsageEntry({
      requestId: "ccx-effort",
      timestamp: 9,
      provider: "openai",
      model: "gpt-5.6-sol",
      requestedModel: "gpt-5.6-sol",
      requestedEffort: "xhigh",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
      requestedServiceTier: "priority",
      requestedSpeedLabel: "fast",
      configuredServiceTier: "auto",
      modelSupportsServiceTier: true,
      responseServiceTier: "priority",
      status: 200,
      durationMs: 5,
      usageStatus: "unreported",
    });
    expect(readUsageEntries()[0]).toMatchObject({
      requestId: "ccx-effort",
      requestedEffort: "xhigh",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
      requestedServiceTier: "priority",
      requestedSpeedLabel: "fast",
      configuredServiceTier: "auto",
      modelSupportsServiceTier: true,
      responseServiceTier: "priority",
    });
  });

  test("readRecentUsageEntries returns only the newest N rows", () => {
    for (let i = 0; i < 12; i++) {
      appendUsageEntry({
        requestId: `ccx-tail-${i}`,
        timestamp: i,
        provider: "openai",
        model: "gpt",
        status: 200,
        durationMs: 1,
        usageStatus: "unreported",
      });
    }
    expect(readRecentUsageEntries(5).map(e => e.requestId)).toEqual([
      "ccx-tail-7",
      "ccx-tail-8",
      "ccx-tail-9",
      "ccx-tail-10",
      "ccx-tail-11",
    ]);
    expect(readRecentUsageEntries(0)).toEqual([]);
    expect(readRecentUsageEntries(-1)).toEqual([]);
  });
});

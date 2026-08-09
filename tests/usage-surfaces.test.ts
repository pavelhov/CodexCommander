import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUsageSurface, summarizeUsage } from "../src/usage/summary";
import { appendUsageEntry, readUsageEntries } from "../src/usage/log";
import type { PersistedUsageEntry } from "../src/usage/log";

/** Usage-surface taxonomy is explicit in every durable row. */

function entry(surface: PersistedUsageEntry["surface"], model: string): PersistedUsageEntry {
  return {
    requestId: `req-${model}`,
    timestamp: Date.now(),
    provider: "prov",
    model,
    ...(surface ? { surface } : {}),
    status: 200,
    durationMs: 42,
    usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

const ENTRIES: PersistedUsageEntry[] = [
  entry("claude", "via-claude-code"),
  entry("claude-desktop", "via-desktop"),
  entry("grok", "via-grok"),
  entry("codex", "via-codex-cli"),
];

function modelsFor(surface: Parameters<typeof summarizeUsage>[3]): string[] {
  return summarizeUsage(ENTRIES, "all", Date.now(), surface).models.map(m => m.model).sort();
}

test("the four buckets are disjoint", () => {
  expect(modelsFor("claude")).toEqual(["via-claude-code", "via-desktop"]);
  expect(modelsFor("grok")).toEqual(["via-grok"]);
  expect(modelsFor("codex")).toEqual(["via-codex-cli"]);
  expect(modelsFor("all")).toEqual(["via-claude-code", "via-codex-cli", "via-desktop", "via-grok"]);
});

test("parseUsageSurface accepts grok and still rejects unknown values", () => {
  expect(parseUsageSurface("grok")).toBe("grok");
  expect(parseUsageSurface("codex")).toBe("codex");
  expect(parseUsageSurface("claude")).toBe("claude");
  expect(parseUsageSurface("chatgpt")).toBe("all");
  expect(parseUsageSurface(null)).toBe("all");
  expect(parseUsageSurface(undefined)).toBe("all");
});

test("usage surfaces survive the usage-log round trip", async () => {
  const home = mkdtempSync(join(tmpdir(), "ccx-usage-grok-"));
  const prev = process.env.CODEXCOMMANDER_HOME;
  process.env.CODEXCOMMANDER_HOME = home;
  try {
    appendUsageEntry(entry("grok", "ccx-kimi-k3"));
    appendUsageEntry(entry("codex", "plain-codex"));
    const entries = await readUsageEntries();
    const grok = entries.find(e => e.model === "ccx-kimi-k3");
    const plain = entries.find(e => e.model === "plain-codex");
    expect(grok?.surface).toBe("grok");
    expect(plain?.surface).toBe("codex");
  } finally {
    if (prev === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

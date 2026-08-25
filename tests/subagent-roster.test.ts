import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  canonicalSubagentRoster,
  mergeLegacyRosterWrite,
  normalizeSubagentRoster,
  rewriteSubagentRosterModels,
  subagentRosterModels,
} from "../src/codex/subagent-roster";
import { getDefaultConfig, loadConfig, readConfigDiagnostics, validateConfigCandidate } from "../src/config";

test("normalizes strings, objects, and mixed arrays", () => {
  expect(normalizeSubagentRoster(["gpt-5.6-sol", { model: "xai/grok-4.6", guidance: "  Review  " }])).toEqual([
    { model: "gpt-5.6-sol" },
    { model: "xai/grok-4.6", guidance: "Review" },
  ]);
});

test("rejects extra keys, blank models, duplicate models, and unsafe guidance", () => {
  expect(() => normalizeSubagentRoster([{ model: "gpt-5.6-sol", effort: "high" }])).toThrow();
  expect(() => normalizeSubagentRoster([{ model: "gpt-5.6-sol" }, { model: "gpt-5.6-sol" }])).toThrow();
  expect(() => normalizeSubagentRoster([{ model: "xai/grok-4.6", guidance: "Use <secret>" }])).toThrow();
});

test("legacy model writes preserve remaining guidance", () => {
  const current = [
    { model: "xai/grok-4.6", guidance: "Review" },
    { model: "gpt-5.6-luna" },
  ];
  expect(mergeLegacyRosterWrite(current, ["gpt-5.6-luna", "xai/grok-4.6"])).toEqual([
    { model: "gpt-5.6-luna" },
    { model: "xai/grok-4.6", guidance: "Review" },
  ]);
});

test("canonicalizes guidance and rewrites models while keeping first duplicate", () => {
  const entries = normalizeSubagentRoster([
    { model: "xai/old", guidance: "  First  " },
    { model: "gpt-5.6-sol", guidance: "Second" },
  ]);
  expect(rewriteSubagentRosterModels(entries, model => model === "xai/old" ? "xai/new" : "xai/new")).toEqual([
    { model: "xai/new", guidance: "First" },
  ]);
  expect(canonicalSubagentRoster([{ model: "gpt-5.6-sol", guidance: " \u00c9lan  " }])).toEqual([
    { model: "gpt-5.6-sol", guidance: "\u00c9lan" },
  ]);
  expect(subagentRosterModels(entries)).toEqual(["xai/old", "gpt-5.6-sol"]);
});

test("rewrite rejects an oversized roster before deduplication", () => {
  const entries = Array.from({ length: 6 }, (_, index) => ({ model: `gpt-${index}` }));
  expect(() => rewriteSubagentRosterModels(entries, () => "xai/same")).toThrow();
});

test("config validation reports helper errors as schema failures without throwing", () => {
  const base = getDefaultConfig();
  expect(() => validateConfigCandidate({
    ...base,
    subagentModels: [{ model: "gpt-5.6-sol", guidance: "Use <secret>" }],
  })).not.toThrow();
  expect(validateConfigCandidate({
    ...base,
    subagentModels: [{ model: "gpt-5.6-sol", guidance: "Use <secret>" }],
  })).toMatchObject({ ok: false });
  expect(validateConfigCandidate({
    ...base,
    subagentModels: [{ model: "gpt-5.6-sol", extra: true }],
  })).toMatchObject({ ok: false });
});

test("invalid roster diagnostics report schema errors rather than invalid_json", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccx-roster-invalid-"));
  const previousHome = process.env.CODEXCOMMANDER_HOME;
  process.env.CODEXCOMMANDER_HOME = dir;
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    ...getDefaultConfig(),
    subagentModels: [{ model: "gpt-5.6-sol", guidance: "Use <secret>" }],
  }));
  try {
    expect(readConfigDiagnostics().error).toMatch(/^schema_invalid:/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loads a legacy string roster without rewriting the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccx-roster-"));
  const previousHome = process.env.CODEXCOMMANDER_HOME;
  process.env.CODEXCOMMANDER_HOME = dir;
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    port: 10100,
    defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    subagentModels: ["gpt-5.6-sol", "gpt-5.6-luna"],
    multiAgentGuidanceEnabled: true,
  }));
  const before = readFileSync(configPath, "utf8");
  try {
    const config = loadConfig();
    expect(subagentRosterModels(config.subagentModels)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  } finally {
    if (previousHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
    else process.env.CODEXCOMMANDER_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

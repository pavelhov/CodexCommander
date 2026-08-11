import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  codexBootConfigHash,
  codexBootFenceMarkerPath,
  observeCodexBootFence,
} from "../src/codex/boot-fence";

let home = "";
let previous: string | undefined;
const configPath = () => join(home, "config.toml");
const marker = () => JSON.parse(readFileSync(codexBootFenceMarkerPath(), "utf8"));

beforeEach(() => {
  previous = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ccx-boot-fence-"));
  process.env.CODEX_HOME = home;
  writeFileSync(configPath(), 'openai_base_url = "http://one/v1"\n[agents]\nenabled = true\n');
});

afterEach(() => {
  if (previous === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

describe("Codex boot fence", () => {
  test("seeds a missing marker from the raw config mtime", () => {
    utimesSync(configPath(), 100, 100);
    expect(observeCodexBootFence().mtimeMs).toBe(100_000);
    expect(marker()).toMatchObject({ schemaVersion: 1, bootHash: codexBootConfigHash(), changedAtMs: 100_000 });
  });

  test("ignores desktop-owned content and formatting churn", () => {
    const initial = observeCodexBootFence().mtimeMs;
    writeFileSync(configPath(), 'openai_base_url="http://one/v1"\n\n[agents]\nenabled=true\n[marketplaces.x]\nlast_updated = 999\n');
    utimesSync(configPath(), 300, 300);
    expect(observeCodexBootFence().mtimeMs).toBe(initial);
  });

  test("advances for each supported boot-key family", () => {
    observeCodexBootFence();
    for (const content of [
      'openai_base_url = "http://two/v1"\n',
      '[agents]\nenabled = false\nmax_depth = 3\n',
      '[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 9\n',
    ]) {
      writeFileSync(configPath(), content);
      const old = marker().changedAtMs;
      observeCodexBootFence();
      expect(marker().changedAtMs).toBeGreaterThanOrEqual(old);
      expect(marker().bootHash).toBe(codexBootConfigHash());
    }
  });

  test("reseeds a corrupt marker", () => {
    writeFileSync(codexBootFenceMarkerPath(), "not-json");
    utimesSync(configPath(), 123, 123);
    expect(observeCodexBootFence().mtimeMs).toBe(123_000);
    expect(marker().schemaVersion).toBe(1);
  });

  test("falls back to raw mtime when config cannot be parsed", () => {
    writeFileSync(configPath(), "value = [\n");
    utimesSync(configPath(), 234, 234);
    expect(codexBootConfigHash()).toBeNull();
    expect(observeCodexBootFence().mtimeMs).toBe(234_000);
  });

  test("never writes into a never-managed Codex home", () => {
    writeFileSync(configPath(), 'model = "gpt-5"\n[marketplaces.x]\nlast_updated = 1\n');
    utimesSync(configPath(), 345, 345);
    expect(observeCodexBootFence().mtimeMs).toBe(345_000);
    expect(existsSync(codexBootFenceMarkerPath())).toBe(false);
    // Pre-injection behavior is unchanged: desktop churn still moves the raw fence
    // until CodexCommander manages the home and seeds the content-scoped marker.
    utimesSync(configPath(), 456, 456);
    expect(observeCodexBootFence().mtimeMs).toBe(456_000);
    expect(existsSync(codexBootFenceMarkerPath())).toBe(false);
  });

  test("never regresses a future stored change time", () => {
    const future = Date.now() + 60_000;
    writeFileSync(codexBootFenceMarkerPath(), JSON.stringify({ schemaVersion: 1, bootHash: "old", changedAtMs: future }));
    expect(observeCodexBootFence().mtimeMs).toBe(future);
    expect(marker().changedAtMs).toBe(future);
  });
});

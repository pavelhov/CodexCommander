import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFile } from "../config";
import {
  activeCodexConfigPath,
  getAgentsEnabled,
  getAgentsMaxDepth,
  getLogicalMaxThreads,
  getSubagentDeveloperInstructions,
  isMultiAgentV2Enabled,
} from "./features";
import { resolveCodexHomeDir } from "./home";

const MARKER_FILENAME = "codexcommander-activation-fence.json";

interface CodexBootFenceMarker {
  schemaVersion: 1;
  bootHash: string;
  changedAtMs: number;
}

function fileMtimeMs(path: string): number | null {
  try {
    const value = statSync(path).mtimeMs;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function codexBootFenceMarkerPath(): string {
  return join(resolveCodexHomeDir(), MARKER_FILENAME);
}

interface CodexBootConfigProjection {
  hash: string;
  /** True when the config carries CodexCommander's injected routing/catalog keys. */
  managed: boolean;
}

function codexBootConfigProjection(configPath: string): CodexBootConfigProjection | null {
  let parsed: Record<string, unknown>;
  try {
    const content = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    parsed = Bun.TOML.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rootString = (key: string): string | null => typeof parsed[key] === "string" ? parsed[key] as string : null;
  try {
    const projection = {
      agentsEnabled: getAgentsEnabled(configPath),
      agentsMaxDepth: getAgentsMaxDepth(configPath),
      maxConcurrentThreadsPerSession: getLogicalMaxThreads(configPath),
      modelCatalogJson: rootString("model_catalog_json"),
      modelProvider: rootString("model_provider"),
      multiAgentV2Enabled: isMultiAgentV2Enabled(configPath),
      openaiBaseUrl: rootString("openai_base_url"),
      subagentDeveloperInstructions: getSubagentDeveloperInstructions(configPath),
    };
    return {
      hash: createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
      managed: projection.modelCatalogJson !== null || projection.openaiBaseUrl !== null,
    };
  } catch {
    return null;
  }
}

/** Hash only values Codex consumes while booting a worker. */
export function codexBootConfigHash(configPath = activeCodexConfigPath()): string | null {
  return codexBootConfigProjection(configPath)?.hash ?? null;
}

function readMarker(path: string): CodexBootFenceMarker | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CodexBootFenceMarker>;
    if (value.schemaVersion !== 1 || typeof value.bootHash !== "string"
      || typeof value.changedAtMs !== "number" || !Number.isFinite(value.changedAtMs)) return null;
    return value as CodexBootFenceMarker;
  } catch {
    return null;
  }
}

function persistMarker(marker: CodexBootFenceMarker): void {
  try {
    atomicWriteFile(codexBootFenceMarkerPath(), `${JSON.stringify(marker, null, 2)}\n`);
  } catch {
    // Best effort: observing the same drift again remains conservative and safe.
  }
}

export function observeCodexBootFence(): { mtimeMs: number | null } {
  const configPath = activeCodexConfigPath();
  const projection = codexBootConfigProjection(configPath);
  if (projection === null) return { mtimeMs: fileMtimeMs(configPath) };

  const markerPath = codexBootFenceMarkerPath();
  const marker = readMarker(markerPath);
  if (!marker) {
    // A never-managed (uninjected or foreign) Codex home is only observed, never
    // written: an integration-off home must stay byte-identical. Raw mtime keeps
    // the pre-injection fence behavior. Once a managed home seeds the marker, the
    // content-scoped fence stays in effect even if injection is later removed.
    if (!projection.managed) return { mtimeMs: fileMtimeMs(configPath) };
    const seeded: CodexBootFenceMarker = {
      schemaVersion: 1,
      bootHash: projection.hash,
      changedAtMs: fileMtimeMs(configPath) ?? Date.now(),
    };
    persistMarker(seeded);
    return { mtimeMs: seeded.changedAtMs };
  }
  if (marker.bootHash === projection.hash) return { mtimeMs: marker.changedAtMs };

  // Detection-on-read intentionally catches external edits such as `codex features`.
  const drifted: CodexBootFenceMarker = {
    schemaVersion: 1,
    bootHash: projection.hash,
    changedAtMs: Math.max(Date.now(), marker.changedAtMs),
  };
  persistMarker(drifted);
  return { mtimeMs: drifted.changedAtMs };
}

export function recordCodexBootFenceApplied(): void {
  const bootHash = codexBootConfigHash();
  if (bootHash === null) return;
  const previous = readMarker(codexBootFenceMarkerPath());
  persistMarker({
    schemaVersion: 1,
    bootHash,
    changedAtMs: Math.max(Date.now(), previous?.changedAtMs ?? 0),
  });
}

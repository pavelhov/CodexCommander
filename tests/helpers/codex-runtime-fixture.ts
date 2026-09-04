import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeExecFile } from "../../src/codex/runtime";
import { persistCodexRuntime, setCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";
import { setBundledCatalogCacheForTests } from "../../src/codex/catalog/bundled";
import type { RawEntry } from "../../src/codex/catalog/parsing";

export const DEFAULT_SYNC_NATIVE_SLUGS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export function bundledCatalogFixture(
  slugs: readonly string[] = [...DEFAULT_SYNC_NATIVE_SLUGS],
): { models: RawEntry[] } {
  return {
    models: slugs.map((slug, priority) => ({
      slug,
      display_name: slug,
      description: "native fixture",
      priority,
      visibility: "list",
      base_instructions: "You are Codex, a coding agent based on GPT-5.",
      supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
    })),
  };
}

export function bundledCatalogJson(
  slugs: readonly string[] = [...DEFAULT_SYNC_NATIVE_SLUGS],
): string {
  return JSON.stringify(bundledCatalogFixture(slugs));
}

export const DEFAULT_BUNDLED_CATALOG_JSON = bundledCatalogJson();

export function createBundledCatalogExec(
  options: {
    versionByPath?: Record<string, string>;
    bundledByPath?: Record<string, string | null>;
    defaultVersion?: string;
    defaultCatalog?: string;
  } = {},
): RuntimeExecFile {
  const defaultVersion = options.defaultVersion ?? "codex-cli 0.999.0";
  const defaultCatalog = options.defaultCatalog ?? DEFAULT_BUNDLED_CATALOG_JSON;
  return (file, args) => {
    const path = String(file);
    const embedded = args[0] === "/d" && args[1] === "/s" && args[2] === "/c"
      ? String(args[3] ?? "").replace(/^"|"$/g, "")
      : "";
    if (embedded.includes("--version")) {
      for (const [candidate, version] of Object.entries(options.versionByPath ?? {})) {
        if (embedded.toLowerCase().includes(candidate.toLowerCase())) return version;
      }
      return defaultVersion;
    }
    if (embedded.includes("debug") && embedded.includes("models") && embedded.includes("--bundled")) {
      for (const [candidate, payload] of Object.entries(options.bundledByPath ?? {})) {
        if (embedded.toLowerCase().includes(candidate.toLowerCase())) {
          if (payload === null) throw new Error("bundled catalog unavailable");
          return payload;
        }
      }
      return defaultCatalog;
    }
    if (args[0] === "--version") {
      for (const [candidate, version] of Object.entries(options.versionByPath ?? {})) {
        if (path.toLowerCase() === candidate.toLowerCase()) return version;
      }
      return defaultVersion;
    }
    if (args[0] === "debug" && args[1] === "models" && args[2] === "--bundled") {
      for (const [candidate, payload] of Object.entries(options.bundledByPath ?? {})) {
        if (path.toLowerCase() === candidate.toLowerCase()) {
          if (payload === null) throw new Error("bundled catalog unavailable");
          return payload;
        }
      }
      const payload = options.bundledByPath?.[path];
      if (payload === null) throw new Error("bundled catalog unavailable");
      return payload ?? defaultCatalog;
    }
    throw new Error(`unexpected codex invocation: ${path} ${args.join(" ")}`);
  };
}

export function seedDeterministicCodexCatalogRuntime(
  options: {
    command?: string;
    version?: string;
    catalog?: { models: RawEntry[] };
    codexCommanderHome?: string;
  } = {},
): { command: string; version: string; source: "environment" } {
  const runtime = {
    command: options.command ?? "/tmp/ccx-codex-fixture",
    version: options.version ?? "0.146.0",
    source: "environment" as const,
  };
  const persistDeps = options.codexCommanderHome ? { configDir: options.codexCommanderHome } : {};
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] });
  setBundledCatalogCacheForTests(
    runtime,
    options.catalog ?? bundledCatalogFixture(),
    options.codexCommanderHome ? { codexCommanderHome: options.codexCommanderHome } : {},
  );
  persistCodexRuntime(runtime, persistDeps);
  return runtime;
}

export function seedDeterministicBundledCatalog(
  runtime: Pick<{ command: string; version: string }, "command" | "version">,
  catalog: { models: RawEntry[] },
  options: { codexCommanderHome?: string; configDir?: string } = {},
): void {
  const codexCommanderHome = options.codexCommanderHome ?? options.configDir;
  setBundledCatalogCacheForTests(
    runtime,
    catalog,
    codexCommanderHome ? { codexCommanderHome } : {},
  );
}

/** Fast deterministic stand-in for `codex --version` and `codex debug models --bundled`. */
export function createCodexRuntimeFixture(
  dir: string,
  options: { version?: string; catalog?: string | { models: RawEntry[] } } = {},
): string {
  const version = options.version ?? "0.999.0";
  const catalog = typeof options.catalog === "string"
    ? options.catalog
    : options.catalog
      ? JSON.stringify(options.catalog)
      : DEFAULT_BUNDLED_CATALOG_JSON;
  if (process.platform === "win32") {
    const path = join(dir, "codex-fixture.cmd");
    writeFileSync(path, [
      "@echo off",
      "if \"%~1\"==\"--version\" (",
      `  echo codex-cli ${version}`,
      ") else if \"%~1\"==\"debug\" if \"%~2\"==\"models\" if \"%~3\"==\"--bundled\" (",
      `  echo ${catalog}`,
      ")",
    ].join("\r\n"), "utf8");
    return path;
  }

  const path = join(dir, "codex-fixture");
  writeFileSync(path, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then",
    `  printf '%s\\n' 'codex-cli ${version}'`,
    "elif [ \"$1\" = \"debug\" ] && [ \"$2\" = \"models\" ] && [ \"$3\" = \"--bundled\" ]; then",
    `  printf '%s\\n' '${catalog}'`,
    "else",
    "  exit 1",
    "fi",
  ].join("\n"), "utf8");
  chmodSync(path, 0o755);
  return path;
}

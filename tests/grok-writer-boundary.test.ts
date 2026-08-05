import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The single-writer boundary (WP3, audit blocker 1): injectGrokConfig is the ONLY
 * module allowed to write a grok config.toml. This test walks ALL of src/ — a second
 * writer anywhere fails it, which is the property the criterion actually claims. A
 * string scan of one route file would pass while the capability existed; this cannot.
 */

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.endsWith(".ts")) yield path;
  }
}

// fileURLToPath, not .pathname: on Windows .pathname keeps a leading slash before the
// drive letter (\D:\a\...), which breaks fs calls on CI.
const SRC = fileURLToPath(new URL("../src", import.meta.url));

test("only src/grok/inject.ts writes a grok config.toml", () => {
  const writers: string[] = [];
  for (const path of walk(SRC)) {
    const content = readFileSync(path, "utf8");
    // A Grok TOML writer: constructs the Grok config path (or calls the shared path
    // helper) AND contains a write primitive. Merely carrying GROK_HOME into a service
    // environment must not combine with an unrelated $CODEX_HOME/config.toml diagnostic
    // elsewhere in the same module and become a false second writer.
    const mentionsGrokToml = /join\s*\(\s*grokHome\s*,\s*["']config\.toml["']/.test(content)
      || /\bgrokConfigPath\s*\(/.test(content)
      || /join\s*\(\s*homedir\(\)\s*,\s*["']\.grok["']\s*,\s*["']config\.toml["']/.test(content);
    const writes = /atomicWriteFile|writeFileSync|writeFile\(/.test(content);
    if (mentionsGrokToml && writes) writers.push(path);
  }
  expect(writers).toEqual([join(SRC, "grok/inject.ts")]);
});

test("the management routes reach the writer only through syncGrokConfig", () => {
  const routes = readFileSync(join(SRC, "server/management/agent-settings-routes.ts"), "utf8");
  expect(routes).toContain("syncGrokConfig");
  // No direct write primitive in the route file at all — the HTTP surface can only
  // ask the existing writer to run.
  expect(routes).not.toContain("atomicWriteFile");
  expect(routes).not.toContain("writeFileSync");
});

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_CATALOG = JSON.stringify({
  models: [{
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "native fixture",
    priority: 0,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
  }],
});

/** Fast deterministic stand-in for `codex --version` and `codex debug models`. */
export function createCodexRuntimeFixture(dir: string): string {
  if (process.platform === "win32") {
    const path = join(dir, "codex-fixture.cmd");
    writeFileSync(path, [
      "@echo off",
      "if \"%~1\"==\"--version\" (",
      "  echo codex-cli 0.999.0",
      ") else (",
      `  echo ${FIXTURE_CATALOG}`,
      ")",
    ].join("\r\n"), "utf8");
    return path;
  }

  const path = join(dir, "codex-fixture");
  writeFileSync(path, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then",
    "  printf '%s\\n' 'codex-cli 0.999.0'",
    "else",
    `  printf '%s\\n' '${FIXTURE_CATALOG}'`,
    "fi",
  ].join("\n"), "utf8");
  chmodSync(path, 0o755);
  return path;
}

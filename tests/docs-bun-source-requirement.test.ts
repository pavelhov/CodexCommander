import { expect, test } from "bun:test";

/**
 * Every contributor entry point must say that building from source needs a local `bun`, and
 * must not claim a registry package exists while package publication remains disabled.
 *
 * Each file is checked as one whole normalized paragraph rather than as scattered fragments.
 * Matching fragments independently across a whole file passes even after the explanatory
 * sentence is deleted, as long as the words survive somewhere else — that is a test that
 * cannot fail for the reason it exists. Whitespace normalization keeps a maintainer's
 * paragraph rewrap from breaking the suite over nothing.
 */
const PARAGRAPH_START = "Source development requires the `bun` CLI on your `PATH`";

const CASES = [
  {
    path: "../CONTRIBUTING.md",
    paragraph:
      "Source development requires the `bun` CLI on your `PATH`. Contributor commands such as `bun install`,"
      + " `bun run test`, and `bun run prepush` run from that local Bun installation. No registry package or"
      + " publishing automation is currently provided.",
  },
  {
    path: "../README.md",
    paragraph: "Source development requires the `bun` CLI on your `PATH`.",
  },
  {
    path: "../docs-site/src/content/docs/contributing.md",
    paragraph:
      "Source development requires the `bun` CLI on your `PATH`. No registry package is currently published;"
      + " this checkout's scripts run through your local Bun installation.",
  },
] as const;

/** The paragraph starting at `PARAGRAPH_START`, collapsed to single spaces. */
function normalizedRequirementParagraph(text: string): string | undefined {
  const start = text.indexOf(PARAGRAPH_START);
  if (start === -1) return undefined;
  const rest = text.slice(start);
  const end = rest.indexOf("\n\n");
  const paragraph = end === -1 ? rest : rest.slice(0, end);
  return paragraph.replace(/\s+/g, " ").trim();
}

test("source development docs require a local Bun CLI without claiming a published package", async () => {
  for (const entry of CASES) {
    const text = await Bun.file(new URL(entry.path, import.meta.url)).text();
    expect(normalizedRequirementParagraph(text)).toBe(entry.paragraph);
  }
});

import { expect, test } from "bun:test";

/** Codex Auth remains deep-linkable without competing with Providers in nav. */
test("Codex Auth is routable but omitted from the grouped sidebar", async () => {
  const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const navTable = src.slice(src.indexOf("const NAV_SECTIONS"), src.indexOf("const NAV ="));

  expect(src).not.toContain('viewMode === "workspace" && id === "codex-auth"');
  expect(navTable).not.toContain('id: "codex-auth"');
  expect(src).toContain('{page === "codex-auth" && <CodexAuth apiBase={API_BASE} />}');
});

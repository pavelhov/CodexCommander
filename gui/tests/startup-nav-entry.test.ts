import { expect, test } from "bun:test";

/**
 * Startup is a permanent navigation destination under the System group, not a
 * page reachable only through dashboard deep links. The selected startup UX
 * keeps it next to Storage with the terminal glyph.
 */

const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const navTable = src.slice(src.indexOf("const NAV_SECTIONS"), src.indexOf("const NAV ="));

test("the sidebar System group contains a permanent Startup entry", () => {
  const systemIndex = navTable.indexOf('labelKey: "nav.group.system"');
  expect(systemIndex).toBeGreaterThanOrEqual(0);
  const systemSection = navTable.slice(systemIndex);
  expect(systemSection).toContain('{ id: "startup", tkey: "nav.startup", Icon: IconTerminal }');
  // Startup leads the System group, before Storage.
  expect(systemSection.indexOf('id: "startup"')).toBeLessThan(systemSection.indexOf('id: "storage"'));
});

test("the Startup page is still routed and rendered", () => {
  expect(src).toContain('{page === "startup" && <Startup apiBase={API_BASE} />}');
  expect(src).toContain('startup: "nav.startup"');
});

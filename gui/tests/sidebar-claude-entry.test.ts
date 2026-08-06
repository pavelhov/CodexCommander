import { expect, test } from "bun:test";

/**
 * Connections are resources, not permanent navigation destinations. Client
 * Apps owns all client-specific detail routes; API Access claims only its key
 * route. This keeps Claude, Grok, OpenCode, and future clients in one catalog.
 */

const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const navTable = src.slice(src.indexOf("const NAV_SECTIONS"), src.indexOf("const NAV ="));

test("the sidebar exposes Client Apps and API Access, not vendor shortcuts", () => {
  expect(navTable).toContain('tkey: "nav.clientApps"');
  expect(navTable).toContain('tkey: "nav.apiAccess"');
  expect(navTable).not.toContain('tkey: "nav.claude"');
  expect(navTable).not.toContain('tkey: "nav.grok"');

  const renderedNav = src.slice(src.indexOf("<nav>"), src.indexOf("</nav>"));
  const navCode = renderedNav.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "").replace(/\/\/.*$/gm, "");
  expect(navCode).not.toContain("Switch");
  expect(navCode).not.toContain("/api/claude");
});

test("the orphaned sidebar switch styles are gone", async () => {
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  expect(css).not.toContain(".nav-entry-claude .switch");
});

function activeRow(rawHash: string): "apiAccess" | "clientApps" | null {
  const keysClaimed = rawHash === "integrations/keys" || rawHash.startsWith("integrations/keys/");
  if (keysClaimed) return "apiAccess";
  if (rawHash === "integrations" || rawHash.startsWith("integrations/")) return "clientApps";
  return null;
}

test("exactly one connection row is current for every integrations hash", () => {
  expect(activeRow("integrations")).toBe("clientApps");
  expect(activeRow("integrations/keys")).toBe("apiAccess");
  expect(activeRow("integrations/grok")).toBe("clientApps");
  expect(activeRow("integrations/claude")).toBe("clientApps");
  expect(activeRow("integrations/claude/desktop")).toBe("clientApps");
  expect(activeRow("integrations/opencode")).toBe("clientApps");
});

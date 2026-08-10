import { expect, test } from "bun:test";
import { hashBelongsToPage, readPageFromHash, resolveAppHashChange, DASHBOARD_TAB_HASHES } from "../src/app-routing";

/**
 * WP2 (implementation contract):
 * Dashboard section tabs live in the hash like Logs, so refresh / bookmark /
 * back-forward keep the choice. Overview is the bare "#dashboard".
 */

test("Dashboard sub-hashes are registered routes, not invalid suffixes", () => {
  for (const raw of DASHBOARD_TAB_HASHES) {
    expect(readPageFromHash(raw)).toBe("dashboard");
    expect(hashBelongsToPage(raw, "dashboard")).toBe(true);

    // A registered hash must survive: no passive replace back to "#dashboard".
    const action = resolveAppHashChange(raw);
    expect(action.page).toBe("dashboard");
    expect(action.replaceTo).toBeNull();
  }
});

test("bare #dashboard stays the Overview route", () => {
  expect(readPageFromHash("dashboard")).toBe("dashboard");
  expect(hashBelongsToPage("dashboard", "dashboard")).toBe(true);
  expect(resolveAppHashChange("dashboard").replaceTo).toBeNull();
  // Overview must not be spelled with a suffix.
  expect(DASHBOARD_TAB_HASHES).not.toContain("dashboard/overview");
});

test("unknown Dashboard suffixes are still normalized away", () => {
  const action = resolveAppHashChange("dashboard/nope");
  expect(action.page).toBe("dashboard");
  expect(action.replaceTo).toBe("dashboard");
});

test("registering Dashboard tabs does not disturb the Logs or Providers contracts", () => {
  expect(hashBelongsToPage("logs/debug", "logs")).toBe(true);
  expect(hashBelongsToPage("providers/example", "providers")).toBe(true);
  // Cross-page suffixes stay invalid.
  expect(hashBelongsToPage("dashboard/providers", "providers")).toBe(false);
  expect(hashBelongsToPage("logs/debug", "dashboard")).toBe(false);
});

test("the grouped sidebar starts with Dashboard, Sources, then Proxy", async () => {
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const nav = app.slice(app.indexOf("const NAV_SECTIONS"), app.indexOf("const NAV ="));
  const order = [...nav.matchAll(/id: "([a-z-]+)"/g)].map((m) => m[1]);
  expect(order[0]).toBe("dashboard");
  expect(order[1]).toBe("providers");
  expect(order[2]).toBe("models");
  expect(nav).toContain('labelKey: "nav.group.sources"');
  expect(nav).toContain('labelKey: "nav.group.proxy"');
  expect(nav).toContain('labelKey: "nav.group.connections"');
  expect(nav).not.toContain('id: "codex-auth"');
});

test("Dashboard uses the shared page-tabs strip with a tablist", async () => {
  const page = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(page).toContain('className="page-tabs" role="tablist"');
  expect(page).toContain('role="tab"');
  expect(page).toContain('role="tabpanel"');
  // The left rail is gone.
  expect(page).not.toContain("dashboard-workspace-rail");

  // Short tab strips wrap instead of creating a horizontal scrollbar (Q7).
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const strip = css.slice(css.indexOf(".page-tabs {"), css.indexOf("}", css.indexOf(".page-tabs {")));
  expect(strip).toContain("flex-wrap: wrap");
  expect(strip).toContain("overflow: visible");
});

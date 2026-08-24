import { expect, test } from "bun:test";
import ts from "typescript";

/**
 * Subagents ships one command-center layout (configured roster + library + policy).
 * Classic stacked cards and the view-mode toggle are gone.
 */

test("Subagents mounts the denser workspace as the only layout", async () => {
  const page = await Bun.file(new URL("../src/pages/Subagents.tsx", import.meta.url)).text();

  expect(page).toContain("SubagentsWorkspace");
  expect(page).toContain("subagents-workspace");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("workspaceView");
  expect(page).not.toContain("ccx-subagents-view");
  expect(page).not.toContain("pws.workspaceToggle");
  expect(page).not.toContain("pws.classicToggle");

  // Exactly one workspace render path remains after the shared cold-state guard.
  expect(page).toContain('state.showSkeleton && !snapshot');
  expect(page).toContain("DataSurfaceSkeleton");
  expect(page.match(/^ {2}return \(/gm)?.length).toBe(1);
});

test("Subagents keeps the featured-slot contract: 5 slots, reorder, remove, save", async () => {
  const page = await Bun.file(new URL("../src/pages/Subagents.tsx", import.meta.url)).text();
  const workspace = await Bun.file(
    new URL("../src/components/subagents-workspace/SubagentsWorkspace.tsx", import.meta.url),
  ).text();

  // Five-slot cap is a single exported FEATURED_MAX shared by page and workspace.
  expect(page).toContain("previous.length >= FEATURED_MAX");
  expect(page).toContain("FEATURED_MAX");
  expect(workspace).toContain("export const FEATURED_MAX");
  expect(workspace).toContain('t("sub.rosterCount", { n: chosen.length, max: FEATURED_MAX })');

  // Reorder / remove / save controls survive in the workspace main pane.
  expect(workspace).toContain('t("sub.moveUp", { m: selector })');
  expect(workspace).toContain('t("sub.moveDown", { m: selector })');
  expect(workspace).toContain('t("sub.removeAria", { m: selector })');
  expect(workspace).toContain('t("sub.saveRoster")');

  // Persistence still targets the subagent-models endpoint.
  expect(page).toContain("/api/subagent-models");
});

test("Subagents workspace assets and i18n keys are present", async () => {
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  expect(css).toContain("styles-subagents-workspace.css");

  const workspaceComponent = Bun.file(
    new URL("../src/components/subagents-workspace/SubagentsWorkspace.tsx", import.meta.url),
  );
  expect(await workspaceComponent.exists()).toBe(true);

  const workspaceCss = Bun.file(new URL("../src/styles-subagents-workspace.css", import.meta.url));
  expect(await workspaceCss.exists()).toBe(true);

  for (const locale of ["en", "ko", "ja", "de", "ru", "zh"]) {
    const src = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(src).toContain("sub.workspace.");
  }
});

const delegationSetupKeys = [
  "sub.delegationSetup.loading",
  "sub.delegationSetup.title",
  "sub.delegationSetup.subtitle",
  "sub.delegationSetup.statusReady",
  "sub.delegationSetup.statusInstalled",
  "sub.delegationSetup.statusShadowed",
  "sub.delegationSetup.statusNotInstalled",
  "sub.delegationSetup.statusUpdate",
  "sub.delegationSetup.statusPartial",
  "sub.delegationSetup.statusConflict",
  "sub.delegationSetup.statusUnsafe",
  "sub.delegationSetup.modeLegend",
  "sub.delegationSetup.mode.balanced",
  "sub.delegationSetup.mode.balancedDescription",
  "sub.delegationSetup.mode.orchestrator",
  "sub.delegationSetup.mode.orchestratorDescription",
  "sub.delegationSetup.liveRoster",
  "sub.delegationSetup.skillArtifact",
  "sub.delegationSetup.agentsArtifact",
  "sub.delegationSetup.preview",
  "sub.delegationSetup.install",
  "sub.delegationSetup.update",
  "sub.delegationSetup.repair",
  "sub.delegationSetup.changeMode",
  "sub.delegationSetup.remove",
  "sub.delegationSetup.removeTitle",
  "sub.delegationSetup.removeConfirm",
  "sub.delegationSetup.manual",
  "sub.delegationSetup.manualHint",
  "sub.delegationSetup.copy",
  "sub.delegationSetup.copied",
  "sub.delegationSetup.copyUnavailable",
  "sub.delegationSetup.newTask",
  "sub.delegationSetup.working",
  "sub.delegationSetup.reasonConflict",
  "sub.delegationSetup.reasonUnsafe",
  "sub.delegationSetup.error",
  "sub.delegationSetup.retry",
  "sub.delegationSetup.close",
  "sub.delegationSetup.cancel",
  "sub.delegationSetup.confirmChangeMode",
] as const;

test("Subagents places Codex delegation setup after Run Policy", async () => {
  const workspace = await Bun.file(new URL("../src/components/subagents-workspace/SubagentsWorkspace.tsx", import.meta.url)).text();
  expect(workspace).toContain('import CodexDelegationSetupCard');
  expect(workspace.indexOf("swi-policy")).toBeLessThan(workspace.indexOf("CodexDelegationSetupCard delegationSetup"));
});

test("every locale has exact parity with the complete delegation setup key contract", async () => {
  for (const locale of ["en", "ko", "ja", "de", "ru", "zh"]) {
    const src = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    const actual = Array.from(src.matchAll(/^\s*"(sub\.delegationSetup\.[^"]+)"\s*:/gm), match => match[1]).sort();
    expect(actual).toEqual([...delegationSetupKeys].sort());
  }
});

test("delegation card has no hardcoded visible JSX copy", async () => {
  const src = await Bun.file(new URL("../src/components/subagents-workspace/CodexDelegationSetupCard.tsx", import.meta.url)).text();
  const sourceFile = ts.createSourceFile("CodexDelegationSetupCard.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  const visibleAttributes = new Set(["alt", "aria-label", "aria-description", "placeholder", "title"]);

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && node.getText(sourceFile).trim()) violations.push(node.getText(sourceFile).trim());
    if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.getText(sourceFile)) && node.initializer && ts.isStringLiteral(node.initializer)) {
      violations.push(node.initializer.text);
    }
    if (ts.isJsxExpression(node) && node.expression && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression))) {
      const parentTag = ts.isJsxElement(node.parent) ? node.parent.openingElement.tagName.getText(sourceFile) : "";
      if (parentTag !== "code" && parentTag !== "pre") violations.push(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  expect(violations).toEqual([]);
});

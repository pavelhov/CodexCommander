import { expect, test } from "bun:test";

test("Models provider table keeps collapse, context policy, and actions in separate controls", async () => {
  const src = await Bun.file(new URL("../src/pages/Models.tsx", import.meta.url)).text();
  expect(src).toContain("models-provider-head");
  expect(src).toContain("models-provider-actions");
  expect(src).toContain("models-provider-toggle");
  expect(src).toContain("models-provider-discovery");
  expect(src).toContain("models-context-policy");
  // Collapse lives on a sibling button; the actions row no longer needs stopPropagation.
  expect(src).toMatch(/className="row models-provider-toggle"/);
  expect(src).toMatch(/className="row models-provider-actions"/);
  expect(src).not.toMatch(/className="row models-provider-actions"\s+onClick=\{e => e\.stopPropagation\(\)\}/);
  // Both Classic and Workspace share renderGroup — no duplicate unclassed group-head for providers.
  const providerHeads = src.match(/models-provider-head/g) ?? [];
  expect(providerHeads.length).toBeGreaterThanOrEqual(1);
  expect(src).toContain("models.allOn");
  expect(src).toContain("models.allOff");
});

test("Models workspace reflows its provider grid before the rail stacks", async () => {
  const css = await Bun.file(new URL("../src/styles-models-workspace.css", import.meta.url)).text();
  expect(css).toContain("container-name: models-workspace");
  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("@container models-workspace (max-width: 720px)");
  expect(css).toContain(".models-provider-head");
  expect(css).toContain(".models-provider-actions");
  expect(css).toContain(".models-provider-toggle");
  expect(css).toContain(".models-provider-discovery");
  expect(css).toMatch(/\.models-provider-columns,\s*\.models-provider-head\s*\{[^}]*display:\s*grid/s);
  expect(css).toContain("@container models-workspace (max-width: 960px)");
  expect(css).toMatch(/@container models-workspace \(max-width: 960px\)[\s\S]*\.models-provider-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  expect(css).toMatch(/\.models-provider-toggle\s*\{[^}]*min-width:\s*0/s);
  // Mobile media rule retained for drawer layouts.
  expect(css).toContain("@media (max-width: 768px)");
});

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
  expect(page.match(/<SubagentsWorkspace\b/g)?.length).toBe(1);
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

function findHardcodedVisibleJsxCopy(src: string): string[] {
  const sourceFile = ts.createSourceFile("fixture.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: string[] = [];
  const nonVisibleAttributes = new Set([
    "aria-busy", "aria-checked", "aria-controls", "aria-current", "aria-describedby", "aria-disabled",
    "aria-expanded", "aria-hidden", "aria-labelledby", "aria-live", "aria-modal", "aria-pressed",
    "aria-selected", "checked", "className", "defaultChecked", "disabled", "href", "htmlFor", "id", "key",
    "multiple", "name", "readOnly", "ref", "rel", "required", "role", "selected", "src", "style", "tabIndex",
    "target", "type",
  ]);

  const attributeName = (attribute: ts.JsxAttribute) => attribute.name.getText(sourceFile);
  const isNonVisibleAttribute = (name: string) => (
    nonVisibleAttributes.has(name) || name.startsWith("data-") || /^on[A-Z]/.test(name)
  );
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const isDelegationTranslationKey = (expression: ts.Expression): boolean => {
    const current = unwrap(expression);
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      return current.text.startsWith("sub.delegationSetup.");
    }
    if (ts.isTemplateExpression(current)) return current.head.text.startsWith("sub.delegationSetup.");
    if (ts.isConditionalExpression(current)) {
      return isDelegationTranslationKey(current.whenTrue) && isDelegationTranslationKey(current.whenFalse);
    }
    // TKey-typed variables and helper results keep non-copy control logic out of
    // the JSX while the real source still passes TypeScript's translation-key check.
    return ts.isIdentifier(current) || ts.isCallExpression(current) || ts.isPropertyAccessExpression(current);
  };
  const isDelegationTranslationCall = (expression: ts.CallExpression) => (
    ts.isIdentifier(expression.expression)
    && expression.expression.text === "t"
    && expression.arguments.length > 0
    && isDelegationTranslationKey(expression.arguments[0]!)
  );
  const isDelegationModeTuple = (expression: ts.Expression) => {
    const current = unwrap(expression);
    return ts.isArrayLiteralExpression(current)
      && current.elements.length === 2
      && ts.isStringLiteral(current.elements[0]!)
      && current.elements[0].text === "balanced"
      && ts.isStringLiteral(current.elements[1]!)
      && current.elements[1].text === "orchestrator";
  };
  const recordLiteral = (node: ts.Node, approvedTechnical: boolean) => {
    if (approvedTechnical) return;
    const text = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : node.getText(sourceFile).trim();
    if (text) violations.push(text);
  };
  const hasTechnicalCopyApproval = (opening: ts.JsxOpeningLikeElement) => {
    const tag = opening.tagName.getText(sourceFile);
    if (tag !== "code" && tag !== "pre") return false;
    const marker = opening.attributes.properties.find(
      property => ts.isJsxAttribute(property) && attributeName(property) === "data-i18n-technical",
    );
    return !!marker && ts.isJsxAttribute(marker) && !!marker.initializer
      && ts.isStringLiteral(marker.initializer) && marker.initializer.text === "true";
  };

  let scanExpression: (expression: ts.Expression, approvedTechnical: boolean) => void;
  let scanJsxElement: (element: ts.JsxElement, approvedTechnical: boolean) => void;
  let scanJsxFragment: (fragment: ts.JsxFragment, approvedTechnical: boolean) => void;

  const scanFunctionBody = (body: ts.ConciseBody, approvedTechnical: boolean) => {
    if (!ts.isBlock(body)) {
      scanExpression(body, approvedTechnical);
      return;
    }
    const visitReturns = (node: ts.Node) => {
      if (node !== body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) {
        scanExpression(node.expression, approvedTechnical);
        return;
      }
      ts.forEachChild(node, visitReturns);
    };
    visitReturns(body);
  };

  const scanObjectLiteral = (object: ts.ObjectLiteralExpression, approvedTechnical: boolean) => {
    for (const property of object.properties) {
      if (ts.isPropertyAssignment(property)) scanExpression(property.initializer, approvedTechnical);
      else if (ts.isSpreadAssignment(property)) scanExpression(property.expression, approvedTechnical);
      else if (ts.isMethodDeclaration(property) && property.body) scanFunctionBody(property.body, approvedTechnical);
      else if (ts.isGetAccessorDeclaration(property) && property.body) scanFunctionBody(property.body, approvedTechnical);
    }
  };

  scanExpression = (expression, approvedTechnical) => {
    const current = unwrap(expression);
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      recordLiteral(current, approvedTechnical);
      return;
    }
    if (ts.isTemplateExpression(current) || ts.isTaggedTemplateExpression(current)) {
      recordLiteral(current, approvedTechnical);
      return;
    }
    if (ts.isJsxElement(current)) {
      scanJsxElement(current, approvedTechnical);
      return;
    }
    if (ts.isJsxSelfClosingElement(current)) {
      scanJsxAttributes(current, false);
      return;
    }
    if (ts.isJsxFragment(current)) {
      scanJsxFragment(current, approvedTechnical);
      return;
    }
    if (ts.isConditionalExpression(current)) {
      scanExpression(current.whenTrue, approvedTechnical);
      scanExpression(current.whenFalse, approvedTechnical);
      return;
    }
    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.CommaToken) {
        scanExpression(current.right, approvedTechnical);
      } else if (
        operator === ts.SyntaxKind.BarBarToken
        || operator === ts.SyntaxKind.QuestionQuestionToken
        || operator === ts.SyntaxKind.PlusToken
        || operator === ts.SyntaxKind.EqualsToken
        || operator === ts.SyntaxKind.PlusEqualsToken
        || operator === ts.SyntaxKind.BarBarEqualsToken
        || operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        || operator === ts.SyntaxKind.QuestionQuestionEqualsToken
      ) {
        scanExpression(current.left, approvedTechnical);
        scanExpression(current.right, approvedTechnical);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        if (ts.isSpreadElement(element)) scanExpression(element.expression, approvedTechnical);
        else scanExpression(element, approvedTechnical);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(current)) {
      scanObjectLiteral(current, approvedTechnical);
      return;
    }
    if (ts.isCallExpression(current)) {
      if (isDelegationTranslationCall(current)) return;
      const callee = unwrap(current.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        // These exact machine values select translated mode labels; they are
        // not rendered copy. Other literal-bearing call receivers still fail.
        if (!isDelegationModeTuple(callee.expression)) scanExpression(callee.expression, approvedTechnical);
      } else if (!ts.isIdentifier(callee)) {
        scanExpression(callee, approvedTechnical);
      }
      for (const argument of current.arguments) scanExpression(argument, approvedTechnical);
      return;
    }
    if (ts.isNewExpression(current)) {
      for (const argument of current.arguments ?? []) scanExpression(argument, approvedTechnical);
      return;
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      scanFunctionBody(current.body, approvedTechnical);
      return;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      scanExpression(current.expression, approvedTechnical);
      return;
    }
    if (ts.isAwaitExpression(current) || ts.isYieldExpression(current)) {
      if (current.expression) scanExpression(current.expression, approvedTechnical);
    }
  };

  const scanJsxAttribute = (attribute: ts.JsxAttribute, approvedTechnical: boolean) => {
    if (isNonVisibleAttribute(attributeName(attribute)) || !attribute.initializer) return;
    if (ts.isStringLiteral(attribute.initializer)) recordLiteral(attribute.initializer, approvedTechnical);
    else if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
      scanExpression(attribute.initializer.expression, approvedTechnical);
    }
  };
  function scanJsxAttributes(opening: ts.JsxOpeningLikeElement, approvedTechnical: boolean) {
    for (const property of opening.attributes.properties) {
      if (ts.isJsxAttribute(property)) scanJsxAttribute(property, approvedTechnical);
      else scanExpression(property.expression, approvedTechnical);
    }
  }
  const scanJsxChild = (child: ts.JsxChild, approvedTechnical: boolean) => {
    if (ts.isJsxText(child)) recordLiteral(child, approvedTechnical);
    else if (ts.isJsxExpression(child) && child.expression) scanExpression(child.expression, approvedTechnical);
    else if (ts.isJsxElement(child)) scanJsxElement(child, approvedTechnical);
    else if (ts.isJsxSelfClosingElement(child)) scanJsxAttributes(child, false);
    else if (ts.isJsxFragment(child)) scanJsxFragment(child, approvedTechnical);
  };
  scanJsxElement = (element, approvedTechnical) => {
    const childTechnicalApproval = approvedTechnical || hasTechnicalCopyApproval(element.openingElement);
    scanJsxAttributes(element.openingElement, false);
    for (const child of element.children) scanJsxChild(child, childTechnicalApproval);
  };
  scanJsxFragment = (fragment, approvedTechnical) => {
    for (const child of fragment.children) scanJsxChild(child, approvedTechnical);
  };

  const visitTopLevel = (node: ts.Node) => {
    if (ts.isJsxElement(node)) scanJsxElement(node, false);
    else if (ts.isJsxSelfClosingElement(node)) scanJsxAttributes(node, false);
    else if (ts.isJsxFragment(node)) scanJsxFragment(node, false);
    else ts.forEachChild(node, visitTopLevel);
  };
  visitTopLevel(sourceFile);
  return violations;
}

test("visible-copy contract rejects direct and recursively wrapped JSX literal mutations", () => {
  const fixtures = [
    ["direct JSX text", "const Card = () => <p>Direct visible copy</p>;"],
    ["direct string expression", 'const Card = () => <p>{"Direct expression copy"}</p>;'],
    ["parenthesized literal", 'const Card = () => <p>{("Parenthesized copy")}</p>;'],
    ["asserted literal", 'const Card = () => <p>{("Asserted copy" as string)}</p>;'],
    ["conditional literal", 'const Card = () => <p>{enabled ? "Conditional copy" : serverCopy}</p>;'],
    ["array-wrapped literal", 'const Card = () => <p>{["Array copy"]}</p>;'],
    ["call-wrapped literal", 'const Card = () => <p>{renderCopy("Call copy")}</p>;'],
  ] as const;

  const actual = Object.fromEntries(fixtures.map(([name, src]) => [name, findHardcodedVisibleJsxCopy(src)]));
  expect(actual).toEqual({
    "direct JSX text": ["Direct visible copy"],
    "direct string expression": ["Direct expression copy"],
    "parenthesized literal": ["Parenthesized copy"],
    "asserted literal": ["Asserted copy"],
    "conditional literal": ["Conditional copy"],
    "array-wrapped literal": ["Array copy"],
    "call-wrapped literal": ["Call copy"],
  });
});

test("visible-copy contract rejects unapproved code and pre literal mutations", () => {
  const src = 'const Card = () => <><code>{"Code visible copy"}</code><pre>{`Pre visible copy`}</pre></>;';
  expect(findHardcodedVisibleJsxCopy(src)).toEqual(["Code visible copy", "Pre visible copy"]);
});

test("visible-copy contract rejects literals in every literal-bearing visible prop", () => {
  const src = `const Card = () => <>
    <img alt="Alt visible copy" />
    <button aria-label="ARIA visible copy" aria-description={"ARIA description copy"} title="Title visible copy" />
    <input placeholder="Placeholder visible copy" value="Value visible copy" />
    <code data-i18n-technical="true"><span title="Nested visible copy" /></code>
  </>;`;
  expect(findHardcodedVisibleJsxCopy(src)).toEqual([
    "Alt visible copy",
    "ARIA visible copy",
    "ARIA description copy",
    "Title visible copy",
    "Placeholder visible copy",
    "Value visible copy",
    "Nested visible copy",
  ]);
});

test("visible-copy contract allows translations, server projections, approved technical copy, and technical attributes", () => {
  const src = `const Card = () => <section className="card" id="setup" role="status" aria-live="polite" data-state="ready">
    <h2>{t("sub.delegationSetup.title")}</h2>
    <p>{status.projectedReason}</p>
    <code>{status.artifacts.skill.displayPath}</code>
    <pre>{status.previews[selectedMode].agentsBlockText}</pre>
    <code data-i18n-technical="true">{"ccx claude"}</code>
    <pre data-i18n-technical="true">{"~/.codex/AGENTS.md"}</pre>
  </section>;`;
  expect(findHardcodedVisibleJsxCopy(src)).toEqual([]);
});

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
  expect(findHardcodedVisibleJsxCopy(src)).toEqual([]);
});

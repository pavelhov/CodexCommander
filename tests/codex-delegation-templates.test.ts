import { describe, expect, test } from "bun:test";
import {
  DELEGATION_BEGIN_MARKER,
  DELEGATION_END_MARKER,
  isCodexCommanderManagedSkill,
  renderCodexDelegationBundle,
} from "../src/codex/delegation-templates";
import {
  inspectDelegationAgentsBlock,
  removeDelegationAgentsBlock,
  upsertDelegationAgentsBlock,
} from "../src/codex/delegation-agents-block";

describe("Codex delegation templates", () => {
  test("balanced is deterministic and carries no roster ids", () => {
    const first = renderCodexDelegationBundle("balanced");
    const second = renderCodexDelegationBundle("balanced");
    expect(first).toEqual(second);
    expect(first.skillText).toContain("name: codexcommander-delegation");
    expect(first.skillText).toContain("managed-by: codexcommander");
    expect(first.agentsBlockText).toContain("Mode: balanced");
    expect(first.copyPrompt).toContain(first.skillText);
    expect(first.copyPrompt).toContain(first.agentsBlockText);
    for (const frozenId of ["gpt-5.6", "kimi/", "xai/", "grok-4.6"]) {
      expect(`${first.skillText}\n${first.agentsBlockText}`).not.toContain(frozenId);
    }
  });

  test("orchestrator delegates execution but preserves wasteful-work exceptions", () => {
    const bundle = renderCodexDelegationBundle("orchestrator");
    expect(bundle.agentsBlockText).toContain("Mode: orchestrator");
    expect(bundle.agentsBlockText).toContain("clearly wasteful");
    expect(bundle.agentsBlockText).toContain("review");
    expect(bundle.agentsBlockText).toContain("synthesis");
  });

  test("managed skill ownership is carried by SKILL.md itself", () => {
    const skill = renderCodexDelegationBundle("balanced").skillText;
    expect(isCodexCommanderManagedSkill(skill)).toBe(true);
    expect(isCodexCommanderManagedSkill(skill.replace("managed-by: codexcommander", "managed-by: someone-else"))).toBe(false);
  });
});

describe("Codex delegation AGENTS.md block transforms", () => {
  const balancedBlock = renderCodexDelegationBundle("balanced").agentsBlockText;
  const orchestratorBlock = renderCodexDelegationBundle("orchestrator").agentsBlockText;

  test("reports an absent block and inserts it as a separate final block", () => {
    expect(inspectDelegationAgentsBlock("# Project\n")).toEqual({ kind: "absent" });
    expect(upsertDelegationAgentsBlock("# Project\n", balancedBlock)).toEqual({
      content: `# Project\n${balancedBlock}`,
      changed: true,
    });
  });

  test("inserts into an empty file and preserves a missing final newline", () => {
    expect(upsertDelegationAgentsBlock("", balancedBlock)).toEqual({
      content: balancedBlock,
      changed: true,
    });
    expect(upsertDelegationAgentsBlock("# Project", balancedBlock)).toEqual({
      content: `# Project\n${balancedBlock}`,
      changed: true,
    });
  });

  test("updates a managed block idempotently and changes only the managed region", () => {
    const source = `before\n${balancedBlock}\nafter\n`;
    expect(upsertDelegationAgentsBlock(source, balancedBlock)).toEqual({ content: source, changed: false });
    expect(upsertDelegationAgentsBlock(source, orchestratorBlock)).toEqual({
      content: `before\n${orchestratorBlock}\nafter\n`,
      changed: true,
    });
  });

  test("preserves CRLF and all prefix and suffix bytes", () => {
    const crlfBlock = balancedBlock.replaceAll("\n", "\r\n");
    const source = `prefix\r\n${crlfBlock}\r\nsuffix\r\n`;
    expect(inspectDelegationAgentsBlock(source)).toMatchObject({ kind: "managed", mode: "balanced", version: 1 });
    expect(upsertDelegationAgentsBlock(source, crlfBlock)).toEqual({ content: source, changed: false });
    expect(removeDelegationAgentsBlock(source)).toEqual({ content: "prefix\r\nsuffix\r\n", changed: true });
  });

  test("removes only its immediately introduced separators", () => {
    expect(removeDelegationAgentsBlock(balancedBlock)).toEqual({ content: "", changed: true });
    expect(removeDelegationAgentsBlock(`before\n${balancedBlock}`)).toEqual({ content: "before\n", changed: true });
  });

  test.each([
    ["duplicate", `${balancedBlock}\n${balancedBlock}\n`],
    ["orphan begin", `${DELEGATION_BEGIN_MARKER}\n# Project\n`],
    ["orphan end", `# Project\n${DELEGATION_END_MARKER}\n`],
    ["reversed", `${DELEGATION_END_MARKER}\n# Project\n${DELEGATION_BEGIN_MARKER}\n`],
    ["begin substring", `prefix ${DELEGATION_BEGIN_MARKER}\n`],
    ["end substring", `prefix ${DELEGATION_END_MARKER}\n`],
  ])("refuses %s marker conflicts without changing the input", (_name, source) => {
    expect(inspectDelegationAgentsBlock(source).kind).toBe("conflict");
    expect(upsertDelegationAgentsBlock(source, balancedBlock)).toEqual({ content: source, changed: false });
    expect(removeDelegationAgentsBlock(source)).toEqual({ content: source, changed: false });
  });
});

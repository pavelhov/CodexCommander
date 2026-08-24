import { readFileSync } from "node:fs";

export type CodexDelegationMode = "balanced" | "orchestrator";

export const CODEX_DELEGATION_SCHEMA_VERSION = 1 as const;
export const DELEGATION_BEGIN_MARKER = "<!-- BEGIN CODEXCOMMANDER DELEGATION -->";
export const DELEGATION_END_MARKER = "<!-- END CODEXCOMMANDER DELEGATION -->";

export interface CodexDelegationBundle {
  mode: CodexDelegationMode;
  skillText: string;
  agentsBlockText: string;
  copyPrompt: string;
}

const SKILL_URL = new URL("../skills/codexcommander-delegation/SKILL.md", import.meta.url);

function canonicalSkillText(): string {
  return readFileSync(SKILL_URL, "utf8");
}

function agentsBlock(mode: CodexDelegationMode): string {
  const delegationSentence = mode === "balanced"
    ? "Delegate substantial bounded parallel work when it will clearly help; the root may still implement and must synthesize."
    : "The root delegates research and implementation, and focuses on decomposition, coordination, review, and synthesis. Work directly only when delegation is unavailable or clearly wasteful.";

  return [
    DELEGATION_BEGIN_MARKER,
    `<!-- CodexCommander delegation schema: ${CODEX_DELEGATION_SCHEMA_VERSION} -->`,
    "## CodexCommander delegation",
    `Mode: ${mode}`,
    "Before spawning subagents, use $codexcommander-delegation and reread its SKILL.md if its details were compacted.",
    "Consult the active collaboration roster and spawn-tool contract. Never hardcode model IDs. Give workers self-contained tasks.",
    delegationSentence,
    "This guidance is advisory and does not create collaboration tools. User and repository instructions outrank it for whether to spawn.",
    DELEGATION_END_MARKER,
  ].join("\n");
}

export function renderCodexDelegationBundle(mode: CodexDelegationMode): CodexDelegationBundle {
  const skillText = canonicalSkillText();
  const agentsBlockText = agentsBlock(mode);
  const copyPrompt = [
    "Preview the following two writes exactly, then wait for my approval before changing any files.",
    "",
    "SKILL.md:",
    skillText,
    "",
    "AGENTS.md block:",
    agentsBlockText,
  ].join("\n");

  return { mode, skillText, agentsBlockText, copyPrompt };
}

export function isCodexCommanderManagedSkill(content: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (frontmatter === undefined) return false;

  return [
    /^name:\s*codexcommander-delegation\s*\r?$/m,
    /^\s{2}managed-by:\s*codexcommander\s*\r?$/m,
    /^\s{2}managed-version:\s*"1"\s*\r?$/m,
  ].every((pattern) => pattern.test(frontmatter));
}

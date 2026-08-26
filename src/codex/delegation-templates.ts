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
const SKILL_PAYLOAD_BEGIN = "<<<CODEXCOMMANDER_DELEGATION_SKILL_PAYLOAD_BEGIN_7F3A9C2E>>>";
const SKILL_PAYLOAD_END = "<<<CODEXCOMMANDER_DELEGATION_SKILL_PAYLOAD_END_7F3A9C2E>>>";
const AGENTS_PAYLOAD_BEGIN = "<<<CODEXCOMMANDER_DELEGATION_AGENTS_PAYLOAD_BEGIN_B6D1E840>>>";
const AGENTS_PAYLOAD_END = "<<<CODEXCOMMANDER_DELEGATION_AGENTS_PAYLOAD_END_B6D1E840>>>";
const MANUAL_PAYLOAD_DELIMITERS = [
  SKILL_PAYLOAD_BEGIN,
  SKILL_PAYLOAD_END,
  AGENTS_PAYLOAD_BEGIN,
  AGENTS_PAYLOAD_END,
] as const;

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
    "A wait_agent timeout is neutral; never interrupt solely because one or more waits timed out. Use the managed skill for reconciliation and interruption gates.",
    delegationSentence,
    "This guidance is advisory and does not create collaboration tools. User and repository instructions outrank it for whether to spawn.",
    DELEGATION_END_MARKER,
  ].join("\n");
}

/** @internal Pure seam for validating the manual-copy frame contract. */
export function assertManualPayloadFrameSafety(skillText: string, agentsBlockText: string): void {
  for (const payload of [skillText, agentsBlockText]) {
    if (MANUAL_PAYLOAD_DELIMITERS.some((delimiter) => payload.includes(delimiter))) {
      throw new Error("canonical delegation payload collides with a manual-copy delimiter");
    }
  }
}

function framePayload(payload: string, begin: string, end: string): string {
  return `${begin}\n${payload}\n${end}`;
}

export function renderCodexDelegationBundle(mode: CodexDelegationMode): CodexDelegationBundle {
  const skillText = canonicalSkillText();
  const agentsBlockText = agentsBlock(mode);
  assertManualPayloadFrameSafety(skillText, agentsBlockText);
  const copyPrompt = [
    `Set up CodexCommander delegation in ${mode} mode.`,
    "",
    "Resolve and inspect before any write:",
    "- Resolve the platform user home displayed as `$HOME` exactly once as a readable, safe physical directory, then derive the skill target `$HOME/.agents/skills/codexcommander-delegation/SKILL.md`; never blindly interpolate an empty home variable.",
    "- Resolve the Codex home exactly once. A configured `CODEX_HOME` whose trimmed value is non-empty is authoritative and must resolve to a readable, safe physical directory; refuse an unreadable, non-directory, or unsafe explicit root instead of falling back. When `CODEX_HOME` is unset or empty, use the same effective platform default discovery as CodexCommander: start with `$HOME/.codex`; if that Linux/default home contains `config.toml`, select it. On supported WSL when it does not, honor the `[automount] root` from `/etc/wsl.conf` (default `/mnt`), discover readable physical Windows-profile `.codex` homes containing `config.toml`, prefer the candidate matching `USERPROFILE`, otherwise select a sole candidate only, and fall back to the Linux default when discovery is absent or ambiguous. Validate the selected root and never blindly interpolate an empty shell variable.",
    "- From that validated Codex home derive the policy target displayed as `$CODEX_HOME/AGENTS.md`, compatibility collision path `skills/codexcommander-delegation`, read-only override path `AGENTS.override.md`, and protected configuration path `config.toml`; `$CODEX_HOME/AGENTS.md` is a symbolic display path, never a shell string to interpolate before resolution.",
    "",
    "Before writing, safely inspect the targets and override, preview both proposed artifact changes, and obtain my explicit approval. Make no write before approval; approval never substitutes for the safety requirements below.",
    "",
    "Ownership and content rules:",
    "- Replace the target skill only when its frontmatter has exactly one `name: codexcommander-delegation`, one `metadata:` mapping containing exactly `managed-by: codexcommander` and `managed-version: \"1\"`; otherwise treat it as foreign and refuse.",
    "- Refuse when the compatibility collision path exists.",
    "- In the policy target, accept only an absent marker pair or one exact full-line begin marker followed by one exact full-line end marker. Refuse duplicate, orphaned, reversed, malformed, substring, or otherwise ambiguous markers.",
    "- For one existing exact pair, replace the inclusive managed region from the first byte of the begin-marker line through the last byte of the end-marker line with the supplied marker-inclusive block. For an absent pair, append the block with only the minimum line separator: none after an existing LF/CRLF, otherwise one detected EOL (CRLF if the file contains CRLF, LF otherwise). Normalize only the inserted block to that EOL and preserve every prior and unrelated byte.",
    "",
    "Override activation rules:",
    "- Inspect `AGENTS.override.md` read-only and never edit it. Absent or zero-byte means a fresh Codex task can load the global policy; any non-zero-byte file, including whitespace-only content, means the artifacts are structurally installed but the policy is shadowed; unreadable or unsafe means activation is unknown. Never guarantee activation.",
    "",
    "Fail-closed filesystem rules:",
    "- Refuse any symlink, junction, or reparse substitution in either validated root, any parent component, or a leaf; a present leaf must be a regular single-link file, never a hardlink or nonregular file.",
    "- If an exact target parent is missing beneath its validated physical root, inspect each existing component and create one missing descendant at a time with exclusive, non-recursive directory creation using mode `0700` on POSIX (or the platform-equivalent user-only mode). Immediately lstat, realpath, and identity-check every created or concurrently appeared component; require a physical directory at the expected path with no symlink, junction, or reparse substitution, record its identity, and refuse any failed or changing check.",
    "- Read with bounded, no-follow inspection and fatal UTF-8 decoding: at most 256 KiB for each skill and 1 MiB for each AGENTS file. Refuse unreadable, oversized, invalid-UTF-8, or changing inputs.",
    "- Bind publication to the exact inspected parent and preimage: revalidate parent identity plus leaf identity and bytes immediately before publishing. For each artifact that changes, create one exclusive same-parent temporary file per artifact as the sole transient-path exception; create it as a regular single-link file at mode `0600`, bind its recorded device/file identity, preserve an existing target's mode when supported, write and sync the exact desired bytes, revalidate it, publish atomically relative to the verified parent, then verify the postimage identity and bytes.",
    "- On every success or failure, clean up only that exact temporary path when its recorded identity still matches a regular single-link file; never remove a changed, replaced, or unknown path.",
    "- Refuse without writing if available filesystem primitives cannot establish no-follow parent/leaf checks, exact parent and preimage revalidation, exclusive temporary creation, parent-bound atomic publication, and postimage verification.",
    "- Only the two target artifacts may persistently change. The minimal missing physical parent directories needed to create those exact artifacts are the only authorized scaffolding; do not create, edit, remove, or leave any unrelated persistent file or directory. Do not edit the override, `config.toml`, or `subagentDeveloperInstructions`. Do not copy a roster or persist model/provider IDs, effort values, tool namespaces, or slot counts.",
    "",
    "Payload framing rules: each exact payload starts after the LF following its BEGIN delimiter and ends before the single wrapper LF immediately preceding its END delimiter. The wrapper LF and all delimiter bytes are not part of either artifact. Preserve payload bytes between those boundaries exactly, including whether the payload itself has a terminal newline; never write a delimiter.",
    "",
    "Canonical skill payload:",
    framePayload(skillText, SKILL_PAYLOAD_BEGIN, SKILL_PAYLOAD_END),
    "",
    "Canonical marker-inclusive AGENTS.md block payload:",
    framePayload(agentsBlockText, AGENTS_PAYLOAD_BEGIN, AGENTS_PAYLOAD_END),
    "",
    "After approved writes, report the paths changed and the override-derived activation state, and advise me to start a new Codex task. Say a fresh task can load the policy only for an absent or zero-byte override; report every non-zero-byte override as shadowed and an unreadable or unsafe override as activation unknown. Never claim guaranteed activation.",
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

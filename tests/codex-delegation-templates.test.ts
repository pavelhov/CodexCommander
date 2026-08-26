import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as delegationTemplates from "../src/codex/delegation-templates";
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

function extractPayload(prompt: string, begin: string, end: string): string {
  const beginToken = `${begin}\n`;
  const endToken = `\n${end}`;
  const start = prompt.indexOf(beginToken);
  const finish = prompt.indexOf(endToken, start + beginToken.length);
  if (start === -1 || finish === -1 || prompt.indexOf(beginToken, start + beginToken.length) !== -1
    || prompt.indexOf(endToken, finish + endToken.length) !== -1) {
    throw new Error(`expected exactly one ordered ${begin}/${end} payload pair`);
  }
  return prompt.slice(start + beginToken.length, finish);
}

describe("Codex delegation templates", () => {
  test("balanced is deterministic and carries no roster ids", () => {
    const first = renderCodexDelegationBundle("balanced");
    const second = renderCodexDelegationBundle("balanced");
    const canonicalSkillSource = readFileSync(
      new URL("../src/skills/codexcommander-delegation/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(first).toEqual(second);
    expect(first.skillText).toBe(canonicalSkillSource);
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

  test.each(["balanced", "orchestrator"] as const)(
    "%s manual setup follows platform default discovery instead of equating an unset CODEX_HOME with the Unix default",
    (mode) => {
      const prompt = renderCodexDelegationBundle(mode).copyPrompt;

      expect(prompt).toContain("same effective platform default discovery as CodexCommander");
      expect(prompt).toContain("supported WSL");
      expect(prompt).toContain("Windows-profile `.codex` home");
      expect(prompt).toContain("`USERPROFILE`");
      expect(prompt).not.toContain("When it is unset or empty, use `$HOME/.codex`.");
    },
  );

  test.each(["balanced", "orchestrator"] as const)(
    "%s manual setup authorizes a safe fresh parent and exactly one identity-bound temp without unrelated persistent writes",
    (mode) => {
      const prompt = renderCodexDelegationBundle(mode).copyPrompt;

      expect(prompt).toContain("one missing descendant at a time");
      expect(prompt).toContain("exclusive, non-recursive directory creation");
      expect(prompt).toContain("Immediately lstat, realpath, and identity-check");
      expect(prompt).toContain("mode `0700` on POSIX");
      expect(prompt).toContain("one exclusive same-parent temporary file per artifact");
      expect(prompt).toContain("sole transient-path exception");
      expect(prompt).toContain("clean up only that exact temporary path when its recorded identity still matches");
      expect(prompt).toContain("Only the two target artifacts may persistently change");
      expect(prompt).not.toContain("any path other than the two artifact targets");
    },
  );

  test.each(
    MANUAL_PAYLOAD_DELIMITERS.flatMap((delimiter) => [
      [`skill payload containing ${delimiter}`, `${delimiter}\ncanonical skill`, "canonical policy"],
      [`AGENTS payload containing ${delimiter}`, "canonical skill", `${delimiter}\ncanonical policy`],
    ] as const),
  )("rejects a cross-frame delimiter collision in the %s", (_case, skillText, agentsBlockText) => {
    const seam = (
      delegationTemplates as unknown as {
        assertManualPayloadFrameSafety?: (skill: string, agents: string) => void;
      }
    ).assertManualPayloadFrameSafety;

    expect(() => seam?.(skillText, agentsBlockText)).toThrow(/collides with a manual-copy delimiter/);
  });

  test.each(["balanced", "orchestrator"] as const)(
    "%s manual setup prompt has an exact fail-closed wrapper and byte-extractable payloads",
    (mode) => {
      const bundle = renderCodexDelegationBundle(mode);
      const skillBegin = bundle.copyPrompt.indexOf(SKILL_PAYLOAD_BEGIN);
      const skillEnd = bundle.copyPrompt.indexOf(SKILL_PAYLOAD_END);
      const agentsBegin = bundle.copyPrompt.indexOf(AGENTS_PAYLOAD_BEGIN);
      const agentsEnd = bundle.copyPrompt.indexOf(AGENTS_PAYLOAD_END);

      expect([skillBegin, skillEnd, agentsBegin, agentsEnd].every((index) => index >= 0)).toBe(true);
      expect(skillBegin).toBeLessThan(skillEnd);
      expect(skillEnd).toBeLessThan(agentsBegin);
      expect(agentsBegin).toBeLessThan(agentsEnd);
      expect(bundle.copyPrompt.slice(0, skillBegin)).toBe(
        `Set up CodexCommander delegation in ${mode} mode.\n\n`
        + "Resolve and inspect before any write:\n"
        + "- Resolve the platform user home displayed as `$HOME` exactly once as a readable, safe physical directory, then derive the skill target `$HOME/.agents/skills/codexcommander-delegation/SKILL.md`; never blindly interpolate an empty home variable.\n"
        + "- Resolve the Codex home exactly once. A configured `CODEX_HOME` whose trimmed value is non-empty is authoritative and must resolve to a readable, safe physical directory; refuse an unreadable, non-directory, or unsafe explicit root instead of falling back. When `CODEX_HOME` is unset or empty, use the same effective platform default discovery as CodexCommander: start with `$HOME/.codex`; if that Linux/default home contains `config.toml`, select it. On supported WSL when it does not, honor the `[automount] root` from `/etc/wsl.conf` (default `/mnt`), discover readable physical Windows-profile `.codex` homes containing `config.toml`, prefer the candidate matching `USERPROFILE`, otherwise select a sole candidate only, and fall back to the Linux default when discovery is absent or ambiguous. Validate the selected root and never blindly interpolate an empty shell variable.\n"
        + "- From that validated Codex home derive the policy target displayed as `$CODEX_HOME/AGENTS.md`, compatibility collision path `skills/codexcommander-delegation`, read-only override path `AGENTS.override.md`, and protected configuration path `config.toml`; `$CODEX_HOME/AGENTS.md` is a symbolic display path, never a shell string to interpolate before resolution.\n\n"
        + "Before writing, safely inspect the targets and override, preview both proposed artifact changes, and obtain my explicit approval. Make no write before approval; approval never substitutes for the safety requirements below.\n\n"
        + "Ownership and content rules:\n"
        + "- Replace the target skill only when its frontmatter has exactly one `name: codexcommander-delegation`, one `metadata:` mapping containing exactly `managed-by: codexcommander` and `managed-version: \"1\"`; otherwise treat it as foreign and refuse.\n"
        + "- Refuse when the compatibility collision path exists.\n"
        + "- In the policy target, accept only an absent marker pair or one exact full-line begin marker followed by one exact full-line end marker. Refuse duplicate, orphaned, reversed, malformed, substring, or otherwise ambiguous markers.\n"
        + "- For one existing exact pair, replace the inclusive managed region from the first byte of the begin-marker line through the last byte of the end-marker line with the supplied marker-inclusive block. For an absent pair, append the block with only the minimum line separator: none after an existing LF/CRLF, otherwise one detected EOL (CRLF if the file contains CRLF, LF otherwise). Normalize only the inserted block to that EOL and preserve every prior and unrelated byte.\n\n"
        + "Override activation rules:\n"
        + "- Inspect `AGENTS.override.md` read-only and never edit it. Absent or zero-byte means a fresh Codex task can load the global policy; any non-zero-byte file, including whitespace-only content, means the artifacts are structurally installed but the policy is shadowed; unreadable or unsafe means activation is unknown. Never guarantee activation.\n\n"
        + "Fail-closed filesystem rules:\n"
        + "- Refuse any symlink, junction, or reparse substitution in either validated root, any parent component, or a leaf; a present leaf must be a regular single-link file, never a hardlink or nonregular file.\n"
        + "- If an exact target parent is missing beneath its validated physical root, inspect each existing component and create one missing descendant at a time with exclusive, non-recursive directory creation using mode `0700` on POSIX (or the platform-equivalent user-only mode). Immediately lstat, realpath, and identity-check every created or concurrently appeared component; require a physical directory at the expected path with no symlink, junction, or reparse substitution, record its identity, and refuse any failed or changing check.\n"
        + "- Read with bounded, no-follow inspection and fatal UTF-8 decoding: at most 256 KiB for each skill and 1 MiB for each AGENTS file. Refuse unreadable, oversized, invalid-UTF-8, or changing inputs.\n"
        + "- Bind publication to the exact inspected parent and preimage: revalidate parent identity plus leaf identity and bytes immediately before publishing. For each artifact that changes, create one exclusive same-parent temporary file per artifact as the sole transient-path exception; create it as a regular single-link file at mode `0600`, bind its recorded device/file identity, preserve an existing target's mode when supported, write and sync the exact desired bytes, revalidate it, publish atomically relative to the verified parent, then verify the postimage identity and bytes.\n"
        + "- On every success or failure, clean up only that exact temporary path when its recorded identity still matches a regular single-link file; never remove a changed, replaced, or unknown path.\n"
        + "- Refuse without writing if available filesystem primitives cannot establish no-follow parent/leaf checks, exact parent and preimage revalidation, exclusive temporary creation, parent-bound atomic publication, and postimage verification.\n"
        + "- Only the two target artifacts may persistently change. The minimal missing physical parent directories needed to create those exact artifacts are the only authorized scaffolding; do not create, edit, remove, or leave any unrelated persistent file or directory. Do not edit the override, `config.toml`, or `subagentDeveloperInstructions`. Do not copy a roster or persist model/provider IDs, effort values, tool namespaces, or slot counts.\n\n"
        + "Payload framing rules: each exact payload starts after the LF following its BEGIN delimiter and ends before the single wrapper LF immediately preceding its END delimiter. The wrapper LF and all delimiter bytes are not part of either artifact. Preserve payload bytes between those boundaries exactly, including whether the payload itself has a terminal newline; never write a delimiter.\n\n"
        + "Canonical skill payload:\n",
      );
      expect(bundle.copyPrompt.slice(skillEnd + SKILL_PAYLOAD_END.length, agentsBegin)).toBe(
        "\n\nCanonical marker-inclusive AGENTS.md block payload:\n",
      );
      expect(bundle.copyPrompt.slice(agentsEnd + AGENTS_PAYLOAD_END.length)).toBe(
        "\n\nAfter approved writes, report the paths changed and the override-derived activation state, and advise me to start a new Codex task. Say a fresh task can load the policy only for an absent or zero-byte override; report every non-zero-byte override as shadowed and an unreadable or unsafe override as activation unknown. Never claim guaranteed activation.",
      );

      expect(extractPayload(bundle.copyPrompt, SKILL_PAYLOAD_BEGIN, SKILL_PAYLOAD_END)).toBe(bundle.skillText);
      expect(extractPayload(bundle.copyPrompt, AGENTS_PAYLOAD_BEGIN, AGENTS_PAYLOAD_END)).toBe(bundle.agentsBlockText);
      for (const delimiter of [SKILL_PAYLOAD_BEGIN, SKILL_PAYLOAD_END, AGENTS_PAYLOAD_BEGIN, AGENTS_PAYLOAD_END]) {
        expect(bundle.skillText).not.toContain(delimiter);
        expect(bundle.agentsBlockText).not.toContain(delimiter);
      }
      expect(bundle.copyPrompt).not.toMatch(/guaranteed to load/i);
      expect(bundle.copyPrompt).not.toMatch(/(?:follow|allow) (?:a )?(?:symbolic )?link/i);
      expect(bundle.copyPrompt).not.toMatch(/approval (?:is|makes|renders).{0,30}safe/i);
      expect(bundle.copyPrompt).not.toMatch(
        /\b(?:may|can|should|must)\s+(?:make\s+)?(?:a\s+)?write.{0,40}\bbefore approval\b/i,
      );
      expect(bundle.copyPrompt).not.toMatch(
        /\b(?:may|can|should|must)\s+(?:edit|modify|write|remove|replace).{0,40}\bAGENTS\.override\.md\b/i,
      );
    },
  );

  test("canonical artifacts carry no concrete roster, model, effort, tool-namespace, or slot data", () => {
    const bundle = renderCodexDelegationBundle("balanced");
    const artifacts = `${bundle.skillText}\n${bundle.agentsBlockText}`;

    expect(artifacts).not.toMatch(
      /\b(?:gpt|claude|gemini|grok|deepseek|llama|mistral|qwen|kimi|xai|anthropic|openai)[-_/.:][a-z0-9]/i,
    );
    expect(artifacts).not.toMatch(/\b(?:functions|tools|mcp|ccx_collaboration)[.:_]{1,2}[a-z][\w.-]*/i);
    expect(artifacts).not.toMatch(/\b(?:low|medium|high|xhigh|max|ultra)\s+(?:reasoning\s+)?effort\b/i);
    expect(artifacts).not.toMatch(/\b\d+\s+(?:concurrency\s+)?slots?\b/i);
  });

  test("managed skill treats featured models as suggestions, not an exhaustive spawn allowlist", () => {
    const skill = renderCodexDelegationBundle("balanced").skillText;
    expect(skill).toContain("featured suggestions, not an exhaustive allowlist");
    expect(skill).toContain("known exact");
    expect(skill).toContain("native");
    expect(skill).not.toContain("Use only model IDs and effort levels advertised live");
    expect(skill).not.toMatch(
      /\b(?:gpt|claude|gemini|grok|deepseek|llama|mistral|qwen|kimi|xai|anthropic|openai)[-_/.:][a-z0-9]/i,
    );
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

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderCodexDelegationBundle } from "../src/codex/delegation-templates";
import {
  inspectCodexDelegation,
  mutateCodexDelegation,
  type CodexDelegationInstallerDeps,
} from "../src/codex/delegation-installer";

interface Fixture {
  root: string;
  userHome: string;
  codexHome: string;
  deps: CodexDelegationInstallerDeps;
  skillDir: string;
  skillPath: string;
  compatSkillPath: string;
  agentsPath: string;
  overridePath: string;
  configPath: string;
}

const fixtures: string[] = [];

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ccx-delegation-installer-"));
  fixtures.push(root);
  const userHome = join(root, "user");
  const codexHome = join(root, "codex");
  mkdirSync(userHome);
  mkdirSync(codexHome);
  const skillDir = join(userHome, ".agents", "skills", "codexcommander-delegation");
  return {
    root,
    userHome,
    codexHome,
    deps: { userHome, codexHome },
    skillDir,
    skillPath: join(skillDir, "SKILL.md"),
    compatSkillPath: join(codexHome, "skills", "codexcommander-delegation", "SKILL.md"),
    agentsPath: join(codexHome, "AGENTS.md"),
    overridePath: join(codexHome, "AGENTS.override.md"),
    configPath: join(codexHome, "config.toml"),
  };
}

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function assertNoManagementResidue(fx: Fixture): void {
  const names: string[] = [];
  function visit(path: string): void {
    if (!existsSync(path) || !lstatSync(path).isDirectory()) return;
    for (const name of readdirSync(path)) {
      names.push(name);
      visit(join(path, name));
    }
  }
  visit(fx.userHome);
  visit(fx.codexHome);
  expect(names.some((name) => name === ".codexcommander-managed" || /(?:hash|manifest|lock)/i.test(name))).toBe(false);
}

describe("Codex delegation installer", () => {
  test("fresh balanced install creates only SKILL.md and the marked AGENTS block", () => {
    const fx = fixture();
    const bundle = renderCodexDelegationBundle("balanced");
    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.changed).toBe(true);
    expect(readFileSync(fx.skillPath, "utf8")).toBe(bundle.skillText);
    expect(readFileSync(fx.agentsPath, "utf8")).toBe(bundle.agentsBlockText);
    expect(outcome.status.state).toBe("current");
    expect(outcome.status.installedMode).toBe("balanced");
    expect(outcome.status.artifacts.skill.displayPath).toBe("$HOME/.agents/skills/codexcommander-delegation/SKILL.md");
    expect(outcome.status.artifacts.agentsPolicy.displayPath).toBe("$CODEX_HOME/AGENTS.md");
  });

  test("orchestrator install writes the same skill and only changes the global mode sentence", () => {
    const balanced = fixture();
    const orchestrator = fixture();
    mutateCodexDelegation({ action: "install", mode: "balanced" }, balanced.deps);
    mutateCodexDelegation({ action: "install", mode: "orchestrator" }, orchestrator.deps);

    expect(readFileSync(orchestrator.skillPath, "utf8")).toBe(readFileSync(balanced.skillPath, "utf8"));
    const left = readFileSync(balanced.agentsPath, "utf8").split("\n");
    const right = readFileSync(orchestrator.agentsPath, "utf8").split("\n");
    expect(left.filter((line, index) => line !== right[index])).toEqual([
      "Mode: balanced",
      "Delegate substantial bounded parallel work when it will clearly help; the root may still implement and must synthesize.",
    ]);
  });

  test("reinstall is idempotent", () => {
    const fx = fixture();
    expect(mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps)).toMatchObject({ ok: true, changed: true });
    const skillMtime = lstatSync(fx.skillPath, { bigint: true }).mtimeNs;
    const agentsMtime = lstatSync(fx.agentsPath, { bigint: true }).mtimeNs;

    expect(mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps)).toMatchObject({ ok: true, changed: false });
    expect(lstatSync(fx.skillPath, { bigint: true }).mtimeNs).toBe(skillMtime);
    expect(lstatSync(fx.agentsPath, { bigint: true }).mtimeNs).toBe(agentsMtime);
  });

  test("mode update replaces only bytes between AGENTS markers", () => {
    const fx = fixture();
    const balanced = renderCodexDelegationBundle("balanced").agentsBlockText;
    const orchestrator = renderCodexDelegationBundle("orchestrator").agentsBlockText;
    write(fx.skillPath, renderCodexDelegationBundle("balanced").skillText);
    write(fx.agentsPath, `prefix\r\n${balanced.replaceAll("\n", "\r\n")}\r\nsuffix\r\n`);

    const outcome = mutateCodexDelegation({ action: "install", mode: "orchestrator" }, fx.deps);
    expect(outcome).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(fx.agentsPath, "utf8")).toBe(`prefix\r\n${orchestrator.replaceAll("\n", "\r\n")}\r\nsuffix\r\n`);
  });

  test("a current CRLF policy inspects as current", () => {
    const fx = fixture();
    const bundle = renderCodexDelegationBundle("balanced");
    write(fx.skillPath, bundle.skillText);
    write(fx.agentsPath, bundle.agentsBlockText.replaceAll("\n", "\r\n"));

    expect(inspectCodexDelegation(fx.deps)).toMatchObject({
      state: "current",
      installedMode: "balanced",
      artifacts: { skill: { state: "current" }, agentsPolicy: { state: "current" } },
    });
  });

  test("uninstall removes AGENTS block first, then only SKILL.md, and rmdir only when empty", () => {
    const fx = fixture();
    mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    const order: string[] = [];

    const outcome = mutateCodexDelegation({ action: "uninstall" }, {
      ...fx.deps,
      beforePublish: (artifact) => order.push(artifact),
    });
    expect(outcome).toMatchObject({ ok: true, changed: true, status: { state: "not-installed" } });
    expect(order).toEqual(["agents", "skill"]);
    expect(existsSync(fx.agentsPath)).toBe(true);
    expect(readFileSync(fx.agentsPath, "utf8")).toBe("");
    expect(existsSync(fx.skillPath)).toBe(false);
    expect(existsSync(fx.skillDir)).toBe(false);
  });

  test("uninstall preserves unexpected sibling files in the skill directory", () => {
    const fx = fixture();
    mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    const sibling = join(fx.skillDir, "notes.txt");
    write(sibling, "user-owned");

    expect(mutateCodexDelegation({ action: "uninstall" }, fx.deps)).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(sibling, "utf8")).toBe("user-owned");
    expect(existsSync(fx.skillDir)).toBe(true);
  });

  test("uninstall preserves an unmarked user AGENTS file byte for byte", () => {
    const fx = fixture();
    const userAgents = Buffer.from("# User policy\r\nNever touch this file.\r\n");
    write(fx.agentsPath, userAgents);

    expect(mutateCodexDelegation({ action: "uninstall" }, fx.deps)).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(fx.agentsPath)).toEqual(userAgents);
  });

  test("foreign SKILL.md is never overwritten or deleted", () => {
    const fx = fixture();
    write(fx.skillPath, "---\nname: codexcommander-delegation\n---\nforeign\n");
    for (const mutation of [{ action: "install", mode: "balanced" }, { action: "uninstall" }] as const) {
      const outcome = mutateCodexDelegation(mutation, fx.deps);
      expect(outcome).toMatchObject({ ok: false, changed: false, reason: "foreign_skill" });
      expect(readFileSync(fx.skillPath, "utf8")).toContain("foreign");
      expect(existsSync(fx.agentsPath)).toBe(false);
    }
  });

  test("valid managed metadata permits update and uninstall without a separate ownership file", () => {
    const fx = fixture();
    const canonical = renderCodexDelegationBundle("balanced").skillText;
    write(fx.skillPath, canonical.replace(/\n# CodexCommander delegation/, "\nlegacy text\n# CodexCommander delegation"));
    write(fx.agentsPath, renderCodexDelegationBundle("balanced").agentsBlockText.replace("schema: 1", "schema: 0"));
    expect(inspectCodexDelegation(fx.deps).state).toBe("update-available");

    expect(mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps)).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(fx.skillPath, "utf8")).toBe(canonical);
    expect(mutateCodexDelegation({ action: "uninstall" }, fx.deps)).toMatchObject({ ok: true, changed: true });
    expect(existsSync(fx.skillPath)).toBe(false);
  });

  test("older managed skill metadata remains owned and reports update available", () => {
    const fx = fixture();
    const older = renderCodexDelegationBundle("balanced").skillText.replace('managed-version: "1"', 'managed-version: "0"');
    write(fx.skillPath, older);
    write(fx.agentsPath, renderCodexDelegationBundle("balanced").agentsBlockText);

    expect(inspectCodexDelegation(fx.deps)).toMatchObject({
      state: "update-available",
      artifacts: { skill: { state: "outdated" }, agentsPolicy: { state: "current" } },
    });
    expect(mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps)).toMatchObject({ ok: true, changed: true });
  });

  test.each([
    ["duplicate", `${renderCodexDelegationBundle("balanced").agentsBlockText}\n${renderCodexDelegationBundle("balanced").agentsBlockText}`],
    ["orphan", "<!-- BEGIN CODEXCOMMANDER DELEGATION -->\nuser"],
    ["reversed", "<!-- END CODEXCOMMANDER DELEGATION -->\n<!-- BEGIN CODEXCOMMANDER DELEGATION -->"],
    ["malformed", "prefix <!-- BEGIN CODEXCOMMANDER DELEGATION -->"],
  ])("%s AGENTS markers refuse without writes", (_name, agents) => {
    const fx = fixture();
    write(fx.agentsPath, agents);
    const before = readFileSync(fx.agentsPath);
    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    expect(outcome).toMatchObject({ ok: false, changed: false, reason: "ambiguous_agents_markers" });
    expect(readFileSync(fx.agentsPath)).toEqual(before);
    expect(existsSync(fx.skillPath)).toBe(false);
  });

  test("a duplicate compatibility-root skill refuses install without reclassifying the managed user skill", () => {
    const fx = fixture();
    mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    const compatibilityBytes = Buffer.from("compatibility collision");
    write(fx.compatSkillPath, compatibilityBytes);

    expect(inspectCodexDelegation(fx.deps)).toMatchObject({
      state: "conflict",
      artifacts: { skill: { state: "current" }, agentsPolicy: { state: "current" } },
    });
    expect(mutateCodexDelegation({ action: "install", mode: "orchestrator" }, fx.deps)).toMatchObject({
      ok: false,
      changed: false,
      reason: "foreign_skill",
    });
    expect(readFileSync(fx.skillPath, "utf8")).toBe(renderCodexDelegationBundle("balanced").skillText);
    expect(readFileSync(fx.compatSkillPath)).toEqual(compatibilityBytes);
  });

  test("managed uninstall succeeds while a compatibility-root collision remains untouched", () => {
    const fx = fixture();
    mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    const compatibilityBytes = Buffer.from("compatibility collision");
    write(fx.compatSkillPath, compatibilityBytes);

    expect(mutateCodexDelegation({ action: "uninstall" }, fx.deps)).toMatchObject({ ok: true, changed: true });
    expect(existsSync(fx.skillPath)).toBe(false);
    expect(readFileSync(fx.agentsPath, "utf8")).toBe("");
    expect(readFileSync(fx.compatSkillPath)).toEqual(compatibilityBytes);
  });

  test.each([
    ["missing managed-version", "---\nname: codexcommander-delegation\nmetadata:\n  managed-by: codexcommander\n---\nforeign\n"],
    ["managed-by outside metadata", "---\nname: codexcommander-delegation\nownership:\n  managed-by: codexcommander\nmetadata:\n  managed-version: \"0\"\n---\nforeign\n"],
    ["non-scalar metadata", "---\nname: codexcommander-delegation\nmetadata: codexcommander\n  managed-by: codexcommander\n  managed-version: \"0\"\n---\nforeign\n"],
  ])("%s never proves skill ownership for install or uninstall", (_name, foreignSkill) => {
    for (const mutation of [{ action: "install", mode: "balanced" }, { action: "uninstall" }] as const) {
      const fx = fixture();
      write(fx.skillPath, foreignSkill);
      const agents = renderCodexDelegationBundle("balanced").agentsBlockText;
      write(fx.agentsPath, agents);

      expect(mutateCodexDelegation(mutation, fx.deps)).toMatchObject({
        ok: false,
        changed: false,
        reason: "foreign_skill",
      });
      expect(readFileSync(fx.skillPath, "utf8")).toBe(foreignSkill);
      expect(readFileSync(fx.agentsPath, "utf8")).toBe(agents);
    }
  });

  test.each(["symlink parent", "symlink leaf", "hardlink", "directory leaf"])("%s refuses as unsafe", (shape) => {
    const fx = fixture();
    if (shape === "symlink parent") {
      const outside = join(fx.root, "outside");
      mkdirSync(outside);
      mkdirSync(join(fx.userHome, ".agents"));
      symlinkSync(outside, join(fx.userHome, ".agents", "skills"), process.platform === "win32" ? "junction" : "dir");
    } else if (shape === "symlink leaf") {
      write(join(fx.root, "outside-skill"), "foreign");
      mkdirSync(fx.skillDir, { recursive: true });
      symlinkSync(join(fx.root, "outside-skill"), fx.skillPath);
    } else if (shape === "hardlink") {
      write(fx.skillPath, renderCodexDelegationBundle("balanced").skillText);
      linkSync(fx.skillPath, join(fx.root, "second-link"));
    } else {
      mkdirSync(fx.skillPath, { recursive: true });
    }
    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    expect(outcome).toMatchObject({ ok: false, changed: false, reason: "unsafe_path" });
    expect(outcome.status.state).toBe("unsafe");
  });

  test("nonregular leaf refuses as unsafe", () => {
    if (process.platform === "win32") return;
    const fx = fixture();
    mkdirSync(fx.skillDir, { recursive: true });
    const made = Bun.spawnSync(["mkfifo", fx.skillPath]);
    expect(made.exitCode).toBe(0);
    expect(mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps)).toMatchObject({
      ok: false,
      changed: false,
      reason: "unsafe_path",
    });
  });

  test("invalid UTF-8 and oversized files refuse with their precise reasons", () => {
    const invalid = fixture();
    write(invalid.agentsPath, new Uint8Array([0xc3, 0x28]));
    expect(mutateCodexDelegation({ action: "install", mode: "balanced" }, invalid.deps)).toMatchObject({ reason: "invalid_utf8" });

    const large = fixture();
    write(large.skillPath, "x".repeat(256 * 1024 + 1));
    expect(mutateCodexDelegation({ action: "install", mode: "balanced" }, large.deps)).toMatchObject({ reason: "too_large" });
  });

  test("AGENTS output crossing the read bound refuses before publication and compensates the skill", () => {
    const fx = fixture();
    const agentsBefore = Buffer.alloc(1024 * 1024 - 1, 0x78);
    write(fx.agentsPath, agentsBefore);

    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);

    expect(outcome).toMatchObject({
      ok: false,
      changed: false,
      reason: "too_large",
      status: {
        state: "not-installed",
        artifacts: { skill: { state: "absent" }, agentsPolicy: { state: "absent" } },
      },
    });
    expect(readFileSync(fx.agentsPath)).toEqual(agentsBefore);
    expect(existsSync(fx.skillPath)).toBe(false);
    expect(readdirSync(fx.codexHome)).toEqual(["AGENTS.md"]);
  });

  test("changed preimage before publish refuses", () => {
    const fx = fixture();
    write(fx.agentsPath, "user preface\n");
    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, {
      ...fx.deps,
      beforePublish: (artifact) => {
        if (artifact === "agents") writeFileSync(fx.agentsPath, "concurrent edit\n");
      },
    });
    expect(outcome).toMatchObject({ ok: false, changed: false, reason: "changed_during_mutation" });
    expect(readFileSync(fx.agentsPath, "utf8")).toBe("concurrent edit\n");
    expect(existsSync(fx.skillPath)).toBe(false);
  });

  test("a Codex root symlink swap between artifacts refuses before creating a temp", () => {
    const fx = fixture();
    const movedRoot = join(fx.root, "moved-codex");
    const outside = join(fx.root, "outside-codex");
    mkdirSync(outside);
    let swapped = false;
    let agentsHookReached = false;
    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, {
      ...fx.deps,
      beforePublish: (artifact) => {
        if (artifact === "skill" && !swapped) {
          swapped = true;
          renameSync(fx.codexHome, movedRoot);
          symlinkSync(outside, fx.codexHome, process.platform === "win32" ? "junction" : "dir");
        } else if (artifact === "agents") {
          agentsHookReached = true;
        }
      },
    });

    expect(outcome).toMatchObject({ ok: false, changed: false, reason: "unsafe_path" });
    expect(agentsHookReached).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("second-artifact failure compensates the first artifact", () => {
    const fx = fixture();
    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, {
      ...fx.deps,
      beforePublish: (artifact) => {
        if (artifact === "agents") throw new Error("injected second-artifact failure");
      },
    });
    expect(outcome).toMatchObject({ ok: false, changed: false, reason: "write_failed" });
    expect(existsSync(fx.skillPath)).toBe(false);
    expect(existsSync(fx.agentsPath)).toBe(false);
  });

  test("failed compensation reports partial_write with changed true", () => {
    const fx = fixture();
    let sabotaged = false;
    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, {
      ...fx.deps,
      beforePublish: (artifact) => {
        if (artifact === "agents" && !sabotaged) {
          sabotaged = true;
          writeFileSync(fx.skillPath, "concurrent replacement");
          throw new Error("injected second-artifact failure");
        }
      },
    });
    expect(outcome).toMatchObject({ ok: false, changed: true, reason: "partial_write" });
    expect(readFileSync(fx.skillPath, "utf8")).toBe("concurrent replacement");
  });

  test("a DelegationFsError after rename reports a published partial write", () => {
    const fx = fixture();
    const deps = {
      ...fx.deps,
      afterPublish: (artifact: "skill" | "agents", operation: "write" | "remove") => {
        if (artifact === "skill" && operation === "write") {
          writeFileSync(fx.skillPath, Buffer.alloc(256 * 1024 + 1, 0x78));
        }
      },
    };

    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, deps);

    expect(outcome).toMatchObject({ ok: false, changed: true, reason: "partial_write" });
    expect(readFileSync(fx.skillPath).byteLength).toBe(256 * 1024 + 1);
    expect(existsSync(fx.agentsPath)).toBe(false);
  });

  test("an arbitrary error after rename reports a published partial write", () => {
    const fx = fixture();
    const deps = {
      ...fx.deps,
      afterPublish: (artifact: "skill" | "agents", operation: "write" | "remove") => {
        if (artifact === "skill" && operation === "write") throw new Error("post-rename verification failure");
      },
    };

    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, deps);

    expect(outcome).toMatchObject({
      ok: false,
      changed: true,
      reason: "partial_write",
      status: { state: "partial", artifacts: { skill: { state: "current" }, agentsPolicy: { state: "absent" } } },
    });
    expect(readFileSync(fx.skillPath, "utf8")).toBe(renderCodexDelegationBundle("balanced").skillText);
    expect(existsSync(fx.agentsPath)).toBe(false);
  });

  test("a DelegationFsError after unlink reports a published partial write", () => {
    const fx = fixture();
    mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    const deps = {
      ...fx.deps,
      afterPublish: (artifact: "skill" | "agents", operation: "write" | "remove") => {
        if (artifact === "skill" && operation === "remove") mkdirSync(fx.skillPath);
      },
    };

    const outcome = mutateCodexDelegation({ action: "uninstall" }, deps);

    expect(outcome).toMatchObject({ ok: false, changed: true, reason: "partial_write" });
    expect(lstatSync(fx.skillPath).isDirectory()).toBe(true);
    expect(readFileSync(fx.agentsPath, "utf8")).toBe("");
  });

  test("an arbitrary error after unlink reports a published partial write", () => {
    const fx = fixture();
    mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    const deps = {
      ...fx.deps,
      afterPublish: (artifact: "skill" | "agents", operation: "write" | "remove") => {
        if (artifact === "skill" && operation === "remove") throw new Error("post-unlink verification failure");
      },
    };

    const outcome = mutateCodexDelegation({ action: "uninstall" }, deps);

    expect(outcome).toMatchObject({
      ok: false,
      changed: true,
      reason: "partial_write",
      status: { state: "not-installed", artifacts: { skill: { state: "absent" }, agentsPolicy: { state: "absent" } } },
    });
    expect(existsSync(fx.skillPath)).toBe(false);
    expect(readFileSync(fx.agentsPath, "utf8")).toBe("");
  });

  test("active AGENTS.override.md reports shadowed without changing override bytes", () => {
    const fx = fixture();
    const override = Buffer.from("# local override\r\nDo not delegate.\r\n");
    write(fx.overridePath, override);
    const outcome = mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    expect(outcome).toMatchObject({ ok: true, status: { state: "current", activation: "shadowed", override: { state: "active" } } });
    expect(readFileSync(fx.overridePath)).toEqual(override);
  });

  test("unsafe AGENTS.override.md retains structural status and reports unknown activation", () => {
    const fx = fixture();
    mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    const target = join(fx.root, "foreign-override");
    write(target, "foreign");
    symlinkSync(target, fx.overridePath);

    expect(inspectCodexDelegation(fx.deps)).toMatchObject({
      state: "current",
      artifacts: { skill: { state: "current" }, agentsPolicy: { state: "current" } },
      override: { state: "unsafe" },
      activation: "unknown",
    });
  });

  test("config.toml and subagentDeveloperInstructions are identical before and after every mutation", () => {
    const fx = fixture();
    const config = Buffer.from('model = "native"\nsubagentDeveloperInstructions = "user-owned"\n');
    write(fx.configPath, config);
    for (const mutation of [
      { action: "install", mode: "balanced" },
      { action: "install", mode: "orchestrator" },
      { action: "uninstall" },
    ] as const) {
      mutateCodexDelegation(mutation, fx.deps);
      expect(readFileSync(fx.configPath)).toEqual(config);
    }
  });

  test("no .codexcommander-managed file hash manifest or lock is created", () => {
    const fx = fixture();
    mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    mutateCodexDelegation({ action: "install", mode: "orchestrator" }, fx.deps);
    mutateCodexDelegation({ action: "uninstall" }, fx.deps);
    assertNoManagementResidue(fx);
  });

  test("module-local single-flight refuses a reentrant mutation", () => {
    const fx = fixture();
    let nested: ReturnType<typeof mutateCodexDelegation> | undefined;
    const outer = mutateCodexDelegation({ action: "install", mode: "balanced" }, {
      ...fx.deps,
      beforePublish: (artifact) => {
        if (artifact === "skill" && nested === undefined) nested = mutateCodexDelegation({ action: "uninstall" }, fx.deps);
      },
    });
    expect(outer.ok).toBe(true);
    expect(nested).toMatchObject({ ok: false, changed: false, reason: "mutation_busy" });
  });

  test("existing AGENTS mode is preserved", () => {
    if (process.platform === "win32") return;
    const fx = fixture();
    write(fx.agentsPath, "preface\n");
    chmodSync(fx.agentsPath, 0o640);
    mutateCodexDelegation({ action: "install", mode: "balanced" }, fx.deps);
    expect(lstatSync(fx.agentsPath).mode & 0o777).toBe(0o640);
  });
});

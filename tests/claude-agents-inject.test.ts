import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeAgentDefs, injectClaudeAgentDefs, syncClaudeAgentDefs } from "../src/claude/agents-inject";
import { buildClaudeContextWindows } from "../src/claude/context-windows";
import { fetchProviderModels } from "../src/codex/catalog/provider-fetch";
import { OAUTH_PROVIDERS } from "../src/oauth";
import type { CodexCommanderConfig } from "../src/types";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ccx-agents-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function cfg(extra?: Partial<CodexCommanderConfig>): CodexCommanderConfig {
  return { port: 10100, defaultProvider: "mock", providers: {}, ...extra } as CodexCommanderConfig;
}

function generatedBodies(config: CodexCommanderConfig, dir: string): string[] {
  const defs = buildClaudeAgentDefs(config, {}, dir);
  syncClaudeAgentDefs(defs, dir);
  return defs.map(def => readFileSync(join(dir, "agents", def.file), "utf8"));
}

describe("buildClaudeAgentDefs (implementation contract + audit 071)", () => {
  test("roster + pinned self mark only authoritative 1M windows; name collision suffix", () => {
    const windows = { "claude-ccx2-native--gpt-5.6-sol": 372_000, "claude-ccx2-cursor--gpt-5.6-sol": 1_000_000 };
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ccx2-native--gpt-5.6-sol[1m]" }));
    const defs = buildClaudeAgentDefs(cfg({
      subagentModels: ["gpt-5.6-sol", "cursor/gpt-5.6-sol"],
      claudeCode: { autoContext: true },
    }), windows, dir);
    const byName = Object.fromEntries(defs.map(d => [d.name, d]));
    // 372K >= 350K compact default marks the MAIN session (env slots pair with the
    // compact window), but a generated subagent has no such pairing — it stays bare.
    expect(byName["ccx-gpt-5-6-sol"]!.model).toBe("claude-ccx2-native--gpt-5.6-sol");
    expect(byName["ccx-gpt-5-6-sol-2"]!.model).toBe("claude-ccx2-cursor--gpt-5.6-sol[1m]"); // collision suffix
    // Self pins the picker-saved default but cannot inherit an unsafe auto-context marker.
    expect(byName["ccx-self"]!.model).toBe("claude-ccx2-native--gpt-5.6-sol");
    expect(defs).toHaveLength(3);
    // Dispatcher directive (live repro: model:"fable" override broke inherit).
    for (const d of defs) expect(d.description).toContain("`model` argument is ignored");
  });

  test("generated profiles retain catalog-derived 1M markers for Claude 4.6 and 4.7", async () => {
    const anthropic = structuredClone(OAUTH_PROVIDERS.anthropic.providerConfig);
    anthropic.liveModels = false;
    const config = cfg({
      defaultProvider: "anthropic",
      providers: { anthropic },
      subagentModels: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6", "anthropic/claude-opus-4-7"],
    });
    const catalog = await fetchProviderModels("anthropic", anthropic, 0);
    const windows = buildClaudeContextWindows([], catalog);
    const defs = buildClaudeAgentDefs(config, windows, tempDir());
    const models = Object.fromEntries(defs.map(def => [def.name, def.model]));

    expect(models).toEqual({
      "ccx-claude-sonnet-4-6": "claude-sonnet-4-6[1m]",
      "ccx-claude-opus-4-6": "claude-opus-4-6[1m]",
      "ccx-claude-opus-4-7": "claude-opus-4-7[1m]",
    });
  });

  test("routed roster entries require the canonical one-slash selector", () => {
    const config = cfg({
      providers: {
        nested: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          models: ["vendor/model"],
        },
      },
      subagentModels: ["nested/vendor-model", "nested/vendor/model"],
    });
    const defs = buildClaudeAgentDefs(config, {}, tempDir());
    expect(defs).toHaveLength(1);
    expect(defs[0]!.model).toBe("claude-ccx2-nested--vendor~smodel");
  });

  test("generated profiles preserve genuine routed [1m] ids and honor provider caps", async () => {
    const kimi = structuredClone(OAUTH_PROVIDERS.kimi.providerConfig);
    kimi.liveModels = false;
    const config = cfg({
      defaultProvider: "kimi",
      providers: { kimi },
      subagentModels: ["kimi/k3[1m]"],
    });
    const catalog = await fetchProviderModels("kimi", kimi, 0);
    const windows = buildClaudeContextWindows([], catalog);
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ccx2-kimi--k3[1m]" }));
    const defs = buildClaudeAgentDefs(config, windows, dir);
    const models = Object.fromEntries(defs.map(def => [def.name, def.model]));

    expect(windows["claude-ccx2-kimi--k3"]).toBe(1_048_576);
    expect(windows["claude-ccx2-kimi--k3[1m]"]).toBe(1_048_576);
    expect(windows["claude-ccx2-kimi--k3-256k"]).toBe(262_144);
    expect(models).toEqual({
      "ccx-k3-1m": "claude-ccx2-kimi--k3[1m]",
      "ccx-self": "claude-ccx2-kimi--k3[1m]",
    });

    // A provider cap below 1M unmarks the same selector.
    const cappedCatalog = await fetchProviderModels("kimi", kimi, 0, 350_000);
    const cappedWindows = buildClaudeContextWindows([], cappedCatalog);
    const cappedDir = tempDir();
    writeFileSync(join(cappedDir, "settings.json"), JSON.stringify({ model: "claude-ccx2-kimi--k3[1m]" }));
    const cappedDefs = buildClaudeAgentDefs(config, cappedWindows, cappedDir);

    expect(cappedWindows["claude-ccx2-kimi--k3[1m]"]).toBe(350_000);
    expect(Object.fromEntries(cappedDefs.map(def => [def.name, def.model]))).toEqual({
      "ccx-k3-1m": "claude-ccx2-kimi--k3",
      "ccx-self": "claude-ccx2-kimi--k3",
    });
  });

  test("marker case is honored and unknown windows keep the selector as-was", () => {
    const windows = { "claude-ccx2-cursor--gpt-5.6-sol": 1_000_000 };
    const dir = tempDir();
    // Uppercase [1M] spelling is a genuine marker (the CLI matches /\[1m\]/i).
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ccx2-cursor--gpt-5.6-sol[1M]" }));
    const defs = buildClaudeAgentDefs(cfg({ subagentModels: ["cursor/gpt-5.6-sol", "cursor/unknown-model"] }), windows, dir);
    const byName = Object.fromEntries(defs.map(d => [d.name, d]));
    expect(byName["ccx-gpt-5-6-sol"]!.model).toBe("claude-ccx2-cursor--gpt-5.6-sol[1m]");
    // Incomplete metadata: no window entry -> selector preserved, never unmarked.
    expect(byName["ccx-unknown-model"]!.model).toBe("claude-ccx2-cursor--unknown-model");
    expect(byName["ccx-self"]!.model).toBe("claude-ccx2-cursor--gpt-5.6-sol[1M]");
  });

  test("placeholder guidance recommends haiku, never sonnet (issue #252)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ccx2-native--gpt-5.6-sol" }));
    const defs = buildClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) {
      // A sonnet-labeled placeholder is indistinguishable from a genuine Sonnet
      // call in the Claude Code UI; guidance must steer to the haiku placeholder.
      expect(d.description).toContain('model: "haiku"');
      expect(d.description).not.toContain('model: "sonnet"');
    }
  });

  test("unset roster seeds the defaults; explicit [] respected; no picker default -> no self", () => {
    const dir = tempDir();
    const seeded = buildClaudeAgentDefs(cfg(), {}, dir);
    expect(seeded.length).toBe(5); // 5 defaults, no self (unresolvable)
    const explicit = buildClaudeAgentDefs(cfg({ subagentModels: [] }), {}, dir);
    expect(explicit).toEqual([]);
  });

  test("rendered frontmatter quotes every scalar and parses back", () => {
    const dir = tempDir();
    const [def] = buildClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    syncClaudeAgentDefs([def!], dir);
    const body = readFileSync(join(dir, "agents", def!.file), "utf8");
    const fm = body.split("---")[1]!;
    const fields: Record<string, string> = {};
    for (const line of fm.trim().split("\n")) {
      const idx = line.indexOf(": ");
      fields[line.slice(0, idx)] = JSON.parse(line.slice(idx + 2));
    }
    expect(fields.name).toBe(def!.name);
    expect(fields.model).toBe(def!.model);
    expect(fields.effort).toBeUndefined();
    expect(typeof fields.description).toBe("string");
    expect(body).toContain("generated-by: codexcommander");
    expect(body).toContain(`ccx-route: ${def!.model}`);
    expect(body).toContain("IDENTITY: your ACTUAL underlying model");
  });

  test("configured Claude Code subagent effort is rendered for roster and self definitions", () => {
    const levels = ["low", "medium", "high", "xhigh", "max"] as const;
    for (const effort of levels) {
      const dir = tempDir();
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ccx2-native--gpt-5.6-sol" }));
      const defs = buildClaudeAgentDefs(cfg({
        subagentModels: ["gpt-5.6-sol"],
        claudeCode: { subagentEffort: effort },
      }), {}, dir);
      expect(defs).toHaveLength(2);
      expect(defs.every(def => def.effort === effort)).toBe(true);
      syncClaudeAgentDefs(defs, dir);
      for (const def of defs) {
        const body = readFileSync(join(dir, "agents", def.file), "utf8");
        expect(body.match(new RegExp(`^effort: ${JSON.stringify(effort)}$`, "gm"))).toHaveLength(1);
        expect(body).toContain(`<!-- ccx-effort: ${effort} -->`);
      }
    }
  });

  test("regeneration removes a previously configured effort when the option is cleared", () => {
    const dir = tempDir();
    const configured = cfg({ subagentModels: ["gpt-5.6-sol"], claudeCode: { subagentEffort: "max" } });
    injectClaudeAgentDefs(configured, {}, dir);
    const target = join(dir, "agents", "ccx-gpt-5-6-sol.md");
    expect(readFileSync(target, "utf8")).toContain('effort: "max"');

    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    expect(readFileSync(target, "utf8")).not.toContain("effort:");
  });

  test("generated routed agents refuse the default blocked skill before its bundle expands", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ccx2-native--gpt-5.6-sol" }));
    const bodies = generatedBodies(cfg({ subagentModels: ["gpt-5.6-sol"] }), dir);
    expect(bodies).toHaveLength(2); // roster + ccx-self
    for (const body of bodies) {
      expect(body).toContain("Do not invoke blocked Claude Code skills");
      expect(body).toContain(JSON.stringify("claude-api"));
    }
  });

  test("generated blocked-skill guard mirrors custom names and honors explicit opt-out", () => {
    const customDir = tempDir();
    writeFileSync(join(customDir, "settings.json"), JSON.stringify({ model: "claude-ccx2-native--gpt-5.6-sol" }));
    const customBodies = generatedBodies(cfg({
      subagentModels: ["gpt-5.6-sol"],
      claudeCode: { blockedSkills: [" My-Skill "] },
    }), customDir);
    expect(customBodies).toHaveLength(2);
    for (const body of customBodies) {
      expect(body).toContain("Do not invoke blocked Claude Code skills");
      expect(body).toContain(JSON.stringify("my-skill"));
      expect(body).not.toContain(JSON.stringify("claude-api"));
    }

    const offDir = tempDir();
    writeFileSync(join(offDir, "settings.json"), JSON.stringify({ model: "claude-ccx2-native--gpt-5.6-sol" }));
    const offBodies = generatedBodies(cfg({
      subagentModels: ["gpt-5.6-sol"],
      claudeCode: { blockedSkills: [] },
    }), offDir);
    expect(offBodies).toHaveLength(2);
    for (const body of offBodies) expect(body).not.toContain("Do not invoke blocked Claude Code skills");
  });

  test("blocked-skill names cannot inject Markdown structure into generated agents", () => {
    const dir = tempDir();
    const hostile = "My\"\n```<!-- injected -->`";
    const [body] = generatedBodies(cfg({
      subagentModels: ["gpt-5.6-sol"],
      claudeCode: { blockedSkills: [hostile] },
    }), dir);
    expect(body).toContain("\"my\\\"\\n\\u0060\\u0060\\u0060\\u003c!-- injected --\\u003e\\u0060\"");
    expect(body).not.toContain(hostile.toLowerCase());
  });

  test("native Claude self keeps skills; a modelMap-claimed Claude self gets the routed guard", () => {
    const nativeDir = tempDir();
    writeFileSync(join(nativeDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-5" }));
    const [nativeBody] = generatedBodies(cfg({ subagentModels: [] }), nativeDir);
    expect(nativeBody).not.toContain("Do not invoke blocked Claude Code skills");

    const routedDir = tempDir();
    writeFileSync(join(routedDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-5" }));
    const [routedBody] = generatedBodies(cfg({
      subagentModels: [],
      claudeCode: { modelMap: { "claude-sonnet-5": "anthropic/claude-sonnet-5" } },
    }), routedDir);
    expect(routedBody).toContain("Do not invoke blocked Claude Code skills");
  });

  test("direct provider self and disabled native passthrough keep the routed guard", () => {
    const directDir = tempDir();
    writeFileSync(join(directDir, "settings.json"), JSON.stringify({ model: "mock/big" }));
    const [directBody] = generatedBodies(cfg({ subagentModels: [] }), directDir);
    expect(directBody).toContain("Do not invoke blocked Claude Code skills");

    const disabledDir = tempDir();
    writeFileSync(join(disabledDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-5" }));
    const [disabledBody] = generatedBodies(cfg({
      subagentModels: [],
      claudeCode: { nativePassthrough: false },
    }), disabledDir);
    expect(disabledBody).toContain("Do not invoke blocked Claude Code skills");
  });
});

describe("syncClaudeAgentDefs ownership contract (audit 071 #2/#3)", () => {
  test("writes, overwrites, and prunes ONLY marker-verified ccx files", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ccx2-native--gpt-5.6-sol" }));
    const defs = buildClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    expect(syncClaudeAgentDefs(defs, dir)!.length).toBe(2);
    const agentsDir = join(dir, "agents");
    // User-authored file with our prefix but no marker: untouched by prune AND by write.
    writeFileSync(join(agentsDir, "ccx-custom.md"), "---\nname: ccx-custom\n---\nuser file");
    writeFileSync(join(agentsDir, "ccx-gpt-5-6-sol.md"), "user replaced this — no marker");
    const second = syncClaudeAgentDefs(buildClaudeAgentDefs(cfg({ subagentModels: [] }), {}, dir), dir)!;
    expect(second).toEqual(["ccx-self.md"]);
    const remaining = readdirSync(agentsDir).sort();
    // ccx-self rewritten; unowned ccx-custom + user-replaced sol file both preserved;
    // no extra generated files remain.
    expect(remaining).toEqual(["ccx-self.md", "ccx-custom.md", "ccx-gpt-5-6-sol.md"].sort());
    expect(readFileSync(join(agentsDir, "ccx-gpt-5-6-sol.md"), "utf8")).toBe("user replaced this — no marker");
  });

  // Capability probe: Windows without elevated symlink rights throws EPERM. Detect once
  // so the test reports a visible skip instead of a silent pass-shaped early return.
  const canSymlink = (() => {
    const dir = tempDir();
    try {
      symlinkSync(join(dir, "probe-target"), join(dir, "probe-link"));
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
      throw e;
    }
  })();

  test.skipIf(!canSymlink)("symlinks are never followed or pruned", () => {
    const dir = tempDir();
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    const victim = join(dir, "victim.md");
    writeFileSync(victim, "precious");
    try {
      symlinkSync(victim, join(agentsDir, "ccx-linked.md"));
    } catch (err) {
      // Windows without Developer Mode / elevated privileges cannot create symlinks.
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw err;
    }
    syncClaudeAgentDefs([], dir); // prune pass
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(readdirSync(agentsDir)).toContain("ccx-linked.md");
  });

  test("injectClaudeAgentDefs prunes owned files when disabled (audit 071 #3)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ccx2-native--gpt-5.6-sol" }));
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    expect(readdirSync(join(dir, "agents")).length).toBe(2);
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"], claudeCode: { injectAgents: false } }), {}, dir);
    expect(readdirSync(join(dir, "agents"))).toEqual([]);
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"], claudeCode: { enabled: false } }), {}, dir);
    expect(readdirSync(join(dir, "agents"))).toEqual([]);
  });
});

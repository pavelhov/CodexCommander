/**
 * Claude Code custom-agent definition injection (implementation contract 070).
 *
 * The Agent tool's `model` argument is a hard 4-alias enum (2.1.207 binary), but an
 * agent DEFINITION's frontmatter `model:` is a free string ("Model alias this agent
 * uses. If omitted, inherits the parent's model"). So we sync the featured
 * subagent roster (config.subagentModels, <=5) plus the main model (when not
 * already covered) into ~/.claude/agents/ccx-*.md — one dispatchable
 * `subagent_type` per routed model, loaded at the next session start.
 *
 * Ownership contract: this module only creates/overwrites/deletes files matching
 * `ccx-*.md` inside the agents dir, and only when the
 * generated-by marker proves we wrote them. User-authored agents are never touched.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexCommanderConfig } from "../types";
import { claudeCodeAlias, claudeCodeNativeAlias } from "./alias";
import { AUTO_CONTEXT_OFF, shouldMarkOneMillion, stripOneMillionMarker, withOneMillionMarker } from "./context-windows";
import { claudeConfigDir } from "./gateway-cache";
import { DEFAULT_SUBAGENT_MODELS, hasOwnProvider } from "../config";
import { effectiveBlockedSkillNames, resolveInboundModel } from "./inbound";
import { knownModelIdsForProvider } from "../router";
import { encodeRoutedModelId } from "../providers/slug-codec";
import { subagentRosterModels } from "../codex/subagent-roster";

export interface ClaudeAgentDef {
  file: string;
  name: string;
  model: string;
  description: string;
  effort?: NonNullable<CodexCommanderConfig["claudeCode"]>["subagentEffort"];
  blockedSkills: readonly string[];
}

const OWNED_PREFIX = "ccx-";
/** Ownership proof (audit 071 #2): a file without this marker is NEVER touched. */
const GENERATED_MARKER = "generated-by: codexcommander";

function sanitizeName(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "model";
}

/**
 * The user's default model as saved by the /model picker (settings.json `model`).
 * `model: "inherit"` in agent frontmatter is DISPROVEN on 2.1.207 (live: a
 * no-model ccx-self dispatch fell back to claude-fable-5 — implementation contract), so the
 * self-clone pins this value instead, refreshed at every launch-time sync.
 */
function pickerDefaultModel(configDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as Record<string, unknown>;
    return typeof parsed.model === "string" && parsed.model.trim() !== "" ? parsed.model.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Roster entry -> alias + display parts. Routed entries use the canonical
 * one-slash Codex selector (`provider/encoded-model-id`).
 */

/**
 * Generated subagent defs cannot rely on the parent's auto-context compaction
 * pairing, so their [1m] marker follows the AUTHORITATIVE window only: mark when
 * the effective window (exact selector, then the canonical [1m] form, then bare)
 * is genuinely >= 1M; strip an inherited unsafe marker back to the bare selector;
 * with no window information, keep the selector as it was. Genuine routed [1m]
 * ids are preserved through the canonical-exact lookup. (#854)
 */
function withSubagentContextMarker(selector: string, windows: Record<string, number>): string {
  const bare = stripOneMillionMarker(selector);
  const wasMarked = selector !== bare;
  const canonicalExact = wasMarked ? `${bare}[1m]` : selector;
  const authoritativeWindow = windows[selector] ?? windows[canonicalExact] ?? windows[bare];
  if (typeof authoritativeWindow === "number" && authoritativeWindow > 0) {
    return shouldMarkOneMillion(authoritativeWindow, AUTO_CONTEXT_OFF)
      ? (withOneMillionMarker(selector, windows) ?? selector)
      : bare;
  }
  return wasMarked ? selector : bare;
}
function entryParts(entry: string, config: CodexCommanderConfig): { alias: string; id: string; provider: string } | null {
  const slash = entry.indexOf("/");
  if (slash > 0) {
    const provider = entry.slice(0, slash);
    const selector = entry.slice(slash + 1);
    if (!selector || selector.includes("/")) return null;
    const prov = hasOwnProvider(config.providers, provider) ? config.providers[provider] : undefined;
    const matches = prov
      ? [...knownModelIdsForProvider(provider, prov)].filter(id => encodeRoutedModelId(id) === selector)
      : [];
    if (matches.length > 1) return null;
    const id = matches[0] ?? selector;
    return { alias: claudeCodeAlias(provider, id), id, provider };
  }
  return { alias: claudeCodeNativeAlias(entry), id: entry, provider: "native" };
}

export function buildClaudeAgentDefs(config: CodexCommanderConfig, windows: Record<string, number>, configDir = claudeConfigDir()): ClaudeAgentDef[] {
  const blockedSkills = effectiveBlockedSkillNames(config.claudeCode);
  const blockedSkillsFor = (model: string): readonly string[] => {
    const unmarked = stripOneMillionMarker(model);
    const nativePassthrough = config.claudeCode?.nativePassthrough !== false
      && !unmarked.includes("/")
      && /^(claude|anthropic)(?:-|$)/i.test(unmarked)
      && resolveInboundModel(unmarked, config.claudeCode) === unmarked;
    return nativePassthrough ? [] : blockedSkills;
  };
  const defs: ClaudeAgentDef[] = [];
  const usedNames = new Set<string>();
  const coveredModels = new Set<string>();

  const push = (name: string, alias: string, description: string) => {
    // Generated defs mark [1m] on the authoritative window only — never the
    // main-session auto-context predicate (a 372K route marked [1m] would be
    // accounted at 1M with no compaction safety net in the subagent).
    const model = withSubagentContextMarker(alias, windows);
    const bare = alias.toLowerCase();
    if (coveredModels.has(bare)) return;
    coveredModels.add(bare);
    let unique = name;
    for (let i = 2; usedNames.has(unique); i++) unique = `${name}-${i}`;
    usedNames.add(unique);
    defs.push({
      file: `${OWNED_PREFIX}${unique}.md`,
      name: `${OWNED_PREFIX}${unique}`,
      model,
      description,
      effort: config.claudeCode?.subagentEffort,
      blockedSkills: blockedSkillsFor(model),
    });
  };

  // Default roster applies only when the field is UNSET — an explicit [] is
  // respected (audit 071 #6: an upgraded config must not lose the default five).
  const roster = config.subagentModels === undefined
    ? DEFAULT_SUBAGENT_MODELS
    : subagentRosterModels(config.subagentModels);
  for (const entry of roster.slice(0, 5)) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    const parts = entryParts(entry.trim(), config);
    if (!parts) continue;
    const { alias, id, provider } = parts;
    push(sanitizeName(id), alias, `Delegate work to ${id} (${provider}) via CodexCommander routing. General-purpose worker/explorer on that model. ${NO_MODEL_ARG}`);
  }

  // Self-clone slot: pin the picker-saved default (settings.json). `inherit` is
  // NOT honored by 2.1.207 (live-disproven, implementation contract); a session
  // started with a divergent --model stays divergent until the next launch sync.
  // No resolvable picker default means no self definition.
  const selfModel = pickerDefaultModel(configDir);
  if (selfModel) {
    const marked = withSubagentContextMarker(selfModel, windows);
    defs.push({
      file: `${OWNED_PREFIX}self.md`,
      name: `${OWNED_PREFIX}self`,
      model: marked,
      description: `Self-clone: delegate to your default main model (${marked}), synced from the /model picker at launch. ${NO_MODEL_ARG}`,
      effort: config.claudeCode?.subagentEffort,
      blockedSkills: blockedSkillsFor(marked),
    });
  }
  return defs;
}

function skillNameLiteral(name: string): string {
  return JSON.stringify(name)
    .replaceAll("`", "\\u0060")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function renderAgentDef(def: ClaudeAgentDef): string {
  const blockedSkillGuard = def.blockedSkills.length === 0 ? [] : [
    "",
    `Do not invoke blocked Claude Code skills: ${def.blockedSkills.map(skillNameLiteral).join(", ")}.`,
    "Their document bundles are intentionally omitted for routed models; continue without loading them.",
  ];
  // YAML frontmatter: model ids carry dots/brackets — always double-quote scalars.
  return [
    "---",
    `name: ${JSON.stringify(def.name)}`,
    `description: ${JSON.stringify(def.description)}`,
    `model: ${JSON.stringify(def.model)}`,
    ...(def.effort ? [`effort: ${JSON.stringify(def.effort)}`] : []),
    "---",
    "",
    `<!-- ${GENERATED_MARKER} -->`,
    // Proxy routing directive (implementation contract): 2.1.207 does not honor custom gateway
    // ids in agent frontmatter (falls back to sonnet — live-proven), but the agent
    // BODY rides the subagent's system prompt verbatim. The proxy detects this
    // directive and overrides the request model before routing/passthrough.
    `<!-- ccx-route: ${def.model} -->`,
    ...(def.effort ? [`<!-- ccx-effort: ${def.effort} -->`] : []),
    "",
    `You are a delegated worker running on \`${def.model}\` through the local CodexCommander proxy.`,
    `IDENTITY: your ACTUAL underlying model is \`${def.model}\` — the CodexCommander proxy routes this`,
    "session there regardless of what model name the Claude Code harness displays or claims.",
    "If asked which model you are, answer with the id above; do not guess a Claude model name.",
    ...blockedSkillGuard,
    "",
    "Complete the dispatched task directly and report results concisely. This file is",
    "auto-generated by CodexCommander (`ccx claude`) from the featured subagent roster —",
    "manual edits will be overwritten; remove the model from the roster to drop it.",
    "",
  ].join("\n");
}

/** True only for a REGULAR file we generated (marker present; symlinks never owned). */
function isOwnedFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return false; // symlink or dir: never touch (audit 071 #2)
    const content = readFileSync(path, "utf8");
    return content.includes(GENERATED_MARKER);
  } catch {
    return false;
  }
}

/**
 * Sync owned agent files: write/overwrite current defs and prune stale ccx-*.md,
 * never touch anything else. Ownership requires the generated marker; writes are
 * atomic (tmp + rename). Best-effort — returns null on any failure.
 */
export function syncClaudeAgentDefs(defs: readonly ClaudeAgentDef[], configDir = claudeConfigDir()): string[] | null {
  try {
    const dir = join(configDir, "agents");
    mkdirSync(dir, { recursive: true });
    const keep = new Set(defs.map(d => d.file));
    for (const existing of readdirSync(dir)) {
      if (!existing.endsWith(".md")) continue;
      if (!existing.startsWith(OWNED_PREFIX)) continue;
      if (!keep.has(existing) && isOwnedFile(join(dir, existing))) {
        try { unlinkSync(join(dir, existing)); } catch { /* best-effort prune */ }
      }
    }
    const written: string[] = [];
    for (const def of defs) {
      const target = join(dir, def.file);
      // A pre-existing ccx-* file WITHOUT our marker is user property: skip the def.
      try {
        lstatSync(target);
        if (!isOwnedFile(target)) continue;
      } catch { /* does not exist: ours to create */ }
      const tmp = `${target}.tmp-${process.pid}`;
      writeFileSync(tmp, renderAgentDef(def), { encoding: "utf8", mode: 0o644 });
      renameSync(tmp, target);
      written.push(def.file);
    }
    return written;
  } catch {
    return null;
  }
}

/** Launch-time hook: gate + build + sync in one call (used by ccx claude and systemEnv). */
export function injectClaudeAgentDefs(config: CodexCommanderConfig, windows: Record<string, number>, configDir?: string): string[] | null {
  if (config.claudeCode?.enabled === false || config.claudeCode?.injectAgents === false) {
    // Disabled: prune verified-owned files so stale definitions stop loading
    // in future sessions (audit 071 #3).
    return syncClaudeAgentDefs([], configDir);
  }
  return syncClaudeAgentDefs(buildClaudeAgentDefs(config, windows, configDir), configDir);
}
/**
 * Dispatcher directive appended to every ccx-* description. The ccx-route body
 * directive makes the Agent tool's `model` argument INERT (the proxy overrides
 * the request model before routing — live-proven), so instead of asking the
 * dispatcher to omit it (which caused schema-anxiety loops), we hand it a fixed
 * placeholder: any value works; "haiku" is canonical because a haiku-labeled call
 * is visibly a placeholder in the Claude Code UI, while "sonnet" was
 * indistinguishable from a genuine Sonnet call (issue #252).
 */
const NO_MODEL_ARG = "NOTE: this agent's real model is pinned by the CodexCommander proxy — the `model` argument is ignored. Pass model: \"haiku\" as a placeholder (or omit it); routing is unaffected either way.";

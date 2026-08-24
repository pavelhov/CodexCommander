import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { renameAtomicFile } from "../config";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import {
  inspectDelegationAgentsBlock,
  removeDelegationAgentsBlock,
  upsertDelegationAgentsBlock,
  type DelegationAgentsInspection,
} from "./delegation-agents-block";
import {
  isCodexCommanderManagedSkill,
  renderCodexDelegationBundle,
  type CodexDelegationMode,
} from "./delegation-templates";
import { getCodexHome } from "./paths";

export type DelegationArtifactState = "absent" | "current" | "outdated" | "foreign" | "unsafe";
export type DelegationActivation = "effective" | "shadowed" | "unknown";

export interface DelegationArtifactStatus {
  state: DelegationArtifactState;
  displayPath: "$HOME/.agents/skills/codexcommander-delegation/SKILL.md" | "$CODEX_HOME/AGENTS.md";
  reason?: string;
}

export interface CodexDelegationStatus {
  schemaVersion: 1;
  state: "not-installed" | "current" | "update-available" | "partial" | "conflict" | "unsafe";
  installedMode: CodexDelegationMode | null;
  artifacts: { skill: DelegationArtifactStatus; agentsPolicy: DelegationArtifactStatus };
  override: { state: "absent" | "empty" | "active" | "unsafe" };
  activation: DelegationActivation;
  previews: Record<CodexDelegationMode, { skillText: string; agentsBlockText: string }>;
  copyPrompts: Record<CodexDelegationMode, string>;
}

export type CodexDelegationMutation =
  | { action: "install"; mode: CodexDelegationMode }
  | { action: "uninstall" };

export type CodexDelegationMutationOutcome =
  | { ok: true; changed: boolean; status: CodexDelegationStatus }
  | { ok: false; changed: boolean; reason: MutationFailureReason; status: CodexDelegationStatus };

type MutationFailureReason =
  | "foreign_skill"
  | "ambiguous_agents_markers"
  | "unsafe_path"
  | "unreadable"
  | "invalid_utf8"
  | "too_large"
  | "changed_during_mutation"
  | "mutation_busy"
  | "write_failed"
  | "partial_write";

export interface CodexDelegationInstallerDeps {
  userHome?: string;
  codexHome?: string;
  beforePublish?: (artifact: "skill" | "agents") => void;
}

const SKILL_LIMIT = 256 * 1024;
const AGENTS_LIMIT = 1024 * 1024;
const SKILL_DISPLAY = "$HOME/.agents/skills/codexcommander-delegation/SKILL.md" as const;
const AGENTS_DISPLAY = "$CODEX_HOME/AGENTS.md" as const;
let mutationInProgress = false;
let tempSequence = 0;

class DelegationFsError extends Error {
  constructor(readonly reason: MutationFailureReason, message: string, readonly published = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "DelegationFsError";
  }
}

interface Paths {
  userHome: string;
  codexHome: string;
  skillDir: string;
  skillPath: string;
  compatibilitySkillPath: string;
  agentsPath: string;
  overridePath: string;
}

interface FileSnapshotAbsent { kind: "absent" }
interface FileSnapshotPresent {
  kind: "file";
  bytes: Buffer;
  text: string;
  stat: BigIntStats;
}
type FileSnapshot = FileSnapshotAbsent | FileSnapshotPresent;

interface InspectionContext {
  paths: Paths;
  skill: FileSnapshot;
  agents: FileSnapshot;
  agentsInspection: DelegationAgentsInspection;
  status: CodexDelegationStatus;
}

interface AppliedMutation {
  artifact: "skill" | "agents";
  path: string;
  before: FileSnapshot;
  after: FileSnapshot;
}

const ABSENT: FileSnapshotAbsent = { kind: "absent" };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string): string => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(left) === normalize(right);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory() && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode;
}

function sameDirectoryObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory() && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

function containedBy(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function classifyIoError(error: unknown): DelegationFsError {
  if (error instanceof DelegationFsError) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") return new DelegationFsError("unreadable", "delegation path is unreadable", false, { cause: error });
  return new DelegationFsError("unsafe_path", "delegation path could not be inspected safely", false, { cause: error });
}

function canonicalRoot(input: string, label: string): string {
  try {
    const absolute = resolve(input);
    const entry = lstatSync(absolute, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new DelegationFsError("unsafe_path", `${label} is not a physical directory`);
    return realpathSync.native(absolute);
  } catch (error) {
    throw classifyIoError(error);
  }
}

function resolvePaths(deps: CodexDelegationInstallerDeps): Paths {
  const userHome = canonicalRoot(deps.userHome ?? homedir(), "user home");
  const codexHome = canonicalRoot(deps.codexHome ?? getCodexHome(), "Codex home");
  const skillDir = join(userHome, ".agents", "skills", "codexcommander-delegation");
  return {
    userHome,
    codexHome,
    skillDir,
    skillPath: join(skillDir, "SKILL.md"),
    compatibilitySkillPath: join(codexHome, "skills", "codexcommander-delegation", "SKILL.md"),
    agentsPath: join(codexHome, "AGENTS.md"),
    overridePath: join(codexHome, "AGENTS.override.md"),
  };
}

function assertCanonicalRoot(root: string): void {
  let before: BigIntStats;
  try { before = lstatSync(root, { bigint: true }); } catch (error) { throw classifyIoError(error); }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new DelegationFsError("unsafe_path", "delegation root is not a physical directory");
  }
  let physical: string;
  try { physical = realpathSync.native(root); } catch (error) { throw classifyIoError(error); }
  if (!samePath(physical, root)) throw new DelegationFsError("unsafe_path", "delegation root contains a reparse substitution");
  const after = lstatSync(root, { bigint: true });
  if (!sameDirectoryIdentity(before, after)) throw new DelegationFsError("changed_during_mutation", "delegation root changed during inspection");
}

function assertSafeExistingDirectories(root: string, targetParent: string): void {
  assertCanonicalRoot(root);
  if (!containedBy(root, targetParent)) throw new DelegationFsError("unsafe_path", "delegation target escaped its fixed root");
  const rel = relative(root, targetParent);
  let current = root;
  for (const segment of rel === "" ? [] : rel.split(sep)) {
    current = join(current, segment);
    let entry: BigIntStats;
    try {
      entry = lstatSync(current, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw classifyIoError(error);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new DelegationFsError("unsafe_path", "delegation path contains a linked or non-directory descendant");
    }
    let physical: string;
    try { physical = realpathSync.native(current); } catch (error) { throw classifyIoError(error); }
    if (!samePath(physical, current)) throw new DelegationFsError("unsafe_path", "delegation path contains a reparse descendant");
    const after = lstatSync(current, { bigint: true });
    if (!sameDirectoryIdentity(entry, after)) throw new DelegationFsError("changed_during_mutation", "delegation directory changed during inspection");
  }
}

function ensureSafeParent(root: string, targetParent: string): void {
  assertCanonicalRoot(root);
  if (!containedBy(root, targetParent)) throw new DelegationFsError("unsafe_path", "delegation target escaped its fixed root");
  const rel = relative(root, targetParent);
  let current = root;
  for (const segment of rel === "" ? [] : rel.split(sep)) {
    current = join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw classifyIoError(error);
    }
    let entry: BigIntStats;
    try { entry = lstatSync(current, { bigint: true }); } catch (error) { throw classifyIoError(error); }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new DelegationFsError("unsafe_path", "delegation path contains a linked or non-directory descendant");
    }
    let physical: string;
    try { physical = realpathSync.native(current); } catch (error) { throw classifyIoError(error); }
    if (!samePath(physical, current)) throw new DelegationFsError("unsafe_path", "delegation path contains a reparse descendant");
    const after = lstatSync(current, { bigint: true });
    if (!sameDirectoryIdentity(entry, after)) throw new DelegationFsError("changed_during_mutation", "delegation directory changed during creation");
  }
}

function readSnapshot(root: string, path: string, limit: number): FileSnapshot {
  assertSafeExistingDirectories(root, dirname(path));
  let pathStat: BigIntStats;
  try {
    pathStat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return ABSENT;
    throw classifyIoError(error);
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n) {
    throw new DelegationFsError("unsafe_path", "delegation leaf is not a regular single-link file");
  }
  if (pathStat.size > BigInt(limit)) throw new DelegationFsError("too_large", "delegation file exceeds its read bound");

  let descriptor: number | null = null;
  try {
    const flags = process.platform === "win32" ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
    descriptor = openSync(path, flags);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
      throw new DelegationFsError("unsafe_path", "delegation leaf changed while it was opened");
    }
    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset > limit) throw new DelegationFsError("too_large", "delegation file exceeds its read bound");
    const after = lstatSync(path, { bigint: true });
    if (!sameIdentity(pathStat, after)) throw new DelegationFsError("changed_during_mutation", "delegation leaf changed while it was read");
    const bytes = Buffer.from(buffer.subarray(0, offset));
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (error) { throw new DelegationFsError("invalid_utf8", "delegation file is not valid UTF-8", false, { cause: error }); }
    return { kind: "file", bytes, text, stat: pathStat };
  } catch (error) {
    throw classifyIoError(error);
  } finally {
    if (descriptor !== null) try { closeSync(descriptor); } catch { /* read result already determined */ }
  }
}

function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  return sameIdentity(left.stat, right.stat) && left.bytes.equals(right.bytes);
}

function contentEquals(snapshot: FileSnapshot, text: string): boolean {
  return snapshot.kind === "file" && snapshot.bytes.equals(Buffer.from(text, "utf8"));
}

function previewsAndPrompts(): Pick<CodexDelegationStatus, "previews" | "copyPrompts"> {
  const balanced = renderCodexDelegationBundle("balanced");
  const orchestrator = renderCodexDelegationBundle("orchestrator");
  return {
    previews: {
      balanced: { skillText: balanced.skillText, agentsBlockText: balanced.agentsBlockText },
      orchestrator: { skillText: orchestrator.skillText, agentsBlockText: orchestrator.agentsBlockText },
    },
    copyPrompts: { balanced: balanced.copyPrompt, orchestrator: orchestrator.copyPrompt },
  };
}

function hasManagedSkillOwnership(content: string): boolean {
  if (isCodexCommanderManagedSkill(content)) return true;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  return frontmatter !== undefined
    && /^name:\s*codexcommander-delegation\s*\r?$/m.test(frontmatter)
    && /^\s{2}managed-by:\s*codexcommander\s*\r?$/m.test(frontmatter);
}

function unsafeStatus(reason: string): CodexDelegationStatus {
  return {
    schemaVersion: 1,
    state: "unsafe",
    installedMode: null,
    artifacts: {
      skill: { state: "unsafe", displayPath: SKILL_DISPLAY, reason },
      agentsPolicy: { state: "unsafe", displayPath: AGENTS_DISPLAY, reason },
    },
    override: { state: "unsafe" },
    activation: "unknown",
    ...previewsAndPrompts(),
  };
}

function buildInspection(deps: CodexDelegationInstallerDeps): InspectionContext {
  const paths = resolvePaths(deps);
  const skill = readSnapshot(paths.userHome, paths.skillPath, SKILL_LIMIT);
  const compatibilitySkill = readSnapshot(paths.codexHome, paths.compatibilitySkillPath, SKILL_LIMIT);
  const agents = readSnapshot(paths.codexHome, paths.agentsPath, AGENTS_LIMIT);
  let overrideState: CodexDelegationStatus["override"]["state"];
  try {
    const override = readSnapshot(paths.codexHome, paths.overridePath, AGENTS_LIMIT);
    overrideState = override.kind === "absent" ? "absent" : override.bytes.length === 0 ? "empty" : "active";
  } catch {
    overrideState = "unsafe";
  }
  const balanced = renderCodexDelegationBundle("balanced");
  const orchestrator = renderCodexDelegationBundle("orchestrator");

  let skillState: DelegationArtifactState;
  let skillReason: string | undefined;
  if (compatibilitySkill.kind === "file") {
    skillState = "foreign";
    skillReason = "same-name skill exists in the compatibility Codex skill root";
  } else if (skill.kind === "absent") {
    skillState = "absent";
  } else if (!hasManagedSkillOwnership(skill.text)) {
    skillState = "foreign";
    skillReason = "skill frontmatter does not prove CodexCommander ownership";
  } else {
    skillState = contentEquals(skill, balanced.skillText) ? "current" : "outdated";
  }

  const agentsInspection = inspectDelegationAgentsBlock(agents.kind === "file" ? agents.text : "");
  let agentsState: DelegationArtifactState;
  let agentsReason: string | undefined;
  if (agentsInspection.kind === "absent") {
    agentsState = "absent";
  } else if (agentsInspection.kind === "conflict") {
    agentsState = "foreign";
    agentsReason = `ambiguous delegation markers: ${agentsInspection.reason}`;
  } else if (agentsInspection.content === balanced.agentsBlockText || agentsInspection.content === orchestrator.agentsBlockText) {
    agentsState = "current";
  } else {
    agentsState = "outdated";
  }

  const installedMode = agentsInspection.kind === "managed" ? agentsInspection.mode : null;
  let state: CodexDelegationStatus["state"];
  if (skillState === "foreign" || agentsState === "foreign") state = "conflict";
  else if (skillState === "absent" && agentsState === "absent") state = "not-installed";
  else if (skillState === "absent" || agentsState === "absent") state = "partial";
  else if (skillState === "current" && agentsState === "current"
    && installedMode !== null
    && (agentsInspection.kind !== "managed" || agentsInspection.content === (installedMode === "balanced" ? balanced.agentsBlockText : orchestrator.agentsBlockText))) {
    state = "current";
  } else state = "update-available";

  const status: CodexDelegationStatus = {
    schemaVersion: 1,
    state,
    installedMode,
    artifacts: {
      skill: { state: skillState, displayPath: SKILL_DISPLAY, ...(skillReason ? { reason: skillReason } : {}) },
      agentsPolicy: { state: agentsState, displayPath: AGENTS_DISPLAY, ...(agentsReason ? { reason: agentsReason } : {}) },
    },
    override: { state: overrideState },
    activation: overrideState === "unsafe" ? "unknown" : overrideState === "active" ? "shadowed" : "effective",
    ...previewsAndPrompts(),
  };
  return { paths, skill, agents, agentsInspection, status };
}

export function inspectCodexDelegation(deps: CodexDelegationInstallerDeps = {}): CodexDelegationStatus {
  try {
    return buildInspection(deps).status;
  } catch (error) {
    const classified = classifyIoError(error);
    return unsafeStatus(classified.reason);
  }
}

function rootForPath(paths: Paths, path: string): string {
  if (containedBy(paths.userHome, path)) return paths.userHome;
  if (containedBy(paths.codexHome, path)) return paths.codexHome;
  throw new DelegationFsError("unsafe_path", "delegation mutation escaped its fixed roots");
}

function safeTempCleanup(path: string | null, identity: { dev: bigint; ino: bigint } | null): void {
  if (path === null || identity === null) return;
  try {
    const current = lstatSync(path, { bigint: true });
    if (current.isFile() && current.nlink === 1n && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
  } catch { /* changed or absent temp paths are not ours to remove */ }
}

function safeWrite(
  paths: Paths,
  path: string,
  expected: FileSnapshot,
  text: string,
  artifact: "skill" | "agents",
  deps: CodexDelegationInstallerDeps,
): FileSnapshotPresent {
  const root = rootForPath(paths, path);
  ensureSafeParent(root, dirname(path));
  const parentBefore = lstatSync(dirname(path), { bigint: true });
  const currentBefore = readSnapshot(root, path, artifact === "skill" ? SKILL_LIMIT : AGENTS_LIMIT);
  if (!snapshotsEqual(expected, currentBefore)) throw new DelegationFsError("changed_during_mutation", "delegation preimage changed before preparation");
  const bytes = Buffer.from(text, "utf8");
  const mode = expected.kind === "file" ? Number(expected.stat.mode & 0o777n) : 0o600;
  const tempPath = join(dirname(path), `.${basename(path)}.ccx.${process.pid}.${++tempSequence}.tmp`);
  let descriptor: number | null = null;
  let tempIdentity: { dev: bigint; ino: bigint } | null = null;
  let parentPrepared: BigIntStats | null = null;
  let published = false;
  try {
    const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
      | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    descriptor = openSync(tempPath, flags, 0o600);
    const created = fstatSync(descriptor, { bigint: true });
    if (!created.isFile() || created.nlink !== 1n) throw new DelegationFsError("unsafe_path", "delegation temp is not a regular single-link file");
    tempIdentity = { dev: created.dev, ino: created.ino };
    writeFileSync(descriptor, bytes);
    try { fchmodSync(descriptor, mode); } catch { if (process.platform !== "win32") throw new DelegationFsError("write_failed", "delegation temp mode could not be preserved"); }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    parentPrepared = lstatSync(dirname(path), { bigint: true });
    if (!sameDirectoryObject(parentBefore, parentPrepared)) {
      throw new DelegationFsError("changed_during_mutation", "delegation parent changed during preparation");
    }

    deps.beforePublish?.(artifact);
    assertSafeExistingDirectories(root, dirname(path));
    const parentNow = lstatSync(dirname(path), { bigint: true });
    if (!sameDirectoryIdentity(parentPrepared, parentNow)) throw new DelegationFsError("changed_during_mutation", "delegation parent changed before publication");
    const current = readSnapshot(root, path, artifact === "skill" ? SKILL_LIMIT : AGENTS_LIMIT);
    if (!snapshotsEqual(expected, current)) throw new DelegationFsError("changed_during_mutation", "delegation preimage changed before publication");
    const temp = readSnapshot(root, tempPath, bytes.length);
    if (temp.kind !== "file" || temp.stat.dev !== tempIdentity.dev || temp.stat.ino !== tempIdentity.ino || !temp.bytes.equals(bytes)) {
      throw new DelegationFsError("changed_during_mutation", "delegation temp changed before publication");
    }
    renameAtomicFile(tempPath, path);
    published = true;
    const after = readSnapshot(root, path, artifact === "skill" ? SKILL_LIMIT : AGENTS_LIMIT);
    if (after.kind !== "file" || after.stat.dev !== tempIdentity.dev || after.stat.ino !== tempIdentity.ino || !after.bytes.equals(bytes)) {
      throw new DelegationFsError("partial_write", "delegation postimage verification failed", true);
    }
    try {
      const parentFd = openSync(dirname(path), "r");
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    } catch { /* not all platforms permit directory fsync */ }
    return after;
  } catch (error) {
    if (error instanceof DelegationFsError) throw error;
    throw new DelegationFsError(published ? "partial_write" : "write_failed", "delegation write failed", published, { cause: error });
  } finally {
    if (descriptor !== null) try { closeSync(descriptor); } catch { /* primary error wins */ }
    safeTempCleanup(tempPath, tempIdentity);
  }
}

function safeRemove(
  paths: Paths,
  path: string,
  expected: FileSnapshotPresent,
  artifact: "skill" | "agents",
  deps: CodexDelegationInstallerDeps,
): FileSnapshotAbsent {
  const root = rootForPath(paths, path);
  const parentBefore = lstatSync(dirname(path), { bigint: true });
  const currentBefore = readSnapshot(root, path, artifact === "skill" ? SKILL_LIMIT : AGENTS_LIMIT);
  if (!snapshotsEqual(expected, currentBefore)) throw new DelegationFsError("changed_during_mutation", "delegation preimage changed before removal");
  let published = false;
  try {
    deps.beforePublish?.(artifact);
    assertSafeExistingDirectories(root, dirname(path));
    const parentNow = lstatSync(dirname(path), { bigint: true });
    if (!sameDirectoryIdentity(parentBefore, parentNow)) throw new DelegationFsError("changed_during_mutation", "delegation parent changed before removal");
    const current = readSnapshot(root, path, artifact === "skill" ? SKILL_LIMIT : AGENTS_LIMIT);
    if (!snapshotsEqual(expected, current)) throw new DelegationFsError("changed_during_mutation", "delegation preimage changed before removal");
    unlinkSync(path);
    published = true;
    if (readSnapshot(root, path, artifact === "skill" ? SKILL_LIMIT : AGENTS_LIMIT).kind !== "absent") {
      throw new DelegationFsError("partial_write", "delegation removal verification failed", true);
    }
    return ABSENT;
  } catch (error) {
    if (error instanceof DelegationFsError) throw error;
    throw new DelegationFsError(published ? "partial_write" : "write_failed", "delegation removal failed", published, { cause: error });
  }
}

function applyDesired(
  context: InspectionContext,
  artifact: "skill" | "agents",
  before: FileSnapshot,
  desired: string | null,
  deps: CodexDelegationInstallerDeps,
): AppliedMutation | null {
  const path = artifact === "skill" ? context.paths.skillPath : context.paths.agentsPath;
  if (desired === null) {
    if (before.kind === "absent") return null;
    return { artifact, path, before, after: safeRemove(context.paths, path, before, artifact, deps) };
  }
  if (contentEquals(before, desired)) return null;
  return { artifact, path, before, after: safeWrite(context.paths, path, before, desired, artifact, deps) };
}

function compensate(context: InspectionContext, applied: AppliedMutation, deps: CodexDelegationInstallerDeps): void {
  if (applied.before.kind === "absent") {
    if (applied.after.kind === "file") safeRemove(context.paths, applied.path, applied.after, applied.artifact, deps);
  } else {
    safeWrite(context.paths, applied.path, applied.after, applied.before.text, applied.artifact, deps);
  }
}

function removeEmptySkillDir(paths: Paths, expected: BigIntStats): void {
  try {
    const entry = lstatSync(paths.skillDir, { bigint: true });
    if (!sameDirectoryObject(expected, entry)
      || entry.isSymbolicLink()
      || !samePath(realpathSync.native(paths.skillDir), paths.skillDir)) {
      throw new DelegationFsError("partial_write", "skill directory became unsafe after uninstall", true);
    }
    const beforeRemove = lstatSync(paths.skillDir, { bigint: true });
    if (!sameDirectoryIdentity(entry, beforeRemove)) {
      throw new DelegationFsError("partial_write", "skill directory changed before uninstall cleanup", true);
    }
    rmdirSync(paths.skillDir);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTEMPTY") return;
    if (error instanceof DelegationFsError) throw error;
    throw new DelegationFsError("partial_write", "skill directory could not be removed safely", true, { cause: error });
  }
}

function failureStatus(deps: CodexDelegationInstallerDeps, fallback: CodexDelegationStatus): CodexDelegationStatus {
  try { return buildInspection(deps).status; } catch { return fallback; }
}

export function mutateCodexDelegation(
  mutation: CodexDelegationMutation,
  deps: CodexDelegationInstallerDeps = {},
): CodexDelegationMutationOutcome {
  if (mutationInProgress) {
    return { ok: false, changed: false, reason: "mutation_busy", status: inspectCodexDelegation(deps) };
  }
  mutationInProgress = true;
  let initialStatus = unsafeStatus("unsafe_path");
  try {
    const paths = resolvePaths(deps);
    assertNotRealHomeUnderTest(paths.skillPath);
    assertNotRealHomeUnderTest(paths.agentsPath);
    const context = buildInspection({ ...deps, userHome: paths.userHome, codexHome: paths.codexHome });
    initialStatus = context.status;
    if (context.status.artifacts.skill.state === "foreign") {
      return { ok: false, changed: false, reason: "foreign_skill", status: context.status };
    }
    if (context.status.artifacts.agentsPolicy.state === "foreign") {
      return { ok: false, changed: false, reason: "ambiguous_agents_markers", status: context.status };
    }

    const skillDirBefore = mutation.action === "uninstall" && context.skill.kind === "file"
      ? lstatSync(context.paths.skillDir, { bigint: true })
      : null;
    let desiredSkill: string | null;
    let desiredAgents: string | null;
    if (mutation.action === "install") {
      const bundle = renderCodexDelegationBundle(mutation.mode);
      desiredSkill = bundle.skillText;
      desiredAgents = upsertDelegationAgentsBlock(context.agents.kind === "file" ? context.agents.text : "", bundle.agentsBlockText).content;
    } else {
      desiredSkill = null;
      desiredAgents = context.agentsInspection.kind === "managed"
        ? removeDelegationAgentsBlock(context.agents.kind === "file" ? context.agents.text : "").content
        : context.agents.kind === "file" ? context.agents.text : null;
    }

    const plan = mutation.action === "install"
      ? [
        { artifact: "skill" as const, before: context.skill, desired: desiredSkill },
        { artifact: "agents" as const, before: context.agents, desired: desiredAgents },
      ]
      : [
        { artifact: "agents" as const, before: context.agents, desired: desiredAgents },
        { artifact: "skill" as const, before: context.skill, desired: desiredSkill },
      ];

    let first: AppliedMutation | null = null;
    let changed = false;
    for (let index = 0; index < plan.length; index += 1) {
      const step = plan[index];
      try {
        const applied = applyDesired(context, step.artifact, step.before, step.desired, deps);
        if (applied === null) continue;
        changed = true;
        if (first === null) first = applied;
      } catch (error) {
        const classified = error instanceof DelegationFsError
          ? error
          : new DelegationFsError("write_failed", "delegation mutation failed", false, { cause: error });
        if (classified.published) {
          return { ok: false, changed: true, reason: "partial_write", status: failureStatus(deps, initialStatus) };
        }
        if (first !== null && index > 0) {
          try {
            compensate(context, first, deps);
            return { ok: false, changed: false, reason: classified.reason, status: failureStatus(deps, initialStatus) };
          } catch {
            return { ok: false, changed: true, reason: "partial_write", status: failureStatus(deps, initialStatus) };
          }
        }
        return { ok: false, changed: false, reason: classified.reason, status: failureStatus(deps, initialStatus) };
      }
    }

    if (mutation.action === "uninstall" && skillDirBefore !== null) removeEmptySkillDir(context.paths, skillDirBefore);
    const status = inspectCodexDelegation(deps);
    if (status.state === "unsafe") return { ok: false, changed, reason: "partial_write", status };
    return { ok: true, changed, status };
  } catch (error) {
    const classified = classifyIoError(error);
    return { ok: false, changed: classified.published, reason: classified.reason, status: failureStatus(deps, initialStatus) };
  } finally {
    mutationInProgress = false;
  }
}

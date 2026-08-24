/**
 * Fail-closed protection for the user's real CodexCommander state home while tests run.
 *
 * A management-route unit test once passed an in-memory fixture config to a handler
 * that persisted it through the process-global writer, replacing a live 41KB,
 * ten-provider `~/.codexcommander/config.json` with an 874-byte fixture on a real machine.
 * Credentials survived only because the store files are separate; the providers were
 * recoverable only because an unrelated backup snapshot happened to exist.
 * This guard exists because tests must never persist fixture data into a live
 * CodexCommander state directory.
 *
 * Two properties matter more than breadth here:
 *
 * 1. It must be INERT in production. Guessing "am I a test?" from ecosystem variables
 *    like NODE_ENV would brick `NODE_ENV=test ccx ...` for a user who did nothing
 *    wrong — worse than the bug it prevents. Arming requires CCX_TEST_HOME_GUARD=1,
 *    which only this repository's test preload sets.
 * 2. It must fail CLOSED for code nobody has written yet. So it denies ONE path — the
 *    captured production home — instead of allow-listing known-good test directories.
 *    An allowlist would have to be opted into, and the test that forgets is exactly
 *    how this incident happened.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

const GUARD_ENV = "CCX_TEST_HOME_GUARD";
/**
 * Set by `scripts/test.ts` to the ORIGINAL home before it hands the child a rewritten
 * HOME. On that path `homedir()` already points at the sandbox by the time this module
 * loads, so the true home is only knowable from this hand-off.
 */
const REAL_HOME_ENV = "CCX_REAL_HOME";

/**
 * Resolve symlinks so two spellings of one location compare equal — macOS hands out
 * `/var/folders/...` whose realpath is `/private/var/folders/...` — and so a path that
 * merely *points* at the protected home cannot slip past a string comparison. A path
 * that does not exist yet canonicalizes through its nearest existing ancestor, which is
 * the common case for a config file about to be created.
 */
function canonicalize(path: string): string {
  let current = resolve(path);
  const unresolved: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...unresolved.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      unresolved.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/**
 * Captured ONCE at module load, before any harness replaces HOME/USERPROFILE. Reading
 * `homedir()` later would return the sandbox and leave the real home unprotected — the
 * guard would be perfectly inverted while its tests still looked green.
 */
const REAL_HOME = process.env[REAL_HOME_ENV]?.trim() || homedir();
const PROTECTED_HOMES = [
  canonicalize(join(REAL_HOME, ".codexcommander")),
  canonicalize(join(REAL_HOME, ".codex")),
  canonicalize(join(REAL_HOME, ".agents")),
] as const;

function isAtOrBelow(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

/** The production home this process protects. Exported for the guard's own tests. */
export function protectedHomeForTests(): string {
  return PROTECTED_HOMES[0];
}

/** Canonical state root protected by the test guard. */
export function protectedHomesForTests(): readonly string[] {
  return PROTECTED_HOMES;
}

export function isTestHomeGuardArmed(): boolean {
  return process.env[GUARD_ENV] === "1";
}

/**
 * Throw when an armed test process is about to write a real CodexCommander home.
 *
 * Call FIRST inside a writer, before any mkdir/chmod/write, so a rejected write leaves
 * nothing behind. Silent no-op when disarmed (production) or when `dir` is any other
 * location, including a suite's own `mkdtemp` fixture — no registration required, which
 * is what keeps the 54 existing suites that write config working untouched.
 */
export function assertNotRealHomeUnderTest(dir: string): void {
  if (!isTestHomeGuardArmed()) return;
  const target = canonicalize(dir);
  if (!PROTECTED_HOMES.some((root) => isAtOrBelow(root, target))) return;
  throw new Error(
    `refusing to write a protected user state home (${target}) from a test process. `
    + "Point the affected home at a temp directory for this test, or inject persistence "
    + "instead of calling the global writer.",
  );
}

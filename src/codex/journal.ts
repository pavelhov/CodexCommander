import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, withConfigMutationLockSync } from "../config";
import { canonicalizeCodexHome } from "./codex-write-lock";
import { hasInjectedCodexRouting } from "./injected-marker";
import { isOwnedProviderId } from "../identity";
import {
  classifyNativeRoutedResidueAfterJournalRestore,
  classifyNativeRoutedResidue,
  classifyNativeRoutedResidueWithoutJournal,
  hasGeneratedCodexProfileRouting,
} from "./native-residue";
import {
  CODEX_HOME,
  CODEX_CONFIG_PATH,
  CODEX_PROFILE_PATH,
  getCodexHome,
} from "./paths";
import { beginCodexCoordinatorRecoveryTransaction } from "./transition-state";
import { resolveEffectiveProjectModelProvider } from "./project-config-warnings";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "./user-identity";

/**
 * Exported so that anything reasoning ABOUT the journal points at the journal.
 *
 * The Codex admission snapshot re-derived this path by hand and got it wrong in
 * both halves — wrong directory and wrong filename — so its "journal identity"
 * watched a file nothing writes. The fixture re-derived it the same wrong way,
 * agreed with the producer, and the pair stayed green. One exported constant
 * removes the opportunity.
 */
export const JOURNAL_PATH = join(CODEX_HOME, "codexcommander-journal.json");

interface Journal {
  version: 1;
  originalConfig: string;
  originalProfile: string | null;
  injectedConfigHash?: string;
  injectedProfileHash?: string | null;
  pid: number;
  timestamp: string;
}

interface RestoreJournalResult {
  configRestored: boolean;
  profileRestored: boolean;
  configChanged: boolean;
  profileChanged: boolean;
  complete: boolean;
}

interface RestoreJournalAttempt {
  readonly result: RestoreJournalResult;
  readonly uncertain: boolean;
}

type AuthorizeJournalMutation = () => boolean;
const authorizeUncoordinatedMutation: AuthorizeJournalMutation = () => true;

interface JournalFileSnapshot {
  readonly content: string;
  readonly journal: Journal;
  readonly stat: Stats;
}

type SurfaceSnapshot =
  | { readonly kind: "absent" }
  | {
      readonly kind: "file";
      readonly content: string;
      readonly entryStat: Stats;
      readonly targetPath: string;
      readonly targetStat: Stats;
      readonly symbolicLink: boolean;
    };

export interface ReconcileJournalOptions {
  /** Test-only race barrier before recovery starts from the captured journal. */
  beforeRecoveryRevalidation?: () => void;
  /** Test-only race barrier immediately before a config recovery mutation. */
  beforeConfigMutationRevalidation?: () => void;
  /** Test-only race barrier immediately before a profile recovery mutation. */
  beforeProfileMutationRevalidation?: () => void;
  /** Test-only race barrier immediately before the final identity revalidation. */
  beforeRetireRevalidation?: () => void;
}

function sha256(content: string | null): string | null {
  return content === null ? null : createHash("sha256").update(content).digest("hex");
}

function validJournalShape(value: unknown): value is Journal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  return journal.version === 1
    && typeof journal.originalConfig === "string"
    && (journal.originalProfile === null || typeof journal.originalProfile === "string")
    && (journal.injectedConfigHash === undefined || typeof journal.injectedConfigHash === "string")
    && (journal.injectedProfileHash === undefined
      || journal.injectedProfileHash === null
      || typeof journal.injectedProfileHash === "string")
    && typeof journal.pid === "number"
    && Number.isSafeInteger(journal.pid)
    && journal.pid > 0
    && typeof journal.timestamp === "string";
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * Stronger than `readJournal`: stale retirement is destructive, so it accepts
 * only one stable regular file with the complete known shape and retains its
 * exact bytes + filesystem identity for the final compare-before-unlink.
 */
function readJournalFileSnapshot(): JournalFileSnapshot | null {
  try {
    const before = lstatSync(JOURNAL_PATH);
    if (!before.isFile()) return null;
    const content = readFileSync(JOURNAL_PATH, "utf-8");
    const after = lstatSync(JOURNAL_PATH);
    if (!sameFileIdentity(before, after)) return null;
    const parsed: unknown = JSON.parse(content);
    if (!validJournalShape(parsed)) return null;
    return { content, journal: parsed, stat: after };
  } catch {
    return null;
  }
}

function sameJournalFile(
  expected: JournalFileSnapshot,
  current: JournalFileSnapshot,
): boolean {
  return expected.content === current.content
    && sameFileIdentity(expected.stat, current.stat);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Stable symlink-aware observation used as the compare-before-mutate witness.
 * Both the directory entry and its canonical target are bound. Recovery later
 * writes the captured target path rather than resolving a potentially replaced
 * link a second time.
 */
function readSurfaceSnapshot(path: string): SurfaceSnapshot | null {
  try {
    const entryBefore = lstatSync(path);
    if (!entryBefore.isFile() && !entryBefore.isSymbolicLink()) return null;
    const symbolicLink = entryBefore.isSymbolicLink();
    // Always canonicalize: the leaf can be regular while CODEX_HOME or another
    // parent component is a symlink, and that parent identity is equally part
    // of the write authority.
    const targetPath = realpathSync.native(path);
    const targetBefore = statSync(targetPath);
    if (!targetBefore.isFile()) return null;
    const content = readFileSync(targetPath, "utf-8");
    const targetAfter = statSync(targetPath);
    const entryAfter = lstatSync(path);
    if (
      !sameFileIdentity(entryBefore, entryAfter)
      || !sameFileIdentity(targetBefore, targetAfter)
      || realpathSync.native(path) !== targetPath
    ) return null;
    return {
      kind: "file",
      content,
      entryStat: entryAfter,
      targetPath,
      targetStat: targetAfter,
      symbolicLink,
    };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "absent" } : null;
  }
}

function sameSurfaceSnapshot(
  expected: SurfaceSnapshot,
  current: SurfaceSnapshot,
): boolean {
  if (expected.kind === "absent" || current.kind === "absent") {
    return expected.kind === current.kind;
  }
  return expected.content === current.content
    && expected.targetPath === current.targetPath
    && expected.symbolicLink === current.symbolicLink
    && sameFileIdentity(expected.entryStat, current.entryStat)
    && sameFileIdentity(expected.targetStat, current.targetStat);
}

function surfaceValue(
  snapshot: SurfaceSnapshot,
  absentValue: "" | null,
): string | null {
  return snapshot.kind === "file" ? snapshot.content : absentValue;
}

function journalOwnerIsProvenDead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM is positive evidence that a process exists but is not signalable.
    // Every error except the platform's explicit "no such process" stays
    // unknown and therefore retains the recovery journal.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function reportJournalRestore(): void {
  console.error("⚠️  A previous Codex session did not shut down cleanly. Codex state was restored from its recovery journal.");
}

function incompleteRecoveryResult(restoredAny: boolean): boolean {
  if (restoredAny) reportJournalRestore();
  return restoredAny;
}

export interface WriteJournalOptions {
  /**
   * The caller's verdict on the config it is about to transform: false when
   * `hasInjectedCodexRouting` matched. This does NOT decide whether the content
   * may be journaled — that is checked below, from the bytes themselves. It only
   * authorizes REPLACING an existing snapshot, which is why omitting it still
   * allows a first snapshot but never an overwrite.
   */
  currentStateIsNative?: boolean;
  /**
   * The exact bytes the caller classified. Journaling these rather than re-reading
   * the file keeps the snapshot and the verdict describing the same content when
   * another process rewrites config.toml mid-flight.
   */
  configContent?: string;
  /** Exact profile preimage captured by the coordinated writer (`null` = absent). */
  profileContent?: string | null;
  /**
   * Intended native postimages. New journals persist these hashes BEFORE the
   * first native write, so a crash never leaves an authority-free recovery
   * record. Omission exists only for reading/writing legacy fixtures.
   */
  intendedPostimage?: {
    config: string;
    profile: string | null;
  };
}

/**
 * Snapshot the pre-injection Codex state.
 *
 * Only native (non-codexcommander-owned) config may be journaled, and native config
 * always supersedes an older snapshot. The first half stops a re-inject from
 * recording codexcommander's own routing as the user's original — which would survive
 * `ccx stop` and make the injection unremovable. The second half is the #477 fix:
 * without it the first snapshot a machine ever takes is the only one it ever has,
 * so an unclean shutdown days later replays a day-one config over the user's
 * plugins, model choice, and trusted projects.
 */
function writeJournalUnlocked(options: WriteJournalOptions): void {
  if (!existsSync(CODEX_CONFIG_PATH)) return;
  const config = options.configContent ?? readFileSync(CODEX_CONFIG_PATH, "utf-8");
  // Ownership is decided HERE, from the bytes about to be journaled — never taken
  // on the caller's word. A caller that says "native" about injected content would
  // otherwise make codexcommander's own routing the user's permanent "original".
  if (hasInjectedCodexRouting(config)) return;
  // The caller's verdict only authorizes REPLACEMENT. It is weaker evidence than
  // the check above (it may describe bytes read a moment earlier), so an
  // unclassified call creates a first snapshot but never overwrites one.
  if (existsSync(JOURNAL_PATH)) {
    // An unreadable, replaced, or unknown journal is authority, not garbage.
    // Never erase it while trying to establish a newer snapshot.
    if (!readJournalFileSnapshot() || options.currentStateIsNative !== true) return;
  }
  const profile = Object.hasOwn(options, "profileContent")
    ? options.profileContent ?? null
    : existsSync(CODEX_PROFILE_PATH)
      ? readFileSync(CODEX_PROFILE_PATH, "utf-8")
      : null;
  const journal: Journal = {
    version: 1,
    originalConfig: Buffer.from(config).toString("base64"),
    originalProfile: profile === null ? null : Buffer.from(profile).toString("base64"),
    ...(options.intendedPostimage
      ? {
          injectedConfigHash: sha256(options.intendedPostimage.config) ?? undefined,
          injectedProfileHash: sha256(options.intendedPostimage.profile),
        }
      : {}),
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
  atomicWriteFile(JOURNAL_PATH, JSON.stringify(journal));
}

export function writeJournal(options: WriteJournalOptions = {}): void {
  withConfigMutationLockSync(() => writeJournalUnlocked(options));
}

const EMPTY_RESTORE: RestoreJournalResult = {
  configRestored: false,
  profileRestored: false,
  configChanged: false,
  profileChanged: false,
  complete: false,
};

function journalAuthorityStillMatches(
  expected: JournalFileSnapshot,
  requireDeadOwner: boolean,
): boolean {
  const current = readJournalFileSnapshot();
  return current !== null
    && sameJournalFile(expected, current)
    && (!requireDeadOwner || journalOwnerIsProvenDead(current.journal.pid));
}

function profileIsLegacyOwned(snapshot: SurfaceSnapshot): boolean {
  return snapshot.kind === "file" && hasGeneratedCodexProfileRouting(snapshot.content);
}

function restoreJournalStateFromSnapshot(
  expected: JournalFileSnapshot,
  options: ReconcileJournalOptions,
  requireDeadOwner: boolean,
  authorizeMutation: AuthorizeJournalMutation,
): RestoreJournalAttempt {
  const journal = expected.journal;
  const configBefore = readSurfaceSnapshot(CODEX_CONFIG_PATH);
  const profileBefore = readSurfaceSnapshot(CODEX_PROFILE_PATH);
  if (!configBefore || !profileBefore) {
    return {
      result: { ...EMPTY_RESTORE, configChanged: true, profileChanged: true },
      uncertain: true,
    };
  }

  const originalConfig = Buffer.from(journal.originalConfig, "base64").toString("utf-8");
  const originalProfile = journal.originalProfile === null
    ? null
    : Buffer.from(journal.originalProfile, "base64").toString("utf-8");
  const currentConfig = surfaceValue(configBefore, "") as string;
  const currentProfile = surfaceValue(profileBefore, null);
  const configAlreadyOriginal = currentConfig === originalConfig;
  const profileAlreadyOriginal = currentProfile === originalProfile;
  const configHasExactPostimage = journal.injectedConfigHash !== undefined
    && sha256(currentConfig) === journal.injectedConfigHash;
  const profileHasExactPostimage = journal.injectedProfileHash !== undefined
    && sha256(currentProfile) === journal.injectedProfileHash;
  // A legacy config.toml is a mixed user/CCX surface: even when routing is
  // recognizable, a post-injection user edit cannot be distinguished from the
  // intended write without the missing hash. Never byte-replay it. The dedicated
  // profile file, by contrast, may recover when its complete generated shape is
  // provably CCX-owned.
  const configMayRestore = configAlreadyOriginal
    || configHasExactPostimage;
  const profileMayRestore = profileAlreadyOriginal
    || profileHasExactPostimage
    || (journal.injectedProfileHash === undefined && profileIsLegacyOwned(profileBefore));

  let configRestored = configAlreadyOriginal;
  let profileRestored = profileAlreadyOriginal;
  let configChanged = !configMayRestore;
  let profileChanged = !profileMayRestore;

  if (!configRestored && configMayRestore) {
    if (!authorizeMutation()) {
      configChanged = true;
      return {
        result: {
          configRestored,
          profileRestored,
          configChanged,
          profileChanged,
          complete: false,
        },
        uncertain: true,
      };
    }
    options.beforeConfigMutationRevalidation?.();
    const current = readSurfaceSnapshot(CODEX_CONFIG_PATH);
    if (
      !current
      || !sameSurfaceSnapshot(configBefore, current)
      || !journalAuthorityStillMatches(expected, requireDeadOwner)
    ) {
      configChanged = true;
      return {
        result: {
          configRestored,
          profileRestored,
          configChanged,
          profileChanged,
          complete: false,
        },
        uncertain: true,
      };
    }
    // Use the target captured by the just-revalidated snapshot. Resolving the
    // logical link again inside the mutation would reopen a link-swap race.
    if (current.kind !== "file") {
      configChanged = true;
      return {
        result: {
          configRestored,
          profileRestored,
          configChanged,
          profileChanged,
          complete: false,
        },
        uncertain: true,
      };
    }
    atomicWriteFile(current.targetPath, originalConfig);
    const written = readSurfaceSnapshot(CODEX_CONFIG_PATH);
    configRestored = written?.kind === "file" && written.content === originalConfig;
    configChanged = !configRestored;
  }

  if (!profileRestored && profileMayRestore) {
    if (!authorizeMutation()) {
      profileChanged = true;
      return {
        result: {
          configRestored,
          profileRestored,
          configChanged,
          profileChanged,
          complete: false,
        },
        uncertain: true,
      };
    }
    options.beforeProfileMutationRevalidation?.();
    const current = readSurfaceSnapshot(CODEX_PROFILE_PATH);
    if (
      !current
      || !sameSurfaceSnapshot(profileBefore, current)
      || !journalAuthorityStillMatches(expected, requireDeadOwner)
    ) {
      profileChanged = true;
      return {
        result: {
          configRestored,
          profileRestored,
          configChanged,
          profileChanged,
          complete: false,
        },
        uncertain: true,
      };
    }
    if (originalProfile !== null) {
      atomicWriteFile(
        current.kind === "file" ? current.targetPath : CODEX_PROFILE_PATH,
        originalProfile,
      );
    } else if (current.kind === "file") {
      // An absent profile preimage can authorize removing only the regular file
      // CodexCommander created. A later same-content symlink is user authority.
      if (current.symbolicLink) {
        profileChanged = true;
        return {
          result: {
            configRestored,
            profileRestored,
            configChanged,
            profileChanged,
            complete: false,
          },
          uncertain: true,
        };
      }
      try {
        unlinkSync(CODEX_PROFILE_PATH);
      } catch {
        profileChanged = true;
        return {
          result: {
            configRestored,
            profileRestored,
            configChanged,
            profileChanged,
            complete: false,
          },
          uncertain: true,
        };
      }
    }
    const written = readSurfaceSnapshot(CODEX_PROFILE_PATH);
    profileRestored = written !== null
      && surfaceValue(written, null) === originalProfile;
    profileChanged = !profileRestored;
  }

  return {
    result: {
      configRestored,
      profileRestored,
      configChanged,
      profileChanged,
      complete: configRestored && profileRestored,
    },
    uncertain: false,
  };
}

function retireExpectedJournal(
  expected: JournalFileSnapshot,
  options: ReconcileJournalOptions,
  requireDeadOwner: boolean,
  requireCleanNativeSurfaces: boolean,
  trustRestoredConfigAndProfile: boolean,
  authorizeMutation: AuthorizeJournalMutation,
): boolean {
  const classifyRemaining = trustRestoredConfigAndProfile
    ? classifyNativeRoutedResidueAfterJournalRestore
    : classifyNativeRoutedResidueWithoutJournal;
  if (requireCleanNativeSurfaces) {
    let classified;
    try {
      classified = classifyRemaining();
    } catch {
      return false;
    }
    if (classified.kind !== "clean") return false;
  }

  const configBefore = readSurfaceSnapshot(CODEX_CONFIG_PATH);
  const profileBefore = readSurfaceSnapshot(CODEX_PROFILE_PATH);
  if (!configBefore || !profileBefore) return false;
  if (trustRestoredConfigAndProfile) {
    const originalConfig = Buffer.from(expected.journal.originalConfig, "base64").toString("utf-8");
    const originalProfile = expected.journal.originalProfile === null
      ? null
      : Buffer.from(expected.journal.originalProfile, "base64").toString("utf-8");
    if (
      surfaceValue(configBefore, "") !== originalConfig
      || surfaceValue(profileBefore, null) !== originalProfile
    ) return false;
  }
  if (!authorizeMutation()) return false;
  options.beforeRetireRevalidation?.();

  // Re-observe every native surface after the race seam. The second full
  // classifier catches catalog/cache/temp residue, while exact config/profile
  // snapshots prevent a clean editor write from being mistaken for the state
  // that was just authorized.
  if (requireCleanNativeSurfaces) {
    let classified;
    try {
      classified = classifyRemaining();
    } catch {
      return false;
    }
    if (classified.kind !== "clean") return false;
  }
  const configFinal = readSurfaceSnapshot(CODEX_CONFIG_PATH);
  const profileFinal = readSurfaceSnapshot(CODEX_PROFILE_PATH);
  if (
    !configFinal
    || !profileFinal
    || !sameSurfaceSnapshot(configBefore, configFinal)
    || !sameSurfaceSnapshot(profileBefore, profileFinal)
    || !journalAuthorityStillMatches(expected, requireDeadOwner)
  ) return false;

  try {
    unlinkSync(JOURNAL_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * Config/profile half of an explicit restore. Production callers MUST already
 * hold N and publish their transition; this helper adds/reuses C and performs
 * exact journal/surface CAS. It is deliberately named as an under-lock
 * primitive so it cannot be mistaken for a standalone recovery entry point.
 */
export function restoreJournalStateUnderCoordinatedWrite(): RestoreJournalResult {
  try {
    return withConfigMutationLockSync(() => {
      const expected = readJournalFileSnapshot();
      if (!expected) return EMPTY_RESTORE;
      const attempt = restoreJournalStateFromSnapshot(
        expected,
        {},
        false,
        authorizeUncoordinatedMutation,
      );
      if (!attempt.uncertain && attempt.result.complete) {
        retireExpectedJournal(
          expected,
          {},
          false,
          false,
          false,
          authorizeUncoordinatedMutation,
        );
      }
      return attempt.result;
    });
  } catch {
    return EMPTY_RESTORE;
  }
}

function reconcileJournalUnderMutationLock(
  options: ReconcileJournalOptions,
  authorizeMutation: AuthorizeJournalMutation = authorizeUncoordinatedMutation,
): boolean {
  const expected = readJournalFileSnapshot();
  if (!expected || !journalOwnerIsProvenDead(expected.journal.pid)) return false;
  const configAtStart = readSurfaceSnapshot(CODEX_CONFIG_PATH);
  const profileAtStart = readSurfaceSnapshot(CODEX_PROFILE_PATH);

  // Recovery always gets first claim. A surface still equal to the journal's
  // injected postimage is restored exactly as before; retirement is considered
  // only for the valid journal left behind by a partial/no-op restore.
  options.beforeRecoveryRevalidation?.();
  const beforeRestore = readJournalFileSnapshot();
  if (
    !beforeRestore
    || !sameJournalFile(expected, beforeRestore)
    || !journalOwnerIsProvenDead(beforeRestore.journal.pid)
  ) return false;
  // Use the captured, revalidated journal rather than re-reading the path. A
  // concurrent replacement can therefore be retained, never restored/deleted
  // as though it were the dead owner's recovery record.
  const attempt = restoreJournalStateFromSnapshot(
    expected,
    options,
    true,
    authorizeMutation,
  );
  const configAfterRestore = readSurfaceSnapshot(CODEX_CONFIG_PATH);
  const profileAfterRestore = readSurfaceSnapshot(CODEX_PROFILE_PATH);
  const restoredAny = configAtStart !== null
    && profileAtStart !== null
    && configAfterRestore !== null
    && profileAfterRestore !== null
    && (
      !sameSurfaceSnapshot(configAtStart, configAfterRestore)
      || !sameSurfaceSnapshot(profileAtStart, profileAfterRestore)
    );

  // A replacement during normal recovery is a new authority. Do not use an
  // observation made for the old journal to remove it.
  const afterRestore = readJournalFileSnapshot();
  if (!afterRestore || !sameJournalFile(expected, afterRestore)) {
    return incompleteRecoveryResult(restoredAny);
  }
  if (attempt.uncertain) {
    return incompleteRecoveryResult(restoredAny);
  }

  // Ignore only the already-observed journal itself. Journal atomic-write temp
  // files and every config/profile/catalog/cache uncertainty remain blockers,
  // including after a byte-exact config/profile restore completed.
  if (!retireExpectedJournal(
    expected,
    options,
    true,
    true,
    attempt.result.complete,
    authorizeMutation,
  )) {
    return incompleteRecoveryResult(restoredAny);
  }

  if (restoredAny) {
    reportJournalRestore();
  } else {
    console.error("⚠️  A detached Codex recovery journal was retired after current native state was verified.");
  }
  return true;
}

function coordinatorTargetForCurrentHome(): { readonly path: string } | null {
  try {
    const canonical = canonicalizeCodexHome(getCodexHome());
    if (!canonical.ok) return null;
    return {
      path: resolveCodexCoordinatorDatabasePath(
        resolveEffectiveUserIdentity(),
        canonical.home.path,
      ),
    };
  } catch {
    return null;
  }
}

/** Formal N -> C serialization and generation publication, including bootstrap recovery. */
function mutateJournalWithCoordinator(
  coordinatorPath: string,
  revalidateRecoveryAdmission: () => boolean,
  validateSettledRecovery: () => boolean,
  mutation: (authorizeMutation: AuthorizeJournalMutation) => boolean,
): boolean {
  let transaction: ReturnType<typeof beginCodexCoordinatorRecoveryTransaction> | undefined;
  try {
    transaction = beginCodexCoordinatorRecoveryTransaction(
      coordinatorPath,
      revalidateRecoveryAdmission,
      validateSettledRecovery,
    );
    const expectation = transaction.expectation();
    const version = transaction.version();
    const attempt = withConfigMutationLockSync(() => {
      let published = false;
      const authorizeMutation = (): boolean => {
        if (published) return true;
        const result = transaction!.capability.beginTransition(
          {
            nativeGeneration: expectation.nativeBefore,
            currentTxId: version.currentTxId,
          },
          { txId: expectation.txId },
        );
        published = result.kind === "updated";
        return published;
      };
      try {
        return { result: mutation(authorizeMutation), published };
      } catch {
        // Atomic replacement failures can leave a hardened temp artifact. The
        // journal remains, but the coordinator must still record that a native
        // mutation may have occurred rather than rolling authority backwards.
        return { result: false, published };
      }
    });

    if (!attempt.published) {
      transaction.rollback();
      return attempt.result;
    }
    transaction.assertPublished(expectation);
    transaction.commit();
    return attempt.result;
  } catch {
    transaction?.rollback();
    return false;
  } finally {
    transaction?.close();
  }
}

export function reconcileJournal(options: ReconcileJournalOptions = {}): boolean {
  // Avoid creating the config-mutation database on the overwhelmingly common
  // no-journal path. This observation grants no authority; all evidence used
  // for recovery is freshly captured after C is held.
  if (!existsSync(JOURNAL_PATH)) return false;
  const preliminary = readJournalFileSnapshot();
  if (!preliminary || !journalOwnerIsProvenDead(preliminary.journal.pid)) return false;
  const preliminaryConfig = readSurfaceSnapshot(CODEX_CONFIG_PATH);
  const preliminaryProfile = readSurfaceSnapshot(CODEX_PROFILE_PATH);
  if (!preliminaryConfig || !preliminaryProfile) return false;
  const coordinator = coordinatorTargetForCurrentHome();
  if (!coordinator) return false;
  return mutateJournalWithCoordinator(
    coordinator.path,
    () => {
      const journal = readJournalFileSnapshot();
      const config = readSurfaceSnapshot(CODEX_CONFIG_PATH);
      const profile = readSurfaceSnapshot(CODEX_PROFILE_PATH);
      return journal !== null
        && sameJournalFile(preliminary, journal)
        && journalOwnerIsProvenDead(journal.journal.pid)
        && config !== null
        && sameSurfaceSnapshot(preliminaryConfig, config)
        && profile !== null
        && sameSurfaceSnapshot(preliminaryProfile, profile);
    },
    () => {
      if (existsSync(JOURNAL_PATH)) return false;
      const config = readSurfaceSnapshot(CODEX_CONFIG_PATH);
      const profile = readSurfaceSnapshot(CODEX_PROFILE_PATH);
      if (!config || !profile) return false;
      const originalConfig = Buffer.from(preliminary.journal.originalConfig, "base64").toString("utf-8");
      const originalProfile = preliminary.journal.originalProfile === null
        ? null
        : Buffer.from(preliminary.journal.originalProfile, "base64").toString("utf-8");
      const restoredOriginals = surfaceValue(config, "") === originalConfig
        && surfaceValue(profile, null) === originalProfile;
      const classified = restoredOriginals
        ? classifyNativeRoutedResidueAfterJournalRestore()
        : classifyNativeRoutedResidue();
      return classified.kind === "clean";
    },
    authorizeMutation => reconcileJournalUnderMutationLock(options, authorizeMutation),
  );
}

function externalProviderFromConfig(content: string): string | null {
  const provider = resolveEffectiveProjectModelProvider(content).provider;
  return provider && provider !== "openai" && !isOwnedProviderId(provider)
    ? provider
    : null;
}

function retireExternalProviderJournalUnderMutationLock(
  expectedProvider: string,
  options: ReconcileJournalOptions,
  authorizeMutation: AuthorizeJournalMutation,
): boolean {
  const expectedJournal = readJournalFileSnapshot();
  const configBefore = readSurfaceSnapshot(CODEX_CONFIG_PATH);
  if (
    !expectedJournal
    || !configBefore
    || configBefore.kind !== "file"
    || externalProviderFromConfig(configBefore.content) !== expectedProvider
  ) return false;

  if (!authorizeMutation()) return false;
  options.beforeRetireRevalidation?.();
  const configFinal = readSurfaceSnapshot(CODEX_CONFIG_PATH);
  const journalFinal = readJournalFileSnapshot();
  if (
    !configFinal
    || configFinal.kind !== "file"
    || !sameSurfaceSnapshot(configBefore, configFinal)
    || externalProviderFromConfig(configFinal.content) !== expectedProvider
    || !journalFinal
    || !sameJournalFile(expectedJournal, journalFinal)
  ) return false;
  try {
    unlinkSync(JOURNAL_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retire a stale journal only while the exact external-provider config that
 * superseded it is stable under recovery N -> C. A changed provider, replaced
 * journal, residue, or contention retains the authority record.
 */
export function retireJournalForExternalProvider(
  expectedProvider: string,
  options: ReconcileJournalOptions = {},
): boolean {
  if (!expectedProvider || !existsSync(JOURNAL_PATH)) return false;
  const preliminaryJournal = readJournalFileSnapshot();
  const preliminaryConfig = readSurfaceSnapshot(CODEX_CONFIG_PATH);
  if (
    !preliminaryJournal
    || !preliminaryConfig
    || preliminaryConfig.kind !== "file"
    || externalProviderFromConfig(preliminaryConfig.content) !== expectedProvider
  ) return false;
  const coordinator = coordinatorTargetForCurrentHome();
  if (!coordinator) return false;
  return mutateJournalWithCoordinator(
    coordinator.path,
    () => {
      const journal = readJournalFileSnapshot();
      const config = readSurfaceSnapshot(CODEX_CONFIG_PATH);
      return journal !== null
        && sameJournalFile(preliminaryJournal, journal)
        && config !== null
        && config.kind === "file"
        && sameSurfaceSnapshot(preliminaryConfig, config)
        && externalProviderFromConfig(config.content) === expectedProvider;
    },
    () => {
      if (existsSync(JOURNAL_PATH)) return false;
      const config = readSurfaceSnapshot(CODEX_CONFIG_PATH);
      return config !== null
        && config.kind === "file"
        && sameSurfaceSnapshot(preliminaryConfig, config)
        && externalProviderFromConfig(config.content) === expectedProvider
        && classifyNativeRoutedResidueWithoutJournal().kind === "clean";
    },
    authorizeMutation => retireExternalProviderJournalUnderMutationLock(
      expectedProvider,
      options,
      authorizeMutation,
    ),
  );
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  codexIntegrationEnabledNow,
  setIntegrationEnabled,
} from "./desired-state";
import { inspectNativeCodexOwnership } from "../integrations/native/ownership-preflight";
import {
  JOURNAL_PATH,
  classifyActiveCodexRoutingJournal,
  reconcileJournal,
  retireJournalAfterExplicitNativeEscape,
  retireJournalForExternalProvider,
} from "./journal";
import {
  restoreNativeCodexRoutingEscape,
  type NativeCodexRoutingEscapeResult,
} from "./native-routing-escape";
import { getCodexHome } from "./paths";
import { observeCodexRoutingDocument } from "./routing-document";

export interface NativeCodexRoutingStopOptions {
  inspectOwnership?: typeof inspectNativeCodexOwnership;
  setEnabled?: typeof setIntegrationEnabled;
  escapeNative?: typeof restoreNativeCodexRoutingEscape;
}

export interface NativeCodexRoutingStopResult extends NativeCodexRoutingEscapeResult {
  desiredChanged: boolean;
  configChanged: boolean;
}

/** Persist OFF before publishing native config; callers may terminate only on success. */
export function restoreNativeCodexRoutingForStop(
  options: NativeCodexRoutingStopOptions = {},
): NativeCodexRoutingStopResult {
  const ownership = (options.inspectOwnership ?? inspectNativeCodexOwnership)();
  if (ownership.ownership === "foreign") {
    return {
      success: false,
      changed: false,
      desiredChanged: false,
      configChanged: false,
      message: `Codex native restore refused: ${ownership.reason}`,
    };
  }
  const desired = (options.setEnabled ?? setIntegrationEnabled)("codex", false);
  if (!desired.ok) {
    return {
      success: false,
      changed: false,
      desiredChanged: false,
      configChanged: false,
      message: `Native routing intent could not be saved: ${desired.message}`,
    };
  }
  const escaped = (options.escapeNative ?? restoreNativeCodexRoutingEscape)();
  const desiredChanged = desired.status === "committed";
  return {
    ...escaped,
    changed: desiredChanged || escaped.changed,
    desiredChanged,
    configChanged: escaped.changed,
  };
}

export function currentExternalCodexModelProvider(): string | null {
  const path = join(getCodexHome(), "config.toml");
  if (!existsSync(path)) return null;
  return observeCodexRoutingDocument(readFileSync(path, "utf8")).externalProvider;
}

export interface ExplicitCodexRoutingStartOptions {
  setEnabled?: typeof setIntegrationEnabled;
  reconcile?: () => boolean | void;
  retireExplicitJournal?: typeof retireJournalAfterExplicitNativeEscape;
  retireExternalJournal?: typeof retireJournalForExternalProvider;
  journalPending?: () => boolean;
  externalProvider?: () => string | null;
  desiredEnabled?: () => boolean;
  classifyActiveJournal?: typeof classifyActiveCodexRoutingJournal;
  /** Exact current-home runtime PID; recordless/config-port listeners never qualify. */
  protectedLiveOwnerPid?: number;
}

export type ExplicitCodexRoutingStartFailureReason =
  | "routing-recovery-failed"
  | "routing-recovery-unverified";

export interface ExplicitCodexRoutingStartResult extends NativeCodexRoutingEscapeResult {
  /** Additive machine-readable classification; callers must not parse message text. */
  reason?: ExplicitCodexRoutingStartFailureReason;
}

function hasActiveManagedJournal(
  options: ExplicitCodexRoutingStartOptions,
  externalProvider: string | null,
): boolean {
  if (externalProvider || options.protectedLiveOwnerPid === undefined) return false;
  try {
    if (!(options.desiredEnabled ?? codexIntegrationEnabledNow)()) return false;
    return (options.classifyActiveJournal ?? classifyActiveCodexRoutingJournal)(
      options.protectedLiveOwnerPid,
    ).kind !== "not-active-managed-postimage";
  } catch {
    // An unreadable desired state or journal cannot authorize the no-op.
    return false;
  }
}

/**
 * Explicit Start is the only operation that turns a prior native escape back
 * on. Enabling happens only after existing journal authority is proven retired.
 */
export function prepareExplicitCodexRoutingStart(
  options: ExplicitCodexRoutingStartOptions = {},
): ExplicitCodexRoutingStartResult {
  const externalProvider = (options.externalProvider ?? currentExternalCodexModelProvider)();
  const journalPending = options.journalPending ?? (() => existsSync(JOURNAL_PATH));
  let activeManagedJournal = false;
  if (journalPending()) {
    // A repeated Route Back may arrive after the first request already synced
    // successfully. Its live proxy journal is active recovery authority, not
    // stale residue: leave it in place only when desired intent is already ON,
    // the exact profile postimage still matches, and config is either the exact
    // postimage or a stable marker-owned descendant of that protected PID.
    activeManagedJournal = hasActiveManagedJournal(options, externalProvider);
    if (!activeManagedJournal) {
      let retired = false;
      try {
        retired = (options.retireExplicitJournal ?? retireJournalAfterExplicitNativeEscape)(
          options.protectedLiveOwnerPid === undefined
            ? { kind: "dead" }
            : { kind: "protected-live", pid: options.protectedLiveOwnerPid },
        );
        // A live current-home runtime does not prove that an older helper-owned
        // journal remains live; the separate dead-owner call must prove ESRCH.
        if (!retired && options.protectedLiveOwnerPid !== undefined) {
          retired = (options.retireExplicitJournal ?? retireJournalAfterExplicitNativeEscape)(
            { kind: "dead" },
          );
        }
        if (!retired) {
          retired = externalProvider
            ? (options.retireExternalJournal ?? retireJournalForExternalProvider)(externalProvider)
            : (options.reconcile ?? reconcileJournal)() === true;
        }
      } catch (error) {
        return {
          success: false,
          changed: false,
          reason: "routing-recovery-failed",
          message: `Codex routing recovery failed: ${error instanceof Error ? error.message : String(error)}.`,
        };
      }
      if (!retired || journalPending()) {
        return {
          success: false,
          changed: false,
          reason: "routing-recovery-unverified",
          message: "Codex routing recovery could not prove and retire the existing journal.",
        };
      }
    }
  }
  const desired = (options.setEnabled ?? setIntegrationEnabled)("codex", true);
  if (!desired.ok) {
    return {
      success: false,
      changed: false,
      message: `Codex routing could not be enabled: ${desired.message}`,
    };
  }
  return {
    success: true,
    changed: desired.status === "committed",
    message: activeManagedJournal
      ? "Codex is already routing through this live proxy."
      : externalProvider
      ? "External Codex provider routing was preserved."
      : "Codex routing is ready to use the proxy.",
  };
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { setIntegrationEnabled } from "./desired-state";
import { inspectNativeCodexOwnership } from "../integrations/native/ownership-preflight";
import {
  JOURNAL_PATH,
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
  /** Exact current-home runtime PID; recordless/config-port listeners never qualify. */
  protectedLiveOwnerPid?: number;
}

/**
 * Explicit Start is the only operation that turns a prior native escape back
 * on. Enabling happens only after existing journal authority is proven retired.
 */
export function prepareExplicitCodexRoutingStart(
  options: ExplicitCodexRoutingStartOptions = {},
): NativeCodexRoutingEscapeResult {
  const externalProvider = (options.externalProvider ?? currentExternalCodexModelProvider)();
  const journalPending = options.journalPending ?? (() => existsSync(JOURNAL_PATH));
  if (journalPending()) {
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
        message: `Codex routing recovery failed: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }
    if (!retired || journalPending()) {
      return {
        success: false,
        changed: false,
        message: "Codex routing recovery could not prove and retire the existing journal.",
      };
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
    message: externalProvider
      ? "External Codex provider routing was preserved."
      : "Codex routing is ready to use the proxy.",
  };
}

import { lstatSync } from "node:fs";
import { CODEX_CONFIG_PATH } from "../codex/paths";
import {
  getDefaultConfig,
  initializeConfigIfMissing,
  type ConfigInitializationResult,
} from "../config";

export type ProxySetupRequirement = "codex-first-run";

export type ProxyStartPreparation =
  | {
      ok: true;
      changed: boolean;
      enableCodexRouting: boolean;
      setupRequired?: ProxySetupRequirement;
    }
  | {
      ok: false;
      changed: false;
      message: string;
      errorCode: "CONFIGURATION_REQUIRED";
    };

export interface MacOSFirstRunIo {
  initializeConfig?: typeof initializeConfigIfMissing;
  codexConfigState?: () => "present-or-unreadable" | "missing";
}

function defaultCodexConfigState(): "present-or-unreadable" | "missing" {
  try {
    lstatSync(CODEX_CONFIG_PATH);
    return "present-or-unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? "missing"
      : "present-or-unreadable";
  }
}

function refusalMessage(reason: Extract<ConfigInitializationResult, { status: "refused" }>["reason"]): string {
  return reason === "existing-invalid"
    ? "CodexCommander configuration needs repair; no files were changed."
    : "CodexCommander configuration is inaccessible or unsafe; no files were changed.";
}

export function prepareMacOSAppStart(
  io: MacOSFirstRunIo = {},
): ProxyStartPreparation {
  const codexState = (io.codexConfigState ?? defaultCodexConfigState)();
  const candidate = structuredClone(getDefaultConfig());
  if (codexState === "missing") {
    candidate.clientIntegrations = {
      ...(candidate.clientIntegrations ?? {}),
      codex: false,
    };
  }

  const initialized = (io.initializeConfig ?? initializeConfigIfMissing)(candidate);
  if (initialized.status === "refused") {
    return {
      ok: false,
      changed: false,
      message: refusalMessage(initialized.reason),
      errorCode: "CONFIGURATION_REQUIRED",
    };
  }

  return {
    ok: true,
    changed: initialized.status === "created",
    enableCodexRouting: !(initialized.status === "created" && codexState === "missing"),
    ...(codexState === "missing" ? { setupRequired: "codex-first-run" as const } : {}),
  };
}

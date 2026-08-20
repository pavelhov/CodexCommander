import { describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../src/config";
import { prepareMacOSAppStart } from "../src/cli/macos-first-run";

describe("macOS first-run preparation", () => {
  test("fresh app plus initialized Codex enables normal explicit routing", () => {
    let candidate = getDefaultConfig();
    const result = prepareMacOSAppStart({
      codexConfigState: () => "present-or-unreadable",
      initializeConfig: value => { candidate = value; return { status: "created" }; },
    });
    expect(candidate).toEqual(getDefaultConfig());
    expect(result).toEqual({ ok: true, changed: true, enableCodexRouting: true });
  });

  test("fresh app plus missing Codex persists integration off and requests setup", () => {
    let candidate = getDefaultConfig();
    const result = prepareMacOSAppStart({
      codexConfigState: () => "missing",
      initializeConfig: value => { candidate = value; return { status: "created" }; },
    });
    expect(candidate.clientIntegrations).toEqual({ codex: false });
    expect(result).toEqual({
      ok: true,
      changed: true,
      enableCodexRouting: false,
      setupRequired: "codex-first-run",
    });
  });

  test("existing config is never replaced even when Codex is missing", () => {
    const result = prepareMacOSAppStart({
      codexConfigState: () => "missing",
      initializeConfig: () => ({ status: "existing" }),
    });
    expect(result).toEqual({
      ok: true,
      changed: false,
      enableCodexRouting: true,
      setupRequired: "codex-first-run",
    });
  });

  test("typed initialization refusals become a secret-free app error", () => {
    const result = prepareMacOSAppStart({
      codexConfigState: () => "present-or-unreadable",
      initializeConfig: () => ({ status: "refused", reason: "existing-invalid" }),
    });
    expect(result).toEqual({
      ok: false,
      changed: false,
      message: "CodexCommander configuration needs repair; no files were changed.",
      errorCode: "CONFIGURATION_REQUIRED",
    });
  });
});

import { expect, test } from "bun:test";
import {
  companionLeaseObserved,
  deriveStartupMethod,
  deriveStartupView,
  type StartupHealthData,
} from "../src/pages/startup-shared";

function health(overrides: Partial<StartupHealthData>): StartupHealthData {
  return {
    status: "native",
    routingKind: "native",
    routingInjected: false,
    localRoutingDependency: false,
    autostartEnabled: false,
    rebootSafe: false,
    protection: "none",
    serviceInstalled: false,
    serviceViable: false,
    serviceEnabled: false,
    serviceRunning: false,
    serviceStale: false,
    serviceConflict: false,
    serviceSupported: true,
    shimInstalled: false,
    shimHealthy: false,
    shimCoverage: "none",
    platform: "darwin",
    recommendedCommand: null,
    diagnosticStale: false,
    commands: {
      installService: "ccx service install",
      repairService: "ccx service repair",
      installShim: "ccx shim install",
      restoreNative: "ccx restore",
    },
    ...overrides,
  };
}

test("caution with a verified companion lease renders calm app-managed", () => {
  const view = deriveStartupView(health({
    status: "caution",
    startupMethod: "companion",
    crashRecovery: false,
    protection: "companion",
    autostartEnabled: true,
    rebootSafe: true,
    companion: { launchAtLogin: "enabled", observedAt: 1_755_000_000_000 },
  }), false);
  expect(view.hero).toBe("app-managed");
  expect(view.method).toBe("companion");
  expect(view.methodState).toBe("ready");
  expect(view.crashRecovery).toBe("off");
  expect(view.canEnableCrashRecovery).toBe(true);
  expect(view.advancedDefaultOpen).toBe(false);
});

test("a missing companion lease stays at-risk/unknown and is never reported disabled", () => {
  const data = health({
    status: "caution",
    startupMethod: "companion",
    crashRecovery: false,
    protection: "companion",
    companion: { launchAtLogin: "enabled", observedAt: 0 },
  });
  expect(companionLeaseObserved(data.companion)).toBe(false);
  const view = deriveStartupView(data, false);
  expect(view.hero).toBe("at-risk");
  expect(view.methodState).toBe("unknown");
  expect(view.companionLeaseMissing).toBe(true);
});

test("companion disabled or pending approval needs attention, not calm", () => {
  for (const launchAtLogin of ["disabled", "requires-approval", "unavailable"] as const) {
    const view = deriveStartupView(health({
      status: "caution",
      startupMethod: "companion",
      protection: "companion",
      companion: { launchAtLogin, observedAt: 1_755_000_000_000 },
    }), false);
    expect(view.hero).toBe("at-risk");
    expect(view.methodState).toBe("attention");
  }
});

test("protected with the crash-recovery service reads as recovery on", () => {
  const view = deriveStartupView(health({
    status: "protected",
    startupMethod: "service",
    crashRecovery: true,
    protection: "service",
    serviceInstalled: true,
    serviceViable: true,
    rebootSafe: true,
  }), false);
  expect(view.hero).toBe("protected");
  expect(view.method).toBe("service");
  expect(view.methodState).toBe("ready");
  expect(view.crashRecovery).toBe("on");
  expect(view.canEnableCrashRecovery).toBe(false);
});

test("legacy payloads derive method and recovery from the old protection fields", () => {
  const legacyService = health({
    status: "protected",
    protection: "service",
    serviceInstalled: true,
    serviceViable: true,
  });
  expect(deriveStartupMethod(legacyService)).toBe("service");
  expect(deriveStartupView(legacyService, false).crashRecovery).toBe("on");

  const legacyShim = health({ status: "protected", protection: "shim", shimInstalled: true, shimHealthy: true, autostartEnabled: true });
  expect(deriveStartupMethod(legacyShim)).toBe("shim");
  expect(deriveStartupView(legacyShim, false).methodState).toBe("ready");

  const legacyNone = health({ status: "at-risk", routingKind: "codexcommander-local", localRoutingDependency: true });
  expect(deriveStartupMethod(legacyNone)).toBe("none");
  expect(deriveStartupView(legacyNone, false).hero).toBe("at-risk");
});

test("stale diagnostics never render calm app-managed and block the enable action", () => {
  const view = deriveStartupView(health({
    status: "caution",
    startupMethod: "companion",
    crashRecovery: false,
    protection: "companion",
    diagnosticStale: true,
    companion: { launchAtLogin: "enabled", observedAt: 1_755_000_000_000 },
  }), true);
  expect(view.hero).toBe("at-risk");
  expect(view.canEnableCrashRecovery).toBe(false);
  expect(view.advancedDefaultOpen).toBe(true);
});

test("at-risk opens Advanced so the repair affordances stay visible", () => {
  const view = deriveStartupView(health({
    status: "at-risk",
    routingKind: "codexcommander-local",
    localRoutingDependency: true,
  }), false);
  expect(view.hero).toBe("at-risk");
  expect(view.advancedDefaultOpen).toBe(true);
});

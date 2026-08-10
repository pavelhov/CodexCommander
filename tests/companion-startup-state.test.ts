import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deriveStartupHealth, type StartupHealth } from "../src/codex/autostart-health";
import { handleManagementAPI } from "../src/server/management-api";
import {
  COMPANION_HEARTBEAT_TARGET_MS,
  COMPANION_LEASE_TTL_MS,
  clearCompanionLeaseForTests,
  currentCompanionLease,
  decorateStartupHealth,
  parseCompanionStartupBody,
  recordCompanionLease,
} from "../src/server/companion-startup-state";
import { invalidateStartupHealthCache } from "../src/server/startup-health-cache";
import type { CodexCommanderConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as CodexCommanderConfig;

function ownedLocalBase(overrides: Partial<Parameters<typeof deriveStartupHealth>[0]> = {}): StartupHealth {
  return deriveStartupHealth({
    routingKind: "codexcommander-local",
    autostartEnabled: true,
    serviceInstalled: false,
    serviceViable: false,
    serviceEnabled: false,
    serviceRunning: false,
    serviceStale: false,
    serviceConflict: false,
    serviceSupported: true,
    shimInstalled: false,
    shimHealthy: false,
    platform: "darwin",
    ...overrides,
  });
}

async function companionPut(
  body: unknown,
  principal?: "admin-token" | "gui-session",
): Promise<{ status: number; raw: string }> {
  const url = new URL("http://127.0.0.1:10100/api/startup-health/companion");
  const req = new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, url, config, {}, principal);
  expect(res).not.toBeNull();
  return { status: res!.status, raw: await res!.text() };
}

beforeEach(() => {
  clearCompanionLeaseForTests();
  invalidateStartupHealthCache();
});

afterEach(() => {
  clearCompanionLeaseForTests();
  invalidateStartupHealthCache();
});

describe("PUT /api/startup-health/companion security", () => {
  test("accepts the raw admin token and records a server-timestamped lease", async () => {
    const before = Date.now();
    const { status, raw } = await companionPut(
      { version: 1, launchAtLogin: "enabled" },
      "admin-token",
    );
    expect(status).toBe(204);
    expect(raw).toBe("");
    const lease = currentCompanionLease(Date.now());
    expect(lease).not.toBeNull();
    expect(lease!.launchAtLogin).toBe("enabled");
    expect(lease!.observedAt).toBeGreaterThanOrEqual(before);
    expect(lease!.observedAt).toBeLessThanOrEqual(Date.now());
  });

  test("rejects a GUI session with 403 and records nothing", async () => {
    const { status } = await companionPut(
      { version: 1, launchAtLogin: "enabled" },
      "gui-session",
    );
    expect(status).toBe(403);
    expect(currentCompanionLease()).toBeNull();
  });

  test("fails closed when no explicit principal is resolved", async () => {
    const { status } = await companionPut({ version: 1, launchAtLogin: "enabled" });
    expect(status).toBe(403);
    expect(currentCompanionLease()).toBeNull();
  });

  test("rejects malformed and extra input without recording a lease", async () => {
    for (const body of [
      null,
      [],
      ["enabled"],
      "enabled",
      {},
      { launchAtLogin: "enabled" },
      { version: 1 },
      { version: 2, launchAtLogin: "enabled" },
      { version: "1", launchAtLogin: "enabled" },
      { version: 1, launchAtLogin: "sometimes" },
      { version: 1, launchAtLogin: "enabled", timestamp: 1_700_000_000_000 },
      { version: 1, launchAtLogin: "enabled", ttl: 90 },
      { version: 1, launchAtLogin: "enabled", pid: 123 },
      { version: 1, launchAtLogin: "enabled", path: "/Applications/CodexCommander.app" },
      { version: 1, launchAtLogin: "enabled", bundle: { id: "com.codexcommander.menubar" } },
    ] as unknown[]) {
      const { status } = await companionPut(body, "admin-token");
      expect(status).toBe(400);
    }
    expect(currentCompanionLease()).toBeNull();
  });

  test("the route and lease module never log bodies or tokens", async () => {
    const configRoutes = await Bun.file(
      new URL("../src/server/management/config-routes.ts", import.meta.url),
    ).text();
    const section = configRoutes.slice(configRoutes.indexOf("api/startup-health/companion"));
    expect(section).not.toMatch(/console\./);
    expect(section).not.toMatch(/logger\./);
    const module = await Bun.file(
      new URL("../src/server/companion-startup-state.ts", import.meta.url),
    ).text();
    expect(module).not.toMatch(/console\./);
    expect(module).not.toMatch(/logger\./);
  });
});

describe("companion lease TTL", () => {
  test("the lease stays fresh for the 90s window and expires at the boundary", () => {
    const now = 1_000_000;
    recordCompanionLease("enabled", now);
    expect(currentCompanionLease(now + COMPANION_LEASE_TTL_MS - 1)).not.toBeNull();
    expect(currentCompanionLease(now + COMPANION_LEASE_TTL_MS)).toBeNull();
    expect(currentCompanionLease(now + COMPANION_LEASE_TTL_MS + 1)).toBeNull();
    // The heartbeat target is one third of the lease so a single dropped beat
    // cannot expire protection by accident.
    expect(COMPANION_HEARTBEAT_TARGET_MS * 3).toBe(COMPANION_LEASE_TTL_MS);
  });

  test("a backwards-moving wall clock expires the lease instead of keeping it fresh", () => {
    const now = 1_500_000;
    recordCompanionLease("enabled", now);
    // Any observation in the "future" relative to now must fail closed.
    expect(currentCompanionLease(now - 1)).toBeNull();
    expect(currentCompanionLease(now - 60_000)).toBeNull();
    const decorated = decorateStartupHealth(ownedLocalBase(), now - 1);
    expect(decorated.status).toBe("at-risk");
    expect(decorated.startupMethod).toBe("none");
    expect(decorated.companion).toBeNull();
  });

  test("decoration credits a fresh lease and drops credit once expired", () => {
    const now = 2_000_000;
    const base = ownedLocalBase();
    recordCompanionLease("enabled", now);
    const fresh = decorateStartupHealth(base, now);
    expect(fresh.status).toBe("caution");
    expect(fresh.startupMethod).toBe("companion");
    const expired = decorateStartupHealth(base, now + COMPANION_LEASE_TTL_MS);
    expect(expired.status).toBe("at-risk");
    expect(expired.startupMethod).toBe("none");
    expect(expired.companion).toBeNull();
  });
});

describe("companion precedence", () => {
  test("no local routing stays native/native even with a fresh lease", () => {
    const base = deriveStartupHealth({
      routingKind: "native",
      autostartEnabled: false,
      serviceInstalled: false,
      serviceViable: false,
      serviceEnabled: false,
      serviceRunning: false,
      serviceStale: false,
      serviceConflict: false,
      serviceSupported: true,
      shimInstalled: false,
      shimHealthy: false,
      platform: "darwin",
    });
    recordCompanionLease("enabled", 3_000_000);
    const decorated = decorateStartupHealth(base, 3_000_000);
    expect(decorated).toMatchObject({
      status: "native",
      startupMethod: "native",
      rebootSafe: true,
      crashRecovery: false,
      protection: "none",
    });
    // The lease is informational even when it grants no credit.
    expect(decorated.companion).toEqual({ launchAtLogin: "enabled", observedAt: 3_000_000 });
  });

  test("a viable service wins over a fresh companion lease", () => {
    const base = ownedLocalBase({
      serviceInstalled: true,
      serviceViable: true,
      serviceEnabled: true,
      serviceRunning: true,
    });
    recordCompanionLease("enabled", 4_000_000);
    const decorated = decorateStartupHealth(base, 4_000_000);
    expect(decorated).toMatchObject({
      status: "protected",
      startupMethod: "service",
      rebootSafe: true,
      crashRecovery: true,
      protection: "service",
      recommendedCommand: null,
    });
    expect(decorated.companion).not.toBeNull();
  });

  test("a fresh enabled companion gives caution without alarming repair guidance", () => {
    const base = ownedLocalBase();
    recordCompanionLease("enabled", 5_000_000);
    const decorated = decorateStartupHealth(base, 5_000_000);
    expect(decorated).toMatchObject({
      status: "caution",
      startupMethod: "companion",
      rebootSafe: true,
      crashRecovery: false,
      protection: "companion",
      recommendedCommand: null,
    });
    // Service install stays available as an optional crash-recovery action.
    expect(decorated.commands.installService).toBe("ccx service install");
  });

  test("disabled or approval-required leases are never credited", () => {
    for (const launchAtLogin of ["disabled", "requires-approval", "unavailable"] as const) {
      const now = 6_000_000;
      recordCompanionLease(launchAtLogin, now);
      const decorated = decorateStartupHealth(ownedLocalBase(), now);
      expect(decorated.status).toBe("at-risk");
      expect(decorated.startupMethod).toBe("none");
      expect(decorated.protection).toBe("none");
      expect(decorated.companion?.launchAtLogin).toBe(launchAtLogin);
    }
  });

  test("a fresh lease never overrides a stale diagnostic", () => {
    const base = {
      ...ownedLocalBase({ serviceInstalled: true, serviceViable: true, serviceEnabled: true, serviceRunning: true }),
      diagnosticStale: true,
      status: "at-risk" as const,
      rebootSafe: false,
      protection: "none" as const,
      startupMethod: "none" as const,
      crashRecovery: false,
    };
    recordCompanionLease("enabled", 7_000_000);
    const decorated = decorateStartupHealth(base, 7_000_000);
    expect(decorated.status).toBe("at-risk");
    expect(decorated.startupMethod).toBe("none");
    expect(decorated.rebootSafe).toBe(false);
    expect(decorated.crashRecovery).toBe(false);
    expect(decorated.protection).toBe("none");
    // Informational lease still surfaces; effective health is untouched.
    expect(decorated.companion?.launchAtLogin).toBe("enabled");
  });

  test("custom-local and unknown routing never credit the companion", () => {
    for (const routingKind of ["custom-local", "unknown"] as const) {
      const now = 8_000_000;
      const base = deriveStartupHealth({
        routingKind,
        autostartEnabled: true,
        serviceInstalled: true,
        serviceViable: true,
        serviceEnabled: true,
        serviceRunning: true,
        serviceStale: false,
        serviceConflict: false,
        serviceSupported: true,
        shimInstalled: false,
        shimHealthy: false,
        platform: "darwin",
      });
      recordCompanionLease("enabled", now);
      const decorated = decorateStartupHealth(base, now);
      expect(decorated).toMatchObject({
        status: "at-risk",
        startupMethod: "none",
        rebootSafe: false,
        crashRecovery: false,
        protection: "none",
        recommendedCommand: "ccx restore",
      });
      expect(decorated.companion?.launchAtLogin).toBe("enabled");
    }
  });

  test("a shim stays conservative even with a fresh companion lease", () => {
    const base = ownedLocalBase({ shimInstalled: true, shimHealthy: true });
    const now = 9_000_000;
    recordCompanionLease("disabled", now);
    const decorated = decorateStartupHealth(base, now);
    expect(decorated).toMatchObject({
      status: "at-risk",
      startupMethod: "shim",
      rebootSafe: false,
      crashRecovery: false,
      protection: "shim",
    });
  });

  test("an owned-local case with no mechanism stays at-risk/none", () => {
    const now = 10_000_000;
    recordCompanionLease("disabled", now);
    const decorated = decorateStartupHealth(ownedLocalBase(), now);
    expect(decorated).toMatchObject({
      status: "at-risk",
      startupMethod: "none",
      rebootSafe: false,
      crashRecovery: false,
      protection: "none",
    });
  });
});

describe("companion decoration at response time", () => {
  test("the settings seed is decorated with the fresh lease", async () => {
    const deps = {
      resolveCodexRuntime: () => ({
        runtime: { command: "codex-fixture", version: "0.999.0", source: "environment" as const },
        failures: [],
      }),
      getCachedStartupHealth: async () => ownedLocalBase(),
    };
    recordCompanionLease("enabled", Date.now());
    const req = new Request("http://127.0.0.1:10100/api/settings");
    const res = await handleManagementAPI(req, new URL(req.url), config, deps);
    expect(res?.status).toBe(200);
    const body = await res!.json() as { startupHealth: StartupHealth };
    expect(body.startupHealth.status).toBe("caution");
    expect(body.startupHealth.startupMethod).toBe("companion");
    expect(body.startupHealth.recommendedCommand).toBeNull();
    expect(body.startupHealth.companion).not.toBeNull();
    expect(body.startupHealth.companion!.launchAtLogin).toBe("enabled");
    expect(typeof body.startupHealth.companion!.observedAt).toBe("number");
  });

  test("GET /api/startup-health carries an internally consistent decorated payload", async () => {
    recordCompanionLease("enabled", Date.now());
    const url = new URL("http://127.0.0.1:10100/api/startup-health");
    const req = new Request(url);
    const res = await handleManagementAPI(req, url, config);
    expect(res?.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(["native", "protected", "caution", "at-risk"]).toContain(body.status);
    expect(["native", "service", "companion", "shim", "none"]).toContain(body.startupMethod);
    expect(typeof body.rebootSafe).toBe("boolean");
    expect(typeof body.crashRecovery).toBe("boolean");
    expect((body.status === "caution") === (body.startupMethod === "companion")).toBe(true);
    expect(body.crashRecovery === (body.startupMethod === "service")).toBe(true);
    expect(body.companion).toMatchObject({ launchAtLogin: "enabled" });
    expect(typeof (body.companion as { observedAt: unknown }).observedAt).toBe("number");
  });

  test("without a lease the companion field is null", async () => {
    const url = new URL("http://127.0.0.1:10100/api/startup-health");
    const req = new Request(url);
    const res = await handleManagementAPI(req, url, config);
    expect(res?.status).toBe(200);
    const body = await res!.json() as { companion: unknown };
    expect(body.companion).toBeNull();
  });
});

describe("server restart loses the lease", () => {
  test("a fresh module instance has no companion state", async () => {
    const now = 11_000_000;
    recordCompanionLease("enabled", now);
    expect(currentCompanionLease(now)).not.toBeNull();

    const restarted = await import("../src/server/companion-startup-state.ts?restart=1");
    expect(restarted.currentCompanionLease(now)).toBeNull();
    const decorated = restarted.decorateStartupHealth(ownedLocalBase(), now);
    expect(decorated.status).toBe("at-risk");
    expect(decorated.startupMethod).toBe("none");
    expect(decorated.companion).toBeNull();
  });
});

describe("strict body parser", () => {
  test("accepts only the locked shape", () => {
    expect(parseCompanionStartupBody({ version: 1, launchAtLogin: "enabled" }))
      .toEqual({ ok: true, launchAtLogin: "enabled" });
    expect(parseCompanionStartupBody({ version: 1, launchAtLogin: "requires-approval" }))
      .toEqual({ ok: true, launchAtLogin: "requires-approval" });
    expect(parseCompanionStartupBody({ version: 1, launchAtLogin: "disabled" }).ok).toBe(true);
  });
});

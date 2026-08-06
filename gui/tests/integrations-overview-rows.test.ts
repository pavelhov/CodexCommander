import { expect, test } from "bun:test";
import {
  buildOverviewRows,
  countOverviewRows,
  type OverviewSources,
} from "../src/pages/integrations/overview-clients";
import type { IntegrationStatus } from "../src/pages/integrations/integration-api";
import type { OpenCodeIntegrationEnvelope } from "../src/pages/integrations/opencode-integration-api";

/**
 * The overview's whole job is to not lie about what is applied, so these tests
 * pin the mappings that are easy to get subtly wrong: an unsettled source that
 * looks absent, a Codex routing state read off the wrong field, and a Desktop
 * profile that exists but is not the one Desktop serves.
 */

function fileStatus(overrides: Partial<IntegrationStatus> = {}): IntegrationStatus {
  return {
    clientId: "hermes",
    state: "absent",
    installed: true,
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshotCount: 0,
    retentionDegraded: false,
    ...overrides,
  };
}

function sources(overrides: Partial<OverviewSources> = {}): OverviewSources {
  return {
    clients: [],
    clientsSettled: true,
    codex: null,
    keyCount: null,
    keyPhase: "settled",
    claude: null,
    claudeDesktop: null,
    grok: null,
    opencode: null,
    opencodeSettled: true,
    native: null,
    nativeSettled: true,
    ...overrides,
  };
}

function opencode(
  state: OpenCodeIntegrationEnvelope["integration"]["state"] = "applied",
  overrides: Partial<OpenCodeIntegrationEnvelope["integration"]> = {},
): OpenCodeIntegrationEnvelope {
  return {
    integration: {
      state,
      targetPath: "/home/test/.config/opencode/opencode.jsonc",
      autoConnect: false,
      canRestore: state !== "not_applied",
      tokenReady: state === "applied" || state === "modified",
      ...overrides,
    },
    installation: { desktopInstalled: true, cliInstalled: true, preferred: "desktop" },
    canOpen: true,
    downloadUrl: "https://opencode.ai/download",
    consoleUrl: "https://opencode.ai/console",
    provider: { configured: false, credentialVerification: "not_configured" },
  };
}

function rowById(built: ReturnType<typeof buildOverviewRows>, id: string) {
  const found = built.rows.find(row => row.id === id);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

test("a null source is unknown, never absent, and is counted in neither total", () => {
  const built = buildOverviewRows(sources());
  for (const id of ["codex", "claude", "claudeDesktop", "grok", "opencode"]) {
    expect(rowById(built, id).state).toBe("unknown");
  }
  const counts = countOverviewRows(built.rows);
  expect(counts.detected).toBe(0);
  expect(counts.applied).toBe(0);
  // Five, not six: keys is a credential surface and never a client row.
  expect(counts.unknown).toBe(5);
});

test("Codex reads routingInjected, not status", () => {
  // `protected` is about surviving a reboot. With no injected routing the
  // proxy is not in Codex's path, and the card must say so.
  const notInjected = buildOverviewRows(
    sources({ codex: { routingInjected: false, status: "protected" } }),
  );
  expect(rowById(notInjected, "codex").state).toBe("absent");
  expect(rowById(notInjected, "codex").applied).toBe(false);

  const injected = buildOverviewRows(
    sources({ codex: { routingInjected: true, status: "at-risk" } }),
  );
  expect(rowById(injected, "codex").state).toBe("current");
  expect(rowById(injected, "codex").applied).toBe(true);

  const broken = buildOverviewRows(
    sources({ codex: { routingInjected: true, status: "error" } }),
  );
  expect(rowById(broken, "codex").state).toBe("stale");
});

test("Claude Desktop: applied but not the served profile reads as stale", () => {
  const desktopNative = [{
    clientId: "claude-desktop" as const,
    state: "current" as const,
    installed: true,
    configPath: "/tmp/desktop",
    desiredEnabled: true,
    disableBlocked: null,
  }];
  const served = buildOverviewRows(
    sources({ native: desktopNative, claudeDesktop: { desiredEnabled: true, installed: true, applied: true, stale: false, activeProfile: true } }),
  );
  expect(rowById(served, "claudeDesktop").state).toBe("current");

  const notServed = buildOverviewRows(
    sources({ native: desktopNative, claudeDesktop: { desiredEnabled: true, installed: true, applied: true, stale: false, activeProfile: false } }),
  );
  expect(rowById(notServed, "claudeDesktop").state).toBe("stale");

  const drifted = buildOverviewRows(
    sources({ native: desktopNative, claudeDesktop: { desiredEnabled: true, installed: true, applied: true, stale: true, activeProfile: true } }),
  );
  expect(rowById(drifted, "claudeDesktop").state).toBe("stale");

  // Undeterminable must not downgrade a healthy applied profile.
  const unknownProfile = buildOverviewRows(
    sources({ native: desktopNative, claudeDesktop: { desiredEnabled: true, installed: true, applied: true, stale: false, activeProfile: null } }),
  );
  expect(rowById(unknownProfile, "claudeDesktop").state).toBe("current");
});

test("file clients keep their existing badge and applied semantics", () => {
  const rows = buildOverviewRows(sources({
    clients: [
      fileStatus({ clientId: "pi", state: "stale" }),
      fileStatus({ clientId: "hermes", state: "conflict" }),
      fileStatus({ clientId: "openclaw", state: "absent" }),
      fileStatus({ clientId: "kimi", state: "absent", installed: false }),
      fileStatus({ clientId: "gajae", state: "unsafe" }),
    ],
    opencode: opencode("applied"),
  }));
  expect(rowById(rows, "opencode").applied).toBe(true);
  expect(rowById(rows, "pi").applied).toBe(true);
  expect(rowById(rows, "hermes").applied).toBe(false);
  // An uninstalled client collapses to the not-installed badge, as the badge
  // component already did, so the grid and the counts cannot disagree.
  expect(rowById(rows, "kimi").state).toBe("not-installed");
  expect(rowById(rows, "kimi").installed).toBe(false);
  expect(rowById(rows, "gajae").state).toBe("unsafe");

  const counts = countOverviewRows(rows.rows);
  expect(counts.detected).toBe(5);
  expect(counts.applied).toBe(2);
  expect(counts.stale).toBe(1);
});

test("every client counts toward the summary, not just shared file clients", () => {
  const rows = buildOverviewRows(sources({
    opencode: opencode("applied"),
    codex: { routingInjected: true, status: "at-risk" },
    keyCount: 2,
    claude: { enabled: true },
    claudeDesktop: { desiredEnabled: true, installed: true, applied: true, stale: true, activeProfile: true },
    native: [{
      clientId: "claude-desktop",
      state: "current",
      installed: true,
      configPath: "/tmp/desktop",
      desiredEnabled: true,
      disableBlocked: null,
    }, {
      clientId: "claude",
      state: "current",
      installed: true,
      configPath: "/tmp/config",
      desiredEnabled: true,
      disableBlocked: null,
    }, {
      clientId: "grok",
      state: "current",
      installed: true,
      configPath: "/tmp/grok",
      desiredEnabled: true,
      disableBlocked: null,
    }],
    grok: { present: true, models: [{}, {}] },
  }));
  const counts = countOverviewRows(rows.rows);
  // codex + claude + desktop + grok + opencode. Keys are deliberately absent:
  // an issued credential is not an applied client.
  expect(counts.applied).toBe(5);
  expect(counts.stale).toBe(1);
  expect(counts.unknown).toBe(0);
});

test("an unsettled file list renders unknown rows instead of dropping them", () => {
  const built = buildOverviewRows(sources({ clients: [], clientsSettled: false }));
  expect(built.rows).toHaveLength(10);
  expect(rowById(built, "kimi").state).toBe("unknown");

  // Once settled, a client the server omitted is genuinely gone.
  const settled = buildOverviewRows(sources({ clients: [], clientsSettled: true }));
  expect(settled.rows).toHaveLength(5);
  expect(settled.rows.some(row => row.hash === "integrations/keys")).toBe(false);
});

test("dedicated OpenCode status preserves the richer writer semantics", () => {
  const applied = buildOverviewRows(sources({ opencode: opencode("applied") }));
  expect(rowById(applied, "opencode")).toMatchObject({
    state: "current",
    installed: true,
    applied: true,
    toggle: null,
    detail: "~/.config/opencode/opencode.jsonc",
  });

  const modified = buildOverviewRows(sources({ opencode: opencode("modified") }));
  expect(rowById(modified, "opencode")).toMatchObject({ state: "stale", applied: true });

  const attention = buildOverviewRows(sources({
    opencode: opencode("needs_attention", { canRestore: true, tokenReady: false }),
  }));
  expect(rowById(attention, "opencode")).toMatchObject({ state: "unsafe", applied: true });

  const noJournal = buildOverviewRows(sources({
    opencode: opencode("needs_attention", { canRestore: false, tokenReady: false }),
  }));
  expect(rowById(noJournal, "opencode")).toMatchObject({ state: "unsafe", applied: false });
});

test("each row points at its own tab", () => {
  const rows = buildOverviewRows(sources({ clientsSettled: false }));
  expect(rowById(rows, "codex").hash).toBe("integrations/codex");
  expect(rowById(rows, "claude").hash).toBe("integrations/claude");
  expect(rowById(rows, "claudeDesktop").hash).toBe("integrations/claude/desktop");
  expect(rowById(rows, "grok").hash).toBe("integrations/grok");
  expect(rowById(rows, "hermes").hash).toBe("integrations/hermes");
});

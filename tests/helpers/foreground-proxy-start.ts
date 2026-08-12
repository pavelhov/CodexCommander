import type { ForegroundProxyStartIo } from "../../src/cli/foreground-proxy";
import type { ProxyLifecycleAuthority } from "../../src/server/proxy-lifecycle-authority";
import type { CodexCommanderConfig } from "../../src/types";

export const foregroundProxyTestConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: {
    mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
  },
} as CodexCommanderConfig;

function makeAuthority(): ProxyLifecycleAuthority {
  const ensure = { token: "ensure", release: () => {} };
  const start = { token: "start", release: () => {} };
  return {
    deadlineAt: 1_000,
    ensure,
    start,
    acquireStart: async () => start,
    delegatedLease: () => ({ ensureToken: "ensure", startToken: "start" }),
    releaseStart: () => {},
    releaseAll: () => {},
  };
}

/** Safe injected defaults for exercising foreground startup without live lifecycle actions. */
export function foregroundProxyStartIo(
  overrides: ForegroundProxyStartIo = {},
): ForegroundProxyStartIo {
  return {
    env: {},
    logger: { log: () => {}, error: () => {} },
    loadServiceToken: () => null,
    acquireAuthority: async () => makeAuthority(),
    loadConfig: () => foregroundProxyTestConfig,
    readPid: () => null,
    removePid: () => {},
    removeRuntimePort: () => {},
    writePid: () => {},
    writeRuntimePort: () => {},
    findLive: async () => null,
    routing: {
      externalProvider: () => null,
      journalPending: () => false,
      setEnabled: (_client, enabled) => ({ ok: true, status: "unchanged", enabled }),
    },
    externalProvider: () => null,
    choosePort: async () => 19191,
    startServer: (() => ({})) as NonNullable<ForegroundProxyStartIo["startServer"]>,
    scheduleCatalogPrewarm: () => {},
    installCrashGuards: () => {},
    createAttestationSecret: () => "local-attestation-secret",
    startGuardian: () => ({ stop: () => {} }),
    isRecyclingForExit: () => false,
    revertSystemEnv: () => {},
    restoreNative: () => ({
      success: true,
      changed: true,
      desiredChanged: true,
      configChanged: true,
      message: "native",
    }),
    serviceEnvironmentOwnedHere: () => false,
    stripGrok: () => ({ ok: true, changed: false, message: "native" }),
    drainAndShutdown: async () => {},
    initializationIo: {
      sleep: async () => {},
      injectSystemEnv: async () => {},
      syncCodexOnStart: async () => ({
        ran: false,
        catalogWritten: false,
        cacheSynced: false,
      }),
      buildDesktopRegistry: async () => {},
      shouldSyncGrok: () => false,
      ensureCompanion: async () => false,
    },
    onSignal: () => {},
    onExit: () => {},
    ...overrides,
  };
}

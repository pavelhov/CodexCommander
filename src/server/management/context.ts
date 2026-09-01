import type { CodexCommanderConfig } from "../../types";
import type { NativeProfileApiDeps } from "../../codex/native-profile-api";
import type { ResolveCodexRuntimeResult } from "../../codex/runtime";
import type { StartupHealth } from "../../codex/autostart-health";
import type { StartupInstallAction } from "../startup-action-control";
import type { ManagementPrincipal } from "../management-auth";
import type { CatalogModel } from "../../codex/catalog";
import type { injectGrokConfig } from "../../grok/inject";
import type { removeDesktop3pStandardPivot, writeDesktop3pConfig } from "../../claude/desktop-3p";
import type { RuntimePortState } from "../../config";
import type { CatalogDisposition, ConvergeCodex } from "../../codex/convergence-types";
import type { syncModelsToCodex } from "../../codex/sync";
import type {
  collectCodexAppServerCatalogState,
  resetCodexAppServerCatalogStateCache,
} from "../../codex/app-server-processes";
import type { applyCodexCatalogWorkers } from "../../codex/catalog-apply";
import type {
  CodexCatalogArtifactProof,
  CodexCatalogDesiredSnapshot,
} from "../../codex/catalog-activation";
import type { ReadinessGate } from "../readiness";
import type { CodexRoutingKind } from "../../codex/inject";
import type { reconcileManagementNativeSubagentDefaults } from "../../codex/management-native-defaults";
import type {
  AcquireProxyLifecycleAuthorityOptions,
  ProxyLifecycleAuthority,
} from "../proxy-lifecycle-authority";
import type { ProxyLifecycleLockLease } from "../proxy-lifecycle-protocol";
import type { inspectCodexDelegation, mutateCodexDelegation } from "../../codex/delegation-installer";
import type { MediaManagementRuntime } from "./media-routes";

export interface ManagementApiDeps {
  /** Server-owned durable media state. Tests inject a fully isolated implementation. */
  mediaManagement?: MediaManagementRuntime;
  /** Delegation installer seams keep management-route tests off user-owned homes. */
  inspectCodexDelegation?: typeof inspectCodexDelegation;
  mutateCodexDelegation?: typeof mutateCodexDelegation;
  /** Shared lifecycle seams for Stop, native routing, and full-sync serialization tests. */
  proxyStopLifecycle?: {
    acquireAuthority?: (
      options?: AcquireProxyLifecycleAuthorityOptions,
    ) => Promise<ProxyLifecycleAuthority>;
    validateLease?: (lease: ProxyLifecycleLockLease) => boolean;
    prepareShutdown?: (options?: {
      allowInstalledServiceStop?: boolean;
      serviceAlreadyStopped?: boolean;
    }) => {
      accepted: boolean;
      status: 200 | 409;
      success: boolean;
      message: string;
    };
    drain?: (server: undefined, timeoutMs: number) => Promise<void>;
    schedule?: (callback: () => void | Promise<void>, delayMs: number) => unknown;
    exit?: (code: number) => never | void;
  };
  resolveCodexRuntime?: () => ResolveCodexRuntimeResult;
  getCachedStartupHealth?: (config: Pick<CodexCommanderConfig, "codexAutoStart">) => Promise<StartupHealth>;
  toggleCodexMultiAgentV2?: (enabled: boolean) => void;
  toggleDefaultModeRequestUserInput?: (enabled: boolean) => void;
  createManagementConvergeCodex?: (config: Readonly<CodexCommanderConfig>) => ConvergeCodex;
  /**
   * Claude agent-definition sync seam for route tests. Production leaves this
   * unset and uses the real best-effort writer; tests with in-memory configs
   * must not rewrite the user's ~/.claude/agents directory.
   */
  syncClaudeAgentDefsBestEffort?: () => Promise<void> | void;
  /**
   * Persistence seam for route-level tests. Production leaves this unset and uses
   * `saveConfigPreservingClaudeCode`; tests that pass an in-memory fixture config
   * MUST inject a no-op/spy so the fixture can never overwrite the user's real
   * CODEXCOMMANDER_HOME (incident: implementation contract).
   */
  saveConfigPreservingClaudeCode?: (config: CodexCommanderConfig) => void;
  /**
   * Catalog seam for the Grok toggle (WP2, implementation contract
   * Rev 3 N2). Production leaves this unset and the route dynamic-imports the
   * real one — a static import would close a cycle with management-api.ts.
   * Tests stub it to orphan the fixture file mid-fetch (the r7 recheck test).
   */
  fetchAllModels?: (config: CodexCommanderConfig) => Promise<CatalogModel[]>;
  /**
   * Native-model catalog seam for Grok route tests. Resolving the real bundled
   * Codex catalog may spawn the selected Codex runtime, so fixture-only tests
   * supply a deterministic list instead of touching host runtime state.
   */
  visibleNativeSlugs?: (config: Pick<CodexCommanderConfig, "disabledModels">) => string[];
  /**
   * Writer seam for the Grok toggle: lets a test place the file in any state
   * between the pre-write recheck and the write itself (the r8 post-inspection
   * tests). Production leaves this unset and uses the real writer.
   */
  injectGrokConfig?: typeof injectGrokConfig;
  /** Desktop mutation seams keep route tests inside temporary config libraries. */
  removeDesktop3pStandardPivot?: typeof removeDesktop3pStandardPivot;
  writeDesktop3pConfig?: typeof writeDesktop3pConfig;
  /**
   * Runtime-state seam: the fence must name the host/port the RUNNING process
   * bound (agent-settings-routes.ts:99-103 pattern), and a test must not depend
   * on the developer's real runtime state file.
   */
  readRuntimePort?: (pid: number) => RuntimePortState | null;
  /**
   * Fixed /api/sync seams keep route-level serialization tests off the host's
   * real Codex process table while production continues to use the native
   * implementations. The reset and collect functions are separate so tests
   * can still assert their ordering.
   */
  syncModelsToCodex?: typeof syncModelsToCodex;
  resetCodexAppServerCatalogStateCache?: typeof resetCodexAppServerCatalogStateCache;
  collectCodexAppServerCatalogState?: typeof collectCodexAppServerCatalogState;
  applyCodexCatalogWorkers?: typeof applyCodexCatalogWorkers;
  /** Atomic desired-config + generation seam for Apply race tests. */
  captureCatalogDesiredSnapshotForActivation?: () => CodexCatalogDesiredSnapshot;
  /** Exact catalog/cache proof seam for activation route tests. */
  catalogArtifactProofForActivation?: () => CodexCatalogArtifactProof;
  /** Read-only native routing observation seam for activation route tests. */
  codexRoutingKindForActivation?: () => CodexRoutingKind;
  /** Fresh routing-document observation seam for the narrow status route. */
  getCodexRoutingKind?: () => CodexRoutingKind;
  /** Non-disruptive native-default writer seam for injection-model route tests. */
  reconcileManagementNativeSubagentDefaults?: typeof reconcileManagementNativeSubagentDefaults;
  /** Fresh persisted desired-state reader for the consent/revision fence. */
  loadConfigForCatalogActivation?: () => CodexCommanderConfig;
  clearThreadAccountMap?: () => void;
  clearProviderQuotaCache?: () => void;
  primeCodexPoolQuotas?: (config: CodexCommanderConfig, reason: string) => Promise<void> | void;
  runStartupInstallAction?: (
    action: StartupInstallAction,
    options?: { repair?: boolean },
  ) => Promise<{ message: string }>;
  /**
   * Native-main profile persistence seam for server-boundary tests. Production
   * leaves this unset, so the route creates its normal NativeProfileManager.
   */
  nativeProfileApi?: NativeProfileApiDeps;
  /**
   * The live server's private readiness gate. Direct-dispatch tests may inject
   * the same narrow capability; no diagnostic text or mutable state is exposed.
   */
  readinessGate?: Pick<ReadinessGate, "recoverReady">;
}


export interface ManagementContext {
  req: Request;
  url: URL;
  config: CodexCommanderConfig;
  deps: ManagementApiDeps;
  /**
   * Which credential authorized this request, resolved by the auth gate before
   * dispatch. Routes that spend the USER's identity (not just the proxy's) must
   * branch on this instead of on request headers: the admin token is readable by
   * anything running as the user, so a token holder can forge any header a route
   * might otherwise treat as browser evidence. Undefined only in direct-dispatch
   * tests, which are treated as the untrusted `admin-token` case.
   */
  principal?: ManagementPrincipal;
  convergeCodexCatalog: (configOverride?: Readonly<CodexCommanderConfig>) => Promise<CatalogDisposition>;
  syncClaudeAgentDefsBestEffort: () => Promise<void>;
}

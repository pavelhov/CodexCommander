import {
  ensureProxyLifecycle,
  restoreBackRoutingLifecycle,
  restartProxyLifecycle,
  type EnsureProxyLifecycleIo,
  type ProxyLifecycleLogger,
  type ProxyLifecycleResult,
  type RoutingLifecycleIo,
} from "./proxy-lifecycle";

export type RecoveryLifecycleEntrypoint =
  | "cli-ensure"
  | "tray-start"
  | "tray-restart"
  | "gui"
  | "cli-restart"
  | "route-back"
  | "macos-ensure"
  | "macos-start";

export interface RecoveryLifecycleDispatchOptions {
  logger?: ProxyLifecycleLogger;
  ensureIo?: EnsureProxyLifecycleIo;
  routingIo?: RoutingLifecycleIo;
}

export interface RecoveryLifecycleDispatchDeps {
  ensureProxyLifecycle?: typeof ensureProxyLifecycle;
  restartProxyLifecycle?: typeof restartProxyLifecycle;
  restoreBackRoutingLifecycle?: typeof restoreBackRoutingLifecycle;
}

/** Dispatch lifecycle entrypoints that are allowed to replace an attested stale runtime. */
export async function dispatchRecoveryLifecycleEntrypoint(
  entrypoint: RecoveryLifecycleEntrypoint,
  options: RecoveryLifecycleDispatchOptions = {},
  deps: RecoveryLifecycleDispatchDeps = {},
): Promise<ProxyLifecycleResult> {
  const ensure = deps.ensureProxyLifecycle ?? ensureProxyLifecycle;
  const restart = deps.restartProxyLifecycle ?? restartProxyLifecycle;
  const restoreBack = deps.restoreBackRoutingLifecycle ?? restoreBackRoutingLifecycle;

  switch (entrypoint) {
    case "cli-ensure":
      return ensure({
        honorAutoStart: true,
        ensureCompanion: true,
        replaceStaleRuntime: true,
        logger: options.logger,
      });
    case "tray-start":
      return ensure({
        action: "start",
        honorAutoStart: false,
        ensureCompanion: false,
        replaceStaleRuntime: true,
        logger: options.logger,
      });
    case "gui":
      return ensure({
        honorAutoStart: false,
        ensureCompanion: true,
        replaceStaleRuntime: true,
        logger: options.logger,
      });
    case "macos-ensure":
      return ensure({
        action: "ensure",
        honorAutoStart: false,
        ensureCompanion: false,
        replaceStaleRuntime: true,
      });
    case "macos-start":
      return ensure({
        action: "start",
        honorAutoStart: false,
        ensureCompanion: false,
        replaceStaleRuntime: true,
        io: options.ensureIo,
      });
    case "tray-restart":
      return restart({
        ensureCompanion: false,
        replaceStaleRuntime: true,
        logger: options.logger,
      });
    case "cli-restart":
      return restart({
        ensureCompanion: true,
        replaceStaleRuntime: true,
        logger: options.logger,
      });
    case "route-back":
      return restoreBack({
        ...options.routingIo,
        replaceStaleRuntime: true,
      });
  }
}

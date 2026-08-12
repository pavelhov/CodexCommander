import Foundation

public enum RestartOutcome: Equatable, Sendable {
    case restarted
    case failed(String)
}

public enum ProxyControlOutcome: Equatable, Sendable {
    case running
    case stopped
    /// The proxy is healthy, but long-lived Codex workers still hold an older roster.
    case catalogUpdateReady(staleWorkerCount: Int?)
    case failed(String)
}

/// Result of switching Codex's configuration through the fixed lifecycle helper.
/// The helper's `ok` field is authoritative; the menu app does not infer routing
/// success from proxy health or keep a second copy of routing state.
public enum CodexRouteOutcome: Equatable, Sendable {
    case completed(String)
    case failed(message: String, errorCode: String?)
}

public struct CodexCatalogApplySummary: Equatable, Sendable {
    public let catalogUpdated: Bool
    public let stoppedWorkerCount: Int

    public init(catalogUpdated: Bool, stoppedWorkerCount: Int) {
        self.catalogUpdated = catalogUpdated
        self.stoppedWorkerCount = stoppedWorkerCount
    }
}

public enum CodexCatalogApplyOutcome: Equatable, Sendable {
    case applied(CodexCatalogApplySummary)
    case incomplete(message: String, stoppedWorkerCount: Int, survivingWorkerCount: Int)
    case failed(String)
}

/// Executes confirm-gated lifecycle actions through the fixed structured helper.
public actor ActionCoordinator {
    private let lifecycle: any LifecycleCommandRunning

    public init(
        lifecycle: any LifecycleCommandRunning = LifecycleHelper()
    ) {
        self.lifecycle = lifecycle
    }

    public func ensure() async -> ProxyControlOutcome {
        await runLifecycle(.ensure, expected: .running)
    }

    public func start() async -> ProxyControlOutcome {
        await runLifecycle(.start, expected: .running)
    }

    public func stop() async -> ProxyControlOutcome {
        await runLifecycle(.stop, expected: .stopped)
    }

    public func restoreNativeCodex() async -> CodexRouteOutcome {
        await runCodexRoute(.restoreNative)
    }

    public func routeCodexThroughProxy() async -> CodexRouteOutcome {
        await runCodexRoute(.restoreBack)
    }

    private func runLifecycle(
        _ action: LifecycleAction,
        expected: LifecycleState
    ) async -> ProxyControlOutcome {
        do {
            let result = try await lifecycle.run(action)
            if result.state == .running, result.codexRestartRequired == true {
                return .catalogUpdateReady(staleWorkerCount: result.staleWorkerCount)
            }
            guard result.ok, result.state == expected else {
                return .failed(result.message)
            }
            return expected == .running ? .running : .stopped
        } catch let error as LifecycleHelperError {
            return .failed(error.userMessage)
        } catch {
            return .failed("CodexCommander lifecycle control failed.")
        }
    }

    private func runCodexRoute(_ action: LifecycleAction) async -> CodexRouteOutcome {
        do {
            let result = try await lifecycle.run(action)
            guard result.ok else {
                return .failed(message: result.message, errorCode: result.errorCode)
            }
            return .completed(result.message)
        } catch let error as LifecycleHelperError {
            return .failed(message: error.userMessage, errorCode: nil)
        } catch {
            return .failed(
                message: "CodexCommander could not update the Codex route.",
                errorCode: nil
            )
        }
    }

    /// Applies the current model catalog and restarts only Codex's catalog-caching
    /// workers through the fixed lifecycle bridge. The CodexCommander proxy is untouched.
    public func applyCodexCatalog() async -> CodexCatalogApplyOutcome {
        do {
            let result = try await lifecycle.run(.applyCodexCatalog)
            let stopped = result.stoppedWorkerCount ?? 0
            let surviving = result.survivingWorkerCount ?? 0
            // A stale worker may coexist with a refused or failed catalog write. The
            // write failure is authoritative: never describe that result as applied.
            if !result.ok, result.errorCode == "SYNC_FAILED" {
                return .failed(result.message)
            }
            if surviving > 0 || result.codexRestartRequired == true {
                return .incomplete(
                    message: result.message,
                    stoppedWorkerCount: stopped,
                    survivingWorkerCount: surviving
                )
            }
            guard result.ok,
                  result.state == .running || result.state == .stopped,
                  let catalogUpdated = result.catalogUpdated
            else {
                return .failed(result.message)
            }
            return .applied(CodexCatalogApplySummary(
                catalogUpdated: catalogUpdated,
                stoppedWorkerCount: stopped
            ))
        } catch let error as LifecycleHelperError {
            return .failed(error.userMessage)
        } catch {
            return .failed("CodexCommander could not apply the agent catalog update.")
        }
    }

    /// The lifecycle helper owns stop/start serialization and replacement verification.
    /// Its structured `ok` + `state` result is the only success authority in the app.
    public func restart() async -> RestartOutcome {
        do {
            let result = try await lifecycle.run(.restart)
            guard result.ok, result.state == .running else {
                return .failed(result.message)
            }
            return .restarted
        } catch let error as LifecycleHelperError {
            return .failed(error.userMessage)
        } catch {
            return .failed("CodexCommander could not restart.")
        }
    }

}

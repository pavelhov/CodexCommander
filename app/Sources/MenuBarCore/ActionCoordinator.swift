import Foundation

public protocol ProxyActionClient: Sendable {
    var currentEndpoint: ProxyEndpoint { get async }
    func restart() async throws -> RestartAccepted
    func liveness(timeout: TimeInterval) async -> ProxyClient.Liveness
}

extension ProxyClient: ProxyActionClient {}

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

/// Executes the panel's confirm-gated restart and reports what actually happened.
///
/// Split from the UI because the interesting behaviour is timing, not presentation: a
/// 202 means accepted, while success requires an identity-validated replacement process.
public actor ActionCoordinator {
    public static let pollInterval: TimeInterval = 0.5

    private let client: any ProxyActionClient
    private let lifecycle: any LifecycleCommandRunning
    private let sleeper: @Sendable (TimeInterval) async -> Void
    /// Injected so tests can advance time without waiting for it. A no-op sleeper alone
    /// is not enough: the loop is bounded by a deadline, so the clock has to move too.
    private let now: @Sendable () -> Date

    public init(
        client: any ProxyActionClient,
        lifecycle: any LifecycleCommandRunning = LifecycleHelper(),
        sleeper: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.client = client
        self.lifecycle = lifecycle
        self.sleeper = sleeper
        self.now = now
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

    /// Requests the proxy's owned drain-and-restart path and waits for a replacement
    /// CodexCommander identity. A 202 only means accepted; success requires a newly
    /// identity-validated process (or a refused interval followed by a valid process
    /// when no prior pid was discoverable).
    public func restart() async -> RestartOutcome {
        let previousPID = await client.currentEndpoint.expectedPID
        let accepted: RestartAccepted
        do {
            accepted = try await client.restart()
        } catch let error as ProxyError {
            return .failed(error.userMessage)
        } catch {
            return .failed("CodexCommander could not accept the restart request.")
        }
        guard accepted.success else {
            return .failed("CodexCommander refused the restart request.")
        }

        let drainSeconds = TimeInterval(accepted.drainTimeoutMs) / 1_000
        let deadline = now().addingTimeInterval(min(max(drainSeconds + 15, 20), 80))
        var sawRefused = false
        while now() < deadline {
            await sleeper(Self.pollInterval)
            let remaining = deadline.timeIntervalSince(now())
            guard remaining > 0 else { break }
            switch await client.liveness(timeout: min(1.5, remaining)) {
            case .refused:
                sawRefused = true
            case .reachable(let pid):
                if let previousPID {
                    if pid != previousPID { return .restarted }
                } else if sawRefused {
                    return .restarted
                }
            case .indeterminate:
                continue
            }
        }
        return .failed(
            "Restart was accepted, but a replacement CodexCommander process could not be confirmed. Check Logs or run `ccx status`."
        )
    }

}

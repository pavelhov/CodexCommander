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

/// Executes the panel's confirm-gated restart and reports what actually happened.
///
/// Split from the UI because the interesting behaviour is timing, not presentation: a
/// 202 means accepted, while success requires an identity-validated replacement process.
public actor ActionCoordinator {
    public static let pollInterval: TimeInterval = 0.5

    private let client: any ProxyActionClient
    private let sleeper: @Sendable (TimeInterval) async -> Void
    /// Injected so tests can advance time without waiting for it. A no-op sleeper alone
    /// is not enough: the loop is bounded by a deadline, so the clock has to move too.
    private let now: @Sendable () -> Date

    public init(
        client: any ProxyActionClient,
        sleeper: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.client = client
        self.sleeper = sleeper
        self.now = now
    }

    /// Requests the proxy's owned drain-and-restart path and waits for a replacement
    /// OpenCodex identity. A 202 only means accepted; success requires a newly
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
            return .failed("OpenCodex could not accept the restart request.")
        }
        guard accepted.success else {
            return .failed("OpenCodex refused the restart request.")
        }

        let drainSeconds = TimeInterval(accepted.drainTimeoutMs ?? 60_000) / 1_000
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
            "Restart was accepted, but a replacement OpenCodex process could not be confirmed. Check Logs or run `ocx status`."
        )
    }

}

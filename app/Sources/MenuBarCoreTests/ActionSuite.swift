import Foundation
import MenuBarCore

private actor FakeActionClient: ProxyActionClient {
    let currentEndpoint: ProxyEndpoint
    private var restartResult: Result<RestartAccepted, Error>
    private var livenessQueue: [ProxyClient.Liveness]
    private(set) var livenessCalls = 0
    private(set) var restartCalls = 0

    init(
        oldPID: Int? = 42,
        restartResult: Result<RestartAccepted, Error> = .success(
            RestartAccepted(
                success: true,
                activeTurnCount: 0,
                drainTimeoutMs: 0,
                alreadyDraining: false
            )
        ),
        liveness: [ProxyClient.Liveness]
    ) {
        currentEndpoint = ProxyEndpoint(
            host: "127.0.0.1",
            port: 10100,
            expectedPID: oldPID
        )!
        self.restartResult = restartResult
        self.livenessQueue = liveness
    }

    func restart() async throws -> RestartAccepted {
        restartCalls += 1
        return try restartResult.get()
    }

    func liveness(timeout: TimeInterval) async -> ProxyClient.Liveness {
        livenessCalls += 1
        return livenessQueue.isEmpty ? .indeterminate : livenessQueue.removeFirst()
    }

    func counts() -> (restart: Int, liveness: Int) {
        (restartCalls, livenessCalls)
    }
}

private actor FakeLifecycleRunner: LifecycleCommandRunning {
    private var results: [LifecycleCommandResult]
    private(set) var actions: [LifecycleAction] = []

    init(results: [LifecycleCommandResult]) {
        self.results = results
    }

    func run(_ action: LifecycleAction) async throws -> LifecycleCommandResult {
        actions.append(action)
        if results.isEmpty {
            return LifecycleCommandResult(
                action: action,
                ok: false,
                state: .failed,
                changed: false,
                message: "No result"
            )
        }
        return results.removeFirst()
    }

    func recordedActions() -> [LifecycleAction] { actions }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant = Date(timeIntervalSince1970: 1_000)

    func now() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return instant
    }

    func advance(_ seconds: TimeInterval) {
        lock.lock()
        instant = instant.addingTimeInterval(seconds)
        lock.unlock()
    }
}

enum ActionSuite {
    static func run(_ t: TestRunner) {
        t.test("restart: a 202 is not success until a replacement pid is validated") {
            let client = FakeActionClient(liveness: [
                .reachable(pid: 42),
                .refused,
                .reachable(pid: 43),
            ])
            let clock = TestClock()
            let coordinator = ActionCoordinator(
                client: client,
                sleeper: { seconds in clock.advance(max(seconds, 1)) },
                now: { clock.now() }
            )
            let result = sync { await coordinator.restart() }
            t.equal(result, .restarted)
            let counts = sync { await client.counts() }
            t.equal(counts.restart, 1)
            t.equal(counts.liveness, 3)
        }

        t.test("restart: the old process staying alive is reported as unconfirmed") {
            let client = FakeActionClient(liveness: Array(repeating: .reachable(pid: 42), count: 30))
            let clock = TestClock()
            let coordinator = ActionCoordinator(
                client: client,
                sleeper: { _ in clock.advance(5) },
                now: { clock.now() }
            )
            let result = sync { await coordinator.restart() }
            if case .failed(let message) = result {
                t.expect(message.contains("could not be confirmed"), "unexpected message: \(message)")
            } else {
                t.expect(false, "same pid must not be reported as restarted")
            }
        }

        t.test("restart: without an old pid, refusal then valid identity proves replacement") {
            let client = FakeActionClient(
                oldPID: nil,
                liveness: [.refused, .reachable(pid: 99)]
            )
            let clock = TestClock()
            let coordinator = ActionCoordinator(
                client: client,
                sleeper: { _ in clock.advance(1) },
                now: { clock.now() }
            )
            t.equal(sync { await coordinator.restart() }, .restarted)
        }

        t.test("restart: an explicit refusal never enters replacement polling") {
            let client = FakeActionClient(
                restartResult: .success(RestartAccepted(success: false)),
                liveness: [.reachable(pid: 43)]
            )
            let coordinator = ActionCoordinator(client: client)
            let result = sync { await coordinator.restart() }
            if case .failed(let message) = result {
                t.expect(message.contains("refused"), "unexpected message: \(message)")
            } else {
                t.expect(false, "an explicit refusal must fail")
            }
            t.equal(sync { await client.counts() }.liveness, 0)
        }

        t.test("lifecycle: ensure, start, and stop use the fixed helper actions") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .ensure, ok: true, state: .running,
                    changed: true, pid: 41, port: 10100, message: "running"
                ),
                LifecycleCommandResult(
                    action: .start, ok: true, state: .running,
                    changed: false, pid: 41, port: 10100, message: "running"
                ),
                LifecycleCommandResult(
                    action: .stop, ok: true, state: .stopped,
                    changed: true, message: "stopped"
                ),
            ])
            let coordinator = ActionCoordinator(
                client: FakeActionClient(liveness: []),
                lifecycle: lifecycle
            )
            t.equal(sync { await coordinator.ensure() }, .running)
            t.equal(sync { await coordinator.start() }, .running)
            t.equal(sync { await coordinator.stop() }, .stopped)
            t.equal(
                sync { await lifecycle.recordedActions() },
                [.ensure, .start, .stop]
            )
        }

        t.test("lifecycle: a helper refusal is surfaced without changing its message") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .stop, ok: false, state: .blocked,
                    changed: false, message: "Service ownership blocked the stop."
                ),
            ])
            let coordinator = ActionCoordinator(
                client: FakeActionClient(liveness: []),
                lifecycle: lifecycle
            )
            t.equal(
                sync { await coordinator.stop() },
                .failed("Service ownership blocked the stop.")
            )
        }

        t.test("lifecycle: a live proxy with stale Codex workers becomes update-ready") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .ensure, ok: false, state: .running,
                    changed: true, pid: 41, port: 10100,
                    message: "Restart ChatGPT to load the routed models.",
                    errorCode: "CODEX_RESTART_REQUIRED",
                    codexRestartRequired: true,
                    staleWorkerCount: 2
                ),
            ])
            let coordinator = ActionCoordinator(
                client: FakeActionClient(liveness: []),
                lifecycle: lifecycle
            )
            t.equal(
                sync { await coordinator.ensure() },
                .catalogUpdateReady(staleWorkerCount: 2)
            )
        }

        t.test("lifecycle: restart-like error codes without the additive flag remain failures") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .ensure, ok: false, state: .running,
                    changed: false, pid: 41, port: 10100,
                    message: "Legacy Codex restart required.",
                    errorCode: "CODEX_RESTART_REQUIRED"
                ),
                LifecycleCommandResult(
                    action: .ensure, ok: false, state: .running,
                    changed: false, pid: 41, port: 10100,
                    message: "Proxy restart required.",
                    errorCode: "PROXY_RESTART_REQUIRED"
                ),
            ])
            let coordinator = ActionCoordinator(
                client: FakeActionClient(liveness: []),
                lifecycle: lifecycle
            )
            t.equal(
                sync { await coordinator.ensure() },
                .failed("Legacy Codex restart required.")
            )
            t.equal(
                sync { await coordinator.ensure() },
                .failed("Proxy restart required.")
            )
        }

        t.test("catalog apply: uses the fixed helper action and returns counts") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .applyCodexCatalog, ok: true, state: .running,
                    changed: true, pid: 41, port: 10100,
                    message: "Agent catalog updated.",
                    catalogUpdated: true,
                    codexRestartRequired: false,
                    stoppedWorkerCount: 2,
                    survivingWorkerCount: 0
                ),
            ])
            let coordinator = ActionCoordinator(
                client: FakeActionClient(liveness: []),
                lifecycle: lifecycle
            )
            t.equal(
                sync { await coordinator.applyCodexCatalog() },
                .applied(CodexCatalogApplySummary(
                    catalogUpdated: true,
                    stoppedWorkerCount: 2
                ))
            )
            t.equal(
                sync { await lifecycle.recordedActions() },
                [.applyCodexCatalog]
            )
        }

        t.test("catalog apply: surviving workers remain an incomplete update") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .applyCodexCatalog, ok: false, state: .running,
                    changed: true, pid: 41, port: 10100,
                    message: "One Codex worker is still running.",
                    catalogUpdated: true,
                    codexRestartRequired: true,
                    stoppedWorkerCount: 1,
                    survivingWorkerCount: 1
                ),
            ])
            let coordinator = ActionCoordinator(
                client: FakeActionClient(liveness: []),
                lifecycle: lifecycle
            )
            t.equal(
                sync { await coordinator.applyCodexCatalog() },
                .incomplete(
                    message: "One Codex worker is still running.",
                    stoppedWorkerCount: 1,
                    survivingWorkerCount: 1
                )
            )
        }

        t.test("catalog apply: a sync failure wins over stale surviving workers") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .applyCodexCatalog, ok: false, state: .running,
                    changed: false, pid: 41, port: 10100,
                    message: "Agent catalog update did not complete.",
                    errorCode: "SYNC_FAILED",
                    catalogUpdated: false,
                    codexRestartRequired: true,
                    staleWorkerCount: 2,
                    stoppedWorkerCount: 0,
                    survivingWorkerCount: 2
                ),
            ])
            let coordinator = ActionCoordinator(
                client: FakeActionClient(liveness: []),
                lifecycle: lifecycle
            )
            t.equal(
                sync { await coordinator.applyCodexCatalog() },
                .failed("Agent catalog update did not complete.")
            )
        }

    }

    private static func sync<T>(_ operation: @escaping () async -> T) -> T {
        let semaphore = DispatchSemaphore(value: 0)
        let box = ResultBox<T>()
        Task {
            box.value = await operation()
            semaphore.signal()
        }
        semaphore.wait()
        return box.value!
    }

    private final class ResultBox<T>: @unchecked Sendable {
        var value: T?
    }
}

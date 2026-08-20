import Foundation
import MenuBarCore

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

enum ActionSuite {
    static func run(_ t: TestRunner) {
        t.test("lifecycle: Codex route actions use the fixed bridge spellings") {
            t.equal(LifecycleAction.restoreNative.rawValue, "restore-native")
            t.equal(LifecycleAction.restoreBack.rawValue, "restore-back")
        }

        t.test("restart: delegates to the fixed helper and trusts its running result") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .restart, ok: true, state: .running,
                    changed: true, pid: 43, port: 10100,
                    message: "CodexCommander proxy restarted."
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
            t.equal(sync { await coordinator.restart() }, .restarted)
            t.equal(sync { await lifecycle.recordedActions() }, [.restart])
        }

        t.test("restart: surfaces a structured helper refusal") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .restart, ok: false, state: .blocked,
                    changed: false, message: "Lifecycle coordination is busy."
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
            t.equal(
                sync { await coordinator.restart() },
                .failed("Lifecycle coordination is busy.")
            )
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
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
            t.equal(sync { await coordinator.ensure() }, .running)
            t.equal(sync { await coordinator.start() }, .running)
            t.equal(sync { await coordinator.stop() }, .stopped)
            t.equal(
                sync { await lifecycle.recordedActions() },
                [.ensure, .start, .stop]
            )
        }

        t.test("lifecycle: direct companion launch starts routing; passive CLI launch only ensures") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .start, ok: true, state: .running,
                    changed: true, pid: 41, port: 10100, message: "running"
                ),
                LifecycleCommandResult(
                    action: .ensure, ok: true, state: .running,
                    changed: false, pid: 41, port: 10100, message: "running"
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
            t.equal(
                sync { await CompanionLaunchPolicy.run(
                    using: coordinator,
                    arguments: ["CodexCommanderMenuBar"]
                ) },
                .running
            )
            t.equal(
                sync { await CompanionLaunchPolicy.run(
                    using: coordinator,
                    arguments: ["CodexCommanderMenuBar", companionPassiveLaunchArgument]
                ) },
                .running
            )
            t.equal(sync { await lifecycle.recordedActions() }, [.start, .ensure])
        }

        t.test("lifecycle: a helper refusal is surfaced without changing its message") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .stop, ok: false, state: .blocked,
                    changed: false, message: "Service ownership blocked the stop."
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
            t.equal(
                sync { await coordinator.stop() },
                .failed("Service ownership blocked the stop.")
            )
        }

        t.test("lifecycle: Codex route controls delegate to helper results") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .restoreNative, ok: true, state: .running,
                    changed: true, pid: 41, port: 10100,
                    message: "Codex now uses its native OpenAI route."
                ),
                LifecycleCommandResult(
                    action: .restoreBack, ok: true, state: .running,
                    changed: true, pid: 41, port: 10100,
                    message: "Codex now routes through CodexCommander."
                ),
                LifecycleCommandResult(
                    action: .restoreNative, ok: false, state: .blocked,
                    changed: false,
                    message: "Codex configuration was unchanged.",
                    errorCode: "ROUTING_RECOVERY_REQUIRED"
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)

            t.equal(
                sync { await coordinator.restoreNativeCodex() },
                .completed("Codex now uses its native OpenAI route.")
            )
            t.equal(
                sync { await coordinator.routeCodexThroughProxy() },
                .completed("Codex now routes through CodexCommander.")
            )
            t.equal(
                sync { await coordinator.restoreNativeCodex() },
                .failed(
                    message: "Codex configuration was unchanged.",
                    errorCode: "ROUTING_RECOVERY_REQUIRED"
                )
            )
            t.equal(
                sync { await lifecycle.recordedActions() },
                [.restoreNative, .restoreBack, .restoreNative]
            )
        }

        t.test("lifecycle: a live proxy with stale Codex workers becomes update-ready") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .ensure, ok: false, state: .running,
                    changed: true, pid: 41, port: 10100,
                    message: "Restart ChatGPT to load the routed models.",
                    errorCode: "CODEX_RESTART_REQUIRED",
                    setupRequired: "codex-first-run",
                    codexRestartRequired: true,
                    staleWorkerCount: 2
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
            t.equal(
                sync { await coordinator.ensure() },
                .catalogUpdateReady(staleWorkerCount: 2)
            )
        }

        t.test("lifecycle: known setup requirement becomes a typed outcome") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .start, ok: true, state: .running,
                    changed: true, pid: 41, port: 10100,
                    message: "Complete Codex setup to continue.",
                    setupRequired: "codex-first-run"
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
            t.equal(
                sync { await coordinator.start() },
                .setupRequired(.codexFirstRun)
            )
        }

        t.test("lifecycle: unknown setup requirement remains forward-compatible") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .start, ok: true, state: .running,
                    changed: false, pid: 41, port: 10100,
                    message: "Complete a future setup step.",
                    setupRequired: "future-setup"
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
            t.equal(
                sync { await coordinator.start() },
                .setupRequired(.unknown("future-setup"))
            )
        }

        t.test("lifecycle: restart-like error codes without the additive flag remain failures") {
            let lifecycle = FakeLifecycleRunner(results: [
                LifecycleCommandResult(
                    action: .ensure, ok: false, state: .running,
                    changed: false, pid: 41, port: 10100,
                    message: "Codex restart required.",
                    errorCode: "CODEX_RESTART_REQUIRED"
                ),
                LifecycleCommandResult(
                    action: .ensure, ok: false, state: .running,
                    changed: false, pid: 41, port: 10100,
                    message: "Proxy restart required.",
                    errorCode: "SYNC_FAILED"
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
            t.equal(
                sync { await coordinator.ensure() },
                .failed("Codex restart required.")
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
                    staleWorkerCount: 2,
                    stoppedWorkerCount: 2,
                    survivingWorkerCount: 0
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
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
                    staleWorkerCount: 2,
                    stoppedWorkerCount: 1,
                    survivingWorkerCount: 1
                ),
            ])
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
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
            let coordinator = ActionCoordinator(lifecycle: lifecycle)
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

import Foundation
import MenuBarCore

enum SnapshotStateSuite {
    private static func health(_ status: String?, service: Bool = false) -> StartupHealth {
        StartupHealth(
            status: status,
            protection: service ? "service" : "none",
            serviceInstalled: service,
            serviceEnabled: service
        )
    }

    static func run(_ t: TestRunner) {
        let endpoint = ProxyEndpoint.default

        t.test("state: every state has a word, so colour is never the only signal") {
            let states: [ProxyState] = [
                .loading, .running(health("protected")), .unreachable,
                .unauthorized, .degraded("boom"),
            ]
            for state in states {
                t.expect(!state.title.isEmpty, "state \(state) must have a title")
            }
            t.equal(ProxyState.unreachable.title, "Stopped")
            t.equal(ProxyState.unauthorized.title, "Authentication unavailable")
        }

        t.test("state: an unprotected but running proxy reads as a warning, not healthy") {
            t.equal(ProxyState.running(health("protected")).tone, .good)
            t.equal(ProxyState.running(health("at-risk")).tone, .warning)
            t.equal(ProxyState.unreachable.tone, .bad)
        }

        // loading is the one state with nothing to act on; every other non-running
        // state must name a next step rather than dead-ending the user.
        t.test("actions: loading has none, and every other non-running state names one") {
            let loading = ProxySnapshot(state: .loading, endpoint: endpoint)
            t.equal(loading.nextAction, NextAction.none)

            let unauthorized = ProxySnapshot(state: .unauthorized, endpoint: endpoint)
            t.equal(unauthorized.nextAction, NextAction.openDashboard)

            let degraded = ProxySnapshot(state: .degraded("x"), endpoint: endpoint)
            t.equal(degraded.nextAction, NextAction.retry)
        }

        t.test("actions: a stopped proxy offers the start command for its own install") {
            let plain = ProxySnapshot(state: .unreachable, endpoint: endpoint)
            t.equal(plain.nextAction, NextAction.runCommand("ocx start"))

            let managed = ProxySnapshot(
                state: .unreachable, endpoint: endpoint,
                lastKnownStartCommand: "ocx service start"
            )
            t.equal(managed.nextAction, NextAction.runCommand("ocx service start"))
        }

        t.test("state: the running detail line drops empty and 'none' qualifiers") {
            let protectedDetail = ProxyState.running(health("protected", service: true)).detail
            t.equal(protectedDetail, "protected · service")
            // protection "none" is noise, not information.
            t.equal(ProxyState.running(health("at-risk")).detail, "at-risk")
        }

        t.test("snapshot: provider summaries remain available to dashboard handoffs") {
            let providers = try JSONDecoder().decode(
                [ProviderSummary].self,
                from: Data(#"[{"name":"openai"},{"name":"anthropic"}]"#.utf8)
            )
            let snapshot = ProxySnapshot(
                state: .running(health("protected")), endpoint: endpoint,
                providers: providers
            )
            t.equal(snapshot.providers, providers)
        }

        t.test("polling: the interval backs off only after repeated failures") {
            t.equal(PollingCoordinator.openInterval, 2)
            t.equal(PollingCoordinator.closedInterval, 30)
            t.equal(PollingCoordinator.heavyInterval, 60)
            t.equal(PollingCoordinator.backoffInterval, 30)
            t.equal(PollingCoordinator.backoffAfterFailures, 3)
        }
    }
}

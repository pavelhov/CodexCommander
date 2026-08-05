import Foundation
import MenuBarCore

enum PollingSuite {
    private static let identity =
        #"{"status":"ok","service":"opencodex","version":"2.10.0","pid":42,"port":10100}"#

    static func run(_ t: TestRunner) {
        t.test("polling: closed uses a slow health cadence; open loads activity and quotas") {
            StubProtocol.reset(openResponses())
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret")
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)

            t.equal(sync { await coordinator.currentInterval }, PollingCoordinator.closedInterval)
            sync { await coordinator.setPopoverOpen(true) }
            let snapshot = sync { await coordinator.current }
            t.equal(sync { await coordinator.currentInterval }, PollingCoordinator.openInterval)
            t.equal(snapshot.state.isRunning, true)
            t.equal(snapshot.activityLoaded, true)
            t.equal(snapshot.activity?.activities.count, 2)
            t.equal(snapshot.quotasLoaded, true)
            t.equal(snapshot.quotas.count, 2)

            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 200, body: #"{"status":"protected"}"#),
                .init(status: 200, body: identity),
                .init(status: 200, body: """
                    {"schemaVersion":1,"generatedAt":3,"proxyState":"active",
                     "activeTurnCount":1,"displayedActivityCount":1,
                     "unattributedActiveCount":0,"truncated":false,"activities":[
                       {"id":"new","role":"primary","model":"fresh-model",
                        "phase":"running","startedAt":3}]}
                    """),
            ])
            sync { await coordinator.refresh() }
            t.equal(sync { await coordinator.current }.activity?.activities.first?.model, "fresh-model")

            sync { await coordinator.setPopoverOpen(false) }
            t.equal(sync { await coordinator.currentInterval }, PollingCoordinator.closedInterval)
            t.equal(sync { await coordinator.current }.activityLoaded, false)
        }

        t.test("polling: connection refusal is stopped; repeated failures back off") {
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            StubProtocol.reset([
                .init(status: 0, urlError: .cannotConnectToHost),
                .init(status: 0, urlError: .cannotConnectToHost),
                .init(status: 0, urlError: .cannotConnectToHost),
            ])
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret")
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
            sync { await coordinator.refresh() }
            sync { await coordinator.refresh() }
            sync { await coordinator.refresh() }
            let snapshot = sync { await coordinator.current }
            t.equal(snapshot.state, .unreachable)
            t.equal(snapshot.consecutiveFailures, 3)
            t.equal(sync { await coordinator.currentInterval }, PollingCoordinator.backoffInterval)
        }

        t.test("polling: activity failures do not erase successful quota data") {
            var responses = openResponses()
            // The third logical response is activity's management response (index 3
            // after health/startup-health and activity health).
            responses[3] = .init(status: 500)
            StubProtocol.reset(responses)
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret")
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
            sync { await coordinator.setPopoverOpen(true) }
            let snapshot = sync { await coordinator.current }
            t.equal(snapshot.activityLoaded, false)
            t.equal(snapshot.quotasLoaded, true)
            t.equal(snapshot.quotas.count, 2)
        }
    }

    private static func openResponses() -> [StubProtocol.Response] {
        let activity = """
        {"schemaVersion":1,"generatedAt":1780000000000,"proxyState":"active",
         "activeTurnCount":2,"displayedActivityCount":2,"unattributedActiveCount":0,
         "truncated":false,"activities":[
           {"id":"a","role":"primary","model":"gpt-5.6-sol","phase":"running","startedAt":1},
           {"id":"b","parentId":"a","role":"subagent","model":"k3","phase":"starting","startedAt":2}]}
        """
        let quotas = """
        {"generatedAt":1780000000000,"reports":[
          {"provider":"openai","label":"ChatGPT","quota":{"fiveHourPercent":38,"weeklyPercent":22}},
          {"provider":"kimi","label":"Kimi","quota":{"weeklyPercent":41}}]}
        """
        func pair(_ body: String) -> [StubProtocol.Response] {
            [.init(status: 200, body: identity), .init(status: 200, body: body)]
        }
        return pair(#"{"status":"protected"}"#)
            + pair(activity)
            + pair(#"[{"name":"openai"},{"name":"kimi"}]"#)
            + pair(quotas)
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

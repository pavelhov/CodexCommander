import Foundation
import MenuBarCore

enum PollingSuite {
    private static let identity =
        #"{"status":"ok","service":"codexcommander","version":"0.1.0","pid":42,"port":10100}"#

    static func run(_ t: TestRunner) {
        t.test("polling: closed uses a slow health cadence; open loads activity and quotas") {
            StubProtocol.reset(openResponses())
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)

            t.equal(sync { await coordinator.currentInterval }, PollingCoordinator.closedInterval)
            sync { await coordinator.setPopoverOpen(true) }
            let snapshot = sync { await coordinator.current }
            t.equal(sync { await coordinator.currentInterval }, PollingCoordinator.openInterval)
            t.equal(snapshot.state.isRunning, true)
            t.equal(snapshot.readiness, .ready)
            t.equal(snapshot.activityLoaded, true)
            t.equal(snapshot.activity?.activities.count, 2)
            t.equal(snapshot.quotasLoaded, true)
            t.equal(snapshot.quotas.count, 2)
            t.equal(snapshot.quotaAvailability.count, 1)
            t.equal(snapshot.quotaAvailability[0].reason, .localCLIRefreshRequired)

            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 200, body: startupHealth(status: "protected", diagnosticStale: false)),
                readinessResponse(status: "ready"),
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
                credentials: StaticCredentialStore("admin-secret"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
            sync { await coordinator.refresh() }
            sync { await coordinator.refresh() }
            sync { await coordinator.refresh() }
            let snapshot = sync { await coordinator.current }
            t.equal(snapshot.state, .unreachable)
            t.equal(snapshot.readiness, .unavailable)
            t.equal(snapshot.consecutiveFailures, 3)
            t.equal(sync { await coordinator.currentInterval }, PollingCoordinator.backoffInterval)
        }

        t.test("polling: stale startup health stays neutral until revalidation completes") {
            StubProtocol.reset(
                startupResponses(startupHealth(status: "at-risk", diagnosticStale: true))
                    + startupResponses(startupHealth(status: "protected", diagnosticStale: false))
            )
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)

            sync { await coordinator.refresh() }
            t.equal(sync { await coordinator.current }.state, .loading)
            t.equal(
                sync { await coordinator.currentInterval },
                PollingCoordinator.revalidationInterval
            )

            sync { await coordinator.refresh() }
            t.equal(sync { await coordinator.current }.state.isRunning, true)
            t.equal(sync { await coordinator.currentInterval }, PollingCoordinator.closedInterval)
        }

        t.test("polling: stale revalidation preserves the last known protected state") {
            StubProtocol.reset(
                startupResponses(startupHealth(status: "protected", diagnosticStale: false))
                    + startupResponses(startupHealth(status: "at-risk", diagnosticStale: true))
                    + startupResponses(startupHealth(status: "protected", diagnosticStale: false))
            )
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)

            sync { await coordinator.refresh() }
            let protected = sync { await coordinator.current }.state
            sync { await coordinator.refresh() }
            t.equal(sync { await coordinator.current }.state, protected)
            t.equal(
                sync { await coordinator.currentInterval },
                PollingCoordinator.revalidationInterval
            )

            sync { await coordinator.refresh() }
            t.equal(sync { await coordinator.current }.state.isRunning, true)
            t.equal(sync { await coordinator.currentInterval }, PollingCoordinator.closedInterval)
        }

        t.test("polling: persistently stale diagnostics eventually surface at-risk") {
            let stale = startupResponses(startupHealth(status: "at-risk", diagnosticStale: true))
            StubProtocol.reset(
                Array(
                    repeating: stale,
                    count: PollingCoordinator.maxDiagnosticStaleRefreshes + 1
                ).flatMap { $0 }
            )
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)

            for _ in 0...PollingCoordinator.maxDiagnosticStaleRefreshes {
                sync { await coordinator.refresh() }
            }
            let snapshot = sync { await coordinator.current }
            t.equal(snapshot.state, .running(try! JSONDecoder().decode(
                StartupHealth.self,
                from: Data(startupHealth(status: "at-risk", diagnosticStale: true).utf8)
            )))
            t.equal(sync { await coordinator.currentInterval }, PollingCoordinator.closedInterval)
        }

        t.test("polling: activity failures do not erase successful quota data") {
            var responses = openResponses()
            // Readiness follows startup health, so activity's management response is
            // index 4 (after health/startup-health/readyz and activity health).
            responses[4] = .init(status: 500)
            StubProtocol.reset(responses)
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
            sync { await coordinator.setPopoverOpen(true) }
            let snapshot = sync { await coordinator.current }
            t.equal(snapshot.activityLoaded, false)
            t.equal(snapshot.quotasLoaded, true)
            t.equal(snapshot.quotas.count, 2)
        }

        t.test("polling: pending readiness is separate from authenticated liveness") {
            StubProtocol.reset(startupResponses(
                startupHealth(status: "protected", diagnosticStale: false),
                readinessStatus: "pending"
            ))
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
            sync { await coordinator.refresh() }

            let snapshot = sync { await coordinator.current }
            t.equal(snapshot.state.isRunning, true)
            t.equal(snapshot.readiness, .pending)
            t.equal(snapshot.consecutiveFailures, 0)
        }

        t.test("polling: unavailable readiness does not overwrite successful liveness") {
            StubProtocol.reset(
                healthResponses(startupHealth(status: "protected", diagnosticStale: false))
                    + [.init(status: 0, urlError: .timedOut)]
            )
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
            sync { await coordinator.refresh() }

            let snapshot = sync { await coordinator.current }
            t.equal(snapshot.state.isRunning, true)
            t.equal(snapshot.readiness, .unavailable)
            t.equal(snapshot.consecutiveFailures, 0)
        }

        t.test("polling: manual refresh bypasses the proxy quota cache") {
            StubProtocol.reset(openResponses())
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
            sync { await coordinator.setPopoverOpen(true) }

            StubProtocol.reset(openResponses())
            sync { await coordinator.forceRefresh() }

            let quotaRequest = StubProtocol.recorded.first {
                $0.url?.path == "/api/provider-quotas"
            }
            let refreshValue = quotaRequest?.url.flatMap {
                URLComponents(url: $0, resolvingAgainstBaseURL: false)?
                    .queryItems?.first { $0.name == "refresh" }?.value
            }
            t.equal(refreshValue, "1")
        }

        t.test("polling: force refresh queued mid-cycle retains its cache bypass") {
            StubProtocol.reset(openResponses() + openResponses())
            let gate = StubProtocol.pauseNextRequest()
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("admin-secret"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
            let opening = Task { await coordinator.setPopoverOpen(true) }
            let started = gate.waitUntilStarted()
            guard started else {
                gate.resume()
                sync { await opening.value }
                t.equal(started, true)
                return
            }
            sync { await coordinator.forceRefresh() }
            gate.resume()
            sync { await opening.value }

            let quotaRequests = StubProtocol.recorded.filter {
                $0.url?.path == "/api/provider-quotas"
            }
            t.equal(quotaRequests.count, 2)
            let refreshValues = quotaRequests.map { request in
                request.url.flatMap {
                    URLComponents(url: $0, resolvingAgainstBaseURL: false)?
                        .queryItems?.first { $0.name == "refresh" }?.value
                }
            }
            t.isNil(refreshValues[0], "ordinary first-cycle quota query")
            t.equal(refreshValues[1], "1")
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
          {"provider":"openai","label":"ChatGPT","source":"test","updatedAt":1,"quota":{"updatedAt":1,"fiveHourPercent":38,"weeklyPercent":22}},
          {"provider":"kimi","label":"Kimi","source":"test","updatedAt":1,"quota":{"updatedAt":1,"weeklyPercent":41}}],
         "availability":[{"provider":"xai","status":"unavailable",
          "reason":"local_cli_refresh_required","checkedAt":1780000000000}]}
        """
        return startupResponses(startupHealth(status: "protected", diagnosticStale: false))
            + healthResponses(activity)
            + healthResponses(#"[{"name":"openai"},{"name":"kimi"}]"#)
            + healthResponses(quotas)
    }

    private static func healthResponses(_ body: String) -> [StubProtocol.Response] {
        [.init(status: 200, body: identity), .init(status: 200, body: body)]
    }

    private static func startupResponses(
        _ body: String,
        readinessStatus: String = "ready"
    ) -> [StubProtocol.Response] {
        healthResponses(body) + [readinessResponse(status: readinessStatus)]
    }

    private static func readinessResponse(status: String) -> StubProtocol.Response {
        .init(
            status: status == "ready" ? 200 : 503,
            body: """
            {"service":"codexcommander","version":"0.1.0","uptime":1,
             "pid":42,"port":10100,"status":"\(status)"}
            """
        )
    }

    private static func startupHealth(status: String, diagnosticStale: Bool) -> String {
        """
        {"status":"\(status)","routingKind":"codexcommander-local","routingInjected":true,
         "localRoutingDependency":true,"autostartEnabled":false,"rebootSafe":false,"protection":"none",
         "serviceInstalled":false,"serviceViable":false,"serviceEnabled":false,"serviceRunning":false,
         "serviceStale":false,"serviceConflict":false,"shimInstalled":false,"shimHealthy":false,
         "shimCoverage":"none","serviceSupported":true,"platform":"darwin","diagnosticStale":\(diagnosticStale),
         "recommendedCommand":"ccx service install","commands":{"installService":"ccx service install",
         "repairService":"ccx service repair","installShim":"ccx codex-shim install","restoreNative":"ccx restore"}}
        """
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

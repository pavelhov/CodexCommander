import Foundation
import MenuBarCore

final class StubProtocol: URLProtocol, @unchecked Sendable {
    final class RequestGate: @unchecked Sendable {
        private let started = DispatchSemaphore(value: 0)
        private let resumeSignal = DispatchSemaphore(value: 0)

        fileprivate func block() {
            started.signal()
            resumeSignal.wait()
        }

        func waitUntilStarted(timeout: TimeInterval = 2) -> Bool {
            started.wait(timeout: .now() + timeout) == .success
        }

        func resume() { resumeSignal.signal() }
    }

    struct Response {
        let status: Int
        let body: String
        let headers: [String: String]
        let urlError: URLError.Code?

        init(
            status: Int,
            body: String = "",
            headers: [String: String] = [:],
            urlError: URLError.Code? = nil
        ) {
            self.status = status
            self.body = body
            self.headers = headers
            self.urlError = urlError
        }
    }

    nonisolated(unsafe) private static var queue: [Response] = []
    nonisolated(unsafe) private static var requests: [URLRequest] = []
    nonisolated(unsafe) private static var nextGate: RequestGate?
    private static let lock = NSLock()

    static func reset(_ responses: [Response]) {
        lock.lock()
        queue = responses
        requests = []
        nextGate = nil
        lock.unlock()
    }

    static func pauseNextRequest() -> RequestGate {
        let gate = RequestGate()
        lock.lock()
        nextGate = gate
        lock.unlock()
        return gate
    }

    static var recorded: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requests.append(request)
        let response = Self.queue.isEmpty ? nil : Self.queue.removeFirst()
        let gate = Self.nextGate
        Self.nextGate = nil
        Self.lock.unlock()

        gate?.block()

        guard let response else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        if let code = response.urlError {
            client?.urlProtocol(self, didFailWithError: URLError(code))
            return
        }
        let http = HTTPURLResponse(
            url: request.url!,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: response.headers
        )!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(response.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
enum TransportSuite {
    private static let identity =
        #"{"status":"ok","service":"codexcommander","version":"0.1.0","pid":42,"port":10100}"#

    private static let startupHealth = #"{"status":"protected","routingKind":"codexcommander-local","routingInjected":true,"localRoutingDependency":true,"autostartEnabled":false,"rebootSafe":true,"protection":"service","serviceInstalled":true,"serviceViable":true,"serviceEnabled":true,"serviceRunning":true,"serviceStale":false,"serviceConflict":false,"shimInstalled":false,"shimHealthy":false,"shimCoverage":"none","serviceSupported":true,"platform":"darwin","diagnosticStale":false,"recommendedCommand":null,"commands":{"installService":"ccx service install","repairService":"ccx service repair","installShim":"ccx codex-shim install","restoreNative":"ccx restore"}}"#

    static func run(_ t: TestRunner) {
        t.test("transport: validates identity immediately before a credential-bearing request") {
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 200, body: startupHealth),
            ])
            let client = makeClient(credential: "admin-secret")
            let status: String? = sync { try? await client.health().status }
            t.equal(status, "protected")
            let requests = StubProtocol.recorded
            t.equal(requests.count, 2)
            t.equal(requests[0].url?.path, "/healthz")
            t.isNil(
                requests[0].value(forHTTPHeaderField: "x-codexcommander-api-key"),
                "health credential"
            )
            t.equal(requests[1].url?.path, "/api/startup-health")
            t.equal(
                requests[1].value(forHTTPHeaderField: "x-codexcommander-api-key"),
                "admin-secret"
            )
            let credentialHeaders = (requests[1].allHTTPHeaderFields ?? [:]).filter {
                $0.key.lowercased().hasSuffix("-api-key") && $0.value == "admin-secret"
            }
            t.equal(credentialHeaders.count, 1, "one management credential header")
        }

        t.test("transport: a foreign health response blocks the token completely") {
            StubProtocol.reset([
                .init(
                    status: 200,
                    body: #"{"status":"ok","service":"other","version":"1","pid":42,"port":10100}"#
                ),
            ])
            let client = makeClient(credential: "never-send")
            let error = sync { await proxyError { try await client.health() } }
            t.equal(error, .identityMismatch)
            t.equal(StubProtocol.recorded.count, 1)
            t.isNil(
                StubProtocol.recorded[0].value(forHTTPHeaderField: "x-codexcommander-api-key"),
                "foreign health credential"
            )
        }

        t.test("transport: missing management auth fails before networking") {
            StubProtocol.reset([])
            let client = makeClient(credential: nil)
            let error = sync { await proxyError { try await client.health() } }
            t.equal(error, .authenticationUnavailable)
            t.equal(StubProtocol.recorded.count, 0)
        }

        t.test("transport: a 401 gets one fresh identity check and one retry") {
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 401),
                .init(status: 200, body: identity),
                .init(status: 200, body: startupHealth),
            ])
            let client = makeClient(credential: "admin-secret")
            let status: String? = sync { try? await client.health().status }
            t.equal(status, "protected")
            t.equal(StubProtocol.recorded.map { $0.url?.path ?? "" }, [
                "/healthz", "/api/startup-health", "/healthz", "/api/startup-health",
            ])
        }

        t.test("transport: repeated 401s stop after the single retry") {
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 401),
                .init(status: 200, body: identity),
                .init(status: 401),
            ])
            let client = makeClient(credential: "stale")
            let error = sync { await proxyError { try await client.health() } }
            t.equal(error, .unauthorized)
            t.equal(StubProtocol.recorded.count, 4)
        }

        t.test("transport: redirects are not followed") {
            StubProtocol.reset([
                .init(
                    status: 302,
                    headers: ["Location": "http://example.com/steal"]
                ),
            ])
            let client = makeClient(credential: "admin-secret")
            let result = sync { await client.liveness() }
            t.equal(result, .indeterminate)
            t.equal(StubProtocol.recorded.count, 1)
            t.equal(StubProtocol.recorded[0].url?.host, "127.0.0.1")
        }

        t.test("transport: production session disables cache, cookies, credentials, and proxies") {
            let session = ProxyClient.secureSessionForTesting(
                protocolClasses: [StubProtocol.self]
            )
            let config = session.configuration
            t.isNil(config.urlCache, "urlCache")
            t.isNil(config.httpCookieStorage, "httpCookieStorage")
            t.isNil(config.urlCredentialStorage, "urlCredentialStorage")
            t.equal(config.httpShouldSetCookies, false)
            t.equal(config.connectionProxyDictionary?.isEmpty ?? true, true)
            t.equal(config.requestCachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
        }

        t.test("transport: response bodies never enter user-facing errors") {
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 500, body: "SECRET-CONFIG-VALUE"),
            ])
            let client = makeClient(credential: "admin-secret")
            let error = sync { await proxyError { try await client.health() } }
            t.equal(error, .http(500))
            t.expect(
                !(error?.userMessage.contains("SECRET") ?? false),
                "error text must not echo response bodies"
            )
        }

        t.test("transport: activity schema v1 decodes without raw identifiers") {
            let activity = """
            {"schemaVersion":1,"generatedAt":1780000000000,"proxyState":"active",
             "activeTurnCount":2,"displayedActivityCount":2,"unattributedActiveCount":0,
             "truncated":false,"activities":[
               {"id":"opaque-a","role":"primary","provider":"openai","model":"gpt-5.6-sol",
                "phase":"running","startedAt":1779999999000},
               {"id":"opaque-b","parentId":"opaque-a","role":"subagent","provider":"kimi",
                "model":"k3","phase":"starting","startedAt":1779999999500}]}
            """
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 200, body: activity),
            ])
            let client = makeClient(credential: "admin-secret")
            let snapshot: AgentActivitySnapshot? = sync { try? await client.activity() }
            t.equal(snapshot?.schemaVersion, 1)
            t.equal(snapshot?.activities.count, 2)
            t.equal(snapshot?.activities[1].parentId, "opaque-a")
            t.equal(snapshot?.activities[1].phase, .starting)
        }

        t.test("transport: companion startup report PUTs the locked body with the admin token") {
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 204),
            ])
            let client = makeClient(credential: "admin-secret")
            let outcome = sync { await proxyError {
                try await client.reportCompanionStartupState(launchAtLogin: .enabled)
            } }
            t.isNil(outcome, "a 204 is success")
            let requests = StubProtocol.recorded
            t.equal(requests.count, 2)
            t.equal(requests[1].httpMethod, "PUT")
            t.equal(requests[1].url?.path, "/api/startup-health/companion")
            t.equal(
                requests[1].value(forHTTPHeaderField: "x-codexcommander-api-key"),
                "admin-secret"
            )
            let bodyData = requests[1].httpBody
                ?? requestStreamBodyData(requests[1])
            let body = bodyData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            t.equal(body?["version"] as? Int, 1, "locked version")
            t.equal(body?["launchAtLogin"] as? String, "enabled", "wire launch-at-login value")
            t.equal(body?.count ?? 0, 2, "no client timestamps, TTLs, or metadata accepted")
        }

        t.test("transport: companion report maps every launch-at-login state to the wire contract") {
            t.equal(LaunchAtLoginStatus.enabled.companionWireValue, "enabled")
            t.equal(LaunchAtLoginStatus.disabled.companionWireValue, "disabled")
            t.equal(LaunchAtLoginStatus.requiresApproval.companionWireValue, "requires-approval")
            t.equal(LaunchAtLoginStatus.unavailable.companionWireValue, "unavailable")
        }

        t.test("transport: companion report failure surfaces as a proxy error, never a body") {
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 403, body: "COMPANION-SECRET-CONFIG"),
            ])
            let client = makeClient(credential: "admin-secret")
            let error = sync { await proxyError {
                try await client.reportCompanionStartupState(launchAtLogin: .enabled)
            } }
            t.equal(error, .http(403))
            t.expect(
                !(error?.userMessage.contains("COMPANION") ?? false),
                "error text must not echo response bodies"
            )
        }
    }

    private static func makeClient(credential: String?) -> ProxyClient {
        let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
        let session = ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self])
        return ProxyClient(
            endpoint: endpoint,
            session: session,
            credentials: StaticCredentialStore(credential)
        )
    }

    /// URLSession can move a small httpBody into httpBodyStream before the URLProtocol
    /// sees the request; drain whichever representation is present.
    private static func requestStreamBodyData(_ request: URLRequest) -> Data? {
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 1024
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    private static func proxyError<T>(
        _ operation: () async throws -> T
    ) async -> ProxyError? {
        do {
            _ = try await operation()
            return nil
        } catch let error as ProxyError {
            return error
        } catch {
            return nil
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

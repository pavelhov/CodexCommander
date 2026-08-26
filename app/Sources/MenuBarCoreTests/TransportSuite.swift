import Foundation
import CryptoKit
import MenuBarCore

final class StubProtocol: URLProtocol, @unchecked Sendable {
    static let attestationSecret = String(repeating: "S", count: 43)
    final class RequestGate: @unchecked Sendable {
        private let started = DispatchSemaphore(value: 0)
        private let resumeSignal = DispatchSemaphore(value: 0)
        fileprivate let asynchronous: Bool

        fileprivate init(asynchronous: Bool) {
            self.asynchronous = asynchronous
        }

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
        let automaticAttestation: Bool
        let attestationProtocol: Int?
        let metadataProofVersion: String?

        init(
            status: Int,
            body: String = "",
            headers: [String: String] = [:],
            urlError: URLError.Code? = nil,
            automaticAttestation: Bool = true,
            attestationProtocol: Int? = nil,
            metadataProofVersion: String? = nil
        ) {
            self.status = status
            self.body = body
            self.headers = headers
            self.urlError = urlError
            self.automaticAttestation = automaticAttestation
            self.attestationProtocol = attestationProtocol
            self.metadataProofVersion = metadataProofVersion
        }
    }

    nonisolated(unsafe) private static var queue: [Response] = []
    nonisolated(unsafe) private static var requests: [URLRequest] = []
    nonisolated(unsafe) private static var nextGate: RequestGate?
    nonisolated(unsafe) private static var nextGatePath: String?
    nonisolated(unsafe) private static var stoppedLoads = 0
    private static let lock = NSLock()

    static func reset(_ responses: [Response]) {
        lock.lock()
        queue = responses
        requests = []
        nextGate = nil
        nextGatePath = nil
        stoppedLoads = 0
        lock.unlock()
    }

    static func pauseNextRequest(
        path: String? = nil,
        asynchronously: Bool = false
    ) -> RequestGate {
        let gate = RequestGate(asynchronous: asynchronously)
        lock.lock()
        nextGate = gate
        nextGatePath = path
        lock.unlock()
        return gate
    }

    static var recorded: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    static var cancellationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return stoppedLoads
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requests.append(request)
        let response = Self.queue.isEmpty ? nil : Self.queue.removeFirst()
        let gateMatches = Self.nextGatePath == nil || Self.nextGatePath == request.url?.path
        let gate = gateMatches ? Self.nextGate : nil
        if gateMatches {
            Self.nextGate = nil
            Self.nextGatePath = nil
        }
        Self.lock.unlock()

        guard let response else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        if let gate, gate.asynchronous {
            DispatchQueue.global().async { [self] in
                gate.block()
                deliver(response)
            }
            return
        }
        gate?.block()
        deliver(response)
    }

    private func deliver(_ response: Response) {
        if let code = response.urlError {
            client?.urlProtocol(self, didFailWithError: URLError(code))
            return
        }
        var headers = response.headers
        if response.automaticAttestation,
           request.url?.path == "/healthz",
           headers["x-codexcommander-attestation-proof"] == nil,
           let proof = Self.attestationProof(
               request: request,
               body: response.body,
               protocolVersion: response.attestationProtocol,
               headers: headers,
               metadataProofVersion: response.metadataProofVersion
           ) {
            headers[response.attestationProtocol == 2
                ? "x-codexcommander-attestation-metadata-proof"
                : "x-codexcommander-attestation-proof"] = proof
        }
        let http = HTTPURLResponse(
            url: request.url!,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(response.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {
        Self.lock.lock()
        Self.stoppedLoads += 1
        Self.lock.unlock()
    }

    private static func attestationProof(
        request: URLRequest,
        body: String,
        protocolVersion: Int?,
        headers: [String: String],
        metadataProofVersion: String?
    ) -> String? {
        guard let challenge = request.value(
            forHTTPHeaderField: "x-codexcommander-attestation-challenge"
        ),
        challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
        let data = body.data(using: .utf8),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let pid = json["pid"] as? Int,
        let port = json["port"] as? Int
        else { return nil }
        let payload: String
        if protocolVersion == 2 {
            guard let version = metadataProofVersion ?? headers["x-codexcommander-runtime-version"],
                  let generation = headers["x-codexcommander-lifecycle-generation"]
            else { return nil }
            let lease = headers["x-codexcommander-lifecycle-lock-lease"] == "1" ? "1" : "0"
            payload = "codexcommander-local-management-v2\n\(challenge)\n\(pid)\n\(port)\n\(version)\n\(generation)\n\(lease)"
        } else {
            payload = "codexcommander-local-management-v1\n\(challenge)\n\(pid)\n\(port)"
        }
        let key = SymmetricKey(data: Data(attestationSecret.utf8))
        let digest = Data(HMAC<SHA256>.authenticationCode(
            for: Data(payload.utf8),
            using: key
        ))
        return digest.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private final class InstallationSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [ProxyInstallation]

    init(_ values: [ProxyInstallation]) { self.values = values }

    func next() throws -> ProxyInstallation {
        lock.lock()
        defer { lock.unlock() }
        guard !values.isEmpty else { throw ProxyError.identityMismatch }
        return values.removeFirst()
    }
}

enum TransportSuite {
    private static let identity =
        #"{"status":"ok","service":"codexcommander","version":"0.1.0","pid":42,"port":10100}"#

    private static let startupHealth = #"{"status":"protected","routingKind":"codexcommander-local","routingInjected":true,"localRoutingDependency":true,"autostartEnabled":false,"rebootSafe":true,"protection":"service","serviceInstalled":true,"serviceViable":true,"serviceEnabled":true,"serviceRunning":true,"serviceStale":false,"serviceConflict":false,"shimInstalled":false,"shimHealthy":false,"shimCoverage":"none","serviceSupported":true,"platform":"darwin","diagnosticStale":false,"recommendedCommand":null,"commands":{"installService":"ccx service install","repairService":"ccx service repair","installShim":"ccx codex-shim install","restoreNative":"ccx restore"}}"#

    private static func readinessBody(
        status: String,
        service: String = "codexcommander",
        version: String = "0.1.0",
        uptime: Double = 1,
        pid: Int = 42,
        port: Int = 10100
    ) -> String {
        """
        {"service":"\(service)","version":"\(version)","uptime":\(uptime),
         "pid":\(pid),"port":\(port),"status":"\(status)"}
        """
    }

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
            t.expect(
                requests[0].value(
                    forHTTPHeaderField: "x-codexcommander-attestation-challenge"
                )?.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                "health challenge"
            )
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

        t.test("transport: current v2 runtime accepts only metadata-bound health proof") {
            StubProtocol.reset([
                .init(
                    status: 200,
                    body: identity,
                    headers: [
                        "x-codexcommander-runtime-version": "1.2.3",
                        "x-codexcommander-lifecycle-generation": "2",
                        "x-codexcommander-lifecycle-lock-lease": "1",
                    ],
                    attestationProtocol: 2
                ),
                .init(status: 200, body: startupHealth),
            ])
            let client = makeClient(credential: "admin-secret", attestationProtocol: 2)
            let status: String? = sync { try? await client.health().status }
            t.equal(status, "protected")
        }

        t.test("transport: current v2 runtime rejects stripped or altered metadata proof") {
            for response in [
                StubProtocol.Response(status: 200, body: identity, automaticAttestation: false),
                StubProtocol.Response(
                    status: 200,
                    body: identity,
                    headers: [
                        "x-codexcommander-runtime-version": "9.9.9",
                        "x-codexcommander-lifecycle-generation": "2",
                    ],
                    attestationProtocol: 2,
                    metadataProofVersion: "1.2.3"
                ),
            ] {
                StubProtocol.reset([response])
                let client = makeClient(credential: "admin-secret", attestationProtocol: 2)
                let error = sync { await proxyError { try await client.health() } }
                t.equal(error, .identityMismatch)
                t.equal(StubProtocol.recorded.count, 1)
            }
            for generation in ["02", "9007199254740992"] {
                StubProtocol.reset([
                    .init(
                        status: 200,
                        body: identity,
                        headers: [
                            "x-codexcommander-runtime-version": "1.2.3",
                            "x-codexcommander-lifecycle-generation": generation,
                        ],
                        attestationProtocol: 2
                    ),
                ])
                let canonicalClient = makeClient(credential: "admin-secret", attestationProtocol: 2)
                let canonicalError = sync { await proxyError { try await canonicalClient.health() } }
                t.equal(canonicalError, .identityMismatch)
            }
        }

        t.test("transport: legacy runtime record remains compatible with v1 health proof") {
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 200, body: startupHealth),
            ])
            let client = makeClient(credential: "admin-secret")
            let status: String? = sync { try? await client.health().status }
            t.equal(status, "protected")
        }

        t.test("transport: fresh Codex route status uses the attested management path") {
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 200, body: #"{"schemaVersion":1,"routingKind":"native","routingInjected":false}"#),
            ])
            let client = makeClient(credential: "admin-secret")
            let route: CodexRouteStatus? = sync { try? await client.codexRouteStatus() }
            t.equal(route?.routingKind, .native)
            t.equal(route?.routingInjected, false)

            let requests = StubProtocol.recorded
            t.equal(requests.map { $0.url?.path ?? "" }, ["/healthz", "/api/codex-routing"])
            t.isNil(
                requests[0].value(forHTTPHeaderField: "x-codexcommander-api-key"),
                "attestation has no credential"
            )
            t.equal(
                requests[1].value(forHTTPHeaderField: "x-codexcommander-api-key"),
                "admin-secret"
            )
            t.equal(requests[1].cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
        }

        t.test("transport: public readiness accepts ready, pending, and failed without credentials") {
            StubProtocol.reset([
                .init(status: 200, body: readinessBody(status: "ready")),
                .init(status: 503, body: readinessBody(status: "pending")),
                .init(status: 503, body: readinessBody(status: "failed")),
            ])
            let client = makeClient(credential: "never-send-publicly")
            let ready = sync { try? await client.readiness() }
            let pending = sync { try? await client.readiness() }
            let failed = sync { try? await client.readiness() }
            t.equal(ready?.status, .ready)
            t.equal(pending?.status, .pending)
            t.equal(failed?.status, .failed)

            let requests = StubProtocol.recorded
            t.equal(requests.map { $0.url?.path ?? "" }, ["/readyz", "/readyz", "/readyz"])
            for request in requests {
                t.isNil(
                    request.value(forHTTPHeaderField: "x-codexcommander-api-key"),
                    "public readiness management credential"
                )
                t.isNil(
                    request.value(forHTTPHeaderField: "authorization"),
                    "public readiness authorization"
                )
            }
        }

        t.test("transport: readiness rejects foreign, stale, and inconsistent contracts") {
            let cases: [(String, Int, ProxyError, String)] = [
                (readinessBody(status: "ready", service: "other"), 200, .identityMismatch, "service"),
                (readinessBody(status: "ready", version: ""), 200, .identityMismatch, "version"),
                (readinessBody(status: "ready", uptime: -1), 200, .identityMismatch, "uptime"),
                (readinessBody(status: "ready", pid: 41), 200, .identityMismatch, "pid"),
                (readinessBody(status: "ready", port: 10101), 200, .identityMismatch, "port"),
                (readinessBody(status: "ready"), 503, .identityMismatch, "503 ready"),
                (readinessBody(status: "pending"), 200, .identityMismatch, "200 pending"),
                (readinessBody(status: "ready"), 500, .http(500), "unexpected HTTP"),
            ]
            for (body, status, expected, label) in cases {
                StubProtocol.reset([.init(status: status, body: body)])
                let client = makeClient(credential: "never-send-publicly")
                let error = sync { await proxyError { try await client.readiness() } }
                t.equal(error, expected, label)
                t.isNil(
                    StubProtocol.recorded.first?.value(
                        forHTTPHeaderField: "x-codexcommander-api-key"
                    ),
                    "\(label) credential"
                )
            }
        }

        t.test("transport: readiness rejects non-exact response shapes") {
            StubProtocol.reset([
                .init(
                    status: 200,
                    body: #"{"service":"codexcommander","version":"0.1.0","uptime":1,"pid":42,"port":10100,"status":"ready","detail":"not-public"}"#
                ),
            ])
            let client = makeClient(credential: "never-send-publicly")
            let error = sync { await proxyError { try await client.readiness() } }
            t.equal(error, .decoding)
            t.isNil(
                StubProtocol.recorded.first?.value(
                    forHTTPHeaderField: "x-codexcommander-api-key"
                ),
                "non-exact readiness credential"
            )
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

        t.test("transport: missing or wrong health proof exposes neither token nor body") {
            let cases: [(StubProtocol.Response, String)] = [
                (.init(
                    status: 200,
                    body: identity,
                    automaticAttestation: false
                ), "missing"),
                (.init(
                    status: 200,
                    body: identity,
                    headers: ["x-codexcommander-attestation-proof": String(repeating: "Z", count: 43)],
                    automaticAttestation: false
                ), "wrong"),
            ]
            for (response, label) in cases {
                StubProtocol.reset([response])
                let client = makeClient(credential: "never-send")
                let error = sync { await proxyError {
                    try await client.reportCompanionStartupState(launchAtLogin: .enabled)
                } }
                t.equal(error, .identityMismatch, label)
                t.equal(StubProtocol.recorded.count, 1, "\(label) request count")
                let request = StubProtocol.recorded[0]
                t.equal(request.url?.path, "/healthz", "\(label) path")
                t.isNil(
                    request.value(forHTTPHeaderField: "x-codexcommander-api-key"),
                    "\(label) credential"
                )
                t.isNil(request.httpBody, "\(label) body")
                t.isNil(request.httpBodyStream, "\(label) body stream")
            }
        }

        t.test("transport: attested health caps chunked and declared response bodies") {
            let prefix = identity.dropLast()
            let oversized = "\(prefix),\"padding\":\"\(String(repeating: "x", count: 20_000))\"}"
            let cases: [(StubProtocol.Response, String)] = [
                (.init(status: 200, body: oversized), "chunked"),
                (.init(
                    status: 200,
                    body: oversized,
                    headers: ["Content-Length": "20000"]
                ), "declared"),
            ]
            for (response, label) in cases {
                StubProtocol.reset([response])
                let client = makeClient(credential: "never-send")
                let error = sync { await proxyError { try await client.health() } }
                t.equal(error, .identityMismatch, label)
                t.equal(StubProtocol.recorded.count, 1, "\(label) request count")
                let request = StubProtocol.recorded[0]
                t.equal(request.url?.path, "/healthz", "\(label) path")
                t.isNil(
                    request.value(forHTTPHeaderField: "x-codexcommander-api-key"),
                    "\(label) credential"
                )
                t.isNil(request.httpBody, "\(label) body")
                t.isNil(request.httpBodyStream, "\(label) body stream")
                if label == "chunked" {
                    t.expect(StubProtocol.cancellationCount >= 1, "chunked response cancelled")
                }
            }
        }

        t.test("transport: config-source or pid-less discovery cannot receive a credential") {
            StubProtocol.reset([])
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100)!
            let client = ProxyClient(
                endpoint: endpoint,
                session: ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self]),
                credentials: StaticCredentialStore("never-send"),
                attestationSecret: StubProtocol.attestationSecret
            )
            let error = sync { await proxyError {
                try await client.reportCompanionStartupState(launchAtLogin: .enabled)
            } }
            t.equal(error, .identityMismatch)
            t.equal(StubProtocol.recorded.count, 0)
        }

        t.test("transport: runtime record rotation after proof blocks token and body") {
            let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
            let firstRuntime = ProxyRuntimeAttestation(
                host: endpoint.host,
                port: endpoint.port,
                pid: 42,
                secret: StubProtocol.attestationSecret
            )!
            let rotatedRuntime = ProxyRuntimeAttestation(
                host: endpoint.host,
                port: endpoint.port,
                pid: 42,
                secret: String(repeating: "R", count: 43)
            )!
            let first = ProxyInstallation(
                endpoint: endpoint,
                credential: "never-send",
                credentialAvailability: .file,
                configDirectory: URL(fileURLWithPath: "/"),
                runtimeAttestation: firstRuntime
            )
            let rotated = ProxyInstallation(
                endpoint: endpoint,
                credential: "never-send",
                credentialAvailability: .file,
                configDirectory: URL(fileURLWithPath: "/"),
                runtimeAttestation: rotatedRuntime
            )
            let sequence = InstallationSequence([first, rotated])
            let session = ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self])
            let client = try! ProxyClient(
                installation: first,
                session: session,
                discovery: { try sequence.next() }
            )
            StubProtocol.reset([.init(status: 200, body: identity)])
            let error = sync { await proxyError {
                try await client.reportCompanionStartupState(launchAtLogin: .enabled)
            } }
            t.equal(error, .identityMismatch)
            t.equal(StubProtocol.recorded.count, 1)
            let request = StubProtocol.recorded[0]
            t.equal(request.url?.path, "/healthz")
            t.isNil(request.value(forHTTPHeaderField: "x-codexcommander-api-key"), "credential")
            t.isNil(request.httpBody, "body")
            t.isNil(request.httpBodyStream, "body stream")
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
            t.equal(LaunchAtLoginStatus.notFound.companionWireValue, "unavailable")
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

        t.test("transport: confirmed GUI launch stays fragment-only and origin-bound") {
            let expiry = Date().timeIntervalSince1970 * 1_000 + 30_000
            let launch = """
            {"ticket":"ccx_launch_\(String(repeating: "a", count: 43))",\
             "origin":"http://127.0.0.1:10100","route":"subagents",\
             "expiresAt":\(expiry)}
            """
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(status: 200, body: launch),
            ])
            let client = makeClient(credential: "admin-secret")
            let url = sync { try? await client.confirmedGuiLaunchURL(route: "subagents") }
            t.equal(url?.scheme, "http")
            t.equal(url?.host, "127.0.0.1")
            t.equal(url?.port, 10100)
            let fragment = URLComponents(string: "http://local/?\(url?.fragment ?? "")")
            let items: [String: String] = Dictionary(uniqueKeysWithValues: (fragment?.queryItems ?? []).compactMap {
                guard let value = $0.value else { return nil }
                return ($0.name, value)
            })
            t.equal(items["ccx-route"], "subagents")
            t.equal(items["ccx-launch-ticket"], "ccx_launch_\(String(repeating: "a", count: 43))")

            let requests = StubProtocol.recorded
            t.equal(requests.map { $0.url?.path ?? "" }, ["/healthz", "/api/gui-launch-ticket"])
            t.equal(requests[1].value(forHTTPHeaderField: "x-codexcommander-api-key"), "admin-secret")
            let bodyData = requests[1].httpBody ?? requestStreamBodyData(requests[1])
            let body = bodyData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            t.equal(body?["route"] as? String, "subagents")
            t.expect(!(requests[1].url?.absoluteString.contains("ccx_launch_") ?? true), "ticket absent from request URL")
        }

        t.test("transport: a localhost response cannot change a 127.0.0.1 ticket origin") {
            let expiry = Date().timeIntervalSince1970 * 1_000 + 30_000
            StubProtocol.reset([
                .init(status: 200, body: identity),
                .init(
                    status: 200,
                    body: """
                    {"ticket":"ccx_launch_\(String(repeating: "b", count: 43))",\
                     "origin":"http://localhost:10100","route":"dashboard",\
                     "expiresAt":\(expiry)}
                    """
                ),
            ])
            let client = makeClient(credential: "admin-secret")
            let error = sync { await proxyError {
                try await client.confirmedGuiLaunchURL(route: "dashboard")
            } }
            t.equal(error, .identityMismatch)
        }
    }

    private static func makeClient(credential: String?, attestationProtocol: Int? = nil) -> ProxyClient {
        let endpoint = ProxyEndpoint(host: "127.0.0.1", port: 10100, expectedPID: 42)!
        let session = ProxyClient.secureSessionForTesting(protocolClasses: [StubProtocol.self])
        return ProxyClient(
            endpoint: endpoint,
            session: session,
            credentials: StaticCredentialStore(credential),
            attestationSecret: StubProtocol.attestationSecret,
            attestationProtocol: attestationProtocol
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

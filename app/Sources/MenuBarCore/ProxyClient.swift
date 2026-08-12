import Foundation
import CryptoKit

public enum ProxyError: Error, Equatable, Sendable {
    case unreachable
    case authenticationUnavailable
    case unauthorized
    case identityMismatch
    case http(Int)
    case decoding
    case transport
    case inconclusive

    public var userMessage: String {
        switch self {
        case .unreachable:
            return "The CodexCommander proxy is not running."
        case .authenticationUnavailable:
            return "Management authentication is unavailable. Run `ccx doctor`."
        case .unauthorized:
            return "CodexCommander rejected its management credential."
        case .identityMismatch:
            return "The local port did not identify itself as CodexCommander."
        case .http(let code):
            return "CodexCommander returned an unexpected status (\(code))."
        case .decoding:
            return "CodexCommander returned a response this app could not read."
        case .transport:
            return "The connection to CodexCommander failed."
        case .inconclusive:
            return "CodexCommander did not respond in time."
        }
    }
}

public protocol CredentialStore: Sendable {
    func loadAPIKey() -> String?
}

public struct StaticCredentialStore: CredentialStore {
    private let value: String?
    public init(_ value: String?) { self.value = value }
    public func loadAPIKey() -> String? { value }
}

private final class SecureSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}

private struct HealthIdentity: Decodable {
    let status: String
    let service: String
    let version: String
    let pid: Int
    let port: Int
}

private struct EmptyBody: Encodable {}

private struct GuiLaunchTicketRequest: Encodable {
    let route: String
}

private struct GuiLaunchTicketResponse: Decodable {
    let ticket: String
    let origin: String
    let route: String
    let expiresAt: Double
}

private let attestationChallengeHeader = "x-codexcommander-attestation-challenge"
private let attestationProofHeader = "x-codexcommander-attestation-proof"
private let attestedHealthBodyLimit = 16 * 1024

private func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func decodeBase64URL(_ value: String) -> Data? {
    guard value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
        return nil
    }
    var standard = value
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    standard += String(repeating: "=", count: (4 - standard.count % 4) % 4)
    return Data(base64Encoded: standard)
}

private func makeAttestationChallenge() -> String {
    let key = SymmetricKey(size: .bits256)
    return base64URL(key.withUnsafeBytes { Data($0) })
}

private func validAttestationProof(
    _ proof: String?,
    challenge: String,
    runtime: ProxyRuntimeAttestation
) -> Bool {
    guard let proof, let bytes = decodeBase64URL(proof) else { return false }
    let payload = "codexcommander-local-management-v1\n\(challenge)\n\(runtime.pid)\n\(runtime.port)"
    let key = SymmetricKey(data: Data(runtime.secret.utf8))
    return HMAC<SHA256>.isValidAuthenticationCode(
        bytes,
        authenticating: Data(payload.utf8),
        using: key
    )
}

public struct RestartAccepted: Decodable, Equatable, Sendable {
    public let success: Bool
    public let message: String
    public let activeTurnCount: Int
    public let drainTimeoutMs: Int
    public let alreadyDraining: Bool

    public init(
        success: Bool,
        message: String,
        activeTurnCount: Int,
        drainTimeoutMs: Int,
        alreadyDraining: Bool
    ) {
        self.success = success
        self.message = message
        self.activeTurnCount = activeTurnCount
        self.drainTimeoutMs = drainTimeoutMs
        self.alreadyDraining = alreadyDraining
    }
}

/// Body for `PUT /api/startup-health/companion`. The server accepts exactly this
/// locked shape: no client timestamps, TTLs, PIDs, paths, or bundle metadata.
public struct CompanionStartupReport: Encodable, Equatable, Sendable {
    public let version: Int
    public let launchAtLogin: String

    public init(launchAtLogin: String) {
        self.version = 1
        self.launchAtLogin = launchAtLogin
    }
}

public extension LaunchAtLoginStatus {
    /// Wire value for the companion report. The server contract is kebab-case
    /// (`requires-approval`), which differs from the Swift case raw values.
    var companionWireValue: String {
        switch self {
        case .enabled: return "enabled"
        case .disabled: return "disabled"
        case .requiresApproval: return "requires-approval"
        case .notFound: return "unavailable"
        case .unavailable: return "unavailable"
        }
    }
}

/// A management client that proves local CodexCommander identity immediately before every
/// credential-bearing request. Discovery is repeated for each request and retry, so a
/// restart never reuses stale descriptors, endpoint metadata, or token bytes.
public actor ProxyClient {
    public enum Liveness: Equatable, Sendable {
        case reachable(pid: Int)
        case refused
        case indeterminate
    }

    private let session: URLSession
    private let discovery: @Sendable () throws -> ProxyInstallation
    private let attestationChallenge: @Sendable () -> String
    private var installation: ProxyInstallation

    public init(
        installation: ProxyInstallation? = nil,
        session: URLSession? = nil,
        discovery: @escaping @Sendable () throws -> ProxyInstallation = {
            try ProxyDiscovery.discover()
        }
    ) throws {
        self.discovery = discovery
        self.installation = try installation ?? discovery()
        self.session = session ?? Self.secureSession()
        self.attestationChallenge = { makeAttestationChallenge() }
    }

    /// Deterministic initializer for transport tests. Production uses
    /// the discovery-backed initializer above.
    public init(
        endpoint: ProxyEndpoint,
        session: URLSession? = nil,
        credentials: CredentialStore,
        attestationSecret: String?
    ) {
        let credential = credentials.loadAPIKey()
        let fixed = ProxyInstallation(
            endpoint: endpoint,
            credential: credential,
            credentialAvailability: credential == nil ? .unavailable : .file,
            configDirectory: URL(fileURLWithPath: "/"),
            runtimeAttestation: attestationSecret.flatMap { secret in
                guard let pid = endpoint.expectedPID else { return nil }
                return ProxyRuntimeAttestation(
                    host: endpoint.host,
                    port: endpoint.port,
                    pid: pid,
                    secret: secret
                )
            }
        )
        self.installation = fixed
        self.discovery = { fixed }
        self.session = session ?? Self.secureSession()
        self.attestationChallenge = { makeAttestationChallenge() }
    }

    public var currentEndpoint: ProxyEndpoint { installation.endpoint }
    public var credentialAvailability: ManagementCredentialAvailability {
        installation.credentialAvailability
    }

    public func rediscover() throws {
        installation = try discovery()
    }

    /// Called whenever the panel opens. A successful fresh discovery naturally gives
    /// the next request a new one-retry budget.
    public func panelDidOpen() throws {
        try rediscover()
    }

    public func health() async throws -> StartupHealth {
        try await authenticatedGet("api/startup-health")
    }

    /// Fresh route truth, intentionally separate from cached startup diagnostics.
    public func codexRouteStatus() async throws -> CodexRouteStatus {
        try await authenticatedGet("api/codex-routing")
    }

    /// Public post-startup readiness. This request intentionally carries no management
    /// credential, and accepts the endpoint's contractually meaningful 503 response for
    /// `pending` and `failed` observations.
    public func readiness(timeout: TimeInterval = 1.5) async throws -> ProxyReadinessObservation {
        try rediscover()
        let current = installation
        let (data, response) = try await performResponse(
            installation: current,
            method: "GET",
            path: "readyz",
            query: [],
            body: nil as EmptyBody?,
            credential: nil,
            timeout: timeout
        )
        guard response.statusCode == 200 || response.statusCode == 503 else {
            throw ProxyError.http(response.statusCode)
        }

        let observation: ProxyReadinessObservation
        do {
            observation = try JSONDecoder().decode(ProxyReadinessObservation.self, from: data)
        } catch {
            throw ProxyError.decoding
        }

        guard observation.service == "codexcommander",
              !observation.version.isEmpty,
              observation.uptime.isFinite,
              observation.uptime >= 0,
              observation.pid > 0,
              observation.port >= 1,
              observation.port <= 65_535,
              observation.port == current.endpoint.port,
              current.endpoint.expectedPID == nil
                || current.endpoint.expectedPID == observation.pid,
              (observation.status == .ready && response.statusCode == 200)
                || (observation.status != .ready && response.statusCode == 503)
        else { throw ProxyError.identityMismatch }
        return observation
    }

    public func providers() async throws -> [ProviderSummary] {
        try await authenticatedGet("api/providers")
    }

    public func activity() async throws -> AgentActivitySnapshot {
        try await authenticatedGet("api/agent-activity")
    }

    public func quotas(forceRefresh: Bool = false) async throws -> ProviderQuotaEnvelope {
        try await authenticatedGet(
            "api/provider-quotas",
            query: forceRefresh ? [URLQueryItem(name: "refresh", value: "1")] : []
        )
    }

    public func restart() async throws -> RestartAccepted {
        let data = try await authenticatedSend(
            method: "POST",
            path: "api/system/restart",
            body: nil as EmptyBody?
        )
        do {
            return try JSONDecoder().decode(RestartAccepted.self, from: data)
        } catch {
            throw ProxyError.decoding
        }
    }

    /// Mint a short-lived, single-use browser handoff through the attested admin
    /// channel. The returned bearer lives only in the URL fragment and is handed
    /// directly to NSWorkspace; it is never persisted or logged by the app.
    public func confirmedGuiLaunchURL(route: String) async throws -> URL {
        guard !route.isEmpty,
              route.count <= 512,
              !route.hasPrefix("/"),
              !route.contains("#"),
              route.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
        else { throw ProxyError.decoding }

        let data = try await authenticatedSend(
            method: "POST",
            path: "api/gui-launch-ticket",
            body: GuiLaunchTicketRequest(route: route)
        )
        let ticket: GuiLaunchTicketResponse
        do {
            ticket = try JSONDecoder().decode(GuiLaunchTicketResponse.self, from: data)
        } catch {
            throw ProxyError.decoding
        }
        let now = Date().timeIntervalSince1970 * 1_000
        guard ticket.route == route,
              ticket.ticket.range(
                of: #"^ccx_launch_[A-Za-z0-9_-]{43}$"#,
                options: .regularExpression
              ) != nil,
              ticket.expiresAt > now,
              ticket.expiresAt <= now + 60_000,
              var origin = URLComponents(string: ticket.origin),
              origin.scheme == "http",
              ProxyEndpoint.normalizedLoopbackHost(origin.host) != nil,
              origin.host?.lowercased() == installation.endpoint.baseURL.host?.lowercased(),
              origin.port == installation.endpoint.port,
              origin.path.isEmpty || origin.path == "/",
              origin.query == nil,
              origin.fragment == nil
        else { throw ProxyError.identityMismatch }

        var fragment = URLComponents()
        fragment.queryItems = [
            URLQueryItem(name: "ccx-launch-ticket", value: ticket.ticket),
            URLQueryItem(name: "ccx-route", value: route),
        ]
        origin.percentEncodedFragment = fragment.percentEncodedQuery
        guard let url = origin.url else { throw ProxyError.decoding }
        return url
    }

    /// Advisory launch-at-login report to the proxy (`PUT /api/startup-health/companion`).
    /// Success is a 204 with no body; callers treat any thrown error as non-blocking.
    public func reportCompanionStartupState(launchAtLogin: LaunchAtLoginStatus) async throws {
        let payload = CompanionStartupReport(launchAtLogin: launchAtLogin.companionWireValue)
        _ = try await authenticatedSend(
            method: "PUT",
            path: "api/startup-health/companion",
            body: payload
        )
    }

    public func liveness(timeout: TimeInterval = 1.5) async -> Liveness {
        do {
            try rediscover()
            let identity = try await validateHealthIdentity(
                installation: installation,
                timeout: timeout
            )
            return .reachable(pid: identity.pid)
        } catch ProxyError.unreachable {
            return .refused
        } catch {
            return .indeterminate
        }
    }

    private static func secureSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 8
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.connectionProxyDictionary = [:]
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        let delegate = SecureSessionDelegate()
        return URLSession(
            configuration: configuration,
            delegate: delegate,
            delegateQueue: nil
        )
    }

    /// Test seam that retains every production transport hardening option while
    /// replacing only URL loading with a deterministic URLProtocol.
    public nonisolated static func secureSessionForTesting(
        protocolClasses: [AnyClass]
    ) -> URLSession {
        secureSession(protocolClasses: protocolClasses)
    }

    private func authenticatedGet<T: Decodable>(
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws -> T {
        let data = try await authenticatedSend(
            method: "GET",
            path: path,
            query: query,
            body: nil as EmptyBody?
        )
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ProxyError.decoding
        }
    }

    private func authenticatedSend<Body: Encodable>(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Body?
    ) async throws -> Data {
        // First attempt: fresh descriptors + identity check immediately before the
        // credential-bearing request.
        try rediscover()
        do {
            return try await authenticatedAttempt(
                installation: installation,
                method: method,
                path: path,
                query: query,
                body: body
            )
        } catch ProxyError.unauthorized {
            // Exactly one retry. Rediscovery may pick up a rotated token or replacement
            // process; health is revalidated immediately before sending it.
            try rediscover()
            return try await authenticatedAttempt(
                installation: installation,
                method: method,
                path: path,
                query: query,
                body: body
            )
        }
    }

    private func authenticatedAttempt<Body: Encodable>(
        installation: ProxyInstallation,
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Body?
    ) async throws -> Data {
        guard installation.credential?.isEmpty == false else {
            throw ProxyError.authenticationUnavailable
        }
        guard let runtime = installation.runtimeAttestation,
              installation.endpoint.expectedPID == runtime.pid,
              installation.endpoint.host == runtime.host,
              installation.endpoint.port == runtime.port
        else { throw ProxyError.identityMismatch }
        _ = try await validateAttestedHealthIdentity(
            installation: installation,
            runtime: runtime,
            timeout: 2
        )

        // Close the record-rotation window before attaching either the bearer or
        // body. A restart/port reuse/secret rotation forces a fresh attempt.
        let current = try discovery()
        guard current.endpoint == installation.endpoint,
              current.runtimeAttestation == runtime,
              let credential = current.credential,
              !credential.isEmpty
        else { throw ProxyError.identityMismatch }
        self.installation = current
        return try await perform(
            installation: current,
            method: method,
            path: path,
            query: query,
            body: body,
            credential: credential,
            timeout: method == "GET" ? 4 : 8
        )
    }

    private func validateHealthIdentity(
        installation: ProxyInstallation,
        timeout: TimeInterval
    ) async throws -> HealthIdentity {
        let data = try await perform(
            installation: installation,
            method: "GET",
            path: "healthz",
            query: [],
            body: nil as EmptyBody?,
            credential: nil,
            timeout: timeout
        )
        guard let identity = try? JSONDecoder().decode(HealthIdentity.self, from: data),
              identity.status == "ok",
              identity.service == "codexcommander",
              !identity.version.isEmpty,
              identity.pid > 0,
              identity.port == installation.endpoint.port,
              installation.endpoint.expectedPID == nil
                || installation.endpoint.expectedPID == identity.pid
        else { throw ProxyError.identityMismatch }
        return identity
    }

    private func validateAttestedHealthIdentity(
        installation: ProxyInstallation,
        runtime: ProxyRuntimeAttestation,
        timeout: TimeInterval
    ) async throws -> HealthIdentity {
        let challenge = attestationChallenge()
        guard challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw ProxyError.identityMismatch
        }
        let (data, response) = try await boundedAttestedHealthResponse(
            installation: installation,
            runtime: runtime,
            challenge: challenge,
            timeout: timeout
        )
        guard let identity = try? JSONDecoder().decode(HealthIdentity.self, from: data),
              identity.status == "ok",
              identity.service == "codexcommander",
              !identity.version.isEmpty,
              identity.pid == runtime.pid,
              identity.port == runtime.port,
              validAttestationProof(
                response.value(forHTTPHeaderField: attestationProofHeader),
                challenge: challenge,
                runtime: runtime
              )
        else { throw ProxyError.identityMismatch }
        return identity
    }

    /// Header-first listener proof. A foreign loopback listener never gets to
    /// choose how much body the app buffers: invalid proof/status/framing cancels
    /// immediately, and a valid chunked response still has a strict streaming cap.
    private func boundedAttestedHealthResponse(
        installation: ProxyInstallation,
        runtime: ProxyRuntimeAttestation,
        challenge: String,
        timeout: TimeInterval
    ) async throws -> (Data, HTTPURLResponse) {
        let url = installation.endpoint.baseURL.appendingPathComponent("healthz")
        guard url.scheme == "http",
              ProxyEndpoint.normalizedLoopbackHost(url.host) != nil,
              url.port == installation.endpoint.port
        else { throw ProxyError.identityMismatch }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("no-store", forHTTPHeaderField: "cache-control")
        request.setValue(challenge, forHTTPHeaderField: attestationChallengeHeader)

        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else {
                bytes.task.cancel()
                throw ProxyError.decoding
            }
            let encoding = http.value(forHTTPHeaderField: "content-encoding")?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            guard http.statusCode == 200,
                  encoding == nil || encoding == "identity",
                  validAttestationProof(
                    http.value(forHTTPHeaderField: attestationProofHeader),
                    challenge: challenge,
                    runtime: runtime
                  )
            else {
                bytes.task.cancel()
                throw ProxyError.identityMismatch
            }

            let expectedLength: Int?
            if let rawLength = http.value(forHTTPHeaderField: "content-length") {
                let normalized = rawLength.trimmingCharacters(in: .whitespacesAndNewlines)
                guard normalized.range(of: "^[0-9]+$", options: .regularExpression) != nil,
                      let parsed = Int(normalized),
                      parsed <= attestedHealthBodyLimit
                else {
                    bytes.task.cancel()
                    throw ProxyError.identityMismatch
                }
                expectedLength = parsed
            } else {
                expectedLength = nil
            }

            var data = Data()
            data.reserveCapacity(expectedLength ?? 512)
            for try await byte in bytes {
                guard data.count < attestedHealthBodyLimit else {
                    bytes.task.cancel()
                    throw ProxyError.identityMismatch
                }
                data.append(byte)
            }
            guard expectedLength == nil || expectedLength == data.count else {
                throw ProxyError.identityMismatch
            }
            return (data, http)
        } catch let error as ProxyError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError {
            switch error.code {
            case .cancelled:
                throw CancellationError()
            case .cannotConnectToHost:
                throw ProxyError.unreachable
            case .timedOut, .networkConnectionLost, .notConnectedToInternet,
                 .cannotFindHost, .dnsLookupFailed:
                throw ProxyError.inconclusive
            default:
                throw ProxyError.transport
            }
        }
    }

    private func perform<Body: Encodable>(
        installation: ProxyInstallation,
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Body?,
        credential: String?,
        headers: [String: String] = [:],
        timeout: TimeInterval
    ) async throws -> Data {
        let (data, response) = try await performResponse(
            installation: installation,
            method: method,
            path: path,
            query: query,
            body: body,
            credential: credential,
            headers: headers,
            timeout: timeout
        )
        if response.statusCode == 401 { throw ProxyError.unauthorized }
        guard (200..<300).contains(response.statusCode) else {
            throw ProxyError.http(response.statusCode)
        }
        return data
    }

    /// Shared hardened transport. Status interpretation stays with the endpoint so
    /// `/readyz` can decode its intentional 503 without weakening management calls.
    private func performResponse<Body: Encodable>(
        installation: ProxyInstallation,
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Body?,
        credential: String?,
        headers: [String: String] = [:],
        timeout: TimeInterval
    ) async throws -> (Data, HTTPURLResponse) {
        guard var components = URLComponents(
            url: installation.endpoint.baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else { throw ProxyError.decoding }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url,
              url.scheme == "http",
              ProxyEndpoint.normalizedLoopbackHost(url.host) != nil,
              url.port == installation.endpoint.port
        else { throw ProxyError.identityMismatch }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("no-store", forHTTPHeaderField: "cache-control")
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if let credential {
            request.setValue(credential, forHTTPHeaderField: "x-codexcommander-api-key")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            do {
                request.httpBody = try JSONEncoder().encode(body)
            } catch {
                throw ProxyError.decoding
            }
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw ProxyError.decoding
            }
            return (data, http)
        } catch let error as ProxyError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError {
            switch error.code {
            case .cancelled:
                throw CancellationError()
            case .cannotConnectToHost:
                throw ProxyError.unreachable
            case .timedOut, .networkConnectionLost, .notConnectedToInternet,
                 .cannotFindHost, .dnsLookupFailed:
                throw ProxyError.inconclusive
            default:
                throw ProxyError.transport
            }
        }
    }
}

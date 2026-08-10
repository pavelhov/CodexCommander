import Foundation

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
    }

    /// Deterministic initializer for transport tests. Production uses
    /// the discovery-backed initializer above.
    public init(
        endpoint: ProxyEndpoint,
        session: URLSession? = nil,
        credentials: CredentialStore
    ) {
        let credential = credentials.loadAPIKey()
        let fixed = ProxyInstallation(
            endpoint: endpoint,
            credential: credential,
            credentialAvailability: credential == nil ? .unavailable : .file,
            configDirectory: URL(fileURLWithPath: "/")
        )
        self.installation = fixed
        self.discovery = { fixed }
        self.session = session ?? Self.secureSession()
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
        guard let credential = installation.credential, !credential.isEmpty else {
            throw ProxyError.authenticationUnavailable
        }
        _ = try await validateHealthIdentity(installation: installation, timeout: 2)
        return try await perform(
            installation: installation,
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

    private func perform<Body: Encodable>(
        installation: ProxyInstallation,
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Body?,
        credential: String?,
        timeout: TimeInterval
    ) async throws -> Data {
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
            if http.statusCode == 401 { throw ProxyError.unauthorized }
            guard (200..<300).contains(http.statusCode) else {
                throw ProxyError.http(http.statusCode)
            }
            return data
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

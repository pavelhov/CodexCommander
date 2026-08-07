import Foundation

/// Everything the UI can show, as one value.
///
/// Views are pure functions of this snapshot, so no view invents its own loading flag or
/// decides independently whether data is missing.
public enum ProxyState: Equatable, Sendable {
    /// First fetch in flight; nothing is known yet.
    case loading
    case running(StartupHealth)
    /// Connection refused — the proxy is not running.
    case unreachable
    /// 401 with no usable credential.
    case unauthorized
    /// Reachable but erroring. The message is proxy-free human text.
    case degraded(String)

    public var isRunning: Bool {
        if case .running = self { return true }
        return false
    }

    /// Short label shown beside the status dot. Colour is never the only carrier of
    /// meaning, so every state has a word.
    public var title: String {
        switch self {
        case .loading: return "Checking…"
        case .running: return "Running"
        case .unreachable: return "Stopped"
        case .unauthorized: return "Authentication unavailable"
        case .degraded: return "Degraded"
        }
    }

    public enum Tone: Sendable { case neutral, good, warning, bad }

    public var tone: Tone {
        switch self {
        case .loading: return .neutral
        case .running(let health): return health.isProtected ? .good : .warning
        case .unreachable: return .bad
        case .unauthorized: return .warning
        case .degraded: return .warning
        }
    }

    /// Secondary line under the title.
    public var detail: String? {
        switch self {
        case .loading:
            return nil
        case .running(let health):
            let parts = [health.status, health.protection]
                .compactMap { $0 }
                .filter { !$0.isEmpty && $0 != "none" }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        case .unreachable:
            return "The proxy is not running."
        case .unauthorized:
            return "OpenCodex management authentication is unavailable."
        case .degraded(let message):
            return message
        }
    }
}

/// What the user should do next. `loading` deliberately has none — there is nothing to
/// act on yet — but every other non-running state names one.
public enum NextAction: Equatable, Sendable {
    case none
    /// A command to run, shown as selectable text. The app never spawns processes.
    case runCommand(String)
    case openDashboard
    case retry
}

public struct ProxySnapshot: Equatable, Sendable {
    public var state: ProxyState
    public var endpoint: ProxyEndpoint
    public var quotas: [QuotaReport]
    public var quotaAvailability: [ProviderQuotaAvailability]
    public var activity: AgentActivitySnapshot?
    public var providers: [ProviderSummary]
    public var lastUpdated: Date?
    public var consecutiveFailures: Int
    /// Remembered from the last successful health read, so a stopped proxy can still
    /// tell the user the right start command for their install.
    public var lastKnownStartCommand: String?
    /// The proxy's own remediation hint (for example `ocx service install`). Displayed
    /// as selectable text, never executed.
    public var recommendedCommand: String?
    /// Whether a section has actually been read, so "not fetched yet" and "the proxy
    /// reported none" render differently.
    public var providersLoaded: Bool
    public var quotasLoaded: Bool
    public var activityLoaded: Bool
    public var credentialAvailability: ManagementCredentialAvailability

    public init(
        state: ProxyState = .loading,
        endpoint: ProxyEndpoint,
        quotas: [QuotaReport] = [],
        quotaAvailability: [ProviderQuotaAvailability] = [],
        activity: AgentActivitySnapshot? = nil,
        providers: [ProviderSummary] = [],
        lastUpdated: Date? = nil,
        consecutiveFailures: Int = 0,
        lastKnownStartCommand: String? = nil,
        recommendedCommand: String? = nil,
        providersLoaded: Bool = false,
        quotasLoaded: Bool = false,
        activityLoaded: Bool = false,
        credentialAvailability: ManagementCredentialAvailability = .unavailable
    ) {
        self.state = state
        self.endpoint = endpoint
        self.quotas = quotas
        self.quotaAvailability = quotaAvailability
        self.activity = activity
        self.providers = providers
        self.lastUpdated = lastUpdated
        self.consecutiveFailures = consecutiveFailures
        self.lastKnownStartCommand = lastKnownStartCommand
        self.recommendedCommand = recommendedCommand
        self.providersLoaded = providersLoaded
        self.quotasLoaded = quotasLoaded
        self.activityLoaded = activityLoaded
        self.credentialAvailability = credentialAvailability
    }

    /// Age of the quota data, not of the last health probe.
    public var dataAge: Date? { quotas.compactMap(\.freshnessDate).max() }

    public var nextAction: NextAction {
        switch state {
        case .loading: return .none
        case .running: return .none
        case .unreachable:
            return .runCommand(lastKnownStartCommand ?? "ocx start")
        case .unauthorized: return .openDashboard
        case .degraded: return .retry
        }
    }

}

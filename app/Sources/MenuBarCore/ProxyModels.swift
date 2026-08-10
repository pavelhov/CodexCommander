import Foundation

// Codable mirrors of the current management API contract. Required keys deliberately
// fail decoding when an older or unrelated listener answers this app; nullable keys are
// optionals only where the server emits JSON null.

/// `GET /api/startup-health`
public struct StartupHealth: Decodable, Equatable, Sendable {
    public let status: String
    public let protection: String
    public let platform: String
    public let routingKind: String
    public let routingInjected: Bool
    public let localRoutingDependency: Bool
    public let autostartEnabled: Bool
    public let serviceRunning: Bool
    public let serviceInstalled: Bool
    public let serviceViable: Bool
    public let serviceEnabled: Bool
    public let serviceStale: Bool
    public let serviceConflict: Bool
    public let serviceSupported: Bool
    public let shimInstalled: Bool
    public let shimHealthy: Bool
    public let shimCoverage: String
    public let rebootSafe: Bool
    public let diagnosticStale: Bool
    public let recommendedCommand: String?
    public let commands: Commands

    public struct Commands: Decodable, Equatable, Sendable {
        public let installService: String
        public let repairService: String
        public let installShim: String
        public let restoreNative: String

        public init(
            installService: String,
            repairService: String,
            installShim: String,
            restoreNative: String
        ) {
            self.installService = installService
            self.repairService = repairService
            self.installShim = installShim
            self.restoreNative = restoreNative
        }
    }

    public init(
        status: String,
        protection: String,
        platform: String,
        routingKind: String,
        routingInjected: Bool,
        localRoutingDependency: Bool,
        autostartEnabled: Bool,
        serviceRunning: Bool,
        serviceInstalled: Bool,
        serviceViable: Bool,
        serviceEnabled: Bool,
        serviceStale: Bool,
        serviceConflict: Bool,
        serviceSupported: Bool,
        shimInstalled: Bool,
        shimHealthy: Bool,
        shimCoverage: String,
        rebootSafe: Bool,
        diagnosticStale: Bool,
        recommendedCommand: String?,
        commands: Commands
    ) {
        self.status = status
        self.protection = protection
        self.platform = platform
        self.routingKind = routingKind
        self.routingInjected = routingInjected
        self.localRoutingDependency = localRoutingDependency
        self.autostartEnabled = autostartEnabled
        self.serviceRunning = serviceRunning
        self.serviceInstalled = serviceInstalled
        self.serviceViable = serviceViable
        self.serviceEnabled = serviceEnabled
        self.serviceStale = serviceStale
        self.serviceConflict = serviceConflict
        self.serviceSupported = serviceSupported
        self.shimInstalled = shimInstalled
        self.shimHealthy = shimHealthy
        self.shimCoverage = shimCoverage
        self.rebootSafe = rebootSafe
        self.diagnosticStale = diagnosticStale
        self.recommendedCommand = recommendedCommand
        self.commands = commands
    }

    /// `status` is treated as an open string: unknown values degrade to a neutral state
    /// rather than crashing or being coerced into "healthy".
    public var isProtected: Bool { status == "protected" }

    /// The server returns its conservative fallback immediately while a service-manager
    /// probe refreshes in the background. That is a revalidation signal, not by itself
    /// evidence that protection was lost.
    public var isDiagnosticStale: Bool { diagnosticStale }

    /// True when a supervisor owns the process lifecycle. Used only for the qualifier
    /// line — it deliberately does not gate any action, because `/api/stop` stops the
    /// service on purpose and nothing restarts the proxy automatically.
    public var isServiceManaged: Bool {
        serviceInstalled && serviceEnabled
    }

    /// The command to show the user when the proxy is not running.
    public var manualStartCommand: String {
        isServiceManaged ? "ccx service start" : "ccx start"
    }
}

public struct QuotaWindow: Decodable, Equatable, Sendable {
    public let label: String
    public let percent: Double
    public let resetAt: Double?
}

/// A published provider cap paired with observations from this local CodexCommander usage
/// log. This is reference data, not a provider-reported balance or remaining percent.
public struct QuotaReferenceWindow: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let windowSeconds: Double
    public let publishedLimitUsd: Double
    public let observedSpendUsd: Double?
    public let observedTokens: Int64
    public let observedRequests: Int
    public let pricedRequests: Int
    public let unpricedRequests: Int
    public let unmeasuredRequests: Int
    public let coverage: String

    public enum ObservationQuality: Equatable, Sendable {
        case none
        /// Every observed request has a local price estimate; it is still not billing data.
        case estimate
        /// Some local usage or pricing is absent, so the displayed estimate is incomplete.
        case partial
    }

    public var observationQuality: ObservationQuality {
        let requests = max(0, observedRequests)
        let tokens = max(0, observedTokens)
        let hasObservation = requests > 0 || tokens > 0 || observedSpendUsd != nil
        guard hasObservation else { return .none }

        let priced = max(0, pricedRequests)
        let unpriced = max(0, unpricedRequests)
        let unmeasured = max(0, unmeasuredRequests)
        let internallyComplete = coverage == "complete"
            && requests > 0
            && priced == requests
            && unpriced == 0
            && unmeasured == 0
            && observedSpendUsd?.isFinite == true
        return internallyComplete ? .estimate : .partial
    }
}

/// A concrete upstream limit response observed by CodexCommander. Unlike reference-window
/// estimates, this event is authoritative evidence that the named provider limit fired.
public struct QuotaObservedLimitEvent: Decodable, Equatable, Sendable {
    public let limitName: String
    public let observedAt: Double
    public let resetAt: Double?
}

public struct ProviderQuota: Decodable, Equatable, Sendable {
    public let weeklyPercent: Double?
    public let monthlyPercent: Double?
    public let fiveHourPercent: Double?
    public let weeklyResetAt: Double?
    public let monthlyResetAt: Double?
    public let fiveHourResetAt: Double?
    public let customWindows: [QuotaWindow]?
    public let referenceWindows: [QuotaReferenceWindow]?
    public let observedLimitEvent: QuotaObservedLimitEvent?
    public let updatedAt: Double
}

public struct QuotaReport: Decodable, Equatable, Sendable {
    public let provider: String
    public let label: String
    public let source: String
    public let quota: ProviderQuota
    public let updatedAt: Double
}

public enum ProviderQuotaAvailabilityState: Equatable, Sendable, Decodable {
    case available
    case stale
    case unavailable
    case unknown

    public init(from decoder: Decoder) throws {
        switch try decoder.singleValueContainer().decode(String.self) {
        case "available": self = .available
        case "stale": self = .stale
        case "unavailable": self = .unavailable
        default: self = .unknown
        }
    }
}

public enum ProviderQuotaUnavailableReason: Equatable, Sendable, Decodable {
    case reauthRequired
    case localCLIRefreshRequired
    case upstreamUnavailable
    case unknown

    public init(from decoder: Decoder) throws {
        switch try decoder.singleValueContainer().decode(String.self) {
        case "reauth_required": self = .reauthRequired
        case "local_cli_refresh_required": self = .localCLIRefreshRequired
        case "upstream_unavailable": self = .upstreamUnavailable
        default: self = .unknown
        }
    }
}

public struct ProviderQuotaAvailability: Decodable, Equatable, Sendable {
    public let provider: String
    public let status: ProviderQuotaAvailabilityState
    public let reason: ProviderQuotaUnavailableReason?
    public let checkedAt: Double
}

public struct ProviderQuotaEnvelope: Decodable, Equatable, Sendable {
    public let generatedAt: Double
    public let reports: [QuotaReport]
    public let availability: [ProviderQuotaAvailability]
}

public enum AgentActivityRole: String, Decodable, Equatable, Sendable {
    case primary
    case subagent
}

public enum AgentActivityPhase: String, Decodable, Equatable, Sendable {
    case starting
    case running
}

public struct AgentActivity: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let parentId: String?
    public let role: AgentActivityRole
    public let provider: String?
    public let model: String?
    public let phase: AgentActivityPhase
    public let startedAt: Int64
    public let firstOutputAt: Int64?

    public var displayName: String {
        if let model, !model.isEmpty { return model }
        if let provider, !provider.isEmpty { return provider }
        return role == .primary ? "Primary agent" : "Subagent"
    }
}

public struct AgentActivitySnapshot: Decodable, Equatable, Sendable {
    public let schemaVersion: Int
    public let generatedAt: Int64
    public let proxyState: String
    public let activeTurnCount: Int
    public let displayedActivityCount: Int
    public let unattributedActiveCount: Int
    public let truncated: Bool
    public let activities: [AgentActivity]

    public var isSupported: Bool { schemaVersion == 1 }
}

/// A provider-agnostic view of quota, since the window key differs per provider.
public struct NormalizedQuota: Equatable, Sendable {
    public let provider: String
    public let providerLabel: String
    public let percent: Double?
    public let windowLabel: String
    public let resetAt: Date?

    public var hasPercent: Bool { percent?.isFinite == true }
}

public extension QuotaReport {
    /// Timestamps in this payload are not uniform: the live proxy returns
    /// `weeklyResetAt` in seconds for `openai` and in milliseconds for `anthropic`,
    /// within the same array. Disambiguate by magnitude — 1e12 is 2001 read as
    /// milliseconds and year 33658 read as seconds, so the boundary is unambiguous for
    /// any timestamp this app will ever see.
    static func date(from value: Double?) -> Date? {
        guard let value, value > 0 else { return nil }
        let seconds = value >= 1_000_000_000_000 ? value / 1000 : value
        return Date(timeIntervalSince1970: seconds)
    }

    /// The current contract carries both report and quota timestamps. The quota timestamp
    /// is the measurement timestamp; the enclosing report timestamp is publication time.
    var freshnessDate: Date? {
        Self.date(from: quota.updatedAt)
    }

    /// Every window the provider reported, in display order.
    ///
    /// The live proxy is not uniform: `openai` and `xai` report a single named window,
    /// `kimi` reports both `weeklyPercent` and `fiveHourPercent`, and `cursor` and
    /// `google-antigravity` carry two `customWindows` each. Returning only one window
    /// would silently hide real quota pressure.
    func normalizedWindows() -> [NormalizedQuota] {
        let name = label
        var windows: [NormalizedQuota] = []

        func append(_ percent: Double?, _ windowLabel: String, _ resetAt: Double?) {
            let validPercent = percent.flatMap { $0.isFinite ? $0 : nil }
            guard validPercent != nil || resetAt != nil else { return }
            windows.append(NormalizedQuota(
                provider: provider, providerLabel: name, percent: validPercent,
                windowLabel: windowLabel, resetAt: Self.date(from: resetAt)
            ))
        }

        append(quota.fiveHourPercent, "5h", quota.fiveHourResetAt)
        append(quota.weeklyPercent, "week", quota.weeklyResetAt)
        append(quota.monthlyPercent, "month", quota.monthlyResetAt)

        for window in quota.customWindows ?? [] {
            append(window.percent, window.label, window.resetAt)
        }

        return windows
    }

    /// Published reference caps remain deliberately separate from normalized provider
    /// windows. In particular, local spend divided by a cap must never become a fake
    /// provider-reported percentage or remaining balance.
    var referenceWindows: [QuotaReferenceWindow] {
        quota.referenceWindows ?? []
    }

    var observedLimitEvent: QuotaObservedLimitEvent? {
        quota.observedLimitEvent
    }

    /// The single window that best represents current pressure, for the compact row.
    ///
    /// Selection is **highest reported usage**, not longest horizon. Every window can
    /// stop work: a provider at 99% of a five-hour limit and 10% of its monthly limit is
    /// blocked right now, and showing the monthly 10% would paint that row green while
    /// the user cannot make a request. Ties break toward the longer horizon, since that
    /// is the one that will not recover on its own.
    ///
    /// Providers with no numeric window normalize to a nil percent so the UI renders an
    /// em dash rather than a misleading zero.
    func normalized() -> NormalizedQuota {
        let name = label
        let windows = normalizedWindows()

        // Longer horizons rank higher only as a tie-breaker.
        func horizonRank(_ label: String) -> Int {
            switch label {
            case "month": return 3
            case "week": return 2
            case "5h": return 1
            default: return 0
            }
        }

        let measured = windows.filter(\.hasPercent)
        let preferred = measured.max { lhs, rhs in
            let left = lhs.percent ?? 0
            let right = rhs.percent ?? 0
            if left != right { return left < right }
            return horizonRank(lhs.windowLabel) < horizonRank(rhs.windowLabel)
        } ?? windows.first

        return preferred ?? NormalizedQuota(
            provider: provider, providerLabel: name, percent: nil,
            windowLabel: "—", resetAt: nil
        )
    }
}

/// `GET /api/providers`. `hasApiKey` is a presence flag; the key never leaves the proxy.
public struct ProviderSummary: Decodable, Equatable, Sendable {
    public let name: String
    public let adapter: String
    public let authMode: String?
    public let hasApiKey: Bool
    public let disabled: Bool
    public let quotaCapable: Bool

    public var isEnabled: Bool { !disabled }
    public var supportsQuotaReporting: Bool { isEnabled && quotaCapable }
}

/// Tray-only display state. An unavailable row is structurally incapable of carrying
/// a fabricated percentage, reset, source, or freshness timestamp.
public enum ProviderQuotaRow: Equatable, Sendable {
    case available(QuotaReport, ProviderQuotaAvailability?)
    case unavailable(ProviderSummary, ProviderQuotaAvailability?)

    public var provider: String {
        switch self {
        case .available(let report, _): return report.provider
        case .unavailable(let summary, _): return summary.name
        }
    }

    public var label: String? {
        if case .available(let report, _) = self { return report.label }
        return nil
    }

    public var report: QuotaReport? {
        if case .available(let report, _) = self { return report }
        return nil
    }

    public var availability: ProviderQuotaAvailability? {
        switch self {
        case .available(_, let availability), .unavailable(_, let availability):
            return availability
        }
    }

    public var isUnavailable: Bool {
        if case .unavailable(_, _) = self { return true }
        return false
    }

    public var freshnessDate: Date? { report?.freshnessDate }
}

public extension ProxySnapshot {
    /// Join one completed provider inventory with the latest completed quota snapshot.
    /// Enabled configured providers form the left side; actual reports always win.
    var providerQuotaRows: [ProviderQuotaRow] {
        let availabilityByProvider = Dictionary(
            quotaAvailability.map { ($0.provider.lowercased(), $0) },
            uniquingKeysWith: { first, _ in first }
        )
        guard providersLoaded, quotasLoaded else {
            return quotas.map {
                .available($0, availabilityByProvider[$0.provider.lowercased()])
            }
        }

        var reportsByProvider: [String: QuotaReport] = [:]
        for report in quotas {
            let key = report.provider.lowercased()
            if reportsByProvider[key] == nil { reportsByProvider[key] = report }
        }

        var rows: [ProviderQuotaRow] = []
        for provider in providers where provider.isEnabled {
            let availability = availabilityByProvider[provider.name.lowercased()]
            if let report = reportsByProvider.removeValue(forKey: provider.name.lowercased()) {
                rows.append(.available(report, availability))
            } else if provider.supportsQuotaReporting {
                rows.append(.unavailable(provider, availability))
            }
        }
        return rows
    }
}

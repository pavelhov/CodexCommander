import Foundation

/// Owns the refresh schedule and turns transport results into a `ProxySnapshot`.
///
/// Polling is deliberately conservative. A menu bar app that hits a local server every
/// five seconds forever is a battery complaint waiting to happen, so heavy aggregation
/// endpoints are fetched only while the popover is open, and repeated failures back the
/// liveness tick off rather than hammering a proxy the user has stopped on purpose.
public actor PollingCoordinator {
    public static let openInterval: TimeInterval = 2
    public static let closedInterval: TimeInterval = 30
    public static let heavyInterval: TimeInterval = 60
    public static let backoffInterval: TimeInterval = 30
    public static let backoffAfterFailures = 3
    public static let revalidationInterval: TimeInterval = 1
    public static let maxDiagnosticStaleRefreshes = 6

    private let client: ProxyClient
    private var snapshot: ProxySnapshot
    private var popoverOpen = false
    private var observers: [UUID: @Sendable (ProxySnapshot) -> Void] = [:]
    /// Rises on every close and on every new refresh, so results from a superseded or
    /// abandoned cycle can be discarded instead of overwriting fresher state.
    private var generation = 0
    private var refreshInFlight = false
    /// A refresh requested while another was in flight. Without this, closing and
    /// immediately reopening the popover dropped the reopen's refresh entirely: the old
    /// cycle exited on its generation guard and the new one had already been rejected.
    private var pendingOpenRefresh = false
    /// Preserve a user-requested server-cache bypass when it arrives during another
    /// cycle; reducing it to a normal pending refresh would make the button lie.
    private var pendingQuotaForceRefresh = false
    /// A stale-while-revalidate startup-health response is intentionally conservative.
    /// Keep the neutral/last-known state while the background probe catches up, but
    /// bound retries so a genuinely broken diagnostic eventually remains visible.
    private var diagnosticStaleRefreshes = 0
    /// Attempt time, distinct from success time: a persistently failing quota endpoint
    /// must still respect the slower cadence.
    private var lastQuotaAttempt: Date?

    public init(client: ProxyClient, endpoint: ProxyEndpoint) {
        self.client = client
        self.snapshot = ProxySnapshot(endpoint: endpoint)
    }

    public var current: ProxySnapshot { snapshot }

    /// Interval until the next liveness tick, widened once failures pile up.
    public var currentInterval: TimeInterval {
        if diagnosticStaleRefreshes > 0,
           diagnosticStaleRefreshes <= Self.maxDiagnosticStaleRefreshes {
            return Self.revalidationInterval
        }
        if snapshot.consecutiveFailures >= Self.backoffAfterFailures {
            return Self.backoffInterval
        }
        return popoverOpen
            ? Self.openInterval
            : Self.closedInterval
    }

    @discardableResult
    public func observe(_ handler: @escaping @Sendable (ProxySnapshot) -> Void) -> UUID {
        let token = UUID()
        observers[token] = handler
        handler(snapshot)
        return token
    }

    public func removeObserver(_ token: UUID) { observers[token] = nil }

    public func setPopoverOpen(_ open: Bool) async {
        popoverOpen = open
        if open {
            try? await client.panelDidOpen()
            await refresh(includeHeavy: true)
        } else {
            // Abandon in-flight heavy work: its results are no longer visible and
            // must not land as if they were current.
            generation &+= 1
            snapshot.activity = nil
            snapshot.activityLoaded = false
            publish()
        }
    }

    /// One refresh cycle.
    ///
    /// `includeHeavy` marks a popover-open refresh: the provider read always runs,
    /// while the provider quota read still respects
    /// the 60s interval so reopening the popover repeatedly does not hammer the proxy.
    public func refresh(includeHeavy: Bool = false) async {
        await performRefresh(includeHeavy: includeHeavy, forceQuotaRefresh: false)
    }

    /// Internal pairing keeps `forceQuotaRefresh` from being requested without the
    /// popover-heavy reads that can actually consume it.
    private func performRefresh(
        includeHeavy: Bool,
        forceQuotaRefresh: Bool
    ) async {
        // Overlapping cycles publish interleaved state and double the request rate.
        guard !refreshInFlight else {
            if includeHeavy { pendingOpenRefresh = true }
            if forceQuotaRefresh { pendingQuotaForceRefresh = true }
            return
        }
        refreshInFlight = true
        generation &+= 1
        let cycle = generation

        do {
            let health = try await client.health()
            guard cycle == generation else {
                refreshInFlight = false
                await drainPendingRefresh()
                return
            }
            snapshot.endpoint = await client.currentEndpoint
            snapshot.credentialAvailability = await client.credentialAvailability
            snapshot.consecutiveFailures = 0
            if health.isDiagnosticStale {
                diagnosticStaleRefreshes += 1
                if diagnosticStaleRefreshes <= Self.maxDiagnosticStaleRefreshes {
                    // A cold launch stays neutral. Once a fresh protected state exists,
                    // do not replace it with a false warning during cache revalidation.
                    if !snapshot.state.isRunning { snapshot.state = .loading }
                    publish()
                    refreshInFlight = false
                    await drainPendingRefresh()
                    return
                }
            } else {
                diagnosticStaleRefreshes = 0
            }
            snapshot.state = .running(health)
            snapshot.lastKnownStartCommand = health.manualStartCommand
            snapshot.recommendedCommand = health.recommendedCommand
            snapshot.lastUpdated = Date()
        } catch is CancellationError {
            // The popover closed mid-flight. Not a proxy failure; leave state untouched.
            refreshInFlight = false
            await drainPendingRefresh()
            return
        } catch let error as ProxyError {
            if cycle == generation { apply(error); publish() }
            refreshInFlight = false
            await drainPendingRefresh()
            return
        } catch {
            if cycle == generation { apply(.transport); publish() }
            refreshInFlight = false
            await drainPendingRefresh()
            return
        }

        if popoverOpen {
            await refreshActivity(cycle: cycle)
            guard isCurrent(cycle) else {
                refreshInFlight = false
                await drainPendingRefresh()
                return
            }
            // Only on an actual open or manual refresh. Running this on every liveness
            // tick would turn a rarely changing endpoint into a two-second poller.
            if includeHeavy { await refreshOnOpen(cycle: cycle) }

            // Rate-limit on ATTEMPT, not success, so a persistently failing endpoint is
            // not retried on every two-second activity cycle.
            let quotaDue = forceQuotaRefresh || (lastQuotaAttempt.map {
                Date().timeIntervalSince($0) >= Self.heavyInterval
            } ?? true)
            if quotaDue, isCurrent(cycle) {
                lastQuotaAttempt = Date()
                await refreshQuotas(cycle: cycle, forceRefresh: forceQuotaRefresh)
            }
        }

        if cycle == generation { publish() }
        refreshInFlight = false
        await drainPendingRefresh()
    }

    /// User-initiated refresh: activity is immediate and quotas bypass their normal
    /// sixty-second cadence and the proxy's five-minute cache exactly once.
    public func forceRefresh() async {
        await performRefresh(includeHeavy: true, forceQuotaRefresh: true)
    }

    /// Runs a refresh that arrived while another cycle held the lock.
    private func drainPendingRefresh() async {
        guard pendingOpenRefresh, popoverOpen else {
            pendingOpenRefresh = false
            pendingQuotaForceRefresh = false
            return
        }
        let forceQuotaRefresh = pendingQuotaForceRefresh
        pendingOpenRefresh = false
        pendingQuotaForceRefresh = false
        await performRefresh(includeHeavy: true, forceQuotaRefresh: forceQuotaRefresh)
    }

    /// Reads that are only meaningful while the popover is open.
    private func refreshOnOpen(cycle: Int) async {
        guard isCurrent(cycle) else { return }
        if let providers = try? await client.providers(), isCurrent(cycle) {
            snapshot.providers = providers
            snapshot.providersLoaded = true
        }
    }

    /// Active-only data is intentionally short-lived. Poll it on every open-panel
    /// cycle and clear it on failure rather than presenting a completed turn as live.
    private func refreshActivity(cycle: Int) async {
        guard isCurrent(cycle) else { return }
        do {
            let activity = try await client.activity()
            guard activity.isSupported, isCurrent(cycle) else {
                snapshot.activity = nil
                snapshot.activityLoaded = false
                return
            }
            snapshot.activity = activity
            snapshot.activityLoaded = true
        } catch {
            guard isCurrent(cycle) else { return }
            snapshot.activity = nil
            snapshot.activityLoaded = false
        }
    }

    /// Still the newest cycle, and still worth doing.
    private func isCurrent(_ cycle: Int) -> Bool { cycle == generation && popoverOpen }

    /// The slower provider-quota read. A failed refresh preserves the last successful
    /// rows and their upstream freshness timestamps.
    private func refreshQuotas(cycle: Int, forceRefresh: Bool) async {
        guard isCurrent(cycle) else { return }
        if let envelope = try? await client.quotas(forceRefresh: forceRefresh) {
            guard isCurrent(cycle) else { return }
            snapshot.quotas = envelope.reports ?? []
            snapshot.quotaAvailability = envelope.availability ?? []
            snapshot.quotasLoaded = true
        }
    }

    private func apply(_ error: ProxyError) {
        diagnosticStaleRefreshes = 0
        snapshot.consecutiveFailures += 1
        switch error {
        case .unreachable:
            snapshot.state = .unreachable
        case .authenticationUnavailable, .unauthorized:
            snapshot.state = .unauthorized
        case .identityMismatch, .http, .decoding, .transport, .inconclusive:
            // A timeout is degraded, not stopped: something may well still be running.
            snapshot.state = .degraded(error.userMessage)
        }
    }

    private func publish() {
        let value = snapshot
        for handler in observers.values { handler(value) }
    }
}

import AppKit
import MenuBarCore

private enum CodexRouteConfirmationError: Error {
    case unavailable
    case mismatch
}

public final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var statusItem: NSStatusItem?
    private let panel = PopoverPanel()
    private let controller = PopoverViewController()
    private var coordinator: PollingCoordinator?
    private var actions: ActionCoordinator?
    private var client: ProxyClient?
    private var latest: ProxySnapshot?
    private var endpoint = ProxyEndpoint.default
    private var pollTask: Task<Void, Never>?
    private var escapeMonitor: Any?
    private var restartInFlight = false
    private var lifecycleInFlight = false
    private var catalogActionInFlight = false
    private var catalogUpdateReady = false
    private var companionHeartbeat: CompanionHeartbeat?
    private let launchAtLoginController = LaunchAtLoginController()
    private lazy var executableFingerprint = ExecutableFingerprint.current()
    private lazy var sourceRevision = BuildProvenance.shortRevision(
        Bundle.main.object(forInfoDictionaryKey: "CodexCommanderSourceRevision")
    )
    private lazy var launchAtLoginRegistrationAllowed =
        LaunchAtLoginEligibility.isStableBundle(Bundle.main.bundleURL)

    public override init() { super.init() }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        installApplicationMenu()
        do {
            let installation = try ProxyDiscovery.discover()
            let client = try ProxyClient(installation: installation)
            self.client = client
            self.endpoint = installation.endpoint
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
            self.coordinator = coordinator
            self.actions = ActionCoordinator()
            wire(controller: controller, coordinator: coordinator)
        } catch {
            // Keep the panel usable after an unsafe/missing discovery result, but retain
            // production rediscovery for the next menu open instead of freezing a
            // credential-less bootstrap client forever.
            let fallback = ProxyInstallation(
                endpoint: .default,
                credential: nil,
                credentialAvailability: .unavailable,
                configDirectory: ProxyDiscovery.configDirectory()
            )
            guard let client = try? ProxyClient(installation: fallback) else { return }
            self.client = client
            self.endpoint = fallback.endpoint
            let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
            self.coordinator = coordinator
            self.actions = ActionCoordinator()
            wire(controller: controller, coordinator: coordinator)
        }
    }

    /// Advisory launch-at-login reporting. The sample reads SMAppService freshly on
    /// every tick and every transition; failures are swallowed so a missing or
    /// restarting proxy can never alarm the user or block the transition.
    @MainActor
    private func makeCompanionHeartbeat(client: ProxyClient) -> CompanionHeartbeat {
        CompanionHeartbeat(
            sample: { [weak self] in
                guard let self else { return .unavailable }
                return self.launchAtLoginController.currentPresentation(
                    registrationAllowed: self.launchAtLoginRegistrationAllowed
                ).status
            },
            send: { [weak client] status in
                guard let client else { return }
                do {
                    try await client.reportCompanionStartupState(launchAtLogin: status)
                } catch {
                    // Best-effort by design: never surface a heartbeat failure.
                }
            }
        )
    }

    /// AppDelegate methods are nonisolated; these transitions are already on the main
    /// thread, so a MainActor hop preserves the immediate-report contract.
    private func startCompanionHeartbeat() {
        Task { @MainActor [weak self] in
            guard let self, let client = self.client else { return }
            let heartbeat = self.companionHeartbeat ?? self.makeCompanionHeartbeat(client: client)
            self.companionHeartbeat = heartbeat
            heartbeat.start()
            heartbeat.reportNow()
        }
    }

    private func reportCompanionHeartbeat() {
        Task { @MainActor [weak self] in
            self?.companionHeartbeat?.reportNow()
        }
    }

    private func stopCompanionHeartbeat() {
        Task { @MainActor [weak self] in
            self?.companionHeartbeat?.stop()
        }
    }

    private func wire(controller: PopoverViewController, coordinator: PollingCoordinator) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = StatusIcon.image(for: .loading)
        item.button?.imagePosition = .imageOnly
        item.button?.target = self
        item.button?.action = #selector(togglePopover)
        item.button?.setAccessibilityLabel("CodexCommander proxy status")
        statusItem = item

        controller.onDashboard = { [weak self] in self?.openDashboard() }
        controller.onLogs = { [weak self] in self?.openLogs() }
        controller.onRefresh = { [weak self] in self?.refreshNow() }
        controller.onStart = { [weak self] in self?.startProxy() }
        controller.onStop = { [weak self] in self?.stopProxy() }
        controller.onRestart = { [weak self] in self?.restartProxy() }
        controller.onRestoreNativeCodex = { [weak self] in self?.restoreNativeCodex() }
        controller.onRouteCodexThroughProxy = { [weak self] in
            self?.routeCodexThroughProxy()
        }
        controller.onApplyCodexCatalog = { [weak self] in self?.applyCodexCatalog() }
        controller.onOpenStartupOptions = { [weak self] in self?.openStartupOptions() }
        controller.onQuitMenuBar = { [weak self] in self?.quitMenuBar(nil) }
        controller.onStopAndQuit = { [weak self] in self?.stopCodexCommanderAndQuit(nil) }
        controller.onLaunchAtLoginChange = { [weak self] enabled in
            self?.setLaunchAtLogin(enabled)
        }
        controller.onOpenLoginSettings = { [weak self] in
            self?.launchAtLoginController.openSystemSettings()
        }
        controller.onManageProvider = { [weak self] provider in
            self?.openProvider(provider)
        }
        controller.onViewAllProviders = { [weak self] in
            self?.openHash("providers")
        }

        panel.contentViewController = controller
        panel.onDismiss = { [weak self] in self?.handlePanelClosed() }

        Task {
            await coordinator.observe { snapshot in
                Task { @MainActor in
                    (NSApp.delegate as? AppDelegate)?.render(snapshot)
                }
            }
            await MainActor.run { (NSApp.delegate as? AppDelegate)?.startPolling() }
        }
        controller.applyLaunchAtLogin(
            launchAtLoginController.reconcile(
                executableFingerprint: executableFingerprint,
                registrationAllowed: launchAtLoginRegistrationAllowed
            )
        )
        startCompanionHeartbeat()
        ensureProxyOnLaunch()
    }

    public func applicationDidBecomeActive(_ notification: Notification) {
        controller.applyLaunchAtLogin(
            launchAtLoginController.currentPresentation(
                registrationAllowed: launchAtLoginRegistrationAllowed
            )
        )
        reportCompanionHeartbeat()
    }

    public func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        presentPopover()
        return true
    }

    public func applicationWillTerminate(_ notification: Notification) {
        pollTask?.cancel()
        stopCompanionHeartbeat()
        removeEscapeMonitor()
        panel.dismiss()
    }

    // MARK: - Polling

    @MainActor
    fileprivate func startPolling() {
        guard let coordinator else { return }
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await coordinator.refresh()
                let interval = await coordinator.currentInterval
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }

    private func refreshNow() {
        Task { [coordinator] in await coordinator?.forceRefresh() }
    }

    @MainActor
    fileprivate func render(_ snapshot: ProxySnapshot) {
        latest = snapshot
        endpoint = snapshot.endpoint
        statusItem?.button?.image = StatusIcon.image(for: snapshot.state)
        let build = sourceRevision.map { " · build \($0)" } ?? ""
        statusItem?.button?.toolTip = "CodexCommander — \(snapshot.state.title) (\(snapshot.endpoint.display))\(build)"
        controller.apply(snapshot)
        if !restartInFlight && !lifecycleInFlight && !catalogActionInFlight {
            controller.setRestartEnabled(snapshot.state.isRunning)
            controller.setLifecycleControlsEnabled(true)
        }
        refreshCatalogApplyAvailability()
        updateApplicationMenu()
    }

    // MARK: - Actions

    #if DEBUG
    public func debugTogglePanel() { togglePopover() }
    #endif

    @objc private func togglePopover() {
        if panel.isShown {
            panel.dismiss()
        } else {
            presentPopover()
        }
    }

    private func presentPopover() {
        guard let button = statusItem?.button else { return }
        controller.applyLaunchAtLogin(
            launchAtLoginController.currentPresentation(
                registrationAllowed: launchAtLoginRegistrationAllowed
            )
        )
        panel.present(from: button)
        installEscapeMonitor()
        Task { [coordinator] in await coordinator?.setPopoverOpen(true) }
    }

    private func handlePanelClosed() {
        removeEscapeMonitor()
        Task { [coordinator] in await coordinator?.setPopoverOpen(false) }
    }

    private func installEscapeMonitor() {
        removeEscapeMonitor()
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53,
                  self?.panel.isShown == true,
                  self?.panel.isPresentingModal == false
            else { return event }
            self?.panel.dismiss()
            return nil
        }
    }

    private func removeEscapeMonitor() {
        if let monitor = escapeMonitor { NSEvent.removeMonitor(monitor) }
        escapeMonitor = nil
    }

    private func openDashboard() {
        openHash("dashboard")
    }

    private func openLogs() {
        openHash("logs")
    }

    /// The dashboard owns startup remediation (service install/repair, shim, routing
    /// decisions), so the tray hands the recommendation off instead of surfacing a raw
    /// `ccx service install` command the app would never execute.
    private func openStartupOptions() {
        openHash("startup")
    }

    /// Package-visible seam so the UI tests can pin the destination without opening a
    /// browser.
    package func startupOptionsURL() -> URL {
        DeepLinks.url(endpoint: endpoint, hash: "startup")
    }

    private func openProvider(_ provider: String) {
        let summary = latest?.providers.first(where: { $0.name == provider })
        let tab = ResourceAssets.supportsAccountsTab(provider, summary: summary)
            ? "accounts"
            : "overview"
        let encoded = DeepLinks.encodeProvider(provider)
        openHash("providers/\(encoded)/\(tab)")
    }

    private func openHash(_ hash: String) {
        guard let client else {
            controller.showResult(
                "Secure dashboard launch is unavailable. Start CodexCommander and try again.",
                isError: true
            )
            return
        }
        Task { @MainActor [weak self, client] in
            let result: Result<URL, Error>
            do {
                result = .success(try await client.confirmedGuiLaunchURL(route: hash))
            } catch {
                result = .failure(error)
            }
            guard let self else { return }
            switch result {
            case .success(let launch):
                NSWorkspace.shared.open(launch)
            case .failure(let error):
                let message = (error as? ProxyError)?.userMessage
                    ?? "Secure dashboard launch failed. Try again."
                self.controller.showResult(message, isError: true)
            }
        }
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        let presentation = launchAtLoginController.setEnabled(
            enabled,
            executableFingerprint: executableFingerprint,
            registrationAllowed: launchAtLoginRegistrationAllowed
        )
        controller.applyLaunchAtLogin(presentation)
        reportCompanionHeartbeat()
        if let error = presentation.errorMessage {
            controller.showResult(error, isError: true)
        } else if presentation.needsApproval {
            controller.showResult(
                "Approve CodexCommander under Login Items in System Settings.",
                isError: false
            )
        }
    }

    private func installApplicationMenu() {
        NSApp.mainMenu = ApplicationMenuFactory.make(
            target: self,
            quitAction: #selector(quitMenuBar(_:)),
            stopAndQuitAction: #selector(stopCodexCommanderAndQuit(_:))
        )
        updateApplicationMenu()
    }

    private func updateApplicationMenu() {
        NSApp.mainMenu?.items.first?.submenu?.update()
    }

    /// Safe default: close only the companion. The proxy is an independent process and
    /// remains available to connected clients.
    @objc private func quitMenuBar(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    public func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(stopCodexCommanderAndQuit(_:)) {
            return LifecycleActionAvailability.canStopAndQuit(
                state: latest?.state,
                controlsAllowed: !lifecycleInFlight && !restartInFlight && !catalogActionInFlight
            )
        }
        return true
    }

    /// Finder launch is the app-level start contract. It uses the fixed TS helper and
    /// keeps the menu app alive even when startup fails, so Start remains available.
    private func ensureProxyOnLaunch() {
        guard !lifecycleInFlight, !restartInFlight, !catalogActionInFlight else { return }
        lifecycleInFlight = true
        updateApplicationMenu()
        controller.setLifecycleControlsEnabled(false)
        refreshCatalogApplyAvailability()
        Task { [actions, coordinator] in
            let outcome = await actions?.ensure() ?? .failed("Lifecycle control is unavailable.")
            await coordinator?.forceRefresh()
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.lifecycleInFlight = false
                self.updateApplicationMenu()
                switch outcome {
                case .running:
                    self.clearCatalogUpdate()
                    self.companionHeartbeat?.reportNow()
                case .catalogUpdateReady(let count):
                    // The proxy is running with a pending catalog refresh; report now so
                    // a failed pre-ensure report is retried right after startup.
                    self.companionHeartbeat?.reportNow()
                    self.presentCatalogUpdate(staleWorkerCount: count)
                case .stopped:
                    break
                case .failed(let message):
                    self.controller.showResult(message, isError: true)
                }
                self.controller.setLifecycleControlsEnabled(true)
                self.refreshCatalogApplyAvailability()
            }
        }
    }

    private func startProxy() {
        guard !lifecycleInFlight, !restartInFlight, !catalogActionInFlight else { return }
        lifecycleInFlight = true
        updateApplicationMenu()
        controller.setLifecycleControlsEnabled(false)
        refreshCatalogApplyAvailability()
        controller.showProgress("Starting CodexCommander…")
        Task { [actions, coordinator] in
            let outcome = await actions?.start() ?? .failed("Lifecycle control is unavailable.")
            await coordinator?.forceRefresh()
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.lifecycleInFlight = false
                self.updateApplicationMenu()
                switch outcome {
                case .running:
                    self.clearCatalogUpdate()
                    self.companionHeartbeat?.reportNow()
                    self.controller.showResult("CodexCommander started.", isError: false)
                case .stopped:
                    self.controller.showResult("CodexCommander did not start.", isError: true)
                case .catalogUpdateReady(let count):
                    // Start succeeded with a pending catalog refresh; report now so the
                    // just-started proxy gets the companion lease immediately.
                    self.companionHeartbeat?.reportNow()
                    self.presentCatalogUpdate(staleWorkerCount: count)
                case .failed(let message):
                    self.controller.showResult(message, isError: true)
                }
                self.controller.setLifecycleControlsEnabled(true)
                self.refreshCatalogApplyAvailability()
            }
        }
    }

    private func stopProxy() {
        guard !lifecycleInFlight, !restartInFlight, !catalogActionInFlight else { return }
        guard confirm(.stopProxy) else { return }
        performStop(quitWhenStopped: false)
    }

    /// Explicit destructive exit: stop routing first and terminate the companion only
    /// after the lifecycle helper confirms that the proxy and service are stopped.
    @objc private func stopCodexCommanderAndQuit(_ sender: Any?) {
        guard !lifecycleInFlight, !restartInFlight, !catalogActionInFlight else { return }
        guard confirm(.stopAndQuit) else { return }
        performStop(quitWhenStopped: true)
    }

    private func performStop(quitWhenStopped: Bool) {
        lifecycleInFlight = true
        updateApplicationMenu()
        controller.setLifecycleControlsEnabled(false)
        refreshCatalogApplyAvailability()
        controller.showProgress("Stopping CodexCommander…")
        Task { [actions, coordinator] in
            let outcome = await actions?.stop() ?? .failed("Lifecycle control is unavailable.")
            let shouldTerminate = quitWhenStopped
                && StopAndQuitPolicy.shouldTerminate(after: outcome)
            if !shouldTerminate { await coordinator?.forceRefresh() }
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.lifecycleInFlight = false
                self.updateApplicationMenu()
                if shouldTerminate {
                    NSApp.terminate(nil)
                    return
                }
                switch outcome {
                case .stopped:
                    self.clearCatalogUpdate()
                    self.controller.showResult(
                        LifecycleResultMessage.proxyStopped,
                        isError: false
                    )
                case .running:
                    self.controller.showResult("CodexCommander is still running.", isError: true)
                case .catalogUpdateReady(let count):
                    self.presentCatalogUpdate(staleWorkerCount: count)
                    self.controller.showResult("CodexCommander is still running.", isError: true)
                case .failed(let message):
                    self.controller.showResult(message, isError: true)
                }
                self.controller.setLifecycleControlsEnabled(true)
                self.refreshCatalogApplyAvailability()
            }
        }
    }

    private func restoreNativeCodex() {
        performCodexRoute(
            destination: .nativeOpenAI,
            expectedRoutingKind: .native
        ) { actions in await actions.restoreNativeCodex() }
    }

    private func routeCodexThroughProxy() {
        performCodexRoute(
            destination: .codexCommander,
            expectedRoutingKind: .codexCommanderLocal
        ) { actions in await actions.routeCodexThroughProxy() }
    }

    /// The tray is only a command surface for the canonical CLI operations. It keeps
    /// no routing model of its own and reports success only when the structured helper
    /// result completes and the fresh routing endpoint confirms the destination.
    private func performCodexRoute(
        destination: CodexRouteDestination,
        expectedRoutingKind: CodexRoutingKind,
        operation: @escaping @Sendable (ActionCoordinator) async -> CodexRouteOutcome
    ) {
        guard !lifecycleInFlight, !restartInFlight, !catalogActionInFlight else { return }
        lifecycleInFlight = true
        updateApplicationMenu()
        controller.setLifecycleControlsEnabled(false)
        refreshCatalogApplyAvailability()
        controller.beginCodexRouteChange(to: destination)

        Task { [actions, coordinator] in
            let outcome: CodexRouteOutcome
            if let actions {
                outcome = await operation(actions)
            } else {
                outcome = .failed(
                    message: "Lifecycle control is unavailable.",
                    errorCode: nil
                )
            }
            let routeConfirmationPending: Bool
            if case .completed = outcome {
                await MainActor.run { [weak self] in
                    self?.controller.updateCodexRoutePhase(.confirming)
                }
                do {
                    guard let coordinator else {
                        throw CodexRouteConfirmationError.unavailable
                    }
                    let route = try await coordinator.refreshRouting()
                    guard route.routingKind == expectedRoutingKind else {
                        throw CodexRouteConfirmationError.mismatch
                    }
                    routeConfirmationPending = false
                } catch {
                    await coordinator?.markRoutingConfirmationUnavailable()
                    routeConfirmationPending = true
                }
            } else {
                routeConfirmationPending = false
            }
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.lifecycleInFlight = false
                self.updateApplicationMenu()
                switch outcome {
                case .completed:
                    if routeConfirmationPending {
                        self.controller.showCodexRouteConfirmationPending()
                    } else {
                        self.controller.showCodexRouteSaved(destination)
                    }
                case .failed(let message, let errorCode):
                    self.controller.showCodexRouteFailure(message, errorCode: errorCode)
                }
                self.controller.setLifecycleControlsEnabled(true)
                self.refreshCatalogApplyAvailability()
            }
        }
    }

    /// Restart is destructive to in-flight work, so it always confirms first and only
    /// reports success only after the lifecycle helper confirms a running replacement.
    private func restartProxy() {
        guard !restartInFlight, !lifecycleInFlight, !catalogActionInFlight else { return }
        guard confirm(.restartProxy) else { return }

        restartInFlight = true
        updateApplicationMenu()
        controller.setRestartEnabled(false)
        controller.setLifecycleControlsEnabled(false)
        refreshCatalogApplyAvailability()
        controller.showProgress("Restarting CodexCommander…")

        Task { [actions, coordinator] in
            let outcome = await actions?.restart() ?? .failed("Unavailable.")
            await coordinator?.forceRefresh()
            await MainActor.run { [weak self] in
                self?.restartInFlight = false
                self?.updateApplicationMenu()
                switch outcome {
                case .restarted:
                    self?.companionHeartbeat?.reportNow()
                    self?.controller.showResult("CodexCommander restarted.", isError: false)
                case .failed(let message):
                    self?.controller.showResult(message, isError: true)
                }
                if let latest = self?.latest {
                    self?.controller.setRestartEnabled(latest.state.isRunning)
                } else {
                    self?.controller.setRestartEnabled(true)
                }
                self?.controller.setLifecycleControlsEnabled(true)
                self?.refreshCatalogApplyAvailability()
            }
        }
    }

    /// Manual ChatGPT restart is the reliable catalog reload boundary. Keep the
    /// menu action informational; guarded worker-only interruption remains an
    /// advanced dashboard/CLI fallback.
    private func applyCodexCatalog() {
        guard catalogUpdateReady,
              !catalogActionInFlight,
              !lifecycleInFlight,
              !restartInFlight
        else { return }
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Restart ChatGPT to load the agent catalog"
        alert.informativeText = "Quit ChatGPT completely, reopen it, then start a new task. CodexCommander will keep running. After ChatGPT reopens, return here and check the catalog status."
        alert.addButton(withTitle: "Check status")
        alert.addButton(withTitle: "Close")
        panel.isPresentingModal = true
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        panel.isPresentingModal = false
        if panel.isShown { panel.makeKeyAndOrderFront(nil) }
        if response == .alertFirstButtonReturn {
            recheckCodexCatalog()
        }
    }

    private func recheckCodexCatalog() {
        guard catalogUpdateReady,
              !catalogActionInFlight,
              !lifecycleInFlight,
              !restartInFlight
        else { return }

        catalogActionInFlight = true
        updateApplicationMenu()
        controller.setLifecycleControlsEnabled(false)
        controller.setCatalogApplyEnabled(false)
        controller.showProgress("Checking agent catalog…")

        Task { [actions, coordinator] in
            let outcome = await actions?.ensure()
                ?? .failed("Catalog status is unavailable.")
            await coordinator?.forceRefresh()
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.catalogActionInFlight = false
                self.updateApplicationMenu()
                switch outcome {
                case .running:
                    self.clearCatalogUpdate()
                    self.controller.showResult(
                        "No stale ChatGPT worker is detected. Start a new task after ChatGPT reopens.",
                        isError: false
                    )
                case .catalogUpdateReady(let count):
                    self.presentCatalogUpdate(staleWorkerCount: count)
                    self.controller.showResult(
                        "ChatGPT is still using the previous agent catalog. Quit it completely, reopen it, then check again.",
                        isError: false
                    )
                case .stopped:
                    self.controller.showResult("CodexCommander is not running.", isError: true)
                case .failed(let message):
                    self.controller.showResult(message, isError: true)
                }
                self.controller.setLifecycleControlsEnabled(true)
                self.refreshCatalogApplyAvailability()
            }
        }
    }

    private func presentCatalogUpdate(staleWorkerCount: Int?) {
        catalogUpdateReady = true
        controller.showCatalogUpdate(staleWorkerCount: staleWorkerCount)
        refreshCatalogApplyAvailability()
    }

    private func clearCatalogUpdate() {
        catalogUpdateReady = false
        controller.hideCatalogUpdate()
        controller.setCatalogApplyEnabled(false)
    }

    private func refreshCatalogApplyAvailability() {
        controller.setCatalogApplyEnabled(CatalogUpdateActionAvailability.canApply(
            updateReady: catalogUpdateReady,
            state: latest?.state,
            controlsAllowed: !catalogActionInFlight && !lifecycleInFlight && !restartInFlight
        ))
    }

    private func confirm(_ confirmation: LifecycleConfirmation) -> Bool {
        let alert = confirmation.makeAlert()
        panel.isPresentingModal = true
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        panel.isPresentingModal = false
        if response != confirmation.confirmationResponse, panel.isShown {
            panel.makeKeyAndOrderFront(nil)
        }
        return response == confirmation.confirmationResponse
    }

    private func confirmCatalogUpdate(activity: CatalogUpdateActivity) -> CatalogUpdateChoice {
        let confirmation = CatalogUpdateConfirmation(activity: activity)
        let alert = confirmation.makeAlert()
        panel.isPresentingModal = true
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        panel.isPresentingModal = false
        let choice = confirmation.choice(for: response)
        if choice == .later, panel.isShown {
            panel.makeKeyAndOrderFront(nil)
        }
        return choice
    }
}

/// Best-effort, non-blocking reporter of the native app's launch-at-login state.
///
/// The proxy treats the report as advisory: it stamps its own observation time and
/// expires the lease after 90s, so this app never needs to know about TTLs. Failures
/// are swallowed on purpose — a missing or restarting proxy must never alarm the user
/// or block the transition that triggered the report. A single repeating timer owns
/// the 30s cadence; repeated `start()` calls cancel any existing timer instead of
/// stacking duplicates, and `stop()` cancels it on termination.
@MainActor
public final class CompanionHeartbeat {
    public typealias Sample = @Sendable () -> LaunchAtLoginStatus
    public typealias SendReport = @Sendable (LaunchAtLoginStatus) async -> Void

    public nonisolated static let targetInterval: TimeInterval = 30
    private let sample: Sample
    private let send: SendReport
    private let interval: TimeInterval
    private var timer: Timer?
    private var inFlight = false
    private var active = false
    private var generation = 0

    public init(
        interval: TimeInterval = CompanionHeartbeat.targetInterval,
        sample: @escaping Sample,
        send: @escaping SendReport
    ) {
        self.interval = interval
        self.sample = sample
        self.send = send
    }

    /// Starts the repeating best-effort timer. Safe to call repeatedly: any existing
    /// timer is cancelled first, so concurrent duplication is impossible.
    public func start() {
        cancelTimer()
        active = true
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// Immediately reports a freshly sampled status. Used after launch-at-login
    /// reconciliation, app activation, login-item changes, and successful proxy
    /// start/restart.
    public func reportNow() {
        tick(requiresActive: false)
    }

    /// Cancels the repeating timer; call on termination.
    public func stop() {
        cancelTimer()
        active = false
        generation += 1
        inFlight = false
    }

    private func cancelTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func tick(requiresActive: Bool = true) {
        guard !requiresActive || active, !inFlight else { return }
        inFlight = true
        let status = sample()
        let generationAtStart = generation
        Task { @MainActor [weak self] in
            guard let self, self.generation == generationAtStart else { return }
            await self.send(status)
            self.inFlight = false
        }
    }
}

/// Pure deep-link helpers shared with tests.
public enum DeepLinks {
    public static func encodeProvider(_ provider: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: ".-_")
        return provider.addingPercentEncoding(withAllowedCharacters: allowed) ?? provider
    }

    public static func providerHash(_ provider: String, accountsSupported: Bool) -> String {
        let tab = accountsSupported ? "accounts" : "overview"
        return "providers/\(encodeProvider(provider))/\(tab)"
    }

    public static func url(endpoint: ProxyEndpoint, hash: String) -> URL {
        var components = URLComponents(url: endpoint.baseURL, resolvingAgainstBaseURL: false)!
        components.fragment = hash
        return components.url ?? endpoint.baseURL
    }
}

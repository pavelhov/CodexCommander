import AppKit
import MenuBarCore

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
    private let launchAtLoginController = LaunchAtLoginController()
    private lazy var executableFingerprint = ExecutableFingerprint.current()
    private lazy var sourceRevision = BuildProvenance.shortRevision(
        Bundle.main.object(forInfoDictionaryKey: "OpenCodexSourceRevision")
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
            self.actions = ActionCoordinator(client: client)
            wire(controller: controller, coordinator: coordinator)
        } catch {
            // Keep the panel usable after an unsafe/missing discovery result, but retain
            // production rediscovery for the next menu open instead of freezing a
            // credential-less compatibility client forever.
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
            self.actions = ActionCoordinator(client: client)
            wire(controller: controller, coordinator: coordinator)
        }
    }

    private func wire(controller: PopoverViewController, coordinator: PollingCoordinator) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = StatusIcon.image(for: .loading)
        item.button?.imagePosition = .imageOnly
        item.button?.target = self
        item.button?.action = #selector(togglePopover)
        item.button?.setAccessibilityLabel("OpenCodex proxy status")
        statusItem = item

        controller.onDashboard = { [weak self] in self?.openDashboard() }
        controller.onLogs = { [weak self] in self?.openLogs() }
        controller.onRefresh = { [weak self] in self?.refreshNow() }
        controller.onStart = { [weak self] in self?.startProxy() }
        controller.onStop = { [weak self] in self?.stopProxy() }
        controller.onRestart = { [weak self] in self?.restartProxy() }
        controller.onQuitMenuBar = { [weak self] in self?.quitMenuBar(nil) }
        controller.onStopAndQuit = { [weak self] in self?.stopOpenCodexAndQuit(nil) }
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
        ensureProxyOnLaunch()
    }

    public func applicationDidBecomeActive(_ notification: Notification) {
        controller.applyLaunchAtLogin(
            launchAtLoginController.currentPresentation(
                registrationAllowed: launchAtLoginRegistrationAllowed
            )
        )
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
        statusItem?.button?.toolTip = "OpenCodex — \(snapshot.state.title) (\(snapshot.endpoint.display))\(build)"
        controller.apply(snapshot)
        if !restartInFlight && !lifecycleInFlight {
            controller.setRestartEnabled(snapshot.state.isRunning)
            controller.setLifecycleControlsEnabled(true)
        }
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

    private func openProvider(_ provider: String) {
        let summary = latest?.providers.first(where: { $0.name == provider })
        let tab = ResourceAssets.supportsAccountsTab(provider, summary: summary)
            ? "accounts"
            : "overview"
        let encoded = DeepLinks.encodeProvider(provider)
        openHash("providers/\(encoded)/\(tab)")
    }

    private func openHash(_ hash: String) {
        var components = URLComponents(url: endpoint.baseURL, resolvingAgainstBaseURL: false)
        components?.fragment = hash
        if let url = components?.url {
            NSWorkspace.shared.open(url)
        } else {
            NSWorkspace.shared.open(endpoint.baseURL)
        }
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        let presentation = launchAtLoginController.setEnabled(
            enabled,
            executableFingerprint: executableFingerprint,
            registrationAllowed: launchAtLoginRegistrationAllowed
        )
        controller.applyLaunchAtLogin(presentation)
        if let error = presentation.errorMessage {
            controller.showResult(error, isError: true)
        } else if presentation.needsApproval {
            controller.showResult(
                "Approve OpenCodex under Login Items in System Settings.",
                isError: false
            )
        }
    }

    private func installApplicationMenu() {
        NSApp.mainMenu = ApplicationMenuFactory.make(
            target: self,
            quitAction: #selector(quitMenuBar(_:)),
            stopAndQuitAction: #selector(stopOpenCodexAndQuit(_:))
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
        if menuItem.action == #selector(stopOpenCodexAndQuit(_:)) {
            return LifecycleActionAvailability.canStopAndQuit(
                state: latest?.state,
                controlsAllowed: !lifecycleInFlight && !restartInFlight
            )
        }
        return true
    }

    /// Finder launch is the app-level start contract. It uses the fixed TS helper and
    /// keeps the menu app alive even when startup fails, so Start remains available.
    private func ensureProxyOnLaunch() {
        guard !lifecycleInFlight, !restartInFlight else { return }
        lifecycleInFlight = true
        updateApplicationMenu()
        controller.setLifecycleControlsEnabled(false)
        Task { [actions, coordinator] in
            let outcome = await actions?.ensure() ?? .failed("Lifecycle control is unavailable.")
            await coordinator?.forceRefresh()
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.lifecycleInFlight = false
                self.updateApplicationMenu()
                if case .failed(let message) = outcome {
                    self.controller.showResult(message, isError: true)
                }
                self.controller.setLifecycleControlsEnabled(true)
            }
        }
    }

    private func startProxy() {
        guard !lifecycleInFlight, !restartInFlight else { return }
        lifecycleInFlight = true
        updateApplicationMenu()
        controller.setLifecycleControlsEnabled(false)
        controller.showResult("Starting OpenCodex…", isError: false)
        Task { [actions, coordinator] in
            let outcome = await actions?.start() ?? .failed("Lifecycle control is unavailable.")
            await coordinator?.forceRefresh()
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.lifecycleInFlight = false
                self.updateApplicationMenu()
                switch outcome {
                case .running:
                    self.controller.showResult("OpenCodex started.", isError: false)
                case .stopped:
                    self.controller.showResult("OpenCodex did not start.", isError: true)
                case .failed(let message):
                    self.controller.showResult(message, isError: true)
                }
                self.controller.setLifecycleControlsEnabled(true)
            }
        }
    }

    private func stopProxy() {
        guard !lifecycleInFlight, !restartInFlight else { return }
        guard confirm(.stopProxy) else { return }
        performStop(quitWhenStopped: false)
    }

    /// Explicit destructive exit: stop routing first and terminate the companion only
    /// after the lifecycle helper confirms that the proxy and service are stopped.
    @objc private func stopOpenCodexAndQuit(_ sender: Any?) {
        guard !lifecycleInFlight, !restartInFlight else { return }
        guard confirm(.stopAndQuit) else { return }
        performStop(quitWhenStopped: true)
    }

    private func performStop(quitWhenStopped: Bool) {
        lifecycleInFlight = true
        updateApplicationMenu()
        controller.setLifecycleControlsEnabled(false)
        controller.showResult("Stopping OpenCodex…", isError: false)
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
                    self.controller.showResult(
                        "Proxy stopped. The menu bar app is still open.",
                        isError: false
                    )
                case .running:
                    self.controller.showResult("OpenCodex is still running.", isError: true)
                case .failed(let message):
                    self.controller.showResult(message, isError: true)
                }
                self.controller.setLifecycleControlsEnabled(true)
            }
        }
    }

    /// Restart is destructive to in-flight work, so it always confirms first and only
    /// reports success after ActionCoordinator confirms a replacement process.
    private func restartProxy() {
        guard !restartInFlight, !lifecycleInFlight else { return }
        guard confirm(.restartProxy) else { return }

        restartInFlight = true
        updateApplicationMenu()
        controller.setRestartEnabled(false)
        controller.setLifecycleControlsEnabled(false)
        controller.showResult("Restart accepted…", isError: false)

        Task { [actions, coordinator] in
            let outcome = await actions?.restart() ?? .failed("Unavailable.")
            await coordinator?.forceRefresh()
            await MainActor.run { [weak self] in
                self?.restartInFlight = false
                self?.updateApplicationMenu()
                switch outcome {
                case .restarted:
                    self?.controller.showResult("OpenCodex restarted.", isError: false)
                case .failed(let message):
                    self?.controller.showResult(message, isError: true)
                }
                if let latest = self?.latest {
                    self?.controller.setRestartEnabled(latest.state.isRunning)
                } else {
                    self?.controller.setRestartEnabled(true)
                }
                self?.controller.setLifecycleControlsEnabled(true)
            }
        }
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

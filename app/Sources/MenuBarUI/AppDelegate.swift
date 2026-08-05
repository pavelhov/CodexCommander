import AppKit
import MenuBarCore

public final class AppDelegate: NSObject, NSApplicationDelegate {
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

    public override init() { super.init() }

    public func applicationDidFinishLaunching(_ notification: Notification) {
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
        controller.onRestart = { [weak self] in self?.restartProxy() }
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
        statusItem?.button?.toolTip = "OpenCodex — \(snapshot.state.title) (\(snapshot.endpoint.display))"
        controller.apply(snapshot)
        if !restartInFlight {
            controller.setRestartEnabled(snapshot.state.isRunning)
        }
    }

    // MARK: - Actions

    #if DEBUG
    public func debugTogglePanel() { togglePopover() }
    #endif

    @objc private func togglePopover() {
        guard let button = statusItem?.button else { return }
        if panel.isShown {
            panel.dismiss()
        } else {
            panel.present(from: button)
            installEscapeMonitor()
            Task { [coordinator] in await coordinator?.setPopoverOpen(true) }
        }
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

    /// Restart is destructive to in-flight work, so it always confirms first and only
    /// reports success after ActionCoordinator confirms a replacement process.
    private func restartProxy() {
        guard !restartInFlight else { return }

        let alert = NSAlert()
        alert.messageText = "Restart OpenCodex?"
        alert.informativeText =
            "Active turns will drain, then OpenCodex will come back on the same port."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Restart")
        alert.addButton(withTitle: "Cancel")

        panel.isPresentingModal = true
        NSApp.activate(ignoringOtherApps: true)
        let confirmed = alert.runModal() == .alertFirstButtonReturn
        panel.isPresentingModal = false

        guard confirmed else {
            panel.makeKeyAndOrderFront(nil)
            return
        }

        restartInFlight = true
        controller.setRestartEnabled(false)
        controller.showResult("Restart accepted…", isError: false)

        Task { [actions, coordinator] in
            let outcome = await actions?.restart() ?? .failed("Unavailable.")
            await coordinator?.forceRefresh()
            await MainActor.run { [weak self] in
                self?.restartInFlight = false
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
            }
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

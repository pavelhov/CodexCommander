import AppKit
import MenuBarCore

/// Native dark translucent popover body matching the approved reference panel.
public final class PopoverViewController: NSViewController {
    public override init(nibName: NSNib.Name?, bundle: Bundle?) {
        super.init(nibName: nibName, bundle: bundle)
    }

    public required init?(coder: NSCoder) { nil }

    // Fixed chrome
    private let header = StatusHeaderView()
    private let dashboardButton = NSButton()
    private let logsButton = NSButton()
    private let refreshButton = NSButton()
    private let lifecycleButton = NSButton()
    private let restartButton = NSButton()
    private let restoreNativeButton = NSButton()
    private let routeThroughProxyButton = NSButton()
    private let quitMenuBarButton = NSButton()
    private let stopAndQuitButton = NSButton()
    private let startupMode = StartupModeView()
    private let headerSeparator = makeSeparator()
    private let operationStatus = OperationStatusView()
    private let footerActions = NSStackView()
    private let column = NSStackView()

    // Scrolling body
    private let scrollView = NSScrollView()
    private let body = NSStackView()
    private let catalogUpdate = CatalogUpdateView()
    private let activity = AgentActivityView()
    private let quotas = ProviderQuotaAccordionView()
    private let guidanceLabel: NSTextField = {
        let field = makeLabel("", font: Theme.caption, color: Theme.muted)
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 3
        field.preferredMaxLayoutWidth = Theme.width - Theme.gutter * 2
        return field
    }()
    private let startupOptionsButton = NSButton()
    private let commandField = NSTextField(labelWithString: "")
    private let activitySeparator = makeSeparator()
    private let quotaSeparator = makeSeparator()

    public var onDashboard: (() -> Void)?
    public var onLogs: (() -> Void)?
    public var onRefresh: (() -> Void)?
    public var onStart: (() -> Void)?
    public var onStop: (() -> Void)?
    public var onRestart: (() -> Void)?
    public var onRestoreNativeCodex: (() -> Void)?
    public var onRouteCodexThroughProxy: (() -> Void)?
    public var onApplyCodexCatalog: (() -> Void)?
    public var onOpenStartupOptions: (() -> Void)?
    public var onQuitMenuBar: (() -> Void)?
    public var onStopAndQuit: (() -> Void)?
    public var onLaunchAtLoginChange: ((Bool) -> Void)?
    public var onOpenLoginSettings: (() -> Void)?
    public var onManageProvider: ((String) -> Void)?
    public var onViewAllProviders: (() -> Void)?

    private var snapshot: ProxySnapshot?
    private var scrollHeight: NSLayoutConstraint?
    private var lifecycleControlsAllowed = true
    private var launchAtLogin = LaunchAtLoginPresentation(
        status: .disabled,
        desiredEnabled: false
    )

    public override func loadView() {
        configureControls()
        startupOptionsButton.isHidden = true

        quotas.onManage = { [weak self] provider in
            self?.onManageProvider?(provider)
        }
        quotas.onViewAll = { [weak self] in
            self?.onViewAllProviders?()
        }
        startupMode.onToggle = { [weak self] enabled in
            self?.onLaunchAtLoginChange?(enabled)
        }
        startupMode.onOpenSettings = { [weak self] in
            self?.onOpenLoginSettings?()
        }
        catalogUpdate.onApply = { [weak self] in
            self?.onApplyCodexCatalog?()
        }
        operationStatus.onDismiss = { [weak self] in
            self?.refreshSize()
        }

        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = Theme.sectionGap
        body.setViews(
            [catalogUpdate, activity, activitySeparator, quotas, guidanceLabel, startupOptionsButton, commandField],
            in: .top
        )
        body.translatesAutoresizingMaskIntoConstraints = false
        for item in [catalogUpdate, activity, activitySeparator, quotas, guidanceLabel, startupOptionsButton, commandField] {
            item.translatesAutoresizingMaskIntoConstraints = false
            item.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }

        scrollView.contentView = FlippedClipView()
        scrollView.documentView = body
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        let navigationActions = NSStackView(views: [
            dashboardButton, logsButton, refreshButton, NSView()
        ])
        navigationActions.orientation = .horizontal
        navigationActions.spacing = Theme.rowGap
        navigationActions.alignment = .centerY

        let lifecycleActions = NSStackView(views: [
            lifecycleButton, restartButton, NSView()
        ])
        lifecycleActions.orientation = .horizontal
        lifecycleActions.spacing = Theme.rowGap
        lifecycleActions.alignment = .centerY

        let codexRouteActions = NSStackView(views: [
            restoreNativeButton, routeThroughProxyButton, NSView()
        ])
        codexRouteActions.orientation = .horizontal
        codexRouteActions.spacing = Theme.rowGap
        codexRouteActions.alignment = .centerY

        let exitActions = NSStackView(views: [
            quitMenuBarButton, NSView(), stopAndQuitButton
        ])
        exitActions.orientation = .horizontal
        exitActions.spacing = Theme.rowGap
        exitActions.alignment = .centerY

        footerActions.setViews(
            [navigationActions, lifecycleActions, codexRouteActions, exitActions],
            in: .top
        )
        footerActions.orientation = .vertical
        footerActions.spacing = 5
        footerActions.alignment = .leading

        column.setViews(
            [header, headerSeparator, operationStatus, scrollView, quotaSeparator, startupMode, footerActions],
            in: .top
        )
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 6
        column.edgeInsets = NSEdgeInsets(
            top: Theme.gutter, left: Theme.gutter,
            bottom: 10, right: Theme.gutter
        )
        column.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView(frame: NSRect(x: 0, y: 0, width: Theme.width, height: Theme.preferredHeight))
        root.addSubview(column)

        let contentWidth = Theme.width - Theme.gutter * 2
        let scrollingContentWidth = contentWidth - Theme.scrollbarClearance
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: root.topAnchor),
            column.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            column.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            root.widthAnchor.constraint(equalToConstant: Theme.width),
            header.widthAnchor.constraint(equalToConstant: contentWidth),
            headerSeparator.widthAnchor.constraint(equalToConstant: contentWidth),
            operationStatus.widthAnchor.constraint(equalToConstant: contentWidth),
            quotaSeparator.widthAnchor.constraint(equalToConstant: contentWidth),
            startupMode.widthAnchor.constraint(equalToConstant: contentWidth),
            footerActions.widthAnchor.constraint(equalToConstant: contentWidth),
            scrollView.widthAnchor.constraint(equalToConstant: contentWidth),
            body.widthAnchor.constraint(equalToConstant: scrollingContentWidth),
        ])

        let heightConstraint = scrollView.heightAnchor.constraint(equalToConstant: 320)
        heightConstraint.isActive = true
        scrollHeight = heightConstraint

        view = root
        preferredContentSize = NSSize(width: Theme.width, height: Theme.preferredHeight)
    }

    private func configureControls() {
        styleFooterButton(dashboardButton, title: "Dashboard", symbol: "square.grid.2x2")
        styleFooterButton(logsButton, title: "Logs", symbol: "list.bullet.rectangle")
        styleFooterButton(refreshButton, title: "Refresh", symbol: "arrow.clockwise")
        styleFooterButton(startupOptionsButton, title: "Startup options…", symbol: "gearshape.2")
        styleFooterButton(lifecycleButton, title: "Start Proxy", symbol: "play.fill")
        styleFooterButton(restartButton, title: "Restart Proxy…", symbol: "power")
        styleFooterButton(
            restoreNativeButton,
            title: "Restore Native Codex",
            symbol: "arrow.uturn.backward.circle"
        )
        styleFooterButton(
            routeThroughProxyButton,
            title: "Route Codex Through Proxy",
            symbol: "arrow.triangle.2.circlepath"
        )
        styleFooterButton(quitMenuBarButton, title: "Quit Menu Bar", symbol: "xmark.circle")
        styleFooterButton(
            stopAndQuitButton,
            title: "Stop CodexCommander and Quit…",
            symbol: "stop.circle"
        )
        stopAndQuitButton.contentTintColor = Theme.red

        dashboardButton.action = #selector(dashboardTapped)
        logsButton.action = #selector(logsTapped)
        refreshButton.action = #selector(refreshTapped)
        startupOptionsButton.action = #selector(startupOptionsTapped)
        lifecycleButton.action = #selector(lifecycleTapped)
        restartButton.action = #selector(restartTapped)
        restoreNativeButton.action = #selector(restoreNativeTapped)
        routeThroughProxyButton.action = #selector(routeThroughProxyTapped)
        quitMenuBarButton.action = #selector(quitMenuBarTapped)
        stopAndQuitButton.action = #selector(stopAndQuitTapped)

        quitMenuBarButton.keyEquivalent = CompanionShortcut.keyEquivalent
        quitMenuBarButton.keyEquivalentModifierMask = CompanionShortcut.quitModifiers
        stopAndQuitButton.keyEquivalent = CompanionShortcut.keyEquivalent
        stopAndQuitButton.keyEquivalentModifierMask = CompanionShortcut.stopAndQuitModifiers

        dashboardButton.setAccessibilityLabel("Open dashboard")
        logsButton.setAccessibilityLabel("Open logs")
        refreshButton.setAccessibilityLabel("Refresh")
        startupOptionsButton.setAccessibilityLabel("Open startup options in the dashboard")
        lifecycleButton.setAccessibilityLabel("Start CodexCommander proxy")
        restartButton.setAccessibilityLabel("Restart CodexCommander proxy")
        restoreNativeButton.setAccessibilityLabel("Restore Codex to its native OpenAI route")
        routeThroughProxyButton.setAccessibilityLabel(
            "Route Codex through the CodexCommander proxy"
        )
        quitMenuBarButton.setAccessibilityLabel(
            "Quit the CodexCommander menu bar app and leave the proxy running"
        )
        stopAndQuitButton.setAccessibilityLabel(
            "Stop the CodexCommander proxy and quit the menu bar app"
        )

        commandField.font = Theme.numericSmall
        commandField.textColor = Theme.text
        commandField.isSelectable = true
        commandField.isBordered = false
        commandField.drawsBackground = false
    }

    private func styleFooterButton(_ button: NSButton, title: String, symbol: String) {
        button.title = title
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        button.imagePosition = .imageLeading
        button.bezelStyle = .recessed
        button.isBordered = false
        button.controlSize = .small
        button.font = Theme.caption
        button.contentTintColor = Theme.text
        button.target = self
        button.setButtonType(.momentaryPushIn)
    }

    public func apply(_ snapshot: ProxySnapshot) {
        self.snapshot = snapshot
        header.apply(snapshot)

        activity.isHidden = false
        activity.apply(snapshot)
        quotas.isHidden = false
        quotas.apply(snapshot)

        activitySeparator.isHidden = activity.isHidden
        quotaSeparator.isHidden = false

        applyGuidance(snapshot)
        applyActions(snapshot)
        applyStartupMode(snapshot)
        resize()
    }

    public func applyLaunchAtLogin(_ presentation: LaunchAtLoginPresentation) {
        launchAtLogin = presentation
        applyStartupMode(snapshot)
        refreshSize()
    }

    public func showResult(_ text: String, isError: Bool) {
        operationStatus.showResult(title: text, tone: isError ? .error : .success)
        refreshSize()
    }

    public func showProgress(_ text: String) {
        operationStatus.beginOperation(text)
        refreshSize()
    }

    public func beginCodexRouteChange(to destination: CodexRouteDestination) {
        operationStatus.beginRouteChange(to: destination)
        refreshSize()
    }

    public func updateCodexRoutePhase(_ phase: CodexRouteOperationPhase) {
        operationStatus.updateRoutePhase(phase)
        refreshSize()
    }

    public func showCodexRouteSaved(_ destination: CodexRouteDestination) {
        let result = LifecycleResultMessage.codexRouteSaved(destination)
        operationStatus.showResult(
            title: result.title,
            detail: result.detail,
            tone: .success
        )
        refreshSize()
    }

    public func showCodexRouteFailure(_ rawMessage: String, errorCode: String? = nil) {
        let result = LifecycleResultMessage.codexRouteFailure(rawMessage, errorCode: errorCode)
        operationStatus.showResult(
            title: result.title,
            detail: result.detail,
            technicalDetail: result.technicalDetail,
            tone: .error
        )
        refreshSize()
    }

    public func showCodexRouteConfirmationPending() {
        let result = LifecycleResultMessage.codexRouteConfirmationPending
        operationStatus.showResult(
            title: result.title,
            detail: result.detail,
            tone: .warning
        )
        refreshSize()
    }

    public func setRestartEnabled(_ enabled: Bool) {
        restartButton.isEnabled = lifecycleControlsAllowed && enabled
        restartButton.alphaValue = restartButton.isEnabled ? 1 : 0.45
    }

    public func showCatalogUpdate(staleWorkerCount: Int?) {
        catalogUpdate.update(staleWorkerCount: staleWorkerCount)
        refreshSize()
    }

    public func hideCatalogUpdate() {
        catalogUpdate.hide()
        refreshSize()
    }

    public func setCatalogApplyEnabled(_ enabled: Bool) {
        catalogUpdate.setApplyEnabled(enabled)
    }

    public func setLifecycleControlsEnabled(_ enabled: Bool) {
        lifecycleControlsAllowed = enabled
        lifecycleButton.isEnabled = enabled && snapshot.map { lifecycleActionable($0.state) } == true
        restartButton.isEnabled = enabled && snapshot?.state.isRunning == true
        applyCodexRouteAvailability()
        stopAndQuitButton.isEnabled = LifecycleActionAvailability.canStopAndQuit(
            state: snapshot?.state,
            controlsAllowed: enabled
        )
        lifecycleButton.alphaValue = lifecycleButton.isEnabled ? 1 : 0.45
        restartButton.alphaValue = restartButton.isEnabled ? 1 : 0.45
        restoreNativeButton.alphaValue = restoreNativeButton.isEnabled ? 1 : 0.45
        routeThroughProxyButton.alphaValue = routeThroughProxyButton.isEnabled ? 1 : 0.45
        stopAndQuitButton.alphaValue = stopAndQuitButton.isEnabled ? 1 : 0.45
    }

    public func refreshSize() { resize() }

    private func applyGuidance(_ snapshot: ProxySnapshot) {
        var guidance: String?
        var command: String?
        var showStartupOptions = false

        switch snapshot.nextAction {
        case .none:
            if case .running = snapshot.state, snapshot.recommendedCommand != nil {
                guidance = "Recommended startup changes are available."
                showStartupOptions = true
            }
        case .runCommand(let value):
            guidance = "Start it again with:"
            command = value
        case .openDashboard:
            guidance = "CodexCommander management authentication is unavailable."
        case .retry:
            guidance = snapshot.dataAge.map { "Showing data from \(Format.age($0)). Retrying automatically." }
                ?? "Retrying automatically."
        }

        guidanceLabel.isHidden = guidance == nil
        guidanceLabel.stringValue = guidance ?? ""
        commandField.isHidden = command == nil
        commandField.stringValue = command ?? ""
        startupOptionsButton.isHidden = !showStartupOptions
        if let command {
            commandField.setAccessibilityLabel("Command to run: \(command)")
        }
    }

    private func applyActions(_ snapshot: ProxySnapshot) {
        let definitelyStopped = snapshot.state == .unreachable
        let stopIntent = lifecycleStops(snapshot.state)
        dashboardButton.isEnabled = !definitelyStopped
        logsButton.isEnabled = !definitelyStopped
        refreshButton.isEnabled = true
        lifecycleButton.title = stopIntent ? "Stop Proxy…" : "Start Proxy"
        lifecycleButton.image = NSImage(
            systemSymbolName: stopIntent ? "stop.fill" : "play.fill",
            accessibilityDescription: lifecycleButton.title
        )
        lifecycleButton.setAccessibilityLabel(
            stopIntent ? "Stop CodexCommander proxy" : "Start CodexCommander proxy"
        )
        lifecycleButton.isEnabled = lifecycleControlsAllowed && lifecycleActionable(snapshot.state)
        lifecycleButton.alphaValue = lifecycleButton.isEnabled ? 1 : 0.45
        restartButton.isEnabled = lifecycleControlsAllowed && snapshot.state.isRunning
        restartButton.alphaValue = restartButton.isEnabled ? 1 : 0.45
        applyCodexRouteAvailability()
        restoreNativeButton.alphaValue = restoreNativeButton.isEnabled ? 1 : 0.45
        routeThroughProxyButton.alphaValue = routeThroughProxyButton.isEnabled ? 1 : 0.45
        quitMenuBarButton.isEnabled = true
        stopAndQuitButton.isEnabled = LifecycleActionAvailability.canStopAndQuit(
            state: snapshot.state,
            controlsAllowed: lifecycleControlsAllowed
        )
        stopAndQuitButton.alphaValue = stopAndQuitButton.isEnabled ? 1 : 0.45
    }

    private func resize() {
        view.layoutSubtreeIfNeeded()
        let bodyHeight = ceil(body.fittingSize.height)
        let fixedViewsHeight = ceil(header.fittingSize.height)
            + ceil(headerSeparator.fittingSize.height)
            + (operationStatus.isHidden ? 0 : ceil(operationStatus.fittingSize.height))
            + ceil(quotaSeparator.fittingSize.height)
            + ceil(startupMode.fittingSize.height)
            + ceil(footerActions.fittingSize.height)
        let stackGaps = column.spacing * CGFloat(max(0, column.views.count - 1))
        let chrome = fixedViewsHeight
            + stackGaps
            + column.edgeInsets.top
            + column.edgeInsets.bottom
        let natural = chrome + bodyHeight
        let preferred = max(Theme.preferredHeight, min(Theme.maxHeight, natural))
        let overflowing = natural > Theme.maxHeight
        scrollView.hasVerticalScroller = overflowing
        scrollHeight?.constant = max(120, preferred - chrome)
        preferredContentSize = NSSize(width: Theme.width, height: preferred)
    }

    private func applyCodexRouteAvailability() {
        guard lifecycleControlsAllowed else {
            restoreNativeButton.isEnabled = false
            routeThroughProxyButton.isEnabled = false
            return
        }

        guard let snapshot else {
            restoreNativeButton.isEnabled = true
            routeThroughProxyButton.isEnabled = false
            return
        }
        switch snapshot.codexRoute {
        case .confirmed(let route):
            restoreNativeButton.isEnabled = route.routingKind != .native
            routeThroughProxyButton.isEnabled =
                snapshot.state.isRunning && route.routingKind != .codexCommanderLocal
            return
        case .confirmationUnavailable:
            restoreNativeButton.isEnabled = true
            routeThroughProxyButton.isEnabled = snapshot.state.isRunning
            return
        case .unobserved:
            break
        }
        guard case .running(let health) = snapshot.state, !health.diagnosticStale else {
            restoreNativeButton.isEnabled = true
            routeThroughProxyButton.isEnabled = false
            return
        }
        let usesProxy = health.routingInjected || health.routingKind == "codexcommander-local"
        restoreNativeButton.isEnabled = health.routingKind != "native"
        routeThroughProxyButton.isEnabled = !usesProxy
    }

    // MARK: - Actions

    @objc private func dashboardTapped() { onDashboard?() }
    @objc private func logsTapped() { onLogs?() }
    @objc private func refreshTapped() { onRefresh?() }
    @objc private func startupOptionsTapped() { onOpenStartupOptions?() }
    @objc private func lifecycleTapped() {
        guard let state = snapshot?.state else { return }
        if lifecycleStops(state) { onStop?() }
        else if state == .unreachable { onStart?() }
    }
    @objc private func restartTapped() { onRestart?() }
    @objc private func restoreNativeTapped() { onRestoreNativeCodex?() }
    @objc private func routeThroughProxyTapped() { onRouteCodexThroughProxy?() }
    @objc private func quitMenuBarTapped() { onQuitMenuBar?() }
    @objc private func stopAndQuitTapped() { onStopAndQuit?() }

    private func applyStartupMode(_ snapshot: ProxySnapshot?) {
        let serviceManaged: Bool
        if let snapshot, case .running(let health) = snapshot.state {
            serviceManaged = health.isServiceManaged
        } else {
            serviceManaged = false
        }
        startupMode.apply(launchAtLogin, serviceManaged: serviceManaged)
    }

    public override func cancelOperation(_ sender: Any?) {
        view.window?.performClose(nil)
    }

    /// Unauthorized/degraded means a process may still be serving. Offer Stop so the
    /// user can recover through the fixed lifecycle helper without spawning a duplicate.
    private func lifecycleStops(_ state: ProxyState) -> Bool {
        switch state {
        case .running, .unauthorized, .degraded: return true
        case .loading, .unreachable: return false
        }
    }

    private func lifecycleActionable(_ state: ProxyState) -> Bool {
        state != .loading
    }

    // MARK: - Test hooks

    package var quotaAccordion: ProviderQuotaAccordionView { quotas }
    package var activityView: AgentActivityView { activity }
    package var scrollingBodyWidth: CGFloat {
        view.layoutSubtreeIfNeeded()
        return body.frame.width
    }
    package var scrollContainerWidth: CGFloat {
        view.layoutSubtreeIfNeeded()
        return scrollView.bounds.width
    }
    package var hasVerticalScroller: Bool { scrollView.hasVerticalScroller }
    package var headerView: StatusHeaderView { header }
    package var operationStatusView: OperationStatusView { operationStatus }
    package var startupModeView: StartupModeView { startupMode }
    package var catalogUpdateVisible: Bool { !catalogUpdate.isHidden }
    package var catalogUpdateDetail: String { catalogUpdate.detailText }
    package var catalogUpdateButtonTitle: String { catalogUpdate.buttonTitle }
    package var catalogUpdateButtonEnabled: Bool { catalogUpdate.buttonEnabled }
    package var catalogUpdateAccessibilityLabel: String? {
        catalogUpdate.accessibilityLabel()
    }
    package var catalogUpdateButtonAccessibilityLabel: String? {
        catalogUpdate.buttonAccessibilityLabel
    }
    package func activateCatalogUpdateForTesting() { catalogUpdate.activateForTesting() }
    package var guidanceText: String? {
        guidanceLabel.isHidden ? nil : guidanceLabel.stringValue
    }
    package var commandText: String? {
        commandField.isHidden ? nil : commandField.stringValue
    }
    package var startupOptionsVisible: Bool { !startupOptionsButton.isHidden }
    package var startupOptionsTitle: String { startupOptionsButton.title }
    package var startupOptionsAccessibilityLabel: String? {
        startupOptionsButton.accessibilityLabel()
    }
    package func activateStartupOptionsForTesting() {
        startupOptionsButton.performClick(nil)
    }
    package var footerTitles: [String] {
        [
            dashboardButton.title,
            logsButton.title,
            refreshButton.title,
            lifecycleButton.title,
            restartButton.title,
            restoreNativeButton.title,
            routeThroughProxyButton.title,
            quitMenuBarButton.title,
            stopAndQuitButton.title,
        ]
    }
    package var footerEnabledStates: [Bool] {
        footerButtons.map(\.isEnabled)
    }
    package var footerAccessibilityLabels: [String?] {
        footerButtons.map { $0.accessibilityLabel() }
    }
    package var footerKeyEquivalents: [(String, NSEvent.ModifierFlags)] {
        footerButtons.map { ($0.keyEquivalent, $0.keyEquivalentModifierMask) }
    }
    package func activateFooterForTesting(_ index: Int) {
        guard footerButtons.indices.contains(index) else { return }
        footerButtons[index].performClick(nil)
    }
    private var footerButtons: [NSButton] {
        [
            dashboardButton,
            logsButton,
            refreshButton,
            lifecycleButton,
            restartButton,
            restoreNativeButton,
            routeThroughProxyButton,
            quitMenuBarButton,
            stopAndQuitButton,
        ]
    }
}

final class FlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

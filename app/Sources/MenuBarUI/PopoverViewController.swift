import AppKit
import MenuBarCore

/// Native dark translucent popover body matching the approved reference panel.
public final class PopoverViewController: NSViewController {
    public override init(nibName: NSNib.Name?, bundle: Bundle?) {
        super.init(nibName: nibName, bundle: bundle)
    }

    public required init?(coder: NSCoder) { nil }

    // Fixed identity, controls, and one-line status
    private let header = BrandHeaderView()
    private let statusFooter = StatusFooterView()
    private let moreActionsMenu = NSMenu(title: "More actions")
    private let refreshMenuItem = NSMenuItem()
    private let logsMenuItem = NSMenuItem()
    private let updateSeparator = NSMenuItem.separator()
    private let updateMenuItem = NSMenuItem()
    private let lifecycleButton = NSButton()
    private let restartButton = NSButton()
    private let restoreNativeButton = NSButton()
    private let routeThroughProxyButton = NSButton()
    private let stopAndQuitButton = NSButton()
    private let updateMessage = NSTextField(wrappingLabelWithString: "")
    private var updateBlocksLifecycle = false
    private let startupMode = StartupModeView()
    private let headerSeparator = makeSeparator()
    private let operationStatus = OperationStatusView()
    private let controlActions = NSStackView()
    private let primaryActions = NSStackView()
    private let separateRouteActions = NSStackView()
    private let primaryActionSpacer = NSView()
    private let separateRouteSpacer = NSView()
    private var routeActionsAreSeparate = false
    private let column = NSStackView()

    // One scrolling monitoring area below the controls
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
    private let footerSeparator = makeSeparator()

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
    public var onCheckForUpdates: (() -> Void)?
    public var onStopAndQuit: (() -> Void)?
    public var onLaunchAtLoginChange: ((Bool) -> Void)?
    public var onLaunchAtLoginRemediation: ((LaunchAtLoginRemediation) -> Void)?
    public var onManageProvider: ((String) -> Void)?
    public var onViewAllProviders: (() -> Void)?

    private var snapshot: ProxySnapshot?
    private var scrollHeight: NSLayoutConstraint?
    private var lifecycleControlsAllowed = true
    private var launchAtLogin = LaunchAtLoginPresentation(
        status: .disabled,
        desiredEnabled: false,
        isToggleEnabled: true
    )

    public override func loadView() {
        configureControls()
        header.onDashboard = { [weak self] in self?.onDashboard?() }
        header.onMoreActions = { [weak self] sender in self?.showMoreActions(from: sender) }
        header.onUpdate = { [weak self] in self?.onCheckForUpdates?() }
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
        startupMode.onRemediation = { [weak self] remediation in
            self?.onLaunchAtLoginRemediation?(remediation)
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
            [catalogUpdate, guidanceLabel, startupOptionsButton, commandField,
             quotas, activitySeparator, activity],
            in: .top
        )
        body.translatesAutoresizingMaskIntoConstraints = false
        for item in [catalogUpdate, guidanceLabel, startupOptionsButton, commandField,
                     quotas, activitySeparator, activity] {
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

        primaryActions.setViews(
            [lifecycleButton, restartButton, restoreNativeButton,
             routeThroughProxyButton, primaryActionSpacer],
            in: .leading
        )
        primaryActions.orientation = .horizontal
        primaryActions.spacing = Theme.rowGap
        primaryActions.alignment = .centerY

        separateRouteActions.setViews([separateRouteSpacer], in: .leading)
        separateRouteActions.orientation = .horizontal
        separateRouteActions.spacing = Theme.rowGap
        separateRouteActions.alignment = .centerY
        separateRouteActions.isHidden = true

        let exitActions = NSStackView(views: [
            stopAndQuitButton, NSView()
        ])
        exitActions.orientation = .horizontal
        exitActions.spacing = Theme.rowGap
        exitActions.alignment = .centerY

        controlActions.setViews(
            [primaryActions, separateRouteActions, updateMessage, exitActions],
            in: .top
        )
        controlActions.orientation = .vertical
        controlActions.spacing = 5
        controlActions.alignment = .leading

        column.setViews(
            [header, headerSeparator, operationStatus, controlActions,
             startupMode, scrollView, footerSeparator, statusFooter],
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
            footerSeparator.widthAnchor.constraint(equalToConstant: contentWidth),
            startupMode.widthAnchor.constraint(equalToConstant: contentWidth),
            statusFooter.widthAnchor.constraint(equalToConstant: contentWidth),
            controlActions.widthAnchor.constraint(equalToConstant: contentWidth),
            scrollView.widthAnchor.constraint(equalToConstant: contentWidth),
            body.widthAnchor.constraint(equalToConstant: scrollingContentWidth),
        ])

        let heightConstraint = scrollView.heightAnchor.constraint(equalToConstant: 320)
        heightConstraint.isActive = true
        scrollHeight = heightConstraint

        view = root
        applyCodexRouteVisibility()
        preferredContentSize = NSSize(width: Theme.width, height: Theme.preferredHeight)
    }

    private func configureControls() {
        moreActionsMenu.autoenablesItems = false
        refreshMenuItem.title = "Refresh Models"
        refreshMenuItem.action = #selector(refreshTapped)
        refreshMenuItem.target = self
        refreshMenuItem.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
        refreshMenuItem.toolTip = "Check for model changes; ChatGPT may need to restart to load them"
        logsMenuItem.title = "Logs"
        logsMenuItem.action = #selector(logsTapped)
        logsMenuItem.target = self
        logsMenuItem.image = NSImage(systemSymbolName: "list.bullet.rectangle", accessibilityDescription: nil)
        updateMenuItem.title = "Check for Updates…"
        updateMenuItem.action = #selector(updateTapped)
        updateMenuItem.target = self
        updateMenuItem.image = NSImage(systemSymbolName: "arrow.down.circle", accessibilityDescription: nil)
        moreActionsMenu.addItem(refreshMenuItem)
        moreActionsMenu.addItem(logsMenuItem)
        moreActionsMenu.addItem(updateSeparator)
        moreActionsMenu.addItem(updateMenuItem)
        updateMessage.font = Theme.caption
        updateMessage.textColor = Theme.muted
        updateMessage.preferredMaxLayoutWidth = Theme.width - Theme.gutter * 2
        updateMessage.isHidden = true
        styleFooterButton(startupOptionsButton, title: "Startup options…", symbol: "gearshape.2")
        styleFooterButton(lifecycleButton, title: "Start Proxy", symbol: "play.fill")
        styleFooterButton(restartButton, title: "Restart…", symbol: "power")
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
        styleFooterButton(
            stopAndQuitButton,
            title: "Stop CodexCommander and Quit…",
            symbol: "stop.circle"
        )
        stopAndQuitButton.contentTintColor = Theme.red

        startupOptionsButton.action = #selector(startupOptionsTapped)
        lifecycleButton.action = #selector(lifecycleTapped)
        restartButton.action = #selector(restartTapped)
        restoreNativeButton.action = #selector(restoreNativeTapped)
        routeThroughProxyButton.action = #selector(routeThroughProxyTapped)
        stopAndQuitButton.action = #selector(stopAndQuitTapped)

        stopAndQuitButton.keyEquivalent = CompanionShortcut.keyEquivalent
        stopAndQuitButton.keyEquivalentModifierMask = CompanionShortcut.stopAndQuitModifiers

        startupOptionsButton.setAccessibilityLabel("Open startup options in the dashboard")
        lifecycleButton.setAccessibilityLabel("Start CodexCommander proxy")
        restartButton.setAccessibilityLabel("Restart CodexCommander proxy")
        restoreNativeButton.setAccessibilityLabel("Restore Codex to its native OpenAI route")
        routeThroughProxyButton.setAccessibilityLabel(
            "Route Codex through the CodexCommander proxy"
        )
        restoreNativeButton.toolTip = "Restore Native Codex"
        routeThroughProxyButton.toolTip = "Route Codex Through Proxy"
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
        statusFooter.apply(snapshot)

        activity.isHidden = false
        activity.apply(snapshot)
        quotas.isHidden = false
        quotas.apply(snapshot)

        activitySeparator.isHidden = activity.isHidden
        footerSeparator.isHidden = false

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

    public func showSetupRequired(_ requirement: ProxySetupRequirement) {
        let result = LifecycleResultMessage.setupRequired(requirement)
        operationStatus.showResult(
            title: result.title,
            detail: result.detail,
            tone: .warning
        )
        refreshSize()
    }

    public func showAppTranslocated() {
        let result = LifecycleResultMessage.appTranslocated
        operationStatus.showResult(
            title: result.title,
            detail: result.detail,
            tone: .warning
        )
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
        restartButton.isEnabled = lifecycleControlsAllowed && enabled && !updateBlocksLifecycle
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
        refreshMenuItem.isEnabled = enabled && snapshot?.state.isRunning == true
        updateMoreActionsAvailability()
        lifecycleButton.isEnabled = enabled && snapshot.map { lifecycleActionable($0.state) } == true
        restartButton.isEnabled = enabled && snapshot?.state.isRunning == true
        restartButton.isHidden = snapshot?.state.isRunning != true
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
        applyUpdateLifecycleGuard()
    }

    public func applyUpdatePresentation(title: String, enabled: Bool, blocked: Bool, message: String) {
        _ = view
        let needsAttention = title == "Update Available…" || title == "Finish Update…"
        header.setUpdateAction(title: needsAttention ? title : nil, enabled: enabled, message: message)
        updateSeparator.isHidden = needsAttention
        updateMenuItem.isHidden = needsAttention
        updateMenuItem.title = "Check for Updates…"
        updateMenuItem.isEnabled = enabled && !needsAttention
        updateMenuItem.toolTip = !enabled && !message.isEmpty ? message : nil
        updateMoreActionsAvailability()
        updateMessage.stringValue = blocked ? message : ""
        updateMessage.isHidden = !blocked || message.isEmpty
        updateBlocksLifecycle = blocked
        if let snapshot { applyGuidance(snapshot) }
        setLifecycleControlsEnabled(lifecycleControlsAllowed)
        refreshSize()
    }

    package var headerUpdateTitleForTesting: String? { header.updateActionTitleForTesting }
    package var headerUpdateEnabledForTesting: Bool { header.updateActionEnabledForTesting }
    package func clickHeaderUpdateForTesting() { header.clickUpdateForTesting() }

    private func applyUpdateLifecycleGuard() {
        guard updateBlocksLifecycle else { return }
        if snapshot?.state.isRunning != true { lifecycleButton.isEnabled = false }
        restartButton.isEnabled = false
        routeThroughProxyButton.isEnabled = false
        restartButton.alphaValue = 0.45
        routeThroughProxyButton.alphaValue = 0.45
    }

    @objc private func updateTapped() { onCheckForUpdates?() }

    public func refreshSize() { resize() }

    private func applyGuidance(_ snapshot: ProxySnapshot) {
        guard !updateBlocksLifecycle else {
            guidanceLabel.isHidden = true
            commandField.isHidden = true
            startupOptionsButton.isHidden = true
            return
        }
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
        header.setDashboardEnabled(!definitelyStopped)
        logsMenuItem.isEnabled = !definitelyStopped
        refreshMenuItem.isEnabled = lifecycleControlsAllowed && snapshot.state.isRunning
        updateMoreActionsAvailability()
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
        restartButton.isHidden = !snapshot.state.isRunning
        restartButton.alphaValue = restartButton.isEnabled ? 1 : 0.45
        applyCodexRouteAvailability()
        applyCodexRouteVisibility()
        restoreNativeButton.alphaValue = restoreNativeButton.isEnabled ? 1 : 0.45
        routeThroughProxyButton.alphaValue = routeThroughProxyButton.isEnabled ? 1 : 0.45
        stopAndQuitButton.isEnabled = LifecycleActionAvailability.canStopAndQuit(
            state: snapshot.state,
            controlsAllowed: lifecycleControlsAllowed
        )
        stopAndQuitButton.alphaValue = stopAndQuitButton.isEnabled ? 1 : 0.45
        applyUpdateLifecycleGuard()
    }

    private func resize() {
        view.layoutSubtreeIfNeeded()
        let bodyHeight = ceil(body.fittingSize.height)
        let fixedViews: [NSView] = [header, headerSeparator, operationStatus,
                                    controlActions, startupMode, footerSeparator, statusFooter]
        let fixedViewsHeight = fixedViews.filter { !$0.isHidden }
            .reduce(CGFloat.zero) { $0 + ceil($1.fittingSize.height) }
        let visibleColumnCount = column.views.filter { !$0.isHidden }.count
        let stackGaps = column.spacing * CGFloat(max(0, visibleColumnCount - 1))
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

    /// Keep the one available route switch beside proxy controls. When route
    /// truth is uncertain, put both recovery choices on their own row.
    private func applyCodexRouteVisibility() {
        let route: CodexRoutingKind?
        switch snapshot?.codexRoute {
        case .confirmed(let status):
            route = status.routingKind
        case .unobserved:
            if case .running(let health) = snapshot?.state, !health.diagnosticStale {
                route = CodexRoutingKind(rawValue: health.routingKind)
            } else {
                route = nil
            }
        case .confirmationUnavailable, nil:
            route = nil
        }
        restoreNativeButton.isHidden = route == .native
        routeThroughProxyButton.isHidden = route == .codexCommanderLocal
        let needsSeparateRow = !restoreNativeButton.isHidden && !routeThroughProxyButton.isHidden
        if needsSeparateRow != routeActionsAreSeparate {
            let source = needsSeparateRow ? primaryActions : separateRouteActions
            let destination = needsSeparateRow ? separateRouteActions : primaryActions
            source.removeView(restoreNativeButton)
            source.removeView(routeThroughProxyButton)
            destination.insertView(restoreNativeButton, at: needsSeparateRow ? 0 : 2, in: .leading)
            destination.insertView(routeThroughProxyButton, at: needsSeparateRow ? 1 : 3, in: .leading)
            routeActionsAreSeparate = needsSeparateRow
        }
        restoreNativeButton.title = needsSeparateRow ? "Restore Native Codex" : "Use Native"
        routeThroughProxyButton.title = needsSeparateRow ? "Route Codex Through Proxy" : "Use Commander"
        separateRouteActions.isHidden = !needsSeparateRow
    }

    // MARK: - Actions

    @objc private func logsTapped() { onLogs?() }
    @objc private func refreshTapped() { onRefresh?() }
    private func showMoreActions(from sender: NSButton) {
        moreActionsMenu.popUp(
            positioning: nil,
            at: NSPoint(x: 0, y: sender.bounds.minY),
            in: sender
        )
    }
    private func updateMoreActionsAvailability() {
        let enabled = refreshMenuItem.isEnabled || logsMenuItem.isEnabled
            || (!updateMenuItem.isHidden && updateMenuItem.isEnabled)
        header.setMoreActionsEnabled(
            enabled,
            label: updateMenuItem.isHidden
                ? "More actions: Refresh Models and Logs"
                : "More actions: Refresh Models, Logs, and updates"
        )
    }
    @objc private func startupOptionsTapped() { onOpenStartupOptions?() }
    @objc private func lifecycleTapped() {
        guard let state = snapshot?.state else { return }
        if lifecycleStops(state) { onStop?() }
        else if state == .unreachable { onStart?() }
    }
    @objc private func restartTapped() { onRestart?() }
    @objc private func restoreNativeTapped() { onRestoreNativeCodex?() }
    @objc private func routeThroughProxyTapped() { onRouteCodexThroughProxy?() }
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
    package var monitoringPrecedesPanelFooter: Bool {
        guard let controlsIndex = column.arrangedSubviews.firstIndex(of: controlActions),
              let statusIndex = column.arrangedSubviews.firstIndex(of: statusFooter),
              let separatorIndex = column.arrangedSubviews.firstIndex(of: footerSeparator),
              let scrollIndex = column.arrangedSubviews.firstIndex(of: scrollView),
              let activityIndex = body.arrangedSubviews.firstIndex(of: activity),
              let quotaIndex = body.arrangedSubviews.firstIndex(of: quotas) else { return false }
        return statusIndex == column.arrangedSubviews.count - 1
            && controlsIndex < scrollIndex && scrollIndex < separatorIndex && separatorIndex < statusIndex
            && quotaIndex < activityIndex
    }
    package var visibleRouteActionTitles: [String] {
        [restoreNativeButton, routeThroughProxyButton]
            .filter { !$0.isHidden }
            .map(\.title)
    }
    package var primaryActionTitles: [String] {
        primaryActions.arrangedSubviews.compactMap { $0 as? NSButton }
            .filter { !$0.isHidden }
            .map(\.title)
    }
    package var separateRouteRowVisible: Bool { !separateRouteActions.isHidden }
    package var visibleUpperControlRowCount: Int {
        controlActions.arrangedSubviews.filter { !$0.isHidden }.count
            + (startupMode.isHidden ? 0 : 1)
    }
    package var headerView: BrandHeaderView { header }
    package var statusFooterView: StatusFooterView { statusFooter }
    package var operationStatusView: OperationStatusView { operationStatus }
    package var operationStatusTitle: String { operationStatus.titleText }
    package var operationStatusDetail: String? { operationStatus.detailText }
    package var operationStatusTone: OperationStatusTone? {
        operationStatus.lastRenderedTone
    }
    package var routeThroughProxyEnabled: Bool { routeThroughProxyButton.isEnabled }
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
            "Dashboard",
            logsMenuItem.title,
            refreshMenuItem.title,
            lifecycleButton.title,
            restartButton.title,
            restoreNativeButton.title,
            routeThroughProxyButton.title,
            stopAndQuitButton.title,
        ]
    }
    package var footerEnabledStates: [Bool] {
        [header.dashboardEnabledForTesting, logsMenuItem.isEnabled, refreshMenuItem.isEnabled,
         lifecycleButton.isEnabled, restartButton.isEnabled, restoreNativeButton.isEnabled,
         routeThroughProxyButton.isEnabled, stopAndQuitButton.isEnabled]
    }
    package var footerAccessibilityLabels: [String?] {
        [header.dashboardAccessibilityLabelForTesting, "Open logs", "Refresh models and proxy status",
         lifecycleButton.accessibilityLabel(), restartButton.accessibilityLabel(),
         restoreNativeButton.accessibilityLabel(), routeThroughProxyButton.accessibilityLabel(),
         stopAndQuitButton.accessibilityLabel()]
    }
    package var footerKeyEquivalents: [(String, NSEvent.ModifierFlags)] {
        [
            ("", []),
            ("", []),
            ("", []),
            (lifecycleButton.keyEquivalent, lifecycleButton.keyEquivalentModifierMask),
            (restartButton.keyEquivalent, restartButton.keyEquivalentModifierMask),
            (restoreNativeButton.keyEquivalent, restoreNativeButton.keyEquivalentModifierMask),
            (routeThroughProxyButton.keyEquivalent, routeThroughProxyButton.keyEquivalentModifierMask),
            (stopAndQuitButton.keyEquivalent, stopAndQuitButton.keyEquivalentModifierMask),
        ]
    }
    package func activateFooterForTesting(_ index: Int) {
        switch index {
        case 0: header.clickDashboardForTesting()
        case 1: activateMoreActionForTesting(1)
        case 2: activateMoreActionForTesting(0)
        case 3: lifecycleButton.performClick(nil)
        case 4: restartButton.performClick(nil)
        case 5: restoreNativeButton.performClick(nil)
        case 6: routeThroughProxyButton.performClick(nil)
        case 7: stopAndQuitButton.performClick(nil)
        default: break
        }
    }
    package var visibleHeaderActionTitles: [String] {
        ["Dashboard", "More actions"]
    }
    package var moreActionsAccessibilityLabel: String? {
        header.moreActionsAccessibilityLabelForTesting
    }
    package var moreActionTitles: [String] {
        let titles = [refreshMenuItem.title, logsMenuItem.title]
        return updateMenuItem.isHidden ? titles : titles + [updateMenuItem.title]
    }
    package var moreActionEnabledStates: [Bool] {
        let states = [refreshMenuItem.isEnabled, logsMenuItem.isEnabled]
        return updateMenuItem.isHidden ? states : states + [updateMenuItem.isEnabled]
    }
    package func activateMoreActionForTesting(_ index: Int) {
        guard moreActionEnabledStates.indices.contains(index), moreActionEnabledStates[index] else { return }
        moreActionsMenu.performActionForItem(at: index == 2 ? 3 : index)
    }
}

final class FlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

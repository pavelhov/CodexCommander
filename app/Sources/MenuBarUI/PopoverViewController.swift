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
    private let restartButton = NSButton()

    // Scrolling body
    private let scrollView = NSScrollView()
    private let body = NSStackView()
    private let activity = AgentActivityView()
    private let quotas = ProviderQuotaAccordionView()
    private let resultBanner = makeLabel("", font: Theme.caption, color: Theme.muted)
    private let guidanceLabel: NSTextField = {
        let field = makeLabel("", font: Theme.caption, color: Theme.muted)
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 3
        field.preferredMaxLayoutWidth = Theme.width - Theme.gutter * 2
        return field
    }()
    private let commandField = NSTextField(labelWithString: "")
    private let activitySeparator = makeSeparator()
    private let quotaSeparator = makeSeparator()

    public var onDashboard: (() -> Void)?
    public var onLogs: (() -> Void)?
    public var onRefresh: (() -> Void)?
    public var onRestart: (() -> Void)?
    public var onManageProvider: ((String) -> Void)?
    public var onViewAllProviders: (() -> Void)?

    private var snapshot: ProxySnapshot?
    private var scrollHeight: NSLayoutConstraint?
    private var resultToken = 0

    public override func loadView() {
        configureControls()
        resultBanner.isHidden = true
        resultBanner.lineBreakMode = .byWordWrapping
        resultBanner.maximumNumberOfLines = 3
        resultBanner.preferredMaxLayoutWidth = Theme.width - Theme.gutter * 2

        quotas.onManage = { [weak self] provider in
            self?.onManageProvider?(provider)
        }
        quotas.onViewAll = { [weak self] in
            self?.onViewAllProviders?()
        }

        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = Theme.sectionGap
        body.setViews(
            [activity, activitySeparator, quotas, resultBanner, guidanceLabel, commandField],
            in: .top
        )
        body.translatesAutoresizingMaskIntoConstraints = false
        for item in [activity, activitySeparator, quotas, resultBanner, guidanceLabel, commandField] {
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

        let footerDivider = NSView()
        footerDivider.wantsLayer = true
        footerDivider.layer?.backgroundColor = Theme.cardBorder.cgColor
        footerDivider.translatesAutoresizingMaskIntoConstraints = false
        footerDivider.widthAnchor.constraint(equalToConstant: 1).isActive = true
        footerDivider.heightAnchor.constraint(equalToConstant: 22).isActive = true

        let actions = NSStackView(views: [
            dashboardButton, logsButton, refreshButton, NSView(), footerDivider, restartButton
        ])
        actions.orientation = .horizontal
        actions.spacing = Theme.rowGap
        actions.alignment = .centerY

        let headerSeparator = makeSeparator()
        let column = NSStackView(views: [header, headerSeparator, scrollView, quotaSeparator, actions])
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
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: root.topAnchor),
            column.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            column.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            root.widthAnchor.constraint(equalToConstant: Theme.width),
            header.widthAnchor.constraint(equalToConstant: contentWidth),
            headerSeparator.widthAnchor.constraint(equalToConstant: contentWidth),
            quotaSeparator.widthAnchor.constraint(equalToConstant: contentWidth),
            actions.widthAnchor.constraint(equalToConstant: contentWidth),
            scrollView.widthAnchor.constraint(equalToConstant: contentWidth),
            body.widthAnchor.constraint(equalToConstant: contentWidth),
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
        styleFooterButton(restartButton, title: "Restart…", symbol: "power")

        dashboardButton.action = #selector(dashboardTapped)
        logsButton.action = #selector(logsTapped)
        refreshButton.action = #selector(refreshTapped)
        restartButton.action = #selector(restartTapped)

        dashboardButton.setAccessibilityLabel("Open dashboard")
        logsButton.setAccessibilityLabel("Open logs")
        refreshButton.setAccessibilityLabel("Refresh")
        restartButton.setAccessibilityLabel("Restart OpenCodex")

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
        resize()
    }

    public func showResult(_ text: String, isError: Bool) {
        resultBanner.stringValue = text
        resultBanner.textColor = isError ? Theme.red : Theme.muted
        resultBanner.isHidden = false
        refreshSize()

        resultToken &+= 1
        let token = resultToken
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self, self.resultToken == token else { return }
            self.resultBanner.isHidden = true
            self.refreshSize()
        }
    }

    public func setRestartEnabled(_ enabled: Bool) {
        restartButton.isEnabled = enabled
    }

    public func refreshSize() { resize() }

    private func applyGuidance(_ snapshot: ProxySnapshot) {
        var guidance: String?
        var command: String?

        switch snapshot.nextAction {
        case .none:
            if case .running = snapshot.state, let recommended = snapshot.recommendedCommand {
                guidance = "Recommended:"
                command = recommended
            }
        case .runCommand(let value):
            guidance = "Start it again with:"
            command = value
        case .openDashboard:
            guidance = "OpenCodex management authentication is unavailable."
        case .retry:
            guidance = snapshot.dataAge.map { "Showing data from \(Format.age($0)). Retrying automatically." }
                ?? "Retrying automatically."
        }

        guidanceLabel.isHidden = guidance == nil
        guidanceLabel.stringValue = guidance ?? ""
        commandField.isHidden = command == nil
        commandField.stringValue = command ?? ""
        if let command {
            commandField.setAccessibilityLabel("Command to run: \(command)")
        }
    }

    private func applyActions(_ snapshot: ProxySnapshot) {
        dashboardButton.isEnabled = true
        logsButton.isEnabled = true
        refreshButton.isEnabled = true
        // Restart only while running; confirmation still gates the destructive call.
        restartButton.isEnabled = snapshot.state.isRunning
        restartButton.alphaValue = snapshot.state.isRunning ? 1 : 0.45
    }

    private func resize() {
        view.layoutSubtreeIfNeeded()
        let bodyHeight = ceil(body.fittingSize.height)
        let chrome = ceil(header.fittingSize.height) + Theme.gutter * 2 + Theme.rowGap * 3 + 30
        let natural = chrome + bodyHeight
        let preferred = max(Theme.preferredHeight, min(Theme.maxHeight, natural))
        let overflowing = natural > Theme.maxHeight
        scrollView.hasVerticalScroller = overflowing
        scrollHeight?.constant = max(120, preferred - chrome)
        preferredContentSize = NSSize(width: Theme.width, height: preferred)
    }

    // MARK: - Actions

    @objc private func dashboardTapped() { onDashboard?() }
    @objc private func logsTapped() { onLogs?() }
    @objc private func refreshTapped() { onRefresh?() }
    @objc private func restartTapped() { onRestart?() }

    public override func cancelOperation(_ sender: Any?) {
        view.window?.performClose(nil)
    }

    // MARK: - Test hooks

    package var quotaAccordion: ProviderQuotaAccordionView { quotas }
    package var activityView: AgentActivityView { activity }
    package var headerView: StatusHeaderView { header }
    package var footerTitles: [String] {
        [dashboardButton.title, logsButton.title, refreshButton.title, restartButton.title]
    }
    package func activateFooterForTesting(_ index: Int) {
        let buttons = [dashboardButton, logsButton, refreshButton, restartButton]
        guard buttons.indices.contains(index) else { return }
        buttons[index].performClick(nil)
    }
}

final class FlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

import AppKit
import MenuBarCore

/// Single provider-quota accordion. ChatGPT/OpenAI first and expanded by default.
///
/// There is deliberately no second provider list. Manage deep-links into the dashboard.
public final class ProviderQuotaAccordionView: NSView {
    private let heading = makeLabel("Provider quotas", font: Theme.captionMedium, color: Theme.muted)
    private let updated = makeLabel("", font: Theme.caption, color: Theme.faint)
    private let rows = NSStackView()
    private let empty = makeLabel("", font: Theme.caption, color: Theme.muted)
    private var expandedProviders: Set<String> = []
    private var didSeedExpansion = false
    private var currentReports: [QuotaReport] = []

    public var onManage: ((String) -> Void)?
    public var onViewAll: (() -> Void)?

    private let viewAllButton = NSButton()

    public override init(frame: NSRect) {
        super.init(frame: frame)
        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 5

        empty.lineBreakMode = .byWordWrapping
        empty.maximumNumberOfLines = 2
        empty.preferredMaxLayoutWidth = Theme.width - Theme.gutter * 2

        viewAllButton.title = "View all providers"
        viewAllButton.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)
        viewAllButton.imagePosition = .imageTrailing
        viewAllButton.alignment = .left
        viewAllButton.bezelStyle = .recessed
        viewAllButton.isBordered = false
        viewAllButton.font = Theme.caption
        viewAllButton.contentTintColor = Theme.text
        viewAllButton.target = self
        viewAllButton.action = #selector(viewAllTapped)
        viewAllButton.setAccessibilityLabel("View all providers")
        viewAllButton.setButtonType(.momentaryPushIn)
        viewAllButton.translatesAutoresizingMaskIntoConstraints = false
        viewAllButton.heightAnchor.constraint(equalToConstant: 24).isActive = true

        let header = makeRow([heading, updated, NSView()], spacing: 8)
        let stack = NSStackView(views: [header, rows, empty, viewAllButton])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.tightGap
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            rows.widthAnchor.constraint(equalTo: stack.widthAnchor),
            empty.widthAnchor.constraint(equalTo: stack.widthAnchor),
            viewAllButton.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Provider quotas")
    }

    public convenience init() { self.init(frame: .zero) }
    public required init?(coder: NSCoder) { nil }

    public func apply(_ snapshot: ProxySnapshot) {
        for view in rows.arrangedSubviews {
            rows.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        guard snapshot.quotasLoaded else {
            currentReports = []
            rows.isHidden = true
            empty.isHidden = false
            empty.stringValue = "Quotas unavailable"
            viewAllButton.isHidden = false
            updated.stringValue = ""
            return
        }

        let ordered = orderedReports(snapshot.quotas)
        currentReports = ordered
        seedExpansionIfNeeded(ordered)

        let quotaUpdated = ordered.compactMap(\.freshnessDate).max()
        if let last = quotaUpdated {
            updated.stringValue = "Updated \(Format.age(last))"
        } else {
            updated.stringValue = "Update time unavailable"
        }

        if ordered.isEmpty {
            rows.isHidden = true
            empty.isHidden = false
            empty.stringValue = "No provider quota sources connected"
            viewAllButton.isHidden = false
            return
        }

        empty.isHidden = true
        rows.isHidden = false
        viewAllButton.isHidden = false

        for report in ordered {
            let expanded = expandedProviders.contains(report.provider)
            let row = ProviderQuotaRowView(
                report: report,
                expanded: expanded,
                onToggle: { [weak self] in self?.toggle(report.provider) },
                onManage: { [weak self] in self?.onManage?(report.provider) }
            )
            row.translatesAutoresizingMaskIntoConstraints = false
            rows.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
        }
    }

    /// Stable order: ChatGPT/OpenAI first, then Kimi, Grok, then remaining alpha.
    public func orderedReports(_ reports: [QuotaReport]) -> [QuotaReport] {
        func rank(_ provider: String) -> Int {
            switch provider.lowercased() {
            case "openai", "chatgpt", "openai-apikey": return 0
            case "kimi", "kimi-code": return 1
            case "xai": return 2
            default: return 10
            }
        }
        return reports.sorted { lhs, rhs in
            let lr = rank(lhs.provider)
            let rr = rank(rhs.provider)
            if lr != rr { return lr < rr }
            let left = (lhs.label ?? lhs.provider).lowercased()
            let right = (rhs.label ?? rhs.provider).lowercased()
            return left < right
        }
    }

    private func seedExpansionIfNeeded(_ reports: [QuotaReport]) {
        guard !didSeedExpansion else { return }
        didSeedExpansion = true
        if let first = reports.first(where: {
            let p = $0.provider.lowercased()
            return p == "openai" || p == "chatgpt" || p == "openai-apikey"
        }) {
            expandedProviders = [first.provider]
        } else if let first = reports.first {
            expandedProviders = [first.provider]
        }
    }

    private func toggle(_ provider: String) {
        if expandedProviders.contains(provider) {
            expandedProviders.remove(provider)
        } else {
            expandedProviders = [provider]
        }
        // Rebuild from last known reports.
        for view in rows.arrangedSubviews {
            rows.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for report in currentReports {
            let expanded = expandedProviders.contains(report.provider)
            let row = ProviderQuotaRowView(
                report: report,
                expanded: expanded,
                onToggle: { [weak self] in self?.toggle(report.provider) },
                onManage: { [weak self] in self?.onManage?(report.provider) }
            )
            row.translatesAutoresizingMaskIntoConstraints = false
            rows.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
        }
        (window?.contentViewController as? PopoverViewController)?.refreshSize()
    }

    @objc private func viewAllTapped() { onViewAll?() }

    // MARK: - Test hooks

    package var expandedProviderIDs: Set<String> { expandedProviders }
    package var providerRowCount: Int { rows.arrangedSubviews.count }
    package var providerIDs: [String] { currentReports.map(\.provider) }
    package func toggleForTesting(_ provider: String) { toggle(provider) }
    package func triggerViewAllForTesting() { onViewAll?() }
    package func triggerManageForTesting(_ provider: String) { onManage?(provider) }
    package func providerHeaderHitTestingWorksForTesting(_ provider: String) -> Bool {
        layoutSubtreeIfNeeded()
        return rows.arrangedSubviews
            .compactMap { $0 as? ProviderQuotaRowView }
            .first(where: { $0.providerID == provider })?
            .headerHitTestingWorksForTesting() == true
    }
}

final class ProviderQuotaRowView: NSView {
    let providerID: String

    init(
        report: QuotaReport,
        expanded: Bool,
        onToggle: @escaping () -> Void,
        onManage: @escaping () -> Void
    ) {
        self.providerID = report.provider
        super.init(frame: .zero)

        let display = ResourceAssets.providerDisplayName(report.provider, label: report.label)
        let iconView = NSImageView()
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.widthAnchor.constraint(equalToConstant: 16).isActive = true
        iconView.heightAnchor.constraint(equalToConstant: 16).isActive = true
        if let icon = ResourceAssets.providerIcon(for: report.provider) {
            iconView.image = icon
            iconView.contentTintColor = Theme.text
        } else {
            iconView.image = NSImage(systemSymbolName: "questionmark.circle", accessibilityDescription: nil)
            iconView.contentTintColor = Theme.faint
        }

        let name = makeLabel(display, font: Theme.captionMedium, color: Theme.text)
        let chevron = NSImageView()
        chevron.image = NSImage(
            systemSymbolName: expanded ? "chevron.up" : "chevron.down",
            accessibilityDescription: expanded ? "Collapse" : "Expand"
        )
        chevron.contentTintColor = Theme.faint
        chevron.translatesAutoresizingMaskIntoConstraints = false
        chevron.widthAnchor.constraint(equalToConstant: 12).isActive = true
        chevron.heightAnchor.constraint(equalToConstant: 12).isActive = true

        let summary = makeLabel(collapsedSummary(report), font: Theme.micro, color: Theme.faint)

        let manage = ActionButton(title: "PROVIDER", handler: onManage)
        manage.bezelStyle = .texturedRounded
        manage.controlSize = .mini
        manage.font = NSFont.systemFont(ofSize: 8, weight: .medium)
        manage.contentTintColor = Theme.muted
        manage.setAccessibilityLabel("Manage \(display)")

        let headerLeft = makeRow([iconView, name], spacing: 8)
        let headerRight = makeRow(expanded ? [manage, chevron] : [summary, chevron], spacing: 6)
        let header = makeRow([headerLeft, NSView(), headerRight], spacing: 8)

        let headerButton = ActionButton(title: "", handler: onToggle)
        headerButton.isBordered = false
        headerButton.setButtonType(.momentaryChange)
        headerButton.title = ""
        headerButton.imagePosition = .imageOnly
        headerButton.setAccessibilityLabel("\(display) quotas")
        headerButton.setAccessibilityRole(.button)

        let headerHost = NSView()
        header.translatesAutoresizingMaskIntoConstraints = false
        headerButton.translatesAutoresizingMaskIntoConstraints = false
        headerHost.addSubview(header)
        // Keep the full row clickable while leaving the nested Manage button in front.
        // A transparent button placed *behind* an NSStackView is inert because AppKit's
        // hit-testing stops at the stack or one of its labels. Put the button above the
        // presentation hierarchy and explicitly pass through only the real nested control.
        headerButton.passthroughView = expanded ? manage : nil
        headerHost.addSubview(headerButton, positioned: .above, relativeTo: header)
        NSLayoutConstraint.activate([
            headerButton.topAnchor.constraint(equalTo: headerHost.topAnchor),
            headerButton.leadingAnchor.constraint(equalTo: headerHost.leadingAnchor),
            headerButton.trailingAnchor.constraint(equalTo: headerHost.trailingAnchor),
            headerButton.bottomAnchor.constraint(equalTo: headerHost.bottomAnchor),
            header.topAnchor.constraint(equalTo: headerHost.topAnchor),
            header.leadingAnchor.constraint(equalTo: headerHost.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: headerHost.trailingAnchor),
            header.bottomAnchor.constraint(equalTo: headerHost.bottomAnchor),
            headerHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 20),
        ])

        var arranged: [NSView] = [headerHost]
        if expanded {
            let windows = report.normalizedWindows()
            if windows.isEmpty {
                let missing = makeLabel("Unavailable", font: Theme.caption, color: Theme.muted)
                arranged.append(missing)
            } else {
                for window in windows {
                    arranged.append(QuotaWindowRowView(window: window))
                }
            }
        }

        let column = NSStackView(views: arranged)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.edgeInsets = NSEdgeInsets(top: 4, left: 10, bottom: 4, right: 10)
        column.wantsLayer = true
        column.layer?.cornerRadius = Theme.cardRadius
        column.layer?.backgroundColor = Theme.card.cgColor
        column.layer?.borderWidth = 1
        column.layer?.borderColor = Theme.cardBorder.cgColor
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            headerHost.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -20),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("\(display) provider quotas")

        self.headerButton = headerButton
        self.manageButton = expanded ? manage : nil
    }

    required init?(coder: NSCoder) { nil }

    private weak var headerButton: ActionButton?
    private weak var manageButton: ActionButton?

    func headerHitTestingWorksForTesting() -> Bool {
        layoutSubtreeIfNeeded()
        guard let headerButton,
              headerButton.bounds.width > 0,
              headerButton.bounds.height > 0
        else { return false }

        let togglePoint = NSPoint(
            x: min(8, headerButton.bounds.midX),
            y: headerButton.bounds.midY
        )
        guard headerButton.hitTest(togglePoint) === headerButton else { return false }

        guard let manageButton else { return true }
        let managePoint = headerButton.convert(
            NSPoint(x: manageButton.bounds.midX, y: manageButton.bounds.midY),
            from: manageButton
        )
        return headerButton.hitTest(managePoint) == nil
    }

    private func collapsedSummary(_ report: QuotaReport) -> String {
        let windows = report.normalizedWindows().filter(\.hasPercent)
        guard !windows.isEmpty else { return "Unavailable" }
        let parts = windows.prefix(3).map { window -> String in
            let label: String
            switch window.windowLabel {
            case "5h": label = "5h"
            case "week": label = "Weekly"
            case "month": label = "Monthly"
            default: label = window.windowLabel
            }
            return "\(label) \(Format.percent(window.percent))"
        }
        var text = parts.joined(separator: " · ")
        if windows.count == 1, let reset = compactReset(windows[0]) {
            text += " · \(reset)"
        }
        return text
    }

    private func compactReset(_ window: NormalizedQuota) -> String? {
        guard let date = window.resetAt else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        if window.windowLabel == "month" {
            formatter.dateFormat = "MMM d"
            return "Renews \(formatter.string(from: date))"
        }
        if window.windowLabel == "week" {
            formatter.dateFormat = "EEE"
            return "Resets \(formatter.string(from: date))"
        }
        return "Resets in \(Format.resetsIn(date))"
    }
}

/// Button owns its action closure, so rebuilding a polling-driven row does not leave
/// global target-retention entries behind.
private final class ActionButton: NSButton {
    private let handler: () -> Void
    weak var passthroughView: NSView?

    init(title: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(frame: .zero)
        self.title = title
        target = self
        action = #selector(fire)
    }

    required init?(coder: NSCoder) { nil }

    @objc func fire() { handler() }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, alphaValue > 0, isEnabled, bounds.contains(point) else {
            return nil
        }
        if let passthroughView,
           !passthroughView.isHidden,
           passthroughView.bounds.contains(passthroughView.convert(point, from: self)) {
            return nil
        }
        // This button intentionally has no title or bezel: it is a semantic hit target
        // over custom header content. NSButton may otherwise treat that transparent cell
        // as having no hit area, so return the control explicitly inside its bounds.
        return self
    }
}

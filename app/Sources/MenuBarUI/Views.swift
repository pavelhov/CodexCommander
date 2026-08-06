import AppKit
import MenuBarCore

// MARK: - Shared helpers

func makeLabel(_ text: String, font: NSFont, color: NSColor) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = font
    field.textColor = color
    field.lineBreakMode = .byTruncatingTail
    field.backgroundColor = .clear
    field.isBezeled = false
    return field
}

func makeRow(_ views: [NSView], spacing: CGFloat = Theme.rowGap) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .horizontal
    stack.spacing = spacing
    stack.alignment = .centerY
    return stack
}

func makeSeparator() -> NSView {
    let line = NSView()
    line.wantsLayer = true
    line.layer?.backgroundColor = Theme.separator.cgColor
    line.translatesAutoresizingMaskIntoConstraints = false
    line.heightAnchor.constraint(equalToConstant: 1).isActive = true
    return line
}

// MARK: - Status header

/// Brand mark + OpenCodex title + truthful status + active count.
public final class StatusHeaderView: NSView {
    private let brand = NSImageView()
    private let title = makeLabel("OpenCodex", font: Theme.title, color: Theme.text)
    private let dot = StatusDotView()
    private let status = makeLabel("", font: Theme.captionMedium, color: Theme.muted)
    private let active = makeLabel("", font: Theme.caption, color: Theme.faint)
    private let divider: NSView = {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = Theme.cardBorder.cgColor
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: 1).isActive = true
        view.heightAnchor.constraint(equalToConstant: 18).isActive = true
        return view
    }()

    init() {
        super.init(frame: .zero)
        brand.image = ResourceAssets.brandImage(size: NSSize(width: 25, height: 25))
        brand.imageScaling = .scaleProportionallyUpOrDown
        brand.translatesAutoresizingMaskIntoConstraints = false
        brand.widthAnchor.constraint(equalToConstant: 25).isActive = true
        brand.heightAnchor.constraint(equalToConstant: 25).isActive = true

        let left = makeRow([brand, title], spacing: 8)
        let right = makeRow([dot, status, divider, active], spacing: 7)
        let row = NSStackView(views: [left, NSView(), right])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.distribution = .fill
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 30),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("OpenCodex status")
    }

    required init?(coder: NSCoder) { nil }

    func apply(_ snapshot: ProxySnapshot) {
        let state = snapshot.state
        let activeCount = snapshot.activity?.activeTurnCount
        if state.isRunning, let activeCount, snapshot.activityLoaded {
            status.stringValue = activeCount > 0 ? "Active" : "Idle"
        } else {
            status.stringValue = state.title
        }
        status.textColor = Theme.color(for: bridge(state.tone))
        dot.tone = bridge(state.tone)

        if let activeCount, snapshot.activityLoaded {
            active.stringValue = activeCount == 1 ? "1 active" : "\(activeCount) active"
            active.isHidden = false
            divider.isHidden = false
        } else {
            active.stringValue = ""
            active.isHidden = true
            divider.isHidden = true
        }

        var label = "OpenCodex \(state.title)"
        if let activeCount, snapshot.activityLoaded {
            label += ", \(activeCount) active"
        }
        setAccessibilityLabel(label)
    }

    private func bridge(_ tone: ProxyState.Tone) -> ProxyToneBridge {
        switch tone {
        case .neutral: return .neutral
        case .good: return .good
        case .warning: return .warning
        case .bad: return .bad
        }
    }
}

final class StatusDotView: NSView {
    var tone: ProxyToneBridge = .neutral {
        didSet { needsDisplay = true }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 8).isActive = true
        heightAnchor.constraint(equalToConstant: 8).isActive = true
    }

    required init?(coder: NSCoder) { nil }

    convenience init() { self.init(frame: .zero) }

    override var intrinsicContentSize: NSSize { NSSize(width: 8, height: 8) }

    override func draw(_ dirtyRect: NSRect) {
        let rect = NSRect(x: 0, y: (bounds.height - 8) / 2, width: 8, height: 8)
        Theme.color(for: tone).setFill()
        NSBezierPath(ovalIn: rect).fill()
    }
}

// MARK: - Agent activity

/// One-level tree of primary agents with emitted children; orphan subagents stand alone.
public final class AgentActivityView: NSView {
    private let heading = makeLabel("Agent activity", font: Theme.captionMedium, color: Theme.muted)
    private let body = NSStackView()
    private let empty = makeLabel("", font: Theme.caption, color: Theme.muted)

    init() {
        super.init(frame: .zero)
        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = 6
        empty.lineBreakMode = .byWordWrapping
        empty.maximumNumberOfLines = 2
        empty.preferredMaxLayoutWidth = Theme.width - Theme.gutter * 2

        let stack = NSStackView(views: [heading, body, empty])
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
            body.widthAnchor.constraint(equalTo: stack.widthAnchor),
            empty.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Agent activity")
    }

    required init?(coder: NSCoder) { nil }

    func apply(_ snapshot: ProxySnapshot) {
        for view in body.arrangedSubviews {
            body.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        guard snapshot.activityLoaded else {
            body.isHidden = true
            empty.isHidden = false
            empty.stringValue = "Activity unavailable"
            setAccessibilityLabel("Agent activity unavailable")
            return
        }

        guard let activity = snapshot.activity, activity.isSupported else {
            body.isHidden = true
            empty.isHidden = false
            empty.stringValue = "Activity unavailable"
            setAccessibilityLabel("Agent activity unavailable")
            return
        }

        let visible = activity.activities.filter {
            $0.phase == .starting || $0.phase == .running
        }

        if visible.isEmpty {
            body.isHidden = true
            empty.isHidden = false
            if activity.unattributedActiveCount > 0 {
                empty.stringValue = "\(activity.unattributedActiveCount) active turn\(activity.unattributedActiveCount == 1 ? "" : "s") unattributed"
            } else {
                empty.stringValue = "No active agents"
            }
            setAccessibilityLabel(empty.stringValue)
            return
        }

        empty.isHidden = true
        body.isHidden = false

        let byID = Dictionary(uniqueKeysWithValues: visible.map { ($0.id, $0) })
        let children = Dictionary(grouping: visible.filter { $0.role == .subagent && $0.parentId != nil }) {
            $0.parentId!
        }
        var rendered = Set<String>()

        // Primaries first, then their children.
        let primaries = visible.filter { $0.role == .primary }
            .sorted { $0.startedAt < $1.startedAt }
        for primary in primaries {
            appendRow(primary, indented: false)
            rendered.insert(primary.id)
            let kids = (children[primary.id] ?? []).sorted { $0.startedAt < $1.startedAt }
            for child in kids {
                appendRow(child, indented: true)
                rendered.insert(child.id)
            }
        }

        // Orphan subagents and any remaining nodes stand alone.
        let orphans = visible
            .filter { !rendered.contains($0.id) }
            .sorted { $0.startedAt < $1.startedAt }
        for item in orphans {
            // If parent exists in snapshot but was filtered out, still show as standalone.
            _ = byID
            appendRow(item, indented: false)
            rendered.insert(item.id)
        }

        if activity.truncated {
            let note = makeLabel("Showing active subset", font: Theme.micro, color: Theme.faint)
            body.addArrangedSubview(note)
        }
        if activity.unattributedActiveCount > 0 {
            let note = makeLabel(
                "+\(activity.unattributedActiveCount) unattributed",
                font: Theme.micro,
                color: Theme.faint
            )
            body.addArrangedSubview(note)
        }

        setAccessibilityLabel("Agent activity, \(visible.count) shown")
    }

    private func appendRow(_ activity: AgentActivity, indented: Bool) {
        let row = AgentActivityRowView(activity: activity, indented: indented)
        row.translatesAutoresizingMaskIntoConstraints = false
        body.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
    }
}

final class AgentActivityRowView: NSView {
    init(activity: AgentActivity, indented: Bool) {
        super.init(frame: .zero)

        let badge = NSView()
        badge.wantsLayer = true
        badge.layer?.cornerRadius = 5
        badge.layer?.backgroundColor = Theme.card.cgColor
        badge.layer?.borderWidth = 1
        badge.layer?.borderColor = Theme.cardBorder.cgColor
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.widthAnchor.constraint(equalToConstant: 24).isActive = true
        badge.heightAnchor.constraint(equalToConstant: 24).isActive = true

        let providerIcon = NSImageView()
        providerIcon.image = activity.provider.flatMap { ResourceAssets.providerIcon(for: $0) }
            ?? NSImage(systemSymbolName: "circle.dashed", accessibilityDescription: nil)
        providerIcon.contentTintColor = Theme.text
        providerIcon.imageScaling = .scaleProportionallyUpOrDown
        providerIcon.translatesAutoresizingMaskIntoConstraints = false
        badge.addSubview(providerIcon)
        NSLayoutConstraint.activate([
            providerIcon.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
            providerIcon.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
            providerIcon.widthAnchor.constraint(equalToConstant: 15),
            providerIcon.heightAnchor.constraint(equalToConstant: 15),
        ])

        let phaseDot = StatusDotView()
        phaseDot.tone = activity.phase == .running ? .good : .neutral

        let name = makeLabel(activity.displayName, font: Theme.label, color: Theme.text)
        let phase = makeLabel(
            activity.phase == .running ? "Running" : "Starting",
            font: Theme.caption,
            color: activity.phase == .running ? Theme.green : Theme.muted
        )
        let role = activity.role == .primary ? "Primary" : "Subagent"
        let meta = makeLabel(role, font: Theme.micro, color: Theme.faint)
        let elapsed = makeLabel(elapsedText(since: activity.startedAt), font: Theme.numericSmall, color: Theme.faint)
        elapsed.alignment = .right
        elapsed.translatesAutoresizingMaskIntoConstraints = false
        elapsed.widthAnchor.constraint(equalToConstant: 38).isActive = true

        let labels = NSStackView(views: [name, meta])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 1

        let state = makeRow([phaseDot, phase], spacing: 5)
        let row = NSStackView(views: [badge, labels, NSView(), state, elapsed])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 7
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        let leading: CGFloat = indented ? 26 : 0
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor, constant: 1),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: leading),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -1),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 30),
        ])

        if indented {
            let connector = AgentTreeConnectorView()
            connector.translatesAutoresizingMaskIntoConstraints = false
            addSubview(connector, positioned: .below, relativeTo: row)
            NSLayoutConstraint.activate([
                connector.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
                connector.topAnchor.constraint(equalTo: topAnchor, constant: -14),
                connector.bottomAnchor.constraint(equalTo: bottomAnchor),
                connector.widthAnchor.constraint(equalToConstant: 14),
            ])
        }

        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel("\(activity.displayName), \(activity.phase.rawValue)")
    }

    required init?(coder: NSCoder) { nil }

    private func elapsedText(since milliseconds: Int64) -> String {
        let elapsed = max(0, Int(Date().timeIntervalSince1970 - Double(milliseconds) / 1_000))
        if elapsed >= 3_600 { return String(format: "%d:%02d", elapsed / 3_600, (elapsed % 3_600) / 60) }
        return String(format: "%02d:%02d", elapsed / 60, elapsed % 60)
    }
}

private final class AgentTreeConnectorView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        Theme.graphMark.withAlphaComponent(0.42).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1
        path.move(to: NSPoint(x: 1, y: bounds.maxY))
        path.line(to: NSPoint(x: 1, y: bounds.midY))
        path.line(to: NSPoint(x: bounds.maxX, y: bounds.midY))
        path.stroke()
    }
}

// MARK: - Quotas

final class QuotaBarView: NSView {
    var percent: Double? {
        didSet { needsDisplay = true }
    }

    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 6) }

    override func draw(_ dirtyRect: NSRect) {
        let track = NSRect(x: 0, y: (bounds.height - 6) / 2, width: bounds.width, height: 6)
        Theme.raised.setFill()
        NSBezierPath(roundedRect: track, xRadius: 3, yRadius: 3).fill()

        guard let percent, percent.isFinite else { return }
        let clamped = max(0, min(100, percent))
        guard clamped > 0 else { return }
        let fill = NSRect(
            x: 0,
            y: track.origin.y,
            width: track.width * CGFloat(clamped / 100),
            height: 6
        )
        Theme.quotaColor(percent: percent).setFill()
        NSBezierPath(roundedRect: fill, xRadius: 3, yRadius: 3).fill()
    }
}

/// One real quota window row inside an expanded provider card.
final class QuotaWindowRowView: NSView {
    init(window: NormalizedQuota) {
        super.init(frame: .zero)

        let title = makeLabel(windowTitle(window.windowLabel), font: Theme.caption, color: Theme.text)
        title.translatesAutoresizingMaskIntoConstraints = false
        title.widthAnchor.constraint(equalToConstant: 82).isActive = true
        let used = makeLabel(
            window.hasPercent ? "\(Format.percent(window.percent)) used" : "Unavailable",
            font: Theme.numericSmall,
            color: Theme.muted
        )
        used.alignment = .right
        used.translatesAutoresizingMaskIntoConstraints = false
        used.widthAnchor.constraint(equalToConstant: 58).isActive = true
        let reset = makeLabel(
            resetText(window.resetAt, windowLabel: window.windowLabel),
            font: Theme.micro,
            color: Theme.faint
        )
        reset.alignment = .right
        reset.translatesAutoresizingMaskIntoConstraints = false
        reset.widthAnchor.constraint(equalToConstant: 84).isActive = true
        let bar = QuotaBarView()
        bar.percent = window.percent
        bar.translatesAutoresizingMaskIntoConstraints = false

        let row = makeRow([title, bar, used, reset], spacing: 6)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            bar.widthAnchor.constraint(greaterThanOrEqualToConstant: 78),
            bar.heightAnchor.constraint(equalToConstant: 5),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 20),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(
            window.hasPercent
                ? "\(windowTitle(window.windowLabel)): \(Format.percent(window.percent)) used, \(resetText(window.resetAt, windowLabel: window.windowLabel))"
                : "\(windowTitle(window.windowLabel)): unavailable"
        )
    }

    required init?(coder: NSCoder) { nil }

    private func windowTitle(_ label: String) -> String {
        switch label {
        case "5h": return "5-hour session"
        case "week": return "Weekly"
        case "month": return "Monthly"
        default: return label.capitalized
        }
    }

    private func resetText(_ date: Date?, windowLabel: String) -> String {
        guard let date else { return "Reset unknown" }
        let interval = date.timeIntervalSinceNow
        if interval <= 0 { return "Expired" }

        if windowLabel == "month" {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "MMM d"
            return "Renews \(formatter.string(from: date))"
        }
        if windowLabel == "week", interval > 86_400 * 2 {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "EEE"
            return "Resets \(formatter.string(from: date))"
        }
        if Calendar.current.isDateInTomorrow(date) {
            return "Resets tomorrow"
        }
        return "Resets in \(Format.resetsIn(date))"
    }
}

/// Text contract for published caps and local observations. Kept separate from
/// `NormalizedQuota`: these values must never acquire a percentage bar unless the
/// upstream provider actually supplied one.
package enum ReferenceQuotaPresentation {
    package static func horizon(_ window: QuotaReferenceWindow) -> String {
        switch window.id {
        case "five_hour": return "5h"
        case "weekly": return "7d"
        case "monthly": return "30d"
        default:
            let label = window.label?.trimmingCharacters(in: .whitespacesAndNewlines)
            return label?.isEmpty == false ? label! : "window"
        }
    }

    package static func capText(_ window: QuotaReferenceWindow) -> String {
        "\(horizon(window)) · Published cap \(Format.usdCap(window.publishedLimitUsd))"
    }

    package static func compactCapText(_ window: QuotaReferenceWindow) -> String {
        "\(Format.usdCap(window.publishedLimitUsd))/\(horizon(window))"
    }

    package static func observationText(_ window: QuotaReferenceWindow) -> String {
        let tokens = "\(Format.count(window.observedTokens)) tokens"
        let requests = max(0, window.observedRequests ?? 0)
        let requestText = "\(requests) request\(requests == 1 ? "" : "s")"
        switch window.observationQuality {
        case .none:
            return "No local usage observed"
        case .estimate:
            return "Estimate \(Format.usdEstimate(window.observedSpendUsd)) · \(tokens) · \(requestText)"
        case .partial:
            let spend = Format.usdEstimate(window.observedSpendUsd)
            let estimate = spend == Format.unknown ? "spend unavailable" : "estimate \(spend)"
            return "Partial \(estimate) · \(tokens) · \(requestText)"
        }
    }

    package static func limitTitle(_ event: QuotaObservedLimitEvent) -> String {
        let raw = event.limitName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name: String
        switch raw?.lowercased() {
        case "5 hour": name = "5-hour"
        case "weekly": name = "weekly"
        case "monthly": name = "monthly"
        default: name = raw?.isEmpty == false ? raw! : "Provider"
        }
        return "Observed \(name) limit"
    }

    package static func limitDetail(
        _ event: QuotaObservedLimitEvent,
        now: Date = Date()
    ) -> String {
        let observed = QuotaReport.date(from: event.observedAt)
            .map { "observed \(Format.age($0, now: now))" }
            ?? "observation time unavailable"
        let reset = QuotaReport.date(from: event.resetAt)
            .map { "resets in \(Format.resetsIn($0, now: now))" }
            ?? "reset not supplied"
        return "Upstream event · \(observed) · \(reset)"
    }
}

/// A published cap with local estimate/coverage text. No progress bar is rendered:
/// dividing observed spend by this cap would manufacture provider quota state.
final class ReferenceQuotaWindowRowView: NSView {
    init(window: QuotaReferenceWindow) {
        super.init(frame: .zero)

        let cap = makeLabel(
            ReferenceQuotaPresentation.capText(window),
            font: Theme.captionMedium,
            color: Theme.text
        )
        let observation = makeLabel(
            ReferenceQuotaPresentation.observationText(window),
            font: Theme.micro,
            color: Theme.muted
        )
        observation.lineBreakMode = .byTruncatingTail
        let column = NSStackView(views: [cap, observation])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 2
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            widthAnchor.constraint(greaterThanOrEqualToConstant: 300),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 30),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(
            "\(ReferenceQuotaPresentation.capText(window)). \(ReferenceQuotaPresentation.observationText(window))."
        )
    }

    required init?(coder: NSCoder) { nil }
}

/// A concrete upstream limit event is visually distinct from local estimates.
final class ObservedLimitEventRowView: NSView {
    init(event: QuotaObservedLimitEvent) {
        super.init(frame: .zero)

        let title = makeLabel(
            ReferenceQuotaPresentation.limitTitle(event),
            font: Theme.captionMedium,
            color: Theme.amber
        )
        let detail = makeLabel(
            ReferenceQuotaPresentation.limitDetail(event),
            font: Theme.micro,
            color: Theme.muted
        )
        detail.lineBreakMode = .byTruncatingTail
        let column = NSStackView(views: [title, detail])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 2
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            widthAnchor.constraint(greaterThanOrEqualToConstant: 300),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 30),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(
            "\(ReferenceQuotaPresentation.limitTitle(event)). \(ReferenceQuotaPresentation.limitDetail(event))."
        )
    }

    required init?(coder: NSCoder) { nil }
}

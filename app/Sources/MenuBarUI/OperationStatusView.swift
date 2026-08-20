import AppKit

/// Destination and user-facing copy for an explicit Codex route change.
public enum CodexRouteDestination: Equatable, Sendable {
    case nativeOpenAI
    case codexCommander

    package var name: String {
        switch self {
        case .nativeOpenAI: return "Native OpenAI"
        case .codexCommander: return "CodexCommander"
        }
    }
}

/// Coarse phases that correspond to real orchestration boundaries in AppDelegate.
/// The helper remains the authority for the actual config mutation.
public enum CodexRouteOperationPhase: Equatable, Sendable {
    case changing
    case confirming

    package func text(for destination: CodexRouteDestination) -> String {
        switch self {
        case .changing:
            return "Changing to the \(destination.name) route…"
        case .confirming:
            return "Confirming the saved Codex route…"
        }
    }
}

package enum OperationStatusTone: Equatable, Sendable {
    case success
    case warning
    case error
}

/// Compact, persistent status surface for route progress and lifecycle outcomes.
/// Progress can only be replaced by another state; results require explicit dismissal.
package final class OperationStatusView: NSView {
    private let spinner = NSProgressIndicator()
    private let stateIcon = NSImageView()
    private let title = makeLabel("", font: Theme.captionMedium, color: Theme.text)
    private let elapsed = makeLabel("", font: Theme.numericSmall, color: Theme.faint)
    private let detail: NSTextField = {
        let field = makeLabel("", font: Theme.caption, color: Theme.muted)
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 4
        return field
    }()
    private let technicalDetail: NSTextField = {
        let field = makeLabel("", font: Theme.micro, color: Theme.faint)
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 3
        field.isSelectable = true
        return field
    }()
    private let dismissButton = NSButton()

    private var timer: Timer?
    private var startedAt: Date?
    private var destination: CodexRouteDestination?
    private var phase: CodexRouteOperationPhase?
    package private(set) var lastRenderedTone: OperationStatusTone?

    var onDismiss: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        wantsLayer = true
        layer?.cornerRadius = Theme.cardRadius
        layer?.backgroundColor = Theme.card.cgColor
        layer?.borderWidth = 1
        layer?.borderColor = Theme.cardBorder.cgColor

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.widthAnchor.constraint(equalToConstant: 14).isActive = true
        spinner.heightAnchor.constraint(equalToConstant: 14).isActive = true
        spinner.setAccessibilityLabel("Codex route change in progress")

        stateIcon.imageScaling = .scaleProportionallyUpOrDown
        stateIcon.translatesAutoresizingMaskIntoConstraints = false
        stateIcon.widthAnchor.constraint(equalToConstant: 14).isActive = true
        stateIcon.heightAnchor.constraint(equalToConstant: 14).isActive = true

        elapsed.alignment = .right
        elapsed.setContentHuggingPriority(.required, for: .horizontal)

        dismissButton.title = "Dismiss"
        dismissButton.bezelStyle = .recessed
        dismissButton.isBordered = false
        dismissButton.controlSize = .small
        dismissButton.font = Theme.caption
        dismissButton.contentTintColor = Theme.muted
        dismissButton.target = self
        dismissButton.action = #selector(dismissTapped)
        dismissButton.setAccessibilityLabel("Dismiss status message")

        let leading = NSStackView(views: [spinner, stateIcon, title])
        leading.orientation = .horizontal
        leading.spacing = 6
        leading.alignment = .centerY

        let heading = NSStackView(views: [leading, NSView(), elapsed, dismissButton])
        heading.orientation = .horizontal
        heading.spacing = 6
        heading.alignment = .centerY

        let column = NSStackView(views: [heading, detail, technicalDetail])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.edgeInsets = NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)

        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
            heading.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -20),
            detail.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -20),
            technicalDetail.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -20),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("CodexCommander operation status")
        isHidden = true
    }

    required init?(coder: NSCoder) { nil }
    convenience init() { self.init(frame: .zero) }

    deinit { timer?.invalidate() }

    func beginRouteChange(
        to destination: CodexRouteDestination,
        phase: CodexRouteOperationPhase = .changing
    ) {
        stopTimer()
        self.destination = destination
        self.phase = phase
        startedAt = Date()
        spinner.isHidden = false
        spinner.startAnimation(nil)
        stateIcon.isHidden = true
        dismissButton.isHidden = true
        detail.isHidden = true
        technicalDetail.isHidden = true
        isHidden = false
        renderProgress(phase)

        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            self?.updateElapsed()
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
        announce(phase.text(for: destination), priority: .medium)
    }

    func beginOperation(_ operationTitle: String) {
        stopTimer()
        destination = nil
        phase = nil
        startedAt = Date()
        spinner.isHidden = false
        spinner.startAnimation(nil)
        stateIcon.isHidden = true
        dismissButton.isHidden = true
        title.stringValue = operationTitle
        title.textColor = Theme.text
        elapsed.stringValue = "0s"
        elapsed.isHidden = false
        detail.isHidden = true
        technicalDetail.isHidden = true
        isHidden = false
        setAccessibilityLabel("CodexCommander operation in progress")
        setAccessibilityValue("\(operationTitle) 0s")

        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            self?.updateElapsed()
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
        announce(operationTitle, priority: .medium)
    }

    func updateRoutePhase(_ phase: CodexRouteOperationPhase) {
        guard let destination, startedAt != nil else { return }
        self.phase = phase
        renderProgress(phase)
        announce(phase.text(for: destination), priority: .medium)
    }

    func showResult(
        title resultTitle: String,
        detail resultDetail: String? = nil,
        technicalDetail resultTechnicalDetail: String? = nil,
        tone: OperationStatusTone
    ) {
        stopTimer()
        lastRenderedTone = tone
        destination = nil
        phase = nil
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        stateIcon.isHidden = false
        stateIcon.image = NSImage(
            systemSymbolName: tone == .success
                ? "checkmark.circle.fill"
                : "exclamationmark.triangle.fill",
            accessibilityDescription: tone == .success
                ? "Completed"
                : (tone == .warning ? "Warning" : "Error")
        )
        stateIcon.contentTintColor = color(for: tone)
        title.stringValue = resultTitle
        title.textColor = tone == .error ? Theme.red : (tone == .warning ? Theme.amber : Theme.text)
        elapsed.stringValue = ""
        elapsed.isHidden = true
        dismissButton.isHidden = false

        detail.stringValue = resultDetail ?? ""
        detail.isHidden = resultDetail?.isEmpty != false
        technicalDetail.stringValue = resultTechnicalDetail.map { "Technical detail: \($0)" } ?? ""
        technicalDetail.isHidden = resultTechnicalDetail?.isEmpty != false
        isHidden = false

        let spoken = [resultTitle, resultDetail].compactMap { $0 }.joined(separator: ". ")
        setAccessibilityLabel(resultTitle)
        setAccessibilityValue(spoken)
        announce(spoken, priority: tone == .error ? .high : .medium)
    }

    func dismiss() {
        stopTimer()
        spinner.stopAnimation(nil)
        destination = nil
        phase = nil
        isHidden = true
    }

    private func renderProgress(_ phase: CodexRouteOperationPhase) {
        guard let destination else { return }
        let progressText = phase.text(for: destination)
        title.stringValue = progressText
        title.textColor = Theme.text
        elapsed.isHidden = false
        updateElapsed()
        spinner.setAccessibilityValue(progressText)
        setAccessibilityLabel("Codex route change in progress")
        setAccessibilityValue("\(progressText) \(elapsed.stringValue)")
    }

    private func updateElapsed(now: Date = Date()) {
        guard let startedAt else { return }
        let seconds = max(0, Int(now.timeIntervalSince(startedAt)))
        if seconds < 60 {
            elapsed.stringValue = "\(seconds)s"
        } else {
            elapsed.stringValue = String(format: "%d:%02d", seconds / 60, seconds % 60)
        }
        if let phase, let destination {
            setAccessibilityValue("\(phase.text(for: destination)) \(elapsed.stringValue)")
        } else {
            setAccessibilityValue("\(title.stringValue) \(elapsed.stringValue)")
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
        startedAt = nil
    }

    private func color(for tone: OperationStatusTone) -> NSColor {
        switch tone {
        case .success: return Theme.green
        case .warning: return Theme.amber
        case .error: return Theme.red
        }
    }

    private func announce(_ message: String, priority: NSAccessibilityPriorityLevel) {
        guard !message.isEmpty else { return }
        NSAccessibility.post(
            element: NSApplication.shared,
            notification: .announcementRequested,
            userInfo: [
                .announcement: message,
                .priority: priority.rawValue,
            ]
        )
    }

    @objc private func dismissTapped() {
        let window = window
        dismiss()
        onDismiss?()
        if let window {
            window.makeFirstResponder(window.contentView)
        }
    }

    // MARK: Test hooks

    package var titleText: String { title.stringValue }
    package var detailText: String? { detail.isHidden ? nil : detail.stringValue }
    package var technicalDetailText: String? {
        technicalDetail.isHidden ? nil : technicalDetail.stringValue
    }
    package var elapsedText: String? { elapsed.isHidden ? nil : elapsed.stringValue }
    package var isProgressVisible: Bool { !isHidden && !spinner.isHidden }
    package var isDismissVisible: Bool { !isHidden && !dismissButton.isHidden }
    package var stateToneName: String {
        if stateIcon.contentTintColor == Theme.amber { return "warning" }
        if stateIcon.contentTintColor == Theme.red { return "error" }
        if stateIcon.contentTintColor == Theme.green { return "success" }
        return "unknown"
    }
    package var accessibilityStatusValue: String? { accessibilityValue() as? String }
    package func advanceElapsedForTesting(by seconds: TimeInterval) {
        guard let startedAt else { return }
        updateElapsed(now: startedAt.addingTimeInterval(seconds))
    }
    package func activateDismissForTesting() { dismissButton.performClick(nil) }
}

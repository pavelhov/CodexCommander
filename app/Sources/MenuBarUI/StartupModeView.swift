import AppKit
import MenuBarCore

/// One compact startup control for all three outcomes:
/// Desktop (menu app at login), Headless (server only), and Off (manual start).
public final class StartupModeView: NSView {
    private let title = makeLabel(
        "Launch at Login",
        font: Theme.captionMedium,
        color: Theme.text
    )
    private let detail: NSTextField = {
        let field = makeLabel("", font: Theme.micro, color: Theme.faint)
        field.lineBreakMode = .byTruncatingTail
        return field
    }()
    private let toggle = NSSwitch()
    private let remediationButton = NSButton()
    private var applying = false
    private var remediation: LaunchAtLoginRemediation?

    public var onToggle: ((Bool) -> Void)?
    public var onRemediation: ((LaunchAtLoginRemediation) -> Void)?

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        toggle.controlSize = .small
        toggle.target = self
        toggle.action = #selector(toggleChanged)
        toggle.setAccessibilityLabel("Launch CodexCommander at login")

        remediationButton.imagePosition = .imageLeading
        remediationButton.bezelStyle = .recessed
        remediationButton.isBordered = false
        remediationButton.controlSize = .small
        remediationButton.font = Theme.caption
        remediationButton.contentTintColor = Theme.text
        remediationButton.target = self
        remediationButton.action = #selector(activateRemediation)
        remediationButton.isHidden = true

        let labels = NSStackView(views: [title, detail])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 1

        let row = NSStackView(views: [labels, NSView(), remediationButton, toggle])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = Theme.rowGap
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("CodexCommander startup mode")
    }

    public required init?(coder: NSCoder) { nil }

    public func apply(
        _ presentation: LaunchAtLoginPresentation,
        serviceManaged: Bool
    ) {
        applying = true
        toggle.state = presentation.isOn ? .on : .off
        toggle.isEnabled = presentation.isToggleEnabled
        toggle.alphaValue = toggle.isEnabled ? 1 : 0.5
        remediation = presentation.remediation
        applyRemediation(presentation.remediation)

        let summary = DesktopStartupMode.summary(
            loginStatus: presentation.status,
            serviceManaged: serviceManaged
        )
        if presentation.relocationRequired {
            detail.stringValue = "Move CodexCommander to Applications to launch at login."
            detail.textColor = Theme.faint
        } else {
            detail.stringValue = presentation.errorMessage ?? summary
            detail.textColor = presentation.errorMessage == nil ? Theme.faint : Theme.red
        }
        setAccessibilityLabel("CodexCommander startup mode, \(detail.stringValue)")
        applying = false
    }

    private func applyRemediation(_ remediation: LaunchAtLoginRemediation?) {
        remediationButton.isHidden = remediation == nil
        switch remediation {
        case .openSystemSettings:
            remediationButton.title = "Open Settings"
            remediationButton.toolTip = nil
            remediationButton.image = NSImage(
                systemSymbolName: "gearshape",
                accessibilityDescription: "Open Login Items settings"
            )
            remediationButton.setAccessibilityLabel("Open Login Items settings")
        case .openApplications:
            remediationButton.title = "Open Applications"
            remediationButton.toolTip =
                "Quit CodexCommander before moving the app, then reopen it from Applications."
            remediationButton.image = NSImage(
                systemSymbolName: "folder",
                accessibilityDescription: "Open Applications folder"
            )
            remediationButton.setAccessibilityLabel("Open Applications folder")
        case nil:
            remediationButton.title = ""
            remediationButton.toolTip = nil
            remediationButton.image = nil
            remediationButton.setAccessibilityLabel(nil)
        }
    }

    @objc private func toggleChanged() {
        guard !applying, toggle.isEnabled else { return }
        onToggle?(toggle.state == .on)
    }

    @objc private func activateRemediation() {
        guard let remediation else { return }
        onRemediation?(remediation)
    }

    package var modeText: String { detail.stringValue }
    package var modeTextColor: NSColor? { detail.textColor }
    package var isLaunchAtLoginOn: Bool { toggle.state == .on }
    package var isLaunchAtLoginToggleEnabled: Bool { toggle.isEnabled }
    package var showsRemediationButton: Bool { !remediationButton.isHidden }
    package var remediationButtonTitle: String { remediationButton.title }
    package var remediationButtonAccessibilityLabel: String? {
        remediationButton.accessibilityLabel()
    }
    package var remediationButtonToolTip: String? { remediationButton.toolTip }
    package func activateLaunchAtLoginToggleForTesting() { toggle.performClick(nil) }
    package func activateRemediationForTesting() { remediationButton.performClick(nil) }
}

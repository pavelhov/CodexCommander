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
    private let settingsButton = NSButton()
    private var applying = false

    public var onToggle: ((Bool) -> Void)?
    public var onOpenSettings: (() -> Void)?

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        toggle.controlSize = .small
        toggle.target = self
        toggle.action = #selector(toggleChanged)
        toggle.setAccessibilityLabel("Launch CodexCommander at login")

        settingsButton.title = "Open Settings"
        settingsButton.image = NSImage(
            systemSymbolName: "gearshape",
            accessibilityDescription: "Open Login Items settings"
        )
        settingsButton.imagePosition = .imageLeading
        settingsButton.bezelStyle = .recessed
        settingsButton.isBordered = false
        settingsButton.controlSize = .small
        settingsButton.font = Theme.caption
        settingsButton.contentTintColor = Theme.text
        settingsButton.target = self
        settingsButton.action = #selector(openSettings)
        settingsButton.setAccessibilityLabel("Open Login Items settings")
        settingsButton.isHidden = true

        let labels = NSStackView(views: [title, detail])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 1

        let row = NSStackView(views: [labels, NSView(), settingsButton, toggle])
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
        settingsButton.isHidden = !presentation.needsApproval

        let summary = DesktopStartupMode.summary(
            loginStatus: presentation.status,
            serviceManaged: serviceManaged
        )
        detail.stringValue = presentation.errorMessage ?? summary
        detail.textColor = presentation.errorMessage == nil ? Theme.faint : Theme.red
        setAccessibilityLabel("CodexCommander startup mode, \(summary)")
        applying = false
    }

    @objc private func toggleChanged() {
        guard !applying, toggle.isEnabled else { return }
        onToggle?(toggle.state == .on)
    }

    @objc private func openSettings() { onOpenSettings?() }

    package var modeText: String { detail.stringValue }
    package var isLaunchAtLoginOn: Bool { toggle.state == .on }
    package var isLaunchAtLoginToggleEnabled: Bool { toggle.isEnabled }
    package var showsSettingsButton: Bool { !settingsButton.isHidden }
    package func activateLaunchAtLoginToggleForTesting() { toggle.performClick(nil) }
}

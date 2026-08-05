import AppKit

/// Native nonactivating panel sized to the approved menu-bar surface.
public final class PopoverPanel: NSPanel {
    public var onDismiss: (() -> Void)?

    private var clickOutsideMonitor: Any?
    private var hostedController: NSViewController?

    public init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: Theme.width, height: Theme.preferredHeight),
            styleMask: [.nonactivatingPanel, .fullSizeContentView, .borderless],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .statusBar
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovable = false
        animationBehavior = .utilityWindow
    }

    public override var contentViewController: NSViewController? {
        get { hostedController }
        set {
            hostedController = newValue
            guard let content = newValue?.view else {
                contentView = nil
                return
            }
            let effect = NSVisualEffectView()
            effect.material = .popover
            effect.blendingMode = .behindWindow
            effect.state = .active
            effect.wantsLayer = true
            effect.layer?.cornerRadius = Theme.radius
            effect.layer?.masksToBounds = true
            effect.layer?.borderWidth = 1
            effect.layer?.borderColor = Theme.cardBorder.cgColor
            effect.translatesAutoresizingMaskIntoConstraints = false

            let host = NSView()
            host.addSubview(effect)
            effect.addSubview(content)
            content.translatesAutoresizingMaskIntoConstraints = false

            NSLayoutConstraint.activate([
                effect.topAnchor.constraint(equalTo: host.topAnchor),
                effect.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                effect.trailingAnchor.constraint(equalTo: host.trailingAnchor),
                effect.bottomAnchor.constraint(equalTo: host.bottomAnchor),
                content.topAnchor.constraint(equalTo: effect.topAnchor),
                content.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
                content.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
            ])
            contentView = host
        }
    }

    public var isPresentingModal = false
    public override var canBecomeKey: Bool { true }
    public override var canBecomeMain: Bool { false }
    public var isShown: Bool { isVisible }

    public func present(from button: NSStatusBarButton) {
        guard let buttonWindow = button.window else { return }
        layoutContent()

        let size = contentViewController?.preferredContentSize
            ?? NSSize(width: Theme.width, height: Theme.preferredHeight)
        setContentSize(NSSize(width: Theme.width, height: size.height))

        let buttonRect = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        var origin = NSPoint(
            x: buttonRect.midX - Theme.width / 2,
            y: buttonRect.minY - size.height - 6
        )

        if let screen = buttonWindow.screen ?? NSScreen.main {
            let visible = screen.visibleFrame
            origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - Theme.width - 8)
            origin.y = max(origin.y, visible.minY + 8)
        }

        setFrameOrigin(origin)
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        installClickOutsideMonitor()
    }

    public func dismiss() {
        guard isVisible else { return }
        removeClickOutsideMonitor()
        orderOut(nil)
        onDismiss?()
    }

    private func installClickOutsideMonitor() {
        removeClickOutsideMonitor()
        clickOutsideMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] _ in
            self?.dismiss()
        }
    }

    private func removeClickOutsideMonitor() {
        if let monitor = clickOutsideMonitor { NSEvent.removeMonitor(monitor) }
        clickOutsideMonitor = nil
    }

    public override func cancelOperation(_ sender: Any?) { dismiss() }

    public override func resignKey() {
        super.resignKey()
        guard !isPresentingModal else { return }
        if isVisible { dismiss() }
    }

    private func layoutContent() {
        contentViewController?.view.layoutSubtreeIfNeeded()
    }
}

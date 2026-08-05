import AppKit
import MenuBarCore

/// The menu bar glyph.
///
/// Uses an SF Symbol so the menu-bar mark stays crisp and follows macOS template-image
/// rendering without carrying a second handcrafted logo.
public enum StatusIcon {
    public static let size = NSSize(width: 17, height: 17)

    public static func image(for state: ProxyState) -> NSImage {
        let image = NSImage(
            systemSymbolName: symbolName(for: state),
            accessibilityDescription: accessibilityDescription(for: state)
        )
            ?? NSImage(systemSymbolName: "chevron.left.forwardslash.chevron.right", accessibilityDescription: "OpenCodex")
            ?? NSImage(size: size)
        image.isTemplate = true
        return image.withSymbolConfiguration(
            NSImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
        ) ?? image
    }

    /// Keep every operational state distinguishable while the panel is closed. The
    /// tooltip and VoiceOver description carry words; shape is the ambient visual cue.
    package static func symbolName(for state: ProxyState) -> String {
        switch state {
        case .loading:
            return "ellipsis.circle"
        case .running(let health):
            return health.isProtected ? "terminal.fill" : "exclamationmark.triangle.fill"
        case .unreachable:
            return "terminal"
        case .unauthorized:
            return "lock.slash"
        case .degraded:
            return "exclamationmark.triangle"
        }
    }

    private static func accessibilityDescription(for state: ProxyState) -> String {
        let detail = state.detail.map { ", \($0)" } ?? ""
        return "OpenCodex — \(state.title)\(detail)"
    }
}

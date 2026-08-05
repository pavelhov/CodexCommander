import AppKit

/// Visual tokens for the native dark translucent menu-bar panel.
///
/// Sized and toned to match the approved reference (~387×468). Semantic AppKit
/// colours track light/dark; accent blues/mints stay restrained so the surface
/// never competes with the system menu bar.
enum Theme {
    // Surfaces
    static let separator = NSColor.separatorColor
    static let raised = NSColor.white.withAlphaComponent(0.10)
    static let card = NSColor.white.withAlphaComponent(0.025)
    static let cardBorder = NSColor.white.withAlphaComponent(0.14)
    // Text
    static let text = dynamic(light: 0x1A1A1A, dark: 0xF5F5F7)
    static let muted = dynamic(light: 0x3D3D3D, dark: 0xC7C7CC)
    static let faint = dynamic(light: 0x545454, dark: 0xA0A0A6)
    static let graphMark = dynamic(light: 0x707070, dark: 0xD2D2D2)

    // State
    static let green = dynamic(light: 0x0A7D5C, dark: 0x4ECB9D)
    static let amber = dynamic(light: 0x9A4A08, dark: 0xFBBF24)
    static let red = dynamic(light: 0xB91C1C, dark: 0xF87171)

    // Type
    static let micro = NSFont.systemFont(ofSize: 10, weight: .regular)
    static let caption = NSFont.systemFont(ofSize: 11)
    static let captionMedium = NSFont.systemFont(ofSize: 11, weight: .medium)
    static let label = NSFont.systemFont(ofSize: 12, weight: .medium)
    static let title = NSFont.systemFont(ofSize: 15, weight: .semibold)
    static let numeric = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
    static let numericSmall = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)

    // Geometry matching the approved panel.
    static let gutter: CGFloat = 14
    static let rowGap: CGFloat = 8
    static let tightGap: CGFloat = 5
    static let sectionGap: CGFloat = 9
    static let radius: CGFloat = 12
    static let cardRadius: CGFloat = 7
    static let width: CGFloat = 387
    static let preferredHeight: CGFloat = 468
    static let maxHeight: CGFloat = 468

    static func color(for tone: ProxyToneBridge) -> NSColor {
        switch tone {
        case .neutral: return muted
        case .good: return green
        case .warning: return amber
        case .bad: return red
        }
    }

    /// Quota fill: green under 80, amber to 95, red above. Percentage is always printed.
    static func quotaColor(percent: Double?) -> NSColor {
        guard let percent else { return faint }
        if percent > 95 { return red }
        if percent >= 80 { return amber }
        return green
    }

    private static func dynamic(light: Int, dark: Int) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light)
        }
    }
}

enum ProxyToneBridge {
    case neutral, good, warning, bad
}

extension NSColor {
    convenience init(hex: Int, alpha: CGFloat = 1) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

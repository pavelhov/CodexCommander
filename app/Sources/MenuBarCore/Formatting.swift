import Foundation

/// Quota and date presentation for the compact popover. Unknown values are always an
/// em dash — never a plausible-looking zero.
public enum Format {
    public static let unknown = "—"

    public static func percent(_ value: Double?) -> String {
        // Provider payloads are external input. `Int(Double.nan)` and very large finite
        // doubles trap in Swift, so malformed quota data must degrade to unknown instead
        // of taking down the menu-bar process.
        guard let value, value.isFinite, abs(value) <= 1_000_000 else { return unknown }
        return "\(Int(value.rounded()))%"
    }

    /// Published dollar cap. Whole-dollar values stay compact (`$12`); malformed
    /// external values remain unknown rather than looking like a real provider fact.
    public static func usdCap(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0, value <= 1_000_000_000 else {
            return unknown
        }
        if value.rounded() == value { return String(format: "$%.0f", value) }
        return String(format: "$%.2f", value)
    }

    /// Local cost observations are pricing estimates, so retain cents even when zero.
    public static func usdEstimate(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0, value <= 1_000_000_000 else {
            return unknown
        }
        return String(format: "$%.2f", value)
    }

    public static func count(_ value: Int64?) -> String {
        guard let value, value >= 0 else { return unknown }
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        formatter.usesGroupingSeparator = true
        return formatter.string(from: NSNumber(value: value)) ?? unknown
    }

    /// "resets in 3d 4h" / "resets in 12m". Past dates read as "expired".
    public static func resetsIn(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return unknown }
        let interval = date.timeIntervalSince(now)
        guard interval > 0 else { return "expired" }

        let totalMinutes = Int(interval / 60)
        let days = totalMinutes / 1440
        let hours = (totalMinutes % 1440) / 60
        let minutes = totalMinutes % 60

        if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
        if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        return "\(max(minutes, 1))m"
    }

    /// "2m ago" for staleness labels on the degraded state.
    public static func age(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return unknown }
        let seconds = Int(now.timeIntervalSince(date))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        if seconds < 86_400 { return "\(seconds / 3600)h ago" }
        return "\(seconds / 86_400)d ago"
    }

}

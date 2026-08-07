import Foundation

/// Presentation-only source identity stamped by `build:macos`.
///
/// Release version and source revision answer different questions: two worktrees can
/// build version 2.10.2 from different commits. Keep the full revision in Info.plist
/// and use this bounded form in diagnostics/tooltips.
public enum BuildProvenance {
    public static func shortRevision(_ raw: Any?) -> String? {
        guard let value = raw as? String else { return nil }
        let dirty = value.hasSuffix("-dirty")
        let revision = dirty ? String(value.dropLast("-dirty".count)) : value
        guard revision.count == 40,
              revision.unicodeScalars.allSatisfy({ scalar in
                  (48...57).contains(scalar.value) || (65...70).contains(scalar.value)
                      || (97...102).contains(scalar.value)
              })
        else { return nil }
        return String(revision.prefix(8)) + (dirty ? "-dirty" : "")
    }
}

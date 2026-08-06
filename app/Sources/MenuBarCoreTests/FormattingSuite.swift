import Foundation
import MenuBarCore

enum FormattingSuite {
    static func run(_ t: TestRunner) {
        t.test("format: nil renders an em dash") {
            t.equal(Format.percent(nil), "—")
        }

        t.test("format: percent rounds") {
            t.equal(Format.percent(44), "44%")
            t.equal(Format.percent(86.82666666666667), "87%")
            t.equal(Format.percent(9.976811594202898), "10%")
        }

        t.test("format: malformed percentages degrade instead of trapping") {
            t.equal(Format.percent(.nan), "—")
            t.equal(Format.percent(.infinity), "—")
            t.equal(Format.percent(-.infinity), "—")
            t.equal(Format.percent(.greatestFiniteMagnitude), "—")
        }

        t.test("format: reference caps, estimates, and token counts stay explicit") {
            t.equal(Format.usdCap(12), "$12")
            t.equal(Format.usdCap(12.5), "$12.50")
            t.equal(Format.usdEstimate(0.3), "$0.30")
            t.equal(Format.usdEstimate(nil), "—")
            t.equal(Format.count(1_000_120), "1,000,120")
            t.equal(Format.count(nil), "—")
        }

        t.test("format: reset countdowns are coarse") {
            let now = Date(timeIntervalSince1970: 1_784_915_000)
            t.equal(Format.resetsIn(now.addingTimeInterval(60 * 30), now: now), "30m")
            t.equal(Format.resetsIn(now.addingTimeInterval(3600 * 5), now: now), "5h")
            t.equal(Format.resetsIn(now.addingTimeInterval(86_400 * 3 + 3600 * 4), now: now), "3d 4h")
            t.equal(Format.resetsIn(now.addingTimeInterval(-60), now: now), "expired")
            t.equal(Format.resetsIn(nil), "—")
        }

        t.test("format: staleness ages read naturally") {
            let now = Date(timeIntervalSince1970: 1_784_915_000)
            t.equal(Format.age(now.addingTimeInterval(-10), now: now), "just now")
            t.equal(Format.age(now.addingTimeInterval(-120), now: now), "2m ago")
            t.equal(Format.age(now.addingTimeInterval(-7200), now: now), "2h ago")
            t.equal(Format.age(nil), "—")
        }
    }
}

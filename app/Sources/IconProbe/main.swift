// Renders every menu bar glyph state to one sheet so the state signal can be verified
// visually.
import AppKit
import MenuBarCore
import MenuBarUI

func currentHealth(_ status: String) -> StartupHealth {
    StartupHealth(
        status: status, protection: "none", platform: "darwin",
        routingKind: "codexcommander-local", routingInjected: true,
        localRoutingDependency: true, autostartEnabled: false, serviceRunning: false,
        serviceInstalled: false, serviceViable: false, serviceEnabled: false,
        serviceStale: false, serviceConflict: false, serviceSupported: true,
        shimInstalled: false, shimHealthy: false, shimCoverage: "none", rebootSafe: false,
        diagnosticStale: false, recommendedCommand: nil,
        commands: .init(installService: "ccx service install", repairService: "ccx service repair",
                        installShim: "ccx codex-shim install", restoreNative: "ccx restore")
    )
}

let states: [(String, ProxyState)] = [
    ("protected", .running(currentHealth("protected"))),
    ("at-risk", .running(currentHealth("at-risk"))),
    ("loading", .loading),
    ("stopped", .unreachable),
]

let scale: CGFloat = 6
let cell = NSSize(width: 17 * scale, height: 17 * scale)
let sheet = NSImage(size: NSSize(width: cell.width * CGFloat(states.count), height: cell.height))
sheet.lockFocus()
NSColor.white.setFill()
NSRect(origin: .zero, size: sheet.size).fill()
for (i, entry) in states.enumerated() {
    let img = StatusIcon.image(for: entry.1)
    let rect = NSRect(x: CGFloat(i) * cell.width, y: 0, width: cell.width, height: cell.height)
    NSGraphicsContext.current?.imageInterpolation = .none
    img.draw(in: rect.insetBy(dx: 8, dy: 8))
}
sheet.unlockFocus()
if let tiff = sheet.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
   let png = rep.representation(using: .png, properties: [:]) {
    try? png.write(to: URL(fileURLWithPath: "/tmp/glyphs.png"))
}
print("wrote /tmp/glyphs.png:", states.map(\.0).joined(separator: ", "))

// Visual-QA harness (not shipped).
//
// Renders the production PopoverViewController with a deterministic realistic fixture
// matching the approved reference panel, writes a PNG, and exits. No live network.

import AppKit
import MenuBarCore
import MenuBarUI

final class ProbeDelegate: NSObject, NSApplicationDelegate {
    let controller = PopoverViewController()
    var panel: PopoverPanel?
    var outputPath = "/tmp/opencodex-ui-probe.png"

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)

        if CommandLine.arguments.count > 1 {
            outputPath = CommandLine.arguments[1]
        }

        let host = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 700),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        host.title = "OpenCodex UIProbe"
        host.backgroundColor = NSColor(calibratedRed: 0.72, green: 0.24, blue: 0.05, alpha: 1)
        host.isOpaque = true
        host.center()
        host.makeKeyAndOrderFront(nil)

        let realPanel = PopoverPanel()
        realPanel.contentViewController = controller
        let snap = Fixture.referenceSnapshot()
        controller.apply(snap)
        controller.view.layoutSubtreeIfNeeded()

        let width: CGFloat = 387
        let height = max(controller.preferredContentSize.height, 468)
        realPanel.setContentSize(NSSize(width: width, height: height))
        realPanel.setFrameOrigin(NSPoint(
            x: host.frame.midX - width / 2,
            y: host.frame.midY - height / 2
        ))
        realPanel.makeKeyAndOrderFront(nil)
        panel = realPanel
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.capture(width: width, height: height)
        }
    }

    @MainActor
    func capture(width: CGFloat, height: CGFloat) {
        // Prefer rasterizing the production view with an explicit dark material so the
        // PNG is legible even when CGWindowListCreateImage returns an empty translucent
        // surface under `swift run`.
        let bounds = NSRect(x: 0, y: 0, width: width, height: height)
        controller.view.frame = bounds
        controller.view.layoutSubtreeIfNeeded()
        controller.view.displayIfNeeded()

        let imageRep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(width * 2),
            pixelsHigh: Int(height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        )!
        imageRep.size = bounds.size

        NSGraphicsContext.saveGraphicsState()
        if let ctx = NSGraphicsContext(bitmapImageRep: imageRep) {
            NSGraphicsContext.current = ctx
            // Dark tonal falloff approximates the production popover material when an
            // offscreen bitmap has no window content behind it to blur.
            let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 12, yRadius: 12)
            path.addClip()
            NSGradient(
                starting: NSColor(calibratedWhite: 0.13, alpha: 0.98),
                ending: NSColor(calibratedWhite: 0.075, alpha: 0.98)
            )?.draw(in: bounds, angle: -90)
            NSColor.white.withAlphaComponent(0.16).setStroke()
            path.lineWidth = 1
            path.stroke()

            // Draw the exact production view tree over that material surrogate.
            controller.view.displayIgnoringOpacity(bounds, in: ctx)
        }
        NSGraphicsContext.restoreGraphicsState()

        if let png = imageRep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: outputPath))
            print(outputPath)
        } else {
            fputs("UIProbe failed to encode PNG\n", stderr)
        }
        NSApp.terminate(nil)
    }
}

private enum Fixture {
    static func referenceSnapshot() -> ProxySnapshot {
        let endpoint = ProxyEndpoint.default
        let now = Date()
        let ms = Int64(now.timeIntervalSince1970 * 1000)

        let activityJSON = """
        {
          "schemaVersion": 1,
          "generatedAt": \(ms),
          "proxyState": "running",
          "activeTurnCount": 3,
          "displayedActivityCount": 3,
          "unattributedActiveCount": 0,
          "truncated": false,
          "activities": [
            {
              "id": "primary-1",
              "parentId": null,
              "role": "primary",
              "provider": "openai",
              "model": "GPT-5.4",
              "phase": "running",
              "startedAt": \(ms - 120000),
              "firstOutputAt": \(ms - 110000)
            },
            {
              "id": "child-1",
              "parentId": "primary-1",
              "role": "subagent",
              "provider": "kimi",
              "model": "Kimi K2.5",
              "phase": "running",
              "startedAt": \(ms - 60000),
              "firstOutputAt": \(ms - 55000)
            },
            {
              "id": "orphan-1",
              "parentId": null,
              "role": "subagent",
              "provider": "xai",
              "model": "Grok Code",
              "phase": "starting",
              "startedAt": \(ms - 15000),
              "firstOutputAt": null
            }
          ]
        }
        """

        let quotasJSON = """
        [
          {
            "provider": "openai",
            "label": "ChatGPT",
            "source": "oauth",
            "updatedAt": \(ms),
            "quota": {
              "fiveHourPercent": 38,
              "weeklyPercent": 22,
              "fiveHourResetAt": \(now.addingTimeInterval(2 * 3600 + 14 * 60).timeIntervalSince1970),
              "weeklyResetAt": \(now.addingTimeInterval(3 * 86400).timeIntervalSince1970)
            }
          },
          {
            "provider": "kimi",
            "label": "Kimi",
            "source": "oauth",
            "updatedAt": \(ms),
            "quota": {
              "fiveHourPercent": 62,
              "weeklyPercent": 38,
              "monthlyPercent": 41,
              "fiveHourResetAt": \(now.addingTimeInterval(2 * 3600 + 14 * 60).timeIntervalSince1970),
              "weeklyResetAt": \(now.addingTimeInterval(2 * 86400).timeIntervalSince1970),
              "monthlyResetAt": \(now.addingTimeInterval(26 * 86400).timeIntervalSince1970)
            }
          },
          {
            "provider": "xai",
            "label": "Grok",
            "source": "oauth",
            "updatedAt": \(ms),
            "quota": {
              "monthlyPercent": 41,
              "monthlyResetAt": \(now.addingTimeInterval(26 * 86400).timeIntervalSince1970)
            }
          }
        ]
        """

        let activity = try! JSONDecoder().decode(
            AgentActivitySnapshot.self,
            from: Data(activityJSON.utf8)
        )
        let quotas = try! JSONDecoder().decode(
            [QuotaReport].self,
            from: Data(quotasJSON.utf8)
        )

        return ProxySnapshot(
            state: .running(StartupHealth(status: "protected", protection: "service")),
            endpoint: endpoint,
            quotas: quotas,
            activity: activity,
            providers: [],
            lastUpdated: now,
            providersLoaded: true,
            quotasLoaded: true,
            activityLoaded: true,
            credentialAvailability: .file
        )
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let d = ProbeDelegate()
app.delegate = d
app.run()

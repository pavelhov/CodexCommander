// Visual-QA harness (not shipped).
//
// Renders the production PopoverViewController with a deterministic realistic fixture
// matching the approved reference panel, writes a PNG, and exits. No live network.

import AppKit
import MenuBarCore
import MenuBarUI

func currentHealth(
    status: String = "protected",
    protection: String = "none",
    serviceRunning: Bool = false,
    serviceInstalled: Bool = false,
    serviceEnabled: Bool = false,
    rebootSafe: Bool = false
) -> StartupHealth {
    StartupHealth(
        status: status, protection: protection, platform: "darwin",
        routingKind: "codexcommander-local", routingInjected: true,
        localRoutingDependency: true, autostartEnabled: serviceEnabled,
        serviceRunning: serviceRunning, serviceInstalled: serviceInstalled,
        serviceViable: serviceEnabled, serviceEnabled: serviceEnabled,
        serviceStale: false, serviceConflict: false, serviceSupported: true,
        shimInstalled: false, shimHealthy: false, shimCoverage: "none", rebootSafe: rebootSafe,
        diagnosticStale: false, recommendedCommand: nil,
        commands: .init(installService: "ccx service install", repairService: "ccx service repair",
                        installShim: "ccx codex-shim install", restoreNative: "ccx restore")
    )
}

final class ProbeDelegate: NSObject, NSApplicationDelegate {
    let controller = PopoverViewController()
    var panel: PopoverPanel?
    var outputPath = "/tmp/codexcommander-ui-probe.png"
    var lightAppearance = false

    func applicationDidFinishLaunching(_ n: Notification) {
        lightAppearance = CommandLine.arguments.contains("--light")
        NSApp.appearance = NSAppearance(
            named: lightAppearance ? .aqua : .darkAqua
        )

        if CommandLine.arguments.count > 1 {
            outputPath = CommandLine.arguments[1]
        }

        let host = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 700),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        host.title = "CodexCommander UIProbe"
        host.backgroundColor = NSColor(calibratedRed: 0.72, green: 0.24, blue: 0.05, alpha: 1)
        host.isOpaque = true
        host.center()
        host.makeKeyAndOrderFront(nil)

        let realPanel = PopoverPanel()
        realPanel.contentViewController = controller
        let snap = Fixture.referenceSnapshot()
        controller.applyLaunchAtLogin(
            LaunchAtLoginPresentation(status: .enabled, desiredEnabled: true)
        )
        controller.apply(snap)
        if CommandLine.arguments.contains("--expand-grok") {
            controller.quotaAccordion.toggleForTesting("xai")
        }
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
            let startingWhite: CGFloat = lightAppearance ? 0.99 : 0.13
            let endingWhite: CGFloat = lightAppearance ? 0.95 : 0.075
            NSGradient(
                starting: NSColor(calibratedWhite: startingWhite, alpha: 0.98),
                ending: NSColor(calibratedWhite: endingWhite, alpha: 0.98)
            )?.draw(in: bounds, angle: -90)
            (lightAppearance ? NSColor.black : NSColor.white)
                .withAlphaComponent(lightAppearance ? 0.12 : 0.16)
                .setStroke()
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
          "activeTurnCount": 1,
          "displayedActivityCount": 1,
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
          }
        ]
        """

        // Grok is intentionally configured but absent from quota reports: this is the
        // expired/transient-probe state that must remain visible without a fake value.
        let providersJSON = """
        [
          {"name":"openai","adapter":"openai-responses","authMode":"forward","hasApiKey":false,"disabled":false,"quotaCapable":true},
          {"name":"kimi","adapter":"kimi","authMode":"oauth","hasApiKey":false,"disabled":false,"quotaCapable":true},
          {"name":"xai","adapter":"openai-chat","authMode":"oauth","hasApiKey":false,"disabled":false,"quotaCapable":true}
        ]
        """
        let availabilityJSON = """
        [
          {
            "provider": "xai",
            "status": "unavailable",
            "reason": "local_cli_refresh_required",
            "checkedAt": \(ms)
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
        let providers = try! JSONDecoder().decode(
            [ProviderSummary].self,
            from: Data(providersJSON.utf8)
        )
        let quotaAvailability = try! JSONDecoder().decode(
            [ProviderQuotaAvailability].self,
            from: Data(availabilityJSON.utf8)
        )

        return ProxySnapshot(
            state: .running(currentHealth(
                protection: "service", serviceRunning: true, serviceInstalled: true,
                serviceEnabled: true, rebootSafe: true
            )),
            endpoint: endpoint,
            quotas: quotas,
            quotaAvailability: quotaAvailability,
            activity: activity,
            providers: providers,
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

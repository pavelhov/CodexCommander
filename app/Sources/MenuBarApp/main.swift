import AppKit
import Darwin
import MenuBarCore
import MenuBarUI

func activateExistingMenuApp() {
    guard let bundleIdentifier = Bundle.main.bundleIdentifier else { return }
    let running = NSRunningApplication.runningApplications(
        withBundleIdentifier: bundleIdentifier
    )
    let currentPID = getpid()
    if let existingPID = MenuAppInstancePolicy.existingProcess(
        currentPID: currentPID,
        runningPIDs: running.map(\.processIdentifier)
    ), let existing = running.first(where: { $0.processIdentifier == existingPID }) {
        existing.activate(options: [.activateIgnoringOtherApps])
    }
}

let appInstanceLock: MenuAppInstanceLock?
switch MenuAppInstanceLock.acquire() {
case .acquired(let lock):
    appInstanceLock = lock
case .contended:
    activateExistingMenuApp()
    exit(EXIT_SUCCESS)
case .unavailable:
    // A protected temp directory should always support the lock. Keep the
    // LaunchServices-level duplicate check as a safe fallback if it does not.
    activateExistingMenuApp()
    let bundleIdentifier = Bundle.main.bundleIdentifier
    let hasExisting = bundleIdentifier.map {
        NSRunningApplication.runningApplications(withBundleIdentifier: $0)
            .contains { $0.processIdentifier != getpid() }
    } ?? false
    if hasExisting { exit(EXIT_SUCCESS) }
    appInstanceLock = nil
}

let app = NSApplication.shared
// .accessory keeps it out of the Dock; LSUIElement in Info.plist does the same for the
// packaged bundle, and this covers `swift run` during development.
app.setActivationPolicy(.accessory)

let delegate = AppDelegate()
app.delegate = delegate
app.run()

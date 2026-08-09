import Foundation
import MenuBarCore

private final class FakeLaunchAtLoginService: LaunchAtLoginServicing {
    enum Failure: Error { case register }

    var status: LaunchAtLoginStatus
    var registerCalls = 0
    var unregisterCalls = 0
    var settingsCalls = 0
    var failRegistration = false

    init(status: LaunchAtLoginStatus) { self.status = status }

    func register() throws {
        registerCalls += 1
        if failRegistration { throw Failure.register }
        if status != .requiresApproval { status = .enabled }
    }

    func unregister() throws {
        unregisterCalls += 1
        status = .disabled
    }

    func openSystemSettings() { settingsCalls += 1 }
}

private final class FakeLaunchAtLoginPreferences: LaunchAtLoginPreferenceStoring {
    var desiredEnabled: Bool?
    var registeredExecutableFingerprint: String?

    init(desired: Bool? = nil, fingerprint: String? = nil) {
        desiredEnabled = desired
        registeredExecutableFingerprint = fingerprint
    }
}

enum LaunchAtLoginSuite {
    static func run(_ t: TestRunner) {
        t.test("login: first app launch enables the desktop experience") {
            let service = FakeLaunchAtLoginService(status: .disabled)
            let preferences = FakeLaunchAtLoginPreferences()
            let controller = LaunchAtLoginController(
                service: service,
                preferences: preferences
            )

            let result = controller.reconcile(executableFingerprint: "build-a")

            t.equal(result.status, .enabled)
            t.equal(result.desiredEnabled, true)
            t.equal(service.registerCalls, 1)
            t.equal(preferences.registeredExecutableFingerprint, "build-a")
        }

        t.test("login: an explicit in-app switch-off stays off") {
            let service = FakeLaunchAtLoginService(status: .enabled)
            let preferences = FakeLaunchAtLoginPreferences(desired: true, fingerprint: "build-a")
            let controller = LaunchAtLoginController(
                service: service,
                preferences: preferences
            )

            let disabled = controller.setEnabled(false, executableFingerprint: "build-a")
            let reconciled = controller.reconcile(executableFingerprint: "build-b")

            t.equal(disabled.status, .disabled)
            t.equal(reconciled.status, .disabled)
            t.equal(service.unregisterCalls, 1)
            t.equal(service.registerCalls, 0)
            t.equal(preferences.desiredEnabled, false)
        }

        t.test("login: failed registration preserves intent without claiming success") {
            let service = FakeLaunchAtLoginService(status: .disabled)
            service.failRegistration = true
            let preferences = FakeLaunchAtLoginPreferences()
            let controller = LaunchAtLoginController(
                service: service,
                preferences: preferences
            )

            let result = controller.reconcile(executableFingerprint: "build-a")

            t.equal(result.status, .disabled)
            t.equal(result.desiredEnabled, true)
            t.equal(result.errorMessage, "CodexCommander could not update Launch at Login.")
            t.equal(preferences.registeredExecutableFingerprint, nil)
        }

        t.test("login: rebuilt source app refreshes an enabled registration once") {
            let service = FakeLaunchAtLoginService(status: .enabled)
            let preferences = FakeLaunchAtLoginPreferences(desired: true, fingerprint: "build-a")
            let controller = LaunchAtLoginController(
                service: service,
                preferences: preferences
            )

            let refreshed = controller.reconcile(executableFingerprint: "build-b")
            _ = controller.reconcile(executableFingerprint: "build-b")

            t.equal(refreshed.status, .enabled)
            t.equal(service.unregisterCalls, 1)
            t.equal(service.registerCalls, 1)
            t.equal(preferences.registeredExecutableFingerprint, "build-b")
        }

        t.test("login: System Settings revocation is surfaced, not fought") {
            let service = FakeLaunchAtLoginService(status: .requiresApproval)
            let preferences = FakeLaunchAtLoginPreferences(desired: true, fingerprint: "build-a")
            let controller = LaunchAtLoginController(
                service: service,
                preferences: preferences
            )

            let result = controller.reconcile(executableFingerprint: "build-b")
            controller.openSystemSettings()

            t.equal(result.status, .requiresApproval)
            t.equal(result.needsApproval, true)
            t.equal(service.registerCalls, 0)
            t.equal(service.unregisterCalls, 0)
            t.equal(service.settingsCalls, 1)
        }

        t.test("login: an unstable app path never creates a registration") {
            let service = FakeLaunchAtLoginService(status: .disabled)
            let preferences = FakeLaunchAtLoginPreferences()
            let controller = LaunchAtLoginController(
                service: service,
                preferences: preferences
            )

            let result = controller.reconcile(
                executableFingerprint: "build-a",
                registrationAllowed: false
            )
            let refreshed = controller.currentPresentation(registrationAllowed: false)

            t.equal(result.status, .unavailable)
            t.equal(refreshed.status, .unavailable)
            t.equal(service.registerCalls, 0)
            t.equal(preferences.desiredEnabled, nil)
        }

        t.test("login: external enablement becomes the current preference") {
            let service = FakeLaunchAtLoginService(status: .enabled)
            let preferences = FakeLaunchAtLoginPreferences(desired: false, fingerprint: "build-a")
            let controller = LaunchAtLoginController(
                service: service,
                preferences: preferences
            )

            let result = controller.currentPresentation()

            t.equal(result.isOn, true)
            t.equal(preferences.desiredEnabled, true)
        }

        t.test("login: mode labels distinguish desktop, headless, and off") {
            t.equal(
                DesktopStartupMode.resolve(loginStatus: .enabled, serviceManaged: false),
                .desktop
            )
            t.equal(
                DesktopStartupMode.resolve(loginStatus: .disabled, serviceManaged: true),
                .headless
            )
            t.equal(
                DesktopStartupMode.resolve(loginStatus: .disabled, serviceManaged: false),
                .off
            )
            t.equal(
                DesktopStartupMode.summary(
                    loginStatus: .enabled,
                    serviceManaged: true
                ),
                "Desktop · Quit Menu Bar leaves proxy running"
            )
            t.equal(
                DesktopStartupMode.summary(
                    loginStatus: .enabled,
                    serviceManaged: false
                ),
                "Desktop · Quit Menu Bar leaves proxy running"
            )
            t.equal(
                DesktopStartupMode.summary(
                    loginStatus: .disabled,
                    serviceManaged: true
                ),
                "Headless · proxy runs without the menu bar"
            )
            t.equal(
                DesktopStartupMode.summary(
                    loginStatus: .requiresApproval,
                    serviceManaged: true
                ),
                "Headless · approval required"
            )
        }

        t.test("menu app: duplicate-instance policy ignores the current process") {
            t.equal(
                MenuAppInstancePolicy.existingProcess(
                    currentPID: 42,
                    runningPIDs: [42, 88]
                ),
                88
            )
            t.isNil(
                MenuAppInstancePolicy.existingProcess(
                    currentPID: 42,
                    runningPIDs: [42]
                ),
                "existing process"
            )
        }

        t.test("menu app: stable login paths exclude downloads and translocation") {
            let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
            t.equal(
                LaunchAtLoginEligibility.isStableBundle(
                    URL(fileURLWithPath: "/repo/dist/macos/CodexCommander.app"),
                    home: home
                ),
                true
            )
            t.equal(
                LaunchAtLoginEligibility.isStableBundle(
                    URL(fileURLWithPath: "/Applications/CodexCommander.app"),
                    home: home
                ),
                true
            )
            t.equal(
                LaunchAtLoginEligibility.isStableBundle(
                    URL(fileURLWithPath: "/Users/example/Applications/CodexCommander.app"),
                    home: home
                ),
                true
            )
            t.equal(
                LaunchAtLoginEligibility.isStableBundle(
                    URL(fileURLWithPath: "/Users/example/Downloads/CodexCommander.app"),
                    home: home
                ),
                false
            )
            t.equal(
                LaunchAtLoginEligibility.isStableBundle(
                    URL(fileURLWithPath: "/private/var/folders/AppTranslocation/CodexCommander.app"),
                    home: home
                ),
                false
            )
            t.equal(
                LaunchAtLoginEligibility.isStableBundle(
                    URL(fileURLWithPath: "/repo/dist/macos/Other.app"),
                    home: home
                ),
                false
            )
            t.equal(
                LaunchAtLoginEligibility.isStableBundle(
                    URL(fileURLWithPath: "/Applications/Other.app"),
                    home: home
                ),
                false
            )
        }

        t.test("menu app: process lock admits exactly one owner") {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "CodexCommander-Instance-\(UUID().uuidString)",
                isDirectory: true
            )
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let path = root.appendingPathComponent("instance.lock")

            var firstLock: MenuAppInstanceLock?
            switch MenuAppInstanceLock.acquire(at: path) {
            case .acquired(let lock): firstLock = lock
            case .contended, .unavailable:
                t.expect(false, "first lock acquisition should succeed")
            }
            switch MenuAppInstanceLock.acquire(at: path) {
            case .contended: break
            case .acquired, .unavailable:
                t.expect(false, "second lock acquisition should be contended")
            }

            firstLock?.release()
            switch MenuAppInstanceLock.acquire(at: path) {
            case .acquired(let lock): lock.release()
            case .contended, .unavailable:
                t.expect(false, "released lock should be acquirable")
            }
        }
    }
}

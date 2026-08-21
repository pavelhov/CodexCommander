import Foundation
import ServiceManagement

public enum LaunchAtLoginStatus: String, Equatable, Sendable {
    case enabled
    case disabled
    case requiresApproval
    case notFound
    case unavailable
}

public enum LaunchAtLoginRemediation: Equatable, Sendable {
    case openSystemSettings
    case openApplications
}

public struct LaunchAtLoginPresentation: Equatable, Sendable {
    public let status: LaunchAtLoginStatus
    public let desiredEnabled: Bool
    public let isToggleEnabled: Bool
    public let errorMessage: String?
    public let relocationRequired: Bool

    public init(
        status: LaunchAtLoginStatus,
        desiredEnabled: Bool,
        isToggleEnabled: Bool,
        errorMessage: String? = nil,
        relocationRequired: Bool = false
    ) {
        self.status = status
        self.desiredEnabled = desiredEnabled
        self.isToggleEnabled = isToggleEnabled
        self.errorMessage = errorMessage
        self.relocationRequired = relocationRequired
    }

    public var isOn: Bool { status == .enabled }
    public var needsApproval: Bool { status == .requiresApproval }
    public var remediation: LaunchAtLoginRemediation? {
        if relocationRequired { return .openApplications }
        if needsApproval { return .openSystemSettings }
        return nil
    }
}

public enum DesktopStartupMode: String, Equatable, Sendable {
    case desktop = "Desktop"
    case headless = "Headless"
    case off = "Off"

    public static func resolve(
        loginStatus: LaunchAtLoginStatus,
        serviceManaged: Bool
    ) -> DesktopStartupMode {
        if loginStatus == .enabled { return .desktop }
        return serviceManaged ? .headless : .off
    }

    public static func summary(
        loginStatus: LaunchAtLoginStatus,
        serviceManaged: Bool
    ) -> String {
        let mode = resolve(loginStatus: loginStatus, serviceManaged: serviceManaged)
        if loginStatus == .requiresApproval {
            return "\(mode.rawValue) · approval required"
        }
        switch mode {
        case .desktop:
            // Both startup paths outlive the companion: services are launchd-owned,
            // while the app fallback uses spawnDetachedProxyStart() and unref().
            return "Desktop · Quit Menu Bar leaves proxy running"
        case .headless:
            return "Headless · proxy runs without the menu bar"
        case .off:
            return "Off · start CodexCommander manually"
        }
    }
}

public protocol LaunchAtLoginServicing: AnyObject {
    var status: LaunchAtLoginStatus { get }
    func register() throws
    func unregister() throws
    func openSystemSettings()
}

public protocol LaunchAtLoginPreferenceStoring: AnyObject {
    var desiredEnabled: Bool? { get set }
    var registeredExecutableFingerprint: String? { get set }
}

public final class UserDefaultsLaunchAtLoginPreferences: LaunchAtLoginPreferenceStoring {
    private let defaults: UserDefaults
    private let desiredKey: String
    private let fingerprintKey: String

    public init(
        defaults: UserDefaults = .standard,
        namespace: String = "com.codexcommander.menubar"
    ) {
        self.defaults = defaults
        desiredKey = "\(namespace).launch-at-login.desired"
        fingerprintKey = "\(namespace).launch-at-login.executable-fingerprint"
    }

    public var desiredEnabled: Bool? {
        get {
            guard defaults.object(forKey: desiredKey) != nil else { return nil }
            return defaults.bool(forKey: desiredKey)
        }
        set {
            if let newValue { defaults.set(newValue, forKey: desiredKey) }
            else { defaults.removeObject(forKey: desiredKey) }
        }
    }

    public var registeredExecutableFingerprint: String? {
        get { defaults.string(forKey: fingerprintKey) }
        set {
            if let newValue { defaults.set(newValue, forKey: fingerprintKey) }
            else { defaults.removeObject(forKey: fingerprintKey) }
        }
    }
}

public final class SystemLaunchAtLoginService: LaunchAtLoginServicing {
    private let service: SMAppService

    public init(service: SMAppService = .mainApp) {
        self.service = service
    }

    public var status: LaunchAtLoginStatus {
        switch service.status {
        case .enabled: return .enabled
        case .notRegistered: return .disabled
        case .requiresApproval: return .requiresApproval
        case .notFound: return .notFound
        @unknown default: return .unavailable
        }
    }

    public func register() throws { try service.register() }
    public func unregister() throws { try service.unregister() }
    public func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}

/// Keeps Login Items aligned with one explicit user preference.
///
/// The first app launch opts into the desktop experience. After that, an explicit
/// switch-off is respected, and a System Settings revocation is surfaced as approval
/// required instead of being silently fought. Rebuilt source apps are re-registered
/// only when the user still wants launch-at-login enabled.
public final class LaunchAtLoginController {
    private let service: any LaunchAtLoginServicing
    private let preferences: any LaunchAtLoginPreferenceStoring

    public init(
        service: any LaunchAtLoginServicing = SystemLaunchAtLoginService(),
        preferences: any LaunchAtLoginPreferenceStoring = UserDefaultsLaunchAtLoginPreferences()
    ) {
        self.service = service
        self.preferences = preferences
    }

    @discardableResult
    public func reconcile(
        executableFingerprint: String?,
        registrationAllowed: Bool = true
    ) -> LaunchAtLoginPresentation {
        guard registrationAllowed else {
            return LaunchAtLoginPresentation(
                status: .unavailable,
                desiredEnabled: preferences.desiredEnabled ?? true,
                isToggleEnabled: false,
                relocationRequired: true
            )
        }
        if preferences.desiredEnabled == nil {
            preferences.desiredEnabled = true
        }

        // System Settings is authoritative. If the user enabled the item there after
        // turning it off in-app, adopt that choice instead of unregistering it again.
        if service.status == .enabled, preferences.desiredEnabled == false {
            preferences.desiredEnabled = true
        }

        guard preferences.desiredEnabled == true else {
            return presentation()
        }

        do {
            switch service.status {
            case .enabled:
                if let executableFingerprint,
                   preferences.registeredExecutableFingerprint != executableFingerprint {
                    try unregisterUnlessConverged()
                    try registerUnlessConverged()
                }
            case .disabled, .notFound:
                try registerUnlessConverged()
            case .requiresApproval, .unavailable:
                break
            }
            if service.status == .enabled {
                preferences.registeredExecutableFingerprint = executableFingerprint
            }
            return presentation()
        } catch {
            return presentation(error: "CodexCommander could not update Launch at Login.")
        }
    }

    @discardableResult
    public func setEnabled(
        _ enabled: Bool,
        executableFingerprint: String?,
        registrationAllowed: Bool = true
    ) -> LaunchAtLoginPresentation {
        guard registrationAllowed else {
            return LaunchAtLoginPresentation(
                status: .unavailable,
                desiredEnabled: preferences.desiredEnabled ?? false,
                isToggleEnabled: false,
                relocationRequired: true
            )
        }
        let previousDesiredEnabled = preferences.desiredEnabled
        let previousFingerprint = preferences.registeredExecutableFingerprint
        do {
            if enabled {
                switch service.status {
                case .disabled, .notFound:
                    try registerUnlessConverged()
                case .enabled, .requiresApproval:
                    break
                case .unavailable:
                    throw LaunchAtLoginTransitionError.unavailable
                }
                guard service.status == .enabled || service.status == .requiresApproval else {
                    throw LaunchAtLoginTransitionError.didNotConverge
                }
                preferences.desiredEnabled = true
                if service.status == .enabled {
                    preferences.registeredExecutableFingerprint = executableFingerprint
                }
            } else {
                if service.status != .disabled && service.status != .notFound {
                    try unregisterUnlessConverged()
                }
                guard service.status == .disabled || service.status == .notFound else {
                    throw LaunchAtLoginTransitionError.didNotConverge
                }
                preferences.desiredEnabled = false
                preferences.registeredExecutableFingerprint = nil
            }
            return presentation()
        } catch {
            preferences.desiredEnabled = previousDesiredEnabled
            preferences.registeredExecutableFingerprint = previousFingerprint
            return presentation(error: "CodexCommander could not update Launch at Login.")
        }
    }

    public func currentPresentation(
        registrationAllowed: Bool = true
    ) -> LaunchAtLoginPresentation {
        guard registrationAllowed else {
            return LaunchAtLoginPresentation(
                status: .unavailable,
                desiredEnabled: preferences.desiredEnabled ?? true,
                isToggleEnabled: false,
                relocationRequired: true
            )
        }
        if service.status == .enabled, preferences.desiredEnabled == false {
            preferences.desiredEnabled = true
        }
        return presentation()
    }

    public func openSystemSettings() { service.openSystemSettings() }

    private func registerUnlessConverged() throws {
        do { try service.register() }
        catch {
            if service.status != .enabled && service.status != .requiresApproval { throw error }
        }
    }

    private func unregisterUnlessConverged() throws {
        do { try service.unregister() }
        catch {
            if service.status != .disabled && service.status != .notFound { throw error }
        }
    }

    private func presentation(error: String? = nil) -> LaunchAtLoginPresentation {
        let status = service.status
        return LaunchAtLoginPresentation(
            status: status,
            desiredEnabled: preferences.desiredEnabled ?? false,
            isToggleEnabled: status == .enabled || status == .disabled || status == .notFound,
            errorMessage: error ?? (status == .unavailable ? "Launch at Login is unavailable." : nil)
        )
    }
}

private enum LaunchAtLoginTransitionError: Error {
    case didNotConverge
    case unavailable
}

public enum ExecutableFingerprint {
    public static func current(
        bundle: Bundle = .main,
        fileManager: FileManager = .default
    ) -> String? {
        guard let executable = bundle.executableURL,
              let attributes = try? fileManager.attributesOfItem(atPath: executable.path),
              let size = (attributes[.size] as? NSNumber)?.uint64Value,
              let modified = attributes[.modificationDate] as? Date
        else { return nil }
        let fileNumber = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
        return "\(executable.path)|\(fileNumber)|\(size)|\(modified.timeIntervalSince1970)"
    }
}

public enum AppBundleLocation: Equatable, Sendable {
    case stable
    case relocatable
    case translocated
}

public enum LaunchAtLoginEligibility {
    public static func classify(
        _ bundleURL: URL,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> AppBundleLocation {
        let bundle = bundleURL.resolvingSymlinksInPath()
        let path = bundle.path
        if path.contains("/AppTranslocation/") { return .translocated }
        guard bundle.pathExtension == "app",
              bundle.lastPathComponent == "CodexCommander.app"
        else { return .relocatable }

        if path.hasPrefix("/Applications/") { return .stable }
        let userApplications = home.appendingPathComponent("Applications", isDirectory: true).path
        if path.hasPrefix("\(userApplications)/") { return .stable }

        let sourceBuild = bundle.deletingLastPathComponent().lastPathComponent == "macos"
            && bundle.deletingLastPathComponent()
                .deletingLastPathComponent().lastPathComponent == "dist"
        return sourceBuild ? .stable : .relocatable
    }

    public static func isStableBundle(
        _ bundleURL: URL,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> Bool {
        classify(bundleURL, home: home) == .stable
    }
}

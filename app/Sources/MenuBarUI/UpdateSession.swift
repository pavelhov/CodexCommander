import AppKit
import MenuBarCore
import Sparkle

/// The durable helper is the authority; Sparkle callbacks never clear this guard.
@MainActor
public final class UpdateSession {
    public private(set) var blocksLifecycle = true
    public private(set) var transactionId: String?
    public private(set) var targetBuild: String?
    public static let pauseDisclosure = "Installing an update pauses CodexCommander during download and installation, then restores your previous proxy and routing choices after relaunch."
    public private(set) var message = "Checking update recovery…"
    public var changed: (() -> Void)?
    private let helper: any MacOSUpdateCommandRunning
    private let confirmInterruption: () -> Bool
    private var busy = false

    public init(helper: any MacOSUpdateCommandRunning, confirmInterruption: @escaping () -> Bool) {
        self.helper = helper
        self.confirmInterruption = confirmInterruption
    }

    /// Only idle authorizes the ordinary launch policy. Recovery already restored
    /// the captured semantic intent (which can deliberately be stopped).
    public func recover() async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false; changed?() }
        do {
            let result = try await helper.run(MacOSUpdateCommand(.reconcile))
            adopt(result)
            return result.status == .idle
        } catch {
            blocksLifecycle = true
            message = "Update recovery could not be verified. Use Finish Update to retry."
            return false
        }
    }

    public func prepare(target: String) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false; changed?() }
        // An old pending installer must reuse its captured target and UUID.
        if let targetBuild, targetBuild != target {
            blocksLifecycle = true
            message = "Finish the pending update before installing another version."
            return false
        }
        let id = transactionId ?? UUID().uuidString
        transactionId = id
        targetBuild = target
        blocksLifecycle = true
        message = "Pausing CodexCommander before downloading the update…"
        changed?()
        do {
            var result = try await helper.run(MacOSUpdateCommand(.prepare, transactionId: id, targetBuild: target))
            adopt(result)
            if result.status == .confirmationRequired {
                guard confirmInterruption() else { return false }
                result = try await helper.run(MacOSUpdateCommand(.prepare, transactionId: id, targetBuild: target, updateAnyway: true))
                adopt(result)
            }
            return result.status == .prepared && result.transactionId == id && result.targetBuild == target
        } catch {
            message = "Could not prepare the update. Use Finish Update to retry."
            return false
        }
    }

    public func arm(target: String) async throws {
        guard let id = transactionId, targetBuild == target else { throw LifecycleHelperError.invalidResponse }
        let result = try await helper.run(MacOSUpdateCommand(.arm, transactionId: id))
        adopt(result)
        changed?()
        guard result.status == .armed, result.transactionId == id, result.targetBuild == target else {
            throw LifecycleHelperError.invalidResponse
        }
    }

    public func cancelPreparation() async -> Bool {
        guard let id = transactionId else { return !blocksLifecycle }
        do {
            let result = try await helper.run(MacOSUpdateCommand(.cancel, transactionId: id))
            adopt(result)
            changed?()
            return !blocksLifecycle
        } catch {
            blocksLifecycle = true
            message = "Update recovery needs attention. Use Finish Update to retry."
            changed?()
            return false
        }
    }

    public func recordOff() async -> Bool {
        do {
            let result = try await helper.run(MacOSUpdateCommand(.recordOff))
            adopt(result)
            changed?()
            return result.status != .blocked
        } catch {
            message = "Could not save Stop intent. Try Stop CodexCommander and Quit again."
            changed?()
            return false
        }
    }

    private func adopt(_ result: MacOSUpdateResult) {
        blocksLifecycle = ![.idle, .recovered].contains(result.status)
        if blocksLifecycle {
            if let id = result.transactionId, let target = result.targetBuild {
                transactionId = id; targetBuild = target
            }
            message = result.status == .armed
                ? "CodexCommander is paused while the update downloads and installs."
                : (result.status == .prepared ? "CodexCommander is paused for the update." : "Update recovery needs attention. Use Finish Update to retry.")
        } else {
            transactionId = nil; targetBuild = nil
            message = result.status == .recovered
                ? "Update recovery completed. " + Self.pauseDisclosure
                : Self.pauseDisclosure
        }
    }
}

/// Owns Sparkle only in explicitly enabled, keyed distribution bundles.
@MainActor
package final class AppUpdater: NSObject, SPUUpdaterDelegate {
    package let session: UpdateSession
    private(set) var driver: UpdateController?
    private var updater: SPUUpdater?
    private(set) var authorizedTermination = false
    private(set) var unavailableReason: String?
    var changed: (() -> Void)?
    private let bundle: Bundle

    package init(bundle: Bundle, helper: any MacOSUpdateCommandRunning, confirmInterruption: @escaping () -> Bool) {
        self.bundle = bundle
        self.session = UpdateSession(helper: helper, confirmInterruption: confirmInterruption)
        super.init()
        session.changed = { [weak self] in self?.changed?() }
    }

    package var available: Bool { updater != nil }
    var automaticChecks: Bool { updater?.automaticallyChecksForUpdates ?? false }
    var blocksLifecycle: Bool { session.blocksLifecycle }

    package func start() async -> Bool {
        let ordinaryStartup = await session.recover()
        guard bundle.object(forInfoDictionaryKey: "CodexCommanderUpdaterEnabled") as? Bool == true,
              let key = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            unavailableReason = "Updates unavailable in this build (release signing key required)."
            changed?()
            return ordinaryStartup
        }
        let driver = UpdateController(hostBundle: bundle, boundary: .init(
            prepare: { [session] target in await session.prepare(target: target) },
            persistArmed: { [session] target in try await session.arm(target: target) },
            cancelPreparation: { [session] in await session.cancelPreparation() },
            stateChanged: { [weak self] state in
                guard let self else { return }
                if state.phase != .armed { self.authorizedTermination = false }
                self.changed?()
            }
        ))
        driver.reconcileStartup(installerDisarmed: !session.blocksLifecycle)
        self.driver = driver
        let updater = SPUUpdater(hostBundle: bundle, applicationBundle: bundle, userDriver: driver, delegate: self)
        updater.automaticallyDownloadsUpdates = false
        do {
            try updater.start()
            self.updater = updater
        } catch {
            unavailableReason = "Updates could not start. Reopen the app to retry."
        }
        changed?()
        return ordinaryStartup
    }

    func check() {
        Task { @MainActor in
            if session.blocksLifecycle { _ = await session.recover() }
            updater?.checkForUpdates()
            changed?()
        }
    }

    func setAutomaticChecks(_ enabled: Bool) {
        updater?.automaticallyChecksForUpdates = enabled
        updater?.automaticallyDownloadsUpdates = false
        changed?()
    }

    package func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        authorizedTermination = driver?.coordinator.phase == .armed && session.blocksLifecycle
        return !authorizedTermination
    }

    package func updaterShouldPromptForPermissionToCheck(forUpdates updater: SPUUpdater) -> Bool { false }

    package func bestValidUpdate(in appcast: SUAppcast, for updater: SPUUpdater) -> SUAppcastItem? {
        bestValidUpdate(in: appcast.items)
    }

    package func bestValidUpdate(in items: [SUAppcastItem]) -> SUAppcastItem? {
        guard let target = session.targetBuild else { return nil }
        // Sparkle supplies already-filtered eligible top-level items. Never select
        // a newer release in place of the identity captured by the transaction.
        return items.first { $0.versionString == target } ?? SUAppcastItem.empty()
    }

    package func updaterShouldRelaunchApplication(_ updater: SPUUpdater) -> Bool {
        driver?.coordinator.phase == .armed && session.blocksLifecycle
    }
}

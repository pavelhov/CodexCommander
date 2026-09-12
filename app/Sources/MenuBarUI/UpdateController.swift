import AppKit
import MenuBarCore
import Sparkle

/// Early-gating adapter. Production startup and menu wiring deliberately live elsewhere.
/// All lifecycle closures must finish their durable work before returning.
@MainActor
public final class UpdateController: NSObject, SPUUserDriver, SPUStandardUserDriverDelegate {
    public struct Boundary {
        public var prepare: (String) async -> Bool
        public var persistArmed: (String) async throws -> Void
        public var cancelPreparation: () async -> Bool
        public var stateChanged: (UpdateCoordinator) -> Void

        public init(prepare: @escaping (String) async -> Bool,
                    persistArmed: @escaping (String) async throws -> Void,
                    cancelPreparation: @escaping () async -> Bool,
                    stateChanged: @escaping (UpdateCoordinator) -> Void) {
            self.prepare = prepare
            self.persistArmed = persistArmed
            self.cancelPreparation = cancelPreparation
            self.stateChanged = stateChanged
        }
    }

    public private(set) var coordinator = UpdateCoordinator()
    private lazy var standard = SPUStandardUserDriver(hostBundle: hostBundle, delegate: self)
    private let hostBundle: Bundle
    private let confirmInstallation: () -> Bool
    package private(set) var updateAvailable = false
    private var userInitiated = false
    private let boundary: Boundary

    public init(hostBundle: Bundle, boundary: Boundary, confirmInstallation: @escaping () -> Bool = UpdateController.confirmPause) {
        self.hostBundle = hostBundle
        self.confirmInstallation = confirmInstallation
        self.boundary = boundary
        super.init()
    }

    public static func makePauseAlert() -> NSAlert {
        let alert = NSAlert()
        alert.messageText = "Install the update?"
        alert.informativeText = UpdateSession.pauseDisclosure + " Active requests may fail and will not be replayed; retry them after the update."
        alert.addButton(withTitle: "Update Anyway")
        alert.addButton(withTitle: "Later")
        alert.buttons[0].keyEquivalent = ""
        alert.buttons[1].keyEquivalent = "\r"
        return alert
    }

    public static func confirmPause() -> Bool {
        let alert = makePauseAlert()
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    public var supportsGentleScheduledUpdateReminders: Bool { true }
    public func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool { false }
    public func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        updateAvailable = true
        changed()
    }
    public func standardUserDriverWillFinishUpdateSession() {
        updateAvailable = false
        changed()
    }

    public func reconcileStartup(installerDisarmed: Bool) {
        coordinator.reconcileStartup(installerDisarmed: installerDisarmed)
        changed()
    }

    private func changed() { boundary.stateChanged(coordinator) }

    public func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
                                reply: @escaping (SPUUserUpdateChoice) -> Void) {
        userInitiated = state.userInitiated
        let stage: UpdateCoordinator.InstallerStage = state.stage == .installing ? .installing
            : (state.stage == .downloaded ? .downloaded : .notDownloaded)
        handleOffer(target: appcastItem.versionString, stage: stage, present: { decide in
            self.standard.showUpdateFound(with: appcastItem, state: state, reply: decide)
        }, reply: reply)
    }

    /// Same retained-reply boundary used by the real standard driver and the UI harness.
    package func handleOffer(target: String, stage: UpdateCoordinator.InstallerStage,
                             present: (@escaping (SPUUserUpdateChoice) -> Void) -> Void,
                             reply: @escaping (SPUUserUpdateChoice) -> Void) {
        guard coordinator.receiveOffer(target: target, stage: stage) else {
            // Dismiss preserves a preexisting installer; never advertise this as disarm.
            reply(.dismiss)
            return
        }
        updateAvailable = true
        changed()
        let offerGeneration = coordinator.generation
        var replied = false
        let respond: (SPUUserUpdateChoice) -> Void = { choice in
            guard !replied else { return }
            replied = true
            reply(choice)
        }
        present { [weak self] choice in
            guard let self else { respond(.dismiss); return }
            guard self.coordinator.generation == offerGeneration, self.coordinator.phase == .offered else {
                respond(.dismiss)
                return
            }
            guard choice == .install else {
                self.coordinator.cancel()
                self.changed()
                respond(choice)
                return
            }
            guard self.confirmInstallation() else {
                self.coordinator.cancel()
                self.changed()
                respond(.dismiss)
                return
            }
            guard let generation = self.coordinator.beginPreparation() else { return }
            self.changed()
            Task { @MainActor in
                let verified = await self.boundary.prepare(target)
                guard self.coordinator.preparationCompleted(generation: generation, verified: verified) else {
                    if !(await self.boundary.cancelPreparation()) {
                        self.coordinator.requireRecovery()
                    }
                    self.changed()
                    respond(.dismiss)
                    return
                }
                self.changed()
                do {
                    try await self.boundary.persistArmed(target)
                    guard self.coordinator.installationArmed(generation: generation) else {
                        self.coordinator.installerSessionEnded()
                        self.changed()
                        respond(.dismiss)
                        return
                    }
                    self.changed()
                    respond(.install)
                } catch {
                    // A failed acknowledgement may follow a successful durable write.
                    self.coordinator.installerSessionEnded()
                    self.changed()
                    respond(.dismiss)
                }
            }
        }
    }

    public func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) { standard.show(request, reply: reply) }
    public func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { userInitiated = true; standard.showUserInitiatedUpdateCheck(cancellation: cancellation) }
    public func showUpdateReleaseNotes(with downloadData: SPUDownloadData) { standard.showUpdateReleaseNotes(with: downloadData) }
    public func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) { standard.showUpdateReleaseNotesFailedToDownloadWithError(error) }
    public func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) { updateAvailable = false; changed(); if userInitiated { standard.showUpdateNotFoundWithError(error, acknowledgement: acknowledgement) } else { acknowledgement() } }
    public func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) { let showError = userInitiated || [.preparing, .prepared, .armed].contains(coordinator.phase); coordinator.installerSessionEnded(); updateAvailable = false; changed(); if showError { standard.showUpdaterError(error, acknowledgement: acknowledgement) } else { acknowledgement() } }
    public func showDownloadInitiated(cancellation: @escaping () -> Void) {
        standard.showDownloadInitiated { [weak self] in
            self?.coordinator.cancel(); self?.changed(); cancellation()
        }
    }
    public func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) { standard.showDownloadDidReceiveExpectedContentLength(expectedContentLength) }
    public func showDownloadDidReceiveData(ofLength length: UInt64) { standard.showDownloadDidReceiveData(ofLength: length) }
    public func showDownloadDidStartExtractingUpdate() { standard.showDownloadDidStartExtractingUpdate() }
    public func showExtractionReceivedProgress(_ progress: Double) { standard.showExtractionReceivedProgress(progress) }
    public func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        // Initial consent already authorized download, installation, and relaunch.
        // Never introduce a second consent stop after service has paused.
        guard coordinator.phase == .armed else {
            coordinator.cancel()
            changed()
            reply(.dismiss)
            return
        }
        reply(.install)
    }
    public func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) { standard.showInstallingUpdate(withApplicationTerminated: applicationTerminated, retryTerminatingApplication: retryTerminatingApplication) }
    public func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { coordinator.installerSessionEnded(); changed(); standard.showUpdateInstalledAndRelaunched(relaunched, acknowledgement: acknowledgement) }
    public func dismissUpdateInstallation() { if coordinator.phase == .offered { coordinator.cancel() }; coordinator.installerSessionEnded(); updateAvailable = false; userInitiated = false; changed(); standard.dismissUpdateInstallation() }
    public func showUpdateInFocus() { userInitiated = true; standard.showUpdateInFocus() }
}

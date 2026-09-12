import AppKit
import MenuBarCore
import Sparkle

/// Early-gating adapter. Production startup and menu wiring deliberately live elsewhere.
/// All lifecycle closures must finish their durable work before returning.
@MainActor
public final class UpdateController: NSObject, SPUUserDriver {
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
    private let standard: SPUStandardUserDriver
    private let boundary: Boundary

    public init(hostBundle: Bundle, boundary: Boundary) {
        self.standard = SPUStandardUserDriver(hostBundle: hostBundle, delegate: nil)
        self.boundary = boundary
        super.init()
    }

    public func reconcileStartup(installerDisarmed: Bool) {
        coordinator.reconcileStartup(installerDisarmed: installerDisarmed)
        changed()
    }

    private func changed() { boundary.stateChanged(coordinator) }

    public func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
                                reply: @escaping (SPUUserUpdateChoice) -> Void) {
        let stage: UpdateCoordinator.InstallerStage = state.stage == .installing ? .installing
            : (state.stage == .downloaded ? .downloaded : .notDownloaded)
        guard coordinator.receiveOffer(target: appcastItem.versionString, stage: stage) else {
            // Dismiss preserves a preexisting installer; never advertise this as disarm.
            reply(.dismiss)
            return
        }
        changed()
        var replied = false
        let respond: (SPUUserUpdateChoice) -> Void = { choice in
            guard !replied else { return }
            replied = true
            reply(choice)
        }
        standard.showUpdateFound(with: appcastItem, state: state) { [weak self] choice in
            guard let self else { respond(.dismiss); return }
            guard choice == .install else {
                self.coordinator.cancel()
                self.changed()
                respond(choice)
                return
            }
            guard let generation = self.coordinator.beginPreparation() else { return }
            self.changed()
            Task { @MainActor in
                let verified = await self.boundary.prepare(appcastItem.versionString)
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
                    try await self.boundary.persistArmed(appcastItem.versionString)
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
    public func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { standard.showUserInitiatedUpdateCheck(cancellation: cancellation) }
    public func showUpdateReleaseNotes(with downloadData: SPUDownloadData) { standard.showUpdateReleaseNotes(with: downloadData) }
    public func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) { standard.showUpdateReleaseNotesFailedToDownloadWithError(error) }
    public func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) { standard.showUpdateNotFoundWithError(error, acknowledgement: acknowledgement) }
    public func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) { coordinator.installerSessionEnded(); changed(); standard.showUpdaterError(error, acknowledgement: acknowledgement) }
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
    public func dismissUpdateInstallation() { coordinator.installerSessionEnded(); changed(); standard.dismissUpdateInstallation() }
    public func showUpdateInFocus() { standard.showUpdateInFocus() }
}

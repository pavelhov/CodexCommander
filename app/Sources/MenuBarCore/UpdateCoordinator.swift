import Foundation

/// Installer state is deliberately independent of Sparkle and of proxy lifecycle I/O.
/// The caller must reconcile its durable transaction before enabling ordinary startup.
public struct UpdateCoordinator: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case startupBlocked, idle, offered, preparing, prepared, armed, cancelled, uncertain
    }
    public enum InstallerStage: Equatable, Sendable { case notDownloaded, downloaded, installing }
    public private(set) var phase: Phase = .startupBlocked
    public private(set) var target: String?
    public private(set) var generation: UInt64 = 0
    private var priorInstallerDisarmed = false

    public init() {}

    /// `true` requires authoritative startup reconciliation, never a nil Sparkle error,
    /// an expired timeout, or absence of a retained reply in this process.
    public mutating func reconcileStartup(installerDisarmed: Bool) {
        guard phase == .startupBlocked else { return }
        priorInstallerDisarmed = installerDisarmed
        phase = installerDisarmed ? .idle : .uncertain
    }

    public var mayRunOrdinaryStartup: Bool { phase == .idle }
    public var mayRestoreAfterCancellation: Bool { phase == .cancelled && priorInstallerDisarmed }

    /// Downloaded or installing offers can belong to an earlier process and are always guarded.
    @discardableResult
    public mutating func receiveOffer(target: String, stage: InstallerStage) -> Bool {
        guard [.idle, .cancelled, .uncertain].contains(phase) else { return false }
        self.target = target
        if stage != .notDownloaded { priorInstallerDisarmed = false }
        phase = .offered
        generation &+= 1
        return true
    }

    public mutating func beginPreparation() -> UInt64? {
        guard phase == .offered else { return nil }
        phase = .preparing
        return generation
    }

    @discardableResult
    public mutating func preparationCompleted(generation: UInt64, verified: Bool) -> Bool {
        guard self.generation == generation, phase == .preparing else { return false }
        phase = verified ? .prepared : (priorInstallerDisarmed ? .cancelled : .uncertain)
        return verified
    }

    /// Call only after the durable armed record has been written successfully.
    /// The caller may forward the retained Install reply exactly when this returns true.
    @discardableResult
    public mutating func installationArmed(generation: UInt64) -> Bool {
        guard self.generation == generation, phase == .prepared else { return false }
        priorInstallerDisarmed = false
        phase = .armed
        return true
    }

    public mutating func cancel() {
        generation &+= 1
        phase = priorInstallerDisarmed && [.offered, .preparing, .prepared, .cancelled].contains(phase)
            ? .cancelled : .uncertain
    }

    public mutating func requireRecovery() {
        generation &+= 1
        priorInstallerDisarmed = false
        phase = .uncertain
    }

    /// Sparkle's dismiss/cycle-end callbacks do not acknowledge installer disarm.
    public mutating func installerSessionEnded() {
        if [.preparing, .prepared, .armed].contains(phase) {
            generation &+= 1
            priorInstallerDisarmed = false
            phase = .uncertain
        }
    }
}

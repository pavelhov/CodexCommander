import Foundation
import Darwin

public enum MacOSUpdateAction: String, Codable, Sendable {
    case status, prepare, arm, cancel, reconcile
    case recordOff = "record-off"
}
public enum MacOSUpdateStatus: String, Codable, Sendable {
    case idle, prepared, armed, recovered, blocked
    case confirmationRequired = "confirmation-required"
    case finishRequired = "finish-required"
}
public struct MacOSUpdateCommand: Equatable, Sendable {
    public let action: MacOSUpdateAction
    public let transactionId: String?
    public let targetBuild: String?
    public let updateAnyway: Bool
    public init(_ action: MacOSUpdateAction, transactionId: String? = nil, targetBuild: String? = nil, updateAnyway: Bool = false) {
        self.action = action; self.transactionId = transactionId; self.targetBuild = targetBuild; self.updateAnyway = updateAnyway
    }
    public func arguments() throws -> [String] {
        switch action {
        case .status, .reconcile, .recordOff:
            guard transactionId == nil, targetBuild == nil, !updateAnyway else { throw LifecycleHelperError.invalidResponse }
            return [action.rawValue]
        case .arm, .cancel:
            guard let transactionId, UUID(uuidString: transactionId) != nil, targetBuild == nil, !updateAnyway else { throw LifecycleHelperError.invalidResponse }
            return [action.rawValue, transactionId]
        case .prepare:
            guard let transactionId, UUID(uuidString: transactionId) != nil, let targetBuild, Self.validBuild(targetBuild) else { throw LifecycleHelperError.invalidResponse }
            return [action.rawValue, transactionId, targetBuild] + (updateAnyway ? ["update-anyway"] : [])
        }
    }
    static func validBuild(_ value: String) -> Bool {
        value.range(of: "^[1-9][0-9]{0,19}$", options: .regularExpression) != nil
    }
}
public struct MacOSUpdateResult: Decodable, Equatable, Sendable {
    public let schemaVersion: Int
    public let action: MacOSUpdateAction
    public let status: MacOSUpdateStatus
    public let transactionId: String?
    public let targetBuild: String?
    public let active: Int
    public let errorCode: String?
    public let message: String
    public init(schemaVersion: Int = 1, action: MacOSUpdateAction, status: MacOSUpdateStatus, transactionId: String? = nil, targetBuild: String? = nil, active: Int = 0, errorCode: String? = nil, message: String = "Update lifecycle state verified.") {
        self.schemaVersion = schemaVersion; self.action = action; self.status = status
        self.transactionId = transactionId; self.targetBuild = targetBuild; self.active = active
        self.errorCode = errorCode; self.message = message
    }
    public static func decode(_ data: Data, command: MacOSUpdateCommand, exitCode: Int32) throws -> MacOSUpdateResult {
        guard data.count <= 2048,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["schemaVersion", "action", "status", "transactionId", "targetBuild", "active", "errorCode", "message"])
        else { throw LifecycleHelperError.invalidResponse }
        let result = try JSONDecoder().decode(Self.self, from: data)
        guard result.schemaVersion == 1, result.action == command.action,
              result.active >= 0, result.active <= 1_000_000,
              result.message.utf8.count <= 240,
              result.transactionId.map({ UUID(uuidString: $0) != nil }) ?? true,
              result.targetBuild.map({ MacOSUpdateCommand.validBuild($0) }) ?? true,
              (result.transactionId == nil) == (result.targetBuild == nil),
              result.errorCode == nil || result.errorCode == "UPDATE_RECOVERY_REQUIRED",
              (result.status == .blocked ? exitCode == 1 : exitCode == 0),
              command.transactionId == nil || result.transactionId == command.transactionId || result.status == .recovered || result.status == .blocked,
              command.targetBuild == nil || result.targetBuild == command.targetBuild || result.status == .blocked,
              result.status != .confirmationRequired || (command.action == .prepare && result.active > 0 && result.transactionId != nil),
              ![MacOSUpdateStatus.prepared, .armed, .finishRequired].contains(result.status) || result.transactionId != nil
        else { throw LifecycleHelperError.invalidResponse }
        return result
    }
}
public protocol MacOSUpdateCommandRunning: Sendable {
    func run(_ command: MacOSUpdateCommand) async throws -> MacOSUpdateResult
}
/// Fixed embedded-runtime bridge; no global-install discovery fallback is accepted.
public actor MacOSUpdateHelper: MacOSUpdateCommandRunning {
    private let invocation: LifecycleInvocation?
    private let timeout: TimeInterval
    public init(invocation: LifecycleInvocation? = LifecycleHelperDiscovery.discover(), timeout: TimeInterval = LifecycleHelper.timeout) {
        self.invocation = invocation; self.timeout = timeout
    }
    public func run(_ command: MacOSUpdateCommand) async throws -> MacOSUpdateResult {
        guard let invocation, invocation.appOwnedRuntime else { throw LifecycleHelperError.unavailable }
        let arguments = try command.arguments()
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                let pipe = Pipe()
                let output = BoundedOutput(limit: LifecycleHelper.maximumOutputBytes)
                let timeoutState = TimeoutState()
                process.executableURL = invocation.executable
                process.arguments = invocation.prefixArguments + ["__macos-update"] + arguments
                process.currentDirectoryURL = invocation.workingDirectory
                process.environment = LifecycleHelper.controlledEnvironment(for: invocation)
                process.standardOutput = pipe
                process.standardError = FileHandle.nullDevice
                pipe.fileHandleForReading.readabilityHandler = { output.append($0.availableData) }
                let killWork = DispatchWorkItem {
                    guard timeoutState.didFire, process.isRunning else { return }
                    _ = Darwin.kill(process.processIdentifier, SIGKILL)
                }
                let timeoutWork = DispatchWorkItem {
                    guard process.isRunning else { return }
                    timeoutState.markFired(); process.terminate()
                    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1, execute: killWork)
                }
                do { try process.run() } catch {
                    pipe.fileHandleForReading.readabilityHandler = nil
                    continuation.resume(throwing: LifecycleHelperError.launchFailed); return
                }
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: timeoutWork)
                process.waitUntilExit(); timeoutWork.cancel(); killWork.cancel()
                pipe.fileHandleForReading.readabilityHandler = nil
                output.append(pipe.fileHandleForReading.readDataToEndOfFile())
                let (data, overflow) = output.snapshot()
                guard !overflow, process.terminationReason != .uncaughtSignal else {
                    continuation.resume(throwing: timeoutState.didFire ? LifecycleHelperError.timedOut : LifecycleHelperError.invalidResponse); return
                }
                do { continuation.resume(returning: try MacOSUpdateResult.decode(data, command: command, exitCode: process.terminationStatus)) }
                catch { continuation.resume(throwing: LifecycleHelperError.invalidResponse) }
            }
        }
    }
}

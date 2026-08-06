import Foundation
import Darwin

public enum LifecycleAction: String, Codable, Sendable {
    case status
    case ensure
    case start
    case stop
    case restart
}

public enum LifecycleState: String, Codable, Sendable {
    case running
    case stopped
    case disabled
    case blocked
    case failed
}

public struct LifecycleCommandResult: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let action: LifecycleAction
    public let ok: Bool
    public let state: LifecycleState
    public let changed: Bool
    public let pid: Int?
    public let port: Int?
    public let message: String
    public let errorCode: String?

    public init(
        schemaVersion: Int = 1,
        action: LifecycleAction,
        ok: Bool,
        state: LifecycleState,
        changed: Bool,
        pid: Int? = nil,
        port: Int? = nil,
        message: String,
        errorCode: String? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.action = action
        self.ok = ok
        self.state = state
        self.changed = changed
        self.pid = pid
        self.port = port
        self.message = message
        self.errorCode = errorCode
    }
}

public enum LifecycleHelperError: Error, Equatable, Sendable {
    case unavailable
    case launchFailed
    case timedOut
    case invalidResponse

    public var userMessage: String {
        switch self {
        case .unavailable:
            return "OpenCodex CLI was not found. Install OpenCodex, then try Start again."
        case .launchFailed:
            return "OpenCodex could not launch its lifecycle helper."
        case .timedOut:
            return "OpenCodex lifecycle control timed out. Check Logs or run `ocx status`."
        case .invalidResponse:
            return "OpenCodex returned an invalid lifecycle response."
        }
    }
}

public protocol LifecycleCommandRunning: Sendable {
    func run(_ action: LifecycleAction) async throws -> LifecycleCommandResult
}

public struct LifecycleInvocation: Equatable, Sendable {
    public let executable: URL
    public let prefixArguments: [String]

    public init(executable: URL, prefixArguments: [String] = []) {
        self.executable = executable
        self.prefixArguments = prefixArguments
    }
}

public enum LifecycleHelperDiscovery {
    public static func discover(
        bundleURL: URL = Bundle.main.bundleURL,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        fileManager: FileManager = .default
    ) -> LifecycleInvocation? {
        if let source = sourceInvocation(bundleURL: bundleURL, fileManager: fileManager) {
            return source
        }

        // Release companions may be launched outside the source tree. Only inspect
        // fixed installation locations, then resolve an npm/bun symlink back to an
        // actual OpenCodex package root. PATH and version-directory scans would turn
        // an ambient shell setting into arbitrary process execution from the menu app.
        let candidates = [
            "/opt/homebrew/bin/ocx",
            "/usr/local/bin/ocx",
            home.appendingPathComponent(".local/bin/ocx").path,
            home.appendingPathComponent(".npm-global/bin/ocx").path,
            home.appendingPathComponent(".volta/bin/ocx").path,
            home.appendingPathComponent(".bun/bin/ocx").path,
        ]
        _ = environment // Explicitly ignored: discovery is independent of ambient PATH.

        var seen = Set<String>()
        for candidate in candidates where seen.insert(candidate).inserted {
            guard isExecutable(candidate, fileManager: fileManager) else { continue }
            let launcher = URL(fileURLWithPath: candidate).resolvingSymlinksInPath()
            guard launcher.lastPathComponent == "ocx.mjs",
                  launcher.deletingLastPathComponent().lastPathComponent == "bin"
            else { continue }
            let repository = launcher.deletingLastPathComponent().deletingLastPathComponent()
            if let invocation = repositoryInvocation(repository, fileManager: fileManager) {
                return invocation
            }
        }
        return nil
    }

    private static func sourceInvocation(
        bundleURL: URL,
        fileManager: FileManager
    ) -> LifecycleInvocation? {
        // <repo>/dist/macos/OpenCodex.app -> <repo>. Requiring every fixed path
        // component keeps a copied/lookalike app from selecting a nearby script.
        let bundle = bundleURL.resolvingSymlinksInPath()
        guard bundle.lastPathComponent == "OpenCodex.app",
              bundle.deletingLastPathComponent().lastPathComponent == "macos",
              bundle.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "dist"
        else { return nil }
        let repository = bundle
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return repositoryInvocation(repository, fileManager: fileManager)
    }

    private static func repositoryInvocation(
        _ repository: URL,
        fileManager: FileManager
    ) -> LifecycleInvocation? {
        let package = repository.appendingPathComponent("package.json")
        let entry = repository.appendingPathComponent("src/cli/index.ts")
        guard isOpenCodexPackage(package, fileManager: fileManager),
              isRegularFile(entry.path, fileManager: fileManager)
        else { return nil }

        let bunCandidates = [
            repository.appendingPathComponent("node_modules/.bin/bun"),
            repository.appendingPathComponent("node_modules/bun/bin/bun"),
            repository.appendingPathComponent("node_modules/bun/bin/bun.exe"),
        ]
        guard let bun = bunCandidates.first(where: {
            isExecutable($0.path, fileManager: fileManager)
        }) else { return nil }
        return LifecycleInvocation(executable: bun, prefixArguments: [entry.path])
    }

    private static func isOpenCodexPackage(
        _ package: URL,
        fileManager: FileManager
    ) -> Bool {
        guard isRegularFile(package.path, fileManager: fileManager),
              let attributes = try? fileManager.attributesOfItem(atPath: package.path),
              let size = attributes[.size] as? NSNumber,
              size.intValue <= 256 * 1024,
              let data = try? Data(contentsOf: package, options: [.mappedIfSafe]),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return object["name"] as? String == "@bitkyc08/opencodex"
    }

    private static func isRegularFile(_ path: String, fileManager: FileManager) -> Bool {
        guard let attributes = try? fileManager.attributesOfItem(atPath: path),
              attributes[.type] as? FileAttributeType == .typeRegular
        else { return false }
        return true
    }

    private static func isExecutable(_ path: String, fileManager: FileManager) -> Bool {
        isRegularFile(URL(fileURLWithPath: path).resolvingSymlinksInPath().path, fileManager: fileManager)
            && fileManager.isExecutableFile(atPath: path)
    }
}

private final class BoundedOutput: @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Int
    private var data = Data()
    private(set) var overflowed = false

    init(limit: Int) { self.limit = limit }

    func append(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        let remaining = max(0, limit - data.count)
        if chunk.count > remaining { overflowed = true }
        if remaining > 0 { data.append(chunk.prefix(remaining)) }
    }

    func snapshot() -> (Data, Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (data, overflowed)
    }
}

private final class TimeoutState: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false

    func markFired() {
        lock.lock()
        fired = true
        lock.unlock()
    }

    var didFire: Bool {
        lock.lock()
        defer { lock.unlock() }
        return fired
    }
}

public actor LifecycleHelper: LifecycleCommandRunning {
    public static let maximumOutputBytes = 2 * 1024
    // Exceeds the CLI's 75s coordination wait + 20s health wait with margin for
    // helper startup and the final managed-client sync.
    public static let timeout: TimeInterval = 120
    private static let terminationGrace: TimeInterval = 1

    private let invocation: LifecycleInvocation?
    private let timeout: TimeInterval

    public init(
        invocation: LifecycleInvocation? = LifecycleHelperDiscovery.discover(),
        timeout: TimeInterval = LifecycleHelper.timeout
    ) {
        self.invocation = invocation
        self.timeout = timeout
    }

    public func run(_ action: LifecycleAction) async throws -> LifecycleCommandResult {
        guard let invocation else { throw LifecycleHelperError.unavailable }
        let timeout = self.timeout
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                let pipe = Pipe()
                let output = BoundedOutput(limit: Self.maximumOutputBytes)
                let timeoutState = TimeoutState()
                process.executableURL = invocation.executable
                process.arguments = invocation.prefixArguments + ["__macos-lifecycle", action.rawValue]
                process.standardOutput = pipe
                process.standardError = FileHandle.nullDevice
                process.environment = Self.controlledEnvironment()
                pipe.fileHandleForReading.readabilityHandler = { handle in
                    output.append(handle.availableData)
                }

                let killWork = DispatchWorkItem {
                    guard timeoutState.didFire, process.isRunning else { return }
                    _ = Darwin.kill(process.processIdentifier, SIGKILL)
                }
                let timeoutWork = DispatchWorkItem {
                    guard process.isRunning else { return }
                    timeoutState.markFired()
                    process.terminate()
                    DispatchQueue.global(qos: .utility).asyncAfter(
                        deadline: .now() + Self.terminationGrace,
                        execute: killWork
                    )
                }
                do {
                    try process.run()
                } catch {
                    pipe.fileHandleForReading.readabilityHandler = nil
                    continuation.resume(throwing: LifecycleHelperError.launchFailed)
                    return
                }
                DispatchQueue.global(qos: .utility).asyncAfter(
                    deadline: .now() + timeout,
                    execute: timeoutWork
                )
                process.waitUntilExit()
                timeoutWork.cancel()
                killWork.cancel()
                pipe.fileHandleForReading.readabilityHandler = nil
                output.append(pipe.fileHandleForReading.readDataToEndOfFile())
                let (data, overflowed) = output.snapshot()

                if process.terminationReason == .uncaughtSignal {
                    continuation.resume(throwing: timeoutState.didFire
                        ? LifecycleHelperError.timedOut
                        : LifecycleHelperError.invalidResponse)
                    return
                }
                guard !overflowed,
                      data.count <= Self.maximumOutputBytes,
                      let result = try? JSONDecoder().decode(LifecycleCommandResult.self, from: data),
                      result.schemaVersion == 1,
                      result.action == action,
                      result.message.utf8.count <= 240,
                      result.pid.map({ $0 > 0 }) ?? true,
                      result.port.map({ (1...65_535).contains($0) }) ?? true,
                      (process.terminationStatus == 0) == result.ok
                else {
                    continuation.resume(throwing: LifecycleHelperError.invalidResponse)
                    return
                }
                continuation.resume(returning: result)
            }
        }
    }

    /// Preserve OpenCodex/Codex configuration while removing runtime preloads and an
    /// attacker-controlled PATH from this privileged fixed-action bridge.
    private nonisolated static func controlledEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        for key in [
            "BUN_OPTIONS", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO",
            "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
        ] {
            environment.removeValue(forKey: key)
        }
        return environment
    }
}

import Darwin
import Foundation

public enum DiscoveryError: Error, Equatable, Sendable {
    case unsafeConfigDirectory
    case unsafeRuntimeRecord
    case unsupportedHost
}

public enum ManagementCredentialAvailability: Equatable, Sendable {
    case file
    case inheritedEnvironment
    case unavailable

    public var userMessage: String? {
        switch self {
        case .file, .inheritedEnvironment:
            return nil
        case .unavailable:
            return "Management authentication is unavailable. Run `ocx doctor`."
        }
    }
}

/// A validated endpoint for the local OpenCodex proxy.
public struct ProxyEndpoint: Equatable, Sendable {
    public static let validPorts = 1...65535

    public let host: String
    public let port: Int
    public let expectedPID: Int?
    private let resolvedURL: URL

    public init?(host: String, port: Int, expectedPID: Int? = nil) {
        guard Self.validPorts.contains(port),
              let normalized = Self.normalizedLoopbackHost(host)
        else { return nil }
        var components = URLComponents()
        components.scheme = "http"
        // Foundation's URLComponents expects brackets when assigning an IPv6 host,
        // even though URL.host later returns the unbracketed literal.
        components.host = normalized.contains(":") ? "[\(normalized)]" : normalized
        components.port = port
        guard let url = components.url else { return nil }
        self.host = normalized
        self.port = port
        self.expectedPID = expectedPID
        self.resolvedURL = url
    }

    public init?(port: Int) {
        self.init(host: "127.0.0.1", port: port)
    }

    public static let `default` = ProxyEndpoint(port: ProxyDiscovery.defaultPort)!

    public var baseURL: URL { resolvedURL }

    public var display: String {
        host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
    }

    public static func normalizedLoopbackHost(_ raw: String?) -> String? {
        let value = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch value {
        case "", "localhost", "127.0.0.1", "0.0.0.0", "*":
            return "127.0.0.1"
        case "::1", "::":
            return "::1"
        default:
            return nil
        }
    }
}

public struct ProxyInstallation: Sendable {
    public let endpoint: ProxyEndpoint
    public let credential: String?
    public let credentialAvailability: ManagementCredentialAvailability
    public let configDirectory: URL

    public init(
        endpoint: ProxyEndpoint,
        credential: String?,
        credentialAvailability: ManagementCredentialAvailability,
        configDirectory: URL
    ) {
        self.endpoint = endpoint
        self.credential = credential
        self.credentialAvailability = credentialAvailability
        self.configDirectory = configDirectory
    }
}

private struct RuntimePortRecord: Decodable {
    let pid: Int
    let port: Int
    let hostname: String?
}

private enum SecureReadError: Error {
    case missing
    case unsafe
    case oversized
    case unreadable
}

private final class SecureDirectory {
    private let descriptor: Int32

    init(url: URL) throws {
        let flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_DIRECTORY
        let fd = url.path.withCString { Darwin.open($0, flags) }
        guard fd >= 0 else {
            if errno == ENOENT { throw SecureReadError.missing }
            throw SecureReadError.unsafe
        }

        var info = stat()
        guard fstat(fd, &info) == 0,
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR),
              info.st_uid == geteuid(),
              (info.st_mode & mode_t(0o077)) == 0
        else {
            Darwin.close(fd)
            throw SecureReadError.unsafe
        }
        descriptor = fd
    }

    deinit {
        Darwin.close(descriptor)
    }

    func readFile(named name: String, maxBytes: Int, requirePrivateMode: Bool = true) throws -> Data {
        guard !name.isEmpty, !name.contains("/") else { throw SecureReadError.unsafe }
        let flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW
        let fd = name.withCString { Darwin.openat(descriptor, $0, flags) }
        guard fd >= 0 else {
            if errno == ENOENT { throw SecureReadError.missing }
            throw SecureReadError.unsafe
        }
        defer { Darwin.close(fd) }

        var info = stat()
        guard fstat(fd, &info) == 0,
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              info.st_uid == geteuid(),
              info.st_nlink == 1,
              !requirePrivateMode || (info.st_mode & mode_t(0o077)) == 0
        else { throw SecureReadError.unsafe }
        guard info.st_size >= 0, info.st_size <= maxBytes else { throw SecureReadError.oversized }

        var result = Data()
        result.reserveCapacity(Int(info.st_size))
        var buffer = [UInt8](repeating: 0, count: min(4096, maxBytes + 1))
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count == 0 { break }
            guard count > 0 else {
                if errno == EINTR { continue }
                throw SecureReadError.unreadable
            }
            guard result.count + count <= maxBytes else { throw SecureReadError.oversized }
            result.append(contentsOf: buffer[0..<count])
        }
        return result
    }
}

/// Discovers the runtime endpoint and existing management credential without creating,
/// mutating, or persisting any state. Every call opens fresh descriptors.
public enum ProxyDiscovery {
    public static let defaultPort = 10100

    public static func configDirectory(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        if let override = environment["OPENCODEX_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
                .standardizedFileURL
        }
        return home.appendingPathComponent(".opencodex", isDirectory: true).standardizedFileURL
    }

    public static func discover(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) throws -> ProxyInstallation {
        let directoryURL = configDirectory(environment: environment, home: home)
        let inherited = environment["OPENCODEX_ADMIN_AUTH_TOKEN"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let directory: SecureDirectory
        do {
            directory = try SecureDirectory(url: directoryURL)
        } catch SecureReadError.missing {
            return ProxyInstallation(
                endpoint: .default,
                credential: inherited?.isEmpty == false ? inherited : nil,
                credentialAvailability: inherited?.isEmpty == false ? .inheritedEnvironment : .unavailable,
                configDirectory: directoryURL
            )
        } catch {
            throw DiscoveryError.unsafeConfigDirectory
        }

        let endpoint: ProxyEndpoint
        do {
            let data = try directory.readFile(named: "runtime-port.json", maxBytes: 16 * 1024)
            guard let record = try? JSONDecoder().decode(RuntimePortRecord.self, from: data),
                  record.pid > 0,
                  let discovered = ProxyEndpoint(
                    host: record.hostname ?? "127.0.0.1",
                    port: record.port,
                    expectedPID: record.pid
                  )
            else {
                if let record = try? JSONDecoder().decode(RuntimePortRecord.self, from: data),
                   ProxyEndpoint.normalizedLoopbackHost(record.hostname) == nil {
                    throw DiscoveryError.unsupportedHost
                }
                throw DiscoveryError.unsafeRuntimeRecord
            }
            endpoint = discovered
        } catch SecureReadError.missing {
            endpoint = .default
        } catch let error as DiscoveryError {
            throw error
        } catch {
            throw DiscoveryError.unsafeRuntimeRecord
        }

        if let inherited, !inherited.isEmpty {
            return ProxyInstallation(
                endpoint: endpoint,
                credential: inherited,
                credentialAvailability: .inheritedEnvironment,
                configDirectory: directoryURL
            )
        }

        do {
            let data = try directory.readFile(named: "admin-api-token", maxBytes: 512)
            guard let raw = String(data: data, encoding: .utf8) else {
                throw SecureReadError.unreadable
            }
            let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let range = NSRange(token.startIndex..<token.endIndex, in: token)
            let regex = try NSRegularExpression(pattern: "^ocx_admin_[A-Za-z0-9_-]{43}$")
            guard regex.firstMatch(in: token, range: range) != nil else {
                throw SecureReadError.unsafe
            }
            return ProxyInstallation(
                endpoint: endpoint,
                credential: token,
                credentialAvailability: .file,
                configDirectory: directoryURL
            )
        } catch {
            return ProxyInstallation(
                endpoint: endpoint,
                credential: nil,
                credentialAvailability: .unavailable,
                configDirectory: directoryURL
            )
        }
    }

    /// Compatibility helper for display-only callers. Token-bearing callers must use
    /// `discover()` and preserve its credential/error state.
    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> ProxyEndpoint {
        (try? discover(environment: environment, home: home).endpoint) ?? .default
    }
}

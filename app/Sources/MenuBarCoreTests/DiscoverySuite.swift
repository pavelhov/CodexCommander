import Foundation
import MenuBarCore

enum DiscoverySuite {
    private static let token = "ccx_admin_" + String(repeating: "a", count: 43)
    private static let attestationSecret = String(repeating: "S", count: 43)

    static func run(_ t: TestRunner) {
        t.test("discovery: accepts only explicit literal loopback and maps wildcards") {
            try withSandbox { root in
                try writeToken(root)
                let cases: [(String?, String)] = [
                    (nil, "127.0.0.1"),
                    ("localhost", "127.0.0.1"),
                    ("127.0.0.1", "127.0.0.1"),
                    ("0.0.0.0", "127.0.0.1"),
                    ("*", "127.0.0.1"),
                    ("::", "::1"),
                    ("::1", "::1"),
                ]
                for (host, expected) in cases {
                    try writeRuntime(root, host: host)
                    let found = try discover(root)
                    t.equal(found.endpoint.host, expected, host ?? "missing host")
                    t.equal(found.endpoint.port, 18181)
                    t.equal(found.endpoint.expectedPID, 4242)
                    t.equal(found.runtimeAttestation?.pid, 4242)
                    t.equal(found.runtimeAttestation?.port, 18181)
                    t.equal(found.runtimeAttestation?.host, expected)
                }
            }
        }

        t.test("discovery: rejects every non-allowlisted hostname or address without DNS") {
            try withSandbox { root in
                try writeToken(root)
                for host in ["example.com", "10.0.0.5", "127.0.0.2", "[::1]", "fe80::1"] {
                    try writeRuntime(root, host: host)
                    do {
                        _ = try discover(root)
                        t.expect(false, "\(host) should be rejected")
                    } catch DiscoveryError.unsupportedHost {
                        // expected
                    }
                }
            }
        }

        t.test("discovery: runtime metadata requires the exact current schema") {
            try withSandbox { root in
                try writeToken(root)
                let validSecret = String(repeating: "A", count: 43)
                try writeRuntimeJSON(
                    root,
                    #"{"schemaVersion":1,"pid":4242,"port":18181,"attestationSecret":"\#(validSecret)"}"#
                )
                t.equal(try discover(root).endpoint.port, 18181)
                try writeRuntimeJSON(
                    root,
                    #"{"schemaVersion":1,"pid":4242,"port":18181,"attestationSecret":"\#(validSecret)","attestationProtocol":2}"#
                )
                t.equal(try discover(root).runtimeAttestation?.attestationProtocol, 2)

                let invalidRecords = [
                    #"{"pid":4242,"port":18181}"#,
                    #"{"schemaVersion":2,"pid":4242,"port":18181}"#,
                    #"{"schemaVersion":1,"pid":4242,"port":18181,"legacyPort":18181}"#,
                    #"{"schemaVersion":1,"pid":4242,"port":18181,"hostname":null}"#,
                    #"{"schemaVersion":1,"pid":4242,"port":18181,"attestationSecret":"short"}"#,
                    #"{"schemaVersion":1,"pid":4242,"port":18181,"attestationSecret":"\#(validSecret)","attestationProtocol":3}"#,
                    #"{"schemaVersion":1,"pid":4242,"port":18181,"attestationSecret":"\#(validSecret)","attestationProtocol":"2"}"#,
                ]
                for record in invalidRecords {
                    try writeRuntimeJSON(root, record)
                    do {
                        _ = try discover(root)
                        t.expect(false, "non-current runtime record should fail")
                    } catch DiscoveryError.unsafeRuntimeRecord {
                        // expected
                    }
                }
            }
        }

        t.test("discovery: reads the existing protected token and never needs Keychain") {
            try withSandbox { root in
                try writeRuntime(root, host: "127.0.0.1")
                try writeToken(root)
                let found = try discover(root)
                t.equal(found.credential, token)
                t.equal(found.credentialAvailability, .file)
            }
        }

        t.test("discovery: inherited admin auth supports environment-only launches") {
            try withSandbox { root in
                try writeRuntime(root, host: "127.0.0.1")
                let found = try ProxyDiscovery.discover(
                    environment: [
                        "CODEXCOMMANDER_HOME": root.path,
                        "CODEXCOMMANDER_ADMIN_AUTH_TOKEN": "environment-secret",
                    ],
                    home: URL(fileURLWithPath: "/unused")
                )
                t.equal(found.credential, "environment-secret")
                t.equal(found.credentialAvailability, .inheritedEnvironment)
            }
        }

        t.test("discovery: Finder-style environment-only config reports unavailable") {
            try withSandbox { root in
                try writeRuntime(root, host: "127.0.0.1")
                let found = try discover(root)
                t.isNil(found.credential, "credential")
                t.equal(found.credentialAvailability, .unavailable)
            }
        }

        t.test("discovery: rejects a symlinked token and an over-permissive token") {
            try withSandbox { root in
                try writeRuntime(root, host: "127.0.0.1")
                let outside = root.appendingPathComponent("outside-token")
                try token.write(to: outside, atomically: true, encoding: .utf8)
                try chmod(outside, 0o600)
                try FileManager.default.createSymbolicLink(
                    at: root.appendingPathComponent("admin-api-token"),
                    withDestinationURL: outside
                )
                var found = try discover(root)
                t.equal(found.credentialAvailability, .unavailable)

                try FileManager.default.removeItem(at: root.appendingPathComponent("admin-api-token"))
                try writeToken(root, mode: 0o644)
                found = try discover(root)
                t.equal(found.credentialAvailability, .unavailable)
            }
        }

        t.test("discovery: rejects symlinked runtime metadata and unsafe directories") {
            try withSandbox { root in
                try writeToken(root)
                let target = root.appendingPathComponent("real-runtime")
                try runtimeJSON(host: "127.0.0.1").write(
                    to: target, atomically: true, encoding: .utf8
                )
                try chmod(target, 0o600)
                try FileManager.default.createSymbolicLink(
                    at: root.appendingPathComponent("runtime-port.json"),
                    withDestinationURL: target
                )
                do {
                    _ = try discover(root)
                    t.expect(false, "symlinked runtime record should fail")
                } catch DiscoveryError.unsafeRuntimeRecord {
                    // expected
                }

                try FileManager.default.removeItem(at: root.appendingPathComponent("runtime-port.json"))
                try chmod(root, 0o755)
                defer { try? chmod(root, 0o700) }
                do {
                    _ = try discover(root)
                    t.expect(false, "unsafe config directory should fail")
                } catch DiscoveryError.unsafeConfigDirectory {
                    // expected
                }
            }
        }

        t.test("discovery: CODEXCOMMANDER_HOME overrides the default directory") {
            try withSandbox { root in
                let resolved = ProxyDiscovery.configDirectory(
                    environment: ["CODEXCOMMANDER_HOME": root.path],
                    home: URL(fileURLWithPath: "/nonexistent")
                )
                t.equal(resolved.path, root.standardizedFileURL.path)
            }
        }

        t.test("discovery: default directory is always the CodexCommander home") {
            try withSandbox { home in
                let canonical = home.appendingPathComponent(".codexcommander", isDirectory: true)
                try FileManager.default.createDirectory(
                    at: canonical,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700]
                )
                let resolved = ProxyDiscovery.configDirectory(environment: [:], home: home)
                t.equal(resolved.path, canonical.standardizedFileURL.path)
            }
        }

        t.test("discovery: blank home override uses the CodexCommander default") {
            try withSandbox { home in
                let canonical = home.appendingPathComponent(".codexcommander", isDirectory: true)
                try FileManager.default.createDirectory(
                    at: canonical,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700]
                )
                let resolved = ProxyDiscovery.configDirectory(
                    environment: ["CODEXCOMMANDER_HOME": "  \n"],
                    home: home
                )
                t.equal(resolved.path, canonical.standardizedFileURL.path)
            }
        }

        t.test("discovery: rejects non-CodexCommander token formats") {
            try withSandbox { root in
                try writeRuntime(root, host: "127.0.0.1")
                let invalid = "wrong_admin_" + String(repeating: "a", count: 43)
                let file = root.appendingPathComponent("admin-api-token")
                try invalid.write(to: file, atomically: true, encoding: .utf8)
                try chmod(file, 0o600)
                let found = try discover(root)
                t.isNil(found.credential, "credential")
                t.equal(found.credentialAvailability, .unavailable)
            }
        }
    }

    private static func withSandbox(_ body: (URL) throws -> Void) throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("codexcommander-discovery-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private static func discover(_ root: URL) throws -> ProxyInstallation {
        try ProxyDiscovery.discover(
            environment: ["CODEXCOMMANDER_HOME": root.path],
            home: URL(fileURLWithPath: "/unused")
        )
    }

    private static func runtimeJSON(host: String?) -> String {
        if let host {
            return #"{"schemaVersion":1,"pid":4242,"port":18181,"hostname":"\#(host)","attestationSecret":"\#(attestationSecret)"}"#
        }
        return #"{"schemaVersion":1,"pid":4242,"port":18181,"attestationSecret":"\#(attestationSecret)"}"#
    }

    private static func writeRuntime(_ root: URL, host: String?) throws {
        try writeRuntimeJSON(root, runtimeJSON(host: host))
    }

    private static func writeRuntimeJSON(_ root: URL, _ json: String) throws {
        let file = root.appendingPathComponent("runtime-port.json")
        try? FileManager.default.removeItem(at: file)
        try json.write(to: file, atomically: true, encoding: .utf8)
        try chmod(file, 0o600)
    }

    private static func writeToken(_ root: URL, mode: Int = 0o600) throws {
        let file = root.appendingPathComponent("admin-api-token")
        try? FileManager.default.removeItem(at: file)
        try (token + "\n").write(to: file, atomically: true, encoding: .utf8)
        try chmod(file, mode)
    }

    private static func chmod(_ url: URL, _ mode: Int) throws {
        try FileManager.default.setAttributes(
            [.posixPermissions: mode],
            ofItemAtPath: url.path
        )
    }
}

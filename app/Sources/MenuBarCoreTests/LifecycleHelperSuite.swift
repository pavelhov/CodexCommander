import Foundation
import MenuBarCore

enum LifecycleHelperSuite {
    static func run(_ t: TestRunner) {
        t.test("lifecycle helper: released app prefers its bundled runtime outside the repository") {
            try withTemporaryDirectory { root in
                let bundle = root.appendingPathComponent(
                    "Applications/OpenCodex.app",
                    isDirectory: true
                )
                let runtime = bundle.appendingPathComponent(
                    "Contents/Resources/runtime",
                    isDirectory: true
                )
                let entry = runtime.appendingPathComponent("src/cli/index.ts")
                let package = runtime.appendingPathComponent("package.json")
                let bun = runtime.appendingPathComponent("node_modules/bun/bin/bun")
                try FileManager.default.createDirectory(
                    at: entry.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try FileManager.default.createDirectory(
                    at: bun.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try Data(#"{"name":"@bitkyc08/opencodex"}"#.utf8).write(to: package)
                try Data().write(to: entry)
                try Data("#!/bin/sh\n".utf8).write(to: bun)
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o700],
                    ofItemAtPath: bun.path
                )

                let invocation = LifecycleHelperDiscovery.discover(
                    bundleURL: bundle,
                    environment: [
                        "PATH": "/definitely/not-a-real-path",
                        "BUN_OPTIONS": "--inspect",
                        "DYLD_INSERT_LIBRARIES": "/tmp/should-not-be-used.dylib",
                    ],
                    home: root.appendingPathComponent("outside-repo", isDirectory: true)
                )
                t.equal(invocation?.executable.path, bun.path)
                t.equal(invocation?.prefixArguments, [entry.path])
            }
        }

        t.test("lifecycle helper: app-owned invocation receives the update boundary marker") {
            try withTemporaryDirectory { root in
                let executable = root.appendingPathComponent(
                    "OpenCodex.app/Contents/Resources/runtime/bin/helper",
                    isDirectory: false
                )
                try FileManager.default.createDirectory(
                    at: executable.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                let body = """
                #!/bin/sh
                if [ "$OCX_APP_RUNTIME" != "1" ]; then exit 9; fi
                if [ "$PATH" != "/usr/bin:/bin:/usr/sbin:/sbin" ]; then exit 10; fi
                printf '{"schemaVersion":1,"action":"%s","ok":true,"state":"running","changed":false,"message":"bundled"}\\n' "$2"
                """
                try Data(body.utf8).write(to: executable)
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o700],
                    ofItemAtPath: executable.path
                )

                let helper = LifecycleHelper(
                    invocation: LifecycleInvocation(executable: executable),
                    timeout: 2
                )
                let result = sync { try await helper.run(.status) }
                switch result {
                case .success(let value):
                    t.equal(value.message, "bundled")
                case .failure(let error):
                    t.expect(false, "unexpected helper failure: \(error)")
                }
            }
        }

        t.test("lifecycle helper: source app resolves the repository Bun entry") {
            try withTemporaryDirectory { root in
                let repository = root.appendingPathComponent("repo", isDirectory: true)
                let bundle = repository.appendingPathComponent(
                    "dist/macos/OpenCodex.app",
                    isDirectory: true
                )
                let entry = repository.appendingPathComponent("src/cli/index.ts")
                let package = repository.appendingPathComponent("package.json")
                let bun = repository.appendingPathComponent("node_modules/bun/bin/bun.exe")
                let bundledRuntime = bundle.appendingPathComponent(
                    "Contents/Resources/runtime",
                    isDirectory: true
                )
                let bundledEntry = bundledRuntime.appendingPathComponent("src/cli/index.ts")
                let bundledPackage = bundledRuntime.appendingPathComponent("package.json")
                let bundledBun = bundledRuntime.appendingPathComponent("node_modules/bun/bin/bun")
                try FileManager.default.createDirectory(
                    at: bundle,
                    withIntermediateDirectories: true
                )
                try FileManager.default.createDirectory(
                    at: entry.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try FileManager.default.createDirectory(
                    at: bun.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try FileManager.default.createDirectory(
                    at: bundledEntry.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try FileManager.default.createDirectory(
                    at: bundledBun.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                FileManager.default.createFile(
                    atPath: package.path,
                    contents: Data(#"{"name":"@bitkyc08/opencodex"}"#.utf8)
                )
                FileManager.default.createFile(atPath: entry.path, contents: Data())
                FileManager.default.createFile(atPath: bun.path, contents: Data("#!/bin/sh\n".utf8))
                FileManager.default.createFile(
                    atPath: bundledPackage.path,
                    contents: Data(#"{"name":"@bitkyc08/opencodex"}"#.utf8)
                )
                FileManager.default.createFile(atPath: bundledEntry.path, contents: Data())
                FileManager.default.createFile(atPath: bundledBun.path, contents: Data("#!/bin/sh\n".utf8))
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o700],
                    ofItemAtPath: bun.path
                )
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o700],
                    ofItemAtPath: bundledBun.path
                )

                let invocation = LifecycleHelperDiscovery.discover(
                    bundleURL: bundle,
                    environment: ["PATH": ""],
                    home: root
                )
                t.equal(invocation?.executable.path, bun.path)
                t.equal(invocation?.prefixArguments, [entry.path])
            }
        }

        t.test("lifecycle helper: ambient PATH executables are never selected") {
            try withTemporaryDirectory { root in
                let untrusted = root.appendingPathComponent("untrusted", isDirectory: true)
                try FileManager.default.createDirectory(
                    at: untrusted,
                    withIntermediateDirectories: true
                )
                _ = try makeExecutable(
                    in: untrusted,
                    named: "ocx",
                    body: "#!/bin/sh\nexit 0\n"
                )
                let invocation = LifecycleHelperDiscovery.discover(
                    bundleURL: root.appendingPathComponent("Copied.app"),
                    environment: ["PATH": untrusted.path],
                    home: root
                )
                t.isNil(invocation, "PATH candidate")
            }
        }

        t.test("lifecycle helper: fixed install symlink resolves only an OpenCodex package") {
            try withTemporaryDirectory { root in
                let repository = root.appendingPathComponent("package", isDirectory: true)
                let bin = repository.appendingPathComponent("bin", isDirectory: true)
                let entry = repository.appendingPathComponent("src/cli/index.ts")
                let bun = repository.appendingPathComponent("node_modules/.bin/bun")
                let installedBin = root.appendingPathComponent(".local/bin", isDirectory: true)
                try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
                try FileManager.default.createDirectory(
                    at: entry.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try FileManager.default.createDirectory(
                    at: bun.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try FileManager.default.createDirectory(at: installedBin, withIntermediateDirectories: true)
                try Data(#"{"name":"@bitkyc08/opencodex"}"#.utf8).write(
                    to: repository.appendingPathComponent("package.json")
                )
                try Data().write(to: entry)
                let launcher = try makeExecutable(
                    in: bin,
                    named: "ocx.mjs",
                    body: "#!/usr/bin/env node\n"
                )
                _ = try makeExecutable(in: bun.deletingLastPathComponent(), named: "bun", body: "#!/bin/sh\n")
                try FileManager.default.createSymbolicLink(
                    at: installedBin.appendingPathComponent("ocx"),
                    withDestinationURL: launcher
                )

                let invocation = LifecycleHelperDiscovery.discover(
                    bundleURL: root.appendingPathComponent("Release.app"),
                    environment: ["PATH": ""],
                    home: root
                )
                t.equal(invocation?.executable.path, bun.path)
                t.equal(invocation?.prefixArguments, [entry.path])
            }
        }

        t.test("lifecycle helper: decodes one matching bounded JSON result") {
            try withTemporaryDirectory { root in
                let script = try makeExecutable(
                    in: root,
                    named: "valid-helper",
                    body: """
                    #!/bin/sh
                    printf '{"schemaVersion":1,"action":"%s","ok":true,"state":"running","changed":true,"pid":42,"port":10100,"message":"OpenCodex proxy started."}\\n' "$2"
                    """
                )
                let helper = LifecycleHelper(
                    invocation: LifecycleInvocation(executable: script),
                    timeout: 2
                )
                let result = sync { try await helper.run(.start) }
                switch result {
                case .success(let value):
                    t.equal(value.action, .start)
                    t.equal(value.state, .running)
                    t.equal(value.port, 10100)
                case .failure(let error):
                    t.expect(false, "unexpected helper failure: \(error)")
                }
            }
        }

        t.test("lifecycle helper: rejects output beyond the fixed cap") {
            try withTemporaryDirectory { root in
                let script = try makeExecutable(
                    in: root,
                    named: "oversized-helper",
                    body: """
                    #!/bin/sh
                    i=0
                    while [ "$i" -lt 3000 ]; do printf x; i=$((i + 1)); done
                    """
                )
                let helper = LifecycleHelper(
                    invocation: LifecycleInvocation(executable: script),
                    timeout: 2
                )
                let result = sync { try await helper.run(.status) }
                if case .failure(let error as LifecycleHelperError) = result {
                    t.equal(error, .invalidResponse)
                } else {
                    t.expect(false, "oversized helper output must be rejected")
                }
            }
        }

        t.test("lifecycle helper: terminates a helper that exceeds its deadline") {
            try withTemporaryDirectory { root in
                let script = try makeExecutable(
                    in: root,
                    named: "slow-helper",
                    body: "#!/bin/sh\nexec sleep 5\n"
                )
                let helper = LifecycleHelper(
                    invocation: LifecycleInvocation(executable: script),
                    timeout: 0.05
                )
                let result = sync { try await helper.run(.status) }
                if case .failure(let error as LifecycleHelperError) = result {
                    t.equal(error, .timedOut)
                } else {
                    t.expect(false, "slow helper must time out")
                }
            }
        }

        t.test("lifecycle helper: an unrelated signal is not misreported as a timeout") {
            try withTemporaryDirectory { root in
                let script = try makeExecutable(
                    in: root,
                    named: "signalled-helper",
                    body: "#!/bin/sh\nkill -TERM $$\n"
                )
                let helper = LifecycleHelper(
                    invocation: LifecycleInvocation(executable: script),
                    timeout: 2
                )
                let result = sync { try await helper.run(.status) }
                if case .failure(let error as LifecycleHelperError) = result {
                    t.equal(error, .invalidResponse)
                } else {
                    t.expect(false, "an externally signalled helper is an invalid response")
                }
            }
        }

        t.test("lifecycle helper: escalates when a helper ignores termination") {
            try withTemporaryDirectory { root in
                let script = try makeExecutable(
                    in: root,
                    named: "term-ignoring-helper",
                    body: "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 0.1; done\n"
                )
                let helper = LifecycleHelper(
                    invocation: LifecycleInvocation(executable: script),
                    timeout: 0.05
                )
                let result = sync { try await helper.run(.status) }
                if case .failure(let error as LifecycleHelperError) = result {
                    t.equal(error, .timedOut)
                } else {
                    t.expect(false, "a termination-resistant helper must still time out")
                }
            }
        }
    }

    private static func withTemporaryDirectory<T>(_ body: (URL) throws -> T) throws -> T {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "OpenCodex-Lifecycle-\(UUID().uuidString)",
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        return try body(root)
    }

    private static func makeExecutable(in root: URL, named: String, body: String) throws -> URL {
        let url = root.appendingPathComponent(named)
        try Data(body.utf8).write(to: url, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: url.path
        )
        return url
    }

    private static func sync<T>(_ operation: @escaping () async throws -> T) -> Result<T, Error> {
        let semaphore = DispatchSemaphore(value: 0)
        let box = ResultBox<T>()
        Task {
            do { box.value = .success(try await operation()) }
            catch { box.value = .failure(error) }
            semaphore.signal()
        }
        semaphore.wait()
        return box.value!
    }

    private final class ResultBox<T>: @unchecked Sendable {
        var value: Result<T, Error>?
    }
}

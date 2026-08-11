import Foundation
import Darwin
import MenuBarCore

enum LifecycleHelperSuite {
    static func run(_ t: TestRunner) {
        t.test("lifecycle helper: renamed app resolves only its bundled runtime") {
            try withTemporaryDirectory { root in
                let bundle = root.appendingPathComponent(
                    "Applications/My Renamed Commander.app",
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
                try Data(#"{"name":"codexcommander"}"#.utf8).write(to: package)
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
                t.equal(invocation?.prefixArguments,
                    ["--no-install", "--no-env-file", "--config=/dev/null", entry.path])
                t.equal(invocation?.workingDirectory?.path, runtime.path)
                t.equal(invocation?.appOwnedRuntime, true)
            }
        }

        t.test("lifecycle helper: app-owned invocation receives the update boundary marker") {
            try withTemporaryDirectory { root in
                let executable = root.appendingPathComponent(
                    "CodexCommander.app/Contents/Resources/runtime/bin/helper",
                    isDirectory: false
                )
                try FileManager.default.createDirectory(
                    at: executable.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try Data().write(
                    to: executable.deletingLastPathComponent().appendingPathComponent("trusted-cwd")
                )
                let body = """
                #!/bin/sh
                if [ "$CCX_APP_RUNTIME" != "1" ]; then exit 9; fi
                if [ "$PATH" != "/usr/bin:/bin:/usr/sbin:/sbin" ]; then exit 10; fi
                if [ ! -f trusted-cwd ]; then exit 11; fi
                printf '{"schemaVersion":1,"action":"%s","ok":true,"state":"running","changed":false,"pid":null,"port":null,"message":"bundled"}\\n' "$2"
                """
                try Data(body.utf8).write(to: executable)
                try FileManager.default.setAttributes(
                    [.posixPermissions: 0o700],
                    ofItemAtPath: executable.path
                )

                let helper = LifecycleHelper(
                    invocation: LifecycleInvocation(
                        executable: executable,
                        workingDirectory: executable.deletingLastPathComponent(),
                        appOwnedRuntime: true
                    ),
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

        t.test("lifecycle helper: dist app prefers its bundled runtime over the checkout") {
            try withTemporaryDirectory { root in
                let repository = root.appendingPathComponent("repo", isDirectory: true)
                let bundle = repository.appendingPathComponent(
                    "dist/macos/CodexCommander.app",
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
                    contents: Data(#"{"name":"codexcommander"}"#.utf8)
                )
                FileManager.default.createFile(atPath: entry.path, contents: Data())
                FileManager.default.createFile(atPath: bun.path, contents: Data("#!/bin/sh\n".utf8))
                FileManager.default.createFile(
                    atPath: bundledPackage.path,
                    contents: Data(#"{"name":"codexcommander"}"#.utf8)
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
                t.equal(invocation?.executable.path, bundledBun.path)
                t.equal(invocation?.prefixArguments,
                    ["--no-install", "--no-env-file", "--config=/dev/null", bundledEntry.path])
                t.equal(invocation?.workingDirectory?.path, bundledRuntime.path)
                t.equal(invocation?.appOwnedRuntime, true)
            }
        }

        t.test("lifecycle helper: missing or damaged app runtime never falls through to a global install") {
            try withTemporaryDirectory { root in
                _ = try installFixedGlobalRuntime(in: root)

                let missingBundle = root.appendingPathComponent("Missing Runtime.app", isDirectory: true)
                try FileManager.default.createDirectory(at: missingBundle, withIntermediateDirectories: true)
                t.isNil(LifecycleHelperDiscovery.discover(
                    bundleURL: missingBundle,
                    environment: ["PATH": ""],
                    home: root
                ), "missing embedded runtime")

                let damagedBundle = root.appendingPathComponent("Damaged Runtime.app", isDirectory: true)
                let damaged = try makeBundledRuntime(in: damagedBundle)
                try Data(#"{"name":"not-codexcommander"}"#.utf8).write(
                    to: damaged.runtime.appendingPathComponent("package.json"),
                    options: .atomic
                )
                t.isNil(LifecycleHelperDiscovery.discover(
                    bundleURL: damagedBundle,
                    environment: ["PATH": ""],
                    home: root
                ), "damaged embedded runtime")
            }
        }

        t.test("lifecycle helper: bundled entry and Bun symlink escapes fail containment") {
            try withTemporaryDirectory { root in
                let entryBundle = root.appendingPathComponent("Entry Escape.app", isDirectory: true)
                let entryRuntime = try makeBundledRuntime(in: entryBundle)
                try FileManager.default.removeItem(at: entryRuntime.entry)
                let sibling = root.appendingPathComponent("runtime-evil", isDirectory: true)
                try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
                let escapedEntry = sibling.appendingPathComponent("index.ts")
                try Data().write(to: escapedEntry)
                try FileManager.default.createSymbolicLink(
                    at: entryRuntime.entry,
                    withDestinationURL: escapedEntry
                )
                t.isNil(LifecycleHelperDiscovery.discover(bundleURL: entryBundle, home: root),
                    "runtime-evil entry prefix")

                let bunBundle = root.appendingPathComponent("Bun Escape.app", isDirectory: true)
                let bunRuntime = try makeBundledRuntime(in: bunBundle)
                try FileManager.default.removeItem(at: bunRuntime.bun)
                let escapedBun = try makeExecutable(
                    in: root,
                    named: "outside-bun",
                    body: "#!/bin/sh\nexit 0\n"
                )
                try FileManager.default.createSymbolicLink(
                    at: bunRuntime.bun,
                    withDestinationURL: escapedBun
                )
                t.isNil(LifecycleHelperDiscovery.discover(bundleURL: bunBundle, home: root),
                    "escaped Bun")

                let runtimeBundle = root.appendingPathComponent("Runtime Escape.app", isDirectory: true)
                let resources = runtimeBundle.appendingPathComponent(
                    "Contents/Resources",
                    isDirectory: true
                )
                try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
                let outsideRuntime = root.appendingPathComponent("outside-runtime", isDirectory: true)
                _ = try makeRuntime(at: outsideRuntime)
                try FileManager.default.createSymbolicLink(
                    at: resources.appendingPathComponent("runtime"),
                    withDestinationURL: outsideRuntime
                )
                t.isNil(LifecycleHelperDiscovery.discover(bundleURL: runtimeBundle, home: root),
                    "escaped runtime root")
            }
        }

        t.test("lifecycle helper: bundled Bun ignores ambient and runtime bunfig preloads") {
            try withTemporaryDirectory { root in
                let bundle = root.appendingPathComponent("Hermetic.app", isDirectory: true)
                let bundled = try makeBundledRuntime(in: bundle)
                guard let projectBun = findProjectBun() else {
                    t.expect(false, "project Bun executable not found")
                    return
                }
                try FileManager.default.removeItem(at: bundled.bun)
                do {
                    try FileManager.default.linkItem(at: projectBun, to: bundled.bun)
                } catch {
                    try FileManager.default.copyItem(at: projectBun, to: bundled.bun)
                }

                let sentinel = root.appendingPathComponent("preload-executed")
                let preloadSource = "await Bun.write(\(String(reflecting: sentinel.path)), \"executed\");\n"
                let maliciousConfig = "preload = [\"./preload.ts\"]\n"
                try Data(preloadSource.utf8).write(
                    to: bundled.runtime.appendingPathComponent("preload.ts"),
                    options: .atomic
                )
                try Data(maliciousConfig.utf8).write(
                    to: bundled.runtime.appendingPathComponent("bunfig.toml"),
                    options: .atomic
                )
                let fakeHome = root.appendingPathComponent("home", isDirectory: true)
                let fakeXDG = root.appendingPathComponent("xdg", isDirectory: true)
                let globalPreload = root.appendingPathComponent("global-preload.ts")
                try FileManager.default.createDirectory(at: fakeHome, withIntermediateDirectories: true)
                try FileManager.default.createDirectory(at: fakeXDG, withIntermediateDirectories: true)
                try Data(preloadSource.utf8).write(to: globalPreload, options: .atomic)
                let globalConfig = "preload = [\(String(reflecting: globalPreload.path))]\n"
                try Data(globalConfig.utf8).write(
                    to: fakeHome.appendingPathComponent(".bunfig.toml"),
                    options: .atomic
                )
                try Data(globalConfig.utf8).write(
                    to: fakeXDG.appendingPathComponent(".bunfig.toml"),
                    options: .atomic
                )
                let entrySource = """
                const action = process.argv.at(-1);
                const pwdTrusted = process.env.PWD?.endsWith("/Contents/Resources/runtime") === true
                  && process.cwd().endsWith("/Contents/Resources/runtime");
                const homeIsolated = process.env.HOME === \(String(reflecting: fakeHome.path));
                console.log(JSON.stringify({
                  schemaVersion: 1,
                  action,
                  ok: true,
                  state: "running",
                  changed: false,
                  pid: null,
                  port: null,
                  message: `hermetic:${pwdTrusted}:${homeIsolated}`
                }));
                """
                try Data(entrySource.utf8).write(to: bundled.entry, options: .atomic)

                let ambient = root.appendingPathComponent("ambient", isDirectory: true)
                try FileManager.default.createDirectory(at: ambient, withIntermediateDirectories: true)
                try Data(preloadSource.utf8).write(
                    to: ambient.appendingPathComponent("preload.ts"),
                    options: .atomic
                )
                try Data(maliciousConfig.utf8).write(
                    to: ambient.appendingPathComponent("bunfig.toml"),
                    options: .atomic
                )
                let previousHome = getenv("HOME").map { String(cString: $0) }
                let previousXDG = getenv("XDG_CONFIG_HOME").map { String(cString: $0) }
                guard setenv("HOME", fakeHome.path, 1) == 0,
                      setenv("XDG_CONFIG_HOME", fakeXDG.path, 1) == 0
                else {
                    t.expect(false, "could not isolate Bun global config homes")
                    return
                }
                defer {
                    if let previousHome { setenv("HOME", previousHome, 1) } else { unsetenv("HOME") }
                    if let previousXDG { setenv("XDG_CONFIG_HOME", previousXDG, 1) }
                    else { unsetenv("XDG_CONFIG_HOME") }
                }
                let originalDirectory = FileManager.default.currentDirectoryPath
                guard FileManager.default.changeCurrentDirectoryPath(ambient.path) else {
                    t.expect(false, "could not enter ambient test directory")
                    return
                }
                defer { _ = FileManager.default.changeCurrentDirectoryPath(originalDirectory) }

                guard let invocation = LifecycleHelperDiscovery.discover(
                    bundleURL: bundle,
                    environment: ["PATH": ""],
                    home: root
                ) else {
                    t.expect(false, "bundled invocation not found")
                    return
                }
                t.equal(invocation.prefixArguments,
                    ["--no-install", "--no-env-file", "--config=/dev/null", bundled.entry.path])
                t.equal(invocation.workingDirectory?.path, bundled.runtime.path)
                let helper = LifecycleHelper(invocation: invocation, timeout: 5)
                let result = sync { try await helper.run(.status) }
                switch result {
                case .success(let value):
                    t.equal(value.message, "hermetic:true:true")
                    t.expect(!FileManager.default.fileExists(atPath: sentinel.path),
                        "no bunfig preload executed")
                case .failure(let error):
                    t.expect(false, "unexpected bundled Bun failure: \(error)")
                }
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
                    named: "ccx",
                    body: "#!/bin/sh\nexit 0\n"
                )
                let invocation = LifecycleHelperDiscovery.discover(
                    bundleURL: root.appendingPathComponent("Copied.bundle"),
                    environment: ["PATH": untrusted.path],
                    home: root
                )
                t.isNil(invocation, "PATH candidate")
            }
        }

        t.test("lifecycle helper: fixed install symlink resolves only a CodexCommander package") {
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
                try Data(#"{"name":"codexcommander"}"#.utf8).write(
                    to: repository.appendingPathComponent("package.json")
                )
                try Data().write(to: entry)
                let launcher = try makeExecutable(
                    in: bin,
                    named: "ccx.mjs",
                    body: "#!/usr/bin/env node\n"
                )
                _ = try makeExecutable(in: bun.deletingLastPathComponent(), named: "bun", body: "#!/bin/sh\n")
                try FileManager.default.createSymbolicLink(
                    at: installedBin.appendingPathComponent("ccx"),
                    withDestinationURL: launcher
                )

                let invocation = LifecycleHelperDiscovery.discover(
                    bundleURL: root.appendingPathComponent("Release.bundle"),
                    environment: ["PATH": ""],
                    home: root
                )
                t.equal(invocation?.executable.path, bun.path)
                t.equal(invocation?.prefixArguments, [entry.path])
                t.equal(invocation?.workingDirectory?.path, repository.path)
                t.equal(invocation?.appOwnedRuntime, false)
            }
        }

        t.test("lifecycle helper: decodes one matching bounded JSON result") {
            try withTemporaryDirectory { root in
                let script = try makeExecutable(
                    in: root,
                    named: "valid-helper",
                    body: """
                    #!/bin/sh
                    printf '{"schemaVersion":1,"action":"%s","ok":true,"state":"running","changed":true,"pid":42,"port":10100,"message":"CodexCommander proxy started."}\\n' "$2"
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

        t.test("lifecycle helper: rejects a result with missing nullable pid or port keys") {
            try withTemporaryDirectory { root in
                let script = try makeExecutable(
                    in: root,
                    named: "partial-helper",
                    body: """
                    #!/bin/sh
                    printf '{"schemaVersion":1,"action":"%s","ok":true,"state":"running","changed":false,"message":"missing pid and port"}\\n' "$2"
                    """
                )
                let helper = LifecycleHelper(invocation: LifecycleInvocation(executable: script), timeout: 2)
                let result = sync { try await helper.run(.status) }
                if case .failure(let error as LifecycleHelperError) = result {
                    t.equal(error, .invalidResponse)
                } else {
                    t.expect(false, "partial lifecycle result must be rejected")
                }
            }
        }

        t.test("lifecycle helper: decodes a bounded count-only catalog result") {
            try withTemporaryDirectory { root in
                let script = try makeExecutable(
                    in: root,
                    named: "catalog-helper",
                    body: """
                    #!/bin/sh
                    printf '{"schemaVersion":1,"action":"%s","ok":true,"state":"running","changed":true,"pid":42,"port":10100,"message":"Agent catalog updated.","catalogUpdated":true,"codexRestartRequired":false,"staleWorkerCount":2,"stoppedWorkerCount":2,"survivingWorkerCount":0}\\n' "$2"
                    """
                )
                let helper = LifecycleHelper(
                    invocation: LifecycleInvocation(executable: script),
                    timeout: 2
                )
                let result = sync { try await helper.run(.applyCodexCatalog) }
                switch result {
                case .success(let value):
                    t.equal(value.action, .applyCodexCatalog)
                    t.equal(value.catalogUpdated, true)
                    t.equal(value.stoppedWorkerCount, 2)
                    t.equal(value.survivingWorkerCount, 0)
                case .failure(let error):
                    t.expect(false, "unexpected helper failure: \(error)")
                }
            }
        }

        t.test("lifecycle helper: rejects negative catalog worker counts") {
            try withTemporaryDirectory { root in
                let script = try makeExecutable(
                    in: root,
                    named: "invalid-catalog-helper",
                    body: """
                    #!/bin/sh
                    printf '{"schemaVersion":1,"action":"%s","ok":true,"state":"running","changed":true,"message":"Agent catalog updated.","catalogUpdated":true,"codexRestartRequired":false,"stoppedWorkerCount":-1,"survivingWorkerCount":0}\\n' "$2"
                    """
                )
                let helper = LifecycleHelper(
                    invocation: LifecycleInvocation(executable: script),
                    timeout: 2
                )
                let result = sync { try await helper.run(.applyCodexCatalog) }
                if case .failure(let error as LifecycleHelperError) = result {
                    t.equal(error, .invalidResponse)
                } else {
                    t.expect(false, "negative worker counts must be rejected")
                }
            }
        }

        t.test("lifecycle helper: rejects catalog success missing required fields") {
            try withTemporaryDirectory { root in
                let script = try makeExecutable(
                    in: root,
                    named: "incomplete-catalog-helper",
                    body: """
                    #!/bin/sh
                    printf '{"schemaVersion":1,"action":"%s","ok":true,"state":"running","changed":true,"message":"Agent catalog updated.","catalogUpdated":true,"codexRestartRequired":false,"stoppedWorkerCount":1}\\n' "$2"
                    """
                )
                let helper = LifecycleHelper(
                    invocation: LifecycleInvocation(executable: script),
                    timeout: 2
                )
                let result = sync { try await helper.run(.applyCodexCatalog) }
                if case .failure(let error as LifecycleHelperError) = result {
                    t.equal(error, .invalidResponse)
                } else {
                    t.expect(false, "catalog success missing a required field must be rejected")
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

    private static func makeBundledRuntime(
        in bundle: URL
    ) throws -> (runtime: URL, entry: URL, bun: URL) {
        let runtime = bundle.appendingPathComponent(
            "Contents/Resources/runtime",
            isDirectory: true
        )
        return try makeRuntime(at: runtime)
    }

    private static func makeRuntime(
        at runtime: URL
    ) throws -> (runtime: URL, entry: URL, bun: URL) {
        let entry = runtime.appendingPathComponent("src/cli/index.ts")
        let bun = runtime.appendingPathComponent("node_modules/bun/bin/bun")
        try FileManager.default.createDirectory(
            at: entry.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: bun.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(#"{"name":"codexcommander"}"#.utf8).write(
            to: runtime.appendingPathComponent("package.json"),
            options: .atomic
        )
        try Data().write(to: entry, options: .atomic)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: bun, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: bun.path
        )
        return (runtime, entry, bun)
    }

    private static func installFixedGlobalRuntime(
        in root: URL
    ) throws -> (entry: URL, bun: URL) {
        let repository = root.appendingPathComponent("global-package", isDirectory: true)
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
        try Data(#"{"name":"codexcommander"}"#.utf8).write(
            to: repository.appendingPathComponent("package.json")
        )
        try Data().write(to: entry)
        let launcher = try makeExecutable(
            in: bin,
            named: "ccx.mjs",
            body: "#!/usr/bin/env node\n"
        )
        _ = try makeExecutable(
            in: bun.deletingLastPathComponent(),
            named: "bun",
            body: "#!/bin/sh\nexit 0\n"
        )
        try FileManager.default.createSymbolicLink(
            at: installedBin.appendingPathComponent("ccx"),
            withDestinationURL: launcher
        )
        return (entry, bun)
    }

    private static func findProjectBun() -> URL? {
        var directory = URL(
            fileURLWithPath: FileManager.default.currentDirectoryPath,
            isDirectory: true
        ).standardizedFileURL
        for _ in 0..<8 {
            for relative in [
                "node_modules/bun/bin/bun.exe",
                "node_modules/bun/bin/bun",
                "node_modules/.bin/bun",
            ] {
                let candidate = directory.appendingPathComponent(relative).resolvingSymlinksInPath()
                if FileManager.default.isExecutableFile(atPath: candidate.path) {
                    return candidate
                }
            }
            let parent = directory.deletingLastPathComponent()
            if parent.path == directory.path { break }
            directory = parent
        }
        return nil
    }

    private static func withTemporaryDirectory<T>(_ body: (URL) throws -> T) throws -> T {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "CodexCommander-Lifecycle-\(UUID().uuidString)",
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
